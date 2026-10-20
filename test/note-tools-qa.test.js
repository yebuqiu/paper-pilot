#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 笔记工具（0.63.0 · A2）独立验收测试 —— QA 侧补充断言
 *
 * 与 test/note-tools.test.js 的分工：那边覆盖主链路，这里专门钉**风险点与边角**，
 * 每条都对着源码注释里的硬约束：
 *   · injectOutline **不得把目录插到正文首个块之前**（否则 noteToTitle 把每条笔记标题变成「目录」）
 *   · buildOutlineHtml 必须转义 `<script>` 与 `&`（标题来自笔记正文，可能是任意 HTML）
 *   · 批量写操作必须「原笔记不被修改/删除」、「失败返回 {ok:false} 不静默」
 *   · parseOutline 两条路径（DOM 缺失时的正则退化路径）在属性和内联标签下都要正确
 *
 * 沙箱不提供 DOMParser（Zotero.getMainWindow() → null），因此全部走正则退化路径。
 * 约束：不联网、不启动 Zotero、不改生产代码。运行：node test/note-tools-qa.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'note-tools.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'note-tools.xhtml');
const WINJS = path.join(ROOT, 'chrome', 'content', 'note-tools.js');

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}
function no(hay, needle, label) {
  return ok(String(hay).indexOf(needle) < 0, label, { want: '不含 ' + needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 桩 ---------------- */

let seq = 100;
const store = new Map();
const created = [];

function makeNote(html, opts) {
  const o = opts || {};
  const n = {
    id: o.id || ++seq,
    key: 'NOTE' + (o.id || seq),
    libraryID: 1,
    _html: String(html == null ? '' : html),
    _tags: (o.tags || []).slice(),
    _colls: (o.colls || []).slice(),
    saved: 0,
    deleted: false,
    isNote: () => true,
    isRegularItem: () => false,
    getNote() { return this._html; },
    setNote(h) { this._html = String(h == null ? '' : h); },
    async saveTx() {
      if (o.failSave) throw new Error('saveTx failed');
      this.saved++;
      return true;
    },
    getDisplayTitle() {
      const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(this._html);
      if (m) return m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return 'note-' + this.id;
    },
    getTags() { return this._tags.map((t) => ({ tag: t })); },
    getCollections() { return this._colls.slice(); },
    addToCollection(cid) { if (this._colls.indexOf(cid) < 0) this._colls.push(cid); },
    removeFromCollection(cid) { this._colls = this._colls.filter((x) => x !== cid); },
  };
  if (!o.noAddTag) n.addTag = function (t) { if (this._tags.indexOf(t) < 0) this._tags.push(t); };
  if (!o.noRemoveTag) {
    n.removeTag = function (t) {
      if (o.failRemoveTag) throw new Error('removeTag failed');
      this._tags = this._tags.filter((x) => x !== t);
    };
  }
  n.setTags = function (list) { this._tags = list.slice(); };
  store.set(n.id, n);
  return n;
}

class ItemStub {
  constructor(type) {
    this.itemType = type;
    this.id = ++seq;
    this.libraryID = 1;
    this._html = '';
    this._colls = [];
    this.saved = 0;
    created.push(this);
  }
  setNote(h) { this._html = String(h == null ? '' : h); }
  getNote() { return this._html; }
  async saveTx() {
    if (ItemStub.failSave) throw new Error('new note saveTx failed');
    this.saved++;
    return true;
  }
  addToCollection(cid) { if (this._colls.indexOf(cid) < 0) this._colls.push(cid); }
  getCollections() { return this._colls.slice(); }
}

const I18N = {
  noteToolsTitle: '笔记工具',
  noteToolsMergeTitle: '笔记整理（合并）',
  noteToolsEmpty: '没有笔记',
  noteToolsPromptTags: '输入标签：',
  noteToolsPromptPrefix: '输入前缀：',
};

const sandbox = {
  console, Promise, Number, String, Object, Math, JSON, Set, Map, Array, Date, RegExp, isFinite, parseInt,
  I18n: { isZh: true, t: (k) => (I18N[k] === undefined ? k : I18N[k]) },
  Zotero: {
    getMainWindow: () => null,          // → parseOutline 走正则退化路径
    getActiveZoteroPane: () => null,
    logError: () => {},
    Items: { get: (id) => store.get(id) || null },
    Item: ItemStub,
  },
  Services: {
    prompt: { alert: () => 0, prompt: () => false },
    wm: { getEnumerator: () => ({ hasMoreElements: () => false, getNext: () => null }) },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'note-tools.js' });

const N = sandbox.NoteTools;

/* ==================== ① 窗口资源静态核查 ==================== */

function testStatic() {
  const win = fs.readFileSync(WINJS, 'utf8');
  const xhtml = fs.readFileSync(XHTML, 'utf8');

  // 窗口脚本不得直接调用 Zotero.* / Services.*（注释里提到不算）
  const codeLines = win.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const code = codeLines.join('\n');
  ok(!/\bZotero\./.test(code), '① 窗口脚本无 Zotero.* 调用（只经 api）');
  ok(!/\bServices\./.test(code), '① 窗口脚本无 Services.* 调用（只经 api）');
  has(win, 'window.arguments', '① 窗口脚本经 window.arguments 取 api');

  // id 引用必须都在 xhtml 里存在
  const ids = Array.from(win.matchAll(/\$\("([\w-]+)"\)/g)).map((m) => m[1]);
  const uniq = Array.from(new Set(ids));
  ok(uniq.length >= 10, '① 窗口脚本引用了 ' + uniq.length + ' 个元素 id');
  for (const id of uniq) {
    has(xhtml, 'id="' + id + '"', '① xhtml 中存在元素 #' + id);
  }
  // 反向：xhtml 里带 pp-nt- 的 id 都有脚本处理（除列表/计数/状态容器）
  const passive = new Set(['pp-nt-list', 'pp-nt-count', 'pp-nt-status']);
  for (const m of xhtml.matchAll(/id="(pp-nt-[\w-]+)"/g)) {
    if (passive.has(m[1])) continue;
    has(win, '"' + m[1] + '"', '① xhtml 元素 #' + m[1] + ' 有脚本接线');
  }

  // XML 可解析性（Python XML 解析放在门禁里跑；这里做最基本的自检）
  ok(/^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(xhtml.trim()), '① xhtml 有 XML 声明');
  ok(xhtml.indexOf('windowtype="papilot:notetools"') > 0, '① windowtype 与 NoteTools.WINDOWTYPE 一致');
  eq(N.WINDOWTYPE, 'papilot:notetools', '① WINDOWTYPE = papilot:notetools');
  eq(N.DLOG_URL, 'chrome://papilot/content/note-tools.xhtml', '① DLOG_URL 指向 note-tools.xhtml');
  has(xhtml, 'src="chrome://papilot/content/note-tools.js"', '① xhtml 脚本引用同目录 note-tools.js');
  no(xhtml, '&nbsp;', '① xhtml 不含 &nbsp;（XUL XML 里是未定义实体）');
}

/* ==================== ② parseOutline ==================== */

function testParseOutline() {
  const mixed = '<h1>一</h1><h2>二</h2><h3>三</h3><h4>四</h4><h5>五</h5><h6>六</h6>';
  const ol = N.parseOutline(mixed);
  eq(ol.map((x) => x.level).join(','), '1,2,3,4,5,6', '② parseOutline h1–h6 混合层级');
  eq(ol.map((x) => x.text).join('|'), '一|二|三|四|五|六', '② parseOutline 文本按序');
  eq(ol.map((x) => x.id).join(','), 'h0,h1,h2,h3,h4,h5', '② parseOutline id 连续');

  // 空标题 / 纯空白 / &nbsp; 占位
  eqJson(N.parseOutline('<h1></h1><h2>   </h2><h3>&nbsp;</h3>'), [],
    '② parseOutline 空标题与空白/&nbsp; 标题全部跳过');

  // 带属性 + 内联标签
  const attr = N.parseOutline('<h2 class="sec" id="s1" data-x="1">方法 <em>Method</em> 与 <code>x</code></h2>');
  eq(attr.length, 1, '② parseOutline 带属性标题命中');
  eq(attr[0].text, '方法 Method 与 x', '② parseOutline 内联标签去标签取纯文本');

  // 大写 / h7 / 未闭合
  eq(N.parseOutline('<H2>UPPER</H2>')[0].text, 'UPPER', '② parseOutline 标签大小写不敏感');
  eq(N.parseOutline('<h7>七</h7>').length, 0, '② parseOutline h7 不算标题');
  eq(N.parseOutline('<h1>未闭合').length, 0, '② parseOutline 未闭合标题不计（退化路径的已知限制）');

  // 非标题块里出现 <h1 字样（属性/文本）不应误判
  eqJson(N.parseOutline('<p>讨论 &lt;h1&gt; 标签</p>'), [], '② parseOutline 实体化的 h1 不算标题');

  // 超长标题
  const longText = '长'.repeat(5000);
  const lo = N.parseOutline('<h1>' + longText + '</h1>');
  eq(lo.length, 1, '② parseOutline 超长标题命中');
  eq(lo[0].text.length, 5000, '② parseOutline 超长标题不截断');
  const lh = N.buildOutlineHtml(lo);
  ok(lh.indexOf(longText) > 0, '② buildOutlineHtml 保留超长标题');

  // 无标题 / 空输入
  eqJson(N.parseOutline('<p>只有正文</p>'), [], '② parseOutline 无标题 → []');
  eqJson(N.parseOutline(''), [], '② parseOutline 空串 → []');
  eqJson(N.parseOutline(null), [], '② parseOutline null → []');
  eqJson(N.parseOutline('   '), [], '② parseOutline 纯空白 → []');
}

function eqJson(a, b, label) { return eq(JSON.stringify(a), JSON.stringify(b), label); }

/* ==================== ③ buildOutlineHtml ==================== */

function testBuildOutline() {
  // 1,2,3,2,1 的完整结构（压栈/弹栈）
  const html = N.buildOutlineHtml([
    { level: 1, text: 'A' }, { level: 2, text: 'B' }, { level: 3, text: 'C' },
    { level: 2, text: 'D' }, { level: 1, text: 'E' },
  ]);
  eq(html, '<ul><li>A<ul><li>B<ul><li>C</li></ul></li><li>D</li></ul></li><li>E</li></ul>',
    '③ buildOutlineHtml 1-2-3-2-1 层级压栈正确');
  eq((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length, '③ <ul> 开闭配对');
  eq((html.match(/<li>/g) || []).length, (html.match(/<\/li>/g) || []).length, '③ <li> 开闭配对');

  // 首项从深层级开始：仍需合法
  const fromDeep = N.buildOutlineHtml([{ level: 3, text: 'x' }, { level: 1, text: 'y' }]);
  eq(fromDeep, '<ul><li>x</li><li>y</li></ul>', '③ 首项深层级 → 平铺（不生成空 <ul>）');

  // 转义：标题来自正文，可能是任意 HTML
  const esc = N.buildOutlineHtml([{ level: 1, text: '<script>alert(1)</script>' }, { level: 2, text: 'A & B' }]);
  no(esc, '<script>', '③ buildOutlineHtml 转义 <script>（不得原样输出）');
  has(esc, '&lt;script&gt;alert(1)&lt;/script&gt;', '③ buildOutlineHtml 尖括号转义');
  has(esc, 'A &amp; B', '③ buildOutlineHtml & 转义');
  no(esc, 'A & B', '③ buildOutlineHtml 不留下裸 &');

  // 引号也要转义（文本里出现 " 时不破坏属性/文本）
  has(N.buildOutlineHtml([{ level: 1, text: 'say "hi"' }]), 'say &quot;hi&quot;',
    '③ buildOutlineHtml 转义双引号');

  // 非法输入
  eq(N.buildOutlineHtml([]), '', '③ buildOutlineHtml([]) → ""');
  eq(N.buildOutlineHtml(null), '', '③ buildOutlineHtml(null) → ""');
  eq(N.buildOutlineHtml('abc'), '', '③ buildOutlineHtml(非数组) → ""');
  eq(N.buildOutlineHtml([{ level: 1, text: '   ' }]), '', '③ 全空文本 → ""');
  eq(N.buildOutlineHtml([null, { level: 1, text: 'a' }, { level: 2 }]),
    '<ul><li>a</li></ul>', '③ 跳过 null / 无文本项');

  // level 越界钳制
  eq(N.buildOutlineHtml([{ level: 0, text: 'a' }]), '<ul><li>a</li></ul>', '③ level 0 → 钳到 1');
  eq(N.buildOutlineHtml([{ level: 99, text: 'a' }, { level: 99, text: 'b' }]),
    '<ul><li>a</li><li>b</li></ul>', '③ level 99 → 钳到 6（同级平铺）');
  eq(N.buildOutlineHtml([{ level: '2', text: 'a' }]), '<ul><li>a</li></ul>', '③ 字符串 level 可用');
}

/* ==================== ④ injectOutline / stripOutline（标题安全） ==================== */

/* Zotero 笔记标题 = 正文首行（noteToTitle）。这里不去复刻 Zotero 内部实现，
 * 而是直接钉住支撑它的机制：目录块必须排在**第一个块级元素闭合之后**。 */
function firstBlockEnd(html) {
  return N.insertPoint(html);
}

function testInject() {
  const wrapped = '<div class="zotero-note znv1"><h1>标题 A</h1><p>正文 1</p><p>正文 2</p></div>';
  const ol = N.buildOutlineHtml(N.parseOutline(wrapped));

  const once = N.injectOutline(wrapped, ol);
  const at = firstBlockEnd(wrapped);
  eq(once.indexOf(N.OUTLINE_START), at, '④ 大纲插在「第一个块闭合之后」的位置');
  ok(at > 0, '④ 插入点不为 0（不可能插到正文首个块之前）');
  ok(once.indexOf(N.OUTLINE_START) > once.indexOf('</h1>'),
    '④ ★ 大纲排在首个标题块之后（笔记标题不会被改成「目录」）');
  ok(once.slice(0, at) === wrapped.slice(0, at), '④ 插入点之前的内容逐字节未变（首个块原样保留）');
  has(once, '</h1>' + N.OUTLINE_START, '④ 标题行紧邻大纲块（视觉仍在顶部）');

  // 幂等：第二次不再插入、长度不变
  const twice = N.injectOutline(once, ol);
  eq(twice, once, '④ injectOutline 幂等（第二次完全不变）');
  eq((twice.match(/pp:outline:start/g) || []).length, 1, '④ 只有一个大纲标记块');

  // 空大纲 → 移除整块，其余精确还原
  eq(N.injectOutline(once, ''), wrapped, '④ 空大纲 → 移除标记块并精确还原原文');
  eq(N.injectOutline(wrapped, ''), wrapped, '④ 无块 + 空大纲 → 原样返回');

  // 只移除、不留「目录」说明行
  no(N.injectOutline(once, ''), '<strong>目录</strong>', '④ 移除大纲时「目录」说明行一起被移除');

  // stripOutline 独立行为
  eq(N.stripOutline(once), wrapped, '④ stripOutline 精确还原');
  eq(N.stripOutline(wrapped), wrapped, '④ stripOutline 无块 → 原样');
  eq(N.stripOutline(N.OUTLINE_START + 'x'), 'x', '④ 只有 START 无 END → 剥掉孤立标记，内容不误删');

  // 无标题笔记：首个块是 <p> → 插在 </p> 之后（首段仍是标题来源）
  const noH = '<div class="zotero-note znv1"><p>只有正文</p></div>';
  const noHOut = N.injectOutline(noH, '<ul><li>x</li></ul>');
  ok(noHOut.indexOf(N.OUTLINE_START) > noHOut.indexOf('</p>'),
    '④ 无标题笔记：大纲排在首段之后（不改首行标题）');

  // 纯文本笔记：没有块结构 → 追加到尾部（宁可靠后也不改标题）
  const plain = N.injectOutline('纯文本笔记', '<ul><li>x</li></ul>');
  ok(plain.indexOf(N.OUTLINE_START) > plain.indexOf('纯文本笔记'), '④ 纯文本笔记：大纲追加到尾部');
  eq(plain.slice(0, '纯文本笔记'.length), '纯文本笔记', '④ 纯文本笔记首行不变');

  // 无外层 div 包装（裸 <h1>）
  const bare = '<h1>T</h1><p>B</p>';
  ok(N.injectOutline(bare, '<ul><li>x</li></ul>').indexOf(N.OUTLINE_START) > bare.indexOf('</h1>'),
    '④ 无包装笔记：大纲排在 </h1> 之后');
  eq(firstBlockEnd(bare), bare.indexOf('</h1>') + '</h1>'.length, '④ insertPoint 无包装时取首个块闭合');

  // 标记顺序被破坏（END 在 START 之前）→ 先剥离全部标记再重建：幂等，不会越插越多（D3 已修）
  const broken = N.OUTLINE_END + 'x' + N.OUTLINE_START;
  const b1 = N.injectOutline(broken, '<ul><li>y</li></ul>');
  const b2 = N.injectOutline(b1, '<ul><li>y</li></ul>');
  eq(b2, b1, '④ [已修复] 标记乱序时重建一次即稳定（幂等）');
  eq((b2.match(/pp:outline:start/g) || []).length, 1, '④ [已修复] 只留 1 个 START 标记（不再越插越多）');
  has(b2, 'x', '④ [已修复] 乱序标记之间的内容不被误删');
}

/* ==================== ④b D1/D2 回归：插入点必须在包装内、列表外 ==================== */

/* 这两项曾是**真缺陷**（首次验收时按 probe 惯例钉住了当时的错误行为），已在 0.63.0 修掉：
 *   D1 大纲被插到笔记外层包装 </div> 之外 → setNote 后被编辑器清掉（功能静默失效）；
 *   D2 以列表开头的笔记把大纲插进 <ul>/<li> 内部 → 非法嵌套 / 目录变成列表项子内容。
 * 现在断言的是**正确行为**：实现一旦退回旧版，这几条会立刻变红。 */
function testDefects() {
  // D1：纯文本笔记（包装内没有任何块闭合标签）→ 插在包装 </div> **之前**
  const plain = '<div class="zotero-note znv1">纯文本笔记</div>';
  const plainOut = N.injectOutline(plain, '<ul><li>O</li></ul>');
  eq(N.insertPoint(plain), plain.lastIndexOf('</div>'), 'D1 [已修复] insertPoint 取外层 </div> 的位置（插它之前）');
  ok(plainOut.indexOf(N.OUTLINE_END) < plainOut.lastIndexOf('</div>'),
    'D1 [已修复] ★ 大纲留在外层包装内部（</div> 之前）');
  eq(plainOut,
    '<div class="zotero-note znv1">纯文本笔记' + N.OUTLINE_START + '<p><strong>目录</strong></p><ul><li>O</li></ul>' + N.OUTLINE_END + '</div>',
    'D1 [已修复] 实测输出：包装内追加');

  const img = '<div class="zotero-note znv1"><img src="a.png"/></div>';
  const imgOut = N.injectOutline(img, '<ul><li>O</li></ul>');
  ok(imgOut.indexOf(N.OUTLINE_END) < imgOut.lastIndexOf('</div>'),
    'D1 [已修复] 只有 <img> 的笔记同样插在包装内（空元素不算块）');

  // D2：以列表开头的笔记 → 插在**整个 </ul> 之后**
  const list = '<div class="zotero-note znv1"><ul><li>甲</li><li>乙</li></ul></div>';
  const listOut = N.injectOutline(list, '<ul><li>O</li></ul>');
  eq(N.insertPoint(list), list.indexOf('</ul>') + '</ul>'.length, 'D2 [已修复] 插入点 = 整个 </ul> 之后');
  ok(listOut.indexOf(N.OUTLINE_START) > listOut.indexOf('</ul>'), 'D2 [已修复] 大纲落在列表之后（不进 <ul>）');
  ok(!/甲<\/li><!-- pp:outline:start -->/.test(listOut),
    'D2 [已修复] ★ 不再产出 <ul><li>甲</li><p>目录</p>… 非法嵌套');
  // ProseMirror 形态（<li><p>）同样落在 </ul> 之后，而不是第一个 <li> 内部
  const listP = '<div class="zotero-note znv1"><ul><li><p>甲</p></li></ul></div>';
  const listPOut = N.injectOutline(listP, '<ul><li>O</li></ul>');
  ok(listPOut.indexOf(N.OUTLINE_START) > listPOut.indexOf('</ul>'), 'D2 [已修复] <li><p> 形态：大纲在 </ul> 之后');
  eq(listPOut.slice(0, listPOut.indexOf(N.OUTLINE_START)).split('<li>').length - 1, 1,
    'D2 [已修复] 大纲之前只有原来的 1 个 <li>（没挤进列表）');

  /* D5（残余 / 低）：修复前，深度扫描把 <pre>/<code> **内部未转义的类标签文本**当成真标签
   * 计数，导致「回到第 1 层」的判断被推迟到包装自己的 </div>，插入点又跑到包装之外
   * （与 D1 同一失效模式：setNote 后大纲可能被清掉，点了看不到效果）。QA 探针复现后
   * 0.63.0 已修：depth 现在**只统计 BLOCK_TAGS**，行内标签（b/i/span/a/code/em…）不再开层，
   * 所以 <pre> 内的裸 <b> 不影响插入点。下面断言的是修复后的正确行为。 */
  const preRaw = '<div class="zotero-note znv1"><pre>a <b> c</pre><p>x</p></div>';
  const preRawOut = N.injectOutline(preRaw, '<ul><li>O</li></ul>');
  ok(preRawOut.indexOf(N.OUTLINE_END) < preRawOut.lastIndexOf('</div>'),
    'D5 [已修复] <pre> 内裸 <b> 时大纲仍在包装内（行内标签不参与深度）');
  eq(N.insertPoint(preRaw), preRaw.indexOf('</pre>') + '</pre>'.length,
    'D5 [已修复] 插入点 = </pre> 之后（不是 src.length）');
  // 正常（编辑器转义）形态不受影响
  const preEsc = '<div class="zotero-note znv1"><pre>a &lt;b&gt; c</pre><p>x</p></div>';
  const preEscOut = N.injectOutline(preEsc, '<ul><li>O</li></ul>');
  ok(preEscOut.indexOf(N.OUTLINE_END) < preEscOut.lastIndexOf('</div>'),
    'D5 [对照] 实体转义后的 <pre> 正常插在包装内');
  eq(preEscOut.indexOf(N.OUTLINE_START), preEsc.indexOf('</pre>') + '</pre>'.length,
    'D5 [对照] 转义形态插入点 = </pre> 之后');

  /* D5b（残余 / 低）：新的判据是「depth 只统计 BLOCK_TAGS」，所以 `<pre>` 里出现的是
   * **块级**标签文本（`<div>` / `<p>` / `<table>`…）时仍会开一层，闭合回不到 base，
   * 插入点又被甩到包装外（与 D1/D5 同一失效模式）。
   * 触发条件比 D5 更窄：需要从外部粘贴/导入的**未转义块级标签**（编辑器自己会转成 &lt;div&gt;）。
   * 修法建议：扫描时跳过 `<pre>/<code>/<script>/<style>` 的内容区（栈里记一下这三个标签）。
   * 这里按 probe 惯例把当前行为钉住，修完后把 ok() 取反即可。 */
  const preDiv = '<div class="zotero-note znv1"><pre>x <div> y</pre><p>z</p></div>';
  const preDivOut = N.injectOutline(preDiv, '<ul><li>O</li></ul>');
  ok(preDivOut.indexOf(N.OUTLINE_END) > preDivOut.lastIndexOf('</div>'),
    'D5b [已知边角] <pre> 内裸块级标签（<div>）时大纲仍会跑到包装外（LOW）');
  eq(N.insertPoint(preDiv), preDiv.length,
    'D5b [已知边角] 该形态下 insertPoint 退化为 src.length');
  // 对照：同样内容、把块级标签转义后正常
  const preDivEsc = '<div class="zotero-note znv1"><pre>x &lt;div&gt; y</pre><p>z</p></div>';
  const preDivEscOut = N.injectOutline(preDivEsc, '<ul><li>O</li></ul>');
  ok(preDivEscOut.indexOf(N.OUTLINE_END) < preDivEscOut.lastIndexOf('</div>'),
    'D5b [对照] 转义后的块级标签文本不影响插入点');
}


function testPrefix() {
  // 已有前缀 → 不重复
  eq(N.applyTitlePrefix('<h1>[精读] 标题</h1>', '[精读]'), '<h1>[精读] 标题</h1>',
    '⑤ 已有前缀不重复添加');
  eq(N.applyTitlePrefix('<h1>[精读] 标题</h1>', '[精读] '), '<h1>[精读] 标题</h1>',
    '⑤ 带尾空格的同一前缀也不重复');
  // 前缀匹配应作用于标题文本（前导空白不影响判定）
  eq(N.applyTitlePrefix('<h1>  [精读] 标题</h1>', '[精读]'), '<h1>  [精读] 标题</h1>',
    '⑤ 标题前导空白时仍判为已有前缀');

  // 无前缀 → 加上
  eq(N.applyTitlePrefix('<h1>标题</h1>', '[精读]'), '<h1>[精读]标题</h1>',
    '⑤ 无尾空格的前缀直接拼接（不凭空加空格）');
  eq(N.applyTitlePrefix('<h1>标题</h1>', '[精读] '), '<h1>[精读] 标题</h1>',
    '⑤ 尾空格是排版意图，必须保留');

  // 无 h1 → 插入 h1 到文首（这才是「改标题」）
  const noH = '<div class="zotero-note znv1"><p>正文</p></div>';
  const out = N.applyTitlePrefix(noH, '[精读] ', '原标题');
  eq(out, '<div class="zotero-note znv1"><h1>[精读] 原标题</h1><p>正文</p></div>',
    '⑤ 无 h1 → 在包装内文首插入 <h1>');
  ok(out.indexOf('<h1>') < out.indexOf('<p>'), '⑤ 新 h1 成为首行（列表标题才会变）');

  // 无 h1 且原标题已有前缀 → 不动
  eq(N.applyTitlePrefix('<p>正文</p>', '[精读]', '[精读] 原标题'), '<p>正文</p>',
    '⑤ 无 h1 且兜底标题已有前缀 → 原样返回');

  // 空前缀 / 非字符串安全
  eq(N.applyTitlePrefix('<h1>x</h1>', ''), '<h1>x</h1>', '⑤ 空前缀 → 原样');
  eq(N.applyTitlePrefix('<h1>x</h1>', '   '), '<h1>x</h1>', '⑤ 纯空白前缀 → 原样');
  eq(N.applyTitlePrefix(null, '[P] '), '<h1>[P] 笔记</h1>', '⑤ null html → 仅插入标题（兜底「笔记」）');

  // 前缀含 HTML 必须转义
  has(N.applyTitlePrefix('<h1>t</h1>', '<b>'), '&lt;b&gt;t', '⑤ 前缀转义（不注入 HTML）');
  // 标题本身含实体：转义前先取纯文本，避免二次编码
  eq(N.applyTitlePrefix('<h1>A &amp; B</h1>', '[P] '), '<h1>[P] A &amp; B</h1>',
    '⑤ 标题实体正确往返（不出现 &amp;amp;）');

  // 大写标签
  eq(N.applyTitlePrefix('<H1>t</H1>', '[P] '), '<h1>[P] t</h1>', '⑤ 大写 <H1> 也能加前缀');
}

/* ==================== ⑥ mergeHtml ==================== */

function testMergeHtml() {
  const html = N.mergeHtml([
    { title: '甲', html: '<div class="zotero-note znv1"><p>甲正文</p></div>' },
    { title: '乙', html: '<div class="zotero-note znv1"><p>乙正文</p></div>' },
  ], { mergedTitle: '合并', heading: 'h2' });

  eq(html.slice(0, '<h1>合并</h1>'.length), '<h1>合并</h1>', '⑥ mergeHtml 首行是合并标题 h1');
  eq((html.match(/<h2>/g) || []).length, 2, '⑥ 各条用 h2（不与合并标题抢层级）');
  eq((html.match(/<hr\/>/g) || []).length, 1, '⑥ n 条之间 n-1 个 <hr/> 分隔');
  has(html, '<p>甲正文</p>', '⑥ 正文保留（不转义）');
  no(html, 'zotero-note znv1', '⑥ 剥掉外层 <div> 包装（避免嵌套 schema 包装）');

  // 转义
  const esc = N.mergeHtml([{ title: 'A & <script>x</script>', html: '<p>1</p>' }], {});
  no(esc, '<script>', '⑥ mergeHtml 转义标题里的 <script>');
  has(esc, '&lt;script&gt;', '⑥ mergeHtml 尖括号转义');
  has(esc, 'A &amp; ', '⑥ mergeHtml & 转义');

  // titlePrefix 拼接并转义
  has(N.mergeHtml([{ title: 'T', html: '' }], { titlePrefix: '[P] ' }), '<h1>[P] T</h1>',
    '⑥ titlePrefix 拼到各条标题前');

  // 无 title 时用首个标题兜底；再没有就「笔记 N」
  eq(N.mergeHtml([{ html: '<h2>来自标题</h2><p>x</p>' }], {}), '<h1>来自标题</h1><h2>来自标题</h2><p>x</p>',
    '⑥ 无 title → 用正文首个标题兜底');
  eq(N.mergeHtml([{ html: '<p>无标题</p>' }], {}), '<h1>笔记 1</h1><p>无标题</p>',
    '⑥ 无 title 且无标题 → 「笔记 1」');
  eq(N.mergeHtml([{}, { html: '' }], {}), '<h1>笔记 1</h1><hr/><h1>笔记 2</h1>',
    '⑥ 空条目也占位编号');

  // heading 参数校验：非法回落 h1
  eq(N.mergeHtml([{ title: 'T' }], { heading: 'h9' }), '<h1>T</h1>', '⑥ 非法 heading → 回落 h1');
  eq(N.mergeHtml([{ title: 'T' }], { heading: 'h3' }), '<h3>T</h3>', '⑥ 合法 heading 生效');

  // 空输入
  eq(N.mergeHtml([], {}), '', '⑥ 空列表 → ""');
  eq(N.mergeHtml(null, {}), '', '⑥ null → ""');

  // 已知边角：多个并列外层 div 时 noteBody 是贪婪匹配，会同时剥掉第二个 div（正文变不闭合）
  const twoDivs = N.mergeHtml([{ title: 'T', html: '<div><p>a</p></div><div><p>b</p></div>' }], {});
  eq(twoDivs, '<h1>T</h1><p>a</p></div><div><p>b</p>',
    '⑥ [已知边角] 并列双 div 被贪婪剥壳，正文残留 </div><div>（LOW）');
}

/* ==================== ⑦ 批量写操作（原笔记不被改坏 / 失败不静默） ==================== */

async function testBatch() {
  // --- addTags ---
  const n1 = makeNote('<h1>A</h1>', { tags: ['旧'] });
  const n2 = makeNote('<h1>B</h1>', { tags: [] });
  const before1 = n1.getNote();
  const r1 = await N.addTags([n1, n2], ['x', ' X ', 'y', '', null]);
  eq(r1.ok, true, '⑦ addTags 成功 → ok:true');
  eq(r1.changed, 2, '⑦ addTags changed = 2');
  eq(r1.total, 2, '⑦ addTags total = 2');
  eqJson(n1.getTags().map((t) => t.tag), ['旧', 'x', 'y'], '⑦ addTags 保留原有标签 + 去重（大小写不敏感，取首个写法）');
  eq(n1.getNote(), before1, '⑦ addTags 不改笔记正文');
  eq(n1.saved, 1, '⑦ addTags 每条只 saveTx 一次');

  // 空标签 / 空列表
  eqJson(await N.addTags([n1], []), { ok: true, changed: 0, total: 1 }, '⑦ addTags 空标签 → changed 0');
  eqJson(await N.addTags([], ['x']), { ok: true, changed: 0, total: 0 }, '⑦ addTags 空笔记列表 → changed 0');

  // 部分失败：不静默，其余继续
  const bad = makeNote('<h1>C</h1>', { failSave: true });
  const good = makeNote('<h1>D</h1>');
  const r2 = await N.addTags([bad, good], ['z']);
  eq(r2.ok, false, '⑦ addTags 单个失败 → ok:false（不静默）');
  ok(typeof r2.error === 'string' && r2.error.length > 0, '⑦ addTags 失败带 error 文本');
  eq(r2.changed, 1, '⑦ addTags 失败不影响其它笔记（changed=1）');
  ok(good.getTags().some((t) => t.tag === 'z'), '⑦ addTags 后续笔记仍然加上标签');

  // setTags 兜底路径（无 addTag）
  const n3 = makeNote('<h1>E</h1>', { tags: ['旧'], noAddTag: true });
  await N.addTags([n3], ['新']);
  eqJson(n3.getTags().map((t) => t.tag), ['旧', '新'], '⑦ addTags 无 addTag → setTags 兜底');

  // --- removeTags ---
  const n4 = makeNote('<h1>F</h1>', { tags: ['keep', 'drop', 'KEEP2'] });
  const r3 = await N.removeTags([n4], ['drop', 'KEEP2']);
  eq(r3.ok, true, '⑦ removeTags 成功 → ok:true');
  eqJson(n4.getTags().map((t) => t.tag), ['keep'], '⑦ removeTags 按标签名去掉指定标签');
  eq(n4.getNote(), '<h1>F</h1>', '⑦ removeTags 不改笔记正文');

  // [依赖] removeTag 主路径把原始写法交给 Zotero，大小写不敏感取决于 Zotero 实现
  // （内部 lower 集合只用于 setTags 兜底分支）。这里用大小写敏感的桩把该依赖钉住。
  const n4b = makeNote('<h1>F2</h1>', { tags: ['KEEP2'] });
  await N.removeTags([n4b], ['keep2']);
  eqJson(n4b.getTags().map((t) => t.tag), ['KEEP2'],
    '⑦ [依赖] removeTag 主路径大小写不敏感取决于 Zotero（兜底分支才是内部保证）');

  const n5 = makeNote('<h1>G</h1>', { tags: ['a', 'b'], noRemoveTag: true });
  await N.removeTags([n5], ['a']);
  eqJson(n5.getTags().map((t) => t.tag), ['b'], '⑦ removeTags 无 removeTag → setTags 兜底');

  const badR = makeNote('<h1>H</h1>', { tags: ['a'], failRemoveTag: true });
  const r4 = await N.removeTags([badR], ['a']);
  eq(r4.ok, false, '⑦ removeTags 失败 → ok:false（不静默）');
  ok(r4.error, '⑦ removeTags 失败带 error');

  // --- moveToCollection ---
  const n6 = makeNote('<h1>I</h1>');
  const r5 = await N.moveToCollection([n6], 0);
  eq(r5.ok, false, '⑦ moveToCollection 无分类 → ok:false');
  eq(r5.reason, 'no-collection', '⑦ moveToCollection 无分类 → reason=no-collection');
  eq(n6.saved, 0, '⑦ moveToCollection 无分类 → 不 saveTx（无副作用）');
  eqJson(n6.getCollections(), [], '⑦ moveToCollection 无分类 → 分类未变');

  const r6 = await N.moveToCollection([n6], 42);
  eq(r6.ok, true, '⑦ moveToCollection 有分类 → ok:true');
  eq(r6.changed, 1, '⑦ moveToCollection changed = 1');
  eqJson(n6.getCollections(), [42], '⑦ moveToCollection 加入指定分类');
  eq(n6.getNote(), '<h1>I</h1>', '⑦ moveToCollection 不改正文');

  // --- prefixTitles ---
  const p0 = makeNote('<h1>原题</h1>');
  const r7 = await N.prefixTitles([p0], '   ');
  eq(r7.ok, false, '⑦ prefixTitles 空前缀 → ok:false');
  eq(r7.reason, 'empty-prefix', '⑦ prefixTitles 空前缀 → reason=empty-prefix');
  eq(p0.saved, 0, '⑦ prefixTitles 空前缀 → 不 saveTx');

  const p1 = makeNote('<h1>[精读] 已有</h1>');
  const r8 = await N.prefixTitles([p1], '[精读] ');
  eq(r8.ok, true, '⑦ prefixTitles 已有前缀 → ok:true');
  eq(r8.changed, 0, '⑦ prefixTitles 已有前缀 → changed 0（幂等）');
  eq(p1.saved, 0, '⑦ prefixTitles 已有前缀 → 不写库');
  eq(p1.getNote(), '<h1>[精读] 已有</h1>', '⑦ prefixTitles 已有前缀 → 正文逐字节不变');

  const p2 = makeNote('<h1>新题</h1>');
  const r9 = await N.prefixTitles([p2], '[精读] ');
  eq(r9.changed, 1, '⑦ prefixTitles 无前缀 → changed 1');
  eq(p2.getNote(), '<h1>[精读] 新题</h1>', '⑦ prefixTitles 保留尾空格排版');

  // --- mergeNotes：原笔记一律保留 ---
  const m1 = makeNote('<h1>甲</h1><p>甲正文</p>', { colls: [7] });
  const m2 = makeNote('<h1>乙</h1><p>乙正文</p>', { colls: [8] });
  const snap1 = m1.getNote();
  const snap2 = m2.getNote();
  const createdBefore = created.length;
  const r10 = await N.mergeNotes([m1, m2]);
  eq(r10.ok, true, '⑦ mergeNotes → ok:true');
  eq(r10.count, 2, '⑦ mergeNotes count = 2');
  eq(created.length, createdBefore + 1, '⑦ mergeNotes 只新建 1 条笔记');
  const merged = created[created.length - 1];
  eq(merged.getNote().slice(0, '<h1>'.length), '<h1>', '⑦ 新笔记首行是合并标题');
  has(merged.getNote(), '甲正文', '⑦ 新笔记含甲正文');
  has(merged.getNote(), '乙正文', '⑦ 新笔记含乙正文');
  eqJson(merged._colls, [7], '⑦ 新笔记沿用首条笔记的分类');
  eq(merged.saved, 1, '⑦ 新笔记保存一次');

  // ★ 原笔记：未被修改、未被删除、未额外保存
  eq(m1.getNote(), snap1, '⑦ ★ 原笔记 1 正文未被修改');
  eq(m2.getNote(), snap2, '⑦ ★ 原笔记 2 正文未被修改');
  eq(m1.saved, 0, '⑦ ★ 原笔记 1 未被 saveTx（不产生不可逆写）');
  eq(m2.saved, 0, '⑦ ★ 原笔记 2 未被 saveTx');
  ok(store.get(m1.id) === m1 && store.get(m2.id) === m2, '⑦ ★ 原笔记仍在库中（未删除）');

  // 空列表
  const r11 = await N.mergeNotes([]);
  eq(r11.ok, false, '⑦ mergeNotes 空列表 → ok:false');
  eq(r11.reason, 'empty', '⑦ mergeNotes 空列表 → reason=empty');

  // 新建笔记保存失败：直接调用会抛出（由调用方 _safe 兜住）；经 _api 一律 {ok:false}
  ItemStub.failSave = true;
  const mf = makeNote('<h1>M</h1>');
  let mergeThrew = false;
  try { await N.mergeNotes([mf]); } catch (e) { mergeThrew = true; }
  ok(mergeThrew, '⑦ [契约差异] mergeNotes 保存失败直接抛错（addTags 等返回 {ok:false}）');
  const apiMerge = await N._api([mf.id]).merge([mf.id]);
  eq(apiMerge.ok, false, '⑦ 经 _api.merge 包装后失败仍返回 {ok:false}（对 UI 不静默）');
  ItemStub.failSave = false;

  // --- _api 包装：异常一律 {ok:false} ---
  const api = N._api([]);
  const badApi = await api.addTags([], []);
  eq(badApi.ok, true, '⑦ _api.addTags 空操作 → ok:true');
  const boom = makeNote('<h1>X</h1>', { failSave: true });
  store.set(boom.id, boom);
  const api2 = N._api([boom.id]);
  const rBad = await api2.addTags([boom.id], ['t']);
  eq(rBad.ok, false, '⑦ _api 把底层失败包成 {ok:false}');

  // _api.list() 返回纯数据（不带对象）
  const listRow = N._api([m1.id]).list();
  eq(listRow.length, 1, '⑦ _api.list() 返回 1 行');
  eq(typeof listRow[0].id, 'number', '⑦ list 行含 id');
  eq(typeof listRow[0].title, 'string', '⑦ list 行含 title');
  eq(typeof listRow[0].excerpt, 'string', '⑦ list 行含 excerpt');
  eq(typeof listRow[0].headings, 'number', '⑦ list 行含 headings');
  ok(typeof listRow[0].getNote === 'undefined', '⑦ list 行不带笔记对象（窗口只拿数据）');
}

/* ==================== 主流程 ==================== */

(async function main() {
  console.log('笔记工具 独立验收（test/note-tools-qa.test.js）');
  testStatic();
  testParseOutline();
  testBuildOutline();
  testInject();
  testDefects();
  testPrefix();
  testMergeHtml();
  await testBatch();

  console.log('---');
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项：');
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('note-tools-qa: ' + pass + ' 通过 / ' + fails.length + ' 失败');
    process.exit(1);
  }
  console.log('note-tools-qa: ' + pass + ' 项断言全部通过 ✓');
  console.log('说明：D1/D2/D3 三处缺陷已修复（0.63.0），④b/④ 段落现在断言的是**正确行为**，');
  console.log('      实现退回旧版会立刻变红。');
})();
