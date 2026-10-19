#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 余额「预占（hold）」独立审计测试（服务端 1.8.6，审查 P1-3 复核）
 *
 * 目的：不复用工程师的用例，独立核对 gatewayChat() 里**每一个** return / 异常出口
 *   是否都落到 settle（扣费）或 release（放款），并覆盖他未覆盖的角度：
 *
 *   ① 预留泄漏：流式请求进行中客户端断开 → heldMicro 必须归零、无 consume 流水；
 *   ② 上游 500 / 400 / 401（翻译 502）→ 预留释放、无 consume 流水；
 *   ③ 连接被拒（upReq.error 分支）→ 502 + 预留释放；
 *   ④ 上游超时（upReq.timeout 分支）→ 预留释放；
 *   ⑤ 连续 10 次串行请求 → heldMicro=0，余额 = 逐笔成本之和；
 *   ⑥ 观察模式（enforce=false）：并发 3 个请求全部 200（不得因预留 402）；
 *   ⑦ 脏数据自愈：手改 users.json 让 holds / heldMicro 相互不一致，reload 后 available 正确；
 *   ⑧ 非法 actual：settleHold 传 NaN / 负数 / 字符串 → 不崩、不放款、不污染余额；
 *   ⑨ 探针：通道 apiKey 含非法头字符时 http.request 同步抛错 → 预留是否泄漏（边界）。
 *
 * 运行：node test/balance-hold-audit.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hold-audit-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';
process.env.PP_REG_MAX = '50';

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

/* 未被捕获的 rejection / 异常：不注册的话 Node 22 直接终止进程，会把整轮测试带走 */
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push('unhandledRejection: ' + ((e && e.message) || e)); });
process.on('uncaughtException', (e) => { unhandled.push('uncaughtException: ' + ((e && e.message) || e)); });

let probeNote = '';   // G 段子进程探针的观察结论（写进报告）

/* ---------------- 假上游：按 metadata.kase 决定行为 ----------------
 *   ok      → 推一帧，DELAY 后带 usage 收尾（正常计费）
 *   hang    → 推一帧后永不结束（用于「客户端断开」与「上游超时」）
 *   e500    → 直接 500
 *   e400    → 直接 400
 *   auth401 → 直接 401（网关应翻译为 502）
 */
const DELAY = 300;
const upStat = { requests: 0, closed: 0 };
const upServer = http.createServer((req, res) => {
  upStat.requests++;
  const cs = [];
  req.on('data', (c) => cs.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch (e) { /* ignore */ }
    const kase = String((body.metadata && body.metadata.kase) || 'ok');
    if (kase === 'e500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"upstream boom"}}');
    }
    if (kase === 'e400') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"bad request"}}');
    }
    if (kase === 'auth401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"invalid api key"}}');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ id: 'c1', model: 'hold-model',
      choices: [{ index: 0, delta: { content: 'x' } }] }) + '\n\n');
    let timer = null;
    if (kase !== 'hang') {
      // slow：故意拉长在飞窗口，用于「8 条在飞 → 第 9 条被并发闸门拦下」的接线用例
      const delay = kase === 'slow' ? 1500 : DELAY;
      timer = setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.write('data: ' + JSON.stringify({ id: 'c1', model: 'hold-model', choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, delay);
    }
    res.on('close', () => {
      if (timer) clearTimeout(timer);
      if (!res.writableEnded) upStat.closed++;
      try { res.destroy(); } catch (e) { /* ignore */ }
    });
  });
});

let mod = null;
let PORT = 0;

/* ---------------- 裸 TCP 上游：回一个 HTTP 合法语法的 600 状态码 ----------------
 * http.Server 自己不让 writeHead(600)，但真实上游（反向代理/自研网关）吐 600+ 是可能的，
 * 网关若直接 writeHead(upRes.statusCode) 会抛 RangeError → 进程退出 + 预留不回滚。
 * 这里用 net 手写原始应答，锁住「夹到 502」这条修复。 */
const rawStat = { requests: 0 };
const rawServer = net.createServer((sock) => {
  sock.on('error', () => { /* ignore */ });
  sock.on('data', () => {
    rawStat.requests++;
    try {
      sock.write('HTTP/1.1 600 Odd Upstream\r\n'
        + 'Content-Type: application/json\r\n'
        + 'Content-Length: 2\r\n'
        + 'Connection: close\r\n\r\n{}');
      sock.end();
    } catch (e) { /* ignore */ }
  });
});

/* ---------------- HTTP 助手 ---------------- */
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
        try { j = JSON.parse(text); } catch (e) { /* SSE */ }
        resolve({ status: res.statusCode, json: j, text });
      });
      res.on('error', () => resolve({ status: res.statusCode, json: null, text: '' }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* ★ 网关全局限速是 GATEWAY_MAX=20 次 / IP / 分钟（常量，不可用 env 覆盖）。
 * 本套件需要 ~21 次网关请求，正好同阶于上限 —— 同 IP 打会拿到 429（与被测行为无关）。
 * 因此每次网关请求用一个「模拟客户端 IP」（服务端 clientIp 认 CF-Connecting-IP 头），
 * 等价于「多个客户端各自发一次」，限速维度与 P1-3 无关。
 * 注意：管理端请求**不能**带代理头（isLocalAdmin 会判为非本机），所以只在流式请求里加。 */
let gwIpSeq = 0;
function nextGwIp() { gwIpSeq++; return '198.51.100.' + ((gwIpSeq % 250) + 1); }

/** 流式请求：等响应彻底结束（不提前断开） */
function streamReq(body, token) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const gwIp = nextGwIp();
    const r = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: {
        Host: '127.0.0.1:' + PORT,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Accept: 'text/event-stream',
        'CF-Connecting-IP': gwIp,
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

/** 流式请求：收到第一帧后立刻断开（模拟插件「停止」/关窗）
 *  onFirst：断开**之前**执行的回调（用于测量「请求进行中」的预留状态） */
function streamAndAbort(body, token, onFirst) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let first = false;
    const r = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: {
        Host: '127.0.0.1:' + PORT,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Accept: 'text/event-stream',
        'CF-Connecting-IP': nextGwIp(),
        Authorization: 'Bearer ' + token,
      },
    }, (res) => {
      res.on('data', async () => {
        if (first) return;
        first = true;
        if (onFirst) { try { await onFirst(); } catch (e) { /* ignore */ } }
        r.destroy();           // ★ 客户端断开
        resolve({ aborted: true, status: res.statusCode });
      });
      res.on('error', () => resolve({ aborted: first, status: res.statusCode }));
    });
    r.on('error', () => resolve({ aborted: first, status: 0 }));
    r.write(payload);
    r.end();
  });
}

async function meOf(token) { return (await req('GET', '/api/auth/me', null, token)).json.user; }

/** 管理端视角（含流水） */
async function adminUser(email) {
  const r = await req('GET', '/api/admin/users');
  return (r.json && r.json.users || []).find((x) => x.email === email);
}

async function consumeCount(email) {
  const u = await adminUser(email);
  const list = (u && u.balance && u.balance.ledger) || [];
  return list.filter((e) => e && e.kind === 'consume').length;
}

async function setTotal(uid, token, target) {
  const me = await meOf(token);
  const delta = target - me.balance.totalMicro;
  if (delta) {
    await req('POST', '/api/admin/users/' + uid + '/balance',
      { micro: delta, kind: 'recharge', reason: '审计用例设定余额' });
  }
  return (await meOf(token)).balance;
}

/** 轮询等 heldMicro 归零（正常 <100ms；给 2s 宽限） */
async function waitHeldZero(token, ms) {
  const limit = ms || 2000;
  const t0 = Date.now();
  let held = -1;
  while (Date.now() - t0 < limit) {
    held = (await meOf(token)).balance.heldMicro;
    if (held === 0) return { held: 0, ms: Date.now() - t0 };
    await sleep(50);
  }
  return { held, ms: limit };
}

/* ---------------- 子进程对抗探针：hold 之后/之后的未捕获出口 ----------------
 * 这些路径一旦回归就会触发服务端模块级 unhandledRejection 兜底（process.exit(1)），
 * 在同一个进程里探会把整轮测试带走，所以单独起一个 node 进程跑 3 个场景：
 *   A 坏密钥一次     → 502 + code=UPSTREAM_CONFIG + held=0（进程存活）
 *   B 坏密钥 + 客户端在 502 之前 destroy → 仍只走一次终态、held=0、不崩
 *   C 坏密钥连续 5 次 → 每次 502、held 恒 0、无 consume
 *   D 风暴后正常请求  → 200 且恰好扣 200 微元（证明没有双释放/双结算污染账本）
 */
const PROBE_SRC = `
'use strict';
const http = require('http');
const path = require('path');
const ROOT = process.argv[2];
const mod = require(path.join(ROOT, 'server', 'account-server.js'));
let PORT = 0;

/* 子进程内的好上游（证明坏密钥风暴之后计费链路仍然正常） */
const up = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"model":"good-model","choices":[{"delta":{"content":"x"}}]}\\n\\n');
    res.write('data: {"model":"good-model","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":10}}\\n\\n');
    res.write('data: [DONE]\\n\\n');
    res.end();
  });
});

function send(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { Host: '127.0.0.1:' + PORT };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
      res.on('error', () => resolve({ status: res.statusCode, json: null }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 打一次网关（model 由参数决定）；onStarted 在 socket 建立后立刻回调（用于并发 destroy） */
function gw(model, token, onStarted) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ model, stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }] }), 'utf8');
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/chat/completions',
      agent: false, headers: { Host: '127.0.0.1:' + PORT, 'Content-Type': 'application/json',
        'Content-Length': body.length, 'CF-Connecting-IP': '198.51.100.240', Authorization: 'Bearer ' + token } },
      (res) => {
        const cs = [];
        res.on('data', (c) => cs.push(c));
        res.on('end', () => {
          let code = null;
          try { code = JSON.parse(Buffer.concat(cs).toString('utf8')).code || null; } catch (e) {}
          resolve({ status: res.statusCode, code });
        });
        res.on('error', () => resolve({ status: res.statusCode, code: null, clientErr: true }));
      });
    r.on('error', () => resolve({ status: 0, code: null, clientErr: true }));
    r.write(body);
    r.end();
    if (onStarted) onStarted(r);          // ★ 请求已发出但尚未收到 502 → 立刻 destroy
  });
}

async function balanceOf(tok) {
  const me = await send('GET', '/api/auth/me', null, tok);
  return me.json && me.json.user ? me.json.user.balance : null;
}
async function consumeCount() {
  const r = await send('GET', '/api/admin/users');
  const u = (r.json && r.json.users || []).find((x) => x.email === 'probe@bad.local');
  return ((u && u.balance && u.balance.ledger) || []).filter((e) => e && e.kind === 'consume').length;
}

(async () => {
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const UP = up.address().port;
  await new Promise((r) => mod.server.listen(0, '127.0.0.1', r));
  PORT = mod.server.address().port;
  // 追加一条正常通道（badhdr 由父进程写进 channels.json）
  mod.channelsStore.data.channels.push({ id: 'good', name: 'good', provider: 'custom',
    baseUrl: 'http://127.0.0.1:' + UP + '/v1', apiKey: 'sk-good', model: 'good-model',
    models: ['auto', 'good-model'], timeoutMs: 5000 });
  mod.channelsStore.save();
  await send('PUT', '/api/admin/pricing', { set: {
    'bad-model': { inPer1k: 0.01, outPer1k: 0.01 },
    'good-model': { inPer1k: 0.01, outPer1k: 0.01 } } });
  await send('PUT', '/api/admin/pricing', { balance: { enforce: true, minBalanceMicro: 0 } });
  await send('POST', '/api/auth/register', { email: 'probe@bad.local', password: 'pw12345678' });
  const tok = (await send('POST', '/api/auth/login', { email: 'probe@bad.local', password: 'pw12345678' })).json.token;

  // ---- A：坏密钥一次 ----
  const a = await gw('bad-model', tok);
  await new Promise((r) => setTimeout(r, 300));
  const balA = await balanceOf(tok);
  process.stdout.write('PROBE_A ' + JSON.stringify({ status: a.status, code: a.code, held: balA && balA.heldMicro }) + '\\n');

  // ---- B：坏密钥 + 客户端在 502 到达前 destroy ----
  const b = await gw('bad-model', tok, (r) => { try { r.destroy(); } catch (e) {} });
  await new Promise((r) => setTimeout(r, 500));
  const balB = await balanceOf(tok);
  process.stdout.write('PROBE_B ' + JSON.stringify({ clientErr: !!b.clientErr, status: b.status, held: balB && balB.heldMicro }) + '\\n');

  // ---- C：坏密钥连续 5 次 ----
  const statuses = [];
  let heldMax = 0;
  for (let i = 0; i < 5; i++) {
    const r1 = await gw('bad-model', tok);
    statuses.push(r1.status);
    const bl = await balanceOf(tok);
    if (bl && bl.heldMicro > heldMax) heldMax = bl.heldMicro;
  }
  process.stdout.write('PROBE_C ' + JSON.stringify({ statuses, heldMax, consume: await consumeCount() }) + '\\n');

  // ---- D：风暴之后走正常通道，计费必须仍然精确 ----
  await send('PUT', '/api/admin/channels/active', { id: 'good' });
  const before = await balanceOf(tok);
  const d = await gw('good-model', tok);
  await new Promise((r) => setTimeout(r, 300));
  const after = await balanceOf(tok);
  process.stdout.write('PROBE_D ' + JSON.stringify({ status: d.status,
    delta: (after ? after.totalMicro : 0) - (before ? before.totalMicro : 0),
    held: after && after.heldMicro, consume: await consumeCount() }) + '\\n');

  process.stdout.write('PROBE_DONE\\n');
  process.exit(0);
})().catch((e) => { process.stdout.write('PROBE_ERR ' + (e && e.message) + '\\n'); process.exit(3); });
`;

/** 起子进程跑 PROBE_SRC；done=true 表示跑完了全部 4 个场景（否则说明进程中途死了） */
function probeBadHeader() {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hold-probe-'));
    fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify({
      channels: [{ id: 'badhdr', name: 'badhdr', provider: 'custom',
        baseUrl: 'http://127.0.0.1:1/v1',      // 不会被真正连接：抛错发生在建连之前
        apiKey: 'sk-bad\nX-Y', model: 'bad-model', models: ['auto', 'bad-model'], timeoutMs: 1000 }],
      active: 'badhdr', highTierModels: [],
    }), 'utf8');
    const script = path.join(dir, 'probe.js');
    fs.writeFileSync(script, PROBE_SRC, 'utf8');
    const child = spawn(process.execPath, [script, path.join(__dirname, '..')], {
      env: Object.assign({}, process.env, { PP_DATA_DIR: dir, PP_PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 40000);
    const pick = (tag) => {
      const m = out.match(new RegExp(tag + ' (\\{[^\\n]*\\})'));
      if (!m) return null;
      try { return JSON.parse(m[1]); } catch (e) { return null; }
    };
    child.on('exit', (code) => {
      clearTimeout(killer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      resolve({
        code, out, done: /PROBE_DONE/.test(out),
        A: pick('PROBE_A'), B: pick('PROBE_B'), C: pick('PROBE_C'), D: pick('PROBE_D'),
      });
    });
  });
}

/** server/data/server-crash.log 行数（兜底 handler 每崩一次写一段；用于证明「没崩」） */
function crashLogLines() {
  const p = path.join(__dirname, '..', 'server', 'data', 'server-crash.log');
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; }
}

let userSeq = 0;
/** 注册 + 登录。注意：注册限速 REG_MAX=5 次 / IP / 分钟（常量，env 覆盖不了），
 *  本套件只用 5 个账号；uid 走管理端内存列表取（users.json 是异步落盘，读文件会竞态）。 */
async function register(prefix) {
  const email = prefix + (++userSeq) + '@audit.local';
  const reg = await req('POST', '/api/auth/register', { email, password: 'pw12345678' });
  if (reg.status !== 200) throw new Error('注册失败：' + reg.status + ' ' + reg.text.slice(0, 120));
  const tok = (await req('POST', '/api/auth/login', { email, password: 'pw12345678' })).json.token;
  const u = await adminUser(email);
  if (!u) throw new Error('注册后找不到账号：' + email);
  return { email, tok, uid: u.id };
}

const S = { model: 'hold-model', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
const bodyOf = (kase, over) => Object.assign({}, S, { metadata: { kase } }, over || {});

(async () => {
  try {
    /* ================= A. 纯函数：非法 actual / 边界 ================= */
    const bal = require(path.join(__dirname, '..', 'server', 'lib', 'balance.js'));
    const T0 = Date.now();
    function fresh(paidMicro) {
      const u = {};
      bal.creditTopUp(u, paidMicro, { orderId: 'topup' }, T0);
      return u;
    }

    // A1-A4：settleHold 传 NaN
    const a1 = fresh(yuan(1));
    const ah1 = bal.hold(a1, yuan(0.3), {}, T0);
    let s1 = null;
    try { s1 = bal.settleHold(a1, ah1.id, NaN, { reason: 'nan' }, T0); }
    catch (e) { fails.push('A1 settleHold(NaN) 抛错：' + e.message); }
    ok(!!s1 && s1.ok === true, 'A1 ★ settleHold 传 NaN 不抛错');
    eq(a1.balance.paidMicro, yuan(1), 'A2 ★ NaN 实际额不扣钱（余额原样）');
    eq(a1.balance.heldMicro, 0, 'A3 NaN 结算仍然摘掉预留（不永久占款）');
    ok(Number.isFinite(a1.balance.paidMicro), 'A4 余额未变成 NaN');

    // A5-A8：settleHold 传负数
    const a2 = fresh(yuan(1));
    const ah2 = bal.hold(a2, yuan(0.3), {}, T0);
    const s2 = bal.settleHold(a2, ah2.id, -yuan(5), { reason: 'neg' }, T0);
    eq(a2.balance.paidMicro, yuan(1), 'A5 ★ 负数实际额不「放款」（不会被加钱）');
    eq(a2.balance.heldMicro, 0, 'A6 负数结算仍摘掉预留');
    ok(s2.holdFound === true, 'A7 负数结算 holdFound=true');

    // A9：字符串 actual
    const a3 = fresh(yuan(1));
    const ah3 = bal.hold(a3, yuan(0.3), {}, T0);
    bal.settleHold(a3, ah3.id, 'abc', { reason: 'str' }, T0);
    eq(a3.balance.paidMicro, yuan(1), 'A8 ★ 非数字实际额按 0 计（不扣钱、不崩）');

    // A10-A11：非法 id / 非法 amount 不崩
    let threw = null;
    try {
      bal.releaseHold(a3, null, T0);
      bal.releaseHold(a3, undefined, T0);
      bal.releaseHold(a3, 12345, T0);
      bal.settleHold(a3, 'no-such-id', NaN, {}, T0);
    } catch (e) { threw = e; }
    ok(!threw, 'A9 release/settle 传非法 id 不抛错', threw && threw.message);
    ok(bal.hold(a3, NaN, {}, T0).ok === true && a3.balance.holds.length === 0, 'A10 hold(NaN) 视为 0 不占额度');
    ok(bal.hold(a3, -1000, {}, T0).ok === true && a3.balance.holds.length === 0, 'A11 hold(负数) 视为 0 不占额度');

    // A12：consume 传 NaN 不污染余额
    const a4 = fresh(yuan(1));
    bal.consume(a4, NaN, { reason: 'nan' }, T0);
    eq(a4.balance.paidMicro, yuan(1), 'A12 consume(NaN) 不扣钱');

    /* ================= 假上游 / 服务端启动 ================= */
    await new Promise((r) => upServer.listen(0, '127.0.0.1', r));
    const UP_PORT = upServer.address().port;
    await new Promise((r) => rawServer.listen(0, '127.0.0.1', r));
    const RAW_PORT = rawServer.address().port;
    // 取一个「确定没人监听」的端口 → 连接被拒（upReq.error 分支）
    const deadSrv = http.createServer(() => {});
    await new Promise((r) => deadSrv.listen(0, '127.0.0.1', r));
    const DEAD_PORT = deadSrv.address().port;
    await new Promise((r) => deadSrv.close(r));

    const upBase = 'http://127.0.0.1:' + UP_PORT + '/v1';
    fs.writeFileSync(path.join(WORK, 'channels.json'), JSON.stringify({
      channels: [
        { id: 'fake', name: 'fake', provider: 'custom', baseUrl: upBase,
          apiKey: 'sk-fake', model: 'hold-model', models: ['auto', 'hold-model'], timeoutMs: 30000 },
        { id: 'slow', name: 'slow', provider: 'custom', baseUrl: upBase,
          apiKey: 'sk-fake', model: 'hold-model', models: ['auto', 'slow-model'], timeoutMs: 200 },
        { id: 'dead', name: 'dead', provider: 'custom', baseUrl: 'http://127.0.0.1:' + DEAD_PORT + '/v1',
          apiKey: 'sk-fake', model: 'dead-model', models: ['auto', 'dead-model'], timeoutMs: 30000 },
        { id: 'badhdr', name: 'badhdr', provider: 'custom', baseUrl: upBase,
          apiKey: 'sk-bad\nX-Y', model: 'hold-model', models: ['auto', 'bad-model'], timeoutMs: 30000 },
        { id: 'raw', name: 'raw', provider: 'custom',
          baseUrl: 'http://127.0.0.1:' + RAW_PORT + '/v1',
          apiKey: 'sk-raw', model: 'raw-model', models: ['auto', 'raw-model'], timeoutMs: 5000 },
      ],
      active: 'fake',
      highTierModels: [],
    }, null, 2), 'utf8');

    mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
    await new Promise((r) => mod.server.listen(0, '127.0.0.1', r));
    PORT = mod.server.address().port;

    // 单价：in/out 各 ¥0.01/千 token ⇒ small 一次实际成本 200 微元
    eq((await req('PUT', '/api/admin/pricing',
      { set: { 'hold-model': { inPer1k: 0.01, outPer1k: 0.01 } } })).status, 200, 'C1 配价成功');
    eq((await req('PUT', '/api/admin/pricing',
      { balance: { enforce: true, minBalanceMicro: 0 } })).status, 200, 'C2 开启 enforce');

    /* ================= B. ★ 预留泄漏：客户端断开 ================= */
    const ua = await register('abort');
    const ab0 = await meOf(ua.tok);
    const abTotal = ab0.balance.totalMicro;
    ok(abTotal > 0, 'B0 账号有余额可发起请求', ab0.balance);
    const closedBefore = upStat.closed;
    let midB = null;

    // 断开**之前**先测量「进行中确实存在预留」，断开后该用户没有任何在飞请求
    const aborted = await streamAndAbort(bodyOf('hang'), ua.tok, async () => {
      midB = (await meOf(ua.tok)).balance;
    });
    eq(aborted.aborted, true, 'B1 请求收到首帧后客户端断开');
    ok(!!midB && midB.heldMicro > 0, 'B2 ★ 断开前 heldMicro>0（预留确实生效）', midB);
    eq(midB ? midB.totalMicro : -1, abTotal, 'B3 预留不动真实余额（totalMicro 不变）');
    ok(!!midB && midB.availableMicro === abTotal - midB.heldMicro,
      'B4 进行中 availableMicro = totalMicro − heldMicro', midB);

    const abWaited = await waitHeldZero(ua.tok, 2500);
    eq(abWaited.held, 0, 'B5 ★ 断开后 heldMicro 归零（无预留泄漏）', abWaited);
    const abEnd = (await meOf(ua.tok)).balance;
    eq(abEnd.availableMicro, abEnd.totalMicro, 'B6 ★ 断开后 availableMicro 回到 totalMicro');
    eq(abEnd.totalMicro, abTotal, 'B7 ★ 断开不计费（余额原样）');
    eq(await consumeCount(ua.email), 0, 'B8 ★ 断开不产生 consume 流水');
    ok(upStat.closed > closedBefore, 'B9 上游连接被取消（不再跑到超时）',
      { closedBefore, closed: upStat.closed });
    // 断开后额度可复用：立刻再发一次（不该因为残留预留被 402）
    const rReuse = await streamReq(bodyOf('ok'), ua.tok);
    eq(rReuse.status, 200, 'B10 ★ 断开后额度立即可复用（新请求 200，不是 402）');
    eq((await meOf(ua.tok)).balance.heldMicro, 0, 'B11 复用请求结束后仍无残留预留');

    /* ================= C. 上游 4xx/5xx / 401 / 连接拒绝 / 超时 ================= */
    const ub = await register('err');
    const eb = await setTotal(ub.uid, ub.tok, yuan(1));
    eq(eb.totalMicro, yuan(1), 'C3 错误分支账号余额设为 ¥1');

    // C4-C6：上游 500
    const r500 = await streamReq(bodyOf('e500'), ub.tok);
    eq(r500.status, 500, 'C4 上游 500 原样透传');
    let ebw = await waitHeldZero(ub.tok, 2500);
    eq(ebw.held, 0, 'C5 ★ 上游 500 后 heldMicro 归零（预留已释放）', ebw);
    eq(await consumeCount(ub.email), 0, 'C6 ★ 上游 500 无 consume 流水（不扣费）');
    eq((await meOf(ub.tok)).balance.totalMicro, yuan(1), 'C7 上游 500 后余额不变');

    // C8-C10：上游 400
    const r400 = await streamReq(bodyOf('e400'), ub.tok);
    eq(r400.status, 400, 'C8 上游 400 原样透传');
    eq((await waitHeldZero(ub.tok, 2500)).held, 0, 'C9 ★ 上游 400 后 heldMicro 归零');
    eq(await consumeCount(ub.email), 0, 'C10 ★ 上游 400 无 consume 流水');

    // C11-C14：上游 401 → 翻译成 502（不能原样透传给客户端，否则插件误判掉登录）
    const r401 = await streamReq(bodyOf('auth401'), ub.tok);
    eq(r401.status, 502, 'C11 上游 401 被翻译为 502');
    eq(r401.json && r401.json.code, 'UPSTREAM_AUTH', 'C12 502 带 UPSTREAM_AUTH code');
    eq((await waitHeldZero(ub.tok, 2500)).held, 0, 'C13 ★ 上游 401 后 heldMicro 归零');
    eq(await consumeCount(ub.email), 0, 'C14 ★ 上游 401 无 consume 流水');
    eq((await meOf(ub.tok)).balance.totalMicro, yuan(1), 'C15 401 后余额不变');

    // C16-C19：连接被拒（upReq.on('error') 分支）
    await req('PUT', '/api/admin/channels/active', { id: 'dead' });
    const rDead = await streamReq({ model: 'dead-model', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }] }, ub.tok);
    eq(rDead.status, 502, 'C16 连接被拒 → 502');
    eq((await waitHeldZero(ub.tok, 2500)).held, 0, 'C17 ★ 连接被拒后 heldMicro 归零');
    eq(await consumeCount(ub.email), 0, 'C18 ★ 连接被拒无 consume 流水');
    eq((await meOf(ub.tok)).balance.totalMicro, yuan(1), 'C19 连接被拒后余额不变');

    // C20-C23：上游超时（upReq.on('timeout') 分支；slow 通道 timeoutMs=200 ⇒ 1s）
    await req('PUT', '/api/admin/channels/active', { id: 'slow' });
    const t0 = Date.now();
    const rSlow = await streamReq({ model: 'slow-model', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }], metadata: { kase: 'hang' } }, ub.tok);
    const slowMs = Date.now() - t0;
    ok(rSlow.status === 502 || rSlow.status === 200, 'C20 超时分支有响应（502 或已发的 200）', rSlow.status);
    eq((await waitHeldZero(ub.tok, 2500)).held, 0, 'C21 ★ 上游超时后 heldMicro 归零');
    eq(await consumeCount(ub.email), 0, 'C22 ★ 上游超时不扣费（无 consume 流水）');
    eq((await meOf(ub.tok)).balance.totalMicro, yuan(1), 'C23 超时后余额不变');
    ok(slowMs < 20000, 'C24 超时由通道 timeoutMs 驱动（未跑到 120s 上限）', slowMs);

    // C25-C29：上游吐非法状态码 600（writeHead 会抛 RangeError 的区间）
    await req('PUT', '/api/admin/channels/active', { id: 'raw' });
    const rawBefore = rawStat.requests;
    const r600 = await streamReq({ model: 'raw-model', messages: [{ role: 'user', content: 'hi' }] }, ub.tok);
    eq(rawStat.requests, rawBefore + 1, 'C25 裸上游确实回了 600');
    eq(r600.status, 502, 'C26 ★ 上游 600 被夹到 502（不再是 600 或崩溃）', r600.status);
    ok(r600.json && /^UPSTREAM_/.test(String(r600.json.code || '')),
      'C26b 502 带 UPSTREAM_* 家族的可编程 code（不锁具体名字，避免重命名即红）', r600.json);
    eq((await waitHeldZero(ub.tok, 2500)).held, 0, 'C27 ★ 上游 600 后 heldMicro 归零（预留已释放）');
    eq(await consumeCount(ub.email), 0, 'C28 ★ 上游 600 无 consume 流水');
    eq((await meOf(ub.tok)).balance.totalMicro, yuan(1), 'C29 上游 600 后余额不变');
    eq((await req('GET', '/api/health')).status, 200, 'C29b ★ 上游 600 后进程仍健康（health 200）');

    await req('PUT', '/api/admin/channels/active', { id: 'fake' });

    /* ================= D. 连续 10 次串行：无泄漏、金额精确 ================= */
    const uc = await register('serial');
    const sc0 = await meOf(uc.tok);
    const startTotal = sc0.balance.totalMicro;
    ok(startTotal > 5000, 'D1 串行账号余额充足（可容纳 10 次预留）', sc0.balance);
    let serialOk = 0;
    let maxHeld = 0;
    for (let i = 0; i < 10; i++) {
      const r = await streamReq(bodyOf('ok'), uc.tok);
      if (r.status === 200) serialOk++;
      const now = (await meOf(uc.tok)).balance.heldMicro;
      if (now > maxHeld) maxHeld = now;
    }
    eq(serialOk, 10, 'D2 ★ 10 次串行请求全部 200');
    eq(maxHeld, 0, 'D3 ★ 每次请求结束后 heldMicro 立即归零（无累积泄漏）', maxHeld);
    const scEnd = (await meOf(uc.tok)).balance;
    eq(scEnd.heldMicro, 0, 'D4 ★ 10 次后 heldMicro=0');
    eq(scEnd.totalMicro, startTotal - 10 * 200, 'D5 ★ 余额 = 初始 − 10×200 微元（逐笔成本之和）');
    eq(scEnd.availableMicro, scEnd.totalMicro, 'D6 无预留时 availableMicro == totalMicro');
    eq(await consumeCount(uc.email), 10, 'D7 恰好 10 条 consume 流水（不多不少）');

    /* ================= E. 观察模式（enforce=false）并发 3 个 ================= */
    await req('PUT', '/api/admin/pricing', { balance: { enforce: false } });
    const ud = await register('obs');
    const ob0 = await setTotal(ud.uid, ud.tok, 0);
    eq(ob0.totalMicro, 0, 'E1 观察模式账号余额清零（enforce=false 时 0 元也放行）');
    const up3 = [streamReq(bodyOf('ok'), ud.tok), streamReq(bodyOf('ok'), ud.tok), streamReq(bodyOf('ok'), ud.tok)];
    const r3 = await Promise.all(up3);
    eq(r3.filter((x) => x.status === 200).length, 3, 'E2 ★ 观察模式并发 3 个请求全部 200（不因预留 402）',
      r3.map((x) => x.status));
    const ob1 = (await meOf(ud.tok)).balance;
    eq(ob1.heldMicro, 0, 'E3 ★ 观察模式不产生预留（heldMicro=0）');
    eq(ob1.totalMicro, -600, 'E4 ★ 观察模式照常记账：3×200 微元全部扣（余额可为负）');
    await req('PUT', '/api/admin/pricing', { balance: { enforce: true } });

    /* ================= E2. 接线层：8 条在飞 → 第 9 条 TOO_MANY_HOLDS =================
     * A 段（纯函数）只证明 hold() 会拒，证明不了网关是否把 hd.code 正确透出、
     * 以及第 9 条会不会破坏前 8 条的预留/结算。这里做端到端。
     */
    const h8before = (await meOf(uc.tok)).balance;
    const h8consume0 = await consumeCount(uc.email);
    // ★ 上限由实现常量驱动，不写字面量 8：HOLDS_MAX 若调整，用例自动跟随，
    //   仍能校验「文案里的上限 == 实现的上限」（防止文案与实现漂移）。
    const MAXH = bal.HOLDS_MAX;
    const inflight = [];
    for (let i = 0; i < MAXH; i++) inflight.push(streamReq(bodyOf('slow'), uc.tok));
    await sleep(500);
    const mid8 = (await meOf(uc.tok)).balance;
    ok(mid8.heldMicro > 0, 'E2.1 ★ ' + MAXH + ' 条在飞时 heldMicro>0（' + MAXH + ' 笔预留叠加）', mid8);
    eq(mid8.availableMicro, mid8.totalMicro - mid8.heldMicro, 'E2.2 可用额 = 余额 − 预留（口径自洽）');
    const heldSnap = mid8.heldMicro;

    const r9 = await streamReq(bodyOf('slow'), uc.tok);
    eq(r9.status, 402, 'E2.3 ★ 第 ' + (MAXH + 1) + ' 条被 402 拦下');
    eq(r9.json && r9.json.code, 'TOO_MANY_HOLDS', 'E2.4 ★ code=TOO_MANY_HOLDS（不再误报余额/订阅不足）');
    const e9 = (r9.json && r9.json.error) || '';
    ok(/并发请求过多/.test(e9), 'E2.5 ★ 文案说「并发请求过多」并给出可操作指引', e9);
    ok(!/余额不足/.test(e9), 'E2.6 ★ 文案不归因余额（余额充足时不得谎称不足）', e9);
    ok(new RegExp('最多\\s*' + MAXH + '\\s*个').test(e9),
      'E2.7 文案点明的上限与 balance.HOLDS_MAX 一致（' + MAXH + '，防文案与实现漂移）', e9);

    const mid8b = (await meOf(uc.tok)).balance;
    eq(mid8b.heldMicro, heldSnap, 'E2.8 ★ 第 ' + (MAXH + 1) + ' 条未破坏前 ' + MAXH + ' 条的预留（heldMicro 不变）');
    eq(mid8b.totalMicro, h8before.totalMicro, 'E2.9 第 ' + (MAXH + 1) + ' 条未扣费（余额不变）');

    const r8 = await Promise.all(inflight);
    eq(r8.filter((x) => x.status === 200).length, MAXH,
      'E2.10 ★ 前 ' + MAXH + ' 条全部正常完成 200', r8.map((x) => x.status));
    eq((await waitHeldZero(uc.tok, 4000)).held, 0, 'E2.11 ★ 全部结算后 heldMicro 归零（无泄漏）');
    const after8 = (await meOf(uc.tok)).balance;
    eq(after8.totalMicro, h8before.totalMicro - MAXH * 200,
      'E2.12 ★ ' + MAXH + ' 条各按实际成本 200 结算（合计 −' + (MAXH * 200) + '）');
    eq((await consumeCount(uc.email)) - h8consume0, MAXH,
      'E2.13 ★ 恰新增 ' + MAXH + ' 条 consume 流水（不多不少）');

    /* ---- E3. 真·余额不足：code 与文案必须保持不变（此处「余额不足」是正确表述） ---- */
    const rPoor = await streamReq(bodyOf('ok'), ud.tok);   // ud 余额为负
    eq(rPoor.status, 402, 'E3.1 真·余额不足仍 402');
    eq(rPoor.json && rPoor.json.code, 'INSUFFICIENT_BALANCE', 'E3.2 ★ 真·余额不足 code 仍为 INSUFFICIENT_BALANCE');
    const ePoor = (rPoor.json && rPoor.json.error) || '';
    ok(/余额不足/.test(ePoor), 'E3.3 ★ 真·余额不足文案仍含「余额不足」（既有文案一字未改）', ePoor);
    ok(/充值|升级/.test(ePoor), 'E3.4 既有文案仍保留充值/升级出路', ePoor);

    /* ================= F. 脏数据自愈（reload 后 available 正确） ================= */
    const ue = await register('dirty');
    const de = await setTotal(ue.uid, ue.tok, yuan(2));
    eq(de.totalMicro, yuan(2), 'F1 脏数据账号余额 ¥2');

    const usersPath = path.join(WORK, 'users.json');
    const readUsers = () => JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    const writeUsers = (d) => fs.writeFileSync(usersPath, JSON.stringify(d, null, 2), 'utf8');
    const patchUser = (email, fn) => {
      try { mod.usersWriter.flush(); } catch (e) { /* ignore */ }
      const d = readUsers();
      const u = d.users.find((x) => x.email === email);
      fn(u);
      writeUsers(d);
      mod.reloadStores();
    };

    // F2-F4：heldMicro 虚高 999999、holds 为空 → 自愈为 0
    patchUser(ue.email, (u) => { u.balance.heldMicro = 999999; u.balance.holds = []; });
    const f1 = (await meOf(ue.tok)).balance;
    eq(f1.heldMicro, 0, 'F2 ★ heldMicro 虚高被 holds 重算纠正为 0（脏数据自愈）');
    eq(f1.availableMicro, yuan(2), 'F3 ★ 自愈后 availableMicro == totalMicro（额度不再凭空少）');
    eq(f1.totalMicro, yuan(2), 'F4 自愈不动真实余额');

    // F5-F7：holds 有明细但 heldMicro=0 → 自愈为明细之和
    const ghostAt = Date.now();
    patchUser(ue.email, (u) => {
      u.balance.heldMicro = 0;
      u.balance.holds = [{ id: 'ghost-1', micro: 500, at: ghostAt, highTier: false }];
    });
    const f2 = (await meOf(ue.tok)).balance;
    eq(f2.heldMicro, 500, 'F5 ★ 明细存在但总额缺失 → heldMicro 由明细重算（500）');
    eq(f2.availableMicro, yuan(2) - 500, 'F6 ★ 不可用额度如实反映（避免并发超发）');
    eq(f2.totalMicro, yuan(2), 'F7 预占不影响真实余额');

    // F8-F9：非法明细项被过滤 + 收尾清理
    patchUser(ue.email, (u) => {
      u.balance.holds = [
        { id: 'ghost-1', micro: 500, at: ghostAt },
        null, { id: '', micro: 9, at: ghostAt }, { id: 'bad', micro: -5, at: ghostAt },
        { id: 'bad2', micro: 7, at: 'x' },
      ];
      u.balance.heldMicro = 12345;
    });
    const f3 = (await meOf(ue.tok)).balance;
    eq(f3.heldMicro, 500, 'F8 ★ 非法明细被过滤，heldMicro 只算合法项');
    patchUser(ue.email, (u) => { u.balance.holds = []; u.balance.heldMicro = 0; });
    eq((await meOf(ue.tok)).balance.heldMicro, 0, 'F9 清理脏数据后 heldMicro=0');

    /* ================= G. 对抗探针：hold 之后的未捕获出口 + 双响应/双释放 =================
     * 代码审计：`mod.request(u, {...})` 在 hold 之后（原 L1598）。apiKey 若含非 latin1
     * 字符（管理员粘密钥很常见），http.request 同步抛 ERR_INVALID_CHAR → 外层 async 处理器
     * reject → 服务端模块级 unhandledRejection 兜底 process.exit(1)（整台后台被杀 + 预留不回滚）。
     * 该路径会**带走整个测试进程**，所以 4 个场景全放子进程里跑。
     */
    const crashBefore = crashLogLines();
    const probe = await probeBadHeader();
    const A = probe.A || {};
    const B = probe.B || {};
    const C = probe.C || {};
    const D = probe.D || {};

    ok(probe.done && probe.code === 0, 'G1 ★ 4 个对抗场景全部跑完、进程存活（exit=' + probe.code + '）',
      { done: probe.done, tail: probe.out.slice(-300) });
    eq(A.status, 502, 'G2 ★ 坏密钥 → 502（不再是崩溃）');
    eq(A.code, 'UPSTREAM_CONFIG', 'G3 ★ 502 带 code=UPSTREAM_CONFIG（前端可定位「密钥混入非法字符」）');
    eq(A.held, 0, 'G4 ★ 坏密钥出口已释放预留（held=0）');

    eq(B.held, 0, 'G5 ★ 坏密钥 + 客户端抢在 502 前断开 → held=0（只走一次终态，无双释放）');
    ok(B.clientErr || B.status === 502 || B.status === 0,
      'G6 断开场景客户端侧表现正常（无第二个响应体）', B);

    ok(Array.isArray(C.statuses) && C.statuses.length === 5 && C.statuses.every((s) => s === 502),
      'G7 ★ 连续 5 次坏密钥：每次都是 502', C.statuses);
    eq(C.heldMax, 0, 'G8 ★ 5 次坏密钥期间 heldMicro 恒为 0（每次终态都归零）');
    eq(C.consume, 0, 'G9 ★ 5 次坏密钥未产生任何 consume 流水（无错扣）');

    eq(D.status, 200, 'G10 ★ 风暴后正常请求仍 200（链路未被污染）');
    eq(D.delta, -200, 'G11 ★ 风暴后正常请求恰好扣 200 微元（无双结算/双释放导致的账本错乱）');
    eq(D.held, 0, 'G12 风暴后无残留预留');
    eq(D.consume, 1, 'G13 全程只有这一次成功调用留下 consume 流水');
    eq(crashLogLines(), crashBefore, 'G14 ★ 全程无新增 server-crash.log（进程从未崩溃）');
    ok(!/write after end|ERR_STREAM_WRITE_AFTER_END|ERR_HTTP_HEADERS_SENT|Cannot set headers/i.test(probe.out),
      'G15 ★ 无「双响应」痕迹（未出现 write-after-end / headers-already-sent）',
      probe.out.slice(-300));
    probeNote = 'A=' + JSON.stringify(A) + ' B=' + JSON.stringify(B)
      + ' C=' + JSON.stringify(C) + ' D=' + JSON.stringify(D);

    /* ================= H. 收尾：全局无残留 ================= */
    eq((await meOf(uc.tok)).balance.heldMicro, 0, 'H1 串行账号最终无残留预留');
    eq((await meOf(ua.tok)).balance.heldMicro, 0, 'H2 断开账号最终无残留预留');
    eq((await meOf(ub.tok)).balance.heldMicro, 0, 'H3 错误分支账号最终无残留预留');
    const h = await req('GET', '/api/health');
    eq(h.status, 200, 'H4 ★ 全部异常路径未导致进程退出（health 仍 200）');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { if (mod) mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    try { if (mod) mod.server.close(); } catch (e) { /* ignore */ }
    try { upServer.close(); } catch (e) { /* ignore */ }
    try { rawServer.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n余额预占独立审计：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (probeNote) console.log('  子进程探针：' + probeNote);
  if (unhandled.length) {
    console.log('  未捕获异常 ' + unhandled.length + ' 条：');
    for (const u of unhandled.slice(0, 5)) console.log('    · ' + u);
  }
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
  process.exit(0);   // keep-alive 连接会让 server.close 永不回调，测试进程必须显式退出
})();
