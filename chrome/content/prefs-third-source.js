/* PaperPilot 设置面板 · 第三方文献源卡片（实验性 · 0.44.2：内置可用网点，无需账号）
 * 「文献虫 / 毕业助手」双站探测结果合并去重后的网点列表：每行一个网点（状态点 + 名称 + 备注 + 打开），
 * 「检测网点」逐个探测连通性（低频节流）并把结果记入 pref 缓存。
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

  function el(tag, attrs, text) {
    const n = document.createElementNS(HTML_NS, tag);
    if (attrs) { for (const k of Object.keys(attrs)) { n.setAttribute(k, attrs[k]); } }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function setText(id, msg, color) {
    const elm = $(id);
    if (elm) { elm.textContent = msg; elm.style.color = color || "var(--pp-muted)"; }
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
      if (!cache) {
        setText("pp-ts-status", zh ? "未检测（点「检测网点」）" : "Not checked");
        return;
      }
      let okN = 0;
      for (const r of cache.list) { if (r && r.ok) { okN++; } }
      let when = "";
      try { when = new Date(cache.at).toLocaleString(zh ? "zh-CN" : "en-US"); } catch (e) { /* ignore */ }
      setText("pp-ts-status",
        (zh ? "上次检测 " : "Checked ") + when + (zh ? " · 可用 " : " · up ") + okN + "/" + cache.list.length,
        okN === cache.list.length ? OK : (okN > 0 ? "" : ERR));
    } catch (e) { /* ignore */ }
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
      for (const e of t.endpoints()) {
        const st = map[e.id];
        const row = el("div", { class: "pp-row" });
        const dot = el("span", { class: "pp-msg" }, st ? (st.ok ? "●" : "○") : "·");
        dot.style.color = st ? (st.ok ? OK : ERR) : "var(--pp-muted)";
        try {
          dot.title = st ? (st.ok ? (zh ? "可用 " : "ok ") + st.ms + "ms"
            : (zh ? "不可达" : "unreachable")) : (zh ? "未检测" : "not checked");
        } catch (x) { /* ignore */ }
        const name = el("span", { class: "pp-label" }, e.name);
        const note = el("span", { class: "pp-msg" }, e.note || "");
        const btn = el("button", { class: "pp-btn pp-btn-sm" }, zh ? "打开" : "Open");
        btn.addEventListener("click", () => { onOpen(e.id); });
        row.appendChild(dot);
        row.appendChild(name);
        row.appendChild(note);
        row.appendChild(btn);
        box.appendChild(row);
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
    const ok = t.openEndpoint(id);
    setResult(ok ? (zh ? "已打开（外部浏览器）" : "Opened in browser")
      : (zh ? "未打开（见上方门控/启用提示）" : "Not opened"), ok ? OK : ERR);
  }

  async function onPing() {
    const t = TS();
    if (!t) { return; }
    const gate = t.proGate();
    if (!gate.ok) { setResult(t.gateMessage(gate), ERR); return; }
    const btn = $("pp-ts-ping-btn");
    if (btn) { btn.disabled = true; }
    setResult(zh ? "检测中…（逐个网点，间隔 ≥1.5s）" : "Checking…");
    try {
      const list = await t.checkEndpoints();
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
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
