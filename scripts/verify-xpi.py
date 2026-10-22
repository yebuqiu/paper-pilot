#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""真机加载验证：把 xpi 装进**独立临时 profile** 启动 Zotero，读插件自己的
papilot-boot.log 判成败。

为什么用临时 profile 而不是 install-xpi.py：
  · 不碰用户正在用的 Zotero 数据/插件（可并发，互不影响）；
  · boot 日志是插件自己写的，断言的是"插件真的跑起来了"，不是"文件复制成功"。

判定：
  成功 = 日志出现 `init complete`，且没有 STARTUP FAILED / 非组件类 FAILED
          （--expect 的正则还必须全部命中；--install 时注册表必须真的落盘）

用法：
  python scripts/verify-xpi.py --xpi dist/papilot-0.73.0.xpi
  python scripts/verify-xpi.py --xpi dist/papilot-0.73.0-slim.xpi --tag slim \
      --serve-modules --install papilot-mod-pdf \
      --expect "module selftest: ok" --expect "module loaded papilot-mod-pdf"
  python scripts/verify-xpi.py --xpi ... --keep      # 保留 profile 便于手工看
"""

import argparse
import functools
import http.server
import json
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZOTERO = Path(r"C:\Program Files\Zotero\zotero.exe")
ADDON_ID = "papilot@dev.local"
BASE = ROOT / "build" / "verify"


def die(msg):
    print("✗ " + msg, file=sys.stderr)
    raise SystemExit(1)


def kill_tree(pid):
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        pass


def read_log(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def free_port():
    sk = socket.socket()
    sk.bind(("127.0.0.1", 0))
    port = sk.getsockname()[1]
    sk.close()
    return port


def start_catalog_server(dest):
    """把 modules/ 清单 + dist/modules/*.zip 起成本机目录，返回 (server, url)。"""
    (dest / "dist").mkdir(parents=True, exist_ok=True)
    (dest / "modules").mkdir(parents=True, exist_ok=True)
    entries = []
    port = free_port()
    base_url = "http://127.0.0.1:%d" % port

    for mf in sorted((ROOT / "modules").glob("*/module.json")):
        m = json.loads(mf.read_text(encoding="utf-8"))
        mid = m["id"]
        out_dir = dest / "modules" / mid
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "module.json").write_text(
            json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
        zp_src = ROOT / "dist" / "modules" / ("%s-%s.zip" % (mid, m["version"]))
        if not zp_src.is_file():
            die("缺少模块包：%s（先跑 build-module.py --all）" % zp_src)
        shutil.copy2(zp_src, dest / "dist" / zp_src.name)
        entries.append({
            "id": mid,
            "name": m["name"],
            "version": m["version"],
            "description": m.get("description", ""),
            "sizeBytes": zp_src.stat().st_size,
            "fileCount": len(m.get("files") or []),
            "tags": m.get("tags") or [],
            "recommended": False,
            "pro": False,
            "hot": False,
            "whatsNew": m.get("whatsNew", ""),
            "download": {"github": "%s/dist/%s" % (base_url, zp_src.name)},
            "manifest": {"github": "%s/modules/%s/module.json" % (base_url, mid)},
        })

    # 合集也进本地目录（bundles/<id>/module.json + dist/<id>-<ver>.zip）
    for bf in sorted((ROOT / "bundles").glob("*/module.json")):
        b = json.loads(bf.read_text(encoding="utf-8"))
        bid = b["id"]
        out_dir = dest / "bundles" / bid
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "module.json").write_text(
            json.dumps(b, ensure_ascii=False, indent=2), encoding="utf-8")
        zp_src = ROOT / "dist" / "modules" / ("%s-%s.zip" % (bid, b["version"]))
        if not zp_src.is_file():
            die("缺少合集包：%s（先跑 build-module.py --all）" % zp_src)
        shutil.copy2(zp_src, dest / "dist" / zp_src.name)
        entries.insert(0, {
            "id": bid, "name": b["name"], "version": b["version"],
            "description": b.get("description", ""),
            "sizeBytes": zp_src.stat().st_size,
            "fileCount": 0, "tags": ["合集"], "recommended": True,
            "pro": False, "hot": False, "bundle": True,
            "contains": b.get("modules") or [],
            "whatsNew": b.get("whatsNew", ""),
            "download": {"github": "%s/dist/%s" % (base_url, zp_src.name)},
            "manifest": {"github": "%s/bundles/%s/module.json" % (base_url, bid)},
        })

    index = {"schema": 1, "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
             "modules": entries}
    (dest / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(dest))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    srv.log_message = lambda *a, **k: None     # 静音访问日志
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, base_url + "/index.json", len(entries)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xpi", required=True)
    ap.add_argument("--tag", default="", help="profile 子目录后缀，便于区分多次验证")
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--install", default="", metavar="MODULE_ID",
                    help="设 modulesSelftestInstall，启动后按需安装该模块（真机 E2E）")
    ap.add_argument("--serve-modules", action="store_true",
                    help="把 modules/ 清单 + dist/modules 起成本机目录供安装")
    ap.add_argument("--expect", action="append", default=[], metavar="REGEX",
                    help="日志必须命中的正则（可多次）")
    ap.add_argument("--allow-load-failures", action="store_true",
                    help="瘦身包预期：允许 loadSubScript FAILED（文件被拆到组件里）")
    args = ap.parse_args()

    xpi = Path(args.xpi)
    if not xpi.is_file():
        die("找不到 xpi：%s" % xpi)
    if not ZOTERO.is_file():
        die("找不到 Zotero：%s" % ZOTERO)

    with zipfile.ZipFile(xpi) as z:
        if "manifest.json" not in z.namelist():
            die("包内没有 manifest.json，不是合法 xpi")
        man = json.loads(z.read("manifest.json").decode("utf-8"))
        if man.get("applications", {}).get("zotero", {}).get("id") != ADDON_ID:
            die("包内 id 不是 %s" % ADDON_ID)
        pkg_ver = man.get("version", "?")
        for need in ("bootstrap.js", "chrome/content/scripts/main.js",
                     "chrome/content/scripts/core/module-loader.js",
                     "chrome/content/modules/builtin-index.json"):
            if need not in z.namelist():
                die("包内缺少核心文件：%s" % need)

    BASE.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%H%M%S")
    tag = (args.tag + "-") if args.tag else ""
    work = BASE / ("%s%s" % (tag, stamp))
    prof = work / "profile"
    data = work / "data"
    prof.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)

    serve = None
    catalog_url = ""
    if args.serve_modules:
        serve, catalog_url, n = start_catalog_server(work / "serve")
        print("本地目录: %s（%d 个模块）" % (catalog_url, n))

    prefs = [
        'user_pref("extensions.zotero.dataDir", %s);' % json.dumps(str(data)),
        'user_pref("extensions.zotero.useDataDir", true);',
        'user_pref("app.update.auto", false);',
        'user_pref("extensions.autoDisableScopes", 0);',
        'user_pref("extensions.zotero.firstRunGuid", "verified");',
        'user_pref("extensions.zotero.httpServer.enabled", false);',
        'user_pref("extensions.zotero.papilot.wizardDone", "verified");',
    ]
    if catalog_url:
        prefs.append('user_pref("extensions.zotero.papilot.modulesCatalogUrl", %s);'
                     % json.dumps(catalog_url))
    if args.install:
        prefs.append('user_pref("extensions.zotero.papilot.modulesSelftestInstall", %s);'
                     % json.dumps(args.install))
    (prof / "prefs.js").write_text("\n".join(prefs) + "\n", encoding="utf-8")

    extdir = prof / "extensions"
    extdir.mkdir(exist_ok=True)
    shutil.copy2(xpi, extdir / (ADDON_ID + ".xpi"))
    cache = prof / "addonStartup.json.lz4"
    if cache.is_file():
        cache.unlink()

    print("包      : %s（v%s，%d 字节）" % (xpi.name, pkg_ver, xpi.stat().st_size))
    print("profile : %s" % prof)
    print("启动 Zotero（独立 profile，-no-remote）…")

    proc = subprocess.Popen([str(ZOTERO), "-profile", str(prof), "-no-remote"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log_candidates = [data / "papilot-boot.log", prof / "papilot-boot.log"]

    deadline = time.time() + args.timeout
    log_text = ""
    ok_marker = False
    try:
        while time.time() < deadline:
            for lp in log_candidates:
                t = read_log(lp)
                if len(t) > len(log_text):
                    log_text = t
            if "STARTUP FAILED" in log_text:
                break
            if "init complete" in log_text:
                ok_marker = True
                # 再等一会儿，收齐 init 之后的异步诊断（账号恢复 / 组件安装自检）
                extra_deadline = time.time() + (25 if args.install else 4)
                while time.time() < extra_deadline:
                    for lp in log_candidates:
                        t = read_log(lp)
                        if len(t) > len(log_text):
                            log_text = t
                    if args.install and "module selftest:" in log_text and re.search(
                            r"module selftest: (ok|FAILED)", log_text):
                        break
                    time.sleep(2)
                break
            time.sleep(2)
    finally:
        kill_tree(proc.pid)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            pass

    lines = [ln for ln in log_text.splitlines() if ln.strip()]
    fails = [ln for ln in lines if "FAILED" in ln]
    print("\n--- boot 日志（%d 行）---" % len(lines))
    for ln in lines[-26:]:
        print("  " + ln)
    if len(lines) > 26:
        print("  …（省略 %d 行）" % (len(lines) - 26))

    print("\n--- 判定 ---")
    print("  init complete : %s" % ("是" if ok_marker else "否"))
    print("  FAILED 行     : %d" % len(fails))
    for ln in fails[:8]:
        print("    ! " + ln)

    missing_expect = [rx for rx in args.expect if not re.search(rx, log_text)]
    for rx in args.expect:
        print("  expect %-42s %s" % (rx, "命中" if rx not in missing_expect else "缺失"))

    installed_ok = True
    if args.install:
        cands = [prof / "papilot" / "modules" / "installed.json",
                 data / "papilot" / "modules" / "installed.json"]
        reg_file = next((p for p in cands if p.is_file()), None)
        if reg_file is None:
            installed_ok = False
            print("  已装注册表   : 文件不存在")
        else:
            try:
                obj = json.loads(reg_file.read_text(encoding="utf-8"))
                entry = (obj.get("modules") or {}).get(args.install)
                installed_ok = bool(entry)
                print("  已装注册表   : %s → %s" % (args.install,
                      (entry or {}).get("version", "缺失")))
            except (OSError, ValueError) as e:
                installed_ok = False
                print("  已装注册表   : 读取失败 %s" % e)

    if serve is not None:
        try:
            serve.shutdown()
            serve.server_close()
        except OSError:
            pass
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
        print("  （临时 profile 已清理；--keep 可保留）")
    else:
        print("  profile 保留在：%s" % work)

    if not ok_marker:
        print("\n✗ 真机验证失败：插件未完成初始化")
        raise SystemExit(1)
    unexpected = [ln for ln in fails
                  if "module" not in ln.lower()
                  and not (args.allow_load_failures and "loadSubScript FAILED" in ln)]
    if unexpected:
        print("\n✗ 真机验证失败：存在 %d 条非组件类 FAILED" % len(unexpected))
        raise SystemExit(1)
    if missing_expect:
        print("\n✗ 真机验证失败：日志缺少预期行 %s" % missing_expect)
        raise SystemExit(1)
    if args.install and not installed_ok:
        print("\n✗ 真机验证失败：模块 %s 未落到注册表" % args.install)
        raise SystemExit(1)
    print("\n✓ 真机验证通过：插件在 Zotero 中完成初始化")


if __name__ == "__main__":
    main()
