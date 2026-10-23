#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
"""设置面板三向接线审计（prefs.xhtml × prefs-*.js × prefs.js）

为什么需要它：面板上有 400+ 个控件、18 个脚本，而「点了没反应 / 填了不生效」
这类问题 check-wiring 的存在性断言查不出来 —— 它只证明「引用存在的 id」，
不证明「存在的 id 被引用」（孤儿控件）或「写入的 pref 被消费」（死配置）。
翻译模块已经踩过一次（可选字段被 needsSecret 条件挡死、按钮反馈写到屏幕外）。

输出三类清单：
  [幽灵]  JS 引用了不存在的 id（运行期 getElementById=null，轻则无效、重则抛错）
  [孤儿]  xhtml 有 id、无 preference= 声明式绑定、且没有任何 JS 引用 → 点了大概率没反应
  [死配置] prefs.js 声明了默认值，但面板与代码都没有读取点
运行：python scripts/diag/audit-prefs.py   （只读，不改文件）
"""
import io, os, re, sys, json
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
XHTML = os.path.join(ROOT, "chrome", "content", "prefs.xhtml")
PREFS_JS_DIR = os.path.join(ROOT, "chrome", "content")
PREFS_DEF = os.path.join(ROOT, "prefs.js")
SCRIPTS_DIR = os.path.join(ROOT, "chrome", "content", "scripts")

# 动态 id（模板拼接）允许不命中
DYNAMIC = re.compile(r"\$\{|\+ *['\"]|['\"] *\+")

def read(p):
    return io.open(p, encoding="utf-8", errors="replace").read()

def strip_comments(s):
    s = re.sub(r"/\*[\s\S]*?\*/", " ", s)
    s = re.sub(r"(^|[^:])//[^\n]*", r"\1", s)  # 不剥 URL（http://）里的 //
    return s

# ---------- 1. prefs.xhtml 的控件 id 与声明式 pref 绑定 ----------
x = read(XHTML)
ids = re.findall(r'id="(pp-[A-Za-z0-9_-]+)"', x)
ids = sorted(set(ids))
decl = set(re.findall(r'preference="extensions\.zotero\.papilot\.([A-Za-z0-9_.-]+)"', x))
decl_ids = set(re.findall(r'<html:(?:input|select|textarea)[^>]*preference="[^"]+"[^>]*id="(pp-[A-Za-z0-9_-]+)"'
                          r'|<html:(?:input|select|textarea)[^>]*id="(pp-[A-Za-z0-9_-]+)"[^>]*preference="[^"]+"', x))
decl_ids = {a or b for a, b in decl_ids}

# 折叠/搜索/装饰性/容器类的 id（不是功能控件）
def is_decorative(i):
    if bool(re.match(r"pp-(fold-|cat-|search|prefs-search|wrap$|pane$)", i)) or i in ("pp-cat-list",):
        return True
    # 纯容器 div（进度轨道 / 布局锚点），真正的交互在里面那个 id 上
    if i in ("pp-cloud-track", "pp-vault-entry"):
        return True
    # 主题色选择器：prefs-theme.js 用 $("pp-ut-<名>-pick") 动态拼接 id，扫不到字面量
    if re.match(r"^pp-ut-[a-z]+-pick$", i):
        return True
    return False

# ---------- 2. 每个 prefs-*.js 引用的 id ----------
# 直接调用式引用（$()/bind()/getElementById）与「字符串字面量引用」分开统计：
# 后者很多是 {el:"pp-x"} 键映射，但也会把 CSS 类名（pp-chip 等）误当 id ——
# 所以幽灵判定只看直接引用，孤儿判定两类都算。
direct_refs = defaultdict(set)
literal_refs = defaultdict(set)
HOST_IDS = {"prefs-content", "prefs-window"}   # Zotero 官方宿主容器的 id（不是我们的 xhtml）

for f in sorted(os.listdir(PREFS_JS_DIR)):
    if not (f.startswith("prefs-") and f.endswith(".js")):
        continue
    src = strip_comments(read(os.path.join(PREFS_JS_DIR, f)))
    for m in re.finditer(r'\$\(\s*["\']([A-Za-z0-9_-]+)["\']\s*\)', src):
        direct_refs[m.group(1)].add(f)
    for m in re.finditer(r'bind\(\s*["\']([A-Za-z0-9_-]+)["\']', src):
        direct_refs[m.group(1)].add(f)
    for m in re.finditer(r'getElementById\(\s*["\']([A-Za-z0-9_-]+)["\']\s*\)', src):
        direct_refs[m.group(1)].add(f)
    # 字符串字面量形式的 id（键映射引用）
    for m in re.finditer(r'["\'](pp-[A-Za-z0-9_-]+)["\']', src):
        literal_refs[m.group(1)].add(f)

# ---------- 3. prefs.js 声明的全部默认 pref ----------
pd = read(PREFS_DEF)
declared = set(re.findall(r'pref\("extensions\.zotero\.papilot\.([A-Za-z0-9_.-]+)"', pd))

# 全部 JS 源码（消费方可能在任何脚本里）
all_src = ""
for dp, dn, fn in os.walk(os.path.join(ROOT, "chrome", "content")):
    if any(s in dp.replace("\\","/") for s in ("vendor", "pdfjs")): continue
    for f in fn:
        if f.endswith((".js", ".xhtml")):
            all_src += read(os.path.join(dp, f)) + "\n"

def pref_consumed(key):
    """pref 是否被任何代码读取/监听（Prefs.get / preference= / 全名常量）"""
    pat = re.escape(key)
    if re.search(r'Prefs\.(?:get|set|watch|observe)\s*\(\s*["\']' + pat, all_src): return True
    if re.search(r'["\']' + pat + r'["\']', all_src): return True
    # 全名引用（Zotero.Prefs.get("extensions.zotero.papilot.x") / 常量定义）
    if re.search(r'papilot\.' + pat + r'(?![A-Za-z0-9])', all_src): return True
    if key in decl: return True
    return False

# ---------- 输出 ----------
# 类名集合：pp-x 同时是 class 时，字面量引用不算"引用了一个 id"（那是样式）
cls = set()
for m in re.finditer(r'class="([^"]+)"', x):
    cls.update(m.group(1).split())

def referenced(i):
    if i in direct_refs:
        return True
    return i in literal_refs and i not in cls

# 幽灵：直接调用引用了不存在的 id（运行期必为 null）
ghosts = {i: fs for i, fs in direct_refs.items() if i not in set(ids) and i not in HOST_IDS}
# 孤儿：有 id、无声明式绑定、且两类引用都没有 → 点了大概率没反应
orphans = [i for i in ids if not referenced(i) and i not in decl_ids and not is_decorative(i)]
dead_prefs = [k for k in declared if not pref_consumed(k)]

print("== 控件统计 ==")
print("  xhtml id:", len(ids), "| 直接引用:", len(direct_refs),
      "| 字面量引用:", len(literal_refs), "| 声明式绑定 id:", len(decl_ids), "| pref 声明:", len(declared))
print()
print("== [幽灵] JS 引用但 xhtml 不存在（%d）==" % len(ghosts))
for i, fs in sorted(ghosts.items()):
    print("  %-40s ← %s" % (i, ", ".join(sorted(fs))))
print()
print("== [孤儿] xhtml 有 id 但无任何 JS 引用（%d，已排除声明式绑定与装饰性）==" % len(orphans))
for i in orphans:
    print("  " + i)
print()
print("== [死配置] prefs.js 声明但无任何读取点（%d）==" % len(dead_prefs))
for k in sorted(dead_prefs):
    print("  " + k)

# 结论用退出码（CI 可用）
sys.exit(0 if not ghosts and not dead_prefs else 1)
