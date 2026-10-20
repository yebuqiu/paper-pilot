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

      btnRec.addEventListener("command", () => {
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
      btnReset.addEventListener("command", () => {
        try { hk.resetCombo(r.id); } catch (e) { /* ignore */ }
        setMsg($("pp-hotkeys-result"), zh ? "已恢复默认" : "Reset to default");
        renderHotkeys();
      });
      chk.addEventListener("command", () => {
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

  function renderAnchors() {
    const host = $("pp-anchor-nav");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
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
      chip.addEventListener("command", () => {
        try {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          // 展开该分类第一张折叠卡，避免「滚到了但还是收起状态」
          let n = target.nextElementSibling;
          while (n) {
            if (n.classList && n.classList.contains("pp-fold")) {
              n.classList.remove("pp-fold-closed");
              break;
            }
            if (n.classList && n.classList.contains("pp-cat-label")) break;
            n = n.nextElementSibling;
          }
        } catch (e) { /* ignore */ }
      });
      host.appendChild(chip);
    }
  }

  /* ---------------- ③ 笔记模板导入导出 ---------------- */

  function wireTemplates() {
    const btnExp = $("pp-tpl-export");
    const btnImp = $("pp-tpl-import");
    if (!btnExp || !btnImp) return;
    btnExp.addEventListener("command", async () => {
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
    btnImp.addEventListener("command", async () => {
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
