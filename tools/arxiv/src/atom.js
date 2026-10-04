"use strict";

/**
 * arXiv Atom 响应解析（纯函数，零依赖，可离线单测）。
 *
 * 为什么手写正则解析而不是引入 XML 库：本仓库的硬约束是「零第三方依赖」，而 arXiv 的
 * Atom 输出结构稳定（feed/entry/title/summary/author/category/link + arxiv: 扩展）。
 * 关键复杂度不在通用 XML 上，而在 arXiv 特有的坑：
 *
 *   1. **错误响应也是 200/400 + Atom**：新版后端（2025-11 迁移）对畸形查询返回 HTTP 400
 *      且 body 是一个 `<entry><id>...#errors#...</id><title>Error</title>`。若不识别，
 *      会被当成「0 条结果」，比报错更难排查。
 *   2. **标题/摘要会被硬换行**：迁移前按 80 字符折行，迁移后仍可能保留段落换行。
 *      因此同时给出「压平后 summary」与「按段落拆分的 summaryParagraphs」。
 *   3. **id 带版本号**：`http://arxiv.org/abs/2610.01889v2`，去重必须按 **不带版本** 的 baseId 归并，
 *      并保留版本号更高的那条。
 *   4. **作者可能有机构**：`<author><name>X</name><arxiv:affiliation>Y</arxiv:affiliation></author>`，
 *      必须在 `<author>` 块内匹配，否则会把全体机构串到一起。
 *   5. **XML 实体必须单遍解码**：多遍替换会让 `&amp;lt;` 被错误解成 `<`。
 */

const { ParseError, ApiError } = require("./errors");

/** 单遍 XML 实体解码（顺序无关，避免二次解码）。 */
function decodeEntities(s) {
  const str = String(s == null ? "" : s);
  if (str.indexOf("&") < 0) return str;
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (m, g) => {
    switch (g) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "nbsp": return " ";
      default:
        if (g[0] === "#") {
          const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
          if (isFinite(code) && code > 0 && code <= 0x10ffff) {
            try { return String.fromCodePoint(code); } catch (e) { return m; }
          }
        }
        return m;
    }
  });
}

/** 取出第一个 `<tag ...>...</tag>` 的内层原文（不解码）。 */
function tagRaw(block, tag) {
  const m = String(block).match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "i"));
  return m ? m[1] : "";
}

/** 取出并解码 + 压平空白的标签文本。 */
function tagText(block, tag) {
  const raw = tagRaw(block, tag);
  return cleanText(decodeEntities(raw));
}

/** 自闭合标签 `&lt;tag .../&gt;` 的属性表。 */
function selfClosed(block, tag) {
  const out = [];
  const re = new RegExp("<" + tag + "\\b([^>]*?)/?>", "gi");
  let m;
  while ((m = re.exec(String(block))) !== null) {
    if (m[0].indexOf("</") === 0) continue;
    out.push(parseAttrs(m[1]));
  }
  return out;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(s))) !== null) attrs[m[1]] = decodeEntities(m[2]);
  return attrs;
}

/** 压平空白：所有连续空白（含换行）折叠为单个空格。 */
function cleanText(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

/**
 * 按段落拆分（保留 arXiv 摘要里的自然段）。
 * 先按换行切，再对每行压平空白；过滤空段。
 */
function splitParagraphs(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((x) => cleanText(x))
    .filter(Boolean);
}

/** 从 abs URL / id 中剥离版本号与 ID。 */
function parseArxivId(idOrUrl) {
  const s = String(idOrUrl == null ? "" : idOrUrl).trim();
  // 新版（2007-04 之后）：YYMM.NNNNN[vN]，另有旧的 archive/xxxx 形式
  const m = s.match(/(\d{4}\.\d{4,5})(?:v(\d+))?/);
  if (m) {
    const base = m[1];
    const version = m[2] ? Number(m[2]) : 1;
    return { baseId: base, version, versionTag: "v" + version, raw: s };
  }
  const old = s.match(/([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(?:v(\d+))?/i);
  if (old) {
    const version = old[2] ? Number(old[2]) : 1;
    return { baseId: old[1], version, versionTag: "v" + version, raw: s };
  }
  return { baseId: "", version: 0, versionTag: "", raw: s };
}

/**
 * 判断 feed 是否其实是 arXiv 的错误响应。
 * @returns {string} 错误文案；空串表示正常
 */
function detectErrorEntry(block) {
  const id = tagText(block, "id");
  const title = tagText(block, "title");
  const isErr = /\/errors#/i.test(id) || /^error$/i.test(title);
  if (!isErr) return "";
  const summary = tagText(block, "summary");
  if (summary) return summary;
  const frag = id.split("#")[1];
  return frag ? decodeURIComponent(frag.replace(/\+/g, " ")) : "arXiv 返回了未说明的错误";
}

/**
 * 解析一条 `<entry>`。
 * @returns {object|null} 结构化条目；缺 id/标题时返回 null
 */
function parseEntry(block) {
  const err = detectErrorEntry(block);
  if (err) throw new ApiError("arXiv 拒绝了该查询：" + err, { details: { raw: cleanText(block).slice(0, 300) } });

  const idUrl = tagText(block, "id");
  const parsed = parseArxivId(idUrl);
  const title = tagText(block, "title");
  if (!parsed.baseId && !idUrl) return null;

  const summaryRaw = decodeEntities(tagRaw(block, "summary"));
  const summaryParagraphs = splitParagraphs(summaryRaw);
  const summary = summaryParagraphs.join(" ");

  // 作者：逐个 <author> 块解析，机构不跨块串味
  const authorsDetailed = [];
  const authorRe = /<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/gi;
  let am;
  while ((am = authorRe.exec(block)) !== null) {
    const body = am[1];
    const name = tagText(body, "name");
    const affiliations = [];
    const affRe = /<arxiv:affiliation(?:\s[^>]*)?>([\s\S]*?)<\/arxiv:affiliation>/gi;
    let af;
    while ((af = affRe.exec(body)) !== null) {
      const v = cleanText(decodeEntities(af[1]));
      if (v) affiliations.push(v);
    }
    if (name) authorsDetailed.push({ name, affiliations });
  }
  const authors = authorsDetailed.map((a) => a.name);

  // 分类
  const categories = [];
  for (const c of selfClosed(block, "category")) {
    if (c.term && categories.indexOf(c.term) < 0) categories.push(c.term);
  }
  let primary = "";
  const pm = block.match(/<arxiv:primary_category\b[^>]*\bterm\s*=\s*"([^"]*)"/i);
  if (pm) primary = pm[1];
  if (!primary) primary = categories[0] || "";

  // 链接
  const links = { abs: "", pdf: "", doi: "", other: [] };
  for (const l of selfClosed(block, "link")) {
    const rel = l.rel || "";
    const type = l.type || "";
    const title_ = l.title || "";
    const href = l.href || "";
    if (!href) continue;
    if (type === "application/pdf" || /^pdf$/i.test(title_)) links.pdf = links.pdf || href;
    else if (rel === "alternate") links.abs = links.abs || href;
    else if (/^doi$/i.test(title_) || /doi\.org/i.test(href)) links.doi = links.doi || href;
    else links.other.push({ rel, type, title: title_, href });
  }

  const doi = tagText(block, "arxiv:doi") || (links.doi ? links.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") : "");
  const journalRef = tagText(block, "arxiv:journal_ref");
  const comment = tagText(block, "arxiv:comment");
  const license = tagText(block, "arxiv:license") || (selfClosed(block, "link").find((l) => l.rel === "license") || {}).href || "";

  const published = tagText(block, "published");
  const updated = tagText(block, "updated");

  const abs = links.abs || (parsed.baseId ? "https://arxiv.org/abs/" + parsed.baseId + parsed.versionTag : idUrl);
  const pdf = links.pdf || (parsed.baseId ? "https://arxiv.org/pdf/" + parsed.baseId + parsed.versionTag : "");

  return {
    arxivId: parsed.baseId,
    baseId: parsed.baseId,
    version: parsed.version,
    versionTag: parsed.versionTag,
    idUrl: idUrl,
    title: title,
    summary: summary,
    summaryRaw: cleanText(summaryRaw),
    summaryParagraphs: summaryParagraphs,
    authors: authors,
    authorsDetailed: authorsDetailed,
    authorText: authors.join(", "),
    published: published,
    updated: updated,
    publishedDay: published ? published.slice(0, 10) : "",
    updatedDay: updated ? updated.slice(0, 10) : "",
    categories: categories,
    primaryCategory: primary,
    archive: primary ? primary.split(".")[0] : (categories[0] ? categories[0].split(".")[0] : ""),
    doi: doi,
    journalRef: journalRef,
    comment: comment,
    license: license,
    absUrl: abs,
    pdfUrl: pdf,
    links: links,
  };
}

/**
 * 解析整个 feed。
 * @param {string} xml
 * @returns {{entries:Array<object>, meta:object}}
 */
function parseAtom(xml) {
  const src = String(xml == null ? "" : xml);
  if (!src.trim()) throw new ParseError("arXiv 返回了空响应");

  // 去掉注释，避免注释里的 <entry> 干扰
  const body = src.replace(/<!--[\s\S]*?-->/g, "");

  const feedId = tagText(body.split(/<entry[\s>]/i)[0], "id");
  const feedUpdated = tagText(body.split(/<entry[\s>]/i)[0], "updated");
  const totalResults = Number(tagText(body, "opensearch:totalResults")) || 0;
  const startIndex = Number(tagText(body, "opensearch:startIndex")) || 0;
  const itemsPerPage = Number(tagText(body, "opensearch:itemsPerPage")) || 0;

  const chunks = body.split(/<entry(?:\s[^>]*)?>/i).slice(1);
  const entries = [];
  for (const chunk of chunks) {
    const e = parseEntry(chunk);
    if (e) entries.push(e);
  }

  return {
    entries,
    meta: { id: feedId, updated: feedUpdated, totalResults, startIndex, itemsPerPage, error: "" },
  };
}

/** 标题归一化：用于跨源去重（去标点、压空白、小写、截断）。 */
function normalizeTitle(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "")
    .slice(0, 160);
}

/**
 * 去重：优先按 arXiv baseId，其次 DOI，最后归一化标题。同 ID 保留 **版本号更高** 的一条，
 * 并用较新那条的非空字段补齐旧条（合并式，避免新版缺字段反而丢信息）。
 *
 * @param {Array<object>} entries
 * @param {{byId?:boolean, byDoi?:boolean, byTitle?:boolean}} [opts]
 * @returns {{entries:Array<object>, removed:number, duplicates:Array<{kept:string, dropped:string, reason:string}>}}
 */
function dedupeEntries(entries, opts) {
  const o = Object.assign({ byId: true, byDoi: true, byTitle: true }, opts || {});
  const byId = new Map();
  const byDoi = new Map();
  const byTitle = new Map();
  const out = [];
  const duplicates = [];

  for (const e of entries || []) {
    if (!e) continue;
    let hit = null;
    let reason = "";
    if (o.byId && e.baseId && byId.has(e.baseId)) { hit = byId.get(e.baseId); reason = "arxiv-id"; }
    if (!hit && o.byDoi && e.doi && byDoi.has(String(e.doi).toLowerCase())) { hit = byDoi.get(String(e.doi).toLowerCase()); reason = "doi"; }
    if (!hit && o.byTitle) {
      const t = normalizeTitle(e.title);
      if (t.length > 12 && byTitle.has(t)) { hit = byTitle.get(t); reason = "title"; }
    }

    if (hit) {
      const keepNew = (e.version || 0) > (hit.version || 0);
      const keeper = keepNew ? e : hit;
      const donor = keepNew ? hit : e;
      const merged = mergeEntries(keeper, donor);
      // 原地替换（保序）
      const idx = out.indexOf(hit);
      if (idx >= 0) out[idx] = merged; else out.push(merged);
      if (o.byId && merged.baseId) byId.set(merged.baseId, merged);
      if (o.byDoi && merged.doi) byDoi.set(String(merged.doi).toLowerCase(), merged);
      if (o.byTitle) { const t = normalizeTitle(merged.title); if (t.length > 12) byTitle.set(t, merged); }
      duplicates.push({ kept: keeper.arxivId || keeper.title, dropped: donor.arxivId || donor.title, reason });
      continue;
    }

    out.push(e);
    if (o.byId && e.baseId) byId.set(e.baseId, e);
    if (o.byDoi && e.doi) byDoi.set(String(e.doi).toLowerCase(), e);
    if (o.byTitle) { const t = normalizeTitle(e.title); if (t.length > 12) byTitle.set(t, e); }
  }

  return { entries: out, removed: (entries || []).length - out.length, duplicates };
}

/** 用 donor 的空缺字段补齐 keeper（keeper 已有值的不动）。 */
function mergeEntries(keeper, donor) {
  const out = Object.assign({}, keeper);
  for (const k of Object.keys(donor || {})) {
    const v = donor[k];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const cur = out[k];
    if (cur == null || cur === "" || (Array.isArray(cur) && !cur.length)) out[k] = v;
  }
  // 版本相关字段以 keeper 为准
  out.version = keeper.version;
  out.versionTag = keeper.versionTag;
  out.arxivId = keeper.arxivId;
  return out;
}

/**
 * 从「非 2xx 的响应体」里尽力挖出 arXiv 的人话错误。
 *
 * 新版后端（2025-11 迁移）对畸形查询返回 HTTP 400，body 是 Atom 错误条目；
 * 官方说明里没写这条，是实测出来的——不处理就会被当成「0 条结果」，最难排查。
 *
 * @param {string} body
 * @returns {string} 错误文案；挖不到返回 ""
 */
function extractApiError(body) {
  const s = String(body == null ? "" : body);
  if (!s || s.indexOf("<") < 0) return "";
  if (/<entry[\s>]/i.test(s)) {
    try {
      parseAtom(s);
    } catch (e) {
      if (e instanceof ApiError) return e.message.replace(/^arXiv 拒绝了该查询：/, "");
    }
  }
  const m = s.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  if (m) return cleanText(decodeEntities(m[1]));
  return "";
}

module.exports = {
  parseAtom,
  parseEntry,
  parseArxivId,
  detectErrorEntry,
  decodeEntities,
  cleanText,
  splitParagraphs,
  normalizeTitle,
  dedupeEntries,
  mergeEntries,
  extractApiError,
  tagText,
  tagRaw,
  selfClosed,
};
