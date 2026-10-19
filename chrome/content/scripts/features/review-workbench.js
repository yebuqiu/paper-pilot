// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 综述工作台（Review Workbench，0.53.0）
 *
 * 定位：ReviewGen（多篇 → 一次性整篇综述）的升级版——把「大纲 → 分节草稿 →
 * 真实引用 → 导出」拆成可人工干预的三步，解决单轮整篇「结构不可控、某节不合意
 * 只能重来」的问题。
 *
 * 分层（本文件三块，顺序即依赖方向）：
 *   ① 纯函数：buildOutlinePrompt / parseOutline / buildSectionPrompt /
 *      assembleDraft / citeToLink / stripFences —— 不碰 Zotero，可在 Node 单测；
 *   ② 编排 API：generateOutline / draftSections / saveAsNote —— 所有 async 不抛，
 *      失败一律 {ok:false, reason, ...}，窗口层只负责显示；
 *   ③ 窗口：openDialog —— 与 skill-store / ref-import 同款：
 *      win.openDialog(url, WINDOW_NAME, flags, {Zotero, Services, metas, api})。
 *
 * 引用约定：AI 一律写「文献 n」（n 为材料编号，见 buildSectionPrompt 的
 * 证据纪律）；citeToLink 在渲染/导出前把「文献 n」换成
 * [文献 n](zotero://select/library/items/<itemKey>)——Zotero 内部链接协议，
 * 笔记里点击可直接跳到条目。越界编号、缺 key 的条目一律保留纯文本。
 *
 * 与 ReviewGen 的分工：不重复实现单轮整篇；两者共用「文献 n」编号语义。
 */
/* global Zotero, Services, AIClient, Notes, I18n */

var ReviewWorkbench = {
  /** 集成方接菜单用的稳定 id */
  MENU_ID: "review-workbench",
  WINDOW_URL: "chrome://papilot/content/review-workbench.xhtml",
  WINDOW_NAME: "papilot-review-workbench",
  WINDOW_TYPE: "papilot:review-workbench",
  /** 一次最多处理的文献篇数（超出截断，窗口顶部提示） */
  MAX_ITEMS: 30,
  /** 大纲提示词里每篇摘要截断长度（大纲只需要主题，不需要细节） */
  OUTLINE_ABSTRACT_CHARS: 120,
  /** 分节提示词里每篇摘要截断长度（要支撑段落论证） */
  SECTION_ABSTRACT_CHARS: 200,
  DEFAULT_TITLE: "文献综述",

  /* ==================== ① 纯函数 ==================== */

  _str(v) {
    return v == null ? "" : String(v).trim();
  },

  _clip(s, n) {
    const t = this._str(s);
    const max = Number(n) > 0 ? Number(n) : 200;
    return t.length > max ? t.slice(0, max) + "…" : t;
  },

  /** 题录归一（兼容 Chat.paperMeta / abstractNote / pub 等字段别名） */
  _meta(m, i) {
    const o = m || {};
    const date = this._str(o.date);
    const year = this._str(o.year) || date.slice(0, 4);
    return {
      n: i + 1,
      key: this._str(o.key),
      id: o.id,
      libraryID: o.libraryID,
      title: this._str(o.title) || "（无标题）",
      authors: this._str(o.authors || o.creators),
      year: year,
      journal: this._str(o.journal || o.pub || o.publicationTitle),
      abstract: this._str(o.abstract || o.abstractNote),
    };
  },

  _normList(metas) {
    const arr = Array.isArray(metas) ? metas : [];
    return arr.map((m, i) => this._meta(m, i));
  },

  /** 参考文献单行：[文献 n] 作者. 标题. 期刊, 年份. */
  _refLine(m, n) {
    const authors = (this._str(m.authors) || "佚名").replace(/[.。]+$/, "");
    const title = (this._str(m.title) || "（无标题）").replace(/[.。]+$/, "");
    const journal = this._str(m.journal).replace(/[.。]+$/, "");
    const year = this._str(m.year) || "年份不详";
    const tail = journal ? journal + ", " + year : year;
    return "[文献 " + n + "] " + authors + ". " + title + ". " + tail + ".";
  },

  /**
   * 大纲提示词：4-7 节、每节标题 + 一句覆盖说明、按「## n. 标题\n说明」输出
   * @param {Array} metas 题录（title/year/journal/abstract/key…）
   * @returns {{system:string, user:string}}
   */
  buildOutlinePrompt(metas) {
    const list = this._normList(metas);
    const system = "你是一位严谨的学术综述规划助手，负责为一篇文献综述设计分节大纲。\n" +
      "要求：\n" +
      "1) 共 4-7 节，按论证逻辑递进（例如：问题背景 → 方法与证据比较 → 共识与分歧 → 空白与展望），不要按「一篇文献一节」机械切分；\n" +
      "2) 每节先给标题，再用一句话说明这一节要回答什么问题、覆盖哪些材料；\n" +
      "3) 输出格式严格为：\n" +
      "## 1. 节标题\n一句覆盖说明\n\n## 2. 节标题\n一句覆盖说明\n" +
      "4) 只输出大纲本身：不要前言、不要总结、不要参考文献小节、不要代码围栏。";

    const blocks = list.map((m) => {
      const bits = ["[文献 " + m.n + "] " + m.title + "（" + (m.year || "年份不详") + "）"];
      if (m.journal) bits[0] += " · " + m.journal;
      if (m.abstract) bits.push("摘要：" + this._clip(m.abstract, this.OUTLINE_ABSTRACT_CHARS));
      return bits.join("\n");
    });
    const user = "以下是 " + list.length + " 篇文献的题录与摘要（编号即引用号「文献 n」）：\n\n" +
      blocks.join("\n\n") +
      "\n\n请为这 " + list.length + " 篇文献设计一篇综述的分节大纲，共 4-7 节。";
    return { system: system, user: user };
  },

  /**
   * 解析大纲文本（容错）：
   *   · 标准「## 1. 标题」+ 下一行说明；
   *   · 无编号「## 标题」→ n 顺序编号；
   *   · 无 ## 时退化为按行解析（要求带序号或列表符号，避免把散文当成大纲）；
   *   · 去掉空标题节与「参考文献」节；解析失败返回 []。
   * @returns {Array<{n:number,title:string,desc:string}>}
   */
  parseOutline(text) {
    const clean = this.stripFences(text);
    if (!clean) return [];
    const lines = clean.split(/\r?\n/);
    const headingRe = /^\s*#{2,4}\s+(?:(\d+)\s*[.、．)）]\s*)?(.+?)\s*$/;
    const hasHeading = lines.some((l) => headingRe.test(l));
    const out = [];

    if (hasHeading) {
      let cur = null;
      for (const raw of lines) {
        const line = String(raw).replace(/\s+$/, "");
        const m = line.match(headingRe);
        if (m) {
          const parts = this._splitTitleDesc(m[2]);
          const title = this._cleanTitle(parts[0]);
          if (!title) { cur = null; continue; }
          cur = {
            n: m[1] ? parseInt(m[1], 10) : out.length + 1,
            title: title,
            desc: parts[1],
          };
          out.push(cur);
          continue;
        }
        if (!cur) continue;
        const t = line.trim();
        if (!t || cur.desc) continue; // 每节只取一句说明（内联冒号已给出则忽略后续行）
        cur.desc = t;
      }
    } else {
      const numberedRe = /^\s*(?:[-*•]\s+)?(\d+)\s*[.、．)）]\s*(.+?)\s*$/;
      const bulletRe = /^\s*[-*•]\s+(.+?)\s*$/;
      for (const raw of lines) {
        const line = String(raw).trim();
        if (!line) continue;
        let num = null;
        let body = "";
        const nm = line.match(numberedRe);
        if (nm) {
          num = parseInt(nm[1], 10);
          body = nm[2];
        } else {
          const bm = line.match(bulletRe);
          if (!bm) continue; // 散文行不计入（否则「抱歉，无法完成」会被当成一节）
          body = bm[1];
        }
        const parts = this._splitTitleDesc(body);
        const title = this._cleanTitle(parts[0]);
        if (!title) continue;
        out.push({ n: num || out.length + 1, title: title, desc: parts[1] });
      }
    }

    return out.filter((s) => s && s.title &&
      !/^(参考文献|references?|bibliography)$/i.test(s.title));
  },

  _splitTitleDesc(s) {
    const t = this._str(s);
    const m = t.match(/^(.+?)[：:]\s*(.+)$/);
    if (m) return [m[1].trim(), m[2].trim()];
    return [t, ""];
  },

  _cleanTitle(s) {
    return this._str(s)
      .replace(/\*\*/g, "")
      .replace(/^#+\s*/, "")
      .replace(/^[「『"']+|[」』"']+$/g, "")
      .trim();
  },

  /**
   * 分节提示词：证据纪律 + 全部题录（摘要 200）+ 本节目标 + 已写节标题
   * @param {Array} metas
   * @param {Array} outline parseOutline() 的结果
   * @param {number} idx 本节在大纲中的下标（0 基）
   * @returns {{system:string, user:string}|null} 下标越界返回 null
   */
  buildSectionPrompt(metas, outline, idx) {
    const secs = Array.isArray(outline) ? outline : [];
    const i = Number(idx);
    if (!isFinite(i) || i < 0 || i >= secs.length) return null;
    const sec = secs[i] || {};
    const list = this._normList(metas);

    const system = "你是一位严谨的学术综述写作者，正在逐节撰写一篇文献综述。必须遵守以下证据纪律：\n" +
      "1) 只使用用户给出的文献材料，不得引入任何外部文献、常识或「众所周知」的结论；\n" +
      "2) 任何引用都必须写成「文献 n」（n 为材料编号，可并列如「文献 2、文献 5」）；" +
      "不要使用 [1]、(Author, 2020)、上标等其他格式，也不要自行编号；\n" +
      "3) 严格区分「文献结论」与「你的推断」：推断必须显式标注（如「据此可以推断」），不得把推断写成文献原话；\n" +
      "4) 禁止编造数据、样本量、统计量、页码、年份或直接引语；材料没有给出的一律不写，宁可少写；\n" +
      "5) 只写本节内容，不重复其他节的标题与论述；不要输出参考文献列表；\n" +
      "6) 输出纯 Markdown 正文（可用小标题、列表），不要代码围栏。";

    const done = secs.slice(0, i).map((s, k) =>
      "第 " + (s && s.n != null ? s.n : k + 1) + " 节《" + this._str(s && s.title) + "》");
    const blocks = list.map((m) => {
      const head = "[文献 " + m.n + "] " + m.title +
        "（" + (m.year || "年份不详") + "）" + (m.journal ? " · " + m.journal : "");
      const body = m.abstract ? "\n摘要：" + this._clip(m.abstract, this.SECTION_ABSTRACT_CHARS) : "";
      return head + body;
    });

    const user = "【本节目标】第 " + (sec.n != null ? sec.n : i + 1) + " 节《" +
      this._str(sec.title) + "》" + (this._str(sec.desc) ? "：" + this._str(sec.desc) : "") + "\n" +
      "【已完成节标题】" + (done.length
        ? done.join("；") + "（不要重复这些节已写的内容）"
        : "（本节为首节，无前序内容）") + "\n" +
      "【文献材料】共 " + list.length + " 篇\n" + blocks.join("\n\n") + "\n\n" +
      "请撰写本节正文（400-800 字），引用一律用「文献 n」。";

    return { system: system, user: user };
  },

  /**
   * 拼完整 Markdown：# 标题 + 各节 + 末尾「## 参考文献」
   * @param {string} title
   * @param {Array} metas
   * @param {Array} outline
   * @param {Array<{n:number,title:string,text:string}>} sections
   */
  assembleDraft(title, metas, outline, sections) {
    const list = this._normList(metas);
    const secs = Array.isArray(outline) ? outline : [];
    const got = Array.isArray(sections) ? sections : [];
    const byN = new Map();
    for (const s of got) {
      if (s && s.n != null) byN.set(Number(s.n), s);
    }
    const ordered = secs.length
      ? secs.map((sec, i) => ({ sec: sec || {}, body: byN.get(Number(sec && sec.n)) || got[i] }))
      : got.map((s, i) => ({ sec: { n: s && s.n != null ? s.n : i + 1, title: this._str(s && s.title) }, body: s }));

    let md = "# " + (this._str(title) || this.DEFAULT_TITLE) + "\n\n";
    for (const item of ordered) {
      const body = item.body && typeof item.body.text === "string" ? item.body.text.trim() : "";
      if (!body) continue; // 失败/空节不占标题，避免导出半截空段
      const n = item.sec.n != null ? item.sec.n : 1;
      md += "## " + n + ". " + this._str(item.sec.title) + "\n\n" + body + "\n\n";
    }
    if (list.length) {
      md += "## 参考文献\n\n" + list.map((m, i) => this._refLine(m, i + 1)).join("\n") + "\n";
    }
    return md.trim();
  },

  /**
   * 「文献 n」→ [文献 n](zotero://select/library/items/<itemKey>)
   *  · 越界编号 / meta 缺 key → 原样保留；
   *  · 已是 markdown 链接文本（[文献 n](…)）→ 不重复包裹；
   *  · 顺手吞掉 AI 常写的「」与 [] 包裹，避免 [[文献 2](…)]。
   */
  citeToLink(md, metas) {
    const list = this._normList(metas);
    const text = String(md == null ? "" : md);
    const re = /(\[)?(「)?文献\s*(\d+)(」)?(\])?/g;
    return text.replace(re, function (full, lb, lq, numStr, rq, rb, offset, whole) {
      const n = parseInt(numStr, 10);
      const meta = list[n - 1];
      const key = meta && meta.key ? String(meta.key) : "";
      const hasOpen = !!lb;
      const hasClose = !!rb;
      // 已在 markdown 链接中：[文献 2](url)
      if (hasClose && whole.charAt(offset + full.length) === "(") return full;
      if (!key || !/^[A-Za-z0-9]+$/.test(key)) return full;
      const link = "[文献 " + n + "](zotero://select/library/items/" + key + ")";
      if (hasOpen && !hasClose) return link; // 0.54.0（审查 P2-8）：半截括号不再补 "["，避免畸形 Markdown
      if (lq && !rq) return "「" + link;
      return link;
    });
  },

  /** 去掉外层 ```markdown / ``` 围栏（只剥最外层，保留正文里的代码块） */
  stripFences(text) {
    let s = String(text == null ? "" : text).replace(/^\uFEFF/, "").trim();
    if (!s) return "";
    const whole = s.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    if (whole) return whole[1].trim();
    s = s.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "").trim();
    return s;
  },

  /* ==================== ② 编排 API ==================== */

  _zotero() {
    try { return typeof Zotero !== "undefined" && Zotero ? Zotero : null; } catch (e) { return null; }
  },

  _defaultGuidance() {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") {
        const t = I18n.t("chatNoKey");
        if (t) return t;
      }
    } catch (e) { /* ignore */ }
    return "请先在 设置 → Papilot 登录账号，或在「AI 模型通道」中配置自己的接口";
  },

  /** AI 就绪状态（窗口打开时据此禁用按钮） */
  aiReady() {
    try {
      const has = typeof AIClient !== "undefined" && AIClient &&
        typeof AIClient.hasKey === "function" && AIClient.hasKey();
      if (has) return { ok: true };
      let guidance = "";
      try {
        if (typeof AIClient !== "undefined" && AIClient &&
          typeof AIClient.guidance === "function") guidance = AIClient.guidance();
      } catch (e) { guidance = ""; }
      return { ok: false, reason: "no_key", guidance: guidance || this._defaultGuidance() };
    } catch (e) {
      return { ok: false, reason: "no_key", guidance: this._defaultGuidance() };
    }
  },

  _aiChat(messages) {
    if (typeof AIClient === "undefined" || !AIClient || typeof AIClient.chat !== "function") {
      throw new Error("AI 客户端未就绪");
    }
    return AIClient.chat(messages);
  },

  /**
   * 生成分节大纲
   * @returns {Promise<{ok:true, outline:Array, raw:string}|{ok:false, reason:string, error?:string, guidance?:string, raw?:string}>}
   */
  async generateOutline(metas) {
    try {
      const list = this._normList(metas);
      if (!list.length) return { ok: false, reason: "no_items" };
      const ready = this.aiReady();
      if (!ready.ok) return { ok: false, reason: "no_key", guidance: ready.guidance };
      const p = this.buildOutlinePrompt(list);
      const raw = await this._aiChat([
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ]);
      const text = this.stripFences(raw);
      const outline = this.parseOutline(text);
      if (!outline.length) {
        return { ok: false, reason: "parse_failed", error: "未能从 AI 输出中解析出分节大纲", raw: String(raw || "") };
      }
      return { ok: true, outline: outline, raw: String(raw || "") };
    } catch (e) {
      return { ok: false, reason: "ai_failed", error: String((e && e.message) || e) };
    }
  },

  /**
   * 逐节起草（顺序执行；单节失败记录后继续）
   * @param {Function} onProgress (doneCount, total) 每节结束后回调（成功与失败都算）
   * @returns {Promise<{ok:boolean, sections:Array, failed:Array<number>, reason?:string, error?:string}>}
   */
  async draftSections(metas, outline, onProgress) {
    const secs = Array.isArray(outline) ? outline : [];
    if (!secs.length) return { ok: false, reason: "no_outline", sections: [], failed: [] };
    try {
      const ready = this.aiReady();
      if (!ready.ok) {
        return { ok: false, reason: "no_key", guidance: ready.guidance, sections: [], failed: [] };
      }
      const list = this._normList(metas);
      const total = secs.length;
      const sections = [];
      const failed = [];
      for (let i = 0; i < total; i++) {
        const sec = secs[i] || {};
        try {
          const p = this.buildSectionPrompt(list, secs, i);
          if (!p) throw new Error("大纲下标越界");
          const raw = await this._aiChat([
            { role: "system", content: p.system },
            { role: "user", content: p.user },
          ]);
          const text = this.stripFences(raw);
          if (!text.trim()) throw new Error("AI 返回本节内容为空");
          sections.push({
            n: sec.n != null ? sec.n : i + 1,
            title: this._str(sec.title),
            text: text.trim(),
          });
        } catch (e) {
          failed.push(i);
        }
        if (typeof onProgress === "function") {
          try { onProgress(i + 1, total); } catch (e) { /* 回调异常不得中断起草 */ }
        }
      }
      return {
        ok: sections.length > 0,
        sections: sections,
        failed: failed,
        total: total,
      };
    } catch (e) {
      return { ok: false, reason: "ai_failed", error: String((e && e.message) || e), sections: [], failed: [] };
    }
  },

  /** 第一条能解析成 Zotero 条目的 meta（笔记挂靠点） */
  async _firstItem(metas) {
    const Z = this._zotero();
    const list = Array.isArray(metas) ? metas : [];
    if (!Z || !Z.Items) return null;
    for (const m of list) {
      if (!m) continue;
      try {
        if (m.id != null && typeof Z.Items.get === "function") {
          const it = Z.Items.get(m.id);
          if (it) return it;
        }
      } catch (e) { /* 试下一个 */ }
      try {
        if (m.key && m.libraryID != null && typeof Z.Items.getByLibraryAndKey === "function") {
          const it = await Z.Items.getByLibraryAndKey(m.libraryID, m.key);
          if (it) return it;
        }
      } catch (e) { /* 试下一个 */ }
    }
    return null;
  },

  /**
   * 笔记内引用链接化：Notes.createFromMarkdown 走 MdLite（只认标题/加粗/代码），
   * Markdown 链接会原样变成字面文本。这里把字面 `[文献 n](zotero://…)` 就地
   * 替换为 <a href>，让笔记里的引用也能点击跳条目。失败不影响笔记本体。
   */
  /** 纯字符串：把 [文献 n](zotero://…) 转成可点击 <a>（供 createFromMarkdown 的 transformHtml） */
  _linkifyHtml(html) {
    const src = String(html == null ? "" : html);
    if (src.indexOf("[文献 ") < 0) return src;
    return src.replace(/\[(文献 \d+)\]\((zotero:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  },

  /**
   * 保存为笔记（挂到第一篇文献下）
   * @returns {Promise<{ok:true, noteID:number}|{ok:false, reason:string, error?:string}>}
   */
  async saveAsNote(metas, draftMd, title) {
    try {
      if (typeof Notes === "undefined" || !Notes || typeof Notes.createFromMarkdown !== "function") {
        return { ok: false, reason: "notes_unavailable" };
      }
      const md = String(draftMd == null ? "" : draftMd);
      if (!md.trim()) return { ok: false, reason: "empty_draft" };
      const item = await this._firstItem(metas);
      if (!item) return { ok: false, reason: "no_item" };
      const name = this._str(title) || this.DEFAULT_TITLE;
      // 0.54.0（审查 P2-9）：引用链接在落盘前一次成型，单次 saveTx（原先二次写盘）
      const note = await Notes.createFromMarkdown(item, name, md, {
        transformHtml: (h) => this._linkifyHtml(h),
      });
      return { ok: true, noteID: note && note.id != null ? note.id : null };
    } catch (e) {
      return { ok: false, reason: "save_failed", error: String((e && e.message) || e) };
    }
  },

  /* ==================== ③ 题录采集 + 窗口 ==================== */

  /** Zotero 条目 → meta（key 供 citeToLink 用；id/libraryID 供 saveAsNote 回查） */
  metaOf(item) {
    const get = (f) => {
      try { return item.getField(f) || ""; } catch (e) { return ""; }
    };
    let authors = "";
    try {
      const cs = item.getCreators() || [];
      authors = cs.slice(0, 3).map((c) => {
        if (c.fieldMode === 1) return c.lastName || "";
        return [c.firstName, c.lastName].filter(Boolean).join(" ");
      }).filter(Boolean).join(", ");
      if (cs.length > 3) authors += ", et al.";
    } catch (e) { /* ignore */ }
    return {
      key: this._str(item.key),
      id: item.id,
      libraryID: item.libraryID,
      title: this._str(get("title")) || "（无标题）",
      authors: authors,
      year: this._str(get("date")).slice(0, 4),
      journal: this._str(get("publicationTitle")),
      abstract: this._str(get("abstractNote")),
    };
  },

  collectMetas(items) {
    const out = [];
    const seen = new Set();
    for (const it of items || []) {
      if (!it) continue;
      try {
        const id = it.id;
        if (id != null) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        if (typeof it.isRegularItem === "function" && !it.isRegularItem()) continue;
        out.push(this.metaOf(it));
        if (out.length >= this.MAX_ITEMS) break;
      } catch (e) { /* 单条失败跳过 */ }
    }
    return out;
  },

  _alert(text) {
    try {
      if (typeof Services !== "undefined" && Services && Services.prompt) {
        Services.prompt.alert(this._zotero().getMainWindow(), "Papilot · 综述工作台", text);
        return;
      }
    } catch (e) { /* ignore */ }
  },

  /**
   * 打开工作台（单例：已开则聚焦并换入新题录）
   * @param {Array<Item>|Array<number>|Item|number} [itemsOrIDs] 省略 → 取当前选中
   */
  openDialog(itemsOrIDs) {
    try {
      const Z = this._zotero();
      if (!Z) return null;
      const Sv = (typeof Services !== "undefined" && Services) ? Services : null;

      let raw = itemsOrIDs;
      if (!raw) {
        try {
          const zp = Z.getActiveZoteroPane();
          raw = zp ? (zp.getSelectedItems() || []) : [];
        } catch (e) { raw = []; }
      }
      if (!Array.isArray(raw)) raw = [raw];

      const items = [];
      const seen = new Set();
      for (const entry of raw) {
        let it = entry;
        if (typeof entry === "number" || typeof entry === "string") {
          try { it = Z.Items.get(Number(entry)); } catch (e) { it = null; }
        }
        try {
          if (it && typeof it.isAttachment === "function" && it.isAttachment() && it.parentID) {
            it = Z.Items.get(it.parentID);
          }
        } catch (e) { /* 保持原对象 */ }
        if (!it) continue;
        try {
          if (typeof it.isRegularItem === "function" && !it.isRegularItem()) continue;
        } catch (e) { /* 保留 */ }
        if (it.id != null) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
        }
        items.push(it);
      }

      if (!items.length) {
        this._alert("请先在条目列表中选中至少一篇文献（可多选）。\n选 PDF 附件也可以，会自动定位到父条目。");
        return null;
      }

      const trimmed = items.length > this.MAX_ITEMS;
      const metas = this.collectMetas(items.slice(0, this.MAX_ITEMS));

      // 单例：已开则聚焦并换入新题录（windowtype 与 openDialog 的窗口名不是一回事）
      try {
        if (Sv && Sv.wm) {
          const en = Sv.wm.getEnumerator(this.WINDOW_TYPE);
          if (en.hasMoreElements()) {
            const w = en.getNext();
            try { w.focus(); } catch (e) { /* ignore */ }
            try {
              if (typeof w.PapilotSetPayload === "function") {
                w.PapilotSetPayload({ metas: metas, trimmed: trimmed });
              }
            } catch (e) { /* ignore */ }
            return w;
          }
        }
      } catch (e) { /* 枚举失败 → 照常开新窗 */ }

      const win = Z.getMainWindow();
      if (!win) return null;
      return win.openDialog(
        this.WINDOW_URL,
        this.WINDOW_NAME,
        "chrome,centerscreen,resizable,dialog=no",
        {
          Zotero: Z,
          Services: Sv,
          metas: metas,
          itemIDs: metas.map((m) => m.id).filter((x) => x != null),
          trimmed: trimmed,
          maxItems: this.MAX_ITEMS,
          api: this,
        }
      );
    } catch (e) {
      try { this._zotero().logError(e); } catch (e2) { /* ignore */ }
      return null;
    }
  },
};
