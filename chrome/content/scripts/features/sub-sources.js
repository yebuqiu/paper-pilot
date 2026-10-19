// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 检索订阅 · 数据源适配层（0.57.0）
 *
 * 为什么单独一层：订阅的「条件」与「去哪查」不是一回事。arXiv 只覆盖预印本，
 * 医学/社科用户的库大半在 PubMed / 期刊库里；把多源塞进 search-subs.js 会让
 * 调度、去重、入库三件事与 HTTP 细节纠缠。这里只做四件事：
 *
 *   1) 把统一的订阅条件（keywords / categories / mode / exclude / maxAgeDays）
 *      翻译成各源自己的查询（build 纯函数，可离线单测）
 *   2) 发请求（每源自己的节奏与分页；arXiv 复用 ArxivFetch 的 3s 限速）
 *   3) 把各源返回归一成同一个 entry 形状（normalize 纯函数）
 *   4) 合并多源、跨源去重（DOI > arXiv ID > 归一标题）
 *
 * 设计纪律（与全仓一致）：
 *   - 绝不抛给调用方：每个源失败只记 `bySource[id].reason`，其余源继续；
 *   - 4xx/5xx Zotero.HTTP 不抛异常（见 arxiv-fetch.js 头注释），必须自己判 status；
 *   - 每条请求加应用层超时竞速，避免挂起的 XHR 占满连接池后「永不返回」；
 *   - 纯函数不读 pref / 不碰网络，便于 node vm 沙箱单测。
 */
/* global Zotero, Prefs, ArxivFetch, ArxivQuery, ArxivCategories */

var SubSources = {
  /** 支持的源（UI 顺序即此顺序）。capabilities 用于表单联动与提示。 */
  LIST: [
    { id: "arxiv", label: "arXiv", caps: { categories: true, keywords: true, exclude: true, citations: false }, hint: "预印本，覆盖数理/CS/生医等；3 秒/次的官方限速" },
    { id: "openalex", label: "OpenAlex", caps: { categories: false, keywords: true, exclude: true, citations: true }, hint: "跨学科期刊与会议，带被引量/开放获取链接；免费无需 Key" },
    { id: "crossref", label: "Crossref", caps: { categories: false, keywords: true, exclude: true, citations: true }, hint: "以 DOI 为中心的元数据，覆盖全学科出版物" },
    { id: "europepmc", label: "Europe PMC", caps: { categories: false, keywords: true, exclude: true, citations: true }, hint: "生物医学（含 PubMed 记录与预印本）；国内网络通常比 NCBI 稳定" },
    { id: "pubmed", label: "PubMed", caps: { categories: false, keywords: true, exclude: true, citations: false }, hint: "NCBI 官方检索；部分网络不可达时单独报错，不影响其它源" },
  ],

  /** 单源最少请求间隔（arXiv 由 ArxivRateLimiter 管，这里只管其它源） */
  MIN_INTERVAL: { openalex: 400, crossref: 400, europepmc: 400, pubmed: 400 },

  _lastAt: {},

  /* ================== 元信息 ================== */

  ids() { return this.LIST.map((s) => s.id); },

  label(id) {
    for (const s of this.LIST) if (s.id === id) return s.label;
    return String(id || "");
  },

  exists(id) {
    return this.ids().indexOf(String(id || "")) >= 0;
  },

  /** 规范化源列表：过滤未知、去重、保序；空 → ["arxiv"]（兼容 0.53 旧订阅） */
  normalizeSources(raw) {
    const list = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[,;\s]+/);
    const out = [];
    for (const x of list) {
      const id = String(x == null ? "" : x).trim().toLowerCase();
      if (this.exists(id) && out.indexOf(id) < 0) out.push(id);
    }
    return out.length ? out : ["arxiv"];
  },

  /* ================== 条件归一（纯函数） ================== */

  split(raw) {
    return String(raw == null ? "" : raw)
      .split(/[,;，；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  },

  keywordsOf(sub) { return this.split(sub && sub.keywords).slice(0, 12); },
  categoriesOf(sub) { return this.split(sub && sub.categories).slice(0, 6); },
  excludeOf(sub) { return this.split(sub && sub.exclude).slice(0, 12); },

  modeOf(sub) {
    const m = String((sub && sub.mode) || "all").toLowerCase();
    return m === "any" || m === "phrase" ? m : "all";
  },

  /** 只要最近 N 天：0 / 空 / 非法 = 不限 */
  maxAgeDays(sub) {
    const n = parseInt(sub && sub.maxAgeDays, 10);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(3650, n));
  },

  /** 本地日期键 YYYY-MM-DD（不用 toISOString，避免时区把日期挪一天） */
  dayKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
  },

  /** 订阅的起始日期（maxAgeDays → YYYY-MM-DD）；不限时返回 "" */
  dateFrom(sub, now) {
    const days = this.maxAgeDays(sub);
    if (!days) return "";
    const at = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    const base = isNaN(at.getTime()) ? new Date() : at;
    return this.dayKey(new Date(base.getTime() - days * 86400000));
  },

  /* ================== 各源查询构建（纯函数） ================== */

  /** 带引号的词：内部双引号会破坏语法，先剔掉 */
  _q(term) {
    return '"' + String(term || "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim() + '"';
  },

  /** OpenAlex `search` 参数：支持 AND / OR / 引号短语 */
  openAlexQuery(sub) {
    const kws = this.keywordsOf(sub);
    if (!kws.length) return "";
    const mode = this.modeOf(sub);
    if (mode === "phrase") return this._q(kws.join(" "));
    return kws.map((k) => this._q(k)).join(mode === "any" ? " OR " : " AND ");
  },

  /** Crossref `query.bibliographic`：相关度检索，布尔由本地二次过滤兜底 */
  crossrefQuery(sub) {
    const kws = this.keywordsOf(sub);
    if (!kws.length) return "";
    if (this.modeOf(sub) === "phrase") return kws.join(" ");
    return kws.join(" ");
  },

  /**
   * PubMed 检索式：每词限定 [tiab]（标题/摘要），剔除纯分类。
   * 无关键词时返回 ""（PubMed 不吃 arXiv 分类）。
   */
  pubmedTerm(sub) {
    const kws = this.keywordsOf(sub);
    if (!kws.length) return "";
    const mode = this.modeOf(sub);
    const parts = kws.map((k) => (/[\s-]/.test(k) ? this._q(k) : k) + "[tiab]");
    let q;
    if (mode === "phrase") q = this._q(kws.join(" ")) + "[tiab]";
    else if (parts.length === 1) q = parts[0];
    else q = "(" + parts.join(mode === "any" ? " OR " : " AND ") + ")";
    const ex = this.excludeOf(sub);
    if (ex.length) q += " NOT (" + ex.map((k) => (/[\s-]/.test(k) ? this._q(k) : k) + "[tiab]").join(" OR ") + ")";
    return q;
  },

  /**
   * Europe PMC 检索式：与 PubMed 不同，它直接支持引号与 AND/OR/NOT。
   * 无关键词时返回 ""（分类只对 arXiv 有意义）。
   */
  europePmcQuery(sub) {
    const kws = this.keywordsOf(sub);
    if (!kws.length) return "";
    const mode = this.modeOf(sub);
    if (mode === "phrase") return this._q(kws.join(" "));
    let q = kws.map((k) => (/[\s-]/.test(k) ? this._q(k) : k)).join(mode === "any" ? " OR " : " AND ");
    const ex = this.excludeOf(sub);
    if (ex.length) q += " NOT (" + ex.map((k) => (/[\s-]/.test(k) ? this._q(k) : k)).join(" OR ") + ")";
    return q;
  },

  /** arXiv spec（Discovery / ArxivFetch 同款语义：多分类并集、关键词 AND/OR） */
  arxivSpec(sub, now) {
    const kws0 = this.keywordsOf(sub);
    const cats = this.categoriesOf(sub);
    const mode = this.modeOf(sub);
    // 整句短语：把多个词合成一个短语再交给 phrase 模式（否则会被拆成多个 AND 短语）
    const kws = mode === "phrase" && kws0.length > 1 ? [kws0.join(" ")] : kws0;
    const spec = {
      keywords: kws,
      categories: cats,
      categoryMode: "OR",
      boolean: mode === "any" ? "OR" : "AND",
      phrase: mode === "phrase",
    };
    const ex = this.excludeOf(sub);
    if (ex.length) spec.excludeKeywords = ex;
    const from = this.dateFrom(sub, now);
    if (from) spec.dateFrom = from.replace(/-/g, "") + "0000";
    return spec;
  },

  /* ================== 归一（纯函数） ================== */

  /** OpenAlex 摘要以倒排索引返回：{word: [pos,...]} → 正常语序文本 */
  abstractFromInverted(index) {
    if (!index || typeof index !== "object") return "";
    const slots = [];
    for (const word of Object.keys(index)) {
      const pos = Array.isArray(index[word]) ? index[word] : [];
      for (const p of pos) {
        const i = Number(p);
        if (isFinite(i) && i >= 0 && i < 20000) slots[i] = word;
      }
    }
    return slots.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  },

  _stripTags(s) {
    return String(s == null ? "" : s)
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+([.,;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  },

  _doi(v) {
    return String(v == null ? "" : v)
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .replace(/\s+/g, "")
      .replace(/[.,;]+$/, "")
      .trim();
  },

  _dateOnly(v) {
    const s = String(v == null ? "" : v).trim();
    const m = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return s.slice(0, 10);
    return m[1] + "-" + (m[2] || "01") + "-" + (m[3] || "01");
  },

  _authors(list, pick) {
    const out = [];
    for (const a of list || []) {
      let name = "";
      try { name = pick(a); } catch (e) { name = ""; }
      name = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
      if (name) out.push(name);
    }
    return out.slice(0, 60);
  },

  normalizeOpenAlex(w) {
    const r = w || {};
    const loc = r.primary_location || {};
    const src = loc.source || {};
    const oa = r.open_access || {};
    const biblio = r.biblio || {};
    const topic = r.primary_topic || {};
    return {
      source: "openalex",
      id: String(r.id || "").replace(/^https?:\/\/openalex\.org\//, ""),
      doi: this._doi(r.doi),
      title: this._stripTags(r.title || r.display_name),
      summary: this.abstractFromInverted(r.abstract_inverted_index),
      authors: this._authors(r.authorships, (a) => (a && a.author && a.author.display_name) || a.author_name),
      published: this._dateOnly(r.publication_date || (r.publication_year ? r.publication_year + "-01-01" : "")),
      url: String(loc.landing_page_url || r.doi || r.id || ""),
      pdfUrl: String(oa.oa_url || loc.pdf_url || ""),
      categories: [],
      venue: String(src.display_name || ""),
      citationCount: Number(r.cited_by_count) || 0,
      type: String(r.type || ""),
      volume: String(biblio.volume || ""),
      issue: String(biblio.issue || ""),
      pages: [biblio.first_page, biblio.last_page].filter(Boolean).join("-"),
      topic: String(topic.display_name || ""),
    };
  },

  normalizeCrossref(w) {
    const r = w || {};
    const dp = (((r.published || r["published-print"] || r["published-online"] || {}).dateParts)
      || ((r.published || r["published-print"] || {})["date-parts"])
      || [[]])[0] || [];
    const day = dp.length ? dp[0] + "-" + String(dp[1] || 1).padStart(2, "0") + "-" + String(dp[2] || 1).padStart(2, "0") : "";
    return {
      source: "crossref",
      id: this._doi(r.DOI),
      doi: this._doi(r.DOI),
      title: this._stripTags((r.title || [])[0] || ""),
      summary: this._stripTags(r.abstract || ""),
      authors: this._authors(r.author, (a) => [a.given, a.family].filter(Boolean).join(" ") || a.name),
      published: day,
      url: String(r.URL || (r.DOI ? "https://doi.org/" + this._doi(r.DOI) : "")),
      pdfUrl: "",
      categories: [],
      venue: String((r["container-title"] || [])[0] || ""),
      citationCount: Number(r["is-referenced-by-count"]) || 0,
      type: String(r.type || ""),
      volume: String(r.volume || ""),
      issue: String(r.issue || ""),
      pages: String(r.page || ""),
    };
  },

  normalizePubMed(doc, uid) {
    const r = doc || {};
    const doiRec = (r.articleids || []).filter((x) => x && /^doi$/i.test(x.idtype))[0];
    const pub = String(r.pubdate || r.epubdate || "");
    const m = pub.match(/(\d{4})(?:\s+([A-Za-z]{3}))?/);
    const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const day = m ? m[1] + "-" + (m[2] ? (MON[String(m[2]).toLowerCase()] || "01") : "01") + "-01" : "";
    return {
      source: "pubmed",
      id: String(uid || r.uid || ""),
      doi: this._doi(doiRec && doiRec.value),
      title: this._stripTags(r.title || ""),
      summary: "",
      authors: this._authors(r.authors, (a) => a.name),
      published: day,
      url: uid ? "https://pubmed.ncbi.nlm.nih.gov/" + uid + "/" : "",
      pdfUrl: "",
      categories: [],
      venue: String(r.fulljournalname || r.source || ""),
      citationCount: 0,
      type: "journal-article",
      volume: String(r.volume || ""),
      issue: String(r.issue || ""),
      pages: String(r.pages || ""),
    };
  },

  /**
   * Europe PMC（含 PubMed 记录 + 预印本）。
   * 选择它的原因：NCBI E-utilities 在部分网络（实测本机）直接不可达，
   * 而 Europe PMC 同一批记录可从 EBI 获取，且返回摘要与开放获取链接。
   */
  normalizeEuropePmc(r) {
    const row = r || {};
    const ji = row.journalInfo || {};
    const journal = (ji.journal && ji.journal.title) || "";
    const urls = ((row.fullTextUrlList || {}).fullTextUrl) || [];
    const pdf = urls.filter((u) => /pdf/i.test(String((u && u.documentStyle) || "")))[0]
      || urls.filter((u) => /open access|free/i.test(String((u && u.availability) || "")))[0];
    const src = String(row.source || "");
    const doi = this._doi(row.doi);
    const title = this._stripTags(row.title || "");
    return {
      source: "europepmc",
      id: String(row.pmid || row.id || ""),
      doi: doi,
      title: title,
      summary: this._stripTags(row.abstractText || ""),
      authors: String(row.authorString || "")
        .split(/,\s*/)
        .map((x) => String(x || "").replace(/\.$/, "").trim())
        .filter(Boolean)
        .slice(0, 60),
      published: this._dateOnly(row.firstPublicationDate || (row.pubYear ? row.pubYear + "-01-01" : "")),
      url: doi ? "https://doi.org/" + doi
        : (row.pmid ? "https://europepmc.org/article/MED/" + row.pmid
          : (row.id ? "https://europepmc.org/article/" + src + "/" + row.id : "")),
      pdfUrl: String((pdf && (pdf.url || pdf.documentUrl)) || ""),
      categories: [],
      venue: String(journal),
      citationCount: Number(row.citedByCount) || 0,
      type: src === "PPR" ? "preprint" : "journal-article",
    };
  },

  /* ================== 归一标题 / 去重 ================== */

  normTitle(t) {
    return String(t == null ? "" : t).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "").slice(0, 160);
  },

  fingerprint(e) {
    const doi = this._doi(e && e.doi);
    if (doi) return "doi:" + doi.toLowerCase();
    if (e && e.arxivId) return "arXiv:" + e.arxivId;
    const t = this.normTitle(e && e.title);
    return t ? "title:" + t : "";
  },

  /** 跨源去重：同 DOI / 同 arXiv / 同标题只留一条；字段互补合并 */
  dedupe(entries) {
    const map = new Map();
    const order = [];
    for (const e of entries || []) {
      if (!e) continue;
      const fp = this.fingerprint(e);
      if (!fp) continue;
      if (!map.has(fp)) {
        map.set(fp, Object.assign({}, e));
        order.push(fp);
        continue;
      }
      const prev = map.get(fp);
      for (const k of Object.keys(e)) {
        const v = e[k];
        if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
        if (prev[k] == null || prev[k] === "" || (Array.isArray(prev[k]) && !prev[k].length)) prev[k] = v;
      }
      // 引用数取大者（OpenAlex 通常比 Crossref 新）
      if (Number(e.citationCount) > Number(prev.citationCount || 0)) prev.citationCount = Number(e.citationCount);
      if (prev.source !== e.source) prev.sources = [...new Set([].concat(prev.sources || [prev.source], e.source))];
    }
    return order.map((fp) => map.get(fp));
  },

  /* ================== 本地条件复核（纯函数） ================== */

  /**
   * 对「不保证布尔语义」的源（OpenAlex / Crossref）做二次过滤。
   * 只查标题+摘要，大小写不敏感；all = 全命中，any = 任一，phrase = 连续短语。
   */
  matches(sub, e) {
    const kws = this.keywordsOf(sub);
    if (!kws.length) return true;
    const title = String((e && e.title) || "");
    const summary = String((e && e.summary) || "");
    const blob = (title + " " + summary).toLowerCase();
    // 没有摘要时无法判断「是否真的相关」——不误杀，交给源自身的相关度排序
    if (!summary.trim()) return true;
    const mode = this.modeOf(sub);
    const hit = (k) => blob.indexOf(String(k).toLowerCase()) >= 0;
    if (mode === "phrase") return hit(kws.join(" "));
    if (mode === "any") return kws.some(hit);
    return kws.every(hit);
  },

  /* ================== 网络 ================== */

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
  },

  async _gate(id) {
    const gap = this.MIN_INTERVAL[id] || 300;
    const last = this._lastAt[id] || 0;
    const wait = last + gap - Date.now();
    if (wait > 0) await this._sleep(wait);
    this._lastAt[id] = Date.now();
  },

  /** HTTP JSON（应用层超时竞速；4xx/5xx 不抛，由调用方判 status） */
  async _json(url, timeoutMs) {
    const ms = timeoutMs || 25000;
    const req = await Promise.race([
      Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: ms,
        headers: { Accept: "application/json", "User-Agent": "Papilot/1.0 (+https://github.com/yebuqiu/zotero-papilot)" },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("请求超时（" + Math.round(ms / 1000) + "s）")), ms + 1000)),
    ]);
    const status = Number(req && req.status) || 0;
    return { status, data: (req && req.response) || null };
  },

  _mailto() {
    try {
      const v = String(Prefs.get("subsMailto", "") || "").trim();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
    } catch (e) { return ""; }
  },

  async _arxiv(sub, limit, now) {
    if (typeof ArxivFetch === "undefined" || !ArxivFetch || typeof ArxivFetch.search !== "function") {
      throw new Error("arXiv 模块未就绪");
    }
    const res = await ArxivFetch.search(this.arxivSpec(sub, now), {
      limit: Math.max(1, Math.min(100, limit)),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });
    if (res && res.ok === false) throw new Error(res.reason || "arXiv 检索失败");
    return (res.entries || []).map((e) => ({
      source: "arxiv",
      id: e.arxivId || "",
      arxivId: e.arxivId || "",
      doi: this._doi(e.doi),
      title: String(e.title || "").trim(),
      summary: String(e.summary || "").trim(),
      authors: (e.authors || []).slice(0, 60),
      published: this._dateOnly(e.publishedDay || e.published),
      url: String(e.absUrl || e.idUrl || ""),
      pdfUrl: String(e.pdfUrl || ""),
      categories: e.categories || [],
      venue: String(e.journalRef || ""),
      citationCount: 0,
      type: "preprint",
    }));
  },

  async _openalex(sub, limit, now) {
    const q = this.openAlexQuery(sub);
    if (!q) throw new Error("OpenAlex 需要关键词（分类仅 arXiv 支持）");
    const filters = [];
    const from = this.dateFrom(sub, now);
    if (from) filters.push("from_publication_date:" + from);
    filters.push("type:article|preprint|review");
    const params = [
      "search=" + encodeURIComponent(q),
      "filter=" + encodeURIComponent(filters.join(",")),
      "sort=publication_date:desc",
      "per-page=" + Math.max(1, Math.min(50, limit)),
    ];
    const mail = this._mailto();
    if (mail) params.push("mailto=" + encodeURIComponent(mail));
    const url = "https://api.openalex.org/works?" + params.join("&");
    await this._gate("openalex");
    const r = await this._json(url);
    if (r.status !== 200 || !r.data) throw new Error("OpenAlex HTTP " + (r.status || "无响应"));
    const rows = (r.data.results || []).map((w) => this.normalizeOpenAlex(w));
    return rows.filter((e) => this.matches(sub, e));
  },

  async _crossref(sub, limit, now) {
    const q = this.crossrefQuery(sub);
    if (!q) throw new Error("Crossref 需要关键词（分类仅 arXiv 支持）");
    const filters = [];
    const from = this.dateFrom(sub, now);
    if (from) filters.push("from-pub-date:" + from);
    const params = [
      "query.bibliographic=" + encodeURIComponent(q),
      "rows=" + Math.max(1, Math.min(50, limit)),
      "sort=published",
      "order=desc",
      "select=" + encodeURIComponent("DOI,title,author,abstract,published,container-title,URL,type,is-referenced-by-count,volume,issue,page"),
    ];
    if (filters.length) params.push("filter=" + encodeURIComponent(filters.join(",")));
    const mail = this._mailto();
    if (mail) params.push("mailto=" + encodeURIComponent(mail));
    const url = "https://api.crossref.org/works?" + params.join("&");
    await this._gate("crossref");
    const r = await this._json(url);
    if (r.status !== 200 || !r.data) throw new Error("Crossref HTTP " + (r.status || "无响应"));
    const rows = (((r.data.message || {}).items) || []).map((w) => this.normalizeCrossref(w));
    return rows.filter((e) => this.matches(sub, e));
  },

  async _europepmc(sub, limit, now) {
    const q = this.europePmcQuery(sub);
    if (!q) throw new Error("Europe PMC 需要关键词（分类仅 arXiv 支持）");
    const params = [
      "query=" + encodeURIComponent(q),
      "format=json",
      "resultType=core",
      "pageSize=" + Math.max(1, Math.min(50, limit)),
      "sort=" + encodeURIComponent("P_PDATE_D desc"),
    ];
    const mail = this._mailto();
    if (mail) params.push("email=" + encodeURIComponent(mail));
    const url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + params.join("&");
    await this._gate("europepmc");
    const r = await this._json(url);
    if (r.status !== 200 || !r.data) throw new Error("Europe PMC HTTP " + (r.status || "无响应"));
    const rows = ((((r.data.resultList || {}).result) || [])).map((x) => this.normalizeEuropePmc(x));
    return rows.filter((e) => e.title);
  },

  async _pubmed(sub, limit) {
    const term = this.pubmedTerm(sub);
    if (!term) throw new Error("PubMed 需要关键词（分类对其不适用）");
    const n = Math.max(1, Math.min(50, limit));
    const esearch = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json"
      + "&sort=pub+date&retmax=" + n + "&term=" + encodeURIComponent(term)
      + (this._mailto() ? "&email=" + encodeURIComponent(this._mailto()) : "");
    await this._gate("pubmed");
    const s = await this._json(esearch);
    if (s.status !== 200 || !s.data) throw new Error("PubMed esearch HTTP " + (s.status || "无响应"));
    const ids = (((s.data.esearchresult || {}).idlist) || []).slice(0, n);
    if (!ids.length) return [];
    const esummary = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json"
      + "&id=" + ids.join(",")
      + (this._mailto() ? "&email=" + encodeURIComponent(this._mailto()) : "");
    await this._gate("pubmed");
    const d = await this._json(esummary);
    if (d.status !== 200 || !d.data) throw new Error("PubMed esummary HTTP " + (d.status || "无响应"));
    const result = (d.data.result || {});
    const order = result.uids || ids;
    const out = [];
    for (const uid of order) {
      const doc = result[uid];
      if (doc && doc.title) out.push(this.normalizePubMed(doc, uid));
    }
    return out;
  },

  /**
   * 执行一次多源检索。
   * @param {object} sub 订阅（含 sources / keywords / categories / mode / exclude / maxAgeDays）
   * @param {{limit?:number, now?:Date|number, only?:string[]}} [opts]
   * @returns {Promise<{ok:boolean, entries:Array, bySource:object, reason?:string, partial:boolean}>}
   */
  async search(sub, opts) {
    const o = opts || {};
    const sources = (Array.isArray(o.only) && o.only.length ? o.only : this.normalizeSources(sub && sub.sources))
      .filter((id) => this.exists(id));
    const limit = Math.max(1, Math.min(50, Number(o.limit) || 20));
    const bySource = {};
    const all = [];
    let anyOk = false;
    let firstReason = "";

    for (const id of sources) {
      try {
        let rows;
        if (id === "arxiv") rows = await this._arxiv(sub, limit, o.now);
        else if (id === "openalex") rows = await this._openalex(sub, limit, o.now);
        else if (id === "crossref") rows = await this._crossref(sub, limit, o.now);
        else if (id === "europepmc") rows = await this._europepmc(sub, limit, o.now);
        else if (id === "pubmed") rows = await this._pubmed(sub, limit);
        else throw new Error("未知数据源");
        bySource[id] = { ok: true, count: rows.length };
        all.push.apply(all, rows);
        anyOk = true;
      } catch (e) {
        const msg = String((e && (e.message || e)) || "失败");
        bySource[id] = { ok: false, count: 0, reason: msg };
        if (!firstReason) firstReason = this.label(id) + "：" + msg;
      }
    }

    const entries = this.dedupe(all);
    if (!anyOk) return { ok: false, entries: [], bySource, reason: firstReason || "所有数据源均失败", partial: false };
    return { ok: true, entries, bySource, partial: Object.keys(bySource).some((k) => !bySource[k].ok) };
  },

  /** 分类拼写核对（arXiv 专有；给 UI 提示用，不中止） */
  categoryNote(cats) {
    if (!cats || !cats.length) return "";
    try {
      if (typeof ArxivCategories === "undefined" || !ArxivCategories || !ArxivCategories.checkAll) return "";
      const r = ArxivCategories.checkAll(cats);
      const bad = (r.unknown || []).concat(r.malformed || []);
      if (!bad.length) return "";
      const hints = (r.suggestions || []).slice(0, 3)
        .map((s) => s.input + "→" + (s.suggestions || []).slice(0, 2).map((x) => x.code).join("/"));
      return "分类可能写错（arXiv 区分大小写）：" + bad.join(", ") + (hints.length ? "；可能是：" + hints.join("、") : "");
    } catch (e) {
      return "";
    }
  },
};

// 便于 Node 侧直接 require（本文件在插件作用域里是全局对象，测试用 vm 加载）
try {
  if (typeof module !== "undefined" && module.exports) module.exports = SubSources;
} catch (e) { /* ignore */ }
