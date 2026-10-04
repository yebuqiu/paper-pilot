/* PaperPilot 菜单：工具菜单 + 条目右键子菜单 + 分类右键 */
/* global Zotero, Services, Prefs, AIChat, AIClient, I18n, Notes, Annotations, AutoTag, Matrix, CollectionStats, Channels, CitationColumn, RuleTag, CitationTrace, FakeCheck, SmartCleanup, MetaEnrich, ItemSel, BilingualTranslate, CNMeta, CNTranslators, CNFetch, CNVerify, ReadingState, NoteTemplates, AttachManager, MindMap, ReviewGen, MetaLint, OAFetch, AnkiExport, LibGraph, UiTheme, PdfTheme, PdfCompare, TagCurator, AttachDoctor, LibSearch, Automation, AutoRead, NoteGraph, ReadingStats, MetaRules, Discovery, MCP */

var Menus = {
  _nodes: [], // 记录注入的 DOM 节点，shutdown 时移除

  _xul(doc, tag) {
    return doc.createXULElement
      ? doc.createXULElement(tag)
      : doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", tag);
  },

  _track(node) {
    this._nodes.push(node);
    return node;
  },

  _menuItem(doc, parent, id, labelKey, onCommand) {
    const mi = this._xul(doc, "menuitem");
    mi.id = id;
    mi.setAttribute("label", I18n.t(labelKey));
    mi.addEventListener("command", onCommand);
    parent.appendChild(mi);
    return mi;
  },

  init(rootURI) {
    const win = Zotero.getMainWindow();
    if (!win) return;
    const doc = win.document;

    // ---- 工具菜单 ----
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (toolsPopup) {
      const t0 = this._menuItem(doc, toolsPopup, "paperpilot-menu-hub", "menuHub",
        () => Zotero.PaperPilot.openHub());
      // 0.22.0：库内问答——问整个文献库（library-wide，与条目选中无关）
      const t0b = this._menuItem(doc, toolsPopup, "paperpilot-menu-lib-ask", "menuLibAsk",
        () => LibSearch.openDialog());
      // 0.23.0：自动化规则（触发-条件-动作 + 入库自动精读的开关都在这一个窗口里）
      const t0c = this._menuItem(doc, toolsPopup, "paperpilot-menu-automation", "menuAutomation",
        () => Automation.openDialog());
      // 0.23.0：笔记关系图谱 + 阅读报告
      const t0d = this._menuItem(doc, toolsPopup, "paperpilot-menu-note-graph", "menuNoteGraph",
        () => NoteGraph.openDialog());
      const t0e = this._menuItem(doc, toolsPopup, "paperpilot-menu-reading-report", "menuReadingReport",
        () => ReadingStats.run());
      // 0.24.0：文献发现（arXiv 日推）/ 元数据体检 / MCP 对外供给
      const t0f = this._menuItem(doc, toolsPopup, "paperpilot-menu-discovery", "menuDiscovery",
        () => Discovery.openDialog());
      const t0g = this._menuItem(doc, toolsPopup, "paperpilot-menu-meta-rules", "menuMetaRules",
        () => MetaRules.openDialog());
      const t0h = this._menuItem(doc, toolsPopup, "paperpilot-menu-mcp", "menuMcp",
        () => MCP.openDialog());
      const t1 = this._menuItem(doc, toolsPopup, "paperpilot-menu-conn-test", "menuConnTest",
        () => this.testConnection());
      // AI 模型通道快速切换（popupshowing 时动态填充；0.14.0 取代配置快照菜单）
      const pmenu = this._xul(doc, "menu");
      pmenu.id = "paperpilot-menu-channels";
      pmenu.setAttribute("label", I18n.t("menuChannels"));
      const ppopup = this._xul(doc, "menupopup");
      pmenu.appendChild(ppopup);
      ppopup.addEventListener("popupshowing", () => this._fillChannelsMenu(doc, ppopup));
      toolsPopup.appendChild(pmenu);
      const t2 = this._menuItem(doc, toolsPopup, "paperpilot-menu-settings", "menuSettings",
        () => this.openSettings());
      const t3 = this._menuItem(doc, toolsPopup, "paperpilot-menu-workbench", "menuWorkbench",
        () => Zotero.PaperPilot.openWorkbench());
      const t4 = this._menuItem(doc, toolsPopup, "paperpilot-menu-cn-translators", "menuCnTranslators",
        () => CNTranslators.update(true));
      const t5 = this._menuItem(doc, toolsPopup, "paperpilot-menu-cn-verify", "menuCNVerify",
        () => CNVerify.interactive());
      // 0.16.0 外观主题：界面主题 / PDF 阅读主题 两组 radio（popupshowing 动态填充，
      // 交互模式与上面的模型通道菜单一致）
      const themeMenu = this._xul(doc, "menu");
      themeMenu.id = "paperpilot-menu-themes";
      themeMenu.setAttribute("label", I18n.t("menuThemes"));
      const themePopup = this._xul(doc, "menupopup");
      themeMenu.appendChild(themePopup);
      const uiSub = this._xul(doc, "menu");
      uiSub.setAttribute("label", I18n.t("menuUiTheme"));
      const uiSubPopup = this._xul(doc, "menupopup");
      uiSub.appendChild(uiSubPopup);
      uiSubPopup.addEventListener("popupshowing", () => this._fillUiThemesMenu(doc, uiSubPopup));
      const pdfSub = this._xul(doc, "menu");
      pdfSub.setAttribute("label", I18n.t("menuPdfTheme"));
      const pdfSubPopup = this._xul(doc, "menupopup");
      pdfSub.appendChild(pdfSubPopup);
      pdfSubPopup.addEventListener("popupshowing", () => this._fillPdfThemesMenu(doc, pdfSubPopup));
      themePopup.appendChild(uiSub);
      themePopup.appendChild(pdfSub);
      // 0.20.0：外观主题从「工具」菜单挪到「视图」菜单——主题属于界面外观，
      // 与 Zotero 原生的布局/界面密度/字体大小同类语义（zotero-night、zoterostyle
      // 等开源插件也把外观入口放在视图侧）；视图菜单缺失时回退到工具菜单。
      const viewPopup = doc.getElementById("menu_ViewPopup");
      (viewPopup || toolsPopup).appendChild(themeMenu);
      this._track(t0); this._track(t1); this._track(pmenu); this._track(t2); this._track(t3); this._track(t4); this._track(t5); this._track(themeMenu); this._track(t0b); this._track(t0c); this._track(t0d); this._track(t0e); this._track(t0f); this._track(t0g); this._track(t0h);
    }

    // ---- 条目右键：PaperPilot 子菜单 ----
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (itemMenu) {
      const sep = this._xul(doc, "menuseparator");
      itemMenu.appendChild(sep);
      this._track(sep);

      const menu = this._xul(doc, "menu");
      menu.id = "paperpilot-itemmenu";
      menu.setAttribute("label", "PaperPilot");
      const popup = this._xul(doc, "menupopup");
      menu.appendChild(popup);
      itemMenu.appendChild(menu);
      this._track(menu);

      this._menuItem(doc, popup, "paperpilot-itemmenu-hub", "menuHub",
        () => Zotero.PaperPilot.openHub());
      // 0.21.0 多篇 PDF 并排对比（需选中 ≥2 篇带 PDF 的文献）
      this._menuItem(doc, popup, "paperpilot-itemmenu-pdf-compare", "menuPdfCompare",
        () => PdfCompare.runForSelected());
      popup.appendChild(this._xul(doc, "menuseparator"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-ai-summary", "menuAiSummary",
        () => this.aiTaskForSelected((it) => AIChat.summarize(it), "noteSummaryTitle"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-ai-translate", "menuAiTranslate",
        () => this.aiTaskForSelected((it) => AIChat.translateTitleAbstract(it), "noteTranslateTitle"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-ai-note", "menuAiNote",
        () => this.aiTaskForSelected((it) => AIChat.interpret(it), "noteTitle"));
      popup.appendChild(this._xul(doc, "menuseparator"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-collect-annot", "menuCollectAnnot",
        () => this.annotationTask(false));
      this._menuItem(doc, popup, "paperpilot-itemmenu-ai-annot", "menuAiAnnot",
        () => this.annotationTask(true));
      popup.appendChild(this._xul(doc, "menuseparator"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-ai-tag", "menuAiTag",
        () => AutoTag.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-rule-tag", "menuRuleTag",
        () => RuleTag.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-matrix", "menuMatrix",
        () => Matrix.forSelected());
      popup.appendChild(this._xul(doc, "menuseparator"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-s2-refresh", "menuS2Refresh",
        () => CitationColumn.refreshForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-cite-trace", "menuCiteTrace",
        () => CitationTrace.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-ref-import", "menuRefImport",
        () => CitationTrace.importForSelected());
      popup.appendChild(this._xul(doc, "menuseparator"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-meta-enrich", "menuMetaEnrich",
        () => MetaEnrich.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-fake-check", "menuFakeCheck",
        () => FakeCheck.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-paste-check", "menuPasteCheck",
        () => FakeCheck.openPasteDialog());
      this._menuItem(doc, popup, "paperpilot-itemmenu-smart-cleanup", "menuSmartCleanup",
        () => SmartCleanup.run());
      // ---- 0.11.0 新增 ----
      popup.appendChild(this._xul(doc, "menuseparator"));
      // 0.25.2：主入口改为左右双栏对照窗口；原「AI 双语笔记」保留（出口不变）
      this._menuItem(doc, popup, "paperpilot-itemmenu-bilingual-view", "menuBilingualView",
        () => BilingualTranslate.openViewerForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-bilingual", "menuBilingual",
        () => BilingualTranslate.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-review", "menuReview",
        () => ReviewGen.forSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-mindmap", "menuMindmap",
        () => MindMap.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-note-template", "menuNoteTemplate",
        () => NoteTemplates.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-anki", "menuAnki",
        () => AnkiExport.runForSelected());
      popup.appendChild(this._xul(doc, "menuseparator"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-cn-meta", "menuCnMeta",
        () => CNMeta.runForSelected());
      // ---- 0.14.5 中文工具组（茉莉花同等能力）----
      this._menuItem(doc, popup, "paperpilot-itemmenu-cn-fetch", "menuCnFetch",
        () => CNFetch.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-cn-match-att", "menuCnMatchAtt",
        () => CNFetch.matchAttachmentsFromDownloads());
      this._menuItem(doc, popup, "paperpilot-itemmenu-cn-name-merge", "menuCnNameMerge",
        () => CNFetch.mergeNames());
      this._menuItem(doc, popup, "paperpilot-itemmenu-cn-name-split", "menuCnNameSplit",
        () => CNFetch.splitNames());
      this._menuItem(doc, popup, "paperpilot-itemmenu-meta-lint", "menuMetaLint",
        () => MetaLint.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-oa-fetch", "menuOaFetch",
        () => OAFetch.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-attach-rename", "menuAttachRename",
        () => AttachManager.runForSelected());
      // ---- 0.22.0 库健康/治理增强 ----
      this._menuItem(doc, popup, "paperpilot-itemmenu-attach-doctor", "menuAttachDoctor",
        () => AttachDoctor.run());
      this._menuItem(doc, popup, "paperpilot-itemmenu-tag-curator", "menuTagCurator",
        () => TagCurator.run(false));
      this._menuItem(doc, popup, "paperpilot-itemmenu-tag-normalize", "menuTagNormalize",
        () => TagCurator.run(true));
      // ---- 0.24.0 元数据体检（规则补齐）----
      this._menuItem(doc, popup, "paperpilot-itemmenu-meta-rules", "menuMetaRules",
        () => MetaRules.openDialog());
      // ---- 0.23.0 自动化与入库自动精读 ----
      this._menuItem(doc, popup, "paperpilot-itemmenu-automation", "menuAutomationRun",
        () => Automation.runForSelected());
      this._menuItem(doc, popup, "paperpilot-itemmenu-auto-read", "menuAutoReadNow",
        () => AutoRead.runForSelected());
      popup.appendChild(this._xul(doc, "menuseparator"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-state-unread", "menuStateUnread",
        () => ReadingState.markForSelected("未读"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-state-reading", "menuStateReading",
        () => ReadingState.markForSelected("在读"));
      this._menuItem(doc, popup, "paperpilot-itemmenu-state-done", "menuStateDone",
        () => ReadingState.markForSelected("已读"));
    }

    // ---- 分类右键：条目统计 + 统计图谱 ----
    const collMenu = doc.getElementById("zotero-collectionmenu");
    if (collMenu) {
      const mi = this._menuItem(doc, collMenu, "paperpilot-collmenu-stats", "menuCollStat",
        () => CollectionStats.showForSelectedCollection());
      const mi2 = this._menuItem(doc, collMenu, "paperpilot-collmenu-libgraph", "menuLibGraph",
        () => LibGraph.run());
      this._track(mi);
      this._track(mi2);
    }
  },

  /** 工具菜单 → AI 配置快照：popupshowing 时动态列出快照，点击即切换 */
  _fillChannelsMenu(doc, popup) {
    while (popup.firstChild) popup.removeChild(popup.firstChild);
    let data = { channels: [], active: null };
    try { data = Channels.list(); } catch (e) { /* ignore */ }
    if (!data.channels.length) {
      const empty = this._xul(doc, "menuitem");
      empty.setAttribute("label", I18n.t("menuChannelsEmpty"));
      empty.setAttribute("disabled", "true");
      popup.appendChild(empty);
      return;
    }
    for (const c of data.channels) {
      const mi = this._xul(doc, "menuitem");
      const current = c.id === data.active;
      const suffix = c.official && !c.available ? "（需登录）" : `（${c.model}）`;
      mi.setAttribute("label", (current ? "✓ " : "") + `${c.name}${suffix}`);
      mi.setAttribute("type", "radio");
      if (current) mi.setAttribute("checked", "true");
      mi.addEventListener("command", () => {
        try {
          const r = Channels.setActive(c.id);
          if (!r.ok) {
            Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
              I18n.t("channelSwitchBlocked") + "：" + r.error);
            return;
          }
          const pw = new Zotero.ProgressWindow({ closeOnClick: true });
          pw.changeHeadline("PaperPilot");
          const prog = new pw.ItemProgress(
            "chrome://paperpilot/content/icons/chat.svg",
            I18n.t("channelSwitched") + `：${c.name}（${c.model}）`
          );
          prog.setProgress(100);
          pw.show();
          pw.startCloseTimer(1800);
        } catch (e) { Zotero.logError(e); }
      });
      popup.appendChild(mi);
    }
  },

  /** 工具菜单 → 外观主题 · 界面主题：按分类嵌套（动漫/风景/动态），radio 单选 */
  _fillUiThemesMenu(doc, popup) {
    while (popup.firstChild) popup.removeChild(popup.firstChild);
    const current = String(Prefs.get("uiTheme", "") || "");
    const mk = (parent, label, id, checked, icon) => {
      const mi = this._xul(doc, "menuitem");
      mi.setAttribute("label", (icon || "") + label);
      mi.setAttribute("type", "radio");
      if (checked) mi.setAttribute("checked", "true");
      mi.addEventListener("command", () => {
        try { UiTheme.setTheme(id); } catch (e) { Zotero.logError(e); }
      });
      parent.appendChild(mi);
    };
    mk(popup, I18n.t("themeFollowNative"), "", current === "", "🍃 ");
    const cats = [
      { key: "standard", label: I18n.t("themeGroupStandard") },
      { key: "anime", label: I18n.t("themeGroupAnime") },
      { key: "scenery", label: I18n.t("themeGroupScenery") },
      { key: "dynamic", label: I18n.t("themeGroupDynamic") },
    ];
    for (const cat of cats) {
      const items = UiTheme.THEMES.filter((t) => t.cat === cat.key);
      if (!items.length) continue;
      const sub = this._xul(doc, "menu");
      sub.setAttribute("label", cat.label);
      const subPopup = this._xul(doc, "menupopup");
      sub.appendChild(subPopup);
      for (const t of items) {
        const icon = t.wp && t.wp.anim ? "⚡ " : (t.dark ? "🌙 " : "☀️ ");
        mk(subPopup, t.name, t.id, current === t.id, icon);
      }
      popup.appendChild(sub);
    }
    popup.appendChild(this._xul(doc, "menuseparator"));
    mk(popup, I18n.t("themeCustom"), "custom", current === "custom", "🎨 ");
  },

  /** 工具菜单 → 外观主题 · PDF 阅读主题：radio 列表 */
  _fillPdfThemesMenu(doc, popup) {
    while (popup.firstChild) popup.removeChild(popup.firstChild);
    const current = PdfTheme ? PdfTheme.current().id : "default";
    for (const t of PdfTheme.THEMES) {
      const mi = this._xul(doc, "menuitem");
      mi.setAttribute("label", (t.dark ? "🌙 " : "📄 ") + t.name);
      mi.setAttribute("type", "radio");
      if (t.id === current) mi.setAttribute("checked", "true");
      mi.addEventListener("command", () => {
        try { PdfTheme.setTheme(t.id); } catch (e) { Zotero.logError(e); }
      });
      popup.appendChild(mi);
    }
  },

  /** 打开 Zotero 设置中的 PaperPilot 窗格 */
  openSettings() {
    try {
      // openPreferences 收 paneID 不是 pluginID（Z10 navigateToPane 按 pane id 查找，
      // 传 pluginID 会落在常规窗格）；用 register 时存的稳定 paneID
      const paneID = (Zotero.PaperPilot && Zotero.PaperPilot._paneID) || "paperpilot-prefs";
      Zotero.Utilities.Internal.openPreferences(paneID);
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 打开设置窗格失败"));
      Zotero.logError(e);
    }
  },

  /** 工具菜单：接口连通性测试，结果弹窗展示 */
  async testConnection() {
    const win = Zotero.getMainWindow();
    if (!AIClient.hasKey()) {
      Services.prompt.alert(win, "PaperPilot", AIClient.guidance() || I18n.t("chatNoKey"));
      return;
    }
    try {
      const reply = await AIClient.chat([
        { role: "user", content: "用一句话回答：接口连通正常" },
      ]);
      Services.prompt.alert(win, "PaperPilot",
        `${I18n.t("connOk")}\n\nBase URL：${AIClient.baseUrl()}\n` +
        `模型：${AIClient.model()}\n回复：${String(reply).slice(0, 200)}`);
    } catch (e) {
      Services.prompt.alert(win, "PaperPilot",
        `${I18n.t("connFail")}\n\nBase URL：${AIClient.baseUrl()}\n` +
        `模型：${AIClient.model()}\n${I18n.t("errPrefix")}${e.message || e}`);
    }
  },

  /** 批注任务：收集为笔记 / AI 解读批注 */
  async annotationTask(withAI) {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = (zp.getSelectedItems() || [])
      .filter(i => (i.isRegularItem && i.isRegularItem()) || (i.isPDFAttachment && i.isPDFAttachment()));
    if (!items.length) return;
    if (withAI && !AIClient.hasKey()) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        AIClient.guidance() || I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    pw.show();

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        if (withAI) {
          const text = await Annotations.aiInterpret(item);
          await Notes.createFromMarkdown(item, `${I18n.t("noteAnnotAiTitle")}｜${title}`, text);
        } else {
          await Annotations.collectToNote(item);
        }
        progress.setProgress(100);
      } catch (e) {
        if (e && e.message === "NO_ANNOTATIONS") {
          progress.setText(I18n.t("annotEmpty"));
          progress.setProgress(100);
        } else {
          progress.setError();
          Zotero.logError(e);
        }
      }
    }
    pw.startCloseTimer(2500);
  },

  /**
   * 通用 AI 任务执行器：为选中条目逐个执行 AI 任务并生成子笔记
   * @param taskFn (item) => Promise<string> 返回 Markdown 文本
   * @param noteTitleKey I18n 键，笔记标题前缀
   */
  async aiTaskForSelected(taskFn, noteTitleKey) {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    // 0.8.1：附件自动上溯父条目；空选择给明确提示而不是静默无反应
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }

    if (!AIClient.hasKey()) {
      // 0.21.0：精确区分未登录 / 缺 Key
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        AIClient.guidance() || I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    pw.show();

    for (const item of items) {
      const progress = new pw.ItemProgress(
        "chrome://paperpilot/content/icons/chat.svg",
        item.getDisplayTitle()
      );
      try {
        progress.setProgress(30);
        const text = await taskFn(item);
        let paperTitle = "";
        try { paperTitle = item.getField("title") || ""; } catch (e) { /* ignore */ }
        await Notes.createFromMarkdown(
          item,
          `${I18n.t(noteTitleKey)}｜${paperTitle}`,
          text
        );
        progress.setProgress(100);
      } catch (e) {
        // 0.8.1：错误原因直接写在进度窗里，不再只有一个红叉
        progress.setError();
        progress.setText(this._taskErrorText(e));
        Zotero.logError(e);
      }
    }
    pw.startCloseTimer(4000);
  },

  /** 把任务异常翻译成用户能看懂的进度窗文案 */
  _taskErrorText(e) {
    const msg = String(e && e.message || e || "");
    const zh = I18n.isZh;
    if (msg === "NO_PDF" || msg === "NO_META") {
      return zh ? "无摘要也无 PDF 全文，无法处理" : "No abstract and no PDF";
    }
    return (zh ? "出错：" : "Error: ") + msg.slice(0, 80);
  },

  destroy() {
    for (const n of this._nodes) {
      try { n.remove(); } catch (e) { /* ignore */ }
    }
    this._nodes = [];
  },
};
