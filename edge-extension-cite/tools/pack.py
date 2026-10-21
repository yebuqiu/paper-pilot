#!/usr/bin/env python3
"""打包「Papilot 引文快取」扩展（zip）。"""

import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def entries():
    out = ["manifest.json", "icons", "src"]
    files = []
    for entry in out:
        path = os.path.join(ROOT, entry)
        if os.path.isfile(path):
            files.append((entry, path))
            continue
        for dirpath, dirnames, filenames in os.walk(path):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "__pycache__")]
            for name in filenames:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
                files.append((rel, full))
    license_src = os.path.join(REPO, "LICENSE")
    if os.path.exists(license_src):
        files.append(("LICENSE", license_src))
    return files


def main():
    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]
    out_dir = os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "papilot-cite-%s.zip" % version)
    if os.path.exists(out):
        os.remove(out)

    files = entries()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name, src in files:
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, open(src, "rb").read())

    print("打包完成：%s" % out)
    print("条目 %d 个，大小 %.2f MB，版本 %s" % (len(files), os.path.getsize(out) / 1048576.0, version))
    return 0


if __name__ == "__main__":
    sys.exit(main())
