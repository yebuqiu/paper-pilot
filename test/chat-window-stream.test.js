#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 分屏 AI 窗口（chat-window.js）流式渲染 / 关闭 / 中断测试
 *
 * 覆盖 0.54.x 审查的三条回归：
 *   P1-7 逐 token 全量渲染 —— 长回答的 MdLite 解析次数必须远小于 delta 次数；
 *   P1-7 关窗不中止 —— window unload 必须调用 ChatFloat.stop()，且窗口 entry 摘除；
 *   P1-2 中断丢半截 —— onAbort/onError 保留已生成内容并加「（已中断）」提示；
 *   P1-7 自动滚底 —— 用户向上翻阅时不再被强行拉回底部。
 *
 * 环境：真加载 utils.js + chat-float.js（复用其 runSend / 节流渲染），
 *       再用迷你 DOM 桩跑 chat-window.js 的 boot()。
 * 运行：node test/chat-window-stream.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

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
    { want: needle, got: String(hay).slice(0, 240) });
}

/* ---------------- 迷你 DOM ---------------- */

function classesOf(n) {
  return String(n.className || '').split(/\s+/).filter(Boolean);
}

/** 极简选择器：支持 tag / .a.b / [attr="v"] */
function matchSimple(node, sel) {
  if (!node || !sel) return false;
  let m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (m) return node.getAttribute(m[1]) === m[2];
  if (sel.charAt(0) === '.') {
    const want = sel.slice(1).split('.').filter(Boolean);
    const have = classesOf(node);
    return want.every((c) => have.indexOf(c) >= 0);
  }
  const m2 = /^(\w+)?((?:\.[\w-]+)*)$/.exec(sel);
  if (!m2) return false;
  if (m2[1] && node.tag !== m2[1]) return false;
  const want2 = (m2[2] || '').split('.').filter(Boolean);
  const have2 = classesOf(node);
  return want2.every((c) => have2.indexOf(c) >= 0);
}

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {};
    this._attrs = {}; this.className = ''; this.id = '';
    this._text = ''; this.value = ''; this.disabled = false;
    this.parentNode = null; this.handlers = {};
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 200;
    this.title = ''; this._html = '';
    const self = this;
    this.classList = {
      contains: (c) => classesOf(self).indexOf(c) >= 0,
      add: (c) => { if (!this.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: (c) => { self.className = classesOf(self).filter((x) => x !== c).join(' '); },
      toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); },
    };
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
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, c); else this.children.unshift(c);
    return c;
  }
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
    for (const f of (this.handlers[ev] || []).slice()) f(arg || {});
  }
  click() { this.fire('click'); }
  focus() {}
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return !!n._isDocRoot;
  }
  get firstChild() { return this.children[0] || null; }
  set textContent(v) {
    this._text = v == null ? '' : String(v);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(v) {
    // 真 DOM 语义：重建会摘掉原有子节点（操作条能否挂回靠 parentNode 判断）
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._html = v == null ? '' : String(v);
    this._text = this._html;
  }
  get innerHTML() { return this._html || ''; }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  querySelectorAll(sel) {
    const out = [];
    for (const n of this.all()) if (matchSimple(n, sel)) out.push(n);
    return out;
  }
  querySelector(sel) {
    const m = /^:scope\s*>\s*(.+)$/.exec(String(sel).trim());
    if (m) {
      for (const c of this.children) if (matchSimple(c, m[1])) return c;
      return null;
    }
    for (const n of this.all()) if (matchSimple(n, sel)) return n;
    return null;
  }
  byId(i) { return this.all().find((n) => n.id === i) || null; }
}

function makeDoc() {
  const docRoot = new El('window');
  docRoot._isDocRoot = true;
  const document = {
    readyState: 'complete',
    title: '',
    documentElement: docRoot,
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    createXULElement: (tag) => new El(tag),
    getElementById(id) { return docRoot.byId(id); },
    querySelector(sel) { return docRoot.querySelector(sel); },
    querySelectorAll(sel) { return docRoot.querySelectorAll(sel); },
  };
  return { document, docRoot };
}

/* ---------------- 桩环境（Zotero / AI） ---------------- */

const PrefStore = new Map();
const PREFIX = 'extensions.zotero.papilot.';

const itemA = {
  id: 101, isRegularItem: () => true,
  getDisplayTitle: () => '论文A', getField: () => '',
};

const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined),
    set: (k, v) => PrefStore.set(k, v),
  },
  Items: { get: () => null },
  Reader: { _readers: [] },
  logError() {},
  getMainWindow: () => null,
  getMainWindows: () => [],
  getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
};

let mdCalls = 0;
const mdLite = {
  toHtml(text) { mdCalls++; return '<p>' + String(text) + '</p>'; },
};

let plan = null;             // async (handle, onDelta) => finalText
const handles = [];
const AIClient = {
  hasKey: () => true,
  _config: () => ({ channelId: 'custom' }),
  chat: async () => '非流式回答',
  chatStream(messages, onDelta) {
    const h = {
      aborted: false,
      abort() { this.aborted = true; },
    };
    h.promise = (async () => {
      await new Promise((r) => setImmediate(r)); // 让 runSend 先拿到 handle
      let text = '';
      if (plan) text = await plan(h, onDelta);
      if (h.aborted) { const e = new Error('aborted'); e.message = 'ABORTED'; throw e; }
      return text;
    })();
    handles.push(h);
    return h;
  },
};

const AIChat = {
  async getFullText() { return '全文'; },
  paperMeta: () => ({ title: '论文A', creators: '作者', pub: '期刊', year: '2024' }),
  windowHistory: (h, n) => h.slice(-(n || 6)),
  async buildMessages(item, q, history) {
    return [{ role: 'system', content: 'sys' }]
      .concat(history.slice(-12))
      .concat([{ role: 'user', content: q }]);
  },
};

const { document, docRoot } = makeDoc();

// chat-window.xhtml 的骨架元素
const IDS = ['pp-cw-root', 'pp-cw-msgs', 'pp-cw-input', 'pp-cw-send', 'pp-cw-save',
  'pp-cw-clear', 'pp-cw-close', 'pp-cw-title', 'pp-cw-sub', 'pp-cw-chips',
  'pp-cw-ctx-chips', 'pp-cw-hint'];
for (const id of IDS) {
  const n = new El('div');
  n.id = id;
  docRoot.appendChild(n);
}
const headerEl = new El('div');
headerEl.setAttribute('class', 'pp-cw-header');
docRoot.appendChild(headerEl);

const winHandlers = {};
const win = {
  document,
  arguments: [{ Zotero }],
  innerWidth: 1000, innerHeight: 800,
  addEventListener(ev, fn) { (winHandlers[ev] = winHandlers[ev] || []).push(fn); },
  fire(ev) { for (const f of (winHandlers[ev] || []).slice()) f({}); },
  matchMedia: () => ({ matches: false }),
  setTimeout, clearTimeout,
  close() {},
};

const sandbox = {
  console, Zotero, Services: {}, AIClient, AIChat,
  Prompts: { all: () => [] },
  window: win, document,
  setTimeout, clearTimeout, setImmediate,
  Promise, Date, Math, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/panels/chat-float.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const CF = sandbox.ChatFloat;
const I18n = sandbox.I18n;
sandbox.Zotero.Papilot = {
  chatFloat: CF, mdLite, i18n: I18n, uiTheme: { current: () => null },
};

const msgsEl = document.getElementById('pp-cw-msgs');
const inputEl = document.getElementById('pp-cw-input');
const sendBtn = document.getElementById('pp-cw-send');

// 会话在窗口打开前已锁定论文 A（与真机「阅读器中开分屏」同序）
CF.session.item = itemA;
CF.session.history = [];
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'chrome/content/chat-window.js'), 'utf8'),
  sandbox, { filename: 'chrome/content/chat-window.js' });

function send(q) {
  inputEl.value = q;
  sendBtn.click();
}
async function waitIdle(limit = 4000) {
  const t0 = Date.now();
  while (CF.session.busy && Date.now() - t0 < limit) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 20)); // 让渲染定时器/微任务收尾
}
function lastAssistant() {
  const list = msgsEl.querySelectorAll('.pp-cw-msg.assistant');
  return list.length ? list[list.length - 1] : null;
}

(async function main() {
  /* ---------------- ⓪ 窗口注册为 ChatFloat entry ---------------- */
  ok(CF._wins.has(win), '分屏窗口已注册为 ChatFloat UI entry');
  ok(!!document.getElementById('pp-cw-root'), '窗口骨架存在');

  /* ---------------- ① 流式渲染节流（P1-7） ---------------- */

  const DELTAS = 60;
  plan = async (h, onDelta) => {
    let acc = '';
    for (let i = 0; i < DELTAS; i++) {
      acc += '片段' + i + '；';
      onDelta(acc);
      if (i % 15 === 0) await new Promise((r) => setTimeout(r, 20));
    }
    return acc;
  };
  mdCalls = 0;
  send('长回答请节流');
  await waitIdle();
  const finalText = '片段' + (DELTAS - 1) + '；';
  ok(mdCalls < DELTAS / 4, '流式渲染节流：MdLite 解析次数远小于 delta 次数',
    { mdCalls, deltas: DELTAS });
  has(lastAssistant() && lastAssistant().innerHTML, finalText, '流式结束后气泡是完整回答');
  eq(CF.session.history.length, 2, '成功轮次照常入历史');

  /* ---------------- ② 自动滚底仅在贴底时跟随（P1-7） ---------------- */

  CF.session.history = [];
  msgsEl.scrollHeight = 1000;
  msgsEl.scrollTop = 1000;
  plan = async (h, onDelta) => {
    let acc = '';
    for (let i = 0; i < 30; i++) {
      acc += '滚' + i;
      onDelta(acc);
      await new Promise((r) => setTimeout(r, 15));
    }
    return acc;
  };
  send('滚动测试');
  await new Promise((r) => setTimeout(r, 130)); // 首帧渲染后再把用户「翻上去」
  msgsEl.scrollTop = 100;
  await new Promise((r) => setTimeout(r, 260));
  eq(msgsEl.scrollTop, 100, '用户向上翻阅时不再被强行拉到底部');
  await waitIdle();

  /* ---------------- ③ 中断保留已生成内容（P1-2） ---------------- */

  CF.session.history = [];
  plan = async (h, onDelta) => {
    onDelta('这是已经生成的前半段');
    await new Promise((r) => setTimeout(r, 120));
    return '这是已经生成的前半段';
  };
  send('中断测试');
  await new Promise((r) => setTimeout(r, 40));
  CF.stop();
  await waitIdle();
  const abortedBubble = lastAssistant();
  ok(!!abortedBubble, '中断后 assistant 气泡仍在（不再整条 remove）');
  has(abortedBubble && abortedBubble.innerHTML, '这是已经生成的前半段',
    '中断后保留已生成的部分内容');
  has(abortedBubble && abortedBubble.textContent, '（已中断）', '中断内容带「（已中断）」提示');
  eq(CF.session.history.length, 0, '中断轮次不入历史');

  /* ---------------- ④ 关窗中止生成（P1-7） ---------------- */

  let stopCalls = 0;
  const origStop = CF.stop.bind(CF);
  CF.stop = function () { stopCalls++; return origStop(); };

  CF.session.history = [];
  plan = async (h, onDelta) => {
    onDelta('半截');
    await new Promise((r) => setTimeout(r, 400));
    return '半截';
  };
  send('关窗测试');
  await new Promise((r) => setTimeout(r, 40));
  const beforeClose = handles[handles.length - 1];
  win.fire('unload');
  await new Promise((r) => setTimeout(r, 60));
  ok(stopCalls >= 1, 'unload 时调用了 ChatFloat.stop()', { stopCalls });
  ok(beforeClose && beforeClose.aborted === true, '关闭窗口后流式句柄被 abort');
  ok(!CF._wins.has(win), 'unload 后窗口 entry 已摘除');
  await waitIdle();

  /* ---------------- 汇总 ---------------- */

  console.log(`\nchat-window-stream: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
