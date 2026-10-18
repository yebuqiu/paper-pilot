#!/usr/bin/env node
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
const PREFIX = 'extensions.zotero.paperpilot.';

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

  const Zotero = {
    locale: 'zh-CN',
    Prefs: {
      get(k) { return store.has(k) ? store.get(k) : undefined; },
      set(k, v) { store.set(k, v); },
    },
    Libraries: { userLibraryID: 1 },
    Items: {
      getByDOI(doi) { return opts.byDoi ? opts.byDoi(doi) : null; },
    },
    Item: FakeItem,
    PaperPilot: {
      diags: [],
      _diag(msg) { Zotero.PaperPilot.diags.push(String(msg)); return Promise.resolve(); },
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

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'search-subs.js' });

  return {
    S: sandbox.SearchSubs,
    store: store,
    items: items,
    notes: notes,
    intervals: intervals,
    errors: errors,
    diags: Zotero.PaperPilot.diags,
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
