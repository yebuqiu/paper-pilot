/* PaperPilot 阅读行为统计（0.23.0，路线图阶段 2 第二批）
 * PaperPilot 有「阅读状态」（未读/在读/已读），但没有任何「阅读行为」数据。
 * 本模块补这一块：阅读时长 → 日历热力图 → 阅读报告，既是粘性功能，也能反过来
 * 支撑 AI（「我最近读的这几篇有什么共同点」）。
 *
 * 采集方式：**心跳**而非事件。每分钟检查一次「当前焦点的阅读器属于哪篇文献」，
 * 命中则给该条目 +1 分钟。这样即使某些 Zotero 版本不派发 tab 事件
 * （项目记忆：tab 事件在部分版本未实证），统计依然可用——比依赖 open/close
 * 事件配对更稳，也不会出现「打开后没关=统计出一个 8 小时的假时长」。
 *
 * 存储：pref `readingStats`（JSON，仅保留最近 N 天）——避免引入文件 IO 与
 * 迁移成本；按 60 天 × 每篇 1 个整数计，体积可控（实测格式见 _empty()）。
 *
 * 隐私：全部数据只在本机 pref 内，不上传、不参与任何网络请求。
 */
/* global Zotero, Services, Prefs, I18n */

var ReadingStats = {
  KEEP_DAYS: 60,
  _timer: null,

  /* ================== 存储（纯函数） ================== */

  _empty() { return { schema: 1, days: {} }; },

  /** JSON 字符串 → store（容错：任何异常都回到空结构，绝不因脏数据卡死启动） */
  parse(raw) {
    try {
      const o = JSON.parse(String(raw || ""));
      if (!o || typeof o !== "object" || !o.days || typeof o.days !== "object") return this._empty();
      return { schema: 1, days: o.days };
    } catch (e) {
      return this._empty();
    }
  },

  stringify(store) {
    try { return JSON.stringify(store || this._empty()); } catch (e) { return JSON.stringify(this._empty()); }
  },

  load() { return this.parse(Prefs.get("readingStats", "")); },

  save(store) {
    try { Prefs.set("readingStats", this.stringify(store)); } catch (e) { Zotero.logError(e); }
  },

  /** 累加某天某条目的阅读分钟（纯函数，返回新 store） */
  bump(store, day, key, minutes) {
    const s = store && store.days ? store : this._empty();
    const d = s.days[day] || {};
    const m = Number(minutes) || 1;
    d[key] = (Number(d[key]) || 0) + m;
    s.days[day] = d;
    return s;
  },

  /** 只保留最近 keepDays 天（含今天），其余丢弃 */
  prune(store, today, keepDays) {
    const s = store && store.days ? store : this._empty();
    const keep = new Set();
    const base = this.parseDay(today) || new Date();
    for (let i = 0; i < (keepDays || this.KEEP_DAYS); i++) {
      const d = new Date(base.getTime() - i * 86400000);
      keep.add(this.dayKey(d));
    }
    const days = {};
    for (const k of Object.keys(s.days)) if (keep.has(k)) days[k] = s.days[k];
    return { schema: 1, days };
  },

  /* ================== 日期工具（纯函数） ================== */

  /** 本地日期键 YYYY-MM-DD（不用 toISOString，避免时区把晚上的记录算到前一天） */
  dayKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const p = (n) => String(n).padStart(2, "0");
    return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
  },

  parseDay(dayStr) {
    const m = String(dayStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  },

  today() { return this.dayKey(new Date()); },

  /* ================== 聚合（纯函数） ================== */

  /**
   * @param {object} store
   * @param {number} days 统计最近多少天
   * @param {number} [nowMs] 便于测试注入
   * @returns {{totalMin:number, perDay:Array<{day:string,min:number}>, topItems:Array<{key:string,min:number}>, activeDays:number, avgPerActiveDay:number}}
   */
  aggregate(store, days, nowMs) {
    const s = store && store.days ? store : this._empty();
    const n = Math.max(1, Number(days) || 7);
    const base = new Date(nowMs != null ? nowMs : Date.now());
    const perDay = [];
    const itemTotals = new Map();
    let total = 0;
    for (let i = n - 1; i >= 0; i--) {
      const day = this.dayKey(new Date(base.getTime() - i * 86400000));
      const rec = s.days[day] || {};
      let min = 0;
      for (const k of Object.keys(rec)) {
        const v = Number(rec[k]) || 0;
        min += v;
        itemTotals.set(k, (itemTotals.get(k) || 0) + v);
      }
      total += min;
      perDay.push({ day, min });
    }
    const topItems = [...itemTotals.entries()]
      .map(([key, min]) => ({ key, min }))
      .sort((a, b) => (b.min - a.min) || a.key.localeCompare(b.key));
    const activeDays = perDay.filter((d) => d.min > 0).length;
    return {
      totalMin: total,
      perDay,
      topItems,
      activeDays,
      avgPerActiveDay: activeDays ? Math.round(total / activeDays) : 0,
    };
  },

  /** 分钟 → 热力等级 0..4 */
  level(min) {
    const m = Number(min) || 0;
    if (m <= 0) return 0;
    if (m < 15) return 1;
    if (m < 30) return 2;
    if (m < 60) return 3;
    return 4;
  },

  /**
   * 生成日历热力图数据（按周对齐，GitHub 风格）
   * @returns {{weeks:Array<Array<{day:string,min:number,level:number,inRange:boolean}>>, max:number}}
   */
  heatmap(store, weeks, nowMs) {
    const s = store && store.days ? store : this._empty();
    const w = Math.max(1, Number(weeks) || 12);
    const base = new Date(nowMs != null ? nowMs : Date.now());
    // 对齐到本周（周日为一周起点），再往前推 w-1 周
    const end = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const dow = end.getDay();
    const lastSunday = new Date(end.getTime() - dow * 86400000);
    const start = new Date(lastSunday.getTime() - (w - 1) * 7 * 86400000);
    const out = [];
    let max = 0;
    for (let i = 0; i < w; i++) {
      const col = [];
      for (let j = 0; j < 7; j++) {
        const d = new Date(start.getTime() + (i * 7 + j) * 86400000);
        const key = this.dayKey(d);
        const rec = s.days[key] || {};
        let min = 0;
        for (const k of Object.keys(rec)) min += Number(rec[k]) || 0;
        max = Math.max(max, min);
        col.push({ day: key, min, level: this.level(min), inRange: d.getTime() <= end.getTime() });
      }
      out.push(col);
    }
    return { weeks: out, max };
  },

  /** 人类可读时长 */
  human(min) {
    const m = Math.round(Number(min) || 0);
    if (m < 60) return m + (I18n.isZh ? " 分钟" : " min");
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h + (I18n.isZh ? " 小时" : " h") + (r ? " " + r + (I18n.isZh ? " 分" : " min") : "");
  },

  /* ================== 心跳采集 ================== */

  /** 当前焦点阅读器实例（拿不到返回 null）——0.46.0 抽出：
   * 焦点解析只有这一份（ReadingProgress 心跳也复用它，不另起一套判定） */
  activeReader() {
    try {
      let reader = null;
      if (Zotero.Reader && typeof Zotero.Reader.getActiveReader === "function") {
        reader = Zotero.Reader.getActiveReader();
      }
      if (!reader && Zotero.Reader && Array.isArray(Zotero.Reader._readers)) {
        // 兜底：在已打开的阅读器里找「其窗口就是当前焦点窗口」的那个
        const focusWin = Services.focus && Services.focus.activeWindow;
        if (focusWin) {
          for (const r of Zotero.Reader._readers) {
            try {
              const w = r._iframeWindow || r._window;
              if (w && (w === focusWin || w.top === focusWin)) { reader = r; break; }
            } catch (e) { /* ignore */ }
          }
        }
      }
      return reader || null;
    } catch (e) {
      return null;
    }
  },

  /** 当前焦点阅读器对应的常规条目（拿不到返回 null） */
  activeItem() {
    try {
      const reader = this.activeReader();
      if (!reader) return null;
      const itemID = reader.itemID;
      if (!itemID) return null;
      let item = Zotero.Items.get(itemID);
      if (item && item.isAttachment && item.isAttachment() && item.parentItemID) item = Zotero.Items.get(item.parentItemID);
      if (!item || !item.isRegularItem || !item.isRegularItem() || item.deleted) return null;
      return item;
    } catch (e) {
      return null;
    }
  },

  /** 一次心跳：命中则 +1 分钟并落盘（返回是否命中，便于单测） */
  tick(nowMs) {
    if (!Prefs.get("readingStatsEnabled", true)) return false;
    const item = this.activeItem();
    if (!item) return false;
    const day = this.dayKey(nowMs != null ? new Date(nowMs) : new Date());
    let store = this.load();
    store = this.bump(store, day, item.key, 1);
    store = this.prune(store, day, this.KEEP_DAYS);
    this.save(store);
    return true;
  },

  start() {
    if (this._timer) return;
    // 60s 一次；未开启统计或没有阅读器焦点时开销几乎为零
    this._timer = setInterval(() => {
      try { this.tick(); } catch (e) { Zotero.logError(e); }
    }, 60000);
  },

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  /* ================== 报告 ================== */

  /** 标题解析：KEY → 条目显示名（拿不到就显示 key） */
  _titleOf(key) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
      if (item) {
        if (item.isRegularItem && item.isRegularItem()) return item.getDisplayTitle() || key;
        let p = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
        if (p) return p.getDisplayTitle() || key;
      }
    } catch (e) { /* ignore */ }
    return key;
  },

  HEAT_COLORS: ["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"],

  /** 报告正文（HTML；热力图用内联色块，即便样式被净化也保留数字可读） */
  reportHtml(agg, heat, zh) {
    const total = this.human(agg.totalMin);
    let html = "<h2>" + (zh ? "阅读报告" : "Reading report") + " ｜ " + this.today() + "</h2>";
    html += "<p>" + (zh ? "最近 " + agg.perDay.length + " 天：共阅读 <b>" + total + "</b>，" +
      "有阅读记录 " + agg.activeDays + " 天，平均每天 " + this.human(agg.avgPerActiveDay) + "。" : "") + "</p>";
    // 热力图
    html += "<p><b>" + (zh ? "阅读日历（近 12 周，颜色越深时长越长）" : "Reading calendar") + "</b></p>";
    html += '<table style="border-collapse:collapse;font-size:9px;line-height:1">';
    for (let j = 0; j < 7; j++) {
      html += "<tr>";
      for (let i = 0; i < heat.weeks.length; i++) {
        const c = heat.weeks[i][j];
        const color = c.inRange ? this.HEAT_COLORS[c.level] : "#ffffff";
        html += '<td title="' + c.day + " · " + c.min + (zh ? " 分" : " min") + '" style="width:11px;height:11px;padding:0;' +
          "background:" + color + ';border:1px solid rgba(0,0,0,.06)"></td>';
      }
      html += "</tr>";
    }
    html += "</table>";
    // 每日明细
    html += "<p><b>" + (zh ? "每日时长" : "Daily") + "</b></p><table border=\"1\" cellspacing=\"0\" cellpadding=\"4\" style=\"border-collapse:collapse\">" +
      "<tr><th>" + (zh ? "日期" : "Date") + "</th><th>" + (zh ? "时长" : "Time") + "</th></tr>" +
      agg.perDay.slice().reverse().filter((d) => d.min > 0).slice(0, 30)
        .map((d) => "<tr><td>" + d.day + "</td><td>" + this.human(d.min) + "</td></tr>").join("") +
      "</table>";
    // Top 条目
    if (agg.topItems.length) {
      html += "<p><b>" + (zh ? "阅读时长最多的文献（前 15）" : "Top items") + "</b></p><ol>";
      for (const t of agg.topItems.slice(0, 15)) {
        const title = String(this._titleOf(t.key)).replace(/[<>&]/g, "");
        html += "<li>" + title + " —— " + this.human(t.min) + "</li>";
      }
      html += "</ol>";
    } else {
      html += "<p>" + (zh ? "这段时间还没有采集到阅读时长。打开 PDF 阅读即可自动记录（每分钟累计一次）。" : "No reading time recorded yet.") + "</p>";
    }
    html += "<p><i>" + (zh ? "说明：时长为「阅读器处于焦点时」的累计，每分钟结算一次；只存本机，不联网。" : "Local only.") + "</i></p>";
    return html;
  },

  /** 菜单入口：生成阅读报告笔记 */
  async run() {
    const zh = I18n.isZh;
    const store = this.load();
    const agg = this.aggregate(store, 30);
    const heat = this.heatmap(store, 12);
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(this.reportHtml(agg, heat, zh));
    await note.saveTx();
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + (zh ? "阅读报告" : "Reading report"));
    const p = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "近 30 天共 " : "30d total ") + this.human(agg.totalMin) +
      (zh ? "，有记录 " : ", active days ") + agg.activeDays + (zh ? " 天" : ""));
    p.setProgress(100);
    pw.show();
    pw.startCloseTimer(4000);
    return note;
  },

  /** 状态摘要（功能中心显示） */
  status() {
    const zh = I18n.isZh;
    const store = this.load();
    const agg = this.aggregate(store, 7);
    return {
      enabled: !!Prefs.get("readingStatsEnabled", true),
      week: this.human(agg.totalMin),
      activeDays: agg.activeDays,
      text: (zh ? "近 7 天阅读 " : "7d ") + this.human(agg.totalMin) +
        (zh ? "（" : " (") + agg.activeDays + (zh ? " 天有记录）" : " active days)"),
    };
  },

  /** 清空统计（破坏性操作，需调用方确认） */
  clear() {
    this.save(this._empty());
  },
};
