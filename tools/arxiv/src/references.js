"use strict";

/**
 * 参考文献 / 被引 抓取（**可选、默认关闭**）。
 *
 * arXiv 的 Atom API **不提供**参考文献与引用关系——这是它的固有缺口。成熟生态的做法是
 * 用 arXiv 拿正文与元数据、用 OpenAlex / Semantic Scholar 补引用关系。
 *
 * 这里接 Semantic Scholar Graph API（免 key，匿名额度低）：
 *   - 默认关闭（`--with-references`），因为这会把请求打到第三方、且匿名额度极易触发 429；
 *   - **任何失败都只降级为「无参考文献」**，绝不让引用关系抓取拖垮主检索；
 *   - 自带独立限速（默认 1.2s/次，比 arXiv 更保守，因为 S2 匿名额度更紧）。
 */

const { RateLimitError } = require("./errors");

const DEFAULT_FIELDS = "title,authors,year,venue,externalIds,citationCount,publicationDate";

function normalizeS2Item(it) {
  const ext = (it && it.externalIds) || {};
  return {
    title: (it && it.title) || "",
    authors: ((it && it.authors) || []).map((a) => a && a.name).filter(Boolean),
    year: (it && it.year) || null,
    venue: (it && it.venue) || "",
    publicationDate: (it && it.publicationDate) || "",
    doi: ext.DOI || "",
    arxivId: ext.ArXiv || "",
    s2Id: (it && it.paperId) || "",
    citationCount: (it && it.citationCount) || 0,
  };
}

/**
 * @param {"references"|"citations"} kind
 * @param {string} arxivId 不含版本号
 * @param {{transport:Function, logger?:object, limit?:number, fields?:string, s2BaseUrl?:string}} opts
 * @returns {Promise<{ok:boolean, arxivId:string, kind:string, items:Array, total:number, reason?:string}>}
 */
async function fetchRelated(kind, arxivId, opts) {
  const o = opts || {};
  const base = (o.s2BaseUrl || "https://api.semanticscholar.org/graph/v1").replace(/\/+$/, "");
  const id = String(arxivId || "").replace(/v\d+$/, "");
  const limit = Math.max(1, Math.min(1000, Number(o.limit) || 100));
  const out = { ok: false, arxivId: id, kind, items: [], total: 0 };
  if (!id) { out.reason = "缺少 arXiv ID"; return out; }
  if (typeof o.transport !== "function") { out.reason = "未提供 transport"; return out; }

  const url = base + "/paper/arXiv:" + encodeURIComponent(id) + "/" + kind +
    "?fields=" + encodeURIComponent(o.fields || DEFAULT_FIELDS) + "&limit=" + limit;
  try {
    const res = await o.transport(url, { headers: { Accept: "application/json" } });
    if (res.status === 404) { out.reason = "Semantic Scholar 未收录该论文"; return out; }
    if (res.status === 429) { out.reason = "Semantic Scholar 限速（429），请降低频率或稍后重试"; return out; }
    if (res.status < 200 || res.status >= 300) { out.reason = "HTTP " + res.status; return out; }
    const data = JSON.parse(res.body);
    const list = (kind === "references" ? data.data || [] : data.data || []);
    const items = list
      .map((x) => normalizeS2Item(x.citedPaper || x.citingPaper || x))
      .filter((x) => x.title);
    out.ok = true;
    out.items = items;
    out.total = items.length;
    if (o.logger && o.logger.isDebug) o.logger.debug("引用数据已获取", { arxivId: id, kind, count: items.length });
    return out;
  } catch (e) {
    out.reason = (e && e.message) || String(e);
    if (o.logger) o.logger.warn("引用数据抓取失败（忽略）", { arxivId: id, kind, error: out.reason });
    return out;
  }
}

function fetchReferences(arxivId, opts) { return fetchRelated("references", arxivId, opts); }
function fetchCitations(arxivId, opts) { return fetchRelated("citations", arxivId, opts); }

module.exports = { fetchReferences, fetchCitations, fetchRelated, normalizeS2Item, DEFAULT_FIELDS, RateLimitError };
