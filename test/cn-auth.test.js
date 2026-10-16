#!/usr/bin/env node
/* 知网账号登录（0.43.0，CNAuth）测试 —— 全部离线、无网络、无 Zotero
 *
 * 覆盖：
 *   A. CNAuth.md5 —— RFC 1321（node crypto 对照：ASCII/中文/长串/空串）
 *   B. CNAuth.signHeaders —— createSign 复刻（参数排序/拼接/签名结构）
 *   C. obfuscate / deobfuscate —— base64 往返与空值
 *   D. parseLoginCookie / loginName 解析
 *   E. creds / saveCreds —— prefs 存取 + base64 混淆
 *   F. ensureLogin(silent) 分支 —— 未登录且无凭据时静默返回 false（不弹窗）
 *   G. SM2 vendor 库（chrome/content/scripts/vendor/sm2.js）—— node 直载 +
 *      encryptPwd 包装（'04' 前缀、hex、随机化；官方 ecpSm2Encrypt 同款调用）
 *   H. CNFetch 反爬基础 —— UA 常量 / _cnkiHeaders 合并 / _throttle 存在性
 *
 * 运行：node test/cn-auth.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const S = (p) => path.join(ROOT, 'chrome', 'content', 'scripts', p);

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 沙箱（与 cn-ai.test.js 同模式） ---------------- */

function deepProxy(name) {
  const fn = function () { return deepProxy(name + '()'); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'toString') return () => name;
      if (k === 'then') return undefined;
      return deepProxy(name + '.' + String(k));
    },
    apply() { return deepProxy(name + '()'); },
    construct() { return deepProxy('new ' + name); },
  });
}

const PrefStore = new Map();
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Date, Math, JSON,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  unescape, escape, encodeURIComponent, decodeURIComponent,
  Zotero: deepProxy('Zotero'),
  Services: deepProxy('Services'),
  IOUtils: deepProxy('IOUtils'),
  PathUtils: deepProxy('PathUtils'),
  Components: deepProxy('Components'),
  _ppDiag: () => {},
};
sandbox.Prefs = {
  PREFIX: 'extensions.zotero.paperpilot.',
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};
sandbox.I18n = { isZh: true, t: (k) => k };
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(fs.readFileSync(S(rel), 'utf8'), sandbox, { filename: rel });
}
load('features/cn-fetch.js');

const CNAuth = sandbox.CNAuth;
const CNFetch = sandbox.CNFetch;
ok(!!CNAuth, 'CNAuth 导出存在');
ok(!!CNFetch, 'CNFetch 导出存在');

/* ==================== A. md5 ==================== */

{
  const cases = ['', 'abc', 'test-pass-666', '中文密码测试',
    'a'.repeat(56), 'b'.repeat(64), 'c'.repeat(71), // 尾块边界：56/64/71
    'userName=tester01&pwd=%2704ABC%27'];
  for (const c of cases) {
    const expect = crypto.createHash('md5').update(c, 'utf8').digest('hex');
    eq(CNAuth.md5(c), expect, 'md5("' + (c.length > 12 ? c.slice(0, 12) + '…' : c) + '")');
  }
  // 跨 64 字节块的长串
  const long = 'x'.repeat(200);
  eq(CNAuth.md5(long), crypto.createHash('md5').update(long, 'utf8').digest('hex'),
    'md5 200 字节长串');
}

/* ==================== B. signHeaders（createSign 复刻） ==================== */

{
  const query = 'userName=tester01&pwd=%2704ABCDEF%27&isAutoLogin=true&p=0&verifyType=3&platform=kns&isEncry=2&fingerprint=';
  const h = CNAuth.signHeaders(query, 'CID-12345', 1697452800000);
  eq(h['appID'], 'LoginWap', 'signHeaders appID');
  eq(h.ClientID, 'CID-12345', 'signHeaders ClientID 透传');
  eq(h.timestamp, '1697452800000', 'signHeaders timestamp 字符串化');
  eq(h.nonce, Math.sin(1697452800000).toString().substr(6), 'signHeaders nonce = sin(ts).substr(6)');
  // 签名可复算（行为自洽）：参数按 key 小写排序、值 decode 后无分隔拼接
  const params = {
    userName: 'tester01', pwd: "'04ABCDEF'", isAutoLogin: 'true', p: '0',
    verifyType: '3', platform: 'kns', isEncry: '2', fingerprint: '',
  };
  const sorted = Object.keys(params).sort((a, b) => a.toLowerCase() > b.toLowerCase() ? 1 : -1);
  const sortedParams2 = sorted.map((k) => k + '=' + params[k]).join('');
  const expect = crypto.createHash('md5')
    .update(String('1697452800000' + h.nonce + CNAuth.SIGN_SECRET + sortedParams2 + 'CID-12345')
      .replace(/ /g, ''), 'utf8').digest('hex');
  eq(h.signature, expect, 'signHeaders signature 与公式一致');
  // 签名包含 decodeURIComponent 语义：%27 → '（不是原样百分号串）
  ok(!sortedParams2.includes('%27'), '签名输入用解码后的明文值');
  // clientId 为空也可工作（老会话无 Ecp_ClientId）
  const h2 = CNAuth.signHeaders(query, '', 1697452800000);
  eq(typeof h2.signature, 'string', 'signHeaders 空 clientId 可工作');
}

/* ==================== C. obfuscate / deobfuscate ==================== */

{
  eq(CNAuth.obfuscate('test-pass-666'), Buffer.from('test-pass-666', 'binary').toString('base64'),
    'obfuscate = base64');
  eq(CNAuth.deobfuscate(CNAuth.obfuscate('test-pass-666')), 'test-pass-666', '往返一致');
  eq(CNAuth.deobfuscate(CNAuth.obfuscate('密码 with 中文')), '密码 with 中文',
    '中文往返（unescape/escape 路径）');
  eq(CNAuth.obfuscate(''), '', '空密码 → 空');
  eq(CNAuth.deobfuscate('!!!not-base64!!!'), '', '坏 base64 安全回落');
  ok(CNAuth.obfuscate('secret') !== 'secret', '混淆后不等于明文');
}

/* ==================== D. parseLoginCookie / parseLoginStatus ==================== */

{
  eq(CNAuth.parseLoginCookie('tester01,1697452800000,0'), 'tester01', 'c_m_Lin 三段值');
  eq(CNAuth.parseLoginCookie('tester01'), 'tester01', 'c_m_Lin 单段值');
  eq(CNAuth.parseLoginCookie('tester01,'), 'tester01', 'c_m_Lin 尾逗号');
  eq(CNAuth.parseLoginCookie('  tester01 ,169,0'), 'tester01', '首段带空白 trim');
  eq(CNAuth.parseLoginCookie(''), '', '空 cookie → 未登录');
  eq(CNAuth.parseLoginCookie(null), '', 'null → 未登录');
  eq(CNAuth.parseLoginCookie(',169,0'), '', '空用户名段 → 未登录');
  // parseLoginStatus（2026-10-16 真值：登录成功种 Ecp_LoginStuts JSON cookie）
  eq(CNAuth.parseLoginStatus('{"IsAutoLogin":true,"UserName":"tester01","ShowName":"测试机构附属医院","UserType":"bk"}'),
    'tester01', 'Ecp_LoginStuts JSON → 用户名');
  eq(CNAuth.parseLoginStatus(''), '', '空状态 → 未登录');
  eq(CNAuth.parseLoginStatus('broken{json'), '', '损坏 cookie → 未登录（不抛）');
  eq(CNAuth.parseLoginStatus('{"IsAutoLogin":true,"UserType":"bk"}'), '',
    'JSON 无 UserName → 未登录');
  ok(String(CNAuth.parseLoginStatus).length > 0, 'parseLoginStatus 存在');
}

/* ==================== E. creds / saveCreds ==================== */

{
  ok(CNAuth.creds() === null, '无凭据时 creds() = null');
  CNAuth.saveCreds('tester01', 'test-pass-666');
  const c = CNAuth.creds();
  ok(c && c.u === 'tester01' && c.p === 'test-pass-666', 'saveCreds 后 creds() 往返一致');
  // prefs 里存的必须是混淆值（不是明文密码）
  eq(PrefStore.get('cnkiPassword'), CNAuth.obfuscate('test-pass-666'),
    'prefs 存 base64 混淆值');
  ok(PrefStore.get('cnkiPassword') !== 'test-pass-666', 'prefs 不存明文密码');
  eq(PrefStore.get('cnkiUsername'), 'tester01', 'prefs 存用户名');
  // 半凭据（只用户名）→ null
  PrefStore.set('cnkiUsername', 'tester01');
  PrefStore.set('cnkiPassword', '');
  ok(CNAuth.creds() === null, '只有用户名无密码 → null');
  CNAuth.saveCreds('tester01', 'test-pass-666'); // 还原，供 F 用
}

/* ==================== F. ensureLogin(silent) 分支 ==================== */

async function testF() {
  PrefStore.set('cnkiUsername', '');
  PrefStore.set('cnkiPassword', '');
  let threw = false, ret = null;
  try { ret = await CNAuth.ensureLogin({ silent: true }); }
  catch (e) { threw = true; }
  // creds() === null → 直接 return false（不触网不弹窗）
  eq(ret, false, 'ensureLogin(silent) 无凭据 → false');
  eq(threw, false, 'ensureLogin(silent) 不抛异常');
  // 有凭据但 _cookie 走 deepProxy（沙箱里 Services.cookies 是 proxy）→
  // isLoggedIn() 实际不可靠；此路径会进 loginSilent 触网——离线不测，
  // 由真机验证覆盖。这里只验证 silent 模式绝不弹窗：loginInteractive 不应被调用。
  let interactiveCalled = false;
  const orig = CNAuth.loginInteractive;
  CNAuth.loginInteractive = () => { interactiveCalled = true; return false; };
  try { await CNAuth.ensureLogin({ silent: true }); } catch (e) { /* deepProxy 触网失败 */ }
  eq(interactiveCalled, false, 'silent 模式绝不弹交互登录');
  CNAuth.loginInteractive = orig;
}

/* ==================== G. SM2 vendor 库 + encryptPwd ==================== */

{
  // node 直载 vendor（UMD 走 module.exports 分支）
  const sm2 = require(path.join(ROOT, 'chrome', 'content', 'scripts', 'vendor', 'sm2.js'));
  ok(!!sm2 && typeof sm2.doEncrypt === 'function', 'vendor sm2.doEncrypt 存在');
  ok(typeof sm2.doDecrypt === 'function', 'vendor sm2.doDecrypt 存在（库完整）');
  // 官方同款调用：'04' + doEncrypt(pwd, PUBKEY, 0)
  const enc = '04' + sm2.doEncrypt('test-pass-666', CNAuth.SM2_PUBKEY, 0);
  ok(/^[0-9a-f]+$/i.test(enc) && enc.startsWith('04'), 'SM2 密文是 04 开头的 hex');
  eq(enc.length, 220, 'SM2 密文长度 220（C1C2C3 = 194 + 2×12 明文）');
  // 随机化（每次加密不同——随机 k）
  const enc2 = '04' + sm2.doEncrypt('test-pass-666', CNAuth.SM2_PUBKEY, 0);
  ok(enc !== enc2, 'SM2 加密随机化');
  // CNAuth.encryptPwd 包装（注入 _sm2Lib 走包装路径）
  CNAuth._sm2Lib = sm2;
  const wrapped = CNAuth.encryptPwd('test-pass-666');
  ok(wrapped.startsWith('04') && /^[0-9a-f]+$/i.test(wrapped), 'encryptPwd 包装输出');
  eq(wrapped.length, 220, 'encryptPwd 密文长度 220');
  // 公钥本身是 04 开头的 130 hex（未压缩点）
  ok(/^04[0-9a-f]{128}$/i.test(CNAuth.SM2_PUBKEY), 'SM2 公钥是未压缩点格式');
  // UMD 无 module/exports/self 的环境（浏览器全局）也挂 sm2：vm 验证
  const scope = { module: undefined, exports: undefined, define: undefined, self: undefined };
  vm.runInContext(fs.readFileSync(S('vendor/sm2.js'), 'utf8'),
    vm.createContext(scope), { filename: 'sm2.js' });
  ok(!!scope.sm2 && typeof scope.sm2.doEncrypt === 'function',
    'vendor UMD 在 loadSubScript 式 scope 挂 sm2');
}

/* ==================== H. CNFetch 反爬基础 ==================== */

{
  eq(CNFetch.UA, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'CNFetch.UA 桌面 UA');
  eq(CNFetch.MIN_INTERVAL_MS, 3000, 'kns 限速 3s（对齐 ref-sources 口径）');
  const h = CNFetch._cnkiHeaders({ Referer: 'https://kns.cnki.net/kns8s/' });
  eq(h['User-Agent'], CNFetch.UA, '_cnkiHeaders 默认带 UA');
  eq(h.Referer, 'https://kns.cnki.net/kns8s/', '_cnkiHeaders 透传额外头');
  const h2 = CNFetch._cnkiHeaders({ 'User-Agent': 'custom' });
  eq(h2['User-Agent'], 'custom', '_cnkiHeaders 允许覆盖');
  eq(typeof CNFetch._throttle, 'function', '_throttle 存在');
  // 源码守卫：CNKI 请求点都带 UA 与限速（PubScholar 是公益平台、不限速）
  const src = fs.readFileSync(S('features/cn-fetch.js'), 'utf8');
  const reqSites = src.split('Zotero.HTTP.request').length - 1;
  const throttled = (src.split('await this._throttle()').length - 1) +
    (src.split('await CNFetch._throttle()').length - 1);
  ok(throttled >= reqSites - 2,
    '知网请求点基本都过 _throttle（req=' + reqSites + ' throttle=' + throttled +
    '；PubScholar 的请求不需要）');
  ok(src.includes('CNAuth.ensureLogin({ silent: true })'), '抓取链路接入 CNAuth 静默登录');
}

/* ==================== I. IP 登录（0.43.1 校园网通道） ==================== */

{
  eq(CNAuth.IP_LOGIN_API,
    'https://login.cnki.net/TopLoginCore/api/LoginApi/IpLoginPo', 'IpLoginPo 端点');
  eq(typeof CNAuth.ipLogin, 'function', 'ipLogin 存在');
  eq(typeof CNAuth.detectAccess, 'function', 'detectAccess 存在');
  eq(typeof CNAuth.loginFromPanel, 'function', 'loginFromPanel（面板登录）存在');
  // 签名参数与 SubmitCheck2 同款：isAutoLogin/isForceLogin/p/verifyType
  const q = 'isAutoLogin=true&isForceLogin=false&p=0&verifyType=3';
  const h = CNAuth.signHeaders(q, 'CID-X', 1697452800000);
  eq(h['appID'], 'LoginWap', 'IP 登录签名头同款');
  // 节流字段存在（ensureLogin 每 30 分钟最多试一次 IP 登录）
  eq(CNAuth._ipCheckedAt, 0, 'IP 探测节流字段初始 0');
  // 源码守卫：ensureLogin 里 IP 登录排在账号静默登录之前
  const src = fs.readFileSync(S('features/cn-fetch.js'), 'utf8');
  const iIp = src.indexOf('await this.ipLogin()');
  const iSilent = src.indexOf('await this.loginSilent(c.u, c.p)');
  ok(iIp > 0 && iSilent > 0 && iIp < iSilent,
    'ensureLogin 优先级：IP 登录 → 账号静默（校园网零配置优先）');
  // 面板卡片守卫
  const px = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'prefs.xhtml'), 'utf8');
  ok(px.includes('data-fold="cnki"') && px.includes('pp-cnki-login-btn'),
    '设置面板有知网账号卡片');
  const pj = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'prefs-cnki.js'), 'utf8');
  ok(pj.includes('detectAccess') && pj.includes('loginFromPanel'), '面板脚本接线');
  // 菜单瘦身守卫
  const menus = fs.readFileSync(S('menus.js'), 'utf8');
  ok(!menus.includes('"menuCNLogin"') && !menus.includes('"menuCNVerify"'),
    '右键/工具菜单已撤登录与验证入口');
}

/* ---------------- 结果 ---------------- */
async function main() {
  await testF();
  console.log('\n' + (fails.length
    ? 'FAIL ' + fails.length + '/' + (pass + fails.length) + ':\n - ' + fails.join('\n - ')
    : 'OK ' + pass + ' assertions passed (cn-auth)'));
  process.exit(fails.length ? 1 : 0);
}
main();
