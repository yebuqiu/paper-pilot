#!/usr/bin/env node
/* PaperPilot PDF 原位对照翻译 测试（插件 0.34.0）
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

const Zotero = {
  logError() {},
  Items: { get: () => null },
  Reader: { _readers: [] },
  getMainWindow: () => ({}),
};
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
  const app = { pdfDocument: {}, eventBus: { on() {}, off() {} } };
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
  eq(snap.noTextPages, 1, '4.5 无文本层的页被记录（扫描页提示）');

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
  btn.id = 'paperpilot-inline-reader-button';
  const cnt = doc.createElementNS('', 'span');
  cnt.id = 'paperpilot-inline-reader-button-count';
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
  const cards = doc.querySelectorAll('.pp-pit-card');
  eq(cards.length, 3, '⑨ 三页各段落都注入了译文卡（整篇一次铺好）');
  PI.stop(reader, { keepPref: true });
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
