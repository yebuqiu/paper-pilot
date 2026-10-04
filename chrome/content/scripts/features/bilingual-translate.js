/* PaperPilot 全文对照翻译（0.11.0，PDF2zh 品类的轻量路线）
 * 不做排版保留（那是 Python/Docker 方案），按段落分段送 LLM。
 *
 * 两个出口（0.25.2）：
 *   ① 双语笔记 —— runForSelected()：逐段「原文引用块 + 译文」写入 Zotero 笔记（上下结构）。
 *   ② 双栏对照窗口 —— openViewerForSelected()：左原文 / 右译文，两栏等宽、随窗口自适应，
 *      段落成对（同一行左右对齐 ⇒ 滚动时行级同步是结构保证的），窄屏自动切单栏。
 *      窗口内亦可一键「导出双语笔记」，与 ① 走同一份正文生成函数（格式零漂移）。
 * 两者共用同一套分段与翻译链路（_chunk / _chunkChars / _translateChunk），
 * 目标语言与系统提示词完全一致 —— 改一处两边都变。
 * 一次一篇（全文翻译属重任务），进度条按段推进。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Notes, I18n, ItemSel */

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

  async _translateChunk(chunk, lang) {
    return AIClient.chat([
      { role: "system", content: Prefs.get("aiSystemPrompt", "") || "" },
      { role: "user", content:
        `请将以下论文片段翻译成${lang}，忠实原文，专业术语保留英文并用括号标注。` +
        "纯文本输出，禁止使用任何 Markdown 标记；只输出译文，不要任何解释。\n\n" + chunk },
    ]);
  },

  _titleOf(item) {
    try { return item.getDisplayTitle() || ""; } catch (e) { return ""; }
  },

  /** 目标语言（与划词浮窗同一口径，改一处两边都变） */
  _targetLang() {
    return Prefs.get("readerPopupTargetLang", "中文") || "中文";
  },

  /** 两个出口的公共前置校验：一次一篇 + AI 已就绪。返回条目或 null */
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
    if (!AIClient.hasKey()) {
      // 0.21.0：区分「未登录官方模型」与「通道缺 Key」，不再用同一条笼统提示
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        AIClient.guidance() || I18n.t("chatNoKey"));
      return null;
    }
    return items[0];
  },

  /** 双语笔记正文（笔记出口与窗口内「导出双语笔记」共用，避免两处格式漂移） */
  _noteMd(pairs, lang) {
    const head = I18n.isZh
      ? `**对照说明**：上为原文（引用块），下为${lang}译文，逐段对应。\n\n`
      : "Source (quote) and translation, paragraph by paragraph.\n\n";
    return head + pairs.map((p) => "> " + p.src + "\n\n" + p.dst).join("\n\n---\n\n");
  },

  /* ---------------- 出口 ①：双语笔记（原有行为，保持不变） ---------------- */

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
      const fullText = await AIChat.getFullText(item);
      if (!fullText) throw new Error("NO_PDF");

      const chunks = this._chunk(fullText, this._chunkChars());

      const pairs = [];
      let done = 0;
      for (const chunk of chunks) {
        const tgt = await this._translateChunk(chunk, lang);
        // 对照格式：引用块原文 + 译文 + 分隔
        pairs.push({ src: chunk.replace(/\n+/g, " ").trim(), dst: String(tgt == null ? "" : tgt).trim() });
        done++;
        progress.setText((I18n.isZh ? "翻译中 " : "Translating ") + done + "/" + chunks.length);
        progress.setProgress(5 + Math.round(done / chunks.length * 90));
        if (done < chunks.length) await new Promise((r) => setTimeout(r, 300));
      }

      await Notes.createFromMarkdown(item, `${I18n.t("noteBilingualTitle")}｜${title}`, this._noteMd(pairs, lang));
      progress.setText(I18n.isZh ? `完成：${chunks.length} 段` : `Done: ${chunks.length} chunks`);
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

  /* ---------------- 出口 ②：双栏对照窗口（0.25.2） ---------------- */

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
      getFullText: () => AIChat.getFullText(item),
      chunkText: (text) => this._chunk(text, this._chunkChars()),
      translateChunk: (chunk) => this._translateChunk(chunk, lang),
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
