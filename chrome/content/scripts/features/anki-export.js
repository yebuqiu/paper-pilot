// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot AI 制卡导出 Anki（0.11.0，zotcard 品类的轻量路线）
 * 对选中单篇：AI 基于摘要/全文生成问答卡片 → 解析 → 导出 Anki 导入格式
 * （.txt，每行：正面<TAB>背面，Anki 导入向导选「制表符分隔」即可）。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, I18n, ItemSel, Components */

var AnkiExport = {
  SEP: "|||",

  _prompt(count) {
    return `请基于这篇论文制作 ${count} 张学习卡片（问答式），覆盖核心概念、方法、关键数字与结论。` +
      `严格按以下格式输出，每行一张卡，正面与背面之间用 ${this.SEP} 分隔，不要输出其他任何内容：\n` +
      `问题${this.SEP}答案`;
  },

  /**
   * 解析 AI 回复 → [{q, a}]
   * 容忍：序号前缀（1. / - ）、加粗标记、空行
   */
  _parseCards(reply) {
    const cards = [];
    for (const raw of String(reply || "").split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || !line.includes(this.SEP)) continue;
      line = line.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, "").replace(/\*\*/g, "");
      const idx = line.indexOf(this.SEP);
      const q = line.slice(0, idx).trim();
      const a = line.slice(idx + this.SEP.length).trim();
      if (q.length >= 2 && a.length >= 1) cards.push({ q, a });
    }
    return cards;
  },

  /** 卡片 → Anki 导入文本（制表符分隔） */
  _toAnkiTxt(cards) {
    return cards.map((c) =>
      c.q.replace(/\t/g, " ").replace(/\n+/g, " ") + "\t" +
      c.a.replace(/\t/g, " ").replace(/\n+/g, " ")
    ).join("\n");
  },

  /** 菜单入口 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    if (items.length > 1) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        I18n.isZh ? "制卡一次请只选一篇" : "Select only one item at a time");
      return;
    }
    if (!AIClient.hasKey()) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot", I18n.t("chatNoKey"));
      return;
    }

    const item = items[0];
    let title = "";
    try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
    const zh = I18n.isZh;
    const win = Zotero.getMainWindow();
    const count = Number(Prefs.get("ankiCardCount", 10)) || 10;

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("menuAnki"));
    const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
    pw.show();

    let cards;
    try {
      progress.setText(zh ? "AI 制卡中…" : "Generating cards…");
      progress.setProgress(30);
      const reply = await AIChat.askTask(item, this._prompt(count));
      cards = this._parseCards(reply);
      if (!cards.length) throw new Error("NO_CARDS");
    } catch (e) {
      progress.setError();
      progress.setText(e && e.message === "NO_PDF" ? I18n.t("chatNoPdf")
        : e && e.message === "NO_CARDS"
          ? (zh ? "AI 回复无法解析为卡片，请重试" : "Failed to parse cards, retry")
          : (zh ? "出错：" : "Error: ") + String(e && e.message || e).slice(0, 80));
      Zotero.logError(e);
      pw.startCloseTimer(4000);
      return;
    }
    progress.setText((zh ? "已生成 " : "Generated ") + cards.length + (zh ? " 张卡片" : " cards"));
    progress.setProgress(100);
    pw.startCloseTimer(2500);

    // 导出 .txt
    try {
      const nsIFilePicker = Components.interfaces.nsIFilePicker;
      const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      fp.init(win, zh ? "导出 Anki 卡片" : "Export Anki cards", nsIFilePicker.modeSave);
      fp.defaultString = (title || "cards").replace(/[\\/:*?"<>|]/g, " ").slice(0, 60) + "-anki.txt";
      fp.appendFilter("Text", "*.txt");
      fp.open((rv) => {
        if (rv !== nsIFilePicker.returnOK && rv !== nsIFilePicker.returnReplace) return;
        Zotero.File.putContentsAsync(fp.file.path, this._toAnkiTxt(cards))
          .catch((e) => Zotero.logError(e));
      });
    } catch (e) { /* 导出取消或失败不影响已生成结果 */ }
  },
};
