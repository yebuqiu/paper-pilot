// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 订阅落地桥（0.71.0）
 *
 * 为什么需要这一层：检索订阅（search-subs.js）走的是「OpenAlex / Crossref 接口检索 +
 * 自动入库」，而用户脑子里的「订阅」是 Zotero 左侧那个【订阅】（原生 RSS，Feeds）。
 * 两套机制不相通 —— 在设置里订阅了期刊，左侧却什么都没有，用户视角就是「订阅了没用」。
 *
 * 本模块把一条订阅同时落到两个用户能看见的地方：
 *   A. 库内分类树「订阅期刊 / <刊名>」：入库时自动归类，覆盖 100%（中文刊同样有效），
 *      点开就是这本刊的新文章，离线可用，不依赖任何外网 RSS。
 *   B. Zotero 原生 RSS 源（左侧【订阅】）：只有能解析到真实 RSS 的刊才会出现
 *      （Elsevier / Nature / Science / BMJ / PNAS / NEJM / 知网 等有规可循的刊）。
 *
 * 三条铁律：
 *   ① 绝不阻塞入库：attach() 失败只记日志，条目照常保存（入库是主业务，归类是增强）。
 *   ② 绝不重复建：分类按名字复用，RSS 源按 URL 去重（Zotero.Feeds.existsByURL）。
 *   ③ 绝不删用户数据：取消订阅只停止后续归类，已有的分类与文章原样保留。
 *
 * 依赖：Zotero.Collections / Zotero.Feeds / Zotero.FeedReader（Z10.0.3 实测可用）。
 * 排障：Zotero.Papilot.subsBridge.selfTest() —— 纯本地只读，返回各环节能力探测结果。
 */

/* global Zotero */

var SubsBridge = {
  /* ================== 常量 ================== */

  /** 父分类名（用户可在设置面板改，但默认就这一个） */
  PARENT_NAME: "订阅期刊",

  /** 与 search-subs.js 保持一致的入库标签前缀（回填靠它找回历史条目） */
  TAG_PREFIX: "#订阅/",

  /** RSS 探测上限：单条候选最多等这么久，超时即放弃（不拖垮订阅流程） */
  PROBE_TIMEOUT: 12000,

  /* ================== 期刊订阅识别 ================== */

  /**
   * 一条订阅是不是「期刊订阅」：有 ISSN 或有刊名才算。
   * 主题订阅（关键词 / 分类 / 作者）不进分类树，也不挂 RSS。
   */
  isJournalSub(sub) {
    if (!sub) return false;
    const issns = Array.isArray(sub.issns) ? sub.issns.filter(Boolean) : [];
    const journals = Array.isArray(sub.journals) ? sub.journals.filter(Boolean) : [];
    return issns.length > 0 || journals.length > 0;
  },

  /**
   * 订阅 → 期刊列表 [{name, issn}]（两者一般 1:1，也兼容手工填了多本的订阅）
   * 没有 issns 的老订阅用订阅名兜底（用户按刊名建的）。
   */
  journalsOf(sub) {
    if (!this.isJournalSub(sub)) return [];
    const issns = (sub.issns || []).map((x) => String(x || "").trim()).filter(Boolean);
    const names = (sub.journals || []).map((x) => String(x || "").trim()).filter(Boolean);
    const n = Math.max(names.length, issns.length, 1);
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = names[i] || names[0] || String(sub.name || "").trim();
      const issn = issns[i] || issns[0] || "";
      if (!name && !issn) continue;
      out.push({ name: name || issn, issn: issn });
    }
    return out;
  },

  /** 分类名净化：Zotero 分类名允许很宽，但去掉换行与控制字符，帽长 60 */
  collectionName(j) {
    let s = String((j && j.name) || "").replace(/[\r\n\t]+/g, " ").trim();
    if (!s) s = String((j && j.issn) || "").trim() || "未命名期刊";
    return s.slice(0, 60);
  },

  /* ================== A. 库内分类 ================== */

  _libID() {
    try {
      const id = Zotero.Libraries.userLibraryID;
      if (typeof id === "number") return id;
    } catch (e) { /* ignore */ }
    return 1;
  },

  /** 父分类「订阅期刊」：有就复用，没有就建（只查顶层，避免误用同名子分类） */
  _parentCollection() {
    const libID = this._libID();
    const all = Zotero.Collections.getByLibrary(libID, true, false) || [];
    const hit = all.find((c) => c && c.name === this.PARENT_NAME && !c.parentID);
    if (hit) return hit;
    return null;
  },

  async _ensureParent() {
    const exist = this._parentCollection();
    if (exist) return exist;
    const col = new Zotero.Collection();
    col.libraryID = this._libID();
    col.name = this.PARENT_NAME;
    await col.saveTx();
    return col;
  },

  /** 子分类：同名复用；没有则挂到父分类下新建 */
  async _ensureChild(parent, name) {
    const kids = (parent.getChildCollections && parent.getChildCollections()) || [];
    const hit = kids.find((c) => c && c.name === name);
    if (hit) return hit;
    const col = new Zotero.Collection();
    col.libraryID = this._libID();
    col.name = name;
    // ★ 必须走 parentKey：Collection._initSave 只认 this._parentKey，
    //   直接赋 parentID 会被忽略（源头实测），结果全建成了顶层分类。
    col.parentKey = parent.key;
    await col.saveTx();
    return col;
  },

  /**
   * 给一批订阅准备好分类（幂等）。
   * @returns {Promise<{ok:boolean, created:number, total:number, names:string[]}>}
   */
  async ensureCollections(subs) {
    const list = (Array.isArray(subs) ? subs : []).filter((s) => this.isJournalSub(s));
    if (!list.length) return { ok: true, created: 0, total: 0, names: [] };
    let parent = null;
    try {
      parent = await this._ensureParent();
    } catch (e) {
      this._log("ensureCollections: 父分类创建失败", e);
      return { ok: false, created: 0, total: list.length, names: [], error: String((e && e.message) || e) };
    }
    const before = (parent.getChildCollections && parent.getChildCollections()) || [];
    const seen = new Set(before.map((c) => c && c.name));
    let created = 0;
    const names = [];
    for (const sub of list) {
      for (const j of this.journalsOf(sub)) {
        const name = this.collectionName(j);
        names.push(name);
        if (seen.has(name)) continue;
        try {
          await this._ensureChild(parent, name);
          seen.add(name);
          created++;
        } catch (e) {
          this._log("ensureCollections: 子分类创建失败 " + name, e);
        }
      }
    }
    return { ok: true, created: created, total: names.length, names: names, parentKey: parent.key };
  },

  /** 找某本刊的分类（不存在返回 null，不建） */
  collectionFor(sub) {
    const j = this.journalsOf(sub)[0];
    if (!j) return null;
    const parent = this._parentCollection();
    if (!parent) return null;
    const name = this.collectionName(j);
    const kids = (parent.getChildCollections && parent.getChildCollections()) || [];
    return kids.find((c) => c && c.name === name) || null;
  },

  /**
   * 入库后归类（核心钩子）。幂等：已在分类里就什么都不做。
   * @param {Zotero.Item|number} itemOrID
   * @param {object} sub 来源订阅
   * @returns {Promise<boolean>} 是否真的加进去了（false = 跳过或失败）
   */
  async attachItem(itemOrID, sub) {
    if (!this.isJournalSub(sub)) return false;
    let item = itemOrID;
    try {
      if (typeof itemOrID === "number") item = await Zotero.Items.getAsync(itemOrID);
    } catch (e) { item = null; }
    if (!item || !item.id) return false;
    try {
      let col = this.collectionFor(sub);
      if (!col) {
        const parent = await this._ensureParent();
        col = await this._ensureChild(parent, this.collectionName(this.journalsOf(sub)[0]));
      }
      // ★ 走 Collection.addItem（必须在事务里；它自己维护 childItems 缓存与 collectionItems
      //   表）。反过来用 item.addToCollection + item.saveTx 也能落库，但要额外保存条目、
      //   会改 dateModified，而且新条目刚 saveTx 过，重复保存没有必要。
      const have = new Set(((col.getChildItems && col.getChildItems()) || []).map((it) => (it && it.id) || it));
      if (have.has(item.id)) return false;
      await Zotero.DB.executeTransaction(async () => {
        await col.addItem(item.id, { skipDateModifiedUpdate: true });
      });
      return true;
    } catch (e) {
      // 归类失败绝不打断入库
      this._log("attachItem failed", e);
      return false;
    }
  },

  /**
   * 回填：把历史上已入库（带 `#订阅/<名字>` 标签）的条目补进对应分类。
   * 用户升级到本版本后点一次「同步左侧分类」即可，之后由 attachItem 增量维护。
   * @returns {Promise<{ok:boolean, moved:number, scanned:number, byName:object}>}
   */
  async backfill(subs) {
    const list = (Array.isArray(subs) ? subs : []).filter((s) => this.isJournalSub(s));
    if (!list.length) return { ok: true, moved: 0, scanned: 0, byName: {} };
    let parent = null;
    try {
      parent = await this._ensureParent();
    } catch (e) {
      return { ok: false, moved: 0, scanned: 0, byName: {}, error: String((e && e.message) || e) };
    }
    let moved = 0;
    let scanned = 0;
    const byName = {};
    for (const sub of list) {
      const j = this.journalsOf(sub)[0];
      if (!j) continue;
      const name = this.collectionName(j);
      const tag = this.TAG_PREFIX + this._safeName(sub.name || j.name);
      let ids = [];
      try {
        ids = await this._itemsByTag(tag);
      } catch (e) {
        this._log("backfill: 按标签查询失败 " + tag, e);
        continue;
      }
      scanned += ids.length;
      if (!ids.length) continue;
      let col = null;
      try {
        col = await this._ensureChild(parent, name);
      } catch (e) {
        this._log("backfill: 分类创建失败 " + name, e);
        continue;
      }
      const have = new Set(((col.getChildItems && col.getChildItems()) || []).map((it) => (it && it.id) || it));
      let add = [];
      for (const id of ids) if (!have.has(id)) add.push(id);
      if (!add.length) continue;
      try {
        await Zotero.DB.executeTransaction(async () => {
          for (const id of add) await col.addItem(id, { skipDateModifiedUpdate: true });
        });
        moved += add.length;
        byName[name] = add.length;
      } catch (e) {
        this._log("backfill: 归类失败 " + name, e);
      }
    }
    return { ok: true, moved: moved, scanned: scanned, byName: byName };
  },

  /** 按标签查条目 id（走 Zotero.Search，不拉全库） */
  async _itemsByTag(tag) {
    const s = new Zotero.Search();
    s.libraryID = this._libID();
    s.addCondition("tag", "is", tag);
    const ids = await s.search();
    return (ids || []).map((x) => (typeof x === "number" ? x : x && x.id)).filter((x) => typeof x === "number");
  },

  /** 与 search-subs._safeName 同规则（标签名归一，回填要按它反查） */
  _safeName(name) {
    let s = String(name == null ? "" : name)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[\/\:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    return s.slice(0, 24) || "未命名订阅";
  },

  /* ================== B. 原生 RSS（左侧【订阅】） ================== */

  /** ISSN → 纯数字（Elsevier 的 RSS 路径只吃数字） */
  _issnDigits(issn) {
    return String(issn || "").replace(/[^0-9Xx]/g, "").replace(/x/g, "X");
  },

  /**
   * 候选 RSS 地址（纯函数，可单测）。只放**有规可循**的来源，按命中概率排序：
   *   ① Elsevier / ScienceDirect：按 ISSN 拼路径（实测 200 + 真实 RSS）
   *   ② Nature Portfolio：nature.com/<slug>.rss（slug 表）
   *   ③ AAAS Science / BMJ / PNAS / NEJM：各自固定路径（按 ISSN 认刊）
   *   ④ 中国知网：navi.cnki.net/knavi/rss/<刊号>（刊号表，见 CNKI_CODES）
   *   ⑤ 订阅里手工存的 rssUrl（用户在面板里填过的优先）
   * 任何一条都不保证可用 —— 真伪由 probeFeed 现场验证。
   */
  feedCandidates(sub) {
    const out = [];
    const push = (u) => {
      if (u && out.indexOf(u) === -1) out.push(u);
    };
    if (sub && sub.rssUrl) push(String(sub.rssUrl).trim());

    const js = this.journalsOf(sub);
    for (const j of js) {
      const digits = this._issnDigits(j.issn);
      const name = String(j.name || "").trim();
      const low = name.toLowerCase();

      // ① Elsevier：绝大多数 Cell/Lancet 系与 Elsevier 自有刊都能命中
      if (digits.length === 8) push("https://rss.sciencedirect.com/publication/science/" + digits);

      // ② Nature Portfolio（slug 表；不在表里的 Nature 系刊会在 probe 阶段自然失败）
      const slug = this.NATURE_SLUGS[low];
      if (slug) push("https://www.nature.com/" + slug + ".rss");

      // ③ 固定路径的几家（按 ISSN 认刊，避免中文别名/写法差异导致漏配）
      const idKey = digits;
      for (const [issn, url] of this.FIXED_FEEDS) {
        if (issn === idKey) push(url);
      }

      // ④ 知网（中文刊主要靠这条；刊号表命中率有限，未命中的可用面板手填）
      const cn = this._cnkiCode(j, sub && sub.name);
      if (cn) push("https://navi.cnki.net/knavi/rss/" + cn);
    }
    return out;
  },

  /**
   * 知网 navi 刊号：三条路依次试
   *   ① 按 ISSN（最稳，订阅来自目录时一定有）
   *   ② 按中文名（用户手工按中文名建的订阅）
   *   ③ 按内置目录里的中文别名（目录条目的 name 多是英文/拼音，别名才是「中草药」）
   * 真机实证：Zhongcaoyao 只能靠 ①/③ 命中（订阅名是拼音）。
   */
  _cnkiCode(j, subName) {
    const issn = this._issnDigits(j && j.issn);
    if (issn && this.CNKI_BY_ISSN[issn]) return this.CNKI_BY_ISSN[issn];
    const names = [j && j.name, subName].map((x) => String(x || "").trim()).filter(Boolean);
    for (const n of names) if (this.CNKI_CODES[n]) return this.CNKI_CODES[n];
    for (const alias of this._catalogAliases(issn)) {
      if (this.CNKI_CODES[alias]) return this.CNKI_CODES[alias];
    }
    return "";
  },

  /** 内置目录里该 ISSN 的别名（zh 名）；目录缺位时返回空数组 */
  _catalogAliases(issn) {
    if (!issn) return [];
    try {
      const cat = (typeof JournalCatalog !== "undefined" && JournalCatalog) ? JournalCatalog : null;
      if (!cat || !Array.isArray(cat.list)) return [];
      const row = cat.list.find((x) => x && String(x.i || "").replace(/[^0-9Xx]/g, "") === issn);
      if (!row || !row.a) return [];
      return String(row.a).split("|").map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      return [];
    }
  },

  /** 期刊名 → nature.com 路径 slug（只放确定可用的，宁缺勿错） */
  NATURE_SLUGS: {
    "nature": "nature",
    "nature medicine": "nm",
    "nature neuroscience": "nn",
    "nature immunology": "ni",
    "nature genetics": "ng",
    "nature cell biology": "ncb",
    "nature communications": "ncomms",
    "nature chemistry": "nchem",
    "nature physics": "nphys",
    "nature materials": "nmat",
    "nature biotechnology": "nbt",
    "nature methods": "nmeth",
    "nature chemical biology": "nchembio",
    "nature reviews cancer": "nrc",
    "nature reviews immunology": "nri",
    "nature reviews drug discovery": "nrd",
    "nature reviews molecular cell biology": "nrm",
    "nature reviews neuroscience": "nrn",
    "nature reviews genetics": "nrg",
    "nature human behaviour": "nhumbehav",
    "nature ecology & evolution": "s41559",
    "nature sustainability": "nsustain",
    "nature climate change": "nclimate",
    "nature energy": "nenergy",
    "nature electronics": "nelec",
    "nature photonics": "nphoton",
    "nature nanotechnology": "nnano",
    "nature machine intelligence": "nmi",
    "scientific reports": "srep",
    "cell research": "cr",
  },

  /** 固定路径的刊（ISSN → 地址），全部是「一家刊一个 RSS」的平台 */
  FIXED_FEEDS: [
    ["00368075", "https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science"],
    ["10959203", "https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science"],
    ["09598138", "https://www.bmj.com/rss/recent.xml"],
    ["17561833", "https://www.bmj.com/rss/recent.xml"],
    ["00278424", "https://www.pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas"],
    ["10916490", "https://www.pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas"],
    ["00284793", "https://www.nejm.org/action/showFeed?type=etoc&feed=rss&jc=nejm"],
    ["15334406", "https://www.nejm.org/action/showFeed?type=etoc&feed=rss&jc=nejm"],
  ],

  /** 中文刊 → 知网 navi 刊号（实测可用的放这里；其余靠手填） */
  CNKI_CODES: {
    "中草药": "ZCYO",
    "中华心血管病杂志": "ZHXX",
    "中国中药杂志": "ZGZY",
  },

  /** ISSN（纯数字）→ 知网刊号：订阅名是拼音/英文时唯一可靠的路（Zhongcaoyao 实测） */
  CNKI_BY_ISSN: {
    "02532670": "ZCYO",
  },

  /** 现场验证：能解析成 feed 且拿得到标题才算数 */
  async probeFeed(url) {
    if (!url || !Zotero.FeedReader) return null;
    let fr = null;
    try {
      fr = new Zotero.FeedReader(url);
      const timeout = new Promise((resolve) => {
        try { setTimeout(() => resolve("timeout"), this.PROBE_TIMEOUT); } catch (e) { resolve("timeout"); }
      });
      const done = (async () => { await fr.process(); return "ok"; })();
      const r = await Promise.race([done, timeout]);
      if (r !== "ok") {
        try { fr.terminate(); } catch (e) { /* ignore */ }
        return null;
      }
      const props = fr.feedProperties || {};
      const title = String(props.title || "").trim();
      if (!title) return null;
      return { url: url, title: title, ttl: props.ttl || 0 };
    } catch (e) {
      try { if (fr) fr.terminate(); } catch (err) { /* ignore */ }
      return null;
    }
  },

  /** 逐个候选试，第一条能解析的就用（全部失败返回 null，不抛） */
  async resolveFeed(sub) {
    const urls = this.feedCandidates(sub);
    for (const u of urls) {
      const r = await this.probeFeed(u);
      if (r) return r;
    }
    return null;
  },

  /** 这台机器上是否已经有这个 RSS 源（按 URL 去重，含用户手工加过的） */
  feedExists(url) {
    try {
      if (typeof Zotero.Feeds.existsByURL === "function") return !!Zotero.Feeds.existsByURL(url);
    } catch (e) { /* ignore */ }
    try {
      return !!(Zotero.Feeds.getByURL(url));
    } catch (e) { return false; }
  },

  /**
   * 把一条期刊订阅挂成 Zotero 原生 RSS 源（左侧【订阅】里多一条）。
   * 已在的不重复建；解析不到的如实返回 no-feed（不算失败）。
   * @returns {Promise<{ok:boolean, url?:string, name?:string, existed?:boolean, reason?:string}>}
   */
  async ensureFeed(sub) {
    if (!this.isJournalSub(sub)) return { ok: false, reason: "not-journal" };
    const j = this.journalsOf(sub)[0] || {};
    const wantName = String(sub.name || j.name || "").trim() || "订阅";

    // 先看用户手工填的地址 / 已知候选里有没有已经在用的，避免重复建源
    for (const u of this.feedCandidates(sub)) {
      if (u && this.feedExists(u)) {
        return { ok: true, url: u, name: wantName, existed: true };
      }
    }

    const r = await this.resolveFeed(sub);
    if (!r) return { ok: false, reason: "no-feed" };
    if (this.feedExists(r.url)) return { ok: true, url: r.url, name: wantName, existed: true };

    try {
      const feed = new Zotero.Feed();
      feed.url = r.url;
      // 源名用期刊名（feed 自带标题常带 "-CNKI"/"- nature.com" 之类后缀，
      // 左侧列表里一行一个刊名更好认）
      feed.name = wantName;
      await feed.saveTx();
      // 拉首屏条目：失败不影响源已建立（Zotero 会在下一次定时检查时重试）
      try { await feed.updateFeed(); } catch (e) { this._log("updateFeed failed " + r.url, e); }
      return { ok: true, url: r.url, name: wantName, title: r.title };
    } catch (e) {
      this._log("ensureFeed: 建源失败 " + r.url, e);
      return { ok: false, reason: "save-failed", error: String((e && e.message) || e) };
    }
  },

  /* ================== 组合入口 ================== */

  /**
   * 一次把一批订阅落到「分类 + RSS」。
   * @param {object[]} subs
   * @param {object} [opts] {feeds?:boolean=true, backfill?:boolean=false}
   * @returns {Promise<object>} 汇总（面板直接拿去显示）
   */
  async sync(subs, opts) {
    const o = opts || {};
    const list = (Array.isArray(subs) ? subs : []).filter((s) => this.isJournalSub(s));
    const out = { ok: true, total: list.length, collections: null, backfill: null, feeds: [] };
    if (!list.length) return out;
    try { out.collections = await this.ensureCollections(list); }
    catch (e) { out.collections = { ok: false, error: String((e && e.message) || e) }; }
    if (o.backfill) {
      try { out.backfill = await this.backfill(list); }
      catch (e) { out.backfill = { ok: false, error: String((e && e.message) || e) }; }
    }
    if (o.feeds !== false) {
      for (const sub of list) {
        try {
          const r = await this.ensureFeed(sub);
          out.feeds.push({ sub: sub.id, name: sub.name, ok: !!r.ok, existed: !!r.existed, url: r.url || "", reason: r.reason || "" });
        } catch (e) {
          out.feeds.push({ sub: sub.id, name: sub.name, ok: false, reason: "error" });
        }
      }
    }
    return out;
  },

  /** 面板状态：几本刊有分类、几个有 RSS（只读，不建东西） */
  status(subs) {
    const list = (Array.isArray(subs) ? subs : []).filter((s) => this.isJournalSub(s));
    let withCol = 0;
    let withFeed = 0;
    for (const sub of list) {
      try { if (this.collectionFor(sub)) withCol++; } catch (e) { /* ignore */ }
      try {
        const urls = this.feedCandidates(sub);
        if (urls.some((u) => this.feedExists(u))) withFeed++;
      } catch (e) { /* ignore */ }
    }
    return { total: list.length, withCol: withCol, withFeed: withFeed };
  },

  /* ================== 排障 ================== */

  /** 能力自检（纯本地、只读、不建任何东西）：真机第一次排查先看这个 */
  selfTest() {
    const caps = {
      collections: !!(Zotero && Zotero.Collections && typeof Zotero.Collections.getByLibrary === "function"),
      feeds: !!(Zotero && Zotero.Feeds && typeof Zotero.Feeds.existsByURL === "function"),
      feedReader: !!(Zotero && typeof Zotero.FeedReader === "function"),
      feedCtor: !!(Zotero && typeof Zotero.Feed === "function"),
      db: !!(Zotero && Zotero.DB && typeof Zotero.DB.executeTransaction === "function"),
    };
    let parent = null;
    try { parent = this._parentCollection(); } catch (e) { /* ignore */ }
    const out = {
      caps: caps,
      parentName: this.PARENT_NAME,
      parentExists: !!parent,
      parentChildren: parent ? (((parent.getChildCollections && parent.getChildCollections()) || []).map((c) => c.name)) : [],
      libID: this._libID(),
      ok: caps.collections && caps.feeds && caps.feedReader && caps.feedCtor,
    };
    Zotero.debug("[Papilot] subsBridge selfTest " + JSON.stringify(out));
    return out;
  },

  _log(msg, err) {
    try {
      Zotero.debug("[Papilot] subsBridge: " + msg + (err ? " :: " + ((err && err.message) || err) : ""));
    } catch (e) { /* ignore */ }
  },
};
