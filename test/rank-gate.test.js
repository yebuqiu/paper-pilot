#!/usr/bin/env node
/* 期刊分区列 · 内置官方 Key 的套餐门控测试（插件 0.41.0）
 *
 * 背景：内置 easyScholar SecretKey 由运营者持有、消耗运营者配额。
 * 0.41.0 起改为「自带 Key 永远优先；已登录的专业版 / 新用户试用期可用内置 Key；
 * 免费版（试用结束后）与未登录须自带 Key」。
 *
 * 为什么值得单独一层测试：
 *   - 门控写成「不知道就锁」会**一次性锁死所有老服务端用户**（同模型分级的历史教训）；
 *   - 门控写反（漏掉 isPro → 所有人都能用）则 Pro 权益形同虚设；
 *   - 内置 Key 常量若被别处直接引用，门控会被绕过 —— 用**引用计数**钉死。
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

const PREFIX = 'extensions.zotero.paperpilot.';
const PrefStore = new Map();
const Prefs = {
  get: (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d),
  set: (k, v) => { PrefStore.set(PREFIX + k, v); },
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

function setAccount(a) { sandbox.Account = a; }
const OFFICIAL = RC.ES_OFFICIAL_KEY;
const freeUser = { isLoggedIn: () => true, isPro: () => false, ai: () => ({ reason: 'none' }) };
const proUser = { isLoggedIn: () => true, isPro: () => true, ai: () => ({ reason: 'plan' }) };
const trialUser = { isLoggedIn: () => true, isPro: () => false, ai: () => ({ reason: 'trial' }) };

/* ---------------- ① 常量与引用面 ---------------- */

ok(typeof OFFICIAL === 'string' && OFFICIAL.length >= 16, 'K1 内置官方 Key 常量存在且非空');

// 引用计数钉死：只允许「常量定义」与「esKey()」两处。
// 别处若直接 this.ES_OFFICIAL_KEY 就是**绕过门控**，必须报错。
const refs = (SRC.match(/ES_OFFICIAL_KEY/g) || []).length;
eq(refs, 2, 'K2 ★ 内置 Key 只有 2 处引用（定义 + esKey），别处直接引用＝绕过门控');

/* ---------------- ② 自带 Key 永远优先 ---------------- */

delete sandbox.Account;                       // 连账号模块都没有
Prefs.set('easyScholarKey', 'my-own-key');
eq(RC.esKey(), 'my-own-key', 'K3 自带 Key 优先（账号模块缺失时一样）');
eq(RC.esStatus(), 'ok', 'K4 自带 Key ⇒ 状态 ok');
Prefs.set('easyScholarKey', '');
PrefStore.delete(PREFIX + 'easyScholarKey');

/* ---------------- ③ 未登录 ⇒ 须自带 Key ---------------- */

setAccount({ isLoggedIn: () => false, isPro: () => false, ai: () => ({ reason: 'none' }) });
eq(RC.esKey(), '', 'K5 ★ 未登录 ⇒ 不给内置 Key（试用挂账号上，判定不了就不放行）');
eq(RC.esStatus(), 'need_key', 'K6 未登录 ⇒ 状态 need_key');

/* ---------------- ④ 已登录：Pro / 试用可用 ---------------- */

setAccount(proUser);
eq(RC.esKey(), OFFICIAL, 'K7 已登录 + 专业版 ⇒ 用内置官方 Key');
eq(RC.esStatus(), 'ok', 'K8 专业版 ⇒ 状态 ok');

setAccount(trialUser);
eq(RC.esKey(), OFFICIAL, 'K9 已登录 + 新用户试用期 ⇒ 用内置官方 Key');

/* ---------------- ⑤ 已登录免费（试用结束）⇒ 不给 ---------------- */

setAccount(freeUser);
eq(RC.esKey(), '', 'K10 ★ 已登录 + 免费（试用结束）⇒ 不给内置 Key');
eq(RC.esStatus(), 'need_key', 'K11 免费 ⇒ 状态 need_key（设置页据此给指引）');

/* ---------------- ⑥ 探测不到 / 异常 ⇒ 一律放行 ---------------- */

setAccount({ isLoggedIn: () => true, isPro: () => false, ai: () => ({ reason: 'unknown' }) });
eq(RC.esKey(), OFFICIAL, 'K12 ★ 旧服务端（ai.reason=unknown）⇒ 放行，不惩罚老用户');

setAccount({ isLoggedIn: () => true, isPro: () => { throw new Error('boom'); }, ai: () => ({ reason: 'none' }) });
eq(RC.esKey(), OFFICIAL, 'K13 ★ 套餐判定抛错 ⇒ 放行（绝不因异常锁用户）');

setAccount({ isPro: () => true, ai: () => ({ reason: 'plan' }) });   // 老形状：无 isLoggedIn
eq(RC.esKey(), OFFICIAL, 'K14 Account 无 isLoggedIn 方法 ⇒ 按已登录处理');

setAccount({ });
eq(RC.esKey(), OFFICIAL, 'K15 Account 形状异常（无任何方法）⇒ 放行');

delete sandbox.Account;
eq(RC.esKey(), OFFICIAL, 'K16 账号模块未加载 ⇒ 放行');

/* ---------------- ⑦ 在线开关与状态联动 ---------------- */

setAccount(proUser);
Prefs.set('easyScholarEnabled', true);
eq(RC._esEnabled(), true, 'K17 专业版 + 开启在线 ⇒ 在线源启用');

Prefs.set('easyScholarEnabled', false);
eq(RC._esEnabled(), false, 'K18 用户关闭在线 ⇒ 在线源不启用');
eq(RC.esStatus(), 'off', 'K19 用户关闭在线 ⇒ 状态 off');
Prefs.set('easyScholarEnabled', true);

setAccount(freeUser);
eq(RC._esEnabled(), false, 'K20 ★ 免费版 ⇒ 在线源不启用（Key 为空）');
eq(RC.esStatus(), 'need_key', 'K21 免费版状态仍为 need_key（不是 off）');

/* ---------------- ⑧ 免费版不白屏：内置数据兜底仍走通 ---------------- */

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
ok(!threw, 'K22 ★ 免费版 lookup 不抛错（在线源关闭后仍走离线兜底）', threw && threw.message);
eq(out, null, 'K23 内置数据无该刊 ⇒ 返回 null（列留空，不伪造数据）');

console.log('\n期刊分区列门控测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ 全部通过');
