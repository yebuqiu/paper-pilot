#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置面板 · 折叠分组与设置项搜索 界面测试（0.38.0，0.65.0 扩展）
 *
 * 为什么要有它：设置面板是折叠式——折叠逻辑出问题的表现是「点了标题没反应 /
 * 展开状态记不住 / 全部展开失效」，这类静默失败只有真跑一遍 prefs-fold.js
 * 才能发现。这个套件用「迷你 DOM」把它真跑一遍（只桩掉 Zotero.Prefs / 定时器），
 * 断言行为本身：
 *   ① 初始：prefsFoldOpen 为空 → 21 张卡全部收起（默认全收起）；
 *   ② 点标题行 → 展开/收起该卡，且**写回 prefsFoldOpen pref**（记住状态）；
 *      点 A 卡不影响 B 卡；
 *   ③ 「全部展开 / 全部收起」→ 19 卡全开/全闭，pref 同步；
 *   ④ 深链定位：_prefsFocus 放分组键 → 打开设置时该卡自动展开并滚动定位，
 *      消费后键被清空（一次性）；
 *   ⑤ 结构体检（纯文本，不跑 JS）：每张 pp-fold 卡都有 pp-fold-head 且在
 *      pp-card-body 之前；19 个 data-fold 键与预期集合一致——防止未来改
 *      prefs.xhtml 时把折叠结构改坏。
 *   ⑦ 搜索过滤（0.65.0）：命中项显示、未命中隐藏、组内无命中时大类标签一起隐藏、
 *      根节点挂 pp-searching（用 CSS 展开命中卡），清空后全部恢复且**不动折叠 pref**。
 *
 * 运行：node test/prefs-fold.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const FOLD_JS = path.join(ROOT, 'chrome', 'content', 'prefs-fold.js');

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
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {};
    this.className = ''; this._text = ''; this.id = '';
    this.parentNode = null; this.handlers = {};
    this.scrolled = false;
    const self = this;
    this.classList = {
      toggle(name, force) {
        const has = (' ' + self.className + ' ').indexOf(' ' + name + ' ') >= 0;
        const want = force === undefined ? !has : !!force;
        if (want && !has) self.className = (self.className + ' ' + name).trim();
        else if (!want && has) self.className = (' ' + self.className + ' ')
          .split(' ' + name + ' ').join(' ').trim();
        return want;
      },
    };
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  fire(e, a) { for (const f of (this.handlers[e] || []).slice()) f(a || {}); }
  click() { this.fire('click'); }
  scrollIntoView() { this.scrolled = true; }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  matches(sel) {
    // 支持本测试用到的选择器：.class / tag.class / 「后代组合 + [attr]」复合（取末段判断）
    const parts = String(sel).trim().split(/\s+/);
    const last = parts[parts.length - 1];
    const m = last.match(/^([a-z]*)\.?([A-Za-z0-9_-]*)(\[([a-zA-Z0-9_-]+)\])?$/);
    if (!m) return false;
    const tag = m[1], cls = m[2], attr = m[4];
    if (tag && this.tag !== tag) return false;
    if (cls && (' ' + this.className + ' ').indexOf(' ' + cls + ' ') < 0) return false;
    if (attr && this.getAttribute(attr) === null) return false;
    return true;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    return this.all().filter((n) => n.matches(sel));
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v == null ? '' : v); }
}

/* 0.65.0 的信息架构：7 个大类，卡片 data-fold 键不变（只在组间搬家） */
const GROUPS = [
  ['账号与会员', ['account']],
  ['AI 能力', ['channels', 'aiparams', 'skills']],
  ['阅读与翻译', ['translate', 'glossary', 'pdfdual', 'popup', 'pdftheme']],
  ['文献获取', ['cnki', 'thirdsrc', 'subscriptions', 'schedule']],
  ['条目与标签', ['columns', 'tagging', 'enhance']],
  ['界面与效率', ['uitheme', 'menu', 'hotkeys', 'wps']],
  ['数据与同步', ['cloud']],
];

const FOLD_KEYS = GROUPS.reduce((a, g) => a.concat(g[1]), []);

/** 从 prefs.xhtml 的真实结构建 DOM（工具条 + 大类标签 + 卡片 + 搜索框） */
function makeDom() {
  const xhtml = fs.readFileSync(XHTML, 'utf8');
  const root = new El('vbox');
  root.className = 'pp-root';
  const byKey = new Map();
  const labels = [];
  for (const [gname, keys] of GROUPS) {
    const label = new El('div');
    label.setAttribute('class', 'pp-cat-label');
    const name = new El('span');
    name.setAttribute('class', 'pp-cat-name');
    name.textContent = gname;
    label.appendChild(name);
    root.appendChild(label);
    labels.push(label);
    for (const key of keys) {
      const re = new RegExp('class="pp-card pp-fold" data-fold="' + key + '"');
      if (!ok(re.test(xhtml), '⑤ prefs.xhtml 含分组卡 data-fold="' + key + '"')) continue;
      const card = new El('div');
      card.setAttribute('class', 'pp-card pp-fold');
      card.setAttribute('data-fold', key);
      // 搜索索引读的是这四项：标题 / 说明 / 关键词 / 折叠键（关键词从源码里取真实值）
      card.setAttribute('data-search-strings-raw',
        (new RegExp('data-fold="' + key + '" data-search-strings-raw="([^"]*)"').exec(xhtml) || [0, ''])[1]);
      const head = new El('div');
      head.setAttribute('class', 'pp-fold-head');
      const title = new El('span');
      title.setAttribute('class', 'pp-card-title');
      const mTitle = new RegExp('data-fold="' + key + '"[\\s\\S]{0,400}?'
        + 'class="pp-card-title">([^<]*)<').exec(xhtml);
      title.textContent = mTitle ? mTitle[1] : key;
      const desc = new El('span');
      desc.setAttribute('class', 'pp-card-desc');
      head.appendChild(title);
      head.appendChild(desc);
      const body = new El('div');
      body.setAttribute('class', 'pp-card-body');
      card.appendChild(head);
      card.appendChild(body);
      root.appendChild(card);
      byKey.set(key, { card, head, body, title });
    }
  }
  const expandBtn = new El('button');
  expandBtn.setAttribute('id', 'pp-fold-expand');
  const collapseBtn = new El('button');
  collapseBtn.setAttribute('id', 'pp-fold-collapse');
  root.appendChild(expandBtn);
  root.appendChild(collapseBtn);
  // 0.65.0 工具条：搜索框 + 计数 + 清空
  const searchInput = new El('input');
  searchInput.setAttribute('id', 'pp-prefs-search');
  searchInput.value = '';
  const searchClear = new El('button');
  searchClear.setAttribute('id', 'pp-prefs-search-clear');
  const countEl = new El('span');
  countEl.setAttribute('id', 'pp-pref-count');
  countEl.textContent = '21 项 · 7 类';
  root.appendChild(searchInput);
  root.appendChild(searchClear);
  root.appendChild(countEl);
  return {
    root, byKey, labels, expandBtn, collapseBtn, xhtml,
    searchInput, searchClear, countEl,
    document: {
      getElementById: (id) => {
        if (id === 'pp-fold-expand') return expandBtn;
        if (id === 'pp-fold-collapse') return collapseBtn;
        if (id === 'pp-prefs-search') return searchInput;
        if (id === 'pp-prefs-search-clear') return searchClear;
        if (id === 'pp-pref-count') return countEl;
        return null;
      },
      // 真实 DOM 里 .pp-root 会匹配到根节点本身（合并根前缀，才能测到 pp-searching 与标签隐藏）
      querySelectorAll: (sel) => (root.matches(sel) ? [root].concat(root.querySelectorAll(sel))
        : root.querySelectorAll(sel)),
    },
  };
}

/** 跑一遍 prefs-fold.js（每个用例用全新上下文 + 可选的初始 pref / 焦点键） */
function runFoldScript(dom, opts) {
  opts = opts || {};
  const PrefStore = new Map(Object.entries(opts.prefs || {}));
  const timers = [];
  const Zotero = {
    Prefs: {
      get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined),
      set: (k, v) => { PrefStore.set(k, v); },
    },
    Papilot: { _prefsFocus: opts.focus || '' },
  };
  const window = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  const sandbox = {
    Zotero, window, document: dom.document,
    console, Math, Date, Set, Array, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FOLD_JS, 'utf8'), sandbox, { filename: 'prefs-fold.js' });
  return { PrefStore, timers, Zotero, flush: () => { for (const t of timers.splice(0)) t.fn(); } };
}

const isOpen = (dom, key) =>
  (' ' + dom.byKey.get(key).card.className + ' ').indexOf(' pp-fold-closed ') < 0;
const openCount = (dom) => FOLD_KEYS.filter((k) => isOpen(dom, k)).length;

/* ---------------- ⑤ 结构体检（纯文本） ---------------- */
{
  const dom = makeDom();
  ok(dom.byKey.size === 21, '⑤ 21 张分组卡都建出来了（0.49.0 定时任务 + 0.53.0 检索订阅 + 0.56.0 云同步 + 0.68.1 WPS 集成 + 0.72.4 翻译卡拆三）', dom.byKey.size);
  ok(/id="pp-fold-expand"/.test(dom.xhtml) && /id="pp-fold-collapse"/.test(dom.xhtml),
    '⑤ 工具条按钮 #pp-fold-expand / #pp-fold-collapse 存在');
  // 每张卡：pp-fold-head 必须在 pp-card-body 之前（点击区不能包住表单）
  for (const key of FOLD_KEYS) {
    const iHead = dom.xhtml.indexOf('pp-fold-head');
    void iHead;
    const re = new RegExp(
      'class="pp-card pp-fold" data-fold="' + key + '"[\\s\\S]*?class="pp-fold-head"[\\s\\S]*?class="pp-card-body"');
    ok(re.test(dom.xhtml), '⑤ 卡 ' + key + '：head 在 body 之前');
  }
  ok((dom.xhtml.match(/class="pp-card pp-fold"/g) || []).length === 21,
    '⑤ pp-fold 卡恰好 21 张（无裸 pp-card 漏包）');
}

/* ---------------- ① 初始：默认全收起 ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  eq(openCount(dom), 0, '① pref 为空 → 21 张卡全部收起');
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen'), undefined,
    '① 初始不写 pref');
}

/* ---------------- ② 点标题行：切换 + 记住 ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  dom.byKey.get('channels').head.click();
  ok(isOpen(dom, 'channels'), '② 点 channels 标题 → 展开');
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen'), 'channels',
    '② 展开写回 pref');
  ok(!isOpen(dom, 'account') && !isOpen(dom, 'translate'),
    '② 点 channels 不影响其他卡');
  dom.byKey.get('translate').head.click();
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen'), 'channels,translate',
    '② 再展开 translate → pref 追加（保持顺序）');
  dom.byKey.get('channels').head.click();
  ok(!isOpen(dom, 'channels'), '② 再点 channels → 收起');
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen'), 'translate',
    '② 收起后 pref 移除该键');
}

/* ---------------- ③ 全部展开 / 全部收起 ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  dom.expandBtn.click();
  eq(openCount(dom), 21, '③ 全部展开 → 21 张卡全开');
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen').split(',').length, 21,
    '③ pref 记满 21 键');
  dom.collapseBtn.click();
  eq(openCount(dom), 0, '③ 全部收起 → 21 张卡全闭');
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen'), '', '③ pref 清空');
}

/* ---------------- ④ 深链定位：_prefsFocus ---------------- */
{
  const dom = makeDom();
  const { Zotero, flush } = runFoldScript(dom, { focus: 'channels' });
  ok(isOpen(dom, 'channels'), '④ _prefsFocus=channels → 该卡自动展开');
  eq(Zotero.Papilot._prefsFocus, '', '④ 焦点键消费后清空（一次性）');
  flush(); // 60ms 滚动定位定时器
  ok(dom.byKey.get('channels').card.scrolled, '④ 滚动定位到目标卡');
}

/* ---------------- ⑥ 状态恢复：pref 里有键 → 打开时恢复 ---------------- */
{
  const dom = makeDom();
  runFoldScript(dom, { prefs: { 'extensions.zotero.papilot.prefsFoldOpen': 'uitheme,pdftheme' } });
  ok(isOpen(dom, 'uitheme') && isOpen(dom, 'pdftheme'), '⑥ pref 记住的卡恢复展开');
  eq(openCount(dom), 2, '⑥ 其余保持收起');
}

/* ---------------- ⑦ 搜索过滤（0.65.0） ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  const cls = (el) => ' ' + (el.className || '') + ' ';
  const hidden = (key) => cls(dom.byKey.get(key).card).indexOf(' pp-hidden ') >= 0;
  const labelHidden = (i) => cls(dom.labels[i]).indexOf(' pp-hidden ') >= 0;

  ok(dom.labels.length === 7, '⑦ 7 个大类标签都建出来了', dom.labels.length);
  ok(dom.byKey.size === 21, '⑦ 21 张卡都在（组间搬家后数量不变）', dom.byKey.size);

  dom.searchInput.value = '快捷键';
  dom.searchInput.fire('input');
  ok(!hidden('hotkeys'), '⑦ 命中项保持可见');
  ok(hidden('channels'), '⑦ 未命中项隐藏');
  ok(cls(dom.root).indexOf(' pp-searching ') >= 0, '⑦ 根节点进入搜索态（CSS 据此展开命中卡）');
  ok(!labelHidden(5), '⑦ 有命中的大类标签保留（界面与效率）');
  ok(labelHidden(1), '⑦ 组内零命中 → 大类标签一起隐藏（AI 能力）');
  ok(dom.countEl.textContent.indexOf('/') > 0 && dom.countEl.textContent.indexOf('21') > 0,
    '⑦ 计数显示「命中 / 全部」', dom.countEl.textContent);
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen'), undefined,
    '⑦ 搜索只切类名，不写折叠 pref');

  dom.searchInput.value = '快捷键';
  dom.searchClear.click();
  ok(!hidden('channels') && !hidden('hotkeys'), '⑦ 清空后全部卡片恢复可见');
  ok(cls(dom.root).indexOf(' pp-searching ') < 0, '⑦ 退出搜索态');
  ok(dom.labels.every((l) => cls(l).indexOf(' pp-hidden ') < 0), '⑦ 大类标签全部恢复');
  eq(dom.countEl.textContent, '21 项 · 7 类', '⑦ 计数恢复原始文案');
  eq(dom.searchInput.value, '', '⑦ 清空按钮同时清掉输入框内容');
}

/* ---------------- ⑧ 键盘可达（0.65.1） ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  const head = dom.byKey.get('menu').head;
  const body = dom.byKey.get('menu').body;

  eq(head.getAttribute('role'), 'button', '⑧ 标题行 role=button（屏幕阅读器认得是可展开分区）');
  eq(head.getAttribute('tabindex'), '0', '⑧ 标题行可聚焦 tabindex=0');
  eq(head.getAttribute('aria-expanded'), 'false', '⑧ 初始 aria-expanded=false（默认收起）');
  ok(/^pp-fold-body-menu$/.test(body.id), '⑧ 卡片体自动补 id（供 aria-controls 引用）', body.id);
  eq(head.getAttribute('aria-controls'), body.id, '⑧ aria-controls 指向卡片体');

  head.fire('keydown', { key: 'Enter', preventDefault() {} });
  ok(isOpen(dom, 'menu'), '⑧ Enter 展开卡片');
  eq(head.getAttribute('aria-expanded'), 'true', '⑧ 展开后 aria-expanded=true');
  eq(PrefStore.get('extensions.zotero.papilot.prefsFoldOpen'), 'menu',
    '⑧ 键盘操作与鼠标一样写回 pref');

  head.fire('keydown', { key: ' ', preventDefault() {} });
  ok(!isOpen(dom, 'menu'), '⑧ 空格键再收起');
  eq(head.getAttribute('aria-expanded'), 'false', '⑧ 收起后 aria-expanded=false');

  let prevented = false;
  head.fire('keydown', { key: 'a', preventDefault() { prevented = true; } });
  ok(!prevented && !isOpen(dom, 'menu'), '⑧ 其它按键不拦截、不切换');
}

/* ---------------- 汇总 ---------------- */
console.log('prefs-fold: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
