"use strict";

/**
 * 版本历史抓取。
 *
 * 为什么不能只靠 Atom API：查询 API 对每个 ID 只返回**最新版本**一条 entry，
 * 而「这篇论文改了几次、每次改了什么时间」对判断可信度很关键（预印本可能被大幅修订）。
 * 完整版本列表只出现在 arXiv 的 abs 页面 HTML 的 "Submission history" 区块。
 *
 * 因此这里做一次可选的 HTML 抓取，并用**极宽容**的正则提取——abs 页面的模板改过多次，
 * 任何严格解析都会在某次改版后静默失效。抓不到就返回 ok:false，绝不影响主流程。
 */

const { cleanText } = require("./atom");

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** `Mon, 2 Oct 2026 12:00:00 UTC` → ISO 字符串（无效返回 ""）。 */
function parseStamp(text) {
  const m = String(text || "").match(/([A-Za-z]{3}),?\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  const mon = MONTHS[m[3].toLowerCase()];
  if (!mon) return "";
  const d = new Date(Date.UTC(Number(m[4]), mon - 1, Number(m[2]), Number(m[5]), Number(m[6]), Number(m[7] || 0)));
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * 从 abs 页面 HTML 中解析版本历史（纯函数，可单测）。
 * @param {string} html
 * @returns {Array<{version:number, date:string, iso:string, sizeKb:number|null, raw:string}>}
 */
function parseVersionHistory(html) {
  const src = String(html || "");
  const at = src.search(/submission-history/i);
  if (at < 0) return [];
  // 取区块后 6000 字符足够覆盖几十个版本
  const seg = src.slice(at, at + 6000);

  const marks = [];
  const re = /\[v(\d+)\]/gi;
  let m;
  while ((m = re.exec(seg)) !== null) marks.push({ version: Number(m[1]), index: m.index, end: re.lastIndex });

  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].index : seg.length;
    const raw = seg.slice(from, to);
    const text = cleanText(raw.replace(/<[^>]*>/g, " "));
    const iso = parseStamp(text);
    const sizeM = text.match(/([\d.,]+)\s*(KB|MB|bytes)/i);
    let sizeKb = null;
    if (sizeM) {
      const n = Number(sizeM[1].replace(/,/g, ""));
      const unit = sizeM[2].toUpperCase();
      sizeKb = unit === "MB" ? Math.round(n * 1024) : unit === "BYTES" ? Math.round(n / 1024) : Math.round(n);
    }
    const dateM = text.match(/[A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:UTC)?/);
    out.push({
      version: marks[i].version,
      date: dateM ? cleanText(dateM[0]) : "",
      iso,
      sizeKb,
      raw: text.slice(0, 160),
    });
  }
  // 去重（同一版本号只保留首次出现）并按版本排序
  const seen = new Set();
  return out.filter((v) => (seen.has(v.version) ? false : (seen.add(v.version), true)))
    .sort((a, b) => a.version - b.version);
}

/**
 * 抓取并解析某个 arXiv ID 的版本历史。
 * @param {string} arxivId 不含版本号
 * @param {{transport:Function, logger?:object, absBaseUrl?:string}} opts
 * @returns {Promise<{ok:boolean, arxivId:string, versions:Array, count:number, latest:number, reason?:string}>}
 */
async function fetchVersionHistory(arxivId, opts) {
  const o = opts || {};
  const base = (o.absBaseUrl || "https://arxiv.org/abs").replace(/\/+$/, "");
  const id = String(arxivId || "").replace(/v\d+$/, "");
  const result = { ok: false, arxivId: id, versions: [], count: 0, latest: 0 };
  if (!id) { result.reason = "缺少 arXiv ID"; return result; }
  if (typeof o.transport !== "function") { result.reason = "未提供 transport"; return result; }
  try {
    const res = await o.transport(base + "/" + id, { headers: { Accept: "text/html,application/xhtml+xml" } });
    if (res.status < 200 || res.status >= 300) { result.reason = "HTTP " + res.status; return result; }
    const versions = parseVersionHistory(res.body);
    if (!versions.length) { result.reason = "页面中未找到 Submission history（模板可能已变）"; return result; }
    result.ok = true;
    result.versions = versions;
    result.count = versions.length;
    result.latest = versions[versions.length - 1].version;
    if (o.logger && o.logger.isDebug) o.logger.debug("版本历史已获取", { arxivId: id, count: versions.length });
    return result;
  } catch (e) {
    result.reason = (e && e.message) || String(e);
    if (o.logger) o.logger.warn("版本历史抓取失败（忽略）", { arxivId: id, error: result.reason });
    return result;
  }
}

module.exports = { fetchVersionHistory, parseVersionHistory, parseStamp };
