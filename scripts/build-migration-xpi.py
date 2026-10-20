#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.

"""构建「PaperPilot → Papilot 迁移提示包」

产物：dist/paperpilot-<version>.xpi（扩展 ID 仍是 paperpilot@dev.local）

为什么单独一个脚本：
  主包（build-xpi.py）只打 chrome/ 与顶层文件，刻意**不**包含 migration/，
  避免迁移提示包被塞进 Papilot 本体。这里反过来只打 migration/。

硬校验（防止改错 ID 把老用户彻底焊死）：
  · manifest 的 applications.zotero.id 必须是 paperpilot@dev.local
  · version 必须严格大于 0.54.0（旧清单最后一个版本），否则老用户不会收到
"""

import io
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "migration")
DIST = os.path.join(ROOT, "dist")
REQUIRED_ID = "paperpilot@dev.local"
MIN_VERSION = (0, 54, 0)


def fail(msg):
    print("✗ " + msg)
    sys.exit(1)


def read_manifest():
    p = os.path.join(SRC, "manifest.json")
    if not os.path.exists(p):
        fail("找不到 migration/manifest.json")
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def version_tuple(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        fail("版本号不是数字点分格式：%r" % v)


def main():
    m = read_manifest()
    zot = (m.get("applications") or {}).get("zotero") or {}
    if zot.get("id") != REQUIRED_ID:
        fail("扩展 ID 必须是 %s（当前 %r）——改成新 ID 就等于放弃老用户" % (REQUIRED_ID, zot.get("id")))
    ver = m.get("version")
    if version_tuple(ver) <= MIN_VERSION:
        fail("版本 %s 必须大于 0.54.0，否则老 ID 的更新通道不会拉取" % ver)
    if not zot.get("update_url"):
        fail("缺 update_url —— 装完之后将再也收不到本包之外的任何提示")

    files = []
    for base, _dirs, names in os.walk(SRC):
        for n in names:
            full = os.path.join(base, n)
            rel = os.path.relpath(full, SRC).replace("\\", "/")
            files.append((rel, full))
    files.sort()

    if not any(rel == "bootstrap.js" for rel, _ in files):
        fail("缺 bootstrap.js —— Zotero 7 起必须有入口脚本")

    if not os.path.isdir(DIST):
        os.makedirs(DIST)
    out = os.path.join(DIST, "paperpilot-%s.xpi" % ver)
    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, full in files:
            z.write(full, rel)

    size = os.path.getsize(out)
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        inner = json.loads(z.read("manifest.json").decode("utf-8"))
    if inner.get("version") != ver or len(names) != len(files):
        fail("包内自检失败（版本 %r / 条目 %d）" % (inner.get("version"), len(names)))

    print("迁移提示包：%s" % os.path.relpath(out, ROOT))
    print("  扩展 ID  = %s（旧 ID，供老用户更新通道拉取）" % inner["applications"]["zotero"]["id"])
    print("  版本     = %s" % ver)
    print("  条目 %d 个 / %.1f KB" % (len(names), size / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
