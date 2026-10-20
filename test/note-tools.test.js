#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 笔记工具（大纲 / 批量整理，0.63.0 · A2）测试
 *
 * 无人环境下没有 ProseMirror、也不该去动编辑器，所以这里用「vm 沙箱 + 笔记桩」把两段链路真跑：
 *   ① 纯函数：parseOutline / buildOutlineHtml / injectOutline / stripOutline / mergeHtml /
 *      applyTitlePrefix / dedupeTags —— 包括**幂等**（重复插大纲不叠加）、嵌套 <ul> 配对、
 *      外层 <div> 包装内插入、空大纲移除整块、前缀尾部空格保留；
 *   ② 运行时：noteItemsFromSelection 归一、refreshOutline/removeOutline、addTags/removeTags
 *      （含 setTags 兜底）、moveToCollection（无分类 vs 有分类）、prefixTitles、mergeNotes
 *      （新笔记 + 原笔记保留 + 继承分类）、list() 载荷、_api() 形状与异常兜底。
 *
 * 沙箱里 **不提供 DOMParser**（Zotero.getMainWindow() 返回 null）：这样 parseOutline 走的是
 * 正则退化路径，正好把「无主窗口也能解析」这条保底覆盖到。
 *
 * 运行：node test/note-tools.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'note-tools.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 240) });
}

/* ---------------- 桩 ---------------- */

let idSeq = 100;
let newItemSeq = 900;

function makeNote(id, html, opts) {
  const o = opts || {};
  const n = {
    id: id || ++idSeq,
    key: 'NOTE' + String(id || idSeq),
    libraryID: 1,
    _html: String(html == null ? '' : html),
    _tags: (o.tags || []).slice(),
    _colls: (o.colls || []).slice(),
    saved: 0,
    isNote() { return true; },
    isRegularItem() { return false; },
    getNote() { return this._html; },
    setNote(h) { this._html = String(h == null ? '' : h); },
    async saveTx() { this.saved++; return true; },
    getDisplayTitle() {
      const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(this._html);
      if (m) return m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return 'note-' + this.id;
    },
    getTags() { return this._tags.map((tag) => ({ tag })); },
    getCollections() { return this._colls.slice(); },
    addToCollection(cid) { if (this._colls.indexOf(cid) < 0) this._colls.push(cid); },
  };
  if (!o.noAddTag) n.addTag = function (t) { if (this._tags.indexOf(t) < 0) this._tags.push(t); };
  if (!o.noRemoveTag) n.removeTag = function (t) { this._tags = this._tags.filter((x) => x !== t); };
  // setTags 兜底路径用
  n.setTags = function (list) { this._tags = list.slice(); };
  return n;
}

class ItemStub {
  constructor(type) {
    this.itemType = type;
    this.id = ++newItemSeq;
    this.libraryID = 1;
    this._html = '';
    this._colls = [];
    this.saved = 0;
    created.push(this);
  }
  setNote(h) { this._html = String(h == null ? '' : h); }
  async saveTx() { this.saved++; return true; }
  addToCollection(cid) { if (this._colls.indexOf(cid) < 0) this._colls.push(cid); }
  getCollections() { return this._colls.slice(); }
}

const store = new Map();          // id → note/regular item
const created = [];               // new Zotero.Item("note") 的产物

const I18N = {
  noteToolsTitle: '笔记工具',
  noteToolsMergeTitle: '笔记整理（合并）',
  noteToolsEmpty: '没有笔记',
  noteToolsNoCollection: '先选分类',
  noteToolsPromptTags: '输入标签：',
  noteToolsPromptPrefix: '输入前缀：',
};

const sandbox = {
  console, Promise, Number, String, Object, Math, JSON, Set, Array, Date, RegExp, isFinite, parseInt,
  I18n: { isZh: true, t: (k) => (I18N[k] === undefined ? k : I18N[k]) },
  Zotero: {
    // 无主窗口 → parseOutline 走正则退化路径
    getMainWindow: () => null,
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

/* ==================== ① 纯函数 ==================== */

function testPure() {
  eq(N.escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;', '① escapeHtml 转义 & < > "');
  eq(N.escapeHtml(null), '', '① escapeHtml(null) → ""');
  eq(N.stripTags('<p>a</p>'), ' a ', '① stripTags 去标签保留文本');
  has(N.stripTags('<p>a&amp;b&nbsp;c</p>'), 'a&b', '① stripTags 解实体（&amp; 最后解）');
  eq(N.normalizeText('  a \n\t b  '), 'a b', '① normalizeText 压空白');

  const html = '<div data-schema-version="9"><h1>标题 A</h1><p>x</p><h2>小节 1</h2>'
    + '<h3>更深</h3><h2>小节 2</h2><h6>末级</h6></div>';
  const ol = N.parseOutline(html);
  eq(ol.length, 5, '① parseOutline 命中 5 个标题（正则退化路径）');
  eq(ol.map((o) => o.level).join(','), '1,2,3,2,6', '① parseOutline 层级');
  eq(ol[0].text, '标题 A', '① parseOutline 文本去标签');
  eq(ol.map((o) => o.id).join(','), 'h0,h1,h2,h3,h4', '① parseOutline id 序号');
  eq(JSON.stringify(N.parseOutline('<h1>   </h1><h2></h2>')), '[]', '① parseOutline 跳过空标题');
  eq(JSON.stringify(N.parseOutline('')), '[]', '① parseOutline 空 HTML');
  eq(N.parseOutline('<p>无标题正文</p>').length, 0, '① parseOutline 无标题');

  const ul = N.buildOutlineHtml(ol);
  eq((ul.match(/<ul>/g) || []).length, (ul.match(/<\/ul>/g) || []).length, '① buildOutlineHtml <ul> 配对');
  eq((ul.match(/<li>/g) || []).length, (ul.match(/<\/li>/g) || []).length, '① buildOutlineHtml <li> 配对');
  eq(ul.slice(0, 10), '<ul><li>标题', '① buildOutlineHtml 顶层从 <ul><li> 起');
  eq(N.buildOutlineHtml([]), '', '① buildOutlineHtml 空大纲 → ""');
  has(N.buildOutlineHtml([{ level: 1, text: 'a<b>&"c' }]), 'a&lt;b&gt;&amp;&quot;c', '① buildOutlineHtml 转义标题文本');
  ok(!/href=/.test(ul), '① buildOutlineHtml 不生成锚点链接（Zotero 笔记不支持）');

  // 同级连续 / 跳级 都要产出合法嵌套
  const flat = N.buildOutlineHtml([{ level: 1, text: 'a' }, { level: 1, text: 'b' }]);
  eq(flat, '<ul><li>a</li><li>b</li></ul>', '① buildOutlineHtml 同级平铺');
  const deep = N.buildOutlineHtml([{ level: 2, text: 'a' }, { level: 4, text: 'b' }]);
  eq(deep, '<ul><li>a<ul><li>b</li></ul></li></ul>', '① buildOutlineHtml 跳级仍合法');

  const once = N.injectOutline(html, ul);
  ok(once.indexOf(N.OUTLINE_START) > 0 && once.indexOf(N.OUTLINE_END) > once.indexOf(N.OUTLINE_START), '① injectOutline 写入标记块');
  ok(once.indexOf(N.OUTLINE_START) > once.indexOf('<div'), '① injectOutline 插在 <div> 包装内部');
  // 标题安全：Zotero 笔记标题 = 正文首行（noteToTitle），大纲必须排在标题行之后
  ok(once.indexOf(N.OUTLINE_START) > once.indexOf('</h1>'), '① injectOutline 排在标题行之后（不改笔记标题）');
  has(once, '<p><strong>目录</strong></p>', '① injectOutline 带「目录」说明行');
  eq(N.injectOutline(once, ul), once, '① injectOutline 幂等（重复执行不叠加）');
  eq(N.stripOutline(once), html, '① stripOutline 精确还原');
  eq(N.injectOutline(once, ''), html, '① 空大纲 → 移除已有标记块');
  eq(N.injectOutline(html, ''), html, '① 无块 + 空大纲 → 原样返回');
  const noH1 = '<p>只有正文</p>';
  eq(N.injectOutline(noH1, '<ul><li>x</li></ul>'),
    noH1 + N.OUTLINE_START + '<p><strong>目录</strong></p><ul><li>x</li></ul>' + N.OUTLINE_END,
    '① 无标题的笔记：大纲排在首段之后（首段仍是标题来源）');
  const plain = N.injectOutline('纯文本笔记', '<ul><li>x</li></ul>');
  ok(plain.indexOf(N.OUTLINE_START) > plain.indexOf('纯文本笔记'), '① 纯文本笔记追加到尾部（宁可靠后也不改标题）');

  // D1/D2 回归（0.63.0 修复）：大纲必须留在包装内部、列表之后
  const imgOnly = '<div class="zotero-note znv1"><img src="a.png"/></div>';
  const imgOut = N.injectOutline(imgOnly, '<ul><li>x</li></ul>');
  ok(imgOut.indexOf(N.OUTLINE_END) < imgOut.lastIndexOf('</div>'),
    '① [D1] 包装内只有 <img> 时大纲仍在 </div> 之内（空元素不算块）');
  const listStart = '<div class="zotero-note znv1"><ul><li>甲</li><li>乙</li></ul></div>';
  const listOut = N.injectOutline(listStart, '<ul><li>x</li></ul>');
  ok(listOut.indexOf(N.OUTLINE_START) > listOut.indexOf('</ul>'),
    '① [D2] 列表开头的笔记：大纲在 </ul> 之后（不进 <ul>/<li>）');
  ok(listOut.indexOf(N.OUTLINE_START) < listOut.lastIndexOf('</div>'),
    '① [D2] 且仍在包装内部');
  // D3 回归：标记乱序时幂等
  const broken = N.OUTLINE_END + 'y' + N.OUTLINE_START;
  const f1 = N.injectOutline(broken, '<ul><li>z</li></ul>');
  ok(N.injectOutline(f1, '<ul><li>z</li></ul>') === f1, '① [D3] 标记乱序时连续执行两次结果逐字节相同');

  // D5 回归（0.63.0）：depth 只统计块级标签，行内标签（b/i/span/code…）不开层
  const preRaw = '<div class="zotero-note znv1"><pre>a <b> c</pre><p>x</p></div>';
  const preOut = N.injectOutline(preRaw, '<ul><li>x</li></ul>');
  ok(preOut.indexOf(N.OUTLINE_END) < preOut.lastIndexOf('</div>'),
    '① [D5] <pre> 内裸 <b> 时大纲仍在包装内（行内标签不参与深度）');
  eq(N.insertPoint(preRaw), preRaw.indexOf('</pre>') + '</pre>'.length,
    '① [D5] 插入点 = </pre> 之后（不是 src.length）');
  const inlineP = '<div class="zotero-note znv1"><p>a <code>b</code> c</p><p>d</p></div>';
  eq(N.insertPoint(inlineP), inlineP.indexOf('</p>') + '</p>'.length,
    '① [D5] 段落内行内标签不干扰：插入点仍是首段 </p> 之后');

  eq(N.noteBody('<div class="a"><p>x</p></div>'), '<p>x</p>', '① noteBody 去掉外层包装');
  eq(N.noteBody('<p>x</p>'), '<p>x</p>', '① noteBody 非包装原样');
  eq(N.firstHeading(html), '标题 A', '① firstHeading 取首个标题');

  const merged = N.mergeHtml(
    [{ title: 'n1', html: '<div><p>a</p></div>' }, { html: '<h2>n2</h2><p>b</p>' }],
    { mergedTitle: '整理', heading: 'h2', titlePrefix: '★ ' }
  );
  has(merged, '<h1>整理</h1>', '① mergeHtml 合并标题');
  has(merged, '<h2>★ n1</h2>', '① mergeHtml 用传入标题 + 前缀');
  has(merged, '<h2>★ n2</h2>', '① mergeHtml 无标题时取首个标题');
  has(merged, '<hr/>', '① mergeHtml 条间 <hr/>');
  ok(merged.indexOf('<div') < 0, '① mergeHtml 剥掉原笔记外层包装');
  eq(N.mergeHtml([{ title: 'only', html: '<p>x</p>' }]), '<h1>only</h1><p>x</p>', '① mergeHtml 单条不带 <hr>');

  eq(JSON.stringify(N.dedupeTags([' a ', 'A', '', null, 'b', 'b '])), '["a","b"]', '① dedupeTags 去空/去重（大小写不敏感）/保序');
  eq(JSON.stringify(N.dedupeTags('solo')), '["solo"]', '① dedupeTags 接受单值');

  const pref = N.applyTitlePrefix(html, '[精读] ', '标题 A');
  has(pref, '<h1>[精读] 标题 A</h1>', '① applyTitlePrefix 保留前缀尾部空格');
  eq(N.applyTitlePrefix(pref, '[精读] ', '标题 A'), pref, '① applyTitlePrefix 幂等');
  has(N.applyTitlePrefix(html, '[精读]', 'x'), '<h1>[精读]标题 A</h1>', '① applyTitlePrefix 无空格时不强加');
  has(N.applyTitlePrefix('<div><p>第一行</p></div>', '# ', '第一行'), '<h1># 第一行</h1>', '① applyTitlePrefix 无 h1 时插入');
  eq(N.applyTitlePrefix(html, '   ', 'x'), html, '① applyTitlePrefix 空前缀 noop');
}

/* ==================== ② 运行时 ==================== */

async function testRuntime() {
  // --- noteItemsFromSelection ---
  const n1 = makeNote(1, '<h1>A</h1><h2>a1</h2>');
  const n2 = makeNote(2, '<h1>B</h1>');
  const n3 = makeNote(3, '<h1>C</h1>');
  store.set(1, n1); store.set(2, n2); store.set(3, n3);
  const regular = {
    id: 50, isRegularItem: () => true, isNote: () => false,
    getNotes: () => [3, 1],
  };
  const picked = N.noteItemsFromSelection([n2, regular, n1]);
  eq(picked.map((n) => n.id).join(','), '1,2,3', '② noteItemsFromSelection 收笔记 + 父条目全部笔记、去重、按 id 升序');

  // --- refreshOutline ---
  const r1 = await N.refreshOutline(n1);
  eq(r1.ok, true, '② refreshOutline ok');
  eq(r1.changed, true, '② refreshOutline 首次 changed');
  eq(r1.count, 2, '② refreshOutline count = 标题数');
  has(n1.getNote(), N.OUTLINE_START, '② refreshOutline 写入笔记');
  eq(n1.saved, 1, '② refreshOutline saveTx 一次');
  const r2 = await N.refreshOutline(n1);
  eq(r2.changed, false, '② refreshOutline 幂等（内容没变不写盘）');
  eq(n1.saved, 1, '② refreshOutline 幂等时不再 saveTx');
  const rEmpty = await N.refreshOutline(makeNote(11, '<p>没有标题</p>'));
  eq(rEmpty.count, 0, '② refreshOutline 无标题 count=0');
  const rNoNote = await N.refreshOutline(null);
  eq(rNoNote.ok, false, '② refreshOutline(空) → ok:false（不静默）');

  // --- removeOutline ---
  const r3 = await N.removeOutline(n1);
  eq(r3.changed, true, '② removeOutline 移除成功');
  ok(n1.getNote().indexOf(N.OUTLINE_START) < 0, '② removeOutline 标记块已消失');
  const r4 = await N.removeOutline(n1);
  eq(r4.changed, false, '② removeOutline 无块时 changed:false 且不报错');

  // --- addTags / removeTags ---
  const t1 = makeNote(21, '<h1>T1</h1>');
  const t2 = makeNote(22, '<h1>T2</h1>');
  const ra = await N.addTags([t1, t2], ['x', 'X', ' y ']);
  eq(ra.changed, 2, '② addTags 统计成功条数');
  eq(JSON.stringify(t1.getTags().map((t) => t.tag)), '["x","y"]', '② addTags 去重后写入');
  eq(t1.saved, 1, '② addTags saveTx');
  const rr = await N.removeTags([t1], ['x']);
  eq(rr.changed, 1, '② removeTags 统计');
  eq(JSON.stringify(t1.getTags().map((t) => t.tag)), '["y"]', '② removeTags 生效');
  eq((await N.addTags([], ['x'])).changed, 0, '② addTags 空笔记列表不抛错');
  eq((await N.addTags([t1], [])).changed, 0, '② addTags 空标签不写盘');

  // setTags 兜底（老版本/桩没有 addTag/removeTag）
  const legacy = makeNote(23, '<h1>L</h1>', { noAddTag: true, noRemoveTag: true, tags: ['old'] });
  await N.addTags([legacy], ['new']);
  eq(JSON.stringify(legacy.getTags().map((t) => t.tag)), '["old","new"]', '② addTags 走 setTags 兜底');
  await N.removeTags([legacy], ['old']);
  eq(JSON.stringify(legacy.getTags().map((t) => t.tag)), '["new"]', '② removeTags 走 setTags 兜底');

  // --- moveToCollection ---
  const mc = makeNote(31, '<h1>M</h1>');
  const bad = await N.moveToCollection([mc], 0);
  eq(bad.ok, false, '② moveToCollection(0) → ok:false');
  eq(bad.reason, 'no-collection', '② moveToCollection(0) → reason no-collection');
  const good = await N.moveToCollection([mc], 7);
  eq(good.changed, 1, '② moveToCollection 成功计数');
  eq(JSON.stringify(mc.getCollections()), '[7]', '② moveToCollection 写入分类');

  // --- prefixTitles ---
  const p1 = makeNote(41, '<h1>原标题</h1><p>b</p>');
  const pr = await N.prefixTitles([p1], '★ ');
  eq(pr.changed, 1, '② prefixTitles 命中');
  has(p1.getNote(), '<h1>★ 原标题</h1>', '② prefixTitles 改的是首个 h1（不是 setField）');
  eq((await N.prefixTitles([p1], '★ ')).changed, 0, '② prefixTitles 幂等');
  eq((await N.prefixTitles([p1], '  ')).ok, false, '② prefixTitles 空前缀 → ok:false');

  // --- mergeNotes ---
  const m1 = makeNote(51, '<div><h1>M1</h1><p>a</p></div>', { colls: [9] });
  const m2 = makeNote(52, '<div><h1>M2</h1><p>b</p></div>', { colls: [9, 10] });
  const before1 = m1.getNote();
  const mg = await N.mergeNotes([m1, m2]);
  eq(mg.ok, true, '② mergeNotes ok');
  eq(mg.count, 2, '② mergeNotes 返回合并条数');
  eq(m1.getNote(), before1, '② mergeNotes 不动原笔记内容');
  eq(m1.saved, 0, '② mergeNotes 不保存原笔记（原笔记保留且未改写）');
  const createdNote = store.get(mg.id) || created.find((x) => x.id === mg.id);
  ok(!!createdNote, '② mergeNotes 产出新笔记对象');
  if (createdNote) {
    has(createdNote.getNote ? createdNote.getNote() : createdNote._html, '<h1>笔记整理（合并）</h1>', '② 合并笔记标题走 i18n');
    has(createdNote._html, '<h2>M1</h2>', '② 合并笔记每条 h2 标题');
    eq(JSON.stringify(createdNote._colls), '[9]', '② 合并笔记继承首条笔记的分类');
  }
  eq((await N.mergeNotes([])).ok, false, '② mergeNotes 空列表 → ok:false');

  // --- list() ---
  const rows = N.list([1, 2, 3]);
  eq(rows.length, 3, '② list 行数');
  eq(typeof rows[0].id, 'number', '② list 行 id 是数字（可直接回传 api）');
  eq(typeof rows[0].title, 'string', '② list 行 title');
  eq(typeof rows[0].excerpt, 'string', '② list 行 excerpt');
  eq(typeof rows[0].headings, 'number', '② list 行 headings 计数');
  eq(N.list([999]).length, 0, '② list 跳过不存在的 id');

  // --- _api 形状与兜底 ---
  const api = N._api([1, 2]);
  for (const k of ['isZh', 'list', 'refreshOutline', 'removeOutline', 'addTags', 'removeTags',
    'moveToCollection', 'prefixTitles', 'merge', 'askTags', 'askPrefix']) {
    eq(typeof api[k], 'function', '② api.' + k + ' 存在');
  }
  eq(api.isZh(), true, '② api.isZh()');
  eq(api.list().length, 2, '② api.list() 用打开窗口时的 id 快照');
  const apiMove = await api.moveToCollection([1]);
  eq(apiMove.reason, 'no-collection', '② api.moveToCollection 无选中分类 → reason no-collection');
  eq(api.askTags(), null, '② api.askTags() 取消 → null');
  eq(api.askPrefix(), null, '② api.askPrefix() 取消 → null');
  const apiBad = await api.refreshOutline(999);
  eq(apiBad.ok, false, '② api 写操作异常/找不到笔记 → {ok:false}（不静默）');
  eq(typeof apiBad.error, 'string', '② api 失败带 error 文案');
}

(async () => {
  testPure();
  await testRuntime();

  if (fails.length) {
    console.error('\nFAILED ' + fails.length + ' / ' + (pass + fails.length));
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('note-tools: ' + pass + ' 项断言全部通过 ✓');
})().catch((e) => {
  console.error('TEST CRASHED: ' + ((e && (e.stack || e.message)) || e));
  process.exit(1);
});
