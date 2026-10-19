// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 多篇 PDF 并排对比 · 窗口逻辑（0.21.0）
 *
 * 结构：
 *   stage（position:relative）里放 N 个 .pp-cmp-pane（position:absolute，百分比定位）
 *   每个 pane = [面板头 hbox] + [<browser type=content> 内嵌 Zotero 阅读器预览]
 *
 * 关键约束与实证结论（写在这里免得后人重复踩）：
 *   1) 挂预览前必须等 <browser> 的 contentDocument.readyState 到 interactive/complete
 *      ——contentWindow 在 DOMContentLoaded 之前就存在，提前 createReader 会炸
 *      （官方 attachmentPreview.js 的同名注释就是这条坑）。
 *   2) Zotero.Reader.openPreview() 只负责构造 ReaderPreview，真正加载要自己
 *      `await reader._open({})`（官方调用序：openPreview → _open）。
 *   3) ReaderPreview 注入的 CSS 把 #viewerContainer 设成 overflow:hidden（悬停预览
 *      只要第一屏）。并排对比必须滚动，故再注入一条 !important 把它还原成 auto。
 *   4) 预览恒只读（ReaderPreview._isReadOnly() 返回 true）且 textLayerMode=0
 *      （不可划词）。面板内不提供新增标注，用「在阅读器中打开」跳正式阅读器。
 *   5) 同步滚动走容器 scrollTop/scrollHeight 的百分比映射；同步缩放走 pdf.js
 *      eventBus 的 scalechanging。两条都要防回环（suppress 标志 + 下一帧/延时释放）。
 */
(function () {
  "use strict";

  const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const args = (window.arguments && window.arguments[0]) || {};
  const Zotero = args.Zotero;
  const T = typeof args.t === "function" ? args.t : (k) => k;
  const MAX = Number(args.maxPanes) || 4;

  const panes = [];        // 面板记录
  let layout = (args.prefs && args.prefs.layout) || "auto";
  // 排障追踪：仅在自检开关打开时记录（PdfCompare 传 trace）
  const TRACE = !!args.trace;
  const traceLog = [];
  const traceT0 = Date.now();
  function trace(msg) {
    if (!TRACE) return;
    if (traceLog.length < 90) traceLog.push((Date.now() - traceT0) + "ms " + msg);
  }
  // 默认「各滚各的」（0.21.2 起）：对比场景下两篇的页码/进度本就不一致，
  // 强制联动反而碍事；需要跟读时在工具栏勾「同步滚动」。
  let syncScroll = !!(args.prefs && args.prefs.syncScroll === true);
  let syncZoom = !!(args.prefs && args.prefs.syncZoom);
  let activeIdx = -1;
  let zoomGuard = false;
  let lastResult = "";     // 结果条当前内容（复制按钮用）

  /* ---------------- DOM 小工具 ---------------- */

  function xul(tag, attrs, style) {
    const el = document.createElementNS(XUL_NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (style) el.style.cssText = style;
    return el;
  }

  function html(tag, style, text) {
    const el = document.createElementNS(HTML_NS, tag);
    if (style) el.style.cssText = style;
    if (text != null) el.textContent = text;
    return el;
  }

  const $ = (id) => document.getElementById(id);
  const stage = () => $("pp-cmp-stage");

  function setStatus(msg) {
    try { $("pp-cmp-status").textContent = msg || ""; } catch (e) { /* ignore */ }
  }

  /* ---------------- 面板构建 ---------------- */

  function paneTitle(rec) {
    return rec.title || T("compareUnnamed");
  }

  function addPane(pdf) {
    if (panes.length >= MAX) {
      setStatus(T("compareLimitReached").replace("%n", String(MAX)));
      return false;
    }
    if (panes.some((p) => p.attID === pdf.id)) {
      setStatus(T("compareDuplicated"));
      return false;
    }

    const wrapper = xul("vbox", { class: "pp-cmp-pane" },
      "position:absolute;box-sizing:border-box;padding:2px;" +
      "display:flex;flex-direction:column;min-width:0;min-height:0;");

    const header = xul("hbox", { align: "center" },
      "flex:0 0 auto;gap:6px;padding:2px 6px;" +
      "background:var(--material-toolbar,#f2f2f2);" +
      "border:1px solid var(--material-border,#ccc);border-bottom:none;" +
      "border-radius:5px 5px 0 0;");

    const idxBadge = html("span",
      "flex:0 0 auto;font-size:10.5px;font-weight:700;color:var(--fill-secondary,#666);",
      "#" + (panes.length + 1));
    const titleEl = html("div",
      "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font-size:11.5px;color:var(--fill-primary,#222);", "");

    // 页码导航：◀ [输入框] / 总数 ▶（跳页只看滚动条太笨）
    const prevBtn = html("button", "flex:0 0 auto;font-size:10px;padding:0 5px;line-height:1.4;");
    prevBtn.textContent = "◀";
    prevBtn.title = T("comparePrevPage");
    const pageInput = html("input",
      "flex:0 0 auto;width:38px;font-size:11px;padding:0 2px;text-align:center;");
    pageInput.type = "text";
    pageInput.title = T("compareJumpPageHint");
    const pageTotal = html("span",
      "flex:0 0 auto;font-size:11px;color:var(--fill-secondary,#666);white-space:nowrap;", "/ –");
    const nextBtn = html("button", "flex:0 0 auto;font-size:10px;padding:0 5px;line-height:1.4;");
    nextBtn.textContent = "▶";
    nextBtn.title = T("compareNextPage");

    const openBtn = html("button",
      "flex:0 0 auto;font-size:11px;padding:0 7px;");
    openBtn.textContent = T("compareOpenInReader");
    openBtn.title = T("compareOpenInReaderHint");

    const closeBtn = html("button",
      "flex:0 0 auto;font-size:11px;padding:0 6px;");
    closeBtn.textContent = "✕";
    closeBtn.title = T("compareRemove");

    header.appendChild(idxBadge);
    header.appendChild(titleEl);
    header.appendChild(prevBtn);
    header.appendChild(pageInput);
    header.appendChild(pageTotal);
    header.appendChild(nextBtn);
    header.appendChild(openBtn);
    header.appendChild(closeBtn);

    const browser = xul("browser", {
      type: "content",
      primary: "true",
      transparent: "transparent",
      tooltip: "iframeTooltip",
      src: "resource://zotero/reader/reader.html",
      flex: "1",
    }, "min-width:0;min-height:0;" +
       "border:1px solid var(--material-border,#ccc);border-radius:0 0 5px 5px;");

    wrapper.appendChild(header);
    wrapper.appendChild(browser);

    const rec = {
      attID: pdf.id,
      title: pdf.title || "",
      wrapper, header, browser, titleEl, openBtn, closeBtn,
      pageInput, pageTotal, prevBtn, nextBtn, pageEl: pageInput,
      reader: null, viewer: null, loaded: false,
      curPage: 1, curIntra: 0, pagesCount: 0, userScaleValue: null,
    };
    panes.push(rec);

    titleEl.textContent = paneTitle(rec);
    pageInput.value = "1";
    pageInput.disabled = true;

    // 点面板任意处置为「当前面板」（焦点面板）——非同步缩放/翻页只作用于它
    wrapper.addEventListener("mousedown", () => { setActive(rec); }, true);
    wrapper.addEventListener("focusin", () => { setActive(rec); }, true);

    openBtn.addEventListener("click", () => {
      try { Zotero.Reader.open(rec.attID); } catch (e) { /* ignore */ }
    });
    closeBtn.addEventListener("click", () => removePane(rec));
    prevBtn.addEventListener("click", () => stepPage(rec, -1));
    nextBtn.addEventListener("click", () => stepPage(rec, +1));
    const doJump = () => {
      const n = parseInt(String(pageInput.value).replace(/[^\d]/g, ""), 10);
      if (n >= 1) gotoPage(rec, n);
    };
    pageInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); doJump(); }
    });
    pageInput.addEventListener("blur", () => { syncPageUi(rec); });

    stage().appendChild(wrapper);
    applyLayout();
    updateCount();
    loadPane(rec);
    return true;
  }

  function setActive(rec) {
    const i = panes.indexOf(rec);
    if (i < 0 || i === activeIdx) return;
    activeIdx = i;
    for (const p of panes) {
      if (p === rec) {
        p.wrapper.style.boxShadow = "0 0 0 2px var(--color-accent,#0a84ff) inset";
      } else {
        p.wrapper.style.boxShadow = "";
      }
    }
  }

  function removePane(rec) {
    const i = panes.indexOf(rec);
    if (i < 0) return;
    try { if (rec._ro) rec._ro.disconnect(); } catch (e) { /* ignore */ }
    for (const k of ["_ensureTimerA", "_ensureTimer", "_ensureTimer2"]) {
      try { if (rec[k]) clearTimeout(rec[k]); } catch (e) { /* ignore */ }
    }
    try { if (rec.reader && rec.reader.uninit) rec.reader.uninit(); } catch (e) { /* ignore */ }
    try { rec.wrapper.remove(); } catch (e) { /* ignore */ }
    panes.splice(i, 1);
    if (activeIdx >= panes.length) activeIdx = panes.length - 1;
    applyLayout();
    updateCount();
  }

  function updateCount() {
    try {
      $("pp-cmp-count").textContent =
        T("compareCount").replace("%n", String(panes.length)).replace("%m", String(MAX));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 加载单个预览 ---------------- */

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 等 <browser> 把 reader.html 真正跑起来。
   *  ⚠️ 只看 readyState 是不够的：新建 <browser> 的 about:blank 立刻就是
   *  "complete"，判定会过早通过；此时 reader.html 的 window.createReader 还没定义，
   *  而 ReaderPreview._open 内部把 createReader 的 TypeError 整个 try/catch 吞掉、
   *  只返回 false —— 面板于是空白且毫无报错（本功能第一次自检就是这么翻车的）。
   *  所以必须等到 createReader 真的可调用为止。 */
  async function waitBrowserReady(browser, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    for (;;) {
      try {
        const w = browser.contentWindow;
        if (w) {
          let uw = null;
          try { uw = w.wrappedJSObject || w; } catch (e) { /* 跨隔间未就绪 */ }
          if (uw && typeof uw.createReader === "function") return true;
        }
      } catch (e) { /* docShell 还没挂上 */ }
      if (Date.now() > deadline) return false;
      await delay(40);
    }
  }

  /** 从 ReaderPreview 里挖出 pdf.js 视图（_primaryView 是 pdf.js 的 PDFView 包装） */
  function resolveViewer(rec) {
    const pick = (w) => {
      if (!w) return null;
      let uw = w;
      try { uw = w.wrappedJSObject || w; } catch (e) { /* 普通窗口 */ }
      const app = uw.PDFViewerApplication;
      if (!app || !app.pdfViewer) return null;
      let container = null;
      try { container = uw.document.getElementById("viewerContainer"); } catch (e) { /* ignore */ }
      return { win: uw, app, viewer: app.pdfViewer, container };
    };

    try {
      const ir = rec.reader && rec.reader._internalReader;
      const pv = ir && ir._primaryView;
      let hit = pick(pv && pv._iframeWindow);
      if (hit) return hit;
      // 兜底：扫 reader.html 里的 iframe 找 pdf.js 全局
      const rw = rec.reader && rec.reader._iframeWindow;
      if (rw && rw.document) {
        for (const f of rw.document.querySelectorAll("iframe")) {
          hit = pick(f.contentWindow);
          if (hit) return hit;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---------------- 可滚动性（0.21.1 核心修正） ----------------
   * 实测（Zotero 9.0.6 + 本功能自检）：
   *   预览打开后 pdf.js 的 `scrollMode` 是 **3 = PAGE（单页模式）**，DOM 里只有
   *   1 个 .page，`#viewerContainer` 的 scrollHeight≈clientHeight（20 页文档也只有
   *   7px 滚动范围）——用户看到的就是「PDF 页面无法滚动」。
   *   把 `scrollMode` 置回 **0 = VERTICAL（连续垂直）** 后，全部页参与布局，
   *   滚动范围立刻变成正常值（实测 20 页 → scrollHeight 8242 / clientHeight 407）。
   *   该赋值不会被阅读器改回去（实测 600ms 后仍为 0）。
   * 所以这里做两件事：① 强制连续垂直；② 注入 CSS 解禁 overflow（ReaderPreview
   * 把 #viewerContainer 设成 overflow:hidden，那是悬停预览「只看第一屏」的取舍）。
   */

  /** 注入/刷新面板内的可滚动样式（幂等且廉价：内容不变则不写 DOM） */
  const VIEWER_CSS =
    // overflow 简写 = 两轴 auto：竖向可滚，放大后横向也可滚（内容不会被裁掉）
    "#viewerContainer{overflow:auto !important;" +
    // 到边界不把滚动传给外层（对比窗口/另一面板），保证各面板互不干扰
    "overscroll-behavior:contain !important;" +
    // 显式允许触摸平移，触摸屏/触控板双指都能滚
    "touch-action:pan-x pan-y !important;}" +
    ".pdfViewer .page{border-radius:4px !important;}";

  function unclampViewer(v) {
    try {
      const d = v.win.document;
      let s = d.getElementById("pp-cmp-viewer-style");
      if (!s) {
        s = d.createElement("style");
        s.id = "pp-cmp-viewer-style";
        (d.head || d.documentElement).appendChild(s);
      }
      if (s.textContent !== VIEWER_CSS) s.textContent = VIEWER_CSS;
    } catch (e) { /* ignore */ }
  }

  /** 确保面板可正常滚动：连续垂直模式 + 解禁 overflow。
   *  缩放/窗口尺寸变化都会重建页面布局，故每次都要再确认一次。 */
  function ensureScrollable(rec) {
    const v = rec && rec.viewer;
    if (!v) return;
    let before = -1, after = -1;
    try {
      before = v.viewer.scrollMode;
      // 0 = pdf.js ScrollMode.VERTICAL；已是目标值时为 no-op（内部 setter 会自行短路）
      if (v.viewer.scrollMode !== 0) v.viewer.scrollMode = 0;
      after = v.viewer.scrollMode;
    } catch (e) { /* ignore */ }
    unclampViewer(v);
    // 阅读器在尺寸变化时会把 scale 打回 page-height：用户手动设过的固定缩放要还原
    if (rec.userScaleValue) {
      try {
        if (String(v.viewer.currentScaleValue) !== rec.userScaleValue) {
          v.viewer.currentScaleValue = rec.userScaleValue;
        }
      } catch (e) { /* ignore */ }
    }
    if (TRACE && (before !== after || before !== 0)) {
      trace("ensureScrollable #" + (panes.indexOf(rec) + 1) + " scrollMode " + before + "->" + after +
        " pageEls=" + pagesIn(rec) + " scale=" + scaleOf(rec));
    }
  }

  function pagesIn(rec) {
    try { return rec.viewer.win.document.querySelectorAll(".page").length; } catch (e) { return -1; }
  }
  function scaleOf(rec) {
    try { return String(rec.viewer.viewer.currentScaleValue).slice(0, 10); } catch (e) { return "?"; }
  }

  /**
   * 延迟兜底（0.21.3 关键修复）：
   * 用户报「第一次打开能滚，全屏后滚不动」。实测最大化后
   * `scrollMode` 0→3、`.page` 20→1、`maxScroll` 9435→7、scale 被打回 page-height
   * ——**阅读器在窗口尺寸变化时会重套自己的视图状态**，而原来的三处兜底
   * （pagesloaded／缩放后／开窗 800ms）都不覆盖 resize。
   * 这里做两次延迟确认：300ms 抓住即时重套，1200ms 抓住滞后重套。
   */
  function scheduleEnsure(rec) {
    try {
      if (TRACE) {
        trace("scheduleEnsure #" + (panes.indexOf(rec) + 1) + " (sm=" +
          (rec.viewer ? rec.viewer.viewer.scrollMode : "-") + ")");
      }// 三个时间点各试一次：120ms 抓「打回得早」的情况，400ms 抓常规，
      // 1200ms 抓滞后重套。实测最大化后阅读器在 ~300ms 内完成重套，
      // 120ms 这一拍常是 no-op，真正生效的是 400ms 那拍，故恢复 <700ms。
      for (const [key, ms] of [["_ensureTimerA", 120], ["_ensureTimer", 400], ["_ensureTimer2", 1200]]) {
        if (rec[key]) clearTimeout(rec[key]);
        rec[key] = setTimeout(() => { rec[key] = null; ensureScrollable(rec); }, ms);
      }
    } catch (e) { /* ignore */ }
  }

  function hookViewer(rec, v) {
    ensureScrollable(rec);
    try {
      if (v.container) {
        rec._onScroll = () => onPaneScroll(rec);
        v.container.addEventListener("scroll", rec._onScroll, { passive: true });
      }
    } catch (e) { /* ignore */ }
    try {
      v.app.eventBus.on("updateviewarea", (ev) => {
        try {
          const loc = (ev && ev.location) || {};
          rec.pagesCount = v.viewer.pagesCount || 0;
          rec.curPage = loc.pageNumber || 1;
          rec.curIntra = intraPageFraction(rec);
          syncPageUi(rec);
        } catch (e) { /* ignore */ }
      });      v.app.eventBus.on("scalechanging", () => onPaneScale(rec));
      // 文档页布局完成后（首次 + 缩放后）再确认一次连续滚动
      v.app.eventBus.on("pagesloaded", () => scheduleEnsure(rec));
      // ★ 被外力改回单页模式（resize 时阅读器重套状态）时立刻拉回，
      //   事件驱动、无轮询；我们把它设回 0 时 mode===0 会提前返回，不会自激。
      v.app.eventBus.on("scrollmodechanged", (ev) => {
        const m = ev && ev.mode;
        trace("scrollmodechanged mode=" + m);
        if (m === 0 || m === undefined) return;
        scheduleEnsure(rec);
      });
      rec._scaleEvtHooked = true;
      trace("eventBus hooks #" + (panes.indexOf(rec) + 1));
    } catch (e) { /* eventBus 缺失时同步缩放降级为仅工具栏按钮生效 */ trace("eventBus hook ERR " + (e && e.message)); }
    // 尺寸变化兜底：面板盒子或整个窗口变化都覆盖（最大化/还原/拖拽/切布局）
    try {
      const RO = window.ResizeObserver || ResizeObserver;
      if (RO) {
        rec._ro = new RO(() => { trace("ResizeObserver #" + (panes.indexOf(rec) + 1)); scheduleEnsure(rec); });
        rec._ro.observe(rec.browser);
        trace("ResizeObserver observed #" + (panes.indexOf(rec) + 1));
      } else trace("no ResizeObserver");
    } catch (e) { trace("RO ERR " + (e && e.message)); }
    try {
      v.win.addEventListener("resize", () => { trace("viewer resize #" + (panes.indexOf(rec) + 1)); scheduleEnsure(rec); });
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 页码：几何 / 导航 / 跟随 ---------------- */

  /** 某个页元素相对滚动容器内容顶部的偏移（跨隔间用 rect 差值，最稳） */
  function pageOffsetTop(pageEl, container) {
    try {
      return (pageEl.getBoundingClientRect().top - container.getBoundingClientRect().top) + container.scrollTop;
    } catch (e) { return null; }
  }

  function pageElByNumber(rec, n) {
    try {
      return rec.viewer.win.document.querySelector('.page[data-page-number="' + n + '"]');
    } catch (e) { return null; }
  }

  /** 当前阅读位置：顶页页码 + 页内比例（0~1）。
   *  ⚠️ 不能用 `pdfViewer.currentPageNumber`：它由 pdf.js 自己的 scroll 处理器更新，
   *  轮到我们时可能还是旧值（程序化滚动 / 事件排队时实测滞后，会把对齐算到错的页）。
   *  这里改成**几何二分**求「最后一个顶边 ≤ scrollTop 的页」——页偏移随页码单调递增，
   *  永远拿到即时值，且是 O(log n)，千页文档也不卡。 */
  function currentPosition(rec) {
    const v = rec && rec.viewer;
    if (!v || !v.container) return null;
    const total = rec.pagesCount || 0;
    const st = v.container.scrollTop;
    const at = (n) => {
      const el = pageElByNumber(rec, n);
      if (!el) return null;
      const top = pageOffsetTop(el, v.container);
      if (top === null) return null;
      return { el, top, h: el.offsetHeight || 1 };
    };
    let page = 0;
    let info = null;
    if (total > 0) {
      let lo = 1, hi = total, bestN = 0, bestI = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const cur = at(mid);
        if (!cur) break;               // 页元素还没布局出来：放弃二分，退回 hint
        if (cur.top <= st) { bestN = mid; bestI = cur; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (bestN) { page = bestN; info = bestI; }
    }
    if (!page) { page = rec.curPage || 1; info = at(page); }
    const intra = info ? Math.min(1, Math.max(0, (st - info.top) / info.h)) : 0;
    return { page, intra };
  }

  /** 当前页内滚动了多少（0~1） */
  function intraPageFraction(rec) {
    const pos = currentPosition(rec);
    return pos ? pos.intra : 0;
  }

  /** 滚到指定页 + 页内比例（0~1）；页码越界自动收敛到该面板的合法范围 */
  function gotoPage(rec, n, intra) {
    const v = rec && rec.viewer;
    if (!v || !v.container) return false;
    const total = rec.pagesCount || v.viewer.pagesCount || 0;
    if (!total) return false;
    let want = Math.round(n);
    if (!isFinite(want)) return false;
    want = Math.min(total, Math.max(1, want));
    const el = pageElByNumber(rec, want);
    if (!el) {
      // 页元素还没布局出来（懒加载）：退回 pdf.js 的页码接口
      try { v.viewer.currentPageNumber = want; } catch (e) { /* ignore */ }
      return false;
    }
    const top = pageOffsetTop(el, v.container);
    if (top === null) return false;
    const target = Math.max(0, Math.round(top + (Number(intra) || 0) * (el.offsetHeight || 0)));
    if (Math.abs(v.container.scrollTop - target) < 1) return true;
    markSkip(rec);
    v.container.scrollTop = target;
    // pdf.js 的 currentPageNumber 会随滚动自行更新，无需手动写
    rec.curPage = want;
    syncPageUi(rec);
    return true;
  }

  function stepPage(rec, delta) {
    if (!rec.viewer) { setStatus(T("compareNotReady")); return; }
    gotoPage(rec, (rec.curPage || 1) + delta, 0);
    setActive(rec);
  }

  /** 页码 UI 与实际状态对齐（输入框在用户编辑时不覆盖） */
  function syncPageUi(rec) {
    try {
      if (!rec.pageInput) return;
      const total = rec.pagesCount || 0;
      if (document.activeElement !== rec.pageInput) rec.pageInput.value = String(rec.curPage || 1);
      rec.pageInput.disabled = !total;
      rec.pageTotal.textContent = "/ " + (total || "–");
      if (rec.prevBtn) rec.prevBtn.disabled = (rec.curPage || 1) <= 1;
      if (rec.nextBtn) rec.nextBtn.disabled = total > 0 && (rec.curPage || 1) >= total;
    } catch (e) { /* ignore */ }
  }

  /** 「对齐到当前页」：所有面板跳到当前聚焦面板的页码（+同样的页内位置） */
  function alignToActive() {
    const src = panes[activeIdx >= 0 ? activeIdx : 0];
    if (!src || !src.viewer) { setStatus(T("compareNotReady")); return; }
    const page = src.curPage || 1;
    const intra = intraPageFraction(src);
    let n = 0;
    for (const p of panes) {
      if (p === src || !p.viewer) continue;
      if (gotoPage(p, page, intra)) n++;
    }
    setStatus(T("compareAligned").replace("%n", String(page)).replace("%c", String(n)));
  }

  /* ---------------- 页面文本（补偿预览无文本层） ---------------- */

  /** 把参数克隆到 pdf.js 所在隔间。
   *  `getPageData` 内部会把参数结构化克隆给 worker；从 chrome 隔间直接传普通对象
   *  会报 "The object could not be cloned."（实测踩过），必须 cloneInto 过去。 */
  function contentArg(obj, win, dbg) {
    const Cu = (typeof Components !== "undefined" && Components && Components.utils) || null;
    if (!Cu || !Cu.cloneInto) { if (dbg) dbg.argHow = "raw(no Cu)"; return obj; }
    const scopes = [];
    try { if (win && win.wrappedJSObject) scopes.push(win.wrappedJSObject); } catch (e) { /* ignore */ }
    try { if (win) scopes.push(win); } catch (e) { /* ignore */ }
    for (const s of scopes) {
      try {
        const a = Cu.cloneInto(obj, s);
        if (dbg) dbg.argHow = "cloneInto";
        return a;
      } catch (e) {
        if (dbg && !dbg.cloneErr) dbg.cloneErr = String(e && e.message);
      }
    }
    if (dbg) dbg.argHow = "raw(fallback)";
    return obj;
  }

  /** 取某页文本。预览没有文本层（textLayerMode=0，不能划词/复制/搜索），
   *  这是硬约束下唯一能拿回文字的口子。走 Zotero 给 pdf.js 打的补丁接口
   *  `pdfDocument.getPageData({pageIndex})` → `{ chars }`（阅读器朗读功能同款），
   *  字符对象字段：`c` / `ignorable` / `spaceAfter` / `lineBreakAfter` / `paragraphBreakAfter`。
   *  实测标准 `getTextContent` 在本机是 undefined（Xray 包裹），故仅作兜底。 */
  async function pageText(rec, pageNo, dbg) {
    const app = rec && rec.viewer && rec.viewer.app;
    const win = rec && rec.viewer && rec.viewer.win;
    if (dbg) {
      dbg.hasApp = !!app;
      try { dbg.hasPdfDoc = !!(app && app.pdfDocument); } catch (e) { dbg.hasPdfDoc = "ERR"; }
      try { dbg.getPageDataType = app && app.pdfDocument && typeof app.pdfDocument.getPageData; } catch (e) { dbg.getPageDataType = "ERR:" + e.message; }
    }
    if (!app || !app.pdfDocument) return "";
    const total = rec.pagesCount || app.pdfViewer.pagesCount || 0;
    const n = Math.min(total || 1, Math.max(1, Math.round(pageNo || 1)));
    if (dbg) dbg.pageNo = n;

    try {
      if (typeof app.pdfDocument.getPageData === "function") {
        const arg = contentArg({ pageIndex: n - 1 }, win, dbg);
        const data = await app.pdfDocument.getPageData(arg);
        if (dbg) {
          try { dbg.dataKeys = data ? Object.getOwnPropertyNames(data).slice(0, 12) : null; } catch (e) { dbg.dataKeys = "ERR"; }
        }
        const chars = data && data.chars;
        if (dbg) { try { dbg.charsLen = chars ? chars.length : -1; } catch (e) { dbg.charsLen = "ERR"; } }
        if (dbg && chars && chars.length) {
          try { dbg.charSample = JSON.stringify(chars[0]).slice(0, 120); } catch (e) { dbg.charSample = "ERR"; }
        }
        if (chars && chars.length) {
          let out = "";
          for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            if (!ch || ch.ignorable || !ch.c) continue;
            out += ch.c;
            if (ch.paragraphBreakAfter || ch.lineBreakAfter) out += "\n";
            else if (ch.spaceAfter) out += " ";
          }
          const cleaned = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]{2,}/g, " ").trim();
          if (cleaned) return cleaned;
        }
      }
    } catch (e) { if (dbg) dbg.getPageDataErr = String(e && e.message); trace("getPageData ERR " + (e && e.message)); }

    // 兜底：标准 pdf.js 文本层接口
    const page = await app.pdfDocument.getPage(n);
    if (typeof page.getTextContent !== "function") {
      if (dbg) dbg.pageGetTextContentType = typeof page.getTextContent;
      return "";
    }
    const tc = await page.getTextContent();
    let out = "";
    for (const it of tc.items) {
      if (it.str) out += it.str;
      if (it.hasEOL) out += "\n";
    }
    return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function loadPane(rec) {
    setPaneMessage(rec, T("compareLoading"));
    const ok = await waitBrowserReady(rec.browser);
    if (!ok) { setPaneMessage(rec, T("compareLoadFailed") + "reader.html 未就绪"); return; }
    try {
      rec.reader = await Zotero.Reader.openPreview(rec.attID, rec.browser);
      // ReaderPreview._open 内部 try/catch 会吞异常并 return false —— 必须看返回值，
      // 否则失败与成功无法区分，用户只会看到一块空白面板。
      const opened = await rec.reader._open({});
      if (opened === false || !rec.reader._internalReader) {
        setPaneMessage(rec, T("compareViewUnavailable"));
        return;
      }
      rec.loaded = true;
      const v = resolveViewer(rec);
      if (v) {
        rec.viewer = v;
        hookViewer(rec, v);
        setPaneMessage(rec, "");
        // 阅读器可能在文档就绪后再套一次自己的视图状态：延迟一拍再确认，
        // 防止「打开时能滚、过一会儿又不能滚」。
        setTimeout(() => ensureScrollable(rec), 800);
      } else {
        setPaneMessage(rec, T("compareViewUnavailable"));
      }
    } catch (e) {
      setPaneMessage(rec, T("compareLoadFailed") + " " + shortErr(e));
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
    }
  }

  function shortErr(e) {
    const m = String((e && e.message) || e || "");
    return m.length > 120 ? m.slice(0, 120) + "…" : m;
  }

  function setPaneMessage(rec, msg) {
    try {
      if (!msg) {
        if (rec._msgEl) { rec._msgEl.remove(); rec._msgEl = null; }
        rec.browser.style.visibility = "";
        return;
      }
      rec.browser.style.visibility = "hidden";
      if (!rec._msgEl) {
        const el = html("div",
          "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
          "padding:14px;text-align:center;font-size:12px;" +
          "color:var(--fill-secondary,#666);pointer-events:none;");
        rec._msgEl = el;
        rec.wrapper.appendChild(el);
      }
      rec._msgEl.textContent = msg;
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 布局 ---------------- */

  function applyLayout() {
    const n = panes.length;
    if (!n) return;
    let mode = layout;
    if (mode === "auto") mode = n <= 3 ? "h" : "grid";
    if (mode === "grid" && n <= 3) mode = "h";

    panes.forEach((p, i) => {
      const st = p.wrapper.style;
      if (mode === "v") {
        st.left = "0%"; st.top = (i * 100 / n) + "%";
        st.width = "100%"; st.height = (100 / n) + "%";
      } else if (mode === "grid") {
        const c = i % 2, r = Math.floor(i / 2);
        st.left = (c * 50) + "%"; st.top = (r * 50) + "%";
        st.width = "50%"; st.height = "50%";
      } else { // h
        st.left = (i * 100 / n) + "%"; st.top = "0%";
        st.width = (100 / n) + "%"; st.height = "100%";
      }
    });
  }

  /* ---------------- 同步滚动 ----------------
   * 对齐方式（0.21.3 起）：**按「页码 + 页内比例」**，而不是整体滚动百分比。
   *   百分比映射在页数差得多时完全错位（20 页 vs 6 页，第 3 页会对到别人第 1 页）；
   *   按页码对齐才是「对比同一篇论文的两个版本」时用户期望的行为。
   *   只有在拿不到页几何信息时才回落为百分比映射。
   * 回声抑制：程序化滚动会打出「自己触发自己」的 scroll 事件，必须只吞掉这些回声。
   *   旧实现用布尔 guard + rAF 释放——窗口被遮挡/最小化时 rAF 不触发，guard 会永久
   *   卡住，之后所有同步静默失效。改成「每个滚动容器一个待吞计数」，不依赖帧回调；
   *   再加 300ms 兜底清零，防止「赋的值没变→没有 scroll 事件」导致计数泄漏。 */

  function ratio(cur, total, view) {
    const max = Math.max(0, total - view);
    return max > 0 ? Math.min(1, Math.max(0, cur / max)) : 0;
  }

  function markSkip(rec) {
    const c = rec.viewer && rec.viewer.container;
    if (!c) return;
    c.__ppSkip = (c.__ppSkip || 0) + 1;
    if (!c.__ppSkipTimer) {
      c.__ppSkipTimer = setTimeout(() => { c.__ppSkip = 0; c.__ppSkipTimer = null; }, 300);
    }
  }

  function takeSkip(container) {
    if (!container) return false;
    if (container.__ppSkip > 0) { container.__ppSkip--; return true; }
    return false;
  }

  function onPaneScroll(src) {
    const sc = src.viewer && src.viewer.container;
    if (!sc) return;
    if (takeSkip(sc)) return;      // 自己刚设的值引起的回声：吞掉，不扩散
    const pos = currentPosition(src);
    if (pos) { src.curPage = pos.page; src.curIntra = pos.intra; syncPageUi(src); }
    if (!syncScroll) return;       // 关闭同步 = 各面板完全独立滚动

    const vr = ratio(sc.scrollTop, sc.scrollHeight, sc.clientHeight);
    const hr = ratio(sc.scrollLeft, sc.scrollWidth, sc.clientWidth);
    for (const p of panes) {
      if (p === src) continue;
      const t = p.viewer && p.viewer.container;
      if (!t) continue;
      try {
        // 主路径：按页码 + 页内比例对齐
        if (pos && gotoPage(p, pos.page, pos.intra)) {
          const left = hr * Math.max(0, t.scrollWidth - t.clientWidth);
          if (Math.abs(t.scrollLeft - left) > 0.5) { markSkip(p); t.scrollLeft = left; }
          continue;
        }
        // 回落：整体滚动百分比
        const top = vr * Math.max(0, t.scrollHeight - t.clientHeight);
        const left = hr * Math.max(0, t.scrollWidth - t.clientWidth);
        if (Math.abs(t.scrollTop - top) <= 0.5 && Math.abs(t.scrollLeft - left) <= 0.5) continue;
        markSkip(p);
        t.scrollTop = top;
        t.scrollLeft = left;
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- 同步缩放 ---------------- */

  function onPaneScale(src) {
    if (!syncZoom || zoomGuard) return;
    const v = src.viewer;
    if (!v) return;
    let target;
    try { target = String(v.viewer.currentScale); } catch (e) { return; }
    zoomGuard = true;
    for (const p of panes) {
      if (p === src) continue;
      const pv = p.viewer;
      if (!pv) continue;
      try { pv.viewer.currentScaleValue = target; } catch (e) { /* ignore */ }
    }
    setTimeout(() => { zoomGuard = false; }, 80);
  }

  /** 缩放：同步开时作用于全部面板，否则只作用于当前面板。
   *  缩放会重建页面布局（scrollHeight 变化），故之后再确认一次
   *  「连续垂直 + 可滚」——保证放大后滚动范围跟着更新。 */
  function zoom(kind) {
    const targets = syncZoom ? panes.slice() : [panes[activeIdx >= 0 ? activeIdx : 0]].filter(Boolean);
    if (!targets.length) {
      setStatus(T("compareNoFocus"));
      return;
    }
    for (const p of targets) {
      const v = p.viewer;
      if (!v) continue;
      try {
        if (kind === "fit") {
          v.viewer.currentScaleValue = "page-width";
        } else if (kind === "100") {
          v.viewer.currentScaleValue = "1";
        } else {
          const cur = Number(v.viewer.currentScale) || 1;
          const next = kind === "in" ? cur * 1.2 : cur / 1.2;
          v.viewer.currentScaleValue = String(Math.min(6, Math.max(0.2, next)));
        }
      } catch (e) { /* ignore */ }
      // 记住用户显式设过的固定缩放：窗口尺寸变化时阅读器会把它打回 page-height，
      // ensureScrollable 会把这个值还原（"全屏后我放大的倍数没了"也是个坑）
      try {
        const now = String(v.viewer.currentScaleValue);
        p.userScaleValue = (now === "page-width" || now === "page-height" || now === "auto") ? null : now;
      } catch (e) { /* ignore */ }
      // 布局是异步的：稍后再确认一次，确保放大后的滚动范围立刻可用
      scheduleEnsure(p);
    }
  }

  /* ---------------- 「添加选中文献」 ---------------- */

  let adding = false;
  async function addFromSelection() {
    if (adding) return;
    if (panes.length >= MAX) {
      setStatus(T("compareLimitReached").replace("%n", String(MAX)));
      return;
    }
    if (typeof args.resolveSelected !== "function") return;
    adding = true;
    setStatus(T("compareReadingSelection"));
    try {
      const pdfs = await args.resolveSelected();
      if (!pdfs || !pdfs.length) {
        setStatus(T("compareNoSelectionPdf"));
        return;
      }
      let added = 0;
      for (const pdf of pdfs) {
        if (panes.length >= MAX) break;
        if (addPane(pdf)) added++;
      }
      setStatus(added ? T("compareAdded").replace("%n", String(added)) : T("compareNothingAdded"));
    } catch (e) {
      setStatus(T("compareLoadFailed") + " " + shortErr(e));
    } finally {
      adding = false;
    }
  }

  /* ---------------- 文本结果条（复制 / 翻译本页） ---------------- */

  function showResult(title, body) {
    try {
      lastResult = body || "";
      $("pp-cmp-result-title").textContent = title || "";
      $("pp-cmp-result-body").textContent = body || "";
      $("pp-cmp-result").style.display = "flex";
    } catch (e) { /* ignore */ }
  }

  function hideResult() {
    try { $("pp-cmp-result").style.display = "none"; } catch (e) { /* ignore */ }
  }

  function activePane() {
    return panes[activeIdx >= 0 ? activeIdx : 0] || null;
  }

  /** 取当前面板当前页的文本（补偿预览无文本层：不能划词/复制/搜索） */
  async function copyActivePageText() {
    const rec = activePane();
    if (!rec || !rec.viewer) { setStatus(T("compareNotReady")); return; }
    const page = rec.curPage || 1;
    setStatus(T("compareExtracting"));
    try {
      const text = await pageText(rec, page);
      if (!text) { setStatus(T("comparePageTextEmpty")); return; }
      try { Zotero.Utilities.Internal.copyText(text); } catch (e) { /* 复制失败仍展示 */ }
      showResult(T("comparePageTextTitle")
        .replace("%p", String(page)).replace("%t", String(rec.pagesCount || "?")), text);
      setStatus(T("comparePageTextCopied").replace("%n", String(text.length)));
    } catch (e) {
      setStatus(T("compareLoadFailed") + " " + shortErr(e));
    }
  }

  /** 本页对照翻译：0.28.0 起经 TranslateSvc 多引擎链路（由 bootstrap 侧注入 translateText） */
  async function translateActivePage() {
    const rec = activePane();
    if (!rec || !rec.viewer) { setStatus(T("compareNotReady")); return; }
    if (typeof args.aiStatus === "function" && args.aiStatus() !== "ok") {
      showResult(T("compareTranslateTitle"), (args.aiGuidance && args.aiGuidance()) || T("popupNoAi"));
      setStatus(T("comparePageTextTitle").replace("%p", "AI").replace("%t", ""));
      return;
    }
    if (typeof args.translateText !== "function") return;
    const page = rec.curPage || 1;
    setStatus(T("compareTranslating"));
    try {
      const text = await pageText(rec, page);
      if (!text) { setStatus(T("comparePageTextEmpty")); return; }
      const clipped = text.length > 6000 ? text.slice(0, 6000) : text;
      const out = await args.translateText(clipped);
      showResult(T("compareTranslateTitle")
        .replace("%p", String(page)).replace("%t", String(rec.pagesCount || "?")) +
        (text.length > clipped.length ? T("compareTruncated") : ""), out);
      setStatus("");
    } catch (e) {
      showResult(T("compareTranslateTitle").replace("%p", String(page)).replace("%t", ""),
        I18nErr(e));
      setStatus(T("compareLoadFailed") + " " + shortErr(e));
    }
  }

  function I18nErr(e) {
    return T("errPrefix") + ((e && e.message) || e);
  }

  /* ---------------- 工具栏接线 ---------------- */

  function wireToolbar() {
    const zh = !!args.isZh;

    try { $("pp-cmp-layout-label").textContent = T("compareLayout"); } catch (e) { /* ignore */ }
    const opt = (id, text) => { try { $(id).setAttribute("label", text); } catch (e) { /* ignore */ } };
    opt("pp-cmp-layout-auto", T("compareLayoutAuto"));
    opt("pp-cmp-layout-h", T("compareLayoutH"));
    opt("pp-cmp-layout-v", T("compareLayoutV"));
    opt("pp-cmp-layout-grid", T("compareLayoutGrid"));

    try {
      $("pp-cmp-layout").value = layout;
      $("pp-cmp-layout").addEventListener("command", (ev) => {
        layout = ev.target.value || "auto";
        applyLayout();
        if (args.setPref) args.setPref("compareLayout", layout);
      });
    } catch (e) { /* ignore */ }

    try {
      const sc = $("pp-cmp-sync-scroll");
      sc.setAttribute("label", T("compareSyncScroll"));
      sc.checked = syncScroll;
      sc.addEventListener("command", () => {
        syncScroll = !!sc.checked;
        if (args.setPref) args.setPref("compareSyncScroll", syncScroll);
      });
    } catch (e) { /* ignore */ }

    try {
      const sz = $("pp-cmp-sync-zoom");
      sz.setAttribute("label", T("compareSyncZoom"));
      sz.checked = syncZoom;
      sz.addEventListener("command", () => {
        syncZoom = !!sz.checked;
        if (args.setPref) args.setPref("compareSyncZoom", syncZoom);
      });
    } catch (e) { /* ignore */ }

    const bindBtn = (id, text, title, fn) => {
      try {
        const b = $(id);
        b.textContent = text;
        b.title = title;
        b.addEventListener("click", fn);
      } catch (e) { /* ignore */ }
    };
    bindBtn("pp-cmp-zoom-out", "−", T("compareZoomOut"), () => zoom("out"));
    bindBtn("pp-cmp-zoom-fit", zh ? "适宽" : "Fit", T("compareZoomFit"), () => zoom("fit"));
    bindBtn("pp-cmp-zoom-in", "+", T("compareZoomIn"), () => zoom("in"));
    bindBtn("pp-cmp-zoom-100", "100%", T("compareZoom100"), () => zoom("100"));
    bindBtn("pp-cmp-align", T("compareAlign"), T("compareAlignHint"), alignToActive);
    bindBtn("pp-cmp-copy-page", T("compareCopyPage"), T("compareCopyPageHint"), copyActivePageText);
    bindBtn("pp-cmp-translate-page", T("compareTranslatePage"), T("compareTranslatePageHint"), translateActivePage);
    bindBtn("pp-cmp-add", T("compareAddSelected"), T("compareAddSelectedHint"), addFromSelection);
    bindBtn("pp-cmp-result-copy", T("popupCopy"), "", () => {
      try { if (lastResult) Zotero.Utilities.Internal.copyText(lastResult); } catch (e) { /* ignore */ }
    });
    bindBtn("pp-cmp-result-close", "✕", T("compareClose"), hideResult);

    document.title = T("compareWindowTitle");
    updateCount();
  }

  /* ---------------- 启动 / 卸载 ---------------- */

  function boot() {
    if (!Zotero || !Zotero.Reader || !Zotero.Reader.openPreview) {
      setStatus(T("compareApiUnavailable"));
      return;
    }
    // 窗口自身尺寸变化（最大化/还原/拖拽）→ 所有面板延迟复核可滚动性
    try {
      window.addEventListener("resize", () => {
        trace("window resize");
        for (const p of panes) scheduleEnsure(p);
      });
    } catch (e) { /* ignore */ }
    wireToolbar();
    const initial = (args.panes || []).slice();
    if (!initial.length) {
      setStatus(T("compareEmptyHint"));
      return;
    }
    for (const pdf of initial) {
      if (panes.length >= MAX) break;
      addPane(pdf);
    }
    activeIdx = panes.length ? 0 : -1;
    if (panes[0]) setActive(panes[0]);
  }

  // 供开窗方（PdfCompare.openWith，窗口已存在时）追加面板
  window.ppCompareAddMany = function (list) {
    try {
      window.focus();
      for (const pdf of list || []) {
        if (panes.length >= MAX) break;
        addPane(pdf);
      }
    } catch (e) { /* ignore */ }
  };

  /* 诊断快照（只读）：排障时用来判断「面板是不是真的挂上了 PDF 视图」——
   * 内嵌预览失败是静默的（面板空白），没有这个就只能靠猜。
   * 由 PdfCompare.selfTest() 与人工在浏览器/终端排障时调用。 */
  window.ppCompareSnapshot = function () {
    return panes.map((p, i) => {
      const d = diagnose(p);
      return {
        index: i + 1,
        attID: p.attID,
        title: String(p.title || "").slice(0, 60),
        loaded: !!p.loaded,
        hasViewer: !!p.viewer,
        pages: p.viewer ? (p.viewer.viewer.pagesCount || 0) : 0,
        scale: p.viewer ? p.viewer.viewer.currentScale : 0,
        pageLabel: p.pageInput ? p.pageInput.value : "",
        curPage: p.curPage || 0,
        message: p._msgEl ? p._msgEl.textContent : "",
        layout: { left: p.wrapper.style.left, top: p.wrapper.style.top, width: p.wrapper.style.width, height: p.wrapper.style.height },
        diag: d,
      };
    });
  };

  /** 逐层探测视图句柄的可达性（排障专用；正常路径不走这里） */
  function diagnose(p) {
    const d = {};
    const t = (fn, key) => { try { d[key] = fn(); } catch (e) { d[key] = "ERR:" + (e && e.message); } };
    t(() => !!p.reader, "hasReader");
    t(() => !!(p.reader && p.reader._internalReader), "hasInternalReader");
    t(() => {
      const ir = p.reader && p.reader._internalReader;
      return ir ? Object.getOwnPropertyNames(ir).slice(0, 40) : null;
    }, "internalReaderKeys");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      return pv ? Object.getOwnPropertyNames(pv).slice(0, 40) : null;
    }, "primaryViewKeys");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      return !!w;
    }, "hasPvWin");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      if (!w) return null;
      return Object.getOwnPropertyNames(w).filter((k) => /pdf|PDF|view|View|reader/.test(k)).slice(0, 25);
    }, "pvWinGlobals");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      if (!w) return null;
      return String((w.location && w.location.href) || "");
    }, "pvWinHref");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      return w ? typeof w.PDFViewerApplication : null;
    }, "pvWinAppType");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      return w ? typeof w.wrappedJSObject : null;
    }, "pvWinWrappedType");
    t(() => {
      const rw = p.reader && p.reader._iframeWindow;
      if (!rw || !rw.document) return null;
      const out = [];
      for (const f of rw.document.querySelectorAll("iframe")) out.push(f.getAttribute("src") || "(no-src)");
      return out;
    }, "readerIframes");
    t(() => {
      const rw = p.reader && p.reader._iframeWindow;
      return rw ? typeof rw.PDFViewerApplication : null;
    }, "readerWinAppType");
    return d;
  }

  /** 同步滚动探针（排障/自检用）：真的滚一下第一个面板，回报其他面板是否跟着走，
   *  并顺带回报容器 overflow 是否已被解禁（ReaderPreview 默认把它设成 hidden）。 */
  window.ppCompareSyncProbe = function () {
    const src = panes.find((p) => p.viewer && p.viewer.container);
    if (!src) return Promise.resolve(null);
    const sc = src.viewer.container;
    let overflowY = "";
    try { overflowY = sc.ownerDocument.defaultView.getComputedStyle(sc).overflowY; } catch (e) { /* ignore */ }
    const maxV = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const before = panes.filter((p) => p !== src).map((p) => (p.viewer && p.viewer.container ? p.viewer.container.scrollTop : -1));
    sc.scrollTop = Math.round(maxV * 0.5);
    // 派发真实 scroll 事件，走的就是面板上挂的那个监听器（不直接调内部函数）
    try {
      const evt = sc.ownerDocument.createEvent("Event");
      evt.initEvent("scroll", false, false);
      sc.dispatchEvent(evt);
    } catch (e) { /* ignore */ }
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          overflowY,
          srcMaxScroll: maxV,
          srcScrollTop: sc.scrollTop,
          othersBefore: before,
          othersAfter: panes.filter((p) => p !== src).map((p) => {
            if (!p.viewer || !p.viewer.container) return null;
            const c = p.viewer.container;
            const m = Math.max(0, c.scrollHeight - c.clientHeight);
            return {
              scrollTop: c.scrollTop,
              max: m,
              ratio: m > 0 ? Number((c.scrollTop / m).toFixed(3)) : 0,
            };
          }),
        });
      }, 200);
    });
  };

  /** 滚动结构探针（排障用）：回答「到底有没有内容可滚、真正的滚动容器是谁」。
   *  只看 overflow 是不够的——overflow:auto 但 scrollHeight≈clientHeight 时
   *  用户看到的就是「滚不动」。 */
  window.ppCompareScrollProbe = function () {
    const paneFacts = (p, i) => {
      const out = { pane: i + 1, attID: p.attID, hasViewer: !!p.viewer };
      if (!p.viewer) return out;
      const v = p.viewer;
      try {
        const sc = v.container;
        const cs = sc ? v.win.getComputedStyle(sc) : null;
        out.scrollMode = v.viewer.scrollMode;          // 0=连续垂直，3=单页(滚不动)
        out.pageEls = v.win.document.querySelectorAll(".page").length;
        out.clientHeight = sc ? sc.clientHeight : -1;
        out.scrollHeight = sc ? sc.scrollHeight : -1;
        out.maxScroll = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : -1;
        out.overflowY = cs ? cs.overflowY : "?";
        out.overscroll = cs ? cs.overscrollBehaviorY : "?";
        out.scaleValue = v.viewer.currentScaleValue;
      } catch (e) { out.err = String(e && e.message); }
      return out;
    };

    const facts = panes.map((p, i) => paneFacts(p, i));

    // A) 同步滚动开：滚面板1，其余应跟到同一比例
    // B) 同步滚动关：其余必须完全不动（面板间互不干扰）
    const fire = (c) => {
      try {
        const ev = c.ownerDocument.createEvent("Event");
        ev.initEvent("scroll", false, false);
        c.dispatchEvent(ev);
      } catch (e) { /* ignore */ }
    };

    return new Promise((resolve) => {
      const first = panes.find((p) => p.viewer && p.viewer.container);
      if (!first) { resolve({ facts, sync: null }); return; }
      const sc = first.viewer.container;
      const others = () => panes.filter((p) => p !== first && p.viewer && p.viewer.container);
      // 先记录窗口打开时的实际默认值（自检要能证明「同步滚动默认关」）
      const defaults = { syncScroll: syncScroll, syncZoom: syncZoom, layout: layout };

      // 滚轮能不能滚，取决于面板中心点上「最顶层」的元素是否把事件交给滚动容器。
      // 用 elementFromPoint 直接看命中谁（比派发 untrusted 事件可靠：合成事件
      // 不会触发浏览器默认滚动行为）。
      let hit = null;
      try {
        const d = first.viewer.win.document;
        const el = d.elementFromPoint(Math.round(sc.clientWidth / 2), Math.round(sc.clientHeight / 2));
        hit = el ? { tag: el.tagName, id: el.id || "", cls: String(el.className || "").slice(0, 60), inScroller: sc.contains(el) } : null;
      } catch (e) { hit = "ERR:" + (e && e.message); }

      const wasOn = syncScroll;
      syncScroll = true;
      sc.scrollTop = Math.round(Math.max(0, sc.scrollHeight - sc.clientHeight) * 0.5);
      fire(sc);

      setTimeout(() => {
        const onRatio = others().map((p) => {
          const c = p.viewer.container;
          const m = Math.max(0, c.scrollHeight - c.clientHeight);
          return m > 0 ? Number((c.scrollTop / m).toFixed(3)) : 0;
        });

        syncScroll = false;
        const beforeOff = others().map((p) => p.viewer.container.scrollTop);
        sc.scrollTop = 0;
        fire(sc);

        setTimeout(() => {
          const offAfter = others().map((p) => p.viewer.container.scrollTop);
          syncScroll = wasOn;

          // C) 缩放后滚动范围是否跟着更新（用户明确要求）
          const zBefore = { scale: Number(first.viewer.viewer.currentScale.toFixed(4)), max: Math.max(0, sc.scrollHeight - sc.clientHeight) };
          zoom("in");
          setTimeout(() => {
            const zAfter = {
              scale: Number(first.viewer.viewer.currentScale.toFixed(4)),
              max: Math.max(0, sc.scrollHeight - sc.clientHeight),
              scrollMode: first.viewer.viewer.scrollMode,
              pageEls: first.viewer.win.document.querySelectorAll(".page").length,
            };

            // D) 尺寸变化（模拟最大化 / 全屏）后可滚动性是否还在
            //    —— 用户报的正是「第一次打开能滚，全屏后滚不动」。
            //    这里做时间序列采样，看清「什么时候被打回单页、什么时候被拉回来」。
            const resized = { before: paneFacts(first, 0), samples: [] };
            try { window.maximize(); } catch (e) { resized.maxErr = String(e && e.message); }
            const t0 = Date.now();
            const iv = setInterval(() => {
              resized.samples.push({
                t: Date.now() - t0,
                sm: first.viewer.viewer.scrollMode,
                pe: first.viewer.win.document.querySelectorAll(".page").length,
                max: Math.max(0, first.viewer.container.scrollHeight - first.viewer.container.clientHeight),
                scale: String(first.viewer.viewer.currentScaleValue).slice(0, 8),
              });
              if (resized.samples.length >= 16) {
                clearInterval(iv);
                resized.after = paneFacts(first, 0);
                try { window.restore(); } catch (e) { /* ignore */ }
                resolve({
                  defaults,
                  facts,
                  wheelHit: hit,
                  syncOn: { srcRatio: 0.5, othersRatios: onRatio },
                  syncOff: { othersBefore: beforeOff, othersAfter: offAfter, moved: offAfter.some((v, i) => v !== beforeOff[i]) },
                  zoom: { before: zBefore, after: zAfter, maxGrew: zAfter.max > zBefore.max },
                  onResize: resized,
                  trace: traceLog,
                });
              }
            }, 200);
          }, 900);
        }, 250);
      }, 250);
    });
  };

  /* 页码导航 / 文本提取探针（排障 + 自检用）：验证 ①②③ 三条在真实阅读器里成立 */
  window.ppCompareNavProbe = async function () {
    const out = { panes: panes.length };
    const first = panes[0];
    const second = panes[1];
    if (!first || !first.viewer) { out.err = "pane1 not ready"; return out; }
    // 前一探针会把窗口最大化再还原，布局在收敛中——先等它稳定，否则
    // 滚动位置会被 pdf.js 的重排带偏，测出来的对齐结果不可信
    await delay(1500);

    // ② 页码导航：跳到第 3 页
    out.beforePage = first.curPage;
    const jumped = gotoPage(first, 3, 0);
    await delay(400);
    out.jumpOk = jumped;
    out.afterJumpPage = first.curPage;
    out.afterJumpScrollTop = first.viewer.container.scrollTop;
    out.afterJumpInput = first.pageInput ? first.pageInput.value : null;
    // 越界应收敛到最后一页而不是乱跳
    gotoPage(first, 99999, 0);
    await delay(300);
    out.clampPage = first.curPage;
    out.totalPages = first.pagesCount;
    // 回到顶部
    gotoPage(first, 1, 0);
    await delay(300);

    // ① 按页码对齐：把面板1 停在某页，再让所有面板对齐过去
    gotoPage(first, Math.min(4, first.pagesCount || 4), 0.25);
    await delay(350);
    out.activePos = currentPosition(first);
    alignToActive();
    await delay(500);
    out.aligned = panes.map((p) => ({ pane: panes.indexOf(p) + 1, curPage: p.curPage, pos: currentPosition(p) }));

    // ③ 文本提取（绕开 textLayer）
    const dbg = {};
    out.textDbg = dbg;
    try {
      const t = await pageText(first, first.curPage || 1, dbg);
      out.textLen = t.length;
      out.textSample = t.slice(0, 80).replace(/\s+/g, " ");
    } catch (e) { out.textErr = String(e && e.message); }

    // ① 同步开关关闭时对齐按钮仍应生效（它是显式动作，不受开关约束）
    out.syncScrollDefault = syncScroll;
    return out;
  };

  window.addEventListener("unload", () => {
    for (const p of panes) {
      try { if (p.reader && p.reader.uninit) p.reader.uninit(); } catch (e) { /* ignore */ }
    }
    panes.length = 0;
    try {
      if (Zotero && Zotero.Papilot && Zotero.Papilot.pdfCompare) {
        Zotero.Papilot.pdfCompare.onWindowClosed();
      }
    } catch (e) { /* ignore */ }
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  }
})();
