#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把本地 git 仓库的当前 HEAD 树同步到 GitHub（REST API 通道）。

背景：本机网络长期阻断 github.com 的 git 协议（curl/ls-remote 挂死），
但 api.github.com 通畅——因此走 REST API 重建一次提交（blobs → tree →
commit → PATCH ref）。树内容与本地等价，但提交 SHA 与本地不同（无历史）。

用法（在仓库根目录）：
    python scripts/sync-github.py            # 同步 HEAD → refs/heads/main
    python scripts/sync-github.py --dry-run  # 只打印计划，不写远端

PAT 取自 Windows 凭据管理器（git:https://github.com），无需写进文件。

三个历史坑（已处理）：
  1. blob 内容必须 `git cat-file blob <sha>` 读 object，不能读工作区文件
     （工作区 CRLF 与提交内容不一致）；
  2. `git ls-tree` 必须 `-c core.quotepath=false`，否则中文路径被转义成
     \\xxx 八进制（会以转义名上传、真实中文名被误删）；
  3. urllib 对 307 POST 不自动跟随（抛 HTTPError），必须手动带原 body
     向 Location 重试（blob 上传会被重定向到 objects host）。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = os.environ.get("PP_GH_REPO", "yebuqiu/paper-pilot")
BRANCH = "main"
API = "https://api.github.com"
COMMIT_MSG_FILE = ".git/COMMIT_EDITMSG"


def sh(*args, binary=False, check=True):
    r = subprocess.run(list(args), capture_output=True)
    if check and r.returncode != 0:
        raise SystemExit("命令失败 %s\n%s" % (args, r.stderr.decode("utf-8", "replace")))
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def token():
    """取 GitHub PAT。
    优先读环境变量 PP_GITHUB_TOKEN —— 本机 git 的 credential.helper 被 WorkBuddy 注入到
    **system 层**（helper-selector），该链路会漂移：一旦没接上 Windows 凭据管理器，
    `git credential fill` 要么返回空、要么弹出 GUI 把脚本挂死（已实踩）。
    环境变量可绕开这条链路，也让自动化可复现。密钥绝不写进仓库。
    """
    env = os.environ.get("PP_GITHUB_TOKEN", "").strip()
    if env:
        return env
    r = subprocess.run(
        ["git", "credential", "fill"],
        input=b"protocol=https\nhost=github.com\n\n",
        capture_output=True,
    )
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("password="):
            return line[len("password="):].strip()
    raise SystemExit("未能从凭据管理器取到 github.com 的 PAT（可设 PP_GITHUB_TOKEN 绕过）")


def api(method, path, body=None, tok=None):
    url = API + path if path.startswith("/") else path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    for _ in range(5):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + tok)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "PaperPilot-Sync")
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            # 307/308：手动带原 body 向 Location 重试（urllib 不会自动跟随 POST）
            if e.code in (301, 302, 307, 308):
                loc = e.headers.get("Location")
                if loc:
                    url = loc
                    continue
            detail = e.read().decode("utf-8", "replace")[:500]
            raise SystemExit("GitHub API %s %s 失败 %s: %s" % (method, path, e.code, detail))
    raise SystemExit("重定向次数过多: " + path)


def local_entries():
    """HEAD 树的全部 blob：[(path, mode, blob_sha)]，中文路径原样。"""
    raw = sh("git", "-c", "core.quotepath=false", "ls-tree", "-r", "-z", "HEAD", binary=True)
    out = []
    for item in raw.split(b"\x00"):
        if not item:
            continue
        meta, path = item.split(b"\t", 1)
        mode, typ, sha = meta.decode().split(" ")
        if typ != "blob":
            continue
        out.append((path.decode("utf-8", "surrogateescape"), mode, sha))
    return out


def main():
    dry = "--dry-run" in sys.argv
    entries = local_entries()
    print("本地 HEAD blob 数：%d" % len(entries))

    tok = token()
    ref = api("GET", "/repos/%s/git/ref/heads/%s" % (REPO, BRANCH), None, tok)
    parent = ref["object"]["sha"]
    parent_tree = parent
    print("GitHub 当前 %s = %s" % (BRANCH, parent[:10]))

    trees = []
    for i, (path, mode, sha) in enumerate(entries, 1):
        if dry:
            trees.append({"path": path, "mode": mode, "type": "blob", "sha": sha})
            continue
        content = sh("git", "cat-file", "blob", sha, binary=True)
        blob = api("POST", "/repos/%s/git/blobs" % REPO, {
            "content": base64.b64encode(content).decode("ascii"),
            "encoding": "base64",
        }, tok)
        # 内容相同则 GitHub 返回同一个 sha（blob 内容寻址）——自检一下
        if blob["sha"] != sha:
            print("  ! blob sha 不一致（本地 %s / 远端 %s）: %s" % (sha[:8], blob["sha"][:8], path))
        trees.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        if i % 20 == 0:
            print("  已上传 %d/%d" % (i, len(entries)))

    # 先做一个临时 tree 用于比较（GitHub 的 tree sha 由内容决定，
    # 但我们的 tree 是「自建」的——先比路径集合再看是否需要新提交）
    remote_tree = api("GET", "/repos/%s/git/trees/%s?recursive=1" % (REPO, parent_tree), None, tok)
    remote_paths = {e["path"]: e["sha"] for e in remote_tree.get("tree", []) if e["type"] == "blob"}
    local_paths = {p: s for p, m, s in entries}
    added = sorted(set(local_paths) - set(remote_paths))
    removed = sorted(set(remote_paths) - set(local_paths))
    changed = sorted(p for p in set(local_paths) & set(remote_paths) if local_paths[p] != remote_paths[p])
    print("差异：+%d -%d ~%d" % (len(added), len(removed), len(changed)))
    for p in added:
        print("  + " + p)
    for p in removed:
        print("  - " + p)
    for p in changed:
        print("  ~ " + p)

    if dry:
        print("dry-run：未写远端")
        return
    if not (added or removed or changed):
        print("远端内容已与本地一致，无需提交")
        return

    # 提交信息取本地 HEAD 的完整 message
    msg = sh("git", "log", "-1", "--pretty=%B").strip() or "sync from local"
    new_tree = api("POST", "/repos/%s/git/trees" % REPO, {"tree": trees}, tok)
    commit = api("POST", "/repos/%s/git/commits" % REPO, {
        "message": msg,
        "tree": new_tree["sha"],
        "parents": [parent],
    }, tok)
    api("PATCH", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH), {"sha": commit["sha"], "force": False}, tok)
    print("已推送 commit %s → %s" % (commit["sha"][:10], BRANCH))

    # 自检：最终 tree 路径集合必须与本地完全一致
    final = api("GET", "/repos/%s/git/trees/%s?recursive=1" % (REPO, commit["sha"]), None, tok)
    final_paths = {e["path"] for e in final.get("tree", []) if e["type"] == "blob"}
    if final_paths != set(local_paths):
        only_remote = sorted(final_paths - set(local_paths))[:10]
        only_local = sorted(set(local_paths) - final_paths)[:10]
        raise SystemExit("自检失败！远端多出 %s，缺少 %s" % (only_remote, only_local))
    print("自检通过：远端 %d 个 blob 与本地完全一致" % len(final_paths))


if __name__ == "__main__":
    main()
