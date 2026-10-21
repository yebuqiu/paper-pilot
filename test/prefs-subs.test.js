#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 检索订阅设置面板 · 迷你 DOM 烟测（prefs-subs.js）
 *
 * 动机：v2 面板有四段交互（推荐 / 一句话 / 试跑 / 表单），而这类代码的失败
 * 几乎都是**静默**的——事件没绑上（点了没反应）、动态节点用了 $(动态 id) 取到 null、
 * 预览结果渲染时抛错被 promise 吞掉。单元测试只测核心域，发现不了这些。
 *
 * 这里用迷你 DOM 真跑 prefs-subs.js，桩掉 SearchSubs 与 Zotero，断言：
 *   ① 列表 / 推荐卡真的渲染出来；
 *   ② 点「预览」→ 调 preview 且结果画进 #pp-subs-detail；
 *   ③ 点「保存」→ 把表单字段（含多源、模式、频率）交给 add；
 *   ④ 一句话 → aiParseQuery，解析结果回填表单并自动试跑；
 *   ⑤ 静态体检：脚本里所有 $("id") 都能在 prefs.xhtml 找到对应节点
 *      （少一个 = 那块功能静默消失）。
 *
 * 运行：node test/prefs-subs.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'prefs-subs.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');

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
    this.tag = String(tag);
    this.children = [];
    this.style = {};
    this._attrs = {};
    this.className = '';
    this.id = '';
    this.handlers = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this._text = '';
    this.parentNode = null;
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
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get firstChild() { return this.children[0] || null; }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  fire(e, a) { for (const f of (this.handlers[e] || []).slice()) f(a || {}); }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v == null ? '' : v);
    this.children = [];
  }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  matches(sel) {
    const s = String(sel).trim();
    if (s.startsWith('.')) return (' ' + this.className + ' ').indexOf(' ' + s.slice(1) + ' ') >= 0;
    return this.tag === s;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
}

const IDS = [
  'pp-sub-journal-q', 'pp-sub-journal-search', 'pp-sub-journal-msg',
  'pp-sub-journal-subjects', 'pp-sub-journal-list', 'pp-sub-journal-subscribe', 'pp-sub-journal-sel',
  'pp-sub-journals', 'pp-sub-journals-clear',
  'pp-subs-reco', 'pp-subs-reco-refresh', 'pp-subs-reco-msg',
  'pp-sub-nl', 'pp-sub-ai', 'pp-sub-nl-msg',
  'pp-subs-list', 'pp-subs-detail', 'pp-subs-form-title',
  'pp-subs-export', 'pp-subs-import', 'pp-subs-feedback-clear',
  'pp-sub-name', 'pp-sub-keywords', 'pp-sub-cats', 'pp-sub-authors', 'pp-sub-exclude',
  'pp-sub-mode', 'pp-sub-freq', 'pp-sub-time', 'pp-sub-weekdays',
  'pp-sub-maxagedays', 'pp-sub-max',
  'pp-sub-src-arxiv', 'pp-sub-src-openalex', 'pp-sub-src-crossref', 'pp-sub-src-europepmc', 'pp-sub-src-pubmed',
  'pp-sub-auto', 'pp-sub-notify', 'pp-sub-ai-rerank', 'pp-sub-ai-digest', 'pp-sub-seed',
  'pp-subs-add', 'pp-subs-preview', 'pp-subs-cancel', 'pp-sub-msg',
];

function makeDom() {
  const byId = new Map();
  for (const id of IDS) {
    const tag = id === 'pp-sub-mode' || id === 'pp-sub-freq' ? 'select'
      : /pp-sub-src-|pp-sub-auto|pp-sub-ai-|pp-sub-seed|pp-sub-journal-q$|pp-sub-journals$/.test(id) ? 'input' : 'div';
    const n = new El(tag);
    n.id = id;
    if (id === 'pp-subs-list') n.setAttribute('class', 'pp-datasets');
    byId.set(id, n);
  }
  return {
    byId,
    document: {
      getElementById: (id) => byId.get(id) || null,
      createElementNS: (ns, tag) => new El(tag),
    },
  };
}

function stubSubs(calls, opts) {
  const o = opts || {};
  const JOURNALS = [
    {
      name: 'The Lancet', issn: '0140-6736', subject: 'med', subjectName: '临床医学',
      publisher: 'Elsevier', aliases: ['柳叶刀'], hot: true, online: false,
    },
    {
      name: 'Nature', issn: '0028-0836', subject: 'multi', subjectName: '综合',
      publisher: '', aliases: ['自然'], hot: true, online: false,
    },
  ];
  const sub = {
    id: 'sub-1', name: '稀疏注意力', keywords: 'sparse attention', categories: 'cs.LG',
    authors: 'Ada Lovelace', notify: false,
    sources: ['arxiv'], mode: 'any', exclude: '', maxAgeDays: 7, freq: 'daily', dailyTime: '08:00',
    weekdays: [1, 2, 3, 4, 5], max: 10, autoImport: true, aiRerank: false, aiDigest: false,
    enabled: true, lastStatus: '2026-10-19 08:00 · +1 新入库 / 0 跳过',
    runLog: [{ at: '2026-10-19 08:00', added: 1, skipped: 0, failed: 0, trigger: 'daily', reason: '' }],
  };
  return {
    list: () => [sub],
    add: (o) => { calls.add.push(o); return Object.assign({}, sub, { id: 'sub-new', name: o.name }); },
    update: (id, patch) => { calls.update.push({ id, patch }); return Object.assign({}, sub, patch); },
    remove: () => true,
    run: async () => { calls.run.push(1); return { ok: true, added: 1, skipped: 0, failed: 0, noteTitle: 'x' }; },
    preview: async (input, opts) => {
      calls.preview.push({ input, opts });
      return {
        ok: true,
        entries: [
          { source: 'arxiv', title: 'Sparse Attention Works', published: '2026-10-18', summary: 'A paper', status: 'new', score: 7, url: 'https://arxiv.org/abs/1' },
          { source: 'openalex', title: 'Known Paper', published: '2026-10-17', summary: 'B paper', status: 'known', score: 2, url: '', citationCount: 5 },
          { source: 'crossref', title: 'Ignored Paper', published: '2026-10-16', summary: 'C paper', status: 'ignored', score: 1, url: '' },
        ],
        bySource: { arxiv: { ok: true, count: 1 }, openalex: { ok: false, count: 0, reason: 'HTTP 503' } },
        partial: true,
      };
    },
    suggest: async (sopts) => {
      calls.suggest.push(sopts || {});
      return [{
        id: 'reco-cat-1', name: '追踪 cs.LG', keywords: 'sparse, attention', categories: 'cs.LG',
        sources: ['arxiv', 'openalex'], mode: 'any', maxAgeDays: 14, coverage: 12, recent: 3,
        reason: '库内 12 篇属于 cs.LG',
      }, {
        id: 'reco-author-ada', name: '追踪作者：Ada Lovelace', keywords: '', categories: '',
        authors: 'Ada Lovelace', sources: ['arxiv', 'openalex'], mode: 'any', maxAgeDays: 14,
        coverage: 3, recent: 1, reason: '库内 3 篇由该作者参与', kind: 'author',
      }];
    },
    recoFromCache: () => !!o.recoCacheHit,
    exportToClipboard: async () => {
      calls.export.push(1);
      return { ok: true, count: 2 };
    },
    importFromClipboard: async () => {
      calls.import.push(1);
      return { ok: true, added: 1, skipped: 3 };
    },
    dismissReco: (id) => { calls.dismiss.push(id); return true; },
    accept: async (entry, subId) => {
      calls.accept.push({ entry, subId });
      return { ok: true, itemID: 42, existed: !!(o.acceptExisted) };
    },
    ignoreEntry: (entry, subId) => {
      calls.ignore.push({ entry, subId });
      return true;
    },
    feedbackClear: () => { calls.feedbackClear.push(1); return true; },
    feedbackStats: () => ({ liked: 2, ignored: 1 }),
    aiParseQuery: async (text) => {
      calls.ai.push(text);
      return {
        ok: true,
        input: { name: 'AI 草稿', keywords: 'sparse attention', categories: 'cs.CL', sources: ['arxiv', 'openalex'], mode: 'any', freq: 'daily', dailyTime: '08:00', maxAgeDays: 7, max: 10, autoImport: false },
        note: 'ok',
      };
    },
    // 期刊订阅（0.69.0）
    journalCatalog: () => ({
      subjects: [{ id: 'med', name: '临床医学' }, { id: 'multi', name: '综合' }],
      list: JOURNALS,
    }),
    journalFind: (q, fopts) => {
      calls.journalFind.push({ q: q, opts: fopts });
      const key = String(q || '').toLowerCase().trim();
      const items = key
        ? JOURNALS.filter((j) => (j.name + ' ' + j.aliases.join(' ') + ' ' + j.issn).toLowerCase().indexOf(key) >= 0)
        : JOURNALS.slice();
      // total 与 items 长度刻意不同：真实目录有 525 种，而 journalRows 只取前 200 条，
      // 提示「共 N 种」必须用 total（0.69.0 真机错报「共 200 种」的回归点）。
      // 只在空搜索词（默认首屏）时放大，避免影响搜索路径的其它断言。
      return { total: key ? items.length : (o.totalOverride || items.length), items: items.slice() };
    },
    journalSearch: async (q, sopts) => {
      calls.journalSearch.push({ q: q, opts: sopts });
      return { ok: true, items: [], localCount: 0, online: false, reason: '' };
    },
    journalSubscribed: (issn) => {
      calls.journalSubscribed.push(issn);
      return !!(o.subscribedIssn && o.subscribedIssn === issn);
    },
    subscribeJournals: (items) => {
      calls.subscribe.push(items);
      return {
        ok: true,
        created: (items || []).map((x) => ({ id: 'sub-new', name: x.name, issns: [x.issn] })),
        skipped: [],
      };
    },
  };
}

function run(opts) {
  const dom = makeDom();
  const calls = {
    add: [], update: [], preview: [], run: [], suggest: [], dismiss: [], ai: [], export: [], import: [],
    accept: [], ignore: [], feedbackClear: [],
    journalFind: [], journalSearch: [], subscribe: [], journalSubscribed: [],
  };
  const subs = stubSubs(calls, opts);
  const timers = [];
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  const confirms = [];

  const Zotero = {
    Prefs: { get: () => undefined, set: () => {} },
    Papilot: { searchSubs: subs },
    logError: (e) => rejections.push(e),
    launchURL: () => {},
    getMainWindow: () => ({ Zotero: { launchURL: () => {} } }),
  };
  const window = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  const Services = {
    prompt: {
      confirm(win, title, text) {
        confirms.push({ title, text });
        return !(opts && opts.denyConfirm);
      },
    },
  };
  const sandbox = {
    Zotero, window, document: dom.document, console, Services,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, Error, RegExp,
    parseInt, isNaN, isFinite,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'prefs-subs.js' });
  return {
    dom, calls, subs, timers, rejections, confirms,
    off: () => process.removeListener('unhandledRejection', onRej),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  /* ① 静态体检：脚本引用的每个 id 都必须在 prefs.xhtml 里存在 */
  {
    const src = fs.readFileSync(SRC, 'utf8');
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    const ids = [...new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
    ok(ids.length >= 10, '① 脚本引用的 id 数量合理', ids.length);
    const missing = ids.filter((id) => xhtml.indexOf('id="' + id + '"') < 0);
    eq(JSON.stringify(missing), '[]', '① ★ 所有 $("id") 都能在 prefs.xhtml 找到');
    // 这些 id 走数组循环（$() 的实参是变量），静态正则覆盖不到，单独点名
    for (const id of ['pp-subs-reco', 'pp-sub-nl', 'pp-sub-src-openalex', 'pp-sub-freq',
      'pp-sub-name', 'pp-sub-keywords', 'pp-sub-cats', 'pp-sub-exclude', 'pp-sub-time',
      'pp-sub-weekdays', 'pp-sub-maxagedays', 'pp-sub-max', 'pp-sub-auto',
      'pp-sub-ai-rerank', 'pp-sub-ai-digest', 'pp-sub-seed', 'pp-sub-mailto',
      'pp-subs-export', 'pp-subs-import']) {
      ok(xhtml.indexOf('id="' + id + '"') >= 0, '① prefs.xhtml 含 ' + id);
    }
  }

  /* ② 初始化：列表 + 推荐卡真的渲染 */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    const list = env.dom.byId.get('pp-subs-list');
    ok(list.children.length > 0, '② 订阅列表渲染出行');
    ok(list.textContent.indexOf('稀疏注意力') >= 0, '② 行内显示订阅名');
    ok(list.textContent.indexOf('每日 08:00') >= 0, '② 行内显示频率');
    const reco = env.dom.byId.get('pp-subs-reco');
    ok(reco.children.length > 0, '② 推荐卡渲染');
    ok(reco.textContent.indexOf('追踪 cs.LG') >= 0, '② 推荐卡显示主题名');
    ok(reco.textContent.indexOf('cs.LG') >= 0, '② 推荐卡显示理由/分类');
    ok(reco.textContent.indexOf('作者：Ada Lovelace') >= 0, '② 推荐卡展示作者（0.58.0 作者轨道）');
    eq(env.rejections.length, 0, '② 初始化无未捕获异常');
    env.off();
  }

  /* ③ 点预览：调 preview 并把结果画进 detail */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    const list = env.dom.byId.get('pp-subs-list');
    const btn = list.querySelectorAll('.pp-subs-preview')[0];
    ok(!!btn, '③ 列表行有「预览」按钮');
    if (btn) {
      btn.fire('click');
      await tick();
      await tick();
    }
    eq(env.calls.preview.length, 1, '③ 点击调用 preview 一次');
    eq(env.calls.preview[0].input, 'sub-1', '③ 预览传入订阅 id');
    const detail = env.dom.byId.get('pp-subs-detail');
    ok(detail.children.length > 0, '③ 预览结果渲染到 detail');
    ok(detail.textContent.indexOf('Sparse Attention Works') >= 0, '③ 预览显示命中标题');
    ok(detail.textContent.indexOf('失败来源') >= 0, '③ 部分源失败有提示');
    eq(env.rejections.length, 0, '③ 预览流程无未捕获异常');
    env.off();
  }

  /* ④ 保存：表单字段（含多源 / 模式 / 频率）交给 add */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    env.dom.byId.get('pp-sub-name').value = '新主题';
    env.dom.byId.get('pp-sub-keywords').value = 'graph neural network';
    env.dom.byId.get('pp-sub-mode').value = 'any';
    env.dom.byId.get('pp-sub-freq').value = 'weekly';
    env.dom.byId.get('pp-sub-time').value = '07:30';
    env.dom.byId.get('pp-sub-weekdays').value = '1,3';
    env.dom.byId.get('pp-sub-maxagedays').value = '14';
    env.dom.byId.get('pp-sub-src-arxiv').checked = true;
    env.dom.byId.get('pp-sub-src-openalex').checked = true;
    env.dom.byId.get('pp-subs-add').fire('click');
    await tick();
    eq(env.calls.add.length, 1, '④ 点击保存调用 add');
    const a = env.calls.add[0] || {};
    eq(a.name, '新主题', '④ 名称');
    eq(a.keywords, 'graph neural network', '④ 关键词');
    eq(a.mode, 'any', '④ 布尔模式');
    eq(a.freq, 'weekly', '④ 频率');
    eq(a.dailyTime, '07:30', '④ 时间');
    eq(a.weekdays, '1,3', '④ 星期');
    eq(a.maxAgeDays, '14', '④ 时间窗');
    eq(JSON.stringify(a.sources), '["arxiv","openalex"]', '④ 多源');
    eq(env.dom.byId.get('pp-sub-name').value, '', '④ 保存后清空表单');
    eq(env.rejections.length, 0, '④ 保存流程无未捕获异常');
    env.off();
  }

  /* ⑤ 一句话 → AI 解析 → 回填 + 自动试跑 */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    env.dom.byId.get('pp-sub-nl').value = '追踪稀疏注意力';
    env.dom.byId.get('pp-sub-ai').fire('click');
    await tick();
    await tick();
    eq(env.calls.ai.length, 1, '⑤ 调用 aiParseQuery');
    eq(env.calls.ai[0], '追踪稀疏注意力', '⑤ 传入原话');
    eq(env.dom.byId.get('pp-sub-name').value, 'AI 草稿', '⑤ 回填名称');
    eq(env.dom.byId.get('pp-sub-keywords').value, 'sparse attention', '⑤ 回填关键词');
    eq(env.dom.byId.get('pp-sub-cats').value, 'cs.CL', '⑤ 回填分类');
    eq(env.dom.byId.get('pp-sub-src-openalex').checked, true, '⑤ 回填多源');
    eq(env.dom.byId.get('pp-sub-auto').checked, false, '⑤ AI 草稿默认不自动入库');
    eq(env.calls.preview.length, 1, '⑤ 解析后自动试跑');
    eq(env.calls.preview[0].input.name, 'AI 草稿', '⑤ 试跑用 AI 草稿');
    eq(env.rejections.length, 0, '⑤ AI 流程无未捕获异常');
    env.off();
  }

  /* ⑥ 忽略推荐 */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    const reco = env.dom.byId.get('pp-subs-reco');
    const btn = reco.querySelectorAll('button').filter((b) => b.textContent === '忽略')[0];
    ok(!!btn, '⑥ 推荐卡有「忽略」按钮');
    if (btn) btn.fire('click');
    eq(env.calls.dismiss.length, 1, '⑥ 忽略写入持久化');
    eq(env.calls.dismiss[0], 'reco-cat-1', '⑥ 忽略的是该推荐 id');
    env.off();
  }

  /* ⑦ 导出到剪贴板 */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    env.dom.byId.get('pp-subs-export').fire('click');
    await tick();
    await tick();
    eq(env.calls.export.length, 1, '⑦ 点击「导出到剪贴板」调用 exportToClipboard');
    const msg = env.dom.byId.get('pp-sub-msg').textContent;
    ok(msg.indexOf('已导出') >= 0, '⑦ 导出成功有提示', msg);
    ok(msg.indexOf('2 条订阅') >= 0, '⑦ 提示里带条数', msg);
    eq(env.rejections.length, 0, '⑦ 导出流程无未捕获异常');
    env.off();
  }

  /* ⑧ 从剪贴板导入 */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    env.dom.byId.get('pp-subs-import').fire('click');
    await tick();
    await tick();
    eq(env.calls.import.length, 1, '⑧ 点击「从剪贴板导入」调用 importFromClipboard');
    const msg = env.dom.byId.get('pp-sub-msg').textContent;
    ok(msg.indexOf('已导入 1 条') >= 0, '⑧ 导入结果写 added', msg);
    ok(msg.indexOf('跳过 3 条') >= 0, '⑧ 导入结果写 skipped', msg);
    ok(env.dom.byId.get('pp-subs-list').children.length > 0, '⑧ 导入后重绘订阅列表');
    eq(env.rejections.length, 0, '⑧ 导入流程无未捕获异常');
    env.off();
  }

  /* ⑨ 推荐：缓存提示 + 强制刷新 */
  {
    const cached = run({ recoCacheHit: true });
    for (const t of cached.timers.splice(0)) t.fn();
    await tick();
    const cmsg = cached.dom.byId.get('pp-subs-reco-msg').textContent;
    ok(cmsg.indexOf('来自最近一次分析（12 小时内）') >= 0, '⑨ 走缓存时提示来自最近一次分析', cmsg);
    eq(cached.calls.suggest[0].force, false, '⑨ 自动加载不强制重算');
    eq(cached.calls.suggest[0].max, 3, '⑨ 自动加载最多 3 条');
    cached.off();

    const fresh = run();
    for (const t of fresh.timers.splice(0)) t.fn();
    await tick();
    fresh.dom.byId.get('pp-subs-reco-refresh').fire('click');
    await tick();
    await tick();
    eq(fresh.calls.suggest.length, 2, '⑨ 点「重新分析」再次调用 suggest');
    eq(fresh.calls.suggest[1].force, true, '⑨ 重新分析传 force=true');
    ok(fresh.dom.byId.get('pp-subs-reco-msg').textContent.indexOf('已重新分析') >= 0,
      '⑨ 强制刷新提示已重新分析', fresh.dom.byId.get('pp-subs-reco-msg').textContent);
    eq(fresh.rejections.length, 0, '⑨ 推荐刷新无未捕获异常');
    fresh.off();
  }

  /* ⑩ 0.58.0：新控件的静态体检 */
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    for (const id of ['pp-sub-authors', 'pp-sub-notify', 'pp-subs-feedback-clear', 'pp-sub-openalex-key']) {
      ok(xhtml.indexOf('id="' + id + '"') >= 0, '⑩ prefs.xhtml 含 ' + id);
    }
    ok(xhtml.indexOf('preference="extensions.zotero.papilot.openAlexApiKey"') >= 0,
      '⑩ ★ OpenAlex Key 输入框绑定 pref');
    ok(/id="pp-sub-openalex-key"[^>]*type="password"|type="password"[^>]*id="pp-sub-openalex-key"/.test(xhtml),
      '⑩ Key 输入框用 password 类型（不明文回显）');
    const src = fs.readFileSync(SRC, 'utf8');
    ok(src.indexOf('关键词、分类、作者、期刊至少要有一个') >= 0, '⑩ 表单提示改为「关键词、分类、作者、期刊至少要有一个」');
    ok(src.indexOf('s.accept(') >= 0 && src.indexOf('s.ignoreEntry(') >= 0,
      '⑩ ★ 预览卡接了 accept / ignoreEntry');
    ok(src.indexOf('feedbackClear') >= 0 && src.indexOf('feedbackStats') >= 0,
      '⑩ 面板接了反馈清空 / 统计');
  }

  /* ⑪ 0.58.0：表单读写（作者 / 通知开关） */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    const editBtn = env.dom.byId.get('pp-subs-list').querySelectorAll('.pp-subs-edit')[0];
    ok(!!editBtn, '⑪ 列表行有「编辑」按钮');
    if (editBtn) editBtn.fire('click');
    eq(env.dom.byId.get('pp-sub-authors').value, 'Ada Lovelace', '⑪ ★ fillForm 回填 authors');
    eq(env.dom.byId.get('pp-sub-notify').checked, false, '⑪ ★ fillForm 回填 notify');
    eq(env.rejections.length, 0, '⑪ 编辑回填无未捕获异常');
    env.off();
  }
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    env.dom.byId.get('pp-sub-name').value = '作者订阅';
    env.dom.byId.get('pp-sub-authors').value = 'Ada Lovelace, Alan Turing';
    env.dom.byId.get('pp-sub-notify').checked = false;
    env.dom.byId.get('pp-subs-add').fire('click');
    await tick();
    eq(env.calls.add.length, 1, '⑪ ★ 只填作者也能保存（readForm 带 authors）');
    const a = env.calls.add[0] || {};
    eq(a.authors, 'Ada Lovelace, Alan Turing', '⑪ readForm 带 authors');
    eq(a.notify, false, '⑪ readForm 带 notify');
    eq(env.dom.byId.get('pp-sub-authors').value, '', '⑪ 保存后清空作者输入');
    eq(env.dom.byId.get('pp-sub-notify').checked, true, '⑪ 清空后通知默认勾选');
    eq(env.rejections.length, 0, '⑪ 保存流程无未捕获异常');
    env.off();
  }
  {
    // 三者全空 → 拦截保存（不调 add）
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    env.dom.byId.get('pp-sub-name').value = '空条件';
    env.dom.byId.get('pp-subs-add').fire('click');
    await tick();
    eq(env.calls.add.length, 0, '⑪ ★ 关键词/分类/作者全空 → 不调 add');
    ok(env.dom.byId.get('pp-sub-msg').textContent.indexOf('关键词、分类、作者、期刊至少要有一个') >= 0,
      '⑪ 提示文案说明四个条件之一（期刊是 0.69.0 新增轴）', env.dom.byId.get('pp-sub-msg').textContent);
    env.off();
  }

  /* ⑫ 0.58.0：预览卡的 [收藏] / [忽略] */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    const btn = env.dom.byId.get('pp-subs-list').querySelectorAll('.pp-subs-preview')[0];
    ok(!!btn, '⑫ 列表行有「预览」按钮');
    if (btn) {
      btn.fire('click');
      await tick();
      await tick();
    }
    const detail = env.dom.byId.get('pp-subs-detail');
    ok(detail.textContent.indexOf('已忽略') >= 0, '⑫ 忽略状态渲染为「已忽略」');
    ok(detail.textContent.indexOf('已忽略 1') >= 0, '⑫ 结果行统计忽略条数');

    const acceptBtn = detail.querySelectorAll('button').filter((b) => b.textContent === '收藏')[0];
    ok(!!acceptBtn, '⑫ ★ 预览卡有「收藏」按钮');
    if (acceptBtn) {
      acceptBtn.fire('click');
      await tick();
      await tick();
    }
    eq(env.calls.accept.length, 1, '⑫ ★ 收藏调用 accept');
    eq(env.calls.accept[0].subId, 'sub-1', '⑫ 收藏带上当前订阅 id');
    eq(env.calls.accept[0].entry.title, 'Sparse Attention Works', '⑫ 收藏的是该卡条目');
    ok(env.dom.byId.get('pp-sub-msg').textContent.indexOf('已收藏并记为感兴趣') >= 0,
      '⑫ 收藏有提示', env.dom.byId.get('pp-sub-msg').textContent);

    const ignoreBtn = detail.querySelectorAll('button').filter((b) => b.textContent === '忽略')[0];
    ok(!!ignoreBtn, '⑫ ★ 预览卡有「忽略」按钮');
    if (ignoreBtn) ignoreBtn.fire('click');
    eq(env.calls.ignore.length, 1, '⑫ ★ 忽略调用 ignoreEntry');
    eq(env.calls.ignore[0].entry.title, 'Sparse Attention Works', '⑫ 忽略的是该卡条目');
    ok(detail.textContent.indexOf('Sparse Attention Works') < 0, '⑫ ★ 忽略后该卡从预览里移除');
    ok(env.dom.byId.get('pp-sub-msg').textContent.indexOf('已忽略') >= 0, '⑫ 忽略有提示');
    eq(env.rejections.length, 0, '⑫ 收藏 / 忽略流程无未捕获异常');
    env.off();
  }

  /* ⑬ 0.58.0：清空反馈学习（二次确认） */
  {
    const env = run();
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    env.dom.byId.get('pp-subs-feedback-clear').fire('click');
    await tick();
    eq(env.calls.feedbackClear.length, 1, '⑬ ★ 点「清空反馈学习」调用 feedbackClear');
    eq(env.confirms.length, 1, '⑬ 清空前二次确认');
    ok((env.confirms[0] || {}).text && env.confirms[0].text.indexOf('2 条「收藏」') >= 0,
      '⑬ 确认文案带统计', (env.confirms[0] || {}).text);
    ok(env.dom.byId.get('pp-sub-msg').textContent.indexOf('已清空反馈学习') >= 0,
      '⑬ 清空后有提示（含 liked / ignored）', env.dom.byId.get('pp-sub-msg').textContent);
    eq(env.rejections.length, 0, '⑬ 清空流程无未捕获异常');
    env.off();

    const deny = run({ denyConfirm: true });
    for (const t of deny.timers.splice(0)) t.fn();
    await tick();
    deny.dom.byId.get('pp-subs-feedback-clear').fire('click');
    await tick();
    eq(deny.calls.feedbackClear.length, 0, '⑬ 取消确认则不执行清空');
    ok(deny.dom.byId.get('pp-sub-msg').textContent.indexOf('已取消') >= 0, '⑬ 取消有提示');
    deny.off();
  }

  /* ⑭ 0.69.0：按期刊订阅（目录渲染 / 中文搜索 / 单条与批量订阅 / 已订阅态） */
  {
    const env = run({ totalOverride: 525 });
    for (const t of env.timers.splice(0)) t.fn();
    await tick();

    const list = env.dom.byId.get('pp-sub-journal-list');
    ok(list.children.length >= 2, '⑭ 期刊列表渲染出行', list.children.length);
    ok(list.textContent.indexOf('The Lancet') >= 0, '⑭ 显示刊名');
    ok(list.textContent.indexOf('ISSN 0140-6736') >= 0, '⑭ 显示 ISSN（用户不用输入，但要能确认选对了）');
    ok(list.textContent.indexOf('临床医学') >= 0, '⑭ 显示学科');
    ok(list.textContent.indexOf('Elsevier') >= 0, '⑭ 显示出版社');
    // 0.69.1 回归（真机首次打开面板错报「共 200 种」）：提示要用真实 total，不能用被截断的行数
    ok(list.textContent.indexOf('共 525 种期刊') >= 0,
      '⑭ ★ 默认列表提示真实总数（不是被 limit 截断的条数）', list.textContent.slice(-56));

    const chips = env.dom.byId.get('pp-sub-journal-subjects');
    ok(chips.textContent.indexOf('全部') >= 0 && chips.textContent.indexOf('临床医学') >= 0, '⑭ 学科 chips 渲染');

    const rows = list.querySelectorAll('.pp-subs-jrow');
    eq(rows.length, 2, '⑭ 每种期刊一行');
    const lrow = rows.filter((r) => r.textContent.indexOf('The Lancet') >= 0)[0];
    const lbtn = lrow ? lrow.querySelectorAll('button')[0] : null;
    ok(!!lbtn && lbtn.textContent === '订阅', '⑭ 行内有「订阅」按钮');
    lbtn.fire('click');
    await tick();
    eq(env.calls.subscribe.length, 1, '⑭ ★ 点「订阅」直接创建（不需要先去表单填一遍）');
    eq((env.calls.subscribe[0] || [])[0].issn, '0140-6736', '⑭ 传入正确 ISSN');
    ok(env.dom.byId.get('pp-sub-journal-msg').textContent.indexOf('已订阅') >= 0,
      '⑭ 订阅后有反馈（说明默认频率）', env.dom.byId.get('pp-sub-journal-msg').textContent);

    // 批量：勾两个 → 订阅所选
    const boxes = list.querySelectorAll('input');
    ok(boxes.length >= 2, '⑭ 每行有勾选框');
    boxes[0].checked = true; boxes[0].fire('change');
    boxes[1].checked = true; boxes[1].fire('change');
    const bulk = env.dom.byId.get('pp-sub-journal-subscribe');
    eq(bulk.disabled, false, '⑭ 勾选后「订阅所选」可用');
    ok(env.dom.byId.get('pp-sub-journal-sel').textContent.indexOf('已选 2 种') >= 0,
      '⑭ 显示已选数量', env.dom.byId.get('pp-sub-journal-sel').textContent);
    bulk.fire('click');
    await tick();
    eq(env.calls.subscribe.length, 2, '⑭ 批量订阅再调一次');
    eq((env.calls.subscribe[1] || []).length, 2, '⑭ 批量传入 2 种期刊');

    // 中文别名搜索（防抖定时器手动执行）
    const q = env.dom.byId.get('pp-sub-journal-q');
    q.value = '柳叶刀';
    q.fire('input');
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    ok(env.calls.journalFind.some((x) => x.q === '柳叶刀'), '⑭ ★ 输入中文别名触发本地搜索');
    ok(list.textContent.indexOf('The Lancet') >= 0 && list.textContent.indexOf('Nature') < 0,
      '⑭ 中文别名过滤生效（只剩目标刊）');
    // 0.69.1 回归（真机 G2 实证）：在「我的订阅」删掉一条后，上面的期刊列表必须重渲染，
    // 否则该刊仍留着「已订阅」灰按钮，用户以为删不掉。
    // 重渲染的标志就是每行重新查一次 journalSubscribed。
    const beforeSub = env.calls.journalSubscribed.length;
    const del = env.dom.byId.get('pp-subs-list').querySelectorAll('.pp-subs-del')[0];
    ok(!!del, '⑭ 订阅行有删除按钮');
    if (del) {
      del.fire('click');
      await tick();
      ok(env.calls.journalSubscribed.length > beforeSub,
        '⑭ ★ 删除订阅后期刊列表重渲染并重查已订阅态',
        beforeSub + ' -> ' + env.calls.journalSubscribed.length);
    }
    eq(env.rejections.length, 0, '⑭ 期刊订阅流程无未捕获异常');
    env.off();
  }

  /* ⑭ 已订阅态：按钮置灰 + 勾选框禁用（避免重复创建同名订阅） */
  {
    const env = run({ subscribedIssn: '0140-6736' });
    for (const t of env.timers.splice(0)) t.fn();
    await tick();
    const list = env.dom.byId.get('pp-sub-journal-list');
    const rows = list.querySelectorAll('.pp-subs-jrow');
    const lrow = rows.filter((r) => r.textContent.indexOf('The Lancet') >= 0)[0];
    const lbtn = lrow ? lrow.querySelectorAll('button')[0] : null;
    ok(!!lbtn && lbtn.textContent === '已订阅', '⑭ 已订阅的刊显示「已订阅」');
    eq(lbtn.disabled, true, '⑭ 已订阅按钮不可再点');
    eq(lrow.querySelectorAll('input')[0].disabled, true, '⑭ 已订阅的勾选框禁用');
    env.off();
  }
}

main().then(() => {
  if (fails.length) {
    console.error('\n✗ 订阅面板烟测失败 ' + fails.length + ' 项 / ' + (pass + fails.length) + ' 项断言');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 订阅面板烟测通过：' + pass + ' 项断言');
}).catch((e) => {
  console.error('✗ 测试执行异常：' + (e && (e.stack || e.message) || e));
  process.exit(1);
});
