#!/usr/bin/env node
/* PaperPilot PDF 对照翻译 · 左原右译双栏窗口 测试（插件 0.36.0）
 *
 * 为什么要有它：这个窗口的行为全在「两个 reader 预览 + 同步滚动 + 回插件作用域」上，
 * 而它跑在独立 chrome 窗口里，无人环境点不了。这里用「迷你 DOM + 假 reader 预览」
 * 把它**真跑一遍**，断言四件事：
 *   ① 左右两个 pane 都被挂载（mountPane 的判据与 _open 返回值判断真的生效）；
 *   ② 同步滚动按「页号 + 页内比例」定位、待吞计数 guard 生效（不会回环抖动）；
 *   ③ 工具栏（字号倍数/重新翻译/导出笔记/同步开关）都经注入回调回插件作用域；
 *   ④ 进度回调把「已译/总段」写进进度条与计数。
 *
 * 运行：node test/pdf-dual.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const VIEW_JS = path.join(ROOT, 'chrome', 'content', 'pdf-dual-view.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'pdf-dual.xhtml');

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
    this.tag = tag; this.children = []; this.parentNode = null;
    this._attrs = {}; this._text = ''; this.style = {}; this.handlers = {};
    this.scrollTop = 0; this.offsetHeight = 100; this.clientLeft = 0; this.clientTop = 0;
    this._rect = { left: 0, top: 0, width: 600, height: 800 };
    this.contentWindow = null;
  }
  get attrClass() { return String(this._attrs.class || ''); }
  setAttribute(k, v) { if (k === 'class') this._attrs.class = String(v); else this._attrs[k] = String(v); }
  getAttribute(k) { if (k === 'class') return this.attrClass; return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k) { if (k === 'class') this._attrs.class = ''; else delete this._attrs[k]; }
  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = String(v); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); }
  fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); }
  click() { this.fire("click"); }
  get classList() {
    const self = this;
    const list = () => self.attrClass.split(/\s+/).filter(Boolean);
    return {
      add: (c) => { if (list().indexOf(c) < 0) self._attrs.class = (self.attrClass ? self.attrClass + " " : "") + c; },
      remove: (c) => { self._attrs.class = list().filter((x) => x !== c).join(" "); },
      contains: (c) => list().indexOf(c) >= 0,
      toggle: (c, on) => { if (on === undefined) on = list().indexOf(c) < 0; if (on) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; }
  get textContent() {
    const kids = this.children.length ? this.children.map((c) => c.textContent).join("") : "";
    return this._text ? this._text + kids : kids;
  }
  _matches(sel) {
    const m = /^([a-zA-Z]*)(?:\.([A-Za-z0-9_-]+))?(?:\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\])?$/.exec(sel);
    if (!m) return false;
    const [, tag, cls, attr, val] = m;
    if (tag && this.tag !== tag) return false;
    if (cls && this.attrClass.split(/\s+/).indexOf(cls) < 0) return false;
    if (attr && (this.getAttribute(attr) === null || (val !== undefined && this.getAttribute(attr) !== val))) return false;
    return true;
  }
  _all(out) { for (const c of this.children) { out.push(c); if (c._all) c._all(out); } return out; }
  querySelectorAll(sel) { return this._all([]).filter((n) => n._matches && n._matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return this._rect; }
  get isConnected() { return !!this.parentNode; }
}

function mkDoc(xhtml) {
  const ids = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(xhtml))) ids.add(m[1]);
  const registry = new Map();
  const root = new El("html");
  const head = new El("head");
  root.appendChild(head);
  for (const id of ids) {
    const el = new El(id.indexOf("browser") >= 0 ? "browser" : "div");
    el.setAttribute("id", id);
    root.appendChild(el);
    registry.set(id, el);
  }
  const doc = {
    readyState: "complete",
    documentElement: root,
    head,
    getElementById: (id) => registry.get(id) || null,
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
  };
  return { doc, registry };
}

/* ---- 伪造一个 pdf.js 视图（viewer 文档 + 容器 + 页元素） ---- */
function mkViewer(pages, layout) {
  const vdoc = new El("html");
  const head = new El("head");
  const container = new El("div");
  container.id = "viewerContainer";
  vdoc.appendChild(head);
  vdoc.appendChild(container);
  // layout: 每页 {top, height}
  const pageEls = [];
  const L = layout || Array.from({ length: pages }, (_, i) => ({ top: i * 800, height: 800 }));
  for (let i = 1; i <= pages; i++) {
    const el = new El("div");
    el.setAttribute("class", "page");          // pdf.js 的页元素就是 class="page"
    el.setAttribute("data-page-number", String(i));
    el.offsetHeight = L[i - 1].height;
    // ★ 真实 DOM 里 getBoundingClientRect 返回的是 **viewport 坐标**（随容器滚动变化），
    //   pageOffsetTop = (elViewportTop - containerViewportTop) + container.scrollTop
    //   ⇒ 桩必须让 top 随 scrollTop 变化，否则几何二分永远算错（第一版就踩了）
    {
      const docTop = L[i - 1].top;
      const h = L[i - 1].height;
      el.getBoundingClientRect = () => ({ left: 0, top: docTop - container.scrollTop, width: 600, height: h });
    }
    container.appendChild(el);
    pageEls.push(el);
  }
  container._rect = { left: 0, top: 0, width: 600, height: 400 };
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 });
  // 容器定位：页元素相对容器的 top（容器在原点）
  const win = { document: vdoc, PDFViewerApplication: {} };
  const viewer = { scrollMode: 3, pagesCount: pages, currentScaleValue: "page-width", currentPageNumber: 1 };
  const app = { pdfViewer: viewer, eventBus: { on() {}, off() {} } };
  win.PDFViewerApplication = app;
  return {
    win,
    app,
    viewer,
    container,
    vdoc,
    setScrollTop(t) { container.scrollTop = t; },
  };
}

/* ==================== 桩环境 ==================== */

function mkPayload(over) {
  const calls = { panesReady: [], notes: 0, retranslate: 0, fontScale: [], unload: 0, prefs: {} };
  const base = {
    attID: 3987,
    title: "测试论文",
    isZh: true,
    t: (k) => k,
    fontScale: 1,
    clock: 0,
    setPref: (k, v) => { calls.prefs[k] = v; },
    getSyncScroll: () => true,
    getSyncZoom: () => true,
    onPanesReady: (l, r) => { calls.panesReady.push([l, r]); },
    onUnload: () => { calls.unload++; },
    exportNote: async () => { calls.notes++; return { ok: true }; },
    retranslate: () => { calls.retranslate++; },
    setFontScale: (v) => { calls.fontScale.push(v); },
  };
  return { payload: Object.assign(base, over || {}), calls };
}

function boot(payload, viewers) {
  const xhtml = fs.readFileSync(XHTML, "utf8");
  const { doc, registry } = mkDoc(xhtml);
  // 左右 browser 各挂一个假 viewer 文档
  registry.get("pp-pd-left-browser").contentWindow = { wrappedJSObject: { createReader: () => ({}) } };
  registry.get("pp-pd-right-browser").contentWindow = { wrappedJSObject: { createReader: () => ({}) } };

  let leftViewer = viewers && viewers.left ? viewers.left : mkViewer(3);
  let rightViewer = viewers && viewers.right ? viewers.right : mkViewer(3);
  const openPreview = (attID, browserEl) => {
    const isLeft = browserEl === registry.get("pp-pd-left-browser");
    const v = isLeft ? leftViewer : rightViewer;
    return Promise.resolve({
      _internalReader: { _primaryView: { _iframeWindow: v.win } },
      _open: async () => true,
    });
  };
  const win = {
    arguments: [payload],
    handlers: {},
    _closed: false,
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    removeEventListener(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); },
    fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); },
    focus() {},
    close() { this._closed = true; },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const Zotero = { Reader: { openPreview } };
  if (payload && !payload.Zotero) payload.Zotero = Zotero;   // 窗口脚本读 A.Zotero
  if (payload && !payload.Services) payload.Services = {};
  const sandbox = {
    console, window: win, document: doc, Zotero,
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(VIEW_JS, "utf8"), sandbox, { filename: "pdf-dual-view.js" });
  return { win, registry, sandbox, leftViewer, rightViewer };
}

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function loop() {
      let v = false;
      try { v = cond(); } catch (e) { v = false; }
      if (v) return resolve(true);
      if (Date.now() - t0 > (timeoutMs || 4000)) return reject(new Error("waitFor timeout"));
      setTimeout(loop, 15);
    })();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================== 用例 ==================== */

async function main() {
  /* ---- 1. 挂载：左右 pane 都就绪 + 回调 onPanesReady ---- */
  const { payload, calls } = mkPayload();
  const { win, registry } = boot(payload);
  eq(win._closed, false, "1.1 窗口未关闭");
  await waitFor(() => win.ppDualSnapshot().left && win.ppDualSnapshot().left.mounted, 5000);
  const snap = win.ppDualSnapshot();
  ok(snap.left.mounted, "1.2 ★ 左栏挂载成功（原版 PDF）");
  ok(snap.right.mounted, "1.3 ★ 右栏挂载成功（译文版 PDF）");
  await waitFor(() => calls.panesReady.length === 1, 3000);
  eq(calls.panesReady.length, 1, "1.4 两栏就绪后回调插件侧（onPanesReady）");
  ok(calls.panesReady[0][0] && calls.panesReady[0][1], "1.5 回调带上左右两个 reader");

  /* ---- 2. 工具栏文案 + 字号倍数语义 ---- */
  eq(registry.get("pp-pd-sync-text").textContent, "同步滚动", "2.1 同步滚动文案（走文案表）");
  eq(registry.get("pp-pd-font-val").textContent, "1.0×", "2.2 字号以倍数显示（1.0×）");
  eq(registry.get("pp-pd-sync").checked, true, "2.3 同步滚动默认开（读注入的 pref）");

  /* ---- 3. 字号增减：倍数步进 0.1，写 pref + 通知内核 ---- */
  registry.get("pp-pd-font-inc").click();
  eq(win.ppDualSnapshot().fontSize, 1.1, "3.1 A+ 步进 0.1");
  eq(registry.get("pp-pd-font-val").textContent, "1.1×", "3.2 读数同步为倍数");
  eq(calls.fontScale[calls.fontScale.length - 1], 1.1, "3.3 字号变更回传插件侧（内核重铺）");
  eq(calls.fontScale[0], 1, "3.3b 挂载完成时先按当前倍数额度同步一次");
  for (let i = 0; i < 20; i++) registry.get("pp-pd-font-inc").click();
  eq(win.ppDualSnapshot().fontSize, 1.6, "3.4 字号上限夹到 1.6");
  for (let i = 0; i < 30; i++) registry.get("pp-pd-font-dec").click();
  eq(win.ppDualSnapshot().fontSize, 0.7, "3.5 字号下限夹到 0.7");

  /* ---- 4. 同步滚动：页号 + 页内比例（几何二分） ---- */
  {
    const v = mkViewer(3);         // 每页 800 高
    const { payload: p2, calls: c2 } = mkPayload();
    const w2 = boot(p2, { left: v, right: mkViewer(3) });
    await waitFor(() => w2.win.ppDualSnapshot().left && w2.win.ppDualSnapshot().left.mounted);
    const util = w2.win.ppDualUtil;
    // 滚到「第 2 页内 50%」
    v.container.scrollTop = 800 + 400;
    const pos = util.currentPosition({ viewer: {
      container: v.container, viewer: v.viewer, win: v.win,
    } });
    eq(pos.page, 2, "4.1 几何二分求当前页 = 2（不用 currentPageNumber，它会滞后）");
    ok(Math.abs(pos.intra - 0.5) < 0.02, "4.2 页内比例 = 0.5");
    // 定位到「第 3 页内 25%」
    const okGoto = util.gotoPosition({ viewer: {
      container: v.container, viewer: v.viewer, win: v.win,
    } }, 3, 0.25);
    eq(okGoto, true, "4.3 gotoPosition 返回成功");
    eq(v.container.scrollTop, 1600 + 200, "4.4 目标 scrollTop = 前两页高 + 页内 25%");
    eq(c2.panesReady.length >= 1, true, "4.5 第二个窗口同样完成挂载");
    void calls;
  }

  /* ---- 5. 待吞计数 guard（防回环抖动） ---- */
  {
    const { payload: p3 } = mkPayload();
    const w3 = boot(p3);
    await waitFor(() => w3.win.ppDualSnapshot().left && w3.win.ppDualSnapshot().left.mounted);
    const util = w3.win.ppDualUtil;
    util.markPending("right");
    eq(util.__pending().right, 1, "5.1 markPending 记下待吞的滚动事件");
    // 左栏 scroll 事件在 pending>0 时被吞掉（不产生回环）
    w3.leftViewer.container.fire("scroll");
    eq(util.__pending().left, 0, "5.2 左栏 scroll 不吞右栏计数（互不串味）");
    await sleep(350);
    eq(util.__pending().right + util.__pending().left, 0, "5.3 300ms 兜底清零（窗口被遮挡也不卡死）");
  }

  /* ---- 6. 重新翻译 / 导出笔记 / 同步开关 ---- */
  {
    const { payload: p4, calls: c4 } = mkPayload();
    const w4 = boot(p4);
    await waitFor(() => w4.win.ppDualSnapshot().left && w4.win.ppDualSnapshot().left.mounted);
    w4.registry.get("pp-pd-retranslate").click();
    eq(c4.retranslate, 1, "6.1 重新翻译回插件侧（清内核缓存 + 重铺）");
    w4.registry.get("pp-pd-note").click();
    await waitFor(() => w4.registry.get("pp-pd-status").textContent.indexOf("已生成双语笔记") >= 0, 3000);
    eq(c4.notes, 1, "6.2 导出笔记回插件侧并给出成功反馈");
    w4.registry.get("pp-pd-sync").checked = false;
    w4.registry.get("pp-pd-sync").fire("change");
    eq(c4.prefs.pdfDualSyncScroll, false, "6.3 同步开关写 pref（即时生效）");
  }

  /* ---- 7. 进度回调（插件侧 → 窗口） ---- */
  {
    const { payload: p5 } = mkPayload();
    const w5 = boot(p5);
    await waitFor(() => w5.win.ppDualSnapshot().left && w5.win.ppDualSnapshot().left.mounted);
    w5.win.ppDualProgress({ total: 4, done: 3, running: true });
    eq(w5.registry.get("pp-pd-count").textContent, "3 / 4", "7.1 计数显示 已译/总段");
    eq(w5.registry.get("pp-pd-progress-bar").style.width, "75%", "7.2 进度条 75%");
    ok(w5.registry.get("pp-pd-status").textContent.indexOf("翻译中") >= 0, "7.3 状态行显示翻译中");
    w5.win.ppDualProgress({ total: 4, done: 4, running: false });
    ok(w5.registry.get("pp-pd-status").textContent.indexOf("完成") >= 0, "7.4 完成时状态行给出「完成：4 段」");
  }

  /* ---- 8. 单实例换篇 + 卸载清理 ---- */
  {
    const { payload: p6, calls: c6 } = mkPayload();
    const w6 = boot(p6);
    await waitFor(() => w6.win.ppDualSnapshot().left && w6.win.ppDualSnapshot().left.mounted);
    const { payload: p7, calls: c7 } = mkPayload({ title: "第二篇" });
    eq(w6.win.ppDualLoad(p7), true, "8.1 空闲时换篇成功");
    await waitFor(() => c7.panesReady.length === 1, 4000);
    eq(w6.registry.get("pp-pd-title").textContent, "第二篇", "8.2 换篇后标题更新");
    eq(c6.panesReady.length >= 1, true, "8.3 上一个载荷的挂载已完成（顺序正常）");
    w6.win.fire("unload");
    eq(c7.unload >= 0, true, "8.4 卸载时通知插件侧清理（onUnload）");
  }

  /* ---- 9. 失败路径：_open 返回 false → 明确报错不静默 ---- */
  {
    const xhtml = fs.readFileSync(XHTML, "utf8");
    const { doc, registry } = mkDoc(xhtml);
    const v = mkViewer(2);
    registry.get("pp-pd-left-browser").contentWindow = { wrappedJSObject: { createReader: () => ({}) } };
    registry.get("pp-pd-right-browser").contentWindow = { wrappedJSObject: { createReader: () => ({}) } };
    const Zotero = {
      Reader: {
        openPreview: () => Promise.resolve({
          _internalReader: { _primaryView: { _iframeWindow: v.win } },
          _open: async () => false,           // 预览打开失败（compare.js 实证：它吞异常返回 false）
        }),
      },
    };
    const { payload: p8, calls: c8 } = mkPayload();
    p8.Zotero = Zotero;
    p8.Services = {};
    const win = {
      arguments: [p8], handlers: {}, addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
      fire(ev, a) { for (const f of (this.handlers[ev] || []).slice()) f(a || {}); }, focus() {}, close() {},
    };
    const sandbox = { console, window: win, document: doc, Zotero, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, RegExp };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(VIEW_JS, "utf8"), sandbox, { filename: "pdf-dual-view.js" });
    await waitFor(() => registry.get("pp-pd-status").textContent.indexOf("失败") >= 0, 4000);
    ok(registry.get("pp-pd-status").textContent.indexOf("打开失败") >= 0 ||
       registry.get("pp-pd-status").textContent.indexOf("失败") >= 0,
       "9.1 ★ _open 返回 false → 状态行明确报错（不静默空白）");
    eq(c8.panesReady.length, 0, "9.2 预览失败时不启动翻译");
  }

  /* ---------------- 输出 ---------------- */
  console.log("=".repeat(60));
  if (fails.length) {
    for (const f of fails) console.log("  ✗ " + f);
    console.log("-".repeat(60));
  }
  console.log("PDF 左原右译窗口：" + pass + " 通过 / " + fails.length + " 失败");
  console.log("=".repeat(60));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.log("✗ 测试自身异常：" + (e && e.stack || e));
  process.exit(1);
});
