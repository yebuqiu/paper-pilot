#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 相关文献推荐（S2 recommendations + 一键入库）测试（0.51.0）
 *
 * 无人环境点不了 ItemPane section，也连不上 Semantic Scholar；这里用
 * 「迷你 DOM + vm 沙箱 + HTTP 桩」把三条链路**真跑一遍**：
 *   ① S2Client.recommendations：URL/字段/limit 拼装、响应归一、缓存、429/断网降级；
 *   ② RelatedPapers.fetchFor：DOI（字段 + extra 两种来源）→ 5 条映射；无 DOI / 无条目 /
 *      HTTP 失败各自的 reason 与文案；
 *   ③ _buildItem：字段映射、`"A, B and C"` 作者拆分、DOI/url 构造、缺年份；
 *   ④ importPaper：成功入库（字段/标签/saveTx）、DOI 已存在去重、saveTx 抛错；
 *   ⑤ register/unregister：pane 路径的句柄语义（注销用返回值）、幂等、pane 不可用不抛。
 *
 * 运行：node test/related-papers.test.js
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

/* ---------------- 迷你 DOM（与 ref-pane.test.js 同一套技法） ---------------- */

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

async function drain(cond, maxRounds = 80) {
  for (let i = 0; i < maxRounds; i++) {
    if (cond()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return cond();
}

/* ---------------- 桩：Zotero / 条目 ---------------- */

const calls = {
  http: [], httpMode: 'ok', section: null, registered: 0, unregistered: null,
  saved: 0, built: 0, byDoi: null, s2: 0,
};

let seq = 0;
class FakeItem {
  constructor(type) {
    this.itemType = type;
    this.id = null;
    this.fields = {};
    this.creators = [];
    this.tags = [];
    this.saved = 0;
    this.libraryID = null;
    calls.built++;
  }
  setField(f, v) { this.fields[f] = String(v); }
  getField(f) { return this.fields[f] || ''; }
  setCreators(c) { this.creators = c; }
  addTag(t) { this.tags.push(t); }
  getTags() { return this.tags.map((t) => ({ tag: t })); }
  async saveTx() {
    if (FakeItem.failNext) { FakeItem.failNext = false; throw new Error('database is locked'); }
    this.saved++;
    calls.saved++;
    if (!this.id) this.id = ++seq;
  }
}
FakeItem.failNext = false;

function makeItem(fields) {
  const f = fields || {};
  return {
    id: ++seq,
    key: 'KEY' + seq,
    isRegularItem: () => true,
    isAttachment: () => false,
    getField(name) { return f[name] || ''; },
    getDisplayTitle() { return f.title || ''; },
  };
}

const RAW = (i) => ({
  paperId: 'a'.repeat(38) + String(i).padStart(2, '0'),
  title: 'Related Paper ' + i,
  year: 2010 + i,
  venue: i % 2 ? 'NeurIPS' : 'Nature',
  authors: [{ authorId: '1', name: 'Ashish Vaswani' }, { authorId: '2', name: 'Niki Parmar' }],
  citationCount: 100 + i,
  externalIds: { DOI: '10.1000/rel.' + i, ArXiv: null },
  abstract: 'Abstract of related paper ' + i + '.',
});

const Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: { get: (k) => undefined, set() {} },
  Item: FakeItem,
  Items: {
    getByDOI: async (doi) => (calls.byDoi && calls.byDoi.doi === doi ? calls.byDoi.item : null),
    getAsync: async (id) => null,
  },
  Search: function Search() {
    this.conditions = [];
    this.addCondition = (f, op, v) => { this.conditions.push([f, op, v]); };
    this.search = async () => (calls.searchIds || []);
  },
  ItemPaneManager: {
    registerSection(opts) { calls.registered++; calls.section = opts; return 'papilot@dev.local-related-' + calls.registered; },
    unregisterSection(id) { calls.unregistered = id; },
  },
  HTTP: {
    request: async (method, url, opts) => {
      calls.http.push({ method, url, opts });
      if (calls.httpMode === '429') { const e = new Error('HTTP 429'); e.status = 429; throw e; }
      if (calls.httpMode === 'offline') throw new Error('NS_ERROR_UNKNOWN_HOST');
      return { response: { recommendedPapers: [1, 2, 3, 4, 5, 6].map(RAW) } };
    },
  },
  launchURL(url) { calls.launched = url; },
  logError() {},
  Papilot: {},
};

/* ---------------- 沙箱：真实 semantic-scholar.js + s2-client.js + related-papers.js ---------------- */

const sandbox = {
  console, Zotero,
  Services: { appShell: { hiddenDOMWindow: { open() {} } } },
  // 长定时器（_req 的 25s 应用层超时）不真挂，避免 node 进程被拖住
  setTimeout: (fn, ms) => (ms > 2000 ? { fake: true } : setTimeout(fn, ms)),
  clearTimeout, setImmediate, Promise, Date, Math, JSON, Map, Set,
  encodeURIComponent, decodeURIComponent, parseInt, isFinite, String, Array, Object,
  Prefs: { get: (k, d) => (k === 's2ApiKey' ? 'test-key' : d), set() {} },
  I18n: { isZh: true, t: (k) => k },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['ai/semantic-scholar.js', 'features/s2-client.js', 'features/related-papers.js']) {
  vm.runInContext(fs.readFileSync(S(f), 'utf8'), sandbox, { filename: f });
}
const S2 = sandbox.S2Client;
const RP = sandbox.RelatedPapers;

// 测试主体（顶层 await 在 CommonJS 里不可用，统一收进 async main）
async function main() {

/* ================= ① S2Client.recommendations ================= */

ok(!!S2 && typeof S2.paperById === 'function', '① 扩展后原有 paperById 仍在（未被整体覆盖）');
eq(typeof S2.recommendations, 'function', '① recommendations 已挂到 S2Client');

S2._recsReset();
calls.http = [];
const recs = await S2.recommendations('10.1000/main.1', 5);
ok(Array.isArray(recs), '① 成功返回数组');
eq(recs.length, 5, '① limit=5 只取前 5 条');
eq(recs[0].title, 'Related Paper 1', '① title 映射');
eq(recs[0].year, 2011, '① year 转为数字');
eq(recs[0].venue, 'NeurIPS', '① venue 映射');
eq(recs[0].authors, 'Ashish Vaswani, Niki Parmar', '① authors 数组 → 字符串');
eq(recs[0].citationCount, 101, '① citationCount 映射');
eq(recs[0].doi, '10.1000/rel.1', '① externalIds.DOI → doi');
eq(recs[0].paperId.length, 40, '① paperId 保留');
eq(calls.http.length, 1, '① 只发一次请求');
has(calls.http[0].url, 'recommendations/v1/papers/forpaper/DOI%3A10.1000%2Fmain.1', '① paperId 用 DOI: 前缀并编码');
has(calls.http[0].url, 'limit=5', '① limit 进 query');
has(calls.http[0].url, 'citationCount', '① fields 带 citationCount');
eq(calls.http[0].opts.headers['x-api-key'], 'test-key', '① 复用 _headers（s2ApiKey 注入）');

const recs2 = await S2.recommendations('10.1000/main.1', 5);
eq(calls.http.length, 1, '① 同一条目第二次命中内存缓存（不再发请求）');
eq(recs2.length, 5, '① 缓存返回同样条数');

S2._recsReset();
calls.httpMode = '429';
const limited = await S2.recommendations('10.1000/main.1', 5);
eq(limited.ok, false, '① 429 返回错误对象，不抛');
eq(limited.reason, 'rate_limit', '① 429 归为 rate_limit');
has(limited.error, '429', '① 429 错误文案可读');

S2._recsReset();
calls.httpMode = 'offline';
const offline = await S2.recommendations('10.1000/main.1', 5);
eq(offline.ok, false, '① 断网返回错误对象，不抛');
eq(offline.reason, 'network', '① 断网归为 network');
calls.httpMode = 'ok';

/* ================= ② fetchFor ================= */

const itemDoi = makeItem({ title: 'Seed Paper', DOI: '10.1000/seed.1' });
S2._recsReset();
calls.http = [];
const f1 = await RP.fetchFor(itemDoi);
eq(f1.ok, true, '② 有 DOI：成功');
eq(f1.items.length, 5, '② 默认 limit=5');
eq(f1.items[0].title, 'Related Paper 1', '② 字段映射：title');
eq(f1.items[0].year, 2011, '② 字段映射：year');
eq(f1.items[0].citationCount, 101, '② 字段映射：citationCount');
eq(f1.items[0].doi, '10.1000/rel.1', '② 字段映射：doi');
has(calls.http[0].url, 'DOI%3A10.1000%2Fseed.1', '② 用条目 DOI 组装 paperId');

const itemExtra = makeItem({ title: 'Seed 2', extra: 'PMID: 12345678\nDOI: 10.1000/extra.2\n' });
const f2 = await RP.fetchFor(itemExtra);
eq(f2.ok, true, '② DOI 只在 extra 里也能取到（正则 DOI: xxx）');

const noDoi = makeItem({ title: 'No DOI' });
const f3 = await RP.fetchFor(noDoi);
eq(f3.ok, false, '② 无 DOI：失败');
eq(f3.reason, 'no_doi', '② 无 DOI：reason=no_doi');
has(f3.message, '缺少 DOI', '② 无 DOI：文案明确');
eq(f3.items.length, 0, '② 无 DOI：items 为空');

const f4 = await RP.fetchFor(null);
eq(f4.ok, false, '② 条目缺失：失败不抛');
eq(f4.reason, 'no_item', '② 条目缺失：reason=no_item');

S2._recsReset();
calls.httpMode = '429';
const f5 = await RP.fetchFor(itemDoi);
eq(f5.ok, false, '② HTTP 429：降级');
eq(f5.reason, 'rate_limit', '② HTTP 429：reason 透传');
has(f5.message, '429', '② HTTP 429：保留可读文案');
calls.httpMode = 'ok';

const savedFn = S2.recommendations;
delete S2.recommendations;
const f6 = await RP.fetchFor(itemDoi);
eq(f6.ok, false, '② S2Client 无 recommendations：降级不抛');
eq(f6.reason, 'no_client', '② S2Client 缺失：reason=no_client');
S2.recommendations = savedFn;

/* ================= ③ _buildItem ================= */

const rec = {
  title: 'Attention Is All You Need',
  year: 2017,
  venue: 'NeurIPS',
  authors: 'Ashish Vaswani, Noam Shazeer and Niki Parmar',
  citationCount: 90000,
  doi: 'https://doi.org/10.5555/attention.1',
  paperId: 'b'.repeat(40),
  abstract: 'The dominant sequence transduction models...',
};
const built = RP._buildItem(rec);
eq(built.itemType, 'journalArticle', '③ 条目类型 journalArticle');
eq(built.getField('title'), 'Attention Is All You Need', '③ title');
eq(built.getField('date'), '2017', '③ year → date');
eq(built.getField('publicationTitle'), 'NeurIPS', '③ venue → publicationTitle');
eq(built.getField('DOI'), '10.5555/attention.1', '③ DOI 去掉 https://doi.org/ 前缀');
eq(built.getField('abstractNote'), 'The dominant sequence transduction models...', '③ abstract → abstractNote');
eq(built.getField('url'), 'https://doi.org/10.5555/attention.1', '③ 有 DOI 时 url 走 doi.org');
eq(built.creators.length, 3, '③ "A, B and C" → 3 位作者');
eq(built.creators[0].firstName, 'Ashish', '③ 第一作者 given');
eq(built.creators[0].lastName, 'Vaswani', '③ 第一作者 family');
eq(built.creators[2].lastName, 'Parmar', '③ 第三作者 family');
eq(built.creators[0].creatorType, 'author', '③ creatorType=author');
eq(built.tags[0], '#来源/S2推荐', '③ 构造时打标签');
eq(built.libraryID, 1, '③ libraryID 指向用户库');

const noYear = RP._buildItem({ title: 'No Year', doi: '', paperId: 'c'.repeat(40), authors: [] });
eq(noYear.getField('date'), '', '③ 缺失年份不写 date');
eq(noYear.getField('url'), 'https://www.semanticscholar.org/paper/' + 'c'.repeat(40), '③ 无 DOI 时 url 回落到 S2 论文页');
eq(noYear.creators.length, 0, '③ 无作者时 creators 为空');

const yearInString = RP._buildItem({ title: 'Year Str', year: '2019', authors: 'Solo' });
eq(yearInString.getField('date'), '2019', '③ 年份字符串也能解析');
eq(yearInString.creators[0].lastName, 'Solo', '③ 单姓名作者落到 lastName');

/* ================= ④ importPaper ================= */

calls.byDoi = null;
const r1 = await RP.importPaper(rec);
eq(r1.ok, true, '④ 入库成功');
ok(!!r1.itemID, '④ 返回 itemID');
const savedItem = r1.item;
eq(savedItem.saved, 1, '④ 只 saveTx 一次（标签随首次保存落盘）');
eq(savedItem.getField('DOI'), '10.5555/attention.1', '④ 入库 DOI 正确');
eq(savedItem.tags.indexOf('#来源/S2推荐') >= 0, true, '④ 入库后带 #来源/S2推荐 标签');

const before = calls.built;
calls.byDoi = { doi: '10.5555/attention.1', item: { id: 777, deleted: false } };
const r2 = await RP.importPaper(rec);
eq(r2.ok, false, '④ DOI 已存在：跳过');
eq(r2.reason, 'dup', '④ 重复入库 reason=dup');
eq(r2.itemID, 777, '④ 返回已有条目 id');
eq(calls.built, before, '④ 重复时不构造新条目');

calls.byDoi = null;
FakeItem.failNext = true;
const r3 = await RP.importPaper({ title: 'Boom', doi: '10.1/boom', authors: 'X' });
eq(r3.ok, false, '④ saveTx 抛错：ok=false');
eq(r3.reason, 'save_failed', '④ saveTx 抛错：reason=save_failed');
has(r3.message, 'locked', '④ saveTx 抛错：保留原始错误信息');
FakeItem.failNext = false;

const r4 = await RP.importPaper(null);
eq(r4.ok, false, '④ 空推荐项：ok=false');
eq(r4.reason, 'invalid', '④ 空推荐项：reason=invalid');

/* ================= ⑤ register / unregister ================= */

const handle1 = RP.register('papilot@dev.local');
eq(handle1, 'papilot@dev.local-related-1', '⑤ register 返回注册句柄');
eq(calls.registered, 1, '⑤ registerSection 被调用一次');

const sec = calls.section;
eq(sec.paneID, 'papilot-related', '⑤ paneID 正确');
eq(sec.header.l10nID, 'papilot-related-section-header', '⑤ header l10nID 与 ftl 命名一致');
eq(sec.sidenav.l10nID, 'papilot-related-section-sidenav', '⑤ sidenav l10nID 与 ftl 命名一致');
eq(typeof sec.onRender, 'function', '⑤ onRender 必填（Z10 缺了会静默返回 false）');
eq(typeof sec.onItemChange, 'function', '⑤ onItemChange 存在');
eq(typeof sec.onDestroy, 'function', '⑤ onDestroy 存在');

const handleAgain = RP.register('papilot@dev.local');
eq(handleAgain, handle1, '⑤ 幂等：重复 register 返回同一句柄');
eq(calls.registered, 1, '⑤ 幂等：不重复调用 registerSection');

RP.unregister();
eq(calls.unregistered, handle1, '⑤ 注销用 registerSection 的返回值（不是 paneID）');
eq(RP._registered, false, '⑤ 注销后状态复位');

const handle2 = RP.register('papilot@dev.local');
eq(handle2, 'papilot@dev.local-related-2', '⑤ 注销后可重新注册');
RP.unregister();

const savedIPM = Zotero.ItemPaneManager;
Zotero.ItemPaneManager = undefined;
let threw = false;
let noPane = null;
try { noPane = RP.register('papilot@dev.local'); } catch (e) { threw = true; }
eq(threw, false, '⑤ pane 不可用：register 不抛');
eq(noPane, false, '⑤ pane 不可用：register 返回 false');
eq(typeof RP.openDialog, 'function', '⑤ pane 不可用时仍有 openDialog 降级入口');
Zotero.ItemPaneManager = savedIPM;

/* ================= ⑥ 面板渲染（pane 路径） ================= */

const handle3 = RP.register('papilot@dev.local');
ok(!!handle3, '⑥ 重新注册成功');

const doc = makeDoc();
const body = new El('div');
body.querySelector = () => null;
calls.section.onRender({ paneID: 'p1', doc, body });
const root = body.firstChild;
ok(!!root, '⑥ onRender 构建根节点');
eq(root.getAttribute('data-pp-related-root'), '1', '⑥ 根节点带防重复标记');
ok(!!root.byClass('pp-related-status')[0], '⑥ 有状态行');
ok(!!root.byClass('pp-related-list')[0], '⑥ 有列表容器');
ok(!!root.byClass('pp-related-s2')[0], '⑥ 有「在 S2 打开」链接');

let enabled = null;
S2._recsReset();
calls.httpMode = 'ok';
// 0.54.0：条目切换防抖在测试中关闭（同步执行）
RP.DEBOUNCE_MS = 0;
calls.section.onItemChange({ paneID: 'p1', item: itemDoi, setEnabled: (v) => { enabled = v; } });
eq(enabled, true, '⑥ 常规条目：section 启用');
const rendered = await drain(() => root.byClass('pp-related-import').length === 5);
ok(rendered, '⑥ 渲染出 5 条推荐');
eq(root.byClass('pp-related-current')[0].textContent, 'Seed Paper', '⑥ 标题行显示当前条目');
const rows = root.byClass('pp-related-title');
has(rows[0].textContent, 'Related Paper 1', '⑥ 行内标题');
has(rows[0].textContent, '（2011）', '⑥ 行内含年份');
has(rows[0].textContent, '被引 101', '⑥ 行内含被引量');
eq(root.byClass('pp-related-import').length, 5, '⑥ 每条右侧有入库按钮');
has(root.byClass('pp-related-status')[0].textContent, '推荐', '⑥ 状态行显示条数');

root.byClass('pp-related-import')[0].click();
const importedRow = await drain(() => root.byClass('pp-related-import')[0].textContent === '已入库', 80);
ok(importedRow, '⑥ 点「入库」后按钮变「已入库」');
eq(root.byClass('pp-related-import')[0].disabled, true, '⑥ 入库后按钮禁用');

const doc2 = makeDoc();
const body2 = new El('div');
body2.querySelector = () => null;
calls.section.onRender({ paneID: 'p2', doc: doc2, body: body2 });
calls.section.onItemChange({ paneID: 'p2', item: noDoi, setEnabled: () => {} });
const noDoiText = await drain(() => body2.firstChild.byClass('pp-related-status')[0].textContent.indexOf('缺少 DOI') >= 0);
ok(noDoiText, '⑥ 无 DOI：面板给出明确文案');
eq(body2.firstChild.byClass('pp-related-import').length, 0, '⑥ 无 DOI：不出推荐行');

calls.section.onItemChange({ paneID: 'p2', item: null, setEnabled: () => {} });
eq(body2.firstChild.byClass('pp-related-import').length, 0, '⑥ 无条目：列表为空');
has(body2.firstChild.byClass('pp-related-status')[0].textContent, '请选择', '⑥ 无条目：提示选择文献');

RP.unregister();
eq(calls.unregistered, handle3, '⑥ 最后一轮注销仍用返回值');

}

/* ---------------- 汇总 ---------------- */

main().then(() => {
  if (fails.length) {
    console.error('\nFAILED ' + fails.length + ' / ' + (pass + fails.length));
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('PASS ' + pass + ' assertions');
}).catch((e) => {
  console.error('TEST CRASHED: ' + (e && (e.stack || e.message) || e));
  process.exit(1);
});
