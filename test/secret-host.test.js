#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 密钥托管集成测试（服务端 1.9.0）
 *
 * 契约：
 *   GET    /api/user/secrets        → 只回掩码（set/hint/updatedAt），绝不回明文
 *   GET    /api/user/secrets/<name> → 明文，必须登录
 *   PUT    /api/user/secrets/<name> → { value }；空字符串 = 删除
 *   DELETE /api/user/secrets/<name> → 删除
 *
 * 本文件要守住的三条线：
 *   ① **落盘无明文**：users.json 里只有 secretbox 密文（备份被拿走也解不开）
 *   ② **账号隔离**：B 永远读不到 A 的 Key（哪怕知道路径）
 *   ③ **审计不泄密**：audit.log 只允许出现掩码
 *
 * 运行：node test/secret-host.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-secret-'));
let PORT = 0;

process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
delete process.env.PP_ALERT_EMAIL;
process.env.PP_LOGIN_MAX = '500';
process.env.PP_SECRET_GET_MAX = '500';
process.env.PP_SECRET_PUT_MAX = '500';

const SERVER = path.join(__dirname, '..', 'server', 'account-server.js');
const mod = require(SERVER);
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
    const r = http.request({
      host: '127.0.0.1', port: PORT, method, path: p, headers,
      agent: false,            // ★ 必须：Node 19+ 默认 keep-alive，复用被服务端关掉的 socket 会偶发 ECONNRESET
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const KEY = '0ad3dcb704e74f6780c6f66d868d8a23';   // 32 位假 Key，形同真实 SecretKey
const KEY2 = 'ffffffffffffffffffffffffffffffff';

(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  PORT = server.address().port;

  try {
    await req('POST', '/api/auth/register', { email: 'a@secret.local', password: 'pw12345678' });
    await req('POST', '/api/auth/register', { email: 'b@secret.local', password: 'pw12345678' });
    const tokA = (await req('POST', '/api/auth/login', { email: 'a@secret.local', password: 'pw12345678' })).json.token;
    const tokB = (await req('POST', '/api/auth/login', { email: 'b@secret.local', password: 'pw12345678' })).json.token;
    ok(!!tokA && !!tokB, 'A1 两个账号都拿到令牌');

    /* ---- 登录态 ---- */
    let r = await req('GET', '/api/user/secrets');
    eq(r.status, 401, 'A2 未登录读列表 → 401');
    r = await req('GET', '/api/user/secrets/easyscholar');
    eq(r.status, 401, 'A3 未登录取明文 → 401');
    r = await req('PUT', '/api/user/secrets/easyscholar', { value: KEY });
    eq(r.status, 401, 'A4 未登录写入 → 401');

    /* ---- 初始状态 ---- */
    r = await req('GET', '/api/user/secrets', null, tokA);
    eq(r.status, 200, 'A5 登录后读列表成功');
    eq(r.json.secrets.easyscholar.set, false, 'A6 新账号默认未托管');

    /* ---- 保存 ---- */
    r = await req('PUT', '/api/user/secrets/easyscholar', { value: KEY }, tokA);
    eq(r.status, 200, 'A7 保存成功');
    eq(r.json.secrets.easyscholar.set, true, 'A8 状态变为已托管');
    ok(/^0ad3…8a23$/.test(r.json.secrets.easyscholar.hint), 'A9 回显是掩码（前4…后4）', r.json.secrets.easyscholar.hint);
    ok(!r.text.includes(KEY), 'A10 写入响应里没有明文');

    /* ---- 列表不回明文 ---- */
    r = await req('GET', '/api/user/secrets', null, tokA);
    ok(!r.text.includes(KEY), 'A11 列表响应里没有明文');
    ok(!r.text.includes('enc'), 'A12 列表不暴露密文字段');

    /* ---- 明文取回 ---- */
    r = await req('GET', '/api/user/secrets/easyscholar', null, tokA);
    eq(r.status, 200, 'A13 取回明文成功');
    eq(r.json.value, KEY, 'A14 取回的值与存的一致');

    /* ---- 落盘无明文 ---- */
    const usersRaw = fs.readFileSync(path.join(WORK, 'users.json'), 'utf8');
    ok(!usersRaw.includes(KEY), 'A15 users.json 里没有明文');
    const usersDoc = JSON.parse(usersRaw);
    const ua = usersDoc.users.find((u) => u.email === 'a@secret.local');
    ok(!!(ua.secrets && ua.secrets.easyscholar && ua.secrets.easyscholar.enc), 'A16 落盘的是密文对象');
    ok(!/0ad3dcb7/.test(JSON.stringify(ua.secrets)), 'A17 密文对象里也没有明文片段');
    eq(ua.secrets.easyscholar.hint, '0ad3…8a23', 'A18 落盘只保留掩码');

    /* ---- 账号隔离 ---- */
    r = await req('GET', '/api/user/secrets', null, tokB);
    eq(r.json.secrets.easyscholar.set, false, 'A19 B 账号看不到 A 的托管状态');
    r = await req('GET', '/api/user/secrets/easyscholar', null, tokB);
    eq(r.status, 404, 'A20 B 取 A 的明文 → 404（隔离）');
    r = await req('PUT', '/api/user/secrets/easyscholar', { value: KEY2 }, tokB);
    eq(r.status, 200, 'A21 B 存自己的 Key 不冲突');
    const tokA2 = (await req('GET', '/api/user/secrets/easyscholar', null, tokA)).json.value;
    eq(tokA2, KEY, 'A22 两个账号各存各的，互不覆盖');

    /* ---- 覆盖更新 ---- */
    r = await req('PUT', '/api/user/secrets/easyscholar', { value: KEY }, tokB);
    eq(r.json.secrets.easyscholar.hint, '0ad3…8a23', 'A23 重复保存是覆盖，不是追加');

    /* ---- 空值 = 删除 ---- */
    r = await req('PUT', '/api/user/secrets/easyscholar', { value: '   ' }, tokB);
    eq(r.json.secrets.easyscholar.set, false, 'A24 写入空白值 = 删除');
    r = await req('DELETE', '/api/user/secrets/easyscholar', null, tokA);
    eq(r.status, 200, 'A25 DELETE 成功');
    eq(r.json.secrets.easyscholar.set, false, 'A26 删除后状态为未托管');
    r = await req('GET', '/api/user/secrets/easyscholar', null, tokA);
    eq(r.status, 404, 'A27 删除后取明文 → 404');

    /* ---- 输入校验 ---- */
    r = await req('PUT', '/api/user/secrets/easyscholar', { value: 'x'.repeat(201) }, tokA);
    eq(r.status, 400, 'A28 超长 Key → 400');
    r = await req('GET', '/api/user/secrets/nosuchkey', null, tokA);
    eq(r.status, 404, 'A29 未知密钥类型 → 404');
    r = await req('PUT', '/api/user/secrets/nosuchkey', { value: 'x' }, tokA);
    eq(r.status, 404, 'A30 未知类型写入 → 404');

    /* ---- 审计只留掩码 ---- */
    await req('PUT', '/api/user/secrets/easyscholar', { value: KEY }, tokA);
    const auditFile = path.join(WORK, 'audit.log');
    const auditRaw = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '';
    ok(auditRaw.includes('user.secret'), 'A31 审计里记了 user.secret');
    ok(!auditRaw.includes(KEY), 'A32 审计里没有明文');
    ok(auditRaw.includes('0ad3…8a23'), 'A33 审计里只有掩码');

    /* ---- 客户端信息不受影响 ---- */
    r = await req('GET', '/api/auth/me', null, tokA);
    eq(r.status, 200, 'A34 /api/auth/me 正常');
    ok(!r.text.includes('secrets'), 'A35 用户信息里不带 secrets 字段');
  } catch (e) {
    fails.push('未捕获异常: ' + (e && e.stack || e));
  } finally {
    server.close();
  }

  if (fails.length) {
    console.error(`\n✗ 密钥托管测试失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`✓ 密钥托管测试全部通过（${pass} 项）`);
  process.exit(0);
})();
