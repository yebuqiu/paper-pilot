"use strict";

/**
 * PaperPilot arXiv 工具包 · 公共 API
 *
 * 用法（库）：
 *   const { createClient } = require("./src");
 *   const client = createClient({ configOverrides: { log: { level: "warn" } } });
 *   const res = await client.search({ keywords: ["retrieval augmented generation"], categories: ["cs.CL"] });
 *
 * 用法（CLI）：
 *   node bin/arxiv.js search -k "diffusion model" -c cs.LG --limit 50 -f json
 */

const errors = require("./errors");
const logger = require("./logger");
const config = require("./config");
const dates = require("./dates");
const query = require("./query");
const atom = require("./atom");
const categories = require("./categories");
const http = require("./http");
const rateLimiter = require("./rate-limiter");
const cache = require("./cache");
const client = require("./client");
const analyze = require("./analyze");
const exporters = require("./exporters");
const report = require("./report");
const versionHistory = require("./version-history");
const references = require("./references");

module.exports = Object.assign(
  {},
  errors,
  { createLogger: logger.createLogger, nullLogger: logger.nullLogger, LEVELS: logger.LEVELS },
  {
    DEFAULTS: config.DEFAULTS,
    loadConfig: config.loadConfig,
    validateConfig: config.validate,
  },
  {
    isDateLike: dates.isDateLike,
    toArxivStamp: dates.toArxivStamp,
    rangeClause: dates.rangeClause,
  },
  {
    QueryBuilder: query.QueryBuilder,
    buildQuery: query.buildQuery,
    buildUrl: query.buildUrl,
    FIELDS: query.FIELDS,
  },
  {
    parseAtom: atom.parseAtom,
    parseEntry: atom.parseEntry,
    dedupeEntries: atom.dedupeEntries,
    normalizeTitle: atom.normalizeTitle,
  },
  {
    listCategories: categories.list,
    groupCategories: categories.groupByArchive,
    validateCategory: categories.validate,
    suggestCategory: categories.suggest,
  },
  { createTransport: http.createTransport, request: http.request },
  { RateLimiter: rateLimiter.RateLimiter, backoffDelay: rateLimiter.backoffDelay },
  { Cache: cache.Cache, StateStore: cache.StateStore },
  { ArxivClient: client.ArxivClient, createClient: client.createClient },
  {
    tokenize: analyze.tokenize,
    highlight: analyze.highlight,
    highlightEntries: analyze.highlightEntries,
    splitStructuredAbstract: analyze.splitStructuredAbstract,
    categoryStats: analyze.categoryStats,
    dateHistogram: analyze.dateHistogram,
    extractKeywords: analyze.extractKeywords,
    clusterTopics: analyze.clusterTopics,
    analyze: analyze.analyze,
  },
  {
    toJSON: exporters.toJSON,
    toJSONL: exporters.toJSONL,
    toCSV: exporters.toCSV,
    toBibTeX: exporters.toBibTeX,
  },
  { toMarkdown: report.toMarkdown, toTerminal: report.toTerminal },
  { fetchVersionHistory: versionHistory.fetchVersionHistory },
  { fetchReferences: references.fetchReferences, fetchCitations: references.fetchCitations }
);
