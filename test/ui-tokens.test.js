#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 统一设计令牌（ui-tokens.css）结构测试（0.65.2）
 *
 * 为什么要有它：设置面板（prefs.css）与四个独立窗口各自有一份 --pp-* 取值。
 * 0.65.2 建了唯一词汇表 `chrome/content/ui-tokens.css`，窗口用 @import 引入（本地声明仍在其后，
 * 计算值不变——已用无头 Chrome 逐令牌比对过）。这份测试守住三件事，避免以后又漂回去：
 *   ① 词汇表完整：核心语义色 / 形状 / 间距 / 字号齐备，且**明暗三态**都在（默认亮、
 *      跟随系统深色、显式 data-theme="dark"）；`:not([data-theme="light"])` 这个 guard 不能丢，
 *      否则系统深色时用户显式选的浅色主题会被顶掉；
 *   ② 两个 css 不漂移：prefs.css 与 ui-tokens.css 的同一令牌必须同值（配色只有一处真理）；
 *   ③ 引入方式正确：每个带 <html:style> 的窗口，块内**第一条有效语句**就是 @import（注释不算）；
 *      @import 之后出现的规则会被浏览器忽略，位置错了等于没引入。
 *
 * 运行：node test/ui-tokens.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOKENS = path.join(ROOT, 'chrome', 'content', 'ui-tokens.css');
const PREFS = path.join(ROOT, 'chrome', 'content', 'prefs.css');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const read = (p) => fs.readFileSync(p, 'utf8');

/** 抽出某段 CSS 文本里的 --pp-* 声明（先去掉注释，避免注释里的示例被误采） */
function decls(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  const re = /(--pp-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(clean))) out[m[1]] = m[2].trim();
  return out;
}

// ★ 先剥注释再分段：文件头注释里**会提到** `@media (prefers-color-scheme: dark)` 与
// `:root[data-theme="dark"]`（说明三态怎么做），不剥离就会把注释当成真实分界点，
// 切出来只剩注释、拿不到任何声明（本测试第一版就踩了这个）。
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tok = stripComments(read(TOKENS));
const pre = stripComments(read(PREFS));

/** 切成三段：默认（亮）/ 系统深色 / 显式深色 */
function segments(css) {
  const iMedia = css.indexOf('@media (prefers-color-scheme: dark)');
  const iAttr = css.indexOf(':root[data-theme="dark"]');
  return {
    light: css.slice(0, iMedia),
    darkMedia: css.slice(iMedia, iAttr),
    darkAttr: css.slice(iAttr),
  };
}
const T = segments(tok);
const uiLight = decls(T.light);
const uiDarkMedia = decls(T.darkMedia);
const uiDarkAttr = decls(T.darkAttr);

/* ---------------- ① 词汇表完整 + 三态 ---------------- */
const CORE = [
  '--pp-surface', '--pp-surface-2', '--pp-surface-3', '--pp-field',
  '--pp-border', '--pp-border-strong',
  '--pp-text', '--pp-text2', '--pp-muted', '--pp-faint',
  '--pp-accent', '--pp-accent-emphasis', '--pp-accent-weak',
  '--pp-success', '--pp-warn', '--pp-danger',
  '--pp-radius-sm', '--pp-radius-md', '--pp-radius-lg',
  '--pp-shadow-1', '--pp-shadow-2', '--pp-shadow-3',
  '--pp-sp-1', '--pp-sp-2', '--pp-sp-3', '--pp-sp-4', '--pp-sp-5',
  '--pp-fs-xs', '--pp-fs-sm', '--pp-fs-md', '--pp-fs-lg', '--pp-fs-xl',
];
const missLight = CORE.filter((k) => !(k in uiLight));
eq(JSON.stringify(missLight), '[]', '① 亮色词汇表覆盖全部核心令牌');

// 深色只重定义「会变的东西」：颜色 + 阴影；圆角/间距/字号在亮色里定义一次即可（继承）。
const DARK_REQUIRED = CORE.filter((k) => !/^--pp-(radius|sp|fs)-/.test(k));
const missDark = DARK_REQUIRED.filter((k) => !(k in uiDarkMedia));
eq(JSON.stringify(missDark), '[]', '① 系统深色覆盖全部会变的令牌（颜色 + 阴影）');

const missAttr = DARK_REQUIRED.filter((k) => !(k in uiDarkAttr));
eq(JSON.stringify(missAttr), '[]', '① 显式深色覆盖全部会变的令牌（颜色 + 阴影）');

ok(T.darkMedia.includes(':root:not([data-theme="light"])'),
  '① ★ 系统深色带 :not([data-theme="light"]) guard（否则用户显式选的浅色会被顶掉）');
ok(T.darkAttr.includes(':root[data-theme="dark"]'),
  '① 显式深色走 [data-theme="dark"]（主题系统/窗口 JS 写这个属性）');

/* ---------------- ② 与 prefs.css 同值（配色只有一处真理） ---------------- */
const P = segments(pre);
const pLight = decls(P.light);
const pDark = decls(P.darkMedia);
const SHARED = ['--pp-surface', '--pp-surface-2', '--pp-border', '--pp-text', '--pp-muted',
  '--pp-accent', '--pp-accent-emphasis', '--pp-accent-weak', '--pp-success', '--pp-warn',
  '--pp-danger', '--pp-btn-hover', '--pp-focus-ring', '--pp-radius-md', '--pp-radius-lg',
  '--pp-shadow-1', '--pp-sp-2', '--pp-fs-md'];
const driftLight = SHARED.filter((k) => pLight[k] !== undefined && uiLight[k] !== undefined
  && pLight[k] !== uiLight[k]).map((k) => k + '(' + pLight[k] + ' vs ' + uiLight[k] + ')');
eq(JSON.stringify(driftLight), '[]', '② prefs.css 与统一令牌的亮色取值一致');

const driftDark = SHARED.filter((k) => pDark[k] !== undefined && uiDarkMedia[k] !== undefined
  && pDark[k] !== uiDarkMedia[k]).map((k) => k + '(' + pDark[k] + ' vs ' + uiDarkMedia[k] + ')');
eq(JSON.stringify(driftDark), '[]', '② prefs.css 与统一令牌的深色取值一致');

// prefs 用到的每个令牌，词汇表里都得有（否则窗口侧引用同名变量会取空）
const prefsKeys = Object.keys(pLight);
const notInTokens = prefsKeys.filter((k) => !(k in uiLight));
eq(JSON.stringify(notInTokens), '[]', '② prefs 声明的每个令牌都能在统一词汇表里找到');

/* ---------------- ③ 历史别名（迁移期可解析） ---------------- */
const LEGACY = ['--pp-soft', '--pp-border2', '--pp-subtle', '--pp-bg', '--pp-user',
  '--pp-user-text', '--pp-ai', '--pp-ai-text', '--pp-code-bg', '--pp-code-text', '--pp-ok'];
const missLegacy = LEGACY.filter((k) => !(k in uiLight));
eq(JSON.stringify(missLegacy), '[]', '③ 历史别名齐全（老窗口 CSS 迁移期仍可解析）');

/* ---------------- ④ 每个带样式块的窗口都正确引入了 ---------------- */
const CONTENT = path.join(ROOT, 'chrome', 'content');
const wins = fs.readdirSync(CONTENT).filter((f) => f.endsWith('.xhtml'))
  .filter((f) => /<html:style>/.test(read(path.join(CONTENT, f))));
ok(wins.length >= 4, '④ 找到带 <html:style> 的窗口（应为 4 个）', wins.length);

for (const w of wins) {
  const src = read(path.join(CONTENT, w));
  const m = src.match(/<html:style><!\[CDATA\[([\s\S]*?)\]\]><\/html:style>/);
  if (!m) { ok(false, '④ ' + w + ' 样式块可解析'); continue; }
  // 去掉注释后的第一条语句必须是 @import
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
  ok(body.startsWith('@import url("chrome://papilot/content/ui-tokens.css");'),
    '④ ' + w + ' 的样式块第一条有效语句是 @import 统一令牌', body.slice(0, 60));
}

/* ---------------- ⑤ 引入位置不会覆盖本地声明（顺序纪律） ---------------- */
// 本地 :root / #id 声明必须出现在 @import 之后；@import 只能是第一条，所以只需断言块内
// 存在本地声明（否则说明被整体搬走了，语义变了）
for (const w of wins) {
  const src = read(path.join(CONTENT, w));
  const m = src.match(/<html:style><!\[CDATA\[([\s\S]*?)\]\]><\/html:style>/);
  // ★ 必须剥注释再比位置：引入处的说明文字里就写着「--pp-*」，否则永远误判成「本地声明在前」
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const iImport = body.indexOf('@import');
  const iLocal = body.indexOf('--pp-');
  // 有的窗口只引入词汇表、自己一个令牌都不声明（新窗口常见）—— 这类不存在「谁覆盖谁」，跳过即可。
  // 只要它声明了本地令牌，就必须在 @import 之后（否则本地值会被词汇表的 :root 顶掉）。
  ok(iLocal < 0 || (iImport >= 0 && iLocal > iImport),
    '⑤ ' + w + ' 若有本地令牌声明，则在 @import 之后（层叠不变）');
}

/* ---------------- 汇总 ---------------- */
console.log('ui-tokens: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
