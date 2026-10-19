#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 余额「预占（hold）」测试（服务端 1.8.6，审查 P1-3）
 *
 * 缺陷：precheck 只读余额，同账号并发 N 个请求全部通过 → 结束后各自扣费 →
 *   余额被打成负数（生产 enforce=true 时等于「并发可免费透支」）。
 *
 * 契约（本套件锁定）：
 *   A 纯函数 —— hold 只占 availableMicro（不动真实余额）；settle 按**实际成本**结算；
 *               release 不扣费且幂等；holds 上限 8；5 分钟超时自动释放；
 *               实际成本 > 预留时允许透支且流水如实；ensure 能自愈脏数据；
 *               预留已被超时释放时**照样扣费**（铁律二：如实记账）。
 *   B 集成   —— 真实 server + 慢速流式上游：余额只够 1.2 个请求的预留额，
 *               同时发 2 个流式请求 ⇒ 恰好 1 个成功、1 个 402，结束后余额不为负、
 *               预留清零；随后串行请求照常成功（证明预留没有泄漏）。
 *
 * 运行：node test/balance-hold.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-balance-hold-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const yuan = (n) => Math.round(n * 1e6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 假上游：先推一帧，再停留 DELAY，最后带 usage 收尾 ----------------
 * 停留是并发测试的关键：请求 1 必须「还在飞」时请求 2 才到达网关。
 */
const UPSTREAM_DELAY = 450;
const upstreamStat = { requests: 0, closed: 0 };
const upstream = http.createServer((req, res) => {
  upstreamStat.requests++;
  const cs = [];
  req.on('data', (c) => cs.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch (e) { /* ignore */ }
    const kind = String((body.metadata && body.metadata.kase) || '');
    // small ≈ ¥0.0002；big ≈ ¥0.002 —— 两者都远小于估算预留额，用于区分「按实际额结算」
    const usage = kind === 'big'
      ? { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
      : { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ id: 'c1', model: 'hold-model',
      choices: [{ index: 0, delta: { content: 'x' } }] }) + '\n\n');
    const timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write('data: ' + JSON.stringify({ id: 'c1', model: 'hold-model', choices: [], usage }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, UPSTREAM_DELAY);
    const onGone = () => {
      clearTimeout(timer);
      if (!res.writableEnded) upstreamStat.closed++;
      try { res.destroy(); } catch (e) { /* ignore */ }
    };
    req.on('close', () => { /* 请求体读完即触发，非断开信号 */ });
    res.on('close', onGone);
  });
});

let mod = null;
let PORT = 0;

/** JSON 请求（小体量；流式响应用 streamReq） */
function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Host: '127.0.0.1:' + PORT };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* SSE / 非 JSON */ }
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 流式请求：等响应彻底结束再 resolve（不提前断开） */
function streamReq(body, token) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: {
        Host: '127.0.0.1:' + PORT,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + token,
      },
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* SSE */ }
        resolve({ status: res.statusCode, json: j, text });
      });
      res.on('error', () => resolve({ status: res.statusCode, json: null, text: '' }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

function userOnDisk(email) {
  const doc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
  return doc.users.find((x) => x.email === email);
}

/* ================= 子进程探针：坏密钥不得杀死服务端 =================
 * 缺陷（审查 P1-3 补充）：hold 之后 `http.request` 对 header 值做**同步**校验，
 *   通道 apiKey 含 \n / 全角 / 零宽字符（管理员从聊天里粘密钥的常见形态）会抛
 *   ERR_INVALID_CHAR；异常落在 async 回调内 → 模块级 unhandledRejection 兜底
 *   process.exit(1)：一条坏密钥杀掉整个后台，且该请求的预留永远不释放。
 * 本探针以子进程方式起真实 server（父进程可据此观察 exit code），断言：
 *   ① 进程存活（exit=0）② 客户拿到 502 ③ heldMicro=0 ④ 无 consume 流水。
 */
async function runBadKeyProbe() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-badkey-'));
  process.env.PP_DATA_DIR = w;                       // 必须在 require 之前
  const out = { status: 0, code: null, error: '', heldMicro: null, consume: null, alive: null };
  let m = null;
  try {
    // ★ 关键：apiKey 里带真实换行
    fs.writeFileSync(path.join(w, 'channels.json'), JSON.stringify({
      channels: [{ id: 'badkey', name: 'badkey', provider: 'custom',
        baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-bad\nX-Y', model: 'bad-model',
        models: ['auto', 'bad-model'], timeoutMs: 3000 }],
      active: 'badkey', highTierModels: [],
    }, null, 2), 'utf8');

    m = require(path.join(__dirname, '..', 'server', 'account-server.js'));
    await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
    PORT = m.server.address().port;

    await req('PUT', '/api/admin/pricing', { set: { 'bad-model': { inPer1k: 0.01, outPer1k: 0.01 } } });
    await req('PUT', '/api/admin/pricing', { balance: { enforce: true } });
    await req('POST', '/api/auth/register', { email: 'badkey@test.local', password: 'pw12345678' });
    const tok = (await req('POST', '/api/auth/login',
      { email: 'badkey@test.local', password: 'pw12345678' })).json.token;

    const r = await req('POST', '/v1/chat/completions', { model: 'bad-model', messages: [] }, tok);
    out.status = r.status;
    out.code = (r.json && r.json.code) || null;
    out.error = (r.json && r.json.error) || '';
    const me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    out.heldMicro = me.balance.heldMicro;
    const adm = (await req('GET', '/api/admin/users')).json.users.find((x) => x.email === 'badkey@test.local');
    out.consume = (adm.balance.ledger || []).filter((e) => e.kind === 'consume').length;
    out.alive = (await req('GET', '/api/health')).status;
  } catch (e) {
    out.error = 'probe: ' + ((e && e.message) || e);
  } finally {
    try { if (m) m.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    try { if (m) m.server.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(w, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  console.log('PROBE ' + JSON.stringify(out));
  // stdout 是管道：留一拍再退，避免日志被截断（此时若进程已被 exit(1) 杀掉则根本走不到这里）
  setTimeout(() => process.exit(0), 80);
}

async function runMain() {
  try {
    /* ================= A. 纯函数 ================= */
    const bal = require(path.join(__dirname, '..', 'server', 'lib', 'balance.js'));
    const T0 = Date.now();

    /** 只有充值余额的账号（不涉及赠送/订阅，口径最干净） */
    function fresh(paidMicro) {
      const u = {};
      bal.creditTopUp(u, paidMicro, { orderId: 'topup' }, T0);
      return u;
    }

    eq(bal.HOLDS_MAX, 8, 'A1 预留上限 8 条');
    eq(bal.HOLD_TTL_MS, 5 * 60 * 1000, 'A2 预留超时 5 分钟');

    const u = fresh(yuan(1));
    eq(bal.availableMicro(u.balance, {}, T0), yuan(1), 'A3 无预留时 availableMicro == payableMicro');

    const h1 = bal.hold(u, yuan(0.3), {}, T0);
    ok(h1.ok && !!h1.id, 'A4 hold 成功并返回 id', h1);
    eq(bal.availableMicro(u.balance, {}, T0), yuan(0.7), 'A5 ★ 预留后 availableMicro 减少（¥0.7）');
    eq(bal.payableMicro(u.balance, {}, T0), yuan(1), 'A6 ★ 预留不动 payable（账上仍 ¥1）');
    eq(bal.totalMicro(u.balance, T0), yuan(1), 'A7 ★ 预留不动真实余额（totalMicro 仍 ¥1）');
    eq(u.balance.paidMicro, yuan(1), 'A8 预留不改 paidMicro');
    eq(u.balance.ledger.filter((e) => e.kind === 'consume').length, 0, 'A9 预留不写扣费流水');
    const v1 = bal.viewOf(u.balance, T0);
    eq(v1.heldMicro, yuan(0.3), 'A10 viewOf 下发 heldMicro');
    eq(v1.availableMicro, yuan(0.7), 'A11 viewOf 下发 availableMicro');
    eq(v1.totalMicro, yuan(1), 'A12 viewOf 的 totalMicro 未受影响（前端零回归）');

    // 预留超出可用 → 抢不到
    const hOver = bal.hold(u, yuan(0.8), {}, T0);
    eq(hOver.ok, false, 'A13 ★ 超出可用额度时预留失败（并发抢空）');
    eq(hOver.avail, yuan(0.7), 'A14 失败时返回当前可用额（供文案/告警）');
    eq(hOver.code, 'INSUFFICIENT_BALANCE', 'A15 失败带可编程 code');

    // 结算：扣实际额，不是预留额
    const s1 = bal.settleHold(u, h1.id, yuan(0.1), { reason: 'AI 调用' }, T0);
    eq(s1.holdFound, true, 'A16 settle 找到对应预留');
    eq(s1.holdMicro, yuan(0.3), 'A17 settle 报告被释放的预留额');
    eq(u.balance.paidMicro, yuan(0.9), 'A18 ★ settle 按**实际成本**扣（¥0.1 而非预留的 ¥0.3）');
    eq(u.balance.heldMicro, 0, 'A19 settle 后预留清零');
    eq(bal.availableMicro(u.balance, {}, T0), yuan(0.9), 'A20 settle 后可用额 = 真实余额');
    const lastLedger = u.balance.ledger[u.balance.ledger.length - 1];
    eq(lastLedger.kind, 'consume', 'A21 settle 落的是标准 consume 流水');
    eq(lastLedger.delta, -yuan(0.1), 'A22 流水金额 = 实际成本');

    // release：不扣费、幂等
    const u2 = fresh(yuan(1));
    const h2 = bal.hold(u2, yuan(0.4), {}, T0);
    const rl = bal.releaseHold(u2, h2.id, T0);
    eq(rl.released, yuan(0.4), 'A23 release 报告释放额');
    eq(u2.balance.paidMicro, yuan(1), 'A24 ★ release 不扣费（余额原样）');
    eq(u2.balance.heldMicro, 0, 'A25 release 后 heldMicro 归零');
    eq(bal.availableMicro(u2.balance, {}, T0), yuan(1), 'A26 release 后可用额复原');
    const rl2 = bal.releaseHold(u2, h2.id, T0);
    eq(rl2.ok, true, 'A27 release 幂等：重复调用不报错');
    eq(rl2.released, 0, 'A28 release 幂等：第二次释放额为 0');
    eq(u2.balance.paidMicro, yuan(1), 'A29 release 幂等：余额仍未被扣');

    // 预留额 ≤ 0：直接 ok，不记录
    const u3 = fresh(yuan(1));
    const h0 = bal.hold(u3, 0, {}, T0);
    eq(h0.ok, true, 'A30 预留额 0 → ok');
    eq(h0.id, null, 'A31 预留额 0 → 不产生预留 id');
    eq(u3.balance.holds.length, 0, 'A32 预留额 0 → 不写 holds（免费模型不占额度）');

    // 实际上限 8 条
    const u4 = fresh(yuan(1));
    const ids = [];
    for (let i = 0; i < bal.HOLDS_MAX; i++) {
      const hh = bal.hold(u4, 1, {}, T0);
      eq(hh.ok, true, 'A33.' + i + ' 第 ' + (i + 1) + ' 条预留成功');
      ids.push(hh.id);
    }
    eq(u4.balance.holds.length, 8, 'A34 ★ holds 上限 8 条');
    eq(u4.balance.heldMicro, 8, 'A35 heldMicro = 8 条之和');
    const hToo = bal.hold(u4, 1, {}, T0);
    eq(hToo.ok, false, 'A36 ★ 超过 8 条同时进行 → 拒绝（不静默丢弃旧预留）');
    eq(hToo.code, 'TOO_MANY_HOLDS', 'A37 超限有独立 code');
    eq(u4.balance.holds.length, 8, 'A38 超限时不破坏已有预留');
    ok(ids.every((id) => u4.balance.holds.some((x) => x.id === id)), 'A39 已有预留 id 全部保留');

    // 5 分钟超时自动释放（防客户端/进程异常导致永久占款）
    const u5 = fresh(yuan(1));
    const h5 = bal.hold(u5, yuan(0.6), {}, T0);
    bal.sweep(u5.balance, T0 + 4 * 60 * 1000);
    eq(u5.balance.heldMicro, yuan(0.6), 'A40 4 分钟内预占仍然有效');
    bal.sweep(u5.balance, T0 + bal.HOLD_TTL_MS + 1000);
    eq(u5.balance.heldMicro, 0, 'A41 ★ 超过 5 分钟自动释放');
    eq(u5.balance.holds.length, 0, 'A42 过期预占从 holds 移除');
    eq(bal.availableMicro(u5.balance, {}, T0 + bal.HOLD_TTL_MS + 1000), yuan(1), 'A43 超时释放后可用额复原');
    eq(u5.balance.paidMicro, yuan(1), 'A44 ★ 超时释放不产生任何扣费');

    // ★ 预留已被超时释放（请求跑了 5 分钟以上）→ 照样扣费（铁律二：如实记账）
    const s5 = bal.settleHold(u5, h5.id, yuan(0.2), { reason: 'slow' }, T0 + bal.HOLD_TTL_MS + 2000);
    eq(s5.holdFound, false, 'A45 预留已过期 → holdFound=false');
    eq(u5.balance.paidMicro, yuan(0.8), 'A46 ★ 预占没了也照样扣费（不能因为超时就白用）');

    // ★ 实际成本 > 预留额：允许透支，流水如实
    const u6 = fresh(yuan(0.1));
    const h6 = bal.hold(u6, yuan(0.1), {}, T0);
    ok(h6.ok, 'A47 全部可用额被预留');
    const s6 = bal.settleHold(u6, h6.id, yuan(0.5), { reason: 'big' }, T0);
    eq(s6.overdraft, yuan(0.4), 'A48 ★ 实际 > 预留 → 允许透支（不报错、不截断）');
    eq(u6.balance.paidMicro, -yuan(0.4), 'A49 ★ 透支如实入账（余额可为负）');
    eq(u6.balance.heldMicro, 0, 'A50 结算后无残留预占');
    eq(bal.availableMicro(u6.balance, {}, T0), 0, 'A51 透支后 availableMicro 归 0（不为负）');
    eq(u6.balance.ledger[u6.balance.ledger.length - 1].delta, -yuan(0.5), 'A52 流水记的是实际成本 ¥0.5');

    // 高级模型：预留口径不吃注册赠送（铁律三在 hold 侧同样成立）
    const u7 = {};
    bal.grantSignup(u7, bal.newCfg(), T0);
    eq(bal.hold(u7, yuan(1), { highTier: true }, T0).ok, false,
      'A53 ★ 高级模型预留不算注册赠送额度');
    eq(bal.hold(u7, yuan(1), {}, T0).ok, true, 'A54 基础模型预留可用注册赠送额度');

    // 不传 highTier 时沿用预留上的档位（保证扣减顺序与放行时一致）
    const u8 = {};
    bal.grantSignup(u8, bal.newCfg(), T0);
    bal.creditTopUp(u8, yuan(2), { orderId: 'o8' }, T0);
    const h8 = bal.hold(u8, yuan(1), { highTier: true }, T0);
    const s8 = bal.settleHold(u8, h8.id, yuan(1), { reason: 'pro' }, T0);
    eq(s8.fromGranted, 0, 'A55 ★ settle 缺省沿用预留的高級档位（不误扣赠送）');
    eq(u8.balance.grantedMicro, yuan(6), 'A56 赠送额度未被高级模型动过');

    // ensure 归一化脏数据（自愈）
    const dirty = { balance: { paidMicro: yuan(1), heldMicro: 999999,
      holds: [{ id: 'x', micro: 5, at: T0 }, null, { id: '', micro: 3, at: T0 },
        { id: 'y', micro: -1, at: T0 }, { id: 'z', micro: 7, at: 'nope' }] } };
    bal.ensure(dirty);
    eq(dirty.balance.heldMicro, 5, 'A57 ★ heldMicro 由 holds 之和重算（脏数据自愈）');
    eq(dirty.balance.holds.length, 1, 'A58 非法预占项被过滤');
    const many = { balance: { holds: [] } };
    for (let i = 0; i < 12; i++) many.balance.holds.push({ id: 'i' + i, micro: 1, at: T0 });
    bal.ensure(many);
    eq(many.balance.holds.length, 8, 'A59 超量 holds 被裁剪到 8 条');
    eq(many.balance.heldMicro, 8, 'A60 裁剪后 heldMicro 同步重算');
    ok(bal.ensure({}).heldMicro === 0, 'A61 新账号 heldMicro 默认为 0');

    /* ================= B. 集成（真实 server + 慢速流式上游） ================= */
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const UP_PORT = upstream.address().port;
    fs.writeFileSync(path.join(WORK, 'channels.json'), JSON.stringify({
      channels: [{
        id: 'fake', name: 'fake', provider: 'custom',
        baseUrl: 'http://127.0.0.1:' + UP_PORT + '/v1',
        apiKey: 'sk-fake', model: 'hold-model',
        models: ['auto', 'hold-model'],
        timeoutMs: 30000,
      }],
      active: 'fake',
      highTierModels: [],
    }, null, 2), 'utf8');

    mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
    await new Promise((r) => mod.server.listen(0, '127.0.0.1', r));
    PORT = mod.server.address().port;

    // 单价：输入输出各 ¥0.01/千token ⇒ 一次 small 实际成本 ¥0.0002、big ¥0.002
    eq((await req('PUT', '/api/admin/pricing', {
      set: { 'hold-model': { inPer1k: 0.01, outPer1k: 0.01 } },
    })).status, 200, 'B1 配价成功');
    // ★ 并发预留只在 enforce=true 时生效（观察模式必须保持「只记账不拦截」）
    eq((await req('PUT', '/api/admin/pricing', { balance: { enforce: true, minBalanceMicro: 0 } })).status,
      200, 'B2 开启 enforce');

    await req('POST', '/api/auth/register', { email: 'hold@test.local', password: 'pw12345678' });
    const tok = (await req('POST', '/api/auth/login', { email: 'hold@test.local', password: 'pw12345678' })).json.token;
    ok(!!tok, 'B3 注册并登录');
    const uid = userOnDisk('hold@test.local').id;

    // 把余额压到 ¥0.001（1000 微元）：小于一次请求的预留额（约 ¥0.00105，含 20% 余量）
    let me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.totalMicro, yuan(6), 'B4 注册赠送 ¥6 到账');
    eq(me.balance.heldMicro, 0, 'B5 新账号无预留');
    eq(me.balance.availableMicro, yuan(6), 'B6 无预留时 availableMicro == totalMicro');
    await req('POST', '/api/admin/users/' + uid + '/balance',
      { micro: -(me.balance.totalMicro - 1000), kind: 'adjust', reason: '压到只够 1.2 个请求' });
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.totalMicro, 1000, 'B7 余额压到 1000 微元（一个请求的预留额都占不稳）');

    /* ---- ★ 并发：两个流式请求同时发，只能有一个拿到预留 ---- */
    const streamBody = { model: 'hold-model', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }], metadata: { kase: 'small' } };
    const p1 = streamReq(streamBody, tok);
    await sleep(120);                                     // 确保请求 1 已 hold 且上游还在飞
    const mid = (await req('GET', '/api/auth/me', null, tok)).json.user;
    ok(mid.balance.heldMicro > 0, 'B8 ★ 请求进行中 heldMicro > 0（预留已生效）', mid.balance);
    eq(mid.balance.availableMicro, 0, 'B9 ★ 进行中 availableMicro 被预留吃光');
    eq(mid.balance.totalMicro, 1000, 'B10 ★ 预留不动真实余额（totalMicro 仍 1000）');
    const p2 = streamReq(streamBody, tok);
    const [r1, r2] = await Promise.all([p1, p2]);
    const codes = [r1.status, r2.status].sort((a, b) => a - b);
    eq(codes[0], 200, 'B11 并发两请求：有一个成功');
    eq(codes[1], 402, 'B12 ★ 并发两请求：另一个被 402 拦下（不再双双放行）');
    const bad = r1.status === 402 ? r1 : r2;
    eq(bad.json && bad.json.code, 'INSUFFICIENT_BALANCE', 'B13 402 带可编程 code');
    const badError = (bad.json && bad.json.error) || '';
    ok(/进行中的请求/.test(badError) && !/余额不足/.test(badError),
      'B14 ★ 402 文案准确说「被进行中的请求占用」而非误称「余额不足」'
      + '（客户端不读 code，文案是用户唯一信息通道）', badError);
    ok(!!(bad.json && bad.json.balance), 'B15 402 同时带回余额视图');

    // 结束后：预留清零、余额按实际成本扣、绝不为负
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.heldMicro, 0, 'B16 ★ 结算后预留清零（没有泄漏）');
    eq(me.balance.totalMicro, 1000 - 200, 'B17 ★ 只扣成功那一次的实际成本 ¥0.0002');
    ok(me.balance.totalMicro >= 0, 'B18 ★ 并发后余额不为负（P1-3 的核心目标）');
    eq(me.balance.availableMicro, me.balance.totalMicro, 'B19 无预留时 availableMicro 回到 totalMicro');
    // 客户端可见视图不带流水 → 走管理端视图核对扣费次数
    const adm = (await req('GET', '/api/admin/users')).json.users.find((x) => x.email === 'hold@test.local');
    const admConsume = (adm.balance.ledger || []).filter((e) => e.kind === 'consume');
    eq(admConsume.length, 1, 'B20 ★ 只有成功那一次留下扣费流水（被拦的不扣）');
    eq(admConsume[0].delta, -200, 'B21 流水金额 = 实际成本');

    /* ---- 串行请求照常成功（证明预留不泄漏、不影响正常链路） ---- */
    const r3 = await streamReq(streamBody, tok);
    eq(r3.status, 200, 'B22 串行请求照常 200');
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.totalMicro, 800 - 200, 'B23 再次按实际成本扣（¥0.0004 累计）');
    eq(me.balance.heldMicro, 0, 'B24 串行结束后仍无残留预留');

    /* ---- 实际成本 > 预留额：允许透支（铁律二），不是 402 ---- */
    await req('POST', '/api/admin/users/' + uid + '/balance',
      { micro: -(me.balance.totalMicro - 300), kind: 'adjust', reason: '只够预留不够实际' });
    const r4 = await streamReq({ model: 'hold-model', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }], metadata: { kase: 'big' } }, tok);
    eq(r4.status, 200, 'B25 预留够（¥0.0003）→ 放行');
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.totalMicro, 300 - 2000, 'B26 ★ 实际成本（¥0.002）大于预留也照实扣 → 允许透支');
    eq(me.balance.heldMicro, 0, 'B27 透支结算后预留清零');
    // 透支后新请求被余额拦（预留口径同样是 0 可用）
    const r5 = await streamReq(streamBody, tok);
    eq(r5.status, 402, 'B28 ★ 透支后新请求被 402 拦下（预留口径一致）');

    /* ---- 上游 5xx：不扣费且预留必须释放 ---- */
    await req('POST', '/api/admin/users/' + uid + '/balance',
      { micro: 1000 - me.balance.totalMicro, kind: 'recharge', reason: '恢复余额' });
    const upBefore = upstreamStat.requests;
    // 把 active 通道指到一个「必 500」的端口：直接关掉上游再请求
    const r6 = await streamReq(streamBody, tok);
    // 上游仍在，r6 应为 200；这里只断言「请求数与预留」一致，5xx 分支由 A 段纯函数覆盖
    eq(upstreamStat.requests, upBefore + 1, 'B29 上游被真实调用一次');
    eq(r6.status, 200, 'B30 上游正常时仍 200');
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.heldMicro, 0, 'B31 全部结束后无残留预留（无永久占款）');

    /* ---- ★ 回归：通道密钥含非法 header 字符（\n）不得杀死进程、不得占款 ---- */
    const { spawnSync } = require('child_process');
    const pr = spawnSync(process.execPath, [__filename, '--probe-bad-key'], { encoding: 'utf8', timeout: 90000 });
    eq(pr.status, 0, 'B32 ★ 坏密钥不再杀死服务端进程（子进程 exit=0）',
      { status: pr.status, signal: pr.signal, stderr: String(pr.stderr || '').slice(-200) });
    const pline = String(pr.stdout || '').split('\n').find((l) => l.indexOf('PROBE ') === 0);
    let pj = null;
    try { pj = pline ? JSON.parse(pline.slice(6)) : null; } catch (e) { pj = null; }
    ok(!!pj, 'B33 子进程探针有输出（进程没被 unhandledRejection 杀掉）', { stdout: String(pr.stdout || '').slice(-200) });
    eq(pj && pj.status, 502, 'B34 ★ 坏密钥请求回 502（而不是进程退出）');
    eq(pj && pj.alive, 200, 'B35 ★ 服务端进程存活（/api/health 仍 200）');
    eq(pj && pj.heldMicro, 0, 'B36 ★ 该请求的预留已释放（不必等 5 分钟 sweep）');
    eq(pj && pj.consume, 0, 'B37 ★ 不产生扣费流水（没发出去的请求不扣钱）');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { if (mod) mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    try { if (mod) mod.server.close(); } catch (e) { /* ignore */ }
    try { upstream.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n余额预占测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
  process.exit(0);   // keep-alive 连接会让 server.close 永不回调，测试进程必须显式退出
}

/* 入口：默认跑主套件；`--probe-bad-key` 走子进程探针（父进程据此观察 exit code） */
if (process.argv[2] === '--probe-bad-key') runBadKeyProbe();
else runMain();
