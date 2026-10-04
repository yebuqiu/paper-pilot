/* PaperPilot 账号后台 · 会员域（0.23.0）
 *
 * 职责：套餐目录 / 价格档位 / 订单生命周期 / 激活码（兑换码）/ 有效期管理。
 * 数据：{DATA_DIR}/membership.json（JsonStore 原子写）
 *   {
 *     schemaVersion: 3,
 *     plans:        { Free:{...}, Pro:{...} },          // 等级与权益（后台可改）
 *     priceItems:   [ 价格条目 ... ],                    // ★ v3 价格表（权威源，见下）
 *     priceOptions: { Pro:[{months,price,label}] },      // 派生视图（兼容旧客户端/旧后台）
 *     pay:          { channel, qrImage, qrText, note },  // 收款信息（后台可改）
 *     orders:       [ ... ],                             // 订单
 *     codes:        [ ... ]                              // 激活码
 *   }
 *
 * ★ v3 价格表（0.23.1 新增）：价格条目 = 「等级 × 计费周期 × 生效时段」
 *   { id, plan, cycle, months, price, label, effectiveFrom, effectiveTo, enabled, priority, note, createdAt }
 *   - 等级：Free / Pro…（Free 不可购买，只需给可购等级配价）
 *   - 计费周期 cycle：monthly / quarterly / halfyear / yearly / custom，与 months 一一对应
 *     （周期只描述「一次付费买多久」，本轮不做自动续费订阅——那属于支付网关能力）
 *   - 生效时段：effectiveFrom/To 为 ISO 或 null（null = 立即生效 / 长期有效）
 *       · 生效中 → 客户端可下单
 *       · 未生效（from 在未来）→ 客户端仅展示「即将生效」，不可下单
 *       · 已过期（to 已过）→ 客户端完全不下发，只留在后台存档
 *   - **允许时段重叠，用优先级决出唯一胜者**：priority 高者胜 → 起期晚者胜 → 创建晚者胜。
 *     这样「长期基础价 + 限时促销价」可以共存：给促销价 priority=1，促销窗口内自动覆盖基础价，
 *     窗口一过自动回到基础价，**不需要**把基础价切成段（那种做法很容易留下空档、
 *     让某个周期突然不可购买）。同一价位若有多条并列，客户端只下发胜者，后台列表标注「生效中·胜出」。
 *   - 空档预警：若某条价格设了 effectiveTo 而之后没有任何启用的价格接续，
 *     写入时返回 warn（不拦，但后台会提示），避免悄悄把某周期卖死。
 *
 * 会员等级的权威落点仍是 user 对象（users.json）：
 *   user.membership = { plan, months, activatedAt, expiresAt, source, refId, history[] }
 *   user.plan / user.expiresAt 是兼容镜像（旧客户端只认这两个字段）
 * 因此会员数据与账号数据同生命周期的持久化策略，无需二次迁移。
 *
 * 有效期规则（关键）：续期 = max(现在, 现有到期) + 时长。
 *   即「剩余时长不吞」——Pro 还剩 20 天时再买 1 个月，到期日 = 今天 + 20 天 + 30 天。
 *
 * 两条开通路径：
 *   A. 订单：插件内下单 → 用户扫码付款后点「我已完成支付」→ 管理员核销 →
 *      直接给下单账号开通（同时生成一枚已用兑换码留档，便于对账）。
 *   B. 激活码：线下售卖/赠送/补偿 → 插件内输码激活（可用「未绑定」通用码，
 *      也可绑定到指定账号）。
 */
'use strict';

const crypto = require('crypto');
const coupon = require('./coupon');

const DAY_MS = 86400e3;
const ORDER_TTL_MS = 7 * DAY_MS;    // 未支付订单 7 天后自动过期
const MAX_MONTHS = 36;

/* ---------------- 默认配置（后台可改，改完落 membership.json） ---------------- */

const DEFAULT_PLANS = {
  Free: {
    id: 'Free', name: '免费版', rank: 0, price: 0, currency: 'CNY',
    dailyLimit: 100, highTierModels: false,
    monthlyGrantMicro: 0,                       // 1.6.0：Free 无订阅额度
    tagline: '登录即用，个人日常够用',
    features: [
      '注册赠送 ¥6 额度（30 天内有效，限基础模型）',
      '全部核心功能（期刊分区列 / 标签治理 / 附件体检 / 库内问答 / PDF 对比…）',
      '可接入自己的 OpenAI 兼容接口，不受额度限制',
      '社区支持',
    ],
  },
  Pro: {
    id: 'Pro', name: '专业版', rank: 1, price: 29, currency: 'CNY',
    dailyLimit: 3000, highTierModels: true,
    // 1.6.0 订阅去无限化：Pro 的权益从「每日 3000 次」改为「每月发放额度」
    // ★ 20000000 微元 = ¥20。**待人均成本数据校准**（后台可改，见 plans 编辑）。
    monthlyGrantMicro: 20000000,
    tagline: '高频写论文/做综述时用',
    features: [
      '每月发放 ¥20 AI 额度（不结转，含全部高级模型）',
      '全部官方模型（含推理档 / 长上下文）',
      '可接入自己的 OpenAI 兼容接口，多通道一键切换',
      '邮件优先支持',
    ],
  },
};

const DEFAULT_PRICE_OPTIONS = {
  Pro: [
    { months: 1, price: 29, label: '1 个月' },
    { months: 3, price: 79, label: '3 个月 · 省 ¥8' },
    { months: 12, price: 269, label: '12 个月 · 省 ¥79' },
  ],
};

/**
 * 计费周期预设（v3）。months 是「一次付费覆盖多少个月」，
 * 与价格条目的 months 一一对应；custom 表示后台自填的月数。
 * 注意：本轮不做自动续费订阅——周期只用于描述与展示，以及为后续订阅能力留位。
 */
const CYCLE_PRESETS = [
  { id: 'monthly', name: '按月', months: 1, short: '月' },
  { id: 'quarterly', name: '按季', months: 3, short: '季' },
  { id: 'halfyear', name: '半年', months: 6, short: '半年' },
  { id: 'yearly', name: '按年', months: 12, short: '年' },
  { id: 'custom', name: '自定义', months: 0, short: '自定义' },
  // 1.4.5：永久会员 —— months 恒为 0（不适用），授予时 expiresAt 置空
  { id: 'perpetual', name: '永久', months: 0, short: '永久' },
];

/** 永久周期的 id（订单/价格条目里 months=0 即视为永久） */
const PERPETUAL = 'perpetual';
const isPerpetual = (cycle) => String(cycle || '') === PERPETUAL;

/**
 * 对账尾数（分）：给每个待支付订单分配一个**同金额内唯一**的小数尾数，
 * 让「¥128.13 / ¥128.27」能唯一对应到某一笔订单 —— 收款流水按金额即可自动核销。
 * 只有 1..99，所以同一价格最多 99 笔同时待支付/待核销；终态订单的尾数会被回收。
 */
const TAIL_MIN = 1;
const TAIL_MAX = 99;

/** 价格条目状态文案（后台列表与 API 共用） */
const PRICE_STATE_TEXT = {
  active: '生效中',
  scheduled: '未生效',
  expired: '已过期',
  disabled: '已停用',
};

const DEFAULT_PAY = {
  channel: '收款码',
  qrImage: '',   // 收款码图片地址（后台填写；为空时展示 qrText）
  qrText: '',    // 无图片时的文字收款信息（如微信号 / 支付宝账号）
  note: '扫码支付后点「我已完成支付」，管理员核销后自动开通（一般几分钟内）。',
};

/**
 * 全局 AI 策略（1.4.9）。
 * trialDays = 新用户「全模型试用」天数：以 user.createdAt 为起点现场计算，
 *   **不需要落盘、不需要迁移**；改成 0 即整体关闭。
 *   试用只放开「高级模型」的可用性，不动每日额度（额度仍按套餐来）。
 */
const DEFAULT_AI = {
  trialDays: 7,
};

/** 激活码字母表：去掉易混的 0/O/1/I/L */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------------- 基础 ---------------- */

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** 整数夹取（仅在**配置类**字段上用；金额类字段一律拒绝而不是夹取） */
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** 默认价格表：由 DEFAULT_PRICE_OPTIONS 生成，避免两处默认值漂移 */
function defaultPriceItems() {
  const out = [];
  for (const [planId, list] of Object.entries(DEFAULT_PRICE_OPTIONS)) {
    for (const o of list) {
      const months = clampMonths(o.months);
      out.push({
        id: 'pr-default-' + planId.toLowerCase() + '-' + months,
        plan: planId,
        cycle: cycleOfMonths(months),
        months,
        price: Math.max(0, Number(o.price) || 0),
        label: o.label || (months + ' 个月'),
        effectiveFrom: null, effectiveTo: null, enabled: true,
        note: '默认价格表',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
  }
  return out;
}

function newDoc() {
  return {
    schemaVersion: 3,
    plans: clone(DEFAULT_PLANS),
    priceItems: defaultPriceItems(),
    priceOptions: clone(DEFAULT_PRICE_OPTIONS),   // 派生视图，normalize 会重算
    pay: clone(DEFAULT_PAY),
    ai: clone(DEFAULT_AI),
    orders: [],
    codes: [],
  };
}

/**
 * 规范化 / 迁移（幂等，每次启动都可安全调用）：
 *   v1（无 schemaVersion）→ v2 → v3。
 * v2→v3 只做一次：把旧的 priceOptions 平铺档位升级为 priceItems 价格条目；
 * 之后 **priceItems 是权威源**，priceOptions 每次都由它重算（只读派生）。
 */
function normalize(doc) {
  const out = doc && typeof doc === 'object' ? doc : newDoc();
  if (!out.plans || typeof out.plans !== 'object') out.plans = clone(DEFAULT_PLANS);
  for (const id of Object.keys(DEFAULT_PLANS)) {
    if (!out.plans[id]) out.plans[id] = clone(DEFAULT_PLANS[id]);
    else out.plans[id] = Object.assign(clone(DEFAULT_PLANS[id]), out.plans[id]);
    // 1.6.0 订阅额度：非负整数微元（0 = 该档不发订阅额度）
    out.plans[id].monthlyGrantMicro = Math.max(0, Math.round(Number(out.plans[id].monthlyGrantMicro) || 0));
  }
  // ---- 价格表：priceItems 权威源 ----
  if (!Array.isArray(out.priceItems) || !out.priceItems.length) {
    const migrated = migratePriceOptions(out.priceOptions);
    out.priceItems = migrated.length ? migrated : defaultPriceItems();
  }
  out.priceItems = out.priceItems.map((i) => sanitizePriceItem(i)).filter(Boolean);
  if (!out.priceItems.length) out.priceItems = defaultPriceItems();
  out.priceOptions = derivePriceOptions(out);
  // ---- 收款 ----
  if (!out.pay || typeof out.pay !== 'object') out.pay = clone(DEFAULT_PAY);
  else out.pay = Object.assign(clone(DEFAULT_PAY), out.pay);
  // ---- AI 全局策略（1.4.9）----
  if (!out.ai || typeof out.ai !== 'object') out.ai = clone(DEFAULT_AI);
  else out.ai = Object.assign(clone(DEFAULT_AI), out.ai);
  out.ai = { trialDays: clampInt(out.ai.trialDays, 0, 365, DEFAULT_AI.trialDays) };
  if (!Array.isArray(out.orders)) out.orders = [];
  if (!Array.isArray(out.codes)) out.codes = [];
  // ---- 优惠券（1.4.6）：只做轻修复，**不重建**，否则会丢掉 uses 占用记录 ----
  if (!Array.isArray(out.coupons)) out.coupons = [];
  out.coupons = out.coupons.filter((c) => c && typeof c === 'object' && c.code).map((c) => {
    if (!c.id) c.id = coupon.rid('cp', 6);
    if (!Array.isArray(c.uses)) c.uses = [];
    if (c.enabled === undefined) c.enabled = true;
    if (c.type !== 'amount') c.type = 'percent';
    if (!Array.isArray(c.plans)) c.plans = [];
    return c;
  });
  out.schemaVersion = 3;
  return out;
}

function rid(prefix, bytes) {
  return prefix + '-' + crypto.randomBytes(bytes || 6).toString('hex');
}

/** 人类可读激活码 PP-XXXX-XXXX-XXXX */
function newCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  const block = () => pick() + pick() + pick() + pick();
  return 'PP-' + block() + '-' + block() + '-' + block();
}

/** 激活码归一：去空白、转大写、接受带或不带分隔符 */
function normCode(c) {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 14 || !s.startsWith('PP')) return '';
  return 'PP-' + s.slice(2, 6) + '-' + s.slice(6, 10) + '-' + s.slice(10, 14);
}

/* ---------------- 价格表（v3：等级 × 计费周期 × 生效时段） ---------------- */

function cycleOfMonths(m) {
  if (Number(m) === 0) return PERPETUAL;
  const hit = CYCLE_PRESETS.find((c) => c.months === Number(m) && c.months > 0);
  return hit ? hit.id : 'custom';
}

/** 周期 + 月数 → 人类可读的时长文案（永久不显示"N 个月"） */
function monthsLabel(months, cycle) {
  return (isPerpetual(cycle) || Number(months) === 0) ? '永久' : (Number(months) + ' 个月');
}

function cycleName(id) {
  const hit = CYCLE_PRESETS.find((c) => c.id === id);
  return hit ? hit.name : '自定义';
}

/** ISO 或 null（非法值一律归 null，避免坏配置把界面搞崩） */
function isoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * 价格条目在指定时刻的状态：
 *   disabled 已停用 / scheduled 未生效（from 在未来）/ expired 已过期 / active 生效中
 */
function priceState(item, now) {
  const t = now || Date.now();
  if (!item || item.enabled === false) return 'disabled';
  if (item.effectiveFrom && t < Date.parse(item.effectiveFrom)) return 'scheduled';
  if (item.effectiveTo && t >= Date.parse(item.effectiveTo)) return 'expired';
  return 'active';
}

/** 价格条目消毒（写入口与读入口都过一遍，坏数据不落库也不下发） */
function sanitizePriceItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const plan = String(raw.plan || 'Pro').slice(0, 24);
  // 永久条目：months 恒为 0（不适用）；clampMonths 会把 0 抬成 1，所以要先判周期
  const rawCycle = String(raw.cycle || '');
  const perpetual = rawCycle === PERPETUAL;
  const months = perpetual ? 0 : clampMonths(raw.months);
  const cycle = perpetual ? PERPETUAL
    : (CYCLE_PRESETS.some((c) => c.id === rawCycle) ? rawCycle : cycleOfMonths(months));
  const from = isoOrNull(raw.effectiveFrom);
  const to = isoOrNull(raw.effectiveTo);
  if (from && to && Date.parse(to) <= Date.parse(from)) return null; // 时段反了：视为非法，丢弃
  return {
    id: String(raw.id || rid('pr', 6)),
    plan,
    cycle,
    months,
    price: Math.max(0, Number(raw.price) || 0),
    label: String(raw.label || '').slice(0, 40),
    effectiveFrom: from,
    effectiveTo: to,
    enabled: raw.enabled === false ? false : true,
    // 优先级 0-9：时段重叠时高者胜（促销价建议给 1+，日常价留 0）
    priority: Math.min(9, Math.max(0, Math.round(Number(raw.priority) || 0))),
    note: String(raw.note || '').slice(0, 80),
    createdAt: isoOrNull(raw.createdAt) || new Date().toISOString(),
  };
}

/** v2 的 priceOptions 平铺档位 → v3 价格条目（只在 priceItems 为空时执行一次） */
function migratePriceOptions(priceOptions) {
  const out = [];
  for (const [planId, list] of Object.entries(priceOptions || {})) {
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      if (!o) continue;
      const months = clampMonths(o.months);
      out.push({
        id: 'pr-migrated-' + String(planId).toLowerCase() + '-' + months,
        plan: planId,
        cycle: cycleOfMonths(months),
        months,
        price: Math.max(0, Number(o.price) || 0),
        label: String(o.label || (months + ' 个月')).slice(0, 40),
        effectiveFrom: null, effectiveTo: null, enabled: true,
        note: '由旧版价格档位迁移',
        createdAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

/**
 * 时段的优先级排序键：priority 升序比较 → 起期晚者更「具体」→ 创建晚者最新。
 * 时段重叠时按此键取**唯一胜者**，因此下单价永远确定。
 */
function priceRank(item) {
  return [
    Number(item.priority) || 0,
    item.effectiveFrom ? Date.parse(item.effectiveFrom) : 0,
    Date.parse(item.createdAt) || 0,
  ];
}

/** 从一批候选里挑出胜者（priority 高 → 起期晚 → 创建晚） */
function pickPriceWinner(items) {
  if (!items || !items.length) return null;
  return items.slice().sort((a, b) => {
    const ra = priceRank(a);
    const rb = priceRank(b);
    if (ra[0] !== rb[0]) return rb[0] - ra[0];
    if (ra[1] !== rb[1]) return rb[1] - ra[1];
    return rb[2] - ra[2];
  })[0];
}

/** 某等级当前生效的条目按「月数 → 胜者」归并（每个周期只留唯一有效价） */
function activeWinnerMap(doc, planId, now) {
  const t = now || Date.now();
  const byMonths = new Map();
  for (const it of (doc.priceItems || [])) {
    if (it.plan !== planId || priceState(it, t) !== 'active') continue;
    const arr = byMonths.get(it.months) || [];
    arr.push(it);
    byMonths.set(it.months, arr);
  }
  const out = [];
  byMonths.forEach((arr) => { const w = pickPriceWinner(arr); if (w) out.push(w); });
  return out;
}

/** priceItems → 旧版 priceOptions 派生视图（只含生效中的周期，每周期取胜者） */
function derivePriceOptions(doc, now) {
  const plans = Object.keys(doc.plans || {});
  const out = {};
  for (const pid of plans) {
    const winners = activeWinnerMap(doc, pid, now)
      .sort((a, b) => a.months - b.months)
      .map((i) => ({ months: i.months, price: i.price, label: i.label || monthsLabel(i.months, i.cycle) }));
    if (winners.length) out[pid] = winners;
  }
  return out;
}

/**
 * 后台可见的价格条目（含未生效/已过期/已停用）。
 * winner=true 表示「此刻若下单，用的是这条」——后台列表据此标注，避免看不出谁生效。
 */
function priceItemOut(doc, item, now) {
  const t = now || Date.now();
  const st = priceState(item, t);
  let winner = false;
  if (st === 'active') {
    const w = pickPriceWinner((doc.priceItems || []).filter((i) =>
      i.plan === item.plan && i.months === item.months && priceState(i, t) === 'active'));
    winner = !!(w && w.id === item.id);
  }
  const shadows = st === 'active' && !winner
    ? (doc.priceItems || []).filter((i) => i.plan === item.plan && i.months === item.months
        && priceState(i, t) === 'active' && i.id !== item.id).length
    : 0;
  return {
    id: item.id, plan: item.plan, planName: planOf(doc, item.plan).name,
    cycle: item.cycle, cycleName: cycleName(item.cycle),
    months: item.months, price: item.price,
    perMonth: item.months > 0 ? Math.round((item.price / item.months) * 100) / 100 : 0,
    label: item.label || monthsLabel(item.months, item.cycle),
    effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo,
    enabled: item.enabled, priority: Number(item.priority) || 0,
    note: item.note || '', createdAt: item.createdAt,
    state: st, stateText: PRICE_STATE_TEXT[st] || st,
    winner: winner, shadowedBy: shadows,
  };
}

/** 两个价格条目的生效时段是否重叠（null 视为 ±∞） */
function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  const af = aFrom ? Date.parse(aFrom) : -Infinity;
  const at = aTo ? Date.parse(aTo) : Infinity;
  const bf = bFrom ? Date.parse(bFrom) : -Infinity;
  const bt = bTo ? Date.parse(bTo) : Infinity;
  return af < bt && bf < at;
}

/** 与该条目时段重叠、同等级同月数的其他**启用中**条目（用于给出提示，不做拒绝） */
function findPriceOverlaps(doc, cand, excludeId) {
  return (doc.priceItems || []).filter((it) =>
    it.id !== excludeId && it.enabled && cand.enabled !== false
    && it.plan === cand.plan && it.months === cand.months
    && rangesOverlap(cand.effectiveFrom, cand.effectiveTo, it.effectiveFrom, it.effectiveTo));
}

/**
 * 空档预警：给某条价格设了 effectiveTo、而之后再没有任何启用价格接续时返回该时间点。
 * 这不是错误（管理员可能确实要下架某周期），但不提示就会「悄悄把周期卖死」。
 */
function coverageGapAfter(doc, cand, excludeId) {
  if (!cand.effectiveTo) return null;
  const after = Date.parse(cand.effectiveTo) + 1;
  const others = (doc.priceItems || []).filter((i) =>
    i.id !== excludeId && i.enabled && i.plan === cand.plan && i.months === cand.months);
  if (others.some((i) => priceState(i, after) === 'active')) return null;
  return cand.effectiveTo;
}

/**
 * 新增 / 更新价格条目。
 * 允许时段重叠（用优先级决胜负），因此不再因为重叠而拒绝；
 * 返回 { item, warn, overlaps }：warn 是空档等需要提醒但不必拦的情况。
 */
function upsertPriceItem(doc, raw, { now } = {}) {
  const cand = sanitizePriceItem(raw);
  if (!cand) return { error: '价格配置非法（时段起止顺序不对或字段缺失）' };
  if (!doc.plans[cand.plan]) return { error: '等级不存在：' + cand.plan };
  if (cand.price <= 0) return { error: '价格必须大于 0（免费等级不需要配价）' };
  const isNew = !(doc.priceItems || []).some((i) => i.id === cand.id);
  if (isNew && (!raw || !raw.id)) cand.id = rid('pr', 6);
  if (isNew) {
    doc.priceItems.push(cand);
  } else {
    const idx = doc.priceItems.findIndex((i) => i.id === cand.id);
    cand.createdAt = doc.priceItems[idx].createdAt;   // 保留原始创建时间，排序稳定
    doc.priceItems[idx] = cand;
  }
  doc.priceOptions = derivePriceOptions(doc, now);

  const warn = [];
  const others = findPriceOverlaps(doc, cand, cand.id);
  if (others.length) {
    const w = pickPriceWinner([cand].concat(others));
    const isWinner = w && w.id === cand.id;
    warn.push('与 ' + others.length + ' 条同等级同周期的价格时段重叠；当前按优先级判定'
      + (isWinner ? '本条胜出' : '由「' + (w.label || w.id) + '」胜出')
      + '（priority ' + (w ? Number(w.priority) || 0 : 0) + '；要让它胜出请提高优先级）');
  }
  const gap = coverageGapAfter(doc, cand, cand.id);
  if (gap) {
    warn.push('该周期在 ' + gap.slice(0, 10) + ' 之后将没有任何生效价格，用户届时无法购买这个周期');
  }
  return { item: cand, warn: warn.length ? warn.join('；') : '', overlaps: others.length };
}

function removePriceItem(doc, id) {
  const idx = (doc.priceItems || []).findIndex((i) => i && i.id === id);
  if (idx < 0) return { error: '价格条目不存在' };
  const [removed] = doc.priceItems.splice(idx, 1);
  doc.priceOptions = derivePriceOptions(doc);
  return { item: removed };
}

/** 该等级是否至少有一条生效中的价格（下单开放判据） */
function hasActivePrice(doc, planId, now) {
  return activeWinnerMap(doc, planId, now).length > 0;
}

/**
 * 下单取价（唯一口径）。
 * 规则：生效中条目里精确匹配同月数 → 多条时按优先级取胜者；该等级有生效价但没这个周期
 * → 明确报错（不让用户买到后台没配的周期）；一条生效价都没有 → 退回「等级单价 × 月数」
 * 兜底（兼容尚未配置价格表的历史数据）。
 * 返回 { ok, price, months, label, itemId, cycle, source:'item'|'base' } 或 { error }。
 */
function effectivePrice(doc, planId, months, now) {
  // months === 0 表示「永久」（不适用月数），不能走 clampMonths（会把 0 抬成 1）
  const m = Number(months) === 0 ? 0 : clampMonths(months);
  const pid = planOf(doc, planId).id;
  const winners = activeWinnerMap(doc, pid, now);
  const hit = winners.find((i) => i.months === m);
  if (hit) {
    return {
      ok: true, price: hit.price, months: m,
      label: hit.label || monthsLabel(m, hit.cycle), itemId: hit.id, cycle: hit.cycle, source: 'item',
    };
  }
  if (winners.length) {
    const opts = winners.map((i) => monthsLabel(i.months, i.cycle))
      .sort((a, b) => a.localeCompare(b, 'zh')).join(' / ');
    return { error: '该计费周期（' + monthsLabel(m) + '）当前不可购买；可选：' + opts };
  }
  if (m === 0) return { error: '永久会员需要后台配置价格条目（不能按单月价折算）' };
  const unit = Number(planOf(doc, pid).price) > 0 ? Number(planOf(doc, pid).price) : 0;
  if (unit <= 0) return { error: '该等级暂未开放购买（后台未配置价格）' };
  return { ok: true, price: unit * m, months: m, label: monthsLabel(m), itemId: null,
    cycle: cycleOfMonths(m), source: 'base' };
}

/* ---------------- 套餐与价格 ---------------- */

function planOf(doc, id) {
  const p = (doc.plans || {})[String(id || '')];
  return p || (doc.plans && doc.plans.Free) || DEFAULT_PLANS.Free;
}

/** 新用户全模型试用天数（0 = 关闭） */
function trialDaysFor(doc) {
  const n = Number((doc && doc.ai && doc.ai.trialDays));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(365, Math.round(n));
}

/**
 * 「新用户全模型试用」状态（纯函数，便于按毫秒级边界覆盖）。
 * - createdAt 缺失 / trialDays <= 0 → 一律**不活跃**（不猜、不给默认试用）
 * - 起点 = 注册时间 createdAt；用时间戳现场算 ⇒ 无需落盘、无需迁移
 * - 已过期时仍返回 endsAt（供界面说明「试用已于 X 结束」）
 * @returns {{active:boolean, days:number, endsAt:string|null, daysLeft:number}}
 */
function trialState(createdAt, trialDays, now) {
  const n = Number(trialDays);
  const days = Number.isFinite(n) && n > 0 ? Math.min(365, Math.round(n)) : 0;
  const out = { active: false, days: days, endsAt: null, daysLeft: 0 };
  if (!days) return out;
  const start = Date.parse(createdAt || '') || 0;
  if (!start) return out;
  const end = start + days * DAY_MS;
  out.endsAt = new Date(end).toISOString();
  const t = Number.isFinite(now) ? now : Date.now();
  const left = end - t;
  if (left <= 0) return out;
  out.active = true;
  out.daysLeft = Math.ceil(left / DAY_MS);
  return out;
}

/** 某等级的每日官方模型额度（管理员在用户级显式设置的 dailyLimit 优先级更高） */
function dailyLimitFor(doc, planId) {
  const p = planOf(doc, planId);
  const n = Number(p.dailyLimit);
  return n > 0 ? n : 100;
}

/** 价格档位查询；未配置的月数按「单价 × 月数」兜底 */
/**
 * 兼容包装：老调用方只要 {months, price, label}。
 * 计价口径统一走 effectivePrice（生效中的价格条目优先），保证「展示价」与「下单价」同源。
 */
function priceOf(doc, planId, months) {
  const eff = effectivePrice(doc, planId, months);
  if (eff.ok) return { months: eff.months, price: eff.price, label: eff.label };
  return { months: clampMonths(months), price: 0, label: '' };
}

function clampMonths(months) {
  const n = Math.round(Number(months) || 0);
  if (n < 1) return 1;
  if (n > MAX_MONTHS) return MAX_MONTHS;
  return n;
}

/** 客户端可见的套餐目录（不含任何后台敏感字段） */
/**
 * 客户端可见的套餐目录。
 * - priceOptions：旧版平铺档位（**只含生效中**，兼容已发布的插件版本，字段语义不变）
 * - priceItems：v3 价格条目（含 cycle / 生效时段 / 折合月单价），供新版客户端展示
 *   「按月 / 按季 / 按年」与「即将生效」；未生效条目只出现在 upcoming 里且不可下单。
 */
function plansForClient(doc, now) {
  const t = now || Date.now();
  const plans = Object.values(doc.plans || {})
    .sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0))
    .map((p) => ({
      id: p.id, name: p.name, rank: Number(p.rank) || 0,
      price: Number(p.price) || 0, currency: p.currency || 'CNY',
      dailyLimit: dailyLimitFor(doc, p.id),
      highTierModels: !!p.highTierModels,
      monthlyGrantMicro: Number(p.monthlyGrantMicro) || 0,   // 1.6.0 订阅每月发放额度
      tagline: p.tagline || '',
      features: Array.isArray(p.features) ? p.features : [],
      // purchasable = 有生效价格 → 可下单；grantable = 可被开通/发激活码（与价格无关）
      purchasable: hasActivePrice(doc, p.id, t),
      grantable: p.id !== 'Free',
    }));
  const priceOptions = [];
  const active = [];
  const upcoming = [];
  const base = (it) => ({
    id: it.id, plan: it.plan, cycle: it.cycle, cycleName: cycleName(it.cycle),
    months: it.months, price: it.price, currency: planOf(doc, it.plan).currency || 'CNY',
    label: it.label || monthsLabel(it.months, it.cycle),
    perMonth: it.months > 0 ? Math.round((it.price / it.months) * 100) / 100 : 0,
    effectiveFrom: it.effectiveFrom, effectiveTo: it.effectiveTo,
    priority: Number(it.priority) || 0,
  });
  // 未生效的照旧只进 upcoming（可预告，不可下单）
  for (const it of (doc.priceItems || [])) {
    if (priceState(it, t) !== 'scheduled') continue;
    upcoming.push(Object.assign({ state: 'scheduled' }, base(it)));
  }
  // 生效中的按「每周期唯一胜者」下发（时段重叠时高优先级者胜）
  for (const pid of Object.keys(doc.plans || {})) {
    for (const it of activeWinnerMap(doc, pid, t)) {
      active.push(base(it));
      priceOptions.push({ plan: it.plan, months: it.months, price: it.price,
        label: it.label || '', currency: planOf(doc, it.plan).currency || 'CNY' });
    }
  }
  const cmp = (a, b) => (a.plan === b.plan ? a.months - b.months : a.plan < b.plan ? -1 : 1);
  active.sort(cmp);
  upcoming.sort(cmp);
  priceOptions.sort(cmp);
  return {
    plans, priceOptions,
    priceItems: active,
    upcoming: upcoming,
    cycles: CYCLE_PRESETS,
    pay: { channel: doc.pay.channel, qrImage: doc.pay.qrImage, qrText: doc.pay.qrText, note: doc.pay.note },
  };
}

/* ---------------- 会员状态 ---------------- */

/**
 * 用户的有效会员视图（等级 / 到期 / 剩余天数 / 额度 / 历史）。
 * 过期即降级展示为 Free，但**不踢下线**（额度回落，客户端下次 /me 或网关调用自然更新）。
 */
function membershipOf(doc, user) {
  const now = Date.now();
  const m = (user && user.membership) || {};
  const rawPlan = m.plan || (user && user.plan) || 'Free';
  let plan = rawPlan;
  let expired = false;
  let expMs = 0;
  if (m.expiresAt) expMs = Date.parse(m.expiresAt) || 0;
  else if (user && user.expiresAt) expMs = Date.parse(user.expiresAt) || 0;
  if (rawPlan !== 'Free' && expMs && now > expMs) { expired = true; plan = 'Free'; }
  // 永久会员：等级非 Free 且没有到期日（Free 无到期日不算永久）
  const perpetual = rawPlan !== 'Free' && !expMs;
  return {
    plan,
    name: planOf(doc, plan).name,
    rawPlan,
    expired,
    perpetual,
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    daysLeft: expMs ? Math.max(0, Math.ceil((expMs - now) / DAY_MS)) : null,
    dailyLimit: dailyLimitFor(doc, plan),
    source: m.source || (expMs ? 'legacy' : ''),
    activatedAt: m.activatedAt || null,
    history: Array.isArray(m.history) ? m.history.slice(-10) : [],
  };
}

/**
 * 开通/续期会员（唯一写入口）。续期 = max(现在, 现有到期) + 时长 —— 剩余时长不吞。
 * 同时同步兼容镜像 user.plan / user.expiresAt（旧客户端与旧管理接口都读它们）。
 */
function grantMembership(doc, user, opts) {
  const o = opts || {};
  const t = o.now || Date.now();
  const pid = planOf(doc, o.plan).id || 'Pro';
  const cur = (user && user.membership) || {};
  // 「已经是永久」＝同等级且无到期日（Free 不算）
  const curPerpetual = cur.plan === pid && !cur.expiresAt;
  const wantPerpetual = isPerpetual(o.cycle) || !!o.perpetual || Number(o.months) === 0 && o.months !== undefined;
  const keepPerpetual = wantPerpetual || curPerpetual;
  const monthsN = keepPerpetual ? 0 : clampMonths(o.months);
  // 永久：到期日置空；否则在「现有到期日」基础上叠加（剩余时长不吞）
  let expiresAt = null;
  if (!keepPerpetual) {
    const base = (cur.plan === pid && cur.expiresAt)
      ? Math.max(t, Date.parse(cur.expiresAt) || t)
      : t;
    expiresAt = new Date(base + monthsN * 30 * DAY_MS).toISOString();
  }
  const history = (Array.isArray(cur.history) ? cur.history : []).slice(-19);
  history.push({
    plan: pid, months: monthsN, perpetual: keepPerpetual,
    at: new Date(t).toISOString(), source: o.source || 'manual', refId: o.refId || '', note: o.note || '',
  });
  user.membership = {
    plan: pid,
    name: planOf(doc, pid).name,
    months: monthsN,
    perpetual: keepPerpetual,
    activatedAt: new Date(t).toISOString(),
    expiresAt,
    source: o.source || 'manual',
    refId: o.refId || '',
    history,
  };
  user.plan = pid;                      // 兼容镜像
  user.expiresAt = expiresAt;           // 兼容镜像（永久为 null）
  return membershipOf(doc, user);
}

/* ---------------- 订单 ---------------- */

function orderOut(doc, o) {
  return {
    id: o.id, plan: o.plan, planName: planOf(doc, o.plan).name,
    // 1.6.0 订单类型：plan = 买会员时长；credit = 买 AI 余额（核销后加余额）
    kind: o.kind === 'credit' ? 'credit' : 'plan',
    creditMicro: Number(o.creditMicro) || 0,
    bonusMicro: Number(o.bonusMicro) || 0,
    months: o.months, amount: o.amount, currency: o.currency || 'CNY',
    // 1.4.5 对账信息：实付（含唯一尾数）/ 原始价 / 尾数，全部用「分」表达，避免浮点误差
    amountCents: amountCentsOf(o),
    baseCents: baseCentsOf(o),
    tailCents: Number.isFinite(o.tailCents) ? Number(o.tailCents) : null,
    amountText: '¥' + (amountCentsOf(o) / 100).toFixed(2),
    // 优惠券（1.4.6）：折前价 / 折扣额 / 券码。discountText 为 '−¥x.xx'，便于直接贴 UI
    originalCents: originalCentsOf(o),
    originalText: '¥' + (originalCentsOf(o) / 100).toFixed(2),
    discountCents: Number(o.discountCents) || 0,
    discountText: Number(o.discountCents) > 0
      ? '−¥' + (Number(o.discountCents) / 100).toFixed(2) : '',
    couponId: o.couponId || null,
    couponCode: o.couponCode || null,
    perpetual: !!o.perpetual || Number(o.months) === 0,
    status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt,
    claimedAt: o.claimedAt || null, fulfilledAt: o.fulfilledAt || null,
    cancelledAt: o.cancelledAt || null, cancelReason: o.cancelReason || '',
    note: o.note || '',
    // 价格溯源（v3）：这一单落在哪条价格条目上、什么计费周期、折合月单价
    priceItemId: o.priceItemId || null,
    cycle: o.cycle || cycleOfMonths(o.months),
    cycleName: cycleName(o.cycle || cycleOfMonths(o.months)),
    priceSource: o.priceSource || 'base',
    unitPrice: typeof o.unitPrice === 'number' ? o.unitPrice : null,
    pay: { channel: doc.pay.channel, qrImage: doc.pay.qrImage, qrText: doc.pay.qrText, note: doc.pay.note },
  };
}

/** 惰性过期：未支付（pending/claimed）超过 TTL 的订单落为 expired */
function reapOrders(doc, now) {
  const t = now || Date.now();
  let changed = false;
  for (const o of doc.orders) {
    if ((o.status === 'pending' || o.status === 'claimed') && (t - Date.parse(o.createdAt)) > ORDER_TTL_MS) {
      o.status = 'expired';
      o.updatedAt = new Date(t).toISOString();
      coupon.releaseUseByOrder(doc, o.id);   // 超时回收 → 释放券名额
      changed = true;
    }
  }
  return changed;
}

/** 订单是否仍占用尾数（终态订单的尾数可回收） */
function tailActive(o) {
  return !!o && (o.status === 'pending' || o.status === 'claimed');
}

/** 订单的原始价（分）。兼容只有 amount（元）或只有 amountCents 的历史订单 */
function baseCentsOf(o) {
  if (!o) return 0;
  if (Number.isFinite(o.baseCents) && o.baseCents > 0) return Math.round(o.baseCents);
  if (Number.isFinite(o.amountCents) && o.amountCents > 0 && Number.isFinite(o.tailCents)) {
    return Math.round(o.amountCents - o.tailCents);
  }
  return Math.round((Number(o.amount) || 0) * 100);
}

/** 订单折前价（分）：老订单没有 originalCents → 折后价 + 折扣额（无折扣时两者相等） */
function originalCentsOf(o) {
  if (!o) return 0;
  if (Number.isFinite(o.originalCents) && o.originalCents > 0) return Math.round(o.originalCents);
  return baseCentsOf(o) + (Number(o.discountCents) || 0);
}

/** 订单实付金额（分）：优先 amountCents，旧数据由 amount（元）换算 */
function amountCentsOf(o) {
  if (!o) return 0;
  if (Number.isFinite(o.amountCents) && o.amountCents > 0) return Math.round(o.amountCents);
  return Math.round((Number(o.amount) || 0) * 100);
}

/**
 * 给 baseCents 分配一个**同金额内唯一**的尾数（分，1..99）。
 * 随机起点 + 线性探测：既让尾数分散（看不出规律、不好猜），又保证同金额内不重复。
 * 99 个都被活跃订单占用 → 明确报错，而不是把两笔订单做成同一个金额（那会让对账无法区分）。
 */
function assignTail(doc, baseCents, opts) {
  const rng = opts && typeof opts.rng === 'function' ? opts.rng : Math.random;
  const used = new Set();
  for (const o of (doc.orders || [])) {
    if (!tailActive(o)) continue;
    if (baseCentsOf(o) !== baseCents) continue;
    const t = Number(o.tailCents);
    if (t >= TAIL_MIN && t <= TAIL_MAX) used.add(t);
  }
  const span = TAIL_MAX - TAIL_MIN + 1;
  if (used.size >= span) {
    return { error: '该价格的待支付/待核销订单已占满 ' + span + ' 个尾数。'
      + '请先处理这些订单（核销或取消）后再下单，避免两笔订单金额相同而无法对账。' };
  }
  const r = Number(rng());
  const seed = Number.isFinite(r) ? Math.max(0, Math.min(0.9999999, r)) : 0;
  const start = TAIL_MIN + Math.floor(seed * span);
  for (let i = 0; i < span; i++) {
    const t = TAIL_MIN + ((start - TAIL_MIN + i) % span);
    if (!used.has(t)) return { tailCents: t, used: used.size };
  }
  return { error: '尾数分配失败（无可用尾数）' };
}

/** 下单。cycle === 'perpetual'（或 months === 0）→ 永久会员订单 */
function createOrder(doc, opts) {
  const o = opts || {};
  const pid = planOf(doc, o.plan).id || String(o.plan || 'Pro');
  const p = planOf(doc, pid);
  const perpetual = isPerpetual(o.cycle) || Number(o.months) === 0;
  const m = perpetual ? 0 : clampMonths(o.months);
  const eff = effectivePrice(doc, pid, m);
  if (eff.error) return { error: eff.error };
  if (!(eff.price > 0)) return { error: '该套餐无需购买（' + p.name + '）' };
  const originalCents = Math.round(eff.price * 100);
  if (originalCents < 100 + TAIL_MAX) return { error: '价格过低（需至少 ¥1.99），无法分出对账尾数' };
  // 优惠券：只把应付金额降下来。**尾数必须在折后金额上分配** ——
  // 否则两张折前同价、折后不同的订单会共用同一批尾数，「按金额唯一对账」就失效了。
  let couponDoc = null;
  let discountCents = 0;
  if (o.couponCode) {
    const q = coupon.quote(doc, {
      code: o.couponCode, plan: pid, months: m,
      baseCents: originalCents, userId: o.user && o.user.id,
      now: Number.isFinite(o.now) ? o.now : Date.now(),
    });
    if (!q.ok) return { error: q.error };
    couponDoc = q.coupon;
    discountCents = q.discountCents;
  }
  const baseCents = originalCents - discountCents;
  if (baseCents < 100 + TAIL_MAX) return { error: '折扣后金额过低（需至少 ¥1.99），无法分出对账尾数' };
  const tail = assignTail(doc, baseCents, { rng: o.rng });
  if (tail.error) return { error: tail.error };
  const amountCents = baseCents + tail.tailCents;
  const now = new Date().toISOString();
  const order = {
    id: rid('o', 6),
    userId: o.user.id, email: o.user.email,
    plan: pid, months: m,
    perpetual,
    // amount 仍保留（元，含尾数）以兼容既有 UI/插件；精确比较一律用 *_Cents
    amount: amountCents / 100,
    amountCents, baseCents, tailCents: tail.tailCents,
    // 优惠券溯源：折前价 / 折扣额 / 券标识。金额一律用「分」，amount（元）只兼容旧 UI
    originalCents,
    discountCents,
    couponId: couponDoc ? couponDoc.id : null,
    couponCode: couponDoc ? couponDoc.code : null,
    currency: p.currency || 'CNY',
    status: 'pending',
    createdAt: now, updatedAt: now,
    claimedAt: null, fulfilledAt: null, cancelledAt: null, cancelReason: '',
    codeId: null, note: '',
    // 价格溯源（对账用）：这一单是按哪条价格条目、什么周期算出来的
    priceItemId: eff.itemId, cycle: eff.cycle, priceSource: eff.source,
    unitPrice: m > 0 ? Math.round((eff.price / m) * 100) / 100 : eff.price,
  };
  doc.orders.push(order);
  // 占住名额（**不是消耗**）：订单超时/取消会释放，只有核销才真正消耗
  if (couponDoc) {
    coupon.reserveUse(couponDoc, {
      orderId: order.id, userId: order.userId, email: order.email,
      discountCents, now: Number.isFinite(o.now) ? o.now : Date.now(),
    });
  }
  return { order };
}

/**
 * 充值订单（1.6.0）：买的是「AI 余额」而不是会员时长。
 * 与会员订单共用同一套生命周期（pending → claimed → fulfilled/expired）与
 * **唯一尾数对账**，只有核销后的副作用不同（加余额而不是开通会员）。
 * 金额一律用「分」；到账额度 creditMicro 由调用方按 1 分 = 1e4 微元换算传入。
 * @param {{user:object, cents:number, creditMicro:number, bonusMicro?:number, label?:string, rng?:function}} opts
 */
function createCreditOrder(doc, opts) {
  const o = opts || {};
  const cents = Math.round(Number(o.cents) || 0);
  if (cents < 100 + TAIL_MAX) return { error: '充值金额过低（需至少 ¥1.99），无法分出对账尾数' };
  const creditMicro = Math.max(0, Math.round(Number(o.creditMicro) || 0));
  if (creditMicro <= 0) return { error: '到账额度必须大于 0' };
  const tail = assignTail(doc, cents, { rng: o.rng });
  if (tail.error) return { error: tail.error };
  const amountCents = cents + tail.tailCents;
  const now = new Date().toISOString();
  const order = {
    id: rid('o', 6),
    kind: 'credit',
    userId: o.user.id, email: o.user.email,
    plan: null, months: 0, perpetual: false,
    amount: amountCents / 100, amountCents, baseCents: cents, tailCents: tail.tailCents,
    originalCents: cents, discountCents: 0, couponId: null, couponCode: null,
    currency: 'CNY', status: 'pending',
    createdAt: now, updatedAt: now,
    claimedAt: null, fulfilledAt: null, cancelledAt: null, cancelReason: '',
    codeId: null, note: String(o.label || 'AI 额度充值').slice(0, 80),
    priceItemId: null, cycle: null, priceSource: 'credit',
    creditMicro,
    // 充值赠送（如充 ¥30 到账 ¥33）：随充值一并进「充值余额」，**不单独设有效期**
    //
    // ——它是购买的附属物，不是独立赠品；让送的钱过期只会招来客诉。
    bonusMicro: Math.max(0, Math.round(Number(o.bonusMicro) || 0)),
    unitPrice: null,
  };
  doc.orders.push(order);
  return { order };
}

function findOrder(doc, id) {
  return doc.orders.find((o) => o && o.id === id) || null;
}

function claimOrder(doc, order, user) {
  if (!order || order.userId !== user.id) return { error: '订单不存在' };
  if (order.status === 'pending') {
    order.status = 'claimed';
    order.claimedAt = new Date().toISOString();
    order.updatedAt = order.claimedAt;
  } else if (order.status !== 'claimed') {
    return { error: '当前订单状态（' + orderStatusText(order.status) + '）无需再次提交' };
  }
  return { order };
}

function cancelOrder(doc, order, user, reason) {
  if (!order || order.userId !== user.id) return { error: '订单不存在' };
  if (order.status === 'fulfilled') return { error: '订单已完成，无法取消' };
  if (order.status === 'cancelled') return { order };
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  order.updatedAt = order.cancelledAt;
  order.cancelReason = String(reason || '用户取消').slice(0, 60);
  coupon.releaseUseByOrder(doc, order.id);   // 取消 → 释放券名额（没付款就不该占额度）
  return { order };
}

/**
 * 核销订单（管理员）：给下单账号开通会员，同时生成一枚**已使用**的兑换码留档对账。
 * 幂等：已 fulfilled 的订单重复调用不重复开通。
 * ★ 充值订单（kind='credit'）不生成留档码：它的凭据就是 user.balance 的流水条目。
 */
function fulfillOrder(doc, order, { by, now } = {}) {
  const t = now || Date.now();
  if (!order) return { error: '订单不存在' };
  if (order.status === 'fulfilled') return { error: '订单已核销，无需重复操作' };
  if (order.status === 'cancelled') return { error: '订单已取消，无法核销' };
  const isCredit = order.kind === 'credit';
  let code = null;
  if (!isCredit) {
    code = {
      id: rid('c', 6), code: newCode(),
      plan: order.plan, months: order.months,
      createdAt: new Date(t).toISOString(), createdBy: String(by || 'admin'),
      note: '订单 ' + order.id + ' 核销留档',
      boundTo: order.userId, orderId: order.id,
      usedAt: new Date(t).toISOString(), usedBy: order.userId,
    };
    doc.codes.push(code);
    order.codeId = code.id;
  }
  order.status = 'fulfilled';
  order.fulfilledAt = new Date(t).toISOString();
  order.updatedAt = order.fulfilledAt;
  coupon.consumeUseByOrder(doc, order.id);   // 核销 = 券真正消耗
  return { order, code };
}

function orderStatusText(s) {
  return { pending: '待支付', claimed: '待核销', fulfilled: '已开通',
    cancelled: '已取消', expired: '已过期' }[s] || s;
}

/* ---------------- 激活码 ---------------- */

function codeOut(c) {
  return {
    id: c.id, code: c.code, plan: c.plan, months: c.months,
    createdAt: c.createdAt, createdBy: c.createdBy || '', note: c.note || '',
    boundTo: c.boundTo || null, orderId: c.orderId || null,
    expiresAt: c.expiresAt || null,
    usedAt: c.usedAt || null, usedBy: c.usedBy || null,
    status: c.usedAt ? 'used' : (c.expiresAt && Date.now() > Date.parse(c.expiresAt) ? 'expired' : 'unused'),
  };
}

function createCodes(doc, { plan, months, count, note, by, expiresAt, boundTo }) {
  const pid = planOf(doc, plan).id;
  if (!pid || pid === 'Free') return { error: '免费版无需激活码' };
  const n = Math.min(Math.max(Math.round(Number(count) || 1), 1), 200);
  const m = clampMonths(months);
  const out = [];
  for (let i = 0; i < n; i++) {
    let code = newCode();
    // 极小概率碰撞：重生成
    while (doc.codes.some((c) => normCode(c.code) === code)) code = newCode();
    const rec = {
      id: rid('c', 6), code, plan: pid, months: m,
      createdAt: new Date().toISOString(), createdBy: String(by || 'admin'),
      note: String(note || '').slice(0, 80),
      boundTo: boundTo || null, orderId: null,
      expiresAt: expiresAt || null,
      usedAt: null, usedBy: null,
    };
    doc.codes.push(rec);
    out.push(codeOut(rec));
  }
  return { codes: out };
}

function findCode(doc, code) {
  const c = normCode(code);
  if (!c) return null;
  return doc.codes.find((x) => x && normCode(x.code) === c) || null;
}

/**
 * 兑换（用户）：校验 → 绑定 → 开通。
 * 失败原因都写成可读中文，客户端直接展示。
 */
function redeem(doc, code, user, now) {
  const t = now || Date.now();
  const rec = findCode(doc, code);
  if (!rec) return { error: '激活码不存在，请核对后重试（形如 PP-XXXX-XXXX-XXXX）' };
  if (rec.usedAt) {
    return { error: '该激活码已于 ' + new Date(rec.usedAt).toLocaleDateString() + ' 被使用' };
  }
  if (rec.expiresAt && t > Date.parse(rec.expiresAt)) return { error: '该激活码已过期' };
  if (rec.boundTo && rec.boundTo !== user.id) return { error: '该激活码已绑定其他账号，无法在本账号使用' };
  rec.usedAt = new Date(t).toISOString();
  rec.usedBy = user.id;
  if (!rec.boundTo) rec.boundTo = user.id;
  const membership = grantMembership(doc, user, {
    plan: rec.plan, months: rec.months,
    source: rec.orderId ? 'order' : 'code',
    refId: rec.id, note: rec.note || '',
  });
  return { membership, code: codeOut(rec) };
}

module.exports = {
  DAY_MS, ORDER_TTL_MS, MAX_MONTHS,
  DEFAULT_PLANS, DEFAULT_PRICE_OPTIONS, DEFAULT_PAY, DEFAULT_AI,
  CYCLE_PRESETS, PRICE_STATE_TEXT,
  newDoc, normalize, newCode, normCode,
  planOf, dailyLimitFor, priceOf, clampMonths, plansForClient, trialState, trialDaysFor,
  // v3 价格表
  cycleOfMonths, cycleName, isoOrNull, priceState, sanitizePriceItem,
  migratePriceOptions, derivePriceOptions, priceItemOut,
  priceRank, pickPriceWinner, activeWinnerMap, findPriceOverlaps, coverageGapAfter,
  upsertPriceItem, removePriceItem, hasActivePrice, effectivePrice, rangesOverlap,
  membershipOf, grantMembership,
  orderOut, reapOrders, createOrder, createCreditOrder, findOrder, claimOrder, cancelOrder, fulfillOrder,
  PERPETUAL, isPerpetual, monthsLabel, TAIL_MIN, TAIL_MAX,
  tailActive, baseCentsOf, amountCentsOf, originalCentsOf, assignTail,
  orderStatusText,
  codeOut, createCodes, findCode, redeem,
};
