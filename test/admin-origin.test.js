#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 管理面来源校验测试（服务端 1.8.5）
 *
 * 背景（审查 P0-2）：管理 API 原先只判「socket 是回环 + 无代理头」。恶意网页把自己的
 * 域名 DNS 重新绑定到 127.0.0.1 后，浏览器发出的请求 socket 同样来自回环、也没有
 * CF/XFF 头，于是可以直接读用户、改会员、调余额。修复是补三道：
 *   · Host 必须是 127.0.0.1 / localhost / [::1]（可带端口）
 *   · 带 Origin 时必须是本机 http 源（`Origin: null` 也拒）
 *   · Sec-Fetch-Site 存在时必须是 same-origin / none
 *
 * 运行：node test/admin-origin.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-admin-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
delete process.env.PP_ALERT_EMAIL;
process.env.PP_LOGIN_MAX = '500';

const SERVER = path.join(__dirname, '..', 'server', 'account-server.js');
const { server } = require(SERVER);

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

let PORT = 0;

/** headers 里的 Host 用 setHost:false 才能真正省略（Node 默认会补） */
function req(method, p, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    const r = http.request({
      host: '127.0.0.1', port: PORT, method, path: p, headers: h, agent: false, setHost: false,
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

async function run() {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  PORT = server.address().port;

  const HOST_OK = '127.0.0.1:' + PORT;
  const HOST_LOCALHOST = 'localhost:' + PORT;

  // ① 正常本机访问：启动器 / 管理页
  let r = await req('GET', '/api/admin/users', { Host: HOST_OK });
  eq(r.status, 200, '本机 127.0.0.1 + 无 Origin → 放行');
  r = await req('GET', '/api/admin/users', { Host: HOST_LOCALHOST });
  eq(r.status, 200, '本机 localhost → 放行');
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, Origin: 'http://' + HOST_OK });
  eq(r.status, 200, '本机同源 Origin → 放行');
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, 'Sec-Fetch-Site': 'same-origin' });
  eq(r.status, 200, 'Sec-Fetch-Site: same-origin → 放行');

  // ② DNS rebinding：Host 是攻击者域名（socket 仍是回环）
  r = await req('GET', '/api/admin/users', { Host: 'evil.example:' + PORT });
  eq(r.status, 403, '★ Host=攻击者域名 → 拒绝（rebinding）');
  r = await req('GET', '/api/admin/users', { Host: '127.0.0.1.evil.example:' + PORT });
  eq(r.status, 403, '★ Host=127.0.0.1.evil.example → 拒绝');
  r = await req('GET', '/api/admin/users', { Host: 'localhost.evil.example' });
  eq(r.status, 403, '★ Host=localhost.evil.example → 拒绝');
  r = await req('GET', '/api/admin/users', {});
  ok(r.status === 400 || r.status === 403, '缺 Host 头 → 拒绝（Node 直接 400）', { status: r.status });
  r = await req('GET', '/admin', { Host: 'evil.example:' + PORT });
  eq(r.status, 403, '★ 管理页在攻击者 Host 下也不可读');

  // ③ 跨站 Origin / Fetch Metadata
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, Origin: 'http://evil.example' });
  eq(r.status, 403, '★ 跨站 Origin → 拒绝（CSRF）');
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, Origin: 'null' });
  eq(r.status, 403, 'Origin: null → 拒绝');
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, 'Sec-Fetch-Site': 'cross-site' });
  eq(r.status, 403, 'Sec-Fetch-Site: cross-site → 拒绝');
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, 'Sec-Fetch-Site': 'same-site' });
  eq(r.status, 403, 'Sec-Fetch-Site: same-site → 拒绝');

  // ④ 旧行为不回归：代理头出现即视为公网
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, 'X-Forwarded-For': '1.2.3.4' });
  eq(r.status, 403, '带 X-Forwarded-For → 拒绝（Tunnel 回源）');
  r = await req('GET', '/api/admin/users', { Host: HOST_OK, 'CF-Connecting-IP': '1.2.3.4' });
  eq(r.status, 403, '带 CF-Connecting-IP → 拒绝');

  // ⑤ 公网路由不受影响（注册页、health 仍可访问）
  r = await req('GET', '/api/health', { Host: 'pp.example.com' });
  eq(r.status, 200, '公网 Host 访问 /api/health 仍正常');
  r = await req('GET', '/register', { Host: 'pp.example.com' });
  eq(r.status, 200, '公网 Host 访问注册页仍正常');
}

run().catch((e) => {
  fails.push('用例异常：' + (e && e.stack || e));
}).then(() => {
  try { server.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (fails.length) {
    console.error('\n管理面来源校验测试失败 ' + fails.length + ' 项（通过 ' + pass + '）：');
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('管理面来源校验测试通过：' + pass + ' 项');
});
