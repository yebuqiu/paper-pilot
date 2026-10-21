#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot Cite · 本地代理（21932）

四件事，每一件都是"浏览器沙箱做不到、但集成必须做"的：
  1. 转发 Zotero 本地 API（127.0.0.1:23119/api/…），补 CORS 头 —— 加载项在浏览器环境里跨源会被拦；
     转发时改写 Host（Zotero 10 会校验，非 127.0.0.1:23119 直接 400）。
  2. 维护**反向链接台账**（%APPDATA%\\PapilotCite\\links.json）——"这篇 PDF 被哪些文档引用"，
     Zotero 原生没有这个能力，由文档侧每次刷新时 upsert。
  3. 打开 zotero:// 链接与本地文档 —— WPS 12 里加载项的 ShellExecute 已失效，只能由外部进程代劳。
  4. 存一点无关键配置（当前样式），避免依赖 WPS 的 localStorage 行为。

用法：
    pythonw proxy.py            # 后台常驻（开机自启用 Run 项）
    python proxy.py status
    python proxy.py stop
"""
import base64
import json
import logging
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

ZOTERO = "127.0.0.1"
ZOTERO_PORT = 23119
LISTEN_PORT = 21932
HOME = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "PapilotCite")
LINKS = os.path.join(HOME, "links.json")
CONFIG = os.path.join(HOME, "config.json")

CORS = (
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET,POST,OPTIONS,PUT,DELETE\r\n"
    "Access-Control-Allow-Headers: *\r\n"
    "Access-Control-Max-Age: 86400\r\n"
)

_LOCK = threading.RLock()
STOP = threading.Event()


def _is_utf8(path):
    try:
        with open(path, "rb") as f:
            f.read().decode("utf-8")
        return True
    except (OSError, UnicodeDecodeError):
        return False


def setup_log():
    os.makedirs(HOME, exist_ok=True)
    path = os.path.join(HOME, "proxy.log")
    try:
        if os.path.exists(path) and os.path.getsize(path) > 512 * 1024:
            os.remove(path)
        # 旧版本用系统编码（GBK）写过日志；混进一个非 UTF-8 字节，整个文件就会
        # 被 grep / 编辑器判定为 binary，排查时读不出来。启动时挪走。
        if os.path.exists(path) and not _is_utf8(path):
            prev = path + ".prev"
            try:
                if os.path.exists(prev):
                    os.remove(prev)
                os.replace(path, prev)
            except OSError:
                pass
    except OSError:
        pass
    logging.basicConfig(filename=path, filemode="a",
                        format="%(asctime)s %(levelname)s %(message)s",
                        level=logging.INFO,
                        # 必须显式 utf-8：默认走系统编码（GBK）时，日志里出现
                        # 特殊字符后整个文件会被 grep/编辑器当成二进制，排查时读不出来。
                        encoding="utf-8")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def zotero_alive():
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect((ZOTERO, ZOTERO_PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def local_api_ok():
    """本地 API 未开启时 Zotero 返回 403，这里用一次轻量请求判定。"""
    try:
        req = urllib.request.Request(
            "http://%s:%d/api/users/0/items?limit=1" % (ZOTERO, ZOTERO_PORT),
            headers={"Host": "%s:%d" % (ZOTERO, ZOTERO_PORT), "Zotero-API-Version": "3"})
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        return e.code != 403
    except (urllib.error.URLError, OSError):
        return False


# ---------------- 窗格 → 主页面 的插入队列 ----------------
# 为什么需要：WPS 的任务窗格是独立页面，未必注入 wps 对象。窗格只负责"选文献"，
# 把结果放进这个队列；主页面（index.html，一定有 wps）定时取走并真正写入文档。
_QUEUE = []
_QUEUE_LOCK = threading.Lock()


def queue_push(items):
    with _QUEUE_LOCK:
        _QUEUE.extend(items or [])
        n = len(_QUEUE)
    logging.info("queue push %d (pending %d)", len(items or []), n)
    return n


def queue_pop():
    with _QUEUE_LOCK:
        items = list(_QUEUE)
        _QUEUE.clear()
    if items:
        logging.info("queue pop %d", len(items))
    return items


# ---------------- 台账 ----------------

def links_upsert(doc, cites):
    with _LOCK:
        data = read_json(LINKS, {"v": 1, "items": {}})
        items = data.setdefault("items", {})
        # 先删该文档的旧记录，再整体写入（文档是台账的"权威来源"）
        for key in list(items.keys()):
            items[key] = [r for r in items[key] if os.path.normcase(r.get("doc", "")) != os.path.normcase(doc)]
            if not items[key]:
                del items[key]
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for c in cites or []:
            key = str(c.get("itemKey") or "")
            if not key:
                continue
            rec = dict(c)
            rec["doc"] = doc
            rec["updatedAt"] = now
            items.setdefault(key, []).append(rec)
        write_json(LINKS, data)
        logging.info("links upsert doc=%s cites=%d", doc, len(cites or []))
        return len(cites or [])


def links_query(item_key, page=None, doc=None):
    data = read_json(LINKS, {"v": 1, "items": {}})
    rows = list((data.get("items") or {}).get(item_key, []))
    if page not in (None, "", 0, "0"):
        rows = [r for r in rows if int(r.get("page") or 0) == int(page)]
    if doc:
        rows = [r for r in rows if os.path.normcase(r.get("doc", "")) != os.path.normcase(doc)]
    return rows


# ---------------- HTTP ----------------

def read_msg(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(65536)
        if not chunk:
            return b"", b""
        data += chunk
        if len(data) > 8 * 1024 * 1024:
            break
    head, _, body = data.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n")[1:]:
        if line.lower().startswith(b"content-length:"):
            try:
                length = int(line.split(b":", 1)[1].strip())
            except ValueError:
                length = 0
    while len(body) < length:
        chunk = sock.recv(65536)
        if not chunk:
            break
        body += chunk
    return head, body[:length] if length else body


def send(sock, code, body=b"", ctype="application/json; charset=utf-8", extra=""):
    if isinstance(body, (dict, list)):
        body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    elif isinstance(body, str):
        body = body.encode("utf-8")
    head = ("HTTP/1.1 %d %s\r\n%sContent-Type: %s\r\nContent-Length: %d\r\n"
            "Connection: close\r\n%s\r\n") % (
        code, {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
               500: "Server Error", 502: "Bad Gateway"}.get(code, "OK"),
        CORS, ctype, len(body), extra)
    sock.sendall(head.encode("latin1") + body)


def forward(method, path, headers, body, timeout=20):
    """把 /zotero/xxx 转发到 Zotero 本地 API，并改写 Host。"""
    url = "http://%s:%d%s" % (ZOTERO, ZOTERO_PORT, path)
    h = {k: v for k, v in headers.items()
         if k.lower() in ("accept", "zotero-api-version", "content-type")}
    h["Host"] = "%s:%d" % (ZOTERO, ZOTERO_PORT)
    req = urllib.request.Request(url, data=body if method in ("POST", "PUT", "PATCH") else None,
                                 headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "application/json")
    except (urllib.error.URLError, OSError) as e:
        return 502, json.dumps({"error": str(e)}).encode(), "application/json"


def handle(client):
    try:
        head, body = read_msg(client)
        if not head:
            return
        line = head.split(b"\r\n")[0].decode("latin1")
        parts = line.split(" ")
        method, target = parts[0].upper(), (parts[1] if len(parts) > 1 else "/")
        headers = {}
        for raw in head.split(b"\r\n")[1:]:
            if b":" in raw:
                k, v = raw.split(b":", 1)
                headers[k.decode("latin1").strip()] = v.decode("latin1").strip()

        from urllib.parse import urlparse, parse_qs, unquote
        u = urlparse(target)
        path, qs = u.path, parse_qs(u.query)

        if method == "OPTIONS":
            return send(client, 200, b"", extra="")

        if path == "/__beacon":
            # 1x1 透明 GIF：图片请求不受 CORS 约束，用来确认"加载项页面能不能碰到代理"。
            # 用户报"连不上"时，先看日志里有没有这行 —— 有=网通、问题在别处；没有=请求就被拦了。
            logging.info("beacon from addon t=%s", (qs.get("t") or [""])[0])
            gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
            return send(client, 200, gif, "image/gif")

        if path == "/__health":
            # 记一行：加载项启动时会自动探一次，这行就是"JS 跑了且网通了"的硬证据
            logging.info("health probe ok-zotero=%s", zotero_alive())
            return send(client, 200, {"ok": True, "zotero": zotero_alive(),
                                      "localApi": local_api_ok() if zotero_alive() else False})

        if path == "/log" and method == "POST":
            # 加载项把"点了什么、WPS 有哪些 API、报什么错"写到这里。
            # 目的：WPS 的界面不能自动化点，只能靠这条通道把现场搬出来。
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                payload = {"msg": body.decode("utf-8", "replace")[:300]}
            extra = payload.get("extra")
            logging.info("ADDON %s%s", payload.get("msg", ""),
                         (" | " + json.dumps(extra, ensure_ascii=False))[:600] if extra else "")
            return send(client, 200, {"ok": True})

        if path.startswith("/zit/"):
            # Zotero 集成协议（execCommand/respond）：**长轮询**——Zotero 会把"下一条命令"
            # 当响应下发，可能等用户在对话框里操作很久。超时必须远大于普通转发。
            # ★ 这个值 = 用户在弹出的「添加引文」框里最多能挑多久。给 240s 时，
            #   挑文献超过 4 分钟就断链，Zotero 侧事务卡在 inProgress（之后全 503）。
            #   现在给 30 分钟，正常操作不可能超过。
            sub = path[len("/zit"):] + (("?" + u.query) if u.query else "")
            code, data, ctype = forward(method, sub, headers, body, timeout=1800)
            return send(client, code, data, ctype)

        if path.startswith("/zotero/"):
            sub = path[len("/zotero"):] + (("?" + u.query) if u.query else "")
            code, data, ctype = forward(method, sub, headers, body)
            return send(client, code, data, ctype)

        if path == "/jsonp":
            # file:// 页面里的 fetch 可能被 CEF 拦；script 标签不受 CORS 约束，
            # 所以给弹窗页留一条 JSONP 通道：/jsonp?fn=cb&p=<path?query>
            from urllib.parse import unquote
            fn = (qs.get("fn") or ["cb"])[0]
            target = unquote((qs.get("p") or [""])[0])
            if not target.startswith("/"):
                return send(client, 400, "cb({error:'bad p'})", "application/javascript; charset=utf-8")
            if target.startswith("/queue-push?"):
                try:
                    items = json.loads(unquote(target.split("?", 1)[1]))
                    queue_push(items.get("items") or [])
                    payload = json.dumps({"ok": True})
                except ValueError:
                    payload = json.dumps({"ok": False})
            elif target.startswith("/config"):
                payload = json.dumps(read_json(CONFIG, {}), ensure_ascii=False)
            else:
                if target.startswith("/zotero"):
                    target = target[len("/zotero"):]
                code, data, _ = forward("GET", target, {"Zotero-API-Version": "3"}, b"")
                payload = data.decode("utf-8", "replace")
            body = "%s(%s);" % (fn, payload)
            return send(client, 200, body, "application/javascript; charset=utf-8")

        if path == "/queue":
            if method == "POST":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                except ValueError:
                    return send(client, 400, {"error": "bad json"})
                return send(client, 200, {"pending": queue_push(payload.get("items") or [])})
            return send(client, 200, {"items": queue_pop()})

        if path == "/links" and method == "GET":
            rows = links_query((qs.get("itemKey") or [""])[0],
                               (qs.get("page") or [None])[0],
                               (qs.get("excludeDoc") or [None])[0])
            return send(client, 200, rows)

        if path == "/links/upsert" and method == "POST":
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"error": "bad json"})
            n = links_upsert(payload.get("doc") or "", payload.get("cites") or [])
            return send(client, 200, {"ok": True, "count": n})

        if path == "/open" and method == "POST":
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"error": "bad json"})
            target_uri = payload.get("uri") or ""
            target_path = payload.get("path") or ""
            try:
                if target_uri:
                    os.startfile(target_uri)          # zotero:// 由系统协议处理器接管
                elif target_path and os.path.exists(target_path):
                    os.startfile(target_path)
                else:
                    return send(client, 404, {"error": "nothing to open"})
            except OSError as e:
                return send(client, 500, {"error": str(e)})
            logging.info("open %s", target_uri or target_path)
            return send(client, 200, {"ok": True})

        if path == "/config":
            if method == "GET":
                return send(client, 200, read_json(CONFIG, {}))
            payload = json.loads(body.decode("utf-8") or "{}")
            cfg = read_json(CONFIG, {})
            cfg.update(payload)
            write_json(CONFIG, cfg)
            return send(client, 200, cfg)

        return send(client, 404, {"error": "not found", "path": path})
    except Exception as e:                        # 单请求失败不能拖垮代理
        logging.warning("request failed: %r", e)
        try:
            send(client, 500, {"error": str(e)})
        except OSError:
            pass
    finally:
        try:
            client.close()
        except OSError:
            pass


def serve(port=LISTEN_PORT):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        srv.bind(("127.0.0.1", port))
    except OSError as e:
        logging.info("bind failed (%s)，可能已有实例", e)
        return 0
    srv.listen(64)
    srv.settimeout(1.0)
    logging.info("proxy on %d → zotero %d", port, ZOTERO_PORT)
    while not STOP.is_set():
        try:
            c, _ = srv.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=handle, args=(c,), daemon=True).start()
    srv.close()
    logging.info("proxy stopped")
    return 0


if __name__ == "__main__":
    setup_log()
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "status":
        s = socket.socket()
        s.settimeout(0.4)
        try:
            s.connect(("127.0.0.1", LISTEN_PORT))
            print("running")
        except OSError:
            print("stopped")
        finally:
            s.close()
    else:
        try:
            sys.exit(serve())
        except Exception:
            import traceback
            logging.error("fatal: %s", traceback.format_exc())
            raise
