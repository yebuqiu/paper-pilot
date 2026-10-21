// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本·快捷键卡片 + 锚点目录 + 模板导入导出（0.42.0 新增）
 * 与 prefs-menu.js 同窗格运行；经 Zotero.Papilot.hotkeys / noteTemplates 访问
 * bootstrap 作用域的中央快捷键注册表与模板中心。
 *
 * 渲染内容：
 *   ① 快捷键表格（getAll → 每行：名称 / 作用域 / 组合键 / 录制 / 重置 / 启用开关）；
 *      改键经 Hotkeys.setCombo 写 pref，注册表观察者即时重挂，无需重启；
 *   ② 锚点目录（按 .pp-cat-label 分类标签动态生成，点击滚动定位并展开该分类首张卡）；
 *   ③ 笔记模板「导出到剪贴板 / 从剪贴板导入」按钮。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测关键节点，不存在就延迟重试。
 * ⚠️ 动态创建的节点一律经变量持有，不要用 $(…) 取动态节点（check-wiring 守卫会误报）。
 */
/* global Zotero, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const PP = () => Zotero.Papilot || {};
  const HK = () => PP().hotkeys;
  const NT = () => PP().noteTemplates;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function setMsg(box, text, color) {
    if (!box) return;
    box.textContent = text || "";
    box.style.color = color || "var(--pp-success)";
  }

  /* ---------------- ① 快捷键表格 ---------------- */

  function renderHotkeys() {
    const host = $("pp-hotkeys-list");
    if (!host) return;
    const hk = HK();
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!hk || typeof hk.getAll !== "function") {
      host.appendChild(el("div", { class: "pp-hint" },
        zh ? "快捷键模块未就绪（插件启动后可配）" : "Hotkeys module not ready"));
      return;
    }
    let rows = [];
    try { rows = hk.getAll() || []; } catch (e) { rows = []; }
    if (!rows.length) {
      host.appendChild(el("div", { class: "pp-hint" },
        zh ? "暂无可配快捷键" : "No configurable hotkeys yet"));
      return;
    }
    for (const r of rows) {
      const line = el("div", { class: "pp-row pp-hk-row", style: "margin-top:6px;align-items:center;" });
      const name = el("span", { class: "pp-label", style: "min-width:200px;" }, r.label || r.id);
      const scope = el("span", { class: "pp-hint", style: "min-width:56px;" },
        r.scope === "reader" ? (zh ? "阅读器" : "Reader") : (zh ? "主窗口" : "Main"));
      const combo = el("span", {
        class: "pp-hint pp-hk-combo",
        style: "min-width:130px;" + (r.enabled === false ? "opacity:.5;text-decoration:line-through;" : ""),
      }, r.combo || (zh ? "（未设置）" : "(unset)"));
      const btnRec = el("button", { class: "pp-btn pp-btn-sm" }, zh ? "录制" : "Record");
      const btnReset = el("button", { class: "pp-btn pp-btn-sm" }, zh ? "重置" : "Reset");
      const chk = el("input", { type: "checkbox" });
      if (r.enabled !== false) chk.setAttribute("checked", "true");

      btnRec.addEventListener("click", () => {
        const resultBox = $("pp-hotkeys-result");
        setMsg(resultBox, zh ? "请按下新的组合键（Esc 取消）…" : "Press new combo (Esc to cancel)…", "");
        btnRec.setAttribute("disabled", "true");
        let cancel = null;
        try {
          cancel = hk.startRecording((newCombo) => {
            try { btnRec.removeAttribute("disabled"); } catch (e) { /* ignore */ }
            if (newCombo) {
              try {
                hk.setCombo(r.id, newCombo);
                setMsg(resultBox, (zh ? "已更新：" : "Updated: ") + (r.label || r.id) + " → " + newCombo);
              } catch (e) {
                setMsg(resultBox, String(e && e.message || e), "var(--pp-danger, #c00)");
              }
            } else {
              setMsg(resultBox, zh ? "已取消录制" : "Recording cancelled", "");
            }
            renderHotkeys();
          });
        } catch (e) {
          try { btnRec.removeAttribute("disabled"); } catch (e2) { /* ignore */ }
          setMsg(resultBox, String(e && e.message || e), "var(--pp-danger, #c00)");
        }
        // 30s 兜底：录制 promise 未回调时自行恢复按钮（用户可能切走了窗口）
        if (typeof window !== "undefined" && window.setTimeout) {
          window.setTimeout(() => {
            try {
              if (cancel) cancel();
              btnRec.removeAttribute("disabled");
            } catch (e) { /* ignore */ }
          }, 30000);
        }
      });
      btnReset.addEventListener("click", () => {
        try { hk.resetCombo(r.id); } catch (e) { /* ignore */ }
        setMsg($("pp-hotkeys-result"), zh ? "已恢复默认" : "Reset to default");
        renderHotkeys();
      });
      chk.addEventListener("change", () => {
        try { hk.setEnabled(r.id, !!chk.checked); } catch (e) { /* ignore */ }
        renderHotkeys();
      });

      line.appendChild(name);
      line.appendChild(scope);
      line.appendChild(combo);
      line.appendChild(btnRec);
      line.appendChild(btnReset);
      line.appendChild(chk);
      host.appendChild(line);
    }
  }

  /* ---------------- ② 锚点目录 ---------------- */

  /** 已生成的 chip 列表：[{ chip, target }]。滚动同步与高亮都靠它（顺序 = 分类顺序） */
  let _chips = [];

  /** 把某个 chip 标成「当前分类」，其余取消（0.68.4） */
  function markActiveByIndex(idx) {
    for (let i = 0; i < _chips.length; i++) {
      const c = _chips[i].chip;
      if (!c || !c.classList) continue;
      try {
        if (i === idx) { if (c.classList.add) c.classList.add("pp-anchor-active"); }
        else if (c.classList.remove) c.classList.remove("pp-anchor-active");
      } catch (e) { /* 老环境没有 classList.add 也不影响跳转 */ }
    }
  }

  /**
   * 滚动时同步高亮（0.68.4）。
   * 取「最后一个 top 已经越过吸顶高度 + 8」的分类标签——即当前视口顶部所在的那一类。
   * 全部都在视口下方时退化为第 1 个。
   */
  function syncActiveByScroll() {
    if (!_chips.length) return;
    const limit = stickyOffset() + 8;
    let best = -1;
    for (let i = 0; i < _chips.length; i++) {
      const t = _chips[i].target;
      if (!t || !t.getBoundingClientRect) continue;
      let top = null;
      try { top = t.getBoundingClientRect().top; } catch (e) { top = null; }
      if (top === null || typeof top !== "number") continue;
      if (top <= limit) best = i;
    }
    markActiveByIndex(best < 0 ? 0 : best);
  }

  /**
   * 给滚动容器挂节流监听（0.68.4）。
   * 滚动容器是 `.pp-root`（prefs.xhtml 里 style="overflow-y:auto"）。
   * ⚠️ 测试桩没有 document.querySelector，拿不到就安静跳过——绝不能因此抛错。
   */
  function bindScrollSync() {
    try {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
      const root = document.querySelector(".pp-root");
      if (!root || !root.addEventListener) return;
      let ticking = false;
      const run = () => {
        ticking = false;
        try { syncActiveByScroll(); } catch (e) { /* ignore */ }
      };
      root.addEventListener("scroll", () => {
        if (ticking) return;
        ticking = true;
        try {
          if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(run);
          } else if (typeof window !== "undefined" && window.setTimeout) {
            window.setTimeout(run, 120);
          } else { run(); }
        } catch (e) { run(); }
      });
    } catch (e) { /* 同步高亮是锦上添花，失败不影响直达 */ }
  }

  /**
   * 吸顶工具条挡住多少像素（0.68.3）。
   *
   * 顶部工具条是 `position: sticky`（见 prefs.css），滚到顶部的分类标签会被它盖住，
   * 表现为「点直达好像没动」。这里量一下它的高度，滚动时留出这段距离；
   * 量不到就退回经验值 56（单行工具条约 44px + 12px 间距）。
   */
  function stickyOffset() {
    try {
      const bar = document.querySelector ? document.querySelector(".pp-toolbar") : null;
      if (!bar || !bar.getBoundingClientRect) return 56;
      const st = (typeof window !== "undefined" && window.getComputedStyle)
        ? window.getComputedStyle(bar) : null;
      if (st && st.position !== "sticky" && st.position !== "fixed") return 8;
      return Math.round((bar.getBoundingClientRect().height || 44) + 12);
    } catch (e) { return 56; }
  }

  /**
   * 滚到某个分类标签（0.68.4 重写）。
   *
   * 旧实现（0.68.3）的致命缺陷：**找到第一个「scrollHeight > clientHeight」的祖先就 break，
   * 从不验证 scrollTop 是否真的变了**。Zotero 设置窗格里 pane 外面套着
   * `<div id="prefs-content">`（`overflow:auto scroll`，见 Zotero 的 preferences.xhtml），
   * 中间层还可能有 `overflow:hidden` 的裁切盒——它们同样满足 `scrollHeight > clientHeight`，
   * 但 `scrollTop` 写进去纹丝不动。于是代码「以为滚了」，界面完全不动，
   * 用户看到的就是「直达没反应」（真机实测：prefsFoldOpen 已写入 → 点击生效，纯粹滚不动）。
   *
   * 现在的判定标准换成**可验证的事实**：
   *   ① 先调标准 `scrollIntoView()`（不带 options —— smooth 在 chrome 的 scrollbox 上会静默失败），
   *      用「调用前后 rect.top 是否变化」判断它到底有没有生效；
   *   ② 没生效就逐层往上写 scrollTop，**写完立刻回读**，没变就继续往上（不再 break）；
   *   ③ 还没动就显式试 Zotero 的滚动容器 `#prefs-content`（id 来自官方 preferences.xhtml）；
   *   ④ 全都失败时把现场写进 diagJump pref（不打扰用户，排查时读 profile/prefs.js 即可）。
   */
  function rectTop(node) {
    try { return Number(node.getBoundingClientRect().top); } catch (e) { return null; }
  }

  /** 在某一层上滚动，返回「scrollTop 是否真的变了」——这是判断它是不是真滚动框的唯一可靠信号 */
  function bumpScroll(container, delta) {
    try {
      const before = Number(container.scrollTop) || 0;
      container.scrollTop = Math.max(0, before + delta);
      const after = Number(container.scrollTop) || 0;
      return Math.abs(after - before) > 1;
    } catch (e) { return false; }
  }

  /** 把目标滚到「吸顶工具条下方」这个位置；返回是否真的滚动了 */
  function scrollByGeometry(target, off) {
    let moved = false;
    let p = target.parentNode;
    while (p && p.nodeType === 1) {
      try {
        const sh = Number(p.scrollHeight) || 0;
        const ch = Number(p.clientHeight) || 0;
        if (sh > ch + 4 && ch > 0) {
          const box = rectTop(p);
          const me = rectTop(target);
          if (box !== null && me !== null && bumpScroll(p, me - box - off)) { moved = true; break; }
        }
      } catch (e) { /* 这一层不行就继续往上 */ }
      p = p.parentNode;
    }
    if (!moved) {
      // 显式兜底：Zotero 设置窗口自己的滚动容器
      try {
        const box = document.getElementById("prefs-content");
        if (box) {
          const bt = rectTop(box);
          const me = rectTop(target);
          if (bt !== null && me !== null) moved = bumpScroll(box, me - bt - off);
        }
      } catch (e) { /* ignore */ }
    }
    return moved;
  }

  /** 滚到位后闪一下：即使几何量不准，用户也能看出跳到了哪个分类 */
  function flashLabel(target) {
    try {
      if (!target || !target.classList || !target.classList.add) return;
      target.classList.add("pp-jump-flash");
      if (typeof window !== "undefined" && window.setTimeout) {
        window.setTimeout(() => {
          try { target.classList.remove("pp-jump-flash"); } catch (e) { /* ignore */ }
        }, 900);
      }
    } catch (e) { /* ignore */ }
  }

  function scrollToLabel(target) {
    const off = stickyOffset();
    try { target.style.scrollMarginTop = off + "px"; } catch (e) { /* ignore */ }

    let moved = false;
    const t0 = rectTop(target);
    try { target.scrollIntoView(); } catch (e) { /* ignore */ }
    const t1 = rectTop(target);
    // scrollIntoView 生效的证据 = 调用前后位置真的变了（不凭「没抛异常」就认定成功）
    if (t0 !== null && t1 !== null && Math.abs(t1 - t0) > 2) {
      moved = true;
      // 它把目标顶到了滚动口最上沿，会被吸顶工具条盖住 → 再补一点
      if (t1 < off - 2) moved = scrollByGeometry(target, off) || moved;
    } else if (t1 !== null) {
      moved = scrollByGeometry(target, off);
    }

    flashLabel(target);

    if (!moved) {
      try {
        const chain = [];
        let p = target.parentNode;
        while (p && p.nodeType === 1 && chain.length < 5) {
          chain.push({
            id: p.id || "", cls: String(p.className || "").slice(0, 24),
            sh: Number(p.scrollHeight) || 0, ch: Number(p.clientHeight) || 0,
            top: rectTop(p),
          });
          p = p.parentNode;
        }
        Zotero.Prefs.set("extensions.zotero.papilot.diagJump",
          JSON.stringify({ at: Date.now(), off: off, t0: t0, t1: t1, chain: chain }), true);
      } catch (e) { /* 诊断写入失败不影响功能 */ }
    }
  }

  function renderAnchors() {
    const host = $("pp-anchor-nav");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    _chips = [];   // 重建前清空：chip 是新建节点，旧的引用全部作废
    const labels = document.querySelectorAll(".pp-cat-label");
    if (!labels || !labels.length) {
      host.style.display = "none";
      return;
    }
    host.appendChild(el("span", { class: "pp-hint" }, zh ? "直达：" : "Jump to: "));
    for (const lab of labels) {
      // 0.65.0：大类标签内是「名称 + 计数」两个 span，chip 只取名称
      let nameEl = null;
      try { nameEl = lab.querySelector(".pp-cat-name"); } catch (e) { nameEl = null; }
      const text = (nameEl && nameEl.textContent) || lab.textContent || "";
      const chip = el("button", { class: "pp-btn pp-btn-sm", title: text }, text);
      const target = lab;
      const slot = _chips.length;
      _chips.push({ chip: chip, target: target });
      // ★ 必须用 click：下面是 createElementNS(XHTML) 出来的 **HTML** 按钮，
      //   不派发 XUL 的 command 事件。0.65.0~0.68.2 绑的是 command，
      //   于是「直达」所有 chip 点了都没反应（用户报的「设置里面直达不可用」）。
      chip.addEventListener("click", () => {
        // 1) 先清搜索态：搜索时未命中的卡是 display:none，滚过去只会看到空白。
        //    reset 内部会 input.focus()，这里不再抢焦点（保持 reset 现状）。
        try {
          const S = window.PapilotPrefsSearch;
          if (S && typeof S.reset === "function") S.reset();
        } catch (e) { /* 搜索模块不在也能直达 */ }
        // 2) 滚动定位（含吸顶工具条让位）
        scrollToLabel(target);
        // 3) 展开该分类第一张折叠卡：优先走 prefs-fold.js 的钩子，它会把展开态
        //    写进 prefsFoldOpen 并同步 aria-expanded；没有钩子才退回直接改类名。
        try {
          let n = target.nextElementSibling;
          while (n) {
            if (n.classList && n.classList.contains("pp-fold")) {
              let done = false;
              try {
                const F = window.PapilotPrefsFold;
                if (F && typeof F.open === "function" && n.getAttribute) {
                  done = !!F.open(n.getAttribute("data-fold"));
                }
              } catch (e) { done = false; }
              if (!done) n.classList.remove("pp-fold-closed");
              break;
            }
            if (n.classList && n.classList.contains("pp-cat-label")) break;
            n = n.nextElementSibling;
          }
        } catch (e) { /* ignore */ }
        // 4) 当前分类高亮
        try { markActiveByIndex(slot); } catch (e) { /* ignore */ }
      });
      host.appendChild(chip);
    }
    // 首屏按当前位置标一次，之后跟着滚动走
    try { syncActiveByScroll(); } catch (e) { /* ignore */ }
    bindScrollSync();
  }

  /* ---------------- ③ 笔记模板导入导出 ---------------- */

  function wireTemplates() {
    const btnExp = $("pp-tpl-export");
    const btnImp = $("pp-tpl-import");
    if (!btnExp || !btnImp) return;
    btnExp.addEventListener("click", async () => {
      const box = $("pp-tpl-result");
      const nt = NT();
      if (!nt || typeof nt.exportAll !== "function") {
        setMsg(box, zh ? "模板模块未就绪" : "Templates module not ready", "var(--pp-danger, #c00)");
        return;
      }
      try {
        const ok = await nt.exportAll();
        setMsg(box, ok
          ? (zh ? "已复制到剪贴板（JSON）" : "Copied to clipboard (JSON)")
          : (zh ? "导出失败" : "Export failed"), ok ? "" : "var(--pp-danger, #c00)");
      } catch (e) {
        setMsg(box, String(e && e.message || e), "var(--pp-danger, #c00)");
      }
    });
    btnImp.addEventListener("click", async () => {
      const box = $("pp-tpl-result");
      const nt = NT();
      if (!nt || typeof nt.importJSON !== "function") {
        setMsg(box, zh ? "模板模块未就绪" : "Templates module not ready", "var(--pp-danger, #c00)");
        return;
      }
      try {
        const r = await nt.importJSON();
        if (r && r.ok) {
          setMsg(box, zh
            ? ("导入完成：新增 " + (r.added || 0) + "，覆盖 " + (r.overwritten || 0)
              + "，重命名 " + (r.renamed || 0) + "，跳过 " + (r.skipped || 0)
              + "（模板文本框刷新后可见）")
            : ("Imported: +" + (r.added || 0) + " / overwrote " + (r.overwritten || 0)
              + " / renamed " + (r.renamed || 0) + " / skipped " + (r.skipped || 0)));
        } else {
          setMsg(box, (zh ? "导入失败：" : "Import failed: ") + (r && r.error || ""), "var(--pp-danger, #c00)");
        }
      } catch (e) {
        setMsg(box, String(e && e.message || e), "var(--pp-danger, #c00)");
      }
    });
  }

  /* ---------------- init（探测重试，同 prefs-menu.js 纪律） ---------------- */

  function init() {
    if (!$("pp-hotkeys-list") || !$("pp-anchor-nav")) {
      if (typeof window !== "undefined" && window.setTimeout) {
        window.setTimeout(init, 400);
        window.setTimeout(init, 1200);
      }
      return;
    }
    if (init._done) return;
    init._done = true;
    try { renderAnchors(); } catch (e) { /* 渲染失败不影响面板其余部分 */ }
    try { renderHotkeys(); } catch (e) { /* ignore */ }
    try { wireTemplates(); } catch (e) { /* ignore */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
