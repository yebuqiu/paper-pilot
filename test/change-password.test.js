#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 自助修改密码（R1，服务端 1.9.3）
 *
 * 运行：node test/change-password.test.js
 *
 * 覆盖（契约 docs/prd/2026-10-23-账号与会员增强-架构.md §2.1 / §8）：
 *   1. 旧密码错误 → 401「旧密码不正确」且 failCount +1（与登录共享计数）
 *   2. 连续 5 次旧密码错误 → 之后即使旧密码正确也 403 account_locked（带 lockUntil/remainMinutes）
 *   3. 新密码 7 位 → 400；新密码与旧密码相同允许（不额外限制）
 *   4. 成功改密 → 旧 token 访问 /api/auth/me 立即 401（含当前会话被踢）
 *   5. 新密码登录 → 200；旧密码登录 → 401
 *   6. audit.log 存在 action='user.change-password' 一条，且全文不含新旧密码明文与 hash/salt
 *   7. 每账号每分钟超限 → 429
 *   8. 改密前打了 users-change 快照（备份目录出现新快照）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-changepw-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与常驻服务撞端口
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;      // 邮件关闭 → 注册直接激活
process.env.PP_LOGIN_MAX = '8';        // 改密限速与登录同常量；调小便于触发 429

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

function userOnDisk(email) {
  const doc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
  return doc.users.find((x) => x.email === email);
}

/** 备份目录里 users-change 快照的 id 列表 */
function userChangeSnapshots() {
  const root = path.join(WORK, 'backup');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => n.indexOf('users-change') >= 0);
}

async function registerAndLogin(email, password) {
  await req('POST', '/api/auth/register', { email, password });
  const lg = await req('POST', '/api/auth/login', { email, password });
  return lg.json && lg.json.token;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  try {
    /* ============ 1. 旧密码错误 → 401 + failCount 累计 ============ */
    const tokA = await registerAndLogin('cpw-a@t.local', 'oldpass123');
    ok(!!tokA, '1.0 注册并登录成功');
    let r = await req('POST', '/api/auth/change-password', { oldPassword: 'wrong-old', newPassword: 'newpass999' }, tokA);
    eq(r.status, 401, '1.1 旧密码错误 → 401');
    eq(r.json.error, '旧密码不正确', '1.2 应答文案为「旧密码不正确」');
    eq(userOnDisk('cpw-a@t.local').failCount, 1, '1.3 ★ failCount +1（与登录共享计数）');

    /* ============ 2. 连续失败 → 阶梯锁定（与登录共享） ============ */
    for (let i = 0; i < 3; i++) {
      r = await req('POST', '/api/auth/change-password', { oldPassword: 'wrong-old', newPassword: 'newpass999' }, tokA);
      eq(r.status, 401, '2.' + i + ' 第 ' + (i + 2) + ' 次旧密码错误仍 401');
    }
    r = await req('POST', '/api/auth/change-password', { oldPassword: 'wrong-old', newPassword: 'newpass999' }, tokA);
    eq(r.status, 401, '2.3 第 5 次错误仍 401（本次触发锁定）');
    eq(userOnDisk('cpw-a@t.local').failCount, 5, '2.4 failCount 累计到 5');
    ok(!!userOnDisk('cpw-a@t.local').lockUntil, '2.5 已落 lockUntil（锁定生效）');
    // 锁定期内**即使旧密码正确也拒绝**（同 login 语义）
    r = await req('POST', '/api/auth/change-password', { oldPassword: 'oldpass123', newPassword: 'newpass999' }, tokA);
    eq(r.status, 403, '2.6 ★ 锁定后旧密码正确也 403');
    eq(r.json.code, 'account_locked', '2.7 403 带 code=account_locked');
    ok(!!r.json.lockUntil && r.json.remainMinutes > 0, '2.8 403 带 lockUntil 与 remainMinutes',
      { lockUntil: r.json.lockUntil, remainMinutes: r.json.remainMinutes });

    /* ============ 3. 强度校验 ============ */
    const tokB = await registerAndLogin('cpw-b@t.local', 'pw12345678');
    r = await req('POST', '/api/auth/change-password', { oldPassword: 'pw12345678', newPassword: '1234567' }, tokB);
    eq(r.status, 400, '3.1 新密码 7 位 → 400');
    eq(r.json.error, '新密码至少 8 位', '3.2 400 文案与注册同规则');
    // 旧密码验证在强度校验之前：缺旧密码按「旧密码错误」处理（不泄露校验顺序之外的信息）
    r = await req('POST', '/api/auth/change-password', { newPassword: 'newpass999' }, tokB);
    eq(r.status, 401, '3.3 缺 oldPassword → 按旧密码错误 401');

    /* ============ 4+5. 成功改密：全会话吊销 + 新旧密码登录 ============ */
    // 新密码与旧密码相同允许（不额外限制）——先演示一次，token 被踢后重新登录
    const snapBefore = userChangeSnapshots();
    r = await req('POST', '/api/auth/change-password', { oldPassword: 'pw12345678', newPassword: 'pw12345678' }, tokB);
    eq(r.status, 200, '4.1 新密码与旧密码相同也允许（200）');
    eq(r.json.ok, true, '4.2 成功应答 {ok:true}');
    r = await req('GET', '/api/auth/me', null, tokB);
    eq(r.status, 401, '4.3 ★ 改密后旧 token 立即 401（含当前会话被踢）');
    const tokB2 = (await req('POST', '/api/auth/login', { email: 'cpw-b@t.local', password: 'pw12345678' })).json.token;
    ok(!!tokB2, '4.4 改密后可用（同一）密码重新登录');

    r = await req('POST', '/api/auth/change-password', { oldPassword: 'pw12345678', newPassword: 'newpass999' }, tokB2);
    eq(r.status, 200, '5.1 正式改密成功');
    eq((await req('GET', '/api/auth/me', null, tokB2)).status, 401, '5.2 第二张旧 token 同样被吊销');
    const lgOld = await req('POST', '/api/auth/login', { email: 'cpw-b@t.local', password: 'pw12345678' });
    eq(lgOld.status, 401, '5.3 旧密码登录 → 401');
    const lgNew = await req('POST', '/api/auth/login', { email: 'cpw-b@t.local', password: 'newpass999' });
    eq(lgNew.status, 200, '5.4 ★ 新密码登录 → 200');
    ok(!!lgNew.json.token, '5.5 新密码登录拿到新令牌');
    eq(Number(userOnDisk('cpw-b@t.local').failCount) || 0, 0, '5.6 改密成功清零失败计数（lockout.reset）');

    /* ============ 6. 审计：有记录且不含秘密 ============ */
    const rawAudit = fs.readFileSync(path.join(WORK, 'audit.log'), 'utf8');
    const cpwLines = rawAudit.split('\n').filter((l) => l.indexOf('"user.change-password"') >= 0);
    eq(cpwLines.length, 2, '6.1 audit.log 含 2 条 user.change-password（4.1 与 5.1 各一）', cpwLines.length);
    const entry = JSON.parse(cpwLines[cpwLines.length - 1]);
    eq(entry.target, 'cpw-b@t.local', '6.2 审计 target 为账号邮箱');
    eq(entry.note, '自助修改密码，全部会话已吊销', '6.3 审计注明全部会话已吊销');
    const uB = userOnDisk('cpw-b@t.local');
    ok(rawAudit.indexOf('newpass999') < 0 && rawAudit.indexOf('pw12345678') < 0,
      '6.4 ★ 审计全文不含新旧密码明文');
    ok(rawAudit.indexOf(uB.hash) < 0 && rawAudit.indexOf(uB.salt) < 0,
      '6.5 ★ 审计全文不含密码哈希与 salt');

    /* ============ 7. 快照：改密前打了 users-change ============ */
    const snapAfter = userChangeSnapshots();
    ok(snapAfter.length > snapBefore.length, '7.1 ★ 改密前产生新的 users-change 快照',
      { before: snapBefore.length, after: snapAfter.length });

    /* ============ 8. 限速：每账号每分钟 8 次（与登录同常量） ============ */
    const tokC = await registerAndLogin('cpw-c@t.local', 'pw12345678');
    let last = null;
    for (let i = 0; i < 9; i++) {
      last = await req('POST', '/api/auth/change-password', { oldPassword: 'bad', newPassword: 'newpass999' }, tokC);
    }
    eq(last.status, 429, '8.1 ★ 超过每账号每分钟上限 → 429', last.status);
    eq(last.json.error, '操作过于频繁，请稍后再试', '8.2 429 文案');

    /* ============ 9. 未带/无效 token ============ */
    r = await req('POST', '/api/auth/change-password', { oldPassword: 'x', newPassword: 'newpass999' });
    eq(r.status, 401, '9.1 未登录改密 → 401');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n自助修改密码测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
