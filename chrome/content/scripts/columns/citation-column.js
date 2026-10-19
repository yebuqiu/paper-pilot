// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 被引量列（0.6.0 新增）
 * 数据来源：Semantic Scholar Graph API（免费公开）。
 * 架构与期刊分区列同构：查询队列 + 本地持久缓存 + 负缓存 + 限速。
 *  - 优先按 DOI 批量查询（/paper/batch，每批最多 50，~1 批/秒）
 *  - 无 DOI 的条目（可选）走标题检索，逐条 ~1 req/s，要求标题归一化后完全匹配
 * 缓存文件：DataDirectory/papilot-s2-citations.json
 * 缓存键："doi:<规范化doi>" 或 "title:<规范化标题>"
 * 值：{c: 被引量, ic: 高影响被引, venue, year, t} 或 {neg:1, t, retryAfter}
 */
/* global Zotero, IOUtils, PathUtils, Prefs, I18n, S2Client, ItemSel */

var CitationColumn = {
  COLUMN_KEY: "papilot-citations",

  _cache: new Map(),        // cacheKey -> 上述值
  _lookupCache: new Map(),  // itemID -> 显示值
  _doiQueue: [],
  _titleQueue: [],
  _queued: new Set(),       // cacheKey 去重
  _working: false,
  _backoffUntil: 0,         // 429 退避截止时间戳
  _refreshTimer: null,
  _saveTimer: null,
  _cacheLoaded: false,
  _registered: false,

  /* ================= 规范化 ================= */

  normalizeDOI(doi) {
    let d = String(doi || "").trim().toLowerCase();
    d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "").trim();
    return d;
  },

  normalizeTitle(title) {
    return String(title || "").toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  },

  _enabled() {
    return !!Prefs.get("citationColumnEnabled", true);
  },

  /* ================= 持久缓存 ================= */

  _cacheFile() {
    return PathUtils.join(Zotero.DataDirectory.dir, "papilot-s2-citations.json");
  },

  async loadCache() {
    if (this._cacheLoaded) return;
    this._cacheLoaded = true;
    try {
      const obj = JSON.parse(await IOUtils.readUTF8(this._cacheFile()));
      for (const k of Object.keys(obj || {})) this._cache.set(k, obj[k]);
      Zotero.debug(`Papilot: S2 被引量缓存 ${this._cache.size} 条`);
    } catch (e) { /* 无缓存文件属正常 */ }
  },

  _saveCacheSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      try {
        const obj = {};
        for (const [k, v] of this._cache) obj[k] = v;
        await IOUtils.writeUTF8(this._cacheFile(), JSON.stringify(obj));
      } catch (e) {
        Zotero.debug("Papilot: S2 被引量缓存写入失败 " + e);
      }
    }, 3000);
  },

  async clearCache() {
    this._cache.clear();
    this._queued.clear();
    this._doiQueue.length = 0;
    this._titleQueue.length = 0;
    this._lookupCache.clear();
    try { await IOUtils.remove(this._cacheFile()); } catch (e) { /* ignore */ }
    this._refreshColumns();
  },

  cacheSize() {
    return this._cache.size;
  },

  /* ================= 查询队列 ================= */

  _keyFor(item) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const doi = this.normalizeDOI(get("DOI"));
    if (doi) return { cacheKey: "doi:" + doi, batchId: "DOI:" + doi, kind: "doi" };
    const title = get("title");
    if (title && Prefs.get("s2TitleSearch", true)) {
      return { cacheKey: "title:" + this.normalizeTitle(title), title, kind: "title" };
    }
    return null;
  },

  _enqueue(entry) {
    if (this._cache.has(entry.cacheKey) || this._queued.has(entry.cacheKey)) return;
    this._queued.add(entry.cacheKey);
    (entry.kind === "doi" ? this._doiQueue : this._titleQueue).push(entry);
    if (!this._working) this._work();
  },

  /** 命中条目写入缓存 */
  _storeHit(cacheKey, p) {
    this._cache.set(cacheKey, {
      c: typeof p.citationCount === "number" ? p.citationCount : 0,
      ic: typeof p.influentialCitationCount === "number" ? p.influentialCitationCount : 0,
      venue: p.venue || "",
      year: p.year || 0,
      title: p.title || "",
      t: Date.now(),
    });
  },

  _storeNeg(cacheKey, reason, retryMs) {
    this._cache.set(cacheKey, {
      neg: 1,
      reason: reason || "",
      t: Date.now(),
      retryAfter: Date.now() + (retryMs || 7 * 24 * 3600 * 1000),
    });
  },

  async _work() {
    if (this._working) return;
    this._working = true;
    try {
      while (this._doiQueue.length || this._titleQueue.length) {
        // 429 退避中：等完再继续
        const wait = this._backoffUntil - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        if (this._doiQueue.length) {
          const batch = this._doiQueue.splice(0, 50);
          for (const e of batch) this._queued.delete(e.cacheKey);
          try {
            const papers = await S2Client.batch(batch.map((e) => e.batchId));
            for (let i = 0; i < batch.length; i++) {
              const p = papers && papers[i];
              if (p && typeof p.citationCount === "number") this._storeHit(batch[i].cacheKey, p);
              else this._storeNeg(batch[i].cacheKey, "not-found");
            }
          } catch (e) {
            this._handleFetchError(batch, e);
          }
          await new Promise((r) => setTimeout(r, S2Client._apiKey() ? 250 : 1100));
        } else if (this._titleQueue.length) {
          const entry = this._titleQueue.shift();
          this._queued.delete(entry.cacheKey);
          try {
            const cands = await S2Client.searchByTitle(entry.title);
            const want = this.normalizeTitle(entry.title);
            const hit = cands.find((p) => this.normalizeTitle(p.title) === want);
            if (hit && typeof hit.citationCount === "number") this._storeHit(entry.cacheKey, hit);
            else this._storeNeg(entry.cacheKey, "not-found");
          } catch (e) {
            this._handleFetchError([entry], e);
          }
          await new Promise((r) => setTimeout(r, S2Client._apiKey() ? 300 : 1100));
        }
        this._saveCacheSoon();
        this._refreshSoon();
      }
    } finally {
      this._working = false;
    }
  },

  _handleFetchError(entries, e) {
    const status = e && e.xmlhttp && e.xmlhttp.status;
    Zotero.debug(`Papilot: S2 查询失败（${status || e.message || e}），${entries.length} 条`);
    if (status === 429) {
      // 限流：整批重新入队，全局退避 10s 起
      this._backoffUntil = Date.now() + 10000;
      for (const entry of entries) {
        this._queued.add(entry.cacheKey);
        (entry.kind === "doi" ? this._doiQueue : this._titleQueue).unshift(entry);
      }
      return;
    }
    // 其他网络错误：30 分钟后允许重试
    for (const entry of entries) this._storeNeg(entry.cacheKey, "http-" + (status || "net"), 30 * 60 * 1000);
  },

  /* ================= 刷新与查找 ================= */

  _refreshSoon() {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._refreshColumns();
    }, 800);
  },

  _refreshColumns() {
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
  },

  /** dataProvider：返回数字（数值排序）；"…" 为查询中占位 */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    if (!this._enabled()) return "";
    if (this._lookupCache.has(item.id)) return this._lookupCache.get(item.id);
    const entry = this._keyFor(item);
    if (!entry) {
      this._lookupCache.set(item.id, "");
      return "";
    }
    const hit = this._cache.get(entry.cacheKey);
    let val;
    if (!hit) {
      this._enqueue(entry);
      val = "…";
    } else if (hit.neg) {
      if (hit.retryAfter && Date.now() > hit.retryAfter) {
        this._cache.delete(entry.cacheKey);
        this._enqueue(entry);
        val = "…";
      } else {
        val = "";
      }
    } else {
      val = hit.c;
    }
    if (this._lookupCache.size > 5000) this._lookupCache.clear();
    if (val !== "…") this._lookupCache.set(item.id, val);
    return val;
  },

  /** 单元格悬停详情 */
  lookupDetail(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    const entry = this._keyFor(item);
    if (!entry) return "";
    const hit = this._cache.get(entry.cacheKey);
    if (!hit || hit.neg) return "";
    const zh = I18n.isZh;
    const lines = [`${zh ? "被引" : "Citations"}: ${hit.c}`];
    if (hit.ic) lines.push(`${zh ? "高影响被引" : "Influential"}: ${hit.ic}`);
    if (hit.venue) lines.push(`${zh ? "来源" : "Venue"}: ${hit.venue}${hit.year ? " (" + hit.year + ")" : ""}`);
    lines.push("Semantic Scholar");
    return lines.join("\n");
  },

  /** 菜单入口：强制重新抓取选中条目的被引量 */
  async refreshForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    let n = 0;
    for (const item of items) {
      const entry = this._keyFor(item);
      if (!entry) continue;
      this._cache.delete(entry.cacheKey);
      this._lookupCache.delete(item.id);
      this._enqueue(entry);
      n++;
    }
    this._refreshColumns();
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    const prog = new pw.ItemProgress(
      "chrome://papilot/content/icons/chat.svg",
      (I18n.isZh ? "已重新排队 " : "Re-queued ") + n + (I18n.isZh ? " 篇的被引量查询" : " item(s) for citation lookup")
    );
    prog.setProgress(100);
    pw.show();
    pw.startCloseTimer(2000);
  },

  /* ================= 注册 ================= */

  async register(pluginID) {
    if (this._registered) return;
    await this.loadCache();
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("citationColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (data !== "" && data !== null && data !== undefined) {
          span.textContent = String(data);
          if (typeof data === "number" && data >= 100) {
            span.style.cssText = "color:var(--accent-red,#c0392b);font-weight:600;";
          }
        }
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
    this._lookupCache.clear();
  },
};
