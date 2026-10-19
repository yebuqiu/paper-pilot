# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.

# -*- coding: utf-8 -*-
"""一次性品牌替换：Papilot -> Papilot（带排除清单与 dry-run）。

用法：
  python scripts/rename-brand.py --dry     # 只统计，不改
  python scripts/rename-brand.py --apply   # 落盘
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {".git", "dist", ".workbuddy", "node_modules", "__pycache__"}
SKIP_PATHS = {
    # 历史快照：记录的是改名前的状态，不能改
    "docs/产品命名评估-重名现状与改名建议-2026-10-19.md",
    # 冻结的旧升级清单：里面的 update_link 指向旧文件名，改了会 404
    "papilot-update.json",
    "server/public/papilot-update-rescue.json",
}
SKIP_EXT = {".pyc", ".xpi", ".png", ".jpg", ".jpeg", ".gif", ".ico",
            ".woff", ".woff2", ".ttf", ".zip", ".gz", ".exe", ".pat", ".log"}

# 顺序敏感：先产物前缀，再仓库名，再品牌名
RULES = [
    ("papilot-", "papilot-"),
    ("zotero-papilot", "zotero-papilot"),
    ("Papilot", "Papilot"),
    ("papilot", "papilot"),
]


def is_text(path):
    try:
        with open(path, "rb") as f:
            chunk = f.read(4096)
        return b"\x00" not in chunk
    except OSError:
        return False


def read_text(path):
    """按 BOM / UTF-8 / GBK 顺序解码，返回 (文本, 回写函数)。

    .bat 是 GBK、部分 PS 脚本带 UTF-8 BOM —— 一律按原编码回写，
    否则中文会变乱码（项目铁律：禁用会改编码的管道式重写）。
    """
    raw = open(path, "rb").read()
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8"), lambda t: open(path, "wb").write(b"\xef\xbb\xbf" + t.encode("utf-8"))
    try:
        return raw.decode("utf-8"), lambda t: open(path, "wb").write(t.encode("utf-8"))
    except UnicodeDecodeError:
        try:
            return raw.decode("gbk"), lambda t: open(path, "wb").write(t.encode("gbk"))
        except UnicodeDecodeError:
            return None, None


def walk():
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
            if rel in SKIP_PATHS:
                continue
            if os.path.splitext(fn)[1].lower() in SKIP_EXT:
                continue
            if not is_text(p):
                continue
            yield p, rel


def main():
    apply_ = "--apply" in sys.argv
    hits = 0
    files = 0
    detail = []
    for p, rel in walk():
        s, writer = read_text(p)
        if s is None:
            continue
        orig = s
        n = 0
        for a, b in RULES:
            if a in s:
                n += s.count(a)
                s = s.replace(a, b)
        if s != orig:
            files += 1
            hits += n
            detail.append((rel, n))
            if apply_:
                writer(s)
    detail.sort(key=lambda x: -x[1])
    for rel, n in detail:
        print("%5d  %s" % (n, rel))
    print("---")
    print("%d files, %d replacements%s" % (files, hits, "" if apply_ else "  (dry-run)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
