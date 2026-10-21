// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 静态自检：语法、清单引用、权限红线、远程代码、图标尺寸。 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function walk(dir, out) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (rel.includes("node_modules") || rel.includes("vendor")) continue;
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const files = walk("src", []);
const jsFiles = files.filter((f) => f.endsWith(".js"));

for (const file of jsFiles) {
  const res = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], { encoding: "utf8" });
  if (res.status !== 0) problems.push("语法错误 " + file + "\n" + (res.stderr || "").split("\n")[0]);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const mustExist = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
];
for (const f of mustExist) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push("清单引用不存在：" + f);
}

if (manifest.permissions.includes("tabs")) problems.push("不应申请 tabs 权限");
if (manifest.permissions.includes("cookies")) problems.push("不应申请 cookies 权限");
if (manifest.host_permissions.length !== 1 || manifest.host_permissions[0] !== "https://api.crossref.org/*") {
  problems.push("外部主机权限应只有 Crossref");
}

for (const f of files.filter((x) => x.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(ROOT, f), "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push("内联脚本（CSP 会拦截）：" + f);
  if (/\son(click|change|input|submit)=/i.test(html)) problems.push("内联事件：" + f);
  if (/<script[^>]+src="https?:/i.test(html)) problems.push("远程脚本：" + f);
}

for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(ROOT, f), "utf8");
  if (/\beval\s*\(/.test(code)) problems.push("eval：" + f);
  if (/new\s+Function\s*\(/.test(code)) problems.push("new Function：" + f);
}

const png = fs.readFileSync(path.join(ROOT, "icons/icon128.png"));
if (png.readUInt32BE(16) !== 128 || png.readUInt32BE(20) !== 128) problems.push("icon128 尺寸不对");

console.log("检查文件：" + files.length + " 个（JS " + jsFiles.length + "）");
if (problems.length) {
  console.log("\n发现 " + problems.length + " 个问题：");
  for (const p of problems) console.log("  - " + p);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
