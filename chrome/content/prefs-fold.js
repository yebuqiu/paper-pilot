// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格 · 折叠分组与面板搜索脚本（0.38.0 新增，0.65.0 加搜索）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行，
 * 与 prefs-pane / prefs-account / prefs-translate / prefs-menu / prefs-theme 并列。
 *
 * 职责（刻意收窄——只管面板外壳，不碰任何设置项本身）：
 *   ① 按 prefsFoldOpen pref（CSV，存「已展开」的 data-fold 键）恢复/切换折叠态；
 *   ② 工具条「全部展开 / 全部收起」；
 *   ③ 深链定位：其他入口（如划词浮窗「未就绪」）打开设置时，先在
 *      Zotero.Papilot._prefsFocus 放一个分组键，这里负责展开并滚动到该分组，
 *      消费后立即清掉（一次性）；
 *   ④ 设置项搜索（0.65.0）：按卡片标题 / 说明 / data-search-strings-raw 关键词过滤，
 *      命中项即时展开、组内无命中则整组标签一起隐藏；搜索只切 .pp-hidden 类，
 *      不改折叠 pref，退出搜索即恢复原折叠状态。
 *
 * ⚠️ 兼容性铁律：折叠 = 只在分组卡片上切 .pp-fold-closed 类（CSS display:none），
 *    不挪动、不删除、不重建任何节点——五个面板脚本全靠 getElementById 探测元素，
 *    preference= 声明式绑定也不受 display 影响。设置项的读写路径零改动。
 * ⚠️ Zotero 先加载本脚本、后插入 fragment DOM（_loadPane 顺序）——init 必须
 *    探测关键节点、不存在就延迟重试，否则 null 崩溃导致面板永远不 loaded（同 prefs-pane）。
 * ⚠️ 测试用迷你 DOM 只实现了 getElementById / querySelectorAll 与 classList.toggle，
 *    所以这里只用这两样能力（不依赖 querySelector / classList.contains / dataset）。
 */
/* global Zotero, window, document */

(function () {
  const PREF_KEY = "extensions.zotero.papilot.prefsFoldOpen";
  const $ = (id) => document.getElementById(id);

  const getOpen = () => {
    try {
      return new Set(String(Zotero.Prefs.get(PREF_KEY, true) || "")
        .split(",").map((s) => s.trim()).filter(Boolean));
    } catch (e) { return new Set(); }
  };
  const setOpen = (set) => {
    try { Zotero.Prefs.set(PREF_KEY, [...set].join(","), true); } catch (e) { /* ignore */ }
  };

  function sections() {
    try {
      return Array.prototype.slice.call(
        document.querySelectorAll(".pp-root .pp-fold[data-fold]"));
    } catch (e) { return []; }
  }

  /** 把「已展开键集合」应用到 DOM（不在集合里 = 收起） */
  function apply(open) {
    for (const sec of sections()) {
      const key = sec.getAttribute("data-fold");
      try { sec.classList.toggle("pp-fold-closed", !open.has(key)); }
      catch (e) { /* 老 Gecko 兜底：直接改 class 字符串 */ 
        const has = (" " + sec.className + " ").indexOf(" pp-fold-closed ") >= 0;
        if (!open.has(key) && !has) sec.className += " pp-fold-closed";
        else if (open.has(key) && has) sec.className = sec.className.replace(/\s*pp-fold-closed/, "");
      }
      // 屏幕阅读器同步：展开态写进 aria-expanded（键盘用户据此知道当前是开还是关）
      try {
        const h = sec.querySelector(".pp-fold-head");
        if (h && h.setAttribute) h.setAttribute("aria-expanded", open.has(key) ? "true" : "false");
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------- 0.65.0 设置项搜索 ---------- */

  const hasCls = (el, c) => !!el && (" " + (el.className || "") + " ").indexOf(" " + c + " ") >= 0;
  const toggleCls = (el, c, on) => {
    if (!el) return;
    try { el.classList.toggle(c, !!on); } catch (e) { /* ignore */ }
  };

  /** 卡片索引：标题 + 说明 + 关键词（data-search-strings-raw）+ 折叠键 */
  function buildIndex() {
    return sections().map((sec) => {
      const pick = (sel) => { try { return sec.querySelector(sel); } catch (e) { return null; } };
      const title = pick(".pp-card-title");
      const desc = pick(".pp-card-desc");
      const raw = sec.getAttribute("data-search-strings-raw") || "";
      const key = sec.getAttribute("data-fold") || "";
      const text = [title && title.textContent, desc && desc.textContent, raw, key]
        .filter(Boolean).join(" ").toLowerCase();
      return { sec, text };
    });
  }

  function initSearch() {
    const input = $("pp-prefs-search");
    if (!input) return false;
    if (input.getAttribute("data-pp-bound") === "1") return true;
    input.setAttribute("data-pp-bound", "1");

    const clearBtn = $("pp-prefs-search-clear");
    const countEl = $("pp-pref-count");
    const idx = buildIndex();
    const total = idx.length;
    const baseText = countEl ? String(countEl.textContent || "") : "";

    const rootOf = () => {
      try {
        const rs = document.querySelectorAll(".pp-root");
        return rs && rs.length ? rs[0] : null;
      } catch (e) { return null; }
    };

    function apply(q) {
      const terms = String(q || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      const searching = terms.length > 0;
      let matched = 0;
      for (const it of idx) {
        const hit = !searching || terms.every((t) => it.text.indexOf(t) >= 0);
        if (hit) matched++;
        toggleCls(it.sec, "pp-hidden", !hit);
      }
      // 分组标签：组内一张卡都没命中 → 标签一起隐藏（避免「空标题」）
      const root = rootOf();
      if (root && root.children) {
        const kids = root.children;
        for (let i = 0; i < kids.length; i++) {
          if (!hasCls(kids[i], "pp-cat-label")) continue;
          let any = false;
          for (let j = i + 1; j < kids.length; j++) {
            if (hasCls(kids[j], "pp-cat-label")) break;
            if (hasCls(kids[j], "pp-card") && !hasCls(kids[j], "pp-hidden")) { any = true; break; }
          }
          toggleCls(kids[i], "pp-hidden", searching && !any);
        }
      }
      toggleCls(root, "pp-searching", searching);
      if (countEl) {
        countEl.textContent = searching ? (matched + " / " + total + " 项") : baseText;
        toggleCls(countEl, "pp-count-hit", searching);
      }
      if (clearBtn) clearBtn.style.display = searching ? "" : "none";
      return matched;
    }

    const reset = () => {
      input.value = "";
      apply("");
      try { input.focus(); } catch (e) { /* ignore */ }
    };
    input.addEventListener("input", () => apply(input.value));
    input.addEventListener("keydown", (e) => {
      if (e && e.key === "Escape") reset();
    });
    if (clearBtn) clearBtn.addEventListener("click", reset);
    apply(input.value || "");
    return true;
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) {
      window.setTimeout(init, 400);
      return;
    }
    // Zotero 先执行脚本、后插入 fragment：关键节点不存在就延迟重试
    if (!$("pp-fold-expand") || !$("pp-fold-collapse") || !sections().length) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    // 深链定位：读一次性焦点键（reader-popup 等入口在 openPreferences 前放上）
    let focusKey = "";
    try {
      focusKey = String((Zotero.Papilot && Zotero.Papilot._prefsFocus) || "");
      if (Zotero.Papilot) Zotero.Papilot._prefsFocus = "";
    } catch (e) { /* ignore */ }

    const open = getOpen();
    if (focusKey) open.add(focusKey);
    apply(open);

    // 点击 / 键盘都能切换（0.65.1）：标题行本来是 div + click，键盘用户完全打不开，
    // 屏幕阅读器也读不出「这是一个可展开的分区」。补 role/tabindex/aria-expanded/aria-controls。
    for (const sec of sections()) {
      const head = sec.querySelector(".pp-fold-head");
      if (!head) continue;
      const key = sec.getAttribute("data-fold");
      try {
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");
        const body = sec.querySelector(".pp-card-body");
        if (body) {
          if (!body.id && key) body.id = "pp-fold-body-" + key;
          if (body.id) head.setAttribute("aria-controls", body.id);
        }
      } catch (e) { /* 老环境没有 setAttribute 也无所谓，功能不受影响 */ }

      const toggle = () => {
        const cur = getOpen();
        if (cur.has(key)) cur.delete(key); else cur.add(key);
        apply(cur);
        setOpen(cur);
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (e) => {
        if (!e) return;
        const k = e.key;
        // Space / Spacebar（老 Gecko 写法）/ Enter
        if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
        if (e.preventDefault) e.preventDefault();   // 空格不滚页面、回车不触发默认动作
        toggle();
      });
    }

    const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
    bind("pp-fold-expand", () => {
      const all = new Set(sections().map((s) => s.getAttribute("data-fold")));
      apply(all);
      setOpen(all);
    });
    bind("pp-fold-collapse", () => {
      apply(new Set());
      setOpen(new Set());
    });

    // 搜索框与折叠互不影响：搜索只切 .pp-hidden，不动 prefsFoldOpen
    try { initSearch(); } catch (e) { /* 搜索不可用不影响折叠 */ }

    // 深链滚动定位（等一帧让布局先稳定）
    if (focusKey) {
      window.setTimeout(() => {
        try {
          const target = sections().filter(
            (s) => s.getAttribute("data-fold") === focusKey)[0];
          if (target && target.scrollIntoView) {
            target.scrollIntoView({ block: "start", behavior: "smooth" });
          }
        } catch (e) { /* ignore */ }
      }, 60);
    }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
