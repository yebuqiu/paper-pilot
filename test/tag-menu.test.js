#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 左下角标签右键注入 · 迷你 DOM（0.70.0）
 *
 * 为什么单独测：这是用户接触标签管理的第一入口，且完全依赖 Zotero 内部结构
 * （#tag-menu / ZoteroPane.tagSelector.contextTag / state.viewOnly）。真机上出问题的
 * 形态是「右键没反应」或「菜单里堆了三条一样的」，静态扫描看不出来。
 *
 * 断言：
 *   ① 注入点正确：追加到 #tag-menu 末尾，且只有一个根节点
 *   ② 文案与上下文：没右键到标签时只给「打开标签管理器」；右键到标签时给删除/定位/保护
 *   ③ 保护状态会翻转菜单项（加入 ↔ 移出）
 *   ④ 只读库（Feeds/虚拟库）时删除项禁用
 *   ⑤ 每次 popupshowing 重建而非堆叠（原生每次右键会重置 disabled，节点必须重建）
 *   ⑥ unregister 后节点干净移除；pref 关掉时根本不注入
 *
 * 运行：node test/tag-menu.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'tag-menu.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = String(tag);
    this.children = [];
    this._attrs = {};
    this.id = '';
    this.handlers = {};
    this.parentNode = null;
    this._text = '';
    this.classList = { contains: () => false };
  }
  setAttribute(k, v) {
    if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
    if (k === 'disabled') this.disabled = String(v) !== 'false';
  }
  getAttribute(k) { return k === 'id' ? this.id : (k in this._attrs ? this._attrs[k] : null); }
  get label() { return this._attrs.label || ''; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  removeEventListener(e, f) {
    const a = this.handlers[e] || [];
    const i = a.indexOf(f);
    if (i >= 0) a.splice(i, 1);
  }
  fire(e, arg) { for (const f of (this.handlers[e] || []).slice()) f(arg || { preventDefault() {}, stopPropagation() {} }); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  find(pred) {
    const out = [];
    const walk = (n) => { if (pred(n)) out.push(n); for (const c of n.children) walk(c); };
    walk(this);
    return out;
  }
}

/* ---------------- 组装环境 ---------------- */

function makeEnv(opts) {
  const o = opts || {};
  const popup = new El('menupopup');
  popup.id = 'tag-menu';
  const doc = {
    getElementById(id) { return id === 'tag-menu' ? popup : null; },
    createXULElement(tag) { return new El(tag); },
    createElement(tag) { return new El(tag); },
    addEventListener() {},
    removeEventListener() {},
  };
  const ts = {
    contextTag: o.tag ? { name: o.tag } : null,
    state: { viewOnly: !!o.viewOnly },
  };
  const win = {
    document: doc,
    ZoteroPane: { tagSelector: ts },
    focus() {},
    openDialog() { win._opened = true; return null; },
  };
  const prefs = { tagMenuEnabled: o.enabled === false ? false : true, tagProtect: o.protect || '' };
  const TagOps = {
    libraryID: () => 1,
    protectList() {
      const raw = String(prefs.tagProtect || '');
      const list = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
      return list.length ? list : ['#状态/*', '#治理/*'];
    },
    setProtectList(list) { prefs.tagProtect = list.join('\n'); },
    isProtected(name, list) {
      for (const p of (list || [])) {
        const re = new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
        if (re.test(name)) return true;
      }
      return false;
    },
    async itemsFor() { return { total: 3, items: [], byTag: {} }; },
    async snapshot() { return {}; },
    async deleteTags() { return { removed: 1, missing: [] }; },
  };
  const Zotero = {
    locale: 'zh-CN',
    getMainWindow: () => win,
    Libraries: { get: () => ({ name: '我的文库', libraryType: o.libType || 'user', editable: o.editable !== false }) },
    logError() {},
    ProgressWindow: class { changeHeadline() {} addDescription() {} show() {} startCloseTimer() {} },
  };
  const Services = {
    wm: { getEnumerator: () => ({ hasMoreElements: () => false, getNext: () => null }) },
    prompt: {
      confirmEx: () => 0,
      alert() {},
      BUTTON_POS_0: 1, BUTTON_POS_1: 2, BUTTON_TITLE_IS_STRING: 4,
    },
  };
  const sandbox = {
    console, setTimeout, Zotero, Services, Prefs: { get: (k, d) => (k in prefs ? prefs[k] : d) },
    TagOps, I18n: { isZh: o.zh !== false }, document: doc,
  };
  sandbox.window = win;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: 'tag-menu.js' });
  return { TM: sandbox.TagMenu, popup, win, prefs, ts, TagOps };
}

/** install 只挂钩子；菜单在 popupshowing 时才构建（真实流程就是右键才建） */
function boot(env) { env.TM.install(); env.popup.fire('popupshowing'); return env; }

const labels = (root) => root.find((n) => n.tag === 'menuitem').map((n) => n.label);
const roots = (popup) => popup.find((n) => n.id === 'papilot-tag-menu-root');
const seps = (popup) => popup.find((n) => n.id === 'papilot-tag-menu-root-sep');

/* ================= ① 无上下文标签：只有管理器入口 ================= */

{
  const E = boot(makeEnv({}));
  eq(roots(E.popup).length, 1, 'I1 注入了一个根菜单');
  eq(seps(E.popup).length, 1, 'I2 根菜单前有分隔符');
  const root = roots(E.popup)[0];
  eq(root.label, 'Papilot 标签工具', 'I3 根菜单文案（中文）');
  const sub = root.children[0];
  const l1 = labels(sub);
  ok(l1.length === 1 && l1[0].includes('打开标签管理器'), 'I4 无上下文时只有「打开标签管理器」', l1);
}

/* ================= ② 右键到具体标签 ================= */

{
  const E = boot(makeEnv({ tag: '深度学习' }));
  const sub = roots(E.popup)[0].children[0];
  const l = labels(sub);
  ok(l.some((x) => x.includes('定位') && x.includes('深度学习')), 'C1 有「在管理器中定位」', l);
  ok(l.some((x) => x.includes('删除') && x.includes('深度学习')), 'C2 有「删除此标签」', l);
  ok(l.some((x) => x.includes('加入保护名单')), 'C3 未受保护时提供「加入保护」', l);

  /* ④ 只读库：删除项禁用 */
  const R = boot(makeEnv({ tag: '深度学习', viewOnly: true }));
  const delBtn = roots(R.popup)[0].children[0].find((n) => n.tag === 'menuitem' && n.label.includes('删除'))[0];
  ok(!!delBtn && delBtn.disabled === true, 'C4 只读视图下删除项禁用');
}

/* ================= ③ 保护状态翻转 ================= */

{
  const E = boot(makeEnv({ tag: '#状态/待读' }));
  const sub = roots(E.popup)[0].children[0];
  ok(labels(sub).some((x) => x.includes('移出保护名单')), 'G1 已受保护时提供「移出保护」', labels(sub));
  ok(!labels(sub).some((x) => x.includes('加入保护名单')), 'G2 不出现「加入保护」');

  // 点「移出保护名单」→ 名单里那条被删掉
  const item = sub.find((n) => n.tag === 'menuitem' && n.label.includes('移出保护'))[0];
  item.fire('command');
  ok(!String(E.prefs.tagProtect).includes('#状态/待读') || String(E.prefs.tagProtect).includes('#状态/*') === false,
    'G3 移出后名单不再显式包含该标签', E.prefs.tagProtect);

  const E2 = boot(makeEnv({ tag: 'tmp-x' }));
  const sub2 = roots(E2.popup)[0].children[0];
  sub2.find((n) => n.tag === 'menuitem' && n.label.includes('加入保护'))[0].fire('command');
  ok(String(E2.prefs.tagProtect).includes('tmp-x'), 'G4 加入保护后写进名单', E2.prefs.tagProtect);
}

/* ================= ⑤ 重复 install / 重复 popupshowing 不堆叠 ================= */

{
  const E = boot(makeEnv({ tag: 'x' }));
  E.TM.install();       // 幂等
  eq(roots(E.popup).length, 1, 'R1 重复 install 不重复注入');

  E.popup.fire('popupshowing');
  E.popup.fire('popupshowing');
  eq(roots(E.popup).length, 1, 'R2 多次 popupshowing 只保留一份');
  eq(seps(E.popup).length, 1, 'R3 分隔符也只有一份');

  // 上下文在两次右键之间变化：菜单必须跟着变
  E.ts.contextTag = { name: 'y' };
  E.popup.fire('popupshowing');
  const l = labels(roots(E.popup)[0].children[0]);
  ok(l.some((x) => x.includes('y')), 'R4 重建时读取最新 contextTag', l);
  ok(!l.some((x) => /「x」/.test(x)), 'R5 旧标签项被清掉', l);
}

/* ================= ⑥ 卸载与开关 ================= */

{
  const E = boot(makeEnv({ tag: 'x' }));
  eq(roots(E.popup).length, 1, 'U1 已注入');
  E.TM.unregister();
  eq(roots(E.popup).length, 0, 'U2 unregister 后根菜单移除');
  eq(seps(E.popup).length, 0, 'U3 分隔符一并移除');
  eq((E.popup.handlers.popupshowing || []).length, 0, 'U4 popupshowing 监听被摘掉');

  const D = boot(makeEnv({ enabled: false }));
  eq(roots(D.popup).length, 0, 'U5 tagMenuEnabled=false 时不注入');
}

/* ================= ⑦ 英文环境 ================= */

{
  const E = boot(makeEnv({ tag: 'x', zh: false }));
  eq(roots(E.popup)[0].label, 'Papilot Tag Tools', 'L1 英文文案');
  const l = labels(roots(E.popup)[0].children[0]);
  ok(l.some((x) => x.includes('Open Tag Manager')), 'L2 英文「Open Tag Manager」', l);
}

if (fails.length) {
  console.error('\n✗ 标签右键注入测试失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nPASS ' + pass + ' assertions  (tag-menu)');
process.exit(0);
