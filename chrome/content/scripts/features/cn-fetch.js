/* PaperPilot 中文元数据网络抓取（0.14.5，茉莉花「抓取期刊元数据」同等能力）
 * 适用场景：拖入 Zotero 的知网/万方中文 PDF 只有文件名、没有元数据。
 * 流程：文件名/标题 → 搜索链 → 选中匹配 → 回填完整元数据（保留原附件）。
 *
 * 搜索链（早期命中即停）：
 *   1. PubScholar 中科院公益学术平台——开放 JSON API、无验证码、覆盖知网/万方/维普，
 *      含摘要/DOI/关键词，为首选源（移植自 jasminum pubscholar.ts，签名算法同源）
 *   2. CNKI 知网直接搜索——命中率高但会触发风控：403 滑块 或 200 no-content 软拦；
 *      被拦时由 CNVerify 引导用户过验证（0.14.8 起自动续抓；0.14.9 手动确认按钮/5 分钟缓存/会话去重）
 *
 * 保护策略：仅在条目元数据不完整（标题=文件名 或 缺作者/期刊）时回填；
 * 字段级保护——已有值的字段（除标题=文件名场景）一律不覆盖。
 *
 * 0.42.0 AI 增强四层（docs/jasminum-cnki-analysis-and-ai-proposal.md 落地，P1-P3）：
 *   L1 检索词规划（CNAI.plan）——多候选检索式替代单式启发式，AI 不可用回退旧行为；
 *   L3 语义裁决（CNAI.judge/decide）——置信度分档：自动采用/带理由置顶/人工/全否决；
 *   L4 元数据融合（GetExport EndNote 通道 + CNAI.fuseMeta）——数据库为准、其余只填空；
 *   P3 兜底（CNAI.recognize/rescue）——检索全灭时 AI 直读 PDF（标 unverified）；
 *      CNKI 结构改版时 LLM 从 HTML 提取结果行；PDF 直链兼容 oversea #pdfDown 锚点。
 * 协议层（签名/Cookie/检索参数）仍是确定性代码，LLM 不碰。
 */
/* global Zotero, Services, Components, IOUtils, PathUtils, Prefs, I18n, ItemSel, CNMeta, _ppDiag */

var CNFetch = {
  _diag(msg) {
    try { _ppDiag("cn-fetch: " + msg); } catch (e) { /* ignore */ }
  },

  // ================= 文本处理 =================

  _normalizeTitle(t) {
    return String(t || "")
      .replace(/\.{2,}|…+/g, " ")
      .replace(/[_＿]+/g, " ")
      .replace(/[《》“”"':：,，.。;；()[\]（）【】<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  _compact(t) {
    return this._normalizeTitle(t).replace(/\s+/g, "");
  },

  /** 标题匹配：忽略空白/标点后相等或互相包含 */
  _isTitleMatch(a, b) {
    const ca = this._compact(String(a || "").replace(/<[^>]+>/g, ""));
    const cb = this._compact(b);
    if (!ca || !cb) return false;
    return ca === cb || ca.includes(cb) || cb.includes(ca);
  },

  _escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  },

  /** 构建候选查询（从精确到宽泛，去重最多 4 条） */
  _buildQueries(title, author) {
    let t = this._normalizeTitle(title);
    if (author) t = this._normalizeTitle(t.replace(new RegExp(this._escapeRe(author), "g"), " "));
    const tokens = t.replace(/的/g, " ").split(/\s+/).filter(Boolean);
    const qs = [];
    if (t) qs.push(t);
    if (tokens.length >= 2) {
      qs.push(tokens.join(" "));
      qs.push([tokens[0], tokens[tokens.length - 1]].join(" "));
    }
    return [...new Set(qs)].slice(0, 4);
  },

  // ================= PubScholar 源 =================

  _PS_URL: "https://pubscholar.cn/hky/open/resources/api/v1/articles",
  _PS_SECRET: "6m6pingbinwaktg227gngifoocrfbo95", // jasminum 逆向签名密钥（同源轮换会整体失效）

  _randToken(n) {
    let v = "";
    while (v.length < n) v += Math.random().toString(36).slice(2).toUpperCase();
    return v.slice(0, n);
  },

  _randHex(n) {
    let v = "";
    while (v.length < n) v += Math.floor(Math.random() * 16).toString(16);
    return v;
  },

  _rotl(v, b) { return (v << b) | (v >>> (32 - b)); },

  // 手写 SHA-1（FIPS 180-1）：Zotero 插件环境 crypto.subtle 受限，与 jasminum 同实现
  _sha1(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    for (let i = 3; i >= 0; i--) bytes.push((hi >>> (i * 8)) & 0xff);
    for (let i = 3; i >= 0; i--) bytes.push((lo >>> (i * 8)) & 0xff);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    for (let i = 0; i < bytes.length; i += 64) {
      const w = new Array(80);
      for (let j = 0; j < 16; j++) {
        w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) |
               (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3];
      }
      for (let j = 16; j < 80; j++) w[j] = this._rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const tmp = (this._rotl(a, 5) + f + e + k + w[j]) | 0;
        e = d; d = c; c = this._rotl(b, 30); b = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
  },

  _psHeaders() {
    const nonce = this._randToken(6);
    const ts = String(Date.now());
    const xsrf = this._randHex(32);
    const finger = this._randHex(32);
    const sig = this._sha1([this._PS_SECRET, ts, nonce].sort().join(""));
    return {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Content-Type": "application/json;charset=UTF-8",
      "Cookie": "XSRF-TOKEN=" + xsrf,
      "Origin": "https://pubscholar.cn",
      "Referer": "https://pubscholar.cn/explore",
      "nonce": nonce, "signature": sig, "timestamp": ts,
      "x-finger": finger, "x-xsrf-token": xsrf,
      _finger: finger,
    };
  },

  _stripHTML(t) {
    return String(t || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  },

  /**
   * PubScholar 搜索 → [{source, articleTitle, author, journal, year, volume, issue,
   * pages, doi, abstract, keywords, url, articleID}]（无结果返回 []）
   * 0.42.0：queries 可外部传入（CNAI 规划的多候选检索式），缺省走内置启发式。
   */
  async _searchPubScholar(title, author, queries) {
    if (!Array.isArray(queries) || !queries.length) {
      queries = this._buildQueries(title, author);
    }
    const target = author
      ? this._normalizeTitle(this._normalizeTitle(title).replace(new RegExp(this._escapeRe(author), "g"), " "))
      : this._normalizeTitle(title);
    const seen = new Set();
    const out = [];
    for (const q of queries) {
      for (const orderField of ["default", "year"]) {
        const headers = this._psHeaders();
        const body = JSON.stringify({
          page: 1, size: 20, order_field: orderField, order_direction: "desc",
          user_id: headers._finger, lang: "zh", query: q,
        });
        delete headers._finger;
        let data;
        try {
          const resp = await Zotero.HTTP.request("POST", this._PS_URL, {
            body, headers, timeout: 10000,
          });
          data = JSON.parse(resp.responseText);
        } catch (e) {
          this._diag("pubscholar request failed: " + (e && e.message));
          continue;
        }
        if (data.error || !data.content) continue;
        for (const a of data.content) {
          const articleTitle = this._stripHTML(a.title);
          if (!articleTitle) continue;
          const key = a.id || (articleTitle + "|" + (a.author || []).join(","));
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            source: "PubScholar",
            articleTitle,
            author: (a.author || []).join(","),
            creators: a.author || [],
            journal: String(a.source || "").trim(),
            year: String(a.year || a.date || ""),
            volume: String(a.volume || "").trim(),
            issue: String(a.issue || "").trim(),
            pages: [a.first_page, a.last_page].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join("-"),
            doi: String(a.doi || "").trim(),
            abstract: this._stripHTML(a.abstracts),
            keywords: a.keywords || [],
            url: (a.links || []).find((l) => l && l.url)?.url || "",
            pdfUrl: (a.local_links || [])[0] || "", // 公益平台免费全文直链（file.scholarin.cn，实测免鉴权）
            articleID: String(a.id || ""),
            itemType: a.article_type === "学位论文" ? "thesis"
              : a.article_type === "会议论文" ? "conferencePaper"
              : a.article_type === "图书" ? "book"
              : a.article_type === "报纸文章" ? "newspaperArticle" : "journalArticle",
          });
        }
        // 早期命中：已找到目标标题则提前返回，避免打满 4 查询 × 2 排序
        if (target && out.some((r) => this._isTitleMatch(r.articleTitle, target))) return out;
      }
    }
    return out;
  },

  // ================= CNKI 源 =================

  /** 表单编码：嵌套对象 JSON.stringify（与 jasminum jsonToFormUrlEncoded 同行为） */
  _formEncode(obj) {
    return Object.keys(obj).map((k) => {
      let v = obj[k];
      if (v && typeof v === "object") v = JSON.stringify(v);
      return encodeURIComponent(k) + "=" + encodeURIComponent(String(v));
    }).join("&");
  },

  /**
   * CNKI 搜索 → {results:[...]} 正常 / {captcha:url}（403 滑块）/
   * {maybeBlocked:true}（200 但 no-content 软拦或真空结果，需探测区分）
   * 结果字段：articleTitle/author/journal/date/citation/url/exportID/dbname/filename
   */
  async _searchCNKI(title, author) {
    const searchExp = "TI %= '" + String(title).replace(/'/g, "") + "'" +
      (author ? " AND AU='" + String(author).replace(/'/g, "") + "'" : "");
    const aside = searchExp.replace(/'/g, "&#39;");
    const post = {
      boolSearch: "true",
      QueryJson: {
        Platform: "", Resource: "CROSSDB", Classid: "WD0FTY92", Products: "",
        QNode: { QGroup: [
          { Key: "Subject", Title: "", Logic: 0,
            Items: [{ Key: "Expert", Title: "", Logic: 0, Field: "EXPERT",
                      Operator: 0, Value: searchExp, Value2: "" }], ChildItems: [] },
          { Key: "ControlGroup", Title: "", Logic: 0, Items: [], ChildItems: [] },
        ] },
        ExScope: "1", SearchType: 4, Rlang: "CHINESE",
        KuaKuCode: "YSTT4HG0,LSTPFY1C,JUP3MUPD,MPMFIG1A,WQ0UVIAA,BLZOG7CK,PWFIRAGL,EMRPGLPA,NLBO1Z6R,NN3FJMUV",
        SearchFrom: 1,
      },
      pageNum: "1", pageSize: "20", sortField: "", sortType: "", dstyle: "listmode",
      productStr: "YSTT4HG0,LSTPFY1C,RMJLXHZ3,JQIRZIYA,JUP3MUPD,1UR4K4HZ,BPBAFJ5S,R79MZMCB,MPMFIG1A,WQ0UVIAA,NB3BWEHK,XVLO76FD,HR1YT1Z9,BLZOG7CK,PWFIRAGL,EMRPGLPA,J708GVCE,ML4DRIDX,NLBO1Z6R,NN3FJMUV,",
      aside: "(" + aside + ")",
      searchFrom: "资源范围：总库;++中英文扩展;++时间范围：更新时间：不限;++",
      CurPage: "1",
    };
    const headers = {
      "Accept": "*/*",
      "Accept-Language": "zh-CN,en-US;q=0.9,en;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://kns.cnki.net",
      "Referer": "https://kns.cnki.net/kns8s/defaultresult/index?kw=",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
    };
    let resp;
    try {
      resp = await Zotero.HTTP.request("POST", "https://kns.cnki.net/kns8s/brief/grid", {
        body: this._formEncode(post), headers, timeout: 10000, successCodes: [200, 403],
      });
    } catch (e) {
      this._diag("cnki request failed: " + (e && e.message));
      return { results: [] };
    }
    if (resp.status === 403) {
      let captcha = "";
      try { captcha = JSON.parse(resp.responseText).message || ""; } catch (e) { /* ignore */ }
      this._diag("cnki captcha: " + captcha);
      return { results: [], captcha };
    }
    const doc = new DOMParser().parseFromString(resp.responseText, "text/html");
    const rows = doc.querySelectorAll("table.result-table-list > tbody > tr");
    // 软拦截特征：200 但 briefBox 里只有 no-content（"抱歉，暂无数据"）。
    // 与真空结果同构，调用方需用 CNVerify.probe() 热词探测区分。
    if (!rows.length && resp.responseText.includes("no-content")) {
      this._diag("cnki no-content (soft block or genuine empty)");
      return { results: [], maybeBlocked: true };
    }
    // 0.42.0 结构改版特征：200、有实质内容、但固定选择器一行都匹配不到，
    // 且没有 no-content 标记——大概率知网改版。附带截断 HTML 供 CNAI.rescue 自愈。
    if (!rows.length && resp.responseText && resp.responseText.length > 1000) {
      this._diag("cnki structure changed? rows=0 len=" + resp.responseText.length);
      return { results: [], structureChanged: true, html: resp.responseText.slice(0, 20000) };
    }
    const results = [];
    for (const r of rows) {
      const txt = (sel) => { const el = r.querySelector(sel); return el ? el.textContent.trim() : ""; };
      const attr = (sel, name) => { const el = r.querySelector(sel); return el ? (el.getAttribute(name) || "") : ""; };
      let url = attr("a.fz14", "href");
      if (url && !url.startsWith("http")) url = "https://chn.oversea.cnki.net" + url;
      const articleTitle = txt("td.name a");
      if (!articleTitle) continue;
      results.push({
        source: "CNKI",
        articleTitle,
        author: txt("td.author").replace(/\s+/g, ",").replace(/^,|,$/g, ""),
        creators: txt("td.author").split(/[,;；\s]+/).filter(Boolean),
        journal: txt("td.source"),
        year: (txt("td.date").match(/\d{4}/) || [""])[0],
        date: txt("td.date"),
        citation: txt("td.quote"),
        url,
        exportID: attr("td.seq input", "value"),
        dbname: attr("td.operat > [data-dbname]", "data-dbname"),
        filename: attr("td.operat > [data-dbname]", "data-filename"),
        itemType: "journalArticle",
      });
    }
    return { results };
  },

  // ================= CNKI GetExport 导出通道（0.42.0，P2 移植 jasminum 双通道） =================

  /**
   * 知网导出接口拿 EndNote 文本。导出接口反爬强度低于详情页，
   * 是网页解析被验证码拦截时的兜底通道；同时它的字段（DOI/摘要/卷期页）
   * 比搜索结果行完整得多，正常路径也用它补全。
   * @returns {Promise<string>} EndNote tagged 文本（失败/被拦返回 ""）
   */
  async _getExportEndNote(exportID) {
    if (!exportID) return "";
    try {
      const resp = await Zotero.HTTP.request(
        "POST",
        "https://kns.cnki.net/dm8/API/GetExport",
        {
          body: "filename=" + encodeURIComponent(exportID) +
            "&uniplatform=NZKPT&displaymode=GBTREFER%2Celearning%2CEndNote",
          headers: {
            "Accept": "text/plain, */*; q=0.01",
            "Accept-Language": "zh-CN,en-US;q=0.7,en;q=0.3",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://www.cnki.net",
            "Referer": "https://kns.cnki.net/",
          },
          timeout: 10000,
          successCodes: [200, 403],
        },
      );
      if (resp.status !== 200) {
        this._diag("getexport status " + resp.status);
        return "";
      }
      const j = JSON.parse(resp.responseText);
      if (!j || j.code != 1 || !Array.isArray(j.data)) return "";
      const en = j.data.find((i) => i && i.key === "EndNote");
      const v = en && en.value && en.value[0];
      return v ? String(v).replace(/<br\s*\/?>/g, "\n") : "";
    } catch (e) {
      this._diag("getexport failed: " + (e && e.message));
      return "";
    }
  },

  /**
   * 解析 EndNote tagged 文本（%0/%T/%A/%J/%D/%V/%N/%P/%R/%X/%K/%U）→ 标准结果字段。
   * 纯函数（test/cn-ai.test.js 离线覆盖）；字段为空则不出现缺省值问题——
   * 融合时由 CNAI.fuseMeta 只填空。
   */
  _parseEndNote(text) {
    const meta = {
      articleTitle: "", creators: [], author: "", journal: "", year: "", date: "",
      volume: "", issue: "", pages: "", doi: "", abstract: "", keywords: [],
      url: "", itemType: "journalArticle",
    };
    const typeMap = {
      "Journal Article": "journalArticle",
      "Thesis": "thesis",
      "Conference Paper": "conferencePaper",
      "Conference Proceedings": "conferencePaper",
      "Newspaper Article": "newspaperArticle",
    };
    let curTag = "";
    let curField = "";
    const flush = () => {
      const v = String(curField || "").replace(/\s+/g, " ").trim();
      curField = "";
      if (!curTag || !v) return;
      switch (curTag) {
        case "0":
          if (typeMap[v]) meta.itemType = typeMap[v];
          break;
        case "T": meta.articleTitle = meta.articleTitle ? meta.articleTitle + " " + v : v; break;
        case "A": meta.creators.push(v); break;
        case "J": meta.journal = meta.journal || v; break;
        case "D":
          meta.date = v;
          meta.year = (v.match(/\d{4}/) || [""])[0];
          break;
        case "V": meta.volume = meta.volume || v; break;
        case "N": meta.issue = meta.issue || v; break;
        case "P": meta.pages = meta.pages || v; break;
        case "R": meta.doi = meta.doi || v; break;
        case "X": meta.abstract = meta.abstract ? meta.abstract + " " + v : v; break;
        case "K": meta.keywords.push(v); break;
        case "U": meta.url = meta.url || v; break;
        default: break;
      }
    };
    for (const line of String(text || "").split(/\r?\n/)) {
      const m = line.match(/^%([0-9A-Z])\s?(.*)$/);
      if (m) {
        flush();
        curTag = m[1];
        curField = m[2] || "";
      } else if (curTag && line.trim()) {
        curField += " " + line.trim(); // 摘要/标题跨行续行
      }
    }
    flush();
    meta.author = meta.creators.join(",");
    return meta;
  },

  // ================= 选择器 =================

  /**
   * 从结果集中挑一条：完全命中自动选；否则弹列表让用户选（返回 null=取消）。
   * 0.42.0：recommend={index, reason}（CNAI 裁决 confirm 档）时把推荐项置顶并标注理由。
   * 注意 recommend.index 的口径是 results.slice(0,10)——与 CNAI.judge 的候选列表一致。
   */
  _pickResult(results, targetTitle, recommend) {
    const exact = results.filter((r) => this._isTitleMatch(r.articleTitle, targetTitle));
    if (exact.length === 1) return exact[0];
    if (!results.length) return null;
    const win = Zotero.getMainWindow();
    if (!win) return null;
    // 候选排序：精确命中优先，其次按标题长度接近度
    const cand = (exact.length ? exact : results).slice(0, 10);
    if (recommend && Number.isInteger(recommend.index) &&
        cand[recommend.index] && !exact.length) {
      const hit = cand.splice(recommend.index, 1)[0];
      cand.unshift(hit);
    }
    const io = { dataIn: null, dataOut: null };
    const items = cand.map((r, i) =>
      (recommend && i === 0 && !exact.length
        ? (I18n.isZh ? "★ AI 推荐" : "★ AI pick") +
          (recommend.reason ? "（" + recommend.reason + "）" : "") + " "
        : "") +
      "【" + r.source + "】" + r.articleTitle +
      (r.author ? " — " + String(r.author).split(",")[0] : "") +
      (r.journal ? " · " + r.journal : "") + (r.year ? " " + r.year : ""));
    const ps = Services.prompt;
    const sel = {};
    const ok = ps.select(win, "PaperPilot · " + (I18n.isZh ? "选择匹配的文献" : "Select match"),
      I18n.isZh
        ? "找到 " + results.length + " 条候选，请选择最匹配的一条（取消则跳过该条目）："
        : "Found " + results.length + " candidates, pick the best match (Cancel skips this item):",
      items.length, items, sel);
    if (!ok || sel.value == null || sel.value < 0) return null;
    return cand[sel.value];
  },

  // ================= 回填 =================

  /** 仅当字段对该条目类型有效时写入，避免 thesis 等类型缺字段抛错 */
  _setField(item, name, value) {
    if (!value) return false;
    try {
      if (Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, name)) {
        item.setField(name, value);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  },

  /** 条目元数据是否不完整（标题=文件名 或 缺作者/期刊） */
  _isIncomplete(item) {
    let title = "";
    try { title = (item.getField("title") || "").trim(); } catch (e) { return false; }
    if (/\.(pdf|caj|kdh|nh|teb)$/i.test(title)) return true;
    try { if (!item.getCreators().length) return true; } catch (e) { /* ignore */ }
    try {
      if (item.itemType === "journalArticle" && !item.getField("publicationTitle")) return true;
    } catch (e) { /* ignore */ }
    return false;
  },

  /**
   * 用抓取结果回填条目。upgradeTitle=true 时（标题仍是文件名）允许覆盖标题。
   * 返回填充的字段名列表。
   */
  _enrichItem(item, r, upgradeTitle) {
    const filled = [];
    const fill = (name, value, force) => {
      let cur = "";
      try { cur = String(item.getField(name) || "").trim(); } catch (e) { cur = ""; }
      if (!force && cur) return;
      if (this._setField(item, name, value)) filled.push(name);
    };
    if (upgradeTitle) fill("title", r.articleTitle, true);
    // 作者：当前无作者才写
    try {
      if (!item.getCreators().length && r.creators && r.creators.length) {
        item.setCreators(r.creators.map((n) => ({
          lastName: n, fieldMode: 1, creatorType: "author",
        })));
        filled.push("creators");
      }
    } catch (e) { /* ignore */ }
    fill("publicationTitle", r.journal);
    fill("volume", r.volume);
    fill("issue", r.issue);
    fill("pages", r.pages);
    fill("date", r.year || r.date || "");
    fill("DOI", r.doi);
    fill("abstractNote", r.abstract);
    fill("url", r.url);
    // 关键词 → 标签（不删已有标签）
    try {
      if (r.keywords && r.keywords.length) {
        const existing = new Set(item.getTags().map((t) => t.tag));
        let added = 0;
        for (const kw of r.keywords) {
          if (kw && !existing.has(kw)) { item.addTag(kw, 1); added++; }
        }
        if (added) filled.push("tags");
      }
    } catch (e) { /* ignore */ }
    return filled;
  },

  /** 取条目的搜索标题：标题=文件名时用 CNMeta 解析文件名，否则用标题 */
  _searchTitleFor(item) {
    let title = "";
    try { title = (item.getField("title") || "").trim(); } catch (e) { /* ignore */ }
    if (/\.(pdf|caj|kdh|nh|teb)$/i.test(title)) {
      const parsed = CNMeta.parseFilename(title);
      if (parsed.title) return { title: parsed.title, author: (parsed.creators || [])[0] || "" };
    }
    // 附件文件名兜底（标题已是正常标题但可能仍是文件名主体）
    return { title: title.replace(/\.(pdf|caj|kdh|nh|teb)$/i, ""), author: "" };
  },

  /** CNKI 会话预热：GET 首页拿 SID cookie（Zotero.HTTP 与标签页共享 profile cookie 罐） */
  async _seedCNKI() {
    if (this._cnkiSeeded) return;
    this._cnkiSeeded = true;
    try {
      await Zotero.HTTP.request("GET", "https://kns.cnki.net/kns8s/", { timeout: 8000 });
      this._diag("cnki session seeded");
    } catch (e) {
      this._diag("cnki seed failed: " + (e && e.message));
    }
  },

  // ================= PDF 附件抓取（0.14.10） =================

  /** 条目是否已有 PDF 附件 */
  _hasPDFAttachment(item) {
    try {
      for (const id of (item.getAttachments ? item.getAttachments() : [])) {
        const a = Zotero.Items.get(id);
        if (a && a.attachmentContentType === "application/pdf") return true;
        if (a && a.isPDFAttachment && a.isPDFAttachment()) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  },

  /** 下载 URL → bytes，校验 %PDF magic；返回 {bytes} 或 {fail:true} */
  async _downloadPDFBytes(url, referer) {
    const resp = await Zotero.HTTP.request("GET", url, {
      responseType: "arraybuffer",
      headers: referer ? { "Referer": referer } : undefined,
      timeout: 45000,
    });
    const bytes = new Uint8Array(resp.response);
    // 无权限/未登录时知网返回 HTML 登录或购买页；免费直链异常时也可能是 HTML 错误页
    if (bytes.length < 500 ||
        !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      return { fail: true };
    }
    return { bytes };
  },

  /** bytes → 临时文件 → 导入为条目附件并命名 */
  async _importPDF(item, bytes, title) {
    const tmp = PathUtils.join(PathUtils.tempDir, "paperpilot-" + Date.now() + ".pdf");
    await IOUtils.write(tmp, bytes);
    try {
      const att = await Zotero.Attachments.importFromFile({ file: tmp, parentItemID: item.id });
      try {
        att.setField("title", title ? ("Full Text: " + title).slice(0, 200) : "Full Text PDF");
        await att.saveTx();
      } catch (e) { /* ignore */ }
      return att;
    } finally {
      try { await IOUtils.remove(tmp, { ignoreAbsent: true }); } catch (e) { /* ignore */ }
    }
  },

  /**
   * 尝试抓 PDF 附件。两条路：
   * ① PubScholar local_links 免费全文（file.scholarin.cn 直链，免鉴权，实测返回 %PDF）
   * ② CNKI 详情页 .btn-dlpdf（与 translators_CN/CNKI.js 同款解析；
   *    按钮只在有下载权限的会话中渲染，下载需要机构订阅/知网账号——任何插件都绕不过付费墙）
   * 返回 "ok" | "denied" | "no-link" | "captcha" | "error" | "skip"
   */
  async _tryAttachPDF(item, pick) {
    try {
      if (pick.pdfUrl) {
        try {
          const r = await this._downloadPDFBytes(pick.pdfUrl, "https://pubscholar.cn/");
          if (r.bytes) {
            await this._importPDF(item, r.bytes, pick.articleTitle);
            this._diag("pdf attached from scholarin: " + pick.articleTitle);
            return "ok";
          }
          this._diag("scholarin link not-pdf: " + pick.pdfUrl);
        } catch (e) {
          this._diag("scholarin pdf error: " + (e && e.message));
        }
      }
      if (pick.source === "CNKI" && (pick.filename || pick.url)) {
        return await this._tryCNKIPdf(item, pick);
      }
      return pick.pdfUrl ? "error" : "no-link";
    } catch (e) {
      this._diag("attach pdf error: " + (e && (e.stack || e.message)));
      return "error";
    }
  },

  /** CNKI 机构权限通道：详情页 → .btn-dlpdf → 下载（共享验证后的 cookie 会话） */
  async _tryCNKIPdf(item, pick) {
    const pages = [];
    if (pick.dbname && pick.filename) {
      pages.push("https://kns.cnki.net/kcms/detail/detail.aspx?dbname=" +
        encodeURIComponent(pick.dbname) + "&filename=" + encodeURIComponent(pick.filename));
    }
    if (pick.url) pages.push(pick.url);
    let pdfUrl = "", pageUrl = "";
    for (const u of pages) {
      let resp;
      try {
        resp = await Zotero.HTTP.request("GET", u, {
          headers: { "Referer": "https://kns.cnki.net/kns8s/" },
          timeout: 15000, successCodes: [200, 403],
        });
      } catch (e) {
        this._diag("cnki detail page failed: " + (e && e.message));
        continue;
      }
      const html = resp.responseText || "";
      // 知网节超时验证页（translators_CN 同款检测）
      if (/知网节超时验证|>captcha</i.test(html)) return "captcha";
      const doc = new DOMParser().parseFromString(html, "text/html");
      // 0.42.0：除新版 .btn-dlpdf 外，兼容 oversea/旧版详情页的 #pdfDown1/#pdfDown
      // （jasminum 旧版 oversea.cnki.net 通道同款锚点）
      const a = doc.querySelector(".btn-dlpdf > a") || doc.querySelector("a.btn-dlpdf") ||
        doc.getElementById("pdfDown1") || doc.getElementById("pdfDown");
      const href = a && a.getAttribute("href");
      if (href) {
        const host = u.includes("oversea") ? "https://oversea.cnki.net" : "https://kns.cnki.net";
        pdfUrl = href.startsWith("http") ? href
          : host + (href.startsWith("/") ? href : "/" + href);
        pageUrl = u;
        break;
      }
    }
    if (!pdfUrl) {
      // 无下载权限/未登录时按钮不渲染——这是正常结果而非错误
      this._diag("no pdf button on detail pages (no access?)");
      return "no-link";
    }
    let r;
    try { r = await this._downloadPDFBytes(pdfUrl, pageUrl); }
    catch (e) { return "error"; }
    if (r.fail) return "denied"; // 返回 HTML 登录/购买页 = 无权限
    await this._importPDF(item, r.bytes, pick.articleTitle);
    this._diag("pdf attached from cnki: " + pick.articleTitle);
    return "ok";
  },

  /** 单条目抓取流程；返回 {status, detail} */
  async _fetchForItem(item, opts) {
    // 附件上溯父条目
    if (item.isAttachment && item.isAttachment()) {
      const p = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
      if (p) item = p;
    }
    if (item.isNote && item.isNote()) return { status: "skip", detail: "note" };
    if (!this._isIncomplete(item) && !opts.force) return { status: "skip", detail: "complete" };

    const { title, author } = this._searchTitleFor(item);
    if (!title || title.length < 4) return { status: "skip", detail: "no-title" };

    // 0.42.0 L1 检索词规划（CNAI）：AI 不可用/失败时回退启发式，行为与旧版一致
    let plan = null;
    if (typeof CNAI !== "undefined" && CNAI) {
      try { plan = await CNAI.plan(item, { title, author }); }
      catch (e) { this._diag("plan error: " + (e && e.message)); }
    }
    const searchTitle = (plan && plan.title) || title;
    const searchAuthor = (plan && plan.author) || author;
    const queries = (plan && plan.queries && plan.queries.length)
      ? plan.queries : this._buildQueries(title, author);

    // 搜索链：PubScholar → CNKI（可关；被风控时整批短路，避免反复触发）
    let results = [];
    try { results = await this._searchPubScholar(searchTitle, searchAuthor, queries); } catch (e) {
      this._diag("pubscholar chain error: " + (e && e.message));
    }
    let captcha = "";
    const exactHit = results.some((r) => this._isTitleMatch(r.articleTitle, searchTitle));
    if (!exactHit && Prefs.get("cnFetchUseCNKI", true) && !this._batchBlocked) {
      await this._seedCNKI();
      let r2 = await this._searchCNKI(searchTitle, searchAuthor);
      // no-content 软拦 vs 真空结果：热词探测一次定真伪（每批至多一次）。
      // 0.42.1：探测通过但本题 0 结果时重试一次原搜索——no-content 也可能是
      // 偶发软拦（2026-10-15 真机诊断实踩：同会话先 no-content 后 403 滑块）
      if (r2.maybeBlocked) {
        const ok = await CNVerify.probe();
        if (!ok) {
          captcha = "soft-block";
          this._batchBlocked = true;
          this._diag("cnki soft-blocked confirmed by probe");
        } else if (!r2.results.length) {
          this._diag("no-content but probe ok, retry original search once");
          r2 = await this._searchCNKI(searchTitle, searchAuthor);
        }
      }
      if (r2.captcha) {
        captcha = r2.captcha;
        this._batchBlocked = true;
        this._lastCaptchaUrl = r2.captcha; // 0.42.1：记住 403 滑块页链接，批末验证窗直接开它
      } else if (r2.structureChanged && typeof CNAI !== "undefined" && CNAI) {
        // 0.42.0 P3 自愈：页面结构疑似改版 → LLM 从 HTML 提取结果行
        const rescued = await CNAI.rescue(r2.html);
        if (rescued.length) r2.results = rescued;
      }
      if (!this._batchBlocked && r2.results.length) {
        const seen = new Set(results.map((r) => this._compact(r.articleTitle)));
        for (const r of r2.results) {
          if (!seen.has(this._compact(r.articleTitle))) results.push(r);
        }
      }
    }

    const upgradeTitle = /\.(pdf|caj|kdh|nh|teb)$/i.test((item.getField("title") || "").trim());

    // 0.42.0 L3 语义裁决：多候选且无唯一精确命中时，由 AI 排序/否决
    let pick = null;
    let recommend = null;
    if (results.length > 1 && typeof CNAI !== "undefined" && CNAI &&
        Prefs.get("cnFetchAIJudge", true)) {
      const exacts = results.filter((r) => this._isTitleMatch(r.articleTitle, searchTitle));
      if (exacts.length !== 1) {
        const cand10 = results.slice(0, 10);
        const judgment = await CNAI.judge(
          { title: searchTitle, author: searchAuthor,
            journal: (plan && plan.journal) || "", year: (plan && plan.year) || "" },
          cand10,
        );
        const d = CNAI.decide(
          judgment, cand10.length,
          Prefs.get("cnAIAutoThreshold", 0.9),
          Prefs.get("cnAIConfirmThreshold", 0.6),
        );
        if (d.action === "auto") {
          pick = cand10[d.index];
          this._diag("judge auto-pick #" + d.index);
        } else if (d.action === "confirm") {
          recommend = { index: d.index, reason: d.reason || "" };
        } else if (d.action === "reject") {
          this._diag("judge rejected all candidates");
          results = [];
        }
      }
    }
    if (results.length && !pick) pick = this._pickResult(results, searchTitle, recommend);

    // 0.42.0 P3 AI 兜底：全部检索失败（非风控）→ AI 直读 PDF 建元数据（标 unverified）
    if (!results.length && !pick) {
      if (!captcha && typeof CNAI !== "undefined" && CNAI) {
        const aiMeta = await CNAI.recognize(item);
        if (aiMeta) {
          const filledAI = this._enrichItem(item, aiMeta, upgradeTitle);
          try {
            const mark = "AI-recognized, unverified";
            const curExtra = String(item.getField("extra") || "");
            if (!curExtra.includes(mark)) {
              item.setField("extra", (curExtra ? curExtra + "\n" : "") + mark);
              if (!filledAI.includes("extra")) filledAI.push("extra");
            }
          } catch (e) { /* ignore */ }
          if (filledAI.length) await item.saveTx();
          return { status: "ok", detail: "ai:" + (filledAI.join(",") || "marked"),
            source: "AI", captcha, pdf: "" };
        }
      }
      return { status: "empty", detail: captcha ? "captcha" : "no-result", captcha };
    }
    if (!pick) return { status: "skip", detail: "user-cancel" };

    // 0.42.0 P2 双通道 + 融合：CNKI 命中 → GetExport 拿 EndNote 权威元数据补全，
    // 融合纪律 = EndNote 为准、搜索结果补协议字段、AI 规划只填空
    if (pick.source === "CNKI" && pick.exportID &&
        Prefs.get("cnFetchCNKIExport", true) && typeof CNAI !== "undefined" && CNAI) {
      const enText = await this._getExportEndNote(pick.exportID);
      if (enText) {
        const dbMeta = this._parseEndNote(enText);
        if (dbMeta.articleTitle) {
          pick = CNAI.fuseMeta(dbMeta, pick, plan);
          this._diag("fused with EndNote export: " + (dbMeta.doi || "no-doi"));
        }
      }
    }

    // 类型不一致（如 thesis vs journalArticle）且字段差异大时，先尽量字段级回填
    const filled = this._enrichItem(item, pick, upgradeTitle);
    // PDF 附件：元数据有/无新字段都尝试（用户核心诉求是全文）
    let pdf = "";
    if (Prefs.get("cnFetchPDF", true) && !this._hasPDFAttachment(item)) {
      pdf = await this._tryAttachPDF(item, pick);
    }
    if (!filled.length) {
      return pdf === "ok"
        ? { status: "ok", detail: "pdf", source: pick.source, captcha, pdf }
        : { status: "skip", detail: "nothing-new", pdf };
    }
    await item.saveTx();
    return { status: "ok", detail: filled.join(","), source: pick.source, captcha, pdf };
  },

  /** 菜单入口：抓取所选条目 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const raw = zp.getSelectedItems() || [];
    const items = ItemSel.regularOnly(raw);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const zh = I18n.isZh;
    this._batchBlocked = false; // 批次级风控状态（软拦/滑块确认后整批短路 CNKI）
    this._cnkiSeeded = false;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + (zh ? "抓取中文元数据" : "Fetch CN metadata"));
    pw.show();
    let nOk = 0, nSkip = 0, nEmpty = 0;
    let blockedHit = false;
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const r = await this._fetchForItem(item, { force: false });
        progress.setProgress(100);
        if (r.status === "ok") {
          nOk++;
          let t = (zh ? "已回填（" : "Filled (") + (r.source || "") + "）";
          if (r.pdf === "ok") t += zh ? " + PDF 全文" : " + PDF";
          else if (r.pdf === "denied") t += zh ? "；PDF 无下载权限" : "; PDF no access";
          else if (r.pdf === "no-link") t += zh ? "；无免费 PDF" : "; no free PDF";
          else if (r.pdf === "error") t += zh ? "；PDF 下载失败" : "; PDF failed";
          progress.setText(t);
          if (r.pdf === "captcha") blockedHit = true;
        } else if (r.status === "empty") {
          nEmpty++;
          if (r.captcha) blockedHit = true;
          progress.setText(r.captcha
            ? (zh ? "知网触发安全验证" : "CNKI verification required")
            : (zh ? "未找到匹配" : "No match found"));
        } else {
          nSkip++;
          const map = { complete: zh ? "跳过（元数据已完整）" : "Skipped (complete)",
            "user-cancel": zh ? "已取消" : "Cancelled",
            "nothing-new": zh ? "无新字段可补" : "Nothing new",
            "no-title": zh ? "无可用标题" : "No usable title" };
          progress.setText(map[r.detail] || (zh ? "跳过" : "Skipped"));
        }
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    const summary = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "合计：回填 " : "Done: filled ") + nOk +
      (zh ? "，未找到 " : ", not found ") + nEmpty +
      (zh ? "，跳过 " : ", skipped ") + nSkip);
    summary.setProgress(100);
    pw.startCloseTimer(5000);

    // 知网被风控（滑块/软拦）→ 引导在内置标签页过验证，通过后自动续抓本批
    if (blockedHit) {
      const win = Zotero.getMainWindow();
      if (CNVerify.recentlyPassed()) {
        // 5 分钟内刚验证过仍被拦：大概率是频次限制，再开验证窗无济于事
        Zotero.alert(win, "PaperPilot · " + (zh ? "知网验证" : "CNKI verification"),
          zh ? "5 分钟内刚完成过知网验证，但仍被拦截——可能是访问频次限制，请几分钟后再试。"
             : "Verified within the last 5 minutes but still blocked — likely rate limiting; try again later.");
      } else {
        const go = Services.prompt.confirm(win,
          "PaperPilot · " + (zh ? "知网验证" : "CNKI verification"),
          zh
            ? "知网触发了安全验证（滑块/风控拦截）。\n是否现在打开知网页面完成验证？验证通过后会自动继续本次抓取。"
            : "CNKI is blocking requests (slider/risk control). Open the CNKI page to verify? Fetching will resume automatically afterwards.");
        if (go) {
          // 0.42.1：优先 403 滑块页链接（本题的 → 探测捕到的），都没有才回落搜索页
          CNVerify.openAndWait(() => this.runForSelected(), null,
            this._lastCaptchaUrl || CNVerify._probeCaptchaUrl || "");
        }
      }
    }
  },

  // ================= 下载文件夹附件匹配 =================

  /** 系统下载目录（可被 pref cnDownloadDir 覆盖） */
  _downloadsDir() {
    const custom = Prefs.get("cnDownloadDir", "");
    if (custom) return custom;
    try {
      const d = Services.dirsvc.get("DfltDwnld", Components.interfaces.nsIFile);
      return d.path;
    } catch (e) {
      return PathUtils.join(PathUtils.homeDir, "Downloads");
    }
  },

  /** 文件名与标题的匹配度（0-1）：标题压缩串被文件名包含 → 高匹配 */
  _matchScore(title, filename) {
    const t = this._compact(title);
    const f = this._compact(String(filename).replace(/\.(pdf|caj|kdh|nh|teb)$/i, ""));
    if (!t || !f) return 0;
    if (f === t) return 1;
    if (f.includes(t)) return 0.95;
    if (t.includes(f) && f.length >= 8) return 0.9;
    // 部分匹配：文件名是标题前缀/包含标题前 12 字
    if (t.length >= 12 && f.includes(t.slice(0, 12))) return 0.75;
    return 0;
  },

  /** 菜单入口：为无 PDF 的所选条目在下载文件夹中查找附件 */
  async matchAttachmentsFromDownloads() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    const zh = I18n.isZh;
    const dir = this._downloadsDir();

    let files = [];
    try {
      const children = await IOUtils.getChildren(dir);
      for (const p of children) {
        const name = PathUtils.filename(p);
        if (/\.(pdf|caj|kdh|nh)$/i.test(name) && /[一-龥]/.test(name)) files.push(p);
      }
    } catch (e) {
      Zotero.alert(null, "PaperPilot", (zh ? "无法读取下载目录：" : "Cannot read downloads dir: ") + dir);
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + (zh ? "下载文件夹匹配附件" : "Match attachments"));
    pw.show();
    let nOk = 0, nNone = 0, nHas = 0;
    for (const item of items) {
      const title = (item.getDisplayTitle() || "").slice(0, 30);
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        // 已有 PDF 附件 → 跳过
        let hasPDF = false;
        for (const id of item.getAttachments()) {
          const a = Zotero.Items.get(id);
          if (a && a.isPDFAttachment && a.isPDFAttachment()) { hasPDF = true; break; }
        }
        if (hasPDF) { nHas++; progress.setText(zh ? "已有 PDF 附件" : "Already has PDF"); progress.setProgress(100); continue; }
        const itemTitle = item.getField("title") || "";
        let best = null, bestScore = 0;
        for (const p of files) {
          const s = this._matchScore(itemTitle, PathUtils.filename(p));
          if (s > bestScore) { bestScore = s; best = p; }
        }
        if (best && bestScore >= 0.75) {
          await Zotero.Attachments.importFromFile({ file: best, parentItemID: item.id, libraryID: item.libraryID });
          nOk++;
          progress.setText((zh ? "已关联：" : "Attached: ") + PathUtils.filename(best));
        } else {
          nNone++;
          progress.setText(zh ? "下载文件夹中无匹配" : "No match in downloads");
        }
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    const summary = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "合计：关联 " : "Attached ") + nOk +
      (zh ? "，无匹配 " : ", none ") + nNone +
      (zh ? "，已有附件 " : ", had PDF ") + nHas);
    summary.setProgress(100);
    pw.startCloseTimer(4000);
  },

  // ================= 中文姓名小工具 =================

  /** 合并中文姓名（two-field → 单字段）；茉莉花「小工具」同款 */
  mergeNames() { this._nameMode("merge"); },

  /** 拆分中文姓名（单字段 → 姓+名 two-field） */
  splitNames() { this._nameMode("split"); },

  _nameMode(mode) {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    const zh = I18n.isZh;
    let n = 0;
    for (const item of items) {
      try {
        const creators = item.getCreators();
        let changed = false;
        const next = creators.map((c, i) => {
          if (mode === "merge") {
            // 中文名（无空格）且分了两栏 → 合并
            if (c.fieldMode !== 1 && c.lastName && /^[一-龥]+$/.test(String(c.firstName || ""))) {
              changed = true;
              return { creatorType: c.creatorType || "author", fieldMode: 1,
                lastName: String(c.lastName) + String(c.firstName || "") };
            }
          } else {
            // 单字段中文名 ≥2 字 → 姓 1 字（复姓 2 字）+ 名
            if (c.fieldMode === 1 && /^[一-龥·]{2,4}$/.test(c.lastName)) {
              const name = String(c.lastName);
              const compound = ["欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人", "夏侯", "诸葛", "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶", "太叔", "申屠", "公孙", "慕容", "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于", "司空", "闾丘", "子车", "亓官", "司寇", "巫马", "公西", "颛孙", "壤驷", "公良", "漆雕", "乐正", "宰父", "谷梁", "拓跋", "夹谷", "轩辕", "令狐", "段干", "百里", "呼延", "东郭", "南门", "羊舌", "微生", "公户", "公玉", "公仪", "梁丘", "公仲", "公上", "公门", "公山", "公坚", "左丘", "公伯", "西门", "公祖", "第五", "公乘", "贯丘", "公皙", "南荣", "东里", "东宫", "仲长", "子书", "子桑", "即墨", "达奚", "褚师"];
              const sur2 = name.slice(0, 2);
              const isCompound = compound.includes(sur2);
              changed = true;
              return { creatorType: c.creatorType || "author", fieldMode: 0,
                lastName: isCompound ? sur2 : name.slice(0, 1),
                firstName: isCompound ? name.slice(2) : name.slice(1) };
            }
          }
          return c;
        });
        if (changed) {
          // getCreators 返回含 id 的对象，直接 setCreators 全量替换
          item.setCreators(next.map((c) => ({
            creatorType: c.creatorType || "author",
            fieldMode: c.fieldMode === 1 ? 1 : 0,
            lastName: c.lastName || "",
            firstName: c.firstName || "",
          })));
          item.saveTx();
          n++;
        }
      } catch (e) { Zotero.logError(e); }
    }
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    pw.show();
    const line = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (mode === "merge" ? (zh ? "已合并姓名：" : "Merged: ") : (zh ? "已拆分姓名：" : "Split: ")) +
      n + (zh ? " 条" : " item(s)"));
    line.setProgress(100);
    pw.startCloseTimer(2500);
  },
};

/* ==================== 知网验证（0.14.8 起，0.14.9 吸收茉莉花 cookiebox 三点改进） ====================
 * 知网风控两种形态：403 滑块 JSON；200 但 no-content 软拦（"抱歉，暂无数据"）。
 * 解除唯一途径：在真实浏览器里过一次安全验证——Zotero 标签页/viewer 与 Zotero.HTTP
 * 共享 profile 默认 cookie 罐，页面里过验证后 XHR 即恢复。
 * 本模块：热词探测（区分软拦/真空结果）→ 开验证窗 → 自动轮询 + 手动确认按钮并行
 * （借鉴茉莉花 cookiebox.ts 的注入面板）→ 通过回调（自动续抓）。
 * 0.14.9：验证通过状态缓存 5 分钟（免重复验证）；等待会话 Promise 去重（并发只开一个窗）。
 */
var CNVerify = {
  // 0.42.1：软拦（no-content 不带验证码 URL）时开**真实搜索页**（预填热词）。
  // 裸首页不执行搜索、不产生完整反爬 cookie；搜索页正常出结果 = 会话已恢复
  // （jasminum getCNKIHomeCookieId 同款思路：带 kw 打开 defaultresult 页）。
  VERIFY_URL: "https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw=%E9%AB%98%E8%A1%80%E5%8E%8B",
  PASS_TTL: 5 * 60 * 1000, // 验证通过状态缓存时长（借鉴茉莉花 COOKIE_EXPIRE_MS）
  _passTime: 0,
  _waitPromise: null,   // 进行中的验证会话（并发去重）
  _manualWaiters: [],
  _closeWaiters: [],
  _panelHint: null,

  _diag(msg) {
    try { _ppDiag("cn-verify: " + msg); } catch (e) { /* ignore */ }
  },

  /** 是否在验证通过后的有效期内（5 分钟内免重复验证） */
  recentlyPassed() {
    return !!(this._passTime && (Date.now() - this._passTime) < this.PASS_TTL);
  },

  /** 探测知网当前是否可用：固定热词搜索，能出结果 = 未被风控。
   *  0.42.1：探测遭 403 时顺手记下滑块 URL——软拦形态（no-content）拿不到链接，
   *  但探测的 403 有；批末验证窗优先用它。 */
  async probe() {
    try {
      const r = await CNFetch._searchCNKI("高血压", "");
      const ok = !r.maybeBlocked && !r.captcha && r.results.length > 0;
      if (ok) this._passTime = Date.now();
      if (r.captcha) this._probeCaptchaUrl = r.captcha;
      this._diag("probe: " + (ok ? "ok" : "blocked") + (r.captcha ? " (403)" : ""));
      return ok;
    } catch (e) {
      this._diag("probe error: " + (e && e.message));
      return false;
    }
  },

  /**
   * 打开知网验证窗并等待通过（自动轮询 + 页面内手动确认按钮并行，最长 5 分钟）。
   * 并发去重：已有验证会话时挂到同一会话上，不再开新窗。
   * 0.42.1：captchaUrl（403 响应里的 verify/home?captchaType=blockPuzzle… 链接）优先——
   * 直接打开**那次拦截对应的滑块页**。此前固定开知网首页：首页本身不被拦、不弹滑块，
   * 用户点「已完成验证」后探测仍 403，永远过不去（真机诊断实踩，jasminum cookiebox
   * passCaptchaToCookieBox(respJson.message) 同款做法）。
   * onPass 在通过后回调（如自动续抓）；onGiveup 超时/关窗时回调。
   */
  async openAndWait(onPass, onGiveup, captchaUrl) {
    if (!this._waitPromise) {
      this._waitPromise = this._waitSession(captchaUrl)
        .finally(() => { this._waitPromise = null; });
    } else {
      this._diag("wait session already running, attaching to it");
    }
    const ok = await this._waitPromise;
    if (ok) {
      if (onPass) { try { onPass(); } catch (e) { Zotero.logError(e); } }
    } else if (onGiveup) {
      try { onGiveup(); } catch (e) { Zotero.logError(e); }
    }
    return ok;
  },

  /** 单个验证会话；resolve true=通过 false=超时/用户关窗 */
  async _waitSession(captchaUrl) {
    const zh = I18n.isZh;
    this._manualWaiters = [];
    this._closeWaiters = [];
    this._panelHint = null;

    // 优先开 403 给的滑块页（带 ident/returnUrl），没有才回落首页
    const targetUrl = (captchaUrl && /^https?:\/\/[\w.]*cnki\.net\//i.test(captchaUrl))
      ? captchaUrl : this.VERIFY_URL;
    this._diag("verify window url=" + targetUrl.slice(0, 120) +
      (captchaUrl ? " (from-403)" : " (home)"));

    // viewer 窗口打开知网（默认 cookie 容器，与 Zotero.HTTP 共享会话）
    let win = null;
    try { win = Zotero.openInViewer(targetUrl); }
    catch (e) { this._diag("openInViewer failed: " + (e && e.message)); }
    if (!win) {
      try { Zotero.getActiveZoteroPane().loadURI(this.VERIFY_URL); }
      catch (e) { try { Zotero.launchURL(this.VERIFY_URL); } catch (e2) { /* ignore */ } }
    }
    if (win) {
      this._injectConfirmPanel(win);
      win.addEventListener("close", () => {
        const ws = this._closeWaiters.splice(0);
        for (const r of ws) { try { r(); } catch (e) { /* ignore */ } }
      });
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("PaperPilot · " + (zh ? "知网验证" : "CNKI verification"));
    const line = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      zh ? "请在打开的知网页面完成滑块验证（若弹出）；若是搜索页，等搜索结果正常显示后，点页面右上角「我已完成验证」（最长 5 分钟）…"
         : "Complete the slider if shown; for the search page, wait until results load, then click the confirm button (up to 5 min)…");
    pw.show();

    const deadline = Date.now() + 5 * 60 * 1000;
    // 0.42.1：cookie 观察驱动验证等待。解题成功的落点是默认 cookie 罐（viewer 与
    // Zotero.HTTP 共享）里知网 cookie 新增/变更；而每次搜索探测的 403 都会**轮换
    // captchaId**（真机实证：5 分钟 68 次探测全部 403、每条都带新 captchaId）——
    // 密集轮询既扰民又可能顶掉用户正在解的题。改为：本地观察 cookie（零请求）→
    // 变更后探测一次；手动确认 → 立即探测；30s 兜底探测。
    const cookieFP = () => {
      try {
        const out = [];
        for (const host of ["cnki.net", "kns.cnki.net"]) {
          for (const c of Services.cookies.getCookiesFromHost(host, {})) {
            out.push(host + "|" + c.name + "=" + String(c.value).slice(0, 24));
          }
        }
        return out.sort().join(";");
      } catch (e) { return "err"; }
    };
    const passedNow = async () => {
      if (await this.probe()) {
        line.setText(zh ? "✓ 验证已通过，知网恢复访问" : "✓ Verification passed");
        line.setProgress(100);
        pw.startCloseTimer(2500);
        try { if (win) win.close(); } catch (e) { /* ignore */ }
        return true;
      }
      lastFP = cookieFP(); // 探测本身也会写 cookie（403 设 KNS2COOKIE 等），快照复位防自激
      return false;
    };
    let lastFP = cookieFP();
    let lastFallback = Date.now();
    // 开窗后先留 8s 给用户解题
    await new Promise((r) => setTimeout(r, 8000));
    while (Date.now() < deadline) {
      const race = await Promise.race([
        new Promise((r) => setTimeout(() => r("tick"), 2000)),
        new Promise((r) => this._manualWaiters.push(() => r("manual"))),
        new Promise((r) => this._closeWaiters.push(() => r("closed"))),
      ]);
      if (race === "closed") {
        this._diag("verification window closed by user");
        line.setError();
        line.setText(zh ? "验证窗口已关闭，验证未完成" : "Verification window closed");
        pw.startCloseTimer(3500);
        return false;
      }
      if (race === "manual") {
        if (await passedNow()) return true;
        this._flashPanel(zh
          ? "仍未检测到通过——请确认已在页面中完成滑块，或稍等自动检测"
          : "Not passed yet — finish the slider, or wait for auto-detection");
        continue;
      }
      const fp = cookieFP();
      const changed = fp !== lastFP;
      const due = Date.now() - lastFallback > 30000;
      if (changed || due) {
        this._diag("cookie " + (changed ? "changed" : "fallback-due") + " → probe");
        lastFP = cookieFP();
        lastFallback = Date.now();
        if (await passedNow()) return true;
      }
    }
    line.setError();
    line.setText(zh ? "等待超时——可稍后从工具菜单重新发起「知网验证」"
                    : "Timed out — retry from the Tools menu later");
    pw.startCloseTimer(4000);
    try { if (win) win.close(); } catch (e) { /* ignore */ }
    return false;
  },

  /** 往验证窗口注入悬浮确认面板（茉莉花 cookiebox 同款：红框 + 绿色确认按钮） */
  _injectConfirmPanel(win) {
    const inject = () => {
      try {
        const zh = I18n.isZh;
        const doc = win.document;
        const XHTML = "http://www.w3.org/1999/xhtml";
        const box = doc.createElementNS(XHTML, "div");
        box.setAttribute("style",
          "position:fixed;top:10px;right:10px;z-index:10000;padding:12px 14px;" +
          "background:#ffffff;border:2px solid #c0392b;border-radius:8px;" +
          "box-shadow:0 2px 8px rgba(0,0,0,0.3);font-family:sans-serif;");
        const hint = doc.createElementNS(XHTML, "div");
        hint.textContent = zh ? "PaperPilot：完成滑块（若弹出）或等搜索结果正常显示后，点击按钮"
                              : "PaperPilot: finish the slider (if shown) or wait for search results, then click";
        hint.setAttribute("style", "font-size:12px;color:#333;margin-bottom:8px;max-width:230px;");
        const btn = doc.createElementNS(XHTML, "button");
        btn.textContent = zh ? "我已完成验证" : "Done verifying";
        btn.setAttribute("style",
          "font-size:13px;padding:6px 14px;background:#2e7d32;color:#ffffff;" +
          "border:none;border-radius:6px;cursor:pointer;font-weight:bold;");
        btn.addEventListener("click", () => {
          const ws = this._manualWaiters.splice(0);
          for (const r of ws) { try { r(); } catch (e) { /* ignore */ } }
        });
        box.appendChild(hint);
        box.appendChild(btn);
        (doc.documentElement || doc.body).appendChild(box);
        this._panelHint = hint;
      } catch (e) {
        this._diag("inject panel failed: " + (e && e.message));
      }
    };
    try {
      if (win.document && win.document.readyState === "complete") inject();
      else win.addEventListener("load", inject, { once: true });
    } catch (e) {
      this._diag("panel setup failed: " + (e && e.message));
    }
  },

  /** 手动确认但探测未通过时，把面板提示变红 */
  _flashPanel(msg) {
    try {
      if (this._panelHint) {
        this._panelHint.textContent = msg;
        this._panelHint.style.color = "#c0392b";
      }
    } catch (e) { /* ignore */ }
  },

  /** 菜单入口：主动发起验证（先探测；5 分钟内刚验证过则提示限流可能） */
  async interactive() {
    const zh = I18n.isZh;
    if (await this.probe()) {
      Zotero.alert(null, "PaperPilot",
        zh ? "知网访问正常，无需验证。" : "CNKI is accessible — no verification needed.");
      return;
    }
    if (this.recentlyPassed()) {
      Zotero.alert(null, "PaperPilot",
        zh ? "5 分钟内刚完成过验证但仍被拦截——可能是知网访问频次限制，请几分钟后自动解除再试。"
           : "Verified within the last 5 minutes but still blocked — likely rate limiting; try again in a few minutes.");
      return;
    }
    await this.openAndWait(() => {
      try {
        Zotero.alert(null, "PaperPilot",
          zh ? "✓ 知网验证已通过，可以重新抓取了。" : "✓ CNKI verification passed — fetch again now.");
      } catch (e) { /* ignore */ }
    });
  },
};
