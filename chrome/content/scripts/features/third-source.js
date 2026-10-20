// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 第三方文献源（实验性 · Pro 试用 · 0.45.0）
 * 用途：
 *   ① **公开入口导航（主线）**：按「中文库 / 英文全文 / 预印本 / 学术搜索」四组内置
 *      常用公开检索站点（知网镜像、万方、维普、PubScholar、Sci-Hub、PubMed、Europe PMC、
 *      DOAJ、CORE、arXiv 系、Google 学术镜像等），一键直达，**无需任何账号**；
 *   ② **带检索词直达**：面板输入 DOI / 标题后，支持检索模板的网点会把查询带入 URL
 *      （Google 学术、PubMed、Europe PMC、arXiv、万方、知网镜像…），少走一次首页；
 *   ③ 网点连通性可一键检测（并发 ≤5，结果缓存进 pref，面板按组显示可用/不可达）；
 *   ④ 备用能力（面板未暴露）：站点账号本机保存 + 登录自检，供自行配置的机构入口复用。
 * 边界（明确不做）：
 *   - 不代下载、不批量请求、不解析文献内容（网点本质是检索/入口导航）；
 *   - 不内置任何账号凭据；第三方站点的授权情况不明，默认关闭、由用户自行评估。
 * 门控（产品口径：Pro 会员试用）：
 *   - 客户端软门控（proGate）；遵循既有纪律——账号模块缺失 / 判定抛错时放行，
 *     只有「已登录且明确判定非 Pro」才拦截（同 rank-column 的 easyScholar 口径）。
 *   - 总开关 thirdSourceEnabled 默认关闭；关闭时菜单入口会引导到设置面板。
 *
 * 合规提示：第三方站点资源来源与授权情况不明，默认关闭；启停由用户自行评估，
 *   并遵守目标站点条款。本模块不提供任何绕过验证（验证码 / 单会话限制）的能力。
 *
 * pref：thirdSourceEnabled / thirdSourceEndpointCheck（+ 站点账号备用项：
 *       thirdSourceSite / thirdSourceUsername / thirdSourcePassword / thirdSourceLastTest /
 *       thirdSourceEntitlements）
 */
/* global Zotero, Services, Prefs, I18n, Account */

var ThirdSource = {
  // 已实测的站点清单（2026-10-16 双账号探测结论；后续可在设置面板切换）
  SITES: [
    {
      id: "wenxianchong",
      name: "文献虫",
      base: "http://b.r88r.top",
      cookiePrefix: "noiojml",
      center: "/e/member/cp/",
      lists: [
        { key: "cn", name: "中文库", path: "/e/action/ListInfo/?classid=61" },
        { key: "en", name: "英文库", path: "/e/action/ListInfo/?classid=63" },
        { key: "med", name: "医学库", path: "/e/action/ListInfo/?classid=66" },
      ],
    },
    {
      id: "biyezhushou",
      name: "毕业助手",
      base: "http://www.060193.top",
      cookiePrefix: "fmdqbml",
      center: "/e/member/my/",
      lists: [
        { key: "cn", name: "中文库", path: "/e/action/ListInfo/?classid=61" },
        { key: "en", name: "英文库", path: "/e/action/ListInfo/?classid=63" },
      ],
    },
  ],
  // 内置公开入口（0.45.0）：按四组整理。字段：
  //   id / name / group / url
  //   q     可选，检索 URL 模板（{q} 占位）——面板输入检索词后点该网点即直接落到检索结果；
  //   qkind "doi" 表示只吃 DOI（标题等其它词不代入，避免落到空结果页）；
  //   probe false 表示站点对自动化探测返回 403 / 超时（浏览器可正常打开），不参与连通性检测。
  // 只收「无需账号即可访问」的公开站点；机构代理类入口需院校账号，不在本功能范围。
  GROUPS: [
    { id: "cn", zh: "中文库", en: "Chinese databases" },
    { id: "full", zh: "英文全文 / 开放获取", en: "Full text / open access" },
    { id: "preprint", zh: "预印本", en: "Preprints" },
    { id: "search", zh: "学术搜索 / 镜像", en: "Search & mirrors" },
  ],
  ENDPOINTS: [
    // ---- 中文库 ----
    { id: "cnki-1", name: "知网镜像 · 一", group: "cn",
      url: "http://43.143.27.149:3344/kns8s/defaultresult/index",
      q: "http://43.143.27.149:3344/kns8s/defaultresult/index?kw={q}" },
    { id: "cnki-2", name: "知网镜像 · 二", group: "cn",
      url: "http://159.75.236.151:8085/kns8s/defaultresult/index",
      q: "http://159.75.236.151:8085/kns8s/defaultresult/index?kw={q}" },
    { id: "cnki-fsso", name: "知网机构访问", group: "cn",
      url: "https://fsso.cnki.net/" },
    { id: "wanfang", name: "万方数据", group: "cn",
      url: "https://www.wanfangdata.com.cn/",
      q: "https://s.wanfangdata.com.cn/paper?q={q}" },
    { id: "cqvip", name: "维普期刊", group: "cn",
      url: "https://www.cqvip.com/" },
    { id: "pubscholar", name: "PubScholar 公益学术", group: "cn",
      url: "https://pubscholar.cn/" },
    { id: "ncpssd", name: "国家哲社文献中心", group: "cn",
      url: "https://www.ncpssd.cn/" },
    // ---- 英文全文 / 开放获取 ----
    { id: "scihub-ren", name: "Sci-Hub · 一", group: "full",
      url: "https://www.sci-hub.ren/", q: "https://www.sci-hub.ren/{q}", qkind: "doi" },
    { id: "scihub-st", name: "Sci-Hub · 二", group: "full",
      url: "https://www.sci-hub.st/", q: "https://www.sci-hub.st/{q}", qkind: "doi" },
    { id: "scihub-cn", name: "Sci-Hub · 三", group: "full",
      url: "https://sci-hub.org.cn/" },
    { id: "pubmed", name: "PubMed", group: "full", probe: false,
      url: "https://pubmed.ncbi.nlm.nih.gov/",
      q: "https://pubmed.ncbi.nlm.nih.gov/?term={q}" },
    { id: "europepmc", name: "Europe PMC", group: "full", probe: false,
      url: "https://europepmc.org/", q: "https://europepmc.org/search?query={q}" },
    { id: "doaj", name: "DOAJ 开放期刊", group: "full", probe: false,
      url: "https://doaj.org/" },
    { id: "core", name: "CORE 开放论文", group: "full",
      url: "https://core.ac.uk/", q: "https://core.ac.uk/search?q={q}" },
    // ---- 预印本 ----
    { id: "arxiv", name: "arXiv", group: "preprint",
      url: "https://arxiv.org/", q: "https://arxiv.org/search/?query={q}&searchtype=all" },
    { id: "biorxiv", name: "bioRxiv", group: "preprint",
      url: "https://www.biorxiv.org/", q: "https://www.biorxiv.org/search/{q}" },
    { id: "medrxiv", name: "medRxiv", group: "preprint",
      url: "https://www.medrxiv.org/", q: "https://www.medrxiv.org/search/{q}" },
    { id: "ssrn", name: "SSRN", group: "preprint", probe: false,
      url: "https://www.ssrn.com/" },
    // ---- 学术搜索 / 镜像 ----
    { id: "gscholar", name: "Google 学术", group: "search", probe: false,
      url: "https://scholar.google.com/", q: "https://scholar.google.com/scholar?q={q}" },
    { id: "gs-1", name: "谷歌镜像 · 一", group: "search", url: "https://xs.essclick.com/" },
    { id: "gs-2", name: "谷歌镜像 · 二", group: "search", url: "https://kuluer.com/" },
    { id: "gs-3", name: "谷歌镜像 · 三", group: "search", url: "https://ac.489.org/" },
    { id: "panda985", name: "巨人学术搜索", group: "search", url: "https://sc.panda985.com/" },
    { id: "typicalgame", name: "巨人学术搜索 · 备用", group: "search",
      url: "https://xs.typicalgame.com/" },
    { id: "baidu", name: "百度学术", group: "search", probe: false,
      url: "https://xueshu.baidu.com/", q: "https://xueshu.baidu.com/s?wd={q}" },
    { id: "semantic", name: "Semantic Scholar", group: "search",
      url: "https://www.semanticscholar.org/",
      q: "https://www.semanticscholar.org/search?q={q}" },
    { id: "scmor", name: "思谋学术导航", group: "search", url: "https://ac.scmor.com/" },
  ],
  // 桌面 UA：部分站点默认 Zotero UA 会被拦；用常见桌面 UA（仅用于站点连通性检测/登录自检）
  UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  LOGIN_PATH: "/e/member/doaction.php",
  TIMEOUT_MS: 20000,
  // 连通性检测：并发上限 + 单点超时（0.45.0 起由串行改为小并发，27 个网点约 5~10s）
  CHECK_CONCURRENCY: 5,
  CHECK_TIMEOUT_MS: 8000,
  // 低频纪律：站点登录/权限页等「有状态请求」任意两次间隔 ≥ 1.5s
  MIN_INTERVAL_MS: 1500,
  _lastReqAt: 0,

  _debug(msg) {
    try { Zotero.debug("Papilot thirdSource: " + msg); } catch (e) { /* ignore */ }
  },

  _zh() {
    try { return !!(I18n && I18n.isZh); } catch (e) { return true; }
  },

  _sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  },

  async _throttle() {
    const wait = this._lastReqAt + this.MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await this._sleep(wait);
    this._lastReqAt = Date.now();
  },

  /* ---------- 站点与开关 ---------- */

  site(id) {
    const want = String(id || "").trim();
    for (const s of this.SITES) { if (s.id === want) return s; }
    return this.SITES[0];
  },

  currentSite() {
    let id = "";
    try { id = String(Prefs.get("thirdSourceSite", this.SITES[0].id) || ""); } catch (e) { /* ignore */ }
    return this.site(id);
  },

  setSite(id) {
    try { Prefs.set("thirdSourceSite", this.site(id).id); return true; }
    catch (e) { return false; }
  },

  enabled() {
    try { return Prefs.get("thirdSourceEnabled", false) === true; } catch (e) { return false; }
  },

  setEnabled(v) {
    try { Prefs.set("thirdSourceEnabled", !!v); return true; }
    catch (e) { return false; }
  },

  /* ---------- Pro 门控（软门控） ----------
   * 纪律：账号模块缺失 / 判定抛错 / 会员信息未知 → 放行（绝不擅自锁用户）；
   *       仅「已登录 + 明确非 Pro」拦截。返回 { ok, reason }。 */
  proGate() {
    try {
      if (typeof Account === "undefined" || !Account) return { ok: true, reason: "no-module" };
      if (typeof Account.isLoggedIn === "function" && !Account.isLoggedIn()) {
        return { ok: false, reason: "not-logged-in" };
      }
      if (typeof Account.isPro === "function" && Account.isPro()) return { ok: true, reason: "pro" };
      const m = (typeof Account.membership === "function") ? Account.membership() : null;
      if (!m) return { ok: true, reason: "unknown-allow" };
      return { ok: false, reason: "need-pro" };
    } catch (e) {
      return { ok: true, reason: "error-allow" };
    }
  },

  gateMessage(gate) {
    const zh = this._zh();
    if (!gate || gate.ok) return "";
    if (gate.reason === "not-logged-in") {
      return zh ? "该实验功能面向 Pro 会员试用：请先登录 Papilot 账号"
        : "Pro-only trial: sign in to your Papilot account first";
    }
    return zh ? "该实验功能面向 Pro 会员试用：当前账号非 Pro，可在设置面板「账号」卡片升级"
      : "Pro-only trial: current plan is not Pro (upgrade in Settings → Account)";
  },

  /* ---------- 凭据（只存本机；base64 混淆，非加密） ---------- */

  obfuscate(p) {
    try { return btoa(unescape(encodeURIComponent(String(p || "")))); }
    catch (e) { return ""; }
  },

  deobfuscate(s) {
    try { return decodeURIComponent(escape(atob(String(s || "")))); }
    catch (e) { return ""; }
  },

  /** 0.67.0：本机为空时回落 CredVault 内存水合副本（仅托管模式） */
  creds() {
    let u = "", p = "";
    try {
      u = String(Prefs.get("thirdSourceUsername", "") || "").trim();
      p = this.deobfuscate(Prefs.get("thirdSourcePassword", ""));
      if ((!u || !p) && typeof CredVault !== "undefined" && CredVault && CredVault.cached) {
        u = u || String(CredVault.cached("third.user") || "").trim();
        p = p || String(CredVault.cached("third.pass") || "");
      }
    } catch (e) { return null; }
    return (u && p) ? { u: u, p: p } : null;
  },

  saveCreds(u, p) {
    try {
      if (typeof CredVault !== "undefined" && CredVault && CredVault.set) {
        const a = CredVault.set("third.user", String(u || "").trim());
        const b = CredVault.set("third.pass", String(p || ""));
        return !!(a.ok && b.ok);
      }
      Prefs.set("thirdSourceUsername", String(u || "").trim());
      Prefs.set("thirdSourcePassword", this.obfuscate(p));
      return true;
    } catch (e) { return false; }
  },

  clearCreds() {
    try {
      Prefs.set("thirdSourceUsername", "");
      Prefs.set("thirdSourcePassword", "");
      return true;
    } catch (e) { return false; }
  },

  /* ---------- 站点会话（Zotero 共享 cookie 罐） ---------- */

  /** base → host（纯函数） */
  hostOf(base) {
    return String(base || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  },

  /** 从 cookie 列表挑出站点登录用户名（纯函数）：prefix+"auth" 判定登录 + prefix+"username" 取名 */
  pickCookieUser(cookies, prefix) {
    let hasAuth = false, user = "";
    for (const c of (cookies || [])) {
      if (c && c.name === prefix + "auth" && c.value) hasAuth = true;
      if (c && c.name === prefix + "username" && c.value) user = c.value;
    }
    return hasAuth ? (user || "已登录") : "";
  },

  session(site) {
    const s = site || this.currentSite();
    try {
      const host = this.hostOf(s.base);
      const iter = Services.cookies.getCookiesFromHost(host, {});
      const list = [];
      while (iter.hasMoreElements()) {
        const c = iter.getNext();
        list.push({ name: c.name, value: c.value });
      }
      const user = this.pickCookieUser(list, s.cookiePrefix);
      return user ? { username: user } : null;
    } catch (e) { return null; }
  },

  /* ---------- 账号权限（用户中心页解析；0.44.0 实机验证后补充） ---------- */

  /** 解析用户中心的权限列表（纯函数，兼容两站皮肤） → ["中文数据库 长期不限时", ...] */
  parseEntitlements(html) {
    const out = [];
    const t = String(html || "");
    let m;
    // 毕业助手（/e/member/my/）：<p class='my_quanxian_t1'>英文数据库</p><p class='my_quanxian_t2'>长期不限时</p>
    const reB = /<p class=['"]my_quanxian_t1['"]>([^<]+)<\/p>\s*<p class=['"]my_quanxian_t2['"]>([^<]+)<\/p>/g;
    while ((m = reB.exec(t))) { out.push((m[1] + " " + m[2]).trim()); }
    // 文献虫（/e/member/cp/）：<span>中文数据库 长期不限时</span>...
    if (!out.length) {
      const reA = /<span>([^<]*?数据库[^<]*?)<\/span>/g;
      while ((m = reA.exec(t))) { out.push(m[1].trim()); }
    }
    return out;
  },

  /** 读缓存的权限列表（纯函数；pref 存 JSON 字符串） */
  cachedEntitlements() {
    try {
      const raw = String(Prefs.get("thirdSourceEntitlements", "") || "");
      if (!raw) return [];
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch (e) { return []; }
  },

  /** 拉取并缓存账号权限（1 次 GET 用户中心页；低频节流） */
  async fetchEntitlements(site) {
    const s = site || this.currentSite();
    await this._throttle();
    try {
      const xhr = await Zotero.HTTP.request("GET", s.base + s.center, {
        timeout: this.TIMEOUT_MS, responseType: "text",
        headers: { "User-Agent": this.UA, "Referer": s.base + "/" },
      });
      const list = this.parseEntitlements(String((xhr && xhr.responseText) || ""));
      if (list.length) {
        try { Prefs.set("thirdSourceEntitlements", JSON.stringify(list)); } catch (e) { /* ignore */ }
      }
      return list;
    } catch (e) {
      this._debug("fetchEntitlements error: " + (e && (e.message || e)));
      return null;
    }
  },

  /* ---------- 上次测试记录（面板展示用；0.44.0 实机验证后补充） ---------- */

  _recordTest(ok, code, username) {
    try {
      Prefs.set("thirdSourceLastTest", JSON.stringify({
        at: Date.now(), ok: !!ok, code: String(code || ""),
        site: this.currentSite().id, username: String(username || ""),
      }));
    } catch (e) { /* ignore */ }
  },

  /** 读上次测试记录（纯函数） → {at,ok,code,site,username} | null */
  readLastTest() {
    try {
      const raw = String(Prefs.get("thirdSourceLastTest", "") || "");
      if (!raw) return null;
      const v = JSON.parse(raw);
      return (v && typeof v === "object" && typeof v.at === "number") ? v : null;
    } catch (e) { return null; }
  },

  /* ---------- 登录自检 ---------- */

  /** 登录响应解析（纯函数）：ok / busy（单会话被占）/ bad-credentials / unknown */
  parseLoginResult(text) {
    const t = String(text || "");
    if (t.indexOf("登录成功") >= 0) return { ok: true, code: "ok" };
    if (t.indexOf("只能一人在线") >= 0) return { ok: false, code: "busy" };
    if (t.indexOf("密码错误") >= 0 || t.indexOf("用户名不存在") >= 0 || t.indexOf("帐号不存在") >= 0) {
      return { ok: false, code: "bad-credentials" };
    }
    return { ok: false, code: "unknown" };
  },

  loginMsg(code, zh) {
    switch (code) {
      case "ok": return zh ? "✓ 登录成功，卡号有效" : "✓ Signed in — card valid";
      case "busy": return zh ? "该卡号正在其他位置使用（站点限制同一帐号单会话），请先退出其他端再试"
        : "Card is in use elsewhere (single-session limit) — sign out first";
      case "bad-credentials": return zh ? "卡号或密码不正确" : "Invalid card number or password";
      default: return zh ? "登录响应无法识别（站点可能变更了页面），可改用「打开入口」在浏览器中登录"
        : "Unrecognized login response — try logging in via the browser";
    }
  },

  /** 登录自检：发 1 次请求；成功时 cookie 落 Zotero 共享罐（供 session() 读取） */
  async login(user, pass) {
    const s = this.currentSite();
    await this._throttle();
    try {
      const body = "enews=login&ecmsfrom=9"
        + "&username=" + encodeURIComponent(String(user || ""))
        + "&password=" + encodeURIComponent(String(pass || ""))
        + "&lifetime=315360000";
      const xhr = await Zotero.HTTP.request("POST", s.base + this.LOGIN_PATH, {
        body: body,
        timeout: this.TIMEOUT_MS,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.UA,
          "Referer": s.base + "/e/member/login/",
        },
        responseType: "text",
      });
      const parsed = this.parseLoginResult(String((xhr && xhr.responseText) || ""));
      if (parsed.ok) {
        const sess = this.session(s);
        const uname = (sess && sess.username) || user;
        this._recordTest(true, "ok", uname);
        // 登录成功后顺手拉取账号权限（用户中心页解析，低频 1 次请求）
        try { await this.fetchEntitlements(s); } catch (e) { /* ignore */ }
        return { ok: true, code: "ok", username: uname };
      }
      this._recordTest(false, parsed.code, user);
      return parsed;
    } catch (e) {
      this._debug("login error: " + (e && (e.message || e)));
      this._recordTest(false, "network", user);
      return { ok: false, code: "network", msg: e && (e.message || String(e)) };
    }
  },

  /* ---------- 打开入口 ---------- */

  /** 列表 URL（纯函数）：key 缺省或未知时取该站点第一个列表 */
  listUrl(site, key) {
    const s = site || this.SITES[0];
    const want = String(key || "").trim();
    let picked = null;
    for (const l of s.lists) { if (l.key === want) { picked = l; break; } }
    if (!picked) picked = s.lists[0];
    return s.base + picked.path;
  },

  openPortal(key) {
    const gate = this.proGate();
    if (!gate.ok) { this._toast(this.gateMessage(gate)); return false; }
    if (!this.enabled()) {
      this._toast(this._zh() ? "第三方文献源为实验功能（默认关闭）：请先在设置面板中启用"
        : "Experimental feature (off by default): enable it in Settings first");
      this.openSettings();
      return false;
    }
    const url = this.listUrl(this.currentSite(), key);
    try {
      Zotero.launchURL(url);
      this._debug("openPortal -> " + url);
      return true;
    } catch (e) {
      this._toast((this._zh() ? "打开失败：" : "Open failed: ") + (e && (e.message || e)));
      return false;
    }
  },

  /* ---------- 内置公开入口（0.45.0：四组导航 + 带检索词直达） ---------- */

  endpoints() { return this.ENDPOINTS.slice(); },

  endpointById(id) {
    const want = String(id || "");
    for (const e of this.ENDPOINTS) { if (e.id === want) return e; }
    return null;
  },

  groupName(id) {
    for (const g of this.GROUPS) { if (g.id === id) return this._zh() ? g.zh : g.en; }
    return "";
  },

  /** 分组视图（纯函数） → [{id, name, items:[endpoint]}]
   *  兜底：漏写 group 的网点归入「其它」组——绝不因元数据缺项让入口从面板消失。 */
  grouped() {
    const out = [];
    for (const g of this.GROUPS) {
      const items = [];
      for (const e of this.ENDPOINTS) { if (e.group === g.id) items.push(e); }
      if (items.length) out.push({ id: g.id, name: this.groupName(g.id), items });
    }
    const known = {};
    for (const g of this.GROUPS) { known[g.id] = true; }
    const rest = this.ENDPOINTS.filter((e) => !known[e.group]);
    if (rest.length) out.push({ id: "_other", name: this._zh() ? "其它" : "Other", items: rest });
    return out;
  },

  /** DOI 形态判定（纯函数）：10.xxxx/yyyy */
  isDoi(s) {
    return /^10\.\d{4,9}\/\S+$/.test(String(s || "").trim());
  },

  /** 该网点在当前查询下是否会「带入检索词」（纯函数）
   *  无模板 / 无查询 / DOI 专用源拿到非 DOI → false（退回首页，避免落到空结果页） */
  canSearch(id, query) {
    const e = this.endpointById(id);
    const q = String(query || "").trim();
    if (!e || !e.q || !q) return false;
    if (e.qkind === "doi") return this.isDoi(q);
    return true;
  },

  /** 目标 URL（纯函数）：能搜索就带查询，否则回首页 */
  urlFor(id, query) {
    const e = this.endpointById(id);
    if (!e) return "";
    const q = String(query || "").trim();
    if (!this.canSearch(id, q)) return e.url;
    return e.q.replace("{q}", encodeURIComponent(q));
  },

  /** 上次检测缓存（纯函数） → {at, list:[{id,ok,ms,error?}]} | null */
  readEndpointCheck() {
    try {
      const raw = String(Prefs.get("thirdSourceEndpointCheck", "") || "");
      if (!raw) return null;
      const v = JSON.parse(raw);
      return (v && typeof v.at === "number" && Array.isArray(v.list)) ? v : null;
    } catch (e) { return null; }
  },

  /** 打开某个网点（同一套门控：Pro 试用 + 启用开关）
   *  query 非空且该网点支持检索 → 直接落到检索结果；
   *  返回 { ok, url, searched, needDoi, name, reason? }（面板据此给准确反馈） */
  openEndpoint(id, query) {
    const gate = this.proGate();
    if (!gate.ok) { this._toast(this.gateMessage(gate)); return { ok: false, reason: gate.reason }; }
    if (!this.enabled()) {
      this._toast(this._zh() ? "第三方文献源为实验功能（默认关闭）：请先在设置面板中启用"
        : "Experimental feature (off by default): enable it in Settings first");
      this.openSettings();
      return { ok: false, reason: "disabled" };
    }
    const e = this.endpointById(id);
    if (!e) {
      this._toast(this._zh() ? "未知网点：" + String(id || "") : "Unknown endpoint: " + String(id || ""));
      return { ok: false, reason: "unknown" };
    }
    const q = String(query || "").trim();
    const searched = this.canSearch(e.id, q);
    const needDoi = !!(q && e.q && e.qkind === "doi" && !searched);
    const url = this.urlFor(e.id, q);
    try {
      Zotero.launchURL(url);
      this._debug("openEndpoint -> " + url);
      return { ok: true, url: url, searched: searched, needDoi: needDoi, name: e.name };
    } catch (err) {
      this._toast((this._zh() ? "打开失败：" : "Open failed: ") + (err && (err.message || err)));
      return { ok: false, reason: "launch" };
    }
  },

  /** 批量检测网点连通性：小并发（默认 5）+ 逐点超时；
   *  onProgress(done, total) 供面板显示进度；结果按 ENDPOINTS 顺序缓存进 pref。 */
  async checkEndpoints(onProgress) {
    const self = this;
    const list = this.ENDPOINTS.filter((e) => e.probe !== false);
    const total = list.length;
    const out = [];
    let idx = 0;
    const report = () => {
      try { if (typeof onProgress === "function") onProgress(out.length, total); } catch (x) { /* ignore */ }
    };
    async function worker() {
      while (idx < total) {
        const e = list[idx++];
        const t0 = Date.now();
        try {
          await Zotero.HTTP.request("GET", e.url, {
            timeout: self.CHECK_TIMEOUT_MS, responseType: "text",
            headers: { "User-Agent": self.UA },
          });
          out.push({ id: e.id, ok: true, ms: Date.now() - t0 });
        } catch (err) {
          out.push({ id: e.id, ok: false, ms: Date.now() - t0,
                     error: String((err && (err.message || err)) || "").slice(0, 60) });
        }
        report();
      }
    }
    const pool = [];
    for (let i = 0; i < Math.min(this.CHECK_CONCURRENCY, total); i++) { pool.push(worker()); }
    await Promise.all(pool);
    // 按清单顺序归一，面板显示位置稳定（并发完成顺序不可依赖）
    const order = {};
    this.ENDPOINTS.forEach((e, i) => { order[e.id] = i; });
    out.sort((a, b) => (order[a.id] || 0) - (order[b.id] || 0));
    try { Prefs.set("thirdSourceEndpointCheck", JSON.stringify({ at: Date.now(), list: out })); } catch (x) { /* ignore */ }
    return out;
  },

  openCenter() {
    const gate = this.proGate();
    if (!gate.ok) { this._toast(this.gateMessage(gate)); return false; }
    const s = this.currentSite();
    try {
      Zotero.launchURL(s.base + s.center);
      return true;
    } catch (e) {
      this._toast((this._zh() ? "打开失败：" : "Open failed: ") + (e && (e.message || e)));
      return false;
    }
  },

  openSettings() {
    try {
      const paneID = (Zotero.Papilot && Zotero.Papilot._paneID) || "papilot-prefs";
      Zotero.Utilities.Internal.openPreferences(paneID);
    } catch (e) { this._debug("openSettings failed: " + (e && (e.message || e))); }
  },

  _toast(msg) {
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline("Papilot");
      pw.addDescription(String(msg || ""));
      pw.show();
      pw.startCloseTimer(6000);
    } catch (e) {
      this._debug("toast: " + msg);
    }
  },

  /* ---------- 状态快照（面板/菜单共用） ---------- */

  status() {
    const s = this.currentSite();
    const sess = this.session(s);
    const gate = this.proGate();
    return {
      enabled: this.enabled(),
      siteId: s.id,
      siteName: s.name,
      configured: !!this.creds(),
      loggedIn: !!sess,
      username: (sess && sess.username) || "",
      gate: gate.ok ? (gate.reason === "pro" ? "pro" : "allowed") : gate.reason,
      lastTest: this.readLastTest(),
      entitlements: this.cachedEntitlements(),
    };
  },
};
