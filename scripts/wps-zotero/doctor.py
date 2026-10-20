#!/usr/bin/env python3
"""WPS-Zotero 集成自检：逐项检查"WPS ↔ 加载项 ↔ 代理 ↔ Zotero"这条链。

用法：python scripts/wps-zotero/doctor.py
"""
import json
import os
import re
import socket
import sys
import urllib.request
import winreg

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
ADDONS = os.path.join(os.environ["APPDATA"], "kingsoft", "wps", "jsaddons")
PUBLISH = os.path.join(ADDONS, "publish.xml")
AUTH = os.path.join(ADDONS, "authaddin.json")
NAME = "wps-zotero"
PROXY = 21931
ZOTERO = 23119
OK, BAD, WARN = "[ OK ]", "[FAIL]", "[WARN]"


def tcp(port):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status, r.read(400).decode("utf-8", "replace")
    except Exception as e:
        return None, str(e)


def main():
    problems = []

    # 1. WPS
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Kingsoft\Office\6.0\common") as k:
            root, _ = winreg.QueryValueEx(k, "InstallRoot")
            ver, _ = winreg.QueryValueEx(k, "Version")
        exe = os.path.join(root, "office6", "wps.exe")
        arch = "x86"
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Kingsoft\Office\6.0\common") as k:
                arch, _ = winreg.QueryValueEx(k, "Architecture")
        except OSError:
            pass
        print(f"{OK} WPS {ver} ({arch})  {exe if os.path.isfile(exe) else '未找到 wps.exe'}")
    except OSError as e:
        print(f"{BAD} 读取 WPS 注册表失败: {e}")
        problems.append("WPS 未安装或注册表缺失")

    # 2. Zotero 本体
    if tcp(ZOTERO):
        st, body = get(f"http://127.0.0.1:{ZOTERO}/connector/ping")
        if st == 200:
            print(f"{OK} Zotero 在 {ZOTERO} 端口应答")
        else:
            print(f"{WARN} Zotero 端口通但 ping 异常: {st} {body[:60]}")
    else:
        print(f"{BAD} Zotero 未运行（{ZOTERO} 端口无应答）")
        problems.append("启动 Zotero")

    # 3. 代理
    if tcp(PROXY):
        st, body = get(f"http://127.0.0.1:{PROXY}/__health")
        print(f"{OK} CORS 代理在 {PROXY} 端口，健康检查: {body[:60]}")
        st2, body2 = get(f"http://127.0.0.1:{PROXY}/connector/ping")
        if st2 == 200:
            print(f"{OK} 代理 → Zotero 转发正常（Host 头已改写）")
        else:
            print(f"{BAD} 代理转发异常: {st2} {body2[:80]}")
            problems.append("代理转发失败")
    else:
        print(f"{BAD} CORS 代理未运行（{PROXY} 端口无应答）")
        problems.append("运行 pythonw <jsaddons>/wps-zotero_*/proxy.py")

    # 4. 加载项注册
    if os.path.isfile(PUBLISH):
        text = open(PUBLISH, encoding="utf-8").read()
        m = re.search(r'<jsplugin[^>]*name="%s"[^>]*/>' % re.escape(NAME), text)
        if m:
            print(f"{OK} publish.xml 已注册: {m.group(0).strip()[:110]}")
            ver = re.search(r'version="([^"]+)"', m.group(0))
            ver = ver.group(1) if ver else ""
            dst = os.path.join(ADDONS, f"{NAME}_{ver}")
            if os.path.isdir(dst):
                idx = os.path.join(dst, "index.html")
                need = os.path.isfile(idx) and "js/ribbon.js" in open(idx, encoding="utf-8").read()
                print(f"{OK if need else WARN} 加载项目录: {dst}" + ("" if need else "（index.html 未静态引脚本）"))
            else:
                print(f"{BAD} 注册指向的目录不存在: {dst}")
                problems.append("重新运行 install.py")
        else:
            print(f"{BAD} publish.xml 里没有 {NAME} 记录")
            problems.append("运行 install.py")
    else:
        print(f"{BAD} 缺少 {PUBLISH}")
        problems.append("运行 install.py")

    # 5. 授权记录
    if os.path.isfile(AUTH):
        try:
            data = json.load(open(AUTH, encoding="utf-8"))
        except ValueError:
            data = {}
        rec = None
        for comp in data.values():
            if isinstance(comp, dict):
                for v in comp.values():
                    if isinstance(v, dict) and str(v.get("name", "")).startswith(NAME):
                        rec = v
        if rec and rec.get("isload") and rec.get("md5"):
            print(f"{OK} WPS 已信任该加载项（isload=true, md5 已记录）")
        else:
            print(f"{WARN} 尚未确认信任：下次打开 WPS 会弹「首次加载，是否信任？」→ 点确定")
    else:
        print(f"{WARN} 还没有授权记录文件（首次加载后生成）")

    # 6. 自启项（HKCU Run）
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Run") as k:
            cmd, _ = winreg.QueryValueEx(k, "PapilotWpsZoteroProxy")
        print(f"{OK} 代理自启项: {cmd[:90]}")
    except OSError:
        print(f"{WARN} 代理自启项未安装（重启后需手动起代理：install.py --proxy-only）")

    # 7. 独立发布物（卡片一键安装用）与源码是否一致
    import base64
    bundle = os.path.join(ROOT, "dist", "papilot-wps-addon.bundle.json")
    src = os.path.join(ROOT, "tools", "wps-zotero", "addon")
    if os.path.isfile(bundle) and os.path.isdir(src):
        import json as _json
        try:
            data = _json.load(open(bundle, encoding="utf-8"))
            diff = []
            for rel, b64 in (data.get("files") or {}).items():
                fp = os.path.join(src, rel.replace("/", os.sep))
                if not os.path.isfile(fp):
                    diff.append(rel + "(缺)")
                    continue
                if base64.b64decode(b64) != open(fp, "rb").read():
                    diff.append(rel + "(内容不同)")
            print(f"{OK if not diff else BAD} 发布物 bundle v{data.get('version')} 与源码一致"
                  + ("" if not diff else " → " + ",".join(diff[:4])))
        except (OSError, ValueError) as e:
            print(f"{BAD} 发布物解析失败: {e}")
    else:
        print(f"{WARN} 未找到 dist/papilot-wps-addon.bundle.json（跑 build-addon-zip.py 生成）")

    print()
    if problems:
        print("需要处理：")
        for p in problems:
            print("  -", p)
        return 1
    print("链路检查通过。若功能区还没出现 Zotero 选项卡：完全退出 WPS（含托盘）后重开。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
