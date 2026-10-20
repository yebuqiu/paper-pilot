// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 账号与密钥中心核心域（0.66.0）
 *
 * 一句话：把散落在各设置卡里的**第三方凭据**收进一处，统一做
 * 「脱敏查看 / 受控编辑 / 加密托管 / 访问审计」，只对 Pro 会员开放。
 *
 * 覆盖四类（Pro 会员个人中心）：
 *   ① 知网 CNKI       用户名（明文）+ 密码（本机 base64 混淆）
 *   ② 坚果云 WebDAV   邮箱（明文）+ 应用密码（令牌）
 *   ③ 期刊分区         easyScholar SecretKey
 *   ④ 自定义 AI 模型   每个非官方通道的 apiKey（动态列出）
 *
 * ── 存储分层（诚实说明边界，别把它说成"军事级加密"）──────────────
 *   L1 本机：Zotero prefs（profile 目录，受系统账户权限保护）。密码类沿用
 *            base64 混淆（防随手翻看 prefs，**不是加密**）——保持与既有
 *            消费方（cn-fetch / cloud-sync / rank-column / channels）**同步可读**，
 *            否则登录、同步、分区列这些热路径要全部改成异步，得不偿失。
 *   L2 账号托管：显式点「存到账号」后，值经服务端 AES-256-GCM 加密落盘
 *            （server/lib/secretbox.js，主密钥不进备份），列表只回掩码，
 *            明文读取走登录 + 限速 + 审计。换机/重装可用它恢复。
 *   L3 访问层：本窗口默认**全量脱敏**；明文需解锁（设了口令就校验口令，
 *            没设口令则二次确认），到期自动重新隐藏；每次动作写本地审计。
 *
 * ── 不变量（改动前先读）────────────────────────────────────────
 *   1. 本模块**永不**把明文写进日志、审计、云同步快照、导出文件。
 *   2. 写 pref 时保持各消费方既有格式（cnkiPassword = base64；其余明文），
 *      否则功能静默失效（例如坚果云会 401、知网登录会拿空密码）。
 *   3. AI 通道的 Key 嵌在 aiChannels JSON 里，只能用 Channels._save() 整体写回，
 *      不能另存一份——两份不同步就会"面板显示新 Key、实际调用用旧 Key"。
 *   4. 审计只记「谁在什么时候动了哪一项」，不记值；最多 JOURNAL_MAX 条。
 */
/* global Zotero, Prefs, Account, Channels */

var CredVault = {
  /* ---------------- pref 键 ---------------- */

  K: {
    pass: "vaultPassHash",        // "salt:hash"，空 = 未设访问口令
    autoHide: "vaultAutoHideSec", // 明文自动隐藏秒数（0 = 不自动隐藏）
    audit: "vaultAudit",          // JSON 数组（最多 JOURNAL_MAX 条）
    lockOnOpen: "vaultLockOnOpen",// 打开窗口是否需要先解锁（有口令时默认 true）
    hostedOnly: "vaultHostedOnly",// JSON 数组：只存账号托管、本机不留值的条目 id
  },

  JOURNAL_MAX: 40,
  /** 口令迭代哈希轮数（纯 JS 同步实现，兼顾挡爆破与打开速度） */
  PASS_ITER: 8000,
  /** 「仅托管」模式的内存水合副本：id → value（**不落盘**，关掉 Zotero 即消失） */
  _mem: {},
  _hydratedAt: 0,

  /* ---------------- 分组与字段注册表 ---------------- */

  GROUPS: [
    { id: "cnki", icon: "📚", title: "知网（CNKI）",
      desc: "个人账号用于非校园网环境下载 PDF 全文；凭据只在本机与你自己账号的加密托管里" },
    { id: "nutstore", icon: "☁️", title: "坚果云（WebDAV）",
      desc: "云同步与备份的账号；应用密码可在坚果云「账户信息 → 安全选项」里单独生成" },
    { id: "rank", icon: "📊", title: "期刊分区（easyScholar）",
      desc: "列表分区列使用的在线数据源；SecretKey 在 easyscholar.cn 免费注册后获取" },
    { id: "ai", icon: "🔌", title: "自定义 AI 模型",
      desc: "你自己接入的 OpenAI 兼容通道 API Key；官方通道用的是登录令牌，不在此列" },
    { id: "third", icon: "🧪", title: "第三方文献源（实验）",
      desc: "卡密/账号型文献站（默认关闭，凭据只在本机与账号托管里）" },
    { id: "services", icon: "🌐", title: "其他集成",
      desc: "Semantic Scholar 与 MCP 对外供给的访问凭据；都可留空，留空即用匿名/关闭状态" },
  ],

  /**
   * 静态字段表。动态字段（AI 通道）由 items() 现场生成。
   *   pref     —— 真实落点（与消费方共用，改这里等于改功能）
   *   secret   —— 是否需要脱敏 / 解锁后才显示
   *   encode   —— 写入前的变换（cnkiPassword 沿用 base64，消费方同步解码）
   *   hosted   —— 服务端托管名（null = 不参与托管）
   *   noKey    —— 该字段在哪些情况下不适用（如 Ollama 免密）
   */
  FIELDS: [
    { id: "cnki.user", group: "cnki", label: "用户名", secret: false,
      pref: "cnkiUsername", placeholder: "手机号 / 邮箱", maxLen: 120,
      hint: "知网个人账号；校园网 IP 授权时可不填" },
    { id: "cnki.pass", group: "cnki", label: "密码", secret: true,
      pref: "cnkiPassword", placeholder: "登录密码", maxLen: 200,
      // 0.67.0：知网改成「账号 + 密码」一条托管（cnki_account，JSON）。只存密码会让
      // 换机取回后还差一个用户名，所谓"一键恢复"是断的。cnki_password 仍写一份兼容副本。
      encode: "b64", hosted: "cnki_account", bundle: "cnki",
      hint: "只用于知网登录请求；本机混淆存放。「存到账号」会连用户名一起存" },

    { id: "nutstore.email", group: "nutstore", label: "账号邮箱", secret: false,
      pref: "cloudSyncEmail", placeholder: "you@example.com", maxLen: 200,
      hint: "坚果云登录邮箱（WebDAV 用户名）" },
    { id: "nutstore.token", group: "nutstore", label: "应用密码", secret: true,
      pref: "cloudSyncToken", placeholder: "应用密码（不是登录密码）", maxLen: 200,
      hosted: "nutstore_token",
      hint: "坚果云「账户信息 → 安全选项 → 添加应用」生成；登录密码会 401" },

    { id: "rank.key", group: "rank", label: "SecretKey", secret: true,
      pref: "easyScholarKey", placeholder: "easyScholar SecretKey", maxLen: 200,
      hosted: "easyscholar",
      hint: "填写后分区列在线查询；不填则回落内置离线数据" },

    { id: "third.site", group: "third", label: "站点", secret: false,
      pref: "thirdSourceSite", placeholder: "文献站入口地址", maxLen: 300,
      hint: "第三方文献源（试验功能）的站点键；留空 = 未配置" },
    { id: "third.user", group: "third", label: "用户名 / 卡密", secret: false,
      pref: "thirdSourceUsername", placeholder: "账号或卡密", maxLen: 200,
      hint: "卡密型站点可直接填卡密" },
    { id: "third.pass", group: "third", label: "密码", secret: true,
      pref: "thirdSourcePassword", placeholder: "站点密码", maxLen: 200,
      encode: "b64", hosted: "third_source_password",
      hint: "本机混淆存放；该功能默认关闭，仅 Pro 试用" },

    { id: "s2.key", group: "services", label: "Semantic Scholar API Key", secret: true,
      pref: "s2ApiKey", placeholder: "可留空（匿名接口限额更低）", maxLen: 200,
      hosted: "s2_apikey",
      hint: "用于被引量、相关文献、引文上下文；留空时走匿名接口" },
    { id: "mcp.token", group: "services", label: "MCP 访问令牌", secret: true,
      pref: "mcpToken", placeholder: "自动生成，可重置", maxLen: 200,
      hosted: "mcp_token",
      hint: "外部 AI 客户端调 Papilot 用的 Bearer 令牌；在 MCP 窗口里点重置即可换新" },
  ],

  /* ---------------- 基础工具 ---------------- */

  _zh() {
    try { return String((Zotero && Zotero.locale) || "").toLowerCase().indexOf("zh") === 0; }
    catch (e) { return true; }
  },

  /** base64（UTF-8 安全）；与 CNAuth.obfuscate 等价 */
  _b64encode(s) {
    try { return btoa(unescape(encodeURIComponent(String(s == null ? "" : s)))); }
    catch (e) { return ""; }
  },
  _b64decode(s) {
    try { return decodeURIComponent(escape(atob(String(s || "")))); }
    catch (e) { return ""; }
  },

  _decodeField(f, raw) {
    const v = String(raw == null ? "" : raw);
    return f && f.encode === "b64" ? this._b64decode(v) : v;
  },
  _encodeField(f, value) {
    const v = String(value == null ? "" : value);
    return f && f.encode === "b64" ? this._b64encode(v) : v;
  },

  /* ---------------- 脱敏 ---------------- */

  /**
   * 脱敏：**不泄露长度**、不泄露首尾（首尾片段足以在截图里认出密钥）。
   * 空值返回 ""（UI 显示「未配置」）。masked() 只用于展示，永不参与比较。
   */
  mask(value) {
    const v = String(value == null ? "" : value);
    if (!v) return "";
    return "••••••••";
  },

  /** 仅用于「确认存的是哪一把」：末 4 位（长度 > 8 才给，太短等于全泄露） */
  tail(value) {
    const v = String(value == null ? "" : value);
    return v.length > 8 ? v.slice(-4) : "";
  },

  /* ---------------- SHA-256（同步；口令哈希用） ---------------- */

  /** 纯 JS SHA-256 → 小写 hex。标准实现，测试向量见 test/cred-vault.test.js */
  sha256(text) {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    // UTF-8 字节化（surrogate pair 单独处理，避免中文口令被截断）
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        const c2 = text.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Array(64);
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const p = off + i * 4;
        w[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) | 0;
      }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) | 0;
        const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) | 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) | 0;
        const ch = ((e & f) ^ (~e & g)) | 0;
        const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) | 0;
        const mj = ((a & b) ^ (a & c) ^ (b & c)) | 0;
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e;
        e = (d + t1) | 0;
        d = c; c = b; b = a;
        a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    function hx(n) { return ("00000000" + (n >>> 0).toString(16)).slice(-8); }
    return hx(h0) + hx(h1) + hx(h2) + hx(h3) + hx(h4) + hx(h5) + hx(h6) + hx(h7);
  },

  /** 口令 → "salt:hash"（salt 为随机 hex；迭代拉高单次验证成本） */
  hashPass(pass, salt) {
    const s = salt || this.randomHex(16);
    let x = s + ":" + String(pass || "");
    for (let i = 0; i < this.PASS_ITER; i++) x = this.sha256(x + ":" + i);
    return s + ":" + x;
  },

  randomHex(bytes) {
    const n = bytes || 16;
    let out = "";
    try {
      const buf = new Uint8Array(n);
      (Zotero.getMainWindow().crypto || crypto).getRandomValues(buf);
      for (let i = 0; i < n; i++) out += ("0" + buf[i].toString(16)).slice(-2);
      return out;
    } catch (e) {
      // 兜底：Math.random 熵不足，只用于「盐」这种非机密场景，并在前缀标记
      out = "w";
      for (let i = 0; i < n; i++) out += ("0" + Math.floor(Math.random() * 256).toString(16)).slice(-2);
      return out;
    }
  },

  /* ---------------- 访问口令 ---------------- */

  hasPasscode() {
    return !!String(Prefs.get(this.K.pass, "") || "");
  },

  setPasscode(pass) {
    const p = String(pass || "");
    if (!p) return { ok: false, error: "口令不能为空" };
    if (p.length < 4) return { ok: false, error: "口令至少 4 位" };
    Prefs.set(this.K.pass, this.hashPass(p));
    this.journal("pass-set", "", "");
    return { ok: true };
  },

  clearPasscode(pass) {
    if (this.hasPasscode()) {
      const r = this.verifyPasscode(pass);
      if (!r.ok) return r;
    }
    Prefs.set(this.K.pass, "");
    // 0.66.0：清口令的同一动作写审计，但**先**把旧口令校验过的痕迹记成 pass-clear
    this.journal("pass-clear", "", "");
    return { ok: true };
  },

  /** 校验口令（失败计数由界面层控制节流；这里只做常数时间比较） */
  verifyPasscode(pass) {
    const stored = String(Prefs.get(this.K.pass, "") || "");
    if (!stored) return { ok: true, noPass: true };
    const idx = stored.lastIndexOf(":");
    if (idx <= 0) return { ok: false, error: "口令记录已损坏，请重置" };
    const salt = stored.slice(0, idx);
    const want = stored.slice(idx + 1);
    const got = this.hashPass(pass, salt).slice(idx + 1);
    if (got.length !== want.length) return { ok: false, error: "口令不正确" };
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0 ? { ok: true } : { ok: false, error: "口令不正确" };
  },

  /* ---------------- 会员门控 ---------------- */

  /**
   * 访问资格：Pro 会员（本地会员缓存判定，离线同样生效）。
   * 未登录 / Free / 已过期 → 锁定；界面只展示「有哪些项」，不展示任何值。
   */
  access() {
    let A = null;
    try { A = (typeof Account !== "undefined") ? Account : null; } catch (e) { A = null; }
    const loggedIn = !!(A && A.isLoggedIn && A.isLoggedIn());
    let pro = false;
    let plan = "Free";
    let name = "免费版";
    let expiresAt = 0;
    try {
      if (loggedIn && A.isPro) pro = !!A.isPro();
      const m = loggedIn && A.membership ? A.membership() : null;
      if (m) { plan = m.plan || plan; name = m.name || name; expiresAt = m.expiresAt || 0; }
    } catch (e) { /* 会员缓存损坏按 Free 处理（fail-closed） */ }
    return {
      loggedIn, pro, plan, name, expiresAt,
      reason: !loggedIn ? "not_logged_in" : (pro ? "ok" : "need_pro"),
      // 门控只认服务端下发的 plan；未知（旧服务端）时 pro 恒 false → 不锁用户也需产品确认，
      // 这里选择 fail-closed：宁可让用户看到「需要专业版」，也不能让凭据裸露。
    };
  },

  /* ---------------- 条目读写 ---------------- */

  _findField(id) {
    return this.FIELDS.find((f) => f.id === id) || null;
  },

  /** 自定义 AI 通道（排除官方通道与本地免密通道） */
  _aiChannels() {
    try {
      if (typeof Channels === "undefined" || !Channels) return [];
      const doc = Channels._load();
      return (doc.channels || []).filter((c) => c && c.id && c.id !== Channels.OFFICIAL_ID);
    } catch (e) { return []; }
  },

  _aiItemOf(ch) {
    const noKey = (() => {
      try { return Channels._providerNoKey(ch.provider, ch.baseUrl); } catch (e) { return false; }
    })();
    return {
      id: "ai." + ch.id,
      group: "ai",
      label: ch.name || ch.id,
      secret: true,
      noKey: !!noKey,
      dynamic: true,
      channelId: ch.id,
      baseUrl: ch.baseUrl || "",
      model: ch.model || "",
      hint: noKey ? "本地接口，无需密钥" : (ch.baseUrl || ""),
      placeholder: noKey ? "无需填写" : "API Key",
      maxLen: 400,
      value: String(ch.apiKey || ""),
      configured: !!String(ch.apiKey || "").trim() || noKey,
      hosted: "ai_channels_keys",
    };
  },

  /**
   * 全量条目（含明文 value）。**调用方必须自己决定能不能把它放进 DOM**；
   * 界面层默认只渲染 mask(value)。
   * value 走 cached()：本机 pref 优先，其次「仅托管」模式下已水合的内存副本。
   */
  items() {
    const out = [];
    const only = this.hostedOnlyIds();
    for (const f of this.FIELDS) {
      const value = this.cached(f.id);
      out.push({
        id: f.id, group: f.group, label: f.label, secret: !!f.secret,
        pref: f.pref, hint: f.hint || "", placeholder: f.placeholder || "",
        maxLen: f.maxLen || 200, hosted: f.hosted || null, dynamic: false,
        bundle: f.bundle || null, hostedOnly: only.indexOf(f.id) >= 0,
        value, configured: !!String(value || "").trim(),
      });
    }
    for (const ch of this._aiChannels()) out.push(this._aiItemOf(ch));
    // 历史单通道 Key（0.14.0 多通道之前）：有值才列，避免多出一行看不懂的空条目
    const legacy = String(Prefs.get("aiApiKey", "") || "");
    if (legacy.trim()) {
      out.push({
        id: "ai.legacy", group: "ai", label: "旧版单通道 Key（历史）", secret: true,
        pref: "aiApiKey", hint: "0.14.0 之前的单通道配置；现在由「AI 模型通道」接管，仅迁移时有用",
        placeholder: "", maxLen: 200, hosted: null, dynamic: false,
        bundle: null, hostedOnly: false, legacy: true,
        value: legacy, configured: true,
      });
    }
    return out;
  },

  get(id) {
    return this.cached(id);
  },

  /** 内存水合值 → 本机 pref → ""（仅托管模式下 pref 为空，值只在内存里） */
  cached(id) {
    if (Object.prototype.hasOwnProperty.call(this._mem, id)) return this._mem[id];
    const f = this._findField(id);
    if (!f) return "";
    return this._decodeField(f, Prefs.get(f.pref, ""));
  },

  /**
   * 写入。空字符串 = 清除该项（不是存空串，避免"看起来配置了"）。
   * @returns {{ok:boolean, error?:string, cleared?:boolean}}
   */
  set(id, value) {
    const v = String(value == null ? "" : value);
    const item = this.items().find((x) => x.id === id);
    if (!item) return { ok: false, error: "未知的凭据项" };
    if (v.length > (item.maxLen || 200)) return { ok: false, error: "内容过长（上限 " + (item.maxLen || 200) + " 字符）" };

    if (item.dynamic) {
      // AI 通道：改 aiChannels JSON 里的 apiKey（保持通道其余字段不动）
      try {
        const doc = Channels._load();
        const ch = (doc.channels || []).find((c) => c && c.id === item.channelId);
        if (!ch) return { ok: false, error: "通道已不存在，请刷新" };
        ch.apiKey = v;
        Channels._save(doc);
        this.journal(v ? "edit" : "clear", id, item.label);
        return { ok: true, cleared: !v };
      } catch (e) {
        return { ok: false, error: (e && e.message) || "写入失败" };
      }
    }

    const f = this._findField(id);
    // 历史字段（旧版单通道 Key）没有 FIELDS 条目，但 item.pref 是可用落点
    const pref = f ? f.pref : item.pref;
    if (!pref) return { ok: false, error: "未知的凭据项" };
    try {
      Prefs.set(pref, f ? this._encodeField(f, v) : v);
      // 本机已有真值：内存水合副本作废，避免「面板显示 A、消费方用 B」
      try {
        delete this._mem[id];
        if (f && f.bundle === "cnki") { delete this._mem["cnki.user"]; delete this._mem["cnki.pass"]; }
      } catch (e2) { /* ignore */ }
      // 手改过的项自动退出「仅托管」——否则下次启动会被内存副本覆盖，用户以为保存丢了
      if (this.hostedOnlyIds().indexOf(id) >= 0) {
        this._setHostedOnlyFlag(id, false);
        if (f && f.bundle === "cnki") this._setHostedOnlyFlag("cnki.user", false);
      }
      this.journal(v ? "edit" : "clear", id, f ? f.label : item.label);
      return { ok: true, cleared: !v };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "写入失败" };
    }
  },

  clear(id) {
    return this.set(id, "");
  },

  /** 已配置项计数（界面顶部汇总） */
  stats() {
    const list = this.items();
    return { total: list.length, configured: list.filter((x) => x.configured).length };
  },

  /* ---------------- 账号托管（服务端 AES-256-GCM） ---------------- */

  _account() {
    try { return (typeof Account !== "undefined") ? Account : null; } catch (e) { return null; }
  },

  /** 托管能力是否可用（登录 + 客户端方法齐备） */
  hostedReady() {
    const A = this._account();
    return !!(A && A.isLoggedIn && A.isLoggedIn()
      && typeof A.hostedSecrets === "function"
      && typeof A.saveHostedSecret === "function");
  },

  /** 服务端托管现状：{ name: {set,hint,label,updatedAt} } */
  async hostedStatus() {
    const A = this._account();
    if (!A || !this.hostedReady()) return {};
    try { return (await A.hostedSecrets()) || {}; } catch (e) { return {}; }
  },

  /** AI 通道 Key 集合（只含有 key 的通道）→ JSON 串；无则返回 "" */
  _aiKeysPayload() {
    const map = {};
    for (const ch of this._aiChannels()) {
      const k = String(ch.apiKey || "").trim();
      if (k) map[ch.id] = k;
    }
    return Object.keys(map).length ? JSON.stringify(map) : "";
  },

  /**
   * 把某一项上传到账号托管（显式动作）。
   * AI 项上传的是「全部自定义通道 Key 的集合」——服务端按 name 存一份，
   * 逐通道分别存会撞上静态白名单（动态名不可枚举），也会让恢复变成 N 次请求。
   */
  async uploadHosted(id) {
    if (!this.hostedReady()) return { ok: false, error: "请先登录 Papilot 账号" };
    const item = this.items().find((x) => x.id === id);
    if (!item || !item.hosted) return { ok: false, error: "该项不支持账号托管" };
    const A = this._account();
    let name = item.hosted;
    let value = "";
    if (item.dynamic) {
      value = this._aiKeysPayload();
      if (!value) return { ok: false, error: "没有可托管的 API Key" };
    } else if (item.bundle === "cnki") {
      // 知网：一条托管里同时存账号与密码，否则换机取回只回来一半
      const u = String(this.cached("cnki.user") || "").trim();
      const p = String(this.cached("cnki.pass") || "");
      if (!p) return { ok: false, error: "请先填写知网密码，再存到账号" };
      if (!u) return { ok: false, error: "请先填写知网用户名（否则换机取回只有密码）" };
      value = JSON.stringify({ u, p, v: 2 });
      try {
        await A.saveHostedSecret(name, value);
        // 兼容副本：0.66.x 及更旧的客户端只认 cnki_password
        await A.saveHostedSecret("cnki_password", p);
        this.journal("host-up", id, item.label + "（含用户名）");
        return { ok: true, name, bundled: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || "上传失败" };
      }
    } else {
      value = String(item.value || "");
      if (!value) return { ok: false, error: "该项还没填写，无法托管" };
    }
    try {
      await A.saveHostedSecret(name, value);
      this.journal("host-up", id, item.label);
      return { ok: true, name };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "上传失败" };
    }
  },

  /**
   * 从账号托管恢复到本机。
   * 单字段：覆盖本机值（用户主动点的「取回」，期望就是覆盖）。
   * AI 集合：**只填空缺**，不覆盖本机已有 Key（多设备各自配过不同通道时，
   * 覆盖会让另一台机器的配置凭空消失）。
   */
  async downloadHosted(id) {
    if (!this.hostedReady()) return { ok: false, error: "请先登录 Papilot 账号" };
    const item = this.items().find((x) => x.id === id);
    if (!item || !item.hosted) return { ok: false, error: "该项不支持账号托管" };
    const A = this._account();
    try {
      // 知网：优先读合并副本；读不到再回落旧格式（只有密码）
      if (item.bundle === "cnki") {
        let obj = null;
        try {
          const v = await A.revealHostedSecret("cnki_account");
          obj = v ? JSON.parse(v) : null;
        } catch (e) { obj = null; }
        if (obj && (obj.p || obj.u)) {
          if (obj.u) this.set("cnki.user", String(obj.u));
          if (obj.p) this.set("cnki.pass", String(obj.p));
          this.journal("host-down", id, item.label + "（含用户名）");
          return { ok: true, bundled: true };
        }
        const p = await A.revealHostedSecret("cnki_password");
        if (!p) return { ok: false, error: "账号里没有保存知网凭据" };
        const r0 = this.set(id, p);
        if (r0.ok) this.journal("host-down", id, item.label + "（旧格式，仅密码）");
        return { ok: true, partial: true, warning: "账号里只有旧格式的密码副本，用户名仍需手填" };
      }
      const v = await A.revealHostedSecret(item.hosted);
      if (!v) return { ok: false, error: "账号里没有保存该项" };
      if (!item.dynamic) {
        const r = this.set(id, v);
        if (r.ok) this.journal("host-down", id, item.label);
        return r;
      }
      // AI：合并填空
      let map = {};
      try { map = JSON.parse(v) || {}; } catch (e) { return { ok: false, error: "托管内容格式异常" }; }
      const doc = Channels._load();
      let filled = 0;
      for (const ch of (doc.channels || [])) {
        if (!ch || ch.id === Channels.OFFICIAL_ID) continue;
        if (String(ch.apiKey || "").trim()) continue;
        const k = String(map[ch.id] || "").trim();
        if (k) { ch.apiKey = k; filled++; }
      }
      if (filled) Channels._save(doc);
      this.journal("host-down", id, item.label + "（填充 " + filled + " 个通道）");
      return filled
        ? { ok: true, filled }
        : { ok: false, error: "本机通道都已有密钥，未覆盖" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "取回失败" };
    }
  },

  /** 删除账号托管副本（本机值不动） */
  async removeHosted(id) {
    if (!this.hostedReady()) return { ok: false, error: "请先登录 Papilot 账号" };
    const item = this.items().find((x) => x.id === id);
    if (!item || !item.hosted) return { ok: false, error: "该项不支持账号托管" };
    try {
      await this._account().deleteHostedSecret(item.hosted);
      if (item.bundle === "cnki") {
        try { await this._account().deleteHostedSecret("cnki_password"); } catch (e2) { /* 副本可能本就不存在 */ }
      }
      this.journal("host-del", id, item.label);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "删除失败" };
    }
  },

  /* ---------------- 仅托管模式（本机不留值） ---------------- */

  /**
   * 「仅托管」= 值只存在服务端密文里，本机 pref 清空；运行时把值水合到**内存**
   * （`_mem`，不落盘），消费方经 CredVault.cached() 取。
   *
   * 代价必须让用户知道：**离线 / 未登录 Papilot 账号时，该项功能不可用**。
   * 所以它是 per-item 的可选项（默认关），不是全局开关。
   */
  hostedOnlyIds() {
    try {
      const v = JSON.parse(Prefs.get(this.K.hostedOnly, "") || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
    } catch (e) { return []; }
  },

  hasHostedOnly() {
    return this.hostedOnlyIds().length > 0;
  },

  _setHostedOnlyFlag(id, on) {
    const list = this.hostedOnlyIds().filter((x) => x !== id);
    if (on) list.push(id);
    try { Prefs.set(this.K.hostedOnly, JSON.stringify(list)); } catch (e) { /* ignore */ }
  },

  /**
   * 打开 / 关闭某一项的「仅托管」。
   * 打开：先上传（失败就不动本机，避免"本机清了、云端也没有"），再把值搬进内存并清 pref。
   * 关闭：把内存值写回本机，清标记。
   */
  async setHostedOnly(id, on) {
    const item = this.items().find((x) => x.id === id);
    if (!item || !item.secret || !item.hosted) return { ok: false, error: "该项不支持仅托管" };
    if (item.dynamic) return { ok: false, error: "AI 通道 Key 不支持仅托管（清掉等于删通道）" };
    if (on) {
      if (!this.hostedReady()) return { ok: false, error: "请先登录 Papilot 账号" };
      const up = await this.uploadHosted(id);
      if (!up.ok) return up;
      if (item.bundle === "cnki") {
        this._mem["cnki.user"] = String(this.cached("cnki.user") || "");
        this._mem["cnki.pass"] = String(this.cached("cnki.pass") || "");
        Prefs.set("cnkiUsername", "");
        Prefs.set("cnkiPassword", "");
      } else {
        this._mem[id] = String(item.value || "");
        Prefs.set(item.pref, "");
      }
      this._setHostedOnlyFlag(id, true);
      this._hydratedAt = Date.now();
      this.journal("host-only-on", id, item.label);
      return { ok: true };
    }
    // 关：内存值回写本机
    const back = Object.keys(this._mem);
    for (const key of back) {
      const f = this._findField(key);
      if (!f) { delete this._mem[key]; continue; }
      try {
        if (!String(Prefs.get(f.pref, "") || "").trim()) {
          Prefs.set(f.pref, this._encodeField(f, this._mem[key]));
        }
      } catch (e) { /* 单项失败保留内存值 */ }
      delete this._mem[key];
    }
    this._setHostedOnlyFlag(id, false);
    if (item.bundle === "cnki") this._setHostedOnlyFlag("cnki.user", false);
    this.journal("host-only-off", id, item.label);
    return { ok: true };
  },

  /**
   * 把「仅托管」项从账号取回到内存（不落盘）。启动与同步前调用；60 秒内不重复。
   * @returns {Promise<number>} 实际水合的字段数
   */
  async hydrateHostedOnly(force) {
    const ids = this.hostedOnlyIds();
    if (!ids.length || !this.hostedReady()) return 0;
    if (!force && this._hydratedAt && Date.now() - this._hydratedAt < 60000) return 0;
    const A = this._account();
    let n = 0;
    for (const id of ids) {
      const item = this.items().find((x) => x.id === id);
      if (!item || !item.hosted) continue;
      try {
        if (item.bundle === "cnki") {
          if (this._mem["cnki.pass"]) continue;
          let obj = null;
          try { obj = JSON.parse(await A.revealHostedSecret("cnki_account")); } catch (e) { obj = null; }
          if (obj && obj.u) { this._mem["cnki.user"] = String(obj.u); n++; }
          if (obj && obj.p) { this._mem["cnki.pass"] = String(obj.p); n++; }
        } else {
          if (this._mem[id]) continue;
          const v = await A.revealHostedSecret(item.hosted);
          if (v) { this._mem[id] = String(v); n++; }
        }
      } catch (e) {
        // 离线 / 未登录 / 限速：整体降级，不抛给调用方（UI 会显示「仅托管待联网」）
      }
    }
    this._hydratedAt = Date.now();
    return n;
  },

  /** 仅托管项当前是否已水合（UI 据此区分「有值」与「待联网取回」） */
  hydrateState(id) {
    if (Object.prototype.hasOwnProperty.call(this._mem, id)) return "ready";
    const item = this.items().find((x) => x.id === id);
    if (!item || !item.hostedOnly) return "";
    return this.hostedReady() ? "pending" : "offline";
  },

  /* ---------------- 本地审计（不含明文） ---------------- */

  journal(action, id, note) {
    try {
      const list = this.recentJournal();
      list.unshift({ t: Date.now(), a: String(action || ""), id: String(id || ""), n: String(note || "").slice(0, 80) });
      Prefs.set(this.K.audit, JSON.stringify(list.slice(0, this.JOURNAL_MAX)));
    } catch (e) { /* 审计失败绝不能挡住主流程 */ }
  },

  recentJournal() {
    try {
      const v = JSON.parse(Prefs.get(this.K.audit, "") || "[]");
      return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
    } catch (e) { return []; }
  },

  /** 清空审计：**清空动作本身也留一条**（否则"谁把痕迹擦了"无从查起） */
  clearJournal() {
    try {
      const rec = { t: Date.now(), a: "audit-clear", id: "", n: "清空访问记录" };
      Prefs.set(this.K.audit, JSON.stringify([rec]));
    } catch (e) { /* ignore */ }
  },

  /** 明文自动隐藏秒数（0 = 手动隐藏） */
  autoHideSec() {
    const n = Number(Prefs.get(this.K.autoHide, 30));
    return isFinite(n) && n >= 0 ? n : 30;
  },

  /** 状态汇总（界面顶部徽标用；不含任何值） */
  headline() {
    const st = this.stats();
    const acc = this.access();
    return {
      configured: st.configured,
      total: st.total,
      locked: !acc.pro,
      passcode: this.hasPasscode(),
      hosted: this.hostedReady(),
    };
  },
};
