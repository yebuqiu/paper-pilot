#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 会员面板渲染测试（插件 0.24.4）
 *
 * 为什么要有它：设置面板脚本（chrome/content/prefs-account.js）跑在 Zotero 设置窗口里，
 * 无人环境点不了。这里用「迷你 DOM + 假 Account」把它**真跑一遍**，断言：
 *   #4 价格档位来自价格表（周期名 + 折合月单价）、未生效价格以灰底预告出现且不可点；
 *   #5 剩余 ≤7 天出现续费横幅、已到期转红、默认档位取「上次购买的周期」；
 *   #11 消耗块画出近 7 天柱状图并显示今日/近 7 天金额（次数上限已取消）；老服务端（无趋势）时整块隐藏。
 *
 * 运行：node test/membership-panel.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const PANEL = path.join(ROOT, 'chrome', 'content', 'prefs-account.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { text: String(hay).slice(0, 160), want: needle });
}

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {};
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false;
    this.checked = false; this.handlers = {};
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = v; else this._attrs[k] = v;
  }
  getAttribute(k) { return k === 'class' ? this.className : (k in this._attrs ? this._attrs[k] : null); }
  removeAttribute(k) { if (k === 'class') this.className = ''; else delete this._attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { this.handlers[ev] = fn; }
  removeEventListener(ev) { delete this.handlers[ev]; }
  click() { if (this.handlers.click) return this.handlers.click({ preventDefault() {} }); return undefined; }
  focus() {}
  scrollIntoView() {}
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(v) {
    this.children.forEach((c) => { c.parentNode = null; });
    this._text = ''; this.children = []; if (v) this._text = String(v);
  }
  get innerHTML() { return this.textContent; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  /** 深度优先收集所有节点（便于断言） */
  all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
  byClass(cls) { return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(cls) >= 0); }
}

function makeDom(html) {
  const ids = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  const registry = new Map();
  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
    body: new El('body'),
  };
  // 面板里有「面板已关」守卫（!el.parentNode 就跳过渲染），所以迷你 DOM 必须让
  // 已有元素**挂在文档上**，否则这类守卫会静默吃掉整段渲染（曾经就是这么误判的）。
  for (const id of ids) {
    const el = new El('div');
    el.parentNode = document.body;
    document.body.children.push(el);
    registry.set(id, el);
  }
  return { document, registry };
}

/* ---------------- 假 Account / Channels ---------------- */

const DAY = 86400e3;
const isoDay = (n) => {
  const d = new Date(Date.now() + n * DAY);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

const PLANS_PAYLOAD = {
  plans: [{ id: 'Free', name: '免费版', rank: 0, features: ['注册赠送 ¥6 额度'] },
    { id: 'Pro', name: '专业版', rank: 1, monthlyGrantMicro: 20000000, features: ['每月发放 ¥20 AI 额度', '全部官方模型'] }],
  priceOptions: [{ plan: 'Pro', months: 1, price: 29, label: '1 个月' }],
  priceItems: [
    { id: 'p1', plan: 'Pro', cycle: 'monthly', cycleName: '按月', months: 1, price: 29, perMonth: 29, label: '按月' },
    { id: 'p3', plan: 'Pro', cycle: 'quarterly', cycleName: '按季', months: 3, price: 79, perMonth: 26.33, label: '按季' },
    { id: 'p12', plan: 'Pro', cycle: 'yearly', cycleName: '按年', months: 12, price: 269, perMonth: 22.42, label: '按年' },
  ],
  upcoming: [{ id: 'p6', plan: 'Pro', cycle: 'halfyear', cycleName: '半年', months: 6, price: 149,
    perMonth: 24.83, label: '半年', effectiveFrom: '2026-11-11T00:00:00.000Z' }],
  cycles: [],
  pay: { channel: '微信收款码', note: '备注订单号' },
  // 0.26.0 充值档位
  rechargeOptions: [
    { id: 'rc10', cents: 1000, creditCents: 1000, bonusCents: 0, label: '¥10', amountText: '¥10.00', creditText: '¥10.00', bonusText: '' },
    { id: 'rc30', cents: 3000, creditCents: 3300, bonusCents: 300, label: '¥30 · 到账 ¥33', amountText: '¥30.00', creditText: '¥33.00', bonusText: '送 ¥3.00' },
  ],
  // 0.50.0 在线支付可用性（服务端 1.7.0+ 下发）
  onlinePay: { available: true, channels: [{ id: 'alipay', text: '支付宝' }] },
  // 1.8.4 唯一尾数开关（本夹具默认开启，便于验证「提尾数」文案；F19 单独验证关闭态）
  tailEnabled: true,
};

function fakeAccount(over) {
  const base = Object.assign({
    isLoggedIn: () => true,
    user: () => ({ email: 'me@test.local', name: '我', plan: 'Pro' }),
    expiresAt: () => Date.now() + 30 * DAY,
    serverUrl: () => 'https://pp.example.com',
    persistStatus: { attempted: 1, ok: true },
    membership: () => ({ plan: 'Pro', name: '专业版', rawPlan: 'Pro', expired: false,
      expiresAt: Date.now() + 3 * DAY, source: 'order',
      history: [{ plan: 'Pro', months: 1, at: '2026-09-01T00:00:00Z' },
        { plan: 'Pro', months: 12, at: '2026-10-01T00:00:00Z' }] }),
    isPro: () => true,
    membershipDaysLeft: () => 3,
    renewalReminder: () => ({ daysLeft: 3, expired: false, expiresAt: Date.now() + 3 * DAY, key: 'k' }),
    lastPurchasedMonths: () => 12,
    // 0.46.0 消耗趋势：按金额（微元）画图，不再有次数/上限
    cost: () => ({
      today: { costMicro: 50000, text: '¥0.05' },
      last7: { costMicro: 170000, text: '¥0.17' },
      last30: null,
      days: Array.from({ length: 7 }, (_, i) => ({ date: isoDay(i - 6), micro: i === 6 ? 50000 : 20000 })),
      last: null,
    }),
    // 0.26.0 AI 额度余额（默认三档都有值，便于断言分档展示）
    balance: () => ({
      totalMicro: 26100000, grantedMicro: 6000000, planMicro: 1000000, paidMicro: 19100000,
      text: '¥26.10', grantedText: '¥6.00', planText: '¥1.00', paidText: '¥19.10',
      grantedDaysLeft: 21, planDaysLeft: 12,
      grantedExpiresAt: '2026-10-25T00:00:00.000Z', planExpiresAt: '2026-10-31T16:00:00.000Z',
      planPeriodKey: '2026-10', enforce: true, minBalanceMicro: 1000000, overdraft: false,
    }),
    refreshUser: async () => null,
    plans: async () => PLANS_PAYLOAD,
    // 1.4.9 套餐 AI 能力（同步方法——面板是同步读取后立即渲染的）
    ai: () => ({ highTier: true, reason: 'plan', trial: null,
      models: ['auto', 'glm-5.3-flash'], lockedModels: [], defaultModel: 'auto' }),
    onSessionChanged: () => () => {},
  }, over || {});
  return new Proxy(base, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      if (k === 'then') return undefined;
      return async () => null;      // 未 stub 的异步方法一律 null，避免未捕获拒绝
    },
  });
}

/* 通道模块只需足够让 renderAccount/renderChannels 跑完（会员面板不依赖它） */
const fakeChannels = {
  OFFICIAL_ID: '__official__',
  PROVIDERS: [],
  list: () => ({ channels: [], active: null }),
  getChannel: () => ({ id: '__official__', model: 'auto', models: ['auto'] }),
  fetchModels: async () => ({ ok: true, models: [] }),
  upsert: () => ({ ok: true }),
  setActive: () => ({ ok: true }),
  testChannel: async () => ({ ok: true }),
  detectChannel: async () => ({ ok: true }),
  remove: () => ({ ok: true }),
  providerOf: () => null,
  activeChannel: () => null,
};

function boot(accountOver) {
  const { document, registry } = makeDom(fs.readFileSync(XHTML, 'utf8'));
  const prefs = new Map();
  const launched = [];
  const sandbox = {
    console,
    document,
    Zotero: {
      locale: 'zh-CN',
      Papilot: { account: fakeAccount(accountOver), channels: fakeChannels },
      Prefs: { get: (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: (k, v) => prefs.set(k, v) },
      getMainWindow: () => null,
      // 0.50.0 在线支付：记录被打开的收银台地址（断言用）
      launchURL: (u) => { launched.push(String(u)); },
    },
    window: {
      setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {},
      addEventListener: () => {}, confirm: () => false, prompt: () => null,
    },
    Components: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), sandbox, { filename: 'prefs-account.js' });
  return { registry, prefs, sandbox, launched };
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  /* ============ 0. 免费版 vs 专业版对照表（静态结构） ============
   * 表格是 xhtml 里的静态结构（不靠 Account 数据渲染），所以这里直接扫源码：
   * 断言差异项齐全、专业版列有高亮类、样式已挂，避免「表格写了但样式没跟上」
   * 或「文案与真实门控不一致」（第三方文献源只有 Pro 可用）。 */
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'prefs.css'), 'utf8');
    ok(xhtml.indexOf('id="pp-mb-compare"') >= 0, 'Z1 ★ 会员卡片内含「免费版 vs 专业版」对照表');
    has(xhtml, '免费版 vs 专业版', 'Z2 表格标题');
    has(xhtml, 'AI 额度', 'Z3 对照项：AI 额度');
    has(xhtml, '每月 ¥20', 'Z4 专业版每月 ¥20 额度');
    has(xhtml, '注册赠送 ¥6', 'Z5 免费版注册赠送 ¥6');
    has(xhtml, '全部官方模型', 'Z6 专业版开放全部官方模型');
    has(xhtml, 'deepseek-v4-flash', 'Z7 免费版模型范围写清楚（基础模型）');
    has(xhtml, '第三方文献源', 'Z8 对照项：第三方文献源');
    has(xhtml, '检索订阅 / 云同步', 'Z9 共有能力如实标注（免费版也有）');
    const yes = (xhtml.match(/pp-cmp-yes/g) || []).length;
    ok(yes >= 8, 'Z10 ★ 共有/可用项用 ✓ 标注（至少 8 处）', yes);
    const pro = (xhtml.match(/pp-cmp-pro/g) || []).length;
    ok(pro >= 6, 'Z11 ★ 专业版整列带高亮类 pp-cmp-pro', pro);
    ok(css.indexOf('.pp-mb-compare') >= 0 && css.indexOf('--pp-accent-weak') >= 0,
      'Z12 ★ 对照表样式已挂（专业版列浅色底）');
    ok(css.indexOf('.pp-cmp-yes') >= 0 && css.indexOf('--pp-success') >= 0,
      'Z13 ✓ 用成功色（深浅主题都可见）');
  }

  /* ============ A. Pro 用户：剩余 3 天 + 用量趋势 ============ */
  let { registry } = boot({});

  const renew = registry.get('pp-mb-renew');
  ok(renew.style.display !== 'none', 'A1 剩余 ≤7 天 → 续费横幅出现', renew.style.display);
  has(renew.textContent, '仅剩 3 天', 'A2 横幅说明剩余天数');
  has(renew.textContent, '点此续费', 'A3 横幅提示可点');
  ok(!/expired/.test(renew.className), 'A4 未到期时不是危险样式', renew.className);

  const usage = registry.get('pp-mb-usage');
  ok(usage.style.display !== 'none', 'A5 消耗块出现');
  has(usage.textContent, '今日 ¥0.05', 'A6 显示今日消耗金额');
  has(usage.textContent, '近 7 天 ¥0.17', 'A7 显示近 7 天消耗合计');
  ok(!/次/.test(usage.textContent), 'A7b ★ 不再出现调用次数/次数上限文案');
  const bars = usage.byClass('pp-mb-bar');
  eq(bars.length, 7, 'A8 画出 7 根柱子');
  const cols = usage.byClass('pp-mb-bar-col');
  eq(cols.length, 7, 'A9 7 个柱位（含日期标签）');
  ok(bars.some((b) => parseInt(b.style.height, 10) > 2), 'A10 有非零柱高', bars.map((b) => b.style.height));
  const dayLabels = usage.byClass('pp-mb-bar-day');
  eq(dayLabels.length, 7, 'A11 每根柱都有日期标签');
  eq(dayLabels[6].textContent, isoDay(0).slice(8, 10), 'A12 最后一根是今天');

  /* ============ B. 续费面板：价格表档位 + 预告 ============ */
  renew.click();                       // 打开续费面板（等价于点「续费专业版」）
  await flush(); await flush(); await flush();

  const order = registry.get('pp-mb-order');
  ok(order.style.display !== 'none', 'B1 点横幅 → 续费面板打开');
  const opts = registry.get('pp-mb-options');
  const chips = opts.children.filter((c) => !/soo?n/.test(c.className) && /pp-mb-opt/.test(c.className));
  eq(chips.length, 3, 'B2 生效中 3 个档位（来自 priceItems）', chips.map((c) => c.textContent));
  has(chips[0].textContent, '按月 · ¥29', 'B3 档位显示中文周期名与价格');
  has(chips[1].textContent, '折合 ¥26.33/月', 'B4 多周期档位显示折合月单价');
  has(chips[2].textContent, '折合 ¥22.42/月', 'B5 按年档位折合价正确');
  ok(!/折合/.test(chips[0].textContent), 'B6 按月档位不显示多余的折合价');

  const soon = opts.children.filter((c) => /pp-mb-opt-soon/.test(c.className));
  eq(soon.length, 1, 'B7 未生效价格以预告形式出现');
  has(soon[0].textContent, '即将生效', 'B8 预告标注「即将生效」');
  has(soon[0].textContent, '2026-11-11', 'B9 预告带生效日期');
  eq(soon[0].handlers.click, undefined, 'B10 预告不可点（没绑 click）');

  const on = chips.filter((c) => /pp-mb-opt-on/.test(c.className));
  eq(on.length, 1, 'B11 恰有一个默认选中档位');
  has(on[0].textContent, '按年', 'B12 默认档位 = 上次购买的 12 个月');

  /* ============ C. 已过期：横幅转红 + 文案变化 ============ */
  ({ registry } = boot({
    membershipDaysLeft: () => 0,
    isPro: () => false,
    renewalReminder: () => ({ daysLeft: 0, expired: true, expiresAt: Date.now() - 2 * DAY, key: 'e' }),
    membership: () => ({ plan: 'Free', name: '免费版', rawPlan: 'Pro', expired: true,
      expiresAt: Date.now() - 2 * DAY, source: 'order', history: [{ plan: 'Pro', months: 1 }] }),
  }));
  const rb2 = registry.get('pp-mb-renew');
  ok(rb2.style.display !== 'none', 'C1 已过期 → 横幅仍出现');
  has(rb2.textContent, '已', 'C2 文案说明已到期');
  has(rb2.className, 'pp-mb-renew-expired', 'C3 已过期用危险样式（红色）');

  /* ============ D. 免费用户（无到期日）：不打扰 ============ */
  ({ registry } = boot({
    isPro: () => false,
    membership: () => ({ plan: 'Free', name: '免费版', rawPlan: 'Free', expired: false,
      expiresAt: 0, source: '', history: [] }),
    membershipDaysLeft: () => Infinity,
    renewalReminder: () => null,
    lastPurchasedMonths: () => null,
  }));
  eq(registry.get('pp-mb-renew').style.display, 'none', 'D1 免费用户不显示到期横幅');
  ok(registry.get('pp-mb-upgrade').textContent.indexOf('升级') >= 0, 'D2 按钮仍显示「升级专业版」');

  /* ============ E. 老服务端（无消耗趋势）：整块隐藏而不是画空图 ============ */
  ({ registry } = boot({
    cost: () => ({ today: null, last7: null, last30: null, days: [], last: null }),
  }));
  eq(registry.get('pp-mb-usage').style.display, 'none', 'E1 无趋势数据 → 消耗块隐藏');
  eq(registry.get('pp-mb-renew').style.display, '', 'E2 到期提醒不受影响（仍显示）');

  /* ============ F. 优惠码：试算 → 展示折后价 → 下单带券 ============ */
  let createdArgs = null;
  let validatedArgs = null;
  ({ registry } = boot({
    validateCoupon: async (code, plan, months, cycle) => {
      validatedArgs = { code: code, plan: plan, months: months, cycle: cycle };
      return { code: 'CP-AAAA-BBBB-CCCC', type: 'percent', label: '减 25%（75 折）',
        originalText: '¥269.00', discountText: '−¥67.25', payableText: '¥201.75', payableCents: 20175 };
    },
    createOrder: async (plan, months, cycle, couponCode) => {
      createdArgs = { plan: plan, months: months, cycle: cycle, couponCode: couponCode };
      return { id: 'o-cp1', plan: 'Pro', planName: '专业版', months: 12, status: 'pending',
        amountText: '¥201.85', baseCents: 20175, originalCents: 26900,
        originalText: '¥269.00', discountText: '−¥67.25', discountCents: 6725,
        couponCode: couponCode, tailCents: 10, pay: { channel: '微信收款码' } };
    },
  }));

  registry.get('pp-mb-upgrade').click();
  await flush(); await flush(); await flush();
  eq(registry.get('pp-mb-quote').style.display, 'none', 'F1 未应用优惠码时折后价区隐藏');

  registry.get('pp-mb-coupon').value = 'cp-aaaa-bbbb-cccc';
  registry.get('pp-mb-coupon-btn').click();
  await flush(); await flush(); await flush();
  eq(validatedArgs && validatedArgs.code, 'cp-aaaa-bbbb-cccc', 'F2 用户输入原样交给服务端校验');
  eq(validatedArgs && validatedArgs.months, 12, 'F3 带上当前档位月数（服务端据此算折前价）');
  has(registry.get('pp-mb-coupon-msg').textContent, '减 25%', 'F4 应用成功回显券的内容');

  const qbox = registry.get('pp-mb-quote');
  eq(qbox.style.display, '', 'F5 折后价区出现');
  has(qbox.textContent, '¥269.00', 'F6 显示折前价');
  has(qbox.textContent, '−¥67.25', 'F7 显示减免额');
  has(qbox.textContent, '¥201.75', 'F8 显示应付金额');
  has(qbox.textContent, '尾数', 'F9 提醒应付之外还会加对账尾数（避免用户以为被多收）');

  // 换档位必须作废已试算的折后价（否则用户会照着旧价格转账）
  const opts2 = registry.get('pp-mb-options');
  const chips2 = opts2.children.filter((c) => /pp-mb-opt/.test(c.className) && !/soo?n/.test(c.className));
  chips2[0].click();
  await flush();
  eq(registry.get('pp-mb-quote').style.display, 'none', 'F10 换档位 → 折后价区收起');
  has(registry.get('pp-mb-coupon-msg').textContent, '重新应用', 'F11 换档位提示需要重新应用优惠码');

  registry.get('pp-mb-coupon-btn').click();
  await flush(); await flush(); await flush();
  eq(registry.get('pp-mb-quote').style.display, '', 'F12 重新应用后折后价区回来');

  registry.get('pp-mb-create').click();
  await flush(); await flush(); await flush();
  eq(createdArgs && createdArgs.couponCode, 'CP-AAAA-BBBB-CCCC', 'F13 下单时把券码带上（用归一后的码）');
  const payInfo = registry.get('pp-mb-pay-info').textContent;
  has(payInfo, '折前 ¥269.00', 'F14 支付页显示折前价');
  has(payInfo, '−¥67.25', 'F15 支付页显示减免额');
  has(payInfo, '折后 ¥201.75', 'F16 支付页显示折后价');
  has(payInfo, '201.85', 'F17 转账金额仍是含尾数的实付（不是折后价）');
  has(payInfo, 'CP-AAAA-BBBB-CCCC', 'F18 支付页标注用了哪张券（便于对账）');

  // ---- F19：服务端关闭唯一尾数（1.8.4 默认）→ 折后价提示不再提尾数（所见即所付）----
  ({ registry } = boot({
    plans: async () => Object.assign({}, PLANS_PAYLOAD, { tailEnabled: false }),
    validateCoupon: async () => ({ code: 'CP-AAAA-BBBB-CCCC', type: 'percent',
      originalText: '¥269.00', discountText: '−¥67.25', payableText: '¥201.75', payableCents: 20175 }),
  }));
  registry.get('pp-mb-upgrade').click();
  await flush(); await flush(); await flush();
  registry.get('pp-mb-coupon').value = 'CP-AAAA-BBBB-CCCC';
  registry.get('pp-mb-coupon-btn').click();
  await flush(); await flush(); await flush();
  ok(registry.get('pp-mb-quote').textContent.indexOf('尾数') < 0,
    'F19 ★ 尾数关闭（默认）→ 折后价不再提尾数（所见即所付）');

  /* ============ G. 优惠码不可用 / 清除 ============ */
  ({ registry } = boot({
    validateCoupon: async () => { throw new Error('该优惠码需满 ¥100.00，本单折前 ¥29.00，未达门槛'); },
  }));
  registry.get('pp-mb-upgrade').click();
  await flush(); await flush(); await flush();
  registry.get('pp-mb-coupon').value = 'CP-AAAA-BBBB-CCCC';
  registry.get('pp-mb-coupon-btn').click();
  await flush(); await flush(); await flush();
  has(registry.get('pp-mb-coupon-msg').textContent, '未达门槛', 'G1 服务端给的原因原样告诉用户');
  eq(registry.get('pp-mb-quote').style.display, 'none', 'G2 失败时不显示折后价（绝不显示错的价）');
  ok(registry.get('pp-mb-order-msg').textContent.indexOf('✗') < 0, 'G3 券失败不影响正常下单流程');

  registry.get('pp-mb-coupon').value = '';
  registry.get('pp-mb-coupon-btn').click();
  await flush();
  has(registry.get('pp-mb-coupon-msg').textContent, '已清除', 'G4 清空输入即取消已应用的券');
  eq(registry.get('pp-mb-quote').style.display, 'none', 'G5 清除后折后价区收起');

  /* ============ H. 登录设备面板（0.24.7） ============ */
  let revokedSid = null;
  let renamed = null;
  let kickOthersCalled = 0;
  const DEVICES = {
    sessions: [
      { sid: 'cur00001', deviceId: 'aaaa1111-2222-3333-4444-555566667777', deviceLabel: null,
        platform: 'Windows 11', zoteroVersion: '10.0.5', lastSeenAt: new Date().toISOString(),
        ipMasked: '203.0.113.*', active: true, current: true, identified: true },
      { sid: 'oth00002', deviceId: 'bbbb1111-2222-3333-4444-555566667777', deviceLabel: '办公室台式',
        platform: 'Windows 10', zoteroVersion: '10.0.5', lastSeenAt: new Date().toISOString(),
        ipMasked: '198.51.100.*', active: true, current: false, identified: true },
      { sid: 'oth00003', deviceId: null, deviceLabel: null,
        platform: null, zoteroVersion: null, lastSeenAt: new Date().toISOString(),
        ipMasked: '203.0.113.*', active: true, current: false, identified: false },
    ],
    activeCount: 3, activeDays: 7, maxDevices: 3, overLimit: false, identified: true, hint: '',
  };
  let booted = boot({
    sessions: async () => DEVICES,
    revokeSession: async (sid) => { revokedSid = sid; return { ok: true }; },
    renameSession: async (sid, label) => { renamed = { sid: sid, label: label }; return { ok: true }; },
    revokeOtherSessions: async () => { kickOthersCalled++; return { ok: true, revoked: 2 }; },
  });
  ({ registry } = booted);
  await flush(); await flush(); await flush();

  const devBlock = registry.get('pp-dev-block');
  eq(devBlock.style.display, '', 'H1 登录设备块出现');
  has(registry.get('pp-dev-stat').textContent, '活跃 3 台', 'H2 显示活跃设备数');
  has(registry.get('pp-dev-stat').textContent, '阈值 3 台', 'H3 显示阈值');
  has(registry.get('pp-dev-stat').textContent, '窗口 7 天', 'H4 显示活跃窗口（诚实表述：不是「在线」）');
  const devRows = registry.get('pp-dev-list').children.filter((c) => /pp-dev-row/.test(c.className));
  eq(devRows.length, 3, 'H5 列出 3 台设备');

  const curRow = devRows.filter((c) => /pp-dev-row-cur/.test(c.className));
  eq(curRow.length, 1, 'H6 恰有一台标为当前设备');
  has(curRow[0].textContent, '（本机）', 'H7 当前设备标注「本机」');
  const curLinks = [];
  (function walk(n) {
    if (!n) return;
    if (/pp-link/.test(n.className || '')) curLinks.push(n.textContent);
    (n.children || []).forEach(walk);
  })(curRow[0]);
  ok(curLinks.indexOf('踢出') < 0, 'H8 当前设备没有「踢出」入口（要退出请用登出）', curLinks);

  has(devRows[1].textContent, '办公室台式', 'H9 展示用户起的设备名');
  has(devRows[1].textContent, '198.51.100.*', 'H10 展示打码后的 IP（不是完整 IP）');
  has(devRows[2].textContent, '未上报设备标识', 'H11 未上报标识的设备如实说明');

  // 踢出一台
  let kickLink = null;
  (function walk(n) {
    if (!n || kickLink) return;
    if (/pp-link/.test(n.className || '') && n.textContent === '踢出') { kickLink = n; return; }
    (n.children || []).forEach(walk);
  })(devRows[1]);
  ok(!!kickLink, 'H12 非当前设备有「踢出」入口');
  // 确认框：sandbox 的 window.confirm 返回 false，这里改成 true 才能继续
  booted.sandbox.window.confirm = () => true;
  if (kickLink) kickLink.handlers.click();
  await flush(); await flush(); await flush();
  eq(revokedSid, 'oth00002', 'H13 踢出的是被点的那台设备（sid 传递正确）');
  has(registry.get('pp-dev-msg').textContent, '已踢出', 'H14 给出成功反馈');

  // 重命名
  booted.sandbox.window.prompt = () => '家里的笔记本';
  let renameLink = null;
  (function walk(n) {
    if (!n || renameLink) return;
    if (/pp-link/.test(n.className || '') && n.textContent === '重命名') { renameLink = n; return; }
    (n.children || []).forEach(walk);
  })(curRow[0]);
  ok(!!renameLink, 'H15 当前设备也能重命名（自己的设备自己起名）');
  if (renameLink) renameLink.handlers.click();
  await flush(); await flush(); await flush();
  eq(renamed && renamed.label, '家里的笔记本', 'H16 重命名把新名字提交到服务端');
  eq(renamed && renamed.sid, 'cur00001', 'H17 重命名提交的是正确会话');

  // 踢出其他全部
  registry.get('pp-dev-kick-others').handlers.click();
  await flush(); await flush(); await flush();
  eq(kickOthersCalled, 1, 'H18 「踢出其他设备」调用对应接口');
  has(registry.get('pp-dev-msg').textContent, '已踢出 2 台', 'H19 反馈踢出数量');

  // 超限提示
  ({ registry } = boot({
    sessions: async () => Object.assign({}, DEVICES, { activeCount: 5, overLimit: true }),
  }));
  await flush(); await flush(); await flush();
  has(registry.get('pp-dev-msg').textContent, '如果这不是你自己', 'H20 超限时给出「不是你自己就踢掉」的提示');
  has(registry.get('pp-dev-msg').textContent, '改密码', 'H21 同时给出改密码这条一刀切的办法');

  // 老服务端 / 接口失败：整块隐藏，不报错占屏
  ({ registry } = boot({ sessions: async () => { throw new Error('HTTP 404'); } }));
  await flush(); await flush(); await flush();
  eq(registry.get('pp-dev-block').style.display, 'none', 'H22 老服务端（无该接口）→ 整块隐藏');

  // 应答形状不对也不能炸（异步抛错会变成未捕获拒绝，在 Zotero 里是控制台噪音）
  ({ registry } = boot({ sessions: async () => null }));
  await flush(); await flush(); await flush();
  eq(registry.get('pp-dev-block').style.display, 'none', 'H23 应答形状异常 → 隐藏而不是抛错');

  // 未登录：不显示
  ({ registry } = boot({ isLoggedIn: () => false, sessions: async () => DEVICES }));
  await flush(); await flush(); await flush();
  eq(registry.get('pp-dev-block').style.display, 'none', 'H24 未登录不显示设备块');

  /* ============ I. 套餐 AI 能力（0.24.8）：试用横幅 / 锁定模型 / 可见回落 ============ */
  {
    const selOf = (reg) => reg.get('pp-account-official-model');
    const noteOf = (reg) => reg.get('pp-ai-tier-note');

    // ---- I1. Pro：无试用、无锁定 → 说明条不出现 ----
    ({ registry } = boot({ ai: () => ({ highTier: true, reason: 'plan', trial: null,
      models: ['auto', 'glm-5.3-flash'], lockedModels: [], defaultModel: 'auto' }) }));
    await flush(); await flush(); await flush();
    eq(noteOf(registry).style.display, 'none', 'I1 Pro 用户没有可说的分层信息 → 说明条隐藏');

    // ---- I2. 试用中：横幅出现，说明剩余天数与到期日 ----
    const trialEnd = new Date(Date.now() + 5 * DAY).toISOString();
    ({ registry } = boot({ ai: () => ({ highTier: true, reason: 'trial',
      trial: { active: true, days: 7, daysLeft: 5, endsAt: trialEnd },
      models: ['auto', 'glm-5.3-flash', 'hunyuan-2.0-thinking'], lockedModels: [], defaultModel: 'auto' }) }));
    await flush(); await flush(); await flush();
    const nTrial = noteOf(registry);
    ok(nTrial.style.display !== 'none', 'I2 试用中 → 说明条出现');
    has(nTrial.textContent, '全模型试用中', 'I3 说明是试用');
    has(nTrial.textContent, '剩 5 天', 'I4 显示剩余天数');
    has(nTrial.textContent, '回到基础模型', 'I5 说明到期后果（不是只报喜）');
    has(nTrial.className, 'pp-ai-tier-trial', 'I6 试用条用醒目样式');

    // 试用中不应出现锁定项（0.72.3：标记由 🔒 改为文字「（需专业版）」）
    const optsTrial = selOf(registry).children.filter((c) => c.tag === 'option');
    eq(optsTrial.filter((o) => /需专业版/.test(o.textContent)).length, 0, 'I7 试用中不出现锁定项');

    // ---- I8. Free 试用已结束：列出需升级的模型 + 当前可用 ----
    const endedAt = new Date(Date.now() - 2 * DAY).toISOString();
    ({ registry } = boot({ ai: () => ({ highTier: false, reason: 'none',
      trial: { active: false, days: 7, daysLeft: 0, endsAt: endedAt },
      models: ['auto', 'glm-5.3-flash'],
      lockedModels: ['deepseek-v4-pro', 'hunyuan-2.0-thinking'], defaultModel: 'auto' }) }));
    await flush(); await flush(); await flush();
    const nLock = noteOf(registry);
    ok(nLock.style.display !== 'none', 'I8 有需升级的模型 → 说明条出现');
    has(nLock.textContent, '需要专业版', 'I9 说清原因');
    has(nLock.textContent, 'deepseek-v4-pro', 'I10 列出锁定的模型');
    has(nLock.textContent, '当前可用：auto、glm-5.3-flash', 'I11 同时给出当前可用的（不只说不许）');
    has(nLock.textContent, '试用已于', 'I12 说明为什么现在不能用了（试用结束）');
    ok(!/pp-ai-tier-trial/.test(nLock.className), 'I13 非试用态不用试用样式');

    // ---- I14. 下拉里锁定模型以「（需专业版）」灰显列出（可见差距才有转化力） ----
    const optsLock = selOf(registry).children.filter((c) => c.tag === 'option');
    const locked = optsLock.filter((o) => /（需专业版）$/.test(o.textContent));
    ok(locked.length === 2, 'I14 两个锁定模型以「（需专业版）」列出', optsLock.map((o) => o.textContent));
    has(locked[0] ? locked[0].textContent : '', 'deepseek-v4-pro', 'I15 锁定项写明模型名');
    ok(!!(locked[0] && locked[0].style.color), 'I16 锁定项灰显（有独立颜色）',
      locked[0] && locked[0].style);
    eq(selOf(registry).value, 'auto', 'I17 当前选择仍是 auto');

    // ---- I18. 当前保存的模型已被锁 → 可见地回落到默认，且写回配置 ----
    let upserts = [];
    const c = boot({ ai: () => ({ highTier: false, reason: 'none',
      trial: { active: false, days: 7, daysLeft: 0, endsAt: endedAt },
      models: ['auto', 'glm-5.3-flash'], lockedModels: ['deepseek-v4-pro'], defaultModel: 'auto' }) });
    // 需要让 getChannel 返回一个「已被锁」的当前模型
    c.sandbox.Zotero.Papilot.channels = Object.assign({}, fakeChannels, {
      getChannel: () => ({ id: 'official', model: 'deepseek-v4-pro', models: ['auto', 'deepseek-v4-pro'] }),
      upsert: (d) => { upserts.push(d); return { ok: true }; },
    });
    // 重新跑一次渲染（channels 已被换掉，renderAll 会读到新值）
    vm.runInContext('(typeof Zotero !== "undefined")', c.sandbox);
    ({ registry } = c);
    registry.get('pp-account-refresh').click();   // 触发 renderAccount → fillOfficialModelSelect
    await flush(); await flush(); await flush();
    eq(selOf(registry).value, 'auto', 'I18 已锁的当前模型 → 下拉回落到 auto');
    has(noteOf(registry).textContent, '已回落到 auto', 'I19 回落是**可见**的（写明原因，不静默改配置）');
    ok(upserts.some((d) => d.model === 'auto'), 'I20 回落同时写回通道配置', upserts);

    // ---- I21. 选中锁定项：不改配置 + 给出提示 ----
    let upserts2 = [];
    const d = boot({ ai: () => ({ highTier: false, reason: 'none', trial: null,
      models: ['auto', 'glm-5.3-flash'], lockedModels: ['deepseek-v4-pro'], defaultModel: 'auto' }) });
    d.sandbox.Zotero.Papilot.channels = Object.assign({}, fakeChannels, {
      getChannel: () => ({ id: 'official', model: 'auto', models: ['auto', 'glm-5.3-flash'] }),
      upsert: (x) => { upserts2.push(x); return { ok: true }; },
    });
    ({ registry } = d);
    registry.get('pp-account-refresh').click();
    await flush(); await flush(); await flush();
    const sel21 = selOf(registry);
    sel21.value = 'deepseek-v4-pro';              // 假装用户选了被锁的那项
    sel21.handlers.change();
    await flush(); await flush(); await flush();
    ok(!upserts2.some((x) => x.model === 'deepseek-v4-pro'), 'I21 选中锁定项不会写进配置', upserts2);
    has(noteOf(registry).textContent, '需要专业版', 'I22 当场给出「需要专业版」的反馈');
    has(noteOf(registry).textContent, '保持原模型不变', 'I23 并且说明没有改动');

    // ---- I24. 旧服务端（没有 ai 块）：不做任何锁定与回落 ----
    let upserts3 = [];
    const e = boot({});   // 基础 fakeAccount：ai() 已被上面的 stub 覆盖为 plan
    e.sandbox.Zotero.Papilot.account = fakeAccount({
      ai: () => ({ highTier: true, reason: 'unknown', trial: null, models: [], lockedModels: [], defaultModel: 'auto' }),
    });
    e.sandbox.Zotero.Papilot.channels = Object.assign({}, fakeChannels, {
      getChannel: () => ({ id: 'official', model: 'glm-5.3-flash', models: ['auto', 'glm-5.3-flash'] }),
      upsert: (x) => { upserts3.push(x); return { ok: true }; },
    });
    ({ registry } = e);
    registry.get('pp-account-refresh').click();
    await flush(); await flush(); await flush();
    eq(selOf(registry).value, 'glm-5.3-flash', 'I24 旧服务端（reason=unknown）→ 不动用户已选模型');
    ok(!upserts3.length, 'I25 旧服务端不做回落写入', upserts3);
    eq(noteOf(registry).style.display, 'none', 'I26 旧服务端不显示分层说明条');
    eq(selOf(registry).children.filter((o) => /🔒/.test(o.textContent)).length, 0, 'I27 旧服务端不显示锁定项');

    // ---- I28. ai() 返回异常形状：不能抛错（会是未捕获拒绝） ----
    for (const bad of [async () => null, () => 'not-an-object', () => ({ models: 'oops', lockedModels: 'oops' }),
      () => { throw new Error('boom'); }]) {
      ({ registry } = boot({ ai: bad }));
      await flush(); await flush(); await flush();
      eq(registry.get('pp-ai-tier-note').style.display, 'none', 'I28 异常 ai() 形状 → 安全降级（' + String(bad).slice(0, 24) + '）');
    }

    // ---- I29. 未登录：说明条收起 ----
    ({ registry } = boot({ isLoggedIn: () => false }));
    await flush(); await flush(); await flush();
    eq(registry.get('pp-ai-tier-note').style.display, 'none', 'I29 未登录不显示分层说明条');
  }

  /* ============ J. AI 额度余额面板（插件 0.26.0） ============ */
  {
    // ---- J1~J6：三档余额展示 ----
    ({ registry } = boot({}));
    await flush(); await flush(); await flush();
    const balBlock = registry.get('pp-bal-block');
    eq(balBlock.style.display, '', 'J1 余额块出现');
    eq(registry.get('pp-bal-total').textContent, '¥26.10', 'J2 总额按服务端文案展示');
    const detail = registry.get('pp-bal-detail').textContent;
    has(detail, '注册赠送 ¥6.00', 'J3 明细含注册赠送（带剩余天数）');
    has(detail, '剩 21 天', 'J4 注册赠送标注剩余天数');
    has(detail, '订阅额度 ¥1.00', 'J5 明细含订阅额度（标注本月底作废）');
    has(detail, '不结转', 'J6 订阅额度明示「不结转」');
    has(detail, '充值 ¥19.10', 'J7 明细含充值并标注永不过期');
    has(detail, '永不过期', 'J8 充值额度明示不过期');
    has(registry.get('pp-bal-note').textContent, '按实际用量从余额扣费（无调用次数上限）', 'J9 说明条讲清计费口径');
    has(registry.get('pp-bal-note').textContent, '注册赠送仅限基础模型', 'J9b 说明条讲清模型限制');

    // ---- J10~J12：观察模式 / 透支 / 额度不足 三种状态各说各的话 ----
    ({ registry } = boot({
      balance: () => ({ totalMicro: 1000000, grantedMicro: 1000000, planMicro: 0, paidMicro: 0,
        text: '¥1.00', grantedText: '¥1.00', planText: '¥0', paidText: '¥0',
        grantedDaysLeft: 5, planDaysLeft: null, grantedExpiresAt: null, planExpiresAt: null,
        planPeriodKey: null, enforce: false, minBalanceMicro: 0, overdraft: false }),
    }));
    await flush(); await flush(); await flush();
    has(registry.get('pp-bal-note').textContent, '观察模式', 'J10 未开启拦截时明示观察模式');

    ({ registry } = boot({
      balance: () => ({ totalMicro: -2000, grantedMicro: 0, planMicro: 0, paidMicro: -2000,
        text: '-¥0.0020', grantedText: '¥0', planText: '¥0', paidText: '-¥0.0020',
        grantedDaysLeft: null, planDaysLeft: null, grantedExpiresAt: null, planExpiresAt: null,
        planPeriodKey: null, enforce: true, minBalanceMicro: 0, overdraft: true }),
    }));
    await flush(); await flush(); await flush();
    has(registry.get('pp-bal-note').textContent, '透支', 'J11 透支时显式告警（不静默）');
    eq(registry.get('pp-bal-note').style.color, 'var(--pp-danger)', 'J12 透支用危险色');

    ({ registry } = boot({
      balance: () => ({ totalMicro: 0, grantedMicro: 0, planMicro: 0, paidMicro: 0,
        text: '¥0', grantedText: '¥0', planText: '¥0', paidText: '¥0',
        grantedDaysLeft: null, planDaysLeft: null, grantedExpiresAt: null, planExpiresAt: null,
        planPeriodKey: null, enforce: true, minBalanceMicro: 1000000, overdraft: false }),
    }));
    await flush(); await flush(); await flush();
    has(registry.get('pp-bal-note').textContent, '额度不足', 'J13 额度低于阈值时提示会被拦截');

    // ---- J14：旧服务端（无 balance 字段）→ 整块隐藏，绝不显示假数据 ----
    ({ registry } = boot({ balance: () => null }));
    await flush(); await flush(); await flush();
    eq(registry.get('pp-bal-block').style.display, 'none', 'J14 ★ 旧服务端无 balance → 整块隐藏');

    // ---- J15~J19：充值档位与下单 ----
    let created = null;
    ({ registry } = boot({
      createCreditOrder: async (optionId) => {
        created = optionId;
        return { id: 'o-cr1', kind: 'credit', amount: 30.42, amountText: '¥30.42',
          creditMicro: 33000000, bonusMicro: 3000000, tailCents: 42, status: 'pending',
          pay: { channel: '微信收款码', note: '备注订单号' } };
      },
    }));
    await flush(); await flush(); await flush();
    ok(!registry.get('pp-bal-recharge-toggle').disabled, 'J15 有充值档位时按钮可用');
    registry.get('pp-bal-recharge-toggle').click();
    await flush(); await flush(); await flush();
    eq(registry.get('pp-bal-recharge').style.display, '', 'J16 点「充值额度」展开充值面板');
    const balChips = registry.get('pp-bal-options').children.filter((c) => /pp-mb-opt/.test(c.className));
    eq(balChips.length, 2, 'J17 渲染服务端下发的充值档位', balChips.map((c) => c.textContent));
    has(balChips[1].textContent, '送 ¥3.00', 'J18 带赠送的档位标注赠送额');
    eq(balChips.filter((c) => /pp-mb-opt-on/.test(c.className)).length, 1, 'J19 恰有一个默认选中档位');

    // 选第二档 → 生成订单
    balChips[1].click();
    registry.get('pp-bal-create').click();
    await flush(); await flush(); await flush();
    eq(created, 'rc30', 'J20 下单带上选中的档位 id');
    const payInfo = registry.get('pp-bal-pay-info').textContent;
    has(payInfo, '到账 ¥33.00', 'J21 付款页展示到账额度');
    has(payInfo, '含赠送 ¥3.00', 'J22 付款页展示赠送额');
    has(payInfo, '¥30.42', 'J23 付款页展示含尾数的精确金额');
    has(payInfo, '专属尾数', 'J24 提示尾数用于自动对账');

    // ---- J25：核销完成 → 提示已入账 ----
    ({ registry } = boot({
      createCreditOrder: async () => ({ id: 'o-cr2', kind: 'credit', amount: 10.05, amountText: '¥10.05',
        creditMicro: 10000000, bonusMicro: 0, tailCents: 5, status: 'pending', pay: {} }),
      orderStatus: async () => ({ id: 'o-cr2', kind: 'credit', amount: 10.05, amountText: '¥10.05',
        creditMicro: 10000000, bonusMicro: 0, tailCents: 5, status: 'fulfilled', pay: {} }),
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-bal-recharge-toggle').click();
    await flush(); await flush(); await flush();
    registry.get('pp-bal-create').click();
    await flush(); await flush();
    registry.get('pp-bal-poll').click();
    await flush(); await flush(); await flush();
    has(registry.get('pp-bal-pay-result').textContent, '已入账', 'J25 轮询到 fulfilled → 提示已入账');
  }

  /* ============ K. 付款订单弹窗（0.49.0：下单成功自动弹出） ============ */
  {
    let claimCalls = 0, cancelCalls = 0, statusCalls = 0;
    const orderK = {
      id: 'o-plan-1', kind: 'plan', plan: 'Pro', planName: '专业版', months: 12,
      cycle: 'yearly', cycleName: '按年', perpetual: false,
      amount: 269.42, amountCents: 26942, amountText: '¥269.42',
      baseCents: 26942, originalText: '¥269.42', discountCents: 0, discountText: '', couponCode: null,
      tailCents: 42, status: 'pending',
      pay: { channel: '支付宝收款码', qrText: '扫码后备注订单号', note: '转账后点「我已完成支付」' },
    };
    ({ registry } = boot({
      createOrder: async () => orderK,
      claimOrder: async () => { claimCalls++; return Object.assign({}, orderK, { status: 'claimed' }); },
      cancelOrder: async () => { cancelCalls++; return Object.assign({}, orderK, { status: 'cancelled' }); },
      orderStatus: async () => { statusCalls++; return Object.assign({}, orderK, { status: 'fulfilled' }); },
    }));
    await flush(); await flush(); await flush();

    const dlgRoot = registry.get('pp-dlg-root');
    eq(dlgRoot.children.length, 0, 'K0 未下单时无弹窗');

    registry.get('pp-mb-upgrade').click();          // 打开下单面板
    await flush(); await flush(); await flush();
    registry.get('pp-mb-create').click();           // 生成订单 → 应自动弹窗
    await flush(); await flush(); await flush();
    eq(dlgRoot.children.length, 1, 'K1 ★ 会员下单成功 → 自动弹出付款单');
    const card = dlgRoot.children[0].children[0];
    has(card.textContent, '会员订单', 'K2 标题为「会员订单」');
    has(card.textContent, '专业版', 'K3 展示订单内容（套餐）');
    has(card.textContent, '12 个月', 'K4 展示订阅周期');
    has(card.textContent, '¥269.42', 'K5 展示精确金额（含尾数）');
    has(card.textContent, 'o-plan-1', 'K6 展示订单号');
    has(card.textContent, '待支付', 'K7 展示状态');
    has(card.textContent, '专属对账尾数', 'K8 尾数提醒（防凑整导致对账失败）');
    has(card.textContent, '支付宝收款码', 'K9 展示收款方式');
    eq(card.byClass('pp-dlg-badge')[0].className, 'pp-dlg-badge pp-dlg-badge-warn', 'K10 待支付状态用警示样式');

    // 关闭 → 视为已读；内联区「查看付款单」可重开
    card.byClass('pp-dlg-done')[0].click();
    eq(dlgRoot.children.length, 0, 'K11 点「关闭」收起弹窗');
    registry.get('pp-mb-order-view').click();
    eq(dlgRoot.children.length, 1, 'K12 ★ 内联区「查看付款单」可重开（自动弹出只发生一次）');

    // 刷新状态 → fulfilled，徽标与按钮联动
    const card2 = dlgRoot.children[0].children[0];
    await card2.byClass('pp-dlg-refresh')[0].click();
    await flush(); await flush();
    eq(statusCalls, 1, 'K13 弹窗「刷新状态」调用查单接口');
    has(card2.byClass('pp-dlg-badge')[0].textContent, '已开通', 'K14 ★ 查到 fulfilled → 徽标更新为已开通');
    eq(card2.byClass('pp-dlg-badge')[0].className, 'pp-dlg-badge pp-dlg-badge-ok', 'K15 已开通用成功样式');
    eq(card2.byClass('pp-dlg-claim')[0].disabled, true, 'K16 已开通后「我已完成支付」禁用');
    eq(card2.byClass('pp-dlg-cancel')[0].disabled, true, 'K17 已开通后「取消订单」禁用');

    // 取消流程：新订单 → 弹窗 → 取消 → 弹窗关闭
    ({ registry } = boot({
      createOrder: async () => orderK,
      cancelOrder: async () => { cancelCalls++; return Object.assign({}, orderK, { status: 'cancelled' }); },
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-mb-upgrade').click();
    await flush(); await flush(); await flush();
    registry.get('pp-mb-create').click();
    await flush(); await flush(); await flush();
    const card3 = dlgRootFor(registry).children[0].children[0];
    await card3.byClass('pp-dlg-cancel')[0].click();
    await flush(); await flush();
    eq(cancelCalls, 1, 'K18 弹窗「取消订单」调用取消接口');
    eq(dlgRootFor(registry).children.length, 0, 'K19 ★ 取消成功 → 弹窗随之关闭');

    // 异常订单：缺订单号 → 不弹窗 + 内联错误（回退可见）
    ({ registry } = boot({
      createOrder: async () => ({ id: '', amount: 10, amountText: '¥10.00', status: 'pending' }),
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-mb-upgrade').click();
    await flush(); await flush(); await flush();
    registry.get('pp-mb-create').click();
    await flush(); await flush(); await flush();
    eq(dlgRootFor(registry).children.length, 0, 'K20 ★ 订单数据异常（缺订单号）→ 不弹窗');
    has(registry.get('pp-mb-order-msg').textContent, '订单数据异常', 'K21 异常回落到内联错误提示');

    // 充值流：同样自动弹出「充值订单」，金额/到账额度/赠送齐备
    const crOrderK = {
      id: 'o-cr-dlg', kind: 'credit', amount: 30.42, amountCents: 3042, amountText: '¥30.42',
      creditMicro: 33000000, bonusMicro: 3000000, tailCents: 42, status: 'pending',
      pay: { channel: '微信收款码', note: '备注订单号' },
    };
    ({ registry } = boot({
      createCreditOrder: async () => crOrderK,
      claimOrder: async () => Object.assign({}, crOrderK, { status: 'claimed' }),
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-bal-recharge-toggle').click();
    await flush(); await flush(); await flush();
    registry.get('pp-bal-create').click();
    await flush(); await flush(); await flush();
    eq(dlgRootFor(registry).children.length, 1, 'K22 ★ 充值下单成功 → 自动弹出付款单');
    const card4 = dlgRootFor(registry).children[0].children[0];
    has(card4.textContent, '充值订单', 'K23 标题为「充值订单」');
    has(card4.textContent, '到账 ¥33.00', 'K24 展示到账额度');
    has(card4.textContent, '含赠送 ¥3.00', 'K25 展示赠送额');
    has(card4.textContent, '¥30.42', 'K26 展示含尾数的精确金额');
    has(card4.textContent, '核销通过后自动入账余额', 'K27 说明履约方式（自动入账）');

    // 认领（我已完成支付）→ 状态转待核销
    await card4.byClass('pp-dlg-claim')[0].click();
    await flush(); await flush();
    has(card4.byClass('pp-dlg-badge')[0].textContent, '待核销', 'K28 ★ 提交认领后徽标转「待核销」');

    // ---- 在线支付（0.50.0）：服务端开通时充值单出现「在线支付（扫码）」 ----
    const onlineCalls = [];
    let launchedUrls = [];
    ({ registry, launched: launchedUrls } = boot({
      createCreditOrder: async () => crOrderK,
      startOnlinePay: async (orderId, channel) => {
        onlineCalls.push([orderId, channel]);
        return { payUrl: 'https://www.ljlliu.cn/Pay/console?trade_no=LH1', channel: channel };
      },
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-bal-recharge-toggle').click();
    await flush(); await flush(); await flush();
    registry.get('pp-bal-create').click();
    await flush(); await flush(); await flush();
    ok(registry.get('pp-bal-online').style.display !== 'none', 'K29 内联区在线支付按钮显示（服务端已开通）');
    const card5 = dlgRootFor(registry).children[0].children[0];
    const dlgOnline = card5.byClass('pp-dlg-online')[0];
    ok(!!dlgOnline, 'K30 ★ 付款单弹窗含「在线支付（扫码）」按钮');
    if (dlgOnline) { await dlgOnline.click(); await flush(); await flush(); }
    eq(onlineCalls.length, 1, 'K31 点击在线支付 → 调用 startOnlinePay');
    eq(onlineCalls.length ? onlineCalls[0][0] : '', 'o-cr-dlg', 'K31b 带上订单号');
    eq(onlineCalls.length ? onlineCalls[0][1] : '', 'alipay', 'K31c 渠道 alipay（免签网关常用）');
    ok(launchedUrls.length === 1 && /Pay\/console/.test(launchedUrls[0]),
      'K32 ★ 用系统浏览器打开收银台 payUrl', launchedUrls);

    // ---- 服务端未开通 → 不出现在线支付入口（走收款码 + 人工核销）----
    ({ registry } = boot({
      createCreditOrder: async () => crOrderK,
      plans: async () => Object.assign({}, PLANS_PAYLOAD, { onlinePay: { available: false, channels: [] } }),
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-bal-recharge-toggle').click();
    await flush(); await flush(); await flush();
    registry.get('pp-bal-create').click();
    await flush(); await flush(); await flush();
    eq(registry.get('pp-bal-online').style.display, 'none', 'K33 未开通 → 内联在线支付按钮隐藏');
    eq(dlgRootFor(registry).children[0].children[0].byClass('pp-dlg-online').length, 0,
      'K34 ★ 未开通 → 弹窗不出现在线支付按钮（不留死入口）');

    // ---- 会员订单在线支付（0.60.0 / 服务端 1.8.7）：与充值单同一套入口 ----
    const mbOnlineCalls = [];
    let mbLaunched = [];
    ({ registry, launched: mbLaunched } = boot({
      createOrder: async () => orderK,
      startOnlinePay: async (orderId, channel) => {
        mbOnlineCalls.push([orderId, channel]);
        return { payUrl: 'https://www.ljlliu.cn/Pay/console?trade_no=LH2', channel: channel };
      },
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-mb-upgrade').click();
    await flush(); await flush(); await flush();
    registry.get('pp-mb-create').click();
    await flush(); await flush(); await flush();
    ok(registry.get('pp-mb-online').style.display !== 'none',
      'K35 ★ 会员单内联区出现「在线支付（扫码）」（服务端已开通）');
    const card6 = dlgRootFor(registry).children[0].children[0];
    const mbDlgOnline = card6.byClass('pp-dlg-online')[0];
    ok(!!mbDlgOnline, 'K36 ★ 会员付款单弹窗含在线支付按钮');
    if (mbDlgOnline) { await mbDlgOnline.click(); await flush(); await flush(); }
    eq(mbOnlineCalls.length, 1, 'K37 点击 → 调用 startOnlinePay');
    eq(mbOnlineCalls.length ? mbOnlineCalls[0][0] : '', 'o-plan-1', 'K38 带会员订单号');
    ok(mbLaunched.length === 1 && /Pay\/console/.test(mbLaunched[0]),
      'K39 ★ 打开会员单收银台（扫码后自动开通）', mbLaunched);

    // 未开通 → 会员单同样不出现入口
    ({ registry } = boot({
      createOrder: async () => orderK,
      plans: async () => Object.assign({}, PLANS_PAYLOAD, { onlinePay: { available: false, channels: [] } }),
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-mb-upgrade').click();
    await flush(); await flush(); await flush();
    registry.get('pp-mb-create').click();
    await flush(); await flush(); await flush();
    eq(registry.get('pp-mb-online').style.display, 'none', 'K40 未开通 → 会员单不显示在线支付');
  }

  /* ============ L. 账号邮箱默认脱敏（0.68.3） ============ */
  {
    const c2 = boot({});
    await flush();
    c2.registry.get('pp-account-refresh').click();   // 触发 renderAccount
    await flush(); await flush();
    const emailEl = c2.registry.get('pp-account-email');
    has(emailEl.textContent, '***', 'L1 ★ 账号邮箱默认脱敏（设置面板是截图/投屏高发界面）');
    ok(String(emailEl.textContent).indexOf('me@test.local') < 0, 'L2 默认视图不含完整地址', emailEl.textContent);
    eq(String(emailEl.textContent), 'me***@test.local', 'L3 脱敏保留首 2 字 + 域名（认得出是哪个号）');
    emailEl.click();
    await flush();
    eq(String(emailEl.textContent), 'me@test.local', 'L4 点一下显示完整地址');
    emailEl.click();
    await flush();
    has(emailEl.textContent, '***', 'L5 再点收起');
  }

  /* ============ M. 账号与会员增强（2026-10-23：R1-R5/R8 新增元素静态断言） ============ */
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    const panelJs = fs.readFileSync(PANEL, 'utf8');
    const NEW_IDS = [
      // R1 修改密码
      'pp-cpw-toggle', 'pp-cpw-form', 'pp-cpw-old', 'pp-cpw-new', 'pp-cpw-new2',
      'pp-cpw-submit', 'pp-cpw-cancel', 'pp-cpw-msg',
      // R2 文案下发
      'pp-login-grant-hint', 'pp-cmp-grant-free', 'pp-cmp-grant-pro',
      // R3 开通/续期记录
      'pp-mb-history-toggle', 'pp-mb-history',
      // R4 我的订单
      'pp-orders-toggle', 'pp-orders-block', 'pp-orders-list', 'pp-orders-msg',
      // R5 最近扣费明细
      'pp-ledger-toggle', 'pp-ledger-block', 'pp-ledger-list',
      // R8 余额不足联动
      'pp-bal-open-channels',
    ];
    for (const id of NEW_IDS) {
      ok(xhtml.indexOf('id="' + id + '"') >= 0, 'M-xhtml:' + id + ' 存在于 prefs.xhtml');
      ok(panelJs.indexOf(id) >= 0, 'M-js:prefs-account.js 引用了 ' + id);
    }
    // 折叠/表单类新元素一律 display:none 起步（初始不占屏；内容由 JS 按需打开）
    const HIDDEN_AT_BOOT = ['pp-cpw-toggle', 'pp-cpw-form', 'pp-mb-history-toggle', 'pp-mb-history',
      'pp-orders-toggle', 'pp-orders-block', 'pp-ledger-toggle', 'pp-ledger-block', 'pp-bal-open-channels'];
    for (const id of HIDDEN_AT_BOOT) {
      const m = xhtml.match(new RegExp('id="' + id + '"[^>]*style="([^"]*)"'));
      ok(!!m && m[1].indexOf('display:none') >= 0, 'M-hide:' + id + ' 初始 display:none', m && m[1]);
    }
    // 链接外观一律真按钮（0.72.3 无障碍纪律：禁 span 假按钮）
    for (const id of ['pp-cpw-toggle', 'pp-mb-history-toggle', 'pp-orders-toggle', 'pp-ledger-toggle', 'pp-bal-open-channels']) {
      const m = xhtml.match(new RegExp('<html:(\\w+)[^>]*id="' + id + '"'));
      ok(!!m && m[1] === 'button', 'M-a11y:' + id + ' 是真 <button>（链接外观用 .pp-link-btn）', m && m[1]);
    }
    // account.js 契约层
    const accountJs = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'scripts', 'ai', 'account.js'), 'utf8');
    has(accountJs, 'changePassword', 'M-api:account.js 暴露 changePassword');
    has(accountJs, '/api/auth/change-password', 'M-api:改密路由字符串');
    has(accountJs, 'unsupported', 'M-api:旧服务端 404 → err.unsupported 降级标记');
    has(accountJs, 'ordersList', 'M-api:account.js 暴露 ordersList');
    has(accountJs, '/api/orders?limit=', 'M-api:订单列表路由字符串');
    has(accountJs, 'balanceLedger', 'M-api:account.js 暴露 balanceLedger');
    has(accountJs, '/api/balance/ledger?limit=', 'M-api:扣费明细路由字符串');
    has(accountJs, 'signupGrant', 'M-api:plans() 透传 signupGrant');
    has(accountJs, 'proMonthlyGrant', 'M-api:plans() 透传 proMonthlyGrant');
  }

  /* ============ N. 账号与会员增强（行为断言：折叠区渲染与降级） ============ */
  {
    // ---- N1：membership.history 有记录 → 折叠入口出现，展开后行数与来源映射正确 ----
    ({ registry } = boot({
      membership: () => ({ plan: 'Pro', name: '专业版', rawPlan: 'Pro', expired: false,
        expiresAt: Date.now() + 3 * DAY, source: 'order',
        history: [
          { plan: 'Pro', months: 1, perpetual: false, at: '2026-09-01T00:00:00Z', source: 'order' },
          { plan: 'Pro', months: 12, perpetual: false, at: '2026-10-01T00:00:00Z', source: 'code' },
          { plan: 'Pro', months: 0, perpetual: true, at: '2026-10-20T00:00:00Z', source: 'admin' },
          { plan: 'Pro', months: 3, perpetual: false, at: '2026-10-21T00:00:00Z', source: 'weird-src' },
        ] }),
    }));
    await flush(); await flush(); await flush();
    const histTg = registry.get('pp-mb-history-toggle');
    ok(histTg.style.display !== 'none', 'N1 ★ 有 history → 开通/续期记录入口出现');
    eq(registry.get('pp-mb-history').style.display, 'none', 'N2 默认收起（display:none）');
    histTg.click();
    await flush();
    const histBox = registry.get('pp-mb-history');
    eq(histBox.style.display, '', 'N3 点一下展开');
    const histRows = histBox.byClass('pp-hist-row');
    eq(histRows.length, 4, 'N4 展开后行数 === history 条数', histRows.length);
    has(histRows[0].textContent, '购买', 'N5 来源映射 order→购买');
    has(histRows[1].textContent, '激活码', 'N6 来源映射 code→激活码');
    has(histRows[2].textContent, '管理员开通', 'N7 来源映射 admin→管理员开通');
    has(histRows[2].textContent, '永久', 'N8 perpetual 渲染「永久」');
    has(histRows[1].textContent, '12 个月', 'N9 时长渲染 months 个月');
    has(histRows[3].textContent, 'weird-src', 'N10 ★ 未知来源原样显示（不吞不猜）');

    // ---- N11：空 history / 无 history 字段 → 整块隐藏 ----
    ({ registry } = boot({
      membership: () => ({ plan: 'Free', name: '免费版', rawPlan: 'Free', expired: false,
        expiresAt: 0, source: '', history: [] }),
    }));
    await flush(); await flush(); await flush();
    eq(registry.get('pp-mb-history-toggle').style.display, 'none', 'N11 ★ 空 history → 入口整块隐藏');
    eq(registry.get('pp-mb-history').style.display, 'none', 'N12 容器同样隐藏');

    // ---- N13~N18：我的订单 ----
    ({ registry } = boot({
      ordersList: async () => ({ count: 2, orders: [
        { id: 'o1', kind: 'plan', plan: 'Pro', planName: '专业版', months: 12, perpetual: false,
          cycleName: '按年', status: 'fulfilled', amountCents: 26900, amountText: '¥269.00',
          createdAt: '2026-10-01T00:00:00Z', note: '' },
        { id: 'o2', kind: 'credit', plan: null, planName: 'AI 额度充值', months: 0, perpetual: false,
          cycleName: '', status: 'pending', amountCents: 1000, amountText: '¥10.00',
          createdAt: '2026-10-22T00:00:00Z', note: '' },
      ] }),
    }));
    await flush(); await flush(); await flush();
    ok(registry.get('pp-orders-toggle').style.display !== 'none', 'N13 ★ 订单接口可用 → 入口出现');
    registry.get('pp-orders-toggle').click();
    await flush(); await flush(); await flush();
    const orderRows = registry.get('pp-orders-list').byClass('pp-order-row');
    eq(orderRows.length, 2, 'N14 渲染全部订单', orderRows.length);
    has(orderRows[0].textContent, '专业版', 'N15 会员单显示套餐名');
    has(orderRows[0].textContent, '已入账', 'N16 ★ 状态映射 fulfilled→已入账（台账口径）');
    has(orderRows[0].textContent, '12 个月', 'N17 显示时长');
    has(orderRows[1].textContent, '待支付', 'N18 状态映射 pending→待支付');
    has(orderRows[1].textContent, '¥10.00', 'N19 金额直接用服务端 amountText（前端零换算）');

    // ---- N20：旧服务端（ordersList → null）→ 整块隐藏 ----
    ({ registry } = boot({ ordersList: async () => null }));
    await flush(); await flush(); await flush();
    eq(registry.get('pp-orders-toggle').style.display, 'none', 'N20 ★ 旧服务端（null）→ 我的订单整块隐藏');
    eq(registry.get('pp-orders-block').style.display, 'none', 'N21 容器同样隐藏');

    // ---- N22~N26：最近扣费明细 ----
    ({ registry } = boot({
      balanceLedger: async () => ({ entries: [
        { at: '2026-10-23T08:00:00Z', delta: -2100, kind: 'consume', label: 'AI 调用 gpt-5', deltaText: '−¥0.0021' },
        { at: '2026-10-22T08:00:00Z', delta: 6000000, kind: 'signup', label: '注册赠送', deltaText: '+¥6.00' },
      ] }),
    }));
    await flush(); await flush(); await flush();
    ok(registry.get('pp-ledger-toggle').style.display !== 'none', 'N22 ★ 流水接口可用 → 入口出现');
    registry.get('pp-ledger-toggle').click();
    await flush(); await flush(); await flush();
    const ledgerRows = registry.get('pp-ledger-list').byClass('pp-ledger-row');
    eq(ledgerRows.length, 2, 'N23 渲染全部流水', ledgerRows.length);
    has(ledgerRows[0].textContent, 'AI 调用 gpt-5', 'N24 直接渲染服务端 label');
    has(ledgerRows[0].textContent, '−¥0.0021', 'N25 直接渲染服务端 deltaText（前端零换算）');
    has(ledgerRows[1].textContent, '+¥6.00', 'N26 正数带 + 前缀（服务端已格式化）');

    // ---- N27：旧服务端（balanceLedger → null）→ 整块隐藏 ----
    ({ registry } = boot({ balanceLedger: async () => null }));
    await flush(); await flush(); await flush();
    eq(registry.get('pp-ledger-toggle').style.display, 'none', 'N27 ★ 旧服务端（null）→ 扣费明细整块隐藏');
    eq(registry.get('pp-ledger-block').style.display, 'none', 'N28 容器同样隐藏');

    // ---- N29~N31：R8 余额不足联动 ----
    const foldCalls = [];
    const b8 = boot({
      balance: () => ({ totalMicro: 0, grantedMicro: 0, planMicro: 0, paidMicro: 0,
        text: '¥0', grantedText: '¥0', planText: '¥0', paidText: '¥0',
        grantedDaysLeft: null, planDaysLeft: null, grantedExpiresAt: null, planExpiresAt: null,
        planPeriodKey: null, enforce: true, minBalanceMicro: 1000000, overdraft: false }),
    });
    ({ registry } = b8);
    await flush(); await flush(); await flush();
    const ocBtn = registry.get('pp-bal-open-channels');
    ok(ocBtn.style.display !== 'none', 'N29 ★ 额度不足 → 「接入自己的模型通道」按钮出现');
    b8.sandbox.window.PapilotPrefsFold = { open: (k) => { foldCalls.push(k); return true; } };
    ocBtn.click();
    await flush();
    eq(foldCalls.length, 1, 'N30 点击 → PapilotPrefsFold.open 被调用');
    eq(foldCalls[0], 'channels', 'N31 ★ 展开的是 channels 卡（走 open()，不直写 classList）');

    // 余额充足 → 按钮不出现
    ({ registry } = boot({}));
    await flush(); await flush(); await flush();
    eq(registry.get('pp-bal-open-channels').style.display, 'none', 'N32 余额充足 → 按钮隐藏');

    // 透支（即使观察模式）→ 按钮出现
    ({ registry } = boot({
      balance: () => ({ totalMicro: -2000, grantedMicro: 0, planMicro: 0, paidMicro: -2000,
        text: '-¥0.0020', grantedText: '¥0', planText: '¥0', paidText: '-¥0.0020',
        grantedDaysLeft: null, planDaysLeft: null, grantedExpiresAt: null, planExpiresAt: null,
        planPeriodKey: null, enforce: false, minBalanceMicro: 0, overdraft: true }),
    }));
    await flush(); await flush(); await flush();
    ok(registry.get('pp-bal-open-channels').style.display !== 'none', 'N33 透支 → 按钮同样出现');

    // ---- N34~N38：R1 修改密码 ----
    let cpwLoggedIn = true;
    let cpwArgs = null;
    ({ registry } = boot({
      isLoggedIn: () => cpwLoggedIn,
      changePassword: async (o, n) => { cpwArgs = { old: o, new: n }; cpwLoggedIn = false; return true; },
    }));
    await flush(); await flush(); await flush();
    const cpwTg = registry.get('pp-cpw-toggle');
    ok(cpwTg.style.display !== 'none', 'N34 已登录 → 修改密码入口出现');
    cpwTg.click();
    await flush();
    eq(registry.get('pp-cpw-form').style.display, '', 'N35 点入口展开表单');
    registry.get('pp-cpw-old').value = 'old-pass-123';
    registry.get('pp-cpw-new').value = 'new-pass-456';
    registry.get('pp-cpw-new2').value = 'new-pass-456';
    registry.get('pp-cpw-submit').click();
    await flush(); await flush(); await flush();
    eq(cpwArgs && cpwArgs.old, 'old-pass-123', 'N36 旧密码原样提交');
    eq(cpwArgs && cpwArgs.new, 'new-pass-456', 'N37 新密码原样提交');
    has(registry.get('pp-login-result').textContent, '密码已修改', 'N38 ★ 成功 → 登录视图提示「密码已修改，全部设备已退出」');
    eq(registry.get('pp-account-view').style.display, 'none', 'N39 成功后回登录视图（账号卡隐藏）');

    // ---- N40：旧服务端（err.unsupported）→ 入口整块隐藏 + 提示 ----
    ({ registry } = boot({
      changePassword: async () => { const e = new Error('HTTP 404'); e.unsupported = true; throw e; },
    }));
    await flush(); await flush(); await flush();
    registry.get('pp-cpw-toggle').click();
    await flush();
    registry.get('pp-cpw-old').value = 'old-pass-123';
    registry.get('pp-cpw-new').value = 'new-pass-456';
    registry.get('pp-cpw-new2').value = 'new-pass-456';
    registry.get('pp-cpw-submit').click();
    await flush(); await flush(); await flush();
    eq(registry.get('pp-cpw-toggle').style.display, 'none', 'N40 ★ unsupported → 改密入口整块隐藏');
    eq(registry.get('pp-cpw-form').style.display, 'none', 'N41 表单同样收起');
    has(registry.get('pp-account-result').textContent, '服务端版本过旧', 'N42 给出「服务端版本过旧」提示');

    // ---- N43~N46：R2 plans 下发渲染三处文案 ----
    ({ registry } = boot({
      plans: async () => Object.assign({}, PLANS_PAYLOAD, {
        signupGrant: { amountMicro: 8000000, validDays: 0, scopeNote: '仅限基础模型' },
        proMonthlyGrant: { amountMicro: 30000000 },
      }),
    }));
    await flush(); await flush(); await flush();
    has(registry.get('pp-login-grant-hint').textContent, '注册赠送 ¥8.00', 'N43 登录提示金额来自服务端（微元换算）');
    has(registry.get('pp-login-grant-hint').textContent, '永久有效', 'N44 ★ validDays=0 → 渲染「永久有效」（不是「0 天」）');
    has(registry.get('pp-login-grant-hint').textContent, '专业版每月发放 ¥30.00', 'N45 每月发放金额来自服务端');
    has(registry.get('pp-cmp-grant-free').textContent, '仅限基础模型', 'N46 ★ 对比表免费版格含 scopeNote');
    has(registry.get('pp-cmp-grant-free').textContent, '永久有效', 'N47 对比表有效期同步渲染');
    has(registry.get('pp-cmp-grant-pro').textContent, '每月 ¥30.00', 'N48 对比表专业版格来自服务端');

    // amountMicro=0 → 隐藏注册赠送说法
    ({ registry } = boot({
      plans: async () => Object.assign({}, PLANS_PAYLOAD, {
        signupGrant: { amountMicro: 0, validDays: 30, scopeNote: '仅限基础模型' },
        proMonthlyGrant: { amountMicro: 20000000 },
      }),
    }));
    await flush(); await flush(); await flush();
    ok(registry.get('pp-login-grant-hint').textContent.indexOf('注册赠送') < 0,
      'N49 ★ amountMicro=0 → 登录提示不再出现「注册赠送」', registry.get('pp-login-grant-hint').textContent);

    // ---- N50：旧服务端（plans 无两个块）→ 三处全部回退硬编码，不空白不报错 ----
    ({ registry } = boot({}));   // 默认 PLANS_PAYLOAD 无 signupGrant/proMonthlyGrant
    await flush(); await flush(); await flush();
    // 迷你 DOM 不装载 xhtml 静态文本（只建空元素）：元素保持为空 = JS 没有覆盖，
    // 真实面板里显示的就是 xhtml 里的硬编码文案（下方 N52 对源码做静态核对）
    eq(registry.get('pp-login-grant-hint').textContent, '', 'N50 旧服务端 → JS 不动登录提示（保留硬编码）');
    eq(registry.get('pp-cmp-grant-free').textContent, '', 'N51 旧服务端 → JS 不动对比表免费版格');
    eq(registry.get('pp-cmp-grant-pro').textContent, '', 'N51b 旧服务端 → JS 不动对比表专业版格');
    const xhtmlSrc = fs.readFileSync(XHTML, 'utf8');
    has(xhtmlSrc, '注册赠送 ¥6', 'N52 ★ xhtml 硬编码回退文案仍在（免费版格 + 登录提示同源）');
    has(xhtmlSrc, '每月 ¥20', 'N52b xhtml 硬编码回退文案仍在（专业版格）');
  }

  function dlgRootFor(reg) { return reg.get('pp-dlg-root'); }

  /* ============ P. 账号资料自助管理（2026-10-24：E1-E4 静态断言） ============ */
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    const panelJs = fs.readFileSync(PANEL, 'utf8');
    const IDS = [
      // E1 修改邮箱
      'pp-cem-toggle', 'pp-cem-form', 'pp-cem-password', 'pp-cem-new',
      'pp-cem-submit', 'pp-cem-cancel', 'pp-cem-msg',
      // E2 危险区（自助注销）
      'pp-danger-toggle', 'pp-danger-block', 'pp-danger-delete', 'pp-danger-msg',
    ];
    for (const id of IDS) {
      ok(xhtml.indexOf('id="' + id + '"') >= 0, 'P-xhtml:' + id + ' 存在于 prefs.xhtml');
      ok(panelJs.indexOf(id) >= 0, 'P-js:prefs-account.js 引用了 ' + id);
    }
    // 只有容器/入口需要 display:none 起步；表单内部输入框/按钮随父容器隐藏，无内联样式属正常
    for (const id of ['pp-cem-toggle', 'pp-cem-form', 'pp-danger-toggle', 'pp-danger-block']) {
      const m = xhtml.match(new RegExp('id="' + id + '"[^>]*style="([^"]*)"'));
      ok(!!m && m[1].indexOf('display:none') >= 0, 'P-hide:' + id + ' 初始 display:none', m && m[1]);
    }
    for (const id of ['pp-cem-toggle', 'pp-danger-toggle']) {
      const m = xhtml.match(new RegExp('<html:(\\w+)[^>]*id="' + id + '"'));
      ok(!!m && m[1] === 'button', 'P-a11y:' + id + ' 是真 <button>', m && m[1]);
    }
    const accountJs = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'scripts', 'ai', 'account.js'), 'utf8');
    has(accountJs, 'changeEmail', 'P-api:account.js 暴露 changeEmail');
    has(accountJs, '/api/auth/change-email', 'P-api:改绑路由字符串');
    has(accountJs, 'deleteAccount', 'P-api:account.js 暴露 deleteAccount');
    has(accountJs, '/api/auth/delete-account', 'P-api:注销路由字符串');
    // E3：冗余刷新按钮移除（负断言）+ 全部刷新生效
    ok(xhtml.indexOf('id="pp-mb-refresh"') < 0, 'P-E3:pp-mb-refresh 已从 xhtml 移除');
    ok(xhtml.indexOf('id="pp-bal-refresh"') < 0, 'P-E3:pp-bal-refresh 已从 xhtml 移除');
    ok(panelJs.indexOf('onMbRefresh') < 0 && panelJs.indexOf('onBalRefresh') < 0,
      'P-E3:onMbRefresh/onBalRefresh 已无残留');
    has(panelJs, '已全部刷新', 'P-E3:底部按钮升级为全部刷新');
    has(xhtml, '全部刷新', 'P-E3:xhtml 按钮文案为全部刷新');
    // E4：会话有效期 >3 天不显示，≤3 天提示并说明自动续期
    has(panelJs, '3 * 86400000', 'P-E4:有效期按 3 天阈值判断');
    has(panelJs, '期间自动续期', 'P-E4:提示含自动续期说明');
    // 危险区样式
    const css = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'prefs.css'), 'utf8');
    has(css, '.pp-danger-block', 'P-css:危险区样式存在');
    has(css, '.pp-btn-danger', 'P-css:危险按钮样式存在');
  }

  console.log('\n会员面板渲染测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
