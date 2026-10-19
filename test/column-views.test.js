#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 视图组（列组合预设）· 数据模型与菜单测试（插件 0.43.0）
 *
 * 为什么要有它：视图组的核心是「pref JSON 序列化 + 快照/应用/删除」的纯逻辑，
 * 出问题表现为「保存的视图丢了 / 应用后列没切换 / 内置预设反复复活」——
 * 都是静默失败，必须真跑一遍：
 *   ① 内置默认预设幂等补种（无 pref 才补；用户删光后 pref="[]" 不复活）；
 *   ② 快照：读取当前 5 个 *ColumnEnabled pref + 原生列 _columnPrefs；
 *   ③ 应用视图：断言写对了哪些 pref（插件列），原生列 hidden 尽力而为同步；
 *   ④ 保存：新名字新增、同名覆盖（不膨胀）；
 *   ⑤ 删除：按 id 移除，序列化 round-trip 不丢字段；
 *   ⑥ 菜单装配：预设点击=应用，「删除视图 ▸ 名字」动态项点击=删除。
 *
 * 运行：node test/column-views.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TQ_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'toolbar-quick.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM（与 toolbar-quick.test.js 同款） ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this._attrs = {};
    this.id = ''; this.parentNode = null; this.handlers = {};
  }
  setAttribute(k, v) { if (k === 'id') this.id = String(v); this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  fire(e, a) {
    const ev = Object.assign({ target: this, stopPropagation() {} }, a || {});
    for (const f of (this.handlers[e] || []).slice()) f(ev);
  }
  all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
}

/** 桩环境：Prefs 用 Map（可读回写结果）；原生列 itemsView 可注入 */
function makeEnv(opts) {
  opts = opts || {};
  const prefStore = new Map(Object.entries(opts.prefs || {}));
  const prefWrites = []; // [key, value] 按写入顺序
  const storeCalls = [];
  const itemsView = opts.itemsView === undefined ? {
    _columnPrefs: {
      title: { hidden: false, ordinal: 1 },
      firstCreator: { hidden: false, ordinal: 2 },
      dateAdded: { hidden: true, ordinal: 3 },
    },
    _storeColumnPrefs(p) { storeCalls.push(Object.keys(p).length); },
  } : opts.itemsView;
  const win = itemsView ? { ZoteroPane: { itemsView } } : null;
  const sandbox = {
    Zotero: {
      Papilot: { openHub: () => {} },
      getMainWindows: () => (win ? [win] : []),
      getMainWindow: () => win,
      ItemTreeManager: { refreshColumns: () => {} },
    },
    Services: {
      prompt: {
        prompt: (w, t, text, input) => {
          if (opts.promptValue === undefined) return false; // 用户取消
          input.value = opts.promptValue;
          return true;
        },
        alert: () => {},
      },
    },
    Prefs: {
      get: (k, d) => (prefStore.has(k) ? prefStore.get(k) : d),
      set: (k, v) => { prefWrites.push([k, v]); prefStore.set(k, v); },
    },
    I18n: { t: (k) => '«' + k + '»' },
    Menus: { _quickItems: () => [], openChatFloat: () => {}, openSettings: () => {} },
    PdfDual: { openForSelected: () => {} },
    console, Math, Date, Set, Array, String, JSON, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(TQ_JS, 'utf8'), sandbox, { filename: 'toolbar-quick.js' });
  return { sandbox, prefStore, prefWrites, storeCalls, itemsView };
}

/* ---------------- ① 内置默认预设幂等补种 ---------------- */
{
  const { sandbox, prefStore } = makeEnv();
  const CV = sandbox.ColumnViews;
  const views = CV.list();
  eq(views.length, 2, '① 无 pref 首次 list → 补种 2 个内置预设');
  eq(views[0].name, '阅读视图', '① 内置预设一');
  eq(views[1].name, '选刊视图', '① 内置预设二');
  eq(typeof prefStore.get('columnViews'), 'string', '① 已写入 pref（JSON 字符串）');
  // 幂等：再次 list 不重复追加
  eq(CV.list().length, 2, '① 再次 list 不重复补种');
  // 序列化 round-trip
  const back = JSON.parse(prefStore.get('columnViews'));
  eq(back.length, 2, '① JSON round-trip 不丢条目');
  ok(back[0].columns && back[0].columns.progress === true && back[0].columns.rank === false,
    '① 阅读视图 = 进度开/分区关', back[0].columns);
  ok(back[1].columns.rank === true && back[1].columns.citation === true && back[1].columns.progress === false,
    '① 选刊视图 = 分区+被引量开、其余关', back[1].columns);
  // 用户删光后不复活
  prefStore.set('columnViews', '[]');
  eq(CV.list().length, 0, '① 用户删光（pref="[]"）后不复活');
}

/* ---------------- ② 快照 ---------------- */
{
  const { sandbox } = makeEnv({ prefs: { rankColumnEnabled: false, ratingColumnEnabled: false } });
  const snap = sandbox.ColumnViews.snapshot();
  eq(snap.columns.rank, false, '② 快照读到 rank 关');
  eq(snap.columns.rating, false, '② 快照读到 rating 关');
  eq(snap.columns.progress, true, '② 快照缺省 pref 按默认 true');
  eq(snap.native.dateAdded, true, '② 快照含原生列 hidden（dateAdded 隐藏）');
  eq(snap.native.title, false, '② 快照含原生列 hidden（title 显示）');
  const noNative = makeEnv({ itemsView: null });
  eq(noNative.sandbox.ColumnViews.snapshot().native, null, '② 无 itemsView 时 native=null 不抛错');
}

/* ---------------- ③ 应用视图：断言写了哪些 pref + 原生列同步 ---------------- */
{
  const { sandbox, prefWrites, storeCalls, itemsView } = makeEnv();
  const CV = sandbox.ColumnViews;
  const reading = CV.list()[0];
  prefWrites.length = 0;
  ok(CV.apply(reading.id), '③ 应用阅读视图返回 true');
  const written = Object.fromEntries(prefWrites.filter(([k]) => k.endsWith('ColumnEnabled')));
  eq(written.rankColumnEnabled, false, '③ 写 rankColumnEnabled=false');
  eq(written.citationColumnEnabled, false, '③ 写 citationColumnEnabled=false');
  eq(written.titleTranslationColumnEnabled, true, '③ 写 titleTranslationColumnEnabled=true');
  eq(written.progressColumnEnabled, true, '③ 写 progressColumnEnabled=true');
  eq(written.ratingColumnEnabled, true, '③ 写 ratingColumnEnabled=true');

  // 自定义视图带 native：hidden 同步进 _columnPrefs 并触发持久化
  const custom = {
    id: 'vx', name: '自定义', columns: { rank: true },
    native: { title: true, dateAdded: false },
  };
  sandbox.Prefs.set('columnViews', JSON.stringify([custom]));
  ok(CV.apply('vx'), '③ 应用带 native 的视图');
  eq(itemsView._columnPrefs.title.hidden, true, '③ 原生列 title 被隐藏');
  eq(itemsView._columnPrefs.dateAdded.hidden, false, '③ 原生列 dateAdded 被恢复显示');
  ok(storeCalls.length >= 1, '③ 调 _storeColumnPrefs 持久化原生列');
  ok(CV.apply('no-such-id') === false, '③ 未知 id 安全返回 false');
}

/* ---------------- ④ 保存：新增 / 同名覆盖 ---------------- */
{
  const { sandbox } = makeEnv();
  const CV = sandbox.ColumnViews;
  CV.list(); // 补种
  const v1 = CV.save('我的视图');
  ok(v1 && v1.id && v1.name === '我的视图', '④ 保存返回预设对象');
  eq(CV.list().length, 3, '④ 新增后共 3 个');
  const again = CV.save('我的视图');
  eq(again.id, v1.id, '④ 同名保存 = 覆盖（id 不变）');
  eq(CV.list().length, 3, '④ 同名覆盖不膨胀');
  eq(CV.save('   '), null, '④ 空白名字拒绝保存');
}

/* ---------------- ⑤ 删除 ---------------- */
{
  const { sandbox, prefStore } = makeEnv();
  const CV = sandbox.ColumnViews;
  const views = CV.list();
  CV.remove(views[0].id);
  const left = CV.list();
  eq(left.length, 1, '⑤ 删除后剩 1 个');
  eq(left[0].id, 'view-journal', '⑤ 删的是阅读视图');
  eq(JSON.parse(prefStore.get('columnViews')).length, 1, '⑤ pref 同步更新');
  CV.remove('not-exists');
  eq(CV.list().length, 1, '⑤ 删除未知 id 无副作用');
}

/* ---------------- ⑥ 菜单装配：点击应用 / 删除 ---------------- */
{
  const { sandbox, prefWrites } = makeEnv();
  const doc = { createElementNS: (ns, tag) => new El(tag), getElementById: () => null };
  const popup = new El('menupopup');
  sandbox.ToolbarQuick._fillQuickMenu(doc, popup);
  const items = popup.byTag('menuitem');
  const byLabel = (l) => items.find((i) => i.getAttribute('label') === l);
  ok(!!byLabel('保存当前为视图…'), '⑥ 有「保存当前为视图…」');
  ok(!!byLabel('阅读视图') && !!byLabel('选刊视图'), '⑥ 预设列出');
  ok(!!byLabel('删除视图 ▸ 阅读视图'), '⑥ 删除动态项列出');

  // 点击「选刊视图」→ 应用（rank/citation 开）
  prefWrites.length = 0;
  byLabel('选刊视图').fire('command');
  const written = Object.fromEntries(prefWrites.filter(([k]) => k.endsWith('ColumnEnabled')));
  eq(written.rankColumnEnabled, true, '⑥ 点击预设 → 应用（rank 开）');
  eq(written.progressColumnEnabled, false, '⑥ 点击预设 → 应用（progress 关）');

  // 点击「删除视图 ▸ 选刊视图」→ 删除
  byLabel('删除视图 ▸ 选刊视图').fire('command');
  eq(sandbox.ColumnViews.list().length, 1, '⑥ 点击删除项 → 预设被删');
}

console.log('column-views: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
