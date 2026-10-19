#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 数据文件损坏 → 维护模式（服务端 1.8.5，审查 P0-4）
 *
 * 历史行为：membership.json 解析失败 → 内存回退默认文档 → 启动路径无条件 save()
 * → 空订单/空套餐/默认价覆盖正式文件，服务照常接单，数据永久丢。
 *
 * 本套件锁定修复后的契约：
 *   ① 损坏文件**原样保留**（字节不变），并生成 .corrupt-* 副本；
 *   ② store.loadFailed / degradation() 能报出是哪个文件、副本叫什么；
 *   ③ /api/health 仍可访问且 degraded=true（运维要能看到原因）；
 *   ④ 其余接口（注册/下单/管理）一律 503 + code=DEGRADED，不写任何文件。
 *
 * 运行：node test/store-corrupt.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-corrupt-'));
const MEMBERSHIP = path.join(WORK, 'membership.json');
const BROKEN = '{"plans": {"Free": {"id": "Free"';   // 截断的 JSON
fs.writeFileSync(MEMBERSHIP, BROKEN, 'utf8');
const BEFORE = fs.readFileSync(MEMBERSHIP);

process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
delete process.env.PP_ALERT_EMAIL;

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

let PORT = 0;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Host: '127.0.0.1:' + PORT };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function run() {
  // ① 加载后：标记 + 原文件不动 + 副本存在
  eq(mod.membershipStore.loadFailed, true, '损坏文件被标记 loadFailed');
  const after = fs.readFileSync(MEMBERSHIP);
  ok(Buffer.compare(BEFORE, after) === 0, '★ 原文件未被默认值覆盖（字节完全一致）');
  const baks = fs.readdirSync(WORK).filter((f) => f.indexOf('membership.json.corrupt-') === 0);
  ok(baks.length === 1, '生成了 .corrupt-* 副本', baks);
  const deg = mod.degradation();
  ok(deg.some((d) => d.store === 'membership'), 'degradation() 报出 membership', deg);

  // ② save() 被硬闸门拦住
  let threw = '';
  try { mod.membershipStore.save(); } catch (e) { threw = e.message; }
  ok(/拒绝写入/.test(threw), 'loadFailed 时 save() 直接抛错（最后一道闸门）', threw);

  // ③ health 可看、写接口 503
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  PORT = server.address().port;

  let r = await req('GET', '/api/health');
  eq(r.status, 200, '维护模式下 /api/health 仍可访问');
  eq(r.json && r.json.degraded, true, 'health.degraded=true');
  ok(r.json && Array.isArray(r.json.degradedStores) && r.json.degradedStores[0].store === 'membership',
    'health 报出具体损坏的 store', r.json && r.json.degradedStores);

  r = await req('POST', '/api/auth/register', { email: 'x@example.com', password: '12345678' });
  eq(r.status, 503, '★ 维护模式下注册被拒（503）');
  eq(r.json && r.json.code, 'DEGRADED', '503 带 code=DEGRADED');

  r = await req('GET', '/api/admin/users');
  eq(r.status, 503, '★ 维护模式下管理写面也被拒（避免空库落盘）');

  r = await req('GET', '/plans-x');   // 未定义路由
  eq(r.status, 503, '维护模式对未知路由同样 503（不泄露路由表）');

  // ④ 文件始终没被改写
  const finalBytes = fs.readFileSync(MEMBERSHIP);
  ok(Buffer.compare(BEFORE, finalBytes) === 0, '★ 全流程结束后原文件仍未被覆盖');
}

run().catch((e) => {
  fails.push('用例异常：' + (e && e.stack || e));
}).then(() => {
  try { server.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (fails.length) {
    console.error('\n损坏文件维护模式测试失败 ' + fails.length + ' 项（通过 ' + pass + '）：');
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('损坏文件维护模式测试通过：' + pass + ' 项');
});
