#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot 组件商店线上巡检（只读，不起 Zotero、不写任何远端）。

每次跑一遍（建议每天一次）：
  ① 双端目录（GitHub raw / Gitee raw）可达且结构合法；
  ② Ed25519 签名用包内公钥验过（node scripts/sign-modules-index.js 的验签面）；
  ③ 每个组件 zip 双端可下载，且下载内容与索引里的 zipSha256 一致；
  ④ --boot 加跑真机冒烟（verify-xpi.py，会短暂拉起 Zotero 独立实例）。

退出码：0 全绿；1 有失败项（stdout 逐项列出）。
"""

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GH_INDEX = "https://raw.githubusercontent.com/yebuqiu/zotero-papilot/main/papilot-modules-index.json"
GE_INDEX = "https://gitee.com/cassiuschen9261/zotero-papilot/raw/main/papilot-modules-index.json"


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "papilot-patrol"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def verify_signature(index):
    """用 Node 复用与插件一致的验签逻辑（Ed25519）。"""
    node_script = r'''
const crypto = require("crypto");
const idx = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const pub = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
const mods = (idx.modules || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
let s = "papilot-modules-v1\n" + String(idx.hostMin || "") + "\n";
for (const m of mods) s += String(m.id) + "|" + String(m.version) + "|" + String(m.zipSha256 || "") + "\n";
s += mods.length + "\n";
if (!idx.signature) { console.log("NO_SIGNATURE"); process.exit(3); }
const key = crypto.createPublicKey({ key: Buffer.from(pub.key, "base64"), format: "der", type: "spki" });
const ok = crypto.verify(null, Buffer.from(s, "utf8"), key, Buffer.from(idx.signature, "base64"));
console.log(ok ? "OK" : "BAD");
process.exit(ok ? 0 : 4);
'''
    with tempfile.TemporaryDirectory() as td:
        ip = Path(td) / "index.json"
        ip.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
        sp = Path(td) / "probe.js"
        sp.write_text(node_script, encoding="utf-8")
        r = subprocess.run(["node", str(sp), str(ip),
                            str(ROOT / "chrome" / "content" / "modules" / "signing-pubkey.json")],
                           capture_output=True, text=True, timeout=60)
        return (r.stdout or "").strip(), r.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--boot", action="store_true", help="追加真机冒烟（会拉起 Zotero 独立实例）")
    ap.add_argument("--skip-download", action="store_true", help="只查可达性，不整包下载校验哈希")
    args = ap.parse_args()

    fails = []
    print("== 组件商店线上巡检 ==")

    # ① 目录可达 + 结构
    indexes = {}
    for name, url in (("github", GH_INDEX), ("gitee", GE_INDEX)):
        try:
            raw = http_get(url)
            idx = json.loads(raw.decode("utf-8"))
            n = len(idx.get("modules") or [])
            print("✓ 目录[%s] 可达，%d 条" % (name, n))
            indexes[name] = idx
        except Exception as e:
            if name == "github":
                try:
                    raw2 = http_get("https://gh-proxy.com/" + url)
                    idx2 = json.loads(raw2.decode("utf-8"))
                    indexes[name] = idx2
                    print("· 目录[github] 直连不可达，gh-proxy 复探通（本机网络限制，记警告）：%s" % e)
                    continue
                except Exception as e2:
                    fails.append("目录[github] 不可达（gh-proxy 复探也失败，仓侧真有问题）：%s / %s" % (e, e2))
            else:
                fails.append("目录[%s] 不可达：%s" % (name, e))
            print("✗ 目录[%s] 不可达：%s" % (name, e))
    if not indexes:
        print("两端目录全挂，提前失败")
        return 1

    # 两端一致性（以 gitee 为准，github 同步可能有秒级延迟）
    if "github" in indexes and "gitee" in indexes:
        g = {m["id"]: (m.get("version"), m.get("zipSha256")) for m in indexes["gitee"]["modules"]}
        h = {m["id"]: (m.get("version"), m.get("zipSha256")) for m in indexes["github"]["modules"]}
        if g != h:
            fails.append("双端目录内容不一致（可能在同步中）")
            print("✗ 双端目录不一致")
        else:
            print("✓ 双端目录一致")

    idx = indexes.get("gitee") or indexes.get("github")

    # ② 签名
    out, code = verify_signature(idx)
    if code == 0:
        print("✓ 目录签名验过（Ed25519）")
    else:
        fails.append("目录签名异常：%s" % out)
        print("✗ 目录签名异常：%s" % out)

    # ③ zip 可达 + 哈希
    for m in idx.get("modules") or []:
        want = m.get("zipSha256") or ""
        ok_any = False
        for src in ("gitee", "github"):
            url = (m.get("download") or {}).get(src)
            if not url:
                continue
            try:
                if args.skip_download:
                    req = urllib.request.Request(url, method="HEAD",
                                                 headers={"User-Agent": "papilot-patrol"})
                    with urllib.request.urlopen(req, timeout=30) as r:
                        if r.status == 200:
                            ok_any = True
                            break
                else:
                    data = http_get(url, timeout=120)
                    if want and hashlib.sha256(data).hexdigest() != want:
                        fails.append("%s [%s] sha256 不符" % (m["id"], src))
                        print("✗ %s [%s] sha256 不符" % (m["id"], src))
                        continue
                    ok_any = True
                    break
            except Exception as e:
                print("  · %s [%s] 失败：%s" % (m["id"], src, e))
        if ok_any:
            print("✓ %s %s（%s）" % (m["id"], m.get("version"),
                  "仅 HEAD 可达" if args.skip_download else "已下载校验，哈希一致"))
        else:
            fails.append("%s 双端均不可下载" % m["id"])
            print("✗ %s 双端均不可下载" % m["id"])

    # ④ 可选真机冒烟
    if args.boot:
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "verify-xpi.py"),
                            "--xpi", str(sorted((ROOT / "dist").glob("papilot-*.xpi"),
                                                key=lambda p: p.stat().st_mtime)[-1]),
                            "--tag", "patrol"],
                           capture_output=True, text=True, timeout=420)
        tail = (r.stdout or "").strip().splitlines()[-1:] or [""]
        if r.returncode == 0:
            print("✓ 真机冒烟通过（%s）" % tail[0])
        else:
            fails.append("真机冒烟失败：%s" % tail[0])
            print("✗ 真机冒烟失败")

    print("-" * 60)
    if fails:
        print("失败 %d 项：" % len(fails))
        for f in fails:
            print("  ✗ " + f)
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
