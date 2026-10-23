#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot 组件目录发布工具（零依赖，仅标准库）。

托管方案（2026-10-22 定案）：**不另建仓库**。
  · 目录 `papilot-modules-index.json` 放在主仓根，随每次发版提交；
  · 9 个组件 zip 作为同一个 GitHub/Gitee Release（tag v<版本>）的附件；
  · 客户端 module-store.js 内置两条 raw 地址（GitHub → Gitee 兜底）。
理由：9 个独立仓库 = 9 份源码副本 + 9 套 Release 维护，收益不抵成本；
组件源码真源仍在主仓 modules/ 清单 + chrome/content 源文件。

用法：
  python scripts/publish-modules.py            # dry-run：只校验 + 打印
  python scripts/publish-modules.py --stage     # 写 papilot-modules-index.json + build/modules-publish/dist
  python scripts/publish-modules.py --verify    # 只校验清单与 zip 一致
"""

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULES_DIR = ROOT / "modules"
ZIP_DIR = ROOT / "dist" / "modules"
INDEX_FILE = ROOT / "papilot-modules-index.json"
STAGE_DIR = ROOT / "build" / "modules-publish" / "dist"

GH = "https://github.com/yebuqiu/zotero-papilot"
GE = "https://gitee.com/cassiuschen9261/zotero-papilot"


def die(msg):
    print("✗ " + msg, file=sys.stderr)
    raise SystemExit(1)


def load_bundles():
    out = []
    bdir = ROOT / "bundles"
    if bdir.is_dir():
        for d in sorted(bdir.iterdir()):
            mf = d / "module.json"
            if mf.is_file():
                out.append(json.loads(mf.read_text(encoding="utf-8")))
    return out


def load_modules():
    if not MODULES_DIR.is_dir():
        die("modules/ 不存在，先跑 python scripts/build-module.py --all")
    out = []
    for d in sorted(MODULES_DIR.iterdir()):
        if not d.is_dir():
            continue
        mf = d / "module.json"
        if not mf.is_file():
            die("缺少清单：%s" % mf)
        out.append(json.loads(mf.read_text(encoding="utf-8")))
    if not out:
        die("modules/ 下没有模块")
    return out


def zip_path_of(mod):
    return ZIP_DIR / ("%s-%s.zip" % (mod["id"], mod["version"]))


def verify(mod):
    problems = []
    zp = zip_path_of(mod)
    if not zp.is_file():
        return ["缺少 zip：%s" % zp]
    if mod.get("zipSha256") and hashlib.sha256(zp.read_bytes()).hexdigest() != mod["zipSha256"]:
        return ["%s 清单 zipSha256 与 zip 不符" % mod["id"]]
    with zipfile.ZipFile(zp) as z:
        names = set(z.namelist())
        if "module.json" not in names:
            problems.append("%s 包内缺 module.json" % mod["id"])
        else:
            inner = json.loads(z.read("module.json").decode("utf-8"))
            if inner.get("id") != mod["id"]:
                problems.append("%s 包内 id 不一致" % mod["id"])
            if str(inner.get("version")) != str(mod["version"]):
                problems.append("%s 包内版本不一致" % mod["id"])
            if len(inner.get("files") or []) != len(mod.get("files") or []):
                problems.append("%s 包内文件数与清单不一致" % mod["id"])
        for f in mod.get("files") or []:
            if f["path"] not in names:
                problems.append("%s 缺少条目 %s" % (mod["id"], f["path"]))
                continue
            if hashlib.sha256(z.read(f["path"])).hexdigest() != f["sha256"]:
                problems.append("%s 条目 sha256 不符：%s" % (mod["id"], f["path"]))
    return problems


def build_index(mods):
    ver = mods[0]["version"]
    entries = []
    for m in mods:
        zp = zip_path_of(m)
        entries.append({
            "id": m["id"],
            "name": m["name"],
            "version": m["version"],
            "description": m.get("description", ""),
            "sizeBytes": zp.stat().st_size if zp.is_file() else 0,
            "zipSha256": hashlib.sha256(zp.read_bytes()).hexdigest() if zp.is_file() else "",
            "fileCount": len(m.get("files") or []),
            "tags": list(m.get("tags") or []),
            "recommended": bool(m.get("recommended")),
            "pro": bool(m.get("pro")),
            "hot": bool(m.get("hot")),
            "whatsNew": m.get("whatsNew", ""),
            "globals": list(m.get("globals") or []),
            "download": {
                "github": "%s/releases/download/v%s/%s" % (GH, ver, zp.name),
                "gitee": "%s/releases/download/v%s/%s" % (GE, ver, zp.name),
            },
            "manifest": {
                "github": "%s/raw/main/modules/%s/module.json" % (GH, m["id"]),
                "gitee": "%s/raw/main/modules/%s/module.json" % (GE, m["id"]),
            },
        })
    # 合集（bundles/<id>/module.json）：一次下载多模块，首启推荐
    bdir_root = ROOT / "bundles"
    if bdir_root.is_dir():
        for bf in sorted(bdir_root.glob("*/module.json")):
            b = json.loads(bf.read_text(encoding="utf-8"))
            zp = zip_path_of(b)
            entries.insert(0, {
                "id": b["id"],
                "name": b["name"],
                "version": b["version"],
                "description": b.get("description", ""),
                "sizeBytes": zp.stat().st_size if zp.is_file() else 0,
                "zipSha256": hashlib.sha256(zp.read_bytes()).hexdigest() if zp.is_file() else "",
                "fileCount": 0,
                "tags": ["合集", "推荐"],
                "recommended": True,
                "pro": False,
                "hot": False,
                "bundle": True,
                "contains": list(b.get("modules") or []),
                "whatsNew": b.get("whatsNew", ""),
                "globals": [],
                "download": {
                    "github": "%s/releases/download/v%s/%s" % (GH, b["version"], zp.name),
                    "gitee": "%s/releases/download/v%s/%s" % (GE, b["version"], zp.name),
                },
                "manifest": {
                    "github": "%s/raw/main/bundles/%s/module.json" % (GH, b["id"]),
                    "gitee": "%s/raw/main/bundles/%s/module.json" % (GE, b["id"]),
                },
            })
    return {
        "schema": 1,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hostMin": mods[0].get("minHost", ""),
        "modules": entries,
    }


def main():
    ap = argparse.ArgumentParser(description="Papilot 组件目录发布（默认 dry-run）")
    ap.add_argument("--stage", action="store_true",
                    help="写目录文件并汇总 zip 到 build/modules-publish/dist")
    ap.add_argument("--verify", action="store_true", help="只校验清单与 zip，不写文件")
    args = ap.parse_args()

    mods = load_modules()
    problems = []
    for m in mods:
        problems += verify(m)
    # 合集：成员路径带 <mid>/ 前缀，清单 sha256 用成员 module.json
    mod_by_id = {m["id"]: m for m in mods}
    for b in load_bundles():
        zp = zip_path_of(b)
        if not zp.is_file():
            problems.append("缺少合集 zip：%s" % zp)
            continue
        with zipfile.ZipFile(zp) as z:
            names = set(z.namelist())
            if "bundle.json" not in names:
                problems.append("%s 包内缺 bundle.json" % b["id"])
            for mid in (b.get("modules") or []):
                if mid not in mod_by_id:
                    problems.append("%s 引用未知模块 %s" % (b["id"], mid))
                    continue
                if ("%s/module.json" % mid) not in names:
                    problems.append("%s 缺成员清单 %s" % (b["id"], mid))
                    continue
                for f in mod_by_id[mid].get("files") or []:
                    rel = "%s/%s" % (mid, f["path"])
                    if rel not in names:
                        problems.append("%s 缺条目 %s" % (b["id"], rel))
                        continue
                    if hashlib.sha256(z.read(rel)).hexdigest() != f["sha256"]:
                        problems.append("%s 条目 sha256 不符：%s" % (b["id"], rel))
    if problems:
        for p in problems:
            print("✗ " + p, file=sys.stderr)
        die("校验失败 %d 处" % len(problems))
    print("✓ %d 个模块清单与 zip 校验通过" % len(mods))

    index = build_index(mods)
    total = sum(e["sizeBytes"] for e in index["modules"])
    print("  目录条目 %d 个，组件包合计 %.1f KB（hostMin %s）"
          % (len(index["modules"]), total / 1024.0, index["hostMin"]))
    for e in index["modules"]:
        print("  · %-26s %7.1f KB  %2d 文件" % (e["id"], e["sizeBytes"] / 1024.0, e["fileCount"]))

    if args.verify:
        return
    if not args.stage:
        print("\n[dry-run] 未写文件；加 --stage 生成目录并汇总 release 附件")
        return

    INDEX_FILE.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
    import subprocess as _sp
    try:
        r = _sp.run(["node", str(ROOT / "scripts" / "sign-modules-index.js"), str(INDEX_FILE)],
                    capture_output=True, text=True, timeout=60)
        print("签名:", ((r.stdout or "") + (r.stderr or "")).strip())
    except (OSError, _sp.SubprocessError) as e:
        print("签名: 跳过（%s）" % e)
    if STAGE_DIR.exists():
        shutil.rmtree(STAGE_DIR)
    STAGE_DIR.mkdir(parents=True)
    for m in mods:
        shutil.copy2(zip_path_of(m), STAGE_DIR / zip_path_of(m).name)
    for b in load_bundles():
        shutil.copy2(zip_path_of(b), STAGE_DIR / zip_path_of(b).name)

    n_files = sum(1 for _ in STAGE_DIR.glob("*.zip"))
    print("\n✓ 目录  : %s" % INDEX_FILE.relative_to(ROOT).as_posix())
    print("✓ 附件  : %s（%d 个 zip）"
          % (STAGE_DIR.relative_to(ROOT).as_posix(), n_files))
    print("\n发版时：把 %s 里 %d 个 zip 作为 v%s Release 附件上传；"
          % (STAGE_DIR.relative_to(ROOT).as_posix(), n_files, mods[0]["version"]))
    print("        papilot-modules-index.json 随主仓提交即可（客户端 raw 直读）。")


if __name__ == "__main__":
    main()
