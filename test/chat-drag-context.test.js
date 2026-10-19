#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 拖拽条目作为 AI 问答上下文（chip）测试（0.44.0）
 *
 * 覆盖（参考 chat-float.test.js 的 Node vm + 迷你 DOM 桩写法）：
 *   ① drop 数据解析：zotero/item flavor → itemID 列表（逗号/空白分隔、坏值过滤）；
 *   ② chip 状态机：加入去重 / 上限 5 条 / 移除 / 附件上溯父条目；
 *   ③ 会话保存恢复：chip itemID 挂在 ChatFloat.session（跨窗口重渲染 = 恢复），
 *      workbench Sessions 快照 chips 字段 pref 往返；
 *   ④ prompt 拼接：多篇「文献 n」标记、单篇截断、全文缺失回退摘要、
 *      chip 优先于「锁定当前条目」；
 *   ⑤ DOM：drop 生成 chip 行、× 移除、超限提示气泡、dragover 放行判定。
 *
 * 运行：node test/chat-drag-context.test.js
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
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 240) });
}

/* ---------------- 迷你 DOM（与 chat-float.test.js 同款） ---------------- */

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

function makeWin() {
  const { document, docRoot } = makeDoc();
  const win = {
    document, innerWidth: 1280, innerHeight: 800, ZoteroPane: {},
    openDialog() { throw new Error('unexpected openDialog'); },
  };
  return { win, document, docRoot };
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const PREFIX = 'extensions.zotero.papilot.';
const getPref = (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d);

// 条目表：101..107（上限测试）+ 201..207（第二组 id）；901 是 101 的 PDF 附件
function mkItem(id, title) {
  return {
    id, isRegularItem: () => true,
    getDisplayTitle: () => title,
    getField: (f) => (f === 'abstractNote' ? (abstractById[id] || '') : ''),
    getCreators: () => [{ firstName: '', lastName: '作者' + id }],
  };
}
const items = {};
for (let i = 101; i <= 107; i++) items[i] = mkItem(i, '论文' + i);
for (let i = 201; i <= 207; i++) items[i] = mkItem(i, '论文' + i);
items[901] = { id: 901, isRegularItem: () => false, parentItemID: 101,
  getDisplayTitle: () => '论文101.pdf', getField: () => '', getCreators: () => [] };

let abstractById = {};
let fullTextById = {};
let lastMessages = null;
const aiReply = 'AI 回答';

const mainWin = makeWin();
const Zotero = {
  locale: 'zh-CN',
  Prefs: { get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined), set: (k, v) => PrefStore.set(k, v) },
  getMainWindow: () => mainWin.win,
  getMainWindows: () => [mainWin.win],
  getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
  Items: { get: (id) => items[id] || null },
  Reader: { _readers: [] },
  Utilities: { Internal: { copyText() {} } },
  logError() {},
};

const AIClient = {
  hasKey: () => true,
  guidance: () => '',
  _config: () => ({ ok: true, channelId: 'custom' }), // 非官方通道：跳过花费回报，测试更聚焦
  async chat(messages) { lastMessages = messages; return aiReply; },
  chatStream(messages, onDelta) {
    lastMessages = messages;
    const h = {
      aborted: false,
      abort() { this.aborted = true; },
      promise: (async () => {
        await new Promise((r) => setImmediate(r));
        onDelta(aiReply);
        return aiReply;
      })(),
    };
    return h;
  },
};

const AIChat = {
  paperMeta(item) {
    return {
      title: item.getDisplayTitle(),
      creators: '作者' + item.id,
      year: '2024',
      pub: '期刊X',
    };
  },
  async getFullText(item) {
    return fullTextById[item.id] !== undefined ? fullTextById[item.id] : null;
  },
  // 0.48.0 历史滑窗（与真实实现同语义：最近 N 轮，断头 assistant 丢弃）
  windowHistory(history, rounds) {
    const list = Array.isArray(history) ? history : [];
    let n = Number(rounds);
    if (!isFinite(n)) n = 6;
    n = Math.max(1, Math.min(30, Math.floor(n)));
    const cut = list.slice(-n * 2);
    return cut.length && cut[0] && cut[0].role === 'assistant' ? cut.slice(1) : cut;
  },
  // 单篇路径桩：打上 'sys-single' 标记，用于断言「chip 存在时不走单篇路径」
  async buildMessages(item, q, history, ft) {
    if (!ft) throw new Error('NO_PDF');
    return [{ role: 'system', content: 'sys-single' }]
      .concat(history.slice(-12))
      .concat([{ role: 'user', content: q }]);
  },
};

let noteArgs = null;
const Prompts = { all: () => [] };

const sandbox = {
  console, Zotero, Services: {}, AIClient, AIChat, Prompts,
  IOUtils: {}, PathUtils: {},
  setTimeout: (fn) => { if (typeof fn === 'function') setTimeout(fn, 0); return 0; },
  clearTimeout: () => {},
  Promise, Date, Math, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/panels/chat-float.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
// utils.js 的 var Notes 覆盖预注入桩（chat-float.test.js 同款处理）
sandbox.Notes.createFromMarkdown = async (item, title, md) => { noteArgs = { title, md, id: item.id }; return true; };
const CF = sandbox.ChatFloat;
const I18n = sandbox.I18n;

function freshUI() {
  return {
    user: '', done: '', errors: [],
    onUser(t) { this.user = t; },
    onStatus() {},
    onDelta() {},
    onDone(t) { this.done = t; },
    onError(m) { this.errors.push(m); },
    onAbort() {},
    onBusy() {},
    onItemChanged() {},
  };
}
function resetSession() {
  CF.session.item = null;
  CF.session.history = [];
  CF.session.inputHistory = [];
  CF.session.histIdx = -1;
  CF.session.contextItems = [];
  CF.session.busy = false;
}

(async function main() {
  /* ---------------- ① drop 数据解析 ---------------- */

  const dt = (raw, types) => ({
    types: types || ['zotero/item', 'text/plain'],
    getData: (f) => (f === 'zotero/item' ? raw : ''),
  });
  eq(CF._parseItemDrop(dt('101,202')).join(','), '101,202', 'drop: 逗号分隔解析');
  eq(CF._parseItemDrop(dt('101, 202 303')).join(','), '101,202,303', 'drop: 空白分隔容错');
  eq(CF._parseItemDrop(dt('101,abc,-5,0')).join(','), '101', 'drop: 坏值与非正数过滤');
  eq(CF._parseItemDrop(dt('')).length, 0, 'drop: 空数据 → 空列表');
  eq(CF._parseItemDrop(null).length, 0, 'drop: 无 dataTransfer → 空列表');
  eq(CF._parseItemDrop({ getData: () => { throw new Error('x'); } }).length, 0, 'drop: getData 抛错 → 空列表');

  /* ---------------- ② chip 状态机：去重 / 上限 / 移除 / 附件上溯 ---------------- */

  resetSession();
  let r = CF.addChipItems([101, 202]);
  eq(r.added.length, 2, 'chip: 两条新条目加入');
  eq(CF.session.contextItems.join(','), '101,202', 'chip: itemID 挂进会话对象');

  r = CF.addChipItems([101, 202, 103]);
  eq(r.added.length, 1, 'chip: 同批只新增 103');
  eq(r.dup, 2, 'chip: 重复拖入计数去重');
  eq(CF.session.contextItems.length, 3, 'chip: 去重后总数正确');

  r = CF.addChipItems([901]);
  eq(r.dup, 1, 'chip: PDF 附件上溯父条目后与已有 chip 去重');
  eq(CF.session.contextItems.length, 3, 'chip: 附件不重复占位');

  r = CF.addChipItems([999]);
  eq(r.invalid, 1, 'chip: 取不到的 itemID 记 invalid');

  // 上限：已有 101,202,103，再拖 104..107（4 条）→ 只进 2 条，2 条超限
  r = CF.addChipItems([104, 105, 106, 107]);
  eq(r.added.length, 2, 'chip: 上限内补满 5 条');
  eq(r.overflow, 2, 'chip: 超出 5 条的部分被拒绝并计数');
  eq(CF.session.contextItems.length, 5, 'chip: 总数封顶 5');

  CF.removeChipItem(104);
  eq(CF.session.contextItems.indexOf(104), -1, 'chip: × 移除生效');
  eq(CF.session.contextItems.length, 4, 'chip: 移除后总数减少');
  CF.removeChipItem(999); // 不存在 → 静默
  eq(CF.session.contextItems.length, 4, 'chip: 移除不存在 id 不崩');

  /* ---------------- ③ 会话保存恢复（悬浮窗：会话单源在 ChatFloat.session） ---------------- */

  resetSession();
  const w1 = makeWin();
  const entry1 = CF._ensure(w1.win);
  CF.addChipItems([101, 202]);
  eq(entry1.refs.ctxChips.children.length, 2, '恢复: chip 行渲染 2 条');
  has(entry1.refs.ctxChips.textContent, '论文101', '恢复: chip 显示条目标题');
  eq(entry1.refs.ctxChips.style.display, 'flex', '恢复: 有 chip 时行可见');

  // 隐藏→再显示：chip 从 session 恢复渲染
  CF.hide(w1.win);
  CF.show(w1.win);
  eq(entry1.refs.ctxChips.children.length, 2, '恢复: hide/show 后 chip 仍在');

  // 第二个窗口（分屏独立窗口同模式）：构建即从同一 session 恢复 chip
  const w2 = makeWin();
  const entry2 = CF._ensure(w2.win);
  eq(entry2.refs.ctxChips.children.length, 2, '恢复: 第二个窗口共享同一 chip 列表');
  CF.removeChipItem(101);
  eq(entry1.refs.ctxChips.children.length, 1, '恢复: 移除后窗口1同步');
  eq(entry2.refs.ctxChips.children.length, 1, '恢复: 移除后窗口2同步');

  // unregister 重置会话含 chip
  CF.unregister();
  eq(CF.session.contextItems.length, 0, '恢复: unregister 清空 chip');

  /* ---------------- ③b workbench 会话快照：chips 字段 pref 往返 ---------------- */

  const wbSandbox = {
    console,
    window: { addEventListener() {} },
    document: { readyState: 'loading' },
  };
  vm.createContext(wbSandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/content/workbench.js'), 'utf8'),
    wbSandbox, { filename: 'workbench.js' });
  const Sessions = wbSandbox.window.PPWorkbench.Sessions;
  ok(!!Sessions, 'workbench: Sessions 纯逻辑可访问');
  const wbPref = new Map();
  const wbGet = (k) => wbPref.get(k);
  const wbSet = (k, v) => wbPref.set(k, v);
  let store = Sessions.load(wbGet);
  Sessions.upsert(store, {
    id: 's1', itemID: 101, title: '会话一', ts: Date.now(),
    transcript: [{ role: 'user', text: '问' }], history: [], chips: [101, 202],
  });
  Sessions.save(wbSet, store);
  const store2 = Sessions.load(wbGet);
  const restored = Sessions.find(store2, 's1');
  ok(!!restored, 'workbench: 会话恢复成功');
  eq(restored && restored.chips && restored.chips.join(','), '101,202',
    'workbench: chip itemID 列表随会话保存/恢复');

  /* ---------------- ④ prompt 拼接：多篇标记 / 截断 / 摘要回退 / 优先级 ---------------- */

  // ④-1 两篇全文 → 多篇标记齐全
  resetSession();
  fullTextById = { 101: 'AAA全文内容', 202: 'BBB全文内容' };
  CF.addChipItems([101, 202]);
  let ui = freshUI();
  await CF.runSend('对比这两篇的方法', ui);
  eq(ui.errors.length, 0, 'prompt: 双 chip 发送无错误');
  ok(!!lastMessages, 'prompt: 消息已送达 AIClient');
  const sys0 = lastMessages[0];
  eq(sys0.role, 'system', 'prompt: 首条为 system');
  has(sys0.content, '【文献 1】', 'prompt: 含文献 1 标记');
  has(sys0.content, '【文献 2】', 'prompt: 含文献 2 标记');
  has(sys0.content, '论文101', 'prompt: 含第一篇标题');
  has(sys0.content, '论文202', 'prompt: 含第二篇标题');
  has(sys0.content, 'AAA全文内容', 'prompt: 含第一篇全文');
  has(sys0.content, 'BBB全文内容', 'prompt: 含第二篇全文');
  has(sys0.content, '文献 n', 'prompt: 含引用出处指引');
  eq(lastMessages[lastMessages.length - 1].content, '对比这两篇的方法', 'prompt: 末条为用户问题');
  eq(CF.session.history.length, 2, 'prompt: 成功轮次入历史');

  // ④-2 单篇截断
  const savedMax = CF.CHIP_TEXT_MAX;
  CF.CHIP_TEXT_MAX = 10;
  resetSession();
  fullTextById = { 101: 'X'.repeat(100) };
  CF.addChipItems([101]);
  ui = freshUI();
  await CF.runSend('问题', ui);
  has(lastMessages[0].content, '单篇已截断', 'prompt: 超长单篇被截断并标注');
  ok(lastMessages[0].content.indexOf('X'.repeat(100)) < 0, 'prompt: 截断后不含完整原文');
  CF.CHIP_TEXT_MAX = savedMax;

  // ④-3 全文缺失回退摘要
  resetSession();
  fullTextById = {};
  abstractById = { 101: '这是论文101的摘要' };
  CF.addChipItems([101]);
  ui = freshUI();
  await CF.runSend('问题', ui);
  has(lastMessages[0].content, '（摘要）', 'prompt: 无全文回退摘要并标注');
  has(lastMessages[0].content, '这是论文101的摘要', 'prompt: 摘要内容入 prompt');
  eq(ui.errors.length, 0, 'prompt: 摘要回退不报错（比单篇更宽容）');
  abstractById = {};

  // ④-4 既无全文也无摘要 → 仅题录，仍不报错
  resetSession();
  CF.addChipItems([101]);
  ui = freshUI();
  await CF.runSend('问题', ui);
  has(lastMessages[0].content, '仅题录', 'prompt: 双缺失退化为仅题录');
  eq(ui.errors.length, 0, 'prompt: 仅题录也不报错');

  // ④-5 chip 优先于「锁定当前条目」
  resetSession();
  fullTextById = { 202: 'BBB全文内容' };
  CF.session.item = items[101]; // 锁定条目 = 101
  CF.addChipItems([202]);       // chip = 202
  ui = freshUI();
  await CF.runSend('问题', ui);
  has(lastMessages[0].content, 'BBB全文内容', '优先级: 有 chip 时用 chip 条目上下文');
  ok(lastMessages[0].content.indexOf('sys-single') < 0, '优先级: 有 chip 时不走单篇 buildMessages');

  // ④-6 无 chip → 维持既有单篇行为（回归口径）
  resetSession();
  fullTextById = { 101: 'AAA全文内容' };
  CF.session.item = items[101];
  ui = freshUI();
  await CF.runSend('问题', ui);
  has(lastMessages[0].content, 'sys-single', '优先级: 无 chip 时维持锁定条目单篇路径');

  // ④-7 无锁定条目但有 chip → 不要求条目也能发
  resetSession();
  fullTextById = { 101: 'AAA全文内容' };
  CF.addChipItems([101]);
  ui = freshUI();
  await CF.runSend('问题', ui);
  eq(ui.errors.length, 0, '优先级: 仅 chip 无锁定条目也可发送');

  // ④-8 存笔记：无锁定条目时挂到第一篇 chip
  noteArgs = null;
  CF.session.history = [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }];
  const savedNote = await CF.saveHistoryAsNote(null);
  eq(savedNote, true, '笔记: chip 模式存笔记成功');
  eq(noteArgs && noteArgs.id, 101, '笔记: 挂到第一篇 chip 条目');

  /* ---------------- ⑤ DOM：drop 事件 → chip 行 / × 移除 / 超限提示 / dragover ---------------- */

  resetSession();
  const w3 = makeWin();
  const entry3 = CF._ensure(w3.win);
  CF.show(w3.win);
  const root = entry3.root;

  // dragover：zotero/item flavor 放行，其他 flavor 不放行
  let prevented = 0;
  root.fire('dragover', { dataTransfer: { types: ['zotero/item'] }, preventDefault() { prevented++; } });
  eq(prevented, 1, 'DOM: dragover 对 zotero/item 放行');
  root.fire('dragover', { dataTransfer: { types: ['text/plain'] }, preventDefault() { prevented++; } });
  eq(prevented, 1, 'DOM: dragover 对纯文本不放行');

  // drop：生成 chip
  let dropPrevented = 0;
  root.fire('drop', {
    dataTransfer: { types: ['zotero/item'], getData: (f) => (f === 'zotero/item' ? '101,202' : '') },
    preventDefault() { dropPrevented++; },
  });
  eq(dropPrevented, 1, 'DOM: drop 阻止默认行为');
  eq(CF.session.contextItems.join(','), '101,202', 'DOM: drop 后 chip 进入会话');
  eq(entry3.refs.ctxChips.children.length, 2, 'DOM: drop 后 chip 行渲染 2 条');

  // × 移除
  const chip0 = entry3.refs.ctxChips.children[0];
  const xBtn = chip0.byTag('button')[0];
  ok(!!xBtn, 'DOM: chip 含 × 按钮');
  xBtn.click();
  eq(CF.session.contextItems.join(','), '202', 'DOM: × 点击移除对应 chip');
  eq(entry3.refs.ctxChips.children.length, 1, 'DOM: chip 行同步减少');

  // 重复拖入 → dup 提示气泡
  root.fire('drop', {
    dataTransfer: { types: ['zotero/item'], getData: () => '202' },
    preventDefault() {},
  });
  ok(entry3.refs.msgs.children.some((c) => String(c.className).indexOf('pp-cf-msg') >= 0),
    'DOM: 重复拖入出现提示气泡');
  has(entry3.refs.msgs.textContent, I18n.t('chatChipDup'), 'DOM: 提示文案为「已在上下文中」');

  // 超限 → 拒绝并提示
  CF.session.contextItems = [101, 102, 103, 104, 105];
  CF._renderAllCtxChips();
  root.fire('drop', {
    dataTransfer: { types: ['zotero/item'], getData: () => '106,107' },
    preventDefault() {},
  });
  eq(CF.session.contextItems.length, 5, 'DOM: 超限后总数仍封顶 5');
  has(entry3.refs.msgs.textContent, I18n.t('chatChipLimit'), 'DOM: 超限提示气泡文案正确');

  // 全部移除 → chip 行隐藏
  CF.session.contextItems = [];
  CF._renderAllCtxChips();
  eq(entry3.refs.ctxChips.style.display, 'none', 'DOM: 无 chip 时行隐藏');

  CF.unregister();

  /* ---------------- 汇总 ---------------- */

  console.log(`\nchat-drag-context: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('ALL OK');

})().catch((e) => { console.error(e); process.exit(1); });
