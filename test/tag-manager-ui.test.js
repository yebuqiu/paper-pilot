#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 标签管理器窗口 · 迷你 DOM 真渲染（0.70.0）
 *
 * 为什么要它：tag-ops 的单测只能证明「规则算得对」，证明不了**窗口能不能起来**。
 * 这类故障在真机上表现为「窗口空白 / 按钮点了没反应」，而且单测全绿 —— 项目已经踩过
 * 两次（tag-preview 的 DOM 未就绪、技能商店的 installedIds 接缝 bug）。
 *
 * 这里用迷你 DOM 真跑 tag-manager.js，并且**加载真实的 tag-ops.js**（只假 Zotero），
 * 断言六条线：
 *   ① 启动即渲染：列表有行、概览有统计、库名有回显
 *   ② 筛选与多选：搜索收敛行数、全选只作用于筛选结果
 *   ③ 破坏性操作必须两步：初始面板只有「预览删除」，没有可直接执行的删除按钮
 *   ④ 保护名单默认生效：#状态/待读 在批量删除预览里被跳过
 *   ⑤ 执行链：确认删除 → 调 removeFromLibrary + 写快照 → 列表刷新
 *   ⑥ 撤销链：快照页列出记录 → 撤销 → 标签重新加回条目
 *
 * 运行：node test/tag-manager-ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OPS = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'tag-ops.js');
const UI = path.join(ROOT, 'chrome', 'content', 'tag-manager.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'tag-manager.xhtml');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ==================== 迷你 DOM ==================== */

class El {
  constructor(tag) {
    this.tag = String(tag);
    this.children = [];
    this.style = {};
    this._attrs = {};
    this.className = '';
    this.id = '';
    this.handlers = {};
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.disabled = false;
    this._text = '';
    this.parentNode = null;
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
    // 真机上 setAttribute('disabled') 不一定拦住点击，property 才是准的
    if (k === 'disabled') this.disabled = String(v) !== 'false';
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get firstChild() { return this.children[0] || null; }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  fire(e, a) { for (const f of (this.handlers[e] || []).slice()) f(a || { type: e, preventDefault() {} }); }
  dispatchEvent(ev) { this.fire(ev && ev.type, ev); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  find(pred) {
    const out = [];
    const walk = (n) => { if (pred(n)) out.push(n); for (const c of n.children) walk(c); };
    walk(this);
    return out;
  }
}

const nodes = new Map();
const document = {
  readyState: 'complete',
  documentElement: { appendChild() {}, removeChild() {} },
  getElementById(id) { return nodes.get(id) || null; },
  createElementNS(ns, tag) { return new El(tag); },
  createElement(tag) { return new El(tag); },
  addEventListener() {},
  execCommand() { return true; },
};

const xhtmlSrc = fs.readFileSync(XHTML, 'utf8');
for (const m of xhtmlSrc.matchAll(/id="([A-Za-z0-9_-]+)"/g)) nodes.set(m[1], new El('div'));

/* xhtml 静态检查：未定义实体会让整个窗口空白（§30 同款判据，这里先自己拦一次） */
{
  const bad = [];
  for (const m of xhtmlSrc.matchAll(/&([a-zA-Z][a-zA-Z0-9]*);/g)) {
    if (!['amp', 'lt', 'gt', 'quot', 'apos'].includes(m[1])) bad.push(m[0]);
  }
  eq(bad.length, 0, xhtmlSrc.includes('windowtype="papilot:tag-manager"') ? 'X1 xhtml 无未定义实体' : 'X0 windowtype', bad);
}

/* ==================== 假 Zotero（够 tag-ops + 窗口用） ==================== */

const ITEMS = [
  { id: 1, title: 'Paper A', deleted: false, tags: [{ tag: 'DNN', type: 0 }, { tag: '#方法/深度学习', type: 0 }] },
  { id: 2, title: 'Paper B', deleted: false, tags: [{ tag: 'dnn', type: 0 }, { tag: '#状态/待读', type: 0 }] },
  { id: 3, title: 'Paper C', deleted: false, tags: [{ tag: '深度学习', type: 0 }, { tag: '#状态/待读', type: 0 }] },
  { id: 4, title: 'Paper D', deleted: false, tags: [{ tag: 'tmp-x', type: 0 }] },
];

let tagSeq = 100;
const tagIDs = new Map();
function idOf(name) {
  if (!tagIDs.has(name)) tagIDs.set(name, ++tagSeq);
  return tagIDs.get(name);
}
const colors = new Map();

const calls = { removeFromLibrary: [], rename: [], setColor: [] };
const FS = new Map();

class FakeSearch {
  constructor() { this.conds = []; this.libraryID = 1; }
  addCondition(k, op, v) { this.conds.push([k, op, v]); }
  async search() {
    const tagCond = this.conds.find((c) => c[0] === 'tag');
    if (tagCond) return ITEMS.filter((it) => it.tags.some((t) => t.tag === tagCond[2])).map((it) => it.id);
    return ITEMS.map((it) => it.id);
  }
}

const Zotero = {
  locale: 'zh-CN',
  Libraries: { userLibraryID: 1, get: () => ({ name: '我的文库', editable: true }) },
  Prefs: {
    _v: {},
    get(k, dflt) { const v = this._v[k]; return v === undefined ? dflt : v; },
    set(k, v) { this._v[k] = v; },
  },
  logError() {},
  debug() {},
  Search: FakeSearch,
  Items: {
    async getAsync(id) {
      const it = ITEMS.find((x) => x.id === id);
      if (!it) return null;
      return {
        id: it.id,
        deleted: it.deleted,
        getDisplayTitle: () => it.title,
        getTags: () => it.tags.slice(),
        addTag(name) { if (!it.tags.some((t) => t.tag === name)) it.tags.push({ tag: name, type: 0 }); },
        async saveTx() { /* 内存里已经改了 */ },
        setTags(list) { it.tags = list.map((t) => ({ tag: t.tag, type: t.type || 0 })); },
      };
    },
  },
  Tags: {
    // 真实 Zotero 里标签存在于库中就有 ID；这里自动分配，模拟扫描后的状态
    getID(name) { return tagIDs.has(name) ? tagIDs.get(name) : idOf(name); },
    getName(id) { for (const [n, v] of tagIDs) if (v === id) return n; return false; },
    getColors() { return colors; },
    getTagItems(lib, tagID) {
      const name = this.getName(tagID);
      return ITEMS.filter((it) => it.tags.some((t) => t.tag === name)).map((it) => it.id);
    },
    async removeFromLibrary(lib, ids) {
      calls.removeFromLibrary.push(ids.slice());
      const names = ids.map((id) => this.getName(id)).filter(Boolean);
      for (const it of ITEMS) it.tags = it.tags.filter((t) => !names.includes(t.tag));
      for (const n of names) colors.delete(n);
    },
    async rename(lib, from, to) {
      calls.rename.push([from, to]);
      for (const it of ITEMS) {
        for (const t of it.tags) if (t.tag === from) t.tag = to;
      }
    },
    async setColor(lib, name, color, position) {
      calls.setColor.push([name, color, position]);
      if (!color) colors.delete(name); else colors.set(name, { color, position });
    },
  },
  DataDirectory: { dir: '/data' },
};

const IOUtils = {
  async makeDirectory() {},
  async exists(p) { return FS.has(p); },
  async readUTF8(p) { return FS.get(p); },
  async writeUTF8(p, s) { FS.set(p, s); },
};
const PathUtils = { join: (...parts) => parts.join('/') };

/* ==================== 装配 ==================== */

const sandbox = {
  console, setTimeout, clearTimeout, navigator: {}, document,
  Zotero, IOUtils, PathUtils, MdLite: {}, Prefs: { get(k, d) { return d; } },
};
sandbox.window = null;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(OPS, 'utf8'), sandbox, { filename: 'tag-ops.js' });

const TagOps = sandbox.TagOps;

let changed = 0;
const win = {
  arguments: [{
    Zotero, TagOps, isZh: true, libraryID: 1, libraryName: '我的文库',
    focusTag: '', onChanged: () => { changed++; },
  }],
  Event: function Ev(type) { this.type = type; },
  addEventListener() {},
  close() { win._closed = true; },
  focus() {},
};
sandbox.window = win;
vm.runInContext(fs.readFileSync(UI, 'utf8'), sandbox, { filename: 'tag-manager.js' });

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 25));
const listText = () => nodes.get('pp-tm-list').textContent;
const panelText = () => nodes.get('pp-tm-panel').textContent;
const statusText = () => nodes.get('pp-tm-status').textContent;
const buttons = (root, label) => root.find((n) => n.tag === 'button' && n.textContent === label);
const panelButtons = (label) => buttons(nodes.get('pp-tm-panel'), label);
const listRows = () => nodes.get('pp-tm-list').find((n) => n.tag === 'div' && (n.className || '').includes('---'));
const rowEls = () => nodes.get('pp-tm-list').find((n) => n.tag === 'div' && n.children.some((c) => c.tag === 'input'));

/* ==================== ① 启动渲染 ==================== */

(async () => {
  await tick(60);

  ok(listText().includes('DNN'), 'R1 列表渲染出标签 DNN', listText().slice(0, 80));
  ok(listText().includes('#方法/深度学习'), 'R2 层级标签也进列表');
  ok(listText().includes('#状态/待读'), 'R3 保护标签照样显示（只是不参与删除）');
  eq(nodes.get('pp-tm-lib').textContent, '· 我的文库', 'R4 库名回显');
  ok(nodes.get('pp-tm-summary').textContent.includes('6 种'), 'R5 概览统计正确（6 种标签）',
    nodes.get('pp-tm-summary').textContent);
  ok(statusText().includes('6 种标签') || statusText().includes('共 6'), 'R6 状态栏给出扫描结果', statusText());

  /* ==================== ③ 破坏性操作必须两步 ==================== */

  eq(panelButtons('确认删除').length, 0, 'D1 初始面板没有「确认删除」（必须先预览）');
  eq(panelButtons('预览删除').length, 1, 'D2 初始面板有「预览删除」');
  ok(panelButtons('预览删除')[0].disabled === true, 'D3 未选标签时预览按钮禁用');

  /* ==================== ② 筛选与多选 ==================== */

  const q = nodes.get('pp-tm-filters').find((n) => n.tag === 'input')[0];
  ok(!!q, 'F1 筛选条有搜索框');
  q.value = 'dnn';
  q.fire('input');
  await tick();
  const afterSearch = listText();
  ok(afterSearch.includes('DNN') && afterSearch.includes('dnn'), 'F2 搜索不区分大小写，两种写法都留',
    afterSearch.slice(0, 120));
  ok(!afterSearch.includes('tmp-x'), 'F3 不匹配的标签被过滤掉');

  // 表头全选（作用于筛选结果 = 2 个）
  const headCb = nodes.get('pp-tm-list').find((n) => n.tag === 'input')[0];
  headCb.checked = true;
  headCb.fire('change');
  await tick();
  ok(nodes.get('pp-tm-selectbar').textContent.includes('已选 2'), 'F4 全选只作用于筛选结果（2 个）',
    nodes.get('pp-tm-selectbar').textContent);

  /* ==================== ④ 保护名单：预览时跳过 ==================== */

  // 清空选择，改为选中所有标签
  q.value = '';
  q.fire('input');
  await tick();
  nodes.get('pp-tm-selectbar').find((n) => n.tag === 'button' && n.textContent === '清空选择')[0].fire('click');
  await tick();
  const cbAll2 = nodes.get('pp-tm-list').find((n) => n.tag === 'input')[0];
  cbAll2.checked = true;
  cbAll2.fire('change');
  await tick();
  ok(nodes.get('pp-tm-selectbar').textContent.includes('已选 6'), 'G1 全选拿到 6 个',
    nodes.get('pp-tm-selectbar').textContent);
  ok(panelText().includes('1 个受保护'), 'G2 面板提示有 1 个受保护标签', panelText().slice(0, 200));

  panelButtons('预览删除')[0].fire('click');
  await tick(80);
  const pv = panelText();
  ok(pv.includes('将删除 5 个标签'), 'G3 受保护的 #状态/待读 被排除（6-1=5）', pv.slice(0, 160));
  ok(pv.includes('已跳过 1 个受保护标签'), 'G4 明确告知跳过数量');
  ok(pv.includes('影响'), 'G5 预览给出受影响条目数');
  eq(panelButtons('确认删除').length, 1, 'G6 预览后才有「确认删除」');

  /* ==================== ⑤ 执行：删除 + 快照 ==================== */

  await panelButtons('确认删除')[0].fireAsync ? null : null;
  panelButtons('确认删除')[0].fire('click');
  await tick(120);
  ok(calls.removeFromLibrary.length === 1, 'E1 调用了一次 removeFromLibrary', calls.removeFromLibrary.length);
  eq((calls.removeFromLibrary[0] || []).length, 5, 'E2 只删了 5 个（不含受保护）');
  const snapRaw = FS.get('/data/papilot/tag-snapshots.json');
  ok(!!snapRaw, 'E3 删除前写了快照文件');
  const snapArr = snapRaw ? JSON.parse(snapRaw) : [];
  eq(snapArr.length, 1, 'E4 快照里有一条记录');
  eq(snapArr[0].op, 'delete', 'E5 快照标记操作类型');
  ok(!listText().includes('DNN'), 'E6 删除后列表已刷新（DNN 消失）', listText().slice(0, 80));
  ok(listText().includes('#状态/待读'), 'E7 受保护标签仍在');
  ok(statusText().includes('可') || statusText().includes('撤销'), 'E8 状态栏提示可撤销', statusText());

  /* ==================== ⑥ 撤销 ==================== */

  nodes.get('pp-tm-views').find((n) => n.tag === 'button' && n.textContent === '快照与撤销')[0].fire('click');
  await tick(80);
  const snapPanel = panelText();
  ok(snapPanel.includes('5 个标签'), 'U1 快照页列出记录（5 个标签）', snapPanel.slice(0, 200));
  const undoBtn = panelButtons('撤销')[0];
  ok(!!undoBtn, 'U2 有撤销按钮');
  undoBtn.fire('click');
  await tick(160);
  ok(ITEMS.some((it) => it.tags.some((t) => t.tag === 'DNN')), 'U3 撤销后 DNN 回到条目上',
    JSON.stringify(ITEMS.map((i) => i.tags.map((t) => t.tag))));
  ok(changed >= 1, 'U4 撤销后回调了 onChanged');

  /* ==================== ⑦ 改名预览 → 执行 ==================== */

  TagOps.invalidate(1);
  nodes.get('pp-tm-views').find((n) => n.tag === 'button' && n.textContent === '批量编辑')[0].fire('click');
  await tick();
  nodes.get('pp-tm-refresh').fire('click');
  await tick(100);

  // 选 DNN
  const rows = nodes.get('pp-tm-list').find((n) => n.tag === 'div' && n.children.some((c) => c.tag === 'input'));
  ok(rows && rows.length > 0, 'N0 列表有可勾选行');
  const dnnRow = rows.find((r) => r.textContent.includes('DNN'));
  ok(!!dnnRow, 'N1 找到 DNN 行');
  const dnnCb = dnnRow.children.find((c) => c.tag === 'input');
  dnnCb.checked = true;
  dnnCb.fire('change');
  await tick();

  // 填改名规则：DNN → 深度神经网络
  const inputs = nodes.get('pp-tm-panel').find((n) => n.tag === 'input' && n.getAttribute('type') === 'text');
  ok(inputs.length >= 2, 'N2 改名表单有查找/替换两个输入框', inputs.length);
  inputs[0].value = 'DNN';
  inputs[1].value = '深度神经网络';
  const intro = panelButtons('预览改名');
  ok(!!intro[0], 'N3 有「预览改名」');
  ok(intro[0].disabled === false, 'N4 选中标签后预览可用');
  intro[0].fire('click');
  await tick(80);
  const rp = panelText();
  ok(rp.includes('将改动 1 个标签'), 'N5 预览给出改动数', rp.slice(0, 160));
  ok(rp.includes('深度神经网络'), 'N6 预览列出了新名字');
  eq(panelButtons('确认执行').length, 1, 'N7 预览后出现「确认执行」');
  panelButtons('确认执行')[0].fire('click');
  await tick(140);
  ok(calls.rename.some(([f, t]) => f === 'DNN' && t === '深度神经网络'), 'N8 调用了 rename(DNN→深度神经网络)',
    calls.rename);
  ok(ITEMS.some((it) => it.tags.some((t) => t.tag === '深度神经网络')), 'N9 条目上完成改名');

  /* ==================== ⑧ 体检页 ==================== */

  nodes.get('pp-tm-views').find((n) => n.tag === 'button' && n.textContent === '体检报告')[0].fire('click');
  await tick();
  const hp = panelText();
  ok(hp.includes('写法变体') || hp.includes('变体'), 'H1 体检页有变体组区块', hp.slice(0, 200));
  ok(hp.includes('仅使用 1 次') || hp.includes('仅用 1 次'), 'H2 有罕见标签区块');
  ok(hp.includes('缺少父级'), 'H3 有缺父级区块');

  /* ==================== 收尾 ==================== */

  if (fails.length) {
    console.error('\n✗ 标签管理器窗口烟测失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\nPASS ' + pass + ' assertions  (tag-manager-ui)');
  process.exit(0);
})();
