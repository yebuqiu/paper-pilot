#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""代理安全冒烟：Origin 白名单 + /open 白名单

为什么不走网络：测试要能在 CI/开发机直接跑，不该依赖 21932 端口是否空闲。
这里用 socketpair 把一段手写 HTTP 请求喂给 proxy.handle()，读回响应断言状态码。

覆盖（对应审查 P0-1）：
  ① 外站 Origin（https://evil.example）打 /links 必须 403
  ② 本机 Origin（http://127.0.0.1:xxxx / http://localhost / null）放行
  ③ 不带 Origin（curl / python 脚本）放行
  ④ /open 拒 .exe / .bat / .ps1
  ⑤ /open 放行 zotero://（不真启动，拦截 os.startfile）
  ⑥ /open 放行 .docx 等文档扩展（不真启动）

运行：python test/proxy_security_smoke.py
"""
import json
import logging
import os
import shutil
import socket
import sys
import tempfile

logging.disable(logging.WARNING)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "proxy"))
import proxy  # noqa: E402

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


def do_request(raw, startfile_stub=None):
    """把一段原始 HTTP 请求喂给 handle()，返回 (status_code, body_str)。"""
    srv, cli = socket.socketpair()
    try:
        srv.sendall(raw)
        try:
            srv.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        orig = proxy.os.startfile
        if startfile_stub is not None:
            proxy.os.startfile = startfile_stub
        try:
            proxy.handle(cli)
        finally:
            if startfile_stub is not None:
                proxy.os.startfile = orig
        out = b""
        while True:
            chunk = srv.recv(65536)
            if not chunk:
                break
            out += chunk
        head, _, body = out.partition(b"\r\n\r\n")
        try:
            code = int(head.split(b" ", 2)[1])
        except (ValueError, IndexError):
            code = -1
        return code, body.decode("utf-8", "replace")
    finally:
        try:
            srv.close()
        except OSError:
            pass
        try:
            cli.close()
        except OSError:
            pass


def req(method, path, origin=None, body=None):
    lines = ["%s %s HTTP/1.1" % (method, path), "Host: 127.0.0.1:21932"]
    if origin is not None:
        lines.append("Origin: " + origin)
    payload = b""
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        lines.append("Content-Type: application/json")
        lines.append("Content-Length: %d" % len(payload))
    lines.append("Connection: close")
    lines.append("")
    lines.append("")
    head = "\r\n".join(lines).encode("latin1")
    return head + payload


TMP = tempfile.mkdtemp(prefix="papilot-sec-smoke-")
try:
    proxy.HOME = TMP
    proxy.DIAG_DIR = os.path.join(TMP, "diag")
    proxy.CONFIG = os.path.join(TMP, "config.json")
    proxy.LINKS = os.path.join(TMP, "links.json")
    with open(proxy.LINKS, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "items": {}}, f)

    # ---------- ① 外站 Origin 被拒 ----------
    code, body = do_request(req("GET", "/links?itemKey=K1", origin="https://evil.example.com"))
    eq(code, 403, "① 外站 https Origin /links 必须 403")
    ok("origin" in body.lower(), "① 响应里点明是 origin 问题", body[:120])

    # 外站 http 也一样
    code, _ = do_request(req("GET", "/links?itemKey=K1", origin="http://evil.example.com"))
    eq(code, 403, "① 外站 http Origin 也拒")

    # 别的端口上的非本机 host 也拒
    code, _ = do_request(req("POST", "/log", origin="http://192.168.1.5:8080",
                             body={"msg": "x"}))
    eq(code, 403, "① 局域网 IP Origin 也拒")

    # ---------- ② 本机 Origin 放行 ----------
    for org in ("http://127.0.0.1:8080", "http://127.0.0.1", "http://localhost:3000",
                "http://localhost", "null"):
        code, _ = do_request(req("GET", "/links?itemKey=K1", origin=org))
        eq(code, 200, "② Origin %r 放行" % org)

    # ---------- ③ 不带 Origin 放行 ----------
    code, _ = do_request(req("GET", "/links?itemKey=K1"))
    eq(code, 200, "③ 不带 Origin（curl/python）放行")

    code, _ = do_request(req("POST", "/log", body={"msg": "hi"}))
    eq(code, 200, "③ POST /log 不带 Origin 放行")

    # ---------- ④ /open 拒危险扩展 ----------
    called = []

    def spy_startfile(p):
        called.append(p)
        return None

    for bad in ("C:/tmp/evil.exe", "C:/tmp/evil.bat", "C:/tmp/evil.cmd",
                "C:/tmp/evil.ps1", "C:/tmp/evil.msi", "C:/tmp/evil.lnk"):
        called[:] = []
        code, body = do_request(req("POST", "/open", body={"path": bad}),
                                startfile_stub=spy_startfile)
        eq(code, 403, "④ /open 拒 %s" % os.path.basename(bad))
        eq(len(called), 0, "④ %s 没真去 startfile" % os.path.basename(bad))

    # file:// 形式的 .exe 也拦
    called[:] = []
    code, _ = do_request(req("POST", "/open", body={"uri": "file:///C:/tmp/evil.exe"}),
                         startfile_stub=spy_startfile)
    eq(code, 403, "④ /open 拒 file:// 形式的 uri")
    eq(len(called), 0, "④ file:// 没真去 startfile")

    # http(s) uri 也拦
    called[:] = []
    code, _ = do_request(req("POST", "/open", body={"uri": "http://evil.example/x"}),
                         startfile_stub=spy_startfile)
    eq(code, 403, "④ /open 拒 http(s) uri")
    eq(len(called), 0, "④ http uri 没真去 startfile")

    # ---------- ⑤ /open 放行 zotero:// ----------
    called[:] = []
    code, body = do_request(req("POST", "/open",
                                body={"uri": "zotero://select/library/items/ABCD1234"}),
                            startfile_stub=spy_startfile)
    eq(code, 200, "⑤ /open 放行 zotero://")
    eq(len(called), 1, "⑤ zotero:// 真的调了 startfile")
    ok(called and called[0].startswith("zotero://"), "⑤ 调的是 zotero:// 那条", called)

    # ---------- ⑥ /open 放行文档扩展 ----------
    doc_file = os.path.join(TMP, "paper.docx")
    with open(doc_file, "wb") as f:
        f.write(b"fake")
    for ext in (".docx", ".doc", ".pdf", ".xlsx", ".pptx", ".txt", ".md"):
        p = os.path.join(TMP, "a" + ext)
        with open(p, "wb") as f:
            f.write(b"x")
        called[:] = []
        code, body = do_request(req("POST", "/open", body={"path": p}),
                                startfile_stub=spy_startfile)
        eq(code, 200, "⑥ /open 放行 %s" % ext)
        eq(len(called), 1, "⑥ %s 真去 startfile" % ext)

    # 文档路径不存在 → 404（不是 403，白名单通过但文件没有）
    called[:] = []
    code, _ = do_request(req("POST", "/open",
                             body={"path": os.path.join(TMP, "nope.docx")}),
                         startfile_stub=spy_startfile)
    eq(code, 404, "⑥ 不存在的 .docx 回 404")
    eq(len(called), 0, "⑥ 不存在不会去 startfile")

    # ---------- ⑦ OPTIONS 预检不受 Origin 影响（保持原行为） ----------
    code, _ = do_request(req("OPTIONS", "/links", origin="https://evil.example.com"))
    eq(code, 200, "⑦ OPTIONS 预检仍 200（CORS 由浏览器判）")

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("=" * 60)
if fails:
    for f in fails:
        print("  !!  " + f)
    print("=" * 60)
    print("代理安全冒烟：%d 通过 / %d 失败" % (pass_n, len(fails)))
    sys.exit(1)
print("代理安全冒烟：%d 项断言全部通过" % pass_n)
