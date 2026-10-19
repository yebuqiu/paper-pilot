#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* AI 问答悬浮窗（ChatFloat）测试（插件 0.31.0）
 *
 * 悬浮窗是「AI 问答的入口本身」——渲染崩了或接线断了就是「快捷键没反应 /
 * 按钮点了没动静」，典型的静默失败。两层覆盖：
 *   纯逻辑层：会话状态机（setSessionItem）、runSend 单源发送（成功/无Key/
 *     无条目/NO_PDF/ABORTED/busy 重入）、几何 pref 解析与夹取、resolveItem。
 *   迷你 DOM 层：真加载 utils.js + chat-float.js，构建悬浮窗并发送一轮，
 *     断言气泡渲染、输入历史 ↑↓、划词注入预填、停靠切换、Esc/按钮接线。
 *
 * 运行：node test/chat-float.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/panels/chat-float.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = new StyleObj();
    this._attrs = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false;
    this.id = ''; this.parentNode = null; this.handlers = {};
    this.scrollTop = 0; this.scrollHeight = 0;
    this.title = '';
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    else if (k === 'title') this.title = String(v);
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = null;
    }
  }
  removeChild(c) { return c.remove(); }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) {
    const list = this.handlers[ev] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  fire(ev, arg) {
    for (const f of (this.handlers[ev] || []).slice()) {
      const r = f(arg || {});
      if (r === false) break;
    }
  }
  click() { this.fire('click'); }
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 400, bottom: 540, width: 400, height: 540 };
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return !!(n._isDocRoot);
  }
  get ownerDocument() { return this._ownerDoc || null; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(v) { this._html = String(v); this._text = String(v); }
  get innerHTML() { return this._html || ''; }
  /** 极简 querySelector：只支持本模块用到的两种形态 */
  querySelector(sel) {
    let m = /^:scope > (\w+):not\(\.([\w-]+)\)$/.exec(sel);
    if (m) {
      for (const c of this.children) {
        if (c.tag === m[1] && String(c.className).split(/\s+/).indexOf(m[2]) < 0) return c;
      }
      return null;
    }
    m = /^#([\w-]+)$/.exec(sel);
    if (m) return this._by((n) => n.id === m[1]);
    return null;
  }
  _by(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const r = c._by(pred);
      if (r) return r;
    }
    return null;
  }
  /** 极简 closest：按 id / tag 向上爬 */
  closest(sel) {
    const mId = /^#([\w-]+)$/.exec(sel);
    const mTag = /^(\w+)$/.exec(sel);
    let n = this;
    while (n) {
      if (mId && n.id === mId[1]) return n;
      if (mTag && n.tag === mTag[1]) return n;
      n = n.parentNode;
    }
    return null;
  }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
  byId(i) { return this.all().find((n) => n.id === i) || null; }
}

class StyleObj {
  constructor() { this._map = {}; }
  // cssText 赋值时解析 display（模块把 display:none 写在 cssText 串里，
  // 之后又用 style.display="flex" 直改——两边要互通）
  set cssText(v) {
    this._cssText = String(v);
    const m = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(this._cssText);
    if (m) this._map.display = m[1].trim();
  }
  get cssText() { return this._cssText || ''; }
  set(k, v) { this._map[k] = v; }
  get display() { return this._map.display; }
  set display(v) { this._map.display = v; }
  get opacity() { return this._map.opacity; }
  set opacity(v) { this._map.opacity = v; }
  get left() { return this._map.left; }
  set left(v) { this._map.left = v; }
  get top() { return this._map.top; }
  set top(v) { this._map.top = v; }
  get right() { return this._map.right; }
  set right(v) { this._map.right = v; }
  get bottom() { return this._map.bottom; }
  set bottom(v) { this._map.bottom = v; }
  get width() { return this._map.width; }
  set width(v) { this._map.width = v; }
  get height() { return this._map.height; }
  set height(v) { this._map.height = v; }
}

function makeDoc() {
  const docRoot = new El('window');
  docRoot._isDocRoot = true;
  const document = {
    documentElement: docRoot,
    createElementNS: (ns, tag) => { const el = new El(tag); el._ownerDoc = document; return el; },
    createElement: (tag) => { const el = new El(tag); el._ownerDoc = document; return el; },
    createXULElement: (tag) => { const el = new El(tag); el._ownerDoc = document; return el; },
    getElementById(id) { return docRoot.byId(id); },
    addEventListener(ev, fn) { (this.handlers = this.handlers || {})[ev] = this.handlers[ev] || []; this.handlers[ev].push(fn); },
  };
  return { document, docRoot };
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const PREFIX = 'extensions.zotero.papilot.';
const getPref = (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d);

const itemA = { id: 101, isRegularItem: () => true, getDisplayTitle: () => '论文A',
  getField: () => '', getCreators: () => [] };
const itemB = { id: 202, isRegularItem: () => true, getDisplayTitle: () => '论文B',
  getField: () => '', getCreators: () => [] };

let readers = [];
// 0.51.0 引用跳转：selectItem 调用计数 + 可控抛错（验证静默失败）
const selectCalls = [];
let selectThrows = false;
const Zotero = {
  locale: 'zh-CN',
  Prefs: { get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined), set: (k, v) => PrefStore.set(k, v) },
  getMainWindow: () => win,
  getMainWindows: () => [win],
  getActiveZoteroPane: () => ({
    getSelectedItems: () => selectedItems,
    selectItem(id) {
      if (selectThrows) throw new Error('pane unavailable');
      selectCalls.push(id);
    },
  }),
  Items: { get: (id) => (id === 101 ? itemA : id === 202 ? itemB : null) },
  Reader: { _readers: readers },
  Utilities: { Internal: { copyText() {} } },
  logError() {},
};

let selectedItems = [itemB];
const { document, docRoot } = makeDoc();
const win = {
  document, innerWidth: 1280, innerHeight: 800, ZoteroPane: {},
  openDialog() { throw new Error('unexpected openDialog'); },
};

let aiReady = true;
let aiReply = '这是**AI**的回答';
let aiThrows = null; // null=成功；Error=抛
let chatStreamDelay = false;
// 非流式门闩：置 true 后 AIClient.chat 会挂起，由测试手动放行（验证代际丢弃）
let chatGate = false;
const chatResolvers = [];
// 0.37.0 价值感知只在官方通道触发，测试里可切换
let activeChannelId = 'official';
const streamHandles = [];
const AIClient = {
  hasKey: () => aiReady,
  guidance: () => '未登录/未配置',
  _config: () => ({ ok: true, channelId: activeChannelId }),
  async chat() {
    if (aiThrows) throw aiThrows;
    if (chatGate) await new Promise((r) => chatResolvers.push(r));
    return aiReply;
  },
  chatStream(messages, onDelta) {
    const h = {
      aborted: false,
      abort() { this.aborted = true; },
      promise: (async () => {
        // 先让出一轮，保证 h 构造完成后才消费（否则 h.aborted 撞 TDZ）
        await new Promise((r) => setImmediate(r));
        if (aiThrows) throw aiThrows;
        if (chatStreamDelay) await new Promise((r) => setTimeout(r, 5));
        if (h.aborted) { const e = new Error('aborted'); e.message = 'ABORTED'; throw e; }
        onDelta(aiReply.slice(0, 4));
        if (h.aborted) { const e = new Error('aborted'); e.message = 'ABORTED'; throw e; }
        return aiReply;
      })(),
    };
    streamHandles.push(h);
    return h;
  },
};

const AIChat = {
  async getFullText() { return fullText; },
  // 多 chip 消息构造（_buildChipsMessages）依赖的两只工具
  paperMeta(it) {
    return { title: it.getDisplayTitle(), creators: '作者', pub: '期刊', year: '2024' };
  },
  windowHistory(h, n) { return h.slice(-(n || 6)); },
  async buildMessages(item, q, history, ft) {
    const e = new Error('NO_PDF');
    if (!ft && !abstractFallback) throw e;
    return [{ role: 'system', content: 'sys' }]
      .concat(history.slice(-12))
      .concat([{ role: 'user', content: q }]);
  },
};
let fullText = '论文全文……';
let abstractFallback = '';

let noteArgs = null;
const Notes = { async createFromMarkdown(item, title, md) { noteArgs = { title, md, id: item.id }; return true; } };
const Prompts = { all: () => [
  { id: 'p1', name: '总结', text: '请总结这篇论文' },
  { id: 'p2', name: '方法', text: '这篇论文用了什么方法？' },
] };

// 0.37.0 价值感知依赖桩：cost() 读缓存的花费视图，refreshCost() 模拟一次服务端刷新
let refreshCostCalls = 0;
let accountCost = null;
let accountCostAfterRefresh = null;
const Account = {
  cost: () => accountCost,
  balance: () => ({ text: '¥9.99' }),
  async refreshCost() { refreshCostCalls++; accountCost = accountCostAfterRefresh; return null; },
};

const sandbox = {
  console, Zotero, Services: {}, AIClient, AIChat, Notes, Prompts, Account,
  IOUtils: {}, PathUtils: {},
  setTimeout: (fn) => { if (typeof fn === 'function') setTimeout(fn, 0); return 0; },
  clearTimeout: () => {},
  Promise, Date, Math, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
// utils.js 的 var Notes 会覆盖预注入桩（vm 全局属性），加载后重新桩掉落笔记动作
// （translate-pane.test.js 同款处理）
sandbox.Notes.createFromMarkdown = async (item, title, md) => { noteArgs = { title, md, id: item.id }; return true; };
const CF = sandbox.ChatFloat;
const I18n = sandbox.I18n;

async function tick(n = 4) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

(async function main() {
  /* ---------------- ① 会话状态机 setSessionItem ---------------- */

  eq(CF.setSessionItem(itemA), '', 'setSessionItem: 首次设置不报切换');
  eq(CF.session.item, itemA, '会话条目已锁定');
  eq(CF.setSessionItem(itemA), '', '同条目重复设置不切换');
  CF.session.history.push({ role: 'user', content: 'q' });
  eq(CF.setSessionItem(itemB), 'switched', '换条目且已有历史 → switched');
  eq(CF.session.history.length, 0, '切换条目清空历史');

  /* ---------------- ② runSend 单源发送 ---------------- */

  let ui = null;
  function freshUI() {
    const u = {
      user: '', statuses: [], deltas: [], done: '', errors: [], aborted: false, busyFlags: [],
      itemTitles: [],
      onUser(t) { this.user = t; },
      onStatus(t) { this.statuses.push(t); },
      onDelta(a) { this.deltas.push(a); },
      onDone(t) { this.done = t; },
      onError(m) { this.errors.push(m); },
      onAbort() { this.aborted = true; },
      onBusy(b) { this.busyFlags.push(b); },
      onItemChanged(t) { this.itemTitles.push(t); },
    };
    return u;
  }

  // 成功轮次（流式）
  CF.session.item = itemA; CF.session.history = [];
  ui = freshUI();
  await CF.runSend('这篇论文的创新点？', ui);
  ok(ui.user === '这篇论文的创新点？', 'runSend: onUser 收到问题');
  ok(ui.deltas.length >= 1, 'runSend: 流式 onDelta 至少一次');
  has(ui.done, aiReply, 'runSend: onDone 收到完整答案');
  eq(ui.errors.length, 0, 'runSend: 成功无错误');
  eq(CF.session.history.length, 2, 'runSend: 成功轮次入历史（user+assistant）');
  if (CF.session.history.length !== 2) {
    console.log('DEBUG history=', JSON.stringify(CF.session.history));
    console.log('DEBUG errors=', JSON.stringify(ui.errors), 'aborted=', ui.aborted, 'done=', JSON.stringify(ui.done));
  }
  eq(CF.session.history[1] && CF.session.history[1].content, aiReply, 'runSend: 历史里是完整答案');
  eq(CF.session.busy, false, 'runSend: 结束后 busy=false');
  ok(ui.busyFlags.indexOf(true) >= 0 && ui.busyFlags.indexOf(false) >= 0, 'runSend: onBusy 开合成对');
  eq(CF.session.inputHistory[0], '这篇论文的创新点？', 'runSend: 输入历史入栈');

  /* ---- 0.37.0 价值感知：官方通道调用后回报「本次消耗 + 剩余额度」 ---- */

  function freshCostUI() {
    const u = freshUI();
    u.costs = [];
    u.onCost = (c) => { u.costs.push(c); };
    return u;
  }
  // _reportCost 走 Promise 微任务链（不阻塞回答）→ 断言前清一次任务队列
  const flush = () => new Promise((r) => setImmediate(r));

  // ① 官方通道 + 产生了新扣费 → 回报一次（文案取刷新后的 last）
  CF.session.item = itemA; CF.session.history = [];
  activeChannelId = 'official';
  refreshCostCalls = 0;
  accountCost = { last: { at: 'T1', micro: 1890, text: '¥0.0019', reason: 'AI 调用 glm-5.3-flash' } };
  accountCostAfterRefresh = { last: { at: 'T2', micro: 2100, text: '¥0.0021', reason: 'AI 调用 glm-5.3-flash' } };
  ui = freshCostUI();
  await CF.runSend('问题', ui);
  await flush();
  eq(ui.costs.length, 1, 'cost: 官方通道回报本次消耗一次');
  eq(ui.costs[0] && ui.costs[0].costText, '¥0.0021', 'cost: 消耗文案来自刷新后的 last');
  eq(ui.costs[0] && ui.costs[0].balanceText, '¥9.99', 'cost: 同时带上剩余额度');
  eq(refreshCostCalls, 1, 'cost: 官方通道刷新了一次花费视图');

  // ② 自带 Key 通道 → 不刷新也不显示（不经本站、不计量，显示 ¥0 是误导）
  refreshCostCalls = 0;
  accountCost = { last: { at: 'T3', micro: 1, text: '¥0.0001', reason: '' } };
  accountCostAfterRefresh = { last: { at: 'T4', micro: 1, text: '¥0.0001', reason: '' } };
  activeChannelId = 'custom';
  ui = freshCostUI();
  await CF.runSend('问题', ui);
  await flush();
  eq(ui.costs.length, 0, 'cost: 自带 Key 通道不显示消耗');
  eq(refreshCostCalls, 0, 'cost: 自带 Key 通道不发起刷新');

  // ③ 官方通道但本次未产生新扣费（成本取整为 0 / 上游未给 usage）→ 跳过
  //    拿上一次的流水冒充「本次」是错的，宁可不显示
  activeChannelId = 'official';
  refreshCostCalls = 0;
  const stale = { last: { at: 'T5', micro: 500, text: '¥0.0005', reason: 'AI 调用 x' } };
  accountCost = stale;
  accountCostAfterRefresh = stale;
  ui = freshCostUI();
  await CF.runSend('问题', ui);
  await flush();
  eq(ui.costs.length, 0, 'cost: at 未变（本次未计费）→ 不显示');
  eq(refreshCostCalls, 1, 'cost: 未计费也刷新了一次（判断依据来自服务端）');

  // ④ 旧服务端没有 cost 块 → 静默，绝不影响回答
  refreshCostCalls = 0;
  accountCost = null; accountCostAfterRefresh = null;
  ui = freshCostUI();
  await CF.runSend('问题', ui);
  await flush();
  eq(ui.costs.length, 0, 'cost: 旧服务端无 cost 块 → 静默不显示');
  has(ui.done, aiReply, 'cost: 取不到花费不影响回答内容');
  accountCost = null; accountCostAfterRefresh = null; activeChannelId = 'official';

  // 无 Key
  aiReady = false; CF.session.item = itemA; CF.session.history = [];
  ui = freshUI();
  await CF.runSend('问题', ui);
  eq(ui.errors.length, 1, 'runSend: 无 Key → onError 一次');
  has(ui.errors[0], I18n.t('chatNoKey'), 'runSend: 无 Key 的错误文案正确');
  eq(CF.session.history.length, 0, 'runSend: 无 Key 不入历史');
  aiReady = true;

  // 无条目
  CF.session.item = null; selectedItems.length = 0; readers.length = 0;
  ui = freshUI();
  await CF.runSend('问题', ui);
  eq(ui.errors.length, 1, 'runSend: 无条目 → onError 一次');
  has(ui.errors[0], I18n.t('chatNoItem'), 'runSend: 无条目的错误文案正确');
  selectedItems.length = 0; selectedItems.push(itemB);

  // 无条目但可 resolve（选中条目兜底）
  CF.session.item = null;
  ui = freshUI();
  await CF.runSend('问题', ui);
  eq(CF.session.item, itemB, 'runSend: 未锁定时 resolve 到选中条目');
  ok(ui.itemTitles.length >= 1, 'runSend: 条目变化通知 onItemChanged');
  eq(ui.errors.length, 0, 'runSend: resolve 成功后正常发送');

  // NO_PDF：buildMessages 抛 NO_PDF
  fullText = null; abstractFallback = false;
  CF.session.item = itemA; CF.session.history = [];
  ui = freshUI();
  await CF.runSend('问题', ui);
  eq(ui.errors.length, 1, 'runSend: NO_PDF → onError 一次');
  has(ui.errors[0], I18n.t('chatNoPdf'), 'runSend: NO_PDF 的错误文案正确');
  eq(CF.session.history.length, 0, 'runSend: NO_PDF 不入历史');
  fullText = '论文全文……'; abstractFallback = true;

  // ABORTED：停止后丢弃半截、不入历史
  CF.session.item = itemA; CF.session.history = [];
  ui = freshUI();
  const p = CF.runSend('需要停止的问题', ui);
  await tick(1);
  CF.stop();
  await p;
  ok(ui.aborted, 'runSend: 停止 → onAbort');
  eq(ui.done, '', 'runSend: 停止后无 onDone');
  eq(CF.session.history.length, 0, 'runSend: 停止的轮次不入历史');
  eq(CF.session.busy, false, 'runSend: 停止后 busy=false');

  // busy 重入
  CF.session.item = itemA;
  chatStreamDelay = true;
  ui = freshUI();
  const slow = CF.runSend('慢问题', ui);
  await tick(1);
  const ui2 = freshUI();
  await CF.runSend('并发的第二个问题', ui2);
  eq(ui2.user, '', 'runSend: busy 期间重入被忽略');
  eq(ui2.errors.length, 0, 'runSend: busy 重入不产生错误');
  CF.stop();
  await slow;
  chatStreamDelay = false;

  /* ---------------- ②.5 会话切换代际校验（0.54.x 审查 P1-6） ----------------
   * 回归点：A 论文的回答在切到 B 之后才返回 → 绝不能写进 B 的 history / 存档。 */

  const savedSessions = [];
  sandbox.ChatSessions = {
    MAX_SESSIONS: 50,
    save(sess) { savedSessions.push(JSON.parse(JSON.stringify(sess))); return { id: 'cs-test' }; },
    latestForItem() { return null; },
    latest() { return null; },
    remove() { return false; },
  };

  // ① 流式：delta 已到、切条目 → 中止 + 丢弃
  CF.session.item = itemA; CF.session.history = []; savedSessions.length = 0;
  chatStreamDelay = true;
  ui = freshUI();
  const switched = CF.runSend('A 论文的问题', ui);
  await tick(1);
  eq(CF.setSessionItem(itemB), '', '切条目时 A 会话尚无历史 → 不报 switched');
  await switched;
  eq(ui.aborted, true, '切条目：在途流式轮次走 onAbort');
  eq(CF.session.history.length, 0, '切条目：旧回答不写进新会话 history');
  eq(savedSessions.length, 0, '切条目：旧回答不落盘');
  eq(CF.session.item, itemB, '切条目：会话已指向新条目');
  chatStreamDelay = false;

  // ② 非流式：没有可 abort 的句柄，只能靠代际校验丢弃（P1-6 核心）
  PrefStore.set(PREFIX + 'readerPopupStream', false);
  chatGate = true; chatResolvers.length = 0;
  CF.session.item = itemA; CF.session.history = []; savedSessions.length = 0;
  ui = freshUI();
  const nonStream = CF.runSend('非流式问题', ui);
  await tick(1);
  CF.setSessionItem(itemB);
  while (chatResolvers.length) chatResolvers.shift()();
  await nonStream;
  eq(ui.aborted, true, '非流式：切条目后迟到结果走 onAbort');
  eq(ui.done, '', '非流式：切条目后不触发 onDone');
  eq(CF.session.history.length, 0, '非流式：旧回答不写进新会话');
  eq(savedSessions.length, 0, '非流式：旧回答不落盘');
  PrefStore.delete(PREFIX + 'readerPopupStream');
  chatGate = false;

  // ③ /clear 在生成中：先停再清，旧答案不得清空后又写回来
  PrefStore.set(PREFIX + 'readerPopupStream', false);
  chatGate = true; chatResolvers.length = 0;
  CF.session.item = itemA; CF.session.history = []; savedSessions.length = 0;
  ui = freshUI();
  const busyClear = CF.runSend('清空测试', ui);
  await tick(1);
  CF._clearHistory(null);
  while (chatResolvers.length) chatResolvers.shift()();
  await busyClear;
  eq(ui.aborted, true, '/clear：生成中清空会中止在途轮次');
  eq(CF.session.history.length, 0, '/clear：清空后旧答案不写回');
  eq(savedSessions.length, 0, '/clear：清空后不落盘');
  PrefStore.delete(PREFIX + 'readerPopupStream');
  chatGate = false;

  delete sandbox.ChatSessions;

  /* ---------------- ③ 几何 pref 解析与夹取 ---------------- */

  eq(CF._parsePair('10,20', [1, 2])[0], 10, 'parsePair: 合法值');
  eq(CF._parsePair('bad', [7, 8])[1], 8, 'parsePair: 坏值回退默认');
  eq(CF._parsePair('', [5, 6]).length, 2, 'parsePair: 空串回退');
  eq(CF._clamp(50, 0, 10), 10, 'clamp: 上界');
  eq(CF._clamp(-5, 0, 10), 0, 'clamp: 下界');

  /* ---------------- ③.5 引用识别 _citeRefsOf（纯函数） ---------------- */

  const refsOf = (t) => CF._citeRefsOf(t);
  eq(refsOf('文献 1').length, 1, 'citeRefs: 「文献 1」命中');
  eq(refsOf('文献 1')[0].n, 1, 'citeRefs: n=1');
  eq(refsOf('文献 1')[0].start, 0, 'citeRefs: start 指向「文」');
  eq(refsOf('文献 1')[0].end, 4, 'citeRefs: end 不含后续字符');
  eq(refsOf('文献2')[0].n, 2, 'citeRefs: 无空格命中');
  eq(refsOf('（文献 3）')[0].n, 3, 'citeRefs: 全角括号内命中');
  eq(refsOf('文献 4，')[0].n, 4, 'citeRefs: 后接中文逗号命中');
  eq(refsOf('文献 5。')[0].n, 5, 'citeRefs: 句末句号命中');
  eq(refsOf('文献 6 的方法')[0].n, 6, 'citeRefs: 后接空格命中');

  eq(refsOf('文献综述').length, 0, 'citeRefs: 「文献综述」不命中');
  eq(refsOf('参考文献 3').length, 0, 'citeRefs: 「参考文献 3」不命中');
  eq(refsOf('文献 10').length, 0, 'citeRefs: 两位数「文献 10」不命中');
  eq(refsOf('文献 0').length, 0, 'citeRefs: 「文献 0」不命中');
  eq(refsOf('文献 2表明').length, 0, 'citeRefs: 后接汉字不命中');
  eq(refsOf('文献 2a').length, 0, 'citeRefs: 后接字母不命中');
  eq(refsOf('').length, 0, 'citeRefs: 空串安全');

  const twoRefs = refsOf('文献 1 与文献 3');
  eq(twoRefs.length, 2, 'citeRefs: 多个引用全量返回');
  eq(twoRefs[1] && twoRefs[1].n, 3, 'citeRefs: 第二个引用 n=3');

  /* ---------------- ③.6 渲染改写 _decorateCites（无 DOM 依赖） ---------------- */

  eq(CF._decorateCites('<p>文献 1</p>', null), '<p>文献 1</p>', 'decorate: 无 chip 原样返回');
  eq(CF._decorateCites('<p>文献 1</p>', []), '<p>文献 1</p>', 'decorate: 空 chip 原样返回');
  has(CF._decorateCites('<p>文献 1</p>', [itemA]), 'data-item-id="101"', 'decorate: 命中 chip 生成 data-item-id');
  eq(CF._decorateCites('<p>文献 2</p>', [itemA]), '<p>文献 2</p>', 'decorate: n 越界保持纯文本');
  eq(CF._decorateCites('<pre><code>文献 1</code></pre>', [itemA]),
    '<pre><code>文献 1</code></pre>', 'decorate: 代码块内不处理');
  const itemQ = { id: 303, getDisplayTitle: () => 'A "quoted" <paper>' };
  has(CF._decorateCites('<p>文献 1</p>', [itemQ]),
    'title="A &quot;quoted&quot; &lt;paper&gt;"', 'decorate: title 属性转义');

  /* ---------------- ③.7 引用开关 pref（默认开 / 可关 / 坏值安全） ---------------- */

  eq(CF._citeLinksEnabled(), true, 'citeLinks: 未配置时默认开');
  PrefStore.set(PREFIX + 'citeLinksEnabled', false);
  eq(CF._citeLinksEnabled(), false, 'citeLinks: pref=false 关闭');
  PrefStore.set(PREFIX + 'citeLinksEnabled', 'false');
  eq(CF._citeLinksEnabled(), false, 'citeLinks: 字符串 false 也关闭');
  PrefStore.delete(PREFIX + 'citeLinksEnabled');
  eq(CF._citeLinksEnabled(), true, 'citeLinks: 删除后恢复默认开');

  /* ---------------- ④ _resolveItem：reader 优先、选中回退 ---------------- */

  // reader 引用必须原位 mutate（readers 数组已被 Zotero.Reader._readers 引用，
  // 重新赋值变量会断开桩）
  readers.length = 0;
  selectedItems.length = 0; selectedItems.push(itemB);
  eq(CF._resolveItem(), itemB, 'resolveItem: 无 reader → 选中条目');
  // reader 里是 itemA 的 PDF 附件（parent 101）
  readers.push({ itemID: 999, _iframeWindow: null });
  Zotero.Items.get = (id) => (id === 999 ? { id: 999, isRegularItem: () => false, parentItemID: 101 } : (id === 101 ? itemA : itemB));
  eq(CF._resolveItem(), itemA, 'resolveItem: reader 附件上溯父条目');
  readers.length = 0;
  // 还原 Items.get 桩（上一段为了附件上溯临时改写过）
  Zotero.Items.get = (id) => (id === 101 ? itemA : id === 202 ? itemB : null);

  /* ---------------- ⑤ 悬浮窗 DOM：构建 / 发送 / 输入历史 / 注入 / 停靠 ---------------- */

  const entry = CF._ensure(win);
  ok(!!entry, '悬浮窗构建成功');
  ok(docRoot.byId(CF.ROOT_ID) === entry.root, '悬浮窗已挂载到窗口文档');
  eq(entry.root.style.display, 'none', '初始隐藏');
  const refs = entry.refs;
  ok(refs.head && refs.msgs && refs.input && refs.sendBtn, '关键结构齐备（标题栏/消息区/输入框/发送）');
  ok(entry.refs.dockLBtn && entry.refs.dockRBtn && entry.refs.opBtn && entry.refs.popBtn, '停靠/透明度/分屏按钮齐备');

  // show：默认浮起
  CF.setSessionItem(itemA);
  CF.show(win);
  eq(entry.root.style.display, 'flex', 'show 后可见');
  has(refs.titleEl.textContent, '论文A', '标题显示文献名');

  // 发送一轮（走悬浮窗 UI 回调）
  CF.session.history = [];
  refs.input.value = '悬浮窗里的问题';
  CF._doSend(entry);
  await tick(6);
  eq(CF.session.history.length, 2, '悬浮窗发送成功入历史');
  const bubbles = refs.msgs.children.filter((c) => c.className.indexOf('pp-cf-msg') >= 0);
  ok(bubbles.length >= 2, '悬浮窗渲染 user + assistant 气泡');
  has(refs.msgs.textContent, '悬浮窗里的问题', '用户气泡可见');
  ok(String(bubbles[bubbles.length - 1].innerHTML || '').indexOf('<') >= 0,
    'assistant 气泡走 MdLite 富文本');

  // 输入历史 ↑↓（回溯→还原）
  refs.input.fire('keydown', { key: 'ArrowUp', selectionStart: 0, selectionEnd: 0, preventDefault() {} });
  has(refs.input.value, '悬浮窗里的问题', '↑ 回溯输入历史');
  refs.input.fire('keydown', { key: 'ArrowDown', selectionStart: refs.input.value.length, preventDefault() {} });
  eq(refs.input.value, '', '↓ 回到末尾清空');

  // 停靠切换
  CF._dock(entry, 'right');
  eq(entry.geo.dock, 'right', '停靠右侧生效');
  CF._dock(entry, 'left');
  eq(entry.geo.dock, 'left', '停靠左侧生效');
  CF._dock(entry, '');
  eq(entry.geo.dock, '', '取消停靠恢复浮动');
  eq(String(getPref('chatFloatDock', '')), '', '停靠状态持久化写回');

  // 位置持久化
  entry.geo.x = 120; entry.geo.y = 60; entry.geo.w = 420; entry.geo.h = 560;
  CF._saveGeo(entry);
  eq(String(getPref('chatFloatPos', '')), '120,60', '位置持久化');
  eq(String(getPref('chatFloatSize', '')), '420,560', '尺寸持久化');
  const geo2 = CF._restoreGeo();
  eq(geo2.x, 120, 'restoreGeo: 位置读回');
  eq(geo2.h, 560, 'restoreGeo: 尺寸读回');

  // hide / toggle
  CF.hide(win);
  eq(entry.root.style.display, 'none', 'hide 后隐藏');
  CF.toggle(win);
  eq(entry.root.style.display, 'flex', 'toggle 再度唤起');
  CF.toggle(win);
  eq(entry.root.style.display, 'none', 'toggle 关闭（对 toggle 幂等）');

  // 划词注入：唤起 + 预填
  CF.session.item = null;
  const injected = CF.injectQuote(itemA, '选中的原文片段');
  eq(injected, true, 'injectQuote 返回成功');
  has(refs.input.value, '选中的原文片段', '注入选区到输入框');
  eq(entry.root.style.display, 'flex', '注入唤起悬浮窗');
  eq(CF.session.item, itemA, '注入锁定条目');

  /* ---------------- ⑤.5 自定义 UI entry 的 send 钩子（0.47.0 分屏窗口） ---------------- */

  const cwDoc = makeDoc();
  const cwRoot = new El('div');
  cwDoc.docRoot.appendChild(cwRoot);
  const cwChips = new El('div');
  const cwInput = new El('textarea');
  const cwEntry = {
    win: { document: cwDoc.document },
    root: cwRoot,
    refs: { chips: cwChips, input: cwInput },
    sendCalls: [],
    send() { this.sendCalls.push(cwInput.value); },
  };
  CF._renderChips(cwEntry);
  ok(cwChips.children.length > 0, 'renderChips 渲染自定义 entry 的标签');
  const chipBtn = cwChips.children.find((c) => c.tag === 'button');
  ok(!!chipBtn, '自定义 entry 的标签按钮存在');
  cwInput.value = '';
  chipBtn.click();
  eq(cwEntry.sendCalls.length, 1, '标签点击走 entry.send 钩子（不再落回 _doSend）');
  has(cwEntry.sendCalls[0], '请总结这篇论文', '钩子收到标签提示词');
  eq(cwInput.value, '请总结这篇论文', '标签点击预填输入框');

  /* ---------------- ⑤.6 标签 {input} 替换（0.48.x：先输入主题再点标签） ---------------- */

  const savedCT = sandbox.CommandTags;
  sandbox.CommandTags = {
    all: () => [{ id: 't1', label: '综述', prompt: '我要写关于「{input}」的综述', color: '', trigger: '' }],
  };
  const cwChips2 = new El('div');
  const cwInput2 = new El('textarea');
  const cwEntry2 = {
    win: { document: cwDoc.document },
    root: cwRoot,
    refs: { chips: cwChips2, input: cwInput2 },
    sendCalls: [],
    send() { this.sendCalls.push(cwInput2.value); },
  };
  CF._renderChips(cwEntry2);
  const chip2 = cwChips2.children.find((c) => c.tag === 'button');
  ok(!!chip2, '⑤.6 标签按钮存在');
  cwInput2.value = '图神经网络';
  chip2.click();
  eq(cwEntry2.sendCalls[0], '我要写关于「图神经网络」的综述',
    '标签 prompt 含 {input} 且输入框有内容 → 替换后发送');
  cwInput2.value = '';
  chip2.click();
  eq(cwEntry2.sendCalls[1], '我要写关于「{input}」的综述',
    '空输入框 → {input} 保持字面（trigger 路径仍可命中）');
  sandbox.CommandTags = savedCT;

  /* ---------------- ⑤.7 AI 回答内引用可点击（0.51.0） ---------------- */

  const styleEl = docRoot.byId(CF.STYLE_ID);
  has(styleEl && styleEl.textContent, '.pp-cf-cite', '样式表含 .pp-cf-cite');
  has(styleEl && styleEl.textContent, 'border-bottom:1px dotted', '引用样式为点线底边');

  // 真实渲染路径 ①：_doSend → onDelta/onDone → _appendBubble/_renderAssistant
  CF.session.history = [];
  CF.session.item = itemA;
  CF.session.contextItems = [101, 202];
  aiReply = '文献 1 提出了方法，文献 2 做了验证；文献 3 不存在；文献综述见参考文献 4。';
  refs.input.value = '引用渲染测试';
  CF._doSend(entry);
  await tick(6);
  const citeBubbles = refs.msgs.children.filter((c) => c.className.indexOf('pp-cf-msg') >= 0);
  const citeBubble = citeBubbles[citeBubbles.length - 1];
  ok(!!citeBubble, '引用测试：assistant 气泡已生成');
  has(citeBubble.innerHTML, 'class="pp-cf-cite" data-item-id="101"', '文献 1 → data-item-id=101');
  has(citeBubble.innerHTML, 'data-item-id="202"', '文献 2 → data-item-id=202');
  has(citeBubble.innerHTML, 'title="论文A"', '引用片段带条目标题 tooltip');
  eq((String(citeBubble.innerHTML).match(/pp-cf-cite/g) || []).length, 2,
    '越界 n /「文献综述」/「参考文献」不生成可点片段');

  // 真实渲染路径 ②：_renderHistory 重放（历史重建同样生效）
  CF.session.history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '历史里也提到文献 2。' },
  ];
  CF._renderHistory(entry);
  const replayed = refs.msgs.children.filter((c) => c.className.indexOf('pp-cf-msg') >= 0);
  const replayedA = replayed[replayed.length - 1];
  has(replayedA.innerHTML, 'data-item-id="202"', '_renderHistory 重放同样生成可点引用');

  // 开关关闭 → 纯文本（不破坏 Markdown 渲染）
  PrefStore.set(PREFIX + 'citeLinksEnabled', false);
  CF._renderHistory(entry);
  const offBubbles = refs.msgs.children.filter((c) => c.className.indexOf('pp-cf-msg') >= 0);
  const offBubble = offBubbles[offBubbles.length - 1];
  eq((String(offBubble.innerHTML).match(/pp-cf-cite/g) || []).length, 0,
    'pref 关闭 → 引用退化为纯文本');
  has(offBubble.innerHTML, '<p>', 'pref 关闭仍走 MdLite 富文本');
  PrefStore.delete(PREFIX + 'citeLinksEnabled');

  // 跳转：只选中条目，selectItem 一次
  selectCalls.length = 0;
  eq(CF._focusItem(entry, 101), true, '_focusItem: 条目存在 → true');
  eq(selectCalls.length, 1, '_focusItem: selectItem 调用一次');
  eq(selectCalls[0], 101, '_focusItem: selectItem 收到条目 ID');

  // 跳转：条目已删除 → 系统气泡 + 不触摸选择
  const beforeCount = refs.msgs.children.length;
  eq(CF._focusItem(entry, 4242), false, '_focusItem: 条目不存在 → false');
  eq(selectCalls.length, 1, '_focusItem: 条目不存在不调用 selectItem');
  eq(refs.msgs.children.length, beforeCount + 1, '_focusItem: 条目不存在追加系统提示');
  const goneBubble = refs.msgs.children[refs.msgs.children.length - 1];
  has(goneBubble.textContent, '引用条目已不存在', '提示文案为「引用条目已不存在」');

  // 跳转：面板异常 → 静默失败（不抛、不误报）
  selectThrows = true;
  eq(CF._focusItem(entry, 101), false, '_focusItem: 面板异常 → 静默 false');
  selectThrows = false;
  eq(selectCalls.length, 1, '_focusItem: 异常时不计数成功');

  /* ---------------- ⑥ saveHistoryAsNote ---------------- */

  CF.session.item = itemA;
  CF.session.history = [
    { role: 'user', content: '问1' },
    { role: 'assistant', content: '答1' },
  ];
  noteArgs = null;
  const saved = await CF.saveHistoryAsNote(null);
  eq(saved, true, '存为笔记成功');
  ok(!!noteArgs, '笔记参数齐备');
  has(noteArgs.md, '问1', '笔记含问答内容');
  CF.session.history = [];
  eq(await CF.saveHistoryAsNote({ onError: (m) => ui.errors.push(m) }), false, '空历史存笔记返回失败');

  /* ---------------- ⑦ Esc 接线 ---------------- */

  // _bindEsc 在 _build 时把 keydown 捕获监听挂到 document（不是 docRoot）
  ok(Array.isArray(document.handlers.keydown) && document.handlers.keydown.length > 0,
    'Esc 捕获监听已挂到窗口 document');

  /* ---------------- ⑧ unregister 清场 ---------------- */

  CF.register('test@plugin');
  CF.unregister();
  ok(!docRoot.byId(CF.ROOT_ID), 'unregister 后悬浮窗 DOM 已摘除');
  ok(!docRoot.byId(CF.STYLE_ID), 'unregister 后样式表已摘除');
  eq(CF.session.history.length, 0, 'unregister 重置会话');
  eq(CF.session.item, null, 'unregister 清除锁定条目');

  /* ---------------- 汇总 ---------------- */

  console.log(`\nchat-float: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('ALL OK');

})().catch((e) => { console.error(e); process.exit(1); });
