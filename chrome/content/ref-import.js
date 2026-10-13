/* PaperPilot 参考文献一键入库 · 对话框脚本（0.33.0）
 *
 * 运行在独立 chrome 窗口作用域：拿不到 bootstrap 作用域，**也不允许自己发网络/AI 请求**
 * （这条纪律与双语对照窗口一致，见 check-wiring 的守卫）。一切动作都经
 * window.arguments[0].api 注入的回调完成 —— 这样窗口脚本可以脱离 Zotero 单测。
 */
/* global window, document, setInterval, clearInterval */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const arg = (window.arguments && window.arguments[0]) || {};
  const api = arg.api || {};
  const payload = arg.payload || {};

  const state = {
    records: [],
    checked: new Set(),
    busy: false,
  };

  const $ = (id) => document.getElementById(id);
  const zh = (() => { try { return api.isZh ? api.isZh() : true; } catch (e) { return true; } })();

  /* ---------------- DOM 小工具（只用 createElementNS，避免 innerHTML 注入） ---------------- */

  function el(tag, opts) {
    const e = document.createElementNS(XHTML, tag);
    const o = opts || {};
    if (o.id) e.setAttribute("id", o.id);
    if (o.cls) e.setAttribute("class", o.cls);
    if (o.style) e.setAttribute("style", o.style);
    if (o.text != null) e.textContent = String(o.text);
    if (o.title) e.setAttribute("title", o.title);
    return e;
  }

  function labelFor(cb, text, style) {
    const lab = el("label", { style: style || "display:inline-flex;align-items:center;gap:4px;cursor:pointer;" });
    lab.appendChild(cb);
    lab.appendChild(el("span", { text: text }));
    return lab;
  }

  function setStatus(text) {
    const s = $("pp-ri-status");
    if (s) s.textContent = String(text || "");
  }

  function checkedRecords() {
    const out = [];
    for (const i of state.checked) if (state.records[i]) out.push(state.records[i]);
    return out;
  }

  function updateCount() {
    const c = $("pp-ri-count");
    if (!c) return;
    const dup = state.records.filter((r) => r.dup && r.dup.dup).length;
    c.textContent = (zh ? "共 " : "Total ") + state.records.length
      + (zh ? " 条，已勾选 " : ", selected ") + state.checked.size
      + (dup ? (zh ? "，" + dup + " 条已在库" : ", " + dup + " in library") : "");
  }

  /* ---------------- 来源勾选 ---------------- */

  function buildSources() {
    const box = $("pp-ri-sources");
    if (!box) return;
    box.textContent = "";
    let list = [];
    try { list = api.sources ? (api.sources() || []) : []; } catch (e) { list = []; }
    let def = [];
    try { def = api.defaultSources ? (api.defaultSources() || []) : []; } catch (e) { def = []; }
    const head = el("span", { text: zh ? "检索来源：" : "Sources:", style: "color:var(--fill-secondary,#666);" });
    box.appendChild(head);
    for (const s of list) {
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = def.indexOf(s.id) >= 0;
      cb.setAttribute("data-source", s.id);
      const lab = labelFor(cb, s.label + (s.hint ? (zh ? "（" + s.hint + "）" : " (" + s.hint + ")") : ""));
      if (s.hint) lab.setAttribute("title", s.hint);
      box.appendChild(lab);
    }
  }

  function selectedSources() {
    const box = $("pp-ri-sources");
    if (!box) return [];
    const out = [];
    for (const cb of box.getElementsByTagName("input")) {
      if (cb.type === "checkbox" && cb.checked) out.push(cb.getAttribute("data-source"));
    }
    return out;
  }

  /* ---------------- 结果渲染 ---------------- */

  function metaLine(rec) {
    const bits = [];
    const names = (rec.authors || []).map((a) => (a.literal ? a.literal : [a.given, a.family].filter(Boolean).join(" ").trim() || a.family));
    if (names.length) bits.push(names.slice(0, 3).join(", ") + (names.length > 3 ? " et al." : ""));
    if (rec.year) bits.push(String(rec.year));
    if (rec.container) bits.push(rec.container);
    const vip = [rec.volume ? (zh ? "卷 " : "vol ") + rec.volume : "", rec.issue ? "(" + rec.issue + ")" : "", rec.pages ? ": " + rec.pages : ""].join("");
    if (vip) bits.push(vip);
    if (rec.doi) bits.push("DOI: " + rec.doi);
    if (rec.pmid) bits.push("PMID:" + rec.pmid);
    if (rec.arxivId) bits.push("arXiv:" + rec.arxivId);
    return bits.join(" ｜ ");
  }

  function badgeRow(rec) {
    const row = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;" });
    const add = (text, color) => {
      row.appendChild(el("span", {
        text: text,
        style: "font-size:.82em;padding:0 5px;border-radius:8px;border:1px solid " + color + ";color:" + color + ";",
      }));
    };
    for (const s of rec.source || []) add(s, "#3a7afe");
    if (rec.dup && rec.dup.dup) add(zh ? "已在库（" + rec.dup.by + "）" : "in library (" + rec.dup.by + ")", "#c0871b");
    if (rec.ai) add(zh ? "AI 补全 · " + (rec.confidence || "medium") : "AI filled · " + (rec.confidence || "medium"), "#8b5cf6");
    if (rec.confidence === "low") add(zh ? "可信度低" : "low confidence", "#c0392b");
    if (rec.note) row.setAttribute("title", rec.note);
    if (!row.children.length) return null;
    return row;
  }

  function renderList() {
    const list = $("pp-ri-list");
    if (!list) return;
    list.textContent = "";
    if (!state.records.length) {
      list.appendChild(el("div", {
        text: zh ? "还没有结果。粘贴 DOI / 标题 / 链接 / PMID / arXiv 号 / BibTeX 后点「联合检索 / 解析」。" : "No results yet.",
        style: "color:var(--fill-secondary,#666);padding:12px;",
      }));
      updateCount();
      return;
    }
    state.records.forEach((rec, i) => {
      const row = el("div", { style: "border-bottom:1px solid var(--fill-tertiary,#ddd);padding:5px 2px;" });
      if (rec.dup && rec.dup.dup) row.setAttribute("style", row.getAttribute("style") + "opacity:.72;");
      const head = el("label", { style: "display:flex;gap:8px;align-items:flex-start;cursor:pointer;" });
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = state.checked.has(i);
      cb.addEventListener("change", () => {
        if (cb.checked) state.checked.add(i); else state.checked.delete(i);
        updateCount();
      });
      head.appendChild(cb);
      const body = el("div", { style: "flex:1;min-width:0;" });
      body.appendChild(el("div", { text: rec.title || (zh ? "（无标题）" : "(no title)"), style: "font-weight:600;word-break:break-word;" }));
      const meta = metaLine(rec);
      if (meta) body.appendChild(el("div", { text: meta, style: "color:var(--fill-secondary,#666);font-size:.9em;word-break:break-word;" }));
      const badges = badgeRow(rec);
      if (badges) body.appendChild(badges);
      head.appendChild(body);
      row.appendChild(head);
      list.appendChild(row);
    });
    updateCount();
  }

  /* ---------------- 业务动作 ---------------- */

  function applyDupDefault() {
    // 「库中已有的不勾选」= 默认行为：新结果一律勾选，重复条目取消勾选但仍留在列表里
    state.checked = new Set();
    state.records.forEach((r, i) => {
      if (!(r.dup && r.dup.dup)) state.checked.add(i);
    });
  }

  async function addRecords(newOnes, note) {
    if (!newOnes || !newOnes.length) return 0;
    const merged = state.records.concat(newOnes);
    let deduped = merged;
    try {
      if (api.dedupe) {
        const r = api.dedupe(merged);
        deduped = r.records || merged;
      }
    } catch (e) { /* 去重失败也要给用户看到结果 */ }
    state.records = deduped;
    if (api.markDuplicates) {
      try { await api.markDuplicates(state.records); } catch (e) { /* ignore */ }
    }
    applyDupDefault();
    renderList();
    if (note) setStatus(note);
    return newOnes.length;
  }

  async function onSearch() {
    if (state.busy) { setStatus(zh ? "正在处理，请稍候…" : "Busy…"); return; }
    const input = $("pp-ri-input");
    const text = input ? String(input.value || "") : "";
    if (!text.trim()) { setStatus(zh ? "请先粘贴 DOI / 标题 / 链接 / PMID / arXiv 号 / BibTeX" : "Paste something first"); return; }
    const sources = selectedSources();
    const limit = Math.max(1, Math.min(50, Number(($("pp-ri-limit") || {}).value) || 10));
    if (!sources.length) { setStatus(zh ? "至少勾选一个检索来源" : "Select at least one source"); return; }
    state.busy = true;
    const btn = $("pp-ri-search");
    if (btn) btn.disabled = true;
    try {
      let collected = [];
      if (/^\s*@[a-zA-Z]+\s*[{(]/.test(text) && api.parseBibtex) {
        setStatus(zh ? "解析 BibTeX…" : "Parsing BibTeX…");
        collected = (await api.parseBibtex(text)) || [];
        setStatus(zh ? "BibTeX 解析出 " + collected.length + " 条" : "Parsed " + collected.length);
      } else {
        const idents = (await api.parseInput(text)) || [];
        const hard = idents.filter((x) => x.kind !== "title");
        const titles = idents.filter((x) => x.kind === "title");
        let done = 0;
        for (const ident of hard) {
          done++;
          setStatus((zh ? "精确解析 " : "Resolving ") + done + "/" + hard.length + " · " + ident.kind);
          try {
            const rec = await api.resolve(ident, { sources: sources });
            if (rec) collected.push(rec);
          } catch (e) { /* 单条失败不影响其余 */ }
        }
        // 标题/自由文本 → 联合检索，每条取最佳命中
        const queries = titles.length ? titles.map((t) => t.value) : (hard.length ? [] : [text.trim()]);
        for (let qi = 0; qi < queries.length; qi++) {
          setStatus((zh ? "联合检索 " : "Searching ") + (qi + 1) + "/" + queries.length);
          try {
            const r = await api.search(queries[qi], { sources: sources, limit: limit });
            for (const rec of (r && r.results) || []) collected.push(rec);
            const errs = Object.keys((r && r.errors) || {});
            if (errs.length) setStatus((zh ? "部分来源失败：" : "Some sources failed: ") + errs.join(", "));
          } catch (e) { /* ignore */ }
        }
      }

      if (!collected.length) {
        setStatus(zh
          ? "没有查到结果。可以试试：换标题关键词、补上 DOI，或点「AI 调研」让模型按线索给出候选。"
          : "Nothing found. Try different keywords, add a DOI, or use AI investigation.");
        renderList();
        return;
      }

      // 逐条多源补全（慢，只对前 20 条做，避免把用户按在窗口上等）
      if ($("pp-ri-opt-enrich") && $("pp-ri-opt-enrich").checked && api.enrich) {
        const head = collected.slice(0, 20);
        for (let i = 0; i < head.length; i++) {
          setStatus((zh ? "多源补全 " : "Enriching ") + (i + 1) + "/" + head.length);
          try {
            const r = await api.enrich([head[i]]);
            if (r && r[0]) collected[collected.indexOf(head[i])] = r[0];
          } catch (e) { /* ignore */ }
        }
      }

      // AI 补全（只填空，不覆盖）
      if ($("pp-ri-opt-ai") && $("pp-ri-opt-ai").checked && api.aiComplete) {
        const st = api.aiStatus ? api.aiStatus() : "ok";
        if (st !== "ok") {
          setStatus(zh ? "AI 不可用（" + st + "），已跳过 AI 补全" : "AI unavailable (" + st + "), skipped");
        } else {
          setStatus(zh ? "AI 补全元数据…" : "AI completing metadata…");
          try {
            const r = await api.aiComplete(collected);
            if (r && r.ok === false) setStatus(zh ? "AI 补全失败：" + (r.reason || "") : "AI failed: " + (r.reason || ""));
            else if (r && r.filled) setStatus((zh ? "AI 补全了 " : "AI filled ") + r.filled + (zh ? " 个字段" : " fields"));
          } catch (e) { /* ignore */ }
        }
      }

      let excluded = 0;
      if ($("pp-ri-opt-exclude") && $("pp-ri-opt-exclude").checked) {
        // 勾选「排除库中已有」→ 直接把重复条目从列表里拿掉
        //（不勾选时它们仍会进列表、只是默认不勾中；「去掉已在库的」按钮可随时手工清理）
        const before = collected.length;
        if (api.markDuplicates) { try { await api.markDuplicates(collected); } catch (e) { /* ignore */ } }
        collected = collected.filter((r) => !(r.dup && r.dup.dup));
        excluded = before - collected.length;
      }

      await addRecords(collected, (zh ? "已解析 " : "Parsed ") + collected.length + (zh ? " 条（去重后）" : " (deduped)")
        + (excluded ? (zh ? "，已过滤 " + excluded + " 条库中已有" : ", filtered " + excluded + " in-library") : ""));
    } finally {
      state.busy = false;
      if (btn) btn.disabled = false;
    }
  }

  async function onInvestigate() {
    const input = $("pp-ri-input");
    const text = input ? String(input.value || "") : "";
    if (!text.trim()) { setStatus(zh ? "请先填入线索（标题 + 作者/年份/etc.）" : "Fill in some clues first"); return; }
    if (!api.aiInvestigate) { setStatus(zh ? "AI 不可用" : "AI unavailable"); return; }
    const st = api.aiStatus ? api.aiStatus() : "ok";
    if (st !== "ok") { setStatus(zh ? "AI 不可用（" + st + "）：请登录或配置模型通道" : "AI unavailable (" + st + ")"); return; }
    if (state.busy) return;
    state.busy = true;
    setStatus(zh ? "AI 调研中…" : "Asking AI…");
    try {
      const r = await api.aiInvestigate(text);
      if (!r || !r.ok) { setStatus((zh ? "AI 调研失败：" : "AI failed: ") + ((r && r.reason) || "")); return; }
      await addRecords([r.record], zh
        ? "AI 调研结果已加入（未核实！请自行确认后再引用）"
        : "AI suggestion added (unverified!)");
    } finally {
      state.busy = false;
    }
  }

  /** 从主窗口当前选中的文献取其参考文献（原「参考文献一键入库」入口的修复版） */
  async function onLoadReferences() {
    if (state.busy) return;
    if (!api.fetchReferences) { setStatus(zh ? "不可用" : "Unavailable"); return; }
    state.busy = true;
    const btn = $("pp-ri-refs-btn");
    if (btn) btn.disabled = true;
    setStatus(zh ? "正在拉取当前文献的参考文献…" : "Fetching references…");
    try {
      const r = await api.fetchReferences({ max: 200 });
      const recs = (r && r.records) || [];
      if (!recs.length) {
        setStatus(zh ? "该文献没有可用的参考文献列表（或 Semantic Scholar 未收录）" : "No references found");
        return;
      }
      if (r.paper && r.paper.title) {
        const sub = $("pp-ri-sub");
        if (sub) sub.textContent = (zh ? "来源文献：" : "Source: ") + r.paper.title;
      }
      await addRecords(recs, (zh ? "已拉取 " : "Fetched ") + recs.length + (zh ? " 篇参考文献（已标注库中已有）" : " references"));
    } catch (e) {
      setStatus((zh ? "拉取失败：" : "Failed: ") + ((e && e.message) || String(e)));
    } finally {
      state.busy = false;
      if (btn) btn.disabled = false;
    }
  }

  async function onImport() {
    if (state.busy) return;
    const picked = checkedRecords();
    if (!picked.length) { setStatus(zh ? "没有勾选任何条目" : "Nothing selected"); return; }
    if (!api.importRecords) { setStatus(zh ? "不可用" : "Unavailable"); return; }
    state.busy = true;
    const btn = $("pp-ri-import");
    if (btn) btn.disabled = true;
    setStatus((zh ? "正在入库 " : "Importing ") + picked.length + (zh ? " 篇…" : "…"));
    try {
      const r = await api.importRecords(picked, {
        viaTranslator: !!($("pp-ri-opt-translator") && $("pp-ri-opt-translator").checked),
      });
      let msg = (zh ? "已入库 " : "Imported ") + (r.ok || 0) + (zh ? " 篇" : "");
      if (r.fail) msg += (zh ? "，失败 " : ", failed ") + r.fail;
      if (r.collection && r.collection.name) msg += (zh ? " → 分类「" : " → \"") + r.collection.name + (zh ? "」" : "\"");
      if (r.mode === "translator") msg += zh ? "（经 Zotero 内置解析器）" : " (via Zotero importer)";
      setStatus(msg);
      if (api.invalidateLibrary) api.invalidateLibrary();
      try { await api.markDuplicates(state.records); } catch (e) { /* ignore */ }
      renderList();
      if (r.fail && r.errors && r.errors.length) {
        setStatus(msg + " ｜ " + (zh ? "首条错误：" : "first error: ") + (r.errors[0].message || "").slice(0, 80));
      }
    } finally {
      state.busy = false;
      if (btn) btn.disabled = false;
    }
  }

  function extOf(fmt) {
    if (fmt === "ris") return "ris";
    if (fmt === "endnote-xml") return "xml";
    if (fmt === "csl") return "json";
    return "bib";
  }

  async function onSaveFile() {
    const picked = checkedRecords();
    if (!picked.length) { setStatus(zh ? "没有勾选任何条目" : "Nothing selected"); return; }
    const fmt = ($("pp-ri-format") || {}).value || "bibtex";
    const text = await api.exportText(picked, fmt);
    const path = await api.saveText(text, "references." + extOf(fmt));
    setStatus(path ? ((zh ? "已导出到 " : "Exported to ") + path) : (zh ? "已取消导出" : "Export cancelled"));
  }

  async function onCopy() {
    const picked = checkedRecords();
    if (!picked.length) { setStatus(zh ? "没有勾选任何条目" : "Nothing selected"); return; }
    const fmt = ($("pp-ri-format") || {}).value || "bibtex";
    const text = await api.exportText(picked, fmt);
    const ok = await api.copyText(text);
    setStatus(ok ? (zh ? "已复制到剪贴板（" + fmt.toUpperCase() + "）" : "Copied (" + fmt.toUpperCase() + ")")
      : (zh ? "复制失败" : "Copy failed"));
  }

  /* ---------------- 初始化 ---------------- */

  function wire() {
    buildSources();
    renderList();
    const on = (id, fn) => { const e = $(id); if (e) e.addEventListener("click", fn); };
    on("pp-ri-search", onSearch);
    on("pp-ri-investigate", onInvestigate);
    on("pp-ri-refs-btn", onLoadReferences);
    on("pp-ri-clear", () => {
      state.records = [];
      state.checked = new Set();
      renderList();
      setStatus("");
    });
    on("pp-ri-selectall", () => {
      state.records.forEach((r, i) => state.checked.add(i));
      renderList();
    });
    on("pp-ri-selectnone", () => {
      state.checked = new Set();
      renderList();
    });
    on("pp-ri-dropdup", () => {
      const before = state.records.length;
      state.records = state.records.filter((r) => !(r.dup && r.dup.dup));
      applyDupDefault();
      renderList();
      setStatus((zh ? "已移除 " : "Removed ") + (before - state.records.length) + (zh ? " 条已在库的条目" : " duplicates"));
    });
    on("pp-ri-import", onImport);
    on("pp-ri-save", onSaveFile);
    on("pp-ri-copy", onCopy);
    on("pp-ri-close", () => window.close());

    const input = $("pp-ri-input");
    if (input) {
      input.setAttribute("placeholder", zh
        ? "每行一条，或直接粘贴整段 BibTeX。支持：10.1038/nature12373 ／ https://doi.org/… ／ PMID: 12345678 ／ arXiv:2101.00001 ／ 论文标题"
        : "One per line, or paste BibTeX. Supports DOI / doi.org URL / PMID / arXiv id / title");
    }
    const head = $("pp-ri-head");
    if (head) head.setAttribute("value", zh ? "参考文献一键入库" : "Import References");
    const sub = $("pp-ri-sub");
    if (sub) sub.setAttribute("value", zh
      ? "支持 DOI／标题／链接／PMID／arXiv 号／BibTeX；多源联合检索 + 自动判重 + AI 元数据补全；可导出 BibTeX / EndNote。"
      : "DOI / title / URL / PMID / arXiv / BibTeX · multi-source search, dedupe, AI metadata completion, BibTeX/EndNote export.");
    const rb = $("pp-ri-refs-btn");
    if (rb) rb.textContent = zh ? "从当前文献导入参考文献" : "Import references of selected item";
    const st = $("pp-ri-selectall");
    if (st) st.textContent = zh ? "全选" : "Select all";
    const sn = $("pp-ri-selectnone");
    if (sn) sn.textContent = zh ? "清空勾选" : "Clear";
    const dd = $("pp-ri-dropdup");
    if (dd) dd.textContent = zh ? "去掉已在库的" : "Drop in-library";
    const sb = $("pp-ri-search");
    if (sb) sb.textContent = zh ? "联合检索 / 解析" : "Search / Resolve";
    const ib = $("pp-ri-investigate");
    if (ib) ib.textContent = zh ? "AI 调研" : "AI investigate";
    const cb2 = $("pp-ri-clear");
    if (cb2) cb2.textContent = zh ? "清空" : "Clear";
    const imp = $("pp-ri-import");
    if (imp) imp.textContent = zh ? "导入选中" : "Import selected";
    const sv = $("pp-ri-save");
    if (sv) sv.textContent = zh ? "导出到文件" : "Export to file";
    const cp = $("pp-ri-copy");
    if (cp) cp.textContent = zh ? "复制" : "Copy";
    const cl = $("pp-ri-close");
    if (cl) cl.textContent = zh ? "关闭" : "Close";
  }

  /** 单实例复用：主窗口再次调用时把新载荷推进来 */
  window.PaperPilotSetPayload = function (p) {
    if (!p) return;
    if (p.mode === "refs") onLoadReferences();
  };

  wire();
  if (payload.mode === "refs") onLoadReferences();
})();
