#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.

# -*- coding: utf-8 -*-
"""Console hang probe (read-only).

Purpose: when "Papilot 后台 · 控制台" looks frozen, tell apart the three
different situations that all look like a hang:

  1) window was minimized to tray  -> process alive, window hidden, UI responsive
  2) UI thread blocked             -> window visible, WM_NULL latency > 200ms
  3) process really gone           -> no window, pid file stale

Also measures the two numbers that decide whether the UI thread can keep up:
  * how long one /api/health probe takes (UI thread timeout is 1s)
  * how long a TCP connect to 127.0.0.1:8000 takes when nothing listens

Read-only: it never starts/stops services, never clicks buttons, never writes
to server/data. Usage:

    python scripts/diag/console-probe.py
    python scripts/diag/console-probe.py --pid 1234
    python scripts/diag/console-probe.py --lag-seconds 10
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import socket
import sys
import time
import urllib.request

TITLE = "Papilot 后台 · 控制台"
TMP = os.environ.get("TEMP", "")
PID_FILE = os.path.join(TMP, "papilot-launcher.pid")
BOOT_LOG = os.path.join(TMP, "papilot-launcher-boot.log")
ERR_LOG = os.path.join(TMP, "papilot-launcher-error.log")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER_LOG = os.path.join(ROOT, "server", "data", "server-console.log")
STDOUT_LOG = os.path.join(ROOT, "server", "data", "server-stdout.log")

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.SendMessageTimeoutW.argtypes = [
    wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM, wt.UINT, wt.UINT,
    ctypes.POINTER(ctypes.c_size_t),
]
EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

WM_NULL = 0x0000
SMTO_ABORTIFHUNG = 0x0002


def win_text(h):
    b = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(h, b, 512)
    return b.value


def win_class(h):
    b = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, b, 256)
    return b.value


def win_pid(h):
    p = wt.DWORD()
    user32.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def find_console_window():
    hits = []

    def cb(h, _l):
        if win_text(h) == TITLE:
            hits.append(h)
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    return hits[0] if hits else None


def enumerate_children(hwnd):
    rows = []

    def cb(ch, _l):
        t = win_text(ch)
        c = win_class(ch)
        if t:
            rows.append((
                ch, c, t,
                bool(user32.IsWindowVisible(ch)),
                bool(user32.IsWindowEnabled(ch)),
            ))
        return True

    user32.EnumChildWindows(hwnd, EnumProc(cb), 0)
    return rows


def ui_lag(hwnd, seconds):
    """Sample WM_NULL round-trip; a blocked UI thread cannot answer at all."""
    samples = []
    t0 = time.time()
    while time.time() - t0 < seconds:
        res = ctypes.c_size_t(0)
        start = time.perf_counter()
        ok = user32.SendMessageTimeoutW(
            hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 3000, ctypes.byref(res))
        samples.append(((time.perf_counter() - start) * 1000.0, bool(ok)))
        time.sleep(0.1)
    return samples


def tcp_connect_ms(port, timeout=3.0):
    start = time.perf_counter()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    ok = False
    try:
        s.connect(("127.0.0.1", port))
        ok = True
    except OSError:
        ok = False
    finally:
        s.close()
    return ok, (time.perf_counter() - start) * 1000.0


def http_probe_ms(port, path, timeout=1.0):
    url = "http://127.0.0.1:%d%s" % (port, path)
    start = time.perf_counter()
    body = None
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            body = r.read(4096).decode("utf-8", "replace")
    except Exception:
        body = None
    return body, (time.perf_counter() - start) * 1000.0


def process_alive(pid):
    """Existence check.

    NOTE: never use os.kill(pid, 0) on Windows -- Python maps a non-console
    signal to TerminateProcess, so a "probe" would actually kill the console.
    """
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    STILL_ACTIVE = 259
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        # ERROR_ACCESS_DENIED means the process does exist, we just may not query it
        return ctypes.get_last_error() == 5
    try:
        code = wt.DWORD()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


def tail(path, n=8):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        return lines[-n:]
    except OSError:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, default=0)
    ap.add_argument("--lag-seconds", type=float, default=6.0)
    args = ap.parse_args()

    print("=" * 68)
    print("Papilot console probe   %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 68)

    # ---- 1. window / process -------------------------------------------
    hwnd = find_console_window()
    pid = args.pid
    if not pid and hwnd:
        pid = win_pid(hwnd)
    pid_from_file = None
    try:
        with open(PID_FILE, "r", encoding="utf-8", errors="replace") as f:
            pid_from_file = int(f.read().strip())
    except Exception:
        pass
    if not pid:
        pid = pid_from_file

    alive = bool(pid) and process_alive(pid)

    print("[1] process")
    print("    pid file      : %s (%s)" % (pid_from_file, "exists" if pid_from_file else "missing"))
    print("    pid           : %s" % (pid or "-"))
    print("    alive         : %s" % ("YES" if alive else "NO"))
    print("    window        : %s" % ("0x%X" % hwnd if hwnd else "not found"))
    if hwnd:
        print("    visible       : %s" % bool(user32.IsWindowVisible(hwnd)))
        print("    enabled       : %s" % bool(user32.IsWindowEnabled(hwnd)))
        print("    minimized     : %s" % bool(user32.IsIconic(hwnd)))
        kids = enumerate_children(hwnd)
        disabled = [k for k in kids if not k[4]]
        print("    controls      : %d (%d disabled)" % (len(kids), len(disabled)))
        for k in disabled[:6]:
            print("      disabled: %s" % k[2])
        refresh = [k[2] for k in kids if k[2].startswith("刷新 ")]
        if refresh:
            print("    refresh label : %s   <-- stale means the 3s timer stopped" % refresh[0])

    # ---- 2. UI thread responsiveness -----------------------------------
    print("[2] UI thread latency (WM_NULL, %ds)" % int(args.lag_seconds))
    if hwnd:
        samples = ui_lag(hwnd, args.lag_seconds)
        vals = [s[0] for s in samples]
        fails = sum(1 for s in samples if not s[1])
        vals_sorted = sorted(vals)
        p95 = vals_sorted[int(len(vals_sorted) * 0.95) - 1] if vals_sorted else 0
        print("    samples=%d  avg=%.0fms  p95=%.0fms  max=%.0fms  no-reply=%d"
              % (len(vals), sum(vals) / len(vals), p95, max(vals), fails))
        print("    verdict       : %s" % (
            "BLOCKED - UI thread is not pumping messages"
            if (p95 > 200 or fails) else "responsive"))
        if p95 > 200:
            print("    detail        : >200ms samples = %d/%d"
                  % (sum(1 for v in vals if v > 200), len(vals)))
    else:
        print("    skipped: no window")

    # ---- 3. backend ----------------------------------------------------
    print("[3] backend 127.0.0.1:8000")
    ok, ms = tcp_connect_ms(8000)
    print("    tcp connect   : %s in %.0fms  (closed port should be <5ms; "
          "~2000ms means SYNs are being dropped)" % ("OPEN" if ok else "refused", ms))
    body, ms = http_probe_ms(8000, "/api/health", 1.0)
    if body:
        try:
            j = json.loads(body)
            print("    /api/health   : %.0fms  version=%s ok=%s"
                  % (ms, j.get("version"), j.get("ok")))
        except Exception:
            print("    /api/health   : %.0fms  (non-JSON body)" % ms)
    else:
        print("    /api/health   : NO ANSWER in %.0fms  <-- each UI probe costs this much" % ms)

    # ---- 4. logs -------------------------------------------------------
    print("[4] recent logs")
    for label, path in (("boot", BOOT_LOG), ("error", ERR_LOG),
                        ("server", SERVER_LOG), ("stdout", STDOUT_LOG)):
        lines = tail(path, 5)
        print("    -- %s (%s)" % (label, path))
        if not lines:
            print("       (empty or missing)")
        for ln in lines:
            print("       %s" % ln[:160])

    # ---- 5. verdict ----------------------------------------------------
    print("[5] reading")
    if not alive:
        print("    process gone: stale pid file? start the console from the .bat")
    elif hwnd is None:
        print("    process alive but no window: probably hidden to tray -> "
              "click the tray icon (right-click -> 退出程序 to really quit)")
    elif not bool(user32.IsWindowVisible(hwnd)):
        print("    window hidden: minimized to tray by design, the process is still "
              "running; only 退出程序 in the tray menu ends it")
    else:
        print("    window visible: if clicks feel dead, look at [2] and [3]")
    print("=" * 68)


if __name__ == "__main__":
    sys.exit(main())
