#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 余额流水接口（R5 · GET /api/balance/ledger，服务端 1.9.3）
 *
 * 运行：node test/balance-ledger.test.js
 *
 * 覆盖（契约 docs/prd/2026-10-23-账号与会员增强-架构.md §2.4 / §8）：
 *   1. 注册赠送 + 消耗后 → entries 含 signup（delta>0）与 consume（delta<0），新的在前
 *   2. label 映射：consume 用 reason（空则「AI 调用」）；未知 kind 原样下发
 *   3. 仅本人流水（A 拿不到 B 的）；无 token → 401
 *   4. deltaText 带符号文案（正 +、负 U+2212），前端零换算
 *   5. limit 默认 20、钳制 [1,50]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ledger-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与常驻服务撞端口
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

const mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
const { server } = mod;

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers,
      agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const yuan = (n) => Math.round(n * 1e6);   // 元 → 微元
const iso = (t) => new Date(t).toISOString();

async function registerAndLogin(email, password) {
  await req('POST', '/api/auth/register', { email, password });
  return (await req('POST', '/api/auth/login', { email, password })).json.token;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  try {
    /* ============ 1. 注册赠送入账 ============ */
    const tokA = await registerAndLogin('ledger-a@t.local', 'pw12345678');
    ok(!!tokA, '1.0 账号 A 注册并登录');
    let r = await req('GET', '/api/balance/ledger', null, tokA);
    eq(r.status, 200, '1.1 流水接口可用');
    eq(r.json.entries.length, 1, '1.2 初始只有注册赠送一条');
    eq(r.json.entries[0].kind, 'signup', '1.3 首条为注册赠送');
    ok(r.json.entries[0].delta > 0, '1.4 注册赠送 delta 为正（收入）');
    eq(r.json.entries[0].delta, yuan(6), '1.5 注册赠送 ¥6');
    eq(r.json.entries[0].label, '注册赠送', '1.6 label=注册赠送');
    eq(r.json.entries[0].deltaText, '+¥6.00', '1.7 ★ 正数 deltaText 带 + 号');

    /* ============ 2. 消耗 / 充值 / 未知 kind 的 label 与符号 ============ */
    // 充值走管理接口（真实写路径）；consume 与未知 kind 直接落库注入（网关链路在 balance.test.js 已覆盖）
    const uidA = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'))
      .users.find((u) => u.email === 'ledger-a@t.local').id;
    const adj = await req('POST', '/api/admin/users/' + uidA + '/balance',
      { micro: yuan(5), kind: 'recharge', reason: '人工充值' });
    eq(adj.status, 200, '2.0 管理员充值成功');

    const udoc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
    const ua = udoc.users.find((u) => u.email === 'ledger-a@t.local');
    const t0 = Date.now();
    ua.balance.ledger.push(
      { at: iso(t0 + 1), delta: -2100, kind: 'consume', reason: 'AI 调用 gpt-5', refId: '' },
      { at: iso(t0 + 2), delta: -100, kind: 'consume', reason: '', refId: '' },
      { at: iso(t0 + 3), delta: 100, kind: 'mystery-kind', reason: '', refId: '' });
    fs.writeFileSync(path.join(WORK, 'users.json'), JSON.stringify(udoc, null, 2), 'utf8');
    mod.reloadStores();

    r = await req('GET', '/api/balance/ledger', null, tokA);
    const entries = r.json.entries;
    eq(entries.length, 5, '2.1 流水共 5 条（signup/recharge/consume×2/未知）', entries.length);
    eq(entries[0].kind, 'mystery-kind', '2.2 ★ 新的在前（最新一条排最前）');
    eq(entries[0].label, 'mystery-kind', '2.3 ★ 未知 kind 原样下发（验收兜底）');
    const consumeNamed = entries.find((e) => e.delta === -2100);
    eq(consumeNamed.label, 'AI 调用 gpt-5', '2.4 consume 用 reason 作 label');
    eq(consumeNamed.deltaText, '−¥0.0021', '2.5 ★ 负数 deltaText 带 U+2212 负号', consumeNamed.deltaText);
    ok(consumeNamed.deltaText.charCodeAt(0) === 0x2212, '2.6 负号是 U+2212 而非 ASCII 连字符');
    const consumeAnon = entries.find((e) => e.delta === -100);
    eq(consumeAnon.label, 'AI 调用', '2.7 consume 无 reason → 兜底「AI 调用」');
    const recharge = entries.find((e) => e.kind === 'recharge');
    eq(recharge.label, '额度充值', '2.8 recharge label=额度充值');
    eq(recharge.deltaText, '+¥5.00', '2.9 充值 deltaText=+¥5.00');
    ok(entries.every((e) => e.at && typeof e.delta === 'number' && e.label && e.deltaText),
      '2.10 每条均含 at/delta/kind/label/deltaText');

    /* ============ 3. limit 钳制 ============ */
    r = await req('GET', '/api/balance/ledger?limit=2', null, tokA);
    eq(r.json.entries.length, 2, '3.1 limit=2 只回 2 条');
    eq(r.json.entries[0].kind, 'mystery-kind', '3.2 截断后仍新的在前');
    r = await req('GET', '/api/balance/ledger?limit=500', null, tokA);
    ok(r.json.entries.length <= 50, '3.3 ★ limit=500 钳制到 50 以内', r.json.entries.length);
    eq(r.json.entries.length, 5, '3.4 本账号共 5 条全返回');
    r = await req('GET', '/api/balance/ledger?limit=abc', null, tokA);
    eq(r.json.entries.length, 5, '3.5 非法 limit 回退默认 20（本账号不足 20 条故全量）');

    /* ============ 4. 隔离与鉴权 ============ */
    const tokB = await registerAndLogin('ledger-b@t.local', 'pw12345678');
    r = await req('GET', '/api/balance/ledger', null, tokB);
    eq(r.json.entries.length, 1, '4.1 ★ 账号 B 只看到自己的 1 条（注册赠送）');
    ok(!r.json.entries.some((e) => e.label === 'AI 调用 gpt-5'), '4.2 ★ A 的流水对 B 不可见');
    r = await req('GET', '/api/balance/ledger');
    eq(r.status, 401, '4.3 无 token → 401');

    /* ============ 5. 读路径不落盘（sweep 惰性变更不触发 save） ============ */
    const mtime1 = fs.statSync(path.join(WORK, 'users.json')).mtimeMs;
    await new Promise((res) => setTimeout(res, 30));
    await req('GET', '/api/balance/ledger', null, tokA);
    const mtime2 = fs.statSync(path.join(WORK, 'users.json')).mtimeMs;
    eq(mtime2, mtime1, '5.1 ★ 读流水不重写 users.json（只读路径）');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n余额流水接口测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
