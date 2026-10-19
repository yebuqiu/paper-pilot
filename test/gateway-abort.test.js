#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 网关客户端断开处理测试（服务端 1.8.5，审查 P1-2）
 *
 * 缺陷：gatewayChat 只在写响应时判 res.writableEnded，从不监听客户端断开。
 *   · 插件点「停止」/关窗口/断网后，上游请求继续跑到超时（最长 120s），token 白烧；
 *   · 继续向已销毁的响应写数据，可能抛出未处理 error 触发 uncaughtException（进程退出）。
 *
 * 契约（本套件锁定）：
 *   ① 客户端一断开，上游 socket 必须被立刻销毁（不等到超时）；
 *   ② 服务端进程不能因此崩溃（断开后 /api/health 仍 200）；
 *   ③ 断开不产生计费/用量（用户感知「停止即停止」）。
 *
 * 运行：node test/gateway-abort.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gwabort-'));

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 假上游：先回头，再每 50ms 推一帧 ---------------- */
const upstream = { closed: false, requests: 0, finished: false };
const upServer = http.createServer((req, res) => {
  upstream.requests++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let n = 0;
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(timer); return; }
    n++;
    res.write('data: {"model":"fake-1","choices":[{"delta":{"content":"x"}}]}\n\n');
    if (n >= 100) { clearInterval(timer); res.end(); upstream.finished = true; }
  }, 50);
  const onGone = () => {
    upstream.closed = true;
    clearInterval(timer);
    try { res.destroy(); } catch (e) { /* ignore */ }
  };
  req.on('close', onGone);
  res.on('close', onGone);
});

function req2(port, method, p, body, token, options) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Host: '127.0.0.1:' + port };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* sse */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  await new Promise((r) => upServer.listen(0, '127.0.0.1', r));
  const UP_PORT = upServer.address().port;

  // 通道配置必须在 require 之前落盘（模块加载时读取）
  fs.writeFileSync(path.join(WORK, 'channels.json'), JSON.stringify({
    channels: [{
      id: 'fake', name: 'fake', provider: 'openai',
      baseUrl: 'http://127.0.0.1:' + UP_PORT,
      apiKey: 'k', model: 'fake-1', models: ['fake-1'], timeoutMs: 30000,
    }],
    active: 'fake',
  }), 'utf8');

  process.env.PP_DATA_DIR = WORK;
  process.env.PP_PORT = '0';
  delete process.env.PP_RESEND_KEY;
  process.env.PP_LOGIN_MAX = '500';
  process.env.PP_REG_MAX = '50';

  const mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
  const { server } = mod;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;

  // 注册 + 登录拿令牌
  await req2(PORT, 'POST', '/api/auth/register', { email: 'abort@example.com', password: 'pass12345' });
  const login = await req2(PORT, 'POST', '/api/auth/login', { email: 'abort@example.com', password: 'pass12345' });
  ok(login.status === 200 && login.json && login.json.token, '登录成功并拿到令牌', login);
  const token = login.json.token;

  // 发起流式请求，收到第一帧后立刻断开（模拟插件 Stop / 关窗）
  let firstChunk = false;
  await new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({
      model: 'fake-1', stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: {
        Host: '127.0.0.1:' + PORT,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: 'Bearer ' + token,
      },
    }, (res) => {
      res.on('data', () => {
        if (!firstChunk) {
          firstChunk = true;
          r.destroy();          // ★ 客户端断开
          resolve();
        }
      });
      res.on('error', () => resolve());
    });
    r.on('error', () => resolve());
    r.write(payload);
    r.end();
  });
  eq(firstChunk, true, '客户端收到了第一帧（确认链路已建立）');

  // 等上游被取消（正常应 <100ms；给 1.5s 宽限）
  for (let i = 0; i < 15 && !upstream.closed; i++) await sleep(100);
  eq(upstream.closed, true, '★ 客户端断开后上游 socket 被立刻销毁（不再跑到超时）');
  eq(upstream.finished, false, '上游没有被正常跑完（证明是取消而非自然结束）');

  // 进程不能崩：断开后 health 仍 200
  const h = await req2(PORT, 'GET', '/api/health');
  eq(h.status, 200, '★ 断开未导致进程退出（health 仍 200）');

  // 断开不计费：余额流水里没有 consume
  const me = await req2(PORT, 'GET', '/api/auth/me', undefined, token);
  const ledger = (me.json && me.json.user && me.json.user.balance && me.json.user.balance.ledger) || [];
  eq(ledger.filter((e) => e && e.kind === 'consume').length, 0, '★ 客户端取消不产生扣费流水');
}

main().catch((e) => {
  fails.push('用例异常：' + (e && e.stack || e));
}).then(() => {
  try { server && server.close(); } catch (e) { /* ignore */ }
  try { upServer.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (fails.length) {
    console.error('\n网关断开处理测试失败 ' + fails.length + ' 项（通过 ' + pass + '）：');
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('网关断开处理测试通过：' + pass + ' 项');
  process.exit(0);   // keep-alive 连接会让 server.close 永不回调，测试进程必须显式退出
});
