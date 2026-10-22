#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置面板「运行时生成内容」审计（0.72.3 批次）
 *
 * 静态门禁（scripts/audit/static-audit.py）只看 prefs.xhtml / prefs.css 的文本，
 * 而 prefs-*.js 用字符串拼出来的 UI 不在它的判定范围内。本脚本补的就是这一块：
 *   ① emoji：JS 字面量里会被写进 DOM 的 emoji 必须为 0（允许的 dingbats 单独报数）
 *   ② 点击目标：动态创建的 span/div 上挂 click（或 onclick）必须为 0——
 *      要么改成真 <button>，要么补 role="button" + tabindex + Enter/Space 键处理
 *
 * 用法：
 *   node scripts/audit/prefs-runtime-audit.js               # 人读摘要
 *   node scripts/audit/prefs-runtime-audit.js --json        # 机器可读
 *   node scripts/audit/prefs-runtime-audit.js --files a.js  # 只查指定文件
 *
 * 退出码：0 全绿 / 1 有违规（emoji 或键盘不可达的点击目标）/ 2 源文件读取失败（含路径打错）。
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

/** 默认扫全部设置面板脚本（prefs-*.js）——门禁要能抓住任何一处新写回去的 emoji / 假按钮，
 *  只盯三个文件会漏（vault.js 那种独立窗口不在面板域，需要时用 --files 单独点）。 */
function defaultFiles() {
  const dir = path.join(ROOT, "chrome", "content");
  return fs.readdirSync(dir)
    .filter((n) => /^prefs-.*\.js$/.test(n))
    .sort()
    .map((n) => "chrome/content/" + n);
}

/* ---------- 字符分类（与 static-audit.py 的 classify_char 同口径） ---------- */

const ALLOWED_SYMBOLS = new Set([
  0x2713, 0x2714, 0x2715, 0x2716, 0x2717, 0x2718, // ✓ ✔ ✕ ✖ ✗ ✘
  0x2605, 0x2606, 0x26a0, 0x21bb,                 // ★ ☆ ⚠ ↻
]);
const ARROW_MATH = new Set([0x00d7, 0x00f7, 0x00b1, 0x2032, 0x2033, 0x2212, 0x00b2, 0x00b3]);
const TYPOGRAPHY = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x00a0]);

function classify(cp, prevCp) {
  if (ALLOWED_SYMBOLS.has(cp)) return "symbol";
  // 变体选择符跟着允许符号时算它的一部分，否则按 emoji 判定（⚠️ 与 ⚠ 不同）
  if (cp === 0xfe0f) return prevCp && ALLOWED_SYMBOLS.has(prevCp) ? "symbol" : "emoji";
  if ((cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x1f1e6 && cp <= 0x1f1ff)) return "emoji";
  if ((cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff)) return "emoji";
  if ((cp >= 0x2190 && cp <= 0x21ff) || (cp >= 0x2200 && cp <= 0x22ff)) return "arrow";
  if (ARROW_MATH.has(cp)) return "arrow";
  if ((cp >= 0x2460 && cp <= 0x24ff) || (cp >= 0x25a0 && cp <= 0x25ff)) return "symbol";
  if (TYPOGRAPHY.has(cp)) return "typography";
  return "other";
}

function scanChars(text) {
  const hits = { emoji: [], symbol: [], arrow: [] };
  let line = 1;
  let prevCp = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === "\n") { line++; prevCp = cp; continue; }
    if (cp > 0x7f) {
      const kind = classify(cp, prevCp);
      // FE0F 紧跟在允许符号后 → 属于该符号（⚠️ 与 ⚠ 同一个），不单独成行
      if (!(cp === 0xfe0f && kind === "symbol") && hits[kind]) hits[kind].push({ ch, cp, line });
    }
    prevCp = cp;
  }
  return hits;
}

/* ---------- 动态元素 × click 绑定 ---------- */

const DECL_RES = [
  // el("span", {...}, ...) / el("div", ...)  —— 项目里的 HTML 助手
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*el\(\s*["'](span|div|b|i|label)["']/g,
  // document.createElement("span") / createElementNS(HTML_NS, "span")
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement(?:NS\([^)]*,\s*)?["'](span|div)["']/g,
];

const INTERACTIVE_TAGS = new Set(["span", "div", "b", "i", "label"]);

/** 声明点前后 window 行内是否挂了 click，以及是否已按 role=button 范式补齐 */
function inspectBinding(lines, declLine, name) {
  const from = declLine - 1;
  const to = Math.min(lines.length, declLine + 14);
  const win = lines.slice(from, to).join("\n");
  const click = new RegExp("\\b" + name.replace(/\$/g, "\\$") +
    "\\s*\\.\\s*(?:addEventListener\\(\\s*[\"']click[\"']|onclick\\s*=)");
  const hasClick = click.test(win);
  const hasRole = /role:\s*["']button["']|setAttribute\(\s*["']role["']\s*,\s*["']button["']/.test(win);
  const hasTab = /tabindex|tabIndex/.test(win);
  const hasKey = /keydown|keypress/.test(win);
  const nowrap = /type:\s*["']button["']/.test(win);
  return {
    hasClick,
    reachable: hasRole && hasTab && hasKey,
    // type=button 说明这里已经是真按钮（只在 el("button") 上出现，不会命中本扫描）
    nowrap,
  };
}

function scanClickTargets(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  const seen = new Set();
  for (const re of DECL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const [, name, tag] = m;
      if (!INTERACTIVE_TAGS.has(tag)) continue;
      const declLine = text.slice(0, m.index).split("\n").length;
      const key = name + "@" + declLine;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = inspectBinding(lines, declLine, name);
      if (!info.hasClick) continue;
      found.push({
        file: null,
        line: declLine,
        tag,
        name,
        reachable: info.reachable,
        src: lines[declLine - 1].trim().slice(0, 120),
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/* ---------- 主流程 ---------- */

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const fi = args.indexOf("--files");
  const files = fi >= 0 ? args.slice(fi + 1).filter((a) => !a.startsWith("--")) : defaultFiles();

  const report = { files: [], emoji: [], symbols: [], clickTargets: [], bad: 0 };
  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (e) {
      // 读不到源文件不是「有违规」，用独立退出码 2 区分，免得 CI 把路径写错误读成门禁红
      process.stderr.write("读取失败：" + rel + "（" + (e && e.code || e && e.message || e) + "）\n");
      return 2;
    }
    const chars = scanChars(text);
    const clicks = scanClickTargets(text).map((c) => Object.assign(c, { file: rel }));
    report.bad += chars.emoji.length;
    report.bad += clicks.filter((c) => !c.reachable).length;
    report.emoji.push(...chars.emoji.map((h) => Object.assign(h, { file: rel })));
    report.symbols.push(...chars.symbol.map((h) => Object.assign(h, { file: rel })));
    report.clickTargets.push(...clicks);
    report.files.push({
      file: rel,
      emoji: chars.emoji.length,
      symbol: chars.symbol.length,
      arrow: chars.arrow.length,
      spanClick: clicks.length,
      spanClickUnreachable: clicks.filter((c) => !c.reachable).length,
    });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.bad ? 1 : 0;
  }

  const out = [];
  out.push("设置面板运行时生成内容审计（0.72.3）");
  out.push("-".repeat(66));
  for (const f of report.files) {
    out.push(`  ${f.file}`);
    out.push(`    emoji ${f.emoji}（须 0） · 允许符号 ${f.symbol} · 箭头/数学 ${f.arrow}` +
      ` · span/div 上的 click ${f.spanClick}（须 0 或全部 role+tabindex+keydown）`);
  }
  out.push("");
  if (report.emoji.length) {
    out.push("① emoji（违规）：");
    for (const h of report.emoji) {
      out.push(`   ${h.ch}  U+${h.cp.toString(16).toUpperCase()}  ${h.file}:${h.line}`);
    }
  } else {
    out.push("① emoji：0（PASS）");
  }
  const symAgg = new Map();
  for (const h of report.symbols) {
    const k = h.ch + " U+" + h.cp.toString(16).toUpperCase();
    symAgg.set(k, (symAgg.get(k) || 0) + 1);
  }
  out.push("   允许保留的 dingbats：" + (symAgg.size
    ? [...symAgg].map(([k, n]) => `${k}×${n}`).join("、") : "无"));
  out.push("");
  if (report.clickTargets.length) {
    out.push("② span/div 点击目标：");
    for (const c of report.clickTargets) {
      out.push(`   ${c.file}:${c.line}  <${c.tag}> ${c.name}  ` +
        (c.reachable ? "role+tabindex+keydown（可达）" : "键盘不可达 ✗"));
      out.push(`      ${c.src}`);
    }
  } else {
    out.push("② span/div 点击目标：0（PASS）");
  }
  out.push("");
  out.push(`结论：${report.bad ? "FAIL（" + report.bad + " 项）" : "PASS"}`);
  process.stdout.write(out.join("\n") + "\n");
  return report.bad ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { scanChars, scanClickTargets, classify };
