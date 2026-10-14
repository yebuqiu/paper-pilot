/* PaperPilot 中文文献 AI 增强（0.42.0，jasminum 分析落地方案 P1/P2/P3）
 *
 * 设计总原则：协议层保持确定性代码，语义层交给大模型。
 *   - 签名 / Cookie / 检索接口参数：LLM 一概不碰（留在 cn-fetch.js 的确定性实现里）；
 *   - 「查什么词、选哪条、补哪些字段、查不到怎么办」：交给 LLM，但输出必须过
 *     JSON 校验 + 字段白名单 + 数据库回验三重把关，防幻觉写库。
 *
 * 四层职责（对应 docs/jasminum-cnki-analysis-and-ai-proposal.md §4）：
 *   L1 检索词规划  plan()        —— 从文件名/PDF 前 2 页文本生成多候选检索式
 *   L3 结果裁决    judge()/decide() —— 候选排序 + 置信度分档（自动/带理由确认/人工/全否决）
 *   L4 元数据融合  fuseMeta()    —— 数据库为准、其余来源只填空（RefImport「只填空」纪律）
 *   P3 兜底识别    recognize()   —— 全部检索失败时 AI 直读 PDF 建元数据（标 unverified）；
 *                  rescue()      —— CNKI 页面结构改版时 LLM 从 HTML 提取结果行（自愈降级）；
 *                  视觉路径       —— 扫描件渲染 PNG 喂多模态（pref cnFetchAIVision 默认关）。
 *
 * 可测试性：plan/parse/decide/fuse/parse* 全部是纯函数（test/cn-ai.test.js 离线覆盖）；
 * 凡是碰 Zotero/网络的胶水都包 try/catch，失败一律回退确定性启发式——AI 不可用
 * 时整条链路行为与 0.41.0 完全一致。
 */
/* global Zotero, Prefs, I18n, AIClient, IOUtils, Worker, _ppDiag, btoa */

var CNAI = {
  _diag(msg) {
    try { _ppDiag("cn-ai: " + msg); } catch (e) { /* ignore */ }
  },

  // ================= 通用：AI 可用性与 JSON 提取 =================

  /** AI 是否就绪（官方通道未登录/无 Key 均为 false，走启发式回退） */
  available() {
    try { return typeof AIClient !== "undefined" && AIClient && AIClient.hasKey(); }
    catch (e) { return false; }
  },

  /** 从模型回复里抠出 JSON（容忍 ```json 围栏与前后闲话；与 RefImport 同款策略） */
  parseAIJSON(text) {
    let s = String(text == null ? "" : text).trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const first = s.search(/[[{]/);
    if (first < 0) return null;
    const open = s[first];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = first; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === close) {
        depth--;
        if (!depth) {
          try { return JSON.parse(s.slice(first, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  },

  _hasCJK(s) {
    return /[一-龥]/.test(String(s || ""));
  },

  _cleanStr(s, max) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max || 300);
  },

  // ================= L1：检索词规划 =================

  /**
   * 确定性回退检索计划（与 cn-fetch._buildQueries 同源的启发式，AI 不可用时的行为基准）。
   * @returns {{title, author, journal, year, docType, queries[], from:"fallback"}}
   */
  fallbackPlan(title, author) {
    let t = String(title || "")
      .replace(/\.{2,}|…+/g, " ")
      .replace(/[_＿]+/g, " ")
      .replace(/[《》“”"':：,，.。;；()[\]（）【】<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (author) {
      t = t.replace(new RegExp(String(author).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ")
        .replace(/\s+/g, " ").trim();
    }
    const tokens = t.replace(/的/g, " ").split(/\s+/).filter(Boolean);
    const qs = [];
    if (t) qs.push(t);
    if (tokens.length >= 2) {
      qs.push(tokens.join(" "));
      qs.push([tokens[0], tokens[tokens.length - 1]].join(" "));
    }
    return {
      title: t, author: String(author || ""), journal: "", year: "", docType: "",
      queries: [...new Set(qs)].slice(0, 4), from: "fallback",
    };
  },

  /**
   * 规划提示词。evidence: {filename, titleHint, authorHint, pdfText}
   * 纪律（对齐 jasminum prompts）：只用证据中明确出现的信息，不猜不补不翻译。
   */
  buildPlannerMessages(evidence) {
    const ev = evidence || {};
    const system = "你是中文学术文献检索词规划助手。根据用户给出的证据（文件名 / 已有标题 / PDF 前两页文本），"
      + "规划在中国知网（CNKI）等中文数据库中检索这篇文献所需的查询参数。\n"
      + "纪律：① 只使用证据中明确出现的信息，绝不臆造、不补全、不翻译；"
      + "② title 取文献的完整中文标题（去掉文件名噪声：下载站名、重复编号、扩展名、_作者 后缀）；"
      + "③ author 只填能明确判断的第一作者，拿不准留空；"
      + "④ queries 是用于标题模糊检索的候选式，按「精确 → 宽泛」排序，最多 4 条："
      + "第 1 条完整标题；标题含副标题（破折号/冒号后）时第 2 条只保留主标题；"
      + "长标题（>15 字）可再给出由 3-6 个核心主题词组成的检索式；不要输出与标题无关的式子；"
      + "⑤ journal/year/docType 只有证据明确时才填，否则留空字符串；docType 只能取 article 或 thesis。\n"
      + "只输出 JSON：{\"title\":\"\",\"author\":\"\",\"journal\":\"\",\"year\":\"\",\"docType\":\"\",\"queries\":[\"\"]}";
    const user = JSON.stringify({
      filename: this._cleanStr(ev.filename, 300),
      title_hint: this._cleanStr(ev.titleHint, 300),
      author_hint: this._cleanStr(ev.authorHint, 60),
      pdf_text: this._cleanStr(ev.pdfText, 3000),
    });
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  },

  /**
   * 解析规划结果。任何一步校验不过 → null（调用方回退 fallbackPlan）。
   * queries 缺失/为空时用标题按启发式补齐——模型只给出好标题也是收益。
   */
  parsePlan(text, fbTitle, fbAuthor) {
    const j = this.parseAIJSON(text);
    if (!j || typeof j !== "object") return null;
    const title = this._cleanStr(j.title, 300) || String(fbTitle || "");
    if (title.length < 4 || !this._hasCJK(title)) return null;
    let queries = Array.isArray(j.queries)
      ? j.queries.map((q) => this._cleanStr(q, 200)).filter((q) => q.length >= 2)
      : [];
    if (!queries.length) {
      queries = this.fallbackPlan(title, "").queries;
    }
    // 完整标题恒为第一条（模型顺序错乱时兜底）
    if (!queries.includes(title)) queries.unshift(title);
    return {
      title,
      author: this._cleanStr(j.author, 60) || String(fbAuthor || ""),
      journal: this._cleanStr(j.journal, 120),
      year: (String(j.year || "").match(/\d{4}/) || [""])[0],
      docType: /^(article|thesis)$/.test(j.docType) ? j.docType : "",
      queries: [...new Set(queries)].slice(0, 4),
      from: "ai",
    };
  },

  // ================= L3：结果裁决 =================

  /**
   * 裁决提示词。candidates: 标准搜索结果数组（只会用到前 10 条）。
   * 模型可返回 index=-1 表示「候选里没有这篇文献」。
   */
  buildJudgeMessages(evidence, candidates) {
    const ev = evidence || {};
    const list = (candidates || []).slice(0, 10).map((r, i) => ({
      index: i,
      source: r.source || "",
      title: r.articleTitle || "",
      author: String(r.author || "").split(",").slice(0, 3).join(","),
      journal: r.journal || "",
      year: r.year || r.date || "",
      citation: r.citation || "",
    }));
    const system = "你是学术文献检索结果裁决助手。给出目标文献的证据与数据库候选列表，"
      + "判断哪一条候选就是目标文献。\n"
      + "判定依据（按重要性）：① 标题语义等价——允许副标题省略、标点/空格差异、"
      + "「——以XX为例」截断，但主标题必须一致；② 第一作者一致（若证据中有）；"
      + "③ 期刊与年份不冲突。标题仅部分重叠、作者对不上、同名不同文的，一律不算命中。\n"
      + "只输出 JSON：{\"index\":0,\"confidence\":0.0,\"reason\":\"一句话理由\"}。"
      + "index 是命中候选的序号；所有候选都不是目标文献时 index 填 -1、confidence 填 0.9 以上。"
      + "confidence 取 0-1，实事求是：证据不足时不要给高分。";
    const user = JSON.stringify({
      evidence: {
        title: this._cleanStr(ev.title, 300),
        author: this._cleanStr(ev.author, 60),
        journal: this._cleanStr(ev.journal, 120),
        year: this._cleanStr(ev.year, 10),
      },
      candidates: list,
    });
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  },

  /**
   * 解析裁决结果 → {index, confidence, reason} | null。
   * index 允许 -1（全否决）；越界/类型错误 → null。
   */
  parseJudgment(text, candidateCount) {
    const j = this.parseAIJSON(text);
    if (!j || typeof j !== "object") return null;
    let index = Number(j.index);
    if (!Number.isInteger(index)) return null;
    if (index < -1 || index >= candidateCount) return null;
    let confidence = Number(j.confidence);
    if (!isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    return { index, confidence, reason: this._cleanStr(j.reason, 200) };
  },

  /**
   * 置信度分档决策：
   *   auto    —— ≥autoT，直接采用（默认 0.9）
   *   confirm —— ≥confirmT，带推荐理由请用户确认（默认 0.6）
   *   reject  —— 模型明确否决全部候选（index=-1 且高置信），进 AI 兜底
   *   manual  —— 其余情况，走原人工选择
   */
  decide(judgment, candidateCount, autoT, confirmT) {
    if (!judgment) return { action: "manual" };
    const a = isFinite(Number(autoT)) ? Number(autoT) : 0.9;
    const c = isFinite(Number(confirmT)) ? Number(confirmT) : 0.6;
    if (judgment.index === -1) {
      return judgment.confidence >= a ? { action: "reject" } : { action: "manual" };
    }
    if (judgment.index < 0 || judgment.index >= candidateCount) return { action: "manual" };
    if (judgment.confidence >= a) return { action: "auto", index: judgment.index };
    if (judgment.confidence >= c) {
      return { action: "confirm", index: judgment.index, reason: judgment.reason };
    }
    return { action: "manual" };
  },

  // ================= L4：元数据融合（数据库为准，其余只填空） =================

  /**
   * 字段级融合：primary 为准，后续来源按顺序只填 primary 的空字段。
   * 空串/空数组/null/undefined 都算「空」。返回新对象，不改入参。
   * 用法：fuseMeta(endNoteMeta, searchPick, aiPlanMeta) —— EndNote 权威全字段优先，
   * 搜索结果补 source/exportID 等协议字段，AI 规划补 journal/year 等识别字段。
   */
  fuseMeta(primary) {
    const sources = Array.prototype.slice.call(arguments, 1).filter(Boolean);
    const all = [primary || {}].concat(sources);
    const keys = new Set();
    for (const s of all) Object.keys(s).forEach((k) => keys.add(k));
    const out = {};
    for (const k of keys) {
      for (const s of all) {
        const v = s[k];
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && !v.trim()) continue;
        if (Array.isArray(v) && !v.length) continue;
        out[k] = v;
        break;
      }
    }
    return out;
  },

  // ================= P3：AI 兜底识别（全部检索失败时） =================

  RECOGNIZE_ITEMTYPES: ["journalArticle", "thesis", "conferencePaper", "newspaperArticle"],

  /** 兜底识别提示词（文本路径；视觉路径在 content 里追加图片 part） */
  buildRecognizeMessages(evidence) {
    const ev = evidence || {};
    const system = "你是中文学术 PDF 元数据识别助手。从给出的 PDF 文本（或页面截图）中提取书目信息。\n"
      + "纪律：① 只用证据中清晰可见的信息，不猜不补不翻译，拿不准的字段留空字符串；"
      + "② 中文论文的中英文对照信息里，标题/摘要/作者/刊名一律取中文原文，不取英文对照、不拼接；"
      + "③ 导师不是论文作者；学位论文 docType 用 thesis；"
      + "④ itemType 只能是 journalArticle|thesis|conferencePaper|newspaperArticle。\n"
      + "只输出 JSON：{\"itemType\":\"\",\"title\":\"\",\"creators\":[\"\"],\"journal\":\"\","
      + "\"year\":\"\",\"volume\":\"\",\"issue\":\"\",\"pages\":\"\",\"doi\":\"\","
      + "\"abstract\":\"\",\"keywords\":[\"\"],\"university\":\"\"}";
    const user = JSON.stringify({
      filename: this._cleanStr(ev.filename, 300),
      pdf_text: this._cleanStr(ev.pdfText, 4000),
    });
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  },

  /**
   * 解析兜底识别结果 → meta | null。
   * 硬性校验：标题 ≥4 字且含汉字（防幻觉写库的第一道闸）；
   * itemType 白名单；creators/keywords 归一为字符串数组。
   */
  parseRecognized(text) {
    const j = this.parseAIJSON(text);
    if (!j || typeof j !== "object") return null;
    const title = this._cleanStr(j.title, 300);
    if (title.length < 4 || !this._hasCJK(title)) return null;
    const itemType = this.RECOGNIZE_ITEMTYPES.includes(j.itemType) ? j.itemType : "journalArticle";
    const creators = Array.isArray(j.creators)
      ? j.creators.map((c) => this._cleanStr(c, 40)).filter((c) => c && c.length <= 30)
      : [];
    const keywords = Array.isArray(j.keywords)
      ? j.keywords.map((k) => this._cleanStr(k, 40)).filter(Boolean).slice(0, 10)
      : [];
    return {
      itemType,
      articleTitle: title,
      creators,
      author: creators.join(","),
      journal: this._cleanStr(j.journal, 120),
      year: (String(j.year || "").match(/\d{4}/) || [""])[0],
      volume: this._cleanStr(j.volume, 20),
      issue: this._cleanStr(j.issue, 20),
      pages: this._cleanStr(j.pages, 40),
      doi: this._cleanStr(j.doi, 120),
      abstract: this._cleanStr(j.abstract, 3000),
      keywords,
      university: this._cleanStr(j.university, 120),
      _unverified: true, // 未与数据库核对——调用方负责写入 extra 标记
    };
  },

  // ================= P3：CNKI 结构改版自愈降级 =================

  /** 自愈提示词：让模型从（可能已改版的）结果页 HTML 中提取结果行 */
  buildRescueMessages(htmlSnippet) {
    const system = "你是网页结构解析助手。给出的 HTML 是中国知网（CNKI）文献检索结果页片段，"
      + "其页面结构可能已经改版。请从中提取检索结果列表。\n"
      + "只输出 JSON 数组（最多 20 条）："
      + "[{\"title\":\"\",\"author\":\"\",\"journal\":\"\",\"date\":\"\",\"href\":\"\"}]。"
      + "href 取结果标题链接的地址（相对地址原样保留）；页面上没有结果列表时输出 []。"
      + "只提取页面上真实存在的信息，不要编造。";
    return [
      { role: "system", content: system },
      { role: "user", content: String(htmlSnippet || "").slice(0, 20000) },
    ];
  },

  /** 解析自愈结果 → 标准搜索结果数组（source 标 CNKI-LLM，便于审计来源） */
  parseRescueResults(text) {
    const j = this.parseAIJSON(text);
    if (!Array.isArray(j)) return [];
    const out = [];
    for (const r of j.slice(0, 20)) {
      if (!r || typeof r !== "object") continue;
      const title = this._cleanStr(r.title, 300).replace(/<[^>]+>/g, "");
      if (title.length < 4 || !this._hasCJK(title)) continue;
      let url = this._cleanStr(r.href, 500);
      if (url && !/^https?:\/\//.test(url)) {
        url = "https://kns.cnki.net" + (url.startsWith("/") ? url : "/" + url);
      }
      out.push({
        source: "CNKI-LLM",
        articleTitle: title,
        author: this._cleanStr(r.author, 120).replace(/\s+/g, ","),
        creators: this._cleanStr(r.author, 120).split(/[,;；\s]+/).filter(Boolean),
        journal: this._cleanStr(r.journal, 120),
        date: this._cleanStr(r.date, 20),
        year: (String(r.date || "").match(/\d{4}/) || [""])[0],
        url,
        itemType: "journalArticle",
      });
    }
    return out;
  },

  // ================= 以下为胶水层（碰 Zotero/网络，全部 try/catch 回退） =================

  /** 条目 PDF 前 N 页文本（L1/P3 的输入证据）；任何失败返回 "" */
  async _pdfFirstPagesText(item, maxPages, maxChars) {
    try {
      let att = null;
      if (item.isPDFAttachment && item.isPDFAttachment()) att = item;
      if (!att && item.getAttachments) {
        for (const id of item.getAttachments()) {
          const a = Zotero.Items.get(id);
          if (a && a.isPDFAttachment && a.isPDFAttachment()) { att = a; break; }
        }
      }
      if (!att) return "";
      if (Zotero.PDFWorker && typeof Zotero.PDFWorker.getFullText === "function") {
        const r = await Zotero.PDFWorker.getFullText(att.id, maxPages || 2, true);
        return String((r && r.text) || "").slice(0, maxChars || 3000);
      }
    } catch (e) {
      this._diag("pdf text failed: " + (e && e.message));
    }
    return "";
  },

  /** 构建识别证据：文件名 + 标题/作者提示 + PDF 前两页文本 */
  async evidenceFor(item, basic) {
    const ev = {
      filename: "",
      titleHint: (basic && basic.title) || "",
      authorHint: (basic && basic.author) || "",
      pdfText: "",
    };
    try {
      if (item.isPDFAttachment && item.isPDFAttachment()) {
        ev.filename = item.attachmentFilename || "";
      } else if (item.getAttachments) {
        for (const id of item.getAttachments()) {
          const a = Zotero.Items.get(id);
          if (a && a.isPDFAttachment && a.isPDFAttachment()) {
            ev.filename = a.attachmentFilename || "";
            break;
          }
        }
      }
      if (!ev.filename) ev.filename = ev.titleHint;
    } catch (e) { /* ignore */ }
    ev.pdfText = await this._pdfFirstPagesText(item, 2, 3000);
    return ev;
  },

  /**
   * L1 入口：为条目生成检索计划。
   * AI 未就绪 / 调用失败 / 输出校验不过 → fallbackPlan（行为与 0.41.0 一致）。
   */
  async plan(item, basic) {
    const fb = () => this.fallbackPlan(basic && basic.title, basic && basic.author);
    if (!Prefs.get("cnFetchAI", true) || !this.available()) return fb();
    try {
      const ev = await this.evidenceFor(item, basic);
      const reply = await AIClient.chat(this.buildPlannerMessages(ev));
      const plan = this.parsePlan(reply, basic && basic.title, basic && basic.author);
      if (plan) {
        this._diag("plan(ai): " + JSON.stringify(plan.queries));
        return plan;
      }
      this._diag("plan reply invalid, fallback");
    } catch (e) {
      this._diag("plan error: " + (e && e.message));
    }
    return fb();
  },

  /**
   * L3 入口：裁决候选（最多 10 条，与 decide 的索引口径一致）。
   * 返回 judgment | null（不可用/失败一律 null → 调用方走人工）。
   */
  async judge(evidence, candidates) {
    if (!Prefs.get("cnFetchAIJudge", true) || !this.available()) return null;
    const cand = (candidates || []).slice(0, 10);
    if (cand.length < 2) return null;
    try {
      const reply = await AIClient.chat(this.buildJudgeMessages(evidence, cand));
      const j = this.parseJudgment(reply, cand.length);
      this._diag("judge: " + JSON.stringify(j));
      return j;
    } catch (e) {
      this._diag("judge error: " + (e && e.message));
      return null;
    }
  },

  /**
   * P3 入口：全部检索失败时的 AI 直读识别。
   * 文本路径（默认）：PDF 前 3 页文本 → 结构化提取；
   * 视觉路径（pref cnFetchAIVision 且文本层过薄）：渲染首页 PNG → 多模态。
   * 返回 meta | null；meta 恒带 _unverified 标记。
   */
  async recognize(item) {
    if (!Prefs.get("cnFetchAI", true) || !this.available()) return null;
    try {
      const filename = (item.isPDFAttachment && item.isPDFAttachment())
        ? (item.attachmentFilename || "")
        : (function () {
            try {
              for (const id of (item.getAttachments ? item.getAttachments() : [])) {
                const a = Zotero.Items.get(id);
                if (a && a.isPDFAttachment && a.isPDFAttachment()) return a.attachmentFilename || "";
              }
            } catch (e) { /* ignore */ }
            return "";
          })();
      const pdfText = await this._pdfFirstPagesText(item, 3, 4000);
      const ev = { filename, pdfText };
      if (pdfText.replace(/\s+/g, "").length >= 200) {
        const reply = await AIClient.chat(this.buildRecognizeMessages(ev));
        const meta = this.parseRecognized(reply);
        this._diag("recognize(text): " + (meta ? meta.articleTitle : "null"));
        return meta;
      }
      // 文本层过薄（疑似扫描件）→ 视觉路径（实验，默认关）
      if (Prefs.get("cnFetchAIVision", false)) {
        return await this._recognizeVision(item, ev);
      }
      this._diag("recognize: pdf text too thin, vision disabled");
    } catch (e) {
      this._diag("recognize error: " + (e && e.message));
    }
    return null;
  },

  /** 视觉识别路径：渲染首页 PNG → data URL → 多模态 chat（全部失败返回 null） */
  async _recognizeVision(item, ev) {
    try {
      let att = null;
      if (item.isPDFAttachment && item.isPDFAttachment()) att = item;
      if (!att && item.getAttachments) {
        for (const id of item.getAttachments()) {
          const a = Zotero.Items.get(id);
          if (a && a.isPDFAttachment && a.isPDFAttachment()) { att = a; break; }
        }
      }
      if (!att) return null;
      const images = await this._renderPagesPNG(att, [0], 2);
      if (!images || !images.length) return null;
      const messages = this.buildRecognizeMessages(ev);
      const reply = await this._chatWithImages(messages[0].content, messages[1].content, images);
      const meta = this.parseRecognized(reply);
      this._diag("recognize(vision): " + (meta ? meta.articleTitle : "null"));
      return meta;
    } catch (e) {
      this._diag("vision recognize error: " + (e && e.message));
      return null;
    }
  },

  /**
   * 渲染 PDF 页面为 PNG（移植自 jasminum pdfImage.ts；Zotero 10+ 才支持，
   * 低版本/任何失败返回 null）。渲染 worker 脚本随包提供：
   * chrome/content/scripts/pdf-render-worker.js
   */
  async _renderPagesPNG(attItem, pageIndexes, scale) {
    try {
      const path = await attItem.getFilePathAsync();
      if (!path) return null;
      const worker = Zotero.PDFWorker;
      if (!worker || typeof worker._enqueue !== "function") return null;
      return await worker._enqueue(async () => {
        const source = await IOUtils.read(path);
        const renderer = new Worker("chrome://paperpilot/content/scripts/pdf-render-worker.js");
        let timer = null;
        try {
          return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("render timeout")), 60000);
            renderer.onerror = (ev) => reject(new Error(ev.message || "render error"));
            renderer.onmessageerror = () => reject(new Error("invalid renderer response"));
            renderer.onmessage = (ev) => {
              const data = ev.data || {};
              if (!data.error && !data.images) return; // worker-ready 消息
              if (data.error) { reject(new Error(String(data.error))); return; }
              resolve(data.images.map((im) => ({
                pageIndex: im.pageIndex,
                data: new Uint8Array(im.buf),
              })));
            };
            renderer.postMessage(
              { buf: source.buffer, pageIndexes: pageIndexes.slice(), scale: scale || 2 },
              [source.buffer],
            );
          });
        } finally {
          if (timer) clearTimeout(timer);
          try { renderer.terminate(); } catch (e) { /* ignore */ }
        }
      }, true);
    } catch (e) {
      this._diag("render pages failed: " + (e && e.message));
      return null;
    }
  },

  /** Uint8Array → data URL（分块 btoa，jasminum 同款，防栈溢出） */
  _bytesToDataURL(bytes, mime) {
    const chunk = 0x8000;
    let bin = "";
    for (let off = 0; off < bytes.length; off += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(off, off + chunk));
    }
    return "data:" + (mime || "image/png") + ";base64," + btoa(bin);
  },

  /**
   * 多模态调用（视觉路径专用）。AIClient.chat 只支持纯文本 content，
   * 这里按 OpenAI image_url 规范自组 parts；配置/鉴权逻辑复用 AIClient._config。
   */
  async _chatWithImages(systemText, userText, images) {
    const cfg = AIClient._config();
    if (cfg.notLoggedIn) throw new Error("NOT_LOGGED_IN");
    if (!cfg.ok) throw new Error("NO_API_KEY");
    const parts = [{ type: "text", text: userText }].concat(
      images.map((im) => ({
        type: "image_url",
        image_url: { url: this._bytesToDataURL(im.data, "image/png") },
      })),
    );
    const payload = {
      model: cfg.model,
      messages: [
        { role: "system", content: systemText },
        { role: "user", content: parts },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      ...(cfg.extraBody || {}),
    };
    const resp = await Zotero.HTTP.request(
      "POST",
      String(cfg.baseUrl).replace(/\/+$/, "") + "/chat/completions",
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (cfg.apiKey || ""),
        },
        body: JSON.stringify(payload),
        responseType: "json",
        timeout: 180000,
      },
    );
    const data = resp.response;
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : "";
    if (!content) throw new Error("AI 返回内容为空");
    return content;
  },

  /**
   * P3 自愈入口：CNKI 结果页结构疑似改版时，让模型从 HTML 提取结果行。
   * 返回标准结果数组（可能为空——空则由调用方按无结果处理）。
   */
  async rescue(html) {
    if (!Prefs.get("cnFetchAI", true) || !this.available()) return [];
    try {
      const reply = await AIClient.chat(this.buildRescueMessages(html));
      const results = this.parseRescueResults(reply);
      this._diag("rescue: " + results.length + " rows");
      return results;
    } catch (e) {
      this._diag("rescue error: " + (e && e.message));
      return [];
    }
  },
};
