#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 全文对照翻译 · 双栏对照窗口渲染测试（插件 0.25.2）
 *
 * 为什么要有它：双栏窗口脚本（chrome/content/bilingual-view.js）跑在独立 chrome 窗口里，
 * 无人环境点不了。这里用「迷你 DOM + 假载荷」把它**真跑一遍**，断言布局结构本身：
 *   ① 段落成对：每段 = 同一网格行里的左(原文)/右(译文)两个单元格 —— 这是「滚动行级同步」
 *      的结构保证，一旦被改成「两个独立滚动容器 + scrollTop 互相追」，对齐就会漂，必须守住；
 *   ② 两栏等宽自适应：grid-template-columns 两栏 1fr，窄屏切 data-cols="single"（单栏）；
 *   ③ 字号 / 布局即时生效并写回 pref（设置面板同一份）；
 *   ④ 翻译链路必须回传到插件作用域（窗口脚本自己不发请求）—— 断言翻译只经 translateChunk。
 *
 * 运行：node test/bilingual-view.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const VIEW_JS = path.join(ROOT, 'chrome', 'content', 'bilingual-view.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'bilingual.xhtml');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM（复用 membership-panel.test.js 的技法） ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {};
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false;
    this.id = ''; this.parentNode = null; this.handlers = {};
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    else this._attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  removeAttribute(k) { if (k === 'class') this.className = ''; else delete this._attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(node, ref) {
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) {
    this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn);
  }
  fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); }
  click() { this.fire('click'); }
  focus() {}
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    const kids = this.children.length ? this.children.map((c) => c.textContent).join('') : '';
    // 真实 DOM 里 textContent 是「文本节点 + 子节点」的拼接；设 textContent 后再
    // insertBefore 徽标，文本节点仍在——迷你 DOM 用 _text 保留它，别丢正文
    return this._text ? this._text + kids : kids;
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
  byClass(cls) { return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(cls) >= 0); }
}

function makeDom(xhtml) {
  const ids = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(xhtml))) ids.add(m[1]);
  const registry = new Map();
  const documentElement = new El('window');
  for (const id of ids) {
    const el = new El('div');
    el.setAttribute('id', id);
    el.parentNode = documentElement;
    documentElement.children.push(el);
    registry.set(id, el);
  }
  const document = {
    readyState: 'complete',
    documentElement,
    getElementById: (id) => registry.get(id) || null,
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
  };
  return { document, registry };
}

/* ---------------- 假载荷（bootstrap 侧注入的回调） ---------------- */

function makePayload(over) {
  const calls = { full: 0, chunks: [], translated: [], notes: [] };
  const prefs = {};
  const base = {
    Zotero: { Utilities: { Internal: { copyText: (t) => { calls.copied = t; } } } },
    Services: {},
    title: '测试论文',
    lang: '中文',
    isZh: true,
    t: (k) => k,                       // 未装文案表 → 走窗口内的中英回退
    fontSize: 15,
    layout: 'auto',
    setPref: (k, v) => { prefs[k] = v; },
    getFullText: async () => { calls.full++; return 'P1\n\nP2\n\nP3'; },
    chunkText: () => ['段落一', '段落二', '段落三'],
    translateChunk: async (c) => { calls.translated.push(c); return '译文·' + c; },
    makeNote: async (pairs) => { calls.notes.push(pairs); return true; },
  };
  return { payload: Object.assign(base, over || {}), calls, prefs };
}

function boot(payload) {
  const xhtml = fs.readFileSync(XHTML, 'utf8');
  const { document, registry } = makeDom(xhtml);
  const win = {
    arguments: [payload],
    innerWidth: 1200,
    handlers: {},
    _closed: false,
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    removeEventListener(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); },
    fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); },
    focus() {},
    close() { this._closed = true; },
  };
  const sandbox = { console, window: win, document, setTimeout, clearTimeout, Promise, Date, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(VIEW_JS, 'utf8'), sandbox, { filename: 'bilingual-view.js' });
  return { win, registry, sandbox };
}

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function loop() {
      let v = false;
      try { v = cond(); } catch (e) { v = false; }
      if (v) return resolve(true);
      if (Date.now() - t0 > (timeoutMs || 6000)) return reject(new Error('waitFor timeout'));
      setTimeout(loop, 20);
    })();
  });
}

/** 去掉注释后再做「有没有直连 AI/网络」这类静态判定（否则注释里的模块名会误报） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---------------- 用例 ---------------- */

async function main() {
  /* ---- 1. 加载期：表头文案 + 工具栏文案 + 网格骨架 ---- */
  const { payload, calls, prefs } = makePayload();
  const { win, registry } = boot(payload);

  eq(registry.get('pp-bl-head-src').textContent, '原文', '1.1 左列表头 = 原文');
  eq(registry.get('pp-bl-head-dst').textContent, '译文', '1.2 右列表头 = 译文');
  eq(registry.get('pp-bl-copy').textContent, '复制译文', '1.3 工具栏「复制译文」文案');
  eq(registry.get('pp-bl-note').textContent, '导出双语笔记', '1.4 工具栏「导出双语笔记」文案');
  eq(registry.get('pp-bl-layout-label').textContent, '布局', '1.5 布局选择器有标签');
  eq(registry.get('pp-bl-grid').getAttribute('data-cols'), 'two', '1.6 默认（宽窗口）为双栏');
  eq(registry.get('pp-bl-grid').style.fontSize, '15px', '1.7 默认字号 15px 应用到网格');

  /* ---- 2. 单一滚动容器：行级同步是结构保证的 ---- */
  const xhtmlSrc = fs.readFileSync(XHTML, 'utf8');
  const viewJs = fs.readFileSync(VIEW_JS, 'utf8');
  has(xhtmlSrc, 'id="pp-bl-scroll"', '2.0 有滚动舞台 #pp-bl-scroll');
  has(xhtmlSrc, 'overflow-y:auto', '2.0b 滚动由舞台这一个容器负责（两栏不各自滚动）');
  eq((viewJs.match(/scrollTop\s*=/g) || []).length, 1,
    '2.1 只有一处 scrollTop 赋值（跟随最新段落），不存在两栏互相追的同步逻辑');
  has(viewJs, 'grid-template-columns: 1fr 1fr', '2.2 两栏等宽（1fr 1fr）');
  has(viewJs, "data-cols='single'] { grid-template-columns: 1fr; }", '2.3 单栏时退化为一列');

  /* ---- 3. 段落成对渲染（翻译过程 + 结果） ---- */
  await waitFor(() => win.ppBilingualSnapshot().done === 3 && !win.ppBilingualSnapshot().busy);
  const grid = registry.get('pp-bl-grid');
  const cells = grid.children.filter((c) => c.id !== 'pp-bl-head-src' && c.id !== 'pp-bl-head-dst');
  eq(cells.length, 6, '3.1 三段 → 6 个单元格（左右成对）');
  eq(cells[0].className, 'pp-bl-cell src', '3.2 每行第 1 格是原文');
  eq(cells[1].className, 'pp-bl-cell dst', '3.3 每行第 2 格是译文');
  eq(cells[0].textContent, '段落一', '3.4 原文内容原文照出');
  eq(cells[1].textContent, '译文·段落一', '3.5 译文落在同行的右侧格');
  eq(cells[2].textContent, '段落二', '3.6 第二行同样成对');
  eq(cells[3].textContent, '译文·段落二', '3.7 第二行译文成对');
  ok(cells[1].className.indexOf('pending') < 0, '3.8 完成后 pending 标记被摘掉');
  eq(registry.get('pp-bl-count').textContent, '3 / 3', '3.9 计数 3 / 3');
  eq(registry.get('pp-bl-progress-bar').style.width, '100%', '3.10 进度条满格');
  eq(win.ppBilingualSnapshot().cols, 'two', '3.11 宽窗口仍为双栏');

  /* ---- 4. 翻译链路必须回传（窗口自己不发请求） ---- */
  eq(JSON.stringify(calls.translated), JSON.stringify(['段落一', '段落二', '段落三']),
    '4.1 翻译只经注入的 translateChunk');
  eq(calls.full, 1, '4.2 全文由注入的 getFullText 取得');
  ok(!/AIClient\s*\.|\bAIChat\b|Zotero\.HTTP|fetch\s*\(/.test(stripComments(viewJs)),
    '4.3 窗口脚本不直连 AI / 网络（去掉注释后无 AIClient/AIChat/Zotero.HTTP/fetch）');

  /* ---- 5. 窄屏自动单栏 + 手动布局 + pref 持久化 ---- */
  win.innerWidth = 600;
  win.fire('resize');
  eq(win.ppBilingualSnapshot().cols, 'single', '5.1 窄屏（600px<720）自动切单栏');
  eq(grid.getAttribute('data-cols'), 'single', '5.2 单栏落到 data-cols');
  win.innerWidth = 1200;
  win.fire('resize');
  eq(win.ppBilingualSnapshot().cols, 'two', '5.3 拉宽后自动回双栏');

  const sel = registry.get('pp-bl-layout');
  sel.value = 'single';
  sel.fire('command');
  eq(win.ppBilingualSnapshot().cols, 'single', '5.4 手动「强制单栏」生效（与宽度无关）');
  eq(prefs.bilingualViewLayout, 'single', '5.5 布局写回 pref（设置面板同一份）');
  sel.value = 'two';
  sel.fire('command');
  eq(prefs.bilingualViewLayout, 'two', '5.6 切回双栏同样持久化');

  /* ---- 6. 字号即时生效 + pref 持久化 ---- */
  registry.get('pp-bl-font-inc').click();
  eq(win.ppBilingualSnapshot().fontSize, 16, '6.1 A+ 使字号 +1');
  eq(grid.style.fontSize, '16px', '6.2 字号即时应用到网格');
  eq(registry.get('pp-bl-font-val').textContent, '16px', '6.3 字号读数同步');
  eq(prefs.bilingualViewFontSize, 16, '6.4 字号写回 pref');
  registry.get('pp-bl-font-dec').click();
  registry.get('pp-bl-font-dec').click();
  eq(win.ppBilingualSnapshot().fontSize, 14, '6.5 A− 连按递减');
  for (let i = 0; i < 40; i++) registry.get('pp-bl-font-dec').click();
  eq(win.ppBilingualSnapshot().fontSize, 11, '6.6 字号下限夹到 11（不越界）');
  for (let i = 0; i < 40; i++) registry.get('pp-bl-font-inc').click();
  eq(win.ppBilingualSnapshot().fontSize, 28, '6.7 字号上限夹到 28');

  /* ---- 7. 复制全部译文 ---- */
  registry.get('pp-bl-copy').click();
  eq(calls.copied, '译文·段落一\n\n译文·段落二\n\n译文·段落三', '7.1 复制的是全部译文，按段拼接');
  has(registry.get('pp-bl-status').textContent, '已复制', '7.2 复制后有反馈');

  /* ---- 8. 导出双语笔记（保留原有笔记出口） ---- */
  registry.get('pp-bl-note').click();
  await waitFor(() => calls.notes.length === 1);
  const pairs = calls.notes[0];
  eq(pairs.length, 3, '8.1 导出三段');
  eq(pairs[0].src, '段落一', '8.2 原文进笔记（空白归一）');
  eq(pairs[0].dst, '译文·段落一', '8.3 译文进笔记');
  await waitFor(() => registry.get('pp-bl-status').textContent.indexOf('已生成双语笔记') >= 0);
  has(registry.get('pp-bl-status').textContent, '已生成双语笔记', '8.4 导出后有反馈');

  /* ---- 9. 单实例复用：busy 时拒绝换篇，空闲时换篇 ---- */
  const { payload: p2, calls: c2 } = makePayload({ title: '第二篇' });
  // 先造一个「正在翻译」的窗口
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = makePayload();
  slow.payload.translateChunk = async (c) => { await gate; return 'X' + c; };
  const w3 = boot(slow.payload);
  await waitFor(() => w3.win.ppBilingualSnapshot().busy === true);
  eq(w3.win.ppBilingualLoad(p2), false, '9.1 翻译中拒绝换篇（返回 false）');
  release();
  await waitFor(() => w3.win.ppBilingualSnapshot().busy === false);
  eq(w3.win.ppBilingualLoad(p2), true, '9.2 空闲后可换篇');
  await waitFor(() => w3.win.ppBilingualSnapshot().done === 3);
  eq(w3.registry.get('pp-bl-title').textContent, '第二篇', '9.3 换篇后标题更新');
  eq(c2.translated.length, 3, '9.4 换篇用的是新载荷的翻译回调');

  /* ---- 10. 卸载清理：不残留段落 / 不长期持有载荷 ---- */
  eq(typeof win.ppBilingualSnapshot, 'function', '10.1 暴露自检快照（排障用）');
  win.fire('unload');
  eq(win.ppBilingualSnapshot().pairs, 0, '10.2 卸载后段落清空');

  /* ---- 11. 取不到全文时给出明确说明（不静默空白） ---- */
  const empty = makePayload({ getFullText: async () => '' });
  const w4 = boot(empty.payload);
  await waitFor(() => w4.win.ppBilingualSnapshot().busy === false);
  has(w4.registry.get('pp-bl-grid').textContent, '未能取得全文', '11.1 无全文时给出可见说明');

  /* ---- 12. 单段失败不拖垮整篇 ---- */
  const flaky = makePayload();
  let n = 0;
  flaky.payload.translateChunk = async (c) => {
    n++;
    if (n === 2) throw new Error('boom');
    return 'T' + c;
  };
  const w5 = boot(flaky.payload);
  await waitFor(() => w5.win.ppBilingualSnapshot().busy === false);
  eq(w5.win.ppBilingualSnapshot().done, 3, '12.1 单段失败仍跑完剩余段落');
  has(w5.registry.get('pp-bl-grid').textContent, '翻译失败', '12.2 失败段有可见标记');

  /* ---- 13. 0.33.0 结构化单元：公式直出 / 页码徽标定位 / kind 信息回传 ---- */
  {
    const located = [];
    const info = [];
    const bl = makePayload({
      getBlocks: async () => ({
        units: [
          { text: '正文第一段。', kind: 'body', page: 1 },
          { text: 'E = mc^2', kind: 'formula', page: 1 },
          { text: 'Figure 1. An example figure.', kind: 'caption', page: 2 },
          { text: '正文第二段。', kind: 'body', page: 2 },
        ],
        via: 'reader',
        dropped: 5,
      }),
      locate: (p) => { located.push(p); return true; },
    });
    bl.payload.translateChunk = async (c, i) => {
      info.push(i || null);
      return '译[' + c + ']';
    };
    const w6 = boot(bl.payload);
    await waitFor(() => w6.win.ppBilingualSnapshot().busy === false);
    const snap = w6.win.ppBilingualSnapshot();

    eq(snap.done, 4, '13.1 四个单元全部完成');
    eq(snap.via, 'reader', '13.2 快照回报来源 reader');
    eq(snap.dropped, 5, '13.3 快照回报被滤行数');
    // 公式不送翻：translateChunk 只被调 3 次（body×2 + caption×1）
    eq(info.length, 3, '13.4 ★ 公式单元不送翻译（只翻了 3 段）');
    eq(info[0] && info[0].kind, 'body', '13.5 kind 信息随翻译回传（body）');
    eq(info[1] && info[1].kind, 'caption', '13.6 kind 信息随翻译回传（caption）');
    ok(info.every((x) => x && typeof x.title === 'string'), '13.7 上下文含文档标题');

    const grid6 = w6.registry.get('pp-bl-grid');
    const cells6 = grid6.children.filter((c) => c.id !== 'pp-bl-head-src' && c.id !== 'pp-bl-head-dst');
    eq(cells6.length, 8, '13.8 四单元 → 8 个单元格');
    // 公式行：右格 = 原文、class 带 formula
    has(cells6[2].textContent, 'E = mc^2', '13.9 公式原文直出');
    has(cells6[3].textContent, 'E = mc^2', '13.10 ★ 公式右格原样保留（未送翻）');
    ok(String(cells6[3].className).indexOf('formula') >= 0, '13.11 公式格带 formula 类');
    // 页码徽标：page>0 的单元原文格里有 .pp-bl-page，点击触发 locate
    const badges = cells6[0].byClass('pp-bl-page');
    eq(badges.length, 1, '13.12 带页码单元有页码徽标');
    badges[0].click();
    eq(JSON.stringify(located), '[1]', '13.13 ★ 点击徽标触发段落级定位（page=1）');
    const badges2 = cells6[4].byClass('pp-bl-page');
    badges2[0].click();
    eq(JSON.stringify(located), '[1,2]', '13.14 第二段徽标定位到 page=2');
    // caption 单元照常翻译
    eq(cells6[5].textContent, '译[Figure 1. An example figure.]', '13.15 图注照常翻译');
    ok(String(cells6[5].className).indexOf('caption') >= 0, '13.16 图注译文格带 caption 类');
    // 完成状态含被滤行数说明
    has(w6.registry.get('pp-bl-status').textContent, '已滤去', '13.17 状态行回报过滤数量');

    // 导出笔记：窗口把全部对（含 kind）交给 makeNote；公式对由模块侧 _noteMd 剔除
    w6.registry.get('pp-bl-note').click();
    await waitFor(() => bl.calls.notes.length === 1);
    const notePairs = bl.calls.notes[0];
    eq(notePairs.length, 4, '13.18 makeNote 收到全部 4 对（含公式，带 kind 标记）');
    ok(notePairs.some((p) => p.kind === 'formula'), '13.19 公式对带 kind=formula（供过滤）');
    eq(notePairs[2].kind, 'caption', '13.20 caption 对 kind 正确回传');
    // 模块侧 _noteMd 过滤公式对（笔记是「对照译文」，公式无译文可对照）
    {
      const BL_SRC = fs.readFileSync(path.join(ROOT, 'chrome/content/scripts/features/bilingual-translate.js'), 'utf8');
      const sb2 = { console, I18n: { isZh: true, t: (k) => k }, setTimeout, Promise, Math, Date, JSON };
      sb2.globalThis = sb2;
      vm.createContext(sb2);
      vm.runInContext(BL_SRC, sb2, { filename: 'bilingual-translate.js' });
      const md = sb2.BilingualTranslate._noteMd(notePairs, '中文');
      ok(md.indexOf('E = mc^2') < 0, '13.21 ★ _noteMd 剔除公式对（笔记中无公式）');
      ok(md.indexOf('正文第一段。') >= 0 && md.indexOf('译[正文第一段。]') >= 0,
        '13.22 正文对照对保留');
    }
  }

  /* ---- 14. getBlocks 缺失 / 抛异常 / 返回空 → 回落旧扁平路径 ---- */
  {
    const bl2 = makePayload(); // 无 getBlocks → 旧路径
    const w7 = boot(bl2.payload);
    await waitFor(() => w7.win.ppBilingualSnapshot().busy === false);
    eq(w7.win.ppBilingualSnapshot().via, '', '14.1 旧路径 via 为空');
    eq(w7.win.ppBilingualSnapshot().done, 3, '14.2 旧路径照常三段');
    eq(bl2.calls.full, 1, '14.3 旧路径仍走 getFullText');
  }
  {
    const bl3 = makePayload({ getBlocks: async () => { throw new Error('boom'); } });
    const w8 = boot(bl3.payload);
    await waitFor(() => w8.win.ppBilingualSnapshot().busy === false);
    eq(w8.win.ppBilingualSnapshot().done, 3, '14.4 getBlocks 抛异常 → 回落旧路径仍三段');
    eq(bl3.calls.full, 1, '14.5 异常后仍取到全文（不静默空白）');
  }
  {
    const bl4 = makePayload({ getBlocks: async () => null });
    const w9 = boot(bl4.payload);
    await waitFor(() => w9.win.ppBilingualSnapshot().busy === false);
    eq(w9.win.ppBilingualSnapshot().done, 3, '14.6 getBlocks 返回 null → 回落旧路径');
  }
  {
    const bl5 = makePayload({ getBlocks: async () => ({ units: [], dropped: 0 }) });
    const w10 = boot(bl5.payload);
    await waitFor(() => w10.win.ppBilingualSnapshot().busy === false);
    eq(w10.win.ppBilingualSnapshot().done, 3, '14.7 空单元数组 → 回落旧路径（不当空文档处理）');
  }

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项：');
    for (const f of fails) console.log('  ✗ ' + f);
  }
  console.log('双栏对照窗口：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.log('✗ 测试自身异常：' + (e && e.stack || e));
  process.exit(1);
});
