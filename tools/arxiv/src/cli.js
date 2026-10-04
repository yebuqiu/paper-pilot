"use strict";

/**
 * 命令行入口。
 *
 * 设计原则：
 *   - **退出码有语义**（见 errors.EXIT），便于脚本判断失败原因；
 *   - **stdout 只放结果**，日志一律 stderr —— `arxiv search -f json > out.json` 必须干净；
 *   - 参数解析自实现（零依赖），支持 `--k=v`、`--k v`、`-k v`、`-vv`、`--no-xxx`；
 *   - 未知参数**直接报错并给最接近的候选**，而不是静默忽略（静默忽略会让人以为查询生效了）。
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("./client");
const { loadConfig } = require("./config");
const categories = require("./categories");
const { createLogger, LEVELS } = require("./logger");
const { EXIT, ArxivError, UsageError, exitCodeFor } = require("./errors");
const { toJSON, toJSONL, toCSV, toBibTeX, toEntries } = require("./exporters");
const { toMarkdown, toTerminal } = require("./report");
const { analyze, extractKeywords } = require("./analyze");
const { buildQuery } = require("./query");
const { Cache, StateStore } = require("./cache");

const VERSION = (() => {
  try { return require("../package.json").version || "1.0.0"; } catch (e) { return "1.0.0"; }
})();

const PROG = "arxiv";

/* ------------------------------ 参数表 ------------------------------ */

/** type: string | number | optional-number | array | bool | count */
const OPTIONS = [
  { name: "query", alias: "q", type: "string", group: "检索条件", desc: "原始 arXiv 查询串（如 'ti:attention AND cat:cs.CL'）" },
  { name: "keyword", alias: "k", type: "array", group: "检索条件", desc: "关键词，可多次；支持 field:value 前缀（ti:/abs:/au:/all:…）" },
  { name: "author", alias: "a", type: "array", group: "检索条件", desc: "作者名（字符串匹配，可多次）" },
  { name: "category", alias: "c", type: "array", group: "检索条件", desc: "arXiv 分类（如 cs.LG），可多次" },
  { name: "id", type: "array", group: "检索条件", desc: "arXiv ID，逗号分隔或多次（走 id_list，精确）" },
  { name: "doi", type: "string", group: "检索条件", desc: "DOI 精确查询" },
  { name: "journal-ref", type: "string", group: "检索条件", desc: "期刊引用（jr:）" },
  { name: "from", type: "string", group: "检索条件", desc: "起始日期 2025-01-01 / 2025-01 / 2025" },
  { name: "to", type: "string", group: "检索条件", desc: "结束日期（含当天）" },
  { name: "date-field", type: "string", group: "检索条件", desc: "日期字段 submittedDate（默认）| lastUpdatedDate" },
  { name: "exclude-category", type: "array", group: "检索条件", desc: "排除分类（ANDNOT）" },
  { name: "exclude-keyword", type: "array", group: "检索条件", desc: "排除关键词（ANDNOT）" },
  { name: "or", type: "bool", group: "检索条件", desc: "关键词/作者之间用 OR 连接（默认 AND）" },
  { name: "cat-mode", type: "string", group: "检索条件", desc: "多个分类之间的关系：and（默认，交叉列表）| or（并集）" },
  { name: "phrase", type: "bool", group: "检索条件", desc: "把关键词当作精确短语（加引号）" },
  { name: "date-field", type: "string", group: "检索条件", desc: "日期字段（submittedDate / lastUpdatedDate）" },

  { name: "sort", alias: "s", type: "string", group: "分页与排序", desc: "relevance | lastUpdatedDate | submittedDate" },
  { name: "order", type: "string", group: "分页与排序", desc: "ascending | descending" },
  { name: "page-size", type: "number", group: "分页与排序", desc: "每页条数（≤2000）" },
  { name: "limit", type: "number", group: "分页与排序", desc: "最多返回条数" },
  { name: "pages", type: "number", group: "分页与排序", desc: "最多翻页数" },
  { name: "batch-size", type: "number", group: "分页与排序", desc: "按 ID 批量获取时的批大小" },

  { name: "format", alias: "f", type: "string", group: "输出", desc: "md | table | json | jsonl | csv | bibtex | url" },
  { name: "out", alias: "o", type: "string", group: "输出", desc: "结构化结果写入文件（默认 stdout）" },
  { name: "report", type: "string", group: "输出", desc: "另写一份 Markdown 报告到该文件（双通道）" },
  { name: "no-pretty", type: "bool", group: "输出", desc: "JSON 不缩进" },
  { name: "max-abstract", type: "number", group: "输出", desc: "报告中摘要截断长度" },
  { name: "max-entries", type: "number", group: "输出", desc: "报告中最多列出的条目数" },
  { name: "dry-run", type: "bool", group: "输出", desc: "只打印将要请求的 URL，不实际联网" },

  { name: "highlight", type: "array", group: "信息提取", desc: "标题/摘要关键词高亮；不带值时自动取 Top10 主题词" },
  { name: "mark", type: "string", group: "信息提取", desc: "高亮标记（默认 **，Markdown 加粗）" },
  { name: "no-structured", type: "bool", group: "信息提取", desc: "关闭结构化摘要拆分" },
  { name: "no-stats", type: "bool", group: "信息提取", desc: "关闭统计" },
  { name: "cluster", type: "optional-number", group: "信息提取", desc: "主题聚类；可指定 k（--cluster 4）" },

  { name: "with-versions", type: "bool", group: "增强", desc: "补版本历史（抓 abs 页，较慢）" },
  { name: "with-references", type: "bool", group: "增强", desc: "补参考文献（Semantic Scholar，默认关闭）" },
  { name: "with-citations", type: "bool", group: "增强", desc: "补被引列表（Semantic Scholar）" },
  { name: "enrich-limit", type: "number", group: "增强", desc: "最多对前 N 条做增强（默认 20）" },

  { name: "cache-dir", type: "string", group: "缓存", desc: "缓存目录（默认 ./.arxiv-cache）" },
  { name: "cache-ttl", type: "number", group: "缓存", desc: "缓存有效期（秒）" },
  { name: "no-cache", type: "bool", group: "缓存", desc: "本次不读写缓存" },
  { name: "refresh", type: "bool", group: "缓存", desc: "忽略缓存，强制联网" },
  { name: "state-key", type: "string", group: "缓存", desc: "增量更新的状态键（默认按查询式）" },
  { name: "reset-state", type: "bool", group: "缓存", desc: "重置增量状态（下次全量视作新增）" },

  { name: "base-url", type: "string", group: "网络", desc: "arXiv API 地址（测试/镜像用）" },
  { name: "timeout", type: "number", group: "网络", desc: "单次请求超时（毫秒）" },
  { name: "retries", type: "number", group: "网络", desc: "失败重试次数" },
  { name: "min-interval", type: "number", group: "网络", desc: "两次请求最小间隔（毫秒，默认 3000）" },
  { name: "concurrency", type: "number", group: "网络", desc: "最大并发（默认 1）" },

  { name: "categories", type: "array", group: "通用", desc: "categories 命令：待校验分类列表（同上，别名）" },
  { name: "check", type: "array", group: "通用", desc: "categories 命令：待校验的分类，如 --check cs.LG,cs.NLP" },
  { name: "config", type: "string", group: "通用", desc: "配置文件路径" },
  { name: "print-config", type: "bool", group: "通用", desc: "打印最终生效配置（含来源）" },
  { name: "log-level", type: "string", group: "通用", desc: "silent|error|warn|info|debug" },
  { name: "log-json", type: "bool", group: "通用", desc: "日志以 JSON 行输出" },
  { name: "quiet", type: "bool", group: "通用", desc: "等价 --log-level error" },
  { name: "verbose", alias: "v", type: "count", group: "通用", desc: "提高日志级别（可叠加 -vv）" },
  { name: "help", alias: "h", type: "bool", group: "通用", desc: "显示帮助" },
  { name: "version", alias: "V", type: "bool", group: "通用", desc: "显示版本" },
];

const COMMANDS = {
  search: { desc: "按条件检索论文（默认命令）", usage: `${PROG} search -k "diffusion" -c cs.LG --limit 50` },
  get: { desc: "按 arXiv ID 精确获取元数据", usage: `${PROG} get --id 2501.00001,2501.00002 -f json` },
  update: { desc: "增量更新：只返回上次之后的新论文/新版本", usage: `${PROG} update -c cs.CL --limit 200` },
  stats: { desc: "检索并输出统计分析（分类/时间/主题聚类）", usage: `${PROG} stats -c cs.LG --cluster 5` },
  categories: { desc: "列出/校验 arXiv 分类", usage: `${PROG} categories --check cs.LG,cs.NLP` },
  cache: { desc: "缓存与增量状态管理", usage: `${PROG} cache stats | clear | prune | state` },
  check: { desc: "自检：配置、分类目录、连通性", usage: `${PROG} check` },
  config: { desc: "打印最终生效配置", usage: `${PROG} config` },
  help: { desc: "显示帮助", usage: `${PROG} help` },
};

/* ------------------------------ 解析器 ------------------------------ */

const LONG = new Map();
const SHORT = new Map();
for (const o of OPTIONS) {
  LONG.set(o.name, o);
  if (o.alias) SHORT.set(o.alias, o);
}

/** 找最接近的选项名（拼错时给建议）。 */
function nearest(name, pool) {
  const cands = Array.from(pool);
  let best = null, bestD = Infinity;
  for (const c of cands) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= Math.max(2, Math.ceil(name.length / 3)) ? best : null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function isBool(spec) { return spec.type === "bool" || spec.type === "count"; }

function setValue(out, spec, raw) {
  switch (spec.type) {
    case "bool": out[spec.name] = true; break;
    case "count": out[spec.name] = (out[spec.name] || 0) + 1; break;
    case "number": {
      const n = Number(raw);
      if (raw == null || !isFinite(n)) throw new UsageError("选项 --" + spec.name + " 需要一个数字，收到：" + raw);
      out[spec.name] = n;
      break;
    }
    case "optional-number": {
      if (raw == null || raw === "") { out[spec.name] = 0; break; }
      const n = Number(raw);
      if (!isFinite(n)) throw new UsageError("选项 --" + spec.name + " 需要数字或留空，收到：" + raw);
      out[spec.name] = n;
      break;
    }
    case "array": {
      if (raw == null) { out[spec.name] = out[spec.name] || []; break; }
      const arr = out[spec.name] || (out[spec.name] = []);
      for (const piece of String(raw).split(",")) {
        const v = piece.trim();
        if (v) arr.push(v);
      }
      break;
    }
    default:
      out[spec.name] = raw == null ? "" : String(raw);
  }
}

/** 取某个 token 对应的选项定义（支持 --no-xxx 与 -x）。 */
function specOf(tok) {
  if (typeof tok !== "string" || tok[0] !== "-" || tok === "-") return null;
  const body = tok.replace(/^--?/, "").split("=")[0];
  if (tok.indexOf("--") === 0) {
    if (LONG.has(body)) return LONG.get(body);
    if (body.indexOf("no-") === 0 && LONG.has(body.slice(3))) return LONG.get(body.slice(3));
    return null;
  }
  return SHORT.get(body[0]) || null;
}

/**
 * 解析 argv。
 * @param {string[]} argv
 * @returns {{command:string, options:object, positionals:string[]}}
 */
function parseArgs(argv) {
  const args = (argv || []).slice();
  const options = {};
  const positionals = [];
  let command = "";

  // 第一遍：定位子命令——「第一个非选项 token，且不是前一个选项的取值」。
  // 必须判「是否为选项取值」，否则 `-c cs.LG` 里的 cs.LG 会被当成子命令。
  const rest = [];
  for (let k = 0; k < args.length; k++) {
    const tok = args[k];
    const isOptish = tok === "--" || (tok !== "-" && tok[0] === "-");
    if (!command && !isOptish) {
      const prev = args[k - 1];
      const prevSpec = prev && prev !== "--" && prev[0] === "-" ? specOf(prev) : null;
      const prevTakesValue = !!(prevSpec && !isBool(prevSpec) && prev.indexOf("=") < 0);
      if (prevTakesValue) { rest.push(tok); continue; }
      command = tok;
      continue;
    }
    rest.push(tok);
  }

  // 第二遍：完整解析
  let onlyPositional = false;
  for (let k = 0; k < rest.length; k++) {
    const tok = rest[k];
    if (onlyPositional) { positionals.push(tok); continue; }
    if (tok === "--") { onlyPositional = true; continue; }
    if (tok === "-" || tok[0] !== "-") { positionals.push(tok); continue; }

    let inlineValue = null;
    let body;
    if (tok.indexOf("--") === 0) {
      body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) { inlineValue = body.slice(eq + 1); body = body.slice(0, eq); }
      if (body.indexOf("no-") === 0 && !LONG.has(body)) {
        const target = LONG.get(body.slice(3));
        if (target) { options[target.name] = false; continue; }
        const guess = nearest(body.slice(3), LONG.keys());
        throw new UsageError("未知选项 --" + body, { hint: guess ? "你是不是想用 --no-" + guess + "？" : "运行 " + PROG + " help 查看全部选项" });
      }
      const spec = LONG.get(body);
      if (!spec) {
        const guess = nearest(body, LONG.keys());
        throw new UsageError("未知选项 --" + body, { hint: guess ? "你是不是想用 --" + guess + "？" : "运行 " + PROG + " help 查看全部选项" });
      }
      if (isBool(spec)) { setValue(options, spec, null); continue; }
      let v = inlineValue;
      if (v == null) {
        const next = rest[k + 1];
        if (next !== undefined && !(next.length > 1 && next[0] === "-" && isNaN(Number(next)))) { v = next; k++; }
      }
      setValue(options, spec, v);
      continue;
    }

    // 短选项
    const shortBody = tok.slice(1);
    if (shortBody.length > 1) {
      const allBool = Array.from(shortBody).every((ch) => { const s = SHORT.get(ch); return !!s && isBool(s); });
      if (allBool) { for (const ch of shortBody) setValue(options, SHORT.get(ch), null); continue; }
    }
    const ch = shortBody[0];
    const spec = SHORT.get(ch);
    if (!spec) {
      const guess = nearest(ch, SHORT.keys());
      throw new UsageError("未知选项 -" + ch, { hint: guess ? "你是不是想用 -" + guess + "？" : "运行 " + PROG + " help 查看全部选项" });
    }
    if (isBool(spec)) { setValue(options, spec, null); continue; }
    let v;
    if (shortBody.length > 1) v = shortBody.slice(1);
    else { v = rest[k + 1]; k++; }
    setValue(options, spec, v);
  }

  return { command, options, positionals };
}

/* --------------------------- CLI → 配置 --------------------------- */

/** 把 CLI 选项映射到配置树，并抽出检索相关的原始选项。 */
function mapToConfig(o) {
  const patch = { api: {}, request: {}, search: {}, cache: {}, output: {}, log: {}, analyze: {}, enrich: {} };
  const set = (obj, k, v) => { if (v !== undefined && v !== null) obj[k] = v; };

  set(patch.api, "baseUrl", o["base-url"]);
  set(patch.request, "timeoutMs", o.timeout);
  set(patch.request, "retries", o.retries);
  set(patch.request, "minIntervalMs", o["min-interval"]);
  set(patch.request, "maxConcurrent", o.concurrency);
  set(patch.search, "pageSize", o["page-size"]);
  set(patch.search, "maxResults", o.limit);
  set(patch.search, "maxPages", o.pages);
  set(patch.search, "sortBy", o.sort);
  set(patch.search, "sortOrder", o.order);
  set(patch.cache, "dir", o["cache-dir"]);
  if (o["cache-ttl"] != null) patch.cache.ttlMs = Math.round(Number(o["cache-ttl"]) * 1000);
  if (o["no-cache"]) patch.cache.enabled = false;
  set(patch.output, "format", o.format);
  set(patch.output, "out", o.out);
  set(patch.output, "report", o.report);
  if (o["no-pretty"]) patch.output.pretty = false;
  set(patch.log, "level", o["log-level"]);
  if (o["log-json"]) patch.log.json = true;
  if (o.quiet) patch.log.level = "error";
  if (o.verbose) patch.log.level = o.verbose >= 2 ? "debug" : "info";

  if (o.highlight !== undefined) patch.analyze.highlight = true;
  if (Array.isArray(o.highlight)) patch.analyze.highlightTerms = o.highlight;
  set(patch.analyze, "highlightMark", o.mark);
  if (o["no-structured"]) patch.analyze.structuredAbstract = false;
  if (o["no-stats"]) patch.analyze.stats = false;
  if (o.cluster !== undefined) {
    patch.analyze.cluster = { enabled: true, k: o.cluster || 0 };
  }

  if (o["with-versions"]) patch.enrich.versionHistory = true;
  if (o["with-references"]) patch.enrich.references = true;
  if (o["with-citations"]) patch.enrich.citations = true;

  // 清理空对象，避免覆盖已有配置项（deepMerge 只在键存在时覆盖）
  for (const k of Object.keys(patch)) if (!Object.keys(patch[k]).length) delete patch[k];
  patch.config = o.config;
  return patch;
}

/** CLI 选项 → buildQuery 的 spec。 */
function toSpec(o) {
  return {
    raw: o.query || "",
    keywords: o.keyword || [],
    authors: o.author || [],
    categories: o.category || [],
    ids: o.id || [],
    doi: o.doi || "",
    journalRef: o["journal-ref"] || "",
    excludeCategories: o["exclude-category"] || [],
    excludeKeywords: o["exclude-keyword"] || [],
    dateFrom: o.from || "",
    dateTo: o.to || "",
    dateField: o["date-field"] || "submittedDate",
    boolean: o.or ? "OR" : "AND",
    categoryMode: o["cat-mode"] || "AND",
    phrase: !!o.phrase,
  };
}

function hasAnyCondition(spec) {
  return !!(spec.raw || spec.keywords.length || spec.authors.length || spec.categories.length ||
    spec.ids.length || spec.doi || spec.journalRef);
}

/* ------------------------------ 输出工具 ------------------------------ */

function writeOut(file, text) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return path.resolve(file);
}

/* ------------------------------ 命令实现 ------------------------------ */

function makeLoggerFor(cfg, streams) {
  return createLogger({
    level: cfg.log.level,
    json: cfg.log.json,
    stream: streams && streams.stderr ? streams.stderr : process.stderr,
  });
}

/** 取条目的高亮词：显式给定则用显式的，否则取 Top-N 主题词。 */
function resolveHighlightTerms(entries, explicit, enabled) {
  if (!enabled) return [];
  if (explicit && explicit.length) return explicit;
  return extractKeywords(entries, { topN: 10 }).map((k) => k.term);
}

function buildAnalysis(entries, cfg, terms) {
  return analyze(entries, {
    highlight: !!terms.length,
    highlightTerms: terms,
    highlightOpts: { mark: cfg.analyze.highlightMark || "**" },
    structured: cfg.analyze.structuredAbstract !== false,
    stats: cfg.analyze.stats !== false,
    cluster: cfg.analyze.cluster && cfg.analyze.cluster.enabled ? (cfg.analyze.cluster.k || 0) : false,
    keywords: 30,
    histogram: "month",
  });
}

/** 结构化载荷：把检索结果 + 分析结果合并输出（机器通道）。 */
function buildPayload(result, analysis, extras) {
  return Object.assign({}, result, {
    analysis: analysis || null,
  }, extras || {});
}

/**
 * 统一渲染与落盘。返回 {stdoutText, reportPath}。
 */
function render(result, analysis, cfg, opts) {
  const o = opts || {};
  const entries = toEntries(result);
  const format = o.format || cfg.output.format || "md";
  const terms = o.highlightTerms || [];

  let stdoutText;
  switch (format) {
    case "json":
      stdoutText = toJSON(buildPayload(result, analysis, o.extras), { pretty: cfg.output.pretty !== false });
      break;
    case "jsonl":
      stdoutText = toJSONL(entries);
      break;
    case "csv":
      stdoutText = toCSV(entries, { bom: true });
      break;
    case "bibtex":
      stdoutText = toBibTeX(entries);
      break;
    case "table":
      stdoutText = toTerminal(result, { analysis, maxEntries: cfg.output.maxEntries || 25, color: process.stdout.isTTY });
      break;
    case "url":
      stdoutText = (result.urls || [result.url]).filter(Boolean).map((u) => u.replace(/^/, "")).join("\n") + "\n";
      break;
    case "md":
    default:
      stdoutText = toMarkdown(result, {
        analysis,
        highlightTerms: terms,
        maxEntries: cfg.output.maxEntries || entries.length,
        maxAbstract: cfg.output.maxAbstract || 700,
      });
      break;
  }

  return { stdoutText, format };
}

function renderReport(result, analysis, cfg, terms) {
  return toMarkdown(result, {
    analysis,
    highlightTerms: terms,
    maxEntries: cfg.output.maxEntries || toEntries(result).length,
    maxAbstract: cfg.output.maxAbstract || 700,
    title: "arXiv 检索报告",
  });
}

/** 公共：跑一次检索 + 增强 + 分析 + 输出。 */
async function runQuery(kind, cli, cfg, log) {
  const client = createClient({ config: cfg, logger: log });
  const spec = toSpec(cli);
  const format = cfg.output.format;

  if (cli["reset-state"]) {
    const st = new StateStore({ dir: cfg.cache.dir, logger: log });
    st.reset(cli["state-key"] || undefined);
    log.info("增量状态已重置", { stateKey: cli["state-key"] || "(全部)" });
  }

  // --dry-run：只打印 URL，不联网
  if (cli["dry-run"]) {
    const built = buildQuery(spec);
    if (built.isEmpty) throw new UsageError("没有可执行的检索条件");
    const pageSize = cfg.search.pageSize;
    const limit = cfg.search.maxResults;
    const pages = Math.max(1, Math.min(cfg.search.maxPages, Math.ceil(limit / pageSize)));
    const urls = [];
    for (let p = 0; p < pages; p++) {
      const start = p * pageSize;
      if (start >= limit) break;
      urls.push(client.urlFor({
        searchQuery: built.encoded,
        idList: built.idList,
        start,
        maxResults: Math.min(pageSize, limit - start),
        sortBy: cfg.search.sortBy,
        sortOrder: cfg.search.sortOrder,
      }));
    }
    if (format === "url") return { text: urls.join("\n") + "\n", report: null };
    return { text: urls.join("\n") + "\n", report: null, dryRun: true, urls };
  }

  let result;
  let extras = {};
  if (kind === "get") {
    if (!spec.ids.length) throw new UsageError("get 命令必须提供 --id", { hint: "示例：--id 2501.00001" });
    result = await client.getByIds(spec.ids, { batchSize: cli["batch-size"], refresh: cli.refresh, cache: !cli["no-cache"] });
    extras = { command: "get" };
  } else if (kind === "update") {
    result = await client.update(spec, {
      sourceKey: cli["state-key"],
      limit: cfg.search.maxResults,
      pageSize: cfg.search.pageSize,
      maxPages: cfg.search.maxPages,
    });
    extras = { command: "update" };
  } else {
    if (!hasAnyCondition(spec)) {
      throw new UsageError("没有可执行的检索条件", {
        hint: '至少给一个：-k "关键词" / -a 作者 / -c cs.LG / --id 2501.00001 / -q "原始查询串"',
      });
    }
    result = await client.search(spec, {
      limit: cfg.search.maxResults,
      pageSize: cfg.search.pageSize,
      maxPages: cfg.search.maxPages,
      refresh: cli.refresh || cli["no-cache"],
      cache: !cli["no-cache"],
    });
  }

  // 分类拼写提醒（只提醒，不中止）
  const bad = categories.checkAll(spec.categories);
  if (bad.unknown.length || bad.malformed.length) {
    for (const s of bad.suggestions) {
      log.warn("分类可能拼错", { input: s.input, suggest: s.suggestions.map((x) => x.code).join("/") });
    }
    if (bad.unknown.length) log.warn("以下分类不在内置目录中（可能仍合法，但请核对大小写）", { codes: bad.unknown.join(",") });
  }

  const enrichWanted = cfg.enrich.versionHistory || cfg.enrich.references || cfg.enrich.citations;
  if (enrichWanted && result.entries && result.entries.length) {
    log.info("正在做增强抓取（版本历史 / 引用），可能较慢", { limit: cli["enrich-limit"] || 20 });
    result.entries = await client.enrich(result.entries, {
      versions: cfg.enrich.versionHistory,
      references: cfg.enrich.references,
      citations: cfg.enrich.citations,
      limit: cli["enrich-limit"],
    });
  }

  const entries = result.entries || [];
  const terms = resolveHighlightTerms(entries, cfg.analyze.highlightTerms, cfg.analyze.highlight);
  const analysis = buildAnalysis(entries, cfg, terms);

  const out = render(result, analysis, Object.assign({}, cfg, { output: Object.assign({}, cfg.output, { format }) }), {
    format,
    highlightTerms: terms,
    extras,
  });

  let reportPath = null;
  if (cfg.output.report) {
    reportPath = writeOut(cfg.output.report, renderReport(result, analysis, cfg, terms));
  }

  // 日志只带当前命令真正有意义的字段（把 undefined 打出来会误导排查）
  const doneCtx = { entries: entries.length };
  if (result.fetched != null) doneCtx.fetched = result.fetched;
  if (result.pages != null) doneCtx.pages = result.pages;
  if (result.fromCache) doneCtx.fromCache = true;
  if (result.totalResults != null) doneCtx.total = result.totalResults;
  if (result.newCount != null) doneCtx.newCount = result.newCount;
  if (result.duplicatesRemoved) doneCtx.deduped = result.duplicatesRemoved;
  log.info("完成", doneCtx);

  return { text: out.stdoutText, report: reportPath, result, analysis, terms };
}

/* ------------------------------ 各命令 ------------------------------ */

async function cmdSearch(cli, cfg, log, io) { return runQuery("search", cli, cfg, log, io); }
async function cmdGet(cli, cfg, log, io) { return runQuery("get", cli, cfg, log, io); }
async function cmdUpdate(cli, cfg, log, io) { return runQuery("update", cli, cfg, log, io); }

async function cmdStats(cli, cfg, log, io) {
  const effective = JSON.parse(JSON.stringify(cfg));
  effective.output.format = cli.format || "md";
  effective.analyze.stats = true;
  if (cli.cluster === undefined) effective.analyze.cluster = { enabled: true, k: 0 };
  effective.output.maxEntries = cfg.output.maxEntries || 0;
  const r = await runQuery("search", cli, effective, log, io);
  return r;
}

function cmdCategories(cli, cfg, log, io) {
  const check = (cli.check || []).concat(cli.category || []).concat(cli._positionals || []);
  if (check.length) {
    const res = categories.checkAll(check);
    const lines = [];
    for (const c of check) {
      const v = categories.validate(c);
      if (v.ok) lines.push("✓ " + c + "  " + (categories.get(c) || {}).name);
      else {
        const sug = categories.suggest(c).map((x) => x.code + " (" + x.name + ")");
        lines.push("✗ " + c + (v.shape ? " 不在内置目录" : " 格式不合法") + (sug.length ? "  → 可能是：" + sug.join(" / ") : ""));
      }
    }
    if (res.unknown.length || res.malformed.length) {
      log.warn("存在需要核对的分类", { unknown: res.unknown.length, malformed: res.malformed.length });
    }
    return { text: lines.join("\n") + "\n", report: null };
  }

  const groups = categories.groupByArchive();
  const lines = ["arXiv 分类目录（内置常用集，共 " + categories.list().length + " 条）", ""];
  for (const arch of Object.keys(groups).sort()) {
    lines.push("[" + arch + "]");
    for (const c of groups[arch]) lines.push("  " + c.code.padEnd(22) + c.name);
    lines.push("");
  }
  lines.push("提示：校验用 `" + PROG + " categories --check cs.LG,cs.NLP`");
  return { text: lines.join("\n") + "\n", report: null };
}

function cmdCache(cli, cfg, log, io) {
  const sub = (cli._positionals || [])[0] || "stats";
  const c = new Cache({ dir: cfg.cache.dir, ttlMs: cfg.cache.ttlMs, maxEntries: cfg.cache.maxEntries, logger: log, enabled: cfg.cache.enabled });
  const st = new StateStore({ dir: cfg.cache.dir, logger: log });

  if (sub === "stats") {
    const s = c.stats();
    const lines = [
      "缓存目录   " + s.dir,
      "状态       " + (s.enabled ? (s.available ? "启用" : "不可写（已降级）") : "已禁用"),
      "条目数     " + s.entries + " / " + s.maxEntries,
      "占用       " + s.bytesHuman,
      "有效期     " + Math.round(s.ttlMs / 1000) + " 秒",
      "命中/未命中 " + s.hits + " / " + s.misses + "（命中率 " + Math.round(s.hitRate * 100) + "%）",
      "合并/淘汰   " + s.writes + " / " + s.evictions,
      "最早/最新   " + (s.oldestAt || "-") + "  " + (s.newestAt || "-"),
      "",
      "增量状态   " + st.summary().file,
      "状态源数   " + st.summary().sources + "  更新于 " + (st.summary().updatedAt || "-"),
    ];
    for (const d of st.summary().detail) lines.push("  - " + d.key.slice(0, 60) + "  已见 " + d.seen + " 条，上次 " + (d.lastRunAt || "-"));
    return { text: lines.join("\n") + "\n", report: null };
  }
  if (sub === "clear") {
    const r = c.clear();
    return { text: "已清空缓存：" + r.files + " 个文件（增量状态未动，如需重置用 cache reset）\n", report: null };
  }
  if (sub === "prune") {
    const r = c.prune();
    return { text: "清理完成：过期 " + r.expired + "，淘汰 " + r.evicted + "\n", report: null };
  }
  if (sub === "state") {
    const s = st.summary();
    return { text: JSON.stringify(s, null, 2) + "\n", report: null };
  }
  if (sub === "reset") {
    const key = (cli._positionals || [])[1] || "";
    st.reset(key || undefined);
    return { text: "增量状态已重置：" + (key || "全部") + "\n", report: null };
  }
  throw new UsageError("cache 的子命令只能是 stats / clear / prune / state / reset", { hint: "示例：" + PROG + " cache stats" });
}

async function cmdCheck(cli, cfg, log, io) {
  const lines = [];
  lines.push("1) 配置       OK（配置文件：" + ((cfg.__meta && cfg.__meta.configPath) || "无，使用默认值+环境变量") + "）");
  const cats = categories.list();
  lines.push("2) 分类目录   OK（" + cats.length + " 条内置分类）");
  const client = createClient({ config: cfg, logger: log });
  lines.push("3) 缓存目录   " + cfg.cache.dir);
  try {
    const probe = await client.probe();
    lines.push("4) 连通性     OK  HTTP " + probe.status + "，cs.LG 命中 " + probe.totalResults + " 条");
    if (probe.sample) lines.push("   样例        " + probe.sample.title.slice(0, 80) + "  (arXiv:" + probe.sample.arxivId + ")");
  } catch (e) {
    lines.push("4) 连通性     失败：" + e.message);
    if (e.hint) lines.push("   建议        " + e.hint);
    return { text: lines.join("\n") + "\n", report: null, error: e };
  }
  return { text: lines.join("\n") + "\n", report: null };
}

function cmdConfig(cli, cfg, log, io) {
  const out = Object.assign({}, cfg);
  return { text: JSON.stringify(out, null, 2) + "\n", report: null };
}

/* ------------------------------ 帮助 ------------------------------ */

function helpText() {
  const L = [];
  L.push(PROG + " " + VERSION + " — PaperPilot arXiv 工具包");
  L.push("");
  L.push("用法：");
  L.push("  " + PROG + " <command> [options]");
  L.push("");
  L.push("命令：");
  for (const k of Object.keys(COMMANDS)) {
    L.push("  " + k.padEnd(12) + COMMANDS[k].desc);
    L.push("  " + " ".repeat(12) + "例：" + COMMANDS[k].usage);
  }
  L.push("");
  const groups = {};
  for (const o of OPTIONS) {
    if (!groups[o.group]) groups[o.group] = [];
    groups[o.group].push(o);
  }
  L.push("选项：");
  for (const g of Object.keys(groups)) {
    L.push("");
    L.push("  【" + g + "】");
    for (const o of groups[g]) {
      const names = "--" + o.name + (o.alias ? ", -" + o.alias : "");
      L.push("    " + names.padEnd(26) + o.desc);
    }
  }
  L.push("");
  L.push("环境变量：ARXIV_BASE_URL / ARXIV_MIN_INTERVAL_MS / ARXIV_PAGE_SIZE / ARXIV_FORMAT /");
  L.push("          ARXIV_CACHE_DIR / ARXIV_CACHE_TTL_MS / ARXIV_NO_CACHE / ARXIV_LOG_LEVEL / ARXIV_S2 …");
  L.push("配置文件：./arxiv.config.json  →  ./.arxivrc.json  →  ~/.arxiv/config.json（就近优先）");
  L.push("");
  L.push("示例：");
  L.push("  " + PROG + " search -k \"retrieval augmented generation\" -c cs.CL --from 2025-01-01 --limit 100 -f json -o rag.json --report rag.md");
  L.push("  " + PROG + " search -k \"diffusion\" -c cs.CV --highlight --cluster 4 -f md");
  L.push("  " + PROG + " get --id 2501.00001,2501.00002 --with-versions -f json");
  L.push("  " + PROG + " update -c cs.LG --limit 200 -f json");
  L.push("  " + PROG + " search -q 'ti:\"sparse autoencoder\" AND cat:cs.LG' --dry-run");
  L.push("  " + PROG + " categories --check cs.LG,cs.NLP");
  L.push("  " + PROG + " cache stats");
  L.push("");
  L.push("退出码：0 成功 / 2 用法错误 / 3 网络错误 / 4 解析错误 / 5 配置错误 / 6 arXiv 业务错误");
  return L.join("\n") + "\n";
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * @param {string[]} argv 不含 node 与脚本路径
 * @param {{stdout?:object, stderr?:object}} [io]
 * @returns {Promise<number>} 退出码
 */
async function run(argv, io) {
  const out = (io && io.stdout) || process.stdout;
  const errStream = (io && io.stderr) || process.stderr;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    errStream.write("错误：" + e.message + (e.hint ? "\n提示：" + e.hint : "") + "\n");
    return exitCodeFor(e);
  }

  const cli = parsed.options;
  cli._positionals = parsed.positionals;

  if (cli.version) { out.write(VERSION + "\n"); return EXIT.OK; }
  const command = parsed.command || "search";
  if (cli.help || command === "help") { out.write(helpText()); return EXIT.OK; }

  let cfg;
  try {
    cfg = loadConfig({ cli: mapToConfig(cli), cwd: process.cwd(), configPath: cli.config });
  } catch (e) {
    errStream.write("配置错误：" + e.message + "\n");
    return exitCodeFor(e);
  }
  const log = makeLoggerFor(cfg, { stderr: errStream });

  if (cli["print-config"] || command === "config") {
    out.write(JSON.stringify(cfg, null, 2) + "\n");
    return EXIT.OK;
  }

  try {
    let r;
    switch (command) {
      case "search": r = await cmdSearch(cli, cfg, log); break;
      case "get": r = await cmdGet(cli, cfg, log); break;
      case "update": r = await cmdUpdate(cli, cfg, log); break;
      case "stats": r = await cmdStats(cli, cfg, log); break;
      case "categories": r = cmdCategories(cli, cfg, log); break;
      case "cache": r = cmdCache(cli, cfg, log); break;
      case "check": r = await cmdCheck(cli, cfg, log); break;
      default: {
        const guess = nearest(command, Object.keys(COMMANDS));
        throw new UsageError("未知命令：" + command, { hint: (guess ? "你是不是想用 " + guess + "？" : "") + "运行 " + PROG + " help 查看全部命令" });
      }
    }
    if (r && r.text != null) {
      // --out：把最终结果写文件而不是 stdout（stdout 只留日志以外的内容，便于管道组合）
      if (cfg.output.out && !r.dryRun) {
        const p = writeOut(cfg.output.out, r.text);
        log.info("结果已写入文件", { path: p, bytes: r.text.length });
      } else {
        out.write(r.text);
      }
    }
    if (r && r.report) log.info("报告已写入", { path: r.report });
    if (r && r.error) return exitCodeFor(r.error);
    return EXIT.OK;
  } catch (e) {
    if (e instanceof ArxivError) {
      errStream.write("失败：" + e.toLine() + "\n");
      if (log.isDebug && e.details) errStream.write(JSON.stringify(e.details, null, 2) + "\n");
    } else {
      errStream.write("未预期错误：" + ((e && e.stack) || e) + "\n");
    }
    return exitCodeFor(e);
  }
}

module.exports = { run, parseArgs, mapToConfig, toSpec, helpText, OPTIONS, COMMANDS, VERSION, LEVELS, PROG };
