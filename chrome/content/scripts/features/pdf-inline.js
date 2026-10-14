/* PaperPilot PDF 原位对照翻译（0.34.0）
 *
 * 与「双栏对照窗口」（bilingual.xhtml，提取文本另开窗口逐段罗列）的区别：
 * 本模块**不动原版页面排版**，把每段译文按**原文段落的真实坐标**叠加回 PDF 页面，
 * 于是译文与原文在同一页、同一位置逐段对应——即 PDF2zh 那类「原位对照」效果。
 *
 * 实现路线（为什么不重造渲染引擎）：
 *   ① 段落坐标**不自己解析 PDF**，而是读 pdf.js 已渲染的 **textLayer**：
 *      页元素 `.page[data-page-number]` → `.textLayer` → 一堆绝对定位的 `span`。
 *      每个 span 用 getBoundingClientRect 换算成「相对页元素」的坐标 ——
 *      这样与 pdf.js 的缩放/DPR/CSS 变量实现解耦（不猜它用 px 还是 --scale-factor）。
 *   ② 段落切分：span → 行（top 聚类）→ 段（行距/缩进/行尾判定）。
 *      纯函数，可在 Node 离线单测（test/pdf-inline.test.js）。
 *   ③ 渲染：页元素内注入 `.pp-pit-layer`（absolute/inset:0），每段一张译文卡
 *      `.pp-pit-card`，定位到该段 bbox；卡片字号自适应（内容超框自动降档）。
 *      原文文字按模式淡化/保留 —— 「对照」靠同位置叠加实现，不是分屏。
 *   ④ 增量与同步：pdf.js **只渲染可见页**（懒加载）→ 监听 eventBus 的
 *      `textlayerrendered`，哪页就绪就处理哪页；缩放/重排会重建 textLayer →
 *      同事件再次触发 → 按旧坐标作废、用新坐标重绘（译文取自缓存，零请求）。
 *   ⑤ 公式与垃圾行：分类复用 PdfText.classify（单一真源）——
 *      formula 段落**不翻译、不叠加**（原文原样保留）；junk（页眉页脚/页码/DOI）跳过。
 *
 * 交互：
 *   · 阅读器工具栏按钮（官方 renderToolbar 扩展位，与主题按钮同一打法）开关；
 *   · 卡片默认 pointer-events:none（不干扰 pdf.js 的划词选择），可在设置里开「可选中」；
 *   · 模式 pref `pdfInlineMode`：overlay（译文覆盖，原文淡显）/ bilingual（原文清晰+半透明译文）/ off；
 *   · pref `pdfInlineFontScale` 微调译文卡字号；
 *   · 翻译串行队列（免费引擎限流友好）+ 全局去重缓存 + 可停止。
 *
 * 边界：扫描版 PDF（无文本层）没有 span → 明确提示需先 OCR，不静默空白；
 *       AI/引擎未就绪时按钮禁用并给出可读原因（复用 TranslateSvc.unavailableHint）。
 */
/* global Zotero, Services, Prefs, I18n, TranslateSvc, PdfText, AIChat, ItemSel */

var PdfInline = (function () {
  "use strict";

  const STYLE_ID = "pp-pit-style";
  const BTN_ID = "paperpilot-inline-reader-button";
  const LAYER_CLS = "pp-pit-layer";
  const CARD_CLS = "pp-pit-card";
  const SRC_CLS = "pp-pit-src";          // 加在原文 span 上（按模式淡化）
  const PREF_MODE = "pdfInlineMode";     // overlay | bilingual | off
  const PREF_SCALE = "pdfInlineFontScale";
  const PREF_SELECTABLE = "pdfInlineSelectable";
  const PREF_GAP_MS = "pdfInlineGapMs";  // 段间节流（免费引擎限流友好）

  const HTML_NS = "http://www.w3.org/1999/xhtml";

  /* ==================== 纯函数：span → 行 → 段 ==================== */

  /** 行聚类容差：同行的 top 差不超过 max(2px, 0.45×字号) */
  function _rowTol(fontSize) {
    return Math.max(2, (Number(fontSize) || 10) * 0.45);
  }

  /**
   * span 列表 → 行。span: {text, left, top, width, height, fontSize}
   * @returns [{text, left, top, right, bottom, height, fontSize, spans:[i...]}]
   */
  function groupSpans(spans) {
    const list = (spans || []).filter((s) => s && s.text && String(s.text).trim() &&
      isFinite(s.left) && isFinite(s.top));
    if (!list.length) return [];
    const sorted = list.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const rows = [];
    for (const s of sorted) {
      const last = rows[rows.length - 1];
      const tol = _rowTol(Math.max(s.fontSize || 10, (last && last.fontSize) || 10));
      if (last && Math.abs(s.top - last.top) <= tol) {
        last.parts.push(s);
        last.top = Math.min(last.top, s.top);
        last.bottom = Math.max(last.bottom, s.top + (s.height || 0));
        last.fontSize = Math.max(last.fontSize, s.fontSize || 10);
      } else {
        rows.push({
          parts: [s],
          top: s.top,
          bottom: s.top + (s.height || 0),
          fontSize: s.fontSize || 10,
        });
      }
    }
    const out = [];
    for (const r of rows) {
      const parts = r.parts.slice().sort((a, b) => a.left - b.left);
      let text = "";
      let prevRight = null;
      for (const p of parts) {
        const t = String(p.text);
        if (prevRight !== null) {
          const gap = p.left - prevRight;
          // pdf.js 的 span 文本通常自带尾随空格；缺空格且间隙明显时补一个
          if (gap > (r.fontSize * 0.22) && !/\s$/.test(text) && !/^\s/.test(t)) text += " ";
        }
        text += t;
        prevRight = p.left + (p.width || 0);
      }
      const left = parts[0].left;
      const right = parts[parts.length - 1].left + (parts[parts.length - 1].width || 0);
      out.push({
        text: text.replace(/\s+/g, " ").trim(),
        left, right,
        top: r.top,
        bottom: r.bottom,
        height: Math.max(1, r.bottom - r.top),
        fontSize: r.fontSize,
      });
    }
    return out.filter((r) => r.text);
  }

  /**
   * 行 → 段落。切段规则（宁多切一点，避免整页塌成一段）：
   *  · 行距 > 1.45×行高 → 新段；
   *  · 首行缩进（当前行 left 比上一行多 0.8×字号）→ 新段；
   *  · 上行明显短于本段宽度（<60%）且以句末标点收尾 → 保守不断（PDF 里这种很常见，
   *    断错会把一句话拆成两段，故只在缩进/行距明确时切）。
   * @returns [{text, left, top, right, bottom, height, fontSize, lines}]
   */
  function linesToBlocks(lines) {
    const rows = (lines || []).filter((r) => r && r.text);
    if (!rows.length) return [];
    const blocks = [];
    let cur = null;
    for (const r of rows) {
      const fs = r.fontSize || 10;
      if (!cur) {
        cur = { lines: [r] };
        continue;
      }
      const prev = cur.lines[cur.lines.length - 1];
      const gap = r.top - prev.bottom;
      const indent = r.left - cur.lines[0].left;
      const newBlock = gap > fs * 1.45 || indent > fs * 0.8;
      if (newBlock) {
        blocks.push(cur);
        cur = { lines: [r] };
      } else {
        cur.lines.push(r);
      }
    }
    if (cur) blocks.push(cur);

    return blocks.map((b) => {
      const ls = b.lines;
      const left = Math.min.apply(null, ls.map((l) => l.left));
      const right = Math.max.apply(null, ls.map((l) => l.right));
      const top = Math.min.apply(null, ls.map((l) => l.top));
      const bottom = Math.max.apply(null, ls.map((l) => l.bottom));
      // 段内字号取众数（多数行字号），避免个别上标/脚注把整段字号带偏
      const freq = new Map();
      for (const l of ls) freq.set(l.fontSize, (freq.get(l.fontSize) || 0) + 1);
      let fs = ls[0].fontSize;
      let best = -1;
      for (const [k, v] of freq) if (v > best) { best = v; fs = k; }
      return {
        text: ls.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim(),
        left, right, top, bottom,
        height: Math.max(1, bottom - top),
        fontSize: fs,
        lines: ls.length,
      };
    }).filter((b) => b.text);
  }

  /** 卡片字号自适应：内容高于框的 ratio 倍就降一档（保底 0.6 倍原字号） */
  function fitFontSize(base, boxHeight, contentHeight) {
    const b = Number(base) > 0 ? Number(base) : 10;
    const box = Number(boxHeight) > 0 ? Number(boxHeight) : b * 1.4;
    const content = Number(contentHeight) || 0;
    if (!content || content <= box * 1.05) return b;
    // 内容比框高多少 → 字号按比例缩（内容高度 ∝ 字号）
    const k = Math.max(0.6, Math.min(1, box / content));
    return Math.max(6, Math.round(b * k * 10) / 10);
  }

  /* ==================== 状态 ==================== */

  const states = new Map();              // reader → state
  const textCache = new Map();           // "lang|text" → 译文（会话级，跨 reader 共享）
  const CACHE_MAX = 800;

  function mode() {
    const v = String((() => { try { return Prefs.get(PREF_MODE, "off"); } catch (e) { return "off"; } })() || "off");
    return (v === "overlay" || v === "bilingual" || v === "mono") ? v : "off";
  }

  /** 生效模式：state 自带（PdfDual 右栏用 mono）优先，否则读 pref */
  function stateMode(state) {
    const m = state && state.mode;
    if (m === "overlay" || m === "bilingual" || m === "mono") return m;
    return mode();
  }
  function fontScale() {
    const n = Number((() => { try { return Prefs.get(PREF_SCALE, "1"); } catch (e) { return 1; } })());
    return isFinite(n) && n > 0 ? Math.min(1.6, Math.max(0.7, n)) : 1;
  }
  function gapMs() {
    const n = Number((() => { try { return Prefs.get(PREF_GAP_MS, 120); } catch (e) { return 120; } })());
    return isFinite(n) && n >= 0 ? Math.min(5000, n) : 120;
  }
  function selectable() {
    try { return Prefs.get(PREF_SELECTABLE, false) === true; } catch (e) { return false; }
  }

  function targetLang() {
    try { return (typeof TranslateSvc !== "undefined" && TranslateSvc) ? TranslateSvc.targetCode() : "zh-CN"; }
    catch (e) { return "zh-CN"; }
  }

  function cacheKey(text) { return targetLang() + "|" + text; }

  function putCache(text, value) {
    if (textCache.size >= CACHE_MAX) {
      const k = textCache.keys().next().value;
      textCache.delete(k);
    }
    textCache.set(cacheKey(text), value);
  }

  /* ==================== 样式（注入 viewer 文档） ==================== */

  function ensureStyle(doc, m) {
    // 换模式要重建样式（原文淡化/隐藏的规则不同）
    const old = doc.getElementById(STYLE_ID);
    if (old) {
      try { old.remove(); } catch (e) { /* ignore */ }
    }
    const st = doc.createElementNS(HTML_NS, "style");
    st.id = STYLE_ID;
    st.textContent = [
      "." + LAYER_CLS + "{position:absolute;inset:0;pointer-events:none;z-index:4;}",
      "." + CARD_CLS + "{position:absolute;box-sizing:border-box;overflow:hidden;",
      "  border-radius:2px;padding:1px 3px;white-space:pre-wrap;word-break:break-word;",
      "  line-height:1.28;color:var(--fill-primary,#111);",
      "  background:var(--material-background,#fff);",
      "  -moz-window-dragging:no-drag;}",
      // overlay：译文不透明盖住原文；bilingual：半透明，原文仍清晰可读；mono：纯译文版页面
      "." + CARD_CLS + ".pp-pit-ov{box-shadow:0 0 0 .5px rgba(127,127,127,.35);}",
      "." + CARD_CLS + ".pp-pit-bi{background:color-mix(in srgb, var(--material-background,#fff) 82%, transparent);",
      "  box-shadow:0 0 0 .5px rgba(127,127,127,.22);}",
      "." + CARD_CLS + ".pp-pit-mo{box-shadow:none;}",
      "." + CARD_CLS + ".pp-pit-pending{color:var(--fill-tertiary,#999);}",
      "." + CARD_CLS + ".pp-pit-fail{color:#c0392b;}",
      "." + SRC_CLS + "{transition:opacity .12s linear;}",
      // 原文处理：overlay 淡显 / mono 完全隐藏（右栏就是「译文版 PDF」，图形与公式保留）
      (m === "overlay" ? ".textLayer ." + SRC_CLS + "{opacity:.18;}\n" : ""),
      (m === "mono" ? ".textLayer ." + SRC_CLS + "{opacity:0 !important;}\n" : ""),
      "." + LAYER_CLS + (selectable() ? "{pointer-events:auto;}" : "{}"),
    ].join("");
    (doc.head || doc.documentElement).appendChild(st);
  }

  function removeStyle(doc) {
    try {
      const st = doc.getElementById(STYLE_ID);
      if (st) st.remove();
    } catch (e) { /* ignore */ }
  }

  /* ==================== 段落抽取（读真实 DOM 坐标） ==================== */

  function pageEls(doc) {
    try { return Array.prototype.slice.call(doc.querySelectorAll(".page[data-page-number]")); }
    catch (e) { return []; }
  }

  /** 一页 → 段落块（含坐标、字号、kind）。无文本层返回 null（扫描版）。 */
  function extractBlocks(pageEl) {
    let layer = null;
    try { layer = pageEl.querySelector(".textLayer"); } catch (e) { layer = null; }
    if (!layer) return null;
    const spans = [];
    let pageRect;
    try { pageRect = pageEl.getBoundingClientRect(); } catch (e) { return null; }
    const cx = pageEl.clientLeft || 0;
    const cy = pageEl.clientTop || 0;
    let nodes = [];
    try { nodes = Array.prototype.slice.call(layer.querySelectorAll("span")); } catch (e) { nodes = []; }
    for (const node of nodes) {
      const text = (node.textContent || "").replace(/\u00a0/g, " ");
      if (!text.trim()) continue;
      let r = null;
      try { r = node.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || (!r.width && !r.height)) continue;
      let fs = 0;
      try { fs = parseFloat(node.style.fontSize || "") || 0; } catch (e) { fs = 0; }
      if (!fs) {
        try { fs = parseFloat((pageEl.ownerDocument.defaultView.getComputedStyle(node) || {}).fontSize || "") || 0; }
        catch (e) { fs = 0; }
      }
      if (!fs) fs = Math.max(6, r.height * 0.92);
      spans.push({
        text,
        left: r.left - pageRect.left - cx,
        top: r.top - pageRect.top - cy,
        width: r.width,
        height: r.height,
        fontSize: fs,
        node,
      });
    }
    if (!spans.length) return null;
    const lines = groupSpans(spans);
    const blocks = linesToBlocks(lines);
    // 分类（单一真源）：junk 丢弃、formula 不译、caption/body 照常翻译
    const out = [];
    for (const b of blocks) {
      let kind = "body";
      try {
        kind = (typeof PdfText !== "undefined" && PdfText) ? PdfText.classify(b.text) : "body";
      } catch (e) { kind = "body"; }
      if (kind === "junk") continue;
      b.kind = kind;
      out.push(b);
    }
    return out;
  }

  /* ==================== 渲染 ==================== */

  function clearPage(pageEl) {
    try {
      const old = pageEl.querySelector("." + LAYER_CLS);
      if (old) old.remove();
    } catch (e) { /* ignore */ }
  }

  function clearAll(state) {
    for (const pageEl of pageEls(state.doc)) clearPage(pageEl);
  }

  /** 在页元素内注入译文层并渲染各段卡片 */
  function renderBlocks(pageEl, blocks, doc, m) {
    clearPage(pageEl);
    if (!blocks || !blocks.length) return;
    const layer = doc.createElementNS(HTML_NS, "div");
    layer.setAttribute("class", LAYER_CLS);
    for (const b of blocks) {
      if (b.kind === "formula") continue;      // 公式保持原样，不叠加
      const card = doc.createElementNS(HTML_NS, "div");
      const cls = CARD_CLS + (m === "bilingual" ? " pp-pit-bi" : (m === "mono" ? " pp-pit-mo" : " pp-pit-ov"));
      card.setAttribute("class", cls + (b.dst == null ? " pp-pit-pending" : ""));
      card.setAttribute("data-pp-pit", "1");
      const pad = 2;
      const w = Math.max(40, (b.right - b.left) + pad * 2);
      card.style.left = Math.max(0, Math.floor(b.left - pad)) + "px";
      card.style.top = Math.max(0, Math.floor(b.top - pad)) + "px";
      card.style.width = Math.ceil(w) + "px";
      card.style.minHeight = Math.max(10, Math.floor(b.height + pad * 2)) + "px";
      // 上限放宽（宁可略溢出下一段，也不把译文裁掉）；字号降档优先兜
      card.style.maxHeight = Math.max(30, Math.ceil(Math.max(b.height * 3.2, b.height + 44))) + "px";
      const base = Math.max(6, (b.fontSize || 10) * fontScale());
      card.style.fontSize = (Math.round(base * 10) / 10) + "px";
      card.textContent = b.dst == null
        ? (I18n && I18n.isZh ? "…" : "…")
        : b.dst;
      layer.appendChild(card);
      b.cardEl = card;
      b.baseFontSize = base;
      // 内容超高 → 降档字号（渲染后量一次）
      try {
        const ch = card.scrollHeight;
        const bh = Math.max(10, Math.floor(b.height + pad * 2));
        if (ch > bh * 1.2) card.style.fontSize = fitFontSize(base, bh, ch) + "px";
      } catch (e) { /* ignore */ }
    }
    pageEl.appendChild(layer);
  }

  /** 把该页原文 span 标记/取消标记（overlay 模式淡化由 CSS 承担）。
   *  幂等：重复调用不会叠加 class（页面重渲染会重建 span，标记随之失效属预期）。 */
  function markSourceSpans(pageEl, on) {
    try {
      const layer = pageEl.querySelector(".textLayer");
      if (!layer) return;
      for (const n of layer.querySelectorAll("span")) {
        const cls = String(n.getAttribute("class") || "");
        const has = new RegExp("(^|\\s)" + SRC_CLS + "(\\s|$)").test(cls);
        if (on && !has) n.setAttribute("class", (cls ? cls + " " : "") + SRC_CLS);
        else if (!on && has) n.setAttribute("class", cls.replace(new RegExp("\\s*" + SRC_CLS + "", "g"), ""));
      }
    } catch (e) { /* ignore */ }
  }

  /** 页面坐标签名：前若干 span 的几何值。缩放/重排会改变它 → 据此判断卡片坐标已作废。 */
  function pageSignature(pageEl) {
    try {
      const layer = pageEl.querySelector(".textLayer");
      if (!layer) return "";
      const spans = layer.querySelectorAll("span");
      const parts = [];
      for (let i = 0; i < Math.min(4, spans.length); i++) {
        let r = null;
        try { r = spans[i].getBoundingClientRect(); } catch (e) { r = null; }
        if (!r) continue;
        parts.push(Math.round(r.left) + "," + Math.round(r.top) + "," + Math.round(r.width));
      }
      return parts.join("|") + "|" + (pageEl.offsetWidth || 0) + "x" + (pageEl.offsetHeight || 0);
    } catch (e) { return ""; }
  }

  /* ==================== 翻译队列 ==================== */

  function queueFor(state) {
    if (!state.queue) state.queue = { items: [], running: false };
    return state.queue;
  }

  /** 并发路数：llm/免费引擎都能承受 2 路；再多容易触发限流（尤其免密钥引擎） */
  const CONCURRENCY = 2;

  function enqueue(state, task) {
    const q = queueFor(state);
    q.items.push(task);
    if (!q.running) drain(state);
  }

  async function drain(state) {
    const q = queueFor(state);
    q.running = true;
    updateButton(state);
    // 2 路并行：整篇译文壁纸式铺满的等待时间直接砍半（原位翻译是逐段独立请求，
    // 段间无顺序依赖 —— 上下文感知只在双语笔记/双栏窗口那条链路上用 prev）
    const worker = async () => {
      while (q.items.length && !state.stopped) {
        const task = q.items.shift();
        try {
          await task();
        } catch (e) {
          try { Zotero.logError(e); } catch (_) { /* ignore */ }
        }
        const gap = gapMs();
        if (gap > 0 && q.items.length) await new Promise((r) => setTimeout(r, gap));
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, Math.max(1, q.items.length)); i++) {
      workers.push(worker());
    }
    try {
      await Promise.all(workers);
    } catch (e) { /* 单任务失败已在 worker 内吞掉 */ }
    q.running = false;
    updateButton(state);
  }

  async function translateBlock(state, b) {
    if (b.kind === "formula") return;                // 不译
    if (!String(b.text || "").trim()) return;
    const hit = textCache.get(cacheKey(b.text));
    if (hit !== undefined) { b.dst = hit; return; }
    let r = null;
    try {
      r = await TranslateSvc.translate(b.text, {
        to: targetLang(),
        context: { title: state.title || "" },
      });
    } catch (e) {
      b.dst = "";
      b.failed = String((e && e.message) || e);
      return;
    }
    if (r && r.ok) {
      b.dst = String(r.text || "").trim();
      putCache(b.text, b.dst);
    } else {
      b.dst = "";
      b.failed = (r && r.error) || "翻译失败";
    }
  }

  function paintBlock(b, m) {
    const card = b.cardEl;
    if (!card) return;
    if (b.failed) {
      card.setAttribute("class", CARD_CLS + " pp-pit-fail");
      card.textContent = (I18n && I18n.isZh ? "翻译失败：" : "Failed: ") + String(b.failed).slice(0, 60);
      return;
    }
    card.setAttribute("class", CARD_CLS + (m === "bilingual" ? " pp-pit-bi" : (m === "mono" ? " pp-pit-mo" : " pp-pit-ov")));
    card.textContent = b.dst == null ? "" : b.dst;
    try {
      const bh = parseFloat(card.style.minHeight || "0") || 0;
      const ch = card.scrollHeight;
      if (ch > bh * 1.2) card.style.fontSize = fitFontSize(b.baseFontSize || 10, bh, ch) + "px";
    } catch (e) { /* ignore */ }
  }

  /* ==================== 逐页处理 ==================== */

  /** 计数**派生**而非累加：缩放重绘同一页不会让进度虚高 */
  function recount(state) {
    let total = 0;
    let done = 0;
    for (const [, bs] of state.pageBlocks) {
      for (const b of bs) {
        if (b.kind === "formula") continue;
        total++;
        if (b.dst != null && !b.failed) done++;
      }
    }
    state.blockCount = total;
    state.doneCount = done;
    if (state.onProgress) {
      try { state.onProgress({ total, done, running: !!(state.queue && state.queue.running) }); }
      catch (e) { /* 回调失败不影响翻译 */ }
    }
  }

  async function processPage(state, pageEl) {
    if (state.stopped) return;
    const pageNum = String(pageEl.getAttribute("data-page-number") || "");
    const sig = pageSignature(pageEl);
    const existing = state.pages.get(pageNum);
    // 已处理且几何签名未变、译文层仍在 → 跳过（幂等，懒加载/事件重入安全）
    if (existing && existing.sig === sig && sig) {
      try {
        if (pageEl.querySelector("." + LAYER_CLS)) return;
      } catch (e) { /* ignore */ }
    }
    const blocks = extractBlocks(pageEl);
    if (blocks === null) {
      // 该页无文本层（扫描页）→ 记录，按钮提示统一给出「需 OCR」
      if (state.noTextPages.indexOf(pageNum) < 0) state.noTextPages.push(pageNum);
      return;
    }
    state.pages.set(pageNum, { sig });
    const sm = stateMode(state);
    // 坐标可能已变（缩放）：旧层作废重建；原文标记一并重刷
    clearPage(pageEl);
    markSourceSpans(pageEl, sm === "overlay" || sm === "mono");
    renderBlocks(pageEl, blocks, state.doc, sm);
    state.pageBlocks.set(pageNum, blocks);
    recount(state);
    updateButton(state);
    for (const b of blocks) {
      if (b.kind === "formula") continue;
      const hit = textCache.get(cacheKey(b.text));
      if (hit !== undefined) { b.dst = hit; paintBlock(b, sm); recount(state); continue; }
      enqueue(state, async () => {
        if (state.stopped) return;
        await translateBlock(state, b);
        if (!state.stopped) paintBlock(b, stateMode(state));
        recount(state);
        updateButton(state);
      });
    }
    // 缓存命中路径不进队列 → 循环后再刷一次计数（否则按钮一直停在上一页的数字）
    updateButton(state);
  }

  /* ==================== reader 绑定 ==================== */

  function stateOf(reader) {
    return reader ? states.get(reader) : null;
  }

  function ensureState(reader) {
    let st = states.get(reader);
    if (st) return st;
    let v = null;
    try { v = (typeof PdfText !== "undefined" && PdfText) ? PdfText.viewerOf(reader) : null; }
    catch (e) { v = null; }
    if (!v || !v.win || !v.win.document) return null;
    st = {
      reader,
      win: v.win,
      app: v.app,
      doc: v.win.document,
      active: false,
      stopped: false,
      pages: new Map(),        // pageNum → {sig}（几何签名，判断坐标是否作废）
      pageBlocks: new Map(),   // pageNum → blocks（计数派生自这里，重绘不虚高）
      noTextPages: [],
      blockCount: 0,
      doneCount: 0,
      title: "",
      busHandler: null,
      busTimer: null,
      pollTimer: null,
    };
    try {
      st.title = (reader && reader.itemID && Zotero.Items.get(reader.itemID))
        ? (Zotero.Items.get(reader.itemID).getDisplayTitle() || "") : "";
    } catch (e) { /* ignore */ }
    states.set(reader, st);
    return st;
  }

  /** 监听 textlayerrendered / pagerendered：
   *  pdf.js 懒加载新页、缩放重建文本层后自动补渲染。
   *  事件不带具体页元素 → 全量扫已存在的页（每页处理幂等、签名未变即跳过）；
   *  用 180ms 节流合并连续事件（翻页/缩放会连发多次）。 */
  function bindBus(state) {
    if (state.busHandler) return;
    try {
      if (!state.app || !state.app.eventBus || typeof state.app.eventBus.on !== "function") return;
      const scan = () => {
        if (!state.active || state.stopped) return;
        for (const pageEl of pageEls(state.doc)) {
          if (state.stopped) return;
          try { processPage(state, pageEl); } catch (e) { /* 单页失败不拖垮 */ }
        }
        updateButton(state);
      };
      state.busHandler = () => {
        if (!state.active || state.stopped) return;
        if (state.busTimer) return;
        state.busTimer = setTimeout(() => {
          state.busTimer = null;
          scan();
        }, 180);
      };
      state.app.eventBus.on("textlayerrendered", state.busHandler);
      state.app.eventBus.on("pagerendered", state.busHandler);
    } catch (e) { /* ignore */ }
  }

  function unbindBus(state) {
    try {
      if (state.busTimer) { clearTimeout(state.busTimer); state.busTimer = null; }
      if (state.app && state.app.eventBus && state.busHandler &&
          typeof state.app.eventBus.off === "function") {
        state.app.eventBus.off("textlayerrendered", state.busHandler);
        state.app.eventBus.off("pagerendered", state.busHandler);
      }
    } catch (e) { /* ignore */ }
    state.busHandler = null;
  }

  /** 开始（幂等）：注入样式 + 扫描已渲染页 + 挂事件与轮询兜底 */
  function start(reader, opts) {
    const state = ensureState(reader);
    if (!state) return false;
    const o = opts || {};
    if (o.mode) state.mode = o.mode;                       // 调用方指定（PdfDual 右栏 = mono）
    if (!state.mode && mode() === "off") setPref(PREF_MODE, "overlay");
    if (o.onProgress) state.onProgress = o.onProgress;
    ensureStyle(state.doc, stateMode(state));
    state.stopped = false;
    state.active = true;
    bindBus(state);
    bindPoll(state);
    for (const pageEl of pageEls(state.doc)) {
      try { processPage(state, pageEl); } catch (e) { /* ignore */ }
    }
    updateButton(state);
    return true;
  }

  /** 轮询兜底（★实机踩过）：pdf.js 只渲染**可见**页，而阅读器标签未激活时
   *  可能一个 textLayer 都不产出，`textlayerrendered` 事件也就永远不来 ——
   *  只看事件会让原位层一直空着（表现为「点了按钮没反应」）。
   *  这里以 900ms 间隔扫已渲染页（签名未变即跳过，开销极小），
   *  轮询 60 次后停（约 54 秒）；此后由事件继续负责懒加载与缩放。 */
  function bindPoll(state) {
    if (state.pollTimer) return;
    let ticks = 0;
    state.pollTimer = setInterval(() => {
      if (!state.active || state.stopped || ++ticks > 60) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        // 轮询结束仍一无所获 → 给出「等待渲染/可能是扫描版」的可读提示
        if (state.active && !state.blockCount) {
          try {
            const btn = state.doc.getElementById(BTN_ID);
            if (btn) {
              btn.title = (I18n && I18n.isZh)
                ? "还没有可提取的文本层：请确认 PDF 页面已渲染（扫描版需先 OCR）"
                : "No text layer yet — make sure the page is rendered (OCR for scans)";
            }
          } catch (e) { /* ignore */ }
        }
        return;
      }
      if (!state.active || state.stopped) return;
      for (const pageEl of pageEls(state.doc)) {
        if (state.stopped) return;
        try { processPage(state, pageEl); } catch (e) { /* ignore */ }
      }
      updateButton(state);
    }, 900);
  }

  function unbindPoll(state) {
    try {
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    } catch (e) { /* ignore */ }
  }

  /** 停止并清理（不清缓存——用户随时再开，译文秒回） */
  function stop(reader, opts) {
    const state = stateOf(reader);
    if (!state) return;
    state.stopped = true;
    state.active = false;
    unbindBus(state);
    unbindPoll(state);
    clearAll(state);
    state.pages.clear();
    state.pageBlocks.clear();
    state.noTextPages = [];
    recount(state);
    for (const pageEl of pageEls(state.doc)) markSourceSpans(pageEl, false);
    if (!state.mode && mode() !== "off" && (!opts || opts.keepPref !== true)) setPref(PREF_MODE, "off");
    state.mode = null;
    state.onProgress = null;
    updateButton(state);
  }

  function setPref(key, value) {
    try { Prefs.set(key, value); } catch (e) { /* ignore */ }
  }

  /* ==================== 工具栏按钮 ==================== */

  function updateButton(state) {
    try {
      const doc = state.doc;
      const btn = doc.getElementById(BTN_ID);
      if (!btn) return;
      const busy = state.active && state.queue && state.queue.running;
      btn.classList.toggle("active", !!state.active);
      const zh = !!(I18n && I18n.isZh);
      let tip;
      if (!state.active) {
        tip = zh ? "PDF 原位对照翻译（译文按段叠加在原页位置）" : "Inline PDF translation (in-place)";
      } else if (busy || (state.doneCount < state.blockCount)) {
        tip = (zh ? "翻译中 " : "Translating ") + state.doneCount + "/" + state.blockCount +
          (zh ? "（点击停止）" : " (click to stop)");
      } else {
        tip = (zh ? "已完成 " : "Done ") + state.doneCount + (zh ? " 段（点击还原原文）" : " (click to revert)");
      }
      if (state.active && state.noTextPages.length && !state.blockCount) {
        tip = zh ? "本页无可提取文本（扫描版需先 OCR）" : "No extractable text (OCR required)";
      }
      btn.title = tip;
      const cnt = doc.getElementById(BTN_ID + "-count");
      if (cnt) cnt.textContent = state.active ? (state.doneCount + "/" + state.blockCount) : "";
    } catch (e) { /* ignore */ }
  }

  function icon(doc) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.style.pointerEvents = "none";
    // 页面外框
    const frame = doc.createElementNS(NS, "rect");
    frame.setAttribute("x", "2.5"); frame.setAttribute("y", "1.5");
    frame.setAttribute("width", "11"); frame.setAttribute("height", "13");
    frame.setAttribute("rx", "1.6");
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "currentColor");
    frame.setAttribute("stroke-width", "1.3");
    svg.appendChild(frame);
    // 两行「译文条」= 原位叠加的语义
    for (const y of [5.2, 9.4]) {
      const bar = doc.createElementNS(NS, "rect");
      bar.setAttribute("x", "4.6"); bar.setAttribute("y", String(y));
      bar.setAttribute("width", "6.8"); bar.setAttribute("height", "2.2");
      bar.setAttribute("rx", "0.7");
      bar.setAttribute("fill", "currentColor");
      bar.setAttribute("opacity", y < 7 ? "0.9" : "0.55");
      svg.appendChild(bar);
    }
    return svg;
  }

  function makeButton(doc, reader) {
    const btn = doc.createElementNS(HTML_NS, "button");
    btn.id = BTN_ID;
    btn.setAttribute("class", "toolbar-button pp-pit-toggle");
    btn.setAttribute("type", "button");
    btn.setAttribute("tabindex", "-1");
    btn.style.flex = "none";
    btn.appendChild(icon(doc));
    const cnt = doc.createElementNS(HTML_NS, "span");
    cnt.id = BTN_ID + "-count";
    cnt.style.cssText = "font-size:9.5px;color:var(--fill-tertiary);margin-inline-start:2px;";
    btn.appendChild(cnt);
    const st = stateOf(reader);
    if (st && st.active) btn.classList.add("active");
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      try {
        const cur = stateOf(reader);
        if (cur && cur.active) stop(reader);
        else if (!ready()) {
          // 引擎不可用：给出可读原因（不静默）
          const msg = (typeof TranslateSvc !== "undefined" && TranslateSvc)
            ? (TranslateSvc.unavailableHint() || "") : "";
          btn.title = msg || (I18n && I18n.isZh ? "翻译引擎不可用" : "No translation engine");
          return;
        } else {
          start(reader);
        }
      } catch (e) {
        try { Zotero.logError(e); } catch (_) { /* ignore */ }
      }
    });
    return btn;
  }

  function ready() {
    try {
      return !!(typeof TranslateSvc !== "undefined" && TranslateSvc && TranslateSvc.available());
    } catch (e) { return false; }
  }

  /* ==================== 注册 / 注销 ==================== */

  let _handler = null;
  let _pluginID = null;

  function readerFromEvent(event) {
    try {
      if (event && event.reader) return event.reader;
      const doc = event && event.doc;
      for (const r of (Zotero.Reader && Zotero.Reader._readers) || []) {
        try {
          if (r && r._iframeWindow && r._iframeWindow.document === doc) return r;
        } catch (e) { /* ignore */ }
      }
      for (const r of (Zotero.Reader && Zotero.Reader._readers) || []) {
        try {
          const v = PdfText && PdfText.viewerOf(r);
          if (v && v.win && v.win.document === doc) return r;
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function onRenderToolbar(event) {
    try {
      const doc = event && event.doc;
      const append = event && event.append;
      if (!doc || typeof append !== "function") return;
      const reader = readerFromEvent(event);
      const btn = makeButton(doc, reader);
      if (!ready()) btn.disabled = true;
      append(btn);
      // ① 用户之前开过（pref 记着 overlay/bilingual）→ 新开的阅读器自动恢复原位对照；
      // ② 该 reader 原本就是开着的（工具栏重渲染）→ 补齐未渲染页
      if (reader && mode() !== "off" && ready()) {
        const st = stateOf(reader) || ensureState(reader);
        if (st) {
          if (!st.active) start(reader);
          else {
            ensureStyle(doc);
            for (const pageEl of pageEls(doc)) {
              try { processPage(st, pageEl); } catch (e) { /* ignore */ }
            }
            updateButton(st);
          }
        }
      }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  }

  /** 入口：对某个条目（或已打开的 reader）一键开启原位对照 */
  async function startForItem(item) {
    if (!ready()) {
      const hint = (typeof TranslateSvc !== "undefined" && TranslateSvc)
        ? (TranslateSvc.unavailableHint() || "") : "";
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot", hint || "翻译引擎不可用");
      return false;
    }
    let att = null;
    try { att = await AIChat.getPdfAttachment(item); } catch (e) { att = null; }
    if (!att) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n && I18n.isZh ? "该条目没有可用的 PDF 附件" : "No PDF attachment");
      return false;
    }
    let reader = null;
    try { reader = PdfText.readerForAttachment(att); } catch (e) { reader = null; }
    if (!reader) {
      try { reader = await Zotero.Reader.open(att.id); } catch (e) { reader = null; }
      if (!reader) return false;
      await new Promise((r) => setTimeout(r, 800));
    }
    setPref(PREF_MODE, "overlay");
    // reader 视图可能尚未就绪：重试几次直到拿到 viewer
    for (let i = 0; i < 10; i++) {
      if (ensureState(reader)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return start(reader);
  }

  /** 入口（右键菜单 / 功能中心）：对当前选中的条目一键开启原位对照 */
  async function startForSelected() {
    let item = null;
    try {
      const zp = Zotero.getActiveZoteroPane();
      const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
      if (!items.length) { ItemSel.alertEmpty(); return false; }
      if (items.length > 1) {
        Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
          I18n && I18n.isZh ? "PDF 原位对照翻译一次请只选一篇" : "Select only one item at a time");
        return false;
      }
      item = items[0];
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return false;
    }
    return startForItem(item);
  }

  /** 0.36.0：**不再注入阅读器工具栏按钮**。
   *  用户明确要的是「左原 PDF / 右译文」的双栏对照（见 PdfDual），页内叠加（overlay/mono）
   *  降级为**内核能力**：由 PdfDual 的右栏复用（mono = 译文版页面）。
   *  这里只保留 pluginID 记录与清理钩子，不再调 registerEventListener。 */
  function register(pluginID) {
    _pluginID = pluginID || "paperpilot@dev.local";
  }

  function unregister() {
    try {
      if (_handler && Zotero.Reader && Zotero.Reader.unregisterEventListener) {
        Zotero.Reader.unregisterEventListener("renderToolbar", _handler);
      }
    } catch (e) { /* ignore */ }
    _handler = null;
    for (const [reader, state] of states) {
      try { stop(reader, { keepPref: true }); } catch (e) { /* ignore */ }
      try { removeStyle(state.doc); } catch (e) { /* ignore */ }
      try {
        const btn = state.doc.getElementById(BTN_ID);
        if (btn) btn.remove();
      } catch (e) { /* ignore */ }
    }
    states.clear();
  }

  /** 模式/字号变化后刷新所有活跃 reader（设置面板改完即时生效） */
  function refresh() {
    for (const [reader, state] of states) {
      try {
        const sm = stateMode(state);
        if (!state.mode && sm === "off") { stop(reader, { keepPref: true }); continue; }
        if (!state.active) continue;
        removeStyle(state.doc);
        ensureStyle(state.doc, sm);
        clearAll(state);
        state.pages.clear();
        state.pageBlocks.clear();
        recount(state);
        for (const pageEl of pageEls(state.doc)) {
          markSourceSpans(pageEl, sm === "overlay" || sm === "mono");
          try { processPage(state, pageEl); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }
  }

  /**
   * 整篇翻译（0.37.0）：后台**逐页滚动**触发 pdf.js 渲染 → 抽段落 → 翻译 → 落卡，
   * 直到最后一页（或调用 stop）。
   *
   * 为什么必须「滚动」而不是「直接渲染」：pdf.js 的渲染入口（PDFPageView 的 draw/
   * render）全是私有方法，外部拿不到；且只有**几何上可见**的页才会被 forceRendering
   * 调度。所以「让每一页都被处理」的唯一可靠办法就是依次把它滚进视口。
   * 滚的是**本 readear 自己的容器**（右栏译文栏），用户左栏的阅读位置不受影响；
   * 完成后把右栏滚回原位。
   *
   * @param {Reader} reader
   * @param {{maxPages?: number, onProgress?: Function, keepScroll?: boolean}} opts
   * @returns {Promise<{pages:number, blocks:number, done:number, skipped:number}>}
   */
  async function translateAll(reader, opts) {
    const o = opts || {};
    const state = ensureState(reader);
    const out = { pages: 0, blocks: 0, done: 0, skipped: 0, error: null };
    if (!state) { out.error = "no-viewer"; return out; }
    if (!state.active) start(reader, { mode: state.mode || mode() });
    const sm = stateMode(state);
    let viewer = null;
    let container = null;
    try {
      viewer = state.app && state.app.pdfViewer;
      container = state.doc.getElementById("viewerContainer");
    } catch (e) { /* ignore */ }
    if (!viewer || !container) { out.error = "no-pdf-viewer"; return out; }
    const total = Number(viewer.pagesCount) || 0;
    const limit = o.maxPages ? Math.min(total, o.maxPages) : total;
    const keep = Number(container.scrollTop) || 0;
    out.totalPages = total;

    for (let i = 1; i <= limit; i++) {
      if (state.stopped) break;
      out.pages = i;
      // ① 把该页滚进视口（触发 pdf.js 渲染，含 textLayer）
      try { viewer.currentPageNumber = i; } catch (e) { /* ignore */ }
      try {
        const pe0 = state.doc.querySelector('.page[data-page-number="' + i + '"]');
        if (pe0 && container) {
          const top = pageOffsetTopIn(container, pe0);
          if (top !== null) container.scrollTop = Math.max(0, Math.round(top) - 4);
        }
      } catch (e) { /* ignore */ }
      // ② 等该页 textLayer 出现（pdf.js 渲染是异步的）；waitTicks 可调（测试/慢机器）
      let pe = null;
      let got = false;
      const ticks = o.waitTicks ? Math.max(1, Number(o.waitTicks)) : 24;
      for (let w = 0; w < ticks; w++) {
        if (state.stopped) break;
        try { pe = state.doc.querySelector('.page[data-page-number="' + i + '"]'); } catch (e) { pe = null; }
        if (pe && pe.querySelector(".textLayer")) { got = true; break; }
        await new Promise((r) => setTimeout(r, 160));
      }
      if (!got) { out.skipped++; if (o.onProgress) { try { o.onProgress({ page: i, total: limit, phase: "skip" }); } catch (e) { /* ignore */ } } continue; }
      // ③ 抽段落 + 翻译（复用页处理；命中缓存时零请求）
      try { await processPage(state, pe); } catch (e) { /* 单页失败不拖垮整篇 */ }
      if (o.onProgress) {
        try { o.onProgress({ page: i, total: limit, phase: "page", blocks: state.blockCount, done: state.doneCount }); }
        catch (e) { /* ignore */ }
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    // 等翻译队列收敛：判据是「没有还没落定的段」（dst == null），
    // 成功与**失败**都算落定 —— 引擎不可用时不能白等 60 秒（自检/用户都等不起）
    const settled = () => {
      for (const [, bs] of state.pageBlocks) {
        for (const b of bs) {
          if (b.kind === "formula") continue;
          if (b.dst == null) return false;
        }
      }
      return true;
    };
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !state.stopped) {
      if (settled()) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    out.blocks = state.blockCount;
    out.done = state.doneCount;
    out.mode = sm;
    if (o.keepScroll !== false) {
      try { container.scrollTop = keep; } catch (e) { /* ignore */ }
    }
    return out;
  }

  /** 页元素相对滚动容器的文档坐标（整篇翻译用；与 pdf-dual-view 的算法同源） */
  function pageOffsetTopIn(container, el) {
    try {
      return (el.getBoundingClientRect().top - container.getBoundingClientRect().top) + container.scrollTop;
    } catch (e) { return null; }
  }

  /** 测试/排障快照 */
  function snapshot() {
    const out = [];
    for (const [, s] of states) {
      out.push({
        active: s.active,
        blocks: s.blockCount,
        done: s.doneCount,
        pages: s.pages.size,
        noTextPages: s.noTextPages.length,
        running: !!(s.queue && s.queue.running),
      });
    }
    return out;
  }

  /**
   * 自检（pref `pdfInlineSelfTest`，默认关）：找库里第一个带 PDF 的条目 →
   * 开原位对照 → 等若干秒 → 收集**每页的段落数/卡片数/首卡落点**写回调用方
   * （main.js 写进 paperpilot-boot.log）。「原地坐标对不对、段落有没有抽出来」
   * 这类问题只有真实 PDF 才能暴露，单测的迷你 DOM 覆盖不到 pdf.js 的真实实现。
   * @returns {Promise<object>} 诊断对象（永不抛异常）
   */
  async function selfTest(waitMs) {
    const out = { ok: false };
    try {
      // ⚠️⚠️ Zotero 10 的 Items.getAll 是 **async**（源码：`this.getAll = async function(...)`）
      // → 必须 await！对它 slice.call 会静默得到空数组（Promise 不可迭代），
      //   表现为「库里有 1500 个 PDF 却报没有附件」（0.34.0 自检实踩）。
      // 另：onlyTopLevel=true 只返回顶层条目（**不含附件**）→ 必须传 false。
      let all = [];
      let attempt = 0;
      const lib = Zotero.Libraries && Zotero.Libraries.userLibraryID;
      for (; attempt < 25; attempt++) {
        let raw = null;
        try { raw = await Zotero.Items.getAll(lib, false, false); } catch (e) { raw = null; }
        all = Array.prototype.slice.call(raw || []);
        if (all.length) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      out.lib = lib;
      out.itemsScanned = all.length;
      out.waitAttempts = attempt;
      let att = null;
      for (const it of all) {
        if (it && it.isPDFAttachment && it.isPDFAttachment()) { att = it; break; }
      }
      if (!att) {
        // 兜底：从常规条目拿附件（有些库第一条就是常规条目）
        for (const it of all) {
          if (!(it && it.isRegularItem && it.isRegularItem())) continue;
          let ids = [];
          try { ids = it.getAttachments() || []; } catch (e) { ids = []; }
          for (const id of ids) {
            const a = Zotero.Items.get(id);
            if (a && a.isPDFAttachment && a.isPDFAttachment()) { att = a; break; }
          }
          if (att) break;
        }
      }
      if (!att) {
        out.error = "no-pdf-attachment-in-library";
        return out;
      }
      out.attachmentID = att.id;
      try { out.attTitle = (att.getDisplayTitle() || "").slice(0, 40); } catch (e) { /* ignore */ }
      const reader = await Zotero.Reader.open(att.id);
      out.readerOpened = !!reader;
      // ★ 实机踩过：标签未激活时 pdf.js 不渲染页面 → 没有 textLayer → 抓不到段落。
      //  自检要模拟「用户点开 PDF 看着屏幕」的场景，故显式激活该标签页。
      try {
        if (reader && reader.tabID && typeof Zotero_Tabs !== "undefined" && Zotero_Tabs.select) {
          Zotero_Tabs.select(reader.tabID);
          out.tabSelected = true;
        }
      } catch (e) { out.tabSelected = String((e && e.message) || e); }
      for (let i = 0; i < 12; i++) {
        if (ensureState(reader)) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      setPref(PREF_MODE, "overlay");
      out.started = start(reader);
      await new Promise((r) => setTimeout(r, waitMs || 22000));
      const st = stateOf(reader);
      if (st) {
        out.pages = [];
        for (const pageEl of pageEls(st.doc)) {
          const num = pageEl.getAttribute("data-page-number");
          const blocks = extractBlocks(pageEl);
          const cards = pageEl.querySelectorAll("." + CARD_CLS);
          const first = cards[0];
          out.pages.push({
            page: num,
            blocks: blocks ? blocks.filter((b) => b.kind !== "formula").length : -1,
            kinds: blocks ? blocks.map((b) => b.kind).join(",").slice(0, 60) : "no-text-layer",
            cards: cards.length,
            card0: first ? {
              left: first.style.left, top: first.style.top, width: first.style.width,
              text: String(first.textContent || "").slice(0, 24),
            } : null,
          });
          if (out.pages.length >= 5) break; // 只看前 5 页，日志别太长
        }
        out.snapshot = snapshot();
      }
      out.ok = !!(st && st.blockCount > 0);
      // 自检不该改变用户的默认行为：还原「不自开」
      stop(reader, { keepPref: true });
      setPref(PREF_MODE, "off");
      return out;
    } catch (e) {
      out.error = String((e && e.message) || e);
      return out;
    }
  }

  return {
    // 纯函数（单测）
    groupSpans, linesToBlocks, fitFontSize,
    // 运行时
    register, unregister, start, stop, startForItem, startForSelected, refresh, snapshot, selfTest,
    // 0.36.0：供 PdfDual 复用（右栏 = 同一 PDF 的 mono 译文视图）
    attach: start, extractBlocks, stateMode,
    // 0.37.0：整篇翻译（逐页滚动触发渲染 → 抽段 → 翻译 → 落卡）
    translateAll,
    // 供测试/排障读取内部状态
    _states: states, _textCache: textCache,
    _mode: mode, _fontScale: fontScale,
  };
})();
