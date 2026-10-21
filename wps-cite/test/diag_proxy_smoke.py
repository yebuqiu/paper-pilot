#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""一键诊断包 · 代理侧冒烟（不占端口）

为什么要单独测代理这一半：zip 是**发出去给人看的文件**，一旦
 - 少一个文件、summary 里没有版本/字段清单 → 收到也判断不了问题；
 - config.json 里的 API key 没打码 → 把用户的凭据发出去了。
 这两种错误都不可能在"手动点一下"里稳定复现，所以这里直接调实现函数断言。

**不起服务、不 bind 端口**：只 import proxy 模块，改掉 HOME/CONFIG/LINKS/DIAG_DIR
让它落在临时目录里，再调 diag_handle()。

运行：python test/diag_proxy_smoke.py
"""
import json
import logging
import os
import shutil
import sys
import tempfile
import zipfile

# 第 ⑥ 例会故意触发一次打包失败，diag_handle 里那句 logging.warning 是**预期**的；
# 不压掉的话，测试输出里会冒出一行 WARNING，容易被误当成失败。
logging.disable(logging.WARNING)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "proxy"))
import proxy  # noqa: E402  —— 必须先加 sys.path（脚本目录不是 proxy/）

pass_n = 0
fails = []


def ok(cond, label, extra=None):
    global pass_n
    if cond:
        pass_n += 1
        return True
    fails.append("%s  ← %r" % (label, extra))
    return False


def eq(a, b, label):
    return ok(a == b, label, {"got": a, "want": b})


def contains(hay, needle, label):
    return ok(needle in str(hay), label, {"want": needle, "got": str(hay)[:200]})


TMP = tempfile.mkdtemp(prefix="papilot-diag-smoke-")

try:
    # ---------- 把模块里的路径指到临时目录（模拟 %APPDATA%\\PapilotCite） ----------
    proxy.HOME = TMP
    proxy.DIAG_DIR = os.path.join(TMP, "diag")
    proxy.CONFIG = os.path.join(TMP, "config.json")
    proxy.LINKS = os.path.join(TMP, "links.json")

    # 环境探测不打真网络：这两个函数的行为已在别处覆盖，这里只关心打包结果
    proxy.zotero_alive = lambda: True
    proxy.local_api_ok = lambda: True

    # ---------- 造现场 ----------
    with open(os.path.join(TMP, "proxy.log"), "w", encoding="utf-8") as f:
        for i in range(1, 501):
            f.write("2026-10-21 10:00:00 INFO line-%d\n" % i)

    with open(proxy.CONFIG, "w", encoding="utf-8") as f:
        json.dump({
            "style": "gb-t-7714-2015-numeric",
            "zoteroApiKey": "SECRET-API-KEY-123",
            "nested": {"Token": "SECRET-TOKEN-456", "keep": "visible"},
            "list": [{"password": "SECRET-PWD-789"}],
        }, f, ensure_ascii=False)

    with open(proxy.LINKS, "w", encoding="utf-8") as f:
        items = {}
        for i in range(25):
            items["KEY%04d" % i] = [{"doc": "C:\\p\\a.docx", "page": 3}]
        json.dump({"v": 1, "items": items}, f, ensure_ascii=False)

    # 文档路径指向一个真实文件，summary 里要能报出"存在 + 大小"
    doc_path = os.path.join(TMP, "paper.docx")
    with open(doc_path, "wb") as f:
        f.write(b"x" * 1234)

    PAYLOAD = {
        "version": "0.1.0",
        "docPath": doc_path,
        "fields": [
            {"index": 1, "kind": "citation", "codeLen": 4302, "textLen": 3, "label": "[3]"},
            {"index": 2, "kind": "bib", "codeLen": 118, "textLen": 12, "label": "[1] 张三"},
        ],
        "note": "插入引文按钮没反应",
    }

    # ---------- ① 正常打包 ----------
    res = proxy.diag_handle(PAYLOAD)
    eq(res.get("ok"), True, "① 返回 ok:true")
    zip_path = res.get("path") or ""
    ok(os.path.isabs(zip_path), "① path 是绝对路径", zip_path)
    ok(os.path.basename(zip_path).startswith("papilot-diag-")
       and zip_path.endswith(".zip"), "① 文件名 papilot-diag-*.zip", zip_path)
    ok(os.path.dirname(zip_path) == proxy.DIAG_DIR, "① 落在 diag 目录", zip_path)
    ok(os.path.exists(zip_path), "① zip 真的存在", zip_path)
    eq(res.get("size"), os.path.getsize(zip_path), "① size 与实际字节数一致")

    with zipfile.ZipFile(zip_path) as z:
        names = sorted(z.namelist())
        eq(names, ["config.json", "links.json", "proxy.tail.log", "summary.txt"],
           "① 包内四个文件")
        summary = z.read("summary.txt").decode("utf-8")
        cfg_text = z.read("config.json").decode("utf-8")
        links_text = z.read("links.json").decode("utf-8")
        tail = z.read("proxy.tail.log").decode("utf-8")

    # ---------- ② summary.txt ----------
    contains(summary, "0.1.0", "② summary 含插件版本")
    contains(summary, doc_path, "② summary 含文档路径")
    contains(summary, "存在", "② summary 报出文档存在")
    contains(summary, "1234 字节", "② summary 报出文档大小")
    contains(summary, "127.0.0.1:21932", "② summary 含监听端口")
    contains(summary, "Python", "② summary 含 Python 版本")
    contains(summary, "#1 citation 4302B [3]", "② 字段清单第一条")
    contains(summary, "#2 bib 118B", "② 字段清单第二条")
    contains(summary, "插入引文按钮没反应", "② summary 含 note")
    contains(summary, "字段清单 (2)", "② 字段条数")

    # ---------- ③ config.json 打码 ----------
    ok("SECRET-API-KEY-123" not in cfg_text, "③ 顶层 zoteroApiKey 被打码", cfg_text)
    ok("SECRET-TOKEN-456" not in cfg_text, "③ 嵌套 Token 被打码", cfg_text)
    ok("SECRET-PWD-789" not in cfg_text, "③ 列表里的 password 被打码", cfg_text)
    ok("***" in cfg_text, "③ 打码占位串是 ***")
    contains(cfg_text, "gb-t-7714-2015-numeric", "③ 非密钥字段原样保留")
    contains(cfg_text, "visible", "③ 非密钥的嵌套字段原样保留")

    # ---------- ④ 日志尾巴 ----------
    lines = [l for l in tail.splitlines() if l.strip()]
    eq(len(lines), 400, "④ 只留 400 行")
    contains(tail, "line-500", "④ 有最后一行")
    contains(tail, "line-101", "④ 有第 400 行边界")
    ok("line-100\n" not in tail and not tail.startswith("line-"), "④ 更早的行被丢掉", tail[:60])

    # ---------- ⑤ 台账只留摘要 ----------
    contains(links_text, "台账条数: 25", "⑤ 台账条数正确")
    contains(links_text, "KEY0000", "⑤ 含首条摘要")
    contains(links_text, "仅列前 20 条", "⑤ 超过 20 条时明说截断")
    ok("KEY0024:" not in links_text, "⑤ 第 21 条之后不进去", links_text)
    ok(len(links_text) < 4000, "⑤ links 摘要是小文件（不是整份台账）", len(links_text))

    # ---------- ⑥ 打包失败不崩 ----------
    blocker = os.path.join(TMP, "blocker")
    with open(blocker, "wb") as f:
        f.write(b"not a dir")
    old = proxy.DIAG_DIR
    proxy.DIAG_DIR = os.path.join(blocker, "diag")   # 父路径是文件 → makedirs 必失败
    bad = proxy.diag_handle(PAYLOAD)
    eq(bad.get("ok"), False, "⑥ 目录建不出来时返回 ok:false（不抛）")
    ok(bool(bad.get("error")), "⑥ 带 error 文案", bad)
    proxy.DIAG_DIR = old

    # ---------- ⑦ 请求体不是对象 ----------
    for payload in (["not", "a", "dict"], "string", None, 42):
        r = proxy.diag_handle(payload)
        eq(r.get("ok"), False, "⑦ 非对象请求体返回 ok:false (%r)" % (payload,))
        ok(bool(r.get("error")), "⑦ 非对象请求体带 error")

    # ---------- ⑧ 空字段 / 空文档也能出包 ----------
    r2 = proxy.diag_handle({"version": "", "docPath": "", "fields": []})
    eq(r2.get("ok"), True, "⑧ 空现场也能出包")
    with zipfile.ZipFile(r2["path"]) as z:
        s2 = z.read("summary.txt").decode("utf-8")
    contains(s2, "（未提供", "⑧ 没文档时 summary 写明未提供")
    contains(s2, "（文档里没扫到域）", "⑧ 没域时 summary 写明")

    # ---------- ⑨ 两次连点不覆盖 ----------
    a = proxy.diag_handle(PAYLOAD)
    b = proxy.diag_handle(PAYLOAD)
    ok(a["path"] != b["path"], "⑨ 同秒两次导出不互相覆盖", (a["path"], b["path"]))
    ok(os.path.exists(a["path"]) and os.path.exists(b["path"]), "⑨ 两份都留着")

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("=" * 60)
if fails:
    for f in fails:
        print("  !!  " + f)
    print("=" * 60)
    print("诊断包（代理侧）：%d 通过 / %d 失败" % (pass_n, len(fails)))
    sys.exit(1)
print("诊断包（代理侧）：%d 项断言全部通过" % pass_n)
