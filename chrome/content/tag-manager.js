// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 标签管理器（窗口脚本，0.70.0）
 *
 * 宿主注入 window.arguments[0]：
 *   { TagOps, isZh, libraryID, libraryName, onChanged }
 * 窗口拿不到插件作用域的 var（tag-ops.js 在 bootstrap 沙箱里），所有数据访问必须走 io.TagOps。
 *
 * ⚠️ 时序：XUL 窗口的 <script src> 可能在 DOM 解析完成前执行（tag-preview/compare 真机教训），
 * 直接 getElementById 会拿到 null，窗口只剩空壳。必须等 DOMContentLoaded（或 readyState 已过 loading）。
 *
 * ⚠️ 破坏性操作一律「先预览 → 再确认 → 执行前快照」，不提供一键直删。
 */
/* global window, document */

(function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const io = (window.arguments && window.arguments[0]) || null;

  if (!io || !io.TagOps) {
    try { window.close(); } catch (e) { /* ignore */ }
    return;
  }

  const T = io.TagOps;
  const zh = io.isZh !== false;
  const S = {
    view: "batch",
    data: null,
    loading: false,
    libID: io.libraryID || 0,
    query: { q: "", min: null, max: null, type: "any", depth: "any", protect: "any", regex: "" },
    sortKey: "count",
    sortDir: "desc",
    selected: new Set(),
    preview: null,        // {kind, changes, invalid, unchanged, items, note}
    busy: false,
    limit: 800,
    cooc: null,
    snapshots: null,
    protectText: "",
  };

  const COLORS = ["#ff6666", "#ff8c40", "#bfbf40", "#59bf40", "#40bfa6", "#408cff", "#7f40ff", "#bf40bf", "#ff40bf"];
  const VIEWS = [
    { id: "batch", zh: "批量编辑", en: "Batch" },
    { id: "health", zh: "体检报告", en: "Health" },
    { id: "snapshot", zh: "快照与撤销", en: "Snapshots" },
    { id: "system", zh: "体系与导入导出", en: "System" },
  ];

  /* ==================== DOM 助手 ==================== */

  const $ = (id) => document.getElementById(id);
  const tr = (z, e) => (zh ? z : e);

  function h(tag, attrs, text) {
    const el = document.createElementNS(XHTML, tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === undefined || v === null) continue;
        if (k === "style") el.style.cssText = v;
        else if (k === "text") el.textContent = v;
        else if (k === "class") el.className = v;
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
    }
    if (text != null) el.textContent = text;
    return el;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function btn(label, onClick, opts) {
    const o = opts || {};
    const b = h("button", {
      style: "padding:3px 10px;font-size:12px;border-radius:5px;border:1px solid " +
        (o.primary ? "#2f7d5f" : "var(--fill-tertiary,#c9c9c9)") + ";" +
        "background:" + (o.primary ? "#2f7d5f" : o.danger ? "#c0392b" : "var(--material-surface,#f6f6f6)") + ";" +
        "color:" + (o.primary || o.danger ? "#fff" : "var(--fill-primary,#1a1a1a)") + ";cursor:pointer;" +
        (o.disabled ? "opacity:.45;cursor:default;" : ""),
    }, label);
    if (o.disabled) b.disabled = true;
    if (onClick) b.addEventListener("click", (ev) => { ev.preventDefault(); onClick(ev); });
    return b;
  }

  function status(msg, kind) {
    const el = $("pp-tm-status");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = kind === "err" ? "#c0392b" : kind === "ok" ? "#2f7d5f" : "var(--fill-secondary,#6b6b6b)";
  }

  function progress(pct, text, show) {
    const el = $("pp-tm-progress");
    if (!el) return;
    el.style.display = show === false ? "none" : "";
    el.value = Math.max(0, Math.min(100, pct || 0));
    if (text) status(text);
  }

  function section(title, body) {
    const box = h("div", { style: "border:1px solid var(--fill-tertiary,#dcdcdc);border-radius:7px;padding:9px 11px;margin-bottom:9px;" });
    box.appendChild(h("div", { style: "font-weight:600;font-size:12.5px;margin-bottom:6px;" }, title));
    box.appendChild(body);
    return box;
  }

  function labelLine(text, control) {
    const row = h("div", { style: "display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap;" });
    row.appendChild(h("span", { style: "color:var(--fill-secondary,#6b6b6b);min-width:76px;font-size:11.5px;" }, text));
    row.appendChild(control);
    return row;
  }

  const INPUT_STYLE = "padding:3px 7px;font-size:12px;border:1px solid var(--fill-tertiary,#c9c9c9);border-radius:5px;" +
    "background:var(--material-surface,#fff);color:var(--fill-primary,#1a1a1a);";

  function input(attrs) {
    return h("input", Object.assign({ style: INPUT_STYLE }, attrs || {}));
  }

  function sel(options, value, onChange) {
    const s = h("select", {
      style: "padding:3px 6px;font-size:12px;border:1px solid var(--fill-tertiary,#c9c9c9);border-radius:5px;" +
        "background:var(--material-surface,#fff);color:var(--fill-primary,#1a1a1a);",
    });
    for (const o of options) {
      const op = h("option", { value: o.v }, o.t);
      // 真机上 setAttribute('selected') 不一定压过「第一项默认选中」，属性与 property 都设
      if (String(o.v) === String(value)) {
        op.setAttribute("selected", "selected");
        op.selected = true;
      }
      s.appendChild(op);
    }
    if (onChange) s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  /* ==================== 数据 ==================== */

  async function load(force) {
    // ★ 不能用 `if (S.busy) return` 一刀切：doDelete / doRenamePlan / undo 都是在
    //   busy=true 的同一调用栈里回头 `load(true)` 刷新列表，一刀切会让
    //   「删完了但列表还是旧的」—— 迷你 DOM 测试的 E6 抓到的就是这个。
    if (S.busy && !force) return;
    S.loading = true;
    status(tr("正在扫描标签…", "Scanning tags…"));
    try {
      const data = await T.collect(S.libID, {
        force: !!force,
        onProgress: (done, total) => {
          if (total) progress(Math.round(done / total * 100), tr("扫描 " + done + "/" + total, "Scanning " + done + "/" + total));
        },
      });
      S.data = data;
      S.libID = data.libraryID;
      // 选中项里已经被删掉的清出去
      const exist = new Set(data.tags.map((t) => t.name));
      for (const n of [...S.selected]) if (!exist.has(n)) S.selected.delete(n);
      S.preview = null;
      renderAll();
      progress(0, "", false);
      status(tr("共 " + data.tags.length + " 种标签 · 扫描 " + data.items + " 篇条目",
        data.tags.length + " tags in " + data.items + " items"), "ok");
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      status(tr("扫描失败：" + (e && e.message || e), "Scan failed: " + (e && e.message || e)), "err");
    } finally {
      S.loading = false;
    }
  }

  function allTags() { return (S.data && S.data.tags) || []; }

  function filterObj() {
    const q = S.query;
    const f = {};
    if (q.q) f.q = q.q;
    if (q.min != null && q.min !== "") f.min = Number(q.min);
    if (q.max != null && q.max !== "") f.max = Number(q.max);
    if (q.type !== "any") f.type = q.type;
    if (q.protect !== "any") f.protect = q.protect;
    if (q.regex) f.regex = q.regex;
    if (q.depth === "nested") f.depthMin = 2;
    if (q.depth === "flat") f.depthMax = 1;
    return f;
  }

  function visibleTags() {
    const list = T.filterTags(allTags(), filterObj());
    return T.sortBy(list, S.sortKey, S.sortDir);
  }

  function selectedNames() {
    return allTags().filter((t) => S.selected.has(t.name)).map((t) => t.name);
  }

  function selectedTags() {
    return allTags().filter((t) => S.selected.has(t.name));
  }

  /* ==================== 渲染 ==================== */

  function renderAll() {
    renderViews();
    renderFilters();
    renderList();
    renderSelectBar();
    renderPanel();
    renderSummary();
  }

  function renderSummary() {
    const el = $("pp-tm-summary");
    const lib = $("pp-tm-lib");
    if (lib) lib.textContent = io.libraryName ? "· " + io.libraryName : "";
    if (!el) return;
    if (!S.data) { el.textContent = ""; return; }
    const st = S.data.stats;
    el.textContent = tr(
      st.unique + " 种 / 累计 " + st.total + " 次" + (st.protectedCount ? " · 受保护 " + st.protectedCount : ""),
      st.unique + " tags / " + st.total + " uses");
  }

  function renderViews() {
    const box = clear($("pp-tm-views"));
    if (!box) return;
    for (const v of VIEWS) {
      const on = S.view === v.id;
      const b = h("button", {
        style: "padding:4px 12px;font-size:12px;border-radius:14px;cursor:pointer;border:1px solid " +
          (on ? "#2f7d5f" : "var(--fill-tertiary,#c9c9c9)") + ";background:" +
          (on ? "#2f7d5f" : "transparent") + ";color:" + (on ? "#fff" : "var(--fill-primary,#1a1a1a)") + ";",
      }, tr(v.zh, v.en));
      b.addEventListener("click", () => {
        S.view = v.id;
        S.preview = null;
        renderAll();
        if (v.id === "snapshot") loadSnapshots();
        if (v.id === "system") renderSystem();
      });
      box.appendChild(b);
    }
  }

  function renderFilters() {
    const box = clear($("pp-tm-filters"));
    if (!box) return;
    const q = input({ type: "search", placeholder: tr("搜索标签（含层级路径）", "Search tags"), style: INPUT_STYLE + "flex:1;min-width:140px;" });
    q.value = S.query.q || "";
    q.addEventListener("input", () => { S.query.q = q.value; renderList(); renderSelectBar(); });
    box.appendChild(q);

    const min = input({ type: "number", min: "0", placeholder: tr("最少", "min"), style: "width:64px;padding:3px 6px;font-size:12px;border:1px solid var(--fill-tertiary,#c9c9c9);border-radius:5px;" });
    min.value = S.query.min == null ? "" : S.query.min;
    min.addEventListener("input", () => { S.query.min = min.value; renderList(); });
    box.appendChild(min);

    const max = input({ type: "number", min: "0", placeholder: tr("最多", "max"), style: "width:64px;padding:3px 6px;font-size:12px;border:1px solid var(--fill-tertiary,#c9c9c9);border-radius:5px;" });
    max.value = S.query.max == null ? "" : S.query.max;
    max.addEventListener("input", () => { S.query.max = max.value; renderList(); });
    box.appendChild(max);

    box.appendChild(sel([
      { v: "any", t: tr("类型：全部", "Type: all") },
      { v: "manual", t: tr("手动", "Manual") },
      { v: "auto", t: tr("自动", "Automatic") },
      { v: "onlyManual", t: tr("仅手动", "Manual only") },
      { v: "onlyAuto", t: tr("仅自动", "Auto only") },
    ], S.query.type, (v) => { S.query.type = v; renderList(); }));

    box.appendChild(sel([
      { v: "any", t: tr("层级：全部", "Depth: all") },
      { v: "nested", t: tr("多层", "Nested") },
      { v: "flat", t: tr("单层", "Flat") },
    ], S.query.depth, (v) => { S.query.depth = v; renderList(); }));

    box.appendChild(sel([
      { v: "any", t: tr("保护：全部", "Guard: all") },
      { v: "unprotected", t: tr("未保护", "Unprotected") },
      { v: "protected", t: tr("已保护", "Protected") },
    ], S.query.protect, (v) => { S.query.protect = v; renderList(); }));

    const re = input({ type: "search", placeholder: tr("正则", "Regex"), style: "width:104px;padding:3px 6px;font-size:12px;border:1px solid var(--fill-tertiary,#c9c9c9);border-radius:5px;" });
    re.value = S.query.regex || "";
    re.addEventListener("input", () => {
      S.query.regex = re.value;
      re.style.borderColor = T.isValidRegex(re.value) ? "var(--fill-tertiary,#c9c9c9)" : "#c0392b";
      renderList();
    });
    box.appendChild(re);

    const sort = sel([
      { v: "count:desc", t: tr("按使用数 ↓", "Uses ↓") },
      { v: "count:asc", t: tr("按使用数 ↑", "Uses ↑") },
      { v: "name:asc", t: tr("按名称 ↑", "Name ↑") },
      { v: "name:desc", t: tr("按名称 ↓", "Name ↓") },
      { v: "depth:desc", t: tr("按层级 ↓", "Depth ↓") },
    ], S.sortKey + ":" + S.sortDir, (v) => {
      const [k, d] = v.split(":");
      S.sortKey = k; S.sortDir = d; renderList();
    });
    box.appendChild(sort);
  }

  function renderList() {
    const box = clear($("pp-tm-list"));
    if (!box) return;
    if (!S.data) {
      box.appendChild(h("div", { style: "padding:16px;color:var(--fill-secondary,#6b6b6b);" }, tr("正在扫描…", "Scanning…")));
      return;
    }
    const list = visibleTags();
    const shown = list.slice(0, S.limit);

    // 表头（全选作用于**当前筛选结果**，不是全库 —— 这点必须写清楚）
    const head = h("div", {
      style: "display:flex;align-items:center;gap:6px;padding:6px 8px;position:sticky;top:0;z-index:2;" +
        "background:var(--material-surface,#fff);border-bottom:1px solid var(--fill-tertiary,#dcdcdc);font-size:11.5px;color:var(--fill-secondary,#6b6b6b);",
    });
    const cbAll = h("input", { type: "checkbox", style: "margin:0;" });
    const allSelected = list.length > 0 && list.every((t) => S.selected.has(t.name));
    cbAll.checked = allSelected;
    cbAll.addEventListener("change", () => {
      if (cbAll.checked) for (const t of list) S.selected.add(t.name);
      else for (const t of list) S.selected.delete(t.name);
      renderList(); renderSelectBar(); renderPanel();
    });
    head.appendChild(cbAll);
    const labelAll = h("span", { style: "cursor:pointer;" }, tr("全选筛选结果（" + list.length + "）", "Select all (" + list.length + ")"));
    labelAll.addEventListener("click", () => { cbAll.checked = !cbAll.checked; cbAll.dispatchEvent(new window.Event("change")); });
    head.appendChild(labelAll);
    box.appendChild(head);

    if (!shown.length) {
      box.appendChild(h("div", { style: "padding:18px;color:var(--fill-secondary,#6b6b6b);" },
        tr("没有匹配的标签", "No matching tags")));
      return;
    }

    for (const t of shown) {
      const row = h("div", {
        style: "display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--fill-tertiary,#f0f0f0);" +
          (S.selected.has(t.name) ? "background:#2f7d5f14;" : ""),
      });
      const cb = h("input", { type: "checkbox", style: "margin:0;flex:none;" });
      cb.checked = S.selected.has(t.name);
      cb.addEventListener("change", () => {
        if (cb.checked) S.selected.add(t.name); else S.selected.delete(t.name);
        row.style.background = cb.checked ? "#2f7d5f14" : "";
        renderSelectBar(); renderPanel();
      });
      row.appendChild(cb);

      if (t.color) {
        row.appendChild(h("span", { style: "width:8px;height:8px;border-radius:50%;flex:none;background:" + t.color + ";" }));
      }

      const name = h("span", {
        style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
          (T.depth(t.name) > 1 ? "font-weight:500;" : ""),
        title: t.name,
      }, t.name);
      row.appendChild(name);

      if (t.protected) row.appendChild(h("span", { style: "flex:none;font-size:10px;color:#2f7d5f;" }, tr("保护", "guard")));
      if (t.auto > 0 && t.manual === 0) row.appendChild(h("span", { style: "flex:none;font-size:10px;color:#8a6d3b;" }, tr("自动", "auto")));

      row.appendChild(h("span", {
        style: "flex:none;font-size:11.5px;color:var(--fill-secondary,#6b6b6b);min-width:34px;text-align:right;",
      }, String(t.count || 0)));

      row.addEventListener("click", (ev) => {
        if (ev.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new window.Event("change"));
      });
      box.appendChild(row);
    }

    if (list.length > shown.length) {
      const more = h("div", { style: "padding:10px;text-align:center;color:var(--fill-secondary,#6b6b6b);font-size:11.5px;" });
      more.appendChild(h("span", null, tr(
        "另有 " + (list.length - shown.length) + " 个未显示（缩小筛选范围可提高精度）",
        (list.length - shown.length) + " more hidden — narrow the filter")));
      box.appendChild(more);
    }
  }

  function renderSelectBar() {
    const box = clear($("pp-tm-selectbar"));
    if (!box) return;
    const n = S.selected.size;
    box.appendChild(h("span", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);" },
      tr("已选 " + n + " / 共 " + allTags().length, n + " selected")));
    box.appendChild(btn(tr("反选", "Invert"), () => {
      const list = visibleTags();
      for (const t of list) {
        if (S.selected.has(t.name)) S.selected.delete(t.name); else S.selected.add(t.name);
      }
      renderList(); renderSelectBar(); renderPanel();
    }));
    box.appendChild(btn(tr("清空选择", "Clear"), () => {
      S.selected.clear();
      renderList(); renderSelectBar(); renderPanel();
    }));
    box.appendChild(btn(tr("选受保护", "Select guarded"), () => {
      for (const t of allTags()) if (t.protected) S.selected.add(t.name);
      renderList(); renderSelectBar(); renderPanel();
    }));
  }

  /* ==================== 右侧操作台 ==================== */

  function renderPanel() {
    const box = $("pp-tm-panel");
    if (!box) return;
    clear(box);
    if (S.view === "batch") renderBatchPanel(box);
    else if (S.view === "health") renderHealthPanel(box);
    else if (S.view === "snapshot") renderSnapshotPanel(box);
    else renderSystemPanel(box);
  }

  /* ---------- 批量编辑 ---------- */

  function renderBatchPanel(box) {
    const names = selectedNames();
    const tags = selectedTags();
    const protectedSel = tags.filter((t) => t.protected).map((t) => t.name);
    const count = tags.reduce((n, t) => n + (t.count || 0), 0);

    box.appendChild(h("div", { style: "font-size:13px;font-weight:600;margin-bottom:2px;" },
      tr("已选 " + names.length + " 个标签", names.length + " tags selected")));
    box.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:9px;" },
      names.length
        ? tr("累计使用 " + count + " 次" + (protectedSel.length ? " · 其中 " + protectedSel.length + " 个受保护（默认跳过）" : ""),
          count + " uses" + (protectedSel.length ? " · " + protectedSel.length + " guarded (skipped)" : ""))
        : tr("在左侧勾选标签，或用筛选条件全选后操作", "Select tags on the left first")));

    if (S.preview) {
      renderPreview(box);
      return;
    }

    /* --- 删除 --- */
    box.appendChild(section(tr("删除", "Delete"), (() => {
      const w = h("div");
      w.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:6px;" },
        tr("从所有条目上移除这些标签。执行前自动生成快照，可在「快照与撤销」回滚。",
          "Removes these tags from all items. A snapshot is taken before running.")));
      const row = h("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;" });
      const cbInc = h("input", { type: "checkbox", style: "margin:0;" });
      row.appendChild(cbInc);
      row.appendChild(h("span", { style: "font-size:11.5px;" }, tr("包含受保护标签", "include guarded")));
      row.appendChild(btn(tr("预览删除", "Preview delete"), async () => {
        const targets = names.filter((n) => cbInc.checked || !(tags.find((t) => t.name === n) || {}).protected);
        if (!targets.length) { status(tr("没有可删除的标签（都可能受保护）", "Nothing to delete (all guarded)"), "err"); return; }
        await previewDelete(targets, names.length - targets.length);
      }, { danger: true, disabled: !names.length }));
      w.appendChild(row);
      return w;
    })()));

    /* --- 重命名 / 查找替换 --- */
    box.appendChild(section(tr("重命名 / 查找替换", "Rename / replace"), (() => {
      const w = h("div");
      const fFind = input({ type: "text", placeholder: tr("查找（留空=只加前后缀）", "Find (empty = prefix/suffix only)"), style: "flex:1;min-width:120px;" });
      const fRep = input({ type: "text", placeholder: tr("替换为", "Replace with"), style: "flex:1;min-width:120px;" });
      w.appendChild(labelLine(tr("查找", "Find"), fFind));
      w.appendChild(labelLine(tr("替换", "Replace"), fRep));

      const fRe = h("input", { type: "checkbox", style: "margin:0;" });
      const fWhole = h("input", { type: "checkbox", style: "margin:0;" });
      const fCase = h("input", { type: "checkbox", style: "margin:0;" });
      const optsRow = h("div", { style: "display:flex;gap:12px;align-items:center;font-size:11.5px;margin:4px 0 6px 0;flex-wrap:wrap;" });
      const wrapOpt = (cb, text) => { const l = h("label", { style: "display:flex;align-items:center;gap:4px;cursor:pointer;" }); l.appendChild(cb); l.appendChild(h("span", null, text)); return l; };
      optsRow.appendChild(wrapOpt(fRe, tr("正则", "regex")));
      optsRow.appendChild(wrapOpt(fWhole, tr("整名匹配", "whole name")));
      optsRow.appendChild(wrapOpt(fCase, tr("区分大小写", "case")));
      w.appendChild(optsRow);

      const fPre = input({ type: "text", placeholder: tr("前缀", "prefix"), style: "width:96px;" });
      const fSuf = input({ type: "text", placeholder: tr("后缀", "suffix"), style: "width:96px;" });
      const fStrip = input({ type: "text", placeholder: tr("先剥掉前缀", "strip prefix"), style: "width:110px;" });
      const fCaseMode = sel([
        { v: "", t: tr("大小写不变", "keep case") },
        { v: "lower", t: tr("全小写", "lower") },
        { v: "upper", t: tr("全大写", "upper") },
        { v: "capitalize", t: tr("首字母大写", "Capitalize") },
      ], "");
      const tailRow = h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:2px;" });
      tailRow.appendChild(fPre); tailRow.appendChild(fSuf); tailRow.appendChild(fStrip); tailRow.appendChild(fCaseMode);
      w.appendChild(labelLine(tr("前后缀/归一", "Affix/normalize"), tailRow));

      const fTrim = h("input", { type: "checkbox", style: "margin:0;" }); fTrim.checked = true;
      const fHalf = h("input", { type: "checkbox", style: "margin:0;" }); fHalf.checked = true;
      const nRow = h("div", { style: "display:flex;gap:12px;align-items:center;font-size:11.5px;margin-bottom:7px;" });
      nRow.appendChild(wrapOpt(fTrim, tr("去尾随标点", "trim punctuation")));
      nRow.appendChild(wrapOpt(fHalf, tr("全角转半角", "half-width")));
      w.appendChild(nRow);

      w.appendChild(btn(tr("预览改名", "Preview rename"), () => {
        const rules = {
          find: fFind.value, replace: fRep.value,
          regex: fRe.checked, wholeName: fWhole.checked, caseSensitive: fCase.checked,
          prefix: fPre.value, suffix: fSuf.value, prefixStrip: fStrip.value,
          caseMode: fCaseMode.value, trimPunct: fTrim.checked, halfWidth: fHalf.checked,
        };
        const plan = T.planRename(allTags(), rules, { only: names, zh });
        S.preview = { kind: "rename", plan, rules };
        renderPanel();
      }, { primary: true, disabled: !names.length }));
      return w;
    })()));

    /* --- 合并 --- */
    box.appendChild(section(tr("合并到已有标签", "Merge into existing tag"), (() => {
      const w = h("div");
      const fTarget = input({ type: "search", placeholder: tr("输入目标标签名（需已存在）", "Target tag (must exist)"), style: "flex:1;min-width:180px;" });
      const hint = h("div", { style: "font-size:11px;color:var(--fill-secondary,#6b6b6b);margin-top:4px;min-height:15px;" });
      fTarget.addEventListener("input", () => {
        const q = fTarget.value.trim().toLowerCase();
        clear(hint);
        if (!q) return;
        const hits = allTags().filter((t) => t.name.toLowerCase().includes(q)).slice(0, 6);
        for (const t of hits) {
          const chip = h("span", {
            style: "display:inline-block;margin:2px 4px 0 0;padding:1px 7px;border-radius:9px;cursor:pointer;" +
              "background:#2f7d5f18;color:#2f7d5f;font-size:11px;",
          }, t.name);
          chip.addEventListener("click", () => { fTarget.value = t.name; clear(hint); });
          hint.appendChild(chip);
        }
      });
      w.appendChild(labelLine(tr("目标", "Target"), fTarget));
      w.appendChild(hint);
      w.appendChild(btn(tr("预览合并", "Preview merge"), () => {
        const plan = T.planMerge(allTags(), fTarget.value, { zh });
        if (!plan.changes.length) {
          status((plan.invalid[0] && plan.invalid[0].reason) || tr("没有可合并的标签", "Nothing to merge"), "err");
          return;
        }
        S.preview = { kind: "merge", plan };
        renderPanel();
      }, { primary: true, disabled: !names.length }));
      return w;
    })()));

    /* --- 层级 --- */
    box.appendChild(section(tr("层级整理", "Hierarchy"), (() => {
      const w = h("div");
      const fParent = input({ type: "text", placeholder: tr("父级，如 主题/方法", "Parent, e.g. Topic/Method"), style: "width:150px;" });
      const fOld = input({ type: "text", placeholder: tr("旧父级", "Old parent"), style: "width:100px;" });
      const fNew = input({ type: "text", placeholder: tr("新父级", "New parent"), style: "width:100px;" });
      const fStrip = input({ type: "text", placeholder: tr("剥掉前缀", "strip prefix"), style: "width:100px;" });
      w.appendChild(labelLine(tr("加父级", "Add parent"), (() => {
        const r = h("div", { style: "display:flex;gap:6px;align-items:center;" });
        r.appendChild(fParent);
        r.appendChild(btn(tr("预览", "Preview"), () => {
          const plan = T.planAddParent(allTags(), fParent.value, { only: names, zh });
          if (!plan.changes.length) { status(tr("没有需要加父级的标签", "Nothing to change"), "err"); return; }
          S.preview = { kind: "parent", plan };
          renderPanel();
        }, { disabled: !names.length }));
        return r;
      })()));
      w.appendChild(labelLine(tr("换父级", "Reparent"), (() => {
        const r = h("div", { style: "display:flex;gap:6px;align-items:center;" });
        r.appendChild(fOld); r.appendChild(h("span", { style: "font-size:11px;" }, "→")); r.appendChild(fNew);
        r.appendChild(btn(tr("预览", "Preview"), () => {
          const plan = T.planReparent(allTags(), fOld.value, fNew.value, { only: names, zh });
          if (!plan.changes.length) { status(tr("没有匹配的标签", "Nothing to change"), "err"); return; }
          S.preview = { kind: "reparent", plan };
          renderPanel();
        }, { disabled: !names.length }));
        return r;
      })()));
      w.appendChild(labelLine(tr("剥前缀", "Strip prefix"), (() => {
        const r = h("div", { style: "display:flex;gap:6px;align-items:center;" });
        r.appendChild(fStrip);
        r.appendChild(btn(tr("预览", "Preview"), () => {
          const plan = T.planStripPrefix(allTags(), fStrip.value, { only: names, zh });
          if (!plan.changes.length) { status(tr("没有匹配的标签", "Nothing to change"), "err"); return; }
          S.preview = { kind: "strip", plan };
          renderPanel();
        }, { disabled: !names.length }));
        return r;
      })()));
      return w;
    })()));

    /* --- 颜色 --- */
    box.appendChild(section(tr("颜色", "Color"), (() => {
      const w = h("div", { style: "display:flex;gap:5px;align-items:center;flex-wrap:wrap;" });
      for (const c of COLORS) {
        const sw = h("span", {
          style: "width:18px;height:18px;border-radius:50%;cursor:pointer;border:2px solid transparent;background:" + c + ";",
          title: c,
        });
        sw.addEventListener("click", () => { previewColor(names, c); });
        w.appendChild(sw);
      }
      w.appendChild(btn(tr("清除颜色", "No color"), () => previewColor(names, "")));
      return w;
    })()));

    /* --- 保护 --- */
    box.appendChild(section(tr("保护名单", "Guard list"), (() => {
      const w = h("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;" });
      w.appendChild(h("span", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);flex:1;" },
        tr("受保护标签不会被批量删除（仅预览删除时可手动包含）", "Guarded tags are skipped by batch delete")));
      w.appendChild(btn(tr("加入保护", "Guard"), () => {
        const list = T.protectList();
        T.setProtectList(list.concat(names));
        load(true);
        status(tr("已加入保护：" + names.length + " 个", names.length + " guarded"), "ok");
      }, { disabled: !names.length }));
      w.appendChild(btn(tr("移出保护", "Unguard"), () => {
        const keep = T.protectList().filter((p) => !names.includes(p));
        T.setProtectList(keep);
        load(true);
        status(tr("已移出保护：" + names.length + " 个", names.length + " unguarded"), "ok");
      }, { disabled: !names.length }));
      return w;
    })()));
  }

  /* ---------- 预览 ---------- */

  function renderPreview(box) {
    const p = S.preview;
    const wrap = h("div");
    const head = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px;" });
    head.appendChild(h("span", { style: "font-weight:600;font-size:12.5px;color:#2f7d5f;" },
      tr("预览：确认后才会改动数据", "Preview — nothing changed yet")));
    head.appendChild(h("spacer"));
    head.appendChild(btn(tr("返回", "Back"), () => { S.preview = null; renderPanel(); }));
    wrap.appendChild(head);

    if (p.kind === "delete") {
      wrap.appendChild(h("div", { style: "font-size:12px;margin-bottom:6px;" },
        tr("将删除 " + p.names.length + " 个标签，影响 " + p.items.total + " 篇条目" +
          (p.skipped ? "（已跳过 " + p.skipped + " 个受保护标签）" : ""),
          "Delete " + p.names.length + " tags, " + p.items.total + " items affected" +
          (p.skipped ? " (" + p.skipped + " guarded skipped)" : ""))));
      const listBox = h("div", { style: "max-height:150px;overflow-y:auto;border:1px solid var(--fill-tertiary,#e3e3e3);border-radius:5px;padding:5px 8px;margin-bottom:8px;font-size:11.5px;" });
      for (const t of p.names.slice(0, 200)) {
        const row = h("div", { style: "display:flex;gap:6px;" });
        row.appendChild(h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" }, t));
        row.appendChild(h("span", { style: "flex:none;color:var(--fill-secondary,#6b6b6b);" }, String(p.items.byTag[t] || 0)));
        listBox.appendChild(row);
      }
      wrap.appendChild(listBox);
      if (p.items.items.length) {
        wrap.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:4px;" },
          tr("受影响条目（抽样）", "Affected items (sample)")));
        const ib = h("div", { style: "max-height:150px;overflow-y:auto;border:1px solid var(--fill-tertiary,#e3e3e3);border-radius:5px;padding:5px 8px;margin-bottom:8px;font-size:11.5px;" });
        for (const it of p.items.items.slice(0, 40)) {
          ib.appendChild(h("div", { style: "padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", title: it.title }, it.title || ("#" + it.id)));
        }
        wrap.appendChild(ib);
        if (p.items.truncated) wrap.appendChild(h("div", { style: "font-size:11px;color:var(--fill-secondary,#6b6b6b);margin-bottom:6px;" },
          tr("（仅显示前 40 条）", "(first 40 shown)")));
      }
      const row = h("div", { style: "display:flex;gap:6px;align-items:center;" });
      row.appendChild(btn(tr("确认删除", "Delete now"), () => doDelete(p), { danger: true }));
      row.appendChild(btn(tr("取消", "Cancel"), () => { S.preview = null; renderPanel(); }));
      wrap.appendChild(row);
      box.appendChild(wrap);
      return;
    }

    // 改名类预览（rename / merge / parent / reparent / strip）
    const plan = p.plan;
    wrap.appendChild(h("div", { style: "font-size:12px;margin-bottom:6px;" },
      tr("将改动 " + plan.changes.length + " 个标签" +
        (plan.unchanged ? "，跳过 " + plan.unchanged + " 个（无需改动或目标已存在）" : "") +
        (plan.invalid.length ? "，" + plan.invalid.length + " 个无效" : ""),
        plan.changes.length + " changes" +
        (plan.unchanged ? ", " + plan.unchanged + " skipped" : "") +
        (plan.invalid.length ? ", " + plan.invalid.length + " invalid" : ""))));

    const tb = h("div", { style: "max-height:210px;overflow-y:auto;border:1px solid var(--fill-tertiary,#e3e3e3);border-radius:5px;padding:5px 8px;margin-bottom:8px;font-size:11.5px;" });
    for (const c of plan.changes.slice(0, 300)) {
      const row = h("div", { style: "display:flex;gap:6px;align-items:center;padding:1px 0;" });
      row.appendChild(h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c0392b;", title: c.from }, c.from));
      row.appendChild(h("span", { style: "flex:none;color:var(--fill-secondary,#6b6b6b);" }, "→"));
      row.appendChild(h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2f7d5f;", title: c.to }, c.to));
      if (c.kind === "merge") row.appendChild(h("span", { style: "flex:none;font-size:10px;color:#8a6d3b;" }, tr("合并", "merge")));
      tb.appendChild(row);
    }
    wrap.appendChild(tb);

    if (plan.invalid.length) {
      wrap.appendChild(h("div", { style: "font-size:11.5px;color:#c0392b;margin-bottom:4px;" },
        tr("无法处理（" + plan.invalid.length + "）", "Invalid (" + plan.invalid.length + ")")));
      const ib = h("div", { style: "max-height:96px;overflow-y:auto;border:1px solid #c0392b55;border-radius:5px;padding:5px 8px;margin-bottom:8px;font-size:11px;color:#c0392b;" });
      for (const c of plan.invalid.slice(0, 60)) {
        ib.appendChild(h("div", { style: "padding:1px 0;" }, (c.from ? c.from + " → " : "") + (c.to || "") + "  (" + c.reason + ")"));
      }
      wrap.appendChild(ib);
    }

    const row = h("div", { style: "display:flex;gap:6px;align-items:center;" });
    row.appendChild(btn(tr("确认执行", "Apply"), () => doRenamePlan(p), { primary: true, disabled: !plan.changes.length }));
    row.appendChild(btn(tr("取消", "Cancel"), () => { S.preview = null; renderPanel(); }));
    wrap.appendChild(row);
    box.appendChild(wrap);
  }

  /* ==================== 执行 ==================== */

  async function previewDelete(names, skipped) {
    try {
      S.busy = true;
      status(tr("正在统计受影响条目…", "Collecting affected items…"));
      const items = await T.itemsFor(S.libID, names, { limit: 200 });
      S.preview = { kind: "delete", names, items, skipped: skipped || 0 };
      renderPanel();
      status(tr("预览完成：" + items.total + " 篇条目受影响", items.total + " items affected"), "ok");
    } catch (e) {
      status(tr("预览失败：" + (e && e.message || e), "Preview failed"), "err");
    } finally {
      S.busy = false;
    }
  }

  async function doDelete(p) {
    if (S.busy) return;
    S.busy = true;
    try {
      progress(8, tr("正在生成快照…", "Snapshotting…"));
      await T.snapshot(S.libID, p.names, { op: "delete", note: "batch delete" });
      progress(20, tr("正在删除…", "Deleting…"));
      const r = await T.deleteTags(S.libID, p.names, (done, total) => {
        if (total) progress(20 + Math.round(done / total * 70), tr("删除 " + done + "/" + total, "Deleting " + done + "/" + total));
      });
      progress(100, tr("完成", "Done"));
      S.selected.clear();
      S.preview = null;
      await load(true);
      progress(0, "", false);
      status(tr("已删除 " + r.removed + " 个标签" + (r.missing.length ? "（" + r.missing.length + " 个已不存在）" : "") + " · 可在「快照与撤销」回滚",
        "Deleted " + r.removed + " tags · undo available"), "ok");
      if (io.onChanged) io.onChanged();
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      progress(0, "", false);
      status(tr("删除失败：" + (e && e.message || e), "Delete failed"), "err");
    } finally {
      S.busy = false;
    }
  }

  async function doRenamePlan(p) {
    if (S.busy || !p.plan.changes.length) return;
    S.busy = true;
    try {
      progress(8, tr("正在生成快照…", "Snapshotting…"));
      await T.snapshot(S.libID, p.plan.changes.map((c) => c.from), { op: "rename", changes: p.plan.changes });
      progress(20, tr("正在改名…", "Renaming…"));
      const r = await T.renameTags(S.libID, p.plan.changes, (done, total) => {
        if (total) progress(20 + Math.round(done / total * 70), tr("改名 " + done + "/" + total, "Renaming " + done + "/" + total));
      });
      S.preview = null;
      S.selected.clear();
      await load(true);
      progress(0, "", false);
      status(tr("已处理 " + r.done + " 个" + (r.failed.length ? "，失败 " + r.failed.length + " 个" : ""),
        r.done + " done" + (r.failed.length ? ", " + r.failed.length + " failed" : "")), r.failed.length ? "err" : "ok");
      if (io.onChanged) io.onChanged();
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      progress(0, "", false);
      status(tr("执行失败：" + (e && e.message || e), "Failed"), "err");
    } finally {
      S.busy = false;
    }
  }

  async function previewColor(names, color) {
    if (!names.length) { status(tr("先选标签", "Select tags first"), "err"); return; }
    S.preview = { kind: "color", names, color };
    // 颜色没有条目影响，直接用紧凑确认条
    const box = $("pp-tm-panel");
    clear(box);
    box.appendChild(h("div", { style: "font-weight:600;margin-bottom:6px;" },
      tr("给 " + names.length + " 个标签" + (color ? "设色 " : "清除颜色") , "Color " + names.length + " tags")));
    box.appendChild(h("div", { style: "display:flex;gap:6px;align-items:center;margin-bottom:10px;" },
      color ? h("span", { style: "width:20px;height:20px;border-radius:50%;background:" + color + ";" }) : h("span", null, tr("（无颜色）", "(none)"))));
    const row = h("div", { style: "display:flex;gap:6px;" });
    row.appendChild(btn(tr("确认", "Apply"), async () => {
      S.busy = true;
      try {
        await T.snapshot(S.libID, names, { op: "color" });
        const r = await T.applyColors(S.libID, names, color);
        S.preview = null;
        await load(true);
        status(tr("已设置 " + r.applied + " 个" + (r.noSlot ? "（彩色标签已满 9 个，超出部分复用了最后一个槽位）" : ""),
          "Colored " + r.applied), "ok");
        if (io.onChanged) io.onChanged();
      } catch (e) {
        status(tr("设置失败", "Failed"), "err");
      } finally { S.busy = false; }
    }, { primary: true }));
    row.appendChild(btn(tr("取消", "Cancel"), () => { S.preview = null; renderPanel(); }));
    box.appendChild(row);
  }

  /* ---------- 体检 ---------- */

  function variationGroups(tags) {
    const map = new Map();
    for (const t of tags) {
      if (T.depth(t.name) > 1) continue; // 层级标签各自独立，避免 `a/b` 与 `a-b` 被误判
      const k = T.shapeKey(t.name);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(t);
    }
    return [...map.values()].filter((g) => g.length > 1)
      .map((g) => g.sort((a, b) => (b.count || 0) - (a.count || 0)))
      .sort((a, b) => b.length - a.length);
  }

  function missingParents(tags) {
    const names = new Set(tags.map((t) => t.name));
    const missing = [];
    for (const t of tags) {
      const segs = T.splitPath(t.name);
      for (let i = 1; i < segs.length; i++) {
        const p = segs.slice(0, i).join("/");
        if (!names.has(p)) missing.push({ child: t.name, missing: p });
      }
    }
    return missing;
  }

  function renderHealthPanel(box) {
    if (!S.data) return;
    const tags = allTags();
    const st = S.data.stats;
    const groups = variationGroups(tags);
    const rare = tags.filter((t) => (t.count || 0) <= 1);
    const missing = missingParents(tags);
    const longTags = tags.filter((t) => t.name.length > 40);
    const deepTags = tags.filter((t) => T.depth(t.name) > 4);

    const cards = h("div", { style: "display:flex;gap:7px;flex-wrap:wrap;margin-bottom:9px;" });
    const card = (v, label) => {
      const c = h("div", { style: "flex:1;min-width:88px;border:1px solid var(--fill-tertiary,#e3e3e3);border-radius:7px;padding:7px 9px;" });
      c.appendChild(h("div", { style: "font-size:17px;font-weight:600;color:#2f7d5f;" }, String(v)));
      c.appendChild(h("div", { style: "font-size:11px;color:var(--fill-secondary,#6b6b6b);" }, label));
      return c;
    };
    cards.appendChild(card(st.unique, tr("标签总数", "Tags")));
    cards.appendChild(card(st.total, tr("累计使用", "Uses")));
    cards.appendChild(card(st.avg, tr("平均使用", "Avg")));
    cards.appendChild(card(rare.length, tr("仅用 1 次", "Used once")));
    cards.appendChild(card(groups.length, tr("变体组", "Variants")));
    cards.appendChild(card(missing.length, tr("缺父级", "No parent")));
    box.appendChild(cards);

    const block = (title, hint, list, pick) => {
      const w = h("div");
      w.appendChild(h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:4px;" }));
      const head = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:4px;" });
      head.appendChild(h("span", { style: "font-weight:600;font-size:12.5px;" }, title));
      head.appendChild(h("span", { style: "font-size:11px;color:#c0392b;" }, String(list.length)));
      head.appendChild(h("spacer"));
      if (list.length && pick) {
        head.appendChild(btn(tr("选中这些", "Select these"), () => {
          for (const n of pick(list)) S.selected.add(n);
          S.view = "batch";
          renderAll();
        }));
      }
      w.appendChild(head);
      w.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:5px;" }, hint));
      return section("", w);
    };

    // 变体组
    {
      const w = h("div");
      const head = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:5px;" });
      head.appendChild(h("span", { style: "font-weight:600;font-size:12.5px;" }, tr("写法变体（可归一）", "Spelling variants")));
      head.appendChild(h("span", { style: "font-size:11px;color:#c0392b;" }, String(groups.length)));
      head.appendChild(h("spacer"));
      if (groups.length) {
        head.appendChild(btn(tr("选中变体组", "Select variants"), () => {
          for (const g of groups) for (const t of g) S.selected.add(t.name);
          S.view = "batch"; renderAll();
        }));
      }
      w.appendChild(head);
      w.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:5px;" },
        tr("忽略大小写/全半角/空格/连字符后同名 —— 在「批量编辑」里用重命名或合并归到使用最多的写法",
          "Same after ignoring case/width/space/hyphen — merge them in Batch")));
      const lb = h("div", { style: "max-height:150px;overflow-y:auto;font-size:11.5px;" });
      for (const g of groups.slice(0, 40)) {
        lb.appendChild(h("div", { style: "padding:2px 0;" }, g.map((t) => t.name + "(" + (t.count || 0) + ")").join("  ·  ")));
      }
      w.appendChild(lb);
      box.appendChild(section("", w));
    }

    box.appendChild(block(tr("仅使用 1 次", "Used once"), tr("多为误输入或一次性标记，可勾选后批量删除", "Likely typos — select to delete"), rare, (l) => l.map((t) => t.name)));
    box.appendChild(block(tr("缺少父级标签", "Missing parent"), tr("存在 a/b 但没有 a 本身（不影响筛选，只影响层级树的可读性）", "a/b exists but a does not"), missing, (l) => l.map((x) => x.child)));
    box.appendChild(block(tr("超长标签（>40 字符）", "Long tags (>40 chars)"), tr("tag selector 里会被截断，建议缩短", "Truncated in the tag selector"), longTags, (l) => l.map((t) => t.name)));
    box.appendChild(block(tr("层级过深（>4 级）", "Deep nesting (>4)"), tr("层级越深越难维护，建议控制在 3 级内", "Aim for 3 levels"), deepTags, (l) => l.map((t) => t.name)));
  }

  /* ---------- 快照 ---------- */

  async function loadSnapshots() {
    try {
      S.snapshots = await T.listSnapshots();
    } catch (e) { S.snapshots = []; }
    renderPanel();
  }

  function renderSnapshotPanel(box) {
    if (!S.snapshots) {
      box.appendChild(h("div", { style: "color:var(--fill-secondary,#6b6b6b);" }, tr("正在读取快照…", "Loading…")));
      loadSnapshots();
      return;
    }
    box.appendChild(h("div", { style: "font-weight:600;font-size:12.5px;margin-bottom:3px;" }, tr("操作快照", "Snapshots")));
    box.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:8px;" },
      tr("每次删除/改名/改色前的现场。撤销只回滚标签关系，不会恢复已被删除的条目。",
        "State before each destructive run. Undo restores tag links only.")));

    if (!S.snapshots.length) {
      box.appendChild(h("div", { style: "padding:14px;color:var(--fill-secondary,#6b6b6b);" }, tr("还没有快照", "No snapshots yet")));
      return;
    }

    for (const s of S.snapshots) {
      const row = h("div", {
        style: "display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--fill-tertiary,#eee);" +
          (s.undoneAt ? "opacity:.55;" : ""),
      });
      const when = String(s.at || "").replace("T", " ").slice(0, 19);
      row.appendChild(h("span", { style: "flex:none;font-size:11.5px;color:var(--fill-secondary,#6b6b6b);" }, when));
      row.appendChild(h("span", { style: "flex:none;font-size:11.5px;" },
        (s.op === "delete" ? tr("删除", "delete") : s.op === "rename" ? tr("改名", "rename") : tr("改色", "color"))));
      row.appendChild(h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;", title: (s.names || []).join(", ") },
        tr((s.names || []).length + " 个标签：" , (s.names || []).length + " tags: ") + (s.names || []).slice(0, 4).join(", ") + ((s.names || []).length > 4 ? " …" : "")));
      if (s.undoneAt) {
        row.appendChild(h("span", { style: "flex:none;font-size:11px;color:var(--fill-secondary,#6b6b6b);" }, tr("已撤销", "undone")));
      } else {
        row.appendChild(btn(tr("撤销", "Undo"), () => undoSnapshot(s), { primary: true }));
      }
      box.appendChild(row);
    }

    box.appendChild(h("div", { style: "margin-top:10px;" }));
    box.appendChild(btn(tr("清空快照（保留最近 1 条）", "Clear (keep latest)"), async () => {
      await T.clearSnapshots();
      await loadSnapshots();
      status(tr("已清空", "Cleared"), "ok");
    }));
  }

  async function undoSnapshot(s) {
    if (S.busy) return;
    S.busy = true;
    try {
      progress(10, tr("正在撤销…", "Undoing…"));
      const r = await T.undo(s.id, (done) => progress(10 + Math.min(80, done), tr("恢复 " + done + " 条", "Restoring " + done)));
      progress(0, "", false);
      status(tr("已恢复 " + r.restored + " 处" + (r.skipped ? "，跳过 " + r.skipped + "（条目已不存在）" : ""),
        "Restored " + r.restored + (r.skipped ? ", " + r.skipped + " skipped" : "")), r.ok ? "ok" : "err");
      await loadSnapshots();
      await load(true);
      if (io.onChanged) io.onChanged();
    } catch (e) {
      status(tr("撤销失败：" + (e && e.message || e), "Undo failed"), "err");
    } finally {
      S.busy = false;
    }
  }

  /* ---------- 体系 / 导入导出 ---------- */

  function renderSystemPanel(box) {
    // 保护名单
    const w = h("div");
    if (!S.protectText) S.protectText = T.protectList().join("\n");
    const ta = h("textarea", {
      style: "width:100%;height:86px;box-sizing:border-box;font-size:12px;padding:6px 8px;border-radius:5px;" +
        "border:1px solid var(--fill-tertiary,#c9c9c9);background:var(--material-surface,#fff);color:var(--fill-primary,#1a1a1a);",
      placeholder: "#状态/*&#10;#治理/*&#10;tmp-*",
    });
    ta.value = S.protectText;
    ta.addEventListener("input", () => { S.protectText = ta.value; });
    w.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:5px;" },
      tr("每行一条，支持 * ? 通配。受保护标签在批量删除时默认跳过。留空则回到默认（#状态/*、#治理/*）。",
        "One per line, * and ? supported. Guarded tags are skipped by batch delete.")));
    w.appendChild(ta);
    const row = h("div", { style: "display:flex;gap:6px;margin-top:6px;" });
    row.appendChild(btn(tr("保存保护名单", "Save"), () => {
      T.setProtectList(S.protectText.split("\n"));
      S.protectText = T.protectList().join("\n");
      load(true);
      status(tr("保护名单已保存", "Guard list saved"), "ok");
    }, { primary: true }));
    row.appendChild(btn(tr("恢复默认", "Reset"), () => {
      T.setProtectList([]);
      S.protectText = T.protectList().join("\n");
      renderPanel();
    }));
    w.appendChild(row);
    box.appendChild(section(tr("保护名单", "Guard list"), w));

    // 导入导出
    const e = h("div");
    const ta2 = h("textarea", {
      style: "width:100%;height:120px;box-sizing:border-box;font-size:11.5px;font-family:monospace;padding:6px 8px;" +
        "border-radius:5px;border:1px solid var(--fill-tertiary,#c9c9c9);background:var(--material-surface,#fff);color:var(--fill-primary,#1a1a1a);",
    });
    ta2.value = T.toCSV(allTags());
    e.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:5px;" },
      tr("导出当前全库标签（名称/使用数/手动/自动/颜色/保护）。导入时按 name 列**选中**这些标签，不会直接改动数据。",
        "Export all tags as CSV. Import selects the listed names — it never modifies data directly.")));
    e.appendChild(ta2);
    const r2 = h("div", { style: "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;" });
    r2.appendChild(btn(tr("复制 CSV", "Copy CSV"), async () => {
      try {
        const s = ta2.value;
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(s);
        else {
          const tmp = h("textarea", { style: "position:fixed;left:-9999px;" });
          tmp.value = s; document.documentElement.appendChild(tmp); tmp.select();
          document.execCommand("copy"); tmp.remove();
        }
        status(tr("已复制到剪贴板", "Copied"), "ok");
      } catch (err) { status(tr("复制失败，请手动选择文本", "Copy failed — select manually"), "err"); }
    }));
    r2.appendChild(btn(tr("按 CSV 选中", "Select from CSV"), () => {
      const list = T.parseCSV(ta2.value);
      if (!list.length) { status(tr("没有解析到标签名", "No names parsed"), "err"); return; }
      const exist = new Set(allTags().map((t) => t.name));
      let hit = 0;
      let miss = 0;
      for (const it of list) {
        if (exist.has(it.name)) { S.selected.add(it.name); hit++; } else miss++;
      }
      S.view = "batch";
      renderAll();
      status(tr("已选中 " + hit + " 个" + (miss ? "，库中不存在 " + miss + " 个" : ""), "Selected " + hit), miss ? "err" : "ok");
    }));
    r2.appendChild(btn(tr("导入保护标记", "Import guards"), () => {
      const list = T.parseCSV(ta2.value).filter((x) => x.protected).map((x) => x.name);
      if (!list.length) { status(tr("CSV 里没有 protected=1 的行", "No protected rows"), "err"); return; }
      T.setProtectList(T.protectList().concat(list));
      S.protectText = T.protectList().join("\n");
      load(true);
      status(tr("已加入保护：" + list.length + " 个", list.length + " guarded"), "ok");
    }));
    e.appendChild(r2);
    box.appendChild(section(tr("导入 / 导出", "Import / Export"), e));

    // 共现建议
    const c = h("div");
    c.appendChild(h("div", { style: "font-size:11.5px;color:var(--fill-secondary,#6b6b6b);margin-bottom:6px;" },
      tr("统计常一起出现的标签对，用来发现「该建层级」或「其实是同义词」的组合。需要一次全库扫描（约数秒）。",
        "Tag pairs that co-occur — hints for hierarchy or synonyms. Runs a full scan.")));
    const cbox = h("div", { style: "font-size:11.5px;max-height:180px;overflow-y:auto;" });
    if (S.cooc && S.cooc.length) {
      for (const p of S.cooc.slice(0, 60)) {
        const line = h("div", { style: "padding:2px 0;display:flex;gap:6px;align-items:center;" });
        line.appendChild(h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", title: p.a + " + " + p.b }, p.a + "  +  " + p.b));
        line.appendChild(h("span", { style: "flex:none;color:#2f7d5f;" }, String(p.n)));
        line.appendChild(btn(tr("选中", "Select"), () => {
          S.selected.add(p.a); S.selected.add(p.b);
          S.view = "batch"; renderAll();
        }));
        cbox.appendChild(line);
      }
    } else {
      cbox.appendChild(h("div", { style: "color:var(--fill-secondary,#6b6b6b);" }, tr("尚未计算", "Not computed")));
    }
    c.appendChild(cbox);
    c.appendChild(btn(tr("计算共现", "Compute co-occurrence"), () => computeCooccurrence(), { primary: true }));
    box.appendChild(section(tr("共现建议", "Co-occurrence"), c));
  }

  async function computeCooccurrence() {
    if (S.busy) return;
    S.busy = true;
    status(tr("正在扫描条目标签…", "Scanning item tags…"));
    try {
      const byItem = [];
      const s = new io.Zotero.Search();
      s.libraryID = S.libID;
      s.addCondition("itemType", "isNot", "attachment");
      const ids = await s.search();
      let done = 0;
      for (const id of ids) {
        const item = await io.Zotero.Items.getAsync(id);
        if (!item || item.deleted) continue;
        const names = (item.getTags() || []).map((t) => t.tag).filter(Boolean);
        if (names.length > 1) byItem.push(names);
        done++;
        if (done % 50 === 0) progress(Math.round(done / ids.length * 100), tr("扫描 " + done + "/" + ids.length, "Scanning " + done));
      }
      S.cooc = T.cooccurrence(byItem, 3).slice(0, 200);
      progress(0, "", false);
      status(tr("共现计算完成：" + S.cooc.length + " 组", S.cooc.length + " pairs"), "ok");
      renderPanel();
    } catch (e) {
      status(tr("计算失败：" + (e && e.message || e), "Failed"), "err");
    } finally {
      S.busy = false;
    }
  }

  /* ==================== 启动 ==================== */

  function bindChrome() {
    const close = $("pp-tm-close");
    if (close) close.addEventListener("click", () => window.close());
    const refresh = $("pp-tm-refresh");
    if (refresh) refresh.addEventListener("click", () => { T.invalidate(S.libID); load(true); });
    const title = $("pp-tm-title");
    if (title) title.textContent = tr("标签管理", "Tag Manager");
  }

  function init() {
    bindChrome();
    renderViews();
    renderFilters();
    renderSelectBar();
    renderAll();
    load(false).then(() => {
      // 支持从右键菜单带一个起始标签（打开即在列表里定位并勾选）
      if (io.focusTag && S.data && S.data.tags.some((t) => t.name === io.focusTag)) {
        S.query.q = io.focusTag;
        S.selected.add(io.focusTag);
        renderAll();
      }
    });
  }

  // 暴露给宿主（单实例复用窗口时刷新数据）
  window.ppTagManagerLoad = function (payload) {
    if (!payload) return;
    if (payload.libraryID) S.libID = payload.libraryID;
    if (payload.focusTag) io.focusTag = payload.focusTag;
    T.invalidate(S.libID);
    init();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
