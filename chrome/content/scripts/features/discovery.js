/* PaperPilot 文献发现 · arXiv 每日推荐（0.24.0，功能借鉴 zotero-arxiv-daily）
 *
 * 解决的问题：PaperPilot 一直是「你已经知道要读什么」的工具。科研信息流需要
 * 反向能力——**从库里已有的兴趣出发，告诉你今天 arXiv 上有什么新东西值得看**。
 *
 * 路线（不引入向量库 / 不做外部服务，全部本地可算）：
 *   1) 兴趣画像：扫描库内条目 → 标题(×3)/标签(×3)/期刊(×2)/摘要(×1) 的词元频次
 *      加权；剔除「出现在过多条目里」的泛词；取 Top-N 作为画像词元；
 *      另从 extra/url/archiveID 里抽出 arXiv 分类（cs.CL 这类）作为偏好
 *   2) 拉取：走 ArxivFetch（分页 + 重试 + 限速），按分类（或按画像词元）取最近提交
 *   3) 打分：条目 标题词元命中 ×3 + 摘要命中 ×1，按画像权重累加；分类命中加成；
 *      新近度小加成（越新越高，7 天衰减）
 *   4) 去重：按 arXiv id / DOI / 归一化标题排除**已在库**的；按 id 排除用户已忽略的
 *   5) 缓存：按天写入 pref（discoveryResults），对话框直接读缓存，绝不每次开窗都请求
 *
 * 依赖纪律：全部网络只在「用户点刷新」或「每日定时（开关默认关）」时发生。
 *
 * ── 0.25.0 重构 ──────────────────────────────────────────────
 * 本模块**不再自带** arXiv 查询构建与 Atom 解析：那两件事（外加去重、限速、分页、重试）
 * 已抽成独立工具包 `tools/arxiv/`，再由 `scripts/build-arxiv-core.py` 生成到
 * `chrome/content/scripts/arxiv/`（纯函数核心，插件作用域可用）。
 *
 * 这样做是为了根治一个老问题：同一套解析逻辑在「CLI 工具」与「插件」里各写一份，
 * 然后慢慢漂移——表现是「命令行里解析对、插件里解析错」，且两边测试都是绿的。
 * 现在单一真源在 tools 侧，改逻辑改源文件 → 重跑生成器；`preflight.py` 会拦住忘记生成。
 *
 * 本模块保留的是**真正属于「发现」的东西**：兴趣画像、打分排序、库内去重、按天缓存。
 */
/* global Zotero, Services, Prefs, I18n, ArxivFetch, ArxivCategories, ArxivErrors */

var Discovery = {

  /* ---------------- 分词与画像（纯函数，可离线单测） ---------------- */

  /* ★ 画像专用停用词（真机验证后补）。
     背景：LibSearch 的 STOP 只挡了最基础的一批；实测真实库的画像第一词是
     `inspire`（783）、随后是 `found`/`from`/`that`/`this`/`results` —— 全是
     功能词与插件噪声，推荐结果因此完全跑偏。这里补上完整的功能词与泛学术词。 */
  EXTRA_STOP: new Set(("a an the and or but if then than that this these those there their them they its it " +
    "as at by for from with without within into onto over under between among during after before above below across through upon per via " +
    "is are was were be been being am do does did done have has had having " +
    "will would shall should can could may might must not no nor so such also too very just only even still yet " +
    "more most much many some any all both each other another one two three first second third new same different " +
    "what which who whom whose when where why how " +
    "about results result show shows shown showed found find finds finding propose proposed present presented provide provides " +
    "using used use uses based however therefore thus furthermore moreover although while due given including include includes " +
    "respectively respectively paper papers study studies " +
    // 中文功能词与泛学术词（真机验证显示，中文库里「治疗/临床/中国/杂志/专家/指南/进展」
    // 这类词会占据画像前列；更多泛词由「出现于过多条目」的 df 过滤兜底）
    "研究 分析 方法 结果 目的 结论 探讨 本文 我们 进行 通过 以及 具有 显著 表明 提示 相关 不同 高于 低于 " +
    "治疗 临床 中国 杂志 专家 指南 进展 共识 作用 影响 关系 意义 现状 问题 应用 观察 疾病 患者 医药 统计 资料 对象 疗效 " +
    "疗效 观察 分析 比较 评价 系统 综述 报道 调查 检测 诊断 组 例 一般资料").split(/\s+/).filter(Boolean)),

  /* 状态/管理类标签识别（★ 真机验证后新增）。
     实测：Better BibTeX 之类插件会给条目打「⛔ No INSPIRE recid found」（261 条）、
     「⛔ No DOI found」（94 条），阅读状态类还有「/unread」「未读」。
     这些是**管理标记**不是研究兴趣，但标签权重 ×3 → `inspire` 一度成为画像第一词。
     规则：以非字母数字非汉字开头（⛔ / # @ …）即视为标记；再加一小份状态词表。 */
  STATUS_WORDS: new Set(["unread", "read", "reading", "to read", "toread", "done", "todo", "important",
    "未读", "在读", "已读", "待读", "待看", "已归档", "归档"]),

  isNoiseTag(tag) {
    const t = String(tag == null ? "" : tag).trim();
    if (!t) return true;
    const c = t.codePointAt(0);
    const wordStart = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 0x4e00 && c <= 0x9fff);
    if (wordStart) {
      if (/^no\s+(doi|inspire|arxiv|pmid|issn)/i.test(t)) return true;
      return this.STATUS_WORDS.has(t.toLowerCase());
    }
    // 非文字开头：引号/书名号/括号开头视为**内容**标签（实测库里有「《中医方剂大辞典》」这类），
    // 其余（⛔ ✓ × # / @ ⭐ …）一律视为标记
    return "《“‘”’「『(（[【<".indexOf(t[0]) < 0;
  },

  /** 分词：复用 LibSearch（单一真源），再叠加画像专用的停用词 */
  tokenize(text) {
    let toks;
    if (typeof LibSearch !== "undefined" && LibSearch && LibSearch.tokenize) {
      toks = LibSearch.tokenize(text);
    } else {
      // 兜底（LibSearch 未加载时的最小实现，行为与之一致）
      const s = String(text || "").toLowerCase();
      toks = [];
      for (const m of s.match(/[a-z][a-z0-9\-_.]{1,}/g) || []) if (m.length >= 2) toks.push(m);
      for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
        if (run.length <= 4) toks.push(run);
        for (let i = 0; i + 2 <= run.length; i++) toks.push(run.slice(i, i + 2));
      }
      toks = [...new Set(toks)];
    }
    return toks.filter((t) => !this.EXTRA_STOP.has(t));
  },

  /** 条目 → arXiv 分类 / arXiv id 抽取（扫 extra、url、archiveID、repository） */
  extractArxiv(item) {
    let blob = "";
    for (const f of ["extra", "url", "archiveID", "archiveLocation", "repository", "DOI"]) {
      try { blob += " " + String(item.getField(f) || ""); } catch (e) { /* ignore */ }
    }
    const idm = blob.match(/arxiv[:\s/]*(\d{4}\.\d{4,5})(v\d+)?/i);
    const cats = [];
    for (const m of blob.match(/\b([a-z]{2,}(?:-[a-z]{2,})?\.[A-Z]{2})\b/g) || []) cats.push(m);
    return { arxivId: idm ? idm[1] : "", categories: [...new Set(cats)] };
  },

  /**
   * 构建兴趣画像
   * @param {Array} items Zotero 条目
   * @param {{topTerms?:number, maxDocFreq?:number}} opts
   * @returns {{terms:Array<{term:string,weight:number}>, categories:Array<string>, scanned:number}}
   */
  buildProfile(items, opts) {
    const o = opts || {};
    const topTerms = o.topTerms || 40;
    const docs = [];
    const catCount = new Map();
    for (const it of items || []) {
      const g = (f) => { try { return String(it.getField(f) || ""); } catch (e) { return ""; } };
      let tags = "";
      try {
        // 跳过状态/管理类标签（⛔ / # / unread / 未读 …），否则它们会主导画像
        tags = (it.getTags() || []).map((t) => t.tag).filter((t) => !this.isNoiseTag(t)).join(" ");
      } catch (e) { tags = ""; }
      const title = g("title");
      const abstract = g("abstractNote");
      const journal = g("publicationTitle") || g("bookTitle") || g("proceedingsTitle") || "";
      const bag = new Map();
      const add = (text, w) => { for (const t of this.tokenize(text)) bag.set(t, (bag.get(t) || 0) + w); };
      add(title, 3); add(tags, 3); add(journal, 2); add(abstract, 1);
      if (!bag.size) continue;
      docs.push(bag);
      const ax = this.extractArxiv(it);
      for (const c of ax.categories) catCount.set(c, (catCount.get(c) || 0) + 1);
    }
    const df = new Map();
    const total = new Map();
    for (const bag of docs) {
      for (const [t, w] of bag) {
        df.set(t, (df.get(t) || 0) + 1);
        total.set(t, (total.get(t) || 0) + w);
      }
    }
    // 泛词过滤：出现于超过 maxDocFreq 比例的文档 → 去掉（这些词无区分度）。
    // 下限取 3 而非 2：小库（新用户常见）里「出现在 2 篇」的词往往是真兴趣，
    // 用 2 当阈值会把画像清空 → 看起来功能「没效果」。
    const maxRatio = o.maxDocFreq || 0.4;
    const floor = Math.max(3, Math.ceil(docs.length * maxRatio));
    const terms = [...total.entries()]
      // 长度下限必须 **≥2**：中文词元是 bigram（2 字），写 ≥3 会把
      // 「抽动 / 障碍 / 中医 / 数据」这类核心中文词**整体丢掉**
      // （真机验证在中文库上实测：画像 Top 里一个中文词都没有）
      .filter(([t]) => (df.get(t) || 0) < floor && t.length >= 2)
      .map(([term, weight]) => ({ term, weight: Math.round(weight * 100) / 100 }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topTerms);
    const categories = [...catCount.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 8);
    return { terms, categories, scanned: docs.length };
  },

  /* ---------------- 条目形状适配（0.25.0） ----------------
   *
   * 解析已移交给生成出来的 ArxivAtom（单一真源 tools/arxiv/src/atom.js）。
   * 它产出的字段名与 UI 期望的略有差异：核心用 absUrl/pdfUrl，而 discovery-ui.js 读
   * link/pdfLink。这里做一次显式别名映射，而不是去改窗口脚本——
   * 窗口脚本跑在独立作用域、改动面越大回归风险越高，且 link/pdfLink 在旧缓存里已落盘，
   * 改了字段名会让「升级后首次打开」读旧缓存时字段缺失。
   */
  _normalize(e) {
    const abs = e.absUrl || e.idUrl || "";
    const pdf = e.pdfUrl || "";
    return {
      arxivId: e.arxivId,
      version: e.version,
      versionTag: e.versionTag,
      title: e.title,
      summary: e.summary,
      authors: e.authors || [],
      authorsDetailed: e.authorsDetailed || [],
      published: e.published,
      updated: e.updated,
      updatedDay: e.updatedDay || "",
      categories: e.categories || [],
      primaryCategory: e.primaryCategory || e.archive || "",
      archive: e.archive || "",
      doi: e.doi || "",
      journalRef: e.journalRef || "",
      comment: e.comment || "",
      link: abs,
      pdfLink: pdf,
      absUrl: abs,
      pdfUrl: pdf,
    };
  },

  /** 把 ArxivErrors 的中文说明转成给用户看的一句话（带建议时一起给）。 */
  _errText(e, zh) {
    if (!e) return zh ? "未知错误" : "unknown error";
    let s = (e.message || String(e));
    if (e.hint) s += (zh ? "（建议：" : " (hint: ") + e.hint + ")";
    return s;
  },

  /* ---------------- 打分与去重（纯函数） ---------------- */

  /** 标题归一化（用于「是否已在库」判定） */
  normTitle(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "").slice(0, 120);
  },

  /** 已在库的标识集合：{ids:Set, dois:Set, titles:Set} */
  knownIndex(items) {
    const ids = new Set(), dois = new Set(), titles = new Set();
    for (const it of items || []) {
      const g = (f) => { try { return String(it.getField(f) || ""); } catch (e) { return ""; } };
      const ax = this.extractArxiv(it);
      if (ax.arxivId) ids.add(ax.arxivId);
      const doi = g("DOI").trim().toLowerCase();
      if (doi) dois.add(doi);
      const t = this.normTitle(g("title"));
      if (t && t.length > 12) titles.add(t);
    }
    return { ids, dois, titles };
  },

  isKnown(entry, known) {
    if (!known) return false;
    if (entry.arxivId && known.ids.has(entry.arxivId)) return true;
    if (entry.doi && known.dois.has(String(entry.doi).trim().toLowerCase())) return true;
    const t = this.normTitle(entry.title);
    return !!(t && t.length > 12 && known.titles.has(t));
  },

  /**
   * 打分：画像词元命中（标题 ×3 / 摘要 ×1）+ 分类加成 + 新近度加成
   * @returns {{score:number, reasons:string[]}}
   */
  scoreEntry(entry, profile, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const tw = new Map();
    for (const t of this.tokenize(entry.title)) tw.set(t, (tw.get(t) || 0) + 1);
    const sw = new Map();
    for (const t of this.tokenize(entry.summary)) sw.set(t, (sw.get(t) || 0) + 1);
    let score = 0;
    let termHits = 0;   // 命中的画像词元个数（不含仅分类加成）——判断推荐是否真有信号
    const reasons = [];
    for (const { term, weight } of profile.terms || []) {
      let hit = 0;
      if (tw.has(term)) hit += 3 * Math.min(2, tw.get(term));
      if (sw.has(term)) hit += 1 * Math.min(3, sw.get(term));
      if (hit) { score += weight * hit; termHits++; if (reasons.length < 6) reasons.push(term); }
    }
    const prefCats = new Set(o.categories || []);
    let catHit = "";
    for (const c of entry.categories || []) {
      if (prefCats.has(c) || (profile.categories || []).includes(c)) { catHit = c; break; }
    }
    if (catHit) { score += 4; reasons.push(catHit); }
    // 新近度：7 天内线性 6→0 的加成（鼓励看新提交）
    let dayBoost = 0;
    try {
      const days = (now - new Date(entry.published).getTime()) / 86400000;
      if (isFinite(days) && days >= 0) dayBoost = Math.max(0, 6 * (1 - days / 7));
    } catch (e) { dayBoost = 0; }
    score += dayBoost;
    return { score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)], termHits };
  },

  /** 排序 + 去重 + 截断（纯函数）：输入原始条目与画像，输出推荐数组 */
  rank(entries, profile, opts) {
    const o = opts || {};
    const seen = new Set();
    const scored = [];
    for (const e of entries || []) {
      if (!e.arxivId || seen.has(e.arxivId)) continue;
      if (o.known && this.isKnown(e, o.known)) continue;
      if (o.ignored && o.ignored.has(e.arxivId)) continue;
      seen.add(e.arxivId);
      const s = this.scoreEntry(e, profile, { categories: o.categories, now: o.now });
      if (s.score <= 0 && !o.keepZero) continue;
      scored.push(Object.assign({}, e, { score: s.score, reasons: s.reasons, termHits: s.termHits }));
    }
    scored.sort((a, b) => b.score - a.score || String(b.published).localeCompare(String(a.published)));
    return scored.slice(0, o.max || 30);
  },

  /* ---------------- 检索条件构建与拉取 ---------------- */

  /**
   * 把「画像 + 用户设置的分类」翻成检索条件。
   *
   * ★ 多分类必须用 `categoryMode: "OR"`（并集）。默认的 AND 表示「同时属于这些分类的
   * 交叉列表论文」——用户填 `cs.AI, cs.CL, cs.LG` 的意图显然是「这几个领域里的新东西」，
   * 用 AND 会把结果集从「任意其一」缩到「三者皆属」，直接偏离预期（0.24.0 的旧实现
   * 就是手写 `+OR+`，重构时若照搬默认值会静默改变推荐结果集）。
   *
   * @returns {object|null} 交给 ArxivFetch.search 的 spec；无法构建时返回 null
   */
  _spec(profile, cats) {
    const list = (cats || []).filter(Boolean).slice(0, 4);
    if (list.length) return { categories: list, categoryMode: "OR" };
    const terms = (profile && profile.terms ? profile.terms : [])
      .slice(0, 6)
      .map((t) => String(t.term || "").replace(/["\\]/g, ""))
      .filter(Boolean);
    if (!terms.length) return null;
    // 画像词元之间是 OR：命中任意一个兴趣词都算相关（要求全命中会几乎无结果）
    return { keywords: terms, boolean: "OR" };
  },

  /** 分类拼写核对（只提醒、不中止）：cs.cl / cs.NLP 这类是新手最常见的失败原因。 */
  _categoryNote(cats, zh) {
    if (!cats || !cats.length) return "";
    let r;
    try { r = ArxivCategories.checkAll(cats); } catch (e) { return ""; }
    const bad = (r.unknown || []).concat(r.malformed || []);
    if (!bad.length) return "";
    const hints = (r.suggestions || []).slice(0, 3)
      .map((s) => s.input + "→" + s.suggestions.slice(0, 2).map((x) => x.code).join("/"));
    return (zh ? "分类可能写错了（arXiv 区分大小写）：" : "Possibly invalid categories (case-sensitive): ")
      + bad.join(", ") + (hints.length ? (zh ? "；可能是：" : "; did you mean: ") + hints.join("、") : "");
  },
  /** 读取/写入缓存 */
  loadCache() {
    try {
      const raw = Prefs.get("discoveryResults", "");
      const d = raw ? JSON.parse(raw) : null;
      if (d && Array.isArray(d.items)) return d;
    } catch (e) { /* 脏数据回落 */ }
    return { generatedAt: "", items: [], profile: { terms: [], categories: [] }, scope: "" };
  },

  saveCache(data) {
    try { Prefs.set("discoveryResults", JSON.stringify(data)); } catch (e) { /* ignore */ }
  },

  ignoredSet() {
    try {
      const raw = Prefs.get("discoveryIgnored", "");
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
  },

  /** 忽略某条推荐（持久化，重启后仍隐藏） */
  ignore(arxivId) {
    if (!arxivId) return;
    const set = this.ignoredSet();
    set.add(arxivId);
    try { Prefs.set("discoveryIgnored", JSON.stringify([...set].slice(-500))); } catch (e) { /* ignore */ }
  },

  /** 今天（本地）的 YYYY-MM-DD */
  _today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  },

  categoriesPref() {
    return String(Prefs.get("discoveryCategories", "") || "")
      .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  },

  /**
   * 执行一次发现：构建画像 → 拉取 → 打分 → 缓存
   * @returns {{ok:boolean, reason?:string, count?:number, ...}}
   */
  async run(opts) {
    const zh = I18n.isZh;
    const cats = this.categoriesPref();
    let items;
    try { items = await this.collectLibraryItems(); }
    catch (e) { return { ok: false, reason: (zh ? "读取库失败：" : "Library read failed: ") + (e && e.message || e) }; }

    const profile = this.buildProfile(items, { topTerms: Number(Prefs.get("discoveryProfileTerms", 40)) });
    const spec = this._spec(profile, cats);
    if (!spec) {
      return { ok: false, reason: zh
        ? "库中可分析的文献太少，且未指定 arXiv 分类。请先在设置里填写分类（如 cs.CL, cs.AI），或先往库里导入一些文献。"
        : "Not enough analyzable items and no arXiv categories set." };
    }
    const catNote = this._categoryNote(cats, zh);
    // 条数上限走既有 pref（默认 100）；每页 100 拉、最多 5 页 ——
    // 既满足「多看一些」，也不会把用户按在刷新按钮上等太久（3 秒/次是 arXiv 的硬约束）。
    const limit = Math.max(1, Math.min(500, Number(Prefs.get("discoveryMaxPerFeed", 100)) || 100));
    const pageSize = Math.max(1, Math.min(100, limit));
    let res;
    try {
      res = await ArxivFetch.search(spec, {
        limit: limit,
        pageSize: pageSize,
        maxPages: Math.max(1, Math.ceil(limit / pageSize)),
      });
    } catch (e) {
      return { ok: false, reason: (zh ? "arXiv 拉取失败：" : "arXiv fetch failed: ") + this._errText(e, zh) };
    }
    const entries = (res.entries || []).map((e) => this._normalize(e));
    if (!entries.length) {
      return { ok: false, reason: [zh ? "arXiv 没有返回条目。" : "arXiv returned no entries.", catNote].filter(Boolean).join(" ") };
    }
    const known = this.knownIndex(items);
    const ranked = this.rank(entries, profile, {
      known,
      ignored: this.ignoredSet(),
      categories: cats,
      max: Number(Prefs.get("discoveryMaxResults", 30)) || 30,
    });
    // ★ 真机验证后新增：只命中分类、没有任何画像词元命中时，推荐其实「没有信号」。
    // 必须显式说明并给出可执行建议，而不是静静给出一张看起来正常的无用清单
    // （实测：中医/抽动障碍主题的库 + 默认 cs.AI/cs.CL/cs.LG → 30 条推荐全 9.1 分、零词元命中）
    const withTermHits = ranked.filter((e) => (e.termHits || 0) > 0).length;
    let note = catNote;
    if (ranked.length && withTermHits === 0) {
      note = [note, zh
        ? "本批推荐没有任何一条与你的库内兴趣词真实重合（只命中了分类）。很可能所选 arXiv 分类与你的研究领域不匹配——"
          + "请把分类改成领域对应的（例如神经科学用 q-bio.NC、医学信息学用 q-bio.QM），或清空分类框改用库内兴趣词检索。"
        : "None of these recommendations match your library's interest terms (category boost only). "
          + "The chosen categories likely don't match your field — change them, or clear the field to search by interest terms."
      ].filter(Boolean).join(" ");
    }
    const data = {
      generatedAt: new Date().toISOString(),
      scope: cats.length ? (zh ? "分类：" : "Categories: ") + cats.join(", ") : (zh ? "按库内兴趣词" : "By interest terms"),
      query: res.query,
      fetched: entries.length,
      pages: res.pages,
      totalResults: res.totalResults,
      duplicatesRemoved: res.duplicatesRemoved,
      termMatched: withTermHits,
      note,
      profile: { terms: profile.terms.slice(0, 20), categories: profile.categories },
      items: ranked,
    };
    this.saveCache(data);
    Prefs.set("discoveryLastRun", this._today());
    return { ok: true, count: ranked.length, fetched: entries.length, pages: res.pages,
      duplicatesRemoved: res.duplicatesRemoved, totalResults: res.totalResults, data };
  },

  /** 全库常规条目（用于画像与去重） */
  async collectLibraryItems() {
    const out = [];
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    s.addCondition("itemType", "isNot", "note");
    for (const id of await s.search()) {
      const it = await Zotero.Items.getAsync(id);
      if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) out.push(it);
    }
    return out;
  },

  /* ---------------- 收藏到库 ---------------- */

  /** 把一条推荐建成库内条目（preprint 类型，字段逐个 try/catch，缺字段回落 extra） */
  async createItem(entry) {
    const item = new Zotero.Item("preprint");
    item.libraryID = Zotero.Libraries.userLibraryID;
    const set = (f, v) => { if (v == null || v === "") return false; try { item.setField(f, v); return true; } catch (e) { return false; } };
    set("title", entry.title);
    set("abstractNote", entry.summary);
    if (entry.published) set("date", String(entry.published).slice(0, 10));
    // 兼容两种输入：核心 entry（absUrl/pdfUrl）与 UI 归一化后的 entry（link/pdfLink）
    set("url", entry.absUrl || entry.link || "");
    set("repository", "arXiv");
    if (entry.doi) set("DOI", entry.doi);
    if (entry.journalRef) set("publicationTitle", entry.journalRef);
    let placed = set("archiveID", entry.arxivId ? "arXiv:" + entry.arxivId : "");
    if (!placed && entry.arxivId) {
      try { item.setField("extra", "arXiv:" + entry.arxivId); } catch (e) { /* ignore */ }
    }
    const creators = (entry.authors || []).map((n) => {
      const parts = String(n).trim().split(/\s+/);
      if (parts.length >= 2) {
        const last = parts.pop();
        return { creatorType: "author", firstName: parts.join(" ").replace(/^\*+/, "").trim(), lastName: last };
      }
      return { creatorType: "author", name: String(n) };
    });
    if (creators.length) item.setCreators(creators);
    await item.saveTx();
    return item;
  },

  /** 收藏并加入「推荐」分类（分类不存在则创建） */
  async collect(entry) {
    const item = await this.createItem(entry);
    if (!item) return null;
    const name = String(Prefs.get("discoveryCollectionName", "arXiv 推荐") || "arXiv 推荐");
    const libID = Zotero.Libraries.userLibraryID;
    // ⚠️ `Zotero.Library` 没有 `getCollections()`（真机验证抓到的 bug：调用抛 TypeError
    // 被外层 catch 吞掉 → 条目建好了却**永远加不进分类**，用户视角「收藏了但没进分类」）。
    // 正确 API = `Zotero.Collections.getByLibrary(libraryID, recursive, includeTrashed)`。
    let col = null;
    try {
      const cols = Zotero.Collections.getByLibrary(libID, true, false) || [];
      col = cols.find((c) => c.name === name) || null;
    } catch (e) {
      return { item, collection: null, colError: String((e && e.message) || e) };
    }
    try {
      if (!col) {
        col = new Zotero.Collection();
        col.libraryID = libID;
        col.name = name;
        await col.saveTx();
      }
      await col.addItem(item.id);
      return { item, collection: col };
    } catch (e) {
      return { item, collection: null, colError: String((e && e.message) || e) };
    }
  },

  /** 推荐列表 → 笔记（纯函数） */
  listMarkdown(data) {
    const zh = I18n.isZh;
    let md = "## " + (zh ? "arXiv 每日推荐" : "arXiv Daily") + "\n" +
      "- " + (zh ? "生成时间" : "Generated") + "：" + String(data.generatedAt || "").replace("T", " ").slice(0, 16) + "\n" +
      "- " + (zh ? "范围" : "Scope") + "：" + (data.scope || "-") + "\n\n";
      if (data.note) md += "\n> ⚠️ " + data.note + "\n";
    (data.items || []).forEach((e, i) => {
      md += "### " + (i + 1) + ". " + e.title + "\n";
      md += "- " + (e.authors || []).slice(0, 4).join(", ") + ((e.authors || []).length > 4 ? " et al." : "") + "\n";
      md += "- " + String(e.published || "").slice(0, 10) + " ｜ " + (e.categories || []).join(", ") +
        " ｜ arXiv:" + e.arxivId + "\n";
      md += "- " + (zh ? "相关度" : "Score") + " " + e.score + (e.reasons && e.reasons.length ? "（" + (zh ? "命中：" : "matched: ") + e.reasons.join(", ") + "）" : "") + "\n";
      md += "- " + e.link + "\n";
      md += "\n" + String(e.summary || "").slice(0, 400) + "\n\n";
    });
    md += "> " + (zh ? "由 PaperPilot 文献发现生成，请自行判断相关性。" : "Generated by PaperPilot Discovery.");
    return md;
  },

  async saveListAsNote(data) {
    const zh = I18n.isZh;
    const md = this.listMarkdown(data);
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    try {
      const M = (typeof MdLite !== "undefined") ? MdLite : null;
      note.setNote(M ? M.toNoteHtml(zh ? "arXiv 每日推荐" : "arXiv Daily", md) : "<pre>" + md + "</pre>");
    } catch (e) { note.setNote("<pre>" + String(md).replace(/</g, "&lt;") + "</pre>"); }
    await note.saveTx();
    return note;
  },

  /* ---------------- 每日定时（默认关闭） ---------------- */

  _timer: null,

  start() {
    if (this._timer) return;
    // 每 30 分钟检查一次「是否到了今天的刷新时间」；功能未开启时直接返回
    this._timer = setInterval(() => { this._maybeDaily().catch(() => {}); }, 30 * 60 * 1000);
    // 启动后 90s 首次检查（避开启动高峰）
    setTimeout(() => { this._maybeDaily().catch(() => {}); }, 90 * 1000);
  },

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  async _maybeDaily() {
    try {
      if (!Prefs.get("discoveryEnabled", false)) return;
      if (Prefs.get("discoveryLastRun", "") === this._today()) return;
      Zotero.debug("PaperPilot discovery: daily refresh starting");
      const r = await this.run();
      Zotero.debug("PaperPilot discovery daily: " + JSON.stringify({ ok: r.ok, count: r.count, reason: r.reason }));
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /** 菜单/功能中心入口：打开推荐窗口 */
  openDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const en = Services.wm.getEnumerator("paperpilot:discovery");
      if (en.hasMoreElements()) { const w = en.getNext(); w.focus(); return w; }
    } catch (e) { /* ignore */ }
    return win.openDialog(
      "chrome://paperpilot/content/discovery.xhtml",
      "paperpilot-discovery",
      "chrome,centerscreen,resizable,dialog=no",
      { Zotero, Services }
    );
  },
};
