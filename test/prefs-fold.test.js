#!/usr/bin/env node
/* 设置面板 · 折叠分组 界面测试（插件 0.38.0）
 *
 * 为什么要有它：设置面板从「一整页 12 张卡片」改成折叠式——折叠逻辑出问题的
 * 表现是「点了标题没反应 / 展开状态记不住 / 全部展开失效」，这类静默失败
 * 只有真跑一遍 prefs-fold.js 才能发现。这个套件用「迷你 DOM」把它真跑一遍
 * （只桩掉 Zotero.Prefs / 定时器），断言行为本身：
 *   ① 初始：prefsFoldOpen 为空 → 12 张卡全部收起（默认全收起）；
 *   ② 点标题行 → 展开/收起该卡，且**写回 prefsFoldOpen pref**（记住状态）；
 *      点 A 卡不影响 B 卡；
 *   ③ 「全部展开 / 全部收起」→ 12 卡全开/全闭，pref 同步；
 *   ④ 深链定位：_prefsFocus 放分组键 → 打开设置时该卡自动展开并滚动定位，
 *      消费后键被清空（一次性）；
 *   ⑤ 结构体检（纯文本，不跑 JS）：每张 pp-fold 卡都有 pp-fold-head 且在
 *      pp-card-body 之前；12 个 data-fold 键与预期集合一致——防止未来改
 *      prefs.xhtml 时把折叠结构改坏。
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
}

const FOLD_KEYS = ['account', 'cnki', 'channels', 'translate', 'aiparams', 'popup',
  'columns', 'tagging', 'enhance', 'uitheme', 'pdftheme', 'menu', 'hotkeys'];

/** 从 prefs.xhtml 的真实结构建卡（每卡 = card > head + body），外加工具条按钮 */
function makeDom() {
  const xhtml = fs.readFileSync(XHTML, 'utf8');
  const root = new El('vbox');
  root.className = 'pp-root';
  const byKey = new Map();
  for (const key of FOLD_KEYS) {
    const re = new RegExp('class="pp-card pp-fold" data-fold="' + key + '"');
    if (!ok(re.test(xhtml), '⑤ prefs.xhtml 含分组卡 data-fold="' + key + '"')) continue;
    const card = new El('div');
    card.setAttribute('class', 'pp-card pp-fold');
    card.setAttribute('data-fold', key);
    const head = new El('div');
    head.setAttribute('class', 'pp-fold-head');
    const body = new El('div');
    body.setAttribute('class', 'pp-card-body');
    card.appendChild(head);
    card.appendChild(body);
    root.appendChild(card);
    byKey.set(key, { card, head, body });
  }
  const expandBtn = new El('button');
  expandBtn.setAttribute('id', 'pp-fold-expand');
  const collapseBtn = new El('button');
  collapseBtn.setAttribute('id', 'pp-fold-collapse');
  root.appendChild(expandBtn);
  root.appendChild(collapseBtn);
  return {
    root, byKey, expandBtn, collapseBtn, xhtml,
    document: {
      getElementById: (id) => {
        if (id === 'pp-fold-expand') return expandBtn;
        if (id === 'pp-fold-collapse') return collapseBtn;
        return null;
      },
      querySelectorAll: (sel) => root.querySelectorAll(sel),
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
    PaperPilot: { _prefsFocus: opts.focus || '' },
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
  ok(dom.byKey.size === 13, '⑤ 13 张分组卡都建出来了（0.43.1 +知网账号）', dom.byKey.size);
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
  ok((dom.xhtml.match(/class="pp-card pp-fold"/g) || []).length === 13,
    '⑤ pp-fold 卡恰好 13 张（无裸 pp-card 漏包）');
}

/* ---------------- ① 初始：默认全收起 ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  eq(openCount(dom), 0, '① pref 为空 → 13 张卡全部收起');
  eq(PrefStore.get('extensions.zotero.paperpilot.prefsFoldOpen'), undefined,
    '① 初始不写 pref');
}

/* ---------------- ② 点标题行：切换 + 记住 ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  dom.byKey.get('channels').head.click();
  ok(isOpen(dom, 'channels'), '② 点 channels 标题 → 展开');
  eq(PrefStore.get('extensions.zotero.paperpilot.prefsFoldOpen'), 'channels',
    '② 展开写回 pref');
  ok(!isOpen(dom, 'account') && !isOpen(dom, 'translate'),
    '② 点 channels 不影响其他卡');
  dom.byKey.get('translate').head.click();
  eq(PrefStore.get('extensions.zotero.paperpilot.prefsFoldOpen'), 'channels,translate',
    '② 再展开 translate → pref 追加（保持顺序）');
  dom.byKey.get('channels').head.click();
  ok(!isOpen(dom, 'channels'), '② 再点 channels → 收起');
  eq(PrefStore.get('extensions.zotero.paperpilot.prefsFoldOpen'), 'translate',
    '② 收起后 pref 移除该键');
}

/* ---------------- ③ 全部展开 / 全部收起 ---------------- */
{
  const dom = makeDom();
  const { PrefStore } = runFoldScript(dom);
  dom.expandBtn.click();
  eq(openCount(dom), 13, '③ 全部展开 → 13 张卡全开');
  eq(PrefStore.get('extensions.zotero.paperpilot.prefsFoldOpen').split(',').length, 13,
    '③ pref 记满 13 键');
  dom.collapseBtn.click();
  eq(openCount(dom), 0, '③ 全部收起 → 12 张卡全闭');
  eq(PrefStore.get('extensions.zotero.paperpilot.prefsFoldOpen'), '', '③ pref 清空');
}

/* ---------------- ④ 深链定位：_prefsFocus ---------------- */
{
  const dom = makeDom();
  const { Zotero, flush } = runFoldScript(dom, { focus: 'channels' });
  ok(isOpen(dom, 'channels'), '④ _prefsFocus=channels → 该卡自动展开');
  eq(Zotero.PaperPilot._prefsFocus, '', '④ 焦点键消费后清空（一次性）');
  flush(); // 60ms 滚动定位定时器
  ok(dom.byKey.get('channels').card.scrolled, '④ 滚动定位到目标卡');
}

/* ---------------- ⑥ 状态恢复：pref 里有键 → 打开时恢复 ---------------- */
{
  const dom = makeDom();
  runFoldScript(dom, { prefs: { 'extensions.zotero.paperpilot.prefsFoldOpen': 'uitheme,pdftheme' } });
  ok(isOpen(dom, 'uitheme') && isOpen(dom, 'pdftheme'), '⑥ pref 记住的卡恢复展开');
  eq(openCount(dom), 2, '⑥ 其余保持收起');
}

/* ---------------- 汇总 ---------------- */
console.log('prefs-fold: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
