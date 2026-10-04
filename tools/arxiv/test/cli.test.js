"use strict";

/**
 * CLI 测试：参数解析（纯函数）+ 端到端（对着本地桩服务器真的跑一遍 run()）。
 * CLI 是用户唯一直接接触的界面，参数解析错误或不友好的退出码比内部 bug 更伤体验。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { test, assert, run, tmpDir, rmTemp } = require("./_harness");
const cli = require("../src/cli");

/* ------------------------------ 工具 ------------------------------ */

function capture() {
  const o = [];
  const e = [];
  return {
    io: { stdout: { write: (s) => o.push(String(s)) }, stderr: { write: (s) => e.push(String(s)) } },
    out: () => o.join(""),
    err: () => e.join(""),
  };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function entryXml(e) {
  return `<entry><id>http://arxiv.org/abs/${e.id}v1</id><title>${esc(e.title)}</title><updated>${e.updated}</updated><published>${e.published}</published><link href="https://arxiv.org/abs/${e.id}v1" rel="alternate" type="text/html"/><summary>${esc(e.summary)}</summary><category term="${e.cat}" scheme="http://arxiv.org/schemas/atom"/><arxiv:primary_category term="${e.cat}"/><author><name>Ada Lovelace</name></author></entry>`;
}
function feed(list, total) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
<opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>
${list.map(entryXml).join("")}</feed>`;
}

const DATASET = [0, 1, 2, 3, 4].map((i) => ({
  id: "2603." + (10000 + i),
  title: "Structured abstract study " + i,
  published: new Date(Date.now() - i * 86400000).toISOString(),
  updated: new Date(Date.now() - i * 86400000).toISOString(),
  cat: i % 2 ? "cs.CL" : "cs.LG",
  summary: "Background: we study X. Methods: we test Y. Results: we find Z. Conclusions: it works.",
}));

function startServer() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    hits.push(u);
    const start = Number(u.searchParams.get("start") || 0);
    const max = Number(u.searchParams.get("max_results") || 10);
    res.writeHead(200, { "Content-Type": "application/atom+xml" });
    res.end(feed(DATASET.slice(start, start + max), DATASET.length));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      resolve({ port: srv.address().port, hits, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

/** 构造一组安全的 CLI 基线参数（静默日志、指向桩、禁用缓存、零限速）。 */
function baseArgs(srv, dir) {
  return ["--base-url", "http://127.0.0.1:" + srv.port + "/api/query", "--min-interval", "0", "--retries", "0", "--cache-dir", dir, "--quiet"];
}

/* ------------------------------ 参数解析 ------------------------------ */

test("parseArgs：识别子命令与全局选项", () => {
  const p = cli.parseArgs(["search", "-k", "diffusion", "--limit", "20"]);
  assert.strictEqual(p.command, "search");
  assert.deepStrictEqual(p.options.keyword, ["diffusion"]);
  assert.strictEqual(p.options.limit, 20);
});

test("parseArgs：子命令可放在选项之后（第一个非选项 token 即命令）", () => {
  const p = cli.parseArgs(["--verbose", "get", "--id", "2501.00001"]);
  assert.strictEqual(p.command, "get");
  assert.strictEqual(p.options.verbose, 1);
  assert.deepStrictEqual(p.options.id, ["2501.00001"]);
});

test("parseArgs：选项的取值不会被误认成子命令", () => {
  const p = cli.parseArgs(["-c", "cs.LG", "search"]);
  assert.strictEqual(p.command, "search");
  assert.deepStrictEqual(p.options.category, ["cs.LG"]);
});

test("parseArgs：数组选项支持逗号分隔与多次出现", () => {
  const p = cli.parseArgs(["search", "-c", "cs.LG,cs.CL", "-c", "stat.ML"]);
  assert.deepStrictEqual(p.options.category, ["cs.LG", "cs.CL", "stat.ML"]);
});

test("parseArgs：--key=value 形式", () => {
  const p = cli.parseArgs(["search", "--limit=50", "--format=json"]);
  assert.strictEqual(p.options.limit, 50);
  assert.strictEqual(p.options.format, "json");
});

test("parseArgs：--no-xxx 布尔取反", () => {
  const p = cli.parseArgs(["search", "--no-cache", "--no-structured"]);
  assert.strictEqual(p.options["no-cache"], true);
  assert.strictEqual(p.options["no-structured"], true);
});

test("parseArgs：短选项叠加 -vv 提高日志级别", () => {
  const p = cli.parseArgs(["search", "-vv"]);
  assert.strictEqual(p.options.verbose, 2);
});

test("parseArgs：--cluster 可带值也可不带值", () => {
  assert.strictEqual(cli.parseArgs(["stats", "--cluster"]).options.cluster, 0);
  assert.strictEqual(cli.parseArgs(["stats", "--cluster", "4"]).options.cluster, 4);
});

test("parseArgs：数字选项校验（非法值直接报错）", () => {
  assert.throws(() => cli.parseArgs(["search", "--limit", "abc"]), /需要一个数字/);
});

test("parseArgs：未知选项报错并给出最接近的候选", () => {
  assert.throws(() => cli.parseArgs(["search", "--limt", "5"]), (e) => {
    assert.strictEqual(e.code, "USAGE_ERROR");
    assert.ok(/--limit/.test(e.hint), "应建议 --limit，实际：" + e.hint);
    return true;
  });
});

test("parseArgs：-- 之后的 token 视为位置参数（命令后的裸词也是位置参数）", () => {
  const p = cli.parseArgs(["cache", "clear", "--", "--not-an-option"]);
  assert.deepStrictEqual(p.positionals, ["clear", "--not-an-option"]);
});

/* ------------------------------ 配置映射 ------------------------------ */

test("mapToConfig：CLI 名 → 配置路径（含单位换算）", () => {
  const patch = cli.mapToConfig({
    "base-url": "http://x/api",
    timeout: 5000,
    "min-interval": 100,
    "page-size": 50,
    "cache-ttl": 60,          // 秒
    "no-cache": true,
    "log-level": "debug",
    format: "csv",
  });
  assert.strictEqual(patch.api.baseUrl, "http://x/api");
  assert.strictEqual(patch.request.timeoutMs, 5000);
  assert.strictEqual(patch.request.minIntervalMs, 100);
  assert.strictEqual(patch.search.pageSize, 50);
  assert.strictEqual(patch.cache.ttlMs, 60000, "cache-ttl 是秒，应换算成毫秒");
  assert.strictEqual(patch.cache.enabled, false);
  assert.strictEqual(patch.log.level, "debug");
  assert.strictEqual(patch.output.format, "csv");
});

test("mapToConfig：verbose 提升日志级别，cluster 打开聚类", () => {
  assert.strictEqual(cli.mapToConfig({ verbose: 1 }).log.level, "info");
  assert.strictEqual(cli.mapToConfig({ verbose: 2 }).log.level, "debug");
  const p = cli.mapToConfig({ cluster: 5 });
  assert.deepStrictEqual(p.analyze.cluster, { enabled: true, k: 5 });
});

test("mapToConfig：未出现的键不写入（避免覆盖已有配置）", () => {
  const patch = cli.mapToConfig({});
  assert.strictEqual(patch.api, undefined);
  assert.strictEqual(patch.search, undefined);
});

test("toSpec：CLI 选项 → 检索 spec", () => {
  const spec = cli.toSpec({ keyword: ["a"], author: ["b"], category: ["cs.LG"], from: "2025-01-01", or: true, phrase: true });
  assert.deepStrictEqual(spec.keywords, ["a"]);
  assert.deepStrictEqual(spec.authors, ["b"]);
  assert.deepStrictEqual(spec.categories, ["cs.LG"]);
  assert.strictEqual(spec.dateFrom, "2025-01-01");
  assert.strictEqual(spec.boolean, "OR");
  assert.strictEqual(spec.phrase, true);
});

/* ------------------------------ 端到端 ------------------------------ */

test("端到端：search -f json 输出可解析的完整结果", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    const cap = capture();
    const code = await cli.run(["search", "-c", "cs.LG", "-k", "study", "--limit", "5", "-f", "json", "--no-cache"].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0, "退出码应为 0，stderr：" + cap.err());
    const data = JSON.parse(cap.out());
    assert.strictEqual(data.entries.length, 5);
    assert.strictEqual(data.totalResults, 5);
    assert.ok(data.query.indexOf("cat:cs.LG") >= 0);
    assert.ok(data.analysis, "应带分析结果");
    assert.ok(data.analysis.categories.byCategory.length > 0);
    assert.ok(data.analysis.structuredCount >= 1, "结构化摘要应被检出");
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：--dry-run 只打印 URL，不发起任何请求", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    const cap = capture();
    const code = await cli.run(["search", "-c", "cs.LG", "--dry-run"].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0);
    assert.ok(cap.out().indexOf("search_query=cat:cs.LG") > 0);
    assert.strictEqual(srv.hits.length, 0, "dry-run 不应联网");
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：双通道输出（结构化 JSON 到 stdout + Markdown 报告到文件）", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    const reportPath = path.join(dir, "report.md");
    const cap = capture();
    const code = await cli.run(
      ["search", "-c", "cs.LG", "--limit", "5", "-f", "json", "--report", reportPath].concat(baseArgs(srv, dir)),
      cap.io
    );
    assert.strictEqual(code, 0, cap.err());
    assert.ok(JSON.parse(cap.out()).entries.length === 5, "stdout 应为结构化 JSON");
    assert.ok(fs.existsSync(reportPath), "报告文件应存在");
    const md = fs.readFileSync(reportPath, "utf8");
    assert.ok(md.indexOf("# arXiv 检索报告") === 0);
    assert.ok(md.indexOf("## 概览统计") > 0);
    assert.ok(md.indexOf("## 结果列表") > 0);
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：CSV 输出带 BOM 与表头", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    const cap = capture();
    const code = await cli.run(["search", "-c", "cs.LG", "--limit", "3", "-f", "csv"].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0, cap.err());
    const csv = cap.out();
    assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
    assert.ok(csv.indexOf("arxiv_id,") >= 0);
    assert.strictEqual(csv.trim().split("\n").length, 4, "表头 + 3 行");
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：--out 写文件，stdout 保持干净", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    const outFile = path.join(dir, "out.json");
    const cap = capture();
    const code = await cli.run(["search", "-c", "cs.LG", "--limit", "2", "-f", "json", "-o", outFile].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0, cap.err());
    assert.ok(fs.existsSync(outFile));
    assert.strictEqual(JSON.parse(fs.readFileSync(outFile, "utf8")).entries.length, 2);
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：--highlight 自动取主题词并加亮", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    const cap = capture();
    const code = await cli.run(["search", "-c", "cs.LG", "--limit", "3", "-f", "md", "--highlight"].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0, cap.err());
    assert.ok(cap.out().indexOf("**") > 0, "报告应包含高亮标记");
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：get --id 精确获取", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    const cap = capture();
    const code = await cli.run(["get", "--id", "2603.10000,2603.10001", "-f", "json"].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0, cap.err());
    const data = JSON.parse(cap.out());
    assert.strictEqual(data.command, "get");
    assert.strictEqual(data.entries.length, 2);
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：update 增量（首次全量，第二次 0 新增）", async () => {
  const srv = await startServer();
  const dir = tmpDir("pp-cli-");
  try {
    let cap = capture();
    let code = await cli.run(["update", "-c", "cs.LG", "--limit", "5", "-f", "json"].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0, cap.err());
    const first = JSON.parse(cap.out());
    assert.strictEqual(first.firstRun, true);
    assert.strictEqual(first.newCount, 5);

    cap = capture();
    code = await cli.run(["update", "-c", "cs.LG", "--limit", "5", "-f", "json"].concat(baseArgs(srv, dir)), cap.io);
    assert.strictEqual(code, 0, cap.err());
    const second = JSON.parse(cap.out());
    assert.strictEqual(second.firstRun, false);
    assert.strictEqual(second.newCount, 0, "数据没变，不应有新增");
  } finally { await srv.close(); rmTemp(dir); }
});

test("端到端：--print-config 输出生效配置（含来源）", async () => {
  const cap = capture();
  const code = await cli.run(["search", "--print-config"], cap.io);
  assert.strictEqual(code, 0);
  const cfg = JSON.parse(cap.out());
  assert.strictEqual(cfg.request.minIntervalMs, 3000);
  assert.ok("__meta" in cfg);
});

test("退出码：无检索条件 → 2（用法错误），并给出可操作提示", async () => {
  const cap = capture();
  const code = await cli.run(["search", "--quiet"], cap.io);
  assert.strictEqual(code, 2);
  assert.ok(/-k |--keyword/.test(cap.err()), "应给出示例，实际：" + cap.err());
});

test("退出码：未知命令 → 2，并建议最接近的命令", async () => {
  const cap = capture();
  const code = await cli.run(["serch", "--quiet"], cap.io);
  assert.strictEqual(code, 2);
  assert.ok(/search/.test(cap.err()), "实际：" + cap.err());
});

test("退出码：非法配置值 → 5", async () => {
  const cap = capture();
  const code = await cli.run(["search", "--sort", "stars", "--quiet"], cap.io);
  assert.strictEqual(code, 5);
});

test("退出码：网络不可达 → 3", async () => {
  const dir = tmpDir("pp-cli-");
  try {
    const cap = capture();
    // 指向一个必然无人监听的端口
    const code = await cli.run([
      "search", "-c", "cs.LG", "--limit", "1",
      "--base-url", "http://127.0.0.1:9/api/query",
      "--timeout", "1500", "--retries", "0", "--min-interval", "0",
      "--cache-dir", dir, "--no-cache", "--quiet",
    ], cap.io);
    assert.strictEqual(code, 3, "stderr：" + cap.err());
    assert.ok(/失败/.test(cap.err()));
  } finally { rmTemp(dir); }
});

test("--help 输出包含命令、选项与示例", () => {
  const h = cli.helpText();
  assert.ok(h.indexOf("用法") > 0);
  assert.ok(h.indexOf("search") > 0);
  assert.ok(h.indexOf("--keyword") > 0);
  assert.ok(h.indexOf("环境变量") > 0);
  assert.ok(h.indexOf("退出码") > 0);
});

test("端到端：categories --check 对拼错分类给出建议", async () => {
  const cap = capture();
  const code = await cli.run(["categories", "--check", "cs.LG,cs.NLP"], cap.io);
  assert.strictEqual(code, 0);
  const out = cap.out();
  assert.ok(out.indexOf("✓ cs.LG") >= 0, "实际：" + out);
  assert.ok(out.indexOf("✗ cs.NLP") >= 0 || /可能是/.test(out), "拼错分类应给出提示，实际：" + out);
});

test("端到端：cache stats / clear / state", async () => {
  const dir = tmpDir("pp-cli-");
  try {
    let cap = capture();
    let code = await cli.run(["cache", "stats", "--cache-dir", dir, "--quiet"], cap.io);
    assert.strictEqual(code, 0, cap.err());
    assert.ok(cap.out().indexOf("缓存目录") >= 0);

    cap = capture();
    code = await cli.run(["cache", "clear", "--cache-dir", dir, "--quiet"], cap.io);
    assert.strictEqual(code, 0);
    assert.ok(/已清空缓存/.test(cap.out()));

    cap = capture();
    code = await cli.run(["cache", "state", "--cache-dir", dir, "--quiet"], cap.io);
    assert.strictEqual(code, 0);
    assert.ok("sources" in JSON.parse(cap.out()));
  } finally { rmTemp(dir); }
});

test("端到端：help 子命令退出码 0", async () => {
  const cap = capture();
  const code = await cli.run(["help"], cap.io);
  assert.strictEqual(code, 0);
  assert.ok(cap.out().indexOf("用法") > 0);
});

test("端到端：--version 打印版本号", async () => {
  const cap = capture();
  const code = await cli.run(["--version"], cap.io);
  assert.strictEqual(code, 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(cap.out().trim()));
});

run("cli");
