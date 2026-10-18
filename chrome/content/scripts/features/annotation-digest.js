/* PaperPilot 标注 → 论点速记（0.52.0）
 *
 * 选中条目 → 读其 PDF 全部标注（高亮/下划线/笔记，上限 60 条）
 * → 交给 AI 整理成「论点-证据-页码」结构化速记 → 存为父条目下的笔记。
 *
 * 设计要点：
 *  - collect 复用 features/annotations.js 的取法：只认 PDF 附件，逐条读
 *    annotationText/Comment/PageLabel/Color，正文与批注都空的直接丢弃
 *    （划词浮窗留下的空壳标注会污染提示词）。
 *  - buildPrompt 是纯函数（无 Zotero/AI 依赖），便于单测形状与证据纪律约束。
 *  - run 全程 try/catch：任何异常都转成 {ok:false, reason}，不抛给菜单层，
 *    避免 Zotero 主进程被未捕获 Promise 拖垮。
 *  - 预览：opts.dryRun === true 只返回 markdown，不落盘。
 *  - 开关 annotationDigestEnabled 由集成方（菜单）判断，模块内不读。
 */
/* global Zotero, AIClient, Notes, Chat */

var AnnotationDigest = {
  /** 集成方接菜单用的稳定 id */
  MENU_ID: "annotation-digest",
  /** 单次最多送入提示词的标注条数（超长提示词会挤掉输出预算） */
  MAX_NOTES: 60,
  /** 落盘笔记标题（与菜单文案解耦，便于用户/测试稳定识别） */
  NOTE_TITLE: "论文速记（AI 整理）",

  _get(item, field) {
    try { return item.getField(field) || ""; } catch (e) { return ""; }
  },

  /** 题录：优先复用 Chat.paperMeta（单一真源），不可用时本地兜底 */
  _meta(item) {
    try {
      if (typeof Chat !== "undefined" && Chat && typeof Chat.paperMeta === "function") {
        const m = Chat.paperMeta(item);
        if (m && m.title !== undefined) return m;
      }
    } catch (e) { /* 落到本地兜底 */ }
    let creators = "";
    try {
      creators = (item.getCreators() || [])
        .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).join(", ");
    } catch (e) { /* 附件无 creators */ }
    return {
      title: this._get(item, "title"),
      creators,
      year: this._get(item, "date").slice(0, 4),
      pub: this._get(item, "publicationTitle"),
    };
  },

  /** 条目的第一个 PDF 附件；没有返回 null */
  _pdfAttachment(item) {
    let ids = [];
    try { ids = item.getAttachments() || []; } catch (e) { return null; }
    for (const id of ids) {
      let att = null;
      try { att = Zotero.Items.get(id); } catch (e) { att = null; }
      if (!att) continue;
      let isPdf = false;
      try { isPdf = att.attachmentContentType === "application/pdf"; } catch (e) { isPdf = false; }
      if (!isPdf) {
        try { isPdf = !!(att.isPDFAttachment && att.isPDFAttachment()); } catch (e) { isPdf = false; }
      }
      if (isPdf) return att;
    }
    return null;
  },

  /**
   * 收集标注
   * @returns {Promise<{ok:boolean, annotations:Array, total:number, reason?:string}>}
   *   annotations: [{text, comment, pageLabel, color}]（已截断到 MAX_NOTES）
   *   total: 截断前的有效标注条数
   */
  async collect(item) {
    if (!item) return { ok: false, annotations: [], total: 0, reason: "no_item" };
    const att = this._pdfAttachment(item);
    if (!att) return { ok: false, annotations: [], total: 0, reason: "no_pdf" };

    let raw = [];
    let failed = "";
    try {
      // Zotero 7+：附件对象上的 getAnnotations() 同步返回注解条目数组。
      // 这里 await 兼容同步返回与（未来）异步实现。
      raw = (await att.getAnnotations()) || [];
    } catch (e) {
      failed = String((e && e.message) || e);
      raw = [];
    }

    const out = [];
    let total = 0;
    for (const ann of raw) {
      try {
        const text = String(ann.annotationText || "").trim();
        const comment = String(ann.annotationComment || "").trim();
        if (!text && !comment) continue;
        total++;
        if (out.length >= this.MAX_NOTES) continue; // 仍然计数，只为拿到真实 total
        out.push({
          text,
          comment,
          pageLabel: String(ann.annotationPageLabel || ""),
          color: String(ann.annotationColor || ""),
        });
      } catch (e) { /* 单条读取失败跳过 */ }
    }

    const res = { ok: true, annotations: out, total };
    if (failed) res.reason = "annotations_error";
    if (failed) res.error = failed;
    return res;
  },

  /** 标注 → 提示词里的单行（编号 + 页码 + 原文 / 批注） */
  _formatAnnotation(a, i) {
    const page = a.pageLabel ? "p." + a.pageLabel : "页码未标注";
    const lines = ["[" + (i + 1) + "] (" + page + ") 原文：「" + (a.text || "（无原文）") + "」"];
    if (a.comment) lines.push("    批注：" + a.comment);
    return lines.join("\n");
  },

  /**
   * 构造提示词（纯函数，无副作用）
   * @param {{title:string, creators:string, year:string, pub?:string}} meta
   * @param {Array<{text, comment, pageLabel, color}>} annotations
   * @returns {{system:string, user:string}}
   */
  buildPrompt(meta, annotations) {
    const m = meta || {};
    const list = Array.isArray(annotations) ? annotations : [];
    const title = m.title || "（未命名文献）";
    const authors = m.creators || "（未记录）";
    const year = m.year || "（未记录）";
    const pub = m.pub || "";
    const few = list.length < 3;

    const system = [
      "你是严谨的学术阅读助手，任务是把我 PDF 里的标注整理成「论点-证据-页码」速记。",
      "",
      "证据纪律（必须全部遵守）：",
      "1. 只使用下方给出的标注原文与批注，禁止引入标注外的内容——不得补全论文其他段落，不得添加未给出的数据、文献或结论。",
      "2. 页码必须原样引用标注中给出的 p.<页码>，不得自行推算、四舍五入或省略；标注本身没有页码时写「页码未标注」。",
      "3. 严格区分两类信息：标注原文必须逐字摘录并放在「」内，一字不改；你自己的归纳与推断必须显式写成「推断：…」。",
      "4. 标注不足以支撑某个论点时，宁可不写该论点，也不要凑数或合并无关标注。",
      "5. 输出中文，使用规范的学术书面语，不用感叹号，不写空洞的评价词。",
    ].join("\n");

    const lines = [
      "【题录】",
      "标题：" + title,
      "作者：" + authors,
      "年份：" + year,
    ];
    if (pub) lines.push("来源：" + pub);
    lines.push(
      "",
      "【标注清单】共 " + list.length + " 条（编号 / 页码 / 原文 / 我的批注）",
      list.length ? list.map((a, i) => this._formatAnnotation(a, i)).join("\n") : "（无）",
      "",
      "【输出契约】严格按下面的 Markdown 结构输出，不要添加额外章节，不要写任何前言或结语：",
      "## 论文速记：" + title,
    );

    if (few) {
      lines.push(
        "### 要点清单",
        "- 要点 1：「标注原文摘录」——p.<页码>（标注 1）",
        "### 我的批注要点",
        "- …",
        "### 待追问",
        "- …",
        "",
        "要求：",
        "- 本次标注少于 3 条，不足以支撑论点归纳：**只做「要点清单」，不要写「核心论点」，不要硬造论点**。",
        "- 每条要点必须挂标注编号与页码，且原文摘录放在「」内。",
        "- 「我的批注要点」只整理我写下的批注（没有批注就写「（本条目标注无批注）」）。",
        "- 「待追问」给 1-3 条基于这些标注才成立的问题，不要泛泛而谈。"
      );
    } else {
      lines.push(
        "### 核心论点",
        "- 论点 1（标注 1、3 支持）",
        "### 证据与出处",
        "- [论点 1] 「标注原文摘录」——p.<页码>（标注 3）",
        "### 我的批注要点",
        "- …",
        "### 待追问",
        "- …",
        "",
        "要求：",
        "- 核心论点写 2-5 条，每条必须挂标注编号与页码（写法：（标注 1、3 支持））；标注编号只能用清单里出现过的编号。",
        "- 「证据与出处」逐条对应核心论点：论点编号 + 「原文摘录」+ p.<页码> + （标注 k），页码照抄标注，不得改写。",
        "- 「我的批注要点」只整理我写下的批注；没有批注就写「（本条目标注无批注）」。",
        "- 「待追问」给 2-4 条基于这些标注才成立的问题，不要泛泛而谈。"
      );
    }

    return { system, user: lines.join("\n") };
  },

  /** 去掉模型可能加的 ```markdown 围栏（只清最外层，内容原样保留） */
  cleanMarkdown(text) {
    let s = String(text == null ? "" : text).replace(/\r\n/g, "\n").trim();
    if (!s) return "";
    const fence = s.match(/^```[A-Za-z]*[ \t]*\n([\s\S]*?)\n?```$/);
    if (fence) return fence[1].trim();
    // 半截围栏（模型截断）：逐行剥掉首尾的 ``` 行
    const rows = s.split("\n");
    if (/^```/.test(rows[0] || "")) rows.shift();
    while (rows.length && !String(rows[rows.length - 1]).trim()) rows.pop();
    if (/^```/.test(rows[rows.length - 1] || "")) rows.pop();
    return rows.join("\n").trim();
  },

  _errText(e) {
    return String((e && e.message) || e || "未知错误");
  },

  /**
   * 编排：collect → AIClient.chat → Notes.createFromMarkdown
   * @param item 常规条目（或其 PDF 附件）
   * @param {{dryRun?:boolean}=} opts dryRun 只返回 markdown 不落盘
   * @returns {Promise<{ok:boolean, noteID?:number|null, title?:string, markdown?:string,
   *                    reason?:string, message?:string, error?:string, total?:number}>}
   */
  async run(item, opts) {
    const o = opts || {};
    let col;
    try {
      col = await this.collect(item);
    } catch (e) {
      return { ok: false, reason: "collect_failed", error: this._errText(e) };
    }

    if (!col.ok) {
      const msg = col.reason === "no_item"
        ? "未选中条目：请先选中一篇文献"
        : "未找到 PDF 附件：请先为该条目添加 PDF，再在 PDF 里标注";
      return { ok: false, reason: col.reason || "no_pdf", message: msg };
    }
    if (!col.annotations.length) {
      const note = col.reason === "annotations_error"
        ? "（读取标注失败：" + (col.error || "") + "）"
        : "";
      return {
        ok: false,
        reason: "no_annotations",
        message: "无标注：请先在 PDF 里高亮或加批注" + note,
        error: col.reason === "annotations_error" ? col.error : undefined,
        total: col.total,
      };
    }

    const meta = this._meta(item);
    const prompt = this.buildPrompt(meta, col.annotations);
    const messages = [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ];

    let raw = "";
    try {
      if (typeof AIClient === "undefined" || !AIClient || typeof AIClient.chat !== "function") {
        throw new Error("AI 客户端未加载");
      }
      raw = await AIClient.chat(messages);
    } catch (e) {
      return { ok: false, reason: "ai_failed", error: this._errText(e) };
    }

    const md = this.cleanMarkdown(raw);
    if (!md) return { ok: false, reason: "ai_failed", error: "AI 返回内容为空" };

    const title = this.NOTE_TITLE;
    const base = { title, markdown: md, total: col.total, used: col.annotations.length };
    if (o.dryRun === true) return Object.assign({ ok: true, dryRun: true, noteID: null }, base);

    if (typeof Notes === "undefined" || !Notes || typeof Notes.createFromMarkdown !== "function") {
      return Object.assign({ ok: false, reason: "notes_unavailable" }, base);
    }

    try {
      const note = await Notes.createFromMarkdown(item, title, md);
      return Object.assign({ ok: true, noteID: note && note.id ? note.id : null }, base);
    } catch (e) {
      return Object.assign({ ok: false, reason: "save_failed", error: this._errText(e) }, base);
    }
  },
};
