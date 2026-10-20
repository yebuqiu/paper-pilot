# -*- coding: utf-8 -*-
"""版本单源同步：manifest.json / 服务端头注释 → 文档里硬编码的版本号。

为什么要有它：文档里的版本号是**手工抄的**，已经漂过两次 ——
AGENTS.md 停在 0.58.0（实际 0.65.0）、服务端写 1.8.1（实际 1.9.0）、README badge 停在 0.63.0。
接手的人/代理按文档判断能力边界会直接误判。

单一真源：
  · 插件版本 = manifest.json 的 version
  · 服务端版本 = account-server.js 顶部注释里出现的**最高** semver
    （该文件每批改动都在头注释标注「xxx（1.9.0）：…」，实测比任何常量都及时）

用法：
  python scripts/sync-docs-version.py           # 就地改写（打印每处 diff）
  python scripts/sync-docs-version.py --check   # 只检查，有漂移则 exit 1（preflight 用）
"""
import io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = "--check" in sys.argv

MANIFEST = os.path.join(ROOT, "manifest.json")
SERVER = os.path.join(ROOT, "server", "account-server.js")


def read(p):
    return io.open(p, encoding="utf-8").read()


def write(p, s):
    # 统一 LF：仓库 core.autocrlf=true，工作区用 LF 不会产生噪声 diff
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


def plugin_version():
    m = re.search(r'"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+)"', read(MANIFEST))
    if not m:
        sys.exit("manifest.json 里找不到 version")
    return m.group(1)


def server_version():
    head = "\n".join(read(SERVER).splitlines()[:80])
    vs = re.findall(r"\b(\d+\.\d+\.\d+)\b", head)
    if not vs:
        sys.exit("account-server.js 头注释里找不到版本号（如「（1.9.0）：」）")
    best = max(vs, key=lambda v: tuple(int(x) for x in v.split(".")))
    return best


# (文件, 正则, 替换模板)。模板里 {v} = 目标版本。
RULES = [
    # AGENTS.md：插件版本行 / 服务端版本行（按上下文分别匹配，避免两行互相顶替）
    ("AGENTS.md", r"(manifest\.json`\s*的\s*`version`（当前 `)([0-9]+\.[0-9]+\.[0-9]+)(`）)", "{v}"),
    ("AGENTS.md", r"(account-server\.js`\s*头注释的服务端版本（当前 `)([0-9]+\.[0-9]+\.[0-9]+)(`）)", "@server"),
    # README badge（中英两份都可能用到）
    ("README.md", r"(shields\.io/badge/version-)([0-9]+\.[0-9]+\.[0-9]+)(-blue)", "{v}"),
    ("README.en.md", r"(shields\.io/badge/version-)([0-9]+\.[0-9]+\.[0-9]+)(-blue)", "{v}"),
]

# ★ 同一文件可能命中多条规则（AGENTS.md 同时写插件版与服务端版）——
#   必须**累积**到同一份内容再写一次，否则后一条规则会用原始串覆盖前一条的结果。
dirty, missing = {}, []
before = {}
for rel, pat, tpl in RULES:
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        missing.append(rel)
        continue
    if rel not in dirty:
        dirty[rel] = read(p)
        before[rel] = dirty[rel]
    want = server_version() if tpl == "@server" else plugin_version()
    hits = []

    def repl(m, _want=want, _hits=hits):
        old = m.group(2)
        if old != _want:
            _hits.append((old, _want))
        return m.group(1) + _want + m.group(3)

    dirty[rel] = re.sub(pat, repl, dirty[rel])
    for old, new in hits:
        print("~ %-12s %s → %s" % (rel, old, new))

changed = [(rel, txt) for rel, txt in dirty.items() if txt != before[rel]]

if missing:
    print("· 跳过不存在的文件：%s" % ", ".join(missing))

if CHECK:
    if changed:
        print("\n✗ 文档版本与真源不一致：%d 个文件需要同步" % len(changed))
        print("  修复：python scripts/sync-docs-version.py")
        sys.exit(1)
    print("✓ 文档版本一致（插件 %s / 服务端 %s）" % (plugin_version(), server_version()))
    sys.exit(0)

for rel, s in changed:
    write(os.path.join(ROOT, rel), s)
if changed:
    print("\n✓ 已同步 %d 个文件（插件 %s / 服务端 %s）"
          % (len(changed), plugin_version(), server_version()))
else:
    print("✓ 无需改动（插件 %s / 服务端 %s）" % (plugin_version(), server_version()))
