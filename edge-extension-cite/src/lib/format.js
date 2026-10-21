// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 五种输出版式：GB/T 7714-2015、APA 7、MLA 9、BibTeX、RIS。
 * BibTeX / RIS 复用 RefFormat（插件同源的纯函数实现），避免两套序列化规则漂移。
 */

import { initials, normalizeDoi } from "./record.js";

const GBT_CODE = {
  journalArticle: "J",
  conferencePaper: "C",
  bookSection: "M",
  book: "M",
  thesis: "D",
  report: "R",
  preprint: "J/OL",
  webpage: "EB/OL",
  dataset: "DB",
};

function hasCJK(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function tidy(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function endDot(text) {
  const s = tidy(text).replace(/[.。]+$/, "");
  return s ? s + "." : "";
}

function gbtName(a) {
  if (!a) return "";
  if (a.literal) return a.literal;
  const ini = initials(a.given);
  return [a.family, ini].filter(Boolean).join(" ");
}

function gbtAuthors(record) {
  const names = (record.authors || []).map(gbtName).filter(Boolean);
  if (!names.length) return "";
  const zh = hasCJK(names.join(""));
  const shown = names.length > 3 ? names.slice(0, 3) : names;
  let text = shown.join(", ");
  if (names.length > 3) text += zh ? ", 等" : ", et al";
  return text.replace(/[.。]+$/, "") + ".";
}

function apaName(a) {
  if (!a) return "";
  if (a.literal) return a.literal;
  const ini = initials(a.given);
  return a.family + (ini ? ", " + ini : "");
}

function apaAuthors(record) {
  const names = (record.authors || []).map(apaName).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ", & " + names[1];
  if (names.length <= 20) return names.slice(0, -1).join(", ") + ", & " + names[names.length - 1];
  return names.slice(0, 19).join(", ") + ", … " + names[names.length - 1];
}

function mlaName(a) {
  if (!a) return "";
  if (a.literal) return a.literal;
  return a.given ? a.family + ", " + a.given : a.family;
}

function mlaAuthors(record) {
  const names = (record.authors || []).map(mlaName).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ", and " + names[1];
  return names[0] + ", et al";
}

function doiUrl(record) {
  const doi = normalizeDoi(record.doi);
  if (!doi) return "";
  return "https://doi.org/" + doi;
}

function journalTail(record) {
  const bits = [record.container];
  if (record.year) bits.push(record.year);
  return bits.filter(Boolean).join(", ");
}

/** GB/T 7714-2015（顺序编码制正文里用的那条）。 */
export function formatGBT(record) {
  const title = tidy(record.title);
  if (!title) return "";
  const authors = gbtAuthors(record);
  const code = GBT_CODE[record.itemType] || "J";
  const prefix = authors ? authors + " " : "";

  let body = "";
  if (record.itemType === "book" || record.itemType === "bookSection") {
    const pub = [record.place, record.publisher].filter(Boolean).join(": ");
    body = [title + "[M]", pub, record.year].filter(Boolean).join(". ");
    body = endDot(body);
  } else if (record.itemType === "thesis") {
    const pub = [record.place, record.publisher].filter(Boolean).join(": ");
    body = endDot([title + "[D]", pub, record.year].filter(Boolean).join(". "));
  } else if (record.itemType === "conferencePaper") {
    const pub = [record.place, record.publisher].filter(Boolean).join(": ");
    const tail = [pub, record.year].filter(Boolean).join(", ");
    body = title + "[C]//" + [record.container, tail].filter(Boolean).join(". ");
    if (record.pages) body += ": " + record.pages;
    body = endDot(body);
  } else if (record.itemType === "preprint") {
    const link = record.url || doiUrl(record);
    body = endDot([title + "[J/OL]", journalTail(record)].filter(Boolean).join(". ") + (link ? ". " + link : ""));
  } else {
    let tail = journalTail(record);
    if (record.volume) tail += ", " + record.volume;
    if (record.issue) tail += "(" + record.issue + ")";
    if (record.pages) tail += ": " + record.pages;
    body = endDot(title + "[J]. " + tail);
  }

  let out = prefix + body;
  const doi = normalizeDoi(record.doi);
  if (doi && !out.includes("doi.org")) {
    if (!/[.。]$/.test(out)) out += ".";
    out += " DOI:" + doi + ".";
  }
  return tidy(out);
}

/** APA 7th：作者 (年). 题名. 刊名, 卷(期), 页. https://doi.org/... */
export function formatAPA(record) {
  const title = tidy(record.title);
  if (!title) return "";
  const authors = apaAuthors(record);
  const year = record.year || "n.d.";
  const head = (authors ? authors + " " : "") + "(" + year + "). " + endDot(title);

  let tail = "";
  if (record.itemType === "book") {
    tail = [record.publisher, doiUrl(record)].filter(Boolean).join(". ");
  } else if (record.itemType === "thesis") {
    tail = [record.publisher, doiUrl(record)].filter(Boolean).join(". ");
  } else {
    let source = record.container || "";
    if (record.volume) source += (source ? ", " : "") + record.volume;
    if (record.issue) source += "(" + record.issue + ")";
    if (record.pages) source += (source ? ", " : "") + record.pages;
    tail = [source, doiUrl(record) || record.url].filter(Boolean).join(". ");
  }
  return tidy(head + " " + (tail ? endDot(tail) : ""));
}

/** MLA 9th：作者. "题名." 刊名, vol. 卷, no. 期, 年, pp. 页. */
export function formatMLA(record) {
  const title = tidy(record.title);
  if (!title) return "";
  const authors = mlaAuthors(record);
  const head = authors ? authors + ". " : "";

  if (record.itemType === "book" || record.itemType === "thesis") {
    return tidy(head + endDot(title) + " " + endDot([record.publisher, record.year].filter(Boolean).join(", ")));
  }

  const quoted = '"' + title.replace(/\.$/, "") + '."';
  const bits = [record.container];
  if (record.volume) bits.push("vol. " + record.volume);
  if (record.issue) bits.push("no. " + record.issue);
  if (record.year) bits.push(record.year);
  if (record.pages) bits.push("pp. " + record.pages);
  let out = head + quoted + (bits.filter(Boolean).length ? " " + endDot(bits.filter(Boolean).join(", ")) : "");
  const link = doiUrl(record) || record.url;
  if (link) out += " " + link + ".";
  return tidy(out);
}

/** BibTeX / RIS 交给 RefFormat；调用方传入 window.RefFormat（插件同源实现）。 */
export function formatBibtex(record, refFormat) {
  const rf = refFormat || globalThis.RefFormat;
  if (!rf) throw new Error("BibTeX 组件未加载");
  return rf.toBibtex([record]).trim();
}

export function formatRIS(record, refFormat) {
  const rf = refFormat || globalThis.RefFormat;
  if (!rf) throw new Error("RIS 组件未加载");
  return rf.toRIS([record]).trim();
}

export const FORMATS = [
  { id: "gbt", label: "GB/T 7714", render: (r) => formatGBT(r) },
  { id: "apa", label: "APA 7", render: (r) => formatAPA(r) },
  { id: "mla", label: "MLA 9", render: (r) => formatMLA(r) },
  { id: "bibtex", label: "BibTeX", render: (r) => formatBibtex(r) },
  { id: "ris", label: "RIS", render: (r) => formatRIS(r) },
];

export function formatAll(record) {
  const out = {};
  for (const f of FORMATS) {
    try {
      out[f.id] = f.render(record);
    } catch (e) {
      out[f.id] = "";
    }
  }
  return out;
}
