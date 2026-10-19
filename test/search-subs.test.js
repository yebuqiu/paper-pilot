#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 检索订阅模块测试（Saved query → 定时检索 → 自动入库 + 速递笔记）
 *
 * 为什么要有它：订阅的失败模式几乎全是「静默」的——指纹算错导致天天重复入库、
 * seen 记账没写导致笔记重复、到点判定写错导致不跑或一天跑多次、单条 saveTx 抛错
 * 把整次订阅带崩。这个套件在 vm 沙箱里真跑 search-subs.js（Zotero / Prefs /
 * ArxivFetch / 笔记全部桩化，零磁盘零网络），断言 CRUD、指纹、执行与调度语义。
 *
 * 运行：node test/search-subs.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'chrome', 'content', 'scripts', 'features', 'search-subs.js');
const PREFIX = 'extensions.zotero.papilot.';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay == null ? '' : hay).indexOf(needle) >= 0, label, { needle: needle });
}
function notHas(hay, needle, label) {
  return ok(String(hay == null ? '' : hay).indexOf(needle) < 0, label, { needle: needle });
}

/* ---------------- 固定时刻（本地时间，只用于 run 的日期与 checkDue） ---------------- */

const AT = new Date(2026, 9, 18, 8, 0, 0); // 2026-10-18 08:00 本地
const DAY = '2026-10-18';

/* ---------------- 测试桩 ---------------- */

/** arXiv Atom 解析后的条目形状（只放本模块用到的字段） */
function entry(i, over) {
  const id = '2501.' + String(i).padStart(5, '0');
  const day = '2025-01-0' + i;
  return Object.assign({
    arxivId: id,
    baseId: id,
    version: 1,
    versionTag: 'v1',
    idUrl: 'http://arxiv.org/abs/' + id + 'v1',
    title: 'Paper ' + i,
    summary: 'Abstract ' + i,
    authors: ['Ada Lovelace', 'Alan Turing'],
    published: day + 'T00:00:00Z',
    publishedDay: day,
    doi: '',
    absUrl: 'https://arxiv.org/abs/' + id,
    links: { abs: 'https://arxiv.org/abs/' + id, pdf: '', doi: '', other: [] },
    categories: ['cs.LG'],
    primaryCategory: 'cs.LG',
  }, over || {});
}

function makeArxiv(entries, behaviour) {
  const calls = [];
  return {
    calls: calls,
    search: function (spec, opts) {
      calls.push({ spec: spec, opts: opts });
      if (behaviour === 'throw') throw new Error('network down');
      const list = (typeof entries === 'function') ? entries(spec, opts) : entries;
      const arr = list || [];
      return Promise.resolve({
        entries: arr,
        totalResults: arr.length,
        fetched: arr.length,
        pages: 1,
        query: 'all:test',
        url: 'https://export.arxiv.org/api/query?search_query=',
        stopped: 'short-page',
      });
    },
  };
}

function sub(over) {
  return Object.assign({
    id: 'sub-1',
    name: '测试订阅',
    keywords: 'attention',
    categories: '',
    dailyTime: '',
    max: 10,
    autoImport: true,
    lastRun: '',
    createdAt: 1,
  }, over || {});
}

function makeEnv(opts) {
  opts = opts || {};
  const store = new Map(Object.entries(opts.prefs || {}));
  const items = [];
  const notes = [];
  const intervals = [];
  const errors = [];
  const pws = [];
  let seq = 100;
  let failNextSave = false;

  class FakeItem {
    constructor(type) {
      this.itemType = type;
      this.id = null;
      this.fields = {};
      this.creators = [];
      this.tags = [];
      this.libraryID = null;
      this.html = '';
    }
    setField(f, v) { this.fields[f] = String(v); }
    getField(f) { return this.fields[f] || ''; }
    setCreators(c) { this.creators = c; }
    addTag(t) { this.tags.push(t); }
    setNote(h) { this.html = String(h); }
    async saveTx() {
      if (this.itemType === 'note') { notes.push(this); return; }
      if (failNextSave) { failNextSave = false; throw new Error('database is locked'); }
      this.id = this.id == null ? (++seq) : this.id;
      items.push(this);
    }
  }

  /** 系统通知桩：只记录调用（弹窗本身不可测，但「弹没弹 / 弹了什么」必须可断言） */
  class FakeProgressWindow {
    constructor(opts) {
      this.opts = opts || {};
      this.headline = '';
      this.lines = [];
      this.shown = 0;
      this.closeMs = null;
      pws.push(this);
    }
    changeHeadline(t) { this.headline = String(t == null ? '' : t); }
    addDescription(t) { this.lines.push(String(t == null ? '' : t)); }
    show() { this.shown++; }
    startCloseTimer(ms) { this.closeMs = ms; }
  }

  const Zotero = {
    locale: 'zh-CN',
    Prefs: {
      get(k) { return store.has(k) ? store.get(k) : undefined; },
      set(k, v) { store.set(k, v); },
    },
    Libraries: { userLibraryID: 1 },
    Items: {
      getByDOI(doi) { return opts.byDoi ? opts.byDoi(doi) : null; },
      /** 收藏查重要求确认「记账里的条目还在」：返回已保存条目或 null */
      getAsync(id) {
        const hit = items.filter((x) => x.id === id)[0];
        return Promise.resolve(hit || null);
      },
    },
    Item: FakeItem,
    ProgressWindow: FakeProgressWindow,
    Papilot: {
      diags: [],
      _diag(msg) { Zotero.Papilot.diags.push(String(msg)); return Promise.resolve(); },
    },
    logError(e) { errors.push(e); },
    debug() {},
  };

  const Prefs = {
    get(k, fallback) {
      const full = PREFIX + k;
      return store.has(full) ? store.get(full) : fallback;
    },
    set(k, v) { store.set(PREFIX + k, v); },
  };

  const win = {
    setInterval(fn, ms) {
      const rec = { id: ++seq, fn: fn, ms: ms, cleared: false };
      intervals.push(rec);
      return rec.id;
    },
    clearInterval(id) {
      const rec = intervals.filter((x) => x.id === id)[0];
      if (rec) rec.cleared = true;
    },
    setTimeout() { return seq++; },
  };

  const sandbox = {
    Zotero: Zotero,
    Prefs: Prefs,
    window: win,
    console: console,
    // Date 必须用外层实例，否则 _dateOf 的 instanceof 会跨 realm 失败
    Date: Date,
    Math: Math,
    JSON: JSON,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Map: Map,
    Set: Set,
    Promise: Promise,
    Error: Error,
    RegExp: RegExp,
    isNaN: isNaN,
    isFinite: isFinite,
    parseInt: parseInt,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    setTimeout: win.setTimeout,
  };
  if (opts.arxiv) sandbox.ArxivFetch = opts.arxiv;
  if (opts.MdLite) sandbox.MdLite = opts.MdLite;
  if (opts.ai) sandbox.AIClient = opts.ai;
  if (opts.discovery) sandbox.Discovery = opts.discovery;
  if (opts.subSources) sandbox.SubSources = opts.subSources;
  if (opts.arxivCategories) sandbox.ArxivCategories = opts.arxivCategories;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'search-subs.js' });

  return {
    S: sandbox.SearchSubs,
    store: store,
    items: items,
    notes: notes,
    intervals: intervals,
    errors: errors,
    pws: pws,
    diags: Zotero.Papilot.diags,
    arxiv: opts.arxiv || null,
    failNext: () => { failNextSave = true; },
    prefs: (k) => store.get(PREFIX + k),
    seen: () => {
      const raw = store.get(PREFIX + 'searchSubsSeen');
      if (!raw) return {};
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
    subs: () => {
      const raw = store.get(PREFIX + 'searchSubscriptions');
      if (!raw) return [];
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
    feedback: () => {
      const raw = store.get(PREFIX + 'searchSubsFeedback');
      if (!raw) return {};
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
  };
}

async function main() {

  /* ================== ① CRUD ================== */

  {
    const env = makeEnv();
    const S = env.S;

    const a = S.add({ name: '订阅A', keywords: 'attention', dailyTime: '8:05', max: 100 });
    ok(!!a, '① add 合法输入返回订阅对象');
    ok(/^sub-[0-9a-z]+$/.test(a.id), '① id 形如 sub-<ts36>', a.id);
    eq(a.max, 30, '① max 超过 30 → 夹紧到 30');
    eq(a.dailyTime, '08:05', '① dailyTime "8:05" 归一为 "08:05"');
    eq(a.autoImport, true, '① autoImport 缺省为 true');
    eq(a.lastRun, '', '① 新订阅 lastRun 为空');
    eq(typeof a.createdAt, 'number', '① createdAt 是时间戳');
    eq(S.list().length, 1, '① list 含新订阅');

    const b = S.add({ name: '订阅B', categories: 'cs.LG, cs.CL', max: 0 });
    ok(!!b, '① 只用分类也能 add');
    eq(b.max, 1, '① max 0 → 夹紧到 1');
    eq(S.list()[0].id, b.id, '① list 最新在前');
    eq(S.list()[1].id, a.id, '① 先添加的排后');

    eq(S.add({ name: '', keywords: 'x' }), null, '① name 空 → 拒绝');
    eq(S.add({ name: '   ', keywords: 'x' }), null, '① name 纯空白 → 拒绝');
    eq(S.add({ name: 'C', keywords: '', categories: '  ' }), null, '① 关键词与分类全空 → 拒绝');
    eq(S.list().length, 2, '① 被拒绝的 add 不写 pref');

    eq(S.add({ name: 'D', keywords: 'x', max: 'abc' }).max, 10, '① max 非数字 → 默认 10');
    eq(S.add({ name: 'E', keywords: 'x', dailyTime: '25:00' }).dailyTime, '', '① 非法 dailyTime → 仅手动');
    eq(S.add({ name: 'F', keywords: 'x', dailyTime: '0730' }).dailyTime, '07:30', '① dailyTime "0730" → "07:30"');

    const u = S.update(a.id, { name: '订阅A2', max: 99, dailyTime: '7:00' });
    ok(!!u, '① update 命中 id 返回新对象');
    eq(u.name, '订阅A2', '① update 改 name');
    eq(u.max, 30, '① update 的 max 也夹紧');
    eq(u.dailyTime, '07:00', '① update 的 dailyTime 归一');
    eq(u.id, a.id, '① update 保持 id 不变');
    eq(S.update(a.id, { name: '' }), null, '① update name 空 → 拒绝');
    eq(S.update(a.id, { keywords: '', categories: '' }), null, '① update 条件清空 → 拒绝');
    eq(S.update('sub-nope', { name: 'X' }), null, '① update 未知 id → null');
    eq(S.update(a.id, { lastRun: DAY }).lastRun, DAY, '① update 可写 lastRun');
    eq(S.list().filter((x) => x.id === a.id)[0].name, '订阅A2', '① update 已落 pref');

    eq(S.remove(b.id), true, '① remove 已存在 → true');
    eq(S.list().length, 4, '① remove 后列表减一');
    eq(S.remove(b.id), false, '① remove 未知 id → false');
  }

  /* 坏 JSON / 非数组：容错为空列表，且仍能继续写入 */
  {
    const env1 = makeEnv({ prefs: { [PREFIX + 'searchSubscriptions']: '{oops' } });
    eq(env1.S.list().length, 0, '① 订阅 pref 坏 JSON → 空列表（不抛）');
    ok(!!env1.S.add({ name: 'X', keywords: 'y' }), '① 坏 JSON 后仍可 add');
    eq(env1.S.list().length, 1, '① 坏 JSON 被新数据覆盖');

    const env2 = makeEnv({ prefs: { [PREFIX + 'searchSubscriptions']: '{"a":1}' } });
    eq(env2.S.list().length, 0, '① 订阅 pref 非数组 → 空列表');

    const env3 = makeEnv({ prefs: { [PREFIX + 'searchSubsSeen']: '[1,2,3]' } });
    eq(JSON.stringify(env3.S._seenLoad()), '{}', '① seen pref 非对象 → 空 map');

    const env4 = makeEnv({ prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([{ id: '', name: '无 id' }, null, 'x']) } });
    eq(env4.S.list().length, 0, '① 订阅数组里的坏元素被过滤');
  }

  /* ================== ② _fingerprint ================== */

  {
    const S = makeEnv().S;

    eq(S._fingerprint({ doi: '10.1000/ABC' }), 'doi:10.1000/abc', '② DOI 小写化');
    eq(S._fingerprint({ doi: 'https://doi.org/10.1000/XyZ' }), 'doi:10.1000/xyz', '② DOI 去 doi.org 前缀');
    eq(S._fingerprint({ doi: 'DOI: 10.1/A' }), 'doi:10.1/a', '② DOI 去 "DOI:" 前缀与空白');
    eq(S._fingerprint({ DOI: '10.2/B' }), 'doi:10.2/b', '② 大写 DOI 字段也识别');
    eq(S._fingerprint({ links: { doi: '10.3/C' } }), 'doi:10.3/c', '② links.doi 也识别');

    eq(S._fingerprint({ arxivId: '2501.00001' }), 'arXiv:2501.00001', '② arXiv id 指纹');
    eq(S._fingerprint({ arxivId: '2501.00001v3' }), 'arXiv:2501.00001', '② arXiv id 去版本号');
    eq(S._fingerprint({ idUrl: 'http://arxiv.org/abs/hep-th/9901001v2' }), 'arXiv:hep-th/9901001', '② 老式 arXiv id 也能取');
    eq(S._fingerprint({ absUrl: 'https://arxiv.org/abs/2405.12345v1' }), 'arXiv:2405.12345', '② 从 absUrl 取 id');
    eq(S._fingerprint({ doi: '10.9/Z', arxivId: '2501.00009' }), 'doi:10.9/z', '② DOI 优先于 arXiv id');

    const t1 = S._fingerprint({ title: '  Attention Is All You Need! ' });
    const t2 = S._fingerprint({ title: 'attention   is all you need' });
    eq(t1, t2, '② 标题归一：空白/大小写/标点不影响');
    eq(S._fingerprint({ title: 'A: B, C' }), 'title:abc', '② 标题去掉标点与空格');

    eq(S._fingerprint({}), '', '② 空记录 → 空指纹');
    eq(S._fingerprint(null), '', '② null 记录 → 空指纹');
    eq(S._fingerprint({ title: '   ' }), '', '② 纯空白标题 → 空指纹');
  }

  /* ================== ③ run：去重 + 入库 + 速递笔记 ================== */

  const SUB3 = sub({ id: 'sub-1', name: '测试订阅', categories: 'cs.LG, cs.CL' });

  /* ③-1 3 条结果，1 条已在 seen → added=2 skipped=1 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]),
        [PREFIX + 'searchSubsSeen']: JSON.stringify({ 'arXiv:2501.00001': { at: 1 } }),
      },
      arxiv: makeArxiv([entry(1), entry(2), entry(3)]),
    });
    const r = await env.S.run('sub-1', { now: AT });

    eq(r.ok, true, '③ 正常执行 → ok');
    eq(r.added, 2, '③ 新条目入库 2 条');
    eq(r.skipped, 1, '③ seen 命中跳过 1 条');
    eq(r.failed, 0, '③ 无失败');
    eq(env.items.length, 2, '③ 只保存了 2 个条目');
    eq(env.notes.length, 1, '③ 生成 1 篇速递笔记');
    eq(r.noteTitle, '订阅速递：测试订阅 ' + DAY, '③ 笔记标题 = 订阅速递：<name> YYYY-MM-DD');

    const call = env.arxiv.calls[0];
    eq(call.opts.limit, 10, '③ search limit = 订阅 max');
    eq(call.opts.sortBy, 'submittedDate', '③ search 按提交时间排序');
    eq(call.opts.sortOrder, 'descending', '③ search 降序');
    eq(JSON.stringify(call.spec.categories), '["cs.LG","cs.CL"]', '③ 分类逗号分隔转数组');
    eq(JSON.stringify(call.spec.keywords), '["attention"]', '③ 关键词转数组');
    eq(call.spec.categoryMode, 'OR', '③ 多分类是并集语义');

    const html = env.notes[0].html;
    has(html, '订阅速递：测试订阅 ' + DAY, '③ 笔记内含规范标题');
    has(html, 'Paper 2', '③ 笔记列出新命中标题');
    has(html, 'arXiv:2501.00002', '③ 笔记列出 arXiv ID');
    has(html, '(2025)', '③ 笔记列出年份');
    has(html, '新入库', '③ 笔记标注新入库');
    has(html, '已在库', '③ 笔记标注跳过项');
    notHas(html, '本次无新增', '③ 有新增时不写空态');

    const it = env.items[0];
    eq(it.itemType, 'preprint', '③ 条目类型为 preprint');
    eq(it.libraryID, 1, '③ 条目落在用户库');
    eq(it.fields.title, 'Paper 2', '③ 条目 title 正确');
    eq(it.fields.date, '2025-01-02', '③ 条目 date 取 publishedDay');
    eq(it.fields.extra, 'arXiv: 2501.00002', '③ 条目 extra = arXiv: <id>');
    eq(it.fields.url, 'https://arxiv.org/abs/2501.00002', '③ 条目 url 指向 abs 页');
    has(it.fields.abstractNote, 'Abstract 2', '③ 条目 abstractNote 来自摘要');
    eq(JSON.stringify(it.tags), JSON.stringify(['#订阅/测试订阅']), '③ 条目带 #订阅/<name> 标签');
    eq(it.creators.length, 2, '③ 作者全部保留');
    eq(it.creators[0].firstName, 'Ada', '③ 作者 firstName 拆分');
    eq(it.creators[0].lastName, 'Lovelace', '③ 作者 lastName 拆分');
    eq(it.creators[0].creatorType, 'author', '③ 作者类型 author');

    const seen = env.seen();
    ok(seen['arXiv:2501.00002'] && seen['arXiv:2501.00002'].itemID === it.id,
      '③ 新入库写入 seen（含 itemID）', seen['arXiv:2501.00002']);
    ok(seen['arXiv:2501.00003'], '③ 第二条新入库也记账');
    eq(seen['arXiv:2501.00001'].at, AT.getTime(), '③ 已记账条目刷新 LRU at');
    eq(env.subs()[0].lastRun, '', '③ 手动 run 不写 lastRun');
  }

  /* ③-2 autoImport=false：不建条目，但笔记仍列全部结果 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ autoImport: false })]) },
      arxiv: makeArxiv([entry(1), entry(2), entry(3)]),
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, true, '③ autoImport=false 仍 ok');
    eq(r.added, 0, '③ autoImport=false 不计数入库');
    eq(env.items.length, 0, '③ autoImport=false 不建条目');
    eq(env.notes.length, 1, '③ autoImport=false 仍生成速递');
    const html = env.notes[0].html;
    has(html, 'Paper 1', '③ 笔记列出第 1 条');
    has(html, 'Paper 2', '③ 笔记列出第 2 条');
    has(html, 'Paper 3', '③ 笔记列出第 3 条');
    has(html, '未入库', '③ 标注为未入库');
    notHas(html, '本次无新增', '③ 有新命中时不写空态');
  }

  /* ③-2b ★ autoImport=false 不写 seen：之后改成自动入库仍能收到（回归：静默丢论文） */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ autoImport: false })]) },
      arxiv: makeArxiv([entry(1), entry(2), entry(3)]),
    });
    const r1 = await env.S.run('sub-1', { now: AT });
    eq(r1.added, 0, '③ ★ autoImport=false 不入库');
    eq(env.items.length, 0, '③ ★ autoImport=false 不建条目');
    eq(env.seen()['arXiv:2501.00001'], undefined, '③ ★ autoImport=false 不写 seen（第 1 条）');
    eq(env.seen()['arXiv:2501.00002'], undefined, '③ ★ autoImport=false 不写 seen（第 2 条）');
    eq(Object.keys(env.seen() || {}).length, 0, '③ ★ autoImport=false 完全不记账');

    // 再跑一次：因为没有记账，仍然能列出全部结果（不会被自己标成「往期已见」）
    const r2 = await env.S.run('sub-1', { now: AT });
    eq(r2.ok, true, '③ 第二次运行仍 ok');
    eq(r2.skipped, 0, '③ 第二次运行 skipped=0（不自我判重）');
    eq(env.notes.length, 2, '③ 第二次运行仍生成速递');
    const html = env.notes[1].html;
    has(html, 'Paper 1', '③ 第二次速递仍列出第 1 条');
    has(html, 'Paper 2', '③ 第二次速递仍列出第 2 条');
    has(html, 'Paper 3', '③ 第二次速递仍列出第 3 条');
    eq(env.items.length, 0, '③ 第二次运行仍未入库');
  }

  /* ③-2c ★ 批内去重：同一批里重复出现的同一条只处理一次（不写 pref） */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ autoImport: false })]) },
      arxiv: makeArxiv([entry(1), entry(1), entry(2)]),
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, true, '③ 批内重复仍 ok');
    eq(r.skipped, 1, '③ ★ 批内重复条目计入 skipped');
    eq(r.added, 0, '③ 批内重复不新增');
    eq(env.items.length, 0, '③ autoImport=false 仍不入库');
    const html = env.notes[0].html;
    has(html, '共 2 条结果', '③ ★ 速递去重后只列 2 条');
    eq(html.split('Paper 1').length - 1, 1, '③ ★ Paper 1 只出现一次');
    eq(html.split('Paper 2').length - 1, 1, '③ Paper 2 只出现一次');
    eq(Object.keys(env.seen() || {}).length, 0, '③ 批内去重不写 seen（纯本次执行的内存集合）');
  }

  /* ③-3 全部已在 seen → 空态文案 */
  {
    const seenMap = {};
    for (const i of [1, 2, 3]) seenMap['arXiv:2501.0000' + i] = { at: 1 };
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]),
        [PREFIX + 'searchSubsSeen']: JSON.stringify(seenMap),
      },
      arxiv: makeArxiv([entry(1), entry(2), entry(3)]),
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, true, '③ 全重复仍 ok');
    eq(r.added, 0, '③ 全重复 added=0');
    eq(r.skipped, 3, '③ 全重复 skipped=3');
    eq(env.items.length, 0, '③ 全重复不建条目');
    has(env.notes[0].html, '本次无新增', '③ 全重复 → 笔记写「本次无新增」');
  }

  /* ③-4 saveTx 抛错 → failed=1，其余条目继续 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]) },
      arxiv: makeArxiv([entry(1), entry(2), entry(3)]),
    });
    env.failNext();
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, true, '③ 单条 saveTx 失败不影响整体 ok');
    eq(r.failed, 1, '③ 失败计数 1');
    eq(r.added, 2, '③ 其余 2 条照常入库');
    eq(env.items.length, 2, '③ 失败条目未落库');
    has(env.notes[0].html, '入库失败', '③ 笔记标注入库失败');
    ok(env.diags.length > 0, '③ 失败写日志（_diag）');
    eq(env.seen()['arXiv:2501.00001'], undefined, '③ 失败条目不记账（下次可重试）');
  }

  /* ③-5 no_arxiv / network / empty / no_sub / busy */
  {
    const env = makeEnv({ prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]) } });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, false, '③ ArxivFetch 缺位 → ok:false');
    eq(r.reason, 'no_arxiv', '③ ArxivFetch 缺位 → reason=no_arxiv');
    eq(r.added, 0, '③ 缺位时计数为 0');
  }
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]) },
      arxiv: makeArxiv([], 'throw'),
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, false, '③ search 抛错 → ok:false');
    eq(r.reason, 'network', '③ search 抛错 → reason=network');
    eq(env.notes.length, 0, '③ 网络失败不生成笔记');
  }
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]) },
      arxiv: makeArxiv([]),
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, false, '③ 0 条结果 → ok:false');
    eq(r.reason, 'empty', '③ 0 条结果 → reason=empty');
  }
  {
    const env = makeEnv({ arxiv: makeArxiv([entry(1)]) });
    const r = await env.S.run('sub-nope', { now: AT });
    eq(r.ok, false, '③ 未知订阅 → ok:false');
    eq(r.reason, 'no_sub', '③ 未知订阅 → reason=no_sub');
  }

  /* ③-6 opts.noNote：入库但不出笔记 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]) },
      arxiv: makeArxiv([entry(1), entry(2)]),
    });
    const r = await env.S.run('sub-1', { now: AT, noNote: true });
    eq(r.ok, true, '③ noNote 仍 ok');
    eq(r.added, 2, '③ noNote 照常入库');
    eq(r.noteTitle, undefined, '③ noNote 不返回 noteTitle');
    eq(env.notes.length, 0, '③ noNote 不建笔记');
  }

  /* ③-7 getByDOI 命中 → 跳过并记 seen(itemID)；getByDOI 抛错 → 照常入库 */
  {
    const e4 = entry(4, { doi: '10.1000/DUP' });
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]) },
      arxiv: makeArxiv([e4]),
      byDoi: (doi) => (String(doi).toLowerCase() === '10.1000/dup' ? { id: 777 } : null),
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, true, '③ DOI 查重路径 ok');
    eq(r.added, 0, '③ DOI 已在库 → 不入库');
    eq(r.skipped, 1, '③ DOI 已在库 → skipped=1');
    eq(env.items.length, 0, '③ DOI 已在库 → 未建条目');
    eq(env.seen()['doi:10.1000/dup'].itemID, 777, '③ 查重命中记 seen.itemID');
  }
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([SUB3]) },
      arxiv: makeArxiv([entry(5, { doi: '10.1000/ERR' })]),
      byDoi: () => { throw new Error('query failed'); },
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, true, '③ getByDOI 抛错 → 不影响执行');
    eq(r.added, 1, '③ getByDOI 抛错按未入库处理');
  }

  /* ③-8 seen LRU：超过 1000 淘汰最旧 */
  {
    const S = makeEnv().S;
    const map = {};
    for (let i = 0; i < 1005; i++) S._seenPut(map, 'fp' + i, null, i + 1);
    eq(Object.keys(map).length, 1000, '③ seen 记账裁剪到 1000 条');
    eq(map['fp0'], undefined, '③ 最旧的第 1 条被淘汰');
    eq(map['fp4'], undefined, '③ 最旧的 5 条都被淘汰');
    ok(!!map['fp5'], '③ 第 6 条保留');
    ok(!!map['fp1004'], '③ 最新一条保留');
    eq(map['fp1004'].at, 1005, '③ 保留 at 时间戳');
  }

  /* ================== ④ checkDue 调度语义 ================== */

  /* ④-1 时间未到：不跑、不写 lastRun */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: '09:00' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT);
    eq(done.length, 0, '④ 时间未到 → 不执行');
    eq(env.arxiv.calls.length, 0, '④ 时间未到 → 不发请求');
    eq(env.notes.length, 0, '④ 时间未到 → 不生成笔记');
    eq(env.subs()[0].lastRun, '', '④ 时间未到 → 不写 lastRun');
  }

  /* ④-2 到点：执行并写 lastRun */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: '07:30' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["sub-1"]', '④ 到点 → 返回执行的 id 数组');
    eq(env.subs()[0].lastRun, DAY, '④ 到点 → lastRun 记当天');
    eq(env.notes.length, 1, '④ 到点 → 生成速递笔记');
  }

  /* ④-3 当天已跑：跳过 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: '07:30', lastRun: DAY })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT);
    eq(done.length, 0, '④ 当天已跑 → 跳过');
    eq(env.arxiv.calls.length, 0, '④ 当天已跑 → 不发请求');
  }

  /* ④-4 超 6h 不补跑；正好 6h 补跑 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: '00:30' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT); // 00:30 → 08:00 已过 7.5h
    eq(done.length, 0, '④ 错过 7.5 小时 → 不补跑');
  }
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: '02:00' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT); // 02:00 + 6h = 08:00，含边界
    eq(JSON.stringify(done), '["sub-1"]', '④ 正好 6 小时边界 → 补跑');
  }

  /* ④-5 空时间 / 坏格式：仅手动 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([
          sub({ id: 'sub-1', dailyTime: '' }),
          sub({ id: 'sub-2', dailyTime: '25:99' }),
          sub({ id: 'sub-3', dailyTime: 'abc' }),
        ]),
      },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT);
    eq(done.length, 0, '④ 空时间/坏格式 → 全部跳过');
    eq(env.arxiv.calls.length, 0, '④ 仅手动订阅不发请求');
  }

  /* ④-6 多订阅独立：各自按自己的时间命中 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([
          sub({ id: 'sub-1', name: 'A', dailyTime: '07:30' }),
          sub({ id: 'sub-2', name: 'B', dailyTime: '08:00' }),
          sub({ id: 'sub-3', name: 'C', dailyTime: '09:00' }),
        ]),
      },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["sub-1","sub-2"]', '④ 多订阅：只执行到点的两个');
    eq(env.notes.length, 2, '④ 多订阅：各生成一篇速递');
    const list = env.subs();
    eq(list[0].lastRun, DAY, '④ 多订阅：A 记 lastRun');
    eq(list[1].lastRun, DAY, '④ 多订阅：B 记 lastRun');
    eq(list[2].lastRun, '', '④ 多订阅：未到点的 C 不记 lastRun');
  }

  /* ④-7 执行失败仍写 lastRun（当天不反复重试），且不抛 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: '07:30' })]) },
      arxiv: makeArxiv([], 'throw'),
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["sub-1"]', '④ 网络失败仍算已触发');
    eq(env.subs()[0].lastRun, DAY, '④ 网络失败也写 lastRun（避免每分钟重试）');
    eq(env.notes.length, 0, '④ 网络失败不生成笔记');
    ok(env.diags.length > 0, '④ 网络失败写日志');
  }

  /* ================== ⑤ start / stop ================== */

  /* ⑤-1 幂等 + 60s + 启动即查 */
  {
    const env = makeEnv();
    env.S.start();
    env.S.start();
    eq(env.intervals.length, 1, '⑤ 两次 start 只创建一个 interval');
    eq(env.intervals[0].ms, 60000, '⑤ 轮询间隔 60s');
    const first = await env.S._startupCheck;
    ok(Array.isArray(first), '⑤ start 先跑一次 checkDue（返回 id 数组）');
    env.S.stop();
    eq(env.intervals[0].cleared, true, '⑤ stop 清掉 interval');
    eq(env.S._timer, null, '⑤ stop 后 _timer 清空');
  }

  /* ⑤-2 stop 可重复调用；重新 start 建新 interval 不叠加 */
  {
    const env = makeEnv();
    env.S.stop();
    eq(env.S._timer, null, '⑤ 未启动时 stop 安全');
    env.S.start();
    const firstId = env.S._timer;
    ok(typeof firstId === 'number', '⑤ start 记下 interval id');
    env.S.stop();
    env.S.start();
    eq(env.intervals.length, 2, '⑤ 重新 start 会建新 interval（旧的不叠加）');
    ok(env.intervals[1].id !== firstId, '⑤ 新 interval 是新 id');
    env.S.stop();
  }

  /* ⑤-3 启动检查命中当前分钟 → 立即执行 */
  {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const t = p(now.getHours()) + ':' + p(now.getMinutes());
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: t })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    env.S.start();
    const done = await env.S._startupCheck;
    eq(JSON.stringify(done), '["sub-1"]', '⑤ 启动检查命中当前分钟 → 立即执行');
    eq(env.notes.length, 1, '⑤ 启动检查生成笔记');
    env.S.stop();
  }

  /* ⑤-4 轮询回调重复触发不会重复建笔记 */
  {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const t = p(now.getHours()) + ':' + p(now.getMinutes());
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ dailyTime: t })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    env.S.start();
    await env.S._startupCheck;
    eq(env.notes.length, 1, '⑤ 启动检查先跑一次');
    const rec = env.intervals[0];
    rec.fn();
    await env.S._lastCheck;
    eq(env.notes.length, 1, '⑤ 同一天第二次轮询不重复建笔记');
    env.S.stop();
  }

  /* ================== ⑥ v2：模型 / 预览 / 频率 / 运行历史 ================== */

  /* ⑥-1 v2 字段归一 + 旧订阅迁移 */
  {
    const env = makeEnv();
    const S = env.S;
    const a = S.add({
      name: '多源订阅', keywords: 'sparse attention', categories: 'cs.LG',
      sources: ['arxiv', 'openalex', 'bogus'], mode: 'any', exclude: 'survey',
      maxAgeDays: 14, freq: 'weekly', dailyTime: '7:30', weekdays: [1, 3, 5],
      aiRerank: true, aiDigest: true, seedProfile: true, enabled: false, autoImport: false,
    });
    ok(!!a, '⑥ add v2 字段');
    eq(JSON.stringify(a.sources), '["arxiv","openalex"]', '⑥ 未知来源被过滤');
    eq(a.mode, 'any', '⑥ 布尔模式');
    eq(a.freq, 'weekly', '⑥ 每周频率');
    eq(a.dailyTime, '07:30', '⑥ 时间归一');
    eq(JSON.stringify(a.weekdays), '[1,3,5]', '⑥ 星期归一');
    eq(a.enabled, false, '⑥ 停用状态');
    eq(a.maxAgeDays, 14, '⑥ 时间窗');
    eq(a.aiRerank, true, '⑥ AI 复核开关');
    eq(a.autoImport, false, '⑥ 自动入库开关');

    const b = S.add({ name: '每周无时间', keywords: 'x', freq: 'weekly' });
    eq(b.freq, 'manual', '⑥ 每周但无时间 → 降级手动');

    const raw = S.list().filter((x) => x.id === a.id)[0];
    eq(JSON.stringify(raw.sources), '["arxiv","openalex"]', '⑥ 落盘后仍保留来源');

    // 旧版（0.53）只有 keywords/categories/dailyTime 的订阅
    const legacy = env.S._normSub({ id: 'sub-old', name: '旧订阅', keywords: 'x', categories: '', dailyTime: '07:30', max: 10, autoImport: true, lastRun: '', createdAt: 1 });
    eq(legacy.sources[0], 'arxiv', '⑥ 旧订阅默认 arxiv');
    eq(legacy.enabled, true, '⑥ 旧订阅默认启用');
    eq(legacy.freq, 'daily', '⑥ 旧订阅带时间 → 每日');
    eq(legacy.mode, 'all', '⑥ 旧订阅默认 AND');
  }

  /* ⑥-2 preview：只读、不写 pref、不入库、不记账 */
  {
    const SUBP = sub({ id: 'sub-1', name: '预览订阅', keywords: 'attention' });
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([SUBP]),
        [PREFIX + 'searchSubsSeen']: JSON.stringify({ 'arXiv:2501.00001': { at: 1 } }),
      },
      arxiv: makeArxiv([entry(1), entry(2)]),
    });
    const r = await env.S.preview('sub-1', { now: AT, limit: 10 });
    eq(r.ok, true, '⑥ preview ok');
    eq(r.entries.length, 2, '⑥ preview 返回条目');
    eq(r.entries.filter((e) => e.status === 'seen').length, 1, '⑥ 往期已见标注');
    eq(r.entries.filter((e) => e.status === 'new').length, 1, '⑥ 新命中标注');
    eq(env.items.length, 0, '⑥ preview 不入库');
    eq(env.notes.length, 0, '⑥ preview 不出笔记');
    eq(env.seen()['arXiv:2501.00002'], undefined, '⑥ preview 不写 seen');
    eq(env.subs()[0].lastRun, '', '⑥ preview 不写 lastRun');
    eq(env.subs()[0].lastStatus || '', '', '⑥ preview 不写运行状态');

    const bad = await env.S.preview('sub-nope');
    eq(bad.reason, 'no_sub', '⑥ preview 未知订阅');
    const noQ = await env.S.preview({ name: 'x' });
    eq(noQ.reason, 'no_query', '⑥ preview 无条件 → no_query');

    // 草稿预览：不落盘
    const before = env.subs().length;
    const d = await env.S.preview({ name: '草稿', keywords: 'attention' }, { now: AT });
    eq(d.ok, true, '⑥ 草稿预览 ok');
    eq(env.subs().length, before, '⑥ 草稿预览不创建订阅');
  }

  /* ⑥-3 启停 / 每周计划日 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ enabled: false, dailyTime: '07:30' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '[]', '⑥ 停用订阅不自动跑');
    eq(env.arxiv.calls.length, 0, '⑥ 停用订阅不发请求');
  }
  {
    const weekly = sub({ id: 'sub-1', name: '每周', dailyTime: '07:30', freq: 'weekly', weekdays: [1] });
    const monday = new Date(2026, 9, 19, 8, 0, 0);
    const env1 = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([weekly]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const sundayDone = await env1.S.checkDue(AT);
    eq(JSON.stringify(sundayDone), '[]', '⑥ 周日不在计划日 → 不跑');
    const env2 = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([weekly]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const mondayDone = await env2.S.checkDue(monday);
    eq(JSON.stringify(mondayDone), '["sub-1"]', '⑥ 周一在计划日 → 跑');
    eq(env2.subs()[0].lastRun, '2026-10-19', '⑥ 每周写当天 lastRun');
  }

  /* ⑥-4 运行历史（最新在前，最多 5 条） */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    await env.S.run('sub-1', { now: AT });
    await env.S.run('sub-1', { now: AT });
    const s = env.subs()[0];
    eq(s.runLog.length, 2, '⑥ 两次运行 → 两条历史');
    eq(s.runLog[0].added, 0, '⑥ 最新一条在前（第二次全跳过）');
    eq(s.runLog[0].skipped, 1, '⑥ 第二次跳过 1');
    eq(s.runLog[1].added, 1, '⑥ 第一条记录入库 1');
    has(s.lastStatus, '新入库', '⑥ lastStatus 可读');

    const five = [1, 2, 3, 4, 5].map((i) => ({ at: '2026-10-1' + i, added: i, skipped: 0, failed: 0, trigger: 'manual', reason: '' }));
    const env2 = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1', runLog: five })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    await env2.S.run('sub-1', { now: AT });
    eq(env2.subs()[0].runLog.length, 5, '⑥ 运行历史最多 5 条');
  }

  /* ================== ⑦ v2：AI 辅助（失败必须降级） ================== */

  /* ⑦-1 一句话 → 草稿：白名单校验 + 强制不入库 */
  {
    const ai = {
      status: () => 'ok',
      hasKey: () => true,
      chat: async () => '```json\n' + JSON.stringify({
        name: '稀疏注意力',
        keywords: ['sparse attention', 'long context'],
        categories: ['cs.CL', 'cs.nope'],
        sources: ['arxiv', 'bogus'],
        mode: 'any',
        exclude: ['survey'],
        maxAgeDays: 14,
        freq: 'daily',
        dailyTime: '9:05',
        autoImport: true,
      }) + '\n```',
    };
    const cats = {
      ALL: [{ code: 'cs.CL' }, { code: 'cs.nope' }],
      checkAll: (list) => ({ valid: (list || []).filter((c) => c === 'cs.CL'), unknown: ['cs.nope'], malformed: [], suggestions: [] }),
    };
    const env = makeEnv({ ai, arxivCategories: cats });
    const r = await env.S.aiParseQuery('追踪稀疏注意力');
    eq(r.ok, true, '⑦ AI 解析 ok');
    eq(r.input.name, '稀疏注意力', '⑦ 保留 AI 名称');
    eq(r.input.keywords, 'sparse attention, long context', '⑦ 关键词数组拼串');
    eq(r.input.categories, 'cs.CL', '⑦ 非法分类被丢弃');
    eq(JSON.stringify(r.input.sources), '["arxiv"]', '⑦ 未知来源被丢弃');
    eq(r.input.mode, 'any', '⑦ 模式保留');
    eq(r.input.dailyTime, '09:05', '⑦ 时间归一');
    eq(r.input.autoImport, false, '⑦ ★ 强制先预览，不自动入库');
    eq(r.input.maxAgeDays, 14, '⑦ 时间窗保留');
    eq(env.S.list().length, 0, '⑦ 解析不创建订阅');
  }

  /* ⑦-2 解析失败 / AI 未配置 / 调用异常 */
  {
    const bad = makeEnv({ ai: { status: () => 'ok', chat: async () => '抱歉，我无法完成。' } });
    const r1 = await bad.S.aiParseQuery('随便写点');
    eq(r1.ok, false, '⑦ 非 JSON → 失败');
    eq(r1.reason, 'parse_failed', '⑦ 非 JSON → parse_failed');

    const noai = makeEnv();
    const r2 = await noai.S.aiParseQuery('追踪稀疏注意力');
    eq(r2.ok, false, '⑦ 无 AI 模块 → 失败');
    eq(r2.reason, 'no_ai', '⑦ 无 AI → no_ai');
    ok(!!r2.guide, '⑦ 无 AI 给出指引');

    const err = makeEnv({ ai: { status: () => 'ok', chat: async () => { throw new Error('429 quota'); } } });
    const r3 = await err.S.aiParseQuery('追踪稀疏注意力');
    eq(r3.reason, 'ai_failed', '⑦ AI 抛错 → ai_failed');
    has(r3.guide, '429', '⑦ 错误原因透出');

    const login = makeEnv({ ai: { status: () => 'not_logged_in', chat: async () => '' } });
    const r4 = await login.S.aiParseQuery('追踪稀疏注意力');
    eq(r4.reason, 'not_logged_in', '⑦ 未登录 → 精确原因');
    has(r4.guide, '登录', '⑦ 未登录给出登录指引');
  }

  /* ⑦-3 AI 复核排序；失败保持原序 */
  {
    const entries = [
      { source: 'arxiv', arxivId: '1', title: 'A', summary: 'x' },
      { source: 'arxiv', arxivId: '2', title: 'B', summary: 'y' },
    ];
    const env = makeEnv({
      ai: { status: () => 'ok', chat: async () => '[{"i":2,"score":90,"why":"best"},{"i":1,"score":10,"why":"meh"}]' },
    });
    const out = await env.S.aiRerank(sub(), entries);
    eq(out[0].title, 'B', '⑦ AI 复核重排');
    eq(out[0].aiScore, 90, '⑦ 分数落地');
    eq(out[0].aiWhy, 'best', '⑦ 理由落地');

    const bad = makeEnv({ ai: { status: () => 'ok', chat: async () => 'not json' } });
    const same = await bad.S.aiRerank(sub(), entries);
    eq(same[0].title, 'A', '⑦ 解析失败保持原序');
    eq(same[0].aiScore, undefined, '⑦ 解析失败不写分数');

    const none = makeEnv();
    const same2 = await none.S.aiRerank(sub(), entries);
    eq(same2[0].title, 'A', '⑦ 无 AI 保持原序');
  }

  /* ================== ⑧ v2：基于库内领域的推荐 ================== */

  function libItem(title, tags, cats, daysAgo) {
    return {
      dateAdded: new Date(AT.getTime() - daysAgo * 86400000).toISOString(),
      _cats: cats,
      getField(f) {
        if (f === 'title') return title;
        if (f === 'abstractNote') return '';
        return '';
      },
      getTags() { return (tags || []).map((t) => ({ tag: t })); },
    };
  }

  {
    const items = [
      libItem('Sparse attention for long context', ['attention'], ['cs.LG'], 10),
      libItem('Sparse attention efficiency', ['attention'], ['cs.LG'], 40),
      libItem('Unrelated topic about biology', ['bio'], ['q-bio.NC'], 200),
    ];
    const discovery = {
      collectLibraryItems: async () => items,
      buildProfile: () => ({ terms: [{ term: 'sparse', weight: 9 }, { term: 'attention', weight: 8 }, { term: 'context', weight: 3 }], categories: ['cs.LG'], scanned: 3 }),
      extractArxiv: (it) => ({ categories: it._cats, arxivId: '' }),
      tokenize: (s) => String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((x) => x && x.length >= 2),
    };
    const env = makeEnv({ discovery });
    const list = await env.S.suggest({ max: 3, now: AT });
    ok(list.length >= 1, '⑧ 产出推荐主题', list.length);
    ok(list.length <= 3, '⑧ 不超过 max');
    has(list[0].keywords, 'sparse', '⑧ 关键词来自画像');
    ok(list[0].coverage >= 2, '⑧ 覆盖篇数可解释', list[0].coverage);
    ok(!!list[0].reason, '⑧ 给出推荐理由');
    ok(list[0].sources.indexOf('arxiv') >= 0, '⑧ 默认来源含 arXiv');
    eq(list[0].autoImport, undefined, '⑧ 推荐不携带自动入库决定');

    // 忽略后不再出现
    const id = list[0].id;
    env.S.dismissReco(id);
    const again = await env.S.suggest({ max: 3, now: AT });
    ok(!again.some((x) => x.id === id), '⑧ 忽略的推荐不再出现');
  }

  {
    // 现有订阅已覆盖同主题 → 不再推荐
    const items = [
      libItem('Sparse attention for long context', ['attention'], ['cs.LG'], 10),
      libItem('Sparse attention efficiency', ['attention'], ['cs.LG'], 40),
    ];
    const discovery = {
      collectLibraryItems: async () => items,
      buildProfile: () => ({ terms: [{ term: 'sparse', weight: 9 }, { term: 'attention', weight: 8 }], categories: ['cs.LG'], scanned: 2 }),
      extractArxiv: (it) => ({ categories: it._cats }),
      tokenize: (s) => String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean),
    };
    const env = makeEnv({
      discovery,
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ keywords: 'sparse, attention', categories: 'cs.LG' })]) },
    });
    const list = await env.S.suggest({ max: 3, now: AT });
    eq(list.length, 0, '⑧ 与现有订阅重复 → 不推荐');
  }

  {
    // 冷启动：库为空 → 用「研究者画像」文本
    const env = makeEnv({
      discovery: {
        collectLibraryItems: async () => [],
        buildProfile: () => ({ terms: [], categories: [], scanned: 0 }),
        extractArxiv: () => ({ categories: [] }),
        tokenize: (s) => String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((x) => x && x.length >= 2),
      },
      prefs: { [PREFIX + 'researcherProfile']: 'graph neural networks for molecular property prediction' },
    });
    const list = await env.S.suggest({ max: 3, now: AT });
    eq(list.length, 1, '⑧ 冷启动回退研究者画像');
    has(list[0].name, '研究方向', '⑧ 冷启动命名');
    has(list[0].keywords, 'graph', '⑧ 画像词进入关键词');
  }

  /* ⑧-4 ★ 12h 推荐缓存 / 强制刷新 / 订阅变化失效 / 忽略命中缓存 */
  {
    let scans = 0;
    const items = [
      libItem('Sparse attention for long context', ['attention'], ['cs.LG'], 10),
      libItem('Sparse attention efficiency', ['attention'], ['cs.LG'], 40),
      libItem('Vision transformer scaling', ['vit'], ['cs.CV'], 5),
    ];
    const discovery = {
      collectLibraryItems: async () => { scans++; return items; },
      buildProfile: () => ({ terms: [{ term: 'sparse' }, { term: 'attention' }, { term: 'context' }], categories: ['cs.LG'], scanned: 3 }),
      extractArxiv: (it) => ({ categories: it._cats }),
      tokenize: (s) => String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean),
    };
    const env = makeEnv({ discovery });

    const a = await env.S.suggest({ max: 3, now: AT });
    eq(scans, 1, '⑧ 首次推荐扫描库内条目');
    ok(a.length >= 1, '⑧ 首次推荐有结果', a.length);
    eq(env.S.recoFromCache(), false, '⑧ 首次推荐不算缓存命中');
    ok(!!env.prefs('searchSubsRecoCache'), '⑧ 计算结果写入缓存 pref');

    const b = await env.S.suggest({ max: 3, now: AT });
    eq(scans, 1, '⑧ ★ 12h 内再次 suggest 走缓存（只扫描 1 次）');
    eq(b.length, a.length, '⑧ 缓存返回相同数量');
    eq(env.S.recoFromCache(), true, '⑧ 缓存命中可被面板识别');

    const c = await env.S.suggest({ max: 3, force: true, now: AT });
    eq(scans, 2, '⑧ ★ suggest({force:true}) 强制重新扫描');
    eq(env.S.recoFromCache(), false, '⑧ force 时不算缓存命中');
    ok(c.length >= 1, '⑧ force 仍有结果', c.length);

    // 忽略后：即使命中缓存也不能返回该 id
    const id = c[0].id;
    ok(env.S.dismissReco(id), '⑧ 忽略推荐成功');
    ok(JSON.stringify(env.prefs('searchSubsRecoCache')).indexOf(id) < 0, '⑧ 缓存里也已剔除被忽略的 id');
    const d = await env.S.suggest({ max: 3, now: AT });
    ok(!d.some((x) => x.id === id), '⑧ ★ 忽略的推荐即使命中缓存也不返回');
    // 缓存被删空时按「无缓存」重算（空推荐不写缓存），这里不为扫描次数写死断言

    // add() / update() / remove() 都会让「与现有订阅去重」的结论失效
    ok(!!env.S.add({ name: '新增订阅', keywords: 'vision transformer' }), '⑧ 新增订阅成功');
    eq(env.prefs('searchSubsRecoCache'), '', '⑧ ★ add() 后缓存被清空');
    let before = scans;
    await env.S.suggest({ max: 3, now: AT });
    eq(scans, before + 1, '⑧ ★ add() 后 suggest 重新扫描');

    const subId = env.subs()[0].id;
    ok(!!env.S.update(subId, { max: 12 }), '⑧ 修改订阅成功');
    eq(env.prefs('searchSubsRecoCache'), '', '⑧ update() 后缓存被清空');
    before = scans;
    await env.S.suggest({ max: 3, now: AT });
    eq(scans, before + 1, '⑧ update() 后重新扫描');

    env.S.remove(subId);
    eq(env.prefs('searchSubsRecoCache'), '', '⑧ remove() 后缓存被清空');

    // 过期 / 损坏的缓存：按无缓存处理，绝不抛
    env.store.set(PREFIX + 'searchSubsRecoCache', JSON.stringify({ at: Date.now() - env.S.RECO_TTL_MS - 1000, items: a }));
    before = scans;
    await env.S.suggest({ max: 3, now: AT });
    eq(scans, before + 1, '⑧ ★ 超过 12h 的缓存视为过期 → 重新扫描');

    env.store.set(PREFIX + 'searchSubsRecoCache', '{oops');
    before = scans;
    await env.S.suggest({ max: 3, now: AT });
    eq(scans, before + 1, '⑧ 坏缓存按无缓存处理（不抛）');

    // 脏元素过滤：缓存是跨版本残留的 JSON，坏元素渲染推荐卡时会直接抛错
    env.store.set(PREFIX + 'searchSubsRecoCache',
      JSON.stringify({ at: Date.now(), items: ['junk', 42, null, { id: 'ok' }] }));
    const loaded = env.S._recoCacheLoad();
    ok(!!loaded, '⑧ 含脏元素的缓存仍可加载');
    eq(loaded.items.length, 1, '⑧ ★ 脏元素被过滤，只留合法对象');
    eq(loaded.items[0].id, 'ok', '⑧ 过滤后保留合法推荐');

    env.store.set(PREFIX + 'searchSubsRecoCache',
      JSON.stringify({ at: Date.now(), items: ['junk', 42, null, []] }));
    eq(env.S._recoCacheLoad(), null, '⑧ ★ 全是脏元素 → 视为无缓存');
  }

  /* ⑧-5 空推荐不写缓存（否则「暂无推荐」会被冻结 12 小时） */
  {
    const env = makeEnv({
      discovery: {
        collectLibraryItems: async () => [],
        buildProfile: () => ({ terms: [], categories: [], scanned: 0 }),
        extractArxiv: () => ({ categories: [] }),
        tokenize: (s) => String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((x) => x && x.length >= 2),
      },
    });
    const list = await env.S.suggest({ max: 3, now: AT });
    eq(list.length, 0, '⑧ 空库且无画像 → 无推荐');
    eq(env.prefs('searchSubsRecoCache'), '', '⑧ ★ 空推荐不写缓存（pref 写回空串，下次立刻重算）');
  }

  /* ================== ⑨ v2：从文献发现衔接 ================== */
  {
    const env = makeEnv({
      discovery: {
        loadCache: () => ({ profile: { terms: [{ term: 'sparse' }, { term: 'attention' }] } }),
      },
      prefs: { [PREFIX + 'discoveryCategories']: 'cs.CL, cs.AI' },
    });
    const d = env.S.fromDiscovery();
    eq(d.categories, 'cs.CL, cs.AI', '⑨ 继承发现分类');
    eq(d.keywords, 'sparse, attention', '⑨ 继承画像词');
    eq(d.freq, 'daily', '⑨ 默认每日');
    eq(d.autoImport, false, '⑨ 默认不自动入库');
    ok(env.S.add(d), '⑨ 草稿可直接创建');
  }

  /* ================== ⑩ v2：导出 / 导入（剪贴板 JSON） ================== */

  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({
          id: 'sub-1', name: 'A', keywords: 'attention', categories: '', dailyTime: '08:00',
          freq: 'daily', sources: ['arxiv', 'openalex'], max: 12, autoImport: false,
          lastRun: DAY, lastStatus: '2026-10-18 08:00 · +1 新入库 / 0 跳过',
          runLog: [{ at: '2026-10-18 08:00', added: 1, skipped: 0, failed: 0, trigger: 'daily', reason: '' }],
          createdAt: 12345,
        })]),
      },
    });

    const json = env.S.exportJson();
    ok(/^ {2}"app":/.test(String(json).split('\n')[1] || ''), '⑩ 导出 JSON 为 2 空格缩进');
    const obj = JSON.parse(json);
    eq(obj.app, 'papilot', '⑩ 导出带 app 标记');
    eq(obj.kind, 'searchSubscriptions', '⑩ 导出 kind');
    eq(obj.version, 2, '⑩ 导出 version=2');
    eq(obj.subscriptions.length, 1, '⑩ 导出条目数');

    const s0 = obj.subscriptions[0];
    eq(s0.id, undefined, '⑩ ★ 不导出 id');
    eq(s0.lastRun, undefined, '⑩ ★ 不导出 lastRun');
    eq(s0.lastStatus, undefined, '⑩ ★ 不导出 lastStatus');
    eq(s0.runLog, undefined, '⑩ ★ 不导出 runLog');
    eq(s0.createdAt, undefined, '⑩ ★ 不导出 createdAt');
    eq(s0.name, 'A', '⑩ 导出 name');
    eq(s0.keywords, 'attention', '⑩ 导出 keywords');
    eq(JSON.stringify(s0.sources), '["arxiv","openalex"]', '⑩ 导出 sources');
    eq(s0.freq, 'daily', '⑩ 导出 freq');
    eq(s0.dailyTime, '08:00', '⑩ 导出 dailyTime');
    eq(s0.max, 12, '⑩ 导出 max');
    eq(s0.autoImport, false, '⑩ 导出 autoImport');
    eq(s0.enabled, true, '⑩ 导出 enabled');

    /* 坏输入：一律 ok:false + error，不抛 */
    const badJson = env.S.importJson('{oops');
    eq(badJson.ok, false, '⑩ 坏 JSON → ok:false');
    eq(badJson.error, 'parse_failed', '⑩ 坏 JSON → parse_failed');
    eq(badJson.added, 0, '⑩ 坏 JSON 不新增');
    eq(env.S.importJson('').error, 'empty', '⑩ 空串 → empty');
    eq(env.S.importJson('{"a":1}').error, 'bad_shape', '⑩ 结构不认识 → bad_shape');
    eq(env.S.list().length, 1, '⑩ 坏输入不写订阅');

    /* 裸数组：字段保真 + 重新分配 id + 运行态清零 */
    const raw = [{
      name: '导入订阅', keywords: 'graph neural network', categories: '', sources: ['openalex', 'arxiv'],
      mode: 'any', exclude: 'survey', maxAgeDays: 14, freq: 'weekly', dailyTime: '9:05',
      weekdays: [1, 3], max: 7, autoImport: false, aiRerank: true, aiDigest: true, seedProfile: true,
      enabled: false,
      id: 'sub-hacked', lastRun: '2026-01-01', lastStatus: '旧机器状态',
      runLog: [{ at: '2026-01-01 08:00', added: 3, skipped: 0, failed: 0, trigger: 'daily', reason: '' }],
      createdAt: 1,
    }];
    const r1 = env.S.importJson(JSON.stringify(raw));
    eq(r1.ok, true, '⑩ 裸数组可导入');
    eq(r1.added, 1, '⑩ 裸数组 added=1');
    eq(r1.skipped, 0, '⑩ 裸数组 skipped=0');
    eq(env.S.list().length, 2, '⑩ 导入后订阅数 +1');

    const imp = env.S.list()[0];
    eq(imp.name, '导入订阅', '⑩ 导入 name');
    ok(imp.id !== 'sub-hacked', '⑩ ★ 重新分配 id（不沿用外来 id）');
    ok(/^sub-[0-9a-z]+$/.test(imp.id), '⑩ 新 id 形如 sub-<ts36>', imp.id);
    eq(imp.lastRun, '', '⑩ ★ 导入清零 lastRun');
    eq(imp.lastStatus, '', '⑩ ★ 导入清零 lastStatus');
    eq(JSON.stringify(imp.runLog), '[]', '⑩ ★ 导入清零 runLog');
    ok(Number(imp.createdAt) > 1000000000000, '⑩ createdAt 重新写入', imp.createdAt);
    eq(JSON.stringify(imp.sources), '["openalex","arxiv"]', '⑩ 导入 sources 保真');
    eq(imp.mode, 'any', '⑩ 导入 mode 保真');
    eq(imp.exclude, 'survey', '⑩ 导入 exclude 保真');
    eq(imp.maxAgeDays, 14, '⑩ 导入 maxAgeDays 保真');
    eq(imp.freq, 'weekly', '⑩ 导入 freq 保真');
    eq(imp.dailyTime, '09:05', '⑩ 导入 dailyTime 归一');
    eq(JSON.stringify(imp.weekdays), '[1,3]', '⑩ 导入 weekdays 保真');
    eq(imp.max, 7, '⑩ 导入 max 保真');
    eq(imp.autoImport, false, '⑩ 导入 autoImport 保真');
    eq(imp.aiRerank, true, '⑩ 导入 aiRerank 保真');
    eq(imp.aiDigest, true, '⑩ 导入 aiDigest 保真');
    eq(imp.seedProfile, true, '⑩ 导入 seedProfile 保真');
    eq(imp.enabled, false, '⑩ 导入 enabled 保真');
    eq(Object.keys(env.seen() || {}).length, 0, '⑩ ★ 导入不写 seen');

    /* 同名 → 跳过 */
    const r2 = env.S.importJson(JSON.stringify(raw));
    eq(r2.ok, true, '⑩ 重复导入仍 ok');
    eq(r2.added, 0, '⑩ ★ 同名订阅被跳过');
    eq(r2.skipped, 1, '⑩ 同名计入 skipped');
    eq(env.S.list().length, 2, '⑩ 跳过时不新增');

    /* 包裹格式 + 无效条目（无名 / 无检索条件） */
    const wrap = {
      app: 'papilot', kind: 'searchSubscriptions', version: 2,
      subscriptions: [
        { name: '', keywords: 'x' },
        { name: '只有名字' },
        { name: '包裹订阅', categories: 'cs.CL' },
      ],
    };
    const r3 = env.S.importJson(JSON.stringify(wrap));
    eq(r3.ok, true, '⑩ 包裹格式可导入');
    eq(r3.added, 1, '⑩ 只导入合法条目');
    eq(r3.skipped, 2, '⑩ 无名 / 无条件条目被跳过');
    eq(env.S.list().length, 3, '⑩ 合法条目落库');

    /* 夹带说明文字也能捞出来（用户从聊天窗口粘贴常见） */
    const noisy = env.S.importJson('订阅如下：\n' + JSON.stringify([{ name: '夹带订阅', keywords: 'diffusion' }]) + '\n以上。');
    eq(noisy.ok, true, '⑩ 夹带说明文字仍可解析');
    eq(noisy.added, 1, '⑩ 夹带文本导入成功');
  }

  /* ================== ⑪ 启动自检（纯本地、不写 pref、不抛） ================== */

  {
    const env = makeEnv();
    const r = env.S.selfTest();
    eq(typeof r, 'string', '⑪ selfTest 返回字符串');
    ok(r.indexOf('ok ') === 0, '⑪ ★ selfTest 以 "ok " 开头', r);
    has(r, 'fp=1', '⑪ DOI 指纹归一通过');
    has(r, 'mig=1', '⑪ v1 订阅迁移通过（sources/freq/enabled）');
    has(r, 'week=1', '⑪ weekly 计划日通过');
    has(r, 'ttl=1', '⑪ 推荐缓存 TTL 通过');
    eq(env.S.RECO_TTL_MS, 12 * 3600 * 1000, '⑪ 推荐缓存 12 小时');
    eq(env.S.PREF_RECO_CACHE, 'searchSubsRecoCache', '⑪ 缓存 pref 名');
    eq(env.store.size, 0, '⑪ ★ selfTest 不写任何 pref');
    eq(env.errors.length, 0, '⑪ selfTest 不抛（未走 logError）');
  }

  /* ================== ⑫ 0.58.0：作者追踪（模型 / 归一 / 迁移 / 导出） ================== */

  {
    const env = makeEnv();
    const S = env.S;

    eq(JSON.stringify(S._normAuthors('Ada Lovelace, ada lovelace; Turing\nB,  A ')),
      '["Ada Lovelace","Turing"]', '⑫ 作者串：逗号/分号/换行切分 + 去重 + 丢单字符');
    eq(JSON.stringify(S._normAuthors('')), '[]', '⑫ 空作者 → 空数组');
    eq(S._normAuthors('A1, B2, C3, D4, E5, F6, G7').length, 6, '⑫ ★ 作者最多 6 个');
    eq(JSON.stringify(S._normAuthors(['Alan Turing', 'alan turing'])), '["Alan Turing"]', '⑫ 数组输入也归一');

    const a = S.add({ name: '追踪作者', authors: 'Ada Lovelace, Alan Turing' });
    ok(!!a, '⑫ ★ 只填作者也能建订阅');
    eq(a.authors, 'Ada Lovelace, Alan Turing', '⑫ authors 归一落库');
    eq(a.notify, true, '⑫ notify 缺省为 true');
    eq(a.keywords, '', '⑫ 纯作者订阅关键词为空');

    const legacy = S._normSub({ id: 'sub-old', name: '旧订阅', keywords: 'x' });
    eq(legacy.authors, '', '⑫ 旧订阅 authors 为空串（迁移安全）');
    eq(legacy.notify, true, '⑫ 旧订阅 notify 默认 true');

    eq(S.add({ name: '空条件', keywords: '', categories: '', authors: ' , ; ' }), null,
      '⑫ 关键词/分类/作者全空 → 拒绝');

    const u = S.update(a.id, { keywords: '', categories: '' });
    ok(!!u, '⑫ update 清空关键词后作者仍支撑订阅');
    eq(u.authors, 'Ada Lovelace, Alan Turing', '⑫ update 保留作者');
    eq(S.update(a.id, { authors: '', keywords: '', categories: '' }), null, '⑫ update 三者全清 → 拒绝');
    eq(S.update(a.id, { notify: false }).notify, false, '⑫ notify 可关闭');

    has(S._condLine(S._normSub({ id: 's', keywords: 'x', authors: 'Ada Lovelace' })),
      '作者：Ada Lovelace', '⑫ 条件行含「作者：…」');

    const obj = JSON.parse(S.exportJson());
    eq(obj.subscriptions[0].authors, 'Ada Lovelace, Alan Turing', '⑫ ★ 导出带 authors');
    eq(obj.subscriptions[0].notify, false, '⑫ ★ 导出带 notify（关了通知，导入后不会又变开）');
    eq(S._statusText('ignored'), '已忽略', '⑫ ignored 状态文案');
  }

  /* ================== ⑬ 0.58.0：收藏 / 忽略反馈学习 ================== */

  /* ⑬-1 记录与调分 */
  {
    const env = makeEnv();
    const S = env.S;

    const rec = S._feedbackPut(entry(1), 1, 'sub-1');
    ok(!!rec, '⑬ _feedbackPut 写入成功');
    eq(rec.v, 1, '⑬ 收藏记 v=1');
    ok(rec.terms.length > 0 && rec.terms.length <= 6, '⑬ terms 记录 ≤6 个词元', rec.terms);
    eq(JSON.stringify(rec.authors), '["ada lovelace","alan turing"]', '⑬ ★ authors 归一为小写姓名');
    eq(rec.sub, 'sub-1', '⑬ 记录来源订阅');
    eq(S._feedbackPut({ title: '   ' }, 1), null, '⑬ 空指纹不记（无脏数据）');

    const got = S.feedbackOf(entry(1));
    ok(!!got && got.v === 1, '⑬ feedbackOf 按指纹取回');
    eq(S.feedbackOf(entry(2)), null, '⑬ 未反馈的条目 → null');
    eq(S.isIgnored(entry(1)), false, '⑬ 收藏项不算忽略');

    const adj = S._feedbackAdjust(entry(1));
    eq(adj.score, 2, '⑬ ★ 收藏反馈加分上限 +2');
    ok(adj.reasons.indexOf('ada lovelace') >= 0, '⑬ 加分理由含命中作者', adj.reasons);

    const other = Object.assign({}, entry(9), {
      title: 'Quantum chemistry', summary: 'Molecules and bonds', authors: ['Someone Else'],
    });
    eq(S._feedbackAdjust(other).score, 0, '⑬ 无关条目不因反馈加分');
    S._feedbackPut(other, -1);
    ok(S._feedbackAdjust(other).score < 0, '⑬ ★ 忽略反馈 → 负分', S._feedbackAdjust(other).score);
    eq(S.isIgnored(other), true, '⑬ isIgnored 命中 v=-1');

    // 坏 pref：不抛、不误判
    env.store.set(PREFIX + 'searchSubsFeedback', '{oops');
    eq(JSON.stringify(S._feedbackLoad()), '{}', '⑬ 坏反馈 JSON → 空 map（不抛）');
    eq(S._feedbackAdjust(entry(1)).score, 0, '⑬ 反馈不可用时调分为 0');
  }

  /* ⑬-2 accept：入库 + 记 +1 + 写 seen + 清缓存；已在库时复用条目 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1', name: '订阅一' })]) },
      arxiv: makeArxiv([entry(1), entry(2)]),
    });
    const p = await env.S.preview('sub-1', { now: AT, limit: 10 });
    eq(p.entries[0].status, 'new', '⑬ 预览初始状态为 new');
    const target = p.entries.filter((x) => x.title === 'Paper 1')[0];
    ok(!!target, '⑬ 预览返回 Paper 1');
    env.store.set(PREFIX + 'searchSubsRecoCache', JSON.stringify({ at: Date.now(), items: [{ id: 'x' }] }));

    const r = await env.S.accept(target, 'sub-1');
    eq(r.ok, true, '⑬ ★ accept 成功');
    eq(r.existed, false, '⑬ 首次收藏不是「已存在」');
    ok(r.itemID != null, '⑬ accept 返回 itemID');
    eq(env.items.length, 1, '⑬ accept 建了 1 个条目');
    eq(env.items[0].fields.title, 'Paper 1', '⑬ 入库标题正确');
    eq(JSON.stringify(env.items[0].tags), JSON.stringify(['#订阅/订阅一']), '⑬ 条目带来源订阅标签');
    eq(env.feedback()['arXiv:2501.00001'].v, 1, '⑬ ★ 写入 +1 反馈');
    ok(env.seen()['arXiv:2501.00001'] && env.seen()['arXiv:2501.00001'].itemID === r.itemID,
      '⑬ ★ 收藏写 seen（含 itemID）');
    eq(env.prefs('searchSubsRecoCache'), '', '⑬ 收藏后推荐缓存清空');

    // ★ 无 DOI 条目连点两次收藏：第二次必须识别为「已存在」，不能再入库一条
    const again = await env.S.accept(target, 'sub-1');
    eq(again.ok, true, '⑬ ★ 同一无 DOI 条目再收藏一次仍 ok');
    eq(again.existed, true, '⑬ ★ 第二次收藏识别为已存在（seen + getAsync 查重）');
    eq(again.itemID, r.itemID, '⑬ 复用第一次的 itemID');
    eq(env.items.length, 1, '⑬ ★ 连点两次只入库 1 条');
    eq(env.feedback()['arXiv:2501.00001'].v, 1, '⑬ 重复收藏不改变反馈（仍是 +1）');
  }
  {
    // seen 记账里的条目已被用户删除 → 视为未收藏，照常新建（不能因为记账卡住）
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubsSeen']: JSON.stringify({ 'arXiv:2502.00009': { at: 1, itemID: 999 } }),
      },
    });
    const r = await env.S.accept({
      source: 'arxiv', title: 'Gone Already', arxivId: '2502.00009', summary: 'x', authors: ['A B'],
    });
    eq(r.ok, true, '⑬ 记账条目已删除 → 仍可收藏');
    eq(r.existed, false, '⑬ ★ 取不到条目视为已删除（走新建）');
    eq(env.items.length, 1, '⑬ 重建 1 条');
    ok(r.itemID !== 999, '⑬ 新条目 id 不是失效的记账 id', r.itemID);
  }
  {
    const env = makeEnv({ byDoi: (d) => (d.toLowerCase() === '10.5/accepted' ? { id: 777 } : null) });
    const e = {
      source: 'crossref', title: 'Already There', summary: 'about sparse things',
      doi: '10.5/ACCEPTED', authors: ['Grace Hopper'], published: '2026-09-01',
    };
    const r = await env.S.accept(e, null);
    eq(r.ok, true, '⑬ 已在库也能收藏（不报错）');
    eq(r.existed, true, '⑬ ★ existed=true');
    eq(r.itemID, 777, '⑬ 复用已有条目 id');
    eq(env.items.length, 0, '⑬ 已在库不重复建条目');
    ok(!!env.feedback()['doi:10.5/accepted'], '⑬ 已在库仍记 +1 反馈');
    ok(env.seen()['doi:10.5/accepted'], '⑬ 已在库也写 seen（itemID 可能为空）');

    const env2 = makeEnv();
    env2.failNext();
    const bad = await env2.S.accept({ source: 'arxiv', title: 'Boom', arxivId: '2502.00001', summary: 'x' });
    eq(bad.ok, false, '⑬ ★ 入库失败 → ok:false（不抛给面板）');
    eq(JSON.stringify(env2.feedback()), '{}', '⑬ 失败不写反馈（不留脏数据）');
  }

  /* ⑬-3 ignore：预览标 ignored、run 跳过且不入库不记账 */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1', name: '订阅一' })]) },
      arxiv: makeArxiv([entry(1), entry(2)]),
    });
    ok(env.S.ignoreEntry(entry(2), 'sub-1'), '⑬ ignoreEntry 写入成功');
    eq(env.feedback()['arXiv:2501.00002'].v, -1, '⑬ 忽略记 v=-1');
    eq(env.prefs('searchSubsRecoCache'), '', '⑬ 忽略后推荐缓存清空');

    const p = await env.S.preview('sub-1', { now: AT, limit: 10 });
    eq(p.ok, true, '⑬ 忽略项仍出现在预览里（用户能看见自己忽略过）');
    const ig = p.entries.filter((x) => x.status === 'ignored');
    eq(ig.length, 1, '⑬ ★ 忽略项状态为 ignored');
    eq(ig[0].title, 'Paper 2', '⑬ 被忽略的是指定条目');
    eq(p.entries.filter((x) => x.status === 'new').length, 1, '⑬ 其余条目仍是 new');

    const r = await env.S.run('sub-1', { now: AT, trigger: 'manual' });
    eq(r.ok, true, '⑬ run 正常完成');
    eq(r.added, 1, '⑬ ★ 忽略项不入库（只入库另一条）');
    eq(r.skipped, 1, '⑬ ★ 忽略项计入 skipped');
    eq(env.items.length, 1, '⑬ 实际只建了 1 个条目');
    eq(env.seen()['arXiv:2501.00002'], undefined, '⑬ ★ 忽略项不写 seen（改主意还能再收到）');
    notHas(env.notes[0].html, 'Paper 2', '⑬ ★ 速递里不再出现被忽略的条目（连标题都不占位）');
    has(env.notes[0].html, 'Paper 1', '⑬ 速递只列真正的新命中');
  }

  /* ⑬-4 统计 / 清空 */
  {
    const env = makeEnv();
    env.S._feedbackPut(entry(1), 1);
    env.S._feedbackPut(entry(2), -1);
    const st = env.S.feedbackStats();
    eq(st.liked, 1, '⑬ 统计收藏数');
    eq(st.ignored, 1, '⑬ 统计忽略数');

    env.store.set(PREFIX + 'searchSubsRecoCache', JSON.stringify({ at: Date.now(), items: [{ id: 'x' }] }));
    ok(env.S.feedbackClear(), '⑬ ★ feedbackClear 成功');
    eq(env.prefs('searchSubsFeedback'), '', '⑬ 反馈已清空');
    eq(env.prefs('searchSubsRecoCache'), '', '⑬ 清空反馈同时作废推荐缓存');
    eq(env.S.feedbackStats().liked, 0, '⑬ 清空后统计归零');
    eq(JSON.stringify(env.S._feedbackLoad()), '{}', '⑬ 清空后 map 为空');
  }

  /* ⑬-5 ★ 忽略项不占 max 名额（修复：先剔 ignored 再截断） */
  {
    const ig = entry(1, {
      title: 'Sparse attention ignored', summary: 'Abstract ignored', authors: ['Ada Lovelace'],
      publishedDay: '2026-10-17', published: '2026-10-17T00:00:00Z',
    });
    const fresh = entry(2, {
      title: 'Brand new paper', summary: 'Nothing to see', authors: ['Someone Else'],
      publishedDay: '2025-05-01', published: '2025-05-01T00:00:00Z',
    });
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([
          sub({ id: 'sub-1', name: '名额订阅', keywords: 'attention', max: 1 }),
        ]),
      },
      arxiv: makeArxiv([ig, fresh]),
    });
    ok(env.S.ignoreEntry(ig, 'sub-1'), '⑬ 先忽略第一条');
    // 忽略项本身打分更高（标题含关键词 + 新鲜度），修复前会把唯一名额占掉
    const subNorm = env.S._normSub(env.subs()[0]);
    const ranked = env.S._rank([env.S._normEntry(ig), env.S._normEntry(fresh)], subNorm, AT.getTime());
    eq(ranked[0].title, 'Sparse attention ignored', '⑬ 前提：忽略项排序在前（否则测不到名额问题）');

    const r = await env.S.run('sub-1', { now: AT });
    eq(r.ok, true, '⑬ 名额场景 run ok');
    eq(r.added, 1, '⑬ ★ 忽略项不占 max 名额（新条目仍入库）');
    eq(r.skipped, 1, '⑬ 被剔除的忽略项计入 skipped');
    eq(env.items.length, 1, '⑬ 只入库 1 条');
    eq(env.items[0].fields.title, 'Brand new paper', '⑬ ★ 入库的是新条目，不是被忽略的那条');
  }

  /* ================== ⑭ 0.58.0：系统通知（定时才弹 / 手动不弹 / 可关） ================== */

  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1', name: '通知订阅', dailyTime: '07:30' })]),
      },
      arxiv: makeArxiv([entry(1)]),
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["sub-1"]', '⑭ 定时触发一次');
    eq(env.pws.length, 1, '⑭ ★ 定时运行有新入库 → 弹系统通知');
    eq(env.pws[0].headline, 'Papilot 检索订阅', '⑭ 通知标题');
    has(env.pws[0].lines[0] || '', '通知订阅', '⑭ 通知正文含订阅名');
    has(env.pws[0].lines[0] || '', '新增 1 篇', '⑭ 通知正文含新增数');
    has(env.pws[0].lines[1] || '', '订阅速递', '⑭ 通知第二行是速递标题');
    eq(env.pws[0].shown, 1, '⑭ 真的 show()');
    eq(env.pws[0].closeMs, 8000, '⑭ 8 秒后自动关闭');
    eq(env.pws[0].opts.closeOnClick, true, '⑭ 点击即关闭');
  }
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const r = await env.S.run('sub-1', { now: AT, trigger: 'manual' });
    eq(r.added, 1, '⑭ 手动运行入库 1 条');
    eq(env.pws.length, 0, '⑭ ★ 手动运行不弹通知（用户就在面板前）');
  }
  {
    // 缺省 trigger（内部 / 测试调用）也必须按 manual 处理，不能误弹
    const env = makeEnv({
      prefs: { [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1' })]) },
      arxiv: makeArxiv([entry(1)]),
    });
    const r = await env.S.run('sub-1', { now: AT });
    eq(r.added, 1, '⑭ 未传 trigger 的运行仍正常入库');
    eq(env.pws.length, 0, '⑭ ★ 不传 trigger 视为 manual → 不弹通知');
    eq(env.subs()[0].runLog[0].trigger, 'manual', '⑭ 运行历史把缺省 trigger 记为 manual');
  }
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1', notify: false, dailyTime: '07:30' })]),
      },
      arxiv: makeArxiv([entry(1)]),
    });
    await env.S.checkDue(AT);
    eq(env.pws.length, 0, '⑭ ★ notify=false 不弹通知');
  }
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([sub({ id: 'sub-1', dailyTime: '07:30' })]),
        [PREFIX + 'searchSubsSeen']: JSON.stringify({ 'arXiv:2501.00001': { at: 1 } }),
      },
      arxiv: makeArxiv([entry(1)]),
    });
    await env.S.checkDue(AT);
    eq(env.pws.length, 0, '⑭ 没有新增就不弹通知');
  }
  {
    // 直接调 _notify：notify=false / 无订阅对象 → 静默返回 false（绝不抛）
    const env = makeEnv();
    eq(env.S._notify({ name: 'x', notify: true }, 3, ''), true, '⑭ 正常情形 _notify 返回 true');
    eq(env.S._notify({ name: 'x', notify: false }, 3, ''), false, '⑭ notify=false 时 _notify 直接返回 false');
    eq(env.S._notify(null, 3, ''), false, '⑭ 无订阅对象 → 不弹');
  }

  /* ================== ⑮ 0.58.0：推荐里的作者轨道 ================== */

  {
    function authorItem(title, creators, cats, daysAgo) {
      const it = libItem(title, ['t'], cats, daysAgo);
      it.getCreators = () => creators.map((n) => {
        const parts = String(n).split(' ');
        return {
          firstName: parts.slice(0, -1).join(' '),
          lastName: parts[parts.length - 1],
          creatorType: 'author',
        };
      });
      return it;
    }
    const items = [
      authorItem('Sparse attention for long context', ['Ada Lovelace', 'Alan Turing'], ['cs.LG'], 10),
      authorItem('Sparse attention efficiency', ['Ada Lovelace'], ['cs.LG'], 40),
      authorItem('Unrelated biology work', ['Grace Hopper'], ['q-bio.NC'], 200),
    ];
    const discovery = {
      collectLibraryItems: async () => items,
      buildProfile: () => ({ terms: [{ term: 'sparse' }, { term: 'attention' }], categories: ['cs.LG'], scanned: 3 }),
      extractArxiv: (it) => ({ categories: it._cats }),
      tokenize: (s) => String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean),
    };
    const env = makeEnv({ discovery });
    const list = await env.S.suggest({ max: 3, now: AT });
    const authorCand = list.filter((x) => x.kind === 'author')[0];
    ok(!!authorCand, '⑮ ★ 产出作者追踪候选', list.map((x) => x.kind));
    if (authorCand) {
      eq(authorCand.authors, 'Ada Lovelace', '⑮ 作者候选填 authors');
      has(authorCand.name, '追踪作者：Ada Lovelace', '⑮ 作者候选命名');
      has(authorCand.reason, '库内 2 篇由该作者参与', '⑮ 作者候选理由给篇数');
      eq(typeof authorCand.keywords, 'string', '⑮ 作者候选关键词可为空串');
      ok(authorCand.sources.indexOf('arxiv') >= 0, '⑮ 作者候选带默认来源');
    }

    const env2 = makeEnv({
      discovery,
      prefs: {
        [PREFIX + 'searchSubscriptions']: JSON.stringify([
          sub({ id: 'sub-1', name: '已有作者订阅', keywords: 'x', authors: 'ada lovelace' }),
        ]),
      },
    });
    const list2 = await env2.S.suggest({ max: 3, now: AT });
    ok(!list2.some((x) => x.kind === 'author'), '⑮ ★ 已订阅该作者 → 不再推荐');

    const env3 = makeEnv({ discovery });
    env3.S.ignoreEntry({
      source: 'arxiv', title: 'Any', summary: 'x', authors: ['Ada Lovelace'], arxivId: '2503.00001',
    }, null);
    const list3 = await env3.S.suggest({ max: 3, now: AT });
    ok(!list3.some((x) => x.kind === 'author'), '⑮ ★ 被忽略过的作者不再推荐');
  }

} // main

/* ---------------- 汇总 ---------------- */

main().then(function () {
  report();
}).catch(function (e) {
  console.error('✗ 测试执行异常：' + (e && (e.stack || e.message) || e));
  process.exit(1);
});

function report() {
  if (fails.length) {
    console.error('\n✗ 检索订阅测试失败 ' + fails.length + ' 项 / ' + (pass + fails.length) + ' 项断言');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 检索订阅测试通过：' + pass + ' 项断言');
}
