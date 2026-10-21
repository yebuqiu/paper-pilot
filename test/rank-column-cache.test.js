#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 期刊分区列 · 条目级负缓存与渲染 pref 预算缓存测试（审查 P1-4；Node vm 桩）
 *
 * 钉住的契约：
 *   ① bundled/custom 均 miss 的空结果（含 null）写入 _lookupCache——
 *      第二次 lookup 不再重扫两张离线表（_match 调用计数为证）；
 *   ② 正结果照常缓存；
 *   ③ easyScholar **瞬态**负缓存（retryAfter 未到期）不写入条目级缓存，
 *      到期后重新 lookup 能触发自动重查（返回 pending 并入队）；
 *   ④ easyScholar **永久**负缓存（无数据，无 retryAfter）可以缓存
 *     （永不自动过期，esClearCache / pref 变化通道统一清）；
 *   ⑤ renderCell 热路径读 _renderPrefs 预算缓存：_refreshRenderPrefs 建立后
 *      不再读 pref；pref 变更后须显式刷新才生效（observer 通道的职责）。
 *
 * 运行：node test/rank-column-cache.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = 'chrome/content/scripts/columns/rank-column.js';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境（与 rank-gate.test.js 同款 Prefs 前缀语义） ---------------- */

const PREFIX = 'extensions.zotero.papilot.';
const PrefStore = new Map();
const Prefs = {
  get: (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d),
  set: (k, v) => { PrefStore.set(PREFIX + k, v); },
  clear: (k) => { PrefStore.delete(PREFIX + k); },
};

const sandbox = {
  console, Prefs,
  Zotero: { debug() {}, logError() {}, ItemTreeManager: {}, Notifier: { trigger() {} } },
  I18n: { t: (k) => k, isZh: true },
  PathUtils: { join: (...a) => a.join('/') },
  IOUtils: { readUTF8: async () => { throw new Error('no file'); }, writeUTF8: async () => {} },
  setTimeout, clearTimeout, Promise, Date, Math, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), sandbox, { filename: FILE });
const RC = sandbox.RankColumn;

const mkItem = (id, pub) => ({
  id, isRegularItem: () => true,
  getField: (f) => (f === 'publicationTitle' ? pub : f === 'journalAbbreviation' ? '' : ''),
});

(async () => {
/* ---------------- ① 离线 miss → 负缓存（不再重扫表） ---------------- */

// 无 Key → 在线源停用，纯离线路径
RC._data = {};
RC._customData = {};
RC._lookupCache = new Map();

// _match 计数桩：第二次 lookup 若缓存命中，_match 一次都不该再调
let matchCalls = 0;
const origMatch = RC._match.bind(RC);
RC._match = (name, table) => { matchCalls++; return origMatch(name, table); };

const itMiss = mkItem(9101, 'Journal of Nowhere');
eq(RC.lookup(itMiss), null, '① 离线 miss → null（列留空，不伪造数据）');
const firstCalls = matchCalls;
ok(firstCalls > 0, '① 首次 lookup 确实扫过离线表（_match 被调 ' + firstCalls + ' 次）');
eq(RC._lookupCache.has(9101), true, '① ★ miss 结果写入条目级负缓存');
eq(RC._lookupCache.get(9101), null, '① 负缓存值为 null');
eq(RC.lookup(itMiss), null, '① 第二次 lookup 仍 null');
eq(matchCalls, firstCalls, '① ★ 第二次 lookup 零 _match 调用（缓存命中，不重扫）');

/* ---------------- ② 正结果照常缓存 ---------------- */

RC._data = { nature: '1区 Top' };   // normalize("Nature") = "nature"
RC._lookupCache = new Map();
matchCalls = 0;
const itHit = mkItem(9102, 'Nature');
const hit1 = RC.lookup(itHit);
ok(hit1 && hit1.text && hit1.text.indexOf('中科院') >= 0, '② 内置数据命中 → 结构化徽章');
eq(RC._lookupCache.has(9102), true, '② 正结果缓存');
const hitCalls = matchCalls;
const hit2 = RC.lookup(itHit);
eq(hit2, hit1, '② 第二次返回同一缓存对象');
eq(matchCalls, hitCalls, '② 第二次零 _match 调用（缓存命中）');

/* ---------------- ③ easyScholar 瞬态负缓存：不写条目级缓存，到期可重查 ---------------- */

Prefs.set('easyScholarKey', 'own-key');
Prefs.set('easyScholarEnabled', true);
RC._lookupCache = new Map();
RC._esCache = new Map();
RC._esQueued = new Set();
RC._esQueue = [];
RC._esCacheLoaded = true;            // 跳过读盘
RC._pendingRefresh = new Set();

const pub3 = 'Transient Failure Journal';
const norm3 = RC.normalize(pub3);
// 瞬态失败：30 分钟后才允许重试
RC._esCache.set(norm3, { neg: 1, t: Date.now(), retryAfter: Date.now() + 30 * 60 * 1000, failReason: '查询失败: boom' });

const itT = mkItem(9103, pub3);
const outT = RC.lookup(itT);
ok(outT && outT.text === '' && (outT.badges || []).length === 0, '③ 瞬态负缓存 → 空结果（不伪造）');
eq(RC._lookupCache.has(9103), false, '③ ★ 瞬态负缓存不写条目级缓存（到期要能自动重查）');

// 到期后：重新 lookup → 删旧条目 + 重新发起查询（_esWork 异步跑完限速循环）
// _esFetch 桩掉（不联网）：查询立即失败 → 重新写入**新的**瞬态负缓存（retryAfter 刷新）
RC._esFetch = async () => { throw new Error('boom'); };
RC._esCache.get(norm3).retryAfter = Date.now() - 1;
const outT2 = RC.lookup(itT);
ok(outT2 && outT2.pending === true, '③ ★ 到期后重新 lookup 触发重查（pending 占位）');
eq(RC._lookupCache.has(9103), false, '③ pending 占位同样不缓存');
eq(RC._esCache.has(norm3), false, '③ 旧负缓存已删除（重查进行中）');
ok(RC._pendingRefresh.has(9103), '③ 等待刷新集合记录该条目（数据到达后精准 redraw）');
await new Promise((r) => setTimeout(r, 30));   // 等 _esFetch 失败落定
const reNeg = RC._esCache.get(norm3);
ok(reNeg && reNeg.neg === 1 && reNeg.retryAfter > Date.now(),
  '③ ★ 重查完成后写入新的瞬态负缓存（retryAfter 重新起算）');

/* ---------------- ④ easyScholar 永久负缓存（无数据）可以缓存 ---------------- */

const pub4 = 'No Data Journal';
const norm4 = RC.normalize(pub4);
RC._esCache.set(norm4, { neg: 1, t: Date.now(), failReason: 'easyScholar 无此期刊分区数据' });
const itN = mkItem(9104, pub4);
const outN = RC.lookup(itN);
ok(outN && outT.text === '' && outN.detail.indexOf('无此期刊') >= 0, '④ 永久负缓存 → 空结果带原因');
eq(RC._lookupCache.has(9104), true, '④ ★ 永久负缓存可缓存（不会自动过期，无重查语义被破坏）');

// 清缓存通道统一生效（esClearCache / pref 变化都 clear _lookupCache）
RC._esQueue = [];
RC._esQueued = new Set();
RC._esSaveTimer && clearTimeout(RC._esSaveTimer);
RC._esRefreshTimer && clearTimeout(RC._esRefreshTimer);
await RC.esClearCache();
eq(RC._lookupCache.size, 0, '④ esClearCache 连带清空条目级负缓存');

/* ---------------- ⑤ 渲染 pref 预算缓存 ---------------- */

RC._renderPrefs = null;
Prefs.clear('rankDataSets');
Prefs.clear('rankMaxBadges');
Prefs.clear('rankBadgeStyle');
const rp1 = RC._refreshRenderPrefs();
// 注意：vm 沙箱内外的 Set 是不同 realm 的对象，不能 instanceof，按鸭子类型断言
ok(rp1.kinds && typeof rp1.kinds.has === 'function' && rp1.kinds.has('jcr'),
  '⑤ 预算缓存建立（默认数据集含 jcr）');
eq(rp1.max, 6, '⑤ 默认 maxBadges=6');
eq(rp1.mono, false, '⑤ 默认彩色模式');

// pref 变更后不刷新：缓存保持旧值（renderCell 读缓存 → 每行零 pref 读）
Prefs.set('rankMaxBadges', 3);
Prefs.set('rankBadgeStyle', 'mono');
eq(RC._renderPrefs.max, 6, '⑤ pref 变了缓存不自动变（observer 负责刷新，热路径零开销）');
const rp2 = RC._refreshRenderPrefs();
eq(rp2.max, 3, '⑤ ★ 刷新后 max=3');
eq(rp2.mono, true, '⑤ 刷新后 mono=true');
Prefs.set('rankDataSets', 'jcr,cas,bogus-kind');
ok(RC._refreshRenderPrefs().kinds.has('cas') && !RC._renderPrefs.kinds.has('bogus-kind'),
  '⑤ 数据集过滤非法 kind');

// _badgeCss 第二参（热路径传入缓存 mono）与旧单参调用等价
const badge = { kind: 'jcr', text: 'Q1', level: 1 };
ok(RC._badgeCss(badge, true).indexOf('--color-accent') >= 0, '⑤ mono=true → 主题色');
ok(RC._badgeCss(badge, false).indexOf('#c0392b') >= 0, '⑤ mono=false → JCR Q1 红');
Prefs.clear('rankBadgeStyle');
ok(RC._badgeCss(badge).indexOf('#c0392b') >= 0, '⑤ 不传第二参 → 实时读 pref（旧行为兼容）');

// 清理 _esWork 限速循环与落盘定时器（避免测试进程挂着不退）
RC._esQueue = [];
if (RC._esSaveTimer) { clearTimeout(RC._esSaveTimer); RC._esSaveTimer = null; }
if (RC._esRefreshTimer) { clearTimeout(RC._esRefreshTimer); RC._esRefreshTimer = null; }
await new Promise((r) => setTimeout(r, 450));

/* ---------------- 输出 ---------------- */
console.log('='.repeat(60));
if (fails.length) {
  for (const f of fails) console.log('  x ' + f);
  console.log('-'.repeat(60));
}
console.log('分区列负缓存与渲染缓存测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
console.log('='.repeat(60));
process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
