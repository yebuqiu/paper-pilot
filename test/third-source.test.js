#!/usr/bin/env node
/* 第三方文献源（实验性 · Pro 试用）测试（0.44.0 草案）
 * 覆盖：站点清单 / URL 纯函数、凭据混淆往返、登录响应解析、cookie 判定、
 *       Pro 门控矩阵（含「判定不出时放行」纪律）、面板 id 接线与三端装配静态检查。
 * 运行：node test/third-source.test.js（无网络、无 DOM）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

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

/* ---------------- 沙箱 ---------------- */

const PrefStore = new Map();
const prefsStub = {
  get(k) { return PrefStore.has(k) ? PrefStore.get(k) : undefined; },
  set(k, v) { PrefStore.set(k, v); },
};
const ZoteroStub = new Proxy(deepProxy('Zotero'), {
  get(t, k) {
    if (k === 'Prefs') return prefsStub;
    if (k === 'locale') return 'zh-CN';
    return deepProxy('Zotero.' + String(k));
  },
});
let cookieList = [];
const ServicesStub = {
  cookies: {
    getCookiesFromHost() {
      return {
        hasMoreElements: () => cookieList.length > 0,
        getNext: () => cookieList.shift(),
      };
    },
  },
};
const sandbox = {
  console, Zotero: ZoteroStub, Services: ServicesStub,
  setTimeout, clearTimeout, Promise, Date, Math, JSON,
  btoa, atob, unescape, escape, encodeURIComponent, decodeURIComponent,
};
vm.createContext(sandbox);
for (const f of ['core/utils.js', 'features/third-source.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/content/scripts', f), 'utf8'),
    sandbox, { filename: f });
}
const runTS = (expr) => vm.runInContext(expr, sandbox);

const TS = runTS('ThirdSource');
ok(!!TS, '① ThirdSource 模块已加载');
eq(runTS('ThirdSource.SITES.length'), 2, '① 站点清单 2 个（文献虫 / 毕业助手）');

/* ---------------- 纯函数 ---------------- */

eq(runTS('ThirdSource.hostOf("http://b.r88r.top/e/x")'), 'b.r88r.top', '② hostOf 提取主机名');
eq(runTS('ThirdSource.hostOf("https://WWW.060193.top/")'), 'www.060193.top', '② hostOf 小写化');
eq(runTS('ThirdSource.listUrl(ThirdSource.site("wenxianchong"), "en")'),
  'http://b.r88r.top/e/action/ListInfo/?classid=63', '② 英文库列表 URL');
eq(runTS('ThirdSource.listUrl(ThirdSource.site("wenxianchong"), "bogus")'),
  'http://b.r88r.top/e/action/ListInfo/?classid=61', '② 未知 key 回退到第一列表');
eq(runTS('ThirdSource.listUrl(ThirdSource.site("biyezhushou"), "cn")'),
  'http://www.060193.top/e/action/ListInfo/?classid=61', '② 毕业助手中文库 URL');

eq(runTS('ThirdSource.deobfuscate(ThirdSource.obfuscate("卡号abc 123"))'),
  '卡号abc 123', '② 凭据混淆往返（含中文/空格）');
ok(runTS('ThirdSource.obfuscate("968200")') !== '968200', '② 混淆后不等于原文（仅防随手翻看）');

/* ---------------- 登录响应解析 ---------------- */

eq(runTS('ThirdSource.parseLoginResult("<b>登录成功!</b>").code'), 'ok', '③ 登录成功 → ok');
eq(runTS('ThirdSource.parseLoginResult("同一帐号同一时刻只能一人在线!").code'), 'busy',
  '③ 单会话被占 → busy（实测话术）');
eq(runTS('ThirdSource.parseLoginResult("密码错误").code'), 'bad-credentials', '③ 密码错误');
eq(runTS('ThirdSource.parseLoginResult("随便什么").code'), 'unknown', '③ 未知响应 → unknown');
ok(runTS('ThirdSource.loginMsg("busy", true)').indexOf('单会话') >= 0, '③ busy 文案提到单会话限制');

/* ---------------- cookie 判定 ---------------- */

eq(runTS('ThirdSource.pickCookieUser([{name:"noiojmlauth",value:"a"},{name:"noiojmlusername",value:"u1"}], "noiojml")'),
  'u1', '④ 会话 cookie → 用户名');
eq(runTS('ThirdSource.pickCookieUser([{name:"noiojmlusername",value:"u1"}], "noiojml")'),
  '', '④ 无 auth 即视为未登录');
eq(runTS('ThirdSource.pickCookieUser([{name:"fmdqbmlauth",value:"a"}], "fmdqbml")'),
  '已登录', '④ 有 auth 无用户名 → 已登录占位');
{
  cookieList = [{ name: 'fmdqbmlauth', value: 'a' }, { name: 'fmdqbmlusername', value: 'u9' }];
  eq(runTS('JSON.stringify(ThirdSource.session(ThirdSource.site("biyezhushou")))'),
    '{"username":"u9"}', '④ session() 走 cookie 服务（共享罐）');
  cookieList = [{ name: 'fmdqbmlusername', value: 'u9' }];
  eq(runTS('ThirdSource.session(ThirdSource.site("biyezhushou"))'), null, '④ 无 auth → null');
}

/* ---------------- 凭据存取（pref 往返） ---------------- */

eq(runTS('(function(){ ThirdSource.saveCreds("55977251118","968200"); var c=ThirdSource.creds(); return c && c.u; })()'),
  '55977251118', '⑤ saveCreds → creds 用户名');
eq(runTS('ThirdSource.creds().p'), '968200', '⑤ 密码往返正确');
ok(PrefStore.has('extensions.zotero.paperpilot.thirdSourceUsername')
  && PrefStore.get('extensions.zotero.paperpilot.thirdSourcePassword') !== '',
  '⑤ 写入的 pref 键为 PREFIX + thirdSource*');
eq(runTS('ThirdSource.clearCreds() && ThirdSource.creds()'), null, '⑤ clearCreds 后为空');

/* ---------------- Pro 门控矩阵 ---------------- */

function setAccount(cfg) {
  sandbox.__accCfg = cfg;
  vm.runInContext(
    'Account = (__accCfg === null) ? undefined : {' +
    ' isLoggedIn: () => __accCfg.loggedIn !== false,' +
    ' isPro: () => { if (__accCfg.throwInIsPro) { throw new Error("boom"); } return !!__accCfg.pro; },' +
    ' membership: () => __accCfg.membership || null };',
    sandbox);
}

setAccount(null);
eq(runTS('ThirdSource.proGate()').reason, 'no-module', '⑥ 账号模块缺失 → 放行（纪律）');
setAccount({ loggedIn: false });
eq(runTS('ThirdSource.proGate().ok'), false, '⑥ 未登录 → 拦截');
eq(runTS('ThirdSource.proGate()').reason, 'not-logged-in', '⑥ 未登录原因可读');
setAccount({ loggedIn: true, pro: true });
eq(runTS('ThirdSource.proGate()').reason, 'pro', '⑥ Pro → 放行');
setAccount({ loggedIn: true, pro: false, membership: null });
eq(runTS('ThirdSource.proGate().reason'), 'unknown-allow', '⑥ 会员信息未知 → 放行（不锁用户）');
setAccount({ loggedIn: true, pro: false, membership: { plan: 'Free' } });
eq(runTS('ThirdSource.proGate().ok'), false, '⑥ 明确 Free → 拦截');
eq(runTS('ThirdSource.proGate()').reason, 'need-pro', '⑥ 拦截原因 = need-pro');
setAccount({ loggedIn: true, throwInIsPro: true });
eq(runTS('ThirdSource.proGate()').reason, 'error-allow', '⑥ 判定抛错 → 放行（纪律）');
ok(runTS('ThirdSource.gateMessage({ok:false,reason:"need-pro"})').indexOf('Pro') >= 0,
  '⑥ 拦截文案提到 Pro');
setAccount({ loggedIn: true, pro: true });

/* ---------------- 权限解析（实机验证后补；A/B 两套皮肤） ---------------- */

{
  const aHtml = '<div class="user_qxspan"><span>中文数据库 长期不限时</span>'
    + '<span>医学数据库 长期不限时</span><span>英文数据库 长期不限时</span></div>';
  eq(runTS('JSON.stringify(ThirdSource.parseEntitlements(' + JSON.stringify(aHtml) + '))'),
    JSON.stringify(["中文数据库 长期不限时", "医学数据库 长期不限时", "英文数据库 长期不限时"]),
    '⑧ 文献虫皮肤：三库权限解析');
  const bHtml = "<li class='on'><a href='#'><p class='my_quanxian_t1'>英文数据库</p>"
    + "<p class='my_quanxian_t2'>长期不限时</p></a></li><li class='on'><a href='#'>"
    + "<p class='my_quanxian_t1'>中文数据库</p><p class='my_quanxian_t2'>长期不限时</p></a></li>";
  eq(runTS('JSON.stringify(ThirdSource.parseEntitlements(' + JSON.stringify(bHtml) + '))'),
    JSON.stringify(["英文数据库 长期不限时", "中文数据库 长期不限时"]),
    '⑧ 毕业助手皮肤：两库权限解析');
  eq(runTS('ThirdSource.parseEntitlements("")').length, 0, '⑧ 空页面 → 空列表');
}

/* ---------------- 上次测试记录 / 权限缓存（pref 往返） ---------------- */

{
  runTS('Prefs.set("thirdSourceLastTest", JSON.stringify({at:1790000000000,ok:true,code:"ok",site:"wenxianchong",username:"u1"}))');
  eq(runTS('ThirdSource.readLastTest().code'), 'ok', '⑨ readLastTest 读出记录');
  eq(runTS('ThirdSource.readLastTest().username'), 'u1', '⑨ 记录含用户名');
  runTS('Prefs.set("thirdSourceLastTest", "")');
  eq(runTS('ThirdSource.readLastTest()'), null, '⑨ 空记录 → null');
  runTS('Prefs.set("thirdSourceEntitlements", JSON.stringify(["中文数据库 长期不限时"]))');
  eq(runTS('ThirdSource.cachedEntitlements()[0]'), '中文数据库 长期不限时', '⑨ 权限缓存读出');
}

/* ---------------- 静态接线（三端一致性） ---------------- */

const mainjs = fs.readFileSync(path.join(ROOT, 'chrome/content/scripts/main.js'), 'utf8');
const xhtml = fs.readFileSync(path.join(ROOT, 'chrome/content/prefs.xhtml'), 'utf8');
const menusjs = fs.readFileSync(path.join(ROOT, 'chrome/content/scripts/menus.js'), 'utf8');
const utilsjs = fs.readFileSync(path.join(ROOT, 'chrome/content/scripts/core/utils.js'), 'utf8');
const prefsdef = fs.readFileSync(path.join(ROOT, 'prefs.js'), 'utf8');
const ptsjs = fs.readFileSync(path.join(ROOT, 'chrome/content/prefs-third-source.js'), 'utf8');

ok(mainjs.indexOf('"features/third-source.js"') >= 0, '⑦ main.js 装配清单含模块');
ok(mainjs.indexOf('this.thirdSource = ThirdSource;') >= 0, '⑦ main.js 暴露 thirdSource');
ok(mainjs.indexOf('"chrome/content/prefs-third-source.js"') >= 0, '⑦ 设置面板注册面板脚本');
ok(menusjs.indexOf('id: "third-source"') >= 0 && menusjs.indexOf('ThirdSource.openPortal()') >= 0,
  '⑦ 菜单注册表含 third-source → openPortal');
ok(utilsjs.indexOf('menuThirdSource:') >= 0, '⑦ I18n 含 menuThirdSource');
ok(xhtml.indexOf('data-fold="thirdsrc"') >= 0, '⑦ prefs.xhtml 含折叠卡 thirdsrc');
for (const id of ['pp-ts-enabled', 'pp-ts-site', 'pp-ts-user', 'pp-ts-pass',
  'pp-ts-login-btn', 'pp-ts-open-btn', 'pp-ts-center-btn', 'pp-ts-clear-btn', 'pp-ts-refresh-btn',
  'pp-ts-ent', 'pp-ts-gate', 'pp-ts-status', 'pp-ts-result']) {
  ok(xhtml.indexOf('id="' + id + '"') >= 0, '⑦ prefs.xhtml 含 #' + id);
}
{
  const used = new Set((ptsjs.match(/\$\("([A-Za-z0-9_-]+)"\)/g) || [])
    .map((s) => s.replace(/\$\("|"\)/g, '')));
  const missing = [...used].filter((id) => xhtml.indexOf('id="' + id + '"') < 0);
  ok(missing.length === 0, '⑦ 面板脚本引用的元素 id 都存在 → 缺失: ' + (missing.join(',') || '无'));
}
for (const k of ['thirdSourceEnabled', 'thirdSourceSite', 'thirdSourceUsername', 'thirdSourcePassword']) {
  ok(prefsdef.indexOf('paperpilot.' + k) >= 0, '⑦ prefs.js 含 ' + k + ' 默认值');
}
ok(prefsdef.indexOf('pref("extensions.zotero.paperpilot.thirdSourceEnabled", false);') >= 0,
  '⑦ 默认关闭（实验功能纪律）');
ok(runTS('typeof ThirdSource.openPortal') === 'function' && runTS('typeof ThirdSource.login') === 'function',
  '⑦ 公开动作存在（openPortal / login）');

/* ---------------- 汇总 ---------------- */

/** ⑩ 登录全链路（桩 HTTP + cookie 罐）与面板 mini-DOM 冒烟 */
async function asyncTests() {
  /* -- ⑩ 登录全链路：能识别成功并把用户名写进状态（曾经 TDZ 隐患区） -- */
  // 桩：整体替换 Zotero（deepProxy 的 set 不生效，必须换真对象）；
  // POST 登录页 → 登录成功；GET 用户中心 → A 皮肤权限页
  sandbox.Zotero = {
    locale: 'zh-CN',
    Prefs: prefsStub,
    debug: () => {},
    HTTP: {
      calls: [],
      request: async (method, url) => {
        sandbox.__httpCalls = (sandbox.__httpCalls || 0) + 1;
        if (method === 'POST') { return { status: 200, responseText: '<b>登录成功!</b>' }; }
        return { status: 200, responseText: '<div class="user_qxspan"><span>中文数据库 长期不限时</span>'
          + '<span>医学数据库 长期不限时</span><span>英文数据库 长期不限时</span></div>' };
      },
    },
  };
  cookieList = [
    { name: 'noiojmlauth', value: 'a' }, { name: 'noiojmlusername', value: 'u123' },
  ];
  const loginR = await runTS('ThirdSource.login("u123", "p456")');
  eq(loginR.ok, true, '⑩ login 成功路径返回 ok');
  eq(loginR.username, 'u123', '⑩ 用户名从 cookie 罐读出');
  eq(runTS('ThirdSource.readLastTest().code'), 'ok', '⑩ 上次测试记录已写入');
  eq(runTS('ThirdSource.cachedEntitlements().length'), 3, '⑩ 登录成功自动拉取并缓存三库权限');

  /* -- ⑪ 面板 mini-DOM 冒烟：真跑 prefs-third-source.js -- */
  // 迷你 DOM（足够面板脚本使用：getElementById/createElementNS/事件/属性）
  class PEl {
    constructor(tag) {
      this.tag = tag; this.children = []; this.style = {}; this._attrs = {};
      this.id = ''; this._text = ''; this.value = ''; this.checked = false;
      this.disabled = false; this.placeholder = ''; this.handlers = {};
    }
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
    fire(e, a) { for (const f of (this.handlers[e] || []).slice()) f(a || {}); }
    click() { this.fire('click'); }
    set innerHTML(v) { if (v === '') this.children = []; }
    get innerHTML() { return ''; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
  }
  const ids = {};
  for (const id of ['pp-ts-enabled', 'pp-ts-site', 'pp-ts-user', 'pp-ts-pass',
    'pp-ts-login-btn', 'pp-ts-open-btn', 'pp-ts-center-btn', 'pp-ts-clear-btn',
    'pp-ts-refresh-btn', 'pp-ts-ent', 'pp-ts-gate', 'pp-ts-status', 'pp-ts-result']) {
    ids[id] = new PEl(id.startsWith('pp-ts-site') ? 'select' : (id.endsWith('-btn') ? 'button' : 'div'));
    ids[id].id = id;
  }
  const timers = [];
  const TSStub = {
    SITES: [
      { id: 'wenxianchong', name: '文献虫', base: 'http://b.r88r.top', cookiePrefix: 'noiojml', center: '/e/member/cp/', lists: [{ key: 'cn', name: '中文库', path: '/e/action/ListInfo/?classid=61' }] },
      { id: 'biyezhushou', name: '毕业助手', base: 'http://www.060193.top', cookiePrefix: 'fmdqbml', center: '/e/member/my/', lists: [{ key: 'cn', name: '中文库', path: '/e/action/ListInfo/?classid=61' }] },
    ],
    hostOf: (b) => String(b).replace(/^https?:\/\//i, '').replace(/\/.*$/, ''),
    currentSite() { return this.SITES[0]; },
    enabled() { return false; },
    proGate() { return { ok: true, reason: 'pro' }; },
    creds() { return null; },
    status() {
      return { enabled: false, siteId: 'wenxianchong', siteName: '文献虫', configured: false,
        loggedIn: false, username: '', gate: 'pro', lastTest: null, entitlements: this._ents };
    },
    loginCalls: 0, saved: null, cleared: 0, opened: 0, centered: 0, refreshed: 0, _ents: [],
    async login(u, p) { this.loginCalls++; return { ok: true, code: 'ok', username: u }; },
    saveCreds(u, p) { this.saved = [u, p]; return true; },
    clearCreds() { this.cleared++; return true; },
    openPortal() { this.opened++; return true; },
    openCenter() { this.centered++; return true; },
    async fetchEntitlements() { this.refreshed++; this._ents = ['中文数据库 长期不限时']; return this._ents; },
    loginMsg(c, zh) { return c === 'ok' ? '✓ 登录成功，卡号有效' : 'code:' + c; },
    gateMessage() { return ''; },
    setSite() { return true; },
    setEnabled() { return true; },
  };
  const pZotero = { locale: 'zh-CN', PaperPilot: { thirdSource: TSStub, _paneID: 'paperpilot-prefs' } };
  const pSandbox = {
    Zotero: pZotero,
    document: {
      getElementById: (id) => ids[id] || null,
      createElementNS: (ns, tag) => new PEl(tag),
    },
    window: { setTimeout: (fn) => { timers.push(fn); return timers.length; } },
    setTimeout, console, Promise, Date, JSON,
  };
  vm.createContext(pSandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/content/prefs-third-source.js'), 'utf8'),
    pSandbox, { filename: 'prefs-third-source.js' });
  for (const t of timers.splice(0)) t();   // 跑掉 init 重试定时器
  eq(ids['pp-ts-site'].children.length, 2, '⑪ 站点下拉填充 2 个站点');
  eq(ids['pp-ts-site'].children[0].textContent.includes('文献虫'), true, '⑪ 首项为文献虫');
  ok(ids['pp-ts-status'].textContent.indexOf('未启用') >= 0, '⑪ 状态行显示「未启用」: ' + ids['pp-ts-status'].textContent);
  ok(ids['pp-ts-gate'].textContent.indexOf('Pro') >= 0, '⑪ 门控行显示 Pro 授权');
  ok(ids['pp-ts-ent'].textContent.indexOf('未获取') >= 0, '⑪ 权限行初始为「未获取」');

  // 点登录（u/p 已填）
  ids['pp-ts-user'].value = 'u9';
  ids['pp-ts-pass'].value = 'p9';
  ids['pp-ts-login-btn'].click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  eq(TSStub.loginCalls, 1, '⑪ 点登录触发模块 login');
  eq(TSStub.saved && TSStub.saved[0], 'u9', '⑪ 成功后保存凭据');
  ok(ids['pp-ts-result'].textContent.indexOf('成功') >= 0, '⑪ 结果行显示登录成功');
  // 点检测权限
  ids['pp-ts-refresh-btn'].click();
  await new Promise((r) => setTimeout(r, 0));
  eq(TSStub.refreshed, 1, '⑪ 点检测权限触发 fetchEntitlements');
  ok(ids['pp-ts-ent'].textContent.indexOf('中文数据库') >= 0, '⑪ 权限行更新为权限列表');
  // 点打开入口 / 用户中心 / 清除凭据
  ids['pp-ts-open-btn'].click();
  ids['pp-ts-center-btn'].click();
  ids['pp-ts-clear-btn'].click();
  eq(TSStub.opened, 1, '⑪ 打开入口触发 openPortal');
  eq(TSStub.centered, 1, '⑪ 打开用户中心触发 openCenter');
  eq(TSStub.cleared, 1, '⑪ 清除凭据触发 clearCreds');
}

(async () => {
  try {
    await asyncTests();
  } catch (e) {
    fails.push('⑩⑪ 异步测试异常: ' + (e && (e.stack || e.message) || e));
  }
  console.log('third-source: %d 通过 / %d 失败', pass, fails.length);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})();
