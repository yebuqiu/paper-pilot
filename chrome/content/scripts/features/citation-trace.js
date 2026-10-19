// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 引文追溯（0.7.0 新增）
 * 基于 Semantic Scholar references/citations 端点：
 * 选中条目 → 解析 S2 paper（DOI 优先，标题检索兜底）→ 拉参考文献与施引文献
 * → 按被引量降序生成 Markdown 笔记（标注哪些参考文献已在本地文库）。
 * 数据字段：title/year/venue/citationCount/externalIds（复用 S2Client.FIELDS）
 */
/* global Zotero, Services, Prefs, I18n, S2Client, CitationColumn, Notes, ItemSel */

var CitationTrace = {
  _doiSet: null,
  _doiSetT: 0,

  _get(item, f) {
    try { return item.getField(f) || ""; } catch (e) { return ""; }
  },

  /** 解析选中条目到 S2 paper 对象；失败抛错。
   *  DOI 命中的记录会做标题一致性校验——库中 DOI 错配（如数字错位）时
   *  自动回退标题检索，避免给错论文拉引文。 */
  async resolvePaper(item) {
    const zh = I18n.isZh;
    const title = this._get(item, "title");
    const want = CitationColumn.normalizeTitle(title);
    const doi = CitationColumn.normalizeDOI(this._get(item, "DOI"));
    let doiPaper = null;
    if (doi) {
      try { doiPaper = await S2Client.paperById("DOI:" + doi); } catch (e) { /* 落标题检索 */ }
      if (doiPaper && want && CitationColumn.normalizeTitle(doiPaper.title) === want) return doiPaper;
    }
    if (title) {
      // DOI 查无或标题不符 → 标题检索兜底
      const cands = await S2Client.searchByTitle(title);
      const hit = cands.find((p) => CitationColumn.normalizeTitle(p.title) === want);
      if (hit) {
        if (doiPaper) {
          Zotero.debug(`Papilot: 引文追溯检测到 DOI 错配（${doi}），已按标题匹配到正确记录`);
        }
        return hit;
      }
      if (doiPaper) return doiPaper; // 标题检索也无果，退回 DOI 记录（聊胜于无）
    } else if (doiPaper) {
      return doiPaper;
    }
    throw new Error(zh ? "Semantic Scholar 查无此文" : "Not found on Semantic Scholar");
  },

  /** 本地文库 DOI 集合（1 分钟缓存），用于标注「在库」 */
  async _libraryDOIs() {
    if (this._doiSet && Date.now() - this._doiSetT < 60000) return this._doiSet;
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    const ids = await s.search();
    const set = new Set();
    for (const id of ids) {
      const it = await Zotero.Items.getAsync(id);
      if (!it || !it.isRegularItem || !it.isRegularItem()) continue;
      const d = CitationColumn.normalizeDOI(it.getField("DOI") || "");
      if (d) set.add(d);
    }
    this._doiSet = set;
    this._doiSetT = Date.now();
    return set;
  },

  _fmt(p, doiSet) {
    const doi = CitationColumn.normalizeDOI((p.externalIds && p.externalIds.DOI) || "");
    const inLib = doi && doiSet.has(doi);
    const bits = [];
    if (p.year) bits.push(p.year);
    if (p.venue) bits.push(p.venue);
    if (typeof p.citationCount === "number") bits.push((I18n.isZh ? "被引 " : "cites ") + p.citationCount);
    let line = "- " + (inLib ? "**[" + (I18n.isZh ? "在库" : "in lib") + "]** " : "") + (p.title || "(no title)");
    if (bits.length) line += "（" + bits.join("，") + "）";
    if (doi) line += " — https://doi.org/" + doi;
    return line;
  },

  /** 核心：返回 {paper, refs, cites, md}；topN 限制每段条数 */
  async trace(item, topN) {
    const zh = I18n.isZh;
    const paper = await this.resolvePaper(item);
    if (!paper || !paper.paperId) throw new Error(zh ? "S2 记录缺少 paperId" : "No paperId");
    const pid = paper.paperId;
    const [refsRaw, citesRaw] = await Promise.all([
      S2Client.references(pid).catch(() => []),
      S2Client.citations(pid).catch(() => []),
    ]);
    const refs = refsRaw.map((r) => r.citedPaper).filter(Boolean);
    const cites = citesRaw.map((r) => r.citingPaper).filter(Boolean);
    const byCount = (a, b) => (b.citationCount || 0) - (a.citationCount || 0);
    refs.sort(byCount);
    cites.sort(byCount);
    const doiSet = await this._libraryDOIs();
    const n = topN || 50;
    const date = new Date().toISOString().slice(0, 10);
    const title = this._get(item, "title") || paper.title || "";
    const md =
      (zh ? "数据：Semantic Scholar，" : "Source: Semantic Scholar, ") + date +
      (zh ? "。S2 被引 " : ". S2 citations ") + (paper.citationCount != null ? paper.citationCount : "?") +
      (zh ? "，参考文献 " : ", references ") + refs.length +
      (zh ? " 篇，施引文献 " : ", citing papers ") + cites.length +
      (zh ? " 篇。**加粗[在库]** = 已在本地文库。" : ". **[in lib]** = already in local library.") +
      "\n\n## " + (zh ? "施引文献（谁引用了本文，按被引量降序 Top " : "Citing papers (top ") + n + "）\n" +
      (cites.slice(0, n).map((p) => this._fmt(p, doiSet)).join("\n") || (zh ? "（无）" : "(none)")) +
      "\n\n## " + (zh ? "参考文献（本文引用的，按被引量降序 Top " : "References (top ") + n + "）\n" +
      (refs.slice(0, n).map((p) => this._fmt(p, doiSet)).join("\n") || (zh ? "（无）" : "(none)"));
    return { paper, refs, cites, md, title };
  },

  /** 菜单入口：为选中条目逐篇生成引文追溯笔记 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    pw.show();
    let first = true;
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const r = await this.trace(item);
        await Notes.createFromMarkdown(item, (I18n.isZh ? "引文追溯｜" : "Citation Trace | ") + r.title, r.md);
        progress.setText((I18n.isZh ? "参考文献 " : "refs ") + r.refs.length + " · " +
          (I18n.isZh ? "施引 " : "cited by ") + r.cites.length);
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        progress.setText(String(e && e.message || e).slice(0, 80));
        Zotero.logError(e);
      }
      if (!first) await new Promise((r2) => setTimeout(r2, 1100)); // S2 限速
      first = false;
    }
    pw.startCloseTimer(3000);
  },

  /** 菜单入口（0.8.0 起，0.33.0 改为委托）：
   *  「参考文献一键入库」已由 RefImport 重写（多源检索 / 多键判重 / AI 补全 / 导出），
   *  这里保留同名入口仅为兼容旧调用方与外部脚本，实际打开的是统一对话框的「参考文献」模式。
   *  ★ 旧实现（无 DOI 即丢弃、只按 DOI 判重、全部建成 journalArticle）已删除，
   *  不要再在此处新增导入逻辑——导入相关的单一真源是 features/ref-import.js。 */
  importForSelected() {
    if (typeof RefImport === "undefined" || !RefImport) {
      return Promise.reject(new Error("RefImport 未加载"));
    }
    return RefImport.importForSelected();
  },
};
