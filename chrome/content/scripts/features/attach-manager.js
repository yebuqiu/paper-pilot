// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 附件管理（0.11.0，Attanger/ZotFile 品类的轻量路线：重命名）
 * 按命名模板批量重命名选中条目的 PDF 附件（文件名 + 附件标题同步）。
 * 模板变量：{author} {year} {title}（pref attachNamePattern）。
 * 注：「移动到自定义目录（链接附件）」涉及库结构变更，本版不做——
 *     只做 Zotero 托管附件的重命名，可逆、无数据风险。
 */
/* global Zotero, Prefs, I18n, ItemSel */

var AttachManager = {
  /** 文件名净化：去掉 Windows/Mac 非法字符 */
  _sanitize(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  },

  /** 按模板生成附件名（不含扩展名） */
  buildName(item, pattern) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    let author = "";
    try {
      const cs = item.getCreators() || [];
      if (cs.length) author = cs[0].lastName || cs[0].firstName || "";
      if (cs.length > 1) author += " 等";
    } catch (e) { /* ignore */ }
    const year = String(get("date")).match(/(\d{4})/);
    const vars = {
      author: author || "Unknown",
      year: year ? year[1] : "nd",
      title: (get("title") || "untitled").slice(0, 80),
    };
    let name = String(pattern || "{author} - {year} - {title}");
    for (const k of Object.keys(vars)) {
      name = name.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    }
    return this._sanitize(name) || "attachment";
  },

  /** 重命名单个附件；返回新名或 null（失败/无需改） */
  async _renameOne(att, newBase) {
    const ext = (String(att.attachmentFilename || "").match(/\.[a-z0-9]+$/i) || [".pdf"])[0];
    const newName = newBase + ext.toLowerCase();
    if (att.attachmentFilename === newName) return null;
    // Z7+：renameAttachmentFile 同步改文件名与附件标题
    if (typeof att.renameAttachmentFile === "function") {
      await att.renameAttachmentFile(newName);
    } else {
      try { att.attachmentFilename = newName; } catch (e) { /* 只读属性时忽略 */ }
      try { att.setField("title", newName); } catch (e) { /* ignore */ }
      await att.saveTx();
    }
    return newName;
  },

  /** 菜单入口 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const pattern = Prefs.get("attachNamePattern", "{author} - {year} - {title}");
    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("menuAttachRename"));
    pw.show();
    let nRenamed = 0, nSkip = 0;

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(40);
        const newBase = this.buildName(item, pattern);
        let renamed = 0, total = 0;
        for (const id of item.getAttachments()) {
          const att = Zotero.Items.get(id);
          if (!att || !att.isPDFAttachment || !att.isPDFAttachment()) continue;
          total++;
          // 多附件同名时加序号
          const base = total > 1 ? `${newBase} (${total})` : newBase;
          try {
            const r = await this._renameOne(att, base);
            if (r) renamed++;
          } catch (e) { Zotero.logError(e); }
        }
        if (!total) { nSkip++; progress.setText(zh ? "无 PDF 附件" : "No PDF"); }
        else if (!renamed) { nSkip++; progress.setText(zh ? "文件名已规范" : "Already OK"); }
        else { nRenamed += renamed; progress.setText((zh ? "已重命名 " : "Renamed ") + renamed); }
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    const summary = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      (zh ? "合计：重命名 " : "Done: renamed ") + nRenamed + (zh ? "，跳过 " : ", skipped ") + nSkip);
    summary.setProgress(100);
    pw.startCloseTimer(3500);
  },
};
