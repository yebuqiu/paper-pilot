/* PaperPilot 阅读进度数据域（0.46.0，进度条 2.0 的地基）
 *
 * 「阅读进度」的语义：**这篇文献我读到哪了**。三个信号源融合出「最远到过的页」：
 *   A. Zotero 原生上次阅读位置：reader 关页时自动持久化（Zotero.SyncedSettings，
 *      随库同步）——零采集成本，读取走 attachment.getAttachmentLastPageIndex()（0 基）；
 *      仅对 PDF 附件有效（EPUB 存 cfi 字符串、快照存滚动百分比，不能当页码）。
 *   B. 心跳捕获：ReadingStats 每 60s 解析一次焦点阅读器，我们顺路取
 *      pdfViewer.currentPageNumber / pagesCount（经 PdfText.viewerOf 单一真源），
 *      viewerOf 不可用时回落原生位置。位置只进不退（重读不倒退）。
 *   C. 标注位置：annotator 在第 N 页做标注 → Notifier add 事件 → 取
 *      annotationPosition.pageIndex 融合进同一 maxPage（标注随库同步，
 *      换设备读的位置证据也能跟上）。
 *
 * 存储：pref `readingProgress`（JSON，与 readingStats 同一套存储纪律）。
 *   { schema: 1, items: { <条目key>: { p: 最远页(1基), t: 总页数(0=未知), a: 更新ms } } }
 *   每条目 ~50 字节，LRU 上限 3000 条防膨胀。只在本机 pref，不上传不联网；
 *   原生位置（A）与标注（C）本身在 Zotero 库里，天然随库同步——我们只存增量。
 *
 * 取舍（为什么不存「已访问页集合」）：覆盖率语义（翻过的页才算）与「进度条」直觉
 * 不符——跳读文献会永远显示低进度；且集合存储体积是单值的几十倍。maxPage 的
 * 位置语义与 Zotero 原生「上次读到」一致，一行即可持久化。
 */
/* global Zotero, Prefs, ReadingStats, PdfText, ReadingState, ItemSel */

var ReadingProgress = {
  SCHEMA: 1,
  MAX_ITEMS: 3000,     // LRU 上限（条目数）；超出按 a（最近更新）淘汰最旧的
  MAX_PAGE_ENTRIES: 128, // 每条目「每页时长」映射的页数上限（超长 PDF 防撑爆）
  MIN_PER_PAGE: 1.5,   // 学术 PDF 经验阅读速度（分钟/页）——时长兜底口径的分母
  ASSUMED_PAGES: 30,   // 拿不到总页数时的启发值（典型论文体量）

  _timer: null,
  _notifierID: null,
  _snap: { raw: "", items: null },  // 快照缓存：raw pref 串没变就不重复 JSON.parse（渲染路径每行都读）

  /* ================== 存储（纯函数） ================== */

  _empty() { return { schema: 1, items: {} }; },

  /** JSON 字符串 → store；任何脏数据都回到空结构（绝不因坏数据卡死启动） */
  parse(raw) {
    try {
      const o = JSON.parse(String(raw || ""));
      if (!o || typeof o !== "object" || !o.items || typeof o.items !== "object") {
        return this._empty();
      }
      return { schema: 1, items: o.items };
    } catch (e) {
      return this._empty();
    }
  },

  stringify(store) {
    try { return JSON.stringify(store || this._empty()); } catch (e) { return JSON.stringify(this._empty()); }
  },

  load() { return this.parse(Prefs.get("readingProgress", "")); },

  save(store) {
    try { Prefs.set("readingProgress", this.stringify(store)); } catch (e) { Zotero.logError(e); }
  },

  /**
   * 记录一次位置（纯函数）：页数只进不退（重读不倒退）、总页数取可信值、刷新时间戳。
   * ★ 额外字段（如 d 每页时长）原样保留——高能进度条的数据不因位置记录被重建而丢失。
   * @returns {{store:object, changed:boolean}} 便于调用方决定是否落盘/重绘
   */
  record(store, key, page, total, nowMs) {
    const s = store && store.items ? store : this._empty();
    const p = Math.max(0, Math.floor(Number(page) || 0));
    const t = Math.max(0, Math.floor(Number(total) || 0));
    if (!key || p <= 0) return { store: s, changed: false };
    const prev = s.items[key] || { p: 0, t: 0, a: 0 };
    const next = {
      p: Math.max(prev.p || 0, p),
      t: prev.t > 0 ? (t > 0 ? Math.max(prev.t, t) : prev.t) : t,
      a: Number(nowMs) || Date.now(),
      d: prev.d || undefined,
    };
    const changed = next.p !== (prev.p || 0) || next.t !== (prev.t || 0);
    if (!changed && prev.a) return { store: s, changed: false };
    s.items[key] = next;
    return { store: s, changed };
  },

  /**
   * 心跳累计：当前页 +minutes（高能进度条的每页时长，zotero-style 同口径——
   * 其 recordInterval 也是每 tick 记一次）。位置推进与否都要记账。
   * @returns {{store:object, changed:boolean}} changed=总有分钟进账（调用方照常落盘）
   */
  bumpPage(store, key, page, minutes, nowMs, total) {
    const r = this.record(store, key, page, total || 0, nowMs);
    const e = r.store.items[key];
    const m = Math.max(0, Number(minutes) || 0);
    if (!e || !m) return r;
    e.d = e.d || {};
    e.d[page] = (Number(e.d[page]) || 0) + m;
    this._shrinkD(e);
    return { store: r.store, changed: true };
  },

  /** 每页时长条目上限：超了按「读得最少」的页淘汰（保住热点页，防超长 PDF 撑爆 pref） */
  _shrinkD(e) {
    const cap = this.MAX_PAGE_ENTRIES;
    const pages = Object.keys(e.d || {});
    if (pages.length <= cap) return;
    pages.sort((a, b) => (e.d[a] || 0) - (e.d[b] || 0));
    for (let i = 0; i < pages.length - cap; i++) delete e.d[pages[i]];
  },

  /** LRU：超上限按 a 淘汰最旧（copy-on-write：未超上限原样返回，超了建新对象
   *  不原地改入参——调用方拿到的旧 store 引用不会被悄悄截断） */
  prune(store, maxItems) {
    const s = store && store.items ? store : this._empty();
    const keys = Object.keys(s.items);
    const cap = Number(maxItems) || this.MAX_ITEMS;
    if (keys.length <= cap) return s;
    keys.sort((a, b) => (s.items[a].a || 0) - (s.items[b].a || 0));
    const items = {};
    for (let i = keys.length - cap; i < keys.length; i++) items[keys[i]] = s.items[keys[i]];
    return { schema: 1, items };
  },

  /** 取某条目的位置记录（无记录返回 null；不触发任何写） */
  /** items 快照（按 raw pref 串缓存：save() 换了 raw → 下次读自动重建） */
  snapshot() {
    const raw = String(Prefs.get("readingProgress", "") || "");
    if (this._snap.raw !== raw || !this._snap.items) {
      const s = this.parse(raw);
      this._snap = { raw, items: s.items || {} };
    }
    return this._snap.items;
  },

  /** 取某条目的位置记录（无记录返回 null；走快照缓存——渲染路径每行一次也不贵） */
  entryOf(key) {
    const e = this.snapshot()[key];
    return (e && (e.p > 0 || e.t > 0)) ? e : null;
  },

  /* ================== 融合计算（纯函数） ================== */

  /**
   * 进度计算（纯函数，列渲染与自动化共用）。
   * @param {number} o.minutes 累计阅读分钟（ReadingStats 聚合）
   * @param {number} o.page    最远到过的页（0 = 无位置记录）
   * @param {number} o.pages   总页数（0 = 未知 → 启发值，标 heuristic）
   * @param {string} o.basis   进度口径："auto"（位置优先、时长兜底）|"position"|"time"
   * @returns null | {pct, page, pages, minutes, basis, heuristic}
   *   pct∈[0,1]；basis 为最终采信的口径；heuristic=页数未知（分母按 ASSUMED_PAGES）
   */
  compute(o) {
    const minutes = Math.max(0, Number(o && o.minutes) || 0);
    const page = Math.max(0, Math.floor(Number(o && o.page) || 0));
    let pages = Math.max(0, Math.floor(Number(o && o.pages) || 0));
    const basis = o && (o.basis === "position" || o.basis === "time") ? o.basis : "auto";
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const heuristic = pages <= 0;
    if (heuristic) pages = this.ASSUMED_PAGES;

    // 各口径的百分比（无该口径数据时为 null）
    const posPct = page > 0 ? clamp(page / pages) : null;
    const timePct = minutes > 0 ? clamp(minutes / (pages * this.MIN_PER_PAGE)) : null;

    // 采信口径：basis 是用户偏好（auto/position/time），usedBasis 记录最终用的信号
    // （detail 的提示文案与「已读」自动化门槛都按采信口径判断，不按偏好回显）
    let pct = null, usedBasis = null;
    if (basis === "position") { pct = posPct; usedBasis = "position"; }
    else if (basis === "time") { pct = timePct; usedBasis = "time"; }
    else if (posPct != null) { pct = posPct; usedBasis = "position"; }
    else { pct = timePct; usedBasis = "time"; }
    if (pct == null) return null;
    return { pct, page, pages, minutes, basis: usedBasis, heuristic };
  },

  /* ================== 采集：心跳 ================== */

  /** 解析当前焦点阅读器的页位置：优先 pdf.js 实时页（顺带拿总页数），回落原生位置 */
  _capture(reader) {
    try {
      const v = (typeof PdfText !== "undefined" && PdfText && PdfText.viewerOf)
        ? PdfText.viewerOf(reader) : null;
      if (v && v.app && v.app.pdfViewer) {
        const cur = Number(v.app.pdfViewer.currentPageNumber) || 0;
        const total = Number(v.app.pdfViewer.pagesCount) || 0;
        if (cur > 0) return { page: cur, total };
      }
    } catch (e) { /* ignore */ }
    // 回落：Zotero 原生上次位置（仅 PDF 附件；EPUB 存 cfi / 快照存百分比，不当页码用）
    try {
      const att = Zotero.Items.get(reader && reader.itemID);
      if (att && att.isAttachment && att.isAttachment() && att.isPDFAttachment
        && typeof att.isPDFAttachment === "function" && att.isPDFAttachment()) {
        const idx = att.getAttachmentLastPageIndex();
        if (Number.isInteger(idx) && idx >= 0) return { page: idx + 1, total: 0 };
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 一次心跳：焦点命中阅读器则融合位置 + 检查状态自动化（返回是否命中，便于单测） */
  tick(nowMs) {
    try {
      const reader = (typeof ReadingStats !== "undefined" && ReadingStats && ReadingStats.activeReader)
        ? ReadingStats.activeReader() : null;
      if (!reader || !reader.itemID) return false;
      // 附件 → 父常规条目（与 ReadingStats.activeItem 同口径，但只解析一次焦点）
      let item = Zotero.Items.get(reader.itemID);
      if (item && item.isAttachment && item.isAttachment() && item.parentItemID) {
        item = Zotero.Items.get(item.parentItemID);
      }
      if (!item || !item.isRegularItem || !item.isRegularItem() || item.deleted) return false;
      const cap = this._capture(reader);
      if (!cap) return false;
      const at = Number(nowMs) || Date.now();
      // bumpPage：位置融合 + 当前页 +1 分钟（高能进度条的每页时长燃料）
      let r = this.bumpPage(this.load(), item.key, cap.page, 1, at, cap.total);
      r.store = this.prune(r.store, this.MAX_ITEMS);
      if (r.changed) {
        this.save(r.store);
        // 正在读的这篇实时更新（60s 一跳：热图格变深/进度推进，不等人重开窗口）
        try { Zotero.Notifier.trigger("redraw", "item", [item.id], {}, true); } catch (e) { /* ignore */ }
      }
      // 状态自动化与位置是否推进无关（原地继续读也应 未读→在读），内部幂等
      this.maybeAutoState(item, cap);
      return r.changed;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return false;
    }
  },

  start() {
    if (this._timer) return;
    // 与 ReadingStats 同节拍（60s）；没有阅读器焦点时开销几乎为零
    this._timer = setInterval(() => {
      try { this.tick(); } catch (e) { Zotero.logError(e); }
    }, 60000);
  },

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  /* ================== 采集：标注位置 ================== */

  /** annotationPosition JSON → 1 基页号（解析不出返回 0） */
  pageOfAnnotation(item) {
    try {
      const pos = JSON.parse(item.annotationPosition || "");
      const idx = Number(pos && pos.pageIndex);
      if (Number.isInteger(idx) && idx >= 0) return idx + 1;
    } catch (e) { /* ignore */ }
    // 旧数据/外部导入标注没有 position：按页标签数字兜底（罗马页码等解析不出则放弃）
    try {
      const n = Number(item.annotationPageLabel);
      if (Number.isInteger(n) && n > 0) return n;
    } catch (e) { /* ignore */ }
    return 0;
  },

  /** Notifier add：新标注 → 标注页并入该篇的 maxPage（bulk get，大导入不逐条查库） */
  _onAnnotations(ids) {
    (async () => {
      try {
        const items = await Zotero.Items.getAsync(ids || []);
        let store = this.load();
        let dirty = false;
        for (const it of items) {
          try {
            if (!it || !it.isAnnotation || !it.isAnnotation()) continue;
            const page = this.pageOfAnnotation(it);
            if (page <= 0) continue;
            const att = Zotero.Items.get(it.parentItemID);
            const parent = att && att.parentItemID ? Zotero.Items.get(att.parentItemID) : null;
            if (!parent || !parent.key || !parent.isRegularItem || !parent.isRegularItem()) continue;
            const r = this.record(store, parent.key, page, 0, Date.now());
            store = r.store;
            if (r.changed) {
              dirty = true;
              try { Zotero.Notifier.trigger("redraw", "item", [parent.id], {}, true); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* 单条失败不拖垮批次 */ }
        }
        if (dirty) {
          store = this.prune(store, this.MAX_ITEMS);
          this.save(store);
        }
      } catch (e) { /* ignore */ }
    })();
  },

  /* ================== 配套：状态自动化 + 重置 ================== */

  /**
   * 进度反向驱动阅读状态（0.46.0）：
   *   有进度（>0）且状态为「未读」→「在读」（ReadingState 的 tab 事件路径在部分
   *   版本不可用，心跳是更稳的兜底）；位置口径进度 ≥ 阈值且非估算 →「已读」。
   * 时长口径不触发「已读」（反复精读前几页也可能攒够时长，误报代价高）。
   * @param {object} cap {page,total} 当前心跳位置（可空 → 回落 store 里的记录）
   */
  maybeAutoState(item, cap) {
    try {
      if (!Prefs.get("progressAutoFinish", true)) return false;
      if (typeof ReadingState === "undefined" || !ReadingState) return false;
      const state = ReadingState.getState(item);
      const entry = this.entryOf(item.key);
      const page = cap && cap.page ? cap.page : (entry ? entry.p : 0);
      const pages = cap && cap.total ? cap.total : (entry ? entry.t : 0);
      // 位置进度只有「拿到真实总页数」才可信（heuristic 时 compute 会按 30 页折算，
      // 这里不复用 compute 的 heuristic 分支，直接按真实页数判）
      const minutes = (typeof ReadingStats !== "undefined" && ReadingStats)
        ? this._minutesOfKey(ReadingStats.load(), item.key) : 0;
      const progress = this.compute({ minutes, page, pages, basis: "position" });
      if (state === "未读" && ((progress && progress.pct > 0) || minutes > 0)) {
        ReadingState.setState(item, "在读").catch(() => {});
        return true;
      }
      if (state !== "已读" && progress && !progress.heuristic && progress.page > 0
        && progress.pages > 0) {
        const threshold = Math.min(1, Math.max(0.5,
          (Number(Prefs.get("progressAutoFinishPct", 95)) || 95) / 100));
        if (progress.pct >= threshold) {
          ReadingState.setState(item, "已读").catch(() => {});
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  /** 从 ReadingStats store 里聚合某条目的累计分钟（一次遍历，O(天)） */
  _minutesOfKey(store, key) {
    if (!store || !store.days || !key) return 0;
    let m = 0;
    for (const day of Object.keys(store.days)) {
      const v = store.days[day] && store.days[day][key];
      if (v) m += Number(v) || 0;
    }
    return m;
  },

  /** 右键「重置阅读进度」：清本模块记录 + 原生上次位置归零（标注不动——它是用户资产） */
  async resetForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return 0;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return 0; }
    const store = this.load();
    let n = 0;
    for (const item of items) {
      try {
        if (store.items[item.key]) { delete store.items[item.key]; n++; }
        const best = await item.getBestAttachment();
        // 原生「上次读到」归零：下次打开从第 1 页开始（非 PDF 附件跳过）
        if (best && best.isPDFAttachment && best.isPDFAttachment()) {
          await best.setAttachmentLastPageIndex(0);
          n++;
        }
      } catch (e) { Zotero.logError(e); }
    }
    if (n) this.save(store);
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    try { Zotero.Notifier.trigger("redraw", "item", items.map((i) => i.id), {}, true); } catch (e) { /* ignore */ }
    return n;
  },

  /* ================== 生命周期 ================== */

  register() {
    // 标注 add → 位置融合（心跳由 start() 起独立节拍，两个采集通道互不依赖）
    if (!this._notifierID) {
      try {
        this._notifierID = Zotero.Notifier.registerObserver({
          notify: (event, type, ids) => {
            try { if (event === "add") this._onAnnotations(ids); } catch (e) { Zotero.logError(e); }
          },
        }, ["item"], "paperpilot-reading-progress");
      } catch (e) {
        this._notifierID = null;
      }
    }
    this.start();
  },

  unregister() {
    this.stop();
    if (this._notifierID) {
      try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) { /* ignore */ }
      this._notifierID = null;
    }
  },

  /** 功能中心/排障摘要 */
  status() {
    const s = this.load();
    const keys = Object.keys(s.items || {});
    return {
      items: keys.length,
      text: (keys.length + " 条位置记录（" +
        (Prefs.get("progressColumnEnabled", true) ? "进度列已启用" : "进度列已停用") + "）"),
    };
  },
};
