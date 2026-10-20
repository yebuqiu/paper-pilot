#!/usr/bin/env python3
"""WPS-Zotero CORS 代理。

为什么需要它
------------
Zotero 的 HTTP 集成协议（/connector/document/execCommand 等）只监听
127.0.0.1:23119，响应里不带 CORS 头；而 WPS 的 JS 加载项跑在浏览器环境里，
跨源请求会被同源策略拦掉。本代理把 21931 端口的请求转发到 23119，并补上
CORS 头，同时在本机直接应答 OPTIONS 预检。

Zotero 10 的两个坑（旧版代理都踩过）
------------------------------------
1. 会校验 Host 头：不是 127.0.0.1:23119 一律 400 Bad request → 必须改写 Host。
2. 响应是 HTTP/1.0 + Connection: close，必须按 Content-Length/EOF 读完整条再回给客户端。

用法
----
    pythonw proxy.py            后台常驻（注册表 Run 项开机自启）
    python proxy.py kill        停止
    python proxy.py status      查看状态
"""
import errno
import logging
import os
import socket
import sys
import threading

ZOTERO_HOST = "127.0.0.1"
ZOTERO_PORT = 23119
LISTEN_PORT = 21931
BUF = 65536
MAX_MSG = 32 * 1024 * 1024

CORS = (
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET,POST,OPTIONS,PUT,PATCH,DELETE\r\n"
    "Access-Control-Allow-Headers: *\r\n"
    "Access-Control-Allow-Credentials: true\r\n"
    "Access-Control-Max-Age: 86400\r\n"
)

STOP = threading.Event()


def setup_log():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    path = os.path.join(base, "kingsoft", "wps", "jsaddons", "wps-zotero-proxy.log")
    try:
        if os.path.exists(path) and os.path.getsize(path) > 512 * 1024:
            os.remove(path)
    except OSError:
        pass
    logging.basicConfig(filename=path, filemode="a",
                        format="%(asctime)s.%(msecs)03d %(levelname)s %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S", level=logging.INFO)


def read_message(sock, until_close=False):
    """读完一条完整的 HTTP 消息，返回 (head_bytes, body_bytes)。

    until_close 只用于"响应"：没有 Content-Length 时按 EOF 读；
    请求不能这么做，否则 GET 会一直等到客户端断开。
    """
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(BUF)
        if not chunk:
            return data, b""
        data += chunk
        if len(data) > MAX_MSG:
            break
    head, _, body = data.partition(b"\r\n\r\n")

    headers = {}
    for line in head.split(b"\r\n")[1:]:
        if b":" in line:
            k, v = line.split(b":", 1)
            headers[k.strip().lower()] = v.strip()

    length = None
    if b"content-length" in headers:
        try:
            length = int(headers[b"content-length"])
        except ValueError:
            length = None

    if length is not None:
        while len(body) < length:
            chunk = sock.recv(BUF)
            if not chunk:
                break
            body += chunk
        body = body[:length]
    elif until_close:
        while True:                      # 没有长度就按 EOF 读（HTTP/1.0 常见）
            try:
                chunk = sock.recv(BUF)
            except OSError:
                break
            if not chunk:
                break
            body += chunk
    return head, body


def with_cors(head, body):
    lines = head.split(b"\r\n")
    status = lines[0]
    rest = [l for l in lines[1:] if not l.lower().startswith(b"access-control-")]
    rest = [l for l in rest if not l.lower().startswith(b"content-length")]
    rest = [l for l in rest if not l.lower().startswith(b"connection")]
    return (status + b"\r\n" + CORS.encode() + b"\r\n".join(rest) +
            b"\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body)) + body


def rewrite_host(head):
    """Zotero 10 只认 Host: 127.0.0.1:23119，其余一律 400。"""
    lines = head.split(b"\r\n")
    out = [lines[0]]
    has_host = False
    for line in lines[1:]:
        low = line.lower()
        if low.startswith(b"host:"):
            out.append(b"Host: %s:%d" % (ZOTERO_HOST.encode(), ZOTERO_PORT))
            has_host = True
        elif low.startswith(b"connection:"):
            out.append(b"Connection: close")
        else:
            out.append(line)
    if not has_host:
        out.insert(1, b"Host: %s:%d" % (ZOTERO_HOST.encode(), ZOTERO_PORT))
    return b"\r\n".join(out)


def handle(client):
    try:
        head, body = read_message(client)
        if not head:
            return
        request_line = head.split(b"\r\n")[0].decode("latin1", "replace")
        parts = request_line.split(" ")
        method = parts[0].upper() if parts else ""
        path = parts[1] if len(parts) > 1 else ""

        if path.startswith("/__stopproxy"):
            client.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            logging.info("stop command received")
            STOP.set()
            return

        if method == "OPTIONS":
            client.sendall(b"HTTP/1.1 200 OK\r\n" + CORS.encode() +
                           b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            logging.info("preflight ok: %s", path)
            return

        if path.startswith("/__health"):
            alive = b"true" if zotero_alive() else b"false"
            out = b'{"ok":true,"zotero":' + alive + b"}"
            client.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                           CORS.encode() +
                           b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(out) + out)
            return

        up = socket.create_connection((ZOTERO_HOST, ZOTERO_PORT), timeout=10)
        try:
            up.sendall(rewrite_host(head) + b"\r\n\r\n" + body)
            resp_head, resp_body = read_message(up, until_close=True)
        finally:
            up.close()

        if not resp_head:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n" + CORS.encode() +
                           b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            logging.warning("empty response for %s", path)
            return
        client.sendall(with_cors(resp_head, resp_body))
        logging.info("relayed %s %s -> %s (%d bytes body)",
                     method, path, resp_head.split(b"\r\n")[0].decode("latin1", "replace"),
                     len(resp_body))
    except Exception as e:
        logging.warning("proxy error: %r", e)
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n" + CORS.encode() +
                           b"Content-Length: 0\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
    finally:
        try:
            client.close()
        except OSError:
            pass


def zotero_alive():
    return port_open(ZOTERO_PORT)


def port_open(port):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def serve(port=LISTEN_PORT):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(("127.0.0.1", port))
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            logging.info("port %s already in use, exiting", port)
            return 0
        raise
    srv.listen(128)
    srv.settimeout(1.0)
    logging.info("proxy started on %s (-> %s:%s), zotero_alive=%s",
                 port, ZOTERO_HOST, ZOTERO_PORT, zotero_alive())
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


def kill():
    try:
        s = socket.create_connection(("127.0.0.1", LISTEN_PORT), timeout=1)
        s.sendall(b"POST /__stopproxy HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        s.close()
        return True
    except OSError:
        return False


if __name__ == "__main__":
    setup_log()
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "kill":
        print("stop requested:", kill())
    elif arg == "status":
        print("listening:", port_open(LISTEN_PORT))
    else:
        try:
            sys.exit(serve())
        except Exception:
            import traceback
            logging.error("fatal: %s", traceback.format_exc())
            raise
