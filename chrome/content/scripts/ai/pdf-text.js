/* PaperPilot PDF 文本结构化分析（0.33.0）
 *
 * 定位：全文对照翻译的「前置处理器」。此前对照翻译直接把 Zotero 全文索引的
 * 扁平文本按字符数切块送翻，学术论文的三类问题会原样进入译文：
 *   ① 公式行被当普通句子翻译 → 符号被改写得面目全非；
 *   ② 图表内的坐标轴刻度 / 图例碎片混进正文 → 译文出现"0.2 0.4 0.6"这类行；
 *   ③ 页眉页脚 / 页码 / DOI 行每页重复 → 翻译预算被白白烧掉。
 * 本模块把文本组织成「块」（block）：{ text, kind: body|caption|formula, page }，
 * 上层（bilingual-translate）按 kind 决定「翻译 / 直出 / 丢弃」。
 *
 * 两条来源路径，产出同一种 blocks：
 *   A. 阅读器路径（首选，PDF 正在阅读器里打开时）：逐页调用 Zotero 给 pdf.js 打的
 *      补丁接口 pdfDocument.getPageData({pageIndex})（朗读功能同款），
 *      字符带 lineBreakAfter / paragraphBreakAfter 断句标记 → 天然有段落边界 + 页码；
 *   B. 扁平路径（兜底，条目未打开时）：Zotero 全文索引缓存（.zotero-ft-cache）的
 *      扁平文本 → 按空行/换行切段，用同一套词法判定打 kind（无页码，page=0）。
 *
 * 设计约束（改代码前必读）：
 *   1. 词法判定（caption/formula/junk）与段落装配全是**纯函数**，可在 Node 离线单测
 *      （test/pdf-text.test.js）；阅读器桥接（readerForAttachment/blocksFromReader/
 *      locatePage）全部 try/catch 包裹，任何一步失败都静默返回 null/false，
 *      绝不让对照翻译整体报错——兜底路径永远在。
 *   2. 判定阈值宁缺毋滥：把正常句子误判成公式/垃圾的代价（丢内容）远高于漏判
 *      （多翻一行），所以 junk 只拦「高置信」模式（纯页码/DOI/坐标轴刻度串）。
 *   3. 不重造排版分析：多栏阅读顺序交给 pdf.js 的文本抽取顺序（Zotero 的 chars 流
 *      已按内容流给出），本模块只做段落级组织与分类，不做几何排版重建。
 */
/* global Zotero */

var PdfText = (function () {
  "use strict";

  /* ==================== 词法判定（纯函数） ==================== */

  /** 图注/表注开头：Figure 3 / Fig. 2a / Table 1 / Algorithm 2 / 图3 / 表1 …
   *  命中只是打 caption 标记（照常翻译、样式区分），不会丢内容，
   *  所以 "Figure 3 shows ..." 这类正文句子被命中也无害。 */
  function isCaptionLine(s) {
    const t = String(s || "").trim();
    return /^\s*(fig(ure)?s?\.?|table|algorithm|scheme|exhibit|box)\s*[0-9]+/i.test(t) ||
      /^\s*(图|表|算法|附图)\s*[0-9]/.test(t);
  }

  const MATH_CHARS = new Set(
    "∑∫∂∇√∞≈≠≤≥±×÷→↔⇒⇔∈∀∃∪∩⊂⊃⊕⊗∝°′″" +
    "αβγδεζηθικλμνξοπρστυφχψω" +
    "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ");

  /** 整段是否是公式/数学表达式（应原样保留，不送翻译）。
   *  三条独立通路，命中任一即判公式：
   *  ① LaTeX 命令 / $...$ 定界（PDF 文本层偶发抽成 LaTeX 残片）；
   *  ② 数学符号密度高且几乎无实词（符号汤）；
   *  ③ 单字母变量串 + 运算符（x_1 + x_2 = y 之类）。 */
  function isFormulaText(s) {
    const t = String(s || "");
    if (Array.from(t.replace(/\s/g, "")).length < 4) return false;
    // ① LaTeX 痕迹
    if (/\\(frac|sqrt|sum|prod|int|oint|lim|log|ln|exp|sin|cos|tan|left|right|begin|end|mathrm|mathbf|mathcal|operatorname|times|cdot|leq|geq|approx)\b/.test(t)) return true;
    if (/\$\$?[^$\n]{2,80}\$\$?/.test(t)) return true;
    // ② 符号密度
    let math = 0;
    let nonspace = 0;
    for (const ch of Array.from(t)) {
      if (/\s/.test(ch)) continue;
      nonspace++;
      if (MATH_CHARS.has(ch)) math++;
    }
    const tokens = t.split(/[^A-Za-z]+/).filter(Boolean);
    const words = tokens.filter((w) => w.length >= 3).length;
    if (math >= 2 && math / Math.max(1, nonspace) >= 0.10 && words <= 2) return true;
    // ③ 变量赋值串：单字母 token 占主导 + 有运算符
    const single = tokens.filter((w) => w.length === 1).length;
    if (single >= 4 && single >= words * 2 && /[=+\-*/^_<≥≤≈]/.test(t)) return true;
    return false;
  }

  /** 高置信垃圾行（不送翻）：纯页码 / DOI / arXiv 号 / URL / 邮箱 / 坐标轴刻度串。
   *  调用顺序必须是 caption → junk → formula（"Fig. 1a" 先被 caption 接住）。 */
  function looksLikeJunkLine(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    if (t.length > 90) return false;
    // 纯页码 / 页码区间 / 期刊卷期页
    if (/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t)) return true;
    if (/^vol\.?\s*\d+/i.test(t) && t.length < 30) return true;
    // DOI / arXiv / URL / 邮箱（整行基本只有它）
    if (/^doi\s*:\s*10\./i.test(t) || /^10\.\d{4,9}\/\S+$/.test(t)) return true;
    if (/^arxiv\s*:\s*\d{4}\.\d{4,5}(v\d+)?$/i.test(t)) return true;
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return true;
    if (/^\S+@\S+\.\S{2,}$/.test(t) && !/\s/.test(t)) return true;
    // 坐标轴刻度 / 图例碎片：≥3 个 token，每个都是数字/百分数/单字符，且含至少一个数字 token
    const parts = t.split(/\s+/);
    if (parts.length >= 3 && parts.length <= 24) {
      const numeric = parts.filter((p) => /^[\d.,:]+[%‰°]?$/.test(p));
      if (numeric.length === parts.length && numeric.some((p) => /\d/.test(p))) return true;
      // 短碎片：无 ≥3 字母的实词 + 含数字/数学符号（"σ (MPa)"、"10 μm"、"x 10⁻³"）
      if (t.length <= 40 &&
          parts.every((p) => !/^[A-Za-z]{3,}$/.test(p)) &&
          /[\d×Ø°±≈≤≥∑∫√αβγσμπ]/.test(t) &&
          !/[.!?。！？；;]\s*$/.test(t)) return true;
    }
    return false;
  }

  /* ==================== 段落装配（纯函数） ==================== */

  /** getPageData 的字符流 → 段落数组。
   *  字段（Zotero reader 实证）：c / ignorable / spaceAfter / lineBreakAfter /
   *  paragraphBreakAfter。行内以空格连接、行间合并进同段（连字符断词保留原样，
   *  与 compare.js 页文本口径一致）。 */
  function charsToParagraphs(chars) {
    const out = [];
    let para = "";
    let line = "";
    const eat = () => {
      const lt = line.replace(/\s+/g, " ").trim();
      if (lt) para = para ? para + " " + lt : lt;
      line = "";
    };
    const flush = () => { eat(); const p = para.trim(); if (p) out.push(p); para = ""; };
    for (const ch of (chars || [])) {
      if (!ch || ch.ignorable || !ch.c) continue;
      line += ch.c;
      if (ch.paragraphBreakAfter || ch.lineBreakAfter) {
        eat();
        if (ch.paragraphBreakAfter) flush();
      } else if (ch.spaceAfter) {
        line += " ";
      }
    }
    flush();
    return out;
  }

  /** 段落文本 → 分类。顺序固定：caption → formula → junk → body。
   *  ★ formula 必须在 junk 之前：像 "σ² = α² + β²" 这类短公式同时命中
   *  「短碎片」垃圾规则，先判公式就不会把真公式当轴标签丢掉——
   *  宁可把垃圾标成 formula 保留（少翻一行），不可把公式当垃圾删除（丢内容）。 */
  function classify(para) {
    if (isCaptionLine(para)) return "caption";
    if (isFormulaText(para)) return "formula";
    if (looksLikeJunkLine(para)) return "junk";
    return "body";
  }

  /* ==================== 块分析（纯函数） ==================== */

  /** 扁平全文（全文索引缓存）→ blocks。page 恒为 0（无页码信息）。
   *  跨页重复的短行（页眉/页脚在全文索引里每页出现一次）出现 ≥3 次即丢。 */
  function analyzeText(text) {
    const paras = String(text || "")
      .split(/\n{2,}|\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const counts = new Map();
    for (const p of paras) {
      if (p.length <= 70) counts.set(p, (counts.get(p) || 0) + 1);
    }
    const blocks = [];
    let dropped = 0;
    for (const p of paras) {
      if ((counts.get(p) || 0) >= 3 || classify(p) === "junk") { dropped++; continue; }
      blocks.push({ text: p, kind: classify(p), page: 0 });
    }
    return { blocks, dropped, via: "flat" };
  }

  /** 多页段落（页码 1 起）→ blocks。页首/页尾的跨页重复行（页眉页脚）≥3 页出现即丢。 */
  function pagesToBlocks(pages) {
    // pages: [[para, ...], ...]，下标 0 = PDF 第 1 页
    const edge = new Map();
    for (const paras of pages) {
      if (!paras || !paras.length) continue;
      for (const i of [0, paras.length - 1]) {
        const t = paras[i];
        if (t && t.length <= 70) edge.set(t, (edge.get(t) || 0) + 1);
      }
    }
    const blocks = [];
    let dropped = 0;
    for (let pi = 0; pi < pages.length; pi++) {
      for (const para of (pages[pi] || [])) {
        if ((edge.get(para) || 0) >= 3 || classify(para) === "junk") { dropped++; continue; }
        blocks.push({ text: para, kind: classify(para), page: pi + 1 });
      }
    }
    return { blocks, dropped };
  }

  /** blocks → 翻译单元（units）。规则：
   *  - formula 块独立成单元（上层直出不送翻）；
   *  - 相邻同 kind 的 body/caption 合并到 maxChars 为止（同旧 _chunk 语义，省请求数）；
   *  - 不同 kind 不合并（图注不并进正文）；
   *  - 单块超长硬切（同旧 _chunk）。单元 page = 首块页码（供定位）。 */
  function blocksToUnits(blocks, maxChars) {
    const cap = Math.max(200, Number(maxChars) || 1200);
    const units = [];
    let cur = null;
    const push = () => { if (cur) { units.push(cur); cur = null; } };
    for (const b of (blocks || [])) {
      const text = String(b && b.text || "").trim();
      if (!text) continue;
      const kind = b.kind || "body";
      const page = b.page || 0;
      if (kind === "formula") {
        push();
        units.push({ text, kind: "formula", page });
        continue;
      }
      if (text.length > cap) {
        push();
        for (let i = 0; i < text.length; i += cap) {
          units.push({ text: text.slice(i, i + cap), kind, page });
        }
        continue;
      }
      if (cur && (cur.kind !== kind || cur.text.length + text.length + 1 > cap)) push();
      if (!cur) cur = { text: "", kind, page };
      cur.text = cur.text ? cur.text + "\n" + text : text;
    }
    push();
    return units;
  }

  /* ==================== 阅读器桥接（运行时；全部静默降级） ==================== */

  /** 附件当前是否开着阅读器（不含 compare 的预览实例）。 */
  function readerForAttachment(att) {
    if (!att || typeof Zotero === "undefined" || !Zotero.Reader) return null;
    try {
      if (typeof Zotero.Reader.getByItemID === "function") {
        const r = Zotero.Reader.getByItemID(att.id);
        if (r) return r;
      }
    } catch (e) { /* ignore */ }
    try {
      for (const r of (Zotero.Reader._readers || [])) {
        if (r && r.itemID === att.id) return r;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 从 Reader 实例里挖 pdf.js 视图（compare.js resolveViewer 同款路径）。 */
  function viewerOf(reader) {
    const pick = (w) => {
      if (!w) return null;
      let uw = w;
      try { uw = w.wrappedJSObject || w; } catch (e) { /* 普通窗口 */ }
      const app = uw.PDFViewerApplication;
      return (app && app.pdfDocument) ? { win: uw, app } : null;
    };
    try {
      const ir = reader && reader._internalReader;
      const pv = ir && ir._primaryView;
      const hit = pick(pv && pv._iframeWindow);
      if (hit) return hit;
      const rw = reader && reader._iframeWindow;
      if (rw && rw.document) {
        for (const f of rw.document.querySelectorAll("iframe")) {
          const h2 = pick(f.contentWindow);
          if (h2) return h2;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 参数克隆到 pdf.js 隔间（getPageData 内部结构化克隆给 worker，
   *  直传普通对象报 "The object could not be cloned."——compare.js 实证）。 */
  function cloneForWorker(obj, win) {
    try {
      const Cu = (typeof Components !== "undefined" && Components && Components.utils) || null;
      if (Cu && Cu.cloneInto) {
        const scopes = [];
        try { if (win && win.wrappedJSObject) scopes.push(win.wrappedJSObject); } catch (e) { /* ignore */ }
        try { if (win) scopes.push(win); } catch (e) { /* ignore */ }
        for (const s of scopes) {
          try { return Cu.cloneInto(obj, s); } catch (e) { /* 逐个降级 */ }
        }
      }
    } catch (e) { /* ignore */ }
    return obj;
  }

  /** 阅读器路径：逐页 getPageData → 段落 → blocks（带页码）。
   *  任何一步失败返回 null（调用方回落扁平路径）。maxPages 防御性上限。 */
  async function blocksFromReader(reader, opts) {
    const v = viewerOf(reader);
    if (!v || !v.app || !v.app.pdfDocument ||
        typeof v.app.pdfDocument.getPageData !== "function") return null;
    let total = 0;
    try { total = v.app.pdfViewer && v.app.pdfViewer.pagesCount; } catch (e) { /* ignore */ }
    if (!total) { try { total = v.app.pdfDocument.numPages; } catch (e) { /* ignore */ } }
    if (!total || total < 1) return null;
    const cap = Math.min(total, (opts && opts.maxPages) || 300);
    const pages = [];
    for (let i = 0; i < cap; i++) {
      let paras = [];
      try {
        const data = await v.app.pdfDocument.getPageData(cloneForWorker({ pageIndex: i }, v.win));
        paras = charsToParagraphs(data && data.chars);
      } catch (e) {
        paras = []; // 单页失败不拖垮整篇
      }
      pages.push(paras);
    }
    const r = pagesToBlocks(pages);
    if (!r.blocks.length) return null;
    r.via = "reader";
    r.pages = cap;
    return r;
  }

  /** 段落级定位：把阅读器滚到 PDF 第 page 页。
   *  返回 false = 没有已打开的阅读器（调用方可选择先打开阅读器再跳）。 */
  function locatePage(reader, page) {
    const v = viewerOf(reader);
    if (!v || !v.app) return false;
    const want = Math.max(1, Math.round(Number(page) || 1));
    try {
      const doc = v.win.document;
      const container = doc.getElementById("viewerContainer");
      const el = doc.querySelector('.page[data-page-number="' + want + '"]');
      if (container && el) {
        const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top +
          container.scrollTop;
        container.scrollTop = top;
        return true;
      }
    } catch (e) { /* ignore */ }
    try { v.app.pdfViewer.currentPageNumber = want; return true; } catch (e) { /* ignore */ }
    return false;
  }

  return {
    // 词法判定（纯）
    isCaptionLine, isFormulaText, looksLikeJunkLine, classify,
    // 段落装配（纯）
    charsToParagraphs, analyzeText, pagesToBlocks, blocksToUnits,
    // 阅读器桥接（运行时）
    readerForAttachment, blocksFromReader, locatePage, viewerOf,
  };
})();
