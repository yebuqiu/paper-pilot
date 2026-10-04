"use strict";

/**
 * 结构化导出：JSON / JSONL / CSV / BibTeX。
 *
 * 纪律：
 *   - CSV 严格按 RFC 4180 转义（含 `,` `"` 换行 的字段必须加引号、内部引号翻倍）；
 *   - 默认写 UTF-8 BOM —— 不加 BOM 时 Excel（Windows 中文环境）会把 UTF-8 中文标题显示成乱码，
 *     这是「输出给非技术用户」场景里最高频的抱怨；
 *   - 导出**保留完整字段**（含摘要、版本、DOI、期刊引用），截断只发生在可读报告侧。
 */

const CSV_COLUMNS = [
  { key: "arxivId", header: "arxiv_id" },
  { key: "version", header: "version" },
  { key: "title", header: "title" },
  { key: "authors", header: "authors" },
  { key: "primaryCategory", header: "primary_category" },
  { key: "categories", header: "categories" },
  { key: "published", header: "published" },
  { key: "updated", header: "updated" },
  { key: "doi", header: "doi" },
  { key: "journalRef", header: "journal_ref" },
  { key: "comment", header: "comment" },
  { key: "absUrl", header: "abs_url" },
  { key: "pdfUrl", header: "pdf_url" },
  { key: "summary", header: "abstract" },
];

/** 归一化输入：接受 {entries:[...]} 或数组。 */
function toEntries(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.entries)) return data.entries;
  return [];
}

function num(v, digits) {
  const n = Number(v);
  if (!isFinite(n)) return v;
  const p = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(n * p) / p;
}

/** 展平成导出行（数组字段用分隔符连接）。 */
function flattenEntry(e, opts) {
  const o = opts || {};
  const sep = o.arraySeparator || "; ";
  const row = {};
  for (const c of CSV_COLUMNS) {
    const v = e[c.key];
    if (Array.isArray(v)) row[c.key] = v.join(sep);
    else if (v == null) row[c.key] = "";
    else row[c.key] = String(v);
  }
  if (e.counts != null) row.counts = String(e.counts);
  return row;
}

/** RFC 4180 单元格转义。 */
function csvCell(value, delimiter) {
  const s = value == null ? "" : String(value);
  const d = delimiter || ",";
  const needQuote = s.indexOf('"') >= 0 || s.indexOf(d) >= 0 || /[\r\n]/.test(s) || /^\s|\s$/.test(s);
  if (!needQuote) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * @param {object|Array} data
 * @param {{columns?:string[], delimiter?:string, bom?:boolean, crlf?:boolean, arraySeparator?:string}} [opts]
 */
function toCSV(data, opts) {
  const o = opts || {};
  const entries = toEntries(data);
  const delim = o.delimiter || ",";
  const cols = (o.columns && o.columns.length ? o.columns : CSV_COLUMNS.map((c) => c.key));
  const headerMap = new Map(CSV_COLUMNS.map((c) => [c.key, c.header]));

  const lines = [];
  lines.push(cols.map((c) => csvCell(headerMap.get(c) || c, delim)).join(delim));
  for (const e of entries) {
    const row = flattenEntry(e, o);
    lines.push(cols.map((c) => csvCell(row[c], delim)).join(delim));
  }
  const eol = o.crlf ? "\r\n" : "\n";
  const body = lines.join(eol) + eol;
  const bom = o.bom === false ? "" : "\uFEFF";
  return bom + body;
}

/** JSON（默认 2 空格缩进）。 */
function toJSON(data, opts) {
  const o = opts || {};
  return JSON.stringify(data, null, o.pretty === false ? 0 : 2);
}

/** JSONL：每行一条条目，适合流式/大数据量管道处理。 */
function toJSONL(data) {
  return toEntries(data).map((e) => JSON.stringify(e)).join("\n") + (toEntries(data).length ? "\n" : "");
}

/** BibTeX 转义。 */
function bibEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 生成 BibTeX。
 * 已发表（有 journal_ref）用 @article，否则 @misc（预印本惯例）。
 * @param {object|Array} data
 * @param {{keyPrefix?:string, includeAbstract?:boolean}} [opts]
 */
function toBibTeX(data, opts) {
  const o = opts || {};
  const prefix = o.keyPrefix || "arxiv";
  const entries = toEntries(data);
  const out = [];
  for (const e of entries) {
    const id = e.arxivId || e.baseId || "unknown";
    const key = prefix + id.replace(/[^A-Za-z0-9]/g, "");
    const type = e.journalRef ? "article" : "misc";
    const fields = [];
    if (e.title) fields.push(["title", "{" + bibEscape(e.title) + "}"]);
    if (e.authors && e.authors.length) fields.push(["author", e.authors.map(bibEscape).join(" and ")]);
    if (e.journalRef) fields.push(["journal", bibEscape(e.journalRef)]);
    const year = String(e.published || "").slice(0, 4);
    if (year) fields.push(["year", year]);
    if (e.primaryCategory) fields.push(["primaryClass", e.primaryCategory]);
    if (e.doi) fields.push(["doi", e.doi]);
    if (e.absUrl) fields.push(["url", e.absUrl]);
    fields.push(["eprint", id]);
    fields.push(["archivePrefix", "arXiv"]);
    if (e.comment) fields.push(["note", bibEscape(e.comment)]);
    if (o.includeAbstract && e.summary) fields.push(["abstract", "{" + bibEscape(e.summary) + "}"]);

    out.push("@" + type + "{" + key + ",\n" +
      fields.map(([k, v]) => "  " + k + " = {" + v + "}").join(",\n") +
      "\n}");
  }
  return out.join("\n\n") + (out.length ? "\n" : "");
}

/** 统计数字格式化（导出给报告用）。 */
function round2(v) { return num(v, 2); }

module.exports = { toJSON, toJSONL, toCSV, toBibTeX, toEntries, flattenEntry, csvCell, CSV_COLUMNS, bibEscape, round2 };
