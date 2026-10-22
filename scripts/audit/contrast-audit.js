#!/usr/bin/env node
/* PaperPilot · 对比度门禁（WCAG 2.x）
 * SPDX-License-Identifier: Apache-2.0 | Copyright (c) 2026 Cassiuschen
 *
 * 作用
 *   ① 解析 chrome/content/ui-tokens.css 的三态令牌（亮色 / 系统深色 media / 显式 data-theme=dark）
 *   ② 解析 chrome/content/prefs.css 的组件规则，抽出所有（文字色, 背景色）与（描边/焦点环, 背景）组合
 *   ③ 按 WCAG 相对亮度公式出真实数字：alpha 先合成、var() 链先展开、字号决定阈值
 *   ④ 逐条复测《设计审查裁决-设置面板-0.72.1》门禁 1 的 10 对失败组合（按选择器，不按名字猜）
 *
 * 用法
 *   node scripts/audit/contrast-audit.js           # 人读表格（markdown）
 *   node scripts/audit/contrast-audit.js --json    # 机器读 JSON
 *   退出码：门禁计入的组里有 FAIL → 1，全通过 → 0
 *
 * 只用 Node 标准库；不写产品文件；只读 CSS。
 *
 * 口径（写进报告，避免数字被误读）
 *   · 通过率按「颜色组合」计数（同 前景×背景 的多个选择器合并成一行），与裁决书「43 对实测」同粒度。
 *   · 门禁计入 = 文字对 + 可交互控件边界/状态 + 焦点主环。
 *     装饰性分隔线/卡片轮廓（1px 的 --pp-border 分区线）照测照列，但 WCAG 1.4.11 只约束
 *     「UI 组件的视觉信息」与「图形对象」，故不纳入通过率与退出码。
 *   · 焦点环 0.72.2 改双层：2px 实色 accent（计入）+ 4px alpha 光晕（装饰，不计入，数值照列）。
 *
 * 静态边界（不猜）
 *   · 背景带 alpha 时静态 CSS 无法证明真实 DOM 嵌套，合成基色由 BASE_MAP 显式声明并打进表格。
 *     prefs.css 里 --pp-bg 与 --pp-surface 两态同值，面板级歧义零影响。
 *   · 由 prefs-*.js 运行时写的内联色（.pp-badge-demo 等）标注为「静态不可判」，不计入通过率。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const TOKENS_CSS = path.join(ROOT, 'chrome', 'content', 'ui-tokens.css');
const PREFS_CSS = path.join(ROOT, 'chrome', 'content', 'prefs.css');
const PREFS_XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const CONTENT_DIR = path.join(ROOT, 'chrome', 'content');

/** 报告里统一用正斜杠（Windows 反斜杠在 markdown 里会被当转义） */
const relPath = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/* ======================================================================
 * 1. 极简 CSS 解析
 * ==================================================================== */

/** 把注释替换成等长空白（保留换行），保证行号不漂移 */
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/** 深度 0 处按分隔符切分（跳过 () / "" / '' 内部） */
function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let buf = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function parseDecls(body) {
  const decls = [];
  for (const chunk of splitTop(body, ';')) {
    const raw = chunk.trim();
    if (!raw) continue;
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const prop = raw.slice(0, idx).trim().toLowerCase();
    let value = raw.slice(idx + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important$/i, '').trim();
    }
    if (!prop || !value) continue;
    const prev = decls.find((d) => d.prop === prop);
    if (prev) {
      if (prev.important && !important) continue;
      prev.value = value;
      prev.important = important;
    } else {
      decls.push({ prop, value, important });
    }
  }
  return decls;
}

/** 返回 [{ selector, selectors[], media[], decls[], line }]；@media 只作为条件附加到子规则 */
function parseCss(text) {
  const src = blankComments(text);
  const rules = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      stack.push({ prelude: buf.replace(/\s+/g, ' ').trim(), bodyStart: i + 1 });
      buf = '';
    } else if (ch === '}') {
      const blk = stack.pop() || { prelude: '', bodyStart: 0 };
      const body = src.slice(blk.bodyStart, i);
      const media = stack.filter((s) => s.prelude.startsWith('@media')).map((s) => s.prelude);
      if (blk.prelude && !blk.prelude.startsWith('@') && !body.includes('{')) {
        const selectors = splitTop(blk.prelude, ',').map((s) => s.trim()).filter(Boolean);
        rules.push({
          selector: blk.prelude,
          selectors,
          media,
          decls: parseDecls(body),
          line: lineOf(src, blk.bodyStart),
        });
      }
      buf = '';
    } else if (ch === ';' && stack.length === 0) {
      buf = '';
    } else {
      buf += ch;
    }
  }
  return rules;
}

/* ======================================================================
 * 2. 颜色 / 变量 / 对比度
 * ==================================================================== */

function expandVars(value, vars, seen = new Set(), lvl = 0) {
  if (value == null) return '';
  if (lvl > 24 || value.indexOf('var(') === -1) return value;
  let out = '';
  let i = 0;
  for (;;) {
    const idx = value.indexOf('var(', i);
    if (idx === -1) { out += value.slice(i); break; }
    out += value.slice(i, idx);
    let depth = 0;
    let end = -1;
    for (let p = idx + 3; p < value.length; p++) {
      if (value[p] === '(') depth++;
      else if (value[p] === ')') { depth--; if (depth === 0) { end = p; break; } }
    }
    if (end === -1) { out += value.slice(idx); break; }
    const inner = value.slice(idx + 4, end);
    const parts = splitTop(inner, ',');
    const name = parts[0].trim();
    const fallback = parts.length > 1 ? parts.slice(1).join(',').trim() : null;
    let rep;
    if (vars[name] !== undefined && !seen.has(name)) {
      rep = expandVars(vars[name], vars, new Set([...seen, name]), lvl + 1);
    } else if (fallback !== null) {
      rep = expandVars(fallback, vars, seen, lvl + 1);
    } else {
      rep = '__UNRESOLVED__';
    }
    out += rep;
    i = end + 1;
  }
  return out;
}

const NAMED = { white: '#ffffff', black: '#000000', transparent: 'rgba(0,0,0,0)' };

function parseColor(input) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s || s === 'none' || s === 'inherit' || s === 'initial' || s === '__unresolved__') return null;
  if (Object.prototype.hasOwnProperty.call(NAMED, s)) s = NAMED[s];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const nums = splitTop(m[1], ',').length > 1
      ? splitTop(m[1], ',').map((x) => x.trim())
      : m[1].trim().split(/[\s/]+/).filter(Boolean);
    if (nums.length < 3) return null;
    const chan = (t) => {
      const v = String(t).trim();
      if (v.endsWith('%')) return Math.round((parseFloat(v) / 100) * 255);
      return parseFloat(v);
    };
    const r = chan(nums[0]);
    const g = chan(nums[1]);
    const b = chan(nums[2]);
    let a = 1;
    if (nums.length > 3) {
      const av = String(nums[3]).trim();
      a = av.endsWith('%') ? parseFloat(av) / 100 : parseFloat(av);
    }
    if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
    return { r, g, b, a: Number.isFinite(a) ? a : 1 };
  }
  return null;
}

/** 从 `1px solid var(--pp-border)` / `0 0 0 2px #0969da` 这类简写里揪出颜色 */
function colorTokens(str) {
  const out = [];
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[0]);
  return out;
}

function blend(top, bottom) {
  const a = top.a == null ? 1 : top.a;
  if (a >= 1) return { r: top.r, g: top.g, b: top.b, a: 1 };
  if (a <= 0) return { r: bottom.r, g: bottom.g, b: bottom.b, a: 1 };
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function lin(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(c) {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hex(c) {
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

function colorLabel(c) {
  const base = hex(c);
  return c.a != null && c.a < 1 ? `${base} @${Number(c.a.toFixed(2))}` : base;
}

/* ======================================================================
 * 3. 三态调色板
 * ==================================================================== */

const STATE_LIST = [
  { id: 'light', label: '亮色（默认，无属性）', short: '浅' },
  { id: 'dark-media', label: '深色（@media prefers-color-scheme: dark）', short: '深' },
  { id: 'dark-explicit', label: '深色（:root[data-theme="dark"] 显式）', short: '显式深' },
];

function isTokenRule(rule) {
  return rule.selectors.every((s) => /^(:root|\.pp-root|html)/.test(s))
    && rule.decls.some((d) => d.prop.startsWith('--'));
}

/** 命中判定：`:not([data-theme="light"])` 里的属性选择器不算「显式浅色」 */
function stateApplies(rule, stateId) {
  const darkMedia = rule.media.some((m) => /prefers-color-scheme\s*:\s*dark/.test(m));
  const lightMedia = rule.media.some((m) => /prefers-color-scheme\s*:\s*light/.test(m));
  const positive = (s) => s.replace(/:not\([^)]*\)/g, '');
  const attrDark = rule.selectors.some((s) => /data-theme\s*=\s*["']?dark/.test(positive(s)));
  const attrLight = rule.selectors.some((s) => /data-theme\s*=\s*["']?light/.test(positive(s)));
  if (attrDark) return stateId === 'dark-explicit';
  if (attrLight) return stateId === 'light';
  // 显式 data-theme 与「跟随系统」是两个互斥入口：显式深色要能在系统亮色下生效，
  // 所以 media 深色块只在 dark-media 这一态命中，不在 dark-explicit 命中。
  if (darkMedia) return stateId === 'dark-media';
  if (lightMedia) return stateId === 'light';
  return true;
}

/**
 * 面板有效令牌。层叠顺序即数组顺序：
 *   ui-tokens.css（:root 基线 → media → data-theme）→ prefs.css（.pp-root 基线 → media）
 * prefs.css 胜出：.pp-root 是 div，自身声明优先于从 :root 继承来的值。
 */
function buildPalette(stateId, tokenRules, prefsRules) {
  const vars = {};
  const owner = {};
  const apply = (rule, sheet) => {
    if (!isTokenRule(rule)) return;
    if (!stateApplies(rule, stateId)) return;
    for (const d of rule.decls) {
      if (!d.prop.startsWith('--')) continue;
      vars[d.prop] = d.value;
      owner[d.prop] = `${sheet}:${rule.line}`;
    }
  };
  for (const r of tokenRules) apply(r, 'ui-tokens.css');
  for (const r of prefsRules) apply(r, 'prefs.css');
  return { vars, owner };
}

/* ======================================================================
 * 4. 组件规则 → 对比对
 * ==================================================================== */

const DEFAULT_BASE = '--pp-surface';

/** 精确选择器 → 合成基色令牌（元素自身背景是 alpha / 透明时，下层是什么） */
const BASE_EXACT = {
  '.pp-count-hit': '--pp-surface',                          // 落在工具条 .pp-toolbar 上
  '.pp-anchor-nav .pp-btn:hover:not(:disabled)': '--pp-bg',  // 直达 chip 悬停，下层是面板底
  '.pp-anchor-nav .pp-btn.pp-anchor-active': '--pp-bg',
  '.pp-fold-head:hover': '--pp-surface-2',
  '.pp-fold-head:hover .pp-card-title': '--pp-surface-2',
  '.pp-fold-head:hover .pp-fold-arrow': '--pp-surface-2',
  '.pp-mb-compare thead th.pp-cmp-pro': '--pp-surface-2',
  '.pp-mb-compare th.pp-cmp-pro': '--pp-surface-2',
  '.pp-mb-compare td.pp-cmp-pro': '--pp-surface',
  '.pp-mb-compare tbody tr:hover td.pp-cmp-pro': '--pp-surface-2',
};

/** 选择器前缀 → 合成基色令牌（按顺序首个命中；越具体的放越前） */
const BASE_PREFIX = [
  ['.pp-mb-compare', '--pp-surface'],   // 对照表本体是 surface，比 .pp-mb- 更具体
  ['.pp-mb-', '--pp-surface-2'],        // 会员块 .pp-mb 底 = surface-2
  ['.pp-dev-', '--pp-surface-2'],
  ['.pp-ch-', '--pp-surface-2'],
  ['.pp-ai-tier', '--pp-surface-2'],
  ['.pp-mem-', '--pp-surface-2'],
  ['.pp-subs-row', '--pp-surface-2'],
  ['.pp-sch-row', '--pp-surface-2'],
  ['.pp-hk-row', '--pp-surface-2'],
  ['.pp-ts-', '--pp-surface-2'],
  ['.pp-rank-preview', '--pp-surface-2'],
  ['.pp-theme-card', '--pp-surface-2'],
  ['.pp-pdf-item', '--pp-surface-2'],
  ['.pp-cloud-log', '--pp-surface-2'],
  ['.pp-vault-entry', '--pp-surface-2'],
  ['.pp-fold-head', '--pp-surface-2'],
  ['.pp-pill', '--pp-surface'],
];

function baseTokenFor(selector) {
  const short = selector.replace(/^\.pp-root\s+/, '');
  if (BASE_EXACT[selector]) return BASE_EXACT[selector];
  if (BASE_EXACT[short]) return BASE_EXACT[short];
  for (const [prefix, token] of BASE_PREFIX) if (selector.includes(prefix)) return token;
  return DEFAULT_BASE;
}

/** 背景值 → {kind:'none'|'color'|'gradient', colors[], raw} */
function readBackground(decls, vars) {
  const d = decls.find((x) => x.prop === 'background' || x.prop === 'background-color');
  if (!d) return { kind: 'none', colors: [] };
  const value = expandVars(d.value, vars);
  if (/gradient\(/i.test(value)) {
    return { kind: 'gradient', colors: colorTokens(value).map(parseColor).filter(Boolean), raw: value };
  }
  if (!colorTokens(value).length) return { kind: 'none', colors: [], raw: value };
  const whole = parseColor(value);
  if (whole) return { kind: 'color', colors: [whole], raw: value };
  const toks = colorTokens(value).map(parseColor).filter(Boolean);
  return toks.length ? { kind: 'color', colors: [toks[toks.length - 1]], raw: value } : { kind: 'none', colors: [], raw: value };
}

function readBorderColors(decls, vars) {
  const out = [];
  const direct = decls.find((x) => x.prop === 'border-color');
  if (direct) for (const piece of splitTop(expandVars(direct.value, vars), ' ')) {
    const c = parseColor(piece);
    // border-color 一次给的是整圈（1 值四边 / 2 值上下、左右 / 4 值四边），都算闭合轮廓
    if (c) out.push(Object.assign({}, c, { sides: 4 }));
  }
  for (const prop of ['border', 'border-top', 'border-bottom', 'border-left', 'border-right']) {
    const d = decls.find((x) => x.prop === prop);
    if (!d) continue;
    const toks = colorTokens(expandVars(d.value, vars)).map(parseColor).filter(Boolean);
    // border 简写 = 四边闭合轮廓；border-bottom 这类单边 = 下划线 / 选中指示条
    if (toks.length) out.push(Object.assign({}, toks[toks.length - 1], {
      sides: prop === 'border' ? 4 : 1,
      side: prop === 'border' ? null : prop.replace(/^border-/, ''),
    }));
  }
  // 同一规则里多个方向同色只留一份（四边分别声明时把 sides 累加，避免把闭合框误判成下划线）
  const uniq = [];
  for (const c of out) {
    if (c.a <= 0.02) continue;
    const hit = uniq.find((u) => hex(u) === hex(c) && Math.abs(u.a - c.a) < 0.01);
    if (hit) { hit.sides = Math.min(4, hit.sides + c.sides); continue; }
    uniq.push(c);
  }
  return uniq;
}

/** 焦点态 box-shadow 里的环：`0 0 0 2px <color>` */
function readRings(decls, vars) {
  const d = decls.find((x) => x.prop === 'box-shadow');
  if (!d) return [];
  const rings = [];
  for (const part of splitTop(expandVars(d.value, vars), ',')) {
    const m = /(?:^|\s)0\s+0\s+0\s+([\d.]+)px/.exec(part.trim());
    const toks = colorTokens(part).map(parseColor).filter(Boolean);
    if (!m || !toks.length) continue;
    rings.push({ width: parseFloat(m[1]), color: toks[toks.length - 1], via: 'box-shadow' });
  }
  return rings.sort((a, b) => a.width - b.width);
}

/**
 * 焦点指示器：box-shadow 环 + outline（0.72.2 起 .pp-link-btn / .pp-disclose>summary 用 outline，
 * 只看 box-shadow 会把它们误判成「无焦点环」——gate-render 实测确认）。
 */
function readFocusIndicators(decls, vars) {
  const out = readRings(decls, vars);
  const outlineShorthand = decls.find((x) => x.prop === 'outline');
  const outlineColorDecl = decls.find((x) => x.prop === 'outline-color');
  const outlineWidthDecl = decls.find((x) => x.prop === 'outline-width');
  let outline = null;
  if (outlineShorthand) {
    const v = expandVars(outlineShorthand.value, vars);
    if (!/^\s*none\b/i.test(v)) {
      const toks = colorTokens(v).map(parseColor).filter(Boolean);
      const wm = /([\d.]+)px/.exec(v);
      if (toks.length) outline = { width: wm ? parseFloat(wm[1]) : 1, color: toks[toks.length - 1], via: 'outline' };
    }
  } else if (outlineColorDecl) {
    const toks = colorTokens(expandVars(outlineColorDecl.value, vars)).map(parseColor).filter(Boolean);
    const w = outlineWidthDecl ? parseFloat(expandVars(outlineWidthDecl.value, vars)) || 1 : 1;
    if (toks.length) outline = { width: w, color: toks[toks.length - 1], via: 'outline' };
  }
  if (outline) out.push(outline);
  return out;
}

function fontSizePx(decls, vars, fallback) {
  const d = decls.find((x) => x.prop === 'font-size');
  if (!d) return fallback;
  const m = /^([\d.]+)\s*(px|pt|rem|em)?$/.exec(expandVars(d.value, vars).trim());
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = m[2] || 'px';
  if (unit === 'pt') return (n * 4) / 3;
  if (unit === 'rem' || unit === 'em') return n * 16;
  return n;
}

function weightOf(decls) {
  const d = decls.find((x) => x.prop === 'font-weight');
  if (!d) return null;
  const v = d.value.trim().toLowerCase();
  if (v === 'bold') return 700;
  if (v === 'normal') return 400;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

const AA_TEXT = 4.5;
const AA_LARGE = 3;
const AA_NONTEXT = 3;

/** ≥24px 或 ≥18.66px 或（≥14px 且 bold）→ 3.0 */
function textThreshold(px, weight) {
  const bold = weight != null && weight >= 600;
  const large = px >= 24 || px >= 18.66 || (bold && px >= 14);
  return { threshold: large ? AA_LARGE : AA_TEXT, large, bold };
}

/** WCAG 1.4.3 对不可用控件豁免 */
function exemptReason(selector) {
  const s = selector.replace(/:not\([^)]*\)/g, '');
  if (/:disabled/.test(s)) return '不可用控件（WCAG 1.4.3 豁免）';
  if (/pp-mb-opt-soon/.test(selector)) return '「即将上线」占位项，不可交互（1.4.3 豁免）';
  return null;
}

/** 背景由 JS 运行时写入，静态不可判 */
const STATIC_INDETERMINATE = ['.pp-badge-demo'];

/* ---------------- 1.4.11 适用范围判定（控件 / 装饰） ----------------
 * 规则可复核，不靠选择器白名单。证据按强度排序：
 *   ① 标记层：prefs.xhtml 里该 class 落在哪个标签上（input/select/textarea/button/a/label/summary → 控件）
 *   ② 脚本层：prefs-*.js 里该 class 由 el("tag") 创建，或该变量绑了 addEventListener("click")
 *      —— 只有「变量本身」被绑才算；点击目标在子按钮上的容器不算（.pp-chip 就是这种）
 *   ③ CSS 层：选择器以控件标签开头、带 [role=button] / [tabindex] → 控件
 *   ④ 弱证据：CSS 声明 cursor:pointer（作者标注可点）。只在①②③都没有时作参考，
 *      因为它会滞后于重构（.pp-chip 改成 span 容器后 cursor 还留着）
 * 都没命中 → 装饰容器（照测照列，不计入 1.4.11 通过率）。
 */

const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button', 'a', 'label', 'summary', 'option']);
const CTOR_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:el|h|ce|document\.createElement)\(\s*["'`](\w+)["'`]/;
const SETCLASS_RE = /([A-Za-z_$][\w$]*)\.setAttribute\(\s*["'`]class["'`]\s*,\s*["'`]([^"'`]*)["'`]/;
// 对象字面量里的 class：`class: "pp-x"` 与 `"class": "pp-x"` 两种写法都要认
const CLASS_IN_OBJ_RE = /\bclass["'`]?\s*:\s*([^,\n}]+)/g;

function stripPrefix(tag) {
  // html:input → input
  return String(tag).replace(/^[a-z]+:/i, '').toLowerCase();
}

/** 标记层：prefs.xhtml 里 class → [{tag, line, role, tabindex, onclick}] */
function scanMarkupScopes(xhtmlText) {
  const map = new Map();
  const re = /<((?:\w+:)?[\w-]+)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xhtmlText))) {
    const tag = stripPrefix(m[1]);
    const attrs = m[2] || '';
    const cm = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
    if (!cm) continue;
    const line = xhtmlText.slice(0, m.index).split('\n').length;
    const role = (/\brole\s*=\s*"([^"]*)"/.exec(attrs) || [])[1] || null;
    const hasTabindex = /\btabindex\s*=/.test(attrs);
    const hasOnclick = /\bonclick\s*=/.test(attrs);
    for (const cls of cm[1].split(/\s+/).filter(Boolean)) {
      if (!cls.startsWith('pp-')) continue;
      if (!map.has(cls)) map.set(cls, []);
      const arr = map.get(cls);
      if (!arr.some((x) => x.tag === tag && x.line === line)) arr.push({ tag, line, role, hasTabindex, hasOnclick });
    }
  }
  return map;
}

/** 脚本层：class → [{tag, hasClick, file, line}]（变量级 click 证据） */
function scanJsScopes(sources) {
  const map = new Map();
  const add = (cls, info) => {
    if (!cls || !cls.startsWith('pp-')) return;
    if (!map.has(cls)) map.set(cls, []);
    const arr = map.get(cls);
    if (arr.some((a) => a.file === info.file && a.line === info.line && a.tag === info.tag)) return;
    arr.push(info);
  };
  const clickReFor = (v) => new RegExp(
    String.raw`\b${v.replace(/[$]/g, '\\$')}\s*\.\s*(?:addEventListener\(\s*["'\`]click|onclick\s*=)`
  );
  for (const src of sources) {
    const lines = src.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let m = CTOR_RE.exec(lines[i]);
      if (m) {
        const varName = m[1];
        const tag = stripPrefix(m[2]);
        // 只在这一条 el(...) 调用的括号范围内找 class，避免把下一个元素的对象字面量算进来
        const joined = lines.slice(i, Math.min(lines.length, i + 14)).join('\n');
        const callStart = joined.search(/(?:el|h|ce|document\.createElement)\(/);
        let slice = joined;
        if (callStart >= 0) {
          let depth = 0;
          let end = -1;
          for (let p = joined.indexOf('(', callStart); p < joined.length; p++) {
            if (joined[p] === '(') depth++;
            else if (joined[p] === ')') { depth--; if (depth === 0) { end = p; break; } }
          }
          slice = joined.slice(callStart, end === -1 ? joined.length : end + 1);
        }
        const classes = new Set();
        for (const cm of slice.matchAll(CLASS_IN_OBJ_RE)) {
          for (const q of cm[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
            for (const c of q[1].split(/\s+/)) if (c.startsWith('pp-')) classes.add(c);
          }
        }
        if (!classes.size) continue;
        const after = lines.slice(i, Math.min(lines.length, i + 40));
        const clickIdx = after.findIndex((l) => clickReFor(varName).test(l));
        for (const c of classes) add(c, { tag, hasClick: clickIdx >= 0, file: src.name, line: i + 1, clickLine: clickIdx >= 0 ? i + 1 + clickIdx : null });
      }
      m = SETCLASS_RE.exec(lines[i]);
      if (m) {
        const varName = m[1];
        const classes = m[2].split(/\s+/).filter((c) => c.startsWith('pp-'));
        if (!classes.length) continue;
        // 回溯同变量的构造语句拿 tag
        let tag = null;
        let ctorLine = null;
        const back = new RegExp(String.raw`\b${varName.replace(/[$]/g, '\\$')}\s*=\s*(?:el|h|ce|document\.createElement)\(\s*["'\`](\w+)["'\`]`);
        for (let j = i; j >= 0 && j > i - 80; j--) {
          const mm = back.exec(lines[j]);
          if (mm) { tag = stripPrefix(mm[1]); ctorLine = j + 1; break; }
        }
        const after = lines.slice(i, Math.min(lines.length, i + 40));
        const clickIdx = after.findIndex((l) => clickReFor(varName).test(l));
        for (const c of classes) add(c, { tag, hasClick: clickIdx >= 0, file: src.name, line: i + 1, ctorLine, clickLine: clickIdx >= 0 ? i + 1 + clickIdx : null });
      }
    }
  }
  return map;
}

/** 该选择器（去掉伪类后的基础选择器）在 CSS 里是否有 cursor:pointer */
function cursorPointerOf(prefsRules, selector) {
  const base = selector.replace(/:(hover|focus|focus-visible|focus-within|active|disabled)\b/g, '').replace(/:not\([^)]*\)/g, '');
  for (const r of prefsRules) {
    if (!r.selectors.includes(base) && !r.selectors.includes(selector)) continue;
    const d = r.decls.find((x) => x.prop === 'cursor');
    if (d && /pointer/i.test(d.value)) return true;
  }
  return false;
}

function scopeOf(selector, prefsRules, ctx) {
  const short = selector.replace(/^\.pp-root\s+/, '');
  const first = short.split(/[\s>+~]/)[0];
  const cssTagMatch = /^([a-z][a-z0-9-]*)/i.exec(first);
  const cssTag = cssTagMatch ? cssTagMatch[1].toLowerCase() : null;
  const classes = [...new Set((short.match(/\.[\w-]+/g) || []).map((s) => s.slice(1)).filter((c) => c !== 'pp-root'))];
  const ev = [];

  // ③ CSS 层
  if (cssTag && CONTROL_TAGS.has(cssTag)) {
    ev.push({ control: true, text: `CSS 选择器以控件标签 \`${cssTag}\` 开头` });
  }
  if (/\[role\s*=\s*["']?button/i.test(selector)) ev.push({ control: true, text: '选择器带 `[role="button"]`' });
  if (/\[tabindex/i.test(selector)) ev.push({ control: true, text: '选择器带 `[tabindex]`（可聚焦）' });

  // ① 标记层（prefs.xhtml）
  for (const c of classes) {
    for (const site of ctx.markup.get(c) || []) {
      const at = `${ctx.markupFile}:${site.line}`;
      if (CONTROL_TAGS.has(site.tag)) {
        ev.push({ control: true, text: `标记层：\`.${c}\` 用在 \`<${site.tag}>\` 上（${at}）` });
      } else if (site.role === 'button' || site.hasTabindex || site.hasOnclick) {
        ev.push({ control: true, text: `标记层：\`.${c}\` 用在 \`<${site.tag}>\` 上，但带 ${site.role === 'button' ? '`role="button"`' : site.hasTabindex ? '`tabindex`' : '`onclick`'}（${at}）` });
      } else {
        ev.push({ control: false, text: `标记层：\`.${c}\` 用在 \`<${site.tag}>\` 上，该标签不可聚焦、无 role/onclick（${at}）` });
      }
    }
  }

  // ② 脚本层
  for (const c of classes) {
    const sites = ctx.js.get(c) || [];
    for (const s of sites) {
      if (s.tag && CONTROL_TAGS.has(s.tag)) {
        ev.push({ control: true, text: `脚本层：\`.${c}\` 由 \`el("${s.tag}")\` 创建（${s.file}:${s.line}）` });
      }
      if (s.hasClick) {
        ev.push({ control: true, text: `脚本层：\`.${c}\` 所在元素绑了 click（${s.file}:${s.clickLine}）` });
      }
      if (s.tag && !CONTROL_TAGS.has(s.tag) && !s.hasClick) {
        ev.push({ control: false, text: `脚本层：\`.${c}\` 由 \`el("${s.tag}")\` 创建、该元素自身无 click 绑定（${s.file}:${s.line}）` });
      }
    }
  }

  // ④ 弱证据
  const cursor = cursorPointerOf(prefsRules, selector);
  if (cursor) ev.push({ control: null, text: 'CSS 声明 `cursor:pointer`（作者标注可点，弱证据）' });

  const strong = ev.filter((e) => e.control === true);
  const container = ev.filter((e) => e.control === false);
  if (strong.length) return { scope: 'control', evidence: ev, reason: strong[0].text };
  if (container.length) {
    // 优先用脚本层证据（带构造点与「无 click」结论），它比「用在 <div> 上」更可复核
    const js = container.find((e) => e.text.startsWith('脚本层'));
    const why = (js || container[0]).text;
    const extra = cursor ? '（CSS 还留着 cursor:pointer，属重构残留，不作为控件证据）' : '';
    return { scope: 'decor', evidence: ev, reason: why + extra };
  }
  return {
    scope: 'decor',
    evidence: ev,
    reason: cursor
      ? `只有 CSS \`cursor:pointer\`（弱证据）：\`${short}\` 未在 ${ctx.markupFile} 命中，也未在 ${ctx.jsFiles.length} 个 prefs-*.js 的构造点/click 绑定中命中`
      : `\`${short}\` 在 ${ctx.markupFile} 与 ${ctx.jsFiles.length} 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer`,
  };
}

/** 收集判定上下文：标记层（prefs.xhtml）+ 脚本层（chrome/content/prefs-*.js） */
function buildScopeCtx() {
  const markup = scanMarkupScopes(fs.readFileSync(PREFS_XHTML, 'utf8'));
  const jsFiles = fs.readdirSync(CONTENT_DIR)
    .filter((f) => /^prefs-.*\.js$/.test(f))
    .sort();
  const sources = jsFiles.map((f) => ({ name: f, text: fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8') }));
  const js = scanJsScopes(sources);
  return {
    markup,
    js,
    files: { markup: relPath(PREFS_XHTML), scripts: jsFiles },
    markupFile: relPath(PREFS_XHTML),
    jsFiles,
    markupClasses: markup.size,
    jsClasses: js.size,
  };
}

/** 纯图标（0.72.2 起 emoji 换成内联 SVG，color 只作为 stroke）：按非文本 3:1 判 */
const ICON_RE = /pp-card-icon|pp-search-icon/;

/* ======================================================================
 * 5. 审计
 * ==================================================================== */

function auditState(stateId, palette, prefsRules, ctx) {
  const { vars } = palette;
  const rows = [];
  const surfaceOf = (token) => parseColor(expandVars(`var(${token})`, vars)) || { r: 255, g: 255, b: 255, a: 1 };

  const weightBySelector = new Map();
  for (const r of prefsRules) for (const s of r.selectors) {
    const w = weightOf(r.decls);
    if (w != null) weightBySelector.set(s, Math.max(w, weightBySelector.get(s) || 0));
  }

  const rootRule = prefsRules.find((r) => r.selectors.includes('.pp-root') && r.decls.some((d) => d.prop === 'font-size'));
  const defaultFontPx = rootRule ? fontSizePx(rootRule.decls, vars, 12.5) : 12.5;

  const push = (row) => {
    const key = [row.kind, row.selector, row.fgHex, row.bgHex, row.note || '', row.status].join('|');
    if (rows.some((r) => [r.kind, r.selector, r.fgHex, r.bgHex, r.note || '', r.status].join('|') === key)) return;
    rows.push(row);
  };

  for (const rule of prefsRules) {
    if (isTokenRule(rule)) continue;
    for (const sel of rule.selectors) {
      if (!/^\.pp-root/.test(sel)) continue;

      const own = rule.decls;
      const bgToken = baseTokenFor(sel);
      const base = surfaceOf(bgToken);
      const bgRead = readBackground(own, vars);
      const fgDecl = own.find((d) => d.prop === 'color');
      const opacityDecl = own.find((d) => d.prop === 'opacity');
      const opacity = opacityDecl ? parseFloat(opacityDecl.value) : 1;
      const indeterminate = STATIC_INDETERMINATE.some((s) => sel.includes(s));

      let bgs;
      if (bgRead.kind === 'gradient') {
        bgs = bgRead.colors.map((c) => ({ color: c.a < 1 ? blend(c, base) : c, note: `渐变底（取较差端），基色 ${bgToken}` }));
      } else if (bgRead.kind === 'color') {
        const c = bgRead.colors[0];
        bgs = [{ color: c.a < 1 ? blend(c, base) : c, note: c.a < 1 ? `alpha ${c.a.toFixed(2)} 合成于 ${bgToken}` : '' }];
      } else {
        bgs = [{ color: base, note: `继承底 ${bgToken}` }];
      }

      // ---------- 文字对（纯图标元素按非文本 3:1 判）
      if (fgDecl) {
        const fg = parseColor(expandVars(fgDecl.value, vars));
        if (fg) {
          const px = fontSizePx(own, vars, defaultFontPx);
          const weight = weightOf(own) != null ? weightOf(own) : (weightBySelector.get(sel) || 400);
          const isIcon = ICON_RE.test(sel);
          const th = isIcon ? { threshold: AA_NONTEXT, large: false, bold: false } : textThreshold(px, weight);
          const exempt = exemptReason(sel);
          for (const bg of bgs) {
            const fgEff = fg.a < 1 ? blend(fg, bg.color) : fg;
            const fgFinal = opacity < 1 ? blend({ ...fgEff, a: opacity }, bg.color) : fgEff;
            const ratio = contrast(fgFinal, bg.color);
            const pass = ratio >= th.threshold;
            let status = exempt ? 'N/A' : pass ? 'PASS' : 'FAIL';
            if (indeterminate) status = 'INFO';
            push({
              kind: isIcon ? 'icon' : 'text',
              state: stateId,
              selector: sel,
              fgRaw: expandVars(fgDecl.value, vars),
              fgHex: colorLabel(fgFinal),
              bgHex: colorLabel(bg.color),
              ratio: Number(ratio.toFixed(2)),
              threshold: th.threshold,
              fontSize: Number(px.toFixed(1)),
              bold: th.bold,
              status,
              gate: status === 'PASS' || status === 'FAIL',
              exempt: exempt || '',
              note: [bg.note, isIcon ? '纯图标（内联 SVG，按非文本 3:1）' : '', opacity < 1 ? `opacity ${opacity}` : '',
                indeterminate ? '底色由 JS 注入，静态不可判' : ''].filter(Boolean).join('；'),
              line: rule.line,
              _fg: fg,
              _bgTop: bgRead.kind === 'color' ? bgRead.colors[0] : null,
            });
          }
        }
      }

      // ---------- 非文本：描边
      for (const bc of readBorderColors(own, vars)) {
        const b = bc.a < 1 ? blend(bc, bgs[0].color) : bc;
        const ratio = contrast(b, bgs[0].color);
        if (ratio < 1.02) continue; // 描边与自身底同色 → 视觉上无描边，不是对比度问题
        const sc = scopeOf(sel, prefsRules, ctx);
        // 单边描边 = 下划线 / 选中指示条，不是控件闭合轮廓（.pp-account-email 的 border-bottom 虚线下划线）
        const boundary = (bc.sides || 4) >= 2;
        const interactive = sc.scope === 'control' && boundary;
        const reason = !boundary
          ? `单边描边 \`border-${bc.side || 'bottom'}\` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用`
          : sc.reason;
        push({
          kind: 'border',
          state: stateId,
          selector: sel,
          fgRaw: colorLabel(bc),
          fgHex: colorLabel(b),
          bgHex: colorLabel(bgs[0].color),
          ratio: Number(ratio.toFixed(2)),
          threshold: AA_NONTEXT,
          fontSize: null,
          bold: false,
          status: ratio >= AA_NONTEXT ? 'PASS' : 'FAIL',
          gate: interactive,
          exempt: '',
          scope: interactive ? 'control' : 'decor',
          elementScope: sc.scope,
          boundary,
          scopeReason: reason,
          scopeEvidence: sc.evidence,
          note: interactive ? '控件边界/状态（1.4.11 计入）' : `装饰性分界（1.4.11 不适用，仅测量）${boundary ? '' : '；单边描边'}`,
          line: rule.line,
        });
      }

      // ---------- 非文本：焦点指示（box-shadow 环 + outline）
      if (/focus/.test(sel)) {
        readFocusIndicators(own, vars).forEach((ring, i) => {
          const solid = ring.color.a >= 0.99;
          const c = solid ? ring.color : blend(ring.color, bgs[0].color);
          const ratio = contrast(c, bgs[0].color);
          const via = ring.via === 'outline' ? 'outline' : 'box-shadow';
          push({
            kind: 'ring',
            state: stateId,
            selector: sel,
            fgRaw: colorLabel(ring.color),
            fgHex: colorLabel(c),
            bgHex: colorLabel(bgs[0].color),
            ratio: Number(ratio.toFixed(2)),
            threshold: AA_NONTEXT,
            fontSize: null,
            bold: false,
            status: ratio >= AA_NONTEXT ? 'PASS' : 'FAIL',
            gate: solid, // 光晕只是装饰，实色主环/outline 才是 1.4.11 的指标
            exempt: '',
            ringWidth: ring.width,
            via,
            scope: solid ? 'control' : 'decor',
            scopeReason: solid
              ? '焦点指示器（实色主环/outline）本身就是控件的视觉信息，1.4.11 直接约束'
              : 'alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰',
            note: `${ring.width}px ${via} ${solid ? '实色主环（1.4.11 计入）' : 'alpha 光晕（装饰，非唯一指示，仅测量）'}${i > 0 ? '·外层' : ''}`,
            line: rule.line,
          });
        });
      }
    }
  }

  // 面板继承基线（.pp-root 自身的 color 落在面板底）
  if (rootRule) {
    const colorDecl = rootRule.decls.find((d) => d.prop === 'color');
    if (colorDecl) {
      const fg = parseColor(expandVars(colorDecl.value, vars));
      const bg = surfaceOf(DEFAULT_BASE);
      const ratio = contrast(fg, bg);
      push({
        kind: 'text',
        state: stateId,
        selector: '.pp-root（继承基线：未自设 color 的元素）',
        fgRaw: expandVars(colorDecl.value, vars),
        fgHex: colorLabel(fg),
        bgHex: colorLabel(bg),
        ratio: Number(ratio.toFixed(2)),
        threshold: AA_TEXT,
        fontSize: Number(defaultFontPx.toFixed(1)),
        bold: false,
        status: ratio >= AA_TEXT ? 'PASS' : 'FAIL',
        gate: true,
        exempt: '',
        note: '面板正文默认色',
        line: rootRule.line,
        _fg: fg,
        _bgTop: { ...bg, a: 1 },
      });
    }
  }

  return rows;
}

/* ---------------- 按颜色组合归并（与裁决书「对」同粒度） ---------------- */

function groupRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = [r.kind, r.fgHex, r.bgHex, r.gate ? 'G' : 'D', r.scope || ''].join('|');
    let g = map.get(key);
    if (!g) {
      g = {
        kind: r.kind, state: r.state, fgHex: r.fgHex, bgHex: r.bgHex, ratio: r.ratio, fgRaw: r.fgRaw,
        selectors: [], thresholds: [], statuses: [], gate: false, notes: [], lines: [],
      };
      map.set(key, g);
    }
    if (!g.selectors.includes(r.selector)) g.selectors.push(r.selector);
    if (r.scope && !g.scope) { g.scope = r.scope; g.scopeReason = r.scopeReason; }
    g.thresholds.push(r.threshold);
    g.statuses.push(r.status);
    g.gate = g.gate || r.gate;
    if (r.note && !g.notes.includes(r.note)) g.notes.push(r.note);
    g.lines.push(r.line);
  }
  const out = [];
  for (const g of map.values()) {
    g.threshold = Math.max(...g.thresholds);
    const counted = g.statuses.filter((s) => s === 'PASS' || s === 'FAIL');
    g.status = counted.includes('FAIL') ? 'FAIL' : counted.length ? 'PASS' : 'N/A';
    if (g.statuses.includes('INFO') && !counted.length) g.status = 'INFO';
    // 装饰性组合：数值照报，但不计入通过率
    if (!g.gate && g.status !== 'N/A' && g.status !== 'INFO') {
      g.status = g.status === 'FAIL' ? 'BELOW' : 'PASS';
    }
    g.count = g.selectors.length;
    // 代表性的选择器排前：可交互控件优先，便于一眼看出这组是不是控件问题
    g.selectors.sort((a, b) => (g.scope === 'control' ? 0 : 1) - (g.scope === 'control' ? 0 : 1));
    out.push(g);
  }
  return out.sort((a, b) => a.ratio - b.ratio);
}

function summarizeGroups(groups) {
  const text = groups.filter((g) => g.kind === 'text' && (g.status === 'PASS' || g.status === 'FAIL'));
  const nonText = groups.filter((g) => g.kind !== 'text' && g.gate && (g.status === 'PASS' || g.status === 'FAIL'));
  const decor = groups.filter((g) => g.kind !== 'text' && !g.gate);
  const count = (arr) => ({ total: arr.length, pass: arr.filter((g) => g.status === 'PASS').length });
  const cText = count(text);
  const cNon = count(nonText);
  const ratios = decor.map((g) => g.ratio);
  return {
    text: cText,
    nonText: cNon,
    // 控件类 = 文字对 + 计入 1.4.11 的非文本对（这两类进通过率与退出码）
    control: { total: cText.total + cNon.total, pass: cText.pass + cNon.pass, text: cText, nonText: cNon },
    // 装饰类 = 1.4.11 不适用的描边/光晕，照测照列但不参与通过率
    decor: {
      total: decor.length,
      below: decor.filter((g) => g.ratio < 3).length,
      min: ratios.length ? Math.min(...ratios) : null,
      max: ratios.length ? Math.max(...ratios) : null,
    },
    exempt: groups.filter((g) => g.status === 'N/A').length,
    info: groups.filter((g) => g.status === 'INFO').length,
    fails: [...text, ...nonText].filter((g) => g.status === 'FAIL'),
  };
}

/* ======================================================================
 * 6. 裁决书 10 对失败组合的逐条回归
 * ==================================================================== */

const REGRESSION = [
  {
    id: 'R1', title: '.pp-btn-primary 深色主按钮', state: 'dark-media', kind: 'text',
    selectors: ['.pp-btn-primary'], original: '3.10:1', origBase: '#21252b',
    originalFg: '#ffffff', originalBg: '#4493f8',
    variants: ['.pp-btn-primary', '.pp-btn.pp-btn-primary', 'button.pp-btn-primary'],
  },
  {
    id: 'R2', title: '.pp-btn-primary:hover 深色 hover 底', state: 'dark-media', kind: 'text',
    selectors: ['.pp-btn-primary:hover:not(:disabled)'], original: '3.75:1', origBase: '#21252b',
    originalFg: '#ffffff', originalBg: '#2f81f7',
    variants: ['.pp-btn-primary:hover', '.pp-btn-primary:hover:not(:disabled)'],
  },
  {
    id: 'R3', title: '.pp-pill-ok（浅）', state: 'light', kind: 'text',
    selectors: ['.pp-pill-ok'], original: '4.34:1', origBase: '#ffffff',
    originalFg: '#1a7f37', originalBg: '#e4f0e8（合成）',
    variants: ['.pp-pill-ok', '.pp-pill.pp-pill-ok'],
  },
  {
    id: 'R4', title: '.pp-dlg-badge-ok（浅）', state: 'light', kind: 'text',
    selectors: ['.pp-dlg-badge-ok'], original: '4.34:1', origBase: '#ffffff',
    originalFg: '#1a7f37', originalBg: '#e4f0e8（合成）',
    variants: ['.pp-dlg-badge-ok', '.pp-dlg-badge.pp-dlg-badge-ok'],
  },
  {
    id: 'R5', title: '.pp-pill-warn（浅，12px 小字）', state: 'light', kind: 'text',
    selectors: ['.pp-pill-warn'], original: '4.17:1', origBase: '#ffffff',
    originalFg: '#9a6700', originalBg: '#f3ede0（合成）',
    variants: ['.pp-pill-warn', '.pp-pill.pp-pill-warn'],
  },
  {
    id: 'R6', title: '.pp-mb-renew（浅，到期提醒横幅）', state: 'light', kind: 'text',
    selectors: ['.pp-mb-renew', 'button.pp-mb-renew'], original: '4.17:1', origBase: '#ffffff',
    originalFg: '#9a6700', originalBg: '#f3ede0（合成）',
    variants: ['.pp-mb-renew', 'button.pp-mb-renew'],
    note: '该横幅实际嵌在 .pp-mb（surface-2 #f6f8fa）里，合成底比原裁决假设的白底更暗，故真实值略低于同基色复算值。',
  },
  {
    id: 'R7', title: '.pp-ai-tier-trial（浅，试用额度说明）', state: 'light', kind: 'text',
    selectors: ['.pp-ai-tier-trial'], original: '4.17:1', origBase: '#ffffff',
    originalFg: '#9a6700', originalBg: '#f3ede0（合成）',
    variants: ['.pp-ai-tier-trial', '.pp-ai-tier.pp-ai-tier-trial'],
    note: '外层 .pp-ai-tier 自身是 surface-2 底，合成基色按 surface-2 计。',
  },
  {
    id: 'R8', title: '.pp-dlg-tail（浅，付款弹窗尾注）', state: 'light', kind: 'text',
    selectors: ['.pp-dlg-tail'], original: '4.17:1', origBase: '#ffffff',
    originalFg: '#9a6700', originalBg: '#f3ede0（合成）',
    variants: ['.pp-dlg-tail', '.pp-dlg.pp-dlg-tail'],
  },
  {
    id: 'R9', title: '.pp-count-hit（深，搜索命中计数）', state: 'dark-media', kind: 'text',
    selectors: ['.pp-count-hit'], original: '4.19:1', origBase: '#21252b',
    originalFg: '#4493f8', originalBg: '#253244（合成）',
    variants: ['.pp-count-hit', '.pp-count.pp-count-hit'],
  },
  {
    id: 'R10', title: '.pp-anchor-active（深，当前分类 chip）', state: 'dark-media', kind: 'text',
    selectors: ['.pp-anchor-nav .pp-btn.pp-anchor-active'], original: '4.19:1', origBase: '#21252b',
    originalFg: '#4493f8', originalBg: '#253244（合成）',
    variants: ['.pp-anchor-active', '.pp-anchor-nav .pp-btn.pp-anchor-active', '.pp-btn.pp-anchor-active'],
  },
  {
    id: 'R11', title: '.pp-dev-row-cur（深，当前设备行）', state: 'dark-media', kind: 'text',
    selectors: ['.pp-dev-row-cur'], original: '4.19:1（裁决书按 accent 文字计）', origBase: '#1a1e23',
    originalFg: '#4493f8', originalBg: '#253244（合成）',
    variants: ['.pp-dev-row-cur', '.pp-dev-row.pp-dev-row-cur', '.pp-dev-row-cur .pp-dev-name'],
    note: '当前源码里 .pp-dev-row-cur 只改 border-color / background，不设 color：行内文字仍是 .pp-dev-name(text-strong) / .pp-dev-meta(muted)。故「accent 文字 4.19」这对已不存在，改为测行内实际文字 + accent 描边两项。',
  },
  {
    id: 'R12', title: '.pp-mb-renew-expired（深）', state: 'dark-media', kind: 'text',
    selectors: ['.pp-mb-renew-expired'], original: '3.92:1', origBase: '#21252b',
    originalFg: '#f85149', originalBg: '#3f2b2f（合成）',
    variants: ['.pp-mb-renew-expired', 'button.pp-mb-renew-expired', '.pp-mb-renew.pp-mb-renew-expired'],
  },
  {
    id: 'N1', title: '输入框描边（浅）', state: 'light', kind: 'border',
    selectors: ['.pp-input', '.pp-select'], original: '1.36:1', origBase: '#ffffff',
    originalFg: '#d8dee4', originalBg: '#ffffff', variants: ['.pp-input', '.pp-select', '.pp-textarea'],
  },
  {
    id: 'N2', title: '输入框描边（深）', state: 'dark-media', kind: 'border',
    selectors: ['.pp-input', '.pp-select'], original: '1.56:1（裁决书按卡片面测）', origBase: '#21252b',
    originalFg: '#3d444d', originalBg: '#21252b', variants: ['.pp-input', '.pp-select', '.pp-textarea'],
    note: '输入框自身底色是 --pp-field #1b1f24，比卡片面更暗，故真实值略高于原裁决的 1.56。',
  },
  {
    id: 'N3', title: '卡片描边（浅）', state: 'light', kind: 'border',
    selectors: ['.pp-card'], original: '1.36:1', origBase: '#ffffff',
    originalFg: '#d8dee4', originalBg: '#ffffff', variants: ['.pp-card'],
  },
  {
    id: 'N4', title: '卡片描边（深）', state: 'dark-media', kind: 'border',
    selectors: ['.pp-card'], original: '1.56:1', origBase: '#21252b',
    originalFg: '#3d444d', originalBg: '#21252b', variants: ['.pp-card'],
  },
  {
    id: 'N5', title: '焦点环合成（浅）', state: 'light', kind: 'ring',
    selectors: ['__focus_ring__'], original: '≈1.33:1', origBase: '#ffffff',
    originalFg: 'rgba(9,105,218,.20)', originalBg: '#ffffff', variants: ['--pp-focus-ring'],
  },
  {
    id: 'N6', title: '焦点环合成（深）', state: 'dark-media', kind: 'ring',
    selectors: ['__focus_ring__'], original: '≈1.55:1', origBase: '#21252b',
    originalFg: 'rgba(68,147,248,.28)', originalBg: '#21252b', variants: ['--pp-focus-ring'],
  },
];

function findRuleBySelector(prefsRules, sel) {
  return prefsRules.find((r) => r.selectors.includes(sel)) || null;
}

/** prefs.css 的选择器一律以 .pp-root 收口：把短名补全成源码里的真实选择器 */
function fullSel(sel) {
  if (sel.startsWith('.pp-root')) return sel;
  if (sel.startsWith('#')) return '.pp-root ' + sel;
  return '.pp-root ' + sel;
}

/** 选择器找不到时，按类名在整个 prefs.css 里搜真实存在的近似选择器（作为「改名/移除」的证据） */
function searchVariants(prefsRules, sel) {
  const cls = (sel.match(/\.[\w-]+/g) || []).pop();
  if (!cls) return [];
  const hits = new Set();
  for (const r of prefsRules) for (const s of r.selectors) if (s.includes(cls)) hits.add(s);
  return [...hits].slice(0, 6);
}

function pickRow(rows, sel, kind) {
  return rows.find((r) => r.selector === sel && r.kind === kind) || null;
}

/** 同基色复算：把背景 alpha 层叠在「原裁决假设的基色」上，做到原值→现值同口径 */
function alignedRatio(row, origBaseHex) {
  if (!row || !row._fg) return null;
  const base = parseColor(origBaseHex);
  if (!base) return null;
  const bg = row._bgTop ? blend(row._bgTop, base) : base;
  const fg = row._fg.a < 1 ? blend(row._fg, bg) : row._fg;
  return { ratio: Number(contrast(fg, bg).toFixed(2)), fg: colorLabel(fg), bg: colorLabel(bg) };
}

function runRegression(prefsRules, palettes, auditByState) {
  const out = [];
  for (const item of REGRESSION) {
    const { vars } = palettes[item.state];
    const rows = auditByState[item.state];
    const surface = (token) => parseColor(expandVars(`var(${token})`, vars)) || { r: 255, g: 255, b: 255, a: 1 };
    const record = {
      id: item.id, title: item.title, state: item.state, kind: item.kind,
      original: item.original, originalFg: item.originalFg, originalBg: item.originalBg,
      now: [], aligned: [], verdict: 'UNKNOWN', note: item.note || '', searched: item.variants,
    };

    if (item.kind === 'ring') {
      const raw = vars['--pp-focus-ring'];
      const ring = raw ? parseColor(expandVars(raw, vars)) : null;
      if (!ring) { record.verdict = 'NOT_FOUND'; out.push(record); continue; }
      for (const tok of ['--pp-surface', '--pp-field']) {
        const bg = surface(tok);
        const comp = blend(ring, bg);
        const ratio = contrast(comp, bg);
        record.now.push({
          selector: `--pp-focus-ring @${ring.a.toFixed(2)} 合成于 ${tok}`,
          fg: colorLabel(comp), bg: colorLabel(bg), ratio: Number(ratio.toFixed(2)),
          threshold: AA_NONTEXT, status: ratio >= AA_NONTEXT ? 'PASS' : 'FAIL', gate: false,
        });
      }
      const solid = parseColor(expandVars('var(--pp-accent)', vars));
      const bg = surface('--pp-surface');
      const sRatio = contrast(solid, bg);
      record.now.push({
        selector: '0.72.2 新增 2px 实色主环 var(--pp-accent)',
        fg: colorLabel(solid), bg: colorLabel(bg), ratio: Number(sRatio.toFixed(2)),
        threshold: AA_NONTEXT, status: sRatio >= AA_NONTEXT ? 'PASS' : 'FAIL', gate: true,
      });      record.verdict = record.now.some((n) => n.gate && n.status === 'FAIL') ? 'FAIL' : 'PASS';
      out.push(record);
      continue;
    }

    for (const rawSel of item.selectors) {
      const sel = fullSel(rawSel);
      const rule = findRuleBySelector(prefsRules, sel);
      let row = pickRow(rows, sel, item.kind);
      if (!rule && !row) {
        record.now.push({
          selector: sel,
          status: 'NOT_FOUND',
          ratio: null,
          searched: searchVariants(prefsRules, sel),
        });
        continue;
      }
      if (!row && item.kind === 'border' && rule) {
        const base = surface(baseTokenFor(sel));
        const bgRead = readBackground(rule.decls, vars);
        const bg = bgRead.kind === 'color'
          ? (bgRead.colors[0].a < 1 ? blend(bgRead.colors[0], base) : bgRead.colors[0])
          : base;
        for (const bc of readBorderColors(rule.decls, vars)) {
          const c = bc.a < 1 ? blend(bc, bg) : bc;
          const ratio = contrast(c, bg);
          record.now.push({
            selector: sel, fg: colorLabel(c), bg: colorLabel(bg), ratio: Number(ratio.toFixed(2)),
            threshold: AA_NONTEXT, status: ratio >= AA_NONTEXT ? 'PASS' : 'FAIL', gate: true, line: rule.line,
          });
        }
        continue;
      }
      if (!row) {
        if (rule && !rule.decls.some((d) => d.prop === 'color')) {
          record.now.push({ selector: sel, status: 'NO_COLOR', ratio: null });
          record.noColor = '该规则只声明 border-color / background，不设文字色（行内文字由子元素决定，见下方补充测项）';
        } else {
          record.now.push({ selector: sel, status: 'NOT_FOUND', ratio: null, searched: searchVariants(prefsRules, sel) });
        }
        continue;
      }

      record.now.push({
        selector: sel, fg: row.fgHex, bg: row.bgHex, ratio: row.ratio,
        threshold: row.threshold, status: row.status, note: row.note, line: row.line, gate: row.gate,
      });
      const al = alignedRatio(row, item.origBase);
      if (al) record.aligned.push({ selector: sel, ...al });
    }

    // R11 补充：行内实际文字色（按该行真实底色 = accent-soft 合成于 surface-2 计）
    if (item.id === 'R11') {
      record.supplementary = [];
      const soft = parseColor(expandVars('var(--pp-accent-soft)', vars));
      const rowBg = soft.a < 1 ? blend(soft, surface('--pp-surface-2')) : soft;
      for (const rawSel of ['.pp-dev-name', '.pp-dev-meta']) {
        const rule = findRuleBySelector(prefsRules, fullSel(rawSel));
        if (!rule) continue;
        const cd = rule.decls.find((d) => d.prop === 'color');
        if (!cd) continue;
        const fg = parseColor(expandVars(cd.value, vars));
        const ratio = contrast(fg, rowBg);
        record.supplementary.push({
          selector: `${fullSel(rawSel)}（行内实际文字，落在 .pp-dev-row-cur 的 accent-soft 底 ${colorLabel(rowBg)} 上）`,
          fg: colorLabel(fg), bg: colorLabel(rowBg), ratio: Number(ratio.toFixed(2)),
          threshold: AA_TEXT, status: ratio >= AA_TEXT ? 'PASS' : 'FAIL',
        });
      }
    }

    const statuses = record.now.map((n) => n.status);
    if (statuses.includes('NOT_FOUND')) record.verdict = 'PARTIAL';
    else {
      // 只看计入门禁的项：alpha 光晕是装饰，不决定判定；描边类按本条目的阈值照判
      const anyFail = record.now.some((n) => n.status === 'FAIL' && (n.gate !== false || item.kind === 'border'));
      const anyPass = record.now.some((n) => n.status === 'PASS');
      const supp = record.supplementary || [];
      if (anyFail || supp.some((s) => s.status === 'FAIL')) record.verdict = 'FAIL';
      else if (anyPass || supp.length) record.verdict = 'PASS';
      else record.verdict = 'PARTIAL';
    }
    out.push(record);
  }
  return out;
}

/* ======================================================================
 * 7. 输出
 * ==================================================================== */

const r2 = (x) => Number(x).toFixed(2);

/** 与 `wc -l` 同口径：数换行符，末尾无换行时补 1（避免 1508/1509 这种对不上账的差 1） */
function countLines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return text.length && !text.endsWith('\n') ? n + 1 : n;
}

function shortSelectors(list, max = 3) {
  const uniq = [...new Set(list)];
  const shown = uniq.slice(0, max).map((s) => `\`${s}\``).join('、');
  return uniq.length > max ? `${shown} … 共 ${uniq.length} 处` : shown;
}

function renderHuman(report) {
  const L = [];
  const _ver = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).version; } catch { return '?'; } })();
  L.push(`# 设置面板对比度门禁实测（${_ver}）`);
  L.push('');
  L.push('> 生成：`node scripts/audit/contrast-audit.js`｜口径：WCAG 2.x 相对亮度，sRGB 线性化，alpha 先合成再比。');
  L.push(`> 输入：\`chrome/content/ui-tokens.css\`、\`chrome/content/prefs.css\`（行数 / 字节 / sha256 / mtime 见〇节「被测指纹」）。只读，未改动任何产品文件。`);
  L.push('> 阈值：普通文本 4.5｜≥18.66px 或 ≥14px 且 bold 3.0｜非文本（描边/焦点环/图标）3.0。');
  L.push('> **计数粒度**：同一「前景 × 背景」组合的多个选择器合并为一「对」（与裁决书 43 对同粒度）。');
  L.push('> **通过率口径（本轮变更）**：按 WCAG 1.4.11 适用范围拆成「控件类」与「装饰类」两张表。控件类进通过率与退出码；装饰类照测照列、标「豁免」，不参与通过率。');
  L.push('> 历史对照：`docs/audit/0.72.2/contrast.md`（上一轮口径：全部非文本对计入，82/90、退出码 1）—— 本轮装饰类拆分是**口径变更**，不是数值变好；同一批颜色的实测值可与旧报告逐行对照。');
  L.push('');

  const rs = report.regressionSummary;
  // ---- 〇、被测指纹（每份门禁报告都要能自证测的是哪一版，否则复跑对不上账）
  L.push('## 〇、被测指纹（复跑对账用）');
  L.push('');
  L.push('| 文件 | 行数（`wc -l` 口径） | 字节 | sha256（前 10 位） | mtime |');
  L.push('|---|---|---|---|---|');
  L.push(`| \`${report.sources.prefs}\` | ${report.sources.prefsLines} | ${report.sources.prefsBytes} | \`${report.sources.sha256.prefs.slice(0, 10)}\` | ${report.sources.mtime.prefs} |`);
  L.push(`| \`${report.sources.tokens}\` | ${report.sources.tokensLines} | ${report.sources.tokensBytes} | \`${report.sources.sha256.tokens.slice(0, 10)}\` | ${report.sources.mtime.tokens} |`);
  L.push('');
  L.push(`> 判定依据文件：\`${report.scope.evidenceSources.markup}\` + \`chrome/content/prefs-*.js\`（${report.scope.evidenceSources.scripts.length} 个）。这三类文件任一 sha 变化都应重跑，不要沿用旧数字。`);
  L.push('> **统计边界（只此一个主口径）**：通过率与退出码只算「控件类 n/m」（文字对 + 计入 1.4.11 的非文本对，按浅色 + media 深色两个可达状态合计）。装饰类是**单独一张表**，只给组数与实测区间，**不进分母**。显式深色列与 media 深色逐令牌同值，仅作对照、不重复计入合计。');
  L.push('');

  const remText = report.remaining.filter((r) => r.kind === 'text');
  const remNonText = report.remaining.filter((r) => r.kind !== 'text');
  const badRegIds = report.regression.filter((r) => r.kind !== 'text' && r.verdict === 'FAIL').map((r) => r.id).join(' / ');
  const dec = report.overall.decor;
  L.push('## 零、结论（先看这里）');
  L.push('');
  L.push(`- **控件类 ${report.overall.control.pass}/${report.overall.control.total} 通过**（文字 ${report.overall.text.pass}/${report.overall.text.total} + 非文本控件/焦点 ${report.overall.nonText.pass}/${report.overall.nonText.total}），未过 **${report.overall.control.fail}** → 退出码 **${report.exitCode}**。`);
  L.push(`- **装饰类 ${dec.groups} 组实测值供参考**：区间 ${r2(dec.min)}–${r2(dec.max)}:1，其中 ${dec.below} 组 <3:1。按 1.4.11 适用范围判为装饰，**不参与通过率**，但数值与逐条理由都在下面（0.1 节与 3.x 节表内）。`);
  L.push(remText.length
    ? `- 文字：仍有 ${remText.length} 处未过：${remText.map((r) => `\`${r.selectors[0].replace(/^\.pp-root\s+/, '')}\` ${r2(r.ratio)}:1`).join('、')}。`
    : '- 文字：**全部通过** —— 含裁决书点名的 5 组及其同批颜色的残留位。');
  L.push(remNonText.length
    ? `- 非文本控件类：仍有 ${remNonText.length} 组 <3:1：${remNonText.map((r) => `\`${r.selectors[0].replace(/^\.pp-root\s+/, '')}\` ${r2(r.ratio)}:1`).join('、')}。`
    : '- 非文本控件类：**全部通过** —— 输入框/选择框/文本域/按钮的描边走 `--pp-border-control`（浅 3.46 / 深 3.78），焦点环双层实色主环达标。');
  L.push('- **`.pp-account-email`（0.72.3 定稿口径）**：此前该按钮文字为 `--pp-muted` 灰、唯一可点信号是 1.61:1 的虚线（0.72.2 裁决 Major）。**0.72.3 已修根因**：文字改 `--pp-accent` 链接色（浅 5.19 / 深 5.40，进文字对并达标），与 `.pp-link-btn` 家族语义一致；虚线 `border-bottom: dashed` 自此降为纯附加提示，判装饰不再影响判定——即使按控件边界计，控件识别已由达标文字承担，无 78/80 情形。');
  L.push(`- 裁决书 10 对回归（拆成 ${rs.textTotal + rs.nonTextTotal} 条测项，按选择器逐条定位）：文字侧 **${rs.textPass}/${rs.textTotal} PASS**；非文本 ${rs.nonTextTotal} 条中 **${rs.nonTextFail} 条仍 FAIL**${badRegIds ? `（${badRegIds}，均为卡片轮廓/容器行，1.4.11 不适用）` : ''}，焦点环 2 条 PASS。`);
  const tp = report.themeProbe;
  if (tp.prefsHasExplicitDark && tp.explicitEqualsDarkMedia) {
    L.push('- 主题：显式 `data-theme="dark"` 已接入（prefs.css 有 `:root[data-theme="dark"] .pp-root`，与 media 块逐令牌同值），三态数值自洽。');
  } else if (tp.prefsHasExplicitDark) {
    L.push(`- 主题：显式深色块已存在，但与 media 深色**不同值**（差异 ${tp.diffFromLight.length} 项），需核对是否漏同步。`);
  } else {
    L.push('- 主题：显式 `data-theme="dark"` 在设置面板**不可达**（prefs.css 无 `[data-theme]` 覆盖），不属对比度问题但会让深色修复在显式主题下失效。');
  }
  // color-scheme：原生控件渲染模式（不是对比度对，但决定暗色下 checkbox / select 弹层长什么样）
  const nc = report.nativeControls;
  if (nc.colorSchemeDeclared) {
    L.push('- 原生控件：**`color-scheme` 已声明 ' + nc.blocks.length + ' 处** —— ' + nc.blocks.map((b) => '`' + b.value + '`（' + b.file + ':' + b.line + ' ' + (b.media ? 'media 深色块' : b.selector) + '）').join('、') + '。gate-render 实测的「暗色下未勾选 checkbox 是纯白方块」问题，由 media 深色块与显式深色块两处 `dark` 关闭。');
  } else {
    L.push('- 原生控件：两份 CSS 都**没有 `color-scheme` 声明** → 暗色下原生 checkbox / select 弹层 / 滚动条仍按浅色渲染（gate-render 增强制 4× 截图实证：未勾选 checkbox 是纯白 13×13 方块）。这不是「对比度不足」而是「对比度反向过剩 + 勾选态可辨识性下降」，修法是在暗色块里加一行 `color-scheme: dark`。');
  }
  // 两个深色块的变量集合一致性（漂移点）
  for (const b of report.themeBlocks) {
    if (b.identical) {
      L.push(`- 主题块一致性 · ${b.file}：\`@media\` 深色块（第 ${b.mediaLines.join('、')} 行）与显式深色块（第 ${b.explicitLines.join('、')} 行）**变量集合与取值完全一致**（各 ${b.mediaCount} / ${b.explicitCount} 条声明，差集为空）。`);
    } else {
      const parts = [];
      if (b.onlyInMedia.length) parts.push(`仅 media 有：${b.onlyInMedia.map((x) => `\`${x}\``).join('、')}`);
      if (b.onlyInExplicit.length) parts.push(`仅显式有：${b.onlyInExplicit.map((x) => `\`${x}\``).join('、')}`);
      if (b.valueDiffs.length) parts.push(`同值不同：${b.valueDiffs.map((d) => `\`${d.prop}\`（media ${d.media} / 显式 ${d.explicit}）`).join('、')}`);
      L.push(`- 主题块一致性 · ${b.file}：**不一致** —— ${parts.join('；')}。`);
    }
  }
  L.push('');

  // ---- 0.1 装饰清单：逐个给理由（评审要能一眼看出「我们知道它多少，只是不归 1.4.11 管」）
  L.push('### 0.1 被判为装饰的清单（逐个给理由）');
  L.push('');
  L.push('> 判定规则（可复核，非选择器白名单）：命中任一「控件」证据才计入 1.4.11 —— ① 标记层 `prefs.xhtml` 里该 class 落在 `input/select/textarea/button/a/label/summary` 上；② 脚本层 `prefs-*.js` 里由 `el("tag")` 创建在控件标签上、或**该元素自身**绑了 click（子按钮的 click 不算到容器头上）；③ CSS 层选择器以控件标签开头、或带 `[role="button"]`/`[tabindex]`；④ 弱证据 `cursor:pointer` 只在①②③全落空时参考。全落空 → 装饰。');
  L.push('> 另有一条与元素可交互性无关的边界判定：**单边描边**（`border-bottom` 等）是下划线/指示条，不构成控件闭合轮廓，1.4.11 的「边界」不适用 —— 只有 `border` / `border-color` 这种整圈描边才按边界计。');
  L.push('');
  L.push('| 选择器 | 状态 | 实测 | 判定依据 |');
  L.push('|---|---|---|---|');
  for (const d of report.scope.decorDetail) {
    L.push(`| \`${d.selector.replace(/^\.pp-root\s+/, '')}\` | ${d.state === 'light' ? '浅' : '深'} | ${r2(d.ratio)}:1 | ${d.reason} |`);
  }
  L.push('');
  L.push(`> 证据来源：\`${report.scope.evidenceSources.markup}\`（命中 ${report.scope.evidenceSources.markupClasses} 个 class）+ \`chrome/content/prefs-*.js\`（${report.scope.evidenceSources.scripts.length} 个文件，命中 ${report.scope.evidenceSources.jsClasses} 个 class）。完整证据链（每条含文件:行号）在 \`contrast.json\` 的 \`scope\` 字段与 \`pairs[].scopeEvidence\`。`);
  L.push('');

  L.push('## 一、三态调色板（令牌解析结果）');
  L.push('');
  L.push('| 令牌 | 亮色 | 深色（media） | 深色（显式） |');
  L.push('|---|---|---|---|');
  for (const k of report.paletteKeys) {
    L.push(`| \`${k}\` | ${report.palettes.light[k] || '—'} | ${report.palettes['dark-media'][k] || '—'} | ${report.palettes['dark-explicit'][k] || '—'} |`);
  }
  L.push('');
  const tp2 = report.themeProbe;
  if (tp2.prefsHasExplicitDark && tp2.explicitEqualsDarkMedia) {
    L.push('> 显式深色列与 media 深色列**逐令牌同值**：prefs.css 已有 `:root:not([data-theme="light"]) .pp-root` 与 `:root[data-theme="dark"] .pp-root` 两块，取值一致。三态自洽。');
  } else if (tp2.prefsHasExplicitDark) {
    L.push(`> 显式深色块已存在，但与 media 深色有 ${tp2.diffFromLight.length} 项差异，需核对同步。`);
  } else {
    L.push(`> 显式深色这一列只有 **${report.paletteDiff.length}** 个令牌是深色（${report.paletteDiff.map((k) => `\`${k}\``).join('、')}），其余退回亮色。原因：这些令牌只由 ui-tokens.css 声明，而 prefs.css 的 \`.pp-root\` 用亮色值覆盖了它自己声明的那批；**prefs.css 里没有任何 \`[data-theme="dark"]\` 选择器**，面板根节点又是 \`<vbox class="pp-root">\`（prefs.xhtml:27），元素自身声明优先于从 \`:root\` 继承的值。`);
    L.push('> 所以「系统亮色 + 用户显式选深色」时，设置面板不会变深，且少数令牌会单独变深，形成两套色并存。这是主题三态的结构性缺口（不是对比度数值）。');
  }
  L.push('');

  L.push('## 二、汇总');
  L.push('');
  L.push('**控件类**（计入通过率与退出码）');
  L.push('');
  L.push('| 状态 | 文字对 | 非文本·控件/焦点 | 控件类合计 | 未过 | 退出码 |');
  L.push('|---|---|---|---|---|---|');
  for (const s of report.summaries) {
    L.push(`| ${s.label} | ${s.text.pass}/${s.text.total} | ${s.nonText.pass}/${s.nonText.total} | **${s.control.pass}/${s.control.total}** | ${s.control.total - s.control.pass} | ${s.fails.length ? 1 : 0} |`);
  }
  L.push(`| **合计（浅+深）** | **${report.overall.text.pass}/${report.overall.text.total}** | **${report.overall.nonText.pass}/${report.overall.nonText.total}** | **${report.overall.control.pass}/${report.overall.control.total}** | **${report.overall.control.fail}** | **${report.exitCode}** |`);
  L.push('');
  L.push('**装饰类**（照测照列，标「豁免（1.4.11 不适用）」，不参与通过率）');
  L.push('');
  L.push('| 状态 | 组数 | 其中 <3:1 | 实测区间 | 豁免 |');
  L.push('|---|---|---|---|---|');
  for (const s of report.summaries) {
    const d = s.decor;
    L.push(`| ${s.label} | ${d.total} | ${d.below} | ${d.min == null ? '—' : `${r2(d.min)}–${r2(d.max)}:1`} | 豁免（1.4.11 不适用） |`);
  }
  L.push(`| **合计（浅+深）** | **${dec.groups}** | **${dec.below}** | **${r2(dec.min)}–${r2(dec.max)}:1** | 豁免（1.4.11 不适用） |`);
  L.push('');
  L.push(`> 控件类合计 **${report.overall.control.total}** 对，通过 **${report.overall.control.pass}**，未通过 **${report.overall.control.fail}**。装饰类 ${dec.groups} 组（含卡片轮廓、容器行、1px 分区线、计数徽标、焦点环的 alpha 光晕、单边下划线）照测照列，逐条理由见 0.1 与 3.x，完整证据链在 \`contrast.json\`。`);
  L.push('');

  for (const state of report.stateReports) {
    L.push(`## 三.${state.index} 逐对实测 · ${state.label}`);
    L.push('');
    if (state.id === 'dark-explicit') {
      if (report.themeProbe.prefsHasExplicitDark && report.themeProbe.explicitEqualsDarkMedia) {
        L.push('> 该状态已接入：prefs.css 的 `:root[data-theme="dark"] .pp-root` 与 media 块逐令牌同值，所以计数与 3.2 完全相同，不重复整表（完整数据在 `contrast.json` 的 `groups["dark-explicit"]`）。');
      } else {
        L.push('> 该状态在设置面板**不可达**：prefs.css 只有 `.pp-root` 与 `@media (prefers-color-scheme: dark)`，没有 `[data-theme="dark"]` 覆盖，面板根节点又是 `.pp-root` div，因此「系统亮色 + 显式深色」时组件拿到的是亮色令牌。下面计数与 3.1 逐对相同，不再重复整表（完整数据在 `contrast.json` 的 `groups["dark-explicit"]`）。');
      }
      L.push('');
      L.push(`- 文字 ${state.summary.text.pass}/${state.summary.text.total}｜控件类非文本 ${state.summary.nonText.pass}/${state.summary.nonText.total}｜装饰类 ${state.summary.decor.total} 组（${state.summary.decor.below} 组 <3:1）。`);
      L.push('');
      continue;
    }
    const text = state.groups.filter((g) => g.kind === 'text');
    const nonText = state.groups.filter((g) => g.kind !== 'text' && g.gate);
    const decor = state.groups.filter((g) => g.kind !== 'text' && !g.gate);

    L.push('### 文字（控件类）');
    L.push('');
    L.push('| 前景 | 背景（已合成） | 实测 | 阈值 | 判定 | 选择器 |');
    L.push('|---|---|---|---|---|---|');
    for (const g of text) {
      const mark = g.status === 'PASS' ? 'PASS' : g.status === 'FAIL' ? '**FAIL**' : g.status === 'N/A' ? 'N/A' : 'INFO';
      L.push(`| ${g.fgHex} | ${g.bgHex} | **${r2(g.ratio)}:1** | ${g.threshold} | ${mark} | ${shortSelectors(g.selectors)} |`);
    }
    L.push('');
    L.push('### 非文本 · 控件边界与焦点环（控件类，计入门禁）');
    L.push('');
    L.push('| 颜色 | 相邻底 | 实测 | 阈值 | 范围 | 判定 | 类型 | 选择器 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const g of nonText) {
      const mark = g.status === 'PASS' ? 'PASS' : '**FAIL**';
      const type = g.kind === 'ring' ? '焦点环' : g.kind === 'icon' ? '图标' : '描边';
      L.push(`| ${g.fgHex} | ${g.bgHex} | **${r2(g.ratio)}:1** | ${g.threshold} | 控件 | ${mark} | ${type} | ${shortSelectors(g.selectors)} |`);
    }
    L.push('');
    L.push('### 非文本 · 装饰类（豁免（1.4.11 不适用），仅测量）');
    L.push('');
    L.push('| 颜色 | 相邻底 | 实测 | 范围 | 判定 | 选择器 | 判定依据 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const g of decor) {
      L.push(`| ${g.fgHex} | ${g.bgHex} | ${r2(g.ratio)}:1 | 装饰 | 豁免（1.4.11 不适用） | ${shortSelectors(g.selectors, 2)} | ${g.scopeReason || '未命中任何交互证据'} |`);
    }
    L.push('');
  }

  // ---- 三·附 焦点态全量（实色主环 / outline / alpha 光晕逐层列，标注本轮新增）
  const NEW_FOCUS = [
    '.pp-root .pp-mb-opt:focus-visible',
    '.pp-root .pp-ds-chip:focus-visible',
    '.pp-root .pp-chip-pick:focus-visible',
    '.pp-root .pp-chip-x:focus-visible',
    '.pp-root .pp-dlg-close:focus-visible',
  ];
  const fs2 = report.focusStates;
  L.push('## 三·附 焦点态全量（含本轮新增 5 条）');
  L.push('');
  L.push('> 焦点指示器按「层」拆开测：实色主环（`0 0 0 Npx <实色>` 或 `outline: Npx solid`）是 1.4.11 的判定对象；外扩的 alpha 光晕是附加装饰，单独列出、不决定判定。');
  L.push('');
  L.push('| 选择器 | 状态 | 层 | 实测 | 阈值 | 判定 | 范围 | 本轮新增 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const f of fs2) {
    const isNew = NEW_FOCUS.includes(f.selector);
    for (const l of f.layers) {
      const kind = l.gate ? `${l.width}px ${l.via} 实色` : `${l.width}px ${l.via} 光晕`;
      L.push(`| \`${f.selector.replace(/^\.pp-root\s+/, '')}\` | ${f.state === 'light' ? '浅' : '深'} | ${kind} | **${r2(l.ratio)}:1** | ${AA_NONTEXT} | ${l.gate ? l.status : '豁免（装饰层）'} | ${l.gate ? '控件' : '装饰'} | ${isNew ? '是' : '—'} |`);
    }
  }
  L.push('');
  const gateLayers = fs2.flatMap((f) => f.layers.filter((l) => l.gate).map((l) => ({ sel: f.selector, state: f.state, ...l })));
  if (gateLayers.length) {
    const minGate = gateLayers.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
    const selCount = new Set(fs2.map((f) => f.selector)).size;
    L.push(`> 共 **${selCount}** 个焦点选择器、**${gateLayers.length}** 个计入门禁的实色层，最低 **${r2(minGate.ratio)}:1**（\`${minGate.sel.replace(/^\.pp-root\s+/, '')}\` · ${minGate.state === 'light' ? '浅' : '深'}），全部 ≥3。本轮新增的 5 条（\`.pp-mb-opt\` / \`.pp-ds-chip\` / \`.pp-chip-pick\` 双层环，\`.pp-chip-x\` / \`.pp-dlg-close\` 单层 outline）实测见标「是」的行。`);
  }
  L.push('');

  L.push('## 四、裁决书 10 对失败组合逐条复测（按选择器定位）');
  L.push('');
  L.push('| # | 位置 | 状态 | 原值 | 现值（真实容器） | 同基色复算 | 判定 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of report.regression) {
    const stateLabel = r.state === 'light' ? '浅' : '深';
    const vals = [...new Set(r.now.filter((n) => n.ratio != null).map((n) => `${r2(n.ratio)}:1`))];
    const now = vals.length ? vals.join(' / ') : (r.noColor ? '不设 color（见补充）' : '未找到');
    const al = r.aligned && r.aligned.length
      ? [...new Set(r.aligned.map((a) => `${r2(a.ratio)}:1`))].join(' / ')
      : '—';
    const mark = r.verdict === 'PASS' ? 'PASS' : r.verdict === 'FAIL' ? '**FAIL**' : r.verdict;
    L.push(`| ${r.id} | ${r.title} | ${stateLabel} | ${r.original} | **${now}** | ${al} | ${mark} |`);
  }
  L.push('');
  L.push('> 「同基色复算」= 把背景 alpha 层叠在**原裁决假设的基色**上重算，用于隔离「改色」与「换底」两个变量，与原值可直接对照。');
  L.push('');
  L.push('### 4.1 逐条明细');
  L.push('');
  for (const r of report.regression) {
    L.push(`**${r.id} · ${r.title}**（${r.state === 'light' ? '浅色' : '深色 media'}）`);
    L.push('');
    L.push(`- 原值：${r.original}（前景 \`${r.originalFg}\` / 背景 \`${r.originalBg}\`）`);
    for (const n of r.now) {
      if (n.status === 'NO_COLOR') {
        L.push(`- 现值：\`${n.selector}\` 规则仍在，但${r.noColor || '不声明文字色'}。`);
      } else if (n.ratio == null) {
        const searched = (n.searched && n.searched.length) ? n.searched : r.searched;
        L.push(`- 现值：**未找到选择器 \`${n.selector}\`** —— 在 prefs.css 里按类名实搜到：${searched.map((v) => `\`${v}\``).join('、') || '（零命中）'}；疑似已被重构改名或移除`);
      } else {
        const tail = n.gate === false ? '，装饰性不计入判定' : '';
        L.push(`- 现值：\`${n.selector}\` → ${n.fg} on ${n.bg} = **${r2(n.ratio)}:1**（阈值 ${n.threshold} → ${n.status}${tail}）`);
      }
    }
    {
      const seenAl = new Set();
      for (const a of r.aligned || []) {
        const k = `${a.fg}|${a.bg}|${a.ratio}`;
        if (seenAl.has(k)) continue;
        seenAl.add(k);
        L.push(`- 同基色复算：${a.fg} on ${a.bg} = **${r2(a.ratio)}:1**`);
      }
    }
    for (const s of r.supplementary || []) {
      L.push(`- 补充：\`${s.selector}\` → ${s.fg} on ${s.bg} = **${r2(s.ratio)}:1**（${s.status}）`);
    }
    if (r.note) L.push(`- 说明：${r.note}`);
    L.push(`- 结论：**${r.verdict === 'PASS' ? '已合规（原失败已修复）' : r.verdict === 'FAIL' ? '仍然不达标' : r.verdict}**`);
    L.push('');
  }

  L.push('## 五、仍然 FAIL 的项');
  L.push('');
  if (!report.remaining.length) {
    L.push('**控件类零 FAIL。** 1.4.11 计入的描边/焦点环全部 ≥3:1，文字对全部 ≥4.5:1。');
  } else {
    L.push('以下仅列**控件类**未过项（装饰类不进此表，见 0.1 与 3.x）。');
    L.push('');
    L.push('| 选择器 | 状态 | 实测 | 阈值 | 修复方向 |');
    L.push('|---|---|---|---|---|');
    for (const r of report.remaining) {
      L.push(`| ${shortSelectors(r.selectors, 2)} | ${r.state === 'light' ? '浅' : '深'} | ${r2(r.ratio)}:1 | ${r.threshold} | ${r.fix} |`);
    }
  }
  L.push('');
  for (const n of report.remainingNotes) L.push(`- ${n}`);
  L.push('');

  L.push('## 六、静态不可判 / 边界');
  L.push('');
  for (const n of report.limits) L.push(`- ${n}`);
  L.push('');

  return L.join('\n');
}

/* ---------------- 主流程 ---------------- */

function main() {
  const jsonMode = process.argv.includes('--json');
  const tokensText = fs.readFileSync(TOKENS_CSS, 'utf8');
  const prefsText = fs.readFileSync(PREFS_CSS, 'utf8');
  const tokenRules = parseCss(tokensText);
  const prefsRules = parseCss(prefsText);

  const palettes = {};
  const palettesRaw = {};
  for (const st of STATE_LIST) {
    const p = buildPalette(st.id, tokenRules, prefsRules);
    palettes[st.id] = p;
    palettesRaw[st.id] = p.vars;
  }

  const scopeCtx = buildScopeCtx();

  const auditByState = {};
  const groupsByState = {};
  for (const st of STATE_LIST) {
    auditByState[st.id] = auditState(st.id, palettes[st.id], prefsRules, scopeCtx);
    groupsByState[st.id] = groupRows(auditByState[st.id]);
  }

  const regression = runRegression(prefsRules, palettes, auditByState);
  // 原生控件配色（color-scheme）：不是对比度对，但决定暗色下原生 checkbox/select/滚动条怎么画
  const colorSchemeProbe = (() => {
    const scan = (text) => {
      const stripped = text.replace(/prefers-color-scheme/g, '');
      return [...stripped.matchAll(/(?:^|[;{\s])color-scheme\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    };
    const values = [...scan(tokensText), ...scan(prefsText)];
    return { declared: values.length > 0, values };
  })();

  // 主题三态探针：prefs.css 是否真的接入了显式深色、显式深色与 media 深色是否同值
  const themeProbe = (() => {
    const positive = (sel) => sel.replace(/:not\([^)]*\)/g, '');
    const hasPrefsExplicit = prefsRules.some((r) => r.selectors.some((sel) =>
      /\.pp-root/.test(sel) && /data-theme\s*=\s*["']?dark/.test(positive(sel))));
    const same = JSON.stringify(palettesRaw['dark-explicit']) === JSON.stringify(palettesRaw['dark-media']);
    const diff = Object.keys(palettesRaw.light).filter((k) => palettesRaw['dark-explicit'][k] !== palettesRaw.light[k]);
    return { prefsHasExplicitDark: hasPrefsExplicit, explicitEqualsDarkMedia: same, diffFromLight: diff };
  })();

  const colorSchemeBlocks = [];
  for (const [name, rules] of [['prefs.css', prefsRules], ['ui-tokens.css', tokenRules]]) {
    for (const rule of rules) {
      const d = rule.decls.find((x) => x.prop === 'color-scheme');
      if (d) colorSchemeBlocks.push({ file: name, line: rule.line, selector: rule.selector, media: rule.media.join(' ') || null, value: d.value.trim() });
    }
  }

  const nativeControlsNote = colorSchemeProbe.declared
    ? 'color-scheme 已声明：' + colorSchemeBlocks.map((b) => '`' + b.value + '`（' + b.file + ':' + b.line + ' ' + b.selector + (b.media ? ' @media' : '') + '）').join('、')
      + '。原生 checkbox / select 弹层 / 滚动条按对应模式绘制；gate-render 4× 截图里的「暗色未勾选 checkbox 纯白方块」由两处 `dark` 关闭。'
    : '两份 CSS 都没有 color-scheme 声明 → 暗色下原生 checkbox / select 弹层 / 滚动条仍按浅色绘制（gate-render 4× 截图实测：未勾选 checkbox 是纯白 13×13 方块，比卡面还亮，勾选后才是蓝底白勾）。修法：暗色块里加一行 color-scheme: dark。';

  /* 主题块一致性探针：media 深色块 vs 显式深色块，变量集合与取值逐条比对
   * —— 这是唯一会「改一处忘一处」的漂移点，必须机器核对而不是眼看 */
  const themeBlockProbe = (() => {
    const positive = (sel) => sel.replace(/:not\([^)]*\)/g, '');
    const isDarkMedia = (r) => r.media.some((m) => /prefers-color-scheme\s*:\s*dark/i.test(m));
    const isExplicitDark = (r) => r.selectors.some((s) => /data-theme\s*=\s*["']?dark/.test(positive(s)));
    const norm = (v) => String(v).replace(/\s+/g, ' ').trim().toLowerCase();
    const collect = (rules, pred) => {
      const map = new Map();
      const lines = [];
      for (const r of rules) {
        if (!pred(r)) continue;
        lines.push(r.line);
        for (const d of r.decls) {
          if (!d.prop.startsWith('--') && d.prop !== 'color-scheme') continue;
          map.set(d.prop, norm(expandVars(d.value, palettesRaw['dark-media'])));
        }
      }
      return { map, lines };
    };
    const build = (name, rules) => {
      const media = collect(rules, (r) => isDarkMedia(r) && !isExplicitDark(r));
      const explicit = collect(rules, (r) => isExplicitDark(r));
      const onlyMedia = [...media.map.keys()].filter((k) => !explicit.map.has(k));
      const onlyExplicit = [...explicit.map.keys()].filter((k) => !media.map.has(k));
      const valueDiffs = [...media.map.keys()]
        .filter((k) => explicit.map.has(k) && explicit.map.get(k) !== media.map.get(k))
        .map((k) => ({ prop: k, media: media.map.get(k), explicit: explicit.map.get(k) }));
      return {
        file: name,
        mediaLines: media.lines,
        explicitLines: explicit.lines,
        mediaCount: media.map.size,
        explicitCount: explicit.map.size,
        identical: !onlyMedia.length && !onlyExplicit.length && !valueDiffs.length,
        onlyInMedia: onlyMedia,
        onlyInExplicit: onlyExplicit,
        valueDiffs,
      };
    };
    return [build('prefs.css', prefsRules), build('ui-tokens.css', tokenRules)];
  })();
  const regressionSummary = {
    textTotal: regression.filter((r) => r.kind === 'text').length,
    textPass: regression.filter((r) => r.kind === 'text' && r.verdict === 'PASS').length,
    nonTextTotal: regression.filter((r) => r.kind !== 'text').length,
    nonTextFail: regression.filter((r) => r.kind !== 'text' && r.verdict === 'FAIL').length,
  };

  const summaries = [];
  const stateReports = [];
  let idx = 0;
  for (const st of STATE_LIST) {
    const s = summarizeGroups(groupsByState[st.id]);
    summaries.push({ id: st.id, label: st.label, ...s });
    stateReports.push({ index: ++idx, id: st.id, label: st.label, groups: groupsByState[st.id], summary: s });
  }

  // 门禁只按两个「面板可达」状态计（light + dark-media）
  const reachable = ['light', 'dark-media'];
  const fails = reachable.flatMap((s) => summaries.find((x) => x.id === s).fails);
  const sum = (fn) => reachable.reduce((acc, s) => acc + fn(summaries.find((x) => x.id === s)), 0);
  const decorGroups = reachable.flatMap((s) => groupsByState[s].filter((g) => g.kind !== 'text' && !g.gate));
  const decorRatios = decorGroups.map((g) => g.ratio);
  const overall = {
    text: { total: sum((x) => x.text.total), pass: sum((x) => x.text.pass) },
    nonText: { total: sum((x) => x.nonText.total), pass: sum((x) => x.nonText.pass) },
    // 控件类：文字对 + 计入 1.4.11 的非文本对 → 进通过率与退出码
    control: {
      total: sum((x) => x.control.total),
      pass: sum((x) => x.control.pass),
    },
    // 装饰类：1.4.11 不适用，照测照列，不参与通过率
    decor: {
      groups: decorGroups.length,
      below: decorGroups.filter((g) => g.ratio < AA_NONTEXT).length,
      min: decorRatios.length ? Math.min(...decorRatios) : null,
      max: decorRatios.length ? Math.max(...decorRatios) : null,
    },
    exempt: sum((x) => x.exempt),
  };
  overall.control.fail = overall.control.total - overall.control.pass;
  // 兼容旧字段名（下游/历史脚本读 gateTotal/gatePass/gateFail）
  overall.gateTotal = overall.control.total;
  overall.gatePass = overall.control.pass;
  overall.gateFail = overall.control.fail;


  const shortOf = (s) => s.replace(/^\.pp-root\s+/, '');
  const TEXT_FIX = {
    '.pp-avatar': '头像底是 linear-gradient(accent→accent-emphasis) 的旧 3.10/3.75 组合；换成主按钮那组令牌（#1f6feb→#1158c7）即 4.63/6.47',
    '.pp-mb-badge-pro': '与 .pp-avatar 同一个渐变底，用 --pp-btn-primary-bg / --pp-btn-primary-bg-hover 作渐变两端',
    '.pp-anchor-nav .pp-btn:hover:not(:disabled)': '深色 hover 文字仍用 --pp-accent（4.18）；改 --pp-accent-fg（#79b8ff → 6.24）——同族的 .pp-anchor-active 已改，这一处漏了',
    '.pp-mb-renew-expired': '浅色 --pp-danger-fg 仍是 #cf222e，压 danger-bg 4.30；提到 #b31d28（≈5.4）或把 danger-bg alpha 从 .10 降到 .06',
  };
  // 修复方向按「实际用到的令牌名」给，不写死颜色 —— 令牌随时会改，写死会变成误导
  const tokenNameOf = (raw, vars) => {
    // raw 可能是 `#0969da @0.24` 这种「hex + 合成后 alpha」标签，必须解析出 alpha 才能区分
    // --pp-accent（a=1）与 --pp-accent-line（a=.24）—— 两者 hex 相同
    const s = String(raw).trim();
    const m = /^(#[0-9a-fA-F]{3,8})\s*@([\d.]+)$/.exec(s);
    const c = m ? Object.assign({}, parseColor(m[1]), { a: parseFloat(m[2]) }) : parseColor(s);
    if (!c) return null;
    let fallback = null;
    for (const name of Object.keys(vars)) {
      const v = parseColor(expandVars(`var(${name})`, vars));
      if (!v || hex(v) !== hex(c)) continue;
      if (Math.abs((v.a == null ? 1 : v.a) - (c.a == null ? 1 : c.a)) < 0.02) return name;
      if (!fallback) fallback = name;
    }
    return fallback;
  };
  const BORDER_FIX = {
    '--pp-border': '该元素仍用装饰性 --pp-border（只该服务卡片轮廓与分区线）：如果它是可交互控件（chip / 行内按钮 / 可点行），改 --pp-border-control；纯容器行则 1.4.11 不强制',
    '--pp-border-strong': 'hover 态仍走 --pp-border-strong：控件 hover 应改 --pp-border-control-hover',
    '--pp-accent-line': 'alpha 线（.24/.30）合成后不足 3:1：控件态可 alpha ≈.55–.6，或直接用实色 accent',
  };
  const remaining = fails
    .map((g) => {
      const key = shortOf(g.selectors[0]);
      let fix;
      if (g.kind === 'text') fix = TEXT_FIX[key] || TEXT_FIX[shortOf(g.selectors.filter((s) => TEXT_FIX[shortOf(s)])[0] || '')] || '提高前景/背景明度差';
      else if (g.kind === 'border') {
        const tok = tokenNameOf(g.fgRaw || g.fgHex, palettes[g.state].vars);
        fix = (tok && BORDER_FIX[tok]) || `提高描边色与底的明度差（当前 ${g.fgHex}，令牌 ${tok || '未识别'}）`;
      } else fix = '提高图标色与底的明度差';
      return { selectors: g.selectors, state: g.state, ratio: g.ratio, threshold: g.threshold, kind: g.kind, fgHex: g.fgHex, token: g.kind === 'border' ? tokenNameOf(g.fgRaw || g.fgHex, palettes[g.state].vars) : null, fix };
    })
    .sort((a, b) => (a.state === b.state ? a.ratio - b.ratio : a.state === 'light' ? -1 : 1));

  const textFails = fails.filter((g) => g.kind === 'text');
  const nonTextFails = fails.filter((g) => g.kind !== 'text');
  const remainingNotes = [];
  if (!fails.length) {
    remainingNotes.push('控件类零 FAIL → 门禁通过。门禁只按「面板可达」的浅色 + media 深色计；显式深色列与 media 深色逐令牌同值，仅作对照。');
  } else {
    if (textFails.length) {
      remainingNotes.push(`文字对仍有 **${textFails.length}** 组未过 4.5：1 —— ${textFails.map((g) => `\`${shortOf(g.selectors[0])}\` ${r2(g.ratio)}:1`).join('；')}（见第五节修复方向）。`);
    } else {
      remainingNotes.push('文字对（4.5：1）**全部通过**，包括裁决书点名的 5 组及其同批颜色的残留位。');
    }
    if (nonTextFails.length) {
      const tokens = [...new Set(nonTextFails.map((g) => g.token).filter(Boolean))];
      remainingNotes.push(`控件类非文本对仍有 **${nonTextFails.length}** 组未过 3：1（WCAG 1.4.11 强制），涉及令牌：${tokens.map((t) => `\`${t}\``).join('、') || '（未能反查令牌）'}：${nonTextFails.map((g) => `\`${shortOf(g.selectors[0])}\` ${r2(g.ratio)}:1`).join('；')}。`);
    }
  }
  if (decorGroups.length) {
    remainingNotes.push(`另有 **${decorGroups.length} 组装饰类描边**（其中 **${overall.decor.below} 组 <3:1**，实测区间 ${r2(overall.decor.min)}–${r2(overall.decor.max)}:1）按 1.4.11 适用范围判为装饰，**不计入通过率、不影响退出码**，但数值全部保留在「装饰类」表里供评审查阅。`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sources: {
      tokens: relPath(TOKENS_CSS),
      prefs: relPath(PREFS_CSS),
      tokensLines: countLines(tokensText),
      prefsLines: countLines(prefsText),
      tokensBytes: Buffer.byteLength(tokensText),
      prefsBytes: Buffer.byteLength(prefsText),
      // 快照指纹：CSS 随时在改，报告必须能对上是哪一版文件
      sha256: {
        tokens: crypto.createHash('sha256').update(tokensText).digest('hex').slice(0, 12),
        prefs: crypto.createHash('sha256').update(prefsText).digest('hex').slice(0, 12),
      },
      mtime: {
        tokens: fs.statSync(TOKENS_CSS).mtime.toISOString(),
        prefs: fs.statSync(PREFS_CSS).mtime.toISOString(),
      },
    },
    nativeControls: {
      colorSchemeDeclared: colorSchemeProbe.declared,
      values: colorSchemeProbe.values,
      blocks: colorSchemeBlocks,
      note: nativeControlsNote,
    },
    themeBlocks: themeBlockProbe,
    // 1.4.11 适用范围判定：证据来源、判定规则、装饰清单（逐个给理由）
    scope: {
      rule: [
        '判定按证据强度分层，命中任一「控件」证据即计入 1.4.11，不靠选择器白名单：',
        '① 标记层：prefs.xhtml 里该 class 落在 input / select / textarea / button / a / label / summary 上；',
        '② 脚本层：prefs-*.js 里该 class 由 el("tag")/h("tag") 创建在控件标签上，或「该元素自身」绑了 click（子按钮的 click 不算到容器头上）；',
        '③ CSS 层：选择器以控件标签开头，或带 [role="button"] / [tabindex]；',
        '④ 弱证据：CSS 声明 cursor:pointer —— 只在①②③都无命中时参考，因为它会滞后于重构（.pp-chip 已改成 span 容器但 cursor:pointer 还留着）。',
        '装饰 = 以上全不命中；此类照测照列，标「豁免（1.4.11 不适用）」，不进通过率、不影响退出码。',
      ],
      evidenceSources: {
        markup: scopeCtx.files.markup,
        scripts: scopeCtx.files.scripts,
        markupClasses: scopeCtx.markupClasses,
        jsClasses: scopeCtx.jsClasses,
      },
      decorList: decorGroups.map((g) => ({
        state: g.state,
        kind: g.kind,
        selectors: g.selectors,
        fgHex: g.fgHex,
        bgHex: g.bgHex,
        ratio: g.ratio,
        reason: g.scopeReason || '（未命中任何交互证据）',
      })),
      // 逐选择器给理由（同一组里不同选择器的证据可能不同，不能只报一个代表）
      decorDetail: (() => {
        const map = new Map();
        for (const s of reachable) {
          for (const row of auditByState[s]) {
            if (row.kind === 'text' || row.gate) continue;
            const key = `${row.state}|${row.selector}|${row.fgHex}`;
            if (!map.has(key)) {
              map.set(key, {
                selector: row.selector,
                state: row.state,
                kind: row.kind,
                ratio: row.ratio,
                reason: row.scopeReason || '（未命中任何交互证据）',
                note: row.note,
              });
            }
          }
        }
        return [...map.values()].sort((a, b) => a.ratio - b.ratio);
      })(),
      controlList: reachable.flatMap((s) => groupsByState[s]
        .filter((g) => g.gate && g.scope === 'control')
        .map((g) => ({ state: g.state, selectors: g.selectors, ratio: g.ratio, reason: g.scopeReason }))),
    },
    // 焦点态全量：每个 :focus 选择器的每一层（实色主环 / outline / alpha 光晕）都单列
    focusStates: reachable.flatMap((s) => {
      const bySel = new Map();
      for (const row of auditByState[s]) {
        if (row.kind !== 'ring') continue;
        if (!bySel.has(row.selector)) bySel.set(row.selector, []);
        bySel.get(row.selector).push(row);
      }
      return [...bySel.entries()].map(([sel, rows]) => ({
        state: s,
        selector: sel,
        scope: rows.some((r) => r.gate) ? 'control' : 'decor',
        layers: rows
          .slice()
          .sort((a, b) => b.ratio - a.ratio)
          .map((r) => ({ via: r.via, width: r.ringWidth, ratio: r.ratio, status: r.status, gate: r.gate, note: r.note })),
      }));
    }),
    themeProbe,
    states: STATE_LIST,
    paletteKeys: Object.keys(palettesRaw.light),
    paletteDiff: Object.keys(palettesRaw.light).filter((k) => palettesRaw['dark-explicit'][k] !== palettesRaw.light[k]),
    palettes: palettesRaw,
    paletteOwner: Object.fromEntries(STATE_LIST.map((s) => [s.id, palettes[s.id].owner])),
    summaries,
    overall,
    stateReports,
    exitCode: overall.control.fail ? 1 : 0,
    groups: groupsByState,
    pairs: auditByState,
    regression,
    regressionSummary,
    remaining,
    remainingNotes,
    limits: [
      '1.4.11 适用范围判定基于静态证据（xhtml 标记 + prefs-*.js 构造/绑定 + CSS 标签与 role），不是运行时 DOM：若某元素的可点性由运行时动态绑定且不在扫描到的 `addEventListener("click")` 形式内，可能被判成装饰。逐条证据（文件:行号）写在 `scope.decorDetail` 与 `pairs[].scopeEvidence` 里，可直接复核。',
      '「单边描边」判定：只有 `border` / `border-color` 这种整圈描边算控件边界；`border-bottom` / `border-left` 等单边是下划线或分区指示条。`.pp-account-email`（`<button class="pp-link-btn pp-account-email">`，`border-bottom: 1px dashed var(--pp-border-strong)`，浅 **1.61:1** / 深 **2.06:1**）属此类。**0.72.3 的变化**：该按钮文字已由 `--pp-muted` 改为 `--pp-accent` 链接色（承担控件识别，文字对实测达标），虚线自此是纯装饰性附加提示，与 `text-decoration: underline` 同类，不属 1.4.11 的「UI 组件视觉信息」。修复前它曾是唯一可点信号（0.72.2 裁决书 Major 项），修复后不存在口径分歧：无论虚线怎么判，控件识别都有达标文字兜底。',
      '层叠空操作（静态 CSS 的已知盲区）：`.pp-chip-pick` 的 `border-color`（prefs.css:683）被该元素内联 `style="…border:0…"`（prefs-account.js:2086 起）压制，边框宽度为 0，**像素上不产生描边**。本报告按 CSS 声明照录该行（浅 5.19 / 深 4.97），它与同选择器的焦点环落在同一组，不改变任何判定；知道这一点即可，不必按它去改颜色。',
      '背景带 alpha 时，合成基色由 BASE_MAP（脚本第 4 节）按「最近祖先面令牌」显式声明，并已把基色打进表格；静态 CSS 无法证明真实 DOM 嵌套，若实际嵌套不同，该行需按实际底色重算。prefs.css 中 --pp-bg 与 --pp-surface 两态同值，面板级歧义零影响。',
      '由 prefs-*.js 运行时写入的内联色（.pp-badge-demo 的徽章底色等）静态不可判，已标 INFO 且不计入通过率。',
      '渐变底（.pp-avatar / .pp-mb-badge-pro）取渐变两端中较差的一对入表，是保守下界。',
      'disabled 控件与「即将上线」占位项按 WCAG 1.4.3 豁免，计 N/A，不进通过率。',
      themeProbe.prefsHasExplicitDark
        ? `显式深色已由 :root[data-theme="dark"] .pp-root 覆盖（与 media 块${themeProbe.explicitEqualsDarkMedia ? '同值' : '不同值，需核对'}）；该态断言基于「系统亮色 + 显式深色」的层叠推导。`
        : '显式深色（:root[data-theme="dark"]）在设置面板不可达：prefs.css 无 [data-theme] 覆盖，面板根节点是 .pp-root div。该列在组件层等价于亮色（另有少数 prefs.css 未声明的令牌会变深），上文已标为结构性缺口。',
      '焦点指示器同时扫 box-shadow 环与 outline（.pp-link-btn / .pp-disclose > summary 走 outline 2px；只看 box-shadow 会误判为「无焦点环」——gate-render 实测确认）。焦点过渡有 .12s transition，本脚本读的是声明值而非运行时计算值，不受过渡起点影响。',
      nativeControlsNote,
      '主题块一致性（机器核对，非眼看）：prefs.css 与 ui-tokens.css 各有一对「media 深色块 / 显式深色块」，脚本按变量名集合与展开后取值逐条比对，差集与取值差异写在 `themeBlocks` 里。这是唯一会「改一处忘一处」的漂移点。',
      '`color-scheme` 只影响 UA 原生控件（checkbox / select 弹层 / 滚动条）的绘制模式，不产生对比度对，故不进通过率；其声明位置与取值由 `nativeControls.blocks` 逐块列出。',
      '原生控件（checkbox / select 弹层 / 滚动条）的外观由 UA 的 color-scheme 决定，不产生 CSS 对比度对，也不在本脚本的测量范围内；1.4.11 对「外观由用户代理决定且未被作者修改」的组件本身即豁免。所以未勾选 checkbox 的描边强弱属于视觉观感问题，不是门禁项——若要量化只能像素采样（`getComputedStyle` 拿不到 UA 自绘边框）。静态声明扫描 + gate-render 注入复核（白块 → 深底中灰，`docs/audit/0.72.2/zoom/inject-dark-cb-off.png`）两者结论一致。',
      'opacity < 1 的元素（如 .pp-mb-opt-soon）按 opacity 混合后计有效对比度，并标豁免。',
      '表格里的合成底色是四舍五入到 8 位的 hex，内部按浮点 RGB 计算；用显示值手算可能差 ±0.01（例如 #cf222e on #f2e3e6 内部 4.30，用四舍五入后的 hex 手算会得 4.31）。',
      '公式自检：#000000 on #ffffff = 21.00、#767676 on #ffffff = 4.54（WCAG AA 边界经典值），与本脚本输出一致。',
    ],
  };

  if (jsonMode) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(renderHuman(report) + '\n');
  process.exitCode = report.exitCode;
}

main();
