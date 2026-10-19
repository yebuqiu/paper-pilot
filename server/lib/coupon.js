// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

'use strict';
/**
 * 优惠券 / 折扣码（服务端 1.4.6）
 *
 * 与「激活码」的分工（**别混用**）：
 *   · 激活码（codes）= **直接发会员**（免费开通/续期），不产生订单、不涉及收款；
 *   · 优惠券（coupons）= **只打折**，仍然走完整下单 → 收款 → 核销流程，
 *     只是把应付金额降下来。想免费送，用激活码；想让人掏钱但少掏点，用优惠券。
 *
 * 数据落在 membership.json 的 `coupons` 数组（与 orders 同一份文档）——
 * 因为订单的核销/取消/超时都要联动释放券的占用，放在一起才能保证事务边界清晰。
 *
 *   {
 *     id, code,                       // CP-XXXX-XXXX-XXXX
 *     type: 'percent' | 'amount',
 *     percent,                        // percent 型：减免百分比（15 = 减 15% = 85 折）
 *     amountCents,                    // amount 型：固定减免（分）
 *     plans: [],                      // 适用等级（空 = 全部可购等级）
 *     minAmountCents,                 // 门槛（折前金额需 ≥ 此值，0 = 无门槛）
 *     maxUses,                        // 可用总次数（0 = 不限）
 *     perUser,                        // 每人可用次数（0 = 不限，默认 1）
 *     effectiveFrom, effectiveTo,     // ISO 或 null（null = 立即生效 / 长期有效）
 *     enabled, note, createdAt, createdBy,
 *     uses: [{ orderId, userId, email, at, discountCents, state }]
 *   }
 *
 * ★ 三个刻意的设计决定，改动前请先读：
 *
 * 1) **占用（reserve）→ 核销（consume）/ 释放（release），而不是「下单即消耗」。**
 *    用户在插件里下单只是「占住一次名额」；订单超时回收、用户取消、管理员取消都会
 *    **释放**名额；只有核销（fulfill）才真正消耗。否则用户随便点几下就能把限量券耗光。
 *
 * 2) **折后至少要留 ¥1（MIN_PAYABLE_CENTS）。** 因为实付金额 = 折后价 + 唯一对账尾数
 *    （见 membership.assignTail）。若允许折到 0，就既能绕过对账机制、又与「激活码免费开通」
 *    的语义重叠。所以 100% 减免一律拒绝 —— 要免费请发激活码。
 *
 * 3) **下单后不再复核券的状态。** 券被停用/额度改小/过期，**不影响已下的单**
 *    （那些单已经在 uses 里占了名额）。否则用户付完钱、券被管理员停掉，订单却核销不了。
 *
 * 纯函数、无 IO —— 持久化由 account-server 的 JsonStore 负责，便于单测。
 */

const crypto = require('crypto');

const CODE_PREFIX = 'CP';
/** 与激活码同一字母表：剔除 0 O 1 I L，避免人工转录看错 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const MIN_PAYABLE_CENTS = 100;      // 折后至少 ¥1
const MAX_PERCENT = 99;             // 不允许 100%（等于白送，请用激活码）
const MAX_AMOUNT_CENTS = 10000000;  // 单券固定减免上限 ¥100000
const MAX_USES_HARD_CAP = 100000;
const PER_USER_HARD_CAP = 1000;
const MAX_BATCH = 200;              // 一次最多生成多少枚
const MAX_PLANS = 8;

const TYPE_TEXT = { percent: '按比例减免', amount: '固定金额减免' };
const STATE_TEXT = {
  active: '生效中', scheduled: '未生效', expired: '已过期',
  disabled: '已停用', exhausted: '已用尽', invalid: '配置异常',
};

/* ---------------- 基础 ---------------- */

function rid(prefix, bytes) {
  return prefix + '-' + crypto.randomBytes(bytes || 6).toString('hex');
}

function isoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function int(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
}

function pickChar() {
  return CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
}

function newCode() {
  const block = () => pickChar() + pickChar() + pickChar() + pickChar();
  return CODE_PREFIX + '-' + block() + '-' + block() + '-' + block();
}

/** 优惠码归一：去空白与大小写、接受带或不带分隔符 */
function normCode(c) {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 14 || !s.startsWith(CODE_PREFIX)) return '';
  return CODE_PREFIX + '-' + s.slice(2, 6) + '-' + s.slice(6, 10) + '-' + s.slice(10, 14);
}

/* ---------------- 规范化 ---------------- */

/**
 * 把任意输入规范成一条合法优惠券；配置非法返回 null（由调用方报错）。
 * 已有券走 「updateCoupon」局部更新，这里只用于新建。
 */
function sanitizeCoupon(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const type = r.type === 'amount' ? 'amount' : 'percent';
  // ★ 金额相关字段**越界一律拒绝**，不做静默夹取 —— 把 150% 悄悄变成 99% 比报错危险得多
  const percentRaw = int(r.percent, 0);
  const amountRaw = int(r.amountCents, 0);
  if (type === 'percent' && !(percentRaw >= 1 && percentRaw <= MAX_PERCENT)) return null;
  if (type === 'amount' && !(amountRaw >= 1 && amountRaw <= MAX_AMOUNT_CENTS)) return null;
  const percent = type === 'percent' ? percentRaw : 0;
  const amountCents = type === 'amount' ? amountRaw : 0;

  const from = isoOrNull(r.effectiveFrom);
  const to = isoOrNull(r.effectiveTo);
  if (from && to && Date.parse(from) >= Date.parse(to)) return null;

  const plans = Array.isArray(r.plans)
    ? r.plans.map((p) => String(p || '').trim()).filter(Boolean).slice(0, MAX_PLANS)
    : [];

  const code = normCode(r.code) || newCode();
  return {
    id: String(r.id || '') || rid('cp', 6),
    code,
    type, percent, amountCents,
    plans,
    minAmountCents: Math.max(0, Math.min(MAX_AMOUNT_CENTS, int(r.minAmountCents, 0))),
    maxUses: Math.max(0, Math.min(MAX_USES_HARD_CAP, int(r.maxUses, 0))),
    perUser: Math.max(0, Math.min(PER_USER_HARD_CAP, int(r.perUser, 1))),
    effectiveFrom: from, effectiveTo: to,
    enabled: r.enabled === false ? false : true,
    note: String(r.note || '').slice(0, 80),
    createdAt: isoOrNull(r.createdAt) || new Date().toISOString(),
    createdBy: String(r.createdBy || 'admin').slice(0, 40),
    uses: Array.isArray(r.uses) ? r.uses : [],
  };
}

/* ---------------- 占用统计 ---------------- */

/** 未释放的占用（reserved + used）—— 这些才计入额度与「每人限用」 */
function activeUses(c) {
  return (c && Array.isArray(c.uses) ? c.uses : []).filter((u) => u && u.state !== 'released');
}

function usedCount(c) {
  return activeUses(c).length;
}

function usedByUser(c, userId) {
  if (!userId) return 0;
  return activeUses(c).filter((u) => u && u.userId === userId).length;
}

/**
 * 券状态。`invalid` 只在数据被手改坏时出现（例如 percent 越界）。
 * 判据顺序很重要：停用 > 配置异常 > 未生效 > 已过期 > 用尽 > 生效中。
 */
function stateOf(c, now) {
  if (!c) return 'invalid';
  const t = Number.isFinite(now) ? now : Date.now();
  if (c.enabled === false) return 'disabled';
  if (c.type === 'percent' && !(c.percent >= 1 && c.percent <= MAX_PERCENT)) return 'invalid';
  if (c.type === 'amount' && !(c.amountCents >= 1)) return 'invalid';
  if (c.effectiveFrom && t < Date.parse(c.effectiveFrom)) return 'scheduled';
  if (c.effectiveTo && t >= Date.parse(c.effectiveTo)) return 'expired';
  if (Number(c.maxUses) > 0 && usedCount(c) >= Number(c.maxUses)) return 'exhausted';
  return 'active';
}

function stateTextOf(st) {
  return STATE_TEXT[st] || st;
}

/** 人类可读文案：「减 15%（85 折）」「减 ¥20」 */
function labelOf(c) {
  if (!c) return '';
  const scope = Array.isArray(c.plans) && c.plans.length ? c.plans.join('/') + ' 专用' : '全场通用';
  const thr = Number(c.minAmountCents) > 0 ? '满 ¥' + (c.minAmountCents / 100).toFixed(2) : '';
  const body = c.type === 'percent'
    ? '减 ' + c.percent + '%（' + (Math.round((100 - c.percent) * 100) / 100) + ' 折）'
    : '减 ¥' + (Number(c.amountCents) / 100).toFixed(2);
  return [body, thr, scope].filter(Boolean).join(' · ');
}

/** 折扣额（分）。按比例用四舍五入到分；并保证折后不少于 MIN_PAYABLE_CENTS。 */
function computeDiscount(c, baseCents) {
  const base = Math.max(0, int(baseCents, 0));
  if (!c || base <= 0) return 0;
  const raw = c.type === 'percent'
    ? Math.round((base * Math.min(MAX_PERCENT, Math.max(1, Number(c.percent) || 0))) / 100)
    : Math.max(1, Number(c.amountCents) || 0);
  const cap = base - MIN_PAYABLE_CENTS;   // 折后至少留 ¥1
  return Math.max(0, Math.min(raw, cap));
}

/* ---------------- 校验与报价 ---------------- */

function findByCode(doc, code) {
  const want = normCode(code);
  if (!want) return null;
  return (doc.coupons || []).find((c) => c && normCode(c.code) === want) || null;
}

function findById(doc, id) {
  return (doc.coupons || []).find((c) => c && c.id === id) || null;
}

/**
 * 报价（唯一取价口径，下单与「试算」共用）。
 * baseCents 必须是**折前**金额（价格条目价）。返回：
 *   { ok:true, coupon, discountCents, payableCents, type, label }
 * 或 { ok:false, error }
 */
function quote(doc, opts) {
  const o = opts || {};
  const t = Number.isFinite(o.now) ? o.now : Date.now();
  const code = normCode(o.code);
  if (!code) return { ok: false, error: '优惠码格式不对（应为 CP-XXXX-XXXX-XXXX）' };
  const c = findByCode(doc, code);
  if (!c) return { ok: false, error: '优惠码不存在或已失效' };

  const st = stateOf(c, t);
  if (st !== 'active') {
    const extra = st === 'scheduled'
      ? '（' + String(c.effectiveFrom).slice(0, 10) + ' 起生效）'
      : st === 'expired'
        ? '（已于 ' + String(c.effectiveTo).slice(0, 10) + ' 截止）'
        : st === 'exhausted' ? '（名额已用完）' : '';
    return { ok: false, error: '优惠码当前不可用：' + stateTextOf(st) + extra };
  }

  const base = Math.max(0, int(o.baseCents, 0));
  if (base <= 0) return { ok: false, error: '订单金额异常，无法使用优惠码' };

  if (Array.isArray(c.plans) && c.plans.length && o.plan && c.plans.indexOf(String(o.plan)) < 0) {
    return { ok: false, error: '该优惠码仅适用于：' + c.plans.join(' / ') };
  }
  if (Number(c.minAmountCents) > 0 && base < Number(c.minAmountCents)) {
    return { ok: false, error: '该优惠码需满 ¥' + (Number(c.minAmountCents) / 100).toFixed(2)
      + '，本单折前 ¥' + (base / 100).toFixed(2) + '，未达门槛' };
  }
  if (Number(c.perUser) > 0 && o.userId && usedByUser(c, o.userId) >= Number(c.perUser)) {
    return { ok: false, error: '该优惠码你已使用过 ' + usedByUser(c, o.userId) + ' 次（每人限 '
      + Number(c.perUser) + ' 次）' };
  }
  if (base <= MIN_PAYABLE_CENTS) {
    return { ok: false, error: '本单折前金额过低（≤ ¥1），无法再打折' };
  }

  const discountCents = computeDiscount(c, base);
  if (discountCents <= 0) return { ok: false, error: '该优惠码对本单没有减免' };
  return {
    ok: true, coupon: c, discountCents,
    payableCents: base - discountCents,
    type: c.type, label: labelOf(c),
  };
}

/* ---------------- 占用 / 释放 ---------------- */

/** 占住一次名额（下单时调用；orderId 必须已经生成） */
function reserveUse(c, use) {
  if (!c) return null;
  if (!Array.isArray(c.uses)) c.uses = [];
  const u = {
    orderId: String((use && use.orderId) || ''),
    userId: String((use && use.userId) || ''),
    email: String((use && use.email) || ''),
    at: new Date(Number.isFinite(use && use.now) ? use.now : Date.now()).toISOString(),
    discountCents: Math.max(0, int(use && use.discountCents, 0)),
    state: 'reserved',
  };
  c.uses.push(u);
  return u;
}

/** 按订单号把占用改成终态（used / released）。幂等。 */
function setUseStateByOrder(doc, orderId, state) {
  const oid = String(orderId || '');
  if (!oid) return false;
  let hit = false;
  for (const c of (doc.coupons || [])) {
    for (const u of (c.uses || [])) {
      if (u && u.orderId === oid && u.state !== state) {
        u.state = state;
        u.at2 = new Date().toISOString();
        hit = true;
      }
    }
  }
  return hit;
}

const consumeUseByOrder = (doc, orderId) => setUseStateByOrder(doc, orderId, 'used');
const releaseUseByOrder = (doc, orderId) => setUseStateByOrder(doc, orderId, 'released');

/* ---------------- 视图 ---------------- */

/** 后台视图：含状态、用量、剩余名额 */
function couponOut(c, now) {
  const st = stateOf(c, now);
  const active = activeUses(c);
  const max = Number(c.maxUses) || 0;
  return {
    id: c.id, code: c.code,
    type: c.type, typeText: TYPE_TEXT[c.type] || c.type,
    percent: c.type === 'percent' ? Number(c.percent) : null,
    amountCents: c.type === 'amount' ? Number(c.amountCents) : null,
    discountText: c.type === 'percent'
      ? '减 ' + c.percent + '%'
      : '减 ¥' + (Number(c.amountCents) / 100).toFixed(2),
    label: labelOf(c),
    plans: Array.isArray(c.plans) ? c.plans : [],
    minAmountCents: Number(c.minAmountCents) || 0,
    maxUses: max, perUser: Number(c.perUser) || 0,
    usedCount: active.length,
    usedReserved: active.filter((u) => u.state === 'reserved').length,
    usedDone: active.filter((u) => u.state === 'used').length,
    remaining: max > 0 ? Math.max(0, max - active.length) : null,
    effectiveFrom: c.effectiveFrom || null, effectiveTo: c.effectiveTo || null,
    enabled: c.enabled !== false, note: c.note || '',
    createdAt: c.createdAt, createdBy: c.createdBy || '',
    state: st, stateText: stateTextOf(st),
    // 使用明细（后台可查，含邮箱便于对账）
    uses: active.slice(-50).map((u) => ({
      orderId: u.orderId, email: u.email || '', at: u.at,
      discountCents: u.discountCents || 0, state: u.state,
    })),
  };
}

/** 客户端视图：只给「这张券长什么样」，**不含用量与使用人** */
function couponPublicOut(c) {
  return {
    code: c.code, type: c.type,
    percent: c.type === 'percent' ? Number(c.percent) : null,
    amountCents: c.type === 'amount' ? Number(c.amountCents) : null,
    plans: Array.isArray(c.plans) ? c.plans : [],
    minAmountCents: Number(c.minAmountCents) || 0,
    effectiveTo: c.effectiveTo || null,
    label: labelOf(c),
  };
}

/* ---------------- 批量生成 ---------------- */

/** 生成 count 枚互不重复的券（同参数），返回数组 */
function createCoupons(doc, input) {
  const cnt = Math.max(1, Math.min(MAX_BATCH, int(input && input.count, 1)));
  if (!Array.isArray(doc.coupons)) doc.coupons = [];
  // ★ 先拿一张试校验（参数非法就地报错），**再**批量落盘 ——
  //   否则非法参数会让「循环里前几枚已经 push 进 doc」的半成品留在库里
  const probe = sanitizeCoupon(Object.assign({}, input, { code: newCode(), id: null }));
  if (!probe) {
    return { error: (input && input.type === 'amount')
      ? '固定减免金额必须在 0.01..' + (MAX_AMOUNT_CENTS / 100) + ' 元之间'
      : '折扣百分比必须在 1..' + MAX_PERCENT + ' 之间（100% 减免请改用激活码）' };
  }
  const taken = new Set(doc.coupons.map((c) => normCode(c.code)));
  const out = [];
  for (let i = 0; i < cnt; i++) {
    let code = newCode();
    let guard = 0;
    while (taken.has(code) && guard++ < 50) code = newCode();
    taken.add(code);
    const c = sanitizeCoupon(Object.assign({}, input, { code, id: null }));
    doc.coupons.push(c);
    out.push(c);
  }
  return { coupons: out };
}

/** 局部更新（只覆盖显式提交的字段；createdAt/uses 永不改） */
function updateCoupon(doc, id, patch) {
  const c = findById(doc, id);
  if (!c) return { error: '优惠券不存在' };
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.enabled !== undefined) c.enabled = !!p.enabled;
  if (p.note !== undefined) c.note = String(p.note).slice(0, 80);
  if (p.maxUses !== undefined) c.maxUses = Math.max(0, Math.min(MAX_USES_HARD_CAP, int(p.maxUses, c.maxUses)));
  if (p.perUser !== undefined) c.perUser = Math.max(0, Math.min(PER_USER_HARD_CAP, int(p.perUser, c.perUser)));
  if (p.minAmountCents !== undefined) c.minAmountCents = Math.max(0, int(p.minAmountCents, c.minAmountCents));
  if (p.effectiveFrom !== undefined) c.effectiveFrom = isoOrNull(p.effectiveFrom);
  if (p.effectiveTo !== undefined) c.effectiveTo = isoOrNull(p.effectiveTo);
  if (p.percent !== undefined && c.type === 'percent') {
    const v = int(p.percent, 0);
    if (!(v >= 1 && v <= MAX_PERCENT)) return { error: '折扣百分比必须在 1..' + MAX_PERCENT + ' 之间' };
    c.percent = v;
  }
  if (p.amountCents !== undefined && c.type === 'amount') {
    const v = int(p.amountCents, 0);
    if (!(v >= 1 && v <= MAX_AMOUNT_CENTS)) return { error: '固定减免金额必须在 0.01..' + (MAX_AMOUNT_CENTS / 100) + ' 元之间' };
    c.amountCents = v;
  }
  if (Array.isArray(p.plans)) {
    c.plans = p.plans.map((x) => String(x || '').trim()).filter(Boolean).slice(0, MAX_PLANS);
  }
  if (c.effectiveFrom && c.effectiveTo && Date.parse(c.effectiveFrom) >= Date.parse(c.effectiveTo)) {
    return { error: '生效起始必须早于截止时间' };
  }
  return { coupon: c };
}

/**
 * 删除（作废）。已经有人占用的券**不允许删除** —— 那些占用挂在待核销订单上，
 * 删掉会让订单的折扣来源凭空消失（对账时对不上）。这种情况请改用「停用」。
 */
function removeCoupon(doc, id) {
  const idx = (doc.coupons || []).findIndex((c) => c && c.id === id);
  if (idx < 0) return { error: '优惠券不存在' };
  if (activeUses(doc.coupons[idx]).length > 0) {
    return { error: '该券已被使用/占用，不能删除（保留对账记录）。如需停发请改为「停用」。' };
  }
  const [removed] = doc.coupons.splice(idx, 1);
  return { coupon: removed };
}

module.exports = {
  CODE_PREFIX, MIN_PAYABLE_CENTS, MAX_PERCENT, MAX_BATCH,
  TYPE_TEXT, STATE_TEXT,
  newCode, normCode, rid,
  sanitizeCoupon, stateOf, stateTextOf, labelOf, computeDiscount,
  activeUses, usedCount, usedByUser,
  findByCode, findById, quote,
  reserveUse, setUseStateByOrder, consumeUseByOrder, releaseUseByOrder,
  couponOut, couponPublicOut,
  createCoupons, updateCoupon, removeCoupon,
};
