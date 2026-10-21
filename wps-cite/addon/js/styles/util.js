// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 样式渲染公共工具：作者名、年份、页码、类型标识 */
(function (root) {
  "use strict";

  const CJK = /[\u3400-\u9fff]/;

  const isCJK = (s) => CJK.test(String(s || ""));

  /** Zotero 的 date 字段形如 "2020-05-01" / "2020" / "2020-05" / 空 */
  function year(item) {
    const raw = String((item && item.date) || "");
    const m = /(\d{4})/.exec(raw);
    if (m) return m[1];
    const d = String((item && item.issued) || "");
    const m2 = /(\d{4})/.exec(d);
    return m2 ? m2[1] : "n.d.";
  }

  /** 名首字母：San → S. / San-He → S. H. */
  function initials(firstName) {
    return String(firstName || "")
      .split(/[\s.\-]+/)
      .filter(Boolean)
      .map((w) => (isCJK(w) ? w : w[0].toUpperCase() + "."))
      .join(" ");
  }

  /** 正文里只写姓：中文全名，西文只留姓（APA 正文不放首字母） */
  function surnameOnly(c) {
    if (!c) return "";
    if (c.name) return String(c.name).trim();
    const last = String(c.lastName || "").trim();
    const first = String(c.firstName || "").trim();
    if (!last) return first;
    if (first && isCJK(last + first)) return last + first;
    return last;
  }

  /** 单个作者：中文用全名；西文用 "LASTNAME I." */
  function oneCreator(c, style) {
    if (!c) return "";
    if (c.name) return String(c.name).trim();                 // 单字段模式
    const last = String(c.lastName || "").trim();
    const first = String(c.firstName || "").trim();
    if (!last) return first;
    if (first && isCJK(last + first)) return last + first;    // 中文：姓前名后直接拼
    if (!first) return last;
    if (style === "gb") return last.toUpperCase() + " " + initials(first);
    return last + ", " + initials(first);                     // APA
  }

  function creators(item, style, sep) {
    const list = (item && item.creators) || [];
    const people = list.filter((c) => c && (c.creatorType === "author" || !c.creatorType));
    const use = people.length ? people : list;
    return use.map((c) => oneCreator(c, style)).filter(Boolean).join(sep);
  }

  /** GB/T 7714：≤3 全列；>3 列前 3 + 等 / et al. */
  function gbCreators(item) {
    const list = ((item && item.creators) || []).filter(
      (c) => c && (c.creatorType === "author" || !c.creatorType));
    const names = list.map((c) => oneCreator(c, "gb")).filter(Boolean);
    if (!names.length) return "";
    const zh = isCJK(names.join(""));
    if (names.length <= 3) return names.join(", ");
    return names.slice(0, 3).join(", ") + (zh ? ", 等" : ", et al");
  }

  /** APA：≤2 用 & 连接；≥3 只留第一个 + et al.（正文），文献表最多 20 个 */
  function apaShort(item) {
    const list = ((item && item.creators) || []).filter(
      (c) => c && (c.creatorType === "author" || !c.creatorType));
    const names = list.map((c) => surnameOnly(c)).filter(Boolean);
    if (!names.length) return "";
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + " & " + names[1];
    return names[0] + " et al.";
  }

  function apaFull(item) {
    const list = ((item && item.creators) || []).filter(
      (c) => c && (c.creatorType === "author" || !c.creatorType));
    const names = list.map((c) => oneCreator(c, "apa")).filter(Boolean).slice(0, 20);
    if (!names.length) return "";
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + ", & " + names[names.length - 1];
  }

  /** 页码规范化：45-67 → 45–67；单个 45 */
  function pages(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    return s.replace(/\s*[-~—]\s*/g, "–");
  }

  const TYPE = {
    journalArticle: { gb: "J", apa: "article" },
    book: { gb: "M", apa: "book" },
    bookSection: { gb: "M", apa: "chapter" },
    thesis: { gb: "D", apa: "thesis" },
    conferencePaper: { gb: "C", apa: "paper" },
    report: { gb: "R", apa: "report" },
    standard: { gb: "S", apa: "standard" },
    patent: { gb: "P", apa: "patent" },
    webpage: { gb: "EB/OL", apa: "web" },
    preprint: { gb: "EB/OL", apa: "preprint" },
    manuscript: { gb: "Z", apa: "manuscript" },
  };

  const typeOf = (item) => (TYPE[item && item.itemType] || { gb: "Z", apa: "misc" });

  /** 去掉尾部标点，避免出现 ".." */
  const trimEnd = (s) => String(s || "").replace(/[\s.,;:，。；：]+$/, "");

  const api = {
    isCJK, year, initials, oneCreator, surnameOnly, creators, gbCreators, apaShort, apaFull,
    pages, typeOf, trimEnd,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PPUtil = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
