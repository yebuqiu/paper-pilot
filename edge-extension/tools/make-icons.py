#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无需 Pillow）。

画法：在 512×512 画布上按几何形状上色，再按整数倍盒式降采样到目标尺寸，
边缘因此是抗锯齿的。所有尺寸的视觉一致，只做缩放。
"""

import os
import struct
import zlib

SS = 512
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
TEAL = (15, 110, 86)
CORAL = (216, 90, 48)
WHITE = (255, 255, 255)


def canvas(w, h):
    return [[(0, 0, 0, 0) for _ in range(w)] for _ in range(h)]


def blend(dst, src, a):
    return tuple(int(round(dst[i] * (1 - a) + src[i] * a)) for i in range(3)) + (255,)


def rounded_rect(img, x0, y0, x1, y1, r, color):
    for y in range(max(0, y0), min(len(img), y1)):
        for x in range(max(0, x0), min(len(img[0]), x1)):
            dx = 0
            dy = 0
            if x < x0 + r:
                dx = x0 + r - x
            elif x > x1 - 1 - r:
                dx = x - (x1 - 1 - r)
            if y < y0 + r:
                dy = y0 + r - y
            elif y > y1 - 1 - r:
                dy = y - (y1 - 1 - r)
            if dx * dx + dy * dy > r * r:
                continue
            img[y][x] = color + (255,)


def circle(img, cx, cy, r, color):
    for y in range(max(0, cy - r), min(len(img), cy + r + 1)):
        for x in range(max(0, cx - r), min(len(img[0]), cx + r + 1)):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                img[y][x] = color + (255,)


def resize(img, size):
    """面积平均缩放：源区域不要求整数倍，48/128 这类非整除尺寸也能正确降采样。"""
    import math

    src_h = len(img)
    src_w = len(img[0])
    scale = src_w / size
    out = []
    for y in range(size):
        y0, y1 = y * scale, (y + 1) * scale
        row = []
        for x in range(size):
            x0, x1 = x * scale, (x + 1) * scale
            r = g = b = a = area = 0.0
            for yy in range(int(y0), min(src_h, math.ceil(y1))):
                yh = min(y1, yy + 1) - max(y0, yy)
                if yh <= 0:
                    continue
                for xx in range(int(x0), min(src_w, math.ceil(x1))):
                    xw = min(x1, xx + 1) - max(x0, xx)
                    if xw <= 0:
                        continue
                    p = img[yy][xx]
                    w = xw * yh
                    r += p[0] * p[3] * w
                    g += p[1] * p[3] * w
                    b += p[2] * p[3] * w
                    a += p[3] * w
                    area += w
            if area == 0 or a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((int(round(r / a)), int(round(g / a)), int(round(b / a)), int(round(a / area))))
        out.append(row)
    return out


def write_png(path, rows):
    h = len(rows)
    w = len(rows[0])
    raw = b"".join(b"\x00" + b"".join(struct.pack("BBBB", *px) for px in row) for row in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    img = canvas(SS, SS)
    rounded_rect(img, 0, 0, SS, SS, 116, TEAL)
    rounded_rect(img, 150, 104, 362, 408, 26, WHITE)
    for i, width in enumerate((132, 152, 152, 96)):
        rounded_rect(img, 190, 178 + i * 54, 190 + width, 178 + i * 54 + 16, 8, TEAL)
    circle(img, 384, 132, 40, CORAL)

    for size in (128, 48, 32, 16):
        write_png(os.path.join(OUT, "icon%d.png" % size), resize(img, size))
    print("icons written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
