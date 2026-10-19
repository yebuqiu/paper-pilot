// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 阅读进度列（0.46.0 升级：进度条 2.0）
 * ★ 主显示形态 = **标题列内嵌进度**（对齐 zotero-style 的高能进度条挂法）：
 *   进度画在条目标题背后，不需要用户勾选任何列，装完即见。「阅读进度」数据列
 *   保留注册但默认隐藏（Zotero 原生行为），仅作可选的「按进度排序」位。
 * 数据源（按优先级，融合逻辑见 features/reading-progress.js）：
 *   1. 位置口径：ReadingProgress 的「最远到过的页」（心跳捕获 + Zotero 原生上次
 *      位置 + 标注页三源融合）÷ 总页数——「这篇我读到哪了」的字面进度；
 *      心跳同时给当前页累计分钟（每页时长 = 高能进度条的燃料）；
 *   2. 时长兜底：reading-stats.js 累计阅读分钟 ÷（页数 × 1.5 分钟/页）；
 *      拿不到页数时按 30 页启发折算，title 提示「估算」；
 *   3. 两者都没有 → 留空（不伪造 0% 覆盖）。
 * 口径可配（progressBasis：auto=位置优先时长兜底 / position / time）。
 *
 * 行内渲染（progressRowStyle，对齐 zotero-style Progress 的两种画法）：
 *   heat（默认 · 高能进度条）——标题背后每页一格，读得越久颜色越深；还没有每页
 *     数据（旧数据/刚装）时自动回退为整体填充，读完一页立刻转正；
 *   fill——标题背景按进度百分比整体铺色。
 *
 * 列内渲染（progressBarStyle）：bar / gradient / percent；可按阅读状态着色。
 * 排序：Zotero 对自定义列按 String(dataProvider 返回值) 做字符串序——数据对象带
 * toString() 返回零填充百分数（"042"），点列头即可按进度排序（空行沉底）。
 *
 * 性能口径（虚拟列表）：itemTree 是 virtualized-table，_renderCell/renderCell 只对
 * 可视行调用（~40 行/屏）；时长聚合成 Map（raw pref 串不变不重算）、位置走快照
 * 缓存（同前）、页数异步取一次后缓存；排序全量时每行 O(1)。
 * 页数到达后双通道精准刷新（refreshColumns + Notifier redraw，同 rank-column）。
 */
/* global Zotero, Prefs, I18n, ReadingStats, ReadingProgress, ReadingState */

var ProgressColumn = {
  COLUMN_KEY: "papilot-readingProgress",   // 0.42.0 起不变：继承老用户的列可见性
  XHTML: "http://www.w3.org/1999/xhtml",

  // 时长口径的折算参数（与 ReadingProgress 同值；此处保留一份是给
  // ReadingProgress 未加载时的独立兜底（旧单测单独加载本文件），值改动两处同步）
  MIN_PER_PAGE: 1.5,
  ASSUMED_PAGES: 30,

  _pageCache: new Map(),  // itemID -> 页数（0 = 拿不到）
  _fetching: new Set(),   // 正在取页数的 itemID
  _backfilled: new Set(), // 已回填过原生位置的 itemID（一回填终身有效）
  _backfilling: new Set(),
  _pendingRefresh: new Set(),
  _refreshTimer: null,
  _minSnap: { raw: "", map: null },  // 时长聚合缓存：{key → 累计分钟}
  _registered: false,

  _enabled() {
    return !!Prefs.get("progressColumnEnabled", true);
  },

  /** 当前进度条样式（bar | gradient | percent） */
  _style() {
    const s = String(Prefs.get("progressBarStyle", "bar") || "bar");
    return (s === "gradient" || s === "percent") ? s : "bar";
  },

  /**
   * 时长口径纯函数（0.42.0 兼容形状；ReadingProgress 在场时委托单一真源）。
   * @param minutes 累计阅读分钟
   * @param pages 总页数（>0 有效；0/无效 = 走启发值）
   * @returns null（无阅读记录）| {pct, minutes, pages, heuristic}
   */
  computeProgress(minutes, pages) {
    if (typeof ReadingProgress !== "undefined" && ReadingProgress && ReadingProgress.compute) {
      return ReadingProgress.compute({ minutes, page: 0, pages, basis: "time" });
    }
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

  /* ================== 数据访问（全部 O(1)，虚拟列表友好） ================== */

  /** readingStats 全量聚合一次 → {key: 累计分钟}（raw pref 串不变不重算） */
  _minutesMap() {
    // 0.54.1（审查 P1-5）：优先走 ReadingStats 的内存聚合（一次构建、save 时失效），
    // 不再每行 `Prefs.get("readingStats")` + JSON.parse 整串。
    const RS = (typeof ReadingStats !== "undefined") ? ReadingStats : null;
    if (RS && typeof RS.minutesByKey === "function") {
      try { return RS.minutesByKey(); } catch (e) { /* 退化到下面的旧路径 */ }
    }
    const raw = String(Prefs.get("readingStats", "") || "");
    if (this._minSnap.raw !== raw || !this._minSnap.map) {
      const map = new Map();
      const store = RS ? RS.parse(raw) : { days: {} };
      for (const day of Object.keys(store.days || {})) {
        const rec = store.days[day] || {};
        for (const k of Object.keys(rec)) {
          map.set(k, (map.get(k) || 0) + (Number(rec[k]) || 0));
        }
      }
      this._minSnap = { raw, map };
    }
    return this._minSnap.map;
  },

  /** 该条目的累计阅读分钟（真实 reading-stats.js 数据，全天数求和） */
  minutesOf(item) {
    let key = "";
    try { key = item.key; } catch (e) { return 0; }
    if (!key) return 0;
    return this._minutesMap().get(key) || 0;
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

  /** 老数据回填：没有位置记录的条目 → 异步融合原生上次位置 + 标注页（分钟时序
   *  0.46.0 之前的阅读也立刻可见），落库后重绘。去重 + 一回填终身有效，不会反复查库；
   *  什么都没有的条目不写 store（不伪造覆盖）。虚拟列表天然把触发面限制在可视行。 */
  async _backfillItem(item) {
    if (typeof ReadingProgress === "undefined" || !ReadingProgress) return;
    if (this._backfilled.has(item.id) || this._backfilling.has(item.id)) return;
    this._backfilling.add(item.id);
    try {
      const best = await item.getBestAttachment();
      let page = 0;
      if (best && best.isPDFAttachment && best.isPDFAttachment()) {
        try {
          const idx = best.getAttachmentLastPageIndex();   // 原生「上次读到」（0 基）
          if (Number.isInteger(idx) && idx >= 0) page = idx + 1;
        } catch (e) { /* ignore */ }
        try {
          const anns = best.getAnnotations() || [];
          for (const a of anns) page = Math.max(page, ReadingProgress.pageOfAnnotation(a));
        } catch (e) { /* ignore */ }
      }
      this._backfilled.add(item.id);
      if (page > 0) {
        const r = ReadingProgress.record(ReadingProgress.load(), item.key, page, 0, Date.now());
        if (r.changed) {
          ReadingProgress.save(ReadingProgress.prune(r.store, ReadingProgress.MAX_ITEMS));
          this._pendingRefresh.add(item.id);
          this._refreshSoon();
        }
      }
    } catch (e) { /* 回填失败静默：渲染路径不抛 */ }
    finally {
      this._backfilling.delete(item.id);
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

  /**
   * dataProvider（列）：受 progressColumnEnabled 门控。列默认隐藏（Zotero 原生
   * 行为：自定义列须用户在表头右键勾选），只作可选的「按进度排序」位——
   * 主要显示形态是标题列内嵌进度（见下方行内显示）。
   */
  lookupForColumn(item) {
    if (!this._enabled()) return "";
    return this.lookup(item);
  },

  /**
   * 进度计算（不被列开关门控——行内显示与列共用同一条数据链）：
   * 返回进度对象（带 toString 排序键）或 ""（无任何阅读记录，留空不伪造）。
   */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    const RP = (typeof ReadingProgress !== "undefined") ? ReadingProgress : null;
    const minutes = this.minutesOf(item);
    const entry = RP ? RP.entryOf(item.key) : null;
    const page = entry ? entry.p : 0;
    // 0.46.0 修订：无位置记录就回填（不要求先有时长——用户可能从未触发过心跳，
    // 但 Zotero 原生「上次读到」早已持久化，一打开列表就该看得到进度）
    if (!page) this._backfillItem(item);
    // 总页数：心跳带来的（entry.t）优先，其次 Fulltext 缓存（异步补）
    const pages = (entry && entry.t > 0) ? entry.t : this._pagesOf(item);
    if (!minutes && !page) return "";
    const basis = String(Prefs.get("progressBasis", "auto") || "auto");
    const prog = RP
      ? RP.compute({ minutes, page, pages, basis })
      : this.computeProgress(minutes, pages);
    if (!prog) return "";
    return this._decorate(prog, item);
  },

  /** 挂上阅读状态与排序键（不动纯函数输出，包装成渲染/排序两用的数据对象） */
  _decorate(prog, item) {
    let state = "";
    try {
      if (typeof ReadingState !== "undefined" && ReadingState) {
        state = ReadingState.getState(item);
      }
    } catch (e) { /* ignore */ }
    const out = {
      pct: prog.pct,
      page: prog.page || 0,
      pages: prog.pages || 0,
      minutes: prog.minutes || 0,
      basis: prog.basis || "time",
      heuristic: !!prog.heuristic,
      state,
      // 排序键：零填充百分数（"042"），空行是 "" → 升序沉底、降序浮头
      toString() {
        const p = Math.round(this.pct * 100);
        return p < 10 ? "00" + p : (p < 100 ? "0" + p : "" + p);
      },
    };
    return out;
  },

  /** 单元格悬停详情（zh/en 双语；位置/时长/估算三种口径都给出处） */
  detail(data) {
    if (!data) return "";
    const zh = I18n.isZh;
    const pctText = Math.round(data.pct * 100) + "%";
    if (data.basis === "position" && data.page > 0) {
      const pagesText = data.heuristic
        ? (zh ? "约 " + data.pages + " 页" : "~" + data.pages + " pages")
        : (zh ? data.pages + " 页" : data.pages + " pages");
      const base = zh
        ? "读到第 " + data.page + "/" + pagesText + "（" + pctText + "）"
        : "At page " + data.page + "/" + data.pages + " (" + pctText + ")";
      const t = data.minutes
        ? (zh ? " · 累计约 " + data.minutes + " 分钟" : " · ~" + data.minutes + " min")
        : "";
      return base + t + (data.heuristic
        ? (zh ? "（总页数为估算）" : " (pages estimated)") : "");
    }
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

  /* ================== 渲染 ================== */

  /** 进度条填充色（估算灰显；按状态着色时：已读绿 / 在读强调色 / 未读中性灰） */
  _fillColor(data) {
    if (data.heuristic) return "var(--fill-tertiary,#999)";
    if (!Prefs.get("progressColorByState", true)) return "var(--color-accent,#2563eb)";
    if (data.state === "已读") return "var(--accent-green,#16a34a)";
    if (data.state === "在读") return "var(--color-accent,#2563eb)";
    if (data.state === "未读") return "var(--fill-secondary,#808080)";
    return "var(--color-accent,#2563eb)";
  },

  /** 三种样式共用的单元格 DOM（theme CSS 变量取色，浅色深色主题自动适配） */
  _renderCell(data, column, doc) {
    const self = this;
    const span = doc.createElementNS(this.XHTML, "span");
    span.className = `cell ${column.className}`;
    if (!data || typeof data !== "object") return span;
    const style = this._style();
    const pct = Math.round(data.pct * 100);
    const color = this._fillColor(data);
    const label = (data.heuristic ? "≈" : "") + pct + "%";
    if (style === "percent") {
      // 仅百分比标注（最紧凑；颜色随状态/口径）
      span.style.cssText = "display:flex;align-items:center;";
      const text = doc.createElementNS(this.XHTML, "span");
      text.textContent = label;
      text.style.cssText = "font-size:10.5px;font-weight:600;color:" + color + ";";
      span.appendChild(text);
      span.title = self.detail(data);
      return span;
    }
    span.style.cssText = "display:flex;align-items:center;gap:5px;";
    // 进度条轨道（fill-quinary 与 Zotero 原生进度指示同款灰度）
    const track = doc.createElementNS(this.XHTML, "span");
    track.style.cssText = "flex:0 0 64px;width:64px;height:5px;border-radius:2.5px;" +
      "background:var(--fill-quinary,rgba(127,127,127,.25));overflow:hidden;display:inline-block;";
    const fill = doc.createElementNS(this.XHTML, "span");
    fill.style.cssText = "display:block;height:100%;width:" + pct + "%;" +
      "background:" + (style === "gradient"
        ? "linear-gradient(to right,var(--accent-blue,#2563eb),var(--accent-green,#16a34a))"
        : color) +
      ";border-radius:2.5px;";
    track.appendChild(fill);
    span.appendChild(track);
    // 百分比文本
    const text = doc.createElementNS(this.XHTML, "span");
    text.textContent = label;
    text.style.cssText = "font-size:10.5px;color:var(--fill-secondary,#666);";
    span.appendChild(text);
    span.title = self.detail(data);
    return span;
  },

  /* ================== 行内显示（0.46.0：进度直接画在标题列，无需勾选任何列） ================== */
  /* 挂法对齐 zotero-style 的 renderTitleColumn：它 hook 原生「标题」列的单元格渲染
   * （先调原生拿 cellSpan，再把进度层以 zIndex:-1 铺在 .cell-text 背后）。我们不依赖
   * ztoolkit，直接把 ItemTree.prototype._renderCell 包一层——itemsView 是该类的实例，
   * 原型一次补丁覆盖主列表与 feed 树；wrapper 内部自检标志，关闭=不装饰，卸载=还原。 */

  _rowPatched: false,
  _rowProto: null,
  _origRenderCell: null,

  /** 行内显示总开关（默认开——装完插件即见，不需要用户做任何勾选） */
  rowEnabled() {
    return !!Prefs.get("progressRowEnabled", true);
  },

  /** 行内样式：heat = 高能进度条（每页一格，读得越久颜色越深）/ fill = 整体进度填充 */
  rowStyle() {
    const s = String(Prefs.get("progressRowStyle", "heat") || "heat");
    return s === "fill" ? "fill" : "heat";
  },

  /** 注册行内显示（独立于列开关；主窗口未就绪时等 uiReadyPromise 再试一次） */
  async registerRow() {
    if (this._patchRowNow()) return true;
    try { await Zotero.uiReadyPromise; } catch (e) { /* 主窗口可能已关 */ }
    return this._patchRowNow();
  },

  _patchRowNow() {
    if (this._rowPatched || !this.rowEnabled()) return this._rowPatched;
    let proto = null;
    try {
      const zp = Zotero.getActiveZoteroPane();
      proto = (zp && zp.itemsView) ? Object.getPrototypeOf(zp.itemsView) : null;
    } catch (e) { proto = null; }
    if (!proto || typeof proto._renderCell !== "function") return false;
    const self = this;
    this._rowProto = proto;
    this._origRenderCell = proto._renderCell;
    const wrapper = function (index, data, column, isFirstColumn) {
      const cell = self._origRenderCell.call(this, index, data, column, isFirstColumn);
      // 装饰受 _rowPatched 门控：关掉开关只停装饰，原生渲染与别家包装层都不受影响
      if (self._rowPatched) {
        try {
          if (column && column.dataKey === "title") self._decorateTitleCell(cell, index, this);
        } catch (e) { /* 装饰失败不影响原生渲染 */ }
      }
      return cell;
    };
    wrapper._ppProgressRow = true;  // 卸载时确认自己仍在最外层
    proto._renderCell = wrapper;
    this._rowPatched = true;
    return true;
  },

  /** 卸载：自己仍在最外层则还原原型；被别家包过一层就只停装饰（wrapper 还会被调） */
  unregisterRow() {
    this._rowPatched = false;
    try {
      if (this._rowProto && this._origRenderCell && this._rowProto._renderCell
        && this._rowProto._renderCell._ppProgressRow) {
        this._rowProto._renderCell = this._origRenderCell;
      }
    } catch (e) { /* ignore */ }
    this._rowProto = null;
    this._origRenderCell = null;
  },

  /** 刷新行内显示（开关/样式变化后重建全部行） */
  refreshRow() {
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    try { Zotero.Notifier.trigger("redraw", "item", []); } catch (e) { /* ignore */ }
  },

  /** 标题单元格装饰：原生 cellSpan 渲染完后追加进度层（zotero-style 同款几何） */
  _decorateTitleCell(cell, index, tree) {
    if (!this.rowEnabled()) return;
    const row = tree.getRow && tree.getRow(index);
    const item = row && row.ref;
    if (!item || !item.isRegularItem || !item.isRegularItem()) return;
    const prog = this.lookup(item);
    if (!prog) return;   // 无阅读记录：不画（不伪造 0% 覆盖）
    const titleSpan = cell.querySelector(".cell-text");
    if (!titleSpan) return;
    const doc = cell.ownerDocument;
    const overlay = this._buildRowOverlay(prog, item, doc);
    if (!overlay) return;
    // 文本浮上层、进度层铺底（与 zotero-style 的 title 列几何完全一致）
    titleSpan.style.position = "relative";
    titleSpan.style.width = "100%";
    titleSpan.style.zIndex = "1";
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.height = "100%";
    overlay.style.zIndex = "-1";
    titleSpan.appendChild(overlay);
    try { cell.title = this.detail(prog); } catch (e) { /* ignore */ }
  },

  /** 解析主题强调色为 rgb 三元组（每页透明度需要数值分量，CSS 变量进不了 rgba()） */
  _varRGB(doc, cssVar, fallbackHex) {
    try {
      const win = doc && doc.defaultView;
      const v = win && win.getComputedStyle(doc.documentElement).getPropertyValue(cssVar);
      const m = String(v || "").trim().match(/^#([0-9a-f]{6})$/i);
      if (m) {
        return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
      }
    } catch (e) { /* ignore */ }
    const fb = String(fallbackHex || "#2563eb").replace("#", "");
    return [parseInt(fb.slice(0, 2), 16), parseInt(fb.slice(2, 4), 16), parseInt(fb.slice(4, 6), 16)];
  },

  /** 行内覆盖层节点（heat：每页一格；fill：整体填充；无每页数据时 heat 回退 fill） */
  _buildRowOverlay(prog, item, doc) {
    const span = doc.createElementNS(this.XHTML, "span");
    const style = this.rowStyle();
    const RP = (typeof ReadingProgress !== "undefined") ? ReadingProgress : null;
    if (style === "heat" && RP) {
      const entry = RP.entryOf(item.key);
      const d = entry && entry.d;
      const pages = prog.pages > 0 ? prog.pages : (entry && entry.t > 0 ? entry.t : 0);
      const values = [];
      if (d && pages > 0) {
        for (let i = 1; i <= pages; i++) values.push(Number(d[i]) || 0);
      }
      const totalRead = values.reduce((a, b) => a + b, 0);
      if (totalRead > 0) return this._heatNode(span, values, doc);
    }
    // 回退/选择：整体填充（覆盖宽度 = 进度百分比）
    const pct = Math.round(prog.pct * 100);
    if (pct <= 0) return null;
    const color = (prog.state === "已读")
      ? this._varRGB(doc, "--accent-green", "#16a34a")
      : this._varRGB(doc, "--color-accent", "#2563eb");
    span.style.cssText = "display:block;height:100%;width:" + pct + "%;" +
      "background:rgba(" + color.join(",") + ",0.13);border-radius:2px;";
    return span;
  },

  /** 高能进度条：每页一格、透明度=该页累计时长（对齐 zotero-style Progress.opacity：
   *  饱和度上限 = 均值 + (最大-均值)×0.5，且不低于 1.5 分钟——读满一页即全深） */
  _heatNode(span, values, doc) {
    const n = values.length;
    const max = Math.max.apply(null, values);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const RP = (typeof ReadingProgress !== "undefined") ? ReadingProgress : null;
    const limit = (RP && RP.MIN_PER_PAGE) || this.MIN_PER_PAGE;
    const maxValue = Math.max(mean + (max - mean) * 0.5, limit);
    const color = this._varRGB(doc, "--color-accent", "#2563eb");
    span.style.cssText = "display:flex;flex-direction:row;height:100%;width:100%;" +
      "justify-content:space-around;";
    for (let i = 0; i < n; i++) {
      const cell = doc.createElementNS(this.XHTML, "span");
      const alpha = Math.min(1, Math.max(0, values[i] / maxValue));
      cell.style.cssText = "height:100%;width:" + (100 / n) + "%;" +
        "background:rgba(" + color.join(",") + "," + alpha.toFixed(3) + ");";
      span.appendChild(cell);
    }
    return span;
  },

  /* ================== 列注册 ================== */

  async register(pluginID) {
    if (this._registered) return;
    const self = this;
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("progressColumnLabel"),
      minWidth: 44,
      zoteroPersist: ["width", "hidden", "sortDirection"],
      dataProvider: (item) => this.lookupForColumn(item),
      renderCell: (index, data, column, isFirstColumn, doc) =>
        self._renderCell(data, column, doc),
    });
    this._registered = true;
  },

  unregister() {
    if (this._registered) {
      Zotero.ItemTreeManager.unregisterColumns(this.COLUMN_KEY);
      this._registered = false;
    }
    this._pageCache.clear();
    this._backfilled.clear();
    this._backfilling.clear();
    this._pendingRefresh.clear();
    this._minSnap = { raw: "", map: null };
  },
};
