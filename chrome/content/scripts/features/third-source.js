/* PaperPilot 第三方文献源（实验性 · Pro 试用 · 0.44.0 草案）
 * 用途：为「文献虫 / 毕业助手」等第三方文献代查站提供：
 *   ① 卡号/密码本机保存（base64 混淆，非加密；只存本机，不上传）；
 *   ② 登录连通性自检（向站点发 1 次登录请求，验证卡号有效 / 是否被单会话占用）；
 *   ③ 一键直达站点入口（外部浏览器打开「文献下载」页，由用户自行检索与下载）。
 *
 * 边界（明确不做）：
 *   - 不代下载、不批量请求、不解析文献内容（站点本身也没有条目级 API，本质是入口导航）；
 *   - 不共享账号：站点限制「同一帐号同一时刻只能一人在线」，多端共用会互踢（实测）；
 *   - 仅在「保存并测试登录」时发起 1 次网络请求，其余动作均为 Zotero.launchURL 打开链接。
 *
 * 门控（产品口径：Pro 会员试用）：
 *   - 客户端软门控（proGate）；遵循既有纪律——账号模块缺失 / 判定抛错时放行，
 *     只有「已登录且明确判定非 Pro」才拦截（同 rank-column 的 easyScholar 口径）。
 *   - 总开关 thirdSourceEnabled 默认关闭；关闭时菜单入口会引导到设置面板。
 *
 * 合规提示：第三方站点资源来源与授权情况不明，默认关闭；启停由用户自行评估，
 *   并遵守目标站点条款。本模块不提供任何绕过验证（验证码 / 单会话限制）的能力。
 *
 * pref：thirdSourceEnabled / thirdSourceSite / thirdSourceUsername / thirdSourcePassword
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
  // 桌面 UA：站点为老 PHP 站，默认 Zotero UA 无必要暴露；用常见桌面 UA 更自然地通过
  UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  LOGIN_PATH: "/e/member/doaction.php",
  TIMEOUT_MS: 20000,
  // 低频纪律：任意两次请求间隔 ≥ 1.5s（探测实测站点无限速，但保守自律）
  MIN_INTERVAL_MS: 1500,
  _lastReqAt: 0,

  _debug(msg) {
    try { Zotero.debug("PaperPilot thirdSource: " + msg); } catch (e) { /* ignore */ }
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
      return zh ? "该实验功能面向 Pro 会员试用：请先登录 PaperPilot 账号"
        : "Pro-only trial: sign in to your PaperPilot account first";
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

  creds() {
    let u = "", p = "";
    try {
      u = String(Prefs.get("thirdSourceUsername", "") || "").trim();
      p = this.deobfuscate(Prefs.get("thirdSourcePassword", ""));
    } catch (e) { return null; }
    return (u && p) ? { u: u, p: p } : null;
  },

  saveCreds(u, p) {
    try {
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
      const paneID = (Zotero.PaperPilot && Zotero.PaperPilot._paneID) || "paperpilot-prefs";
      Zotero.Utilities.Internal.openPreferences(paneID);
    } catch (e) { this._debug("openSettings failed: " + (e && (e.message || e))); }
  },

  _toast(msg) {
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline("PaperPilot");
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
