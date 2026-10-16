/* PaperPilot 阅读进度列
 * 数据源（按优先级）：
 *   1. reading-stats.js 心跳统计的累计阅读分钟 ÷ 最佳 PDF 附件页数
 *      （页数经 Zotero.Fulltext.getPages 异步获取并缓存，约 1.5 分钟/页折算）；
 *   2. 拿不到页数时用时长启发值：按一篇典型论文 30 页 × 1.5 分钟/页估算，
 *      并在 title 提示「估算」；
 *   3. 没有任何阅读记录 → 列留空（不伪造 0% 条）。
 *
 * 渲染：列内就地自绘进度条（track + fill + 百分比文本，与 rank-column 一样
 * 走 renderCell 的 XHTML DOM）。页数到达后双通道精准刷新（refreshColumns +
 * Notifier redraw，同 rank-column 的修复口径）。
 */
/* global Zotero, Prefs, I18n, ReadingStats */

var ProgressColumn = {
  COLUMN_KEY: "paperpilot-readingProgress",

  MIN_PER_PAGE: 1.5,      // 学术 PDF 经验阅读速度（分钟/页）
  ASSUMED_PAGES: 30,      // 无页数时的启发总页数（典型论文体量）

  _pageCache: new Map(),  // itemID -> 页数（0 = 拿不到）
  _fetching: new Set(),   // 正在取页数的 itemID
  _pendingRefresh: new Set(),
  _refreshTimer: null,
  _registered: false,

  _enabled() {
    return !!Prefs.get("progressColumnEnabled", true);
  },

  /**
   * 进度计算（纯函数，可单测）。
   * @param minutes 累计阅读分钟
   * @param pages 总页数（>0 有效；0/无效 = 走启发值）
   * @returns null（无阅读记录）| {pct, minutes, pages, heuristic}
   */
  computeProgress(minutes, pages) {
    const m = Number(minutes) || 0;
    if (m <= 0) return null;
    const p = Number(pages) || 0;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    if (p > 0) {
      return { pct: clamp(m / (p * this.MIN_PER_PAGE)), minutes: m, pages: p, heuristic: false };
    }
    return {
      pct: clamp(m / (this.ASSUMED_PAGES * this.MIN_PER_PAGE)),
      minutes: m, pages: 0, heuristic: true,
    };
  },

  /** 该条目在心跳统计里的累计分钟（全部天数求和） */
  minutesOf(item) {
    if (typeof ReadingStats === "undefined" || !ReadingStats) return 0;
    let key = "";
    try { key = item.key; } catch (e) { return 0; }
    if (!key) return 0;
    const store = ReadingStats.load();
    let m = 0;
    for (const day of Object.keys(store.days || {})) {
      const v = store.days[day][key];
      if (v) m += Number(v) || 0;
    }
    return m;
  },

  /** 同步拿页数缓存；未缓存则触发异步获取并先按启发值渲染 */
  _pagesOf(item) {
    if (this._pageCache.has(item.id)) return this._pageCache.get(item.id);
    this._fetchPages(item);
    return 0;
  },

  async _fetchPages(item) {
    if (this._fetching.has(item.id)) return;
    this._fetching.add(item.id);
    try {
      let pages = 0;
      const best = await item.getBestAttachment();
      if (best && Zotero.Fulltext && typeof Zotero.Fulltext.getPages === "function") {
        const r = await Zotero.Fulltext.getPages(best.id);
        pages = Number(r && (r.total || r.pages)) || 0;
      }
      this._pageCache.set(item.id, pages);
      if (pages > 0) {
        this._pendingRefresh.add(item.id);
        this._refreshSoon();
      }
    } catch (e) {
      this._pageCache.set(item.id, 0);
    } finally {
      this._fetching.delete(item.id);
    }
  },

  _refreshSoon() {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._refreshColumns();
    }, 800);
  },

  _refreshColumns() {
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    const ids = [...this._pendingRefresh];
    this._pendingRefresh.clear();
    try {
      if (ids.length) Zotero.Notifier.trigger("redraw", "item", ids, {}, true);
    } catch (e) { /* ignore */ }
  },

  /** dataProvider：{pct, minutes, pages, heuristic} 或 null（无记录留空） */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return null;
    if (!this._enabled()) return null;
    const minutes = this.minutesOf(item);
    if (minutes <= 0) return null;
    return this.computeProgress(minutes, this._pagesOf(item));
  },

  /** 单元格悬停详情 */
  detail(data) {
    if (!data) return "";
    const zh = I18n.isZh;
    const pctText = Math.round(data.pct * 100) + "%";
    if (data.heuristic) {
      return (zh
        ? "已读约 " + data.minutes + " 分钟，进度约 " + pctText +
          "（时长估算：未获取到 PDF 页数，按约 " + this.ASSUMED_PAGES + " 页 × " +
          this.MIN_PER_PAGE + " 分钟/页折算）"
        : "~" + data.minutes + " min read, ~" + pctText + " (estimated)");
    }
    const readPages = Math.round(data.minutes / this.MIN_PER_PAGE);
    return (zh
      ? "已读约 " + data.minutes + " 分钟 ≈ " + readPages + "/" + data.pages + " 页（" + pctText + "）"
      : "~" + data.minutes + " min ≈ " + readPages + "/" + data.pages + " pages (" + pctText + ")");
  },

  /* ================= 列注册与渲染 ================= */

  async register(pluginID) {
    if (this._registered) return;
    const self = this;
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("progressColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (!data) return span;
        span.style.cssText = "display:flex;align-items:center;gap:5px;";
        // 进度条轨道
        const track = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        track.style.cssText = "flex:0 0 56px;width:56px;height:6px;border-radius:3px;" +
          "background:var(--fill-quinary,rgba(127,127,127,.25));overflow:hidden;display:inline-block;";
        const fill = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        const pct = Math.round(data.pct * 100);
        fill.style.cssText = "display:block;height:100%;width:" + pct + "%;" +
          "background:" + (data.heuristic ? "var(--fill-tertiary,#999)" : "var(--color-accent,#2563eb)") + ";" +
          "border-radius:3px;";
        track.appendChild(fill);
        span.appendChild(track);
        // 百分比文本
        const text = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        text.textContent = pct + "%";
        text.style.cssText = "font-size:10.5px;color:var(--fill-secondary,#666);";
        span.appendChild(text);
        span.title = self.detail(data);
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
    this._pageCache.clear();
    this._pendingRefresh.clear();
  },
};
