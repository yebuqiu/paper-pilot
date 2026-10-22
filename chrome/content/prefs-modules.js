// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本 · 组件管理（0.73.2）
 *
 * 背景：0.73.0/0.73.1 的轻量版把功能组件改成了「按需下载」。用户反馈：
 * 首启弹窗式引导太打扰，真正要的是「装完安静 + 在设置里按需装」。本卡片即按需入口。
 *
 * 运行上下文是设置窗口作用域：拿不到 bootstrap 作用域，全部经 Zotero.Papilot.moduleStore。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 #pp-mods-list，
 *    不存在就延迟重试（同 prefs-cloud.js / prefs-subs.js 纪律）。
 * ⚠️ 动态节点一律经变量持有，不用 $() 取动态节点（check-wiring 守卫）。
 * ⚠️ 目录拉取失败不弹窗：只写状态行（离线时列表仍显示已安装组件，可卸载）。
 */
/* global Zotero, Services, window, document */

(function () {
  const $ = (id) => document.getElementById(id);
  const MS = () => ((typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.moduleStore) || null);
  const LD = () => ((typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.moduleLoader) || null);

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const el = (tag, cls, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (cls) node.setAttribute("class", cls);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const fmtSize = (n) => {
    const v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(0) + " KB";
    return (v / 1024 / 1024).toFixed(1) + " MB";
  };

  let _busy = false;

  function setMsg(text, kind) {
    const m = $("pp-mods-msg");
    if (!m) return;
    m.textContent = text || "";
    m.setAttribute("data-kind", kind || "");
  }

  function stateBadge(row) {
    if (row.broken) return { text: "损坏", cls: "pp-mods-badge pp-mods-badge-danger" };
    if (row.updateAvailable) return { text: "可更新", cls: "pp-mods-badge pp-mods-badge-warn" };
    if (row.installed) return { text: "已安装 " + (row.installedVersion || ""), cls: "pp-mods-badge pp-mods-badge-ok" };
    return { text: "未安装", cls: "pp-mods-badge" };
  }

  function renderRow(listEl, row) {
    const card = el("div", "pp-mods-row" + (row.bundle ? " pp-mods-row-bundle" : ""));
    const left = el("div", "pp-mods-row-main");
    const title = el("div", "pp-mods-row-title");
    title.appendChild(el("span", "pp-mods-row-name", row.name || row.id));
    if (row.bundle) title.appendChild(el("span", "pp-mods-badge pp-mods-badge-bundle", "合集"));
    if (row.pro) title.appendChild(el("span", "pp-mods-badge pp-mods-badge-pro", "Pro"));
    const st = stateBadge(row);
    title.appendChild(el("span", st.cls, st.text));
    left.appendChild(title);
    left.appendChild(el("div", "pp-mods-row-desc", row.description || ""));
    left.appendChild(el("div", "pp-mods-row-meta",
      (row.bundle ? "含 " + (row.contains || []).length + " 个组件 · " : "")
      + fmtSize(row.sizeBytes)
      + (row.version ? " · v" + row.version : "")));
    card.appendChild(left);

    const acts = el("div", "pp-mods-row-actions");
    const ms = MS();
    const mkBtn = (label, cls, fn) => {
      const b = el("button", "pp-btn pp-btn-sm" + (cls ? " " + cls : ""), label);
      b.addEventListener("click", () => { if (!_busy) fn(); });
      acts.appendChild(b);
      return b;
    };
    if (!ms) {
      acts.appendChild(el("span", "pp-hint", "运行时未就绪"));
    } else if (row.broken) {
      mkBtn("重装", "pp-btn-primary", () => runOp("install", row.id, row.name));
    } else if (row.updateAvailable) {
      mkBtn("更新到 v" + row.version, "pp-btn-primary", () => runOp("install", row.id, row.name));
      mkBtn("卸载", "", () => runOp("uninstall", row.id, row.name));
    } else if (row.installed) {
      if (row.canRollback) mkBtn("回滚", "", () => runOp("rollback", row.id, row.name));
      mkBtn("卸载", "", () => runOp("uninstall", row.id, row.name));
    } else {
      mkBtn("安装（" + fmtSize(row.sizeBytes) + "）", "pp-btn-primary",
        () => runOp("install", row.id, row.name));
    }
    card.appendChild(acts);
    listEl.appendChild(card);
  }

  function render() {
    const listEl = $("pp-mods-list");
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    const ms = MS();
    if (!ms) {
      listEl.appendChild(el("div", "pp-hint", "组件运行时不可用（完整安装包不受影响）。"));
      return;
    }
    let rows = [];
    try { rows = ms.listRows ? ms.listRows() : []; } catch (e) { rows = []; }
    if (!rows.length) {
      listEl.appendChild(el("div", "pp-hint",
        "目录暂不可用（离线或源不可达）。已安装的组件不受影响；点「刷新目录」重试。"));
      return;
    }
    // 合集与推荐项置顶，其余按名称
    rows.sort((a, b) => (Number(b.bundle) - Number(a.bundle))
      || (Number(b.recommended) - Number(a.recommended))
      || String(a.name || a.id).localeCompare(String(b.name || b.id), "zh"));
    for (const r of rows) renderRow(listEl, r);
  }

  async function runOp(op, id, name) {
    const ms = MS();
    if (!ms || _busy) return;
    _busy = true;
    const label = { install: "安装", uninstall: "卸载", rollback: "回滚" }[op] || op;
    setMsg("正在" + label + "「" + (name || id) + "」…", "busy");
    try {
      const fn = ms[op];
      const r = await fn.call(ms, id);
      if (r && r.ok) {
        setMsg(label + "完成：" + (name || id) + (r.version ? "（v" + r.version + "）" : ""), "ok");
      } else {
        setMsg(label + "失败：" + ((r && r.error) || "未知错误"), "error");
      }
    } catch (e) {
      setMsg(label + "失败：" + (e && (e.message || e)), "error");
    }
    _busy = false;
    render();
  }

  async function refresh() {
    const ms = MS();
    if (!ms || _busy) return;
    _busy = true;
    setMsg("正在刷新目录…", "busy");
    try {
      const r = await ms.fetchCatalog(true);
      setMsg(r && r.ok
        ? "目录已更新（" + ((r.modules || []).length) + " 项，来源：" + (r.source || "?") + "）"
        : "目录拉取失败：" + ((r && r.error) || "未知错误"),
        r && r.ok ? "ok" : "error");
    } catch (e) {
      setMsg("目录拉取失败：" + (e && (e.message || e)), "error");
    }
    _busy = false;
    render();
  }

  function init() {
    const listEl = $("pp-mods-list");
    const btnRefresh = $("pp-mods-refresh");
    const btnStore = $("pp-mods-store");
    if (!listEl || !btnRefresh) {
      // fragment 还没插进来（Zotero 先加载脚本、后插入 DOM），延迟重试
      window.setTimeout(init, 300);
      return;
    }
    btnRefresh.addEventListener("click", refresh);
    if (btnStore) {
      btnStore.addEventListener("click", () => {
        try { Zotero.Papilot.openModuleStore(); } catch (e) { /* ignore */ }
      });
    }
    render();
    // 目录还没拉过就静默拉一次（不阻塞首屏）
    const ms = MS();
    if (ms && !ms.getCatalog || !ms.getCatalog()) {
      try { ms.fetchCatalog(false).then(render, render); } catch (e) { /* ignore */ }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
