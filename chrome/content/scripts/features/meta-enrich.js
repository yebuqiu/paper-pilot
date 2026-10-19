// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 元数据补全（0.8.0 新增）
 * 对选中条目：用 S2（DOI 优先、标题检索兜底，带标题一致性校验）查记录，
 * 只回写【空缺】字段（绝不覆盖已有值）：DOI / 摘要 / 日期 / 期刊名 /
 * 卷 / 期 / 页码 / 作者。智能清理报告的「缺元数据」配套修复工具。
 */
/* global Zotero, I18n, S2Client, CitationColumn, ItemSel */

var MetaEnrich = {
  FIELDS: "title,year,venue,abstract,externalIds,authors,journal,citationCount",

  _get(item, f) {
    try { return item.getField(f) || ""; } catch (e) { return ""; }
  },

  _missing(item) {
    const miss = [];
    if (!this._get(item, "DOI")) miss.push("DOI");
    if (!this._get(item, "abstractNote")) miss.push("abstractNote");
    if (!this._get(item, "date")) miss.push("date");
    let typeName = "";
    try { typeName = Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch (e) { /* ignore */ }
    if (typeName === "journalArticle") {
      if (!this._get(item, "publicationTitle")) miss.push("publicationTitle");
      if (!this._get(item, "volume")) miss.push("volume");
      if (!this._get(item, "issue")) miss.push("issue");
      if (!this._get(item, "pages")) miss.push("pages");
    }
    try { if (!item.getCreators().length) miss.push("creators"); } catch (e) { /* ignore */ }
    return miss;
  },

  /** 查 S2 记录（DOI→标题校验→错配回退标题检索），带 abstract 等富字段 */
  async _lookup(item) {
    const title = this._get(item, "title");
    const want = CitationColumn.normalizeTitle(title);
    const doi = CitationColumn.normalizeDOI(this._get(item, "DOI"));
    let doiPaper = null;
    if (doi) {
      try { doiPaper = await S2Client.paperById("DOI:" + doi, this.FIELDS); } catch (e) { /* 落标题检索 */ }
      if (doiPaper && want && CitationColumn.normalizeTitle(doiPaper.title) === want) return doiPaper;
    }
    if (title) {
      const cands = await S2Client.searchByTitle(title, 5, this.FIELDS);
      const hit = cands.find((p) => CitationColumn.normalizeTitle(p.title) === want);
      if (hit) return hit;
      if (doiPaper) return doiPaper;
    } else if (doiPaper) {
      return doiPaper;
    }
    return null;
  },

  /** 拆分 "First M. Last" → {firstName, lastName}（末 token 为姓） */
  _splitName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) return { lastName: parts[0], firstName: "", creatorType: "author" };
    return { lastName: parts[parts.length - 1], firstName: parts.slice(0, -1).join(" "), creatorType: "author" };
  },

  /** 核心：补全单条目，返回实际写入的 {字段: 值}（未命中/无缺失返回 null 或 {}） */
  async enrich(item) {
    const missing = this._missing(item);
    if (!missing.length) return null;
    const p = await this._lookup(item);
    if (!p) return {};
    const filled = {};
    const put = (field, value) => {
      if (value == null || value === "") return;
      if (this._get(item, field)) return; // 只填空
      try { item.setField(field, String(value)); filled[field] = value; } catch (e) { /* 字段不适用于该类型 */ }
    };
    put("DOI", p.externalIds && p.externalIds.DOI);
    put("abstractNote", p.abstract);
    put("date", p.year ? String(p.year) : "");
    const j = p.journal || {};
    put("publicationTitle", j.name || p.venue || "");
    put("volume", j.volume || "");
    put("issue", j.issue || "");
    put("pages", j.pages || "");
    if (missing.includes("creators") && Array.isArray(p.authors) && p.authors.length) {
      const creators = p.authors.map((a) => this._splitName(a && a.name)).filter(Boolean);
      if (creators.length) {
        try { item.setCreators(creators); filled.creators = creators.length + (I18n.isZh ? " 位作者" : " authors"); } catch (e) { /* ignore */ }
      }
    }
    if (Object.keys(filled).length) await item.saveTx();
    return filled;
  },

  /** 菜单入口 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    pw.show();
    let nFilled = 0, nSkip = 0, nMiss = 0;
    let first = true;
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const filled = await this.enrich(item);
        if (filled === null) { nSkip++; progress.setText(zh ? "字段齐全，跳过" : "Complete, skipped"); }
        else if (!Object.keys(filled).length) { nMiss++; progress.setText(zh ? "未查到可补记录" : "No record found"); }
        else {
          nFilled++;
          const label = { abstractNote: zh ? "摘要" : "abstract", publicationTitle: zh ? "期刊" : "journal", creators: zh ? "作者" : "authors" };
          progress.setText((zh ? "已补：" : "Filled: ") +
            Object.keys(filled).map((k) => label[k] || k).join("、"));
        }
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
      if (!first) await new Promise((r) => setTimeout(r, 1100)); // S2 限速
      first = false;
    }
    const summary = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      (zh ? "合计：补全 " : "Done: enriched ") + nFilled +
      (zh ? "，跳过 " : ", skipped ") + nSkip +
      (zh ? "，未命中 " : ", not found ") + nMiss);
    summary.setProgress(100);
    pw.startCloseTimer(3500);
  },
};
