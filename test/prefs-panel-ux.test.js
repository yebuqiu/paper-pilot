#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置面板 P0–P2 修订的行为回归（0.68.4 补测）
 *
 * 为什么要有它：这一轮 10 项修订全是「静默失败」型——写错了不报错、界面照样能开，
 * 只有真跑一遍脚本或真点一下才看得出来。实现者当时用的是临时脚本，跑完就删了，
 * 于是下次有人「顺手简化」就会把这些坑重新挖开。本套件把它们固化成持久断言。
 *
 * 覆盖（编号对应本轮 12 项修订）：
 *   A1 账号卡（真跑 chrome/content/prefs-account.js）
 *     P0-1 服务端把 name 回填成邮箱时，标题与邮箱行都不得出现完整地址；
 *          中文昵称优先做标题、徽标「昵称首字优先、邮箱兜底」。
 *     P0-2 空邮箱整行隐藏（不留假可点的空节点与「点击显示完整邮箱」的 title）。
 *          邮箱默认脱敏、点一下展开、再点收起。
 *     P2-3 免费版 vs 专业版对照表默认收起，click / Enter / Space 都能切换，
 *          且 aria-expanded 与可见性同步（不是只改类名）。
 *   A2 折叠 + 搜索 + 直达联动（同一沙箱先跑 prefs-fold.js 再跑 prefs-hotkeys.js，与真机顺序一致）
 *     P1-2 0 命中时出现空态提示，清空后收起；
 *     P1-3 卡内 .pp-label / .pp-sub-title 的文字能搜到（否则「应用密码」这类字段名 0 命中）；
 *     P1-4 搜索态下点「直达」先清搜索态（否则滚过去只看到 display:none 的空白）；
 *     P1-5 直达展开首卡要**真的**写进 prefsFoldOpen 并同步 aria-expanded；
 *     P1-6 搜索态下点折叠头不得静默改写 prefsFoldOpen；
 *     P1-7 默认展开账号卡（默认值在仓库根 prefs.js），但「全部收起」写下的空串记忆优先；
 *     P2-2 直达 chip 有「当前分类」高亮，且跟随滚动同步（最后一个 top <= stickyOffset()+8）。
 *   A3 静态一致性（纯读文件）
 *     P1-1 工具条计数 = 卡片数 = 各分类计数之和，文件头注释也不再写旧的「18 组」；
 *     P1-3 每张卡的 data-search-strings-raw 都在且非空；
 *     P1-7 prefs.js 里 prefsFoldOpen 默认值是 "account"；
 *     P2-4 知网卡与坚果云卡各有且仅有一条「账号与密钥」引导；
 *     prefs.xhtml 必须是 well-formed XML 且无未定义实体（&nbsp; 之类会让面板整屏空白）；
 *     面板脚本不得把 HTML 元素绑到 command 事件；#pp-anchor-nav 不得 sticky。
 *
 * 纪律：零依赖、不 sleep（用 flush）、不用 ?. / ??（Zotero 老版本兼容）、迷你 DOM 能力
 *       与 test/prefs-fold.test.js / test/prefs-anchors.test.js 保持一致。
 *
 * 运行：node test/prefs-panel-ux.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const CSS_FILE = path.join(ROOT, 'chrome', 'content', 'prefs.css');
const ACCOUNT_JS = path.join(ROOT, 'chrome', 'content', 'prefs-account.js');
const FOLD_JS = path.join(ROOT, 'chrome', 'content', 'prefs-fold.js');
const HOTKEYS_JS = path.join(ROOT, 'chrome', 'content', 'prefs-hotkeys.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label,
    { text: String(hay).slice(0, 160), want: needle });
}
function noHas(hay, needle, label) {
  return ok(String(hay).indexOf(needle) < 0, label,
    { text: String(hay).slice(0, 160), forbidden: needle });
}

/* ==================== 迷你 DOM（两支共用） ==================== */

class El {
  constructor(tag, cls) {
    this.tag = tag; this.nodeType = 1; this.children = []; this.parentNode = null;
    this.style = {}; this._attrs = {};
    this.className = cls || ''; this._text = '';
    this.handlers = {}; this.value = ''; this.disabled = false; this.checked = false;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this._rect = { top: 0, height: 20 };
    this.scrollIntoViewCalls = 0;
  }
  get classList() {
    const self = this;
    const list = () => String(self.className || '').split(/\s+/).filter(Boolean);
    return {
      add(c) { if (list().indexOf(c) < 0) self.className = (self.className ? self.className + ' ' : '') + c; },
      remove(c) { self.className = list().filter((x) => x !== c).join(' '); },
      contains(c) { return list().indexOf(c) >= 0; },
      toggle(c, force) {
        const had = list().indexOf(c) >= 0;
        const want = force === undefined ? !had : !!force;
        if (want && !had) self.className = (self.className ? self.className + ' ' : '') + c;
        else if (!want && had) self.className = list().filter((x) => x !== c).join(' ');
        return want;
      },
    };
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    this._attrs[k] = String(v);
  }
  getAttribute(k) { return k === 'class' ? this.className : (k in this._attrs ? this._attrs[k] : null); }
  removeAttribute(k) { if (k === 'class') this.className = ''; else delete this._attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get firstChild() { return this.children[0] || null; }
  get nextElementSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.children.indexOf(this);
    return i >= 0 ? (p.children[i + 1] || null) : null;
  }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) {
    if (this.handlers[ev]) this.handlers[ev] = this.handlers[ev].filter((f) => f !== fn);
  }
  fire(ev, arg) {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, arg || {});
    for (const f of (this.handlers[ev] || []).slice()) f(e);
    return e;
  }
  click() { return this.fire('click'); }
  focus() {}
  scrollIntoView() { this.scrollIntoViewCalls++; }
  matches(sel) {
    // 只支持本仓测试桩约定：单类 / tag.class / 复合选择器取末段。
    const parts = String(sel).trim().split(/\s+/);
    const last = parts[parts.length - 1];
    const m = last.match(/^([a-zA-Z]*)\.?([A-Za-z0-9_-]*)(\[([A-Za-z0-9_-]+)\])?$/);
    if (!m) return false;
    if (m[1] && this.tag !== m[1]) return false;
    if (m[2] && String(this.className || '').split(/\s+/).indexOf(m[2]) < 0) return false;
    if (m[4] && this.getAttribute(m[4]) === null) return false;
    return true;
  }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() {
    return { top: this._rect.top, height: this._rect.height, bottom: this._rect.top + this._rect.height };
  }
  set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = v == null ? '' : String(v);
  }
  get innerHTML() { return this.textContent; }
}

const flush = () => new Promise((r) => setImmediate(r));
async function flushAll(n) {
  for (let i = 0; i < (n || 4); i++) await flush();
}

/* ==================== A1：账号卡 ==================== */

/**
 * 账号卡 DOM：按 prefs.xhtml 里真实存在的 id 建节点。
 * 刻意用「全量 id」而不是手抄一份最小清单——脚本多处是 `if (!$("x")) return;` 的静默守卫，
 * 少建一个节点会让整段渲染安静地不执行，测试反而变成绿的。
 */
function makeAccountDom() {
  const html = fs.readFileSync(XHTML, 'utf8');
  const ids = [];
  const seen = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }
  const body = new El('body');
  const registry = new Map();
  for (const id of ids) {
    const node = new El('div');
    node.setAttribute('id', id);
    node.parentNode = body;
    body.children.push(node);
    registry.set(id, node);
  }
  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
    querySelector: () => null,
    querySelectorAll: () => [],
    body,
  };
  return { document, registry };
}

/* 通道模块只需足够让 renderAccount / renderChannels 跑完 */
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

const DAY = 86400e3;

function fakeAccount(over) {
  const base = Object.assign({
    isLoggedIn: () => true,
    user: () => ({ email: 'me@test.local', name: '我', plan: 'Pro' }),
    expiresAt: () => Date.now() + 30 * DAY,
    serverUrl: () => 'https://pp.example.com',
    gatewayUrl: () => 'https://pp.example.com/v1',
    token: () => 'tok',
    membership: () => ({ plan: 'Pro', name: '专业版', rawPlan: 'Pro', expired: false,
      expiresAt: Date.now() + 30 * DAY, source: 'order', history: [] }),
    isPro: () => true,
    membershipDaysLeft: () => 30,
    renewalReminder: () => null,
    lastPurchasedMonths: () => 1,
    cost: () => null,
    balance: () => null,
    plans: async () => ({ plans: [], priceItems: [], rechargeOptions: [], onlinePay: { available: false } }),
    ai: () => ({ highTier: true, reason: 'plan', trial: null,
      models: ['auto'], lockedModels: [], defaultModel: 'auto' }),
    sessions: async () => null,
    refreshUser: async () => null,
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

function bootAccount(accountOver) {
  const { document, registry } = makeAccountDom();
  const prefs = new Map();
  const sandbox = {
    console,
    document,
    Zotero: {
      locale: 'zh-CN',
      Papilot: { account: fakeAccount(accountOver), channels: fakeChannels },
      Prefs: {
        get: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
        set: (k, v) => prefs.set(k, v),
      },
      getMainWindow: () => null,
      launchURL: () => {},
    },
    window: {
      setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {},
      addEventListener: () => {}, confirm: () => false, prompt: () => null,
    },
    Components: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ACCOUNT_JS, 'utf8'), sandbox, { filename: 'prefs-account.js' });
  return { registry, prefs, sandbox };
}

/* ==================== A2：折叠 + 搜索 + 直达 ==================== */

/* 3 个分类 / 3 张折叠卡。字段名刻意写在 .pp-label（不在标题里），
   用来验证「索引包含卡内字段名」，这是 P1-3 的核心。 */
const PANEL_SPEC = [
  { name: '账号与会员', key: 'account', title: '账号与登录',
    labels: ['应用密码', '邮箱'], sub: '安全', top: 100 },
  { name: 'AI 能力', key: 'channels', title: '模型通道',
    labels: ['接口地址'], sub: '连接', top: 500 },
  { name: '界面与效率', key: 'menu', title: '菜单项',
    labels: ['快捷入口'], sub: '外观', top: 900 },
];

function makePanelDom(opts) {
  opts = opts || {};
  const root = new El('vbox', 'pp-root');
  root.scrollHeight = 2000;
  root.clientHeight = 600;
  root._rect = { top: 0, height: 600 };

  // 0.68.4 真机回归：中间层可能是「假滚动框」——scrollHeight > clientHeight，
  // 但 overflow:hidden，scrollTop 写进去纹丝不动。旧实现「找到第一个就 break」，
  // 于是屏幕完全不动（用户报的「直达没反应」）。这里把根节点做成这种假滚动框。
  if (opts.deadRootScroll) {
    let dead = 0;
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get: () => dead,
      set: () => { /* 纹丝不动：模拟 overflow:hidden 的裁切层 */ },
    });
  }

  const nav = new El('div'); nav.setAttribute('id', 'pp-anchor-nav');
  const empty = new El('div'); empty.setAttribute('id', 'pp-prefs-empty');
  empty.style.display = 'none';
  root.appendChild(nav);
  root.appendChild(empty);

  const cats = [];
  for (const spec of PANEL_SPEC) {
    const lab = new El('div', 'pp-cat-label');
    const nameEl = new El('span', 'pp-cat-name');
    nameEl.textContent = spec.name;
    const cnt = new El('span', 'pp-cat-count');
    cnt.textContent = '1 项';
    lab.appendChild(nameEl);
    lab.appendChild(cnt);
    lab._rect = { top: spec.top, height: 20 };
    root.appendChild(lab);

    const card = new El('div', 'pp-card pp-fold');
    card.setAttribute('data-fold', spec.key);
    card.setAttribute('data-search-strings-raw', '');
    const head = new El('div', 'pp-fold-head');
    const title = new El('span', 'pp-card-title');
    title.textContent = spec.title;
    const desc = new El('span', 'pp-card-desc');
    head.appendChild(title);
    head.appendChild(desc);
    const body = new El('div', 'pp-card-body');
    const sub = new El('div', 'pp-sub-title');
    sub.textContent = spec.sub;
    body.appendChild(sub);
    for (const l of spec.labels) {
      const field = new El('span', 'pp-label');
      field.textContent = l;
      body.appendChild(field);
    }
    card.appendChild(head);
    card.appendChild(body);
    root.appendChild(card);
    cats.push({ spec: spec, label: lab, card: card, head: head, title: title, body: body });
  }

  const mk = (id, tag) => { const n = new El(tag || 'div'); n.setAttribute('id', id); return n; };
  const expandBtn = mk('pp-fold-expand', 'button');
  const collapseBtn = mk('pp-fold-collapse', 'button');
  const searchInput = mk('pp-prefs-search', 'input');
  searchInput.value = '';
  const searchClear = mk('pp-prefs-search-clear', 'button');
  const countEl = mk('pp-pref-count', 'span');
  countEl.textContent = '3 项 · 3 类';
  const emptyHint = empty;
  const hotkeysList = mk('pp-hotkeys-list');

  const byId = new Map([
    ['pp-anchor-nav', nav], ['pp-prefs-empty', emptyHint],
    ['pp-fold-expand', expandBtn], ['pp-fold-collapse', collapseBtn],
    ['pp-prefs-search', searchInput], ['pp-prefs-search-clear', searchClear],
    ['pp-pref-count', countEl], ['pp-hotkeys-list', hotkeysList],
  ]);

  // 真机上真正的滚动容器是 Zotero 自己的 <div id="prefs-content">（见官方 preferences.xhtml）
  let prefsContent = null;
  if (opts.deadRootScroll && !opts.noContent) {
    prefsContent = new El('div');
    prefsContent.setAttribute('id', 'prefs-content');
    prefsContent.scrollHeight = 8000;
    prefsContent.clientHeight = 600;
    prefsContent._rect = { top: 0, height: 600 };
    byId.set('prefs-content', prefsContent);
  }

  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElementNS: (ns, tag) => new El(tag),
    // 真 DOM 里 .pp-root 会匹配到根节点本身；合并根前缀才能测到 pp-searching 与标签隐藏
    querySelectorAll: (sel) => (root.matches(sel)
      ? [root].concat(root.querySelectorAll(sel)) : root.querySelectorAll(sel)),
  };
  document.querySelector = (sel) => {
    const list = document.querySelectorAll(sel);
    return list.length ? list[0] : null;
  };
  return { root, nav, cats, expandBtn, collapseBtn, searchInput, searchClear,
    countEl, empty: emptyHint, hotkeysList, byId, document, prefsContent };
}

const PREF_FOLD = 'extensions.zotero.papilot.prefsFoldOpen';

/** 同一沙箱里先跑 prefs-fold.js 再跑 prefs-hotkeys.js（与真机注入顺序一致） */
function bootPanel(opts) {
  opts = opts || {};
  const dom = makePanelDom(opts);
  const prefStore = new Map(Object.entries(opts.prefs || {}));
  const timers = [];
  const Zotero = {
    locale: 'zh-CN',
    Prefs: {
      get: (k) => (prefStore.has(k) ? prefStore.get(k) : undefined),
      set: (k, v) => { prefStore.set(k, v); },
    },
    Papilot: {
      _prefsFocus: '',
      hotkeys: { getAll: () => [], setCombo: () => {}, resetCombo: () => {}, setEnabled: () => {} },
      noteTemplates: null,
    },
  };
  const window = {
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; },
    // 滚动同步走 requestAnimationFrame：沙箱里立即执行，避免测试里 sleep
    requestAnimationFrame: (fn) => { fn(); return 1; },
    addEventListener: () => {},
  };
  const sandbox = { console, document: dom.document, window, Zotero };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FOLD_JS, 'utf8'), sandbox, { filename: 'prefs-fold.js' });
  vm.runInContext(fs.readFileSync(HOTKEYS_JS, 'utf8'), sandbox, { filename: 'prefs-hotkeys.js' });
  return { dom, sandbox, prefStore, timers, Zotero,
    runTimers: () => { for (const t of timers.splice(0)) t.fn(); } };
}

const hasClass = (el, c) => (' ' + String((el && el.className) || '') + ' ').indexOf(' ' + c + ' ') >= 0;
const isClosed = (card) => hasClass(card, 'pp-fold-closed');

/** 模拟用户在搜索框里输入（真实端口派发 input 事件） */
function typeSearch(dom, q) {
  dom.searchInput.value = q;
  dom.searchInput.fire('input');
}

function chipsOf(dom) {
  return dom.nav.children.filter((c) => c.tag === 'button');
}

/* ---------------- 主流程 ---------------- */

(async () => {
  /* ==================== A1 账号卡 ==================== */
  {
    // ---- A1.1 ★ P0-1：服务端把 name 回填成邮箱 → 界面不得出现完整邮箱 ----
    {
      const b = bootAccount({
        user: () => ({ email: 'alice@example.com', name: 'alice@example.com' }),
      });
      await flushAll();
      const nameEl = b.registry.get('pp-account-name');
      const mailEl = b.registry.get('pp-account-email');
      eq(nameEl.textContent, '已登录用户',
        'A1.1 ★ P0-1 name 是邮箱回填值 → 标题显示「已登录用户」（不是明文邮箱）');
      noHas(nameEl.textContent, 'alice@example.com', 'A1.2 ★ P0-1 标题里没有完整邮箱');
      noHas(mailEl.textContent, 'alice@example.com', 'A1.3 ★ P0-1 邮箱行默认不带完整地址');
      eq(mailEl.textContent, 'al***@example.com', 'A1.4 邮箱行默认脱敏（首 2 字 + *** + 域名）');
      noHas(mailEl.getAttribute('title'), 'alice@example.com',
        'A1.5 默认态 title（悬停提示）也不泄露完整邮箱');
      eq(mailEl.getAttribute('aria-label'), '已隐藏的账号邮箱',
        'A1.6 无障碍标签不塞明文邮箱');
    }

    // ---- A1.7 中文昵称优先：标题用昵称、徽标取昵称首字 ----
    {
      const b = bootAccount({
        user: () => ({ email: 'alice@example.com', name: '张三' }),
      });
      await flushAll();
      eq(b.registry.get('pp-account-name').textContent, '张三', 'A1.7 有昵称时标题用昵称');
      eq(b.registry.get('pp-account-badge').textContent, '张',
        'A1.8 ★ 徽标取昵称首字（中文昵称取邮箱首字母 A 就认不出是谁）');
    }

    // ---- A1.9 昵称为空 → 标题「已登录用户」、徽标回落到邮箱首字母 ----
    {
      const b = bootAccount({
        user: () => ({ email: 'alice@example.com', name: '' }),
      });
      await flushAll();
      eq(b.registry.get('pp-account-name').textContent, '已登录用户',
        'A1.9 昵称为空 → 标题仍是「已登录用户」');
      eq(b.registry.get('pp-account-badge').textContent, 'A',
        'A1.10 昵称为空 → 徽标回落邮箱首字母');
    }

    // ---- A1.11 邮箱为空：整行隐藏，不留「假可点」的空节点 ----
    {
      const b = bootAccount({
        user: () => ({ email: '', name: '我' }),
      });
      await flushAll();
      const mailEl = b.registry.get('pp-account-email');
      eq(mailEl.textContent, '', 'A1.11 空邮箱 → 文本为空');
      eq(mailEl.style.display, 'none', 'A1.12 ★ 空邮箱 → 整行隐藏（不是空着仍占一行）');
      eq(mailEl.getAttribute('title'), null, 'A1.13 空邮箱 → 不再挂「点击显示完整邮箱」的 title');
    }

    // ---- A1.14 邮箱脱敏三态：默认脱敏 → 点一下展开 → 再点收起 ----
    {
      const b = bootAccount({
        user: () => ({ email: 'alice@example.com', name: '张三' }),
      });
      await flushAll();
      const mailEl = b.registry.get('pp-account-email');
      eq(mailEl.textContent, 'al***@example.com', 'A1.14 默认脱敏');
      mailEl.click();
      await flushAll(2);
      eq(mailEl.textContent, 'alice@example.com', 'A1.15 ★ 点一下显示完整邮箱（用户自己按需展开）');
      mailEl.click();
      await flushAll(2);
      eq(mailEl.textContent, 'al***@example.com', 'A1.16 ★ 再点收起（防止后人把脱敏改回去）');
    }

    // ---- A1.17 ★ P2-3：免费版 vs 专业版对照表默认收起 + click/Enter/Space 切换 ----
    {
      const b = bootAccount({ user: () => ({ email: 'alice@example.com', name: '张三' }) });
      await flushAll();
      const box = b.registry.get('pp-mb-compare');
      const tg = b.registry.get('pp-mb-compare-toggle');
      eq(box.style.display, 'none', 'A1.17 ★ P2-3 对照表初始收起（8 行表常驻会把升级按钮挤出首屏）');
      eq(tg.getAttribute('aria-expanded'), 'false', 'A1.18 初始 aria-expanded=false');
      has(tg.textContent, '▾', 'A1.19 收起态箭头朝下');

      tg.click();
      eq(box.style.display, '', 'A1.20 ★ 点一下展开');
      eq(tg.getAttribute('aria-expanded'), 'true', 'A1.21 展开后 aria-expanded=true（读屏能读出来）');
      has(tg.textContent, '▴', 'A1.22 展开态箭头朝上');

      tg.click();
      eq(box.style.display, 'none', 'A1.23 再点收起');
      eq(tg.getAttribute('aria-expanded'), 'false', 'A1.24 收起后 aria-expanded 回到 false');

      tg.fire('keydown', { key: 'Enter' });
      eq(box.style.display, '', 'A1.25 ★ Enter 键也能展开（HTML span 不会自己派发 click）');
      eq(tg.getAttribute('aria-expanded'), 'true', 'A1.26 键盘展开同样同步 aria-expanded');

      tg.fire('keydown', { key: ' ' });
      eq(box.style.display, 'none', 'A1.27 ★ 空格键也能收起（键值用 e.key=单空格）');

      let prevented = false;
      tg.fire('keydown', { key: 'a', preventDefault() { prevented = true; } });
      eq(box.style.display, 'none', 'A1.28 其它按键不切换');
      ok(!prevented, 'A1.29 其它按键不拦截默认行为');
    }
  }

  /* ==================== A2 折叠 + 搜索 + 直达 ==================== */
  {
    // ---- A2.1 ★ P1-3：只存在于 .pp-label 的词也能搜到 ----
    {
      const { dom } = bootPanel();
      eq(chipsOf(dom).length, 3, 'A2.0 3 个分类各生成一个直达 chip');
      typeSearch(dom, '应用密码');
      const acc = dom.cats[0], ch = dom.cats[1], menu = dom.cats[2];
      ok(!hasClass(acc.card, 'pp-hidden'),
        'A2.1 ★ P1-3 搜「应用密码」（只写在 .pp-label 里）→ 该卡保持可见');
      ok(hasClass(ch.card, 'pp-hidden'), 'A2.2 未命中的卡片被 .pp-hidden 隐藏');
      ok(hasClass(menu.card, 'pp-hidden'), 'A2.3 另一张未命中的卡片同样隐藏');
      ok(hasClass(dom.root, 'pp-searching'), 'A2.4 根节点进入搜索态');
      ok(!hasClass(acc.label, 'pp-hidden'), 'A2.5 有命中的分类标签保留');
      ok(hasClass(ch.label, 'pp-hidden'), 'A2.6 组内零命中 → 分类标签一起隐藏');
    }

    // ---- A2.7 ★ P1-2：0 命中出现空态，清空后收起 ----
    {
      const { dom } = bootPanel();
      eq(dom.empty.style.display, 'none', 'A2.7 初始空态容器隐藏');
      typeSearch(dom, 'zzzz');
      ok(dom.empty.style.display !== 'none',
        'A2.8 ★ P1-2 搜不到任何东西 → 出现空态提示（整屏空白会被当成面板坏了）');
      typeSearch(dom, '');
      eq(dom.empty.style.display, 'none', 'A2.9 清空搜索 → 空态收起');
    }

    // ---- A2.10 ★ P1-4 + P1-5：搜索态下点直达 → 清搜索 + 展开首卡 + 写 pref + aria ----
    {
      const { dom, prefStore } = bootPanel();
      typeSearch(dom, 'zzzz');
      ok(hasClass(dom.root, 'pp-searching'), 'A2.10 前置：进入搜索态且 0 命中');
      const chipAcc = chipsOf(dom)[0];
      eq(chipAcc.textContent, '账号与会员', 'A2.11 chip 文案取 .pp-cat-name');

      chipAcc.click();

      eq(dom.searchInput.value, '', 'A2.12 ★ P1-4 点直达先清空搜索框');
      ok(!hasClass(dom.root, 'pp-searching'), 'A2.13 ★ P1-4 退出搜索态（否则滚过去只看到空白）');
      ok(!hasClass(dom.cats[0].card, 'pp-hidden'), 'A2.14 清搜索后目标卡不再被隐藏');
      ok(!isClosed(dom.cats[0].card), 'A2.15 ★ P1-5 目标分类第一张折叠卡被展开');
      ok(isClosed(dom.cats[1].card), 'A2.16 其它分类的折叠卡状态不变（不误展开）');

      const raw = String(prefStore.get(PREF_FOLD) || '');
      eq(raw.indexOf('account') >= 0, true,
        'A2.17 ★ P1-5 展开态真的写进了 prefsFoldOpen（否则下次开面板又收起）');
      eq(dom.cats[0].head.getAttribute('aria-expanded'), 'true',
        'A2.18 ★ P1-5 aria-expanded 同步为 true（不是只改类名，读屏才读得对）');
      eq(dom.cats[1].head.getAttribute('aria-expanded'), 'false',
        'A2.19 未展开的卡 aria-expanded 仍为 false');
    }

    // ---- A2.20 ★ P1-6：搜索态下点折叠头不得静默改写 prefsFoldOpen ----
    {
      const { dom, prefStore } = bootPanel();
      typeSearch(dom, '菜单');
      ok(hasClass(dom.root, 'pp-searching'), 'A2.20 前置：进入搜索态');
      const before = prefStore.get(PREF_FOLD);
      eq(before, undefined, 'A2.21 前置：此时 pref 尚未写入');
      dom.cats[1].head.click();
      eq(prefStore.get(PREF_FOLD), before,
        'A2.22 ★ P1-6 搜索态下点折叠头 → prefsFoldOpen 完全不变（不静默改写）');
      ok(isClosed(dom.cats[1].card), 'A2.23 搜索态下点折叠头也不改折叠态（视觉无变化就别改记忆）');

      typeSearch(dom, '');
      dom.cats[1].head.click();
      eq(prefStore.get(PREF_FOLD), 'channels',
        'A2.24 退出搜索后再点 → pref 必须变化（说明上面不是「一直不生效」）');
    }

    // ---- A2.25 ★ P2-2：chip 当前分类高亮 + 跟随滚动同步 ----
    {
      const { dom } = bootPanel();
      const chips = chipsOf(dom);
      eq(chips.length, 3, 'A2.25 前置：3 个 chip');
      ok(hasClass(chips[0], 'pp-anchor-active'),
        'A2.26 首屏（各分类都在视口下方）默认高亮第 1 个 chip');
      ok(!hasClass(chips[1], 'pp-anchor-active') && !hasClass(chips[2], 'pp-anchor-active'),
        'A2.27 其余 chip 不高亮');

      chips[0].click();
      ok(hasClass(chips[0], 'pp-anchor-active'), 'A2.28 ★ P2-2 点第 1 个 chip → 它高亮');
      ok(!hasClass(chips[1], 'pp-anchor-active'), 'A2.29 同时取消其它 chip 的高亮');

      // 模拟滚动：第 1 类已滚出吸顶线，第 2 类正好压到吸顶线下方
      dom.cats[0].label._rect.top = -400;
      dom.cats[1].label._rect.top = 60;      // stickyOffset()=56，同步阈值 56+8=64
      dom.root.fire('scroll');

      ok(hasClass(chips[1], 'pp-anchor-active'),
        'A2.30 ★ P2-2 滚动后高亮切到第 2 个 chip（吸顶工具条 56px + 8px 容差）');
      ok(!hasClass(chips[0], 'pp-anchor-active'), 'A2.31 第 1 个 chip 的高亮被取消');
      eq(dom.root.scrollTop >= 0, true, 'A2.32 滚动兜底把 scrollTop 收敛为非负');
    }

    // ---- A2.38 ★ 0.68.4 真机回归：中间层是「假滚动框」时必须落到真正滚动容器 ----
    // 现场还原：用户点直达后 prefsFoldOpen 已写入（说明 click 生效、折叠也展开了），
    // 但屏幕纹丝不动 —— 旧实现找到第一个 scrollHeight>clientHeight 的祖先就 break，
    // 而那一层是 overflow:hidden 的裁切盒，scrollTop 写了不动。
    {
      const a = bootPanel({ deadRootScroll: true });
      const chips = chipsOf(a.dom);
      chips[1].click();                     // 第 2 类标签 top=500，stickyOffset=56
      eq(a.dom.root.scrollTop, 0,
        'A2.38 假滚动框（scrollTop 写了不动）不能被当成「已经滚了」');
      eq(a.dom.prefsContent.scrollTop, 444,
        'A2.39 ★ 跳过假滚动框，回落到 Zotero 的 #prefs-content（500 - 56）');
      ok(!a.prefStore.has('extensions.zotero.papilot.diagJump'),
        'A2.40 滚动成功时不写诊断 pref（不打扰用户）');
    }

    // ---- A2.41 连真容器都找不到时，必须把现场落盘，否则线上又是「点了没反应」且无从查证 ----
    {
      const b = bootPanel({ deadRootScroll: true, noContent: true });
      chipsOf(b.dom)[1].click();
      const diag = b.prefStore.get('extensions.zotero.papilot.diagJump');
      ok(!!diag && String(diag).indexOf('chain') >= 0,
        'A2.41 ★ 全部滚动路径都失败时写 diagJump（含祖先链的 scrollHeight/clientHeight）');
    }


    // ---- A2.33 ★ P1-7：首次进设置默认展开账号卡，但「全部收起」写下的空串记忆优先 ----
    // 默认值由仓库根 prefs.js 提供（见 A3.13 的静态守卫），折叠脚本本身只负责「按值应用」。
    {
      const pDefault = {};
      pDefault[PREF_FOLD] = 'account';
      const a = bootPanel({ prefs: pDefault });
      ok(!isClosed(a.dom.cats[0].card),
        'A2.33 ★ P1-7 默认值 account → 账号卡默认展开（用户一进设置就看到最可能要改的那张）');
      ok(isClosed(a.dom.cats[1].card) && isClosed(a.dom.cats[2].card),
        'A2.34 其余卡仍默认收起（不是「全展开」）');
      eq(a.dom.cats[0].head.getAttribute('aria-expanded'), 'true',
        'A2.35 默认展开态也同步到 aria-expanded');

      const pEmpty = {};
      pEmpty[PREF_FOLD] = '';
      const b2 = bootPanel({ prefs: pEmpty });
      ok(isClosed(b2.dom.cats[0].card) && isClosed(b2.dom.cats[1].card)
        && isClosed(b2.dom.cats[2].card),
        'A2.36 ★ P1-7 显式空串（用户点过「全部收起」）→ 一张都不展开，记忆优先于默认值');
      eq(b2.prefStore.get(PREF_FOLD), '', 'A2.37 空串记忆不被默认值覆盖回 account');
    }
  }

  /* ==================== A3 静态一致性 ==================== */
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    const css = fs.readFileSync(CSS_FILE, 'utf8');
    const accountSrc = fs.readFileSync(ACCOUNT_JS, 'utf8');
    const foldSrc = fs.readFileSync(FOLD_JS, 'utf8');
    const hkSrc = fs.readFileSync(HOTKEYS_JS, 'utf8');

    // ---- A3.1 工具条计数 == 卡片数 == 各分类计数之和 ----
    const mHdr = /id="pp-pref-count"[^>]*>\s*(\d+)\s*项/.exec(xhtml);
    const hdr = mHdr ? Number(mHdr[1]) : -1;
    const cardCount = (xhtml.match(/class="pp-card pp-fold"/g) || []).length;
    const catNums = [];
    const reCat = /class="pp-cat-count"[^>]*>\s*(\d+)\s*项/g;
    let mc;
    while ((mc = reCat.exec(xhtml))) catNums.push(Number(mc[1]));
    const catSum = catNums.reduce((a, b) => a + b, 0);

    eq(hdr, cardCount, 'A3.1 ★ 工具条计数 == 实际折叠卡数', { hdr: hdr, cards: cardCount });
    eq(catSum, cardCount, 'A3.2 ★ 各分类计数之和 == 实际折叠卡数',
      { sum: catSum, parts: catNums });
    eq(cardCount, 22, 'A3.3 折叠卡仍为 22 张（与 .pp-cat-count 一起校验；0.73.2 +组件管理）');
    eq(catNums.length, 7, 'A3.4 7 个分类标签各带一个计数徽标', catNums.length);

    // ---- A3.5 ★ P1-1b：文件头信息架构注释不得写成旧数字 ----
    // 0.68.1 加「WPS 集成」卡时，工具条计数与文件头注释「18 组」一起漏改，
    // 于是文档与界面互相矛盾（一个说 18、一个说 19）。
    noHas(xhtml, '18 组', 'A3.5 ★ P1-1 文件头注释不再写着旧的「18 组」');
    has(xhtml, '19 组', 'A3.6 ★ P1-1 文件头注释已更新为「19 组」');
    has(xhtml, '分为 7 类', 'A3.7 文件头注释的「7 类」与实际分类数一致');

    // ---- A3.8 ★ P1-3b：关键词索引覆盖全部分组卡（缺一张就有设置项搜不到） ----
    {
      const raws = [];
      const reRaw = /data-fold="([a-z]+)" data-search-strings-raw="([^"]*)"/g;
      let mr2;
      while ((mr2 = reRaw.exec(xhtml))) raws.push({ key: mr2[1], raw: mr2[2] });
      eq(raws.length, cardCount, 'A3.8 ★ P1-3 每张折叠卡都带 data-search-strings-raw',
        { got: raws.length, cards: cardCount });
      const emptyRaw = raws.filter((r) => !r.raw.trim()).map((r) => r.key);
      eq(emptyRaw.length, 0,
        'A3.9 ★ P1-3 没有一张卡的关键词是空的（空 = 只能靠标题/字段名搜到）', emptyRaw);
    }

    // ---- A3.10 ★ P2-4：知网卡与坚果云卡都要把人引到「账号与密钥」（两处入口两种脱敏） ----
    {
      const HINT = '也可以存到「账号与密钥」';
      const occurrences = xhtml.split(HINT).length - 1;
      eq(occurrences, 2, 'A3.10 ★ P2-4 「账号与密钥」提示恰好两处（知网 + 坚果云，不多不少）');
      const cardSeg = (key) => {
        const start = xhtml.indexOf('class="pp-card pp-fold" data-fold="' + key + '"');
        if (start < 0) return '';
        const next = xhtml.indexOf('class="pp-card pp-fold"', start + 10);
        return xhtml.slice(start, next < 0 ? xhtml.length : next);
      };
      for (const key of ['cnki', 'cloud']) {
        ok(cardSeg(key).length > 200, 'A3.11 前置：能切出卡 ' + key + ' 的片段', cardSeg(key).length);
        has(cardSeg(key), HINT,
          'A3.12 ★ P2-4 卡 ' + key + ' 里有「账号与密钥」引导（同一份凭据两处入口脱敏口径不同，必须说清）');
      }
      ok(cardSeg('channels').length > 200, 'A3.13 前置：能切出 channels 卡片段');
      noHas(cardSeg('channels'), HINT,
        'A3.14 提示没被粘到无关卡片（AI 通道卡不该出现这条）');
    }

    // ---- A3.15 ★ P1-7：prefsFoldOpen 默认值由仓库根 prefs.js 提供 ----
    {
      const prefsDef = fs.readFileSync(path.join(ROOT, 'prefs.js'), 'utf8');
      has(prefsDef, 'pref("extensions.zotero.papilot.prefsFoldOpen", "account");',
        'A3.15 ★ P1-7 prefs.js 里 prefsFoldOpen 默认值为 "account"（空默认 = 首屏 21 张全收起）');
    }

    // ---- A3.19 ★ prefs.xhtml 必须是 well-formed XML 且无未定义实体 ----
    // 用 Python 的 xml.etree 解析（与 Zotero 解析 XHTML fragment 的口径一致）。
    // 未定义实体（如 &nbsp;）会让**整个设置面板空白**——历史事故，必须守住。
    {
      const pyScript = [
        'import sys, re',
        'import xml.etree.ElementTree as ET',
        'p = sys.argv[1]',
        'try:',
        '    ET.parse(p)',
        '    print("WF ok")',
        'except Exception as e:',
        '    print("WF fail: %s" % e)',
        'src = open(p, encoding="utf-8").read()',
        'known = set(["amp", "lt", "gt", "quot", "apos"])',
        'bad = sorted(set(x for x in re.findall(r"&([A-Za-z][A-Za-z0-9]*);", src) if x not in known))',
        'print("ENT " + (",".join(bad) if bad else "ok"))',
      ].join('\n');
      let out = null;
      const tried = [];
      for (const py of ['python', 'python3', 'py']) {
        try {
          out = execFileSync(py, ['-c', pyScript, XHTML], { encoding: 'utf8', timeout: 60000 });
          break;
        } catch (e) { tried.push(py); }
      }
      ok(out !== null, 'A3.19 ★ prefs.xhtml 可用 Python xml.etree 解析（找不到解释器时算红）',
        { tried: tried });
      if (out !== null) {
        has(out, 'WF ok', 'A3.20 ★ prefs.xhtml 是 well-formed XML（否则设置面板整屏空白）');
        has(out, 'ENT ok', 'A3.21 ★ 无未定义实体（&nbsp; 之类会让面板开不出来）');
      }
    }

    // ---- A3.16 面板脚本不得把 HTML 元素绑到 command 事件 ----
    for (const pair of [['prefs-account.js', accountSrc], ['prefs-fold.js', foldSrc],
      ['prefs-hotkeys.js', hkSrc]]) {
      const bad = pair[1].indexOf('addEventListener("command"') >= 0
        || pair[1].indexOf("addEventListener('command'") >= 0;
      ok(!bad, 'A3.16 ★ ' + pair[0] + ' 不绑 command 事件（HTML 元素只派发 click/change，绑了=点不动）');
    }

    // ---- A3.17 #pp-anchor-nav 不得 sticky/fixed（双吸顶会遮挡分类标签） ----
    {
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const reRule = /([^{}]+)\{([^{}]*)\}/g;
      let mr;
      let navRules = 0;
      const offenders = [];
      while ((mr = reRule.exec(bare))) {
        if (mr[1].indexOf('pp-anchor-nav') < 0) continue;
        navRules++;
        if (/position\s*:\s*(sticky|fixed)/.test(mr[2])) offenders.push(mr[1].trim());
      }
      ok(navRules > 0, 'A3.17 前置：prefs.css 里确有 #pp-anchor-nav 相关规则', navRules);
      eq(offenders.length, 0,
        'A3.18 ★ P2-2 #pp-anchor-nav 没有 position:sticky/fixed（双吸顶会盖住分类标签，明确不做）',
        offenders);
    }
  }

  /* ==================== 汇总 ==================== */
  console.log('\n设置面板交互（P0–P2 修订）：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
