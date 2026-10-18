#!/usr/bin/env node
/* 引文上下文（Scite 风格）测试（0.52.0）
 *
 * 无人环境点不了 ItemPane section，也连不上 Semantic Scholar；这里用
 * 「迷你 DOM + vm 沙箱 + HTTP 桩」把四条链路真跑一遍：
 *   ① S2Client.citations：URL/fields/limit 拼装、paperId 归一、缓存、429/断网降级，
 *      以及**双模分派**——单参旧调用仍然返回 [{citingPaper}]（citation-trace 不能被静默打断）；
 *   ② _classify：批评/对比/支持/中性、中英关键词、methodology、isInfluential、空文本、大小写；
 *   ③ fetchFor：排序（critique > contrast > support > neutral）+ 上限 8 + total 原始条数、
 *      无 DOI、S2 失败透传、条目缺失、contexts 缺失回落；
 *   ④ register/unregister + pane 渲染（标题行/状态行/徽标/引用句/在 S2 打开）。
 *
 * 运行：node test/citation-context.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const S = (p) => path.join(ROOT, 'chrome', 'content', 'scripts', p);

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM（与 related-papers.test.js 同一套技法） ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false;
    this.id = ''; this.parentNode = null; this.handlers = {};
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
    if (k.indexOf('data-') === 0) this.dataset[k.slice(5)] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) f(arg || {}); }
  click() { this.fire('click'); }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  byClass(cls) { return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(cls) >= 0); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
}

function makeDoc() {
  return {
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    getElementById: () => null,
  };
}

async function drain(cond, maxRounds = 200) {
  for (let i = 0; i < maxRounds; i++) {
    if (cond()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return cond();
}

/* ---------------- 桩：Zotero / HTTP ---------------- */

const calls = {
  http: [], httpMode: 'ok', section: null, registered: 0, unregistered: null,
  citeRows: null, launched: [],
};

function citing(i, ctx, intents, inf) {
  return {
    citingPaper: {
      paperId: 'p' + i,
      title: 'Citing Paper ' + i,
      year: 2000 + i,
      authors: [{ authorId: '1', name: 'Alice Alpha' }, { authorId: '2', name: 'Bob Beta' }],
    },
    contexts: ctx == null ? [] : [ctx],
    intents: intents || ['background'],
    isInfluential: !!inf,
  };
}

const CITE_ROWS = [
  citing(1, 'In contrast to our approach, this method requires tuning.'),
  citing(2, 'The results are consistent with our findings.'),
  citing(3, 'However, this approach fails on long inputs.'),
  citing(4, null),
  citing(5, '该方法存在明显不足。'),
  citing(6, 'We extend this work with a new decoder.'),
  citing(7, 'Unlike prior work, the setup differs in scope.'),
  citing(8, '结果与文献一致。'),
  citing(9, 'We use the same dataset.'),
  citing(10, 'This contradicts the earlier claim.'),
];

const Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: { get: () => undefined, set() {} },
  ItemPaneManager: {
    registerSection(opts) {
      calls.registered++;
      calls.section = opts;
      return 'paperpilot@dev.local-citecon-' + calls.registered;
    },
    unregisterSection(id) { calls.unregistered = id; },
  },
  HTTP: {
    request: async (method, url, opts) => {
      calls.http.push({ method, url, opts });
      if (calls.httpMode === '429') { const e = new Error('HTTP 429'); e.status = 429; throw e; }
      if (calls.httpMode === 'offline') throw new Error('NS_ERROR_UNKNOWN_HOST');
      if (/\/citations\?/.test(url)) {
        return { response: { data: calls.citeRows == null ? CITE_ROWS : calls.citeRows } };
      }
      return { response: { recommendedPapers: [] } };
    },
  },
  launchURL(url) { calls.launched.push(url); },
  logError() {},
  PaperPilot: {},
};

/* ---------------- 沙箱：真实 semantic-scholar.js + s2-client.js + citation-context.js ---------------- */

const sandbox = {
  console, Zotero,
  Services: { appShell: { hiddenDOMWindow: { open() {} } } },
  // 长定时器（_req 的 25s 应用层超时）不真挂，避免 node 进程被拖住
  setTimeout: (fn, ms) => (ms > 2000 ? { fake: true } : setTimeout(fn, ms)),
  clearTimeout, setImmediate, Promise, Date, Math, JSON, Map, Set,
  encodeURIComponent, decodeURIComponent, encodeURI, parseInt, isFinite, String, Array, Object,
  Prefs: { get: (k, d) => (k === 's2ApiKey' ? 'test-key' : d), set() {} },
  I18n: { isZh: true, t: (k) => k },
  RegExp,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['ai/semantic-scholar.js', 'features/s2-client.js', 'features/citation-context.js']) {
  vm.runInContext(fs.readFileSync(S(f), 'utf8'), sandbox, { filename: f });
}
const S2 = sandbox.S2Client;
const CC = sandbox.CitationContext;

function makeItem(fields) {
  const f = fields || {};
  return {
    id: ++makeItem.seq,
    isRegularItem: () => true,
    isAttachment: () => false,
    getField(name) { return f[name] || ''; },
    getDisplayTitle() { return f.title || ''; },
  };
}
makeItem.seq = 0;

const itemDoi = makeItem({ title: 'Seed Paper', DOI: '10.1000/seed.1' });
const itemExtra = makeItem({ title: 'Extra DOI', extra: 'PMID: 123\nDOI: 10.1000/extra.2\n' });
const noDoi = makeItem({ title: 'No DOI' });

async function main() {

/* ================= ① _classify（纯函数） ================= */

eq(typeof CC._classify, 'function', '① _classify 存在');
eq(CC._classify('This approach fails to reproduce the result.'), 'critique', '① fail → critique');
eq(CC._classify('A serious limitation of that study is the sample size.'), 'critique', '① limitation → critique');
eq(CC._classify('该方法在长文本上存在明显不足。'), 'critique', '① 中文「不足」→ critique');
eq(CC._classify('In contrast, our pipeline needs no pretraining.'), 'contrast', '① in contrast → contrast');
eq(CC._classify('相反，该结论在低温下并不成立。'), 'contrast', '① 中文「相反」→ contrast');
eq(CC._classify('The results are consistent with previous work.'), 'support', '① consistent with → support');
eq(CC._classify('这一发现印证了我们的假设。'), 'support', '① 中文「印证」→ support');
eq(CC._classify('结果与已有报告一致。'), 'support', '① 中文「一致」→ support');
eq(CC._classify('We use the same dataset and the same splits.'), 'neutral', '① 无关键词 → neutral');
eq(CC._classify(''), 'neutral', '① 空文本 → neutral');
eq(CC._classify(null), 'neutral', '① null 文本 → neutral');
eq(CC._classify('   '), 'neutral', '① 空白文本 → neutral');
eq(CC._classify('THE METHOD FAILS TO CONVERGE.'), 'critique', '① 大小写不敏感');
eq(CC._classify('Although the pipeline is widely used, it has a serious limitation when the input is long.'),
  'critique', '① 关键词嵌在长句里也能命中');
eq(CC._classify('In contrast with prior work, this approach fails to scale.'),
  'critique', '① 优先级 critique > contrast');
eq(CC._classify('The results are consistent with ours, but the method fails on long inputs.'),
  'critique', '① 优先级 critique > support');
eq(CC._classify('This is consistent with our findings.', ['methodology']),
  'neutral', '① methodology 意图：support 文本降为 neutral（方法引用不代表赞同）');
eq(CC._classify('This is consistent with our findings.', 'methodology,background'),
  'neutral', '① intents 传字符串也能识别 methodology');
eq(CC._classify('This is consistent with our findings.', ['methodology'], true),
  'support', '① isInfluential 且 support：保留 support');
eq(CC._classify('This is consistent with our findings.', ['background'], true),
  'support', '① isInfluential 不改变既有 support');
eq(CC._classify('We use the same dataset.', [], true),
  'neutral', '① isInfluential 不把 neutral 升级成 support');
eq(CC._classify('The method has a limitation in low-resource settings.', ['methodology']),
  'critique', '① methodology 只压制 support，不压制 critique');
eq(CC._classify('该方法简单，而成本更低。'), 'neutral', '① 「而」不作为对比关键词');
eq(CC._classify('It is unlikely that this generalizes to other domains.'),
  'neutral', '① unlikely 不被 unlike 误命中');
eq(CC._classify('Furthermore, we extend the codebase.'),
  'support', '① extend → support（furthermore 不误命中）');

/* ================= ② S2Client.citations ================= */

ok(!!S2 && typeof S2.recommendations === 'function', '② 扩展后 recommendations 仍在');
eq(typeof S2.citations, 'function', '② citations 已挂到 S2Client');
eq(typeof S2._citationsLegacy, 'function', '② 旧 citations 实现被保留（citation-trace 依赖）');

S2._citationsReset();
calls.http = [];
calls.citeRows = null;
const cites = await S2.citations('10.1000/seed.1', 20);
ok(Array.isArray(cites), '② 成功返回数组');
eq(cites.length, 10, '② 返回全部 10 条');
eq(cites[0].title, 'Citing Paper 1', '② title 映射');
eq(cites[0].year, 2001, '② year 转为数字');
eq(cites[0].authors, 'Alice Alpha, Bob Beta', '② authors 数组 → 字符串');
eq(cites[0].contexts.length, 1, '② contexts 保留为数组');
has(cites[0].contexts[0], 'In contrast', '② 引用句原文保留');
eq(cites[0].intents[0], 'background', '② intents 保留');
eq(cites[0].isInfluential, false, '② isInfluential 布尔化');
eq(calls.http.length, 1, '② 只发一次请求');
has(calls.http[0].url, 'graph/v1/paper/DOI%3A10.1000%2Fseed.1/citations', '② 端点与 DOI 前缀正确');
has(calls.http[0].url, 'fields=title%2Cyear%2Cauthors%2Ccontexts%2Cintents%2CisInfluential', '② fields 含 contexts/intents/isInfluential');
has(calls.http[0].url, 'limit=20', '② limit 进 query');
eq(calls.http[0].opts.headers['x-api-key'], 'test-key', '② 复用 _headers（s2ApiKey 注入）');

const again = await S2.citations('10.1000/seed.1', 20);
eq(calls.http.length, 1, '② 同 id/limit 第二次命中缓存（不再请求）');
eq(again.length, 10, '② 缓存返回同样条数');

calls.http = [];
await S2.citations('10.1000/seed.1', 5);
eq(calls.http.length, 1, '② limit 不同 → 缓存 key 不同，重新请求（key 含 limit）');
eq(calls.http[0].url.indexOf('limit=5') >= 0, true, '② 缓存 key 含 limit 的旁证');

calls.http = [];
await S2.citations('DOI:10.1000/seed.1', 20);
eq(calls.http.length, 0, '② 已带 DOI: 前缀 → 归一后同 key，命中缓存');

S2._citationsReset();
calls.http = [];
calls.citeRows = [];
await S2.citations('2101.00001', 20);
has(calls.http[0].url, 'ARXIV%3A2101.00001', '② 裸 arXiv 号 → ARXIV: 前缀');

S2._citationsReset();
calls.http = [];
const corpus = await S2.citations('12345', 20);
ok(Array.isArray(corpus), '② CorpusId 请求成功');
has(calls.http[0].url, 'CorpusId%3A12345', '② 纯数字 → CorpusId: 前缀');
calls.citeRows = null;

S2._citationsReset();
calls.httpMode = '429';
const limited = await S2.citations('10.1000/seed.1', 20);
eq(limited.ok, false, '② 429 返回错误对象，不抛');
eq(limited.reason, 'rate_limit', '② 429 → rate_limit');
has(limited.error, '429', '② 429 文案可读');

S2._citationsReset();
calls.httpMode = 'offline';
const offline = await S2.citations('10.1000/seed.1', 20);
eq(offline.ok, false, '② 断网返回错误对象，不抛');
eq(offline.reason, 'network', '② 断网 → network');
calls.httpMode = 'ok';

// 双模分派：单参旧调用必须仍是原始 [{citingPaper}]（citation-trace 的读取方式）
S2._citationsReset();
calls.http = [];
const legacy = await S2.citations('DOI:10.1000/seed.1');
ok(Array.isArray(legacy), '② 单参旧调用仍返回数组');
eq(legacy.length, 10, '② 旧调用条数不变');
ok(!!(legacy[0] && legacy[0].citingPaper), '② 旧调用保留 .citingPaper 结构');
has(calls.http[0].url, 'limit=200', '② 旧调用仍用旧实现的 limit=200');

S2._citationsReset();
calls.http = [];
const legacyFields = await S2.citations('DOI:10.1000/seed.1', 'title,year', 5);
ok(Array.isArray(legacyFields), '② citations(id, fields, n) 也走旧实现');
has(calls.http[0].url, 'limit=5', '② 旧实现第三参 limit 生效');

/* ================= ③ fetchFor ================= */

S2._citationsReset();
calls.http = [];
const f1 = await CC.fetchFor(itemDoi);
eq(f1.ok, true, '③ 有 DOI：成功');
eq(f1.total, 10, '③ total = 原始条数 10');
eq(f1.entries.length, 8, '③ entries 截到上限 8');
eq(f1.entries[0].stance, 'critique', '③ 排序：critique 最前');
eq(f1.entries[0].title, 'Citing Paper 3', '③ 同倾向内保持 S2 原序');
eq(f1.entries[1].title, 'Citing Paper 5', '③ 第二条仍是 critique');
eq(f1.entries[2].title, 'Citing Paper 10', '③ 第三条仍是 critique');
eq(f1.entries[3].stance, 'contrast', '③ 其次 contrast');
eq(f1.entries[4].stance, 'contrast', '③ contrast 有两条');
eq(f1.entries[5].stance, 'support', '③ 再次 support');
eq(f1.entries[7].stance, 'support', '③ 末尾仍是 support');
eq(f1.entries.filter((e) => e.stance === 'neutral').length, 0, '③ neutral 被上限挤掉（排在最后）');
eq(f1.entries[0].context, 'However, this approach fails on long inputs.', '③ context 取第一个引用句');
eq(f1.entries[0].isInfluential, false, '③ isInfluential 透传');
has(calls.http[0].url, 'DOI%3A10.1000%2Fseed.1', '③ 用条目 DOI 组装 paperId');

const f2 = await CC.fetchFor(itemExtra);
eq(f2.ok, true, '③ DOI 只在 extra 里也能取到');

const f3 = await CC.fetchFor(noDoi);
eq(f3.ok, false, '③ 无 DOI：失败');
eq(f3.reason, 'no_doi', '③ 无 DOI：reason=no_doi');
eq(f3.total, 0, '③ 无 DOI：total=0');
eq(f3.entries.length, 0, '③ 无 DOI：entries 为空');

const f4 = await CC.fetchFor(null);
eq(f4.ok, false, '③ 条目缺失：失败不抛');
eq(f4.reason, 'no_item', '③ 条目缺失：reason=no_item');

S2._citationsReset();
calls.httpMode = '429';
const f5 = await CC.fetchFor(itemDoi);
eq(f5.ok, false, '③ S2 429：降级');
eq(f5.reason, 'rate_limit', '③ S2 失败 reason 透传');
eq(f5.entries.length, 0, '③ 失败时 entries 为空');
calls.httpMode = 'ok';

calls.citeRows = [];
S2._citationsReset();
const f6 = await CC.fetchFor(itemDoi);
eq(f6.ok, true, '③ 无施引记录：仍算成功（空列表）');
eq(f6.total, 0, '③ 无施引记录：total=0');
eq(f6.entries.length, 0, '③ 无施引记录：entries 为空');

// contexts 缺失 → context 空串 + neutral
const e1 = CC._entry({ title: 'No Contexts' });
eq(e1.context, '', '③ contexts 缺失：context 为空串');
eq(e1.stance, 'neutral', '③ contexts 缺失：回落 neutral');
const e2 = CC._entry({ title: 'Two Contexts', contexts: ['We use the same data.', 'It fails badly.'] });
eq(e2.context, 'We use the same data.', '③ 多 context 只取第一个');
eq(e2.stance, 'neutral', '③ 判定只看第一个 context');
const e3 = CC._entry({ title: 'X', contexts: null, intents: null, isInfluential: null });
eq(e3.context, '', '③ contexts=null 不抛');
eq(e3.isInfluential, false, '③ isInfluential=null → false');
calls.citeRows = null;

const savedFn = S2.citations;
delete S2.citations;
const f7 = await CC.fetchFor(itemDoi);
eq(f7.ok, false, '③ S2Client 无 citations：降级不抛');
eq(f7.reason, 'no_client', '③ 客户端缺失：reason=no_client');
S2.citations = savedFn;

/* ================= ④ register / unregister ================= */

eq(CC._l10nID, 'paperpilot-citecon-section-header', '④ _l10nID 常量与集成方 ftl 对齐');

const handle1 = CC.register('paperpilot@dev.local');
eq(handle1, 'paperpilot@dev.local-citecon-1', '④ register 返回注册句柄');
eq(calls.registered, 1, '④ registerSection 被调用一次');

const sec = calls.section;
eq(sec.paneID, 'paperpilot-citecon', '④ paneID 正确（与 related-papers 不冲突）');
eq(sec.header.l10nID, CC._l10nID, '④ header l10nID 用 _l10nID 常量');
eq(sec.sidenav.l10nID, 'paperpilot-citecon-section-sidenav', '④ sidenav l10nID 已给出');
eq(typeof sec.onRender, 'function', '④ onRender 必填');
eq(typeof sec.onItemChange, 'function', '④ onItemChange 存在');
eq(typeof sec.onDestroy, 'function', '④ onDestroy 存在');

const handleAgain = CC.register('paperpilot@dev.local');
eq(handleAgain, handle1, '④ 幂等：重复 register 返回同一句柄');
eq(calls.registered, 1, '④ 幂等：不重复注册');

CC.unregister();
eq(calls.unregistered, handle1, '④ 注销用 registerSection 的返回值（不是 paneID）');
eq(CC._registered, false, '④ 注销后状态复位');

const handle2 = CC.register('paperpilot@dev.local');
eq(handle2, 'paperpilot@dev.local-citecon-2', '④ 注销后可重新注册');
CC.unregister();

const savedIPM = Zotero.ItemPaneManager;
Zotero.ItemPaneManager = undefined;
let threw = false;
let noPane = null;
try { noPane = CC.register('paperpilot@dev.local'); } catch (e) { threw = true; }
eq(threw, false, '④ pane 不可用：register 不抛');
eq(noPane, false, '④ pane 不可用：register 返回 false');
Zotero.ItemPaneManager = savedIPM;

/* ================= ⑤ 面板渲染 ================= */

const handle3 = CC.register('paperpilot@dev.local');
ok(!!handle3, '⑤ 重新注册成功');
const doc = makeDoc();
const body = new El('div');
body.querySelector = () => null;
calls.section.onRender({ paneID: 'p1', doc, body });
const root = body.firstChild;
ok(!!root, '⑤ onRender 构建根节点');
eq(root.getAttribute('data-pp-citecon-root'), '1', '⑤ 根节点带防重复标记');
ok(!!root.byClass('pp-citecon-current')[0], '⑤ 有标题行');
ok(!!root.byClass('pp-citecon-status')[0], '⑤ 有状态行');
ok(!!root.byClass('pp-citecon-list')[0], '⑤ 有列表容器');
ok(!!root.byClass('pp-citecon-s2')[0], '⑤ 有「在 S2 打开」链接');

let enabled = null;
S2._citationsReset();
calls.citeRows = null;
calls.section.onItemChange({ paneID: 'p1', item: itemDoi, setEnabled: (v) => { enabled = v; } });
eq(enabled, true, '⑤ 常规条目：section 启用');
const rendered = await drain(() => root.byClass('pp-citecon-row').length > 0);
ok(rendered, '⑤ 渲染出条目');
eq(root.byClass('pp-citecon-row').length, 8, '⑤ 最多渲染 8 条');
eq(root.byClass('pp-citecon-current')[0].textContent, 'Seed Paper', '⑤ 标题行显示当前条目');
eq(root.byClass('pp-citecon-badge')[0].textContent, '批评', '⑤ 首条徽标为「批评」（文字，非 emoji）');
eq(root.byClass('pp-citecon-badge')[1].textContent, '批评', '⑤ 第二条也是批评');
eq(root.byClass('pp-citecon-badge')[3].textContent, '对比', '⑤ 第四条为对比');
has(root.byClass('pp-citecon-title')[0].textContent, 'Citing Paper 3', '⑤ 行内标题');
has(root.byClass('pp-citecon-title')[0].textContent, '（2003）', '⑤ 行内含年份');
eq(root.byClass('pp-citecon-quote').length, 8, '⑤ 每条都有引用句');
has(root.byClass('pp-citecon-quote')[0].textContent, 'fails on long inputs', '⑤ 引用句内容');
has(root.byClass('pp-citecon-status')[0].textContent, '共 10 条引用', '⑤ 状态行显示原始条数');

root.byClass('pp-citecon-s2')[0].click();
has(calls.launched[calls.launched.length - 1], 'semanticscholar.org/paper/DOI:10.1000/seed.1',
  '⑤ 「在 S2 打开」走 Zotero.launchURL + DOI paperId');

// 引用句截断 200 字
calls.citeRows = [citing(1, 'A'.repeat(50) + ' ' + 'B'.repeat(300))];
S2._citationsReset();
calls.section.onItemChange({ paneID: 'p1', item: makeItem({ title: 'Long', DOI: '10.1000/long.1' }), setEnabled: () => {} });
const cut = await drain(() => {
  const q = root.byClass('pp-citecon-quote');
  return q.length && q[0].textContent.length > 0;
});
ok(cut, '⑤ 长引用句已渲染');
eq(root.byClass('pp-citecon-quote')[0].textContent.length, 201, '⑤ 引用句截到 200 字 + 省略号');

// 无 DOI
const doc2 = makeDoc();
const body2 = new El('div');
body2.querySelector = () => null;
calls.section.onRender({ paneID: 'p2', doc: doc2, body: body2 });
calls.section.onItemChange({ paneID: 'p2', item: noDoi, setEnabled: () => {} });
const noDoiText = await drain(() => body2.firstChild.byClass('pp-citecon-status')[0].textContent.indexOf('缺少 DOI') >= 0);
ok(noDoiText, '⑤ 无 DOI：文案「该条目缺少 DOI，无法查询引文上下文」');
eq(body2.firstChild.byClass('pp-citecon-row').length, 0, '⑤ 无 DOI：不出条目行');

// 无施引
calls.citeRows = [];
S2._citationsReset();
calls.section.onItemChange({ paneID: 'p2', item: makeItem({ title: 'Empty', DOI: '10.1000/empty.1' }), setEnabled: () => {} });
const emptyText = await drain(() => body2.firstChild.byClass('pp-citecon-status')[0].textContent.indexOf('暂无引用记录') >= 0);
ok(emptyText, '⑤ 无引文：文案「暂无引用记录」');
calls.citeRows = null;

// 换条目丢弃旧请求
calls.citeRows = null;
S2._citationsReset();
const slowItem = makeItem({ title: 'Slow', DOI: '10.1000/slow.1' });
calls.section.onItemChange({ paneID: 'p2', item: slowItem, setEnabled: () => {} });
calls.section.onItemChange({ paneID: 'p2', item: null, setEnabled: () => {} });
eq(body2.firstChild.byClass('pp-citecon-row').length, 0, '⑤ 清空条目：列表清空');
has(body2.firstChild.byClass('pp-citecon-status')[0].textContent, '请选择', '⑤ 清空条目：提示选择文献');

calls.section.onDestroy({ paneID: 'p2' });
eq(CC._panes.has('p2'), false, '⑤ onDestroy 清掉 pane 状态');

CC.unregister();
eq(calls.unregistered, handle3, '⑤ 最后一轮注销仍用返回值');

}

/* ---------------- 汇总 ---------------- */

main().then(() => {
  if (fails.length) {
    console.error('\nFAILED ' + fails.length + ' / ' + (pass + fails.length));
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('PASS ' + pass + ' assertions');
}).catch((e) => {
  console.error('TEST CRASHED: ' + (e && (e.stack || e.message) || e));
  process.exit(1);
});
