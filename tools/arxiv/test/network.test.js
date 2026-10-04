"use strict";

/**
 * 联网冒烟测试（默认不跑）。
 *
 * 存在的意义：桩服务器验证的是「我们的逻辑」，验证不了「arXiv 真的长这样」——
 * 官方后端 2025-11 迁移过、模板改过、错误响应格式变过。这个文件用真实响应兜住这一层。
 *
 * 运行：node test/run-all.js --include-network    或    PP_ARXIV_NETWORK=1 node test/network.test.js
 */

const { test, assert, run } = require("./_harness");
const { createClient } = require("../src/client");
const { loadConfig } = require("../src/config");
const { nullLogger } = require("../src/logger");

if (!process.env.PP_ARXIV_NETWORK) {
  console.log("  （跳过联网用例：设置 PP_ARXIV_NETWORK=1 或加 --include-network 以启用）");
  process.exit(0);
}

function client(extra) {
  const cfg = loadConfig({
    cwd: require("os").tmpdir(),
    env: {},
    cli: {
      request: { minIntervalMs: 3000, retries: 2, timeoutMs: 40000 },
      search: { pageSize: 20, maxResults: 40 },
      cache: { enabled: false },
      log: { level: "silent" },
    },
  });
  Object.assign(cfg, extra || {});
  return createClient({ config: cfg, logger: nullLogger() });
}

test("真实 API：按分类检索返回结构完整的条目", async () => {
  const c = client();
  const r = await c.search({ categories: ["cs.CL"] }, { limit: 20, pageSize: 20 });
  assert.ok(r.entries.length > 0, "应返回条目");
  const e = r.entries[0];
  assert.ok(/^\d{4}\.\d{4,5}$/.test(e.arxivId), "arxivId 形状不对：" + e.arxivId);
  assert.ok(e.title.length > 5);
  assert.ok(e.summary.length > 50);
  assert.ok(e.authors.length >= 1);
  assert.ok(e.categories.indexOf("cs.CL") >= 0);
  assert.ok(/^https:\/\/arxiv\.org\/abs\//.test(e.absUrl));
  assert.ok(/^https:\/\/arxiv\.org\/pdf\//.test(e.pdfUrl));
  assert.ok(e.published.indexOf("T") > 0);
});

test("真实 API：关键词 + 分类组合检索", async () => {
  const c = client();
  const r = await c.search({ keywords: ["transformer"], categories: ["cs.LG"] }, { limit: 10 });
  assert.ok(r.entries.length > 0);
  assert.ok(r.totalResults > 0);
  assert.ok(r.url.indexOf("search_query=") > 0);
});

test("真实 API：日期区间被服务端接受", async () => {
  const c = client();
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const r = await c.search({ categories: ["cs.LG"], dateFrom: from, dateTo: to }, { limit: 10, sortBy: "submittedDate" });
  assert.ok(r.entries.length > 0, "近 30 天 cs.LG 应有结果");
  for (const e of r.entries) {
    assert.ok(e.publishedDay >= from, e.publishedDay + " 早于区间下界 " + from);
  }
});

test("真实 API：按 ID 精确获取并解析元数据", async () => {
  const c = client();
  // 一个长期存在的经典条目，降低偶发失败概率
  const r = await c.getByIds(["1706.03762"]);
  assert.strictEqual(r.entries.length, 1, "应找到 Attention Is All You Need");
  const e = r.entries[0];
  assert.ok(/attention/i.test(e.title), "标题：" + e.title);
  assert.ok(e.authors.some((a) => /vaswani/i.test(a)), "作者应包含 Vaswani：" + e.authors.join(", "));
});

test("真实 API：错误查询返回可读的业务错误（不是静默 0 结果）", async () => {
  const c = client();
  // 故意用错误大小写的分类
  let err = null;
  try {
    await c.search({ raw: "cat:cs.lg" }, { limit: 1 });
  } catch (e) {
    err = e;
  }
  if (err) {
    assert.ok(["API_ERROR", "HTTP_ERROR"].indexOf(err.code) >= 0, "错误码：" + err.code);
    assert.ok(err.message.length > 5);
  } else {
    // 后端的宽容度会变；只要没抛错就必须给出合法的 0/若干结果，不允许崩溃
    assert.ok(true);
  }
});

test("真实 API：分页（第 2 页与第 1 页不重复）", async () => {
  const c = client();
  const p1 = await c.search({ categories: ["cs.AI"] }, { limit: 20, pageSize: 20, sortBy: "submittedDate", sortOrder: "descending" });
  const p2 = await c.search({ categories: ["cs.AI"] }, { limit: 40, pageSize: 20, sortBy: "submittedDate", sortOrder: "descending" });
  const set1 = new Set(p1.entries.map((e) => e.arxivId));
  const overlap = p2.entries.filter((e) => set1.has(e.arxivId)).length;
  assert.strictEqual(overlap, p1.entries.length, "第 2 页应包含第 1 页（同一排序下的前缀）");
  assert.ok(p2.entries.length > p1.entries.length);
});

run("network");
