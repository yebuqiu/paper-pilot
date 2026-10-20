#!/usr/bin/env python3
"""把 WPS-Zotero 加载项安装进 WPS（个人版 / 无 VBA 环境）。

做的事：
  1. 读注册表找到 WPS 安装根目录（校验版本与位数）
  2. 把 tools/wps-zotero/addon 复制到 %APPDATA%\\kingsoft\\wps\\jsaddons\\wps-zotero_<ver>
  3. 按 WPS 官方 wpsjs build 的格式写 publish.xml（url = 目录名，enable="enable_dev"）
  4. 清掉该加载项的旧授权记录，让 WPS 重新确认一次
  5. 在启动目录放一个无窗启动器，登录即拉起 CORS 代理（WPS 12 的 ShellExecute 已失效）
  6. 立即启动代理并自检

用法：
    python scripts/wps-zotero/install.py
    python scripts/wps-zotero/install.py --uninstall
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import winreg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC_ADDON = os.path.join(ROOT, "tools", "wps-zotero", "addon")
ADDONS = os.path.join(os.environ["APPDATA"], "kingsoft", "wps", "jsaddons")
# 代理放在加载项目录之外：可以随时升级，不会改动加载项内容（改动会触发 WPS 的"已被修改"确认）
PROXY_HOME = os.path.join(os.environ["APPDATA"], "Papilot", "wps-zotero")
PUBLISH = os.path.join(ADDONS, "publish.xml")
AUTH = os.path.join(ADDONS, "authaddin.json")
STARTUP = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows", "Start Menu",
                       "Programs", "Startup")
LAUNCHER = os.path.join(STARTUP, "Papilot-WPS-Zotero-Proxy.vbs")
NAME = "wps-zotero"
PROXY_PORT = 21931
ZOTERO_PORT = 23119


# ---------- 基础工具 ----------

def read_version():
    p = os.path.join(SRC_ADDON, "version.js")
    with open(p, encoding="utf-8") as f:
        m = re.search(r"VERSION\s*=\s*'([^']+)'", f.read())
    return m.group(1) if m else "1.0.0"


def wps_root():
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Kingsoft\Office\6.0\common") as k:
        root, _ = winreg.QueryValueEx(k, "InstallRoot")
    return root


def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def pythonw():
    """找一个 pythonw.exe，用于无窗启动代理。"""
    for cand in (shutil.which("pythonw.exe"), shutil.which("pythonw")):
        if cand:
            return cand
    exe = sys.executable
    guess = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return guess if os.path.isfile(guess) else exe


# ---------- 注册表 / 清单 ----------

def upsert_publish(version, target):
    os.makedirs(ADDONS, exist_ok=True)
    record = (f'    <jsplugin name="{NAME}" type="wps" url="{target}" version="{version}" '
              'enable="enable_dev" install="null" customDomain=""/>')
    if os.path.isfile(PUBLISH):
        text = open(PUBLISH, encoding="utf-8").read()
    else:
        text = '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n</jsplugins>\n'
    # 去掉同名旧记录
    text = re.sub(r"[ \t]*<jsplugin[^>]*name=\"%s\"[^>]*/>\s*" % re.escape(NAME), "", text)
    if "</jsplugins>" not in text:
        text = '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n</jsplugins>\n'
    text = text.replace("</jsplugins>", record + "\n</jsplugins>")
    with open(PUBLISH, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def drop_auth_record():
    """删掉该加载项的授权记录：WPS 会重新确认一次，并把正确的签名写回来。"""
    if not os.path.isfile(AUTH):
        return
    try:
        data = json.load(open(AUTH, encoding="utf-8"))
    except (OSError, ValueError):
        return
    for comp in data.values():
        if not isinstance(comp, dict):
            continue
        keep = {}
        for k, v in comp.items():
            if k == "namelist":
                continue
            if isinstance(v, dict) and str(v.get("name", "")).startswith(NAME):
                continue
            keep[k] = v
        comp.clear()
        comp.update(keep)
        comp["namelist"] = ";".join(keep.keys())
    try:
        json.dump(data, open(AUTH, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    except OSError:
        pass


def drop_auth_record_for(name):
    if not os.path.isfile(AUTH):
        return
    try:
        data = json.load(open(AUTH, encoding="utf-8"))
    except (OSError, ValueError):
        return
    for comp in data.values():
        if not isinstance(comp, dict):
            continue
        keep = {k: v for k, v in comp.items()
                if k != "namelist" and not (isinstance(v, dict) and str(v.get("name", "")).startswith(name))}
        comp.clear()
        comp.update(keep)
        comp["namelist"] = ";".join(keep.keys())
    try:
        json.dump(data, open(AUTH, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    except OSError:
        pass


# ---------- 常驻代理 ----------

def write_launcher(proxy_py):
    """用 HKCU\\...\\Run 做登录自启（不受启动目录写权限影响）。"""
    cmd = f'"{pythonw()}" "{proxy_py}"'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                          r"Software\Microsoft\Windows\CurrentVersion\Run") as k:
        winreg.SetValueEx(k, "PapilotWpsZoteroProxy", 0, winreg.REG_SZ, cmd)


def remove_launcher():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                            winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, "PapilotWpsZoteroProxy")
    except OSError:
        pass


def start_proxy(proxy_py):
    if port_open(PROXY_PORT):
        return "already running"
    subprocess.Popen([pythonw(), proxy_py], cwd=os.path.dirname(proxy_py))
    for _ in range(20):
        if port_open(PROXY_PORT):
            return "started"
        import time
        time.sleep(0.25)
    return "failed"


# ---------- 安装 / 卸载 ----------

def install():
    version = read_version()
    root = wps_root()
    print(f"WPS 安装目录: {root}")
    print(f"加载项版本  : {version}")

    target = f"{NAME}_{version}"
    dst = os.path.join(ADDONS, target)
    if os.path.isdir(dst):
        print(f"加载项目录已存在，保持不变: {dst}")
        print("（改动加载项内容会让 WPS 重新询问「已被修改」，所以这里不覆盖）")
    else:
        shutil.copytree(SRC_ADDON, dst)
        print(f"已安装到    : {dst}")

    upsert_publish(version, target)
    print(f"已写入清单  : {PUBLISH}")
    drop_auth_record()
    print("已清理旧授权记录（首次加载会再问一次）")

    os.makedirs(PROXY_HOME, exist_ok=True)
    proxy_py = os.path.join(PROXY_HOME, "proxy.py")
    shutil.copy(os.path.join(SRC_ADDON, "proxy.py"), proxy_py)
    write_launcher(proxy_py)
    print(f"代理已部署  : {proxy_py}")
    print(r"已设置自启  : HKCU\...\Run\PapilotWpsZoteroProxy")
    print("代理状态    :", start_proxy(proxy_py))

    print()
    print("下一步（只需做一次）：")
    print("  1. 完全退出 WPS（含后台常驻），重新打开任意文档")
    print("  2. 功能区出现 Zotero 选项卡时，会弹「加载项“wps-zotero”首次加载，是否信任？」→ 点【确定】")
    print("  3. 之后点【Add/Edit Citation】插入引文、点【Add/Edit Ref】生成参考文献表")
    print()
    print("自检：python scripts/wps-zotero/doctor.py")


def uninstall():
    version = read_version()
    dst = os.path.join(ADDONS, f"{NAME}_{version}")
    # 停代理
    try:
        s = socket.create_connection(("127.0.0.1", PROXY_PORT), timeout=1)
        s.sendall(b"POST /__stopproxy HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        s.close()
    except OSError:
        pass
    remove_launcher()
    print("已删除自启项")
    if os.path.isdir(dst):
        shutil.rmtree(dst, ignore_errors=True)
        print("已删除加载项目录")
    if os.path.isdir(PROXY_HOME):
        shutil.rmtree(PROXY_HOME, ignore_errors=True)
        print("已删除代理目录")
    if os.path.isfile(PUBLISH):
        text = open(PUBLISH, encoding="utf-8").read()
        text = re.sub(r"[ \t]*<jsplugin[^>]*name=\"%s\"[^>]*/>\s*" % re.escape(NAME), "", text)
        open(PUBLISH, "w", encoding="utf-8", newline="\n").write(text)
        print("已从 publish.xml 移除")
    drop_auth_record()
    print("卸载完成")


def install_proxy_only():
    """只部署/更新代理与自启项，不动加载项和授权记录（不会触发 WPS 的确认弹窗）。"""
    os.makedirs(PROXY_HOME, exist_ok=True)
    proxy_py = os.path.join(PROXY_HOME, "proxy.py")
    shutil.copy(os.path.join(SRC_ADDON, "proxy.py"), proxy_py)
    write_launcher(proxy_py)
    print(f"代理已部署  : {proxy_py}")
    print(r"已设置自启  : HKCU\...\Run\PapilotWpsZoteroProxy")
    print("代理状态    :", start_proxy(proxy_py))


if __name__ == "__main__":
    if "--uninstall" in sys.argv:
        uninstall()
    elif "--proxy-only" in sys.argv:
        install_proxy_only()
    else:
        install()
