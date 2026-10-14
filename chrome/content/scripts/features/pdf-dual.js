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
/* global Zotero, Services, Prefs, I18n, ItemSel, AIChat, TranslateSvc, PdfText, PdfInline, BilingualTranslate, Notes */

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
      retranslate: () => this.retranslate(),
      setFontScale: (v) => this.setFontScale(v),
    };
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
      return PdfInline.attach(rightReader, { mode: this._rightMode(), onProgress });
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
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

  /* ---------------- 自检（真实 PDF 上验左右栏与段落注入） ---------------- */

  /**
   * 自检（pref `pdfDualSelfTest`，默认关）：拿库里第一个 PDF 开一次对照窗口，
   * 等右栏翻译若干秒后把「左/右 pane 是否挂上、右栏每页段落数与卡片数、同步滚动位置」
   * 写进 boot 日志（main.js 调用）。迷你 DOM 测不到 pdf.js 真实渲染，这类问题只能实机验。
   * @returns {Promise<object>} 诊断对象（永不抛异常）
   */
  async selfTest(waitMs) {
    const out = { ok: false };
    try {
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
      let att = null;
      for (const it of all) {
        if (it && it.isPDFAttachment && it.isPDFAttachment()) { att = it; break; }
      }
      if (!att) { out.error = "no-pdf-attachment-in-library"; return out; }
      out.itemsScanned = all.length;
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
      const deadline2 = Date.now() + 25000;
      for (;;) {
        const st0 = this._kernelState();
        if (st0 && st0.blockCount > 0 && st0.doneCount >= st0.blockCount) break;
        if (Date.now() > deadline2) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
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
    };
  },
};
