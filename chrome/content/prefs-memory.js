// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本 · AI 记忆（0.51.0）
 *
 * 集成方在 prefs.xhtml 提供两个锚点：
 *   <html:div id="pp-mem-list"></html:div>   列表容器（本脚本动态生成行）
 *   <html:button id="pp-mem-clear">清空全部</html:button>
 *
 * 行为：
 *   - 列 AgentMemory.list(50)：每行「[项目] 文本（相对时间）」+ 行内「删除」；
 *   - 「清空全部」走 Services.prompt.confirm（不可用时退化为 3 秒内二次点击确认）；
 *   - 记忆模块经 Zotero.Papilot.agentMemory 访问（集成方暴露），未就绪给明确提示。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 pp-mem-list，不存在就
 *    延迟重试（同 prefs-schedule.js / prefs-agent.js 纪律）。
 * ⚠️ 动态生成的节点一律经变量持有，不用 $(…) 取动态节点（check-wiring 守卫）。
 */
/* global Zotero, Services, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const $ = (id) => document.getElementById(id);
  const LIST_MAX = 50;
  const KIND_LABEL = { project: "项目", fact: "事实", prefer: "偏好" };

  /** 记忆模块（集成方暴露 Zotero.Papilot.agentMemory） */
  const M = () => {
    try {
      const api = Zotero.Papilot && Zotero.Papilot.agentMemory;
      return (api && typeof api.list === "function") ? api : null;
    } catch (e) { return null; }
  };

  const labelOf = (kind) => KIND_LABEL[kind] || "事实";

  /** 相对时间（分钟/小时/天；超 30 天退回本地日期） */
  function relTime(at) {
    const t = Number(at) || 0;
    if (!t) return "";
    const diff = Date.now() - t;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 30 * 86400000) return Math.floor(diff / 86400000) + " 天前";
    try { return new Date(t).toLocaleDateString(); }
    catch (e) { return ""; }
  }

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* 状态提示节点（init 时创建并持有，不 $ 取） */
  let msgNode = null;
  let clearArmedUntil = 0;

  function setMsg(text, color) {
    if (!msgNode) return;
    msgNode.textContent = text || "";
    msgNode.style.color = color || "var(--pp-muted)";
  }

  function syncClearBtn(count, ready) {
    const btn = $("pp-mem-clear");
    if (!btn) return;
    btn.textContent = count ? "清空全部（" + count + "）" : "清空全部";
    btn.disabled = !ready || !count;
  }

  function buildRow(api, item) {
    const row = el("div", {
      class: "pp-row pp-mem-row",
      "data-id": item.id,
      style: "align-items:flex-start;border-bottom:1px solid var(--pp-border);" +
        "padding:6px 0;margin-top:0;gap:8px;",
    });
    row.appendChild(el("span", {
      class: "pp-mem-kind",
      style: "flex:0 0 auto;font-weight:600;",
    }, "[" + labelOf(item.kind) + "]"));
    row.appendChild(el("span", {
      class: "pp-mem-text",
      style: "flex:1 1 auto;word-break:break-word;",
    }, String(item.text || "")));
    const time = relTime(item.at);
    if (time) {
      row.appendChild(el("span", {
        class: "pp-hint pp-mem-time",
        style: "flex:0 0 auto;",
      }, time));
    }
    const del = el("button", {
      class: "pp-btn pp-btn-sm pp-mem-del",
      title: "删除这条记忆",
    }, "删除");
    del.addEventListener("click", () => {
      try { api.remove(item.id); }
      catch (e) { /* 单条删除失败不拖垮面板 */ }
      render();
    });
    row.appendChild(del);
    return row;
  }

  function render() {
    const host = $("pp-mem-list");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const api = M();
    if (!api) {
      host.appendChild(el("div", {
        class: "pp-hint",
        style: "color:var(--pp-warn);",
      }, "记忆模块未就绪（请重启 Zotero 后再试）"));
      syncClearBtn(0, false);
      return;
    }

    let items = [];
    try { items = api.list(LIST_MAX) || []; }
    catch (e) { items = []; }

    if (!items.length) {
      host.appendChild(el("div", { class: "pp-hint" },
        "暂无记忆。AI 可用 memory_write 保存研究方向、结论或偏好。"));
    }
    for (const it of items) host.appendChild(buildRow(api, it));
    syncClearBtn(items.length, true);
  }

  function clearAll() {
    const api = M();
    if (!api || typeof api.clear !== "function") {
      setMsg("记忆模块未就绪（请重启 Zotero 后再试）", "var(--pp-danger)");
      return;
    }

    let confirmed = false;
    let usedPrompt = false;
    try {
      if (typeof Services !== "undefined" && Services.prompt &&
          typeof Services.prompt.confirm === "function") {
        usedPrompt = true;
        confirmed = !!Services.prompt.confirm(
          Zotero.getMainWindow(),
          "Papilot · AI 记忆",
          "确定清空全部 AI 记忆？此操作不可撤销。");
      }
    } catch (e) { confirmed = false; }

    if (!usedPrompt) {
      // 无确认框能力 → 3 秒内二次点击确认
      const now = Date.now();
      if (clearArmedUntil > now) {
        confirmed = true;
        clearArmedUntil = 0;
      } else {
        clearArmedUntil = now + 3000;
        setMsg("再次点击「清空全部」以确认（3 秒内有效）", "var(--pp-warn)");
        return;
      }
    }
    if (!confirmed) return;

    let n = 0;
    try { n = api.clear() || 0; }
    catch (e) { n = 0; }
    render();
    setMsg(n ? "✓ 已清空 " + n + " 条记忆" : "没有可清空的记忆",
      n ? "var(--pp-success)" : "var(--pp-muted)");
  }

  /* ---------------- init（探测重试，同 prefs-schedule.js 纪律） ---------------- */

  function retry() {
    try {
      window.setTimeout(init, 400);
      window.setTimeout(init, 1200);
    } catch (e) { /* ignore */ }
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) { retry(); return; }
    const host = $("pp-mem-list");
    const btn = $("pp-mem-clear");
    if (!host || !btn) { retry(); return; }
    if (init._done) return;
    init._done = true;

    if (!msgNode) {
      // 0.75.2：优先用 xhtml 里既有的 pp-mem-result（此前它是没人写的死元素，
      // 反馈实际写到了这里动态创建的节点上 —— 两个相邻反馈区，容易漂移）。
      msgNode = $("pp-mem-result");
      if (!msgNode) {
        msgNode = el("div", { class: "pp-hint pp-mem-msg", style: "min-height:1em;" });
        if (btn.parentNode) btn.parentNode.insertBefore(msgNode, btn.nextSibling);
      }
    }
    btn.addEventListener("click", clearAll);

    try { render(); }
    catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
    }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
