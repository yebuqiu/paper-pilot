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
  'pp-subs-reco', 'pp-subs-reco-refresh', 'pp-subs-reco-msg',
  'pp-sub-nl', 'pp-sub-ai', 'pp-sub-nl-msg',
  'pp-subs-list', 'pp-subs-detail', 'pp-subs-form-title',
  'pp-subs-export', 'pp-subs-import',
  'pp-sub-name', 'pp-sub-keywords', 'pp-sub-cats', 'pp-sub-exclude',
  'pp-sub-mode', 'pp-sub-freq', 'pp-sub-time', 'pp-sub-weekdays',
  'pp-sub-maxagedays', 'pp-sub-max',
  'pp-sub-src-arxiv', 'pp-sub-src-openalex', 'pp-sub-src-crossref', 'pp-sub-src-europepmc', 'pp-sub-src-pubmed',
  'pp-sub-auto', 'pp-sub-ai-rerank', 'pp-sub-ai-digest', 'pp-sub-seed',
  'pp-subs-add', 'pp-subs-preview', 'pp-subs-cancel', 'pp-sub-msg',
];

function makeDom() {
  const byId = new Map();
  for (const id of IDS) {
    const tag = id === 'pp-sub-mode' || id === 'pp-sub-freq' ? 'select'
      : /pp-sub-src-|pp-sub-auto|pp-sub-ai-|pp-sub-seed/.test(id) ? 'input' : 'div';
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
  const sub = {
    id: 'sub-1', name: '稀疏注意力', keywords: 'sparse attention', categories: 'cs.LG',
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
    aiParseQuery: async (text) => {
      calls.ai.push(text);
      return {
        ok: true,
        input: { name: 'AI 草稿', keywords: 'sparse attention', categories: 'cs.CL', sources: ['arxiv', 'openalex'], mode: 'any', freq: 'daily', dailyTime: '08:00', maxAgeDays: 7, max: 10, autoImport: false },
        note: 'ok',
      };
    },
  };
}

function run(opts) {
  const dom = makeDom();
  const calls = { add: [], update: [], preview: [], run: [], suggest: [], dismiss: [], ai: [], export: [], import: [] };
  const subs = stubSubs(calls, opts);
  const timers = [];
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);

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
  const sandbox = {
    Zotero, window, document: dom.document, console,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, Error, RegExp,
    parseInt, isNaN, isFinite,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'prefs-subs.js' });
  return { dom, calls, subs, timers, rejections, off: () => process.removeListener('unhandledRejection', onRej) };
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
