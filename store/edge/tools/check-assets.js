// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 商店材料自检：截图规格、文案长度、隐私页要素、包与清单版本一致性。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EDGE = path.join(ROOT, "store/edge");
const problems = [];

const EXT = [
  { id: "reader", dir: "edge-extension", pkg: "papilot-edge" },
  { id: "cite", dir: "edge-extension-cite", pkg: "papilot-cite" },
];

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

for (const ext of EXT) {
  const base = path.join(EDGE, ext.id);
  const listing = fs.readFileSync(path.join(base, "listing-zh.md"), "utf8");
  const m = listing.match(/简短描述（≤132 字符） \| (.+?) \|/);
  if (!m) problems.push(ext.id + ": 找不到简短描述");
  else if (m[1].trim().length > 132) problems.push(ext.id + ": 简短描述超过 132 字符");

  const shots = fs.readdirSync(path.join(base, "screenshots")).filter((f) => f.endsWith(".png"));
  if (!shots.length) problems.push(ext.id + ": 没有截图");
  for (const s of shots) {
    const p = path.join(base, "screenshots", s);
    const { w, h, bytes } = pngSize(p);
    if (w !== 1280 || h !== 800) problems.push(ext.id + "/" + s + ": 尺寸 " + w + "x" + h);
    if (bytes < 20000) problems.push(ext.id + "/" + s + ": 文件过小，可能是空图");
  }

  const privacy = fs.readFileSync(path.join(base, "privacy-policy.html"), "utf8");
  for (const key of ["生效日期", "947250030@qq.com", "权限"]) {
    if (!privacy.includes(key)) problems.push(ext.id + ": 隐私政策缺少「" + key + "」");
  }

  const notes = fs.readFileSync(path.join(base, "review-notes.md"), "utf8");
  if (!/测试步骤/.test(notes)) problems.push(ext.id + ": 审核说明缺少测试步骤");

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ext.dir, "manifest.json"), "utf8"));
  const zip = path.join(ROOT, ext.dir, "dist", ext.pkg + "-" + manifest.version + ".zip");
  if (!fs.existsSync(zip)) problems.push(ext.id + ": 缺少安装包 " + path.relative(ROOT, zip));
  else {
    const out = execFileSync("python", ["-c",
      "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);d=json.loads(z.read('manifest.json'));print(d['version']);print(len(z.namelist()))",
      zip], { encoding: "utf8" }).trim().split(/\r?\n/).map((s) => s.trim());
    if (out[0] !== manifest.version) problems.push(ext.id + ": 包内版本与清单不一致");
  }
}

console.log("检查 " + EXT.length + " 个扩展的商店材料");
if (problems.length) {
  console.log("发现 " + problems.length + " 个问题：");
  for (const p of problems) console.log("  - " + p);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
