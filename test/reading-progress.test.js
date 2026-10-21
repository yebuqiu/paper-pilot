#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 阅读进度 2.0 测试（0.46.0；Node vm 桩，无 Zotero 环境）
 *
 * 覆盖（数据域 features/reading-progress.js + 列 columns/progress-column.js）：
 *   ① 存储纯函数：parse 容错 / record 只进不退 + changed 语义 / prune LRU /
 *      snapshot 快照缓存随 pref 变化自动重建；
 *   ② 融合 compute：位置优先（auto）/ 纯位置 / 纯时长 / 启发值（页数未知→30 页）
 *      / 夹紧 100%；
 *   ③ 列 lookup：无记录 → ""（可排序沉底）/ 位置优先于时长 / 排序键 toString
 *      零填充（"042"）/ 按阅读状态挂色 / pref 开关；
 *   ④ 渲染三样式（迷你 DOM 真渲染）：bar 轨道+填充 / gradient 渐变 / percent
 *      仅文本 / 启发值 ≈ 前缀与灰显；
 *   ⑤ 采集集成桩：pageOfAnnotation（position JSON / 页标签兜底 / 坏数据 0）/
 *      标注 Notifier 融合 / 心跳 tick（捕获→落盘→redraw）/ 老数据 backfill；
 *   ⑥ 状态自动化：未读→在读、位置达标→已读（heuristic 与时长口径不触发）。
 *
 * 运行：node test/reading-progress.test.js
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
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM（与 column-views.test.js 同款 + 样式/文本） ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this._attrs = {};
    this.id = ''; this.parentNode = null; this.handlers = {};
    this._style = ''; this.textContent = ''; this.title = '';
    this.className = ''; this.ownerDocument = null;
  }
  setAttribute(k, v) { if (k === 'id') this.id = String(v); this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  // style：cssText 整串写 + 任意属性零散写都收进 _style（行内装饰两种写法混用）
  get style() {
    const self = this;
    if (!self._styleProxy) {
      self._styleProxy = new Proxy({}, {
        get(t, k) { return k === 'cssText' ? self._style : undefined; },
        set(t, k, v) {
          if (k === 'cssText') self._style = String(v);
          else self._style = (self._style ? self._style.replace(/;?$/, ';') : '') + k + ':' + String(v) + ';';
          return true;
        },
      });
    }
    return self._styleProxy;
  }
  // 本测试用到的两种选择器：.class / tag
  querySelector(sel) {
    const byClass = sel.startsWith('.');
    const cls = sel.slice(1);
    return this.all().find((n) => (byClass
      ? (n.className || '').split(/\s+/).includes(cls)
      : n.tag === sel)) || null;
  }
  all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
}
const miniDoc = {
  createElementNS: (ns, tag) => { const el = new El(tag); el.ownerDocument = miniDoc; return el; },
  // CSS 变量桩：--color-accent 有值，--accent-green 返回空 → 走 fallback 色号
  defaultView: {
    getComputedStyle: () => ({
      getPropertyValue: (v) => (v === '--color-accent' ? '#2563eb' : ''),
    }),
  },
};

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
let statsGetCount = 0;   // 统计行渲染读 readingStats 的次数（P1-5 回归用）
let sandboxRef = null;   // 由 makeSandbox 赋值：外部写 pref 时模拟 pref 观察者刷新内存副本
const Prefs = {
  PREFIX: 'extensions.zotero.papilot.',
  get(k, d) {
    if (k === 'readingStats') statsGetCount++;
    return PrefStore.has(k) ? PrefStore.get(k) : d;
  },
  set(k, v) {
    PrefStore.set(k, v);
    try {
      if (k === 'readingProgress' && sandboxRef && sandboxRef.ReadingProgress) sandboxRef.ReadingProgress.reloadFromPref();
      if (k === 'readingStats' && sandboxRef && sandboxRef.ReadingStats) sandboxRef.ReadingStats.reloadFromPref();
    } catch (e) { /* ignore */ }
  },
};

const redrawCalls = [];
const notifRegister = [];
const stateCalls = [];
let itemsById = new Map();
let annotationsAsync = [];

const Zotero = {
  debug() {}, logError() {},
  Items: {
    get: (id) => itemsById.get(id) || null,
    getAsync: async (ids) => (ids || []).map((i) => itemsById.get(i) || null).filter(Boolean),
  },
  Notifier: {
    trigger: (ev, type, ids) => { redrawCalls.push({ ev, type, ids: ids.slice() }); },
    registerObserver: (o, types, id) => { notifRegister.push({ types, id }); return notifRegister.length; },
    unregisterObserver: () => {},
  },
  ItemTreeManager: { refreshColumns() {}, registerColumns: async () => {}, unregisterColumns() {} },
};
const I18n = { t: (k) => k, isZh: true };
const ItemSel = { regularOnly: (a) => a.filter((i) => i && i.isRegularItem && i.isRegularItem()), alertEmpty() {} };

/** 心跳/标注路径的 ReadingState 桩（记录调用；状态真存在 fake item 的 tags 上） */
function mkReadingState() {
  return {
    STATES: ['未读', '在读', '已读'],
    getState(item) {
      const tags = (item.getTags && item.getTags().map((t) => t.tag)) || [];
      return tags.find((t) => this.STATES.includes(t)) || '';
    },
    async setState(item, state) { stateCalls.push([item.key, state]); },
  };
}

function makeSandbox(extra) {
  const sb = Object.assign({
    console, Zotero, Prefs, I18n, ItemSel,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON,
  }, extra || {});
  sb.globalThis = sb;
  vm.createContext(sb);
  for (const f of [
    'features/reading-progress.js',
    // 0.54.1：列渲染改走 ReadingStats.minutesByKey() 内存聚合，沙箱里必须一起加载，
    // 否则测的是已不存在的「每行读整串 pref」旧路径。
    'features/reading-stats.js',
    'columns/progress-column.js',
  ]) {
    vm.runInContext(fs.readFileSync(S(f), 'utf8'), sb, { filename: f });
  }
  sandboxRef = sb;
  return sb;
}

const flush = (ms) => new Promise((r) => setTimeout(r, ms || 15));

/* ==================== ① 存储纯函数 ==================== */

{
  const sb = makeSandbox({ ReadingState: mkReadingState() });
  const RP = sb.ReadingProgress;

  // parse 容错
  eq(RP.parse('').schema, 1, '① 空 pref → 空结构');
  eq(Object.keys(RP.parse('not json').items).length, 0, '① 脏 JSON → 空结构');
  eq(Object.keys(RP.parse('{"days":{}}').items).length, 0, '① 旧版结构（无 items）→ 空结构');
  const st = RP.parse('{"schema":1,"items":{"K1":{"p":3,"t":10,"a":9}}}');
  eq(st.items.K1.p, 3, '① 正常 JSON 解析');

  // stringify round-trip
  eq(RP.parse(RP.stringify(st)).items.K1.t, 10, '① stringify→parse round-trip');

  // record：新增 / 只进不退 / total 取信 / changed 语义
  let s0 = RP._empty();
  let r1 = RP.record(s0, 'K1', 5, 24, 1000);
  eq(r1.changed, true, '① 首次记录 changed=true');
  eq(r1.store.items.K1.p, 5, '① 记录页码');
  eq(r1.store.items.K1.t, 24, '① 记录总页数');
  let r2 = RP.record(r1.store, 'K1', 3, 20, 2000);   // 重读更靠前的页
  eq(r2.changed, false, '① 页数只进不退（5→3 不算变化）');
  eq(r2.store.items.K1.p, 5, '① 页码不倒退');
  eq(r2.store.items.K1.t, 24, '① 总页数保留可信值');
  let r3 = RP.record(r2.store, 'K1', 12, 0, 3000);   // 心跳没带 total（原生回落路径）
  eq(r3.changed, true, '① 更远页 changed=true');
  eq(r3.store.items.K1.t, 24, '① total=0 不清掉已知总页数');
  eq(r3.store.items.K1.a, 3000, '① 时间戳刷新');
  eq(RP.record(r3.store, 'K1', 0, 99, 1).changed, false, '① page=0 忽略');
  eq(RP.record(r3.store, '', 5, 0, 1).changed, false, '① 空 key 忽略');

  // prune LRU
  let big = RP._empty();
  for (let i = 0; i < 60; i++) big.items['K' + i] = { p: i + 1, t: 0, a: 1000 + i };
  const kept = RP.prune(big, 10);
  eq(Object.keys(kept.items).length, 10, '① 超上限淘汰到 10 条');
  ok(kept.items.K59 && kept.items.K59.p === 60, '① 保留最近更新的（K59）');
  ok(!kept.items.K0, '① 最旧的 K0 被淘汰');
  eq(Object.keys(RP.prune(big, 100).items).length, 60, '① 未超上限不动');

  // snapshot：pref 变了自动重建
  PrefStore.delete('readingProgress');
  RP.reloadFromPref();
  eq(RP.entryOf('K1'), null, '① 无记录 entryOf → null');
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { K1: { p: 7, t: 24, a: 1 } } }));
  RP.reloadFromPref();   // 真实环境由 pref 观察者触发；测试里显式刷新
  eq(RP.entryOf('K1').p, 7, '① snapshot 读到记录');
  eq(RP.entryOf('K2'), null, '① 无关条目 → null');
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { K1: { p: 9, t: 24, a: 2 } } }));
  RP.reloadFromPref();
  eq(RP.entryOf('K1').p, 9, '① ★ pref 更新后快照自动重建（9 不是旧值 7）');
  PrefStore.delete('readingProgress');
  RP.reloadFromPref();
}

/* ==================== ② 融合 compute ==================== */

{
  const sb = makeSandbox({});
  const RP = sb.ReadingProgress;

  // auto：位置优先
  const a1 = RP.compute({ minutes: 99, page: 12, pages: 24, basis: 'auto' });
  eq(a1.pct, 0.5, '② auto 有位置 → 位置口径（12/24）');
  eq(a1.basis, 'position', '② basis = 采信口径（auto 下用了位置 → "position"）');
  eq(a1.heuristic, false, '② 有真实页数 → 非启发');
  const a2 = RP.compute({ minutes: 45, page: 0, pages: 0, basis: 'auto' });
  eq(a2.pct, 1, '② auto 无位置 → 时长兜底（45/(30×1.5)=1 夹紧）');
  eq(a2.heuristic, true, '② 页数未知 → 启发标记');
  eq(RP.compute({ minutes: 0, page: 0, pages: 0, basis: 'auto' }), null, '② 无任何数据 → null');

  // position：纯位置
  eq(RP.compute({ minutes: 99, page: 12, pages: 24, basis: 'position' }).pct, 0.5,
    '② position 口径只看位置');
  eq(RP.compute({ minutes: 99, page: 0, pages: 24, basis: 'position' }), null,
    '② position 无位置 → null（不拿时长凑）');

  // time：纯时长（0.42.0 旧行为；位置再远也不看）
  eq(RP.compute({ minutes: 30, page: 99, pages: 10, basis: 'time' }).pct, 1,
    '② time 口径忽略位置并夹紧（30/(10×1.5)=2 → 1）');
  eq(RP.compute({ minutes: 30, page: 99, pages: 10, basis: 'time' }).pct <= 1, true,
    '② pct 永不超 1');
  eq(RP.compute({ minutes: 0, page: 5, pages: 24, basis: 'time' }), null,
    '② time 无时长 → null');

  // 启发值：位置模式页数未知也能显示（按 30 页折算并标记）
  const h = RP.compute({ minutes: 0, page: 12, pages: 0, basis: 'position' });
  eq(h.pct, 12 / 30, '② 位置 + 页数未知 → 按 30 页启发折算');
  eq(h.heuristic, true, '② 启发标记（着色灰显、悬停提示「估算」）');

  // 夹紧
  eq(RP.compute({ minutes: 0, page: 99, pages: 24, basis: 'position' }).pct, 1, '② 超页夹紧 100%');
  // 非法输入
  eq(RP.compute(null), null, '② null 入参安全');
  eq(RP.compute({ minutes: -5, page: -1, pages: -1, basis: 'position' }), null, '② 负数安全归零');
}

/* ==================== ③ 列 lookup 与排序键 ==================== */

(async () => {
  PrefStore.delete('readingProgress');
  PrefStore.delete('readingStats');
  PrefStore.delete('progressColumnEnabled');
  PrefStore.delete('progressBasis');
  PrefStore.delete('progressColorByState');

  // ③④ 段用同一个沙箱：时长聚合需要 ReadingStats.parse（真实现语义的桩）
  const sb = makeSandbox({
    ReadingState: mkReadingState(),
    ReadingStats: {
      parse(raw) {
        const o = JSON.parse(String(raw || '{}'));
        return (o && o.days) ? { days: o.days } : { days: {} };
      },
    },
  });
  const PC = sb.ProgressColumn;
  const RP = sb.ReadingProgress;

  const mkItem = (id, key, tags) => ({
    id, key,
    isRegularItem: () => true,
    getTags: () => (tags || []).map((t) => ({ tag: t })),
    async getBestAttachment() { return null; },
  });

  // 时长聚合：分钟 → lookup
  Prefs.set('readingStats', JSON.stringify({ schema: 1, days: {
    '2026-10-14': { KA: 5 }, '2026-10-15': { KA: 7 },
  } }));
  const itemA = mkItem(201, 'KA', ['在读']);
  const d1 = PC.lookup(itemA);
  ok(d1 && typeof d1 === 'object', '③ 有时长 → 数据对象');
  eq(d1.pct, 12 / 45, '③ 无页数先走启发（12 分钟 / 30×1.5）');
  eq(d1.heuristic, true, '③ 启发分支标记');
  eq(d1.state, '在读', '③ 挂上阅读状态（着色依据）');
  eq(d1.basis, 'time', '③ 采信口径 = time');

  // 排序键：零填充百分数
  eq(String(d1), '027', '③ ★ toString 排序键零填充（27% → "027"）');
  eq(String(PC._decorate({ pct: 1, page: 0, pages: 0, minutes: 0, basis: 'time', heuristic: false }, itemA)), '100',
    '③ 100% → "100"');
  eq(String(PC._decorate({ pct: 0.07, page: 0, pages: 0, minutes: 0, basis: 'time', heuristic: false }, itemA)), '007',
    '③ 7% → "007"（"100" > "042" > "007" 字符串序 = 数值序）');

  // 位置优先于时长（store 有位置记录）
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { KA: { p: 12, t: 24, a: 1 } } }));
  const d2 = PC.lookup(itemA);
  eq(d2.pct, 0.5, '③ ★ 位置优先（12/24=50% 而非时长口径）');
  eq(d2.page, 12, '③ 带回最远页（tooltip「读到第 12/24 页」）');
  eq(d2.pages, 24, '③ 总页数取 store 心跳捕获值');

  // basis=position：无位置 → 留空
  Prefs.set('progressBasis', 'position');
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: {} }));
  eq(PC.lookup(itemA), '', '③ position 口径无位置 → ""（排序沉底）');

  // basis=time：回到 0.42.0 行为
  Prefs.set('progressBasis', 'time');
  PC._pageCache.set(201, 20);
  eq(PC.lookup(itemA).pct, 12 / 30, '③ time 口径 = 12/(20×1.5)');
  Prefs.set('progressBasis', 'auto');

  // 无任何记录 / 非常规条目 / pref 关闭 → ""（不再是 null）
  eq(PC.lookup(mkItem(203, 'KC')), '', '③ 无记录 → ""');
  eq(PC.lookup({ id: 204, isRegularItem: () => false }), '', '③ 非常规条目 → ""');
  Prefs.set('progressColumnEnabled', false);
  // 0.46.0：列开关只门控列；lookup 本体不受影响（行内显示共用数据链）
  eq(PC.lookupForColumn(itemA), '', '③ 列 pref 关闭 → 列留空');
  ok(typeof PC.lookup(itemA) === 'object', '③ ★ 列关闭不影响 lookup 本体（行内仍可用）');
  PrefStore.delete('progressColumnEnabled');

  // 时长聚合缓存：readingStats pref 变化自动重算
  Prefs.set('readingStats', JSON.stringify({ schema: 1, days: { '2026-10-16': { KA: 6 } } }));
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: {} }));
  PC._pageCache.set(201, 20);
  eq(PC.lookup(itemA).minutes, 6, '③ ★ 时长缓存随 pref 更新（99 分钟旧值不残留）');

  // P1-5：行渲染只读内存聚合，不再每次 Prefs.get 整串
  const statsGetsBefore = statsGetCount;
  for (let i = 0; i < 5; i++) PC.lookup(itemA);
  eq(statsGetCount, statsGetsBefore, '③ ★ 多次行渲染不再读 readingStats pref（内存聚合）');

  // computeProgress 兼容委托（ReadingProgress 在场 → 单一真源）
  eq(PC.computeProgress(15, 20).pct, 0.5, '③ computeProgress 委托后数值不变');
  eq(PC.computeProgress(0, 20), null, '③ computeProgress 无记录仍 null');

  /* ==================== ④ 渲染三样式（迷你 DOM） ==================== */

  const col = { className: 'papilot-readingProgress-column' };
  const progBar = PC._decorate({ pct: 0.42, page: 12, pages: 24, minutes: 45, basis: 'position', heuristic: false }, itemA);
  PrefStore.delete('progressBarStyle');

  // bar（默认）：轨道 + 填充 + 百分比文本
  let cell = PC._renderCell(progBar, col, miniDoc);
  let spans = cell.byTag('span');
  ok(spans.length >= 3, '④ bar = 轨道 + 填充 + 百分比文本');
  eq(cell.children[cell.children.length - 1].textContent, '42%', '④ 百分比文本');
  ok(cell.children[0]._style.indexOf('64px') >= 0, '④ 轨道 64px 宽');
  ok(cell.title.indexOf('第 12/24 页') >= 0, '④ 悬停提示含「读到第几页」');
  ok(spans.some((s) => s._style.indexOf('width:42%') >= 0), '④ 填充宽 = 42%');

  // gradient：填充背景为渐变
  Prefs.set('progressBarStyle', 'gradient');
  cell = PC._renderCell(progBar, col, miniDoc);
  ok(cell.byTag('span').some((s) => s._style.indexOf('linear-gradient') >= 0),
    '④ gradient 样式填充为渐变（蓝→绿）');
  PrefStore.delete('progressBarStyle');

  // percent：仅文本无轨道
  Prefs.set('progressBarStyle', 'percent');
  cell = PC._renderCell(progBar, col, miniDoc);
  eq(cell.children.length, 1, '④ percent 仅一个文本节点（无轨道）');
  eq(cell.children[0].textContent, '42%', '④ percent 文本');
  PrefStore.delete('progressBarStyle');

  // 启发值：≈ 前缀 + 灰显；未知值（""）→ 空单元格
  const progEst = PC._decorate({ pct: 0.27, page: 0, pages: 30, minutes: 12, basis: 'time', heuristic: true }, itemA);
  cell = PC._renderCell(progEst, col, miniDoc);
  eq(cell.children[cell.children.length - 1].textContent, '≈27%', '④ 启发值文本带 ≈ 前缀');
  ok(cell.byTag('span').some((s) => s._style.indexOf('--fill-tertiary') >= 0),
    '④ 启发值填充灰显（var(--fill-tertiary)）');
  eq(PC._renderCell('', col, miniDoc).children.length, 0, '④ 空数据 → 空单元格');

  // 状态着色分支
  eq(PC._fillColor({ heuristic: false, state: '已读' }), 'var(--accent-green,#16a34a)', '④ 已读 → 绿');
  eq(PC._fillColor({ heuristic: false, state: '在读' }), 'var(--color-accent,#2563eb)', '④ 在读 → 主题强调色');
  eq(PC._fillColor({ heuristic: false, state: '未读' }), 'var(--fill-secondary,#808080)', '④ 未读 → 中性灰');
  eq(PC._fillColor({ heuristic: false, state: '' }), 'var(--color-accent,#2563eb)', '④ 无状态 → 统一强调色');
  Prefs.set('progressColorByState', false);
  eq(PC._fillColor({ heuristic: false, state: '已读' }), 'var(--color-accent,#2563eb)',
    '④ 关闭着色 → 统一强调色');
  PrefStore.delete('progressColorByState');

  /* ==================== ⑤ 采集集成桩 ==================== */

  // pageOfAnnotation
  eq(RP.pageOfAnnotation({ annotationPosition: '{"pageIndex":11}' }), 12, '⑤ position JSON：0 基 → 1 基');
  eq(RP.pageOfAnnotation({ annotationPosition: '{}', annotationPageLabel: '17' }), 17,
    '⑤ position 无 pageIndex → 页标签兜底');
  eq(RP.pageOfAnnotation({ annotationPosition: 'bad', annotationPageLabel: 'XII' }), 0,
    '⑤ 坏 JSON / 罗马页码 → 0（放弃融合）');

  // 标注 Notifier：标注页并入父条目 maxPage
  PrefStore.delete('readingProgress');
  const parent = mkItem(777, 'KP', []);
  const att = { id: 555, isAttachment: () => true, parentItemID: 777, isPDFAttachment: () => true };
  itemsById = new Map([[555, att], [777, parent]]);
  const ann = { id: 900, isAnnotation: () => true, annotationPosition: '{"pageIndex":4}', parentItemID: 555 };
  itemsById.set(900, ann);
  RP._onAnnotations([900]);
  await flush();
  eq(RP.entryOf('KP').p, 5, '⑤ ★ 新标注 → 父条目位置记录（第 5 页）');

  // 心跳 tick：捕获焦点页 → 落盘 + redraw + 状态自动化
  PrefStore.delete('readingProgress');
  PrefStore.set('readingStats', JSON.stringify({ schema: 1, days: {} }));
  stateCalls.length = 0;
  redrawCalls.length = 0;
  sb.ReadingStats = {
    parse(raw) {
      const o = JSON.parse(String(raw || '{}'));
      return (o && o.days) ? { days: o.days } : { days: {} };
    },
    load: () => sb.ReadingProgress.parse(PrefStore.get('readingStats') || ''),
    activeReader: () => ({ itemID: 555 }),
  };
  sb.PdfText = { viewerOf: () => ({ win: {}, app: { pdfViewer: { currentPageNumber: 8, pagesCount: 24 } } }) };
  const ticked = RP.tick(123450);
  eq(ticked, true, '⑤ 心跳命中（首次记录 changed）');
  eq(RP.entryOf('KP').p, 8, '⑤ 捕获当前页 8');
  eq(RP.entryOf('KP').t, 24, '⑤ 顺带记录总页数 24');
  ok(redrawCalls.some((c) => c.ev === 'redraw' && c.ids.includes(777)),
    '⑤ ★ 命中后触发该行 redraw（阅读中进度条实时更新）');
  eq(RP.entryOf('KP').d['8'], 1, '⑤ ★ 心跳给当前页 +1 分钟（高能进度条燃料）');
  // 0.46.0 bumpPage：同页继续读分钟照记（changed=true，热图格持续变深）
  eq(RP.tick(123460), true, '⑤ 同页继续读：分钟照记（bumpPage 语义）');
  eq(RP.entryOf('KP').d['8'], 2, '⑤ 同页累计到 2 分钟');
  eq(RP.entryOf('KP').p, 8, '⑤ 同页读时位置不虚进');

  // viewerOf 不可用 → 回落原生上次位置（0 基 → 1 基）
  sb.PdfText = { viewerOf: () => null };
  att.getAttachmentLastPageIndex = () => 25;
  ok(RP.tick(123480), '⑤ 回落原生位置路径命中（25 → 第 26 页，位置推进）');
  eq(RP.entryOf('KP').p, 26, '⑤ 原生 0 基 25 → 记为第 26 页');
  eq(RP.entryOf('KP').d['26'], 1, '⑤ 回落路径同样给该页计分钟');
  delete sb.PdfText;

  // 老数据 backfill：有时长无位置 → 异步融合原生位置 + 标注页
  PrefStore.delete('readingProgress');
  PC._backfilled.clear(); PC._backfilling.clear();
  Prefs.set('readingStats', JSON.stringify({ schema: 1, days: { '2026-10-15': { KA: 12 } } }));
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: {} }));
  const itemB = mkItem(201, 'KA', []);
  itemB.getBestAttachment = async () => att2;
  const att2 = { isPDFAttachment: () => true, getAttachmentLastPageIndex: () => 11,
    getAnnotations: () => [{ annotationPosition: '{"pageIndex":19}' }] };
  PC._backfillItem(itemB);
  await flush();
  eq(RP.entryOf('KA').p, 20, '⑤ ★ backfill = max(原生 12 页, 标注 20 页)');
  PC._backfilled.clear();

  /* ==================== ⑥ 状态自动化 ==================== */

  stateCalls.length = 0;
  PrefStore.delete('progressAutoFinish');
  PrefStore.delete('progressAutoFinishPct');
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { KF: { p: 23, t: 24, a: 1 } } }));
  const itemF = mkItem(301, 'KF', ['未读']);

  // 有进度：未读 → 在读
  eq(RP.maybeAutoState(itemF, null), true, '⑥ 未读 + 有位置进度 → 触发');
  await flush(5);
  eq(stateCalls[0] && stateCalls[0][1], '在读', '⑥ 第一次自动化：在读');

  // 位置达标（23/24=95.8% ≥ 95）：→ 已读
  stateCalls.length = 0;
  const itemG = mkItem(302, 'KF', ['在读']);
  eq(RP.maybeAutoState(itemG, null), true, '⑥ 在读 + 位置 ≥95% → 触发');
  await flush(5);
  eq(stateCalls[0] && stateCalls[0][1], '已读', '⑥ 达标自动化：已读');

  // heuristic（页数未知）不触发已读
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { KH: { p: 29, t: 0, a: 1 } } }));
  eq(RP.maybeAutoState(mkItem(303, 'KH', ['在读']), null), false,
    '⑥ 总页数未知（启发）→ 不自动已读');

  // 纯时长口径不触发已读（page=0）
  Prefs.set('readingStats', JSON.stringify({ schema: 1, days: { '2026-10-15': { KI: 99 } } }));
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: {} }));
  eq(RP.maybeAutoState(mkItem(304, 'KI', ['在读']), null), false,
    '⑥ 只有时长（无位置）→ 不自动已读');

  // 已读状态不再重复触发
  eq(RP.maybeAutoState(mkItem(305, 'KF', ['已读']), null), false, '⑥ 已读 → 幂等不动作');

  // pref 关闭 → 全部不动
  Prefs.set('progressAutoFinish', false);
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { KJ: { p: 24, t: 24, a: 1 } } }));
  eq(RP.maybeAutoState(mkItem(306, 'KJ', ['在读']), null), false, '⑥ pref 关闭 → 不自动化');
  PrefStore.delete('progressAutoFinish');

  /* ==================== ⑦ 每页时长（高能燃料）+ 行内显示（标题背景） ==================== */

  // --- bumpPage 纯函数：分钟累计 / 位置融合 / d 跨 record 保留 / 封顶淘汰 ---
  let s0 = RP._empty();
  let rb = RP.bumpPage(s0, 'KQ', 3, 1, 1000);
  eq(rb.store.items.KQ.d['3'], 1, '⑦ bumpPage 给当前页记分钟');
  rb = RP.bumpPage(rb.store, 'KQ', 3, 1, 2000);
  eq(rb.store.items.KQ.d['3'], 2, '⑦ 同页重复心跳累计（2 分钟）');
  rb = RP.bumpPage(rb.store, 'KQ', 5, 1, 3000);
  eq(rb.store.items.KQ.d['5'], 1, '⑦ 翻页记新页');
  eq(rb.store.items.KQ.p, 5, '⑦ 位置随 bump 推进（只进不退）');
  const rr = RP.record(rb.store, 'KQ', 7, 9, 4000);
  eq(rr.store.items.KQ.d['3'], 2, '⑦ ★ record 重建条目保留 d（每页时长不丢）');
  let big = RP._empty();
  big.items.KS = { p: 200, t: 200, a: 1, d: {} };
  for (let i = 1; i <= 200; i++) big.items.KS.d[i] = i <= 72 ? 0.01 : 5;
  RP._shrinkD(big.items.KS);
  eq(Object.keys(big.items.KS.d).length, 128, '⑦ 每页映射封顶 128');
  ok(!big.items.KS.d['1'] && big.items.KS.d['200'] === 5, '⑦ 淘汰读得最少的页、保留热点页');

  // --- 行内 overlay 渲染 ---
  PrefStore.delete('progressRowStyle');
  Prefs.set('readingProgress', JSON.stringify({
    schema: 1, items: { KT: { p: 5, t: 6, a: 1, d: { 2: 3, 5: 1.5 } } },
  }));
  const itemT = mkItem(401, 'KT', []);
  PC._pageCache.set(401, 6);
  const ovHeat = PC._buildRowOverlay(PC.lookup(itemT), itemT, miniDoc);
  // 0.71.x（审查 P1-6）：每页一格的 N 个 span → 单节点 linear-gradient 硬止点，
  // DOM 节点从 N+1 降为 1（外观等价：等宽分段、逐页纯色、顺序不变），断言随之改写
  eq(ovHeat.children.length, 0, '⑦ heat：单节点渐变（不再每页建一个 span）');
  const grad = ovHeat._style;
  ok(grad.indexOf('linear-gradient(to right') >= 0, '⑦ heat：linear-gradient 一次绘出');
  eq((grad.match(/rgba\(/g) || []).length, 12, '⑦ 6 页 × 2 个硬止点 = 12 段色标（每页一段）');
  // 饱和度：mean=0.75, max=3 → mv=max(0.75+1.125, 1.5)=1.875；页2=3min→夹紧 1；页5=1.5/1.875=0.8
  ok(grad.indexOf(',1.000)') >= 0, '⑦ 读满一页（3min ≥ 1.5min 基线）全深');
  ok(grad.indexOf('0.800') >= 0, '⑦ 1.5 分钟的页 0.8 透明度（zotero-style 同款公式）');
  ok(grad.indexOf(',0.000)') >= 0, '⑦ 没读过的页透明');
  ok(grad.indexOf(',0.000)') < grad.indexOf(',1.000)') && grad.indexOf(',1.000)') < grad.indexOf('0.800'),
    '⑦ ★ 色标按页序排列（页1透明 → 页2全深 → 页5 0.8，顺序不变）');

  // heat 无每页数据（旧数据/刚装）→ 回退整体填充
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { KU: { p: 12, t: 24, a: 1 } } }));
  const itemU = mkItem(402, 'KU', []);
  PC._pageCache.set(402, 24);
  const ovFill = PC._buildRowOverlay(PC.lookup(itemU), itemU, miniDoc);
  eq(ovFill.children.length, 0, '⑦ heat 无 d → 回退 fill（单层无格）');
  ok(ovFill._style.indexOf('width:50%') >= 0, '⑦ 回退 fill 宽度 = 进度 50%');

  // fill 显式选择 + 已读绿色
  Prefs.set('progressRowStyle', 'fill');
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { KV: { p: 12, t: 24, a: 1 } } }));
  const itemV = mkItem(403, 'KV', ['已读']);
  PC._pageCache.set(403, 24);
  const ovDone = PC._buildRowOverlay(PC.lookup(itemV), itemV, miniDoc);
  ok(ovDone._style.indexOf('width:50%') >= 0, '⑦ fill 样式整体填充');
  ok(ovDone._style.indexOf('rgba(22,163,74') >= 0, '⑦ 已读状态 → 绿色（--accent-green）');
  PrefStore.delete('progressRowStyle');

  // --- 回填触发修订（用户实测场景）：从未触发过心跳（零分钟）也要吸收原生位置 ---
  PrefStore.delete('readingProgress');
  Prefs.set('readingStats', JSON.stringify({ schema: 1, days: {} }));  // 无任何分钟数据
  PC._backfilled.clear(); PC._backfilling.clear();
  const itemW = mkItem(405, 'KW', []);
  const attW = { isPDFAttachment: () => true, getAttachmentLastPageIndex: () => 9,
    getAnnotations: () => [{ annotationPosition: '{"pageIndex":14}' }] };
  itemW.getBestAttachment = async () => attW;
  eq(PC.lookup(itemW), '', '⑦ 无分钟无位置 → 首次渲染留空（不伪造）');
  await flush();
  eq(RP.entryOf('KW').p, 15, '⑦ ★ 回填吸收 max(原生第10页, 标注第15页)——零分钟用户也能看到进度');
  ok(typeof PC.lookup(itemW) === 'object', '⑦ 回填落库后 lookup 立即有数据（等 redraw 上屏）');
  PC._backfilled.clear();

  // --- _decorateTitleCell：真实几何（.cell-text 相对定位 + 进度层铺底） ---
  // （上面的 KV 覆写过整个 pref——这里把 KU 设回去，装饰测试用它）
  Prefs.set('readingProgress', JSON.stringify({ schema: 1, items: { KU: { p: 12, t: 24, a: 1 } } }));
  const mkTitleCell = () => {
    const cell = miniDoc.createElementNS('', 'span');
    cell.className = 'cell';
    const text = miniDoc.createElementNS('', 'span');
    text.className = 'cell-text';
    cell.appendChild(text);
    return { cell, text };
  };
  const { cell: dc1, text: dt1 } = mkTitleCell();
  PC._decorateTitleCell(dc1, 0, { getRow: () => ({ ref: itemU }) });
  eq(dt1.children.length, 1, '⑦ ★ 进度层挂进 .cell-text（标题背景）');
  ok(dt1._style.indexOf('position:relative') >= 0, '⑦ 标题容器相对定位（文字浮上层）');
  ok(dt1._style.indexOf('width:100%') >= 0, '⑦ 标题容器占满列宽（热图才铺得开）');
  ok(dt1.children[0]._style.indexOf('position:absolute') >= 0 && dt1.children[0]._style.indexOf('zIndex:-1') >= 0,
    '⑦ 进度层绝对定位铺底 zIndex:-1（zotero-style 同款几何）');
  ok((dc1.title || '').indexOf('读到第') >= 0, '⑦ 悬停 tooltip「读到第几页」');
  // 无阅读记录：不画（不伪造 0% 覆盖）
  const { cell: dc0, text: dt0 } = mkTitleCell();
  PC._decorateTitleCell(dc0, 0, { getRow: () => ({ ref: mkItem(404, 'KZ') }) });
  eq(dt0.children.length, 0, '⑦ 无阅读记录不画（标题不被伪造 0% 覆盖）');

  // --- 原型补丁生命周期：挂 → 装饰 → 开关门控 → 还原 → 重挂 ---
  const calls = [];
  function FakeTree() {}
  FakeTree.prototype._renderCell = function (index, data, column, isFirst) {
    calls.push('orig');
    return this._cells[index];
  };
  sb.Zotero.getActiveZoteroPane = () => ({ itemsView: new FakeTree() });
  PrefStore.delete('progressRowEnabled');
  eq(PC._patchRowNow(), true, '⑦ 原型补丁挂上（itemsView 实例的原型）');
  ok(PC._rowPatched && typeof PC._rowProto._renderCell._ppProgressRow === 'boolean',
    '⑦ wrapper 带识别标记（卸载时确认自己在最外层）');

  const inst = new FakeTree();
  inst.getRow = () => ({ ref: itemU });
  const { cell: px, text: ptx } = mkTitleCell();
  inst._cells = [px];
  calls.length = 0;
  const got = PC._rowProto._renderCell.call(inst, 0, 'T', { dataKey: 'title' }, true);
  eq(calls[0], 'orig', '⑦ 原生渲染先执行（包装不改基础行为）');
  eq(got, px, '⑦ 返回原生 cellSpan');
  eq(ptx.children.length, 1, '⑦ ★ title 列被装饰（进度画进标题）');
  const { cell: py, text: pty } = mkTitleCell();
  inst._cells = [py];
  calls.length = 0;
  PC._rowProto._renderCell.call(inst, 0, 'D', { dataKey: 'dateAdded' }, false);
  eq(calls[0], 'orig', '⑦ 非 title 列也走原生');
  eq(pty.children.length, 0, '⑦ 非 title 列不装饰');

  // 开关关闭 → wrapper 还在但停止装饰（开关即时生效、无需重启）
  Prefs.set('progressRowEnabled', false);
  const { cell: pz, text: ptz } = mkTitleCell();
  inst._cells = [pz];
  PC._rowProto._renderCell.call(inst, 0, 'T', { dataKey: 'title' }, true);
  eq(ptz.children.length, 0, '⑦ progressRowEnabled=false → 不装饰（即时生效）');

  // 卸载还原 + 重挂
  PC.unregisterRow();
  eq(typeof FakeTree.prototype._renderCell._ppProgressRow, 'undefined', '⑦ 卸载后原型还原为原生函数');
  Prefs.set('progressRowEnabled', true);
  eq(PC._patchRowNow(), true, '⑦ 开关再开 → 重挂成功');
  const { cell: pw, text: ptw } = mkTitleCell();
  inst._cells = [pw];
  PC._rowProto._renderCell.call(inst, 0, 'T', { dataKey: 'title' }, true);
  eq(ptw.children.length, 1, '⑦ 重挂后装饰恢复');
  PC.unregisterRow();   // 收尾还原，不留全局痕迹
  PrefStore.delete('progressRowEnabled');

  // 清理挂起的 800ms 重绘定时器（避免测试进程挂着不退）
  if (PC._refreshTimer) { clearTimeout(PC._refreshTimer); PC._refreshTimer = null; }

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    console.log('-'.repeat(60));
  }
  console.log('阅读进度与进度条测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
