// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 真假文献识别（0.7.0 新增）
 * 检测 AI 生成的幻觉文献：逐条核验 Semantic Scholar / Crossref 是否存在该记录。
 * 判定逻辑：
 *  - 有 DOI：S2 单查 → 命中且标题/年份一致 = 真实；S2 查无 → Crossref works/{doi}
 *    → 命中 = 真实；双查无 = 存疑（疑似幻觉）；网络错误 = 无法判断
 *  - 无 DOI：S2 标题检索要求归一化完全匹配，无匹配 = 存疑（标注仅凭标题检索）
 * 存疑条目自动打标签 #存疑/查无记录，全部结果生成汇总笔记（库级，不挂条目）。
 * Crossref 免费公开（礼貌池带 User-Agent mailto），S2 复用现有限速。
 */
/* global Zotero, I18n, S2Client, CitationColumn, MdLite, ItemSel */

var FakeCheck = {
  TAG: "#存疑/查无记录",
  CROSSREF: "https://api.crossref.org/works/",

  _get(item, f) {
    try { return item.getField(f) || ""; } catch (e) { return ""; }
  },

  _year(item) {
    const m = String(this._get(item, "date")).match(/(\d{4})/);
    return m ? Number(m[1]) : 0;
  },

  /** 轻量标题相似度（归一化串上的 Levenshtein），0-1。
   *  用途：英美拼写变体（nanometer/nanometre）等导致的假阳性——
   *  DOI 核验时记录标题与文献标题不必逐字相同。 */
  _similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return 1 - prev[n] / Math.max(m, n);
  },

  /** 标题一致性：完全相等 或 相似度 ≥0.85（拼写变体容忍） */
  _titleMatch(t1, t2) {
    const n1 = CitationColumn.normalizeTitle(t1);
    const n2 = CitationColumn.normalizeTitle(t2);
    if (!n1 || !n2) return true; // 一方无标题时不做否定判断
    return n1 === n2 || this._similarity(n1, n2) >= 0.85;
  },

  /** 通用核验入口（0.8.0 抽出，供条目核验与粘贴列表核验共用）
   * @param entry {doi?, title?, year?}
   * @returns {verdict: 'real'|'suspicious'|'unknown', reason, evidence} */
  async checkEntry(entry) {
    const zh = I18n.isZh;
    const doi = CitationColumn.normalizeDOI(entry && entry.doi);
    const title = String(entry && entry.title || "");
    const year = Number(entry && entry.year) || 0;
    if (doi) {
      // 1. Semantic Scholar
      //    arXiv/DataCite 系 DOI（10.48550/arXiv.xxx）S2 不以 DOI: 前缀收录，
      //    需换 ARXIV: 前缀查——否则真实 arXiv 论文会被误判为幻觉（0.8.0 实测踩坑）
      const s2ids = ["DOI:" + doi];
      const ax = doi.match(/arxiv[.:]?(\d{4}\.\d{4,5})/i) || doi.match(/arxiv[.:]?([a-z-]+\/\d{7})/i);
      if (ax) s2ids.push("ARXIV:" + ax[1]);
      let p = null;
      for (const pid of s2ids) {
        try {
          const r = await S2Client.paperById(pid);
          if (r && r.title) { p = r; break; }
        } catch (e) { /* 试下一个前缀 */ }
      }
      if (p && p.title) {
        if (title && !this._titleMatch(p.title, title)) {
          return { verdict: "suspicious", reason: zh ? "DOI 记录的标题与文献不匹配" : "DOI record title mismatch", evidence: p.title };
        }
        if (p.year && year && Math.abs(p.year - year) > 2) {
          return { verdict: "suspicious", reason: (zh ? "年份不符：S2 记录 " : "Year mismatch: S2 ") + p.year + (zh ? " vs 文献 " : " vs ref ") + year, evidence: p.title };
        }
        return { verdict: "real", reason: zh ? "Semantic Scholar 命中，元数据一致" : "Found on Semantic Scholar", evidence: p.title };
      }
      // 2. Crossref
      try {
        const req = await Zotero.HTTP.request("GET", this.CROSSREF + encodeURIComponent(doi), {
          responseType: "json",
          timeout: 15000,
          headers: { "User-Agent": "Papilot/0.8 (mailto:papilot@dev.local)" },
        });
        const m = req.response && req.response.message;
        if (m && (m.DOI || m.title)) {
          const cTitle = (Array.isArray(m.title) ? m.title[0] : m.title) || "";
          if (title && cTitle && !this._titleMatch(cTitle, title)) {
            return { verdict: "suspicious", reason: zh ? "Crossref 记录的标题与文献不匹配" : "Crossref title mismatch", evidence: cTitle };
          }
          return { verdict: "real", reason: zh ? "Crossref 命中" : "Found on Crossref", evidence: cTitle };
        }
      } catch (e) {
        const st = e && e.xmlhttp && e.xmlhttp.status;
        if (st === 404) {
          return { verdict: "suspicious", reason: zh ? "DOI 在 Semantic Scholar 与 Crossref 均查无记录（疑似 AI 幻觉）" : "DOI not found on S2 or Crossref (possible hallucination)" };
        }
        return { verdict: "unknown", reason: (zh ? "网络错误，无法判断（HTTP " : "Network error (HTTP ") + (st || "?") + "）" };
      }
      return { verdict: "suspicious", reason: zh ? "DOI 在 Semantic Scholar 与 Crossref 均查无记录（疑似 AI 幻觉）" : "DOI not found on S2 or Crossref" };
    }
    // 无 DOI：标题检索
    if (!title) return { verdict: "unknown", reason: zh ? "无 DOI 且无标题" : "No DOI and no title" };
    try {
      const cands = await S2Client.searchByTitle(title);
      const want = CitationColumn.normalizeTitle(title);
      const hit = cands.find((p) => CitationColumn.normalizeTitle(p.title) === want);
      if (hit) return { verdict: "real", reason: zh ? "S2 标题检索命中（无 DOI，仅凭标题）" : "Title match on S2 (no DOI)", evidence: hit.title };
      return { verdict: "suspicious", reason: zh ? "无 DOI，S2 标题检索无完全匹配（疑似 AI 幻觉）" : "No DOI, no exact title match on S2" };
    } catch (e) {
      return { verdict: "unknown", reason: zh ? "标题检索网络错误" : "Search network error" };
    }
  },

  /** 条目核验：取条目字段走 checkEntry */
  async checkItem(item) {
    return this.checkEntry({
      doi: this._get(item, "DOI"),
      title: this._get(item, "title"),
      year: this._year(item),
    });
  },

  /** 打开「粘贴文献列表核验」对话框（非模态，可边核验边操作主窗口） */
  openPasteDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return;
    win.openDialog(
      "chrome://papilot/content/paste-check.xhtml",
      "papilot-paste-check",
      "chrome,centerscreen,resizable"
    );
  },

  /** 汇总笔记（库级，不挂条目） */
  async _createLibraryNote(title, md) {
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(MdLite.toNoteHtml(title, md));
    await note.saveTx();
    return note;
  },

  /** 菜单入口：批量核验选中条目 */
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
    const lines = [];
    let nReal = 0, nSus = 0, nUnk = 0;
    let first = true;
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const r = await this.checkItem(item);
        if (r.verdict === "real") { nReal++; lines.push("- ✅ " + title + " —— " + r.reason); }
        else if (r.verdict === "suspicious") {
          nSus++;
          lines.push("- ⚠️ **" + title + "** —— " + r.reason + (r.evidence ? "（记录：" + r.evidence + "）" : ""));
          try {
            if (!item.getTags().some((t) => t.tag === this.TAG)) {
              item.addTag(this.TAG);
              await item.saveTx();
            }
          } catch (e) { /* ignore */ }
        } else { nUnk++; lines.push("- ❓ " + title + " —— " + r.reason); }
        progress.setText(r.verdict === "real" ? (zh ? "✅ 真实" : "✅ real")
          : r.verdict === "suspicious" ? (zh ? "⚠️ 存疑" : "⚠️ suspicious") : (zh ? "❓ 无法判断" : "❓ unknown"));
        progress.setProgress(100);
      } catch (e) {
        nUnk++;
        progress.setError();
        Zotero.logError(e);
      }
      if (!first) await new Promise((r2) => setTimeout(r2, 1100)); // 限速
      first = false;
    }
    const date = new Date().toISOString().slice(0, 10);
    const md = (zh ? "检测 " : "Checked ") + items.length + (zh ? " 篇（" : " (") + date + "）：" +
      (zh ? "真实 " : "real ") + nReal + (zh ? "，存疑 " : ", suspicious ") + nSus +
      (zh ? "，无法判断 " : ", unknown ") + nUnk +
      (zh ? "。存疑条目已打标签 " : ". Suspicious items tagged ") + "`" + this.TAG + "`" +
      (zh ? "。判定依据：DOI 双源核验（Semantic Scholar + Crossref）；无 DOI 仅凭标题检索，可能有漏判（新书/中文文献 S2 收录不全）。" : ".") +
      "\n\n" + lines.join("\n");
    await this._createLibraryNote((zh ? "真假文献识别报告｜" : "Fake Reference Check | ") + date, md);
    pw.startCloseTimer(3000);
  },
};
