/* PaperPilot 账号后台 · 余额域（服务端 1.6.0，配合插件 0.26.x）
 *
 * 职责：AI 额度余额 —— 注册赠送 / 充值 / 消耗 / 流水。
 * 数据落在 user.balance（users.json，随既有快照/回滚体系走，无需新文件）：
 *   {
 *     grantedMicro: n,       // 赠送余额（微元）——注册礼包；有有效期
 *     grantedExpiresAt: ISO, // 赠送额度过期时间（null = 不过期，不建议）
 *     paidMicro: n,          // 充值余额（微元）——**永不过期**；管理员充值/调账也进这里
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
 * ★ 铁律三：**高级模型不吃赠送额度**（用户决策：赠送限基础模型）。
 *   highTier 模型的消耗只从 paidMicro 扣；赠送额度只能用于基础模型。
 *
 * 计费单位沿用 pricing.js 的「微元」（1e-6 元）整数口径，两模块零换算。
 *
 * 配置（pricing.json 顶层 balance 块，normalizeCfg 维护）：
 *   {
 *     signupGrantMicro: 6000000,  // 注册赠送 ¥6；0 = 关闭
 *     signupValidDays: 30,        // 赠送有效期（天）；0 = 不过期（不建议）
 *     enforce: false,            // ★ 余额不足是否拦截。false = 只记账不拦（观察模式）。
 *                                //   上线初期必须先观察（真实成本数据没跑够两周，
 *                                //   拦截阈值就是拍脑袋），确认单价后再开。
 *     minBalanceMicro: 0         // 拦截阈值：可用余额低于此值拒绝新请求
 *   }
 */
'use strict';

const pricing = require('./pricing');

/** 流水保留条数（每账号；users.json 是全量读写的 JSON，不能无限长） */
const LEDGER_KEEP = 50;

const DEFAULT_CFG = {
  signupGrantMicro: 6 * pricing.MICRO_PER_YUAN,   // ¥6
  signupValidDays: 30,
  enforce: false,
  minBalanceMicro: 0,
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

/**
 * 规范化 pricing 文档的 balance 配置块（幂等）。
 * @param {object} pricingDoc pricing.json 文档（原位修改）
 */
function normalizeCfg(pricingDoc) {
  if (!pricingDoc || typeof pricingDoc !== 'object') return newCfg();
  const raw = pricingDoc.balance && typeof pricingDoc.balance === 'object'
    ? pricingDoc.balance : {};
  const cfg = {
    signupGrantMicro: micro(raw.signupGrantMicro, DEFAULT_CFG.signupGrantMicro),
    signupValidDays: Math.max(0, Math.round(Number(raw.signupValidDays) || 0)) || 30,
    enforce: raw.enforce === true,
    minBalanceMicro: micro(raw.minBalanceMicro, 0),
  };
  pricingDoc.balance = cfg;
  return cfg;
}

function cfgOf(pricingDoc) {
  return normalizeCfg(pricingDoc);
}

/* ---------------- 用户余额对象 ---------------- */

/** 确保余额结构存在（幂等；老账号现场补，零迁移） */
function ensure(user) {
  if (!user.balance || typeof user.balance !== 'object' || Array.isArray(user.balance)) {
    user.balance = {};
  }
  const b = user.balance;
  b.grantedMicro = micro(b.grantedMicro, 0);   // 赠送永不为负（过期由 sweep 清零）
  // ★ 充值余额允许为负（并发窗口下的透支）：绝不能在读取路径上被"消毒"成 0——
  //   那会让欠费凭空消失、看板失真、透支用户继续畅通无阻。
  b.paidMicro = signedMicro(b.paidMicro);
  b.grantedExpiresAt = b.grantedExpiresAt || null;
  if (!Array.isArray(b.ledger)) b.ledger = [];
  return b;
}

/** 到期即清零（幂等；只在被触到的用户上惰性执行，不做全表扫描） */
function sweep(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (b.grantedMicro > 0 && b.grantedExpiresAt && t >= Date.parse(b.grantedExpiresAt)) {
    push(b, {
      delta: -b.grantedMicro, kind: 'grant-expire',
      reason: '赠送额度到期回收', grantedAfter: 0, paidAfter: b.paidMicro,
    });
    b.grantedMicro = 0;
  }
  return b;
}

function push(b, entry) {
  b.ledger.push(Object.assign({ at: new Date().toISOString(), refId: '' }, entry));
  if (b.ledger.length > LEDGER_KEEP) b.ledger.splice(0, b.ledger.length - LEDGER_KEEP);
  return b;
}

/** 赠送部分当前可用（过期 = 0） */
function grantedAvailable(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (!b.grantedExpiresAt) return b.grantedMicro;
  return t >= Date.parse(b.grantedExpiresAt) ? 0 : b.grantedMicro;
}

/** 可用总额 = 未过期赠送 + 充值 */
function totalMicro(b, now) {
  return grantedAvailable(b, now) + b.paidMicro;
}

/** 高级模型只能用充值余额（铁律三） */
function payableMicro(b, { highTier } = {}, now) {
  return highTier ? b.paidMicro : totalMicro(b, now);
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
    const need = -amt;
    const fromGranted = Math.min(b.grantedMicro, need);
    b.grantedMicro -= fromGranted;
    const fromPaid = need - fromGranted;
    if (fromPaid > b.paidMicro) return { error: '扣减超出当前余额（可用 ' + totalMicro(b, t) + ' 微元）' };
    b.paidMicro -= fromPaid;
  }
  push(b, {
    delta: amt, kind: kind === 'recharge' ? 'recharge' : 'adjust',
    reason: String(reason || (amt > 0 ? '管理员充值' : '管理员修正')).slice(0, 80),
    refId: String(refId || ''), grantedAfter: b.grantedMicro, paidAfter: b.paidMicro,
  });
  return { balance: viewOf(b, t) };
}

/**
 * 消耗（网关计费扣减）。★ 铁律二：永远如实记账、允许透支——
 * 是否"付得起"由 canAfford 在请求发出前判定，这里不做拦截。
 * @returns {{fromGranted:number, fromPaid:number, overdraft:number}}
 */
function consume(user, amount, { highTier, reason, refId } = {}, now) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const out = { fromGranted: 0, fromPaid: 0, overdraft: 0 };
  if (!amt) return out;
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  let left = amt;
  // 铁律三：高级模型不走赠送额度
  if (!highTier) {
    const fromGranted = Math.min(grantedAvailable(b, t), left);
    if (fromGranted > 0) { b.grantedMicro -= fromGranted; left -= fromGranted; out.fromGranted = fromGranted; }
  }
  b.paidMicro -= left;
  out.fromPaid = left;
  out.overdraft = b.paidMicro < 0 ? -b.paidMicro : 0;
  push(b, {
    delta: -amt, kind: 'consume',
    reason: String(reason || 'AI 调用').slice(0, 80),
    refId: String(refId || ''),
    grantedAfter: b.grantedMicro, paidAfter: b.paidMicro,
  });
  return out;
}

/**
 * 请求前判定：是否放行。只在 enforce=true 时拦截（观察模式恒放行）。
 * 成本是响应之后才知道的，所以 pre-check 用「阈值」而不是预估单次成本。
 *   基础模型：可用总额（未过期赠送 + 充值）≥ minBalanceMicro
 *   高级模型：★ 赠送不算数（铁律三）——要求**充值余额**过阈值且大于 0，
 *             否则"只有赠送额度"的用户会在阈值 0 时直接透支充值余额
 * @returns {{allowed:boolean, avail?:number, code?:string, error?:string}}
 */
function precheck(user, cfg, { highTier } = {}, now) {
  const c = cfg || newCfg();
  const t = Number.isFinite(now) ? now : Date.now();
  const b = sweep(ensure(user), t);
  // ★ 观察模式（enforce=false）恒放行：只扣账不拦截。
  //   真实成本数据没跑够之前，任何阈值都是拍脑袋——先观察、配准价、再开。
  if (!c.enforce) return { allowed: true, avail: highTier ? b.paidMicro : totalMicro(b, t) };
  if (highTier) {
    const okPaid = b.paidMicro > 0 && b.paidMicro >= c.minBalanceMicro;
    if (okPaid) return { allowed: true, avail: b.paidMicro };
    return {
      allowed: false, avail: b.paidMicro,
      code: 'BALANCE_REQUIRED_FOR_HIGH_TIER',
      error: '高级模型需要充值余额（赠送额度仅限基础模型）。当前充值余额 '
        + pricing.microText(b.paidMicro)
        + '。请充值，或在设置中接入自己的模型通道（自带 Key 不受额度限制）。',
    };
  }
  const avail = totalMicro(b, t);
  if (avail >= c.minBalanceMicro) return { allowed: true, avail };
  return {
    allowed: false, avail,
    code: 'INSUFFICIENT_BALANCE',
    error: 'AI 额度余额不足。当前可用 ' + pricing.microText(avail)
      + '。请充值，或在设置中接入自己的模型通道（自带 Key 不受额度限制）。',
  };
}

/* ---------------- 读视图 ---------------- */

/** 客户端/后台共用的余额视图（微元 + 已格式化文案，前端不换算） */
function viewOf(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return {
    grantedMicro: b.grantedMicro,
    grantedAvailableMicro: grantedAvailable(b, t),
    grantedExpiresAt: b.grantedExpiresAt,
    paidMicro: b.paidMicro,
    totalMicro: totalMicro(b, t),
    text: pricing.microText(totalMicro(b, t)),
    grantedText: pricing.microText(grantedAvailable(b, t)),
    paidText: pricing.microText(b.paidMicro),
    grantedDaysLeft: b.grantedExpiresAt
      ? Math.max(0, Math.ceil((Date.parse(b.grantedExpiresAt) - t) / 86400e3)) : null,
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
      refId: e.refId || '', grantedAfter: e.grantedAfter, paidAfter: e.paidAfter,
    })),
  });
}

module.exports = {
  LEDGER_KEEP, DEFAULT_CFG, MICRO_PER_YUAN: pricing.MICRO_PER_YUAN,
  newCfg, normalizeCfg, cfgOf,
  ensure, sweep, grantedAvailable, totalMicro, payableMicro,
  grantSignup, adminAdjust, consume, precheck,
  viewOf, userView, adminView,
};
