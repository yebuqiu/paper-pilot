// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 库内问答对话框（0.22.0）
 * 数据通道与 hub/workbench 一致：Zotero/Services 经 window.arguments 传入，
 * 功能调用一律走 Zotero.Papilot.libSearch（窗口作用域访问不到 bootstrap 作用域）。
 */
/* global window, document, Zotero */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero);
  const PP = Z && Z.Papilot;
  const zh = Z && (Z.locale || "").toLowerCase().startsWith("zh");

  const $ = (id) => document.getElementById(id);
  const statusEl = $("pp-lq-status");
  const astatusEl = $("pp-lq-astatus");
  const candsEl = $("pp-lq-cands");
  const resultEl = $("pp-lq-result");

  if (!PP || !PP.libSearch) {
    statusEl.textContent = zh ? "错误：无法访问 Papilot 模块" : "Error: Papilot module unavailable";
    return;
  }
  const LS = PP.libSearch;

  let hits = [];       // 当前候选
  let answerText = ""; // 当前回答
  let running = false;

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function setStatus(t, isErr) {
    statusEl.textContent = t || "";
    statusEl.style.color = isErr ? "var(--accent-red,#c0392b)" : "var(--fill-secondary,#666)";
  }

  function setAStatus(t, isErr) {
    astatusEl.textContent = t || "";
    astatusEl.style.color = isErr ? "var(--accent-red,#c0392b)" : "var(--fill-secondary,#666)";
  }

  /** 在 Zotero 主窗口中定位条目 */
  function reveal(item) {
    try {
      const win = Z.getMainWindow();
      const zp = Z.getActiveZoteroPane();
      if (zp && zp.selectItem) zp.selectItem(item.id);
      if (win) win.focus();
    } catch (e) { /* ignore */ }
  }

  function renderCandidates() {
    candsEl.textContent = "";
    if (!hits.length) {
      candsEl.appendChild(el("div", "color:var(--fill-tertiary,#999);padding:6px;",
        zh ? "没有命中任何条目，换个说法或放宽条件试试。" : "No matches."));
      return;
    }
    hits.forEach((h, i) => {
      const f = LS.fieldsOf(h.item);
      const row = el("div", "padding:7px 4px;border-bottom:1px solid var(--fill-quinary,#eee);cursor:pointer;");
      const head = el("div", "font-weight:600;font-size:13px;",
        "[" + (i + 1) + "] " + (f.title || "?"));
      row.appendChild(head);
      const meta = el("div", "color:var(--fill-secondary,#777);font-size:11.5px;margin-top:2px;",
        (LS._authors(h.item) || "-") + " ｜ " + (f.journal || "-") + " ｜ " + (LS._year(h.item) || "?") +
        " ｜ " + (zh ? "相关度 " : "score ") + Math.round(h.score));
      row.appendChild(meta);
      const matched = Object.keys(h.fieldHits || {});
      if (matched.length) {
        row.appendChild(el("div", "font-size:11px;margin-top:3px;color:var(--color-accent,#2563eb);",
          (zh ? "命中：" : "matched: ") + matched.join("、")));
      }
      if (h.snippet) {
        row.appendChild(el("div", "font-size:11.5px;margin-top:3px;color:var(--fill-secondary,#666);",
          "…" + h.snippet.slice(0, 160) + "…"));
      }
      row.addEventListener("click", () => reveal(h.item));
      candsEl.appendChild(row);
    });
  }

  async function run() {
    if (running) return;
    const q = $("pp-lq-query").value.trim();
    if (q.length < 2) { setStatus(zh ? "请先输入问题" : "Enter a question first", true); return; }
    running = true;
    $("pp-lq-run").disabled = true;
    resultEl.textContent = "";
    answerText = "";
    setStatus(zh ? "正在检索库内文献…" : "Searching…");
    setAStatus("");
    try {
      const r = await LS.retrieve(q, {
        useCollection: $("pp-lq-collection").checked,
        pdfOnly: $("pp-lq-pdfonly").checked,
        deep: $("pp-lq-deep").checked,
        topN: Number($("pp-lq-topn").value) || 8,
      });
      hits = r.results.slice(0, Number($("pp-lq-topn").value) || 8);
      renderCandidates();
      setStatus((zh ? "范围 " : "scope ") + r.scope + (zh ? " ｜ 扫描 " : " | scanned ") + r.scanned +
        (zh ? " 篇 ｜ 命中 " : " | hits ") + r.results.length +
        (zh ? " 篇 ｜ 全文复核 " : " | full-text ") + r.deepChecked + (zh ? " 篇" : ""));
    } catch (e) {
      setStatus((zh ? "检索失败：" : "Search failed: ") + ((e && e.message) || e), true);
    }
    running = false;
    $("pp-lq-run").disabled = false;
  }

  async function answer() {
    const q = $("pp-lq-query").value.trim();
    if (!q) { setAStatus(zh ? "请先检索" : "Search first", true); return; }
    if (!hits.length) { setAStatus(zh ? "没有候选文献，先检索并确认命中" : "No candidates yet", true); return; }
    if (!PP.aiClient || !PP.aiClient.hasKey()) {
      // 项目纪律：AI 未就绪不静默，给出精确原因与去处
      const reason = PP.aiClient ? PP.aiClient.guidance() : "";
      setAStatus((zh ? "AI 不可用：" : "AI unavailable: ") + reason, true);
      return;
    }
    $("pp-lq-answer").disabled = true;
    setAStatus(zh ? "AI 正在依据候选文献作答…" : "AI is answering…");
    resultEl.textContent = "";
    try {
      const r = await LS.answer(q, hits);
      if (!r.ok) {
        setAStatus((zh ? "AI 不可用：" : "AI unavailable: ") + (r.text || r.reason), true);
      } else {
        answerText = r.text;
        const Md = PP.mdLite;
        if (Md && Md.toHtml) {
          const box = el("div", "");
          box.innerHTML = Md.toHtml(answerText);
          resultEl.appendChild(box);
        } else {
          resultEl.appendChild(el("div", "white-space:pre-wrap;", answerText));
        }
        resultEl.appendChild(el("div", "margin-top:12px;padding-top:8px;border-top:1px solid var(--fill-quinary,#eee);font-size:11.5px;color:var(--fill-secondary,#777);",
          zh ? "以上回答基于候选文献生成，请对照原文核对；引用编号 [n] 对应左侧候选列表序号。"
             : "Verify against the originals; [n] maps to the candidate list on the left."));
        setAStatus(zh ? "已生成" : "Done");
      }
    } catch (e) {
      setAStatus((zh ? "生成失败：" : "Failed: ") + ((e && e.message) || e), true);
    }
    $("pp-lq-answer").disabled = false;
  }

  async function saveNote() {
    if (!hits.length) { setAStatus(zh ? "没有可保存的内容" : "Nothing to save", true); return; }
    try {
      await LS.saveAsNote($("pp-lq-query").value.trim(), hits, answerText);
      setAStatus(zh ? "已存为库级笔记（在「我的文库」根下）" : "Saved as a library note");
    } catch (e) {
      setAStatus((zh ? "保存失败：" : "Save failed: ") + ((e && e.message) || e), true);
    }
  }

  $("pp-lq-run").addEventListener("click", () => { run(); });
  $("pp-lq-answer").addEventListener("click", () => { answer(); });
  $("pp-lq-save").addEventListener("click", () => { saveNote(); });
  $("pp-lq-close").addEventListener("click", () => window.close());
  $("pp-lq-query").addEventListener("keydown", (ev) => {
    // Ctrl/⌘ + Enter 直接检索，符合聊天式输入习惯
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); run(); }
  });
})();
