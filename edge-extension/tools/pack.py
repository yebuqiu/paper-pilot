#!/usr/bin/env python3
"""打包 Edge 扩展（zip），用于商店提交或侧载分发。

只收 manifest / icons / src / 许可证与第三方声明；排除 node_modules、test、tools、dist。
"""

import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def collect():
    entries = ["manifest.json", "icons", "src"]
    files = []
    for entry in entries:
        path = os.path.join(ROOT, entry)
        if os.path.isfile(path):
            files.append(entry)
            continue
        for dirpath, dirnames, filenames in os.walk(path):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "__pycache__")]
            for name in filenames:
                full = os.path.join(dirpath, name)
                files.append(os.path.relpath(full, ROOT).replace(os.sep, "/"))
    for extra in ("LICENSE", "THIRD-PARTY-NOTICES.md"):
        local = os.path.join(ROOT, extra)
        src = local if os.path.exists(local) else os.path.join(REPO, extra)
        if os.path.exists(src):
            files.append(("__EXTRA__", extra, src))
    return files


def main():
    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]
    out_dir = os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "papilot-edge-%s.zip" % version)
    if os.path.exists(out):
        os.remove(out)

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for item in collect():
            if isinstance(item, tuple):
                _, name, src = item
                data = open(src, "rb").read()
            else:
                name = item
                data = open(os.path.join(ROOT, item), "rb").read()
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)
            count += 1

    size = os.path.getsize(out)
    print("打包完成：%s" % out)
    print("条目 %d 个，大小 %.2f MB，版本 %s" % (count, size / 1048576.0, version))
    return 0


if __name__ == "__main__":
    sys.exit(main())
