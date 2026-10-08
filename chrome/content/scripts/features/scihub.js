/* PaperPilot Sci-Hub / Sci-Net 补全文（0.27.0）
 * 用途：Unpaywall 未命中时的补充渠道 —— 有 DOI 但既无开放获取版本、也无 PDF 的条目。
 * 流程：按镜像顺序探测 Sci-Hub 文章页（默认 sci-hub.ru → sci-hub.se → sci-hub.st，可配置）
 *      → 解析 PDF 直链（embed#pdf / citation_pdf_url / object / 下载链 / JS 跳转，兼容 " = " 带空格写法）
 *      → 下载字节并用 %PDF 魔数校验 → 交 OAFetch 挂附件。
 * 兜底：Sci-Hub 未收录（2021 年后文献居多）时可选接力 Sci-Net（社区上传，见 fetchFromSciNet）。
 * 验证页：镜像要求人机验证（ALTCHA .question/.answer / Cloudflare 盾）时返回 captcha，
 *        由调用方在 Zotero 中打开页面；验证状态存于 Zotero 会话 cookie 罐，完成后重跑即可。
 * 说明：本模块不做渠道开关判断（由 OAFetch 依 pref 决定是否调用）；sci-hub.ru 页面模板里
 *      属性会写成 `class = "..."`（等号两侧带空格），所有正则必须容忍。
 * 声明：仅供个人学术研究用途；如所在机构/地区有版权要求，请在插件设置中关闭。
 * pref：scihubMirrors（逗号/换行分隔的镜像列表，允许只写域名）、scinetUrl。
 */
/* global Zotero, Prefs, TextDecoder, URL */

var SciHub = {
  DEFAULT_MIRRORS: ["sci-hub.ru", "sci-hub.se", "sci-hub.st"],
  DEFAULT_SCINET: "https://sci-net.xyz",
  // 移动端 UA：镜像对移动端返回更简单、可稳定解析的页面模板（参考 zotero-scihub 的成熟做法）
  UA: "Mozilla/5.0 (iPhone; CPU iPhone OS 11_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1",
  MIN_INTERVAL_MS: 1200,
  TIMEOUT_MS: 30000,
  _lastReqAt: 0,

  _debug(msg) {
    try { Zotero.debug("PaperPilot scihub: " + msg); } catch (e) { /* ignore */ }
  },

  /** 镜像列表：pref 覆盖默认；允许只写域名（自动补 https://、去尾斜杠） */
  mirrors() {
    let raw = "";
    try { raw = String(Prefs.get("scihubMirrors", "") || ""); } catch (e) { /* ignore */ }
    const list = raw.split(/[,，;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^https?:\/\//i.test(s) ? s : "https://" + s).replace(/\/+$/, ""));
    return list.length ? list : this.DEFAULT_MIRRORS.map((m) => "https://" + m);
  },

  /** Sci-Net 基地址（pref 覆盖默认） */
  scinetBase() {
    let raw = "";
    try { raw = String(Prefs.get("scinetUrl", "") || ""); } catch (e) { /* ignore */ }
    raw = raw.trim() || this.DEFAULT_SCINET;
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    return raw.replace(/\/+$/, "");
  },

  /* ================= 网络 ================= */

  /** 任意两次请求启动间隔 ≥ MIN_INTERVAL_MS（防触发镜像反爬） */
  async _throttle() {
    const gap = Date.now() - this._lastReqAt;
    if (gap < this.MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, this.MIN_INTERVAL_MS - gap));
    }
    this._lastReqAt = Date.now();
  },

  /** 带限速的 GET → { buf, status, finalUrl } | { transport: true, error } */
  async _getBuffer(url, referer) {
    await this._throttle();
    const headers = { "User-Agent": this.UA };
    if (referer) headers.Referer = referer;
    let xhr = null;
    try {
      xhr = await Zotero.HTTP.request("GET", url, {
        responseType: "arraybuffer",
        noCache: true,        // 验证页带长缓存：不过缓存，验证后重跑才不会拿到旧验证页
        successCodes: false,  // 404 是「未收录」的正常应答，不是传输错误
        timeout: this.TIMEOUT_MS,
        headers,
      });
    } catch (e) {
      return { transport: true, error: e };
    }
    if (!xhr || !xhr.status) {
      return { transport: true, error: (xhr && xhr.statusText) || "no response" };
    }
    return { buf: new Uint8Array(xhr.response || []), status: xhr.status, finalUrl: xhr.responseURL || url };
  },

  /* ================= 解析（纯函数，便于单测） ================= */

  _decode(buf) {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(buf); }
    catch (e) { return ""; }
  },

  /** %PDF 魔数 */
  _isPdf(buf) {
    return !!(buf && buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);
  },

  /** HTML 实体最小还原（属性值里常见 &amp;；&amp; 放最后避免二次解码） */
  _unescape(s) {
    return String(s || "")
      .replace(/&quot;/gi, "\"")
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
  },

  /** 相对 / 协议相对（//host/…）→ 绝对；去 #fragment（下载链常带 #navpanes=0&view=FitH） */
  _resolveUrl(raw, base) {
    if (!raw) return "";
    const u = this._unescape(raw).trim().replace(/\\\//g, "/");
    try {
      const abs = new URL(u, base || undefined);
      abs.hash = "";
      return abs.href;
    } catch (e) { return u; }
  },

  _looksPdfUrl(u) {
    return /\.pdf(?:[?#]|$)/i.test(u) || /\/downloads?\//i.test(u) || /dacemirror/i.test(u);
  },

  /** 标签属性取值：name 指定时取该属性，否则 src / data 依次试（(?:^|\s) 防 data-* 前缀误配） */
  _attrUrl(tag, name) {
    const names = name ? [name] : ["src", "data"];
    for (const n of names) {
      const m = String(tag).match(new RegExp("(?:^|\\s)" + n + "\\s*=\\s*[\"']([^\"']+)[\"']", "i"));
      if (m && m[1]) return this._unescape(m[1]);
    }
    return "";
  },

  /** 从文章页 HTML 解析 PDF 直链（按镜像模板逐级尝试；容忍 " = " 带空格写法） */
  _extractPdfUrl(html, baseUrl) {
    const s = String(html || "");
    if (!s) return "";
    const mediaTags = s.match(/<(?:embed|iframe|object)\b[^>]*>/gi) || [];
    // ① id="pdf" 的 embed/iframe（.tf/.st 模板）
    for (const t of mediaTags) {
      if (/\bid\s*=\s*["']pdf["']/i.test(t)) {
        const u = this._attrUrl(t);
        if (u) return this._resolveUrl(u, baseUrl);
      }
    }
    // ② <meta name="citation_pdf_url" content="…">（.ru 2026）
    for (const t of s.match(/<meta\b[^>]*>/gi) || []) {
      if (/\bname\s*=\s*["']citation_pdf_url["']/i.test(t)) {
        const u = this._attrUrl(t, "content");
        if (u) return this._resolveUrl(u, baseUrl);
      }
    }
    // ③ <object type="application/pdf" data="…">（.ru）
    for (const t of mediaTags) {
      if (/^<object\b/i.test(t) && /\btype\s*=\s*["']application\/pdf["']/i.test(t)) {
        const u = this._attrUrl(t);
        if (u) return this._resolveUrl(u, baseUrl);
      }
    }
    // ④ 任意媒体标签里形似 PDF 的 src/data
    for (const t of mediaTags) {
      const u = this._attrUrl(t);
      if (u && this._looksPdfUrl(u)) return this._resolveUrl(u, baseUrl);
    }
    // ⑤ 下载按钮 <a href="…pdf">
    for (const t of s.match(/<a\b[^>]*>/gi) || []) {
      const u = this._attrUrl(t, "href");
      if (u && this._looksPdfUrl(u)) return this._resolveUrl(u, baseUrl);
    }
    // ⑥ 老版「保存」按钮的 JS 跳转：location.href = '…'（路径写作 \/\/host\/…）
    const m = s.match(/location\s*\.\s*href\s*=\s*['"]([^'"]+)['"]/i);
    if (m && m[1]) {
      const u = this._resolveUrl(m[1], baseUrl);
      if (this._looksPdfUrl(u) || /\.pdf/i.test(u)) return u;
    }
    return "";
  },

  /** 验证页判定：ALTCHA（.question/.answer 组合）+ 文案特征 + Cloudflare 盾 */
  _isCaptcha(html) {
    const s = String(html || "");
    if (!s) return false;
    if (/class\s*=\s*["'][^"']*\bquestion\b[^"']*["']/.test(s) &&
        /class\s*=\s*["'][^"']*\banswer\b[^"']*["']/.test(s)) return true;
    if (/проверка на робота|Вы робот|you a robot/i.test(s)) return true;
    if (/Just a moment|Checking your browser|cf-browser-verification|challenge-platform|Enable JavaScript and cookies/i.test(s)) return true;
    return false;
  },

  /** 「未收录 / 查询不到」页特征（无正文页 / .tf 提示语 / .ru 俄文提示），用于日志与语义区分 */
  _isNotAvailable(html) {
    const s = String(html || "");
    if (!s.trim()) return true;
    if (/Please try to search again using DOI/i.test(s)) return true;
    if (/статья не найдена в базе|(отсутствует|нет) в (моей )?базе|article not found|not found in the database/i.test(s)) return true;
    // 无正文、也无任何媒体标签（.st 未收录时返回近空页）→ 视为未收录；
    // 注意正常文章页 body 可能只有 embed/iframe 没有文字，不能只看「有没有文字」
    const bodyMatch = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const body = bodyMatch ? bodyMatch[1] : s;
    const text = body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, "");
    if (!text && !/<(?:embed|iframe|object|img|a|video|audio|canvas)\b/i.test(body)) return true;
    return false;
  },

  /* ================= 抓取编排 ================= */

  /**
   * 抓一个「文章页 → PDF 字节」，统一处理传输失败 / 404 / 验证页 / 直出 PDF / 页面解析 + 下载校验。
   * 返回 { status: "ok", bytes, pdfUrl, pageUrl, host }
   *    | { status: "not-found" | "captcha" | "unreachable" | "error", host, pageUrl?, message? }
   */
  async _fetchPageForPdf(pageUrl, meta) {
    const host = (meta && meta.host) || "";
    const r = await this._getBuffer(pageUrl);
    if (r.transport) {
      return { status: "unreachable", host, pageUrl, message: String((r.error && r.error.message) || r.error || "").slice(0, 120) };
    }
    if (r.status === 404 || r.status === 410) return { status: "not-found", host, pageUrl };
    if (r.status !== 200) return { status: "error", host, pageUrl, message: "HTTP " + r.status };
    if (this._isPdf(r.buf)) return { status: "ok", bytes: r.buf, pdfUrl: pageUrl, pageUrl, host };

    const html = this._decode(r.buf);
    if (this._isCaptcha(html)) return { status: "captcha", host, pageUrl };
    const pdfUrl = this._extractPdfUrl(html, r.finalUrl || pageUrl);
    if (!pdfUrl) {
      // 明确「未收录」（含近空页）→ 各镜像共享同一数据库，不再换镜像；
      // 其余「有内容但解析不出 PDF」更可能是模板变化 / 风控页 → 当镜像级失败，换下一个镜像再试
      if (this._isNotAvailable(html)) {
        this._debug("未收录（" + pageUrl + "）");
        return { status: "not-found", host, pageUrl };
      }
      this._debug("页面结构未识别（" + pageUrl + "），换下一个镜像");
      return { status: "error", host, pageUrl, message: "unrecognised page" };
    }

    const dl = await this._getBuffer(pdfUrl, r.finalUrl || pageUrl);
    if (dl.transport) return { status: "unreachable", host, pageUrl, message: "pdf download failed" };
    if (dl.status !== 200) return { status: "error", host, pageUrl, message: "HTTP " + dl.status + " (pdf)" };
    if (!this._isPdf(dl.buf)) {
      if (this._isCaptcha(this._decode(dl.buf))) return { status: "captcha", host, pageUrl };
      return { status: "error", host, pageUrl, message: "not a pdf" };
    }
    return { status: "ok", bytes: dl.buf, pdfUrl, pageUrl, host };
  },

  /**
   * Sci-Hub：按镜像顺序尝试。任一镜像返回 not-found 即停（各镜像共享同一数据库，再审无益）；
   * 验证页 / 不可达 / 其它错误则换下一个镜像；全部失败时优先返回「验证页」（可修复，供用户处理）。
   */
  async fetchPdf(doi) {
    const mirrors = this.mirrors();
    let lastCaptcha = null;
    let last = { status: "error", host: "", message: "no mirrors" };
    for (const m of mirrors) {
      const host = m.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const r = await this._fetchPageForPdf(m + "/" + doi, { host });
      if (r.status === "ok" || r.status === "not-found") return r;
      if (r.status === "captcha" && !lastCaptcha) lastCaptcha = r;
      last = r;
      this._debug("镜像 " + host + " 失败（" + r.status + (r.message ? "：" + r.message : "") + "），换下一个");
    }
    return lastCaptcha || last;
  },

  /** Sci-Net：单地址兜底（收录 2021 年后新文献；未知 DOI 会跳回首页 → 解析不到则 not-found） */
  async fetchFromSciNet(doi) {
    const base = this.scinetBase();
    const host = base.replace(/^https?:\/\//, "");
    return this._fetchPageForPdf(base + "/" + doi, { host });
  },
};
