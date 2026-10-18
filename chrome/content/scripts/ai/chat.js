/* PaperPilot PDF 全文提取 + 问答逻辑 */
/* global Zotero, IOUtils, Prefs, AIClient, TranslateSvc, TranslateX, I18n */

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

  /** 提取 PDF 全文（Zotero 内置全文索引），按当前 pref 截断。
   *  0.33.0：opts.noTruncate = true 时不截断（全文对照翻译需要整篇；
   *  默认行为不变——AI 问答等场景仍按 aiFullTextMaxChars 截断）。 */
  async getFullText(item, opts) {
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
    if (opts && opts.noTruncate) return raw;

    const max = Number(Prefs.get("aiFullTextMaxChars", 16000)) || 16000;
    if (raw.length > max) {
      // 头 2/3 + 尾 1/3，保住摘要与结论
      const head = Math.floor(max * 2 / 3);
      return raw.slice(0, head) + "\n\n[……中间内容已截断……]\n\n" + raw.slice(-(max - head));
    }
    return raw;
  },

  /**
   * 0.48.0：对话历史滑窗（多轮上下文管理，轮数可配）。
   * pref aiHistoryRounds（默认 6，1-30）——取代各调用点硬编码 slice(-12)。
   * 防御：截断点落在 assistant（交替断裂）时丢弃首个半轮，保证窗口以 user 开头。
   */
  windowHistory(history, rounds) {
    const list = Array.isArray(history) ? history : [];
    let n = Number(rounds);
    if (!isFinite(n)) n = 6;
    n = Math.max(1, Math.min(30, Math.floor(n)));
    const cut = list.slice(-n * 2);
    return cut.length && cut[0] && cut[0].role === "assistant" ? cut.slice(1) : cut;
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
    // 0.48.0：历史轮数可配（aiHistoryRounds，默认 6 轮）——多轮上下文管理
    messages.push(...this.windowHistory(history, Prefs.get("aiHistoryRounds", 6)));
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
    // 0.48.0：历史轮数可配（aiHistoryRounds，默认 6 轮）——多轮上下文管理
    messages.push(...this.windowHistory(history, Prefs.get("aiHistoryRounds", 6)));
    messages.push({ role: "user", content: question });

    return AIClient.chat(messages);
  },

  _systemWith(meta, contextBlock) {
    // 0.38.0： grounding 指令具体化——注明出处位置、区分推断与原文（配合根提示词纪律 2）
    return (Prefs.get("aiSystemPrompt", "") || "") +
      `\n\n当前用户正在阅读以下论文。回答要求：只基于该论文内容；论文未提及的信息明确说明；` +
      `引用论文观点注明位置（章节/图表/摘要）；你的推断与论文原文分开表述。\n` +
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
    // 0.38.0：从「300-500 字泛泛总结」升级为四要素结构化输出（数字/边界/不补写）
    return this.askTask(item,
      "请对这篇论文做结构化总结，300-500 字，分四点输出：\n" +
      "1) 研究问题：解决什么问题、为什么重要（1-2 句）；\n" +
      "2) 方法：研究设计、数据/样本规模、关键分析方法——写出具体名称与数字；\n" +
      "3) 结果：主要发现 2-4 条，给出方向与效应大小（用论文报告的数字）；\n" +
      "4) 结论与边界：作者结论、适用范围与作者自述的局限。\n" +
      "只写论文里有的内容，论文未报告的不要补。");
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
      let titleTrans;
      if (meta.title) {
        const rt = await TranslateSvc.translate(meta.title, { to });
        if (!rt.ok) throw new Error(rt.error);
        titleTrans = rt.text;
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
      // 引擎路径：标题/摘要译文天然分离，直接写回 extra（供「标题译文」列渲染）
      await this._writeBackTA(item, { title: titleTrans, abstract: ra.text });
      return out.join("\n\n");
    }

    // AI 大模型引擎：原有单轮提示词路径（标题 + 摘要一次翻译，语气/术语更优）
    const system = Prefs.get("aiSystemPrompt", "") || "";
    if (abstract.trim()) {
      const q =
        "请将以下论文的标题与摘要翻译成中文。要求：学术语气、忠实原文、不增删内容；" +
        "专业术语首次出现时保留英文原词并括号标注；数字、单位与统计量原样保留。" +
        "按「标题」「摘要」两节输出。\n\n" +
        `标题：${meta.title}\n\n摘要：${abstract}`;
      const text = await AIClient.chat([
        { role: "system", content: system },
        { role: "user", content: q },
      ]);
      await this._writeBackTA(item, this._parseTASections(text));
      return text;
    }
    // 回退：无摘要字段，翻译 PDF 开篇
    const fullText = await this.getFullText(item);
    if (!fullText) throw new Error("NO_PDF");
    const q =
      "以下是某论文的开篇内容（含标题与摘要）。请将其中标题与摘要部分翻译成中文，" +
      "学术语气、忠实原文、不增删内容；专业术语首次出现时保留英文原词并括号标注；" +
      "数字、单位与统计量原样保留。按「标题」「摘要」两节输出：\n\n" +
      fullText.slice(0, 3000);
    const text = await AIClient.chat([
      { role: "system", content: system },
      { role: "user", content: q },
    ]);
    await this._writeBackTA(item, this._parseTASections(text));
    return text;
  },

  /** 解析 LLM 合并输出为 {title, abstract}（识别不出则不动 extra） */
  _parseTASections(text) {
    if (typeof TranslateX === "undefined" || !TranslateX) return {};
    const sec = TranslateX.parseSections(text);
    const out = {};
    if (sec.title) out.title = sec.title;
    if (sec.abstract) out.abstract = sec.abstract;
    return out;
  },

  /**
   * 译文写回 extra（pref translateWriteBack 开关，默认开）。
   * 写回是附加动作：失败绝不打断笔记生成主流程。
   */
  async _writeBackTA(item, translations) {
    try {
      if (!Prefs.get("translateWriteBack", true)) return;
      if (typeof TranslateX === "undefined" || !TranslateX) return;
      await TranslateX.writeBackTranslations(item, translations || {});
    } catch (e) {
      try { Zotero.debug("PaperPilot: 译文写回 extra 失败 " + (e && e.message || e)); } catch (e2) { /* ignore */ }
    }
  },

  /** 一键深度解读：五段式结构化解读（全文优先，无全文回退摘要） */
  async interpret(item) {
    // 0.38.0：每节要求落到论文中的具体证据；创新点要求说清对照基准；局限区分作者自述与判断
    const question =
      "请对这篇论文做结构化解读，分五节输出，每节 3-5 句，且每节至少给一处论文中的具体证据（章节、图表或数据）：\n" +
      "1) 研究问题与动机：问题是什么，现有方案差在哪里；\n" +
      "2) 核心方法：关键设计与技术路线，作者为什么这样选；\n" +
      "3) 关键实验与结论：最重要的 1-2 个实验及其结果与解读；\n" +
      "4) 创新点：相对既有工作新在哪里（新问题/新方法/新证据），并说明对照的基准是什么；\n" +
      "5) 局限与方向：作者自述的局限与你基于论文内容的判断，两者分开写。";
    return this.askTask(item, question);
  },
};
