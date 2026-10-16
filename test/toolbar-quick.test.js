#!/usr/bin/env node
/* 顶部快捷按钮 · 菜单装配测试（插件 0.38.0）
 *
 * 为什么要有它：快捷按钮的菜单是「高频直达项（右键菜单同一份 menuQuickItems pref）
 * + 固定三件套（AI 悬浮窗 / PDF 对照翻译 / 功能中心）+ 设置」的**动态装配**——
 * 去重逻辑（固定项 vs 直达项）与菜单结构出问题表现为「菜单空了 / 重复项 /
 * 设置入口丢失」，静默失败只有真跑一遍才能发现：
 *   ① 直达项配置 → 菜单顶部列出（标签来自 ITEM_REGISTRY 的 labelKey）；
 *   ② ★ 固定三件套与直达项按 id 去重（quick 里有 ai-chat 时固定项不再重复列）；
 *   ③ 末尾始终有「设置」入口（与直达项之间有分隔线）；
 *   ④ ★ 冒泡守卫：menuitem 的 command 冒泡到按钮时被忽略（ev.target 守卫）——
 *      0.38.0 主题按钮实踩的坑，这里防回归；
 *   ⑤ 直达项为空 / Menus 不可用时菜单仍可用（只有固定项 + 设置）。
 *
 * 运行：node test/toolbar-quick.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TQ_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'toolbar-quick.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this._attrs = {};
    this.className = ''; this.id = ''; this.parentNode = null; this.handlers = {};
    this.commandFired = null;
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  fire(e, a) {
    const ev = Object.assign({ target: this, stopPropagation() {} }, a || {});
    for (const f of (this.handlers[e] || []).slice()) f(ev);
  }
  all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
}

/** 桩环境：Prefs / I18n / Menus / PdfDual 全部可注入 */
function makeEnv(opts) {
  opts = opts || {};
  const PrefStore = new Map(Object.entries(opts.prefs || {}));
  const calls = [];
  const sandbox = {
    Zotero: { PaperPilot: { openHub: () => calls.push('hub') } },
    Services: {},
    Prefs: {
      get: (k, d) => (PrefStore.has(k) ? PrefStore.get(k) : d),
      set: (k, v) => PrefStore.set(k, v),
    },
    I18n: { t: (k) => '«' + k + '»' },
    Menus: {
      _quickItems: () => (opts.quick || []),
      openChatFloat: () => calls.push('ai-chat'),
      openSettings: () => calls.push('settings'),
    },
    PdfDual: { openForSelected: () => calls.push('bilingual-view') },
    window: { setTimeout: () => {} },
    console, Math, Date, Set, Array, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(TQ_JS, 'utf8'), sandbox, { filename: 'toolbar-quick.js' });
  return { sandbox, calls };
}

const QUICK_STUB = [
  { id: 'ai-summary', group: 'ai', labelKey: 'menuAiSummary', run: () => {} },
  { id: 'bilingual-view', group: 'notes', labelKey: 'menuPdfDual', run: () => {} },
];

/* ---------------- ①②③ 菜单装配 ---------------- */
{
  const { sandbox } = makeEnv({ quick: QUICK_STUB });
  const doc = { createElementNS: (ns, tag) => new El(tag), createXULElement: undefined,
    getElementById: () => null };
  const popup = new El('menupopup');
  sandbox.ToolbarQuick._fillQuickMenu(doc, popup);
  const items = popup.byTag('menuitem');
  const seps = popup.byTag('menuseparator');
  const labels = items.map((i) => i.getAttribute('label'));
  eq(items.length, 10, '①② 菜单项 = 2 直达 + 2 固定（bilingual-view 去重）+ 视图组 5 + 设置');
  includes(labels, '«menuAiSummary»', '① 直达项在顶部');
  includes(labels, '«menuAiChat»', '② 固定项 AI 悬浮窗');
  includes(labels, '«menuHub»', '② 固定项 功能中心');
  ok(labels.indexOf('«menuPdfDual»') === labels.lastIndexOf('«menuPdfDual»'),
    '② bilingual-view 不因同时出现在直达与固定而重复');
  includes(labels, '保存当前为视图…', '③ 视图组：保存当前入口');
  includes(labels, '阅读视图', '③ 视图组：内置默认预设补种');
  eq(labels[labels.length - 1], '«menuSettings»', '④ 设置入口在末尾');
  ok(seps.length === 4, '④ 分隔线：直达/固定 + 固定/视图组 + 视图/删除 + 视图组/设置');
}
function includes(arr, needle, label) {
  return ok(arr.indexOf(needle) >= 0, label, { got: arr });
}

/* ---------------- ⑤ 兜底：直达项为空 / Menus 缺席 ---------------- */
{
  const { sandbox } = makeEnv({ quick: [] });
  const doc = { createElementNS: (ns, tag) => new El(tag), getElementById: () => null };
  const popup = new El('menupopup');
  sandbox.ToolbarQuick._fillQuickMenu(doc, popup);
  const labels = popup.byTag('menuitem').map((i) => i.getAttribute('label'));
  eq(labels.length, 9, '⑤ 直达项为空 → 固定三件套 + 视图组 5 + 设置');
  includes(labels, '«menuAiChat»', '⑤ 固定项可用');
  eq(labels[labels.length - 1], '«menuSettings»', '⑤ 设置入口仍在');
}

/* ---------------- ④ 冒泡守卫（防 0.38.0 主题按钮同款坑） ---------------- */
{
  const src = fs.readFileSync(TQ_JS, 'utf8');
  ok(/popup\.addEventListener\("popupshowing", onlySelf/.test(src) &&
    /if \(ev\.target !== popup\) return/.test(src),
    '④ popup 事件带 ev.target 守卫（源码级）');
  ok(/if \(ev\.target !== btn\) return; \/\/ 菜单项 command 冒泡/.test(src),
    '④ 按钮 command 带 ev.target 守卫（源码级）');
  ok(/mi\.addEventListener\("command", \(ev\) => \{[\s\S]*?ev\.stopPropagation\(\);/.test(src),
    '④ menuitem command 主动 stopPropagation');
}

/* ---------------- ⑥ 点击真的调到对应功能 ---------------- */
{
  const { sandbox, calls } = makeEnv({ quick: [] });
  const doc = { createElementNS: (ns, tag) => new El(tag), getElementById: () => null };
  const popup = new El('menupopup');
  sandbox.ToolbarQuick._fillQuickMenu(doc, popup);
  const items = popup.byTag('menuitem');
  const byLabel = (l) => items.find((i) => i.getAttribute('label') === l);
  byLabel('«menuHub»').fire('command');
  byLabel('«menuSettings»').fire('command');
  byLabel('«menuAiChat»').fire('command');
  eq(calls.join(','), 'hub,settings,ai-chat', '⑥ 菜单项 command 调到对应功能');
}

console.log('toolbar-quick: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
