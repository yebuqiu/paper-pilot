#!/usr/bin/env node
/* PaperPilot 会员域集成测试（0.23.0 / 服务端 1.4.0）
 *
 * 零依赖、自起自停：用临时 PP_DATA_DIR 起一个账号服务器实例，跑完整购买/激活链路。
 *   node test/membership.test.js
 *
 * 覆盖：套餐目录 → 注册登录 → 下单 → 我已完成支付 → 管理员核销自动开通 →
 *       激活码批量生成 → 兑换 → 重复兑换拦截 → 管理员直开 → 续期叠加 →
 *       过期降级 → 额度随等级变化 → 越权访问订单被拒。
 */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-membership-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE
process.env.PP_DATA_DIR = DATA_DIR;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY; // 邮件关闭 → 注册直接激活，测试不依赖外网

const serverPath = path.join(__dirname, '..', 'server', 'account-server.js');
const { server } = require(serverPath);

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  failures.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers,
      agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const DAY = 86400e3;
function daysBetween(iso) { return Math.round((Date.parse(iso) - Date.now()) / DAY); }

(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  PORT = server.address().port;

  try {
    /* 1. 套餐目录（公开，未登录可看） */
    let r = await req('GET', '/api/plans');
    eq(r.status, 200, '1.1 /api/plans 公开可访问');
    const planIds = (r.json.plans || []).map((p) => p.id);
    ok(planIds.includes('Free') && planIds.includes('Pro'), '1.2 套餐含 Free 与 Pro', planIds);
    ok((r.json.priceOptions || []).length >= 3, '1.3 价格档位已下发', r.json.priceOptions);
    const freePlan = r.json.plans.find((p) => p.id === 'Free');
    const proPlan = r.json.plans.find((p) => p.id === 'Pro');
    eq(freePlan.dailyLimit, 100, '1.4 Free 每日额度 = 100');
    eq(proPlan.dailyLimit, 3000, '1.5 Pro 每日额度 = 3000');
    eq(proPlan.purchasable, true, '1.6 Pro 可购买');
    eq(freePlan.purchasable, false, '1.7 Free 不可购买');

    /* 2. 注册 + 登录 */
    r = await req('POST', '/api/auth/register', { email: 'u1@test.local', password: 'pw12345678', nickname: '测试甲' });
    eq(r.status, 200, '2.1 注册成功');
    eq(r.json.user.status, 'active', '2.2 无邮件服务时直接激活');
    const userId = (await req('POST', '/api/auth/login', { email: 'u1@test.local', password: 'pw12345678' }));
    let token = userId.json.token;
    ok(!!token, '2.3 登录拿到令牌');
    eq(userId.json.user.membership.plan, 'Free', '2.4 新用户默认 Free');
    eq(userId.json.user.dailyLimit, 100, '2.5 新用户额度 100');
    eq(userId.json.user.membership.expiresAt, null, '2.6 Free 无到期日');

    /* 3. 下单 */
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 3 }, token);
    eq(r.status, 200, '3.1 下单成功');
    const order = r.json.order;
    eq(order.status, 'pending', '3.2 订单初始为待支付');
    eq(order.baseCents, 7900, '3.3 3 个月走档位价 79（baseCents；实付另加对账尾数）');
    eq(order.months, 3, '3.4 订单月数');
    ok(!!order.pay && 'note' in order.pay, '3.5 订单带收款信息');

    r = await req('POST', '/api/orders', { plan: 'Free', months: 1 }, token);
    eq(r.status, 400, '3.6 免费版不可下单');

    /* 4. 越权：另一个账号读不到该订单 */
    await req('POST', '/api/auth/register', { email: 'u2@test.local', password: 'pw12345678' });
    const t2 = (await req('POST', '/api/auth/login', { email: 'u2@test.local', password: 'pw12345678' })).json.token;
    r = await req('GET', '/api/orders/' + order.id, undefined, t2);
    eq(r.status, 404, '4.1 他人订单不可见');

    /* 5. 我已完成支付 → 管理员核销 → 自动开通 */
    r = await req('POST', `/api/orders/${order.id}/claim`, undefined, token);
    eq(r.status, 200, '5.1 标记已支付');
    eq(r.json.order.status, 'claimed', '5.2 状态转待核销');

    r = await req('GET', '/api/admin/membership');
    eq(r.status, 200, '5.3 管理接口本机可访问');
    eq(r.json.counts.awaitingReview, 1, '5.4 待核销计数 = 1');

    r = await req('POST', `/api/admin/orders/${order.id}/fulfill`, {}, undefined);
    eq(r.status, 200, '5.5 核销成功');
    eq(r.json.order.status, 'fulfilled', '5.6 订单已开通');
    eq(r.json.user.membership.plan, 'Pro', '5.7 核销后开通 Pro');
    ok(!!r.json.archiveCode && r.json.archiveCode.status === 'used', '5.8 生成已用留档兑换码');
    const afterFulfill = r.json.user.membership.expiresAt;
    eq(daysBetween(afterFulfill), 90, '5.9 3 个月 = 90 天');

    r = await req('POST', `/api/admin/orders/${order.id}/fulfill`, {}, undefined);
    eq(r.status, 400, '5.10 重复核销被拒（幂等保护）');

    /* 6. /me 反映 Pro */
    r = await req('GET', '/api/auth/me', undefined, token);
    eq(r.json.user.plan, 'Pro', '6.1 /me 返回 Pro');
    eq(r.json.user.dailyLimit, 3000, '6.2 Pro 额度 3000');
    ok(r.json.user.membership.daysLeft >= 89, '6.3 剩余天数 ≥ 89', r.json.user.membership.daysLeft);

    /* 7. 激活码：生成 → 兑换 → 续期叠加 */
    r = await req('POST', '/api/admin/codes', { plan: 'Pro', months: 1, count: 2, note: '线下售卖' });
    eq(r.status, 200, '7.1 批量生成 2 枚激活码');
    eq(r.json.codes.length, 2, '7.2 返回 2 枚');
    const codeA = r.json.codes[0].code;
    const codeB = r.json.codes[1].code;
    ok(/^PP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeA), '7.3 激活码格式', codeA);

    r = await req('POST', '/api/redeem', { code: codeA }, token);
    eq(r.status, 200, '7.4 兑换成功');
    eq(r.json.membership.plan, 'Pro', '7.5 兑换后 Pro');
    eq(daysBetween(r.json.membership.expiresAt), 120, '7.6 续期叠加：90 → 120 天（剩余时长不吞）');

    r = await req('POST', '/api/redeem', { code: codeA }, token);
    eq(r.status, 400, '7.7 同一激活码重复兑换被拒');
    ok(/已.*使用/.test(r.json.error || ''), '7.8 报错文案说明已被使用', r.json.error);

    r = await req('POST', '/api/redeem', { code: 'PP-XXXX-XXXX-XXXX' }, token);
    eq(r.status, 400, '7.9 不存在的激活码被拒');

    // 小写 / 无分隔符写法也应识别
    const loose = codeB.toLowerCase().replace(/-/g, '');
    r = await req('POST', '/api/redeem', { code: loose }, t2);
    eq(r.status, 200, '7.10 激活码大小写与分隔符不敏感');

    // 已绑定的码不能被别人用
    r = await req('POST', '/api/redeem', { code: codeA }, t2);
    eq(r.status, 400, '7.11 已用激活码他人不可用');

    /* 8. 管理员直接开通（叠加） */
    r = await req('GET', '/api/admin/users');
    const u1 = r.json.users.find((u) => u.email === 'u1@test.local');
    ok(!!u1, '8.1 管理列表含目标用户');
    const before = u1.membership.expiresAt;
    r = await req('POST', `/api/admin/users/${u1.id}/membership`, { plan: 'Pro', months: 1, note: '补偿' });
    eq(r.status, 200, '8.2 管理员直开成功');
    eq(daysBetween(r.json.membership.expiresAt) - daysBetween(before), 30, '8.3 直开同样叠加 30 天');

    /* 9. 过期降级（不踢下线） */
    r = await req('PUT', `/api/admin/users/${u1.id}`, { expiresAt: new Date(Date.now() - DAY).toISOString() });
    eq(r.status, 200, '9.1 管理员把到期日改到昨天');
    r = await req('GET', '/api/auth/me', undefined, token);
    eq(r.status, 200, '9.2 过期不踢下线（仍 200）');
    eq(r.json.user.plan, 'Free', '9.3 过期后有效等级回落 Free');
    eq(r.json.user.dailyLimit, 100, '9.4 额度同步回落到 100');
    eq(r.json.user.membership.expired, true, '9.5 membership.expired 标记为真');
    eq(r.json.user.membership.daysLeft, 0, '9.6 剩余天数 0');

    /* 10. 套餐配置可后台调整 */
    r = await req('PUT', '/api/admin/membership', { plans: { Free: { dailyLimit: 150 } } });
    eq(r.status, 200, '10.1 改 Free 额度');
    r = await req('GET', '/api/auth/me', undefined, token);
    eq(r.json.user.dailyLimit, 150, '10.2 改配置即刻生效（无需重启）');
    r = await req('PUT', '/api/admin/membership', { plans: { Free: { dailyLimit: 100 } } });
    eq(r.json.plans.plans.find((p) => p.id === 'Free').dailyLimit, 100, '10.3 改回 100');

    /* 11. 未登录访问会员接口 */
    r = await req('GET', '/api/membership');
    eq(r.status, 401, '11.1 未登录查会员 → 401');
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 1 });
    eq(r.status, 401, '11.2 未登录下单 → 401');

    /* 12. 持久化：membership.json 与 users.json 均落盘且可重新加载 */
    const mdoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'membership.json'), 'utf8'));
    eq(mdoc.schemaVersion, 3, '12.1 membership.json 带 schemaVersion=3');
    ok(mdoc.orders.length >= 1 && mdoc.codes.length >= 3, '12.2 订单与激活码已落盘',
      { orders: mdoc.orders.length, codes: mdoc.codes.length });
    const udoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8'));
    const su = udoc.users.find((u) => u.email === 'u1@test.local');
    ok(!!su.membership && su.membership.history.length >= 3, '12.3 用户会员历史已落盘',
      su.membership && su.membership.history.length);
    eq(su.plan, su.membership.plan, '12.4 兼容镜像 user.plan 与 membership.plan 一致');

    /* ============ 13. 价格表：等级 × 计费周期 × 生效时段 ============ */
    r = await req('GET', '/api/admin/prices');
    eq(r.status, 200, '13.1 价格表接口可用');
    eq(r.json.items.length, 3, '13.2 默认 3 条价格');
    ok(r.json.cycles.length >= 5, '13.3 下发计费周期预设', r.json.cycles.length);
    eq(r.json.plans.length, 1, '13.4 可配价等级只有 Pro（Free 不需要配价）');
    eq(r.json.plans[0].id, 'Pro', '13.5 等级 id 正确');
    const p12 = r.json.items.find((i) => i.months === 12);
    eq(p12.cycleName, '按年', '13.6 12 个月识别为按年');
    eq(p12.perMonth, 22.42, '13.7 折合月单价 269/12');
    eq(p12.state, 'active', '13.8 默认价格生效中');
    eq(p12.winner, true, '13.9 默认价格是胜者');

    // 新增「未来生效」的限时促销价（同周期、priority 1）
    const promoFrom = new Date(Date.now() + 2 * DAY).toISOString();
    const promoTo = new Date(Date.now() + 10 * DAY).toISOString();
    r = await req('POST', '/api/admin/prices', { plan: 'Pro', months: 1, price: 19,
      label: '限时 19', effectiveFrom: promoFrom, effectiveTo: promoTo, priority: 1 });
    eq(r.status, 200, '13.10 新增促销价成功');
    const promoId = r.json.item.id;
    eq(r.json.item.state, 'scheduled', '13.11 起期在将来 → 状态为未生效');
    ok(/重叠/.test(r.json.warn || ''), '13.12 与基础价重叠 → 返回提示而不是报错', r.json.warn);

    // 未生效的价格不能下单，只能预告
    r = await req('GET', '/api/plans');
    ok(!(r.json.priceItems || []).some((i) => i.months === 1 && i.price === 19),
      '13.13 未生效促销价不下发到可购清单');
    ok((r.json.upcoming || []).some((i) => i.months === 1 && i.price === 19),
      '13.14 未生效促销价出现在 upcoming 预告里');
    ok(!(r.json.priceOptions || []).some((o) => o.months === 1 && o.price === 19),
      '13.15 派生 priceOptions 也不含未生效价');
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 1 }, token);
    // 1.4.5 起实付金额 = 原始价 + 对账尾数，所以原始价要看 baseCents
    eq(r.json.order.baseCents, 2900, '13.16 促销未生效时下单仍是原价 29（baseCents=2900）');
    ok(r.json.order.tailCents >= 1 && r.json.order.tailCents <= 99, '13.16b 订单带 1..99 的对账尾数', r.json.order.tailCents);
    eq(r.json.order.cycle, 'monthly', '13.17 订单记录计费周期');
    ok(!!r.json.order.priceItemId, '13.18 订单记录价格条目 id（对账溯源）');
    const orderBeforePromo = r.json.order.id;

    // 把促销价改成「现在立刻生效 + 更高优先级」→ 立刻覆盖基础价
    r = await req('PUT', '/api/admin/prices/' + promoId, {
      effectiveFrom: null, effectiveTo: null, priority: 2 });
    eq(r.status, 200, '13.19 改促销价时段成功');
    eq(r.json.item.state, 'active', '13.20 去掉时段限制后立即生效');
    r = await req('GET', '/api/plans');
    const oneMonth = (r.json.priceItems || []).filter((i) => i.months === 1);
    eq(oneMonth.length, 1, '13.21 同一周期客户端只看到一条价');
    eq(oneMonth[0].price, 19, '13.22 高优先级促销价胜出');
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 1 }, token);
    eq(r.json.order.baseCents, 1900, '13.23 下单立刻用上促销价（baseCents=1900）');
    eq(r.json.order.priceItemId, promoId, '13.24 订单指向促销条目');
    eq(r.json.order.priceSource, 'item', '13.25 价格来源为条目');

    // 后台仍能看到两条同周期价，且只有一条标注胜出
    r = await req('GET', '/api/admin/prices');
    const oneMonthAll = r.json.items.filter((i) => i.months === 1);
    eq(oneMonthAll.length, 2, '13.26 后台仍可见两条同周期价格');
    eq(oneMonthAll.filter((i) => i.winner).length, 1, '13.27 仅一条标注为胜出');
    eq(oneMonthAll.find((i) => i.winner).price, 19, '13.28 胜出的是促销价');

    // 停用促销 → 立刻回到基础价
    r = await req('PUT', '/api/admin/prices/' + promoId, { enabled: false });
    eq(r.status, 200, '13.29 停用促销价成功');
    eq(r.json.item.state, 'disabled', '13.30 状态为已停用');
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 1 }, token);
    eq(r.json.order.baseCents, 2900, '13.31 停用后下单回到基础价（baseCents=2900）');

    // 未配置的计费周期明确拒绝（不让用户买到没配的周期）
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 6 }, token);
    eq(r.status, 400, '13.32 未配置周期下单被拒');
    ok(/可选/.test(r.json.error || ''), '13.33 报错里列出可购买周期', r.json.error);

    // 空档预警
    r = await req('POST', '/api/admin/prices', { plan: 'Pro', months: 18, price: 399,
      label: '十八个月', effectiveTo: new Date(Date.now() + 30 * DAY).toISOString() });
    eq(r.status, 200, '13.34 新增有限时段价格成功');
    ok(/没有任何生效价格/.test(r.json.warn || ''), '13.35 其后无接续 → 返回空档预警', r.json.warn);
    const gapId = r.json.item.id;

    // 非法输入
    r = await req('POST', '/api/admin/prices', { plan: 'Pro', months: 7, price: 0 });
    eq(r.status, 400, '13.36 价格 0 被拒');
    r = await req('POST', '/api/admin/prices', { plan: 'Nope', months: 7, price: 10 });
    eq(r.status, 400, '13.37 未知等级被拒');
    r = await req('PUT', '/api/admin/prices/pr-not-exist', { price: 5 });
    eq(r.status, 404, '13.38 改不存在的条目 → 404');
    r = await req('DELETE', '/api/admin/prices/pr-not-exist');
    eq(r.status, 404, '13.39 删不存在的条目 → 404');

    // 删除
    r = await req('DELETE', '/api/admin/prices/' + gapId);
    eq(r.status, 200, '13.40 删除价格条目成功');
    r = await req('GET', '/api/admin/prices');
    ok(!r.json.items.some((i) => i.id === gapId), '13.41 条目已从列表中移除');

    // 健康检查反映价格表规模
    r = await req('GET', '/api/health');
    ok(typeof r.json.priceActive === 'number', '13.42 health 暴露 priceActive', r.json.priceActive);
    ok(typeof r.json.priceScheduled === 'number', '13.43 health 暴露 priceScheduled');
    eq(r.json.priceActive, 3, '13.44 生效中价格数（1/3/12 月基础价；停用的促销与已删条目不计）',
      r.json.priceActive);
    eq(r.json.priceScheduled, 0, '13.44b 无未生效价格（促销已改为停用而非未来生效）',
      r.json.priceScheduled);

    // 落盘校验
    const mdoc2 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'membership.json'), 'utf8'));
    ok(Array.isArray(mdoc2.priceItems) && mdoc2.priceItems.length >= 4, '13.45 价格表已落盘',
      mdoc2.priceItems.length);
    ok(!!mdoc2.priceOptions && !!mdoc2.priceOptions.Pro, '13.46 派生的 priceOptions 也写回文档');
    eq(mdoc2.priceOptions.Pro.filter((o) => o.months === 1).length, 1,
      '13.47 派生视图中同周期只保留胜者');
    const promoRow = mdoc2.priceItems.find((i) => i.id === promoId);
    eq(promoRow.enabled, false, '13.48 停用状态已落盘');
    eq(promoRow.priority, 2, '13.49 优先级已落盘');
    void orderBeforePromo;
  } catch (e) {
    failures.push('异常中断：' + (e && e.stack || e));
  } finally {
    server.close();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n会员域集成测试：' + pass + ' 项通过，' + failures.length + ' 项失败');
  if (failures.length) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
