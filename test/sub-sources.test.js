#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 检索订阅 · 多源适配层测试（sub-sources.js）
 *
 * 覆盖两类失败模式：
 *   ① 查询构建错：分类大小写、AND/OR、日期窗、PubMed [tiab] —— 静默少结果/多噪声；
 *   ② 归一化错：OpenAlex 倒排摘要、Crossref 日期、PubMed DOI —— 入库字段错、去重失效。
 * 以及多源容错：一个源失败不能让整次订阅失败；全失败才 ok:false。
 *
 * 运行：node test/sub-sources.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'chrome', 'content', 'scripts', 'features', 'sub-sources.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(s, needle, label) { return ok(String(s || '').indexOf(needle) >= 0, label, { needle }); }

const AT = new Date(2026, 9, 19, 8, 0, 0); // 2026-10-19 08:00 本地

function makeEnv(opts) {
  opts = opts || {};
  const calls = [];
  const store = new Map(Object.entries(opts.prefs || {}));
  const Zotero = {
    locale: 'zh-CN',
    Prefs: {
      get(k) { return store.has(k) ? store.get(k) : undefined; },
      set(k, v) { store.set(k, v); },
    },
    logError() {},
    debug() {},
    HTTP: {
      request(method, url) {
        calls.push({ method, url });
        const handler = opts.http ? opts.http(url) : null;
        if (handler instanceof Error) return Promise.reject(handler);
        return Promise.resolve({ status: handler ? handler.status : 200, response: handler ? handler.body : {} });
      },
    },
  };
  const Prefs = {
    get(k, fallback) {
      const full = 'extensions.zotero.papilot.' + k;
      return store.has(full) ? store.get(full) : fallback;
    },
    set(k, v) { store.set('extensions.zotero.papilot.' + k, v); },
  };
  const sandbox = {
    Zotero, Prefs,
    console,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, Error, RegExp,
    isNaN, isFinite, parseInt, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      // 只对「应用层超时竞速」的长计时器 unref，避免测试进程被 25s 卡住；
      // 0ms 的限速等待必须保持 ref，否则事件循环会提前退出（静默 0 输出）
      if (ms >= 1000 && t && typeof t.unref === 'function') t.unref();
      return t;
    },
  };
  if (opts.arxiv) sandbox.ArxivFetch = opts.arxiv;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'sub-sources.js' });
  return { S: sandbox.SubSources, calls, store };
}

function sub(over) {
  return Object.assign({ keywords: 'sparse attention', categories: '', mode: 'all', exclude: '', maxAgeDays: 0, sources: ['arxiv'] }, over || {});
}

function openAlexWork(over) {
  return Object.assign({
    id: 'https://openalex.org/W123',
    doi: 'https://doi.org/10.1000/ABC',
    title: 'Sparse <i>Attention</i> for Long Context',
    publication_date: '2026-10-10',
    publication_year: 2026,
    authorships: [{ author: { display_name: 'Ada Lovelace' } }, { author: { display_name: 'Alan Turing' } }],
    primary_location: { source: { display_name: 'Journal of Tests' }, landing_page_url: 'https://example.org/a' },
    open_access: { oa_url: 'https://example.org/a.pdf' },
    cited_by_count: 12,
    type: 'article',
    biblio: { volume: '3', issue: '2', first_page: '10', last_page: '20' },
    primary_topic: { display_name: 'Attention Mechanisms' },
    abstract_inverted_index: { Sparse: [0], attention: [1], works: [2], here: [3] },
  }, over || {});
}

function crossrefWork(over) {
  return Object.assign({
    DOI: '10.2000/XYZ',
    title: ['A Crossref Paper'],
    author: [{ given: 'Grace', family: 'Hopper' }],
    abstract: '<jats:p>We test <jats:italic>things</jats:italic>.</jats:p>',
    published: { 'date-parts': [[2026, 5, 7]] },
    'container-title': ['Journal of Crossref'],
    URL: 'https://doi.org/10.2000/xyz',
    type: 'journal-article',
    'is-referenced-by-count': 4,
    volume: '9',
    issue: '1',
    page: '1-9',
  }, over || {});
}

function pubmedDoc(over) {
  return Object.assign({
    uid: '40000001',
    title: 'A PubMed Paper.',
    pubdate: '2026 Oct 3',
    authors: [{ name: 'Fleming A' }, { name: 'Chain E' }],
    fulljournalname: 'Journal of Medicine',
    volume: '12',
    issue: '4',
    pages: '100-110',
    articleids: [{ idtype: 'doi', value: '10.3000/med' }],
  }, over || {});
}

async function main() {
  /* ================== ① 条件归一 ================== */
  {
    const { S } = makeEnv();
    eq(JSON.stringify(S.normalizeSources(['arxiv', 'nope', 'ARXIV', 'pubmed'])), '["arxiv","pubmed"]', '① 源列表过滤未知/去重');
    eq(JSON.stringify(S.normalizeSources('')), '["arxiv"]', '① 空源 → arxiv（旧订阅兼容）');
    eq(JSON.stringify(S.normalizeSources('openalex, crossref')), '["openalex","crossref"]', '① 字符串源也可解析');
    eq(S.modeOf({ mode: 'ANY' }), 'any', '① mode 大小写归一');
    eq(S.modeOf({ mode: 'weird' }), 'all', '① 未知 mode → all');
    eq(S.maxAgeDays({ maxAgeDays: '0' }), 0, '① 0 = 不限');
    eq(S.maxAgeDays({ maxAgeDays: '9999' }), 3650, '① 天数夹紧');
    eq(S.dateFrom({ maxAgeDays: 7 }, AT), '2026-10-12', '① 近 7 天 → 本地日期');
    eq(S.dateFrom({ maxAgeDays: 0 }, AT), '', '① 不限 → 空日期');
    eq(S.dayKey(new Date(2026, 0, 2)), '2026-01-02', '① 本地日期键补零');
  }

  /* ================== ② 查询构建 ================== */
  {
    const { S } = makeEnv();
    eq(S.openAlexQuery(sub({ keywords: 'sparse attention, long context', mode: 'all' })),
      '"sparse attention" AND "long context"', '② OpenAlex all → AND + 短语引号');
    eq(S.openAlexQuery(sub({ keywords: 'a, b', mode: 'any' })), '"a" OR "b"', '② OpenAlex any → OR');
    eq(S.openAlexQuery(sub({ keywords: 'sparse attention', mode: 'phrase' })), '"sparse attention"', '② OpenAlex phrase → 单短语');
    eq(S.openAlexQuery(sub({ keywords: '' })), '', '② 无关键词 → 空查询');

    const ax = S.arxivSpec(sub({ keywords: 'a, b', categories: 'cs.LG, cs.CL', mode: 'any', exclude: 'survey' }));
    eq(JSON.stringify(ax.keywords), '["a","b"]', '② arXiv keywords 数组');
    eq(JSON.stringify(ax.categories), '["cs.LG","cs.CL"]', '② arXiv 分类数组');
    eq(ax.categoryMode, 'OR', '② arXiv 多分类并集');
    eq(ax.boolean, 'OR', '② arXiv any → OR');
    eq(JSON.stringify(ax.excludeKeywords), '["survey"]', '② arXiv 排除词');
    eq(ax.dateFrom || '', '', '② 不限天数 → 无日期子句');
    eq(JSON.stringify(S.arxivSpec(sub({ keywords: 'a, b', mode: 'phrase' })).keywords), '["a b"]', '② arXiv phrase 合并为单短语');

    const ax2 = S.arxivSpec(sub({ maxAgeDays: 3 }));
    ok(/^\d{8}0000$/.test(ax2.dateFrom), '② arXiv 日期格式 YYYYMMDD0000', ax2.dateFrom);

    eq(S.pubmedTerm(sub({ keywords: 'sparse attention, fMRI', mode: 'all' })),
      '("sparse attention"[tiab] AND fMRI[tiab])', '② PubMed all → 括号 + [tiab]');
    eq(S.pubmedTerm(sub({ keywords: 'a, b', mode: 'any' })), '(a[tiab] OR b[tiab])', '② PubMed any → OR');
    eq(S.pubmedTerm(sub({ keywords: 'a, b', exclude: 'mouse' })), '(a[tiab] AND b[tiab]) NOT (mouse[tiab])', '② PubMed 排除');
    eq(S.pubmedTerm(sub({ keywords: '', categories: 'q-bio.NC' })), '', '② PubMed 不吃分类');
    eq(S.europePmcQuery(sub({ keywords: 'a, b', mode: 'all' })), 'a AND b', '② Europe PMC all → AND');
    eq(S.europePmcQuery(sub({ keywords: 'sparse attention', mode: 'phrase' })), '"sparse attention"', '② Europe PMC phrase');
    eq(S.europePmcQuery(sub({ keywords: 'a, b', exclude: 'mouse' })), 'a AND b NOT (mouse)', '② Europe PMC 排除');
  }

  /* ================== ③ 归一化 ================== */
  {
    const { S } = makeEnv();
    eq(S.abstractFromInverted({ b: [1], a: [0], c: [2] }), 'a b c', '③ OpenAlex 倒排摘要还原顺序');
    eq(S.abstractFromInverted(null), '', '③ 无摘要 → 空串');
    eq(S.abstractFromInverted({ a: [99999] }), '', '③ 越界位置忽略');

    const oa = S.normalizeOpenAlex(openAlexWork());
    eq(oa.source, 'openalex', '③ OA source');
    eq(oa.doi, '10.1000/ABC', '③ OA DOI 去 doi.org');
    eq(oa.title, 'Sparse Attention for Long Context', '③ OA 标题去 HTML 标签');
    eq(oa.summary, 'Sparse attention works here', '③ OA 摘要');
    eq(oa.authors.length, 2, '③ OA 作者');
    eq(oa.published, '2026-10-10', '③ OA 日期');
    eq(oa.venue, 'Journal of Tests', '③ OA 期刊');
    eq(oa.pdfUrl, 'https://example.org/a.pdf', '③ OA 开放获取 PDF');
    eq(oa.citationCount, 12, '③ OA 被引量');
    eq(oa.pages, '10-20', '③ OA 页码');

    const cr = S.normalizeCrossref(crossrefWork());
    eq(cr.doi, '10.2000/XYZ', '③ CR DOI');
    eq(cr.title, 'A Crossref Paper', '③ CR 标题');
    eq(cr.summary, 'We test things.', '③ CR 摘要去 JATS 标签');
    eq(cr.published, '2026-05-07', '③ CR date-parts 日期');
    eq(cr.authors[0], 'Grace Hopper', '③ CR 作者');
    eq(cr.venue, 'Journal of Crossref', '③ CR 期刊');
    eq(cr.citationCount, 4, '③ CR 被引量');

    const pm = S.normalizePubMed(pubmedDoc(), '40000001');
    eq(pm.doi, '10.3000/med', '③ PM DOI');
    eq(pm.published, '2026-10-01', '③ PM 月份缩写转数字');
    eq(pm.authors[0], 'Fleming A', '③ PM 作者');
    eq(pm.url, 'https://pubmed.ncbi.nlm.nih.gov/40000001/', '③ PM URL');
    eq(pm.venue, 'Journal of Medicine', '③ PM 期刊');
    eq(pm.type, 'journal-article', '③ PM 类型');

    const ep = S.normalizeEuropePmc({
      id: 'PPR123', source: 'PPR', doi: '10.4000/pre', title: 'A Preprint',
      authorString: 'Smith J, Doe A.', journalInfo: {}, pubYear: '2026',
      firstPublicationDate: '2026-09-02', abstractText: '<p>Hello</p>', citedByCount: 3,
      fullTextUrlList: { fullTextUrl: [{ url: 'https://x/y.pdf', documentStyle: 'pdf', availability: 'Open access' }] },
    });
    eq(ep.source, 'europepmc', '③ EPMC source');
    eq(ep.doi, '10.4000/pre', '③ EPMC DOI');
    eq(ep.title, 'A Preprint', '③ EPMC 标题');
    eq(ep.summary, 'Hello', '③ EPMC 摘要去标签');
    eq(ep.authors[0], 'Smith J', '③ EPMC 作者去尾点');
    eq(ep.published, '2026-09-02', '③ EPMC 日期');
    eq(ep.pdfUrl, 'https://x/y.pdf', '③ EPMC PDF');
    eq(ep.citationCount, 3, '③ EPMC 被引');
    eq(ep.type, 'preprint', '③ EPMC 预印本类型');
  }

  /* ================== ④ 去重 / 本地复核 ================== */
  {
    const { S } = makeEnv();
    const a = { source: 'arxiv', arxivId: '2601.00001', title: 'Same Paper', doi: '', summary: 'sparse attention', published: '2026-10-01' };
    const b = { source: 'openalex', doi: '10.1/SAME', title: 'Same Paper', summary: 'long context', citationCount: 30, pdfUrl: 'x.pdf' };
    const c = { source: 'crossref', doi: '10.1/same', title: 'Same Paper (dup)', summary: '', citationCount: 5 };
    eq(S.fingerprint(a), 'arXiv:2601.00001', '④ arXiv 指纹');
    eq(S.fingerprint(b), 'doi:10.1/same', '④ DOI 指纹小写');
    const out = S.dedupe([a, b, c]);
    eq(out.length, 2, '④ 同 DOI 跨源合并');
    const merged = out.filter((x) => x.doi)[0];
    eq(merged.citationCount, 30, '④ 合并保留较大被引');
    eq(merged.pdfUrl, 'x.pdf', '④ 合并补齐 PDF');
    eq(merged.summary, 'long context', '④ 合并保留非空摘要');
    ok((merged.sources || []).indexOf('crossref') >= 0, '④ 合并记录来源');

    ok(S.matches(sub({ keywords: 'sparse, attention', mode: 'all' }), { title: 'Sparse attention', summary: 'about sparse attention' }), '④ all 命中');
    ok(!S.matches(sub({ keywords: 'sparse, quantum', mode: 'all' }), { title: 'Sparse attention', summary: 'about sparse attention' }), '④ all 缺一不命中');
    ok(S.matches(sub({ keywords: 'sparse, quantum', mode: 'any' }), { title: 'Sparse attention', summary: 'about sparse attention' }), '④ any 任一命中');
    ok(!S.matches(sub({ keywords: 'sparse attention', mode: 'phrase' }), { title: 'Sparse long attention', summary: 'sparse long attention here' }), '④ phrase 必须连续');
    ok(S.matches(sub({ keywords: 'x' }), { title: 'T', summary: '' }), '④ 无摘要不误杀');
  }

  /* ================== ⑤ 多源容错 ================== */
  {
    const arxiv = {
      search() {
        return Promise.resolve({
          entries: [{ arxivId: '2601.00009', title: 'Attention Paper', summary: 'sparse attention', published: '2026-10-18', categories: ['cs.LG'], authors: ['A B'], absUrl: 'https://arxiv.org/abs/2601.00009' }],
          totalResults: 1, pages: 1,
        });
      },
    };
    const { S, calls } = makeEnv({
      arxiv,
      http: (url) => {
        if (url.indexOf('openalex') >= 0) return new Error('network down');
        return { status: 200, body: { results: [] } };
      },
    });
    const r = await S.search(sub({ sources: ['arxiv', 'openalex'] }), { limit: 5, now: AT });
    eq(r.ok, true, '⑤ 一个源失败仍 ok');
    eq(r.partial, true, '⑤ 标记 partial');
    eq(r.entries.length, 1, '⑤ 返回成功源结果');
    eq(r.bySource.arxiv.ok, true, '⑤ arXiv bySource ok');
    eq(r.bySource.openalex.ok, false, '⑤ OpenAlex bySource failed');
    has(r.bySource.openalex.reason, 'network', '⑤ 失败原因保留');
    ok(calls.some((c) => c.url.indexOf('openalex') >= 0), '⑤ 确实请求了 OpenAlex');
  }
  {
    const { S } = makeEnv({ http: () => new Error('down') });
    const r = await S.search(sub({ sources: ['openalex'] }), { limit: 5, now: AT });
    eq(r.ok, false, '⑤ 全失败 → ok:false');
    ok(!!r.reason, '⑤ 全失败有 reason');
    eq(r.entries.length, 0, '⑤ 全失败无条目');
  }

  /* ================== ⑥ OpenAlex 请求参数 + 本地复核 ================== */
  {
    const { S, calls } = makeEnv({
      http: () => ({
        status: 200,
        body: {
          results: [
            openAlexWork({ title: 'Sparse attention for long context', doi: '10.1000/hit' }),
            openAlexWork({ title: 'Quantum chemistry', doi: '10.1000/miss', abstract_inverted_index: { Quantum: [0], chemistry: [1] } }),
          ],
        },
      }),
    });
    const r = await S.search(sub({ sources: ['openalex'], keywords: 'sparse attention', mode: 'all', maxAgeDays: 7 }), { limit: 5, now: AT });
    eq(r.ok, true, '⑥ OpenAlex 检索 ok');
    eq(r.entries.length, 1, '⑥ 本地复核过滤掉不相关条目');
    eq(r.entries[0].doi, '10.1000/hit', '⑥ 保留命中条目');
    const url = calls[0].url;
    const decoded = decodeURIComponent(url);
    has(url, 'api.openalex.org/works', '⑥ OpenAlex 端点');
    has(url, 'search=', '⑥ 带 search');
    has(decoded, 'from_publication_date:2026-10-12', '⑥ 带日期过滤');
    has(url, 'per-page=5', '⑥ 带条数');
    has(decoded, 'type:article', '⑥ 限定文献类型');
  }

  /* ================== ⑦ PubMed 两步 + 无关键词降级 ================== */
  {
    const { S, calls } = makeEnv({
      http: (url) => {
        if (url.indexOf('esearch') >= 0) return { status: 200, body: { esearchresult: { idlist: ['40000001'] } } };
        return { status: 200, body: { result: { uids: ['40000001'], 40000001: pubmedDoc() } } };
      },
    });
    const r = await S.search(sub({ sources: ['pubmed'], keywords: 'sparse attention', categories: 'q-bio.NC' }), { limit: 3, now: AT });
    eq(r.ok, true, '⑦ PubMed 检索 ok');
    eq(r.entries.length, 1, '⑦ PubMed 归一一条');
    eq(r.entries[0].doi, '10.3000/med', '⑦ PubMed DOI');
    ok(calls.filter((c) => c.url.indexOf('esearch') >= 0).length === 1, '⑦ 先 esearch');
    ok(calls.filter((c) => c.url.indexOf('esummary') >= 0).length === 1, '⑦ 再 esummary');
  }
  {
    const { S, calls } = makeEnv();
    const r = await S.search(sub({ sources: ['pubmed'], keywords: '', categories: 'q-bio.NC' }), { limit: 3, now: AT });
    eq(r.ok, false, '⑦ PubMed 无关键词 → 失败');
    has(r.reason, '关键词', '⑦ 失败原因说明需要关键词');
    eq(calls.length, 0, '⑦ 不发无意义请求');
  }

  /* ================== ⑧ Europe PMC（生物医学替代，单请求） ================== */
  {
    const { S, calls } = makeEnv({
      http: () => ({
        status: 200,
        body: {
          hitCount: 1,
          resultList: {
            result: [{
              id: '40000002', source: 'MED', pmid: '40000002', doi: '10.5000/epmc',
              title: 'Sparse attention in medicine', authorString: 'Fleming A, Chain E.',
              journalInfo: { journal: { title: 'Journal of EPMC' } }, pubYear: '2026',
              firstPublicationDate: '2026-10-05', abstractText: 'Sparse attention works.',
              citedByCount: 9,
            }],
          },
        },
      }),
    });
    const r = await S.search(sub({ sources: ['europepmc'], keywords: 'sparse attention' }), { limit: 5, now: AT });
    eq(r.ok, true, '⑧ Europe PMC 检索 ok');
    eq(r.entries.length, 1, '⑧ 归一一条');
    eq(r.entries[0].doi, '10.5000/epmc', '⑧ DOI');
    eq(r.entries[0].venue, 'Journal of EPMC', '⑧ 期刊');
    eq(calls.length, 1, '⑧ 单请求完成（不需要 esearch/esummary 两步）');
    const decoded = decodeURIComponent(calls[0].url);
    has(decoded, 'query=', '⑧ 查询串');
    has(decoded, 'sparse attention', '⑧ 查询词');
    has(decoded, 'resultType=core', '⑧ 带摘要');
    has(decoded, 'P_PDATE_D desc', '⑧ 按发表日期排序');
  }
  /* ================== ⑨ 0.58.0：作者追踪（四源查询 / OpenAlex Key / 本地复核） ================== */
  {
    const { S } = makeEnv();
    eq(JSON.stringify(S.authorsOf({ authors: 'Ada Lovelace, Alan Turing, , X' })),
      '["Ada Lovelace","Alan Turing","X"]', '⑨ authorsOf 切分');
    eq(S.authorsOf({ authors: Array.from({ length: 9 }, (_, i) => 'Author ' + i) }).length, 6,
      '⑨ authorsOf 最多 6 个');

    const ax = S.arxivSpec({ keywords: '', authors: 'Ada Lovelace' });
    eq(JSON.stringify(ax.authors), '["Ada Lovelace"]', '⑨ arXiv spec 带 authors');
    eq(JSON.stringify(ax.keywords), '[]', '⑨ 作者-only 时 keywords 为空');

    eq(S.pubmedTerm({ authors: 'Ada Lovelace' }), '"Ada Lovelace"[au]', '⑨ PubMed 作者-only 也能出查询');
    eq(S.pubmedTerm({ keywords: 'sparse attention', authors: 'Ada Lovelace, Alan Turing' }),
      '("sparse attention"[tiab] AND ("Ada Lovelace"[au] OR "Alan Turing"[au]))',
      '⑨ ★ PubMed 关键词 + 作者用 AND，多作者 OR 分组');
    eq(S.pubmedTerm({ keywords: '', authors: '' }), '', '⑨ 关键词与作者都空 → 空串');
    eq(S.pubmedTerm({ keywords: '', categories: 'q-bio.NC' }), '', '⑨ 只有分类 → 空串（分类只对 arXiv 有意义）');

    eq(S.europePmcQuery({ authors: 'Ada Lovelace' }), 'AUTH:"Ada Lovelace"', '⑨ Europe PMC 作者-only');
    eq(S.europePmcQuery({ keywords: 'sparse attention', authors: 'Ada Lovelace, Alan Turing' }),
      '("sparse attention") AND (AUTH:"Ada Lovelace" OR AUTH:"Alan Turing")',
      '⑨ ★ Europe PMC (关键词组) AND (作者组)');
    eq(S.europePmcQuery({ keywords: '', authors: '' }), '', '⑨ Europe PMC 无条件 → 空串');
  }

  {
    // OpenAlex 作者-only：filter 里带 raw_author_name.search，且不带 search 参数
    const { S, calls } = makeEnv({
      http: () => ({ status: 200, body: { results: [openAlexWork()] } }),
    });
    const r = await S.search(sub({ sources: ['openalex'], keywords: '', authors: 'Ada Lovelace, Alan Turing' }),
      { limit: 5, now: AT });
    eq(r.ok, true, '⑨ OpenAlex 作者-only 检索 ok');
    eq(r.entries.length, 1, '⑨ OpenAlex 作者-only 有结果');
    const url = calls[0].url;
    has(decodeURIComponent(url), 'raw_author_name.search:Ada Lovelace|Alan Turing',
      '⑨ ★ OpenAlex 作者过滤（| 分隔 = OR）');
    ok(url.indexOf('search=') < 0, '⑨ ★ 作者-only 不带 search 参数', url);
    ok(url.indexOf('api_key=') < 0, '⑨ 未配置 Key 时不带 api_key');
  }

  {
    // OpenAlex 免费 Key：配置后进 URL；绝不进 bySource / 日志
    const { S, calls } = makeEnv({
      prefs: { 'extensions.zotero.papilot.openAlexApiKey': 'KEY-123' },
      http: () => ({ status: 200, body: { results: [openAlexWork()] } }),
    });
    const r = await S.search(sub({ sources: ['openalex'], keywords: 'sparse attention' }), { limit: 5, now: AT });
    eq(r.ok, true, '⑨ 配 Key 后 OpenAlex 仍 ok');
    eq(r.entries.length, 1, '⑨ 配 Key 不影响检索结果');
    has(calls[0].url, 'api_key=KEY-123', '⑨ ★ OpenAlex Key 进 URL');
    ok(JSON.stringify(r.bySource).indexOf('KEY-123') < 0, '⑨ ★ Key 不进 bySource（不写日志/不回显）');
    eq(S._oaKey(), 'KEY-123', '⑨ _oaKey 读 pref');
    eq(makeEnv().S._oaKey(), '', '⑨ 未配置时 _oaKey 为空串');
  }

  {
    // Crossref：作者走 query.author（只支持第一个），其余靠本地复核
    const { S, calls } = makeEnv({
      http: () => ({
        status: 200,
        body: {
          message: {
            items: [crossrefWork({ title: ['Author Paper'], author: [{ given: 'Ada', family: 'Lovelace' }] })],
          },
        },
      }),
    });
    const r = await S.search(sub({ sources: ['crossref'], keywords: '', authors: 'Ada Lovelace, Alan Turing' }),
      { limit: 5, now: AT });
    eq(r.ok, true, '⑨ Crossref 作者-only 检索 ok');
    eq(r.entries.length, 1, '⑨ Crossref 作者-only 有结果');
    const decoded = decodeURIComponent(calls[0].url);
    has(decoded, 'query.author=Ada Lovelace', '⑨ ★ Crossref 用第一个作者查');
    ok(calls[0].url.indexOf('query.bibliographic') < 0, '⑨ 作者-only 不带 bibliographic', calls[0].url);
  }

  {
    // Europe PMC / PubMed 作者-only 也要真的发出请求（不是静默跳过）
    const { S, calls } = makeEnv({
      http: (url) => {
        if (url.indexOf('europepmc') >= 0) return { status: 200, body: { resultList: { result: [] } } };
        return { status: 200, body: { esearchresult: { idlist: [] } } };
      },
    });
    const r1 = await S.search(sub({ sources: ['europepmc'], keywords: '', authors: 'Ada Lovelace' }), { limit: 5, now: AT });
    eq(r1.ok, true, '⑨ Europe PMC 作者-only 检索 ok');
    has(decodeURIComponent(calls[0].url), 'AUTH:"Ada Lovelace"', '⑨ ★ Europe PMC 作者查询进了请求');

    const r2 = await S.search(sub({ sources: ['pubmed'], keywords: '', authors: 'Fleming A' }), { limit: 5, now: AT });
    eq(r2.ok, true, '⑨ PubMed 作者-only 检索 ok');
    has(decodeURIComponent(calls[calls.length - 1].url), '"Fleming A"[au]', '⑨ ★ PubMed 作者查询进了请求');
  }

  {
    // 本地作者复核：命中保留 / 不命中过滤 / 条目无作者时不误杀
    const { S } = makeEnv();
    const target = { authors: 'Ada Lovelace' };
    ok(S.matches(target, { title: 'T', summary: 'abstract here', authors: ['Ada Lovelace', 'X Y'] }),
      '⑨ 作者命中 → 保留');
    ok(!S.matches(target, { title: 'T', summary: 'x', authors: ['Grace Hopper'] }),
      '⑨ ★ 作者不命中 → 过滤掉');
    ok(S.matches(target, { title: 'T', summary: 'x', authors: [] }), '⑨ 条目作者为空 → 不误杀');
    ok(S.matches(target, { title: 'T', summary: 'x' }), '⑨ 条目无 authors 字段 → 不误杀');
    ok(S.matches({ authors: 'Alexander Fleming' }, { title: 'T', summary: 'x', authors: ['Fleming A'] }),
      '⑨ 姓名写法差异（全名 vs 缩写）也能命中');
    ok(!S.matches({ keywords: 'sparse', authors: 'Ada Lovelace' },
      { title: 'Quantum', summary: 'about quantum', authors: ['Ada Lovelace'] }),
      '⑨ ★ 关键词不命中时，作者命中也不放行');
    ok(S.matches({ keywords: 'sparse', authors: 'Ada Lovelace' },
      { title: 'Sparse', summary: 'about sparse', authors: ['Ada Lovelace'] }),
      '⑨ 关键词与作者都命中 → 保留');
  }
  {
    // 失败原因里带的凭据必须脱敏（reason 会进面板提示 / 运行历史 / 速递）
    const { S } = makeEnv({
      http: () => new Error('bad https://api.openalex.org/works?api_key=SECRET123&x=1'),
    });
    const r = await S.search(sub({ sources: ['openalex'], keywords: 'sparse attention' }), { limit: 5, now: AT });
    eq(r.ok, false, '⑨ Key 脱敏：请求失败仍 ok:false');
    ok(String(r.reason).indexOf('SECRET123') < 0, '⑨ ★ 汇总 reason 不含 api_key 明文', r.reason);
    ok(String(r.bySource.openalex.reason).indexOf('SECRET123') < 0, '⑨ ★ bySource.reason 已脱敏');
    has(String(r.bySource.openalex.reason), 'api_key=***', '⑨ 脱敏成 api_key=***');
    has(String(r.bySource.openalex.reason), '&x=1', '⑨ 只遮凭据，不动其余信息');
  }
}

main().then(() => {
  if (fails.length) {
    console.error('\n✗ 多源适配测试失败 ' + fails.length + ' 项 / ' + (pass + fails.length) + ' 项断言');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 多源适配测试通过：' + pass + ' 项断言');
}).catch((e) => {
  console.error('✗ 测试执行异常：' + (e && (e.stack || e.message) || e));
  process.exit(1);
});
