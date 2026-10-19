// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 笔记关系图谱（0.23.0，路线图阶段 2 第二批）
 * 解决的问题：Papilot 能「生成笔记」（AI 总结/解读/模板/批注），但笔记之间
 * 是孤岛——用户看不到「我的笔记彼此怎么关联、哪条笔记是枢纽」。
 *
 * 本模块做三件事：
 *  1. **抽取链接**：从笔记 HTML 里解析 Zotero 内部链接与 wiki 链接
 *       zotero://select/library/items/<KEY>     → 指向条目
 *       zotero://select/groups/<gid>/items/<KEY> → 指向群组条目
 *       zotero://open-pdf/library/items/<KEY>    → 指向附件（归并到其父条目）
 *       zotero://note/u/<KEY>                    → 指向另一条笔记
 *       [[笔记标题]]                              → 按标题匹配笔记（better-notes 风格）
 *  2. **构图**：节点 = 条目 + 笔记；边 = 归属（笔记→父条目）+ 链接（笔记→条目/笔记）
 *  3. **布局**：确定性初始化的力导向布局（Fruchterman-Reingold 简化版），
 *     输出坐标给 SVG 渲染；纯函数、无 DOM 依赖，便于单测。
 *
 * 硬约束：只读。不修改任何笔记内容，不做「自动建链」这类有副作用的操作。
 */
/* global Zotero, Services, Prefs, I18n */

var NoteGraph = {
  MAX_NODES: 400, // 渲染上限（超出截断并在 UI 提示，避免几千节点把窗口拖死）

  /* ================== 链接抽取（纯函数） ================== */

  RE: {
    item: /zotero:\/\/select\/(?:groups\/\d+\/)?(?:library\/)?items\/([A-Za-z0-9]{8})/g,
    pdf: /zotero:\/\/open-pdf\/(?:groups\/\d+\/)?(?:library\/)?items\/([A-Za-z0-9]{8})/g,
    note: /zotero:\/\/note\/u\/([A-Za-z0-9]{8})/g,
    wiki: /\[\[([^\[\]\n]{1,120})\]\]/g,
  },

  /** HTML → 纯文本（只用于标题比对与展示，不做富文本处理） */
  stripHtml(html) {
    return String(html == null ? "" : html)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  },

  /**
   * 从一段笔记 HTML 抽取全部链接
   * @returns {{items:string[], pdfs:string[], notes:string[], wiki:string[]}}
   */
  extractLinks(html) {
    const src = String(html == null ? "" : html);
    const grab = (re) => {
      const out = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        if (m[1]) out.push(m[1]);
      }
      return out;
    };
    const uniq = (a) => [...new Set(a)];
    return {
      items: uniq(grab(this.RE.item)),
      pdfs: uniq(grab(this.RE.pdf)),
      notes: uniq(grab(this.RE.note)),
      wiki: uniq(grab(this.RE.wiki).map((s) => s.trim()).filter(Boolean)),
    };
  },

  /* ================== 构图（纯函数） ================== */

  /**
   * @param {Array} records 记录数组：
   *   { key, kind: "item"|"note", title, parentKey?, html?, collection?, year? }
   * @param {{maxNodes?:number, wikiMatch?:boolean}} opts
   * @returns {{nodes:Array, edges:Array, truncated:boolean, stats:object}}
   */
  buildGraph(records, opts) {
    const o = opts || {};
    const max = o.maxNodes || this.MAX_NODES;
    const byKey = new Map();
    for (const r of records || []) {
      if (!r || !r.key) continue;
      if (!byKey.has(r.key)) byKey.set(r.key, r);
    }
    // wiki 标题索引（仅用于 [[标题]] 匹配，重名取第一个）
    const byTitle = new Map();
    if (o.wikiMatch !== false) {
      for (const r of byKey.values()) {
        const t = String(r.title || "").trim();
        if (t && !byTitle.has(t)) byTitle.set(t, r.key);
      }
    }

    const edges = [];
    const edgeSeen = new Set();

    const addEdge = (from, to, type, label) => {
      if (!from || !to || from === to) return;
      const id = from + ">" + to + ":" + type;
      if (edgeSeen.has(id)) return;
      edgeSeen.add(id);
      edges.push({ source: from, target: to, type, label: label || "" });
    };

    for (const r of byKey.values()) {
      // ① 归属边：笔记 → 其父条目
      if (r.kind === "note" && r.parentKey) addEdge(r.key, r.parentKey, "parent");
      if (r.kind !== "note") continue;
      // ② 链接边：笔记 → 条目 / 附件（归并到父条目）/ 笔记 / wiki 标题命中的笔记
      const links = this.extractLinks(r.html);
      for (const k of links.items) addEdge(r.key, k, "link");
      for (const k of links.pdfs) {
        const att = byKey.get(k);
        const target = att && att.parentKey ? att.parentKey : k;
        addEdge(r.key, target, "pdf");
      }
      for (const k of links.notes) addEdge(r.key, k, "note");
      for (const title of links.wiki) {
        const k = byTitle.get(String(title).trim());
        if (k) addEdge(r.key, k, "wiki");
      }
    }

    // 附件只作为「pdf 链接 → 父条目」的解析中介，不进入图谱（否则节点被无意义地翻倍）
    const visible = [...byKey.values()].filter((r) => r.kind !== "attachment");
    const visibleKeys = new Set(visible.map((r) => r.key));
    // 剪掉悬空边：端点不在可见节点集合里的边（如指向群组库条目、或已过滤的附件）一律丢弃
    const keptEdges = edges.filter((e) => visibleKeys.has(e.source) && visibleKeys.has(e.target));
    const deg2 = new Map();
    for (const e of keptEdges) {
      deg2.set(e.source, (deg2.get(e.source) || 0) + 1);
      deg2.set(e.target, (deg2.get(e.target) || 0) + 1);
    }
    edges.length = 0;
    edges.push(...keptEdges);

    let nodes = visible.map((r) => ({
      key: r.key,
      kind: r.kind,
      title: r.title || "",
      parentKey: r.parentKey || "",
      year: r.year || "",
      collection: r.collection || "",
      degree: deg2.get(r.key) || 0,
    }));
    const total = nodes.length;
    let truncated = false;
    if (nodes.length > max) {
      // 截断策略：先按连接度降序（保留枢纽），再按 key 稳定排序，保证结果确定
      nodes.sort((a, b) => (b.degree - a.degree) || a.key.localeCompare(b.key));
      nodes = nodes.slice(0, max);
      truncated = true;
      const keep = new Set(nodes.map((n) => n.key));
      for (let i = edges.length - 1; i >= 0; i--) {
        if (!keep.has(edges[i].source) || !keep.has(edges[i].target)) edges.splice(i, 1);
      }
    }
    const linked = nodes.filter((n) => n.degree > 0).length;
    return {
      nodes, edges, truncated,
      stats: {
        total, shown: nodes.length, edges: edges.length, linked,
        orphans: nodes.length - linked,
        maxDegree: nodes.reduce((m, n) => Math.max(m, n.degree), 0),
      },
    };
  },

  /* ================== 布局（纯函数） ================== */

  /**
   * 力导向布局（确定性：初始位置按索引分布，随机数用固定种子 LCG）
   * @returns {Map<string,{x:number,y:number}>}
   */
  layout(nodes, edges, opts) {
    const o = opts || {};
    const W = o.width || 900;
    const H = o.height || 620;
    const iterations = o.iterations || 260;
    const n = (nodes || []).length;
    const pos = new Map();
    if (!n) return pos;
    // 固定种子伪随机（保证同样输入得同样图，便于截图对比与测试）
    let seed = 20261003;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // 初始：按黄金角螺旋铺开，避免全部堆在中心
    nodes.forEach((node, i) => {
      const a = i * 2.399963;
      const r = Math.sqrt(i + 1) / Math.sqrt(n) * Math.min(W, H) * 0.45;
      pos.set(node.key, { x: W / 2 + Math.cos(a) * r + (rnd() - 0.5) * 4, y: H / 2 + Math.sin(a) * r + (rnd() - 0.5) * 4 });
    });
    const idx = new Map(nodes.map((nd, i) => [nd.key, i]));
    const k = Math.sqrt((W * H) / n) * 0.62;   // 理想边长
    const temp0 = Math.min(W, H) * 0.12;
    let temp = temp0;
    const disp = new Array(n).fill(0).map(() => ({ x: 0, y: 0 }));
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) { disp[i].x = 0; disp[i].y = 0; }
      // 斥力 O(n²)：n≤400 时约 16 万次/轮 × 260 轮偏重，故按需降轮次
      for (let i = 0; i < n; i++) {
        const pi = pos.get(nodes[i].key);
        for (let j = i + 1; j < n; j++) {
          const pj = pos.get(nodes[j].key);
          let dx = pi.x - pj.x, dy = pi.y - pj.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = (rnd() - 0.5) * 0.1; dy = (rnd() - 0.5) * 0.1; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const f = (k * k) / d;
          const ux = dx / d, uy = dy / d;
          disp[i].x += ux * f; disp[i].y += uy * f;
          disp[j].x -= ux * f; disp[j].y -= uy * f;
        }
      }
      // 引力（沿边）
      for (const e of edges || []) {
        const a = idx.get(e.source), b = idx.get(e.target);
        if (a === undefined || b === undefined) continue;
        const pa = pos.get(e.source), pb = pos.get(e.target);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
        const f = (d * d) / k;
        const ux = dx / d, uy = dy / d;
        disp[a].x -= ux * f; disp[a].y -= uy * f;
        disp[b].x += ux * f; disp[b].y += uy * f;
      }
      for (let i = 0; i < n; i++) {
        const p = pos.get(nodes[i].key);
        const d = Math.max(0.01, Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y));
        const lim = Math.min(d, temp);
        p.x += (disp[i].x / d) * lim;
        p.y += (disp[i].y / d) * lim;
        // 轻度向心力：连接度越低的节点被拉回中心越明显——否则孤立节点会被斥力
        // 顶到画布边缘、沿边界排成一条直线，图像观感很差
        const pull = 0.02 / (1 + Math.min(8, nodes[i].degree));
        p.x += (W / 2 - p.x) * pull;
        p.y += (H / 2 - p.y) * pull;
        p.x = Math.min(W - 30, Math.max(30, p.x));
        p.y = Math.min(H - 24, Math.max(24, p.y));
      }
      temp = Math.max(temp0 * 0.02, temp * 0.965);
    }
    return pos;
  },

  /* ================== 数据采集 ================== */

  /** 采集范围内条目与其笔记（分类优先，否则全库） */
  async collect(opts) {
    const o = opts || {};
    const max = o.maxNodes || this.MAX_NODES;
    const records = [];
    let scopeName = I18n.isZh ? "全库" : "Whole library";
    const zp = Zotero.getActiveZoteroPane();
    let items = [];
    let col = null;
    try { col = zp && zp.getSelectedCollections && zp.getSelectedCollections()[0]; } catch (e) { col = null; }
    if (o.useCollection && col) {
      scopeName = (I18n.isZh ? "分类「" : "Collection \"") + col.name + "」";
      const children = (col.getChildItems ? col.getChildItems() : []) || [];
      for (const it of children) if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) items.push(it);
    } else {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("itemType", "isNot", "attachment");
      for (const id of await s.search()) {
        const it = await Zotero.Items.getAsync(id);
        if (it && !it.deleted && it.isRegularItem && it.isRegularItem()) items.push(it);
      }
    }
    // 节点预算的一半给条目，另一半给笔记（笔记通常远多于 1:1）
    const itemBudget = Math.max(20, Math.floor(max * 0.45));
    if (items.length > itemBudget) {
      // 只保留「有笔记」的条目优先，保证图谱有意义
      const withNotes = [];
      const others = [];
      for (const it of items) {
        let n = 0;
        try { n = (it.getNotes() || []).length; } catch (e) { n = 0; }
        (n ? withNotes : others).push(it);
      }
      items = withNotes.concat(others).slice(0, itemBudget);
    }
    const collectionOf = (it) => {
      try {
        const ids = it.getCollections() || [];
        const c = ids.length ? Zotero.Collections.get(ids[0]) : null;
        return c ? c.name : "";
      } catch (e) { return ""; }
    };
    const yearOf = (it) => {
      try { const m = String(it.getField("date") || "").match(/(\d{4})/); return m ? m[1] : ""; } catch (e) { return ""; }
    };
    for (const it of items) {
      records.push({
        key: it.key, kind: "item", title: (() => { try { return it.getDisplayTitle() || ""; } catch (e) { return ""; } })(),
        year: yearOf(it), collection: collectionOf(it),
      });
      let noteIDs = [];
      try { noteIDs = it.getNotes() || []; } catch (e) { noteIDs = []; }
      for (const nid of noteIDs) {
        let note = null;
        try { note = Zotero.Items.get(nid); } catch (e) { note = null; }
        if (!note) continue;
        let title = "";
        try { title = note.getNoteTitle ? note.getNoteTitle() : ""; } catch (e) { title = ""; }
        let html = "";
        try { html = note.getNote() || ""; } catch (e) { html = ""; }
        records.push({ key: note.key, kind: "note", title: title || this.stripHtml(html).slice(0, 40), parentKey: it.key, html });
      }
      // 附件记录：只用于把笔记里的 `zotero://open-pdf/.../items/<附件KEY>` 链接
      // 解析回它所属的条目（不进入图谱节点，见 buildGraph）
      let attIDs = [];
      try { attIDs = it.getAttachments() || []; } catch (e) { attIDs = []; }
      for (const aid of attIDs) {
        let att = null;
        try { att = Zotero.Items.get(aid); } catch (e) { att = null; }
        if (!att || !att.key) continue;
        records.push({ key: att.key, kind: "attachment", title: "", parentKey: it.key });
      }
    }
    return { records, scopeName, itemCount: items.length };
  },

  async build(opts) {
    const { records, scopeName, itemCount } = await this.collect(opts);
    const g = this.buildGraph(records, opts);
    g.scopeName = scopeName;
    g.itemCount = itemCount;
    g.positions = this.layout(g.nodes, g.edges, opts);
    return g;
  },

  /** 入口：打开图谱窗口 */
  openDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const en = Services.wm.getEnumerator("papilot:notegraph");
      if (en.hasMoreElements()) { const w = en.getNext(); w.focus(); return w; }
    } catch (e) { /* ignore */ }
    return win.openDialog(
      "chrome://papilot/content/note-graph.xhtml",
      "papilot-note-graph",
      "chrome,centerscreen,resizable,dialog=no",
      { Zotero, Services }
    );
  },

  /** 在 Zotero 主窗口定位节点（UI 用） */
  reveal(key) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
      if (!item) return false;
      const zp = Zotero.getActiveZoteroPane();
      if (zp && zp.selectItem) zp.selectItem(item.id);
      const win = Zotero.getMainWindow();
      if (win) win.focus();
      return true;
    } catch (e) { return false; }
  },
};
