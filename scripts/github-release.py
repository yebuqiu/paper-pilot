#!/usr/bin/env python3
"""GitHub 版本 tag + Release（含 xpi 附件）—— PaperPilot 发版流程的 GitHub 侧。

为什么需要它：`sync-github.py` 只把**内容**镜像到 GitHub（走 REST，SHA 与本地不同），
不建 tag / Release。而 GitHub 会把 Release 展示在仓库首页侧栏，别人也能直接下载 xpi。
所以 GitHub 侧要额外做两件事：**按版本打 tag** + **把该版本的 xpi 传成 Release 附件**。

用法：
  # 正常发版（打完本地 tag、推完 Gitee、跑完 sync-github.py 之后执行）
  python scripts/github-release.py --version 0.26.0

  # 历史补发：给 dist/ 里有产物但 GitHub 上还没有 Release 的版本全部补上
  python scripts/github-release.py --backfill

  # 预演（不调写接口，只打印计划）
  python scripts/github-release.py --backfill --dry-run

设计要点：
  · **tag 指向 GitHub 侧提交**（REST 镜像 SHA ≠ 本地 SHA），靠「读每个提交里的
    manifest.json version」来找，不用提交消息（消息可能不带版本号或写法不一）。
  · 幂等：已存在的 Release / tag 一律跳过，可反复执行。
  · 找不到对应提交的版本（例如当年版本号只在打包时改、没提交的 0.21.3）——
    **如实报告并跳过**，不做张冠李戴的 tag。
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

OWNER, REPO = "yebuqiu", "paper-pilot"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")


def _token():
    out = subprocess.run(["git", "credential", "fill"],
                         input=b"protocol=https\nhost=github.com\n\n",
                         capture_output=True).stdout.decode()
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("取不到 GitHub PAT（git credential fill 无 password=）")


TOK = None
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, method="GET", body=None, raw=None, ctype=None, base="https://api.github.com"):
    global TOK
    if TOK is None:
        TOK = _token()
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    elif raw is not None:
        data = raw
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "paperpilot-release")
    if ctype:
        req.add_header("Content-Type", ctype)
    elif data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with OPENER.open(req, timeout=120) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError("GitHub API %s %s → %s %s" % (method, path, e.code, detail))


def dist_versions():
    """dist/ 里有 xpi 产物的版本（按版本号排序）"""
    if not os.path.isdir(DIST):
        return []
    vs = []
    for f in os.listdir(DIST):
        if f.startswith("paper-pilot-") and f.endswith(".xpi"):
            vs.append(f[len("paper-pilot-"):-len(".xpi")])
    def key(v):
        return [int(x) for x in v.split(".")]
    return sorted(set(vs), key=key)


def commit_version_map():
    """GitHub main 上「版本 → 引入该版本的那个提交」。从旧到新遍历，首次出现为准。"""
    commits, page = [], 1
    while True:
        batch = api("/repos/%s/%s/commits?sha=main&per_page=100&page=%d" % (OWNER, REPO, page))
        if not batch:
            break
        commits.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    first = {}
    for c in reversed(commits):
        try:
            j = api("/repos/%s/%s/contents/manifest.json?ref=%s" % (OWNER, REPO, c["sha"]))
            v = json.loads(base64.b64decode(j["content"]).decode("utf-8")).get("version")
        except Exception:
            continue
        if v and v not in first:
            first[v] = {"sha": c["sha"], "msg": c["commit"]["message"],
                        "date": c["commit"]["committer"]["date"]}
    return first


def existing_releases():
    out, page = {}, 1
    while True:
        batch = api("/repos/%s/%s/releases?per_page=100&page=%d" % (OWNER, REPO, page))
        if not batch:
            break
        for r in batch:
            out[r["tag_name"]] = r
        if len(batch) < 100:
            break
        page += 1
    return out


def existing_tags():
    out, page = set(), 1
    while True:
        batch = api("/repos/%s/%s/git/refs/tags?per_page=100&page=%d" % (OWNER, REPO, page))
        if not batch:
            break
        for r in batch:
            out.add(r["ref"].split("refs/tags/")[-1])
        if len(batch) < 100:
            break
        page += 1
    return out


def release_notes(version, info):
    """Release 正文：拿提交消息当更新说明 + 安装指引 + 更新通道说明。"""
    body = info.get("msg", "").strip() or ("PaperPilot %s" % version)
    return (
        body + "\n\n"
        "---\n\n"
        "### 下载安装\n"
        "- 直接下载下面的 `paper-pilot-%s.xpi`，在 Zotero 里 **工具 → 附加组件 → 齿轮 → "
        "Install Add-on From File…** 选择该文件即可。\n"
        "- 已装旧版的用户**重启 Zotero** 会自动收到更新（更新通道：Gitee 的 "
        "`paperpilot-update.json`）。\n\n"
        "### 说明\n"
        "- 本仓库是内容镜像；tag 由 `scripts/github-release.py` 按版本补建。\n"
        "- 提交时间：%s\n" % (version, info.get("date", ""))
    )


def ensure_release(version, info, rels, tags, apply):
    tag = "v" + version
    if tag in rels:
        return "skip", "Release %s 已存在" % tag
    asset = os.path.join(DIST, "paper-pilot-%s.xpi" % version)
    if not os.path.exists(asset):
        return "skip", "无产物 dist/paper-pilot-%s.xpi" % version
    if not info:
        return "skip", "GitHub 上找不到 manifest 版本为 %s 的提交（历史遗留，跳过）" % version
    if not apply:
        return "plan", "%s → 提交 %s（%d bytes 附件）" % (tag, info["sha"][:10], os.path.getsize(asset))

    payload = {
        "tag_name": tag,
        "name": "PaperPilot v" + version,
        "body": release_notes(version, info),
        "draft": False,
        "prerelease": False,
    }
    # tag 不存在时由 target_commitish 指定落点；已存在则只建 Release
    if tag not in tags:
        payload["target_commitish"] = info["sha"]
    rel = api("/repos/%s/%s/releases" % (OWNER, REPO), "POST", payload)
    with open(asset, "rb") as f:
        data = f.read()
    up = api("/repos/%s/%s/releases/%d/assets?name=%s" % (OWNER, REPO, rel["id"],
                                                          os.path.basename(asset)),
             "POST", raw=data, ctype="application/octet-stream",
             base="https://uploads.github.com")
    return "done", "%s → %s（附件 %s, %d bytes）" % (tag, rel["html_url"], up.get("name"), up.get("size", 0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", help="只发这一个版本（如 0.26.0）")
    ap.add_argument("--backfill", action="store_true", help="给 dist 里所有缺 Release 的版本补发")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不调写接口")
    args = ap.parse_args()
    if not args.version and not args.backfill:
        ap.error("需要 --version <v> 或 --backfill")

    targets = [args.version] if args.version else dist_versions()
    print("目标版本 %d 个：%s" % (len(targets), " ".join(targets)))
    print("建立版本→提交映射（读每个提交的 manifest.json）…")
    vmap = commit_version_map()
    print("  GitHub 上可映射版本 %d 个" % len(vmap))
    rels = existing_releases()
    tags = existing_tags()
    print("  已有 Release %d 个 / 已有 tag %d 个" % (len(rels), len(tags)))

    done = plan = skipped = 0
    for v in targets:
        kind, msg = ensure_release(v, vmap.get(v), rels, tags, apply=not args.dry_run)
        print("  [%s] %s" % (kind, msg))
        if kind == "done":
            done += 1
        elif kind == "plan":
            plan += 1
        else:
            skipped += 1
    print("\n结果：新建 %d，预演 %d，跳过 %d" % (done, plan, skipped))
    if not args.dry_run and done:
        r = api("/repos/%s/%s/releases?per_page=100" % (OWNER, REPO))
        print("远端 Release 总数：%d，最新：%s" % (len(r), r[0]["tag_name"] if r else "无"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
