// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 选文献窗格：检索 Zotero → 勾选 → 插入到光标处
 * 支持记一条"引用出处"：选了页码/标注后，插进书签名里，之后「回到原文」能精确跳回去。
 */
(function () {
  "use strict";
  const Z = window.PPZotero;
  const App = window.PPApp;

  const $ = (id) => document.getElementById(id);
  const picked = new Map();     // key -> row data
  let rows = [];

  function setMsg(t, bad) {
    const n = $("msg");
    n.textContent = t || "";
    n.style.color = bad ? "#d1242f" : "#59636e";
  }

  function initials(authors) {
    if (!authors || !authors.length) return "";
    const first = authors[0];
    const n = authors.length;
    const last = first.name || first.lastName || first.firstName || "";
    return n > 1 ? `${last} 等` : String(last);
  }

  function year(d) {
    const m = /(\d{4})/.exec(String(d.date || ""));
    return m ? m[1] : "";
  }

  function render() {
    const box = $("list");
    box.innerHTML = "";
    if (!rows.length) return;
    for (const r of rows) {
      const d = r.data;
      const el = document.createElement("label");
      el.className = "item";
      el.innerHTML =
        `<input type="checkbox" data-key="${r.key}" ${picked.has(r.key) ? "checked" : ""}/>` +
        `<span><span class="t">${escapeHtml(d.title || "(无标题)")}</span>` +
        `<br><span class="m">${escapeHtml(initials(d.creators))} ${escapeHtml(year(d))}` +
        `${d.publicationTitle ? " · " + escapeHtml(d.publicationTitle) : ""}</span></span>`;
      box.appendChild(el);
    }
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const key = cb.getAttribute("data-key");
        if (cb.checked) {
          const r = rows.find((x) => x.key === key);
          picked.set(key, r);
        } else {
          picked.delete(key);
        }
        $("ins").textContent = `插入选中（${picked.size}）`;
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function search() {
    const q = $("q").value.trim();
    if (!q) return;
    setMsg("检索中…");
    try {
      rows = await Z.search(q, 20);
      App.log("picker search", { q: q, n: rows.length });
      if (!rows.length) setMsg("没找到条目。检查关键词，或确认 Zotero 本地 API 已开启。", true);
      else setMsg(`找到 ${rows.length} 条，勾选后点「插入选中」。`);
      render();
    } catch (e) {
      setMsg(App.connError(e), true);
    }
  }

  async function insert() {
    if (!picked.size) {
      setMsg("先勾选至少一条文献。", true);
      return;
    }
    const items = [...picked.values()].map((r) => ({
      key: r.key, libId: r.libId || 1, page: 0, anno: "", locator: "",
    }));
    setMsg("写入文档…");
    const hasWps = (typeof wps !== "undefined" && wps && wps.WpsApplication);
    App.log("picker insert", { n: items.length, hasWps: !!hasWps });
    if (!hasWps) {
      // 任务窗格是独立页面，拿不到 wps 对象 —— 交给主页面去写
      try {
        await Z.call("/queue", { method: "POST", body: { items } });
        setMsg("已选中。关掉这个窗口就会写入文档。");
        App.log("picker queue push", { pending: q && q.pending });
      } catch (e) {
        setMsg("无法与文档通信：" + App.connError(e), true);
      }
      return;
    }
    try {
      const r = await App.insertCitation(items);
      if (r && r.ok) {
        setMsg(`已插入 ${items.length} 条：${r.text}`);
        picked.clear();
        $("ins").textContent = "插入选中（0）";
        render();
        setTimeout(() => { try { window.close(); } catch (e) { /* 关不掉就留着 */ } }, 600);
      } else {
        setMsg("插入失败：" + ((r && r.error) || "未知原因"), true);
      }
    } catch (e) {
      setMsg("插入失败：" + (e.message || e), true);
    }
  }

  try {
    $("style").textContent = App.style().label || "";
  } catch (e) { /* 取不到样式名不影响使用 */ }
  $("close").addEventListener("click", () => { try { window.close(); } catch (e) { /* 弹窗里可能不允许 */ } });

  $("go").addEventListener("click", search);
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") search();
  });
  $("ins").addEventListener("click", insert);
  $("clr").addEventListener("click", () => {
    picked.clear();
    rows = [];
    render();
    $("ins").textContent = "插入选中（0）";
    setMsg("已清空。");
  });

  Z.health().then((h) => {
    if (!h.ok) setMsg("本地服务没在运行。双击这个文件启动：" + App.proxyBat(), true);
    else if (!h.localApi) setMsg("Zotero 本地 API 未开启：设置 → 高级 → 允许其他应用与 Zotero 通信。", true);
  });
}());
