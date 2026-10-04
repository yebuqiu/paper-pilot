#!/usr/bin/env node
/* 插件侧 arXiv 核心（0.25.0）：生成物等价性 + ArxivFetch 适配层
 *
 * 运行：node test/arxiv-core.test.js
 *
 * 本套测试守两类**光靠实机很难发现**的失败：
 *
 *   1. **生成物与源漂移**：`chrome/content/scripts/arxiv/arxiv-*.js` 由
 *      `scripts/build-arxiv-core.py` 从 `tools/arxiv/src/` 生成（单一真源在 tools 侧）。
 *      只要有人在 tools 侧改了逻辑却没重新生成，就会「CLI 里对、插件里错」，
 *      而两边各自的测试都还是绿的。这里用同一份 fixture 跑两边逐字段比对。
 *
 *   2. **插件作用域不可加载**：Zotero 特权作用域没有 require / module / process。
 *      生成器一旦转错（例如 `module.exports =` 被换成 `return =`，生成器首跑就踩过），
 *      loadSubScript 失败只会写一行 boot 日志、功能静默降级。
 *      这里用**真正的裸 realm**（vm.createContext，只补 setTimeout）加载并断言产物干净。
 *
 * 另覆盖 ArxivFetch：以本地 http 桩服务器扮演 arXiv，验证分页 / 重试 / 限速间隔 /
 * 400 业务错误 / 去重 —— 全程不联网。
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const http = require('http');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'chrome', 'content', 'scripts', 'arxiv');
const SRC_DIR = path.join(ROOT, 'tools', 'arxiv', 'src');
const EXAMPLES = path.join(ROOT, 'tools', 'arxiv', 'examples');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  return ok(same, label, same ? undefined : { got: a, want: b });
}

/** 生成物清单（顺序 = 依赖序，与 build-arxiv-core.py 的 MODULES 一致）。 */
const GENERATED = ['arxiv-errors', 'arxiv-dates', 'arxiv-query', 'arxiv-categories',
  'arxiv-atom', 'arxiv-analyze', 'arxiv-rate-limiter'];

/** 在裸 realm 里加载插件侧 arXiv 核心（模拟 Zotero 特权作用域）。 */
function loadCore() {
  const ctx = vm.createContext({ setTimeout, clearTimeout });
  for (const name of GENERATED) {
    const file = path.join(CORE_DIR, name + '.js');
    if (!fs.existsSync(file)) throw new Error('缺少生成物 ' + name + '.js（跑 python scripts/build-arxiv-core.py）');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: name + '.js' });
  }
  vm.runInContext(fs.readFileSync(path.join(CORE_DIR, 'arxiv-fetch.js'), 'utf8'), ctx, { filename: 'arxiv-fetch.js' });
  return ctx;
}

/** 跨 realm 比较：vm 里造的对象原型不同，deepStrictEqual 会误判 → 统一走 JSON。 */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const MULTI = fs.readFileSync(path.join(EXAMPLES, 'sample-atom-multi.xml'), 'utf8');
const REAL = fs.readFileSync(path.join(EXAMPLES, 'sample-atom.xml'), 'utf8');
const ERROR_FEED = fs.readFileSync(path.join(EXAMPLES, 'sample-atom-error.xml'), 'utf8');

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function entryXml(e) {
  const v = e.version || 1;
  return '<entry><id>http://arxiv.org/abs/' + e.id + 'v' + v + '</id><title>' + esc(e.title) + '</title>' +
    '<published>' + e.published + '</published><updated>' + e.updated + '</updated>' +
    '<summary>' + esc(e.summary || 's') + '</summary>' +
    "<category term='" + (e.cat || 'cs.LG') + "'/><arxiv:primary_category term='" + (e.cat || 'cs.LG') + "'/>" +
    '<author><name>Ada Lovelace</name></author></entry>';
}
function feedXml(list, total) {
  return "<?xml version='1.0' encoding='UTF-8'?>" +
    "<feed xmlns:opensearch='http://a9.com/-/spec/opensearch/1.1/' xmlns:arxiv='http://arxiv.org/schemas/atom' xmlns='http://www.w3.org/2005/Atom'>" +
    '<opensearch:totalResults>' + total + '</opensearch:totalResults>' +
    '<opensearch:startIndex>0</opensearch:startIndex>' + list.map(entryXml).join('') + '</feed>';
}
function errorFeedXml(msg) {
  return "<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom'>" +
    "<entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title><summary>" + esc(msg) + '</summary></entry></feed>';
}
function makeDataset(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString();
    out.push({ id: '2601.' + (10000 + i), version: 1, title: 'Paper ' + i, published: d, updated: d, cat: i % 2 ? 'cs.CL' : 'cs.LG' });
  }
  return out;
}

/** 起一个扮演 arXiv 的本地服务器（端口由系统分配，避免与常驻服务撞端口）。 */
function startServer(opts) {
  const o = opts || {};
  const state = { dataset: o.dataset || [], failQueue: (o.failQueue || []).slice(), hits: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    state.hits.push({ at: Date.now(), q: Object.fromEntries(u.searchParams) });
    if (state.failQueue.length) {
      const f = state.failQueue.shift();
      res.writeHead(f.status, { 'Content-Type': 'application/atom+xml' });
      res.end(f.body != null ? f.body : '');
      return;
    }
    const start = Number(u.searchParams.get('start') || 0);
    const max = Number(u.searchParams.get('max_results') || 10);
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(feedXml(state.dataset.slice(start, start + max), state.dataset.length));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;   // ★ 回读实际端口（不能假设随机段可用）
      resolve({ port, state, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

/** 给 vm 里的 ArxivFetch 装 Zotero.HTTP.request 桩（走真实 HTTP，但打本地）。 */
function installHttpStub(ctx, baseUrl) {
  ctx.Zotero = {
    debug() {}, logError() {},
    HTTP: {
      request(method, url, options) {
        return new Promise((resolve, reject) => {
          const u = new URL(url);
          const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET' }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, responseText: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', reject);
          req.setTimeout((options && options.timeout) || 30000, () => { req.destroy(new Error('timeout')); });
          req.end();
        });
      },
    },
  };
  ctx.ArxivFetch.API = baseUrl;
  // 测试里把节奏压到 0、重试间隔压到 1ms，避免用例变慢（生产默认仍是 3 秒 / 1.2 秒起）
  ctx.ArxivFetch.configure({ minIntervalMs: 0, retries: 2, backoffBaseMs: 1, timeoutMs: 5000, pageSize: 100, maxItems: 200, maxPages: 5 });
  return ctx.ArxivFetch;
}

(async function main() {
  /* ============ 1. 生成物卫生 ============ */
  for (const name of GENERATED) {
    const head = fs.readFileSync(path.join(CORE_DIR, name + '.js'), 'utf8').slice(0, 400);
    ok(head.indexOf('AUTOGENERATED') >= 0, '1 生成物带 AUTOGENERATED 标记: ' + name);
    ok(head.indexOf('scripts/build-arxiv-core.py') > 0, '1 生成物标注了重新生成方式: ' + name);
    const src = fs.readFileSync(path.join(CORE_DIR, name + '.js'), 'utf8');
    for (const bad of ['require(', 'module.exports', 'process.', '__dirname']) {
      ok(src.indexOf(bad) === -1, '1 生成物无 Node 专有标识 ' + name + ' / ' + bad);
    }
  }

  let ctx;
  try {
    ctx = loadCore();
    ok(true, '2 裸 realm 加载全部生成物 + arxiv-fetch');
  } catch (e) {
    ok(false, '2 裸 realm 加载失败', String(e && e.message));
    ctx = null;
  }

  if (ctx) {
    eq(Object.keys(ctx).filter((k) => k.indexOf('Arxiv') === 0).sort(),
      ['ArxivAnalyze', 'ArxivAtom', 'ArxivCategories', 'ArxivDates', 'ArxivErrors', 'ArxivFetch', 'ArxivQuery', 'ArxivRateLimiter'],
      '2 全局名恰为约定的 8 个（不污染其它命名空间）');

    /* ============ 3. 等价性：生成物 vs tools 源 ============ */
    const srcAtom = require(path.join(SRC_DIR, 'atom'));
    const srcQuery = require(path.join(SRC_DIR, 'query'));
    const srcCat = require(path.join(SRC_DIR, 'categories'));
    const srcAnalyze = require(path.join(SRC_DIR, 'analyze'));

    eq(plain(ctx.ArxivAtom.parseAtom(REAL)).entries, plain(srcAtom.parseAtom(REAL)).entries, '3 atom 真实响应逐字段一致');
    eq(plain(ctx.ArxivAtom.parseAtom(MULTI)).entries, plain(srcAtom.parseAtom(MULTI)).entries, '3 atom 多条目/实体/机构一致');
    eq(plain(ctx.ArxivAtom.parseAtom(MULTI)).meta, plain(srcAtom.parseAtom(MULTI)).meta, '3 atom feed 元信息一致');
    eq(plain(ctx.ArxivAtom.parseAtom(MULTI)).entries[0].authorsDetailed, [{ name: 'Ada Lovelace', affiliations: [] }, { name: 'Alan Turing', affiliations: ['NPL'] }], '3 作者机构分块解析正确');

    let apiErr = null;
    try { ctx.ArxivAtom.parseAtom(ERROR_FEED); } catch (e) { apiErr = e; }
    ok(apiErr && apiErr.name === 'ApiError' && /incorrect category format/.test(apiErr.message),
      '3 插件侧同样把错误 feed 识别为 ApiError（不当成 0 结果）', apiErr && apiErr.message);
    eq(ctx.ArxivAtom.extractApiError(ERROR_FEED), srcAtom.extractApiError(ERROR_FEED), '3 extractApiError 一致');

    const genDedup = plain(ctx.ArxivAtom.dedupeEntries(ctx.ArxivAtom.parseAtom(MULTI).entries, { byId: true, byDoi: true, byTitle: true }));
    const srcDedup = plain(srcAtom.dedupeEntries(srcAtom.parseAtom(MULTI).entries, { byId: true, byDoi: true, byTitle: true }));
    eq(genDedup, srcDedup, '3 去重结果一致');
    eq(genDedup.entries.length, 2, '3 去重语义：v1/v2 合并 + 重名标题合并 → 2 条');

    const QCASES = [
      { keywords: ['diffusion model'], categories: ['cs.LG'] },
      { keywords: ['transformer'], phrase: true },
      { keywords: ['ti:attention'], categories: ['cs.CL'] },
      { keywords: ['a', 'b'], categories: ['cs.LG'], boolean: 'OR' },
      { categories: ['cs.LG'], dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      { categories: ['cs.LG'], excludeCategories: ['cs.CV'], excludeKeywords: ['survey'] },
      { raw: 'ti:"sparse autoencoder" AND cat:cs.LG' },
      { ids: ['1706.03762', '2501.00001'] },
      { keywords: ['foo"bar'] },
      { keywords: ['zz:foo'] },
    ];
    let qDiff = 0;
    for (const c of QCASES) if (JSON.stringify(plain(ctx.ArxivQuery.buildQuery(c))) !== JSON.stringify(plain(srcQuery.buildQuery(c)))) qDiff++;
    eq(qDiff, 0, '3 query 构建 10 组样例全部一致（含引号三态/OR 分组/日期/原始串）');
    const bp = { baseUrl: 'https://example.org/api/query', searchQuery: 'cat:cs.LG', start: 100, maxResults: 50, sortBy: 'submittedDate', sortOrder: 'descending' };
    eq(ctx.ArxivQuery.buildUrl(bp), srcQuery.buildUrl(bp), '3 buildUrl 一致');

    eq(ctx.ArxivCategories.list().length, srcCat.list().length, '3 分类目录条数一致');
    let cDiff = 0;
    for (const bad of ['cs.NLP', 'cs.cl', 'stat.MLx', 'cs.LG']) {
      const g = JSON.stringify(plain(ctx.ArxivCategories.checkAll([bad])));
      const s = JSON.stringify(plain(srcCat.checkAll([bad])));
      if (g !== s) cDiff++;
    }
    eq(cDiff, 0, '3 分类校验（含拼写纠错）一致');

    const TEXT = 'attention mechanism and Attention. 医学影像分割方法';
    eq(plain(ctx.ArxivAnalyze.highlight(TEXT, ['attention', 'attention mechanism', '医学影像'])),
      plain(srcAnalyze.highlight(TEXT, ['attention', 'attention mechanism', '医学影像'])), '3 高亮一致（长词优先 / 词边界 / CJK）');
    const SA = 'Background: a. Methods: b. Results: c. Conclusions: d.';
    eq(plain(ctx.ArxivAnalyze.splitStructuredAbstract(SA)), plain(srcAnalyze.splitStructuredAbstract(SA)), '3 结构化摘要（英）一致');
    const ZH = '背景：心衰常见。方法：队列研究。结果：120 例。结论：有效。';
    eq(plain(ctx.ArxivAnalyze.splitStructuredAbstract(ZH)), plain(srcAnalyze.splitStructuredAbstract(ZH)), '3 结构化摘要（中）一致');
    const AE = [
      { arxivId: '1', title: 'A', primaryCategory: 'cs.LG', categories: ['cs.LG', 'cs.CL'], published: '2026-03-01T00:00:00Z', summary: 'image segmentation medical' },
      { arxivId: '2', title: 'B', primaryCategory: 'cs.LG', categories: ['cs.LG'], published: '2026-03-02T00:00:00Z', summary: 'image segmentation dice' },
      { arxivId: '3', title: 'C', primaryCategory: 'cs.CL', categories: ['cs.CL'], published: '2026-03-03T00:00:00Z', summary: 'speech recognition phoneme' },
    ];
    eq(plain(ctx.ArxivAnalyze.categoryStats(AE)), plain(srcAnalyze.categoryStats(AE)), '3 分类统计一致');
    eq(plain(ctx.ArxivAnalyze.extractKeywords(AE, { topN: 5 })), plain(srcAnalyze.extractKeywords(AE, { topN: 5 })), '3 TF-IDF 关键词一致');
    eq(plain(ctx.ArxivAnalyze.clusterTopics(AE, { k: 2, seed: 7 })), plain(srcAnalyze.clusterTopics(AE, { k: 2, seed: 7 })), '3 主题聚类一致（确定性）');
    eq(plain(ctx.ArxivAnalyze.dateHistogram(AE, { bucket: 'month' })), plain(srcAnalyze.dateHistogram(AE, { bucket: 'month' })), '3 时间分布一致');

    /* ============ 4. 限速器在裸 realm 可用 ============ */
    try {
      const rl = new ctx.ArxivRateLimiter.RateLimiter({ minIntervalMs: 0, maxConcurrent: 1 });
      eq(await rl.run(async () => 'ok'), 'ok', '4 RateLimiter 在插件作用域可运行');
    } catch (e) { ok(false, '4 RateLimiter 运行失败', String(e && e.message)); }

    /* ============ 5. ArxivFetch 离线自检 ============ */
    const st = ctx.ArxivFetch.selfTest();
    ok(/^ok /.test(st), '5 selfTest 通过（实机 boot 日志凭它下结论）', st);
    ok(/query=1/.test(st) && /atom=1/.test(st) && /dedupe=1/.test(st) && /cat=1/.test(st) && /rate=1/.test(st), '5 selfTest 各项均为 1', st);
  }

  /* ============ 6. ArxivFetch × 本地桩服务器 ============ */
  const withServer = async (opts, fn) => {
    const srv = await startServer(opts);
    try {
      const c = loadCore();
      const F = installHttpStub(c, 'http://127.0.0.1:' + srv.port + '/api/query');
      return await fn(c, F, srv);
    } finally { await srv.close(); }
  };

  await withServer({ dataset: makeDataset(250) }, async (c, F, srv) => {
    const r = await F.search({ categories: ['cs.LG'] }, { limit: 250, pageSize: 100 });
    eq(r.fetched, 250, '6 分页取满 limit（fetched）');
    eq(r.entries.length, 250, '6 分页取满 limit（去重后）');
    eq(r.pages, 3, '6 分页页数');
    eq(r.totalResults, 250, '6 命中总数透传');
    eq(srv.state.hits.map((h) => h.q.start), ['0', '100', '200'], '6 游标按服务端返回条数推进');
    ok(r.url.indexOf('search_query=cat:cs.LG') > 0, '6 请求 URL 带编码后的查询串', r.url);
    ok(r.entries[0].absUrl.indexOf('https://arxiv.org/abs/') === 0, '6 条目带 abs/pdf 链接');
  });

  await withServer({ dataset: makeDataset(1) }, async (c, F, srv) => {
    let err = null;
    try { await F.search({}, { limit: 5 }); } catch (e) { err = e; }
    ok(err && err.code === 'USAGE_ERROR', '6 空条件抛 UsageError', err && err.message);
    eq(srv.state.hits.length, 0, '6 空条件不发请求');
  });

  await withServer({ dataset: makeDataset(1), failQueue: [{ status: 400, body: errorFeedXml('incorrect category format: cs.cl') }] }, async (c, F, srv) => {
    let err = null;
    try { await F.search({ categories: ['cs.cl'] }, { limit: 1 }); } catch (e) { err = e; }
    ok(err && err.code === 'API_ERROR', '6 400 → ApiError（Zotero.HTTP 不抛异常，必须自行判状态）', err && err.message);
    ok(err && /incorrect category format/.test(err.message), '6 400 业务错误文案被带出', err && err.message);
    ok(err && !!err.hint, '6 400 附带排查建议');
    eq(srv.state.hits.length, 1, '6 业务错误不重试');
  });

  await withServer({ dataset: makeDataset(3), failQueue: [{ status: 503 }, { status: 500 }] }, async (c, F, srv) => {
    const r = await F.search({ categories: ['cs.LG'] }, { limit: 3 });
    eq(r.entries.length, 3, '6 5xx 重试后成功');
    eq(F.stats().requests, 3, '6 请求计数 = 1 成功 + 2 重试');
    eq(F.stats().retries, 2, '6 重试计数');
  });

  await withServer({ dataset: makeDataset(1), failQueue: [{ status: 429 }, { status: 503 }, { status: 503 }, { status: 503 }] }, async (c, F, srv) => {
    let err = null;
    try { await F.search({ categories: ['cs.LG'] }, { limit: 1 }); } catch (e) { err = e; }
    ok(err && err.code === 'RATE_LIMIT', '6 限速重试耗尽后抛 RateLimitError', err && err.code);
    ok(F.stats().failures >= 1, '6 失败计数递增');
  });

  await withServer({ dataset: makeDataset(250) }, async (c, F, srv) => {
    F.configure({ minIntervalMs: 60 });
    await F.search({ categories: ['cs.LG'] }, { limit: 250, pageSize: 100 });
    const hits = srv.state.hits;
    eq(hits.length, 3, '6 限速用例三次请求');
    let minGap = Infinity;
    for (let i = 1; i < hits.length; i++) minGap = Math.min(minGap, hits[i].at - hits[i - 1].at);
    ok(minGap >= 45, '6 请求启动间隔受 RateLimiter 约束（≥60ms，arXiv 礼节）', minGap);
  });

  const ds2 = makeDataset(2);
  ds2.push({ id: ds2[0].id, version: 2, title: ds2[0].title, published: ds2[0].published, updated: '2026-06-01T00:00:00Z', cat: 'cs.LG' });
  await withServer({ dataset: ds2 }, async (c, F, srv) => {
    const r = await F.search({ categories: ['cs.LG'] }, { limit: 10, pageSize: 10 });
    eq(r.fetched, 3, '6 去重前条数');
    eq(r.entries.length, 2, '6 去重后条数');
    eq(r.duplicatesRemoved, 1, '6 去重计数（UI 可提示已合并 N 条）');
    eq(r.entries.find((e) => e.arxivId === ds2[0].id).version, 2, '6 保留高版本');
  });

  /* ---- 汇总 ---- */
  console.log('\narXiv 核心（插件侧）：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
