/* PaperPilot 全文对照翻译（0.11.0，PDF2zh 品类的轻量路线）
 * 不做排版保留（那是 Python/Docker 方案），按段落分段送 LLM。
 *
 * 两个出口（0.25.2）：
 *   ① 双语笔记 —— runForSelected()：逐段「原文引用块 + 译文」写入 Zotero 笔记（上下结构）。
 *   ② 双栏对照窗口 —— openViewerForSelected()：左原文 / 右译文，两栏等宽、随窗口自适应，
 *      段落成对（同一行左右对齐 ⇒ 滚动时行级同步是结构保证的），窄屏自动切单栏。
 *      窗口内亦可一键「导出双语笔记」，与 ① 走同一份正文生成函数（格式零漂移）。
 * 两者共用同一套分段与翻译链路，目标语言与系统提示词完全一致 —— 改一处两边都变。
 * 一次一篇（全文翻译属重任务），进度条按段推进。
 *
 * 0.33.0 复杂 PDF 优化（ PdfText 模块，chrome/content/scripts/ai/pdf-text.js）：
 *   - 结构化提取（bilingualStructExtract，默认开）：优先走**阅读器路径**
 *     （PDF 已打开时逐页 getPageData，段落自带页码），否则**扁平路径**
 *     （全文索引缓存，词法判定段落类型）。产出的 units 带 kind：
 *     body=正文 / caption=图表注（照常翻译）/ formula=公式（**原样保留不送翻**）；
 *     页眉页脚、页码、DOI、坐标轴刻度这类高置信垃圾行直接丢弃（计数反馈）。
 *   - 上下文感知（bilingualContext，默认开）：每段把「文档标题 + 上一段译文」
 *     作为上下文交给 llm 引擎，保持术语与行文一致；术语表见设置面板（TranslateSvc）。
 *   - 段落级定位：窗口里每个带页码的段落可点击徽标，直接把阅读器跳到对应页；
 *     阅读器未打开时会先打开再定位。
 *   - 关闭结构化提取（设置面板）或提取失败 → 自动回落旧的「扁平切块」路径，行为不回退。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Notes, I18n, ItemSel, TranslateSvc, PdfText */

var BilingualTranslate = {
  WINDOW_TYPE: "paperpilot:bilingual",
  WINDOW_URL: "chrome://paperpilot/content/bilingual.xhtml",
  WINDOW_NAME: "paperpilot-bilingual",

  /**
   * 全文 → 段落块（尽量在段落边界切分，单块不超 maxChars）
   * @returns {string[]}
   */
  _chunk(text, maxChars) {
    const paras = String(text || "").split(/\n{2,}|\r?\n/);
    const chunks = [];
    let cur = "";
    for (const p of paras) {
      const para = p.trim();
      if (!para) continue;
      // 单段超长：硬切
      if (para.length > maxChars) {
        if (cur) { chunks.push(cur); cur = ""; }
        for (let i = 0; i < para.length; i += maxChars) {
          chunks.push(para.slice(i, i + maxChars));
        }
        continue;
      }
      if (cur && (cur.length + para.length + 2) > maxChars) {
        chunks.push(cur);
        cur = para;
      } else {
        cur = cur ? cur + "\n" + para : para;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  },

  /** 分段长度（设置面板可调；下限 400，避免把一段切成太多碎片） */
  _chunkChars() {
    const n = Number(Prefs.get("bilingualChunkChars", 1200));
    return Math.max(400, isFinite(n) && n > 0 ? n : 1200);
  },

  async _translateChunk(chunk, lang, ctx) {
    // 0.28.0：改走 TranslateSvc —— 尊重用户在「翻译引擎」里的选择
    // （AI 大模型引擎行为与旧版一致；也可选 Google/DeepL/百度等专用引擎，
    //  无需登录即可用免费引擎做全文对照翻译）。
    // 0.33.0：ctx = {title, prev} 上下文（仅 llm 引擎消费；bilingualContext 可关）
    const o = { to: TranslateSvc.targetCode() };
    if (ctx && Prefs.get("bilingualContext", true) !== false) o.context = ctx;
    const r = await TranslateSvc.translate(chunk, o);
    if (!r.ok) throw new Error(r.error || "翻译失败");
    return r.text;
  },

  _titleOf(item) {
    try { return item.getDisplayTitle() || ""; } catch (e) { return ""; }
  },

  /** 目标语言（prompt / 笔记抬头用；与划词浮窗同一口径，改一处两边都变） */
  _targetLang() {
    try { return TranslateSvc.targetName() || "中文"; } catch (e) { return "中文"; }
  },

  /** 两个出口的公共前置校验：一次一篇 + 翻译链路可用。返回条目或 null */
  _pickOne() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return null;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return null; }
    if (items.length > 1) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n.isZh ? "全文对照翻译一次请只选一篇" : "Select only one item at a time");
      return null;
    }
    // 0.28.0：不再要求「必须登录 AI」——只要有可用翻译引擎即可
    // （免费引擎开箱即用；引擎为 AI 大模型时这一条等价于旧的 hasKey 判定）
    if (!TranslateSvc.available()) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        TranslateSvc.unavailableHint() || I18n.t("chatNoKey"));
      return null;
    }
    return items[0];
  },

  /* ---------------- 0.33.0 结构化提取（阅读器优先 / 扁平兜底） ---------------- */

  /** 条目 → 翻译单元。返回 {units, via, dropped} 或 null（回落旧扁平切块路径）。
   *  units: [{text, kind: body|caption|formula, page}]（page=0 表示无页码） */
  async _blocksFor(item) {
    if (Prefs.get("bilingualStructExtract", true) === false) return null;
    try {
      const att = await AIChat.getPdfAttachment(item);
      if (!att) return null;
      let r = null;
      // 阅读器路径：PDF 正在打开时逐页取文（段落自带页码）
      try {
        const reader = PdfText.readerForAttachment(att);
        if (reader) r = await PdfText.blocksFromReader(reader);
      } catch (e) { Zotero.logError(e); r = null; }
      // 扁平路径：全文索引缓存（不截断——全文翻译要整篇）
      if (!r || !r.blocks || !r.blocks.length) {
        const full = await AIChat.getFullText(item, { noTruncate: true });
        if (!full) return null;
        const a = PdfText.analyzeText(full);
        r = { blocks: a.blocks, dropped: a.dropped, via: "flat" };
      }
      if (!r.blocks.length) return null;
      const units = PdfText.blocksToUnits(r.blocks, this._chunkChars());
      if (!units.length) return null;
      return { units, via: r.via || "flat", dropped: r.dropped || 0 };
    } catch (e) {
      Zotero.logError(e);
      return null;
    }
  },

  /** units → 笔记/窗口共用的对照对。formula 单元原样直出（不送翻、不占翻译预算）。 */
  async _pairsFromUnits(units, title, onProgress) {
    const pairs = [];
    let prev = "";
    let done = 0;
    for (const u of units) {
      if (u.kind === "formula") {
        pairs.push({ src: u.text.replace(/\n+/g, " ").trim(), dst: u.text, kind: "formula", page: u.page || 0 });
      } else {
        const tgt = await this._translateChunk(u.text, null, { title, prev });
        const dst = String(tgt == null ? "" : tgt).trim();
        pairs.push({ src: u.text.replace(/\n+/g, " ").trim(), dst, kind: u.kind || "body", page: u.page || 0 });
        prev = dst;
      }
      done++;
      if (onProgress) onProgress(done, units.length);
    }
    return pairs;
  },

  /** 双语笔记正文（笔记出口与窗口内「导出双语笔记」共用，避免两处格式漂移）。
   *  formula 对（原文=译文）不进笔记——笔记是「对照译文」，公式没有译文可对照。 */
  _noteMd(pairs, lang) {
    const head = I18n.isZh
      ? `**对照说明**：上为原文（引用块），下为${lang}译文，逐段对应。\n\n`
      : "Source (quote) and translation, paragraph by paragraph.\n\n";
    return head + pairs
      .filter((p) => p.kind !== "formula")
      .map((p) => "> " + p.src + "\n\n" + p.dst).join("\n\n---\n\n");
  },

  /* ---------------- 出口 ①：双语笔记（0.33.0 起走结构化单元） ---------------- */

  /** 菜单/功能中心入口：一次一篇 → 生成上下结构的双语笔记 */
  async runForSelected() {
    const item = this._pickOne();
    if (!item) return;
    const title = this._titleOf(item);
    const lang = this._targetLang();

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + I18n.t("noteBilingualTitle"));
    const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
    pw.show();

    try {
      progress.setText(I18n.isZh ? "读取全文…" : "Reading full text…");
      progress.setProgress(5);

      // 0.33.0：结构化单元（公式直出 / 垃圾行已滤 / 图注单列）；
      // 提取失败回落旧的「全文 → 扁平切块」路径（行为与 0.32 完全一致）
      const blocks = await this._blocksFor(item);
      let pairs;
      if (blocks) {
        progress.setText(I18n.isZh ? "翻译中" : "Translating");
        pairs = await this._pairsFromUnits(blocks.units, title, (done, total) => {
          progress.setText((I18n.isZh ? "翻译中 " : "Translating ") + done + "/" + total);
          progress.setProgress(5 + Math.round(done / total * 90));
        });
      } else {
        const fullText = await AIChat.getFullText(item);
        if (!fullText) throw new Error("NO_PDF");
        const chunks = this._chunk(fullText, this._chunkChars());
        pairs = [];
        let prev = "";
        let done = 0;
        for (const chunk of chunks) {
          const tgt = await this._translateChunk(chunk, lang, { title, prev });
          const dst = String(tgt == null ? "" : tgt).trim();
          pairs.push({ src: chunk.replace(/\n+/g, " ").trim(), dst });
          prev = dst;
          done++;
          progress.setText((I18n.isZh ? "翻译中 " : "Translating ") + done + "/" + chunks.length);
          progress.setProgress(5 + Math.round(done / chunks.length * 90));
          if (done < chunks.length) await new Promise((r) => setTimeout(r, 300));
        }
      }

      await Notes.createFromMarkdown(item, `${I18n.t("noteBilingualTitle")}｜${title}`, this._noteMd(pairs, lang));
      progress.setText(I18n.isZh ? `完成：${pairs.length} 段` : `Done: ${pairs.length} chunks`);
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      progress.setText(e && e.message === "NO_PDF"
        ? I18n.t("chatNoPdf")
        : (I18n.isZh ? "出错：" : "Error: ") + String(e && e.message || e).slice(0, 80));
      Zotero.logError(e);
    }
    pw.startCloseTimer(4000);
  },

  /* ---------------- 出口 ②：双栏对照窗口（0.25.2；0.33.0 支持结构化单元） ---------------- */

  /** 菜单/工作台/功能中心入口：一次一篇 → 打开左右双栏对照窗口 */
  async openViewerForSelected() {
    const item = this._pickOne();
    if (!item) return null;
    return this.openViewer(item);
  },

  /** 打开（或复用）双栏对照窗口 */
  openViewer(item) {
    if (!item) return null;
    const payload = this._viewerPayload(item);

    // 单实例：已开则聚焦并换一篇（正在翻译时窗口自己会拒绝，见 bilingual-view.js）
    try {
      const en = Services.wm.getEnumerator(this.WINDOW_TYPE);
      if (en.hasMoreElements()) {
        const win = en.getNext();
        try { win.focus(); } catch (e) { /* ignore */ }
        try {
          if (typeof win.ppBilingualLoad === "function") win.ppBilingualLoad(payload);
        } catch (e) { /* ignore */ }
        return win;
      }
    } catch (e) { /* ignore */ }

    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      return win.openDialog(
        this.WINDOW_URL,
        this.WINDOW_NAME,
        "chrome,extracz,resizable,dialog=no,centerscreen",
        payload
      );
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 打开双栏对照窗口失败"));
      Zotero.logError(e);
      return null;
    }
  },

  /** 0.33.0 段落级定位：把阅读器跳到 PDF 第 page 页（未打开则先打开再定位） */
  async _locate(item, page) {
    try {
      const att = await AIChat.getPdfAttachment(item);
      if (!att) return false;
      const want = Math.max(1, Math.round(Number(page) || 1));
      let reader = PdfText.readerForAttachment(att);
      if (!reader) {
        try {
          reader = await Zotero.Reader.open(att.id, { pageIndex: want - 1 }, {});
        } catch (e) {
          try { reader = await Zotero.Reader.open(att.id); } catch (e2) { return false; }
        }
        if (!reader) return false;
        // 视图未就绪时直接跳页会拿不到页元素：等一拍再试
        await new Promise((r) => setTimeout(r, 600));
      }
      return !!PdfText.locatePage(reader, want);
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
  },

  /** 窗口载荷：翻译链路一律作为回调注入（窗口脚本访问不到 bootstrap 作用域） */
  _viewerPayload(item) {
    const title = this._titleOf(item);
    const lang = this._targetLang();
    return {
      Zotero,
      Services,
      title,
      lang,
      isZh: !!I18n.isZh,
      t: (key) => I18n.t(key),
      fontSize: this._viewFontSize(),
      layout: this._viewLayout(),
      // 窗口脚本读不到 pref，故由这里注入读写闭包
      setPref: (key, value) => { try { Prefs.set(key, value); } catch (e) { /* ignore */ } },
      // 0.33.0 结构化单元（返回 {units, via, dropped}；失败/关闭时返回 null → 窗口回落旧路径）
      getBlocks: () => this._blocksFor(item),
      // 0.33.0 段落级定位：点击页码徽标跳转阅读器
      locate: (page) => this._locate(item, page),
      getFullText: () => AIChat.getFullText(item),
      chunkText: (text) => this._chunk(text, this._chunkChars()),
      // info = {kind, page, prev, title}：上下文感知（仅 llm 引擎消费）
      translateChunk: (chunk, info) => this._translateChunk(chunk, lang, info || {}),
      makeNote: async (pairs) => {
        await Notes.createFromMarkdown(
          item, `${I18n.t("noteBilingualTitle")}｜${title}`, this._noteMd(pairs, lang));
        return true;
      },
    };
  },

  _viewFontSize() {
    const n = Number(Prefs.get("bilingualViewFontSize", 15));
    return Math.min(28, Math.max(11, isFinite(n) && n > 0 ? Math.round(n) : 15));
  },

  _viewLayout() {
    const v = String(Prefs.get("bilingualViewLayout", "auto") || "auto");
    return (v === "two" || v === "single") ? v : "auto";
  },
};
