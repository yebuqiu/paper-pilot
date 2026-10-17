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
ok(menusjs.indexOf('id: "third-source"') >= 0 && menusjs.indexOf('ThirdSource.openSettings()') >= 0,
  '⑦ 菜单注册表含 third-source → 打开设置面板网点卡片');
ok(utilsjs.indexOf('menuThirdSource:') >= 0, '⑦ I18n 含 menuThirdSource');
ok(xhtml.indexOf('data-fold="thirdsrc"') >= 0, '⑦ prefs.xhtml 含折叠卡 thirdsrc');
for (const id of ['pp-ts-enabled', 'pp-ts-endpoints', 'pp-ts-ping-btn', 'pp-ts-query',
  'pp-ts-query-hint', 'pp-ts-gate', 'pp-ts-status', 'pp-ts-result']) {
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

  /* -- ⑫ 0.45.0：公开入口清单（分组 / 检索模板 / 检测） -- */
  const epList = JSON.parse(runTS('JSON.stringify(ThirdSource.endpoints())'));
  eq(epList.length, 27, '⑫ 内置入口 27 个（四组）');
  ok(epList.every((e) => e.id && e.name && e.group && e.url), '⑫ 每个入口都有 id/name/group/url');
  ok(epList.every((e) => e.note === undefined && e.kind === undefined),
    '⑫ 数据层不再带 note/kind 注释字段（面板只显示名称）');
  eq(new Set(epList.map((e) => e.id)).size, epList.length, '⑫ id 唯一');
  ok(epList.every((e) => /^https?:\/\//.test(e.url)), '⑫ 全部为 http(s) 直链');
  ok(epList.every((e) => !/文献虫|毕业助手/.test(e.name)), '⑫ 入口名称不含任何来源站点名');

  // 分组（顺序 + 数量）
  eq(JSON.stringify(JSON.parse(runTS('JSON.stringify(ThirdSource.grouped().map((g) => [g.id, g.items.length]))'))),
    JSON.stringify([['cn', 7], ['full', 7], ['preprint', 4], ['search', 9]]),
    '⑫ 四组数量 7/7/4/9（中文库/英文全文/预印本/学术搜索）');
  eq(runTS('ThirdSource.grouped()[0].name'), '中文库', '⑫ 组名可读（中文）');
  eq(runTS('ThirdSource.groupName("bogus")'), '', '⑫ 未知组 → 空名');
  // 兜底：漏写 group 的入口归入「其它」，不静默丢失
  runTS('ThirdSource.__bak = ThirdSource.ENDPOINTS.slice()');
  runTS('ThirdSource.ENDPOINTS.push({ id: "orphan", name: "孤儿", url: "https://x.invalid/" })');
  eq(runTS('ThirdSource.grouped().slice(-1)[0].id'), '_other', '⑫ 漏写 group → 归入「其它」组');
  eq(runTS('ThirdSource.grouped().slice(-1)[0].items[0].id'), 'orphan', '⑫ 兜底组含该入口');
  runTS('ThirdSource.ENDPOINTS = ThirdSource.__bak');

  // 检索模板（纯函数）
  eq(runTS('ThirdSource.isDoi("10.1038/nature12373")'), true, '⑫ DOI 识别');
  eq(runTS('ThirdSource.isDoi("磁性材料")'), false, '⑫ 标题不是 DOI');
  eq(runTS('ThirdSource.urlFor("scihub-ren", "10.1038/nature12373")'),
    'https://www.sci-hub.ren/10.1038%2Fnature12373', '⑫ Sci-Hub 带 DOI 直达');
  eq(runTS('ThirdSource.urlFor("scihub-ren", "磁性材料")'), 'https://www.sci-hub.ren/',
    '⑫ Sci-Hub 遇非 DOI → 回首页（避免空结果页）');
  eq(runTS('ThirdSource.urlFor("gscholar", "magnetic skyrmion")'),
    'https://scholar.google.com/scholar?q=magnetic%20skyrmion', '⑫ Google 学术带词检索');
  ok(runTS('ThirdSource.urlFor("cnki-1", "磁性材料")').indexOf('kw=%E7%A3%81%E6%80%A7%E6%9D%90%E6%96%99') > 0,
    '⑫ 知网镜像带词检索（中文编码正确）');
  eq(runTS('ThirdSource.urlFor("scmor", "x")'), 'https://ac.scmor.com/', '⑫ 无模板入口 → 首页');
  eq(runTS('ThirdSource.canSearch("scmor", "x")'), false, '⑫ 无模板 → canSearch=false');
  eq(runTS('ThirdSource.canSearch("gscholar", "")'), false, '⑫ 无检索词 → canSearch=false');
  eq(runTS('ThirdSource.urlFor("nope", "x")'), '', '⑫ 未知 id → 空串');
  ok(JSON.parse(runTS('JSON.stringify(ThirdSource.endpoints().filter((e) => !!e.q).map((e) => e.id))'))
    .length >= 8, '⑫ 至少 8 个入口支持带检索词直达');

  // openEndpoint：门控 / 启用 / 未知 id / 首开 / 带词开 / 需 DOI 六态
  runTS('Zotero.launchURL = (u) => { Zotero.__launched = (Zotero.__launched || []).concat([u]); };');
  runTS('Zotero.Utilities = { Internal: { openPreferences: () => { Zotero.__prefsOpened = (Zotero.__prefsOpened || 0) + 1; } } };');
  runTS('Prefs.set("thirdSourceEnabled", false)');
  eq(runTS('ThirdSource.openEndpoint("scihub-ren").ok'), false, '⑫ 未启用 → 不打开并引导设置');
  ok(runTS('(Zotero.__prefsOpened || 0) >= 1'), '⑫ 未启用时打开设置面板');
  runTS('Prefs.set("thirdSourceEnabled", true)');
  eq(runTS('ThirdSource.openEndpoint("nope").reason'), 'unknown', '⑫ 未知入口 id → reason=unknown');
  const openHome = runTS('ThirdSource.openEndpoint("scihub-ren")');
  eq(openHome.ok, true, '⑫ 启用后成功打开');
  eq(openHome.searched, false, '⑫ 无检索词 → 首页');
  ok(runTS('(Zotero.__launched || []).some((u) => u.indexOf("sci-hub") >= 0)'), '⑫ 打开的是 Sci-Hub 网址');
  const openQ = runTS('ThirdSource.openEndpoint("gscholar", "skyrmion")');
  eq(openQ.searched, true, '⑫ 带检索词 → 标记 searched');
  ok(runTS('(Zotero.__launched || []).slice(-1)[0]').indexOf('/scholar?q=skyrmion') > 0,
    '⑫ 实际打开的 URL 带了检索词');
  const openDoi = runTS('ThirdSource.openEndpoint("scihub-st", "磁性材料")');
  eq(openDoi.needDoi, true, '⑫ Sci-Hub 遇标题 → needDoi=true（面板据实提示）');
  eq(openDoi.searched, false, '⑫ 需要 DOI 的入口不标记 searched');

  // checkEndpoints：小并发 + 跳过 probe:false + 进度回调 + 顺序归一
  runTS('ThirdSource.MIN_INTERVAL_MS = 0');   // 测试内取消节流等待
  sandbox.Zotero.HTTP = {
    request: async (method, url) => {
      if (url.indexOf("43.143") >= 0) { throw new Error("timeout"); }
      return { status: 200, responseText: "" };
    },
  };
  runTS('Zotero.__prog = []');
  const chk = await runTS('ThirdSource.checkEndpoints((d, t) => { Zotero.__prog.push([d, t]); })');
  eq(chk.length, 21, '⑫ 只检测参与探测的 21 个入口（6 个 probe:false 跳过）');
  eq(chk.find((r) => r.id === 'cnki-1').ok, false, '⑫ 不可达入口标 ok=false');
  eq(chk.filter((r) => r.ok).length, 20, '⑫ 其余 20 个可达');
  ok(!chk.some((r) => r.id === 'gscholar' || r.id === 'pubmed'), '⑫ probe:false 入口不参与检测');
  eq(runTS('ThirdSource.readEndpointCheck().list.length'), 21, '⑫ 检测结果写入缓存 pref');
  ok(runTS('ThirdSource.readEndpointCheck().at') > 0, '⑫ 缓存带时间戳');
  eq(runTS('ThirdSource.readEndpointCheck().list[0].id'), 'cnki-1', '⑫ 结果按清单顺序归一');
  eq(JSON.parse(runTS('JSON.stringify(Zotero.__prog.slice(-1)[0])'))[0], 21, '⑫ 进度回调推到 21/21');
  eq(JSON.parse(runTS('JSON.stringify(Zotero.__prog.slice(-1)[0])'))[1], 21, '⑫ 进度回调带总数');

  /* -- ⑪ 面板 mini-DOM 冒烟：真跑 prefs-third-source.js（0.45.0 分组芯片版） -- */
  // 迷你 DOM（足够面板脚本使用：getElementById/createElementNS/事件/属性）
  class PEl {
    constructor(tag) {
      this.tag = tag; this.children = []; this.style = {}; this._attrs = {};
      this.id = ''; this._text = ''; this.value = ''; this.checked = false;
      this.disabled = false; this.placeholder = ''; this.handlers = {}; this.title = '';
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
  for (const id of ['pp-ts-enabled', 'pp-ts-endpoints', 'pp-ts-ping-btn', 'pp-ts-query',
    'pp-ts-query-hint', 'pp-ts-gate', 'pp-ts-status', 'pp-ts-result']) {
    ids[id] = new PEl(id.endsWith('-btn') ? 'button'
      : (id === 'pp-ts-endpoints' ? 'vbox' : (id === 'pp-ts-query' ? 'input' : 'div')));
    ids[id].id = id;
  }
  const timers = [];
  const TSStub = {
    ENDPOINTS: [
      { id: 'e1', name: '入口一', url: 'https://e1.invalid/', group: 'g1' },
      { id: 'e2', name: '入口二', url: 'https://e2.invalid/', group: 'g2', probe: false },
    ],
    hostOf: (b) => String(b).replace(/^https?:\/\//i, '').replace(/\/.*$/, ''),
    currentSite() { return { id: 's1', name: '站点' }; },
    enabled() { return true; },
    proGate() { return { ok: true, reason: 'pro' }; },
    gateMessage() { return ''; },
    setEnabled() { return true; },
    grouped() {
      return [
        { id: 'g1', name: '组一', items: [this.ENDPOINTS[0]] },
        { id: 'g2', name: '组二', items: [this.ENDPOINTS[1]] },
      ];
    },
    canSearch(id, q) { return !!q && id === 'e1'; },
    _check: null,
    readEndpointCheck() { return this._check; },
    openCalls: [], last: null, pinged: 0,
    openEndpoint(id, q) {
      this.openCalls.push(id); this.last = { id: id, q: q || '' };
      if (id === 'e2') { return { ok: true, name: '入口二', searched: false, needDoi: false }; }
      return { ok: true, name: '入口一', searched: !!q, needDoi: false };
    },
    async checkEndpoints(cb) {
      this.pinged++;
      if (typeof cb === 'function') { cb(1, 2); }
      this._check = { at: Date.now(), list: [{ id: 'e1', ok: true, ms: 12 }, { id: 'e2', ok: false, ms: 34 }] };
      if (typeof cb === 'function') { cb(2, 2); }
      return this._check.list;
    },
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
  eq(ids['pp-ts-enabled'].checked, true, '⑪ 启用状态回填');
  eq(ids['pp-ts-gate'].textContent.indexOf('Pro') >= 0, true, '⑪ 门控行显示 Pro 授权');
  ok(ids['pp-ts-status'].textContent.indexOf('未检测') >= 0, '⑪ 初始状态行「未检测」');
  // 分组结构：组标题 + 芯片行 交替；一个入口 = 一枚芯片（状态点 + 名称）
  const box = ids['pp-ts-endpoints'];
  eq(box.children.length, 4, '⑪ 两个分组各渲染「标题 + 芯片行」');
  eq(box.children[0].textContent, '组一', '⑪ 分组标题显示组名');
  eq(box.children[1].children.length, 1, '⑪ 组一有 1 枚芯片');
  const chip0 = box.children[1].children[0];
  eq(chip0.children.length, 2, '⑪ 芯片 = 状态点 + 名称（无备注文字）');
  eq(chip0.children[1].textContent, '入口一', '⑪ 芯片显示入口名');
  eq(chip0.children[0].textContent, '·', '⑪ 未检测时状态点为 ·');
  ok(String(chip0.title).indexOf('e1.invalid') >= 0, '⑪ 芯片提示为站点主机名（无来源注释）');
  // 点芯片 → openEndpoint(id, 当前检索词)
  chip0.click();
  eq(TSStub.last.id, 'e1', '⑪ 点芯片 → openEndpoint(e1)');
  eq(TSStub.last.q, '', '⑪ 无检索词时传空串');
  ok(ids['pp-ts-result'].textContent.indexOf('已打开') >= 0, '⑪ 结果行提示已打开');
  // 填检索词 → 再点：带词直达；提示行说明支持数量
  ids['pp-ts-query'].value = '10.1038/nature12373';
  ids['pp-ts-query'].fire('input');
  ok(ids['pp-ts-query-hint'].textContent.indexOf('1 个入口支持直达检索') > 0,
    '⑪ 检索词提示行说明支持直达的入口数');
  const chip0b = box.children[1].children[0];
  chip0b.click();
  eq(TSStub.last.q, '10.1038/nature12373', '⑪ 有检索词时把它传给 openEndpoint');
  ok(ids['pp-ts-result'].textContent.indexOf('已在') >= 0, '⑪ 结果行提示已在该源检索');
  // 点「检测网点」→ 刷新状态与状态点（probe:false 的入口不参与）
  ids['pp-ts-ping-btn'].click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  eq(TSStub.pinged, 1, '⑪ 点「检测网点」触发 checkEndpoints');
  ok(ids['pp-ts-result'].textContent.indexOf('可用 1/2') >= 0, '⑪ 检测结果「可用 1/2」');
  ok(ids['pp-ts-status'].textContent.indexOf('上次检测') >= 0, '⑪ 状态行显示上次检测时间');
  eq(ids['pp-ts-endpoints'].children[1].children[0].children[0].textContent, '●', '⑪ 可用入口显示实心点');
  eq(ids['pp-ts-endpoints'].children[3].children[0].children[0].textContent, '○', '⑪ 不可达入口显示空心点');
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
