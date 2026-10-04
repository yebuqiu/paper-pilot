#!/usr/bin/env node
/* 余额域测试（服务端 1.6.0）
 *
 * 运行：node test/balance.test.js
 *
 * 覆盖：
 *   A 纯函数 —— 注册赠送 / 消耗顺序（先赠送后充值）/ 高级模型只扣充值 /
 *              透支如实记账 / 赠送过期惰性清零 / 管理端调账 / precheck 双模式
 *   B 集成   —— 注册即送 ¥6（/api/auth/me 可见）；网关按真实成本扣余额；
 *              观察模式（enforce=false）余额为 0 也放行；开启 enforce 后 402 拦截
 *              + 充值恢复；高级模型只有赠送额度时被拦；管理端调账 + 审计
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-balance-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

let UPSTREAM_PORT = 0;
const USAGE = { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 };

/** 假 OpenAI 兼容上游：模型名带 "pro" 视为高级模型名，只影响返回的 model 字段 */
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* ignore */ }
    const asked = String(body.model || '');
    const real = (asked === 'auto') ? 'base-model' : asked;
    const out = { id: 'c1', object: 'chat.completion', model: real,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: USAGE };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

let mod = null;
let PORT = 0;

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
const yuan = (n) => Math.round(n * 1e6);   // 元 → 微元

(async () => {
  try {
    /* ================= A. 纯函数 ================= */
    const bal = require(path.join(__dirname, '..', 'server', 'lib', 'balance.js'));

    eq(bal.newCfg().signupGrantMicro, yuan(6), 'A1 默认注册赠送 ¥6');
    eq(bal.newCfg().signupValidDays, 30, 'A2 默认赠送有效期 30 天');
    eq(bal.newCfg().enforce, false, 'A3 默认观察模式（不拦截）');

    const cfg = bal.newCfg();
    const u = {};
    const g1 = bal.grantSignup(u, cfg, Date.now());
    eq(g1.granted, yuan(6), 'A4 发放注册赠送 ¥6');
    ok(g1.expiresAt && Date.parse(g1.expiresAt) > Date.now(), 'A5 赠带有到期时间');
    const g2 = bal.grantSignup(u, cfg, Date.now());
    ok(g2.skipped, 'A6 重复发放幂等跳过');
    eq(bal.grantSignup({}, { signupGrantMicro: 0 }, Date.now()).skipped, true, 'A7 配置为 0 → 不发放');

    // 消耗顺序：先赠送后充值（赠送够用时不动充值）
    bal.adminAdjust(u, { micro: yuan(2), kind: 'recharge', reason: '充值' }, Date.now());
    eq(u.balance.paidMicro, yuan(2), 'A8 充值进入 paidMicro');
    const c1 = bal.consume(u, yuan(3), { reason: 't' }, Date.now());
    eq(c1.fromGranted, yuan(3), 'A9 先扣赠送 3 元');
    eq(c1.fromPaid, 0, 'A10 赠送够用时不动充值');
    eq(u.balance.grantedMicro, yuan(3), 'A11 赠送剩余 3 元');
    eq(u.balance.paidMicro, yuan(2), 'A12 充值未动（仍 2 元）');

    // ★ 高级模型只扣充值（用户决策：赠送限基础模型）
    bal.adminAdjust(u, { micro: yuan(5), kind: 'recharge', reason: '再充' }, Date.now());
    const c2 = bal.consume(u, yuan(2), { highTier: true, reason: 'pro' }, Date.now());
    eq(c2.fromGranted, 0, 'A13 ★ 高级模型不吃赠送额度');
    eq(c2.fromPaid, yuan(2), 'A14 高级模型只扣充值');
    eq(u.balance.grantedMicro, yuan(3), 'A15 赠送额度未被高级模型动过');

    // ★ 透支如实记账（pre-check 与扣减之间的并发窗口）
    const before = u.balance.paidMicro;
    const c3 = bal.consume(u, before + yuan(1), { highTier: true }, Date.now());
    eq(c3.overdraft, yuan(1), 'A16 ★ 余额不足时透支如实入账（不冒充 0）');
    ok(u.balance.paidMicro < 0, 'A17 充值余额可为负（下次 pre-check 拦截）');
    ok(bal.viewOf(u.balance).paidText.indexOf('-¥') === 0, 'A18 负余额文案带负号（不是 ¥0）');

    // ★ 赠送过期：惰性清零 + 留流水 + 不追回已消耗部分
    const u2 = {};
    bal.grantSignup(u2, cfg, Date.now() - 40 * 86400e3);   // 发放在 40 天前（已过 30 天有效期）
    const v2 = bal.userView(u2, cfg, Date.now());
    eq(v2.grantedAvailableMicro, 0, 'A19 过期赠送不可用');
    const sweeped = bal.sweep(u2.balance, Date.now());
    eq(sweeped.grantedMicro, 0, 'A20 惰性清零过期的赠送额度');
    ok(u2.balance.ledger.some((e) => e.kind === 'grant-expire'), 'A21 过期回收留了流水');
    eq(bal.consume(u2, yuan(1), {}, Date.now()).fromGranted, 0, 'A22 过期后消耗不再走赠送');

    // ★ 充值余额永不过期（铁律：钱不过期，赠品才过期）
    const u3 = {};
    bal.grantSignup(u3, cfg, Date.now() - 40 * 86400e3);
    bal.adminAdjust(u3, { micro: yuan(1), kind: 'recharge' }, Date.now() - 40 * 86400e3);
    const v3 = bal.userView(u3, cfg, Date.now());
    eq(v3.paidMicro, yuan(1), 'A23 ★ 充值余额不受时间影响（永不过期）');
    eq(v3.totalMicro, yuan(1), 'A24 总额 = 充值部分');

    // adminAdjust 边界
    ok(!!bal.adminAdjust({ balance: { paidMicro: yuan(1) } }, { micro: -yuan(5) }).error,
      'A25 扣减超出余额被拒（管理端不制造透支）');
    ok(!!bal.adminAdjust({}, { micro: 0 }).error, 'A26 零变动被拒');
    const u4 = {};
    bal.adminAdjust(u4, { micro: yuan(1), kind: 'recharge', reason: 'r' }, Date.now());
    bal.adminAdjust(u4, { micro: -yuan(1), kind: 'adjust', reason: '退款' }, Date.now());
    eq(u4.balance.paidMicro, 0, 'A27 正负调账相互抵消');

    // 流水上限
    const u5 = {};
    for (let i = 0; i < 60; i++) bal.adminAdjust(u5, { micro: 1, reason: 'x' + i }, Date.now());
    eq(u5.balance.ledger.length, bal.LEDGER_KEEP, 'A28 流水只留最近 ' + bal.LEDGER_KEEP + ' 条');

    // precheck 双模式
    const cfgEnf = Object.assign(bal.newCfg(), { enforce: true, minBalanceMicro: yuan(1) });
    const u6 = {};
    eq(bal.precheck(u6, cfg, {}, Date.now()).allowed, true, 'A29 观察模式恒放行（余额 0）');
    eq(bal.precheck(u6, cfg, { highTier: true }, Date.now()).allowed, true,
      'A29b ★ 观察模式下高级模型也放行（只记账不拦——曾因漏判 enforce 把观察模式变成拦截）');
    eq(bal.precheck(u6, cfgEnf, {}, Date.now()).allowed, false, 'A30 enforce 开启后余额不足被拦');
    const pc = bal.precheck(u6, cfgEnf, {}, Date.now());
    eq(pc.code, 'INSUFFICIENT_BALANCE', 'A31 拦截返回可编程识别的 code');
    ok(/充值/.test(pc.error) && /自己的模型通道/.test(pc.error), 'A32 拦截文案给充值与自有 Key 两条出路');
    // ★ 高级模型 + 只有赠送额度 → 拦（铁律三在 precheck 侧的体现）
    bal.grantSignup(u6, cfg, Date.now());
    eq(bal.precheck(u6, cfgEnf, {}, Date.now()).allowed, true, 'A33 基础模型：赠送额度计入阈值判定（6 元 ≥ 1 元）');
    const cfgEnf0 = Object.assign(bal.newCfg(), { enforce: true });
    eq(bal.precheck(u6, cfgEnf0, {}, Date.now()).allowed, true, 'A34 基础模型：有赠送且阈值为 0 → 放行');
    eq(bal.precheck(u6, cfgEnf0, { highTier: true }, Date.now()).allowed, false,
      'A35 ★ 高级模型只有赠送额度 → 拦（赠送限基础模型）');
    eq(bal.precheck(u6, cfgEnf0, { highTier: true }, Date.now()).code, 'BALANCE_REQUIRED_FOR_HIGH_TIER',
      'A36 高级模型拦截有独立 code');

    /* ================= B. 集成（假上游） ================= */

    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    UPSTREAM_PORT = upstream.address().port;
    fs.writeFileSync(path.join(WORK, 'channels.json'), JSON.stringify({
      channels: [{
        id: 'fake', name: 'fake', provider: 'custom',
        baseUrl: 'http://127.0.0.1:' + UPSTREAM_PORT + '/v1',
        apiKey: 'sk-fake', model: 'base-model',
        models: ['auto', 'base-model', 'pro-model'],
      }],
      active: 'fake',
      highTierModels: ['pro-model'],
    }, null, 2), 'utf8');

    mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
    const { server } = mod;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    PORT = server.address().port;

    // 配价：base-model 输入输出各 0.01 元/千 token → 每次 200 token 成本 2 微元... 算一下：
    // (100*0.01 + 100*0.01) * 1000 = 2000 微元 = ¥0.002
    let r = await req('PUT', '/api/admin/pricing', {
      set: { 'base-model': { inPer1k: 0.01, outPer1k: 0.01 }, 'pro-model': { inPer1k: 0.01, outPer1k: 0.01 } },
    });
    eq(r.status, 200, 'B1 配价成功');

    await req('POST', '/api/auth/register', { email: 'bal@test.local', password: 'pw12345678' });
    const tok = (await req('POST', '/api/auth/login', { email: 'bal@test.local', password: 'pw12345678' })).json.token;
    ok(!!tok, 'B2 注册并登录');

    // 注册即送
    let me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    ok(!!me.balance, 'B3 /api/auth/me 下发 balance');
    eq(me.balance.totalMicro, yuan(6), 'B4 注册赠送 ¥6 到账');
    eq(me.balance.grantedDaysLeft, 30, 'B5 赠送有效期 30 天');
    eq(me.balance.enforce, false, 'B6 客户端可见观察模式状态');

    // 观察模式下调用：按真实成本扣
    await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok);
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.totalMicro, yuan(6) - 2000, 'B7 ★ 网关按真实成本扣减（¥0.002）');
    eq(me.balance.grantedMicro, yuan(6) - 2000, 'B8 先扣赠送额度');

    // ★ 高级模型消耗只走充值（此时充值为 0 → 透支如实记录）
    // （先给账号升 Pro：Free 会被 1.4.9 套餐模型门在更早处拦下，走不到计费）
    const uid0 = userOnDisk('bal@test.local').id;
    await req('POST', '/api/admin/users/' + uid0 + '/membership', { plan: 'Pro', months: 1 });
    await req('POST', '/v1/chat/completions', { model: 'pro-model', messages: [] }, tok);
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.grantedMicro, yuan(6) - 2000, 'B9 ★ 高级模型没有动赠送额度');
    eq(me.balance.paidMicro, -2000, 'B10 充值为 0 时高级模型消耗如实透支');

    // 观察模式：余额为负仍放行（只记账）
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok);
    eq(r.status, 200, 'B11 ★ 观察模式余额为负也放行（先观察后拦截）');

    // 管理员充值 ¥10（有符号微元）
    const uid = userOnDisk('bal@test.local').id;
    r = await req('POST', '/api/admin/users/' + uid + '/balance', { micro: yuan(10), kind: 'recharge', reason: '人工充值' });
    eq(r.status, 200, 'B12 管理员充值成功');
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.paidMicro, yuan(10) - 2000, 'B13 充值抵消透支后剩余正确');

    // 开启 enforce：把余额调到阈值以下再调用
    r = await req('PUT', '/api/admin/pricing', { balance: { enforce: true, minBalanceMicro: yuan(1) } });
    eq(r.status, 200, 'B14 开启 enforce 成功');
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok);
    eq(me.balance.totalMicro >= yuan(1), true, 'B15 当前余额高于阈值（前置条件）');
    // 调到阈值以下
    await req('POST', '/api/admin/users/' + uid + '/balance',
      { micro: -(me.balance.totalMicro - yuan(0.5)), kind: 'adjust', reason: '压到阈值下' });
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok);
    eq(r.status, 402, 'B16 ★ enforce 开启后低于阈值 → 402');
    eq(r.json.code, 'INSUFFICIENT_BALANCE', 'B17 402 带可编程 code');
    ok(/充值/.test(r.json.error || ''), 'B18 拦截文案引导充值');
    ok(!!r.json.balance, 'B19 402 应答同时带回余额视图（客户端可直接展示）');

    // ★ 高级模型 + 余额全在赠送侧 → 402 且 code 不同（先升 Pro，否则过不了套餐模型门）
    await req('POST', '/api/auth/register', { email: 'bal2@test.local', password: 'pw12345678' });
    const tok2 = (await req('POST', '/api/auth/login', { email: 'bal2@test.local', password: 'pw12345678' })).json.token;
    const uid2 = userOnDisk('bal2@test.local').id;
    await req('POST', '/api/admin/users/' + uid2 + '/membership', { plan: 'Pro', months: 1 });
    r = await req('POST', '/v1/chat/completions', { model: 'pro-model', messages: [] }, tok2);
    eq(r.status, 402, 'B20 ★ 只有赠送额度时高级模型被拦');
    eq(r.json.code, 'BALANCE_REQUIRED_FOR_HIGH_TIER', 'B21 高级模型拦截 code 正确');
    // 同一账号基础模型放行（赠送额度高于阈值）
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok2);
    eq(r.status, 200, 'B22 同一账号基础模型照常使用（赠送计入基础模型阈值）');

    // 管理端视图带流水 + 审计
    const adm = (await req('GET', '/api/admin/users')).json.users.find((x) => x.email === 'bal@test.local');
    ok(!!(adm.balance && Array.isArray(adm.balance.ledger) && adm.balance.ledger.length),
      'B23 管理端用户视图带余额流水');
    const audit = (await req('GET', '/api/admin/audit?limit=50')).json;
    ok((audit.items || []).some((e) => e.action === 'balance.adjust'),
      'B24 充值/调账写入审计（balance.adjust）');

    // health
    const h = (await req('GET', '/api/health')).json;
    eq(h.version, '1.6.0', 'B25 服务端版本 1.6.0');
    eq(h.balanceEnforce, true, 'B26 health 暴露 enforce 状态');
    eq(h.signupGrantMicro, yuan(6), 'B27 health 暴露注册赠送额度');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { if (mod) mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    try { if (mod) mod.server.close(); } catch (e) { /* ignore */ }
    try { upstream.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n余额域测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
