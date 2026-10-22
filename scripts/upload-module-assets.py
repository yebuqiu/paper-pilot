#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""把组件 zip 传到已存在的 Release（GitHub + Gitee），幂等。

为什么单独一支：`github-release.py` / `gitee-release.py` 只负责 xpi 主产物；
组件商店的 9 个 zip 需要挂同一个 tag，但**不能因此改动两条已经稳定的发版路径**。

用法：
  python scripts/upload-module-assets.py --version 0.73.0 --dry-run
  python scripts/upload-module-assets.py --version 0.73.0
  python scripts/upload-module-assets.py --version 0.73.0 --platform gitee

令牌与两条发版脚本同源：
  GitHub：PP_GITHUB_TOKEN → git credential fill
  Gitee ：PP_GITEE_TOKEN → ~/.git-credentials
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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist" / "modules"
GH_OWNER, GH_REPO = "yebuqiu", "zotero-papilot"
GE_OWNER, GE_REPO = "cassiuschen9261", "zotero-papilot"
GE_API = "https://gitee.com/api/v5"
GH_API = "https://api.github.com"
GH_UPLOAD_API = "https://uploads.github.com"   # Release 附件上传走专用域名


def die(msg):
    print("✗ " + msg, file=sys.stderr)
    raise SystemExit(1)


def gh_token():
    tok = os.environ.get("PP_GITHUB_TOKEN", "").strip()
    if tok:
        return tok
    try:
        out = subprocess.run(
            ["git", "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True, text=True, timeout=20,
            cwd=str(ROOT)).stdout
        for line in out.splitlines():
            if line.startswith("password="):
                return line.split("=", 1)[1].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    die("取不到 GitHub PAT（可设 PP_GITHUB_TOKEN）")


def ge_token():
    tok = os.environ.get("PP_GITEE_TOKEN", "").strip()
    if tok:
        return tok
    p = Path.home() / ".git-credentials"
    if p.is_file():
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            if "gitee.com" in line:
                parts = urllib.parse.urlsplit(line.strip())
                if parts.password:
                    return urllib.parse.unquote(parts.password)
    die("取不到 Gitee token（可设 PP_GITEE_TOKEN）")


def http(url, token, method="GET", data=None, ctype="application/json", _retry=3):
    """带重试的 REST 调用：沙箱代理对大响应体偶发截断（IncompleteRead），
    重试比让用户重跑便宜。响应体越大越容易踩，调用方请用小 page。"""
    import http.client
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "token " + token)
    req.add_header("User-Agent", "papilot-release")
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
            return json.loads(body.decode("utf-8")) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError("HTTP %d %s %s" % (e.code, url, detail))
    except http.client.IncompleteRead as e:
        if _retry > 0:
            import time
            time.sleep(2)
            return http(url, token, method, data, ctype, _retry - 1)
        raise RuntimeError("响应体被截断且重试失败：%s（%s）" % (url, e))


def module_zips(version):
    files = sorted(DIST.glob("*-%s.zip" % version))
    if not files:
        die("dist/modules 下没有 %s 的组件包（先跑 build-module.py --all）" % version)
    return files


def gh_upload(version, dry):
    token = gh_token()
    tag = "v" + version
    # 最新 Release 在前，10 条足够；大 page 的响应体在代理下会被截断
    rels = http("%s/repos/%s/%s/releases?per_page=10" % (GH_API, GH_OWNER, GH_REPO), token)
    rel = next((r for r in rels if r.get("tag_name") == tag), None)
    if not rel:
        die("GitHub 上没有 %s 的 Release（先跑 github-release.py --version %s）" % (tag, version))
    have = {a.get("name") for a in rel.get("assets") or []}
    for p in module_zips(version):
        if p.name in have:
            print("  = GitHub 已有 %s" % p.name)
            continue
        if dry:
            print("  + GitHub 待传 %s（%d bytes）" % (p.name, p.stat().st_size))
            continue
        data = p.read_bytes()
        up = http("%s/repos/%s/%s/releases/%d/assets?name=%s"
                  % (GH_UPLOAD_API, GH_OWNER, GH_REPO, rel["id"], urllib.parse.quote(p.name)),
                  token, "POST", data, "application/octet-stream")
        print("  ✓ GitHub %s（%d bytes）" % (up.get("name"), up.get("size", 0)))


def ge_upload(version, dry):
    token = ge_token()
    tag = "v" + version
    q = urllib.parse.urlencode({"access_token": token, "page": 1, "per_page": 10})
    rels = http("%s/repos/%s/%s/releases?%s" % (GE_API, GE_OWNER, GE_REPO, q), token)
    rel = next((r for r in rels if r.get("tag_name") == tag), None)
    if not rel:
        die("Gitee 上没有 %s 的 Release（先跑 gitee-release.py --version %s）" % (tag, version))
    detail = http("%s/repos/%s/%s/releases/%d?access_token=%s"
                  % (GE_API, GE_OWNER, GE_REPO, rel["id"], urllib.parse.quote(token)), token)
    have = {a.get("name") for a in detail.get("assets") or []}
    for p in module_zips(version):
        if p.name in have:
            print("  = Gitee 已有 %s" % p.name)
            continue
        if dry:
            print("  + Gitee 待传 %s（%d bytes）" % (p.name, p.stat().st_size))
            continue
        boundary = "----PPBoundary" + uuid.uuid4().hex
        payload = b"".join([
            ("--%s\r\n" % boundary).encode(),
            ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % p.name).encode(),
            b"Content-Type: application/octet-stream\r\n\r\n",
            p.read_bytes(),
            ("\r\n--%s--\r\n" % boundary).encode(),
        ])
        up = http("%s/repos/%s/%s/releases/%d/attach_files?access_token=%s"
                  % (GE_API, GE_OWNER, GE_REPO, rel["id"], urllib.parse.quote(token)),
                  token, "POST", payload, "multipart/form-data; boundary=" + boundary)
        print("  ✓ Gitee %s" % (up.get("name") or p.name))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--platform", choices=["both", "github", "gitee"], default="both")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    print("组件包 %d 个（版本 %s，%s）"
          % (len(module_zips(args.version)), args.version,
             "预演" if args.dry_run else "上传"))
    if args.platform in ("both", "github"):
        gh_upload(args.version, args.dry_run)
    if args.platform in ("both", "gitee"):
        ge_upload(args.version, args.dry_run)


if __name__ == "__main__":
    main()
