// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* APA 7th · 作者-年制
 * 正文：(Zhang, 2020)、(Zhang & Li, 2020)、(Zhang et al., 2020)，多篇用 "; " 分隔，带页码加 ", p. 7"。
 * 文献表：按作者字母序（同作者按年份），作者列表最多 20 人。
 */
(function (root) {
  "use strict";
  const U = root.PPUtil || require("./util.js");

  function oneCite(e) {
    const who = U.apaShort(e.item) || U.trimEnd(e.item.title);
    const y = U.year(e.item);
    const loc = e.locator
      ? ", " + (/^\d+$/.test(String(e.locator).trim()) ? "p. " : "pp. ") + String(e.locator).trim()
      : "";
    return `${who}, ${y}${loc}`;
  }

  /** items = [{item, locator}]：同一处多篇按作者排序后用 "; " 连接 */
  function cite(items) {
    if (!items || !items.length) return "";
    const parts = [...items].sort((a, b) =>
      (U.apaShort(a.item) || "").localeCompare(U.apaShort(b.item) || "", "en"));
    return "(" + parts.map(oneCite).join("; ") + ")";
  }

  function oneEntry(item) {
    const who = U.apaFull(item) || U.trimEnd(item.title);
    const y = U.year(item);
    const title = U.trimEnd(item.title);
    const pg = U.pages(item.pages);
    let body = "";

    switch (item.itemType) {
      case "journalArticle": {
        const vol = item.volume ? `, ${item.volume}` : "";
        const iss = item.issue ? `(${item.issue})` : "";
        body = `${title}. ${U.trimEnd(item.publicationTitle)}${vol}${iss}` +
          (pg ? `, ${pg}` : "") + ".";
        break;
      }
      case "book":
        body = `${title}. ${U.trimEnd(item.publisher || "")}.`;
        break;
      case "bookSection":
        body = `${title}. In ${U.trimEnd(item.bookTitle || item.proceedingsTitle || "")}` +
          (pg ? ` (pp. ${pg})` : "") + `. ${U.trimEnd(item.publisher || "")}.`;
        break;
      case "thesis":
        body = `${title} [${/master/i.test(item.thesisType || "") ? "Master's thesis" : "Doctoral dissertation"}]. ` +
          `${U.trimEnd(item.university || item.publisher || "")}.`;
        break;
      case "conferencePaper":
        body = `${title} [Paper presentation]. ${U.trimEnd(item.proceedingsTitle || "")}` +
          (item.place ? `, ${U.trimEnd(item.place)}` : "") + ".";
        break;
      case "report":
        body = `${title}. ${U.trimEnd(item.institution || item.publisher || "")}.`;
        break;
      case "webpage":
      case "preprint":
        body = `${title}.` + (item.url ? ` ${item.url}` : "");
        break;
      default:
        body = `${title}. ${U.trimEnd(item.publisher || "")}.`;
    }

    const doi = item.DOI ? ` https://doi.org/${item.DOI}` : "";
    return `${who} (${y}). ${body.replace(/\s{2,}/g, " ").trim()}${doi}`.replace(/\s+\./g, ".");
  }

  /** entries = [{item}]：字母序；同作者按年份升序 */
  function bib(entries) {
    const sorted = [...entries].sort((a, b) => {
      const ka = (U.apaFull(a.item) || "").toLowerCase();
      const kb = (U.apaFull(b.item) || "").toLowerCase();
      if (ka !== kb) return ka.localeCompare(kb, "en");
      return U.year(a.item).localeCompare(U.year(b.item));
    });
    return sorted.map((e) => oneEntry(e.item));
  }

  const api = { id: "apa", label: "APA 7th（作者-年制）", numeric: false, cite, bib };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PPStyleAPA = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
