// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 导出到 Obsidian（0.62.0）
 *
 * 为什么只做「单向」：Notero（3,233★）/ mdnotes（1,399★）证明「把库同步到笔记工具」是刚需，
 * 但双向同步意味着 OAuth、增量游标、冲突合并与长期维护债。这里的取舍是——
 * **只导出，不回读**：一条命令把选中条目变成一组 Markdown 文件，落进用户指定的 vault 子目录。
 *
 * 差异化：导出的不是「原始笔记的搬运」，而是 Papilot 已经加工过的东西——
 * 结构化 front-matter、AI 摘要（可选）、批注摘录、以及一条 GB/T 7714 引用。
 *
 * 纯函数（文件名清洗 / front-matter 转义 / Markdown 组装）放在前半段，可在 Node 单测；
 * 运行时只负责选目录、收集批注、写文件。
 */
/* global Zotero, Services, Components, IOUtils, PathUtils, Prefs, I18n, Annotations, AIChat, RefFormat, CiteExport */

var ObsidianExport = {
  SUBFOLDER: "Papilot",

  /* ==================== 纯函数 ==================== */

  /** Windows/POSIX 共用的非法字符；同时避开 CON/PRN 等保留名与首尾点空格 */
  sanitizeName(name, max) {
    let s = String(name == null ? "" : name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, "");
    const limit = Math.max(12, Number(max) || 80);
    if (s.length > limit) s = s.slice(0, limit).trim();
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = "_" + s;
    return s || "untitled";
  },

  /** 文件名：`作者年份 标题.md`（作者取首位；无作者就只用年份/标题）。
   *  这里**不用** GB/T 的「姓全大写」写法——文件名是给人看的，`Zhang2020` 比 `ZHANG W2020` 好认。 */
  buildFileName(rec, opts) {
    const o = opts || {};
    const a = (rec && rec.authors && rec.authors[0]) || null;
    const first = a ? String(a.literal || a.family || "").trim() : "";
    const year = (rec && rec.year) || "";
    const title = (rec && rec.title) || "";
    const head = [first, year].filter(Boolean).join("");
    const raw = [head, title].filter(Boolean).join(" ").trim();
    return this.sanitizeName(raw || (rec && rec.container) || "untitled", o.maxLen || 72) + ".md";
  },

  /** YAML 双引号字符串：转义反斜杠、引号、换行 */
  yamlStr(s) {
    const v = String(s == null ? "" : s).replace(/\r?\n/g, " ").replace(/"/g, '\\"');
    return '"' + v + '"';
  },

  yamlList(arr) {
    const list = (arr || []).filter((x) => String(x || "").trim()).map((x) => this.yamlStr(x));
    return "[" + list.join(", ") + "]";
  },

  /** 批注分组 → Markdown 列表（保持页码与评论层级） */
  formatAnnotations(groups, zh) {
    const lines = [];
    for (const g of groups || []) {
      for (const a of (g && g.list) || []) {
        if (!a) continue;
        const page = a.page ? (zh ? "（p." + a.page + "）" : " (p." + a.page + ")") : "";
        if (a.text) lines.push("- " + String(a.text).replace(/\n+/g, " ") + page);
        if (a.comment) lines.push("  - " + String(a.comment).replace(/\n+/g, " "));
      }
    }
    return lines.join("\n");
  },

  /**
   * 单条 → Markdown 全文（front-matter + 正文）。
   * @param p {rec, tags, collections, itemKey, annotations, aiSummary, citation, zh}
   * @param opts {cite?:boolean=true, ai?:boolean}
   */
  buildMarkdown(p, opts) {
    const o = opts || {};
    const rec = p.rec || {};
    const zh = p.zh !== false;
    const fm = [
      "---",
      "title: " + this.yamlStr(rec.title),
      "authors: " + this.yamlList((rec.authors || []).map((a) => RefFormat.gbtAuthorName(a))),
      "year: " + (rec.year || ""),
      "journal: " + this.yamlStr(rec.container || rec.publisher || ""),
      "doi: " + this.yamlStr(rec.doi || ""),
      "itemType: " + this.yamlStr(rec.itemType || ""),
      "tags: " + this.yamlList(p.tags || []),
      "collections: " + this.yamlList(p.collections || []),
      "zotero: " + this.yamlStr(p.itemKey ? "zotero://select/library/items/" + p.itemKey : ""),
      "---",
      "",
    ];

    const body = [];
    body.push("# " + (rec.title || (zh ? "（无标题）" : "(untitled)")));
    const meta = [((p.authorsText) || ""), rec.container, rec.year].filter(Boolean).join(" · ");
    if (meta) body.push("", "> " + meta);
    if (rec.abstract) body.push("", "## " + (zh ? "摘要" : "Abstract"), "", rec.abstract);
    if (p.aiSummary) body.push("", "## " + (zh ? "AI 摘要" : "AI summary"), "", p.aiSummary);
    if (p.annotations) body.push("", "## " + (zh ? "批注" : "Annotations"), "", p.annotations);
    if (o.cite !== false && p.citation) body.push("", "## " + (zh ? "引用" : "Citation"), "", p.citation);

    return fm.join("\n") + body.join("\n") + "\n";
  },

  /** 冲突文件名：`名字.md` → `名字-2.md` */
  withSuffix(fileName, n) {
    const k = Number(n) || 0;
    if (k <= 1) return fileName;
    return String(fileName).replace(/\.md$/i, "") + "-" + k + ".md";
  },

  /* ==================== 运行时 ==================== */

  folder() {
    try { return String(Prefs.get("obsidianExportFolder", "") || ""); } catch (e) { return ""; }
  },

  setFolder(p) {
    try { Prefs.set("obsidianExportFolder", String(p || "")); } catch (e) { /* ignore */ }
  },

  /** 选目录（返回绝对路径；取消返回 ""） */
  async chooseFolder() {
    try {
      const win = Zotero.getMainWindow();
      const fp = Components.classes["@mozilla.org/filepicker;1"]
        .createInstance(Components.interfaces.nsIFilePicker);
      const ctx = (win && win.browsingContext) || win;
      if (fp.init) fp.init(ctx, I18n.t("obsidianPickFolder"), fp.modeGetFolder);
      const rv = await new Promise((resolve) => fp.open(resolve));
      if (rv === fp.returnCancel || !fp.file) return "";
      return fp.file.path || "";
    } catch (e) {
      Zotero.logError(e);
      return "";
    }
  },

  /** 条目 → 载荷（不含 AI，AI 摘要由调用方按需补） */
  payloadFor(item, zh) {
    const rec = (CiteExport.recordsFromItems([item]) || [])[0];
    if (!rec) return null;
    let tags = [];
    try { tags = (item.getTags() || []).map((t) => t && t.tag).filter(Boolean); } catch (e) { tags = []; }
    let collections = [];
    try {
      collections = (item.getCollections() || []).map((id) => {
        try { return (Zotero.Collections.get(id) || {}).name || ""; } catch (e) { return ""; }
      }).filter(Boolean);
    } catch (e) { collections = []; }

    let annotations = "";
    try { annotations = this.formatAnnotations(Annotations.collect(item), zh); } catch (e) { annotations = ""; }

    let citation = "";
    try { citation = RefFormat.gbtEntry(rec, { maxAuthors: 3, doi: true }); } catch (e) { citation = ""; }

    return {
      rec, tags, collections,
      itemKey: (item && item.key) || "",
      annotations, citation, zh,
      authorsText: (rec.authors || []).map((a) => RefFormat.gbtAuthorName(a)).join(", "),
    };
  },

  /**
   * 批量导出。
   * @param items Zotero 常规条目
   * @param opts {folder, ai?:boolean, onProgress?(i,n,title)}
   * @returns {Promise<{dir:string, written:number, failed:Array}>}
   */
  async exportItems(items, opts) {
    const o = opts || {};
    const root = String(o.folder || "").trim();
    const out = { dir: "", written: 0, files: [], failed: [] };
    if (!root) return out;
    const dir = PathUtils.join(root, this.SUBFOLDER);
    try {
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    } catch (e) {
      Zotero.logError(e);
      out.failed.push({ title: "", reason: "mkdir" });
      return out;
    }
    out.dir = dir;

    const zh = !!I18n.isZh;
    let i = 0;
    for (const item of items || []) {
      i++;
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      try { if (o.onProgress) o.onProgress(i, items.length, title); } catch (e) { /* ignore */ }

      const payload = this.payloadFor(item, zh);
      if (!payload) { out.failed.push({ title, reason: "no-record" }); continue; }

      if (o.ai) {
        try { payload.aiSummary = await AIChat.summarize(item); } catch (e) { payload.aiSummary = ""; }
      }

      let fileName = this.buildFileName(payload.rec, {});
      let target = PathUtils.join(dir, fileName);
      try {
        let n = 2;
        // 冲突：同一篇重复导出时保留旧文件，新增 `-2` / `-3`
        while (await IOUtils.exists(target)) {
          fileName = this.withSuffix(this.buildFileName(payload.rec, {}), n++);
          target = PathUtils.join(dir, fileName);
          if (n > 999) break;
        }
        await IOUtils.writeUTF8(target, this.buildMarkdown(payload, { ai: !!o.ai }));
        out.written++;
        out.files.push(fileName);
      } catch (e) {
        Zotero.logError(e);
        out.failed.push({ title, reason: "write" });
      }
    }
    return out;
  },

  /** 菜单入口：选目录 → 确认（含 AI 摘要开关）→ 导出 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    let items = [];
    try { items = (zp.getSelectedItems() || []).filter((it) => it && it.isRegularItem && it.isRegularItem()); } catch (e) { items = []; }
    if (!items.length) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot", I18n.t("obsidianNoItems"));
      return;
    }

    let folder = this.folder();
    if (!folder) {
      folder = await this.chooseFolder();
      if (!folder) return;
      this.setFolder(folder);
    }

    const win = Zotero.getMainWindow();
    const ai = { value: false };
    const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
      + Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL;
    const choice = Services.prompt.confirmEx(win, "Papilot · " + I18n.t("obsidianExportTitle"),
      I18n.t("obsidianConfirm").replace("{n}", String(items.length)).replace("{dir}", PathUtils.join(folder, this.SUBFOLDER)),
      flags, I18n.t("obsidianExportBtn"), null, null,
      I18n.t("obsidianIncludeAi"), ai);
    if (choice !== 0) return;

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("obsidianExportTitle"));
    pw.show();
    const r = await this.exportItems(items, {
      folder,
      ai: !!ai.value,
      onProgress: (i, n, title) => {
        try { new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title); } catch (e) { /* ignore */ }
      },
    });
    try {
      if (r.written) new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", I18n.t("obsidianDone").replace("{n}", String(r.written)));
    } catch (e) { /* ignore */ }
    pw.startCloseTimer(3500);
    if (r.failed.length && !r.written) {
      Services.prompt.alert(win, "Papilot", I18n.t("obsidianFailed"));
    }
  },
};
