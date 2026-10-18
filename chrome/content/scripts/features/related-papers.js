/* PaperPilot · 相关文献推荐（0.51.0 新增）
 *
 * 解决什么：读完一篇文献最自然的下一步是「顺藤摸瓜」找同领域的下一批——现在得
 * 复制标题、去 S2/Google Scholar、挑一篇、再回 Zotero 手工建条目，五次操作。
 * 本模块把这一步压成「打开条目 → 看 5 条推荐 → 点一次入库」。
 *
 * 数据：Semantic Scholar Recommendations API（S2Client.recommendations，
 *       见 features/s2-client.js）。依据是当前条目的 DOI。
 * 落库：journalArticle + 标签 `#来源/S2推荐`；DOI 已在库则**不建重复条目**，
 *       只提示「已在文库」并返回已有 itemID。
 *
 * 注册路径（本项目真机范式，见 panels/ref-pane.js 的四坑）：
 *   ① onRender 必填且自己包 try；② header/sidenav 的 l10nID 必须有 ftl 条目；
 *   ③ 注销用 registerSection 的**返回值**；④ 注册时机由 main.js 主线控制。
 * 本模块沿用 pane 路径（registerSection）。若宿主机没有 ItemPaneManager 或
 * 校验失败（返回 false / 抛错），register() **不抛**、返回 false 并静默降级为
 * openDialog(item)（在浏览器打开 S2 检索页），绝不拖死启动。
 *
 * 与其它模块的关系：**不 import RefImport**（构造逻辑独立实现），只借用其
 * 「按 DOI 判重」的思路——但用 Zotero 自己的轻量查询（Items.getByDOI 或
 * Zotero.Search），不拉全库索引。
 */
/* global Zotero, Services, Prefs, I18n, S2Client */

var RelatedPapers = {
  PANE_ID: "paperpilot-related",
  ICON: "chrome://paperpilot/content/icons/refs.svg",
  LIMIT: 5,
  TAG: "#来源/S2推荐",

  _registered: false,
  _registeredPaneID: null,
  _panes: new Map(),

  /* ---------------- 基础 ---------------- */

  _zh() {
    try { return (typeof I18n !== "undefined" && I18n) ? !!I18n.isZh : true; } catch (e) { return true; }
  },

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
      this._panes.set(paneID, { item: null, res: null, busy: false, refs: null, doc: null });
    }
    return this._panes.get(paneID);
  },

  /** 常规条目；PDF 附件归一到父条目（阅读器侧栏选中的常是附件） */
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

  _field(item, name) {
    try { return String(item.getField(name) || "").trim(); } catch (e) { return ""; }
  },

  /** DOI：标准字段优先，其次 extra 里的 `DOI: 10.x/y`（Zotero 通用约定） */
  _doiOf(item) {
    const direct = this._field(item, "DOI").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    if (direct) return direct;
    const extra = this._field(item, "extra");
    const m = /DOI:\s*(\S+)/i.exec(extra);
    return m ? String(m[1]).replace(/[.,;]+$/, "") : "";
  },

  _cleanDOI(v) {
    return String(v == null ? "" : v)
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .replace(/\s+/g, "")
      .trim();
  },

  _yearOf(rec) {
    const m = /\b(1[6-9]\d{2}|20\d{2}|21\d{2})\b/.exec(String((rec && (rec.year || rec.date)) || ""));
    return m ? m[1] : "";
  },

  /* ---------------- 注册 ---------------- */

  /**
   * item pane section 注册（幂等）。
   * @returns {string|false} 成功返回 registerSection 的句柄（注销必须用它），失败返回 false
   */
  register(pluginID) {
    if (this._registered) return this._registeredPaneID || false;
    const IPM = (typeof Zotero !== "undefined" && Zotero) ? Zotero.ItemPaneManager : null;
    if (!IPM || typeof IPM.registerSection !== "function") return false;

    const self = this;
    let handle = false;
    try {
      handle = IPM.registerSection({
        paneID: this.PANE_ID,
        pluginID,
        header: { l10nID: "paperpilot-related-section-header", icon: this.ICON },
        sidenav: { l10nID: "paperpilot-related-section-sidenav", icon: this.ICON },
        // 坑①：onRender 必填；渲染异常自己兜住，不能把 section 宿主拖垮
        onRender({ paneID, doc, body }) {
          try {
            if (!body || (body.querySelector && body.querySelector("[data-pp-related-root]"))) return;
            self._build(doc, body, paneID);
          } catch (e) {
            try { Zotero.logError(e); } catch (_) { /* ignore */ }
          }
        },
        onItemChange({ paneID, item, setEnabled }) {
          const target = self._resolveItem(item);
          if (typeof setEnabled === "function") setEnabled(!!target);
          const st = self._state(paneID);
          const prev = st.item;
          st.item = target;
          if (!target) { st.res = null; self._render(paneID); return true; }
          if (!prev || prev.id !== target.id) self._fetchDebounced(paneID);
          return true;
        },
        onDestroy({ paneID }) {
          const _st = self._panes.get(paneID);
          if (_st && _st.timer) { try { clearTimeout(_st.timer); } catch (e) { /* ignore */ } }
          self._panes.delete(paneID);
        },
      });
    } catch (e) {
      handle = false;
    }
    // 坑②：Z10 schema 校验失败时静默返回 false，必须显式检查
    if (!handle) return false;
    this._registeredPaneID = handle;
    this._registered = true;
    return handle;
  },

  /** 坑③：用 registerSection 的返回值注销；未注册时静默 */
  unregister() {
    const handle = this._registeredPaneID;
    this._registeredPaneID = null;
    this._registered = false;
    this._panes.clear();
    if (!handle) return false;
    try {
      if (Zotero.ItemPaneManager && typeof Zotero.ItemPaneManager.unregisterSection === "function") {
        Zotero.ItemPaneManager.unregisterSection(handle);
      }
    } catch (e) { /* 已注销则忽略 */ }
    return true;
  },

  /* ---------------- 取数（纯函数级：条目 → 结果，不碰 DOM） ---------------- */

  /**
   * @returns {Promise<{ok:boolean, items:Array, reason?:string, message?:string}>}
   *   reason: no_item / no_doi / no_client / rate_limit / network / server / auth / http / empty
   *   永不抛。
   */
  async fetchFor(item, limit) {
    const it = this._resolveItem(item);
    if (!it) {
      return { ok: false, items: [], reason: "no_item", message: this._zh() ? "请选择一个文献条目" : "No item selected" };
    }
    const doi = this._doiOf(it);
    if (!doi) {
      return {
        ok: false, items: [], reason: "no_doi",
        message: this._zh() ? "该条目缺少 DOI，无法检索相关文献" : "This item has no DOI, so related works cannot be looked up",
      };
    }
    const S2 = (typeof S2Client !== "undefined" && S2Client) ? S2Client : null;
    if (!S2 || typeof S2.recommendations !== "function") {
      return { ok: false, items: [], reason: "no_client", message: this._zh() ? "Semantic Scholar 客户端不可用" : "Semantic Scholar client unavailable" };
    }

    const n = Math.max(1, Math.min(20, parseInt(limit, 10) || this.LIMIT));
    try {
      const raw = await S2.recommendations("DOI:" + doi, n);
      if (raw && raw.ok === false) {
        return { ok: false, items: [], reason: raw.reason || "http", message: raw.error || "S2 request failed" };
      }
      const list = Array.isArray(raw) ? raw : [];
      const items = list.filter((r) => r && r.title).slice(0, n);
      if (!items.length) {
        return { ok: false, items: [], reason: "empty", message: this._zh() ? "Semantic Scholar 暂无相关文献推荐" : "No recommendations from Semantic Scholar" };
      }
      return { ok: true, items };
    } catch (e) {
      return { ok: false, items: [], reason: "network", message: (e && e.message) || String(e) };
    }
  },

  /* ---------------- 条目构造 ---------------- */

  /** "A, B and C" / ["A","B"] / [{name}] → [{firstName,lastName,creatorType}] */
  _creators(authors) {
    const names = [];
    const push = (v) => { const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); if (s) names.push(s); };
    if (Array.isArray(authors)) {
      for (const a of authors) {
        if (a == null) continue;
        if (typeof a === "string") push(a);
        else push(a.name || a.literal || [a.given, a.family].filter(Boolean).join(" "));
      }
    } else if (typeof authors === "string") {
      // 先按分隔符切（`, ` / `;` / `&` / ` and `），S2 的 "A, B and C" 即三段
      for (const part of authors.split(/\s*(?:;|,|&|\band\b)\s*/i)) push(part);
    }
    const out = [];
    for (const name of names) {
      const sp = name.lastIndexOf(" ");
      if (sp > 0) out.push({ firstName: name.slice(0, sp), lastName: name.slice(sp + 1), creatorType: "author" });
      else out.push({ lastName: name, creatorType: "author" });
    }
    return out;
  },

  /** 网页地址：DOI 优先，其次 S2 论文页 */
  _urlFor(rec) {
    const doi = this._cleanDOI(rec && rec.doi);
    if (doi) return "https://doi.org/" + doi;
    const pid = String((rec && rec.paperId) || "").trim();
    if (pid) return "https://www.semanticscholar.org/paper/" + encodeURIComponent(pid);
    return "";
  },

  /**
   * 推荐项 → Zotero.Item（journalArticle，**不保存**；纯构造，便于单测断言字段）
   * 字段：title / date(年) / publicationTitle / DOI / abstractNote / url / creators。
   */
  _buildItem(rec) {
    const r = rec || {};
    const item = new Zotero.Item("journalArticle");
    try { item.libraryID = Zotero.Libraries.userLibraryID; } catch (e) { /* ignore */ }

    const set = (f, v) => { try { if (v) item.setField(f, v); } catch (e) { /* 该类型无此字段 */ } };
    set("title", String(r.title || "").trim());
    set("date", this._yearOf(r));
    set("publicationTitle", String(r.venue || "").trim());
    set("DOI", this._cleanDOI(r.doi));
    set("abstractNote", String(r.abstract || "").trim());
    set("url", this._urlFor(r));

    const creators = this._creators(r.authors);
    if (creators.length) { try { item.setCreators(creators); } catch (e) { /* 个别姓名异常时忽略 */ } }
    try { item.addTag(this.TAG); } catch (e) { /* 标签失败不挡入库 */ }
    return item;
  },

  /* ---------------- 去重与入库 ---------------- */

  /**
   * DOI 查重：先试 Zotero.Items.getByDOI（Z7 有就最省），没有则用 Zotero.Search
   * 的 DOI 等值条件——**不**走 Items.getAll（全库实例化太贵）。
   */
  async _findExisting(doi) {
    if (!doi) return null;
    const Items = (Zotero && Zotero.Items) || null;
    try {
      if (Items && typeof Items.getByDOI === "function") {
        const hit = await Items.getByDOI(doi);
        if (hit) return hit;
      }
    } catch (e) { /* 继续走 Search */ }
    try {
      if (typeof Zotero.Search !== "function") return null;
      const s = new Zotero.Search();
      try { s.libraryID = Zotero.Libraries.userLibraryID; } catch (e) { /* ignore */ }
      s.addCondition("DOI", "is", doi);
      const ids = (await s.search()) || [];
      for (const id of ids) {
        const it = (Items && typeof Items.getAsync === "function") ? await Items.getAsync(id) : null;
        if (it && !it.deleted) return it;
      }
    } catch (e) { /* 查重失败按「未入库」继续 */ }
    return null;
  },

  /**
   * 推荐项 → 入库。
   * @returns {Promise<{ok:boolean, itemID?:number, reason?:string, message?:string}>}
   *   重复：{ok:false, reason:"dup", itemID}（已存在条目的 id，若拿得到）
   */
  async importPaper(rec) {
    try {
      if (!rec || !String(rec.title || "").trim()) {
        return { ok: false, reason: "invalid", message: this._zh() ? "推荐项缺少标题，无法入库" : "Recommendation has no title" };
      }
      const doi = this._cleanDOI(rec.doi);
      const exist = await this._findExisting(doi);
      if (exist) {
        return {
          ok: false, reason: "dup", itemID: exist.id || null,
          message: this._zh() ? "该文献已在文库中（DOI 相同），已跳过" : "Already in library (same DOI), skipped",
        };
      }
      const item = this._buildItem(rec);
      // addTag 已在 _buildItem 内完成：标签随这一次 saveTx 一起落盘，无需二次保存
      await item.saveTx();
      return { ok: true, itemID: item.id || null, item };
    } catch (e) {
      return { ok: false, reason: "save_failed", message: (e && (e.message || String(e))) || "save failed" };
    }
  },

  /* ---------------- UI（onRender 调用；测试可直接调） ---------------- */

  _build(doc, body, paneID) {
    const self = this;
    const H = (t, a, x) => self._h(doc, t, a, x);
    const zh = this._zh();
    const st = this._state(paneID);
    st.doc = doc;

    const root = H("div", {
      "data-pp-related-root": "1",
      style: "display:flex;flex-direction:column;gap:6px;padding:7px 8px;font-size:12.5px;line-height:1.5;",
    });
    const current = H("div", {
      class: "pp-related-current",
      style: "font-size:11.5px;color:var(--fill-secondary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    }, zh ? "当前文献" : "Current item");
    root.appendChild(current);
    const status = H("div", {
      class: "pp-related-status",
      style: "font-size:11px;color:var(--fill-secondary,#888);min-height:14px;",
    }, zh ? "正在检索相关文献…" : "Looking up related papers…");
    root.appendChild(status);
    const list = H("div", {
      class: "pp-related-list",
      style: "display:flex;flex-direction:column;gap:5px;max-height:420px;overflow-y:auto;",
    });
    root.appendChild(list);
    const link = H("a", {
      class: "pp-related-s2",
      href: "#",
      style: "font-size:11.5px;color:var(--color-accent,#2f9e6f);text-decoration:none;cursor:pointer;margin-top:2px;",
    }, zh ? "在 S2 打开" : "Open in S2");
    link.addEventListener("click", (ev) => {
      try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
      self._openCurrent(paneID);
    });
    root.appendChild(link);

    body.appendChild(root);
    st.refs = { current, status, list, link };

    if (st.item) this._fetch(paneID);
  },

  _status(paneID, msg, warn) {
    const st = this._state(paneID);
    if (!st.refs || !st.refs.status) return;
    st.refs.status.textContent = msg || "";
    st.refs.status.style.color = warn ? "var(--color-warning,#b45309)" : "var(--fill-secondary,#888)";
  },

  _openURL(url) {
    if (!url) return false;
    try { if (Zotero.launchURL) { Zotero.launchURL(url); return true; } } catch (e) { /* 落兜底 */ }
    try { Services.appShell.hiddenDOMWindow.open(url, "_blank"); return true; } catch (e) { /* ignore */ }
    return false;
  },

  _recURL(rec) {
    const pid = String((rec && rec.paperId) || "").trim();
    if (pid && /^[0-9a-f]{20,}$/i.test(pid)) return "https://www.semanticscholar.org/paper/" + pid;
    const t = String((rec && rec.title) || "").trim();
    return t ? "https://www.semanticscholar.org/search?q=" + encodeURIComponent(t) : "";
  },

  _openCurrent(paneID) {
    const st = this._state(paneID);
    const doi = st.item ? this._doiOf(st.item) : "";
    const url = doi
      ? "https://www.semanticscholar.org/search?q=" + encodeURIComponent("DOI:" + doi)
      : "";
    return this._openURL(url);
  },

  /** 0.54.0（审查 P1-6）：条目切换防抖——快速翻阅时不为停留 <400ms 的条目发请求 */
  _fetchDebounced(paneID) {
    const delay = Number(this.DEBOUNCE_MS);
    if (!isFinite(delay) || delay <= 0) { this._fetch(paneID); return; }
    const st = this._state(paneID);
    if (st.timer) { try { clearTimeout(st.timer); } catch (e) { /* ignore */ } }
    st.timer = setTimeout(() => {
      st.timer = null;
      this._fetch(paneID);
    }, delay);
  },

  async _fetch(paneID) {
    const st = this._state(paneID);
    const item = st.item;
    if (!item || st.busy) return;
    st.busy = true;
    this._renderTitle(paneID);
    this._status(paneID, this._zh() ? "正在检索相关文献…" : "Looking up related papers…");
    try {
      const res = await this.fetchFor(item, this.LIMIT);
      if (st.item && st.item.id !== item.id) return; // 期间换了条目：丢弃旧结果
      st.res = res;
      this._render(paneID);
    } finally {
      st.busy = false;
      // 抓取期间换了条目：_fetch 的 busy 守卫会吞掉那次调用，这里补一次
      if (st.item && st.item.id !== item.id) this._fetch(paneID);
    }
  },

  _renderTitle(paneID) {
    const st = this._state(paneID);
    if (!st.refs || !st.refs.current) return;
    let title = "";
    try {
      if (st.item) title = st.item.getDisplayTitle ? st.item.getDisplayTitle() : this._field(st.item, "title");
    } catch (e) { title = ""; }
    st.refs.current.textContent = title || (this._zh() ? "当前文献" : "Current item");
    st.refs.current.title = title;
  },

  _render(paneID) {
    const st = this._state(paneID);
    if (!st.refs || !st.doc) return;
    const zh = this._zh();
    const H = (t, a, x) => this._h(st.doc, t, a, x);
    const list = st.refs.list;
    while (list.firstChild) list.removeChild(list.firstChild);
    this._renderTitle(paneID);

    if (!st.item) {
      this._status(paneID, zh ? "请选择一条文献" : "Select an item");
      return;
    }
    const res = st.res;
    if (!res) { this._status(paneID, ""); return; }
    if (!res.ok) {
      const fallback = zh ? "暂时无法获取相关文献" : "Related papers unavailable";
      this._status(paneID, res.message || fallback, true);
      return;
    }
    this._status(paneID, (zh ? "Semantic Scholar 推荐 · " : "From Semantic Scholar · ") + res.items.length + (zh ? " 条" : ""));

    for (const rec of res.items) {
      const row = H("div", {
        "data-pp-rec": rec.paperId || rec.doi || rec.title || "",
        style: "display:flex;align-items:flex-start;gap:6px;padding:5px 6px;border-radius:5px;" +
          "background:#88888810;border:1px solid #88888828;",
      });
      const main = H("div", { style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;" });
      const title = H("div", {
        class: "pp-related-title",
        title: rec.title || "",
        style: "font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
      }, this._lineText(rec));
      title.addEventListener("click", () => this._openURL(this._recURL(rec)));
      main.appendChild(title);
      if (rec.venue) {
        main.appendChild(H("div", {
          class: "pp-related-venue",
          style: "font-size:10.5px;color:var(--fill-secondary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
        }, rec.venue));
      }
      row.appendChild(main);

      const btn = H("button", {
        class: "pp-related-import",
        style: "font-size:11px;line-height:1.5;padding:2px 8px;border-radius:5px;cursor:pointer;flex:none;" +
          "border:1px solid #88888855;background:transparent;color:inherit;white-space:nowrap;",
      }, zh ? "入库" : "Add");
      btn.addEventListener("click", () => this._importOne(paneID, rec, btn));
      row.appendChild(btn);
      list.appendChild(row);
    }
  },

  /** 列表行文案：`标题（年份）· 被引 N`（无年份/被引量时省掉对应段） */
  _lineText(rec) {
    const zh = this._zh();
    const title = String(rec.title || "");
    const year = this._yearOf(rec);
    const cited = typeof rec.citationCount === "number" ? rec.citationCount : null;
    let s = title;
    if (year) s += (zh ? "（" : " (") + year + (zh ? "）" : ")");
    if (cited != null) s += " · " + (zh ? "被引 " : "cited ") + cited;
    return s;
  },

  async _importOne(paneID, rec, btn) {
    const st = this._state(paneID);
    if (st.importing) return;
    st.importing = true;
    const zh = this._zh();
    if (btn) { btn.disabled = true; btn.textContent = zh ? "入库中…" : "Adding…"; }
    try {
      const r = await this.importPaper(rec);
      if (r.ok) {
        if (btn) { btn.textContent = zh ? "已入库" : "Added"; btn.disabled = true; }
        this._status(paneID, zh ? "已入库并打上标签 " + this.TAG : "Added to library with tag " + this.TAG);
      } else if (r.reason === "dup") {
        if (btn) { btn.textContent = zh ? "已在库" : "In library"; btn.disabled = true; }
        this._status(paneID, r.message, false);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = zh ? "入库" : "Add"; }
        this._status(paneID, (zh ? "入库失败：" : "Failed: ") + (r.message || ""), true);
      }
    } finally {
      st.importing = false;
    }
  },

  /* ---------------- 降级入口（pane 不可用时） ---------------- */

  /**
   * 降级路径：宿主没有 ItemPaneManager 时，取一次推荐并在浏览器打开 S2 页，
   * 同时把条数/失败原因回报给调用方（不建 UI、不抛）。
   */
  async openDialog(item) {
    try {
      const it = this._resolveItem(item);
      if (!it) return { ok: false, items: [], reason: "no_item" };
      const res = await this.fetchFor(it, this.LIMIT);
      const doi = this._doiOf(it);
      const url = doi ? "https://www.semanticscholar.org/search?q=" + encodeURIComponent("DOI:" + doi) : this._recURL(res.items[0]);
      this._openURL(url);
      try {
        if (typeof Zotero.ProgressWindow === "function") {
          const pw = new Zotero.ProgressWindow({ closeOnClick: true });
          pw.changeHeadline(this._zh() ? "相关文献" : "Related papers");
          pw.addDescription(res.ok
            ? (this._zh() ? "已找到 " + res.items.length + " 条推荐，已在浏览器打开 S2" : res.items.length + " recommendations; opened S2 in browser")
            : (res.message || ""));
          pw.show();
          pw.startCloseTimer(5000);
        }
      } catch (e) { /* 提示条失败不影响主流程 */ }
      return res;
    } catch (e) {
      return { ok: false, items: [], reason: "error", message: (e && e.message) || String(e) };
    }
  },
};

// 与 ref-pane 同款：main.js 装配完成后可直接 Zotero.PaperPilot.RelatedPapers 取到
try {
  if (typeof Zotero !== "undefined" && Zotero.PaperPilot && !Zotero.PaperPilot.RelatedPapers) {
    Zotero.PaperPilot.RelatedPapers = RelatedPapers;
  }
} catch (e) { /* ignore */ }
