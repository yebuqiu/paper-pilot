#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""把 dist 里最新的 Papilot xpi 装进这台机器的 Zotero（本地强制覆盖安装）

为什么要有它：原来那支 `升级Papilot.bat` 里**写死了** `papilot-0.19.0.xpi` 和
`swc79sqh.default` 这个 profile 目录 —— 版本一路走到 0.71，profile 也换了名字，
再双击它等于把插件**降级**到 0.19 甚至直接找不到目录。写死版本号的脚本迟早会咬人，
所以这里改成"取 dist 里最新的、自己找 profile"。

用法：
    python scripts/install-xpi.py            # 装最新
    python scripts/install-xpi.py --dry-run  # 只报告要做什么
    python scripts/install-xpi.py --xpi dist/papilot-0.71.1.xpi
"""
import glob
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADDON_ID = "papilot@dev.local"


def version_key(path):
    m = re.search(r"papilot-(\d+(?:\.\d+)*)\.xpi$", os.path.basename(path))
    if not m:
        return (0,)
    return tuple(int(x) for x in m.group(1).split("."))


def newest_xpi():
    files = [p for p in glob.glob(os.path.join(ROOT, "dist", "papilot-*.xpi"))
             if re.search(r"papilot-\d+(?:\.\d+)*\.xpi$", os.path.basename(p))]
    if not files:
        return ""
    files.sort(key=version_key)
    return files[-1]


def profiles_dir():
    appdata = os.environ.get("APPDATA") or ""
    return os.path.join(appdata, "Zotero", "Zotero", "Profiles")


def find_profile():
    """优先选已经装着 papilot 的 profile；否则选最近改动的那个。"""
    base = profiles_dir()
    cands = [d for d in glob.glob(os.path.join(base, "*")) if os.path.isdir(d)]
    if not cands:
        return "", ""
    for d in cands:
        ext = os.path.join(d, "extensions", ADDON_ID + ".xpi")
        if os.path.isfile(ext):
            return d, ext
    cands.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    d = cands[0]
    return d, os.path.join(d, "extensions", ADDON_ID + ".xpi")


def zotero_running():
    # ★ 不要用 text=True：中文 Windows 的 tasklist 输出是 GBK，Python 按 UTF-8 解码
    #   会抛 UnicodeDecodeError（不是 OSError/SubprocessError，捕获不到）→ 装机脚本每次
    #   刷一段 traceback。直接比 bytes 最稳，且与系统语言无关。
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq zotero.exe"],
                             capture_output=True, timeout=15)
        return b"zotero.exe" in (out.stdout or b"").lower()
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def main(argv):
    dry = "--dry-run" in argv
    xpi = ""
    if "--xpi" in argv:
        xpi = argv[argv.index("--xpi") + 1]
    if not xpi:
        xpi = newest_xpi()
    if not xpi or not os.path.isfile(xpi):
        print("找不到可安装的 xpi（先 python scripts/build-xpi.py <版本>）")
        return 1

    ver = "%d.%d.%d" % (version_key(xpi) + (0, 0, 0))[:3] if len(version_key(xpi)) >= 3 else str(version_key(xpi))
    print("包      : %s（%s，%d 字节）" % (os.path.basename(xpi), ver, os.path.getsize(xpi)))

    prof, dest = find_profile()
    if not prof:
        print("找不到 Zotero profile：%s" % profiles_dir())
        return 1
    print("profile : %s" % prof)
    print("目标    : %s" % dest)
    if os.path.isfile(dest):
        try:
            import zipfile
            with zipfile.ZipFile(dest) as z:
                cur = ""
                if "manifest.json" in z.namelist():
                    import json
                    cur = json.loads(z.read("manifest.json").decode("utf-8")).get("version", "?")
            print("已装版本: %s" % cur)
        except (OSError, ValueError, zipfile.BadZipFile):
            print("已装版本: ？（读不出当前 xpi）")

    if dry:
        print("\n--dry-run：只检查，没有写入。")
        return 0

    if zotero_running():
        print("\n[拒绝] Zotero 正在运行 —— 文件被占用，覆盖会失败。")
        print("       请完全退出 Zotero（含任务栏托盘）后再运行本脚本。")
        return 2

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.isfile(dest):
        bak = dest + ".bak"
        try:
            shutil.copy2(dest, bak)
            print("已备份旧包: %s" % bak)
        except OSError as e:
            print("备份旧包失败（继续尝试覆盖）: %s" % e)
    try:
        shutil.copy2(xpi, dest)
    except OSError as e:
        # WinError 1224/32：Zotero 正把这个 xpi 映射进内存。tasklist 有时抓不到
        # （进程名大小写、本地化输出），所以这里以**实际写入失败**为准给提示。
        print("\n[失败] 写不进目标文件：%s" % e)
        print("       Zotero 正在运行并占着这个 xpi。请完全退出 Zotero（含托盘）后重跑。")
        return 2
    print("已覆盖: %s" % dest)

    # 删掉 addonStartup 缓存：不删的话 Zotero 会沿用上一次的加载清单（判"没有新版本"）
    startup = os.path.join(prof, "addonStartup.json.lz4")
    if os.path.isfile(startup):
        try:
            os.remove(startup)
            print("已删 addonStartup.json.lz4（触发全量重扫）")
        except OSError as e:
            print("删 addonStartup 失败（可忽略）: %s" % e)

    print("\n完成。启动 Zotero 后到「工具 → 插件」确认版本是 %s。" % ver)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
