// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 中文元数据识别（0.11.0，Jasminum 品类的轻量路线）
 * 知网/万方/维普下载的中文 PDF 常见文件名格式：
 *   标题_作者.pdf            （知网最常见）
 *   标题_作者_期刊.pdf
 *   作者. 标题[J]. 期刊, 年, 卷(期): 页码.pdf   （GB/T 7714 导出）
 * 解析文件名 → 回填 标题/作者/期刊/年份。
 * 保护策略：仅当条目【标题为空或等于附件文件名（即未抓取过元数据）】时才回写，
 * 已有正常元数据的条目一律跳过，绝不覆盖。
 */
/* global Zotero, Prefs, AIClient, I18n, ItemSel */

var CNMeta = {
  /** 中文姓名：两字/三字/四字（含·间隔），多位用 , ; 、 分隔 */
  _isNameList(s) {
    const t = String(s || "").trim();
    if (!t || t.length > 40) return false;
    return t.split(/[,;，、；\s]+/).every((n) => /^[一-龥·]{2,4}$/.test(n));
  },

  /**
   * 解析中文文献文件名 → {title, creators[], journal, year}（尽力而为，字段可缺）
   * @param filename 带或不带扩展名
   */
  parseFilename(filename) {
    let base = String(filename || "").replace(/\.(pdf|caj|kdh|nh|teb)$/i, "").trim();
    const out = { title: "", creators: [], journal: "", year: "" };
    if (!base) return out;

    // GB/T 7714：作者. 标题[J]. 期刊, 年, 卷(期): 页码
    let m = base.match(/^([一-龥·]{2,4}(?:\s*[,，、]\s*[一-龥·]{2,4})*)\s*[.．]\s*(.+?)\s*\[[JDMC]\]\s*[.．]?\s*([^,，.．]*)\s*[,，]?\s*(\d{4})?/);
    if (m && m[2] && m[2].length >= 4) {
      out.creators = m[1].split(/\s*[,，、]\s*/).filter(Boolean);
      out.title = m[2].trim();
      out.journal = (m[3] || "").trim();
      out.year = m[4] || "";
      return out;
    }

    // 知网：标题_作者[_期刊][_年]
    const parts = base.split("_").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && this._isNameList(parts[1])) {
      out.title = parts[0];
      out.creators = parts[1].split(/[,;，、；\s]+/).filter(Boolean);
      if (parts[2] && !/^\d{4}$/.test(parts[2])) out.journal = parts[2];
      const ym = base.match(/(\d{4})(?!\d)/);
      if (ym) out.year = ym[1];
      return out;
    }

    // 只有标题：清理末尾干扰串
    out.title = base
      .replace(/[-_（(]\s*(知网|万方|维普|cnki|wanfang)\s*[)）]?$/i, "")
      .trim();
    const ym2 = base.match(/(\d{4})(?!\d)/);
    if (ym2) out.year = ym2[1];
    return out;
  },

  /** 条目标题是否仍停留在「文件名状态」（=未抓取过元数据） */
  _titleIsFilename(item, attName) {
    let title = "";
    try { title = (item.getField("title") || "").trim(); } catch (e) { return false; }
    if (!title) return true;
    if (!attName) return false;
    const base = attName.replace(/\.(pdf|caj|kdh|nh|teb)$/i, "").trim();
    return title === attName.trim() || title === base;
  },

  /** 单条目识别回填；返回 {filled:{...}} 或 null（跳过/未识别） */
  async enrich(item) {
    // 找中文 PDF 附件
    let attName = "";
    try {
      if (item.isPDFAttachment && item.isPDFAttachment()) {
        attName = item.attachmentFilename || "";
        const p = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
        if (p) item = p;
      } else {
        for (const id of item.getAttachments()) {
          const a = Zotero.Items.get(id);
          if (a && a.isPDFAttachment && a.isPDFAttachment()) {
            attName = a.attachmentFilename || "";
            if (/[一-龥]/.test(attName)) break;
          }
        }
      }
    } catch (e) { /* ignore */ }
    if (!attName || !/[一-龥]/.test(attName)) return null;
    if (!this._titleIsFilename(item, attName)) return null;

    const parsed = this.parseFilename(attName);
    if (!parsed.title || parsed.title.length < 4) return null;

    const filled = {};
    try {
      item.setField("title", parsed.title);
      filled.title = parsed.title;
    } catch (e) { return null; }
    if (parsed.creators.length) {
      try {
        if (!item.getCreators().length) {
          item.setCreators(parsed.creators.map((n) => ({
            lastName: n, fieldMode: 1, creatorType: "author",
          })));
          filled.creators = parsed.creators.length;
        }
      } catch (e) { /* ignore */ }
    }
    if (parsed.journal) {
      try {
        if (!item.getField("publicationTitle")) {
          item.setField("publicationTitle", parsed.journal);
          filled.journal = parsed.journal;
        }
      } catch (e) { /* 字段不适用于该类型 */ }
    }
    if (parsed.year) {
      try {
        if (!item.getField("date")) {
          item.setField("date", parsed.year);
          filled.year = parsed.year;
        }
      } catch (e) { /* ignore */ }
    }
    await item.saveTx();
    return { filled };
  },

  /** 菜单入口 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const raw = zp.getSelectedItems() || [];
    // 这里常规条目与 PDF 附件都接受（附件上溯父条目）
    const items = ItemSel.regularOnly(raw);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("menuCnMeta"));
    pw.show();
    let nFilled = 0, nSkip = 0;
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(40);
        const r = await this.enrich(item);
        if (r) {
          nFilled++;
          const bits = [];
          if (r.filled.title) bits.push(zh ? "标题" : "title");
          if (r.filled.creators) bits.push((zh ? "作者×" : "authors×") + r.filled.creators);
          if (r.filled.journal) bits.push(zh ? "期刊" : "journal");
          if (r.filled.year) bits.push(zh ? "年份" : "year");
          progress.setText((zh ? "已识别：" : "Filled: ") + bits.join("、"));
        } else {
          nSkip++;
          progress.setText(zh ? "跳过（已有元数据或非中文文件名）" : "Skipped");
        }
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    const summary = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      (zh ? "合计：识别 " : "Done: filled ") + nFilled + (zh ? "，跳过 " : ", skipped ") + nSkip);
    summary.setProgress(100);
    pw.startCloseTimer(3500);
  },
};
