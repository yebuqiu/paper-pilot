/* PaperPilot AI 自动打标签 v2（0.46.0 重构增强）
 *
 * 参考的成熟开源方案：
 *  - Karakeep(Hoarder)：受控词表（把库内已有标签注入提示词"优先复用"）+
 *    结构化 JSON 输出 + normalizeTag 形状匹配对齐已有标签（只新建不存在的写法）；
 *  - Paperless-ngx / paperless-gpt：建议先审核再应用、输出语言可控。
 *
 * ── 数据契约 ────────────────────────────────────────────────
 * 输入 buildContext(item) →
 *   { title, abstract(截断), publication, creators(前3位), year, itemType,
 *     language, existingTags[], vocab[](库内高频标签), max, lang("zh"|"en") }
 * AI 输出（提示词强约束）→
 *   [ { "tag":"#类别/名称", "reason":"≤15字依据", "confidence":0~1 } ]
 * 内部处理流水线（parseReply）：
 *   结构化解析(JSON优先,围栏/前后杂文/{tags:[]}包装全兼容)
 *   → 归一化(全角→半角/＃归一/尾随标点/分段trim)
 *   → 词表对齐(shape 键命中→复用库内原样写法)
 *   → 校验(长度3-40/新标签类别白名单/宽泛词黑名单/shape 去重)
 *   → 上限截断(勾选 UI 用 max+4 个，suggest() 只取前 max 个)
 * suggestDetailed(item) →
 *   { suggestions:[{tag,reason,confidence}], dropped:{existing[]}, cached:bool }
 * suggest(item)（兼容层，automation.js 的 aiAutoTag 动作不改自升级）→
 *   string[]（≤autoTagMax 个）
 *
 * ── 异常与边界 ──────────────────────────────────────────────
 *  - 无标题且无摘要 → 抛可读错误（NO_META 场景）；
 *  - AI 回复非 JSON → 降级链：JSON → 显式 #token → 报可读错误
 *    （旧「按行兜底」会把拒答散文写成垃圾标签，v2 弃用该路径，_parseTags 仅为对照保留）；
 *  - 词表扫描失败 → 空词表继续（只少了"复用"提示，不影响出标）；
 *  - 缓存 pref 损坏 → 静默视为空缓存；
 *  - 缓存命中后条目已写入部分标签 → 运行期再过滤一次已有标签；
 *  - 置信度越界/缺失 → 钳到 [0,1]，缺省 0.5。
 */
/* global Zotero, Services, Prefs, AIClient, I18n, ItemSel */

var AutoTag = {
  /* ==================== 常量 ==================== */

  /** 新标签的类别白名单（与提示词一致；对齐到库内已有标签的不受此限——
   *  用户库里的 #状态/预印本 等既有体系必须能被复用） */
  CATEGORIES: ["领域", "方法", "主题", "数据", "理论"],
  CATEGORIES_EN: ["Domain", "Method", "Topic", "Data", "Theory"],

  /** 宽泛词黑名单：去掉类别前缀后恰好等于这些词的标签一律拒绝 */
  GENERIC_NAMES: ["研究", "论文", "科学", "文献", "综述", "领域", "方法", "理论", "主题", "数据", "实验", "分析", "模型",
    "research", "paper", "study", "science", "review", "domain", "topic", "data", "method", "theory", "analysis", "model", "survey"],

  /** 受控词表注入预算（Karakeep 同款思路：个数 + 字符双上限） */
  VOCAB_MAX_TAGS: 40,
  VOCAB_MAX_CHARS: 600,
  /** 词表内存缓存 TTL：全库遍历不便宜，逐条目打标时复用（10 分钟） */
  VOCAB_TTL_MS: 10 * 60 * 1000,

  /** 建议缓存（pref autoTagCacheData）LRU 上限 */
  CACHE_MAX: 100,

  /** 上下文截断（控制 token 成本） */
  ABSTRACT_MAX: 1200,
  TITLE_MAX: 300,

  /* ==================== 归一化与形状键（纯函数） ==================== */

  /** 标签归一化：全角→半角、＃/# 前缀归一、分段 trim、去尾随标点；非法 → "" */
  _normalizeTag(raw) {
    let s = String(raw == null ? "" : raw);
    s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); // 全角→半角
    s = s.replace(/\u3000/g, " ").replace(/／/g, "/");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/^[#＃\s]+/, ""); // 先剥掉所有前导 # 再统一补一个
    s = s.replace(/[.。,，;；:：!！?？、]+$/, "").trim(); // 尾随标点
    const parts = s.split("/").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return "";
    return "#" + parts.join("/");
  },

  /** 形状键（去 #、小写、抹掉空白与分隔符）：deep-learning / deep learning / DeepLearning 视为同一概念 */
  _shapeKey(tag) {
    return this._normalizeTag(tag).slice(1).toLowerCase().replace(/[\s\-_·]+/g, "");
  },

  /* ==================== 结构化解析（纯函数） ==================== */

  /** 抽取首个与 open 平衡的片段（跳过字符串字面量内的括号）；不平衡返回 null */
  _extractBalanced(raw, open, close, from) {
    const start = String(raw).indexOf(open, from || 0);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return raw.slice(start, i + 1);
      }
    }
    return null; // 宁缺毋滥：不平衡交给降级链
  },

  /**
   * 结构化解析：JSON 数组 → [{tag, reason, confidence}]；解析不出返回 null。
   * 容错顺序：剥代码围栏 → 整体解析 → 逐个平衡数组片段（含 [maybe] 干扰）→ {tags:[...]} 包装。
   */
  _parseStructured(text) {
    const raw = String(text || "");
    const tryParse = (s) => {
      s = String(s || "").trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    };
    let data = null;
    // 1) 代码围栏（模型最常见的"不听话"形态）
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m) data = tryParse(m[1]);
    // 2) 整体就是 JSON
    if (!data) data = tryParse(raw);
    // 3) 前后杂文本中的数组片段（逐个尝试，第一个能解析的生效）
    if (!data || !Array.isArray(data)) {
      let from = 0;
      while (!Array.isArray(data)) {
        const cand = this._extractBalanced(raw, "[", "]", from);
        if (!cand) break;
        const parsed = tryParse(cand);
        if (Array.isArray(parsed)) data = parsed;
        else from = raw.indexOf("[", from) + 1;
        if (from <= 0) break;
      }
    }
    // 4) 对象包装 {"tags":[...]} / {"suggestions":[...]}
    if (!Array.isArray(data)) {
      const objText = this._extractBalanced(raw, "{", "}", 0);
      if (objText) {
        const o = tryParse(objText);
        if (o && typeof o === "object") data = o;
      }
    }
    let list = null;
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === "object") {
      if (Array.isArray(data.tags)) list = data.tags;
      else if (Array.isArray(data.suggestions)) list = data.suggestions;
    }
    if (!list) return null;
    // 元素归一：字符串 / {tag|name|label, reason, confidence|score}
    const out = [];
    for (const el of list) {
      let tag = "", reason = "", confidence = 0.5;
      if (typeof el === "string") tag = el;
      else if (el && typeof el === "object") {
        tag = el.tag || el.name || el.label || "";
        reason = String(el.reason || el.why || "").slice(0, 40);
        const c = Number(el.confidence !== undefined ? el.confidence : el.score);
        confidence = isNaN(c) ? 0.5 : Math.min(1, Math.max(0, c));
      }
      if (tag) out.push({ tag: String(tag), reason, confidence });
    }
    return out.length ? out : null;
  },

  /** 显式 #token 抽取（去重、长度 3-40、尾随标点；正则与 _parseTags 第一遍一致） */
  _parseHashTokens(text) {
    const seen = new Set();
    const tags = [];
    const push = (t) => {
      t = String(t || "").trim().replace(/[.。,，;；]+$/, "");
      if (!t) return;
      if (t[0] !== "#") t = "#" + t;
      if (t.length < 3 || t.length > 40) return;
      if (!seen.has(t)) { seen.add(t); tags.push(t); }
    };
    const found = String(text || "").match(/#[^\s，,;；。、"'“”‘’()（）\[\]]+/g) || [];
    for (const t of found) push(t);
    return tags;
  },

  /**
   * v2 降级链第二级：只认显式 # 前缀的 token。
   * 旧版「按行兜底」在 JSON 时代会把手写散文变成垃圾标签（拒答文本整行
   * 被当成 #标签写入）——模型既没给 JSON 也没给 # 时，宁可报可读错误也不写脏库。
   * （_parseTags 本体原样保留，仅供历史行为对照。）
   */
  _parseTagsAsDetail(text) {
    return this._parseHashTokens(text).map((t) => ({ tag: t, reason: "", confidence: 0.5 }));
  },

  /** 从 AI 回复中解析 #标签（容错：直接抓 # 开头的 token；模型不带 # 时按行兜底） */
  _parseTags(text) {
    const seen = new Set();
    const tags = [];
    const push = (t) => {
      t = String(t || "").trim().replace(/[.。,，;；]+$/, "");
      if (!t) return;
      if (t[0] !== "#") t = "#" + t;
      if (t.length < 3 || t.length > 40) return;
      if (!seen.has(t)) { seen.add(t); tags.push(t); }
    };
    const raw = String(text || "");
    // 第一遍：抓 # 开头的 token（兼容行内混排）
    const found = raw.match(/#[^\s，,;；。、"'“”‘’()（）\[\]]+/g) || [];
    for (const t of found) push(t);
    // 第二遍（兜底）：模型没按格式输出 # 时，按行解析（去编号/项目符号/代码围栏）
    if (!tags.length) {
      for (let line of raw.split(/\r?\n/)) {
        line = line.trim();
        if (!line || /^```/.test(line)) continue;
        line = line.replace(/^(?:[-*•·]|\d+[.、)）])\s*/, "").trim();
        line = line.replace(/^(?:标签|tags?)\s*[:：]\s*/i, "").trim();
        // 行内可能有多个标签（顿号/逗号分隔）
        for (const part of line.split(/[、,，;；]/)) push(part);
      }
    }
    const max = Number(Prefs.get("autoTagMax", 6)) || 6;
    return tags.slice(0, Math.max(max, 6)); // 多解析一些供勾选
  },

  /* ==================== 校验与词表对齐（纯函数） ==================== */

  /**
   * 新标签规则校验（对齐到库内已有标签的跳过此关）：
   * 带类别时类别必须 ∈ 白名单；名称不得是宽泛词。
   */
  _tagPassesRules(tag, lang) {
    const body = tag.replace(/^#/, "");
    const slash = body.indexOf("/");
    const category = slash > 0 ? body.slice(0, slash).trim() : "";
    const name = slash > 0 ? body.slice(slash + 1).trim() : body;
    if (!name) return false;
    if (category) {
      const cats = lang === "en" ? this.CATEGORIES_EN : this.CATEGORIES;
      if (cats.indexOf(category) < 0) return false;
    }
    return this.GENERIC_NAMES.indexOf(name.toLowerCase()) < 0;
  },

  /**
   * 词表对齐（Karakeep normalizeTag 匹配思路）：建议与库内已有标签
   * shape 相同（忽略大小写/分隔符）时，改写为库内既有写法——从源头
   * 杜绝「同一含义多种写法」（TagCurator 治理的正是这个烂摊子）。
   */
  _alignToVocabulary(items, vocab) {
    if (!Array.isArray(vocab) || !vocab.length || !Array.isArray(items) || !items.length) return items || [];
    const idx = new Map();
    for (const v of vocab) {
      const k = this._shapeKey(v);
      if (k && !idx.has(k)) idx.set(k, v);
    }
    return items.map((it) => {
      const hit = idx.get(this._shapeKey(it.tag));
      return hit && hit !== it.tag ? { tag: hit, reason: it.reason, confidence: it.confidence } : it;
    });
  },

  /**
   * 全流水线：解析 → 归一 → 词表对齐 → 校验 → shape 去重 → 截断。
   * @returns {{items:Array<{tag,reason,confidence}>, invalid:string[]}}
   */
  _processReply(reply, ctx) {
    const parsed = this._parseStructured(reply) || this._parseTagsAsDetail(reply);
    if (!parsed.length) return { items: [], invalid: [] };
    const aligned = this._alignToVocabulary(parsed, ctx.vocab || []);
    const vocabKeys = new Set((ctx.vocab || []).map((v) => this._shapeKey(v)));
    const items = [];
    const invalid = [];
    const seen = new Set();
    for (const it of aligned) {
      const tag = this._normalizeTag(it.tag);
      if (!tag || tag.length < 3 || tag.length > 40) { invalid.push(String(it.tag)); continue; }
      const key = this._shapeKey(tag);
      if (!key || seen.has(key)) { invalid.push(tag); continue; }
      const isVocab = vocabKeys.has(key); // 库内既有体系（#状态/预印本 等）不受新标签规则约束
      if (!isVocab && !this._tagPassesRules(tag, ctx.lang)) { invalid.push(tag); continue; }
      seen.add(key);
      items.push({ tag, reason: String(it.reason || ""), confidence: it.confidence });
    }
    const cap = Math.max(Number(ctx.max) || 6, 6) + 4; // 勾选 UI 多给几个候选
    return { items: items.slice(0, cap), invalid };
  },

  /* ==================== 缓存（纯函数 + pref 存储） ==================== */

  /** FNV-1a 32 位（Math.imul 防乘法溢出丢精度）；非安全用途，缓存指纹足够 */
  _hash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  },

  /** 缓存指纹：标题+摘要+个数+语言+词表规模——任何一个变化都会失效 */
  _fingerprint(ctx) {
    return this._hash([ctx.title, "|", ctx.abstract, "|", ctx.max, "|", ctx.lang, "|",
      Array.isArray(ctx.vocab) ? ctx.vocab.length : 0].join(""));
  },

  _cacheAll() {
    try {
      const raw = String(Prefs.get("autoTagCacheData", "") || "");
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
    } catch (e) { return {}; } // 损坏 → 视为空
  },

  _cacheGet(fp) {
    if (Prefs.get("autoTagCache", true) === false) return null;
    const hit = this._cacheAll()[fp];
    return hit && Array.isArray(hit.items) ? hit.items : null;
  },

  _cachePut(fp, items) {
    if (Prefs.get("autoTagCache", true) === false) return;
    try {
      const all = this._cacheAll();
      const keys = Object.keys(all);
      // LRU：超上限删最旧（对象插入序）
      if (!(fp in all) && keys.length >= this.CACHE_MAX) {
        for (const k of keys.slice(0, keys.length - this.CACHE_MAX + 1)) delete all[k];
      }
      all[fp] = { t: Date.now(), items };
      Prefs.set("autoTagCacheData", JSON.stringify(all));
    } catch (e) { try { Zotero.logError(e); } catch (_) { /* ignore */ } }
  },

  /* ==================== Zotero 数据层 ==================== */

  /** 标签语言：pref autoTagLang = auto（跟随界面）| zh | en */
  _effectiveLang() {
    const pref = String(Prefs.get("autoTagLang", "auto") || "auto");
    if (pref === "zh" || pref === "en") return pref;
    try {
      return (typeof I18n !== "undefined" && I18n.isZh) ? "zh" : "en";
    } catch (e) { return "zh"; }
  },

  /**
   * 全库高频标签采集（受控词表）。与 TagCurator.collectTagStats 同款遍历，
   * 但带 10 分钟内存缓存——AI 打标是逐条目调用，不能每条都扫全库。
   * 扫描失败 → 空词表（打标照常，只是少了复用提示）。
   */
  async _collectVocabulary() {
    const now = Date.now();
    if (this._vocab && this._vocabAt && now - this._vocabAt < this.VOCAB_TTL_MS) return this._vocab;
    const counts = new Map();
    try {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("itemType", "isNot", "attachment");
      const ids = await s.search();
      for (const id of ids) {
        const item = await Zotero.Items.getAsync(id);
        if (!item || item.deleted) continue;
        let tags = [];
        try { tags = item.getTags() || []; } catch (e) { tags = []; }
        for (const t of tags) {
          const name = t && t.tag;
          if (name) counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return []; // 失败不缓存，下次再试
    }
    // 高频优先 + 字符预算截断（Karakeep 同款预算思路）
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const vocab = [];
    let chars = 0;
    for (const [name] of sorted) {
      if (vocab.length >= this.VOCAB_MAX_TAGS) break;
      const cost = name.length + 1; // 顿号分隔
      if (chars + cost > this.VOCAB_MAX_CHARS) break;
      vocab.push(name);
      chars += cost;
    }
    this._vocab = vocab;
    this._vocabAt = now;
    return vocab;
  },

  /** 组装打标上下文（输入数据格式的唯一权威来源；字段级容错） */
  async buildContext(item) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const title = String(get("title") || "").slice(0, this.TITLE_MAX).trim();
    const abstract = String(get("abstractNote") || "").slice(0, this.ABSTRACT_MAX).trim();
    const publication = String(get("publicationTitle") || "").trim();
    let creators = "";
    try {
      const cs = item.getCreators() || [];
      creators = cs.slice(0, 3).map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).join(", ");
    } catch (e) { creators = ""; }
    let year = "";
    const dm = String(get("date") || "").match(/(\d{4})/);
    if (dm) year = dm[1];
    let itemType = "";
    try { itemType = Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch (e) { itemType = ""; }
    const language = String(get("language") || "").trim();
    let existingTags = [];
    try { existingTags = (item.getTags() || []).map((t) => t.tag).filter(Boolean); } catch (e) { existingTags = []; }
    if (!title && !abstract) {
      const err = new Error(I18n.isZh ? "该条目缺少标题与摘要，无法建议标签" : "No title/abstract — cannot suggest tags");
      err.code = "NO_META";
      throw err;
    }
    const max = Number(Prefs.get("autoTagMax", 6)) || 6;
    const lang = this._effectiveLang();
    const vocab = Prefs.get("autoTagUseVocab", true) === false ? [] : await this._collectVocabulary();
    return { title, abstract, publication, creators, year, itemType, language, existingTags, vocab, max, lang };
  },

  /* ==================== 提示词（纯函数，随 ctx.lang 切换） ==================== */

  buildPrompt(ctx) {
    const zh = ctx.lang !== "en";
    const max = ctx.max;
    let q;
    if (zh) {
      q =
        "请为以下论文建议不超过 " + max + " 个标签，用于文献管理与检索。\n\n" +
        "输出格式（严格遵守）：\n" +
        "- 只输出一个 JSON 数组，不要输出 JSON 以外的任何内容，不要用 Markdown 代码围栏；\n" +
        "- 每个元素形如 {\"tag\":\"#类别/名称\",\"reason\":\"不超过15字的选取依据\",\"confidence\":0到1之间的小数}。\n\n" +
        "标签要求：\n" +
        "1) 每个标签形如 #类别/名称，类别从「领域、方法、主题、数据、理论」中选；确无合适类别可省略类别（如 #预印本）；\n" +
        "2) 名称要具体到子领域或具体技术（如 #领域/图神经网络 而不是 #领域/计算机；#方法/双重差分 而不是 #方法/计量）；\n" +
        "3) 禁止宽泛标签（如 #研究、#论文、#方法）；同一概念只给一个标签；\n" +
        "4) 标签用中文，专有名词可保留英文；\n" +
        "5) confidence 表示你对该标签确实适用于本文的把握：仅凭标题与摘要无法确认的给低分。\n";
    } else {
      q =
        "Suggest at most " + max + " tags for the following paper for a reference library.\n\n" +
        "Output format (strict):\n" +
        "- Output ONLY a JSON array — nothing else, no Markdown fences;\n" +
        "- Each element: {\"tag\":\"#Category/name\",\"reason\":\"rationale in <=15 words\",\"confidence\":decimal 0-1}.\n\n" +
        "Tag rules:\n" +
        "1) Tags look like #Category/name; pick the category from Domain, Method, Topic, Data, Theory — omit it if none fits;\n" +
        "2) Be specific (#Domain/graph neural networks, not #Domain/computer science);\n" +
        "3) No generic tags (#research, #paper); one tag per concept;\n" +
        "4) Tags in English;\n" +
        "5) confidence reflects how sure the tag applies based on title/abstract alone.\n";
    }
    if (Array.isArray(ctx.vocab) && ctx.vocab.length) {
      q += (zh
        ? "\n库内已有标签（含义相同者优先复用其中的原样写法，不相关则忽略）：\n"
        : "\nExisting tags in this library (reuse the exact spelling when the meaning matches; ignore otherwise):\n")
        + ctx.vocab.join(zh ? "、" : ", ") + "\n";
    }
    if (Array.isArray(ctx.existingTags) && ctx.existingTags.length) {
      q += (zh
        ? "\n该条目已有的标签（不要重复建议）：\n"
        : "\nTags already on this item (do not suggest again):\n")
        + ctx.existingTags.join(zh ? "、" : ", ") + "\n";
    }
    q += "\n" + (zh ? "标题：" : "Title: ") + (ctx.title || "（无）") + "\n";
    if (ctx.creators) q += (zh ? "作者：" : "Authors: ") + ctx.creators + "\n";
    if (ctx.publication) q += (zh ? "期刊：" : "Journal: ") + ctx.publication + "\n";
    const meta = [ctx.year, ctx.itemType, ctx.language].filter(Boolean).join(" / ");
    if (meta) q += (zh ? "年份/类型/语言：" : "Year/Type/Language: ") + meta + "\n";
    q += (zh ? "摘要：" : "Abstract: ") + (ctx.abstract || "（无）");
    return q;
  },

  /* ==================== 编排层 ==================== */

  /**
   * 主入口：为单个条目建议标签（含理由与置信度）。
   * @returns {Promise<{suggestions:Array<{tag,reason,confidence}>,
   *                     dropped:{existing:string[]}, cached:boolean}>}
   */
  async suggestDetailed(item) {
    const ctx = await this.buildContext(item); // NO_META 在此抛出
    const fp = this._fingerprint(ctx);
    let cached = false;
    let items = this._cacheGet(fp);
    if (items && items.length) {
      cached = true;
    } else {
      const reply = await AIClient.chat([
        { role: "system", content: String(Prefs.get("aiSystemPrompt", "") || "") },
        { role: "user", content: this.buildPrompt(ctx) },
      ]);
      try { Zotero.debug("[PaperPilot] AutoTag AI raw reply: " + String(reply).slice(0, 500)); } catch (e) { /* ignore */ }
      const r = this._processReply(reply, ctx);
      if (!r.items.length) {
        throw new Error((I18n.isZh ? "AI 未返回有效标签（原始回复：" : "No valid tags (raw: ")
          + String(reply || "").slice(0, 120) + "…）");
      }
      items = r.items;
      this._cachePut(fp, items); // 缓存"对齐+校验后"的最终结果
    }
    // 运行期过滤：缓存命中后条目可能已写入部分标签
    const existing = new Set(ctx.existingTags);
    const suggestions = [];
    const droppedExisting = [];
    for (const it of items) {
      if (existing.has(it.tag)) droppedExisting.push(it.tag);
      else suggestions.push(it);
    }
    return { suggestions, dropped: { existing: droppedExisting }, cached };
  },

  /** 兼容层：automation.js 的 aiAutoTag 动作按 string[] 消费（上限 autoTagMax） */
  async suggest(item) {
    const r = await this.suggestDetailed(item);
    const max = Number(Prefs.get("autoTagMax", 6)) || 6;
    return r.suggestions.slice(0, Math.max(max, 1)).map((s) => s.tag);
  },

  /** 模态弹窗让用户勾选标签；取消返回 null。list 兼容 string[] 或 detail 对象数组 */
  pickTags(list, paperTitle, opts) {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    const detail = (Array.isArray(list) ? list : []).map((x) =>
      typeof x === "string" ? { tag: x, reason: "", confidence: 0.5 } : x);
    let threshold = Number(Prefs.get("autoTagConfidenceThreshold", 0.7));
    if (isNaN(threshold)) threshold = 0.7;
    threshold = Math.min(1, Math.max(0, threshold));
    const io = {
      tags: detail.map((d) => d.tag),
      detail,
      paperTitle: paperTitle || "",
      existing: (opts && opts.existing) || [],
      threshold,
      selected: null,
    };
    win.openDialog(
      "chrome://paperpilot/content/tag-preview.xhtml",
      "paperpilot-tag-preview",
      "chrome,modal,centerscreen,resizable",
      io
    );
    return io.selected;
  },

  /** 菜单入口：为选中条目逐个建议、勾选后写入（审核制不变，只是建议更聪明） */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    if (!AIClient.hasKey()) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot", I18n.t("chatNoKey"));
      return;
    }

    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    const bootProgress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      zh ? "正在准备库内标签词表…" : "Preparing tag vocabulary…");
    pw.show();
    try { await this._collectVocabulary(); } catch (e) { /* 词表失败不影响打标 */ }
    bootProgress.setProgress(100);
    bootProgress.setText(zh ? "词表就绪" : "Vocabulary ready");

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const r = await this.suggestDetailed(item);
        progress.setProgress(70);
        if (!r.suggestions.length) {
          progress.setText(zh ? "建议的标签都已存在或被过滤" : "All suggestions already present or filtered");
          progress.setProgress(100);
          continue;
        }
        const selected = this.pickTags(r.suggestions, title, { existing: r.dropped.existing });
        if (selected === null) {
          progress.setText(zh ? "已取消" : "Cancelled");
          progress.setProgress(100);
          continue;
        }
        if (selected.length) {
          for (const t of selected) item.addTag(t);
          await item.saveTx();
        }
        progress.setText(`${I18n.t("tagApplyDone")} ${selected.length} 个`
          + (r.cached ? (zh ? "（命中缓存，未消耗额度）" : " (cached)") : ""));
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        try { progress.setText(String((e && e.message) || e).slice(0, 120)); } catch (_) { /* ignore */ }
        Zotero.logError(e);
      }
    }
    pw.startCloseTimer(2500);
  },
};
