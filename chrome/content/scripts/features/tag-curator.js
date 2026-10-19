// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 标签治理（0.22.0）
 * 背景：AI 打标 + 手动打标并用后，标签必然出现「同一含义多种写法」——
 * 大小写（DNN/dnn）、全半角（机器学习／机器学习）、空格与连字符
 * （deep learning / deep-learning）、尾随标点等。标签一乱，按标签筛选
 * 与统计就失真，且越积越多不可收拾。
 *
 * 本模块只做三件事，全部为**只读扫描 + 用户确认后的归一**：
 *  1. 变体检测：按 shape key（忽略大小写/全半角/空白/连字符）聚类，
 *     组内 ≥2 种写法即判为变体组，建议合并到「条目最多」的那种写法；
 *  2. 罕见标签：只被 1 篇使用（多为误输入或一次性标记），仅报告不处理；
 *  3. 层级缺失：存在 `父/子` 形式标签但没有 `父` 本身，仅报告。
 *
 * 设计约束（沿用项目纪律）：
 *  - 破坏性操作必须「预览 → 确认」：run(false) 出报告不改动任何数据，
 *    run(true) 才执行归一，且执行前弹确认框（含影响条目数）。
 *  - 跨版本稳妥：优先用 Zotero.Tags.rename（库级、快），拿不到则回退
 *    「按标签搜索条目 → 逐条目重写标签」。
 */
/* global Zotero, Services, Prefs, I18n, MdLite */

var TagCurator = {
  TAG_RARE: "#治理/罕见标签",
  TAG_HIER: "#治理/层级缺失",

  /* ---------- 纯函数层（可单测，不触碰 Zotero） ---------- */

  /** 归一化：全角→半角、去首尾空白、合并内部空白、去尾随标点、统一小写 */
  _norm(name) {
    let s = String(name == null ? "" : name);
    // 全角字符 → 半角（ASCII 区）
    s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s.replace(/\u3000/g, " "); // 全角空格
    s = s.replace(/[／]/g, "/"); // 全角斜杠（层级分隔符统一）
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/[.。,，;；:：!！?？·、]+$/g, "").trim();
    return s.toLowerCase();
  },

  /** 形状键：在 _norm 基础上再抹掉分隔符，用来抓 deep-learning / deep learning 这类差异 */
  _shape(name) {
    return this._norm(name).replace(/[\s\-_·/\\]+/g, "");
  },

  /**
   * 分析标签清单（纯函数）
   * @param {Array<{name:string,count:number}>} tags
   * @returns {{groups:Array, rare:Array, hierarchy:Array, total:number, unique:number}}
   */
  analyze(tags) {
    const list = (tags || []).filter((t) => t && t.name);
    const byShape = new Map();
    for (const t of list) {
      const k = this._shape(t.name);
      if (!k) continue;
      if (!byShape.has(k)) byShape.set(k, []);
      byShape.get(k).push({ name: t.name, count: t.count || 0 });
    }
    const groups = [];
    for (const [key, variants] of byShape) {
      if (variants.length < 2) continue;
      // 规范形：条目数最多者胜出；并列时取「更易读」的形式
      // （含大写或含空格的写法优先于全小写/无分隔符），最后按字典序稳定
      const sorted = variants.slice().sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        const ra = /[A-Z]/.test(a.name) ? 1 : 0;
        const rb = /[A-Z]/.test(b.name) ? 1 : 0;
        if (ra !== rb) return rb - ra;
        const sa = /\s/.test(a.name) ? 1 : 0;
        const sb = /\s/.test(b.name) ? 1 : 0;
        if (sa !== sb) return sb - sa;
        return a.name.localeCompare(b.name);
      });
      groups.push({
        key,
        canonical: sorted[0].name,
        variants: sorted.map((v) => ({ name: v.name, count: v.count, keep: v.name === sorted[0].name })),
        merges: sorted.slice(1).map((v) => ({ from: v.name, to: sorted[0].name, count: v.count })),
        affected: sorted.reduce((n, v) => (v.name === sorted[0].name ? n : n + v.count), 0),
      });
    }
    groups.sort((a, b) => b.affected - a.affected);

    const known = new Set(list.map((t) => t.name));
    const rare = list.filter((t) => (t.count || 0) <= 1).sort((a, b) => a.name.localeCompare(b.name));
    const hierarchy = [];
    for (const t of list) {
      const m = String(t.name).match(/^([^/\\]+)[/\\].+$/);
      if (m && !known.has(m[1]) && !known.has(m[1].trim())) {
        hierarchy.push({ tag: t.name, parent: m[1].trim() });
      }
    }
    hierarchy.sort((a, b) => a.parent.localeCompare(b.parent));

    return {
      groups,
      rare,
      hierarchy,
      total: list.reduce((n, t) => n + (t.count || 0), 0),
      unique: list.length,
    };
  },

  /* ---------- Zotero 数据层 ---------- */

  /** 扫描全库，统计标签使用次数（一次遍历条目） */
  async collectTagStats() {
    const counts = new Map();
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    const ids = await s.search();
    for (const id of ids) {
      const item = await Zotero.Items.getAsync(id);
      if (!item || item.deleted) continue;
      let tags = [];
      try { tags = item.getTags() || []; } catch (e) { tags = []; }
      for (const t of tags) {
        const name = t && t.tag;
        if (!name) continue;
        // Zotero 会用 type=1 表示自动标签，这里不区分，统一计数
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  },

  /** 扫描：返回分析结果 + 范围信息 */
  async scan() {
    const tags = await this.collectTagStats();
    const r = this.analyze(tags);
    r.scope = I18n.isZh ? "全库" : "Whole library";
    return r;
  },

  /* ---------- 执行层 ---------- */

  /** 重命名一个标签：优先库级 API，回退逐条目重写 */
  async _renameTag(from, to) {
    // 1) 库级 API（Zotero 7+ 提供；一次调用即可，最快）
    try {
      if (Zotero.Tags && typeof Zotero.Tags.rename === "function") {
        await Zotero.Tags.rename(Zotero.Libraries.userLibraryID, from, to);
        return "lib";
      }
    } catch (e) { /* 回退 */ }
    // 2) 回退：按标签搜条目，逐条重写标签数组
    let n = 0;
    try {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("tag", "is", from);
      const ids = await s.search();
      for (const id of ids) {
        const item = await Zotero.Items.getAsync(id);
        if (!item) continue;
        const names = new Set();
        for (const t of item.getTags() || []) {
          const nm = t.tag === from ? to : t.tag;
          if (nm) names.add(nm);
        }
        item.setTags([...names].map((n2) => ({ tag: n2 })));
        await item.saveTx();
        n++;
      }
    } catch (e) {
      Zotero.logError(e);
    }
    return n ? "items:" + n : "none";
  },

  async _tag(item, tag) {
    try {
      if (!item.getTags().some((t) => t.tag === tag)) {
        item.addTag(tag);
        await item.saveTx();
      }
    } catch (e) { /* ignore */ }
  },

  async _createLibraryNote(title, md) {
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(MdLite.toNoteHtml(title, md));
    await note.saveTx();
    return note;
  },

  _reportMd(r, applied) {
    const zh = I18n.isZh;
    const date = new Date().toISOString().slice(0, 10);
    const merges = r.groups.reduce((n, g) => n + g.merges.length, 0);
    let md = (zh ? "扫描范围：" : "Scope: ") + r.scope +
      (zh ? "，标签 " : " | tags ") + r.unique +
      (zh ? " 种，累计使用 " : " unique, ") + r.total + (zh ? " 次（" : " uses (") + date + "）\n\n" +
      "| " + (zh ? "问题" : "Issue") + " | " + (zh ? "数量" : "Count") + " |\n|---|---|\n" +
      "| " + (zh ? "变体组（可归一）" : "Variant groups") + " | " + r.groups.length +
      (zh ? " 组 / 待合并 " : " groups / ") + merges + (zh ? " 种写法" : " merges") + " |\n" +
      "| " + (zh ? "罕见标签（仅 1 篇）" : "Rare tags (1 item)") + " | " + r.rare.length + " |\n" +
      "| " + (zh ? "层级缺失" : "Missing parent tags") + " | " + r.hierarchy.length + " |\n";
    md += "\n" + (applied ? (zh ? "> ✅ 本次已执行归一合并。\n" : "> ✅ Normalization applied.\n") : "");
    if (r.groups.length) {
      md += "\n## " + (zh ? "变体组与合并方案" : "Variant groups") + "\n";
      r.groups.forEach((g, i) => {
        md += "\n### " + (i + 1) + ". " + g.canonical + (zh ? "（建议保留，影响 " : " (keep, affects ") + g.affected + (zh ? " 篇）" : ")") + "\n";
        g.merges.forEach((m) => {
          md += "- `" + m.from + "` → `" + m.to + "`" + (zh ? "（" : " (") + m.count + (zh ? " 篇）" : ")") + "\n";
        });
      });
    }
    if (r.rare.length) {
      md += "\n## " + (zh ? "罕见标签（建议人工确认是否删除）" : "Rare tags") + "\n" +
        r.rare.slice(0, 60).map((t) => "- " + t.name).join("\n") +
        (r.rare.length > 60 ? "\n- … " + (zh ? "其余 " : "and ") + (r.rare.length - 60) + (zh ? " 个" : " more") : "") + "\n";
    }
    if (r.hierarchy.length) {
      md += "\n## " + (zh ? "层级缺失（子标签存在但父标签不存在）" : "Missing parent tags") + "\n" +
        r.hierarchy.slice(0, 40).map((h) => "- `" + h.tag + "`" + (zh ? " —— 缺少父标签 " : " — missing parent ") + "`" + h.parent + "`").join("\n") + "\n";
    }
    md += "\n" + (zh
      ? "> 提示：本报告只读。执行归一请用「标签归一（执行合并）」；合并前建议先备份库（文件 → 导出库）。"
      : "> Tip: this report is read-only. Use “Normalize tags” to apply; back up your library first.");
    return md;
  },

  /**
   * 入口
   * @param {boolean} apply false=只出报告（安全预览）；true=确认后执行归一
   */
  async run(apply) {
    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + (zh ? "标签治理" : "Tag Curator"));
    const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      zh ? "正在统计标签使用情况…" : "Counting tags…");
    progress.setProgress(20);
    pw.show();
    try {
      const r = await this.scan();
      progress.setText(zh ? "已扫描，正在生成报告…" : "Scanning done, writing report…");
      progress.setProgress(55);

      let applied = false;
      if (apply && r.groups.length) {
        const merges = r.groups.reduce((n, g) => n + g.merges.length, 0);
        const sample = r.groups.slice(0, 8).map((g) =>
          "  " + g.merges.map((m) => m.from).join(" / ") + "  →  " + g.canonical).join("\n");
        const msg = (zh
          ? "将把 " + r.groups.length + " 组变体（共 " + merges + " 种写法、影响 " + r.groups.reduce((n, g) => n + g.affected, 0) + " 篇条目）合并到各自的主体写法：\n\n"
          : "Merge " + r.groups.length + " groups (" + merges + " variants) into their main spelling:\n\n") +
          sample + (r.groups.length > 8 ? "\n  …" : "") +
          (zh ? "\n\n此操作会修改标签，不可自动撤销。建议先导出备份。是否继续？"
              : "\n\nThis modifies tags and cannot be auto-undone. Continue?");
        const win = Zotero.getMainWindow();
        const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
          Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
        const choice = Services.prompt.confirmEx(win, "Papilot · " + (zh ? "标签归一" : "Normalize tags"), msg, flags,
          zh ? "执行合并" : "Merge", zh ? "取消" : "Cancel", null, null, {});
        if (choice === 0) {
          progress.setText(zh ? "正在合并标签…" : "Merging tags…");
          progress.setProgress(70);
          for (const g of r.groups) {
            for (const m of g.merges) {
              try { await this._renameTag(m.from, m.to); } catch (e) { Zotero.logError(e); }
            }
          }
          applied = true;
        }
      }

      const date = new Date().toISOString().slice(0, 10);
      await this._createLibraryNote(
        (zh ? "标签治理报告｜" : "Tag Curator | ") + date, this._reportMd(r, applied));
      progress.setText((zh ? "变体组 " : "groups ") + r.groups.length +
        (zh ? " · 罕见 " : " · rare ") + r.rare.length +
        (zh ? " · 层级缺失 " : " · missing parent ") + r.hierarchy.length +
        (applied ? (zh ? " · 已合并" : " · merged") : ""));
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      Zotero.logError(e);
    }
    pw.startCloseTimer(4500);
  },

  /* ==================== 嵌套标签视图（E3，0.40.0，纯只读） ====================
   * 把 `#a/b/c` 形态的标签渲染成可折叠树：节点显示条目数（total = 子树合计，
   * count = 恰好等于该路径的标签自身条目数），点击节点列出命中条目。
   * 全程不改任何标签数据 —— 与 run(false) 的「只读扫描」同一纪律。
   *
   * 说明：标签治理此前没有自己的窗口（run() 的产出是库内笔记），
   * 嵌套视图是交互式 UI，无法塞进笔记，故给它一个独立只读窗口
   * （chrome/content/tag-nested.xhtml），入口由 TagCurator.openNestedView() 提供。
   */

  NESTED_WINDOW_TYPE: "papilot:tag-nested",
  NESTED_WINDOW_URL: "chrome://papilot/content/tag-nested.xhtml",
  NESTED_WINDOW_NAME: "papilot-tag-nested",

  /** 标签名 → 层级段（全角斜杠/反斜杠统一为 "/"，各段去空白，空段丢弃） */
  _splitPath(name) {
    return String(name == null ? "" : name)
      .replace(/[／\\]+/g, "/")
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },

  /**
   * 嵌套树（纯函数，可单测）
   * @param {Array<{name:string,count:number}>} tags
   * @returns {Array<{name:string, path:string, count:number, total:number, children:Array}>}
   *   count = 恰好等于该路径的标签自身条目数；total = 子树合计（含自身）。
   *   无层级的单段标签作为顶层叶子节点也进树（信息完整，不影响层级结构）。
   *   排序：total 降序，并列按段名字典序（稳定）。
   */
  buildNestedTree(tags) {
    const counts = new Map();
    for (const t of (tags || [])) {
      if (!t || !t.name) continue;
      const nm = String(t.name);
      counts.set(nm, (counts.get(nm) || 0) + (Number(t.count) || 0));
    }
    const root = [];
    const nodeByPath = new Map();
    const getNode = (parentArr, path, seg) => {
      let n = nodeByPath.get(path);
      if (!n) {
        n = { name: seg, path, count: 0, total: 0, children: [] };
        nodeByPath.set(path, n);
        parentArr.push(n);
      }
      return n;
    };
    for (const [name, cnt] of counts) {
      const segs = this._splitPath(name);
      if (!segs.length) continue;
      let arr = root;
      let path = "";
      for (let i = 0; i < segs.length; i++) {
        path = path ? path + "/" + segs[i] : segs[i];
        const n = getNode(arr, path, segs[i]);
        if (i === segs.length - 1) n.count += cnt;
        arr = n.children;
      }
    }
    const finalize = (nodes) => {
      for (const n of nodes) {
        finalize(n.children);
        n.total = n.count + n.children.reduce((s, c) => s + c.total, 0);
      }
      nodes.sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
    };
    finalize(root);
    return root;
  },

  /**
   * 扫描全库（只读）：标签计数 + 每个树路径命中的条目清单。
   * 一条 `a/b/c` 标签会同时计入 a、a/b、a/b/c 三个路径 —— 与树节点的
   * total 语义一致，点击任一节点列出的就是「该子树下」的条目。
   * @returns {Promise<{tags:Array, items:Object<string,Array<{id,title}>>}>}
   */
  async collectNestedData() {
    const counts = new Map();
    const itemsByPath = new Map(); // path -> Map(id -> title)
    const addItem = (path, id, title) => {
      if (!itemsByPath.has(path)) itemsByPath.set(path, new Map());
      itemsByPath.get(path).set(id, title);
    };
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    const ids = await s.search();
    for (const id of ids) {
      const item = await Zotero.Items.getAsync(id);
      if (!item || item.deleted) continue;
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { title = ""; }
      let tags = [];
      try { tags = item.getTags() || []; } catch (e) { tags = []; }
      for (const t of tags) {
        const name = t && t.tag;
        if (!name) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
        const segs = this._splitPath(name);
        let path = "";
        for (const seg of segs) {
          path = path ? path + "/" + seg : seg;
          addItem(path, id, title);
        }
      }
    }
    const items = {};
    for (const [path, m] of itemsByPath) {
      items[path] = [...m.entries()].map(([id, title]) => ({ id, title }))
        .sort((a, b) => a.title.localeCompare(b.title));
    }
    return {
      tags: [...counts.entries()].map(([name, count]) => ({ name, count })),
      items,
    };
  },

  /** 点击条目：在主窗口条目树里选中（只读导航，不改数据） */
  async _revealItem(id) {
    try {
      const zp = Zotero.getActiveZoteroPane();
      if (zp && typeof zp.selectItem === "function") await zp.selectItem(id);
    } catch (e) { /* ignore */ }
  },

  /** 打开（或复用）嵌套标签视图窗口 */
  async openNestedView() {
    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + (zh ? "嵌套标签视图" : "Nested Tags"));
    const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      zh ? "正在扫描标签层级…" : "Scanning tag hierarchy…");
    progress.setProgress(30);
    pw.show();
    try {
      const data = await this.collectNestedData();
      const tree = this.buildNestedTree(data.tags);
      progress.setProgress(90);
      progress.setText((zh ? "共 " : "") + data.tags.length + (zh ? " 种标签" : " tags"));
      const payload = {
        Zotero,
        isZh: zh,
        tree,
        items: data.items,
        revealItem: (id) => this._revealItem(id),
      };
      // 单实例：已开则聚焦并刷新数据
      try {
        const en = Services.wm.getEnumerator(this.NESTED_WINDOW_TYPE);
        if (en.hasMoreElements()) {
          const win = en.getNext();
          try { win.focus(); } catch (e) { /* ignore */ }
          try {
            if (typeof win.ppNestedLoad === "function") win.ppNestedLoad(payload);
          } catch (e) { /* ignore */ }
          pw.startCloseTimer(1800);
          return win;
        }
      } catch (e) { /* ignore */ }
      const win = Zotero.getMainWindow();
      if (!win) { pw.startCloseTimer(1800); return null; }
      const w = win.openDialog(
        this.NESTED_WINDOW_URL,
        this.NESTED_WINDOW_NAME,
        "chrome,extracz,resizable,dialog=no,centerscreen",
        payload
      );
      pw.startCloseTimer(1800);
      return w;
    } catch (e) {
      progress.setError();
      Zotero.logError(e);
      pw.startCloseTimer(3000);
      return null;
    }
  },
};
