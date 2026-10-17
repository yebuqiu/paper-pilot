/* PaperPilot 设置面板 · 第三方文献源卡片（实验性 · 0.45.0）
 * 面板只做两件事：分组陈列公开入口（点一下就开）+ 可选检索词直达。
 * 文案纪律：不写任何来源/出处说明，只保留「实验功能」提示与门控状态。
 * 与 prefs-cnki.js 同构：Zotero 先跑脚本后插 DOM → init 探测节点、延迟重试；
 * 经 Zotero.PaperPilot.thirdSource 访问主模块（bootstrap 作用域）。
 */
/* global Zotero, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const TS = () => Zotero.PaperPilot && Zotero.PaperPilot.thirdSource;

  const OK = "var(--pp-success, #2e7d32)";
  const ERR = "var(--pp-danger, #c0392b)";
  const MUTED = "var(--pp-muted)";

  function el(tag, attrs, text) {
    const n = document.createElementNS(HTML_NS, tag);
    if (attrs) { for (const k of Object.keys(attrs)) { n.setAttribute(k, attrs[k]); } }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function setText(id, msg, color) {
    const elm = $(id);
    if (elm) { elm.textContent = msg; elm.style.color = color || MUTED; }
  }

  function query() {
    const inp = $("pp-ts-query");
    return inp ? String(inp.value || "").trim() : "";
  }

  /* ---------- 渲染 ---------- */

  function renderGate() {
    try {
      const g = TS().proGate();
      if (!g.ok) {
        setText("pp-ts-gate", TS().gateMessage(g), ERR);
      } else if (g.reason === "pro") {
        setText("pp-ts-gate", zh ? "✓ Pro 会员 · 试用已授权" : "✓ Pro · trial unlocked", OK);
      } else {
        setText("pp-ts-gate", "");
      }
    } catch (e) { /* ignore */ }
  }

  function renderStatus() {
    try {
      const cache = TS().readEndpointCheck();
      const total = TS().ENDPOINTS.filter((e) => e.probe !== false).length;
      if (!cache) {
        setText("pp-ts-status", zh ? "未检测（点「检测入口」）" : "Not checked");
        return;
      }
      let okN = 0;
      for (const r of cache.list) { if (r && r.ok) { okN++; } }
      let when = "";
      try { when = new Date(cache.at).toLocaleString(zh ? "zh-CN" : "en-US"); } catch (e) { /* ignore */ }
      setText("pp-ts-status",
        (zh ? "上次检测 " : "Checked ") + when + (zh ? " · 可用 " : " · up ")
          + okN + "/" + (cache.list.length || total),
        okN === cache.list.length ? OK : (okN > 0 ? "" : ERR));
    } catch (e) { /* ignore */ }
  }

  function chip(e, st) {
    const btn = el("button", { class: "pp-ts-chip", type: "button" });
    const dot = el("span", { class: "pp-ts-dot" }, st ? (st.ok ? "●" : "○") : "·");
    dot.style.color = st ? (st.ok ? OK : ERR) : MUTED;
    const name = el("span", { class: "pp-ts-chip-name" }, e.name);
    let tip = "";
    try { tip = String(e.url || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, ""); } catch (x) { tip = ""; }
    if (st && !st.ok) { tip += zh ? "（上次检测不可达）" : " (unreachable last check)"; }
    if (e.probe === false) { tip += zh ? "（不参与自动检测）" : " (not auto-checked)"; }
    try { btn.title = tip; } catch (x) { /* ignore */ }
    btn.appendChild(dot);
    btn.appendChild(name);
    btn.addEventListener("click", () => { onOpen(e.id); });
    return btn;
  }

  function renderEndpoints() {
    const box = $("pp-ts-endpoints");
    if (!box || !TS()) { return; }
    try {
      const t = TS();
      const cache = t.readEndpointCheck();
      const map = {};
      if (cache) { for (const r of cache.list) { map[r.id] = r; } }
      box.innerHTML = "";
      for (const g of t.grouped()) {
        box.appendChild(el("div", { class: "pp-ts-group" }, g.name));
        const wrap = el("div", { class: "pp-ts-chips" });
        for (const e of g.items) { wrap.appendChild(chip(e, map[e.id])); }
        box.appendChild(wrap);
      }
      // 检索词提示行：空态说明「能带词直达」，有词则显示会带词的入口数
      const q = query();
      if (!q) {
        const nAll = t.ENDPOINTS.filter((e) => !!e.q).length;
        setText("pp-ts-query-hint",
          zh ? "输入 DOI 或标题后点入口，可直接落到检索结果（" + nAll + " 个入口支持）"
            : "Type a DOI or title, then click a source to search directly ("
              + nAll + " sources)", MUTED);
      } else {
        const n = t.ENDPOINTS.filter((e) => t.canSearch(e.id, q)).length;
        setText("pp-ts-query-hint",
          (zh ? "将带入检索词：「" : "Query: \"") + q + (zh ? "」· " : "\" · ")
            + n + (zh ? " 个入口支持直达检索" : " sources support direct search"), MUTED);
      }
    } catch (e) { /* ignore */ }
  }

  function setResult(msg, color) {
    setText("pp-ts-result", msg || "", color);
  }

  /* ---------- 动作 ---------- */

  function onOpen(id) {
    const t = TS();
    if (!t) { return; }
    const r = t.openEndpoint(id, query());
    if (!r || !r.ok) {
      setResult(zh ? "未打开（见上方门控 / 启用提示）" : "Not opened", ERR);
      return;
    }
    const name = r.name || id;
    if (r.searched) {
      setResult((zh ? "已在 " : "Searching on ") + name + (zh ? " 检索（外部浏览器）" : ""), OK);
    } else if (r.needDoi) {
      setResult((zh ? name + " 需 DOI 才能直取全文：已打开首页" : name + " needs a DOI"), "");
    } else {
      setResult((zh ? "已打开 " : "Opened ") + name + (zh ? "（外部浏览器）" : ""), OK);
    }
  }

  async function onPing() {
    const t = TS();
    if (!t) { return; }
    const gate = t.proGate();
    if (!gate.ok) { setResult(t.gateMessage(gate), ERR); return; }
    const btn = $("pp-ts-ping-btn");
    if (btn) { btn.disabled = true; }
    setResult(zh ? "检测中…" : "Checking…");
    try {
      const list = await t.checkEndpoints((done, total) => {
        setResult((zh ? "检测中 " : "Checking ") + done + "/" + total + "…");
      });
      const okN = list.filter((r) => r && r.ok).length;
      setResult((zh ? "检测完成：可用 " : "Done: up ") + okN + "/" + list.length, okN ? OK : ERR);
    } catch (e) {
      setResult((zh ? "检测失败：" : "Failed: ") + (e && (e.message || e)), ERR);
    } finally {
      if (btn) { btn.disabled = false; }
    }
    renderEndpoints();
    renderStatus();
  }

  function onEnable() {
    try {
      const cb = $("pp-ts-enabled");
      TS().setEnabled(!!(cb && cb.checked));
      setResult(zh ? (cb && cb.checked ? "已启用（Pro 试用）" : "已关闭") : "Updated");
    } catch (e) { /* ignore */ }
  }

  /* ---------- 初始化（DOM 就绪探测，同 prefs-cnki.js 模式） ---------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !TS()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-ts-ping-btn") || !$("pp-ts-endpoints")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) { return; }
    init._done = true;

    const t = TS();
    const en = $("pp-ts-enabled");
    if (en) { en.checked = t.enabled(); }
    renderGate();
    renderStatus();
    renderEndpoints();

    const bind = (id, ev, fn) => { const elm = $(id); if (elm) { elm.addEventListener(ev, fn); } };
    bind("pp-ts-ping-btn", "click", onPing);
    bind("pp-ts-enabled", "change", onEnable);
    // 输入检索词只影响「按钮是否带词」，重渲染成本极低（≤27 个 chip）
    bind("pp-ts-query", "input", renderEndpoints);
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
