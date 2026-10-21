#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置面板「直达」锚点目录烟测（0.68.3）
 *
 * 为什么要有它：用户报「设置里面【直达】不可用」。
 * 根因是 prefs-hotkeys.js 用 createElementNS(XHTML) 造的是 **HTML** 按钮，
 * 却按 XUL 习惯绑了 `command` 事件 —— HTML 元素只派发 click，于是每个 chip 点了都没反应，
 * 而且不报错、静态扫描也看不出来（0.65.0 起一直如此）。
 *
 * 本测试用迷你 DOM 真加载脚本，按**真机行为**只派发 click：
 *   ① chip 必须真的出现（按 .pp-cat-label 生成，文案取 .pp-cat-name）；
 *   ② 点 chip → 目标分类滚进视野（scrollIntoView + XUL scrollbox 的 scrollTop 兜底）；
 *   ③ 点 chip → 顺带展开该分类第一张折叠卡。
 * 旧代码（绑 command）在这里会 0 反应，测试直接红。
 *
 * 运行：node test/prefs-anchors.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'chrome', 'content', 'prefs-hotkeys.js');

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
  constructor(tag, cls) {
    this.tag = tag; this.nodeType = 1; this.children = []; this.parentNode = null;
    this.style = {}; this._attrs = {};
    this.className = cls || ''; this._text = '';
    this.handlers = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this._rect = { top: 0 };
    this.scrollIntoViewCalls = 0;
  }
  get classList() {
    const self = this;
    const list = () => String(self.className || '').split(/\s+/).filter(Boolean);
    return {
      add(c) { if (!list().includes(c)) self.className = (self.className ? self.className + ' ' : '') + c; },
      remove(c) { self.className = list().filter((x) => x !== c).join(' '); },
      contains(c) { return list().includes(c); },
    };
  }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); this._attrs[k] = String(v); }
  getAttribute(k) { return k === 'class' ? this.className : (k in this._attrs ? this._attrs[k] : null); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  get nextElementSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.children.indexOf(this);
    return i >= 0 ? (p.children[i + 1] || null) : null;
  }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  fire(ev, arg) {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, arg || {});
    for (const f of (this.handlers[ev] || []).slice()) f(e);
  }
  click() { this.fire('click'); }
  querySelector(sel) {
    if (sel !== '.pp-cat-name') return null;
    return this.children.find((c) => String(c.className || '').split(/\s+/).includes('pp-cat-name')) || null;
  }
  getBoundingClientRect() { return { top: this._rect.top, bottom: this._rect.top + 20 }; }
  scrollIntoView() { this.scrollIntoViewCalls++; }
  set textContent(v) { this._text = v == null ? '' : String(v); }
  get textContent() {
    if (this.children.length && this.children.some((c) => c.tag !== 'button')) {
      return this.children.map((c) => c.textContent).join('');
    }
    return this._text;
  }
}

function makeDom() {
  const root = new El('div', 'pp-root');   // 可滚动容器（模拟 Zotero 设置窗格主体）
  root.scrollHeight = 2000;
  root.clientHeight = 600;
  root._rect = { top: 0 };

  const nav = new El('div'); nav.setAttribute('id', 'pp-anchor-nav');
  const hkList = new El('div'); hkList.setAttribute('id', 'pp-hotkeys-list');

  const lab1 = new El('div', 'pp-cat-label');
  const n1 = new El('span', 'pp-cat-name'); n1.textContent = '账号与会员';
  lab1.appendChild(n1);
  lab1._rect = { top: 100 };

  const card1 = new El('div', 'pp-card pp-fold pp-fold-closed');
  const lab2 = new El('div', 'pp-cat-label');
  const n2 = new El('span', 'pp-cat-name'); n2.textContent = 'AI 能力';
  lab2.appendChild(n2);
  lab2._rect = { top: 500 };
  const card2 = new El('div', 'pp-card pp-fold pp-fold-closed');

  root.appendChild(nav);
  root.appendChild(hkList);
  root.appendChild(lab1);
  root.appendChild(card1);
  root.appendChild(lab2);
  root.appendChild(card2);

  const byId = new Map([['pp-anchor-nav', nav], ['pp-hotkeys-list', hkList]]);
  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElementNS: (ns, tag) => new El(tag),
    querySelectorAll: (sel) => {
      if (sel !== '.pp-cat-label') return [];
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.className || '').split(/\s+/).includes('pp-cat-label')) out.push(c);
          walk(c);
        }
      };
      walk(root);
      return out;
    },
  };
  return { root, document, nav, lab1, card1, lab2, card2 };
}

/* ---------------- 装载脚本 ---------------- */

const dom = makeDom();
const sandbox = {
  console,
  document: dom.document,
  window: { setTimeout: () => 0, addEventListener: () => {} },
  Zotero: {
    locale: 'zh-CN',
    Papilot: {
      // 快捷键表为空：本测试只关心锚点目录
      hotkeys: { getAll: () => [] },
      noteTemplates: null,
    },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'prefs-hotkeys.js' });

/* ---------------- ① 生成 ---------------- */

const chips = dom.nav.children.filter((c) => c.tag === 'button');
eq(chips.length, 2, '① ★ 按 .pp-cat-label 生成 2 个直达 chip');
eq(dom.nav.children[0].tag, 'span', '① 前面有一句「直达：」提示');
eq(chips[0].textContent, '账号与会员', '① chip 文案取 .pp-cat-name（不是整个标签含计数）');

/* ---------------- ② 点击生效（旧代码绑 command → 这里 0 反应） ---------------- */

chips[0].click();
eq(dom.lab1.scrollIntoViewCalls, 1, '② ★ 点 chip → scrollIntoView 被调用（click 生效）');
ok(!dom.card1.classList.contains('pp-fold-closed'), '② 点 chip → 该分类第一张折叠卡展开');
eq(dom.root.scrollTop, 44, '② 兜底滚动：留出吸顶工具条（100 - 56）');
eq(dom.lab1.style.scrollMarginTop, '56px', '② 给 scrollIntoView 也设了 scroll-margin-top（避开吸顶栏）');

/* ③ XUL scrollbox 兜底：scrollIntoView 在 Zotero 设置窗格里常常无效，必须手动设 scrollTop */
// 真实布局里 rect.top 会随 scrollTop 变化，这里手动同步，避免桩把两次滚动叠起来
dom.lab2._rect.top = 500 - dom.root.scrollTop;
chips[1].click();
eq(dom.root.scrollTop, 444, '③ ★ 兜底滚动：按几何位置设置 scrollTop（500 - 56）');
ok(!dom.card2.classList.contains('pp-fold-closed'), '③ 第二个分类的折叠卡同样被展开');
ok(dom.card1.classList.contains('pp-fold-closed') === false, '③ 不误改其它分类的展开态');

/* ---------------- 汇总 ---------------- */

console.log('prefs anchors: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
