#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 资金履约原子性 / 幂等测试（服务端 1.8.5，审查 P0-3）
 *
 * 缺陷回顾：履约同时改两个文件（订单状态在 membership.json，余额/会员在 users.json），
 * 旧写序是「先订单后余额」。两次写之间进程退出 → 订单显示已履约、余额没到账，且重试
 * 被 `status=fulfilled → already:true` 直接挡住，永远不会补账。
 *
 * 修复后的契约（本套件锁定）：
 *   ① 写序 = 先 users.json（入账/开通），再 membership.json（置状态）；
 *   ② 用「流水 refId / 会员历史 refId」判重：崩溃后重试只补状态，不重复加钱/叠加时长；
 *   ③ 激活码兑换同理（会员已到账、码未落盘 → 重试只补 usedAt）。
 *
 * 运行：node test/pay-atomic.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-atomic-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
delete process.env.PP_ALERT_EMAIL;

const SERVER = path.join(__dirname, '..', 'server', 'account-server.js');
const mod = require(SERVER);

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function mkUser(email) {
  const user = {
    id: 'u-' + Math.random().toString(16).slice(2, 10),
    email, nickname: email.split('@')[0],
    salt: 'x', hash: 'x', plan: 'Free', expiresAt: null,
    createdAt: new Date().toISOString(), usage: { date: mod.today(), count: 0 },
  };
  mod.usersStore.data.users.push(user);
  return user;
}
const findUser = (id) => mod.usersStore.data.users.find((u) => u.id === id);
const paidOf = (id) => Number((findUser(id).balance || {}).paidMicro) || 0;

function creditOrder(user, micro) {
  const r = mod.membershipStore.data && require(path.join(__dirname, '..', 'server', 'lib', 'membership.js'))
    .createCreditOrder(mod.membershipStore.data, {
      user, cents: 1000, creditMicro: micro, bonusMicro: 0, label: '测试充值',
    });
  if (r.error) throw new Error('createCreditOrder: ' + r.error);
  return r.order;
}

/* ① 充值单：模拟「只写成功 users.json，membership.json 未写就崩溃」 */
const u1 = mkUser('atomic1@example.com');
mod.membershipStore.save();
mod.usersStore.save();

const o1 = creditOrder(u1, 5000000);
mod.membershipStore.save();

const r1 = mod.applyOrderFulfill(o1, 'test');
ok(r1.ok, '首次履约成功', r1.error);
eq(paidOf(u1.id), 5000000, '首次履约后余额 +5000000 微元');

// 崩溃模拟：只落盘 users（入账），不落盘 membership（订单仍 pending）
mod.usersStore.save();

mod.reloadStores();                       // 相当于进程重启后从磁盘重载
const u1b = findUser(u1.id);
eq(paidOf(u1.id), 5000000, '重启后余额仍在（第一笔写已落盘）');
const o1b = mod.membershipStore.data.orders.find((o) => o.id === o1.id);
eq(o1b.status, 'pending', '★ 订单在磁盘上仍为 pending（模拟两次写之间崩溃）');

const r2 = mod.applyOrderFulfill(o1b, 'test-retry');
ok(r2.ok, '重试履约成功（可收敛）', r2.error);
eq(r2.already, true, '★ 重试命中 refId 幂等，不重复入账');
eq(paidOf(u1.id), 5000000, '★ 重试后余额没有翻倍');

mod.usersStore.save();
mod.membershipStore.save();
mod.reloadStores();
eq(mod.membershipStore.data.orders.find((o) => o.id === o1.id).status, 'fulfilled', '重试后订单状态补齐为 fulfilled');
eq(paidOf(u1.id), 5000000, '最终余额正确（恰好一次）');

/* ② 会员单：重复履约不叠加时长 */
const u2 = mkUser('atomic2@example.com');
mod.usersStore.save();
const mb = require(path.join(__dirname, '..', 'server', 'lib', 'membership.js'));
const created = mb.createOrder(mod.membershipStore.data, { user: u2, plan: 'Pro', months: 1 });
if (created.error) throw new Error('createOrder: ' + created.error);
mod.membershipStore.save();

const g1 = mod.applyOrderFulfill(created.order, 'test');
ok(g1.ok, '会员单首次开通成功', g1.error);
const exp1 = Date.parse(findUser(u2.id).membership.expiresAt);
ok(exp1 > Date.now(), '会员到期时间已写入');

mod.usersStore.save();                    // 崩溃点：订单状态未落盘
mod.reloadStores();
const order2 = mod.membershipStore.data.orders.find((o) => o.id === created.order.id);
eq(order2.status, 'pending', '★ 会员单在磁盘上仍 pending');
const g2 = mod.applyOrderFulfill(order2, 'test-retry');
eq(g2.already, true, '★ 会员单重试命中 history.refId，不重复叠加');
const exp2 = Date.parse(findUser(u2.id).membership.expiresAt);
eq(exp2, exp1, '★ 到期时间没有被叠加成 2 个月');
mod.usersStore.save();
mod.membershipStore.save();

/* ③ 激活码：会员已到账、码未落盘 → 重试只补 usedAt，不重复叠加 */
const u3 = mkUser('atomic3@example.com');
mod.usersStore.save();
const codes = mb.createCodes(mod.membershipStore.data, {
  plan: 'Pro', months: 1, count: 1, note: '原子性测试', by: 'test',
});
const codeVal = codes.codes[0].code;
mod.membershipStore.save();

const rd1 = mb.redeem(mod.membershipStore.data, codeVal, u3);
ok(!rd1.error, '激活码首次兑换成功', rd1.error);
const u3exp = Date.parse(findUser(u3.id).membership.expiresAt);
mod.usersStore.save();                    // 崩溃点：码状态未落盘
mod.reloadStores();

const u3b = findUser(u3.id);
const rec = mb.findCode(mod.membershipStore.data, codeVal);
ok(!rec.usedAt, '★ 码在磁盘上仍未标记已用（模拟崩溃）', rec.usedAt);
const rd2 = mb.redeem(mod.membershipStore.data, codeVal, u3b);
ok(!rd2.error, '★ 重试兑换返回成功（幂等收敛）', rd2.error);
eq(rd2.already, true, '重试命中 hasGrantRef 幂等分支');
eq(Date.parse(findUser(u3.id).membership.expiresAt), u3exp, '★ 会员时长没有被重复叠加');
ok(!!mb.findCode(mod.membershipStore.data, codeVal).usedAt, '重试后码状态已补标记');

/* ④ 正常兑换仍然拒绝二次使用（幂等不能把「别人已用」也放行） */
const other = mkUser('atomic4@example.com');
const rd3 = mb.redeem(mod.membershipStore.data, codeVal, other);
ok(!!rd3.error, '其他账号再兑换同一码仍被拒（usedAt 生效）', rd3.error);

try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
if (fails.length) {
  console.error('\n资金履约原子性测试失败 ' + fails.length + ' 项（通过 ' + pass + '）：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('资金履约原子性测试通过：' + pass + ' 项');
