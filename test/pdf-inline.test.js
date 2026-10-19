#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot PDF 原位对照翻译 测试（插件 0.34.0）
 *
 * 为什么要有它：原位对照的成败全在「段落坐标」与「叠加时机」两件事上——
 * ① 段落切错 = 译文卡错位、一句话被拆成两张卡（版面观感直接崩）；
 * ② 公式/页码被当正文翻 = 原页出现垃圾译文；
 * ③ 缩放/懒加载后不重铺 = 用户滚动几页就发现「后半本没有译文」。
 * 这些在无人环境点不出来，所以：纯函数（行/段聚类）逐条钉死 + 迷你 DOM **真跑模块**
 * 断言「卡片真的按段落 bbox 落在页内、公式不产卡、停止能清干净」。
 *
 * 运行：node test/pdf-inline.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'pdf-inline.js');
const PDFTEXT = path.join(ROOT, 'chrome', 'content', 'scripts', 'ai', 'pdf-text.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function near(a, b, tol, label) {
  return ok(Math.abs(Number(a) - Number(b)) <= (tol || 0.6), label, { got: a, want: b });
}

/* ==================== 迷你 DOM（支持 class/tag/[attr] 选择器 + 桩 rect） ==================== */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parentNode = null;
    this._attrs = {}; this._text = ''; this.style = {}; this.handlers = {};
    this._rect = null; this.clientLeft = 0; this.clientTop = 0;
    this.offsetWidth = 0; this.offsetHeight = 0;
    this.ownerDocument = null; this._scrollHeight = 0;
  }
  get attrClass() { return String(this._attrs.class || ''); }
  _clsList() { return this.attrClass.split(/\s+/).filter(Boolean); }
  hasClass(c) { return this._clsList().indexOf(c) >= 0; }
  get classList() {
    const self = this;
    return {
      add: (c) => { if (!self.hasClass(c)) self._attrs.class = (self.attrClass ? self.attrClass + ' ' : '') + c; },
      remove: (c) => { self._attrs.class = self._clsList().filter((x) => x !== c).join(' '); },
      contains: (c) => self.hasClass(c),
      toggle: (c, on) => { if (on === undefined) on = !self.hasClass(c); if (on) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  setAttribute(k, v) { if (k === 'class') this._attrs.class = String(v); else if (k === 'id') this._attrs.id = String(v); else this._attrs[k] = String(v); }
  getAttribute(k) { if (k === 'class') return this.attrClass; if (k === 'id') return this._attrs.id || null; return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k) { if (k === 'class') this._attrs.class = ''; else delete this._attrs[k]; }
  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = String(v); }
  appendChild(c) { c.parentNode = this; this.children.push(c); if (c.ownerDocument === null) c.ownerDocument = this.ownerDocument; return c; }
  insertBefore(n, ref) { n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n; }
  removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); }
  fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); }
  click() { this.fire('click'); }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    const kids = this.children.length ? this.children.map((c) => c.textContent).join('') : '';
    return this._text ? this._text + kids : kids;
  }
  get scrollHeight() { return this._scrollHeight || this._text.length ? (this._scrollHeight || 14) : 14; }
  // ---- 选择器（够用即可：tag / .class / tag[attr] / .class[attr]） ----
  _matches(sel) {
    const m = /^([a-zA-Z]*)(?:\.([A-Za-z0-9_-]+))?(?:\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\])?$/.exec(sel);
    if (!m) return false;
    const [, tag, cls, attr, val] = m;
    if (tag && this.tag !== tag) return false;
    if (cls && !this.hasClass(cls)) return false;
    if (attr && (this.getAttribute(attr) === null || (val !== undefined && this.getAttribute(attr) !== val))) return false;
    return true;
  }
  _all(out) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  querySelectorAll(sel) { return this._all([]).filter((n) => n._matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return this._rect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { return !!this.parentNode; }
}

function mkDoc() {
  const html = new El('html');
  const head = new El('head');
  html.appendChild(head);
  const doc = {
    head,
    documentElement: html,
    _byId: new Map(),
    createElementNS: (ns, tag) => { const e = new El(tag); e.ownerDocument = doc; return e; },
    createElement: (tag) => { const e = new El(tag); e.ownerDocument = doc; return e; },
    getElementById: (id) => {
      const all = html._all([]);
      for (const n of all) if (n.getAttribute('id') === id) return n;
      return null;
    },
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    querySelector: (sel) => html.querySelector(sel),
  };
  doc.defaultView = { getComputedStyle: () => ({ fontSize: '' }) };
  return doc;
}

/** 造一页：spans = [{text,left,top,width,height,fontSize}]；无 spans 则不建 textLayer（扫描页） */
function mkPage(doc, num, spans) {
  const page = doc.createElementNS('', 'div');
  page.setAttribute('class', 'page');
  page.setAttribute('data-page-number', String(num));
  page._rect = { left: 0, top: 0, width: 612, height: 792 };
  page.offsetWidth = 612; page.offsetHeight = 792;
  if (spans) {
    const layer = doc.createElementNS('', 'div');
    layer.setAttribute('class', 'textLayer');
    for (const s of spans) {
      const sp = doc.createElementNS('', 'span');
      sp.textContent = s.text;
      sp.style.fontSize = (s.fontSize || 10) + 'px';
      sp._rect = { left: s.left, top: s.top, width: s.width || 100, height: s.height || 12,
        right: s.left + (s.width || 100), bottom: s.top + (s.height || 12) };
      layer.appendChild(sp);
    }
    page.appendChild(layer);
  }
  doc.documentElement.appendChild(page);
  return page;
}
/* ==================== 桩环境 ==================== */

const PrefStore = new Map();
const Prefs = {
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};
const notifierObservers = [];

const Zotero = {
  logError() {},
  Items: { get: () => null },
  Reader: {
    _readers: [],
    getByTabID(id) { return this._readers.find((r) => r && r.tabID === id) || null; },
  },
  // P1-8：tab close 观察者（pdf-inline 关一个标签释放一份 state）
  Notifier: {
    registerObserver(obs, types, id) { notifierObservers.push({ obs, types, id }); return id; },
    unregisterObserver(id) {
      const i = notifierObservers.findIndex((o) => o.id === id);
      if (i >= 0) notifierObservers.splice(i, 1);
    },
  },
  getMainWindow: () => ({}),
};
/** 合成一次 Notifier 通知（模拟关标签） */
function fireNotifier(event, type, ids) {
  for (const o of notifierObservers.slice()) {
    try { o.obs.notify(event, type, ids); } catch (e) { /* ignore */ }
  }
}
const Services = { prompt: { alert() {} } };
const I18n = { isZh: true, t: (k) => k };
const translated = [];
const TranslateSvc = {
  available: () => true,
  targetCode: () => 'zh-CN',
  unavailableHint: () => '未配置引擎',
  async translate(text) { translated.push(text); return { ok: true, text: '译:' + text }; },
};

const sandbox = {
  console, Zotero, Services, Prefs, I18n, TranslateSvc,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, RegExp,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// 先加载 PdfText（classify 是单一真源，PdfInline 依赖它）
vm.runInContext(fs.readFileSync(PDFTEXT, 'utf8'), sandbox, { filename: 'pdf-text.js' });
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'pdf-inline.js' });
const PI = sandbox.PdfInline;
const PdfText = sandbox.PdfText;

/** 取某页的原文 span（迷你 DOM 不支持 `.textLayer span` 后代选择器，分两步取） */
function srcSpans(page) {
  const layer = page.querySelector('.textLayer');
  return layer ? layer.querySelectorAll('span') : [];
}

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function loop() {
      let v = false;
      try { v = cond(); } catch (e) { v = false; }
      if (v) return resolve(true);
      if (Date.now() - t0 > (timeoutMs || 4000)) return reject(new Error('waitFor timeout'));
      setTimeout(loop, 15);
    })();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================== ① 纯函数：groupSpans ==================== */
{
  const spans = [
    { text: 'world', left: 90, top: 100, width: 50, height: 12, fontSize: 10 },
    { text: 'Hello', left: 50, top: 101, width: 35, height: 12, fontSize: 10 },
    { text: 'second line', left: 50, top: 130, width: 80, height: 12, fontSize: 10 },
  ];
  const lines = PI.groupSpans(spans);
  eq(lines.length, 2, '① 三 span（含乱序/同行）→ 2 行');
  eq(lines[0].text, 'Hello world', '① 同行按 left 排序并以空格连接');
  near(lines[0].left, 50, 0.5, '① 行 left = 最左 span');
  near(lines[0].right, 140, 0.5, '① 行 right = 最右 span 右边界');
  eq(lines[1].text, 'second line', '① 第二行独立');
  eq(PI.groupSpans([]).length, 0, '① 空输入 → 空行');
  eq(PI.groupSpans([{ text: '   ', left: 1, top: 1 }]).length, 0, '① 纯空白 span 被忽略');
  // 大间隙且无空格 → 补空格（pdf.js span 之间偶尔缺空格）
  const l2 = PI.groupSpans([
    { text: 'end.', left: 50, top: 10, width: 20, height: 12, fontSize: 10 },
    { text: 'Next', left: 80, top: 10, width: 22, height: 12, fontSize: 10 },
  ]);
  eq(l2[0].text, 'end. Next', '① 间隙明显且缺空格 → 自动补一个空格');
}

/* ==================== ② 纯函数：linesToBlocks（段落切分） ==================== */
{
  const lines = PI.groupSpans([
    // 段落 1：两行，行距小（gap=3）
    { text: 'This is the first', left: 50, top: 100, width: 120, height: 12, fontSize: 10 },
    { text: 'paragraph of the paper.', left: 50, top: 115, width: 150, height: 12, fontSize: 10 },
    // 段落 2：缩进 20px
    { text: 'Second paragraph starts here.', left: 70, top: 160, width: 180, height: 12, fontSize: 10 },
    // 段落 3：行距大（gap=25）
    { text: 'A separate block.', left: 50, top: 200, width: 90, height: 12, fontSize: 10 },
  ]);
  const blocks = PI.linesToBlocks(lines);
  eq(blocks.length, 3, '② 四个行 → 三段（行距/缩进各切一次）');
  eq(blocks[0].text, 'This is the first paragraph of the paper.', '② 同段两行合并为一句');
  eq(blocks[0].lines, 2, '② 首段含两行');
  near(blocks[0].top, 100, 0.5, '② 段 top = 首行 top');
  near(blocks[0].bottom, 127, 0.5, '② 段 bottom = 末行 bottom');
  eq(blocks[1].text, 'Second paragraph starts here.', '② 缩进行独立成段');
  eq(blocks[2].text, 'A separate block.', '② 大行距独立成段');
  eq(PI.linesToBlocks([]).length, 0, '② 空行 → 空段');
  // 字号取众数：两行 10px + 一行 7px（上标）→ 段字号 = 10
  const b2 = PI.linesToBlocks([
    { text: 'a', left: 0, top: 0, right: 10, bottom: 10, fontSize: 10 },
    { text: 'b', left: 0, top: 12, right: 10, bottom: 19, fontSize: 7 },
    { text: 'c', left: 0, top: 20, right: 10, bottom: 30, fontSize: 10 },
  ]);
  eq(b2.length, 1, '② 行距紧凑的三行 → 一段');
  eq(b2[0].fontSize, 10, '② 段字号取众数（不被上标带偏）');
}

/* ==================== ③ 纯函数：fitFontSize（卡片字号自适应） ==================== */
eq(PI.fitFontSize(10, 20, 18), 10, '③ 内容不超框 → 原字号');
eq(PI.fitFontSize(10, 20, 40), 6, '③ 内容超框一倍 → 按比例降档并被夹到 6px 下限');
eq(PI.fitFontSize(10, 20, 23), 8.7, '③ 轻微超框 → 按比例小幅降档（8.7px）');
eq(PI.fitFontSize(0, 0, 0), 10, '③ 非法输入兜默认 10');

/* ==================== ④ 迷你 DOM：真跑 start() → 卡片按段落 bbox 叠加 ==================== */
const SPANS = [
  // 段落 1（两行）
  { text: 'This is the first', left: 50, top: 100, width: 120, height: 12, fontSize: 10 },
  { text: 'paragraph of the paper.', left: 50, top: 115, width: 150, height: 12, fontSize: 10 },
  // 段落 2（缩进）
  { text: 'Second paragraph starts here.', left: 70, top: 160, width: 180, height: 12, fontSize: 10 },
  // 图注（caption → 照常翻译）
  { text: 'Figure 1. System overview.', left: 50, top: 200, width: 160, height: 12, fontSize: 10 },
  // 公式（formula → 不翻译、不叠加）
  { text: 'σ² = α² + β²', left: 50, top: 230, width: 120, height: 12, fontSize: 10 },
  // 页码（junk → 跳过）
  { text: '12', left: 50, top: 400, width: 20, height: 12, fontSize: 10 },
];

async function main() {
  PrefStore.clear();
  PrefStore.set('pdfInlineMode', 'overlay');
  PrefStore.set('pdfInlineGapMs', 0);

  const doc = mkDoc();
  const page1 = mkPage(doc, 1, SPANS);
  mkPage(doc, 2, null); // 无文本层（扫描页）
  const win = { document: doc };
  // 0.38.3：兜底路径要能拿到 viewport.transform 才会问 worker；扫描页 = 有 transform
  // 但 getPageData 返回空字符（真实语义）。测试桩照此建模。
  const T4 = [1, 0, 0, -1, 0, 792];
  let fetchCalls = 0;
  const app = {
    pdfDocument: {
      getPageData: async () => { fetchCalls++; return { chars: [] }; },   // 真扫描页：空字符
    },
    pdfViewer: { pagesCount: 2, _pages: [{ viewport: { transform: T4 } }, { viewport: { transform: T4 } }] },
    eventBus: { on() {}, off() {} },
  };
  const fakeWin = { document: doc, PDFViewerApplication: app };
  const reader = { itemID: 1, _internalReader: { _primaryView: { _iframeWindow: fakeWin } } };

  /* ---- 4.1 viewerOf 认得这个 fake reader（前置自检，失败则后续断言无意义） ---- */
  const v = PdfText.viewerOf(reader);
  ok(v && v.win && v.win.document === doc, '4.0 PdfText.viewerOf 能从 fake reader 拿到 viewer 文档');
  ok(PI.start(reader), '4.1 start() 返回 true');

  /* ---- 4.2 翻译完成后：卡片数量与内容 ---- */
  await waitFor(() => { const s = PI.snapshot()[0]; return s && s.done === s.blocks && s.blocks > 0; }, 5000);
  const snap = PI.snapshot()[0];
  eq(snap.active, true, '4.2 状态为启用');
  eq(snap.blocks, 3, '4.3 段落数 = 3（两段正文 + 图注；公式与页码不计）');
  eq(snap.done, 3, '4.4 三段全部翻译完成');
  // 0.38.3：扫描页判定走异步兜底（getPageData → 空字符）→ 等它落定
  await waitFor(() => PI.snapshot()[0].noTextPages === 1, 3000);
  eq(PI.snapshot()[0].noTextPages, 1, '4.5 无文本层的页被记录（扫描页提示）');
  eq(fetchCalls, 1, '4.5b ★ 扫描页结果负缓存：worker 只被问一次（轮询空转的卡顿根因）');

  const cards = page1.querySelectorAll('.pp-pit-card');
  eq(cards.length, 3, '4.6 页内恰好 3 张译文卡（公式段不产卡）');
  await waitFor(() => doc.querySelectorAll('.pp-pit-card').length >= 3);
  // 位置：卡片贴在段落 bbox 上（left/top 各留 2px padding）
  near(parseFloat(cards[0].style.left), 48, 1, '4.7 首卡 left 对应段落左边界（-2px padding）');
  near(parseFloat(cards[0].style.top), 98, 1, '4.8 首卡 top 对应段落顶边');
  near(parseFloat(cards[0].style.width), 154, 2, '4.9 首卡宽度对应段落宽度（150 + 4px padding）');
  near(parseFloat(cards[1].style.top), 158, 1, '4.10 第二卡贴在第二段位置');
  eq(cards[0].textContent, '译:This is the first paragraph of the paper.',
    '4.11 卡片文本是译文，且整段在**同一张卡**里（不再一段一段拆开）');
  ok(cards.every((c) => String(c.attributeClass || c.getAttribute('class')).indexOf('pp-pit-ov') >= 0),
    '4.12 overlay 模式卡片带 ov 类');
  eq(doc.querySelectorAll('.pp-pit-layer').length, 1,
    '4.13 只有有文本层的页建译文层（扫描页不建空层）');
  // 原文 span 被标记淡显（overlay 模式）
  const srcMarked = srcSpans(page1).filter((s) => s.hasClass('pp-pit-src')).length;
  eq(srcMarked, 6, '4.14 overlay 模式下原文 span 全部标记（仅公式/页码也标，统一淡化）');

  /* ---- 4.15 公式与页码没有被送去翻译 ---- */
  ok(translated.every((t) => t.indexOf('σ²') < 0), '4.15 公式从未送翻译');
  ok(translated.every((t) => t !== '12'), '4.16 页码行从未送翻译');

  /* ---- 4.17 计数文本挂到按钮上（按钮由 renderToolbar 注入，这里手工造一个验证） ---- */
  const btn = doc.createElementNS('', 'button');
  btn.id = 'papilot-inline-reader-button';
  const cnt = doc.createElementNS('', 'span');
  cnt.id = 'papilot-inline-reader-button-count';
  btn.appendChild(cnt);
  doc.documentElement.appendChild(btn);
  PI.refresh(); // 触发一次重绘/计数刷新
  await waitFor(() => cnt.textContent === '3/3', 3000);
  eq(cnt.textContent, '3/3', '4.17 工具栏计数显示 已译/总段');

  /* ---- 4.18 模式切 bilingual：卡片类切换（半透明浮层） ---- */
  PrefStore.set('pdfInlineMode', 'bilingual');
  PI.refresh();
  await sleep(60);
  const cards2 = page1.querySelectorAll('.pp-pit-card');
  ok(cards2.length >= 3 && String(cards2[0].getAttribute('class')).indexOf('pp-pit-bi') >= 0,
    '4.18 切到 bilingual → 卡片带 bi 类（原文完整可见）');
  const marked2 = srcSpans(page1).filter((s) => s.hasClass('pp-pit-src')).length;
  eq(marked2, 0, '4.19 bilingual 模式不再淡化原文');

  /* ---- 4.20 缓存命中：重铺零请求 ---- */
  const callsBefore = translated.length;
  PI.refresh();
  await sleep(60);
  eq(translated.length, callsBefore, '4.20 重铺走缓存，不再请求翻译引擎');

  /* ---- 4.21 停止：清干净（层与原文标记都不留） ---- */
  PI.stop(reader);
  eq(page1.querySelectorAll('.pp-pit-card').length, 0, '4.21 stop() 后页内无译文卡');
  eq(page1.querySelectorAll('.pp-pit-layer').length, 0, '4.22 stop() 后译文层被移除');
  const marked3 = srcSpans(page1).filter((s) => s.hasClass('pp-pit-src')).length;
  eq(marked3, 0, '4.23 stop() 后原文标记被清除');
  eq(PrefStore.get('pdfInlineMode'), 'off', '4.24 stop() 把模式 pref 置 off（下次不自动开）');

  /* ---- 4.25 关闭态下 start() 会重新打开（按钮语义） ---- */
  ok(PI.start(reader), '4.25 关闭后再 start() 仍可用');
  eq(PrefStore.get('pdfInlineMode'), 'overlay', '4.26 start() 把模式恢复为 overlay');
  await waitFor(() => { const s = PI.snapshot()[0]; return s && s.done === s.blocks; }, 5000);

  /* ---- 4.27 引擎不可用时不可用提示（ready() 门禁） ---- */
  TranslateSvc.available = () => false;
  const doc2 = mkDoc();
  mkPage(doc2, 1, SPANS);
  const reader2 = { itemID: 2, _internalReader: { _primaryView: { _iframeWindow: { document: doc2, PDFViewerApplication: { pdfDocument: {}, eventBus: { on() {}, off() {} } } } } } };
  const okStart = PI.start(reader2);
  ok(okStart === true, '4.27 引擎不可用时 start 仍返回（门禁在按钮/入口层）');
  TranslateSvc.available = () => true;
  PI.stop(reader2, { keepPref: true });

  /* ---- 4.28 卸载清理 ---- */
  PI.unregister();
  eq(doc.querySelectorAll('.pp-pit-card').length, 0, '4.28 unregister() 清掉全部译文卡');

  /* ==================== ⑨ translateAll：整篇翻译（逐页滚动触发渲染） ==================== */
{
  PrefStore.clear();
  PrefStore.set('pdfInlineMode', 'overlay');
  PrefStore.set('pdfInlineGapMs', 0);
  const doc = mkDoc();
  // 3 页：第 2 页没有 textLayer（模拟扫描页 → 应被跳过并计数）
  mkPage(doc, 1, [
    // 两行间距 28 > 1.45×字号 → 判为**两段**（行距小于阈值会合成一段，属预期）
    { text: 'Alpha paragraph one.', left: 50, top: 100, width: 200, height: 12, fontSize: 10 },
    { text: 'Alpha paragraph two.', left: 50, top: 140, width: 200, height: 12, fontSize: 10 },
  ]);
  mkPage(doc, 2, null);
  mkPage(doc, 3, [
    { text: 'Gamma paragraph.', left: 50, top: 100, width: 200, height: 12, fontSize: 10 },
  ]);
  // 第 3 页排在文档 800px 处 → 整篇翻译期间容器真的会被滚下去（否则 scrollTop 断言
  // 恒为 0，测不出「结束后还原」）
  doc.querySelector('.page[data-page-number="3"]')._rect =
    { left: 0, top: 800, width: 612, height: 792 };
  const container = doc.createElementNS('', 'div');
  container.id = 'viewerContainer';
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 });
  doc.documentElement.appendChild(container);
  const viewer = { pagesCount: 3, currentPageNumber: 1 };
  const app = { pdfDocument: {}, pdfViewer: viewer, eventBus: { on() {}, off() {} } };
  const fakeWin = { document: doc, PDFViewerApplication: app };
  const reader = { itemID: 9, _internalReader: { _primaryView: { _iframeWindow: fakeWin } } };
  const progressCalls = [];
  const res = await PI.translateAll(reader, {
    waitTicks: 1, keepScroll: true,
    onProgress: (p) => progressCalls.push(p),
  });
  eq(res.error, null, '⑨ translateAll 无错误');
  eq(res.totalPages, 3, '⑨ 读到总页数');
  eq(res.pages, 3, '⑨ 遍历到最后一页');
  eq(res.skipped, 1, '⑨ ★ 无文本层的页被跳过并计数（不当成空内容）');
  eq(res.blocks, 3, '⑨ 三页共 3 段（第 1 页 2 段 + 第 3 页 1 段）');
  eq(res.done, 3, '⑨ 三段全部落定');
  eq(progressCalls.length, 3, '⑨ 每页一次进度回调（含跳过页）');
  ok(progressCalls.some((p) => p.phase === 'skip' && p.page === 2), '⑨ 跳过页的进度带 phase=skip');
  eq(container.scrollTop, 0, '⑨ ★ 结束后滚回原位置（不打扰用户当前阅读位置）');
  eq(viewer.currentPageNumber, 1, '⑨ ★ 结束后 currentPageNumber 也还原（P2-10：不被拖到末页）');
  const cards = doc.querySelectorAll('.pp-pit-card');
  eq(cards.length, 3, '⑨ 三页各段落都注入了译文卡（整篇一次铺好）');
  PI.stop(reader, { keepPref: true });
}

  /* ==================== ⑩ getPageData 兜底（0.38.1：无 textLayer 也能翻译） ==================== */
{
  /* ---- ⑩.1 rectToCssBox：PDF 用户空间 → 页内 CSS（标准旋转 0 变换） ---- */
  // t = [s,0,0,-s,0,pageH*s]（s=1.5，页高 792）——rect [72,700,78,712] → {108,120,9,18}
  const T = [1.5, 0, 0, -1.5, 0, 792 * 1.5];
  const box = PI.rectToCssBox(T, [72, 700, 78, 712]);
  ok(box && Math.abs(box.left - 108) < 0.01 && Math.abs(box.top - 120) < 0.01,
    '⑩.1 rect → CSS 盒（y 轴翻转 + 缩放）', box);
  ok(Math.abs(box.width - 9) < 0.01 && Math.abs(box.height - 18) < 0.01, '⑩.1b 盒宽高随 scale 缩放');
  eq(PI.rectToCssBox(null, [1, 2, 3, 4]), null, '⑩.1c 无 transform → null');
  eq(PI.rectToCssBox(T, null), null, '⑩.1d 无 rect → null');
  eq(PI.rectToCssBox(T, [5, 5, 5, 5]), null, '⑩.1e 零面积 rect → null');

  /* ---- ⑩.2 charsToLineSpans：Zotero 的 lineBreakAfter 断行、spaceAfter 补空格 ---- */
  const mkChars = (lines) => {
    const chars = [];
    for (const ln of lines) {
      let x = ln.x;
      for (let i = 0; i < ln.text.length; i++) {
        const c = ln.text[i];
        chars.push({ c, rect: [x, ln.y, x + 6, ln.y + 12], rotation: 0 });
        x += 6;
        if (i < ln.text.length - 1 && c === ' ') chars[chars.length - 1].spaceAfter = true;
      }
      chars[chars.length - 1].lineBreakAfter = true;
      if (ln.paraEnd) chars[chars.length - 1].paragraphBreakAfter = true;
    }
    return chars;
  };
  const CHARS = mkChars([
    { text: 'Hello world first line.', x: 72, y: 700 },
    { text: 'Second line same para.', x: 72, y: 686 },
    { text: 'A brand new paragraph.', x: 72, y: 650, paraEnd: true },
  ]);
  const spans = PI.charsToLineSpans(CHARS, T);
  eq(spans.length, 3, '⑩.2 三行字符 → 3 个行级 span（lineBreakAfter 断行）');
  eq(spans[0].text, 'Hello world first line.', '⑩.2b 行文本完整（含空格）');
  near(spans[0].left, 108, 0.6, '⑩.2c 行 left = 首字符 CSS x');
  near(spans[0].top, 120, 0.6, '⑩.2d 行 top = 字符顶边（y 翻转后）');
  ok(spans[0].fontSize >= 17 && spans[0].fontSize <= 19, '⑩.2e 行字号 ≈ 字符高（18）');
  eq(PI.charsToLineSpans([], T).length, 0, '⑩.2f 空字符 → 空 span');
  eq(PI.charsToLineSpans([{ c: 'x', ignorable: true, rect: [1, 1, 2, 2] }], T).length, 0,
    '⑩.2g ignorable 字符被跳过');
  eq(PI.charsToLineSpans([{ c: 'x', rect: null }], T).length, 0, '⑩.2h 无 rect 字符被跳过');

  /* ---- ⑩.3 blocksFromCharsCore：段落切分 + 分类（与 textLayer 路径同构） ---- */
  const blocks = PI.blocksFromCharsCore(CHARS, T);
  ok(blocks && blocks.length === 2, '⑩.3 三行 → 2 段（第三行行距大 → 新段）', blocks && blocks.length);
  eq(blocks[0].kind, 'body', '⑩.3b 正常文本判 body（PdfText.classify 单一真源）');
  ok(String(blocks[0].text).indexOf('Hello world') === 0 &&
    String(blocks[0].text).indexOf('Second line') > 0, '⑩.3c 同段两行文本合并');
  eq(blocks[1].text, 'A brand new paragraph.', '⑩.3d 第二段独立成块');
  near(blocks[0].top, 120, 0.6, '⑩.3e 块 top = 首行 top');
  eq(PI.blocksFromCharsCore([], T), null, '⑩.3f 空字符 → null（扫描页）');

  /* ---- ⑩.4 端到端：translateAll 无 textLayer 的页走 getPageData 兜底落卡 ---- */
  PrefStore.clear();
  PrefStore.set('pdfInlineMode', 'overlay');
  PrefStore.set('pdfInlineGapMs', 0);
  const docF = mkDoc();
  mkPage(docF, 1, null);   // 无 textLayer，但 getPageData 有字符 → 兜底翻译落卡
  mkPage(docF, 2, null);   // 无 textLayer 且字符为空 → 真扫描页 → 如实跳过
  const contF = docF.createElementNS('', 'div');
  contF.id = 'viewerContainer';
  contF.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 });
  docF.documentElement.appendChild(contF);
  const viewerF = {
    pagesCount: 2, currentPageNumber: 1,
    _pages: [{ viewport: { transform: T } }, { viewport: { transform: T } }],
  };
  const appF = {
    pdfViewer: viewerF,
    pdfDocument: { getPageData: async (arg) => ({ chars: (arg && arg.pageIndex === 0) ? CHARS : [] }) },
    eventBus: { on() {}, off() {} },
  };
  const readerF = { itemID: 10, _internalReader: { _primaryView: { _iframeWindow: { document: docF, PDFViewerApplication: appF } } } };
  const progF = [];
  const resF = await PI.translateAll(readerF, { waitTicks: 1, onProgress: (p) => progF.push(p) });
  eq(resF.error, null, '⑩.4 translateAll 无错误');
  eq(resF.skipped, 1, '⑩.4b ★ 真扫描页（无字符）才计入 skipped');
  eq(resF.blocks, 2, '⑩.4c ★ 无 textLayer 的第 1 页经兜底产出 2 段');
  eq(resF.done, 2, '⑩.4d 兜底段落同样完成翻译');
  ok(progF.some((p) => p.phase === 'skip' && p.page === 2), '⑩.4e 扫描页进度带 phase=skip');
  const page1F = docF.querySelector('.page[data-page-number="1"]');
  const cardsF = page1F.querySelectorAll('.pp-pit-card');
  eq(cardsF.length, 2, '⑩.4f ★ 兜底段落真的落了译文卡');
  const layerF = page1F.querySelector('.pp-pit-layer');
  ok(layerF && layerF.hasClass('pp-pit-fb'), '⑩.4g 兜底译文层带 pp-pit-fb 类（描边提示）');
  ok(String(cardsF[0].textContent).indexOf('译:') === 0, '⑩.4h 卡片内容是译文');
  eq(docF.querySelector('.page[data-page-number="2"]').querySelectorAll('.pp-pit-card').length, 0,
    '⑩.4i 扫描页不产卡');
  const stF = PI._states.get(readerF);
  eq(stF && stF.noTextPages.indexOf('2') >= 0, true, '⑩.4j 扫描页进 noTextPages（按钮提示「需 OCR」）');
  PI.stop(readerF, { keepPref: true });
}

  /* ==================== ⑪ 双栏检测与拆分（0.38.2） ==================== */
{
  /* ---- ⑪.1 rowPartsOf：top 聚行 + parts 按 left 排序 ---- */
  const spans = [
    { text: 'right col', left: 320, top: 100, width: 200, height: 12, fontSize: 10 },
    { text: 'left col', left: 40, top: 101, width: 200, height: 12, fontSize: 10 },
    { text: 'next line', left: 40, top: 130, width: 200, height: 12, fontSize: 10 },
  ];
  const rows = PI.rowPartsOf(spans);
  eq(rows.length, 2, '⑪.1 top 聚行 → 2 行');
  eq(rows[0].parts.length, 2, '⑪.1b 同一基线的左右栏 span 是一行的两个 part');
  eq(rows[0].parts[0].text, 'left col', '⑪.1c parts 按 left 排序');

  /* ---- ⑪.2 detectColumnSplit：合成双栏 → 检出分界 ---- */
  const mk2col = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ text: 'L' + i, left: 40, top: 100 + i * 20, width: 220, height: 12, fontSize: 10 });
      out.push({ text: 'R' + i, left: 320, top: 100 + i * 20, width: 220, height: 12, fontSize: 10 });
    }
    return out;
  };
  const sp2 = mk2col(12);
  const splitX = PI.detectColumnSplit(PI.rowPartsOf(sp2), 600);
  ok(splitX !== null, '⑪.2 双栏检出分界', splitX);
  ok(splitX >= 260 && splitX <= 320, '⑪.2b 分界落在栏间距区间 [260,320]', splitX);

  eq(PI.detectColumnSplit(PI.rowPartsOf([
    { text: 'single col long line text here', left: 50, top: 100, width: 500, height: 12, fontSize: 10 },
  ]), 600), null, '⑪.2c 单行不足 → null');
  eq(PI.detectColumnSplit(PI.rowPartsOf(mk2col(3)), 600), null, '⑪.2d 行数不足 6 → null（宁缺勿滥）');
  eq(PI.detectColumnSplit(PI.rowPartsOf([
    { text: 'a', left: 50, top: 100, width: 400, height: 12, fontSize: 10 },   // 整宽行
    { text: 'b', left: 50, top: 130, width: 400, height: 12, fontSize: 10 },
    { text: 'c', left: 50, top: 160, width: 400, height: 12, fontSize: 10 },
    { text: 'd', left: 50, top: 190, width: 400, height: 12, fontSize: 10 },
    { text: 'e', left: 50, top: 220, width: 400, height: 12, fontSize: 10 },
    { text: 'f', left: 50, top: 250, width: 400, height: 12, fontSize: 10 },
  ]), 600), null, '⑪.2e 全是整宽单段行（无行内空档）→ null');

  /* ---- ⑪.3 目录页负例：行内空档位置杂乱（「标题……页码」）→ 不判双栏 ---- */
  const tocSpans = [];
  for (let i = 0; i < 10; i++) {
    const titleEnd = 60 + (i % 5) * 80;      // 标题长度不一 → 空档左缘乱飞
    tocSpans.push({ text: '第一章 标题' + i, left: 40, top: 100 + i * 24, width: titleEnd - 40, height: 12, fontSize: 12 });
    tocSpans.push({ text: String(i + 1), left: 540, top: 100 + i * 24, width: 20, height: 12, fontSize: 12 });
  }
  eq(PI.detectColumnSplit(PI.rowPartsOf(tocSpans), 600), null,
    '⑪.3 ★ 目录页（行内空档边缘杂乱）不误判双栏');

  /* ---- ⑪.4 splitByColumn：行级归属（整宽行不撕开） ---- */
  {
    // 整宽摘要行：两半 span 恰好跨分界 → 整行归跨栏组，保持完整
    const rowsA = PI.rowPartsOf([
      { text: 'tivity disorder and obsessive', left: 71, top: 200, width: 118, height: 12, fontSize: 10 },
      { text: '–', left: 190, top: 200, width: 5, height: 12, fontSize: 10 },
      { text: 'compulsive disorder. The first', left: 195, top: 200, width: 289, height: 12, fontSize: 10 },
    ]);
    const g = PI.splitByColumn(rowsA, 270, 544);
    eq(g.cross.length, 3, '⑪.4 覆盖分界的整宽行 → 全部 span 归跨栏组（不撕行）');
    eq(g.left.length + g.right.length, 0, '⑪.4b 不剩散件');
    // 真双栏行：左右各归其栏
    const rowsB = PI.rowPartsOf([
      { text: 'L0', left: 40, top: 100, width: 220, height: 12, fontSize: 10 },
      { text: 'R0', left: 320, top: 100, width: 220, height: 12, fontSize: 10 },
    ]);
    const g2 = PI.splitByColumn(rowsB, 270, 600);
    eq(g2.left.length, 1, '⑪.4c 双栏行的左半归左栏');
    eq(g2.right.length, 1, '⑪.4d 右半归右栏');
    eq(g2.cross.length, 0, '⑪.4e 双栏行不进跨栏组');
  }

  /* ---- ⑪.5 blocksFromSpans 端到端：双栏页 → 段落块各归其栏、标题整宽 ---- */
  {
    const sp = [
      // 整宽标题（跨栏）
      { text: 'Chapter Title Here', left: 140, top: 40, width: 320, height: 16, fontSize: 16 },
    ];
    for (let i = 0; i < 10; i++) {
      sp.push({ text: 'left paragraph line ' + i + ' with some words', left: 40, top: 120 + i * 20, width: 220, height: 12, fontSize: 10 });
      sp.push({ text: 'right paragraph line ' + i + ' more text', left: 320, top: 120 + i * 20, width: 220, height: 12, fontSize: 10 });
    }
    const blocks = PI.blocksFromSpans(sp, 600);
    ok(blocks && blocks.length >= 3, '⑪.5 双栏页产出 ≥3 块', blocks && blocks.length);
    const title = blocks.find((b) => b.text.indexOf('Chapter Title') === 0);
    ok(title, '⑪.5b 整宽标题独立成块');
    near(title.right - title.left, 320, 2, '⑪.5c 标题块保持整宽');
    const bodies = blocks.filter((b) => b.kind === 'body' && b.text.indexOf('paragraph line') >= 0);
    ok(bodies.length >= 2, '⑪.5d 左右栏段落各成块');
    ok(bodies.every((b) => (b.right <= 300) || (b.left >= 300)),
      '⑪.5e ★ 正文块不横跨栏间距（左右栏结构保留）',
      bodies.map((b) => [Math.round(b.left), Math.round(b.right)]));
    const leftB = bodies.filter((b) => b.right <= 300);
    const rightB = bodies.filter((b) => b.left >= 300);
    ok(leftB.length >= 1 && rightB.length >= 1, '⑪.5f 两栏都有块');
    ok(String(leftB[0].text).indexOf('left paragraph') >= 0 &&
      String(rightB[0].text).indexOf('right paragraph') >= 0,
      '⑪.5g 左右栏文本不交错（各是连续的一句话）');
  }

  /* ---- ⑪.6 chars 兜底路径同样双栏感知 ---- */
  {
    // chars 模拟双栏：两列各 8 行（worker 的 lineBreakAfter 断行），中间栏间距
    const T = [1, 0, 0, -1, 0, 800];
    const chars = [];
    let x = 40, y = 700;
    for (let i = 0; i < 8; i++) {
      for (const c of 'left col!') {
        chars.push({ c, rect: [x, y, x + 8, y + 12] });
        x += 8;
      }
      chars[chars.length - 1].lineBreakAfter = true;
      x = 40; y -= 20;
    }
    x = 320;
    for (let i = 0; i < 8; i++) {
      for (const c of 'right col!') {
        chars.push({ c, rect: [x, y, x + 8, y + 12] });
        x += 8;
      }
      chars[chars.length - 1].lineBreakAfter = true;
      x = 320; y -= 20;
    }
    const blocks = PI.blocksFromCharsCore(chars, T);
    ok(blocks && blocks.length >= 2, '⑪.6 chars 兜底双栏产出 ≥2 块', blocks && blocks.length);
    const noCross = (blocks || []).every((b) => (b.right <= 300) || (b.left >= 300));
    ok(noCross, '⑩⑪.6b 兜底块也不跨栏间距');
  }
}

  /* ==================== ⑫ scalechanging 缩放保底（0.38.2） ==================== */
{
    PrefStore.clear();
    PrefStore.set('pdfInlineMode', 'overlay');
    PrefStore.set('pdfInlineGapMs', 0);
    const doc = mkDoc();
    mkPage(doc, 1, [
      { text: 'Zoom test paragraph.', left: 50, top: 100, width: 200, height: 12, fontSize: 10 },
    ]);
    const handlers = {};
    const app = {
      pdfDocument: {},
      pdfViewer: { pagesCount: 1 },
      eventBus: {
        on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
        off(ev, fn) { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
      },
    };
    const reader = { itemID: 12, _internalReader: { _primaryView: { _iframeWindow: { document: doc, PDFViewerApplication: app } } } };
    PI.start(reader);
    ok(handlers["scalechanging"] && handlers["scalechanging"].length >= 1,
      '⑫.1 ★ scalechanging 已挂监听（缩放保底入口）');
    const st = PI._states.get(reader);
    ok(st && st.pollTimer != null, '⑫.2 start 后轮询在跑');
    // 模拟「轮询快到期」：scalechanging → 重启轮询窗口（ticks 清零）
    st.pollTicks = 55;
    for (const fn of handlers["scalechanging"]) fn();
    eq(st.pollTicks, 0, '⑫.3 ★ scalechanging 重启轮询窗口（读 54 秒后再缩放也能重铺）');
    // 手动把轮询杀掉再触发 → 应重新拉起
    clearInterval(st.pollTimer); st.pollTimer = null;
    for (const fn of handlers["scalechanging"]) fn();
    ok(st.pollTimer != null, '⑫.4 轮询已停时 scalechanging 重新拉起轮询');
    // unbind 干净
    PI.stop(reader, { keepPref: true });
    eq(handlers["scalechanging"] ? handlers["scalechanging"].length : 0, 0,
      '⑫.5 stop 后 scalechanging 监听被移除（不泄漏）');
    clearInterval(st.pollTimer);
  }

  /* ==================== ⑬ 幂等与性能（0.38.3：无 textLayer 页不得空转） ==================== */
{
    PrefStore.clear();
    PrefStore.set('pdfInlineMode', 'overlay');
    PrefStore.set('pdfInlineGapMs', 0);
    const doc = mkDoc();
    mkPage(doc, 1, null);                       // 无 textLayer（走 getPageData 兜底）
    const T = [1, 0, 0, -1, 0, 800];
    const chars = [];
    let x = 50;
    for (const c of 'Fallback page paragraph.') {
      chars.push({ c, rect: [x, 700, x + 8, 712] });
      x += 8;
    }
    chars[chars.length - 1].lineBreakAfter = true;
    let fetches = 0;
    const app = {
      pdfDocument: { getPageData: async () => { fetches++; return { chars }; } },
      pdfViewer: { pagesCount: 1, _pages: [{ viewport: { transform: T } }] },
      eventBus: { on() {}, off() {} },
    };
    const reader = { itemID: 13, _internalReader: { _primaryView: { _iframeWindow: { document: doc, PDFViewerApplication: app } } } };
    const st = PI.start(reader) && PI._states.get(reader);
    await waitFor(() => st.blockCount > 0, 3000);
    const fetchesAfterFirst = fetches;
    const rendersAfterFirst = st.stat.charRenders;
    eq(fetchesAfterFirst, 1, '⑬.1 兜底页只问 worker 一次');
    ok(st.pages.get('1') && st.pages.get('1').sig, '⑬.2 ★ 无 textLayer 页有稳定几何签名（0.38.2 是空串 → 永不跳过）');
    // 模拟轮询连续 5 拍（0.38.2 在此处每拍重跑 getPageData + 重铺卡片 → 卡顿）
    for (let i = 0; i < 5; i++) PI.processPage(st, doc.querySelector('.page[data-page-number="1"]'));
    await sleep(50);
    eq(fetches, fetchesAfterFirst, '⑬.3 ★ 重复扫描不再问 worker（负结果/结果都缓存）');
    eq(st.stat.charRenders, rendersAfterFirst, '⑬.4 ★ 重复扫描不再重铺卡片');
    // 缩放（页几何变化）→ 应重铺但仍复用缓存的 chars（不发新请求）
    const pageEl = doc.querySelector('.page[data-page-number="1"]');
    pageEl.offsetWidth = 900; pageEl.offsetHeight = 1200;
    PI.processPage(st, pageEl);
    await waitFor(() => st.stat.charRenders > rendersAfterFirst, 2000);
    eq(fetches, fetchesAfterFirst, '⑬.5 ★ 缩放重铺复用 chars 缓存（零新增 worker 往返）');
    PI.stop(reader, { keepPref: true });
    clearInterval(st.pollTimer);
  }

  /* ==================== ⑭ 生命周期：state 释放 / 队列清理（P1-8） ==================== */
{
    PrefStore.clear();
    PrefStore.set('pdfInlineMode', 'overlay');
    PrefStore.set('pdfInlineGapMs', 0);
    const doc = mkDoc();
    mkPage(doc, 1, [
      { text: 'Lifecycle paragraph one.', left: 50, top: 100, width: 200, height: 12, fontSize: 10 },
      { text: 'Lifecycle paragraph two.', left: 50, top: 160, width: 200, height: 12, fontSize: 10 },
    ]);
    // 引擎挂起（永不返回）→ 任务真的留在队列里，才能验证「stop 会清队列」
    const origTranslate = TranslateSvc.translate;
    TranslateSvc.translate = () => new Promise(() => {});
    const app = { pdfDocument: {}, pdfViewer: { pagesCount: 1 }, eventBus: { on() {}, off() {} } };
    const reader = {
      itemID: 31, tabID: 'pp-tab-31',
      _internalReader: { _primaryView: { _iframeWindow: { document: doc, PDFViewerApplication: app } } },
    };
    Zotero.Reader._readers.push(reader);
    const baseSize = PI._states.size;
    PI.register('papilot@test');
    ok(PI.start(reader), '⑭.1 start 建立 state');
    const st = PI._states.get(reader);
    ok(st && st.queue && st.queue.items.length > 0, '⑭.2 引擎挂起时任务仍在队列（前置）', st && st.queue && st.queue.items.length);

    PI.stop(reader, { keepPref: true });
    eq(st.queue.items.length, 0, '⑭.3 ★ stop() 清空待办队列（旧版本残留 → 重开会把旧任务重跑）');
    eq(st.queue.running, false, '⑭.4 stop() 复位 running');
    PI._enqueue(st, async () => { throw new Error('dropped'); });
    eq(st.queue.items.length, 0, '⑭.5 ★ stopped 状态下 enqueue 直接丢弃（不重复计费）');
    eq(PI._states.size, baseSize + 1, '⑭.6 stop() 不摘 state（语义未变：仍可 start 重开）');

    // 关标签 → 自动释放（旧版本只在插件 unregister 时清理 → 开一篇关一篇泄漏一份）
    fireNotifier('close', 'tab', ['pp-tab-31']);
    eq(PI._states.has(reader), false, '⑭.7 ★ 关闭标签 → state 被释放（含 charsByPage/页块）');
    eq(PI._states.size, baseSize, '⑭.8 _states 回到基线（无泄漏）');
    eq(PI.disposeState(reader), false, '⑭.9 disposeState 幂等（重复调用不抛、返回 false）');

    const observersBefore = notifierObservers.length;
    PI.unregister();
    eq(notifierObservers.length, observersBefore - 1, '⑭.10 unregister 注销 tab 观察者');

    TranslateSvc.translate = origTranslate;
    Zotero.Reader._readers = Zotero.Reader._readers.filter((r) => r !== reader);
  }

/* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('-'.repeat(60));
  }
  console.log('PDF 原位对照翻译：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.log('✗ 测试自身异常：' + (e && e.stack || e));
  process.exit(1);
});
