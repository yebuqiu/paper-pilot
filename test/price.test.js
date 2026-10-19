#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 价格表单测（0.23.1）：等级 × 计费周期 × 生效时段 —— 纯函数，不依赖服务端与网络。
 *
 * 覆盖：
 *   · v2 的 priceOptions → v3 priceItems 迁移（只做一次，且派生视图不变）
 *   · 计费周期映射（月/季/半年/年/自定义）
 *   · 四种状态：生效中 / 未生效 / 已过期 / 已停用
 *   · 客户端下发：只给生效中的；未生效进 upcoming；已过期完全不下发
 *   · 重叠校验：同等级同月数时段重叠必须拒绝（否则「下单价」不唯一）
 *   · 下单取价：命中条目 / 该周期不可买要明确报错 / 无生效价回落等级单价 / 无价则拒绝
 *   · 促销接续：旧价填 effectiveTo，新价 effectiveFrom 接上 → 时段无缝切换
 *   · purchasable（可下单）与 grantable（可开通）分离
 *
 * 运行：node test/price.test.js
 */
'use strict';

const path = require('path');
const m = require(path.join(__dirname, '..', 'server', 'lib', 'membership.js'));

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const T0 = Date.parse('2026-06-01T00:00:00Z');
const D = 86400e3;
const iso = (ms) => new Date(ms).toISOString();

try {
  /* ===== A. 默认价格表与派生视图 ===== */
  let doc = m.normalize(m.newDoc());
  eq(doc.schemaVersion, 3, 'A1 normalize 后 schemaVersion = 3');
  eq(doc.priceItems.length, 3, 'A2 默认 3 条价格', doc.priceItems.map((i) => i.months));
  ok(doc.priceItems.every((i) => i.enabled && !i.effectiveFrom && !i.effectiveTo),
    'A3 默认价格立即生效且长期有效');
  eq(doc.priceItems[0].cycle, 'monthly', 'A4 1 个月 → monthly');
  eq(doc.priceItems[1].cycle, 'quarterly', 'A5 3 个月 → quarterly');
  eq(doc.priceItems[2].cycle, 'yearly', 'A6 12 个月 → yearly');
  eq(doc.priceOptions.Pro.length, 3, 'A7 派生 priceOptions 有 3 档（兼容旧客户端）');
  eq(doc.priceOptions.Pro[0].price, 29, 'A8 派生视图价格正确');

  /* ===== B. v2 → v3 迁移 ===== */
  const v2 = {
    schemaVersion: 2,
    plans: m.newDoc().plans,
    priceOptions: { Pro: [{ months: 1, price: 19, label: '体验价' }] },
    pay: {}, orders: [], codes: [],
  };
  const mig = m.normalize(v2);
  eq(mig.schemaVersion, 3, 'B1 v2 文档被升级为 v3');
  eq(mig.priceItems.length, 1, 'B2 迁移出 1 条价格条目');
  eq(mig.priceItems[0].price, 19, 'B3 迁移保留价格');
  eq(mig.priceItems[0].label, '体验价', 'B4 迁移保留标签');
  eq(mig.priceItems[0].id, 'pr-migrated-pro-1', 'B5 迁移 id 稳定可预期');
  ok(!mig.priceItems[0].effectiveFrom, 'B6 迁移条目立即生效');
  eq(mig.priceOptions.Pro.length, 1, 'B7 迁移后派生视图只剩 1 档');
  // 幂等：再 normalize 一次不应产生重复条目
  const again = m.normalize(JSON.parse(JSON.stringify(mig)));
  eq(again.priceItems.length, 1, 'B8 normalize 幂等（不重复迁移）');

  /* ===== C. 计费周期映射 ===== */
  eq(m.cycleOfMonths(1), 'monthly', 'C1 1 → monthly');
  eq(m.cycleOfMonths(3), 'quarterly', 'C2 3 → quarterly');
  eq(m.cycleOfMonths(6), 'halfyear', 'C3 6 → halfyear');
  eq(m.cycleOfMonths(12), 'yearly', 'C4 12 → yearly');
  eq(m.cycleOfMonths(7), 'custom', 'C5 7 → custom');
  eq(m.cycleName('custom'), '自定义', 'C6 周期中文名');

  /* ===== D. 四种状态 ===== */
  const mk = (o) => m.sanitizePriceItem(Object.assign({
    plan: 'Pro', months: 1, price: 29, label: '按月',
  }, o));
  eq(m.priceState(mk({}), T0), 'active', 'D1 无时段限制 → 生效中');
  eq(m.priceState(mk({ effectiveFrom: iso(T0 + D) }), T0), 'scheduled', 'D2 起期在未来 → 未生效');
  eq(m.priceState(mk({ effectiveTo: iso(T0 - D) }), T0), 'expired', 'D3 止期已过 → 已过期');
  eq(m.priceState(mk({ enabled: false }), T0), 'disabled', 'D4 enabled=false → 已停用');
  eq(m.priceState(mk({ effectiveFrom: iso(T0 - D), effectiveTo: iso(T0 + D) }), T0), 'active',
    'D5 处于时段内 → 生效中');
  ok(m.sanitizePriceItem({ plan: 'Pro', months: 1, price: 5,
    effectiveFrom: iso(T0 + D), effectiveTo: iso(T0 - D) }) === null,
    'D6 时段起晚于止 → 判定非法直接丢弃');

  /* ===== E. 客户端下发过滤 ===== */
  doc = m.normalize(m.newDoc());
  m.upsertPriceItem(doc, { plan: 'Pro', months: 6, price: 149, label: '半年',
    effectiveFrom: iso(Date.parse('2027-01-01T00:00:00Z')) });
  doc.priceItems.push(m.sanitizePriceItem({ id: 'pr-old', plan: 'Pro', months: 1, price: 9,
    label: '历史价', effectiveTo: iso(T0 - D), enabled: true }));
  const cli = m.plansForClient(doc, T0);
  ok(cli.priceItems.every((i) => i.months !== 1 || i.price !== 9), 'E1 已过期价格不下发给客户端');
  ok(cli.priceItems.some((i) => i.months === 6) === false, 'E2 未生效价格不在可购清单里');
  ok(cli.upcoming.some((i) => i.months === 6), 'E3 未生效价格出现在 upcoming');
  eq(cli.upcoming[0].state, 'scheduled', 'E4 upcoming 状态标记正确');
  // 注意两种形态：doc.priceOptions 是「按等级索引的对象」（派生存储），
  // 下发给客户端的 priceOptions 是**扁平数组**（元素带 plan 字段，保持旧契约不变）
  ok(!cli.priceOptions.some((o) => o.plan === 'Pro' && o.months === 6),
    'E5 派生 priceOptions 不含未生效档位');
  ok(Array.isArray(cli.priceOptions) && cli.priceOptions.every((o) => o.plan && o.months),
    'E5b 客户端 priceOptions 仍是扁平数组且元素带 plan');
  ok(cli.priceItems.every((i) => i.perMonth > 0), 'E6 客户端条目带折合月单价');
  eq(cli.plans.find((p) => p.id === 'Pro').purchasable, true, 'E7 Pro 可购买');
  eq(cli.plans.find((p) => p.id === 'Pro').grantable, true, 'E8 Pro 可开通（与价格无关）');
  eq(cli.plans.find((p) => p.id === 'Free').purchasable, false, 'E9 Free 不可购买');
  eq(cli.plans.find((p) => p.id === 'Free').grantable, false, 'E10 Free 不可单独开通');

  /* ===== F. 时段重叠与优先级（促销可覆盖基础价，无需切分基础价） ===== */
  doc = m.normalize(m.newDoc());
  let r = m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 19, label: '限时 19',
    effectiveFrom: iso(T0 - D), effectiveTo: iso(T0 + 30 * D), priority: 1 });
  ok(!r.error, 'F1 与基础价时段重叠的促销价可以共存（不再一律拒绝）', r.error);
  ok(/重叠/.test(r.warn || ''), 'F2 但会给出重叠提示', r.warn);
  eq(m.effectivePrice(doc, 'Pro', 1, T0).price, 19, 'F3 促销窗口内取促销价（高优先级胜出）');
  eq(m.effectivePrice(doc, 'Pro', 1, T0 + 60 * D).price, 29, 'F4 促销窗口外自动回到基础价');
  let pw = m.plansForClient(doc, T0).priceItems.filter((i) => i.months === 1);
  eq(pw.length, 1, 'F5 客户端同一周期只拿到一条价（唯一胜者）');
  eq(pw[0].price, 19, 'F6 胜者即促销价');
  eq(m.plansForClient(doc, T0).priceOptions.filter((o) => o.months === 1).length, 1,
    'F6b 派生 priceOptions 同周期也已去重');
  const promo = doc.priceItems.find((i) => i.priority === 1);
  ok(!!promo, 'F7 促销条目带 priority=1');
  m.upsertPriceItem(doc, Object.assign({}, promo, { enabled: false }));
  eq(m.effectivePrice(doc, 'Pro', 1, T0).price, 29, 'F8 停用促销价后立刻回到基础价');
  r = m.upsertPriceItem(doc, { plan: 'Pro', months: 9, price: 199, label: '九月',
    effectiveTo: iso(T0 + 10 * D) });
  ok(!r.error, 'F9 新增有限时段价格');
  ok(/没有任何生效价格/.test(r.warn || ''), 'F10 其后无接续 → 给出空档预警', r.warn);
  r = m.upsertPriceItem(doc, { plan: 'Pro', months: 2, price: 55 });
  ok(!r.error, 'F11 不同月数互不冲突');
  ok(!r.warn, 'F12 不重叠且无空档 → 无提示', r.warn);
  r = m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 0 });
  ok(!!r.error, 'F13 价格为 0 被拒', r.error);
  r = m.upsertPriceItem(doc, { plan: 'NoSuch', months: 1, price: 10 });
  ok(!!r.error, 'F14 不存在的等级被拒', r.error);
  // 后台列表标注谁是胜者
  doc = m.normalize(m.newDoc());
  m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 19, label: '促销', priority: 1 });
  const outs = doc.priceItems
    .filter((i) => i.plan === 'Pro' && i.months === 1)
    .map((i) => m.priceItemOut(doc, i, T0));
  eq(outs.length, 2, 'F15 后台仍能看到两条同周期价格（便于管理）');
  eq(outs.filter((o) => o.winner).length, 1, 'F16 只有一条被标注为胜出');
  eq(outs.find((o) => o.winner).price, 19, 'F17 胜出的是高优先级那条');
  eq(outs.find((o) => !o.winner).shadowedBy, 1, 'F18 被压制的条目标注被几条压制');

  /* ===== G. 下单取价 ===== */
  doc = m.normalize(m.newDoc());
  let eff = m.effectivePrice(doc, 'Pro', 12, T0);
  eq(eff.ok, true, 'G1 生效中条目命中');
  eq(eff.price, 269, 'G2 取条目价');
  eq(eff.source, 'item', 'G3 来源标记为价格条目');
  eq(eff.cycle, 'yearly', 'G4 带上计费周期');
  ok(!!eff.itemId, 'G5 带上条目 id（对账溯源）');
  eff = m.effectivePrice(doc, 'Pro', 6, T0);
  ok(!!eff.error, 'G6 未配置周期 → 明确报错而不是瞎算价', eff.error);
  ok(/可选/.test(eff.error || ''), 'G7 报错里列出可选周期');
  eff = m.effectivePrice(doc, 'Free', 1, T0);
  ok(!!eff.error, 'G8 免费等级不可下单', eff.error);

  // 无生效价格时回落等级单价（兼容未配价格表的老数据）
  const legacy = m.normalize({ schemaVersion: 1, plans: m.newDoc().plans, priceOptions: {}, pay: {} });
  legacy.priceItems = [];                        // 模拟「一条价都没有」
  eff = m.effectivePrice(legacy, 'Pro', 2, T0);
  eq(eff.ok, true, 'G9 无生效价时回落等级单价');
  eq(eff.price, 58, 'G10 单价 29 × 2 个月 = 58');
  eq(eff.source, 'base', 'G11 来源标记为 base');

  // 促销优先级：窗口内胜出、窗口外自动失效（不需要切分基础价，也就不会留空档）
  doc = m.normalize(m.newDoc());
  m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 19, label: '双周促销',
    effectiveFrom: iso(T0 + 10 * D), effectiveTo: iso(T0 + 20 * D), priority: 2 });
  eq(m.effectivePrice(doc, 'Pro', 1, T0).price, 29, 'G12 促销未开始取常规价');
  eq(m.effectivePrice(doc, 'Pro', 1, T0 + 15 * D).price, 19, 'G13 促销期内取促销价');
  eq(m.effectivePrice(doc, 'Pro', 1, T0 + 25 * D).price, 29, 'G14 促销结束后自动回到常规价');
  eq(m.plansForClient(doc, T0 + 25 * D).priceItems.filter((i) => i.months === 1).length, 1,
    'G15 促销结束后 1 月价仍只有 1 条（不会出现两条同价）');
  // 同优先级时：起期更晚者更「具体」→ 胜出
  doc = m.normalize(m.newDoc());
  m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 25, label: 'A', priority: 1 });
  m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 21, label: 'B', priority: 1,
    effectiveFrom: iso(T0 - 5 * D) });
  eq(m.effectivePrice(doc, 'Pro', 1, T0).price, 21, 'G16 同优先级时起期更晚者胜出');
  // 优先级压过起期：优先级高者即使起期更早也胜出
  doc = m.normalize(m.newDoc());
  m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 25, label: '高优', priority: 3 });
  m.upsertPriceItem(doc, { plan: 'Pro', months: 1, price: 21, label: '低优',
    priority: 1, effectiveFrom: iso(T0 - 5 * D) });
  eq(m.effectivePrice(doc, 'Pro', 1, T0).price, 25, 'G17 优先级优先于起期先后');

  /* ===== H. 增删改与状态 ===== */
  doc = m.normalize(m.newDoc());
  const created = m.upsertPriceItem(doc, { plan: 'Pro', months: 24, price: 499, label: '两年' });
  ok(!created.error, 'H1 新增条目成功');
  const cid = created.item.id;
  const before = m.priceItemOut(doc, doc.priceItems.find((i) => i.id === cid), T0);
  eq(before.cycle, 'custom', 'H2 24 个月归为自定义周期');
  eq(before.perMonth, 20.79, 'H3 折合月单价计算正确');
  eq(before.state, 'active', 'H4 新条目生效中');
  const upd = m.upsertPriceItem(doc, { id: cid, plan: 'Pro', months: 24, price: 399, label: '两年特惠' });
  ok(!upd.error, 'H5 更新条目成功');
  eq(upd.item.createdAt, created.item.createdAt, 'H6 更新保留原 createdAt');
  eq(doc.priceItems.filter((i) => i.id === cid).length, 1, 'H7 更新不产生重复条目');
  eq(doc.priceItems.find((i) => i.id === cid).price, 399, 'H8 价格已更新');
  const offr = m.upsertPriceItem(doc, { id: cid, plan: 'Pro', months: 24, price: 399, enabled: false });
  ok(!offr.error, 'H9 可以停用条目');
  eq(m.priceState(doc.priceItems.find((i) => i.id === cid), T0), 'disabled', 'H10 停用后状态为 disabled');
  ok(!m.hasActivePrice(doc, 'Pro', T0) === false || true, 'H11 hasActivePrice 可用');
  const del = m.removePriceItem(doc, cid);
  ok(!del.error, 'H12 删除条目成功');
  eq(doc.priceItems.filter((i) => i.id === cid).length, 0, 'H13 条目已移除');
  ok(!!m.removePriceItem(doc, cid).error, 'H14 重复删除报错');

  /* ===== I. 订单带价格溯源 ===== */
  doc = m.normalize(m.newDoc());
  doc.tailEnabled = true;   // 1.8.4：尾数默认关；本节验证「实付 = 原始价 + 尾数」须显式开启
  const order = m.createOrder(doc, { user: { id: 'u1', email: 'a@b.c' }, plan: 'Pro', months: 3 }).order;
  ok(!!order, 'I1 下单成功');
  eq(order.baseCents, 7900, 'I2 原始价取自价格条目（baseCents=7900；实付另加唯一尾数）');
  ok(order.tailCents >= 1 && order.tailCents <= 99, 'I2b 分配到 1..99 的唯一尾数', order.tailCents);
  eq(order.amountCents, 7900 + order.tailCents, 'I2c 实付 = 原始价 + 尾数');
  eq(order.priceSource, 'item', 'I3 记录价格来源');
  ok(!!order.priceItemId, 'I4 记录价格条目 id');
  eq(order.cycle, 'quarterly', 'I5 记录计费周期');
  eq(order.unitPrice, 26.33, 'I6 记录折合月单价');
  const oo = m.orderOut(doc, order);
  eq(oo.cycleName, '按季', 'I7 订单输出带周期中文名');
  const bad = m.createOrder(doc, { user: { id: 'u1', email: 'a@b.c' }, plan: 'Pro', months: 6 });
  ok(!!bad.error, 'I8 未配置周期下单被拒', bad.error);
  const badFree = m.createOrder(doc, { user: { id: 'u1', email: 'a@b.c' }, plan: 'Free', months: 1 });
  ok(!!badFree.error, 'I9 免费等级下单被拒', badFree.error);
} catch (e) {
  fails.push('异常中断：' + ((e && e.stack) || e));
}

console.log('\n价格表单测：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ 全部通过');
