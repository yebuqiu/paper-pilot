/* PaperPilot 定时任务（研究晨报 / 阅读周报 / 库体检）
 *
 * 为什么不用系统 cron：Zotero 插件没有系统级定时器，只有主窗口的 setInterval。
 * 所以这里用「60s 轮询 + 启动时立即检查一次」的轻量模型：
 *   - 每秒/每分只做 pref 字符串比较（纯计算），不扫库、不发网络请求；
 *   - 命中到点任务才真正执行，执行完写 scheduleLastRun 防当天重复；
 *   - 错过太久（> 6 小时）不补跑：避免用户深夜开机被补生成一堆报告。
 *
 * 所有任务都在后台跑（只生成笔记），不依赖任何窗口 / 选区：
 *   digest  最近 24 小时新增条目 → 清单笔记（上限 30 条，0 条写空态文案）
 *   weekly  近 7 天阅读统计（ReadingStats） + 库概况 → 周报笔记
 *   health  无附件 / 缺 DOI / 疑似重复标题（MetaLint 可用时附加可规范化项）→ 体检笔记
 *
 * 纪律：
 *   - 任务内部全量 try/catch，失败只写日志（_diag / logError），绝不弹窗、绝不阻塞主线程；
 *   - 依赖模块缺位时降级（ReadingStats / ReadingProgress / MetaLint / MdLite 都可缺席）；
 *   - start() 幂等：重复调用不叠加 interval（设置面板切换 / 主窗口重建都可能再调）。
 *
 * 已知语义（与集成方约定）：PREF_TIME 只表达「每天 HH:MM」，没有 weekday 字段。
 * 所以 weekly / health 实际是「当天该时刻首次被看到就跑」——契约只给了这一点，
 * 本模块不擅自发明「每周只跑一次」的隐式规则（那会让 checkDue 的判定不可预期）。
 * 若产品上要严格按周，需再加 `scheduleWeeklyDay` / `scheduleHealthDay` pref 并在
 * checkDue 里多一个 weekday 比较；当前实现保持契约最小面。
 */
/* global Zotero, Prefs, MdLite, ReadingStats, ReadingProgress, MetaLint */

var Scheduler = {
  /* ================== 契约常量 ================== */

  JOBS: [
    { id: "digest", label: "每日研究晨报", desc: "每天固定时间生成最近新增文献清单笔记" },
    { id: "weekly", label: "每周阅读周报", desc: "每周固定时间汇总阅读统计为笔记" },
    { id: "health", label: "每周库体检", desc: "每周固定时间跑库健康检查并生成报告笔记" },
  ],

  PREF_TIME: {
    digest: "scheduleDailyDigest",
    weekly: "scheduleWeeklyReport",
    health: "scheduleLibHealth",
  },

  PREF_LAST: "scheduleLastRun",

  /** 轮询间隔（60s） */
  CHECK_MS: 60000,
  /** 到点后允许补跑的时间窗（6 小时）；超过视为错过 */
  WINDOW_MIN: 360,
  /** 清单类报告单节最多列多少条 */
  MAX_LIST: 30,
  /** 体检明细每类最多列多少条 */
  MAX_ISSUES: 10,

  _timer: null,
  _running: {},
  _lastCheck: null,
  _startupCheck: null,
  _collCache: {},

  /* ================== pref 读写（Prefs 缺位时回落 Zotero.Prefs） ================== */

  _prefGet(key, fallback) {
    try {
      if (typeof Prefs !== "undefined" && Prefs && typeof Prefs.get === "function") {
        return Prefs.get(key, fallback);
      }
    } catch (e) { /* 走 Zotero.Prefs 回落 */ }
    try {
      const v = Zotero.Prefs.get("extensions.zotero.paperpilot." + key, true);
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
      Zotero.Prefs.set("extensions.zotero.paperpilot." + key, value, true);
      return true;
    } catch (e) {
      this._log("pref write failed: " + key, e);
      return false;
    }
  },

  /* ================== 日志（静默，永不抛） ================== */

  _log(msg, err) {
    let text = "scheduler: " + msg;
    if (err) text += " :: " + ((err && (err.stack || err.message)) || err);
    try {
      if (Zotero && Zotero.PaperPilot && typeof Zotero.PaperPilot._diag === "function") {
        const r = Zotero.PaperPilot._diag(text);
        if (r && typeof r.catch === "function") r.catch(function () { /* ignore */ });
      } else if (Zotero && typeof Zotero.logError === "function") {
        Zotero.logError(new Error("PaperPilot " + text));
      }
    } catch (e) { /* ignore */ }
    try { if (Zotero && typeof Zotero.debug === "function") Zotero.debug("PaperPilot " + text); }
    catch (e) { /* ignore */ }
  },

  /* ================== 时间工具 ================== */

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

  /** ISO 周序号（周报标题用） */
  _isoWeek(d) {
    const dt = this._dateOf(d);
    const t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const dow = t.getDay() || 7;
    t.setDate(t.getDate() + 4 - dow); // 移到本周周四
    const year = t.getFullYear();
    const yearStart = new Date(year, 0, 1);
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return { year: year, week: week };
  },

  /* ================== 上次运行记录 ================== */

  _lastRunMap() {
    let raw = "";
    try { raw = String(this._prefGet(this.PREF_LAST, "") || ""); } catch (e) { raw = ""; }
    if (!raw) return {};
    try {
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object" || Array.isArray(o)) return {};
      return o;
    } catch (e) {
      return {};
    }
  },

  /** 先记账再执行：即使任务失败也不会在 60s 后反复重试同一任务 */
  _markRun(jobId, day) {
    const map = this._lastRunMap();
    map[jobId] = day;
    this._prefSet(this.PREF_LAST, JSON.stringify(map));
  },

  /* ================== 调度 ================== */

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
      this._log("no main window; 定时轮询未启动（下次启动重试）");
    }
    this._startupCheck = this._tick("startup");
  },

  /** 停止轮询（卸载 / 禁用插件时调用；可重复调用） */
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
   * 检查并执行到点任务。
   * @param {Date|number} [now] 便于测试注入；缺省当前时间
   * @returns {Promise<string[]>} 本次执行的 jobId（按 JOBS 顺序）
   *
   * 判定：时间单非空且合法 → 当天没跑过 → now ∈ [计划, 计划+6h] → 执行。
   * 先写 lastRun 再执行，避免执行期间下一次轮询重复触发。
   */
  async checkDue(now) {
    const at = this._dateOf(now);
    const today = this._dayKey(at);
    const nowMin = at.getHours() * 60 + at.getMinutes();
    const done = [];

    for (const job of this.JOBS) {
      let raw = "";
      try { raw = String(this._prefGet(this.PREF_TIME[job.id], "") || "").trim(); }
      catch (e) { raw = ""; }
      const hm = this._parseTime(raw);
      if (!hm) continue; // 空 / 坏格式 = 关闭该任务

      if (this._lastRunMap()[job.id] === today) continue; // 当天已跑
      if (nowMin < hm.minutes) continue; // 还没到点
      if (nowMin > hm.minutes + this.WINDOW_MIN) continue; // 错过太久，不补跑
      if (this._running[job.id]) continue; // 上一轮尚未结束

      this._markRun(job.id, today);
      done.push(job.id);
      const r = await this.runJob(job.id, at);
      if (!r || !r.ok) this._log("job failed: " + job.id + " :: " + ((r && r.error) || "unknown"));
    }
    return done;
  },

  /**
   * 立即执行单个任务（不做时间判断、不写 lastRun）。
   * @param {string} id
   * @param {Date|number} [at] 仅测试/内部传时用；缺省当前时间
   * @returns {Promise<{ok:boolean, noteTitle?:string, error?:string}>}
   */
  async runJob(id, at) {
    const known = this.JOBS.some(function (j) { return j.id === id; });
    if (!known) return { ok: false, error: "unknown job: " + id };
    if (this._running[id]) return { ok: false, error: "job already running: " + id };
    const now = this._dateOf(at);
    this._running[id] = true;
    try {
      let noteTitle;
      if (id === "digest") noteTitle = await this._jobDigest(now);
      else if (id === "weekly") noteTitle = await this._jobWeekly(now);
      else noteTitle = await this._jobHealth(now);
      return { ok: true, noteTitle: noteTitle };
    } catch (e) {
      this._log("runJob(" + id + ") failed", e);
      return { ok: false, error: String((e && (e.message || e)) || e) };
    } finally {
      delete this._running[id];
    }
  },

  /** 设置面板渲染数据 */
  state() {
    const last = this._lastRunMap();
    const self = this;
    return this.JOBS.map(function (j) {
      let raw = "";
      try { raw = String(self._prefGet(self.PREF_TIME[j.id], "") || "").trim(); }
      catch (e) { raw = ""; }
      return {
        id: j.id,
        label: j.label,
        time: raw,
        enabled: !!self._parseTime(raw),
        lastRun: String(last[j.id] || ""),
      };
    });
  },

  /* ================== 库访问（防御式） ================== */

  _libID() {
    try {
      const id = Zotero.Libraries.userLibraryID;
      if (typeof id === "number") return id;
    } catch (e) { /* ignore */ }
    return 1;
  },

  /** 全库常规条目（Zotero 10 的 Items.getAll 是 async；只取顶层，天然排除附件/笔记） */
  async _regularItems() {
    const out = [];
    let raw = null;
    try {
      raw = await Zotero.Items.getAll(this._libID(), true, false, false);
    } catch (e) {
      this._log("Items.getAll failed", e);
      return out;
    }
    for (const it of raw || []) {
      try {
        if (!it || it.deleted) continue;
        if (typeof it.isRegularItem === "function" && !it.isRegularItem()) continue;
        out.push(it);
      } catch (e) { /* 跳过坏条目 */ }
    }
    return out;
  },

  /**
   * 0.54.0（审查 P1-5）：只取最近 N 小时新增条目——走 Zotero.Search 的 dateAdded 条件，
   * 避免晨报每天把全库条目对象一次性物化（大库数十万对象 → 数百 MB 峰值 + 数秒卡顿）。
   * Search 不可用（老版本/桩环境）时回退全量 + 内存过滤。
   */
  async _recentItems(hours, refDate) {
    const span = Math.max(1, Number(hours) || 24);
    const ref = (refDate instanceof Date && !isNaN(refDate.getTime())) ? refDate : new Date();
    const since = new Date(ref.getTime() - span * 3600 * 1000);
    let ids = null;
    try {
      const s = new Zotero.Search();
      s.libraryID = this._libID();
      s.addCondition("dateAdded", "isAfter", Zotero.Date.dateToSQL(since, true));
      ids = await s.search();
    } catch (e) { ids = null; }
    if (!Array.isArray(ids)) {
      const all = await this._regularItems();
      const cutoff = since.getTime();
      return all.filter((it) => {
        const t = this._dateAdded(it);
        return t && t.getTime() >= cutoff;
      });
    }
    const out = [];
    for (const id of ids) {
      let it = null;
      try {
        it = (typeof Zotero.Items.getAsync === "function")
          ? await Zotero.Items.getAsync(id) : Zotero.Items.get(id);
      } catch (e) { continue; }
      if (!it || it.deleted) continue;
      try { if (typeof it.isRegularItem === "function" && !it.isRegularItem()) continue; }
      catch (e) { continue; }
      out.push(it);
    }
    return out;
  },

  /**
   * 0.54.0（审查 P1-5）：分批迭代全库常规条目（每批 300，批间让出事件循环）。
   * 体检/周报不再一次性持有全部条目对象，内存峰值与库大小解耦。
   */
  async *_iterItems(batch) {
    const size = Math.max(50, Number(batch) || 300);
    let ids = null;
    try {
      const s = new Zotero.Search();
      s.libraryID = this._libID();
      s.addCondition("itemType", "isNot", "attachment");
      s.addCondition("itemType", "isNot", "note");
      ids = await s.search();
    } catch (e) { ids = null; }
    if (!Array.isArray(ids)) {
      const all = await this._regularItems();
      for (const it of all) yield it;
      return;
    }
    for (let i = 0; i < ids.length; i += size) {
      const chunk = ids.slice(i, i + size);
      let loaded = [];
      try {
        loaded = await Promise.all(chunk.map((id) => (
          typeof Zotero.Items.getAsync === "function"
            ? Zotero.Items.getAsync(id) : Zotero.Items.get(id))));
      } catch (e) { loaded = []; }
      for (const it of loaded) {
        if (!it || it.deleted) continue;
        try { if (typeof it.isRegularItem === "function" && !it.isRegularItem()) continue; }
        catch (e) { continue; }
        yield it;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  },

  /** dateAdded → Date。库内是 UTC SQL 时间（"YYYY-MM-DD HH:MM:SS"），不能按本地时间解析 */
  _dateAdded(item) {
    let v = null;
    try { v = item && item.dateAdded; } catch (e) { v = null; }
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (!v) return null;
    const s = String(v).trim();
    try {
      if (Zotero.Date && typeof Zotero.Date.sqlToDate === "function") {
        const d = Zotero.Date.sqlToDate(s, true);
        if (d instanceof Date && !isNaN(d.getTime())) return d;
      }
    } catch (e) { /* 回落手写解析 */ }
    const norm = s.replace(" ", "T");
    const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(norm) ? norm : norm + "Z";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  },

  _title(item) {
    let t = "";
    try {
      t = typeof item.getDisplayTitle === "function" ? item.getDisplayTitle() : "";
      if (!t) t = item.getField("title") || "";
    } catch (e) { t = ""; }
    t = String(t || "").replace(/\s+/g, " ").trim();
    return t || "(无标题)";
  },

  _year(item) {
    let s = "";
    try { s = String(item.getField("date") || ""); } catch (e) { s = ""; }
    const m = s.match(/(\d{4})/);
    return m ? m[1] : "";
  },

  _creatorLine(item) {
    let cs = [];
    try { cs = item.getCreators() || []; } catch (e) { cs = []; }
    const names = [];
    for (const c of cs) {
      const n = String((c && (c.name || [c.lastName, c.firstName].filter(Boolean).join(" "))) || "").trim();
      if (n) names.push(n);
    }
    if (!names.length) return "";
    if (names.length <= 3) return names.join(", ");
    return names.slice(0, 3).join(", ") + " 等";
  },

  _collectionLine(item) {
    let ids = [];
    try { ids = item.getCollections() || []; } catch (e) { ids = []; }
    const names = [];
    for (const id of ids) {
      let name = this._collCache[id];
      if (!name) {
        try {
          const c = Zotero.Collections.get(id);
          name = c && c.name ? String(c.name) : "";
        } catch (e) { name = ""; }
        if (name) this._collCache[id] = name;
      }
      if (name && names.indexOf(name) < 0) names.push(name);
    }
    if (!names.length) return "";
    return names.slice(0, 2).join(" / ") + (names.length > 2 ? " 等" : "");
  },

  /** 标题归一化（去空白/标点/符号 + 小写）：用于疑似重复检测，只是粗筛 */
  _normTitle(t) {
    return String(t || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  },

  /* ================== 生成笔记 ================== */

  _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  /** 与 chat-float.saveHistoryAsNote → Notes.createFromMarkdown 同一条链路：Markdown → 笔记 HTML */
  _noteHtml(title, md) {
    if (typeof MdLite !== "undefined" && MdLite && typeof MdLite.toNoteHtml === "function") {
      try { return MdLite.toNoteHtml(title, md); } catch (e) { /* 回落 */ }
    }
    return "<h2>" + this._esc(title) + "</h2><pre>" + this._esc(md) + "</pre>";
  },

  /** 库根目录独立笔记（同 ReadingStats.run 的建笔记方式） */
  async _saveNote(title, md) {
    const note = new Zotero.Item("note");
    note.libraryID = this._libID();
    note.setNote(this._noteHtml(title, md));
    await note.saveTx();
    return title;
  },

  /* ================== 任务 1：研究晨报 ================== */

  async _jobDigest(now) {
    const at = this._dateOf(now);
    const title = "研究晨报 " + this._dayKey(at);
    // 0.54.0（审查 P1-5）：只取最近 24h（Search 服务端过滤），不再全库物化
    const items = await this._recentItems(24, at);
    const cutoff = at.getTime() - 24 * 3600 * 1000;
    const recent = [];
    for (const it of items) {
      const t = this._dateAdded(it);
      if (t && t.getTime() >= cutoff) recent.push({ item: it, at: t });
    }
    recent.sort(function (a, b) { return b.at.getTime() - a.at.getTime(); });

    if (!recent.length) {
      const md = "**今日无新增文献**（过去 24 小时）。\n\n"
        + "> 由 PaperPilot 定时任务生成于 " + this._stamp(at) + "。";
      return await this._saveNote(title, md);
    }

    const lines = [];
    lines.push("过去 24 小时新增 **" + recent.length + "** 篇文献"
      + (recent.length > this.MAX_LIST ? "（下列前 " + this.MAX_LIST + " 篇）" : "") + "。");
    lines.push("");
    lines.push("## 新增文献");
    const shown = recent.slice(0, this.MAX_LIST);
    for (let i = 0; i < shown.length; i++) {
      const it = shown[i].item;
      const t = this._title(it);
      const creators = this._creatorLine(it);
      const year = this._year(it);
      const coll = this._collectionLine(it);
      let line = (i + 1) + ". **" + t + "**";
      if (creators) line += " — " + creators;
      if (year) line += " (" + year + ")";
      if (coll) line += " · 分类：" + coll;
      lines.push(line);
    }
    lines.push("");
    lines.push("> 由 PaperPilot 定时任务生成于 " + this._stamp(at) + "。");
    return await this._saveNote(title, lines.join("\n"));
  },

  /* ================== 任务 2：阅读周报 ================== */

  async _jobWeekly(now) {
    const at = this._dateOf(now);
    const wk = this._isoWeek(at);
    const title = "阅读周报 " + wk.year + "-W" + String(wk.week).padStart(2, "0");
    const lines = [];
    let rs = null;
    try { rs = (typeof ReadingStats !== "undefined") ? ReadingStats : null; } catch (e) { rs = null; }

    lines.push("## 阅读时长（近 7 天）");
    if (rs && typeof rs.load === "function" && typeof rs.aggregate === "function") {
      let agg = null;
      try { agg = rs.aggregate(rs.load(), 7); } catch (e) { agg = null; }
      if (agg) {
        const human = function (min) {
          try { return typeof rs.human === "function" ? rs.human(min) : (Math.round(Number(min) || 0) + " 分钟"); }
          catch (e) { return (Math.round(Number(min) || 0) + " 分钟"); }
        };
        lines.push("- 总时长：**" + human(agg.totalMin) + "**");
        lines.push("- 有记录天数：" + (agg.activeDays || 0) + " 天");
        lines.push("- 日均（按有记录天数）：" + human(agg.avgPerActiveDay || 0));
        const active = (agg.perDay || []).filter(function (d) { return d.min > 0; });
        if (active.length) {
          lines.push("");
          lines.push("## 每日时长");
          for (const d of active.slice().reverse()) lines.push("- " + d.day + "：" + human(d.min));
        }
      } else {
        lines.push("阅读统计数据读取失败（已跳过时长明细）。");
      }
    } else {
      lines.push("阅读统计模块未就绪，本次仅输出库概况。");
    }

    // 阅读进度（可选）：不扫全库，只数 ReadingProgress 快照里的条目
    let rp = null;
    try { rp = (typeof ReadingProgress !== "undefined") ? ReadingProgress : null; } catch (e) { rp = null; }
    if (rp && typeof rp.snapshot === "function") {
      try {
        const snap = rp.snapshot() || {};
        let entries = 0;
        let finished = 0;
        for (const k of Object.keys(snap)) {
          const e = snap[k];
          if (!e) continue;
          entries++;
          if (typeof rp.compute === "function") {
            const p = rp.compute({ minutes: e.t, page: e.p, pages: 0 });
            if (p && p.pct >= 0.95) finished++;
          }
        }
        if (entries) lines.push("- 有阅读进度记录：" + entries + " 篇；读完（≥95%）：" + finished + " 篇");
      } catch (e) { /* 进度模块异常不影响周报 */ }
    }

    // 0.54.0（审查 P1-5）：分批迭代计数，不再一次性持有全库对象
    const month = this._dayKey(at).slice(0, 7);
    let addedThisMonth = 0;
    let totalItems = 0;
    for await (const it of this._iterItems()) {
      totalItems++;
      let d = "";
      try { d = String(it.dateAdded || ""); } catch (e) { d = ""; }
      if (d.slice(0, 7) === month) addedThisMonth++;
    }
    lines.push("");
    lines.push("## 库概况");
    lines.push("- 条目总数：" + totalItems);
    lines.push("- 本月新增：" + addedThisMonth);
    lines.push("");
    lines.push("> 由 PaperPilot 定时任务生成于 " + this._stamp(at) + "。");
    return await this._saveNote(title, lines.join("\n"));
  },

  /* ================== 任务 3：库体检 ================== */

  async _jobHealth(now) {
    const at = this._dateOf(now);
    const title = "库体检报告 " + this._dayKey(at);
    // 0.54.0（审查 P1-5）：分批读取（内存与库大小解耦；每批 300 后让出事件循环）
    const items = this._iterItems();

    const noAtt = [];
    const noDoi = [];
    const lint = [];
    const dupMap = new Map();
    let lintMod = null;
    try { lintMod = (typeof MetaLint !== "undefined") ? MetaLint : null; } catch (e) { lintMod = null; }

    let totalItems = 0;
    for await (const it of items) {
      totalItems++;
      const t = this._title(it);
      let atts = 0;
      try { atts = typeof it.getAttachments === "function" ? (it.getAttachments() || []).length : 0; }
      catch (e) { atts = 0; }
      if (!atts) noAtt.push(t);

      let doi = "";
      try { doi = String(it.getField("DOI") || "").trim(); } catch (e) { doi = ""; }
      if (!doi) noDoi.push(t);

      const key = this._normTitle(t);
      if (key.length >= 6) {
        const arr = dupMap.get(key) || [];
        arr.push(t);
        dupMap.set(key, arr);
      }

      if (lintMod && typeof lintMod.scan === "function") {
        try {
          const hits = lintMod.scan(it) || [];
          if (hits.length) {
            const fields = [];
            for (const h of hits) if (fields.indexOf(h.field) < 0) fields.push(h.field);
            lint.push(t + "（" + fields.join("、") + "）");
          }
        } catch (e) { /* 单条 lint 失败跳过 */ }
      }
    }

    const dupGroups = [];
    dupMap.forEach(function (arr) { if (arr.length > 1) dupGroups.push(arr); });
    dupGroups.sort(function (a, b) { return b.length - a.length; });

    const self = this;
    const section = function (head, list, emptyText) {
      const out = ["", "## " + head];
      if (!list.length) {
        out.push(emptyText || "未发现。");
        return out.join("\n");
      }
      const shown = list.slice(0, self.MAX_ISSUES);
      shown.forEach(function (x, i) { out.push((i + 1) + ". " + x); });
      if (list.length > shown.length) out.push("- 其余 " + (list.length - shown.length) + " 条未列出。");
      return out.join("\n");
    };

    const lines = [];
    lines.push("## 概览");
    lines.push("- 常规条目：" + totalItems);
    lines.push("- 无附件：" + noAtt.length);
    lines.push("- 缺 DOI：" + noDoi.length);
    lines.push("- 疑似重复标题：" + dupGroups.length + " 组");
    if (lintMod && typeof lintMod.scan === "function") {
      lines.push("- 可规范化元数据：" + lint.length + " 条");
    }
    lines.push("");
    lines.push(section("无附件（前 " + this.MAX_ISSUES + "）", noAtt, "所有条目都有附件。"));
    lines.push("");
    lines.push(section("缺 DOI（前 " + this.MAX_ISSUES + "）", noDoi, "所有条目都有 DOI。"));
    lines.push("");
    const dupLines = dupGroups.map(function (arr) { return "《" + arr[0] + "》— " + arr.length + " 条"; });
    lines.push(section("疑似重复标题（前 " + this.MAX_ISSUES + " 组）", dupLines, "未发现标题重复的条目。"));
    if (lintMod && typeof lintMod.scan === "function") {
      lines.push("");
      lines.push(section("可规范化元数据（MetaLint，前 " + this.MAX_ISSUES + "）", lint, "元数据格式规范。"));
    }
    lines.push("");
    lines.push("> 说明：无附件 / 缺 DOI / 重复标题均为粗筛，请按需人工确认；"
      + "由 PaperPilot 定时任务生成于 " + this._stamp(at) + "。");
    return await this._saveNote(title, lines.join("\n"));
  },
};
