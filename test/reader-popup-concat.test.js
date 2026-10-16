#!/usr/bin/env node
/* 划词浮窗 · B1 Ctrl 拼接模式 + B2 批注标记写入 测试
 *
 * 为什么要有它：拼接模式横跨「键监听 → 缓冲 → 多次浮窗事件 → 合并触发」，
 * 任何一环断了表现都是「Ctrl 划词没反应 / 译文串段」；批注标记写入若把用户
 * 手写备注吃掉则是数据损坏。这里用 Node vm + 迷你 DOM 桩把浮窗真跑一遍，断言：
 *   ① Ctrl 划词只入缓冲不触发，徽标「已拼接 N 段」随段数刷新；
 *   ② 松开 Ctrl（keyup）以合并文本触发默认动作（走 readerPopupAutoTranslate 语义）；
 *   ③ 单段 × 移除后合并文本同步变化；
 *   ④ 「清空」清空缓冲且 keyup 不再触发；
 *   ⑤ 自动开关关闭时 keyup 不触发、缓冲保留；下一次无 Ctrl 划词并入并合并触发；
 *   ⑥ 浮窗关闭（box 脱离文档）清空缓冲；
 *   ⑦ 写入批注带 <!-- pp:tr --> 标记对；二次写入仅替换对内内容，手写内容保留；
 *      无标记时追加标记块；_stripMarked 读取剥离。
 *
 * 运行：node test/reader-popup-concat.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/features/reader-popup.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM（同 translate-pane.test.js 技法） ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false;
    this.id = ''; this.title = ''; this.parentNode = null; this.handlers = {};
    this._conn = true;
  }
  get isConnected() { return this._conn !== false; }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
    if (k.indexOf('data-') === 0) this.dataset[k.slice(5)] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); }
  click() { this.fire('click'); }
  focus() {}
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  byClass(cls) { return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(cls) >= 0); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
}

function makeDoc() {
  const doc = new El('#document');
  doc.createElementNS = (ns, tag) => new El(tag);
  doc.createElement = (tag) => new El(tag);
  return doc;
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const PREFIX = 'extensions.zotero.paperpilot.';
const setPref = (k, v) => PrefStore.set(PREFIX + k, v);
const clearPrefs = () => PrefStore.clear();

const chatCalls = [];
let aiReply = '译文';
const intervals = [];
const timers = [];
async function tick(n = 5) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// 附件/父条目/批注桩
const anno = {
  annotationComment: '',
  saved: 0,
  async saveTx() { this.saved++; },
};
const att = { id: 1, libraryID: 1, isRegularItem: () => false, parentItemID: 100 };
const parent = { id: 100, libraryID: 1, isRegularItem: () => true };

let popupHandler = null;
const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined),
    set: (k, v) => PrefStore.set(k, v),
  },
  Reader: {
    registerEventListener: (name, fn) => { popupHandler = fn; },
    unregisterEventListener: () => {},
  },
  Items: {
    get: (id) => (id === 1 ? att : id === 100 ? parent : null),
    getByLibraryAndKey: (lib, key) => (lib === 1 && key === 'ANNO1' ? anno : null),
  },
  Utilities: { Internal: { copyText: () => {}, openPreferences: () => {} } },
  PaperPilot: { _paneID: 'paperpilot-prefs' },
  logError() {},
};

const AIClient = {
  hasKey: () => true,
  guidance: () => '',
  async chat(messages) { chatCalls.push(messages); return aiReply; },
  // 不提供 chatStream：强制走非流式路径（测试聚焦拼接/写入，不聚焦流式）
};

const sandbox = {
  console, Zotero, AIClient,
  AIChat: { paperMeta: () => ({ title: 'T', creators: 'A', pub: 'P', year: '2024' }) },
  AIChatPane: { injectQuote: () => true },
  ChatFloat: { injectQuote: () => {} },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  setInterval: (fn) => { intervals.push(fn); return intervals.length; },
  clearInterval: () => {},
  Promise, Date, Math, JSON, WeakSet,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const RP = sandbox.ReaderPopup;
const I18n = sandbox.I18n;

/* ---------------- 驱动工具 ---------------- */

const doc = makeDoc();
let box = null;

/** 触发一次划词浮窗；anno=true 时带高亮批注参数 */
function popup(text, withAnno) {
  box = null;
  popupHandler({
    doc,
    params: withAnno
      ? { annotation: { id: 'ANNO1', text }, text }
      : { text },
    reader: { itemID: 1 },
    append: (b) => { box = b; },
  });
  return box;
}

function reset() {
  RP._concatClear();
  RP._concat.modifier = false;
  RP._concat.run = null;
  RP._resultCache.clear();
  RP._lastAutoKey = '';
  RP._lastAutoTime = 0;
  chatCalls.length = 0;
  intervals.length = 0;
}

const segs = () => RP._concat.segs.slice();
const concatRow = () => box.byClass('pp-pop-concat')[0];
const badgeText = () => {
  const row = concatRow();
  const badge = row && row.children.find((c) => c.tag === 'span' && /已拼接/.test(c.textContent));
  return badge ? badge.textContent : '';
};
const removeBtns = () => concatRow().byTag('button').filter((b) => b.title === I18n.t('popupConcatRemove'));
const clearBtn = () => concatRow().byTag('button').find((b) => b.textContent === I18n.t('popupConcatClear'));
const btnByText = (t) => box.byTag('button').find((b) => b.textContent === t);

setPref('readerPopupAutoTranslate', true);

async function main() {
RP.register('paperpilot@dev.local');
ok(!!popupHandler, '0 renderTextSelectionPopup 已注册');

/* ---------------- ① Ctrl 划词：累加缓冲 + 徽标，不触发 ---------------- */

reset();
// 先触发一次普通浮窗：键监听在首次 _onPopup 时才绑到 reader 文档
// （register 阶段拿不到 doc；这是已知的「史上第一次划词」绑定窗口）
popup('warm up binding');
reset();
doc.fire('keydown', { key: 'Control' });
popup('First segment.');
eq(segs().length, 1, '① 第一段入缓冲');
eq(chatCalls.length, 0, '① Ctrl 划词不立即触发');
eq(concatRow().style.display, 'flex', '① 拼接行可见');
eq(badgeText(), '已拼接 1 段', '① 徽标 1 段');

popup('Second segment.');
eq(segs().length, 2, '① 第二段累加');
eq(badgeText(), '已拼接 2 段', '① 徽标刷新为 2 段');
eq(chatCalls.length, 0, '① 仍未触发');

/* ---------------- ② 松开 Ctrl：合并文本触发默认动作 ---------------- */

doc.fire('keyup', { key: 'Control' });
await tick();
eq(chatCalls.length, 1, '② keyup 触发一次翻译');
has(chatCalls[0][1].content, 'First segment.\nSecond segment.', '② 合并文本进 prompt');
eq(segs().length, 0, '② 触发后缓冲清空');
eq(concatRow().style.display, 'none', '② 拼接行收起');

/* ---------------- ③ 单段移除 ---------------- */

reset();
doc.fire('keydown', { key: 'Control' });
popup('Alpha one');
popup('Beta two');
popup('Gamma three');
eq(segs().length, 3, '③ 三段入缓冲');
eq(removeBtns().length, 3, '③ 每段一个移除按钮');
removeBtns()[1].click();
eq(segs().join('|'), 'Alpha one|Gamma three', '③ 移除中间段');
eq(badgeText(), '已拼接 2 段', '③ 徽标同步为 2 段');
doc.fire('keyup', { key: 'Control' });
await tick();
has(chatCalls[0][1].content, 'Alpha one\nGamma three', '③ 合并文本不含已移除段');

/* ---------------- ④ 清空 ---------------- */

reset();
doc.fire('keydown', { key: 'Control' });
popup('Xx part');
popup('Yy part');
ok(!!clearBtn(), '④ 有「清空」按钮');
clearBtn().click();
eq(segs().length, 0, '④ 清空缓冲');
eq(concatRow().style.display, 'none', '④ 清空后拼接行收起');
doc.fire('keyup', { key: 'Control' });
await tick();
eq(chatCalls.length, 0, '④ 清空后 keyup 不再触发');

/* ---------------- ⑤ 自动开关关闭：keyup 不触发、缓冲保留；无 Ctrl 划词合并消费 ---------------- */

reset();
setPref('readerPopupAutoTranslate', false);
doc.fire('keydown', { key: 'Control' });
popup('Part one');
popup('Part two');
doc.fire('keyup', { key: 'Control' });
await tick();
eq(chatCalls.length, 0, '⑤ 开关关闭时 keyup 不自动触发');
eq(segs().length, 2, '⑤ 缓冲保留（按钮仍作用于合并文本）');
setPref('readerPopupAutoTranslate', true);
popup('Part three'); // 无 Ctrl 划词：并入缓冲并以合并文本触发
await tick();
eq(chatCalls.length, 1, '⑤ 无 Ctrl 划词触发默认动作');
has(chatCalls[0][1].content, 'Part one\nPart two\nPart three', '⑤ 合并 = 缓冲 + 本次选区');
eq(segs().length, 0, '⑤ 消费后缓冲清空');
setPref('readerPopupAutoTranslate', true);

/* ---------------- ⑥ 浮窗关闭清缓冲 ---------------- */

reset();
setPref('readerPopupAutoTranslate', false);
doc.fire('keydown', { key: 'Control' });
popup('Close me later');
doc.fire('keyup', { key: 'Control' });
eq(segs().length, 1, '⑥ 关闭前缓冲有 1 段');
eq(intervals.length, 1, '⑥ 浮窗挂载了关闭监听');
box._conn = false; // 模拟浮窗从 reader 文档移除
intervals[0]();
eq(segs().length, 0, '⑥ 浮窗关闭后缓冲清空');
setPref('readerPopupAutoTranslate', true);

/* ---------------- ⑦ B2 批注标记写入 + 安全重译 ---------------- */

reset();
setPref('readerPopupAutoTranslate', false); // 手动点翻译，聚焦写入逻辑
anno.annotationComment = '';
anno.saved = 0;
aiReply = '译文一';
popup('Some highlighted text', true);
const trBtn = btnByText(I18n.t('popupTranslate'));
const wbBtn = btnByText(I18n.t('popupWriteBack'));
ok(!!trBtn && !!wbBtn, '⑦ 批注划词有翻译与写入批注按钮');
trBtn.click();
await tick();
const resultBox = box.byClass('pp-pop-result')[0];
eq(resultBox.textContent, '译文一', '⑦ 翻译结果渲染');
wbBtn.click();
await tick();
eq(anno.saved, 1, '⑦ saveTx 被调用');
eq(anno.annotationComment, '<!-- pp:tr -->\n译文一\n<!-- /pp:tr -->', '⑦ 首次写入带标记对');

// 二次写入：标记外手写内容原样保留，仅替换对内
anno.annotationComment = '手写开头\n\n<!-- pp:tr -->\n旧译文\n<!-- /pp:tr -->\n\n手写结尾';
RP._resultCache.clear();
aiReply = '新译文';
popup('Some highlighted text', true);
btnByText(I18n.t('popupTranslate')).click();
await tick();
btnByText(I18n.t('popupWriteBack')).click();
await tick();
eq(anno.annotationComment, '手写开头\n\n<!-- pp:tr -->\n新译文\n<!-- /pp:tr -->\n\n手写结尾',
  '⑦ 重译仅替换标记对内，手写开头/结尾保留');

// 无标记：追加一个标记块，不动原文
anno.annotationComment = '纯手写备注';
RP._resultCache.clear();
aiReply = '译文三';
popup('Some highlighted text', true);
btnByText(I18n.t('popupTranslate')).click();
await tick();
btnByText(I18n.t('popupWriteBack')).click();
await tick();
eq(anno.annotationComment, '纯手写备注\n\n<!-- pp:tr -->\n译文三\n<!-- /pp:tr -->',
  '⑦ 无标记时追加标记块');

// 读取剥离
eq(RP._stripMarked('a\n<!-- pp:tr -->\n译\n<!-- /pp:tr -->\nb'), 'a\n\n译\n\nb',
  '⑦ _stripMarked 剥离标记保留正文');

/* ---------------- 输出 ---------------- */

console.log('='.repeat(60));
if (fails.length) {
  for (const f of fails) console.log('  x ' + f);
  console.log('-'.repeat(60));
}
console.log('划词浮窗拼接/批注标记测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
console.log('='.repeat(60));
process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.log('测试异常：' + (e && e.stack || e)); process.exit(1); });
