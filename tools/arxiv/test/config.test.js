"use strict";

const fs = require("fs");
const path = require("path");
const { test, assert, run, tmpDir, rmTemp } = require("./_harness");
const { loadConfig, DEFAULTS, deepMerge, getAtPath, setAtPath } = require("../src/config");

test("默认值：无配置文件、无环境变量时等于内置默认", () => {
  const empty = tmpDir("pp-cfg-");
  try {
    const cfg = loadConfig({ cwd: empty, env: {}, cli: {} });
    assert.strictEqual(cfg.api.baseUrl, DEFAULTS.api.baseUrl);
    assert.strictEqual(cfg.request.minIntervalMs, 3000, "arXiv 礼节：默认 3 秒一次");
    assert.strictEqual(cfg.search.pageSize, 100);
    assert.strictEqual(cfg.cache.enabled, true);
    assert.strictEqual(cfg.__meta.configPath, null);
  } finally { rmTemp(empty); }
});

test("配置文件：读取并深合并（未覆盖的键保留默认）", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    fs.writeFileSync(path.join(dir, "arxiv.config.json"), JSON.stringify({
      search: { pageSize: 50, sortBy: "relevance" },
      log: { level: "debug" },
    }));
    const cfg = loadConfig({ cwd: dir, env: {}, cli: {} });
    assert.strictEqual(cfg.search.pageSize, 50);
    assert.strictEqual(cfg.search.sortBy, "relevance");
    assert.strictEqual(cfg.search.maxResults, DEFAULTS.search.maxResults, "未指定的键应保留默认");
    assert.strictEqual(cfg.log.level, "debug");
    assert.ok(cfg.__meta.configPath.endsWith("arxiv.config.json"));
  } finally { rmTemp(dir); }
});

test("配置文件：容忍 BOM 与 // 行注释", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    fs.writeFileSync(path.join(dir, "arxiv.config.json"), "\uFEFF{\n  // 注释行\n  \"log\": { \"level\": \"warn\" }\n}\n");
    const cfg = loadConfig({ cwd: dir, env: {}, cli: {} });
    assert.strictEqual(cfg.log.level, "warn");
  } finally { rmTemp(dir); }
});

test("优先级：CLI > 环境变量 > 配置文件 > 默认", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    fs.writeFileSync(path.join(dir, "arxiv.config.json"), JSON.stringify({ search: { pageSize: 10 } }));
    const cfg = loadConfig({
      cwd: dir,
      env: { ARXIV_PAGE_SIZE: "20" },
      cli: { search: { pageSize: 30 } },
    });
    assert.strictEqual(cfg.search.pageSize, 30, "CLI 优先级最高");
    const cfg2 = loadConfig({ cwd: dir, env: { ARXIV_PAGE_SIZE: "20" }, cli: {} });
    assert.strictEqual(cfg2.search.pageSize, 20, "环境变量次之");
    const cfg3 = loadConfig({ cwd: dir, env: {}, cli: {} });
    assert.strictEqual(cfg3.search.pageSize, 10, "配置文件再次之");
  } finally { rmTemp(dir); }
});

test("环境变量：数字 / 布尔 / 反布尔 / 字符串 解析", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    const cfg = loadConfig({
      cwd: dir,
      env: {
        ARXIV_TIMEOUT_MS: "12345",
        ARXIV_LOG_JSON: "1",
        ARXIV_NO_CACHE: "true",
        ARXIV_FORMAT: "csv",
        ARXIV_BASE_URL: "http://127.0.0.1:9999/api/query",
      },
      cli: {},
    });
    assert.strictEqual(cfg.request.timeoutMs, 12345);
    assert.strictEqual(cfg.log.json, true);
    assert.strictEqual(cfg.cache.enabled, false, "ARXIV_NO_CACHE 应取反");
    assert.strictEqual(cfg.output.format, "csv");
    assert.strictEqual(cfg.api.baseUrl, "http://127.0.0.1:9999/api/query");
  } finally { rmTemp(dir); }
});

test("环境变量：非法数字直接报错（而不是静默变 NaN）", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    assert.throws(() => loadConfig({ cwd: dir, env: { ARXIV_TIMEOUT_MS: "abc" }, cli: {} }), /需要数字/);
  } finally { rmTemp(dir); }
});

test("显式指定的配置文件不存在 → ConfigError", () => {
  assert.throws(() => loadConfig({ cwd: process.cwd(), env: {}, cli: {}, configPath: "E:/definitely/not/here.json" }), /配置文件不存在/);
});

test("配置文件 JSON 损坏 → ConfigError 且指出路径", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    fs.writeFileSync(path.join(dir, "arxiv.config.json"), "{ not json ");
    assert.throws(() => loadConfig({ cwd: dir, env: {}, cli: {} }), /JSON 解析失败/);
  } finally { rmTemp(dir); }
});

test("校验：非法 sortBy / format / log.level 被拒绝", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    assert.throws(() => loadConfig({ cwd: dir, env: {}, cli: { search: { sortBy: "stars" } } }), /search.sortBy/);
    assert.throws(() => loadConfig({ cwd: dir, env: {}, cli: { output: { format: "yaml" } } }), /output.format/);
    assert.throws(() => loadConfig({ cwd: dir, env: {}, cli: { log: { level: "trace" } } }), /log.level/);
    assert.throws(() => loadConfig({ cwd: dir, env: {}, cli: { request: { timeoutMs: 10 } } }), /request.timeoutMs/);
  } finally { rmTemp(dir); }
});

test("校验：pageSize > 2000 被夹取（arXiv 单次上限），maxResults > 30000 同理", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    const cfg = loadConfig({ cwd: dir, env: {}, cli: { search: { pageSize: 9999, maxResults: 99999 } } });
    assert.strictEqual(cfg.search.pageSize, 2000);
    assert.strictEqual(cfg.search.maxResults, 30000);
  } finally { rmTemp(dir); }
});

test("校验：baseUrl 必须是 http(s)", () => {
  const dir = tmpDir("pp-cfg-");
  try {
    assert.throws(() => loadConfig({ cwd: dir, env: {}, cli: { api: { baseUrl: "ftp://x" } } }), /api.baseUrl/);
  } finally { rmTemp(dir); }
});

test("工具函数：deepMerge 对数组整体覆盖而非按下标合并", () => {
  const out = deepMerge({ a: [1, 2, 3], b: { c: 1 } }, { a: [9], b: { d: 2 } });
  assert.deepStrictEqual(out.a, [9]);
  assert.deepStrictEqual(out.b, { c: 1, d: 2 });
});

test("工具函数：get/setAtPath", () => {
  const o = {};
  setAtPath(o, "x.y.z", 5);
  assert.strictEqual(getAtPath(o, "x.y.z"), 5);
  assert.strictEqual(getAtPath(o, "x.nope.z"), undefined);
});

run("config");
