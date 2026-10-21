# -*- coding: utf-8 -*-
"""纯 ctypes 截屏（GDI BitBlt + 手写 PNG），用于真机界面验收。

不依赖 PIL / pywin32，也不启动任何 GUI 进程；只读取屏幕像素。
用法：
    python diag_shot.py out.png            # 全屏
    python diag_shot.py out.png "Zotero"   # 只要标题含该串的窗口
"""
import ctypes, sys, zlib, struct
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

user32.SetProcessDPIAware()  # 避免 DPI 虚拟化导致截图被拉伸/裁切


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def find_window(title_sub):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        t = buf.value
        if title_sub.lower() in t.lower():
            found.append((hwnd, t))
        return True

    user32.EnumWindows(cb, 0)
    return found


def grab(x, y, w, h):
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, hbmp)
    gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, 0x00CC0020)  # SRCCOPY

    bi = BITMAPINFO()
    bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h  # 负 = 自上而下
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = 0  # BI_RGB

    buf = ctypes.create_string_buffer(w * h * 4)
    got = gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)
    if got == 0:
        raise RuntimeError("GetDIBits failed")
    return buf.raw


def to_png(path, w, h, bgra):
    rows = []
    stride = w * 4
    for yy in range(h):
        off = yy * stride
        line = bgra[off:off + stride]
        # BGRA -> RGB
        rgb = bytearray(w * 3)
        rgb[0::3] = line[2::4]
        rgb[1::3] = line[1::4]
        rgb[2::3] = line[0::4]
        rows.append(b"\x00" + bytes(rgb))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)
    return len(png)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
    sub = sys.argv[2] if len(sys.argv) > 2 else ""
    focus = "--focus" in sys.argv
    if sub:
        wins = find_window(sub)
        if not wins:
            print("no window matching:", sub)
            return 2
        hwnd, title = wins[0]
        if focus:
            # BitBlt 抓的是屏幕像素，被遮挡就会抓到别人的窗口。
            # 除了抢焦点（会被前台锁/别的应用抢回去），再加一层窗口置顶兜底。
            k32 = ctypes.windll.kernel32
            fg = user32.GetForegroundWindow()
            tid_fg = user32.GetWindowThreadProcessId(fg, None)
            tid_me = k32.GetCurrentThreadId()
            user32.AttachThreadInput(tid_fg, tid_me, True)
            user32.ShowWindow(hwnd, 9)                 # SW_RESTORE
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.AttachThreadInput(tid_fg, tid_me, False)
            import time
            time.sleep(0.6)
            if "--top" in sys.argv:
                HWND_TOPMOST = -1
                SWP = 0x0001 | 0x0002 | 0x0010   # NOSIZE|NOMOVE|NOACTIVATE
                user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP)
                time.sleep(0.5)
            print("focused:", user32.GetForegroundWindow() == hwnd)
        r = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        x, y = r.left, r.top
        w, h = r.right - r.left, r.bottom - r.top
        print("window:", title, "rect:", x, y, w, h)
    else:
        x = y = 0
        w = user32.GetSystemMetrics(0)
        h = user32.GetSystemMetrics(1)
        print("screen:", w, "x", h)
    if w <= 0 or h <= 0:
        print("bad rect")
        return 1
    data = grab(x, y, w, h)
    n = to_png(out, w, h, data)
    print("saved", out, n, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
