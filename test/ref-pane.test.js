#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 阅读器右侧栏 · 参考文献面板 渲染与行为测试（0.40.0）
 *
 * 无人环境点不了 Zotero 的 ItemPane section，而它承担的是「参考文献入口本身」——
 * 渲染崩了或接线断了，表现就是「侧栏空白 / 点了没反应」的典型静默失败。
 * 用「迷你 DOM + vm 沙箱」把面板**真跑一遍**（真实加载 ref-format.js / ref-import.js /
 * ref-pane.js，只桩 Zotero 与网络），断言：
 *   ① section 注册参数：paneID / header / sidenav 的 l10nID（且 .ftl 里真有条目）/
 *      onRender 必填（Z10 缺了静默返回 false）；
 *   ② 面板结构：数据源圆点 ×5、刷新按钮、列表容器；
 *   ③ 参考文献区段定位与解析（喂样例全文文本，走真实 RefFormat）；
 *   ④ 列表渲染：序号 / 题录截断行 / 来源徽标 / `+` 按钮；缓存命中时状态行标「缓存」；
 *   ⑤ 缓存读写与 LRU（上限内淘汰最旧）；
 *   ⑥ 刷新按钮：单击 = 按缓存渲染（不重新抓）；长按 ≥500ms = 跳过缓存强刷；
 *   ⑦ 圆点点击 = 指定该源通道重新检索（channels 参数透传）；
 *   ⑧ `+` 未入库分支：补全 → 判重未中 → importRecords 带 contextItem → 按钮变「已入库·关联」；
 *   ⑨ 判重命中分支：按钮变「已入库·关联」，点击**只**建立双向 related（不调 importRecords）；
 *   ⑩ RefImport._linkContext：新条目进当前条目全部分类 + 双向 related + 各自 saveTx；
 *   ⑪ 注销用 registerSection 的返回值。
 *
 * 运行：node test/ref-pane.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const S = (p) => path.join(ROOT, 'chrome', 'content', 'scripts', p);

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM（与 translate-pane.test.js 同一套技法） ---------------- */

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
  return {
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    getElementById: () => null,
  };
}

/** 让出微任务若干轮，直到条件成立（面板抓取/入库都是异步的） */
async function drain(cond, maxRounds = 60) {
  for (let i = 0; i < maxRounds; i++) {
    if (cond()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return cond();
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map(); // 完整 pref key -> 值
const calls = { fetch: 0, fetchOpts: null, importOpts: null, imported: null, section: null, unregistered: null, prefSets: 0 };

function makeItem(id, key) {
  return {
    id, key,
    isRegularItem: () => true,
    isAttachment: () => false,
    related: [],
    addRelatedItem(other) { this.related.push(other.id); },
    async saveTx() { this.saved = (this.saved || 0) + 1; },
    getField(f) { return ({ title: '测试论文 ' + id, DOI: '', extra: '', archiveID: '', ISBN: '', firstCreator: '', url: '', archiveLocation: '' })[f] || ''; },
    getDisplayTitle() { return '测试论文 ' + id; },
  };
}

const Zotero = {
  Prefs: {
    get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined),
    set: (k, v) => { calls.prefSets++; PrefStore.set(k, v); },
  },
  ItemPaneManager: {
    registerSection(opts) { calls.section = opts; return 'papilot@dev.local-papilot-refs'; },
    unregisterSection(id) { calls.unregistered = id; },
  },
  Papilot: {},
  logError() {},
};

const RECS = [
  { source: ['pdf'], title: 'Attention is All you Need', authors: [{ family: 'Vaswani', given: 'Ashish' }],
    year: 2017, container: 'NeurIPS', doi: '10.1/aaa', itemType: 'conferencePaper' },
  { source: ['crossref-ref'], title: 'Deep residual learning for image recognition',
    authors: [{ family: 'He', given: 'Kaiming' }], year: 2016, container: 'CVPR', doi: '10.1/bbb', itemType: 'conferencePaper' },
  { source: ['cnki'], title: '抽动障碍的中医证候分布规律研究', authors: [{ family: '', given: '', literal: '张伟' }],
    year: 2020, container: '中医杂志', itemType: 'journalArticle' },
];
const clone = (r) => JSON.parse(JSON.stringify(r));

const sandbox = {
  console, Zotero,
  Services: {},
  setTimeout, clearTimeout, setImmediate, Promise, Date, Math, JSON,
  Prefs: { get: (k, d) => d, set() {} },
  I18n: { isZh: true, t: (k) => k },
  RefSources: {
    // 五源联合补全：原样返回（网络层不在本测试范围，ref-import.test.js 已覆盖）
    async enrichRecords(recs) { return recs.map((r) => Object.assign({}, r)); },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['features/ref-format.js', 'features/ref-import.js', 'panels/ref-pane.js']) {
  vm.runInContext(fs.readFileSync(S(f), 'utf8'), sandbox, { filename: f });
}
const RF = sandbox.RefFormat;
const RI = sandbox.RefImport;
const RP = sandbox.RefPane;

// 网络/库层全部桩掉（ref-import.test.js 已覆盖真实实现，这里只对面板接线负责）
RI.fetchReferenceLists = async (items, opts) => {
  calls.fetch++;
  calls.fetchOpts = opts || {};
  return { records: RECS.map(clone), channels: { pdf: 2, crossref: 1, cnki: 1 }, diagnosis: '', errors: [] };
};
RI.markDuplicates = async (recs) => {
  for (const r of recs || []) { if (!r.dup) r.dup = { dup: false, by: '', item: null }; }
  return recs;
};
let libIdx = { items: [], titles: new Map(), dois: new Set(), pmids: new Set(), arxiv: new Set(), isbns: new Set() };
RI.libraryIndex = async () => libIdx;
RI.importRecords = async (recs, opts) => {
  calls.importOpts = opts || {};
  calls.imported = (calls.imported || 0) + recs.length;
  return { ok: recs.length, fail: 0, items: recs.map((r, i) => makeItem(500 + i, 'NEW' + i)), errors: [], collection: null, mode: 'direct' };
};

/* ================= ① section 注册参数 + ftl 条目 ================= */

ok(!!Zotero.Papilot.RefPane, '① 加载后挂上 Papilot.RefPane（主线注册入口）');

RP.register('papilot@dev.local');
const sec = calls.section;
ok(!!sec, '① registerSection 被调用');
eq(sec.paneID, 'papilot-refs', '① paneID 正确');
eq(sec.header.l10nID, 'papilot-refs-section-header', '① header l10nID 正确');
eq(sec.sidenav.l10nID, 'papilot-refs-section-sidenav', '① sidenav l10nID 正确');
has(sec.header.icon, 'refs.svg', '① 使用参考文献图标');
eq(typeof sec.onRender, 'function', '① onRender 必须存在（Z10 schema 缺了会静默返回 false）');
eq(typeof sec.onItemChange, 'function', '① onItemChange 存在');
eq(typeof sec.onDestroy, 'function', '① onDestroy 存在');

const ftlZh = fs.readFileSync(path.join(ROOT, 'locale', 'zh-CN', 'papilot.ftl'), 'utf8');
const ftlEn = fs.readFileSync(path.join(ROOT, 'locale', 'en-US', 'papilot.ftl'), 'utf8');
has(ftlZh, 'papilot-refs-section-header', '① zh-CN ftl 有 header 条目（缺了注册静默失败）');
has(ftlZh, 'papilot-refs-section-sidenav', '① zh-CN ftl 有 sidenav 条目');
has(ftlEn, 'papilot-refs-section-header', '① en-US ftl 有 header 条目');
has(ftlEn, 'papilot-refs-section-sidenav', '① en-US ftl 有 sidenav 条目');

/* ================= ② 面板结构 ================= */

const doc = makeDoc();
const body = new El('div');
body.querySelector = () => null;
sec.onRender({ paneID: 'p1', doc, body });
const root = body.firstChild;
ok(!!root, '② onRender 构建了根节点');
eq(root.getAttribute('data-pp-ref-root'), '1', '② 根节点带标记（防重复渲染）');
eq(root.byClass('pp-ref-dot').length, 5, '② 数据源圆点 ×5（PDF解析/Crossref/S2/arXiv/CNKI）');
ok(!!root.byClass('pp-ref-refresh')[0], '② 有刷新按钮');
ok(!!root.byClass('pp-ref-list')[0], '② 有列表容器');
ok(!!root.byClass('pp-ref-status')[0], '② 有状态行');
const dotIds = root.all().filter((n) => n.getAttribute('data-pp-dot')).map((n) => n.getAttribute('data-pp-dot'));
eq(dotIds.join(','), 'pdf,crossref,s2,arxiv,cnki', '② 圆点顺序与指定数据源一致');

/* ================= ③ 区段定位与解析（真实 RefFormat，喂样例全文） ================= */

const sampleText = [
  '1. Introduction',
  'Transformers have dominated sequence modeling.',
  '',
  'References',
  '[1] Vaswani, A. et al. Attention is all you need. Adv. Neural Inf. Process. Syst. 30, 5998-6008 (2017).',
  '[2] He, K. et al. Deep residual learning for image recognition. Proc. CVPR 770-778 (2016).',
  '[3] 张伟, 李娜. 抽动障碍的中医证候分布规律研究[J]. 中医杂志, 2020, 61(3): 12-16.',
  '',
  'Appendix',
  'Supplementary proofs.',
].join('\n');
const secBib = RF.splitBibliography(sampleText);
ok(!!secBib, '③ 定位到参考文献区段');
eq(secBib.heading, 'References', '③ 取到最后一个 References 标题');
const entries = RF.splitBibliographyEntries(secBib.text);
eq(entries.length, 3, '③ 按编号切出 3 条题录');
const parsed = RF.recordsFromBibliographyEntries(entries, { source: 'pdf', reason: 'PDF 参考文献段' });
eq(parsed.length, 3, '③ 题录解析出 3 条记录');
has(parsed[0].title, 'Attention is all you need', '③ 英文题录抠出标题', parsed[0].title);
has(parsed[2].title, '抽动障碍的中医证候分布规律研究', '③ GB/T 中文题录抠出标题', parsed[2].title);
eq(parsed[2].container, '中医杂志', '③ GB/T 解析出刊名');
eq(parsed[2].source[0], 'pdf', '③ 来源标记为 pdf（GB/T 只是格式）');

/* ================= ④ 列表渲染 + 缓存写入 ================= */

const item1 = makeItem(1, 'KEY1');
const item2 = makeItem(2, 'KEY2');
let enabled = null;

async function main() {
  sec.onItemChange({ paneID: 'p1', item: item1, setEnabled: (e) => { enabled = e; } });
  eq(enabled, true, '④ 常规条目 → section 启用');
  await drain(() => root.byClass('pp-ref-row').length === 3);
  const rows = root.byClass('pp-ref-row');
  eq(rows.length, 3, '④ 渲染出 3 行参考文献');
  eq(rows[0].byClass('pp-ref-num')[0].textContent, '1', '④ 行首是序号');
  has(rows[0].byClass('pp-ref-title')[0].textContent, 'Attention is All you Need', '④ 题录行显示标题');
  eq(rows[1].byClass('pp-ref-badge')[0].textContent, 'CR', '④ 来源徽标（crossref-ref -> CR）');
  eq(rows[2].byClass('pp-ref-badge')[0].textContent, 'CNKI', '④ 来源徽标（cnki）');
  eq(rows[0].byClass('pp-ref-add')[0].textContent, '+', '④ 未入库条目操作钮是 +');
  has(rows[0].byClass('pp-ref-meta')[0].textContent, 'Vaswani', '④ 元信息行含作者');
  eq(calls.fetch, 1, '④ 首次换篇自动抓取一次');

  // 圆点点亮：pdf/crossref/cnki 有命中 -> 绿；s2 无命中 -> 灰
  const dotEls = {};
  for (const n of root.all()) { const id = n.getAttribute('data-pp-dot'); if (id) dotEls[id] = n.byClass('pp-ref-dot')[0]; }
  has(dotEls.pdf.style.background, 'accent', '④ PDF 圆点点亮');
  has(dotEls.crossref.style.background, 'accent', '④ Crossref 圆点点亮');
  has(dotEls.s2.style.background, '#88888855', '④ S2 无命中不点亮');
  has(dotEls.cnki.style.background, 'accent', '④ CNKI 圆点点亮');

  // 缓存写入：pref 里有该条目的记录（0.54.1：键改回规范命名空间，
  // 旧键 extensions.papilot.refPaneCache 会被 Zotero 再补一次前缀 → 实际落到
  // extensions.zotero.extensions.papilot.refPaneCache 孤儿键）
  RP.flushCache();   // 0.54.1：缓存改为防抖落盘，断言前显式 flush
  const cacheRaw = PrefStore.get('extensions.zotero.papilot.refPaneCache');
  ok(!!cacheRaw, '④ 缓存写入 pref extensions.zotero.papilot.refPaneCache');
  ok(!PrefStore.has('extensions.papilot.refPaneCache'), '④ 不再写旧的非规范键');
  const cacheObj = JSON.parse(cacheRaw);
  ok(!!cacheObj.KEY1 && cacheObj.KEY1.records.length === 3, '④ 按条目 key 缓存了 3 条记录');
  ok(cacheObj.KEY1.records[0].abstract === undefined, '④ 缓存是精简记录（不含 abstract 等重字段）');

  /* ================= ⑤ 换篇再换回：缓存命中，不重复抓 ================= */

  sec.onItemChange({ paneID: 'p1', item: item2, setEnabled: () => {} });
  // fetch 计数在调用**开始**时 +1，必须等 busy 落回 false 才算抓完（否则下一步会被 busy 挡掉）
  await drain(() => calls.fetch === 2 && !RP._state('p1').busy);
  eq(calls.fetch, 2, '⑤ 新条目缓存未命中 -> 抓取');
  sec.onItemChange({ paneID: 'p1', item: item1, setEnabled: () => {} });
  await drain(() => /缓存/.test(root.byClass('pp-ref-status')[0].textContent));
  eq(calls.fetch, 2, '⑤ 换回旧条目走缓存，不再抓取');
  has(root.byClass('pp-ref-status')[0].textContent, '缓存', '⑤ 状态行标注缓存来源');
  eq(root.byClass('pp-ref-row').length, 3, '⑤ 缓存渲染出同样 3 行');

  /* ================= ⑥ 缓存 LRU：超限淘汰最旧 ================= */

  const savedMax = RP.CACHE_MAX;
  RP.CACHE_MAX = 3;
  // 同时清内存副本（0.54.1 起读走内存，只删 pref 不会影响本轮断言）
  RP._cacheMem = null;
  RP._cacheDirty = false;
  PrefStore.delete('extensions.zotero.papilot.refPaneCache'); // 清掉 KEY1/KEY2，LRU 段只看 lr* 键
  RP._cacheSet('lr1', { records: [], t: 10 });
  RP._cacheSet('lr2', { records: [], t: 20 });
  RP._cacheSet('lr3', { records: [], t: 30 });
  RP._cacheSet('lr4', { records: [], t: 40 });
  RP._cacheSet('lr5', { records: [], t: 50 });
  let keys = Object.keys(RP._cacheReadAll()).filter((k) => /^lr/.test(k));
  eq(keys.sort().join(','), 'lr3,lr4,lr5', '⑥ LRU 超上限淘汰最旧的条目', keys);
  RP._cacheGet('lr3'); // 访问 lr3 -> 它变最新
  const setsBefore = calls.prefSets;
  RP._cacheGet('lr3');
  eq(calls.prefSets, setsBefore, '⑥b 读缓存不产生 pref 写入（0.54.1 读放大修复）');
  RP._cacheSet('lr6', { records: [], t: 60 });
  keys = Object.keys(RP._cacheReadAll()).filter((k) => /^lr/.test(k));
  eq(keys.sort().join(','), 'lr3,lr5,lr6', '⑥ 访问过的条目免于淘汰（LRU 而非 FIFO）', keys);
  RP.CACHE_MAX = savedMax;
  RP._cacheMem = null;
  RP._cacheDirty = false;
  PrefStore.delete('extensions.zotero.papilot.refPaneCache'); // 清掉 LRU 垃圾，恢复面板缓存
  RP._cacheSet('KEY1', { records: RECS.map((r) => RP._slim(clone(r))), channels: { pdf: 2 } });
  RP.flushCache();

  /* ================= ⑦ 刷新按钮：单击缓存 / 长按强刷 ================= */

  const refreshBtn = root.byClass('pp-ref-refresh')[0];
  refreshBtn.fire('mousedown');
  refreshBtn.fire('mouseup'); // 立即抬起 -> 单击
  await drain(() => /缓存/.test(root.byClass('pp-ref-status')[0].textContent));
  eq(calls.fetch, 2, '⑦ 单击刷新 = 按缓存渲染，不抓取');

  refreshBtn.fire('mousedown');
  RP._state('p1').pressT = Date.now() - 600; // 模拟按住 600ms
  refreshBtn.fire('mouseup');
  await drain(() => calls.fetch === 3 && !RP._state('p1').busy);
  eq(calls.fetch, 3, '⑦ 长按 ≥500ms = 跳过缓存重新抓取');
  eq(calls.fetchOpts.channels, undefined, '⑦ 强刷走全部通道');

  /* ================= ⑧ 圆点点击 = 指定源重新检索 ================= */

  const pdfDot = root.all().find((n) => n.getAttribute('data-pp-dot') === 'pdf');
  pdfDot.click();
  await drain(() => calls.fetch === 4 && !RP._state('p1').busy);
  eq(JSON.stringify(calls.fetchOpts.channels), '["pdf"]', '⑧ 点击 PDF 圆点只走 pdf 通道');
  eq(root.byClass('pp-ref-row').length, 3, '⑧ 指定源结果与现有列表合并去重后仍 3 行');

  /* ================= ⑨ `+` 未入库分支：importRecords 带 contextItem ================= */

  calls.importOpts = null;
  const btn1 = root.byClass('pp-ref-row')[0].byClass('pp-ref-add')[0];
  btn1.click();
  await drain(() => btn1.textContent === '已入库·关联');
  ok(!!calls.importOpts, '⑨ 走了 importRecords');
  eq(calls.importOpts.contextItem, item1, '⑨ importRecords 带 contextItem（当前条目）');
  eq(calls.importOpts.contextItem.id, 1, '⑨ contextItem 是当前条目');
  eq(btn1.textContent, '已入库·关联', '⑨ 入库成功后按钮变「已入库·关联」');
  eq(btn1.disabled, true, '⑨ 已入库按钮置灰（防重复点）');
  eq(RI._lib, null, '⑨ 入库后库索引失效（下一次判重能见到新条目）');

  /* ================= ⑩ 判重命中分支：只建双向 related ================= */

  const existItem = makeItem(9, 'EXIST');
  const recsNow = RP._state('p1').records;
  recsNow[1].dup = { dup: true, by: 'title', item: existItem };
  RP._renderList('p1'); // 重渲染让按钮文案反映判重状态
  const btn2 = root.byClass('pp-ref-row')[1].byClass('pp-ref-add')[0];
  eq(btn2.textContent, '已入库·关联', '⑩ 判重命中的行按钮是「已入库·关联」');
  const importedBefore = calls.imported || 0;
  btn2.click();
  await drain(() => existItem.related.length > 0 && item1.related.length > 0);
  eq(calls.imported, importedBefore, '⑩ 判重命中不调 importRecords（不造重复条目）');
  eq(existItem.related[0], 1, '⑩ 库中条目 -> 当前条目 建立 related');
  eq(item1.related[0], 9, '⑩ 当前条目 -> 库中条目 建立 related（双向）');
  ok(existItem.saved >= 1 && item1.saved >= 1, '⑩ 双向关联各自 saveTx 落盘');
  eq(btn2.textContent, '已入库·关联', '⑩ 关联成功后按钮保持「已入库·关联」');
  eq(btn2.disabled, true, '⑩ 关联成功后按钮置灰');

  /* ================= ⑪ RefImport._linkContext：分类 + 双向 related ================= */

  const ctx = makeItem(7, 'CTX');
  ctx.getCollections = () => [101, 102];
  const newIt = makeItem(8, 'NEW');
  newIt.cols = [];
  newIt.addToCollection = function (cid) { this.cols.push(cid); };
  await RI._linkContext([newIt], ctx);
  eq(newIt.cols.join(','), '101,102', '⑪ 新条目进当前条目全部分类');
  eq(newIt.related[0], 7, '⑪ 新条目 -> 当前条目 related');
  eq(ctx.related[0], 8, '⑪ 当前条目 -> 新条目 related（双向）');
  ok(newIt.saved >= 1 && ctx.saved >= 1, '⑪ 关联各自 saveTx');
  eq(RI.importRecords.length, 2, '⑪ importRecords 保持 (records, opts) 签名（contextItem 走 opts，老调用兼容）');

  /* ================= ⑫ 不可用条目 + 注销 ================= */

  sec.onItemChange({ paneID: 'p1', item: null, setEnabled: (e) => { enabled = e; } });
  eq(enabled, false, '⑫ 无条目 -> section 禁用');
  RP.unregister();
  eq(calls.unregistered, 'papilot@dev.local-papilot-refs',
    '⑫ 注销用 registerSection 的返回值（不是注册时的 paneID）');

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    console.log('-'.repeat(60));
  }
  console.log('参考文献面板测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.log('测试异常：' + (e && e.stack || e)); process.exit(1); });
