// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 正文抽取与文本清洗（经典脚本：供 content script 直接加载，同时可在 Node 侧副作用导入做单测）。
 * 不依赖任何框架；extractFromDocument 只用到 querySelector / innerText / closest 这几个标准接口。
 */
(function (root) {
  "use strict";

  var CANDIDATES = ["article", "main", '[role="main"]', ".article-body", "#content", ".content", "body"];
  var BLOCKS = "h1,h2,h3,p,li,blockquote,figcaption";
  var SKIP = "nav,footer,aside,script,style,noscript,form,header,[role='navigation'],[aria-hidden='true']";

  /** 折叠行内空白，保留段落分隔（连续空行压成一个）。 */
  function normalizeText(input) {
    return String(input || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\u00a0\u3000]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** 按空行切段；单行过长（>400 字）时按句号再切一次，避免整页挤成一段。 */
  function paragraphize(input) {
    var text = normalizeText(input);
    if (!text) return [];
    var out = [];
    text.split(/\n{2,}/).forEach(function (block) {
      if (block.length <= 400) {
        out.push(block);
        return;
      }
      var sentences = block.match(/[^。！？.!?]+[。！？.!?]?/g) || [block];
      var buf = "";
      sentences.forEach(function (s) {
        if ((buf + s).length > 400 && buf) {
          out.push(buf);
          buf = s;
        } else {
          buf += s;
        }
      });
      if (buf.trim()) out.push(buf);
    });
    return out.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /** 在自然边界截断：优先段落，其次句末，最后硬切；附带省略号标记。 */
  function truncateText(input, max) {
    var text = String(input || "");
    var limit = Number(max) || 0;
    if (!limit || text.length <= limit) return text;
    var head = text.slice(0, limit);
    var cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("。"), head.lastIndexOf(". "));
    if (cut < limit * 0.6) cut = limit;
    return head.slice(0, cut).replace(/[\s,，;；:：]+$/, "") + "…";
  }

  function textOf(el) {
    if (!el) return "";
    if (typeof el.innerText === "string" && el.innerText) return el.innerText;
    return el.textContent || "";
  }

  /** 选出正文容器：按可见文本长度打分，取最长者（article/main 通常胜出）。 */
  function pickRoot(doc) {
    var best = null;
    var bestScore = 0;
    CANDIDATES.forEach(function (sel) {
      var el = null;
      try { el = doc.querySelector(sel); } catch (e) { el = null; }
      if (!el) return;
      var score = textOf(el).length;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best || doc.body || null;
  }

  function shouldSkip(node) {
    try {
      return !!(node.closest && node.closest(SKIP));
    } catch (e) {
      return false;
    }
  }

  /** 抽取标题 + 正文；重复行（页眉页脚、导航残片）按相邻去重。 */
  function extractFromDocument(doc) {
    var out = { title: "", url: "", text: "", chars: 0, paragraphs: 0 };
    if (!doc) return out;
    out.title = String(doc.title || "").trim();
    try { out.url = (doc.location && doc.location.href) || ""; } catch (e) { out.url = ""; }

    var rootEl = pickRoot(doc);
    if (!rootEl) return out;

    var nodes = [];
    try { nodes = rootEl.querySelectorAll(BLOCKS) || []; } catch (e) { nodes = []; }

    var lines = [];
    var last = "";
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || shouldSkip(node)) continue;
      var text = normalizeText(textOf(node)).replace(/\n+/g, " ");
      if (!text || text.length < 2) continue;
      if (text === last) continue;
      last = text;
      lines.push(text);
    }

    out.text = normalizeText(lines.join("\n\n")).slice(0, 120000);
    out.chars = out.text.length;
    out.paragraphs = lines.length;
    return out;
  }

  var api = {
    normalizeText: normalizeText,
    paragraphize: paragraphize,
    truncateText: truncateText,
    pickRoot: pickRoot,
    extractFromDocument: extractFromDocument,
  };

  root.PPTextLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
