#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""把 Zotero 的 Word 插件（Zotero.dotm）装进 WPS 的启动目录，让 WPS 也出现「Zotero」选项卡。

原理（本机取证）：
    WPS 会加载 `<WPS>\\office6\\startup\\` 下的 dotm（相当于 Word 的 STARTUP 目录），
    并执行其中的 customUI + VBA。Zotero 官方那份 dotm 就在
    `C:\\Program Files\\Zotero\\integration\\word-for-windows\\Zotero.dotm`，
    Zotero 自己的「重新安装加载项 Microsoft Word」只写 Word 的 STARTUP，**不写 WPS 的**，
    所以新装的 WPS 默认没有那个选项卡，把 dotm 复制过去就有了。

⚠️ 许可与边界：
    本工具**不打包、不分发** dotm，只把**用户机器上已有的** Zotero 官方文件复制到 WPS 目录。
    dotm 是 Zotero 的一部分（其许可随 Zotero），我们不把它放进 Papilot 的任何发行物。

用法：
    python wps-cite/tools/wps-dotm.py            # 安装（幂等，已有同版本则跳过）
    python wps-cite/tools/wps-dotm.py --check    # 只看状态，不写盘
    python wps-cite/tools/wps-dotm.py --remove   # 卸载（只删字节一致的副本，并还原备份）
"""
import hashlib
import os
import shutil
import subprocess
import sys
import winreg

NAME = "Zotero.dotm"


def sha(path):
    try:
        return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]
    except OSError:
        return ""


def zotero_dotm():
    """按可靠性排序找 Zotero 官方 dotm：注册表 → 默认安装目录 → Program Files 通配。"""
    cands = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Zotero\Zotero") as k:
            for name in ("Install Directory", "InstallDir"):
                try:
                    v, _ = winreg.QueryValueEx(k, name)
                    if v:
                        cands.append(os.path.join(v, "integration", "word-for-windows", NAME))
                except OSError:
                    pass
    except OSError:
        pass
    for root in filter(None, [os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)")]):
        cands.append(os.path.join(root, "Zotero", "integration", "word-for-windows", NAME))
        try:
            for d in os.listdir(root):
                if d.lower().startswith("zotero"):
                    cands.append(os.path.join(root, d, "integration", "word-for-windows", NAME))
        except OSError:
            pass
    for c in cands:
        if os.path.isfile(c):
            return c
    return ""


def wps_startups():
    """找出所有 WPS 的 office6\\startup 目录。

    不能只靠 %LOCALAPPDATA%：本机 WPS 就装在 D 盘的同一用户路径下。
    所以三路并行：运行中的 wps.exe → 各盘符的 Users\\*\\AppData\\Local 与 Program Files → 去重。
    """
    found = []

    # ① 运行中的 wps.exe 最可靠
    try:
        out = subprocess.run(["wmic", "process", "where", "name='wps.exe'", "get",
                              "ExecutablePath", "/value"],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="ignore").stdout
        for line in out.splitlines():
            if line.lower().startswith("executablepath="):
                p = line.split("=", 1)[1].strip()
                if p:
                    found.append(os.path.dirname(p))
    except OSError:
        pass

    # ② 盘符枚举（用户级安装 + 系统级安装）
    roots = []
    for drive in "CDEFGH":
        roots.append(rf"{drive}:\Users\{os.environ.get('USERNAME')}\AppData\Local\Kingsoft\WPS Office")
        roots.append(rf"{drive}:\Program Files\Kingsoft\WPS Office")
        roots.append(rf"{drive}:\Program Files (x86)\Kingsoft\WPS Office")
    roots.append(os.path.join(os.environ.get("LOCALAPPDATA", ""), "Kingsoft", "WPS Office"))
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        try:
            for ver in os.listdir(root):
                base = os.path.join(root, ver, "office6")
                if os.path.isdir(base):
                    found.append(base)
        except OSError:
            pass

    out = []
    for base in found:
        st = os.path.join(base, "startup")
        if os.path.isdir(st) and st not in out:
            out.append(st)
    return out


def target_override():
    """--target <startup 目录>：给"WPS 装在非常规位置"或自动化测试用"""
    if "--target" in sys.argv:
        i = sys.argv.index("--target")
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return ""


def install():
    src = zotero_dotm()
    if not src:
        print("[FAIL] 找不到 Zotero 的 dotm。请先安装 Zotero（或确认 C:\\Program Files\\Zotero 存在）。")
        return 1
    sh = sha(src)
    print(f"源       : {src}（{os.path.getsize(src)} B，sha256 {sh}）")

    override = target_override()
    dirs = [override] if override else wps_startups()
    if override:
        os.makedirs(override, exist_ok=True)
    if not dirs:
        print("[FAIL] 没找到 WPS 的 office6\\startup 目录。请确认装了 WPS 并至少启动过一次。")
        return 1

    rc = 0
    for d in dirs:
        dst = os.path.join(d, NAME)
        if os.path.isfile(dst):
            if sha(dst) == sh:
                print(f"[ OK ] 已是最新：{dst}")
                continue
            bak = dst + ".bak"
            try:
                shutil.copy2(dst, bak)
                print(f"备份     : {bak}")
            except OSError as e:
                print(f"[WARN] 备份失败（继续覆盖）：{e}")
        try:
            shutil.copy2(src, dst)
            print(f"[ OK ] 已复制：{dst}")
        except PermissionError:
            print(f"[FAIL] 无写权限：{d}")
            print("       WPS 若安装在 Program Files 下，需要以管理员身份运行本脚本。")
            rc = 1
        except OSError as e:
            print(f"[FAIL] 复制失败：{dst} → {e}")
            rc = 1

    print()
    print("下一步：完全退出 WPS（含托盘）再打开，功能区应出现「Zotero」选项卡。")
    print("注意：该选项卡来自 dotm + VBA，只有插入引文那套功能，没有 Papilot Cite 的双向链接。")
    return rc


def check():
    src = zotero_dotm()
    sh = sha(src) if src else ""
    print(f"Zotero dotm : {src or '（未找到）'}")
    override = target_override()
    dirs = [override] if override else wps_startups()
    if not dirs:
        print("[FAIL] 没找到 WPS 的 office6\\startup 目录")
        return 1
    bad = 0
    for d in dirs:
        dst = os.path.join(d, NAME)
        if not os.path.isfile(dst):
            print(f"[----] 未安装：{d}")
            bad += 1
        elif sh and sha(dst) == sh:
            print(f"[ OK ] 已安装且与 Zotero 版本一致：{dst}")
        else:
            print(f"[WARN] 已存在但内容不同（可能是旧版）：{dst}")
    return 0 if bad == 0 else 1


def remove():
    src = zotero_dotm()
    sh = sha(src) if src else ""
    override = target_override()
    for d in ([override] if override else wps_startups()):
        dst = os.path.join(d, NAME)
        if not os.path.isfile(dst):
            continue
        # 只删"由本工具复制"的（与 Zotero 源字节一致），避免误删用户自己放的文件
        if sh and sha(dst) != sh:
            print(f"[SKIP] 内容与 Zotero 源不同，保留：{dst}")
            continue
        try:
            os.remove(dst)
            print(f"[ OK ] 已删除：{dst}")
            bak = dst + ".bak"
            if os.path.isfile(bak):
                shutil.move(bak, dst)
                print(f"[ OK ] 已还原备份：{dst}")
        except OSError as e:
            print(f"[FAIL] 删除失败：{dst} → {e}")
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check())
    if "--remove" in sys.argv:
        sys.exit(remove())
    sys.exit(install())
