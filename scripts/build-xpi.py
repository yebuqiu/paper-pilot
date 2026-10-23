# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.

import io, os, sys, zipfile, json, re, hashlib

# ★ 0.41.1：根路径改为**脚本自身位置推导**（原为写死的绝对路径）。
# 写死的后果：在 git worktree（并发期从干净树构建的常规手段）里执行本脚本，
# 实际打包的仍是主树 —— 会混入另一会话的在制品，且版本号取自主树 manifest
# （真机实踩：worktree 构建出的包里有主树的未提交新文件，版本也不是传入的那个）。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# ★ 0.73.0 模块化拆包开关（默认关闭）：
#   带 --modular 时，scripts/module-map.json 声明的文件改由 dist/modules/*.zip 分发，
#   主包只保留骨架 + chrome/content/modules/builtin-index.json（商店离线快照）。
#   不加该参数时，下面所有逻辑（含版本号取值）与历史版本逐字一致。
MODULAR = "--modular" in sys.argv[1:]
if MODULAR:
    sys.argv = [a for a in sys.argv if a != "--modular"]   # 版本号仍取第一个位置参数

VER = sys.argv[1] if len(sys.argv) > 1 else "0.18.1"
argv = sys.argv[1:]          # 供 --note / --no-update-json 判定
# --out：试打包/瘦身包验证时另存，避免覆盖已发布的同名 xpi（默认行为不变）
def _arg_value(flag):
    if flag in argv:
        i = argv.index(flag)
        if i + 1 < len(argv) and argv[i + 1].strip():
            return argv[i + 1].strip()
    return None
OUT = _arg_value("--out") or ("dist/papilot-%s.xpi" % VER)

TOP = ["bootstrap.js", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md", "prefs.js", "README.md", "README.en.md", "manifest.json"]

# ---------------------------------------------------------------------------
# WPS 加载项载荷（0.71.1）
#
# 设置面板里的「安装加载项」要能离线装，所以载荷必须进包。但**不能以目录形式进包**：
# 用户装的是 xpi（jar:），jar 里没有可枚举的目录、也拿不到 nsIFile，
# 桥接层没法"复制目录"。所以打成**一个文本 JSON**（rel 路径 → 文件内容），
# 桥接层用 fetch 读出来再逐个落盘（fetch 是 bootstrap 里唯一能读 jar 的通道，
# Zotero.File.getContentsAsync 对 jar: 会抛 NS_ERROR_FAILURE）。
#
# 单一真源仍是 wps-cite/（平时靠 python tools/install.py 直装），这里只做打包期快照。
# ---------------------------------------------------------------------------
_WPS_SRC = os.path.join(ROOT, "wps-cite", "addon")
_WPS_PROXY = os.path.join(ROOT, "wps-cite", "proxy", "proxy.py")
_WPS_BUNDLE = os.path.join(ROOT, "chrome", "content", "tools", "wps-cite.bundle.json")
_WPS_LEGACY_DIR = os.path.join(ROOT, "chrome", "content", "tools", "wps-cite")

if os.path.isdir(_WPS_SRC):
    import shutil
    if os.path.isdir(_WPS_LEGACY_DIR):
        shutil.rmtree(_WPS_LEGACY_DIR)          # 0.71.1 早期版本用目录形态，清掉
    _files = {}
    for _dp, _dn, _fn in os.walk(_WPS_SRC):
        for _f in sorted(_fn):
            _p = os.path.join(_dp, _f)
            _rel = os.path.relpath(_p, _WPS_SRC).replace(os.sep, "/")
            _files[_rel] = io.open(_p, encoding="utf-8").read()
    _ver_src = _files.get("version.js", "")
    _vm = re.search(r"PPC_VERSION\s*=\s*'([^']+)'", _ver_src)
    _pv = _vm.group(1) if _vm else "0.0.0"
    _proxy_src = io.open(_WPS_PROXY, encoding="utf-8").read() if os.path.exists(_WPS_PROXY) else ""
    _pm = re.search(r'PROXY_VERSION\s*=\s*"([0-9.]+)"', _proxy_src)
    _payload = {
        "version": _pv,
        "proxyVersion": _pm.group(1) if _pm else "",   # 桥接据此判断运行中的代理是否该重启
        "files": _files,
        "proxy": _proxy_src,
    }
    os.makedirs(os.path.dirname(_WPS_BUNDLE), exist_ok=True)
    io.open(_WPS_BUNDLE, "w", encoding="utf-8", newline="\n").write(
        json.dumps(_payload, ensure_ascii=False))
    print("WPS 载荷: %s（%s，%d 个文件，%d 字节）"
          % (os.path.relpath(_WPS_BUNDLE, ROOT), _pv, len(_files), os.path.getsize(_WPS_BUNDLE)))
else:
    print("WPS 载荷: 跳过（没有 wps-cite/ 目录）")

inc = [p for p in TOP if os.path.exists(p)]
for root in ["chrome", "locale"]:
    for dp, dn, fn in os.walk(root):
        for f in sorted(fn):
            p = os.path.join(dp, f).replace(os.sep, "/")
            inc.append(p)
inc.sort(key=lambda p: (p not in TOP, p))

# ---------------------------------------------------------------------------
# --modular：按 scripts/module-map.json 的显式清单剔除模块侧文件（0.73.0）
#
# 纪律：
#   · 清单里的路径一律相对 chrome/content/ 书写，这里拼成包内路径再比对；
#   · 声明了却不在待打包清单里的文件 = 清单与磁盘脱节，直接报错，不静默放过；
#   · builtin-index.json 是主包唯一保留的模块侧文件（商店离线快照），显式兜底收入。
# 不加 --modular 时本段整体跳过，inc 与历史版本完全一致。
# ---------------------------------------------------------------------------
_MOD_REPORT = []
if MODULAR:
    _map_path = os.path.join(ROOT, "scripts", "module-map.json")
    if not os.path.exists(_map_path):
        raise SystemExit("--modular 需要 scripts/module-map.json，但文件不存在")
    with open(_map_path, "r", encoding="utf-8") as _mf:
        _mod_map = json.load(_mf)
    _in_inc = set(inc)
    _excluded = set()
    for _m in _mod_map.get("modules", []):
        _mid = _m.get("id")
        _hits, _miss = [], []
        for _rel in _m.get("files", []):
            _p = "chrome/content/" + _rel
            (_hits if _p in _in_inc else _miss).append(_p)
        if _miss:
            raise SystemExit("模块 %s 声明的文件不在待打包清单里: %s" % (_mid, _miss[:5]))
        _excluded.update(_hits)
        _MOD_REPORT.append((_mid, len(_hits), sum(os.path.getsize(p) for p in _hits)))
    inc = [p for p in inc if p not in _excluded]
    _bi = "chrome/content/modules/builtin-index.json"
    if os.path.exists(_bi) and _bi not in inc:
        inc.append(_bi)
        inc.sort(key=lambda p: (p not in TOP, p))
    print("模块化拆包：排除 %d 个文件 / %d 字节，主包剩 %d 个条目"
          % (len(_excluded), sum(r[2] for r in _MOD_REPORT), len(inc)))

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

if MODULAR:
    _out_size = os.path.getsize(OUT)
    _src_size = sum(os.path.getsize(p) for p in inc)
    print("模块化主包：条目 %d 个，源 %d 字节，xpi %d 字节（%.2f MB）"
          % (len(inc), _src_size, _out_size, _out_size / 1024.0 / 1024.0))
    for _mid, _cnt, _size in _MOD_REPORT:
        print("  · %-24s 排除 %3d 个文件 %9d 字节" % (_mid, _cnt, _size))

# 自检
with zipfile.ZipFile(OUT) as z:
    got = sorted(n for n in z.namelist() if not n.endswith("/"))
    assert got == sorted(inc), "包内清单不一致"
    mf = json.loads(z.read("manifest.json").decode("utf-8"))
    print("manifest version =", mf["version"], "| 包内条目", len(got))

with open(OUT, "rb") as _f:
    print("sha256 =", hashlib.sha256(_f.read()).hexdigest())

# ---------------------------------------------------------------------------
# 体积趋势记录（0.73.2）
#
# 只在**正式主包构建**（非 --modular、非 --out 试打包）成功后写
# docs/audit/<版本>/size.json；与 render.json/render.md 同目录惯例。
# 上次同结构记录存在时，顺带打印一行 xpi 与总计（xpi + 组件 zip 合计）体积差。
# ---------------------------------------------------------------------------
def _ver_key(v):
    return tuple(int(x) if x.isdigit() else 0 for x in str(v).split("."))


if not MODULAR and not _arg_value("--out"):
    import datetime
    with zipfile.ZipFile(OUT) as _z:
        _entries = [i for i in _z.infolist() if not i.is_dir()]
        _unpacked = sum(i.file_size for i in _entries)

    # 组件 zip：id 取自 modules/*/module.json 与 bundles/*/module.json，
    # 只记录与本版同号的 dist/modules/<id>-<VER>.zip（忽略历史残留版本）
    _mods = []
    for _mdir in ("modules", "bundles"):
        _base = os.path.join(ROOT, _mdir)
        if not os.path.isdir(_base):
            continue
        for _d in sorted(os.listdir(_base)):
            if not os.path.exists(os.path.join(_base, _d, "module.json")):
                continue
            _zp = os.path.join(ROOT, "dist", "modules", "%s-%s.zip" % (_d, VER))
            if not os.path.exists(_zp):
                continue
            with zipfile.ZipFile(_zp) as _z:
                _fc = sum(1 for n in _z.namelist() if not n.endswith("/"))
            _mods.append({"id": _d, "zipBytes": os.path.getsize(_zp),
                          "fileCount": _fc})

    _report = {
        "version": VER,
        "xpiBytes": os.path.getsize(OUT),
        "unpackedBytes": _unpacked,
        "entryCount": len(_entries),
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "modules": _mods,
    }

    _prev = None
    _audit_root = os.path.join(ROOT, "docs", "audit")
    if os.path.isdir(_audit_root):
        for _d in sorted(os.listdir(_audit_root), key=_ver_key, reverse=True):
            if _d == VER:
                continue
            _p = os.path.join(_audit_root, _d, "size.json")
            if not os.path.exists(_p):
                continue
            try:
                _prev = json.load(io.open(_p, encoding="utf-8"))
            except Exception:
                _prev = None
            if _prev:
                break

    _audit_dir = os.path.join(_audit_root, VER)
    os.makedirs(_audit_dir, exist_ok=True)
    _size_path = os.path.join(_audit_dir, "size.json")
    io.open(_size_path, "w", encoding="utf-8", newline="\n").write(
        json.dumps(_report, ensure_ascii=False, indent=2) + "\n")
    print("✓ 体积记录：%s（xpi %d 字节 / 解压 %d 字节 / %d 个条目 / %d 个组件 zip）"
          % (os.path.relpath(_size_path, ROOT), _report["xpiBytes"],
             _unpacked, _report["entryCount"], len(_mods)))
    if _prev:
        _dx = _report["xpiBytes"] - int(_prev.get("xpiBytes") or 0)
        _t1 = _report["xpiBytes"] + sum(m["zipBytes"] for m in _mods)
        _t0 = (int(_prev.get("xpiBytes") or 0)
               + sum(int(m.get("zipBytes") or 0) for m in (_prev.get("modules") or [])))
        print("  与 %s 相比：xpi %+d 字节，总计 %+d 字节"
              % (_prev.get("version") or "?", _dx, _t1 - _t0))

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
