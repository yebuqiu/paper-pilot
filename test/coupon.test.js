#!/usr/bin/env node
/* 优惠券 / 折扣码（服务端 1.4.6）
 *
 * 运行：node test/coupon.test.js
 *
 * 覆盖：
 *   纯函数 —— 码格式与归一、参数校验（**越界拒绝而非夹取**）、状态机五态、
 *            折扣计算（四舍五入到分 / 折后至少留 ¥1 的下限保护 / 门槛 / 每人限用）、
 *            批量生成的原子性（参数非法不留半成品）、局部更新、删除保护。
 *   模型   —— 下单占用名额（reserve）→ 核销消耗（consume）/ 取消与超时释放（release）；
 *            **尾数分配在折后金额上**（否则「按金额唯一对账」会失效）；
 *            与永久会员共存；折后价与试算价一致。
 *   接口   —— Bearer 试算 / 管理 CRUD / health 观测 / 审计留痕。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cp-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

const membership = require(path.join(__dirname, '..', 'server', 'lib', 'membership.js'));
const coupon = require(path.join(__dirname, '..', 'server', 'lib', 'coupon.js'));
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

const D = 86400e3;
const T0 = Date.now();
const iso = (t) => new Date(t).toISOString();
const fresh = () => membership.normalize(membership.newDoc());

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  /* ================= A. 码与参数校验 ================= */
  const a1 = coupon.createCoupons(fresh(), { type: 'percent', percent: 25 }).coupons[0];
  ok(/^CP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(a1.code), 'A1 券码格式 CP-XXXX-XXXX-XXXX', a1.code);
  ok(!/[0O1IL]/.test(a1.code.replace(/-/g, '')), 'A2 字母表剔除易混字符 0/O/1/I/L', a1.code);
  eq(coupon.normCode(a1.code.toLowerCase()), a1.code, 'A3 归一：大小写不敏感');
  eq(coupon.normCode(a1.code.replace(/-/g, ' ')), a1.code, 'A4 归一：分隔符不敏感');
  eq(coupon.normCode('PP-ABCD-EFGH-JKLM'), '', 'A5 不接受激活码前缀（PP- 不会被当成券）');
  eq(coupon.normCode('CP-ABC'), '', 'A6 长度不足判为非法');

  ok(!!coupon.sanitizeCoupon({ type: 'percent', percent: 1 }), 'A7 百分比下界 1 合法');
  ok(!!coupon.sanitizeCoupon({ type: 'percent', percent: 99 }), 'A8 百分比上界 99 合法');
  eq(coupon.sanitizeCoupon({ type: 'percent', percent: 100 }), null, 'A9 100% 被拒绝（免费请用激活码）');
  eq(coupon.sanitizeCoupon({ type: 'percent', percent: 150 }), null, 'A10 越界百分比被拒绝，而非悄悄夹成 99');
  eq(coupon.sanitizeCoupon({ type: 'percent', percent: 0 }), null, 'A11 百分比 0 被拒绝');
  eq(coupon.sanitizeCoupon({ type: 'percent' }), null, 'A12 缺百分比被拒绝');
  eq(coupon.sanitizeCoupon({ type: 'amount', amountCents: 0 }), null, 'A13 固定减免 0 被拒绝');
  ok(!!coupon.sanitizeCoupon({ type: 'amount', amountCents: 1 }), 'A14 固定减免 1 分合法');
  eq(coupon.sanitizeCoupon({ type: 'percent', percent: 10, effectiveFrom: iso(T0 + 2 * D), effectiveTo: iso(T0 + D) }), null,
    'A15 生效起始晚于截止 → 拒绝');

  const r15 = coupon.createCoupons(fresh(), { type: 'percent', percent: 200 });
  ok(!!r15.error, 'A16 批量生成参数非法时报错', r15.error);
  const docNoSide = fresh();
  coupon.createCoupons(docNoSide, { type: 'amount', amountCents: -5, count: 5 });
  eq(docNoSide.coupons.length, 0, 'A17 参数非法时**不留半成品**（doc 里 0 条）');

  const bat = coupon.createCoupons(fresh(), { type: 'percent', percent: 10, count: 5 });
  eq(bat.coupons.length, 5, 'A18 批量生成 5 枚');
  eq(new Set(bat.coupons.map((c) => c.code)).size, 5, 'A19 5 枚码互不重复');
  eq(coupon.createCoupons(fresh(), { type: 'percent', percent: 10, count: 0 }).coupons.length, 1,
    'A20 count=0 回落到 1 枚');

  /* ================= B. 状态机 ================= */
  const mk = (p) => coupon.sanitizeCoupon(Object.assign({ type: 'percent', percent: 20 }, p));
  eq(coupon.stateOf(mk({}), T0), 'active', 'B1 无时段限制 → 生效中');
  eq(coupon.stateOf(mk({ effectiveFrom: iso(T0 + D) }), T0), 'scheduled', 'B2 起期在未来 → 未生效');
  eq(coupon.stateOf(mk({ effectiveTo: iso(T0 - D) }), T0), 'expired', 'B3 截止已过 → 已过期');
  eq(coupon.stateOf(mk({ enabled: false }), T0), 'disabled', 'B4 停用优先于其他判据');
  const ex = mk({ maxUses: 1 });
  coupon.reserveUse(ex, { orderId: 'o-x', userId: 'u1' });
  eq(coupon.stateOf(ex, T0), 'exhausted', 'B5 名额用尽 → 已用尽');
  eq(coupon.stateOf({ id: 'x', code: 'CP-AAAA-BBBB-CCCC', type: 'percent', percent: 0, enabled: true }, T0),
    'invalid', 'B6 数据被手改坏 → 配置异常');
  eq(coupon.stateTextOf('exhausted'), '已用尽', 'B7 状态中文文案');

  /* ================= C. 折扣计算 ================= */
  const c25 = mk({ percent: 25 });
  eq(coupon.computeDiscount(c25, 26900), 6725, 'C1 25% of ¥269 = ¥67.25');
  eq(coupon.computeDiscount(mk({ percent: 33 }), 6900), 2277, 'C2 33% of ¥69 = ¥22.77（四舍五入到分）');
  eq(coupon.computeDiscount(mk({ percent: 33 }), 100), 0, 'C3 折前 ≤ ¥1 时不给减免（守住下限）');
  eq(coupon.computeDiscount(mk({ percent: 99 }), 150), 50, 'C4 折后至少留 ¥1：¥1.50 最多折 ¥0.50');
  eq(coupon.computeDiscount(mk({ percent: 99 }), 26900), 26631, 'C5 99% of ¥269 = ¥266.31（未触到下限）');
  eq(coupon.computeDiscount(mk({ type: 'amount', amountCents: 5000, percent: 0 }), 26900), 5000,
    'C6 固定减免 ¥50');
  eq(coupon.computeDiscount(mk({ type: 'amount', amountCents: 5000, percent: 0 }), 200), 100,
    'C7 固定减免也守下限：¥2.00 最多折 ¥1.00');
  eq(coupon.computeDiscount(c25, 0), 0, 'C8 金额为 0 不给减免');

  /* ================= D. 报价（拒绝路径） ================= */
  const docD = fresh();
  const dP25 = coupon.createCoupons(docD, { type: 'percent', percent: 25 }).coupons[0];
  const dProOnly = coupon.createCoupons(docD, { type: 'percent', percent: 10, plans: ['Pro'] }).coupons[0];
  const dMin = coupon.createCoupons(docD, { type: 'percent', percent: 10, minAmountCents: 10000 }).coupons[0];
  const dOnce = coupon.createCoupons(docD, { type: 'percent', percent: 10, perUser: 1 }).coupons[0];

  eq(coupon.quote(docD, { code: 'NOPE', baseCents: 26900 }).error,
    '优惠码格式不对（应为 CP-XXXX-XXXX-XXXX）', 'D1 格式错 → 明确报格式');
  eq(coupon.quote(docD, { code: 'CP-AAAA-BBBB-CCCC', baseCents: 26900 }).error,
    '优惠码不存在或已失效', 'D2 不存在 → 明确报不存在');
  const q1 = coupon.quote(docD, { code: dP25.code, baseCents: 26900, plan: 'Pro', userId: 'u1' });
  ok(q1.ok, 'D3 正常券报价成功');
  eq(q1.discountCents, 6725, 'D4 报价折扣额正确');
  eq(q1.payableCents, 20175, 'D5 报价应付 = 折前 − 折扣');
  eq(coupon.quote(docD, { code: dProOnly.code, baseCents: 6900, plan: 'Free' }).error,
    '该优惠码仅适用于：Pro', 'D6 等级不匹配 → 拒绝');
  ok(/未达门槛/.test(coupon.quote(docD, { code: dMin.code, baseCents: 6900, plan: 'Pro' }).error || ''),
    'D7 未达门槛 → 拒绝并说明');
  ok(coupon.quote(docD, { code: dMin.code, baseCents: 10000, plan: 'Pro' }).ok, 'D8 恰好达门槛 → 允许');
  coupon.reserveUse(dOnce, { orderId: 'o-1', userId: 'u1' });
  ok(/已使用过 1 次（每人限 1 次）/.test(coupon.quote(docD, { code: dOnce.code, baseCents: 6900, userId: 'u1' }).error || ''),
    'D9 每人限用 → 同一用户第二次被拒');
  ok(coupon.quote(docD, { code: dOnce.code, baseCents: 6900, userId: 'u2' }).ok,
    'D10 每人限用只针对同一用户，别人仍可用');
  eq(coupon.quote(docD, { code: dP25.code, baseCents: 100, plan: 'Pro' }).error,
    '本单折前金额过低（≤ ¥1），无法再打折', 'D11 折前过低 → 拒绝');
  const dOff = coupon.createCoupons(docD, { type: 'percent', percent: 20 }).coupons[0];
  coupon.updateCoupon(docD, dOff.id, { enabled: false });
  ok(/不可用：已停用/.test(coupon.quote(docD, { code: dOff.code, baseCents: 26900 }).error || ''),
    'D12 停用券 → 拒绝并说明原因');

  /* ================= E. 更新 / 删除保护 ================= */
  const docE = fresh();
  const eC = coupon.createCoupons(docE, { type: 'percent', percent: 20, maxUses: 10, perUser: 2, note: '原备注' }).coupons[0];
  const eUp = coupon.updateCoupon(docE, eC.id, { maxUses: 3 });
  ok(!eUp.error, 'E1 局部更新成功');
  eq(eUp.coupon.percent, 20, 'E2 未提交的字段（percent）保持原值');
  eq(eUp.coupon.note, '原备注', 'E3 未提交的字段（note）保持原值');
  eq(eUp.coupon.maxUses, 3, 'E4 已提交字段生效');
  eq(eUp.coupon.perUser, 2, 'E5 perUser 未被清成默认值');
  ok(!!coupon.updateCoupon(docE, eC.id, { percent: 200 }).error, 'E6 更新时越界百分比被拒绝');
  ok(!!coupon.updateCoupon(docE, eC.id, { effectiveFrom: iso(T0 + D), effectiveTo: iso(T0) }).error,
    'E7 更新时时段顺序错误被拒绝');
  eq(eC.percent, 20, 'E8 被拒绝的更新没有污染原值');
  ok(!!coupon.updateCoupon(docE, 'cp-nope', { enabled: false }).error, 'E9 更新不存在的券 → 报错');
  const eDel = coupon.removeCoupon(docE, eC.id);
  ok(!eDel.error, 'E10 无人占用的券可以删除');
  const docE2 = fresh();
  const e2 = coupon.createCoupons(docE2, { type: 'percent', percent: 20 }).coupons[0];
  coupon.reserveUse(e2, { orderId: 'o-9', userId: 'u1' });
  const eDel2 = coupon.removeCoupon(docE2, e2.id);
  ok(!!eDel2.error && /不能删除/.test(eDel2.error), 'E11 已被占用的券拒绝删除（保住对账链）');
  eq(docE2.coupons.length, 1, 'E12 拒绝删除后券仍在库里');
  coupon.releaseUseByOrder(docE2, 'o-9');
  ok(!coupon.removeCoupon(docE2, e2.id).error, 'E13 占用释放后即可删除');

  /* ================= F. 订单生命周期联动 ================= */
  const docF = fresh();
  const fC = coupon.createCoupons(docF, { type: 'percent', percent: 25, maxUses: 2, perUser: 1 }).coupons[0];
  const uA = { id: 'uA', email: 'a@t.local' };
  const uB = { id: 'uB', email: 'b@t.local' };

  const o1 = membership.createOrder(docF, { user: uA, plan: 'Pro', months: 12, couponCode: fC.code });
  ok(!o1.error, 'F1 带券下单成功', o1.error);
  const oo1 = membership.orderOut(docF, o1.order);
  eq(oo1.originalCents, 26900, 'F2 订单记录折前价 ¥269');
  eq(oo1.discountCents, 6725, 'F3 订单记录折扣额 ¥67.25');
  eq(oo1.baseCents, 20175, 'F4 折后价 = 折前 − 折扣');
  eq(oo1.couponCode, fC.code, 'F5 订单记录券码');
  eq(oo1.originalText, '¥269.00', 'F6 折前文案');
  eq(oo1.discountText, '−¥67.25', 'F7 折扣文案');
  ok(oo1.amountCents > oo1.baseCents, 'F8 实付含对账尾数（大于折后价）');
  eq(coupon.usedCount(fC), 1, 'F9 下单即占住 1 个名额');
  eq(coupon.activeUses(fC)[0].state, 'reserved', 'F10 状态是「占用」而不是「已用」');

  const o1b = membership.createOrder(docF, { user: uA, plan: 'Pro', months: 12, couponCode: fC.code });
  ok(!!o1b.error, 'F11 同一用户第二单被每人限用拦下', o1b.error);

  const o2 = membership.createOrder(docF, { user: uB, plan: 'Pro', months: 12, couponCode: fC.code });
  ok(!o2.error, 'F12 另一用户可用同一张券', o2.error);
  eq(coupon.usedCount(fC), 2, 'F13 两个名额都被占住');
  eq(coupon.stateOf(fC), 'exhausted', 'F14 名额用尽 → 已用尽');
  const o3 = membership.createOrder(docF, { user: { id: 'uC', email: 'c@t.local' }, plan: 'Pro', months: 1, couponCode: fC.code });
  ok(!!o3.error && /已用尽/.test(o3.error), 'F15 第三人下单被额度拦下', o3.error);

  // 尾数唯一性必须在**折后**金额上做：两张券折后同价 → 尾数仍互不相同
  eq(o1.order.baseCents, o2.order.baseCents, 'F16 两单折后价相同（前提）');
  ok(o1.order.tailCents !== o2.order.tailCents, 'F17 折后同价的两单尾数互不相同（仍可唯一对账）',
    { a: o1.order.tailCents, b: o2.order.tailCents });

  // 释放：取消
  membership.cancelOrder(docF, o2.order, uB, '测试取消');
  eq(coupon.usedCount(fC), 1, 'F18 取消订单 → 名额释放回 1');
  eq(coupon.activeUses(fC)[0].state, 'reserved', 'F19 另一笔仍保持占用');
  const o4 = membership.createOrder(docF, { user: { id: 'uC', email: 'c@t.local' }, plan: 'Pro', months: 1, couponCode: fC.code });
  ok(!o4.error, 'F20 释放后的名额可以被别人用掉', o4.error);

  // 消耗：核销
  membership.fulfillOrder(docF, o1.order, { by: 'admin' });
  const st1 = coupon.activeUses(fC).map((u) => u.state).sort();
  eq(st1.join(','), 'reserved,used', 'F21 核销只把该订单的占用转为「已用」');
  membership.reapOrders(docF, Date.now() + 999 * D * 0);   // 不超时，不应释放
  eq(coupon.usedCount(fC), 2, 'F22 未超时的订单不受影响');

  /* ================= G. 超时回收释放名额 ================= */
  const docG = fresh();
  const gC = coupon.createCoupons(docG, { type: 'amount', amountCents: 1000, maxUses: 1 }).coupons[0];
  const oG = membership.createOrder(docG, { user: uA, plan: 'Pro', months: 1, couponCode: gC.code });
  ok(!oG.error, 'G1 固定减免券下单成功', oG.error);
  eq(membership.orderOut(docG, oG.order).discountCents, 1000, 'G2 固定减免 ¥10 生效');
  eq(coupon.stateOf(gC), 'exhausted', 'G3 额度被占满');
  oG.order.createdAt = new Date(Date.now() - 999 * D).toISOString();   // 伪造成很久以前
  membership.reapOrders(docG, Date.now());
  eq(oG.order.status, 'expired', 'G4 超时订单被回收');
  eq(coupon.usedCount(gC), 0, 'G5 超时回收 → 券名额释放');
  eq(coupon.stateOf(gC), 'active', 'G6 券回到生效中（名额释放是给后面的人用的）');

  /* ================= H. 与永久会员共存 ================= */
  const docH = fresh();
  coupon.createCoupons(docH, { type: 'percent', percent: 25, note: '永久档打折' });
  // 永久档价格条目在默认配置里没有（线上是后台配的），测试里补一条
  const hPrice = membership.upsertPriceItem(docH, { plan: 'Pro', cycle: 'perpetual', months: 0, price: 128, label: '永久' });
  ok(!hPrice.error, 'H0 配置永久价格条目', hPrice.error);
  const hC = docH.coupons[0];
  const oH = membership.createOrder(docH, { user: uA, plan: 'Pro', cycle: 'perpetual', couponCode: hC.code });
  ok(!oH.error, 'H1 永久会员订单可用优惠券', oH.error);
  const ooH = membership.orderOut(docH, oH.order);
  ok(ooH.perpetual, 'H2 订单仍是永久会员');
  eq(ooH.originalCents, 12800, 'H3 永久档折前价取自价格条目（¥128）');
  eq(ooH.discountCents, 3200, 'H4 永久档折扣正常（25% = ¥32）');
  membership.fulfillOrder(docH, oH.order, { by: 'admin' });
  // 服务端核销路由是「先 fulfillOrder，再 grantMembership」两步，这里照抄同样顺序
  membership.grantMembership(docH, uA, {
    plan: 'Pro', months: 0, perpetual: true, cycle: 'perpetual', source: 'order',
  });
  const mpH = membership.membershipOf(docH, uA);
  ok(mpH.perpetual && !mpH.expiresAt, 'H5 核销后用户获得永久会员（无到期日）',
    { plan: mpH.plan, expiresAt: mpH.expiresAt });

  /* ================= I. 无券下单不受影响（回归） ================= */
  const docI = fresh();
  const oI = membership.createOrder(docI, { user: uA, plan: 'Pro', months: 12 });
  const ooI = membership.orderOut(docI, oI.order);
  eq(ooI.discountCents, 0, 'I1 无券订单折扣为 0');
  eq(ooI.couponCode, null, 'I2 无券订单券码为空');
  eq(ooI.originalCents, ooI.baseCents, 'I3 无券时折前 = 折后');
  eq(ooI.originalText, '¥269.00', 'I4 折前文案正常');
  ok(ooI.discountText === '', 'I5 无折扣时不给折扣文案（UI 不显示减号）');

  /* ================= J. HTTP 接口 ================= */
  await req('POST', '/api/auth/register', { email: 'buyer@t.local', password: 'pw12345678' });
  const lg = await req('POST', '/api/auth/login', { email: 'buyer@t.local', password: 'pw12345678' });
  const tok = lg.json && lg.json.token;
  ok(!!tok, 'J1 测试账号登录成功');

  const h0 = await req('GET', '/api/health');
  eq(h0.json.version, '1.7.0', 'J2 服务端版本 1.7.0');
  ok('coupons' in h0.json && 'couponsActive' in h0.json, 'J3 health 暴露优惠券观测字段', h0.json.coupons);

  const jc = await req('POST', '/api/admin/coupons', { type: 'percent', percent: 30, maxUses: 2, perUser: 1, note: '上线三折优惠' });
  eq(jc.status, 200, 'J4 管理端建券成功');
  const jCode = jc.json.coupons[0].code;
  eq(jc.json.coupons[0].state, 'active', 'J5 新券状态为生效中');
  eq(jc.json.coupons[0].remaining, 2, 'J6 剩余名额 2');
  eq(jc.json.coupons[0].typeText, '按比例减免', 'J7 类型中文文案');

  const jBad = await req('POST', '/api/admin/coupons', { type: 'percent', percent: 100 });
  eq(jBad.status, 400, 'J8 100% 建券被接口拒绝');
  const jBad2 = await req('POST', '/api/admin/coupons', { type: 'amount', amountCents: 0 });
  eq(jBad2.status, 400, 'J9 固定减免 0 被接口拒绝');

  const jq = await req('POST', '/api/coupons/validate', { code: jCode, plan: 'Pro', months: 12 }, tok);
  eq(jq.status, 200, 'J10 试算接口可用（需登录）');
  eq(jq.json.quote.originalCents, 26900, 'J11 试算折前价');
  eq(jq.json.quote.discountCents, 8070, 'J12 试算折扣额 30% = ¥80.70');
  eq(jq.json.quote.payableCents, 18830, 'J13 试算应付 ¥188.30');
  eq(jq.json.quote.payableText, '¥188.30', 'J14 试算应付文案');
  ok(!('uses' in jq.json.quote.coupon), 'J15 试算返回的券视图**不含用量**（不外泄使用记录）');

  const jqNoAuth = await req('POST', '/api/coupons/validate', { code: jCode, plan: 'Pro', months: 12 });
  eq(jqNoAuth.status, 401, 'J16 未登录不能试算');

  // 试算不占名额
  const jListA = await req('GET', '/api/admin/coupons');
  eq(jListA.json.counts.reserved, 0, 'J17 反复试算不占名额');

  const jo = await req('POST', '/api/orders', { plan: 'Pro', months: 12, couponCode: jCode }, tok);
  eq(jo.status, 200, 'J18 带券下单成功');
  eq(jo.json.order.discountCents, 8070, 'J19 接口下单折扣正确');
  eq(jo.json.order.originalCents, 26900, 'J20 接口下单折前价正确');
  eq(jo.json.order.couponCode, jCode, 'J21 接口下单回传券码');
  eq(jo.json.order.baseCents, 18830, 'J22 接口下单折后价正确');

  // ★ 试算价与下单价必须一致（同一个 quote 口径）
  eq(jq.json.quote.payableCents, jo.json.order.baseCents, 'J23 试算应付 == 下单折后价');

  const jListB = await req('GET', '/api/admin/coupons');
  eq(jListB.json.counts.reserved, 1, 'J24 下单后占住 1 个名额');

  const jOrderId = jo.json.order.id;
  const jClaim = await req('POST', '/api/orders/' + jOrderId + '/claim', {}, tok);
  eq(jClaim.status, 200, 'J25 用户标记「我已完成支付」');
  const jFu = await req('POST', '/api/admin/orders/' + jOrderId + '/fulfill', {});
  eq(jFu.status, 200, 'J26 管理员核销');
  const jListC = await req('GET', '/api/admin/coupons');
  eq(jListC.json.counts.used, 1, 'J27 核销后记为「已用」');
  eq(jListC.json.counts.reserved, 0, 'J28 不再有占用');
  eq(jListC.json.counts.active, 1, 'J29 名额 2 只用了 1，券仍在生效中');
  eq(jListC.json.counts.exhausted, 0, 'J29b 未达额度上限，不算用尽');

  // 用户自助取消 → 释放
  const jo2 = await req('POST', '/api/orders', { plan: 'Pro', months: 1, couponCode: jCode }, tok);
  eq(jo2.status, 400, 'J30 同一用户再用同券被拒（perUser=1）');

  // 管理端列表 / 占用后禁止删除 / 停用
  const jId = jc.json.coupons[0].id;
  const jPut = await req('PUT', '/api/admin/coupons/' + jId, { maxUses: 50, note: '扩容' });
  eq(jPut.status, 200, 'J31 局部更新成功');
  eq(jPut.json.coupon.maxUses, 50, 'J32 更新 maxUses 生效');
  eq(jPut.json.coupon.percent, 30, 'J33 未提交的 percent 保持原值');
  eq(jPut.json.coupon.note, '扩容', 'J34 更新 note 生效');

  const jDel = await req('DELETE', '/api/admin/coupons/' + jId);
  eq(jDel.status, 400, 'J35 已有使用记录的券拒绝删除');

  const jc2 = await req('POST', '/api/admin/coupons', { type: 'amount', amountCents: 2000, note: '待删' });
  const jDel2 = await req('DELETE', '/api/admin/coupons/' + jc2.json.coupons[0].id);
  eq(jDel2.status, 200, 'J36 未使用的券可删除');

  // 审计
  const ja = await req('GET', '/api/admin/audit?limit=20');
  const coupons = ja.json.items.filter((x) => x.action.indexOf('coupon.') === 0);
  ok(coupons.some((x) => x.action === 'coupon.create'), 'J37 审计记录 coupon.create');
  ok(coupons.some((x) => x.action === 'coupon.update'), 'J38 审计记录 coupon.update');
  ok(coupons.some((x) => x.action === 'coupon.revoke'), 'J39 审计记录 coupon.revoke');
  const cu = coupons.find((x) => x.action === 'coupon.update');
  ok(!!cu && !!cu.before && !!cu.after, 'J40 更新审计含 before/after 便于追溯改了什么', cu);
  eq(cu.after.percent, 30, 'J41 审计记录了折扣百分比');

  // 批量生成的码值**不落审计**（否则审计日志就成了码本）；单张券的启停/修改仍留码值
  const jBatch = await req('POST', '/api/admin/coupons', { type: 'percent', percent: 5, count: 3, note: '批量' });
  eq(jBatch.json.coupons.length, 3, 'J42 批量生成 3 枚');
  const batchCodes = jBatch.json.coupons.map((c) => c.code);
  const rawAudit = fs.readFileSync(path.join(WORK, 'audit.log'), 'utf8');
  ok(batchCodes.every((c) => rawAudit.indexOf(c) < 0), 'J43 批量生成的码值不落审计（避免审计变成码本）');
  ok(rawAudit.indexOf(jCode) >= 0, 'J44 单张券的修改仍留码值（券码非敏感凭据，便于追溯）');

  // 落盘
  const mdoc = JSON.parse(fs.readFileSync(path.join(WORK, 'membership.json'), 'utf8'));
  // 本轮 HTTP 共建 5 张（1 张主券 + 1 张待删 + 3 张批量），其中 1 张已删除 → 落盘 4 张。
  // A~I 各节用的是彼此独立的内存文档，不落这个文件。
  eq(mdoc.coupons.length, 4, 'J45 优惠券已落盘 membership.json', mdoc.coupons.length);
  const persisted = mdoc.coupons.find((c) => c.id === jId);
  ok(!!persisted && persisted.uses.length === 1 && persisted.uses[0].state === 'used',
    'J46 占用明细（含订单号与用户）已落盘', persisted && persisted.uses);
  ok(!!persisted.uses[0].orderId && !!persisted.uses[0].email,
    'J47 占用明细带订单号与邮箱（可直接对账）', persisted.uses[0]);

  try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
  server.close();
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n优惠券/折扣码测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
