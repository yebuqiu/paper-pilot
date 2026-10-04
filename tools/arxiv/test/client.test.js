"use strict";

/**
 * 客户端集成测试：**不碰外网**。
 *
 * 起一个本地 http 桩服务器扮演 arXiv（同样的 URL 参数、同样的 Atom 响应），
 * 再注入 baseUrl 指向 127.0.0.1，就能真实走通：限速 → 重试 → 分页 → 解析 → 去重 → 缓存
 * → 增量更新 → 增强抓取。相比 mock 掉 transport 函数，这样能同时验证 http.js、
 * URL 组装与真实的分页游标推进逻辑。
 */

const http = require("http");
const path = require("path");
const { test, assert, run, tmpDir, rmTemp } = require("./_harness");
const { ArxivClient } = require("../src/client");
const { loadConfig } = require("../src/config");
const { nullLogger } = require("../src/logger");

/* ------------------------------ 桩服务器 ------------------------------ */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function entryXml(e) {
  const v = e.version || 1;
  return `
  <entry>
    <id>http://arxiv.org/abs/${e.id}v${v}</id>
    <title>${esc(e.title)}</title>
    <updated>${e.updated}</updated>
    <published>${e.published}</published>
    <link href="https://arxiv.org/abs/${e.id}v${v}" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/${e.id}v${v}" rel="related" type="application/pdf" title="pdf"/>
    <summary>${esc(e.summary || "Summary of " + e.title)}</summary>
    <category term="${e.cat || "cs.LG"}" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:primary_category term="${e.cat || "cs.LG"}"/>
    <author><name>Author ${e.id}</name></author>
  </entry>`;
}

function feedXml(entries, total, start) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/mock</id>
  <title>arXiv Query: mock</title>
  <updated>2026-01-01T00:00:00Z</updated>
  <opensearch:totalResults>${total}</opensearch:totalResults>
  <opensearch:startIndex>${start}</opensearch:startIndex>
  <opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage>
  ${entries.map(entryXml).join("")}
</feed>`;
}

function errorFeedXml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query</title>
  <entry>
    <id>http://arxiv.org/api/errors#bad_query</id>
    <title>Error</title>
    <summary>${esc(msg)}</summary>
  </entry>
</feed>`;
}

/**
 * 造 n 条论文元数据。
 * ★ 时间戳必须**相对当前时间**生成：增量更新用「updated ≤ 上次运行时间即提前停止」判据，
 * 若用固定历史日期（如 2026-01-01），所有条目都会被判为「早于上次运行」而全部跳过。
 */
function makeDataset(n, prefix) {
  const out = [];
  const base = Date.now();
  for (let i = 0; i < n; i++) {
    // ★ 时间戳格式必须统一（统一带毫秒）：ISO 字符串的字典序比较在「带毫秒 vs 不带毫秒」
    // 之间会翻转（'.' < 'Z'），混用会让排序结果与时间顺序不一致，进而把新条目误判为旧条目。
    const d = new Date(base - i * 86400000).toISOString();
    out.push({
      id: (prefix || "2601.") + String(10000 + i),
      version: 1,
      title: "Paper number " + i,
      published: d,
      updated: d,
      cat: i % 2 ? "cs.CL" : "cs.LG",
      summary: "We study topic " + (i % 5) + " with a method.",
    });
  }
  return out;
}

/**
 * 启动桩服务器。
 * @param {{dataset:Array, failQueue?:Array<{status:number,body?:string,retryAfter?:string}>, delayMs?:number}} opts
 */
function startServer(opts) {
  const o = opts || {};
  const state = {
    dataset: o.dataset || [],
    failQueue: (o.failQueue || []).slice(),
    delayMs: o.delayMs || 0,
    hits: [],
    absPages: {},
  };

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    state.hits.push({ path: u.pathname, at: Date.now(), q: Object.fromEntries(u.searchParams) });

    const respond = () => {
      // 版本历史页
      if (/^\/abs\//.test(u.pathname)) {
        const id = u.pathname.replace(/^\/abs\//, "");
        const html = state.absPages[id] || "";
        if (!html) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      // 排队中的失败响应
      if (state.failQueue.length) {
        const f = state.failQueue.shift();
        const headers = { "Content-Type": "application/atom+xml" };
        if (f.retryAfter) headers["Retry-After"] = f.retryAfter;
        res.writeHead(f.status, headers);
        res.end(f.body != null ? f.body : "");
        return;
      }

      const q = u.searchParams;
      let list = state.dataset.slice();

      const idList = (q.get("id_list") || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (idList.length) {
        const want = new Set(idList.map((x) => x.replace(/v\d+$/, "")));
        list = list.filter((e) => want.has(e.id));
      }

      const sortBy = q.get("sortBy") || "submittedDate";
      const order = q.get("sortOrder") || "descending";
      const field = sortBy === "lastUpdatedDate" ? "updated" : "published";
      // 按时间戳排序而非字符串比较：保证与 arXiv 的「时间序」语义一致
      list.sort((a, b) => {
        const d = Date.parse(a[field]) - Date.parse(b[field]);
        return order === "ascending" ? d : -d;
      });

      const start = Number(q.get("start") || 0);
      const max = Number(q.get("max_results") || 10);
      const total = list.length;
      const page = list.slice(start, start + max);

      res.writeHead(200, { "Content-Type": "application/atom+xml" });
      res.end(feedXml(page, total, start));
    };

    if (state.delayMs) setTimeout(respond, state.delayMs);
    else respond();
  });

  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({
        state,
        port,
        baseUrl: "http://127.0.0.1:" + port + "/api/query",
        absBaseUrl: "http://127.0.0.1:" + port + "/abs",
        close: () => new Promise((r) => srv.close(r)),
        /** 只统计 /api/query 的次数 */
        queryHits: () => state.hits.filter((h) => h.path.indexOf("/api/query") === 0),
      });
    });
  });
}

/** 造一个指向桩服务器的客户端配置。 */
function makeConfig(srv, over) {
  const dir = tmpDir("pp-cli-");
  const cfg = loadConfig({
    cwd: dir,
    env: {},
    cli: {
      api: { baseUrl: srv.baseUrl, absBaseUrl: srv.absBaseUrl },
      request: { minIntervalMs: 0, retries: 2, backoffBaseMs: 1, maxConcurrent: 1, timeoutMs: 5000 },
      search: { pageSize: 100, maxResults: 2000, maxPages: 20 },
      cache: { dir: path.join(dir, "cache"), enabled: true, ttlMs: 60000 },
      log: { level: "silent" },
    },
  });
  Object.assign(cfg, over || {});
  return { cfg, dir };
}

function makeClient(srv, mutate) {
  const { cfg, dir } = makeConfig(srv);
  // ★ 必须在构造客户端**之前**改配置：RateLimiter 是在构造函数里按 minIntervalMs 建好的，
  // 构造完再改 cfg 不会影响已经建好的限速器（踩过一次：限速用例假失败）。
  if (mutate) mutate(cfg);
  const client = new ArxivClient({
    config: cfg,
    logger: nullLogger(),
    sleep: async () => {},              // 重试不真的等待
    backoff: () => 0,
  });
  return { client, cfg, dir };
}

/* ------------------------------ 用例 ------------------------------ */

test("分页：自动翻页直到取满 limit，用服务端返回条数推进游标", async () => {
  const srv = await startServer({ dataset: makeDataset(250) });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 250, pageSize: 100 });
    assert.strictEqual(r.fetched, 250);
    assert.strictEqual(r.entries.length, 250);
    assert.strictEqual(r.pages, 3);
    assert.strictEqual(r.totalResults, 250);
    const starts = srv.queryHits().map((h) => h.q.start);
    assert.deepStrictEqual(starts, ["0", "100", "200"]);
  } finally { await srv.close(); rmTemp(dir); }
});

test("分页：limit 不是 pageSize 整数倍时最后一页只取余数", async () => {
  const srv = await startServer({ dataset: makeDataset(250) });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 150, pageSize: 100 });
    assert.strictEqual(r.entries.length, 150);
    assert.strictEqual(r.pages, 2);
    assert.deepStrictEqual(srv.queryHits().map((h) => h.q.max_results), ["100", "50"]);
  } finally { await srv.close(); rmTemp(dir); }
});

test("分页：结果不足一页时立即停止（不空翻下一页）", async () => {
  const srv = await startServer({ dataset: makeDataset(7) });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 200, pageSize: 100 });
    assert.strictEqual(r.entries.length, 7);
    assert.strictEqual(r.pages, 1);
    assert.strictEqual(srv.queryHits().length, 1);
  } finally { await srv.close(); rmTemp(dir); }
});

test("去重：跨页出现同一 ID 的不同版本时合并，保留高版本", async () => {
  const ds = makeDataset(3);
  ds.push({ id: ds[0].id, version: 2, title: ds[0].title, published: ds[0].published, updated: "2026-02-01T00:00:00Z", cat: "cs.LG" });
  const srv = await startServer({ dataset: ds });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 10, pageSize: 10 });
    assert.strictEqual(r.fetched, 4);
    assert.strictEqual(r.entries.length, 3, "重复 ID 应被合并");
    assert.strictEqual(r.duplicatesRemoved, 1);
    const e = r.entries.find((x) => x.arxivId === ds[0].id);
    assert.strictEqual(e.version, 2);
  } finally { await srv.close(); rmTemp(dir); }
});

test("重试：503 两次后成功，且请求计数为 3", async () => {
  const srv = await startServer({
    dataset: makeDataset(3),
    failQueue: [{ status: 503 }, { status: 503 }],
  });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 3, pageSize: 10 });
    assert.strictEqual(r.entries.length, 3);
    assert.strictEqual(client.requestCount, 3, "应有 2 次重试");
  } finally { await srv.close(); rmTemp(dir); }
});

test("重试：重试次数耗尽后抛出可分类的错误", async () => {
  const srv = await startServer({
    dataset: makeDataset(1),
    failQueue: [{ status: 500 }, { status: 500 }, { status: 500 }],
  });
  const { client, dir } = makeClient(srv);
  try {
    await assert.rejects(
      () => client.search({ categories: ["cs.LG"] }, { limit: 1 }),
      (e) => {
        assert.strictEqual(e.code, "HTTP_ERROR");
        assert.strictEqual(e.status, 500);
        assert.strictEqual(e.retryable, true);
        return true;
      }
    );
    assert.strictEqual(client.requestCount, 3, "1 次原始 + 2 次重试");
  } finally { await srv.close(); rmTemp(dir); }
});

test("429 限速响应被识别为 RateLimitError 并重试", async () => {
  const srv = await startServer({
    dataset: makeDataset(1),
    failQueue: [{ status: 429, retryAfter: "0" }],
  });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 1 });
    assert.strictEqual(r.entries.length, 1);
    assert.strictEqual(client.requestCount, 2);
  } finally { await srv.close(); rmTemp(dir); }
});

test("400 + Atom 错误条目 → ApiError（不可重试），且把 arXiv 的原话带出来", async () => {
  const srv = await startServer({
    dataset: makeDataset(1),
    failQueue: [{ status: 400, body: errorFeedXml("incorrect category format: cs.cl") }],
  });
  const { client, dir } = makeClient(srv);
  try {
    await assert.rejects(
      () => client.search({ categories: ["cs.cl"] }, { limit: 1 }),
      (e) => {
        assert.strictEqual(e.code, "API_ERROR");
        assert.ok(/incorrect category format/.test(e.message), "实际：" + e.message);
        assert.ok(e.hint, "应给出排查建议");
        return true;
      }
    );
    assert.strictEqual(client.requestCount, 1, "业务错误不应重试");
  } finally { await srv.close(); rmTemp(dir); }
});

test("超时：应用层计时器保证不挂死", async () => {
  const srv = await startServer({ dataset: makeDataset(1), delayMs: 300 });
  const { client, dir } = makeClient(srv, (cfg) => {
    // 配置校验要求 timeoutMs ≥ 1000，测试里直接压到 80ms
    cfg.request.timeoutMs = 80;
    cfg.request.retries = 0;
  });
  try {
    await assert.rejects(() => client.search({ categories: ["cs.LG"] }, { limit: 1 }), (e) => {
      assert.strictEqual(e.code, "TIMEOUT");
      assert.strictEqual(e.retryable, true);
      return true;
    });
  } finally { await srv.close(); rmTemp(dir); }
});

test("缓存：第二次相同查询命中缓存，不再发起网络请求", async () => {
  const srv = await startServer({ dataset: makeDataset(20) });
  const { client, dir } = makeClient(srv);
  try {
    const a = await client.search({ categories: ["cs.LG"] }, { limit: 20 });
    assert.strictEqual(a.fromCache, false);
    const before = srv.queryHits().length;
    const b = await client.search({ categories: ["cs.LG"] }, { limit: 20 });
    assert.strictEqual(b.fromCache, true);
    assert.strictEqual(b.entries.length, 20);
    assert.strictEqual(srv.queryHits().length, before, "命中缓存不应产生新请求");
    assert.ok(b.cacheAgeMs >= 0);
  } finally { await srv.close(); rmTemp(dir); }
});

test("缓存：条件不同（limit 不同）不会误命中", async () => {
  const srv = await startServer({ dataset: makeDataset(30) });
  const { client, dir } = makeClient(srv);
  try {
    await client.search({ categories: ["cs.LG"] }, { limit: 10 });
    const b = await client.search({ categories: ["cs.LG"] }, { limit: 30 });
    assert.strictEqual(b.fromCache, false);
    assert.strictEqual(b.entries.length, 30);
  } finally { await srv.close(); rmTemp(dir); }
});

test("缓存：refresh 强制绕过缓存", async () => {
  const srv = await startServer({ dataset: makeDataset(5) });
  const { client, dir } = makeClient(srv);
  try {
    await client.search({ categories: ["cs.LG"] }, { limit: 5 });
    const before = srv.queryHits().length;
    const b = await client.search({ categories: ["cs.LG"] }, { limit: 5, refresh: true });
    assert.strictEqual(b.fromCache, false);
    assert.ok(srv.queryHits().length > before);
  } finally { await srv.close(); rmTemp(dir); }
});

test("限速：多页请求之间的实际间隔不小于 minIntervalMs", async () => {
  const srv = await startServer({ dataset: makeDataset(250) });
  const { client, dir } = makeClient(srv, (cfg) => { cfg.request.minIntervalMs = 60; });
  try {
    await client.search({ categories: ["cs.LG"] }, { limit: 250, pageSize: 100 });
    const hits = srv.queryHits();
    assert.strictEqual(hits.length, 3);
    for (let i = 1; i < hits.length; i++) {
      const gap = hits[i].at - hits[i - 1].at;
      assert.ok(gap >= 50, "第 " + (i + 1) + " 次请求间隔仅 " + gap + "ms（应 ≥60）");
    }
  } finally { await srv.close(); rmTemp(dir); }
});

test("getByIds：精确获取 + 自动分批 + 报告未找到的 ID", async () => {
  const ds = makeDataset(5);
  const srv = await startServer({ dataset: ds });
  const { client, dir } = makeClient(srv);
  try {
    const ids = [ds[0].id, ds[2].id, ds[3].id, "9999.99999"];
    const r = await client.getByIds(ids, { batchSize: 2 });
    assert.strictEqual(r.requested, 4);
    assert.strictEqual(r.entries.length, 3);
    assert.strictEqual(r.pages, 2, "4 个 ID、批大小 2 → 2 批");
    assert.deepStrictEqual(r.missing, ["9999.99999"]);
  } finally { await srv.close(); rmTemp(dir); }
});

test("getByIds：接受 URL 形式并剥离版本号", async () => {
  const ds = makeDataset(2);
  const srv = await startServer({ dataset: ds });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.getByIds(["https://arxiv.org/abs/" + ds[0].id + "v3"], {});
    assert.strictEqual(r.entries.length, 1);
    assert.strictEqual(r.entries[0].arxivId, ds[0].id);
  } finally { await srv.close(); rmTemp(dir); }
});

test("增量更新：首次运行全量视作新增，第二次只返回真正的新内容", async () => {
  const ds = makeDataset(10);
  const srv = await startServer({ dataset: ds });
  const { client, dir } = makeClient(srv);
  try {
    const first = await client.update({ categories: ["cs.LG"] }, { limit: 10 });
    assert.strictEqual(first.firstRun, true);
    assert.strictEqual(first.newCount, 10);
    assert.strictEqual(first.since, "");

    // 间隔保证新条目时间戳严格晚于上次运行时间（保留毫秒，否则截断到秒可能反而更早）
    await new Promise((r) => setTimeout(r, 20));

    const newer = new Date().toISOString();
    srv.state.dataset = [{ id: "2606.00001", version: 1, title: "Brand new paper", published: newer, updated: newer, cat: "cs.LG" }].concat(ds);

    const second = await client.update({ categories: ["cs.LG"] }, { limit: 20 });
    assert.strictEqual(second.firstRun, false);
    assert.ok(second.since, "应记录上次运行时间");
    assert.strictEqual(second.newCount, 1, "只应返回 1 条新增，实际 " + second.newCount + "：" + JSON.stringify(second.entries.map((e) => e.arxivId)));
    assert.strictEqual(second.entries[0].arxivId, "2606.00001");
    assert.strictEqual(second.stoppedEarly, true, "遇到旧条目应提前停止翻页");
  } finally { await srv.close(); rmTemp(dir); }
});

test("增量更新：老论文出新版本会被识别为新内容（不只比对 ID）", async () => {
  const ds = makeDataset(3);
  const srv = await startServer({ dataset: ds });
  const { client, dir } = makeClient(srv);
  try {
    await client.update({ categories: ["cs.LG"] }, { limit: 3 });
    await new Promise((r) => setTimeout(r, 20));
    const later = new Date().toISOString();
    srv.state.dataset = ds.map((e, i) => (i === 1 ? Object.assign({}, e, { version: 2, updated: later }) : e));

    const second = await client.update({ categories: ["cs.LG"] }, { limit: 3 });
    assert.strictEqual(second.newCount, 1);
    assert.strictEqual(second.entries[0].arxivId, ds[1].id);
    assert.strictEqual(second.entries[0].version, 2);
  } finally { await srv.close(); rmTemp(dir); }
});

test("无检索条件 → UsageError（在发起任何请求前失败）", async () => {
  const srv = await startServer({ dataset: makeDataset(1) });
  const { client, dir } = makeClient(srv);
  try {
    await assert.rejects(() => client.search({}, { limit: 5 }), (e) => {
      assert.strictEqual(e.code, "USAGE_ERROR");
      return true;
    });
    assert.strictEqual(srv.queryHits().length, 0, "不应发出请求");
  } finally { await srv.close(); rmTemp(dir); }
});

test("streamSearch：逐页产出，不一次性堆积", async () => {
  const srv = await startServer({ dataset: makeDataset(250) });
  const { client, dir } = makeClient(srv);
  try {
    const pages = [];
    for await (const p of client.streamSearch({ categories: ["cs.LG"] }, { limit: 250, pageSize: 100 })) {
      pages.push(p);
    }
    assert.strictEqual(pages.length, 3);
    assert.strictEqual(pages[0].start, 0);
    assert.strictEqual(pages[1].start, 100);
    assert.strictEqual(pages[0].totalResults, 250);
  } finally { await srv.close(); rmTemp(dir); }
});

test("增强：版本历史从 abs 页 HTML 解析", async () => {
  const ds = makeDataset(1);
  const srv = await startServer({ dataset: ds });
  const { client, dir } = makeClient(srv);
  srv.state.absPages[ds[0].id] =
    '<html><body><div class="submission-history"><h2>Submission history</h2> From: arXiv:2601.10000v1 [cs.LG]<br/>' +
    '<b>[v1]</b> Mon, 1 Jan 2026 10:00:00 UTC (1,024 KB)<br/>' +
    '<b>[v2]</b> Wed, 11 Mar 2026 09:30:00 UTC (1,300 KB)<br/></div></body></html>';
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 1 });
    const enriched = await client.enrich(r.entries, { versions: true, limit: 1 });
    const vh = enriched[0].versionHistory;
    assert.strictEqual(vh.ok, true);
    assert.strictEqual(vh.count, 2);
    assert.strictEqual(vh.latest, 2);
    assert.strictEqual(vh.versions[0].sizeKb, 1024);
    assert.strictEqual(vh.versions[1].iso, "2026-03-11T09:30:00.000Z");
  } finally { await srv.close(); rmTemp(dir); }
});

test("增强：抓取失败只降级记录原因，不抛出", async () => {
  const ds = makeDataset(1);
  const srv = await startServer({ dataset: ds });
  const { client, dir } = makeClient(srv);
  try {
    const r = await client.search({ categories: ["cs.LG"] }, { limit: 1 });
    const enriched = await client.enrich(r.entries, { versions: true, limit: 1 });   // abs 页 404
    assert.strictEqual(enriched[0].versionHistory.ok, false);
    assert.ok(enriched[0].versionHistory.reason);
    assert.strictEqual(enriched.length, 1, "条目本身必须保留");
  } finally { await srv.close(); rmTemp(dir); }
});

test("probe：连通性自检返回样例条目", async () => {
  const srv = await startServer({ dataset: makeDataset(3) });
  const { client, dir } = makeClient(srv);
  try {
    const p = await client.probe();
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.status, 200);
    assert.ok(p.sample && p.sample.arxivId);
  } finally { await srv.close(); rmTemp(dir); }
});

test("urlFor：组装出的 URL 参数完整且可读", async () => {
  const srv = await startServer({ dataset: makeDataset(1) });
  const { client, dir } = makeClient(srv);
  try {
    const url = client.urlFor({ searchQuery: "cat:cs.LG", start: 0, maxResults: 5, sortBy: "submittedDate", sortOrder: "descending" });
    assert.ok(url.indexOf("search_query=cat:cs.LG") > 0);
    assert.ok(url.indexOf("start=0") > 0);
    assert.ok(url.indexOf("max_results=5") > 0);
    assert.ok(url.indexOf("sortOrder=descending") > 0);
  } finally { await srv.close(); rmTemp(dir); }
});

run("client");
