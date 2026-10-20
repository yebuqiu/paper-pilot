// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 笔记工具：大纲生成 + 批量整理（0.63.0 · A2）
 *
 * 与 note-graph.js 的分工：note-graph 管「笔记之间」的关系图谱，本模块管「单篇笔记内部的
 * 结构」（标题大纲）与「多篇笔记的批量操作」（标签 / 分类 / 标题前缀 / 合并）。
 *
 * 硬约束（别越过）：
 *   - **不改动 Zotero 笔记编辑器内部**。ProseMirror 的私有 API 属于劫持，一旦上游改结构就
 *     静默坏掉；这里只用公开接口 `getNote()` / `setNote()` / `saveTx()` / `addTag()` 等。
 *   - 大纲用注释标记块（`<!-- pp:outline:start -->` … `<!-- pp:outline:end -->`）包裹，
 *     因此**幂等**：重复执行只是替换块内内容，不会越插越多。已知取舍：用户若在编辑器里
 *     手动编辑过该块，ProseMirror 可能吃掉注释（它不保留 HTML 注释），届时再点一次
 *     「生成大纲」即可重建。
 *   - 大纲落在**标题行的下一行**（不是最前面）：Zotero 的笔记标题 = 正文首行
 *     （noteToTitle），插到首行之前会把每条笔记的显示标题变成「目录」。详见 insertPoint()。
 *   - 笔记标题在 Zotero 里由正文首行派生，所以「统一前缀」改的是正文首个 `<h1>`（没有就插入
 *     一个），**不碰 setField("title")**——那个字段对笔记无效。
 *   - 合并只新建一条笔记，**原笔记一律保留**（不删、不移），避免不可逆的数据操作。
 *
 * 结构：纯函数（parseOutline / buildOutlineHtml / injectOutline / stripOutline / mergeHtml /
 * escapeHtml / dedupeTags 及若干辅助）放在前半段，可 Node 单测；运行时在后面。
 */
/* global Zotero, Services, I18n */

var NoteTools = {
  /** 大纲块标记（注释在 HTML 里不影响渲染；ProseMirror 不保留注释 → 见头注释的取舍） */
  OUTLINE_START: "<!-- pp:outline:start -->",
  OUTLINE_END: "<!-- pp:outline:end -->",
  /** 对话框 URI / 窗口类型（openDialog 与「已开则聚焦」都用它） */
  DLOG_URL: "chrome://papilot/content/note-tools.xhtml",
  WINDOWTYPE: "papilot:notetools",
  /** 列表摘要长度（字符） */
  EXCERPT_MAX: 160,

  /* ==================== 纯函数（可离线单测） ==================== */

  /** HTML 转义：`& < > "`（顺序重要，`&` 必须最先） */
  escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  /** 去标签 → 纯文本（用于标题文本抽取；`&amp;` 必须最后解，否则会二次解码） */
  stripTags(html) {
    return String(html == null ? "" : html)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/gi, "&");
  },

  /** 空白归一：连续空白（含 &nbsp; 的 \u00a0）压成一个空格并去首尾 */
  normalizeText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  },

  /** 取主窗口 DOMParser 文档；不可用时返回 null（调用方走正则退化路径） */
  _docFor(html) {
    try {
      if (typeof Zotero === "undefined" || !Zotero || typeof Zotero.getMainWindow !== "function") return null;
      const win = Zotero.getMainWindow();
      if (!win || typeof win.DOMParser !== "function") return null;
      return new win.DOMParser().parseFromString(String(html == null ? "" : html), "text/html");
    } catch (e) {
      return null;
    }
  },

  /**
   * 解析笔记标题结构。
   * 两条路径都必须有：DOM（准确，能正确跳过 `<!-- -->` 与属性里的尖括号）与
   * 正则（DOMParser 拿不到时保底，例如无主窗口 / 单测桩）。
   * @param {string} html 笔记 HTML
   * @returns {Array<{level:number, text:string, id:string}>} level 1–6；id 仅 UI 定位用（h0/h1/…），不写进笔记
   */
  parseOutline(html) {
    const src = String(html == null ? "" : html);
    const out = [];
    if (!src.trim()) return out;

    const doc = this._docFor(src);
    if (doc && typeof doc.querySelectorAll === "function") {
      let nodes = null;
      try { nodes = doc.querySelectorAll("h1, h2, h3, h4, h5, h6"); } catch (e) { nodes = null; }
      if (nodes) {
        for (const el of nodes) {
          const text = this.normalizeText(el.textContent);
          if (!text) continue;
          const level = Math.max(1, Math.min(6, Number(String(el.tagName || "").replace(/\D/g, "")) || 1));
          out.push({ level, text, id: "h" + out.length });
        }
        return out;
      }
    }

    // 退化路径：正则扫描（非贪婪、配对闭合标签）
    const re = /<h\s*([1-6])\b[^>]*>([\s\S]*?)<\/h\s*\1\s*>/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const text = this.normalizeText(this.stripTags(m[2]));
      if (!text) continue;
      out.push({ level: Number(m[1]), text, id: "h" + out.length });
    }
    return out;
  },

  /**
   * 大纲 → 嵌套 `<ul>` HTML（按 level 压栈）。条目文本**必须转义**；
   * 不生成锚点链接（Zotero 笔记不支持标题锚点）。
   * @param {Array} outline parseOutline 的结果
   * @returns {string} 空大纲返回 ""
   */
  buildOutlineHtml(outline) {
    const items = (Array.isArray(outline) ? outline : [])
      .filter((it) => it && this.normalizeText(it.text));
    if (!items.length) return "";
    let html = "";
    const stack = []; // 当前打开的层级值（升序）
    for (const it of items) {
      const level = Math.max(1, Math.min(6, Number(it.level) || 1));
      const text = this.escapeHtml(this.normalizeText(it.text));
      if (!stack.length) {
        stack.push(level);
        html += "<ul><li>" + text;
        continue;
      }
      const top = stack[stack.length - 1];
      if (level > top) {
        stack.push(level);
        html += "<ul><li>" + text;
      } else {
        // 回退到同级或更浅：先把更深的层收掉
        while (stack.length > 1 && stack[stack.length - 1] > level) {
          html += "</li></ul>";
          stack.pop();
        }
        html += "</li><li>" + text;
      }
    }
    while (stack.length) {
      html += "</li></ul>";
      stack.pop();
    }
    return html;
  },

  /** 空元素（没有闭合标签）——不参与深度计数 */
  VOID_TAGS: /^(?:img|br|hr|input|meta|link|source|col|area|base|embed|param|track|wbr)$/i,
  /** 块级标签：只有它们闭合才算「标题行结束」（内联标签不能作为插入锚点） */
  BLOCK_TAGS: /^(?:h[1-6]|p|div|blockquote|pre|table|ul|ol|dl|section|figure|details|aside|header|footer|main|article|nav)$/i,

  /**
   * 标题安全的插入点 = 正文**第一个顶层块级元素结束之后**。
   *
   * 三条约束（都有过实测缺陷，别再简化）：
   *   ① 不能落在笔记外层包装（`<div class="zotero-note">`）**之外**——那样 `setNote()` 后
   *      大纲会被编辑器当脏节点清掉，用户点「生成大纲」看不到任何变化（静默失败）；
   *   ② 不能落在 `<ul>/<ol>/<li>` **内部**——会产出 `<ul><li>x</li><p>目录</p></ul>` 这种
   *      非法嵌套，或让目录变成第一个列表项的子内容；
   *   ③ 不能放到标题行**之前**——Zotero 的笔记标题 = 正文首行（`Zotero.Utilities.Item.noteToTitle()`，
   *      `setNote()` 时缓存成 `_noteTitle`；见 xpcom/translate/modules/utilities/utilities_item.js）。
   *      放到首行之前会让列表里每条笔记的标题变成「目录」。
   *
   * 做法：从包装内部开始按标签深度扫描，只有在「回到包装内第一层」且闭合的是块级标签时
   * 才取它之后；包装自己的闭合标签取它**之前**。纯文本（无任何块结构）追加在尾部。
   *
   * ⚠️ **depth 只统计块级标签**（`BLOCK_TAGS`），行内标签（b/i/span/a/code/em/strong…）一律不计：
   * 否则 `<pre>`/`<code>` 里**未转义**的裸标签文本（外部粘贴/导入的脏 HTML，如
   * `<pre>a <b> c</pre>`）会把 depth 顶高一层，闭合回不到 base，插入点又被甩到包装外
   * （与 D1 同一个失效模式，QA 探针实测：`insertPoint` 返回 `src.length`）。
   */
  insertPoint(html) {
    const src = String(html == null ? "" : html);
    const wrap = /<(div|blockquote)\b[^>]*>/i.exec(src);
    const hasWrapper = !!(wrap && src.slice(0, wrap.index).trim() === "");
    const wrapperTag = hasWrapper ? String(wrap[1]).toLowerCase() : "";
    const base = hasWrapper ? 1 : 0; // 包装自身算第 1 层
    let depth = base;
    const start = hasWrapper ? wrap.index + wrap[0].length : 0;

    // 逐标签扫描（属性里的 > 用引号分组挡掉）
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    re.lastIndex = start;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = String(m[2] || "").toLowerCase();
      // 行内标签与空元素都不参与深度：它们既不开层也不闭层（见上面 <pre> 的坑）
      if (!this.BLOCK_TAGS.test(name)) continue;
      if (m[1] !== "/") {
        if (/\/\s*$/.test(m[3] || "") || this.VOID_TAGS.test(name)) continue; // 自闭合
        depth++;
        continue;
      }
      if (depth > base) {
        depth--;
        // 回到包装内第一层 → 一个顶层块结束，插在它后面（li 只计数，永远到不了这里作锚点）
        if (depth === base) return m.index + m[0].length;
        continue;
      }
      // depth === base：包装自己的闭合（或游离的块闭合）→ 插在它**之前**，留在包装内部
      if (hasWrapper && name === wrapperTag) return m.index;
    }
    // 没有任何块结构（纯文本 / 只有行内标签 / 只有空元素）：追加到尾部，宁可靠后也不改标题
    return src.length;
  },

  /** 文首插入点（wrapper 内部），只用于「改标题」的操作（applyTitlePrefix） */
  frontPoint(html) {
    const src = String(html == null ? "" : html);
    const wrap = /<(div|blockquote)\b[^>]*>/i.exec(src);
    if (wrap && src.slice(0, wrap.index).trim() === "") return wrap.index + wrap[0].length;
    return 0;
  },

  /** 去掉**所有**标记（含重复/孤立的），内容原样保留（D3：外部工具打乱注释后仍要幂等） */
  _dropMarkers(html) {
    return String(html == null ? "" : html)
      .split(this.OUTLINE_START).join("")
      .split(this.OUTLINE_END).join("");
  },

  /**
   * 幂等写入大纲块：有标记 → 替换块内（空大纲则**移除**整块）；无标记 → 插到插入点。
   * 标记乱序/只剩一个时先剥掉全部标记再重来一次（否则每点一次就多插一块）。
   * @param {string} html 笔记 HTML @param {string} outlineHtml buildOutlineHtml 的结果（空串 = 只移除）
   * @returns {string}
   */
  injectOutline(html, outlineHtml) {
    const src = String(html == null ? "" : html);
    const body = String(outlineHtml == null ? "" : outlineHtml).trim();
    const START = this.OUTLINE_START;
    const END = this.OUTLINE_END;
    // 一行说明放在块内（块外的话用户删大纲时会残留一行「目录」）
    const block = body ? START + "<p><strong>目录</strong></p>" + body + END : "";

    const s = src.indexOf(START);
    const e = src.indexOf(END);
    if (s >= 0 && e > s) {
      const before = src.slice(0, s);
      // 第一对块之后若还有重复/孤立标记，一并清掉（幂等性的另一半）
      const after = this._dropMarkers(src.slice(e + END.length));
      return (block ? before + block : before) + after;
    }
    if (s < 0 && e < 0) {
      if (!block) return src;
      const at = this.insertPoint(src);
      return src.slice(0, at) + block + src.slice(at);
    }
    // 乱序（END 在 START 之前）或只有单个标记：剥掉所有标记后按「无标记」重来（递归必终止）
    return this.injectOutline(this._dropMarkers(src), outlineHtml);
  },

  /** 去掉大纲块（「移除大纲」用）；没有块时原样返回，顺手清掉孤立标记 */
  stripOutline(html) {
    const src = String(html == null ? "" : html);
    const s = src.indexOf(this.OUTLINE_START);
    const e = s >= 0 ? src.indexOf(this.OUTLINE_END, s) : -1;
    const out = (s >= 0 && e > s) ? src.slice(0, s) + src.slice(e + this.OUTLINE_END.length) : src;
    return this._dropMarkers(out);
  },

  /** 去掉笔记正文的外层包装 `<div …>…</div>`（合并进新笔记时必须去掉，否则嵌套 schema 包装） */
  noteBody(html) {
    const src = String(html == null ? "" : html).trim();
    const m = /^<div\b[^>]*>([\s\S]*)<\/div>$/i.exec(src);
    return m ? String(m[1]).trim() : src;
  },

  /** 首个标题的纯文本（合并时「用笔记标题或首个标题」的兜底） */
  firstHeading(html) {
    const list = this.parseOutline(html);
    return list.length ? list[0].text : "";
  },

  /**
   * 合并多条笔记为一份 HTML：每条一个 `<h1>`/`<h2>` 标题 + 正文，条间 `<hr/>`。
   * @param {Array<{title?:string, html:string}>} notes
   * @param {{heading?:string, titlePrefix?:string, mergedTitle?:string}=} opts
   * @returns {string}
   */
  mergeHtml(notes, opts) {
    const o = opts || {};
    const tag = /^h[1-6]$/.test(String(o.heading || "")) ? String(o.heading) : "h1";
    const prefix = String(o.titlePrefix || "");
    const list = Array.isArray(notes) ? notes : [];
    const entries = [];
    list.forEach((n, i) => {
      const raw = (n && n.title) ? n.title : (n && n.html ? this.firstHeading(n.html) : "");
      const title = this.normalizeText(raw) || "笔记 " + (i + 1);
      const body = (n && n.html) ? this.noteBody(n.html) : "";
      entries.push("<" + tag + ">" + this.escapeHtml(prefix + title) + "</" + tag + ">" + body);
    });
    const head = o.mergedTitle ? "<h1>" + this.escapeHtml(String(o.mergedTitle)) + "</h1>" : "";
    return head + entries.join("<hr/>");
  },

  /**
   * 标签归一：去空、去重（大小写不敏感，保序取首个写法）。
   * @param {Array<string>|string} list
   * @returns {Array<string>}
   */
  dedupeTags(list) {
    const out = [];
    const seen = new Set();
    const arr = Array.isArray(list) ? list : [list];
    for (const raw of arr) {
      const t = String(raw == null ? "" : raw).trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  },

  /**
   * 给笔记正文的首个 `<h1>` 加前缀；没有 `<h1>` 就在插入点新建一个。
   * 幂等：标题已以该前缀开头时原样返回。
   * @param {string} html 笔记 HTML
   * @param {string} prefix 前缀文本
   * @param {string} fallbackTitle 无 h1 时的原标题（通常取 getDisplayTitle()）
   * @returns {string}
   */
  applyTitlePrefix(html, prefix, fallbackTitle) {
    const src = String(html == null ? "" : html);
    const raw = String(prefix == null ? "" : prefix);
    const pfx = raw.trim();
    if (!pfx) return src;
    // 前缀末尾的空格是**有意的排版**（「[精读] 标题」而不是「[精读]标题」），
    // 所以只 trim 判定用，拼接时按用户输入是否带空白补回一个空格。
    const label = pfx + (/\s$/.test(raw) ? " " : "");
    const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(src);
    if (m) {
      const text = this.normalizeText(this.stripTags(m[1]));
      if (text.startsWith(pfx)) return src;
      const replaced = "<h1>" + this.escapeHtml(label + text) + "</h1>";
      return src.slice(0, m.index) + replaced + src.slice(m.index + m[0].length);
    }
    const title = this.normalizeText(fallbackTitle) || "笔记";
    if (title.startsWith(pfx)) return src;
    const block = "<h1>" + this.escapeHtml(label + title) + "</h1>";
    // 这里**必须**放在文首：新 h1 成为笔记第一行，才能真正改变列表里显示的标题
    const at = this.frontPoint(src);
    return src.slice(0, at) + block + src.slice(at);
  },

  /* ==================== 运行时：条目归一化 ==================== */

  /**
   * 选中项 → 笔记条目（去重、按 id 升序）。
   * 语义：本身就是笔记就收；常规条目收其**全部**笔记（「给选中的文献批量整理其笔记」）。
   * @param {Array} items Zotero 条目
   * @returns {Array} 笔记条目
   */
  noteItemsFromSelection(items) {
    const byId = new Map();
    for (const it of items || []) {
      if (!it) continue;
      try {
        if (it.isNote && it.isNote()) { byId.set(it.id, it); continue; }
        if (it.isRegularItem && it.isRegularItem()) {
          for (const id of (it.getNotes() || [])) {
            const n = Zotero.Items.get(id);
            if (n && n.isNote && n.isNote()) byId.set(n.id, n);
          }
        }
      } catch (e) { /* 单条异常不拖垮整批 */ }
    }
    return Array.from(byId.values()).sort((a, b) => (a.id || 0) - (b.id || 0));
  },

  /** id 列表 → 笔记条目（跳过不存在的 / 非笔记） */
  _notesByIds(ids) {
    const out = [];
    for (const id of ids || []) {
      try {
        const n = Zotero.Items.get(id);
        if (n && n.isNote && n.isNote()) out.push(n);
      } catch (e) { /* ignore */ }
    }
    return out;
  },

  /** 笔记标题：优先 getDisplayTitle（Zotero 自带的派生逻辑），失败退回首个标题/首行 */
  _title(note) {
    try {
      if (note && typeof note.getDisplayTitle === "function") {
        const t = this.normalizeText(note.getDisplayTitle());
        if (t) return t;
      }
    } catch (e) { /* fallthrough */ }
    try { return this.firstHeading(note.getNote() || "") || ""; } catch (e) { return ""; }
  },

  /** 列表载荷：{id, title, excerpt, headings}（窗口渲染用，纯数据不带对象） */
  list(ids) {
    const rows = [];
    for (const n of this._notesByIds(ids)) {
      let html = "";
      try { html = n.getNote() || ""; } catch (e) { html = ""; }
      const outline = this.parseOutline(html);
      const excerpt = this.normalizeText(this.stripTags(this.noteBody(html))).slice(0, this.EXCERPT_MAX);
      rows.push({
        id: n.id,
        title: this._title(n),
        excerpt,
        headings: outline.length,
      });
    }
    return rows;
  },

  /* ==================== 运行时：单个操作 ==================== */

  /**
   * 生成/刷新大纲：读正文 → 解析 → 写回。内容没变化就不写（少一次同步与历史版本）。
   * @returns {Promise<{ok:boolean, changed:boolean, count:number, error?:string}>}
   */
  async refreshOutline(note) {
    if (!note) return { ok: false, changed: false, count: 0, error: "no-note" };
    const html = String(note.getNote() || "");
    const outline = this.parseOutline(html);
    const next = this.injectOutline(html, this.buildOutlineHtml(outline));
    if (next === html) return { ok: true, changed: false, count: outline.length };
    note.setNote(next);
    await note.saveTx();
    return { ok: true, changed: true, count: outline.length };
  },

  /** 移除大纲块（没有块 → changed:false，不报错） */
  async removeOutline(note) {
    if (!note) return { ok: false, changed: false, error: "no-note" };
    const html = String(note.getNote() || "");
    const next = this.stripOutline(html);
    if (next === html) return { ok: true, changed: false };
    note.setNote(next);
    await note.saveTx();
    return { ok: true, changed: true };
  },

  /**
   * 批量加标签。`note.addTag(tag, type)` 是公开接口；个别版本/桩没有该方法时退回 setTags。
   * @returns {Promise<{ok:boolean, changed:number, total:number, error?:string}>}
   */
  async addTags(notes, tags) {
    const list = this.dedupeTags(tags);
    const out = { ok: true, changed: 0, total: (notes || []).length };
    if (!list.length || !notes || !notes.length) return out;
    for (const n of notes) {
      try {
        if (typeof n.addTag === "function") {
          for (const t of list) n.addTag(t, 0);
        } else {
          const cur = (typeof n.getTags === "function" ? (n.getTags() || []) : []).map((x) => x && x.tag).filter(Boolean);
          n.setTags(this.dedupeTags(cur.concat(list)));
        }
        await n.saveTx();
        out.changed++;
      } catch (e) {
        Zotero.logError(e);
        out.ok = false;
        out.error = String((e && (e.message || e)) || e);
      }
    }
    return out;
  },

  /** 批量去标签（同样带 setTags 兜底） */
  async removeTags(notes, tags) {
    const list = this.dedupeTags(tags);
    const out = { ok: true, changed: 0, total: (notes || []).length };
    if (!list.length || !notes || !notes.length) return out;
    const lower = new Set(list.map((t) => t.toLowerCase()));
    for (const n of notes) {
      try {
        if (typeof n.removeTag === "function") {
          for (const t of list) n.removeTag(t);
        } else {
          const cur = (typeof n.getTags === "function" ? (n.getTags() || []) : []).map((x) => x && x.tag).filter(Boolean);
          n.setTags(cur.filter((t) => !lower.has(String(t).toLowerCase())));
        }
        await n.saveTx();
        out.changed++;
      } catch (e) {
        Zotero.logError(e);
        out.ok = false;
        out.error = String((e && (e.message || e)) || e);
      }
    }
    return out;
  },

  /** 当前主窗口选中的分类 id（没有选中返回 0） */
  currentCollectionID() {
    try {
      const zp = Zotero.getActiveZoteroPane();
      const c = zp && typeof zp.getSelectedCollection === "function" ? zp.getSelectedCollection() : null;
      return (c && c.id) ? Number(c.id) : 0;
    } catch (e) {
      return 0;
    }
  },

  /** 把笔记移入指定分类（只动笔记本身，不动其父条目） */
  async moveToCollection(notes, collectionID) {
    const cid = Number(collectionID) || 0;
    if (!cid) return { ok: false, reason: "no-collection", changed: 0 };
    const out = { ok: true, changed: 0, total: (notes || []).length };
    for (const n of notes || []) {
      try {
        if (typeof n.addToCollection === "function") n.addToCollection(cid);
        await n.saveTx();
        out.changed++;
      } catch (e) {
        Zotero.logError(e);
        out.ok = false;
        out.error = String((e && (e.message || e)) || e);
      }
    }
    return out;
  },

  /** 批量统一标题前缀（改首个 h1 / 没有就插入；幂等） */
  async prefixTitles(notes, prefix) {
    // 只去前导空白：**尾部空格是有意的**（「[精读] 标题」），applyTitlePrefix 会保留它
    const raw = String(prefix == null ? "" : prefix);
    const pfx = raw.replace(/^\s+/, "");
    if (!pfx.trim()) return { ok: false, reason: "empty-prefix", changed: 0 };
    const out = { ok: true, changed: 0, total: (notes || []).length };
    for (const n of notes || []) {
      try {
        const html = String(n.getNote() || "");
        const next = this.applyTitlePrefix(html, pfx, this._title(n));
        if (next === html) continue;
        n.setNote(next);
        await n.saveTx();
        out.changed++;
      } catch (e) {
        Zotero.logError(e);
        out.ok = false;
        out.error = String((e && (e.message || e)) || e);
      }
    }
    return out;
  },

  /**
   * 合并多篇笔记为**一条新笔记**：原笔记一律保留。
   * 分类归属：沿用首条笔记所在的分类（把整理结果放回同一处，用户不用再找）。
   * @param {Array} notes 笔记条目
   * @param {{title?:string, titlePrefix?:string}=} opts 可选覆盖（默认标题走 i18n noteToolsMergeTitle）
   */
  async mergeNotes(notes, opts) {
    const o = opts || {};
    const list = notes || [];
    if (!list.length) return { ok: false, reason: "empty", changed: 0 };
    const payload = list.map((n) => ({ title: this._title(n), html: String(n.getNote() || "") }));
    const html = this.mergeHtml(payload, {
      mergedTitle: o.title || I18n.t("noteToolsMergeTitle"),
      titlePrefix: o.titlePrefix || "",
      // 合并后的笔记标题来自 h1（合并标题），各条用 h2 才不会与它抢层级
      heading: "h2",
    });
    const note = new Zotero.Item("note");
    try { note.libraryID = list[0].libraryID; } catch (e) { /* 极端情况用默认库 */ }
    note.setNote(html);
    let colls = [];
    try { colls = list[0].getCollections() || []; } catch (e) { colls = []; }
    for (const cid of colls) {
      try { note.addToCollection(cid); } catch (e) { /* 分类可能已删 */ }
    }
    await note.saveTx();
    return { ok: true, changed: 1, id: note.id, count: list.length };
  },

  /* ==================== 运行时：窗口与入口 ==================== */

  /** 统一的返回值包装：异常一律 Zotero.logError + {ok:false}（不静默） */
  async _safe(fn) {
    try {
      const r = await fn();
      return r || { ok: true, changed: 0 };
    } catch (e) {
      Zotero.logError(e);
      return { ok: false, changed: 0, error: String((e && (e.message || e)) || e) };
    }
  },

  /** 在主窗口取标签输入（窗口脚本不能直接调 Services，必须经这里） */
  askTags() {
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
    try {
      const v = { value: "" };
      const ok = Services.prompt.prompt(win, "Papilot · " + I18n.t("noteToolsTitle"),
        I18n.t("noteToolsPromptTags"), v, null, {});
      if (!ok) return null;
      const tags = this.dedupeTags(String(v.value || "").split(/[,，;；\s]+/));
      return tags.length ? tags : null;
    } catch (e) {
      Zotero.logError(e);
      return null;
    }
  },

  /** 在主窗口取前缀输入 */
  askPrefix() {
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
    try {
      const v = { value: "" };
      const ok = Services.prompt.prompt(win, "Papilot · " + I18n.t("noteToolsTitle"),
        I18n.t("noteToolsPromptPrefix"), v, null, {});
      if (!ok) return null;
      // 同上：尾部空格有意义，只削前导空白
      const raw = String(v.value || "");
      if (!raw.trim()) return null;
      return raw.replace(/^\s+/, "");
    } catch (e) {
      Zotero.logError(e);
      return null;
    }
  },

  /**
   * 给窗口暴露的 API（窗口脚本只经过这里，不直接摸 Zotero/Services）。
   * 所有写操作返回 `{ok, changed, error?}`。
   * @param {Array<number>} ids 打开窗口时的笔记 id 快照（list() 用它取当前状态）
   */
  _api(ids) {
    const self = this;
    const scope = Array.isArray(ids) ? ids.slice() : [];
    return {
      isZh() { return !!(typeof I18n !== "undefined" && I18n.isZh); },
      list() {
        try { return self.list(scope); }
        catch (e) { Zotero.logError(e); return []; }
      },
      refreshOutline(id) { return self._safe(() => self.refreshOutline(self._notesByIds([id])[0])); },
      removeOutline(id) { return self._safe(() => self.removeOutline(self._notesByIds([id])[0])); },
      addTags(list, tags) { return self._safe(() => self.addTags(self._notesByIds(list), tags)); },
      removeTags(list, tags) { return self._safe(() => self.removeTags(self._notesByIds(list), tags)); },
      moveToCollection(list) {
        return self._safe(() => self.moveToCollection(self._notesByIds(list), self.currentCollectionID()));
      },
      prefixTitles(list, prefix) { return self._safe(() => self.prefixTitles(self._notesByIds(list), prefix)); },
      merge(list, opts) { return self._safe(() => self.mergeNotes(self._notesByIds(list), opts)); },
      askTags() { return self.askTags(); },
      askPrefix() { return self.askPrefix(); },
    };
  },

  /**
   * 打开整理窗口（同类型窗口已开则聚焦，避免开一堆）。
   * @param {Array} notes 笔记条目
   * @returns {Object|null} 窗口对象
   */
  openDialog(notes) {
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
    if (!win) {
      try { Services.prompt.alert(null, "Papilot", I18n.t("noteToolsEmpty")); } catch (e) { /* ignore */ }
      return null;
    }
    try {
      const en = Services.wm.getEnumerator(this.WINDOWTYPE);
      if (en.hasMoreElements()) {
        const w = en.getNext();
        try { w.focus(); } catch (e) { /* ignore */ }
        return w;
      }
    } catch (e) { /* 枚举失败就当没开过 */ }
    const ids = (notes || []).map((n) => n.id).filter(Boolean);
    return win.openDialog(this.DLOG_URL, "papilot-note-tools",
      "chrome,centerscreen,resizable,dialog=no",
      { api: this._api(ids), payload: { ids } });
  },

  /** 菜单入口：选中项（或其父条目的笔记）→ 打开窗口 */
  runForSelected() {
    let items = [];
    try {
      const zp = Zotero.getActiveZoteroPane();
      items = zp ? (zp.getSelectedItems() || []) : [];
    } catch (e) { items = []; }
    const notes = this.noteItemsFromSelection(items);
    if (!notes.length) {
      let win = null;
      try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
      try { Services.prompt.alert(win, "Papilot", I18n.t("noteToolsEmpty")); } catch (e) { /* ignore */ }
      return null;
    }
    return this.openDialog(notes);
  },
};
