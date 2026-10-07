#!/usr/bin/env python3
"""Gitee 版本 Release（含 xpi 附件）—— PaperPilot 发版流程的 Gitee 侧。

为什么需要它：GitHub 侧由 `github-release.py` 管 tag + Release + xpi 附件；
Gitee 是主仓库与国内下载通道（更新通道 `paperpilot-update.json` 也走 Gitee raw），
但「发行版」页不会自动带上 xpi —— 需要按版本补建 release 并上传附件，
否则用户点开发行版看不到最新安装包（实踩：2026-10-07 时 Gitee 上只有
v0.13.0/v0.13.1 两个远古发行版，0.14+ 全部缺失）。

用法：
  # 发单个版本（发版流程中，push 完 Gitee 之后执行）
  python scripts/gitee-release.py --version 0.26.0

  # 全量补发：给 dist/ 里有产物但 Gitee 上缺 xpi 附件的版本都补上
  python scripts/gitee-release.py --backfill

  # 预演（不调写接口，只打印计划）
  python scripts/gitee-release.py --backfill --dry-run

设计要点：
  · 幂等：已有 release 且 xpi 附件齐全 → 跳过；release 在但缺附件 → 只补传附件
    （不会动已有 release 的正文）。
  · 版本→提交：读**本地 git**（tag 优先；无 tag 的版本遍历历史找 manifest.json
    首次出现的提交），与 Gitee 远端无关——Gitee 上 tag 由 push 维护。
  · token：优先 `PP_GITEE_TOKEN` 环境变量，回退 `~/.git-credentials` 的 gitee 条目；
    任何密钥不进仓库。
  · 附件上传走 multipart 表单（标准库手拼，无第三方依赖）。
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

OWNER, REPO = "cassiuschen9261", "paper-pilot"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
API = "https://gitee.com/api/v5"


def _token():
    tok = os.environ.get("PP_GITEE_TOKEN", "").strip()
    if tok:
        return tok
    path = os.path.join(os.path.expanduser("~"), ".git-credentials")
    if os.path.exists(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if "gitee.com" in line and "@" in line and "://" in line:
                    cred = line.split("://", 1)[1].split("@", 1)[0]
                    if ":" in cred:
                        return cred.split(":", 1)[1]
    raise SystemExit("取不到 Gitee token（可设 PP_GITEE_TOKEN 环境变量绕过）")


TOK = None
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, method="GET", body=None, raw=None, ctype=None):
    global TOK
    if TOK is None:
        TOK = _token()
    sep = "&" if "?" in path else "?"
    url = API + path + sep + "access_token=" + urllib.parse.quote(TOK)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    elif raw is not None:
        data = raw
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "paperpilot-release")
    if ctype:
        req.add_header("Content-Type", ctype)
    elif data is not None:
        req.add_header("Content-Type", "application/json;charset=UTF-8")
    try:
        with OPENER.open(req, timeout=180) as r:
            txt = r.read().decode("utf-8", "replace")
            return json.loads(txt) if txt.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError("Gitee API %s %s → %s %s" % (method, path, e.code, detail))


def _git(*args):
    return subprocess.run(["git"] + list(args), cwd=ROOT,
                          capture_output=True).stdout.decode("utf-8", "replace")


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


def version_commit_map():
    """版本 → {sha, msg, date}（读本地 git）。tag 优先，其余遍历历史首次出现为准。"""
    first = {}
    for sha in _git("log", "--reverse", "--format=%H").split():
        try:
            v = json.loads(_git("show", "%s:manifest.json" % sha)).get("version")
        except Exception:
            continue
        if v and v not in first:
            first[v] = sha
    for name in _git("tag", "-l").split():
        if not name.startswith("v"):
            continue
        sha = _git("rev-list", "-n", "1", name).strip()
        if sha:
            first[name[1:]] = sha
    out = {}
    for ver, sha in first.items():
        out[ver] = {
            "sha": sha,
            "msg": _git("log", "-1", "--format=%B", sha).strip(),
            "date": _git("log", "-1", "--format=%cI", sha).strip(),
        }
    return out


def existing_releases():
    """tag → release 对象（含 assets），翻页取全。"""
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


def has_xpi_asset(rel, version):
    name = "paper-pilot-%s.xpi" % version
    for a in rel.get("assets") or []:
        if a.get("name") == name:
            return True
    return False


def release_notes(version, info):
    body = info.get("msg", "").strip() or ("PaperPilot %s" % version)
    return (
        body + "\n\n"
        "---\n\n"
        "### 下载安装\n"
        "- 直接下载下面的 `paper-pilot-%s.xpi`，在 Zotero 里 **工具 → 附加组件 → 齿轮 → "
        "Install Add-on From File…** 选择该文件即可。\n"
        "- 已装旧版的用户**重启 Zotero** 会自动收到更新（更新通道：本仓库的 "
        "`paperpilot-update.json`）。\n\n"
        "### 说明\n"
        "- 提交时间：%s\n" % (version, info.get("date", ""))
    )


def _multipart(field, filename, data):
    boundary = "----PPBoundary" + uuid.uuid4().hex
    parts = [
        ("--%s\r\n" % boundary).encode(),
        ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
         % (field, filename)).encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        data,
        ("\r\n--%s--\r\n" % boundary).encode(),
    ]
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


def upload_xpi(release_id, version):
    asset = os.path.join(DIST, "paper-pilot-%s.xpi" % version)
    with open(asset, "rb") as f:
        data = f.read()
    payload, ctype = _multipart("file", os.path.basename(asset), data)
    return api("/repos/%s/%s/releases/%d/attach_files" % (OWNER, REPO, release_id),
               "POST", raw=payload, ctype=ctype)


def verify_asset(rel_id, version):
    """上传后回读一次，确认附件真的挂上了（Gitee 偶发静默丢附件）。"""
    one = api("/repos/%s/%s/releases/%s" % (OWNER, REPO, rel_id))
    return has_xpi_asset(one, version)


def ensure_release(version, info, rels, apply):
    tag = "v" + version
    asset = os.path.join(DIST, "paper-pilot-%s.xpi" % version)
    if not os.path.exists(asset):
        return "skip", "无产物 dist/paper-pilot-%s.xpi" % version
    rel = rels.get(tag)
    if rel:
        if has_xpi_asset(rel, version):
            return "skip", "Release %s 已有 xpi 附件" % tag
        if not apply:
            return "plan", "%s 已存在但缺附件 → 补传（%d bytes）" % (tag, os.path.getsize(asset))
        up = upload_xpi(rel["id"], version)
        ok = verify_asset(rel["id"], version)
        return ("done" if ok else "skip"), "%s 补传附件 %s（%d bytes）%s" % (
            tag, up.get("name"), up.get("size", 0), "" if ok else "——回读未见附件，请复查")
    if not info:
        return "skip", "本地 git 找不到 manifest 版本为 %s 的提交（历史遗留，跳过）" % version
    if not apply:
        return "plan", "%s → 补建 Release + xpi 附件（%d bytes，提交 %s）" % (
            tag, os.path.getsize(asset), info["sha"][:10])
    rel = api("/repos/%s/%s/releases" % (OWNER, REPO), "POST", {
        "tag_name": tag,
        "name": "PaperPilot v" + version,
        "body": release_notes(version, info),
        "target_commitish": "main",
        "prerelease": False,
    })
    rid = rel["id"]
    up = upload_xpi(rid, version)
    ok = verify_asset(rid, version)
    return ("done" if ok else "skip"), "%s → https://gitee.com/%s/%s/releases/tag/%s（附件 %s, %d bytes）%s" % (
        tag, OWNER, REPO, tag, up.get("name"), up.get("size", 0),
        "" if ok else "——回读未见附件，请复查")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", help="只发这一个版本（如 0.26.0）")
    ap.add_argument("--backfill", action="store_true", help="给 dist 里所有缺附件的版本补发")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不调写接口")
    args = ap.parse_args()
    if not args.version and not args.backfill:
        ap.error("需要 --version <v> 或 --backfill")

    targets = [args.version] if args.version else dist_versions()
    print("目标版本 %d 个：%s" % (len(targets), " ".join(targets)))
    print("建立版本→提交映射（读本地 git）…")
    vmap = version_commit_map()
    print("  可映射版本 %d 个" % len(vmap))
    rels = existing_releases()
    print("  Gitee 已有 Release %d 个：%s" % (len(rels), " ".join(sorted(rels))))

    done = plan = skipped = 0
    for v in targets:
        kind, msg = ensure_release(v, vmap.get(v), rels, apply=not args.dry_run)
        print("  [%s] %s" % (kind, msg))
        if kind == "done":
            done += 1
        elif kind == "plan":
            plan += 1
        else:
            skipped += 1
    print("\n结果：新建/补传 %d，预演 %d，跳过 %d" % (done, plan, skipped))
    if not args.dry_run and done:
        r = api("/repos/%s/%s/releases?per_page=100" % (OWNER, REPO))
        print("远端 Release 总数：%d" % len(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
