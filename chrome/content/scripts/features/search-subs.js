// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 检索订阅 v2（0.57.0）
 *
 * 0.53.0 的第一版只有一条链路：关键词/分类 → 每日一次 → arXiv → 自动入库 → 速递笔记。
 * 真实使用暴露了四类问题（也是 v2 的设计输入）：
 *   ① 配置门槛高：用户得自己知道 arXiv 分类代码、AND/OR 语义、英文关键词；
 *   ② 只有 arXiv：医学/社科库大半在 PubMed / 期刊库，订阅等于不可用；
 *   ③ 没有预览：建完订阅只能等第二天，错了也不知道错在哪；
 *   ④ 管理太薄：不能暂停、不能编辑、看不到上次结果、也没有「基于我库里的领域」推荐。
 *
 * v2 因此分成四块能力（都保持「可离线、可降级、绝不抛给 UI」）：
 *   A. 订阅模型：来源 / 布尔模式 / 排除词 / 时间窗 / 频率（手动·每日·每周）/ 启停 / 运行历史
 *   B. 试跑预览：preview() 只取数打分，不写 pref、不入库、不记账——先看再建
 *   C. 智能推荐：suggest() 用库内画像（复用 Discovery.buildProfile）产出可解释的主题订阅，
 *      冷启动时退回「研究者画像」文本
 *   D. AI 辅助（全部可选、失败即降级）：一句话建订阅 aiParseQuery()、相关性复核 aiRerank()、
 *      速递速览 aiDigest()
 *
 * 数据面（三个 pref，均为 JSON 字符串）：
 *   searchSubscriptions      订阅数组，最新在前（v2 字段对 v1 向后兼容）
 *   searchSubsSeen           去重记账 map：fingerprint → { itemID?, at }，LRU 1000
 *   searchSubsRecoDismissed  被忽略的推荐主题 id 数组（LRU 100）
 *   searchSubsRecoCache      推荐结果缓存 { at, items }，12 小时有效（订阅增删改即失效）
 *
 * 去重三层：
 *   ① 记账（主）：fingerprint 命中即「往期已见」，跨订阅也拦得住；
 *   ② 库内查重（兜底）：仅 DOI，且 Zotero.Items.getByDOI 可用时调用一次；
 *   ③ 预览不记账：preview 只读 seen，绝不写——否则「试跑」会把正式订阅的内容吃掉。
 *   ④ 不入库不记账：autoImport=false 的订阅只推送、不入库，因此绝不写 seen。
 *      若写了，这些论文之后永远被当成「往期已见」，用户改成自动入库也再收不到（静默丢论文）；
 *      代价只是它们会重复出现在速递里，可以接受（库内 DOI 查重仍会拦已手动导入的）。
 *
 * 定时语义（与 scheduler.js 同款 60s 轮询 + 启动即查，独立 timer）：
 *   - daily：lastRun === 今天则跳过；到点后 6 小时窗口内补跑；
 *   - weekly：weekdays（ISO 1=周一 … 7=周日）包含今天才跑，其余同上；
 *   - manual：不自动跑，只能「立即运行」。
 *   先写 lastRun 再执行，配合 _running 守卫，轮询不会重复触发。
 *
 * 纪律：网络/解析/入库失败全部转成返回值（reason），绝不抛给 UI；依赖模块
 * （SubSources / ArxivFetch / Discovery / AIClient / MdLite）缺位时逐级降级。
 */
/* global Zotero, Prefs, ArxivFetch, ArxivCategories, SubSources, Discovery, AIClient, MdLite, I18n */

var SearchSubs = {
  PREF_LIST: "searchSubscriptions",
  PREF_SEEN: "searchSubsSeen",
  PREF_RECO_DISMISSED: "searchSubsRecoDismissed",
  PREF_RECO_CACHE: "searchSubsRecoCache",

  /** 推荐结果缓存有效期（12 小时）：库内画像扫描是纯本地计算，但会遍历全库，不必每次进设置都重算 */
  RECO_TTL_MS: 12 * 3600 * 1000,

  /** 轮询间隔（60s，与 Scheduler.CHECK_MS 同节奏） */
  CHECK_MS: 60000,
  /** 到点后的补跑窗口（6 小时） */
  WINDOW_MIN: 360,
  /** 去重记账上限（LRU） */
  MAX_SEEN: 1000,
  /** 单条订阅每次最多取多少条（与 add 的夹紧区间一致） */
  MAX_LIMIT: 30,
  MIN_LIMIT: 1,
  /** 运行历史保留条数 */
  RUNLOG_MAX: 5,
  /** AI 复核最多送多少条（控制 token） */
  AI_RERANK_MAX: 12,
  /** AI 速览最多送多少条 */
  AI_DIGEST_MAX: 15,
  /** 入库标签前缀 */
  TAG_PREFIX: "#订阅/",

  _timer: null,
  _running: {},
  _lastCheck: null,
  _startupCheck: null,
  /** 上一次 suggest() 是否直接复用了缓存（供设置面板区分「来自缓存」与「刚重新分析」） */
  _recoFromCache: false,

  /* ================== pref 读写（Prefs 缺位时回落 Zotero.Prefs） ================== */

  _prefGet(key, fallback) {
    try {
      if (typeof Prefs !== "undefined" && Prefs && typeof Prefs.get === "function") {
        const v = Prefs.get(key, fallback);
        if (v !== undefined && v !== null) return v;
      }
    } catch (e) { /* 走 Zotero.Prefs 回落 */ }
    try {
      const v = Zotero.Prefs.get("extensions.zotero.papilot." + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  },

  _prefSet(key, value) {
    try {
      if (typeof Prefs !== "undefined" && Prefs && typeof Prefs.set === "function") {
        Prefs.set(key, value);
        return true;
      }
    } catch (e) { /* 走 Zotero.Prefs 回落 */ }
    try {
      Zotero.Prefs.set("extensions.zotero.papilot." + key, value, true);
      return true;
    } catch (e) {
      this._log("pref write failed: " + key, e);
      return false;
    }
  },

  /* ================== 日志（静默，永不抛） ================== */

  _log(msg, err) {
    let text = "search-subs: " + msg;
    if (err) text += " :: " + ((err && (err.stack || err.message)) || err);
    try {
      if (Zotero && Zotero.Papilot && typeof Zotero.Papilot._diag === "function") {
        const r = Zotero.Papilot._diag(text);
        if (r && typeof r.catch === "function") r.catch(function () { /* ignore */ });
      } else if (Zotero && typeof Zotero.logError === "function") {
        Zotero.logError(new Error("Papilot " + text));
      }
    } catch (e) { /* ignore */ }
    try { if (Zotero && typeof Zotero.debug === "function") Zotero.debug("Papilot " + text); }
    catch (e) { /* ignore */ }
  },

  /* ================== 时间工具（与 scheduler 同语义） ================== */

  /** "HH:MM" / "H:MM" / "HHMM" → {h,m,minutes}；空、非法、越界 → null */
  _parseTime(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2}):(\d{2})$/);
    let h;
    let min;
    if (m) {
      h = Number(m[1]);
      min = Number(m[2]);
    } else {
      m = s.match(/^(\d{1,2})(\d{2})$/);
      if (!m) return null;
      h = Number(m[1]);
      min = Number(m[2]);
    }
    if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
    return { h: h, m: min, minutes: h * 60 + min };
  },

  _hhmm(hm) {
    const p = function (n) { return String(n).padStart(2, "0"); };
    return p(hm.h) + ":" + p(hm.m);
  },

  _dateOf(now) {
    if (now instanceof Date && !isNaN(now.getTime())) return now;
    if (typeof now === "number") {
      const d = new Date(now);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  },

  /** 本地日期键（不用 toISOString：晚上 23:30 的 UTC 日期会跑到前一天） */
  _dayKey(d) {
    const dt = this._dateOf(d);
    const p = function (n) { return String(n).padStart(2, "0"); };
    return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
  },

  _stamp(d) {
    const dt = this._dateOf(d);
    const p = function (n) { return String(n).padStart(2, "0"); };
    return this._dayKey(dt) + " " + p(dt.getHours()) + ":" + p(dt.getMinutes());
  },

  /* ================== 订阅读写 ================== */

  _clampMax(v) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return 10;
    return Math.max(this.MIN_LIMIT, Math.min(this.MAX_LIMIT, n));
  },

  _clampAge(v) {
    const n = parseInt(v, 10);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(3650, n));
  },

  _normSources(raw) {
    try {
      if (typeof SubSources !== "undefined" && SubSources && SubSources.normalizeSources) {
        return SubSources.normalizeSources(raw);
      }
    } catch (e) { /* 回落 */ }
    const list = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[,;\s]+/);
    const out = [];
    for (const x of list) {
      const id = String(x == null ? "" : x).trim().toLowerCase();
      if ((id === "arxiv" || id === "openalex" || id === "crossref" || id === "pubmed" || id === "europepmc") && out.indexOf(id) < 0) out.push(id);
    }
    return out.length ? out : ["arxiv"];
  },

  _normWeekdays(raw) {
    const list = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[,;\s]+/);
    const out = [];
    for (const x of list) {
      const n = parseInt(x, 10);
      if (isFinite(n) && n >= 1 && n <= 7 && out.indexOf(n) < 0) out.push(n);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  },

  _normRunLog(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      out.push({
        at: String(r.at == null ? "" : r.at),
        added: Math.max(0, parseInt(r.added, 10) || 0),
        skipped: Math.max(0, parseInt(r.skipped, 10) || 0),
        failed: Math.max(0, parseInt(r.failed, 10) || 0),
        trigger: String(r.trigger == null ? "" : r.trigger),
        reason: String(r.reason == null ? "" : r.reason),
      });
      if (out.length >= this.RUNLOG_MAX) break;
    }
    return out;
  },

  /** 单条订阅归一：脏 pref / 手工改坏 / v1 旧字段都能安全使用 */
  _normSub(raw) {
    const r = raw || {};
    const hm = this._parseTime(r.dailyTime);
    let freq = String(r.freq == null ? "" : r.freq).toLowerCase();
    if (freq !== "daily" && freq !== "weekly" && freq !== "manual") freq = hm ? "daily" : "manual";
    // weekly 必须有合法时间，否则降级为手动（不悄悄改用户意图）
    if (freq === "weekly" && !hm) freq = "manual";
    let mode = String(r.mode == null ? "" : r.mode).toLowerCase();
    if (mode !== "all" && mode !== "any" && mode !== "phrase") mode = "all";
    const weekdays = this._normWeekdays(r.weekdays);
    return {
      id: String(r.id || ""),
      name: String(r.name == null ? "" : r.name).trim(),
      enabled: r.enabled === undefined ? true : !!r.enabled,
      sources: this._normSources(r.sources),
      keywords: String(r.keywords == null ? "" : r.keywords).trim(),
      categories: String(r.categories == null ? "" : r.categories).trim(),
      mode: mode,
      exclude: String(r.exclude == null ? "" : r.exclude).trim(),
      maxAgeDays: this._clampAge(r.maxAgeDays),
      dailyTime: hm ? this._hhmm(hm) : "",
      freq: freq,
      weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5],
      max: this._clampMax(r.max),
      autoImport: r.autoImport === undefined ? true : !!r.autoImport,
      aiRerank: !!r.aiRerank,
      aiDigest: !!r.aiDigest,
      seedProfile: !!r.seedProfile,
      lastRun: String(r.lastRun == null ? "" : r.lastRun).trim(),
      lastStatus: String(r.lastStatus == null ? "" : r.lastStatus).trim(),
      runLog: this._normRunLog(r.runLog),
      createdAt: Number(r.createdAt) || 0,
      updatedAt: Number(r.updatedAt) || 0,
    };
  },

  /** 读订阅数组；坏 JSON / 非数组一律视为空（不抛） */
  _loadList() {
    let raw = "";
    try { raw = String(this._prefGet(this.PREF_LIST, "") || ""); } catch (e) { raw = ""; }
    if (!raw) return [];
    let arr = null;
    try { arr = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const sub = this._normSub(item);
      if (sub.id) out.push(sub);
    }
    return out;
  },

  _saveList(list) {
    return this._prefSet(this.PREF_LIST, JSON.stringify(Array.isArray(list) ? list : []));
  },

  _find(id) {
    for (const sub of this._loadList()) if (sub.id === id) return sub;
    return null;
  },

  _newId(list) {
    const used = {};
    for (const sub of list || []) used[sub.id] = true;
    let ts = Date.now();
    let id = "sub-" + ts.toString(36);
    while (used[id]) { ts++; id = "sub-" + ts.toString(36); }
    return id;
  },

  /** 订阅列表（最新在前；返回副本，调用方改动不污染 pref） */
  list() {
    return this._loadList();
  },

  /** 把任意输入补齐成一条完整订阅（不落盘），供 add / preview 共用 */
  _coerce(input, id) {
    const o = input || {};
    const hm = this._parseTime(o.dailyTime);
    const sources = this._normSources(o.sources);
    const mode = String(o.mode || "all").toLowerCase();
    const base = {
      id: id || "",
      name: String(o.name == null ? "" : o.name).trim(),
      enabled: o.enabled === undefined ? true : !!o.enabled,
      sources: sources,
      keywords: String(o.keywords == null ? "" : o.keywords).trim(),
      categories: String(o.categories == null ? "" : o.categories).trim(),
      mode: mode === "any" || mode === "phrase" ? mode : "all",
      exclude: String(o.exclude == null ? "" : o.exclude).trim(),
      maxAgeDays: this._clampAge(o.maxAgeDays),
      dailyTime: hm ? this._hhmm(hm) : "",
      freq: "manual",
      weekdays: this._normWeekdays(o.weekdays),
      max: this._clampMax(o.max),
      autoImport: o.autoImport === undefined ? true : !!o.autoImport,
      aiRerank: !!o.aiRerank,
      aiDigest: !!o.aiDigest,
      seedProfile: !!o.seedProfile,
      lastRun: String(o.lastRun == null ? "" : o.lastRun).trim(),
      lastStatus: String(o.lastStatus == null ? "" : o.lastStatus).trim(),
      runLog: this._normRunLog(o.runLog),
      createdAt: Number(o.createdAt) || Date.now(),
      updatedAt: Number(o.updatedAt) || 0,
    };
    let freq = String(o.freq == null ? "" : o.freq).toLowerCase();
    if (freq !== "daily" && freq !== "weekly" && freq !== "manual") freq = hm ? "daily" : "manual";
    if (freq === "weekly" && !hm) freq = "manual";
    base.freq = freq;
    if (!base.weekdays.length) base.weekdays = [1, 2, 3, 4, 5];
    return base;
  },

  /**
   * 新建订阅。
   * @param {{name:string, keywords?:string, categories?:string, sources?:string[],
   *          mode?:string, exclude?:string, maxAgeDays?:number, dailyTime?:string,
   *          freq?:string, weekdays?:number[], max?:number, autoImport?:boolean,
   *          aiRerank?:boolean, aiDigest?:boolean, seedProfile?:boolean}} input
   * @returns {object|null} 成功返回订阅对象；name 空 / 关键词与分类全空 / 写 pref 失败 → null
   */
  add(input) {
    const o = input || {};
    const name = String(o.name == null ? "" : o.name).trim();
    const keywords = String(o.keywords == null ? "" : o.keywords).trim();
    const categories = String(o.categories == null ? "" : o.categories).trim();
    if (!name) return null;
    if (!keywords && !categories) return null;
    const list = this._loadList();
    const sub = this._coerce(o, this._newId(list));
    sub.createdAt = Date.now();
    sub.updatedAt = 0;
    list.unshift(sub);
    if (!this._saveList(list)) return null;
    // 订阅集合变了 → 推荐里「与现有订阅去重」的结论失效
    this._clearRecoCache();
    return sub;
  },

  /**
   * 局部修改订阅。
   * @returns {object|null} 成功返回修改后的订阅；id 不存在 / 校验失败 / 写 pref 失败 → null
   */
  update(id, patch) {
    const list = this._loadList();
    let idx = -1;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) { idx = i; break; }
    if (idx < 0) return null;
    const p = patch || {};
    const next = Object.assign({}, list[idx]);

    if ("name" in p) {
      const v = String(p.name == null ? "" : p.name).trim();
      if (!v) return null;
      next.name = v;
    }
    if ("keywords" in p) next.keywords = String(p.keywords == null ? "" : p.keywords).trim();
    if ("categories" in p) next.categories = String(p.categories == null ? "" : p.categories).trim();
    if (!next.keywords && !next.categories) return null;
    if ("sources" in p) next.sources = this._normSources(p.sources);
    if ("mode" in p) {
      const m = String(p.mode || "all").toLowerCase();
      next.mode = m === "any" || m === "phrase" ? m : "all";
    }
    if ("exclude" in p) next.exclude = String(p.exclude == null ? "" : p.exclude).trim();
    if ("maxAgeDays" in p) next.maxAgeDays = this._clampAge(p.maxAgeDays);
    if ("max" in p) next.max = this._clampMax(p.max);
    if ("autoImport" in p) next.autoImport = !!p.autoImport;
    if ("aiRerank" in p) next.aiRerank = !!p.aiRerank;
    if ("aiDigest" in p) next.aiDigest = !!p.aiDigest;
    if ("seedProfile" in p) next.seedProfile = !!p.seedProfile;
    if ("enabled" in p) next.enabled = !!p.enabled;
    if ("weekdays" in p) next.weekdays = this._normWeekdays(p.weekdays).length
      ? this._normWeekdays(p.weekdays) : [1, 2, 3, 4, 5];
    if ("freq" in p) {
      const f = String(p.freq || "").toLowerCase();
      next.freq = f === "daily" || f === "weekly" || f === "manual" ? f : "manual";
    }
    if ("dailyTime" in p) {
      const hm = this._parseTime(p.dailyTime);
      next.dailyTime = hm ? this._hhmm(hm) : "";
      if (next.freq !== "manual" && !hm) next.freq = "manual";
    }
    if (next.freq === "weekly" && !this._parseTime(next.dailyTime)) next.freq = "manual";
    if ("lastRun" in p) next.lastRun = String(p.lastRun == null ? "" : p.lastRun).trim();
    if ("lastStatus" in p) next.lastStatus = String(p.lastStatus == null ? "" : p.lastStatus).trim();
    if ("runLog" in p) next.runLog = this._normRunLog(p.runLog);

    next.updatedAt = Date.now();
    list[idx] = next;
    if (!this._saveList(list)) return null;
    // 条件改动可能让某条推荐变成「已覆盖」或反过来 → 缓存作废
    this._clearRecoCache();
    return next;
  },

  /** @returns {boolean} 是否真的删掉了一条 */
  remove(id) {
    const list = this._loadList();
    const next = list.filter(function (s) { return s.id !== id; });
    if (next.length === list.length) return false;
    if (!this._saveList(next)) return false;
    this._clearRecoCache();
    return true;
  },

  _writeLastRun(id, day) {
    const list = this._loadList();
    for (const sub of list) if (sub.id === id) { sub.lastRun = String(day || ""); break; }
    this._saveList(list);
  },

  /** 追加一条运行历史（最新在前，最多 RUNLOG_MAX 条） */
  _pushRunLog(id, rec) {
    const list = this._loadList();
    for (const sub of list) {
      if (sub.id !== id) continue;
      const item = {
        at: String(rec.at || this._stamp(Date.now())),
        added: Math.max(0, parseInt(rec.added, 10) || 0),
        skipped: Math.max(0, parseInt(rec.skipped, 10) || 0),
        failed: Math.max(0, parseInt(rec.failed, 10) || 0),
        trigger: String(rec.trigger || "manual"),
        reason: String(rec.reason || ""),
      };
      sub.runLog = [item].concat(sub.runLog || []).slice(0, this.RUNLOG_MAX);
      sub.lastStatus = item.at + " · +" + item.added + " 新入库 / " + item.skipped + " 跳过"
        + (item.failed ? " / " + item.failed + " 失败" : "")
        + (item.reason ? "（" + item.reason + "）" : "");
      sub.updatedAt = Date.now();
      break;
    }
    this._saveList(list);
  },

  /* ================== 去重记账（pref map，LRU） ================== */

  _seenLoad() {
    let raw = "";
    try { raw = String(this._prefGet(this.PREF_SEEN, "") || ""); } catch (e) { raw = ""; }
    if (!raw) return {};
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { return {}; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj;
  },

  _seenSave(map) {
    try { this._prefSet(this.PREF_SEEN, JSON.stringify(map || {})); }
    catch (e) { this._log("seen write failed", e); }
  },

  /** 写入一条并裁剪到 MAX_SEEN（按 at 淘汰最旧） */
  _seenPut(map, fp, itemID, at) {
    if (!map || !fp) return map;
    const rec = { at: Number(at) || Date.now() };
    if (itemID != null) rec.itemID = itemID;
    map[fp] = rec;
    const keys = Object.keys(map);
    if (keys.length > this.MAX_SEEN) {
      keys.sort(function (a, b) { return (Number(map[a].at) || 0) - (Number(map[b].at) || 0); });
      const drop = keys.length - this.MAX_SEEN;
      for (let i = 0; i < drop; i++) delete map[keys[i]];
    }
    return map;
  },

  _seenTouch(map, fp, at) {
    if (!map || !fp || !map[fp]) return;
    map[fp].at = Number(at) || Date.now();
  },

  /* ================== 指纹 / 归一（纯函数） ================== */

  _cleanDOI(v) {
    return String(v == null ? "" : v)
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .replace(/\s+/g, "")
      .replace(/[.,;]+$/, "")
      .trim();
  },

  /** 从 arxivId / idUrl / absUrl 里取「不带版本」的 ID */
  _baseId(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "";
    let m = s.match(/(\d{4}\.\d{4,5})(?:v\d+)?/);
    if (m) return m[1];
    m = s.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i);
    return m ? m[1] : "";
  },

  _arxivId(rec) {
    const r = rec || {};
    const links = r.links || {};
    const cands = [r.arxivId, r.baseId, r.idUrl, r.absUrl, links.abs, r.id, r.url];
    for (const c of cands) {
      const id = this._baseId(c);
      if (id) return id;
    }
    return "";
  },

  /** 标题归一（去空白/标点/符号 + 小写） */
  _normTitle(t) {
    return String(t == null ? "" : t).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  },

  /**
   * 去重指纹：DOI（小写）> arXiv ID（不带版本）> 归一标题。
   * @returns {string} 空记录返回 ""
   */
  _fingerprint(rec) {
    const r = rec || {};
    const doi = this._cleanDOI(r.doi || r.DOI || (r.links && r.links.doi) || "");
    if (doi) return "doi:" + doi.toLowerCase();
    const id = this._arxivId(r);
    if (id) return "arXiv:" + id;
    const t = this._normTitle(r.title);
    return t ? "title:" + t : "";
  },

  _yearOf(rec) {
    const r = rec || {};
    const m = /\b(\d{4})\b/.exec(String(r.publishedDay || r.published || r.year || r.date || ""));
    return m ? m[1] : "";
  },

  /** 把各源/旧版 arxiv 形状统一成 v2 entry（纯函数） */
  _normEntry(e) {
    if (!e || typeof e !== "object") return null;
    if (e.source) {
      return Object.assign({
        id: e.id || e.arxivId || "",
        title: String(e.title || "").trim(),
        summary: String(e.summary || "").trim(),
        authors: Array.isArray(e.authors) ? e.authors : [],
        published: String(e.published || "").slice(0, 10),
        publishedDay: String(e.published || "").slice(0, 10),
        url: String(e.url || ""),
        pdfUrl: String(e.pdfUrl || ""),
        categories: Array.isArray(e.categories) ? e.categories : [],
        doi: this._cleanDOI(e.doi),
        citationCount: Number(e.citationCount) || 0,
        source: e.source,
      }, e);
    }
    const id = this._arxivId(e);
    const links = e.links || {};
    const day = String(e.publishedDay || e.published || e.date || "").slice(0, 10);
    return {
      source: "arxiv",
      id: id,
      arxivId: id,
      doi: this._cleanDOI(e.doi || e.DOI || links.doi),
      title: String(e.title || "").trim(),
      summary: String(e.summary || e.abstractNote || "").trim(),
      authors: Array.isArray(e.authors) ? e.authors : [],
      published: day,
      publishedDay: day,
      url: String(e.absUrl || e.idUrl || links.abs || ""),
      pdfUrl: String(e.pdfUrl || links.pdf || ""),
      categories: Array.isArray(e.categories) ? e.categories : [],
      venue: String(e.journalRef || ""),
      citationCount: 0,
      type: "preprint",
    };
  },

  /* ================== 条目构造（纯函数：不保存） ================== */

  /** ["Ada Lovelace", {name}] → [{firstName,lastName,creatorType}] */
  _creators(authors) {
    const out = [];
    const list = Array.isArray(authors) ? authors : [];
    for (const a of list) {
      let raw = "";
      if (typeof a === "string") raw = a;
      else if (a && typeof a === "object") raw = a.name || a.literal || [a.given, a.family].filter(Boolean).join(" ");
      const name = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
      if (!name) continue;
      const sp = name.lastIndexOf(" ");
      if (sp > 0) out.push({ firstName: name.slice(0, sp), lastName: name.slice(sp + 1), creatorType: "author" });
      else out.push({ lastName: name, creatorType: "author" });
    }
    return out;
  },

  /**
   * 检索记录 → Zotero 条目（**不保存**；纯构造便于单测断言字段）
   * arXiv / preprint → preprint（extra = arXiv: id）；
   * 期刊源（OpenAlex / Crossref / PubMed）→ journalArticle（DOI / 期刊 / 卷期页）。
   */
  _buildItem(rec, subName) {
    const r = rec || {};
    const isPreprint = r.source === "arxiv" || (!!r.arxivId && !r.doi) || r.type === "preprint" || !r.source;
    const item = new Zotero.Item(isPreprint ? "preprint" : "journalArticle");
    try { item.libraryID = this._libID(); } catch (e) { /* ignore */ }

    const id = this._arxivId(r);
    const set = function (f, v) { try { if (v) item.setField(f, v); } catch (e) { /* 该类型无此字段 */ } };
    set("title", String(r.title || "").trim());
    set("date", String(r.publishedDay || r.published || this._yearOf(r) || "").trim().slice(0, 10));
    set("abstractNote", String(r.summary || r.abstractNote || "").trim());
    set("url", String(r.url || "").trim() || (id ? "https://arxiv.org/abs/" + id : ""));
    set("DOI", this._cleanDOI(r.doi));

    if (isPreprint) {
      set("extra", id ? "arXiv: " + id : "");
    } else {
      set("publicationTitle", String(r.venue || "").trim());
      set("volume", String(r.volume || "").trim());
      set("issue", String(r.issue || "").trim());
      set("pages", String(r.pages || "").trim());
      if (id) set("extra", "arXiv: " + id);
    }

    const creators = this._creators(r.authors);
    if (creators.length) { try { item.setCreators(creators); } catch (e) { /* 个别姓名异常时忽略 */ } }
    const tag = String(subName || "").trim();
    if (tag) {
      try { item.addTag(this.TAG_PREFIX + this._safeName(tag)); }
      catch (e) { /* 标签失败不挡入库 */ }
    }
    return item;
  },

  /* ================== 库访问（防御式） ================== */

  _libID() {
    try {
      const id = Zotero.Libraries.userLibraryID;
      if (typeof id === "number") return id;
    } catch (e) { /* ignore */ }
    return 1;
  },

  /** DOI 查重：只用 Zotero.Items.getByDOI（不拉全库）；不可用 / 抛错 → null */
  async _findByDOI(doi) {
    const d = this._cleanDOI(doi);
    if (!d) return null;
    try {
      const Items = (Zotero && Zotero.Items) || null;
      if (!Items || typeof Items.getByDOI !== "function") return null;
      const hit = await Items.getByDOI(d);
      if (Array.isArray(hit)) return hit.length ? hit[0] : null;
      return hit || null;
    } catch (e) {
      return null;
    }
  },

  /* ================== 笔记（与 scheduler 的 digest 同一条链路） ================== */

  _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  _noteHtml(title, md) {
    if (typeof MdLite !== "undefined" && MdLite && typeof MdLite.toNoteHtml === "function") {
      try { return MdLite.toNoteHtml(title, md); } catch (e) { /* 回落 */ }
    }
    return "<h2>" + this._esc(title) + "</h2><pre>" + this._esc(md) + "</pre>";
  },

  /** 库根目录独立笔记（同 Scheduler._saveNote 的建笔记方式） */
  async _saveNote(title, md) {
    const note = new Zotero.Item("note");
    note.libraryID = this._libID();
    note.setNote(this._noteHtml(title, md));
    await note.saveTx();
    return title;
  },

  /* ================== 检索执行 ================== */

  _arxiv() {
    try {
      if (typeof ArxivFetch !== "undefined" && ArxivFetch && typeof ArxivFetch.search === "function") return ArxivFetch;
    } catch (e) { /* ignore */ }
    return null;
  },

  _subSources() {
    try {
      if (typeof SubSources !== "undefined" && SubSources && typeof SubSources.search === "function") return SubSources;
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 订阅名归一：去换行/控制字符、`/`→`-`、限 24 字，防标签树被意外分层 */
  _safeName(name) {
    let s = String(name == null ? "" : name)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[\/\:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    if (s.length > 24) s = s.slice(0, 24);
    return s || "未命名订阅";
  },

  /** 逗号/分号/换行分隔 → 数组 */
  _splitList(raw) {
    return String(raw == null ? "" : raw)
      .split(/[,;，；\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  },

  /** 旧版 arXiv spec（0.53 语义；SubSources 缺位时的回退路径） */
  _spec(sub) {
    if (this._subSources() && SubSources.arxivSpec) {
      try { return SubSources.arxivSpec(sub); } catch (e) { /* 回落手写 */ }
    }
    const mode = String(sub && sub.mode || "all").toLowerCase();
    return {
      keywords: this._splitList(sub.keywords),
      categories: this._splitList(sub.categories),
      // 多分类是「并集」语义：订阅 cs.LG, cs.CL 应看到两个分类的新论文
      categoryMode: "OR",
      boolean: mode === "any" ? "OR" : "AND",
      phrase: mode === "phrase",
    };
  },

  /** 统一检索入口：优先多源适配层，缺位时退回 0.53 的 arXiv 单源 */
  async _search(sub, limit, now) {
    const SS = this._subSources();
    if (SS) {
      let s = sub;
      if (sub && sub.seedProfile) s = await this._withProfileTerms(sub);
      const r = await SS.search(s, { limit: limit, now: now });
      if (r && !r.ok) return { ok: false, entries: [], reason: r.reason || "network", bySource: r.bySource || {} };
      return { ok: true, entries: (r.entries || []).map((e) => this._normEntry(e)).filter(Boolean),
        bySource: r.bySource || {}, partial: !!r.partial };
    }
    const AF = this._arxiv();
    if (!AF) return { ok: false, entries: [], reason: "no_arxiv", bySource: {} };
    let res = null;
    try {
      res = await AF.search(this._spec(sub), {
        limit: limit,
        sortBy: "submittedDate",
        sortOrder: "descending",
      });
    } catch (e) {
      this._log("search failed: " + (sub && sub.name), e);
      return { ok: false, entries: [], reason: "network", bySource: {} };
    }
    if (res && res.ok === false) return { ok: false, entries: [], reason: res.reason || "network", bySource: {} };
    return { ok: true, entries: (res.entries || []).slice(0, limit).map((e) => this._normEntry(e)).filter(Boolean), bySource: {} };
  },

  /** seedProfile：把库内画像的高频词并入关键词（最多 4 个，去重） */
  async _withProfileTerms(sub) {
    try {
      if (typeof Discovery === "undefined" || !Discovery || !Discovery.collectLibraryItems || !Discovery.buildProfile) return sub;
      const items = await Discovery.collectLibraryItems();
      const p = Discovery.buildProfile(items, { topTerms: 24 });
      const have = this._splitList(sub.keywords).map((x) => x.toLowerCase());
      const add = (p.terms || []).map((t) => String(t.term || "")).filter((t) => t && have.indexOf(t.toLowerCase()) < 0).slice(0, 4);
      if (!add.length) return sub;
      return Object.assign({}, sub, { keywords: this._splitList(sub.keywords).concat(add).join(", ") });
    } catch (e) {
      this._log("seedProfile failed", e);
      return sub;
    }
  },

  /** 轻量相关度打分：标题命中 ×3 + 摘要命中 ×1 + 关键词覆盖 + 新近度 */
  _scoreEntry(e, sub, now) {
    const kws = this._splitList(sub && sub.keywords).map((k) => k.toLowerCase()).filter(Boolean);
    const title = String((e && e.title) || "").toLowerCase();
    const abst = String((e && e.summary) || "").toLowerCase();
    let score = 0;
    const reasons = [];
    for (const k of kws) {
      let hit = 0;
      if (title.indexOf(k) >= 0) hit += 3;
      if (abst.indexOf(k) >= 0) hit += 1;
      if (hit) { score += hit; reasons.push(k); }
    }
    const cats = this._splitList(sub && sub.categories);
    for (const c of (e && e.categories) || []) {
      if (cats.indexOf(c) >= 0) { score += 2; reasons.push(c); break; }
    }
    // 新近度：7 天内 3 → 0
    try {
      const t = new Date(e && e.published).getTime();
      if (isFinite(t)) {
        const days = ((now || Date.now()) - t) / 86400000;
        if (days >= 0 && days < 7) score += 3 * (1 - days / 7);
      }
    } catch (err) { /* ignore */ }
    return { score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)] };
  },

  /** 打分排序（纯函数）：结果多于上限时优先保留最相关 + 最新 */
  _rank(entries, sub, now) {
    const scored = (entries || []).map((e) => {
      const s = this._scoreEntry(e, sub, now);
      return Object.assign({}, e, { score: s.score, reasons: s.reasons });
    });
    scored.sort((a, b) => (b.score - a.score) || String(b.published || "").localeCompare(String(a.published || "")));
    return scored;
  },

  _statusText(status) {
    if (status === "added") return "新入库";
    if (status === "dup") return "已在库";
    if (status === "failed") return "入库失败";
    if (status === "seen") return "往期已见";
    if (status === "known") return "已在库";
    return "未入库";
  },

  _sourceLine(sub) {
    const ids = this._normSources(sub && sub.sources);
    if (!ids.length) return "";
    try {
      if (this._subSources() && SubSources.label) return ids.map((id) => SubSources.label(id)).join(" + ");
    } catch (e) { /* ignore */ }
    return ids.join(" + ");
  },

  _condLine(sub) {
    const parts = [];
    if (sub.keywords) parts.push("关键词：" + sub.keywords + (sub.mode === "any" ? "（任一）" : sub.mode === "phrase" ? "（短语）" : "（全部）"));
    if (sub.categories) parts.push("分类：" + sub.categories);
    if (sub.exclude) parts.push("排除：" + sub.exclude);
    if (sub.maxAgeDays) parts.push("近 " + sub.maxAgeDays + " 天");
    return parts.join(" · ");
  },

  _noteMd(sub, rows, counts, at, aiText) {
    const lines = [];
    const cond = this._condLine(sub);
    if (cond) lines.push(cond);
    const src = this._sourceLine(sub);
    if (src) lines.push("来源：" + src);
    lines.push("共 " + rows.length + " 条结果 · 新入库 " + counts.added
      + " · 跳过 " + counts.skipped + " · 失败 " + counts.failed);

    if (aiText) {
      lines.push("");
      lines.push("## AI 速览");
      lines.push(String(aiText).trim());
    }

    // 空态：所有结果都是「已在库」（本次没有任何新内容可看）
    const anyNew = rows.some(function (r) { return r.status !== "dup" && r.status !== "seen" && r.status !== "known"; });
    if (!anyNew) {
      lines.push("");
      lines.push("**本次无新增**：命中的论文均已在文库或往期速递中出现。");
    }

    if (rows.length) {
      lines.push("");
      lines.push("## 检索结果");
      rows.forEach(function (row, i) {
        const r = row.rec || {};
        const y = this._yearOf(r);
        const id = this._arxivId(r);
        let line = (i + 1) + ". **" + String(r.title || "(无标题)") + "**";
        if (y) line += " (" + y + ")";
        if (id) line += " · arXiv:" + id;
        else if (r.doi) line += " · DOI:" + r.doi;
        if (r.venue) line += " · " + r.venue;
        if (r.citationCount) line += " · 被引 " + r.citationCount;
        line += " · " + this._statusText(row.status);
        lines.push(line);
      }, this);
    }
    lines.push("");
    lines.push("> 由 Papilot 订阅检索生成于 " + this._stamp(at) + "。");
    return lines.join("\n");
  },

  /**
   * 执行一次订阅（会入库、会写记账、会生成笔记）。
   * @param {string} id
   * @param {{noNote?:boolean, now?:Date|number, trigger?:string, noAi?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, added:number, skipped:number, failed:number,
   *                    reason?:string, noteTitle?:string, bySource?:object}>}
   *   reason: no_sub / no_arxiv / network / empty / busy / no_query
   */
  async run(id, opts) {
    const o = opts || {};
    const at = this._dateOf(o.now);
    const zero = { added: 0, skipped: 0, failed: 0 };
    const sub = this._find(id);
    if (!sub) return Object.assign({ ok: false, reason: "no_sub" }, zero);
    if (this._running[id]) return Object.assign({ ok: false, reason: "busy" }, zero);
    if (!this._subSources() && !this._arxiv()) return Object.assign({ ok: false, reason: "no_arxiv" }, zero);
    if (!sub.keywords && !sub.categories) return Object.assign({ ok: false, reason: "no_query" }, zero);

    this._running[id] = true;
    let added = 0;
    let skipped = 0;
    let failed = 0;
    try {
      const limit = this._clampMax(sub.max);
      const res = await this._search(sub, limit, at);
      if (!res.ok) {
        const reason = res.reason === "no_arxiv" ? "no_arxiv" : "network";
        this._pushRunLog(id, { at: this._stamp(at), trigger: o.trigger || "manual", reason: reason });
        return Object.assign({ ok: false, reason: reason, bySource: res.bySource }, { added: 0, skipped: 0, failed: 0 });
      }
      if (!res.entries.length) {
        this._pushRunLog(id, { at: this._stamp(at), trigger: o.trigger || "manual", reason: "empty" });
        return Object.assign({ ok: false, reason: "empty", bySource: res.bySource }, { added: 0, skipped: 0, failed: 0 });
      }

      const seen = this._seenLoad();
      const stamp = at.getTime();
      const rows = [];
      // 批内去重（只活在本次执行，不写 pref）：多源合并 / 分页重叠会让同一条在一个批次里
      // 出现两次。没有它，autoImport=false 的速递会把同一篇论文列两遍。
      const seenThisRun = new Set();
      // 结果多于上限时按相关度截断；未超限时保持源返回顺序（旧行为不变，便于追溯）
      let ordered = res.entries.length > limit
        ? this._rank(res.entries, sub, stamp).slice(0, limit)
        : res.entries;
      // AI 复核是用户显式开启的可选项：只改顺序与解读，不改变「是否入库」的确定性判定
      if (!o.noAi && sub.aiRerank) {
        try { ordered = await this.aiRerank(sub, ordered); } catch (e) { /* 保持原序 */ }
      }

      for (const rec of ordered) {
        const normalized = this._normEntry(rec);
        const fp = this._fingerprint(normalized);
        let status = "";
        let itemID = null;

        // 本批已处理过同一条（多源合并 / 分页重叠）：只记一次跳过，不重复入库、
        // 不写 seen。**不 push 行**——否则速递里仍会把同一篇列两遍（autoImport=false
        // 时最明显：没有任何记账兜底）。
        if (fp && seenThisRun.has(fp)) {
          skipped++;
          continue;
        }
        if (fp) seenThisRun.add(fp);

        if (fp && seen[fp]) {
          skipped++;
          status = "dup";
          itemID = seen[fp].itemID == null ? null : seen[fp].itemID;
          this._seenTouch(seen, fp, stamp);
        } else {
          const doi = this._cleanDOI(normalized && normalized.doi);
          const exist = doi ? await this._findByDOI(doi) : null;
          if (exist) {
            skipped++;
            status = "dup";
            itemID = exist.id == null ? null : exist.id;
            if (fp) this._seenPut(seen, fp, itemID, stamp);
          } else if (sub.autoImport) {
            let item = null;
            try {
              item = this._buildItem(normalized, sub.name);
              await item.saveTx();
              added++;
              status = "added";
              itemID = item.id == null ? null : item.id;
              if (fp) this._seenPut(seen, fp, itemID, stamp);
            } catch (e) {
              // 单条失败不中断整次订阅；不记账，下次运行会重试
              failed++;
              status = "failed";
              this._log("import failed: " + String((normalized && normalized.title) || ""), e);
            }
          } else {
            // autoImport=false：只推送、不入库 → **不记账**。
            // 写了 seen 会让这批论文之后永远被当成「往期已见」，用户改成自动入库也再收不到
            // （等于静默丢论文）。代价只是它们会重复出现在速递里，可接受；已手动导入的
            // 条目仍会被上面的 DOI 查重拦住，不会重复入库。
            status = "skipped";
          }
        }

        rows.push({ rec: normalized, status: status, itemID: itemID });
      }

      this._seenSave(seen);

      const counts = { added: added, skipped: skipped, failed: failed };
      const out = { ok: true, added: added, skipped: skipped, failed: failed, bySource: res.bySource || {} };

      // AI 复核（可选）：只影响笔记排序与解读，不改变「是否入库」的确定性结果
      let aiText = "";
      if (!o.noAi && sub.aiDigest && added > 0) {
        try { aiText = await this.aiDigest(sub, rows); } catch (e) { aiText = ""; }
      }

      if (!o.noNote) {
        const title = "订阅速递：" + sub.name + " " + this._dayKey(at);
        try {
          await this._saveNote(title, this._noteMd(sub, rows, counts, at, aiText));
          out.noteTitle = title;
        } catch (e) {
          this._log("note save failed: " + sub.name, e);
        }
      }

      this._pushRunLog(id, {
        at: this._stamp(at), added: added, skipped: skipped, failed: failed,
        trigger: o.trigger || "manual", reason: "",
      });
      return out;
    } catch (e) {
      // 兜底：任何未预期异常都以 network 语义返回，绝不抛给调用方
      this._log("run(" + id + ") failed", e);
      this._pushRunLog(id, { at: this._stamp(at), trigger: o.trigger || "manual", reason: "network" });
      return { ok: false, reason: "network", added: added, skipped: skipped, failed: failed };
    } finally {
      delete this._running[id];
    }
  },

  /**
   * 试跑预览：**只取数 + 打分 + 标注状态，绝不写 pref / 不入库 / 不记账 / 不出笔记**。
   * @param {string|object} input 订阅 id，或一份待创建的订阅草稿（与 add 同字段）
   * @param {{limit?:number, now?:Date|number}} [opts]
   * @returns {Promise<{ok:boolean, entries:Array, bySource:object, reason?:string, partial?:boolean}>}
   */
  async preview(input, opts) {
    const o = opts || {};
    const at = this._dateOf(o.now);
    let sub = null;
    if (typeof input === "string") {
      sub = this._find(input);
      if (!sub) return { ok: false, entries: [], bySource: {}, reason: "no_sub" };
    } else {
      sub = this._coerce(input || {});
    }
    if (!sub.keywords && !sub.categories) return { ok: false, entries: [], bySource: {}, reason: "no_query" };
    if (!this._subSources() && !this._arxiv()) return { ok: false, entries: [], bySource: {}, reason: "no_arxiv" };

    const limit = Math.max(1, Math.min(this.MAX_LIMIT, parseInt(o.limit, 10) || 10));
    const res = await this._search(sub, limit, at);
    if (!res.ok) return { ok: false, entries: [], bySource: res.bySource || {}, reason: res.reason || "network" };

    const seen = this._seenLoad();
    let ranked = this._rank(res.entries, sub, at.getTime());
    if (sub.aiRerank) {
      try { ranked = await this.aiRerank(sub, ranked); } catch (e) { /* 保持确定性排序 */ }
    }
    ranked = ranked.slice(0, limit);
    const entries = [];
    for (const rec of ranked) {
      const e = this._normEntry(rec);
      const fp = this._fingerprint(e);
      let status = "new";
      if (fp && seen[fp]) status = "seen";
      else if (this._cleanDOI(e.doi)) {
        const exist = await this._findByDOI(e.doi);
        if (exist) status = "known";
      }
      entries.push(Object.assign({}, e, { status: status, score: rec.score, reasons: rec.reasons || [] }));
    }
    return { ok: true, entries: entries, bySource: res.bySource || {}, partial: !!res.partial };
  },

  /* ================== 智能推荐（基于库内研究领域） ================== */

  _recoDismissed() {
    try {
      const raw = this._prefGet(this.PREF_RECO_DISMISSED, "");
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      return new Set();
    }
  },

  /** 忽略一条推荐主题（持久化，之后不再出现） */
  dismissReco(id) {
    const key = String(id || "").trim();
    if (!key) return false;
    const set = this._recoDismissed();
    set.add(key);
    let ok = false;
    try {
      ok = !!this._prefSet(this.PREF_RECO_DISMISSED, JSON.stringify([...set].slice(-100)));
    } catch (e) {
      ok = false;
    }
    // 缓存里也要剔掉：否则「忽略」之后下一次仍从缓存返回，用户会觉得忽略没生效
    try {
      const cache = this._recoCacheLoad();
      if (cache) {
        const kept = cache.items.filter(function (x) { return x && x.id !== key; });
        if (kept.length !== cache.items.length) {
          this._prefSet(this.PREF_RECO_CACHE, JSON.stringify({ at: cache.at, items: kept }));
        }
      }
    } catch (e) { /* 缓存清理失败不影响「忽略」本身 */ }
    return ok;
  },

  /* ---- 推荐结果缓存（12h；订阅变化 / 忽略推荐时失效） ---- */

  /** @returns {{at:number, items:Array}|null} 缓存结构不合法一律当没有 */
  _recoCacheLoad() {
    let raw = "";
    try { raw = String(this._prefGet(this.PREF_RECO_CACHE, "") || ""); } catch (e) { raw = ""; }
    if (!raw) return null;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (!Array.isArray(obj.items)) return null;
    const at = Number(obj.at);
    if (!isFinite(at) || at <= 0) return null;
    // 缓存是跨版本残留的 JSON：脏元素（字符串 / 数字 / null / 数组）在渲染推荐卡时
    // 会直接抛错，所以在这里过滤掉；过滤后为空 = 没有可用缓存。
    const items = obj.items.filter(function (x) {
      return !!x && typeof x === "object" && !Array.isArray(x);
    });
    if (!items.length) return null;
    return { at: at, items: items };
  },

  /**
   * 写缓存（at = 计算完成的时刻）。
   * 空结果不写 `{at, items: []}`——那会把「库里暂时没有可分析内容」冻结 12 小时，
   * 用户导入文献后仍看到「暂无推荐」。清空 pref = 下次进设置立刻重算。
   */
  _recoCacheSave(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return this._clearRecoCache();
    try {
      return !!this._prefSet(this.PREF_RECO_CACHE, JSON.stringify({ at: Date.now(), items: list }));
    } catch (e) {
      this._log("reco cache write failed", e);
      return false;
    }
  },

  /**
   * 清空推荐缓存（订阅增 / 改 / 删成功后调用）。
   * 推荐结果里带着「与现有订阅去重」的判断，订阅一变就必须重算，否则会推荐已被覆盖的主题、
   * 或漏掉本该推荐的主题。
   * @returns {boolean} 是否写入成功
   */
  _clearRecoCache() {
    this._recoFromCache = false;
    try { return !!this._prefSet(this.PREF_RECO_CACHE, ""); }
    catch (e) { return false; }
  },

  /** 上一次 suggest() 是否直接复用了缓存（设置面板据此区分提示文案） */
  recoFromCache() {
    return !!this._recoFromCache;
  },

  _termsOfText(text) {
    let toks = [];
    try {
      if (typeof Discovery !== "undefined" && Discovery && Discovery.tokenize) toks = Discovery.tokenize(text);
    } catch (e) { toks = []; }
    if (!toks.length) {
      toks = String(text == null ? "" : text).toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((x) => x && x.length >= 2);
    }
    return [...new Set(toks)].slice(0, 30);
  },

  _kwSet(keywords) {
    return new Set(this._splitList(keywords).map((x) => x.toLowerCase()));
  },

  _jaccard(a, b) {
    const A = a instanceof Set ? a : new Set(a || []);
    const B = b instanceof Set ? b : new Set(b || []);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
  },

  /**
   * 产出「可以一键创建」的主题订阅建议（确定性、可解释，不依赖 AI）。
   *
   * 逻辑：
   *   1) 库内画像（Discovery.buildProfile：标题×3 / 标签×3 / 期刊×2 / 摘要×1，df 过滤泛词）
   *   2) 三类候选：
   *      - 分类轨道：库内出现最多的 1-2 个 arXiv 分类，各自再画像取词
   *      - 全局主题：全库画像 Top 词
   *      - 近期关注：近 180 天入库条目的画像 Top 词
   *   3) 可解释性：每条给出覆盖篇数 / 近 90 天新增 / 生成理由
   *   4) 去重：与现有订阅关键词 Jaccard ≥ 0.5 的主题不再推荐
   *   5) 缓存：12 小时内直接复用上次结果（订阅增删改会让缓存失效）；force 强制重算
   *
   * @param {{max?:number, now?:Date|number, force?:boolean}} [opts]
   * @returns {Promise<Array<{id:string,name:string,keywords:string,categories:string,
   *          sources:string[],mode:string,maxAgeDays:number,reason:string,coverage:number,recent:number,kind:string}>>}
   */
  async suggest(opts) {
    const o = opts || {};
    const max = Math.max(1, Math.min(5, parseInt(o.max, 10) || 3));
    const now = this._dateOf(o.now);
    const dismissed = this._recoDismissed();
    this._recoFromCache = false;

    // 12h 缓存：命中即返回（仍要过滤「已忽略」——忽略是用户的明确意图，不能因为缓存复活）
    if (!o.force) {
      const cache = this._recoCacheLoad();
      if (cache) {
        const age = Date.now() - cache.at;
        if (age >= 0 && age < this.RECO_TTL_MS) {
          this._recoFromCache = true;
          return cache.items
            .filter(function (x) { return x && !dismissed.has(x.id); })
            .slice(0, max);
        }
      }
    }

    let items = [];
    try {
      if (typeof Discovery !== "undefined" && Discovery && Discovery.collectLibraryItems) {
        items = await Discovery.collectLibraryItems();
      }
    } catch (e) {
      this._log("suggest: collect items failed", e);
      items = [];
    }

    const profileOf = (list, top) => {
      try {
        if (typeof Discovery !== "undefined" && Discovery && Discovery.buildProfile) {
          return Discovery.buildProfile(list, { topTerms: top || 24 });
        }
      } catch (e) { /* 回落 */ }
      return { terms: [], categories: [], scanned: 0 };
    };
    const itemsOfCat = (cat) => {
      const out = [];
      for (const it of items) {
        try {
          if (typeof Discovery !== "undefined" && Discovery && Discovery.extractArxiv) {
            if ((Discovery.extractArxiv(it).categories || []).indexOf(cat) >= 0) out.push(it);
          }
        } catch (e) { /* ignore */ }
      }
      return out;
    };
    const recentItems = items.filter((it) => {
      try {
        const t = Number(it.dateAdded ? new Date(it.dateAdded).getTime() : 0);
        return t && (now.getTime() - t) <= 180 * 86400000;
      } catch (e) { return false; }
    });
    const cover = (kws) => {
      const list = kws.map((k) => k.toLowerCase()).filter(Boolean);
      let c = 0;
      let r = 0;
      for (const it of items) {
        let blob = "";
        try {
          blob = [it.getField("title"), it.getField("abstractNote"),
            (it.getTags() || []).map((t) => t.tag).join(" ")].join(" ").toLowerCase();
        } catch (e) { blob = ""; }
        if (list.some((k) => blob.indexOf(k) >= 0)) {
          c++;
          try {
            const t = Number(it.dateAdded ? new Date(it.dateAdded).getTime() : 0);
            if (t && (now.getTime() - t) <= 90 * 86400000) r++;
          } catch (e) { /* ignore */ }
        }
      }
      return { coverage: c, recent: r };
    };
    const mk = (kind, name, kws, cats, extra) => {
      const keywords = [...new Set(kws.map((x) => String(x || "").trim()).filter((x) => x.length >= 2))].slice(0, 5);
      if (!keywords.length) return null;
      const cov = cover(keywords);
      return Object.assign({
        id: "reco-" + kind + "-" + this._normTitle(keywords.slice(0, 3).join("-")).slice(0, 24),
        name: name,
        keywords: keywords.join(", "),
        categories: cats || "",
        sources: ["arxiv", "openalex"],
        mode: "any",
        maxAgeDays: 14,
        reason: "",
        coverage: cov.coverage,
        recent: cov.recent,
        kind: kind,
      }, extra || {});
    };

    const cands = [];
    const full = profileOf(items, 24);
    const topTerms = (full.terms || []).map((t) => t.term);
    if (items.length && topTerms.length) {
      const cats = (full.categories || []).slice(0, 2);
      for (const cat of cats) {
        const subset = itemsOfCat(cat);
        if (subset.length < 2) continue;
        const p = profileOf(subset, 12);
        const kws = (p.terms || []).map((t) => t.term).slice(0, 4);
        if (!kws.length) continue;
        const c = mk("cat", "追踪 " + cat, kws, cat, {
          reason: "库内 " + subset.length + " 篇属于 " + cat + "，用其中高频词作检索条件",
        });
        if (c) cands.push(c);
      }
      const globalKws = topTerms.slice(0, 4);
      const g = mk("topic", globalKws.slice(0, 2).join(" / "), globalKws, "", {
        reason: "全库画像的高频主题词（已过滤出现在过多文献里的泛词）",
      });
      if (g) cands.push(g);

      if (recentItems.length >= 2) {
        const rp = (profileOf(recentItems, 12).terms || []).map((t) => t.term).slice(0, 4);
        const r = mk("recent", "近半年关注：" + (rp.slice(0, 2).join(" / ") || "新方向"), rp, "", {
          reason: "近 180 天新入库 " + recentItems.length + " 篇，反映你当前的关注点",
        });
        if (r) cands.push(r);
      }
    } else {
      // 冷启动：库里没有可分析条目时，退回「研究者画像」文本（设置 → AI 与翻译 → 研究者画像）
      let rp = "";
      try { rp = String(this._prefGet("researcherProfile", "") || ""); } catch (e) { rp = ""; }
      const kws = this._termsOfText(rp).slice(0, 5);
      if (kws.length) {
        const c = mk("profile", "研究方向：" + kws.slice(0, 2).join(" / "), kws, "", {
          reason: "来自「研究者画像」文本；库内条目还太少，导入一些文献后推荐会更准",
        });
        if (c) cands.push(c);
      }
    }

    const existing = this._loadList().map((s) => this._kwSet(s.keywords));
    const out = [];
    for (const c of cands) {
      if (dismissed.has(c.id)) continue;
      const set = this._kwSet(c.keywords);
      if (existing.some((e) => this._jaccard(e, set) >= 0.5)) continue;
      if (out.some((x) => this._jaccard(this._kwSet(x.keywords), set) >= 0.6)) continue;
      out.push(c);
    }
    out.sort((a, b) => (b.recent * 3 + b.coverage) - (a.recent * 3 + a.coverage));
    // 缓存完整候选（不截断）：下次换个 max 也能直接复用
    this._recoCacheSave(out);
    return out.slice(0, max);
  },

  /** 从「文献发现」当前条件生成订阅草稿（不落盘，交给 UI 预览/确认） */
  fromDiscovery() {
    let cats = "";
    let terms = [];
    try { cats = String(this._prefGet("discoveryCategories", "") || ""); } catch (e) { cats = ""; }
    try {
      if (typeof Discovery !== "undefined" && Discovery && Discovery.loadCache) {
        const d = Discovery.loadCache();
        terms = ((d && d.profile && d.profile.terms) || []).slice(0, 4).map((t) => t.term);
      }
    } catch (e) { terms = []; }
    const firstCat = this._splitList(cats)[0] || "";
    return {
      name: firstCat ? "发现：" + firstCat : "库内兴趣追踪",
      keywords: terms.join(", "),
      categories: cats,
      sources: ["arxiv"],
      mode: "any",
      maxAgeDays: 7,
      freq: "daily",
      dailyTime: "08:00",
      max: 10,
      autoImport: false,
      aiRerank: false,
      aiDigest: false,
    };
  },

  /* ================== 导出 / 导入（剪贴板；多机同步、点对点分享） ================== */

  /** 导出时会带上的配置字段（顺序即 JSON 里的顺序，便于人工核对） */
  EXPORT_FIELDS: ["name", "enabled", "sources", "keywords", "categories", "mode", "exclude",
    "maxAgeDays", "freq", "dailyTime", "weekdays", "max", "autoImport", "aiRerank", "aiDigest", "seedProfile"],

  /**
   * 订阅 → 可粘贴的 JSON 文本。
   * 只导出**配置**：id / lastRun / lastStatus / runLog / createdAt 是本机运行态，
   * 跨机复制过去只会造成「上次运行时间对不上」的困惑。
   * @returns {string} 2 空格缩进的 JSON
   */
  exportJson() {
    const subscriptions = [];
    for (const sub of this._loadList()) {
      const out = {};
      for (const f of this.EXPORT_FIELDS) out[f] = sub[f];
      subscriptions.push(out);
    }
    return JSON.stringify({
      app: "papilot",
      kind: "searchSubscriptions",
      version: 2,
      subscriptions: subscriptions,
    }, null, 2);
  },

  /**
   * 粘贴文本 → 追加订阅。宽容接受本模块的包裹格式，也接受裸数组。
   *
   * 语义：
   *   - 逐条用 `_coerce` 归一（脏字段自动降级），name 必填且 keywords/categories 至少一个；
   *   - **重新分配 id**（避免两台机器的 id 撞车），运行态清零（lastRun/lastStatus/runLog）；
   *   - 同名已存在 → 跳过（见面板提示「跳过同名订阅」），不重复创建；
   *   - 坏 JSON / 结构不认识 → 返回 error，**不抛**（粘贴板内容不可信）。
   *
   * @param {string} text
   * @returns {{ok:boolean, added:number, skipped:number, error?:string}}
   */
  importJson(text) {
    const bad = function (error) { return { ok: false, added: 0, skipped: 0, error: error }; };
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return bad("empty");

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (parsed == null) {
      // 用户常把说明文字一起粘进来：退一步取首个 [ 到末个 ]
      const a = raw.indexOf("[");
      const b = raw.lastIndexOf("]");
      if (a >= 0 && b > a) {
        try { parsed = JSON.parse(raw.slice(a, b + 1)); } catch (e) { parsed = null; }
      }
    }
    if (parsed == null) return bad("parse_failed");

    let arr = null;
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && typeof parsed === "object" && Array.isArray(parsed.subscriptions)) arr = parsed.subscriptions;
    if (!arr) return bad("bad_shape");

    const list = this._loadList();
    const nameKey = function (s) {
      return String((s && s.name) || "").trim().toLowerCase();
    };

    // 同名已存在 → 跳过（面板提示里写的也是「跳过同名订阅」）。
    // 用名字而不是「同名 + 同条件」做判据：条件可以事后在面板里改，
    // 同名两条订阅在列表里无法区分，用户根本不知道该删哪一条。
    const names = new Set();
    for (const s of list) names.add(nameKey(s));

    const fresh = [];
    let skipped = 0;
    for (const item of arr) {
      if (!item || typeof item !== "object" || Array.isArray(item)) { skipped++; continue; }
      const sub = this._coerce(item, "");
      if (!sub.name || (!sub.keywords && !sub.categories)) { skipped++; continue; }
      const nk = nameKey(sub);
      if (names.has(nk)) { skipped++; continue; }
      sub.id = this._newId(list.concat(fresh));
      sub.lastRun = "";
      sub.lastStatus = "";
      sub.runLog = [];
      sub.createdAt = Date.now();
      sub.updatedAt = 0;
      fresh.push(sub);
      names.add(nk);
    }

    if (!fresh.length) return { ok: true, added: 0, skipped: skipped };
    if (!this._saveList(fresh.concat(list))) return bad("write_failed");
    this._clearRecoCache();
    return { ok: true, added: fresh.length, skipped: skipped };
  },

  /** 写剪贴板：优先主窗口 navigator.clipboard，失败退回 XPCOM（同 note-templates） */
  async _writeClipboard(text) {
    const s = String(text == null ? "" : text);
    try {
      const win = Zotero.getMainWindow();
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
        await win.navigator.clipboard.writeText(s);
        return true;
      }
    } catch (e) { /* 走 XPCOM 回落 */ }
    try {
      if (typeof Components === "undefined" || !Components.classes) return false;
      const clip = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(s);
      return true;
    } catch (e) {
      this._log("clipboard write failed", e);
      return false;
    }
  },

  /** 读剪贴板文本：优先主窗口 navigator.clipboard，失败退回 XPCOM；读不到返回 "" */
  async _readClipboard() {
    try {
      const win = Zotero.getMainWindow();
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.readText) {
        const t = await win.navigator.clipboard.readText();
        return String(t == null ? "" : t);
      }
    } catch (e) { /* 走 XPCOM 回落 */ }
    try {
      if (typeof Components === "undefined" || !Components.classes) return "";
      const clip = Components.classes["@mozilla.org/widget/clipboard;1"]
        .getService(Components.interfaces.nsIClipboard);
      const trans = Components.classes["@mozilla.org/widget/transferable;1"]
        .createInstance(Components.interfaces.nsITransferable);
      if (trans.init) trans.init(null);
      for (const flavor of ["text/plain", "text/unicode"]) {
        try {
          trans.addDataFlavor(flavor);
          clip.getData(trans, clip.kGlobalClipboard);
          const data = {};
          const len = {};
          try { trans.getTransferData(flavor, data, len); } catch (e) { data.value = trans.getTransferData(flavor); }
          if (data.value) {
            const str = data.value.QueryInterface(Components.interfaces.nsISupportsString);
            if (str && str.data) return String(str.data);
          }
        } catch (e) { /* 换下一个 flavor */ }
      }
    } catch (e) {
      this._log("clipboard read failed", e);
    }
    return "";
  },

  /**
   * 导出到剪贴板。
   * @returns {Promise<{ok:boolean, count:number, error?:string}>}
   */
  async exportToClipboard() {
    let count = 0;
    try {
      count = this._loadList().length;
      const json = this.exportJson();
      const ok = await this._writeClipboard(json);
      if (!ok) return { ok: false, count: count, error: "clipboard_write_failed" };
      return { ok: true, count: count };
    } catch (e) {
      this._log("exportToClipboard failed", e);
      return { ok: false, count: count, error: String((e && (e.message || e)) || e) };
    }
  },

  /**
   * 从剪贴板导入。
   * @returns {Promise<{ok:boolean, added:number, skipped:number, error?:string}>}
   */
  async importFromClipboard() {
    try {
      const text = await this._readClipboard();
      if (!String(text || "").trim()) return { ok: false, added: 0, skipped: 0, error: "clipboard_empty" };
      return this.importJson(text);
    } catch (e) {
      this._log("importFromClipboard failed", e);
      return { ok: false, added: 0, skipped: 0, error: String((e && (e.message || e)) || e) };
    }
  },

  /* ================== AI 辅助（可选；失败一律降级，绝不阻断） ================== */

  _ai() {
    try {
      if (typeof AIClient !== "undefined" && AIClient && typeof AIClient.chat === "function") return AIClient;
    } catch (e) { /* ignore */ }
    return null;
  },

  /** AI 是否可用；不可用时返回可读原因（供 UI 指引） */
  aiStatus() {
    const ai = this._ai();
    if (!ai) return { ok: false, reason: "no_ai", guide: "AI 模块未就绪" };
    let s = "no_key";
    try { s = ai.status ? ai.status() : (ai.hasKey && ai.hasKey() ? "ok" : "no_key"); } catch (e) { s = "no_key"; }
    if (s === "ok") return { ok: true, reason: "ok", guide: "" };
    return {
      ok: false,
      reason: s,
      guide: s === "not_logged_in"
        ? "官方模型需要登录：设置 → Papilot 登录账号，或在「AI 模型通道」里配置自己的接口"
        : "未配置 AI：设置 → AI 模型通道（填 Base URL 与 Key，或登录官方通道）",
    };
  },

  _extractJson(text, open, close) {
    let s = String(text == null ? "" : text).trim();
    s = s.replace(/```(?:json)?/gi, "").replace(/```/g, "");
    const a = s.indexOf(open);
    const b = s.lastIndexOf(close);
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  },

  _validCats(raw) {
    let cats = Array.isArray(raw) ? raw : this._splitList(raw);
    cats = cats.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 4);
    try {
      if (typeof ArxivCategories !== "undefined" && ArxivCategories && ArxivCategories.checkAll) {
        const r = ArxivCategories.checkAll(cats);
        const bad = new Set([].concat(r.unknown || [], r.malformed || [], r.invalid || []).map((x) => String(x).toLowerCase()));
        cats = cats.filter((c) => !bad.has(c.toLowerCase()));
      }
    } catch (e) { /* 保留原值 */ }
    return cats.join(", ");
  },

  /**
   * 一句话 → 订阅草稿（AI 解析）。**只返回草稿，不创建**；UI 必须先预览再确认。
   *
   * 能力边界：
   *   - 只做「自然语言 → 结构化检索条件」的翻译，不替用户决定是否自动入库；
   *   - 输出必须通过白名单校验（来源 / 模式 / 频率 / 时间 / 分类），不合格的字段丢弃；
   *   - 关键词统一要求英文（中文检索在 arXiv/OpenAlex 命中率低），失败不臆造；
   *   - 未配置 AI 时返回 no_ai，不偷偷走别的通道。
   *
   * @param {string} text 用户描述（可中文）
   * @returns {Promise<{ok:boolean, input?:object, note?:string, reason?:string, guide?:string}>}
   */
  async aiParseQuery(text) {
    const desc = String(text == null ? "" : text).trim();
    if (!desc) return { ok: false, reason: "empty" };
    const st = this.aiStatus();
    if (!st.ok) return { ok: false, reason: st.reason, guide: st.guide };
    const ai = this._ai();
    let cats = "";
    try {
      if (typeof ArxivCategories !== "undefined" && ArxivCategories && Array.isArray(ArxivCategories.ALL)) {
        cats = ArxivCategories.ALL.slice(0, 220).map((c) => c.code).join(", ");
      }
    } catch (e) { cats = ""; }

    const sys = [
      "你是文献订阅配置助手。把用户的一句话研究兴趣翻译成检索订阅参数。",
      "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。字段：",
      '{"name":"订阅名称(中文,≤20字)","keywords":["英文检索词",...],',
      '"categories":["arXiv分类代码"],"sources":["arxiv"|"openalex"|"crossref"|"pubmed"],',
      '"mode":"all|any|phrase","exclude":["排除词"],"maxAgeDays":7,',
      '"freq":"daily|weekly|manual","dailyTime":"HH:MM","autoImport":false}',
      "规则：keywords 必须是英文（中文概念要译成领域通用英文术语），2-5 个，不要泛词；",
      "categories 只在有把握时给，代码区分大小写，不确定就留空数组；",
      "sources：预印本/理论/CS 用 arxiv；医学用 europepmc（比 pubmed 在部分网络更稳）并加 openalex；综合学科用 openalex+crossref；",
      "autoImport 默认 false（先预览再入库）；maxAgeDays 默认 7；freq 默认 daily，dailyTime 默认 08:00。",
      cats ? "可用 arXiv 分类（部分）：" + cats : "",
    ].filter(Boolean).join("\n");

    let out = "";
    try {
      out = await ai.chat([{ role: "system", content: sys }, { role: "user", content: desc }]);
    } catch (e) {
      return { ok: false, reason: "ai_failed", guide: String((e && (e.message || e)) || e).slice(0, 200) };
    }
    const obj = this._extractJson(out, "{", "}");
    if (!obj || typeof obj !== "object") return { ok: false, reason: "parse_failed" };

    const kws = (Array.isArray(obj.keywords) ? obj.keywords : this._splitList(obj.keywords))
      .map((x) => String(x || "").trim()).filter((x) => x.length >= 2 && x.length <= 80).slice(0, 8);
    const categories = this._validCats(obj.categories);
    if (!kws.length && !categories) return { ok: false, reason: "no_query" };

    const sourcesRaw = Array.isArray(obj.sources) ? obj.sources : this._splitList(obj.sources);
    const known = ["arxiv", "openalex", "crossref", "europepmc", "pubmed"];
    const sources = sourcesRaw.map((x) => String(x || "").toLowerCase()).filter((x) => known.indexOf(x) >= 0);
    const mode = ["all", "any", "phrase"].indexOf(String(obj.mode || "").toLowerCase()) >= 0
      ? String(obj.mode).toLowerCase() : "any";
    const hm = this._parseTime(obj.dailyTime) || this._parseTime("08:00");
    const freqRaw = String(obj.freq || "").toLowerCase();
    const freq = freqRaw === "weekly" || freqRaw === "manual" ? freqRaw : "daily";
    const age = this._clampAge(obj.maxAgeDays);

    const input = {
      name: String(obj.name || "").trim().slice(0, 40) || (kws.slice(0, 2).join(" / ") || "新订阅"),
      keywords: kws.join(", "),
      categories: categories,
      sources: sources.length ? sources : ["arxiv", "openalex"],
      mode: mode,
      exclude: (Array.isArray(obj.exclude) ? obj.exclude : this._splitList(obj.exclude))
        .map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6).join(", "),
      maxAgeDays: age || 7,
      freq: freq,
      dailyTime: this._hhmm(hm),
      max: 10,
      autoImport: false,
      aiRerank: false,
      aiDigest: false,
      seedProfile: false,
    };
    return {
      ok: true,
      input: input,
      note: "AI 解析结果仅供确认：关键词与分类都可以在预览后手动修改。",
    };
  },

  /**
   * AI 相关性复核（可选）：给前 N 条打 0-100 分 + 一句理由，用于笔记排序与解读。
   * - 只发送标题 + 摘要前 220 字，不发送库内其它内容；
   * - 最多 AI_RERANK_MAX 条，单次调用；失败/超时 → 返回原序，不写入任何状态。
   */
  async aiRerank(sub, entries) {
    const ai = this._ai();
    const st = this.aiStatus();
    if (!ai || !st.ok || !entries || entries.length < 2) return entries;
    const list = entries.slice(0, this.AI_RERANK_MAX);
    const lines = list.map((e, i) => (i + 1) + ". " + String(e.title || "").slice(0, 160)
      + " — " + String(e.summary || "").replace(/\s+/g, " ").slice(0, 220));
    const sys = [
      "你是文献相关性评审。按「订阅主题」给每条论文打 0-100 的相关度，并给一句中文理由（≤24 字）。",
      '只输出 JSON 数组，元素形如 {"i":1,"score":85,"why":"..."}，不要解释、不要代码块。',
    ].join("\n");
    const user = "订阅主题：" + (this._condLine(sub) || sub.name) + "\n\n候选：\n" + lines.join("\n");
    let out = "";
    try { out = await ai.chat([{ role: "system", content: sys }, { role: "user", content: user }]); }
    catch (e) { return entries; }
    const arr = this._extractJson(out, "[", "]");
    if (!Array.isArray(arr)) return entries;
    const byIdx = new Map();
    for (const r of arr) {
      const i = parseInt(r && r.i, 10);
      const s = Math.max(0, Math.min(100, parseInt(r && r.score, 10) || 0));
      if (i >= 1 && i <= list.length) byIdx.set(i - 1, { score: s, why: String((r && r.why) || "").slice(0, 40) });
    }
    if (!byIdx.size) return entries;
    const out2 = entries.map((e, i) => {
      const hit = byIdx.get(i);
      return hit ? Object.assign({}, e, { aiScore: hit.score, aiWhy: hit.why }) : e;
    });
    out2.sort((a, b) => {
      const sa = a.aiScore == null ? -1 : a.aiScore;
      const sb = b.aiScore == null ? -1 : b.aiScore;
      return sb - sa;
    });
    return out2;
  },

  /**
   * AI 速递速览：3-5 条要点（主题脉络 / 值得先看 / 方法共性）。
   * 只发标题 + 摘要前 120 字，最多 AI_DIGEST_MAX 条；失败返回 ""（笔记照常生成）。
   */
  async aiDigest(sub, rows) {
    const ai = this._ai();
    const st = this.aiStatus();
    if (!ai || !st.ok || !rows || !rows.length) return "";
    const list = rows.slice(0, this.AI_DIGEST_MAX);
    const lines = list.map((r, i) => (i + 1) + ". " + String((r.rec && r.rec.title) || "").slice(0, 140)
      + " — " + String((r.rec && r.rec.summary) || "").replace(/\s+/g, " ").slice(0, 120));
    const sys = "你是科研速读助手。根据订阅主题与今日命中论文，写 3-5 条中文要点（每条一行，以「- 」开头，总长 ≤180 字）。"
      + "不要复述标题清单，要提炼主题脉络、值得先看的 1-2 篇、以及方法上的共性；不确定就说不确定。";
    const user = "订阅主题：" + (this._condLine(sub) || sub.name) + "\n\n今日命中：\n" + lines.join("\n");
    try {
      const out = await ai.chat([{ role: "system", content: sys }, { role: "user", content: user }]);
      return String(out || "").trim().slice(0, 1200);
    } catch (e) {
      return "";
    }
  },

  /* ================== 调度（独立 timer，不复用 Scheduler.JOBS） ================== */

  _win() {
    try {
      if (typeof window !== "undefined" && window && typeof window.setInterval === "function") return window;
    } catch (e) { /* 回落主窗口 */ }
    try {
      const w = Zotero.getMainWindow();
      if (w && typeof w.setInterval === "function") return w;
    } catch (e) { /* ignore */ }
    try {
      if (typeof setInterval === "function") return { setInterval: setInterval, clearInterval: clearInterval };
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 启动 60s 轮询（幂等）并立即检查一次 */
  start() {
    if (this._timer) return;
    const w = this._win();
    const self = this;
    if (w) {
      try {
        this._timer = w.setInterval(function () { self._tick("interval"); }, this.CHECK_MS);
      } catch (e) {
        this._log("setInterval failed", e);
        this._timer = null;
      }
    } else {
      this._log("no main window; 订阅轮询未启动（下次启动重试）");
    }
    this._startupCheck = this._tick("startup");
  },

  /** 停止轮询（可重复调用） */
  stop() {
    const id = this._timer;
    this._timer = null;
    if (id == null) return;
    try {
      const w = this._win();
      if (w && typeof w.clearInterval === "function") w.clearInterval(id);
      else if (typeof clearInterval === "function") clearInterval(id);
    } catch (e) { /* ignore */ }
  },

  _tick(reason) {
    const self = this;
    let p;
    try {
      p = Promise.resolve(this.checkDue()).catch(function (e) {
        self._log("checkDue(" + reason + ") failed", e);
        return [];
      });
    } catch (e) {
      this._log("checkDue(" + reason + ") threw", e);
      p = Promise.resolve([]);
    }
    this._lastCheck = p;
    return p;
  },

  /** 今天是否是该订阅的计划日（weekly 用 ISO 1=周一 … 7=周日） */
  _isPlannedDay(sub, at) {
    if (sub.freq === "weekly") {
      const iso = at.getDay() === 0 ? 7 : at.getDay();
      return (sub.weekdays || []).indexOf(iso) >= 0;
    }
    if (sub.freq === "manual") return false;
    return true;
  },

  /**
   * 检查并执行到点订阅。
   * @param {Date|number} [now] 便于测试注入；缺省当前时间
   * @returns {Promise<string[]>} 本次执行的订阅 id（按 pref 顺序）
   *
   * 判定：enabled → 非 manual → 当天计划日 → 当天没跑过 → now ∈ [计划, 计划+6h] → 执行。
   * 先写 lastRun 再执行，避免执行期间下一次 60s 轮询重复触发。
   */
  async checkDue(now) {
    const at = this._dateOf(now);
    const today = this._dayKey(at);
    const nowMin = at.getHours() * 60 + at.getMinutes();
    const done = [];

    for (const sub of this._loadList()) {
      if (!sub.enabled) continue;
      const hm = this._parseTime(sub.dailyTime);
      if (!hm) continue; // 空 / 坏格式 = 仅手动
      if (!this._isPlannedDay(sub, at)) continue;
      if (sub.lastRun === today) continue; // 当天已跑
      if (nowMin < hm.minutes) continue; // 还没到点
      if (nowMin > hm.minutes + this.WINDOW_MIN) continue; // 错过太久，不补跑
      if (this._running[sub.id]) continue; // 上一轮尚未结束

      this._writeLastRun(sub.id, today);
      done.push(sub.id);
      const r = await this.run(sub.id, { now: at, trigger: sub.freq });
      if (!r || !r.ok) this._log("sub failed: " + sub.id + " :: " + ((r && r.reason) || "unknown"));
    }
    return done;
  },

  /* ================== 启动自检（纯本地：不写 pref、不联网、不抛） ================== */

  /**
   * 订阅核心不变量自检，供真机 boot 日志一眼判断「加载是否正常」。
   *
   * 覆盖四个最容易在打包/搬运中悄悄坏掉的点：
   *   fp   —— DOI 指纹归一（去 doi.org 前缀 + 小写）→ 去重的地基；
   *   mig  —— v1（0.53）订阅迁移：无 sources → arxiv、有 dailyTime → daily、enabled 默认 true；
   *   week —— weekly 计划日按 ISO 星期（1=周一）判定；
   *   ttl  —— 推荐缓存 TTL 常量存在且为正。
   *
   * @returns {string} "ok fp=1 mig=1 week=1 ttl=1"，任一项失败则 "FAIL ..."（每项 1/0）
   */
  selfTest() {
    let fp = 0;
    let mig = 0;
    let week = 0;
    let ttl = 0;
    try {
      fp = this._fingerprint({ doi: "https://doi.org/10.1/A" }) === "doi:10.1/a" ? 1 : 0;
    } catch (e) { fp = 0; }
    try {
      const old = this._normSub({ id: "t", name: "v1", keywords: "x", dailyTime: "08:00", max: 10 });
      mig = (Array.isArray(old.sources) && old.sources.length === 1 && old.sources[0] === "arxiv"
        && old.freq === "daily" && old.enabled === true) ? 1 : 0;
    } catch (e) { mig = 0; }
    try {
      // 2026-10-19 是周一（ISO 1）
      week = this._isPlannedDay({ freq: "weekly", weekdays: [1, 3] }, new Date(2026, 9, 19, 8, 0, 0)) ? 1 : 0;
    } catch (e) { week = 0; }
    try {
      ttl = Number(this.RECO_TTL_MS) > 0 ? 1 : 0;
    } catch (e) { ttl = 0; }
    const okAll = fp === 1 && mig === 1 && week === 1 && ttl === 1;
    return (okAll ? "ok" : "FAIL")
      + " fp=" + fp + " mig=" + mig + " week=" + week + " ttl=" + ttl;
  },
};

// 与 related-papers 同款：main.js 装配完成后可直接 Zotero.Papilot.searchSubs 取到
try {
  if (typeof Zotero !== "undefined" && Zotero.Papilot && !Zotero.Papilot.searchSubs) {
    Zotero.Papilot.searchSubs = SearchSubs;
  }
} catch (e) { /* ignore */ }
