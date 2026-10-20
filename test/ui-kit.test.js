#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* ui-kit 组件层契约测试（B2.0，0.66.x）
 *
 * 并行开发时，组件层是**四五个任务共同消费的 API**。API 一旦偷偷漂移（类名改名、写死颜色、
 * 冒出第三种控件高度），消费方的界面会在某次合并后突然变形，而且很难定位到是谁改的。
 * 这份测试把契约钉成四条机器可校验的规则：
 *   ① 类名集合 == 契约文档（docs/parallel/ui-kit-contract.md）里登记的那一套，多一个少一个都报；
 *   ② 不留 !important（会压死窗口自己的主题与暗色）；
 *   ③ 颜色一律 `var(--pp-*)`，不写死色值（否则暗色/自定义主题失效）；
 *   ④ 控件高度只有 28（常规）/ 24（-sm）两档。
 *
 * 运行：node test/ui-kit.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'chrome', 'content', 'ui-kit.css');
const CONTRACT = path.join(ROOT, 'docs', 'parallel', 'ui-kit-contract.md');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}

const css = fs.readFileSync(KIT, 'utf8');
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const selectorsOnly = noComments.replace(/\{[^}]*\}/g, '{}');   // 去掉声明，只留选择器

/* ---------------- ① 类名集合 == 契约 ---------------- */
const impl = Array.from(new Set(selectorsOnly.match(/\.pp-[a-z0-9-]+/g) || [])).sort();

const doc = fs.readFileSync(CONTRACT, 'utf8');
// 契约里用反引号标注类名；只认带前导点的（`pp-wb-*` 这类窗口私有前缀不算）
const declared = Array.from(new Set((doc.match(/`\.pp-[a-z0-9-]+`/g) || [])
  .map((s) => s.replace(/`/g, '')))).sort();

const missing = declared.filter((c) => impl.indexOf(c) < 0);   // 文档有、实现没有
const undocumented = impl.filter((c) => declared.indexOf(c) < 0); // 实现有、文档没有
ok(missing.length === 0, '① 契约里的每个类都已实现', missing);
ok(undocumented.length === 0, '① 实现里的每个类都在契约里登记过（类名只增不改，需同步文档）', undocumented);

/* ---------------- ② 无 !important ---------------- */
ok(!/!\s*important/i.test(noComments), '② 组件层不留 !important（会压死窗口主题与暗色）');

/* ---------------- ③ 颜色不写死 ---------------- */
const hexOrRgb = [];
const declRe = /([a-z-]+)\s*:\s*([^;{}]+);/g;
let m;
while ((m = declRe.exec(noComments))) {
  const prop = m[1];
  const val = m[2].trim();
  if (!/^(color|background|background-color|border|border-color|border-top|border-bottom|box-shadow|outline)/.test(prop)) continue;
  // var(--pp-x, #fff) 里的 #fff 是**不回退就崩**的必要兜底，不算写死色值：先剥掉整段 var(...)
  const bare = val.replace(/var\([^)]*\)/g, '');
  if (/#[0-9a-fA-F]{3,8}\b/.test(bare) || /rgba?\(/.test(bare)) {
    // 例外：主按钮文字必须纯白（不随主题变）
    if (prop === 'color' && /^#ffffff$/i.test(val)) continue;
    hexOrRgb.push(prop + ':' + val);
  }
}
ok(hexOrRgb.length === 0, '③ 颜色一律走 var(--pp-*)，不写死色值', hexOrRgb.slice(0, 6));

/* ---------------- ④ 控件高度两档 ---------------- */
function block(sel) {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const mm = re.exec(noComments);
  return mm ? mm[1] : '';
}
const hasDecl = (b, prop, val) => new RegExp('(^|;|\\s)' + prop + '\\s*:\\s*' + val).test(b);
ok(hasDecl(block('.pp-btn'), 'height', '28px'), '④ 常规按钮高 28');
ok(hasDecl(block('.pp-btn-sm'), 'height', '24px'), '④ 小号按钮高 24');
ok(hasDecl(block('.pp-input,\n.pp-select'), 'height', '28px')
  || hasDecl(block('.pp-input'), 'height', '28px'), '④ 输入/下拉高 28');
// 不允许出现第三档高度
// 只看 height / min-height 之外的固定高度；min-height（如 .pp-msg 的 16px）不属于控件高度档位
const heights = Array.from(new Set((noComments.match(/(?<!min-)(?<!max-)height\s*:\s*(\d+)px/g) || [])
  .map((s) => s.replace(/\D/g, ''))));
ok(hasDecl(block('.pp-btn-lg'), 'height', '36px'), '④ 大号按钮（编辑器主操作）高 36');
// 三档：28 常规 / 24 小号 / 36 编辑器主操作。出现第四种即报。
ok(heights.every((h) => h === '28' || h === '24' || h === '36'),
  '④ 组件层只出现 28 / 24 / 36 三档固定高度', heights);

/* ---------------- ⑤ 令牌与可聚焦 ---------------- */
ok(/@import\s+url\("chrome:\/\/papilot\/content\/ui-tokens\.css"\)/.test(css),
  '⑤ 组件层内部引入统一令牌（消费方只引 ui-kit 一个即可）');
ok(/:focus-visible/.test(noComments) && /focus-ring/.test(noComments),
  '⑤ 键盘焦点环走 --pp-focus-ring');
ok(/\.pp-btn:disabled/.test(noComments), '⑤ 禁用态有统一样式（0.5 透明度）');

/* ---------------- 汇总 ---------------- */
console.log('ui-kit: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
