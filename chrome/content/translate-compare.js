// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 多引擎同屏对比小窗（窗口脚本，C2）
 * 只做 UI：预填文本、引擎勾选、分栏渲染结果与耗时。
 * 翻译编排回插件作用域（window.arguments[0].compare）—— 窗口作用域访问不到 TranslateSvc。
 * 单引擎失败只渲染自己那一栏的错误占位，不影响其他栏。
 */
/* global window, document */

(function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  let A = (window.arguments && window.arguments[0]) || {};
  const $ = (id) => document.getElementById(id);
  const zh = () => A.isZh !== false;
  let busy = false;

  function h(tag, attrs, text) {
    const el = document.createElementNS(XHTML, tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  }

  function setStatus(msg) { $("pp-tc-status").textContent = msg || ""; }

  /* ---------------- 引擎勾选区 ---------------- */

  function renderEngines() {
    const box = $("pp-tc-engines");
    while (box.firstChild) box.removeChild(box.firstChild);
    const checked = new Set(Array.isArray(A.checked) ? A.checked : []);
    for (const e of (A.engines || [])) {
      const label = h("label", {
        style: "display:inline-flex;align-items:center;gap:3px;margin:0 8px 4px 0;" +
          "font-size:12px;cursor:pointer;white-space:nowrap;" +
          (e.ready ? "" : "opacity:0.55;"),
        title: e.ready ? "" : (zh() ? "该引擎未就绪（缺密钥或 AI 不可用），勾选后可能失败" : "Not ready"),
      });
      const cb = h("input", { type: "checkbox", value: e.id, "data-engine": e.id });
      cb.checked = checked.has(e.id);
      label.appendChild(cb);
      label.appendChild(h("span", null, e.name + (e.llm ? " 🤖" : "")));
      box.appendChild(label);
    }
  }

  function checkedIds() {
    const out = [];
    for (const cb of $("pp-tc-engines").querySelectorAll("input[type=checkbox]")) {
      if (cb.checked) out.push(cb.getAttribute("data-engine"));
    }
    return out;
  }

  /* ---------------- 结果分栏 ---------------- */

  function columnShell(name) {
    const col = h("div", {
      style: "flex:1 1 0;min-width:230px;display:flex;flex-direction:column;" +
        "border:1px solid #88888840;border-radius:6px;background:var(--material-surface,#fff);" +
        "color:var(--fill-primary,#222);overflow:hidden;",
    });
    const head = h("div", {
      style: "display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:12px;" +
        "font-weight:600;border-bottom:1px solid #88888830;background:#88888810;",
    });
    head.appendChild(h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;" }, name));
    const ms = h("span", { style: "flex:none;font-weight:400;color:#888;font-size:11px;" }, "");
    head.appendChild(ms);
    col.appendChild(head);
    const body = h("div", {
      style: "flex:1;overflow-y:auto;padding:8px;font-size:13px;line-height:1.55;" +
        "white-space:pre-wrap;word-break:break-word;min-height:120px;",
    });
    col.appendChild(body);
    return { col, head, body, ms };
  }

  function renderPending(ids) {
    const box = $("pp-tc-results");
    while (box.firstChild) box.removeChild(box.firstChild);
    const map = new Map();
    for (const id of ids) {
      const eng = (A.engines || []).find((e) => e.id === id);
      const c = columnShell(eng ? eng.name : id);
      c.body.textContent = zh() ? "翻译中…" : "Translating…";
      c.body.style.color = "#888";
      box.appendChild(c.col);
      map.set(id, c);
    }
    return map;
  }

  function fillColumn(c, r) {
    c.ms.textContent = r.ms + " ms";
    c.body.style.color = "";
    if (r.ok) {
      c.body.textContent = r.text;
      // 复制按钮
      const copyBtn = h("button", {
        style: "flex:none;font-size:11px;padding:1px 6px;border:1px solid #88888855;" +
          "border-radius:4px;background:transparent;color:inherit;cursor:pointer;",
      }, zh() ? "复制" : "Copy");
      copyBtn.addEventListener("click", () => {
        try {
          A.Zotero.Utilities.Internal.copyText(r.text);
          copyBtn.textContent = zh() ? "已复制" : "Copied";
          setTimeout(() => { try { copyBtn.textContent = zh() ? "复制" : "Copy"; } catch (e) { /* ignore */ } }, 1200);
        } catch (e) { /* ignore */ }
      });
      c.head.appendChild(copyBtn);
    } else {
      // 失败占位：仅本栏标红，其他栏不受影响
      c.body.textContent = (zh() ? "⚠ 失败：" : "⚠ Failed: ") + r.error;
      c.body.style.color = "var(--color-warning,#b45309)";
      c.col.style.borderColor = "#b4530955";
    }
  }

  /* ---------------- 主流程 ---------------- */

  async function run() {
    if (busy) return;
    const text = String($("pp-tc-input").value || "").trim();
    if (!text) {
      setStatus(zh() ? "请先输入要翻译的文本" : "Enter text first");
      return;
    }
    const ids = checkedIds();
    if (!ids.length) {
      setStatus(zh() ? "请至少勾选一个引擎" : "Check at least one engine");
      return;
    }
    busy = true;
    $("pp-tc-run").disabled = true;
    setStatus(zh() ? "并行请求 " + ids.length + " 个引擎…" : "Querying " + ids.length + " engines…");
    const cols = renderPending(ids);
    const t0 = Date.now();
    try {
      const results = await A.compare(ids, text);
      const byEngine = new Map((results || []).map((r) => [r.engine, r]));
      let okN = 0;
      for (const id of ids) {
        const r = byEngine.get(id);
        const c = cols.get(id);
        if (!r || !c) continue;
        if (r.ok) okN++;
        fillColumn(c, r);
      }
      setStatus((zh() ? "完成：" : "Done: ") + okN + "/" + ids.length +
        (zh() ? " 个引擎成功，总耗时 " : " succeeded in ") + (Date.now() - t0) + " ms");
    } catch (e) {
      // compare 自身承诺不整体 reject；这里只是兜底，绝不让窗口白屏
      setStatus((zh() ? "对比失败：" : "Failed: ") + ((e && e.message) || e));
    } finally {
      busy = false;
      $("pp-tc-run").disabled = false;
    }
  }

  function init(payload) {
    if (payload) A = payload;
    $("pp-tc-input").value = A.text || "";
    $("pp-tc-target").textContent = (zh() ? "目标语言：" : "Target: ") + (A.targetLabel || "");
    renderEngines();
    const box = $("pp-tc-results");
    while (box.firstChild) box.removeChild(box.firstChild);
    setStatus("");
  }

  /** 单实例复用：插件侧重开时换文本/重渲染 */
  window.ppTCLoad = function (payload) {
    try { window.focus(); } catch (e) { /* ignore */ }
    init(payload || {});
    return true;
  };

  function bindUi() {
    $("pp-tc-run").addEventListener("click", run);
    $("pp-tc-close").addEventListener("click", () => { try { window.close(); } catch (e) { /* ignore */ } });
    if (!zh()) {
      $("pp-tc-eng-label").textContent = "Engines:";
      $("pp-tc-run").textContent = "Compare";
      $("pp-tc-close").textContent = "Close";
      document.title = "Papilot · Engine Compare";
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    bindUi(); init(A);
  } else {
    window.addEventListener("DOMContentLoaded", () => { bindUi(); init(A); }, { once: true });
  }
})();
