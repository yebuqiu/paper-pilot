#!/usr/bin/env node
/* Sci-Hub / Sci-Net 补全文 测试（插件 0.27.0）
 *
 * 为什么要有它：补全文链路的外部世界（镜像模板、验证页、直链失效）变化极快，
 * 而解析与轮换逻辑是纯代码，可以在无人环境里真跑一遍。覆盖：
 *   ① 页面解析：embed#pdf / iframe / meta citation_pdf_url / object / 下载链 / JS location.href
 *      （含 sci-hub.ru 模板的 " = " 带空格写法、协议相对 & 相对路径、#fragment 剥离、实体还原、
 *       data-src 前缀不误配）；
 *   ② 验证页判定：sci-hub.ru 2026 ALTCHA 页（按真实页面结构裁剪的 fixture）+ Cloudflare 盾，
 *      且不误伤正常文章页；
 *   ③ 镜像轮换：不可达 / 验证页 / 5xx 换下一个；not-found 即停；全部失败时优先上报验证页；
 *   ④ 编排：Unpaywall 命中不再走 Sci-Hub；Sci-Hub 未收录兜底 Sci-Net；渠道关闭不发请求；
 *   ⑤ 附件落库：%PDF 魔数校验、临时文件清理、标题回填；
 *   ⑥ runForSelected：验证拦截时打开验证页 + 一次性提示 + 本次运行停试（后续条目不再碰镜像）。
 *
 * 运行：node test/scihub-fetch.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULES = [
  'chrome/content/scripts/features/scihub.js',
  'chrome/content/scripts/features/oa-fetch.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 160) });
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map([
  ['scihubEnabled', true],
  ['scinetEnabled', true],
  ['scinetUrl', 'https://sci-net.xyz'],
]);
const Prefs = {
  PREFIX: 'extensions.zotero.paperpilot.',
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};

const httpCalls = [];
let httpPlan = [];
function res(status, body, finalUrl) {
  const payload = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return { status, response: payload, responseURL: finalUrl };
}
function jsonRes(obj) { return { status: 200, response: obj, responseURL: 'https://api.unpaywall.org/v2/x' }; }
function netFail(msg) { return () => { throw new Error(msg || 'dns failure'); }; }

const tmpFiles = new Map();
const IOUtils = {
  async write(p, bytes) { tmpFiles.set(p, Buffer.from(bytes)); },
  async remove(p) { tmpFiles.delete(p); },
};
const PathUtils = { tempDir: '/tmp/pp', join: (...a) => a.join('/') };

const openedViewer = [];
const alerts = [];
const progressTexts = [];
const paneStub = { items: [], getSelectedItems() { return this.items.slice(); } };

class FakeItemProgress {
  constructor(icon, text) {
    this.text = text || '';
    if (text) progressTexts.push(String(text));
  }
  setProgress() {}
  setText(t) { this.text = t; progressTexts.push(String(t)); }
  setError() { this.errored = true; }
}
class FakeProgressWindow {
  constructor() {}
  changeHeadline() {}
  show() {}
  startCloseTimer() {}
}
FakeProgressWindow.prototype.ItemProgress = FakeItemProgress;

const Zotero = {
  debug() {}, locale: 'zh-CN',
  logError() {},
  HTTP: {
    async request(method, url, opts) {
      httpCalls.push({ method, url, opts });
      const h = httpPlan.shift();
      if (!h) throw new Error('unexpected HTTP call: ' + url);
      return typeof h === 'function' ? h(url, opts) : h;
    },
  },
  Items: {
    _map: new Map(),
    get(id) { return this._map.get(id) || null; },
  },
  Attachments: {
    importedURL: [],
    importedFile: [],
    async importFromURL(o) { this.importedURL.push(o); return { id: 9001 }; },
    async importFromFile(o) {
      const rec = { file: o.file, parentItemID: o.parentItemID, titles: [], saved: 0 };
      this.importedFile.push(rec);
      return { setField(k, v) { rec.titles.push(v); }, saveTx: async () => { rec.saved++; } };
    },
  },
  getActiveZoteroPane() { return paneStub; },
  getMainWindow() { return null; },
  openInViewer(url) { openedViewer.push(url); return {}; },
  launchURL(url) { openedViewer.push('launch:' + url); },
  alert(win, title, msg) { alerts.push({ title, msg: String(msg) }); },
  ProgressWindow: FakeProgressWindow,
};

const I18n = { isZh: true, t: (k) => 't:' + k };
const ItemSel = { regularOnly: (a) => a.slice(), alertEmpty() {} };
const CitationColumn = {
  normalizeDOI: (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''),
};

const sandbox = {
  console, Zotero, Prefs, I18n, ItemSel, CitationColumn, PathUtils, IOUtils,
  TextDecoder, TextEncoder, URL, Promise, Date, Math, JSON, setTimeout, clearTimeout,
  Uint8Array,
};
sandbox.Zotero.Prefs = Prefs;
vm.createContext(sandbox);
for (const f of MODULES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const SciHub = sandbox.SciHub;
const OAFetch = sandbox.OAFetch;
ok(!!SciHub && !!OAFetch, '模块加载：SciHub / OAFetch 均为全局对象');

SciHub.MIN_INTERVAL_MS = 0; // 测试关掉限速，避免每个请求睡 1.2s

/* ---------------- 夹具 ---------------- */

function pdfBytes(tag) {
  const head = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]; // %PDF-1.7\n
  const body = Array.from('paperpilot fake pdf body ' + (tag || '')).map((c) => c.charCodeAt(0));
  return new Uint8Array(head.concat(body));
}

const H = {
  // ①-⑥ 各模板：以下片段逐字取自 Web Archive 真实快照（se-2022 / st-2024 / ru-2026），
  // 保留 " = " 带空格写法、src 在 id 之后、#navpanes 片段等真实细节
  embed: '<html><body><div id="article"><embed type="application/pdf" src="//zero.sci-hub.se/6716/8f5cb6224b5f27d6d09f54bfc99e05ed/watson1953.pdf#navpanes=0&view=FitH" id = "pdf"></div></body></html>',
  iframe: '<html><body><iframe id="pdf" src="/downloads/2020-01-01/xyz.pdf" frameborder="0"></iframe></body></html>',
  meta: '<html><head><meta name="citation_pdf_url" content="https://sci-hub.ru/storage/2024/1006/121f21353cc62328f952e208f882e0c8/zoology-1870.pdf"></head><body></body></html>',
  metaAlt: '<html><head><meta content="//sci-hub.ru/downloads/2024/aaa.pdf" name="citation_pdf_url"></head><body></body></html>',
  object: '<html><body><div class = "pdf"><object type = "application/pdf" data = "/storage/2024/1006/121f21353cc62328f952e208f882e0c8/zoology-1870.pdf#navpanes=0&view=FitH"></object></div></body></html>',
  link: '<html><body><div class = "download"><a href = "/download/2024/1006/121f21353cc62328f952e208f882e0c8/zoology-1870.pdf"></a></div></body></html>',
  js: "<html><body><a onclick=\"location.href='//zero.sci-hub.st/6716/8f5cb6224b5f27d6d09f54bfc99e05ed/watson1953.pdf?download=true'\">&darr; save</a></body></html>",
  jsEscaped: "<html><body><button onclick=\"location.href='https:\\/\\/dacemirror.sci-hub.se\\/files\\/ddd.pdf'\">Save</button></body></html>",
  dataSrc: '<html><body><iframe data-src="/fake-missing.pdf" src="/real.pdf"></iframe></body></html>',
  scinet: '<html><body><iframe src="/storage/2024/9f8a.pdf"></iframe></body></html>',
  // 验证页：按 sci-hub.ru 2026 实际返回裁剪（保留 " = " 写法与 altcha-widget）
  captcha: '<!DOCTYPE html><html><head><title translate = "ru:title">Sci-Hub: проверка на робота</title></head>'
    + '<body><div class = "question"><div class = "ask" translate = "ru:isrobot">Вы робот?</div>'
    + '<div class = "answer" onclick = "check()" translate = "ru:nope">Нет</div>'
    + '<div class = "result"><span class = "rotate">|</span></div>'
    + '<altcha-widget style="--altcha-border-width:0" challengeurl = "/captcha/challenge/93690650" hidefooter></altcha-widget>'
    + '</div></body></html>',
  cf: '<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification"></div></body></html>',
  notFound: '<html><body><fixed-width><block-rounded class="info"><h1>Ой!</h1><div>статья отсутствует в базе</div></blockquote></block-rounded></fixed-width></body></html>',
  empty: '<html><body></body></html>',
  unmarked: '<html><body><div class="info">Some unexpected page without any pdf link</div></body></html>',
};

const BASE = 'https://sci-hub.se/10.1038/171737a0';
const DOI = '10.1038/171737a0';

function resetHttp() { httpCalls.length = 0; httpPlan = []; }
function resetAll() {
  resetHttp();
  openedViewer.length = 0;
  alerts.length = 0;
  progressTexts.length = 0;
  tmpFiles.clear();
  Zotero.Attachments.importedURL.length = 0;
  Zotero.Attachments.importedFile.length = 0;
  Zotero.Items._map.clear();
  PrefStore.set('scihubMirrors', 'sci-hub.ru, sci-hub.st');
  PrefStore.set('scinetUrl', 'https://sci-net.xyz');
  PrefStore.set('scihubEnabled', true);
  PrefStore.set('scinetEnabled', true);
  paneStub.items = [];
}

function makeItem(opts) {
  opts = opts || {};
  return {
    id: opts.id || 101,
    getField: (f) => (f === 'DOI' ? (opts.doi !== undefined ? opts.doi : DOI) : ''),
    getAttachments: () => (opts.attachments || []).slice(),
    getDisplayTitle: () => opts.title || 'Test Paper',
  };
}

/* ---------------- ①/② 纯函数解析 ---------------- */

function testParsers() {
  eq(SciHub._extractPdfUrl(H.embed, BASE), 'https://zero.sci-hub.se/6716/8f5cb6224b5f27d6d09f54bfc99e05ed/watson1953.pdf', '① embed#pdf（src 在 id 前、带空格写法）→ 协议相对还原 + #fragment 剥离');
  eq(SciHub._extractPdfUrl(H.iframe, BASE), 'https://sci-hub.se/downloads/2020-01-01/xyz.pdf', '① iframe#pdf → 相对路径还原');
  eq(SciHub._extractPdfUrl(H.meta, BASE), 'https://sci-hub.ru/storage/2024/1006/121f21353cc62328f952e208f882e0c8/zoology-1870.pdf', '① meta citation_pdf_url（name 在前，ru-2026 原样）');
  eq(SciHub._extractPdfUrl(H.metaAlt, BASE), 'https://sci-hub.ru/downloads/2024/aaa.pdf', '① meta citation_pdf_url（content 在前，属性顺序无关）');
  eq(SciHub._extractPdfUrl(H.object, BASE), 'https://sci-hub.se/storage/2024/1006/121f21353cc62328f952e208f882e0c8/zoology-1870.pdf', '① object[type=application/pdf] data 属性 + fragment 剥离（相对路径按 base 解析）');
  eq(SciHub._extractPdfUrl(H.link, BASE), 'https://sci-hub.se/download/2024/1006/121f21353cc62328f952e208f882e0c8/zoology-1870.pdf', '① 下载链（href = 带空格、单数 download）');
  eq(SciHub._extractPdfUrl(H.js, BASE), 'https://zero.sci-hub.st/6716/8f5cb6224b5f27d6d09f54bfc99e05ed/watson1953.pdf?download=true', '① location.href 保存链（保留 query，st-2024 原样）');
  eq(SciHub._extractPdfUrl(H.jsEscaped, BASE), 'https://dacemirror.sci-hub.se/files/ddd.pdf', '① location.href 的 \\/ 转义还原');
  eq(SciHub._extractPdfUrl(H.dataSrc, BASE), 'https://sci-hub.se/real.pdf', '① data-src 前缀不误配、取真 src');
  eq(SciHub._extractPdfUrl('<html><body><a href="/d.pdf?a=1&amp;b=2">x</a></body></html>', BASE), 'https://sci-hub.se/d.pdf?a=1&b=2', '① URL 中的 HTML 实体还原');
  eq(SciHub._extractPdfUrl(H.captcha, BASE), '', '① 验证页解析不出 PDF');
  eq(SciHub._extractPdfUrl(H.empty, BASE), '', '① 空页解析不出 PDF');

  ok(SciHub._isCaptcha(H.captcha), '② ALTCHA 验证页识别（.question/.answer 组合）');
  ok(SciHub._isCaptcha(H.cf), '② Cloudflare 盾识别');
  ok(!SciHub._isCaptcha(H.embed), '② 正常文章页不误判为验证页');
  ok(!SciHub._isCaptcha(H.notFound), '② 未收录页不误判为验证页');
  ok(SciHub._isNotAvailable(H.notFound), '② 俄文「不在库中」页识别');
  ok(SciHub._isNotAvailable(H.empty), '② 空页视为未收录');
  ok(!SciHub._isNotAvailable(H.embed), '② 正常文章页不算未收录');

  ok(SciHub._isPdf(pdfBytes('magic')), '⑤ %PDF 魔数通过');
  ok(!SciHub._isPdf(new TextEncoder().encode('<!DOCTYPE html>')), '⑤ HTML 不通过魔数');

  // 镜像列表解析
  PrefStore.set('scihubMirrors', '');
  eq(SciHub.mirrors().length, SciHub.DEFAULT_MIRRORS.length, '默认镜像数量（pref 为空时）');
  eq(SciHub.mirrors()[0], 'https://sci-hub.ru', '默认镜像首个为 sci-hub.ru');
  PrefStore.set('scihubMirrors', 'sci-hub.box, https://sci-hub.ru/');
  eq(SciHub.mirrors().join('|'), 'https://sci-hub.box|https://sci-hub.ru', '镜像列表：补协议 + 去尾斜杠');
  PrefStore.set('scinetUrl', '');
  eq(SciHub.scinetBase(), 'https://sci-net.xyz', 'Sci-Net 默认地址');
  PrefStore.set('scinetUrl', 'sci-net.example.org/');
  eq(SciHub.scinetBase(), 'https://sci-net.example.org', 'Sci-Net 自定义地址归一');
  PrefStore.set('scinetUrl', 'https://sci-net.xyz');
  PrefStore.set('scihubMirrors', 'sci-hub.ru, sci-hub.st');
}

/* ---------------- ③ 镜像轮换 ---------------- */

async function testMirrorRotation() {
  // T1：第一个镜像网络失败 → 第二个成功（页面 + PDF 两跳）
  resetHttp();
  httpPlan = [
    netFail('dns'),
    res(200, H.embed, 'https://sci-hub.st/' + DOI),
    res(200, pdfBytes('t1')),
  ];
  let r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'ok', '③ 网络失败自动换镜像后成功');
  eq(r.host, 'sci-hub.st', '③ 成功来自第二个镜像');
  eq(httpCalls.length, 3, '③ 共 3 次请求（失败页 + 文章页 + PDF 下载）');
  ok(SciHub._isPdf(r.bytes), '③ 返回字节通过 %PDF 校验');
  includes(httpCalls[2].url, 'zero.sci-hub.se', '③ PDF 下载指向解析出的直链');

  // T2：验证页 + 后续不可达 → 优先上报验证页（可修复）
  resetHttp();
  httpPlan = [
    res(200, H.captcha, 'https://sci-hub.ru/' + DOI),
    netFail('blocked'),
  ];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'captcha', '③ 全失败时优先上报验证页');
  eq(r.host, 'sci-hub.ru', '③ 验证页来自第一个镜像');
  eq(r.pageUrl, 'https://sci-hub.ru/' + DOI, '③ 带出验证页地址');

  // T3：全部不可达
  resetHttp();
  httpPlan = [netFail('dns'), netFail('tls')];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'unreachable', '③ 全部镜像不可达');

  // T4：404 = 未收录，即停不换镜像
  resetHttp();
  httpPlan = [res(404, 'not found')];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'not-found', '③ 404 视为未收录');
  eq(httpCalls.length, 1, '③ 未收录不再换镜像（共享同一数据库）');

  // T5：文章页直出 PDF（单请求）
  resetHttp();
  httpPlan = [res(200, pdfBytes('direct'))];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'ok', '③ 页面直出 PDF');
  eq(httpCalls.length, 1, '③ 直出 PDF 单次请求');

  // T6：PDF 直链被验证拦截
  resetHttp();
  httpPlan = [
    res(200, H.embed, 'https://sci-hub.ru/' + DOI),
    res(200, H.captcha),
  ];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'captcha', '③ 下载 PDF 时被验证拦截 → captcha');

  // T7：5xx（换镜像）→ 空页未收录
  resetHttp();
  httpPlan = [res(503, 'busy'), res(200, H.empty)];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'not-found', '③ 5xx 换镜像，空页未收录');

  // T9：页面有内容但解析不出 PDF（无「未收录」标记）→ 视为模板漂移，换镜像再试
  resetHttp();
  httpPlan = [
    res(200, H.unmarked, 'https://sci-hub.ru/' + DOI),
    res(200, H.embed, 'https://sci-hub.st/' + DOI),
    res(200, pdfBytes('t9')),
  ];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'ok', '③ 未识别页（模板漂移）换镜像后成功');
  eq(r.host, 'sci-hub.st', '③ 未识别页不当作未收录');

  // T10：明确「未收录」标记 → 即停（不换镜像）
  resetHttp();
  httpPlan = [res(200, H.notFound, 'https://sci-hub.ru/' + DOI)];
  r = await SciHub.fetchPdf(DOI);
  eq(r.status, 'not-found', '③ 俄文未收录标记 → 未收录');
  eq(httpCalls.length, 1, '③ 明确未收录不再换镜像');

  // T8：Sci-Net（iframe .pdf）
  resetHttp();
  httpPlan = [
    res(200, H.scinet),
    res(200, pdfBytes('scinet')),
  ];
  r = await SciHub.fetchFromSciNet('10.1038/s41586-021-03819-2');
  eq(r.status, 'ok', '③ Sci-Net iframe 解析并下载');
  includes(httpCalls[0].url, 'sci-net.xyz/10.1038/s41586-021-03819-2', '③ Sci-Net URL 拼接');
}

/* ---------------- ④/⑤ 编排链 ---------------- */

async function testFillChain() {
  // F1：已有 PDF → 直接跳过
  resetAll();
  PrefStore.set('scihubMirrors', 'sci-hub.ru');
  Zotero.Items._map.set(7, { isPDFAttachment: () => true });
  let r = await OAFetch.fill(makeItem({ attachments: [7] }), { email: 'a@b.c', scihub: true, scinet: true });
  eq(r.status, 'has-pdf', '④ 已有 PDF 跳过');
  eq(httpCalls.length, 0, '④ 已有 PDF 不发任何请求');

  // F2：无 DOI
  r = await OAFetch.fill(makeItem({ doi: '' }), { email: 'a@b.c', scihub: true, scinet: true });
  eq(r.status, 'no-doi', '④ 无 DOI 跳过');

  // F3：Unpaywall 命中 → 不再走 Sci-Hub
  resetHttp();
  httpPlan = [jsonRes({ best_oa_location: { url_for_pdf: 'https://oa.example/x.pdf' } })];
  r = await OAFetch.fill(makeItem({}), { email: 'a@b.c', scihub: true, scinet: true });
  eq(r.status, 'added', '④ Unpaywall 命中直接补全文');
  eq(httpCalls.length, 1, '④ Unpaywall 命中不再走 Sci-Hub');
  eq(Zotero.Attachments.importedURL.length, 1, '④ 走 importFromURL 挂 OA 附件');

  // F4：Unpaywall 未命中 → Sci-Hub 成功（临时文件通路 + 清理）
  resetHttp();
  httpPlan = [
    jsonRes({}),
    res(200, H.embed, 'https://sci-hub.ru/' + DOI),
    res(200, pdfBytes('f4')),
  ];
  r = await OAFetch.fill(makeItem({}), { email: 'a@b.c', scihub: true, scinet: true });
  eq(r.status, 'added-scihub', '④ Sci-Hub 补全文成功');
  eq(Zotero.Attachments.importedFile.length, 1, '④ 走 importFromFile 挂附件');
  includes(Zotero.Attachments.importedFile[0].file, 'paperpilot-fulltext-', '④ 通过临时文件导入');
  eq(tmpFiles.size, 0, '⑤ 临时文件导入后已清理');
  includes(Zotero.Attachments.importedFile[0].titles[0], 'Sci-Hub', '⑤ 附件标题标注来源');
  eq(Zotero.Attachments.importedFile[0].saved, 1, '⑤ saveTx 已调用');

  // F5：Sci-Hub 未收录 → Sci-Net 兜底
  resetHttp();
  httpPlan = [
    jsonRes({}),
    res(200, H.empty, 'https://sci-hub.ru/' + DOI),
    res(200, H.scinet, 'https://sci-net.xyz/' + DOI),
    res(200, pdfBytes('f5')),
  ];
  r = await OAFetch.fill(makeItem({}), { email: 'a@b.c', scihub: true, scinet: true });
  eq(r.status, 'added-scinet', '④ Sci-Hub 未收录 → Sci-Net 兜底成功');
  const lastImp = Zotero.Attachments.importedFile[Zotero.Attachments.importedFile.length - 1];
  includes(lastImp.titles[0], 'Sci-Net', '⑤ Sci-Net 附件标题');

  // F6：渠道关闭 → 只查 Unpaywall
  resetHttp();
  PrefStore.set('scihubMirrors', 'sci-hub.ru');
  httpPlan = [jsonRes({})];
  r = await OAFetch.fill(makeItem({}), { email: 'a@b.c', scihub: false, scinet: false });
  eq(r.status, 'not-found', '④ 渠道关闭 → 未找到');
  eq(httpCalls.length, 1, '④ 渠道关闭不发补充渠道请求');

  // F7：验证拦截 → captcha 带地址，不再试 Sci-Net
  resetHttp();
  httpPlan = [
    jsonRes({}),
    res(200, H.captcha, 'https://sci-hub.ru/' + DOI),
  ];
  r = await OAFetch.fill(makeItem({}), { email: 'a@b.c', scihub: true, scinet: true });
  eq(r.status, 'captcha', '④ 验证拦截向上传递 captcha');
  eq(r.pageUrl, 'https://sci-hub.ru/' + DOI, '④ captcha 带出验证页地址');
  eq(httpCalls.length, 2, '④ 验证拦截后不再试 Sci-Net');

  // F8：双渠道不可达 → 报「不可达」（host 取 Sci-Hub）
  resetHttp();
  httpPlan = [netFail('dns'), netFail('dns')];
  r = await OAFetch.fill(makeItem({}), { email: 'a@b.c', scihub: true, scinet: true });
  eq(r.status, 'unreachable', '④ 双渠道不可达如实上报');
  eq(r.host, 'sci-hub.ru', '④ 不可达 host 取 Sci-Hub');
}

/* ---------------- ⑥ runForSelected 交互 ---------------- */

async function testRunForSelected() {
  // 两个条目：第一条验证拦截（打开验证页 + 提示一次 + 本次停试），第二条只查 Unpaywall
  resetAll();
  PrefStore.set('scihubMirrors', 'sci-hub.ru');
  paneStub.items = [makeItem({ id: 1, doi: '10.1/a' }), makeItem({ id: 2, doi: '10.1/b' })];
  httpPlan = [
    jsonRes({}),                        // 条目1 Unpaywall 未命中
    res(200, H.captcha, 'https://sci-hub.ru/10.1/a'),
    jsonRes({}),                        // 条目2 Unpaywall 未命中（Sci-Hub 已停试）
  ];
  await OAFetch.runForSelected();
  eq(httpCalls.length, 3, '⑥ 验证后本次运行不再请求镜像');
  eq(openedViewer.length, 1, '⑥ 验证页只打开一次');
  eq(openedViewer[0], 'https://sci-hub.ru/10.1/a', '⑥ 打开的是验证页地址');
  eq(alerts.length, 1, '⑥ 验证提示只弹一次');
  ok(progressTexts.some((t) => t.indexOf('人机验证') >= 0), '⑥ 进度条给出验证提示');
  ok(progressTexts.some((t) => t.indexOf('暂停') >= 0), '⑥ 汇总提示 Sci-Hub 已暂停');
  ok(progressTexts.some((t) => t.indexOf('未找到') >= 0), '⑥ 第二条计为未找到');
}

/* ---------------- 主流程 ---------------- */

(async function main() {
  testParsers();
  await testMirrorRotation();
  await testFillChain();
  await testRunForSelected();

  if (fails.length) {
    console.log('Sci-Hub 补全文测试：' + pass + ' 通过，' + fails.length + ' 失败');
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('Sci-Hub 补全文测试：' + pass + ' 项断言全部通过');
})();
