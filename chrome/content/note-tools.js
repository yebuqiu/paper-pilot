// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 笔记工具窗口（0.63.0 · A2）
 *
 * 只做渲染与交互：解析/写回/批量操作全部由 Zotero.Papilot.noteTools 完成（便于单测）。
 * 数据通道与其它窗口一致：**不直接摸 Zotero/Services**，一律经 window.arguments[0].api
 * （标签/前缀输入需要 Services.prompt，也由 api.askTags/askPrefix 在主窗口弹出）。
 *
 * 纪律：先刷新列表、再写状态行（反馈必须描述刷新后的真实状态）。
 */
/* global window, document */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const api = args.api || null;
  const payload = args.payload || {};
  const zh = !!(api && typeof api.isZh === "function" && api.isZh());

  const T = {
    noApi: zh ? "错误：无法访问 Papilot 模块（请从菜单重新打开本窗口）" : "Error: module unavailable",
    noNotes: zh ? "没有可整理的笔记。" : "No notes to organize.",
    noSelection: zh ? "请先勾选至少一条笔记。" : "Select at least one note first.",
    working: zh ? "处理中…" : "Working…",
    cancelled: zh ? "已取消（没有输入内容）" : "Cancelled (nothing entered)",
    failed: zh ? "失败：" : "Failed: ",
    outlineDone: zh ? "大纲已更新 {n}/{m} 条（其余无需改动）" : "Outline updated for {n}/{m}",
    outlineNone: zh ? "没有可识别的标题：请先在笔记正文里用「标题 1/2/3」写小节" : "No headings found in the note body",
    removeDone: zh ? "已移除 {n}/{m} 条笔记的大纲块" : "Outline removed from {n}/{m}",
    tagsAdded: zh ? "已给 {n} 条笔记加上标签：{t}" : "Tagged {n} note(s): {t}",
    tagsRemoved: zh ? "已从 {n} 条笔记去掉标签：{t}" : "Untagged {n} note(s): {t}",
    moveDone: zh ? "已移入当前分类：{n} 条" : "Moved {n} note(s) into the selected collection",
    noCollection: zh ? "请先在主窗口左侧选中一个分类，再执行「移入当前分类」" : "Select a collection in the main window first",
    prefixDone: zh ? "已统一标题前缀：{n} 条" : "Title prefix applied to {n} note(s)",
    mergeDone: zh ? "已合并为新笔记：{n} 条（原笔记保留，未删除）" : "Merged into a new note: {n} note(s) (originals kept)",
    count: zh ? "已选 {n} / {m} 条" : "{n} / {m} selected",
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function setStatus(msg) {
    const box = $("pp-nt-status");
    if (box) box.textContent = String(msg == null ? "" : msg);
  }

  function fill(tpl, map) {
    let s = String(tpl);
    for (const k of Object.keys(map || {})) s = s.split("{" + k + "}").join(String(map[k]));
    return s;
  }

  function boxes() {
    return Array.from(document.querySelectorAll("#pp-nt-list input.pp-nt-cb"));
  }

  function selectedIds() {
    const out = [];
    for (const cb of boxes()) {
      if (!cb.checked) continue;
      const id = Number(cb.getAttribute("data-id"));
      if (id) out.push(id);
    }
    return out;
  }

  function updateCount() {
    const box = $("pp-nt-count");
    if (box) box.textContent = fill(T.count, { n: selectedIds().length, m: boxes().length });
  }

  function setAll(on) {
    for (const cb of boxes()) cb.checked = !!on;
    updateCount();
  }

  /** 渲染列表（每次操作后调用；渲染本身不写状态行） */
  function renderList() {
    const box = $("pp-nt-list");
    if (!box) return;
    box.textContent = "";
    let rows = [];
    try { rows = api.list() || []; } catch (e) { rows = []; }
    if (!rows.length) {
      box.appendChild(el("div", "padding:10px;color:var(--fill-tertiary,#999);", T.noNotes));
      updateCount();
      return;
    }
    const ids = new Set((payload.ids || []).map((x) => Number(x)));
    for (const r of rows) {
      const row = el("div", "display:flex;gap:8px;align-items:flex-start;padding:5px 2px;border-bottom:1px dashed rgba(128,128,128,.25);");
      const cb = document.createElementNS(XHTML, "input");
      cb.setAttribute("type", "checkbox");
      cb.setAttribute("data-id", String(r.id));
      cb.className = "pp-nt-cb";
      // 打开窗口时带来的笔记默认勾上（用户点菜单就是要处理它们）
      cb.checked = ids.size ? ids.has(Number(r.id)) : false;
      cb.addEventListener("change", updateCount);
      row.appendChild(cb);

      const right = el("div", "flex:1;min-width:0;");
      right.appendChild(el("div", "font-weight:600;word-break:break-word;", r.title || ("#" + r.id)));
      const meta = [];
      meta.push(zh ? "标题 " + (r.headings || 0) + " 个" : (r.headings || 0) + " headings");
      if (r.excerpt) meta.push(r.excerpt);
      right.appendChild(el("div", "font-size:11.5px;color:var(--fill-secondary,#666);word-break:break-word;", meta.join(" ｜ ")));
      row.appendChild(right);
      box.appendChild(row);
    }
    updateCount();
  }

  function fail(r) {
    const detail = r && r.error ? r.error : (zh ? "未知错误" : "unknown error");
    setStatus(T.failed + detail);
  }

  /* ---------------- 事件 ---------------- */

  async function onRefresh() {
    const ids = selectedIds();
    if (!ids.length) return setStatus(T.noSelection);
    setStatus(T.working);
    let changed = 0;
    let headings = 0;
    let bad = null;
    for (const id of ids) {
      const r = await api.refreshOutline(id);
      if (r && r.ok) {
        headings += Number(r.count) || 0;
        if (r.changed) changed++;
      } else if (r && !r.ok && !bad) {
        bad = r;
      }
    }
    renderList();
    if (bad) return fail(bad);
    setStatus(changed ? fill(T.outlineDone, { n: changed, m: ids.length })
      : (headings ? fill(T.outlineDone, { n: 0, m: ids.length }) : T.outlineNone));
  }

  async function onRemoveOutline() {
    const ids = selectedIds();
    if (!ids.length) return setStatus(T.noSelection);
    setStatus(T.working);
    let changed = 0;
    let bad = null;
    for (const id of ids) {
      const r = await api.removeOutline(id);
      if (r && r.ok) { if (r.changed) changed++; }
      else if (r && !r.ok && !bad) bad = r;
    }
    renderList();
    if (bad) return fail(bad);
    setStatus(fill(T.removeDone, { n: changed, m: ids.length }));
  }

  async function onAddTags() {
    const ids = selectedIds();
    if (!ids.length) return setStatus(T.noSelection);
    const tags = api.askTags();
    if (!tags || !tags.length) return setStatus(T.cancelled);
    setStatus(T.working);
    const r = await api.addTags(ids, tags);
    renderList();
    if (!r || !r.ok) return fail(r);
    setStatus(fill(T.tagsAdded, { n: r.changed || 0, t: tags.join(", ") }));
  }

  async function onRemoveTags() {
    const ids = selectedIds();
    if (!ids.length) return setStatus(T.noSelection);
    const tags = api.askTags();
    if (!tags || !tags.length) return setStatus(T.cancelled);
    setStatus(T.working);
    const r = await api.removeTags(ids, tags);
    renderList();
    if (!r || !r.ok) return fail(r);
    setStatus(fill(T.tagsRemoved, { n: r.changed || 0, t: tags.join(", ") }));
  }

  async function onMove() {
    const ids = selectedIds();
    if (!ids.length) return setStatus(T.noSelection);
    setStatus(T.working);
    const r = await api.moveToCollection(ids);
    renderList();
    if (r && r.ok) return setStatus(fill(T.moveDone, { n: r.changed || 0 }));
    if (r && r.reason === "no-collection") return setStatus(T.noCollection);
    fail(r);
  }

  async function onPrefix() {
    const ids = selectedIds();
    if (!ids.length) return setStatus(T.noSelection);
    const prefix = api.askPrefix();
    if (!prefix) return setStatus(T.cancelled);
    setStatus(T.working);
    const r = await api.prefixTitles(ids, prefix);
    renderList();
    if (!r || !r.ok) return fail(r);
    setStatus(fill(T.prefixDone, { n: r.changed || 0 }));
  }

  async function onMerge() {
    const ids = selectedIds();
    if (!ids.length) return setStatus(T.noSelection);
    setStatus(T.working);
    const r = await api.merge(ids);
    renderList();
    if (!r || !r.ok) return fail(r);
    setStatus(fill(T.mergeDone, { n: r.count || ids.length }));
  }

  function init() {
    if (!api) { setStatus(T.noApi); return; }
    // 事件在 DOM 就绪后才绑：XUL 窗口里内联脚本执行时元素尚未全部构造
    $("pp-nt-refresh").addEventListener("click", () => { onRefresh(); });
    $("pp-nt-remove-outline").addEventListener("click", () => { onRemoveOutline(); });
    $("pp-nt-add-tag").addEventListener("click", () => { onAddTags(); });
    $("pp-nt-remove-tag").addEventListener("click", () => { onRemoveTags(); });
    $("pp-nt-move").addEventListener("click", () => { onMove(); });
    $("pp-nt-prefix").addEventListener("click", () => { onPrefix(); });
    $("pp-nt-merge").addEventListener("click", () => { onMerge(); });
    $("pp-nt-all").addEventListener("click", () => { setAll(true); });
    $("pp-nt-none").addEventListener("click", () => { setAll(false); });
    $("pp-nt-close").addEventListener("click", () => window.close());
    renderList();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });
})();
