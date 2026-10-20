#!/usr/bin/env python3
"""把修好的 WPS 加载项打成**独立发布物**（不进 xpi）。

为什么要单独一个包：
    WPS 加载项源自 tankwyn/WPS-Zotero，是 GPL-3.0；Papilot 是 Apache-2.0。
    把 GPL 代码静态打进 xpi 会让整包受 GPL 约束，所以这里把它做成**独立组件**：
    卡片里由用户点击下载安装（聚合分发），xpi 只带自有代码。

产物（都放在 dist/，稳定文件名，下载地址不随版本变）：
    papilot-wps-addon.zip            人工安装/查阅用（解压即得加载项目录）
    papilot-wps-addon.bundle.json    插件「一键安装」用：同样是这些文件，base64 内嵌，
                                     落到 jsaddons 后与 zip 解压结果逐字节一致
    papilot-wps-addon.manifest.json  版本 / 两个产物的 sha256 / 文件清单（供人核对与排障）

用法：
    python scripts/wps-zotero/build-addon-zip.py
"""
import hashlib
import json
import os
import sys
import time
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SRC = os.path.join(ROOT, "tools", "wps-zotero", "addon")
DIST = os.path.join(ROOT, "dist")
ZIP_NAME = "papilot-wps-addon.zip"
BUNDLE_NAME = "papilot-wps-addon.bundle.json"
MANIFEST_NAME = "papilot-wps-addon.manifest.json"

# 加载项跑起来所必需的文件（缺一个 WPS 都加载不起来）——打包与校验共用这份清单
REQUIRED = [
    "index.html",
    "ribbon.xml",
    "version.js",
    "js/ribbon.js",
    "js/zclient.js",
    "js/tools.js",
    "js/wpsif.js",
]

SKIP_DIRS = {"__pycache__", ".idea", ".git"}


def read_version():
    with open(os.path.join(SRC, "version.js"), encoding="utf-8") as f:
        text = f.read()
    for line in text.splitlines():
        if "VERSION" in line and "'" in line:
            return line.split("'")[1]
    raise SystemExit("version.js 里找不到 VERSION")


def main():
    if not os.path.isdir(SRC):
        raise SystemExit("找不到加载项源码目录: " + SRC)
    version = read_version()

    files = []
    for root, dirs, names in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for n in sorted(names):
            if n.endswith((".pyc",)) or n == "proxy.py":   # 代理由插件自带，不进加载项包
                continue
            full = os.path.join(root, n)
            rel = os.path.relpath(full, SRC).replace("\\", "/")
            files.append((rel, full))

    rels = {r for r, _ in files}
    missing = [r for r in REQUIRED if r not in rels]
    if missing:
        raise SystemExit("加载项缺必需文件: " + ", ".join(missing))

    index_html = open(os.path.join(SRC, "index.html"), encoding="utf-8").read()
    if 'src="js/ribbon.js"' not in index_html:
        raise SystemExit(
            "index.html 不是静态引入版（WPS 12 不执行 document.write）——先修好再打包")

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, ZIP_NAME)
    if os.path.exists(out):
        os.remove(out)

    # 不打顶层目录：解压出来直接就是 index.html / ribbon.xml …
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, full in files:
            z.write(full, rel)

    data = open(out, "rb").read()

    # ② 插件用 bundle：同一批文件 base64 内嵌（免掉运行时解压 API，行为可单测）
    import base64
    bundle = {
        "name": "papilot-wps-addon",
        "version": version,
        "required": REQUIRED,
        "license": "GPL-3.0 (upstream tankwyn/WPS-Zotero)",
        "files": {},
    }
    for rel, full in files:
        with open(full, "rb") as f:
            bundle["files"][rel] = base64.b64encode(f.read()).decode("ascii")
    bpath = os.path.join(DIST, BUNDLE_NAME)
    with open(bpath, "w", encoding="utf-8", newline="\n") as f:
        json.dump(bundle, f, ensure_ascii=False)
    bdata = open(bpath, "rb").read()

    manifest = {
        "name": "papilot-wps-addon",
        "version": version,
        "zip": ZIP_NAME,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bundle": BUNDLE_NAME,
        "bundleSize": len(bdata),
        "bundleSha256": hashlib.sha256(bdata).hexdigest(),
        "fileCount": len(files),
        "required": REQUIRED,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "license": "GPL-3.0 (upstream tankwyn/WPS-Zotero)",
        "note": "独立组件，不随 papilot xpi 分发；由设置面板「WPS 集成」卡片按需下载安装。",
    }
    mpath = os.path.join(DIST, MANIFEST_NAME)
    with open(mpath, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"加载项版本 : {version}")
    print(f"文件数     : {len(files)}")
    print(f"产物       : {out}（{len(data)} B）")
    print(f"sha256     : {manifest['sha256']}")
    print(f"bundle     : {bpath}（{len(bdata)} B，sha256={manifest['bundleSha256']}）")
    print(f"清单       : {mpath}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
