// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本·菜单定制（0.29.0 新增）
 * 与 prefs-pane.js / prefs-account.js 同窗格运行；经 Zotero.Papilot.menus /
 * Zotero.Papilot.i18n 访问 bootstrap 作用域的 Menus 注册表与 i18n（单一真源，
 * 面板里的分组与直达项直接遍历注册表渲染，不维护第二份列表）。
 *
 * 渲染内容：菜单结构切换（menuMode，走 prefs.xhtml 声明式 preference 绑定）
 *          + 隐藏分组复选框（menuHiddenGroups，CSV）
 *          + 高频直达项下拉 ×3（menuQuickItems，CSV）。
 *
 * 写 pref 后由 menus.js 的 pref 观察者即时重建主窗口菜单，本脚本不需要（也不能）
 * 直接操作主窗口 DOM。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测关键节点，
 *    不存在就延迟重试，否则 null 崩溃会让整个面板永远不 loaded（同 prefs-pane）。
 * ⚠️ 动态创建的节点一律经变量持有，**不要**用 $(…) 去取动态节点，
 *    否则 check-wiring 的「元素 id 必须存在于 prefs.xhtml」守卫会误报。
 */
/* global Zotero, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const PP = () => Zotero.Papilot || {};
  const M = () => PP().menus;
  const T = () => PP().i18n;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const PREF = {
    hidden: "extensions.zotero.papilot.menuHiddenGroups",
    quick: "extensions.zotero.papilot.menuQuickItems",
  };

  function setMsg(text, color) {
    const box = $("pp-menu-result");
    if (!box) return;
    box.textContent = text || "";
    box.style.color = color || "var(--pp-success)";
  }

  const getPref = (key, fallback) => {
    try {
      const v = Zotero.Prefs.get(key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
  };
  const setPref = (key, val) => Zotero.Prefs.set(key, val, true);

  const parseCsv = (raw) =>
    String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);

  /* ---------- 直达项候选：注册表里可分组收纳的命令（排除 state 与顶层直达） ---------- */
  function quickCandidates() {
    const reg = M() && M().ITEM_REGISTRY;
    if (!reg) return [];
    const i18n = T();
    return reg
      .filter((i) => i.group && i.group !== "state")
      .map((i) => ({ id: i.id, label: i18n ? i18n.t(i.labelKey) : i.labelKey }));
  }

  /* ---------- 隐藏分组复选框 ---------- */
  function renderGroups() {
    const box = $("pp-menu-groups");
    const groups = M() && M().GROUPS;
    if (!box || !groups) return;
    box.innerHTML = "";
    const i18n = T();
    const hidden = new Set(parseCsv(getPref(PREF.hidden, "")));
    for (const g of groups) {
      const label = el("label", { class: "pp-check" });
      const cb = el("input", { type: "checkbox" });
      if (!hidden.has(g.id)) cb.setAttribute("checked", "true");
      cb.addEventListener("command", () => {
        const cur = new Set(parseCsv(getPref(PREF.hidden, "")));
        if (cb.checked) cur.delete(g.id);
        else cur.add(g.id);
        setPref(PREF.hidden, [...cur].join(","));
        setMsg(zh ? "已更新隐藏分组（右键菜单即时生效）" : "Hidden groups updated");
      });
      label.appendChild(cb);
      label.appendChild(el("span", null, " " + (i18n ? i18n.t(g.labelKey) : g.id)));
      box.appendChild(label);
    }
  }

  /* ---------- 高频直达项下拉 ×3 ---------- */
  function renderQuick() {
    const selects = [$("pp-menu-quick-0"), $("pp-menu-quick-1"), $("pp-menu-quick-2")];
    const cand = quickCandidates();
    if (!cand.length || selects.some((s) => !s)) return;
    const chosen = parseCsv(getPref(PREF.quick, "ai-summary,bilingual-view"));
    const noneLabel = zh ? "（无）" : "(none)";
    for (let idx = 0; idx < selects.length; idx++) {
      const sel = selects[idx];
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      sel.appendChild(el("option", { value: "" }, noneLabel));
      // 已被其他下拉占用的命令灰显，避免直达项重复
      const taken = new Set(chosen.filter((_, i) => i !== idx));
      for (const c of cand) {
        const opt = el("option", { value: c.id }, c.label);
        if (taken.has(c.id)) opt.setAttribute("disabled", "true");
        sel.appendChild(opt);
      }
      sel.value = chosen[idx] || "";
      sel.addEventListener("command", () => {
        const cur = selects.map((s) => s.value).filter(Boolean);
        const dedup = [...new Set(cur)];
        setPref(PREF.quick, dedup.join(","));
        setMsg(zh ? "已更新直达项（右键菜单即时生效）" : "Quick items updated");
        renderQuick(); // 重渲染灰显态
      });
    }
  }

  function init() {
    if (!$("pp-menu-groups") || !$("pp-menu-quick-0") || !M()) {
      if (typeof window !== "undefined" && window.setTimeout) {
        window.setTimeout(init, 400);
        window.setTimeout(init, 1200);
      }
      return;
    }
    if (init._done) return;
    init._done = true;
    try {
      renderGroups();
      renderQuick();
    } catch (e) { /* 渲染失败不影响面板其余部分 */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
