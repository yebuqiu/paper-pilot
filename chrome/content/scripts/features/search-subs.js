// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 检索订阅（Saved query → 定时检索 → 自动入库 + 速递笔记）
 *
 * 解决什么：arXiv 有新论文，但「每天手动开 Discovery、改关键词、挑几条入库」这件事
 * 没人愿意天天做。本模块把一条「关键词/分类」检索保存成订阅，按天定时跑一次，
 * 命中的新论文自动入库，并生成一篇「订阅速递」笔记（今天有什么、哪几条是新入库的）。
 *
 * 数据面（两个 pref，均为 JSON 字符串）：
 *   searchSubscriptions  订阅数组，**最新在前**
 *   searchSubsSeen       去重记账 map：fingerprint → { itemID?, at }，LRU 1000
 *
 * 去重双层：
 *   ① 记账（主）：命中 fingerprint 即视为「往期已见」，连网络结果里跨订阅重复也能拦住；
 *      不拉全库，只读一个 pref（O(结果条数)，与库规模无关）。
 *   ② 库内查重（兜底）：仅当记录有 DOI 且 Zotero.Items.getByDOI 存在时调用一次；
 *      getByDOI 不存在 / 抛错时静默跳过（宁可多一条，也不阻塞整次订阅）。
 *
 * 定时语义：与 features/scheduler.js 同款「60s 轮询 + 启动即查」的独立定时器
 * （**不复用 Scheduler.JOBS**，两条线互不影响）：
 *   - 只看 dailyTime（"HH:MM"；空/非法 = 仅手动），lastRun === 今天则跳过；
 *   - 到点后 6 小时窗口内补跑，超过视为错过（避免深夜开机补一堆速递）；
 *   - 先写 lastRun 再执行，配合 _running 守卫，60s 轮询不会重复触发。
 *
 * 纪律：网络/解析/入库失败全部转成返回值（reason），绝不抛给 UI；依赖模块
 * （ArxivFetch / MdLite）缺位时降级；入库单条失败不影响其余条目，也不影响笔记生成。
 */
/* global Zotero, Prefs, ArxivFetch, MdLite */

var SearchSubs = {
  PREF_LIST: "searchSubscriptions",
  PREF_SEEN: "searchSubsSeen",

  /** 轮询间隔（60s，与 Scheduler.CHECK_MS 同节奏） */
  CHECK_MS: 60000,
  /** 到点后的补跑窗口（6 小时，与 Scheduler.WINDOW_MIN 一致） */
  WINDOW_MIN: 360,
  /** 去重记账上限（LRU） */
  MAX_SEEN: 1000,
  /** 单条订阅每次最多取多少条（与 add 的夹紧区间一致） */
  MAX_LIMIT: 30,
  MIN_LIMIT: 1,
  /** 入库标签前缀 */
  TAG_PREFIX: "#订阅/",

  _timer: null,
  _running: {},
  _lastCheck: null,
  _startupCheck: null,

  /* ================== pref 读写（Prefs 缺位时回落 Zotero.Prefs） ================== */

  _prefGet(key, fallback) {
    try {
      if (typeof Prefs !== "undefined" && Prefs && typeof Prefs.get === "function") {
        return Prefs.get(key, fallback);
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

  /** 单条订阅归一：脏 pref / 手工改坏时也能安全使用 */
  _normSub(raw) {
    const r = raw || {};
    const hm = this._parseTime(r.dailyTime);
    return {
      id: String(r.id || ""),
      name: String(r.name == null ? "" : r.name).trim(),
      keywords: String(r.keywords == null ? "" : r.keywords).trim(),
      categories: String(r.categories == null ? "" : r.categories).trim(),
      dailyTime: hm ? this._hhmm(hm) : "",
      max: this._clampMax(r.max),
      autoImport: r.autoImport === undefined ? true : !!r.autoImport,
      lastRun: String(r.lastRun == null ? "" : r.lastRun).trim(),
      createdAt: Number(r.createdAt) || 0,
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

  /**
   * 新建订阅。
   * @param {{name:string, keywords?:string, categories?:string, dailyTime?:string, max?:number, autoImport?:boolean}} input
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
    const hm = this._parseTime(o.dailyTime);
    const sub = {
      id: this._newId(list),
      name: name,
      keywords: keywords,
      categories: categories,
      dailyTime: hm ? this._hhmm(hm) : "",
      max: this._clampMax(o.max),
      autoImport: o.autoImport === undefined ? true : !!o.autoImport,
      lastRun: "",
      createdAt: Date.now(),
    };
    list.unshift(sub);
    if (!this._saveList(list)) return null;
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
    if ("dailyTime" in p) {
      const hm = this._parseTime(p.dailyTime);
      next.dailyTime = hm ? this._hhmm(hm) : "";
    }
    if ("max" in p) next.max = this._clampMax(p.max);
    if ("autoImport" in p) next.autoImport = !!p.autoImport;
    if ("lastRun" in p) next.lastRun = String(p.lastRun == null ? "" : p.lastRun).trim();

    list[idx] = next;
    if (!this._saveList(list)) return null;
    return next;
  },

  /** @returns {boolean} 是否真的删掉了一条 */
  remove(id) {
    const list = this._loadList();
    const next = list.filter(function (s) { return s.id !== id; });
    if (next.length === list.length) return false;
    return this._saveList(next);
  },

  _writeLastRun(id, day) {
    const list = this._loadList();
    for (const sub of list) if (sub.id === id) { sub.lastRun = String(day || ""); break; }
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
   * arXiv 记录 → preprint 条目（**不保存**；纯构造便于单测断言字段）
   * 字段：title / date / creators / abstractNote / url / extra；标签 `#订阅/<name>`。
   */
  _buildItem(rec, subName) {
    const r = rec || {};
    const item = new Zotero.Item("preprint");
    try { item.libraryID = this._libID(); } catch (e) { /* ignore */ }

    const id = this._arxivId(r);
    const abs = String(r.absUrl || (id ? "https://arxiv.org/abs/" + id : "") || "").trim();
    const set = function (f, v) { try { if (v) item.setField(f, v); } catch (e) { /* 该类型无此字段 */ } };
    set("title", String(r.title || "").trim());
    set("date", String(r.publishedDay || this._yearOf(r) || "").trim());
    set("abstractNote", String(r.summary || r.abstractNote || "").trim());
    set("url", abs);
    set("extra", id ? "arXiv: " + id : "");

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

  /** 订阅名归一（0.54.0 审查 P2-10）：去换行/控制字符、`/`→`-`、限 24 字，防标签树被意外分层 */
  _safeName(name) {
    let s = String(name == null ? "" : name)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[\/\:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    if (s.length > 24) s = s.slice(0, 24);
    return s || "未命名订阅";
  },

  /** 逗号/分号/换行分隔 → 数组（categories 必需；keywords 同样受益，便于多词 AND） */
  _splitList(raw) {
    return String(raw == null ? "" : raw)
      .split(/[,;，；\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  },

  _spec(sub) {
    return {
      keywords: this._splitList(sub.keywords),
      categories: this._splitList(sub.categories),
      // 多分类是「并集」语义：订阅 cs.LG, cs.CL 应看到两个分类的新论文
      categoryMode: "OR",
    };
  },

  _statusText(status) {
    if (status === "added") return "新入库";
    if (status === "dup") return "已在库";
    if (status === "failed") return "入库失败";
    return "未入库";
  },

  _noteMd(sub, rows, counts, at) {
    const lines = [];
    const cond = [];
    if (sub.keywords) cond.push("关键词：" + sub.keywords);
    if (sub.categories) cond.push("分类：" + sub.categories);
    if (cond.length) lines.push(cond.join(" · "));
    lines.push("共 " + rows.length + " 条结果 · 新入库 " + counts.added
      + " · 跳过 " + counts.skipped + " · 失败 " + counts.failed);

    // 空态：所有结果都是「已在库」（本次没有任何新内容可看）
    const anyNew = rows.some(function (r) { return r.status !== "dup"; });
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
        line += " · " + this._statusText(row.status);
        lines.push(line);
      }, this);
    }
    lines.push("");
    lines.push("> 由 Papilot 订阅检索生成于 " + this._stamp(at) + "。");
    return lines.join("\n");
  },

  /**
   * 执行一次订阅。
   * @param {string} id
   * @param {{noNote?:boolean, now?:Date|number}} [opts]
   * @returns {Promise<{ok:boolean, added:number, skipped:number, failed:number,
   *                    reason?:string, noteTitle?:string}>}
   *   reason: no_sub / no_arxiv / network / empty / busy
   */
  async run(id, opts) {
    const o = opts || {};
    const at = this._dateOf(o.now);
    const zero = { added: 0, skipped: 0, failed: 0 };
    const sub = this._find(id);
    if (!sub) return Object.assign({ ok: false, reason: "no_sub" }, zero);
    const AF = this._arxiv();
    if (!AF) return Object.assign({ ok: false, reason: "no_arxiv" }, zero);
    if (this._running[id]) return Object.assign({ ok: false, reason: "busy" }, zero);

    this._running[id] = true;
    let added = 0;
    let skipped = 0;
    let failed = 0;
    try {
      const limit = this._clampMax(sub.max);
      let res = null;
      try {
        res = await AF.search(this._spec(sub), {
          limit: limit,
          sortBy: "submittedDate",
          sortOrder: "descending",
        });
      } catch (e) {
        this._log("search failed: " + sub.name, e);
        return Object.assign({ ok: false, reason: "network" }, { added: 0, skipped: 0, failed: 0 });
      }
      if (res && res.ok === false) {
        return Object.assign({ ok: false, reason: res.reason || "network" }, { added: 0, skipped: 0, failed: 0 });
      }
      const entries = (res && Array.isArray(res.entries)) ? res.entries.slice(0, limit) : [];
      if (!entries.length) {
        return Object.assign({ ok: false, reason: "empty" }, { added: 0, skipped: 0, failed: 0 });
      }

      const seen = this._seenLoad();
      const stamp = at.getTime();
      const rows = [];

      for (const rec of entries) {
        const fp = this._fingerprint(rec);
        let status = "";
        let itemID = null;

        if (fp && seen[fp]) {
          skipped++;
          status = "dup";
          itemID = seen[fp].itemID == null ? null : seen[fp].itemID;
          this._seenTouch(seen, fp, stamp);
        } else {
          const doi = this._cleanDOI(rec && (rec.doi || rec.DOI || (rec.links && rec.links.doi)));
          const exist = doi ? await this._findByDOI(doi) : null;
          if (exist) {
            skipped++;
            status = "dup";
            itemID = exist.id == null ? null : exist.id;
            if (fp) this._seenPut(seen, fp, itemID, stamp);
          } else if (sub.autoImport) {
            let item = null;
            try {
              item = this._buildItem(rec, sub.name);
              await item.saveTx();
              added++;
              status = "added";
              itemID = item.id == null ? null : item.id;
              if (fp) this._seenPut(seen, fp, itemID, stamp);
            } catch (e) {
              // 单条失败不中断整次订阅；不记账，下次运行会重试
              failed++;
              status = "failed";
              this._log("import failed: " + String((rec && rec.title) || ""), e);
            }
          } else {
            status = "skipped";
            if (fp) this._seenPut(seen, fp, null, stamp);
          }
        }

        rows.push({ rec: rec, status: status, itemID: itemID });
      }

      this._seenSave(seen);

      const counts = { added: added, skipped: skipped, failed: failed };
      const out = { ok: true, added: added, skipped: skipped, failed: failed };
      if (!o.noNote) {
        const title = "订阅速递：" + sub.name + " " + this._dayKey(at);
        try {
          await this._saveNote(title, this._noteMd(sub, rows, counts, at));
          out.noteTitle = title;
        } catch (e) {
          this._log("note save failed: " + sub.name, e);
        }
      }
      return out;
    } catch (e) {
      // 兜底：任何未预期异常都以 network 语义返回，绝不抛给调用方
      this._log("run(" + id + ") failed", e);
      return { ok: false, reason: "network", added: added, skipped: skipped, failed: failed };
    } finally {
      delete this._running[id];
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

  /**
   * 检查并执行到点订阅。
   * @param {Date|number} [now] 便于测试注入；缺省当前时间
   * @returns {Promise<string[]>} 本次执行的订阅 id（按 pref 顺序）
   *
   * 判定：dailyTime 非空且合法 → 当天没跑过 → now ∈ [计划, 计划+6h] → 执行。
   * 先写 lastRun 再执行，避免执行期间下一次 60s 轮询重复触发。
   */
  async checkDue(now) {
    const at = this._dateOf(now);
    const today = this._dayKey(at);
    const nowMin = at.getHours() * 60 + at.getMinutes();
    const done = [];

    for (const sub of this._loadList()) {
      const hm = this._parseTime(sub.dailyTime);
      if (!hm) continue; // 空 / 坏格式 = 仅手动
      if (sub.lastRun === today) continue; // 当天已跑
      if (nowMin < hm.minutes) continue; // 还没到点
      if (nowMin > hm.minutes + this.WINDOW_MIN) continue; // 错过太久，不补跑
      if (this._running[sub.id]) continue; // 上一轮尚未结束

      this._writeLastRun(sub.id, today);
      done.push(sub.id);
      const r = await this.run(sub.id, { now: at });
      if (!r || !r.ok) this._log("sub failed: " + sub.id + " :: " + ((r && r.reason) || "unknown"));
    }
    return done;
  },
};

// 与 related-papers 同款：main.js 装配完成后可直接 Zotero.Papilot.searchSubs 取到
try {
  if (typeof Zotero !== "undefined" && Zotero.Papilot && !Zotero.Papilot.searchSubs) {
    Zotero.Papilot.searchSubs = SearchSubs;
  }
} catch (e) { /* ignore */ }
