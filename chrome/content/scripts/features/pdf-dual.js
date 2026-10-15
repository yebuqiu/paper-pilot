/* PaperPilot PDF 对照翻译 · 左原右译（0.36.0）
 *
 * 产品形态（用户明确要求，取代 0.34.0 的「阅读器内页内叠加」）：
 *   「全文对照翻译」打开一个双栏窗口 —— **左栏 = 原版 PDF 页面**，
 *   **右栏 = 同一页的译文**（同一个 PDF、同一缩放；原文文字被译文按**原文段落坐标**
 *   原位替换，图表与公式图形原样保留）⇒ 两栏逐页、逐段位置严格对应。
 *
 * 分工（本模块 = 插件作用域那一半）：
 *   · 打开/复用窗口（单实例），把 attID、标题、语言与**回调**注入窗口载荷；
 *   · 窗口把两个 ReaderPreview 挂好后回调 onPanesReady → 本模块对**右栏**调用
 *     PdfInline.attach(reader, {mode:"mono"})：提取段落（textLayer 真实坐标，内核已实现）
 *     → 翻译（TranslateSvc：多引擎 + 术语表 + 公式/垃圾行过滤 + 2 路并发 + 缓存）
 *     → 注入译文卡（mono：原文文字隐藏、图形保留）；
 *   · 进度回传窗口（window.ppDualProgress）、导出双语笔记（复用 BilingualTranslate._noteMd）、
 *     重新翻译（清内核缓存后重铺）、字号联动（pdfDualFontScale → 内核 refresh）。
 *
 * 为什么右栏不「另生成一份译文 PDF」：版面/分页/图形天然一致，无需重排引擎与
 * Python 生成链；坐标来自 pdf.js 已渲染的 textLayer（真实 rect），与缩放/DPR 解耦。
 */
/* global Zotero, Services, Prefs, I18n, ItemSel, AIChat, TranslateSvc, PdfText, PdfInline, BilingualTranslate, Notes, PdfExport */

var PdfDual = {
  WINDOW_TYPE: "paperpilot:pdf-dual",
  WINDOW_URL: "chrome://paperpilot/content/pdf-dual.xhtml",
  WINDOW_NAME: "paperpilot-pdf-dual",

  _win: null,          // 最近一次窗口（进度回传用）
  _rightReader: null,  // 右栏 reader（停止/导出时定位内核 state）

  /* ---------------- 前置校验 ---------------- */

  _pickOne() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return null;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return null; }
    if (items.length > 1) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n.isZh ? "PDF 对照翻译一次请只选一篇" : "Select only one item at a time");
      return null;
    }
    if (!TranslateSvc.available()) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        TranslateSvc.unavailableHint() || I18n.t("chatNoKey"));
      return null;
    }
    return items[0];
  },

  async _pdfAttachment(item) {
    try {
      const att = await AIChat.getPdfAttachment(item);
      if (att) return att;
    } catch (e) { /* ignore */ }
    return null;
  },

  /* ---------------- 入口 ---------------- */

  /** 菜单/工作台/功能中心入口：一次一篇 → 打开（或复用）左原右译双栏窗口 */
  async openForSelected() {
    const item = this._pickOne();
    if (!item) return null;
    return this.openForItem(item);
  },

  async openForItem(item) {
    if (!item) return null;
    const att = await this._pdfAttachment(item);
    if (!att) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n.isZh ? "该条目没有可用的 PDF 附件" : "No PDF attachment");
      return null;
    }
    const payload = this._payload(item, att);

    // 单实例：已开则换一篇（正在翻译时窗口侧会拒绝）
    try {
      const en = Services.wm.getEnumerator(this.WINDOW_TYPE);
      if (en.hasMoreElements()) {
        const win = en.getNext();
        this._win = win;
        try { win.focus(); } catch (e) { /* ignore */ }
        try {
          if (typeof win.ppDualLoad === "function") win.ppDualLoad(payload);
        } catch (e) { /* ignore */ }
        return win;
      }
    } catch (e) { /* ignore */ }

    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const w = win.openDialog(
        this.WINDOW_URL,
        this.WINDOW_NAME,
        "chrome,extracz,resizable,dialog=no,centerscreen",
        payload
      );
      this._win = w;
      return w;
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 打开 PDF 对照翻译窗口失败"));
      Zotero.logError(e);
      return null;
    }
  },

  /* ---------------- 载荷（窗口只能经回调访问插件作用域） ---------------- */

  _payload(item, att) {
    const title = (() => {
      try { return item.getDisplayTitle() || ""; } catch (e) { return ""; }
    })();
    return {
      Zotero,
      Services,
      attID: att.id,
      title,
      isZh: !!I18n.isZh,
      t: (key) => I18n.t(key),
      fontScale: this._fontScale(),
      getFontScale: () => this._fontScale(),
      setPref: (key, value) => { try { Prefs.set(key, value); } catch (e) { /* ignore */ } },
      getSyncScroll: () => {
        try { return Prefs.get("pdfDualSyncScroll", true) !== false; } catch (e) { return true; }
      },
      getSyncZoom: () => {
        try { return Prefs.get("pdfDualSyncZoom", true) !== false; } catch (e) { return true; }
      },
      // 两个 pane 挂好后启动右栏译文注入（mono = 译文版页面）
      onPanesReady: (leftReader, rightReader) => this._startRight(leftReader, rightReader, title),
      onUnload: () => this._stopRight(),
      exportNote: () => this.exportNote(item, title),
      // 0.39.0：导出 ▾（pdf=双语PDF附件 / html / md / docx）
      exportAs: (kind) => this.exportAs(kind, item, title),
      retranslate: () => this.retranslate(),
      setFontScale: (v) => this.setFontScale(v),
      translateAll: () => this.translateAll(),
    };
  },

  /**
   * 整篇翻译（窗口「翻译全文」按钮）：逐页滚动触发 pdf.js 渲染 → 抽段落 → 翻译 → 落卡，
   * 进度经 `win.ppDualPhase` 回传。用户左栏阅读位置不受影响（只滚右栏容器）。
   */
  async translateAll(opts) {
    const r = this._rightReader;
    if (!r) return { ok: false, error: "no-reader" };
    const win = this._win;
    const onProgress = (p) => {
      try { if (win && typeof win.ppDualPhase === "function") win.ppDualPhase(p); }
      catch (e) { /* ignore */ }
    };
    const res = await PdfInline.translateAll(r, Object.assign({ onProgress }, opts || {}));
    return res;
  },

  _rightMode() {
    try {
      const v = String(Prefs.get("pdfDualRightMode", "mono") || "mono");
      return v === "overlay" ? "overlay" : "mono";
    } catch (e) { return "mono"; }
  },

  /* ---------------- 右栏：启动 / 停止 / 重译 / 字号 ---------------- */

  _startRight(leftReader, rightReader, title) {
    this._rightReader = rightReader;
    if (!rightReader) return false;
    const onProgress = (p) => {
      try {
        const w = this._win;
        if (w && typeof w.ppDualProgress === "function") w.ppDualProgress(p);
      } catch (e) { /* ignore */ }
    };
    try {
      const ok = PdfInline.attach(rightReader, { mode: this._rightMode(), onProgress });
      this._diagAfterOpen(title);
      return ok;
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
  },

  /** 0.38.1：每次开窗都把「翻转/探测/内核」写进 boot 日志 —— 用户一句「还是无文本层」
   *  就够我们定位（翻转成没成、textLayer 有没有、兜底走了几页），不用再来回问。
   *  「textLayerFlip」= pdf-dual-view 的 textLayerMode 翻转结果；
   *  「right.probe」= 右栏页元素数 / 有 textLayer 的页数；
   *  「kernel」= 内核块数（>0 说明 getPageData 兜底或 textLayer 至少一路成了）。 */
  _diagAfterOpen(title) {
    setTimeout(() => {
      try {
        const w = this._win;
        const snap = (w && typeof w.ppDualSnapshot === "function") ? w.ppDualSnapshot() : null;
        const r = this._rightReader;
        const st = r && PdfInline._states ? PdfInline._states.get(r) : null;
        const d = {
          t: (title || "").slice(0, 24),
          flipL: snap && snap.left ? snap.left.textLayerFlip : null,
          howL: snap && snap.left ? snap.left.textLayerHow : null,
          flipR: snap && snap.right ? snap.right.textLayerFlip : null,
          howR: snap && snap.right ? snap.right.textLayerHow : null,
          probeR: snap && snap.right ? snap.right.probe : null,
          kernelBlocks: st ? st.blockCount : (st === null ? "no-state" : 0),
          noTextPages: st ? st.noTextPages.length : null,
        };
        try { _ppDiag("pdfDual open diag: " + JSON.stringify(d)); } catch (e) { /* ignore */ }
      } catch (e) { /* ignore */ }
    }, 10000);
  },

  _stopRight() {
    const r = this._rightReader;
    this._rightReader = null;
    if (!r) return;
    try { PdfInline.stop(r, { keepPref: true }); } catch (e) { /* ignore */ }
  },

  /** 重新翻译：清内核文本缓存 + 重铺（§ 不重启窗口） */
  retranslate() {
    try {
      if (PdfInline._textCache && PdfInline._textCache.clear) PdfInline._textCache.clear();
    } catch (e) { /* ignore */ }
    try { TranslateSvc.clearCache(); } catch (e) { /* ignore */ }
    try { PdfInline.refresh(); } catch (e) { /* ignore */ }
  },

  /** 字号 = 相对原文字号的倍数（内核 PdfInline 读的就是 pdfInlineFontScale） */
  setFontScale(v) {
    const n = Math.min(1.6, Math.max(0.7, Math.round((Number(v) || 1) * 10) / 10));
    try { Prefs.set("pdfInlineFontScale", String(n)); } catch (e) { /* ignore */ }
    try { PdfInline.refresh(); } catch (e) { /* ignore */ }
  },

  _fontScale() {
    try {
      const n = Number(Prefs.get("pdfInlineFontScale", "1"));
      return isFinite(n) && n > 0 ? Math.min(1.6, Math.max(0.7, n)) : 1;
    } catch (e) { return 1; }
  },

  /* ---------------- 导出双语笔记（复用既有正文生成，格式零漂移） ---------------- */

  async exportNote(item, title) {
    try {
      const r = this._rightReader;
      const states = (PdfInline && PdfInline._states) || null;
      const st = (states && r && states.get(r)) || null;
      const pairs = [];
      if (st && st.pageBlocks) {
        const nums = Array.from(st.pageBlocks.keys()).sort((a, b) => Number(a) - Number(b));
        for (const n of nums) {
          for (const b of (st.pageBlocks.get(n) || [])) {
            if (b.kind === "formula") continue;
            if (b.dst == null || b.failed) continue;
            pairs.push({ src: String(b.text || "").replace(/\s+/g, " ").trim(), dst: b.dst, kind: b.kind });
          }
        }
      }
      if (!pairs.length) return { ok: false, error: I18n.isZh ? "还没有可导出的译文" : "Nothing to export yet" };
      const md = BilingualTranslate._noteMd(pairs, TranslateSvc.targetName() || "中文");
      await Notes.createFromMarkdown(item, `${I18n.t("noteBilingualTitle")}｜${title}`, md);
      return { ok: true, count: pairs.length };
    } catch (e) {
      Zotero.logError(e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  },

  /**
   * 导出（0.39.0）：双语 PDF 附件 / HTML / Markdown / Word。
   * PDF 出口把右栏已渲染页的 canvas + 译文原位叠画 → 自建 PDF → 作为附件挂到条目下；
   * 其余三种写文件（文件选择器）。全部实现在 features/pdf-export.js（纯函数可单测）。
   */
  async exportAs(kind, item, title) {
    try {
      const r = this._rightReader;
      if (!r) return { ok: false, error: "no-reader" };
      if (typeof PdfExport === "undefined" || !PdfExport) {
        return { ok: false, error: "PdfExport 未加载" };
      }
      const res = await PdfExport.exportAs(kind, { item, reader: r, title });
      if (res && res.ok && kind === "pdf") {
        // 新附件要立刻出现在条目下：刷新条目树
        try {
          if (item && item.id && Zotero.ItemTreeManager && Zotero.ItemTreeManager.refresh) {
            Zotero.ItemTreeManager.refresh();
          }
        } catch (e) { /* ignore */ }
      }
      return res || { ok: false, error: "unknown" };
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return { ok: false, error: String((e && e.message) || e) };
    }
  },

  /* ---------------- 自检（真实 PDF 上验左右栏与段落注入） ---------------- */

  /**
   * 自检（pref `pdfDualSelfTest`，默认关）：拿库里第一个 PDF 开一次对照窗口，
   * 等右栏翻译若干秒后把「左/右 pane 是否挂上、右栏每页段落数与卡片数、同步滚动位置」
   * 写进 boot 日志（main.js 调用）。迷你 DOM 测不到 pdf.js 真实渲染，这类问题只能实机验。
   * @param {number} waitMs 挂载等待上限
   * @param {number} [attID] 指定附件 itemID（pref pdfDualSelfTestAtt；0 = 扫库取第一个）
   * @returns {Promise<object>} 诊断对象（永不抛异常）
   */
  async selfTest(waitMs, attID) {
    const out = { ok: false };
    try {
      let att = null;
      if (attID) {
        // 指定附件（排障用：直指用户报告的那篇，如双栏 PDF）
        try { att = Zotero.Items.get(Number(attID)); } catch (e) { att = null; }
        if (!att || !(att.isPDFAttachment && att.isPDFAttachment())) {
          out.error = "pdfDualSelfTestAtt not a pdf attachment";
          return out;
        }
      }
      if (!att) {
        let all = [];
        let attempt = 0;
        const lib = Zotero.Libraries && Zotero.Libraries.userLibraryID;
        for (; attempt < 25; attempt++) {
          // ⚠️ Zotero 10 的 Items.getAll 是 async（必须 await）；onlyTopLevel 必须为 false
          let raw = null;
          try { raw = await Zotero.Items.getAll(lib, false, false); } catch (e) { raw = null; }
          all = Array.prototype.slice.call(raw || []);
          if (all.length) break;
          await new Promise((r) => setTimeout(r, 800));
        }
        for (const it of all) {
          if (it && it.isPDFAttachment && it.isPDFAttachment()) { att = it; break; }
        }
        if (!att) { out.error = "no-pdf-attachment-in-library"; return out; }
        out.itemsScanned = all.length;
      }
      out.attachmentID = att.id;
      try { out.attTitle = (att.getDisplayTitle() || "").slice(0, 40); } catch (e) { /* ignore */ }
      const parent = (() => {
        try { return att.parentItemID ? Zotero.Items.get(att.parentItemID) : att; } catch (e) { return att; }
      })();
      const win = await this.openForItem(parent);
      out.windowOpened = !!win;
      // 真实使用是「用户点菜单打开 → 窗口在前台」；自检必须模拟这一点，
      // 否则预览在后台窗口里可能迟迟不挂载（首轮自检实测 left/right 均未 mounted）
      try { if (win && win.focus) win.focus(); } catch (e) { /* ignore */ }
      // 轮询等「两个 pane 都挂上」——reader preview 在窗口未聚焦/后台时加载慢，
      // 固定等待会把「还在加载」误判成失败（0.36.0 首轮自检实测：25s 时 busy 仍为 true）
      const deadline = Date.now() + (waitMs || 45000);
      let snap = null;
      while (Date.now() < deadline) {
        snap = (win && typeof win.ppDualSnapshot === "function") ? win.ppDualSnapshot() : null;
        if (snap && snap.left && snap.left.mounted && snap.right && snap.right.mounted) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      out.snapshot = snap;
      // 挂载后等 pdf.js 真正渲染出可见页（自检环境窗口可能迟迟未布局 →
      // textLayer 不产出 → 内核自然抓不到段落；这段时间给足 30 秒）
      {
        const deadlineR = Date.now() + 30000;
        while (Date.now() < deadlineR) {
          const st0 = this._kernelState();
          if (st0 && st0.pages && st0.pages.size > 0) break;
          const snapNow = (win && typeof win.ppDualSnapshot === "function") ? win.ppDualSnapshot() : null;
          const pr = snapNow && snapNow.right && snapNow.right.probe;
          if (pr && pr.withTextLayer > 0) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      // 挂载后再给翻译一点时间（只等「有段落且已译完」，最多 25 秒）
      const tStart = Date.now();
      let tFirstCard = 0;
      const deadline2 = Date.now() + 25000;
      for (;;) {
        const st0 = this._kernelState();
        if (!tFirstCard && st0 && st0.blockCount > 0) tFirstCard = Date.now() - tStart;
        if (st0 && st0.blockCount > 0 && st0.doneCount >= st0.blockCount) break;
        if (Date.now() > deadline2) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      // ★ 0.38.3：首屏出译文耗时（ms）—— 直接量化用户说的「解析很慢」是否解决
      out.firstBlocksMs = tFirstCard || null;
      out.snapshot = (win && typeof win.ppDualSnapshot === "function") ? win.ppDualSnapshot() : snap;
      out.windowOpened = !!win;
      const r = this._rightReader;
      const states = (PdfInline && PdfInline._states) || null;
      const st = (states && r && states.get(r)) || null;
      if (st) {
        out.kernel = this._kernelSnapshot(st);
        out.pages = [];
        for (const [num, blocks] of st.pageBlocks) {
          const list = blocks || [];
          out.pages.push({
            page: num,
            blocks: list.filter((b) => b.kind !== "formula").length,
            kinds: list.map((b) => b.kind).join(",").slice(0, 50),
            cards: list.filter((b) => b.cardEl).length,
          });
          if (out.pages.length >= 5) break;
        }
      }
      out.ok = !!(snap && snap.left && snap.left.mounted && snap.right && snap.right.mounted &&
        st && st.blockCount > 0);

      // ---- 端到端验证：让内核「整篇翻译」（逐页滚动触发渲染 → 抽段 → 翻译 → 落卡）。
      //  这是唯一不依赖窗口可见性的全量验证路径：即使自检环境里预览窗口被判为不可见
      //  （容器 clientHeight 为 0 → pdf.js 一页都不渲染），逐页滚动仍能驱动渲染。
      if (!out.ok) {
        out.wholeDoc = await this.translateAll({ maxPages: 8, keepScroll: true });
        const st3 = this._kernelState();
        if (st3) {
          out.wholeDocKernel = this._kernelSnapshot(st3);
          out.wholeDocPages = [];
          for (const [num, blocks] of st3.pageBlocks) {
            const list = blocks || [];
            out.wholeDocPages.push({
              page: num,
              blocks: list.filter((b) => b.kind !== "formula").length,
              kinds: list.map((b) => b.kind).join(",").slice(0, 40),
              cards: list.filter((b) => b.cardEl).length,
            });
            if (out.wholeDocPages.length >= 8) break;
          }
          out.ok = out.wholeDocKernel.blocks > 0;
        }
      }

      // ---- 回退验证（自检环境限制）：无头/后台窗口里 pdf.js 不渲染页面内容
      //   （探测显示两栏 pageEls>0 但 withTextLayer=0 —— 左栏原版同样如此），
      //   于是「右栏段落/落卡」拿不到。此时改在主窗口打开真实 reader（可见 → 会渲染），
      //   对同一个内核做一次端到端验证：提取段落 → 翻译 → 注入 mono 卡片。
      if (!out.ok) {
        const pr = snap && snap.right && snap.right.probe;
        if (!pr || !pr.withTextLayer) {
          out.fallback = "preview-not-rendered (window not visible in self-test)";
          try {
            const r2 = await Zotero.Reader.open(att.id);
            try {
              if (r2 && r2.tabID && typeof Zotero_Tabs !== "undefined" && Zotero_Tabs.select) {
                Zotero_Tabs.select(r2.tabID);
              }
            } catch (e) { /* ignore */ }
            for (let i = 0; i < 20; i++) {
              if (PdfText.viewerOf(r2)) break;
              await new Promise((r) => setTimeout(r, 700));
            }
            PdfInline.attach(r2, { mode: "mono" });
            for (let i = 0; i < 30; i++) {
              const s2 = (PdfInline._states || new Map()).get(r2);
              if (s2 && s2.blockCount > 0 && s2.doneCount >= s2.blockCount) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
            const s2 = (PdfInline._states || new Map()).get(r2);
            if (s2) {
              out.fallbackKernel = this._kernelSnapshot(s2);
              out.fallbackPages = [];
              for (const [num, blocks] of s2.pageBlocks) {
                const list = blocks || [];
                out.fallbackPages.push({
                  page: num,
                  blocks: list.filter((b) => b.kind !== "formula").length,
                  kinds: list.map((b) => b.kind).join(",").slice(0, 40),
                  cards: list.filter((b) => b.cardEl).length,
                  sample: (list.find((b) => b.dst) || {}).dst ?
                    String((list.find((b) => b.dst) || {}).dst).slice(0, 30) : "",
                });
                if (out.fallbackPages.length >= 4) break;
              }
              out.ok = out.fallbackKernel.blocks > 0;
            }
            try { PdfInline.stop(r2, { keepPref: true }); } catch (e) { /* ignore */ }
            try { if (r2 && r2.tabID) Zotero_Tabs.close(r2.tabID); } catch (e) { /* ignore */ }
          } catch (e) {
            out.fallbackError = String((e && e.message) || e);
          }
        }
      }
      // ---- 缩放探针（0.38.2）：**等轮询过期后**再放大右栏 1.4×（复现用户
      //  「读了一会儿再缩放」的最恶劣场景——轮询已死、事件链不可靠），
      //  验证 scalechanging 保底重铺：卡片几何应换算到新比例。
      try {
        const w = this._win;
        const r = this._rightReader;
        const stOf = () => (r && PdfInline._states ? PdfInline._states.get(r) : null);
        const cardsOf = (st) => {
          if (!st) return -1;
          let n = 0;
          for (const [, bs] of st.pageBlocks) for (const b of (bs || [])) {
            if (b.kind !== "formula" && b.cardEl && b.cardEl.isConnected) n++;
          }
          return n;
        };
        const cardGeo = (st) => {
          if (!st) return null;
          for (const [, bs] of st.pageBlocks) {
            const b = (bs || []).find((x) => x.cardEl && x.cardEl.isConnected);
            if (b) return { top: b.cardEl.style.top, left: b.cardEl.style.left, w: b.cardEl.style.width, fs: b.cardEl.style.fontSize };
          }
          return null;
        };
        // 等轮询自然过期（bindPoll 60×900ms ≈ 54s；给到 80s）
        const deadlinePoll = Date.now() + 80000;
        while (Date.now() < deadlinePoll) {
          const s = stOf();
          if (!s || s.pollTimer == null) break;
          await new Promise((r2) => setTimeout(r2, 1000));
        }
        const st0 = stOf();
        const scale0 = (w && typeof w.ppDualUtil.getScale === "function") ? w.ppDualUtil.getScale("right") : 0;
        out.zoomProbe = {
          pollExpired: !!(st0 && st0.pollTimer == null),
          scaleBefore: scale0, cardsBefore: cardsOf(st0), cardBefore: cardGeo(st0),
          procBefore: st0 ? (st0.procCount || 0) : -1,
        };
        if (w && typeof w.ppDualUtil.setScale === "function") w.ppDualUtil.setScale("right", (scale0 || 1) * 1.4);
        await new Promise((r2) => setTimeout(r2, 6000));
        const snapZ = (w && typeof w.ppDualSnapshot === "function") ? w.ppDualSnapshot() : null;
        const st1 = stOf();
        out.zoomProbe.scaleAt140 = (w && w.ppDualUtil.getScale) ? w.ppDualUtil.getScale("right") : 0;
        out.zoomProbe.cardsAfterZoom = cardsOf(st1);
        out.zoomProbe.procAfterZoom = st1 ? (st1.procCount || 0) : -1;
        out.zoomProbe.probeR = snapZ && snapZ.right ? snapZ.right.probe : null;
        out.zoomProbe.boxR = snapZ && snapZ.right ? snapZ.right.box : null;
        out.zoomProbe.cardAfter = cardGeo(st1);
        out.zoomProbe.noTextPages = st1 ? st1.noTextPages.length : null;
        // 还原
        if (w && typeof w.ppDualUtil.setScale === "function") w.ppDualUtil.setScale("right", scale0 || 1);
        await new Promise((r2) => setTimeout(r2, 4000));
        const st2 = stOf();
        out.zoomProbe.cardsAfterRestore = cardsOf(st2);
        out.zoomProbe.procAfterRestore = st2 ? (st2.procCount || 0) : -1;
      } catch (e) {
        out.zoomProbe = out.zoomProbe || {};
        out.zoomProbe.error = String((e && e.message) || e);
      }

      // ---- 空闲性能探针（0.38.3）：静置 8 秒统计「空转」——0.38.2 时轮询每拍都对
      //  无 textLayer 的页重发 getPageData + 重铺卡片（用户实测「很卡、解析很慢」）。
      //  修好后这两个计数在静置期应**零增长**。
      try {
        const stP = (r && PdfInline._states) ? PdfInline._states.get(r) : null;
        if (stP && stP.stat) {
          const s0 = { fetch: stP.stat.charFetches || 0, charR: stP.stat.charRenders || 0, textR: stP.stat.textRenders || 0, proc: stP.procCount || 0 };
          await new Promise((r2) => setTimeout(r2, 8000));
          const stP2 = PdfInline._states.get(r);
          const s1 = stP2 && stP2.stat ? { fetch: stP2.stat.charFetches || 0, charR: stP2.stat.charRenders || 0, textR: stP2.stat.textRenders || 0, proc: stP2.procCount || 0 } : null;
          out.idleProbe = {
            before: s0, after: s1,
            dFetch: s1 ? s1.fetch - s0.fetch : null,
            dCharRender: s1 ? s1.charR - s0.charR : null,
            dProc: s1 ? s1.proc - s0.proc : null,
            idleSeconds: 8,
          };
        }
      } catch (e) {
        out.idleProbe = { error: String((e && e.message) || e) };
      }

      // ---- 导出探针（0.39.0）：四条出口都真跑一遍，产物写临时目录（不动用户库）——
      //  验证「canvas 叠画 → JPEG → 自建 PDF」「HTML/Markdown 文本」「OOXML+zip → docx」
      //  在真实引擎里能闭环；页数/字节数写进 boot 日志。
      try {
        const r = this._rightReader;
        const tmpDir = (typeof PathUtils !== "undefined" && PathUtils.tempDir) ? PathUtils.tempDir : null;
        if (r && tmpDir && typeof PdfExport !== "undefined" && PdfExport) {
          const stamp = Date.now();
          // 探针一律走 outPath（只落盘，不挂附件）→ 不需要 item
          out.exportProbe = {};
          const pdfPath = PathUtils.join(tmpDir, "pp-exp-" + stamp + ".pdf");
          const htmlPath = PathUtils.join(tmpDir, "pp-exp-" + stamp + ".html");
          const mdPath = PathUtils.join(tmpDir, "pp-exp-" + stamp + ".md");
          const docxPath = PathUtils.join(tmpDir, "pp-exp-" + stamp + ".docx");
          const ctx = {
            item: null, reader: r, outPath: null,
            title: (snap && snap.title) || out.attTitle || "paper",
          };
          // PDF（自建生成器 + canvas 捕获）
          try {
            out.exportProbe.pdf = await PdfExport.exportAs("pdf", Object.assign({}, ctx, { outPath: pdfPath }));
          } catch (e) { out.exportProbe.pdf = { ok: false, error: String((e && e.message) || e) }; }
          // HTML
          try {
            out.exportProbe.html = await PdfExport.exportAs("html", Object.assign({}, ctx, { outPath: htmlPath }));
          } catch (e) { out.exportProbe.html = { ok: false, error: String((e && e.message) || e) }; }
          // Markdown
          try {
            out.exportProbe.md = await PdfExport.exportAs("md", Object.assign({}, ctx, { outPath: mdPath }));
          } catch (e) { out.exportProbe.md = { ok: false, error: String((e && e.message) || e) }; }
          // Word（OOXML + zipDirectory）
          try {
            out.exportProbe.docx = await PdfExport.exportAs("docx", Object.assign({}, ctx, { outPath: docxPath }));
          } catch (e) { out.exportProbe.docx = { ok: false, error: String((e && e.message) || e) }; }
          // 产物大小（证明真的写到磁盘了）
          try {
            const sizes = {};
            for (const [k, p] of [["pdf", pdfPath], ["html", htmlPath], ["md", mdPath], ["docx", docxPath]]) {
              try { sizes[k] = (await IOUtils.stat(p)).size; } catch (e) { sizes[k] = -1; }
            }
            out.exportProbe.sizes = sizes;
          } catch (e) { /* ignore */ }

          // ---- ★ 0.41.1：真「附件」路径验证（建后立即删，不留痕迹）----
          //  0.39.0 的自检只验了 outPath 落盘路径，**没验 Zotero.Attachments.importFromFile**
          //  （当时为不污染用户库而刻意绕过）→ 附件路径的问题（如菜单事件不触发）测不出来。
          //  这里真的挂一次附件、回读确认，再 eraseTx 删掉。
          try {
            const parent = (() => {
              try { return att && att.parentItemID ? Zotero.Items.get(att.parentItemID) : att; }
              catch (e) { return null; }
            })();
            if (parent) {
              const res = await PdfExport.exportAs("pdf", {
                item: parent, reader: r,
                title: (snap && snap.title) || out.attTitle || "paper",
              });
              out.exportProbe.attach = {
                ok: !!(res && res.ok),
                error: (res && res.error) || null,
                attachmentID: (res && res.attachmentID) || null,
                pages: (res && res.pages) || null,
              };
              if (res && res.ok && res.attachmentID) {
                let title = "";
                let erased = false;
                try {
                  const made = Zotero.Items.get(res.attachmentID);
                  if (made) {
                    title = String(made.getField("title") || "");
                    out.exportProbe.attachIsPDF = !!(made.isPDFAttachment && made.isPDFAttachment());
                    out.exportProbe.attachFile = (() => {
                      try { return PathUtils.filename(made.getFilePath() || ""); } catch (e) { return ""; }
                    })();
                    await made.eraseTx();
                    erased = true;
                  }
                } catch (e) {
                  out.exportProbe.attachEraseError = String((e && e.message) || e);
                }
                out.exportProbe.attachTitle = title;
                out.exportProbe.attachErased = erased;   // 不回读为 true 就会留下垃圾附件
              }
            } else {
              out.exportProbe.attach = { ok: false, error: "no-parent-item" };
            }
          } catch (e) {
            out.exportProbe.attach = { ok: false, error: String((e && e.message) || e) };
          }

          // ---- ★ 0.41.1：UI 链路探针 —— 合成 command 事件走「菜单 → 窗口 → 插件」全链 ----
          //  本次 bug 就出在这一环（XUL menulist 发 command，代码却只绑了 change）。
          //  dryRun 只验链路，不真导出（否则会弹文件选择器卡住自检）。
          try {
            const w = this._win;
            const doc = w && w.document;
            const sel = doc && doc.getElementById ? doc.getElementById("pp-pd-export") : null;
            if (sel) {
              const s0 = (w.ppDualExportStats && w.ppDualExportStats.calls) || 0;
              w.ppDualExportDryRun = true;
              try { sel.value = "md"; } catch (e) { /* ignore */ }
              try {
                const Ev = w.Event || (w.CustomEvent);
                sel.dispatchEvent(new Ev("command", { bubbles: true }));
              } catch (e) {
                out.exportProbe.uiEventError = String((e && e.message) || e);
              }
              await new Promise((r2) => setTimeout(r2, 300));
              const s1 = (w.ppDualExportStats && w.ppDualExportStats.calls) || 0;
              out.exportProbe.uiCommand = {
                before: s0, after: s1, fired: s1 > s0,
                lastKind: (w.ppDualExportStats && w.ppDualExportStats.last) || null,
              };
              w.ppDualExportDryRun = false;
            } else {
              out.exportProbe.uiCommand = { fired: false, error: "menulist not found" };
            }
          } catch (e) {
            out.exportProbe.uiCommand = { fired: false, error: String((e && e.message) || e) };
          }
        }
      } catch (e) {
        out.exportProbe = { error: String((e && e.message) || e) };
      }

      // 自检不改用户偏好：停掉本次注入
      this._stopRight();
      return out;
    } catch (e) {
      out.error = String((e && e.message) || e);
      return out;
    }
  },

  /** 右栏内核 state（自检/排障） */
  _kernelState() {
    const r = this._rightReader;
    const states = (PdfInline && PdfInline._states) || null;
    return (states && r && states.get(r)) || null;
  },

  _kernelSnapshot(st) {
    return {
      mode: st.mode || null,
      active: !!st.active,
      pages: st.pages ? st.pages.size : 0,
      blocks: st.blockCount,
      done: st.doneCount,
      noTextPages: st.noTextPages ? st.noTextPages.length : 0,
      proc: st.procCount || 0,
      stat: st.stat ? { fetch: st.stat.charFetches || 0, charR: st.stat.charRenders || 0, textR: st.stat.textRenders || 0 } : null,
    };
  },
};
