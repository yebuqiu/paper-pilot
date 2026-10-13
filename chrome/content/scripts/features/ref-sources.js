/* PaperPilot 参考文献多源元数据层（0.33.0 新增）
 *
 * 目标：让「一键入库」不再把命运押在单一数据源上。
 * 原有实现只走 Semantic Scholar，且**只认 DOI**——实测大多数中文文献与相当一部分
 * 国际旧文献在 S2 的 references 里没有 externalIds.DOI，直接被过滤掉，
 * 用户看到的就是「参考文献均已在本地文库（或缺 DOI 无法可靠入库）」。
 *
 * 本模块把五个**免密钥**公开源统一到 RefFormat 的规范记录上：
 *   - Crossref      期刊/会议/图书，卷期页与 ISSN 最全（DOI 世界的权威）
 *   - OpenAlex      覆盖最广，能从「标题/网址/PMID」反查 DOI，带开放获取链接
 *   - PubMed        E-utilities，生物医学方向（MeSH、PMCID、期刊缩写）
 *   - arXiv         Atom API，预印本（复用仓库已有 ArxivFetch/ArxivAtom，不重造）
 *   - Semantic Scholar  引用量、开放获取 PDF（复用已有 S2Client）
 * 外加一条 **DOI 内容协商**：直接取出版社发布的 BibTeX（最「规范」的一份元数据）。
 *
 * 两条核心能力：
 *   1) resolve(identifier)  单个标识符/标题 → 一条尽量完整的规范记录（多源合并补缺）
 *   2) search(query)        自由文本 → 五源**联合检索** → 合并去重 → 按「多源一致性命中」排序
 *                           （同一篇被越多源命中、标题越贴近查询，排得越前——这就是准确率的来源）
 *
 * 纪律：
 *   - 所有 fetch 都带**按主机的限速**与**内存缓存**（Crossref/OpenAlex 有礼貌池，
 *     PubMed 无 key 限 3 次/秒，S2 无 key 约 1 次/秒，arXiv 硬性 3 秒/请求）；
 *   - 每个源的失败**只影响该源**（Promise.allSettled），错误逐源上报给 UI；
 *   - 解析函数（fromCrossref/fromOpenAlex/…）是**纯函数**，测试用夹具直接喂 JSON。
 */
/* global Zotero, Prefs, RefFormat, ArxivFetch, S2Client, CitationColumn */

var RefSources = {
  CROSSREF: "https://api.crossref.org",
  OPENALEX: "https://api.openalex.org",
  EUTILS: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
  EUROPEPMC: "https://www.ebi.ac.uk/europepmc/webservices/rest",
  DOI_RESOLVER: "https://doi.org",

  /** 可勾选的源（顺序即 UI 呈现顺序）。
   *  `refsOnly` 的源不参与「联合检索」——PDF 没有检索接口，只用来解析参考文献段。 */
  SOURCES: [
    { id: "crossref", label: "Crossref", hint: "期刊卷期页最全" },
    { id: "openalex", label: "OpenAlex", hint: "覆盖最广、可从标题反查 DOI" },
    { id: "pubmed", label: "PubMed", hint: "生物医学" },
    { id: "europepmc", label: "Europe PMC", hint: "PubMed 全量 + 参考文献列表" },
    { id: "arxiv", label: "arXiv", hint: "预印本" },
    { id: "s2", label: "Semantic Scholar", hint: "引用量与开放获取 PDF" },
    { id: "pdf", label: "PDF 参考文献段", hint: "从本机 PDF 正文解析（中文文献的唯一兜底）", refsOnly: true },
  ],

  /** 可跑「联合检索」的源（排除只做参考文献段的 PDF） */
  SEARCHABLE: ["crossref", "openalex", "pubmed", "europepmc", "arxiv", "s2"],

  /* ================= 网络：限速 + 缓存 ================= */

  // 各主机最小间隔（ms）。数值取「官方推荐值的 2 倍以上」，宁可慢一点也不被封。
  _MIN_INTERVAL: {
    "api.crossref.org": 600,
    "api.openalex.org": 220,
    "eutils.ncbi.nlm.nih.gov": 400,
    "www.ebi.ac.uk": 300,
    "export.arxiv.org": 3000,
    "api.semanticscholar.org": 1100,
    "doi.org": 700,
  },

  _cache: new Map(),      // url(+accept) -> { t, data, text }
  _lastReq: new Map(),    // host -> 上次请求时间戳
  _queueTail: Promise.resolve(),

  _mailto() {
    const v = String(Prefs.get("refImportMailto", "") || "").trim();
    return v || "paperpilot@dev.local";
  },

  _ua() {
    return "PaperPilot/0.33 (Zotero reference importer; mailto:" + this._mailto() + ")";
  },

  _hostOf(url) {
    const m = String(url || "").match(/^https?:\/\/([^/]+)/i);
    return m ? m[1].toLowerCase() : "";
  },

  /** 串行化 + 按主机限速地发一个 GET；返回 {status, json, text}（非 2xx 不抛，交调用方判断） */
  async _get(url, opts) {
    const o = opts || {};
    const cacheKey = url + "|" + (o.accept || "");
    const hit = this._cache.get(cacheKey);
    const ttl = o.ttl == null ? 10 * 60 * 1000 : o.ttl;
    if (hit && Date.now() - hit.t < ttl) return hit.data;

    // 串到全局队列尾：避免多源并发时同主机请求撞在一起
    const run = async () => {
      const host = this._hostOf(url);
      const gap = this._MIN_INTERVAL[host] || 300;
      const last = this._lastReq.get(host) || 0;
      const wait = last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastReq.set(host, Date.now());
      const headers = Object.assign({
        "User-Agent": this._ua(),
        "Accept": o.accept || "application/json",
      }, o.headers || {});
      const asText = !!(o.accept && o.accept.indexOf("json") < 0);
      const res = { status: 0, json: null, text: "", error: "" };
      try {
        // 不用 successCodes：非 2xx 让它按既有范式 reject，再从容器的 xmlhttp 里取状态码。
        // （把 successCodes 设成 false 在不同 Zotero 版本上语义不一致，会静默吞掉错误。）
        const req = await Zotero.HTTP.request("GET", url, {
          headers,
          responseType: asText ? "text" : "json",
          timeout: o.timeout || 20000,
        });
        res.status = req.status || 200;
        if (asText) res.text = String(req.responseText || req.response || "");
        else res.json = req.response;
      } catch (e) {
        const xhr = e && e.xmlhttp;
        res.status = (xhr && xhr.status) || 0;
        res.error = (e && (e.message || String(e))) || "network error";
        try {
          if (xhr && xhr.responseText) {
            res.text = xhr.responseText;
            if (!asText) { try { res.json = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ } }
          }
        } catch (_) { /* ignore */ }
      }
      const out = { t: Date.now(), data: res };
      // 只缓存成功结果（失败要允许重试，否则一次网络抖动会被记 10 分钟）
      if (!res.error) this._cache.set(cacheKey, out);
      return res;
    };
    const p = this._queueTail.then(run, run);
    // 队列尾只关心「上一个请求结束」；不吞异常（run 内部已不抛）
    this._queueTail = p.then(() => undefined, () => undefined);
    return p;
  },

  async _getJSON(url, opts) {
    const r = await this._get(url, Object.assign({ accept: "application/json" }, opts || {}));
    if (r.error || !r.json) return null;
    return r.json;
  },

  clearCache() {
    this._cache.clear();
    this._lastReq.clear();
  },

  /* ================= 纯解析：各源原始结构 → 规范记录 ================= */

  /** Crossref 的摘要带 JATS 标签，剥掉才是能读的文本 */
  stripJats(s) {
    let t = String(s == null ? "" : s);
    t = t.replace(/^\s*<jats:p[^>]*>/i, "").replace(/<\/jats:p>\s*$/i, "");
    t = t.replace(/<\/?jats:[a-z]+[^>]*>/gi, " ");
    t = t.replace(/<[^>]+>/g, " ");
    return t.replace(/\s+/g, " ").trim();
  },

  /** OpenAlex 的摘要以「倒排索引」形式给出 → 还原成正常文本 */
  abstractFromInvertedIndex(idx) {
    if (!idx || typeof idx !== "object") return "";
    const pairs = [];
    for (const word of Object.keys(idx)) {
      for (const pos of idx[word] || []) pairs.push([Number(pos), word]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    return pairs.map((p) => p[1]).join(" ").replace(/\s+/g, " ").trim();
  },

  /** 从 {given,family} / "Family, Given" / 单串 里造作者对象 */
  _author(a) {
    if (!a) return null;
    if (typeof a === "string") return RefFormat.parseAuthor(a);
    if (a.literal) return { family: "", given: "", literal: String(a.literal) };
    const family = a.family || a.name || "";
    const given = a.given || "";
    if (!family) return null;
    return { family: String(family), given: String(given), literal: "" };
  },

  _authors(list) {
    const out = [];
    for (const a of list || []) {
      const r = this._author(a);
      if (r && (r.family || r.literal)) out.push(r);
    }
    return out;
  },

  /** Crossref message → rec */
  fromCrossref(msg) {
    if (!msg) return null;
    const rec = RefFormat.empty();
    rec.source = ["crossref"];
    const t = msg.title;
    rec.title = Array.isArray(t) ? (t[0] || "") : (t || "");
    const ct = msg["container-title"];
    const ctFirst = Array.isArray(ct) ? (ct[0] || "") : (ct || "");
    const ctShort = (msg["short-container-title"] || [])[0] || "";
    rec.container = ctFirst || ctShort || "";
    rec.authors = this._authors((msg.author || []).map((a) => ({ given: a.given, family: a.family, name: a.name, literal: a.name && !a.family ? a.name : "" })));
    const dp = msg.issued && msg.issued["date-parts"] && msg.issued["date-parts"][0];
    if (dp && dp.length) {
      rec.year = Number(dp[0]) || null;
      rec.date = [dp[0], dp[1] ? String(dp[1]).padStart(2, "0") : "", dp[2] ? String(dp[2]).padStart(2, "0") : ""]
        .filter(Boolean).join("-");
    }
    if (!rec.date && msg["published-print"] && msg["published-print"]["date-parts"]) {
      const p = msg["published-print"]["date-parts"][0];
      if (p && p.length) { rec.year = Number(p[0]) || null; rec.date = String(p[0]); }
    }
    rec.volume = msg.volume || "";
    rec.issue = msg.issue || "";
    rec.pages = msg.page || "";
    rec.publisher = msg.publisher || "";
    rec.place = msg["publisher-location"] || "";
    rec.issn = (msg.ISSN || [])[0] || "";
    rec.isbn = (msg.ISBN || [])[0] || "";
    rec.doi = RefFormat.normDOI(msg.DOI || "");
    rec.url = msg.URL || (rec.doi ? "https://doi.org/" + rec.doi : "");
    rec.abstract = this.stripJats(msg.abstract);
    rec.language = msg.language || "";
    rec.itemType = RefFormat.itemTypeFromSource("crossref", msg.type);
    rec.citationCount = typeof msg["is-referenced-by-count"] === "number" ? msg["is-referenced-by-count"] : null;
    rec.reasons.push("Crossref");
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /** OpenAlex work → rec */
  fromOpenAlex(w) {
    if (!w) return null;
    const rec = RefFormat.empty();
    rec.source = ["openalex"];
    rec.title = w.title || w.display_name || "";
    rec.authors = this._authors((w.authorships || []).map((a) => (a.author ? { given: a.author.given_name, family: a.author.family_name, name: a.author.display_name } : null)));
    rec.year = w.publication_year || null;
    rec.date = w.publication_date || (rec.year ? String(rec.year) : "");
    rec.container = (w.primary_location && w.primary_location.source && w.primary_location.source.display_name)
      || (w.host_venue && w.host_venue.display_name) || "";
    const b = w.biblio || {};
    rec.volume = b.volume || "";
    rec.issue = b.issue || "";
    if (b.first_page) rec.pages = b.first_page + (b.last_page && b.last_page !== b.first_page ? "-" + b.last_page : "");
    rec.publisher = (w.primary_location && w.primary_location.source && w.primary_location.source.host_organization_name) || "";
    rec.issn = (w.primary_location && w.primary_location.source && (w.primary_location.source.issn || [])[0]) || "";
    rec.doi = RefFormat.normDOI((w.doi || "").replace(/^https?:\/\/doi\.org\//, ""));
    // OpenAlex 的 ids 是**完整 URL**（…/12345678/ 与 …/PMC7477828/），
    // 注意尾部斜杠：`split("/").pop()` 会拿到空串——这是踩过的坑。
    rec.pmid = RefFormat.normPmid((w.ids && w.ids.pmid) || "");
    const pmcM = String((w.ids && w.ids.pmcid) || "").match(/PMC\d{6,8}/i);
    rec.pmcid = pmcM ? pmcM[0].toUpperCase() : "";
    rec.url = (w.primary_location && w.primary_location.landing_page_url) || (rec.doi ? "https://doi.org/" + rec.doi : "") || w.id || "";
    rec.abstract = this.abstractFromInvertedIndex(w.abstract_inverted_index);
    rec.language = w.language || "";
    rec.itemType = RefFormat.itemTypeFromSource("openalex", w.type);
    rec.citationCount = typeof w.cited_by_count === "number" ? w.cited_by_count : null;
    // 开放获取直链（oa-fetch 与附件下载可复用）
    const oa = w.open_access && w.open_access.oa_url;
    if (oa) rec.oaUrl = oa;
    rec.reasons.push("OpenAlex");
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /** PubMed esummary 的 doc → rec */
  fromPubMedSummary(uid, doc) {
    if (!doc) return null;
    const rec = RefFormat.empty();
    rec.source = ["pubmed"];
    rec.pmid = String(doc.uid || uid || "");
    rec.title = String(doc.title || "").replace(/<[^>]+>/g, "").replace(/\.$/, "");
    rec.authors = this._authors((doc.authors || []).map((a) => (a && a.name) ? a.name : null));
    const pubdate = doc.pubdate || doc.epubdate || "";
    rec.year = RefFormat.yearOf(pubdate);
    rec.date = pubdate ? String(pubdate).replace(/\s+/g, " ") : "";
    rec.container = doc.fulljournalname || doc.source || "";
    rec.volume = doc.volume || "";
    rec.issue = doc.issue || "";
    rec.pages = doc.pages || "";
    rec.issn = doc.issn || "";
    rec.language = (doc.lang || [])[0] || "";
    rec.itemType = RefFormat.itemTypeFromSource("pubmed", (doc.pubtype || []).join(" "));
    for (const id of doc.articleids || []) {
      if (id.idtype === "doi") rec.doi = RefFormat.normDOI(id.value);
      if (id.idtype === "pmc") rec.pmcid = String(id.value || "").toUpperCase();
      // articleids 里没有 doi 时，elocationid 偶尔就是 DOI（只在形如 10.x/y 时才采纳，
      // 否则会把 "pii: S0140-6736(20)30154-9" 这种当 DOI 写进条目）
      if (!rec.doi && id.idtype === "elocationid" && /^10\.\d{4,9}\//.test(String(id.value || ""))) {
        rec.doi = RefFormat.normDOI(id.value);
      }
    }
    rec.url = rec.pmid ? "https://pubmed.ncbi.nlm.nih.gov/" + rec.pmid + "/" : "";
    rec.reasons.push("PubMed");
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /** arXiv 条目（ArxivAtom.parseEntry 输出）→ rec */
  fromArxivEntry(e) {
    if (!e) return null;
    const rec = RefFormat.empty();
    rec.source = ["arxiv"];
    rec.title = e.title || "";
    rec.authors = this._authors((e.authorsDetailed || e.authors || []).map((a) => (typeof a === "string" ? a : a.name)));
    rec.year = RefFormat.yearOf(e.published);
    rec.date = e.publishedDay || (e.published ? String(e.published).slice(0, 10) : "");
    rec.container = e.journalRef || "";
    rec.arxivId = RefFormat.normArxiv(e.arxivId || e.baseId || "");
    rec.doi = RefFormat.normDOI(e.doi || "");
    rec.url = e.absUrl || (rec.arxivId ? "https://arxiv.org/abs/" + rec.arxivId : "");
    rec.abstract = e.summary || "";
    rec.itemType = "preprint";
    // arXiv 已注明期刊发表信息时，升级为期刊论文更有用
    if (e.journalRef && /[A-Za-z]{3,}/.test(e.journalRef)) rec.itemType = "journalArticle";
    rec.reasons.push("arXiv");
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /** Semantic Scholar paper → rec */
  fromS2(p) {
    if (!p) return null;
    const rec = RefFormat.empty();
    rec.source = ["s2"];
    rec.title = p.title || "";
    rec.authors = this._authors((p.authors || []).map((a) => (a && a.name) ? a.name : null));
    const j = p.journal || {};
    rec.container = j.name || p.venue || "";
    rec.volume = j.volume || "";
    rec.pages = j.pages || "";
    rec.year = p.year || null;
    rec.date = p.year ? String(p.year) : "";
    const ext = p.externalIds || {};
    rec.doi = RefFormat.normDOI(ext.DOI || "");
    rec.pmid = RefFormat.normPmid(ext.PubMed || "");
    rec.arxivId = RefFormat.normArxiv(ext.ArXiv || "");
    rec.url = p.url || (rec.doi ? "https://doi.org/" + rec.doi : "");
    rec.abstract = p.abstract || "";
    rec.citationCount = typeof p.citationCount === "number" ? p.citationCount : null;
    rec.itemType = RefFormat.itemTypeFromSource("s2", (p.publicationTypes || []).join(" ") || p.venue);
    if (p.openAccessPdf && p.openAccessPdf.url) rec.oaUrl = p.openAccessPdf.url;
    rec.reasons.push("Semantic Scholar");
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /** Crossref 的 `message.reference[]` 单条 → rec。
   *  这是**出版社自己 deposit 的参考文献题录**：卷/期/首页/刊名/年都在里面，
   *  比任何二次抓取都准；缺的通常只有标题（要靠 unstructured 抠）。 */
  fromCrossrefReference(r) {
    if (!r) return null;
    const rec = RefFormat.empty();
    rec.source = ["crossref-ref"];
    rec.reasons = ["Crossref 参考文献"];
    rec.confidence = "medium";
    rec.doi = RefFormat.normDOI(r.DOI || "");
    rec.title = String(r["article-title"] || r["volume-title"] || r["unstructured-title"] || "").trim();
    const unstructured = String(r.unstructured || "");
    if (!rec.title && unstructured) {
      rec.title = RefFormat.titleFromUnstructured(unstructured);
      if (!rec.title) rec.confidence = "low";
    }
    if (!rec.title && !rec.doi && !unstructured) return null;
    if (!rec.title) rec.title = unstructured.slice(0, 200);
    rec.authors = RefFormat.authorsFromReferenceString(unstructured, 12);
    rec.container = String(r["journal-title"] || "").trim();
    rec.volume = String(r.volume || "").trim();
    rec.pages = String(r["first-page"] || "").trim();
    rec.year = RefFormat.yearFromReference(r.year || unstructured);
    if (rec.year) rec.date = String(rec.year);
    rec.raw = unstructured;
    rec.itemType = RefFormat.itemTypeFromSource("crossref", r["article-title"] ? "journal-article" : "journal-article");
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /** Europe PMC 检索结果（resultType=core/lite）→ rec */
  fromEuropepmcResult(r) {
    if (!r) return null;
    const rec = RefFormat.empty();
    rec.source = ["europepmc"];
    rec.title = String(r.title || "").replace(/<[^>]+>/g, "").replace(/\.$/, "");
    rec.authors = RefFormat.parseAuthorStringList(r.authorString || "", 60);
    rec.pmid = RefFormat.normPmid(r.pmid || (/^\d+$/.test(String(r.id || "")) && r.source === "MED" ? r.id : ""));
    rec.pmcid = String(r.pmcid || "").toUpperCase();
    rec.doi = RefFormat.normDOI(r.doi || "");
    rec.container = String(r.journalTitle || (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || "").trim();
    const ji = r.journalInfo || {};
    rec.volume = String(ji.volume || "").trim();
    rec.issue = String(ji.issue || "").trim();
    rec.pages = String(r.pageInfo || "").trim();
    rec.year = RefFormat.yearOf(r.pubYear || (ji.yearOfPublication ? String(ji.yearOfPublication) : ""));
    if (rec.year) rec.date = String(rec.year);
    rec.abstract = String(r.abstractText || "").replace(/<[^>]+>/g, "");
    rec.itemType = RefFormat.itemTypeFromSource("pubmed", (r.pubTypeList && r.pubTypeList.pubType || []).join(" ") || r.pubType || "");
    rec.url = rec.pmid ? "https://pubmed.ncbi.nlm.nih.gov/" + rec.pmid + "/" : (rec.doi ? "https://doi.org/" + rec.doi : "");
    rec.reasons.push("Europe PMC");
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /** Europe PMC 的 `referenceList.reference[]` 单条 → rec（有标题！生物医学方向最全） */
  fromEuropepmcReference(r) {
    if (!r) return null;
    const rec = RefFormat.empty();
    rec.source = ["europepmc-ref"];
    rec.reasons = ["Europe PMC 参考文献"];
    rec.confidence = "medium";
    rec.title = String(r.title || "").replace(/<[^>]+>/g, "").replace(/\.$/, "");
    rec.authors = RefFormat.parseAuthorStringList(r.authorString || "", 60);
    rec.doi = RefFormat.normDOI(r.doi || "");
    if (r.source === "MED" && /^\d{6,9}$/.test(String(r.id || ""))) rec.pmid = String(r.id);
    rec.pmcid = String(r.pmcid || "").toUpperCase();
    rec.container = String(r.journalAbbreviation || r.journalTitle || "").trim();
    rec.volume = String(r.volume || "").trim();
    rec.issue = String(r.issue || "").trim();
    rec.pages = String(r.pageInfo || "").trim();
    rec.year = RefFormat.yearOf(r.pubYear);
    if (rec.year) rec.date = String(rec.year);
    const ct = String(r.citationType || "").toUpperCase();
    rec.itemType = /BOOK/.test(ct) && /CHAPTER/.test(ct) ? "bookSection" : (/BOOK/.test(ct) ? "book" : "journalArticle");
    if (!rec.title && !rec.doi && !rec.pmid) return null;
    if (!rec.title) rec.title = String(r.id || "").slice(0, 120);
    return RefFormat.isBlank(rec) ? null : rec;
  },

  /* ================= 参考文献列表（四通道 + PDF） ================= */

  /** Crossref message.reference[] → recs（同时缓存整条 message，避免重复请求） */
  async crossrefWork(doi) {
    const d = RefFormat.normDOI(doi);
    if (!d) return null;
    const j = await this._getJSON(this.CROSSREF + "/works/" + encodeURIComponent(d) + "?mailto=" + encodeURIComponent(this._mailto()));
    return (j && j.message) || null;
  },

  /** 出版社 deposit 的参考文献题录（卷期页最全） */
  async crossrefReferenceList(doi) {
    const m = await this.crossrefWork(doi);
    if (!m) return [];
    return (m.reference || [])
      .filter((r) => r && (r.DOI || r["article-title"] || r.unstructured || r["volume-title"]))
      .map((r) => this.fromCrossrefReference(r))
      .filter(Boolean);
  },

  /** OpenAlex：referenced_works（ID 列表）→ 按 openalex_id 批量取回题录。
   *  两次请求就能拿到整份参考文献表，是覆盖率最高、成本最低的一条通道。 */
  async openalexReferenceList(ids) {
    const o = ids || {};
    const doi = RefFormat.normDOI(o.doi || "");
    const workUrl = doi
      ? this.OPENALEX + "/works/doi:" + encodeURIComponent(doi) + "?select=id,referenced_works&mailto=" + encodeURIComponent(this._mailto())
      : (o.openalexId ? this.OPENALEX + "/works/" + o.openalexId + "?select=id,referenced_works&mailto=" + encodeURIComponent(this._mailto()) : "");
    if (!workUrl) return [];
    const work = await this._getJSON(workUrl);
    const refs = (work && work.referenced_works) || [];
    if (!refs.length) return [];
    // "https://openalex.org/W123" → "W123"
    const shortIds = refs.map((u) => String(u).split("/").pop()).filter(Boolean).slice(0, 300);
    const out = [];
    for (let i = 0; i < shortIds.length; i += 50) {
      const chunk = shortIds.slice(i, i + 50);
      const url = this.OPENALEX + "/works?filter=openalex_id:" + encodeURIComponent(chunk.join("|"))
        + "&per-page=50&select=doi,title,publication_year,type,biblio,authorships,primary_location,ids"
        + "&mailto=" + encodeURIComponent(this._mailto());
      const j = await this._getJSON(url);
      for (const w of ((j && j.results) || [])) {
        const rec = this.fromOpenAlex(w);
        if (rec) { rec.source = ["openalex-ref"]; rec.reasons = ["OpenAlex 参考文献"]; rec.confidence = "high"; out.push(rec); }
      }
    }
    return out;
  },

  /** Europe PMC 参考文献（生物医学方向最全，且**带标题**）。
   *  先按 DOI/PMID/PMCID 找到 MED/PMC 标识，再取 references 端点。 */
  async europepmcReferenceList(ids) {
    const o = ids || {};
    let source = "", id = "";
    const pmid = RefFormat.normPmid(o.pmid || "");
    const pmcid = String(o.pmcid || "").toUpperCase();
    if (pmid) { source = "MED"; id = pmid; }
    else if (pmcid) { source = "PMC"; id = pmcid; }
    else if (o.doi) {
      const j = await this._getJSON(this.EUROPEPMC + "/search?query=" + encodeURIComponent('DOI:"' + RefFormat.normDOI(o.doi) + '"')
        + "&format=json&resultType=lite&pageSize=1");
      const r = (((j || {}).resultList || {}).result || [])[0];
      if (r) { source = r.pmcid ? "PMC" : "MED"; id = r.pmcid || r.pmid || (/^\d+$/.test(String(r.id || "")) ? r.id : ""); }
    }
    if (!source || !id) return [];
    const url = this.EUROPEPMC + "/" + source + "/" + encodeURIComponent(id)
      + "/references?format=json&pageSize=100&page=1";
    const j = await this._getJSON(url);
    const list = (((j || {}).referenceList || {}).reference) || [];
    return list.map((r) => this.fromEuropepmcReference(r)).filter(Boolean);
  },

  /** Semantic Scholar 参考文献（按 DOI/arXiv/标题先定位 paperId） */
  async s2ReferenceList(ids, limit) {
    if (typeof S2Client === "undefined" || !S2Client) return [];
    const o = ids || {};
    const F = "title,year,venue,externalIds,citationCount";
    let paper = null;
    const doi = RefFormat.normDOI(o.doi || "");
    const want = RefFormat.normTitle(o.title || "");
    if (doi) {
      try { paper = await S2Client.paperById("DOI:" + doi, F); } catch (e) { paper = null; }
      if (paper && want && RefFormat.normTitle(paper.title) !== want) paper = null; // DOI 错配 → 回退
    }
    if (!paper && o.arxivId) {
      try { paper = await S2Client.paperById("ARXIV:" + RefFormat.normArxiv(o.arxivId), F); } catch (e) { paper = null; }
    }
    if (!paper && o.pmid) {
      try { paper = await S2Client.paperById("PMID:" + RefFormat.normPmid(o.pmid), F); } catch (e) { paper = null; }
    }
    if (!paper && o.title) {
      try {
        const cands = await S2Client.searchByTitle(o.title, 5, F);
        paper = (cands || []).find((p) => RefFormat.normTitle(p.title) === want) || null;
      } catch (e) { paper = null; }
    }
    if (!paper || !paper.paperId) return [];
    const raw = await S2Client.references(paper.paperId,
      "title,year,venue,abstract,externalIds,authors,citationCount,publicationTypes,journal", limit || 500);
    return (raw || []).map((r) => {
      const p = r && r.citedPaper;
      if (!p) return null;
      const rec = this.fromS2(p);
      if (rec) { rec.source = ["s2-ref"]; rec.reasons = ["Semantic Scholar 参考文献"]; }
      return rec;
    }).filter(Boolean);
  },

  /** DOI 批量补全：走 S2 的 /paper/batch（一次最多 500 条）。
   *  参考文献表里大量条目只有 DOI（Crossref 只给 DOI + 卷页），标题/作者/年份都得靠它补齐。 */
  async s2BatchByDois(dois) {
    if (typeof S2Client === "undefined" || !S2Client) return [];
    const list = [...new Set((dois || []).map((d) => RefFormat.normDOI(d)).filter(Boolean))];
    const out = [];
    const F = "title,year,venue,abstract,externalIds,authors,citationCount,publicationTypes,journal,url,openAccessPdf";
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      let papers = [];
      try { papers = await S2Client.batch(chunk.map((d) => "DOI:" + d), F); } catch (e) { papers = []; }
      for (let k = 0; k < chunk.length; k++) {
        const p = papers && papers[k];
        if (!p) continue;
        const rec = this.fromS2(p);
        if (!rec) continue;
        if (!rec.doi) rec.doi = chunk[k];
        out.push(rec);
      }
      if (i + 100 < list.length) await new Promise((r) => setTimeout(r, 1200)); // S2 无 key 限速
    }
    return out;
  },

  /** Europe PMC 检索（并入联合检索：PubMed 全量镜像，命中率比 eutils 更宽） */
  async europepmcSearch(query, limit) {
    const url = this.EUROPEPMC + "/search?query=" + encodeURIComponent(query)
      + "&format=json&resultType=core&pageSize=" + Math.max(1, Math.min(25, limit || 10));
    const j = await this._getJSON(url);
    return ((((j || {}).resultList || {}).result || [])).map((r) => this.fromEuropepmcResult(r)).filter(Boolean);
  },

  /**
   * 条目没有 DOI/PMID 时，用**标题**先在各库里把它认出来，回填标识符。
   * 为什么必须有这一步：中文指南/期刊论文常常没记 DOI，而参考文献列表接口全都
   * 以 DOI/PMID 为入口 —— 不先定位到标识符，后面四条通道一个都跑不起来。
   * 只在标题**真实一致**（titleMatch，≥0.9）时才采纳，绝不靠相似度硬凑。
   */
  async resolveItemIdentifiers(ids, opts) {
    const o = opts || {};
    const cur = Object.assign({}, ids || {});
    if (cur.doi || cur.pmid || cur.pmcid || cur.arxivId) return { ids: cur, matched: false };
    if (!cur.title) return { ids: cur, matched: false };
    const srcs = o.sources || this.SEARCHABLE;
    let best = null;
    const tries = [
      () => (srcs.indexOf("openalex") >= 0 ? this.openalexSearch(cur.title, 5) : []),
      () => (srcs.indexOf("crossref") >= 0 ? this.crossrefSearch(cur.title, 5) : []),
      () => (srcs.indexOf("s2") >= 0 ? this.s2Search(cur.title, 5) : []),
      () => (srcs.indexOf("europepmc") >= 0 ? this.europepmcSearch(cur.title, 5) : []),
    ];
    for (const fn of tries) {
      let cands = [];
      try { cands = (await fn()) || []; } catch (e) { cands = []; }
      const hit = cands.find((r) => r && RefFormat.titleMatch(r.title, cur.title, 0.9));
      if (hit) { best = hit; break; }
    }
    if (!best) return { ids: cur, matched: false };
    if (best.doi) cur.doi = RefFormat.normDOI(best.doi);
    if (best.pmid) cur.pmid = RefFormat.normPmid(best.pmid);
    if (best.pmcid) cur.pmcid = String(best.pmcid).toUpperCase();
    if (best.arxivId) cur.arxivId = RefFormat.normArxiv(best.arxivId);
    cur.matchedTitle = best.title || "";
    return { ids: cur, matched: !!(cur.doi || cur.pmid || cur.pmcid || cur.arxivId) };
  },

  /* ================= 各源取数 ================= */

  _sel() {
    const v = String(Prefs.get("refImportSources", "") || "");
    if (!v) return this.SOURCES.map((s) => s.id);
    return v.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  },

  _has(id) {
    return this._sel().indexOf(id) >= 0;
  },

  /** DOI → Crossref */
  async crossrefByDOI(doi) {
    const d = RefFormat.normDOI(doi);
    if (!d) return null;
    const j = await this._getJSON(this.CROSSREF + "/works/" + encodeURIComponent(d) + "?mailto=" + encodeURIComponent(this._mailto()));
    return this.fromCrossref(j && j.message);
  },

  /** 自由文本 → Crossref 单条最佳命中 */
  async crossrefSearch(query, limit) {
    const url = this.CROSSREF + "/works?rows=" + (limit || 5)
      + "&query.bibliographic=" + encodeURIComponent(query)
      + "&select=DOI,title,author,issued,container-title,short-container-title,volume,issue,page,publisher,ISSN,ISBN,type,abstract,URL,language,is-referenced-by-count"
      + "&mailto=" + encodeURIComponent(this._mailto());
    const j = await this._getJSON(url);
    return ((j && j.message && j.message.items) || []).map((m) => this.fromCrossref(m)).filter(Boolean);
  },

  /** DOI → OpenAlex */
  async openalexByDOI(doi) {
    const d = RefFormat.normDOI(doi);
    if (!d) return null;
    const j = await this._getJSON(this.OPENALEX + "/works/doi:" + encodeURIComponent(d) + "?mailto=" + encodeURIComponent(this._mailto()));
    return this.fromOpenAlex(j);
  },

  async openalexByPmid(pmid) {
    const p = RefFormat.normPmid(pmid);
    if (!p) return null;
    const j = await this._getJSON(this.OPENALEX + "/works/pmid:" + encodeURIComponent(p) + "?mailto=" + encodeURIComponent(this._mailto()));
    return this.fromOpenAlex(j);
  },

  async openalexSearch(query, limit) {
    const url = this.OPENALEX + "/works?per-page=" + Math.max(1, Math.min(25, limit || 5))
      + "&search=" + encodeURIComponent(query)
      + "&mailto=" + encodeURIComponent(this._mailto());
    const j = await this._getJSON(url);
    return ((j && j.results) || []).map((w) => this.fromOpenAlex(w)).filter(Boolean);
  },

  /** esearch → id 列表 */
  async _pubmedEsearch(term, retmax) {
    const url = this.EUTILS + "/esearch.fcgi?db=pubmed&retmode=json&retmax=" + (retmax || 5)
      + "&term=" + encodeURIComponent(term);
    const j = await this._getJSON(url);
    return ((j && j.esearchresult && j.esearchresult.idlist) || []).map(String);
  },

  /** esummary → rec 列表（一次最多 200 条，实测 20 条以内最稳） */
  async pubmedByIds(ids) {
    const list = (ids || []).map(String).filter(Boolean).slice(0, 20);
    if (!list.length) return [];
    const url = this.EUTILS + "/esummary.fcgi?db=pubmed&retmode=json&id=" + list.join(",");
    const j = await this._getJSON(url);
    const result = (j && j.result) || {};
    const out = [];
    for (const uid of result.uids || list) {
      const doc = result[uid];
      const rec = this.fromPubMedSummary(uid, doc);
      if (rec) out.push(rec);
    }
    return out;
  },

  async pubmedSearch(query, limit) {
    const ids = await this._pubmedEsearch(query, Math.max(1, Math.min(20, limit || 5)));
    return this.pubmedByIds(ids);
  },

  /** arXiv（复用仓库既有抓取层：自带限速/重试/退避；不存在时返回空） */
  async arxivSearch(query, limit) {
    if (typeof ArxivFetch === "undefined" || !ArxivFetch) return [];
    try {
      const res = await ArxivFetch.search({ keywords: [query], phrase: true }, {
        limit: Math.max(1, Math.min(30, limit || 5)),
        pageSize: Math.max(1, Math.min(30, limit || 5)),
        maxPages: 1,
      });
      return (res.entries || []).map((e) => this.fromArxivEntry(e)).filter(Boolean);
    } catch (e) {
      return [];
    }
  },

  async arxivById(idOrUrl) {
    const id = RefFormat.normArxiv(idOrUrl);
    if (!id) return null;
    if (typeof ArxivFetch === "undefined" || !ArxivFetch) return null;
    try {
      const res = await ArxivFetch.search({ ids: [id] }, { limit: 1, pageSize: 1, maxPages: 1 });
      const e = (res.entries || [])[0];
      return this.fromArxivEntry(e);
    } catch (e) {
      return null;
    }
  },

  async s2ByDOI(doi) {
    if (typeof S2Client === "undefined" || !S2Client) return null;
    const d = RefFormat.normDOI(doi);
    if (!d) return null;
    try {
      const p = await S2Client.paperById("DOI:" + d,
        "title,year,venue,abstract,externalIds,authors,url,openAccessPdf,citationCount,publicationTypes,journal");
      return this.fromS2(p);
    } catch (e) {
      return null;
    }
  },

  async s2Search(query, limit) {
    if (typeof S2Client === "undefined" || !S2Client) return [];
    try {
      const list = await S2Client.searchByTitle(query,
        "title,year,venue,abstract,externalIds,authors,url,openAccessPdf,citationCount,publicationTypes,journal",
        Math.max(1, Math.min(20, limit || 5)));
      return (list || []).map((p) => this.fromS2(p)).filter(Boolean);
    } catch (e) {
      return [];
    }
  },

  /** ISBN / 书名 → OpenAlex 反查（图书章节常只有 ISBN） */
  async openalexByIsbn(isbn) {
    const v = RefFormat.normIsbn(isbn);
    if (!v) return null;
    const j = await this._getJSON(this.OPENALEX + "/works?filter=isbn:" + encodeURIComponent(v)
      + "&per-page=1&mailto=" + encodeURIComponent(this._mailto()));
    const w = ((j && j.results) || [])[0];
    return this.fromOpenAlex(w);
  },

  /**
   * DOI 内容协商：直接向 DOI 解析器要**出版社发布的 BibTeX**。
   * 这是「格式最规范」的一份元数据（出版社自己导出），比任何爬来的字段都准。
   * 但并非所有出版社都支持（Elsevier/Wiley 等常 406），失败一律静默回落。
   */
  async bibtexByDOI(doi) {
    const d = RefFormat.normDOI(doi);
    if (!d) return null;
    const r = await this._get(this.DOI_RESOLVER + "/" + encodeURIComponent(d),
      { accept: "application/x-bibtex", ttl: 60 * 60 * 1000, timeout: 15000 });
    if (r.error || !r.text || r.text.indexOf("@") !== 0) return null;
    try {
      const recs = RefFormat.parseBibtex(r.text);
      if (!recs.length) return null;
      const rec = recs[0];
      rec.reasons.push("出版社 BibTeX");
      return rec;
    } catch (e) {
      return null;
    }
  },

  /* ================= 解析与联合检索 ================= */

  /**
   * 单个标识符 → 尽量完整的规范记录（多源合并补缺，先到先得）
   * @param {{kind:string, value:string}} ident
   * @param {{sources?:Array<string>, enrich?:boolean}} [opts]
   */
  async resolve(ident, opts) {
    const o = opts || {};
    const kind = ident && ident.kind;
    const value = ident && ident.value;
    if (!kind || !value) return null;
    if (kind === "bibtex") {
      const recs = RefFormat.parseBibtex(value);
      if (!recs.length) return null;
      // 有 DOI 就顺手补全（BibTeX 常缺卷期页）
      if (recs[0].doi && o.enrich !== false) {
        const extra = await this.crossrefByDOI(recs[0].doi).catch(() => null);
        if (extra) return RefFormat.mergeRecords(RefFormat.mergeRecords(extra, recs[0]), extra);
      }
      return recs[0];
    }
    if (kind === "doi") return this.resolveDOI(value, o);
    if (kind === "pmid" || kind === "pmcid") return this.resolvePubMed(value, kind, o);
    if (kind === "arxiv") {
      const a = await this.arxivById(value).catch(() => null);
      if (a && a.doi && o.enrich !== false) {
        const cr = await this.crossrefByDOI(a.doi).catch(() => null);
        if (cr) return RefFormat.mergeRecords(RefFormat.mergeRecords(cr, a), cr);
      }
      return a;
    }
    if (kind === "isbn") {
      const w = await this.openalexByIsbn(value).catch(() => null);
      if (w) return w;
      const crs = await this.crossrefSearch(value, 3).catch(() => []);
      return crs[0] || null;
    }
    if (kind === "url") {
      // URL 里往往含着 DOI / PMID / arXiv 号——先挖出来走精确通道
      const inner = RefFormat.extractIdentifiers(value).filter((x) => x.kind !== "url");
      if (inner.length) return this.resolve(inner[0], o);
      const w = await this.openalexSearch(value, 3).catch(() => []);
      return w[0] || null;
    }
    if (kind === "title") return this.resolveTitle(value, o);
    return null;
  },

  /** DOI 通道：Crossref（最全）为主，OpenAlex 补 PMID/OA，出版社 BibTeX 补缺 */
  async resolveDOI(doi, opts) {
    const srcs = (opts && opts.sources) || this._sel();
    const want = (id) => srcs.indexOf(id) >= 0;
    let rec = null;
    if (want("crossref")) rec = await this.crossrefByDOI(doi).catch(() => null);
    if (want("openalex")) {
      const oa = await this.openalexByDOI(doi).catch(() => null);
      if (oa) rec = rec ? RefFormat.mergeRecords(rec, oa) : oa;
    }
    if (want("pubmed") && rec && rec.pmid) {
      const pm = (await this.pubmedByIds([rec.pmid]).catch(() => []))[0];
      if (pm) rec = RefFormat.mergeRecords(rec, pm);
    }
    if (!rec && want("s2")) rec = await this.s2ByDOI(doi).catch(() => null);
    if (rec && (!rec.volume || !rec.pages) && (opts && opts.publisherBibtex !== false)) {
      const bib = await this.bibtexByDOI(doi).catch(() => null);
      if (bib) rec = RefFormat.mergeRecords(rec, bib);
    }
    if (rec) rec.confidence = "high";
    return rec;
  },

  /** PMID / PMCID 通道 */
  async resolvePubMed(value, kind, opts) {
    const srcs = (opts && opts.sources) || this._sel();
    let pmid = RefFormat.normPmid(value);
    if (kind === "pmcid" && !pmid) {
      const ids = await this._pubmedEsearch(value + "[pmcid]", 1).catch(() => []);
      pmid = ids[0] || "";
    }
    let rec = null;
    if (pmid) {
      rec = (await this.pubmedByIds([pmid]).catch(() => []))[0] || null;
    }
    if (!rec && srcs.indexOf("openalex") >= 0) rec = await this.openalexByPmid(value).catch(() => null);
    if (rec && rec.doi && srcs.indexOf("crossref") >= 0) {
      const cr = await this.crossrefByDOI(rec.doi).catch(() => null);
      if (cr) rec = RefFormat.mergeRecords(RefFormat.mergeRecords(cr, rec), cr);
    }
    if (rec) rec.confidence = "high";
    return rec;
  },

  /** 标题通道：多源联合检索后取「标题真的一致」且得分最高的一条 */
  async resolveTitle(title, opts) {
    const { results } = await this.search(title, Object.assign({ limit: 8 }, opts || {}));
    const hit = (results || []).find((r) => RefFormat.titleMatch(r.title, title, 0.9));
    if (hit) return hit;
    return (results || [])[0] || null;
  },

  /**
   * 联合检索：五源并行 → 合并去重 → 打分排序。
   * 打分 = 标题贴近度（主）+ 命中源数（次）+ 是否有 DOI + 引用量对数项。
   * 「多源一致命中」是本功能提高准确率的核心机制：同一篇被 Crossref/PubMed/OpenAlex
   * 同时返回，远比其他源里一条孤零零的同名结果可信。
   * @returns {{results:Array, perSource:object, errors:object, query:string}}
   */
  async search(query, opts) {
    const o = opts || {};
    const q = String(query || "").trim();
    const limit = Math.max(1, Math.min(50, o.limit || 10));
    const srcs = o.sources || this._sel();
    const perSource = {};
    const errors = {};
    // ★ 计划必须是**惰性的**：若先 `this.crossrefSearch(...)` 再判断要不要跑，
    // 被取消勾选的源照样会发出请求（浪费限速额度，且用户看到「关了还在查」）。
    const plan = [
      ["crossref", () => this.crossrefSearch(q, Math.max(3, limit))],
      ["openalex", () => this.openalexSearch(q, Math.max(3, limit))],
      ["pubmed", () => this.pubmedSearch(q, Math.max(3, limit))],
      ["europepmc", () => this.europepmcSearch(q, Math.max(3, limit))],
      ["arxiv", () => this.arxivSearch(q, Math.max(3, limit))],
      ["s2", () => this.s2Search(q, Math.max(3, limit))],
    ];
    const tasks = [];
    for (const [id, fn] of plan) {
      if (srcs.indexOf(id) < 0) continue;
      tasks.push(fn().then((list) => {
        perSource[id] = (list || []).length;
        return list || [];
      }, (e) => {
        errors[id] = (e && (e.message || String(e))) || "failed";
        perSource[id] = 0;
        return [];
      }));
    }

    const settled = await Promise.all(tasks);
    const flat = [];
    for (const list of settled) for (const r of list) flat.push(r);

    const { records } = RefFormat.dedupeRecords(flat);
    for (const rec of records) this._score(rec, q, limit);
    records.sort((a, b) => b.score - a.score);
    return { results: records.slice(0, limit), perSource, errors, query: q };
  },

  /** 给一条记录打「与查询的贴合度」分（0-100+） */
  _score(rec, query, limit) {
    const sim = RefFormat.similarity(RefFormat.normTitle(rec.title), RefFormat.normTitle(query));
    const exact = RefFormat.titleMatch(rec.title, query, 0.98) ? 1 : 0;
    let score = sim * 70 + exact * 12;
    const nSrc = (rec.source || []).length;
    score += Math.min(4, nSrc) * 6;                       // 多源一致命中
    if (rec.doi) score += 5;
    if (rec.abstract) score += 2;
    if (rec.volume && rec.pages) score += 3;
    if (typeof rec.citationCount === "number" && rec.citationCount > 0) {
      score += Math.min(6, Math.log10(rec.citationCount + 1) * 3);
    }
    rec.score = Math.round(score * 10) / 10;
    rec.reasons = [...new Set((rec.reasons || []).concat(
      nSrc > 1 ? [nSrc + " 源一致"] : [],
      sim >= 0.9 ? ["标题贴近 " + sim.toFixed(2)] : []
    ))];
    if (limit && rec.score < 15) rec.lowConfidence = true;
  },

  /** 对一批已有记录做「补全」（缺字段时按 DOI/PMID/arXiv/标题去查） */
  async enrichRecords(records, opts) {
    const out = [];
    for (const rec of records || []) {
      let better = null;
      try {
        if (rec.doi) better = await this.resolveDOI(rec.doi, opts);
        else if (rec.pmid) better = await this.resolvePubMed(rec.pmid, "pmid", opts);
        else if (rec.arxivId) better = await this.resolve({ kind: "arxiv", value: rec.arxivId }, opts);
        else if (rec.title) better = await this.resolveTitle(rec.title, opts);
      } catch (e) {
        better = null;
      }
      out.push(better ? RefFormat.mergeRecords(better, rec) : rec);
    }
    return out;
  },

  /** 启动自检摘要（写入 boot 日志，便于实机排障时一眼看出源是否可达） */
  async selfTest() {
    const r = await this._getJSON(this.CROSSREF + "/works/10.1038/nature12373?mailto=" + encodeURIComponent(this._mailto()), { timeout: 8000 })
      .catch(() => null);
    const rec = this.fromCrossref(r && r.message);
    return "ok=" + (rec && rec.title ? "1" : "0") + " title=" + ((rec && rec.title) || "").slice(0, 40);
  },
};
