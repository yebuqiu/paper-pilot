# -*- coding: utf-8 -*-
"""为仓库内**自有**源文件插入 SPDX 许可头（幂等，可反复运行）。

- JS：`// SPDX-License-Identifier: Apache-2.0` + 版权行
- PY：`# ...`（有 shebang 时插在其后）
- XHTML：`<!-- ... -->`（插在 XML 声明之后）

排除：`chrome/content/scripts/vendor/`（第三方，自带许可头）、
      `chrome/content/scripts/arxiv/arxiv-*.js`（由 tools/arxiv/src 生成，改了会被覆盖）、
      `dist/`、`.workbuddy/`、`node_modules/`。

用法：
  python scripts/add-spdx-headers.py --dry
  python scripts/add-spdx-headers.py --apply
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = "Cassiuschen"
YEAR = "2026"
SPDX = "Apache-2.0"

SKIP_DIRS = {".git", "dist", ".workbuddy", "node_modules", "__pycache__", "vendor"}
SKIP_FILE_PREFIX = ("arxiv-",)  # chrome/content/scripts/arxiv/ 下的生成物


def targets():
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in sorted(fns):
            ext = os.path.splitext(fn)[1].lower()
            if ext not in (".js", ".py", ".xhtml"):
                continue
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
            if rel.startswith("dist/") or rel.startswith(".workbuddy/"):
                continue
            if rel.startswith("chrome/content/scripts/vendor/"):
                continue
            if rel.startswith("chrome/content/scripts/arxiv/") and fn.startswith(SKIP_FILE_PREFIX):
                continue
            yield p, rel, ext


def build_header(ext, first_lines):
    if ext == ".py":
        return ("# SPDX-License-Identifier: %s\n"
                "# Copyright (c) %s %s. All rights reserved.\n" % (SPDX, YEAR, OWNER))
    if ext == ".xhtml":
        return ("<!-- SPDX-License-Identifier: %s | Copyright (c) %s %s -->\n" % (SPDX, YEAR, OWNER))
    return ("// SPDX-License-Identifier: %s\n"
            "// Copyright (c) %s %s. All rights reserved.\n" % (SPDX, YEAR, OWNER))


def main():
    apply_ = "--apply" in sys.argv
    done = skipped = 0
    for p, rel, ext in targets():
        raw = open(p, "rb").read()
        bom = raw.startswith(b"\xef\xbb\xbf")
        try:
            text = raw[3:].decode("utf-8") if bom else raw.decode("utf-8")
        except UnicodeDecodeError:
            print("skip(non-utf8)", rel)
            skipped += 1
            continue
        if "SPDX-License-Identifier" in text[:1200]:
            skipped += 1
            continue

        lines = text.split("\n")
        insert_at = 0
        if ext == ".xhtml" and lines[0].lstrip().startswith("<?xml"):
            insert_at = 1
        # shebang 必须是文件第一行（test/*.js 大量使用 #!/usr/bin/env node）
        if lines[0].startswith("#!"):
            insert_at = 1

        header = build_header(ext, lines[:2])
        # 头部后面留一个空行，避免和原注释粘连
        new_text = "\n".join(lines[:insert_at]) + ("\n" if insert_at else "") + header
        if insert_at:
            new_text += "\n" + "\n".join(lines[insert_at:])
        else:
            new_text += "\n" + text

        done += 1
        if apply_:
            out = new_text.encode("utf-8")
            open(p, "wb").write((b"\xef\xbb\xbf" if bom else b"") + out)

    print("%d files %s, %d skipped" % (done, "updated" if apply_ else "(dry-run)", skipped))


if __name__ == "__main__":
    main()
