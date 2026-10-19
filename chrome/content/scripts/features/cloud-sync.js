// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 坚果云统一云同步（0.56.0）
 *
 * 设计目标：**本项目后续所有数据同步需求都从这里走**——设置项、AI 对话记录、
 * 技能包与任意安装包，统一一套凭据、一套索引、一套状态反馈。新增一类数据 =
 * `registerDataset()`，不需要再改引擎。
 *
 * 远程布局（cfg.root 默认 /Papilot）：
 *   data/settings.json                 设置项快照（白名单，剔除密钥）
 *   data/papilot-chat-sessions.json    AI 对话记录
 *   packages/skill-packs/<id>-<v>.json 已安装技能包（stageSkillPacks 自动收集）
 *   packages/installers/<name>         用户自己丢进来的安装包
 *   devices/<deviceId>.json            设备心跳（只写不读，用于多机排查）
 *   .ppparts/<file>.<hash8>/0001.part  大文件分卷
 *
 * 三条不可动摇的纪律（对应 docs/坚果云云同步-移植方案与风险评估.md §5）：
 *   1. **删除不传播**：一侧删除只记日志，绝不删对面（误删传播是最常见的数据灾难）；
 *   2. **冲突不合并**：文件默认 keepBoth（本机版本改名另存后上传，再拉云端版本）；
 *      设置快照不做逐键合并，本机为准 + 云端旧版留档；
 *   3. **密钥不同步**：`cloudSync*` 自身配置与 apiKey/token/password 类键一律排除，
 *      否则一次同步就把全机密钥送上云。
 *
 * 错误处理：所有失败都带 `code`（WebDAV.CODES），401 与 403 严格区分；
 * 网络类自动重试（指数退避+抖动），授权类立刻停并要求重新填应用密码，
 * 且**不清空已存凭据**（避免"越修越丢"）。
 *
 * 本模块只依赖 core/webdav.js 与全局 Prefs；所有 IO 都走 IOUtils/PathUtils。
 */
/* global Zotero, Services, IOUtils, PathUtils, Prefs, WebDAV, SkillPacks, TextEncoder */

var CloudSync = (function () {
  "use strict";

  var CODES = WebDAV.CODES;
  var err = WebDAV.syncError;

  /* ---------------- pref 键（全部落在 extensions.zotero.papilot.*） ---------------- */

  var K = {
    enabled: "cloudSyncEnabled",
    email: "cloudSyncEmail",
    token: "cloudSyncToken",
    remember: "cloudSyncRememberToken",
    baseUrl: "cloudSyncBaseUrl",
    root: "cloudSyncRoot",
    policy: "cloudSyncConflictPolicy",
    direction: "cloudSyncDirection",
    datasets: "cloudSyncDatasets",
    autoMinutes: "cloudSyncAutoMinutes",
    maxFileMB: "cloudSyncMaxFileMB",
    largeFileMB: "cloudSyncLargeFileMB",
    partMB: "cloudSyncPartMB",
    timeoutSec: "cloudSyncTimeoutSec",
    lastSyncAt: "cloudSyncLastSyncAt",
    deviceId: "cloudSyncDeviceId",
    deviceName: "cloudSyncDeviceName",
    lastError: "cloudSyncLastError",
    snapshotMaxKB: "cloudSyncSnapshotMaxKB",
    assembleMaxMB: "cloudSyncAssembleMaxMB",
    maxFiles: "cloudSyncMaxFiles",
    maxDepth: "cloudSyncMaxDepth",
    keepOldParts: "cloudSyncKeepOldParts",
    indexOwner: "cloudSyncIndexOwner",
  };

  var DEFAULTS = {
    enabled: true,
    baseUrl: WebDAV.DEFAULT_BASE,
    root: "/Papilot",
    policy: "keepBoth",
    direction: "both",
    datasets: "settings,chatSessions,packages",
    autoMinutes: 0,
    maxFileMB: 512,
    largeFileMB: 64,
    partMB: 32,
    timeoutSec: 40,
    remember: true,
    snapshotMaxKB: 1024,
    assembleMaxMB: 128,
    maxFiles: 2000,
    maxDepth: 6,
    keepOldParts: false,
  };

  /** 数据集：新增同步对象只需往这里加一条（或在运行期 registerDataset） */
  var DATASETS = [
    {
      key: "settings",
      name: "设置项",
      kind: "pref",
      remoteDir: "data",
      fileName: "settings.json",
      desc: "提示词、模型通道之外的偏好项（密钥类自动剔除）",
    },
    {
      key: "chatSessions",
      name: "AI 对话记录",
      kind: "file",
      remoteDir: "data",
      localName: "papilot-chat-sessions.json",
      fileName: "papilot-chat-sessions.json",
      desc: "浮窗/分屏窗口的会话列表（整文件替换）",
    },
    {
      key: "packages",
      name: "技能包与安装包",
      kind: "dir",
      remoteDir: "packages",
      localDir: "packages",
      desc: "已安装技能包清单 + 用户自己放入的 xpi/zip/json",
    },
  ];

  /** 密钥类 pref：绝不出本机 */
  var SECRET_LEAF_RE = /(password|passwd|secret|apikey|api_key|cookie|credential|token$|key$)/i;
  var SECRET_LEAVES = ["aiChannels", "aiApiKey", "cnkiPassword", "easyScholarKey", "mcpToken", "s2ApiKey", "thirdSourcePassword"];

  /**
   * 非设置项：**默认不进云端**。分三类，每一类同步过去都会造成真实故障：
   *   · 缓存/统计/会话：每天自然变化 → 天天冲突、快照虚胖；
   *   · 大型数据集（分区数据等）：MB 级，改一个开关就整包上传；
   *   · 机器相关绝对路径：同步到另一台机器会直接改坏对方的壁纸/下载目录/数据路径。
   * 用显式清单而不是正则猜——猜错一次就是跨机配置污染。
   */
  var NON_SETTING_LEAVES = [
    // 缓存 / 统计 / 会话
    "autoTagCache", "autoTagCacheData", "searchSubsRecoCache", "searchSubsSeen",
    "searchSubsFeedback", "searchSubsRecoDismissed", "discoveryResults", "discoveryLastRun",
    "readingProgress", "readingStats", "agentMemory", "agentAuditLog",
    "chatSessions", "workbenchSessions", "refPaneCache", "bilingualStructExtract",
    // 大型数据集
    "rankDataSets", "rankDataSetsM181",
    // 机器相关绝对路径
    "uiWallpaperPath", "uiWallpaperUrl", "cnDownloadDir", "rankDataPath", "metaRulesJournalDir",
    // 设备标识 / 一次性标记 / 每日计数器
    "installId", "renewPromptShownFor", "updateNoticeLastSeen", "brandMigrated",
    "accountServerMigrated15", "translateMigrated28", "translateFallbackUpgraded",
    "compareSelfTest", "pdfInlineSelfTest", "pdfDualSelfTest", "cnkiBootSelfTest",
    "autoReadDailyCount", "automationDailyAiCount", "readerPopupDailyCount",
    "cloudSyncIndexOwner",
  ];

  /* ---------------- 小工具 ---------------- */

  var stamp = function (d) {
    var x = d instanceof Date ? d : new Date(d || Date.now());
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return String(x.getFullYear()) + p(x.getMonth() + 1) + p(x.getDate()) +
      "-" + p(x.getHours()) + p(x.getMinutes()) + p(x.getSeconds());
  };

  function encodeText(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(s));
    var enc = unescape(encodeURIComponent(String(s)));
    var u8 = new Uint8Array(enc.length);
    for (var i = 0; i < enc.length; i++) u8[i] = enc.charCodeAt(i);
    return u8;
  }

  function decodeText(bytes) {
    try {
      if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    } catch (e) { /* 回落 */ }
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  function safeName(s) {
    return String(s == null ? "" : s).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** 极简中断令牌：XHR 能真中断，Zotero.HTTP 只能靠 _checkAbort 在文件之间生效 */
  function newAbortToken() {
    var t = { aborted: false, cbs: [] };
    t.abort = function () {
      if (t.aborted) return;
      t.aborted = true;
      t.cbs.forEach(function (cb) { try { cb(); } catch (e) { /* ignore */ } });
    };
    t.register = function (cb) { if (typeof cb === "function") t.cbs.push(cb); };
    return t;
  }

  function copyMap(m) {
    var o = {};
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) o[k] = m[k];
    return o;
  }

  /* ---------------- 主体 ---------------- */

  var CS = {
    VERSION: "1",
    DATASETS: DATASETS,
    K: K,
    CODES: CODES,

    _listeners: [],
    _state: {
      state: "idle",
      phase: "",
      message: "尚未同步",
      file: "",
      current: 0,
      total: 0,
      bytesDone: 0,
      bytesTotal: 0,
      lastError: null,
      authExpired: false,
      updatedAt: 0,
    },
    _logBuf: [],
    _running: false,
    _abortToken: null,
    _autoTimer: null,
    _sessionToken: "",
    _client: null,
    _retries: 2,

    /* ---------- 配置 ---------- */

    config: function () {
      var g = function (key, dflt) {
        try {
          var v = Prefs.get(key, dflt);
          return v === undefined || v === null || v === "" ? dflt : v;
        } catch (e) { return dflt; }
      };
      var root = WebDAV.normalizePath(g(K.root, DEFAULTS.root));
      // 根目录不允许是 "/"：一次误配置就会把整个网盘当同步区
      if (!root || root === "/") root = DEFAULTS.root;
      var remember = !!g(K.remember, DEFAULTS.remember);
      var token = this._sessionToken || (remember ? String(g(K.token, "") || "") : "");
      return {
        enabled: !!g(K.enabled, DEFAULTS.enabled),
        email: String(g(K.email, "") || "").trim(),
        token: String(token || ""),
        remember: remember,
        baseUrl: String(g(K.baseUrl, DEFAULTS.baseUrl) || DEFAULTS.baseUrl).replace(/\/+$/, ""),
        root: root,
        policy: String(g(K.policy, DEFAULTS.policy) || DEFAULTS.policy),
        direction: String(g(K.direction, DEFAULTS.direction) || DEFAULTS.direction),
        datasets: String(g(K.datasets, DEFAULTS.datasets) || DEFAULTS.datasets),
        autoMinutes: Math.max(0, Number(g(K.autoMinutes, DEFAULTS.autoMinutes)) || 0),
        maxFileMB: Math.max(1, Number(g(K.maxFileMB, DEFAULTS.maxFileMB)) || DEFAULTS.maxFileMB),
        largeFileMB: Math.max(1, Number(g(K.largeFileMB, DEFAULTS.largeFileMB)) || DEFAULTS.largeFileMB),
        partMB: Math.max(1, Number(g(K.partMB, DEFAULTS.partMB)) || DEFAULTS.partMB),
        timeoutSec: Math.max(5, Number(g(K.timeoutSec, DEFAULTS.timeoutSec)) || DEFAULTS.timeoutSec),
        snapshotMaxKB: Math.max(64, Number(g(K.snapshotMaxKB, DEFAULTS.snapshotMaxKB)) || DEFAULTS.snapshotMaxKB),
        assembleMaxMB: Math.max(8, Number(g(K.assembleMaxMB, DEFAULTS.assembleMaxMB)) || DEFAULTS.assembleMaxMB),
        maxFiles: Math.max(50, Number(g(K.maxFiles, DEFAULTS.maxFiles)) || DEFAULTS.maxFiles),
        maxDepth: Math.max(1, Number(g(K.maxDepth, DEFAULTS.maxDepth)) || DEFAULTS.maxDepth),
        keepOldParts: !!g(K.keepOldParts, DEFAULTS.keepOldParts),
        deviceId: this.deviceId(),
        lastSyncAt: Number(g(K.lastSyncAt, 0)) || 0,
      };
    },

    /** 只保存已知字段；未知字段忽略（防止 UI 拼错键静默写脏数据） */
    saveConfig: function (patch) {
      if (!patch || typeof patch !== "object") return this.config();
      var map = {
        enabled: K.enabled, email: K.email, remember: K.remember, baseUrl: K.baseUrl,
        root: K.root, policy: K.policy, direction: K.direction, datasets: K.datasets,
        autoMinutes: K.autoMinutes, maxFileMB: K.maxFileMB, largeFileMB: K.largeFileMB,
        partMB: K.partMB, timeoutSec: K.timeoutSec, deviceName: K.deviceName,
        snapshotMaxKB: K.snapshotMaxKB, assembleMaxMB: K.assembleMaxMB,
        maxFiles: K.maxFiles, maxDepth: K.maxDepth,
      };
      var policyOk = { keepBoth: 1, local: 1, remote: 1 };
      var dirOk = { both: 1, up: 1, down: 1 };
      for (var key in patch) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        if (!map[key]) continue;
        var v = patch[key];
        try {
          if (key === "root") {
            var r = WebDAV.normalizePath(v);
            // 兜底：不接受根目录（会把整个网盘当同步区）与含 ".." 的路径
            if (!r || r === "/" || r.indexOf("..") >= 0) r = DEFAULTS.root;
            Prefs.set(K.root, r);
          } else if (key === "policy") {
            Prefs.set(K.policy, policyOk[v] ? v : DEFAULTS.policy);
          } else if (key === "direction") {
            Prefs.set(K.direction, dirOk[v] ? v : DEFAULTS.direction);
          } else if (key === "baseUrl") {
            var u = String(v || "").trim();
            Prefs.set(K.baseUrl, /^https:\/\//i.test(u) ? u.replace(/\/+$/, "") : DEFAULTS.baseUrl);
          } else if (key === "datasets") {
            var list = String(v || "").split(",").map(function (s) { return s.trim(); })
              .filter(function (s) { return !!this.datasetOf(s); }, this);
            Prefs.set(K.datasets, list.join(",") || DEFAULTS.datasets);
          } else if (key === "enabled" || key === "remember" || key === "keepOldParts") {
            Prefs.set(key === "keepOldParts" ? K.keepOldParts : map[key], !!v);
          } else if (key === "email") {
            Prefs.set(K.email, String(v || "").trim().slice(0, 200));
          } else if (key === "deviceName") {
            Prefs.set(K.deviceName, String(v || "").slice(0, 60));
          } else {
            var n = Number(v);
            if (!isFinite(n)) continue;
            Prefs.set(map[key], Math.round(n));
          }
        } catch (e) { /* 单键失败不影响其余 */ }
      }
      return this.config();
    },

    deviceId: function () {
      var id = "";
      try { id = String(Prefs.get(K.deviceId, "") || ""); } catch (e) { id = ""; }
      if (id) return id;
      id = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      try { Prefs.set(K.deviceId, id); } catch (e) { /* 记不住就用临时的，不挡启动 */ }
      return id;
    },

    deviceName: function () {
      var n = "";
      try { n = String(Prefs.get(K.deviceName, "") || ""); } catch (e) { n = ""; }
      if (n) return n;
      var os = "未知系统";
      try {
        if (Zotero.isWin) os = "Windows";
        else if (Zotero.isMac) os = "macOS";
        else if (Zotero.isLinux) os = "Linux";
      } catch (e) { /* ignore */ }
      return os + " · " + this.deviceId().slice(-4);
    },

    isLoggedIn: function () {
      var c = this.config();
      return !!(c.email && c.token);
    },

    /** 状态快照（UI 直接渲染；不要在这里抛异常） */
    status: function () {
      var s = this._state;
      return {
        state: s.state, phase: s.phase, message: s.message, file: s.file,
        current: s.current, total: s.total,
        bytesDone: s.bytesDone, bytesTotal: s.bytesTotal,
        lastError: s.lastError ? copyMap(s.lastError) : null,
        authExpired: !!s.authExpired, updatedAt: s.updatedAt,
        running: this._running,
        loggedIn: this.isLoggedIn(),
        lastSyncAt: this.config().lastSyncAt,
        deviceName: this.deviceName(),
      };
    },

    /** 订阅状态/进度/日志；返回取消订阅函数 */
    on: function (fn) {
      if (typeof fn !== "function") return function () {};
      this._listeners.push(fn);
      return function () {
        var i = CS._listeners.indexOf(fn);
        if (i >= 0) CS._listeners.splice(i, 1);
      };
    },

    logs: function () { return this._logBuf.slice(); },

    _emit: function (ev) {
      var list = this._listeners.slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](ev); } catch (e) { /* 单个订阅者异常不能影响同步 */ }
      }
    },

    _log: function (level, msg) {
      var rec = { at: Date.now(), level: level || "info", msg: String(msg == null ? "" : msg) };
      this._logBuf.push(rec);
      if (this._logBuf.length > 200) this._logBuf.splice(0, this._logBuf.length - 200);
      this._emit({ type: "log", entry: rec });
    },

    _setState: function (patch) {
      if (!patch) return;
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) this._state[k] = patch[k];
      }
      this._state.updatedAt = Date.now();
      this._emit({ type: "state", state: this.status() });
    },

    _progress: function (patch) {
      this._emit({ type: "progress", progress: patch });
    },

    /* ---------- 授权 ---------- */

    /**
     * 登录 = 校验凭据 + 记住（可选）。
     * @param {{email:string, token:string, remember?:boolean}} o
     * @returns {Promise<{ok:boolean, rootExists:boolean, message:string}>}
     */
    login: async function (o) {
      o = o || {};
      var email = String(o.email == null ? "" : o.email).trim();
      // 应用密码里不会有空格，但用户从网页复制常带换行/前后空格
      var token = String(o.token == null ? "" : o.token).replace(/\s+/g, " ").trim();
      if (!email) throw err(CODES.CONFIG, "请填写坚果云账号（邮箱）");
      if (!token) throw err(CODES.AUTH_REQUIRED, "请填写应用密码（不是登录密码）");

      var remember = o.remember !== false;
      var prevEmail = ""; var prevToken = "";
      try { prevEmail = String(Prefs.get(K.email, "") || ""); prevToken = String(Prefs.get(K.token, "") || ""); } catch (e) { /* ignore */ }

      try {
        Prefs.set(K.email, email);
        Prefs.set(K.remember, !!remember);
        if (remember) Prefs.set(K.token, token);
        else {
          this._sessionToken = token;
          Prefs.set(K.token, "");
        }
        this._authExpired = false;
        this._client = null;
        this._setState({ state: "auth", message: "正在验证坚果云凭据…", authExpired: false, lastError: null });

        var info = await this.testConnection();
        this._log("info", "授权成功：" + email + (info.rootExists ? "" : "（同步目录尚未创建，首次同步时自动建立）"));
        this._setState({ state: "idle", message: "已连接坚果云" + (info.rootExists ? "" : "（同步目录待创建）") });
        this.startAutoSync();
        return { ok: true, rootExists: info.rootExists, message: info.message };
      } catch (e) {
        // 只有"凭据确实不对"才回滚；网络问题保留用户输入，避免离线时把正确密码清掉
        if (e && (e.code === CODES.AUTH_REQUIRED || e.code === CODES.AUTH_EXPIRED)) {
          try {
            Prefs.set(K.email, prevEmail);
            Prefs.set(K.token, prevToken);
            this._sessionToken = "";
          } catch (e2) { /* ignore */ }
        }
        this._failState(e, "授权失败");
        throw e;
      }
    },

    /** 只测连通与凭据，不写任何配置 */
    testConnection: async function () {
      var cfg = this.config();
      if (!cfg.email || !cfg.token) throw err(CODES.AUTH_REQUIRED, "请先填写账号与应用密码");
      var client = this._clientFor(cfg);
      var rootExists = false;
      try {
        await client.propfind(cfg.root, 0);
        rootExists = true;
      } catch (e) {
        if (e.code !== CODES.NOT_FOUND) throw e;
        // 目录还没建：退回根目录验凭据（能列根 = 凭据有效）
        await client.propfind("/", 0);
        rootExists = false;
      }
      return {
        ok: true,
        rootExists: rootExists,
        message: rootExists ? "连接正常，同步目录已存在" : "连接正常，同步目录将在首次同步时创建",
      };
    },

    logout: function () {
      this.stopAutoSync();
      this._sessionToken = "";
      try {
        Prefs.set(K.token, "");
        Prefs.set(K.email, "");
      } catch (e) { /* ignore */ }
      this._client = null;
      this._setState({ state: "idle", message: "已退出坚果云", lastError: null, authExpired: false, file: "", current: 0, total: 0 });
    },

    _clientFor: function (cfg) {
      if (this._client && this._client.__cfgKey === this._cfgKey(cfg)) return this._client;
      var client = WebDAV.createClient({
        baseUrl: cfg.baseUrl,
        username: cfg.email,
        password: cfg.token,
        timeoutMs: cfg.timeoutSec * 1000,
        // 生产 120ms 起、遇限流自动升档；测试/离线校验可置 0（见 _minIntervalMs）
        minIntervalMs: this._minIntervalMs === undefined ? 120 : this._minIntervalMs,
        transport: this._transport || undefined,
      });
      client.__cfgKey = this._cfgKey(cfg);
      this._client = client;
      return client;
    },

    _cfgKey: function (cfg) {
      return [cfg.baseUrl, cfg.email, cfg.token, cfg.timeoutSec].join("|");
    },

    /* ---------- 同步主流程 ---------- */

    /**
     * @param {{direction?:"both"|"up"|"down", datasets?:string[], dryRun?:boolean}} opts
     * @returns {Promise<object>} 结果汇总；失败也返回（不抛），只有配置缺失才抛
     */
    syncNow: async function (opts) {
      opts = opts || {};
      if (this._running) return { ok: false, code: "BUSY", error: "同步正在进行中，请等这一轮结束" };

      var cfg = this.config();
      if (!cfg.email || !cfg.token) {
        var e0 = err(CODES.AUTH_REQUIRED, "尚未配置坚果云账号/应用密码");
        this._failState(e0, "无法同步");
        throw e0;
      }

      this._running = true;
      this._abortToken = newAbortToken();
      this._ensuredDirs = {};
      this._indexWriteError = null;
      var self = this;
      var result = {
        ok: true, startedAt: Date.now(), finishedAt: 0, dryRun: !!opts.dryRun,
        uploaded: 0, downloaded: 0, skipped: 0, conflicts: 0, failed: 0,
        bytesUp: 0, bytesDown: 0, errors: [], warnings: [], datasets: {},
      };

      try {
        var client = this._clientFor(cfg);
        this._setState({ state: "scanning", phase: "scan", message: "检查云端同步目录…", file: "", current: 0, total: 0, bytesDone: 0, bytesTotal: 0, lastError: null });
        await client.ensureDir(cfg.root);

        var index = await this._readIndex();
        var list = this._selectDatasets(opts.datasets);
        if (!list.length) throw err(CODES.CONFIG, "没有勾选任何要同步的数据集");

        for (var i = 0; i < list.length; i++) {
          this._checkAbort();
          await this._syncDataset(client, cfg, list[i], index, opts, result);
        }

        if (!opts.dryRun) {
          await this._writeIndex(index);
          if (this._indexWriteError) {
            result.warnings.push({ dataset: "index", code: "IO", message: "本地索引写入失败：" + this._indexWriteError });
            this._log("error", "本地索引写入失败：" + this._indexWriteError + "（下一轮会退化判定）");
            this._indexWriteError = null;
          }
          await this._writeDeviceState(client, cfg, result);
          try { Prefs.set(K.lastSyncAt, Date.now()); } catch (e) { /* ignore */ }
        }

        result.finishedAt = Date.now();
        var summary = "上传 " + result.uploaded + " · 下载 " + result.downloaded +
          " · 跳过 " + result.skipped + (result.conflicts ? " · 冲突 " + result.conflicts : "") +
          (result.failed ? " · 失败 " + result.failed : "") +
          (result.warnings.length ? " · 告警 " + result.warnings.length : "");
        this._log("info", (opts.dryRun ? "预演完成：" : "同步完成：") + summary);
        this._setState({
          state: result.failed ? "warn" : "done",
          phase: "done",
          message: (opts.dryRun ? "预演：" : "") + summary,
          file: "", current: 0, total: 0,
          authExpired: false,
        });
        return result;
      } catch (e) {
        result.ok = false;
        result.finishedAt = Date.now();
        result.error = String(e && e.message || e);
        result.code = (e && e.code) || CODES.UNKNOWN;
        this._failState(e, "同步失败");
        return result;
      } finally {
        this._running = false;
        this._abortToken = null;
      }
    },

    uploadOnly: function (opts) {
      var o = {};
      for (var k in (opts || {})) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
      o.direction = "up";
      return this.syncNow(o);
    },

    downloadOnly: function (opts) {
      var o = {};
      for (var k in (opts || {})) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
      o.direction = "down";
      return this.syncNow(o);
    },

    cancel: function () {
      if (this._abortToken) {
        this._log("warn", "用户取消了本轮同步（当前文件完成后停止）");
        this._abortToken.abort();
      }
    },

    _checkAbort: function () {
      if (this._abortToken && this._abortToken.aborted) throw err(CODES.ABORTED, "同步已取消");
    },

    /** 远程目录创建缓存（同一轮同步内每个目录只 MKCOL 一次） */
    _ensureRemoteDir: async function (client, dir) {
      if (!this._ensuredDirs) this._ensuredDirs = {};
      if (this._ensuredDirs[dir]) return;
      await client.ensureDir(dir);
      this._ensuredDirs[dir] = true;
    },

    _failState: function (e, action) {
      var code = (e && e.code) || CODES.UNKNOWN;
      var msg = String(e && e.message || e);
      var info = { code: code, message: msg, at: Date.now(), retryable: WebDAV.retryable(code) };
      this._log("error", action + "：" + msg + " [" + code + "]");
      this._setState({
        state: "error",
        phase: "error",
        message: action + "：" + msg,
        lastError: info,
        authExpired: code === CODES.AUTH_REQUIRED || code === CODES.AUTH_EXPIRED,
      });
      try { Prefs.set(K.lastError, JSON.stringify(info)); } catch (e2) { /* ignore */ }
    },

    _selectDatasets: function (keys) {
      var all = this.DATASETS;
      var wanted = keys && keys.length ? keys : String(this.config().datasets || "").split(",");
      var out = [];
      for (var i = 0; i < all.length; i++) {
        if (wanted.indexOf(all[i].key) >= 0) out.push(all[i]);
      }
      return out;
    },

    datasetOf: function (key) {
      for (var i = 0; i < this.DATASETS.length; i++) {
        if (this.DATASETS[i].key === key) return this.DATASETS[i];
      }
      return null;
    },

    /** 新增同步对象（运行期扩展点；重复 key 覆盖） */
    registerDataset: function (ds) {
      if (!ds || !ds.key || !ds.kind) throw err(CODES.CONFIG, "数据集定义缺 key/kind");
      var existing = this.datasetOf(ds.key);
      if (existing) {
        for (var k in ds) if (Object.prototype.hasOwnProperty.call(ds, k)) existing[k] = ds[k];
        return existing;
      }
      this.DATASETS.push(ds);
      return ds;
    },

    _withRetry: async function (fn, action) {
      var attempt = 0;
      for (;;) {
        try {
          return await fn(attempt);
        } catch (e) {
          var code = (e && e.code) || CODES.UNKNOWN;
          if (code === CODES.ABORTED) throw e;
          if (!WebDAV.retryable(code) || attempt >= this._retries) throw e;
          attempt++;
          var wait = WebDAV.backoff(attempt, 900, 8000);
          // 服务端明确给了"多久后再来"（坚果云限流）→ 必须按它等，短退避只会继续撞墙
          if (e && Number(e.retryAfterMs) > 0) wait = Math.max(wait, Number(e.retryAfterMs));
          var why = code === CODES.RATE_LIMIT
            ? "坚果云临时限流（请求过于密集）"
            : (e.message || code);
          this._log("warn", action + "：" + why + "，第 " + attempt + " 次重试（" + Math.round(wait / 1000) + "s 后）");
          this._setState({ phase: "retry", message: action + "重试中（" + attempt + "/" + this._retries + "）" });
          await sleep(wait);
          this._checkAbort();
        }
      }
    },

    /* ---------- 单个数据集 ---------- */

    _syncDataset: async function (client, cfg, ds, index, opts, result) {
      var dir = WebDAV.join(cfg.root, ds.remoteDir);
      var stat = { uploaded: 0, downloaded: 0, skipped: 0, conflicts: 0, failed: 0 };
      result.datasets[ds.key] = stat;
      var direction = opts.direction || cfg.direction || "both";

      this._setState({ state: "scanning", phase: "scan", message: "扫描「" + ds.name + "」…" });
      await client.ensureDir(dir);

      // 扫描预算：超限时**整数据集跳过**，绝不做"只同步看到的部分"——
      // 漏扫的文件会被当成"云端独有"而触发下载/覆盖，比不同步危险得多。
      var budget = { maxFiles: cfg.maxFiles, maxDepth: cfg.maxDepth, count: 0, truncated: 0, deep: 0 };
      var local;
      var remote;
      try {
        local = await this._scanLocal(ds, budget);
        remote = await this._scanRemote(client, dir, ds, budget);
      } catch (e) {
        stat.failed++; result.failed++;
        result.errors.push({ dataset: ds.key, file: "", code: (e && e.code) || CODES.UNKNOWN, message: String(e && e.message || e) });
        this._log("error", "「" + ds.name + "」扫描失败，已跳过该数据集：" + (e && e.message || e));
        return;
      }
      if (budget.truncated || budget.deep) {
        var whyLimit = budget.truncated
          ? "文件数超过上限 " + cfg.maxFiles
          : "目录深度超过上限 " + cfg.maxDepth;
        var msgLimit = "「" + ds.name + "」" + whyLimit + "，已跳过该数据集以避免误判；可在「云同步 → 高级」调大上限";
        result.warnings.push({ dataset: ds.key, code: "LIMIT", message: msgLimit });
        stat.failed++; result.failed++;
        this._log("warn", msgLimit);
        return;
      }
      // 多个数据集可能共用一个远程目录（settings 与 chatSessions 都在 data/）：
      // 单文件型数据集必须只认自己那一个文件名，否则会把邻居的文件当成自己的下载。
      if (ds.kind !== "dir") {
        var only = ds.fileName || ds.localName;
        var picked = {};
        if (only && remote[only]) picked[only] = remote[only];
        remote = picked;
      }
      var keys = Object.keys(local).concat(Object.keys(remote).filter(function (k) { return !local[k]; })).sort();
      var total = keys.length;

      this._log("info", "「" + ds.name + "」本地 " + Object.keys(local).length + " 个，云端 " + Object.keys(remote).length + " 个");

      for (var i = 0; i < keys.length; i++) {
        this._checkAbort();
        var rel = keys[i];
        var l = local[rel] || null;
        var r = remote[rel] || null;
        var idxKey = ds.key + "::" + rel;
        var entry = index.entries[idxKey] || null;

        var d = this.decideAction({ local: l, remote: r, entry: entry, policy: cfg.policy, direction: direction });

        this._progress({
          dataset: ds.key, file: rel, current: i + 1, total: total,
          action: d.action, reason: d.reason,
          bytesTotal: (l && l.size) || (r && r.size) || 0,
        });
        this._setState({ file: rel, current: i + 1, total: total });

        if (d.action === "skip") {
          stat.skipped++;
          result.skipped++;
          // 没有索引但有基线（例如云端本来就有这个文件）→ 记一条，避免下次又判冲突
          if (!entry && r) index.entries[idxKey] = this._makeEntry(l, r, null);
          continue;
        }

        if (opts.dryRun) {
          if (d.action === "upload") { stat.uploaded++; result.uploaded++; }
          else if (d.action === "download") { stat.downloaded++; result.downloaded++; }
          else if (d.action === "conflict") { stat.conflicts++; result.conflicts++; }
          continue;
        }

        try {
          if (d.action === "upload") {
            var up = await this._uploadOne(client, cfg, ds, { rel: rel, local: l, remote: r, entry: entry });
            index.entries[idxKey] = up.entry;
            stat.uploaded++; result.uploaded++;
            result.bytesUp += up.entry.size || 0;
          } else if (d.action === "download") {
            var down = await this._downloadOne(client, cfg, ds, { rel: rel, local: l, remote: r, entry: entry });
            index.entries[idxKey] = down.entry;
            stat.downloaded++; result.downloaded++;
            result.bytesDown += (r && r.size) || 0;
          } else if (d.action === "conflict") {
            var res = await this._resolveConflict(client, cfg, ds, { rel: rel, local: l, remote: r, entry: entry });
            index.entries[idxKey] = res.entry;
            stat.conflicts++; result.conflicts++;
            if (res.uploaded) { stat.uploaded++; result.uploaded++; }
            if (res.downloaded) { stat.downloaded++; result.downloaded++; }
          }
        } catch (e) {
          // 授权失效与配额满都不该逐文件重试：立刻中止整轮，提示用户处理
          if (e && (e.code === CODES.AUTH_REQUIRED || e.code === CODES.AUTH_EXPIRED || e.code === CODES.QUOTA)) throw e;
          stat.failed++; result.failed++;
          result.errors.push({ dataset: ds.key, file: rel, code: (e && e.code) || CODES.UNKNOWN, message: String(e && e.message || e) });
          this._log("error", "「" + ds.name + "」" + rel + " 失败：" + (e && e.message || e));
        }
      }
      this._setState({ phase: "scan", message: "「" + ds.name + "」完成" });
    },

    /**
     * 纯函数：三向增量判定。**测试直接喂对象**（test/cloud-sync.test.js）。
     * @returns {{action:"upload"|"download"|"skip"|"conflict", reason:string}}
     */
    decideAction: function (o) {
      o = o || {};
      var local = o.local || null;
      var remote = o.remote || null;
      var entry = o.entry || null;
      var direction = o.direction || "both";

      if (!local && !remote) return { action: "skip", reason: "两边都没有" };

      if (direction === "up") {
        if (!local) return { action: "skip", reason: "仅云端存在（方向=仅上传）" };
        if (!remote) return { action: "upload", reason: "云端没有" };
        if (!entry) return { action: "upload", reason: "无同步记录，本机为准" };
        if (this._localChanged(local, entry)) return { action: "upload", reason: "本地已修改" };
        if (this._remoteChanged(remote, entry)) return { action: "upload", reason: "云端已变，按仅上传策略覆盖" };
        return { action: "skip", reason: "无变化" };
      }

      if (direction === "down") {
        if (!remote) return { action: "skip", reason: "仅本机存在（方向=仅下载）" };
        if (!local) return { action: "download", reason: "本机没有" };
        if (!entry) return { action: "download", reason: "无同步记录，云端为准" };
        if (this._remoteChanged(remote, entry)) return { action: "download", reason: "云端已修改" };
        return { action: "skip", reason: "无变化" };
      }

      // 双向
      if (local && !remote) return { action: "upload", reason: "云端没有" };
      if (!local && remote) return { action: "download", reason: "本机没有" };
      if (!entry) {
        // 两边都有但没有基线：大小一致先当同一份（记索引），否则冲突
        if (Number(local.size) === Number(remote.size)) return { action: "skip", reason: "大小一致，视为已同步" };
        return { action: "conflict", reason: "两边都有且无同步记录" };
      }

      var lc = this._localChanged(local, entry);
      var rc = this._remoteChanged(remote, entry);
      if (lc && rc) return { action: "conflict", reason: "两边都改过" };
      if (lc) return { action: "upload", reason: "本地已修改" };
      if (rc) return { action: "download", reason: "云端已修改" };
      return { action: "skip", reason: "无变化" };
    },

    _localChanged: function (local, entry) {
      if (!entry) return true;
      if (local.hash && entry.hash) return String(local.hash) !== String(entry.hash);
      if (Number(local.size) !== Number(entry.localSize)) return true;
      // 文件系统 mtime 有秒级/毫秒级差异，留 1.5s 容差；容差内改动靠 size 兜底
      if (entry.localMtime && Math.abs(Number(local.mtime) - Number(entry.localMtime)) > 1500) return true;
      return false;
    },

    _remoteChanged: function (remote, entry) {
      if (!entry) return true;
      if (remote.etag && entry.etag) return String(remote.etag) !== String(entry.etag);
      return Number(remote.size) !== Number(entry.size);
    },

    _makeEntry: function (local, remote, hash) {
      return {
        etag: (remote && remote.etag) || "",
        // 原样 etag（可能带引号/裸串）：下一次条件写必须原样回传，否则坚果云 412
        etagRaw: (remote && remote.etagRaw) || "",
        size: Number((remote && remote.size) || (local && local.size) || 0),
        remoteMtime: Number((remote && remote.mtime) || 0),
        localSize: Number((local && local.size) || 0),
        localMtime: Number((local && local.mtime) || 0),
        hash: hash || (local && local.hash) || "",
        syncedAt: Date.now(),
      };
    },

    /* ---------- 上传 ---------- */

    _uploadOne: async function (client, cfg, ds, ctx) {
      var rel = ctx.rel;
      var remotePath = WebDAV.join(cfg.root, ds.remoteDir, rel);
      // 目录型数据集有子目录（packages/installers/…），PUT 前必须逐级 MKCOL，
      // 否则 WebDAV 返回 409（父集合不存在）。按目录缓存，避免每个文件都探测一次。
      await this._ensureRemoteDir(client, WebDAV.dirname(remotePath));
      var bytes = await this._readLocalBytes(ds, ctx.local);
      var size = bytes.byteLength;
      var maxBytes = cfg.maxFileMB * 1024 * 1024;
      if (size > maxBytes) {
        throw err(CODES.TOO_LARGE, "文件 " + WebDAV.formatBytes(size) + " 超过上限 " + cfg.maxFileMB + "MB，已跳过");
      }

      var ifMatch = ctx.entry && (ctx.entry.etagRaw || ctx.entry.etag);
      var largeBytes = cfg.largeFileMB * 1024 * 1024;
      var out;
      var self = this;

      if (size > largeBytes) {
        this._log("info", "大文件分卷上传：" + rel + "（" + WebDAV.formatBytes(size) + "）");
        out = await this._uploadParts(client, cfg, remotePath, bytes, ctx, ds.key);
      } else {
        out = await this._withRetry(async function (attempt) {
          try {
            return await client.put(remotePath, bytes, {
              ifMatch: attempt > 0 ? "" : ifMatch,     // 重试时不再带旧 etag（上次可能已写成功）
              createOnly: !ctx.remote,
              contentType: /\.json$/i.test(rel) ? "application/json" : "application/octet-stream",
              abortToken: self._abortToken,
            });
          } catch (e) {
            // 重试遇到 412：很可能上一次其实写成功了 → 用大小复核，避免误报冲突
            if (e.code === CODES.CONFLICT && attempt > 0) {
              var st = await client.stat(remotePath);
              if (st && Number(st.size) === size) return { etag: st.etag, size: size, recovered: true };
            }
            throw e;
          }
        }, "上传 " + rel);
      }

      var hash = size <= 16 * 1024 * 1024 ? await WebDAV.sha256Hex(bytes) : (ctx.local && ctx.local.hash) || "";
      return {
        entry: this._makeEntry(
          { size: size, mtime: (ctx.local && ctx.local.mtime) || Date.now(), hash: hash },
          { etag: out.etag, etagRaw: out.etagRaw, size: size },
          hash
        ),
      };
    },

    /** 大文件分卷：逐片跳过已存在的同尺寸片 → 写清单。下载端靠清单组装。 */
    _uploadParts: async function (client, cfg, remotePath, bytes, ctx, dsKey) {
      var total = bytes.byteLength;
      var partBytes = cfg.partMB * 1024 * 1024;
      var count = Math.max(1, Math.ceil(total / partBytes));
      var hash = await WebDAV.sha256Hex(bytes);
      var dir = WebDAV.partsDirFor(remotePath, hash || Date.now().toString(16));
      await client.ensureDir(dir);

      var parts = [];
      for (var i = 0; i < count; i++) {
        this._checkAbort();
        var start = i * partBytes;
        var end = Math.min(total, start + partBytes);
        var chunk = bytes.subarray(start, end);
        var name = WebDAV.partName(i);
        var pPath = WebDAV.join(dir, name);
        var existed = null;
        try { existed = await client.stat(pPath); } catch (e) { existed = null; }
        if (!(existed && Number(existed.size) === chunk.byteLength)) {
          await this._withRetry(function () {
            return client.put(pPath, chunk, { abortToken: CS._abortToken });
          }, "上传分片 " + name);
        } else {
          this._log("info", "分片已存在，跳过：" + name);
        }
        parts.push({ name: name, size: chunk.byteLength });
        this._progress({ dataset: dsKey || "packages", file: WebDAV.basename(remotePath), current: i + 1, total: count, bytesDone: end, bytesTotal: total, action: "upload" });
      }

      var manifest = {
        version: 1, kind: "papilot-parts", name: WebDAV.basename(remotePath),
        size: total, sha256: hash, partSize: partBytes, parts: parts,
        createdAt: Date.now(), device: this.deviceId(),
      };
      var mPath = WebDAV.manifestPathFor(remotePath);
      var mBytes = encodeText(JSON.stringify(manifest, null, 2));
      var mres = await this._withRetry(function () {
        return client.put(mPath, mBytes, { contentType: "application/json", abortToken: CS._abortToken });
      }, "上传分卷清单");

      // 旧分卷目录按内容 hash 命名，新版本会生成新目录；不清就会把配额吃干。
      // 清理失败不影响本次上传（下次还会再试），只记日志。
      var cleaned = 0;
      if (!cfg.keepOldParts) {
        try {
          cleaned = await this._cleanupOldParts(client, remotePath, dir);
        } catch (e) {
          this._log("warn", "清理旧分卷失败（不影响本次）：" + (e && e.message || e));
        }
      }

      return {
        etag: mres.etag || "", etagRaw: mres.etagRaw || "",
        size: total, parts: count, cleaned: cleaned, manifest: manifest,
      };
    },

    /** 删除同一文件其它 hash 的分卷目录，只保留本次写入的那一组 */
    _cleanupOldParts: async function (client, remotePath, keepDir) {
      var partsRoot = WebDAV.join(WebDAV.dirname(remotePath), ".ppparts");
      var prefix = WebDAV.basename(remotePath) + ".";
      var keep = WebDAV.normalizePath(keepDir);
      var items = [];
      try {
        items = await client.propfind(partsRoot, 1);
      } catch (e) {
        if (e.code === CODES.NOT_FOUND) return 0;
        throw e;
      }
      var removed = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || !it.isDir) continue;
        if (it.path === keep) continue;
        var nm = it.name || WebDAV.basename(it.path);
        if (nm.indexOf(prefix) !== 0) continue;
        try {
          removed += await this._purgeDir(client, it.path, 0);
        } catch (e2) {
          this._log("warn", "删除旧分卷失败：" + it.path + "（" + (e2 && e2.message || e2) + "）");
        }
      }
      if (removed) this._log("info", "已清理旧分卷文件 " + removed + " 个（" + WebDAV.basename(remotePath) + "）");
      return removed;
    },

    /**
     * 递归清空目录。坚果云对 **collection 的 DELETE 返回 403**（真机实测），
     * 所以必须先把里面的分片文件删掉；空目录删不掉就留着（不占配额）。
     */
    _purgeDir: async function (client, dir, depth) {
      if (depth > 2) return 0;
      var items = [];
      try { items = await client.propfind(dir, 1); } catch (e) { return 0; }
      var n = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || it.path === WebDAV.normalizePath(dir)) continue;
        if (it.isDir) n += await this._purgeDir(client, it.path, depth + 1);
        else {
          try { await client.del(it.path); n++; } catch (e2) { /* 单个失败继续 */ }
        }
      }
      try { await client.del(dir); n++; } catch (e3) { /* 403 = 不支持删 collection，留空目录 */ }
      return n;
    },

    _readLocalBytes: async function (ds, local) {
      if (!local) throw err(CODES.IO, "本地文件不存在");
      if (local.data) return local.data;
      if (!local.localPath) throw err(CODES.IO, "本地文件路径缺失");
      try {
        return await IOUtils.read(local.localPath);
      } catch (e) {
        throw err(CODES.IO, "读取本地文件失败：" + (e && e.message || e));
      }
    },

    /* ---------- 下载 ---------- */

    _downloadOne: async function (client, cfg, ds, ctx) {
      var rel = ctx.rel;
      var remotePath = WebDAV.join(cfg.root, ds.remoteDir, rel);
      var remote = ctx.remote || {};
      var size = Number(remote.size) || 0;
      var maxBytes = cfg.maxFileMB * 1024 * 1024;
      if (size > maxBytes) throw err(CODES.TOO_LARGE, "云端文件 " + WebDAV.formatBytes(size) + " 超过上限，已跳过");

      var bytes;
      if (remote.parts) {
        bytes = await this._downloadParts(client, cfg, remotePath, remote);
      } else {
        var res = await this._withRetry(function () {
          return client.getBuffer(remotePath, { abortToken: CS._abortToken });
        }, "下载 " + rel);
        bytes = new Uint8Array(res.body || new ArrayBuffer(0));
      }

      if (size && bytes.byteLength !== size) {
        throw err(CODES.IO, "下载大小不符（" + bytes.byteLength + " ≠ " + size + "），已丢弃");
      }

      var hash = await WebDAV.sha256Hex(bytes);
      if (remote.sha256 && hash && remote.sha256 !== hash) {
        throw err(CODES.IO, "内容校验失败（SHA-256 不符），已丢弃");
      }

      if (ds.kind === "pref") {
        var text = decodeText(bytes);
        var snap = null;
        try { snap = JSON.parse(text); } catch (e) { throw err(CODES.IO, "云端设置快照不是合法 JSON"); }
        // 只在"本机已有设置、要用云端版本覆盖"时留档，正常首次下载不产生垃圾备份
        if (ctx.local) await this._backupLocalBytes(ds, rel, bytes);
        var applied = this.applySnapshot(snap);
        this._log("info", "已应用云端设置项 " + applied + " 条");
        return { entry: this._makeEntry({ size: bytes.byteLength, mtime: Date.now(), hash: hash }, { etag: remote.etag, etagRaw: remote.etagRaw, size: bytes.byteLength }, hash) };
      }

      var target = this._localPathFor(ds, rel);
      if (!target) throw err(CODES.IO, "无法确定本地落点：" + rel);
      await this._ensureLocalDir(this._localParent(target));
      await this._backupLocalFile(target, ds.key);

      var partPath = target + ".part";
      try {
        // 大于 8MB 且已有半成品 → 尝试 Range 续传
        if (bytes.byteLength > 8 * 1024 * 1024 && await this._exists(partPath)) {
          var have = 0;
          try { have = Number((await IOUtils.stat(partPath)).size) || 0; } catch (e) { have = 0; }
          if (have > 0 && have < bytes.byteLength) {
            var res2 = await client.getBuffer(remotePath, { rangeStart: have, abortToken: this._abortToken });
            if (res2.status === 206) {
              var tail = new Uint8Array(res2.body || new ArrayBuffer(0));
              var head = await IOUtils.read(partPath);
              var merged = new Uint8Array(head.byteLength + tail.byteLength);
              merged.set(head, 0);
              merged.set(tail, head.byteLength);
              bytes = merged;
            }
          }
        }
        await IOUtils.write(partPath, bytes);
        if (await this._exists(target)) await IOUtils.remove(target);
        await IOUtils.move(partPath, target);
      } catch (e) {
        if (e && e.code) throw e;
        throw err(CODES.IO, "写入本地文件失败：" + (e && e.message || e));
      }

      return {
        entry: this._makeEntry(
          { size: bytes.byteLength, mtime: Date.now(), hash: hash },
          { etag: remote.etag, etagRaw: remote.etagRaw, size: bytes.byteLength },
          hash
        ),
      };
    },

    _downloadParts: async function (client, cfg, remotePath, remote) {
      // 组装是在内存里做的，必须**独立于单文件上限**再设一道更低的闸：
      // 512MB 的连续分配足以让 Zotero 卡死。超限时明确让用户去网页下载。
      var maxBytes = Math.min(cfg.maxFileMB, cfg.assembleMaxMB) * 1024 * 1024;
      var manifest = remote.manifest;
      if (!manifest) {
        var mres = await this._withRetry(function () {
          return client.getBuffer(WebDAV.manifestPathFor(remotePath), { abortToken: CS._abortToken });
        }, "下载分卷清单 " + WebDAV.basename(remotePath));
        try { manifest = JSON.parse(decodeText(new Uint8Array(mres.body))); } catch (e) {
          throw err(CODES.IO, "分卷清单解析失败");
        }
      }
      var v = WebDAV.validateManifest(manifest);
      if (!v.ok) throw err(CODES.IO, "分卷清单无效：" + v.error);
      if (v.total > maxBytes) {
        throw err(CODES.TOO_LARGE, "分卷总大小 " + WebDAV.formatBytes(v.total) +
          " 超过本机组装上限 " + WebDAV.formatBytes(maxBytes) +
          "；请在坚果云网页下载该文件，或在「云同步 → 高级」调大组装上限");
      }

      var hash8 = String(manifest.sha256 || "").slice(0, 8) || "nohash";
      var dir = WebDAV.partsDirFor(remotePath, hash8);
      var out = new Uint8Array(v.total);
      var offset = 0;
      for (var i = 0; i < manifest.parts.length; i++) {
        this._checkAbort();
        var p = manifest.parts[i];
        var buf = await this._withRetry(function () {
          return client.getBuffer(WebDAV.join(dir, p.name), { abortToken: CS._abortToken });
        }, "下载分片 " + p.name);
        var chunk = new Uint8Array(buf.body || new ArrayBuffer(0));
        if (chunk.byteLength !== Number(p.size)) {
          throw err(CODES.IO, "分片 " + p.name + " 大小不符（" + chunk.byteLength + " ≠ " + p.size + "）");
        }
        out.set(chunk, offset);
        offset += chunk.byteLength;
        this._progress({ file: WebDAV.basename(remotePath), current: i + 1, total: manifest.parts.length, bytesDone: offset, bytesTotal: v.total, action: "download" });
      }
      // 清单里有 sha256：组装完必须校验，避免"大小对但内容坏"的静默损坏
      if (manifest.sha256) {
        var got = await WebDAV.sha256Hex(out);
        if (got && got !== manifest.sha256) {
          throw err(CODES.IO, "分卷内容校验失败（SHA-256 不符），已丢弃");
        }
      }
      return out;
    },

    /* ---------- 冲突 ---------- */

    /** 冲突副本名：`foo.json` → `foo (冲突 本机 20261019-103000).json` */
    conflictName: function (name, date) {
      var n = String(name == null ? "" : name);
      var s = stamp(date);
      var ext = WebDAV.extname(n);
      var base = ext ? n.slice(0, n.length - ext.length) : n;
      return base + " (冲突 本机 " + s + ")" + ext;
    },

    _resolveConflict: async function (client, cfg, ds, ctx) {
      var rel = ctx.rel;
      var policy = cfg.policy;

      // 设置快照不合并：本机为准 + 云端留档（逐键合并的语义边界太多，宁可人工看）
      if (ds.kind === "pref") {
        this._log("warn", "设置项冲突：以本机为准上传，云端旧版已留档");
        if (ctx.remote) await this._backupRemote(client, cfg, ds, rel);
        var up = await this._uploadOne(client, cfg, ds, { rel: rel, local: ctx.local, remote: ctx.remote, entry: null });
        return { entry: up.entry, uploaded: true, downloaded: false };
      }

      if (policy === "local") {
        this._log("warn", "冲突（" + rel + "）：按策略以本机覆盖云端");
        var up2 = await this._uploadOne(client, cfg, ds, { rel: rel, local: ctx.local, remote: ctx.remote, entry: null });
        return { entry: up2.entry, uploaded: true, downloaded: false };
      }

      if (policy === "remote") {
        this._log("warn", "冲突（" + rel + "）：按策略以云端覆盖本机（本地已备份）");
        var down = await this._downloadOne(client, cfg, ds, { rel: rel, local: ctx.local, remote: ctx.remote, entry: null });
        return { entry: down.entry, uploaded: false, downloaded: true };
      }

      // keepBoth：本机版本改名上传，再拉云端版本覆盖原名 —— 两份都保住
      var newRel = this.conflictRel(rel);
      this._log("warn", "冲突（" + rel + "）：本机版本另存为 " + newRel + "，随后拉取云端版本");
      var moved = await this._copyLocalAside(ds, rel, newRel);
      if (moved) {
        await this._uploadOne(client, cfg, ds, {
          rel: newRel,
          local: { localPath: moved, size: ctx.local.size, mtime: ctx.local.mtime },
          remote: null,
          entry: null,
        });
      }
      var down2 = await this._downloadOne(client, cfg, ds, { rel: rel, local: ctx.local, remote: ctx.remote, entry: null });
      return { entry: down2.entry, uploaded: !!moved, downloaded: true };
    },

    conflictRel: function (rel) {
      var dir = WebDAV.dirname(rel);
      var name = WebDAV.basename(rel);
      var renamed = this.conflictName(name);
      // rel 是"相对数据集的路径"，不带前导斜杠（WebDAV.join 会补），保持一致
      if (dir === "/" || dir === "") return renamed;
      return WebDAV.join(dir, renamed).replace(/^\//, "");
    },

    /* ---------- 本地扫描 ---------- */

    /**
     * 构建待上传的设置快照，并做**体积上限**检查。
     * 超过上限不静默截断（截断等于丢设置），而是明确报错并指出最大的几个键，
     * 让用户自己决定调大上限还是清理。
     */
    _buildSnapshot: async function () {
      var cfg = this.config();
      var snap = this.snapshotPrefs();
      var text = JSON.stringify(snap, null, 2);
      var bytes = encodeText(text);
      var cap = cfg.snapshotMaxKB * 1024;
      if (bytes.byteLength > cap) {
        var biggest = Object.keys(snap.prefs).map(function (k) {
          var v = snap.prefs[k];
          return [k, typeof v === "string" ? v.length : 8];
        }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5).map(function (x) {
          return x[0] + "(" + WebDAV.formatBytes(x[1]) + ")";
        });
        throw err(CODES.TOO_LARGE, "设置快照 " + WebDAV.formatBytes(bytes.byteLength) +
          " 超过上限 " + cfg.snapshotMaxKB + "KB；最大项：" + biggest.join("、") +
          "。可在「云同步 → 快照上限」调大，或清理这些设置");
      }
      return { snap: snap, text: text, bytes: bytes, hash: await WebDAV.sha256Hex(bytes) };
    },

    _scanLocal: async function (ds, budget) {
      var out = {};
      if (ds.kind === "pref") {
        var built = await this._buildSnapshot();
        out[ds.fileName] = {
          rel: ds.fileName, size: built.bytes.byteLength, mtime: 0, data: built.bytes, hash: built.hash,
        };
        return out;
      }

      if (ds.kind === "file") {
        var p = this._localPathFor(ds, ds.localName);
        if (!p) return out;
        try {
          var st = await IOUtils.stat(p);
          if (!st || st.type === "directory") return out;
          out[ds.localName] = { rel: ds.localName, size: Number(st.size) || 0, mtime: Number(st.lastModified) || 0, localPath: p };
        } catch (e) { /* 不存在 = 空 */ }
        return out;
      }

      if (ds.kind === "dir") {
        var root = this._localPathFor(ds, "");
        if (!root || !(await this._exists(root))) return out;
        await this._walkLocal(root, "", out, 0, budget);
        return out;
      }
      return out;
    },

    _walkLocal: async function (root, prefix, out, depth, budget) {
      var maxDepth = budget ? budget.maxDepth : 6;
      if (depth > maxDepth) {
        if (budget) budget.deep++;
        return;
      }
      var names = [];
      try { names = await IOUtils.getChildren(root); } catch (e) { return; }
      for (var i = 0; i < names.length; i++) {
        var full = names[i];
        var name = WebDAV.basename(full);
        if (!name || name === ".ppparts" || name === "index.json" || name === "conflicts") continue;
        if (/\.part$/i.test(name) || WebDAV.isManifestName(name) || name.charAt(0) === ".") continue;
        var rel = prefix ? prefix + "/" + name : name;
        var st = null;
        try { st = await IOUtils.stat(full); } catch (e) { continue; }
        if (!st) continue;
        if (st.type === "directory") {
          await this._walkLocal(full, rel, out, depth + 1, budget);
        } else {
          if (budget) {
            if (budget.count >= budget.maxFiles) { budget.truncated++; break; }
            budget.count++;
          }
          out[rel] = { rel: rel, size: Number(st.size) || 0, mtime: Number(st.lastModified) || 0, localPath: full };
        }
      }
    },

    /** 文件/目录型数据集在磁盘上的位置；pref 型返回 null */
    _localPathFor: function (ds, rel) {
      var base;
      if (ds.kind === "dir") base = this._localCloudDir();
      else base = this._dataDir();
      if (!base) return null;
      if (ds.kind === "dir") return this._localJoin(base, ds.localDir || "packages", rel || "");
      return this._localJoin(base, rel || ds.localName || "");
    },

    /**
     * 本地路径拼接：**不能复用 WebDAV.join**。后者按 POSIX 语义返回 `/C:/Users/...`，
     * 在 Windows 上 IOUtils 会把它当成"当前盘根下的 C: 目录"，索引/备份/安装包目录
     * 全部静默创建失败（真机 0.59.0 首次装机踩到：云端有数据，本地没有 index）。
     */
    _localJoin: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (v === undefined || v === null || v === "") continue;
        parts.push(String(v));
      }
      if (!parts.length) return "";
      // 优先用 Zotero 的 PathUtils：Windows 上会给出反斜杠路径，IOUtils 最稳；
      // 测试/无 PathUtils 环境回落字符串拼接（POSIX 语义）。
      try {
        if (typeof PathUtils !== "undefined" && PathUtils && typeof PathUtils.join === "function") {
          return PathUtils.join.apply(PathUtils, parts);
        }
      } catch (e) { /* 回落 */ }
      var out = parts[0].split("\\").join("/").replace(/\/+$/, "");
      for (var j = 1; j < parts.length; j++) {
        var seg = parts[j].split("\\").join("/").replace(/^\/+|\/+$/g, "");
        if (!seg) continue;
        out += "/" + seg;
      }
      return out;
    },

    _localParent: function (p) {
      try {
        if (typeof PathUtils !== "undefined" && PathUtils && typeof PathUtils.parent === "function") {
          return PathUtils.parent(String(p == null ? "" : p));
        }
      } catch (e) { /* 回落 */ }
      var s = String(p == null ? "" : p).split("\\").join("/").replace(/\/+$/, "");
      var i = s.lastIndexOf("/");
      if (i < 0) return "";
      var head = s.slice(0, i);
      if (/^[A-Za-z]:$/.test(head)) return head + "/";
      return head || "/";
    },

    _dataDir: function () {
      try {
        var d = Zotero.DataDirectory && Zotero.DataDirectory.dir;
        if (d) {
          if (typeof d === "string") return d;
          if (d.path) return String(d.path);   // nsIFile
          return String(d);
        }
      } catch (e) { /* 回落 ProfD */ }
      try {
        var prof = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
        if (prof && prof.path) return String(prof.path);
      } catch (e) { /* ignore */ }
      return null;
    },

    _localCloudDir: function () {
      var d = this._dataDir();
      if (!d) throw err(CODES.IO, "无法定位 Zotero 数据目录");
      return this._localJoin(d, "papilot-cloud");
    },

    async _exists(p) {
      try { return await IOUtils.exists(p); } catch (e) { return false; }
    },

    async _ensureLocalDir(p) {
      var path = this._localJoin(p);
      if (!path) return;
      if (await this._exists(path)) return;
      var parent = this._localParent(path);
      if (parent && parent !== path) await this._ensureLocalDir(parent);
      try {
        await IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true });
      } catch (e) {
        if (!(await this._exists(path))) throw err(CODES.IO, "创建本地目录失败：" + path + "（" + (e && e.message || e) + "）");
      }
    },

    /* ---------- 远程扫描 ---------- */

    _scanRemote: async function (client, dir, ds, budget) {
      var out = {};
      var manifests = {};
      await this._walkRemote(client, dir, "", out, manifests, 0, budget);

      // 有清单没有正式文件 → 视为"分卷文件"，取清单补全逻辑条目
      var keys = Object.keys(manifests);
      for (var i = 0; i < keys.length; i++) {
        var logical = keys[i];
        if (out[logical]) continue;                 // 正式文件优先（清单可能是旧的）
        this._checkAbort();
        var mPath = manifests[logical];
        try {
          var res = await client.getBuffer(mPath, { abortToken: this._abortToken });
          var manifest = JSON.parse(decodeText(new Uint8Array(res.body || new ArrayBuffer(0))));
          var v = WebDAV.validateManifest(manifest);
          if (!v.ok) {
            this._log("warn", "分卷清单无效，已忽略：" + mPath + "（" + v.error + "）");
            continue;
          }
          out[logical] = {
            rel: logical, size: v.total, mtime: 0,
            etag: "", manifestPath: mPath, parts: true, manifest: manifest,
          };
        } catch (e) {
          this._log("warn", "读取分卷清单失败：" + mPath + "（" + (e && e.message || e) + "）");
        }
      }
      return out;
    },

    _walkRemote: async function (client, dir, prefix, out, manifests, depth, budget) {
      var maxDepth = budget ? budget.maxDepth : 6;
      if (depth > maxDepth) {
        if (budget) budget.deep++;
        return;
      }
      var items = [];
      try { items = await client.propfind(dir, 1); } catch (e) {
        if (e.code === CODES.NOT_FOUND) return;
        throw e;
      }
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || it.path === WebDAV.normalizePath(dir)) continue;   // PROPFIND 会带回自身
        var name = it.name;
        if (!name) continue;
        var rel = prefix ? prefix + "/" + name : name;
        if (it.isDir) {
          if (name === ".ppparts" || name === "conflicts") continue;
          await this._walkRemote(client, WebDAV.join(dir, name), rel, out, manifests, depth + 1, budget);
        } else {
          if (budget) {
            if (budget.count >= budget.maxFiles) { budget.truncated++; break; }
            budget.count++;
          }
          if (WebDAV.isManifestName(name)) {
            manifests[rel.replace(/\.ppmanifest\.json$/i, "")] = WebDAV.join(dir, name);
            continue;
          }
          if (/\.part$/i.test(name)) continue;
          out[rel] = {
            rel: rel, size: Number(it.size) || 0, mtime: Number(it.mtime) || 0,
            etag: it.etag || "", etagRaw: it.etagRaw || "",
          };
        }
      }
    },

    /* ---------- 设置快照 ---------- */

    /** 是否允许进入云端的 pref（密钥类绝不允许） */
    shouldSyncPref: function (leaf) {
      if (!leaf) return false;
      if (leaf.indexOf("cloudSync") === 0) return false;      // 同步配置本身
      if (leaf === "prefsFoldOpen") return false;             // 纯本机 UI 状态
      // 检索订阅的两个本机运行态：同步过去只会制造「幽灵行为」，两边都不该带走。
      //  · searchSubsRecoCache：推荐缓存是「本机图书馆画像」的产物。A 机的推荐灌到 B 机会
      //    推荐 B 机根本没有的主题；且 at 每 12 小时变一次，快照内容随之变化会让同步判定
      //    「本地已修改」，与云端口径来回打架（乒乓）。
      //  · searchSubsSeen：本机投递记账。B 机若拿到 A 机的 seen，会把 A 机见过的论文当成
      //    「往期已见」而静默不推送（用户以为订阅漏了）；丢掉也不要紧——库内 DOI 查重
      //    仍能拦住重复入库。
      // ★ 口径：searchSubsFeedback（收藏 / 忽略）是**用户显式偏好**——跟人走，正常同步；
      //   seen / recoCache 是**本机运行态**——跟机器走，同步只会互相污染。
      if (leaf === "searchSubsRecoCache") return false;
      if (leaf === "searchSubsSeen") return false;
      // 缓存 / 大型数据集 / 机器绝对路径 / 设备标记：默认一律不出本机
      if (NON_SETTING_LEAVES.indexOf(leaf) >= 0) return false;
      if (SECRET_LEAVES.indexOf(leaf) >= 0) return false;
      if (SECRET_LEAF_RE.test(leaf)) return false;
      return true;
    },

    /**
     * 导出设置快照（白名单 + 类型保真）。
     * ⚠️ 快照必须**内容稳定**：不能带 exportedAt / device 这类每次都变的字段，
     * 否则每轮同步都会判定"本地已修改"，进而每轮都上传、下一轮又把改动当成
     * "云端已修改"下载回来，形成乒乓。时间信息看云端 Last-Modified 即可。
     */
    snapshotPrefs: function () {
      var snap = { version: 1, prefs: {} };
      var S = null;
      try { S = Services.prefs; } catch (e) { return snap; }
      var list = [];
      try { list = S.getChildList(Prefs.PREFIX) || []; } catch (e) { return snap; }
      for (var i = 0; i < list.length; i++) {
        var full = String(list[i]);
        var leaf = full.slice(Prefs.PREFIX.length);
        if (!this.shouldSyncPref(leaf)) continue;
        try {
          var t = S.getPrefType(full);
          if (t === S.PREF_STRING) snap.prefs[leaf] = S.getStringPref(full);
          else if (t === S.PREF_BOOL) snap.prefs[leaf] = S.getBoolPref(full);
          else if (t === S.PREF_INT) snap.prefs[leaf] = S.getIntPref(full);
        } catch (e) { /* 单键失败跳过 */ }
      }
      return snap;
    },

    /** 应用云端快照：只写允许的键；返回实际写入条数 */
    applySnapshot: function (snap) {
      if (!snap || typeof snap !== "object" || !snap.prefs) return 0;
      var n = 0;
      var prefs = snap.prefs;
      for (var leaf in prefs) {
        if (!Object.prototype.hasOwnProperty.call(prefs, leaf)) continue;
        if (!this.shouldSyncPref(leaf)) continue;
        var v = prefs[leaf];
        try {
          if (typeof v === "boolean") Prefs.set(leaf, v);
          else if (typeof v === "number") Prefs.set(leaf, Math.round(v));
          else if (typeof v === "string") Prefs.set(leaf, v);
          else continue;
          n++;
        } catch (e) { /* 单键失败跳过 */ }
      }
      return n;
    },

    /* ---------- 索引 ---------- */

    /** FNV-1a 32 位：只用于文件名指纹，不用于安全用途；同步、跨平台稳定 */
    _fingerprint: function (s) {
      var h = 2166136261 >>> 0;
      var str = String(s == null ? "" : s);
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return ("00000000" + h.toString(16)).slice(-8);
    },

    /** 账号 + 服务地址 + 同步根：任一变化都必须用独立索引，否则旧 etag 全量失配 */
    _accountKey: function () {
      var cfg = this.config();
      return this._fingerprint([cfg.baseUrl, String(cfg.email || "").toLowerCase(), cfg.root].join("|"));
    },

    _indexPath: function () {
      return this._localJoin(this._localCloudDir(), "index-" + this._accountKey() + ".json");
    },

    /**
     * 老版本只有一份 index.json。升级后首次读取时按"当前账号"迁移一次；
     * 如果检测到账号/根目录已变（indexOwner 不同），则不迁移，避免把 A 账号的
     * etag 用在 B 账号上制造假冲突。
     */
    _migrateLegacyIndex: async function (newPath) {
      try {
        var legacy = this._localJoin(this._localCloudDir(), "index.json");
        if (!(await this._exists(legacy))) return;
        var owner = "";
        try { owner = String(Prefs.get(K.indexOwner, "") || ""); } catch (e) { owner = ""; }
        var key = this._accountKey();
        if (owner && owner !== key) return;
        await IOUtils.copy(legacy, newPath);
        this._log("info", "已把旧索引迁移到账号专属文件（" + key + "）");
      } catch (e) {
        this._log("warn", "迁移旧索引失败（将按新索引处理）：" + (e && e.message || e));
      }
    },

    _readIndex: async function () {
      var p = this._indexPath();
      var empty = { version: 1, updatedAt: 0, entries: {} };
      if (!(await this._exists(p))) {
        await this._migrateLegacyIndex(p);
        if (!(await this._exists(p))) return empty;
      }
      try {
        var text = await IOUtils.readUTF8(p);
        var v = JSON.parse(text);
        if (!v || typeof v !== "object" || !v.entries || typeof v.entries !== "object") return empty;
        v.version = 1;
        return v;
      } catch (e) {
        // 索引损坏 → 不阻塞同步，只是这一轮会退化成"无基线"（冲突可能变多）
        this._log("warn", "本地索引损坏，已忽略：" + (e && e.message || e));
        return empty;
      }
    },

    _writeIndex: async function (index) {
      try {
        var dir = this._localCloudDir();
        await this._ensureLocalDir(dir);
        index.updatedAt = Date.now();
        index.version = 1;
        index.account = this._accountKey();
        index.root = this.config().root;
        // 只保留最近 90 天没动过的条目，防索引无限膨胀
        var cutoff = Date.now() - 90 * 24 * 3600 * 1000;
        for (var k in index.entries) {
          if (!Object.prototype.hasOwnProperty.call(index.entries, k)) continue;
          var e = index.entries[k] || {};
          if (Number(e.syncedAt) > 0 && Number(e.syncedAt) < cutoff) delete index.entries[k];
        }
        await IOUtils.writeUTF8(this._indexPath(), JSON.stringify(index, null, 2));
        try { Prefs.set(K.indexOwner, index.account); } catch (e2) { /* 标记失败不影响索引 */ }
      } catch (e) {
        this._indexWriteError = String(e && e.message || e);
        this._log("warn", "写本地索引失败（不影响本轮结果）：" + this._indexWriteError);
      }
    },

    /* ---------- 设备心跳 ---------- */

    _writeDeviceState: async function (client, cfg, result) {
      try {
        var dir = WebDAV.join(cfg.root, "devices");
        await client.ensureDir(dir);
        var body = {
          id: cfg.deviceId,
          name: this.deviceName(),
          appVersion: (Zotero.Papilot && Zotero.Papilot.version) || "",
          platform: Zotero.isWin ? "win" : (Zotero.isMac ? "mac" : (Zotero.isLinux ? "linux" : "")),
          lastSyncAt: Date.now(),
          lastResult: {
            uploaded: result.uploaded, downloaded: result.downloaded,
            conflicts: result.conflicts, failed: result.failed,
          },
        };
        await client.put(WebDAV.join(dir, safeName(cfg.deviceId) + ".json"), encodeText(JSON.stringify(body, null, 2)), {
          contentType: "application/json",
          abortToken: this._abortToken,
        });
      } catch (e) {
        this._log("warn", "写设备心跳失败（不影响数据同步）：" + (e && e.message || e));
      }
    },

    /* ---------- 备份 ---------- */

    async _backupLocalFile(target, datasetKey) {
      try {
        if (!target || !(await this._exists(target))) return "";
        var st = null;
        try { st = await IOUtils.stat(target); } catch (e) { return ""; }
        if (!st || !(Number(st.size) > 0)) return "";
        var dir = this._localJoin(this._localCloudDir(), "conflicts", safeName(datasetKey));
        await this._ensureLocalDir(dir);
        var dst = WebDAV.join(dir, WebDAV.basename(target) + "." + stamp());
        await IOUtils.copy(target, dst);
        return dst;
      } catch (e) {
        this._log("warn", "备份本地文件失败：" + (e && e.message || e));
        return "";
      }
    },

    async _backupLocalBytes(ds, rel, bytes) {
      try {
        var dir = this._localJoin(this._localCloudDir(), "conflicts", safeName(ds.key));
        await this._ensureLocalDir(dir);
        var dst = WebDAV.join(dir, WebDAV.basename(rel).replace(/\.json$/i, "") + "." + stamp() + ".json");
        await IOUtils.write(dst, bytes);
        return dst;
      } catch (e) { return ""; }
    },

    async _backupRemote(client, cfg, ds, rel) {
      try {
        var remotePath = WebDAV.join(cfg.root, ds.remoteDir, rel);
        var res = await client.getBuffer(remotePath, { abortToken: this._abortToken });
        var dir = this._localJoin(this._localCloudDir(), "conflicts", safeName(ds.key));
        await this._ensureLocalDir(dir);
        var dst = WebDAV.join(dir, WebDAV.basename(rel).replace(/\.json$/i, "") + ".remote." + stamp() + ".json");
        await IOUtils.write(dst, new Uint8Array(res.body || new ArrayBuffer(0)));
        this._log("info", "云端版本已留档：" + dst);
      } catch (e) {
        this._log("warn", "留档云端版本失败：" + (e && e.message || e));
      }
    },

    /** keepBoth 用：把本地文件复制成冲突名，返回新路径 */
    async _copyLocalAside(ds, rel, newRel) {
      if (ds.kind === "pref") return "";
      var src = this._localPathFor(ds, rel);
      var dst = this._localPathFor(ds, newRel);
      if (!src || !dst || !(await this._exists(src))) return "";
      try {
        await this._ensureLocalDir(this._localParent(dst));
        await IOUtils.copy(src, dst);
        return dst;
      } catch (e) {
        this._log("warn", "创建冲突副本失败：" + (e && e.message || e));
        return "";
      }
    },

    /* ---------- 技能包 / 安装包 ---------- */

    /**
     * 把已安装技能包的 manifest 落到 `packages/skill-packs/`，随下一次同步上传。
     * 这样"装了哪些技能包"本身也进了云端，换机可恢复。
     */
    stageSkillPacks: async function () {
      if (typeof SkillPacks === "undefined" || !SkillPacks || typeof SkillPacks.exportPack !== "function") {
        throw err(CODES.CONFIG, "技能包模块未就绪");
      }
      var dir = this._localJoin(this._localCloudDir(), "packages", "skill-packs");
      await this._ensureLocalDir(dir);
      var list = [];
      try { list = SkillPacks.listInstalled() || []; } catch (e) { list = []; }
      var written = 0;
      for (var i = 0; i < list.length; i++) {
        var pack = list[i] || {};
        var text = "";
        try { text = SkillPacks.exportPack(pack.id); } catch (e) { text = ""; }
        if (!text) continue;
        var name = safeName(pack.id) + "-" + safeName(pack.version || "0") + ".json";
        try {
          await IOUtils.writeUTF8(WebDAV.join(dir, name), text);
          written++;
        } catch (e) {
          this._log("warn", "写技能包失败：" + name + "（" + (e && e.message || e) + "）");
        }
      }
      this._log("info", "已收集 " + written + " 个技能包到本地待同步目录");
      return { ok: true, written: written, dir: dir };
    },

    /** 用户把自己的安装包丢进同步区（kind: installers | skill-packs） */
    addLocalPackage: async function (srcPath, kind) {
      var k = kind === "skill-packs" ? "skill-packs" : "installers";
      var dir = this._localJoin(this._localCloudDir(), "packages", k);
      await this._ensureLocalDir(dir);
      var name = WebDAV.basename(srcPath);
      if (!name) throw err(CODES.CONFIG, "文件名为空");
      var dst = WebDAV.join(dir, name);
      var n = 1;
      while (await this._exists(dst)) {
        var ext = WebDAV.extname(name);
        var base = ext ? name.slice(0, name.length - ext.length) : name;
        dst = WebDAV.join(dir, base + "-" + n + ext);
        n++;
      }
      await IOUtils.copy(srcPath, dst);
      this._log("info", "已加入待同步安装包：" + WebDAV.basename(dst));
      return { ok: true, path: dst };
    },

    listLocalPackages: async function () {
      var out = [];
      try {
        var root = this._localJoin(this._localCloudDir(), "packages");
        if (!(await this._exists(root))) return out;
        var map = {};
        await this._walkLocal(root, "", map, 0);
        for (var k in map) {
          if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
          out.push({ rel: k, size: map[k].size, mtime: map[k].mtime, path: map[k].localPath });
        }
      } catch (e) { /* 返回空列表 */ }
      return out.sort(function (a, b) { return String(a.rel).localeCompare(String(b.rel)); });
    },

    openCloudDir: async function () {
      var dir = this._localCloudDir();
      await this._ensureLocalDir(dir);
      try {
        Zotero.launchFile(dir);
        return dir;
      } catch (e) {
        throw err(CODES.IO, "无法打开目录：" + (e && e.message || e));
      }
    },

    /* ---------- 自动同步 ---------- */

    startAutoSync: function () {
      this.stopAutoSync();
      var cfg = this.config();
      if (!cfg.autoMinutes || !this.isLoggedIn() || !cfg.enabled) return false;
      var self = this;
      var ms = Math.max(5, cfg.autoMinutes) * 60 * 1000;
      this._autoTimer = setInterval(function () {
        if (self._running) return;
        self.syncNow().catch(function (e) {
          self._log("warn", "自动同步失败：" + (e && e.message || e));
        });
      }, ms);
      this._log("info", "自动同步已开启：每 " + Math.max(5, cfg.autoMinutes) + " 分钟");
      return true;
    },

    stopAutoSync: function () {
      if (this._autoTimer) {
        clearInterval(this._autoTimer);
        this._autoTimer = null;
      }
    },

    destroy: function () {
      this.stopAutoSync();
      this._listeners = [];
    },
  };

  return CS;
})();
