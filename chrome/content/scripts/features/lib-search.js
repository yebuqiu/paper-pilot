// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 库内问答（0.22.0）
 * 解决的问题：现有 AI 问答都是「对着当前这一篇」。用户真正的问法是
 * 「我这个库里有没有讲过 XXX 方法？」「我读过的关于 XX 的文献都什么结论？」
 * ——关键词检索给不了答案，单篇问答也回答不了。
 *
 * 实现路线（不引入向量库，先做两阶段检索，效果不够再上嵌入）：
 *   阶段 1 · 快速召回：遍历范围内条目，对 标题/标签/摘要/期刊/作者/extra 做
 *     加权打分（中文 bigram + 英文分词），按「命中总分 × 词覆盖率」排序；
 *   阶段 2 · 全文复核：对 Top-N 读 Zotero 全文索引（消歧、纠偏、抽取命中片段），
 *     命中正文的候选上调分数 —— 这一步能把「摘要没提但正文有」的文献捞回来；
 *   阶段 3 · 生成回答：把候选整理成带编号的上下文交 LLM，要求逐条标注 [n] 引用，
 *     并明确要求「库中没有就说没有」，不许编造。
 *
 * 就绪纪律：AI 不可用时绝不静默失败，一律返回可读原因与指引（见 run()）。
 */
/* global Zotero, Services, Prefs, I18n, AIClient, AIChat, ItemSel, MdLite */

var LibSearch = {
  // 中英文停用词（只挡噪声词，不挡领域词）
  STOP: new Set(("的 了 是 我 有 和 与 在 对 为 及 或 等 这 那 哪 什么 哪些 哪个 怎么 如何 请问 介绍 一下 关于 一下 " +
    "the a an of and or to in on for with is are was were be been do does did what which how why " +
    "paper papers study studies about me my i we our you your").split(/\s+/).filter(Boolean)),

  FIELD_WEIGHT: { title: 5, tags: 3, journal: 2, abstract: 2, creators: 1.5, extra: 1 },

  /* ---------- 分词与打分（纯函数，可单测） ---------- */

  /** 查询 → 词元数组：英文单词 + 中文 bigram（含长于 4 字的整词） */
  tokenize(q) {
    const s = String(q || "").toLowerCase();
    const out = [];
    // 英文/数字词
    for (const m of s.match(/[a-z][a-z0-9\-_.]{1,}/g) || []) {
      if (!this.STOP.has(m) && m.length >= 2) out.push(m);
    }
    // 中文串 → bigram
    for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      if (run.length <= 4) out.push(run);
      for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    }
    // 去重（同一词元只算一次权重，避免复读机式查询被放大）
    return [...new Set(out)];
  },

  /** 取条目的可检索字段（阶段 1 只碰轻量字段，不读全文） */
  fieldsOf(item) {
    const g = (f) => { try { return String(item.getField(f) || ""); } catch (e) { return ""; } };
    let tags = [];
    try { tags = (item.getTags() || []).map((t) => t.tag); } catch (e) { tags = []; }
    let creators = [];
    try {
      creators = (item.getCreators() || []).map((c) => c.lastName || c.name || "").filter(Boolean);
    } catch (e) { creators = []; }
    let extra = "";
    try { extra = String(item.getField("extra") || ""); } catch (e) { extra = ""; }
    return {
      title: g("title"),
      abstract: g("abstractNote"),
      journal: g("publicationTitle") || g("bookTitle") || g("proceedingsTitle") || "",
      tags: tags.join(" "),
      creators: creators.join(" "),
      extra,
    };
  },

  /**
   * 打分：命中加权总分 × 覆盖率（0.5 次幂），覆盖率让「命中查询多数词」的文献排前
   * @returns {{score:number, hitTokens:string[], fieldHits:object}}
   */
  score(fields, tokens) {
    const W = this.FIELD_WEIGHT;
    let total = 0;
    let matched = 0;
    const hitTokens = [];
    const fieldHits = {};
    for (const tk of tokens) {
      let w = 0;
      for (const key of Object.keys(W)) {
        const text = String(fields[key] || "").toLowerCase();
        if (!text) continue;
        let n = 0, idx = text.indexOf(tk);
        while (idx >= 0 && n < 8) { n++; idx = text.indexOf(tk, idx + tk.length); }
        if (n) { w += W[key] * n; fieldHits[key] = (fieldHits[key] || 0) + n; }
      }
      if (w > 0) { total += w; matched++; hitTokens.push(tk); }
    }
    if (!matched) return { score: 0, hitTokens: [], fieldHits: {} };
    const coverage = matched / tokens.length;
    return { score: total * Math.pow(coverage, 0.5), hitTokens, fieldHits };
  },

  /** 全文里按「整串 + 词元」复核，返回命中次数与首个片段（供上下文与 UI 展示） */
  verifyText(text, query, tokens) {
    const t = String(text || "");
    if (!t) return { hits: 0, snippet: "" };
    const low = t.toLowerCase();
    let hits = 0;
    let pos = -1;
    const whole = String(query || "").trim().toLowerCase();
    if (whole.length >= 2) {
      const p = low.indexOf(whole);
      if (p >= 0) { hits += 6; pos = p; } // 整串命中权重最高（短语匹配）
    }
    for (const tk of tokens) {
      const p = low.indexOf(tk);
      if (p >= 0) {
        hits += 1;
        if (pos < 0 || p < pos) pos = p;
      }
    }
    let snippet = "";
    if (pos >= 0) {
      const start = Math.max(0, pos - 120);
      snippet = t.slice(start, pos + 300).replace(/\s+/g, " ").trim();
    }
    return { hits, snippet };
  },

  /* ---------- 数据层 ---------- */

  /** 检索范围：分类内条目 or 全库常规条目 */
  async scopeItems(useCollection) {
    const out = [];
    let name = I18n.isZh ? "全库" : "Whole library";
    const zp = Zotero.getActiveZoteroPane();
    let col = null;
    if (useCollection) {
      try { col = zp && zp.getSelectedCollections && zp.getSelectedCollections()[0]; } catch (e) { col = null; }
    }
    if (col) {
      name = (I18n.isZh ? "分类「" : "Collection \"") + col.name + "」";
      let children = [];
      try { children = col.getChildItems ? col.getChildItems() : []; } catch (e) { children = []; }
      for (const it of children) {
        if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) out.push(it);
      }
    } else {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("itemType", "isNot", "attachment");
      for (const id of await s.search()) {
        const it = await Zotero.Items.getAsync(id);
        if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) out.push(it);
      }
    }
    return { name, items: out };
  },

  /**
   * 两阶段检索
   * @param {string} query
   * @param {{useCollection?:boolean, deep?:boolean, topN?:number, pdfOnly?:boolean}} opts
   */
  async retrieve(query, opts) {
    const o = opts || {};
    const tokens = this.tokenize(query);
    if (!tokens.length) return { tokens, scope: "", scanned: 0, results: [], deepChecked: 0 };
    const { name, items } = await this.scopeItems(!!o.useCollection);
    let scanned = 0;
    const scored = [];
    for (const item of items) {
      if (o.pdfOnly) {
        let has = false;
        try { has = !!(await item.getBestAttachment()); } catch (e) { has = false; }
        if (!has) continue;
      }
      scanned++;
      const r = this.score(this.fieldsOf(item), tokens);
      if (r.score > 0) scored.push({ item, score: r.score, hitTokens: r.hitTokens, fieldHits: r.fieldHits, snippet: "" });
    }
    scored.sort((a, b) => b.score - a.score);
    const topN = Math.max(1, Math.min(30, o.topN || 8));
    let deepChecked = 0;
    if (o.deep !== false) {
      const head = scored.slice(0, topN);
      for (const c of head) {
        try {
          const att = await AIChat.getPdfAttachment(c.item);
          if (!att) continue;
          const text = await AIChat._readIndexedText(att);
          if (!text) continue;
          const v = this.verifyText(text, query, tokens);
          c.snippet = v.snippet;
          if (v.hits) c.score += v.hits * 2; // 正文命中上调，但不至于压过标题强匹配
          deepChecked++;
        } catch (e) { /* 单篇失败不影响整体 */ }
      }
      head.sort((a, b) => b.score - a.score);
      scored.splice(0, head.length, ...head);
    }
    return { tokens, scope: name, scanned, results: scored, deepChecked };
  },

  /* ---------- 上下文与回答 ---------- */

  _year(item) {
    try {
      const m = String(item.getField("date") || "").match(/(\d{4})/);
      return m ? m[1] : "";
    } catch (e) { return ""; }
  },

  _authors(item) {
    try {
      const cs = item.getCreators() || [];
      const names = cs.slice(0, 3).map((c) => c.lastName || c.name || "").filter(Boolean);
      return names.join(", ") + (cs.length > 3 ? " et al." : "");
    } catch (e) { return ""; }
  },

  /** 候选 → 带编号的上下文文本（预算按 pref 截断） */
  buildContext(hits, maxChars) {
    const budget = maxChars || 12000;
    const zh = I18n.isZh;
    let out = "";
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const f = this.fieldsOf(h.item);
      const block = "[" + (i + 1) + "] " + (zh ? "标题：" : "Title: ") + (f.title || "?") + "\n" +
        (zh ? "作者：" : "Authors: ") + this._authors(h.item) + " ｜ " +
        (zh ? "期刊：" : "Journal: ") + (f.journal || "-") + " ｜ " +
        (zh ? "年份：" : "Year: ") + (this._year(h.item) || "-") + "\n" +
        (zh ? "标签：" : "Tags: ") + (f.tags || "-") + "\n" +
        (zh ? "摘要：" : "Abstract: ") + String(f.abstract || (zh ? "（无摘要）" : "(none)")).slice(0, 500) + "\n" +
        (h.snippet ? (zh ? "正文命中片段：" : "Snippet: ") + h.snippet.slice(0, 400) + "\n" : "") + "\n";
      if (out.length + block.length > budget) { out += (zh ? "…（上下文已达上限，其余候选仅列标题）\n" : "…(context limit)\n"); break; }
      out += block;
    }
    return out;
  },

  buildMessages(query, hits) {
    const zh = I18n.isZh;
    const sys = zh
      ? "你是文献库检索助手。只能依据给定的候选文献内容回答，禁止编造文献、数据或结论。\n" +
        "要求：\n" +
        "1. 每个来自文献的结论句末必须标注来源编号，如 [1]、[2][3]；\n" +
        "2. 如果候选文献不足以回答，明确说明「库中现有文献不足以回答该问题」，并指出还缺什么；\n" +
        "3. 最后用一句话概括结论；如涉及多篇文献的分歧，要指出分歧点；\n" +
        "4. 用简洁的 Markdown（小标题 + 列表）输出，不要复述问题。"
      : "You are a library retrieval assistant. Use ONLY the provided candidate papers; never invent references or findings.\n" +
        "Cite sources with [n] after each claim; if evidence is insufficient, say so explicitly; end with a one-line takeaway.";
    const user = zh
      ? "问题：" + query + "\n\n候选文献（共 " + hits.length + " 篇）：\n\n" + this.buildContext(hits, Number(Prefs.get("libSearchContextChars", 12000)))
      : "Question: " + query + "\n\nCandidates (" + hits.length + "):\n\n" + this.buildContext(hits, Number(Prefs.get("libSearchContextChars", 12000)));
    return [{ role: "system", content: sys }, { role: "user", content: user }];
  },

  /** 生成回答；未就绪时返回 {ok:false, reason} 而不是抛错（便于 UI 显示指引） */
  async answer(query, hits) {
    if (!AIClient.hasKey()) {
      return { ok: false, reason: AIClient.status(), text: AIClient.guidance() };
    }
    try {
      const text = await AIClient.chat(this.buildMessages(query, hits));
      return { ok: true, text: String(text || "").trim() };
    } catch (e) {
      return { ok: false, reason: "error", text: String((e && e.message) || e) };
    }
  },

  /** 把一次问答存为库级笔记（不在条目下），便于沉淀 */
  async saveAsNote(query, hits, answerText) {
    const zh = I18n.isZh;
    let md = "## " + (zh ? "问题" : "Question") + "\n" + query + "\n\n" +
      "## " + (zh ? "AI 回答" : "Answer") + "\n" + (answerText || "") + "\n\n" +
      "## " + (zh ? "检索到的候选文献（按相关度）" : "Candidates") + "\n";
    hits.forEach((h, i) => {
      const f = this.fieldsOf(h.item);
      md += "[" + (i + 1) + "] " + (f.title || "?") + "（" + this._authors(h.item) + "，" +
        (this._year(h.item) || "?") + "，" + (f.journal || "-") + "）\n";
    });
    md += "\n> " + (zh ? "由 Papilot 库内问答生成，回答内容请自行核对原文。" : "Generated by Papilot; verify against the originals.");
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    try {
      const Md = (typeof MdLite !== "undefined") ? MdLite : null;
      note.setNote(Md ? Md.toNoteHtml((zh ? "库内问答｜" : "Library Q&A | ") + query.slice(0, 40), md) : md);
    } catch (e) {
      note.setNote("<p>" + md.replace(/</g, "&lt;") + "</p>");
    }
    await note.saveTx();
    return note;
  },

  /** 菜单/功能中心入口：打开问答对话框 */
  openDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const en = Services.wm.getEnumerator("papilot:libask");
      if (en.hasMoreElements()) { const w = en.getNext(); w.focus(); return w; }
    } catch (e) { /* ignore */ }
    return win.openDialog(
      "chrome://papilot/content/lib-ask.xhtml",
      "papilot-lib-ask",
      "chrome,centerscreen,resizable,dialog=no",
      { Zotero, Services }
    );
  },
};
