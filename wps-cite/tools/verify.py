#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Papilot Cite 一次性自检。

回答三个问题，每条都只给 OK / WARN / FAIL：
  1. 部署一致性——WPS 加载项目录里的文件，和源码目录是不是同一份（防止"改了没生效"）
  2. 链路可用性——本地代理 / Zotero / Zotero 本地 API 是否都在
  3. 最近事务健康度——proxy.log 里最后几次集成事务，有没有正常 done、有没有报错痕迹

用法：
    python wps-cite/tools/verify.py
    python wps-cite/tools/verify.py --log 200     # 多看几行日志
退出码：0 全部 OK/WARN；1 有 FAIL。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ADDON_SRC = os.path.normpath(os.path.join(HERE, "..", "addon"))
APPDATA = os.environ.get("APPDATA", "")
JSADDONS = os.path.join(APPDATA, "kingsoft", "wps", "jsaddons")
LOG = os.path.join(APPDATA, "PapilotCite", "proxy.log")

results = []


def report(level, name, detail):
    results.append((level, name, detail))
    print("[%-4s] %s：%s" % (level, name, detail))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def find_installed():
    if not os.path.isdir(JSADDONS):
        return None
    cands = [d for d in os.listdir(JSADDONS) if d.startswith("papilot-cite_")]
    if not cands:
        return None
    cands.sort(key=lambda d: os.path.getmtime(os.path.join(JSADDONS, d)))
    return os.path.join(JSADDONS, cands[-1])


def check_deploy():
    dst = find_installed()
    if not dst:
        report("FAIL", "加载项部署", "WPS 的 jsaddons 下找不到 papilot-cite_* 目录")
        return
    if not os.path.isdir(ADDON_SRC):
        report("FAIL", "加载项部署", "源码目录不存在：" + ADDON_SRC)
        return
    diffs = []
    for root, _dirs, files in os.walk(ADDON_SRC):
        for fn in files:
            src = os.path.join(root, fn)
            rel = os.path.relpath(src, ADDON_SRC)
            target = os.path.join(dst, rel)
            if not os.path.exists(target):
                diffs.append("缺 " + rel)
            elif sha256(src) != sha256(target):
                diffs.append("异 " + rel)
    if diffs:
        report("FAIL", "加载项部署", "部署目录与源码不一致（" + os.path.basename(dst) + "）："
               + "；".join(diffs[:5]) + ("…共 %d 处" % len(diffs) if len(diffs) > 5 else ""))
    else:
        report("OK", "加载项部署", "与源码逐文件一致（" + os.path.basename(dst) + "）")


def http(url, timeout=4):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:                       # noqa: BLE001 —— 自检脚本，任何异常都转成提示
        return 0, str(e)


def check_link():
    code, body = http("http://127.0.0.1:21932/__health")
    if code != 200:
        report("FAIL", "本地代理", "21932 不可达：" + body[:80])
        return
    try:
        j = json.loads(body)
    except ValueError:
        report("FAIL", "本地代理", "health 返回不是 JSON：" + body[:60])
        return
    if not j.get("zotero"):
        report("FAIL", "Zotero", "进程不在或 23119 无响应")
    elif not j.get("localApi"):
        report("WARN", "Zotero 本地 API", "未开启（Zotero → 设置 → 高级 → 允许此计算机上的其他应用程序通信）")
    else:
        report("OK", "本地代理 + Zotero", "21932 与 23119 均正常，本地 API 已开启")


RUN_RE = re.compile(r"ITG run (\w+)")
DONE_RE = re.compile(r"ITG done (\w+)(.*)$")
BAD_RE = re.compile(r"ITG (★[^|]*|setCode 失败|setText 失败|getFields 失败|bad response|handle failed|removeCode 被调用)[^|]*\|?\s*(.*)$")


def tail(path, n):
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    return lines[-n:]


def check_txns(n):
    lines = tail(LOG, n)
    if not lines:
        report("WARN", "事务日志", "还没产生集成日志（说明还没点过按钮，或日志被轮转）")
        return
    runs, dones, bads = [], [], []
    for ln in lines:
        m = RUN_RE.search(ln)
        if m:
            runs.append(m.group(1))
            continue
        m = DONE_RE.search(ln)
        if m:
            dones.append((m.group(1), m.group(2).strip()))
            continue
        m = BAD_RE.search(ln)
        if m:
            bads.append(ln.strip())
    report("OK" if runs else "WARN", "事务尝试", "最近日志里发起过 %d 次：%s"
           % (len(runs), ", ".join(runs) or "无"))
    if dones:
        report("OK", "事务收尾", "完成 %d 次；最后一条：%s %s"
               % (len(dones), dones[-1][0], dones[-1][1]))
    elif runs:
        report("FAIL", "事务收尾", "发起了但没有一条 done —— 事务很可能卡在 Zotero 侧（需重启 Zotero）")
    if bads:
        report("WARN", "异常痕迹", "最近有 %d 条告警，最后一条：%s" % (len(bads), bads[-1][:180]))
    else:
        report("OK", "异常痕迹", "没有截断/失败告警")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", type=int, default=300, help="回看日志行数（默认 300）")
    args = ap.parse_args()

    print("Papilot Cite 自检  —  源码 %s\n" % ADDON_SRC)
    check_deploy()
    check_link()
    check_txns(args.log)

    fails = [r for r in results if r[0] == "FAIL"]
    warns = [r for r in results if r[0] == "WARN"]
    print("\n结论：%s（OK %d / WARN %d / FAIL %d）"
          % ("可交付" if not fails else "有阻塞项，见上", 
             len([r for r in results if r[0] == "OK"]), len(warns), len(fails)))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
