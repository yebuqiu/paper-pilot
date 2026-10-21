#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 订阅落地桥测试（subs-bridge.js）
 *
 * 这个模块做的事全是「落地」——建分类、加条目、建 RSS 源。它的失败模式同样是静默的：
 * 分类建成了顶层而不是子级、条目加进分类没保存、回填数错了、RSS 源重复建。
 * 这里在 vm 沙箱里真跑 subs-bridge.js，把 Zotero 的数据层全部桩化（零磁盘零网络），
 * 断言：
 *   ① 期刊订阅识别 / 候选 RSS 地址（纯函数）
 *   ② 分类树建对层级、幂等（第二次 created=0）
 *   ③ 条目归类：加一次成功、第二次返回 false、已归类的不重复加
 *   ④ 回填：按标签找回历史条目并计数
 *   ⑤ RSS：无可用候选 → no-feed；解析成功 → 建源；第二次 → existed
 *
 * 运行：node test/subs-bridge.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'subs-bridge.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(arr, needle, label) {
  return ok((arr || []).some((x) => String(x).indexOf(needle) >= 0), label, { needle: needle, got: arr });
}

/* ---------------- 假数据层 ---------------- */

let seq = 1;

function makeEnv(opts) {
  const o = opts || {};
  const cols = [];          // {id,key,name,libraryID,parentID,_items:Set}
  const feeds = [];         // {url,name,refreshInterval}
  const items = new Map();  // id → {id, getCollections, addToCollection, saveTx}
  const tagIndex = o.tagIndex || {}; // tag → [itemID]
  const probes = o.probes || {};     // url → {title} | null（模拟解析失败）

  function Collection(params) {
    this.libraryID = params && params.libraryID;
    this.name = params && params.name;
    this.parentKey = params && params.parentKey;
    this.parentID = null;
    this.id = null;
    this.key = null;
  }
  Collection.prototype.getChildCollections = function () {
    return cols.filter((c) => c.parentID === this.id);
  };
  Collection.prototype.getChildItems = function () {
    return Array.from(this._items || []);
  };
  Collection.prototype.addItem = function (itemID) {
    if (!this._items) this._items = new Set();
    this._items.add(itemID);
  };
  Collection.prototype.saveTx = async function () {
    if (!this.id) {
      this.id = seq++;
      this.key = 'COL' + this.id;
      if (this.parentKey) {
        const parent = cols.filter((c) => c.key === this.parentKey)[0];
        this.parentID = parent ? parent.id : null;
      }
      cols.push(this);
      return this.id;
    }
    return true;
  };

  const Zotero = {
    Libraries: { userLibraryID: 1 },
    Collection: Collection,
    Collections: {
      getByLibrary() { return cols.slice(); },
    },
    Items: {
      async getAsync(id) { return items.get(id) || null; },
      get(id) { return items.get(id) || null; },
    },
    DB: {
      async executeTransaction(fn) { return fn(); },
    },
    Search: function () {
      this.conditions = [];
      this.libraryID = 0;
    },
    Feeds: {
      existsByURL(url) { return feeds.some((f) => f.url === url); },
      getByURL(url) { return feeds.filter((f) => f.url === url)[0] || null; },
    },
    Feed: function () { this.url = ''; this.name = ''; },
    FeedReader: function (url) {
      this._url = url;
      this.feedProperties = null;
    },
    debug() {},
  };
  Zotero.Search.prototype.addCondition = function (field, op, val) {
    this.conditions.push([field, op, val]);
  };
  Zotero.Search.prototype.search = async function () {
    const c = this.conditions[0] || [];
    if (c[0] !== 'tag') return [];
    return (tagIndex[c[2]] || []).slice();
  };
  Zotero.Feed.prototype.saveTx = async function () {
    if (!this.url) throw new Error('Feed URL not set');
    if (Zotero.Feeds.existsByURL(this.url)) throw new Error('Feed for URL already exists: ' + this.url);
    const rec = { url: this.url, name: this.name, refreshInterval: this.refreshInterval };
    feeds.push(rec);
    return true;
  };
  Zotero.Feed.prototype.updateFeed = async function () { return true; };
  Zotero.FeedReader.prototype.process = async function () {
    const hit = probes[this._url];
    if (!hit) throw new Error('not a feed');
    this.feedProperties = { title: hit.title };
  };
  Zotero.FeedReader.prototype.terminate = function () {};

  const sandbox = {
    Zotero: Zotero,
    console: console,
    Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, String: String,
    Number: Number, Boolean: Boolean, Map: Map, Set: Set, Promise: Promise, Error: Error,
    RegExp: RegExp, isNaN: isNaN, parseInt: parseInt,
    setTimeout: (fn, ms) => (0, setTimeout)(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'subs-bridge.js' });

  return { B: sandbox.SubsBridge, Zotero: Zotero, cols: cols, feeds: feeds, items: items, tagIndex: tagIndex };
}

/** 造一条订阅（期刊订阅默认带 ISSN + 刊名） */
function sub(name, issn, extra) {
  return Object.assign({
    id: 'sub-' + name,
    name: name,
    issns: issn ? [issn] : [],
    journals: name ? [name] : [],
  }, extra || {});
}

/** 造一个已入库条目 */
function addItem(env, id, colIDs) {
  const set = new Set(colIDs || []);
  const item = {
    id: id,
    getCollections() { return Array.from(set); },
    addToCollection(colID) { set.add(colID); },
    async saveTx() { return true; },
  };
  env.items.set(id, item);
  return item;
}

async function main() {
  /* ① 期刊订阅识别 */
  {
    const env = makeEnv();
    const B = env.B;
    ok(B.isJournalSub(sub('The Lancet', '0140-6736')), '① 有 ISSN 的算期刊订阅');
    ok(!B.isJournalSub({ name: '图神经网络', keywords: 'gnn' }), '① 主题订阅不算期刊订阅');
    const js = B.journalsOf(sub('The Lancet', '0140-6736'));
    eq(js.length, 1, '① 一条订阅抽出一本刊');
    eq(js[0].name, 'The Lancet', '① 刊名');
    eq(js[0].issn, '0140-6736', '① ISSN');
    eq(B.collectionName({ name: '  Brain  ' }), 'Brain', '① 分类名去空白');
    eq(B.collectionName({ name: '' , issn: '0006-8950' }), '0006-8950', '① 没有刊名时用 ISSN');
    eq(B._issnDigits('0140-6736'), '01406736', '① ISSN 去连字符');
  }

  /* ② 候选 RSS 地址（纯函数） */
  {
    const env = makeEnv();
    const B = env.B;
    const c1 = B.feedCandidates(sub('The Lancet', '0140-6736'));
    has(c1, 'rss.sciencedirect.com/publication/science/01406736', '② Elsevier 走 ISSN 直连');
    const c2 = B.feedCandidates(sub('Nature Medicine', '1078-8956'));
    has(c2, 'nature.com/nm.rss', '② Nature 系走 slug 表');
    const c3 = B.feedCandidates(sub('Science', '0036-8075'));
    has(c3, 'science.org/action/showFeed', '② Science 走固定路径');
    const c4 = B.feedCandidates(sub('BMJ', '0959-8138'));
    has(c4, 'bmj.com/rss/recent.xml', '② BMJ 走固定路径');
    const c5 = B.feedCandidates(sub('中草药', '0253-2670'));
    has(c5, 'navi.cnki.net/knavi/rss/ZCYO', '② 知网刊号表命中');
    const c5b = B.feedCandidates(sub('Zhongcaoyao', '0253-2670'));
    has(c5b, 'navi.cnki.net/knavi/rss/ZCYO', '② 订阅名是拼音时按 ISSN 认刊号（真机踩到）');
    const c6 = B.feedCandidates(sub('X', '0140-6736', { rssUrl: 'https://example.org/f.xml' }));
    eq(c6[0], 'https://example.org/f.xml', '② 手填地址优先');
    eq(new Set(c6).size, c6.length, '② 候选不重复');
  }

  /* ③ 分类树：层级 + 幂等 */
  {
    const env = makeEnv();
    const B = env.B;
    const subs = [sub('The Lancet', '0140-6736'), sub('Brain', '0006-8950')];
    const r1 = await B.ensureCollections(subs);
    eq(r1.ok, true, '③ 建分类成功');
    eq(r1.created, 2, '③ 建了 2 个子分类');
    eq(env.cols.length, 3, '③ 父分类 + 2 子分类（没有多建）');
    const parent = env.cols.filter((c) => c.name === '订阅期刊')[0];
    ok(!!parent, '③ 父分类存在');
    eq(parent.parentID, null, '③ 父分类在顶层');
    const kids = env.cols.filter((c) => c.parentID === parent.id);
    eq(kids.length, 2, '③ 子分类真的挂在父分类下（走 parentKey 而非 parentID）');
    eq(kids.map((c) => c.name).sort().join(','), 'Brain,The Lancet', '③ 子分类名 = 刊名');

    const r2 = await B.ensureCollections(subs);
    eq(r2.created, 0, '③ 幂等：第二次不再建');
    eq(env.cols.length, 3, '③ 幂等：分类数不变');
  }

  /* ④ 条目归类 */
  {
    const env = makeEnv();
    const B = env.B;
    const s = sub('The Lancet', '0140-6736');
    const item = addItem(env, 101);
    eq(await B.attachItem(item, s), true, '④ 首次归类返回 true');
    const col = B.collectionFor(s);
    ok(!!col, '④ 分类已建');
    eq(col.getChildItems().indexOf(101) >= 0, true, '④ 条目进了分类');
    eq(await B.attachItem(item, s), false, '④ 重复归类返回 false（不重复加）');
    eq(col.getChildItems().length, 1, '④ 分类里只有一条');
    eq(await B.attachItem(item, { id: 't', name: '主题', keywords: 'x' }), false, '④ 主题订阅不归类');
    // 不存在的条目：静默 false，不抛
    eq(await B.attachItem(null, s), false, '④ 条目为空时返回 false 且不抛');
  }

  /* ⑤ 回填历史条目 */
  {
    const env = makeEnv({ tagIndex: { '#订阅/Brain': [201, 202], '#订阅/The Lancet': [203] } });
    const B = env.B;
    const subs = [sub('Brain', '0006-8950'), sub('The Lancet', '0140-6736')];
    const r = await B.backfill(subs);
    eq(r.ok, true, '⑤ 回填成功');
    eq(r.moved, 3, '⑤ 回填 3 篇');
    eq(r.scanned, 3, '⑤ 扫到 3 篇');
    const brain = env.cols.filter((c) => c.name === 'Brain')[0];
    eq(brain.getChildItems().length, 2, '⑤ Brain 分类里 2 篇');
    // 再跑一次：不应重复加
    const r2 = await B.backfill(subs);
    eq(r2.moved, 0, '⑤ 回填幂等');
  }

  /* ⑥ RSS 落地 */
  {
    const env = makeEnv({
      probes: {
        'https://rss.sciencedirect.com/publication/science/01406736': { title: 'The Lancet' },
      },
    });
    const B = env.B;
    const s = sub('The Lancet', '0140-6736');
    const r = await B.ensureFeed(s);
    eq(r.ok, true, '⑥ 解析成功 → 建源');
    eq(r.name, 'The Lancet', '⑥ 源名用刊名');
    eq(env.feeds.length, 1, '⑥ 只建了一个源');
    eq(env.feeds[0].url, 'https://rss.sciencedirect.com/publication/science/01406736', '⑥ 源地址来自候选');
    const r2 = await B.ensureFeed(s);
    eq(r2.ok, true, '⑥ 第二次仍 ok');
    eq(r2.existed, true, '⑥ 第二次标记已存在');
    eq(env.feeds.length, 1, '⑥ 不重复建源');
  }

  /* ⑦ 没有可用 RSS 的刊：如实返回 no-feed，不建源不抛 */
  {
    const env = makeEnv({ probes: {} });
    const B = env.B;
    const r = await B.ensureFeed(sub('中草药', '0253-2670'));
    eq(r.ok, false, '⑦ 无 RSS 时 ok=false');
    eq(r.reason, 'no-feed', '⑦ 原因如实标 no-feed');
    eq(env.feeds.length, 0, '⑦ 不建空源');
  }

  /* ⑧ sync 汇总 + status */
  {
    const env = makeEnv({
      tagIndex: { '#订阅/Brain': [301] },
      probes: { 'https://rss.sciencedirect.com/publication/science/01406736': { title: 'The Lancet' } },
    });
    const B = env.B;
    const subs = [sub('Brain', '0006-8950'), sub('The Lancet', '0140-6736')];
    const r = await B.sync(subs, { feeds: true, backfill: true });
    eq(r.ok, true, '⑧ 汇总 ok');
    eq(r.total, 2, '⑧ 统计 2 本刊');
    eq(r.collections.created, 2, '⑧ 建 2 个分类');
    eq(r.backfill.moved, 1, '⑧ 回填 1 篇');
    eq(r.feeds.filter((x) => x.ok).length, 1, '⑧ 只有 Lancet 拿到 RSS');
    const st = B.status(subs);
    eq(st.total, 2, '⑧ status.total');
    eq(st.withCol, 2, '⑧ status.withCol');
    eq(st.withFeed, 1, '⑧ status.withFeed');
  }

  /* ⑨ 自检：能力探测不抛，缺能力时 ok=false */
  {
    const env = makeEnv();
    const st = env.B.selfTest();
    eq(st.ok, true, '⑨ 能力齐备时 selfTest.ok');
    eq(st.parentExists, false, '⑨ 还没建父分类');
    eq(st.caps.feedReader, true, '⑨ FeedReader 探测');
    eq(st.libID, 1, '⑨ 库 id');
  }
}

main().then(() => {
  if (fails.length) {
    console.error('\n✗ 订阅落地桥测试失败 ' + fails.length + ' 项 / ' + (pass + fails.length) + ' 项断言');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 订阅落地桥测试通过：' + pass + ' 项断言');
}).catch((e) => {
  console.error('✗ 测试执行异常：' + (e && (e.stack || e.message) || e));
  process.exit(1);
});
