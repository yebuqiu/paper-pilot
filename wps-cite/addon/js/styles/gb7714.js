// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* GB/T 7714-2015 · 顺序编码制
 *
 * 正文：按首次出现顺序编号，写作 [1]、[1,3]、[1-3]（连续 ≥3 篇才压成区间）。
 * 文献表：按编号排列，条目格式按文献类型分派。
 *
 * 已知简化（都在 README 的"样式覆盖边界"里列了）：
 *   - 不处理析出文献的"//"主编说明；
 *   - 电子资源只给 URL/DOI，不给"引用日期"（日期不稳定的场景少）；
 *   - 西文姓全大写（GB/T 7714 的常见排版惯例），名字只留首字母。
 */
(function (root) {
  "use strict";
  const U = root.PPUtil || require("./util.js");

  /** 连续编号压缩：1,2,3,7 → "1-3,7" */
  function compress(seqs) {
    const a = [...new Set(seqs)].sort((x, y) => x - y);
    const out = [];
    for (let i = 0; i < a.length; i++) {
      let j = i;
      while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
      out.push(j - i >= 2 ? `${a[i]}-${a[j]}` : a.slice(i, j + 1).join(","));
      i = j;
    }
    return out.join(",");
  }

  /** 正文引文：items = [{seq, locator}] */
  function cite(items) {
    if (!items || !items.length) return "";
    const seqs = items.map((x) => x.seq);
    const locs = items.map((x) => (x.locator ? String(x.locator).trim() : "")).filter(Boolean);
    const core = compress(seqs);
    // 只有一条引文且带页码时写 [3]7（GB/T 7714 页码可后置）
    if (items.length === 1 && locs.length === 1) return `[${core}]${locs[0]}`;
    return `[${core}]`;
  }

  function oneEntry(item, seq, locator) {
    const t = U.typeOf(item);
    const author = U.gbCreators(item) || U.trimEnd(item.title);
    const title = U.trimEnd(item.title);
    const y = U.year(item);
    const pg = U.pages(item.pages);
    const loc = locator ? String(locator).trim() : "";
    const parts = [];

    switch (item.itemType) {
      case "journalArticle":
        parts.push(`${author}. ${title}[${t.gb}]. ${U.trimEnd(item.publicationTitle)}`);
        parts.push([y, item.volume ? `${item.volume}${item.issue ? `(${item.issue})` : ""}` : ""]
          .filter(Boolean).join(", "));
        if (pg || loc) parts.push(`${pg || loc}`);
        break;
      case "book":
        parts.push(`${author}. ${title}[${t.gb}]`);
        if (item.edition) parts.push(`${item.edition}版`);
        parts.push(`${U.trimEnd(item.place || "出版地不详")}: ${U.trimEnd(item.publisher || "出版者不详")}, ${y}`);
        if (pg || loc) parts.push(`${pg || loc}`);
        break;
      case "thesis":
        parts.push(`${author}. ${title}[${t.gb}]. ${U.trimEnd(item.place || "")}`);
        parts.push(`${U.trimEnd(item.university || item.publisher || "学校不详")}, ${y}`);
        break;
      case "conferencePaper":
        parts.push(`${author}. ${title}[${t.gb}]`);
        if (item.proceedingsTitle) parts.push(`//${U.trimEnd(item.proceedingsTitle)}`);
        parts.push(`${U.trimEnd(item.place || "")}: ${U.trimEnd(item.publisher || "")}, ${y}`);
        if (pg) parts.push(pg);
        break;
      case "report":
        parts.push(`${author}. ${title}[${t.gb}]. ${U.trimEnd(item.place || "")}`);
        parts.push(`${U.trimEnd(item.institution || item.publisher || "")}, ${y}`);
        break;
      case "webpage":
      case "preprint":
        parts.push(`${author}. ${title}[${t.gb}]`);
        parts.push(`(${y})`);
        if (item.url) parts.push(item.url);
        else if (item.DOI) parts.push(`https://doi.org/${item.DOI}`);
        break;
      default:
        parts.push(`${author}. ${title}[${t.gb}]`);
        parts.push(`${U.trimEnd(item.place || "")}: ${U.trimEnd(item.publisher || "")}, ${y}`);
    }

    let s = parts.filter((x) => x !== "" && x != null).join(". ")
      .replace(/\.\s*\./g, ".")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!/[.。]$/.test(s)) s += ".";
    return `[${seq}] ${s}`;
  }

  /** entries = [{seq, item, locator}]，按 seq 升序输出 */
  function bib(entries) {
    return [...entries]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => oneEntry(e.item, e.seq, e.locator));
  }

  const api = { id: "gb7714", label: "GB/T 7714-2015（顺序编码制）", numeric: true, compress, cite, bib };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PPStyleGB = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
