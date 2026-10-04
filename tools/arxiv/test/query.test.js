"use strict";

const { test, assert, run } = require("./_harness");
const q = require("../src/query");
const dates = require("../src/dates");

test("单关键词：多词自动加引号（否则 arXiv 会语法错误）", () => {
  const r = q.buildQuery({ keywords: ["diffusion model"] });
  assert.strictEqual(r.query, 'all:"diffusion model"');
  assert.strictEqual(r.encoded, "all:%22diffusion+model%22");
});

test("单关键词：单字不加引号", () => {
  assert.strictEqual(q.buildQuery({ keywords: ["transformer"] }).query, "all:transformer");
});

test("--phrase 强制加引号（即使单字）", () => {
  assert.strictEqual(q.buildQuery({ keywords: ["transformer"], phrase: true }).query, 'all:"transformer"');
});

test("关键词支持 field:value 前缀", () => {
  assert.strictEqual(q.buildQuery({ keywords: ["ti:attention"] }).query, "ti:attention");
  assert.strictEqual(q.buildQuery({ keywords: ["abs:reinforcement learning"] }).query, 'abs:"reinforcement learning"');
});

test("未知字段前缀加引号（避免 arXiv 语法歧义），不当成字段", () => {
  assert.strictEqual(q.buildQuery({ keywords: ["zz:foo"] }).query, 'all:"zz:foo"');
});

test("关键词 + 分类：分类恒为 AND", () => {
  const r = q.buildQuery({ keywords: ["diffusion model"], categories: ["cs.LG"] });
  assert.strictEqual(r.query, 'all:"diffusion model" AND cat:cs.LG');
});

test("多分类默认 AND（交叉列表），categoryMode=OR 才是并集", () => {
  assert.strictEqual(q.buildQuery({ categories: ["cs.AI", "cs.CL"] }).query, "cat:cs.AI AND cat:cs.CL");
  assert.strictEqual(q.buildQuery({ categories: ["cs.AI", "cs.CL"], categoryMode: "OR" }).query, "(cat:cs.AI OR cat:cs.CL)");
  assert.strictEqual(q.buildQuery({ categories: ["cs.AI", "cs.CL", "cs.LG"], categoryMode: "or" }).query,
    "(cat:cs.AI OR cat:cs.CL OR cat:cs.LG)");
  // 单分类时无论哪种模式都不分组（无意义的多余括号）
  assert.strictEqual(q.buildQuery({ categories: ["cs.AI"], categoryMode: "OR" }).query, "cat:cs.AI");
});

test("OR 组合必须显式加括号（否则与后续分类条件优先级错误）", () => {
  const r = q.buildQuery({ keywords: ["a", "b"], categories: ["cs.LG"], boolean: "OR" });
  assert.strictEqual(r.query, "(all:a OR all:b) AND cat:cs.LG");
  assert.strictEqual(r.encoded, "(all:a+OR+all:b)+AND+cat:cs.LG");
});

test("作者多词自动加引号", () => {
  assert.strictEqual(q.buildQuery({ authors: ["Yoshua Bengio"] }).query, 'au:"Yoshua Bengio"');
});

test("日期区间：下界补 0000、上界补 2359（否则会漏掉最后一天）", () => {
  const r = q.buildQuery({ dateFrom: "2025-01-01", dateTo: "2025-01-31", categories: ["cs.CL"] });
  assert.strictEqual(r.query, "cat:cs.CL AND submittedDate:[202501010000 TO 202501312359]");
});

test("日期区间：只给 --from 时上界开放（自该时刻起），不会误缩成一天", () => {
  assert.strictEqual(dates.rangeClause("submittedDate", "2025-01-01", ""), "submittedDate:[202501010000 TO 999912312359]");
  assert.strictEqual(dates.rangeClause("submittedDate", "", "2025-01-31"), "submittedDate:[000101010000 TO 202501312359]");
  // 要表达「某一整月」必须显式给出两端
  assert.strictEqual(dates.rangeClause("submittedDate", "2025-01", "2025-01"), "submittedDate:[202501010000 TO 202501312359]");
});

test("日期：12 位与 8 位压缩格式直通", () => {
  assert.strictEqual(dates.toArxivStamp("202501011200", "start"), "202501011200");
  assert.strictEqual(dates.toArxivStamp("20250101", "end"), "202501012359");
});

test("非法日期抛 ConfigError（且给出示例）", () => {
  assert.throws(() => dates.toArxivStamp("Jan 2025"), /无法解析的日期/);
});

test("排除条件用 ANDNOT", () => {
  const r = q.buildQuery({ categories: ["cs.LG"], excludeCategories: ["cs.CV"], excludeKeywords: ["survey"] });
  assert.strictEqual(r.query, "cat:cs.LG ANDNOT cat:cs.CV ANDNOT all:survey");
});

test("ID 走 id_list 参数，不污染 search_query", () => {
  const r = q.buildQuery({ ids: ["2501.00001", "https://arxiv.org/abs/2501.00002v3"] });
  assert.strictEqual(r.idList, "2501.00001,https://arxiv.org/abs/2501.00002v3");
  assert.strictEqual(r.query, "");
  assert.strictEqual(r.isEmpty, false);
});

test("无任何条件时 isEmpty=true", () => {
  const r = q.buildQuery({});
  assert.strictEqual(r.isEmpty, true);
  assert.strictEqual(r.query, "");
});

test("原始查询串与结构化条件 AND 组合", () => {
  const r = q.buildQuery({ raw: 'ti:"sparse autoencoder"', categories: ["cs.LG"] });
  assert.strictEqual(r.query, 'ti:"sparse autoencoder" AND cat:cs.LG');
});

test("检索词里的双引号被清洗并触发引号包裹（不破坏语法）", () => {
  assert.strictEqual(q.buildQuery({ keywords: ['foo"bar'] }).query, 'all:"foo bar"');
});

test("原始查询串保留引号与括号（不得被转义）", () => {
  const r = q.buildQuery({ raw: 'ti:"sparse autoencoder" AND cat:cs.LG' });
  assert.strictEqual(r.query, 'ti:"sparse autoencoder" AND cat:cs.LG');
  assert.strictEqual(r.encoded, "ti:%22sparse+autoencoder%22+AND+cat:cs.LG");
});

test("encodeQuery：空格→+，引号→%22，括号保留", () => {
  assert.strictEqual(q.encodeQuery('(a AND b)'), "(a+AND+b)");
  assert.strictEqual(q.encodeQuery('ti:"x y"'), "ti:%22x+y%22");
  assert.strictEqual(q.encodeQuery("a&b"), "a%26b");
  assert.strictEqual(q.encodeQuery("100%"), "100%25");
});

test("buildUrl 组装完整请求参数", () => {
  const url = q.buildUrl({
    baseUrl: "https://example.org/api/query",
    searchQuery: "cat:cs.LG",
    start: 100,
    maxResults: 50,
    sortBy: "submittedDate",
    sortOrder: "descending",
  });
  assert.strictEqual(url, "https://example.org/api/query?search_query=cat:cs.LG&start=100&max_results=50&sortBy=submittedDate&sortOrder=descending");
});

test("QueryBuilder 链式 API 与分组", () => {
  const qb = new q.QueryBuilder();
  qb.field("cat", "cs.LG").and().group((g) => {
    g.field("ti", "attention").or().field("abs", "attention");
  });
  assert.strictEqual(qb.toString(), "cat:cs.LG AND (ti:attention OR abs:attention)");
});

test("QueryBuilder 未知字段抛 ConfigError", () => {
  assert.throws(() => new q.QueryBuilder().field("zz", "x"), /未知的检索字段前缀/);
});

test("fieldClause 引号三态：强制/禁止/自动", () => {
  assert.strictEqual(q.fieldClause("ti", "x y", { quote: true }), 'ti:"x y"');
  assert.strictEqual(q.fieldClause("all", "x y", { quote: false }), "all:x y");
  assert.strictEqual(q.fieldClause("all", "x y"), 'all:"x y"');
  assert.strictEqual(q.fieldClause("cat", "cs.LG"), "cat:cs.LG");
});

run("query");
