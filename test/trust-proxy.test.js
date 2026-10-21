#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* PP_TRUST_PROXY 代理头信任开关测试（服务端 1.9.1，审查 P1-4）
 *
 * 背景：clientIp() 之前无条件读 CF-Connecting-IP / X-Forwarded-For，攻击者
 * 只要伪造不同的 XFF 就能把每 IP 限速（登录/注册/激活码/支付回调）打散到
 * 根本不存在的 IP 上，等于没限速。1.9.1 起：只有显式 PP_TRUST_PROXY=1
 * （隧道/反代部署在 pp.env 里配置）才读代理头；否则一律用 socket 对端 IP。
 *
 * 本测试用**登录限速**做观测点：
 *   · 同一 socket IP（127.0.0.1）发 N 次错密码登录；
 *   · 信任代理时：每次带不同 XFF → 每次都被认成新 IP → 永远不 429；
 *   · 不信任代理时（默认）：伪造 XFF 无效 → 仍按 127.0.0.1 计数 → 达到阈值 429。
 *
 * 运行：node test/trust-proxy.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'account-server.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function req(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    if (data) h['Content-Length'] = data.length;
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, headers: h, agent: false,
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 找一个当前空闲的 TCP 端口（listen(0) 取到再立刻关掉） */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 启动一个独立 account-server 进程（独立 DATA_DIR，env 可注入），返回 {proc, port, work} */
async function startServer(extraEnv) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-trustproxy-'));
  const port = await pickFreePort();
  const env = Object.assign({}, process.env, {
    PP_DATA_DIR: work,
    PP_PORT: String(port),
    PP_LOGIN_MAX: '3',      // 3 次就触发限速，缩短测试时间
    PP_RESEND_KEY: '',      // 关闭邮件，避免外发
  }, extraEnv || {});
  const proc = spawn(process.execPath, [SERVER], {
    env, cwd: path.join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 等服务就绪：轮询 /api/health 最多 10 秒
  const deadline = Date.now() + 10000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await req(port, 'GET', '/api/health', { Host: '127.0.0.1:' + port });
      if (r.status === 200) return { proc, port, work };
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  throw new Error('server not ready in 10s: ' + (lastErr && lastErr.message));
}

/** 反复用错密码登录，每次都伪造不同的 XFF；返回最后一次响应 */
async function hammerLogin(port, n) {
  let last = null;
  for (let i = 0; i < n; i++) {
    last = await req(port, 'POST', '/api/auth/login', {
      // 每次换一个不存在的公网 IP——若服务端信 XFF，每次都当成新访客
      'X-Forwarded-For': '203.0.113.' + (i + 1),
      'CF-Connecting-IP': '203.0.113.' + (i + 1),
    }, { email: 'nobody@example.com', password: 'wrong-password-' + i });
  }
  return last;
}

async function run() {
  // ---------- A. 未设 PP_TRUST_PROXY（默认）：伪造 XFF 无效，仍按 socket IP 限速 ----------
  {
    const s = await startServer({ /* 不传 PP_TRUST_PROXY */ });
    try {
      const r = await hammerLogin(s.port, 5);    // PP_LOGIN_MAX=3，第 4 次起应 429
      eq(r.status, 429, '默认（不信任代理）：伪造 XFF 仍按 socket IP 计数，第 5 次被限速');
    } finally {
      try { s.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
      try { fs.rmSync(s.work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }

  // ---------- B. PP_TRUST_PROXY=1：信代理头，每次伪造新 XFF 都视为新 IP，永不限速 ----------
  {
    const s = await startServer({ PP_TRUST_PROXY: '1' });
    try {
      const r = await hammerLogin(s.port, 5);
      // 隧道部署下 XFF 每次都是新 IP → 不触发 IP 限速 → 仍是 401（密码错）而不是 429
      eq(r.status, 401, 'PP_TRUST_PROXY=1：每次伪造新 XFF → 不限速，仍 401');
    } finally {
      try { s.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
      try { fs.rmSync(s.work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
}

run().catch((e) => {
  fails.push('用例异常：' + (e && e.stack || e));
}).then(() => {
  if (fails.length) {
    console.error('\nPP_TRUST_PROXY 测试失败 ' + fails.length + ' 项（通过 ' + pass + '）：');
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('PP_TRUST_PROXY 测试通过：' + pass + ' 项');
});
