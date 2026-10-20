// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 参考文献导出（GB/T 7714，0.61.0）
 *
 * 为什么要有它：`ref-format.js` 早就能**解析**国标题录（知网参考文献列表粘进来能认），
 * 但没有反向出口——用户没法把库里的条目导出成一段能直接粘进 Word 的国标参考文献表。
 * 竞品（BBT / zotero-reference 等）基本只做 BibTeX，国标输出是中文写作场景的空位。
 *
 * 分工：
 *   · 纯函数（RefFormat.toGBT / gbtEntry）负责格式，可在 Node 单测；
 *   · 本模块只做「Zotero 条目 → 记录」的字段映射与窗口/剪贴板/落盘；
 *   · 窗口脚本 cite-export.js 不碰 Zotero，一切经 api 注入（与 ref-import 同纪律）。
 */
/* global Zotero, Services, Components, IOUtils, Prefs, I18n, ItemSel, RefFormat */

var CiteExport = {
  DLOG_URL: "chrome://papilot/content/cite-export.xhtml",
  WINDOW_NAME: "papilot-cite-export",
  _win: null,

  /** 默认导出选项（持久化在 citeExportOpts，窗口里改了就记住） */
  defaultOptions() {
    return { style: "numeric", typeCode: true, doi: true, maxAuthors: 3 };
  },

  loadOptions() {
    const base = this.defaultOptions();
    try {
      const raw = Prefs.get("citeExportOpts", "");
      if (!raw) return base;
      const o = JSON.parse(String(raw));
      if (!o || typeof o !== "object") return base;
      if (o.style === "authorDate" || o.style === "numeric") base.style = o.style;
      if (typeof o.typeCode === "boolean") base.typeCode = o.typeCode;
      if (typeof o.doi === "boolean") base.doi = o.doi;
      const n = Number(o.maxAuthors);
      if (n >= 1 && n <= 10) base.maxAuthors = Math.round(n);
    } catch (e) { /* 配置损坏 → 回落默认，不打断导出 */ }
    return base;
  },

  saveOptions(opts) {
    try {
      const o = Object.assign(this.defaultOptions(), opts || {});
      Prefs.set("citeExportOpts", JSON.stringify({
        style: o.style, typeCode: !!o.typeCode, doi: !!o.doi, maxAuthors: Number(o.maxAuthors) || 3,
      }));
    } catch (e) { /* 存不下不影响本次导出 */ }
  },

  /**
   * Zotero 条目 → RefFormat 记录。
   * 字段映射按条目类型分支：用错字段名不会报错，只会静默丢字段（这是入库类功能最常见的坑）。
   */
  recordsFromItems(items) {
    const g = (it, f) => { try { return it.getField(f) || ""; } catch (e) { return ""; } };
    const out = [];
    for (const it of items || []) {
      try {
        if (!it || typeof it.isRegularItem !== "function" || !it.isRegularItem()) continue;
        const rec = RefFormat.empty();
        rec.title = g(it, "title");
        rec.itemType = it.itemType || "journalArticle";
        rec.date = g(it, "date");
        const y = String(rec.date).match(/\d{4}/);
        rec.year = y ? Number(y[0]) : null;
        rec.doi = g(it, "DOI");
        rec.url = g(it, "url");
        rec.isbn = g(it, "ISBN");
        rec.issn = g(it, "ISSN");
        rec.language = g(it, "language");
        rec.volume = g(it, "volume");
        rec.issue = g(it, "issue");
        rec.pages = g(it, "pages");

        const t = rec.itemType;
        if (t === "journalArticle" || t === "magazineArticle" || t === "newspaperArticle") {
          rec.container = g(it, "publicationTitle");
        } else if (t === "conferencePaper") {
          rec.container = g(it, "proceedingsTitle") || g(it, "conferenceName");
          rec.publisher = g(it, "publisher");
          rec.place = g(it, "place");
        } else if (t === "bookSection") {
          rec.container = g(it, "bookTitle");
          rec.publisher = g(it, "publisher");
          rec.place = g(it, "place");
        } else if (t === "book") {
          rec.publisher = g(it, "publisher");
          rec.place = g(it, "place");
        } else if (t === "thesis") {
          rec.publisher = g(it, "university") || g(it, "publisher");
          rec.place = g(it, "place");
        } else if (t === "report") {
          rec.publisher = g(it, "institution") || g(it, "publisher");
          rec.place = g(it, "place");
        } else if (t === "webpage" || t === "blogPost" || t === "forumPost") {
          rec.container = g(it, "websiteTitle") || g(it, "blogTitle");
        } else if (t === "patent") {
          rec.place = g(it, "place");
          rec.publisher = g(it, "issuingAuthority") || g(it, "publisher");
        }

        let creators = [];
        try { creators = it.getCreators() || []; } catch (e) { creators = []; }
        rec.authors = creators.map((c) => {
          if (c && Number(c.fieldMode) === 1) return { literal: c.lastName || c.name || "" };
          return { family: (c && c.lastName) || "", given: (c && c.firstName) || "" };
        }).filter((a) => a.literal || a.family || a.given);

        rec.source = ["zotero"];
        out.push(rec);
      } catch (e) {
        Zotero.logError(e);
      }
    }
    return out;
  },

  /** 记录 → 文本（窗口预览与最终复制共用同一个入口，避免两套格式漂移） */
  render(records, opts) {
    try {
      return RefFormat.toGBT(records || [], opts || {});
    } catch (e) {
      Zotero.logError(e);
      return "";
    }
  },

  /** 写剪贴板：优先 Zotero 内建（Zotero 7+），失败回落 XPCOM */
  copy(text) {
    const s = String(text || "");
    try {
      if (Zotero.Utilities && Zotero.Utilities.Internal
        && typeof Zotero.Utilities.Internal.copyTextToClipboard === "function") {
        Zotero.Utilities.Internal.copyTextToClipboard(s);
        return true;
      }
    } catch (e) { /* 走 XPCOM 回落 */ }
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(s);
      return true;
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
  },

  /** 另存为 .txt（UTF-8；★ IOUtils.writeUTF8 永不传 mode） */
  async saveAs(text, suggestedName) {
    const win = Zotero.getMainWindow();
    try {
      const fp = Components.classes["@mozilla.org/filepicker;1"]
        .createInstance(Components.interfaces.nsIFilePicker);
      const ctx = (win && win.browsingContext) || win;
      if (fp.init) fp.init(ctx, I18n.t("citeExportSaveTitle"), fp.modeSave);
      if (fp.appendFilter) fp.appendFilter("Text", "*.txt");
      fp.defaultString = suggestedName || "references.txt";
      const rv = await new Promise((resolve) => fp.open(resolve));
      if (rv === fp.returnCancel || !fp.file) return "";
      await IOUtils.writeUTF8(fp.file.path, String(text || ""));
      return fp.file.path;
    } catch (e) {
      Zotero.logError(e);
      return "";
    }
  },

  /** 窗口入口：条目右键 / 工具菜单共用 */
  openDialog() {
    let items = [];
    try {
      const zp = Zotero.getActiveZoteroPane();
      items = ItemSel.regularOnly((zp && zp.getSelectedItems()) || []);
    } catch (e) { items = []; }
    if (!items.length) { ItemSel.alertEmpty(); return null; }

    const records = this.recordsFromItems(items);
    if (!records.length) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot", I18n.t("citeExportEmpty"));
      return null;
    }
    if (this._win && !this._win.closed) {
      try { this._win.focus(); } catch (e) { /* ignore */ }
      return this._win;
    }
    const main = Zotero.getMainWindow();
    const win = main.openDialog(this.DLOG_URL, this.WINDOW_NAME,
      "chrome,centerscreen,resizable,dialog=no", {
        api: {
          isZh: () => !!I18n.isZh,
          preview: (opts) => this.render(records, opts),
          loadOptions: () => this.loadOptions(),
          saveOptions: (opts) => this.saveOptions(opts),
          copy: (text) => this.copy(text),
          saveAs: (text, name) => this.saveAs(text, name),
          recordCount: () => records.length,
        },
        payload: { count: records.length },
      });
    this._win = win;
    try {
      win.addEventListener("unload", () => { this._win = null; }, { once: true });
    } catch (e) { /* ignore */ }
    return win;
  },
};
