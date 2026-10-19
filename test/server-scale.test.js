#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 服务端规模测试（服务端 1.8.6 审查 P1-4 / P1-10）
 *
 * 运行：node test/server-scale.test.js
 *
 * 覆盖：
 *   A 800 用户 / 500 订单 / 800 令牌 —— 启动即建索引，find* 不再 O(n) 扫描
 *   B 索引结果与线性扫描逐条一致（抽样 200 条，含大小写邮箱）
 *   C 索引未命中时退回线性并自愈（模拟漏维护，结果不能丢）
 *   D /api/health 连续 5 次只触发 1 次重算（backlog/audit 只算一次），
 *     且启动器依赖的字段一个不少；?detail=1 强制重算、?lite=1 只回核心字段
 *   E countUsage 连续 20 次只产生 1 次磁盘写；flush 后 20 次全部落盘
 *   F 性能前后对比（索引 vs 线性，同一批查找）
 *
 * 说明：本文件在 require 服务端**之前**写好人造数据目录，并把合并窗口/健康缓存
 *       调短，保证用例确定性。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-scale-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';
process.env.PP_USAGE_SAVE_DELAY_MS = '40';   // 合并窗口 40ms（生产默认 800ms）
process.env.PP_HEALTH_CACHE_MS = '5000';     // health 缓存 5s（生产默认 2s）

const N_USERS = 800;
const N_ORDERS = 500;
const N_TOKENS = 800;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ---------- 造数据（必须在 require 服务端之前落盘） ---------- */
const nowIso = new Date().toISOString();
const users = [];
for (let i = 0; i < N_USERS; i++) {
  const n = String(i).padStart(4, '0');
  users.push({
    id: 'u' + n,
    email: 'scale' + n + '@test.local',
    nickname: 'scale' + n,
    salt: '0'.repeat(32),
    hash: '0'.repeat(128),
    plan: 'Free',
    expiresAt: null,
    createdAt: nowIso,
    lastLoginAt: null,
    usage: { date: new Date().toISOString().slice(0, 10), count: 0 },
  });
}
const tokens = {};
for (let i = 0; i < N_TOKENS; i++) {
  const n = String(i).padStart(4, '0');
  tokens[sha256('scale-token-' + n)] = {
    userId: 'u' + n,
    expiresAt: Date.now() + 30 * 86400e3,
  };
}
fs.writeFileSync(path.join(WORK, 'users.json'), JSON.stringify({ users, tokens }, null, 2), 'utf8');

const membershipLib = require(path.join(__dirname, '..', 'server', 'lib', 'membership.js'));
const mdoc = membershipLib.newDoc();
for (let i = 0; i < N_ORDERS; i++) {
  const n = String(i).padStart(4, '0');
  mdoc.orders.push({
    id: 'o' + n,
    userId: 'u' + n,
    email: 'scale' + n + '@test.local',
    plan: 'Pro', months: 1,
    amount: 19.9, amountCents: 1990, baseCents: 1990, tailCents: 0,
    status: i % 2 === 0 ? 'pending' : 'claimed',
    createdAt: nowIso,
    updatedAt: nowIso,
    outTradeNo: 'PPSCALE' + n,
    kind: 'membership',
    payChannel: '',
    tradeNo: '',
    paidAt: null,
  });
}
fs.writeFileSync(path.join(WORK, 'membership.json'), JSON.stringify(mdoc, null, 2), 'utf8');

const mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
const { server, usersStore, membershipStore } = mod;

let PORT = 0;
let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    r.on('error', reject);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 线性兜底（对照组：索引未建时的原始实现） */
const linearUserByEmail = (email) =>
  usersStore.data.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null;
const linearUserById = (id) => usersStore.data.users.find((u) => u.id === id) || null;
const linearOrder = (id) => membershipStore.data.orders.find((o) => o && o.id === id) || null;
const linearOrderByTradeNo = (no) => membershipStore.data.orders.find((o) => o && o.outTradeNo === no) || null;

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  try {
    /* ================= A. 索引已建立 ================= */
    let st = mod.indexStats();
    eq(st.users, N_USERS, 'A1 启动即建立 userId 索引（800）', st);
    eq(st.usersByEmail, N_USERS, 'A2 启动即建立 email 索引（800）', st);
    eq(st.orders, N_ORDERS, 'A3 启动即建立 orderId 索引（500）', st);
    eq(st.ordersByTradeNo, N_ORDERS, 'A4 启动即建立 outTradeNo 索引（500）', st);
    eq(Object.keys(usersStore.data.tokens || {}).length, N_TOKENS, 'A5 800 个令牌已载入');

    /* ================= B. 索引 vs 线性：结果完全一致 ================= */
    let mismatch = 0;
    for (let i = 0; i < N_USERS; i += 4) {          // 抽样 200 条
      const n = String(i).padStart(4, '0');
      const email = 'scale' + n + '@test.local';
      const a = mod.findUserByEmail(email);
      const b = linearUserByEmail(email);
      if (!a || a !== b) mismatch += 1;
      // 大小写混写也必须命中同一条（登录时用户可能输入大写）
      const c = mod.findUserByEmail(email.toUpperCase());
      if (!c || c !== b) mismatch += 1;
      const d = mod.findUserById('u' + n);
      if (!d || d !== linearUserById('u' + n)) mismatch += 1;
    }
    eq(mismatch, 0, 'B1 200 个账号的邮箱/id 查找与线性结果逐条一致');

    mismatch = 0;
    for (let i = 0; i < N_ORDERS; i += 2) {         // 抽样 250 条
      const n = String(i).padStart(4, '0');
      const a = mod.findOrder('o' + n);
      const b = linearOrder('o' + n);
      if (!a || a !== b) mismatch += 1;
      const c = mod.findOrderByTradeNo('PPSCALE' + n);
      const d = linearOrderByTradeNo('PPSCALE' + n);
      if (!c || c !== d) mismatch += 1;
    }
    eq(mismatch, 0, 'B2 250 笔订单的 id/商户单号查找与线性结果逐条一致');
    eq(mod.findUserByEmail('nobody@test.local'), null, 'B3 不存在的邮箱返回 null');
    eq(mod.findOrderByTradeNo('NOPE'), null, 'B4 不存在的商户单号返回 null');

    /* ================= C. 索引漏维护 → 线性兜底并自愈 ================= */
    st = mod.indexStats();
    const hit0 = st.hits;
    const miss0 = st.misses;
    for (let i = 0; i < 100; i++) {
      mod.findUserByEmail('scale' + String(i).padStart(4, '0') + '@test.local');
    }
    st = mod.indexStats();
    eq(st.hits - hit0, 100, 'C1 100 次有效查找全部命中索引（0 次线性扫描）', st);
    eq(st.misses - miss0, 0, 'C2 命中路径不产生 misses');

    // 绕过维护点直接往数组里塞一条：第一次查找应走线性并补回索引
    usersStore.data.users.push({
      id: 'u-should-be-found', email: 'late@test.local', plan: 'Free',
      createdAt: nowIso, usage: { date: nowIso.slice(0, 10), count: 0 },
    });
    const late = mod.findUserByEmail('late@test.local');
    ok(late && late.id === 'u-should-be-found', 'C3 ★ 索引未覆盖时退回线性扫描，结果不丢');
    st = mod.indexStats();
    const afterLate = mod.findUserByEmail('late@test.local');
    ok(afterLate === late && mod.indexStats().misses === st.misses,
      'C4 线性命中后自动补索引，下一次即命中');
    // 收尾：把这条人造用户移出，保持 800 的基线
    const li = usersStore.data.users.findIndex((u) => u.id === 'u-should-be-found');
    if (li >= 0) usersStore.data.users.splice(li, 1);
    mod.reloadStores();
    eq(mod.indexStats().users, N_USERS, 'C5 reloadStores 后索引按磁盘重建（回到 800）');

    /* ================= D. health 缓存与字段契约 ================= */
    let hs = mod.healthStats();
    const computes0 = hs.computes;
    const hits0 = hs.hits;
    const r1 = await req('GET', '/api/health');
    for (let i = 0; i < 4; i++) await req('GET', '/api/health');
    hs = mod.healthStats();
    eq(r1.status, 200, 'D1 health 200');
    eq(hs.computes - computes0, 1, 'D2 ★ 连续 5 次 health 只重算 1 次（backlog/audit 各只算一次）', hs);
    eq(hs.hits - hits0, 4, 'D3 其余 4 次全部命中缓存', hs);
    // 启动器 scripts/launcher.ps1 实际读取的字段一个都不能少
    const launcherFields = ['pid', 'version', 'lagMs', 'maxLagMs', 'users', 'orders',
      'ordersAwaitingReview', 'backlogCount', 'backlogOverdue', 'backlogOldestMinutes', 'channels'];
    const missing = launcherFields.filter((k) => r1.json[k] === undefined);
    eq(missing.length, 0, 'D4 ★ 启动器依赖的 health 字段齐全（默认仍返回全量）', missing);
    eq(r1.json.users, N_USERS, 'D5 health.users 是真实用户数');
    eq(r1.json.orders, N_ORDERS, 'D6 health.orders 是真实订单数');
    ok(typeof r1.json.cachedAgeMs === 'number', 'D7 返回缓存年龄，便于观察是否为旧值');

    const computes1 = mod.healthStats().computes;
    await req('GET', '/api/health?detail=1');
    eq(mod.healthStats().computes - computes1, 1, 'D8 ?detail=1 强制重算一次');

    const rLite = await req('GET', '/api/health?lite=1');
    const keys = Object.keys(rLite.json).sort().join(',');
    eq(keys, 'degraded,lagMs,maxLagMs,ok,orders,pid,users,version', 'D9 ?lite=1 只回 liveness 核心字段', keys);

    /* ================= E. countUsage 合并写 ================= */
    const user = mod.findUserByEmail('scale0000@test.local');
    ok(!!user, 'E0 取到测试账号');
    const writes0 = mod.usersWriter.stats().writes;
    const count0 = Number((user.usage || {}).count) || 0;
    for (let i = 0; i < 20; i++) mod.countUsage(user, null);   // 只记次数（与旧行为一致）
    await sleep(180);                                          // 等合并窗口 + 一次异步落盘
    const ws = mod.usersWriter.stats();
    eq(ws.writes - writes0, 1, 'E1 ★ 连续 20 次 countUsage 只产生 1 次磁盘写', ws);
    ok(ws.coalesced >= 19, 'E2 其余 19 次被合并（coalesced）', ws);

    // shutdown 语义：flush 后数据必须完整（20 次一次不少）
    mod.flushStores();
    const disk = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
    const du = disk.users.find((x) => x.email === 'scale0000@test.local');
    eq(Number((du.usage || {}).count) - count0, 20, 'E3 ★ flush 后 20 次计量全部落盘（不丢）');
    eq(mod.usersWriter.stats().pending, false, 'E4 flush 后无待写快照');

    /* ================= F. 性能对比（同进程，同一批 800 次查找） ================= */
    const ids = users.map((_, i) => 'u' + String(i).padStart(4, '0'));
    const emailList = users.map((_, i) => 'scale' + String(i).padStart(4, '0') + '@test.local');
    const t0 = Date.now();
    for (const e of emailList) mod.findUserByEmail(e);
    const tIdx = Date.now() - t0;
    const t1 = Date.now();
    for (const e of emailList) linearUserByEmail(e);
    const tLin = Date.now() - t1;

    const o0 = Date.now();
    for (let i = 0; i < N_ORDERS; i++) mod.findOrder('o' + String(i).padStart(4, '0'));
    const tOrderIdx = Date.now() - o0;
    const o1 = Date.now();
    for (let i = 0; i < N_ORDERS; i++) linearOrder('o' + String(i).padStart(4, '0'));
    const tOrderLin = Date.now() - o1;

    console.log('\n性能对比（800 用户 / 500 订单，单进程同一批查找）');
    console.log('  用户邮箱 ×800：索引 ' + tIdx + 'ms  vs 线性 ' + tLin + 'ms');
    console.log('  订单 id ×500：索引 ' + tOrderIdx + 'ms  vs 线性 ' + tOrderLin + 'ms');
    console.log('  health：5 次请求只重算 1 次（缓存 5s）');
    // 只做趋势断言，避免 CI 机器抖动导致偶发失败
    ok(tIdx <= tLin, 'F1 索引查找不慢于线性扫描', { idx: tIdx, linear: tLin });
    ok(tOrderIdx <= tOrderLin, 'F2 订单索引查找不慢于线性扫描', { idx: tOrderIdx, linear: tOrderLin });
    ok(ids.length === N_USERS, 'F3 数据集规模符合预期');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    try { server.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n服务端规模测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
