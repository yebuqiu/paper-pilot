// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 双向链接：正向靠 Zotero 的 URI scheme，反向靠本地台账
 *
 * 正向（引文 → 原文）
 *   zotero://open-pdf/library/items/<attachmentKey>?page=<p>&annotation=<anno>
 *   zotero://select/library/items/<itemKey>
 *   这两个是 Zotero 原生支持的，**不需要装任何东西**；我们只负责把 URI 拼对，
 *   再交给本地代理 ShellExecute（WPS 12 里加载项自己的 ShellExecute 已失效）。
 *
 * 反向（原文 → 引文）
 *   Zotero 没有"谁引用了我"的原生能力，所以由本地代理维护一份台账：
 *     %APPDATA%\PapilotCite\links.json
 *   key = 文档路径哈希，值 = { doc, style, cites: [{token, itemKey, page, anno, snippet, seq, text}] }
 *   每次插入/刷新都 upsert；代理还能生成 PDF 同目录的 `<pdf名>.被引用.md` 边车文件，
 *   让"从原文找引用"在文件系统层面也有一条可见路径。
 */
(function (root) {
  "use strict";

  const ZOTERO = "zotero://";

  /** 跳到 PDF 的具体页（带 annotation 时精确到高亮） */
  function pdfUri(attachmentKey, page, anno) {
    if (!attachmentKey) return "";
    let u = `${ZOTERO}open-pdf/library/items/${attachmentKey}`;
    const q = [];
    if (page) q.push("page=" + Number(page));
    if (anno) q.push("annotation=" + String(anno).toUpperCase());
    return q.length ? u + "?" + q.join("&") : u;
  }

  /** 选中条目（在 Zotero 里高亮该条） */
  function selectUri(itemKey, libId) {
    if (!itemKey) return "";
    const lib = Number(libId || 1);
    return lib === 1
      ? `${ZOTERO}select/library/items/${itemKey}`
      : `${ZOTERO}select/groups/${lib}/items/${itemKey}`;
  }

  /** 给正则/URL 用的短摘要（台账里存一句上下文，便于人眼确认） */
  function snippet(text, max) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    const n = max || 60;
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /** 台账记录（一次刷新写一批） */
  function record(docPath, entry) {
    return {
      doc: docPath,
      token: entry.token,
      itemKey: entry.itemKey,
      libId: entry.libId || 1,
      page: entry.page || 0,
      anno: entry.anno || "",
      locator: entry.locator || "",
      seq: entry.seq || 0,
      text: entry.text || "",
      snippet: snippet(entry.snippet || ""),
    };
  }

  /** 边车 Markdown：人在 PDF 目录里就能看到"这份 PDF 被谁引用了" */
  function sidecarMarkdown(item, records, docTitleOf) {
    const lines = [
      `# 被引用记录：${item.title || item.itemKey}`,
      "",
      `> 由 Papilot Cite 自动生成，最近更新 ${new Date().toISOString().slice(0, 16).replace("T", " ")}。`,
      `> 共 ${records.length} 处引用，来自 ${new Set(records.map((r) => r.doc)).size} 个文档。`,
      "",
    ];
    const groups = new Map();
    for (const r of records) {
      const k = r.page || 0;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const page of [...groups.keys()].sort((a, b) => a - b)) {
      lines.push(`## ${page ? `第 ${page} 页` : "未标注页码"}`);
      lines.push("");
      for (const r of groups.get(page)) {
        const doc = docTitleOf ? docTitleOf(r.doc) : r.doc;
        const enc = encodeURI("file:///" + String(r.doc).replace(/\\/g, "/"));
        lines.push(`- [${doc}](${enc})${r.text ? " · " + r.text : ""}` +
          (r.snippet ? `\n  > ${r.snippet}` : ""));
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  const api = { pdfUri, selectUri, snippet, record, sidecarMarkdown };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PPLinks = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
