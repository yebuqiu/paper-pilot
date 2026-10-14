/* PaperPilot AI 思维导图（0.11.0）
 * 轻量路线：AI 生成 Markdown 大纲（标题+嵌套列表），存为笔记；
 * 可选导出 .md 文件（markmap/Obsidian 可直接渲染为导图）。
 * 不内嵌 markmap 渲染器（CDN 依赖与 CSP 风险），导出走标准格式。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Notes, I18n, ItemSel, Components */

var MindMap = {
  _prompt() {
    // 0.38.0：叶节点保留关键数字与术语（信息量），总节点上限防爆炸
    return "请为这篇论文生成思维导图大纲，用 Markdown 表达层级：" +
      "一级标题 = 中心主题（论文核心命题）；二级标题 = 4-6 个主干（研究问题/方法/数据/结果/结论/局限这类）；" +
      "其下用无序列表继续展开 2-3 层，叶节点保留论文的关键数字与术语（不要抽象成空泛短语）。总节点不超过 40 个。" +
      "只输出 Markdown 大纲本身，不要任何解释性文字。";
  },

  /** 菜单入口 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    if (items.length > 1) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n.isZh ? "思维导图一次请只选一篇" : "Select only one item at a time");
      return;
    }
    if (!AIClient.hasKey()) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot", I18n.t("chatNoKey"));
      return;
    }

    const item = items[0];
    let title = "";
    try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
    const zh = I18n.isZh;
    const win = Zotero.getMainWindow();

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + I18n.t("menuMindmap"));
    const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
    pw.show();

    let md;
    try {
      progress.setText(zh ? "AI 生成大纲…" : "Generating outline…");
      progress.setProgress(30);
      md = await AIChat.askTask(item, this._prompt());
      await Notes.createFromMarkdown(item, `${I18n.t("noteMindmapTitle")}｜${title}`, md);
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      progress.setText(e && e.message === "NO_PDF" ? I18n.t("chatNoPdf")
        : (zh ? "出错：" : "Error: ") + String(e && e.message || e).slice(0, 80));
      Zotero.logError(e);
      pw.startCloseTimer(4000);
      return;
    }
    pw.startCloseTimer(2500);

    // 可选导出 .md（markmap 兼容）
    try {
      if (Services.prompt.confirm(win, "PaperPilot",
        zh ? "笔记已生成。是否再导出一份 .md 文件（可用 markmap/Obsidian 渲染为导图）？"
           : "Note created. Also export a .md file (markmap/Obsidian compatible)?")) {
        const nsIFilePicker = Components.interfaces.nsIFilePicker;
        const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(win, zh ? "导出思维导图大纲" : "Export outline", nsIFilePicker.modeSave);
        fp.defaultString = (title || "mindmap").replace(/[\\/:*?"<>|]/g, " ").slice(0, 60) + ".md";
        fp.appendFilter("Markdown", "*.md");
        fp.open((rv) => {
          if (rv !== nsIFilePicker.returnOK && rv !== nsIFilePicker.returnReplace) return;
          Zotero.File.putContentsAsync(fp.file.path, md).catch((e) => Zotero.logError(e));
        });
      }
    } catch (e) { /* 导出失败不影响笔记 */ }
  },
};
