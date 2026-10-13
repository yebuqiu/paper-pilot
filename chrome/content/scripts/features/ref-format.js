/* PaperPilot 参考文献格式层（纯函数，0.33.0 新增）
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
    for (const m of raw.match(/https?:\/\/[^\s<>"'）)】\]]+/gi) || []) push("url", m);

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
