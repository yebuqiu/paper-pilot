// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 组件目录与安装编排（module-store）
 * ================================================================
 * module-loader 只管本地状态机；本文件负责「目录 → 下载 → 交给 loader」这一段。
 * 目录拉取/缓存/失败源记忆已抽取到共享基建 core/catalog-client.js
 * （全局 CatalogClient，0.73.2 P1-4）；本文件只做编排与商店私有兜底。
 *
 * 目录三级降级（对齐 skill-store 的成熟做法）：
 *   1. GitHub raw（本机 api/raw 通畅，git 协议被墙——见分册 02）
 *   2. Gitee raw 镜像（单源被改时仍可交叉兜底）
 *   3. 包内快照 chrome/content/modules/builtin-index.json（离线可用）
 * 缓存 12h（pref: modulesCatalogCache），手动刷新强制穿透。
 *
 * 纪律：
 *   · 下载源域名**只允许目录里声明的 github/gitee**，不接受模块自带第三方 URL。
 *   · 任何网络失败都不弹错误框，只记 lastError + 返回 {ok:false,error}，
 *     已安装模块照常工作（离线降级，分册 21「异常静默」）。
 *   · 安装成功后写 whatsNew 记账（pref: modulesWhatsNew，≤20 条），
 *     解决「Zotero 静默更新、用户不知道变了什么」的老问题。
 */

/* global Zotero, Services, IOUtils, PathUtils, CatalogClient */

var ModuleStore = {
  // 目录托管在主仓（与 xpi 同一个 Release）：不额外建 10 个公开仓库，
  // 组件 zip 作为 v<版本> 的 Release 附件，清单走 raw / gitee raw。
  CATALOG_URLS: [
    "https://raw.githubusercontent.com/yebuqiu/zotero-papilot/main/papilot-modules-index.json",
    "https://gitee.com/cassiuschen9261/zotero-papilot/raw/main/papilot-modules-index.json",
  ],
  // 自建镜像 / 真机自检用：pref modulesCatalogUrl 置顶（生产默认空）
  MIRROR_PREF: "modulesCatalogUrl",
  CACHE_TTL_MS: 12 * 60 * 60 * 1000,
  LAST_ERROR_PREF: "modulesLastError",
  CACHE_PREF: "modulesCatalogCache",
  WHATSNEW_PREF: "modulesWhatsNew",
  STATS_PREF: "modulesStats",

  _loader: null,
  _deps: { prefGet: null, prefSet: null, httpGet: null, httpGetBytes: null, diag: null, now: null },
  _catalog: null,
  _catalogAt: 0,
  _lastError: null,
  _inflight: {},

  /* ================= 初始化 ================= */

  init(opts) {
    const o = opts || {};
    this._loader = o.loader || (typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.moduleLoader) || null;
    const d = this._deps;
    if (o.deps) Object.assign(d, o.deps);
    if (!d.now) d.now = () => Date.now();
    if (!d.prefGet) {
      d.prefGet = (k, def) => {
        try {
          if (typeof Prefs !== "undefined" && Prefs.get) return Prefs.get(k, def);
          return Zotero.Prefs.get("papilot." + k, true);
        } catch (e) { return def; }
      };
    }
    if (!d.prefSet) {
      d.prefSet = (k, v) => {
        try {
          if (typeof Prefs !== "undefined" && Prefs.set) Prefs.set(k, v);
          else Zotero.Prefs.set("papilot." + k, v, true);
        } catch (e) { /* ignore */ }
      };
    }
    if (!d.diag) {
      d.diag = msg => {
        try {
          if (Zotero.Papilot && Zotero.Papilot._diag) Zotero.Papilot._diag(msg);
          else Zotero.debug("[papilot] " + msg);
        } catch (e) { /* ignore */ }
      };
    }
    if (!d.httpGet) d.httpGet = url => this._defaultHttpGet(url);
    if (!d.httpGetBytes) d.httpGetBytes = url => this._defaultHttpGetBytes(url);
    this._catClient = null;   // 重新 init（换依赖）时丢弃旧目录客户端
    return this;
  },

  /** JSON 拉取（默认实现委托共享基建：8s 超时、Promise 形式）。 */
  async _defaultHttpGet(url) {
    return CatalogClient.httpGet(url);
  },

  /** 二进制拉取（模块 zip；默认实现委托共享基建：60s 超时）。 */
  async _defaultHttpGetBytes(url) {
    return CatalogClient.httpGetBytes(url);
  },

  /**
   * 共享目录客户端（惰性创建；CatalogClient 未装配时返回 null，调用方走兜底）。
   * _deadUrls 与客户端共享同一对象：目录源挂过的 URL，清单/zip 下载同样跳过。
   */
  _client() {
    if (this._catClient) return this._catClient;
    if (typeof CatalogClient === "undefined" || !CatalogClient || typeof CatalogClient.create !== "function") {
      return null;
    }
    const d = this._deps;
    this._catClient = CatalogClient.create({
      urls: this.CATALOG_URLS,
      mirrorPref: this.MIRROR_PREF,
      cachePref: this.CACHE_PREF,
      cacheTtlMs: this.CACHE_TTL_MS,
      validate: data => this.validateCatalog(data),
      sourceLabel: url => (String(url).indexOf("gitee") >= 0 ? "gitee" : "github"),
      rememberFailures: true,
      prefGet: (k, def) => d.prefGet(k, def),
      prefSet: (k, v) => d.prefSet(k, v),
      diag: m => d.diag(m),
      now: () => d.now(),
      httpGet: url => d.httpGet(url),
    });
    this._deadUrls = this._catClient.deadUrls;
    return this._catClient;
  },

  /* ================= 目录 ================= */

  /** 包内快照：随 xpi 分发，离线/首启都能显示商店内容。 */
  async _builtinCatalog() {
    try {
      const root = (Zotero.Papilot && Zotero.Papilot.rootURI) || "";
      if (!root) return null;
      const url = root + "chrome/content/modules/builtin-index.json";
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      this._deps.diag("builtin catalog unavailable: " + (e && e.message || e));
      return null;
    }
  },

  /** 统一返回形状：既给内部（ok/data）也给窗口（modules/updated）用，避免接缝空列表。 */
  _ok(source, data, error) {
    return { ok: true, data, modules: (data && data.modules) || [], updated: (data && data.updated) || null, source, error };
  },

  _fail(error) {
    return { ok: false, error, modules: [], updated: null };
  },

  /**
   * 拉目录。force=true 穿透缓存；全部源失败时回落到上次缓存/内置快照。
   * 网络/缓存/失败源记忆在 CatalogClient 里，这里只管内存层与商店私有兜底。
   * @returns {Promise<{ok:boolean, data?:object, source?:string, error?:string}>}
   */
  async fetchCatalog(force) {
    const d = this._deps;
    if (!force && this._catalog && (d.now() - this._catalogAt) < this.CACHE_TTL_MS) {
      return this._ok("memory", this._catalog);
    }

    const client = this._client();
    if (client) {
      const r = await client.fetch(!!force);
      if (r.ok) {
        this._catalog = r.data;
        this._catalogAt = r.ts != null ? r.ts : d.now();
        if (r.url) {
          // 网络新鲜拉取：记录来源并清掉历史错误
          this._catalogSource = r.source;
          this._lastError = null;
          d.diag("module catalog fetched: " + ((r.data && r.data.modules) || []).length + " modules from " + r.url);
        } else if (r.source === "stale-cache") {
          this._lastError = r.error || this._lastError;
        }
        return this._ok(r.source, r.data, r.error);
      }
      this._lastError = r.error;
    }

    // 兜底：包内快照（随 xpi 分发，离线/首启都能显示商店内容）
    const builtin = await this._builtinCatalog();
    if (builtin && builtin.modules) {
      this._catalog = builtin;
      this._catalogAt = d.now();
      return this._ok("builtin", builtin, this._lastError);
    }
    return this._fail(this._lastError || "无法连接组件目录");
  },

  /** 目录源：pref 镜像（自建/自检）优先，其后才是官方两源（解析逻辑在 CatalogClient）。 */
  _catalogUrls() {
    const client = this._client();
    return client ? client.urls() : this.CATALOG_URLS.slice();
  },

  /** 目录结构校验（纯函数式，供测试直接调）。 */
  validateCatalog(data) {
    const errors = [];
    if (!data || typeof data !== "object") return { ok: false, errors: ["不是对象"] };
    if (!Array.isArray(data.modules)) return { ok: false, errors: ["modules 不是数组"] };
    for (const m of data.modules) {
      if (!m || !m.id) { errors.push("条目缺 id"); continue; }
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(m.id)) errors.push("id 非法：" + m.id);
      if (!m.version) errors.push(m.id + " 缺 version");
      const dl = m.download || {};
      for (const k of ["github", "gitee"]) {
        if (dl[k] && !this._urlAllowed(dl[k])) {
          errors.push(m.id + " 下载源不在白名单：" + dl[k]);
        }
      }
      const mf = m.manifest || {};
      for (const k of ["github", "gitee"]) {
        if (mf[k] && !this._urlAllowed(mf[k])) {
          errors.push(m.id + " 清单源不在白名单：" + mf[k]);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  },

  /** 允许的下载/清单源：三个官方域 + 本机回环（自建镜像与真机自检）。 */
  _urlAllowed(url) {
    if (typeof url !== "string") return false;
    if (/^https:\/\/(raw\.githubusercontent\.com|github\.com|gitee\.com)\//.test(url)) return true;
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return true;
    return false;
  },

  getCatalog() { return this._catalog; },
  getLastError() { return this._lastError; },
  getCatalogSource() { return this._catalogSource || null; },

  /* ================= 列表视图 ================= */

  /**
   * 合并「目录条目」与「本地已装」。目录里没有但本地有的（已下架/离线目录旧）
   * 也要列出来，否则用户没法卸载。
   */
  listRows() {
    const rows = [];
    const cat = (this._catalog && this._catalog.modules) || [];
    const installed = {};
    for (const it of (this._loader ? this._loader.list() : [])) installed[it.id] = it;

    for (const m of cat) {
      const inst = installed[m.id];
      rows.push({
        id: m.id,
        name: m.name || m.id,
        description: m.description || "",
        version: m.version || null,
        sizeBytes: Number(m.sizeBytes) || 0,
        fileCount: Number(m.fileCount) || 0,
        updateNotes: m.updateNotes || m.whatsNew || "",
        tags: Array.isArray(m.tags) ? m.tags.slice() : [],
        requires: Array.isArray(m.requires) ? m.requires.slice() : [],
        permissions: Array.isArray(m.permissions) ? m.permissions.slice() : [],
        bundle: !!m.bundle,
        contains: Array.isArray(m.contains) ? m.contains.slice() : [],
        pro: !!m.pro,
        recommended: !!m.recommended,
        hot: !!m.hot,
        installedVersion: inst ? inst.version : null,
        installed: !!inst,
        broken: !!(inst && inst.broken),
        updateAvailable: !!(inst && m.version && this.compareVersion(m.version, inst.version) > 0),
        canRollback: !!(inst && inst.previous),
        _catalog: m,
      });
      delete installed[m.id];
    }
    for (const id of Object.keys(installed)) {
      const inst = installed[id];
      rows.push({
        id,
        name: id,
        description: "（目录中已下架，仅可卸载/回滚）",
        version: null,
        sizeBytes: 0,
        fileCount: 0,
        updateNotes: "",
        tags: [],
        pro: false,
        recommended: false,
        hot: false,
        installedVersion: inst.version,
        installed: true,
        broken: !!inst.broken,
        updateAvailable: false,
        canRollback: !!inst.previous,
        _catalog: null,
      });
    }
    rows.sort((a, b) => (Number(b.recommended) - Number(a.recommended)) || a.name.localeCompare(b.name, "zh"));
    return rows;
  },

  compareVersion(a, b) {
    return this._loader ? this._loader._pure.compareVersion(a, b) : 0;
  },

  /* ================= 安装 ================= */

  _entry(id) {
    const cat = (this._catalog && this._catalog.modules) || [];
    return cat.find(m => m.id === id) || null;
  },

  /** Pro 门控：entry.pro 时必须已登录且 Pro；判定失败按不放行处理。 */
  planAllows(entry) {
    if (!entry || !entry.pro) return { ok: true };
    try {
      const acc = Zotero.Papilot && Zotero.Papilot.account;
      if (!acc || typeof acc.isPro !== "function") return { ok: false, reason: "需要 Papilot 专业版" };
      if (!acc.isLoggedIn || !acc.isLoggedIn()) return { ok: false, reason: "该组件需要登录并开通专业版" };
      if (!acc.isPro()) return { ok: false, reason: "该组件仅限专业版用户" };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "无法确认会员状态" };
    }
  },

  /**
   * 安装一个模块：取清单 → 下载 zip → loader 校验安装 → 记账。
   * 全程串行（同一 id 并发点击直接复用同一 promise）。
   */
  install(id) {
    if (this._inflight[id]) return this._inflight[id];
    const p = this._install(id).finally(() => { delete this._inflight[id]; });
    this._inflight[id] = p;
    return p;
  },

  async _install(id) {
    const d = this._deps;
    if (!this._loader) return { ok: false, error: "模块运行时未就绪" };
    if (!this._catalog) {
      const r = await this.fetchCatalog(false);
      if (!r.ok) return { ok: false, error: r.error || "目录不可用" };
    }
    const entry = this._entry(id);
    if (!entry) return { ok: false, error: "目录中没有该组件" };
    const gate = this.planAllows(entry);
    if (!gate.ok) return { ok: false, error: gate.reason };

    // 1) 清单：优先 github，失败换 gitee
    let manifest = null, lastErr = null;
    for (const url of [entry.manifest && entry.manifest.github, entry.manifest && entry.manifest.gitee]) {
      if (!url) continue;
      if (this._deadUrls && this._deadUrls[url]) continue;   // 本会话已知不通，不等超时
      try {
        const m = await d.httpGet(url);
        const v = this._loader._pure.validateManifest(m, null, this._loader.API_VERSION);
        if (!v.ok) throw new Error("清单非法：" + v.errors.join("; "));
        if (m.id !== id) throw new Error("清单 id 与目录不一致");
        manifest = m;
        break;
      } catch (e) { lastErr = e; d.diag("manifest fetch failed " + url + ": " + (e && e.message || e)); }
    }
    if (!manifest) return { ok: false, error: "组件清单下载失败：" + String(lastErr && (lastErr.message || lastErr)) };

    // 2) zip
    const baseDir = this._loader._ensureDeps().baseDir;
    const dlDir = PathUtils.join(baseDir, "modules", ".downloads");
    const zipPath = PathUtils.join(dlDir, id + "-" + manifest.version + ".zip");
    let bytesOk = false;
    for (const url of [entry.download && entry.download.github, entry.download && entry.download.gitee]) {
      if (!url) continue;
      if (this._deadUrls && this._deadUrls[url]) continue;   // 本会话已知不通，不等超时
      try {
        const bytes = await d.httpGetBytes(url);
        if (!bytes || !bytes.length) throw new Error("空文件");
        await IOUtils.makeDirectory(dlDir, { createAncestors: true, ignoreExisting: true });
        await IOUtils.write(zipPath, bytes);
        bytesOk = true;
        break;
      } catch (e) { lastErr = e; d.diag("zip download failed " + url + ": " + (e && e.message || e)); }
    }
    if (!bytesOk) return { ok: false, error: "组件包下载失败：" + String(lastErr && (lastErr.message || lastErr)) };

    // 3) 交给 loader（校验 + 原子切换 + 热加载）
    let res;
    try {
      res = await this._loader.installFromZip(zipPath, manifest, { hot: true });
    } finally {
      try { await IOUtils.remove(zipPath, { ignoreAbsent: true }); } catch (e) { /* ignore */ }
    }
    if (res && res.ok) {
      this._recordStats(id);
      this._recordWhatsNew(id, res.version, manifest.whatsNew || entry.updateNotes || "");
    }
    return res;
  },

  /** 未安装时的交互：确认 → 后台装。供 module-loader.require() 调用。 */
  async promptInstall(id, opts) {
    const o = opts || {};
    // 瘦身包里点十个功能会弹十次同一确认框——会话内去重，一次只问一回
    this._prompted = this._prompted || {};
    if (this._prompted[id]) return { ok: false, error: "已提示过（组件商店内可随时安装）" };
    this._prompted[id] = 1;
    const entry = this._entry(id) || null;
    if (!entry) {
      // 目录还没拉过：先拉一次再判断
      const r = await this.fetchCatalog(false);
      if (!r.ok) return { ok: false, error: r.error };
    }
    const m = this._entry(id);
    if (!m) return { ok: false, error: "目录中没有该组件" };
    const size = this.formatSize(m.sizeBytes);
    let confirmed = false;
    try {
      const win = Zotero.getMainWindow();
      const msg = (o.reason ? o.reason + "\n\n" : "")
        + "「" + (m.name || id) + "」需要单独下载（约 " + size + "）。\n\n"
        + "组件会在后台安装，装好后通常无需重启。是否现在安装？";
      const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
        + Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL;
      const rv = Services.prompt.confirmEx(win, "Papilot 组件", msg, flags,
        "下载并安装", null, null, null, {});
      confirmed = rv === 0;
    } catch (e) {
      confirmed = false;
    }
    if (!confirmed) return { ok: false, error: "cancelled" };

    const res = await this.install(id);
    try {
      const win = Zotero.getMainWindow();
      if (win && win.ZoteroPane) {
        if (res && res.ok) {
          Zotero.Papilot._diag("module installed on demand: " + id + "@" + res.version);
        } else {
          Services.prompt.alert(win, "Papilot 组件", "安装失败：" + ((res && res.error) || "未知错误"));
        }
      }
    } catch (e) { /* 提示失败不影响安装结果 */ }
    return res;
  },

  async uninstall(id) {
    if (!this._loader) return { ok: false, error: "模块运行时未就绪" };
    return this._loader.uninstall(id);
  },

  async rollback(id) {
    if (!this._loader) return { ok: false, error: "模块运行时未就绪" };
    return this._loader.rollback(id);
  },

  async setEnabled(id, enabled) {
    if (!this._loader) return { ok: false, error: "模块运行时未就绪" };
    return this._loader.setEnabled(id, enabled);
  },

  /* ================= 更新 ================= */

  /**
   * 检查更新（只查目录版本 vs 已装版本，不下载）。
   * force=false 时走 12h 缓存 —— 启动期自动检查绝不能强制穿透网络。
   */
  async checkUpdates(force) {
    const r = await this.fetchCatalog(!!force);
    if (!r.ok) return { ok: false, error: r.error, updates: [] };
    const updates = [];
    for (const it of (this._loader ? this._loader.list() : [])) {
      const m = this._entry(it.id);
      if (!m || !m.version) continue;
      if (this.compareVersion(m.version, it.version) > 0) {
        updates.push({
          id: it.id,
          name: m.name || it.id,
          version: m.version,
          installedVersion: it.version,
          sizeBytes: Number(m.sizeBytes) || 0,
          whatsNew: m.whatsNew || m.updateNotes || "",
        });
      }
    }
    return { ok: true, updates };
  },

  /** 全部更新（串行，逐项结果都在 results 里，单项失败不中断）。 */
  async updateAll(ids) {
    const list = Array.isArray(ids) && ids.length
      ? ids
      : (await this.checkUpdates()).updates.map(u => u.id);
    const results = [];
    for (const id of list) {
      let r;
      try { r = await this.install(id); } catch (e) { r = { ok: false, error: String(e && (e.message || e)) }; }
      results.push({ id, ...r });
    }
    return { ok: results.every(x => x.ok), results };
  },

  /* ================= 记账：whatsNew / 本地统计 ================= */

  _recordWhatsNew(id, version, text) {
    if (!text) return;
    try {
      const raw = this._deps.prefGet(this.WHATSNEW_PREF, "");
      let arr = [];
      if (raw) { const p = typeof raw === "string" ? JSON.parse(raw) : raw; if (Array.isArray(p)) arr = p; }
      arr = arr.filter(x => !(x && x.id === id && x.version === version));
      arr.unshift({ id, version, text: String(text).slice(0, 500), at: new Date(this._deps.now()).toISOString() });
      this._deps.prefSet(this.WHATSNEW_PREF, JSON.stringify(arr.slice(0, 20)));
    } catch (e) { /* 记账失败不影响安装 */ }
  },

  /** 未读的组件更新说明（设置面板/通知可读）。 */
  getWhatsNew(limit) {
    try {
      const raw = this._deps.prefGet(this.WHATSNEW_PREF, "");
      const arr = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
      return Array.isArray(arr) ? arr.slice(0, limit || 20) : [];
    } catch (e) { return []; }
  },

  _recordStats(id) {
    try {
      const raw = this._deps.prefGet(this.STATS_PREF, "");
      let obj = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
      if (!obj || typeof obj !== "object") obj = {};
      const cur = obj[id] || { installs: 0 };
      cur.installs = (Number(cur.installs) || 0) + 1;
      cur.lastAt = new Date(this._deps.now()).toISOString();
      obj[id] = cur;
      this._deps.prefSet(this.STATS_PREF, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  },

  getStats() {
    try {
      const raw = this._deps.prefGet(this.STATS_PREF, "");
      const obj = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) { return {}; }
  },

  /* ================= 工具 ================= */

  formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  },
};
