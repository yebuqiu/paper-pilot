// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 元数据归一：把页面上的 citation_* meta、JSON-LD、URL 线索合成一份记录。
 * 纯函数，不碰 DOM 也不发请求，可直接单测。
 */

const TYPE_MAP = {
  "journal-article": "journalArticle",
  "proceedings-article": "conferencePaper",
  "book-chapter": "bookSection",
  "book": "book",
  "monograph": "book",
  "dissertation": "thesis",
  "posted-content": "preprint",
  "report": "report",
  "dataset": "dataset",
};

const SITE_SUFFIX = [
  " - ScienceDirect",
  " | SpringerLink",
  " - PubMed",
  " | Nature",
  " - Wiley Online Library",
  " | IEEE Xplore",
  " - arXiv",
];

function clean(input) {
  return String(input == null ? "" : input)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDoi(input) {
  return clean(input)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;:)\]}'"]+$/, "")
    .trim();
}

export function initials(given) {
  const parts = clean(given).split(/[\s.-]+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.map((p) => p[0].toUpperCase() + ".").join(" ");
}

/** 支持 "Family, Given" / "Given Family" / "Smith J" / 中文姓名。 */
export function parseAuthorName(input) {
  const t = clean(input);
  if (!t) return null;

  if (t.includes(",")) {
    const idx = t.indexOf(",");
    const family = t.slice(0, idx).trim();
    const given = t.slice(idx + 1).trim();
    if (!family) return null;
    return given ? { family, given } : { literal: family };
  }

  if (!/\s/.test(t)) {
    if (/[\u4e00-\u9fff]/.test(t)) return { literal: t };
    return { literal: t };
  }

  const parts = t.split(/\s+/);
  // "Smith J" / "Smith JA"：末尾是缩写，首段是姓
  if (parts.length === 2 && /^[A-Z]{1,4}$/.test(parts[1])) {
    return { family: parts[0], given: parts[1] };
  }

  const family = parts[parts.length - 1];
  const given = parts.slice(0, -1).join(" ");
  return { family, given };
}

function firstYear(value) {
  const m = String(value || "").match(/(1[5-9]\d{2}|20\d{2}|2100)/);
  return m ? m[1] : "";
}

function splitPages(value) {
  const s = clean(value).replace(/[–—]/g, "-");
  if (!s) return "";
  return s.replace(/\s*-\s*/, "-");
}

function mapType(kind, rawType) {
  const t = clean(rawType || kind).toLowerCase();
  if (TYPE_MAP[t]) return TYPE_MAP[t];
  if (/journal|article/.test(t) && !/proceedings|conference/.test(t)) return "journalArticle";
  if (/conference|proceedings/.test(t)) return "conferencePaper";
  if (/chapter/.test(t)) return "bookSection";
  if (/book|monograph/.test(t)) return "book";
  if (/thesis|dissertation/.test(t)) return "thesis";
  if (/preprint|posted/.test(t)) return "preprint";
  if (/report/.test(t)) return "report";
  return "journalArticle";
}

function pickJsonLd(list) {
  const items = Array.isArray(list) ? list : [];
  const wanted = /(scholarlyarticle|article|book|chapter|thesis|report|preprint)/i;
  return items.find((x) => x && wanted.test(String(x["@type"] || ""))) || items[0] || null;
}

function jsonLdAuthors(node) {
  const raw = node && node.author;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const a of list) {
    if (!a) continue;
    if (typeof a === "string") {
      const parsed = parseAuthorName(a);
      if (parsed) out.push(parsed);
      continue;
    }
    if (a.familyName || a.givenName) {
      out.push({ family: clean(a.familyName), given: clean(a.givenName) });
    } else if (a.name) {
      const parsed = parseAuthorName(a.name);
      if (parsed) out.push(parsed);
    }
  }
  return out.filter((a) => a.family || a.literal);
}

function dedupeAuthors(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = (a.family || "") + "|" + (a.given || "") + "|" + (a.literal || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function normalizeRecord(raw) {
  const data = raw || {};
  const meta = data.meta || {};
  const node = pickJsonLd(data.jsonld);
  const partOf = (node && node.isPartOf) || {};

  const arxivId = clean(data.arxivId || meta.arxivId).replace(/v\d+$/i, "");
  let title = clean(meta.title || (node && (node.name || node.headline)));
  if (!title) {
    title = clean(data.pageTitle || "");
    for (const suffix of SITE_SUFFIX) {
      if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    }
  }

  let authors = [];
  const metaAuthors = meta.authors || [];
  for (const a of metaAuthors) {
    const parsed = parseAuthorName(a);
    if (parsed) authors.push(parsed);
  }
  if (!authors.length) authors = jsonLdAuthors(node);
  authors = dedupeAuthors(authors);

  const date = clean(meta.date || (node && node.datePublished));
  const container = clean(
    meta.journal ||
    meta.conference ||
    (partOf && (partOf.name || partOf["@id"])) ||
    (arxivId ? "arXiv" : "")
  );

  const pages = clean(
    meta.pages ||
    [meta.firstpage, meta.lastpage].filter(Boolean).join("-") ||
    [node && node.pageStart, node && node.pageEnd].filter(Boolean).join("-")
  );

  const explicitType = clean(meta.type || (node && node["@type"]));
  const itemType = arxivId ? "preprint" : mapType("", explicitType);

  const record = {
    source: ["page"],
    title,
    authors,
    year: firstYear(date || meta.year),
    date,
    container,
    volume: clean(meta.volume || (partOf && partOf.volumeNumber)),
    issue: clean(meta.issue || (partOf && partOf.issueNumber)),
    pages: splitPages(pages),
    publisher: clean(meta.publisher || (node && node.publisher && (node.publisher.name || node.publisher))),
    place: clean(meta.place),
    issn: clean(meta.issn),
    isbn: clean(meta.isbn),
    doi: normalizeDoi(meta.doi || (node && node.doi) || data.doiFromText),
    pmid: clean(meta.pmid),
    arxivId,
    url: clean(data.url || meta.url),
    language: clean(data.lang).slice(0, 8),
    itemType,
    abstract: clean(meta.abstract || (node && node.abstract)),
  };

  record.hasCoreFields = !!(record.title && (record.container || record.doi || record.isbn || record.arxivId));
  return record;
}

/** 用 Crossref 的 message 对象补齐空缺字段（不覆盖页面已有值）。 */
export function applyCrossref(record, message) {
  if (!record || !message) return record;
  const msg = message;
  const fill = (key, value) => {
    if ((record[key] === undefined || record[key] === null || record[key] === "") && value) record[key] = value;
  };

  const title = Array.isArray(msg.title) ? msg.title[0] : msg.title;
  fill("title", clean(title));
  if (!record.authors || !record.authors.length) {
    const list = (msg.author || []).map((a) => ({
      family: clean(a.family),
      given: clean(a.given),
      literal: clean(a.name),
    })).filter((a) => a.family || a.literal);
    if (list.length) record.authors = dedupeAuthors(list);
  }
  fill("container", clean(Array.isArray(msg["container-title"]) ? msg["container-title"][0] : msg["container-title"]));
  fill("volume", clean(msg.volume));
  fill("issue", clean(msg.issue));
  fill("pages", splitPages(msg.page));
  fill("publisher", clean(msg.publisher));
  fill("issn", clean(Array.isArray(msg.ISSN) ? msg.ISSN[0] : msg.ISSN));
  fill("isbn", clean(Array.isArray(msg.ISBN) ? msg.ISBN[0] : msg.ISBN));
  fill("url", clean(msg.URL));
  fill("doi", normalizeDoi(msg.DOI));
  const issued = msg.issued && msg.issued["date-parts"] && msg.issued["date-parts"][0];
  if (issued && issued.length) {
    fill("year", String(issued[0]));
    if (!record.date) record.date = issued.map((n, i) => (i ? String(n).padStart(2, "0") : String(n))).join("-");
  }
  const type = mapType("", msg.type);
  if (record.itemType === "journalArticle" && type && type !== "journalArticle") record.itemType = type;
  record.source = Array.from(new Set([...(record.source || []), "crossref"]));
  record.hasCoreFields = !!(record.title && (record.container || record.doi || record.isbn || record.arxivId));
  return record;
}
