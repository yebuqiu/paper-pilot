#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 账号资料自助管理（E1 邮箱改绑 / E2 自助注销，服务端 1.9.4）
 *
 * 运行：node test/account-profile.test.js
 *
 * 覆盖：
 *   A. change-email：密码错 401+failCount、格式/同邮箱/冲突 400、成功不踢会话、
 *      旧邮箱登录失效新邮箱可登录、索引重挂、通知发旧邮箱、审计不含秘密
 *   B. delete-account：密码错 401 且账号不动、成功匿名化（deleted_<id>@deleted.local、
 *      salt/hash 空、令牌全废、余额三档清零、secrets 清空）、订单与流水保留、
 *      原邮箱可再注册、注销确认邮件、审计留痕、快照
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-profile-'));
let PORT = 0;
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;      // 邮件关闭 → 注册直接激活

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
function has(s, sub, label) { return ok(String(s).indexOf(sub) >= 0, label, { text: String(s).slice(0, 120) }); }

function req(method, p, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (extraHeaders) Object.assign(headers, extraHeaders);
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

function usersDoc() {
  return JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
}
function userOnDisk(email) {
  return usersDoc().users.find((x) => x.email === email);
}
function userById(id) {
  return usersDoc().users.find((x) => x.id === id);
}

async function registerAndLogin(email, password) {
  await req('POST', '/api/auth/register', { email, password });
  const lg = await req('POST', '/api/auth/login', { email, password });
  return lg.json && lg.json.token;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  // 桩 SMTP：PP_RESEND_BASE 指向本地 listen(0) 的 HTTP 桩，记录每一封来信
  const inbox = [];
  const mailStub = http.createServer((rq, rs) => {
    const cs = [];
    rq.on('data', (c) => cs.push(c));
    rq.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* ignore */ }
      inbox.push(body);
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end('{"id":"stub"}');
    });
  });
  await new Promise((r) => mailStub.listen(0, '127.0.0.1', r));
  // 注意：PP_RESEND_BASE/KEY 先不设置——注册全部账号后再启用，
  // 否则注册会要求邮箱验证（激活不了 → 登录 401），与 sessions.test.js R7 同纪律。
  const waitMails = async (n) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && inbox.length < n) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return inbox.length >= n;
  };

  try {
    // 先注册（此刻 PP_RESEND_KEY 未配置 → 直接激活，不卡邮箱验证）
    const tokA = await registerAndLogin('cem-a@t.local', 'pw12345678');
    const tokB = await registerAndLogin('cem-b@t.local', 'pw12345678');
    const tokC = await registerAndLogin('del-a@t.local', 'pw12345678');
    // 三个账号就绪后再启用桩 SMTP（后续改绑/注销通知都进 inbox）
    process.env.PP_RESEND_BASE = 'http://127.0.0.1:' + mailStub.address().port;
    process.env.PP_RESEND_KEY = 're_test_stub';

    /* ==================== A. 邮箱改绑 ==================== */
    const uidA = userOnDisk('cem-a@t.local').id;
    ok(!!tokA, 'A0 注册并登录成功');

    let r = await req('POST', '/api/auth/change-email', { password: 'wrong', newEmail: 'x@t.local' }, tokA);
    eq(r.status, 401, 'A1 密码错误 → 401');
    eq(r.json.error, '密码不正确', 'A2 401 文案');
    eq(userOnDisk('cem-a@t.local').failCount, 1, 'A3 ★ failCount +1（与登录共享计数）');

    r = await req('POST', '/api/auth/change-email', { password: 'pw12345678', newEmail: 'not-an-email' }, tokA);
    eq(r.status, 400, 'A4 新邮箱格式非法 → 400');
    r = await req('POST', '/api/auth/change-email', { password: 'pw12345678', newEmail: 'cem-a@t.local' }, tokA);
    eq(r.status, 400, 'A5 新旧邮箱相同 → 400');

    ok(!!tokB, 'A6 第二账号就绪（冲突靶子）');
    r = await req('POST', '/api/auth/change-email', { password: 'pw12345678', newEmail: 'cem-b@t.local' }, tokA);
    eq(r.status, 400, 'A7 新邮箱已被使用 → 400');
    eq(r.json.error, '该邮箱已被使用', 'A8 冲突文案');

    r = await req('POST', '/api/auth/change-email', { password: 'pw12345678', newEmail: 'cem-a2@t.local' }, tokA);
    eq(r.status, 200, 'A9 改绑成功 → 200');
    eq(r.json.email, 'cem-a2@t.local', 'A10 应答带新邮箱');
    ok(!userOnDisk('cem-a@t.local'), 'A11 ★ 旧邮箱已从索引摘除（findUserByEmail 不再命中）');
    eq(userById(uidA).email, 'cem-a2@t.local', 'A12 磁盘记录已改新邮箱');
    eq(Number(userById(uidA).failCount) || 0, 0, 'A13 改绑成功清零失败计数（lockout.reset）');

    r = await req('GET', '/api/auth/me', null, tokA);
    eq(r.status, 200, 'A14 ★ 改绑不踢会话：原 token 仍有效');
    eq(r.json.user.email, 'cem-a2@t.local', 'A15 /me 返回新邮箱');
    r = await req('POST', '/api/auth/login', { email: 'cem-a@t.local', password: 'pw12345678' });
    eq(r.status, 401, 'A16 旧邮箱登录 → 401');
    r = await req('POST', '/api/auth/login', { email: 'cem-a2@t.local', password: 'pw12345678' });
    eq(r.status, 200, 'A17 ★ 新邮箱可登录');

    eq(await waitMails(1), true, 'A18 ★ 改绑通知发出 1 封');
    const mailA = inbox[0] || {};
    eq(String(mailA.to), 'cem-a@t.local', 'A19 ★ 通知发到旧邮箱（原主人可感知）');
    eq(mailA.subject, '【Papilot】账号邮箱已改绑', 'A20 邮件主题正确');
    has(mailA.text || '', 'ce***@t.local', 'A21 正文含脱敏新邮箱');
    ok((mailA.text || '').indexOf('cem-a2@t.local') < 0, 'A22 ★ 正文不含完整新邮箱');
    has(mailA.text || '', '修改密码', 'A23 正文含「不是本人→修改密码」指引');

    /* ==================== B. 自助注销 ==================== */
    const uidC = userOnDisk('del-a@t.local').id;
    // 造一笔订单 + 有注册赠送流水，验证注销后财务留档仍在
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 1 }, tokC);
    eq(r.status, 200, 'B0 注销前造一笔 Pro 订单', r.json);
    const orderId = r.json && r.json.order && r.json.order.id;
    ok(!!orderId, 'B1 订单号到手');

    // 密码错误：账号纹丝不动
    r = await req('POST', '/api/auth/delete-account', { password: 'wrong' }, tokC);
    eq(r.status, 401, 'B2 注销密码错误 → 401');
    eq(userOnDisk('del-a@t.local').email, 'del-a@t.local', 'B3 密码错误后账号未匿名化');

    r = await req('POST', '/api/auth/delete-account', { password: 'pw12345678' }, tokC);
    eq(r.status, 200, 'B4 注销成功 → 200');
    const gone = userById(uidC);
    eq(gone.email, 'deleted_' + uidC + '@deleted.local', 'B5 ★ email 已匿名化为保留域名');
    eq(gone.nickname, '', 'B6 昵称已清空');
    ok(gone.salt === '' && gone.hash === '', 'B7 ★ salt/hash 置空（login 自然 401）');
    ok(!!gone.deletedAt, 'B8 记录 deletedAt 时间戳');
    eq(gone.balance.grantedMicro, 0, 'B9 赠送额度清零');
    eq(gone.balance.planMicro, 0, 'B10 订阅额度清零');
    eq(gone.balance.paidMicro, 0, 'B11 充值余额清零');
    ok(Array.isArray(gone.balance.ledger) && gone.balance.ledger.length > 0,
      'B12 ★ 余额流水保留（财务留档）');
    eq(Object.keys(gone.secrets || {}).length, 0, 'B13 托管密钥清空');
    ok(!userOnDisk('del-a@t.local'), 'B14 原邮箱已从索引摘除');

    r = await req('GET', '/api/auth/me', null, tokC);
    eq(r.status, 401, 'B15 ★ 注销后旧 token 立即 401');
    r = await req('POST', '/api/auth/login', { email: 'del-a@t.local', password: 'pw12345678' });
    eq(r.status, 401, 'B16 原邮箱+原密码登录 → 401（哈希已空）');

    const mdoc = JSON.parse(fs.readFileSync(path.join(WORK, 'membership.json'), 'utf8'));
    ok(mdoc.orders.some((o) => o.id === orderId && o.userId === uidC),
      'B17 ★ 订单保留（不删单，财务留档）');

    // 再注册前临时关掉邮件配置：否则会走「需邮箱验证」流程（登录 403 未激活）
    delete process.env.PP_RESEND_KEY;
    r = await req('POST', '/api/auth/register', { email: 'del-a@t.local', password: 'pw12345678' });
    eq(r.status, 200, 'B18 ★ 原邮箱可再注册（匿名行不撞唯一性）');
    r = await req('POST', '/api/auth/login', { email: 'del-a@t.local', password: 'pw12345678' });
    eq(r.status, 200, 'B19 再注册后可正常登录（是全新账号）');

    eq(await waitMails(2), true, 'B20 ★ 注销确认邮件发出');
    const mailB = inbox[1] || {};
    eq(String(mailB.to), 'del-a@t.local', 'B21 注销确认发到原邮箱');
    eq(mailB.subject, '【Papilot】账号已注销', 'B22 邮件主题正确');
    has(mailB.text || '', '不可恢复', 'B23 正文含余额清零不可恢复说明');

    /* ==================== C. 审计与快照 ==================== */
    const rawAudit = fs.readFileSync(path.join(WORK, 'audit.log'), 'utf8');
    eq(rawAudit.split('\n').filter((l) => l.indexOf('"user.change-email"') >= 0).length, 1,
      'C1 audit.log 恰 1 条 user.change-email');
    eq(rawAudit.split('\n').filter((l) => l.indexOf('"user.delete-account"') >= 0).length, 1,
      'C2 audit.log 恰 1 条 user.delete-account');
    ok(rawAudit.indexOf('pw12345678') < 0, 'C3 ★ 审计全文不含密码明文');
    const uC = userById(uidC);
    has(rawAudit, 'de***@t.local', 'C4 审计含脱敏原邮箱（不留完整邮箱）');
    ok((!uC.hash || rawAudit.indexOf(uC.hash) < 0) && (!uC.salt || rawAudit.indexOf(uC.salt) < 0),
      'C5 审计不含哈希/salt');
    const backups = fs.readdirSync(path.join(WORK, 'backup')).filter((n) => n.indexOf('users-change') >= 0);
    ok(backups.length >= 1, 'C6 已产生 users-change 快照（同节流窗口内第二次跳过属设计）', backups.length);

    /* ==================== D. 未带 token ==================== */
    r = await req('POST', '/api/auth/change-email', { password: 'x', newEmail: 'y@t.local' });
    eq(r.status, 401, 'D1 未登录改绑 → 401');
    r = await req('POST', '/api/auth/delete-account', { password: 'x' });
    eq(r.status, 401, 'D2 未登录注销 → 401');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  }

  try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
  try { delete process.env.PP_RESEND_BASE; delete process.env.PP_RESEND_KEY; } catch (e) { /* ignore */ }
  mailStub.close();
  server.close();
  console.log('account-profile: ' + pass + ' 过 / ' + fails.length + ' 败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})();
