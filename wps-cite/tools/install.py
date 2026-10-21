#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot Cite · 安装/卸载/自检

做四件事：
  1. 把 addon/ 装进 WPS 的 jsaddons（目录名 = 包内 version.js 的版本）；
  2. 在 publish.xml 写一条 **WPS 12 认的本地注册**（url=目录名，customDomain=""）；
  3. 把 proxy/proxy.py 部署到 %APPDATA%\\PapilotCite 并注册开机自启（Run 项）；
  4. 拉起代理，并打印用户还需要手动做的一件事（WPS 首次信任 + Zotero 开本地 API）。

用法：
    python wps-cite/tools/install.py
    python wps-cite/tools/install.py --uninstall
    python wps-cite/tools/install.py --check        # 只自检
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import winreg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
SRC = os.path.join(ROOT, "addon")
PROXY_SRC = os.path.join(ROOT, "proxy", "proxy.py")
WATCHDOG_SRC = os.path.join(ROOT, "proxy", "watchdog.py")
TASK = "PapilotCiteProxyWatch"
APPDATA = os.environ["APPDATA"]
ADDONS = os.path.join(APPDATA, "kingsoft", "wps", "jsaddons")
HOME = os.path.join(APPDATA, "PapilotCite")
PUBLISH = os.path.join(ADDONS, "publish.xml")
AUTH = os.path.join(ADDONS, "authaddin.json")

NAME = "papilot-cite"
PORT = 21932
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "PapilotCiteProxy"


def version():
    p = os.path.join(SRC, "version.js")
    m = re.search(r"PPC_VERSION\s*=\s*'([^']+)'", open(p, encoding="utf-8").read())
    return m.group(1) if m else "0.0.0"


def port_open(p=PORT):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", p))
        return True
    except OSError:
        return False
    finally:
        s.close()


def pythonw():
    cands = [shutil.which("pythonw.exe"), shutil.which("pythonw")]
    exe = sys.executable
    cands.append(os.path.join(os.path.dirname(exe), "pythonw.exe"))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return exe


def upsert_publish(ver):
    os.makedirs(ADDONS, exist_ok=True)
    target = "%s_%s" % (NAME, ver)
    xml = open(PUBLISH, encoding="utf-8").read() if os.path.isfile(PUBLISH) else "<jsplugins>\n</jsplugins>\n"
    xml = re.sub(r'[ \t]*<jsplugin[^>]*name="%s"[^>]*/>\s*' % re.escape(NAME), "", xml)
    if "</jsplugins>" not in xml:
        xml = "<jsplugins>\n</jsplugins>\n"
    rec = ('    <jsplugin name="%s" type="wps" url="%s" version="%s" '
           'enable="enable_dev" install="null" customDomain=""/>' % (NAME, target, ver))
    xml = xml.replace("</jsplugins>", rec + "\n</jsplugins>")
    open(PUBLISH, "w", encoding="utf-8", newline="\n").write(xml)
    return target


def drop_auth():
    """清掉本插件的授权记录：改名/首次安装时 WPS 才肯重新确认，否则可能沿用旧签名。"""
    if not os.path.isfile(AUTH):
        return
    try:
        data = json.load(open(AUTH, encoding="utf-8"))
    except ValueError:
        return
    for comp in data.values():
        if not isinstance(comp, dict):
            continue
        keep = {k: v for k, v in comp.items()
                if k != "namelist" and not (isinstance(v, dict) and str(v.get("name", "")) == NAME)}
        comp.clear()
        comp.update(keep)
        comp["namelist"] = ";".join(keep.keys())
    try:
        json.dump(data, open(AUTH, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    except OSError:
        pass


def register_watchdog():
    """每分钟检查一次 21932，没在监听就拉起代理。

    为什么必须有它：Run 项与启动文件夹**只在登录时**触发一次；代理进程一旦退出
    （崩溃 / 被安全软件清 / 被上层会话回收），用户下次点「插入引文」就是 `Failed to fetch`。
    计划任务不挂在任何终端会话下，是唯一靠谱的兜底。
    """
    wd = os.path.join(HOME, "watchdog.py")
    tr = '"%s" "%s"' % (pythonw(), wd)
    try:
        r = subprocess.run(["schtasks", "/Create", "/F", "/TN", TASK,
                            "/SC", "MINUTE", "/MO", "1", "/TR", tr],
                           capture_output=True, text=True, encoding="gbk", errors="ignore")
        if r.returncode == 0:
            print("看门狗   : 已注册计划任务 %s（每分钟，端口没起就拉起代理）" % TASK)
        else:
            print("看门狗   : 注册失败（%s），只能靠 Run 项/启动文件夹" % (r.stderr or r.stdout).strip()[:80])
    except OSError as e:
        print("看门狗   : 无法调用 schtasks（%s）" % e)


def remove_watchdog():
    try:
        subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK], capture_output=True)
    except OSError:
        pass


def write_launchers(proxy):
    """三条启动通道，任一条活着代理就能起来：
       ① start-proxy.bat —— 用户手点（连接失败提示里直接给这个路径）
       ② 启动文件夹 .vbs —— 无窗，登录即起
       ③ Run 项（上面已写）
       为什么这么啰嗦：WPS 12 里加载项自己的 ShellExecute 已失效，
       代理只能靠外部拉起；而"代理没跑"正是最常见的"连不上 Zotero"。
    """
    bat = os.path.join(HOME, "start-proxy.bat")
    with open(bat, "w", encoding="gbk", newline="\r\n") as f:
        f.write("@echo off\r\n")
        f.write('start "" "%s" "%%~dp0proxy.py"\r\n' % pythonw())
    vbs = os.path.join(HOME, "start-proxy.vbs")
    with open(vbs, "w", encoding="utf-8", newline="\r\n") as f:
        f.write('Set sh = CreateObject("WScript.Shell")\r\n')
        f.write('sh.Run """%s"" ""%s""", 0, False\r\n' % (pythonw(), proxy))
    startup = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows",
                           "Start Menu", "Programs", "Startup")
    try:
        os.makedirs(startup, exist_ok=True)
        with open(os.path.join(startup, "PapilotCiteProxy.vbs"), "w",
                  encoding="utf-8", newline="\r\n") as f:
            f.write('Set sh = CreateObject("WScript.Shell")\r\n')
            f.write('sh.Run """%s"" ""%s""", 0, False\r\n' % (pythonw(), proxy))
    except OSError as e:
        print("启动文件夹写入失败（不影响 Run 项）：%s" % e)
    return bat


def kill_proxy():
    """停掉占用 21932 的旧代理（改了 proxy.py 必须重启才生效——这个坑踩过一次）"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="ignore").stdout
    except OSError:
        return False
    for line in out.splitlines():
        if "127.0.0.1:21932" in line and "LISTENING" in line:
            pid = line.split()[-1]
            subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
            time.sleep(0.6)
            return True
    return False


def start_proxy(proxy):
    if port_open():
        return True
    try:
        bat = os.path.join(HOME, "start-proxy.bat")
        if os.path.isfile(bat):
            subprocess.Popen([bat], cwd=HOME, shell=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen([pythonw(), proxy], cwd=HOME,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    except OSError:
        return False
    for _ in range(24):
        if port_open():
            return True
        time.sleep(0.25)
    return False


def repair():
    """只修"连不上"：补齐启动脚本 + 拉起代理，不动加载项与信任记录。"""
    os.makedirs(HOME, exist_ok=True)
    proxy = os.path.join(HOME, "proxy.py")
    shutil.copy(PROXY_SRC, proxy)
    shutil.copy(WATCHDOG_SRC, os.path.join(HOME, "watchdog.py"))
    register_watchdog()
    write_launchers(proxy)
    kill_proxy()
    ok = start_proxy(proxy)
    print("代理     : %s" % ("已运行" if ok else "启动失败，请双击 %s" % os.path.join(HOME, "start-proxy.bat")))
    return 0 if ok else 1


def install():
    ver = version()
    target = upsert_publish(ver)
    dst = os.path.join(ADDONS, target)
    existed = os.path.isdir(dst)
    if existed:
        shutil.rmtree(dst)
    shutil.copytree(SRC, dst)
    print("加载项   : %s" % dst)

    # 清同名旧版本，避免 WPS 列出两份
    for n in os.listdir(ADDONS):
        p = os.path.join(ADDONS, n)
        if n.startswith(NAME + "_") and os.path.isdir(p) and n != target:
            shutil.rmtree(p, ignore_errors=True)
            print("清旧版本 : %s" % n)

    os.makedirs(HOME, exist_ok=True)
    proxy = os.path.join(HOME, "proxy.py")
    shutil.copy(PROXY_SRC, proxy)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
        winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, '"%s" "%s"' % (pythonw(), proxy))
    write_launchers(proxy)
    print("代理     : %s（Run 项 + 启动文件夹 双通道自启）" % proxy)

    # 覆盖安装 = 加载项内容变了，WPS 会因签名不符**静默跳过**（不弹窗也不加载）。
    # 所以这里照例清掉记录，让它重新问一次（点确定即恢复）。
    # 只想修连接、不换代码时用 --repair，它不碰加载项。
    drop_auth()
    print("信任记录 : 已清（WPS 下次启动会问一次，点确定即可）")

    kill_proxy()
    started = start_proxy(proxy)
    print("代理状态 : %s" % ("运行中（已重启加载新代码）" if started else "未启动（双击 start-proxy.bat）"))

    if "--with-dotm" in sys.argv:
        print()
        print("—— 顺带把 Zotero 官方的 Word 插件装进 WPS（运行 wps-dotm.py）——")
        subprocess.run([sys.executable, os.path.join(HERE, "wps-dotm.py")])

    print()
    print("还需要你手动做两件事（都只需一次）：")
    print("  1. 完全退出 WPS（含托盘）后重开任意文档；功能区出现「Papilot 引用」时点【确定】信任它。")
    print("  2. Zotero → 设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」。")
    print()
    print("自检：python wps-cite/tools/install.py --check")
    print("可选：想让 WPS 也出现 Zotero 官方选项卡（dotm，依赖 VBA、无双向链接）：")
    print("      python wps-cite/tools/install.py --with-dotm")


def uninstall():
    remove_run()
    remove_watchdog()
    startup = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows",
                           "Start Menu", "Programs", "Startup", "PapilotCiteProxy.vbs")
    if os.path.isfile(startup):
        try:
            os.remove(startup)
            print("已删除启动项 vbs")
        except OSError:
            pass
    for n in os.listdir(ADDONS) if os.path.isdir(ADDONS) else []:
        p = os.path.join(ADDONS, n)
        if n.startswith(NAME + "_") and os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
            print("删除加载项:", n)
    if os.path.isfile(PUBLISH):
        xml = open(PUBLISH, encoding="utf-8").read()
        xml = re.sub(r'[ \t]*<jsplugin[^>]*name="%s"[^>]*/>\s*' % re.escape(NAME), "", xml)
        open(PUBLISH, "w", encoding="utf-8", newline="\n").write(xml)
    drop_auth()
    print("已卸载（台账保留在 %s，需要的话手动删）" % HOME)


def remove_run():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, RUN_VALUE)
    except OSError:
        pass


def check():
    import urllib.request
    ok_all = True

    def line(ok, text):
        nonlocal ok_all
        ok_all = ok_all and ok
        print(("[ OK ] " if ok else "[FAIL] ") + text)

    ver = version()
    dst = os.path.join(ADDONS, "%s_%s" % (NAME, ver))
    line(os.path.isdir(dst), "加载项目录 %s" % dst)
    xml = open(PUBLISH, encoding="utf-8").read() if os.path.isfile(PUBLISH) else ""
    line(NAME in xml and ("%s_%s" % (NAME, ver)) in xml, "publish.xml 注册指向当前版本")
    try:
        auth = open(AUTH, encoding="utf-8").read()
        line(NAME in auth, "WPS 已信任（authaddin 里有记录）")
    except OSError:
        line(False, "还没有 authaddin 记录（首次打开 WPS 点一次信任）")

    try:
        q = subprocess.run(["schtasks", "/Query", "/TN", TASK],
                           capture_output=True, text=True, encoding="gbk", errors="ignore")
        line(q.returncode == 0, "看门狗计划任务 %s 已注册" % TASK)
    except OSError:
        line(False, "无法查询计划任务（schtasks 不可用）")

    line(port_open(), "代理 21932 在监听")
    if port_open():
        try:
            with urllib.request.urlopen("http://127.0.0.1:21932/__health", timeout=3) as r:
                h = json.loads(r.read().decode() or "{}")
            line(bool(h.get("zotero")), "Zotero 23119 可连")
            line(bool(h.get("localApi")), "Zotero 本地 API 已开启（否则检索会 403）")
        except Exception as e:
            line(False, "代理健康检查失败: %s" % e)
    print()
    print("结论：%s" % ("链路就绪" if ok_all else "有项目未就绪，按上面 FAIL 处理"))
    return 0 if ok_all else 1


if __name__ == "__main__":
    if "--uninstall" in sys.argv:
        uninstall()
    elif "--check" in sys.argv:
        sys.exit(check())
    elif "--repair" in sys.argv:
        sys.exit(repair())
    else:
        install()
        print()
        sys.exit(check())
