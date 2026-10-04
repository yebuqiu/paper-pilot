/* PaperPilot 全文对照翻译 · 双栏对照窗口逻辑（0.25.2）
 *
 * 职责边界：本脚本**只做渲染与交互**。翻译、取全文、写笔记一律经
 * window.arguments[0] 里的回调回传到插件作用域执行
 * （窗口脚本访问不到 bootstrap 作用域的 AIChat/AIClient/Notes）。
 *
 * 布局要点（为什么这样做，写在这里免得后人重复踩）：
 *   1) 「段落成对」网格：每一段 = 同一网格行里的左(原文)/右(译文)两个单元格。
 *      ⇒ 左右逐段严格对齐；**行级同步是结构保证的**——滚动由单一容器
 *        (#pp-bl-scroll) 负责，不需要监听 scrollTop 互相追赶，也就没有
 *        回环抑制、比例映射误差、滚动条跳跃那类问题。
 *   2) grid-template-columns: 1fr 1fr ⇒ 两栏等宽，并随窗口宽度自适应。
 *   3) 窄屏（窗口宽 < MIN_TWO_COL_PX，auto 模式下）或用户显式选择 ⇒
 *      data-cols="single"：网格变一列，原文/译文上下交替成对。
 *   4) 表头用 position:sticky 固定在滚动容器顶部；单栏模式下改由每段自带
 *      小标（::before）区分原文/译文，此时隐藏双列表头。
 *   5) 字号与布局写入 pref（设置面板同一份），下次打开沿用。
 */
(function () {
  "use strict";

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const STYLE_ID = "pp-bl-style";
  const MIN_TWO_COL_PX = 720;   // 窄于此宽度 = 单栏（仅 auto 模式）
  const FONT_MIN = 11, FONT_MAX = 28, FONT_DEF = 15;
  const CHUNK_GAP_MS = 300;     // 段间节流：与双语笔记流程保持一致
  const STICK_BOTTOM_PX = 80;   // 距底 ≤ 此值才「跟随最新段落」（否则不打断用户阅读）

  const args0 = (window.arguments && window.arguments[0]) || {};
  let A = args0;                                        // 当前载荷（可被 ppBilingualLoad 替换）
  const Zotero = A.Zotero;

  let fontSize = FONT_DEF;
  let layout = "auto";                                  // auto | two | single
  let busy = false;
  const pairs = [];                                     // { src, dst, srcEl, dstEl }
  let total = 0, done = 0;

  /* ---------------- 小工具 ---------------- */

  const $ = (id) => document.getElementById(id);
  const zh = () => A.isZh !== false;
  const T = (k) => {
    try { return typeof A.t === "function" ? A.t(k) : k; } catch (e) { return k; }
  };
  function tx(k, zhText, enText) {                       // 有文案键用文案键，缺失时回退
    const v = T(k);
    return v && v !== k ? v : (zh() ? zhText : enText);
  }
  function htmlEl(tag, cls, text) {
    const el = document.createElementNS(HTML_NS, tag);
    if (cls) el.setAttribute("class", cls);
    if (text != null) el.textContent = text;
    return el;
  }
  function setText(id, text) { const el = $(id); if (el) el.textContent = text == null ? "" : String(text); }
  function setLabel(id, text) { const el = $(id); if (el) el.setAttribute("label", text); }
  function setStatus(msg) { setText("pp-bl-status", msg || ""); }
  function clampFont(n) {
    const v = Math.round(Number(n));
    if (!isFinite(v) || v <= 0) return FONT_DEF;
    return Math.min(FONT_MAX, Math.max(FONT_MIN, v));
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ---------------- 注入样式（表头 sticky / 单栏徽标 / 分隔线） ---------------- */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const src = zh() ? "原文" : "Source";
    const dst = zh() ? "译文" : "Translation";
    const line = "var(--material-border, #ddd)";
    const st = document.createElementNS(HTML_NS, "style");
    st.id = STYLE_ID;
    st.textContent = [
      "#pp-bl-scroll { color: var(--fill-primary, #222); }",
      // 两栏等宽 + 随宽度自适应；单栏时退成一列
      "#pp-bl-grid { display: grid; grid-template-columns: 1fr 1fr; align-items: stretch; }",
      "#pp-bl-grid[data-cols='single'] { grid-template-columns: 1fr; }",
      // 每段单元格：撑满行高，于是左右两栏的分隔线是连续的一条
      ".pp-bl-cell { padding: 9px 14px; border-top: 1px solid " + line + ";",
      "  white-space: pre-wrap; word-break: break-word; line-height: 1.65; }",
      ".pp-bl-cell.src { border-right: 1px solid " + line + "; }",
      "#pp-bl-grid[data-cols='single'] .pp-bl-cell.src { border-right: none; }",
      ".pp-bl-cell.dst.pending { color: var(--fill-secondary, #888); }",
      ".pp-bl-cell.dst.failed { color: #c0392b; }",
      // 表头：吸附在滚动容器顶部
      ".pp-bl-head { position: sticky; top: 0; z-index: 2; padding: 6px 14px;",
      "  font-size: 11.5px; font-weight: 700; letter-spacing: .04em;",
      "  color: var(--fill-secondary, #666); background: var(--material-toolbar, #f6f6f6);",
      "  border-bottom: 1px solid " + line + "; }",
      "#pp-bl-grid[data-cols='two'] #pp-bl-head-dst { border-left: 1px solid " + line + "; }",
      // 单栏：隐藏双列表头，每段自带小标
      "#pp-bl-grid[data-cols='single'] .pp-bl-head { display: none; }",
      "#pp-bl-grid[data-cols='single'] .pp-bl-cell::before {",
      "  content: ''; display: block; font-size: 10.5px; font-weight: 700;",
      "  letter-spacing: .06em; color: var(--fill-secondary, #888); margin-bottom: 2px; }",
      "#pp-bl-grid[data-cols='single'] .pp-bl-cell.src::before { content: '" + src + "'; }",
      "#pp-bl-grid[data-cols='single'] .pp-bl-cell.dst::before { content: '" + dst + "'; }",
      ".pp-bl-empty { padding: 18px 14px; color: var(--fill-secondary, #888); font-size: 12.5px; }",
    ].join("\n");
    try { document.documentElement.appendChild(st); } catch (e) { /* ignore */ }
  }

  /* ---------------- 字号 / 布局 ---------------- */

  function applyFontSize() {
    const g = $("pp-bl-grid");
    if (g) g.style.fontSize = fontSize + "px";
    setText("pp-bl-font-val", fontSize + "px");
  }
  function setFontSize(n, persist) {
    fontSize = clampFont(n);
    applyFontSize();
    if (persist !== false && typeof A.setPref === "function") {
      try { A.setPref("bilingualViewFontSize", fontSize); } catch (e) { /* ignore */ }
    }
  }

  /** 当前生效栏数：显式选择优先；auto 时按窗口宽度判定 */
  function effectiveCols() {
    if (layout === "single") return "single";
    if (layout === "two") return "two";
    const w = Number(window.innerWidth) || 0;
    return w > 0 && w < MIN_TWO_COL_PX ? "single" : "two";
  }
  function applyCols() {
    const g = $("pp-bl-grid");
    if (g) g.setAttribute("data-cols", effectiveCols());
  }
  function setLayout(v, persist) {
    layout = (v === "two" || v === "single") ? v : "auto";
    const sel = $("pp-bl-layout");
    if (sel) sel.value = layout;
    applyCols();
    if (persist !== false && typeof A.setPref === "function") {
      try { A.setPref("bilingualViewLayout", layout); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- 渲染 ---------------- */

  const HEAD_IDS = ["pp-bl-head-src", "pp-bl-head-dst"];

  function clearGrid() {
    const g = $("pp-bl-grid");
    if (g) {
      for (const n of Array.prototype.slice.call(g.childNodes || [])) {
        if (HEAD_IDS.indexOf(n.id) < 0) g.removeChild(n);
      }
    }
    pairs.length = 0; total = 0; done = 0;
    updateProgress();
  }

  function showEmpty(msg) {
    const g = $("pp-bl-grid");
    if (g) g.appendChild(htmlEl("div", "pp-bl-cell pp-bl-empty", msg));
  }

  function updateProgress() {
    const bar = $("pp-bl-progress-bar");
    if (bar) bar.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
    setText("pp-bl-count", total ? done + " / " + total : "");
  }

  function nearBottom() {
    const sc = $("pp-bl-scroll");
    if (!sc) return true;
    const h = Number(sc.scrollHeight) || 0;
    const t = Number(sc.scrollTop) || 0;
    const c = Number(sc.clientHeight) || 0;
    return h - t - c <= STICK_BOTTOM_PX;
  }
  function scrollToBottom() {
    const sc = $("pp-bl-scroll");
    if (sc) sc.scrollTop = Number(sc.scrollHeight) || 0;
  }

  /** 追加一段：返回同一行里的左(原文)/右(译文)两个单元格 */
  function addPair(src) {
    const rec = { src: src, dst: "", srcEl: null, dstEl: null };
    rec.srcEl = htmlEl("div", "pp-bl-cell src", src);
    rec.dstEl = htmlEl("div", "pp-bl-cell dst pending", tx("blPending", "翻译中…", "Translating…"));
    const g = $("pp-bl-grid");
    if (g) { g.appendChild(rec.srcEl); g.appendChild(rec.dstEl); }
    pairs.push(rec);
    return rec;
  }

  function setBusyUI(b) {
    busy = b;
    const note = $("pp-bl-note");
    if (note) note.disabled = b;
  }

  /* ---------------- 主流程 ---------------- */

  async function run(payload) {
    if (payload) A = payload;
    clearGrid();
    setBusyUI(true);
    setText("pp-bl-title", A.title || "");
    setStatus(tx("blReading", "读取全文…", "Reading full text…"));

    let full = "";
    try {
      full = await A.getFullText();
    } catch (e) {
      full = "";
    }
    if (!full) {
      showEmpty(tx("blNoText",
        "未能取得全文：该条目可能没有可解析文本的 PDF（或无 PDF 附件、扫描件需先 OCR）。",
        "No extractable full text: the item may have no PDF or only a scanned PDF (OCR required)."));
      setStatus("");
      setBusyUI(false);
      return;
    }

    let chunks = [];
    try {
      chunks = (typeof A.chunkText === "function" ? A.chunkText(full) : [String(full)]) || [];
    } catch (e) {
      chunks = [];
    }
    if (!chunks.length) {
      showEmpty(tx("blNoText", "未能取得全文（分段结果为空）。", "No extractable full text."));
      setStatus("");
      setBusyUI(false);
      return;
    }

    total = chunks.length;
    updateProgress();
    setStatus(tx("blTranslating", "翻译中", "Translating") + " 0/" + total);

    for (let i = 0; i < chunks.length; i++) {
      const stick = nearBottom();
      const rec = addPair(chunks[i]);
      if (stick) scrollToBottom();
      try {
        const tgt = await A.translateChunk(chunks[i]);
        rec.dst = String(tgt == null ? "" : tgt).trim() || tx("blEmptyCell", "（空）", "(empty)");
        rec.dstEl.setAttribute("class", "pp-bl-cell dst");
        rec.dstEl.textContent = rec.dst;
      } catch (e) {
        // 单段失败只标记这一段，继续翻后面的（整篇中断对长文太不友好）
        rec.dst = "";
        rec.dstEl.setAttribute("class", "pp-bl-cell dst failed");
        rec.dstEl.textContent = tx("blFail", "翻译失败：", "Failed: ") +
          String((e && e.message) || e).slice(0, 140);
      }
      done = i + 1;
      updateProgress();
      setStatus(tx("blTranslating", "翻译中", "Translating") + " " + done + "/" + total);
      if (done < total) await sleep(CHUNK_GAP_MS);
    }

    setStatus(tx("blDone", "完成：", "Done: ") + done + (zh() ? " 段" : " chunks"));
    setBusyUI(false);
  }

  /* ---------------- 交互 ---------------- */

  function copyAll() {
    const text = pairs.map((p) => p.dst).filter(Boolean).join("\n\n");
    if (!text) { setStatus(tx("blNothingCopy", "还没有译文可复制", "Nothing to copy yet")); return; }
    try { Zotero.Utilities.Internal.copyText(text); } catch (e) { /* ignore */ }
    setStatus(tx("blCopied", "已复制全部译文", "Copied all translations"));
  }

  async function exportNote() {
    if (busy) { setStatus(tx("blBusy", "翻译还没结束，请稍候…", "Still translating — please wait…")); return; }
    const payload = pairs
      .filter((p) => p.dst && p.dst !== tx("blEmptyCell", "（空）", "(empty)"))
      .map((p) => ({ src: String(p.src).replace(/\s+/g, " ").trim(), dst: p.dst }));
    if (!payload.length) { setStatus(tx("blNothingCopy", "还没有译文可复制", "Nothing to export yet")); return; }
    setStatus(tx("blNoteBusy", "正在生成双语笔记…", "Creating note…"));
    try {
      await A.makeNote(payload);
      setStatus(tx("blNoteDone", "✓ 已生成双语笔记", "✓ Bilingual note created"));
    } catch (e) {
      setStatus(tx("blNoteFail", "生成笔记失败：", "Note failed: ") +
        String((e && e.message) || e).slice(0, 120));
    }
  }

  function bindUi() {
    setLabel("pp-bl-layout-auto", tx("blLayoutAuto", "自动（窄屏单栏）", "Auto (single when narrow)"));
    setLabel("pp-bl-layout-two", tx("blLayoutTwo", "强制双栏", "Two columns"));
    setLabel("pp-bl-layout-single", tx("blLayoutSingle", "强制单栏", "Single column"));
    setText("pp-bl-layout-label", tx("blLayout", "布局", "Layout"));
    setText("pp-bl-font-label", tx("blFont", "字号", "Font"));
    setText("pp-bl-head-src", zh() ? "原文" : "Source");
    setText("pp-bl-head-dst", zh() ? "译文" : "Translation");
    setText("pp-bl-copy", tx("blCopyAll", "复制译文", "Copy translations"));
    setText("pp-bl-note", tx("blNote", "导出双语笔记", "Export note"));

    const dec = $("pp-bl-font-dec"), inc = $("pp-bl-font-inc");
    if (dec) dec.addEventListener("click", () => setFontSize(fontSize - 1));
    if (inc) inc.addEventListener("click", () => setFontSize(fontSize + 1));
    const cp = $("pp-bl-copy");
    if (cp) cp.addEventListener("click", copyAll);
    const nt = $("pp-bl-note");
    if (nt) nt.addEventListener("click", () => { exportNote(); });
    const cl = $("pp-bl-close");
    if (cl) cl.addEventListener("click", () => { try { window.close(); } catch (e) { /* ignore */ } });

    const sel = $("pp-bl-layout");
    if (sel) {
      sel.value = layout;
      sel.addEventListener("command", () => setLayout(sel.value));
    }
    window.addEventListener("resize", applyCols);
  }

  function boot() {
    injectStyle();
    // 先不落 pref：按当前载荷初始化，避免「打开窗口就写一次」
    setFontSize(clampFont(A.fontSize), false);
    setLayout(A.layout === "two" || A.layout === "single" ? A.layout : "auto", false);
    bindUi();
    applyCols();
    run(A);
  }

  /* ---------------- 对外接口（供插件侧复用窗口 / 自检） ---------------- */

  /** 已开窗口换一篇：正在翻译时拒绝（避免把进行中的文档冲掉） */
  window.ppBilingualLoad = function (payload) {
    if (busy) {
      setStatus(tx("blBusySwitch", "正在翻译中：请等完成或关闭窗口后重试", "Busy translating — wait or reopen"));
      try { window.focus(); } catch (e) { /* ignore */ }
      return false;
    }
    try { window.focus(); } catch (e) { /* ignore */ }
    run(payload || {});
    return true;
  };

  /** 自检快照（窗口内状态，便于排障/测试断言） */
  window.ppBilingualSnapshot = function () {
    return {
      title: A.title || "",
      total: total,
      done: done,
      pairs: pairs.length,
      layout: layout,
      cols: effectiveCols(),
      fontSize: fontSize,
      busy: busy,
    };
  };

  window.addEventListener("unload", () => {
    pairs.length = 0;
    A = { Zotero: Zotero };
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  }
})();
