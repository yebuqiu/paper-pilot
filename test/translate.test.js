#!/usr/bin/env node
/* PaperPilot 多引擎翻译 测试（插件 0.28.0）
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
  PREFIX: 'extensions.zotero.paperpilot.',
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};

// HTTP 计划：数组，每项 {match(urlSub), res(obj) | fail(msg) | failStatus(code)}
let httpPlan = [];
const httpCalls = [];
function resetHttp() { httpPlan = []; httpCalls.length = 0; }
function plan(match, outcome) { httpPlan.push({ match, outcome }); }

const Zotero = {
  locale: 'zh-CN',
  Prefs: Prefs,
  Utilities: { Internal: { md5: (s) => 'md5(' + require('crypto').createHash('md5').update(String(s), 'utf8').digest('hex') + ')' } },
  HTTP: {
    async request(method, url, opts) {
      httpCalls.push({ method, url, opts });
      const hit = httpPlan.find((p) => url.indexOf(p.match) >= 0);
      if (!hit) throw new Error('no http plan for ' + url.slice(0, 80));
      const o = hit.outcome;
      if (o.fail) throw new Error(o.fail);
      if (o.failStatus) {
        const e = new Error('HTTP ' + o.failStatus);
        e.xmlhttp = { status: o.failStatus, response: null, responseText: 'err' };
        throw e;
      }
      return { status: 200, response: o.res, responseText: o.text };
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
