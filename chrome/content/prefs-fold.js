// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格 · 折叠分组脚本（0.38.0 新增）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行，
 * 与 prefs-pane / prefs-account / prefs-translate / prefs-menu / prefs-theme 并列。
 *
 * 职责（刻意收窄——只管折叠，不碰任何设置项本身）：
 *   ① 按 prefsFoldOpen pref（CSV，存「已展开」的 data-fold 键）恢复/切换折叠态；
 *   ② 工具条「全部展开 / 全部收起」；
 *   ③ 深链定位：其他入口（如划词浮窗「未就绪」）打开设置时，先在
 *      Zotero.Papilot._prefsFocus 放一个分组键，这里负责展开并滚动到该分组，
 *      消费后立即清掉（一次性）。
 *
 * ⚠️ 兼容性铁律：折叠 = 只在分组卡片上切 .pp-fold-closed 类（CSS display:none），
 *    不挪动、不删除、不重建任何节点——五个面板脚本全靠 getElementById 探测元素，
 *    preference= 声明式绑定也不受 display 影响。设置项的读写路径零改动。
 * ⚠️ Zotero 先加载本脚本、后插入 fragment DOM（_loadPane 顺序）——init 必须
 *    探测关键节点、不存在就延迟重试，否则 null 崩溃导致面板永远不 loaded（同 prefs-pane）。
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
    }
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

    // 点击标题行 → 切换该组并记住
    for (const sec of sections()) {
      const head = sec.querySelector(".pp-fold-head");
      if (!head) continue;
      head.addEventListener("click", () => {
        const key = sec.getAttribute("data-fold");
        const cur = getOpen();
        if (cur.has(key)) cur.delete(key); else cur.add(key);
        apply(cur);
        setOpen(cur);
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
