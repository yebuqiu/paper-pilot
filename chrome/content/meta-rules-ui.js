// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 元数据体检对话框（0.24.0）
 * 与标签治理同纪律：**先出问题清单 → 用户勾选 → 才写库**。
 * 数据通道与 hub/workbench 一致：Zotero 经 window.arguments 传入，
 * 功能调用一律走 Zotero.Papilot.metaRules。
 */
/* global window, document */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero);
  const PP = Z && Z.Papilot;
  const zh = !!(Z && (Z.locale || "").toLowerCase().startsWith("zh"));
  const PREFIX = "extensions.zotero.papilot.";

  const $ = (id) => document.getElementById(id);
  const listEl = $("pp-mr-list");
  const statusEl = $("pp-mr-status");
  const sumEl = $("pp-mr-sum");

  if (!PP || !PP.metaRules) {
    if (statusEl) statusEl.textContent = zh ? "错误：无法访问 Papilot 模块" : "Error: Papilot unavailable";
    return;
  }
  const MR = PP.metaRules;

  const pget = (k, d) => {
    try { const v = Z.Prefs.get(PREFIX + k, true); return v === undefined || v === null ? d : v; } catch (e) { return d; }
  };
  const pset = (k, v) => { try { Z.Prefs.set(PREFIX + k, v, true); } catch (e) { /* ignore */ } };

  let scan = null;
  let entries = [];             // {row, hit, item, title, cb?}
  const selected = new Set();   // entries 下标
  let running = false;

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function setStatus(t, err) {
    statusEl.textContent = t || "";
    statusEl.style.color = err ? "var(--accent-red,#c0392b)" : "var(--fill-secondary,#666)";
  }

  function ask(msg) {
    try { return Z.getMainWindow().confirm(msg); } catch (e) {
      try { return window.confirm(msg); } catch (e2) { return true; }
    }
  }

  function updateSum() {
    const fix = entries.filter((e) => e.hit.kind === "fix").length;
    const warn = entries.length - fix;
    sumEl.textContent = (zh ? "可修复 " : "fixable ") + fix +
      (zh ? " ｜ 已勾选 " : " / selected ") + selected.size +
      (zh ? " ｜ 提示 " : " / advisory ") + warn;
  }

  function head(text, weight, extraCss) {
    return el("div", "font-weight:" + (weight || 600) + ";font-size:13px;" + (extraCss || ""), text);
  }

  function lineFor(e, idx) {
    const h = e.hit;
    const row = el("div", "display:flex;align-items:flex-start;gap:8px;padding:3px 0 3px 14px;border-bottom:1px solid var(--fill-quinary,#f0f0f0);");
    if (h.kind === "fix") {
      const cb = el("input", "margin-top:3px;cursor:pointer;");
      cb.setAttribute("type", "checkbox");
      cb.addEventListener("change", () => { if (cb.checked) selected.add(idx); else selected.delete(idx); updateSum(); });
      e.cb = cb;
      row.appendChild(cb);
    } else {
      row.appendChild(el("span", "color:var(--accent-orange,#d9822b);margin-top:1px;", "⚠"));
    }
    const body = el("div", "flex:1;min-width:0;");
    body.appendChild(el("div", "font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", e.title));
    const detail = el("div", "font-size:11.5px;color:var(--fill-secondary,#666);margin-top:1px;word-break:break-all;");
    detail.textContent = h.from != null
      ? "`" + String(h.from).slice(0, 160) + "` → `" + String(h.to).slice(0, 160) + "`" + (h.note ? "（" + h.note + "）" : "")
      : (h.note || "");
    body.appendChild(detail);
    row.appendChild(body);
    return row;
  }

  function render() {
    listEl.textContent = "";
    entries = [];
    selected.clear();
    if (!scan || !scan.rows.length) {
      listEl.appendChild(el("div", "padding:8px;color:var(--fill-tertiary,#999);", zh ? "没有发现问题，库很干净。" : "No issues found."));
      updateSum();
      return;
    }
    // 分组：group → rule → entries 下标
    const groups = new Map();
    scan.rows.forEach((row) => {
      row.hits.forEach((h) => {
        const i = entries.length;
        entries.push({ row, hit: h, item: row.item, title: (row.snap && row.snap.title) || (row.snap && row.snap.key) || "?" });
        if (!groups.has(h.group)) groups.set(h.group, new Map());
        const g = groups.get(h.group);
        if (!g.has(h.rule)) g.set(h.rule, { label: h.label, kind: h.kind, idxs: [] });
        g.get(h.rule).idxs.push(i);
      });
    });

    for (const [gname, rules] of groups) {
      const sec = el("div", "margin-bottom:12px;");
      sec.appendChild(el("div", "font-weight:700;font-size:13.5px;border-bottom:1px solid var(--fill-quinary,#e5e5e5);padding-bottom:3px;margin-bottom:4px;", gname));
      for (const [, info] of rules) {
        const bar = el("div", "display:flex;align-items:center;gap:8px;margin-top:6px;");
        bar.appendChild(el("span", "font-weight:600;font-size:12.5px;", info.label));
        bar.appendChild(el("span", "color:var(--fill-tertiary,#999);font-size:11.5px;", "×" + info.idxs.length));
        if (info.kind === "fix") {
          const b = el("button", "font-size:11px;padding:1px 8px;cursor:pointer;", zh ? "全选本规则" : "select all");
          b.addEventListener("click", () => {
            info.idxs.forEach((i) => { selected.add(i); if (entries[i].cb) entries[i].cb.checked = true; });
            updateSum();
          });
          bar.appendChild(b);
        } else {
          bar.appendChild(el("span", "color:var(--accent-orange,#d9822b);font-size:11.5px;", zh ? "（提示，不自动修改）" : "(advisory)"));
        }
        sec.appendChild(bar);
        for (const i of info.idxs) sec.appendChild(lineFor(entries[i], i));
      }
      listEl.appendChild(sec);
    }
    updateSum();
  }

  async function run() {
    if (running) return;
    running = true;
    const useLib = $("pp-mr-scope-lib").checked;
    const dir = $("pp-mr-dir").value || "expand";
    pset("metaRulesJournalDir", dir);
    setStatus(zh ? "正在扫描…" : "Scanning…");
    listEl.textContent = "";
    try {
      const items = await MR.collectItems(useLib);
      if (!items.length) {
        setStatus(zh ? "没有可扫描的条目：先在条目列表里选中文献，或改选「扫描整个库」。" : "No items to scan.", true);
        running = false;
        return;
      }
      scan = MR.scanAll(items, { journalPref: pget("metaRulesJournals", ""), journalDir: dir });
      render();
      setStatus((zh ? "已扫描 " : "Scanned ") + scan.scanned +
        (zh ? " 条 ｜ 可修复 " : " ｜ fixable ") + scan.fixCount +
        (zh ? " 处 ｜ 提示 " : " ｜ advisory ") + scan.warnCount + (zh ? " 项" : ""));
    } catch (e) {
      setStatus((zh ? "扫描失败：" : "Scan failed: ") + ((e && e.message) || e), true);
    }
    running = false;
  }

  async function apply() {
    const idxs = [...selected];
    if (!idxs.length) { setStatus(zh ? "还没有勾选任何可修复项" : "Nothing selected", true); return; }
    const targetable = idxs.filter((i) => entries[i].item);
    if (!targetable.length) { setStatus(zh ? "勾选项没有可写入的条目" : "No writable items", true); return; }
    if (!ask((zh ? "将对 " : "Apply ") + targetable.length + (zh
      ? " 处修改写回库中。\n\n建议先「存为报告笔记」留底。是否继续？"
      : " changes to your library.\n\nContinue?"))) return;
    setStatus(zh ? "正在写入…" : "Applying…");
    let ok = 0, fail = 0;
    for (const i of targetable) {
      try { await MR.applyHit(entries[i].item, entries[i].hit); ok++; }
      catch (e) { fail++; }
    }
    setStatus((zh ? "已写入 " : "Applied ") + ok + (zh ? " 处" : "") + (fail ? (zh ? "，失败 " : ", failed ") + fail : ""));
    await run();
  }

  async function save() {
    if (!scan) { setStatus(zh ? "先扫描一次再保存报告" : "Scan first", true); return; }
    try {
      await MR.saveReport(scan);
      setStatus(zh ? "已存为库级笔记（可在库中找到「元数据体检报告」）" : "Saved as a library-level note");
    } catch (e) {
      setStatus((zh ? "保存失败：" : "Save failed: ") + ((e && e.message) || e), true);
    }
  }

  /* ---- 初始化 ---- */
  try { $("pp-mr-dir").value = String(pget("metaRulesJournalDir", "expand")); } catch (e) { /* ignore */ }
  $("pp-mr-run").addEventListener("click", run);
  $("pp-mr-apply").addEventListener("click", apply);
  $("pp-mr-save").addEventListener("click", save);
  $("pp-mr-close").addEventListener("click", () => window.close());
  $("pp-mr-all").addEventListener("click", () => {
    entries.forEach((e, i) => { if (e.hit.kind === "fix") { selected.add(i); if (e.cb) e.cb.checked = true; } });
    updateSum();
  });
  $("pp-mr-none").addEventListener("click", () => {
    entries.forEach((e) => { if (e.cb) e.cb.checked = false; });
    selected.clear();
    updateSum();
  });

  // 打开即扫描选中条目（无选中时给明确提示，不静默）
  setTimeout(run, 120);
})();
