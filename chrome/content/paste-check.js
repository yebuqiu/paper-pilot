// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 粘贴文献列表核验对话框（非模态）
 * 从 window.opener 取 Zotero → Zotero.Papilot.fakeCheck.checkEntry 逐条核验。
 * 解析：DOI 正则优先；标题按 引号 / APA(年份). / Vancouver「. 」分段 启发式提取。
 */
/* global window, document */

(function () {
  const Zotero = window.opener && window.opener.Zotero;
  if (!Zotero || !Zotero.Papilot || !Zotero.Papilot.fakeCheck) {
    document.getElementById("pp-pc-status").textContent = "错误：无法访问 Papilot 模块";
    return;
  }
  const fakeCheck = Zotero.Papilot.fakeCheck;
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const XHTML = "http://www.w3.org/1999/xhtml";

  const input = document.getElementById("pp-pc-input");
  const status = document.getElementById("pp-pc-status");
  const results = document.getElementById("pp-pc-results");
  const runBtn = document.getElementById("pp-pc-run");

  /** 从一行参考文献文本提取 {doi, title, year, raw} */
  function parseLine(line) {
    let text = line.trim();
    const out = { doi: "", title: "", year: 0, raw: text };
    if (!text) return null;
    // DOI（剥结尾标点）
    const dm = text.match(/10\.\d{4,9}\/[^\s"'<>），。;\]]+/i);
    if (dm) out.doi = dm[0].replace(/[.,;:\])}》]+$/, "");
    // 年份
    const ym = text.match(/\b(19|20)\d{2}\b/);
    if (ym) out.year = Number(ym[0]);
    // 标题提取（无 DOI 时才关键）
    let t = "";
    const qm = text.match(/["""']([^"""']{10,200})["""']/) || text.match(/《([^》]{4,200})》/);
    if (qm) {
      t = qm[1];
    } else {
      // APA：作者 (年份). 标题. 期刊
      const apa = text.match(/\(\s*(19|20)\d{2}[a-z]?\s*\)\s*[.:]?\s*([^.。]{10,200})[.。]/);
      if (apa) {
        t = apa[2];
      } else {
        // Vancouver：作者. 标题. 期刊 → 取第二段；去行首编号
        const stripped = text.replace(/^\s*(\[?\d+\]?[.)、]|-|\*)\s*/, "");
        const segs = stripped.split(/\.\s+/).filter(s => s.trim().length > 8);
        if (segs.length >= 2) t = segs[1];
        else if (!out.doi) t = stripped;
      }
    }
    out.title = (t || "").trim().replace(/[.。]+$/, "");
    return (out.doi || out.title) ? out : null;
  }

  function addRow(icon, color, main, sub) {
    const div = document.createElementNS(XHTML, "div");
    div.style.cssText = "padding:5px 2px;border-bottom:1px solid #eee;line-height:1.4;";
    const head = document.createElementNS(XHTML, "div");
    head.innerHTML = "<b style='color:" + color + "'>" + icon + "</b> " +
      (main || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
    div.appendChild(head);
    if (sub) {
      const s = document.createElementNS(XHTML, "div");
      s.style.cssText = "color:var(--fill-secondary,#777);font-size:12px;padding-left:22px;";
      s.textContent = sub;
      div.appendChild(s);
    }
    results.appendChild(div);
    div.scrollIntoView({ block: "nearest" });
  }

  let running = false;

  async function run() {
    if (running) return;
    const lines = input.value.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 10);
    if (!lines.length) {
      status.textContent = zh ? "请先粘贴文献列表" : "Paste references first";
      return;
    }
    running = true;
    runBtn.disabled = true;
    results.innerHTML = "";
    let nReal = 0, nSus = 0, nUnk = 0, nSkip = 0;
    for (let i = 0; i < lines.length; i++) {
      const entry = parseLine(lines[i]);
      status.textContent = (zh ? "核验中 " : "Checking ") + (i + 1) + "/" + lines.length + "…";
      if (!entry) {
        nSkip++;
        addRow("➖", "#999", lines[i].slice(0, 90), zh ? "未能解析出 DOI 或标题，跳过" : "Unparseable, skipped");
        continue;
      }
      try {
        const r = await fakeCheck.checkEntry(entry);
        const head = entry.title || entry.doi;
        if (r.verdict === "real") {
          nReal++;
          addRow("✅", "#1e7d32", head, r.reason + (r.evidence && r.evidence !== entry.title ? "｜记录：" + r.evidence : ""));
        } else if (r.verdict === "suspicious") {
          nSus++;
          addRow("⚠️", "#c0392b", head, r.reason + (r.evidence ? "｜记录：" + r.evidence : ""));
        } else {
          nUnk++;
          addRow("❓", "#b8860b", head, r.reason);
        }
      } catch (e) {
        nUnk++;
        addRow("❓", "#b8860b", entry.title || entry.doi, String(e && e.message || e));
      }
      await new Promise(r2 => setTimeout(r2, 1100)); // 限速
    }
    status.textContent = (zh ? "完成：真实 " : "Done: real ") + nReal +
      (zh ? "，存疑 " : ", suspicious ") + nSus +
      (zh ? "，无法判断 " : ", unknown ") + nUnk +
      (nSkip ? (zh ? "，跳过 " : ", skipped ") + nSkip : "");
    running = false;
    runBtn.disabled = false;
  }

  runBtn.addEventListener("click", () => { run(); });
  document.getElementById("pp-pc-clear").addEventListener("click", () => {
    input.value = "";
    results.innerHTML = "";
    status.textContent = "";
  });
  document.getElementById("pp-pc-close").addEventListener("click", () => window.close());
})();
