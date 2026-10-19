// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 多篇 PDF 并排对比（0.21.0）
 * 目标：同时查看多篇论文的正文、排版与差异，方便找版本区别/图表分布/段落对应。
 *
 * 技术路线（为什么是这个）：
 *   Zotero 9 提供公开接口 `Zotero.Reader.openPreview(itemID, iframe)`，官方用它做
 *   附件悬停预览（chrome/content/zotero/elements/attachmentPreview.js 实证）。
 *   它把阅读器内核（reader.html + pdf.js）直接挂进调用方提供的 <browser>，
 *   因此本插件可以在自建窗口里并排挂 N 个预览实例——这是唯一不重造 PDF 引擎、
 *   又不依赖私有内嵌接口的可行路径。
 *
 *   代价（硬约束，不是偷懒）：
 *   `ReaderPreview._isReadOnly()` 恒返回 true，且 `preview:true` 会跳过文本层
 *   （reader.js 实证 `textLayerMode = preview ? 0 : 1`）——所以对比面板是
 *   **只读且不可划词**的：能看已有高亮/批注、能滚动缩放，但不能在面板内新增标注。
 *   需要标注时经面板头的「在阅读器中打开」跳到正式阅读器（那里功能完整）。
 *
 * 本模块只做 bootstrap 侧的事：解析选中的 PDF 附件、开窗/复用窗口。
 * 窗口内逻辑（布局、同步滚动缩放、面板生命周期）在 chrome/content/compare.js。
 */
/* global Zotero, Services, Prefs, I18n, ItemSel, AIClient, TranslateSvc */

var PdfCompare = {
  WINDOW_TYPE: "papilot:compare",
  WINDOW_URL: "chrome://papilot/content/compare.xhtml",
  WINDOW_NAME: "papilot-compare",

  /** 面板数量上限（pref 可调；4 是"每页仍可读"与"能横向对比"的平衡点） */
  maxPanes() {
    const n = Number(Prefs.get("compareMaxPanes", 4));
    return Math.min(6, Math.max(2, isFinite(n) && n > 0 ? Math.round(n) : 4));
  },

  /** 选中项 → 去重后的 PDF 附件条目（常规条目自动下钻到最佳附件） */
  async collectPdfs(items) {
    const out = [];
    const seen = new Set();
    const isPdf = (x) => !!(x && x.isPDFAttachment && x.isPDFAttachment());
    for (const it of items || []) {
      let att = null;
      try {
        if (isPdf(it)) {
          att = it;
        } else if (it.isRegularItem && it.isRegularItem()) {
          const best = await it.getBestAttachment();
          if (isPdf(best)) {
            att = best;
          } else {
            for (const id of it.getAttachments()) {
              const a = Zotero.Items.get(id);
              if (isPdf(a)) { att = a; break; }
            }
          }
        }
      } catch (e) { /* 单个条目异常不影响其他 */ }
      if (att && !seen.has(att.id)) {
        seen.add(att.id);
        let title = "";
        try { title = att.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        out.push({ id: att.id, title });
      }
    }
    return out;
  },

  /** 当前条目列表选中项 → PDF 附件（窗口内「添加选中文献」按钮回调用） */
  async collectSelectedPdfs() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return [];
    return this.collectPdfs(zp.getSelectedItems() || []);
  },

  /** 已开窗口 → 追加面板；未开窗 → 带着初始面板开窗 */
  async openWith(pdfs) {
    const list = (pdfs || []).slice(0, this.maxPanes());
    try {
      const wm = Services.wm;
      const en = wm.getEnumerator(this.WINDOW_TYPE);
      if (en.hasMoreElements()) {
        const win = en.getNext();
        try { win.focus(); } catch (e) { /* ignore */ }
        // 已开窗口：把新选的 PDF 追加进去（超过上限时由窗口内提示）
        try {
          if (list.length && typeof win.ppCompareAddMany === "function") {
            win.ppCompareAddMany(list);
          }
        } catch (e) { /* ignore */ }
        return win;
      }
      return this._openWindow(list);
    } catch (e) {
      Zotero.logError(new Error("Papilot: 打开 PDF 对比窗口失败"));
      Zotero.logError(e);
      return null;
    }
  },

  /** 菜单/功能中心入口：取当前选中条目 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = zp.getSelectedItems() || [];
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const pdfs = await this.collectPdfs(items);
    if (!pdfs.length) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        I18n.t("compareNoPdf"));
      return;
    }
    if (pdfs.length < 2) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        I18n.t("compareNeedTwo"));
      return;
    }
    const max = this.maxPanes();
    const trimmed = pdfs.slice(0, max);
    if (pdfs.length > max) {
      const notice = I18n.t("compareTrimmed").replace("%n", String(pdfs.length)).replace("%m", String(max));
      try {
        Services.prompt.alert(Zotero.getMainWindow(), "Papilot", notice);
      } catch (e) { /* ignore */ }
    }
    await this.openWith(trimmed);
  },

  _openWindow(list) {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    const payload = {
      Zotero,
      Services,
      panes: list,
      // 窗口脚本访问不到 bootstrap 作用域：解析与 prett 读写统一经这里回传
      resolveSelected: () => this.collectSelectedPdfs(),
      maxPanes: this.maxPanes(),
      prefs: {
        // 默认「各滚各的」：对比时两篇的页码/进度本来就不同，强制联动反而碍事，
        // 需要跟读再在工具栏勾上（0.21.1 及以前默认开）
        syncScroll: Prefs.get("compareSyncScroll", false) === true,
        syncZoom: Prefs.get("compareSyncZoom", false) === true,
        layout: String(Prefs.get("compareLayout", "auto") || "auto"),
      },
      setPref: (key, value) => { try { Prefs.set(key, value); } catch (e) { /* ignore */ } },
      t: (key) => I18n.t(key),
      isZh: !!I18n.isZh,
      // AI 链路只能从 bootstrap 侧调（窗口脚本访问不到 AIClient）——
      // 用于「翻译本页」：0.28.0 起改走 TranslateSvc（尊重用户在「翻译引擎」
      // 里的选择；引擎为 AI 大模型时行为与旧版一致），并与划词浮窗同口径。
      aiStatus: () => {
        try {
          if (AIClient.status() === "ok") return "ok";
        } catch (e) { /* ignore */ }
        // 大模型不可用时，只要有可用的翻译引擎（免费/自备密钥），本页翻译依然可用
        try {
          if (TranslateSvc.available()) return "ok";
        } catch (e) { /* ignore */ }
        return "no_key";
      },
      aiGuidance: () => {
        try {
          if (AIClient.status() === "ok" || TranslateSvc.available()) return "";
          return TranslateSvc.unavailableHint();
        } catch (e) { return ""; }
      },
      // 自检开关同时打开窗口内的事件追踪（窗口脚本读不到 pref，故由此注入）
      trace: Prefs.get("compareSelfTest", false) === true,
      translateText: async (text) => {
        const r = await TranslateSvc.translate(text, { to: TranslateSvc.targetCode() });
        if (!r.ok) throw new Error(r.error);
        return r.text;
      },
    };
    return win.openDialog(
      this.WINDOW_URL,
      this.WINDOW_NAME,
      "chrome,extracz,resizable,dialog=no,centerscreen",
      payload
    );
  },

  /** 窗口关闭时回调（compare.js 卸载时调用），仅用于释放引用 */
  onWindowClosed() { /* 预留：当前无需额外处理 */ },

  /* ---------------- 自检（pref compareSelfTest，默认关） ----------------
   * 这个功能的价值全在「内嵌预览真的挂上了」这一步，而它一旦失败就是静默的
   * （面板空白）——正是本插件历史上最坑的失败模式。故留一个可复现的自检：
   * 开 pref 后下次启动自动取库里前 4 个 PDF 附件开对比窗，12 秒后把每个面板的
   * 加载结果写进 papilot-boot.log。排查「面板空白」时第一时间开它。
   */

  _diag(msg) {
    try {
      if (typeof _ppDiag === "function") { _ppDiag(msg); return; }
    } catch (e) { /* ignore */ }
    try { Zotero.debug("Papilot compare: " + msg); } catch (e) { /* ignore */ }
  },

  async _firstPdfs(n) {
    const out = [];
    try {
      const libID = Zotero.Libraries.userLibraryID;
      // 优先用检索引擎（只回附件，避免把整库条目都载进内存）；失败再退回 getAll
      let ids = [];
      try {
        const s = new Zotero.Search();
        s.libraryID = libID;
        s.addCondition("itemType", "is", "attachment");
        ids = (await s.search()) || [];
      } catch (e) {
        this._diag("selfTest: search failed, falling back to getAll: " + (e && e.message));
        // Zotero.Items.getAll 是 async，且签名是 (libraryID, onlyTopLevel, includeDeleted, asIDs)
        ids = (await Zotero.Items.getAll(libID, false, false, true)) || [];
      }
      if (!ids.length) return out;
      const items = await Zotero.Items.getAsync(ids.slice(0, 4000));
      for (const it of items) {
        try {
          if (it && it.isPDFAttachment && it.isPDFAttachment() && !it.deleted) {
            out.push({ id: it.id, title: it.getDisplayTitle() || "" });
          }
        } catch (e) { /* ignore */ }
        if (out.length >= n) break;
      }
    } catch (e) {
      this._diag("selfTest: enumerate failed: " + (e && e.message));
    }
    return out;
  },

  /** @returns {Promise<Array>} 每个面板的快照，便于在日志里判读 */
  async selfTest() {
    const n = Math.min(4, this.maxPanes());
    const pdfs = await this._firstPdfs(n);
    await this._diag("selfTest: found " + pdfs.length + " PDF attachment(s) in user library");
    if (pdfs.length < 2) {
      await this._diag("selfTest: SKIP (need at least 2 PDFs in the library)");
      return [];
    }
    const win = await this.openWith(pdfs);
    if (!win) { await this._diag("selfTest: FAILED to open compare window"); return []; }
    // 给内嵌读者留出解码时间（本地 PDF 首次解析通常 <2s，大图档更久）
    await new Promise((r) => setTimeout(r, 12000));
    let snap = null;
    try {
      if (typeof win.ppCompareSnapshot === "function") snap = win.ppCompareSnapshot();
    } catch (e) {
      await this._diag("selfTest: snapshot threw: " + (e && e.message));
    }
    await this._diag("selfTest snapshot: " + JSON.stringify(snap));
    try {
      if (typeof win.ppCompareScrollProbe === "function") {
        await this._diag("selfTest scrollProbe: " + JSON.stringify(await win.ppCompareScrollProbe()));
      }
    } catch (e) {
      await this._diag("selfTest: scroll probe threw: " + (e && e.message));
    }
    try {
      if (typeof win.ppCompareNavProbe === "function") {
        await this._diag("selfTest navProbe: " + JSON.stringify(await win.ppCompareNavProbe()));
      }
    } catch (e) {
      await this._diag("selfTest: nav probe threw: " + (e && e.message));
    }
    try { win.close(); } catch (e) { /* ignore */ }
    return snap || [];
  },
};
