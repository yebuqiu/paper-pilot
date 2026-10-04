"use strict";

/**
 * 可读报告（Markdown / 终端）。与 exporters.js 的「结构化输出」构成双通道：
 * 结构化格式喂机器（管道、入库、二次处理），报告给人看（决策、分享、贴进笔记）。
 */

const { cleanText } = require("./atom");
const { dayOf, humanOf } = require("./dates");
const { highlight } = require("./analyze");
const { toEntries } = require("./exporters");

/** 文本条形图。 */
function bar(count, max, width) {
  const w = width == null ? 24 : width;
  if (!max) return "";
  const n = Math.max(count > 0 ? 1 : 0, Math.round((count / max) * w));
  return "█".repeat(n);
}

function pct(share) {
  return (Math.round((share || 0) * 1000) / 10) + "%";
}

function truncate(s, n) {
  const t = cleanText(s);
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * 构建 Markdown 报告。
 * @param {object} result client.search/getByIds/update 的返回值
 * @param {{analysis?:object, highlightTerms?:string[], structured?:boolean, maxEntries?:number,
 *          maxAbstract?:number, title?:string, includeAbstract?:boolean}} [opts]
 */
function toMarkdown(result, opts) {
  const o = opts || {};
  const r = result || {};
  const entries = r.entries || [];
  const a = o.analysis || null;
  const maxEntries = o.maxEntries == null ? entries.length : o.maxEntries;
  const maxAbstract = o.maxAbstract == null ? 700 : o.maxAbstract;
  const includeAbstract = o.includeAbstract !== false;
  const structuredMap = new Map();
  if (a && Array.isArray(a.structured)) for (const s of a.structured) structuredMap.set(s.arxivId, s);

  const L = [];
  L.push("# " + (o.title || "arXiv 检索报告"));
  L.push("");
  L.push("| 项目 | 值 |");
  L.push("| --- | --- |");
  if (r.query) L.push("| 查询式 | `" + r.query + "` |");
  if (r.idList) L.push("| ID 列表 | `" + r.idList + "` |");
  L.push("| 生成时间 | " + humanOf(r.generatedAt || new Date().toISOString()) + " |");
  if (r.totalResults != null) L.push("| 索引命中总数 | " + r.totalResults + " |");
  L.push("| 本次获取 | " + (r.fetched != null ? r.fetched : entries.length) + " 条 / " + (r.pages || 0) + " 页 |");
  if (r.duplicatesRemoved) L.push("| 去重移除 | " + r.duplicatesRemoved + " |");
  if (r.missing && r.missing.length) L.push("| 未找到的 ID | " + r.missing.length + "（" + r.missing.slice(0, 10).join(", ") + "） |");
  if (r.sortBy) L.push("| 排序 | " + r.sortBy + " " + (r.sortOrder || "") + " |");
  if (r.fromCache) L.push("| 数据来源 | 本地缓存（" + Math.round((r.cacheAgeMs || 0) / 60000) + " 分钟前） |");
  if (r.newCount != null) L.push("| 新增 | " + r.newCount + "（" + (r.firstRun ? "首次运行，全量视作新增" : "自 " + humanOf(r.since) + " 起") + "） |");
  if (r.elapsedMs != null) L.push("| 耗时 | " + (r.elapsedMs / 1000).toFixed(2) + " s |");
  L.push("| 结果条数 | " + entries.length + " |");
  L.push("");

  if (a) {
    L.push("## 概览统计");
    L.push("");

    const cats = (a.categories && a.categories.byCategory) || [];
    if (cats.length) {
      const max = cats[0].count;
      L.push("### 分类分布（Top " + Math.min(12, cats.length) + "）");
      L.push("");
      L.push("| 分类 | 数量 | 占比 | |");
      L.push("| --- | ---: | ---: | --- |");
      for (const c of cats.slice(0, 12)) {
        L.push("| `" + c.name + "` | " + c.count + " | " + pct(c.share) + " | `" + bar(c.count, max) + "` |");
      }
      L.push("");
    }

    const arch = (a.categories && a.categories.byArchive) || [];
    if (arch.length > 1) {
      L.push("### 大类分布");
      L.push("");
      L.push(arch.slice(0, 8).map((x) => "`" + x.name + "` " + x.count + " (" + pct(x.share) + ")").join(" ｜ "));
      L.push("");
    }

    const co = (a.categories && a.categories.coOccurrence) || [];
    if (co.length) {
      L.push("### 标签共现（Top " + Math.min(8, co.length) + "）");
      L.push("");
      for (const x of co.slice(0, 8)) L.push("- " + x.pair + " — " + x.count + " 篇");
      L.push("");
    }

    if (a.histogram && a.histogram.length) {
      const max = Math.max.apply(null, a.histogram.map((x) => x.count));
      L.push("### 时间分布（" + (o.timeBucket || "按月") + "）");
      L.push("");
      L.push("| 区间 | 数量 | |");
      L.push("| --- | ---: | --- |");
      for (const h of a.histogram.slice(-18)) {
        L.push("| " + h.bucket + " | " + h.count + " | `" + bar(h.count, max, 16) + "` |");
      }
      L.push("");
    }

    if (a.keywords && a.keywords.length) {
      L.push("### 高频主题词（TF-IDF）");
      L.push("");
      L.push(a.keywords.slice(0, 20).map((k) => "`" + k.term + "`").join("、"));
      L.push("");
      L.push("> 权重分值（TF-IDF）：" + a.keywords.slice(0, 12).map((k) => k.term + "=" + k.score).join(", "));
      L.push("");
    }

    if (a.clusters && a.clusters.clusters && a.clusters.clusters.length) {
      L.push("### 主题聚类（k=" + a.clusters.k + "）");
      L.push("");
      for (const c of a.clusters.clusters) {
        L.push("**簇 " + (c.id + 1) + "**（" + c.size + " 篇）— 关键词：" + c.topTerms.map((t) => "`" + t + "`").join(" "));
        for (const t of (c.titles || []).slice(0, 3)) L.push("  - " + truncate(t, 110));
        if ((c.titles || []).length > 3) L.push("  - …其余 " + (c.titles.length - 3) + " 篇");
        L.push("");
      }
    }

    if (a.structuredCount != null) {
      L.push("### 结构化摘要");
      L.push("");
      L.push("检出结构化摘要的论文：" + a.structuredCount + " / " + (a.total || entries.length));
      L.push("");
    }
  }

  L.push("## 结果列表");
  L.push("");
  const terms = o.highlightTerms || [];
  entries.slice(0, maxEntries).forEach((e, i) => {
    const title = terms.length ? highlight(e.title, terms).text : e.title;
    L.push("### " + (i + 1) + ". " + title);
    L.push("");
    const meta = [];
    meta.push((e.authors || []).slice(0, 5).join(", ") + ((e.authors || []).length > 5 ? " et al." : ""));
    L.push("- " + meta.join(" ｜ "));
    L.push("- " + [dayOf(e.published), "arXiv:" + e.arxivId + (e.version > 1 ? " v" + e.version : ""),
      (e.categories || []).join(", ")].filter(Boolean).join(" ｜ "));
    if (e.doi) L.push("- DOI：" + e.doi);
    if (e.journalRef) L.push("- 期刊引用：" + e.journalRef);
    if (e.comment) L.push("- 备注：" + truncate(e.comment, 200));
    if (e.versionHistory && e.versionHistory.ok) {
      L.push("- 版本历史：" + e.versionHistory.versions.map((v) => "v" + v.version + "(" + (v.date || "?").replace(/ UTC$/, "") + ")").join(" → "));
    }
    if (e.references) L.push("- 参考文献：" + e.references.length + " 条" + (e.referencesError ? "（" + e.referencesError + "）" : ""));
    if (e.citations) L.push("- 被引：" + e.citations.length + " 条");
    L.push("- 链接：" + e.absUrl + " ｜ PDF：" + e.pdfUrl);
    if (includeAbstract && e.summary) {
      L.push("");
      const st = structuredMap.get(e.arxivId);
      if (st && st.structured) {
        for (const s of st.sections) {
          const body = terms.length ? highlight(s.text, terms).text : s.text;
          L.push("**" + s.label + "**：" + truncate(body, maxAbstract));
          L.push("");
        }
      } else {
        const body = terms.length ? highlight(e.summary, terms).text : e.summary;
        L.push("> " + truncate(body, maxAbstract));
        L.push("");
      }
    }
    L.push("");
  });

  if (entries.length > maxEntries) {
    L.push("> 报告仅列出前 " + maxEntries + " 条，完整结果请用 `--format json` 或 `--format csv` 导出。");
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push("<sub>由 PaperPilot arXiv 工具包生成 · 数据来源 arXiv API（导出/使用请遵守 arXiv 使用条款）</sub>");
  return L.join("\n");
}

/** 终端宽度自适应的截断。 */
function pad(s, n) {
  const t = String(s == null ? "" : s);
  if (t.length >= n) return t.slice(0, n - 1) + "…";
  return t + " ".repeat(n - t.length);
}

/**
 * 终端可读输出：统计条 + 精简表格。
 * @param {object} result
 * @param {{analysis?:object, maxEntries?:number, color?:boolean, titleWidth?:number}} [opts]
 */
function toTerminal(result, opts) {
  const o = opts || {};
  const r = result || {};
  const entries = toEntries(r);
  const a = o.analysis || null;
  const maxEntries = o.maxEntries == null ? 25 : o.maxEntries;
  const C = o.color
    ? { dim: "\u001b[90m", bold: "\u001b[1m", cyan: "\u001b[36m", reset: "\u001b[0m" }
    : { dim: "", bold: "", cyan: "", reset: "" };

  const L = [];
  L.push(C.bold + (o.title || "arXiv 检索结果") + C.reset);
  if (r.query) L.push(C.dim + "查询: " + truncate(r.query, 120) + C.reset);
  const summaryBits = [];
  if (r.totalResults != null) summaryBits.push("命中 " + r.totalResults);
  summaryBits.push("获取 " + (r.fetched != null ? r.fetched : entries.length));
  if (r.pages) summaryBits.push(r.pages + " 页");
  if (r.duplicatesRemoved) summaryBits.push("去重 " + r.duplicatesRemoved);
  if (r.fromCache) summaryBits.push("缓存");
  if (r.newCount != null) summaryBits.push("新增 " + r.newCount);
  if (r.elapsedMs != null) summaryBits.push((r.elapsedMs / 1000).toFixed(2) + "s");
  L.push(C.dim + summaryBits.join(" ｜ ") + C.reset);
  L.push("");

  if (a && a.categories && a.categories.byCategory.length) {
    const cats = a.categories.byCategory.slice(0, 8);
    const max = cats[0].count;
    L.push(C.bold + "分类分布" + C.reset);
    for (const c of cats) L.push("  " + pad(c.name, 12) + " " + String(c.count).padStart(4) + "  " + C.cyan + bar(c.count, max, 20) + C.reset);
    L.push("");
  }

  if (a && a.clusters && a.clusters.clusters && a.clusters.clusters.length) {
    L.push(C.bold + "主题聚类 (k=" + a.clusters.k + ")" + C.reset);
    for (const c of a.clusters.clusters) {
      L.push("  簇" + (c.id + 1) + " (" + c.size + "篇): " + c.topTerms.slice(0, 5).join(", "));
      L.push("       " + C.dim + truncate((c.titles || [])[0] || "", 78) + C.reset);
    }
    L.push("");
  }

  L.push(C.bold + "条目" + C.reset);
  entries.slice(0, maxEntries).forEach((e, i) => {
    L.push("  " + String(i + 1).padStart(3) + ". " + (e.title || "(无标题)"));
    L.push("       " + C.dim + [(e.published || "").slice(0, 10), "arXiv:" + e.arxivId, (e.primaryCategory || ""),
      ((e.authors || [])[0] ? (e.authors[0] + ((e.authors.length > 1) ? " 等" : "")) : "")].filter(Boolean).join(" ｜ ") + C.reset);
  });
  if (entries.length > maxEntries) L.push("  " + C.dim + "… 其余 " + (entries.length - maxEntries) + " 条（用 --format json/csv 导出全部）" + C.reset);
  return L.join("\n");
}

module.exports = { toMarkdown, toTerminal, bar, truncate };
