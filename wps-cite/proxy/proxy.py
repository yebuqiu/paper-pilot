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
import platform
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

PROXY_VERSION = "0.1.2"   # 部署在多机上，排障先对版本：__health 与启动日志都带它
ZOTERO = "127.0.0.1"
ZOTERO_PORT = 23119
LISTEN_PORT = 21932
HOME = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "PapilotCite")
LINKS = os.path.join(HOME, "links.json")
CONFIG = os.path.join(HOME, "config.json")
DIAG_DIR = os.path.join(HOME, "diag")

CORS = (
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET,POST,OPTIONS,PUT,DELETE\r\n"
    "Access-Control-Allow-Headers: *\r\n"
    "Access-Control-Max-Age: 86400\r\n"
)

# ---------- 跨源/命令白名单 ----------
# 代理监听 127.0.0.1，但浏览器有一个坑：任意外站网页里 fetch("http://127.0.0.1:21932/...")
# 也会把请求发到这里（Private Network Access 之前，这就是 CSRF 的温床）。所以：
#   - 带 Origin 头的（一律是浏览器发的）只允许 127.0.0.1 / localhost / null / file://
#     （CEF file:// 加载项多数发 null；部分 WPS 内嵌的旧 Chromium 把 file 源序列化成
#     "file://"——2026-10-21 外机实测，两者同为本地文件页，信任等级一致）；
#   - 不带 Origin 的（curl / python / 本机工具）不是浏览器场景，放行。
# 这样即使别人诱导用户访问一个恶意站点，它也无法驱使代理去翻 Zotero 库或开文件。
_ALLOW_ORIGIN = re.compile(
    r"^(?:https?://(?:127\.0\.0\.1|localhost)(?::\d+)?|null|file://)$", re.IGNORECASE)


def origin_ok(headers):
    """带 Origin 才校验；不带就是本机命令行工具，放行。"""
    for k, v in (headers or {}).items():
        if k.lower() == "origin":
            return bool(_ALLOW_ORIGIN.match(str(v).strip()))
    return True


# /open 只放两类东西：zotero:// 协议链接（Zotero 自己接管）；
# 或本机已存在的**文档**路径（用来"打开引用它的那份文件"）。
# .exe/.bat/... 一开放就是远程任意命令执行（配合上面的 Origin 白名单也不该开）。
_DOC_EXT = (".docx", ".doc", ".pdf", ".xlsx", ".pptx", ".txt", ".md")

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
        # ★ 超限不能直接删：proxy.log 是排障唯一凭据，删掉等于把上一次出问题的现场抹掉。
        #   与下面 .prev 一个思路：改名成 .1 留着（已有 .1 就先覆盖掉）。
        if os.path.exists(path) and os.path.getsize(path) > 512 * 1024:
            rotated = path + ".1"
            try:
                if os.path.exists(rotated):
                    os.remove(rotated)
                os.replace(path, rotated)
            except OSError:
                pass
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


# ---------- 把 Zotero 的「添加引注」浮窗拉到最前 ----------
# 为什么要在外部进程做：引注框是 Zotero 自己的窗口，WPS 里的加载项（一个隐藏的浏览器页）
# 完全没有能力控制操作系统的窗口层级。用户点完按钮、Zotero 弹框后，只要点一下 WPS 正文，
# 浮窗就沉到后面去，看起来像"按钮没反应"。
#
# 策略（保守）：只在 Zotero 进程的窗口里找；优先标题像引注框的，其次主窗口；
# 找到就把引注框置顶 + 前置；找不到什么都不做（绝不乱动别的程序）。
_RAISE_WORDS = ("引注", "引文", "参考文献", "citation", "bibliograph")


def _proc_image_name(pid):
    """返回进程可执行文件名（小写），取不到返回空串。"""
    import ctypes
    from ctypes import wintypes
    k = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value).lower()
        return ""
    except OSError:
        return ""
    finally:
        try:
            k.CloseHandle(h)
        except OSError:
            pass


def _zotero_windows():
    """枚举 zotero 进程的所有可见顶层窗口 → [(hwnd, title, w, h)]"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    out = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lparam):
        try:
            if not u.IsWindowVisible(hwnd):
                return True
            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if _proc_image_name(pid.value) != "zotero.exe":
                return True
            n = u.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            rect = wintypes.RECT()
            u.GetWindowRect(hwnd, ctypes.byref(rect))
            out.append((hwnd, buf.value, rect.right - rect.left, rect.bottom - rect.top))
            return True
        except Exception:
            return True

    u.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def raise_zotero_dialog(timeout=15.0, interval=0.3):
    """等 Zotero 的引注浮窗出现并把它拉到最前；最多等 timeout 秒。

    判定"这是不是引注框"用两条互补的信号，都不靠窗口标题的本地化文案：
      1. **新出现的窗口** —— 调用时先给现存窗口拍个快照，之后冒出来的那个就是刚弹的框；
      2. 标题里带引注/参考文献字样（框已经开着时走这条）。
    找不到就什么都不做。**不会**去动 Zotero 主窗口（把主窗口拉到前面毫无意义，
    还会把用户正在看的别的东西挤走）。
    """
    try:
        import ctypes
        u = ctypes.windll.user32
    except Exception as e:
        return {"ok": False, "why": "ctypes unavailable: %s" % e}

    HWND_TOPMOST = -1
    SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x0001, 0x0002, 0x0040
    SW_RESTORE = 9

    first = _zotero_windows()
    before = set(h[0] for h in first)
    deadline = time.time() + max(1.0, timeout)
    seen = [t for (_h, t, _w, _hh) in first]
    while time.time() < deadline:
        wins = _zotero_windows()
        seen = [t for (_h, t, _w, _hh) in wins]
        pick = None
        kind = ""
        for hwnd, title, w, h in wins:
            low = title.lower()
            if hwnd not in before:                      # 刚冒出来的窗口
                pick, kind = (hwnd, title), "new"
                break
            if any(word in title or word in low for word in _RAISE_WORDS):
                pick, kind = (hwnd, title), "keyword"
                break
        if pick:
            hwnd, title = pick
            try:
                u.ShowWindow(hwnd, SW_RESTORE)
                u.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                               SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
                u.SetForegroundWindow(hwnd)
                u.BringWindowToTop(hwnd)
                return {"ok": True, "title": title, "kind": kind}
            except Exception as e:
                return {"ok": False, "why": str(e), "title": title}
        time.sleep(interval)
    return {"ok": False, "why": "没等到新窗口", "seen": seen[:6]}


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
        # ★ page 是从 query string 来的（"abc"、"1.5"、"None" 都可能传进来），
        #   直接 int() 会 ValueError → 整个 /links 请求 500，前端只看到"查台账失败"。
        try:
            want = int(page)
        except (TypeError, ValueError):
            want = None
        if want is not None:
            rows = [r for r in rows if int(r.get("page") or 0) == want]
    if doc:
        rows = [r for r in rows if os.path.normcase(r.get("doc", "")) != os.path.normcase(doc)]
    return rows


# ---------------- 一键诊断包 ----------------
# 为什么要有：用户说"某个按钮不好使"时，我们没法远程连他的机器，也不该让他手动翻目录找日志。
# 让他点一下"导出诊断包"，把生成的 zip 发过来，现场就在里面了：
# 日志尾巴、脱敏后的配置、文档里有哪些域、Zotero/API 通不通。
DIAG_TAIL_LINES = 400      # 只留日志尾巴：proxy.log 可能几十 MB，整个塞进 zip 没人看得下去
DIAG_LINKS_KEEP = 20       # 台账可能很大，只留条数 + 前 20 条摘要

# 诊断包是要发出去的，config.json 里可能有 Zotero API key / token，
# 键名命中这些词的，值一律打码，绝不带明文凭据出门。
_SECRET_HINTS = ("key", "token", "secret", "password", "passwd", "pwd", "密码", "令牌", "密钥", "凭证")


def _looks_secret(name):
    low = str(name or "").lower()
    return any(h in low for h in _SECRET_HINTS)


def redact(obj):
    """递归把像密钥的字段值换成 ***；其余原样。"""
    if isinstance(obj, dict):
        return {k: ("***" if _looks_secret(k) else redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


def tail_lines(path, n=DIAG_TAIL_LINES):
    """只保留最后 n 行，用 deque 滚动，避免把大文件整个读进内存。"""
    from collections import deque
    buf = deque(maxlen=max(1, int(n)))
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                buf.append(line.rstrip("\r\n"))
    except OSError:
        return "（读不到 %s）\n" % path
    return "\n".join(buf) + "\n"


def _doc_line(doc_path):
    if not doc_path:
        return "（未提供，可能没打开文档）"
    # 诊断包是从 HTTP 入口进来的，docPath 可能被传成 list/dict/数字，
    # 直接走 os.path.exists 会 TypeError 把整份 summary 搞挂。
    if not isinstance(doc_path, str):
        return "（docPath 类型异常：%r）" % (type(doc_path).__name__,)
    try:
        if os.path.exists(doc_path):
            return "%s（存在，%d 字节）" % (doc_path, os.path.getsize(doc_path))
        return "%s（不存在）" % doc_path
    except OSError as e:
        return "%s（读不到：%s）" % (doc_path, e)


def build_summary(payload):
    """summary.txt：人先看的那一页，不用解开 zip 里的别的文件就能判断个大概。"""
    alive = zotero_alive()
    lines = [
        "Papilot Cite 诊断包",
        "生成时间: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
        "插件版本: %s" % (payload.get("version") or "（未知）"),
        "文档: %s" % _doc_line(payload.get("docPath")),
        "Zotero 进程: %s" % ("在跑" if alive else "没在跑"),
        "Zotero 本地 API: %s" % ("可用" if (alive and local_api_ok()) else "不可用"),
        "代理监听: 127.0.0.1:%d" % LISTEN_PORT,
        "Python: %s (%s)" % (platform.python_version(), sys.platform),
        "系统: %s" % platform.platform(),
    ]
    fields = payload.get("fields") or []
    lines.append("字段清单 (%d):" % len(fields))
    for f in fields:
        if not isinstance(f, dict):
            continue
        lines.append("  #%s %s %sB %s" % (
            f.get("index"), f.get("kind") or "other", f.get("codeLen") or 0, f.get("label") or ""))
    if not fields:
        lines.append("  （文档里没扫到域）")
    lines.append("备注: %s" % (payload.get("note") or "（无）"))
    return "\n".join(lines) + "\n"


def build_links_digest():
    """links.json 只留条数与前若干条摘要：整份台账可能很大，而且对排障没那么关键。"""
    data = read_json(LINKS, {})
    items = (data.get("items") if isinstance(data, dict) else None) or {}
    keys = list(items.keys())
    out = ["台账条数: %d" % len(keys),
           "（每篇文献一条，值是引用它的文档列表）", ""]
    for key in keys[:DIAG_LINKS_KEEP]:
        rows = items.get(key) or []
        docs = []
        for r in rows[:3]:
            if not isinstance(r, dict):
                continue
            name = os.path.basename(str(r.get("doc") or "")) or "?"
            page = r.get("page")
            docs.append(name + (" p%s" % page if page not in (None, "", 0, "0") else ""))
        out.append("%s: %d 条引用 ← %s" % (key, len(rows), ", ".join(docs) or "（无文档）"))
    if len(keys) > DIAG_LINKS_KEEP:
        out.append("…（仅列前 %d 条）" % DIAG_LINKS_KEEP)
    return "\n".join(out) + "\n"


def diag_build(payload):
    """打一个 zip，返回 {"ok":True,"path","size"}。失败时异常交给 diag_handle 兜。"""
    os.makedirs(DIAG_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(DIAG_DIR, "papilot-diag-%s.zip" % stamp)
    n = 2
    while os.path.exists(path):                    # 同一秒内连点两次也不能互相覆盖
        path = os.path.join(DIAG_DIR, "papilot-diag-%s-%d.zip" % (stamp, n))
        n += 1
    cfg = redact(read_json(CONFIG, {}))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("summary.txt", build_summary(payload))
        z.writestr("proxy.tail.log", tail_lines(os.path.join(HOME, "proxy.log")))
        z.writestr("config.json", json.dumps(cfg, ensure_ascii=False, indent=1))
        z.writestr("links.json", build_links_digest())
    size = os.path.getsize(path)
    logging.info("diag %s (%d bytes, fields=%d)", path, size, len(payload.get("fields") or []))
    return {"ok": True, "path": path, "size": size}


def diag_handle(payload):
    """POST /diag 的实现入口。**绝不抛**：打包失败也只是回一个 ok:false。"""
    try:
        if not isinstance(payload, dict):
            return {"ok": False, "error": "请求体必须是 JSON 对象"}
        return diag_build(payload)
    except Exception as e:                          # noqa: BLE001 —— 这里的意图就是"什么错都不许炸"
        logging.warning("diag failed: %r", e)
        return {"ok": False, "error": str(e)}


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

        # ★ Origin 白名单：外站网页能 fetch 到 127.0.0.1 上的代理（浏览器不拦），
        #   不挡就是 CSRF。带 Origin 必须是本机/localhost/null（CEF file:// 页发 null），
        #   否则 403；不带 Origin 的是 curl/python/同机工具，不是浏览器场景，放行。
        if not origin_ok(headers):
            rejected = headers.get("Origin") or headers.get("origin") or ""
            logging.warning("reject origin: %r", rejected)
            # 把被拒的 Origin 放进响应体：加载项的报错文案能直接显示它，
            # 用户不用翻 proxy.log 也能把关键信息报回来。
            return send(client, 403, {"error": "origin not allowed", "origin": rejected})

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
                                      "localApi": local_api_ok() if zotero_alive() else False,
                                      "proxyVersion": PROXY_VERSION})

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

        if path == "/raise":
            r = raise_zotero_dialog()
            logging.info("raise %s", json.dumps(r, ensure_ascii=False))
            return send(client, 200, r)

        if path == "/diag" and method == "POST":
            # 一键诊断包：用户报"按钮不好使"时，把现场打成 zip 让他回传。
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"ok": False, "error": "bad json"})
            res = diag_handle(payload)              # 自己兜异常，不会把代理带崩
            return send(client, 200 if res.get("ok") else 500, res)

        if path.startswith("/zit/"):
            # Zotero 集成协议（execCommand/respond）：**长轮询**——Zotero 会把"下一条命令"
            # 当响应下发，可能等用户在对话框里操作很久。超时必须远大于普通转发。
            # ★ 这个值 = 用户在弹出的「添加引文」框里最多能挑多久。给 240s 时，
            #   挑文献超过 4 分钟就断链，Zotero 侧事务卡在 inProgress（之后全 503）。
            #   现在给 30 分钟，正常操作不可能超过。
            sub = path[len("/zit"):] + (("?" + u.query) if u.query else "")
            code, data, ctype = forward(method, sub, headers, body, timeout=1800)
            if code >= 400:
                logging.warning("fwd %s %s -> %d", method, sub.split("?")[0], code)
            return send(client, code, data, ctype)

        if path.startswith("/zotero/"):
            sub = path[len("/zotero"):] + (("?" + u.query) if u.query else "")
            code, data, ctype = forward(method, sub, headers, body)
            if code >= 400:
                # 403 几乎总是「Zotero 本地 API 未开启」——落日志后 proxy.log 就是第一现场，
                # 不用再看加载项里的裸 "HTTP 403" 猜来源。
                logging.warning("fwd %s %s -> %d (403 = zotero local api off?)", method, sub.split("?")[0], code)
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
            # ★ 白名单：os.startfile 等价于双击，uri/path 不做限制就是"远程双击任意文件"，
            #   一个钓鱼网页就能借它启动 .exe。只允许：
            #     - zotero:// 协议（交给 Zotero 的协议处理器）
            #     - 本机已存在的文档类文件（.docx/.pdf/...，见 _DOC_EXT）
            if target_uri:
                if not str(target_uri).lower().startswith("zotero://"):
                    logging.warning("open 拒绝非 zotero:// 的 uri: %r", target_uri)
                    return send(client, 403, {"error": "uri scheme not allowed"})
            elif target_path:
                ext = os.path.splitext(str(target_path))[1].lower()
                if ext not in _DOC_EXT:
                    logging.warning("open 拒绝非文档扩展名: %r", target_path)
                    return send(client, 403, {"error": "path extension not allowed"})
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
            # ★ 与 /links/upsert、/queue 的写法对齐：坏 JSON 要回 400，
            #   不能让它冒到外层 Exception → 500（那是"服务器内部错"，不是"请求错"）。
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"error": "bad json"})
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
    logging.info("proxy v%s on %d → zotero %d", PROXY_VERSION, port, ZOTERO_PORT)
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
