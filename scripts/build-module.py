#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot 模块包构建工具（零依赖，仅标准库）。

职责：
  · 依据 scripts/module-map.json 的**显式文件清单**，为 9 个模块生成
    modules/<id>/module.json（含每个文件 sha256/size）；
  · 汇总生成 chrome/content/modules/builtin-index.json（组件商店内置目录快照）；
  · 打包 dist/modules/<id>-<version>.zip（文件置于 zip 根，附 module.json）。

设计纪律：
  · 清单在 module-map.json 里逐条固定，构建期**不再展开 glob**，保证可复现；
  · 任一清单文件缺失立刻报错退出，绝不静默跳过（否则会打出"少文件但不报错"的包）；
  · zip 用固定时间戳 + 固定条目顺序，同样输入产出同样字节。

用法：
  python scripts/build-module.py --list                # 列出模块与文件数/体积
  python scripts/build-module.py --all                 # 生成清单 + 索引 + zip
  python scripts/build-module.py --all --no-zip        # 只写清单与索引
  python scripts/build-module.py --check               # 校验 manifest 与磁盘一致
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# ROOT 由脚本位置推导（scripts/ 的上一级），不写死盘符
ROOT = Path(__file__).resolve().parent.parent
MAP_FILE = ROOT / "scripts" / "module-map.json"
MODULES_DIR = ROOT / "modules"
DIST_DIR = ROOT / "dist" / "modules"
INDEX_FILE = ROOT / "chrome" / "content" / "modules" / "builtin-index.json"
CONTENT_DIR = ROOT / "chrome" / "content"

# zip 内固定时间戳：不同机器/时区打出的包字节一致
ZIP_DATE_TIME = (2020, 1, 1, 0, 0, 0)
ZIP_COMPRESS_LEVEL = 9

# 既有 scope 组件白名单：这 9 个模块 + 1 个合集从主包拆出，沿用 scope 加载。
# module-map.json 中**不在**此清单里的新模块必须显式写 "mode": "sandbox"，
# 否则构建报错退出（合集 bundle 不受限——它只是记账，不加载代码）。
# 注意：module-map.json 是 JSON 不能写注释，本说明以这里与构建报错文案为准。
LEGACY_SCOPE_IDS = frozenset([
    "papilot-mod-pdf",
    "papilot-mod-ai",
    "papilot-mod-cnki",
    "papilot-mod-discovery",
    "papilot-mod-notes",
    "papilot-mod-meta",
    "papilot-mod-cite",
    "papilot-mod-sync",
    "papilot-mod-ui",
    "papilot-bundle-basic",
])

# 与 loader validateManifest 同步的清单 schema 扩展（0.73.2）：
#   requires    —— 能力声明，只允许已知能力名；ai 计划中暂不接受
#   permissions —— 权限声明，白名单之外即非法
KNOWN_CAPABILITIES = frozenset(["storage", "events", "ui", "prefs", "ai"])
PLANNED_CAPABILITIES = frozenset(["ai"])
KNOWN_PERMISSIONS = frozenset(["storage", "network", "ai", "prefs", "filesystem", "ui"])
# 宿主 API v1 实际提供的能力（ai 计划中，不在内）
HOST_CAPABILITIES_V1 = frozenset(["storage", "events", "ui", "prefs"])


def die(msg):
    """统一的中文错误出口：打印到 stderr 并以 1 退出。"""
    print("错误：%s" % msg, file=sys.stderr)
    raise SystemExit(1)


def human(nbytes):
    """把字节数转成人读的单位。"""
    if nbytes < 1024:
        return "%d B" % nbytes
    if nbytes < 1024 * 1024:
        return "%.1f KB" % (nbytes / 1024.0)
    return "%.2f MB" % (nbytes / (1024.0 * 1024.0))


def validate_decl(mod):
    """校验模块声明的 mode / requires / permissions（与 loader validateManifest 同步）。

    · mode：可选，只接受 scope/sandbox；非 LEGACY_SCOPE_IDS 的新模块必须显式 sandbox；
    · requires：可选数组，只允许 KNOWN_CAPABILITIES，且 ai（计划中）暂不接受；
    · permissions：可选数组，只允许 KNOWN_PERMISSIONS。
    """
    mid = mod.get("id") or ""
    mode = mod.get("mode")
    if mode is not None and mode not in ("scope", "sandbox"):
        die("模块 %s 的 mode 非法：%r（只接受 scope/sandbox）" % (mid, mode))
    if mid not in LEGACY_SCOPE_IDS and mode != "sandbox":
        die("模块 %s 不在 LEGACY_SCOPE_IDS 白名单内，新组件必须显式 \"mode\": \"sandbox\""
            "（module-map.json 是 JSON 无法注释，规则见 build-module.py 顶部 LEGACY_SCOPE_IDS 说明）"
            % mid)
    req = mod.get("requires")
    if req is not None:
        if not isinstance(req, list):
            die("模块 %s 的 requires 必须是数组" % mid)
        for cap in req:
            if not isinstance(cap, str) or cap not in KNOWN_CAPABILITIES:
                die("模块 %s 的 requires 含未知能力：%r" % (mid, cap))
            if cap in PLANNED_CAPABILITIES:
                die("模块 %s 要求的能力 %r 尚在计划中，宿主暂不提供" % (mid, cap))
            if cap not in HOST_CAPABILITIES_V1:
                die("模块 %s 要求的能力 %r 超出宿主 API v1 提供范围" % (mid, cap))
    perm = mod.get("permissions")
    if perm is not None:
        if not isinstance(perm, list):
            die("模块 %s 的 permissions 必须是数组" % mid)
        for p in perm:
            if not isinstance(p, str) or p not in KNOWN_PERMISSIONS:
                die("模块 %s 的 permissions 含未知权限：%r" % (mid, p))
    if mode == "sandbox" and not mod.get("entry"):
        die("模块 %s 为 sandbox 模式，必须声明 entry" % mid)


def load_map():
    """读取并做结构校验；任何不合契约的地方都显式报错。"""
    if not MAP_FILE.is_file():
        die("找不到模块清单 %s" % MAP_FILE.relative_to(ROOT))
    with open(MAP_FILE, "r", encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("schema") != 1:
        die("module-map.json 的 schema 不是 1")
    mods = doc.get("modules")
    if not isinstance(mods, list) or not mods:
        die("module-map.json 的 modules 为空")
    seen_ids = set()
    seen_files = {}
    for mod in mods:
        mid = mod.get("id") or ""
        if not mid.startswith("papilot-mod-"):
            die("模块 id 不合规：%r" % mid)
        if mid in seen_ids:
            die("模块 id 重复：%s" % mid)
        seen_ids.add(mid)
        validate_decl(mod)
        files = mod.get("files")
        if not isinstance(files, list) or not files:
            die("模块 %s 的文件清单为空" % mid)
        for rel in files:
            # 只接受 chrome/content 下的相对路径，禁止逃逸
            if rel.startswith("/") or ".." in rel.replace("\\", "/").split("/"):
                die("模块 %s 含非法路径：%r" % (mid, rel))
            if rel in seen_files:
                die("文件被多个模块声明：%s（%s 与 %s）" % (rel, seen_files[rel], mid))
            seen_files[rel] = mid
    return doc


def content_file(rel):
    """把 content 相对路径映射到磁盘文件；不存在就报错（不静默跳过）。"""
    path = CONTENT_DIR / rel
    if not path.is_file():
        die("清单文件不存在：chrome/content/%s（模块清单与磁盘不一致）" % rel)
    return path


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


GLOBAL_RE = re.compile(r"^(?:var|const|let)\s+([A-Z][A-Za-z0-9_]*)\s*=", re.M)


def main_js_order():
    """主包 main.js 里 files 数组的权威加载顺序（chrome/content/scripts/ 相对路径）。

    模块文件的加载顺序必须跟它一致——主包顺序是手排的依赖序（如 translate-lang
    必须在 translate-engines 之前）。模块清单若按字母序加载，消费者会拿到占位桩。
    """
    main_js = (ROOT / "chrome" / "content" / "scripts" / "main.js").read_text(encoding="utf-8")
    m = re.search(r"const files = \[(.*?)\];", main_js, re.S)
    if not m:
        return {}
    order = {}
    for i, name in enumerate(re.findall(r'"([a-zA-Z0-9_\-./]+\.js)"', m.group(1))):
        order[name] = i
    return order


def sort_files_by_main(mod, order):
    """模块 files 按主包顺序排；不在主包清单里的（窗口脚本等）保持原顺序排尾。"""
    files = list(mod["files"])
    files.sort(key=lambda f: (order.get(f.replace("scripts/", "", 1)
                                       if f.startswith("scripts/") else f, 1 << 30), f))
    return files


def collect_globals(mod):
    """从模块源文件里提取顶层全局名（用于瘦身包的「缺组件占位」）。

    只认 `var|const|let X =` 且首字母大写的定义 —— 与仓库「模块挂全局对象」的
    既有约定一致；不追求完备，漏掉的名字最多让那一个入口在未安装时报错。
    """
    names = []
    for rel in mod["files"]:
        path = content_file(rel)
        if path.suffix != ".js":
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in GLOBAL_RE.finditer(text):
            name = m.group(1)
            if name not in names:
                names.append(name)
    return names


def globals_js(doc):
    """生成 chrome/content/scripts/modules-globals.js（随主包分发，供 loader 装桩）。"""
    arr = [{"id": m["id"], "globals": collect_globals(m),
            "name": m.get("name", m["id"])} for m in doc["modules"]]
    header = ("// 生成物：由 scripts/build-module.py --all 自动生成，请勿手改。\n"
              "// 用途：瘦身包缺少组件时，为这些全局装惰性占位，避免 init 里裸引用 ReferenceError。\n")
    return header + "var ModuleGlobals = " + json.dumps(arr, ensure_ascii=False, indent=2) + ";\n"


def write_globals(doc):
    target = ROOT / "chrome" / "content" / "scripts" / "modules-globals.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    text = globals_js(doc)
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    total = text.count('"globals"') and sum(
        len(collect_globals(m)) for m in doc["modules"])
    print("全局占位 %-54s %d 个名字" % (str(target.relative_to(ROOT)), total))
    return target


def build_manifest(mod):
    """按契约生成单个模块的 module.json 结构。"""
    entries = []
    for rel in mod["files"]:    # 注：顺序在 cmd_all 已按主包次序排好
        path = content_file(rel)
        entries.append({
            "path": rel,
            "sha256": sha256_of(path),
            "size": path.stat().st_size,
        })
    return {
        "id": mod["id"],
        "name": mod["name"],
        "version": mod["version"],
        "minHost": mod["hostMin"],
        "apiVersion": 1,
        "description": mod["description"],
        "entry": mod.get("entry", ""),
        "mode": mod.get("mode", "scope"),
        "order": mod["order"],
        "provides": list(mod["provides"]),
        "depends": list(mod["depends"]),
        "requires": list(mod.get("requires") or []),
        "permissions": list(mod.get("permissions") or []),
        "whatsNew": mod["whatsNew"],
        "repo": {"github": mod["repo"]["github"], "gitee": mod["repo"]["gitee"]},
        "globals": collect_globals(mod),
        "files": entries,
    }


def manifest_bytes(manifest):
    """序列化成 UTF-8 字节（缩进 2，保留中文）。"""
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    return text.encode("utf-8")


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def zip_bytes(mod, manifest_blob):
    """在内存里压出模块 zip（条目在根，module.json 打头）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED,
                         compresslevel=ZIP_COMPRESS_LEVEL) as zf:
        info = zipfile.ZipInfo("module.json", date_time=ZIP_DATE_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(info, manifest_blob)
        for rel in mod["files"]:
            info = zipfile.ZipInfo(rel, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, content_file(rel).read_bytes())
    return buf.getvalue()


BUNDLES_DIR = ROOT / "bundles"


def bundle_manifest(bundle, mods_by_id, doc):
    """合集清单：bundle.json（落盘名仍叫 module.json，靠 bundle:true 区分）。"""
    return {
        "id": bundle["id"],
        "name": bundle["name"],
        "version": doc["version"],
        "minHost": doc["hostMin"],
        "apiVersion": 1,
        "description": bundle["description"],
        "bundle": True,
        "modules": list(bundle["modules"]),
        "entry": "",
        "mode": "scope",
        "whatsNew": bundle.get("whatsNew") or "常用组件合集：%s" % "、".join(
            mods_by_id[m]["name"] for m in bundle["modules"]),
        "repo": {"github": doc["modules"][0]["repo"]["github"],
                 "gitee": doc["modules"][0]["repo"]["gitee"]},
        "files": [],
    }


def bundle_zip_bytes(bundle, mods_by_id, manifest_blobs, bman_blob):
    """合集 zip：bundle.json 打头，其后每模块 <id>/module.json + <id>/<文件>。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED,
                         compresslevel=ZIP_COMPRESS_LEVEL) as zf:
        info = zipfile.ZipInfo("bundle.json", date_time=ZIP_DATE_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(info, bman_blob)
        for mid in bundle["modules"]:
            mod = mods_by_id[mid]
            info = zipfile.ZipInfo("%s/module.json" % mid, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, manifest_blobs[mid])
            for rel in mod["files"]:
                info = zipfile.ZipInfo("%s/%s" % (mid, rel), date_time=ZIP_DATE_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, content_file(rel).read_bytes())
    return buf.getvalue()


def module_stats(mod):
    """返回（文件数、解压总字节）。"""
    total = 0
    for rel in mod["files"]:
        total += content_file(rel).stat().st_size
    return len(mod["files"]), total


def build_index(doc, manifest_blobs, zip_sizes, bundle_meta=None, zip_hashes=None):
    """生成内置目录快照；sizeBytes 取实际 zip 字节数。"""
    version = doc["version"]
    host_min = doc["hostMin"]
    out_modules = []
    for mod in doc["modules"]:
        mid = mod["id"]
        gh = mod["repo"]["github"].rstrip("/")
        ge = mod["repo"]["gitee"].rstrip("/")
        zip_name = "%s-%s.zip" % (mid, version)
        out_modules.append({
            "id": mid,
            "name": mod["name"],
            "version": version,
            "description": mod["description"],
            "sizeBytes": zip_sizes[mid],
            "zipSha256": (zip_hashes or {}).get(mid, ""),
            "fileCount": len(mod["files"]),
            "download": {
                "github": "%s/releases/download/v%s/%s" % (gh, version, zip_name),
                "gitee": "%s/releases/download/v%s/%s" % (ge, version, zip_name),
            },
            "manifest": {
                "github": "%s/raw/main/modules/%s/module.json" % (gh, mid),
                "gitee": "%s/raw/main/modules/%s/module.json" % (ge, mid),
            },
            "tags": list(mod["tags"]),
            "mode": mod.get("mode", "scope"),
            "requires": list(mod.get("requires") or []),
            "permissions": list(mod.get("permissions") or []),
            "recommended": bool(mod["recommended"]),
            "pro": bool(mod["pro"]),
            "hot": bool(mod["hot"]),
        })
    for b in (bundle_meta or []):
        bundle = b["bundle"]
        bid = bundle["id"]
        zip_name = "%s-%s.zip" % (bid, version)
        gh = doc["modules"][0]["repo"]["github"].rstrip("/")
        ge = doc["modules"][0]["repo"]["gitee"].rstrip("/")
        out_modules.insert(0, {
            "id": bid,
            "name": bundle["name"],
            "version": version,
            "description": bundle["description"],
            "sizeBytes": zip_sizes[bid],
            "zipSha256": (zip_hashes or {}).get(bid, ""),
            "fileCount": sum(len(b["mods_by_id"][m]["files"]) for m in bundle["modules"]),
            "bundle": True,
            "contains": list(bundle["modules"]),
            "download": {
                "github": "%s/releases/download/v%s/%s" % (gh, version, zip_name),
                "gitee": "%s/releases/download/v%s/%s" % (ge, version, zip_name),
            },
            "manifest": {
                "github": "%s/raw/main/bundles/%s/module.json" % (gh, bid),
                "gitee": "%s/raw/main/bundles/%s/module.json" % (ge, bid),
            },
            "tags": list(bundle.get("tags") or ["合集"]),
            "recommended": bool(bundle.get("recommended")),
            "pro": False,
            "hot": False,
        })
    return {
        "schema": 1,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hostMin": host_min,
        "modules": out_modules,
    }


def cmd_list(doc):
    print("模块清单（来源 scripts/module-map.json，共 %d 个）" % len(doc["modules"]))
    print("%-24s %6s %12s %12s  %s" % ("ID", "文件数", "解压", "zip", "清单/包"))
    total_files = 0
    total_raw = 0
    total_zip = 0
    for mod in doc["modules"]:
        count, raw = module_stats(mod)
        mid = mod["id"]
        zip_path = DIST_DIR / ("%s-%s.zip" % (mid, doc["version"]))
        mf_path = MODULES_DIR / mid / "module.json"
        marks = []
        marks.append("清单✓" if mf_path.is_file() else "清单—")
        if zip_path.is_file():
            zsize = zip_path.stat().st_size
            marks.append("包✓")
            total_zip += zsize
        else:
            zsize = 0
            marks.append("包—")
        total_files += count
        total_raw += raw
        print("%-24s %6d %12s %12s  %s"
              % (mid, count, human(raw), human(zsize) if zsize else "-", " ".join(marks)))
    print("-" * 78)
    print("合计 %d 个文件 · 解压 %s · zip %s（已存在的包）"
          % (total_files, human(total_raw), human(total_zip)))


def cmd_all(doc, no_zip):
    version = doc["version"]
    MODULES_DIR.mkdir(parents=True, exist_ok=True)
    order = main_js_order()
    if order:
        for mod in doc["modules"]:
            mod["files"] = sort_files_by_main(mod, order)
        print("按主包 main.js 权威顺序重排模块文件（%d 个锚点）" % len(order))
    manifest_blobs = {}
    zip_sizes = {}
    zip_hashes = {}

    # 第一遍：写 module.json，一切校验在此之前完成
    for mod in doc["modules"]:
        manifest = build_manifest(mod)
        blob = manifest_bytes(manifest)
        manifest_blobs[mod["id"]] = blob
        target = MODULES_DIR / mod["id"] / "module.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "wb") as f:
            f.write(blob)
        print("清单 %-54s %2d 个文件" % (str(target.relative_to(ROOT)), len(manifest["files"])))

    # 第二遍：打包（--no-zip 时只在内存压缩，用于索引里的真实体积）
    print("-" * 78)
    for mod in doc["modules"]:
        mid = mod["id"]
        blob = zip_bytes(mod, manifest_blobs[mid])
        zip_sizes[mid] = len(blob)
        zip_hashes[mid] = hashlib.sha256(blob).hexdigest()
        out = DIST_DIR / ("%s-%s.zip" % (mid, version))
        if no_zip:
            print("跳过打包 %-32s 预计 %s" % (out.name, human(len(blob))))
            continue
        DIST_DIR.mkdir(parents=True, exist_ok=True)
        with open(out, "wb") as f:
            f.write(blob)
        _, raw = module_stats(mod)
        print("打包 %-32s 解压 %10s → zip %10s" % (out.name, human(raw), human(len(blob))))

    # 索引最后写：sizeBytes 必须来自上面算出的真实 zip 体积
    # 合集（合集打包在模块之后：manifest_blobs 已齐）
    mods_by_id = {m["id"]: m for m in doc["modules"]}
    bundle_meta = []
    for bundle in doc.get("bundles") or []:
        for mid in bundle["modules"]:
            if mid not in mods_by_id:
                die("合集 %s 引用未知模块 %s" % (bundle["id"], mid))
        bman = bundle_manifest(bundle, mods_by_id, doc)
        blob = manifest_bytes(bman)
        BUNDLES_DIR.mkdir(parents=True, exist_ok=True)
        bdir = BUNDLES_DIR / bundle["id"]
        bdir.mkdir(parents=True, exist_ok=True)
        with open(bdir / "module.json", "wb") as f:
            f.write(blob)
        zbytes = bundle_zip_bytes(bundle, mods_by_id, manifest_blobs, blob)
        zip_sizes[bundle["id"]] = len(zbytes)
        zip_hashes[bundle["id"]] = hashlib.sha256(zbytes).hexdigest()
        bundle_meta.append({"bundle": bundle, "mods_by_id": mods_by_id})
        if not no_zip:
            out = DIST_DIR / ("%s-%s.zip" % (bundle["id"], version))
            with open(out, "wb") as f:
                f.write(zbytes)
            print("合集 %-32s %2d 模块 → zip %10s"
                  % (out.name, len(bundle["modules"]), human(len(zbytes))))

    write_globals(doc)
    index = build_index(doc, manifest_blobs, zip_sizes, bundle_meta, zip_hashes)
    write_json(INDEX_FILE, index)
    print("-" * 78)
    print("索引 %s（%d 个模块，hostMin %s）"
          % (str(INDEX_FILE.relative_to(ROOT)), len(index["modules"]), index["hostMin"]))
    # Ed25519 签名：私钥不进 git（_brain/keys/）；缺私钥时索引保持未签名并明示
    import subprocess as _sp
    _node = os.environ.get("PP_NODE") or "node"
    try:
        r = _sp.run([_node, str(ROOT / "scripts" / "sign-modules-index.js"), str(INDEX_FILE)],
                    capture_output=True, text=True, timeout=60)
        out = (r.stdout or "").strip() + (r.stderr or "").strip()
        print("签名:", out or ("exit=%s" % r.returncode))
    except (OSError, _sp.SubprocessError) as e:
        print("签名: 跳过（%s）" % e)
    if no_zip:
        print("注意：--no-zip 未写 dist/modules/*.zip，索引体积按内存压缩结果计算")


def cmd_check(doc):
    """校验 modules/*/module.json 的文件清单、sha256、size 与磁盘是否一致。"""
    errors = []
    version = doc["version"]
    print("校验模块清单（%d 个模块，版本 %s）" % (len(doc["modules"]), version))
    for mod in doc["modules"]:
        mid = mod["id"]
        mf_path = MODULES_DIR / mid / "module.json"
        if not mf_path.is_file():
            errors.append("缺少清单：%s" % mf_path.relative_to(ROOT))
            continue
        with open(mf_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        if manifest.get("id") != mid:
            errors.append("%s: manifest id 为 %r" % (mid, manifest.get("id")))
        if manifest.get("version") != version:
            errors.append("%s: 版本 %r != %r" % (mid, manifest.get("version"), version))
        listed = [item.get("path") for item in manifest.get("files", [])]
        if sorted(listed) != sorted(mod["files"]):
            missing = sorted(set(mod["files"]) - set(listed))
            extra = sorted(set(listed) - set(mod["files"]))
            if missing:
                errors.append("%s: 清单缺文件 %s" % (mid, ", ".join(missing[:5])))
            if extra:
                errors.append("%s: 清单多文件 %s" % (mid, ", ".join(extra[:5])))
        bad = []
        for item in manifest.get("files", []):
            rel = item.get("path", "")
            path = CONTENT_DIR / rel
            if not path.is_file():
                bad.append("缺文件 %s" % rel)
                continue
            size = path.stat().st_size
            if item.get("size") != size:
                bad.append("%s 体积 %s != 磁盘 %d" % (rel, item.get("size"), size))
                continue
            digest = sha256_of(path)
            if item.get("sha256") != digest:
                bad.append("%s sha256 不匹配" % rel)
        if bad:
            errors.extend(["%s: %s" % (mid, msg) for msg in bad])
        else:
            print("  ✓ %-24s %2d 个文件一致" % (mid, len(listed)))

    if errors:
        print("-" * 78)
        for msg in errors:
            print("✗ %s" % msg, file=sys.stderr)
        die("共 %d 处不一致" % len(errors))
    gpath = ROOT / "chrome" / "content" / "scripts" / "modules-globals.js"
    expect = globals_js(doc)
    actual = gpath.read_text(encoding="utf-8") if gpath.is_file() else ""
    if actual != expect:
        die("modules-globals.js 与模块清单不同步（跑 --all 重建）")
    print("-" * 78)
    print("✓ 全部 %d 个模块的 sha256/size 与磁盘一致；全局占位文件同步" % len(doc["modules"]))


def prepare(doc):
    """把顶层元数据下发到每个模块，避免 module.json 里重复抄写。"""
    for mod in doc["modules"]:
        mod.setdefault("version", doc["version"])
        mod.setdefault("hostMin", doc["hostMin"])
        mod.setdefault("whatsNew", "从主包拆出，功能与 %s 一致" % doc["version"])
        for key in ("name", "description", "order", "provides", "depends", "tags",
                    "repo", "recommended", "pro", "hot", "files"):
            if key not in mod:
                die("模块 %s 缺少字段 %s" % (mod.get("id"), key))


def main():
    parser = argparse.ArgumentParser(
        description="Papilot 模块包构建工具（清单 / 索引 / zip）")
    parser.add_argument("--list", action="store_true", help="列出 9 个模块及文件数/体积")
    parser.add_argument("--all", action="store_true", help="生成 module.json、builtin-index 与 zip")
    parser.add_argument("--no-zip", action="store_true", help="配合 --all：只写清单，不写 zip")
    parser.add_argument("--check", action="store_true", help="校验 manifest 与磁盘一致")
    args = parser.parse_args()

    actions = [name for name in ("list", "all", "check") if getattr(args, name)]
    if len(actions) != 1:
        parser.print_help()
        raise SystemExit(2)
    if args.no_zip and not args.all:
        die("--no-zip 只能与 --all 一起使用")

    doc = load_map()
    # 版本口径单一真源：默认跟 manifest.json 走，避免「模块 minHost 0.73.0 但宿主
    # 还是 0.72.4」这种全量安装被拒的漂移。需要钉死时在 module-map.json 写死具体版本。
    host_version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    if str(doc.get("version", "auto")).lower() == "auto":
        doc["version"] = host_version
    if str(doc.get("hostMin", "auto")).lower() == "auto":
        doc["hostMin"] = host_version
    prepare(doc)

    if args.list:
        cmd_list(doc)
    elif args.all:
        cmd_all(doc, args.no_zip)
    else:
        cmd_check(doc)


if __name__ == "__main__":
    main()
