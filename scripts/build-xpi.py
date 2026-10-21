# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.

import os, sys, zipfile, json, re, hashlib

# ★ 0.41.1：根路径改为**脚本自身位置推导**（原为写死的绝对路径）。
# 写死的后果：在 git worktree（并发期从干净树构建的常规手段）里执行本脚本，
# 实际打包的仍是主树 —— 会混入另一会话的在制品，且版本号取自主树 manifest
# （真机实踩：worktree 构建出的包里有主树的未提交新文件，版本也不是传入的那个）。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
VER = sys.argv[1] if len(sys.argv) > 1 else "0.18.1"
argv = sys.argv[1:]          # 供 --note / --no-update-json 判定
OUT = "dist/papilot-%s.xpi" % VER

TOP = ["bootstrap.js", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md", "prefs.js", "README.md", "README.en.md", "manifest.json"]
inc = [p for p in TOP if os.path.exists(p)]
for root in ["chrome", "locale"]:
    for dp, dn, fn in os.walk(root):
        for f in sorted(fn):
            p = os.path.join(dp, f).replace(os.sep, "/")
            inc.append(p)
inc.sort(key=lambda p: (p not in TOP, p))

names = set(inc)
print("待打包 %d 个文件" % len(inc))
bad = [p for p in inc if not os.path.exists(p)]
if bad:
    raise SystemExit("源文件缺失: %s" % bad)

# ZIP_DEFLATED；xpi 需从根开始，目录项可省
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in inc:
        z.write(p, p)
print("已生成", OUT, os.path.getsize(OUT), "bytes")

# 自检
with zipfile.ZipFile(OUT) as z:
    got = sorted(n for n in z.namelist() if not n.endswith("/"))
    assert got == sorted(inc), "包内清单不一致"
    mf = json.loads(z.read("manifest.json").decode("utf-8"))
    print("manifest version =", mf["version"], "| 包内条目", len(got))

with open(OUT, "rb") as _f:
    print("sha256 =", hashlib.sha256(_f.read()).hexdigest())

# ---------------------------------------------------------------------------
# 更新清单自动 upsert（0.65.1）
#
# 背景：papilot-update.json 一直靠手工补条目，漏一次 = 老用户点「检查更新」永远拿不到新版
# （0.56 改名那次就吃过这个亏：旧清单最高只有 0.54.0，用户停更了两个版本）。
# 这里在打包成功后自动插入/刷新本版条目，并按版本倒序重排。
#
# 纪律：
#   · 只在「包内 manifest 版本 == 命令行版本」时才写清单 —— 否则那是试打包
#     （如 `preflight --with-build 0.25.0`），写进去会把更新通道指到不存在的产物。
#   · update_link 的仓库前缀从现有条目里取（已有约定，不硬编码第二份）。
#   · whatsNew 优先 --note，其次 docs/release-notes/<ver>.md，都没有就写占位并显式告警。
# ---------------------------------------------------------------------------
ADDON_ID = "papilot@dev.local"
UPD_JSON = os.path.join(ROOT, "papilot-update.json")


def _whats_new(ver, argv):
    if "--note" in argv:
        i = argv.index("--note")
        if i + 1 < len(argv) and argv[i + 1].strip():
            return argv[i + 1].strip()
    note_file = os.path.join(ROOT, "docs", "release-notes", "%s.md" % ver)
    if os.path.exists(note_file):
        with open(note_file, "r", encoding="utf-8") as f:
            txt = f.read().strip()
        if txt:
            # 发行说明是给人读的长文（Markdown），但 Zotero 更新卡片里只显示一小段。
            # 优先取显式摘要标记；否则取「第一个非标题、非列表的段落」压成一行。
            # 直接把整篇塞进去会让用户看到一堆 # 和 **（0.70.0 首跑踩过）。
            m = re.search(r"<!--\s*whatsNew\s*:\s*(.+?)\s*-->", txt, re.S)
            if m:
                return re.sub(r"\s+", " ", m.group(1)).strip()
            for para in re.split(r"\n\s*\n", txt):
                p = para.strip()
                if not p or p.startswith("#") or p.startswith("- ") or p.startswith("* "):
                    continue
                p = re.sub(r"[*_`]", "", p)
                return re.sub(r"\s+", " ", p).strip()[:300]
            return re.sub(r"\s+", " ", txt.splitlines()[0]).strip()[:300]
    print("!! 没有 --note，也没有 docs/release-notes/%s.md —— whatsNew 写成占位文案" % ver)
    return "本版更新见发行说明（docs/release-notes/%s.md 未提供）" % ver


if "--no-update-json" in argv:
    print("· 已跳过更新清单（--no-update-json）")
elif mf["version"] != VER:
    print("!! 包内版本 %s 与命令行版本 %s 不一致 —— 视为试打包，**不写**更新清单"
          % (mf["version"], VER))
elif not os.path.exists(UPD_JSON):
    print("!! 找不到 papilot-update.json —— 跳过更新清单同步")
else:
    with open(UPD_JSON, "r", encoding="utf-8") as f:
        upd = json.load(f)
    lst = (((upd.get("addons") or {}).get(ADDON_ID) or {}).get("updates") or [])
    if not lst:
        raise SystemExit("papilot-update.json 里没有 %s 的 updates 列表" % ADDON_ID)

    # 仓库前缀沿用现有条目的写法（只替换版本号与文件名）
    base_link = re.sub(r"papilot-[0-9.]+\.xpi", "papilot-%s.xpi" % VER,
                       lst[0].get("update_link") or "")
    if not base_link:
        raise SystemExit("现有条目缺少 update_link，无法推导本版下载地址")

    apps = lst[0].get("applications") or {"zotero": {"strict_min_version": "6.999",
                                                     "strict_max_version": "99.*"}}
    entry = {"version": VER, "update_link": base_link, "applications": apps,
             "whatsNew": _whats_new(VER, argv)}

    lst = [u for u in lst if u.get("version") != VER]
    lst.append(entry)
    lst.sort(key=lambda u: tuple(int(x) for x in str(u.get("version", "0")).split(".")
                                 if x.isdigit()), reverse=True)
    upd.setdefault("addons", {}).setdefault(ADDON_ID, {})["updates"] = lst
    with open(UPD_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(upd, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("✓ 更新清单已同步：%s（%d 条，最新 %s）" % (UPD_JSON, len(lst), lst[0]["version"]))
