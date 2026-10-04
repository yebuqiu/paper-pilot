/* PaperPilot 账号系统（0.14.0 新增；0.15.0 收口服务器入口；0.23.0 持久化层重写 + 会员体系）
 *
 * 一、登录与鉴权
 * - 邮箱密码登录 PaperPilot 官方账号服务器（地址内置固定 https://pp.xinglintools.top，
 *   设置界面不提供服务器入口，不开放自建后台）
 * - 令牌只出现在 Authorization 头；密码只进请求体，永不落盘、不进日志
 * - 登录过期：本地 expiresAt 判断 + 服务端 401 双保险；任何官方模型调用遇 401
 *   自动失效会话并弹窗提醒重新登录（403/网络层错误一律不清会话）
 *
 * 二、会话持久化 v2（0.23.0 重写，根治「更新 xpi 后掉登录」）
 * 旧实现（≤0.22.0）的四个结构性缺陷：
 *   ① restore() 按「数据目录 → ProfD」顺序取第一份带 token 的文件就 break，
 *      若该份本地判过期直接 return —— 另一落点更新的副本永远读不到；
 *   ② _save() 把写失败 catch 掉继续返回，调用方以为成功 —— UI 显示「登录成功」，
 *      磁盘上却没有会话，重启即掉；
 *   ③ 只有一份代际，没有备份，任何一次损坏/被清理都无恢复源；
 *   ④ _diag 用「读全文再写回」且写失败静默丢弃 —— 掉登录时拿不到任何证据。
 *
 * 新布局：2 个落点 × 3 代滚动副本 = 最多 6 份，按 savedAt 取最新有效者。
 *   <落点>/paperpilot-account.json      第 0 代（最新）
 *   <落点>/paperpilot-account.1.json    第 1 代
 *   <落点>/paperpilot-account.2.json    第 2 代
 *   落点 = Zotero 数据目录（Zotero.DataDirectory.dir）+ 配置目录（ProfD）
 * 写入：滚动代际 → 写第 0 代（tmp+rename）→ 回读校验 → 失败自动回退直写；
 *       全程带硬超时（杜绝「写操作永不 resolve」导致登录卡死且无日志）。
 * 读取：收集全部 6 份 → JSON 解析 → 按 savedAt 降序 → 最新者胜。
 * 墓碑：用户登出 / 服务端确认 401 时，把**全部代际**覆盖为 revoked 墓碑
 *       （令牌物理清除 + 阻止旧代际把已登出的会话「复活」）。
 * 迁移：旧版单文件即第 0 代，天然兼容；读取时无 schemaVersion 视为 v1，
 *       首次成功写入即升级为 v2，旧内容自动滚动进第 1 代作为备份。
 * 卸载：bootstrap 的 uninstall 钩子绝不动会话文件（更新/重装会触发 uninstall）。
 *
 * 三、登录设备（0.24.7）
 * - 本机生成一次 installId（非敏感标识，存 pref）并随请求上报，供服务端识别"这是哪台机器"
 *   —— 服务端据此才能回答「这个账号在几台机器上登录着」，也才有据可查账号共享。
 * - installId **不是凭据**（可伪造），只用于展示与异常检测，绝不参与鉴权。
 * - 不上报主机名等更多标识：本机拿不到可靠主机名（Zotero 10 的 Firefox 基座已移除
 *   Services.sysinfo），设备名改由用户自己命名（PUT /api/sessions/:sid）—— 既够用又最小必要。
 *
 * 四、会员（0.23.0）
 * - 等级 Free / Pro；额度、价格档位、收款信息全部由服务端下发（可后台调整）
 * - 购买：插件内下单（服务端返回订单号 + 收款信息）→ 用户付款后点「我已完成支付」
 *         → 管理员核销 → 会员自动开通（订单绑定账号，无需手动输码）
 * - 激活：兑换码 / 激活码（线下售卖、赠送、补偿），插件内输码即开通
 * - 有效期：激活按「max(现在, 现有到期) + 时长」叠加续期，升级不吞掉剩余时长
 *
 * 服务端契约（OpenAI 兼容网关 + 鉴权 + 会员）：
 *   POST {server}/api/auth/login    {email,password}
 *     → 200 {ok:true, token, expiresAt(ISO), user:{email,name,plan,dailyUsed,dailyLimit,membership}}
 *   POST {server}/api/auth/logout   Authorization: Bearer <token> → 200 {ok:true}
 *   GET  {server}/api/auth/me       Bearer → 200 {ok:true, user:{...}, expiresAt?}（返回即滑动续期）
 *   POST {server}/api/auth/register {email,password,nickname} → 200 {ok,user,notice}
 *   GET  {server}/api/plans         → 200 {ok, plans:[...], priceOptions:[...], pay:{...}}
 *   POST {server}/api/orders        Bearer {plan,months} → 200 {ok, order}
 *   GET  {server}/api/orders/:id    Bearer → 200 {ok, order}
 *   POST {server}/api/orders/:id/claim Bearer → 200 {ok, order}（标记「我已付款」）
 *   POST {server}/api/redeem        Bearer {code} → 200 {ok, membership, user}
 *   GET  {server}/api/membership    Bearer → 200 {ok, membership}
 *   GET  {server}/v1/models | POST {server}/v1/chat/completions  Bearer <token>
 */
/* global Zotero, Services, Components, IOUtils, PathUtils, Prefs, crypto, setTimeout, clearTimeout */

var Account = {
  _session: null,       // {token, expiresAt(ms), user:{}}，仅存内存；落盘走 _save
  _listeners: [],
  _restoring: false,
  _diagChain: Promise.resolve(),  // 诊断日志串行队列（并发读-改-写会互相覆盖）
  // 最近一次落盘结果（设置面板据此提示「会话无法写入磁盘」）
  persistStatus: { attempted: false, ok: false, wrote: 0, total: 0, at: 0, errors: [] },

  // 官方账号服务器（0.15.0 起内置固定）
  SERVER_DEFAULT: "https://pp.xinglintools.top",

  // 本地会话有效期（0.15.1）：与服务端 TOKEN_TTL 对齐（30 天滑动）
  SESSION_TTL_MS: 30 * 86400e3,

  /* ---------- 持久化布局常量 ---------- */
  SCHEMA_VERSION: 2,
  FILE_BASE: "paperpilot-account",   // 第 0 代 = paperpilot-account.json（兼容旧版）
  GENERATIONS: 3,                    // 每落点保留 3 代
  WRITE_TIMEOUT_MS: 8000,            // 单次文件读写硬上限
  DIAG_MAX_LINES: 400,               // 诊断日志上限（防止无限增长）

  /** 账号服务器根地址（无末尾斜杠）。网关 = server + /v1 */
  serverUrl() {
    return String(Prefs.get("accountServerUrl", this.SERVER_DEFAULT) || this.SERVER_DEFAULT)
      .replace(/\/+$/, "");
  },

  /** 官方网关 Base URL（OpenAI 兼容 /v1），供通道管理引用 */
  gatewayUrl() {
    return this.serverUrl() + "/v1";
  },

  isLoggedIn() {
    return !!this._session && !this._expired();
  },

  token() {
    return this.isLoggedIn() ? this._session.token : "";
  },

  /** 当前用户信息（未登录返回 null；过期视为未登录） */
  user() {
    return this.isLoggedIn() ? this._session.user || {} : null;
  },

  expiresAt() {
    return this._session ? this._session.expiresAt || 0 : 0;
  },

  _expired() {
    return !!(this._session && this._session.expiresAt && Date.now() > this._session.expiresAt);
  },

  /* ==================== 会话仓库（多落点 × 多代滚动） ==================== */

  /**
   * 会话落点目录（按优先级）。0.20.0 双落点起，0.23.0 沿用：
   * 单落点一旦写失败（权限 / 被同步工具搬走 / 目录变更）用户就表现为
   * 「更新后掉登录」且无从恢复；两个落点互为兜底。
   */
  _storeDirs() {
    const out = [];
    const push = (p) => { if (p && out.indexOf(p) < 0) out.push(p); };
    try {
      const d = Zotero.DataDirectory && Zotero.DataDirectory.dir;
      if (d) push(String(d));
    } catch (e) { /* 数据目录未就绪：仅用 profile 落点 */ }
    try {
      const prof = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
      if (prof && prof.path) push(String(prof.path));
    } catch (e) { /* ignore */ }
    return out;
  },

  /** 某落点的 3 代文件路径（索引 0 = 最新） */
  _genPaths(dir) {
    const out = [PathUtils.join(dir, this.FILE_BASE + ".json")];
    for (let i = 1; i < this.GENERATIONS; i++) {
      out.push(PathUtils.join(dir, this.FILE_BASE + "." + i + ".json"));
    }
    return out;
  },

  /** 全部候选路径（落点 × 代际），供读取与自检 */
  _allPaths() {
    const out = [];
    for (const dir of this._storeDirs()) {
      const paths = this._genPaths(dir);
      for (let i = 0; i < paths.length; i++) out.push({ path: paths[i], dir, gen: i });
    }
    return out;
  },

  /** 诊断日志路径（与启动日志同源：数据目录 + 配置目录） */
  _logPaths() {
    const out = [];
    for (const dir of this._storeDirs()) {
      try { out.push(PathUtils.join(dir, this.FILE_BASE + ".log")); } catch (e) { /* ignore */ }
    }
    return out;
  },

  /**
   * 账号生命周期诊断：Zotero.debug + 落盘 account.log（下次掉登录可回溯）。
   * 0.23.0：改为串行队列 + 行数上限（旧实现并发读-改-写会互相覆盖、无上限增长）。
   */
  _diag(msg) {
    try { Zotero.debug("PaperPilot account: " + msg); } catch (e) { /* ignore */ }
    const line = new Date().toISOString() + " " + msg + "\n";
    this._diagChain = this._diagChain
      .then(() => this._appendLog(line))
      .catch(() => { /* 诊断失败不影响主流程 */ });
    return this._diagChain;
  },

  async _appendLog(line) {
    for (const p of this._logPaths()) {
      try {
        let old = "";
        try { old = await this._withTimeout(IOUtils.readUTF8(p), 3000, "readUTF8"); } catch (e) { /* 无文件 */ }
        let text = String(old || "") + line;
        const lines = text.split("\n");
        if (lines.length > this.DIAG_MAX_LINES) {
          text = lines.slice(lines.length - this.DIAG_MAX_LINES).join("\n");
        }
        // ⚠️ 不传任何 options：IOUtils 的 options.mode 是 "append"/"create"/"overwrite"
        // 字符串开关，不是 UNIX 权限位。旧代码传 {mode: 0o600} 属 API 误用。
        await this._withTimeout(IOUtils.writeUTF8(p, text), 3000, "writeUTF8");
      } catch (e) { /* 单落点失败：试下一个 */ }
    }
  },

  /** Promise 硬超时（杜绝「IO 永不 resolve」把登录卡死且无任何日志） */
  _withTimeout(promise, ms, tag) {
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((tag || "IO") + " 超时（" + ms + "ms）")), ms);
    });
    return Promise.race([Promise.resolve(promise), guard]).then(
      (v) => { if (timer) clearTimeout(timer); return v; },
      (e) => { if (timer) clearTimeout(timer); throw e; }
    );
  },

  /**
   * 单文件写 + 回读校验。
   * 优先带 tmpPath 原子写（写一半崩溃不留半截文件）；失败回退**无选项直写**
   * —— 无选项写法是本插件其余模块（rank-column / citation-column / cn-translators）
   * 长期验证可用的形态。写完一律回读比对内容，「写成功但内容不符」同样算失败，
   * 绝不谎报成功。
   *
   * ⚠️ 不要再往 options 里塞 `mode: 0o600`：IOUtils 的 options.mode 语义是
   * 字符串开关（"append"/"create"/"overwrite"），不是 UNIX 权限位。旧实现
   * 传数字 mode 是 API 误用，也是「唯一写不出去的文件恰好只有会话文件」的嫌疑点。
   */
  async _writeFile(path, text) {
    let lastErr = null;
    const variants = [{ tmpPath: path + ".tmp" }, null];
    for (const opts of variants) {
      try {
        const p = opts ? IOUtils.writeUTF8(path, text, opts) : IOUtils.writeUTF8(path, text);
        await this._withTimeout(p, this.WRITE_TIMEOUT_MS, "writeUTF8");
        const back = await this._withTimeout(IOUtils.readUTF8(path), this.WRITE_TIMEOUT_MS, "readUTF8");
        if (back === text) return true;
        lastErr = new Error("回读校验不一致（期望 " + text.length + " 字节，实得 " + String(back).length + "）");
        this._diag("写入回读不一致 @ " + path + "（将回退直写）");
      } catch (e) {
        lastErr = e;
        this._diag("写入尝试失败 @ " + path + (opts ? "（tmpPath）" : "（直写）") + " :: " + (e && e.message));
      }
    }
    throw lastErr || new Error("写入失败");
  },

  /**
   * 代际滚动：gen1 ← gen0 的旧内容，gen2 ← gen1 的旧内容。
   * 首次落盘（没有旧代际）时用**新内容**填充 gen1/gen2 —— 这样「登录成功」这一
   * 瞬间就立刻有 3 代副本（2 落点共 6 份），而不是要等第二次写入才出现备份。
   * 必须先全部读完再写，否则会自己覆盖自己。
   */
  async _rollDir(paths, fresh) {
    let c0 = null, c1 = null;
    try { c0 = await this._withTimeout(IOUtils.readUTF8(paths[0]), 3000, "readUTF8"); } catch (e) { /* 无旧文件 */ }
    try { c1 = await this._withTimeout(IOUtils.readUTF8(paths[1]), 3000, "readUTF8"); } catch (e) { /* ignore */ }
    const nextG1 = c0 !== null ? c0 : fresh;
    const nextG2 = c1 !== null ? c1 : (c0 !== null ? c0 : fresh);
    try { await this._writeFile(paths[1], nextG1); } catch (e) { /* 备份失败不阻断主写 */ }
    try { await this._writeFile(paths[2], nextG2); } catch (e) { /* ignore */ }
  },

  /**
   * 写入一份会话文档到全部落点（含代际滚动 + 回读校验）。
   * 返回 {ok, wrote, total, errors}；调用方据此判断是否真的落盘成功。
   */
  async _writeDoc(doc, label) {
    const dirs = this._storeDirs();
    const body = JSON.stringify(doc);
    const errors = [];
    let wrote = 0;
    if (!dirs.length) {
      this.persistStatus = { attempted: true, ok: false, wrote: 0, total: 0, at: Date.now(),
        errors: ["无法解析任何可写目录（数据目录与 ProfD 均不可用）"] };
      this._diag((label || "write") + " SKIPPED: 无可用落点");
      return { ok: false, wrote: 0, total: 0, errors: this.persistStatus.errors };
    }
    for (const dir of dirs) {
      const paths = this._genPaths(dir);
      try {
        await this._rollDir(paths, body);
        await this._writeFile(paths[0], body);
        wrote++;
      } catch (e) {
        errors.push(dir + " :: " + (e && e.message));
      }
    }
    this.persistStatus = { attempted: true, ok: wrote > 0, wrote, total: dirs.length, at: Date.now(), errors };
    this._diag((label || "write") + " → " + wrote + "/" + dirs.length + " 落点"
      + (errors.length ? "；失败：" + errors.join(" ｜ ") : ""));
    return { ok: wrote > 0, wrote, total: dirs.length, errors };
  },

  /** 读取全部候选副本：按 savedAt 降序（缺失 savedAt 记 0），附来源信息 */
  async _readSlots() {
    const out = [];
    const dirs = this._storeDirs();
    for (const slot of this._allPaths()) {
      let raw = null;
      try { raw = await this._withTimeout(IOUtils.readUTF8(slot.path), 3000, "readUTF8"); }
      catch (e) { continue; } // 无文件/读失败：跳过该代
      let doc = null;
      try { doc = JSON.parse(raw); } catch (e) {
        this._diag("副本损坏（保留现场，不删）：" + slot.path);
        continue;
      }
      if (!doc || typeof doc !== "object") continue;
      const di = dirs.indexOf(slot.dir);
      out.push({
        path: slot.path, dir: slot.dir, gen: slot.gen, doc,
        savedAt: Number(doc.savedAt) || 0,
        dirLabel: (di === 0 ? "数据目录" : "ProfD") + (di < 0 ? "?" : ""),
      });
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  },

  /**
   * 会话文档（v2 信封）。membership 一并落盘，离线也能显示会员等级与到期日。
   */
  _sessionDoc(reason) {
    return {
      schemaVersion: this.SCHEMA_VERSION,
      app: "paperpilot",
      token: this._session.token,
      expiresAt: this._session.expiresAt || 0,
      user: this._session.user || {},
      savedAt: Date.now(),
      reason: reason || "",
    };
  },

  /**
   * 落盘（登录 / 刷新 / 滑动续期 / 会员变化都走这里）。
   * 写不成功**不再静默吞掉**：persistStatus 记录真实结果，设置面板据此提示。
   */
  async _save(reason) {
    if (!this._session) return false;
    const r = await this._writeDoc(this._sessionDoc(reason), "session saved（" + (reason || "save") + "）");
    return r.ok;
  },

  /**
   * 墓碑清除（登出 / 服务端确认 401 / 检测到最新副本已登出时同步）。
   * 关键：覆盖**全部代际**。只删第 0 代的话，第 1/2 代里的旧令牌会在下次
   * 启动时被 restore 读出来 —— 用户「登出后重启又自动登录」。
   * 覆盖为 revoked 而不是简单删除：既物理清除令牌，又留下「已登出」的证据，
   * 防止另一落点残留的有效副本把会话复活。
   */
  async _wipe(reason) {
    const doc = {
      schemaVersion: this.SCHEMA_VERSION, app: "paperpilot",
      revoked: true, savedAt: Date.now(), reason: reason || "logout",
    };
    const body = JSON.stringify(doc);
    let ok = 0, total = 0;
    for (const dir of this._storeDirs()) {
      for (const p of this._genPaths(dir)) {
        total++;
        try { await this._writeFile(p, body); ok++; } catch (e) { /* 尽力而为 */ }
      }
    }
    this.persistStatus = { attempted: true, ok: ok > 0, wrote: ok, total, at: Date.now(), errors: [] };
    this._diag("会话已按墓碑清除（" + (reason || "logout") + "，覆盖 " + ok + "/" + total + " 份）");
  },

  /* ---------- 启动恢复：读全部副本 → 最新者胜 → 尽力刷新 ---------- */

  async restore() {
    if (this._restoring) return;
    this._restoring = true;
    try {
      const slots = await this._readSlots();
      if (!slots.length) {
        this._diag("restore: 未找到任何会话副本（落点 " + this._storeDirs().length
          + " 个 × " + this.GENERATIONS + " 代全空）");
        return;
      }
      const best = slots[0];
      this._diag("restore: 发现 " + slots.length + " 份副本，最新来自 " + best.dirLabel
        + " 第" + best.gen + "代（savedAt=" + new Date(best.savedAt).toISOString() + "）");
      if (best.doc.revoked) {
        // 最新动作是登出：保持登出，并把其余落点也写成墓碑（避免复活）
        this._diag("restore: 最新副本是登出墓碑 → 保持登出");
        await this._wipe("restore-seen-revoked");
        return;
      }
      if (!best.doc.token) {
        this._diag("restore: 最新副本无令牌");
        return;
      }
      this._session = {
        token: String(best.doc.token),
        expiresAt: Number(best.doc.expiresAt) || 0,
        user: best.doc.user || {},
      };
      // 0.23.0：本地判过期**不再 return 放弃**（旧实现会因此永远读不到另一落点
      // 更新的副本），也不删文件 —— 服务端可能已滑动续期而本地落盘落后一步。
      // 一律交 refreshUser 的 401 定论（首答 401 还会复核一次）。
      if (this._session.expiresAt && Date.now() > this._session.expiresAt) {
        this._diag("restore: 本地已过期，仍交服务端定论（文件保留）");
      }
      if (best.doc.schemaVersion !== this.SCHEMA_VERSION) {
        this._diag("restore: 副本为 v" + (best.doc.schemaVersion || 1) + " 旧格式，解析后已按 v2 兼容读取");
      }
      await this.refreshUser({ silent: true });
    } catch (e) {
      this._diag("restore 异常: " + (e && e.message));
    } finally {
      this._restoring = false;
      this._notify(); // 恢复结束（无论刷新成败）通知 UI 对齐登录态
    }
  },

  /** 持久化自检（启动时写进 boot 日志；下次「掉登录」可直接看结论） */
  async selfCheck() {
    try {
      const dirs = this._storeDirs();
      const slots = await this._readSlots();
      const newest = slots[0];
      return "account store: dirs=" + dirs.length + " copies=" + slots.length
        + (newest ? " newest=" + newest.dirLabel + "#" + newest.gen
          + " savedAt=" + new Date(newest.savedAt).toISOString()
          + (newest.doc.revoked ? " [revoked]" : "") : " newest=-")
        + " loggedIn=" + this.isLoggedIn();
    } catch (e) {
      return "account selfCheck failed: " + (e && e.message);
    }
  },

  /* ---------- 登录 / 登出 ---------- */

  /**
   * 邮箱密码登录。成功返回 user 对象；失败抛可读中文错误。
   * 密码只进请求体，不落盘不进日志。
   */
  async login(email, password) {
    email = String(email || "").trim();
    password = String(password || "");
    if (!email || !password) throw new Error("请填写邮箱和密码");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");

    const resp = await this._request("POST", "/api/auth/login", { email, password }, null, 15000);
    const j = resp.json || {};
    if (!j.ok || !j.token) throw new Error(j.error || "登录失败：服务端应答异常");
    if (j.expiresAt && Date.now() > Date.parse(j.expiresAt)) {
      throw new Error("登录失败：服务端返回的会话已过期");
    }
    this._session = {
      token: String(j.token),
      expiresAt: j.expiresAt ? Date.parse(j.expiresAt) || 0 : 0,
      user: j.user || { email },
    };
    // 落盘结果如实上报（旧实现在此静默吞掉写失败 → 用户看到「登录成功」却掉登录）
    const saved = await this._save("login");
    this._notify();
    try { Zotero.debug("PaperPilot: account login ok (" + this._mask(j.token) + "), persisted=" + saved); } catch (_) { /* ignore */ }
    return this._session.user;
  },

  /**
   * 自助注册（0.20.0 内置注册界面）：成功后按服务端返回决定是否需邮箱验证。
   * 返回 {user, notice, needVerify}；失败抛可读中文错误。
   */
  async register(email, password, nickname) {
    email = String(email || "").trim();
    password = String(password || "");
    nickname = String(nickname || "").trim();
    if (!email || !password) throw new Error("请填写邮箱和密码");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");
    if (password.length < 8) throw new Error("密码至少 8 位");
    const resp = await this._request("POST", "/api/auth/register",
      { email, password, nickname: nickname || undefined }, null, 25000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "注册失败：服务端应答异常");
    const status = (j.user && j.user.status) || "active";
    this._diag("register ok: " + email + " status=" + status);
    return { user: j.user || {}, notice: j.notice || "", needVerify: status === "pending" };
  },

  /** 重发验证邮件（内置注册界面用） */
  async resendVerify(email) {
    const resp = await this._request("POST", "/api/auth/resend",
      { email: String(email || "").trim() }, null, 20000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "发送失败");
    return j.message || "验证邮件已重新发送，请查收（含垃圾邮件箱）";
  },

  /** 登出：通知服务端（尽力而为，2s 超时不阻塞）+ 本地墓碑清除 */
  async logout({ silent } = {}) {
    const token = this._session && this._session.token;
    this._session = null;
    await this._wipe("user-logout");
    this._notify();
    if (token) {
      try { await this._request("POST", "/api/auth/logout", null, token, 2000); } catch (e) { /* 服务端登出失败不影响本地登出 */ }
    }
    if (!silent) {
      try { Zotero.debug("PaperPilot: account logout"); } catch (_) { /* ignore */ }
    }
  },

  /**
   * 刷新用户信息（用量/套餐/会员/续期）。401 → 会话失效；其余失败静默保留旧数据。
   * silent: 不弹 401 提醒（启动恢复路径用——不惊扰，UI 自然显示未登录）
   */
  async refreshUser({ silent } = {}) {
    if (!this._session) return null;
    let resp = null;
    let fail = null;
    try {
      resp = await this._request("GET", "/api/auth/me", null, this._session.token, 10000);
    } catch (e) {
      fail = e;
      if (e && e.auth) {
        // 401 先复核一次再定论。服务端重启/落盘延迟/边缘节点瞬时误判都可能让
        // 首答是 401，直接清会话正是用户看到的「更新后掉登录」。
        try {
          await new Promise((r) => setTimeout(r, 900));
          resp = await this._request("GET", "/api/auth/me", null, this._session.token, 10000);
          fail = null;
          this._diag("refreshUser: 首次 401，复核成功 —— 保留会话");
        } catch (e2) {
          if (!(e2 && e2.auth)) {
            this._diag("refreshUser: 401 后遇网络层错误 —— 无法判定，保留会话");
            return this._session.user;
          }
          fail = e2;
        }
      }
    }
    if (fail) {
      if (fail.auth) {
        this._diag("refreshUser: 两次均为 401 —— 清除会话");
        await this.handleAuthFailure(fail.message, { silent });
      }
      throw fail;
    }
    const j = (resp && resp.json) || {};
    if (!j.ok || !j.user) throw new Error(j.error || "刷新失败：服务端应答异常");
    this._session.user = j.user;
    if (j.expiresAt) {
      const exp = Date.parse(j.expiresAt);
      if (exp && exp > (this._session.expiresAt || 0)) this._session.expiresAt = exp; // 滑动续期
    }
    await this._save("refresh");
    this._notify();
    return this._session.user;
  },

  /**
   * 会话失效统一出口（AIClient 官方通道 401 / refreshUser 401 都走这里）：
   * 墓碑清除 + 弹窗提醒 + 通知 UI。silent 时只清不弹（启动恢复阶段）。
   * 仅 401 触发；403（Cloudflare/WAF 拦截等）不再视为会话失效。
   */
  async handleAuthFailure(reason, { silent } = {}) {
    if (!this._session) return;
    this._session = null;
    await this._wipe("auth-401");
    this._notify();
    if (!silent) {
      try {
        Services.prompt.alert(
          Zotero.getMainWindow(),
          "PaperPilot 账号",
          "登录已过期或已失效：" + (reason || "请重新登录") + "\n\n请到 设置 → PaperPilot 重新登录后继续使用官方模型。"
        );
      } catch (e) { /* ignore */ }
    }
  },

  /**
   * 本地会话滑动续期（0.15.1）：官方网关调用成功后由 AIClient 调用，
   * 与服务端 touchTokenSoon 对齐（now + 30 天），并异步落盘。
   * 防御：未登录 / 新有效期不比现存值更晚时不动。
   */
  touchSession() {
    if (!this._session) return;
    const exp = Date.now() + this.SESSION_TTL_MS;
    if (exp <= (this._session.expiresAt || 0)) return;
    this._session.expiresAt = exp;
    this._save("touch").catch(() => { /* 落盘失败不影响调用链 */ });
  },

  /* ==================== 会员（0.23.0） ==================== */

  /** 本地缓存的会员信息（离线可用）；未登录或无会员字段返回 Free 视图 */
  membership() {
    const u = this.user();
    if (!u) return null;
    const m = u.membership;
    if (m && m.plan) {
      return {
        plan: m.plan,
        name: m.name || m.plan,
        rawPlan: m.rawPlan || m.plan,
        expired: !!m.expired,
        expiresAt: m.expiresAt ? (Number(m.expiresAt) || Date.parse(m.expiresAt) || 0) : 0,
        dailyLimit: Number(m.dailyLimit) > 0 ? Number(m.dailyLimit) : 0,
        source: m.source || "",
        activatedAt: m.activatedAt || "",
        perpetual: !!m.perpetual,   // 0.24.5 永久会员（无到期日）
        // 0.24.4：购买历史（续费默认周期取最近一次；到期提醒也用它判"曾经是付费用户"）
        history: Array.isArray(m.history) ? m.history : [],
      };
    }
    // 兼容旧服务端：只有 plan/expiresAt 字段
    const exp = typeof u.expiresAt === "number" ? u.expiresAt : (u.expiresAt ? Date.parse(u.expiresAt) || 0 : 0);
    return { plan: u.plan || "Free", name: u.plan || "Free", rawPlan: u.plan || "Free", expired: false,
      expiresAt: exp, dailyLimit: Number(u.dailyLimit) > 0 ? Number(u.dailyLimit) : 0, source: "", activatedAt: "",
      perpetual: !!u.plan && u.plan !== "Free" && !exp, history: [] };
  },

  /** 用量（近 30 天按日 + 近 7 天合计）；离线时回落本地缓存字段 */
  usage() {
    const u = this.user();
    const us = (u && u.usage) || null;
    if (us && Array.isArray(us.days) && us.days.length) {
      return {
        today: Number(us.today) || 0,
        limit: Number(us.limit) || 0,
        last7: Number(us.last7) || us.days.slice(-7).reduce((s, d) => s + (Number(d && d.count) || 0), 0),
        days: us.days,
      };
    }
    return { today: Number(u && u.dailyUsed) || 0, limit: Number(u && u.dailyLimit) || 0, last7: 0, days: [] };
  },

  /**
   * 套餐 AI 能力（1.4.9）。服务端在 /api/auth/me 与 /api/membership 里下发，随会话缓存。
   * @returns {{highTier:boolean, reason:"plan"|"trial"|"none"|"unknown", trial:object|null,
   *            models:string[], lockedModels:string[], defaultModel:string}}
   *
   * **旧服务端（无 ai 块）一律返回「不限制」**：模型能不能用由服务端网关说了算，
   * 客户端不知道时绝不自作主张去锁用户（否则老服务端会被新插件锁死）。
   */
  ai() {
    const u = this.user();
    const a = u && u.ai;
    if (a && typeof a === "object") {
      return {
        highTier: !!a.highTier,
        reason: a.reason || "none",
        trial: a.trial && typeof a.trial === "object" ? a.trial : null,
        models: Array.isArray(a.models) ? a.models : [],
        lockedModels: Array.isArray(a.lockedModels) ? a.lockedModels : [],
        defaultModel: a.defaultModel || "auto",
      };
    }
    return { highTier: true, reason: "unknown", trial: null, models: [], lockedModels: [], defaultModel: "auto" };
  },

  /**
   * AI 额度余额（0.26.0，服务端 1.6.0）。
   * 三档：注册赠送（有期，限基础模型）/ 订阅额度（当期有效不结转）/ 充值（永不过期）。
   * **旧服务端没有 balance 字段 → 返回 null**，面板据此隐藏余额区块（不显示假数据）。
   * @returns {{totalMicro:number, grantedMicro:number, planMicro:number, paidMicro:number,
   *            text:string, grantedText:string, planText:string, paidText:string,
   *            grantedDaysLeft:number|null, planDaysLeft:number|null,
   *            grantedExpiresAt:string|null, planExpiresAt:string|null, planPeriodKey:string|null,
   *            enforce:boolean, minBalanceMicro:number, overdraft:boolean}|null}
   */
  balance() {
    const u = this.user();
    const b = u && u.balance;
    if (!b || typeof b !== "object") return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      totalMicro: num(b.totalMicro),
      grantedMicro: num(b.grantedAvailableMicro != null ? b.grantedAvailableMicro : b.grantedMicro),
      planMicro: num(b.planAvailableMicro != null ? b.planAvailableMicro : b.planMicro),
      paidMicro: num(b.paidMicro),
      text: b.text || "",
      grantedText: b.grantedText || "",
      planText: b.planText || "",
      paidText: b.paidText || "",
      grantedDaysLeft: b.grantedDaysLeft == null ? null : num(b.grantedDaysLeft),
      planDaysLeft: b.planDaysLeft == null ? null : num(b.planDaysLeft),
      grantedExpiresAt: b.grantedExpiresAt || null,
      planExpiresAt: b.planExpiresAt || null,
      planPeriodKey: b.planPeriodKey || null,
      enforce: !!b.enforce,
      minBalanceMicro: num(b.minBalanceMicro),
      // 充值余额为负 = 并发窗口透支；面板要显式提示（不是"刚好用完"）
      overdraft: num(b.paidMicro) < 0,
    };
  },

  /** 是否 Pro（含到期判断：过期的 Pro 视为 Free） */
  isPro() {
    const m = this.membership();
    if (!m || m.plan !== "Pro") return false;
    if (m.expiresAt && Date.now() > m.expiresAt) return false;
    return true;
  },

  /** 会员剩余天数（无到期日 = Infinity；已过期 = 0） */
  membershipDaysLeft() {
    const m = this.membership();
    if (!m) return 0;
    if (!m.expiresAt) return Infinity;
    const ms = m.expiresAt - Date.now();
    return ms <= 0 ? 0 : Math.ceil(ms / 86400e3);
  },

  /**
   * 到期提醒判定（面板横幅与启动提示共用）。
   * 返回 null（无需提醒）或 { daysLeft, expired, expiresAt, key }。
   * `key` = expiresAt 字符串，用于「同一个到期周期只提醒一次」，避免反复打扰。
   */
  renewalReminder() {
    const m = this.membership();
    if (!m || !m.expiresAt) return null;      // 免费 / 长期有效 → 无到期概念
    const days = this.membershipDaysLeft();
    if (days > 7) return null;
    return { daysLeft: days, expired: days <= 0, expiresAt: m.expiresAt, key: String(m.expiresAt) };
  },

  /** 上次购买/开通的时长（月）；无历史返回 null —— 用作续费默认周期 */
  lastPurchasedMonths() {
    const m = this.membership();
    const h = (m && m.history) || [];
    for (let i = h.length - 1; i >= 0; i--) {
      const n = Number(h[i] && h[i].months);
      if (n > 0) return n;
    }
    return null;
  },

  /** 套餐目录 + 价格档位 + 收款信息（无需登录即可查看价格） */
  async plans() {
    const resp = await this._request("GET", "/api/plans", null, this.token() || null, 10000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "获取套餐失败");
    return {
      plans: j.plans || [],
      priceOptions: j.priceOptions || [],
      // 0.24.4：价格表形态（生效中含周期名与折合月单价；upcoming 为尚未生效的预告）
      priceItems: j.priceItems || [],
      upcoming: j.upcoming || [],
      cycles: j.cycles || [],
      pay: j.pay || {},
      // 0.26.0：充值档位（服务端 1.6.0 起下发；旧服务端为空数组 → 面板隐藏充值入口）
      rechargeOptions: Array.isArray(j.rechargeOptions) ? j.rechargeOptions : [],
      recharge: j.recharge || {},
    };
  },

  /**
   * 充值下单（0.26.0）：{ kind:'credit', optionId } → 返回充值订单
   * （含唯一尾数金额 + 收款信息；核销后自动入账余额）
   */
  async createCreditOrder(optionId) {
    const resp = await this._request("POST", "/api/orders",
      { kind: "credit", optionId: String(optionId || "") }, this.token(), 15000);
    const j = resp.json || {};
    if (!j.ok || !j.order) throw new Error(j.error || "充值下单失败");
    return j.order;
  },

  /** 下单：返回 {order}（含订单号、金额、收款信息与状态）。cycle==='perpetual' 表示永久会员 */
  async createOrder(plan, months, cycle, couponCode) {
    const body = { plan: String(plan || "Pro") };
    if (cycle === "perpetual") body.cycle = "perpetual";   // 永久：不传 months（不适用）
    else body.months = Number(months) || 1;
    // 0.24.6 优惠码：服务端会**重新校验**（不信客户端），此刻才真正占住券的名额
    if (couponCode) body.couponCode = String(couponCode).trim();
    const resp = await this._request("POST", "/api/orders", body, this.token(), 15000);
    const j = resp.json || {};
    if (!j.ok || !j.order) throw new Error(j.error || "下单失败");
    return j.order;
  },

  /**
   * 0.24.6 优惠码试算：拿到折后价再决定要不要下单。
   * **不占名额**，用户可以反复试；失败一律抛错（错误文案直接给用户看）。
   */
  async validateCoupon(code, plan, months, cycle) {
    const body = { code: String(code || "").trim(), plan: String(plan || "Pro") };
    if (cycle === "perpetual") body.cycle = "perpetual";
    else body.months = Number(months) || 1;
    const resp = await this._request("POST", "/api/coupons/validate", body, this.token(), 10000);
    const j = resp.json || {};
    if (!j.ok || !j.quote) throw new Error(j.error || "优惠码不可用");
    return j.quote;
  },

  /* ---------- 登录设备（0.24.7） ---------- */

  /** 本账号的登录设备列表（IP 已由服务端打码）+ 活跃设备数与阈值 */
  async sessions() {
    const resp = await this._request("GET", "/api/sessions", null, this.token(), 10000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "获取登录设备失败");
    return {
      sessions: j.sessions || [],
      activeCount: Number(j.activeCount) || 0,
      activeDays: Number(j.activeDays) || 7,
      maxDevices: Number(j.maxDevices) || 3,
      overLimit: !!j.overLimit,
      identified: j.identified !== false,
      hint: j.hint || "",
    };
  },

  /** 给自己的设备起名（空串 = 清空） */
  async renameSession(sid, label) {
    const resp = await this._request("PUT", "/api/sessions/" + encodeURIComponent(sid),
      { label: String(label == null ? "" : label) }, this.token(), 10000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "重命名失败");
    return j;
  },

  /** 踢出某台设备（踢自己 = 登出） */
  async revokeSession(sid) {
    const resp = await this._request("DELETE", "/api/sessions/" + encodeURIComponent(sid),
      null, this.token(), 10000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "踢出失败");
    return j;
  },

  /** 踢出除当前设备外的全部设备 */
  async revokeOtherSessions() {
    const resp = await this._request("POST", "/api/sessions/revoke-others", {}, this.token(), 15000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "操作失败");
    return j;
  },

  /** 查询订单状态（下单后轮询用） */
  async orderStatus(orderId) {
    const resp = await this._request("GET", "/api/orders/" + encodeURIComponent(orderId), null, this.token(), 10000);
    const j = resp.json || {};
    if (!j.ok || !j.order) throw new Error(j.error || "查询订单失败");
    return j.order;
  },

  /** 标记「我已完成支付」——管理员核销后自动开通 */
  async claimOrder(orderId) {
    const resp = await this._request("POST", "/api/orders/" + encodeURIComponent(orderId) + "/claim",
      null, this.token(), 10000);
    const j = resp.json || {};
    if (!j.ok || !j.order) throw new Error(j.error || "提交失败");
    return j.order;
  },

  /** 取消订单（未支付的） */
  async cancelOrder(orderId) {
    const resp = await this._request("POST", "/api/orders/" + encodeURIComponent(orderId) + "/cancel",
      null, this.token(), 10000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "取消失败");
    return j.order || null;
  },

  /** 兑换码 / 激活码激活：成功后立刻刷新本地会员状态并落盘 */
  async redeem(code) {
    const c = String(code || "").trim();
    if (!c) throw new Error("请输入激活码");
    const resp = await this._request("POST", "/api/redeem", { code: c }, this.token(), 15000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "激活失败");
    if (j.user && this._session) {
      this._session.user = j.user;                 // 服务端回传最新用户（含 membership）
      await this._save("redeem");
      this._notify();
    }
    return { membership: j.membership || (j.user && j.user.membership) || null, user: j.user || null };
  },

  /** 拉取会员状态（等级/到期/历史），并写回本地会话缓存 */
  async refreshMembership() {
    if (!this._session) throw new Error("请先登录");
    const resp = await this._request("GET", "/api/membership", null, this._session.token, 10000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "获取会员信息失败");
    if (this._session.user) {
      this._session.user.membership = j.membership || null;
      if (j.membership && j.membership.plan) this._session.user.plan = j.membership.plan;
      // 0.24.4：服务端同时回传最新 user（含用量趋势 usage），合并进来以便离线画图
      if (j.user && typeof j.user === "object") {
        this._session.user = Object.assign({}, this._session.user, j.user);
      }
      await this._save("membership-refresh");
      this._notify();
    }
    return j.membership || null;
  },

  /* ---------- UI 刷新回调（设置面板注册；窗口关闭必须注销） ---------- */

  onSessionChanged(cb) {
    this._listeners.push(cb);
    return () => this.offSessionChanged(cb);
  },

  offSessionChanged(cb) {
    this._listeners = this._listeners.filter((f) => f !== cb);
  },

  _notify() {
    for (const cb of this._listeners) {
      try { cb(); } catch (e) { /* 单个回调失败不拖累其他 */ }
    }
  },

  /* ---------- HTTP（带超时与错误翻译；Token 只出现在 Authorization 头） ---------- */

  /** 本机安装标识：首次调用时生成一次并持久化（随机 UUID，非凭据） */
  installId() {
    let id = "";
    try { id = String(Prefs.get("installId", "") || ""); } catch (e) { /* 读失败下面生成 */ }
    if (/^[0-9a-fA-F-]{8,64}$/.test(id)) return id;
    // 生成：优先 crypto.randomUUID，退化用 getRandomValues 拼装
    let nid = "";
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) nid = crypto.randomUUID();
      else {
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        nid = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
        nid = nid.slice(0, 8) + "-" + nid.slice(8, 12) + "-" + nid.slice(12, 16)
          + "-" + nid.slice(16, 20) + "-" + nid.slice(20);
      }
    } catch (e) {
      // 极端情况下退化成时间戳 + 随机数（形状仍需符合服务端校验）
      nid = "dev" + Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);
    }
    try { Prefs.set("installId", nid); } catch (e) { /* 存不下也照用，最坏是每次换标识 */ }
    return nid;
  },

  /** 设备上报头（服务端只用它做展示与异常检测，不作鉴权） */
  _deviceHeaders() {
    const h = {};
    try {
      h["X-PP-Device"] = this.installId();
      const plat = (typeof Zotero !== "undefined" && Zotero.isWin) ? "Windows"
        : (typeof Zotero !== "undefined" && Zotero.isMac) ? "macOS" : "Linux";
      h["X-PP-Platform"] = plat;
      const ver = (typeof Zotero !== "undefined" && Zotero.version) ? String(Zotero.version) : "";
      if (ver) h["X-PP-Zotero"] = ver;
    } catch (e) { /* 取不到就不报，服务端会标记为未识别设备 */ }
    return h;
  },

  async _request(method, path, body, token, timeoutMs) {
    const url = this.serverUrl() + path;
    const headers = this._deviceHeaders();
    if (body !== null && body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = "Bearer " + token;
    let req;
    try {
      req = await Zotero.HTTP.request(method, url, {
        headers,
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
        responseType: "json",
        timeout: timeoutMs || 10000,
      });
    } catch (e) {
      throw this._translateError(e);
    }
    let json = req.response;
    if (!json && req.responseText) {
      try { json = JSON.parse(req.responseText); } catch (e) { /* 非 JSON 应答按无 body 处理 */ }
    }
    if (req.status >= 400) {
      // 关键：仅 401 视为会话失效。此前这里是 `401 || 403`，而 Zotero.HTTP 对 4xx
      // 不抛异常、实际都会走本分支（_translateError 那条路只兜网络异常）——
      // 于是 Cloudflare/WAF 拦一次 403 就被当成「令牌失效」清掉本地会话。
      const msg = (json && json.error) || (req.status === 403
        ? "请求被拦截（HTTP 403）——可能是网络策略/防火墙，令牌未必失效"
        : "HTTP " + req.status);
      const err = new Error(msg);
      if (req.status === 401) err.auth = true;
      if (req.status === 403) err.blocked = true; // 供上层区分，不触发会话清理
      if (req.status === 402) err.payment = true;
      throw err;
    }
    return { status: req.status, json: json || {} };
  },

  /** 网络层错误 → 可读中文（登录/刷新/网关排障都靠它给线索） */
  _translateError(e) {
    const msg = (e && e.message) || String(e);
    const status = e && e.xmlhttp && e.xmlhttp.status;
    const server = this.serverUrl();
    if (/timed?\s*out|timeout/i.test(msg)) {
      const err = new Error("连接账号服务器超时（" + server + "）——网络不通或服务未响应");
      err.network = true;
      return err;
    }
    if (/CONNECTION_REFUSED|connection refused/i.test(msg)) {
      const err = new Error("无法连接官方账号服务器（" + server + "）——请检查网络连接后重试");
      err.network = true;
      return err;
    }
    if (status === 401 || status === 403) {
      // 优先透传服务端文案（邮箱未验证 / 登录已过期等），无 body 再用本地兜底。
      // 仅 401 标记 auth（触发会话清理）；403 多来自 WAF/反代拦截，令牌未必失效。
      let serverMsg = "";
      try {
        const xhr = e.xmlhttp;
        const rj = xhr && (xhr.response || (xhr.responseText && JSON.parse(xhr.responseText)));
        if (rj && rj.error) serverMsg = rj.error;
      } catch (_) { /* ignore */ }
      const err = new Error(serverMsg || (status === 401 ? "邮箱或密码错误" : "无权限（HTTP 403）"));
      err.auth = (status === 401);
      return err;
    }
    if (status === 429) {
      const err = new Error("尝试过于频繁，请稍后再试（HTTP 429）");
      return err;
    }
    if (status >= 500) {
      const err = new Error("账号服务器内部错误（HTTP " + status + "），请稍后再试");
      return err;
    }
    const err = new Error("网络异常：" + msg);
    err.network = true;
    return err;
  },

  /** 调试日志里的 token 一律脱敏 */
  _mask(token) {
    const t = String(token || "");
    return t.length <= 8 ? "****" : t.slice(0, 4) + "****" + t.slice(-4);
  },
};
