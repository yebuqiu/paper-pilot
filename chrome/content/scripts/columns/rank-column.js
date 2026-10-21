// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 期刊分区列（0.18.1：中文/机构评级体系解析 + 配色全覆盖 + 离线数据降级兜底）
 * 数据来源（按优先级）：
 *  1. 用户自定义 JSON（设置中指定，最高优先级——用户自己的数据最可信）
 *  2. easyScholar 开放接口 getPublicationRank（在线主源），结果本地缓存
 *     （DataDirectory/papilot-easyscholar.json），查询队列限速 ~3 req/s，
 *     失败 30 分钟负缓存
 *  3. 内置示例数据（随包分发的演示数据，仅当在线无数据/未启用时兜底）
 *
 * 0.18.0 修复与增强：
 *  - 修复「列表不显示、点击文章才显示」：异步结果到达后按插件圈标准解法
 *    双通道刷新：refreshColumns + Notifier.trigger("redraw","item",ids)
 *    （zotero-AI-Butler 同款），ids 精确到等待中的条目，避免全树闪烁。
 *  - 多分区完整显示：改用 officialRank.all 全量数据集 + customRank 全量，
 *    全部 badge 化展示，数量与数据集可在设置中配置。
 *
 * 0.18.1 修复（用户报「设置细化没生效、只有灰色一种颜色」）：
 *  - 根因一：非 SCI 体系（中文期刊库主体）此前完全不解析——easyScholar 对
 *    中文期刊返回的是 cscd/pku（北大核心）/zhongguokejihexin（科技核心）/
 *    cju 等键，以及 customRank 里的「中医药高质量 T1」「临床医学高质量 T3」
 *    「NKU 核心」等评级，旧代码只认 sci/ssci/sciUp/sciif/ccf（CCF 之外一律
 *    塞进 tooltip）→ 中文期刊整行为空，看起来「设置不起作用」。
 *    现补齐：cnTier（T1-T4 中文分级）/pku/cscd/core/cssci/org（机构目录）
 *    全部结构化。
 *  - 根因二：内置示例数据（离线）此前优先级高于在线源，命中即产出
 *    kind:"legacy" 的灰色徽章；而 legacy 又被硬编码为 #7f8c8d、且被
 *    `b.kind === "legacy"` 白名单豁免掉数据集过滤 → 无论怎么设置都是灰色，
 *    且勾选数据集对它无效。现：示例数据降为真兜底 + 离线文本也走结构化解析
 *    （"1区 Top" → 中科院1区[TOP 金描边]），legacy 不再无条件绕过过滤。
 *  - 根因三：改变显示配置后只 refreshColumns()；不同 Zotero 版本对行数据
 *    缓存的处理不一致，现额外发一次 Notifier redraw 兜底。
 *  - 配色：补齐全部 kind 的颜色，默认分支不再是灰色（灰=低区语义，仅用于
 *    Q4/4区）；设置面板预览改为「全 kind 图例」，一眼可见设置是否生效。
 */
/* global Zotero, IOUtils, PathUtils, Prefs, I18n, Account */

var RankColumn = {
  COLUMN_KEY: "papilot-journalRank",
  _data: {},        // 内置示例数据（真兜底）
  _customData: {},  // 用户自定义 JSON（最高优先级）
  _lookupCache: new Map(), // itemID -> {text, badges, detail} | null（含负缓存，口径见 lookup）
  _registered: false,
  _pendingRefresh: new Set(), // 等待数据的 itemID（数据到达后精准 redraw）

  /* easyScholar 状态 */
  ES_ENDPOINT: "https://www.easyscholar.cc/open/getPublicationRank",

  /* 0.56.0：移除内置官方 SecretKey。
   * 该 Key 属于第三方（easyscholar）授权账号，随插件明文分发给终端用户使用
   * 不具备可转让的商用授权；转为商业项目后必须由使用者自备（easyscholar.cn 免费注册），
   * 或改走服务端代理（由服务端持有 Key，不随客户端分发）。
   * 兼容性：旧版遗留在 pref 里的用户自有 Key 继续生效；不再有任何「内置 Key」分支。
   */

  _esCache: new Map(),     // 规范化刊名 -> {text, badges, detail, neg, t, retryAfter}
  _esQueue: [],
  _esQueued: new Set(),
  _esWorking: false,
  _esRefreshTimer: null,
  _esSaveTimer: null,
  _esCacheLoaded: false,

  /* ================= 显示配置（pref 驱动） ================= */

  /** 数据集元信息：kind -> { label, on }（数组顺序即显示优先级） */
  DATASETS: [
    { kind: "warning", label: "中科院预警", on: true },
    { kind: "jcr", label: "JCR 分区（SCI）", on: true },
    { kind: "ssci", label: "SSCI 分区", on: true },
    { kind: "cas", label: "中科院分区（大类）", on: true },
    { kind: "casSmall", label: "中科院分区（小类）", on: true },
    { kind: "ccf", label: "CCF 评级", on: true },
    { kind: "cnTier", label: "中文分级（T1-T4）", on: true },
    { kind: "pku", label: "北大核心", on: true },
    { kind: "cscd", label: "CSCD 中国科学引文库", on: true },
    { kind: "core", label: "中国科技核心", on: true },
    { kind: "cssci", label: "CSSCI 南大核心", on: true },
    { kind: "if", label: "影响因子", on: true },
    { kind: "if5", label: "5 年影响因子", on: false },
    { kind: "casBase", label: "中科院基础版", on: false },
    { kind: "esi", label: "ESI 学科", on: false },
    { kind: "ajg", label: "AJG/ABS 评级", on: false },
    { kind: "abdc", label: "ABDC 评级", on: false },
    { kind: "jci", label: "JCI 指数", on: false },
    { kind: "org", label: "机构/高校分级目录", on: false },
    { kind: "legacy", label: "其他/自定义文本", on: true },
  ],

  /** easyScholar officialRank 中「中文核心体系」键 → 展示规则 */
  CN_RANK_KEYS: {
    cscd: "CSCD",
    zhongguokejihexin: "科技核心",
  },

  /** easyScholar officialRank/l select 中「机构/高校期刊分级目录」键 → 中文名 */
  ORG_NAMES: {
    xju: "西安交大", zju: "浙江大学", nju: "南京大学", sjtu: "上海交大",
    fdu: "复旦", swjtu: "西南交大", swufe: "西南财大", cufe: "中央财大",
    uibe: "对外经贸", sdufe: "山东财大", hhu: "河海大学", cug: "中国地质大学",
    scu: "四川大学", cju: "CJU 分级", xr: "软科", xrSmall: "软科小类", xrTop: "软科TOP",
  },

  /** 已被国际体系消费的 officialRank 键（其余键进 tooltip，避免静默丢失） */
  KNOWN_ES_KEYS: [
    "sciwarning", "sci", "ssci", "sciif", "sciif5", "sciUp", "sciUpSmall",
    "sciUpSmallClass", "sciUpTop", "sciUpSmallTop", "sciBase", "esi", "ajg",
    "abdc", "jci", "cpu", "cscd", "pku", "zhongguokejihexin", "cssci",
  ],

  /** 启用的数据集 kind 集合（pref rankDataSets，逗号分隔；空 = 默认 on 的集合）
   *  ⚠️ 渲染热路径（renderCell）不直接调它——每行重读 pref + 建 Set 是纯浪费
   *  （审查 P1-4）。热路径读 _renderPrefs 预算缓存（load 时建立、pref observer 刷新）；
   *  本方法保留给设置面板等需要实时真值的低频调用方。 */
  enabledKinds() {
    const raw = String(Prefs.get("rankDataSets", "") || "").trim();
    const def = this.DATASETS.filter((d) => d.on).map((d) => d.kind);
    if (!raw) return new Set(def);
    const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    // 保证 kind 合法
    const valid = new Set(this.DATASETS.map((d) => d.kind));
    for (const k of [...set]) if (!valid.has(k)) set.delete(k);
    return set.size ? set : new Set(def);
  },

  maxBadges() {
    const n = Number(Prefs.get("rankMaxBadges", 6));
    return isFinite(n) ? Math.min(12, Math.max(1, Math.round(n))) : 6;
  },

  badgeStyleMode() {
    return String(Prefs.get("rankBadgeStyle", "color") || "color"); // color | mono
  },

  /* renderCell 每行渲染用的 pref 预算缓存（审查 P1-4）：
   * null = 尚未建立（load 时建立；rankDataSets/rankMaxBadges/rankBadgeStyle 的
   * pref observer 通道里统一刷新——见 main.js _onPrefChanged）。 */
  _renderPrefs: null,

  _refreshRenderPrefs() {
    this._renderPrefs = {
      kinds: this.enabledKinds(),
      max: this.maxBadges(),
      mono: this.badgeStyleMode() === "mono",
    };
    return this._renderPrefs;
  },

  /* ================= easyScholar 在线源 ================= */

  /**
   * 取用的 easyScholar Key 来源（按优先级）：
   *   ① 本机自备（pref easyScholarKey）——最可信，也永不联网取回；
   *   ② **账号托管**（服务端 1.9.0 起）——用户自己把这把 Key 存进自己账号，
   *      换机器 / 重装后自动取回；只在内存里，不落盘。
   * 两者都没有 ⇒ 在线查询停用，回落内置离线数据。
   */
  esKey() {
    const own = String(Prefs.get("easyScholarKey", "") || "").trim();
    return own || this._hostedKey || "";
  },

  /**
   * 在线源状态（供设置页给出**可执行**的指引，而不是让用户看到空白以为坏了）：
   *   "ok"       = 本机自备 Key 可用
   *   "hosted"   = 正在使用账号里托管的 Key（本机没填）
   *   "off"      = 用户自己关了在线查询
   *   "need_key" = 都没有 ⇒ 需要去 easyscholar.cn 免费注册后填入
   */
  esStatus() {
    if (!Prefs.get("easyScholarEnabled", true)) return "off";
    if (String(Prefs.get("easyScholarKey", "") || "").trim()) return "ok";
    if (this._hostedKey) return "hosted";
    return "need_key";
  },

  /* ================= 账号托管 Key（服务端 1.9.0） ================= */

  /** 托管 Key 与掩码（仅本次会话内存；不落盘、不进云同步） */
  _hostedKey: "",
  _hostedHint: "",
  _hostedTried: false,
  _hostedWatch: null,

  /**
   * 从账号取回托管的 Key。仅当本机没有自备 Key 且已登录时尝试；
   * 失败一律静默——404 表示「没托管」，属正常状态，不该打扰用户。
   * 拿到后清条目缓存并重绘，列会在下一轮 dataProvider 调用时开始在线查询。
   *
   * ⚠️ 启动时序（0.64.0 实机踩到）：`Account.restore()` 是**异步**的（读多落点副本 +
   * 可能的网络刷新），而分区列注册往往比它早几十毫秒 —— 首次调用时必然 `isLoggedIn()`
   * 为 false。所以这里**不能**一上来就锁 `_hostedTried`：未登录时安排 3s×10 的轮询，
   * 并额外订阅 onSessionChanged（恢复结束 / 登录 / 登出都会通知）。
   * 失败（网络不可达）同样重置标记，让上面的两条路径都能再试。
   */
  async _loadHostedKey(attempt) {
    const n = attempt || 0;
    if (this._hostedTried) return;
    if (typeof Account === "undefined" || !Account) return;
    if (!Account.isLoggedIn()) {
      if (n < 10 && typeof setTimeout === "function") {
        setTimeout(() => { this._loadHostedKey(n + 1).catch(() => {}); }, 3000);
      }
      return;
    }
    this._hostedTried = true;
    try {
      const meta = await Account.hostedSecrets();
      const st = meta && meta.easyscholar;
      if (!st || !st.set) return;
      const v = await Account.revealHostedSecret("easyscholar");
      if (!v) return;
      this._hostedKey = v;
      this._hostedHint = st.hint || "";
      Zotero.debug(`Papilot: 已取回账号托管的 easyScholar Key（${this._hostedHint || "已保存"}）`);
      try { this._lookupCache.clear(); } catch (e) { /* ignore */ }
      this._esRefreshColumns();
    } catch (e) {
      this._hostedTried = false;   // 网络/服务暂不可达：留给下一次会话通知或面板按钮重试
      Zotero.debug("Papilot: 取回托管 Key 未成功 " + (e && e.message || e));
    }
  },

  /** 订阅账号会话变化：恢复完成 / 登录 / 登出后自动再试（只注册一次） */
  _watchHostedKey() {
    if (this._hostedWatch) return;
    try {
      if (typeof Account === "undefined" || !Account
          || typeof Account.onSessionChanged !== "function") return;
      this._hostedWatch = Account.onSessionChanged(() => {
        if (this._hostedKey || this._hostedTried) return;
        this._loadHostedKey().catch(() => {});
      });
    } catch (e) { /* ignore */ }
  },

  /** pref 变化后重新评估（用户清空自备 Key 时应回落到账号托管） */
  async refreshHostedKey() {
    this._hostedTried = false;
    if (!String(Prefs.get("easyScholarKey", "") || "").trim()) await this._loadHostedKey();
  },

  _esEnabled() {
    return !!Prefs.get("easyScholarEnabled", true) && !!this.esKey();
  },

  _esCacheFile() {
    return PathUtils.join(Zotero.DataDirectory.dir, "papilot-easyscholar.json");
  },

  async _esLoadCache() {
    if (this._esCacheLoaded) return;
    this._esCacheLoaded = true;
    try {
      const obj = JSON.parse(await IOUtils.readUTF8(this._esCacheFile()));
      let dropped = 0;
      let revived = 0;
      for (const k of Object.keys(obj || {})) {
        const v = obj[k];
        // 旧格式（0.18.0 之前无 badges 字段、text 常为空）判定为失效缓存：
        // 丢弃以便用新解析器重查（否则中文期刊永远只有一个空/灰条目）
        if (v && !v.neg && !v.badges) { dropped++; continue; }
        // 0.64.0：**老负缓存没有 retryAfter**（0.18 时代还没有「过期重查」的概念）。
        // 这类条目会永久压住该期刊——later 就算配好了 Key 也永远空白，
        // 用户只能自己去点「清空查询缓存」。这里补一个已过期的 retryAfter，
        // 让下一轮 lookup 自动重查（232 条 ≈ 80s，限速内跑完）。
        if (v && v.neg && !v.retryAfter) {
          v.retryAfter = (Number(v.t) || 0) + 30 * 60 * 1000;
          if (v.retryAfter > Date.now()) v.retryAfter = Date.now() - 1;
          revived++;
        }
        this._esCache.set(k, v);
      }
      Zotero.debug(`Papilot: easyScholar 缓存 ${this._esCache.size} 条（迁移丢弃旧格式 ${dropped} 条，复活过期负缓存 ${revived} 条）`);
      if (dropped || revived) this._esSaveCacheSoon();
    } catch (e) { /* 无缓存文件属正常 */ }
  },

  _esSaveCacheSoon() {
    if (this._esSaveTimer) return;
    this._esSaveTimer = setTimeout(async () => {
      this._esSaveTimer = null;
      try {
        const obj = {};
        for (const [k, v] of this._esCache) obj[k] = v;
        await IOUtils.writeUTF8(this._esCacheFile(), JSON.stringify(obj));
      } catch (e) {
        Zotero.debug("Papilot: easyScholar 缓存写入失败 " + e);
      }
    }, 3000);
  },

  async esClearCache() {
    this._esCache.clear();
    this._esQueued.clear();
    this._esQueue.length = 0;
    this._lookupCache.clear();
    this._pendingRefresh.clear();
    try { await IOUtils.remove(this._esCacheFile()); } catch (e) { /* ignore */ }
    this._esRefreshColumns();
  },

  esCacheSize() {
    return this._esCache.size;
  },

  /* ================= 分区数据结构化 ================= */

  /** 评级文本 → 等级（1 最好，0 未知）：T1 / 1区 / Q1 / A / 核心 */
  _tierLevel(v) {
    const s = String(v == null ? "" : v).trim();
    let m = s.match(/^T\s*([1-4])/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/([1-4])\s*区/);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^Q\s*([1-4])/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^([ABCD])\+?$/i);
    if (m) return "ABCD".indexOf(m[1].toUpperCase()) + 1;
    if (/top|顶尖|一区|甲等/i.test(s)) return 1;
    if (/核心|权威|重点/.test(s)) return 1;
    if (/扩展|一般/i.test(s)) return 3;
    return 0;
  },

  /** 从 easyScholar 响应提取结构化分区（badges 全量 + text 紧凑串 + detail 详情）
   *  改用 officialRank.all（全量数据集）；officialRank.select 为扩展端用户自选
   *  子集，仅当 all 缺失时兜底。0.18.1 补齐中文核心体系与机构目录。 */
  _esFormat(resp) {
    const d = resp && resp.data;
    if (!d) return null;
    const off = (d.officialRank && (d.officialRank.all || d.officialRank.select)) || {};
    const badges = [];
    const detail = [];
    const push = (kind, text, level, extra) => {
      if (!text) return;
      badges.push(Object.assign({ kind, text: String(text), level: level || 0 }, extra || {}));
    };

    // 预警（最高优先级提示）
    if (off.sciwarning) {
      const w = String(off.sciwarning);
      if (!/无|否|none/i.test(w)) {
        push("warning", "⚠预警", 1);
        detail.push("中科院预警: " + w);
      }
    }
    // JCR SCI 分区（Q1-Q4）
    if (off.sci) {
      const q = String(off.sci).match(/Q?([1-4])/i);
      push("jcr", String(off.sci).toUpperCase().startsWith("Q") ? String(off.sci).toUpperCase() : "Q" + (q ? q[1] : off.sci), q ? parseInt(q[1], 10) : 0);
      detail.push("JCR 分区: " + off.sci);
    }
    // SSCI 分区
    if (off.ssci) {
      const q = String(off.ssci).match(/Q?([1-4])/i);
      push("ssci", "SSCI " + String(off.ssci).toUpperCase(), q ? parseInt(q[1], 10) : 0);
      detail.push("SSCI 分区: " + off.ssci);
    }
    // 中科院升级版（大类）
    const casUp = off.sciUp || "";
    if (casUp) {
      const m = String(casUp).match(/([1-4])\s*区/);
      const lv = m ? parseInt(m[1], 10) : this._tierLevel(casUp);
      const top = !!(off.sciUpTop && /TOP/i.test(String(off.sciUpTop)));
      push("cas", "中科院" + (m ? m[1] + "区" : casUp), lv, top ? { top: true } : null);
      detail.push("中科院升级版(大类): " + casUp + (top ? " [TOP]" : ""));
    }
    // 中科院升级版小类（可能与大类不同，全部展示）
    const casSmall = off.sciUpSmall || off.sciUpSmallClass || "";
    if (casSmall && this.normalize(casSmall) !== this.normalize(casUp)) {
      const m = String(casSmall).match(/([1-4])\s*区/);
      const lv = m ? parseInt(m[1], 10) : this._tierLevel(casSmall);
      const top = !!(off.sciUpSmallTop && /TOP/i.test(String(off.sciUpSmallTop)));
      push("casSmall", "小类" + (m ? m[1] + "区" : casSmall), lv, top ? { top: true } : null);
      detail.push("中科院升级版(小类): " + casSmall + (top ? " [TOP]" : ""));
    }
    // 中科院基础版
    if (off.sciBase && this.normalize(off.sciBase) !== this.normalize(casUp)) {
      const m = String(off.sciBase).match(/([1-4])\s*区/);
      push("casBase", "基础版" + (m ? m[1] + "区" : off.sciBase), m ? parseInt(m[1], 10) : this._tierLevel(off.sciBase));
      detail.push("中科院基础版: " + off.sciBase);
    }
    // 自定义评级集（CCF / CSSCI / 中文分级 T1-T4 / 预警 / 机构核心）
    this._esCustomRank(d, detail, badges);
    // 影响因子
    if (off.sciif) { push("if", "IF " + off.sciif, 0); detail.push("影响因子: " + off.sciif); }
    if (off.sciif5) { push("if5", "IF5 " + off.sciif5, 0); detail.push("5年影响因子: " + off.sciif5); }
    // 国际其他评级
    if (off.esi) { push("esi", "ESI " + off.esi, 0); detail.push("ESI 学科: " + off.esi); }
    if (off.ajg) { push("ajg", "AJG " + off.ajg, 0); detail.push("AJG/ABS: " + off.ajg); }
    if (off.abdc) { push("abdc", "ABDC " + off.abdc, 0); detail.push("ABDC: " + off.abdc); }
    if (off.jci) { push("jci", "JCI " + off.jci, 0); detail.push("JCI: " + off.jci); }
    if (off.cpu) detail.push("评价: " + off.cpu);
    // 中文核心体系（0.18.1 新增）：CSCD / 北大核心 / 中国科技核心 / CSSCI
    if (off.cscd) {
      const v = String(off.cscd).trim();
      const lv = this._tierLevel(v);
      push("cscd", /扩展/.test(v) ? "CSCD扩展" : "CSCD核心", lv || 1);
      detail.push("CSCD 中国科学引文数据库: " + v);
    }
    if (off.pku && !/^(0|否|无|no|false)$/i.test(String(off.pku).trim())) {
      push("pku", "北大核心", 1);
      detail.push("北大核心（中文核心期刊要目总览）: " + off.pku);
    }
    if (off.zhongguokejihexin && !/^(0|否|无|no|false)$/i.test(String(off.zhongguokejihexin).trim())) {
      push("core", "科技核心", 1);
      detail.push("中国科技核心期刊: " + off.zhongguokejihexin);
    }
    if (off.cssci) {
      const v = String(off.cssci).trim();
      push("cssci", "CSSCI " + v, this._tierLevel(v));
      detail.push("CSSCI 南大核心: " + v);
    }
    // 机构/高校期刊分级目录（默认不展示，可在设置中勾选；详情始终可见）
    for (const k in this.ORG_NAMES) {
      if (!off[k]) continue;
      const v = String(off[k]).trim();
      if (!v) continue;
      push("org", v, this._tierLevel(v));
      detail.push(this.ORG_NAMES[k] + ": " + v);
    }
    // 其余未消费键：一律进 tooltip，避免静默丢数据
    for (const k in off) {
      if (this.KNOWN_ES_KEYS.indexOf(k) >= 0 || this.ORG_NAMES[k]) continue;
      const v = off[k];
      if (v === null || v === undefined || v === "") continue;
      detail.push(k + ": " + v);
    }

    if (!badges.length && !detail.length) return null;
    return {
      badges: badges,
      text: badges.map((b) => b.text).join(" · "),
      detail: detail.join("\n"),
    };
  },

  /** customRank 提取（CCF / CSSCI / 中文分级 / 预警 / 机构核心）；其余写入 detail */
  _esCustomRank(d, detail, badges) {
    try {
      const cr = d.customRank;
      if (!cr || !Array.isArray(cr.rank) || !Array.isArray(cr.rankInfo)) return;
      for (const r of cr.rank) {
        const [uuid, idx] = String(r).split("&&&");
        const info = cr.rankInfo.find((x) => x.uuid === uuid);
        if (!info || !info.abbName) continue;
        const val = String(info[["oneRankText", "twoRankText", "threeRankText", "fourRankText"][idx - 1]] || "").trim();
        if (!val) continue;
        const abb = String(info.abbName);
        const lv = this._tierLevel(val);
        if (/^CCF$/i.test(abb)) {
          badges.push({ kind: "ccf", text: "CCF-" + val, level: "ABC".indexOf(val.toUpperCase()) + 1 });
          detail.push("CCF: " + val);
        } else if (/CSSCI|CHSSACD|南大核心/i.test(abb)) {
          badges.push({ kind: "cssci", text: "CSSCI " + val, level: lv });
          detail.push(abb + ": " + val);
        } else if (/预警/.test(abb)) {
          badges.push({ kind: "warning", text: "⚠预警" + (lv ? val : ""), level: 1 });
          detail.push(abb + ": " + val);
        } else if (/^T[1-4]$/i.test(val)) {
          // 「中医药高质量 T1」「临床医学高质量 T3」等中文分级：最核心的中文期刊信号
          badges.push({ kind: "cnTier", text: val.toUpperCase(), level: lv });
          detail.push(abb + ": " + val);
        } else if (/^[ABCD]\+?$/i.test(val) || /核心|权威|重点|一级|二级/.test(val)) {
          badges.push({ kind: "org", text: val, level: lv });
          detail.push(abb + ": " + val);
        } else {
          detail.push(abb + ": " + val);
        }
      }
    } catch (e) { /* ignore */ }
  },

  async _esFetch(pubName) {
    const key = this.esKey();
    if (!key) throw new Error("未配置 easyScholar SecretKey");
    const url = this.ES_ENDPOINT + "?secretKey=" + encodeURIComponent(key)
      + "&publicationName=" + encodeURIComponent(pubName);
    const req = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 15000 });
    const resp = req.response;
    if (!resp || resp.code !== 200) {
      throw new Error("easyScholar 返回异常: " + (resp && (resp.msg || resp.code)));
    }
    return resp;
  },

  _esEnqueue(pubName) {
    const norm = this.normalize(pubName);
    if (!norm || this._esCache.has(norm) || this._esQueued.has(norm)) return;
    this._esQueued.add(norm);
    this._esQueue.push(pubName.trim());
    if (!this._esWorking) this._esWork();
  },

  async _esWork() {
    if (this._esWorking) return;
    this._esWorking = true;
    while (this._esQueue.length) {
      const name = this._esQueue.shift();
      const norm = this.normalize(name);
      this._esQueued.delete(norm);
      if (this._esCache.has(norm)) continue;
      try {
        const fmt = this._esFormat(await this._esFetch(name));
        this._esCache.set(norm, fmt
          ? { text: fmt.text, badges: fmt.badges, detail: fmt.detail, t: Date.now() }
          : { neg: 1, t: Date.now(), failReason: "easyScholar 无此期刊分区数据" });
      } catch (e) {
        Zotero.debug(`Papilot: easyScholar 查询失败 '${name}': ${e && e.message || e}`);
        this._esCache.set(norm, {
          neg: 1, t: Date.now(), retryAfter: Date.now() + 30 * 60 * 1000,
          failReason: "查询失败: " + (e && e.message || e),
        });
      }
      this._esSaveCacheSoon();
      this._esRefreshSoon();
      await new Promise((r) => setTimeout(r, 350)); // 限速 ~3 req/s
    }
    this._esWorking = false;
  },

  _esRefreshSoon() {
    if (this._esRefreshTimer) return;
    this._esRefreshTimer = setTimeout(() => {
      this._esRefreshTimer = null;
      this._esRefreshColumns();
    }, 800);
  },

  /** 双通道刷新（0.18.0 修复核心，0.18.1 补 redraw 兜底）：
   *  ① refreshColumns 重置列配置（Zotero 官方通道）
   *  ② Notifier.trigger("redraw","item",ids) 让等待中的条目行 invalidate、
   *     重调 dataProvider——不同 Zotero 版本对行数据缓存的处理不一致
   *    （7.0.x 的 refresh() 会清 _rowCache，部分版本不清），双管齐下最稳。 */
  _esRefreshColumns() {
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    const ids = [...this._pendingRefresh];
    this._pendingRefresh.clear();
    try {
      if (ids.length) Zotero.Notifier.trigger("redraw", "item", ids, {}, true);
      else Zotero.Notifier.trigger("redraw", "item", []);
    } catch (e) {
      try { Zotero.Notifier.trigger("redraw", "item", []); } catch (e2) { /* ignore */ }
    }
  },

  /** 同步查询 easyScholar 缓存；未命中则入队并返回加载占位 */
  _esLookup(pubName) {
    const norm = this.normalize(pubName);
    const hit = this._esCache.get(norm);
    if (!hit) {
      this._esEnqueue(pubName);
      return { pending: true, text: "…", detail: "查询中：" + pubName };
    }
    if (hit.neg) {
      if (hit.retryAfter && Date.now() > hit.retryAfter) {
        this._esCache.delete(norm);
        this._esEnqueue(pubName);
        return { pending: true, text: "…", detail: "重试中：" + pubName };
      }
      // negTemp=true（瞬态失败，retryAfter 未到期）：条目级负缓存必须跳过它，
      // 否则到期后的自动重查永远触发不到（见 lookup 的缓存口径）
      return { text: "", badges: [], detail: hit.failReason || "", neg: true, negTemp: !!hit.retryAfter };
    }
    // 旧版缓存（无 badges 字段）兼容：包装单色 badge 显示
    if (!hit.badges) {
      return { text: hit.text, badges: hit.text ? this._parseOffline(hit.text) : [], detail: hit.detail };
    }
    return hit;
  },

  /* ================= 离线数据 ================= */

  normalize(name) {
    return (name || "").toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  },

  /** 离线文本（内置示例 / 用户自定义 JSON 的裸字符串）→ 结构化徽章。
   *  "1区 Top" → 中科院1区 + TOP 金描边；"JCR Q2 / IF 5.1 / CCF-A / 北大核心"
   *  等写法同样识别；实在解析不出才落入 legacy（靛蓝，不再是灰色） */
  _parseOffline(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return [];
    const badges = [];
    const top = /\btop\b/i.test(s) || /顶尖/.test(s);
    const casM = s.match(/([1-4])\s*区/) || s.match(/[一二三四]区/);
    const qm = s.match(/(?:\bJCR\b\s*)?\bQ\s*([1-4])/i);
    const ccfM = s.match(/CCF[-\s]*([ABC])\b/i);
    const tM = s.match(/\bT([1-4])\b/i);
    const ifM = s.match(/(?:IF|影响因子)\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (casM) {
      const zhMap = { 一: 1, 二: 2, 三: 3, 四: 4 };
      const lv = casM[1].length === 1 && /\d/.test(casM[1]) ? parseInt(casM[1], 10) : zhMap[casM[1][0]] || 0;
      const kind = /小类/.test(s) ? "casSmall" : /基础版/.test(s) ? "casBase" : "cas";
      badges.push({ kind, text: (/小类/.test(s) ? "小类" : /基础版/.test(s) ? "基础版" : "中科院") + lv + "区", level: lv, top });
    }
    if (qm) badges.push({ kind: "jcr", text: "Q" + qm[1], level: parseInt(qm[1], 10) });
    if (ccfM) badges.push({ kind: "ccf", text: "CCF-" + ccfM[1].toUpperCase(), level: "ABC".indexOf(ccfM[1].toUpperCase()) + 1 });
    if (!casM && tM) badges.push({ kind: "cnTier", text: "T" + tM[1], level: parseInt(tM[1], 10) });
    if (/北大核心|中文核心/.test(s)) badges.push({ kind: "pku", text: "北大核心", level: 1 });
    if (/科技核心/.test(s)) badges.push({ kind: "core", text: "科技核心", level: 1 });
    if (/CSCD/i.test(s)) badges.push({ kind: "cscd", text: /扩展/.test(s) ? "CSCD扩展" : "CSCD核心", level: /扩展/.test(s) ? 3 : 1 });
    if (/CSSCI/i.test(s)) badges.push({ kind: "cssci", text: "CSSCI", level: 1 });
    if (ifM) badges.push({ kind: "if", text: "IF " + ifM[1], level: 0 });
    if (!badges.length) badges.push({ kind: "legacy", text: s, level: 0 });
    return badges;
  },

  _offlineOut(raw, src) {
    const badges = this._parseOffline(raw);
    return {
      text: badges.map((b) => b.text).join(" · ") || String(raw),
      badges,
      detail: src + ": " + raw,
    };
  },

  async _readBundledJSON(url) {
    try {
      const text = await Zotero.File.getContentsFromURLAsync(url);
      return JSON.parse(text);
    } catch (e) {
      const resp = await Zotero.HTTP.request("GET", url, { responseType: "json" });
      return resp.response || {};
    }
  },

  async load(rootURI) {
    this._rootURI = rootURI;
    try {
      this._data = await this._readBundledJSON(rootURI + "chrome/content/data/journal-rank.json") || {};
    } catch (e) {
      Zotero.logError(e);
      this._data = {};
    }
    delete this._data._comment;
    // 用户自定义 JSON：最高优先级，与内置示例数据分开存放
    this._customData = {};
    const customPath = Prefs.get("rankDataPath", "");
    if (customPath) {
      try {
        const custom = await IOUtils.readJSON(customPath);
        if (custom && typeof custom === "object") {
          this._customData = custom;
          delete this._customData._comment;
        }
        Zotero.debug(`Papilot: 已加载自定义分区数据 ${customPath}`);
      } catch (e) {
        Zotero.logError(new Error("Papilot: 自定义分区数据加载失败 " + customPath));
        Zotero.logError(e);
      }
    }
    this._lookupCache.clear();
    this._refreshRenderPrefs();   // P1-4：renderCell 热路径的 pref 预算缓存（observer 通道刷新）
    await this._esLoadCache();
    this._migrateDataSets181();
    // 账号托管的 Key（1.9.0）：不阻塞启动；本机已有自备 Key 时无需取回
    this._hostedTried = false;
    if (!String(Prefs.get("easyScholarKey", "") || "").trim()) {
      this._watchHostedKey();
      this._loadHostedKey().catch(() => {});
    }
  },

  /** 0.18.1 数据集迁移：旧版本（≤0.18.0）的 rankDataSets 显式列表里不可能
   *  包含新增的中文体系 kind（cnTier/pku/cscd/core/cssci）与 legacy——
   *  用户当时无法表达对这些新分类的意愿，直接补进去（默认开），
   *  一次性执行，之后用户自己的勾选优先。 */
  _migrateDataSets181() {
    try {
      if (Prefs.get("rankDataSetsM181", false)) return;
      Prefs.set("rankDataSetsM181", true);
      const raw = String(Prefs.get("rankDataSets", "") || "").trim();
      if (!raw) return; // 空 = 走默认集，无需迁移
      const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
      let changed = false;
      for (const k of ["cnTier", "pku", "cscd", "core", "cssci", "legacy"]) {
        if (!set.has(k)) { set.add(k); changed = true; }
      }
      if (!changed) return;
      const ordered = this.DATASETS.map((d) => d.kind).filter((k) => set.has(k));
      Prefs.set("rankDataSets", ordered.join(","));
    } catch (e) { Zotero.debug("Papilot: rankDataSets 迁移失败 " + e); }
  },

  async reload() {
    if (!this._rootURI) return;
    await this.load(this._rootURI);
    this._esRefreshColumns();
  },

  _match(name, table) {
    const data = table || {};
    const key = this.normalize(name);
    if (!key) return "";
    if (data[key] != null) return String(data[key]);
    for (const k in data) {
      if (k.length >= 6 && key.includes(k)) return String(data[k]);
    }
    return "";
  },

  /* ================= 配色（色阶 + 主题自适应 + 可切换风格） ================= */

  /** kind+level → 颜色（彩色模式）；TOP 金色描边。
   *  0.18.1：补齐全部 kind，默认分支不再是灰色——灰蓝 #5d6d7e 专用于
   *  「Q4/4区」这类低区语义（见设置面板图例），避免「只有灰色」的误解。 */
  _badgeColor(badge) {
    const L = badge.level;
    const scale = (a, b, c, d) => (L === 1 ? a : L === 2 ? b : L === 3 ? c : d);
    switch (badge.kind) {
      case "warning": return "#b03060";
      case "jcr":
      case "ssci":
        return scale("#c0392b", "#e67e22", "#2471a3", "#5d6d7e");
      case "cas":
      case "casSmall":
      case "casBase":
        return scale("#a8324a", "#cf6a1f", "#2e86c1", "#5d6d7e");
      case "cnTier":
        return scale("#b03a2e", "#ca6f1e", "#8a6d1f", "#5d6d7e");
      case "ccf":
        return scale("#0e8a6d", "#17a2a8", "#5d6d7e", "#5d6d7e");
      case "pku": return "#8e5b2f";     // 北大核心（棕）
      case "cscd": return "#4a69bd";    // CSCD（靛蓝）
      case "core": return "#1e8449";    // 中国科技核心（绿）
      case "cssci": return "#7d3c98";   // CSSCI（紫）
      case "if":
      case "if5":
        return "#6c5ce7";
      case "esi":
        return "#2e86c1";
      case "ajg":
      case "abdc":
        return "#c46b1a";
      case "jci":
        return "#5b8fd4";
      case "org":
        return "#3f7f8f";               // 机构/高校目录（青灰蓝）
      default:
        return "#4a6fa5";               // legacy/其他自定义文本（靛蓝，非灰）
    }
  },

  _badgeCss(badge, mono) {
    // mono 由调用方（renderCell 热路径）从 _renderPrefs 缓存传入；
    // 未传时实时读 pref（设置面板预览等低频路径兼容旧行为）
    const isMono = (mono !== undefined) ? mono : this.badgeStyleMode() === "mono";
    const bg = isMono ? "var(--color-accent, #2563eb)" : this._badgeColor(badge);
    let css = "background:" + bg + ";color:#fff;border-radius:4px;" +
      "padding:0 5px;font-size:11px;line-height:16px;margin-inline-end:4px;" +
      "white-space:nowrap;display:inline-block;";
    if (badge.top) css += "box-shadow:inset 0 0 0 1.5px #ffd76a;"; // TOP 金描边
    return css;
  },

  /* ================= 条目查询（dataProvider） ================= */

  /** 返回 {text, badges, detail, pending} 或 null（无数据）。
   *  优先级：用户自定义 JSON > easyScholar 在线 > 内置示例数据。
   *  0.71.x（审查 P1-4）负缓存：bundled/custom 均 miss 的空结果（含 null）也写
   *  _lookupCache——此前每行渲染都重扫两张离线表（_match 是 O(表大小) 的子串扫描）。
   *  缓存失效走已有通道：load/reload 统一 clear，easyScholar 开关/密钥与显示配置的
   *  pref observer 也 clear。
   *  唯一例外：easyScholar **瞬态**负缓存（查询失败、retryAfter 未到期）不写入——
   *  到期后要靠重新 lookup 触发自动重查；「…」占位同理不缓存（待刷新重查）。 */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return null;
    if (this._lookupCache.has(item.id)) return this._lookupCache.get(item.id);
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const pub = get("publicationTitle") || get("journalAbbreviation");
    const abbr = get("journalAbbreviation");
    const bundled = () => this._match(pub, this._data) || this._match(abbr, this._data);
    let out = null;
    let esTempNeg = false;
    // 1. 用户自定义 JSON（最高优先级）
    const custom = this._match(pub, this._customData) || this._match(abbr, this._customData);
    if (custom) {
      out = this._offlineOut(custom, "自定义数据");
    } else if (pub && this._esEnabled()) {
      // 2. easyScholar 在线源（缓存命中即用；未命中入队并显示占位）
      const r = this._esLookup(pub);
      if (r.pending) {
        this._pendingRefresh.add(item.id); // 数据到达后精准 redraw 此行
        out = { text: r.text, badges: [], detail: r.detail, pending: true };
      } else if (r.text || (r.badges || []).length) {
        out = { text: r.text, badges: r.badges || [], detail: r.detail };
      } else {
        // 3. 在线无此期刊 → 内置示例数据兜底（0.18.1：示例数据不再压过在线源）
        const b = bundled();
        if (b) out = this._offlineOut(b, "内置示例数据");
        else {
          esTempNeg = !!r.negTemp;
          out = r.detail ? { text: "", badges: [], detail: r.detail } : null;
        }
      }
    } else {
      // 未启用在线源 → 内置示例数据兜底
      const b = bundled();
      out = b ? this._offlineOut(b, "内置数据") : null;
    }
    // 缓存口径见方法头注释：正结果 + 空结果（负缓存）都写；占位与瞬态负缓存不写
    if (!esTempNeg && (!out || !out.pending)) {
      this._lookupCache.set(item.id, out);
    }
    return out;
  },

  /** 单元格悬停详情（tooltip 用完整信息） */
  lookupDetail(item) {
    const r = this.lookup(item);
    return (r && r.detail) || "";
  },

  /* ================= 列注册与渲染 ================= */

  async register(pluginID) {
    if (this._registered) return;
    const self = this;
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("rankColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (!data) return span;
        // 加载占位（"…"）
        if (data.pending) {
          span.textContent = data.text;
          span.style.cssText = "color:var(--fill-tertiary,#888);font-size:11px;";
          return span;
        }
        // badge 渲染（按启用数据集过滤 + 数量上限）
        // 审查 P1-4：prefs 读预算缓存（load 建立 / pref observer 刷新），每行不再重读 pref
        const rp = self._renderPrefs || self._refreshRenderPrefs();
        const kinds = rp.kinds;
        const all = (data.badges || []).filter((b) => kinds.has(b.kind));
        const max = rp.max;
        const shown = all.slice(0, max);
        for (const b of shown) {
          const el = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
          el.textContent = b.text;
          el.style.cssText = self._badgeCss(b, rp.mono);
          span.appendChild(el);
        }
        if (all.length > shown.length) {
          const more = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
          more.textContent = "+" + (all.length - shown.length);
          more.style.cssText = "color:var(--fill-tertiary,#888);font-size:10.5px;";
          span.appendChild(more);
        }
        if (data.detail) span.title = data.detail;
        return span;
      },
    });
    this._registered = true;
  },

  unregister() {
    if (this._registered) {
      Zotero.ItemTreeManager.unregisterColumns(this.COLUMN_KEY);
      this._registered = false;
    }
    this._lookupCache.clear();
    this._pendingRefresh.clear();
  },
};
