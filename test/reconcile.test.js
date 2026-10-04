#!/usr/bin/env node
/* 永久会员 + 唯一尾数 + 收款流水对账（服务端 1.4.5）
 *
 * 运行：node test/reconcile.test.js
 *
 * 覆盖：
 *   纯函数 —— 流水解析（金额/时间/备注/容错）、尾数分配（同金额唯一 / 终态回收 / 用尽报错 / 分散）、
 *            匹配三态（命中 / 无对应 / 多笔同价需人工 / 重复流水）、时间窗、多付少付不匹配。
 *   模型   —— 永久价格条目、永久取价（months=0）、永久下单、永久授予、**永久不被月数续费降级**。
 *   接口   —— dryRun 预览 → 确认核销 → 用户变永久；审计留痕；已核销订单不重复核销。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rc-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

const membership = require(path.join(__dirname, '..', 'server', 'lib', 'membership.js'));
const reconcile = require(path.join(__dirname, '..', 'server', 'lib', 'reconcile.js'));
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

(async () => {
  try {
    /* ================= A. 流水解析 ================= */
    const T0 = Date.parse('2026-10-03T12:00:00Z');
    let e = reconcile.parseLine('128.62,2026-10-03 20:00:00,微信,4200001', T0);
    eq(e.amountCents, 12862, 'A1 金额换算成分（128.62 → 12862）');
    eq(e.note, '微信', 'A2 备注解析');
    eq(e.txnId, '4200001', 'A3 交易号解析');
    ok(e.at > 0, 'A4 时间解析成功', e.at);
    eq(reconcile.parseLine('¥29.50', T0).amountCents, 2950, 'A5 容忍 ¥ 前缀');
    eq(reconcile.parseLine('79.15，2026-10-03 13:05', T0).amountCents, 7915, 'A6 容忍全角逗号');
    eq(reconcile.parseLine('29.5', T0).amountCents, 2950, 'A7 一位小数按分补齐（29.5 → 2950）');
    eq(reconcile.parseLine('29.5', T0).at, T0, 'A8 未给时间 → 用默认时间');
    eq(reconcile.parseLine('', T0), null, 'A9 空行忽略');
    eq(reconcile.parseLine('# 注释', T0), null, 'A10 # 开头当注释忽略');
    eq(reconcile.parseLine('abc', T0), null, 'A11 非数字忽略');
    eq(reconcile.parseLine('-5', T0), null, 'A12 负数忽略');
    eq(reconcile.parseEntries('128.62\n\n29.50,2026-10-03 12:00\n#x\n79.15', T0).length, 3, 'A13 批量解析跳过空行与注释');
    eq(reconcile.money(12862), '¥128.62', 'A14 金额格式化');

    /* ================= B. 尾数分配 ================= */
    const doc0 = membership.normalize(membership.newDoc());
    const a1 = membership.assignTail(doc0, 12800, { rng: () => 0 });        // 起点固定 → 1
    eq(a1.tailCents, 1, 'B1 随机起点 0 → 取最小可用尾数 1');
    doc0.orders.push({ id: 'x1', status: 'pending', baseCents: 12800, amountCents: 12801, tailCents: 1 });
    const a2 = membership.assignTail(doc0, 12800, { rng: () => 0 });
    eq(a2.tailCents, 2, 'B2 已占用的尾数会被跳过');
    // 终态订单的尾数可回收
    doc0.orders[0].status = 'fulfilled';
    const a3 = membership.assignTail(doc0, 12800, { rng: () => 0 });
    eq(a3.tailCents, 1, 'B3 已核销订单的尾数被回收重用');
    // 不同 base 互不影响
    eq(membership.assignTail(doc0, 2900, { rng: () => 0 }).tailCents, 1, 'B4 不同原始价各自从可用尾数开始');
    // 用尽 → 明确报错
    const docFull = membership.normalize(membership.newDoc());
    for (let i = 1; i <= 99; i++) {
      docFull.orders.push({ id: 'f' + i, status: 'pending', baseCents: 12800, amountCents: 12800 + i, tailCents: i });
    }
    const af = membership.assignTail(docFull, 12800);
    ok(!!af.error && /占满|尾数/.test(af.error), 'B5 99 个尾数用尽 → 明确报错（不重复金额）', af.error);
    // 分散性：随机起点确实会给出不同尾数
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(membership.assignTail(doc0, 99900).tailCents);
    ok(seen.size > 1, 'B6 随机起点让尾数分散（不是总给 1）', seen.size);

    /* ================= C. 永久会员模型 ================= */
    const doc = membership.normalize(membership.newDoc());
    let r = membership.upsertPriceItem(doc, { plan: 'Pro', cycle: 'perpetual', months: 0, price: 128, label: '永久' });
    ok(!r.error, 'C1 可以新增「永久」价格条目', r.error);
    eq(r.item.months, 0, 'C2 永久条目的 months 恒为 0');
    eq(r.item.cycle, 'perpetual', 'C3 周期标记为 perpetual');
    eq(membership.effectivePrice(doc, 'Pro', 0).price, 128, 'C4 months=0 取到永久价');
    ok(!!membership.effectivePrice(doc, 'Pro', 0).ok, 'C5 永久取价成功');
    eq(membership.effectivePrice(doc, 'Pro', 1).price, 29, 'C6 按月价不受影响');

    const cli = membership.plansForClient(doc);
    const perp = cli.priceItems.filter((i) => i.cycle === 'perpetual')[0];
    ok(!!perp, 'C7 永久条目下发给客户端');
    eq(perp.cycleName, '永久', 'C8 客户端拿到中文周期名');
    eq(perp.perMonth, 0, 'C9 永久不显示折合月单价');
    eq(perp.label, '永久', 'C10 默认展示名是「永久」而不是「0 个月」');
    ok(cli.priceOptions.some((o) => o.months === 0 && o.label === '永久'), 'C11 派生只读视图也标「永久」（老客户端可用）');

    // 下单
    const buyer = { id: 'u1', email: 'a@b.c' };
    const o1 = membership.createOrder(doc, { user: buyer, plan: 'Pro', cycle: 'perpetual' }).order;
    ok(!!o1 && o1.perpetual === true, 'C12 永久下单标记 perpetual');
    eq(o1.baseCents, 12800, 'C13 原始价为 12800 分');
    ok(o1.tailCents >= 1 && o1.tailCents <= 99, 'C14 分配到 1..99 的尾数', o1.tailCents);
    eq(o1.amountCents, 12800 + o1.tailCents, 'C15 实付 = 原始价 + 尾数');
    const oo1 = membership.orderOut(doc, o1);
    eq(oo1.amountText, '¥' + ((12800 + o1.tailCents) / 100).toFixed(2), 'C16 amountText 带两位小数');
    eq(oo1.perpetual, true, 'C17 orderOut 暴露 perpetual');
    const o2 = membership.createOrder(doc, { user: { id: 'u2', email: 'd@e.f' }, plan: 'Pro', cycle: 'perpetual' }).order;
    ok(o2.amountCents !== o1.amountCents, 'C18 两笔同价订单拿到不同尾数（这是对账能工作的前提）',
      { a: o1.amountCents, b: o2.amountCents });
    const o3 = membership.createOrder(doc, { user: buyer, plan: 'Pro', months: 3 }).order;
    eq(o3.perpetual, false, 'C19 按月下单不是永久');
    eq(o3.baseCents, 7900, 'C20 3 个月的原始价 7900 分');

    // 授予
    const mu = { id: 'u1', email: 'a@b.c' };
    let mp = membership.grantMembership(doc, mu, { plan: 'Pro', perpetual: true, source: 'order' });
    eq(mp.plan, 'Pro', 'C21 永久授予后等级为 Pro');
    eq(mp.perpetual, true, 'C22 membershipOf 标记 perpetual');
    eq(mp.expiresAt, null, 'C23 永久没有到期日');
    eq(mp.daysLeft, null, 'C24 永久没有剩余天数');
    eq(mu.expiresAt, null, 'C25 兼容镜像 user.expiresAt 为 null');
    mp = membership.grantMembership(doc, mu, { plan: 'Pro', months: 3, source: 'admin' });
    eq(mp.perpetual, true, 'C26 永久用户再买月数**不会**被降级为限期');
    eq(mp.expiresAt, null, 'C27 降级后仍是永久（无到期日）');
    const mu2 = { id: 'u3', email: 'g@h.i' };
    eq(membership.grantMembership(doc, mu2, { plan: 'Pro', months: 3 }).perpetual, false, 'C28 普通月数授予不是永久');
    // 永久用户不被到期检查踢成 Free
    eq(membership.membershipOf(doc, mu).plan, 'Pro', 'C29 永久用户始终是 Pro（不会被判过期）');
    eq(membership.membershipOf(doc, mu).expired, false, 'C30 永久用户不会 expired');

    /* ================= D. 匹配三态 ================= */
    const t = Date.parse(o1.createdAt);
    let m = reconcile.matchPayments(doc, [{ amountCents: o1.amountCents, at: t + 60000 }], { now: t });
    eq(m.results[0].status, 'matched', 'D1 金额精确命中');
    eq(m.results[0].orderId, o1.id, 'D2 命中的是正确订单');
    eq(m.summary.matched, 1, 'D3 汇总命中数正确');
    eq(m.summary.matchedCents, o1.amountCents, 'D4 汇总命中金额正确');

    m = reconcile.matchPayments(doc, [{ amountCents: 99999, at: t }], { now: t });
    eq(m.results[0].status, 'unmatched', 'D5 金额对不上 → 无对应订单');
    ok(/尾数/.test(m.results[0].reason), 'D6 提示里说明「金额需含尾数」', m.results[0].reason);
    // 多付/少付都不匹配（防错）
    eq(reconcile.matchPayments(doc, [{ amountCents: o1.amountCents + 100, at: t }]).results[0].status,
      'unmatched', 'D7 多付 1 元不匹配');
    eq(reconcile.matchPayments(doc, [{ amountCents: 12800, at: t }]).results[0].status,
      'unmatched', 'D8 只按整数（无尾数）不匹配');
    // 时间窗
    eq(reconcile.matchPayments(doc, [{ amountCents: o1.amountCents, at: t + 40 * 86400e3 }],
      { windowDays: 30 }).results[0].status, 'unmatched', 'D9 超出时间窗不匹配');
    eq(reconcile.matchPayments(doc, [{ amountCents: o1.amountCents, at: t + 40 * 86400e3 }],
      { windowDays: 60 }).results[0].status, 'matched', 'D10 放大时间窗后命中');
    // 重复流水
    m = reconcile.matchPayments(doc, [
      { amountCents: o1.amountCents, at: t + 60000 },
      { amountCents: o1.amountCents, at: t + 70000 },
    ]);
    eq(m.results[0].status, 'matched', 'D11 第一条命中');
    eq(m.results[1].status, 'duplicate', 'D12 同一批里重复流水被拦住（不会核销两次）');
    // 已核销订单
    o1.status = 'fulfilled';
    m = reconcile.matchPayments(doc, [{ amountCents: o1.amountCents, at: t + 60000 }]);
    eq(m.results[0].status, 'unmatched', 'D13 已核销订单不再被匹配');
    ok(/已完成|已取消/.test(m.results[0].reason), 'D14 提示说明订单已完成', m.results[0].reason);
    o1.status = 'pending';

    /* ================= E. 接口：dryRun → 确认核销 ================= */
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    PORT = server.address().port;

    // 生产同款：加一条永久价（走后台接口）
    let rr = await req('POST', '/api/admin/prices', { plan: 'Pro', cycle: 'perpetual', months: 0, price: 128, label: '永久' });
    eq(rr.status, 200, 'E1 后台可新增永久价格条目');
    eq(rr.json.item.months, 0, 'E2 接口返回的永久条目 months=0');

    const plans = (await req('GET', '/api/plans')).json;
    ok(plans.priceItems.some((x) => x.cycle === 'perpetual' && x.price === 128),
      'E3 /api/plans 下发永久价（插件据此显示「永久 · ¥128」）');

    // 用户下单（模拟插件：传 cycle=perpetual）
    await req('POST', '/api/auth/register', { email: 'buyer@test.local', password: 'pw12345678' });
    const tok = (await req('POST', '/api/auth/login', { email: 'buyer@test.local', password: 'pw12345678' })).json.token;
    const order = (await req('POST', '/api/orders', { plan: 'Pro', cycle: 'perpetual' }, tok)).json.order;
    ok(!!order && order.perpetual === true, 'E4 用户端下永久订单（只传 cycle）');
    eq(order.baseCents, 12800, 'E5 订单原始价 12800 分');
    ok(!!order.tailCents, 'E6 订单带唯一尾数');
    eq(order.amountText, '¥' + (order.amountCents / 100).toFixed(2), 'E7 用户端拿到带尾数的实付金额');

    // 预览（dryRun）：不改任何数据
    let rc = await req('POST', '/api/admin/reconcile', { text: order.amountText.replace('¥', '') });
    eq(rc.status, 200, 'E8 对账接口可用');
    eq(rc.json.dryRun, true, 'E9 默认是预览模式（不传 dryRun:false 不会改数据）');
    eq(rc.json.results[0].status, 'matched', 'E10 预览命中该订单');
    eq(rc.json.results[0].email, 'buyer@test.local', 'E11 预览显示对应用户');
    let stillPending = (await req('GET', '/api/admin/orders')).json.orders.find((o) => o.id === order.id);
    eq(stillPending.status, 'pending', 'E12 预览后订单**仍未**核销（dryRun 不动数据）');

    // 确认核销
    rc = await req('POST', '/api/admin/reconcile', {
      text: order.amountText.replace('¥', ''), dryRun: false,
    });
    eq(rc.json.dryRun, false, 'E13 执行模式');
    eq((rc.json.applied || []).filter((x) => x.ok).length, 1, 'E14 核销 1 笔');
    const done = (await req('GET', '/api/admin/orders')).json.orders.find((o) => o.id === order.id);
    eq(done.status, 'fulfilled', 'E15 订单已核销开通');

    // 用户已变永久
    const me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.plan, 'Pro', 'E16 用户等级变 Pro');
    eq(me.membership.perpetual, true, 'E17 用户成为**永久**会员');
    eq(me.membership.expiresAt, null, 'E18 永久会员没有到期日');

    // 盘上也要对（重启不丢）
    const udoc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
    const su = udoc.users.find((u) => u.email === 'buyer@test.local');
    ok(!!(su.membership && su.membership.perpetual === true), 'E19 users.json 里落盘为永久');
    eq(su.expiresAt, null, 'E20 兼容镜像 user.expiresAt 为 null');

    // 再对一次同一流水 → 不再重复核销
    rc = await req('POST', '/api/admin/reconcile', { text: order.amountText.replace('¥', ''), dryRun: false });
    eq((rc.json.applied || []).length, 0, 'E21 重复对账不会再次核销');
    ok(['unmatched', 'duplicate'].indexOf(rc.json.results[0].status) >= 0,
      'E22 重复流水被识别为无对应/重复', rc.json.results[0].status);

    // 审计留痕
    const audit = (await req('GET', '/api/admin/audit?action=order.reconcile')).json;
    eq(audit.items.length, 1, 'E23 对账核销写入了审计');
    eq(audit.items[0].target, order.id, 'E24 审计指向该订单');
    ok(/buyer@test.local/.test(audit.items[0].note), 'E25 审计记下用户邮箱', audit.items[0].note);
    eq(audit.items[0].actionText, '对账自动核销', 'E26 审计动作有中文名');

    // 空流水 / 无有效行 → 400 且给格式提示
    rc = await req('POST', '/api/admin/reconcile', { text: '一堆无法解析的文字' });
    eq(rc.status, 400, 'E27 解析不出流水 → 400');
    ok(/每行|格式/.test(rc.json.error), 'E28 报错里给出格式示例', rc.json.error);

    // 按月订单走同一条链路（回归）
    const order2 = (await req('POST', '/api/orders', { plan: 'Pro', months: 1 }, tok)).json.order;
    rc = await req('POST', '/api/admin/reconcile', { text: order2.amountText.replace('¥', ''), dryRun: false });
    eq(rc.json.results[0].status, 'matched', 'E29 按月订单同样可对账');
    const me2 = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me2.membership.perpetual, true, 'E30 永久用户再买月数仍是永久');
    eq(me2.membership.expiresAt, null, 'E31 且仍无到期日');

    // 管理员开通/续期接口也支持永久
    const u2 = (await req('GET', '/api/admin/users')).json.users
      .filter((x) => x.email !== 'buyer@test.local')[0];
    if (u2) {
      const g = await req('POST', `/api/admin/users/${u2.id}/membership`, { plan: 'Pro', perpetual: true, note: '测试永久' });
      eq(g.json.membership.perpetual, true, 'E32 管理员可直接开永久（perpetual:true）');
      eq(g.json.membership.expiresAt, null, 'E33 永久无到期日');
    }
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n永久会员与对账测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
