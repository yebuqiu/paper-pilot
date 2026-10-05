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

    /* ---- 1.6.0 订阅额度（每月发放 / 不结转 / 可用于高级模型）---- */
    const u7 = {};
    bal.grantPlan(u7, { micro: yuan(20), periodKey: '2026-10', expiresAt: new Date(Date.now() + 86400e3).toISOString() }, Date.now());
    eq(u7.balance.planMicro, yuan(20), 'A37 订阅额度发放到账');
    eq(bal.viewOf(u7.balance).planText, '¥20.00', 'A38 订阅额度有独立文案');
    // ★ 不结转：再次发放是**覆盖**而不是累加
    bal.grantPlan(u7, { micro: yuan(20), periodKey: '2026-11', expiresAt: new Date(Date.now() + 86400e3).toISOString() }, Date.now());
    eq(u7.balance.planMicro, yuan(20), 'A39 ★ 不结转：换期覆盖而非累加');
    eq(u7.balance.planPeriodKey, '2026-11', 'A40 期号更新');
    ok(u7.balance.ledger.filter((e) => e.kind === 'plan-grant').length === 2, 'A41 每次发放都留流水');

    // 订阅额度过期 → 惰性回收（不结转的落点）
    const u8 = {};
    bal.grantPlan(u8, { micro: yuan(20), periodKey: '2026-01', expiresAt: new Date(Date.now() - 1000).toISOString() }, Date.now());
    eq(bal.planAvailable(u8.balance, Date.now()), 0, 'A42 过期订阅额度不可用');
    bal.sweep(u8.balance, Date.now());
    eq(u8.balance.planMicro, 0, 'A43 过期订阅额度被惰性清零');
    ok(u8.balance.ledger.some((e) => e.kind === 'plan-expire'), 'A44 订阅额度回收留流水');

    // ★ 消耗顺序：注册赠送 → 订阅额度 → 充值（越保值的越晚扣）
    const u9 = {};
    bal.grantSignup(u9, cfg, Date.now());
    bal.grantPlan(u9, { micro: yuan(20), periodKey: 'p', expiresAt: new Date(Date.now() + 86400e3).toISOString() }, Date.now());
    bal.adminAdjust(u9, { micro: yuan(50), kind: 'recharge' }, Date.now());
    const c9 = bal.consume(u9, yuan(10), {}, Date.now());
    eq(c9.fromGranted, yuan(6), 'A45 先扣注册赠送（6 元）');
    eq(c9.fromPlan, yuan(4), 'A46 再扣订阅额度（4 元）');
    eq(c9.fromPaid, 0, 'A47 充值未动');
    eq(u9.balance.planMicro, yuan(16), 'A48 订阅额度剩 16 元');
    eq(u9.balance.paidMicro, yuan(50), 'A49 充值仍 50 元');

    // ★ 高级模型：跳过注册赠送，但从**订阅额度**起扣（订阅就是为高级模型付的钱）
    const c10 = bal.consume(u9, yuan(3), { highTier: true }, Date.now());
    eq(c10.fromGranted, 0, 'A50 高级模型仍不吃注册赠送');
    eq(c10.fromPlan, yuan(3), 'A51 ★ 高级模型可用订阅额度');
    eq(bal.precheck(u9, Object.assign(bal.newCfg(), { enforce: true }), { highTier: true }, Date.now()).allowed,
      true, 'A52 有订阅额度时高级模型放行');
    // 订阅额度花光且无充值时 → 高级模型被拦
    bal.consume(u9, yuan(13), { highTier: true }, Date.now());
    bal.consume(u9, yuan(50), {}, Date.now());
    eq(bal.precheck(u9, Object.assign(bal.newCfg(), { enforce: true }), { highTier: true }, Date.now()).allowed,
      false, 'A53 订阅额度与充值都用尽 → 高级模型被拦');

    // 充值到账（订单核销副作用）
    const u10 = {};
    const top = bal.creditTopUp(u10, yuan(33), { orderId: 'o-1', reason: '充值订单' }, Date.now());
    eq(u10.balance.paidMicro, yuan(33), 'A54 充值到账进 paidMicro');
    ok(!top.error, 'A55 充值到账成功');
    ok(u10.balance.ledger.some((e) => e.kind === 'recharge' && e.refId === 'o-1'), 'A56 充值流水带订单号');
    eq(bal.creditTopUp(u10, 0).error !== undefined, true, 'A57 零额度充值被拒');

    // 充值档位消毒
    const opts = bal.sanitizeRechargeOptions([
      { id: 'a', cents: 1000, creditCents: 1000 },
      { id: 'a', cents: 2000, creditCents: 2000 },           // 重复 id → 丢弃
      { id: 'b', cents: 3000, creditCents: 2000 },           // 到账 < 付款 → 丢弃
      { id: 'c', cents: 0, creditCents: 0 },                 // 金额 0 → 丢弃
      { id: 'd', cents: 1000, creditCents: 1200, enabled: false },
    ]);
    eq(opts.length, 2, 'A58 充值档位消毒：重复 id / 到账少于付款 / 零金额都被剔除');
    eq(opts[1].id, 'd', 'A59 保留合法档位（含被停用的）');
    eq(bal.rechargeOptionOf({ rechargeOptions: opts }, 'd'), null, 'A60 停用档位不可下单');
    ok(!!bal.rechargeOptionOf({ rechargeOptions: opts }, 'a'), 'A61 启用档位可下单');

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

    // ★ 高级模型消耗：跳过注册赠送，从**订阅额度**（Pro 每月发放）扣
    // （先给账号升 Pro：Free 会被 1.4.9 套餐模型门在更早处拦下，走不到计费）
    const uid0 = userOnDisk('bal@test.local').id;
    await req('POST', '/api/admin/users/' + uid0 + '/membership', { plan: 'Pro', months: 1 });
    await req('POST', '/v1/chat/completions', { model: 'pro-model', messages: [] }, tok);
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.grantedMicro, yuan(6) - 2000, 'B9 ★ 高级模型没有动注册赠送额度');
    ok(me.balance.planMicro > 0, 'B9b ★ Pro 已按期发放订阅额度');
    eq(me.balance.planMicro, yuan(20) - 2000, 'B10 高级模型从订阅额度扣（¥20 − ¥0.002）');
    eq(me.balance.paidMicro, 0, 'B10b 充值为 0 未被透支（订阅额度先顶上）');
    eq(me.balance.planPeriodKey, mod.today().slice(0, 7), 'B10c 订阅额度期号 = 当前自然月');
    const planExp = Date.parse(me.balance.planExpiresAt);
    ok(planExp > Date.now() && planExp - Date.now() <= 32 * 86400e3, 'B10d 订阅额度在下月 1 日作废', me.balance.planExpiresAt);

    // 观察模式：余额为负仍放行（只记账）
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok);
    eq(r.status, 200, 'B11 ★ 观察模式余额为负也放行（先观察后拦截）');

    // 管理员充值 ¥10（有符号微元）
    const uid = userOnDisk('bal@test.local').id;
    r = await req('POST', '/api/admin/users/' + uid + '/balance', { micro: yuan(10), kind: 'recharge', reason: '人工充值' });
    eq(r.status, 200, 'B12 管理员充值成功');
    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.paidMicro, yuan(10), 'B13 充值全额进 paidMicro（无透支需要抵消）');

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

    // ★ 高级模型 + 只有注册赠送额度 → 402 且 code 不同
    //   把 Pro 的每月额度临时设为 0，构造「Pro 但无订阅额度、无充值」的场景
    await req('PUT', '/api/admin/membership', { plans: { Pro: { monthlyGrantMicro: 0 } } });
    await req('POST', '/api/auth/register', { email: 'bal2@test.local', password: 'pw12345678' });
    const tok2 = (await req('POST', '/api/auth/login', { email: 'bal2@test.local', password: 'pw12345678' })).json.token;
    const uid2 = userOnDisk('bal2@test.local').id;
    await req('POST', '/api/admin/users/' + uid2 + '/membership', { plan: 'Pro', months: 1 });
    r = await req('POST', '/v1/chat/completions', { model: 'pro-model', messages: [] }, tok2);
    eq(r.status, 402, 'B20 ★ 无订阅额度/充值时高级模型被拦（注册赠送不算数）');
    eq(r.json.code, 'BALANCE_REQUIRED_FOR_HIGH_TIER', 'B21 高级模型拦截 code 正确');
    // 同一账号基础模型放行（注册赠送计入基础模型阈值）
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok2);
    eq(r.status, 200, 'B22 同一账号基础模型照常使用（注册赠送可用）');
    // 恢复 Pro 的每月订阅额度
    await req('PUT', '/api/admin/membership', { plans: { Pro: { monthlyGrantMicro: yuan(20) } } });

    /* ---- 1.6.0 充值订单端到端：下单 → 标记已付 → 核销 → 自动入账 ---- */
    const beforePay = (await req('GET', '/api/auth/me', null, tok2)).json.user.balance.paidMicro;
    const co = await req('POST', '/api/orders', { kind: 'credit', optionId: 'rc30' }, tok2);
    eq(co.status, 200, 'B23 充值订单创建成功');
    eq(co.json.order.kind, 'credit', 'B24 订单类型 = credit');
    eq(co.json.order.creditMicro, yuan(33), 'B25 到账额度含赠送（付 ¥30 到账 ¥33）');
    eq(co.json.order.bonusMicro, yuan(3), 'B26 赠送额单独记录');
    ok(co.json.order.tailCents >= 1 && co.json.order.tailCents <= 99, 'B27 ★ 充值订单也分配唯一尾数（可走对账）');
    eq((await req('POST', '/api/orders', { kind: 'credit', optionId: 'nope' }, tok2)).status, 400,
      'B28 不存在的充值档位被拒');
    await req('POST', '/api/orders/' + co.json.order.id + '/claim', null, tok2);
    const fu = await req('POST', '/api/admin/orders/' + co.json.order.id + '/fulfill', {});
    eq(fu.status, 200, 'B29 管理员核销成功');
    eq(fu.json.archiveCode || null, null, 'B30 ★ 充值订单不生成留档兑换码（凭据是余额流水）');
    const afterPay = (await req('GET', '/api/auth/me', null, tok2)).json.user.balance.paidMicro;
    eq(afterPay - beforePay, yuan(33), 'B31 ★ 核销后自动入账 ¥33（含充值赠送）');
    ok(!(await req('POST', '/api/admin/orders/' + co.json.order.id + '/fulfill', {})).json.ok,
      'B32 重复核销被拒（幂等）');

    /* ---- dailyLimit 只在观察模式生效（订阅去无限化的落点） ---- */
    const uid2b = userOnDisk('bal2@test.local').id;
    await req('PUT', '/api/admin/users/' + uid2b, { dailyLimit: 1 });
    await req('PUT', '/api/admin/pricing', { balance: { enforce: false } });
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok2);
    eq(r.status, 429, 'B33 观察模式下仍按次数上限拦截');
    await req('PUT', '/api/admin/pricing', { balance: { enforce: true } });
    r = await req('POST', '/v1/chat/completions', { model: 'base-model', messages: [] }, tok2);
    eq(r.status, 200, 'B34 ★ 开启 enforce 后次数上限不再生效（额度改由余额承担）');

    // 管理端视图带流水 + 审计
    const adm = (await req('GET', '/api/admin/users')).json.users.find((x) => x.email === 'bal@test.local');
    ok(!!(adm.balance && Array.isArray(adm.balance.ledger) && adm.balance.ledger.length),
      'B35 管理端用户视图带余额流水');
    ok(adm.balance.ledger.some((e) => e.kind === 'plan-grant'), 'B36 ★ 订阅额度发放写入流水');
    const audit = (await req('GET', '/api/admin/audit?limit=50')).json;
    ok((audit.items || []).some((e) => e.action === 'balance.adjust'),
      'B37 充值/调账写入审计（balance.adjust）');
    ok((audit.items || []).some((e) => e.action === 'order.fulfill' && (e.after || {}).kind === 'credit'),
      'B38 充值订单核销写入审计（含 kind=credit）');

    // 充值档位随 /api/plans 下发（插件充值入口据此渲染）
    const plans = (await req('GET', '/api/plans')).json;
    ok(Array.isArray(plans.rechargeOptions) && plans.rechargeOptions.length >= 3, 'B39 /api/plans 下发充值档位');
    ok(plans.rechargeOptions.some((o) => o.bonusCents > 0), 'B40 充值档位含赠送信息（插件可直接展示）');
    eq(plans.plans.find((p) => p.id === 'Pro').monthlyGrantMicro, yuan(20), 'B41 套餐目录暴露每月订阅额度');

    // health
    const h = (await req('GET', '/api/health')).json;
    eq(h.version, '1.7.0', 'B42 服务端版本 1.7.0');
    eq(h.balanceEnforce, true, 'B43 health 暴露 enforce 状态');
    eq(h.signupGrantMicro, yuan(6), 'B44 health 暴露注册赠送额度');
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
