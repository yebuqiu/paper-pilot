/* PaperPilot PDF 全文提取 + 问答逻辑 */
/* global Zotero, IOUtils, Prefs, AIClient, TranslateSvc, I18n */

var AIChat = {
  // 附件全文缓存（存未截断原文，截断在使用时按当前 pref 值进行；FIFO 淘汰）
  _textCache: new Map(),
  _CACHE_LIMIT: 20,

  /** 取条目的最佳 PDF 附件 */
  async getPdfAttachment(item) {
    if (!item) return null;
    if (item.isPDFAttachment && item.isPDFAttachment()) return item;
    if (item.isRegularItem && item.isRegularItem()) {
      try {
        const best = await item.getBestAttachment();
        if (best && best.attachmentContentType === "application/pdf") return best;
      } catch (e) { /* fallthrough */ }
      // 兜底：遍历附件找 PDF
      try {
        for (const id of item.getAttachments()) {
          const att = Zotero.Items.get(id);
          if (att && att.attachmentContentType === "application/pdf") return att;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  },

  /** 读 Zotero 全文索引内容：Z9 及以前走 getItemContent，Z10 读 .zotero-ft-cache 缓存文件 */
  async _readIndexedText(att) {
    // 触发索引（已索引会很快返回）
    try {
      await Zotero.FullText.indexItems([att.id]);
    } catch (e) {
      Zotero.debug("PaperPilot: 全文索引失败，尝试读取已有内容 " + e);
    }
    // Zotero 9 及以前
    if (typeof Zotero.FullText.getItemContent === "function") {
      const result = await Zotero.FullText.getItemContent(att.id);
      return (typeof result === "string" ? result : (result && result.content) || "");
    }
    // Zotero 10：getItemContent 已删除（FTS5 重写），全文内容在附件存储目录的
    // .zotero-ft-cache；getItemCacheFile(item) 返回 nsIFile（Z10 源码实证）
    if (typeof Zotero.FullText.getItemCacheFile === "function") {
      const cacheFile = Zotero.FullText.getItemCacheFile(att);
      const path = typeof cacheFile === "string" ? cacheFile : cacheFile && cacheFile.path;
      if (!path) return "";
      let exists = false;
      try {
        exists = typeof cacheFile === "string" ? await IOUtils.exists(path) : cacheFile.exists();
      } catch (e) { /* 按不存在处理 */ }
      if (!exists) return "";
      try {
        return await Zotero.File.getContentsAsync(path) || "";
      } catch (e) {
        try { return await IOUtils.readUTF8(path); } catch (e2) { return ""; }
      }
    }
    throw new Error("当前 Zotero 版本没有可用的全文读取接口");
  },

  /** 提取 PDF 全文（Zotero 内置全文索引），按当前 pref 截断 */
  async getFullText(item) {
    const att = await this.getPdfAttachment(item);
    if (!att) return null;

    let raw = this._textCache.get(att.id);
    if (raw === undefined) {
      let text;
      try {
        text = await this._readIndexedText(att);
      } catch (e) {
        Zotero.logError(e);
        return null;
      }
      raw = (text || "").replace(/\s+\n/g, "\n").trim();
      if (!raw) return null; // 空结果不缓存，OCR 后可重试
      if (this._textCache.size >= this._CACHE_LIMIT) {
        this._textCache.delete(this._textCache.keys().next().value);
      }
      this._textCache.set(att.id, raw);
    }
    if (!raw) return null;

    const max = Number(Prefs.get("aiFullTextMaxChars", 16000)) || 16000;
    if (raw.length > max) {
      // 头 2/3 + 尾 1/3，保住摘要与结论
      const head = Math.floor(max * 2 / 3);
      return raw.slice(0, head) + "\n\n[……中间内容已截断……]\n\n" + raw.slice(-(max - head));
    }
    return raw;
  },

  paperMeta(item) {
    const get = (f) => {
      try { return item.getField(f) || ""; } catch (e) { return ""; }
    };
    let creators = "";
    try {
      creators = (item.getCreators() || [])
        .map(c => [c.firstName, c.lastName].filter(Boolean).join(" ")).join(", ");
    } catch (e) { /* 附件无 creators */ }
    return {
      title: get("title"),
      creators,
      year: get("date").slice(0, 4),
      pub: get("publicationTitle"),
    };
  },

  /**
   * 0.31.0：对话消息构造（单源）。悬浮窗与分屏窗口共用的构造器，
   * 与 ask() 的差异：全文拿不到时**回退摘要**并在上下文里声明依据有限
   * （对齐 askTask 的口径，用户在浮窗里就标题/摘要追问不至于直接报错）。
   * @param item 条目 @param question 本轮问题 @param history [{role,content}]
   * @param fullText 可选；不传或 null 时自动 getFullText，仍为空则回退 abstractNote
   */
  async buildMessages(item, question, history = [], fullText) {
    if (fullText === undefined || fullText === null) {
      fullText = await this.getFullText(item);
    }
    const meta = this.paperMeta(item);
    let context;
    if (fullText) {
      context = `【论文全文】\n${fullText}`;
    } else {
      let abstract = "";
      try { abstract = item.getField("abstractNote") || ""; } catch (e) { /* ignore */ }
      if (!abstract.trim()) throw new Error("NO_PDF");
      context =
        `【论文摘要】（说明：未获取到该文献的 PDF 全文，请仅基于摘要与题录信息回答，并在开头注明依据有限）\n${abstract}`;
    }
    const messages = [{ role: "system", content: this._systemWith(meta, context) }];
    // 与 ask() 同口径：只带最近 6 轮历史，控制 token
    messages.push(...history.slice(-12));
    messages.push({ role: "user", content: question });
    return messages;
  },

  /**
   * 基于 PDF 全文回答一个问题
   * @param item Zotero 常规条目（或其 PDF 附件）
   * @param question 用户问题
   * @param history 之前的对话 [{role, content}]（不含本轮）
   */
  async ask(item, question, history = []) {
    const fullText = await this.getFullText(item);
    if (!fullText) throw new Error("NO_PDF");

    const meta = this.paperMeta(item);
    const system = this._systemWith(meta, `【论文全文】\n${fullText}`);

    const messages = [{ role: "system", content: system }];
    // 只带最近 6 轮历史，控制 token
    messages.push(...history.slice(-12));
    messages.push({ role: "user", content: question });

    return AIClient.chat(messages);
  },

  _systemWith(meta, contextBlock) {
    return (Prefs.get("aiSystemPrompt", "") || "") +
      `\n\n当前用户正在阅读以下论文，请只基于该论文内容回答；论文中没有的信息请明确说明，不要编造：\n` +
      `标题：${meta.title}\n作者：${meta.creators}\n发表：${meta.pub} ${meta.year}\n\n` +
      contextBlock;
  },

  /**
   * 任务型提问（总结/解读）：优先 PDF 全文；
   * 无全文时回退用标题 + 摘要字段回答，并在上下文中声明依据有限
   */
  async askTask(item, question) {
    const fullText = await this.getFullText(item);
    const meta = this.paperMeta(item);
    let context;
    if (fullText) {
      context = `【论文全文】\n${fullText}`;
    } else {
      let abstract = "";
      try { abstract = item.getField("abstractNote") || ""; } catch (e) { /* ignore */ }
      if (!abstract.trim()) throw new Error("NO_PDF");
      context =
        `【论文摘要】（说明：未获取到该文献的 PDF 全文，请仅基于摘要与题录信息回答，并在开头注明依据有限）\n${abstract}`;
    }
    return AIClient.chat([
      { role: "system", content: this._systemWith(meta, context) },
      { role: "user", content: question },
    ]);
  },

  /** AI 总结（全文优先，无全文回退摘要） */
  async summarize(item) {
    return this.askTask(item,
      "请用中文对这篇论文做 300-500 字的总结，涵盖研究问题、方法、主要结果与结论，一段话或分点均可。");
  },

  /**
   * AI 翻译标题与摘要：优先摘要字段；无摘要时回退翻译 PDF 开篇 3000 字。
   * 0.28.0：改为**尊重「翻译引擎」设置**——
   *   · 引擎 = AI 大模型（默认）→ 沿用原单轮流式提示词（学术语气、术语括号标注）；
   *   · 引擎 = 专用翻译服务（Google/DeepL/百度…）→ 标题与摘要分别送该引擎翻译，
   *     这样未登录 AI 的用户也能用免费引擎翻译题录。
   * 返回结构与旧版一致（纯文本，标题在前、摘要在后），调用方无需改动。
   */
  async translateTitleAbstract(item) {
    const meta = this.paperMeta(item);
    let abstract = "";
    try { abstract = item.getField("abstractNote") || ""; } catch (e) { /* ignore */ }

    // 非「AI 大模型」引擎（或大模型不可用）→ 直接走引擎，标题与摘要分开翻译
    const useEngine = typeof TranslateSvc !== "undefined" && TranslateSvc &&
      (!TranslateSvc.isLLM() || !AIClient.hasKey());
    if (useEngine) {
      const to = TranslateSvc.targetCode();
      const head = I18n.isZh ? { t: "标题", a: "摘要" } : { t: "Title", a: "Abstract" };
      const out = [];
      if (meta.title) {
        const rt = await TranslateSvc.translate(meta.title, { to });
        if (!rt.ok) throw new Error(rt.error);
        out.push(head.t + "\n" + rt.text);
      }
      let body = abstract;
      if (!body.trim()) {
        // 无摘要字段：回退翻译 PDF 开篇（与旧版兜底一致）
        const fullText = await this.getFullText(item);
        if (!fullText) throw new Error("NO_PDF");
        body = fullText.slice(0, 3000);
      }
      const ra = await TranslateSvc.translate(body, { to });
      if (!ra.ok) throw new Error(ra.error);
      out.push(head.a + "\n" + ra.text);
      return out.join("\n\n");
    }

    // AI 大模型引擎：原有单轮提示词路径（标题 + 摘要一次翻译，语气/术语更优）
    const system = Prefs.get("aiSystemPrompt", "") || "";
    if (abstract.trim()) {
      const q =
        "请将以下论文标题与摘要翻译成中文。要求：学术语气、忠实原文；" +
        "专业术语保留英文原词并用括号标注。按「标题」「摘要」两节输出。\n\n" +
        `标题：${meta.title}\n\n摘要：${abstract}`;
      return AIClient.chat([
        { role: "system", content: system },
        { role: "user", content: q },
      ]);
    }
    // 回退：无摘要字段，翻译 PDF 开篇
    const fullText = await this.getFullText(item);
    if (!fullText) throw new Error("NO_PDF");
    const q =
      "以下是某论文的开篇内容（含标题与摘要）。请将标题与摘要部分翻译成中文，" +
      "学术语气、忠实原文，专业术语保留英文原词并用括号标注；按「标题」「摘要」两节输出：\n\n" +
      fullText.slice(0, 3000);
    return AIClient.chat([
      { role: "system", content: system },
      { role: "user", content: q },
    ]);
  },

  /** 一键深度解读：五段式结构化解读（全文优先，无全文回退摘要） */
  async interpret(item) {
    const question =
      "请对这篇论文做结构化解读，包含：1) 研究问题与动机 2) 核心方法 3) 关键实验与结论 " +
      "4) 创新点与贡献 5) 局限性与未来方向。分节输出，每节 3-5 句。";
    return this.askTask(item, question);
  },
};
