"use strict";

/**
 * 配置解析：默认值 ← 配置文件 ← 环境变量 ← 命令行。
 *
 * 优先级刻意做成「越靠近当前这一次调用越高」，便于同一份配置文件在 CI 里被 env 覆盖、又被临时 CLI 参数再覆盖。
 * 所有校验集中在 validate()，非法值抛 ConfigError 并在消息里点名到具体字段路径（a.b.c）。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ConfigError } = require("./errors");
const { isLevel } = require("./logger");
const { isDateLike } = require("./dates");

const SORT_BY = ["relevance", "lastUpdatedDate", "submittedDate"];
const SORT_ORDER = ["ascending", "descending"];
const FORMATS = ["md", "json", "jsonl", "csv", "bibtex", "table", "url"];

const DEFAULTS = {
  api: {
    baseUrl: "https://export.arxiv.org/api/query",
    absBaseUrl: "https://arxiv.org/abs",
    userAgent: "PaperPilot-arXiv-Toolkit/1.0 (+https://github.com/yebuqiu/paper-pilot)",
  },
  request: {
    timeoutMs: 30000,
    retries: 3,
    backoffBaseMs: 1200,
    backoffMaxMs: 30000,
    // arXiv 官方礼节：每 3 秒不超过 1 次请求、同时只保持 1 条连接。
    minIntervalMs: 3000,
    maxConcurrent: 1,
  },
  search: {
    pageSize: 100,
    maxResults: 2000,
    maxPages: 20,
    sortBy: "submittedDate",
    sortOrder: "descending",
  },
  cache: {
    enabled: true,
    dir: ".arxiv-cache",
    ttlMs: 86400000,
    maxEntries: 500,
  },
  output: {
    format: "md",
    out: null,
    report: null,
    pretty: true,
    // 报告侧截断（结构化导出不受影响）：0 = 不限制列出条数
    maxEntries: 0,
    maxAbstract: 700,
  },
  log: {
    level: "info",
    json: false,
  },
  analyze: {
    highlight: false,
    highlightTerms: [],
    highlightMark: "**",
    structuredAbstract: true,
    stats: true,
    cluster: { enabled: false, k: 0, maxTerms: 6 },
  },
  enrich: {
    versionHistory: false,
    references: false,
    citations: false,
    s2BaseUrl: "https://api.semanticscholar.org/graph/v1",
    s2MinIntervalMs: 1200,
  },
  dedupe: {
    byId: true,
    byDoi: true,
    byTitle: true,
  },
};

/** 环境变量 → 配置路径映射。`kind` 决定解析方式。 */
const ENV_MAP = [
  ["ARXIV_BASE_URL", "api.baseUrl", "string"],
  ["ARXIV_ABS_BASE_URL", "api.absBaseUrl", "string"],
  ["ARXIV_USER_AGENT", "api.userAgent", "string"],
  ["ARXIV_TIMEOUT_MS", "request.timeoutMs", "number"],
  ["ARXIV_RETRIES", "request.retries", "number"],
  ["ARXIV_BACKOFF_BASE_MS", "request.backoffBaseMs", "number"],
  ["ARXIV_BACKOFF_MAX_MS", "request.backoffMaxMs", "number"],
  ["ARXIV_MIN_INTERVAL_MS", "request.minIntervalMs", "number"],
  ["ARXIV_CONCURRENCY", "request.maxConcurrent", "number"],
  ["ARXIV_PAGE_SIZE", "search.pageSize", "number"],
  ["ARXIV_MAX_RESULTS", "search.maxResults", "number"],
  ["ARXIV_MAX_PAGES", "search.maxPages", "number"],
  ["ARXIV_SORT_BY", "search.sortBy", "string"],
  ["ARXIV_SORT_ORDER", "search.sortOrder", "string"],
  ["ARXIV_CACHE_DIR", "cache.dir", "string"],
  ["ARXIV_CACHE_TTL_MS", "cache.ttlMs", "number"],
  ["ARXIV_NO_CACHE", "cache.enabled", "bool-invert"],
  ["ARXIV_FORMAT", "output.format", "string"],
  ["ARXIV_PRETTY", "output.pretty", "bool"],
  ["ARXIV_LOG_LEVEL", "log.level", "string"],
  ["ARXIV_LOG_JSON", "log.json", "bool"],
  ["ARXIV_HIGHLIGHT", "analyze.highlight", "bool"],
  ["ARXIV_CLUSTER", "analyze.cluster.enabled", "bool"],
  ["ARXIV_VERSIONS", "enrich.versionHistory", "bool"],
  ["ARXIV_S2", "enrich.s2Enabled", "bool"],
];

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** 深合并：只对纯对象递归，数组与标量整体覆盖（避免数组下标合并这种反直觉行为）。 */
function deepMerge(base, patch) {
  const out = isPlainObject(base) ? Object.assign({}, base) : {};
  if (!isPlainObject(patch)) return out;
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (isPlainObject(pv) && isPlainObject(out[k])) out[k] = deepMerge(out[k], pv);
    else if (pv !== undefined) out[k] = pv;
  }
  return out;
}

function getAtPath(obj, dotted) {
  const parts = String(dotted).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAtPath(obj, dotted, value) {
  const parts = String(dotted).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function parseEnvValue(raw, kind) {
  const s = String(raw);
  switch (kind) {
    case "number": {
      const n = Number(s);
      if (!isFinite(n)) throw new ConfigError("环境变量需要数字，收到：" + s);
      return n;
    }
    case "bool":
      return !/^(0|false|no|off|)$/i.test(s.trim());
    case "bool-invert":
      return !(!/^(0|false|no|off|)$/i.test(s.trim()));
    case "list":
      return s.split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
    default:
      return s;
  }
}

/** 候选配置文件（按优先级）。 */
function candidateConfigPaths(cwd) {
  const home = os.homedir();
  return [
    path.join(cwd || process.cwd(), "arxiv.config.json"),
    path.join(cwd || process.cwd(), ".arxivrc.json"),
    path.join(home, ".arxiv", "config.json"),
  ];
}

/**
 * @param {{cli?:object, env?:object, cwd?:string, configPath?:string, home?:string}} [opts]
 * @returns {object} 校验通过的完整配置（含 `__meta.configPath` 记录来源）
 */
function loadConfig(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();

  let cfg = deepClone(DEFAULTS);
  let usedPath = null;

  // 1) 配置文件
  const explicit = o.configPath || (o.cli && o.cli.config) || env.ARXIV_CONFIG || null;
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    if (!fs.existsSync(p)) throw new ConfigError("配置文件不存在：" + p);
    usedPath = p;
    cfg = deepMerge(cfg, readConfigFile(p));
  } else {
    for (const cand of candidateConfigPaths(cwd)) {
      if (fs.existsSync(cand)) {
        usedPath = cand;
        cfg = deepMerge(cfg, readConfigFile(cand));
        break;
      }
    }
  }

  // 2) 环境变量
  for (const [name, target, kind] of ENV_MAP) {
    if (target == null) continue;
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    setAtPath(cfg, target, parseEnvValue(raw, kind));
  }

  // 3) CLI（已由 cli.js 归一化成嵌套对象）
  if (o.cli) {
    const clean = deepClone(o.cli);
    delete clean.config;
    delete clean.command;
    delete clean._;
    cfg = deepMerge(cfg, clean);
  }

  cfg.__meta = { configPath: usedPath };
  resolvePaths(cfg, cwd);
  validate(cfg);
  return cfg;
}

function readConfigFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (e) { throw new ConfigError("读取配置文件失败：" + p + " — " + e.message, { cause: e }); }
  // 容忍 BOM 与 // 行注释（JSONC-lite：只处理行首 // 与整行注释，不碰字符串内部）
  const text = raw.replace(/^\uFEFF/, "").replace(/^[ \t]*\/\/.*$/gm, "");
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error("顶层必须是对象");
    return parsed;
  } catch (e) {
    throw new ConfigError("配置文件 JSON 解析失败：" + p + " — " + e.message, { cause: e });
  }
}

/** 把相对路径（cache.dir）落到绝对路径。 */
function resolvePaths(cfg, cwd) {
  if (cfg.cache && cfg.cache.dir && !path.isAbsolute(cfg.cache.dir)) {
    cfg.cache.dir = path.resolve(cwd, cfg.cache.dir);
  }
  return cfg;
}

function fail(field, msg) {
  throw new ConfigError("配置项 " + field + " " + msg);
}

function num(field, v, min, max) {
  if (typeof v !== "number" || !isFinite(v)) fail(field, "必须是数字，当前为 " + JSON.stringify(v));
  if (v < min || v > max) fail(field, "必须在 " + min + " ~ " + max + " 之间，当前为 " + v);
}

/** 校验并就地修正（部分超界值会被夹取而非报错，见注释）。 */
function validate(cfg) {
  if (!/^https?:\/\//.test(String(cfg.api.baseUrl || ""))) fail("api.baseUrl", "必须是 http(s) URL");
  if (!String(cfg.api.userAgent || "").trim()) fail("api.userAgent", "不能为空（arXiv 要求带可识别 UA）");

  num("request.timeoutMs", cfg.request.timeoutMs, 1000, 600000);
  num("request.retries", cfg.request.retries, 0, 10);
  num("request.backoffBaseMs", cfg.request.backoffBaseMs, 0, 60000);
  num("request.backoffMaxMs", cfg.request.backoffMaxMs, 0, 600000);
  num("request.minIntervalMs", cfg.request.minIntervalMs, 0, 600000);
  num("request.maxConcurrent", cfg.request.maxConcurrent, 1, 16);

  // pageSize 上限 = arXiv 单次 max_results 上限 2000，超界夹取（好过直接失败，用户意图明确）
  if (typeof cfg.search.pageSize !== "number" || !isFinite(cfg.search.pageSize) || cfg.search.pageSize < 1) {
    fail("search.pageSize", "必须 ≥ 1");
  }
  if (cfg.search.pageSize > 2000) cfg.search.pageSize = 2000;
  if (typeof cfg.search.maxResults !== "number" || !isFinite(cfg.search.maxResults) || cfg.search.maxResults < 1) {
    fail("search.maxResults", "必须 ≥ 1");
  }
  // arXiv 分页总量硬上限 30000（超出返回 400）
  if (cfg.search.maxResults > 30000) cfg.search.maxResults = 30000;
  num("search.maxPages", cfg.search.maxPages, 1, 500);
  if (SORT_BY.indexOf(cfg.search.sortBy) < 0) fail("search.sortBy", "只能是 " + SORT_BY.join(" / "));
  if (SORT_ORDER.indexOf(cfg.search.sortOrder) < 0) fail("search.sortOrder", "只能是 " + SORT_ORDER.join(" / "));

  if (typeof cfg.cache.enabled !== "boolean") fail("cache.enabled", "必须是布尔值");
  if (!String(cfg.cache.dir || "").trim()) fail("cache.dir", "不能为空");
  num("cache.ttlMs", cfg.cache.ttlMs, 0, 31536000000);
  num("cache.maxEntries", cfg.cache.maxEntries, 1, 100000);

  if (FORMATS.indexOf(cfg.output.format) < 0) fail("output.format", "只能是 " + FORMATS.join(" / "));
  if (!isLevel(cfg.log.level)) fail("log.level", "只能是 silent / error / warn / info / debug");

  if (cfg.analyze.highlightTerms != null && !Array.isArray(cfg.analyze.highlightTerms)) {
    fail("analyze.highlightTerms", "必须是字符串数组");
  }
  if (cfg.analyze.highlightMark != null && typeof cfg.analyze.highlightMark !== "string") {
    fail("analyze.highlightMark", "必须是字符串");
  }
  if (cfg.analyze.cluster && cfg.analyze.cluster.k != null) {
    num("analyze.cluster.k", cfg.analyze.cluster.k, 0, 50);
  }
  num("enrich.s2MinIntervalMs", cfg.enrich.s2MinIntervalMs, 0, 600000);
  return cfg;
}

module.exports = {
  DEFAULTS,
  ENV_MAP,
  FORMATS,
  SORT_BY,
  SORT_ORDER,
  loadConfig,
  validate,
  deepMerge,
  deepClone,
  getAtPath,
  setAtPath,
  isPlainObject,
  candidateConfigPaths,
  readConfigFile,
};
