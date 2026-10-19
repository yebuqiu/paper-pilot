#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 期刊分区列 · easyScholar Key 取值与在线源状态测试（插件 0.56.0）
 *
 * 背景：0.56.0 移除了内置官方 SecretKey（第三方账号的 Key 不具备可转让的商用授权，
 * 随插件明文分发给终端用户使用不合法）。现在的规则只有两条：
 *   1) 只认用户自备的 Key（pref easyScholarKey）；
 *   2) 没有 Key 时在线源整体停用，分区列回落内置离线数据集，不联网、不报错。
 *
 * 这一层测试要钉住的回归点：
 *   - 任何形式的「内置 Key」常量都不能复活（引用计数）；
 *   - Key 取值不能再受登录态/套餐影响（旧实现在这里分叉，是本次移除的重点）；
 *   - 无 Key 时 lookup 不能抛错、不能伪造数据（列留空）。
 *
 * 运行：node test/rank-gate.test.js
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

/* ---------------- 桩环境 ---------------- */

const PREFIX = 'extensions.zotero.papilot.';
const PrefStore = new Map();
const Prefs = {
  get: (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d),
  set: (k, v) => { PrefStore.set(PREFIX + k, v); },
  clear: (k) => { PrefStore.delete(PREFIX + k); },
};

const sandbox = {
  console, Prefs,
  Zotero: { debug() {}, logError() {}, ItemTreeManager: {} },
  I18n: { t: (k) => k, isZh: true },
  PathUtils: { join: (...a) => a.join('/') },
  IOUtils: { readUTF8: async () => { throw new Error('no file'); }, writeUTF8: async () => {} },
  setTimeout, clearTimeout, Promise, Date, Math, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
vm.runInContext(SRC, sandbox, { filename: FILE });
const RC = sandbox.RankColumn;

/* ---------------- ① 内置 Key 已彻底移除 ---------------- */

eq(typeof RC.ES_OFFICIAL_KEY, 'undefined', 'K1 ★ 内置官方 Key 常量已移除');
eq((SRC.match(/ES_OFFICIAL_KEY/g) || []).length, 0, 'K2 ★ 源码中零处引用（防止死灰复燃）');
eq((SRC.match(/_officialKeyAllowed/g) || []).length, 0, 'K3 套餐门控方法已移除（Key 不再与套餐挂钩）');

/* ---------------- ② 只认用户自备 Key，且与账号/套餐无关 ---------------- */

Prefs.set('easyScholarKey', 'my-own-key');

delete sandbox.Account;                       // 账号模块未加载
eq(RC.esKey(), 'my-own-key', 'K4 账号模块缺失时仍取用户 Key（不再依赖账号判定）');

sandbox.Account = { isLoggedIn: () => false, isPro: () => false, ai: () => ({ reason: 'none' }) };
eq(RC.esKey(), 'my-own-key', 'K5 ★ 未登录也照常使用自己的 Key');

sandbox.Account = { isLoggedIn: () => true, isPro: () => false, ai: () => ({ reason: 'none' }) };
eq(RC.esKey(), 'my-own-key', 'K6 免费用户同样可用自己的 Key');

sandbox.Account = { isLoggedIn: () => true, isPro: () => true, ai: () => ({ reason: 'plan' }) };
eq(RC.esKey(), 'my-own-key', 'K7 专业版不改变取值来源');

sandbox.Account = { isPro: () => { throw new Error('boom'); } };
eq(RC.esKey(), 'my-own-key', 'K8 套餐判定抛错也不影响（压根不调用它）');

/* ---------------- ③ 无 Key ⇒ 在线源停用，状态可解释 ---------------- */

Prefs.clear('easyScholarKey');
delete sandbox.Account;
eq(RC.esKey(), '', 'K9 无 Key ⇒ 空串');
eq(RC.esStatus(), 'need_key', 'K10 无 Key ⇒ 状态 need_key（设置页据此给指引）');
eq(RC._esEnabled(), false, 'K11 ★ 无 Key ⇒ 在线源不启用（不会发出任何请求）');

Prefs.set('easyScholarKey', '   ');
eq(RC.esKey(), '', 'K12 Key 全空白视为未填写（trim）');
Prefs.clear('easyScholarKey');

/* ---------------- ④ 开关与状态联动 ---------------- */

Prefs.set('easyScholarKey', 'my-own-key');
Prefs.set('easyScholarEnabled', true);
eq(RC.esStatus(), 'ok', 'K13 有 Key + 开启 ⇒ 状态 ok');
eq(RC._esEnabled(), true, 'K14 有 Key + 开启 ⇒ 在线源启用');

Prefs.set('easyScholarEnabled', false);
eq(RC.esStatus(), 'off', 'K15 用户关闭在线 ⇒ 状态 off');
eq(RC._esEnabled(), false, 'K16 用户关闭在线 ⇒ 在线源不启用');
Prefs.set('easyScholarEnabled', true);

/* ---------------- ⑤ 无 Key 时不白屏：离线兜底仍走通 ---------------- */

Prefs.clear('easyScholarKey');
RC._customData = {};
RC._data = {};
RC._lookupCache = new Map();
const item = {
  id: 9001, isRegularItem: () => true,
  getField: (f) => (f === 'publicationTitle' ? 'Nature' : ''),
};
let threw = null;
let out = null;
try { out = RC.lookup(item); } catch (e) { threw = e; }
ok(!threw, 'K17 ★ 无 Key 时 lookup 不抛错（在线源停用后仍走离线兜底）', threw && threw.message);
eq(out, null, 'K18 内置数据无该刊 ⇒ 返回 null（列留空，不伪造数据）');

console.log('\n期刊分区列 Key 与在线源状态测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ 全部通过');
