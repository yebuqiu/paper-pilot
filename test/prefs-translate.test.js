#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置面板 · 翻译引擎 界面测试（插件 0.31.0）
 *
 * 为什么要有它：设置面板的翻译卡片此前**一个测试都没有**——所以「测试按钮点了没反应」
 * 这种问题只能靠用户发现。这个套件用「迷你 DOM」把 prefs-translate.js 真跑一遍
 * （真加载 core/utils.js + 翻译模块六文件（test/translate-files.js 清单），只桩掉 Zotero/网络），断言界面行为本身：
 *   ① 渲染：状态行 / 引擎下拉（选项数 = 引擎数、选中 = 活动引擎）/ 语言下拉 / 预算三项；
 *   ② ★ 折叠式布局：默认只列「常用引擎」（≤6），标题显示常用个数，按钮文案含引擎总数，
 *      并有「已收起 N 个」提示；点「展开全部」→ 列出全部引擎且出现分类标题；
 *      再点「收起」→ 回到常用；**展开状态在 renderAll 重建后必须保持**；
 *   ③ ★ 测试按钮：点击真的调用引擎；结果**写在按钮旁边那一行**（不只写卡片底部），
 *      按钮文案在结束后复原；成功给出耗时与译文片段；
 *   ④ ★ 测试失败：行内给出可读原因（HTTP 500 / 缺密钥 / 取 token 失败），绝不静默；
 *   ⑤ 设为当前 / 纳入回退 写回同一份 pref；
 *   ⑥ 检测本机自建服务：渲染建议并一键填入该引擎地址。
 *
 * 运行：node test/prefs-translate.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.value = ''; this.checked = false;
    this.disabled = false; this.id = ''; this.parentNode = null; this.handlers = {};
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
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  fire(e, a) { for (const f of (this.handlers[e] || []).slice()) f(a || {}); }
  click() { this.fire('click'); }
  focus() {}
  querySelector() { return null; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  byTag(t) { return this.all().filter((n) => n.tag === t); }
  byClass(c) { return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(c) >= 0); }
}

/** 用 prefs.xhtml 里真实存在的 id 建桩（顺带验证脚本引用的 id 不是幻觉） */
function makeDom() {
  const xhtml = fs.readFileSync(XHTML, 'utf8');
  const ids = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(xhtml))) ids.add(m[1]);
  const registry = new Map();
  const documentElement = new El('window');
  for (const id of ids) {
    const el = new El('div');
    el.setAttribute('id', id);
    el.parentNode = documentElement;
    documentElement.children.push(el);
    registry.set(id, el);
  }
  return {
    ids,
    registry,
    document: {
      getElementById: (id) => registry.get(id) || null,
      createElementNS: (ns, tag) => new El(tag),
      createElement: (tag) => new El(tag),
    },
  };
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const PREFIX = 'extensions.zotero.papilot.';
const P = (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d);
const setP = (k, v) => PrefStore.set(PREFIX + k, v);

let plan = [];
const httpCalls = [];
function planOk(match, res) { plan.push({ match, res }); }
function planFailStatus(match, status) { plan.push({ match, failStatus: status }); }

const dom = makeDom();
const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined), // 缺省必须返回 undefined
    set: (k, v) => PrefStore.set(k, v),
  },
  Utilities: { Internal: { md5: (s) => 'x'.repeat(32) } },
  HTTP: {
    async request(method, url) {
      httpCalls.push({ method, url });
      const hit = plan.find((p) => url.indexOf(p.match) >= 0);
      if (!hit) throw new Error('no plan for ' + url.slice(0, 60));
      if (hit.failStatus) {
        const e = new Error('HTTP ' + hit.failStatus);
        e.xmlhttp = { status: hit.failStatus, response: null, responseText: 'err' };
        throw e;
      }
      return { status: 200, response: hit.res, responseText: hit.text };
    },
  },
  launchURL() {},
  logError() {},
  Papilot: { openHub() {} },
};

const AIClient = { hasKey: () => true, guidance: () => '未登录/未配置', async chat() { return 'AI 译文'; } };

const sandbox = {
  console, Zotero, AIClient, IOUtils: {}, PathUtils: {},
  Promise, Date, Math, JSON, URLSearchParams, setTimeout, clearTimeout,
  document: dom.document,
  // 面板脚本用 window.setTimeout 做"DOM 未就绪重试"；这里只需要首次 init 生效
  window: { setTimeout() {}, clearTimeout() {} },
  navigator: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['chrome/content/scripts/core/utils.js',
                 ...require('./translate-files'),
                 'chrome/content/scripts/ai/glossary-packs.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const T = sandbox.TranslateSvc;
Zotero.Papilot.translateSvc = T; // ★ 必须在面板脚本之前挂上，否则首次 init 直接放弃
Zotero.Papilot.glossaryPacks = sandbox.GlossaryPacks; // 0.4x 在线词包模块（面板经 PP() 调用）
vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/content/prefs-translate.js'), 'utf8'),
  sandbox, { filename: 'prefs-translate.js' });

/* ---------------- 便捷取用 ---------------- */

const list = () => dom.registry.get('pp-tr-list');
const globalMsg = () => dom.registry.get('pp-tr-test-result');
const rows = () => list().children.filter((c) => String(c.className).indexOf('pp-ch-row') >= 0);
const rowOf = (id) => rows().find((r) => r.getAttribute('data-engine') === id) || null;
const btnOf = (node, text) => node.byTag('button').find((b) => b.textContent === text) || null;
const findToggle = () => list().byTag('button').find((b) => /展开全部|收起/.test(b.textContent));
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

async function main() {
  /* ---------- ① 基础渲染（默认配置下的首次渲染） ---------- */
  const ov0 = T.overview();
  const engSel = dom.registry.get('pp-tr-active');
  eq(engSel.children.length, ov0.services.length, '① 引擎下拉选项数 = 引擎数');
  eq(engSel.value, T.cfg().active, '① 下拉选中 = 活动引擎');
  // 语言两项不靠 JS：走 prefs.xhtml 的 preference= 声明式绑定（真实窗口里由宿主同步）。
  // 桩里没有绑定机制，所以这里断言"绑定声明存在"，而不是断言桩元素的值。
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    const tagOf = (id) => (new RegExp('<html:select[^>]*id="' + id + '"[^>]*>').exec(xhtml) || [''])[0];
    includes(tagOf('pp-tr-to'), 'preference="extensions.zotero.papilot.readerPopupTargetLang"',
      '① 目标语言走声明式 pref 绑定');
    includes(tagOf('pp-tr-from'), 'preference="extensions.zotero.papilot.translateFromLang"',
      '① 源语言走声明式 pref 绑定');
    ok(tagOf('pp-tr-to').indexOf('value="zh-CN"') >= 0 || /value="zh-CN"/.test(xhtml),
      '① 目标语言选项含规范码 zh-CN');
  }
  eq(dom.registry.get('pp-tr-route').value, String(T.cfg().routeMs), '① 单路预算已填入');

  /* ---------- ② 折叠式布局 ---------- */
  const total = ov0.services.length;
  ok(total >= 16, '① 引擎总数 ≥ 16', total);
  const common0 = rows().length;
  ok(common0 > 0 && common0 <= 6, '② 默认只列常用引擎（≤6）', common0);
  ok(common0 < total, '② 默认渲染的行数少于引擎总数', { rows: common0, total });
  ok(!!rowOf(T.cfg().active), '② 活动引擎在常用区可见');
  ok(!!findToggle(), '② 有展开/收起按钮');
  includes(findToggle().textContent, '展开全部', '② 收起态按钮文案是「展开全部」');
  includes(findToggle().textContent, String(total), '② 按钮文案里带引擎总数');
  includes(list().children[0].textContent, '常用引擎', '② 标题写明这是"常用引擎"');
  const moreHint = list().byClass('pp-tr-more')[0];
  ok(!!moreHint, '② 有「已收起 N 个」提示');
  includes(moreHint.textContent, String(total - common0), '② 提示里的数量正确');

  /* ---------- ②b 改配置后仍按真实 UI 路径重渲染 ---------- */
  // 用「设为当前」触发一次真实的 renderAll（不靠测试自己伪造重渲染）
  setP('translateCfg', JSON.stringify({
    active: 'llm', fallback: ['edge', 'bing'], cache: false, retry: 0, cooldownMs: 0,
  }));
  btnOf(rowOf('llm'), '设为当前');
  // 0.75.0：COMMON_ENGINES 换掉了 google（国内不可达）→ 用默认链里的 youdao 走同一路径
  const llmSetBtn = btnOf(rowOf('youdao'), '设为当前');
  ok(!!llmSetBtn, '② 常用区里能看到 youdao 的「设为当前」');
  llmSetBtn.click(); // → setActive('youdao') → renderAll()
  eq(T.cfg().active, 'youdao', '② 「设为当前」写回 translateCfg.active');
  eq(dom.registry.get('pp-tr-active').value, 'youdao', '② 重渲染后下拉跟上新活动引擎');
  eq(dom.registry.get('pp-tr-cooldown').value, '0', '② 重渲染后冷却框显示 0 秒（与配置一致）');

  // 展开
  findToggle().click();
  eq(rows().length, total, '② 展开后列出全部引擎');
  const groupTitles = list().children.filter((c) => String(c.className).indexOf('pp-sub-title') >= 0);
  ok(groupTitles.length >= 3, '② 展开后按类别分组', groupTitles.map((g) => g.textContent));
  includes(findToggle().textContent, '收起', '② 展开态按钮文案是「收起」');
  ok(!!rowOf('deepl') && !!rowOf('tencent'), '② 收起时看不到的引擎（deepl/tencent）现在可见');

  // 展开状态必须能扛住 renderAll 重建（否则用户一操作就又折回去）
  const tencentRow = rowOf('tencent');
  const fbBtn = btnOf(tencentRow, '纳入回退');
  ok(!!fbBtn, '② 展开区里的行也有「纳入回退」');
  fbBtn.click();
  eq(rows().length, total, '② ★ 一次操作触发的 renderAll 之后仍保持展开');
  ok(T.cfg().fallback.indexOf('tencent') >= 0, '② 「纳入回退」写回 translateCfg.fallback');
  // 撤销，避免影响后续断言
  btnOf(rowOf('tencent'), '移出回退').click();
  ok(T.cfg().fallback.indexOf('tencent') < 0, '② 再次点击可移出回退');

  // 收起
  findToggle().click();
  ok(rows().length <= 6, '② 点「收起」回到常用视图', rows().length);
  includes(findToggle().textContent, '展开全部', '② 收起后按钮文案复原');

  /* ---------- ③ 测试按钮：真的会调用 + 行内反馈 ---------- */
  setP('translateCfg', JSON.stringify({ active: 'google', fallback: ['edge'], cache: false, retry: 0, cooldownMs: 0 }));
  plan = []; httpCalls.length = 0;
  planOk('translate.google.com', [[['你好世界', 'Hello world']]]);
  findToggle().click(); // 展开，方便取任意引擎行
  const gRow = rowOf('google');
  ok(!!gRow, '③ 展开后找到 google 行');
  const gTest = btnOf(gRow, '测试');
  ok(!!gTest, '③ 该行有「测试」按钮');
  const gMsg = gRow.byClass('pp-tr-rowmsg')[0];
  ok(!!gMsg, '③ 该行内有行内结果位（反馈就在按钮下方）');
  eq(gMsg.textContent, '', '③ 测试前行内结果为空');
  gTest.click();
  eq(gTest.textContent, '…', '③ 点击后按钮进入测试中状态');
  eq(gTest.disabled, true, '③ 测试中禁用按钮（防连点）');
  await tick(6);
  ok(!!httpCalls.length, '③ ★ 点击「测试」真的发出了请求', httpCalls.map((c) => c.url.slice(0, 40)));
  includes(gMsg.textContent, '✓', '③ ★ 成功结果写在**该行内**（不在屏幕外）');
  includes(gMsg.textContent, '你好世界', '③ 行内给出译文片段');
  includes(gMsg.textContent, 'ms', '③ 行内给出耗时');
  includes(globalMsg().textContent, '翻译', '③ 底部汇总也写了（便于多引擎对比）', globalMsg().textContent);
  eq(gTest.textContent, '测试', '③ 结束后按钮文案复原');
  eq(gTest.disabled, false, '③ 结束后按钮恢复可用');

  /* ---------- ④ 测试失败：行内给可读原因 ---------- */
  plan = []; httpCalls.length = 0;
  planFailStatus('translate.google.com', 500);
  btnOf(rowOf('google'), '测试').click();
  await tick(6);
  const gMsg2 = rowOf('google').byClass('pp-tr-rowmsg')[0];
  includes(gMsg2.textContent, '失败', '④ 失败时行内显示失败');
  includes(gMsg2.textContent, '500', '④ 透出 HTTP 状态，便于定位', gMsg2.textContent);

  /* ---------- ⑤ 未就绪引擎：明确提示缺什么 ---------- */
  plan = []; httpCalls.length = 0;
  const dRow = rowOf('deepl');
  if (dRow) {
    btnOf(dRow, '测试').click();
    await tick(4);
    const dMsg = rowOf('deepl').byClass('pp-tr-rowmsg')[0];
    includes(dMsg.textContent, '失败', '⑤ 未配置密钥的引擎测试失败有提示');
    includes(dMsg.textContent, '密钥', '⑤ 直接点出"缺密钥"，而不是笼统报错', dMsg.textContent);
    eq(httpCalls.length, 0, '⑤ 缺密钥时不发请求（不做无意义调用）');
  }

  /* ---------- ⑥ 检测本机自建服务 → 一键填入 ---------- */
  plan = []; httpCalls.length = 0;
  planOk('127.0.0.1:5000', [{ code: 'en' }]);
  planOk('127.0.0.1:1188', { code: 200, data: 'pong' });
  dom.registry.get('pp-tr-local-scan').click();
  await tick(8);
  const localBox = dom.registry.get('pp-tr-local');
  includes(localBox.textContent, '发现', '⑥ 探测到本机服务');
  ok(localBox.byTag('button').length >= 1, '⑥ 渲染出「填入」按钮',
    localBox.byTag('button').map((b) => b.textContent));
  // 找到 libretranslate 的填入按钮（探测顺序：5000 在前）
  const fillLR = localBox.byTag('button').find((b) => /LibreTranslate/.test(b.textContent));
  ok(!!fillLR, '⑥ 有 LibreTranslate 的填入按钮');
  fillLR.click();
  eq(T.parseSecret('libretranslate', T.secretOf('libretranslate')).url, 'http://127.0.0.1:5000',
    '⑥ ★ 一键填入把地址写进了该引擎');
  T.setSecret('libretranslate', '');

  /* ---------- ⑥b 可选字段（needsSecret=false 但要填东西）也必须渲染 ---------- */
  // 0.75.0：此前表单渲染条件写死 needsSecret，导致 MyMemory 的「联系邮箱」与
  //         Google 的「自定义镜像地址」在界面上根本看不到（配了也白配）。
  {
    const gRow2 = rowOf('google');
    ok(!!gRow2, '⑥b 展开后有 google 行');
    eq(gRow2.byTag('input').length, 1, '⑥b ★ Google 的「镜像地址」可选字段已渲染');
    const mmRow = rowOf('mymemory');
    ok(!!mmRow, '⑥b 展开后有 MyMemory 行');
    eq(mmRow.byTag('input').length, 1, '⑥b ★ MyMemory 的「联系邮箱」可选字段已渲染');
    const mmInput = mmRow.byTag('input')[0];
    mmInput.value = 'me@example.com';
    mmInput.fire('change');
    eq(T.parseSecret('mymemory', T.secretOf('mymemory')).email, 'me@example.com',
      '⑥b 可选字段改动即写进该引擎的复合密钥串');
    T.setSecret('mymemory', '');
  }

  /* ---------- ⑥c 一键体检：真实逐个调用，结果逐条列出 ---------- */
  {
    const BING_PAGE = '<html><script>IG:"1A2B3C4D5E",data-iid="translator.5023",' +
      'var params_AbusePreventionHelper = [1699999999999,"TOK",3600000];</script></html>';
    setP('translateCfg', JSON.stringify({ active: 'youdao', fallback: [], cache: false, retry: 0, cooldownMs: 0, secrets: {} }));
    // 重新渲染以反映新配置（走真实按钮路径）
    btnOf(rowOf('youdao'), '设为当前').click();
    plan = []; httpCalls.length = 0;
    planOk('translate.google.com', [[['你好', 'hi']]]);
    planOk('translate.googleapis.com', [[['你好', 'hi']]]);
    plan.push({ match: 'www.bing.com/translator', text: BING_PAGE });
    planOk('www.bing.com/ttranslatev3', [{ translations: [{ text: '你好' }] }]);
    planOk('edge.microsoft.com/translate/translatetext', [{ translations: [{ text: '你好' }] }]);
    planOk('aidemo.youdao.com', { errorCode: '0', translation: ['你好'] });
    planOk('transmart.qq.com', { auto_translation: ['你好'] });
    planOk('api.mymemory.translated.net', { responseStatus: 200, responseData: { translatedText: '你好' } });

    dom.registry.get('pp-tr-test-all').click();
    const done = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        if (/体检完成/.test(dom.registry.get('pp-tr-test-all-msg').textContent || '')) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    })();
    ok(done, '⑥c ★ 一键体检跑完并给出汇总');
    includes(dom.registry.get('pp-tr-test-all-msg').textContent, '7/7', '⑥c 七个免配置引擎全部可用');
    ok(httpCalls.length >= 8, '⑥c 每个引擎都真实发过请求（bing 另有取页面）', httpCalls.length);
    includes(globalMsg().textContent, '✓', '⑥c 底部汇总逐条列出结果');
    eq(dom.registry.get('pp-tr-test-all').disabled, false, '⑥c 结束后按钮恢复可用');
  }

  /* ---------- ⑦ 0.4x 在线词包目录（open-termbank）：获取 → 逐域导入 → 有更新检测 ---------- */
  {
    const IDX = {
      version: '1.0.0', total: 40,
      domains: [
        { domain: '医学', slug: 'medicine', file: 'medicine.csv', count: 20, sha256: 'a'.repeat(64) },
        { domain: '计算机', slug: 'computer-science', file: 'computer-science.csv', count: 20, sha256: 'b'.repeat(64) },
      ],
    };
    const CSV = 'source,target,domain\nmyocardial infarction,心肌梗死,医学\nplacebo,安慰剂,医学\n';
    const onlineBtn = () => dom.registry.get('pp-tr-glossary-online-fetch');
    const onlineStatus = () => dom.registry.get('pp-tr-glossary-online-status');
    const onlineList = () => dom.registry.get('pp-tr-glossary-online-list');
    const importBtnOf = (slug) => onlineList().byTag('button')
      .find((b) => b.getAttribute('data-slug') === slug) || null;

    // ① 获取目录 → 渲染每域行
    plan = []; httpCalls.length = 0;
    plan.push({ match: 'index.json', text: JSON.stringify(IDX) });
    onlineBtn().click();
    await tick(6);
    includes(onlineStatus().textContent, 'open-termbank v1.0.0', '⑦ 目录状态行显示版本与规模');
    eq(onlineList().byTag('button').length, 2, '⑦ 每个领域渲染一个导入按钮');
    ok(!!importBtnOf('medicine') && importBtnOf('medicine').textContent === '导入',
      '⑦ 未导入过的域按钮是「导入」');

    // ② 点击导入 → 走 parseGlossaryImport+mergeGlossary → 写 pref + sha256 记账
    plan.push({ match: 'medicine.csv', text: CSV });
    importBtnOf('medicine').click();
    await tick(8);
    const glossPref = P('translateGlossary', '');
    includes(glossPref, 'myocardial infarction = 心肌梗死 | 医学', '⑦ ★ 在线词包并入术语表（带领域标注）');
    includes(glossPref, 'placebo = 安慰剂 | 医学', '⑦ 逐条并入（非整体替换）');
    const stateRaw = P('translateGlossaryPackState', '');
    const state = JSON.parse(stateRaw || '{}');
    eq(state.medicine, 'a'.repeat(64), '⑦ ★ sha256 记账（「有更新」检测的依据）');
    eq(importBtnOf('medicine').textContent, '重新导入', '⑦ 导入后按钮变「重新导入」');
    includes(dom.registry.get('pp-tr-glossary-msg').textContent, '已解析', '⑦ 术语表统计行随导入刷新');
    // 已导入的域出现 ✓ 徽标；未导入的域没有
    ok(onlineList().textContent.indexOf('已导入') >= 0, '⑦ 已导入域显示 ✓ 徽标');

    // ③ 目录 sha 变化 → 「有更新」徽标 + 按钮变「更新」
    const IDX2 = JSON.parse(JSON.stringify(IDX));
    IDX2.version = '1.1.0';
    IDX2.domains[0].sha256 = 'c'.repeat(64);
    plan = []; httpCalls.length = 0;
    plan.push({ match: 'index.json', text: JSON.stringify(IDX2) });
    onlineBtn().click();
    await tick(6);
    eq(importBtnOf('medicine').textContent, '更新', '⑦ 目录 sha 变化 → 按钮变「更新」');
    includes(onlineList().textContent, '有更新', '⑦ ★ 「有更新」徽标出现');
    eq(importBtnOf('computer-science').textContent, '导入', '⑦ 未导入过的域不受影响');

    // ④ 网络全挂 → 状态行降级提示、面板不炸、列表清空
    plan = []; httpCalls.length = 0;
    onlineBtn().click();
    await tick(8);
    includes(onlineStatus().textContent, '不可用', '⑦ 网络失败给可读降级提示（不静默）');
    eq(onlineList().children.length, 0, '⑦ 失败后列表清空（不残留旧目录）');
    ok(dom.registry.get('pp-tr-glossary') !== null, '⑦ 面板其余部分不受影响');

    // ⑤ 清理：还原术语表与记账 pref，避免影响后续断言
    setP('translateGlossary', '');
    setP('translateGlossaryPackState', '');
    plan = []; httpCalls.length = 0;
  }

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('-'.repeat(60));
  }
  console.log('翻译引擎设置面板测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.log('测试异常：' + ((e && e.stack) || e)); process.exit(1); });
