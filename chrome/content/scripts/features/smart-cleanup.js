// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 智能清理（0.7.0 新增）
 * 扫描当前选中分类（无选中分类则全库）的常规条目，找出三类问题：
 *  1. 重复条目：规范化 DOI 相同，或「规范化标题+年份+第一作者姓」相同
 *  2. 无 PDF 附件
 *  3. 缺元数据（journalArticle 查 DOI/摘要/日期/期刊名；其他类型查 DOI/摘要/日期）
 * 问题条目自动打标签（#清理/重复、#清理/无附件、#清理/缺元数据，幂等），
 * 并生成库级报告笔记：重复组给出「建议保留」（附件最多、入库最早）供合并参考。
 */
/* global Zotero, I18n, CitationColumn, MdLite */

var SmartCleanup = {
  TAG_DUP: "#清理/重复",
  TAG_NOATT: "#清理/无附件",
  TAG_NOMETA: "#清理/缺元数据",

  _get(item, f) {
    try { return item.getField(f) || ""; } catch (e) { return ""; }
  },

  _year(item) {
    const m = String(this._get(item, "date")).match(/(\d{4})/);
    return m ? m[1] : "";
  },

  _firstAuthor(item) {
    try {
      const c = item.getCreators()[0];
      return (c && (c.lastName || c.name || "") || "").toLowerCase();
    } catch (e) { return ""; }
  },

  async _pdfCount(item) {
    try {
      const ids = item.getAttachments() || [];
      let n = 0;
      for (const id of ids) {
        const att = await Zotero.Items.getAsync(id);
        if (att && att.isPDFAttachment && att.isPDFAttachment()) n++;
      }
      return n;
    } catch (e) { return 0; }
  },

  _missingMeta(item) {
    const missing = [];
    let typeName = "";
    try { typeName = Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch (e) { /* ignore */ }
    if (!this._get(item, "DOI")) missing.push("DOI");
    if (!this._get(item, "abstractNote")) missing.push(I18n.isZh ? "摘要" : "abstract");
    if (!this._get(item, "date")) missing.push(I18n.isZh ? "日期" : "date");
    if (typeName === "journalArticle" && !this._get(item, "publicationTitle")) {
      missing.push(I18n.isZh ? "期刊名" : "journal");
    }
    return missing;
  },

  /** 取扫描范围：选中分类的条目，否则全库常规条目 */
  async _scopeItems() {
    const zp = Zotero.getActiveZoteroPane();
    let scope = I18n.isZh ? "全库" : "Whole library";
    let items = [];
    let col = null;
    try { col = zp && zp.getSelectedCollections && zp.getSelectedCollections()[0]; } catch (e) { /* Z10 getSelectedCollection 会 throw */ }
    if (col) {
      scope = (I18n.isZh ? "分类「" : "Collection \"") + col.name + "」";
      // getChildItems() 返回 Zotero.Item 数组；传 true 返回的是 ID 数组，
      // 之前写成 getChildItems(true).map(i => i.id) 导致全 undefined（0.8.2 体检实证）
      const children = col.getChildItems ? col.getChildItems() : [];
      for (const it of children) {
        if (it && it.isRegularItem && it.isRegularItem()) items.push(it);
      }
    } else {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("itemType", "isNot", "attachment");
      const ids = await s.search();
      for (const id of ids) {
        const it = await Zotero.Items.getAsync(id);
        if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) items.push(it);
      }
    }
    return { scope, items };
  },

  /** 核心扫描 → {scope, total, dupGroups, noAttach, noMeta} */
  async scan() {
    const { scope, items } = await this._scopeItems();
    const groups = new Map(); // dupKey -> [item]
    const noAttach = [];
    const noMeta = [];
    const pdfCounts = new Map();
    for (const item of items) {
      const doi = CitationColumn.normalizeDOI(this._get(item, "DOI"));
      const titleKey = CitationColumn.normalizeTitle(this._get(item, "title"));
      let key = null;
      if (doi) key = "doi:" + doi;
      else if (titleKey) key = "t:" + titleKey + "|" + this._year(item) + "|" + this._firstAuthor(item);
      if (key) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      const pdfs = await this._pdfCount(item);
      pdfCounts.set(item.id, pdfs);
      if (!pdfs) noAttach.push(item);
      const missing = this._missingMeta(item);
      if (missing.length) noMeta.push({ item, missing });
    }
    const dupGroups = [...groups.values()].filter((g) => g.length > 1);
    // 组内排序：附件多、入库早 的排前 = 建议保留
    for (const g of dupGroups) {
      g.sort((a, b) => {
        const dp = (pdfCounts.get(b.id) || 0) - (pdfCounts.get(a.id) || 0);
        if (dp) return dp;
        return String(a.dateAdded).localeCompare(String(b.dateAdded));
      });
    }
    return { scope, total: items.length, dupGroups, noAttach, noMeta, pdfCounts };
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

  _title(item) {
    try { return item.getDisplayTitle() || ""; } catch (e) { return ""; }
  },

  /** 菜单入口：扫描 → 打标签 → 报告笔记 */
  async run() {
    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    pw.show();
    const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      zh ? "智能清理扫描中…" : "Smart cleanup scanning…");
    progress.setProgress(30);
    try {
      const r = await this.scan();
      // 打标签
      for (const g of r.dupGroups) for (const it of g) await this._tag(it, this.TAG_DUP);
      for (const it of r.noAttach) await this._tag(it, this.TAG_NOATT);
      for (const x of r.noMeta) await this._tag(x.item, this.TAG_NOMETA);
      // 报告
      const date = new Date().toISOString().slice(0, 10);
      const dupItemCount = r.dupGroups.reduce((n, g) => n + g.length, 0);
      let md = (zh ? "扫描范围：" : "Scope: ") + r.scope +
        (zh ? "，共 " : ", ") + r.total + (zh ? " 篇（" : " items (") + date + "）\n\n" +
        "| " + (zh ? "问题" : "Issue") + " | " + (zh ? "数量" : "Count") + " | " + (zh ? "标签" : "Tag") + " |\n" +
        "|---|---|---|\n" +
        "| " + (zh ? "重复条目" : "Duplicates") + " | " + r.dupGroups.length + (zh ? " 组 / " : " groups / ") + dupItemCount + (zh ? " 篇" : " items") + " | `" + this.TAG_DUP + "` |\n" +
        "| " + (zh ? "无 PDF 附件" : "No PDF") + " | " + r.noAttach.length + " | `" + this.TAG_NOATT + "` |\n" +
        "| " + (zh ? "缺元数据" : "Missing metadata") + " | " + r.noMeta.length + " | `" + this.TAG_NOMETA + "` |\n";
      if (r.dupGroups.length) {
        md += "\n## " + (zh ? "重复组（每组第一条为建议保留）" : "Duplicate groups (first = suggested keep)") + "\n";
        r.dupGroups.forEach((g, i) => {
          md += "\n### " + (zh ? "组 " : "Group ") + (i + 1) + "\n";
          g.forEach((it, j) => {
            md += (j + 1) + ". " + (j === 0 ? (zh ? "**建议保留**：" : "**KEEP**: ") : (zh ? "候选合并：" : "merge candidate: ")) +
              this._title(it) + "（" + (this._year(it) || "?") +
              (zh ? "，PDF " : ", PDF ") + (r.pdfCounts.get(it.id) || 0) + "）\n";
          });
        });
      }
      if (r.noAttach.length) {
        md += "\n## " + (zh ? "无 PDF 附件" : "No PDF attachment") + "\n" +
          r.noAttach.slice(0, 100).map((it) => "- " + this._title(it)).join("\n") + "\n";
      }
      if (r.noMeta.length) {
        md += "\n## " + (zh ? "缺元数据" : "Missing metadata") + "\n" +
          r.noMeta.slice(0, 100).map((x) => "- " + this._title(x.item) + " —— " + (zh ? "缺：" : "missing: ") + x.missing.join("、")).join("\n") + "\n";
      }
      md += "\n" + (zh ? "> 提示：按标签过滤可快速定位问题条目；重复条目建议用 Zotero 自带「重复条目」面板合并。"
        : "> Tip: filter by tags to locate issues; use Zotero's Duplicate Items panel to merge.");
      await this._createLibraryNote((zh ? "智能清理报告｜" : "Smart Cleanup | ") + date, md);
      progress.setText((zh ? "重复 " : "dup ") + r.dupGroups.length +
        (zh ? " 组 · 无附件 " : " · noPDF ") + r.noAttach.length +
        (zh ? " · 缺元数据 " : " · noMeta ") + r.noMeta.length);
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      Zotero.logError(e);
    }
    pw.startCloseTimer(4000);
  },
};
