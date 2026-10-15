/* PaperPilot PDF 对照翻译 · 左原右译双栏窗口脚本（0.36.0）
 *
 * 职责边界：**只做「两个 reader 预览 + 同步滚动/缩放 + 工具栏」**。
 *   翻译、段落提取、译文卡注入一律回插件作用域（window.arguments[0] 的回调），
 *   因为窗口作用域没有 AIClient / AIChat / TranslateSvc / PdfInline。
 *
 * 与 compare.js 的关系：pane 挂载与「页 + 页内比例」定位这套打法源自 compare.js
 * （多篇 PDF 对比窗口），本文件是它的**精简双栏版**，并保留其三条核心结论：
 *   ① `reader._open({})` 吞异常后 return false → 必须判返回值；
 *   ② 预览的 scrollMode 落到 3（单页）→ 强制 0（连续垂直）+ 解禁 #viewerContainer 的 overflow；
 *   ③ 就绪判据是 `contentWindow.wrappedJSObject.createReader` 是函数（about:blank 的
 *      readyState 立刻是 complete，只看它会把未就绪当就绪）。
 *   ④ ★ 预览恒 textLayerMode=0（Zotero reader.js 在 webviewerloaded 里写死
 *      `textLayerMode: this._preview ? 0 : 1`）→ 预览 pane **永远不渲染 .textLayer**，
 *      右栏 PdfInline 会每页都报「无文本层」（0.37.3 实锤；0.36/0.37 自检里预览栏
 *      withTextLayer=0 也是它，此前误归因为 detached 窗口不渲染）。
 *      补救见 ensureTextLayer：抢在 viewer 初始化读选项前把 textLayerMode 改回 1。
 */
(function () {
  "use strict";

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SYNC_GUARD_MS = 300;   // 程序化滚动后的「待吞计数」兜底清零
  const READY_TIMEOUT_MS = 15000;
  const OPEN_TIMEOUT_MS = 12000;   // openPreview / _open 的超时（防永久挂起）

  const args0 = (window.arguments && window.arguments[0]) || {};
  let A = args0;
  const Zotero = A.Zotero;
  const Services = A.Services;

  const $ = (id) => document.getElementById(id);
  const zh = () => A.isZh !== false;
  const T = (k) => {
    try { return typeof A.t === "function" ? A.t(k) : k; } catch (e) { return k; }
  };
  function tx(k, zhText, enText) {
    const v = T(k);
    return v && v !== k ? v : (zh() ? zhText : enText);
  }
  function setText(id, text) { const el = $(id); if (el) el.textContent = text == null ? "" : String(text); }
  function setStatus(msg) { setText("pp-pd-status", msg || ""); }
  /** 译文字号 = **相对原文字号的倍数**（0.7–1.6，步进 0.1）——
   *  与内核（PdfInline.fontScale）同一语义：卡片字号 = 原文段落字号 × 倍数。 */
  function clampFont(n) {
    const v = Math.round(Number(n) * 10) / 10;
    if (!isFinite(v) || v <= 0) return 1;
    return Math.min(1.6, Math.max(0.7, v));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let fontSize = 1;   // = 字号倍数（1.0×）
  let busy = false;
  let panes = null;            // { left:{browser,reader,viewer}, right:{...} }

  /* ==================== reader 预览挂载（compare.js 打法） ==================== */

  function unwaive(w) {
    if (!w) return null;
    try { return w.wrappedJSObject || w; } catch (e) { return w; }
  }

  /** browser 是否已挂上 reader 文档（只看 readyState 会把 about:blank 当就绪） */
  function browserReady(browser) {
    try {
      const w = browser && browser.contentWindow;
      const uw = unwaive(w);
      return !!(uw && typeof uw.createReader === "function");
    } catch (e) {
      return false;
    }
  }

  async function waitBrowserReady(browser) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (browserReady(browser)) return true;
      if (Date.now() > deadline) return false;
      await sleep(60);
    }
  }

  /** 从 ReaderPreview 里挖出 pdf.js 视图（照 compare.js resolveViewer） */
  function resolveViewer(reader) {
    const pick = (w) => {
      const uw = unwaive(w);
      if (!uw) return null;
      const app = uw.PDFViewerApplication;
      if (!app || !app.pdfViewer) return null;
      let container = null;
      try { container = uw.document.getElementById("viewerContainer"); } catch (e) { /* ignore */ }
      return { win: uw, app, viewer: app.pdfViewer, container };
    };
    try {
      const ir = reader && reader._internalReader;
      const pv = ir && ir._primaryView;
      let hit = pick(pv && pv._iframeWindow);
      if (hit) return hit;
      const rw = reader && reader._iframeWindow;
      if (rw && rw.document) {
        for (const f of rw.document.querySelectorAll("iframe")) {
          hit = pick(f.contentWindow);
          if (hit) return hit;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  const VIEWER_CSS =
    "#viewerContainer{overflow:auto !important;overscroll-behavior:contain !important;" +
    "touch-action:pan-x pan-y !important;}" +
    ".pdfViewer .page{border-radius:0 !important;}";

  function unclampViewer(v) {
    if (!v) return;
    try {
      const d = v.win.document;
      let s = d.getElementById("pp-pd-viewer-style");
      if (!s) {
        s = d.createElement("style");
        s.id = "pp-pd-viewer-style";
        (d.head || d.documentElement).appendChild(s);
      }
      if (s.textContent !== VIEWER_CSS) s.textContent = VIEWER_CSS;
    } catch (e) { /* ignore */ }
    // scrollMode 3 = 单页（预览默认）→ 0 = 连续垂直，否则「不能滚」
    try {
      if (v.viewer && v.viewer.scrollMode !== 0) v.viewer.scrollMode = 0;
    } catch (e) { /* ignore */ }
  }

  /* ★ 预览无文本层的根因与补救（0.37.3）：
   *  Zotero reader.js 在 webviewerloaded 事件里写死 `textLayerMode: this._preview ? 0 : 1`
   *  （本机 Zotero 10 的 resource/reader/reader.js 实锤）→ openPreview 的 pane 从不渲染
   *  .textLayer，与窗口可见性无关。右栏 PdfInline 靠 textLayer span 抽段落坐标 →
   *  每页都被判「无文本层（扫描版）」。
   *
   *  viewer.html 的启动序（resource/reader/pdf/web/viewer.mjs）：
   *    webviewerloaded（Zotero 置 0）→ PDFViewerApplication.run() →
   *    `await createL10n()` ← ★异步窗口 → _initializeViewerComponents 读 AppOptions
   *    构造 PDFViewer（textLayerMode 烧进私有字段，事后改无效）
   *  所以在 openPreview 返回后立刻高频轮询 PDFViewerApplicationOptions、持续置 1，
   *  直到 _initializedCapability.settled —— 无论 Zotero 的 0 何时落，都保证读到的是 1。
   *  （顺带收益：左栏预览从此可划词/复制，compare.js 时代「预览不能选字」的限制解除。）
   *
   *  ★ 0.38.1 加固（0.38.0 真机实锤「翻转在跑但仍失败」——PDF 有文本、全文索引
   *  正常，右栏却整篇报无文本层）：
   *    · 写后回读校验：每次 set 后用 opts.get("textLayerMode") 复核，绝不无凭据报成功；
   *    · 三管齐下：opts.set(1) + 直改视图对象 _preview=false（让 Zotero 自己的 setOptions
   *      置 1，最正路）+ settled 后再补 6 秒轻量重设（防 late setOptions 覆盖）；
   *    · 真机上仍失败时的兜底在内核：PdfInline 的 getPageData 字符路径（不依赖 textLayer）。
   */
  async function ensureTextLayer(pane) {
    const FLIP_KEEP_MS = 6000;
    const deadline = Date.now() + 20000;
    let sets = 0, verified = false;
    const viewerWin = () => {
      // ① reader 内部视图 iframe：_iframeWindow 在 webviewerloaded 之后才有值；
      //    _iframe.contentWindow 更早可用（viewer.html 加载期间 contentWindow 会换壳）
      try {
        const ir = pane.reader && pane.reader._internalReader;
        const pv = ir && ir._primaryView;
        const w = (pv && pv._iframeWindow) || (pv && pv._iframe && pv._iframe.contentWindow);
        if (w) return { w, pv: pv || null };
      } catch (e) { /* ignore */ }
      // ② 兜底：从 browser 的 reader.html 文档里找带 PDFViewerApplicationOptions 的 iframe
      try {
        const rw = pane.browser.contentWindow;
        const rdoc = rw && (rw.wrappedJSObject || rw).document;
        if (rdoc && typeof rdoc.querySelectorAll === "function") {
          for (const f of rdoc.querySelectorAll("iframe")) {
            const w = f.contentWindow;
            if (!w) continue;
            const uw = w.wrappedJSObject || w;
            if (uw.PDFViewerApplicationOptions) return { w, pv: null };
          }
        }
      } catch (e) { /* ignore */ }
      return null;
    };
    for (;;) {
      const hit = viewerWin();
      if (hit) {
        const uw = (hit.w && hit.w.wrappedJSObject) || hit.w;
        // 三管齐下之一：直改视图的 _preview（setOptions 读它决定 0/1）
        if (hit.pv) { try { hit.pv._preview = false; } catch (e) { /* ignore */ } }
        const opts = uw.PDFViewerApplicationOptions;
        if (opts && typeof opts.set === "function") {
          try { opts.set("textLayerMode", 1); sets++; } catch (e) { /* ignore */ }
          // 写后回读：set 没抛 ≠ 真的写进去了（跨隔间可能有坑），必须复核
          try {
            if (typeof opts.get === "function" && opts.get("textLayerMode") === 1) verified = true;
          } catch (e) { /* ignore */ }
        }
        const app = uw.PDFViewerApplication;
        if (app && app._initializedCapability && app._initializedCapability.settled) {
          // settled 后再补几拍轻量重设（防 late setOptions 把 0 又写回去），
          // 不阻塞返回：后台自转，下一轮窗口快照/日志能看到 verified
          const keep = Date.now() + FLIP_KEEP_MS;
          (async () => {
            try {
              while (Date.now() < keep) {
                const h2 = viewerWin();
                if (!h2) return;
                const u2 = (h2.w && h2.w.wrappedJSObject) || h2.w;
                const o2 = u2.PDFViewerApplicationOptions;
                if (o2 && typeof o2.set === "function") {
                  o2.set("textLayerMode", 1); sets++;
                  if (typeof o2.get === "function" && o2.get("textLayerMode") === 1) verified = true;
                }
                await sleep(300);
              }
            } catch (e) { /* ignore */ }
          })();
          pane.textLayerHow = (sets ? (verified ? "set+verified" : "set(unverified)") : "no-set")
            + ";sets=" + sets;
          return !!(sets && (verified || (opts && typeof opts.get !== "function")));
        }
      }
      if (Date.now() > deadline) {
        pane.textLayerHow = "timeout;sets=" + sets + ";verified=" + (verified ? 1 : 0);
        return false;
      }
      await sleep(10);
    }
  }

  /** 打开一个 pane 的 reader 预览 */
  async function mountPane(pane, attID) {
    const ok = await waitBrowserReady(pane.browser);
    if (!ok) {
      pane.error = "reader.html 未就绪";
      return false;
    }
    try {
      // 聚焦 browser 再 openPreview：预览在**未聚焦的后台窗口**里可能迟迟不完成挂载
      // （自检环境实测：窗口刚开就被主窗口抢焦点 → await 长时间不返回）
      try { pane.browser.focus(); } catch (e) { /* ignore */ }
      pane.reader = await Promise.race([
        Zotero.Reader.openPreview(attID, pane.browser),
        new Promise((res) => setTimeout(() => res(null), OPEN_TIMEOUT_MS)),
      ]);
      if (!pane.reader) {
        pane.error = tx("pdOpenTimeout", "预览打开超时（" + (OPEN_TIMEOUT_MS / 1000) + "s）",
          "Preview open timed out");
        return false;
      }
      // ★ 预览 textLayerMode=0（头注释④）→ 并发启动翻转循环，抢在 viewer 初始化读选项
      //   之前生效；不 await：_open 与它互不阻塞，谁先跑完都正确。
      pane.textLayerFlip = null;
      ensureTextLayer(pane).then((v) => { pane.textLayerFlip = v; }, () => { pane.textLayerFlip = false; });
      // _open 内部吞异常后 return false —— 必须判返回值
      if (pane.reader && typeof pane.reader._open === "function") {
        const opened = await Promise.race([
          pane.reader._open({}),
          new Promise((res) => setTimeout(() => res(null), OPEN_TIMEOUT_MS)),
        ]);
        if (opened === false) {
          pane.error = "reader._open 返回 false";
          return false;
        }
      }
    } catch (e) {
      pane.error = String((e && e.message) || e);
      return false;
    }
    if (!pane.reader || !pane.reader._internalReader) {
      pane.error = "无 _internalReader";
      return false;
    }
    // 视图 iframe 可能滞后于 _open 返回 → 轮询重试（最多 ~6 秒）
    for (let i = 0; i < 12 && !pane.viewer; i++) {
      pane.viewer = resolveViewer(pane.reader);
      if (!pane.viewer) await sleep(500);
    }
    if (!pane.viewer) {
      pane.error = "视图未就绪（resolveViewer 为空）";
      return false;
    }
    unclampViewer(pane.viewer);
    return true;
  }

  /* ==================== 页定位（页号 + 页内比例；几何二分求当前页） ==================== */

  function pageElOf(pane, n) {
    try {
      return pane.viewer.win.document.querySelector('.page[data-page-number="' + n + '"]');
    } catch (e) { return null; }
  }
  function pageOffsetTop(pane, el) {
    try {
      const c = pane.viewer.container;
      return (el.getBoundingClientRect().top - c.getBoundingClientRect().top) + c.scrollTop;
    } catch (e) { return null; }
  }
  function pagesCount(pane) {
    try { return pane.viewer.viewer.pagesCount || 0; } catch (e) { return 0; }
  }
  /** 当前阅读位置：顶页页码 + 页内比例（不用 currentPageNumber —— 程序化滚动后它滞后） */
  function currentPosition(pane) {
    const v = pane && pane.viewer;
    if (!v || !v.container) return null;
    const total = pagesCount(pane);
    const st = v.container.scrollTop;
    const at = (n) => {
      const el = pageElOf(pane, n);
      if (!el) return null;
      const top = pageOffsetTop(pane, el);
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
        if (!cur) break;
        if (cur.top <= st) { bestN = mid; bestI = cur; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (bestN) { page = bestN; info = bestI; }
    }
    if (!page) { page = 1; info = at(1); }
    const intra = info ? Math.min(1, Math.max(0, (st - info.top) / info.h)) : 0;
    return { page, intra };
  }
  function gotoPosition(pane, page, intra) {
    const v = pane && pane.viewer;
    if (!v || !v.container) return false;
    const total = pagesCount(pane);
    if (!total) return false;
    let want = Math.round(page);
    if (!isFinite(want)) return false;
    want = Math.min(total, Math.max(1, want));
    const el = pageElOf(pane, want);
    if (!el) {
      try { v.viewer.currentPageNumber = want; } catch (e) { /* ignore */ }
      return false;
    }
    const top = pageOffsetTop(pane, el);
    if (top === null) return false;
    const target = Math.max(0, Math.round(top + (Number(intra) || 0) * (el.offsetHeight || 0)));
    if (Math.abs(v.container.scrollTop - target) < 1.5) return true;
    v.container.scrollTop = target;
    return true;
  }

  /* ==================== 同步滚动（待吞计数 guard，不用布尔+rAF） ==================== */

  let pendingLeft = 0;
  let pendingRight = 0;
  let guardTimer = null;

  function markPending(side) {
    if (side === "left") pendingLeft++;
    else pendingRight++;
    // 窗口被遮挡时 scroll 事件可能不来 → 计时兜底清零，避免永久卡死（compare.js 结论）
    if (guardTimer) clearTimeout(guardTimer);
    guardTimer = setTimeout(() => { pendingLeft = 0; pendingRight = 0; guardTimer = null; }, SYNC_GUARD_MS);
  }

  function syncEnabled() {
    const cb = $("pp-pd-sync");
    return !!cb && !!cb.checked;
  }

  function bindScrollSync() {
    if (!panes) return;
    const L = panes.left, R = panes.right;
    // ★ 0.38.3 节流：scroll 事件每秒可达几十次，每次都做几何二分（多次
    //  getBoundingClientRect = 强制布局）+ 对侧写 scrollTop（又一次布局）→ 卡顿。
    //  合并到 60ms 一次、且只跟最新位置（pending 标记存待办，不排队积压）。
    const SYNC_THROTTLE_MS = 60;
    let adjTimer = null;      // 节流窗口
    let adjDirty = null;      // "left" | "right"：窗口结束后补跑一次
    const schedule = (side) => {
      adjDirty = side;
      if (adjTimer) return;
      adjTimer = setTimeout(run, SYNC_THROTTLE_MS);
    };
    const run = () => {
      adjTimer = null;
      const side = adjDirty;
      adjDirty = null;
      if (!side) return;
      if (side === "left") {
        if (!syncEnabled() || !R.viewer) return;
        const pos = currentPosition(L);
        if (!pos) return;
        markPending("right");
        gotoPosition(R, pos.page, pos.intra);
      } else {
        if (!syncEnabled() || !L.viewer) return;
        const pos = currentPosition(R);
        if (!pos) return;
        markPending("left");
        gotoPosition(L, pos.page, pos.intra);
      }
    };
    const onLeft = () => {
      if (pendingLeft > 0) { pendingLeft--; return; }
      schedule("left");
    };
    const onRight = () => {
      if (pendingRight > 0) { pendingRight--; return; }
      schedule("right");
    };
    try { L.viewer.container.addEventListener("scroll", onLeft, { passive: true }); } catch (e) { /* ignore */ }
    try { R.viewer.container.addEventListener("scroll", onRight, { passive: true }); } catch (e) { /* ignore */ }
    // 面板尺寸变化会让 pdf.js 重套视图状态（compare.js 坑）→ 重解禁 + 重设连续模式
    window.addEventListener("resize", () => {
      try { unclampViewer(L.viewer); unclampViewer(R.viewer); } catch (e) { /* ignore */ }
    });
  }

  /** 同步缩放：两侧同 scaleValue ⇒ 页高一致 ⇒ 位置映射无误差（默认开） */
  function bindZoomSync() {
    if (!panes) return;
    const L = panes.left, R = panes.right;
    const apply = () => {
      if (!syncZoomEnabled()) return;
      try {
        const v = L.viewer.viewer.currentScaleValue;
        if (v && R.viewer.viewer.currentScaleValue !== v) R.viewer.viewer.currentScaleValue = v;
      } catch (e) { /* ignore */ }
    };
    try {
      L.viewer.app.eventBus.on("scalechanging", apply);
      R.viewer.app.eventBus.on("scalechanging", () => {
        if (!syncZoomEnabled()) return;
        try {
          const v = R.viewer.viewer.currentScaleValue;
          if (v && L.viewer.viewer.currentScaleValue !== v) L.viewer.viewer.currentScaleValue = v;
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    apply();
  }
  function syncZoomEnabled() {
    try { return !!A.getSyncZoom(); } catch (e) { return false; }
  }

  /* ==================== 文案 / 工具栏 ==================== */

  function bindUi() {
    setLabelAndText();
    const sync = $("pp-pd-sync");
    if (sync) {
      sync.checked = (typeof A.getSyncScroll === "function") ? !!A.getSyncScroll() : true;
      sync.addEventListener("change", () => {
        try { A.setPref("pdfDualSyncScroll", !!sync.checked); } catch (e) { /* ignore */ }
        setStatus(tx("pdSyncOn", "同步滚动已开", "Sync on") + (sync.checked ? "" : ""));
      });
    }
    const dec = $("pp-pd-font-dec"), inc = $("pp-pd-font-inc");
    if (dec) dec.addEventListener("click", () => setFontSize(fontSize - 0.1));
    if (inc) inc.addEventListener("click", () => setFontSize(fontSize + 0.1));
    const all = $("pp-pd-all");
    if (all) all.addEventListener("click", async () => {
      if (busy) { setStatus(tx("pdBusy", "翻译进行中，请稍候…", "Still translating…")); return; }
      busy = true;
      setStatus(tx("pdAllStart", "整篇翻译：正在逐页渲染并翻译…", "Whole-doc: rendering and translating page by page…"));
      try {
        const r = await A.translateAll();
        if (r && r.error) {
          setStatus(tx("pdAllFail", "整篇翻译失败：", "Whole-doc failed: ") + r.error);
        } else {
          setStatus(tx("pdAllDone", "整篇翻译完成：", "Whole-doc done: ") +
            (r ? (r.pages || 0) + (zh() ? " 页 / " : " pages / ") + (r.blocks || 0) + (zh() ? " 段" : " blocks") +
              (r.skipped ? (zh() ? "（跳过 " + r.skipped + " 页：无文本层）" : " (" + r.skipped + " skipped)") : "") : ""));
        }
      } catch (e) {
        setStatus(tx("pdAllFail", "整篇翻译失败：", "Whole-doc failed: ") + ((e && e.message) || e));
      }
      busy = false;
    });
    const rt = $("pp-pd-retranslate");
    if (rt) rt.addEventListener("click", () => {
      if (busy) { setStatus(tx("pdBusy", "翻译进行中，请稍候…", "Still translating…")); return; }
      setStatus(tx("pdRetranslating", "已清缓存并重新翻译…", "Cache cleared, re-translating…"));
      try { A.retranslate(); } catch (e) { /* ignore */ }
    });
    const nt = $("pp-pd-note");
    if (nt) nt.addEventListener("click", async () => {
      if (busy) { setStatus(tx("pdBusy", "翻译进行中，请稍候…", "Still translating…")); return; }
      setStatus(tx("pdNoteBusy", "正在生成双语笔记…", "Creating note…"));
      try {
        const r = await A.exportNote();
        setStatus(r && r.ok
          ? tx("pdNoteDone", "✓ 已生成双语笔记", "✓ Bilingual note created")
          : tx("pdNoteFail", "生成笔记失败：", "Note failed: ") + ((r && r.error) || ""));
      } catch (e) {
        setStatus(tx("pdNoteFail", "生成笔记失败：", "Note failed: ") + ((e && e.message) || e));
      }
    });
    // 0.39.0 导出 ▾（双语 PDF 附件 / HTML / Markdown / Word）：选中即执行，
    // 执行后清空 value 便于再次选择同一项。
    // ★ 0.41.1 修复：XUL `menulist` 派发的是 **command**（HTML 才用 change）——
    //  0.39.0/0.40.0 只绑了 change → 真机点选后回调根本不触发，
    //  表现为「选了导出，什么都没发生、也没有附件」（用户实报）。
    //  compare.js:931 / bilingual-view.js:367 的项目惯例同为 command。
    //  这里两个都绑：处理函数开头读 value 并立刻清空 → 第二个事件读到空值自然 no-op（幂等）。
    const exp = $("pp-pd-export");
    if (exp) {
      const onExportPick = () => {
        const kind = String(exp.value || "");
        try { exp.value = ""; } catch (e) { /* ignore */ }
        if (kind) window.ppDualExport(kind);
      };
      exp.addEventListener("command", onExportPick);
      exp.addEventListener("change", onExportPick);
    }
    const cl = $("pp-pd-close");
    if (cl) cl.addEventListener("click", () => { try { window.close(); } catch (e) { /* ignore */ } });
  }

  function setLabelAndText() {
    setText("pp-pd-sync-text", tx("pdSync", "同步滚动", "Sync scroll"));
    setText("pp-pd-font-label", tx("pdFont", "译文字号", "Font scale"));
    setText("pp-pd-all", tx("pdAll", "翻译全文", "Translate whole doc"));
    setText("pp-pd-retranslate", tx("pdRetranslate", "重新翻译", "Re-translate"));
    setText("pp-pd-note", tx("pdNote", "导出双语笔记", "Export note"));
    setText("pp-pd-title", A.title || "");
    // 0.39.0：导出 ▾ 菜单
    setText("pp-pd-export-label", tx("pdExport", "导出", "Export"));
    const opt = (id, text) => {
      const el = $(id);
      if (el) { try { el.setAttribute("label", text); } catch (e) { /* ignore */ } }
    };
    opt("pp-pd-exp-pdf", tx("pdExpPdf", "双语 PDF 附件（挂到条目）", "Bilingual PDF attachment"));
    opt("pp-pd-exp-html", tx("pdExpHtml", "双语 HTML 文件…", "Bilingual HTML file…"));
    opt("pp-pd-exp-md", tx("pdExpMd", "双语 Markdown 文件…", "Bilingual Markdown file…"));
    opt("pp-pd-exp-docx", tx("pdExpDocx", "双语 Word (.docx)…", "Bilingual Word (.docx)…"));
  }

  /** 导出入口（0.39.0）：kind = pdf | html | md | docx；回插件作用域执行并把结果写状态行。
   *  导出 PDF 需要「已渲染的页」——未渲染页会如实报跳过数，提示先点「翻译全文」。
   *  0.41.1：调用计数写进 window.ppDualExportStats（自检据此验证「菜单事件→回调」链路）；
   *  window.ppDualExportDryRun = true 时只验链路、不真导出（自检用，避免弹文件选择器）。 */
  window.ppDualExportStats = { calls: 0, last: null, dry: 0 };
  window.ppDualExport = async function (kind, opts) {
    if (!kind) return false;
    const stats = window.ppDualExportStats;
    stats.calls++;
    stats.last = kind;
    const dry = (opts && opts.dryRun === true) || window.ppDualExportDryRun === true;
    if (dry) { stats.dry++; return true; }
    if (busy) { setStatus(tx("pdBusy", "翻译进行中，请稍候…", "Still translating…")); return false; }
    const label = kind === "pdf" ? tx("pdExpPdf", "双语 PDF 附件（挂到条目）", "Bilingual PDF attachment")
      : kind === "docx" ? "Word (.docx)"
        : kind === "html" ? "HTML" : "Markdown";
    setStatus(tx("pdExpBusy", "正在导出：", "Exporting: ") + label + "…");
    try {
      const r = await A.exportAs(kind);
      if (r && r.ok) {
        let extra = "";
        if (kind === "pdf") {
          extra = r.pages + (zh() ? " 页" : " pages")
            + (r.skipped ? (zh() ? "（跳过 " + r.skipped + " 页未渲染）" : " (" + r.skipped + " not rendered)") : "")
            + (zh() ? " → 已作为附件加入该条目" : " → attached to item");
        } else {
          extra = r.path || "";
        }
        setStatus(tx("pdExpDone", "✓ 已导出 ", "✓ Exported ") + label + (extra ? "：" + extra : ""));
        return true;
      }
      if (r && r.canceled) {
        setStatus(tx("pdExpCanceled", "已取消导出", "Export canceled"));
        return false;
      }
      setStatus(tx("pdExpFail", "导出失败：", "Export failed: ") + ((r && r.error) || ""));
      return false;
    } catch (e) {
      setStatus(tx("pdExpFail", "导出失败：", "Export failed: ") + ((e && e.message) || e));
      return false;
    }
  };

  function setFontSize(n) {
    fontSize = clampFont(n);
    setText("pp-pd-font-val", fontSize.toFixed(1) + "×");
    try { A.setFontScale(fontSize); } catch (e) { /* ignore */ }
  }

  /* ==================== 主流程 ==================== */

  async function run(payload) {
    if (payload) A = payload;
    busy = true;
    setLabelAndText();
    setStatus(tx("pdOpening", "正在打开左右两栏 PDF…", "Opening both panes…"));

    panes = {
      left: { browser: $("pp-pd-left-browser") },
      right: { browser: $("pp-pd-right-browser") },
    };
    if (!panes.left.browser || !panes.right.browser) {
      setStatus(tx("pdNoBrowser", "窗口组件缺失，无法打开预览", "Missing browser element"));
      busy = false;
      return;
    }

    const attID = A.attID;
    const okL = await mountPane(panes.left, attID);
    const okR = await mountPane(panes.right, attID);
    if (!okL || !okR) {
      setStatus(tx("pdOpenFail", "PDF 预览打开失败：", "Failed to open preview: ") +
        ((panes.left.error || panes.right.error) || "unknown"));
      busy = false;
      return;
    }

    // 窗口/容器几何为 0 时 pdf.js 不渲染任何页（自检环境实测）→ 主动撑一次窗口；
    // 真实用户侧也能兜住「窗口被系统压成 0 高 / 首帧未布局」的空白情况
    try {
      const c0 = panes.left.viewer.container;
      if (!c0 || c0.clientHeight < 10) {
        try { window.resizeTo(Math.max(1100, window.innerWidth || 1100), Math.max(760, window.innerHeight || 760)); }
        catch (e) { /* ignore */ }
        await sleep(300);
      }
    } catch (e) { /* ignore */ }

    bindScrollSync();
    bindZoomSync();
    setFontSize(A.fontScale || 1);
    setStatus(tx("pdTranslating", "翻译中", "Translating") + " 0/0");
    // 右栏的译文注入交给插件侧内核（mono：原文文字被译文替换、图形保留）
    try {
      A.onPanesReady(panes.left.reader, panes.right.reader);
    } catch (e) {
      setStatus(tx("pdInjectFail", "无法启动翻译：", "Failed to start translation: ") + ((e && e.message) || e));
    }
    busy = false;
  }

  /* ==================== 插件侧 → 窗口 的回调 ==================== */

  /** 进度（由插件侧内核在每段完成时调用） */
  window.ppDualProgress = function (p) {
    try {
      const total = (p && p.total) || 0;
      const done = (p && p.done) || 0;
      const bar = $("pp-pd-progress-bar");
      if (bar) bar.style.width = (total ? Math.round(done / total * 100) : 0) + "%";
      setText("pp-pd-count", total ? done + " / " + total : "");
      if (total && done >= total) {
        setStatus(tx("pdDone", "完成：", "Done: ") + done + (zh() ? " 段" : " blocks"));
      } else if (total) {
        setStatus(tx("pdTranslating", "翻译中", "Translating") + " " + done + "/" + total);
      }
    } catch (e) { /* ignore */ }
  };

  /** 整篇翻译的页级进度（由插件侧 translateAll 的 onProgress 转来） */
  window.ppDualPhase = function (p) {
    try {
      const page = (p && p.page) || 0;
      const total = (p && p.total) || 0;
      const bar = $("pp-pd-progress-bar");
      if (bar && total) bar.style.width = Math.round(page / total * 100) + "%";
      if (p && p.phase === "skip") {
        setStatus(tx("pdAllSkip", "整篇翻译：第 ", "Whole-doc: page ") + page + "/" + total +
          (zh() ? " 页无文本层，跳过" : " has no text layer, skipped"));
      } else {
        setStatus(tx("pdAllPage", "整篇翻译：第 ", "Whole-doc: page ") + page + "/" + total +
          (zh() ? " 页" : "") +
          (p && p.blocks != null ? (zh() ? "（累计 " + p.blocks + " 段）" : " (" + p.blocks + " blocks)") : ""));
      }
    } catch (e) { /* ignore */ }
  };

  /** 就绪信号：两栏都已挂载**且**初始化已跑完（busy=false）。
   *  外部（自检/测试/排障）等这一个条件即可 —— 只看 mounted 会在
   *  bindScrollSync/setFontSize/onPanesReady 还没执行完时误判「可用」。 */
  window.ppDualReady = function () {
    try {
      return !!(panes && panes.left && panes.left.viewer && panes.right && panes.right.viewer && !busy);
    } catch (e) { return false; }
  };

  /** 换一篇（单实例复用；翻译中拒绝） */
  window.ppDualLoad = function (payload) {
    if (busy) {
      setStatus(tx("pdBusySwitch", "正在翻译中：请等完成或关闭窗口后重试", "Busy — try again later"));
      try { window.focus(); } catch (e) { /* ignore */ }
      return false;
    }
    try { window.focus(); } catch (e) { /* ignore */ }
    // 先让插件侧停掉旧的右栏翻译，再重开
    try { if (A.onUnload) A.onUnload(); } catch (e) { /* ignore */ }
    run(payload || {});
    return true;
  };

  /** 自检快照（排障/测试） */
  window.ppDualSnapshot = function () {
    const pos = (pane) => {
      try {
        const pos2 = currentPosition(pane);
        return pos2 ? { page: pos2.page, intra: Math.round(pos2.intra * 100) / 100 } : null;
      } catch (e) { return null; }
    };
    // 渲染探测：页元素数 / 有 textLayer 的页数 —— pdf.js 只渲染可见页，
    // 「窗口不可见/未布局」时两者都会是 0，这是排障时最需要看到的一对数
    const probe = (pane) => {
      if (!pane || !pane.viewer) return null;
      try {
        const d = pane.viewer.win.document;
        const pages = d.querySelectorAll(".page[data-page-number]");
        let withLayer = 0;
        for (const p of pages) {
          try { if (p.querySelector(".textLayer")) withLayer++; } catch (e) { /* ignore */ }
        }
        return { pageEls: pages.length, withTextLayer: withLayer };
      } catch (e) { return null; }
    };
    const paneInfo = (pane) => {
      if (!pane) return null;
      let ready = null;
      try { ready = browserReady(pane.browser); } catch (e) { ready = null; }
      // 尺寸：pdf.js 用「容器几何可见」决定渲染哪些页 —— clientHeight 为 0 时一页都不渲染
      // （0.36.0 首轮自检「pageEls>0 但 withTextLayer=0」的症状就是它，排障先看这几个数）
      let box = null;
      try {
        const c = pane.viewer && pane.viewer.container;
        const pageEl = pane.viewer && pane.viewer.win.document.querySelector(".page[data-page-number]");
        box = {
          containerW: c ? c.clientWidth : null,
          containerH: c ? c.clientHeight : null,
          scrollTop: c ? Math.round(c.scrollTop) : null,
          pageW: pageEl ? pageEl.offsetWidth : null,
          pageH: pageEl ? pageEl.offsetHeight : null,
        };
      } catch (e) { box = null; }
      return {
        mounted: !!pane.viewer,
        pos: pane.viewer ? pos(pane) : null,
        error: pane.error || null,
        browserReady: ready,
        probe: probe(pane),
        box,
        // textLayerMode 翻转：null=进行中 / true=已生效 / false=超时（此时右栏靠内核
        // getPageData 兜底，仍能翻译；textLayerHow 是过程明细，排障看它）
        textLayerFlip: pane.textLayerFlip === undefined ? null : pane.textLayerFlip,
        textLayerHow: pane.textLayerHow || null,
      };
    };
    let winBox = null;
    try {
      winBox = {
        w: window.innerWidth,
        h: window.innerHeight,
        visibility: document.visibilityState,
        hidden: document.hidden === true,
      };
    } catch (e) { winBox = null; }
    let browserBox = null;
    try {
      const lb = panes && panes.left && panes.left.browser;
      const rb = panes && panes.right && panes.right.browser;
      browserBox = {
        left: lb ? { w: lb.clientWidth, h: lb.clientHeight } : null,
        right: rb ? { w: rb.clientWidth, h: rb.clientHeight } : null,
      };
    } catch (e) { browserBox = null; }
    return {
      title: A.title || "",
      fontSize,
      syncScroll: syncEnabled(),
      win: winBox,
      browsers: browserBox,
      left: paneInfo(panes && panes.left),
      right: paneInfo(panes && panes.right),
      rightReader: !!(panes && panes.right && panes.right.reader),
      busy,
    };
  };

  /** 供测试/同步断言使用（纯函数导出） */
  window.ppDualUtil = {
    currentPosition, gotoPosition, markPending, ensureTextLayer,
    // 缩放探针（自检/测试用）：读写某栏的缩放倍数
    getScale: (side) => {
      try {
        const pane = panes && panes[side];
        return pane && pane.viewer ? (pane.viewer.viewer.currentScale || 0) : 0;
      } catch (e) { return 0; }
    },
    setScale: (side, v) => {
      try {
        const pane = panes && panes[side];
        if (!pane || !pane.viewer) return false;
        pane.viewer.viewer.currentScale = Number(v);
        return true;
      } catch (e) { return false; }
    },
    __pending: () => ({ left: pendingLeft, right: pendingRight }),
  };

  window.addEventListener("unload", () => {
    try { if (A.onUnload) A.onUnload(); } catch (e) { /* ignore */ }
    panes = null;
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    bindUi();
    run(A);
  } else {
    window.addEventListener("DOMContentLoaded", () => { bindUi(); run(A); }, { once: true });
  }
})();
