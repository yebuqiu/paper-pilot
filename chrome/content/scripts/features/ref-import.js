/* PaperPilot 参考文献一键入库 · 编排层（0.33.0 重写）
 *
 * ── 为什么重写 ────────────────────────────────────────────────
 * 旧实现（citation-trace.js 的 importForSelected，0.8.0 起）有三个硬伤，合起来导致
 * 用户视角「这功能没法用」：
 *   ① **无 DOI 即丢弃**：`return d && !doiSet.has(d)` —— 参考文献里没有 DOI 的
 *      （中文文献、旧文献、会议论文占很大比例）一条都不显示，最后弹
 *      「参考文献均已在本地文库（或缺 DOI 无法可靠入库）」；
 *   ② **只认 DOI 判重**：库里明明有这篇（靠标题/arXiv/PMID 匹配），因为 DOI 不同就当作新条目，
 *      一键入库变一键造重复；
 *   ③ **元数据不全**：只写 title/year/venue/abstract/DOI+作者，
 *      卷/期/页/ISSN/出版社/itemType 全部缺失，入库后还要手工补一遍。
 * 另外它把一切条目都建成 journalArticle，会议论文/书章/预印本被建错类型。
 *
 * ── 本模块的职责 ──────────────────────────────────────────────
 *   · 库内索引与**多键判重**（DOI / PMID / arXiv / ISBN / 标题）
 *   · 条目构建（按 itemType 精确映射字段 —— 这是「格式规范」的关键，
 *     因为 Zotero 对不同类型只接受各自的合法字段，乱 set 会抛错）
 *   · AI 元数据补全（只填空、不覆盖）与「AI 调研」兜底（明确标注未核实）
 *   · 批量入库（可直接建条目，也可走 Zotero 内置 BibTeX 解析器）
 *   · 导出 BibTeX / EndNote(RIS) / CSL-JSON
 *   · 打开统一对话框，并保留「从当前文献导入参考文献」入口
 */
/* global Zotero, Services, Components, IOUtils, Prefs, I18n, RefFormat, RefSources, CitationColumn, ItemSel, AIClient, S2Client, MdLite */

var RefImport = {
  DLOG_URL: "chrome://paperpilot/content/ref-import.xhtml",
  // 两个名字不是一回事：openDialog 的第二个参数是**窗口名**，
  // 而 Services.wm.getEnumerator 匹配的是 **windowtype 属性**。
  // 把它们写成同一个字符串（很容易顺手这么干）会让「单实例」永远失效——
  // 表现是每点一次菜单就开一个新窗口（真机才会发现，静态单测看不出来）。
  WINDOW_NAME: "paperpilot-ref-import",
  WINDOW_TYPE: "paperpilot:ref-import",

  /* ================= 库内索引与判重 ================= */

  _lib: null,
  _libT: 0,

  /** 全库常规条目（与 Discovery 同口径：排除附件与笔记） */
  async collectLibraryItems() {
    const out = [];
    try {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("itemType", "isNot", "attachment");
      s.addCondition("itemType", "isNot", "note");
      for (const id of await s.search()) {
        const it = await Zotero.Items.getAsync(id);
        if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) out.push(it);
      }
    } catch (e) { /* 读库失败时返回空索引：功能仍可用，只是判不了重 */ }
    return out;
  },

  /** 库内索引（60s 缓存）：多键判重靠它。旧实现只建 DOI 一个 Set，是重复条目的主要来源。 */
  async libraryIndex(force) {
    if (!force && this._lib && Date.now() - this._libT < 60000) return this._lib;
    const items = await this.collectLibraryItems();
    const idx = { dois: new Set(), pmids: new Set(), arxiv: new Set(), isbns: new Set(), titles: new Map(), items };
    for (const it of items) {
      const g = (f) => { try { return String(it.getField(f) || ""); } catch (e) { return ""; } };
      const doi = RefFormat.normDOI(g("DOI"));
      if (doi) idx.dois.add(doi);
      const extra = g("extra");
      const pmid = /PMID:\s*(\d{6,9})/i.exec(extra);
      if (pmid) idx.pmids.add(pmid[1]);
      const ax = (RefFormat.normArxiv(g("archiveID")) || "") || RefFormat.normArxiv(extra);
      if (ax) idx.arxiv.add(ax);
      const isbn = RefFormat.normIsbn(g("ISBN"));
      if (isbn) idx.isbns.add(isbn);
      const t = RefFormat.normTitle(g("title"));
      if (t && t.length >= 8 && !idx.titles.has(t)) idx.titles.set(t, it);
    }
    this._lib = idx;
    this._libT = Date.now();
    return idx;
  },

  /** 判重：返回 {dup:boolean, by:string, item:ZoteroItem|null}
   *  ★ 标题键走「归一化全等 + 模糊相似」，因为库里常混着同一篇的预印本与正式版。 */
  findDuplicate(rec, idx) {
    if (!rec || !idx) return { dup: false, by: "", item: null };
    const doi = RefFormat.normDOI(rec.doi);
    if (doi && idx.dois.has(doi)) return { dup: true, by: "doi", item: null };
    const pm = RefFormat.normPmid(rec.pmid);
    if (pm && idx.pmids.has(pm)) return { dup: true, by: "pmid", item: null };
    const ax = RefFormat.normArxiv(rec.arxivId);
    if (ax && idx.arxiv.has(ax)) return { dup: true, by: "arxiv", item: null };
    const isbn = RefFormat.normIsbn(rec.isbn);
    if (isbn && idx.isbns.has(isbn)) return { dup: true, by: "isbn", item: null };
    const nt = RefFormat.normTitle(rec.title);
    if (nt && nt.length >= 8) {
      const exact = idx.titles.get(nt);
      if (exact) return { dup: true, by: "title", item: exact };
      if (nt.length >= 20) {
        for (const [k, it] of idx.titles) {
          if (Math.abs(k.length - nt.length) > 24) continue;
          if (RefFormat.similarity(k, nt) >= 0.95) return { dup: true, by: "title~", item: it };
        }
      }
    }
    return { dup: false, by: "", item: null };
  },

  /** 给一批记录标注 dup（就地写 `dup` 字段，UI 直接读） */
  async markDuplicates(records) {
    const idx = await this.libraryIndex();
    for (const rec of records || []) rec.dup = this.findDuplicate(rec, idx);
    return records;
  },

  /* ================= 记录 → Zotero 条目（纯函数，可离线单测） ================= */

  /** 各 itemType 的字段白名单 + 取值方式。★ 白名单是硬要求：
   *  Zotero 对不合法的 (itemType, field) 组合会抛错，旧实现不分类型地
   *  setField("publicationTitle")，遇到会议论文/书章时静默失败、字段丢失。 */
  FIELD_PLAN: {
    journalArticle: [["title", "title"], ["abstractNote", "abstract"], ["publicationTitle", "container"],
      ["volume", "volume"], ["issue", "issue"], ["pages", "pages"], ["date", "dateOrYear"],
      ["DOI", "doi"], ["ISSN", "issn"], ["url", "url"], ["language", "language"]],
    conferencePaper: [["title", "title"], ["abstractNote", "abstract"], ["proceedingsTitle", "container"],
      ["conferenceName", "container"], ["pages", "pages"], ["date", "dateOrYear"], ["DOI", "doi"],
      ["publisher", "publisher"], ["place", "place"], ["url", "url"], ["language", "language"]],
    bookSection: [["title", "title"], ["abstractNote", "abstract"], ["bookTitle", "container"],
      ["pages", "pages"], ["date", "dateOrYear"], ["publisher", "publisher"], ["place", "place"],
      ["ISBN", "isbn"], ["DOI", "doi"], ["url", "url"], ["language", "language"]],
    book: [["title", "title"], ["abstractNote", "abstract"], ["date", "dateOrYear"],
      ["publisher", "publisher"], ["place", "place"], ["ISBN", "isbn"], ["url", "url"], ["language", "language"]],
    preprint: [["title", "title"], ["abstractNote", "abstract"], ["date", "dateOrYear"],
      ["repository", "repository"], ["archiveID", "archiveID"], ["url", "url"], ["language", "language"]],
    thesis: [["title", "title"], ["abstractNote", "abstract"], ["date", "dateOrYear"],
      ["university", "publisher"], ["place", "place"], ["url", "url"], ["language", "language"]],
    report: [["title", "title"], ["abstractNote", "abstract"], ["date", "dateOrYear"],
      ["institution", "publisher"], ["reportNumber", "issue"], ["place", "place"],
      ["DOI", "doi"], ["url", "url"], ["language", "language"]],
    webpage: [["title", "title"], ["abstractNote", "abstract"], ["date", "dateOrYear"],
      ["websiteTitle", "container"], ["url", "url"], ["language", "language"]],
    document: [["title", "title"], ["abstractNote", "abstract"], ["date", "dateOrYear"],
      ["publisher", "publisher"], ["url", "url"], ["language", "language"]],
  },

  /** rec → {itemType, fields:{zoteroField:value}, creators:[{firstName,lastName,creatorType}], extra}
   *  纯函数：不碰 Zotero，测试直接断言字段映射。 */
  buildItem(rec) {
    const itemType = this.FIELD_PLAN[rec.itemType] ? rec.itemType : "journalArticle";
    const src = {
      title: rec.title || "",
      abstract: rec.abstract || "",
      container: rec.container || "",
      volume: rec.volume || "",
      issue: rec.issue || "",
      pages: String(rec.pages || "").replace(/\s*[-–—]+\s*/, "-"),
      doi: rec.doi || "",
      issn: rec.issn || "",
      isbn: rec.isbn || "",
      url: rec.url || "",
      language: rec.language || "",
      publisher: rec.publisher || "",
      place: rec.place || "",
      // Zotero 的 date 字段接受 "2020-05-01" / "2020-05" / "2020" 三种
      dateOrYear: rec.date || (rec.year ? String(rec.year) : ""),
      repository: rec.arxivId ? "arXiv" : (rec.container || ""),
      archiveID: rec.arxivId ? "arXiv:" + rec.arxivId : "",
    };
    const fields = {};
    for (const [zf, f] of this.FIELD_PLAN[itemType]) {
      const v = src[f];
      if (v == null || String(v).trim() === "") continue;
      fields[zf] = String(v).trim();
    }
    if (fields.conferenceName && fields.conferenceName === fields.proceedingsTitle) delete fields.conferenceName;
    const creators = [];
    for (const a of rec.authors || []) {
      if (a.literal) creators.push({ name: a.literal, creatorType: "author" });
      else if (a.family || a.given) creators.push({ firstName: a.given || "", lastName: a.family || "", creatorType: "author" });
    }
    // extra：把无法用标准字段表达、但检索/写作时很有用的信息写进去（Zotero 通用约定）
    const extra = [];
    if (rec.pmid) extra.push("PMID: " + rec.pmid);
    if (rec.pmcid) extra.push("PMCID: " + rec.pmcid);
    if (rec.arxivId && itemType !== "preprint") extra.push("arXiv: " + rec.arxivId);
    if (rec.year && !src.dateOrYear) extra.push("Year: " + rec.year);
    if (rec.ai) extra.push("Metadata assisted by AI (PaperPilot) — verify before citing");
    if (typeof rec.citationCount === "number" && rec.citationCount > 0) extra.push("Citations (Semantic Scholar): " + rec.citationCount);
    return { itemType, fields, creators, extra: extra.join("\n") };
  },

  /* ================= 入库 ================= */

  /** 目标分类：显式传入 > 当前选中分类 > null（只进文库） */
  _targetCollection(zp, explicit) {
    if (explicit) return explicit;
    try {
      const cols = zp && zp.getSelectedCollections && zp.getSelectedCollections();
      return (cols && cols[0]) || null;
    } catch (e) { return null; }
  },

  /**
   * 批量入库。
   * @param {Array} records
   * @param {{libraryID?:number, collection?:object, viaTranslator?:boolean,
   *          onProgress?:function(rec, i, n)}} [opts]
   * @returns {Promise<{ok:number, fail:number, items:Array, errors:Array, collection:object|null, mode:string}>}
   */
  async importRecords(records, opts) {
    const o = opts || {};
    const list = (records || []).filter((r) => r && !RefFormat.isBlank(r));
    const libID = o.libraryID || Zotero.Libraries.userLibraryID;
    const col = o.collection || null;
    const res = { ok: 0, fail: 0, items: [], errors: [], collection: col, mode: "direct" };

    // 走 Zotero 内置 BibTeX 解析器：字段映射由 Zotero 自己负责，最「规范」，
    // 但一旦某条解析失败难以定位，所以失败时**整批回落到直接建条目**（不丢数据）。
    if (o.viaTranslator) {
      const tr = await this._importViaTranslator(list, libID, col).catch(() => null);
      if (tr && tr.ok > 0) return tr;
    }

    let i = 0;
    for (const rec of list) {
      i++;
      try {
        if (o.onProgress) { try { o.onProgress(rec, i, list.length); } catch (e) { /* ignore */ } }
        const spec = this.buildItem(rec);
        const item = new Zotero.Item(spec.itemType);
        item.libraryID = libID;
        for (const k of Object.keys(spec.fields)) {
          try { item.setField(k, spec.fields[k]); } catch (e) { /* 该类型无此字段 */ }
        }
        if (spec.extra) { try { item.setField("extra", spec.extra); } catch (e) { /* ignore */ } }
        if (spec.creators.length) {
          try { item.setCreators(spec.creators); } catch (e) { /* 个别姓名为空时忽略 */ }
        }
        if (col) { try { item.addToCollection(col.id); } catch (e) { /* ignore */ } }
        await item.saveTx();
        res.ok++;
        res.items.push(item);
      } catch (e) {
        res.fail++;
        res.errors.push({ title: rec.title || "", message: (e && (e.message || String(e))) || "save failed" });
      }
    }
    return res;
  },

  /** 用 Zotero 自带 BibTeX 导入器解析后建条目（作为「更规范」的可选通道）
   *
   *  ★ 不能只信翻译器「换了 itemDone」就算成功：不同 Zotero 版本对 import 翻译器的
   *  落盘时机不一致（有的自己 saveTx，有的交给调用方）。历史上这类「看起来成功了、
   *  其实一条都没进库」的静默失败最难排。所以这里：① 收集 itemDone 抛出的条目；
   *  ② 翻译结束后逐条确认真的有 id（没有就自己 saveTx）；③ 一条都没落盘的整批
   *  返回 null，由调用方回落到直接建条目 —— 绝不把「0 条」当成成功。 */
  async _importViaTranslator(records, libID, col) {
    const bib = RefFormat.toBibtex(records);
    if (!bib.trim()) return null;
    const out = { ok: 0, fail: 0, items: [], errors: [], collection: col, mode: "translator" };
    const pending = [];
    let translator;
    try {
      translator = await Promise.resolve(Zotero.loadTranslator("import"));
      // Zotero 内置 BibTeX 转换器的 id（多年稳定不变）
      await Promise.resolve(translator.setTranslator("9cb70025-a888-4a29-a210-93ec52da40d4"));
      translator.setString(bib);
    } catch (e) {
      return null;
    }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        translator.setHandler("itemDone", (obj, item) => {
          if (item) pending.push(item);
        });
        translator.setHandler("error", (obj, err) => { out.errors.push({ title: "", message: String(err) }); });
        translator.setHandler("done", finish);
        Promise.resolve(translator.translate()).then(finish, (e) => {
          out.errors.push({ title: "", message: (e && (e.message || String(e))) || "translate failed" });
          finish();
        });
      } catch (e) {
        finish();
      }
      setTimeout(finish, 60000); // 兜底：某些版本不触发 done
    });

    for (const item of pending) {
      try {
        if (!item.libraryID) item.libraryID = libID;
        if (!item.id) await item.saveTx();
        if (col && item.id) { try { item.addToCollection(col.id); await item.saveTx(); } catch (e) { /* 分类失败不算导入失败 */ } }
        if (item.id) { out.ok++; out.items.push(item); } else { out.fail++; }
      } catch (e) {
        out.fail++;
        out.errors.push({ title: "", message: (e && (e.message || String(e))) || "save failed" });
      }
    }
    // 一条都没真正落盘 → 交回上层走直接建条目（宁可字段少一点，也不能什么都没入库）
    if (!out.ok) return null;
    return out;
  },

  /* ================= AI：元数据补全 / 调研 ================= */

  AI_FIELDS: ["title", "authors", "year", "container", "volume", "issue", "pages", "publisher", "doi", "abstract", "itemType"],

  /** 从模型回复里抠出 JSON（容忍 ```json 围栏与前后闲话） */
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

  aiPrompt(records) {
    const payload = records.map((r) => ({
      title: r.title || "", authors: (r.authors || []).map((a) => (a.literal ? a.literal : [a.given, a.family].filter(Boolean).join(" "))),
      year: r.year || "", container: r.container || "", volume: r.volume || "", issue: r.issue || "",
      pages: r.pages || "", publisher: r.publisher || "", doi: r.doi || "", abstract: r.abstract || "",
      itemType: r.itemType || "",
    }));
    return [
      {
        role: "system",
        content: "你是学术文献元数据校对助手。只输出 JSON，不要任何解释、不要 Markdown 围栏。"
          + "规则：① 只补充你确有把握的字段；② 绝不允许编造 DOI/PMID（拿不准就留空字符串）；"
          + "③ 不得修改输入中已有非空字段的语义，只允许修正明显的大小写/拼写错误；"
          + "④ itemType 取值限：journalArticle / conferencePaper / bookSection / book / preprint / thesis / report / webpage。",
      },
      {
        role: "user",
        content: "请补全下列文献记录中缺失的字段，并原样返回全部记录（顺序不变、条数不变）。\n"
          + '输出格式：{"records":[{"title":"","authors":[],"year":"","container":"","volume":"","issue":"","pages":"","publisher":"","doi":"","abstract":"","itemType":"","fixed":[]}]}\n'
          + "输入：" + JSON.stringify({ records: payload }),
      },
    ];
  },

  /**
   * AI 元数据补全：**只填空，不覆盖**（与 MetaEnrich 同一纪律）。
   * @returns {Promise<{ok:boolean, reason?:string, filled:number, records:Array}>}
   */
  async aiComplete(records, opts) {
    const o = opts || {};
    const list = records || [];
    if (!list.length) return { ok: true, filled: 0, records: list };
    if (o.force !== true) {
      const need = list.filter((r) => RefFormat.gapFields(r).length > 0);
      if (!need.length) return { ok: true, filled: 0, records: list };
    }
    if (typeof AIClient === "undefined" || !AIClient || !AIClient.hasKey()) {
      return { ok: false, reason: AIClient && AIClient.status ? AIClient.status() : "no_key", filled: 0, records: list };
    }
    let filled = 0;
    // 每批 5 条：条数太多时模型容易漏项或串行，反而降低质量
    for (let i = 0; i < list.length; i += 5) {
      const chunk = list.slice(i, i + 5);
      let reply;
      try {
        reply = await AIClient.chat(this.aiPrompt(chunk));
      } catch (e) {
        return { ok: false, reason: (e && (e.message || String(e))) || "ai failed", filled, records: list };
      }
      const data = this.parseAIJSON(reply);
      const out = (data && (data.records || (Array.isArray(data) ? data : null))) || [];
      for (let k = 0; k < chunk.length; k++) {
        const got = out[k];
        if (!got || typeof got !== "object") continue;
        filled += this.applyAIFields(chunk[k], got);
      }
      if (o.onProgress) { try { o.onProgress(Math.min(list.length, i + 5), list.length); } catch (e) { /* ignore */ } }
    }
    return { ok: true, filled, records: list };
  },

  /** 把 AI 返回的字段合进一条记录：只填空；返回实际补上的字段数 */
  applyAIFields(rec, got) {
    if (!rec || !got) return 0;
    let n = 0;
    const put = (field, v) => {
      if (v == null || String(v).trim() === "") return;
      if (rec[field] != null && String(rec[field]).trim() !== "") return; // ★ 只填空
      rec[field] = String(v).trim();
      n++;
    };
    for (const f of ["title", "container", "volume", "issue", "pages", "publisher", "abstract"]) put(f, got[f]);
    if (!rec.year) { const y = RefFormat.yearOf(got.year); if (y) { rec.year = y; rec.date = rec.date || String(y); n++; } }
    // ★ DOI 不做「补空」：AI 编造 DOI 的代价极高（错误链接比缺失更糟），非空且格式合法才采纳
    if (!rec.doi && got.doi && /^10\.\d{4,9}\//.test(String(got.doi))) { rec.doi = RefFormat.normDOI(got.doi); n++; }
    if ((!rec.authors || !rec.authors.length) && Array.isArray(got.authors) && got.authors.length) {
      const auth = [];
      for (const a of got.authors) {
        const p = typeof a === "string" ? RefFormat.parseAuthor(a) : (a && (a.family || a.literal)) ? a : null;
        if (p && (p.family || p.literal)) auth.push({ family: p.family || "", given: p.given || "", literal: p.literal || "" });
      }
      if (auth.length) { rec.authors = auth; n++; }
    }
    if (got.itemType && rec.itemType === "preprint" && this.FIELD_PLAN[got.itemType] && got.itemType !== "preprint") {
      rec.itemType = got.itemType;
      n++;
    }
    if (n) {
      rec.ai = true;
      rec.confidence = rec.confidence || "medium";
      rec.reasons = [...new Set((rec.reasons || []).concat(["AI 补全"]))];
    }
    return n;
  },

  /**
   * AI 调研兜底：五个源都查不到时，让模型按线索给出**候选**元数据。
   * 纪律：结果一律带 `ai:true` 与 `confidence`，UI 必须显著标注「AI 推断，未经核实」，
   * 且不允许由它自动入库（必须用户勾选）。
   */
  async aiInvestigate(text) {
    if (typeof AIClient === "undefined" || !AIClient || !AIClient.hasKey()) {
      return { ok: false, reason: AIClient && AIClient.status ? AIClient.status() : "no_key" };
    }
    const messages = [
      { role: "system", content: "你是学术检索助手。只输出 JSON，不要解释、不要 Markdown 围栏。绝不编造 DOI/PMID，拿不准就留空。" },
      { role: "user", content: "根据以下线索，给出最可能对应的那一篇文献的规范元数据。\n"
        + '线索：' + String(text || "").slice(0, 800) + "\n"
        + '输出：{"record":{"title":"","authors":[],"year":"","container":"","volume":"","issue":"","pages":"","publisher":"","doi":"","abstract":"","itemType":"journalArticle"},"confidence":"high|medium|low","note":"为什么这么判断"}' },
    ];
    let reply;
    try { reply = await AIClient.chat(messages); }
    catch (e) { return { ok: false, reason: (e && (e.message || String(e))) || "ai failed" }; }
    const data = this.parseAIJSON(reply);
    const got = data && (data.record || data);
    if (!got || typeof got !== "object" || !got.title) return { ok: false, reason: "ai_no_result" };
    const rec = RefFormat.empty();
    rec.source = ["ai"];
    rec.ai = true;
    rec.confidence = (data && data.confidence) || "low";
    rec.note = (data && data.note) || "";
    rec.reasons = ["AI 调研（未核实）"];
    this.applyAIFields(rec, got);
    if (got.itemType && this.FIELD_PLAN[got.itemType]) rec.itemType = got.itemType;
    rec.title = rec.title || String(got.title);
    return { ok: true, record: rec };
  },

  /* ================= 导出 ================= */

  exportRecords(records, format) {
    return RefFormat.exportAs(records, format);
  },

  /** 导出并写入剪贴板（Zotero 8 前用 XPCOM 剪贴板，失败回落 dump 到临时文件） */
  async copyToClipboard(text) {
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(String(text || ""));
      return true;
    } catch (e) { return false; }
  },

  /** 导出到文件（用户选路径） */
  async saveToFile(text, suggestedName) {
    try {
      const win = Zotero.getMainWindow();
      const fp = Components.classes["@mozilla.org/filepicker;1"]
        .createInstance(Components.interfaces.nsIFilePicker);
      fp.init(win, I18n.isZh ? "导出参考文献" : "Export references", fp.modeSave);
      fp.defaultString = suggestedName || "references.bib";
      fp.appendFilters(fp.filterAll);
      const rv = await new Promise((resolve) => { fp.open((r) => resolve(r)); });
      if (rv === fp.returnCancel) return "";
      const path = fp.file && fp.file.path;
      if (!path) return "";
      await IOUtils.writeUTF8(path, String(text || ""));
      return path;
    } catch (e) {
      return "";
    }
  },

  /* ================= 从当前条目导入其参考文献（替代旧流程） ================= */

  /**
   * 取「选中条目的参考文献」列表（S2 references 仍然是最省事的免费来源：
   * 一次请求就能拿到上百条带作者/摘要/DOI 的题录），但**不再按 DOI 丢弃**，
   * 改用多键判重；无 DOI 的照常入库（标题+年份+作者已足够定位一篇文献）。
   */
  async fetchReferences(item, opts) {
    const o = opts || {};
    const zh = I18n.isZh;
    const title = this._fieldOf(item, "title");
    const want = RefFormat.normTitle(title);
    const doi = RefFormat.normDOI(this._fieldOf(item, "DOI"));
    if (typeof S2Client === "undefined" || !S2Client) throw new Error(zh ? "Semantic Scholar 客户端不可用" : "S2 client unavailable");

    let paper = null;
    if (doi) {
      try { paper = await S2Client.paperById("DOI:" + doi, "title,year,venue,externalIds,citationCount"); } catch (e) { /* 落标题检索 */ }
      if (paper && want && RefFormat.normTitle(paper.title) !== want) paper = null; // DOI 错配 → 回退
    }
    if (!paper && title) {
      const cands = await S2Client.searchByTitle(title, 5, "title,year,venue,externalIds,citationCount");
      paper = cands.find((p) => RefFormat.normTitle(p.title) === want) || null;
    }
    if (!paper || !paper.paperId) throw new Error(zh ? "Semantic Scholar 查无此文" : "Not found on Semantic Scholar");

    const raw = await S2Client.references(paper.paperId,
      "title,year,venue,abstract,externalIds,authors,citationCount", o.limit || 200);
    const recs = [];
    for (const r of raw || []) {
      const p = r && r.citedPaper;
      if (!p) continue;
      const rec = RefSources.fromS2({
        title: p.title, year: p.year, venue: p.venue, abstract: p.abstract,
        externalIds: p.externalIds, authors: p.authors, citationCount: p.citationCount,
        publicationTypes: [], journal: p.journal,
      });
      if (rec) { rec.source = ["s2"]; rec.reasons = ["Semantic Scholar · 参考文献"]; recs.push(rec); }
    }
    // 参考文献列表可能很大：先按「有没有强标识符 + 引用量」粗排，让最有价值的排前面
    recs.sort((a, b) => {
      const ka = (a.doi || a.pmid || a.arxivId) ? 1 : 0;
      const kb = (b.doi || b.pmid || b.arxivId) ? 1 : 0;
      if (ka !== kb) return kb - ka;
      return (b.citationCount || 0) - (a.citationCount || 0);
    });
    return { paper, records: recs.slice(0, o.max || 200) };
  },

  _fieldOf(item, f) {
    try { return item.getField(f) || ""; } catch (e) { return ""; }
  },

  /** 菜单入口：从当前选中条目导入其参考文献（打开统一对话框的 refs 模式） */
  async importForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const item = ItemSel.regularOnly(zp.getSelectedItems() || [])[0];
    if (!item) { ItemSel.alertEmpty(); return; }
    const win = this._openDialog({ mode: "refs", item });
    return win;
  },

  /** 菜单/功能中心入口：打开「参考文献一键入库」总对话框 */
  openDialog(mode) {
    return this._openDialog({ mode: mode || "search" });
  },

  _openDialog(payload) {
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
    if (!win) return null;
    try {
      const en = Services.wm.getEnumerator(this.WINDOW_TYPE);
      if (en.hasMoreElements()) {
        const w = en.getNext();
        try { w.focus(); } catch (e) { /* ignore */ }
        if (typeof w.PaperPilotSetPayload === "function") {
          try { w.PaperPilotSetPayload(payload); } catch (e) { /* ignore */ }
        }
        return w;
      }
    } catch (e) { /* ignore */ }
    return win.openDialog(this.DLOG_URL, this.WINDOW_NAME, "chrome,centerscreen,resizable,dialog=no", {
      Zotero: Zotero,
      Services: Services,
      payload: payload || {},
      api: this.windowApi(),
    });
  },

  /* ================= 对话框 API（窗口脚本运行在独立作用域，
   * 既拿不到 bootstrap 作用域也**不允许**自己发网络/AI 请求） ================= */

  windowApi() {
    return {
      sources: () => RefSources.SOURCES.map((s) => Object.assign({}, s)),
      defaultSources: () => RefSources._sel(),
      parseInput: (text) => RefFormat.extractIdentifiers(text),
      parseBibtex: (text) => RefFormat.parseBibtex(text),
      dedupe: (records) => RefFormat.dedupeRecords(records),
      search: (query, opts) => RefSources.search(query, opts || {}),
      resolve: (ident, opts) => RefSources.resolve(ident, opts || {}),
      enrich: (records, opts) => RefSources.enrichRecords(records, opts || {}),
      aiComplete: (records, opts) => this.aiComplete(records, opts || {}),
      aiInvestigate: (text) => this.aiInvestigate(text),
      aiStatus: () => (typeof AIClient !== "undefined" && AIClient && AIClient.status ? AIClient.status() : "no_key"),
      markDuplicates: (records) => this.markDuplicates(records),
      libraryCount: async () => (await this.libraryIndex()).items.length,
      fetchReferences: async (opts) => {
        const zp = Zotero.getActiveZoteroPane();
        const item = ItemSel.regularOnly(zp ? (zp.getSelectedItems() || []) : [])[0];
        if (!item) throw new Error(I18n.isZh ? "主窗口没有选中任何条目" : "No item selected in the main window");
        const r = await this.fetchReferences(item, opts || {});
        return { paper: { title: (r.paper && r.paper.title) || this._fieldOf(item, "title") }, records: r.records };
      },
      importRecords: (records, opts) => {
        const zp = Zotero.getActiveZoteroPane();
        const col = this._targetCollection(zp, (opts && opts.collectionId) ? { id: opts.collectionId } : null);
        return this.importRecords(records, Object.assign({}, opts || {}, { collection: col }));
      },
      exportText: (records, format) => this.exportRecords(records, format),
      copyText: (text) => this.copyToClipboard(text),
      saveText: (text, name) => this.saveToFile(text, name),
      invalidateLibrary: () => { this._lib = null; this._libT = 0; },
      i18n: (key) => I18n.t(key),
      isZh: () => I18n.isZh,
    };
  },
};
