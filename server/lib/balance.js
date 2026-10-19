// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 账号后台 · 余额域（服务端 1.6.0，配合插件 0.26.x）
 *
 * 职责：AI 额度余额 —— 注册赠送 / 充值 / 消耗 / 流水。
 * 数据落在 user.balance（users.json，随既有快照/回滚体系走，无需新文件）：
 *   {
 *     grantedMicro: n,       // 赠送余额（微元）——注册礼包；有有效期
 *     grantedExpiresAt: ISO, // 赠送额度过期时间（null = 不过期，不建议）
 *     paidMicro: n,          // 充值余额（微元）——**永不过期**；管理员充值/调账也进这里
 *     heldMicro: n,          // 进行中请求的**预占**总额（微元，恒等于 holds 之和）
 *     holds: [ { id, micro, at, highTier } ],   // 预占明细（最多 HOLDS_MAX 条）
 *     ledger: [ ... ]        // 最近 BALANCE_LEDGER_KEEP 条流水
 *   }
 *
 * ★ 铁律一：**钱不过期，赠品才过期**。paidMicro 永远不设有效期——
 *   「充的钱还会作废」既是口碑雷也是纠纷源。赠送额度过期只是"不可再用"，不追回已消耗部分。
 *
 * ★ 铁律二：**消耗永远如实记账，允许透支**。pre-check（能否发起新请求）与
 *   实际扣减（响应结束才知道成本）之间存在并发窗口：同账号并发 N 个请求时，
 *   全部可能通过 pre-check。此时余额可能为负——流水必须如实记录，
 *   由下一次 pre-check 拦截后续请求。绝不能"扣不到就当 0"。
 *
 * ★ 铁律二补充（1.8.6 审查 P1-3）：**发出请求前先「预占」额度**。
 *   pre-check 只读余额，N 个并发请求会同时通过，结束后各自扣费 → 余额被透支。
 *   因此网关在放行后先 hold() 预占一笔估算额（只占 availableMicro，不动真实余额），
 *   响应结束后 settleHold() 按**实际成本**结算（移除预占 + 走原有扣减顺序，仍允许透支），
 *   任何不扣费的出口（客户端断开 / 上游 4xx5xx / 超时 / 写响应失败）必须 releaseHold()。
 *   预占只是"并发阀门"，不是账：它不进流水、不影响 totalMicro/paidMicro，
 *   且 5 分钟后由 sweep() 自动释放（防客户端或进程异常导致永久占款）。
 *
 * ★ 铁律三：**高级模型不吃赠送额度**（用户决策：赠送限基础模型）。
 *   highTier 模型的消耗只从 paidMicro 扣；赠送额度只能用于基础模型。
 *
 * 计费单位沿用 pricing.js 的「微元」（1e-6 元）整数口径，两模块零换算。
 *
 * 配置（pricing.json 顶层 balance 块，normalizeCfg 维护）：
 *   {
 *     signupGrantMicro: 6000000,  // 注册赠送 ¥6；0 = 关闭
 *     signupValidDays: 30,        // 赠送有效期（天）；0 = 不过期（不建议）
 *     enforce: true,             // ★ 余额不足是否拦截。1.8.0 起默认开启：
 *                                //   取消「赠送调用次数」后余额是**唯一**阀门，
 *                                //   关掉就等于无限免费用。关闭仅用于观察/压测。
 *     minBalanceMicro: 0         // 拦截阈值：可用余额 ≤ 此值（或 ≤ 0）拒绝新请求
 *   }
 */
'use strict';

const pricing = require('./pricing');

/** 流水保留条数（每账号；users.json 是全量读写的 JSON，不能无限长） */
const LEDGER_KEEP = 50;

/**
 * 预占（hold）上限：
 *   HOLDS_MAX    —— 每账号同时进行中的请求数上限。超出即拒（宁可 402，
 *                   也不静默丢弃旧预占——那等于把别人的钱偷偷放回去）。
 *   HOLD_TTL_MS  —— 预占最长存活 5 分钟。正常请求远短于此；超时即视为
 *                   客户端/进程异常，由 sweep() 自动释放，防止永久占款。
 */
const HOLDS_MAX = 8;
const HOLD_TTL_MS = 5 * 60 * 1000;

/** 充值档位默认值：到账额度 creditCents ≥ 付款 cents（差额即「充值赠送」） */
const DEFAULT_RECHARGE_OPTIONS = [
  { id: 'rc10', cents: 1000, creditCents: 1000, label: '¥10', enabled: true },
  { id: 'rc30', cents: 3000, creditCents: 3300, label: '¥30 · 到账 ¥33', enabled: true },
  { id: 'rc100', cents: 10000, creditCents: 11500, label: '¥100 · 到账 ¥115', enabled: true },
];

const DEFAULT_CFG = {
  signupGrantMicro: 6 * pricing.MICRO_PER_YUAN,   // ¥6
  signupValidDays: 30,
  enforce: true,        // 1.8.0：没有次数上限了，余额必须真正拦截
  minBalanceMicro: 0,
  rechargeOptions: DEFAULT_RECHARGE_OPTIONS,
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function newCfg() { return clone(DEFAULT_CFG); }

/** 非负整数微元 */
function micro(v, dft) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : dft;
}

/** 有符号整数微元（调账允许负数） */
function signedMicro(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}

/** 充值档位消毒：id 唯一、金额 > 0、到账 ≥ 付款（不允许「充得多到得少」） */
function sanitizeRechargeOptions(raw) {
  if (!Array.isArray(raw)) return clone(DEFAULT_RECHARGE_OPTIONS);
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const id = String(o.id || '').trim().slice(0, 24);
    const cents = Math.round(Number(o.cents) || 0);
    const creditCents = Math.round(Number(o.creditCents) || cents);
    if (!id || seen.has(id) || cents <= 0) continue;
    if (creditCents < cents) continue;
    seen.add(id);
    out.push({ id, cents, creditCents, label: String(o.label || '').slice(0, 40), enabled: o.enabled !== false });
  }
  return out.length ? out : clone(DEFAULT_RECHARGE_OPTIONS);
}

/**
 * 规范化 pricing 文档的 balance 配置块（幂等）。
 * @param {object} pricingDoc pricing.json 文档（原位修改）
 */
function normalizeCfg(pricingDoc) {
  if (!pricingDoc || typeof pricingDoc !== 'object') return clone(DEFAULT_CFG);
  const raw = pricingDoc.balance && typeof pricingDoc.balance === 'object'
    ? pricingDoc.balance : {};
  // ★ 1.8.7 审查：enforce 缺省必须**回落默认值（true）**，不能等价于 false。
  //   原实现 `raw.enforce === true` 在字段缺失（老数据 / 只改单价的 PUT / 损坏后重建）
  //   时会静默变成「观察模式」→ 余额不足不再拦截，等于把付费阀门整个关掉（fail-open）。
  //   显式写 false 仍然生效（运维需要观察模式时是可用的），只是「没写」不再等于关闭。
  const svdRaw = Number(raw.signupValidDays);
  const svd = Number.isFinite(svdRaw) ? Math.max(0, Math.round(svdRaw)) : NaN;
  const cfg = {
    signupGrantMicro: micro(raw.signupGrantMicro, DEFAULT_CFG.signupGrantMicro),
    // 0 是合法值（= 不过期），原 `|| 30` 会让它永远配不出来
    signupValidDays: Number.isFinite(svd) ? svd : DEFAULT_CFG.signupValidDays,
    enforce: raw.enforce === undefined ? DEFAULT_CFG.enforce : raw.enforce === true,
    minBalanceMicro: micro(raw.minBalanceMicro, 0),
    rechargeOptions: sanitizeRechargeOptions(raw.rechargeOptions),
  };
  pricingDoc.balance = cfg;
  return cfg;
}

function cfgOf(pricingDoc) {
  return normalizeCfg(pricingDoc);
}

/* ---------------- 用户余额对象 ---------------- */

/**
 * 预占明细消毒（幂等）：
 *   - 非法项（无 id / micro ≤ 0 / at 非数字）丢弃；
 *   - id 重复只留最后一条（同一 id 重复 append 说明上游写坏了）；
 *   - 裁剪到最近 HOLDS_MAX 条。
 */
function sanitizeHolds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const h of raw) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    const id = String(h.id == null ? '' : h.id).slice(0, 64);
    const amount = micro(h.micro, 0);
    const at = Math.round(Number(h.at));
    if (!id || seen.has(id) || !(amount > 0) || !Number.isFinite(at) || at <= 0) continue;
    seen.add(id);
    out.push({ id, micro: amount, at, highTier: h.highTier === true });
  }
  return out.slice(-HOLDS_MAX);
}

/** 预占总额 = 明细之和（唯一口径，杜绝 heldMicro 与 holds 对不上） */
function heldTotal(holds) {
  let sum = 0;
  for (const h of holds) sum += micro(h.micro, 0);
  return sum;
}

/** 确保余额结构存在（幂等；老账号现场补，零迁移） */
function ensure(user) {
  if (!user.balance || typeof user.balance !== 'object' || Array.isArray(user.balance)) {
    user.balance = {};
  }
  const b = user.balance;
  b.grantedMicro = micro(b.grantedMicro, 0);   // 注册赠送：非负（过期由 sweep 清零）
  b.planMicro = micro(b.planMicro, 0);         // 订阅额度：非负（换期由 sweep/发放重置）
  b.planExpiresAt = b.planExpiresAt || null;
  b.planPeriodKey = b.planPeriodKey || null;
  // ★ 充值余额允许为负（并发窗口下的透支）：绝不能在读取路径上被"消毒"成 0——
  //   那会让欠费凭空消失、看板失真、透支用户继续畅通无阻。
  b.paidMicro = signedMicro(b.paidMicro);
  b.grantedExpiresAt = b.grantedExpiresAt || null;
  if (!Array.isArray(b.ledger)) b.ledger = [];
  // ★ 预占：heldMicro 一律由 holds 之和重算（天然 ≥ 0）。
  //   只做 clamp 修不了「明细已丢、总额还在」的脏数据——那会让可用余额凭空变少
  //   且永远无法自愈（sweep 是按明细里的 at 逐条过期的）。
  b.holds = sanitizeHolds(b.holds);
  b.heldMicro = heldTotal(b.holds);
  return b;
}

/** 到期即清零（幂等；只在被触到的用户上惰性执行，不做全表扫描） */
function sweep(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (b.grantedMicro > 0 && b.grantedExpiresAt && t >= Date.parse(b.grantedExpiresAt)) {
    push(b, {
      delta: -b.grantedMicro, kind: 'grant-expire',
      reason: '注册赠送额度到期回收', grantedAfter: 0, planAfter: b.planMicro, paidAfter: b.paidMicro,
    });
    b.grantedMicro = 0;
  }
  // 订阅额度：不结转 —— 过了当期就作废（这是"订阅"与"充值"的本质区别）
  if (b.planMicro > 0 && b.planExpiresAt && t >= Date.parse(b.planExpiresAt)) {
    push(b, {
      delta: -b.planMicro, kind: 'plan-expire',
      reason: '订阅额度到期回收（不结转）', grantedAfter: b.grantedMicro, planAfter: 0, paidAfter: b.paidMicro,
    });
    b.planMicro = 0;
  }
  // ★ 预占超时释放（P1-3）：正常请求远短于 5 分钟；留下的都是客户端/进程异常。
  //   不释放就会永久占款——用户余额还在，可用额度却永远为 0，且无法自愈。
  if (Array.isArray(b.holds) && b.holds.length) {
    const keep = [];
    for (const h of b.holds) {
      // at 在未来（时钟回拨 / 跨进程写入）时 t - at 为负，不算过期
      if (h && Number.isFinite(h.at) && t - h.at > HOLD_TTL_MS) continue;
      keep.push(h);
    }
    if (keep.length !== b.holds.length) {
      b.holds = keep;
      b.heldMicro = heldTotal(keep);
    }
  }
  return b;
}

function push(b, entry) {
  b.ledger.push(Object.assign({ at: new Date().toISOString(), refId: '' }, entry));
  if (b.ledger.length > LEDGER_KEEP) b.ledger.splice(0, b.ledger.length - LEDGER_KEEP);
  return b;
}

/**
 * 1.8.5（审查 P0-3）：这笔外部单据是否已经入过账。
 * 订单履约改成「先入账、后置订单状态」后，崩溃窗口会留下「钱到了、单还 pending」；
 * 网关重试时靠这个判据避免二次入账。只认 recharge + refId 精确匹配。
 * 注意：流水只保留 LEDGER_KEEP(50) 条，极端高频下早期记录可能已滚出——届时改用订单侧
 * 幂等字段（见 P2-11 的流水扩容建议），但那已超出「崩溃后立刻重试」的窗口。
 */
function hasRef(user, refId, kind) {
  const b = user && user.balance;
  const list = b && Array.isArray(b.ledger) ? b.ledger : [];
  const k = String(kind || 'recharge');
  const id = String(refId || '');
  if (!id) return false;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.kind === k && String(e.refId || '') === id) return true;
  }
  return false;
}

/** 注册赠送部分当前可用（过期 = 0） */function grantedAvailable(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (!b.grantedExpiresAt) return b.grantedMicro;
  return t >= Date.parse(b.grantedExpiresAt) ? 0 : b.grantedMicro;
}

/** 订阅额度当前可用（当期有效，不结转） */
function planAvailable(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (!b.planExpiresAt) return b.planMicro;
  return t >= Date.parse(b.planExpiresAt) ? 0 : b.planMicro;
}

/** 可用总额 = 未过期赠送 + 当期订阅额度 + 充值 */
function totalMicro(b, now) {
  return grantedAvailable(b, now) + planAvailable(b, now) + b.paidMicro;
}

/**
 * 可用于该类模型的额度（铁律三：注册赠送只限基础模型）。
 *   高级模型：订阅额度 + 充值（订阅本来就是为了开高级模型，不能用反）
 *   基础模型：三者皆可
 */
function payableMicro(b, { highTier } = {}, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return highTier ? (planAvailable(b, t) + b.paidMicro) : totalMicro(b, t);
}

/**
 * **可用**额度 = payableMicro − 进行中请求的预占（heldMicro），下限 0。
 *
 * 与 payableMicro 的分工：payableMicro 是「账上有多少钱」（用于展示/结算），
 * availableMicro 是「现在还能开多少新请求」（用于并发阀门）。两者只差预占部分，
 * 因此 viewOf 同时下发，前端零回归。
 */
function availableMicro(b, { highTier } = {}, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const held = micro(b.heldMicro, 0);
  const left = payableMicro(b, { highTier }, t) - held;
  return left > 0 ? left : 0;
}

/* ---------------- 写操作 ---------------- */

/**
 * 发放注册赠送（只在公开注册时调用一次）。
 * signupGrantMicro <= 0 或已发过（grantedMicro>0 或流水里有 signup）→ 不发。
 */
function grantSignup(user, cfg, now) {
  const c = cfg || newCfg();
  if (!(c.signupGrantMicro > 0)) return { skipped: true, reason: 'signupGrantMicro=0' };
  const b = ensure(user);
  const t = Number.isFinite(now) ? now : Date.now();
  // 已发过就不再发（幂等：注册路径只走一次，这里是防御）
  if (b.grantedMicro > 0 || b.ledger.some((e) => e.kind === 'signup')) {
    return { skipped: true, reason: 'already-granted' };
  }
  b.grantedMicro = c.signupGrantMicro;
  b.grantedExpiresAt = c.signupValidDays > 0
    ? new Date(t + c.signupValidDays * 86400e3).toISOString() : null;
  push(b, {
    delta: c.signupGrantMicro, kind: 'signup',
    reason: '注册赠送' + (c.signupValidDays > 0 ? '（' + c.signupValidDays + ' 天内有效）' : ''),
    grantedAfter: b.grantedMicro, paidAfter: b.paidMicro,
  });
  return { granted: c.signupGrantMicro, expiresAt: b.grantedExpiresAt };
}

/**
 * 管理端充值 / 调账。正数进充值余额（永不过期）；负数从赠送扣起、再扣充值，**不透支**。
 * kind: 'recharge'（充值）| 'adjust'（修正）；每次都会留流水。
 */
function adminAdjust(user, { micro: amount, kind, reason, refId }, now) {
  const amt = signedMicro(amount);
  if (!amt) return { error: '变动金额不能为 0' };
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  if (amt > 0) {
    b.paidMicro += amt;
  } else {
    let need = -amt;
    // 扣减顺序与消耗一致：赠送 → 订阅 → 充值（越保值的越晚动）
    const fromGranted = Math.min(b.grantedMicro, need);
    b.grantedMicro -= fromGranted; need -= fromGranted;
    const fromPlan = Math.min(b.planMicro, need);
    b.planMicro -= fromPlan; need -= fromPlan;
    if (need > b.paidMicro) return { error: '扣减超出当前余额（可用 ' + totalMicro(b, t) + ' 微元）' };
    b.paidMicro -= need;
  }
  push(b, {
    delta: amt, kind: kind === 'recharge' ? 'recharge' : 'adjust',
    reason: String(reason || (amt > 0 ? '管理员充值' : '管理员修正')).slice(0, 80),
    refId: String(refId || ''),
    grantedAfter: b.grantedMicro, planAfter: b.planMicro, paidAfter: b.paidMicro,
  });
  return { balance: viewOf(b, t) };
}

/**
 * 只延长「订阅额度」的有效期，**不加钱**（1.8.7）。
 * 场景：月中到期前只发了 3 天额度，用户随后续费 → 本期 periodKey 没变，
 * 若什么都不做，额度会继续在那 3 天后失效（等于续费后额度反而提前没了）。
 * 只把 planExpiresAt 顶到 min(本期末, 新会员到期日)，planMicro 原样保留。
 * @returns {boolean} 是否真的延长了
 */
function extendPlanExpiry(user, expiresAt, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const next = Date.parse(expiresAt || '') || 0;
  if (!next) return false;
  const b = sweep(ensure(user), t);
  const cur = b.planExpiresAt ? Date.parse(b.planExpiresAt) : 0;
  if (next <= cur) return false;
  b.planExpiresAt = new Date(next).toISOString();
  return true;
}

/**
 * 订阅额度按月发放（1.6.0）：**现场推导，不需要定时任务**。
 * 触发点在 /api/auth/me 与网关 pre-check —— 用户只要在用，就会拿到当期额度。
 * 不结转：直接**覆盖** planMicro（不是累加），并记一笔流水。
 * @returns {{micro:number, periodKey:string, expiresAt:string}|null} null = 本期无需发放
 */
function grantPlan(user, { micro: amount, periodKey, expiresAt }, now) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  if (!amt) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  b.planMicro = amt;
  b.planPeriodKey = String(periodKey || '');
  b.planExpiresAt = expiresAt || null;
  push(b, {
    delta: amt, kind: 'plan-grant',
    reason: '订阅额度发放（' + b.planPeriodKey + '，不结转）',
    grantedAfter: b.grantedMicro, planAfter: b.planMicro, paidAfter: b.paidMicro,
  });
  return { micro: amt, periodKey: b.planPeriodKey, expiresAt: b.planExpiresAt };
}

/**
 * 充值到账（充值订单核销时调用）。进 paidMicro（永不过期）。
 * 充值赠送（bonus）随充值一并入 paidMicro —— 它是购买的附属物，不单独设有效期。
 */
function creditTopUp(user, amount, { orderId, reason } = {}, now) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  if (!amt) return { error: '到账额度必须大于 0' };
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  b.paidMicro += amt;
  push(b, {
    delta: amt, kind: 'recharge',
    reason: String(reason || '额度充值').slice(0, 80),
    refId: String(orderId || ''),
    grantedAfter: b.grantedMicro, planAfter: b.planMicro, paidAfter: b.paidMicro,
  });
  return { balance: viewOf(b, t) };
}

/**
 * 消耗（网关计费扣减）。★ 铁律二：永远如实记账、允许透支——
 * 是否"付得起"由 canAfford 在请求发出前判定，这里不做拦截。
 * 扣减顺序：注册赠送 → 订阅额度 → 充值（越"保值"的越晚扣）。
 *   高级模型跳过注册赠送（铁律三），从订阅额度起扣。
 * @returns {{fromGranted:number, fromPlan:number, fromPaid:number, overdraft:number}}
 */
function consume(user, amount, { highTier, reason, refId } = {}, now) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const out = { fromGranted: 0, fromPlan: 0, fromPaid: 0, overdraft: 0 };
  if (!amt) return out;
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  let left = amt;
  if (!highTier) {
    const fromGranted = Math.min(grantedAvailable(b, t), left);
    if (fromGranted > 0) { b.grantedMicro -= fromGranted; left -= fromGranted; out.fromGranted = fromGranted; }
  }
  const fromPlan = Math.min(planAvailable(b, t), left);
  if (fromPlan > 0) { b.planMicro -= fromPlan; left -= fromPlan; out.fromPlan = fromPlan; }
  b.paidMicro -= left;
  out.fromPaid = left;
  out.overdraft = b.paidMicro < 0 ? -b.paidMicro : 0;
  push(b, {
    delta: -amt, kind: 'consume',
    reason: String(reason || 'AI 调用').slice(0, 80),
    refId: String(refId || ''),
    grantedAfter: b.grantedMicro, planAfter: b.planMicro, paidAfter: b.paidMicro,
  });
  return out;
}

/* ---------------- 预占（hold）：并发阀门 ---------------- */

/** 预占 id 生成：进程内单调 + 随机后缀（不引入新依赖，且天然跨进程不撞） */
let holdSeq = 0;
function newHoldId(t) {
  holdSeq = (holdSeq + 1) % 1e9;
  return 'h-' + Math.round(t).toString(36) + '-' + holdSeq.toString(36)
    + '-' + Math.random().toString(36).slice(2, 8);
}

/** 按 id 摘掉一条预占（内部用；找不到返回 null，不动 heldMicro） */
function dropHold(b, id) {
  if (!Array.isArray(b.holds) || !b.holds.length) return null;
  const key = String(id == null ? '' : id);
  if (!key) return null;
  const idx = b.holds.findIndex((h) => h && h.id === key);
  if (idx < 0) return null;
  const h = b.holds.splice(idx, 1)[0];
  b.heldMicro = heldTotal(b.holds);
  return h;
}

/**
 * 预占一笔额度（网关在发起上游请求前调用）。
 * 语义：只占 availableMicro，**不动真实余额**（paidMicro/grantedMicro/planMicro 全不变），
 *      因此中途看 /api/auth/me 的 totalMicro 仍是真实余额，只有 availableMicro 变小。
 *
 * @param {object} user 用户文档（原位修改）
 * @param {number} amount 预占微元；≤ 0 时直接返回 ok 且不记录（免费模型/无估算额）
 * @param {{highTier?:boolean, id?:string}} opts
 * @returns {{ok:boolean, id?:string|null, micro:number, avail:number, code?:string}}
 *   ok=false 表示「抢不到」（并发已把可用额占满）——调用方应答 402。
 */
function hold(user, amount, { highTier, id } = {}, now) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  if (!amt) return { ok: true, id: null, micro: 0, avail: availableMicro(b, { highTier }, t) };
  const avail = availableMicro(b, { highTier }, t);
  if (amt > avail) return { ok: false, id: null, micro: 0, avail, code: 'INSUFFICIENT_BALANCE' };
  if (b.holds.length >= HOLDS_MAX) {
    return { ok: false, id: null, micro: 0, avail, code: 'TOO_MANY_HOLDS' };
  }
  const hid = String(id || newHoldId(t)).slice(0, 64);
  b.holds.push({ id: hid, micro: amt, at: t, highTier: highTier === true });
  b.heldMicro = heldTotal(b.holds);
  return { ok: true, id: hid, micro: amt, avail: avail - amt };
}

/**
 * 结算：移除预留并按**实际成本**扣费（唯一扣费出口）。
 *
 * ★ 铁律二仍然成立：扣减走 consume() 的同一顺序（赠送 → 订阅 → 充值），允许透支；
 *   实际成本大于预留额时不报错、不截断——预留只是并发阀门，绝不是账单上限。
 * ★ 预留已被 sweep 释放（请求跑超过 5 分钟）时**照样扣费**：钱是花掉的，
 *   不能因为预占没了就免费。此时 holdFound=false，调用方可据此留日志。
 *
 * @param {number} actualMicro 实际成本（上游 usage 算出来的）
 * @param {{reason?:string, refId?:string, highTier?:boolean}} opts highTier 缺省沿用预留上的档位
 * @returns {{ok:true, holdId:string, holdFound:boolean, holdMicro:number,
 *            fromGranted:number, fromPlan:number, fromPaid:number, overdraft:number}}
 */
function settleHold(user, id, actualMicro, { reason, refId, highTier } = {}, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  const h = dropHold(b, id);
  const tier = (highTier === undefined || highTier === null) ? !!(h && h.highTier) : !!highTier;
  const out = consume(user, actualMicro, { highTier: tier, reason, refId }, t);
  return Object.assign({
    ok: true,
    holdId: String(id == null ? '' : id),
    holdFound: !!h,
    holdMicro: h ? h.micro : 0,
  }, out);
}

/**
 * 释放预留（不扣费）。用于所有「上游/客户端没跑完、不计费」的出口。
 * **幂等**：id 不存在（已结算/已过期/重复调用）时返回 released=0，不抛错。
 * @returns {{ok:true, id:string, released:number, holdFound:boolean, heldMicro:number}}
 */
function releaseHold(user, id, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  const h = dropHold(b, id);
  return {
    ok: true,
    id: String(id == null ? '' : id),
    released: h ? h.micro : 0,
    holdFound: !!h,
    heldMicro: b.heldMicro,
  };
}

/**
 * 请求前判定：是否放行。只在 enforce=true 时拦截（观察模式恒放行）。
 * 成本是响应之后才知道的，所以 pre-check 用「阈值」而不是预估单次成本。
 *   基础模型：可用总额（未过期赠送 + 订阅 + 充值）需 > 0 且 ≥ minBalanceMicro
 *   高级模型：★ 赠送不算数（铁律三）——要求**订阅额度或充值余额** > 0 且过阈值，
 *             否则"只有赠送额度"的用户会在阈值 0 时直接透支充值余额
 * @returns {{allowed:boolean, avail?:number, code?:string, error?:string}}
 */
function precheck(user, cfg, { highTier } = {}, now) {
  const c = cfg || newCfg();
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  // ★ 观察模式（enforce=false）恒放行：只扣账不拦截。
  //   真实成本数据没跑够之前，任何阈值都是拍脑袋——先观察、配准价、再开。
  if (!c.enforce) return { allowed: true, avail: payableMicro(b, { highTier }, t) };
  if (highTier) {
    const avail = planAvailable(b, t) + b.paidMicro;
    const okPaid = avail > 0 && avail >= c.minBalanceMicro;
    if (okPaid) return { allowed: true, avail };
    return {
      allowed: false, avail,
      code: 'BALANCE_REQUIRED_FOR_HIGH_TIER',
      error: '高级模型需要订阅额度或充值余额（注册赠送额度仅限基础模型）。当前可用 '
        + pricing.microText(avail)
        + '。请充值或升级专业版（每月发放额度），也可在设置中接入自己的模型通道。',
    };
  }
  // ★ 1.8.0 起没有每日次数上限，余额是唯一阀门：**余额为 0 也视为不足**，
  //   否则「0 元还能再发一次」等于给了无限次（每次调用都会留下欠费）。
  const avail = totalMicro(b, t);
  if (avail > 0 && avail >= c.minBalanceMicro) return { allowed: true, avail };
  return {
    allowed: false, avail,
    code: 'INSUFFICIENT_BALANCE',
    error: 'AI 额度余额不足。当前可用 ' + pricing.microText(avail)
      + '。请充值或升级专业版（每月发放 AI 额度），也可在设置中接入自己的模型通道（自带 Key 不受额度限制）。',
  };
}

/* ---------------- 读视图 ---------------- */

/** 客户端/后台共用的余额视图（微元 + 已格式化文案，前端不换算） */
function viewOf(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const g = grantedAvailable(b, t);
  const pl = planAvailable(b, t);
  const held = micro(b.heldMicro, 0);
  const total = g + pl + b.paidMicro;
  return {
    grantedMicro: b.grantedMicro,
    grantedAvailableMicro: g,
    grantedExpiresAt: b.grantedExpiresAt,
    planMicro: b.planMicro,
    planAvailableMicro: pl,
    planExpiresAt: b.planExpiresAt,
    planPeriodKey: b.planPeriodKey || null,
    paidMicro: b.paidMicro,
    totalMicro: total,
    // ★ 1.8.6（P1-3）：进行中请求的预占，以及「扣掉预占后还能开多少新请求」。
    //   旧字段一个不动（前端零回归）；heldMicro=0 时 availableMicro === totalMicro。
    heldMicro: held,
    availableMicro: (total - held) > 0 ? (total - held) : 0,
    text: pricing.microText(total),
    grantedText: pricing.microText(g),
    planText: pricing.microText(pl),
    paidText: pricing.microText(b.paidMicro),
    grantedDaysLeft: b.grantedExpiresAt
      ? Math.max(0, Math.ceil((Date.parse(b.grantedExpiresAt) - t) / 86400e3)) : null,
    planDaysLeft: b.planExpiresAt
      ? Math.max(0, Math.ceil((Date.parse(b.planExpiresAt) - t) / 86400e3)) : null,
  };
}

function userView(user, cfg, now) {
  const b = sweep(ensure(user), Number.isFinite(now) ? now : Date.now());
  return Object.assign(viewOf(b, now), {
    enforce: !!(cfg && cfg.enforce),
    minBalanceMicro: (cfg && cfg.minBalanceMicro) || 0,
  });
}

/** 管理端视图：多带流水（客户端契约不带流水，避免无谓流量） */
function adminView(user, now) {
  const b = sweep(ensure(user), Number.isFinite(now) ? now : Date.now());
  return Object.assign(viewOf(b, now), {
    ledger: b.ledger.slice(-LEDGER_KEEP).reverse().map((e) => ({
      at: e.at, delta: e.delta, kind: e.kind, reason: e.reason || '',
      refId: e.refId || '',
      grantedAfter: e.grantedAfter, planAfter: e.planAfter, paidAfter: e.paidAfter,
    })),
  });
}

/** 按 id 找充值档位（只返回启用中的；找不到返回 null） */
function rechargeOptionOf(cfg, id) {
  const c = cfg || newCfg();
  const hit = (c.rechargeOptions || []).find((o) => o && o.id === String(id || ''));
  return hit && hit.enabled ? hit : null;
}

/** 客户端可见的充值档位（含到账额度与赠送，供插件展示） */
function rechargeOptionsForClient(cfg) {
  const c = cfg || newCfg();
  return (c.rechargeOptions || []).filter((o) => o && o.enabled).map((o) => ({
    id: o.id, cents: o.cents, creditCents: o.creditCents,
    bonusCents: Math.max(0, o.creditCents - o.cents),
    label: o.label || '',
    amountText: '¥' + (o.cents / 100).toFixed(2),
    creditText: pricing.microText(o.creditCents * pricing.MICRO_PER_CENT),
    bonusText: o.creditCents > o.cents ? '送 ' + pricing.microText((o.creditCents - o.cents) * pricing.MICRO_PER_CENT) : '',
  }));
}

module.exports = {
  LEDGER_KEEP, DEFAULT_CFG, DEFAULT_RECHARGE_OPTIONS, MICRO_PER_YUAN: pricing.MICRO_PER_YUAN,
  HOLDS_MAX, HOLD_TTL_MS,
  newCfg, normalizeCfg, cfgOf, sanitizeRechargeOptions,
  ensure, sweep, grantedAvailable, planAvailable, totalMicro, payableMicro, availableMicro,
  sanitizeHolds, heldTotal, newHoldId,
  hold, settleHold, releaseHold,
  grantSignup, grantPlan, extendPlanExpiry, creditTopUp, adminAdjust, consume, precheck,
  hasRef,
  viewOf, userView, adminView,
  rechargeOptionOf, rechargeOptionsForClient,
};
