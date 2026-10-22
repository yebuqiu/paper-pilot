#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 阅读器右侧栏 · 翻译面板 渲染与行为测试（插件 0.30.0）
 *
 * 为什么要有它：右侧栏面板跑在 Zotero 的 ItemPane section 里，无人环境点不了；
 * 而它承担的是「翻译的入口本身」——一旦渲染崩了或按钮接线断了，表现就是
 * 「右侧栏一片空白 / 点了没反应」，属于最典型的静默失败。这里用「迷你 DOM」
 * 把面板**真跑一遍**（真实加载 utils.js + 翻译模块六文件（test/translate-files.js 清单），只桩掉 Zotero/网络），断言：
 *   ① section 注册参数：paneID / sidenav / l10nID / onRender 必填（Z10 缺了返回 false）；
 *   ② 面板结构：引擎下拉（选项数 = 引擎数、选中 = 活动引擎）、源/目标语言、待译框、结果区；
 *   ③ 划词填入：captureSelection 在条目匹配时自动填、用户编辑后不被覆盖；
 *   ④ 换引擎 / 换目标语言 → 写回同一份 pref（translateCfg.active / readerPopupTargetLang）；
 *   ⑤ 翻译：结果区出译文 + 引擎徽章；引擎不可用时按钮禁用并给出指引（不静默）；
 *   ⑥ 失败：结果区显示可读错误（不能空白）；
 *   ⑦ 全文对照：分段进度 + 段落对照列表 + 导出双语笔记 / 打开双栏窗口；
 *   ⑧ 注销用 registerSection 的返回值。
 *
 * 运行：node test/translate-pane.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  ...require('./translate-files'),
  'chrome/content/scripts/panels/translate-pane.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM（复用 bilingual-view.test.js 的技法） ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false;
    this.id = ''; this.parentNode = null; this.handlers = {};
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
    if (k.indexOf('data-') === 0) this.dataset[k.slice(5)] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); }
  click() { this.fire('click'); }
  focus() {}
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  byClass(cls) { return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(cls) >= 0); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
}

function makeDoc() {
  const document = {
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    getElementById: () => null,
  };
  return document;
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map(); // 完整 pref key → 值
const PREFIX = 'extensions.zotero.papilot.';
const setPref = (k, v) => PrefStore.set(PREFIX + k, v);
const getPref = (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d);

const calls = { twoCol: 0, notes: [], copy: '' };
let httpPlan = [];
const httpCalls = [];
const timers = [];
/** 执行并清空排队的延时回调（面板的 pacing / 提示复原） */
function flushTimers() { const q = timers.splice(0); for (const f of q) f(); }
/** 让出微任务若干轮 */
async function tick(n = 3) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

const Zotero = {
  locale: 'zh-CN',
  // 与真实一致：pref 不存在时返回 undefined（utils.js 的 Prefs 用 undefined 判定回落默认值；
  // 若这里返回第二个参数，会把「未设置」误当成 true —— 实测踩到过）
  Prefs: {
    get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined),
    set: (k, v) => PrefStore.set(k, v),
  },
  Utilities: {
    Internal: {
      copyText: (t) => { calls.copy = t; },
      openPreferences: () => { calls.prefs = (calls.prefs || 0) + 1; },
      md5: (s) => 'x'.repeat(32),
    },
  },
  ItemPaneManager: {
    registerSection(opts) { calls.section = opts; return 'papilot@dev.local-papilot-translate'; },
    unregisterSection(id) { calls.unregistered = id; },
  },
  HTTP: {
    async request(method, url) {
      httpCalls.push(url);
      const hit = httpPlan.find((p) => url.indexOf(p.match) >= 0);
      if (!hit) throw new Error('no http plan for ' + url.slice(0, 60));
      if (hit.fail) throw new Error(hit.fail);
      if (hit.failStatus) {
        const e = new Error('HTTP ' + hit.failStatus);
        e.xmlhttp = { status: hit.failStatus, response: null, responseText: 'err' };
        throw e;
      }
      return { status: 200, response: hit.res, responseText: hit.text };
    },
  },
  Papilot: {
    openHub: () => { calls.hub = (calls.hub || 0) + 1; },
    _paneID: 'papilot-prefs',
    // 0.36.0：侧栏「双栏窗口」按钮改走左原右译窗口（PdfDual.openForItem）
    pdfDual: { openForItem: (item) => { calls.twoCol++; calls.twoColItem = item && item.id; } },
  },
  logError() {},
};

let aiReady = true;
let aiReply = 'LLM 译文';
let aiThrows = false;
const AIClient = {
  hasKey: () => aiReady,
  guidance: () => '未登录/未配置',
  async chat() { if (aiThrows) throw new Error('AI 请求失败：请求超时'); return aiReply; },
};

const sandbox = {
  console, Zotero, Services: {}, AIClient,
  IOUtils: {}, PathUtils: {},
  // 延时回调入队（不是立即执行）：面板里的「复制后 1.2s 复原文案」若被立即执行，
  // 断言就看不到反馈；同时全文档的 pacing 定时器需要显式 flush 才能推进
  setTimeout: (fn) => { if (typeof fn === 'function') timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  Promise, Date, Math, JSON, URLSearchParams,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const TP = sandbox.TranslatePane;
const T = sandbox.TranslateSvc;
const I18n = sandbox.I18n;

// 桩：AIChat / BilingualTranslate（面板依赖它们的全文与分段能力）
sandbox.AIChat = {
  async getFullText() { return 'Para one content.\n\nPara two content.'; },
  async translateTitleAbstract() { return '标题\n译标题\n\n摘要\n译摘要'; },
};
sandbox.BilingualTranslate = {
  _chunk: (text) => String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
  _chunkChars: () => 1200,
  _noteMd: (pairs) => pairs.map((p) => '> ' + p.src + '\n\n' + p.dst).join('\n\n---\n\n'),
  _targetLang: () => '中文',
  // 旧「文本双栏」出口（0.36.0 起不再由侧栏按钮调用，保留桩以便回归）
  openViewer: (item) => { calls.legacyTwoCol = item && item.id; },
};
// 桩：Notes（utils.js 已定义真实对象，这里只替换落笔记的动作）
let noteArgs = null;
sandbox.Notes.createFromMarkdown = async (item, title, md) => { noteArgs = { title, md, id: item.id }; return true; };

const item = { id: 101, isRegularItem: () => true, getDisplayTitle: () => '测试论文' };

/* ---------------- ① section 注册参数 ---------------- */

setPref('translateCfg', JSON.stringify({ active: 'llm', fallback: ['google'], retry: 1, cache: true }));

TP.register('papilot@dev.local');
const sec = calls.section;
ok(!!sec, '① registerSection 被调用');
eq(sec.paneID, 'papilot-translate', '① paneID 正确');
ok(!!sec.sidenav && sec.sidenav.l10nID === 'papilot-translate-section-sidenav',
  '① 提供 sidenav（侧栏图标位）且 l10nID 正确');
eq(sec.header.l10nID, 'papilot-translate-section-header', '① header l10nID 正确');
has(sec.header.icon, 'translate.svg', '① 使用专用翻译图标');
eq(typeof sec.onRender, 'function', '① onRender 必须存在（Z10 schema 缺了会静默返回 false）');
eq(typeof sec.onItemChange, 'function', '① onItemChange 存在');
eq(typeof sec.onDestroy, 'function', '① onDestroy 存在');

/* ---------------- ② 面板结构 ---------------- */

const doc = makeDoc();
const body = new El('div');
body.querySelector = () => null;
sec.onRender({ paneID: 'p1', doc, body });
const root = body.firstChild;
ok(!!root, '② onRender 构建了根节点');
eq(root.getAttribute('data-pp-tr-root'), '1', '② 根节点带标记（防重复渲染）');
const engSel = root.byClass('pp-tr-sel')[0];
const langSels = root.byClass('pp-tr-lang');
const input = root.byClass('pp-tr-input')[0];
const result = root.byClass('pp-tr-result')[0];
ok(!!engSel, '② 有「引擎」下拉');
eq(engSel.children.length, T.list().length, '② 引擎下拉选项数 = 引擎数');
eq(engSel.value, 'llm', '② 引擎下拉选中 = 活动引擎');
eq(langSels.length, 2, '② 有源/目标两个语言下拉');
ok(langSels[0].children.length === T.LANGS.length - 1, '② 目标语言不含「自动检测」',
  langSels[0].children.length);
eq(langSels[1].children.length, T.LANGS.length, '② 源语言含「自动检测」');
eq(langSels[1].value, 'auto', '② 源语言默认自动检测');
eq(langSels[0].value, 'zh-CN', '② 目标语言默认 zh-CN');
ok(!!input && input.tag === 'textarea', '② 有待译文本框');
eq(result.textContent, I18n.t('tpResultEmpty'), '② 结果区初始为占位文案');
ok(root.byTag('button').length >= 8, '② 按钮齐全（翻译/清空/复制/开始/双栏/笔记/标题摘要/设置）',
  root.byTag('button').length);

/* ---------------- ③ 划词填入 ---------------- */

sec.onItemChange({ paneID: 'p1', item, setEnabled: (e) => { calls.enabled = e; } });
eq(calls.enabled, true, '③ 常规条目 → section 启用');
eq(String(input.value), '', '③ 换篇后待译框清空');

TP.captureSelection(101, 'Hello, this is a sentence to translate.');
eq(input.value, 'Hello, this is a sentence to translate.', '③ 划词自动填入待译框');
eq(input.dataset.ppAuto, '1', '③ 标记为自动填入（用户编辑后可覆盖）');
TP.captureSelection(999, 'Another item text');
eq(input.value, 'Hello, this is a sentence to translate.', '③ 其他条目的划词不覆盖当前面板');
// 用户手工编辑后，同类划词不再覆盖
input.value = 'my own text';
input.fire('input');
TP.captureSelection(101, 'new selection');
eq(input.value, 'my own text', '③ 用户编辑后不被划词覆盖');

/* ---------------- ④ 换引擎 / 换语言写回 pref ---------------- */

input.value = 'Hello world';
engSel.value = 'google';
engSel.fire('change');
eq(T.cfg().active, 'google', '④ 引擎下拉 → 写回 translateCfg.active');
eq(engSel.value, 'google', '④ 下拉保持选中');
eq(T.cfg().active, 'google', '④ 引擎徽章刷新不改变选择');

langSels[0].value = 'en';
langSels[0].fire('change');
eq(getPref('readerPopupTargetLang'), 'en', '④ 目标语言 → 写回 readerPopupTargetLang');
langSels[1].value = 'zh-CN';
langSels[1].fire('change');
eq(getPref('translateFromLang'), 'zh-CN', '④ 源语言 → 写回 translateFromLang');

/* ---------------- ⑤ 翻译（真实走 TranslateSvc → AIClient 桩） ---------------- */

setPref('readerPopupTargetLang', 'zh-CN');
setPref('translateCfg', JSON.stringify({ active: 'llm', fallback: [], retry: 1, cache: false }));
aiReply = '你好世界';
/** 反复让出微任务并推进定时器，直到条件成立（或轮次用尽） */
async function drain(cond, maxRounds = 40) {
  for (let i = 0; i < maxRounds; i++) {
    if (cond()) return true;
    await tick(2);
    flushTimers();
  }
  return cond();
}
async function main() {
  TP._refresh('p1');
  eq(T.cfg().active, 'llm', '⑤ 切回 llm 引擎');
  input.value = 'Hello world';
  input.dataset.ppAuto = '0';
  const trBtn = root.byTag('button')[0];
  const clrBtn = root.byTag('button')[1];
  eq(clrBtn.textContent, I18n.t('tpClear'), '⑤ 第二个按钮是清空');
  trBtn.click();
  await drain(() => result.textContent === '你好世界');
  eq(result.textContent, '你好世界', '⑤ 结果区显示译文');
  const resMeta = root.all().find((n) => n.tag === 'span' && /·/.test(n.textContent || ''));
  ok(!!resMeta && resMeta.textContent.indexOf('AI 大模型') >= 0,
    '⑤ 结果带引擎徽章（用户知道是谁翻的）', resMeta && resMeta.textContent);
  const copyBtn = root.byTag('button').find((b) => b.textContent === I18n.t('tpCopy'));
  ok(!!copyBtn, '⑤ 复制按钮出现');
  copyBtn.click();
  eq(calls.copy, '你好世界', '⑤ 复制把译文写进剪贴板');
  eq(copyBtn.textContent, I18n.t('tpCopied'), '⑤ 复制后按钮文案变化');

  clrBtn.click();
  eq(input.value, '', '⑤ 清空按钮清空待译框');
  eq(result.textContent, I18n.t('tpResultEmpty'), '⑤ 清空后结果区回到占位');

  /* ---------------- ⑥ 失败与未就绪：不静默 ---------------- */
  aiThrows = true;
  input.value = 'boom';
  input.dataset.ppAuto = '0';
  trBtn.click();
  await drain(() => /翻译失败/.test(result.textContent));
  has(result.textContent, '翻译失败', '⑥ 失败时结果区给出可读错误');
  has(result.textContent, '超时', '⑥ 透出底层失败原因');
  aiThrows = false;

  setPref('translateCfg', JSON.stringify({ active: 'deepl', fallback: [], retry: 1 }));
  TP._refresh('p1');
  ok(trBtn.disabled === true, '⑥ 引擎未配置密钥 → 翻译按钮禁用（不静默）');
  has(result.textContent, 'DeepL', '⑥ 未就绪时给出具体指引', result.textContent);

  /* ---------------- ⑦ 全文对照 ---------------- */
  setPref('translateCfg', JSON.stringify({ active: 'llm', fallback: [], retry: 1, cache: false }));
  aiReply = 'LLM 译文';
  TP._refresh('p1');
  const fullBtn = root.byTag('button').find((b) => b.textContent === I18n.t('tpStart'));
  ok(!!fullBtn, '⑦ 有「开始」按钮');
  fullBtn.click();
  await drain(() => TP._panes.get('p1').pairs.length === 2);
  eq(TP._panes.get('p1').pairs.length, 2, '⑦ 两段全文都译了');
  const pairList = root.byClass('pp-tr-pairs')[0];
  eq(pairList.children.length, 2, '⑦ 段落对照列表渲染出 2 行');
  eq(pairList.children[0].children.length, 2, '⑦ 每行 = 原文 + 译文两格');
  const barFill = root.byClass('pp-tr-barfill')[0];
  eq(barFill.style.width, '100%', '⑦ 进度条走到 100%');

  const twoColBtn = root.byTag('button').find((b) => b.textContent === I18n.t('tpOpenTwoCol'));
  twoColBtn.click();
  eq(calls.twoCol, 1, '⑦ 「双栏窗口」打开现有对照窗口');
  eq(calls.twoColItem, 101, '⑦ 传的是当前条目');

  const noteBtn = root.byTag('button').find((b) => b.textContent === I18n.t('tpExportNote'));
  noteBtn.click();
  await drain(() => !!noteArgs);
  ok(!!noteArgs, '⑦ 「导出双语笔记」写入笔记');
  has(noteArgs.md, '> Para one content.', '⑦ 笔记正文是「引用块原文 + 译文」结构');
  has(noteArgs.title, '全文对照翻译', '⑦ 笔记标题沿用同一文案');

  /* ---------------- ⑧ 注销 ---------------- */
  TP.unregister();
  eq(calls.unregistered, 'papilot@dev.local-papilot-translate',
    '⑧ 注销用 registerSection 的返回值（不是注册时的 paneID）');

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('-'.repeat(60));
  }
  console.log('翻译面板测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.log('测试异常：' + (e && e.stack || e)); process.exit(1); });
