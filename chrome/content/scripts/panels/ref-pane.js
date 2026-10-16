/* PaperPilot 阅读器右侧栏 · 参考文献面板（0.40.0 新增）
 *
 * 解决什么：0.33.0 的「参考文献一键入库」是一个对话框流程——选条目 → 开窗口 →
 * 抓五源参考文献表 → 勾选 → 导入。功能完整，但**脱离了阅读场景**：用户在 PDF 里
 * 读到一条引用，得回主窗口、找菜单、开对话框，来回三次。本面板把同一条管线
 * （解析/五源检索/判重/导入，全部复用 RefImport/RefSources/RefFormat，不重写）
 * 搬进右侧栏（ItemPane section，主窗口条目面板与 PDF 阅读器侧栏同一份注册），
 * 读文献时参考文献列表就在手边，点 `+` 即入库并与当前条目建立 related 关联。
 *
 * 面板结构（自上而下）：
 *   ① 数据源圆点行（PDF解析 / Crossref / S2 / arXiv / CNKI）：点亮 = 该源有命中；
 *      点击某个圆点 = 只走该源重新抓取并**合并**进当前列表。
 *   ② 刷新按钮：单击 = 按缓存渲染（缓存没有再抓）；长按 ≥500ms = 跳过缓存
 *      重新解析 PDF + 重新检索全部源。
 *   ③ 参考文献列表：序号 + 题录（标题截断 + 作者/年/出处一行）+ 来源徽标 + 操作钮。
 *      操作钮三态：`+`（未入库）/「已入库·关联」（判重命中，点击只建关联）/
 *      「已入库·关联」置灰（本次已导入或已关联）。
 *
 * 缓存（D3）：按条目 key 存「解析出的参考文献列表 + 各源命中数」到
 *   pref extensions.paperpilot.refPaneCache（JSON，LRU 上限 100 条）。
 *   存的是**精简记录**（去 abstract 等重字段），避免大 PDF 的解析结果挤爆 pref。
 *
 * ⚠️ registerSection 四坑（与 translate-pane 同源，务必维持）：
 *   ① onRender 必填且自己包 try（Z10 schema 缺了静默返回 false）；
 *   ② header/sidenav 的 l10nID 必须在 .ftl 有对应条目（paperpilot-refs-section-*）；
 *   ③ 注销用 registerSection 的**返回值**，不是注册时的 paneID；
 *   ④ 注册时序：本模块由 main.js 在启动阶段 loadSubScript，注册入口是
 *      PaperPilot.RefPane.register(pluginID)（同时挂同名全局，供主线直接调用）。
 */
/* global Zotero, RefFormat, RefSources, RefImport, I18n */

var RefPane = {
  PANE_ID: "paperpilot-refs",
  ICON: "chrome://paperpilot/content/icons/refs.svg",

  /** 缓存 pref（完整键，非 Prefs 模块前缀）：JSON，{itemKey: {t, records, channels}} */
  CACHE_PREF: "extensions.paperpilot.refPaneCache",
  CACHE_MAX: 100,
  LONG_PRESS_MS: 500,

  /** 数据源圆点。
   *  match    = rec.source 里哪些标记算「该源命中」（点亮依据）
   *  channels = 点击该圆点时，fetchReferenceLists 只跑哪些通道
   *  ★ arXiv 没有「参考文献表」接口，预印本的引用网络经 OpenAlex 的
   *    referenced_works 反查（对 arXiv 系覆盖最好），故 channels 映射到 openalex。 */
  DOTS: [
    { id: "pdf", zh: "PDF解析", en: "PDF", match: ["pdf", "gbt"], channels: ["pdf"] },
    { id: "crossref", zh: "Crossref", en: "Crossref", match: ["crossref-ref", "crossref"], channels: ["crossref"] },
    { id: "s2", zh: "S2", en: "S2", match: ["s2-ref", "s2"], channels: ["s2"] },
    { id: "arxiv", zh: "arXiv", en: "arXiv", match: ["arxiv", "openalex-ref"], channels: ["openalex"] },
    { id: "cnki", zh: "CNKI", en: "CNKI", match: ["cnki"], channels: ["cnki"] },
  ],

  /** rec.source 标记 → 徽标短名（行内显示，比全名省地方） */
  BADGE: {
    pdf: "PDF", gbt: "GB/T", cnki: "CNKI", arxiv: "arXiv", ai: "AI", bibtex: "Bib",
    "crossref-ref": "CR", crossref: "CR", "s2-ref": "S2", s2: "S2",
    "openalex-ref": "OA", openalex: "OA", "europepmc-ref": "EPMC", europepmc: "EPMC",
    pubmed: "PM",
  },

  _panes: new Map(),      // paneID -> 状态
  _registered: false,
  _registeredPaneID: null,

  /* ---------------- 基础 ---------------- */

  _h(doc, tag, attrs, text) {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  },

  _state(paneID) {
    if (!this._panes.has(paneID)) {
      this._panes.set(paneID, {
        item: null,        // 当前条目（常规条目；PDF 附件会被归一到其父条目）
        records: null,     // 当前渲染的参考文献记录
        channels: {},      // 各通道命中数（点亮圆点用）
        busy: false,       // 抓取中
        importing: false,  // 单条入库中
        pressT: 0,         // 刷新按钮按下时刻（长按判定）
        refs: null,        // DOM 引用
        doc: null,
      });
    }
    return this._panes.get(paneID);
  },

  _zh() {
    return (typeof I18n !== "undefined" && I18n) ? I18n.isZh : true;
  },

  /** 可用条目：常规条目；PDF 附件归一到父条目（阅读器里选中的常是附件本身） */
  _resolveItem(item) {
    if (!item) return null;
    try {
      if (item.isRegularItem && item.isRegularItem()) return item;
      if (item.isAttachment && item.isAttachment()) {
        const p = item.parentItem;
        if (p && p.isRegularItem && p.isRegularItem()) return p;
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  _cacheKey(item) {
    try { if (item.key) return String(item.key); } catch (e) { /* ignore */ }
    return "id:" + String(item && item.id || "");
  },

  /* ---------------- 缓存（pref JSON + LRU） ---------------- */

  _cacheReadAll() {
    try {
      const raw = Zotero.Prefs.get(this.CACHE_PREF);
      if (!raw) return {};
      const data = JSON.parse(String(raw));
      return (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
    } catch (e) { return {}; }
  },

  _cacheWriteAll(map) {
    const keys = Object.keys(map);
    if (keys.length > this.CACHE_MAX) {
      // LRU：按最近访问时间淘汰最旧的（t 在 get/set 时都会刷新）
      keys.sort((a, b) => (map[a].t || 0) - (map[b].t || 0));
      for (const k of keys.slice(0, keys.length - this.CACHE_MAX)) delete map[k];
    }
    try { Zotero.Prefs.set(this.CACHE_PREF, JSON.stringify(map)); } catch (e) { /* pref 写失败不致命 */ }
  },

  _cacheGet(key) {
    if (!key) return null;
    const map = this._cacheReadAll();
    const v = map[key];
    if (!v || !Array.isArray(v.records)) return null;
    v.t = Date.now();
    map[key] = v;
    this._cacheWriteAll(map);
    return v;
  },

  _cacheSet(key, value) {
    if (!key || !value) return;
    const map = this._cacheReadAll();
    // value.t 可由调用方显式指定（测试用）；缺省为当前时间
    map[key] = Object.assign({ t: Date.now() }, value);
    this._cacheWriteAll(map);
  },

  /** 缓存用的精简记录：去 abstract/长 raw，避免 100 条缓存挤爆 pref */
  _slim(rec) {
    const o = {};
    for (const f of ["title", "year", "date", "container", "volume", "issue", "pages",
      "publisher", "place", "doi", "pmid", "pmcid", "arxivId", "isbn", "url",
      "language", "itemType", "citationCount", "confidence"]) {
      if (rec[f] != null && rec[f] !== "") o[f] = rec[f];
    }
    if (rec.authors && rec.authors.length) o.authors = rec.authors.slice(0, 20);
    if (rec.source && rec.source.length) o.source = rec.source.slice();
    if (rec.reasons && rec.reasons.length) o.reasons = rec.reasons.slice(0, 6);
    if (rec.raw) o.raw = String(rec.raw).slice(0, 400);
    return o;
  },

  /* ---------------- 注册 ---------------- */

  register(pluginID) {
    if (this._registered) return;
    const self = this;
    const registeredPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: this.PANE_ID,
      pluginID,
      header: {
        l10nID: "paperpilot-refs-section-header",
        icon: this.ICON,
      },
      sidenav: {
        l10nID: "paperpilot-refs-section-sidenav",
        icon: this.ICON,
      },
      // 坑①：onRender 必填，且自己包 try（渲染异常不能拖垮整个 section 宿主）
      onRender({ paneID, doc, body }) {
        try {
          if (body.querySelector("[data-pp-ref-root]")) return;
          self._build(doc, body, paneID);
        } catch (e) {
          try { Zotero.logError(e); } catch (_) { /* ignore */ }
        }
      },
      onItemChange({ paneID, item, setEnabled }) {
        const target = self._resolveItem(item);
        setEnabled(!!target);
        const st = self._state(paneID);
        const prev = st.item;
        st.item = target;
        if (!target) return true;
        // 换篇：先按缓存渲染（无缓存则自动抓一次）；同篇重渲染不动
        if (!prev || prev.id !== target.id) {
          self._fetch(paneID, {});
        }
        return true;
      },
      onDestroy({ paneID }) {
        self._panes.delete(paneID);
      },
    });
    // registerSection 校验失败时静默返回 false（不抛错），必须显式检查
    if (!registeredPaneID) {
      throw new Error("ItemPaneManager.registerSection 校验失败（返回 false），参考文献面板未注册");
    }
    this._registeredPaneID = registeredPaneID;
    this._registered = true;
  },

  unregister() {
    if (this._registered) {
      try {
        // 坑③：用 registerSection 的返回值注销
        Zotero.ItemPaneManager.unregisterSection(this._registeredPaneID || this.PANE_ID);
      } catch (e) { /* 已注销则忽略 */ }
      this._registeredPaneID = null;
      this._registered = false;
    }
    this._panes.clear();
  },

  /* ---------------- UI 构建（onRender 调用；测试可直接调） ---------------- */

  _build(doc, body, paneID) {
    const self = this;
    const H = (t, a, x) => self._h(doc, t, a, x);
    const zh = this._zh();
    const st = this._state(paneID);
    st.doc = doc;

    const root = H("div", {
      "data-pp-ref-root": "1",
      style: "display:flex;flex-direction:column;gap:7px;padding:7px 8px;font-size:12.5px;line-height:1.5;",
    });

    /* ① 数据源圆点行 + 刷新按钮 */
    const topRow = H("div", { style: "display:flex;align-items:center;gap:6px;" });
    topRow.appendChild(H("span", { style: "color:var(--fill-secondary,#666);flex:none;font-size:11.5px;" },
      zh ? "数据源" : "Sources"));
    const dotsBox = H("div", { class: "pp-ref-dots", style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0;flex-wrap:wrap;" });
    const dots = {};
    for (const d of this.DOTS) {
      const wrap = H("span", {
        "data-pp-dot": d.id,
        title: zh ? d.zh + "：点击只用该源重新检索" : d.en + ": click to re-fetch via this source only",
        style: "display:inline-flex;align-items:center;gap:3px;cursor:pointer;font-size:11px;" +
          "color:var(--fill-secondary,#888);",
      });
      const dot = H("span", {
        class: "pp-ref-dot",
        style: "width:8px;height:8px;border-radius:50%;background:#88888855;display:inline-block;flex:none;",
      });
      wrap.appendChild(dot);
      wrap.appendChild(H("span", null, zh ? d.zh : d.en));
      wrap.addEventListener("click", () => { if (!st.busy) self._fetch(paneID, { channels: d.channels, merge: true, force: true }); });
      dots[d.id] = dot;
      dotsBox.appendChild(wrap);
    }
    topRow.appendChild(dotsBox);
    const refreshBtn = H("button", {
      class: "pp-ref-refresh",
      title: zh ? "单击：按缓存渲染（无缓存则抓取）；长按 ≥0.5s：跳过缓存重新解析与检索"
        : "Click: render from cache (fetch if none); long-press >=0.5s: bypass cache",
      style: "flex:none;font-size:13px;line-height:1;padding:3px 7px;border-radius:5px;cursor:pointer;" +
        "border:1px solid #88888855;background:transparent;color:inherit;",
    }, "⟳");
    topRow.appendChild(refreshBtn);
    root.appendChild(topRow);

    /* ② 状态行 */
    const status = H("div", {
      class: "pp-ref-status",
      style: "font-size:11px;color:var(--fill-secondary,#888);min-height:14px;",
    }, zh ? "打开条目后自动解析参考文献" : "References are parsed when an item is selected");
    root.appendChild(status);

    /* ③ 列表 */
    const list = H("div", {
      class: "pp-ref-list",
      style: "display:flex;flex-direction:column;gap:5px;max-height:520px;overflow-y:auto;",
    });
    root.appendChild(list);

    body.appendChild(root);
    st.refs = { dots, refreshBtn, status, list };

    /* 刷新：按下记时刻，抬起按时长分单击/长按（坑：别同时绑 click，会双触发） */
    refreshBtn.addEventListener("mousedown", () => { st.pressT = Date.now(); });
    refreshBtn.addEventListener("mouseup", () => {
      const long = st.pressT && (Date.now() - st.pressT >= this.LONG_PRESS_MS);
      st.pressT = 0;
      if (st.busy) return;
      if (long) self._fetch(paneID, { force: true });
      else self._renderFromCache(paneID);
    });

    // 面板刚建好时若已有条目（section 复用场景），按缓存补一次渲染
    if (st.item) this._renderFromCache(paneID);
  },

  _btnCss() {
    return "font-size:11px;line-height:1.5;padding:2px 8px;border-radius:5px;cursor:pointer;flex:none;" +
      "border:1px solid #88888855;background:transparent;color:inherit;white-space:nowrap;";
  },

  /* ---------------- 抓取与渲染 ---------------- */

  /** 单击刷新：有缓存按缓存渲染，没有才抓 */
  _renderFromCache(paneID) {
    const st = this._state(paneID);
    if (!st.item) return;
    const hit = this._cacheGet(this._cacheKey(st.item));
    if (hit) {
      st.records = hit.records;
      st.channels = hit.channels || {};
      this._renderList(paneID);
      this._status(paneID, (this._zh() ? "缓存 · 共 " : "Cached · ") + st.records.length
        + (this._zh() ? " 条（长按 ⟳ 强刷）" : " (long-press ⟳ to refresh)"));
    } else {
      this._fetch(paneID, {});
    }
  },

  /**
   * 抓参考文献：RefImport.fetchReferenceLists（五源通道 + PDF 段，内部合并去重）。
   * @param {{force?:boolean, channels?:Array<string>, merge?:boolean}} opts
   *   force   跳过缓存；channels 只跑指定通道（圆点点击）；merge 与现有列表合并
   */
  async _fetch(paneID, opts) {
    const o = opts || {};
    const st = this._state(paneID);
    const item = st.item;
    if (!item || st.busy) return;
    const zh = this._zh();
    const key = this._cacheKey(item);
    if (!o.force && !o.channels) {
      const hit = this._cacheGet(key);
      if (hit) {
        st.records = hit.records;
        st.channels = hit.channels || {};
        this._renderList(paneID);
        this._status(paneID, (zh ? "缓存 · 共 " : "Cached · ") + st.records.length + (zh ? " 条" : ""));
        return;
      }
    }
    st.busy = true;
    this._status(paneID, zh ? "正在解析 PDF 并检索参考文献…" : "Parsing PDF and fetching references…");
    try {
      const r = await RefImport.fetchReferenceLists([item], {
        channels: o.channels,
        limit: 400,
        max: 400,
      });
      let records = r.records || [];
      let channels = r.channels || {};
      if (o.merge && st.records && st.records.length) {
        records = RefFormat.dedupeRecords(st.records.concat(records)).records;
        channels = Object.assign({}, st.channels, channels);
      }
      try { await RefImport.markDuplicates(records); } catch (e) { /* 判重失败不挡渲染 */ }
      st.records = records;
      st.channels = channels;
      this._cacheSet(key, { records: records.map((x) => this._slim(x)), channels });
      this._renderList(paneID);
      if (!records.length && r.diagnosis) {
        this._status(paneID, this._diagnosisText(r.diagnosis), true);
      } else {
        this._status(paneID, (zh ? "共 " : "") + records.length + (zh ? " 条参考文献" : " references"));
      }
    } catch (e) {
      this._status(paneID, (zh ? "抓取失败：" : "Failed: ") + ((e && e.message) || e), true);
    } finally {
      st.busy = false;
    }
  },

  _diagnosisText(code) {
    const zh = this._zh();
    const map = {
      no_identifier: zh ? "条目缺 DOI/PMID 等标识符，且 PDF 无法定位" : "Item lacks identifiers and PDF not found",
      scanned_pdf: zh ? "PDF 无文本层（扫描件），无法解析参考文献段" : "PDF has no text layer (scanned)",
      no_bib_section: zh ? "PDF 中未定位到参考文献区段" : "Bibliography section not found in PDF",
      cnki_verify: zh ? "知网需要人机验证，请先在浏览器过验证" : "CNKI requires verification",
      cnki_login: zh ? "知网需要登录/机构权限" : "CNKI requires login",
      cnki_no_hit: zh ? "知网未收录该文献" : "Not indexed by CNKI",
      not_indexed: zh ? "各数据源均未收录该文献的参考文献" : "Not indexed by any source",
    };
    return map[code] || (zh ? "未找到参考文献" : "No references found");
  },

  _status(paneID, msg, warn) {
    const st = this._state(paneID);
    if (!st.refs) return;
    st.refs.status.textContent = msg || "";
    st.refs.status.style.color = warn ? "var(--color-warning,#b45309)" : "var(--fill-secondary,#888)";
  },

  _badgeText(rec) {
    const seen = [];
    for (const s of rec.source || []) {
      const b = this.BADGE[s] || s;
      if (seen.indexOf(b) < 0) seen.push(b);
    }
    return seen.join("/") || "?";
  },

  _updateDots(paneID) {
    const st = this._state(paneID);
    if (!st.refs) return;
    const srcs = new Set();
    for (const r of st.records || []) for (const s of r.source || []) srcs.add(s);
    for (const d of this.DOTS) {
      const lit = d.match.some((m) => srcs.has(m));
      const el = st.refs.dots[d.id];
      if (el) el.style.background = lit ? "var(--color-accent,#2f9e6f)" : "#88888855";
    }
  },

  /** 列表渲染：序号 + 题录（截断）+ 来源徽标 + 操作钮 */
  _renderList(paneID) {
    const st = this._state(paneID);
    if (!st.refs || !st.doc) return;
    const zh = this._zh();
    const doc = st.doc;
    const H = (t, a, x) => this._h(doc, t, a, x);
    const list = st.refs.list;
    while (list.firstChild) list.removeChild(list.firstChild);
    const records = st.records || [];
    records.forEach((rec, i) => {
      const row = H("div", {
        class: "pp-ref-row",
        style: "display:flex;align-items:flex-start;gap:6px;padding:5px 6px;border-radius:5px;" +
          "background:#88888810;border:1px solid #88888828;",
      });
      row.appendChild(H("span", {
        class: "pp-ref-num",
        style: "flex:none;min-width:20px;text-align:right;font-size:11px;color:var(--fill-secondary,#888);",
      }, String(i + 1)));
      const main = H("div", { style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;" });
      main.appendChild(H("div", {
        class: "pp-ref-title",
        title: rec.title || rec.raw || "",
        style: "font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
      }, rec.title || String(rec.raw || "").slice(0, 120) || (zh ? "（无题录）" : "(no title)")));
      const metaParts = [];
      const auth = RefFormat.authorText(rec, 3);
      if (auth) metaParts.push(auth);
      if (rec.year) metaParts.push(String(rec.year));
      if (rec.container) metaParts.push(rec.container);
      if (metaParts.length) {
        main.appendChild(H("div", {
          class: "pp-ref-meta",
          style: "font-size:11px;color:var(--fill-secondary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
        }, metaParts.join(" · ")));
      }
      row.appendChild(main);
      row.appendChild(H("span", {
        class: "pp-ref-badge",
        title: (rec.source || []).join(", "),
        style: "flex:none;font-size:10px;color:var(--fill-secondary,#888);border:1px solid #88888844;" +
          "border-radius:4px;padding:0 4px;margin-top:1px;",
      }, this._badgeText(rec)));
      const btn = H("button", {
        class: "pp-ref-add",
        style: this._btnCss(),
      }, this._btnText(rec));
      if (rec.imported || rec.linked) btn.disabled = true;
      btn.addEventListener("click", () => { if (!st.importing) this._importOne(paneID, rec, btn); });
      row.appendChild(btn);
      list.appendChild(row);
    });
    this._updateDots(paneID);
  },

  _btnText(rec) {
    const zh = this._zh();
    if (rec.imported || rec.linked) return zh ? "已入库·关联" : "Linked";
    if (rec.dup && rec.dup.dup) return zh ? "已入库·关联" : "In library · Link";
    return "+";
  },

  /* ---------------- 单条入库 + related 关联（D2） ---------------- */

  /**
   * `+` 一键入库管线（全部复用现有模块）：
   *   五源联合补全（RefSources.enrichRecords）→ AI 补全元数据（只填空）→
   *   判重（findDuplicate；命中则只建关联）→ 入库（importRecords + contextItem，
   *   由 RefImport 负责双向 related 与进当前条目全部分类）。
   */
  async _importOne(paneID, rec, btn) {
    const st = this._state(paneID);
    const ctx = st.item;
    if (!ctx || !rec || st.importing) return;
    const zh = this._zh();
    st.importing = true;
    btn.disabled = true;
    try {
      // 判重命中分支：不入库，只与库中已有条目建关联
      if (rec.dup && rec.dup.dup) {
        btn.textContent = zh ? "关联中…" : "Linking…";
        let exist = rec.dup.item || null;
        if (!exist) {
          try { exist = this._findDupItem(rec, await RefImport.libraryIndex()); } catch (e) { exist = null; }
        }
        if (exist) {
          const ok = await this._relate(exist, ctx);
          rec.linked = ok;
          btn.textContent = ok ? (zh ? "已入库·关联" : "Linked") : (zh ? "关联失败" : "Link failed");
          if (!ok) btn.disabled = false;
        } else {
          btn.textContent = zh ? "已在库" : "In library";
        }
        return;
      }

      // 未入库分支：补全 → AI → 再判重 → 入库
      btn.textContent = zh ? "检索中…" : "Searching…";
      let full = rec;
      try {
        const en = await RefSources.enrichRecords([rec], {});
        if (en && en[0]) full = en[0];
      } catch (e) { /* 补全失败用原始记录继续 */ }
      try { await RefImport.aiComplete([full]); } catch (e) { /* 无 key 时自动跳过 */ }

      let dup = { dup: false, by: "", item: null };
      try {
        const idx = await RefImport.libraryIndex();
        dup = RefImport.findDuplicate(full, idx);
        if (dup.dup && !dup.item) dup.item = this._findDupItem(full, idx);
      } catch (e) { /* 判重失败按未入库继续 */ }
      if (dup.dup) {
        rec.dup = dup;
        if (dup.item) {
          const ok = await this._relate(dup.item, ctx);
          rec.linked = ok;
        }
        btn.textContent = zh ? "已入库·关联" : "In library · Link";
        return;
      }

      btn.textContent = zh ? "入库中…" : "Importing…";
      const res = await RefImport.importRecords([full], { contextItem: ctx });
      if (res && res.ok > 0) {
        rec.imported = true;
        btn.textContent = zh ? "已入库·关联" : "Imported";
        // 库索引失效：紧接着的下一次判重要能见到刚入库的条目
        try { RefImport._lib = null; RefImport._libT = 0; } catch (e) { /* ignore */ }
        this._status(paneID, zh ? "已入库并建立关联" : "Imported and linked");
      } else {
        const msg = (res && res.errors && res.errors[0] && res.errors[0].message) || "save failed";
        btn.disabled = false;
        btn.textContent = "+";
        this._status(paneID, (zh ? "入库失败：" : "Import failed: ") + msg, true);
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = rec.dup && rec.dup.dup ? (zh ? "已入库·关联" : "In library · Link") : "+";
      this._status(paneID, (zh ? "操作失败：" : "Failed: ") + ((e && e.message) || e), true);
    } finally {
      st.importing = false;
    }
  },

  /** 双向 related：两方向各挂一次、各存一次（Zotero 原生 API 是单向的） */
  async _relate(a, b) {
    if (!a || !b || !a.id || !b.id || a.id === b.id) return false;
    try {
      a.addRelatedItem(b);
      await a.saveTx();
    } catch (e) { return false; }
    try {
      b.addRelatedItem(a);
      await b.saveTx();
    } catch (e) { /* 反向失败保留单向，不判整体失败 */ }
    return true;
  },

  /** 判重命中但 findDuplicate 没给条目（DOI/PMID/arXiv 键只存了 Set）时，线性找回库中条目 */
  _findDupItem(rec, idx) {
    if (!rec || !idx || !idx.items) return null;
    const doi = RefFormat.normDOI(rec.doi);
    const pm = RefFormat.normPmid(rec.pmid);
    const ax = RefFormat.normArxiv(rec.arxivId);
    const isbn = RefFormat.normIsbn(rec.isbn);
    const rt = RefFormat.normTitle(rec.title);
    for (const it of idx.items) {
      const g = (f) => { try { return String(it.getField(f) || ""); } catch (e) { return ""; } };
      if (doi && RefFormat.normDOI(g("DOI")) === doi) return it;
      const extra = g("extra");
      if (pm) {
        const m = /PMID:\s*(\d{6,9})/i.exec(extra);
        if (m && m[1] === pm) return it;
      }
      if (ax && (RefFormat.normArxiv(g("archiveID")) === ax || RefFormat.normArxiv(extra) === ax)) return it;
      if (isbn && RefFormat.normIsbn(g("ISBN")) === isbn) return it;
      if (rt && rt.length >= 8 && RefFormat.normTitle(g("title")) === rt) return it;
    }
    return null;
  },
};

// 坑④：注册入口留给主线。main.js 完成装配后可直接 PaperPilot.RefPane.register(id)；
// 这里在 Zotero.PaperPilot 已存在时先挂上引用（不主动注册，注册时机由主线控制）。
try {
  if (typeof Zotero !== "undefined" && Zotero.PaperPilot && !Zotero.PaperPilot.RefPane) {
    Zotero.PaperPilot.RefPane = RefPane;
  }
} catch (e) { /* ignore */ }
