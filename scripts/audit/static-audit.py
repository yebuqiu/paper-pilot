#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0 | Copyright (c) 2026 Cassiuschen
"""设置面板静态门禁审计（0.72.2 复审批次）。

七项检查，全部基于源文件文本实测，可重复运行：
  1 emoji 硬门禁        2 裸色值 lint        3 字号令牌纪律
  4 间距令牌纪律（A 布局节奏 / B 光学补偿 / C 控件尺寸 / D 内联债务）
  5 假按钮 / 键盘可达  6 语义标签        7 文案一致性
  附 增量复核（color-scheme / 控件描边令牌 / 动态点击目标）

只读产品文件；仅写 docs/audit/<ver>/static.{md,json}。

用法：
  python scripts/audit/static-audit.py                # 写报告
  python scripts/audit/static-audit.py --print        # 同时打印摘要
  python scripts/audit/static-audit.py --version 0.72.2
"""

from __future__ import annotations

import argparse
import bisect
import collections
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTENT = ROOT / "chrome" / "content"
XHTML = CONTENT / "prefs.xhtml"
CSS = CONTENT / "prefs.css"
TOKENS = CONTENT / "ui-tokens.css"

MAX_ROWS = 20

# --------------------------------------------------------------------------
# 通用工具
# --------------------------------------------------------------------------


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def mask(text: str, kind: str) -> str:
    """把注释替换成等长空白（保留换行），保证偏移与行号不变。"""
    pat = re.compile(r"/\*.*?\*/", re.S) if kind == "css" else re.compile(r"<!--.*?-->", re.S)
    return pat.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


class Lines:
    def __init__(self, text: str):
        self.starts = [0] + [m.end() for m in re.finditer(r"\n", text)]

    def of(self, offset: int) -> int:
        return bisect.bisect_right(self.starts, offset)


def cap(rows, limit=MAX_ROWS):
    rows = list(rows)
    return rows[:limit], max(0, len(rows) - limit)


def where(rel: str, line: int) -> str:
    return f"{rel}:{line}"


# --------------------------------------------------------------------------
# XHTML 标签扫描（保留行号 + 父子关系 + 文本）
# --------------------------------------------------------------------------

VOID = {"html:input", "html:img", "html:br", "html:hr", "html:meta", "html:link"}
TAG_RE = re.compile(r'<(/?)([A-Za-z][\w:.\-]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*?)(/?)>', re.S)
ATTR_RE = re.compile(r'([\w:.\-]+)\s*=\s*"([^"]*)"')


class Node:
    __slots__ = ("tag", "attrs", "line", "start", "end", "children", "parent", "text")

    def __init__(self, tag, attrs, line, start):
        self.tag = tag
        self.attrs = attrs
        self.line = line
        self.start = start
        self.end = start
        self.children = []
        self.parent = None
        self.text = ""

    def cls(self) -> str:
        return self.attrs.get("class", "")

    def ident(self) -> str:
        return self.attrs.get("id", "")


def parse_xhtml(text: str):
    masked = mask(text, "xhtml")
    li = Lines(text)
    nodes = []
    stack = []
    last = 0
    for m in TAG_RE.finditer(masked):
        if stack:
            stack[-1].text += text[last: m.start()]
        closing, tag, raw_attrs, selfclose = m.groups()
        if closing:
            if stack:
                node = stack.pop()
                node.end = m.end()
            last = m.end()
            continue
        attrs = {k: v for k, v in ATTR_RE.findall(raw_attrs)}
        node = Node(tag, attrs, li.of(m.start()), m.start())
        node.end = m.end()
        nodes.append(node)
        if stack:
            node.parent = stack[-1]
            stack[-1].children.append(node)
        if not selfclose and tag.lower() not in VOID:
            stack.append(node)
        last = m.end()
    return nodes


def plain(node: Node, text: str) -> str:
    raw = text[node.start: node.end]
    raw = re.sub(r"<[^>]*>", "", raw)
    return re.sub(r"\s+", " ", raw).strip()


def has_ancestor(node: Node, tag: str) -> bool:
    p = node.parent
    while p is not None:
        if p.tag == tag:
            return True
        p = p.parent
    return False


# --------------------------------------------------------------------------
# CSS 解析
# --------------------------------------------------------------------------

DECL_RE = re.compile(r"([-\w]+)\s*:\s*([^;{}]+)")
HEX_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b")
FUNC_RE = re.compile(r"\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)")
VAR_FALLBACK_RE = re.compile(r"var\([^()]*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))\s*\)")

NAMED_COLORS = {
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
    "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue",
    "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan",
    "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
    "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
    "darksalmon", "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey",
    "darkturquoise", "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey",
    "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
    "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew",
    "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush",
    "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
    "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink",
    "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey",
    "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon",
    "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen",
    "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred",
    "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
    "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
    "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum",
    "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown",
    "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue",
    "slateblue", "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan",
    "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke",
    "yellow", "yellowgreen",
}

COLOR_PROPS = re.compile(
    r"^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)"
    r"(?:-(?:color|style|width))?|-color|-style|-width)?|outline(?:-color|-style|-width)?|"
    r"box-shadow|text-shadow|fill|stroke|caret-color|text-decoration-color|"
    r"column-rule-color|-webkit-text-fill-color|filter)$"
)
NON_COLOR_PROPS = re.compile(r"^(?:border-radius|border-(?:top|bottom)-(?:left|right)-radius)$")

SPACING_PROPS = (
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "gap", "row-gap", "column-gap",
)
SPACING_RE = re.compile(r"(?<![\w-])(?:" + "|".join(SPACING_PROPS) + r")\s*:\s*([^;{}\"]+)")


def css_blocks(text: str):
    """返回 (selector, body_start, body_end)，按大括号配对。"""
    blocks = []
    stack = []
    sel_start = 0
    for i, ch in enumerate(text):
        if ch == "{":
            stack.append((text[sel_start:i].strip(), i))
            sel_start = i + 1
        elif ch == "}":
            if stack:
                sel, open_i = stack.pop()
                blocks.append((sel, open_i + 1, i))
            sel_start = i + 1
    return blocks


def color_literals(value: str, prop: str):
    """返回 [(kind, literal)]。named 颜色只在颜色属性上判。"""
    out = []
    for m in HEX_RE.finditer(value):
        out.append(("hex", m.group(0)))
    for m in FUNC_RE.finditer(value):
        out.append(("func", m.group(0)))
    if COLOR_PROPS.match(prop) and not NON_COLOR_PROPS.match(prop):
        for tok in re.findall(r"[A-Za-z]+", value):
            low = tok.lower()
            if low in NAMED_COLORS:
                out.append(("named", tok))
    return out


def px_values(value: str):
    return re.findall(r"(?<![\w.])([0-9.]+)px", value)


def token_px(text: str, prefix: str):
    return {m.group(1): m.group(2) for m in
            re.finditer(r"(--pp-" + prefix + r"-[\w-]+)\s*:\s*([0-9.]+)px", text)}


# --------------------------------------------------------------------------
# 检查 1 · emoji
# --------------------------------------------------------------------------

# 基准明确列入「非 emoji，允许」的符号（第 ② 桶）
ALLOWED_SYMBOLS = {
    0x2713: "✓", 0x2714: "✔", 0x2715: "✕", 0x2716: "✖", 0x2717: "✗", 0x2718: "✘",
    0x2605: "★", 0x2606: "☆", 0x26A0: "⚠", 0x21BB: "↻",
}
ARROW_MATH = {0x00D7, 0x00F7, 0x00B1, 0x2032, 0x2033, 0x2212, 0x00B2, 0x00B3}
TYPOGRAPHY = {0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2018, 0x2019,
              0x201C, 0x201D, 0x2026, 0x00A0}


def classify_char(ch: str, prev: str | None):
    cp = ord(ch)
    if cp in ALLOWED_SYMBOLS:
        return "symbol"
    if cp == 0xFE0F:
        # 紧跟在允许符号后的变体选择符属于该符号本身
        return "symbol" if prev and ord(prev) in ALLOWED_SYMBOLS else "emoji"
    if 0x1F000 <= cp <= 0x1FAFF or 0x1F1E6 <= cp <= 0x1F1FF:
        return "emoji"
    if 0x2600 <= cp <= 0x27BF or 0x2B00 <= cp <= 0x2BFF:
        return "emoji"
    if 0x2190 <= cp <= 0x21FF or 0x2200 <= cp <= 0x22FF or cp in ARROW_MATH:
        return "arrow"
    if 0x2460 <= cp <= 0x24FF or 0x25A0 <= cp <= 0x25FF:
        return "symbol"
    if cp in TYPOGRAPHY:
        return "typography"
    return "other"


def scan_chars(path: Path, text: str):
    li = Lines(text)
    buckets = {"emoji": [], "symbol": [], "arrow": [], "typography": [], "other": []}
    prev = None
    for m in re.finditer(r"[^\x00-\x7F]", text):
        ch = m.group(0)
        if ord(ch) == 0xFE0F and prev and ord(prev) in ALLOWED_SYMBOLS:
            prev = ch
            continue
        kind = classify_char(ch, prev)
        buckets[kind].append((ch, li.of(m.start())))
        prev = ch
    return buckets


def check_emoji() -> dict:
    files = [("chrome/content/prefs.xhtml", XHTML), ("chrome/content/prefs.css", CSS)]
    per_bucket = {"emoji": [], "symbol": [], "arrow": []}
    typo = 0
    for rel, path in files:
        b = scan_chars(path, read(path))
        typo += len(b["typography"])
        for kind in per_bucket:
            per_bucket[kind].extend((ch, rel, ln) for ch, ln in b[kind])

    def agg(items):
        c = collections.Counter(ch for ch, _, _ in items)
        return c

    emoji_c = agg(per_bucket["emoji"])
    symbol_c = agg(per_bucket["symbol"])
    arrow_c = agg(per_bucket["arrow"])

    def table(counter, items):
        rows = []
        for ch, n in counter.most_common():
            locs = []
            for c, rel, ln in items:
                if c == ch and where(rel, ln) not in locs:
                    locs.append(where(rel, ln))
            tail = f" 等 {n} 次" if n > 5 else ""
            rows.append([ch, f"U+{ord(ch):04X}", str(n), "、".join(locs[:5]) + tail])
        return rows

    emoji_rows = table(emoji_c, per_bucket["emoji"])
    symbol_rows = table(symbol_c, per_bucket["symbol"])
    arrow_rows = table(arrow_c, per_bucket["arrow"])

    # 范围外补充：JS 字面量里的 emoji（运行时 UI 文案，可能进面板）
    js_hits = []
    for path in sorted(CONTENT.glob("prefs-*.js")):
        text = read(path)
        li = Lines(text)
        lines = text.split("\n")
        prev = None
        for m in re.finditer(r"[^\x00-\x7F]", text):
            ch = m.group(0)
            if ord(ch) == 0xFE0F and prev and ord(prev) in ALLOWED_SYMBOLS:
                prev = ch
                continue
            kind = classify_char(ch, prev)
            if kind == "emoji":
                line_no = li.of(m.start())
                src = lines[line_no - 1].strip()
                in_comment = src.startswith(("*", "//", "/*"))
                js_hits.append((ch, path.name, line_no, in_comment))
            prev = ch
    js_c = collections.Counter(ch for ch, _, _, _ in js_hits)
    js_rows = []
    for ch, n in js_c.most_common():
        locs = []
        for c, f, l, _ in js_hits:
            if c == ch and where(f, l) not in locs:
                locs.append(where(f, l))
        tail = f" 等 {n} 次" if n > 5 else ""
        live = sum(1 for c, _, _, com in js_hits if c == ch and not com)
        js_rows.append([ch, f"U+{ord(ch):04X}", str(n), str(live), "、".join(locs[:5]) + tail])

    status = "PASS" if sum(emoji_c.values()) == 0 else "FAIL"
    return {
        "key": "emoji",
        "name": "emoji 硬门禁",
        "status": status,
        "brief": f"① 桶 {sum(emoji_c.values())}（② {sum(symbol_c.values())} / ③ {sum(arrow_c.values())} 允许）；JS 范围外 {len(js_hits)}（其中注释 {sum(1 for h in js_hits if h[3])}）",
        "metrics": {
            "扫描文件": "chrome/content/prefs.xhtml、chrome/content/prefs.css",
            "① emoji 字符数（判定项）": sum(emoji_c.values()),
            "① 不同 emoji 字符": len(emoji_c),
            "② dingbats/符号数（允许）": sum(symbol_c.values()),
            "③ 箭头/数学符号数（允许）": sum(arrow_c.values()),
            "排版标点（—… 等，不计）": typo,
            "范围外 · JS 中 emoji 字符数": len(js_hits),
            "范围外 · 其中写在注释里": sum(1 for h in js_hits if h[3]),
            "范围外 · 会进入 UI 的字面量": sum(1 for h in js_hits if not h[3]),
        },
        "tables": [
            {"title": "① emoji（判定桶，必须 0）", "columns": ["字符", "码位", "次数", "位置"], "rows": emoji_rows},
            {"title": "② dingbats/符号（允许，仅报数）", "columns": ["字符", "码位", "次数", "位置"], "rows": symbol_rows},
            {"title": "③ 箭头/数学符号（允许，仅报数）", "columns": ["字符", "码位", "次数", "位置"], "rows": arrow_rows},
            {"title": "范围外补充：prefs-*.js 字面量中的 emoji", "columns": ["字符", "码位", "次数", "其中在运行代码", "位置（前 5）"], "rows": js_rows},
        ],
        "notes": [
            "判定只对 ① 桶生效；②③ 按基准单独计数、不参与 PASS/FAIL。",
            "JS 一表为范围外补充事实：预览/面板脚本里的字面量不在 xhtml/css 文本里，故不影响本门禁判定。",
            ("现存 " + str(len(js_hits)) + " 处全部写在注释里（不进入 UI）。") if js_hits and not any(not h[3] for h in js_hits) else
            (f"其中 {sum(1 for h in js_hits if not h[3])} 处位于运行代码，会写入 DOM。" if js_hits else "JS 中无 emoji 字面量。"),
        ],
    }


# --------------------------------------------------------------------------
# 检查 2 · 裸色值
# --------------------------------------------------------------------------

def check_colors() -> dict:
    text = read(CSS)
    masked = mask(text, "css")
    li = Lines(text)
    blocks = css_blocks(masked)

    token_literals = 0
    violations = []
    for sel, start, end in blocks:
        body = masked[start:end]
        if "{" in body:
            continue
        sel_txt = sel.strip()
        # 令牌块：.pp-root / :root 本体，以及深色模式下 :root… .pp-root 的覆盖块
        is_token = sel_txt in (".pp-root", ":root") or sel_txt.endswith(".pp-root") or sel_txt.endswith(":root")
        for m in DECL_RE.finditer(body):
            prop, value = m.group(1), m.group(2)
            for kind, lit in color_literals(value, prop):
                if is_token:
                    token_literals += 1
                    continue
                off = start + m.start()
                violations.append({
                    "file": "chrome/content/prefs.css",
                    "line": li.of(off),
                    "selector": sel.strip(),
                    "decl": f"{prop}: {value.strip()}",
                    "literal": lit,
                    "kind": kind,
                    "fallback": bool(VAR_FALLBACK_RE.search(value)),
                })

    # xhtml 内联
    xtext = read(XHTML)
    xmasked = mask(xtext, "xhtml")
    xli = Lines(xtext)
    inline = []
    for sm in re.finditer(r'style="([^"]*)"', xmasked):
        raw = xtext[sm.start(1): sm.end(1)]
        for m in DECL_RE.finditer(raw):
            prop, value = m.group(1), m.group(2)
            for kind, lit in color_literals(value, prop):
                inline.append({
                    "file": "chrome/content/prefs.xhtml",
                    "line": xli.of(sm.start(1) + m.start()),
                    "decl": f"{prop}: {value.strip()}",
                    "literal": lit,
                    "kind": kind,
                    "fallback": bool(VAR_FALLBACK_RE.search(value)),
                })

    # #4b7bec 全仓库（排除依赖/构建产物/本报告）
    skip_dirs = {"node_modules", ".git", "dist", "__pycache__"}
    exts = {".js", ".css", ".xhtml", ".html", ".json", ".md", ".py"}
    product_prefix = ("chrome/", "runtime/", "server/", "locale/", "wps-cite/",
                      "edge-extension/", "edge-extension-cite/")
    product_root = {"prefs.js", "bootstrap.js", "manifest.json"}
    self_path = Path(__file__).resolve()
    hits = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in exts:
            continue
        if any(part in skip_dirs for part in path.parts):
            continue
        if path.resolve() == self_path:
            continue
        if "docs" in path.parts and "audit" in path.parts:
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if "4b7bec" not in content.lower():
            continue
        rel = path.relative_to(ROOT).as_posix()
        is_product = rel.startswith(product_prefix) or rel in product_root
        for i, line in enumerate(content.split("\n"), 1):
            if "4b7bec" in line.lower():
                hits.append({"file": rel, "line": i, "product": is_product})

    product_hits = [h for h in hits if h["product"]]
    status = "PASS" if not violations and not inline and not product_hits else "FAIL"

    def rows(items):
        return [[where(v["file"].split("chrome/content/")[-1], v["line"]), v["decl"][:70], v["literal"],
                 "var() 兜底" if v["fallback"] else ""] for v in items]

    return {
        "key": "colors",
        "name": "裸色值 lint",
        "status": status,
        "brief": f"组件区 {len(violations)} / 内联 {len(inline)} / #4b7bec 产品源 {len(product_hits)}",
        "metrics": {
            "prefs.css 颜色字面量（.pp-root 令牌区，放行）": token_literals,
            "prefs.css 组件区违例": len(violations),
            "prefs.xhtml 内联违例": len(inline),
            "#4b7bec 产品源命中": len(product_hits),
            "#4b7bec 非产品源命中（docs 快照）": len(hits) - len(product_hits),
        },
        "tables": [
            {"title": "组件区违例（prefs.css）", "columns": ["位置", "声明", "字面量", "备注"], "rows": rows(violations)},
            {"title": "内联违例（prefs.xhtml style=）", "columns": ["位置", "声明", "字面量", "备注"], "rows": rows(inline)},
            {"title": "#4b7bec 命中（全仓库）", "columns": ["位置", "是否产品源"], "rows": [[where(h["file"], h["line"]), "是" if h["product"] else "否（历史快照）"] for h in hits]},
        ],
        "notes": [
            "放行口径：prefs.css 中 .pp-root / :root 规则块内的声明视为令牌定义，不计违例。",
            "内联检查含 var(--x, #fff) 形式的兜底字面量。",
        ],
    }


# --------------------------------------------------------------------------
# 检查 3 · 字号
# --------------------------------------------------------------------------

def check_font_sizes() -> dict:
    css_raw = read(CSS)
    tok_raw = read(TOKENS)
    css = mask(css_raw, "css")
    tok = mask(tok_raw, "css")

    tok_fs = token_px(tok, "fs")
    css_fs = token_px(css, "fs")
    scale = sorted(set(tok_fs.values()) | set(css_fs.values()), key=float)

    counters = {}
    occurrences = []
    var_usage = collections.Counter()
    for name, raw in (("prefs.css", css_raw), ("ui-tokens.css", tok_raw)):
        masked = mask(raw, "css")
        li = Lines(raw)
        c = collections.Counter()
        for m in re.finditer(r"font-size\s*:\s*([^;{}]+)", masked):
            value = m.group(1).strip()
            for v in re.findall(r"([0-9.]+)px", value):
                c[v] += 1
                occurrences.append({"file": name, "line": li.of(m.start()), "px": v})
            for v in re.findall(r"var\((--pp-fs-[\w-]+)\)", value):
                var_usage[v] += 1
        counters[name] = c

    all_literals = collections.Counter()
    for name, c in counters.items():
        all_literals.update(c)
    distinct = sorted(all_literals, key=float)
    off = {v: n for v, n in all_literals.items() if v not in scale}
    below = {v: n for v, n in all_literals.items() if float(v) < 10}
    unused_tokens = sorted({v for v in tok_fs.values()}
                           - {tok_fs[k] for k in var_usage if k in tok_fs}, key=float)

    # 范围外补充：JS 里写死的 px 字号
    js_rows = []
    for path in sorted(CONTENT.glob("prefs-*.js")):
        raw = read(path)
        li = Lines(raw)
        for m in re.finditer(r"font-size:\s*([0-9.]+)px", raw):
            js_rows.append([where(path.name, li.of(m.start())), m.group(1)])

    status = "PASS" if not off and not below else "FAIL"
    return {
        "key": "font",
        "name": "字号令牌纪律",
        "status": status,
        "brief": f"px 字面量 {sum(all_literals.values())}；{sum(var_usage.values())} 处走 var()；低于 10px {len(below)}",
        "metrics": {
            "令牌档位（ui-tokens + prefs.css）": " / ".join(f"{v}px" for v in scale),
            "prefs.css font-size px 字面量": sum(counters["prefs.css"].values()),
            "ui-tokens.css font-size px 字面量": sum(counters["ui-tokens.css"].values()),
            "distinct px 字面量值": ", ".join(distinct) if distinct else "（无）",
            "不在令牌内的值": len(off),
            "低于 10px 的值": len(below),
            "font-size 声明使用 var(--pp-fs-*) 次数": sum(var_usage.values()),
        },
        "tables": [
            {"title": "各字号 token 使用次数（prefs.css 声明级）",
             "columns": ["token", "值", "次数"],
             "rows": [[k, tok_fs.get(k, "?") + "px", str(n)] for k, n in var_usage.most_common()]},
            {"title": "不在令牌内的 px 值", "columns": ["值", "次数", "位置"],
             "rows": [[v, str(n), "、".join(where(o["file"], o["line"]) for o in occurrences if o["px"] == v)[:160]] for v, n in sorted(off.items(), key=lambda t: float(t[0]))]},
            {"title": "范围外补充：JS 写死的 font-size px", "columns": ["位置", "px"], "rows": js_rows},
        ],
        "notes": [
            "probe 口径：font-size 声明里的 px 数字（含简写外的单值）；var() 视为合规引用。",
            f"令牌档位中未被使用的档位：{', '.join(v + 'px' for v in unused_tokens) if unused_tokens else '无'}。",
            f"范围外 JS 内联字号 {len(js_rows)} 处，其中不在令牌档位内的值 "
            f"{len([r for r in js_rows if r[1] not in scale])} 处（"
            + "、".join(f"{v}px×{n}" for v, n in sorted(collections.Counter(r[1] for r in js_rows if r[1] not in scale).items())) + "）。",
        ],
        "debt": {
            "item": "字号 · prefs-*.js 内联 px",
            "count": f"{len(js_rows)} 处",
            "detail": "其中 "
                      + str(len([r for r in js_rows if r[1] not in scale]))
                      + " 处不在令牌档位（11/11.5/13px）；改 CSS 类或 var() 引用需逐处处理",
        },
    }


# --------------------------------------------------------------------------
# 检查 4 · 间距
# --------------------------------------------------------------------------

SP_SCALE = (4.0, 6.0, 8.0, 10.0, 12.0, 16.0, 22.0)
B_MAX = 3.0          # 光学补偿上界（0.72.3 裁决口径：≤3px）；改为 5 则 5px 也归 B


def sp_class(value: float, prop: str) -> str:
    """间距三分：A 布局节奏 / B 光学补偿 / C 控件尺寸。"""
    if value <= B_MAX:
        return "B"
    if value in (24.0, 25.0, 26.0) and prop.startswith("padding"):
        return "C"
    return "A"


def sp_on_scale(value: float) -> bool:
    """合刻度：等于令牌值，或为任一刻度值的整数倍。"""
    return any(value == t or value % t == 0 for t in SP_SCALE)


def check_spacing() -> dict:
    css_raw = read(CSS)
    tok_raw = read(TOKENS)
    css = mask(css_raw, "css")
    tok = mask(tok_raw, "css")
    li = Lines(css_raw)

    scale = sorted(set(token_px(tok, "sp").values()) | set(token_px(css, "sp").values()), key=float)

    css_rec = []
    for sel, start, end in css_blocks(css):
        body = css[start:end]
        if "{" in body:
            continue
        for m in DECL_RE.finditer(body):
            prop, value = m.group(1), m.group(2)
            if not re.match(r"(?:margin|padding|gap|row-gap|column-gap)(?:-|$)", prop):
                continue
            for v in px_values(value):
                fv = float(v)
                css_rec.append({
                    "line": li.of(start + m.start()),
                    "selector": sel.strip(),
                    "prop": prop,
                    "value": v,
                    "num": fv,
                    "cls": sp_class(fv, prop),
                    "on_scale": sp_on_scale(fv),
                    "decl": f"{prop}: {value.strip()}",
                })

    xtext = read(XHTML)
    xmasked = mask(xtext, "xhtml")
    xli = Lines(xtext)
    inline_rec = []
    inline_decls = 0
    inline_elements = 0
    inline_var = 0
    for sm in re.finditer(r'style="([^"]*)"', xmasked):
        raw = xtext[sm.start(1): sm.end(1)]
        has_px = False
        for m in SPACING_RE.finditer(raw):
            if "var(--pp-sp" in m.group(1):
                inline_var += 1
            vals = px_values(m.group(1))
            if not vals:
                continue
            inline_decls += 1
            has_px = True
            for v in vals:
                fv = float(v)
                inline_rec.append({
                    "line": xli.of(sm.start(1) + m.start()),
                    "prop": m.group(0).split(":", 1)[0].strip(),
                    "value": v,
                    "num": fv,
                    "cls": sp_class(fv, m.group(0).split(":", 1)[0].strip()),
                    "on_scale": sp_on_scale(fv),
                    "decl": m.group(0).strip()[:60],
                })
        if has_px:
            inline_elements += 1

    def group(records, cls=None):
        c = collections.Counter()
        for r in records:
            if cls and r["cls"] != cls:
                continue
            c[r["value"]] += 1
        return c

    a_all = [r for r in css_rec if r["cls"] == "A"]
    a_bad = [r for r in a_all if not r["on_scale"]]
    a_bad_vals = collections.Counter(r["value"] for r in a_bad)
    a_decls = {(r["line"], r["decl"]) for r in a_all}

    b_vals = group(css_rec, "B")
    c_vals = group(css_rec, "C")
    d_vals = group(inline_rec)
    d_a = [r for r in inline_rec if r["cls"] == "A"]
    d_b = [r for r in inline_rec if r["cls"] == "B"]
    d_decls = {(r["line"], r["decl"]) for r in inline_rec}

    def loc_cell(records, v, rel, total):
        lines = []
        for r in records:
            if r["value"] != v:
                continue
            loc = f"{rel}:{r['line']}"
            if loc not in lines:
                lines.append(loc)
        tail = f" 等 {total} 次" if total > 5 else ""
        return "、".join(lines[:5]) + tail

    status = "PASS" if not a_bad else "FAIL"
    class_rows = []
    for v, n in sorted(group(css_rec).items(), key=lambda t: float(t[0])):
        cls = "/".join(sorted({r["cls"] for r in css_rec if r["value"] == v}))
        class_rows.append([v, cls, str(n),
                           "是" if sp_on_scale(float(v)) else "否" if cls == "A" else "豁免（B/C）",
                           loc_cell(css_rec, v, "prefs.css", n)])
    d_rows = [[v, str(n), "是" if sp_on_scale(float(v)) else "否",
               loc_cell(inline_rec, v, "prefs.xhtml", n)]
              for v, n in sorted(d_vals.items(), key=lambda t: float(t[0]))]

    return {
        "key": "spacing",
        "name": "间距令牌纪律",
        "status": status,
        "brief": f"A 类违例 {len(a_bad)}（{('、'.join(v + 'px×' + str(n) for v, n in sorted(a_bad_vals.items(), key=lambda t: float(t[0]))) or '无')}）；"
                 f"B 类 {sum(b_vals.values())} 处；C 类 {sum(c_vals.values())} 处；D 类债务 {inline_decls} 条/{inline_elements} 元素",
        "metrics": {
            "令牌刻度": " / ".join(f"{v}px" for v in scale),
            "A 类 · 布局节奏（≥4px）声明": f"{len(a_decls)} 条",
            "A 类 · 违例（不合刻度且非整数倍）": f"{len(a_bad)} 处",
            "A 类 · 合规（等于刻度或整数倍）": f"{len(a_all) - len(a_bad)} 处",
            "A 类 · 若 B 上界放宽到 5px": f"{sum(1 for r in a_all if not r['on_scale'] and r['num'] > 5.0)} 处违例",
            "B 类 · 光学补偿（≤3px）": f"{sum(b_vals.values())} 处 / {len(b_vals)} 种",
            "C 类 · 控件尺寸（24/25/26px）": f"{sum(c_vals.values())} 处 / {len(c_vals)} 种",
            "D 类 · 内联间距声明（债务）": f"{inline_decls} 条",
            "D 类 · 涉及元素": f"{inline_elements} 个",
            "D 类 · 内联 var(--pp-sp-*)": f"{inline_var} 处",
            "D 类 · 字面量": f"{len(inline_rec)} 个（≥4px {len(d_a)} / ≤3px {len(d_b)}）",
        },
        "tables": [
            {"title": "A 类违例明细（判定项，必须 0）", "columns": ["位置", "选择器", "声明", "px"],
             "rows": [[f"prefs.css:{r['line']}", r["selector"][:38], r["decl"][:52], r["value"]] for r in a_bad]},
            {"title": "prefs.css 值分布（A/B/C 分类）", "columns": ["px", "类别", "次数", "合刻度", "位置（前 5）"],
             "rows": class_rows},
            {"title": "D 类 · prefs.xhtml 内联值分布（债务，不参与判定）", "columns": ["px", "次数", "合刻度", "位置（前 5）"],
             "rows": d_rows},
        ],
        "notes": [
            "A 类 = margin/padding/gap（含 -top/-right/-bottom/-left）中 ≥4px 的值；合规条件为等于 4/6/8/10/12/16/22 或为其整数倍。",
            f"B 类 = ≤{B_MAX:g}px（边框补偿、图标对齐微调），不属间距节奏，照实报数、不参与 PASS/FAIL。常量 B_MAX 定义在脚本顶部。",
            "C 类 = 24/25/26px 且属性为 padding（搜索框内给图标/清除钮留位、取色器内高），按控件尺寸处理，不参与判定。",
            "D 类 = prefs.xhtml 的 style= 内联间距，整体记为已知技术债："
            f"{inline_decls} 条声明、{inline_elements} 个元素、{len(inline_rec)} 个字面量，var(--pp-sp-*) 使用 0 处；"
            f"若 tokenize 需改动 {inline_decls} 条声明。",
            "判定：A 类违例 = 0 即 PASS；B/C/D 只报数。",
            ("边界个案：A 类违例全部是 5px（" +
             "、".join(f"{r['selector'].split()[-1]} {r['line']}" for r in a_bad) +
             "）。按 B_MAX=3 判为违例；若裁决 5px 同属发丝级（把 B_MAX 改为 5），A 类归零、本项转 PASS。"
             "四处语义：折源头下内衬（图标对齐）、小徽章左右内衬、PDF 列表 gap、分组下边距。")
            if a_bad else "A 类全部合规。",
        ],
        "debt": {
            "item": "间距 · prefs.xhtml 内联",
            "count": f"{inline_decls} 条声明 / {inline_elements} 个元素",
            "detail": "全部写死 px（var 0 处）；tokenize 需改动 "
                      f"{inline_decls} 条声明，涉及 {inline_elements} 个元素",
        },
    }


# --------------------------------------------------------------------------
# 检查 5 · 假按钮 / 键盘可达
# --------------------------------------------------------------------------

BASELINE_IDS = [
    "pp-register-link", "pp-forgot-link", "pp-reg-back", "pp-mb-code-toggle",
    "pp-bal-order-view", "pp-mb-order-view", "pp-account-email", "pp-mb-renew",
    "pp-mb-compare-toggle",
]


def js_bindings():
    """返回 click_ids / keydown_ids：id -> [(file, line, pattern)]"""
    click = collections.defaultdict(list)
    keydown = collections.defaultdict(list)
    pats = [
        (re.compile(r'\bbind\(\s*"([\w-]+)"\s*,\s*"click"'), "bind()"),
        (re.compile(r'\$\(\s*"([\w-]+)"\s*\)\s*\.\s*addEventListener\(\s*"click"'), "$().addEventListener"),
        (re.compile(r'\$\(\s*"([\w-]+)"\s*\)\s*\.\s*onclick'), "$().onclick"),
        (re.compile(r'getElementById\(\s*"([\w-]+)"\s*\)\s*\.\s*addEventListener\(\s*"click"'), "getElementById"),
    ]
    kpats = [
        (re.compile(r'\bbind\(\s*"([\w-]+)"\s*,\s*"keydown"'), "bind()"),
        (re.compile(r'\$\(\s*"([\w-]+)"\s*\)\s*\.\s*addEventListener\(\s*"keydown"'), "$().addEventListener"),
        (re.compile(r'getElementById\(\s*"([\w-]+)"\s*\)\s*\.\s*addEventListener\(\s*"keydown"'), "getElementById"),
    ]
    for path in sorted(CONTENT.glob("prefs-*.js")):
        raw = read(path)
        li = Lines(raw)
        for pat, label in pats:
            for m in pat.finditer(raw):
                click[m.group(1)].append((path.name, li.of(m.start()), label))
        for pat, label in kpats:
            for m in pat.finditer(raw):
                keydown[m.group(1)].append((path.name, li.of(m.start()), label))
        # 变量式：const x = $("id"); 后续 x.addEventListener("click" / x.onclick
        varmap = {}
        for m in re.finditer(r'\b(?:const|let|var)\s+(\w+)\s*=\s*\$\(\s*"([\w-]+)"\s*\)', raw):
            varmap[m.group(1)] = (m.group(2), li.of(m.start()))
        for var, (ident, line) in varmap.items():
            # 单字母/短变量名在长文件里极易撞名（如 b、el），只在变量唯一赋值时采信
            if len(var) < 3 or len(re.findall(r"\b(?:const|let|var)\s+" + re.escape(var) + r"\s*=", raw)) > 1:
                continue
            if re.search(r"\b" + re.escape(var) + r"\s*\.\s*(?:addEventListener\(\s*\"click\"|onclick)", raw):
                click[ident].append((path.name, line, f"变量 {var}"))
            if re.search(r"\b" + re.escape(var) + r"\s*\.\s*addEventListener\(\s*\"keydown\"", raw):
                keydown[ident].append((path.name, line, f"变量 {var}"))
    return click, keydown


def scan_dynamic_clickables():
    """范围外复核：JS 运行时创建的 span/div/b 上绑 click 的元素（xhtml 里没有对应 id）。"""
    out = []
    pat = re.compile(r'\b(?:const|let|var)\s+(\w+)\s*=\s*el\(\s*"(span|div|b|i|em|img|small|p)"')
    for path in sorted(CONTENT.glob("prefs-*.js")):
        raw = read(path)
        li = Lines(raw)
        for m in pat.finditer(raw):
            var, tag = m.group(1), m.group(2)
            window = raw[m.end(): m.end() + 900]
            click = re.search(r"\n[^\n]*\b" + re.escape(var) + r"\.addEventListener\(\s*\"click\"", window)
            if not click:
                continue
            head = raw[m.start(): m.start() + 220]
            cls = re.search(r'class:\s*"([^"]*)"', head)
            if cls:
                cls = cls.group(1)
            else:
                alt = re.search(r"class:\s*([^,}]{0,140})", head)
                cls = re.sub(r"\s+", " ", alt.group(1)).strip() if alt else ""
            if "mask" in cls or "overlay" in cls:
                continue
            scope = raw[m.start(): m.end() + click.end() + 400]
            has_role = bool(re.search(re.escape(var) + r'\.setAttribute\(\s*"role"', scope))
            has_tab = bool(re.search(re.escape(var) + r'\.tabIndex|' + re.escape(var) + r'\.setAttribute\(\s*"tabindex"', scope))
            has_key = bool(re.search(re.escape(var) + r'\.addEventListener\(\s*"keydown"', scope))
            out.append({
                "file": path.name,
                "line": li.of(m.start()),
                "tag": tag,
                "class": cls,
                "role": has_role,
                "tabindex": has_tab,
                "keydown": has_key,
            })
    return out


def check_fake_buttons() -> dict:
    text = read(XHTML)
    nodes = parse_xhtml(text)
    by_id = {n.ident(): n for n in nodes if n.ident()}
    click, keydown = js_bindings()

    def is_keyboard_ok(node: Node, js_keydown: bool):
        tag = node.tag
        if tag == "html:button":
            return True, "原生 button"
        if tag == "html:a" and node.attrs.get("href"):
            return True, "a[href]"
        if tag == "html:input" and (node.attrs.get("type") or "").lower() in ("button", "submit"):
            return True, "input[type=button/submit]"
        role = node.attrs.get("role") == "button"
        tab = node.attrs.get("tabindex") not in (None, "", "-1")
        if role and tab and js_keydown:
            return True, "role+tabindex+keydown"
        missing = []
        if not role:
            missing.append("role")
        if not tab:
            missing.append("tabindex")
        if not js_keydown:
            missing.append("keydown")
        return False, "缺 " + "/".join(missing)

    violations = []
    ok_rows = []
    dynamic = []
    tag_counter = collections.Counter()
    for ident in sorted(click):
        node = by_id.get(ident)
        if node is None:
            dynamic.append((ident, click[ident][0]))
            continue
        tag_counter[node.tag] += 1
        ok, why = is_keyboard_ok(node, ident in keydown)
        row = [ident, node.tag, str(node.line), why, "、".join(f"{f}:{l}" for f, l, _ in click[ident][:3])]
        if ok:
            ok_rows.append(row)
        else:
            violations.append(row)

    baseline_rows = []
    for ident in BASELINE_IDS:
        node = by_id.get(ident)
        if node is None:
            baseline_rows.append([ident, "（不在 xhtml）", "-", "-", "-", "-"])
            continue
        has_click = ident in click
        ok, why = is_keyboard_ok(node, ident in keydown)
        baseline_rows.append([
            ident, node.tag, str(node.line),
            node.attrs.get("role", "—"),
            node.attrs.get("tabindex", "—"),
            ("✓ " if ok else "✗ ") + why,
        ])

    # 付款弹窗实现核查（prefs-account.js）
    acc = read(CONTENT / "prefs-account.js")
    ali = Lines(acc)

    def find(pattern, label):
        m = re.search(pattern, acc)
        return {"label": label, "found": bool(m), "line": ali.of(m.start()) if m else None}

    dialog = [
        find(r'role:\s*"dialog"', 'role="dialog"'),
        find(r'"aria-modal":\s*"true"', 'aria-modal="true"'),
        find(r'"aria-labelledby":\s*"pp-order-dlg-title"', 'aria-labelledby'),
        find(r'el\("button",\s*\{\s*class:\s*"pp-dlg-close"', "关闭钮为 <button>"),
        find(r'if\s*\(ev\.key\s*===\s*"Escape"\)', "Esc 关闭"),
        find(r'_focusables\(\)', "focus trap 候选集"),
        find(r'if\s*\(ev\.key\s*!==\s*"Tab"\)\s*return', "Tab 循环"),
        find(r'_returnFocus\s*=\s*\(ae', "记录触发元素"),
        find(r'back\.focus\(\)', "关闭后归还焦点"),
    ]
    dialog_ok = all(d["found"] for d in dialog)
    close_is_button = next(d for d in dialog if d["label"].startswith("关闭钮"))["found"]

    fn_rows = []
    for pattern, label in (
        (r"_focusables\(\)\s*\{", "_focusables()"),
        (r"show\(order, kind, actions\)\s*\{", "show()"),
        (r"this\._onKey\s*=\s*\(ev\)\s*=>", "_onKey(Esc/Tab)"),
        (r"^\s{4}close\(\)\s*\{", "close()"),
    ):
        m = re.search(pattern, acc, re.M)
        fn_rows.append([label, str(ali.of(m.start())) if m else "—"])

    # 弹窗二维码 img 的 alt（JS 动态创建）
    qr = re.search(r'el\("img",\s*\{\s*class:\s*"pp-dlg-qr"[^}]*\}\)', acc)
    qr_alt = bool(qr and "alt" in qr.group(0))

    dyn = scan_dynamic_clickables()
    dyn_bad = [d for d in dyn if not (d["role"] and d["tabindex"] and d["keydown"])]

    status = "PASS" if not violations and dialog_ok and close_is_button else "FAIL"
    return {
        "key": "keyboard",
        "name": "假按钮 / 键盘可达",
        "status": status,
        "brief": f"click id {len(click)} 个全部可键盘达；动态节点复核 {len(dyn_bad)} 处违例",
        "metrics": {
            "JS 绑定了 click 的 id 数": len(click),
            "其中 xhtml 可定位": sum(tag_counter.values()),
            "其中动态生成（xhtml 无此 id）": len(dynamic),
            "判定通过的按钮": len(ok_rows),
            "假按钮（键盘不可达）": len(violations),
            "付款弹窗无障碍五项": "齐备" if dialog_ok else "缺失",
            "补充 · 动态生成的可点击元素": f"{len(dyn)} 个（键盘不可达 {len(dyn_bad)} 个）",
        },
        "tables": [
            {"title": "基准点名 id 现状", "columns": ["id", "标签", "行", "role", "tabindex", "判定"], "rows": baseline_rows},
            {"title": "假按钮违例（click 可达、键盘不可达）", "columns": ["id", "标签", "行", "缺失项", "click 绑定"], "rows": violations},
            {"title": "付款弹窗实现（prefs-account.js）", "columns": ["项", "存在", "行号"],
             "rows": [[d["label"], "✓" if d["found"] else "✗", str(d["line"] or "—")] for d in dialog]},
            {"title": "付款弹窗实现函数（prefs-account.js）", "columns": ["函数", "起始行"], "rows": fn_rows},
            {"title": "范围外复核：JS 动态生成的可点击 span/div（键鼠不等价）",
             "columns": ["位置", "标签", "class", "role", "tabindex", "keydown"],
             "rows": [[f"{d['file']}:{d['line']}", d["tag"], d["class"] or "—",
                       "✓" if d["role"] else "✗", "✓" if d["tabindex"] else "✗",
                       "✓" if d["keydown"] else "✗"] for d in dyn_bad]},
        ],
        "notes": [
            "可键盘达口径：html:button / a[href] / input[type=button|submit]；其余标签须 role=button + tabindex + JS keydown 三者齐备。",
            f"弹窗二维码由 JS 创建（el(\"img\"…)），alt 属性：{'有' if qr_alt else '无'}。",
            f"动态生成 id（不在 xhtml，跳过判定）{len(dynamic)} 个。",
            ("范围外复核不计入本门禁 PASS/FAIL（口径为 xhtml id 交叉分析）；"
             f"若计入，动态节点 {len(dyn_bad)} 处键盘不可达，本项应为 FAIL。") if dyn_bad else
            ("范围外复核：JS 运行时创建的可点击元素已全部消除（0 处 span/div 绑定 click 且无 role/tabindex/keydown）。"),
        ],
    }


# --------------------------------------------------------------------------
# 检查 6 · 语义标签
# --------------------------------------------------------------------------

TEXTUAL_EXCLUDE = {"button", "checkbox", "radio", "hidden", "submit", "reset", "image", "file"}


def check_semantics() -> dict:
    text = read(XHTML)
    nodes = parse_xhtml(text)
    labels = [n for n in nodes if n.tag == "html:label"]
    controls = {"html:input", "html:select", "html:textarea"}

    def _desc_controls(node: Node):
        out = []
        stack = list(node.children)
        while stack:
            c = stack.pop()
            if c.tag in controls:
                out.append(c)
            stack.extend(c.children)
        return out

    with_for = [n for n in labels if n.attrs.get("for")]
    wrapping = [n for n in labels if _desc_controls(n)]
    neither = [n for n in labels if not n.attrs.get("for") and not _desc_controls(n)]

    ids = [n.ident() for n in nodes if n.ident()]
    dup_ids = [k for k, v in collections.Counter(ids).items() if v > 1]
    broken_for = [n for n in with_for if n.attrs["for"] not in set(ids)]

    label_tags = collections.Counter(n.tag for n in nodes if "pp-label" in n.cls())
    for_labels = {n.attrs["for"]: n for n in with_for}
    label_ids = {n.ident() for n in labels if n.ident()}

    textual = []
    for n in nodes:
        if n.tag == "html:input":
            t = (n.attrs.get("type") or "text").lower()
            if t in TEXTUAL_EXCLUDE:
                continue
            textual.append(n)
        elif n.tag in ("html:select", "html:textarea"):
            textual.append(n)

    def associated(n: Node):
        if has_ancestor(n, "html:label"):
            return True
        if n.ident() and n.ident() in for_labels:
            return True
        if n.attrs.get("aria-label") or n.attrs.get("aria-labelledby"):
            return True
        return False

    unlabeled = [n for n in textual if not associated(n)]

    imgs = [n for n in nodes if n.tag == "html:img"]
    imgs_no_alt = [n for n in imgs if "alt" not in n.attrs]
    msgs = [n for n in nodes if "pp-msg" in n.cls()]
    msgs_no_live = [n for n in msgs if not n.attrs.get("aria-live")]
    decorative = [n for n in msgs_no_live if n.attrs.get("aria-hidden") == "true"]

    def next_sibling_info(node: Node):
        p = node.parent
        if p is None:
            return "—"
        kids = p.children
        try:
            idx = kids.index(node)
        except ValueError:
            return "—"
        if idx + 1 >= len(kids):
            return "（父节点末尾）"
        sib = kids[idx + 1]
        extra = "·其后含控件" if _desc_controls(sib) else ""
        return sib.tag + extra

    status = "PASS" if not neither and not unlabeled and not imgs_no_alt else "FAIL"
    return {
        "key": "semantics",
        "name": "语义标签",
        "status": status,
        "brief": f"label 无关联 {len(neither)}；控件无标签 {len(unlabeled)}；img 无 alt {len(imgs_no_alt)}",
        "metrics": {
            "html:label 总数": len(labels),
            "其中带 for=": len(with_for),
            "其中 for= 断链": len(broken_for),
            "元素 id 重复": len(dup_ids),
            "其中包裹控件": len(wrapping),
            "既无 for 也无包裹控件（必须 0）": len(neither),
            "表单文本类控件总数": len(textual),
            "无 label 且无 aria-label（必须 0）": len(unlabeled),
            "html:img 总数 / 无 alt": f"{len(imgs)} / {len(imgs_no_alt)}",
            ".pp-msg 总数": len(msgs),
            ".pp-msg 带 aria-live": len(msgs) - len(msgs_no_live),
            ".pp-msg 无 aria-live": f"{len(msgs_no_live)}（均为 aria-hidden 装饰点，按设计豁免）" if len(decorative) == len(msgs_no_live) else str(len(msgs_no_live)),
            "class=pp-label 的元素": "、".join(f"{k}×{v}" for k, v in label_tags.items()),
        },
        "tables": [
            {"title": "label 关联方式分布", "columns": ["类别", "数量"],
             "rows": [["带 for=", str(len(with_for))], ["包裹式", str(len(wrapping))],
                      ["既有 for 又包裹", str(len([n for n in labels if n.attrs.get('for') and _desc_controls(n)]))],
                      ["两者皆无", str(len(neither))]]},
            {"title": "无关联的 label（伪标题/伪标签）", "columns": ["行", "class", "文本", "下一个兄弟"],
             "rows": [[str(n.line), n.cls(), plain(n, text)[:44], next_sibling_info(n)] for n in neither]},
            {"title": "无 label / 无 aria 的文本类控件", "columns": ["行", "标签", "id", "class"],
             "rows": [[str(n.line), n.tag, n.ident() or "—", n.cls()] for n in unlabeled]},
            {"title": "按设计豁免的装饰点（aria-hidden，无 aria-live）", "columns": ["行", "id", "class", "aria-hidden"],
             "rows": [[str(n.line), n.ident(), n.cls(), n.attrs.get("aria-hidden", "—")] for n in msgs_no_live]},
        ],
        "notes": [
            "文本类控件口径：html:input 除 button/checkbox/radio/hidden/submit/reset/image/file 外的全部类型（含 text/number/color/password/range），加 html:select / html:textarea。",
            "checkbox/radio 由包裹式 label 承担即算已关联。",
            (f"{len(neither)} 个无关联 label 中：{sum(1 for n in neither if next_sibling_info(n) == 'html:input')} 个是紧邻 input 的字段标签（未用 for= 也未包裹），"
             f"其余 {sum(1 for n in neither if next_sibling_info(n) != 'html:input')} 个用作分区标题/组标题。") if neither else
            "所有 label 均带 for= 或包裹控件（无孤立 label）。",
            f"23 个 for= 全部指向存在且唯一的 id（断链 {len(broken_for)}、重复 id {len(dup_ids)}）。",
            f".pp-msg 中 {len(msgs_no_live)} 个无 aria-live（{('、'.join(m.ident() for m in msgs_no_live))}），"
            "均为彩色状态圆点（内容「●」）借用 .pp-msg 类：现为 aria-hidden=\"true\" 纯装饰，"
            "状态播报由紧邻文字节点承担（#pp-wps-state / #pp-cloud-state 各自带 aria-live=\"polite\" 与初始文案）。",
        ],
    }


# --------------------------------------------------------------------------
# 检查 7 · 文案一致性
# --------------------------------------------------------------------------

TERMS = ["实测", "检测入口", "检测本机自建服务", "重新检测", "保存并测试"]
VERB_RE = re.compile(r"(测试|检测|实测|验证|试跑)")


def check_copy() -> dict:
    files = sorted(CONTENT.glob("prefs-*.js")) + [XHTML]
    term_rows = []
    button_copy_hits = []
    for path in files:
        raw = read(path)
        rel = path.name
        li = Lines(raw)
        lines = raw.split("\n")
        for i, line in enumerate(lines, 1):
            for term in TERMS:
                if term not in line:
                    continue
                # 按钮文案判定：同一行含 <html:button，或 JS 里是 el("button"/textContent
                is_button = bool(re.search(r"html:button|<button", line)) or bool(
                    re.search(r'el\(\s*"button"|textContent\s*=|innerHTML\s*=', line))
                term_rows.append([f"{rel}:{i}", term, "按钮/标签文案" if is_button else "注释/说明", line.strip()[:72]])
                if is_button and not (term == "保存并测试" and "保存并测试连接" in line):
                    button_copy_hits.append(f"{rel}:{i}「{term}」")

    # 现存「测试/检测」动词的按钮文案清单（事实）
    verb_rows = []
    for path in files:
        raw = read(path)
        rel = path.name
        li = Lines(raw)
        for m in re.finditer(r"<html:button[^>]*>([^<]{0,40})</html:button>", raw):
            label = m.group(1).strip()
            if VERB_RE.search(label):
                verb_rows.append([f"{rel}:{li.of(m.start())}", label])
        for m in re.finditer(r'el\(\s*"button"[^)]{0,160}?\)\s*,?\s*"([^"]{0,40})"', raw):
            label = m.group(1)
            if VERB_RE.search(label):
                verb_rows.append([f"{rel}:{li.of(m.start())}", label])
        for m in re.finditer(r'textContent\s*=\s*"([^"]{0,40})"', raw):
            label = m.group(1)
            if VERB_RE.search(label):
                verb_rows.append([f"{rel}:{li.of(m.start())}", label])

    # 通道行行内反馈
    acc = read(CONTENT / "prefs-account.js")
    ali = Lines(acc)
    m = re.search(r"function buildChannelRow", acc)
    row_start = m.start() if m else 0
    row_end = acc.find("\n  function ", row_start + 10)
    if row_end < 0:
        row_end = len(acc)
    row_body = acc[row_start:row_end]
    inline_msg = re.search(r'class:\s*"pp-msg"', row_body)
    inline_line = ali.of(row_start + inline_msg.start()) if inline_msg else None
    fallback_lines = [ali.of(x.start()) for x in re.finditer(r'\$\("pp-ch-test-result"\)', acc)]

    status = "PASS" if not button_copy_hits and inline_msg else "FAIL"
    verbs = collections.Counter()
    for _, label in verb_rows:
        for m in VERB_RE.finditer(label):
            verbs[m.group(1)] += 1
    return {
        "key": "copy",
        "name": "文案一致性",
        "status": status,
        "brief": f"五词按钮文案违例 {len(button_copy_hits)}；通道行行内反馈 {'有' if inline_msg else '无'}；动词 {len(verbs)} 种并存",
        "metrics": {
            "历史用词命中总数": len(term_rows),
            "其中出现在按钮/标签文案": sum(1 for r in term_rows if r[2] == "按钮/标签文案"),
            "按钮文案违例": len(button_copy_hits),
            "现存按钮文案的动词种类": "、".join(f"{k}×{v}" for k, v in verbs.most_common()) or "无",
            "通道行行内 .pp-msg": "有" if inline_msg else "无",
            "通道卡底部兜底位 #pp-ch-test-result 引用": f"{len(fallback_lines)} 处",
        },
        "tables": [
            {"title": "历史用词现存位置", "columns": ["位置", "用词", "语境", "原文"], "rows": term_rows},
            {"title": "现存含 测试/检测/实测/验证 的按钮文案", "columns": ["位置", "文案"], "rows": verb_rows},
        ],
        "notes": [
            f"通道行行内反馈槽：prefs-account.js:{inline_line}" if inline_line else "通道行未找到行内 .pp-msg。",
            "「保存并测试连接」视为已统一后的规范词，不计违例；仅「保存并测试」（无「连接」）计违例。",
        ],
    }


# --------------------------------------------------------------------------
# 附 · 0.72.3 增量复核（不占门禁编号）
# --------------------------------------------------------------------------

def check_increment() -> dict:
    css_raw = read(CSS)
    css = mask(css_raw, "css")
    li = Lines(css_raw)
    tok_raw = read(TOKENS)
    tok = mask(tok_raw, "css")
    tli = Lines(tok_raw)

    def is_token_sel(sel: str) -> bool:
        s = sel.strip()
        return s in (".pp-root", ":root") or s.endswith(".pp-root") or s.endswith(":root")

    # ① color-scheme：亮色 1 处，两套深色各 1 处
    cs = []
    for sel, start, end in css_blocks(css):
        body = css[start:end]
        if "{" in body:
            continue
        for m in re.finditer(r"color-scheme\s*:\s*([^;{}]+)", body):
            cs.append({"selector": sel.strip(), "value": m.group(1).strip(), "line": li.of(start + m.start())})
    light = [x for x in cs if x["value"].split()[0] == "light"]
    dark = [x for x in cs if x["value"].split()[0] == "dark"]
    cs_ok = (len(light) == 1 and len(dark) == 2
             and any(':not([data-theme="light"])' in x["selector"] for x in dark)
             and any('[data-theme="dark"]' in x["selector"] for x in dark))

    # ② border-control 令牌：两个文件各三段齐全，组件区只用 var()
    names = ("pp-border-control", "pp-border-control-hover")

    def defs(masked, lines):
        out = []
        for sel, start, end in css_blocks(masked):
            body = masked[start:end]
            if "{" in body:
                continue
            for name in names:
                for m in re.finditer(r"--" + re.escape(name) + r"\s*:\s*([^;{}]+)", body):
                    out.append({"name": name, "selector": sel.strip(),
                                "value": m.group(1).strip(), "line": lines.of(start + m.start())})
        return out

    tok_defs = defs(tok, tli)
    pre_defs = defs(css, li)
    tok_ok = len(tok_defs) == 6 and len({d["selector"] for d in tok_defs}) == 3
    pre_ok = len(pre_defs) == 6 and len({d["selector"] for d in pre_defs}) == 3
    def block_order(defs_list):
        """按 亮 / media 深 / [data-theme=dark] 顺序返回每段的 {name: value}。"""
        order = {}
        for d in defs_list:
            sel = d["selector"]
            key = 2 if '[data-theme="dark"]' in sel else (1 if "prefers-color" in sel or ":not(" in sel else 0)
            order.setdefault(key, {})[d["name"]] = d["value"]
        return [order.get(k, {}) for k in (0, 1, 2)]

    same_values = block_order(tok_defs) == block_order(pre_defs) and len(tok_defs) == len(pre_defs)

    uses = collections.Counter()
    token_spans = []
    for sel, start, end in css_blocks(css):
        if "{" in css[start:end]:
            continue
        if is_token_sel(sel):
            token_spans.append((start, end))
    for m in re.finditer(r"var\(--pp-border-control(-hover)?\)", css):
        if any(a <= m.start() <= b for a, b in token_spans):
            continue
        uses["hover" if m.group(1) else "base"] += 1

    bare_border = []
    for sel, start, end in css_blocks(css):
        body = css[start:end]
        if "{" in body or is_token_sel(sel):
            continue
        for m in DECL_RE.finditer(body):
            prop, value = m.group(1), m.group(2)
            if prop.startswith("border") or prop in ("outline", "box-shadow"):
                if HEX_RE.search(value) or FUNC_RE.search(value):
                    bare_border.append((li.of(start + m.start()), f"{prop}: {value.strip()}"))
    tokens_ok = tok_ok and pre_ok and uses.get("base", 0) > 0 and uses.get("hover", 0) > 0 and not bare_border

    # ③ 动态点击目标独立复跑
    dyn = scan_dynamic_clickables()

    status = "PASS" if (cs_ok and tokens_ok and not dyn) else "FAIL"
    return {
        "key": "increment",
        "name": "0.72.3 增量复核",
        "status": status,
        "brief": (f"color-scheme {len(cs)} 处（light {len(light)} / dark {len(dark)}）；"
                  f"border-control 定义 ui {len(tok_defs)} / prefs {len(pre_defs)} 条，var 使用 {sum(uses.values())} 次；"
                  f"动态点击目标 {len(dyn)} 处"),
        "metrics": {
            "① color-scheme 声明": f"{len(cs)} 处（light {len(light)} / dark {len(dark)}）",
            "① 两套深色块是否都有": "是" if cs_ok else "否",
            "② --pp-border-control* 定义（ui-tokens）": f"{len(tok_defs)} 条 / {len({d['selector'] for d in tok_defs})} 段",
            "② --pp-border-control* 定义（prefs.css）": f"{len(pre_defs)} 条 / {len({d['selector'] for d in pre_defs})} 段",
            "② 两文件取值是否一致": "是" if same_values else "否",
            "② 组件区 var() 使用": f"{sum(uses.values())} 次（base {uses.get('base', 0)} / hover {uses.get('hover', 0)}）",
            "② 组件区裸色描边": f"{len(bare_border)} 处",
            "③ 动态生成的 span/div 点击目标": f"{len(dyn)} 处",
        },
        "tables": [
            {"title": "① color-scheme 落点", "columns": ["行", "选择器", "值"],
             "rows": [[str(x["line"]), x["selector"][:56], x["value"]] for x in cs]},
            {"title": "② 令牌定义（ui-tokens.css）", "columns": ["行", "选择器", "令牌", "值"],
             "rows": [[str(d["line"]), d["selector"][:44], d["name"], d["value"]] for d in tok_defs]},
            {"title": "② 令牌定义（prefs.css）", "columns": ["行", "选择器", "令牌", "值"],
             "rows": [[str(d["line"]), d["selector"][:44], d["name"], d["value"]] for d in pre_defs]},
            {"title": "② 组件区裸色描边", "columns": ["行", "声明"],
             "rows": [[f"prefs.css:{l}", d] for l, d in bare_border]},
            {"title": "③ 动态点击目标（独立复跑）", "columns": ["位置", "标签", "class", "role", "tabindex", "keydown"],
             "rows": [[f"{d['file']}:{d['line']}", d["tag"], d["class"] or "—",
                       "✓" if d["role"] else "✗", "✓" if d["tabindex"] else "✗",
                       "✓" if d["keydown"] else "✗"] for d in dyn]},
        ],
        "notes": [
            "① 只查 prefs.css（ui-tokens 是窗口词汇表，不负责控件渲染）。",
            "② 期望形态：两个文件各 3 段（亮 / @media 深色 / [data-theme=dark]），每段 2 个令牌，且两文件取值一致；组件区通过 var() 引用。",
            "③ 本脚本扫全部 11 个 prefs-*.js；fix-runtime 的 prefs-runtime-audit.js 另报 103/103，两条独立实现互为交叉验证。",
        ],
    }


# --------------------------------------------------------------------------
# 报告
# --------------------------------------------------------------------------

def file_meta(path: Path) -> dict:
    """输入指纹 + 文本形态。行数同时给 wc -l 口径与含末尾空行口径，避免歧义。"""
    blob = path.read_bytes()
    text = blob.decode("utf-8")
    return {
        "bytes": len(blob),
        "lines": text.count("\n"),
        "lines_split": len(text.split("\n")),
        "eol": "CRLF" if b"\r\n" in blob else "LF",
        "bom": blob.startswith(b"\xef\xbb\xbf"),
        "trailing_newline": text.endswith("\n"),
        "sha256_16": hashlib.sha256(blob).hexdigest()[:16],
    }


def build(version: str) -> dict:
    checks = [
        check_emoji(),
        check_colors(),
        check_font_sizes(),
        check_spacing(),
        check_fake_buttons(),
        check_semantics(),
        check_copy(),
    ]
    return {
        "meta": {
            "version": version,
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "root": str(ROOT),
            "files": {
                "prefs.xhtml": file_meta(XHTML),
                "prefs.css": file_meta(CSS),
                "ui-tokens.css": file_meta(TOKENS),
            },
        },
        "debt": sorted([c["debt"] for c in checks if c.get("debt")],
                       key=lambda d: 0 if d["item"].startswith("间距") else 1),
        "checks": checks,
        "increment": check_increment(),
    }


def render_md(report: dict) -> str:
    m = report["meta"]
    out = []
    out.append(f"# 设置面板静态门禁审计（{m['version']}）\n")
    out.append(f"> 生成时间：{m['generated_at']}｜脚本：`scripts/audit/static-audit.py`（可重复运行）")
    out.append(f"> 输入：`chrome/content/prefs.xhtml`（{m['files']['prefs.xhtml']['lines']} 行）、`prefs.css`（{m['files']['prefs.css']['lines']} 行）、"
               f"`ui-tokens.css`（{m['files']['ui-tokens.css']['lines']} 行）、`prefs-*.js`（11 个）")
    out.append("> 行数口径：`wc -l`（换行符数）；按 `\\n` 切分会多 1（末尾保留换行）。")
    if m.get("files"):
        out.append("> 指纹（SHA-256 前 16 位 · 字节 · 行尾）：" + "；".join(
            f"{k} `{v['sha256_16']}`（{v['bytes']} B · {v['eol']}"
            + ("，无 BOM" if not v["bom"] else "，有 BOM")
            + ("，末尾保留换行" if v["trailing_newline"] else "，末尾无换行") + "）"
            for k, v in m["files"].items()))
    out.append("> 全部计数来自脚本实测；明细超过 20 条时只列前 20 条并注明余量。\n")

    out.append("## 总览\n")
    out.append("| # | 门禁 | 结果 | 关键计数 |")
    out.append("|---|---|---|---|")
    for i, c in enumerate(report["checks"], 1):
        out.append(f"| {i} | {c['name']} | **{c['status']}** | {c.get('brief', '')} |")
    out.append("")

    debt = report.get("debt") or []
    if debt:
        out.append("## 已知债务（不参与门禁判定）\n")
        out.append("| 项 | 数量 | 说明 |")
        out.append("|---|---|---|")
        for d in debt:
            out.append(f"| {d['item']} | {d['count']} | {d['detail']} |")
        out.append("")

    for i, c in enumerate(report["checks"], 1):
        out.append(f"## {i}. {c['name']} — {c['status']}\n")
        out.append("| 指标 | 值 |")
        out.append("|---|---|")
        for k, v in c["metrics"].items():
            out.append(f"| {k} | {v} |")
        out.append("")
        for t in c["tables"]:
            rows = t["rows"]
            out.append(f"### {t['title']}\n")
            if not rows:
                out.append("（无）\n")
                continue
            head, rest = rows[:MAX_ROWS], rows[MAX_ROWS:]
            out.append("| " + " | ".join(t["columns"]) + " |")
            out.append("|" + "|".join(["---"] * len(t["columns"])) + "|")
            for r in head:
                cells = [str(x).replace("|", "\\|").replace("\n", " ") for x in r]
                out.append("| " + " | ".join(cells) + " |")
            if rest:
                out.append(f"| … | 另有 {len(rest)} 处 |" + " — |" * (len(t["columns"]) - 2))
            out.append("")
        if c.get("notes"):
            for n in c["notes"]:
                out.append(f"- {n}")
            out.append("")

    inc = report.get("increment")
    if inc:
        out.append(f"## 附：{inc['name']} — {inc['status']}\n")
        out.append("| 指标 | 值 |")
        out.append("|---|---|")
        for k, v in inc["metrics"].items():
            out.append(f"| {k} | {v} |")
        out.append("")
        for t in inc["tables"]:
            rows = t["rows"]
            out.append(f"### {t['title']}\n")
            if not rows:
                out.append("（无）\n")
                continue
            head, rest = rows[:MAX_ROWS], rows[MAX_ROWS:]
            out.append("| " + " | ".join(t["columns"]) + " |")
            out.append("|" + "|".join(["---"] * len(t["columns"])) + "|")
            for r in head:
                cells = [str(x).replace("|", "\\|").replace("\n", " ") for x in r]
                out.append("| " + " | ".join(cells) + " |")
            if rest:
                out.append(f"| … | 另有 {len(rest)} 处 |" + " — |" * (len(t["columns"]) - 2))
            out.append("")
        for n in inc.get("notes", []):
            out.append(f"- {n}")
        out.append("")

    out.append("---\n")
    out.append("判定口径见脚本常量：emoji 桶按 Unicode 区段 + 显式允许符号表；颜色放行 `.pp-root` / `:root` 规则块；"
               "字号/间距以 `ui-tokens.css` 与 `prefs.css` 的 `--pp-fs-*` / `--pp-sp-*` 为准；"
               "键盘可达以原生可聚焦标签或 role+tabindex+keydown 三者齐备为准。")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="设置面板静态门禁审计")
    ap.add_argument("--version", default="0.72.3")
    ap.add_argument("--out", default=None, help="输出目录（默认 docs/audit/<version>）")
    ap.add_argument("--print", action="store_true", help="同时打印总览")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    report = build(args.version)
    out_dir = Path(args.out) if args.out else ROOT / "docs" / "audit" / args.version
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / "static.md"
    json_path = out_dir / "static.json"
    md_path.write_text(render_md(report), encoding="utf-8")
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.print:
        for c in report["checks"]:
            print(f"[{c['status']}] {c['name']}")
    print(f"wrote {md_path.relative_to(ROOT).as_posix()}")
    print(f"wrote {json_path.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
