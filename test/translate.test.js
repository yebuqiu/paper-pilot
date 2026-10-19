#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 多引擎翻译 测试（插件 0.28.0）
 *
 * 为什么要有它：翻译引擎的接入面是「外部世界的契约」——每个厂商的语言码、
 * 请求形态、响应结构各不相同，且都极易因对方改版而静默失效（返回空串、
 * 或者把错误码当正文）。这些构造/解析都是纯函数，可以在无人环境里逐条钉死。
 * 覆盖：
 *   ① 语言归一化：显示名 / 规范码 / 厂商码 / 地区变体 → 规范码
 *   ② 各引擎语言码映射：百度 jp、腾讯 ja、DeepL ZH-HANS、微软 zh-Hans、彩云 zh-Hant
 *   ③ 复合密钥："#" 串 ↔ 字段对象；必填缺失判定
 *   ④ 请求构造：URL/头/体（含腾讯云 HMAC-SHA1 签名、百度 md5 签名、Google tk）
 *   ⑤ 响应解析：各厂商成功/错误码分支（错误必须抛出，不能静默空串）
 *   ⑥ 摘要算法正确性：SHA-1 / HMAC-SHA1 / base64（对公开测试向量）
 *   ⑦ 运行时：超时重试、回退链、结果缓存、AI 未就绪时跳过 llm 引擎
 *
 * 运行：node test/translate.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'ai', 'translate.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 260) });
}
function throws(fn, re, label) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) return ok(false, label + '（未抛异常）');
  return ok(re ? re.test(String(threw.message)) : true, label, { got: threw.message });
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const Prefs = {
  PREFIX: 'extensions.zotero.papilot.',
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};

// HTTP 计划：数组，每项 {match(urlSub), res(obj) | fail(msg) | failStatus(code)}
let httpPlan = [];
const httpCalls = [];
function resetHttp() {
  httpPlan = []; httpCalls.length = 0;
  // 冷却与缓存都是"会话级状态"，用例之间必须清掉，否则会串味（0.31.0 新增冷却后踩到）
  if (T && T.clearCooldown) T.clearCooldown();
  if (T && T.clearCache) T.clearCache();
}
/** 只换 HTTP 计划，保留冷却状态（测冷却行为时用） */
function resetHttpOnly() { httpPlan = []; httpCalls.length = 0; }
function plan(match, outcome) { httpPlan.push({ match, outcome, count: 0 }); }
/** 某匹配串被真正请求了几次 */
function hits(match) {
  const h = httpPlan.find((p) => p.match === match);
  return h ? h.count : 0;
}

const Zotero = {
  locale: 'zh-CN',
  Prefs: Prefs,
  Utilities: { Internal: { md5: (s) => 'md5(' + require('crypto').createHash('md5').update(String(s), 'utf8').digest('hex') + ')' } },
  HTTP: {
    async request(method, url, opts) {
      httpCalls.push({ method, url, opts });
      const hit = httpPlan.find((p) => url.indexOf(p.match) >= 0);
      if (!hit) throw new Error('no http plan for ' + url.slice(0, 80));
      hit.count++;
      // outcome / outcome.res 都支持函数形式（按请求 URL 动态造响应，用于多段分段的回显）
      const o = (typeof hit.outcome === 'function') ? hit.outcome(url, method) : hit.outcome;
      if (o.fail) throw new Error(o.fail);
      if (o.failStatus) {
        const e = new Error('HTTP ' + o.failStatus);
        e.xmlhttp = { status: o.failStatus, response: null, responseText: 'err' };
        throw e;
      }
      const res = (typeof o.res === 'function') ? o.res(url, method) : o.res;
      return { status: 200, response: res, responseText: o.text };
    },
  },
};

let aiReady = true;
const AIClient = {
  hasKey: () => aiReady,
  guidance: () => '未登录/未配置',
  async chat() { return 'LLM 译文'; },
};

const sandbox = {
  console, Zotero, Prefs, AIClient,
  setTimeout, clearTimeout, Promise, Date, Math, JSON, URLSearchParams,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'translate.js' });
const T = sandbox.TranslateSvc;

/** 写配置（覆盖默认） */
function setCfg(patch) {
  const cur = T.cfg();
  Prefs.set('translateCfg', JSON.stringify(Object.assign({}, cur, patch)));
}

/* ==================== ① 语言归一化 ==================== */
eq(T.normalizeLang('中文'), 'zh-CN', '① 显示名「中文」→ zh-CN');
eq(T.normalizeLang('English'), 'en', '① 「English」→ en');
eq(T.normalizeLang('日本語'), 'ja', '① 「日本語」→ ja');
eq(T.normalizeLang('繁體中文'), 'zh-TW', '① 「繁體中文」→ zh-TW');
eq(T.normalizeLang('zh-Hans'), 'zh-CN', '① zh-Hans → zh-CN');
eq(T.normalizeLang('zh-Hant'), 'zh-TW', '① zh-Hant → zh-TW');
eq(T.normalizeLang('en-US'), 'en', '① en-US → en');
eq(T.normalizeLang('zh-TW'), 'zh-TW', '① zh-TW 保持繁体（不被 zh 前缀吞成简体）');
eq(T.normalizeLang(''), 'auto', '① 空 → auto');
eq(T.normalizeLang('自动检测'), 'auto', '① 「自动检测」→ auto');
eq(T.normalizeLang('kp'), 'kp', '① 未知码原样保留');
eq(T.langLabel('zh-CN'), '中文（简体）', '① label 可读');
eq(T.langName('zh-CN'), '中文', '① name 用于 prompt');

/* ==================== ② 各引擎语言码 ==================== */
eq(T.langCode('baidu', 'ja'), 'jp', '② 百度 ja → jp');
eq(T.langCode('baidu', 'zh-TW'), 'cht', '② 百度繁中 → cht');
eq(T.langCode('tencent', 'ja'), 'ja', '② 腾讯 ja → ja');
eq(T.langCode('tencent', 'ko'), 'ko', '② 腾讯 ko → ko');
eq(T.langCode('deepl', 'zh-CN'), 'ZH-HANS', '② DeepL 简中 → ZH-HANS');
eq(T.langCode('deepl', 'zh-TW'), 'ZH-HANT', '② DeepL 繁中 → ZH-HANT');
eq(T.langCode('deepl', 'auto'), '', '② DeepL 源语言 auto → 空（省略字段）');
eq(T.langCode('microsoft', 'zh-CN'), 'zh-Hans', '② 微软简中 → zh-Hans');
eq(T.langCode('microsoft', 'zh-TW'), 'zh-Hant', '② 微软繁中 → zh-Hant');
eq(T.langCode('caiyun', 'zh-TW'), 'zh-Hant', '② 彩云繁中 → zh-Hant');
eq(T.langCode('youdao', 'zh-CN'), 'zh-CHS', '② 有道简中 → zh-CHS');
eq(T.langCode('libretranslate', 'zh-TW'), 'zt', '② LibreTranslate 繁中 → zt');

/* ==================== ③ 复合密钥 ==================== */
eq(T.parseSecret('baidu', 'app#key').appid, 'app', '③ 百度密钥第 1 段 = appid');
eq(T.parseSecret('baidu', 'app#key').key, 'key', '③ 百度密钥第 2 段 = key');
eq(T.joinSecret('baidu', { appid: 'a', key: 'b' }), 'a#b', '③ 字段对象 → "#" 串');
eq(T.joinSecret('tencent', { secretId: 'x', secretKey: 'y' }), 'x#y',
   '③ 可选尾段为空时裁掉（腾讯只填两段）');
eq(T.joinSecret('tencent', { secretId: 'x', secretKey: 'y', region: 'ap-beijing' }),
   'x#y#ap-beijing', '③ 中间段保留');
eq(T.parseSecret('tencent', 'x#y').region, '', '③ 缺位补空不报错');
eq(T.resolveSecret('baidu', '').ok, false, '③ 百度未填密钥 → 不就绪');
ok(/AppID/.test(T.resolveSecret('baidu', '').error), '③ 报错点名缺失字段');
eq(T.resolveSecret('baidu', 'a#b').ok, true, '③ 百度两段齐全 → 就绪');
eq(T.resolveSecret('deepl', 'k:fx').ok, true, '③ DeepL 单字段密钥');
eq(T.resolveSecret('google', '').ok, true, '③ 免密引擎恒就绪');

/* ==================== ④ 请求构造 ==================== */
const cG = T.buildEndpoint('google', T.makeCtx('google', { text: 'Hello 世界', from: 'en', to: 'zh-CN' }));
includes(cG.url, 'translate_a/single', '④ Google 走 single 接口');
includes(cG.url, 'sl=en', '④ Google 源语言带上');
includes(cG.url, 'tl=zh-CN', '④ Google 目标语言带上');
ok(/&tk=\d+\.\d+/.test(cG.url), '④ Google 请求含 tk 令牌', cG.url.slice(0, 200));
includes(cG.url, encodeURIComponent('Hello 世界'), '④ Google q 已 encode');
eq(cG.method, 'GET', '④ Google 用 GET');

Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(), { secrets: { deepl: 'k:fx' } })));
const cD = T.buildEndpoint('deepl', T.makeCtx('deepl', { text: 'hi', from: 'auto', to: 'zh-CN' }));
eq(cD.url, 'https://api-free.deepl.com/v2/translate', '④ DeepL :fx 密钥走免费端点');
eq(cD.headers.Authorization, 'DeepL-Auth-Key k:fx', '④ DeepL 鉴权头');
ok(JSON.parse(cD.body).source_lang === undefined, '④ DeepL 源语言 auto 时省略字段');

Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(), { secrets: { deepl: 'k' } })));
eq(T.buildEndpoint('deepl', T.makeCtx('deepl', { text: 'hi' })).url,
   'https://api.deepl.com/v2/translate', '④ DeepL 非 :fx 走 Pro 端点');

Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(),
  { secrets: { microsoft: 'KEY32#East Asia' } })));
const cM = T.buildEndpoint('microsoft', T.makeCtx('microsoft', { text: 'hi', from: 'en', to: 'zh-CN' }));
includes(cM.url, 'to=zh-Hans', '④ 微软目标码 zh-Hans');
eq(cM.headers['Ocp-Apim-Subscription-Region'], 'eastasia', '④ 微软区域去空格转小写');
includes(cM.url, 'from=en', '④ 微软源语言');
eq(JSON.parse(cM.body)[0].Text, 'hi', '④ 微软请求体是 [{Text}] 数组');
const cM2 = T.buildEndpoint('microsoft', T.makeCtx('microsoft', { text: 'hi', secret: 'KEY32#global' }));
ok(!cM2.headers['Ocp-Apim-Subscription-Region'], '④ 微软区域 global 时不加头');
ok(!/from=/.test(cM2.url), '④ 微软源语言 auto 时不带 from');

Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(),
  { secrets: { baidu: 'app#key' }, from: 'en' })));
const cB = T.buildEndpoint('baidu', T.makeCtx('baidu', { text: 'hello', to: 'ja' }));
includes(cB.url, 'appid=app', '④ 百度带 appid');
includes(cB.url, 'to=jp', '④ 百度目标码 jp');
includes(cB.url, '&sign=md5(', '④ 百度 sign 已计算');
ok(/salt=\d+/.test(cB.url), '④ 百度带时间戳 salt');

Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(),
  { secrets: { tencent: 'SID#SKEY#ap-shanghai#0' } })));
const cT = T.buildEndpoint('tencent', T.makeCtx('tencent', { text: '你好', from: 'zh-CN', to: 'en' }));
eq(cT.url, 'https://tmt.tencentcloudapi.com', '④ 腾讯云端点');
includes(cT.body, 'Action=TextTranslate', '④ 腾讯云 Action');
includes(cT.body, 'SecretId=SID', '④ 腾讯云 SecretId');
includes(cT.body, 'Target=en', '④ 腾讯云 Target');
ok(/&Signature=[A-Za-z0-9%+.*()'-]+/.test(cT.body), '④ 腾讯云签名已附加', cT.body.slice(-120));
includes(cT.body, 'SourceText=' + encodeURIComponent('你好').replace(/%20/g, '+'), '④ 腾讯云源文本已编码');
ok(cT.body.indexOf('Signature=') > cT.body.indexOf('SourceText='), '④ 签名在最后（先签名后追加）');

Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(),
  { secrets: { caiyun: 'tok' } })));
throws(() => T.buildEndpoint('caiyun', T.makeCtx('caiyun', { text: 'x', from: 'zh-CN', to: 'fr' })),
  /中\/英\/日|中文/, '④ 彩云不支持的语言对 → 明确报错');
const cC = T.buildEndpoint('caiyun', T.makeCtx('caiyun', { text: 'x', from: 'auto', to: 'zh-CN' }));
eq(JSON.parse(cC.body).trans_type, 'auto2zh', '④ 彩云 trans_type = from2to（auto 源语言保留 auto）');
const cC2 = T.buildEndpoint('caiyun', T.makeCtx('caiyun', { text: 'x', from: 'en', to: 'zh-TW' }));
eq(JSON.parse(cC2.body).trans_type, 'en2zh-Hant', '④ 彩云繁中目标 → zh-Hant');

throws(() => T.buildEndpoint('libretranslate', T.makeCtx('libretranslate', { text: 'x' })),
  /服务地址/, '④ LibreTranslate 缺地址 → 报错');
Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(),
  { secrets: { libretranslate: 'https://lt.example.com/#k1' } })));
const cL = T.buildEndpoint('libretranslate', T.makeCtx('libretranslate', { text: 'x', from: 'en', to: 'zh-CN' }));
eq(cL.url, 'https://lt.example.com/translate', '④ LibreTranslate 端点拼接');
eq(JSON.parse(cL.body).api_key, 'k1', '④ LibreTranslate api_key 透传');
eq(JSON.parse(cL.body).target, 'zh', '④ LibreTranslate 目标码 zh');

eq(T.buildEndpoint('llm', T.makeCtx('llm', { text: 'x' })), null, '④ llm 引擎不走纯 endpoint');

/* ==================== ⑤ 响应解析 ==================== */
eq(T.extractResult('google', { response: [[['你好', 'Hello', null, null, 10], [', 世界', ', world']]] }, {}),
   '你好, 世界', '⑤ Google 多段拼接');
eq(T.extractResult('deepl', { response: { translations: [{ text: '你好' }] } }, {}), '你好', '⑤ DeepL 解析');
eq(T.extractResult('microsoft', { response: [{ translations: [{ text: '你好' }] }] }, {}), '你好', '⑤ 微软解析');
eq(T.extractResult('baidu', { response: { trans_result: [{ dst: '你好' }, { dst: '世界' }] } }, {}),
   '你好世界', '⑤ 百度多行拼接');
throws(() => T.extractResult('baidu', { response: { error_code: '54001', error_msg: '签名错误' } }, {}),
  /54001/, '⑤ 百度错误码必须抛出（不能当空串）');
eq(T.extractResult('tencent', { response: { Response: { TargetText: 'Hello' } } }, {}), 'Hello', '⑤ 腾讯云解析');
throws(() => T.extractResult('tencent', { response: { Response: { Error: { Code: 'AuthFailure', Message: 'x' } } } }, {}),
  /AuthFailure/, '⑤ 腾讯云错误必须抛出');
eq(T.extractResult('youdao', { response: { errorCode: '0', translation: ['你好', '世界'] } }, {}),
   '你好\n世界', '⑤ 有道多段换行拼接');
throws(() => T.extractResult('youdao', { response: { errorCode: '108' } }, {}), /108/, '⑤ 有道错误码抛出');
eq(T.extractResult('caiyun', { response: { target: ['你好'] } }, {}), '你好', '⑤ 彩云解析');
eq(T.extractResult('mymemory', { response: { responseStatus: 200, responseData: { translatedText: '你好' } } }, {}),
   '你好', '⑤ MyMemory 解析');
eq(T.extractResult('deeplx', { response: { code: 200, data: '你好' } }, {}), '你好', '⑤ DeepLX data 字段');
eq(T.extractResult('libretranslate', { response: { translatedText: '你好' } }, {}), '你好', '⑤ LibreTranslate 解析');
eq(T.extractResult('bing', { response: [{ translations: [{ text: '你好' }] }] }, {}), '你好', '⑤ 必应解析');
throws(() => T.extractResult('bing', { response: { statusCode: 400 } }, {}), /400/, '⑤ 必应错误码抛出');

/* ==================== ⑥ 摘要算法（公开测试向量） ==================== */
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
eq(hex(T.sha1Bytes(T.utf8Bytes('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d',
   '⑥ SHA-1("abc") 与 FIPS 向量一致');
eq(hex(T.sha1Bytes(T.utf8Bytes(''))), 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
   '⑥ SHA-1("") 与向量一致');
eq(hex(T.hmacSha1(T.utf8Bytes('key'), T.utf8Bytes('The quick brown fox jumps over the lazy dog'))),
   'de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9', '⑥ HMAC-SHA1 与 RFC 2202 向量一致');
eq(T.base64('abc'), 'YWJj', '⑥ base64("abc")');
eq(T.base64('中文'), '5Lit5paH', '⑥ base64 UTF-8 中文');
eq(T.base64(T.utf8Bytes('a')), 'YQ==', '⑥ base64 补位');
eq(T.encodeRFC5987("a b'c()"), 'a+b%27c%28%29', '⑥ 腾讯云要求的 RFC5987 变体编码');
eq(T.googleTk('hello'), T.googleTk('hello'), '⑥ Google tk 对同一输入稳定');
ok(/^\d+\.\d+$/.test(T.googleTk('测试')), '⑥ Google tk 形如 num.num');
ok(T.googleTk('a') !== T.googleTk('b'), '⑥ Google tk 随文本变化');

/* ==================== ⑦ 运行时：回退 / 缓存 / AI 门禁 ==================== */
(async () => {
  // 活动引擎 google 失败（500）→ 回退链里的 youdao 成功
  setCfg({ active: 'google', fallback: ['youdao'], secrets: {}, cache: true });
  resetHttp();
  plan('translate.google.com', { failStatus: 500 });
  plan('translate.googleapis.com', { failStatus: 500 });
  plan('aidemo.youdao.com', { res: { errorCode: '0', translation: ['你好'] } });
  let r = await T.translate('hello', { to: 'zh-CN' });
  ok(r.ok, '⑦ 主引擎失败时回退成功', r);
  eq(r.engine, 'youdao', '⑦ 命中回退引擎');
  eq(r.text, '你好', '⑦ 回退结果正确');
  eq(r.fallback, true, '⑦ 标记为回退结果');
  eq(r.tried.length, 1, '⑦ 记录失败过一次');
  ok(/HTTP 500/.test(r.tried[0].error), '⑦ 失败原因可读');

  // 缓存：同一文本再翻译不再发请求
  const before = httpCalls.length;
  const r2 = await T.translate('hello', { to: 'zh-CN', engine: 'youdao' });
  ok(r2.cached, '⑦ 第二次命中缓存');
  eq(httpCalls.length, before, '⑦ 缓存命中不发网络请求');

  // 全部失败：返回 ok:false 且 tried 完整
  setCfg({ active: 'google', fallback: ['youdao'], cache: false });
  resetHttp();
  plan('translate.google.com', { failStatus: 500 });
  plan('translate.googleapis.com', { failStatus: 500 });
  plan('aidemo.youdao.com', { fail: 'dns failure' });
  const r3 = await T.translate('world', { to: 'zh-CN' });
  eq(r3.ok, false, '⑦ 全部失败返回 ok:false');
  eq(r3.tried.length, 2, '⑦ tried 覆盖两个引擎');

  // 401 不重试（retryable=false）：只请求一次
  setCfg({ active: 'deepl', fallback: [], secrets: { deepl: 'k' }, retry: 1, cache: false });
  resetHttp();
  plan('api.deepl.com', { failStatus: 401 });
  const r4 = await T.translate('abc', { to: 'zh-CN' });
  eq(r4.ok, false, '⑦ 401 返回失败');
  eq(httpCalls.length, 1, '⑦ 401（不可重试）只请求一次');
  ok(/密钥无效/.test(r4.error), '⑦ 401 文案可读');

  // 5xx 会重试一次 → 共 2 次请求
  resetHttp();
  plan('api-free.deepl.com', { failStatus: 503 });
  Prefs.set('translateCfg', JSON.stringify(Object.assign({}, T.cfg(), { secrets: { deepl: 'k:fx' } })));
  const r5 = await T.translate('abc', { to: 'zh-CN', engine: 'deepl' });
  eq(httpCalls.length, 2, '⑦ 5xx 重试一次（共 2 次请求）');
  eq(r5.ok, false, '⑦ 重试后仍失败 → ok:false');

  // 业务/解析类错误不重试：百度返回错误码 → 只请求一次（避免白烧额度）
  setCfg({ active: 'baidu', fallback: [], secrets: { baidu: 'a#kk' }, retry: 1, cache: false });
  resetHttp();
  plan('api.fanyi.baidu.com', { res: { error_code: '54001', error_msg: '签名错误' } });
  const r5b = await T.translate('abc', { to: 'zh-CN' });
  eq(r5b.ok, false, '⑦ 业务错误码 → 失败');
  eq(httpCalls.length, 1, '⑦ 业务错误码不重试（共 1 次请求）');
  ok(/54001/.test(r5b.error), '⑦ 错误码透出给用户', r5b.error);

  // llm 引擎：AI 未就绪 → 跳过（不当作引擎故障，回退到免费引擎）
  aiReady = false;
  setCfg({ active: 'llm', fallback: ['google'], cache: false });
  resetHttp();
  plan('translate.google.com', { res: [[['你好', 'hi']]] });
  const r6 = await T.translate('hi', { to: 'zh-CN' });
  eq(r6.ok, true, '⑦ AI 未就绪时自动回退到免费引擎');
  eq(r6.engine, 'google', '⑦ 回退到 google');
  ok(/AI/.test(r6.tried[0].error), '⑦ 记录「AI 不可用」而非崩溃');
  aiReady = true;

  // llm 引擎：AI 就绪 → 走大模型
  setCfg({ active: 'llm', fallback: [], cache: false });
  resetHttp();
  const r7 = await T.translate('hi', { to: 'zh-CN' });
  eq(r7.ok, true, '⑦ AI 就绪时 llm 引擎可用');
  eq(r7.engine, 'llm', '⑦ 命中 llm 引擎');
  eq(r7.text, 'LLM 译文', '⑦ llm 引擎返回大模型输出');

  // overview / ready
  setCfg({ active: 'google', fallback: ['bing'], secrets: { baidu: 'a#b' } });
  const ov = T.overview();
  eq(ov.active, 'google', '⑦ overview 暴露活动引擎');
  eq(ov.services.find((s) => s.id === 'baidu').configured, true, '⑦ overview 标记已配置引擎');
  eq(ov.services.find((s) => s.id === 'deepl').configured, false, '⑦ overview 标记未配置引擎');
  eq(T.ready('google'), true, '⑦ 免密引擎就绪');
  eq(T.ready('deepl'), false, '⑦ 缺密钥引擎不就绪');

  // available()：活动引擎不可用但备用引擎可用 → 整体仍可用（浮窗据此放行翻译）
  setCfg({ active: 'deepl', fallback: ['google'], secrets: {} });
  eq(T.ready('deepl'), false, '⑦ 活动引擎缺密钥 → 未就绪');
  eq(T.available(), true, '⑦ 有可用备用引擎 → available() 为真');
  setCfg({ active: 'deepl', fallback: [], secrets: {} });
  eq(T.available(), false, '⑦ 无任何可用引擎 → available() 为假');
  ok(/翻译引擎|密钥/.test(T.unavailableHint()), '⑦ 不可用时有可执行指引', T.unavailableHint());

  // 源语言：独立 pref translateFromLang
  Prefs.set('translateFromLang', 'en');
  eq(T.sourceCode(), 'en', '⑦ 源语言读 translateFromLang');
  Prefs.set('translateFromLang', '英文');
  eq(T.sourceCode(), 'en', '⑦ 源语言旧显示名也归一');
  Prefs.delete ? Prefs.delete('translateFromLang') : Prefs.set('translateFromLang', 'auto');
  setCfg({ active: 'google', fallback: ['bing'] });
  eq(T.overview().source, 'auto', '⑦ overview 暴露源语言');

  ok(ov.services.length >= 13, '⑦ 引擎数量 ≥ 13', ov.services.length);
  ok(ov.langs.some((l) => l.code === 'zh-CN'), '⑦ 语言表含简中');

  /* ==================== ⑧ 长文本分段 / Edge 引擎 / prepare（0.31.0） ==================== */

  /** 把分段结果按 sep 拼回（应与原文一致） */
  const rejoin = (sp) => {
    let out = sp.parts[0] || '';
    for (let i = 1; i < sp.parts.length; i++) out += (sp.seps[i - 1] || '') + sp.parts[i];
    return out;
  };

  // --- 纯函数 _splitText ---
  let sp = T.splitText('aa bb cc', 4, 'chars');
  eq(sp.parts.length, 3, '⑧ 按字符切分：4 字符上限 → 3 段');
  eq(sp.parts[0], 'aa', '⑧ 段内容正确（不含尾随空格）');
  eq(sp.seps[0], ' ', '⑧ 尾随空白被摘成 sep（拼回时空格不丢）');
  eq(sp.seps.length, sp.parts.length - 1, '⑧ seps 与 parts 对齐');
  eq(rejoin(sp), 'aa bb cc', '⑧ 拼回 == 原文');

  sp = T.splitText('你好世界', 3, 'bytes');
  eq(sp.parts.length, 4, '⑧ 按字节切分：CJK 每字 3 字节 → 4 段');
  eq(rejoin(sp), '你好世界', '⑧ 无空格 CJK 硬切后拼回 == 原文');

  sp = T.splitText('😀😀😀', 4, 'bytes');
  eq(sp.parts.length, 3, '⑧ 4 字节 emoji 按字节切分');
  ok(sp.parts.every((p) => p.length === 2), '⑧ 代理对不被切开（每段是完整的 2 个 UTF-16 单元）', sp.parts);
  eq(rejoin(sp), '😀😀😀', '⑧ emoji 拼回 == 原文');

  sp = T.splitText('abc', 1, 'chars');
  eq(sp.parts.join(''), 'abc', '⑧ 上限=1 也不丢内容、不死循环');

  sp = T.splitText('  lead', 3, 'chars');
  eq(sp.parts.join(''), 'lead', '⑧ 行首空白不产出空段（否则会发出空请求）');
  ok(sp.parts.every((p) => p.trim().length > 0), '⑧ 任何一段都不是空白');

  eq(T.splitText('', 10, 'chars').parts.length, 0, '⑧ 空文本 → 0 段');
  eq(T.splitText('abc', 0, 'chars').parts.length, 1, '⑧ 上限为 0 时不切分');

  // 一段长文本按同一规则反复切分都应能无损拼回
  const longText = Array.from({ length: 300 }, (_, i) => 'word' + i).join(' ');
  for (const metric of ['chars', 'bytes']) {
    const r = T.splitText(longText, 120, metric);
    eq(rejoin(r), longText, '⑧ 长文本按 ' + metric + ' 切分后无损拼回');
    ok(r.parts.every((p) => (metric === 'chars' ? p.length <= 120 : T.utf8Bytes(p).length <= 120)),
      '⑧ 每段都不超上限（' + metric + '）', r.parts.map((p) => p.length).slice(0, 5));
  }

  // --- 各引擎的单次上限（决定谁会分段） ---
  eq(T.get('mymemory').limits.bytes, 500, '⑧ MyMemory 声明 500 字节上限（★ 官方是字节不是字符）');
  eq(T.get('bing').limits.chars, 1000, '⑧ 必应网页版声明 1000 字符上限');
  eq(T.get('edge').limits.chars, 5000, '⑧ Edge 引擎声明 5000 字符上限');
  eq(T.get('tencent').limits.chars, 2000, '⑧ 腾讯 TMT 声明 2000 字符上限');
  eq(T.get('baidu').limits.bytes, 4000, '⑧ 百度按字节声明上限');
  eq(T.segmentsFor(T.get('mymemory'), 'x'.repeat(1200)).parts.length, 3, '⑧ 1200 字节 → MyMemory 切 3 段');
  eq(T.segmentsFor(T.get('edge'), 'x'.repeat(1200)).parts.length, 1, '⑧ 1200 字符 → Edge 不分段');
  eq(T.segmentsFor(T.get('deepl'), 'x'.repeat(9000)).parts.length, 1, '⑧ 未声明上限的引擎不分段');

  // --- 引擎清单含 edge，且免密钥 ---
  ok(!!T.get('edge'), '⑧ 引擎注册表含 edge');
  eq(T.resolveSecret('edge', '').ok, true, '⑧ edge 免密钥恒就绪');
  ok(/Edge/i.test(T.get('edge').name), '⑧ edge 名称可读');
  ok(!!T.get('edge').hint, '⑧ edge 带使用说明');
  ok(!!T.get('microsoft').hint, '⑧ microsoft 带 Azure F0 申请说明');
  ok(/F0|200 万/.test(T.get('microsoft').hint), '⑧ microsoft 说明里点出 F0 免费额度');

  // --- edge 的请求构造 / 响应解析（纯） ---
  const eCtx = T.makeCtx('edge', { text: 'Hello', from: 'en', to: 'zh-CN', pre: { token: 'T.OK' } });
  const eSpec = T.buildEndpoint('edge', eCtx);
  includes(eSpec.url, 'api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0', '⑧ edge 端点正确');
  includes(eSpec.url, 'to=zh-Hans', '⑧ edge 目标语言用微软码 zh-Hans');
  includes(eSpec.url, 'from=en', '⑧ edge 源语言带上');
  eq(eSpec.headers.Authorization, 'Bearer T.OK', '⑧ edge 用 prepare 拿到的 token');
  includes(eSpec.headers['User-Agent'], 'Edg/', '⑧ edge 必须伪装成 Edge UA（接口对 UA 敏感）');
  eq(JSON.parse(eSpec.body)[0].Text, 'Hello', '⑧ edge 请求体是 [{Text}]');
  eq(T.extractResult('edge', { response: [{ translations: [{ text: '你好' }] }] }, {}), '你好', '⑧ edge 解析译文');
  throws(() => T.extractResult('edge', { response: { error: { code: '401', message: 'bad token' } } }, {}),
    /bad token/, '⑧ edge 错误体必须抛出（不能当空结果）');

  // --- ★ prepare 真的会被调用（此前只声明未调用 → bing 引擎必然失败） ---
  const BING_PAGE = '<html><script>IG:"1A2B3C4D5E",data-iid="translator.5023",' +
    'var params_AbusePreventionHelper = [1699999999999,"TOKEN-XYZ",3600000];</script></html>';
  setCfg({ active: 'bing', fallback: [], cache: false });
  resetHttp();
  plan('www.bing.com/translator', { text: BING_PAGE });
  plan('www.bing.com/ttranslatev3', { res: [{ translations: [{ text: '你好' }] }] });
  const rBing = await T.translate('hello', { to: 'zh-CN' });
  eq(rBing.ok, true, '⑧ bing 引擎可翻译（prepare 被调用）', rBing);
  eq(rBing.text, '你好', '⑧ bing 返回译文');
  eq(hits('www.bing.com/translator'), 1, '⑧ 先取一次页面参数');
  const bingCall = httpCalls.find((c) => c.url.indexOf('ttranslatev3') >= 0);
  ok(!!bingCall, '⑧ 再发正式翻译请求');
  includes(bingCall.url, 'IG=1A2B3C4D5E', '⑧ IG 来自页面（prepare 产物进了 URL）');
  includes(bingCall.url, 'IID=translator.5023', '⑧ IID 来自页面');
  includes(String(bingCall.opts.body), 'token=TOKEN-XYZ', '⑧ 反滥用 token 进了请求体');

  resetHttp();
  plan('www.bing.com/translator', { text: '<html>no helper here</html>' });
  const rBing2 = await T.translate('hello', { to: 'zh-CN' });
  eq(rBing2.ok, false, '⑧ 取不到页面参数 → 失败而非静默');
  ok(/取 token 失败/.test(rBing2.error), '⑧ 给出可定位的错误', rBing2.error);

  // --- edge 端到端（auth → 翻译） ---
  const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'x'.repeat(60) + '.abc123signature';
  setCfg({ active: 'edge', fallback: [], cache: false });
  resetHttp();
  plan('edge.microsoft.com/translate/auth', { text: FAKE_JWT });
  plan('api-edge.cognitive.microsofttranslator.com', { res: [{ translations: [{ text: '你好世界' }] }] });
  const rEdge = await T.translate('Hello world', { to: 'zh-CN' });
  eq(rEdge.ok, true, '⑧ Edge 引擎端到端可用', rEdge);
  eq(rEdge.text, '你好世界', '⑧ Edge 返回译文');
  eq(hits('edge.microsoft.com/translate/auth'), 1, '⑧ auth 只取一次');

  resetHttp();
  plan('edge.microsoft.com/translate/auth', { text: 'not-a-jwt' });
  const rEdge2 = await T.translate('Hello', { to: 'zh-CN' });
  eq(rEdge2.ok, false, '⑧ auth 返回异常内容 → 明确失败');
  ok(/取 token 失败/.test(rEdge2.error), '⑧ 不把"接口变了"误报成"密钥无效"', rEdge2.error);

  // --- MyMemory 多段：真发多次请求并正确拼回 ---
  const mmText = Array.from({ length: 400 }, (_, i) => 'w' + i).join(' '); // > 1000 字节
  const mmParts = T.splitText(mmText, 500, 'bytes').parts.length;
  ok(mmParts >= 3, '⑧ 测试文本足够触发多段（' + mmParts + ' 段）');
  setCfg({ active: 'mymemory', fallback: [], cache: false });
  resetHttp();
  plan('api.mymemory.translated.net', {
    res: () => ({ responseStatus: 200, responseData: { translatedText: '(seg)' } }),
  });
  const rMM = await T.translate(mmText, { to: 'zh-CN' });
  ok(rMM.ok, '⑧ MyMemory 长文本可分多次调用', rMM);
  const mmOut = rMM.text || '';
  eq(hits('api.mymemory.translated.net'), mmParts, '⑧ 请求次数 == 分段数（超长才拆，不长不拆）');
  eq(mmOut.split('(seg)').length - 1, mmParts, '⑧ 每段译文都拼回结果', mmOut.slice(0, 60));
  includes(mmOut, ' ', '⑧ 拼回时保留段落间空格');

  // --- 分段数保护 ---
  setCfg({ active: 'mymemory', fallback: [], cache: false });
  resetHttp();
  plan('api.mymemory.translated.net', { res: { responseStatus: 200, responseData: { translatedText: 'x' } } });
  const huge = Array.from({ length: 4000 }, (_, i) => 'w' + i).join(' ');
  const rHuge = await T.translate(huge, { to: 'zh-CN' });
  eq(rHuge.ok, false, '⑧ 分段数超上限 → 明确失败（不退化成上百次串行请求）');
  ok(/文本过长/.test(rHuge.error), '⑧ 给出可执行提示', rHuge.error);
  eq(httpCalls.length, 0, '⑧ 超限时一个请求都不发');

  /* ==================== ⑨ P1：冷却 / 预算 / Lingva / TranSmart（0.31.0） ==================== */

  // --- 新增引擎入册 ---
  ok(!!T.get('lingva'), '⑨ 引擎注册表含 lingva（自建=Google 质量）');
  ok(!!T.get('transmart'), '⑨ 引擎注册表含 transmart（腾讯交互翻译，免密钥）');
  eq(T.list().length >= 16, true, '⑨ 引擎总数 ≥ 16', T.list().length);
  ok(!!T.get('transmart').experimental, '⑨ transmart 标注实验性（非官方协议）');

  // --- Lingva：REST 形态与语言码 ---
  setCfg({ secrets: { lingva: 'https://lingva.example.com/' } });
  const lv = T.buildEndpoint('lingva', T.makeCtx('lingva', { text: 'Hello world', from: 'en', to: 'zh-CN' }));
  eq(lv.method, 'GET', '⑨ Lingva 用 GET');
  includes(lv.url, 'https://lingva.example.com/api/v1/', '⑨ Lingva 走 /api/v1/{source}/{target}/{query}（末尾斜杠被规整）');
  includes(lv.url, '/en/zh/', '⑨ Lingva 语言码：简中 = zh（Google 码约定）');
  includes(lv.url, encodeURIComponent('Hello world'), '⑨ Lingva 查询串已编码');
  const lv2 = T.buildEndpoint('lingva', T.makeCtx('lingva', { text: 'x', from: 'auto', to: 'zh-TW' }));
  includes(lv2.url, '/auto/zh_HANT/', '⑨ Lingva 繁中 = zh_HANT');
  eq(T.extractResult('lingva', { response: { translation: '你好世界' } }, {}), '你好世界', '⑨ Lingva 解析译文');
  throws(() => T.extractResult('lingva', { response: { error: 'Invalid target language' } }, {}),
    /Invalid target/, '⑨ Lingva 错误体必须抛出');
  throws(() => T.buildEndpoint('lingva', T.makeCtx('lingva', { text: 'x', secret: '' })),
    /实例地址/, '⑨ Lingva 缺地址 → 明确报错');

  // --- TranSmart：请求体形态 ---
  const tm = T.buildEndpoint('transmart', T.makeCtx('transmart', { text: '你好，世界', from: 'auto', to: 'en' }));
  eq(tm.method, 'POST', '⑨ TranSmart 用 POST');
  eq(tm.url, 'https://transmart.qq.com/api/imt', '⑨ TranSmart 端点正确');
  eq(tm.headers.Origin, 'https://transmart.qq.com', '⑨ TranSmart 带 Origin');
  eq(tm.headers.Referer, 'https://transmart.qq.com/', '⑨ TranSmart 带 Referer');
  const tmB = JSON.parse(tm.body);
  eq(tmB.header.fn, 'auto_translation', '⑨ TranSmart header.fn 正确');
  eq(tmB.type, 'plain', '⑨ TranSmart type=plain');
  eq(tmB.source.text_list[0], '你好，世界', '⑨ TranSmart 文本放 text_list');
  eq(tmB.source.lang, 'auto', '⑨ TranSmart 源语言 auto 透传');
  eq(tmB.target.lang, 'en', '⑨ TranSmart 目标语言');
  ok(/^browser-chrome-[\d.]+-Windows_10-[0-9a-f-]{36}-\d+$/.test(tmB.header.client_key),
    '⑨ TranSmart client_key 形如 browser-chrome-<ver>-<os>-<uuid>-<ts>', tmB.header.client_key);
  const tmZH = T.buildEndpoint('transmart', T.makeCtx('transmart', { text: 'x', from: 'en', to: 'zh-CN' }));
  eq(JSON.parse(tmZH.body).target.lang, 'zh', '⑨ TranSmart 简中目标写成 zh');
  eq(T.extractResult('transmart', { response: { auto_translation: ['Hello', 'world'] } }, {}),
    'Hello\nworld', '⑨ TranSmart 多段换行拼接');
  throws(() => T.extractResult('transmart', { response: { header: { ret_code: '1' } } }, {}),
    /ret_code/, '⑨ TranSmart 无译文时抛出并带 ret_code');

  // --- 失败冷却：失败过的引擎短时间内被跳过，冷却期内由备用引擎顶上 ---
  setCfg({ active: 'google', fallback: ['youdao'], cache: false, cooldownMs: 60000, retry: 0 });
  T.clearCooldown();
  resetHttp();
  plan('translate.google.com', { failStatus: 500 });
  plan('aidemo.youdao.com', { res: { errorCode: '0', translation: ['你好'] } });
  const cd1 = await T.translate('alpha', { to: 'zh-CN' });
  eq(cd1.engine, 'youdao', '⑨ 首次：google 失败 → 回退 youdao');
  eq(cd1.cooled.length, 0, '⑨ 首次没有引擎处于冷却');
  ok(T.cooldownLeft('google') > 0, '⑨ 失败的引擎进入冷却');

  resetHttpOnly();
  plan('aidemo.youdao.com', { res: { errorCode: '0', translation: ['你好'] } });
  const cd2 = await T.translate('beta', { to: 'zh-CN' });
  eq(cd2.engine, 'youdao', '⑨ 冷却期内直接走备用引擎');
  eq(cd2.cooled.length, 1, '⑨ 结果里报告了被跳过的引擎');
  eq(cd2.cooled[0].engine, 'google', '⑨ 被跳过的是刚失败的 google');
  ok(cd2.cooled[0].leftMs > 0, '⑨ 附带剩余冷却时间（UI 可直接展示）');
  eq(hits('translate.google.com'), 0, '⑨ 冷却期内不再请求该引擎');

  resetHttp();
  plan('translate.google.com', { res: [[['OK', 'gamma']]] });
  T.clearCooldown();
  const cd3 = await T.translate('gamma', { to: 'zh-CN' });
  eq(cd3.engine, 'google', '⑨ 清除冷却后立即恢复使用');
  eq(hits('translate.google.com'), 1, '⑨ 恢复后确实发了请求');

  // 显式指定引擎时不受冷却影响（尊重调用方意图）
  T.clearCooldown();
  setCfg({ active: 'google', fallback: [], cache: false, cooldownMs: 60000 });
  resetHttp();
  plan('translate.google.com', { failStatus: 500 });
  await T.translate('delta', { to: 'zh-CN' });
  ok(T.cooldownLeft('google') > 0, '⑨ google 处于冷却');
  resetHttpOnly(); // 保留冷却，验证"显式指定 engine"能绕过它
  plan('translate.google.com', { res: [[['OK', 'eps']]] });
  const cd4 = await T.translate('epsilon', { to: 'zh-CN', engine: 'google' });
  eq(cd4.ok, true, '⑨ 显式指定 engine 时即使冷却也会尝试（不被静默跳过）');
  eq(hits('translate.google.com'), 1, '⑨ 显式指定确实发了请求');

  // 冷却可关闭
  setCfg({ active: 'google', fallback: ['youdao'], cache: false, cooldownMs: 0, retry: 0 });
  T.clearCooldown();
  resetHttp();
  plan('translate.google.com', { failStatus: 500 });
  plan('aidemo.youdao.com', { res: { errorCode: '0', translation: ['你好'] } });
  await T.translate('zeta', { to: 'zh-CN' });
  eq(T.cooldownLeft('google'), 0, '⑨ cooldownMs=0 → 不做冷却');

  // --- 预算：单路预算会真正压到 HTTP 超时上；0 = 关闭该保护 ---
  setCfg({ active: 'google', fallback: [], cache: false, timeoutMs: 15000, routeMs: 6000 });
  resetHttp();
  plan('translate.google.com', { res: [[['OK', 'eta']]] });
  await T.translate('eta', { to: 'zh-CN' });
  ok(httpCalls[0].opts.timeout <= 6000 && httpCalls[0].opts.timeout >= 3000,
    '⑨ 单路预算压到 HTTP 超时（≤ routeMs）', httpCalls[0].opts.timeout);

  const cc = T.cfg();
  setCfg({ routeMs: 999999, totalMs: 999999, cooldownMs: 999999 });
  const cHigh = T.cfg();
  ok(cHigh.routeMs <= 120000 && cHigh.totalMs <= 300000 && cHigh.cooldownMs <= 3600000,
    '⑨ 预算参数有上限保护（不会因为填了天文数字而永不超时）', cHigh);
  setCfg({ routeMs: 0, totalMs: 0, cooldownMs: 0 });
  const cOff = T.cfg();
  eq(cOff.routeMs, 0, '⑨ routeMs=0 → 关闭单路预算');
  eq(cOff.totalMs, 0, '⑨ totalMs=0 → 关闭总预算');
  eq(cOff.cooldownMs, 0, '⑨ cooldownMs=0 → 关闭冷却');
  setCfg({ routeMs: cc.routeMs, totalMs: cc.totalMs, cooldownMs: cc.cooldownMs });

  // --- 默认回退链升级（仅当从未自定义） ---
  setCfg({ fallback: ['google', 'bing', 'youdao'] });
  Prefs.set('translateFallbackUpgraded', false);
  T.migrate();
  eq(T.cfg().fallback.join(','), 'edge,google,bing,youdao',
    '⑨ 旧默认回退链升级为含 edge 的新默认（edge 排首位）');
  eq(Prefs.get('translateFallbackUpgraded'), true, '⑨ 升级只做一次（打标）');
  setCfg({ fallback: ['youdao', 'google'] });
  Prefs.set('translateFallbackUpgraded', false);
  T.migrate();
  eq(T.cfg().fallback.join(','), 'youdao,google', '⑨ 用户自定义过的回退链不被覆盖');

  // --- 全链失败时给出可读明细 ---
  setCfg({ active: 'google', fallback: ['youdao'], cache: false, retry: 0, cooldownMs: 0 });
  resetHttp();
  plan('translate.google.com', { failStatus: 500 });
  plan('aidemo.youdao.com', { failStatus: 500 });
  const allFail = await T.translate('theta', { to: 'zh-CN' });
  eq(allFail.ok, false, '⑨ 全链失败 → ok:false');
  ok(/Google/.test(allFail.detail) && /有道/.test(allFail.detail),
    '⑨ detail 逐条列出「引擎：原因」便于排障', allFail.detail);

  /* ==================== ⑩ 本机自建服务探测（把"自建离线"变成一键可用） ==================== */

  eq(T.LOCAL_PROBES.length, 3, '⑩ 探测三个常见自建翻译服务');
  eq(T.LOCAL_PROBES.map((p) => p.engine).sort().join(','), 'deeplx,libretranslate,lingva',
    '⑩ 覆盖 LibreTranslate / Lingva / DLX');
  eq(T.LOCAL_PROBES.find((p) => p.engine === 'libretranslate').port, 5000, '⑩ LibreTranslate 默认 5000');
  eq(T.LOCAL_PROBES.find((p) => p.engine === 'lingva').port, 3000, '⑩ Lingva 默认 3000');
  eq(T.LOCAL_PROBES.find((p) => p.engine === 'deeplx').port, 1188, '⑩ DLX 默认 1188');

  resetHttpOnly();
  plan('127.0.0.1:5000', { res: [{ code: 'en' }] });
  plan('127.0.0.1:1188', { res: { code: 200, data: 'ping' } });
  const probe = await T.probeLocal(1000);
  eq(probe.found.length, 2, '⑩ 命中两个本机服务');
  eq(probe.found.map((f) => f.engine).sort().join(','), 'deeplx,libretranslate',
    '⑩ 命中的是 LibreTranslate 与 DLX');
  eq(probe.found[0].url, 'http://127.0.0.1:5000', '⑩ 返回可直接填入的地址');
  ok(typeof probe.found[0].latencyMs === 'number', '⑩ 附带延迟（界面展示用）');
  eq(probe.missed.length, 1, '⑩ 未命中的记为 missed（探测永不抛异常）');
  eq(probe.missed[0].engine, 'lingva', '⑩ 未命中的是没起服务的 Lingva');
  eq(httpCalls.length, 3, '⑩ 三个候选都探了（没起服务的也要探一次才知道）');

  // 一键填入：写入的正是该引擎的 url 字段，填完即就绪
  T.setSecret('libretranslate', { url: probe.found[0].url });
  eq(T.parseSecret('libretranslate', T.secretOf('libretranslate')).url, 'http://127.0.0.1:5000',
    '⑩ 探测结果可直接写入引擎地址');
  ok(T.ready('libretranslate'), '⑩ 填入地址后该引擎立即可用');
  T.setSecret('libretranslate', '');

  /* ==================== ⑪ 术语表 / 上下文感知 / 行内公式保护（0.33.0） ==================== */

  // ---- 术语表解析（纯函数） ----
  eq(T.parseGlossary('').length, 0, '⑪ 空输入 → 空术语表');
  eq(T.parseGlossary('# 注释\n// 也是注释\ntransformer = Transformer').length, 1,
    '⑪ 注释行被跳过');
  eq(T.parseGlossary('graph neural network => 图神经网络')[0].s, 'graph neural network',
    '⑪ => 分隔符解析出原文');
  eq(T.parseGlossary('graph neural network => 图神经网络')[0].t, '图神经网络',
    '⑪ => 分隔符解析出译文');
  eq(T.parseGlossary('large language model\t大语言模型')[0].t, '大语言模型',
    '⑪ TAB 分隔同样支持');
  eq(T.parseGlossary('same = same').length, 0, '⑪ 原文=译文（无意义）被丢弃');
  eq(T.parseGlossary('JSON 数组：见下行').length, 0, '⑪ 无分隔符的行不产出术语');
  eq(T.parseGlossary('[{"s":"a","t":"b"},["c","d"]]')[1].t, 'd', '⑪ JSON 数组双形态兼容');
  eq(T.glossaryBlock([{ s: 'k8s', t: 'Kubernetes' }]), '- k8s → Kubernetes',
    '⑪ 术语块拼装成提示词行');
  eq(T.glossaryBlock([]), '', '⑪ 空表 → 空块（提示词零开销）');
  // 指纹：区分术语表版本（缓存键依赖）
  const fp1 = T.glossaryFingerprint([{ s: 'a', t: 'b' }]);
  const fp2 = T.glossaryFingerprint([{ s: 'a', t: 'b' }]);
  const fp3 = T.glossaryFingerprint([{ s: 'a', t: 'c' }]);
  ok(fp1 && fp1 === fp2, '⑪ 指纹稳定（同表同值）');
  ok(fp1 !== fp3, '⑪ 改术语表 → 指纹变化（缓存随之失效）');
  eq(T.glossaryFingerprint([]), '', '⑪ 空表指纹为空串');

  // ---- glossary() 读 pref ----
  Prefs.set('translateGlossary', 'transformer = Transformer\nLLM = 大语言模型');
  eq(T.glossary().length, 2, '⑪ glossary() 从 pref 读取并解析');
  Prefs.set('translateGlossary', '');

  // ---- 术语表进缓存键：改术语表不吃旧缓存 ----
  resetHttp();
  setCfg({ active: 'googleapi' });
  Prefs.set('translateGlossary', 'transformer = Transformer');
  plan('translate.googleapis.com', {
    res: () => [[['cached-with-glossary-A', 'src']]],
  });
  let rG1 = await T.translate('Hello glossary cache');
  ok(rG1.ok && rG1.text === 'cached-with-glossary-A', '⑪ 第一次翻译产生缓存');
  ok(rG1.cached === false, '⑪ 第一次是真请求');
  Prefs.set('translateGlossary', 'transformer = Transformer 变体');
  resetHttpOnly();
  plan('translate.googleapis.com', {
    res: () => [[['fresh-after-glossary-edit', 'src']]],
  });
  let rG2 = await T.translate('Hello glossary cache');
  eq(rG2.text, 'fresh-after-glossary-edit', '⑪ ★ 术语表变化后不吃旧缓存（指纹进缓存键）');
  Prefs.set('translateGlossary', '');
  resetHttp();

  // ---- llm prompt：术语表 + 上下文 + 公式保持指令 ----
  setCfg({ active: 'llm' });
  Prefs.set('translateGlossary', 'transformer = Transformer');
  let capturedMsgs = null;
  sandbox.AIClient.chat = async (msgs) => { capturedMsgs = msgs; return 'ok 译文'; };
  let rLlm = await T.translate('The transformer model.', {
    to: 'zh-CN',
    context: { title: 'Attention Is All You Need', prev: '上一段译文示例' },
  });
  ok(rLlm.ok, '⑪ llm 翻译成功（上下文路径）');
  ok(capturedMsgs && capturedMsgs[1].content.indexOf('transformer → Transformer') >= 0,
    '⑪ ★ llm prompt 含术语表');
  ok(capturedMsgs[1].content.indexOf('Attention Is All You Need') >= 0,
    '⑪ llm prompt 含文档标题（上下文）');
  ok(capturedMsgs[1].content.indexOf('上一段译文示例') >= 0,
    '⑪ llm prompt 含上一段译文（上下文感知）');
  ok(/公式/.test(capturedMsgs[1].content), '⑪ llm prompt 含公式保持指令');
  Prefs.set('translateGlossary', '');
  sandbox.AIClient.chat = async () => 'LLM 译文'; // 还原桩，避免影响后续用例

  // ---- 行内公式掩码（纯函数） ----
  const masked = T.maskInlineFormulas('The loss is $L = \\alpha x^2$ in all cases.');
  eq(masked.count, 1, '⑪ $...$ 定界公式被掩码');
  ok(/⟦PPF0⟧/.test(masked.text), '⑪ 掩码产出占位符 ⟦PPF0⟧');
  ok(masked.text.indexOf('The loss is') === 0, '⑪ 掩码不伤正文前缀');
  ok(masked.text.indexOf('in all cases.') >= 0, '⑪ 掩码不伤正文后缀');
  eq(T.unmaskFormulas(masked.text, masked.map), 'The loss is $L = \\alpha x^2$ in all cases.',
    '⑪ 掩码 → 还原 往返一致');
  eq(T.unmaskFormulas('⟦ PPF : 0 ⟧', masked.map), '$L = \\alpha x^2$',
    '⑪ 还原容忍引擎插入的空白');
  eq(T.unmaskFormulas('译文丢了占位符', masked.map), '译文丢了占位符',
    '⑪ 占位符不在译文里则原样返回（不会拼错内容）');

  const masked2 = T.maskInlineFormulas('where x 1 + x 2 = y 3 + z 4 holds for all inputs');
  eq(masked2.count, 1, '⑪ 连续数学 token 串被掩码');
  ok(masked2.text.indexOf('⟦PPF0⟧') >= 0 && masked2.text.indexOf('where') === 0 &&
    masked2.text.indexOf('holds for all inputs') > 0, '⑪ token 串掩码保留前后正文');

  const masked3 = T.maskInlineFormulas('The quick brown fox jumps over the lazy dog.');
  eq(masked3.count, 0, '⑪ 正常英文句子零误伤');
  eq(masked3.text, 'The quick brown fox jumps over the lazy dog.', '⑪ 零掩码时文本原样');

  // ---- 非 llm 引擎集成：掩码 → 引擎 → 还原 ----
  resetHttp();
  setCfg({ active: 'googleapi' });
  Prefs.set('translateFormulaProtect', true);
  plan('translate.googleapis.com', {
    res: (url) => {
      const q = decodeURIComponent((url.match(/&q=([^&]+)/) || [])[1] || '');
      return [[[ 'ECHO:' + q, 'src' ]]];
    },
  });
  let rMask = await T.translate('The loss is $L = \\alpha x^2$ in all cases.');
  ok(rMask.ok, '⑪ 非 llm 引擎翻译成功（掩码路径）');
  eq(rMask.text, 'ECHO:The loss is $L = \\alpha x^2$ in all cases.',
    '⑪ 译文里的公式已被还原（占位符不外露）');
  {
    const sentUrl = httpCalls.length ? httpCalls[httpCalls.length - 1].url : '';
    ok(decodeURIComponent(sentUrl).indexOf('⟦PPF0⟧') >= 0,
      '⑪ ★ 引擎实际收到的是占位符（公式没被送翻）');
  }
  // 引擎若把占位符原样吐回 → 还原成原公式
  resetHttpOnly();
  plan('translate.googleapis.com', {
    res: (url) => {
      const q = decodeURIComponent((url.match(/&q=([^&]+)/) || [])[1] || '');
      return [[[ '损失为 ' + q + '（还原前）', 'src' ]]];
    },
  });
  let rMask2 = await T.translate('Loss value $L = \\alpha$ here.', { noCache: true });
  eq(rMask2.text, '损失为 Loss value $L = \\alpha$ here.（还原前）', '⑪ ★ 掩码在引擎返回后被原样还原');
  Prefs.set('translateFormulaProtect', false);
  resetHttpOnly();
  plan('translate.googleapis.com', {
    res: (url) => {
      const q = decodeURIComponent((url.match(/&q=([^&]+)/) || [])[1] || '');
      return [[[ 'RAW:' + q, 'src' ]]];
    },
  });
  let rNoMask = await T.translate('Loss value $L = \\alpha$ here.', { noCache: true });
  eq(rNoMask.text, 'RAW:Loss value $L = \\alpha$ here.',
    '⑪ 关闭公式保护 → 原文直送引擎（开关生效）');
  Prefs.set('translateFormulaProtect', true);
  resetHttp();

  /* ==================== ⑪b 术语表领域化（0.4x） ==================== */

  // ---- 领域标签解析（行式第三段 / JSON d 字段 / 三元数组） ----
  {
    const g1 = T.parseGlossary('myocardial infarction = 心肌梗死 | 医学')[0];
    eq(g1.s, 'myocardial infarction', '⑪b 行式第三段解析出原文');
    eq(g1.t, '心肌梗死', '⑪b 行式第三段解析出译文');
    eq(g1.d, '医学', '⑪b 行式第三段解析出领域标签');
    eq(T.parseGlossary('cross attention = 交叉注意力 | 计算机;AI')[0].d, '计算机;ai',
      '⑪b 多标签领域（; 分隔、归一化为小写）');
    eq(T.parseGlossary('a | b = c')[0].d, '', '⑪b 正文里的 | 不被误当域分隔符（护栏生效）');
    eq(T.parseGlossary('[{"s":"a","t":"b","d":"医学"}]')[0].d, '医学', '⑪b JSON {s,t,d} 解析领域');
    eq(T.parseGlossary('[["a","b","计算机"]]')[0].d, '计算机', '⑪b 三元数组第三位 = 领域');
    eq(T.parseGlossary('plain = 普通')[0].d, '', '⑪b 无标注行 → 通用域（d 为空串）');
  }

  // ---- glossary() 域过滤（pref translateGlossaryDomains；通用术语永不被滤） ----
  {
    Prefs.set('translateGlossary',
      'transformer = Transformer\nalpha = 甲 | 医学\nbeta = 乙 | 计算机\n通用词 = 通用译');
    eq(T.glossaryAll().length, 4, '⑪b glossaryAll() 返回全量（不受域过滤影响）');
    eq(T.glossary().length, 4, '⑪b 未配置启用域（空白名单）→ 全部启用');
    eq(T.glossaryDomains().join(','), '医学,计算机', '⑪b glossaryDomains() 列出全部领域（排序去重）');
    Prefs.set('translateGlossaryDomains', '医学');
    eq(T.glossary().length, 3, '⑪b 只启用医学域 → 医学条目 + 通用条目');
    ok(T.glossary().some((g) => g.s === 'alpha'), '⑪b 启用域的条目在过滤结果里');
    ok(T.glossary().every((g) => !g.d || g.d === '医学'), '⑪b 未启用域（计算机）条目被滤掉');
    ok(T.glossary().some((g) => g.s === '通用词' && !g.d), '⑪b ★ 无领域标注的通用术语永不被滤');
    Prefs.set('translateGlossaryDomains', '医学;计算机');
    eq(T.glossary().length, 4, '⑪b 多域白名单（; 分隔）→ 两域条目都在');
    Prefs.set('translateGlossaryDomains', '不存在的域');
    eq(T.glossary().length, 2, '⑪b 白名单全未命中 → 只剩通用条目（transformer + 通用词）');
    // 指纹随「启用域」变化（域启停 = 改表 → 缓存键变 → 不吃旧缓存）
    Prefs.set('translateGlossaryDomains', '');
    const fpAll = T.glossaryFingerprint();
    Prefs.set('translateGlossaryDomains', '医学');
    const fpMed = T.glossaryFingerprint();
    ok(fpAll && fpMed && fpAll !== fpMed, '⑪b ★ 启用域变化 → 指纹变化（缓存随之失效）');
    Prefs.set('translateGlossaryDomains', '');
    Prefs.set('translateGlossary', '');
  }

  // ---- glossaryBlock(list, text)：命中术语优先（60 条上限的关键保障） ----
  {
    const list = [];
    for (let i = 0; i < 70; i++) list.push({ s: 'filler' + i, t: '填充' + i, d: '' });
    list.push({ s: 'special term', t: '特别术语', d: '' }); // 第 71 条：不带 text 会被 60 上限截掉
    eq(T.glossaryBlock(list).split('\n').length, 60, '⑪b 无待译文本 → 维持 60 条上限');
    ok(T.glossaryBlock(list).indexOf('special term') < 0, '⑪b 上限外的术语默认不注入');
    const withText = T.glossaryBlock(list, 'Here comes the special term in text.');
    ok(withText.indexOf('special term → 特别术语') >= 0, '⑪b ★ 待译文本命中的术语必进 prompt（哪怕在第 71 条）');
    eq(withText.split('\n').length, 60, '⑪b 相关性排序后总量仍守 60 上限');
    ok(withText.indexOf('special term') < withText.indexOf('filler0'),
      '⑪b ★ 命中术语排在未命中术语之前');
    eq(T.glossaryBlock(list, 'nothing matches'), list.slice(0, 60).map((g) => '- ' + g.s + ' → ' + g.t).join('\n'),
      '⑪b 零命中 → 原顺序（行为不回退）');
  }

  // ---- glossaryStats：译后一致性自检 ----
  {
    const st = T.glossaryStats([{ s: 'alpha', t: '甲', d: '' }, { s: 'beta', t: '乙', d: '' }],
      'alpha and beta appear', '只有 甲 出现');
    eq(st.total, 2, '⑪b 一致性统计只计原文命中的术语');
    eq(st.hit, 1, '⑪b 译文中出现的译法记为命中');
    eq(st.miss.join(','), 'beta', '⑪b 未出现的译法进 miss 列表');
    eq(T.glossaryStats([{ s: 'alpha', t: '甲' }], '别的文本', '随便').total, 0,
      '⑪b 原文未命中 → 不计入统计');
  }

  // ---- translate() 返回附带 glossary 一致性统计（成功路径） ----
  {
    resetHttp();
    setCfg({ active: 'llm', cache: false });
    Prefs.set('translateGlossary', 'transformer = Transformer');
    sandbox.AIClient.chat = async () => '这里没有按术语表翻译';
    let rStat = await T.translate('The transformer model.', { to: 'zh-CN' });
    ok(rStat.ok && rStat.glossary && rStat.glossary.total === 1 && rStat.glossary.hit === 0,
      '⑪b ★ 术语未按表翻译 → glossary 统计 0/1（可观测，不阻断）');
    sandbox.AIClient.chat = async () => 'Transformer 按表翻译';
    let rStat2 = await T.translate('The transformer model.', { to: 'zh-CN' });
    ok(rStat2.glossary && rStat2.glossary.hit === 1, '⑪b 术语按表翻译 → glossary 统计 1/1');
    sandbox.AIClient.chat = async () => 'LLM 译文';
    Prefs.set('translateGlossary', '');
    resetHttp();
  }

  // ---- 域过滤端到端：llm prompt 只含启用域术语 ----
  {
    resetHttp();
    setCfg({ active: 'llm', cache: false });
    Prefs.set('translateGlossary', 'alpha = 甲 | 医学\ncommon = 通用译');
    Prefs.set('translateGlossaryDomains', '计算机');
    let captured = null;
    sandbox.AIClient.chat = async (msgs) => { captured = msgs; return 'ok'; };
    await T.translate('alpha and common here.', { to: 'zh-CN' });
    ok(captured && captured[1].content.indexOf('alpha → 甲') < 0,
      '⑪b ★ 未启用域的术语不进 prompt');
    ok(captured && captured[1].content.indexOf('common → 通用译') >= 0,
      '⑪b 通用术语不受域过滤影响');
    Prefs.set('translateGlossaryDomains', '医学');
    await T.translate('alpha and common here.', { to: 'zh-CN', noCache: true });
    ok(captured && captured[1].content.indexOf('alpha → 甲') >= 0,
      '⑪b 启用域后该域术语进 prompt');
    sandbox.AIClient.chat = async () => 'LLM 译文';
    Prefs.set('translateGlossaryDomains', '');
    Prefs.set('translateGlossary', '');
    resetHttp();
  }

  /* ==================== ⑫ 术语表导入导出与领域词包（0.4x） ==================== */

  // ---- glossaryToCsv：表头 + 转义 ----
  {
    const csv = T.glossaryToCsv([
      { s: 'alpha', t: '甲', d: '医学' },
      { s: 'a,b "x"', t: '含逗号', d: '' },
    ]);
    eq(csv.split('\n')[0], 'source,target,domain', '⑫ CSV 表头三列');
    eq(csv.split('\n')[1], 'alpha,甲,医学', '⑫ 普通行原样输出（含领域列）');
    eq(csv.split('\n')[2], '"a,b ""x""",含逗号,', '⑫ 含逗号/引号的术语按 CSV 规则转义');
    eq(T.glossaryToCsv([]), 'source,target,domain', '⑫ 空表也有表头（可再导入）');
  }

  // ---- parseGlossaryImport：四形态识别 ----
  {
    const rCsv = T.parseGlossaryImport('source,target,domain\nalpha,甲,医学\nbeta,乙,计算机\n');
    eq(rCsv.format, 'csv', '⑫ 带表头 CSV 识别');
    eq(rCsv.list.length, 2, '⑫ 表头行不计入术语');
    eq(rCsv.list[0].d, '医学', '⑫ 表头 CSV 解析出领域列');

    const rEecs = T.parseGlossaryImport('en,zh_CN,pos,description\ntransformer,变压器,n,a device\n');
    eq(rEecs.list.length, 1, '⑫ EECS-Terminology 式表头（en,zh_CN,pos,description）可导入');
    eq(rEecs.list[0].t, '变压器', '⑫ en→zh_CN 列正确对应');
    eq(rEecs.list[0].d, '', '⑫ 多余列（pos/description）自动忽略、不误当领域');

    const rTsv = T.parseGlossaryImport('source\ttarget\tdomain\nalpha\t甲\t医学\n');
    eq(rTsv.format, 'tsv', '⑫ TSV（TAB 分隔）识别');
    eq(rTsv.list[0].d, '医学', '⑫ TSV 解析出领域');

    const rBare = T.parseGlossaryImport('alpha,甲,医学\nbeta,乙,计算机\n');
    eq(rBare.format, 'csv-bare', '⑫ 裸三列 CSV（无表头）识别');
    eq(rBare.list.length, 2, '⑫ 裸 CSV 每行一条');
    eq(rBare.list[0].d, '医学', '⑫ 裸 CSV 第三列当领域');

    const rBare2 = T.parseGlossaryImport('alpha\t甲\n');
    eq(rBare2.list.length, 1, '⑫ 裸两列 TSV（等价 TAB 行式）可导入');
    eq(rBare2.list[0].t, '甲', '⑫ 两列取 s/t');

    const rJson = T.parseGlossaryImport('[{"s":"a","t":"b","d":"医学"}]');
    eq(rJson.format, 'json', '⑫ JSON 数组识别');
    eq(rJson.list[0].d, '医学', '⑫ JSON 导入保留领域');

    const rLines = T.parseGlossaryImport('# 注释\nalpha = 甲 | 医学\nbeta => 乙\n');
    eq(rLines.format, 'lines', '⑫ 行式（本插件原生格式）识别');
    eq(rLines.list.length, 2, '⑫ 行式导入逐条解析');
    eq(rLines.list[0].d, '医学', '⑫ 行式导入保留领域标注');

    eq(T.parseGlossaryImport('').list.length, 0, '⑫ 空输入 → 空列表');
    eq(T.parseGlossaryImport('\uFEFFalpha,甲\n').list.length, 1, '⑫ BOM 头自动剥除（Excel 导出的 CSV）');

    // 往返一致：导出 → 导入 → 同一术语表
    const rt = T.parseGlossaryImport(T.glossaryToCsv([
      { s: 'alpha', t: '甲', d: '医学' }, { s: 'beta', t: '乙', d: '' },
    ]));
    eq(rt.list.length, 2, '⑫ 导出→导入 往返保条数');
    eq(rt.list[0].d, '医学', '⑫ 导出→导入 领域不丢');
    eq(rt.list[1].d, '', '⑫ 导出→导入 通用域保持为空');
  }

  // ---- mergeGlossary：行级 upsert（注释保留 / 同 s 更新 / 新增追加） ----
  {
    const cur = '# 我的术语表\nalpha = 旧译 | 医学\nkeep = 保留\n';
    const m = T.mergeGlossary(cur, [
      { s: 'alpha', t: '新译', d: '医学' },
      { s: 'new term', t: '新术语', d: '计算机' },
      { s: 'same', t: 'same' }, // 无效条目（s===t）→ 跳过
    ]);
    eq(m.added, 1, '⑫ 合并统计：新增 1 条');
    eq(m.updated, 1, '⑫ 合并统计：更新 1 条');
    ok(m.raw.indexOf('# 我的术语表') >= 0, '⑫ ★ 注释行原样保留（不重建丢注释）');
    ok(m.raw.indexOf('keep = 保留') >= 0, '⑫ 无关行原样保留');
    ok(m.raw.indexOf('alpha = 新译 | 医学') >= 0, '⑫ 同原文 → 新译法覆盖旧行');
    ok(m.raw.indexOf('new term = 新术语 | 计算机') >= 0, '⑫ 新条目追加（带领域标注）');
    ok(m.raw.indexOf('旧译') < 0, '⑫ 旧译法被替换（不残留双份）');
    // JSON 形态输入保 JSON
    const mj = T.mergeGlossary('[{"s":"a","t":"b"}]', [{ s: 'a', t: 'c' }, { s: 'x', t: 'y', d: '法律' }]);
    eq(mj.added, 1, '⑫ JSON 形态合并：新增计数正确');
    eq(mj.updated, 1, '⑫ JSON 形态合并：更新计数正确');
    const parsedJ = T.parseGlossary(mj.raw);
    eq(parsedJ.length, 2, '⑫ JSON 输入 → JSON 输出（可再解析）');
    ok(mj.raw.charAt(0) === '[', '⑫ JSON 形态不转行式（程序化写入形态保真）');
  }

  // ---- 内置领域词包：结构完整、可合并 ----
  {
    vm.runInContext(fs.readFileSync(
      path.join(ROOT, 'chrome', 'content', 'scripts', 'ai', 'glossary-packs.js'), 'utf8'),
      sandbox, { filename: 'glossary-packs.js' });
    const GP = sandbox.GlossaryPacks;
    ok(!!GP && typeof GP.list === 'function' && typeof GP.get === 'function', '⑫ 词包模块导出 list/get');
    const packs = GP.list();
    ok(packs.length >= 4, '⑫ 内置 ≥4 个领域词包', packs.map((p) => p.id));
    ok(packs.some((p) => p.id === 'cs-ai') && packs.some((p) => p.id === 'med')
      && packs.some((p) => p.id === 'fin') && packs.some((p) => p.id === 'law'),
      '⑫ 覆盖 计算机/医学/金融/法律 四大领域');
    for (const p of packs) {
      const full = GP.get(p.id);
      ok(full.terms.length >= 15, '⑫ 词包「' + p.label + '」条数 ≥15', full.terms.length);
      ok(full.terms.every((g) => g.s && g.t && g.s !== g.t && g.d),
        '⑫ 词包「' + p.label + '」每条都有 s/t 且带领域标签');
    }
    // 词包 → 合并进空表 → 导出可往返
    const mp = T.mergeGlossary('', GP.get('cs-ai').terms);
    eq(mp.added, GP.get('cs-ai').terms.length, '⑫ 词包合入空表 = 全新增');
    const back = T.parseGlossaryImport(T.glossaryToCsv(T.parseGlossary(mp.raw)));
    eq(back.list.length, GP.get('cs-ai').terms.length, '⑫ 词包数据 导出→导入 往返无损');
    ok(T.parseGlossary(mp.raw).every((g) => g.d === '计算机'), '⑫ 词包术语带统一领域标签');
  }

  /* ==================== ⑫c 在线词包目录（open-termbank 同步协议） ==================== */
  {
    // 桩环境里 GlossaryPacks 已在 ⑫ 节加载；此处测 fetchCatalog / fetchDomain / 基址回退
    const GP = sandbox.GlossaryPacks;
    ok(typeof GP.fetchCatalog === 'function' && typeof GP.fetchDomain === 'function',
      '⑫c 在线目录模块导出 fetchCatalog/fetchDomain');

    const IDX = {
      version: '1.0.0', total: 40,
      domains: [
        { domain: '医学', slug: 'medicine', file: 'medicine.csv', count: 20, sha256: 'a'.repeat(64) },
        { domain: '计算机', slug: 'computer-science', file: 'computer-science.csv', count: 20, sha256: 'b'.repeat(64) },
      ],
    };
    const CSV = 'source,target,domain\nmyocardial infarction,心肌梗死,医学\n';

    // ① jsDelivr 正常命中
    resetHttp();
    plan('cdn.jsdelivr.net', { text: JSON.stringify(IDX) });
    let cat = await GP.fetchCatalog();
    ok(cat.ok && cat.index.domains.length === 2 && cat.index.total === 40,
      '⑫c fetchCatalog 解析 index.json（域数/条数）');
    ok(cat.via.indexOf('jsdelivr') >= 0, '⑫c 正常时走 jsDelivr 基址');

    // ② jsDelivr 挂了 → 回退 raw
    resetHttpOnly();
    plan('cdn.jsdelivr.net', { fail: 'CDN 不可达' });
    plan('raw.githubusercontent.com', { text: JSON.stringify(IDX) });
    cat = await GP.fetchCatalog();
    ok(cat.ok && cat.via.indexOf('raw.githubusercontent') >= 0,
      '⑫c ★ jsDelivr 失败自动回退 raw 直链');
    eq(httpCalls.filter((c) => c.url.indexOf('raw.githubusercontent') >= 0).length, 1,
      '⑫c 回退只打一次 raw 请求');

    // ③ 全部不可达 → ok:false（面板据此静默降级）
    resetHttpOnly();
    plan('cdn.jsdelivr.net', { fail: 'down' });
    plan('raw.githubusercontent.com', { fail: 'down' });
    cat = await GP.fetchCatalog();
    ok(!cat.ok && cat.error, '⑫c 全部基址失败 → {ok:false, error}（不抛异常）');

    // ④ 坏 JSON / 结构异常 → 同样 ok:false
    resetHttpOnly();
    plan('cdn.jsdelivr.net', { text: 'not json {' });
    plan('raw.githubusercontent.com', { fail: 'down' });
    cat = await GP.fetchCatalog();
    ok(!cat.ok, '⑫c 非法 index.json → ok:false（不炸面板）');
    resetHttpOnly();
    plan('cdn.jsdelivr.net', { text: '{"version":"1","domains":[{"slug":"x"}]}' });
    plan('raw.githubusercontent.com', { fail: 'down' });
    cat = await GP.fetchCatalog();
    ok(!cat.ok, '⑫c 目录条目缺 sha256 等字段被校验拦下（继续回退 raw，最终 ok:false）');
    ok(httpCalls.some((c) => c.url.indexOf('cdn.jsdelivr.net') >= 0), '⑫c 校验失败的那次请求确实发生过');

    // ⑤ 自定义镜像基址（pref translateGlossaryPackBase）优先于内置基址
    Prefs.set('translateGlossaryPackBase', 'http://127.0.0.1:8765/mirror');
    eq(GP.onlineBases()[0], 'http://127.0.0.1:8765/mirror/', '⑫c 自定义基址补齐尾部斜杠并置顶');
    resetHttp();
    plan('127.0.0.1:8765', { text: JSON.stringify(IDX) });
    cat = await GP.fetchCatalog();
    ok(cat.ok && cat.via.indexOf('http://127.0.0.1:8765') === 0, '⑫c ★ 自定义镜像（被墙网络的逃生门）优先生效');
    Prefs.set('translateGlossaryPackBase', '');
    eq(GP.onlineBases().length, 2, '⑫c 清空自定义基址 → 回到内置两基址');

    // ⑥ fetchDomain：按 slug 拉 CSV（优先复用目录基址）
    resetHttp();
    plan('cdn.jsdelivr.net', { text: JSON.stringify(IDX) });
    plan('raw.githubusercontent.com', { text: CSV });
    let dom1 = await GP.fetchDomain('medicine', 'https://cdn.jsdelivr.net/gh/yebuqiu/open-termbank@main/data/');
    ok(dom1.ok && dom1.text.indexOf('myocardial infarction') >= 0, '⑫c fetchDomain 拉到 CSV 文本');
    ok(httpCalls.some((c) => c.url.indexOf('medicine.csv') >= 0), '⑫c 域文件 URL 按 slug 拼装');
    // 目录基址挂了 → 回退其它基址
    resetHttpOnly();
    plan('cdn.jsdelivr.net', { fail: 'down' });
    plan('raw.githubusercontent.com', { text: CSV });
    dom1 = await GP.fetchDomain('medicine', 'https://cdn.jsdelivr.net/gh/yebuqiu/open-termbank@main/data/');
    ok(dom1.ok && dom1.via.indexOf('raw.githubusercontent') >= 0, '⑫c 域下载同样有基址回退');

    // ⑦ index.json 请求带缓存击穿参数（jsDelivr @main 有长缓存，否则「有更新」检测滞后）
    resetHttp();
    plan('cdn.jsdelivr.net', { text: JSON.stringify(IDX) });
    await GP.fetchCatalog();
    ok(httpCalls.some((c) => /index\.json\?_=\d+/.test(c.url)), '⑫c index.json 带时间戳参数破 CDN 缓存');
    ok(!httpCalls.some((c) => /medicine\.csv\?/.test(c.url)), '⑫c 域 CSV 不带参数（内容寻址，吃缓存是好事）');
    resetHttp();
  }

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('-'.repeat(60));
  }
  console.log('翻译引擎测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
})();
