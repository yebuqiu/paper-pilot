// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 参考文献格式层（纯函数，0.33.0 新增）
 *
 * 为什么单独一个文件：参考文献一键入库的**全部难点都在「格式」上**——
 *   ① 用户给的输入五花八门（DOI / 标题 / 网址 / PMID / arXiv 号 / 整段 BibTeX）；
 *   ② 各家元数据源的字段名与语义都不一样（Crossref 叫 container-title、
 *      OpenAlex 叫 primary_location.source.display_name、PubMed 只有 source）；
 *   ③ 去重要同时看 DOI、PMID、arXiv、ISBN 与标题（只比 DOI 会漏掉大量中文与旧文献）；
 *   ④ 入库要求「格式规范」——BibTeX / EndNote(RIS) / CSL-JSON 三套序列化规则各不相同。
 *
 * 这些全是**纯字符串/对象变换**，不碰网络也不碰 Zotero。放这里的好处：
 * 可以离线单测（test/ref-import.test.js），不必为了验证「& 有没有被转义成 \&」
 * 去起一个真实 Zotero。凡是这里能测的，就别留给「装到真机上点点看」。
 *
 * 记录（rec）的规范字段（各源解析后都归一到这一份，UI 与入库只认它）：
 *   { source:[], title, abstract, authors:[{family,given,literal}], year, date,
 *     container, volume, issue, pages, publisher, place, issn, isbn,
 *     doi, pmid, pmcid, arxivId, url, language, itemType, citationCount,
 *     ai, confidence, score, reasons, dup }
 */
/* global CitationColumn */

var RefFormat = {
  /* ================= 归一化与比较 ================= */

  /** DOI 归一：去协议前缀、doi: 前缀、尾部标点，统一小写。
   *  ★ 运行时优先复用 CitationColumn.normalizeDOI（该模块 0.6.0 起就有这一份，
   *  再写一份迟早漂移）；这里在其基础上**补一步剥尾部标点**——因为从正文里
   *  抠出来的 DOI 常带句末标点（"…10.1/x."），不剥掉 Crossref 会 404。 */
  normDOI(doi) {
    let d;
    if (typeof CitationColumn !== "undefined" && CitationColumn && CitationColumn.normalizeDOI) {
      d = CitationColumn.normalizeDOI(doi);
    } else {
      d = String(doi || "").trim().toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
        .replace(/^doi:\s*/, "")
        .trim();
    }
    return String(d || "").replace(/[.,;:)\]}'"]+$/, "");
  },

  normTitle(title) {
    if (typeof CitationColumn !== "undefined" && CitationColumn && CitationColumn.normalizeTitle) {
      // CitationColumn 版会保留 HTML 标签，这里先剥一层再交给它
      return CitationColumn.normalizeTitle(String(title || "").replace(/<[^>]+>/g, ""));
    }
    return String(title || "")
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z]+;/g, "")
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  },

  /** arXiv 号归一：可接受 URL / "arXiv:2101.00001v2" / 裸号 */
  normArxiv(id) {
    const s = String(id || "").trim();
    const m = s.match(/(?:arxiv[:\s/]*)?((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?/i);
    return m ? m[1].toLowerCase() : "";
  },

  normPmid(id) {
    const m = String(id || "").match(/(\d{6,9})/);
    return m ? m[1] : "";
  },

  normIsbn(id) {
    return String(id || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  },

  /** 轻量编辑距离相似度（0-1）；用于标题模糊比对（拼写变体/副标题截断） */
  similarity(a, b) {
    const s1 = String(a || "");
    const s2 = String(b || "");
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;
    if (Math.abs(s1.length - s2.length) > Math.max(s1.length, s2.length) * 0.6) return 0;
    const m = s1.length, n = s2.length;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    return 1 - prev[n] / Math.max(m, n);
  },

  /** 标题一致判定：归一化相等，或（够长时）相似度 ≥ 阈值。
   *  ★ 加长度门槛：太短的标题（"Editorial"）相似度毫无区分度，容易误判同一条。 */
  titleMatch(t1, t2, thr) {
    const n1 = this.normTitle(t1);
    const n2 = this.normTitle(t2);
    if (!n1 || !n2) return false;
    if (n1 === n2) return true;
    if (n1.length < 12 || n2.length < 12) return false;
    // 一方是另一方的子串（副标题被截断）也算命中
    if (n1.length > 24 && (n1.indexOf(n2) >= 0 || n2.indexOf(n1) >= 0)) return true;
    return this.similarity(n1, n2) >= (thr == null ? 0.92 : thr);
  },

  /** 去重主键：有强标识符用强标识符，否则退回标题（仅在标题够长时） */
  recKey(rec) {
    if (!rec) return "";
    if (rec.doi) return "doi:" + this.normDOI(rec.doi);
    if (rec.pmid) return "pmid:" + this.normPmid(rec.pmid);
    if (rec.arxivId) return "arxiv:" + this.normArxiv(rec.arxivId);
    if (rec.isbn) return "isbn:" + this.normIsbn(rec.isbn);
    const t = this.normTitle(rec.title);
    return t && t.length >= 8 ? "t:" + t : "";
  },

  empty() {
    return {
      source: [], title: "", abstract: "", authors: [], year: null, date: "",
      container: "", volume: "", issue: "", pages: "", publisher: "", place: "",
      issn: "", isbn: "", doi: "", pmid: "", pmcid: "", arxivId: "", url: "",
      language: "", itemType: "journalArticle", citationCount: null,
      ai: false, confidence: "", score: 0, reasons: [], dup: null,
    };
  },

  /** 记录是否「空」（一篇文章都没抓到时不要把空记录塞进结果） */
  isBlank(rec) {
    if (!rec) return true;
    return !(rec.title || rec.doi || rec.pmid || rec.arxivId || rec.isbn);
  },

  /** 按 itemType 列出「应当有但缺失」的字段，供 AI 补全与 UI 提示使用 */
  gapFields(rec) {
    if (!rec) return [];
    const gaps = [];
    const need = (f) => { const v = rec[f]; return v == null || String(v).trim() === ""; };
    if (need("title")) gaps.push("title");
    if (!(rec.authors && rec.authors.length)) gaps.push("authors");
    if (need("year")) gaps.push("year");
    const t = rec.itemType || "journalArticle";
    if (t === "journalArticle" || t === "conferencePaper" || t === "bookSection") {
      if (need("container")) gaps.push("container");
    }
    if (t === "journalArticle") {
      if (need("volume")) gaps.push("volume");
      if (need("pages")) gaps.push("pages");
    }
    if (t === "journalArticle" || t === "conferencePaper") {
      if (need("pages")) gaps.push("pages");
    }
    // 三个强标识符全无 → 标出来（用户至少该知道这条只能靠标题匹配）
    if (need("doi") && need("pmid") && need("arxivId")) gaps.push("identifier");
    return gaps;
  },

  /* ================= 输入解析（用户粘贴的东西五花八门） ================= */

  /** 从任意文本里抽标识符；返回数组，按出现顺序，元素形如 {kind, value}
   *  kind: doi | pmid | pmcid | arxiv | isbn | url | title | bibtex */
  extractIdentifiers(text) {
    const raw = String(text == null ? "" : text);
    const out = [];
    const seen = new Set();
    const push = (kind, value) => {
      const v = String(value || "").trim();
      if (!v) return;
      const k = kind + "|" + v.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ kind, value: v });
    };

    if (!raw.trim()) return out;
    if (this.looksLikeBibtex(raw)) { push("bibtex", raw); return out; }

    // 先挖超链接（保留给「链接」入口；DOI 链接同时也会被 DOI 规则吃掉）
    // URL 尾部常跟句读（"见 https://x.com/a, 2021."），不剥掉会把标点带进字段
    for (const m of raw.match(/https?:\/\/[^\s<>"'）)】\]]+/gi) || []) push("url", m.replace(/[.,;:、，。；：]+$/, ""));

    for (const m of raw.match(/\b10\.\d{4,9}\/[^\s"'<>）)】\]]+/gi) || []) {
      push("doi", this.normDOI(m));
    }
    for (const m of raw.match(/\bPMC\d{6,8}\b/gi) || []) push("pmcid", m.toUpperCase());
    // PubMed URL / PMID: 前缀两种写法
    for (const m of raw.match(/pubmed(?:\.ncbi\.nlm\.nih\.gov)?\/(\d{6,9})/gi) || []) {
      const d = m.match(/(\d{6,9})/); if (d) push("pmid", d[1]);
    }
    for (const m of raw.match(/\bpmid[:\s#]*(\d{6,9})\b/gi) || []) {
      const d = m.match(/(\d{6,9})/); if (d) push("pmid", d[1]);
    }
    // arXiv：URL / arXiv: 前缀 / 裸号（裸号必须在有 arXiv 语境的串里才认，避免把年份当编号）
    for (const m of raw.match(/arxiv[:\s/]*((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?/gi) || []) {
      const id = this.normArxiv(m); if (id) push("arxiv", id);
    }
    for (const m of raw.match(/arxiv\.org\/(?:abs|pdf)\/([^\s"'<>）)】\]]+)/gi) || []) {
      const id = this.normArxiv(m); if (id) push("arxiv", id);
    }
    for (const m of raw.match(/\bISBN[:\s]*(97[89][\d-\s]{9,17}[\dXx])/gi) || []) {
      const d = m.match(/97[89][\d-\s]{9,17}[\dXx]/); if (d) push("isbn", this.normIsbn(d[0]));
    }

    // 上面什么都没挖到 → 把每一行当作「标题候选」（支持一次粘贴多行题录）
    if (!out.length) {
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*\d.)\s]+/, "").trim();
        if (t.length >= 4) push("title", t);
      }
    }
    return out;
  },

  looksLikeBibtex(text) {
    return /^\s*@[a-zA-Z]+\s*[{(]/.test(String(text || ""));
  },

  /**
   * 解析 BibTeX（够用为准：@type{key, field = {v} / "v" / 123, ...}）。
   * 支持 @string 变量与 # 拼接、括号嵌套、内部大括号保护（标题里的 {DNA} 不被截断）。
   * @returns {Array<rec>}
   */
  parseBibtex(text) {
    const src = String(text || "");
    const strings = {};
    const recs = [];
    let i = 0;
    while (i < src.length) {
      const at = src.indexOf("@", i);
      if (at < 0) break;
      const head = /^@([a-zA-Z]+)\s*([{(])/.exec(src.slice(at));
      if (!head) { i = at + 1; continue; }
      const type = head[1].toLowerCase();
      const open = head[2];
      const close = open === "{" ? "}" : ")";
      // 读到匹配的收尾括号（考虑嵌套与转义）
      let depth = 1;
      let j = at + head[0].length;
      let body = "";
      while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === "\\") { body += src[j + 1] || ""; j += 2; continue; }
        if (ch === open) depth++;
        else if (ch === close) { depth--; if (!depth) break; }
        body += ch;
        j++;
      }
      i = j + 1;
      if (type === "string") {
        const eq = body.indexOf("=");
        if (eq > 0) strings[body.slice(0, eq).trim().toLowerCase()] = this._bibValue(body.slice(eq + 1), strings);
        continue;
      }
      if (type === "comment" || type === "preamble") continue;
      recs.push(this._bibEntry(type, body, strings));
    }
    return recs;
  },

  /** 拆 "key, field = value, ..." 并取值 */
  _bibEntry(type, body, strings) {
    const rec = this.empty();
    const map = {};
    const comma = body.indexOf(",");
    const key = comma < 0 ? "" : body.slice(0, comma).trim();
    const rest = comma < 0 ? body : body.slice(comma + 1);
    // 逐字段：name = value（value 可能带 {} / "" / 数字 / 变量 + # 拼接）
    let k = 0;
    while (k < rest.length) {
      const eq = rest.indexOf("=", k);
      if (eq < 0) break;
      const name = rest.slice(k, eq).replace(/[,\s]+$/, "").trim().toLowerCase();
      let v = "";
      let p = eq + 1;
      let done = false;
      while (p < rest.length && !done) {
        while (p < rest.length && /\s/.test(rest[p])) p++;
        const ch = rest[p];
        if (ch === "{") {
          let d = 1; let s = "";
          p++;
          while (p < rest.length && d > 0) {
            if (rest[p] === "\\") { s += rest[p + 1] || ""; p += 2; continue; }
            if (rest[p] === "{") d++;
            else if (rest[p] === "}") { d--; if (!d) break; }
            s += rest[p]; p++;
          }
          p++;
          v += s;
        } else if (ch === '"') {
          p++;
          let s = "";
          while (p < rest.length && rest[p] !== '"') {
            if (rest[p] === "\\") { s += rest[p + 1] || ""; p += 2; continue; }
            if (rest[p] === "{") { // 引号内的大括号是保护层：原样保留内容
              let d = 1; p++;
              while (p < rest.length && d > 0) {
                if (rest[p] === "{") d++;
                else if (rest[p] === "}") { d--; if (!d) break; }
                s += rest[p]; p++;
              }
              continue;
            }
            s += rest[p]; p++;
          }
          p++;
          v += s;
        } else {
          let s = "";
          while (p < rest.length && !/[,#\s]/.test(rest[p])) { s += rest[p]; p++; }
          v += strings[s.trim().toLowerCase()] != null ? strings[s.trim().toLowerCase()] : s.trim();
        }
        while (p < rest.length && /\s/.test(rest[p])) p++;
        if (rest[p] === "#") { p++; continue; }
        // 逗号或结尾 → 本条结束
        if (rest[p] === ",") p++;
        done = true;
      }
      k = p;
      if (name) map[name] = this._cleanBibValue(v);
    }
    this._bibToRec(rec, type, map, key);
    return rec;
  },

  _bibValue(raw, strings) {
    const s = String(raw || "").trim().replace(/,$/, "").trim();
    if (s[0] === "{") return this._cleanBibValue(s.slice(1, -1));
    if (s[0] === '"') return this._cleanBibValue(s.slice(1, -1));
    return this._cleanBibValue(strings[s.toLowerCase()] != null ? strings[s.toLowerCase()] : s);
  },

  /** 去 BibTeX 的花括号保护层与常见转义（{\"o} / \& / -- 等） */
  _cleanBibValue(v) {
    let s = String(v == null ? "" : v);
    s = s.replace(/[{}]/g, "");
    s = s.replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\_/g, "_").replace(/\\\$/g, "$").replace(/#/g, "#");
    s = s.replace(/\\[`'^"~=.]\s*\{\\?([a-zA-Z])\}/g, "$1");
    s = s.replace(/\\"\{?([a-zA-Z])\}?/g, "$1").replace(/\\'\{?([a-zA-Z])\}?/g, "$1");
    s = s.replace(/\\`\{?([a-zA-Z])\}?/g, "$1").replace(/\\([a-zA-Z])\{?\}?/g, "$1");
    s = s.replace(/~+/g, " ").replace(/\s+/g, " ").trim();
    return s;
  },

  _bibToRec(rec, type, f, key) {
    rec.source = ["bibtex"];
    rec.title = f.title || "";
    rec.abstract = f.abstract || "";
    if (f.author) rec.authors = this.parseAuthorList(f.author);
    if (!rec.authors.length && f.editor) rec.authors = this.parseAuthorList(f.editor);
    rec.date = f.date || (f.year ? String(f.year) : "");
    rec.year = this.yearOf(rec.date);
    rec.container = f.journal || f.booktitle || f.journaltitle || f.series || "";
    rec.volume = f.volume || "";
    rec.issue = f.number || f.issue || "";
    rec.pages = String(f.pages || "").replace(/--+/g, "-");
    rec.publisher = f.publisher || f.institution || f.school || "";
    rec.place = f.address || f.location || "";
    rec.issn = f.issn || "";
    rec.isbn = f.isbn || "";
    rec.doi = this.normDOI(f.doi || "");
    rec.url = f.url || "";
    rec.language = f.language || "";
    rec.pmid = this.normPmid(f.pmid || "");
    if (f.eprint && /arxiv/i.test(f.archiveprefix || f.eprinttype || "")) rec.arxivId = this.normArxiv(f.eprint);
    rec.itemType = this.bibTypeToItemType(type);
    rec.confidence = "high";
    rec.reasons.push("bibtex:" + key);
    return rec;
  },

  bibTypeToItemType(type) {
    const t = String(type || "").toLowerCase();
    if (t === "article") return "journalArticle";
    if (t === "inproceedings" || t === "conference" || t === "proceedings" || t === "inbook") return "conferencePaper";
    if (t === "incollection") return "bookSection";
    if (t === "book" || t === "mvbook" || t === "manual") return "book";
    if (t === "phdthesis" || t === "mastersthesis" || t === "thesis") return "thesis";
    if (t === "techreport" || t === "report") return "report";
    if (t === "online" || t === "electronic") return "webpage";
    return "preprint";
  },

  itemTypeToBibType(itemType, rec) {
    const t = itemType || "journalArticle";
    if (t === "journalArticle") return "article";
    if (t === "conferencePaper") return "inproceedings";
    if (t === "bookSection") return "incollection";
    if (t === "book") return "book";
    if (t === "thesis") return "phdthesis";
    if (t === "report") return "techreport";
    if (t === "webpage") return "misc";
    if (t === "preprint") return "misc";
    // preprint 但带期刊信息（arXiv 已发表版本）→ 用 article 更规范
    if (rec && rec.container && rec.volume) return "article";
    return "misc";
  },

  /** "A and B and C" → [{family,given}]；支持 "Family, Given" / "Given Family" */
  parseAuthorList(list) {
    const out = [];
    for (const piece of String(list || "").split(/\s+and\s+/i)) {
      const name = piece.trim();
      if (!name) continue;
      const a = this.parseAuthor(name);
      if (a) out.push(a);
    }
    return out;
  },

  /** 单个人名 → {family, given, literal}
   *  - 含逗号：逗号前是姓（可能带 von 前缀），逗号后是名（可能还能再切出 Jr 后缀）
   *  - 无逗号：末 token 为姓
   *  - 纯 CJK / 单个 token / 含「等」「et al.」：退回 literal（不猜，避免把中文名切错） */
  parseAuthor(name) {
    const s = String(name || "").trim().replace(/\s+/g, " ");
    if (!s) return null;
    if (/^(et\s+al\.?|等)$/i.test(s)) return null;
    const hasCJK = /[\u4e00-\u9fff]/.test(s);
    if (hasCJK) return { family: "", given: "", literal: s };
    if (s.indexOf(",") >= 0) {
      const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
      const family = parts[0] || "";
      const given = parts[1] || "";
      return family ? { family, given, literal: "" } : { family: "", given: "", literal: s };
    }
    const toks = s.split(" ").filter(Boolean);
    if (toks.length === 1) return { family: toks[0], given: "", literal: "" };
    return { family: toks[toks.length - 1], given: toks.slice(0, -1).join(" "), literal: "" };
  },

  yearOf(dateOrYear) {
    const m = String(dateOrYear == null ? "" : dateOrYear).match(/(\d{4})/);
    return m ? Number(m[1]) : null;
  },

  /** 作者数组 → 显示串 */
  authorText(rec, max) {
    const list = (rec && rec.authors) || [];
    const names = list.map((a) => (a.literal ? a.literal : [a.given, a.family].filter(Boolean).join(" ").trim() || a.family));
    const n = max || names.length;
    return names.slice(0, n).join(", ") + (names.length > n ? " et al." : "");
  },

  /* ================= 合并与去重 ================= */

  /** 字段「有内容」判定 */
  _has(v) {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v).trim() !== "";
  },

  /**
   * 合并两条（同一文献来自不同源）的记录：**空缺才填**，绝不覆盖已有值。
   * @param {object} a 目标（优先级更高）
   * @param {object} b 供体
   * @returns {object} 新对象（不改入参）
   */
  mergeRecords(a, b) {
    const out = Object.assign({}, a);
    for (const f of ["title", "abstract", "container", "volume", "issue", "pages", "publisher",
      "place", "issn", "isbn", "doi", "pmid", "pmcid", "arxivId", "url", "language", "date"]) {
      if (!this._has(out[f]) && this._has(b[f])) out[f] = b[f];
    }
    if (!out.year && b.year) out.year = b.year;
    if (!this._has(out.authors) && this._has(b.authors)) out.authors = b.authors.slice();
    // itemType：以「更具体」的一方为准（preprint → journalArticle 是升级，反之不是）
    if (out.itemType === "preprint" && b.itemType && b.itemType !== "preprint") out.itemType = b.itemType;
    if (typeof out.citationCount !== "number" && typeof b.citationCount === "number") out.citationCount = b.citationCount;
    if (this._has(b.reasons)) out.reasons = [...new Set([].concat(out.reasons || [], b.reasons))];
    const srcs = new Set([].concat(out.source || [], b.source || []));
    out.source = [...srcs];
    return out;
  },

  /**
   * 批量去重：同一条（DOI/PMID/arXiv/ISBN 命中，或标题高相似）合并为一条。
   * @returns {{records:Array, merged:number}}
   */
  dedupeRecords(records) {
    const list = [];
    let merged = 0;
    for (const rec of records || []) {
      if (this.isBlank(rec)) continue;
      const strongKey = this.recKey(rec);
      let hit = -1;
      if (strongKey) hit = list.findIndex((x) => this.recKey(x) === strongKey);
      // 标题兜底：强标识符不同的同一篇（例如 arXiv 预印本与正式发表版）。
      // ★ 必须带长度门槛：社论/勘误之类标题（"Editorial"）在多篇之间重复，
      // 用它做键会把不相干的文献合并成一条。
      const nt = this.normTitle(rec.title);
      if (hit < 0 && nt && nt.length >= 8) {
        hit = list.findIndex((x) => {
          const nx = this.normTitle(x.title);
          return nx && nx.length >= 8 && this.titleMatch(x.title, rec.title);
        });
      }
      if (hit >= 0) {
        list[hit] = this.mergeRecords(list[hit], rec);
        merged++;
      } else {
        list.push(Object.assign({}, rec));
      }
    }
    return { records: list, merged };
  },

  /** 从「一行式题录」里抠标题（纯函数）。
   *  为什么需要它：三家源的参考文献条目大多只能拿到**整条字符串**
   *  （Crossref 的 `unstructured`、PDF 里的参考文献段、Europe PMC 的部分条目），
   *  而标题是判重与检索的唯一抓手——抠不出来这条文献就只能当噪声丢掉。
   *  实测样例（test/ref-import.test.js 逐条钉死）：
   *    "Abbott, B. P. et al. Observation of gravitational waves from a binary
   *     black hole merger. Phys. Rev. Lett. 116, 061102 (2016)."
   *      → Observation of gravitational waves from a binary black hole merger
   *    "Dubois, P. F., Hinsen, K. & Hugunin, J. Numerical Python. Comput. Phys. 10, 262–267 (1996)."
   *      → Numerical Python
   *    "张伟, 李娜. 抽动障碍的中医证候分布规律研究. 中医杂志, 2020, 61(3): 12-16."
   *      → 抽动障碍的中医证候分布规律研究
   *  返回 "" 表示抠不出可信标题（调用方应回落到原始串或丢弃，**不要瞎猜**）。 */
  titleFromUnstructured(s) {
    let t = String(s == null ? "" : s)
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ").trim();
    if (!t) return "";

    // 1) 切掉尾部的年份与随后的卷期页（(2016) / [2016] / , 2016.）
    t = t.replace(/[,\s]*[([［]\s*\d{4}[a-z]?\s*[)\]］]\s*\.?\s*$/, "").trim();
    t = t.replace(/[\s,，]*\d{4}[a-z]?\s*\.?\s*$/, "").trim();

    // 2) "et al." 之后就是标题 —— 最可靠的一种切法，先切掉（省得作者段混进分段）
    if (/\bet\s+al\.?\s/i.test(t)) t = t.replace(/^.*?\bet\s+al\.?\s+/i, "").trim();

    // 3) 按句末切段，逐段判定「像作者」还是「像标题」，取第一个像标题的。
    //    ★ 比「按正则剥作者前缀」稳：作者段的写法太多（倒装、缩写带点/不带点、
    //    单姓多缩写、& 或 and 连接…），而「标题段」的特征（词数、缩写占比、
    //    是否以逗号收尾）反而是稳定的——用正向特征筛选，不用穷举反向形态。
    const segs = t.split(/\.\s+|\.(?=[A-Z\u4e00-\u9fff])|\u3002\s*/).map((x) => x.replace(/[,，;；\s]+$/, "").trim()).filter(Boolean);
    const hit = segs.find((seg) => this._looksLikeTitle(seg));
    return hit ? hit.replace(/[.,;:]\s*$/, "").trim() : "";
  },

  /** 从「一行式题录」里抽作者（纯函数，保守策略：抽不出就返回空，绝不猜）。
   *  能拿到的形态（实测）：
   *    "Abbott, B. P. et al. …"                → [{family:Abbott, given:"B. P."}]
   *    "Pettitt J, Muller B, Stansfield I, …"  → 4 位（姓在前、缩写在后）
   *    "Dubois, P. F., Hinsen, K. & Hugunin, J. Numerical Python. …" → 3 位
   *    "张伟, 李娜. …"                          → 退化为 literal（中文不切姓） */
  authorsFromReferenceString(s, max) {
    const str = String(s || "").trim();
    if (!str) return [];
    const cap = max || 12;
    let head = "";
    const etAl = str.match(/^([\s\S]*?)\bet\s+al\.?/i);
    if (etAl) {
      head = etAl[1];
    } else {
      // 没有 et al.：作者段 = **第一个「像标题」的段之前**的全部内容。
      // ★ 不能用「第一段像作者就取第一段」——缩写自带点号（"Dubois, P. F." 就是一个段），
      //   那样会把多作者截成一位。定位标题段再往前切才稳。
      const segs = str.split(/\.\s+|\.(?=[A-Z\u4e00-\u9fff])|\u3002\s*/)
        .map((x) => x.replace(/[,，;；\s]+$/, "").trim()).filter(Boolean);
      const ti = segs.findIndex((seg) => this._looksLikeTitle(seg));
      if (ti > 0) head = segs.slice(0, ti).join(" ");
      else if (ti < 0) {
        // 整串就是作者段（调用方已把题名切走，例如 GB/T 7714 解析）——
        // 仅当它确实「像作者段」时才认，避免把一句标题当成人名。
        const cand = str.replace(/[.。\s]+$/, "").trim();
        if (this._looksLikeAuthors(cand) || /^[\u4e00-\u9fff]{2,4}(?:\s*[,，、]\s*[\u4e00-\u9fff]{2,4})*$/.test(cand)) head = cand;
      }
    }
    head = head.replace(/[\s,;&，、]+$/, "").trim();
    if (!head) return [];
    // 中文姓名列表（每段 2–4 汉字）→ 一律 literal，不做姓/名切分
    if (/^[\u4e00-\u9fff]{2,4}(?:\s*[,，、]\s*[\u4e00-\u9fff]{2,4})*$/.test(head)) {
      return head.split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, cap)
        .map((n) => ({ family: "", given: "", literal: n }));
    }
    // ★ 先按逗号/& 切块，再判断每块是「新作者」还是「上一位的缩写」。
    //   为什么不能直接按空白分词：PubMed/GB/T 形态是「姓 缩写, 姓 缩写」（块内是完整作者），
    //   而倒装形态是「姓, 缩写缩写, 姓, 缩写」（缩写自成一块）。两种混在同一个串里，
    //   只有保留逗号边界才能都认对——否则 "SMITH J, DOE A" 会被读成 SMITH 的名是 "J. DOE A."。
    const initOnly = (piece) => {
      const toks = piece.split(/\s+/).filter(Boolean);
      if (!toks.length || toks.length > 2) return false;
      return toks.every((t) => /^[A-Z]\.?$/.test(t)) || (toks.length === 1 && /^[A-Z]{2,3}$/.test(toks[0]));
    };
    const pieces = head.split(/\s*[,，;；]\s*|\s+&\s+|\s+and\s+/i)
      .map((x) => x.trim()).filter(Boolean)
      .filter((x) => !/^(?:and|et|al|jr|sr|ii|iii)$/i.test(x));
    const out = [];
    let pendingGiven = "";
    for (const piece of pieces) {
      if (out.length >= cap) break;
      if (/^\d/.test(piece)) continue;
      if (initOnly(piece)) {
        // 缩写块：并到上一位作者的名上；若还没有作者，先暂存（名在前形态）
        const g = piece.split(/\s+/).map((t) => (/^[A-Z]$/.test(t) ? t + "." : t)).join(" ");
        if (out.length) {
          const last = out[out.length - 1];
          last.given = (last.given ? last.given + " " : "") + g;
        } else {
          pendingGiven = (pendingGiven ? pendingGiven + " " : "") + g;
        }
        continue;
      }
      const a = this.parseAuthorCompact(piece);
      if (!a || !(a.family || a.literal)) continue;
      if (pendingGiven && !a.literal && !a.given) { a.given = pendingGiven; pendingGiven = ""; }
      out.push({ family: a.family || "", given: a.given || "", literal: a.literal || "" });
    }
    return out;
  },

  /** 段是否像「作者列表」（内部工具，纯函数） */
  _looksLikeAuthors(seg) {
    const raw = String(seg || "");
    if (!raw) return false;
    // 中文姓名列表：「张三, 李四, 王五」——每段 2–4 个汉字、以逗号/顿号分隔。
    // ★ 必须在这里挡住：中文作者段本身就是「多个 2–4 字短词」，很容易被当成标题
    //（「张三, 李四, 王五」归一化后 8 个字，长度门槛挡不住它）。
    const cjkPieces = raw.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    if (cjkPieces.length >= 2 && cjkPieces.every((p) => /^[\u4e00-\u9fff]{2,4}$/.test(p))) return true;
    const toks = raw.split(/\s+/).map((x) => x.replace(/^[,&.\s]+|[,&.\s]+$/g, "")).filter(Boolean);
    if (!toks.length) return false;
    let initials = 0;
    for (const x of toks) {
      if (/^(?:[A-Z]\.?|[A-Z]{2,3}|&|and|et|al)$/.test(x)) initials++;
    }
    if (/[,&]$/.test(raw)) initials++;                     // 以逗号/& 收尾 → 后面还有作者
    if (initials / toks.length >= 0.4) return true;
    // 「姓, 缩写」出现两处以上（倒装形态）
    if ((raw.match(/[A-Za-z\u00c0-\u024f'\u2019-]+\s*,\s*(?:[A-Z]\.?\s*){1,3}/g) || []).length >= 2) return true;
    return false;
  },

  /** 段是否像「标题」（内部工具，纯函数） */
  _looksLikeTitle(seg) {
    const s = String(seg || "").trim();
    if (!s) return false;
    const cjk = /[\u4e00-\u9fff]/.test(s);
    // 中文标题天然短（「抽动障碍的中医证候研究」11 字），门槛按语种分档
    const minLen = cjk ? 6 : 10;
    if (s.length < minLen) return false;
    if (/^\d/.test(s)) return false;                       // 卷期页/年份开头
    if (this._looksLikeAuthors(s)) return false;
    // 刊名缩写串（"Phys. Rev. Lett" → "Rev"/"Lett" 这类已被长度门槛挡掉，这里兜长缩写）
    if (!cjk && s.split(/\s+/).length <= 3 && /^[A-Z]/.test(s) && /[A-Z]\.\s*[A-Z]/.test(s)) return false;
    const norm = this.normTitle(s);
    if (norm.length < (cjk ? 6 : 8)) return false;
    return true;
  },

  /** 剥掉题录开头的作者段（内部工具，纯函数）——仅用于「et al.」这类无歧义形态 */
  _stripAuthorPrefix(t) {
    let out = String(t || "").trim();
    if (/\bet\s+al\.?\s/i.test(out)) out = out.replace(/^.*?\bet\s+al\.?\s+/i, "").trim();
    return out;
  },

  /** 紧凑人名（PubMed / Crossref 参考文献的写法）→ {family, given}
   *  两种顺序都要认：PubMed 是「姓 缩写」（van der Walt SJ），
   *  Crossref 的 reference.author 是「缩写 姓」（BP Abbott）——搞反会让整库作者倒过来。 */
  parseAuthorCompact(name) {
    const s = String(name || "").trim().replace(/[.,;]+$/, "").replace(/\s+/g, " ");
    if (!s) return null;
    if (/[\u4e00-\u9fff]/.test(s)) return { family: "", given: "", literal: s };
    const isInit = (x) => /^(?:[A-Z]\.?|[A-Z]{2,3})$/.test(x);
    const toks = s.split(" ").filter(Boolean);
    if (toks.length === 1) return { family: toks[0], given: "", literal: "" };
    // 名在前：首 token 是缩写、末 token 不是 → family = 末 token
    if (isInit(toks[0]) && !isInit(toks[toks.length - 1])) {
      return { family: toks[toks.length - 1], given: toks.slice(0, -1).join(" "), literal: "" };
    }
    // 姓在前：从尾部吃掉所有缩写 token
    let i = toks.length;
    while (i > 1 && isInit(toks[i - 1])) i--;
    if (i === toks.length) return this.parseAuthor(s); // 没有缩写可吃 → 交给通用人名解析
    return { family: toks.slice(0, i).join(" "), given: toks.slice(i).join(" "), literal: "" };
  },

  /** 逗号分隔的作者串 → 作者数组（Europe PMC 的 authorString 形态） */
  parseAuthorStringList(str, max) {
    const out = [];
    for (const piece of String(str || "").split(/\s*[,;]\s*/)) {
      const p = this.parseAuthorCompact(piece);
      if (p && (p.family || p.literal)) out.push(p);
      if (out.length >= (max || 50)) break;
    }
    return out;
  },

  /** 题录串里的年份（纯函数）。★ 不能直接用 yearOf：它匹配任意 4 位数字，
   *  "…Phys. Rev. Lett. 116, 061102 (2016)." 会先命中 "061102" 里的 "0611" → 年份变成 611。
   *  这里要求 ① 优先取括号里的；② 否则取**被非数字包夹**且落在 1500–2099 的 4 位数。 */
  yearFromReference(s) {
    const str = String(s || "");
    const ok = (y) => y >= 1500 && y <= 2099;
    // 括号优先，但**必须落年份区间**——"…Nature, 2017, 550(7676): …" 里 "(7676)" 是期号，
    // 不校验区间就会把年份写成 7676（实踩）。
    const inParen = str.match(/[([［]\s*(\d{4})[a-z]?\s*[)\]］]/g) || [];
    for (const p of inParen) {
      const y = Number((p.match(/\d{4}/) || [""])[0]);
      if (ok(y)) return y;
    }
    const m = str.match(/(?:^|[^\d])((?:1[5-9]|20)\d{2})(?![\d])/);
    return m && ok(Number(m[1])) ? Number(m[1]) : null;
  },

  /* ================= 参考文献段（PDF 文本）解析 ================= */

  BIB_HEADING: /^\s*(?:\d{1,2}\s*[.、]?\s*)?(?:references|reference|bibliography|literature\s+cited|works\s+cited|参考文献|引用文献|主要参考文献|文献)\s*[:：]?\s*$/i,
  BIB_STOP: /^\s*(?:\d{1,2}\s*[.、]?\s*)?(?:appendix|appendices|supplementary(?:\s+material)?|acknowledg(?:e?ments?|ements?)|author\s+contributions?|conflicts?\s+of\s+interest|致\s*谢|附\s*录|附录|补充材料|作者贡献|利益冲突)\s*[:：]?\s*$/i,

  /** 从整篇文本里切出参考文献段。返回 {heading, text, index} 或 null。
   *  取**最后**一个标题（有些排版在正文里也会出现 "References" 小标题）。 */
  splitBibliography(fullText) {
    const text = String(fullText || "");
    if (!text) return null;
    const lines = text.split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (this.BIB_HEADING.test(lines[i])) start = i;
    }
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (this.BIB_STOP.test(lines[i])) { end = i; break; }
    }
    const body = lines.slice(start + 1, end).join("\n").trim();
    if (!body) return null;
    return { heading: lines[start].trim(), text: body, index: start };
  },

  /** 参考文献段 → 条目数组（纯函数）。
   *  切分策略按「有编号 → 按编号；无编号 → 一行一条（把续行并回上一条）」。 */
  splitBibliographyEntries(section) {
    const text = String(section || "").trim();
    if (!text) return [];
    // ① 编号式：[12] / 12. / 12) / 12、
    const numbered = text.split(/(?:^|\n)\s*(?:\[(\d{1,3})\]|(\d{1,3})\s*[.)、])\s+/);
    if ((text.match(/(?:^|\n)\s*(?:\[\d{1,3}\]|\d{1,3}\s*[.)、])\s+/g) || []).length >= 3) {
      const out = [];
      for (let i = 1; i < numbered.length; i += 3) {
        const body = numbered[i + 2] || "";
        const v = body.replace(/\s*\n\s*/g, " ").trim();
        if (v.length >= 12) out.push(v);
      }
      if (out.length >= 3) return out;
    }
    // ② 一行一条；把「以大写/中文续写」的续行并回上一条
    const out = [];
    let cur = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, "").trim();
      if (!line) continue;
      if (!cur) { cur = line; continue; }
      // 续行特征：行首是小写字母或标点，或上一行没有句末标点
      const continues = /^[a-z(（]/.test(line) || !/[.。;；]$/.test(cur);
      if (continues && line.length < 120) cur += " " + line;
      else { if (cur.length >= 12) out.push(cur); cur = line; }
    }
    if (cur.length >= 12) out.push(cur);
    return out;
  },

  /** 参考文献条目文本数组 → 规范记录（能抽到 DOI/PMID/arXiv 就用标识符，否则尽力抽标题） */
  recordsFromBibliographyEntries(entries, opts) {
    const o = opts || {};
    const out = [];
    const seen = new Set();
    for (const raw of entries || []) {
      const s = String(raw || "").trim();
      if (!s) continue;
      const ids = this.extractIdentifiers(s);
      let rec = null;
      // ① 带 GB/T 7714 类型码（[J]/[M]/[D]…）的中文题录走专用解析 —— 类型、卷期页、
      //    出版社都能拿到，比通用「抠标题」准得多。这正是用户从知网复制参考文献的形态。
      if (this.gbtTypeCode(s)) {
        rec = this.parseChineseReference(s);
        // ★ 格式是 GB/T，但**来源**由调用方决定（知网/PDF/粘贴）——混用会让「来源」徽章说错话
        if (rec && o.source) { rec.source = [o.source]; rec.reasons = [o.reason || "GB/T 7714 题录"]; }
      }
      // ② 否则走通用题录解析
      if (!rec) {
        rec = this.empty();
        rec.source = [o.source || "pdf"];
        rec.reasons = [o.reason || "PDF 参考文献段"];
        rec.confidence = "low";
      }
      const hard = ids.filter((x) => x.kind !== "title" && x.kind !== "url");
      for (const x of hard) {
        if (x.kind === "doi" && !rec.doi) rec.doi = this.normDOI(x.value);
        else if (x.kind === "pmid" && !rec.pmid) rec.pmid = this.normPmid(x.value);
        else if (x.kind === "pmcid" && !rec.pmcid) rec.pmcid = x.value.toUpperCase();
        else if (x.kind === "arxiv" && !rec.arxivId) rec.arxivId = this.normArxiv(x.value);
        else if (x.kind === "isbn" && !rec.isbn) rec.isbn = this.normIsbn(x.value);
      }
      if (!rec.title) {
        const title = this.titleFromUnstructured(s);
        if (title) rec.title = title;
        else if (!rec.doi && !rec.pmid && !rec.arxivId) continue; // 既无标识符又抽不出标题 → 丢弃（不制造噪声）
      }
      if (!rec.year) {
        rec.year = this.yearFromReference(s);
        if (rec.year) rec.date = rec.date || String(rec.year);
      }
      if (!rec.title) rec.title = String(s).slice(0, 200); // 有标识符时用原文兜底展示
      rec.raw = rec.raw || s;
      const key = this.recKey(rec) || this.normTitle(rec.title);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(rec);
    }
    return out;
  },

  /* ================= 中文题录（GB/T 7714）================= */

  /** 文献类型标识 → Zotero 条目类型。
   *  知网/万方「参考文献」列表复制出来的就是这套格式，类型码是**最可靠的类型判据**
   *  （比按刊名猜类型准得多）。 */
  GBT_TYPES: {
    J: "journalArticle", M: "book", C: "conferencePaper", G: "document",
    D: "thesis", R: "report", S: "report", N: "newspaperArticle",
    P: "patent", DB: "dataset", CP: "conferencePaper", EB: "webpage",
    A: "journalArticle", Z: "document",
  },

  /** GB/T 7714 类型码（[J] / [J/OL] / [EB/OL] / [M] …）；找不到返回 null */
  gbtTypeCode(s) {
    const m = String(s || "").match(/\[\s*([A-Z]{1,3})\s*(?:\/\s*([A-Z]{2})\s*)?\]/);
    return m ? { code: m[1].toUpperCase(), carrier: (m[2] || "").toUpperCase(), index: m.index, raw: m[0] } : null;
  },

  /**
   * 解析一条 GB/T 7714 题录（中文参考文献列表的单条）。
   * 形如（实测/标准样例）：
   *   [1] 张伟, 李娜. 抽动障碍的中医证候分布规律研究[J]. 中医杂志, 2020, 61(3): 12-16.
   *   [2] 陈明. 小儿抽动障碍辨治经验[J/OL]. 中医杂志, 2018, 59(4): 300-303.
   *   [3] 王五. 中医儿科学[M]. 北京: 人民卫生出版社, 2015: 88-90.
   *   [4] 李四. 抽动障碍中医证候研究[D]. 北京: 北京中医药大学, 2019.
   *   [5] SMITH J, DOE A. Attention is all you need[J]. Nature, 2017, 550(7676): 354-358.
   *   [6] 国家中医药管理局. 中医儿科临床诊疗指南·儿童多动症(修订)[S]. 2020.
   * 返回 rec 或 null（不是 GBT 格式就别用它，交给通用题录解析）。
   */
  parseChineseReference(s) {
    let text = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    // 去序号：[1] / 1. / １.
    text = text.replace(/^\s*[\[［【]?\s*\d{1,4}\s*[\]］】]?\s*[.、]?\s*/, "").trim();
    const t = this.gbtTypeCode(text);
    if (!t) return null;
    const code = /^(EB|DB|CP)$/.test(t.code) ? (t.code === "EB" ? "EB" : t.code) : t.code;
    const before = text.slice(0, t.index).trim();
    const after = text.slice(t.index + t.raw.length).replace(/^[.。:：\s]+/, "").trim();
    if (!before) return null;

    const rec = this.empty();
    rec.source = ["gbt"];
    rec.reasons = ["GB/T 7714 题录"];
    rec.confidence = "medium";
    rec.itemType = this.GBT_TYPES[code] || "journalArticle";
    rec.raw = String(s || "").trim();

    // 题名切分：取**最后一个「句点 + 空白」**处切开，右侧即题名（左侧是作者段）。
    // ★ 必须要求句点后跟空白：缩写like "U.S. economy" 的句点后面没有空白，
    //   按任意句点切会把英文标题切碎（实踩）；中文题录始终是「姓名. 题名」带空格。
    let title = "", authorsText = "";
    const cuts = [];
    for (let i = 0; i < before.length - 1; i++) {
      if ((before[i] === "." || before[i] === "。") && /\s/.test(before[i + 1])) cuts.push(i);
    }
    for (const i of cuts.reverse()) {
      const rest = before.slice(i + 1).trim();
      if (rest.length >= 4) { title = rest; authorsText = before.slice(0, i).trim(); break; }
    }
    if (!title) { title = before.trim(); authorsText = ""; }
    rec.title = title.replace(/[.,;:，。；：]\s*$/, "").trim();
    if (authorsText) rec.authors = this.authorsFromReferenceString(authorsText, 20);

    // 出处：年份 / 卷(期) / 页码 / 刊名或出版社
    const src = this.parseGBTSource(after, rec.itemType);
    rec.container = src.container;
    rec.volume = src.volume;
    rec.issue = src.issue;
    rec.pages = src.pages;
    rec.publisher = src.publisher;
    rec.place = src.place;
    rec.year = src.year;
    if (rec.year) rec.date = rec.date || String(rec.year);
    // 文中自带的 DOI/URL 顺手取出来（"…[J]. 期刊, 2020. DOI:10.1/x." 这种）
    const ids = this.extractIdentifiers(after + " " + before);
    for (const x of ids) {
      if (x.kind === "doi" && !rec.doi) rec.doi = this.normDOI(x.value);
      else if (x.kind === "pmid" && !rec.pmid) rec.pmid = this.normPmid(x.value);
      else if (x.kind === "arxiv" && !rec.arxivId) rec.arxivId = this.normArxiv(x.value);
      else if (x.kind === "url" && !rec.url) rec.url = x.value;
    }
    if (rec.itemType === "journalArticle" && !rec.container && !rec.volume && !rec.pages && !rec.doi) {
      rec.confidence = "low";
    }
    return this.isBlank(rec) ? null : rec;
  },

  /** GB/T 7714 的「出处」段 → {container, volume, issue, pages, publisher, place, year} */
  parseGBTSource(after, itemType) {
    const out = { container: "", volume: "", issue: "", pages: "", publisher: "", place: "", year: null };
    let s = String(after || "").replace(/[.。]\s*$/, "").trim();
    if (!s) return out;
    // 去掉尾部的中图分类号/文献标识等尾巴
    s = s.replace(/\s*(?:DOI|doi)\s*[:：]\s*10\.[^\s]*/, (m) => " " + m).trim();
    out.year = this.yearFromReference(s);
    // 页码：最后一个冒号后的数字串（"12-16" / "88-90" / "e12345"）
    const pm = s.match(/[:：]\s*([A-Za-z]?\d+(?:\s*[-–—~]\s*\d+)?)\s*$/);
    if (pm) out.pages = pm[1].replace(/\s*[-–—~]\s*/, "-");
    // 卷(期) / (期)
    const vi = s.match(/(\d+)\s*[（(]\s*(\d+)\s*[）)]/);
    const ionly = s.match(/[（(]\s*(\d+)\s*[）)]/);
    if (vi) { out.volume = vi[1]; out.issue = vi[2]; }
    else if (ionly) out.issue = ionly[1];
    // 按 ", " / "：" 切段：[刊名/地点, 出版社, 年, 卷(期): 页]
    const parts = s.split(/[,，]/).map((x) => x.replace(/[.。]\s*$/, "").trim()).filter(Boolean);
    if (itemType === "book" || itemType === "thesis" || itemType === "report") {
      // "北京: 人民卫生出版社, 2015: 88-90" → 地点: 出版社
      const first = parts[0] || "";
      const colon = first.split(/[:：]/);
      if (colon.length >= 2) {
        out.place = colon[0].trim();
        out.publisher = colon.slice(1).join(":").replace(/\s*[:：]\s*[\d-]*\s*$/, "").trim();
      } else {
        out.publisher = first;
      }
      const rest = parts.slice(1).join(" ");
      const rest2 = rest.split(/[:：]/)[0] || "";
      if (!out.publisher && rest2) out.publisher = rest2.replace(/\d{4}.*$/, "").trim();
      // 去掉误并进来的年份/页码
      out.publisher = out.publisher.replace(/\s*\d{4}\s*.*$/, "").replace(/\s*[:：]\s*[\d-]+\s*$/, "").trim();
    } else {
      out.container = (parts[0] || "").replace(/\s*[:：]\s*[\d-]+\s*$/, "").trim();
      // 刊名里带年份的情况（"中医杂志 2020 年第 61 卷" 之类）→ 剥掉尾部数字
      out.container = out.container.replace(/\s+\d{4}\s*$/, "").trim();
    }
    return out;
  },

  /* ================= 导出：BibTeX / RIS(EndNote) / CSL-JSON / EndNote XML ================= */

  /** BibTeX 特殊字符转义（含 LaTeX 保留字与 & % _ #） */
  bibEscape(s) {
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\textbackslash{}")
      .replace(/([&%$#_])/g, "\\$1")
      .replace(/\^/g, "\\^{}")
      .replace(/~/g, "\\~{}");
  },

  /** 引用键：姓氏 + 年份 + 标题首词（去重后加 a/b/c 后缀由 toBibtexAll 保证唯一） */
  bibKey(rec) {
    const first = (rec.authors && rec.authors[0]) || null;
    let fam = first ? (first.family || first.literal || "") : "";
    fam = fam.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "");
    const year = rec.year || (rec.date || "").slice(0, 4) || "";
    const words = String(rec.title || "").replace(/[^A-Za-z0-9\u4e00-\u9fff\s]/g, " ").split(/\s+/).filter((w) => w.length > 3);
    const w = words[0] || "";
    const key = (fam || "ref") + (year ? String(year) : "") + (w ? w[0].toUpperCase() + w.slice(1) : "");
    return key.slice(0, 60) || "ref";
  },

  /** 单条 → BibTeX 条目文本 */
  toBibtexEntry(rec, key) {
    const btype = this.itemTypeToBibType(rec.itemType, rec);
    const f = [];
    const put = (k, v) => { if (this._has(v)) f.push("  " + k + " = {" + this.bibEscape(v) + "}"); };
    put("title", rec.title);
    if (this._has(rec.authors)) {
      const names = rec.authors.map((a) => (a.literal ? a.literal : [a.family, a.given].filter(Boolean).join(", ")));
      put("author", names.join(" and "));
    }
    if (btype === "article") put("journal", rec.container);
    if (btype === "inproceedings" || btype === "incollection") put("booktitle", rec.container);
    if (btype === "techreport") put("institution", rec.publisher || rec.container);
    if (btype === "phdthesis") put("school", rec.publisher || rec.container);
    if (btype === "book") put("publisher", rec.publisher);
    if (btype === "book" || btype === "incollection") put("publisher", rec.publisher);
    if (btype === "book" || btype === "incollection" || btype === "inproceedings") put("address", rec.place);
    put("volume", rec.volume);
    put("number", rec.issue);
    put("pages", rec.pages);
    put("year", rec.year || (String(rec.date || "").match(/\d{4}/) || [""])[0]);
    put("doi", rec.doi);
    put("issn", rec.issn);
    put("isbn", rec.isbn);
    put("abstract", rec.abstract);
    put("url", rec.url);
    put("language", rec.language);
    if (rec.arxivId) {
      put("eprint", rec.arxivId);
      put("archivePrefix", "arXiv");
    }
    return "@" + btype + "{" + key + ",\n" + f.join(",\n") + "\n}\n";
  },

  /** 多条 → 完整 .bib 文本（键自动去重加后缀） */
  toBibtex(records) {
    const used = new Set();
    const out = [];
    for (const rec of records || []) {
      if (this.isBlank(rec)) continue;
      let key = this.bibKey(rec);
      let k = key;
      let n = 1;
      while (used.has(k.toLowerCase())) { k = key + String.fromCharCode(96 + n); n++; }
      used.add(k.toLowerCase());
      out.push(this.toBibtexEntry(rec, k));
    }
    return out.join("\n");
  },

  RIS_TYPES: {
    journalArticle: "JOUR", conferencePaper: "CPAPER", bookSection: "CHAP",
    book: "BOOK", thesis: "THES", report: "RPRT", webpage: "ELEC", preprint: "UNPB",
  },

  /** 单条 → RIS（EndNote / NoteExpress / RefWorks 通吃的交换格式） */
  toRISEntry(rec) {
    const L = [];
    const p = (tag, v) => { if (this._has(v)) L.push(tag + "  - " + v); };
    p("TY", this.RIS_TYPES[rec.itemType] || "GEN");
    p("TI", rec.title);
    if (this._has(rec.authors)) {
      for (const a of rec.authors) {
        const name = a.literal ? a.literal : (a.family ? a.family + (a.given ? ", " + a.given : "") : a.given);
        p("AU", name);
      }
    }
    p("T2", rec.container);            // 期刊/会议名（RIS 2.0 别名 JO/JF）
    p("JO", rec.itemType === "journalArticle" ? rec.container : "");
    p("VL", rec.volume);
    p("IS", rec.issue);
    // 页码：RIS 用 SP/EP，也要给 PY
    if (this._has(rec.pages)) {
      const m = String(rec.pages).match(/^\s*([A-Za-z]?\d+)\s*[-–—]\s*([A-Za-z]?\d+)\s*$/);
      if (m) { p("SP", m[1]); p("EP", m[2]); } else p("SP", rec.pages);
    }
    p("PB", rec.publisher);
    p("CY", rec.place);
    p("PY", rec.year || (String(rec.date || "").match(/\d{4}/) || [""])[0]);
    p("DA", rec.date);
    p("DO", rec.doi);
    p("SN", rec.issn || rec.isbn);
    p("UR", rec.url || (rec.doi ? "https://doi.org/" + rec.doi : ""));
    p("AB", rec.abstract);
    p("LA", rec.language);
    if (rec.pmid) L.push("AN  - PMID:" + rec.pmid);
    L.push("ER  - ");
    return L.join("\n") + "\n";
  },

  toRIS(records) {
    return (records || []).filter((r) => !this.isBlank(r)).map((r) => this.toRISEntry(r)).join("\n");
  },

  ENDNOTE_TYPES: {
    journalArticle: ["Journal Article", 17], conferencePaper: ["Conference Paper", 10],
    bookSection: ["Book Section", 5], book: ["Book", 6], thesis: ["Thesis", 32],
    report: ["Report", 27], webpage: ["Web Page", 12], preprint: ["Electronic Article", 43],
  },

  xmlEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  /** EndNote XML（.xml，EndNote / NoteExpress 可直接导入） */
  toEndNoteXML(records) {
    const list = (records || []).filter((r) => !this.isBlank(r));
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<xml>\n<records>\n';
    list.forEach((rec, i) => {
      const [typeName, typeCode] = this.ENDNOTE_TYPES[rec.itemType] || ["Generic", 13];
      xml += "  <record>\n";
      xml += "    <rec-number>" + (i + 1) + "</rec-number>\n";
      xml += '    <ref-type name="' + this.xmlEscape(typeName) + '">' + typeCode + "</ref-type>\n";
      if (this._has(rec.authors)) {
        xml += "    <contributors>\n      <authors>\n";
        for (const a of rec.authors) {
          const name = a.literal ? a.literal : (a.family ? a.family + (a.given ? ", " + a.given : "") : a.given);
          xml += "        <author>" + this.xmlEscape(name) + "</author>\n";
        }
        xml += "      </authors>\n    </contributors>\n";
      }
      xml += "    <titles>\n      <title>" + this.xmlEscape(rec.title) + "</title>\n";
      if (this._has(rec.container)) xml += "      <secondary-title>" + this.xmlEscape(rec.container) + "</secondary-title>\n";
      xml += "    </titles>\n";
      if (this._has(rec.container)) {
        xml += "    <periodical>\n      <full-title>" + this.xmlEscape(rec.container) + "</full-title>\n    </periodical>\n";
      }
      if (this._has(rec.pages)) xml += "    <pages>" + this.xmlEscape(rec.pages) + "</pages>\n";
      if (this._has(rec.volume)) xml += "    <volume>" + this.xmlEscape(rec.volume) + "</volume>\n";
      if (this._has(rec.issue)) xml += "    <number>" + this.xmlEscape(rec.issue) + "</number>\n";
      if (this._has(rec.publisher)) xml += "    <publisher>" + this.xmlEscape(rec.publisher) + "</publisher>\n";
      if (this._has(rec.place)) xml += "    <pub-location>" + this.xmlEscape(rec.place) + "</pub-location>\n";
      if (rec.year || rec.date) {
        xml += "    <dates>\n      <year>" + this.xmlEscape(String(rec.year || rec.date)) + "</year>\n    </dates>\n";
      }
      if (this._has(rec.isbn)) xml += "    <isbn>" + this.xmlEscape(rec.isbn) + "</isbn>\n";
      if (this._has(rec.issn)) xml += "    <issn>" + this.xmlEscape(rec.issn) + "</issn>\n";
      if (this._has(rec.doi)) xml += "    <electronic-resource-num>" + this.xmlEscape(rec.doi) + "</electronic-resource-num>\n";
      if (this._has(rec.url)) xml += "    <urls>\n      <related-urls>\n        <url>" + this.xmlEscape(rec.url) + "</url>\n      </related-urls>\n    </urls>\n";
      if (this._has(rec.abstract)) xml += "    <abstract>" + this.xmlEscape(rec.abstract) + "</abstract>\n";
      if (this._has(rec.language)) xml += "    <language>" + this.xmlEscape(rec.language) + "</language>\n";
      xml += "  </record>\n";
    });
    xml += "</records>\n</xml>\n";
    return xml;
  },

  /** CSL-JSON（Zotero/Pandoc/Zotero 内置导入器都吃） */
  toCSL(rec) {
    const CSL_TYPES = {
      journalArticle: "article-journal", conferencePaper: "paper-conference",
      bookSection: "chapter", book: "book", thesis: "thesis",
      report: "report", webpage: "webpage", preprint: "article",
    };
    const o = {
      id: this.bibKey(rec),
      type: CSL_TYPES[rec.itemType] || "article",
      title: rec.title || "",
    };
    if (this._has(rec.authors)) {
      o.author = rec.authors.map((a) => (a.literal ? { literal: a.literal } : { family: a.family || "", given: a.given || "" }));
    }
    if (rec.container) o["container-title"] = rec.container;
    if (rec.volume) o.volume = rec.volume;
    if (rec.issue) o.issue = rec.issue;
    if (rec.pages) o.page = rec.pages;
    if (rec.publisher) o.publisher = rec.publisher;
    if (rec.place) o["publisher-place"] = rec.place;
    if (rec.doi) o.DOI = rec.doi;
    if (rec.issn) o.ISSN = rec.issn;
    if (rec.isbn) o.ISBN = rec.isbn;
    if (rec.url) o.URL = rec.url;
    if (rec.abstract) o.abstract = rec.abstract;
    if (rec.language) o.language = rec.language;
    if (rec.year || rec.date) o.issued = { "date-parts": [[rec.year || Number(String(rec.date).slice(0, 4))]] };
    if (rec.pmid) o.PMID = rec.pmid;
    return o;
  },

  toCSLAll(records) {
    return JSON.stringify((records || []).filter((r) => !this.isBlank(r)).map((r) => this.toCSL(r)), null, 2);
  },

  /** 统一导出入口（UI 与测试共用单一真源） */
  exportAs(records, format) {
    const f = String(format || "bibtex").toLowerCase();
    if (f === "ris" || f === "endnote" || f === "enw") return this.toRIS(records);
    if (f === "endnote-xml" || f === "endnotexml" || f === "xml") return this.toEndNoteXML(records);
    if (f === "csl" || f === "csl-json" || f === "json") return this.toCSLAll(records);
    return this.toBibtex(records);
  },

  /* ================= 源类型 → Zotero 条目类型 ================= */

  /** 各源返回的原始类型串 → Zotero 条目类型名 */
  itemTypeFromSource(kind, raw) {
    const t = String(raw || "").toLowerCase();
    if (!t) return "journalArticle";
    if (kind === "crossref" || kind === "openalex" || kind === "datacite") {
      if (t.indexOf("proceedings") >= 0 || t.indexOf("paper-conference") >= 0) return "conferencePaper";
      if (t.indexOf("book-chapter") >= 0 || t.indexOf("chapter") >= 0) return "bookSection";
      if (t.indexOf("book") >= 0 || t === "monograph") return "book";
      if (t.indexOf("posted-content") >= 0 || t.indexOf("preprint") >= 0) return "preprint";
      if (t.indexOf("report") >= 0 || t.indexOf("standard") >= 0) return "report";
      if (t.indexOf("dissertation") >= 0 || t.indexOf("thesis") >= 0) return "thesis";
      if (t.indexOf("dataset") >= 0 || t.indexOf("component") >= 0) return "document";
      return "journalArticle";
    }
    if (kind === "pubmed") {
      // esummary 的 pubtype 数组：Journal Article / Review / Retracted Publication ...
      if (/book|chapter/.test(t)) return "bookSection";
      if (/editorial|news|comment/.test(t)) return "journalArticle";
      return "journalArticle";
    }
    if (kind === "arxiv") return "preprint";
    if (kind === "s2") {
      if (/conference|workshop|proceedings/.test(t)) return "conferencePaper";
      if (/book/.test(t)) return "book";
      if (/journal|review/.test(t)) return "journalArticle";
      return "journalArticle";
    }
    return "journalArticle";
  },
};
