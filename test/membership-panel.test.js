#!/usr/bin/env node
/* 会员面板渲染测试（插件 0.24.4）
 *
 * 为什么要有它：设置面板脚本（chrome/content/prefs-account.js）跑在 Zotero 设置窗口里，
 * 无人环境点不了。这里用「迷你 DOM + 假 Account」把它**真跑一遍**，断言：
 *   #4 价格档位来自价格表（周期名 + 折合月单价）、未生效价格以灰底预告出现且不可点；
 *   #5 剩余 ≤7 天出现续费横幅、已到期转红、默认档位取「上次购买的周期」；
 *   #11 用量块画出近 7 天柱状图并显示今日/额度与近 7 天合计；老服务端（无趋势）时整块隐藏。
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
  plans: [{ id: 'Free', name: '免费版', rank: 0, dailyLimit: 100, features: ['每日 100 次'] },
    { id: 'Pro', name: '专业版', rank: 1, dailyLimit: 3000, features: ['每日 3000 次', '全部官方模型'] }],
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
};

function fakeAccount(over) {
  const base = Object.assign({
    isLoggedIn: () => true,
    user: () => ({ email: 'me@test.local', name: '我', plan: 'Pro', dailyUsed: 5, dailyLimit: 3000 }),
    expiresAt: () => Date.now() + 30 * DAY,
    serverUrl: () => 'https://pp.example.com',
    persistStatus: { attempted: 1, ok: true },
    membership: () => ({ plan: 'Pro', name: '专业版', rawPlan: 'Pro', expired: false,
      expiresAt: Date.now() + 3 * DAY, dailyLimit: 3000, source: 'order',
      history: [{ plan: 'Pro', months: 1, at: '2026-09-01T00:00:00Z' },
        { plan: 'Pro', months: 12, at: '2026-10-01T00:00:00Z' }] }),
    isPro: () => true,
    membershipDaysLeft: () => 3,
    renewalReminder: () => ({ daysLeft: 3, expired: false, expiresAt: Date.now() + 3 * DAY, key: 'k' }),
    lastPurchasedMonths: () => 12,
    usage: () => ({
      today: 5, limit: 3000, last7: 12,
      days: Array.from({ length: 30 }, (_, i) => ({ date: isoDay(i - 29), count: i % 4 })),
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
  const sandbox = {
    console,
    document,
    Zotero: {
      locale: 'zh-CN',
      PaperPilot: { account: fakeAccount(accountOver), channels: fakeChannels },
      Prefs: { get: (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: (k, v) => prefs.set(k, v) },
      getMainWindow: () => null,
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
  return { registry, prefs, sandbox };
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  /* ============ A. Pro 用户：剩余 3 天 + 用量趋势 ============ */
  let { registry } = boot({});

  const renew = registry.get('pp-mb-renew');
  ok(renew.style.display !== 'none', 'A1 剩余 ≤7 天 → 续费横幅出现', renew.style.display);
  has(renew.textContent, '仅剩 3 天', 'A2 横幅说明剩余天数');
  has(renew.textContent, '点此续费', 'A3 横幅提示可点');
  ok(!/expired/.test(renew.className), 'A4 未到期时不是危险样式', renew.className);

  const usage = registry.get('pp-mb-usage');
  ok(usage.style.display !== 'none', 'A5 用量块出现');
  has(usage.textContent, '今日 5 / 3000', 'A6 显示今日/额度');
  has(usage.textContent, '近 7 天合计 12', 'A7 显示近 7 天合计');
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
      expiresAt: Date.now() - 2 * DAY, dailyLimit: 100, source: 'order', history: [{ plan: 'Pro', months: 1 }] }),
  }));
  const rb2 = registry.get('pp-mb-renew');
  ok(rb2.style.display !== 'none', 'C1 已过期 → 横幅仍出现');
  has(rb2.textContent, '已', 'C2 文案说明已到期');
  has(rb2.className, 'pp-mb-renew-expired', 'C3 已过期用危险样式（红色）');

  /* ============ D. 免费用户（无到期日）：不打扰 ============ */
  ({ registry } = boot({
    isPro: () => false,
    membership: () => ({ plan: 'Free', name: '免费版', rawPlan: 'Free', expired: false,
      expiresAt: 0, dailyLimit: 100, source: '', history: [] }),
    membershipDaysLeft: () => Infinity,
    renewalReminder: () => null,
    lastPurchasedMonths: () => null,
  }));
  eq(registry.get('pp-mb-renew').style.display, 'none', 'D1 免费用户不显示到期横幅');
  ok(registry.get('pp-mb-upgrade').textContent.indexOf('升级') >= 0, 'D2 按钮仍显示「升级专业版」');

  /* ============ E. 老服务端（无用量趋势）：整块隐藏而不是画空图 ============ */
  ({ registry } = boot({
    usage: () => ({ today: 5, limit: 3000, last7: 0, days: [] }),
  }));
  eq(registry.get('pp-mb-usage').style.display, 'none', 'E1 无趋势数据 → 用量块隐藏');
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

    // 试用中不应出现 🔒 项
    const optsTrial = selOf(registry).children.filter((c) => c.tag === 'option');
    eq(optsTrial.filter((o) => /🔒/.test(o.textContent)).length, 0, 'I7 试用中不出现锁定项');

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

    // ---- I14. 下拉里锁定模型以 🔒 灰显列出（可见差距才有转化力） ----
    const optsLock = selOf(registry).children.filter((c) => c.tag === 'option');
    const locked = optsLock.filter((o) => /^🔒 /.test(o.textContent));
    ok(locked.length === 2, 'I14 两个锁定模型以 🔒 列出', optsLock.map((o) => o.textContent));
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
    c.sandbox.Zotero.PaperPilot.channels = Object.assign({}, fakeChannels, {
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
    d.sandbox.Zotero.PaperPilot.channels = Object.assign({}, fakeChannels, {
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
    e.sandbox.Zotero.PaperPilot.account = fakeAccount({
      ai: () => ({ highTier: true, reason: 'unknown', trial: null, models: [], lockedModels: [], defaultModel: 'auto' }),
    });
    e.sandbox.Zotero.PaperPilot.channels = Object.assign({}, fakeChannels, {
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
    has(detail, '本月底作废', 'J6 订阅额度明示「不结转」');
    has(detail, '充值 ¥19.10', 'J7 明细含充值并标注永不过期');
    has(detail, '永不过期', 'J8 充值额度明示不过期');
    has(registry.get('pp-bal-note').textContent, '注册赠送额度仅限基础模型', 'J9 说明条讲清模型限制');

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

  console.log('\n会员面板渲染测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
