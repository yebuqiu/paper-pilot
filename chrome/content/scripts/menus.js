// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 菜单：工具菜单 + 条目右键子菜单 + 分类右键
 * 0.29.0 菜单瘦身：
 *   - 注册表驱动：条目右键命令集中在 ITEM_REGISTRY（id/group/labelKey/run），
 *     新增功能不再手改菜单结构，分组归属即一行；
 *   - menuMode=grouped（默认）：右键 = 高频直达（≤3 项）+ 8 个语义分组两层结构；
 *     「工具」菜单收拢为单一「Papilot ▸」入口 + 独立「设置」项；
 *   - menuMode=classic：完整保留 0.28 及以前的平铺结构（设置窗格可一键切回）；
 *   - menuMode / menuHiddenGroups / menuQuickItems 三个 pref 变更即时重建菜单。
 * 设计口径：只做「重组」不做「删减」——被折叠的功能仍可从功能中心（Hub）、
 * 工具菜单分组、classic 模式三处到达，任何入口都不失联。 */
/* global Zotero, Services, Prefs, AIChat, AIClient, I18n, Notes, Annotations, AutoTag, Matrix, Channels, CitationColumn, RuleTag, CitationTrace, RefImport, FakeCheck, SmartCleanup, MetaEnrich, ItemSel, CNMeta, CNTranslators, CNFetch, CNVerify, CNAuth, ReadingState, NoteTemplates, AttachManager, MindMap, ReviewGen, MetaLint, OAFetch, AnkiExport, LibGraph, UiTheme, PdfTheme, PdfCompare, TagCurator, AttachDoctor, LibSearch, Automation, AutoRead, NoteGraph, ReadingStats, ReadingProgress, MetaRules, Discovery, MCP, ChatFloat, Rating, PdfDual, CollectionStats, ThirdSource, MetaDoctor, AnnotationDigest, ReviewWorkbench, OcrService, NoteTools */

var Menus = {
  _nodes: [], // 记录注入的 DOM 节点，shutdown 时移除
  _observers: [], // 菜单 pref 观察者（即时重建）
  _rootURI: null,

  // ---------- 0.29.0 条目右键命令注册表 ----------
  // group=null：恒在顶层直达；group="state"：阅读状态（radio 子菜单，特殊渲染）；
  // 其余 group 对应 GROUPS 中的语义分组。id 同时是 pref menuQuickItems 的取值。
  ITEM_REGISTRY: [
    // 顶层直达（不进分组、不受隐藏分组影响）
    { id: "pdf-compare", group: null, labelKey: "menuPdfCompare", run: () => PdfCompare.runForSelected() },
    { id: "hub", group: null, labelKey: "menuHub", run: () => Zotero.Papilot.openHub() },
    // 0.31.0 AI 问答悬浮窗：锁定为右键选中的条目并唤起（Ctrl+Shift+K）
    { id: "ai-chat", group: null, labelKey: "menuAiChat", run: () => Menus.openChatFloat() },
    // AI 阅读助手
    { id: "ai-summary", group: "ai", labelKey: "menuAiSummary",
      run: () => Menus.aiTaskForSelected((it) => AIChat.summarize(it), "noteSummaryTitle") },
    { id: "ai-translate", group: "ai", labelKey: "menuAiTranslate",
      run: () => Menus.aiTaskForSelected((it) => AIChat.translateTitleAbstract(it), "noteTranslateTitle") },
    { id: "ai-note", group: "ai", labelKey: "menuAiNote",
      run: () => Menus.aiTaskForSelected((it) => AIChat.interpret(it), "noteTitle") },
    { id: "collect-annot", group: "ai", labelKey: "menuCollectAnnot", run: () => Menus.annotationTask(false) },
    { id: "ai-annot", group: "ai", labelKey: "menuAiAnnot", run: () => Menus.annotationTask(true) },
    // 笔记与输出
    // 0.36.0：主入口改为「左原右译」双栏窗口（左=原版 PDF 页面 / 右=同一页译文，
    // 译文按原文段落坐标原位替换、图形与公式保留）。
    // 0.42.0：旧「文本双栏窗口」右键入口下线（与对照翻译重叠），仍可从功能中心到达。
    { id: "bilingual-view", group: "notes", labelKey: "menuPdfDual",
      run: () => PdfDual.openForSelected() },
    { id: "review", group: "notes", labelKey: "menuReview", run: () => ReviewGen.forSelected() },
    { id: "mindmap", group: "notes", labelKey: "menuMindmap", run: () => MindMap.runForSelected() },
    { id: "note-template", group: "notes", labelKey: "menuNoteTemplate", run: () => NoteTemplates.runForSelected() },
    // 0.63.0 笔记工具（A2）：单篇内的大纲 + 多篇批量整理（只走公开接口，不碰编辑器内部）
    { id: "note-tools", group: "notes", labelKey: "menuNoteTools", run: () => NoteTools.runForSelected() },
    // 0.62.0 单向导出到 Obsidian（只写不回读，避免变成同步引擎）
    { id: "obsidian-export", group: "notes", labelKey: "menuObsidianExport", run: () => ObsidianExport.runForSelected() },
    { id: "anki", group: "notes", labelKey: "menuAnki", run: () => AnkiExport.runForSelected() },
    // 引文分析
    { id: "s2-refresh", group: "citation", labelKey: "menuS2Refresh", run: () => CitationColumn.refreshForSelected() },
    { id: "cite-trace", group: "citation", labelKey: "menuCiteTrace", run: () => CitationTrace.runForSelected() },
    { id: "ref-import", group: "citation", labelKey: "menuRefImport", run: () => RefImport.openDialog() },
    { id: "cite-export", group: "citation", labelKey: "menuCiteExport", run: () => CiteExport.openDialog() },
    { id: "matrix", group: "citation", labelKey: "menuMatrix", run: () => Matrix.forSelected() },
    // 标签治理
    { id: "ai-tag", group: "tags", labelKey: "menuAiTag", run: () => AutoTag.runForSelected() },
    { id: "rule-tag", group: "tags", labelKey: "menuRuleTag", run: () => RuleTag.runForSelected() },
    { id: "tag-curator", group: "tags", labelKey: "menuTagCurator", run: () => TagCurator.run(false) },
    { id: "tag-normalize", group: "tags", labelKey: "menuTagNormalize", run: () => TagCurator.run(true) },
    // 0.42.0 嵌套标签树（#a/b 层级只读视图，独立窗口）
    { id: "tag-nested", group: "tags", labelKey: "menuTagNested", run: () => TagCurator.openNestedView() },
    // 元数据治理
    { id: "meta-enrich", group: "meta", labelKey: "menuMetaEnrich", run: () => MetaEnrich.runForSelected() },
    { id: "fake-check", group: "meta", labelKey: "menuFakeCheck", run: () => FakeCheck.runForSelected() },
    { id: "paste-check", group: "meta", labelKey: "menuPasteCheck", run: () => FakeCheck.openPasteDialog() },
    { id: "smart-cleanup", group: "meta", labelKey: "menuSmartCleanup", run: () => SmartCleanup.run() },
    { id: "meta-lint", group: "meta", labelKey: "menuMetaLint", run: () => MetaLint.runForSelected() },
    // 0.52.0 元数据医生：Crossref 反查补全（预览→确认→可撤销）
    { id: "meta-doctor", group: "meta", labelKey: "menuMetaDoctor", run: () => MetaDoctor.run() },
    // 0.63.0 PDF 无头渲染 + 视觉 OCR：扫描件（无文本层）补全文，结果落本地侧车后
    // AI 问答自动回退可用。只发送当前页 JPEG 到用户自己配置的 AI 通道。
    { id: "ocr-run", group: "meta", labelKey: "menuOcrRun", run: () => OcrService.runForSelected() },
    // 0.53.0 综述工作台（笔记组：多篇 → 大纲 → 分节草稿）
    { id: "review-workbench", group: "notes", labelKey: "menuReviewWorkbench", run: () => ReviewWorkbench.openDialog() },
    { id: "meta-rules", group: "meta", labelKey: "menuMetaRules", run: () => MetaRules.openDialog() },
    // 中文文献工具
    { id: "cn-meta", group: "cn", labelKey: "menuCnMeta", run: () => CNMeta.runForSelected() },
    { id: "cn-fetch", group: "cn", labelKey: "menuCnFetch", run: () => CNFetch.runForSelected() },
    // 0.43.1：知网账号登录/验证/转换器更新收敛到设置面板（登录类不再出现在右键菜单）
    { id: "cn-match-att", group: "cn", labelKey: "menuCnMatchAtt", run: () => CNFetch.matchAttachmentsFromDownloads() },
    { id: "cn-name-merge", group: "cn", labelKey: "menuCnNameMerge", run: () => CNFetch.mergeNames() },
    { id: "cn-name-split", group: "cn", labelKey: "menuCnNameSplit", run: () => CNFetch.splitNames() },
    { id: "oa-fetch", group: "cn", labelKey: "menuOaFetch", run: () => OAFetch.runForSelected() },
    // 0.44.2（实验）第三方文献源：内置可用网点（无需账号）——菜单直达设置面板的网点卡片
    { id: "third-source", group: "cn", labelKey: "menuThirdSource", run: () => ThirdSource.openSettings() },
    { id: "attach-rename", group: "cn", labelKey: "menuAttachRename", run: () => AttachManager.runForSelected() },
    { id: "attach-doctor", group: "cn", labelKey: "menuAttachDoctor", run: () => AttachDoctor.run() },
    // 自动化
    { id: "automation-run", group: "automation", labelKey: "menuAutomationRun", run: () => Automation.runForSelected() },
    { id: "auto-read", group: "automation", labelKey: "menuAutoReadNow", run: () => AutoRead.runForSelected() },
    // 阅读状态（radio 子菜单，见 _buildStateSubmenu）
    { id: "state-unread", group: "state", labelKey: "menuStateUnread", run: () => ReadingState.markForSelected("未读") },
    { id: "state-reading", group: "state", labelKey: "menuStateReading", run: () => ReadingState.markForSelected("在读") },
    { id: "state-done", group: "state", labelKey: "menuStateDone", run: () => ReadingState.markForSelected("已读") },
    // 星标评级（0.42.0，radio 子菜单，见 _buildRatingSubmenu；存储为 ★×n 单标签）
    { id: "rating-1", group: "rating", labelKey: "menuRating1", run: () => Menus.setRatingForSelected(1) },
    { id: "rating-2", group: "rating", labelKey: "menuRating2", run: () => Menus.setRatingForSelected(2) },
    { id: "rating-3", group: "rating", labelKey: "menuRating3", run: () => Menus.setRatingForSelected(3) },
    { id: "rating-4", group: "rating", labelKey: "menuRating4", run: () => Menus.setRatingForSelected(4) },
    { id: "rating-5", group: "rating", labelKey: "menuRating5", run: () => Menus.setRatingForSelected(5) },
    { id: "rating-clear", group: "rating", labelKey: "menuRatingClear", run: () => Menus.setRatingForSelected(0) },
  ],

  // 语义分组（顺序即菜单呈现顺序；id 即 menuHiddenGroups 的取值）
  GROUPS: [
    { id: "ai", labelKey: "menuGroupAi" },
    { id: "notes", labelKey: "menuGroupNotes" },
    { id: "citation", labelKey: "menuGroupCitation" },
    { id: "tags", labelKey: "menuGroupTags" },
    { id: "meta", labelKey: "menuGroupMeta" },
    { id: "cn", labelKey: "menuGroupCn" },
    { id: "automation", labelKey: "menuGroupAutomation" },
    { id: "state", labelKey: "menuReadingState" },
    { id: "rating", labelKey: "menuRating" },
  ],

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
    this._rootURI = rootURI;
    const win = Zotero.getMainWindow();
    if (!win) return;
    const doc = win.document;
    // 0.29.0：grouped（默认）= 分组两层；classic = 0.28 及以前的平铺结构
    const grouped = String(Prefs.get("menuMode", "grouped")) !== "classic";

    // ---- 工具菜单 ----
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (toolsPopup) {
      if (grouped) this._buildGroupedTools(doc, toolsPopup);
      else this._buildClassicTools(doc, toolsPopup);
    }

    // ---- 条目右键：Papilot 子菜单 ----
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (itemMenu) {
      const sep = this._xul(doc, "menuseparator");
      itemMenu.appendChild(sep);
      this._track(sep);

      const menu = this._xul(doc, "menu");
      menu.id = "papilot-itemmenu";
      menu.setAttribute("label", "Papilot");
      const popup = this._xul(doc, "menupopup");
      menu.appendChild(popup);
      itemMenu.appendChild(menu);
      this._track(menu);

      if (grouped) this._buildGroupedItemMenu(doc, popup);
      else this._buildClassicItemMenu(doc, popup);
    }

    // ---- 分类右键：条目统计 + 统计图谱 ----
    const collMenu = doc.getElementById("zotero-collectionmenu");
    if (collMenu) {
      const mi = this._menuItem(doc, collMenu, "papilot-collmenu-stats", "menuCollStat",
        () => CollectionStats.showForSelectedCollection());
      const mi2 = this._menuItem(doc, collMenu, "papilot-collmenu-libgraph", "menuLibGraph",
        () => LibGraph.run());
      this._track(mi);
      this._track(mi2);
    }

    // ---- 菜单定制 pref 变更即时重建（无需重启） ----
    this._watchMenuPrefs();
  },

  /* ---------- 分组模式构建（0.29.0 默认） ---------- */

  /** 条目右键：高频直达 + 语义分组 + 顶层直达 */
  _buildGroupedItemMenu(doc, popup) {
    const hidden = this._hiddenGroups();
    // 高频直达（与分组内条目是同一功能的两处入口，不算重复）
    const quick = this._quickItems();
    for (const q of quick) {
      this._menuItem(doc, popup, "papilot-itemmenu-quick-" + q.id, q.labelKey, q.run);
    }
    if (quick.length) popup.appendChild(this._xul(doc, "menuseparator"));
    // 语义分组
    for (const g of this.GROUPS) {
      if (g.id === "state") {
        if (!hidden.has("state")) this._buildStateSubmenu(doc, popup);
        continue;
      }
      if (g.id === "rating") {
        if (!hidden.has("rating")) this._buildRatingSubmenu(doc, popup);
        continue;
      }
      if (hidden.has(g.id)) continue;
      const items = this.ITEM_REGISTRY.filter((i) => i.group === g.id);
      if (!items.length) continue;
      const sub = this._xul(doc, "menu");
      sub.setAttribute("label", I18n.t(g.labelKey));
      const subPopup = this._xul(doc, "menupopup");
      sub.appendChild(subPopup);
      for (const it of items) {
        this._menuItem(doc, subPopup, "papilot-itemmenu-" + it.id, it.labelKey, it.run);
      }
      // 0.42.0 自动化组尾部追加「出现在右键菜单」的用户规则（动态，随规则 pref 重建）
      if (g.id === "automation") this._automationRuleItems(doc, subPopup);
      popup.appendChild(sub);
    }
    // 顶层直达（恒显，不受隐藏分组影响）
    popup.appendChild(this._xul(doc, "menuseparator"));
    for (const it of this.ITEM_REGISTRY.filter((i) => i.group === null)) {
      this._menuItem(doc, popup, "papilot-itemmenu-" + it.id, it.labelKey, it.run);
    }
  },

  /** 阅读状态：radio 子菜单，popupshowing 时按当前选中条目打点 */
  _buildStateSubmenu(doc, popup) {
    const sub = this._xul(doc, "menu");
    sub.setAttribute("label", I18n.t("menuReadingState"));
    const subPopup = this._xul(doc, "menupopup");
    sub.appendChild(subPopup);
    const radios = this.ITEM_REGISTRY
      .filter((i) => i.group === "state")
      .map((it) => {
        const mi = this._xul(doc, "menuitem");
        mi.id = "papilot-itemmenu-" + it.id;
        mi.setAttribute("label", I18n.t(it.labelKey));
        mi.setAttribute("type", "radio");
        mi.addEventListener("command", it.run);
        subPopup.appendChild(mi);
        return mi;
      });
    // 打点口径：全部选中条目状态一致才打点（状态不一则全部不选中）
    subPopup.addEventListener("popupshowing", () => {
      try {
        const zp = Zotero.getActiveZoteroPane();
        const items = zp ? ItemSel.regularOnly(zp.getSelectedItems() || []) : [];
        let cur = items.length ? ReadingState.getState(items[0]) : "";
        for (const i of items) {
          if (ReadingState.getState(i) !== cur) { cur = ""; break; }
        }
        radios.forEach((mi, idx) => {
          const state = ReadingState.STATES[idx];
          if (cur && state === cur) mi.setAttribute("checked", "true");
          else mi.removeAttribute("checked");
        });
      } catch (e) { /* 状态读取失败不影响打开 */ }
    });
    // 0.46.0 尾部维护项：重置阅读进度（非 radio——它是命令不是状态；
    // 不进 ITEM_REGISTRY，radio 打点逻辑保持只认三种状态）
    subPopup.appendChild(this._xul(doc, "menuseparator"));
    const reset = this._xul(doc, "menuitem");
    reset.id = "papilot-itemmenu-progress-reset";
    reset.setAttribute("label", I18n.t("menuResetProgress"));
    reset.addEventListener("command", () => Menus.resetProgressForSelected());
    subPopup.appendChild(reset);
    popup.appendChild(sub);
  },

  /** 0.46.0 重置阅读进度（清位置记录 + 原生「上次读到」归零；标注是用户资产不动） */
  async resetProgressForSelected() {
    try {
      const n = await ReadingProgress.resetForSelected();
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Papilot · " + I18n.t("menuResetProgress"));
      const p = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
        n > 0 ? I18n.t("progressResetDone") : I18n.t("progressResetNone"));
      p.setProgress(100);
      pw.show();
      pw.startCloseTimer(2600);
    } catch (e) {
      Zotero.logError(e);
    }
  },

  /** 星标评级：radio 子菜单，popupshowing 时按当前选中条目打点（0.42.0） */
  _buildRatingSubmenu(doc, popup) {
    const sub = this._xul(doc, "menu");
    sub.setAttribute("label", I18n.t("menuRating"));
    const subPopup = this._xul(doc, "menupopup");
    sub.appendChild(subPopup);
    const radios = this.ITEM_REGISTRY
      .filter((i) => i.group === "rating")
      .map((it) => {
        const mi = this._xul(doc, "menuitem");
        mi.id = "papilot-itemmenu-" + it.id;
        mi.setAttribute("label", I18n.t(it.labelKey));
        mi.setAttribute("type", "radio");
        mi.addEventListener("command", it.run);
        subPopup.appendChild(mi);
        return mi;
      });
    // 打点口径与阅读状态一致：全部选中条目评级一致才打点（0 星=勾选「清除评级」）
    subPopup.addEventListener("popupshowing", () => {
      try {
        const zp = Zotero.getActiveZoteroPane();
        const items = zp ? ItemSel.regularOnly(zp.getSelectedItems() || []) : [];
        let cur = items.length ? Rating.get(items[0]) : -1;
        for (const i of items) {
          if (Rating.get(i) !== cur) { cur = -1; break; }
        }
        // 注册表 rating 组顺序：1..5 星 + 清除（索引 5 对应 rating=0）
        radios.forEach((mi, idx) => {
          const val = idx < 5 ? idx + 1 : 0;
          if (cur >= 0 && val === cur) mi.setAttribute("checked", "true");
          else mi.removeAttribute("checked");
        });
      } catch (e) { /* 状态读取失败不影响打开 */ }
    });
    popup.appendChild(sub);
  },

  /** 对当前选中条目设置星标评级（n=0 清除） */
  setRatingForSelected(n) {
    try {
      const zp = Zotero.getActiveZoteroPane();
      const items = zp ? ItemSel.regularOnly(zp.getSelectedItems() || []) : [];
      if (items.length) Rating.set(items, n);
    } catch (e) { Zotero.logError(e); }
  },

  /** 自动化用户规则的动态菜单项（0.42.0：规则里勾了「出现在条目右键菜单」的） */
  _automationRuleItems(doc, parent) {
    let rules = [];
    try { rules = Automation.getMenuRules ? Automation.getMenuRules() : []; } catch (e) { rules = []; }
    for (const r of rules) {
      const mi = this._xul(doc, "menuitem");
      mi.id = "papilot-itemmenu-autorule-" + r.id;
      mi.setAttribute("label", r.name);
      mi.addEventListener("command", () => {
        try { Automation.runRule(r.id); } catch (e) { Zotero.logError(e); }
      });
      parent.appendChild(mi);
    }
  },

  /** 工具菜单：单一「Papilot ▸」入口 + 独立「设置」项 */
  _buildGroupedTools(doc, toolsPopup) {
    const sub = this._xul(doc, "menu");
    sub.id = "papilot-tools-menu";
    sub.setAttribute("label", "Papilot");
    const pop = this._xul(doc, "menupopup");
    sub.appendChild(pop);
    toolsPopup.appendChild(sub);
    this._track(sub);

    // 功能中心（Hub / 工作台 / 库内问答）
    const hubMenu = this._xul(doc, "menu");
    hubMenu.setAttribute("label", I18n.t("menuGroupHub"));
    const hubPop = this._xul(doc, "menupopup");
    hubMenu.appendChild(hubPop);
    this._menuItem(doc, hubPop, "papilot-menu-hub", "menuHub", () => Zotero.Papilot.openHub());
    this._menuItem(doc, hubPop, "papilot-menu-workbench", "menuWorkbench", () => Zotero.Papilot.openWorkbench());
    this._menuItem(doc, hubPop, "papilot-menu-lib-ask", "menuLibAsk", () => LibSearch.openDialog());
    pop.appendChild(hubMenu);

    // 发现与报告
    const discMenu = this._xul(doc, "menu");
    discMenu.setAttribute("label", I18n.t("menuGroupDiscovery"));
    const discPop = this._xul(doc, "menupopup");
    discMenu.appendChild(discPop);
    this._menuItem(doc, discPop, "papilot-menu-discovery", "menuDiscovery", () => Discovery.openDialog());
    this._menuItem(doc, discPop, "papilot-menu-note-graph", "menuNoteGraph", () => NoteGraph.openDialog());
    this._menuItem(doc, discPop, "papilot-menu-reading-report", "menuReadingReport", () => ReadingStats.run());
    pop.appendChild(discMenu);

    // 治理与维护（自动化 / 体检 / 转换器 / 校验 / MCP / 连通测试 / 模型通道）
    const govMenu = this._xul(doc, "menu");
    govMenu.setAttribute("label", I18n.t("menuGroupGovernance"));
    const govPop = this._xul(doc, "menupopup");
    govMenu.appendChild(govPop);
    this._menuItem(doc, govPop, "papilot-menu-automation", "menuAutomation", () => Automation.openDialog());
    this._menuItem(doc, govPop, "papilot-menu-meta-rules", "menuMetaRules", () => MetaRules.openDialog());
    // 0.43.1：知网账号登录/验证/转换器更新 → 设置面板「知网账号」卡片（登录类入口不在菜单）
    this._menuItem(doc, govPop, "papilot-menu-mcp", "menuMcp", () => MCP.openDialog());
    this._menuItem(doc, govPop, "papilot-menu-conn-test", "menuConnTest", () => this.testConnection());
    // AI 模型通道快速切换（popupshowing 时动态填充；0.14.0 取代配置快照菜单）
    const pmenu = this._xul(doc, "menu");
    pmenu.id = "papilot-menu-channels";
    pmenu.setAttribute("label", I18n.t("menuChannels"));
    const ppopup = this._xul(doc, "menupopup");
    pmenu.appendChild(ppopup);
    ppopup.addEventListener("popupshowing", () => this._fillChannelsMenu(doc, ppopup));
    govPop.appendChild(pmenu);
    pop.appendChild(govMenu);

    // 设置独立于总入口（配置操作高频直达，与 0.28 习惯一致）
    this._menuItem(doc, toolsPopup, "papilot-menu-settings", "menuSettings", () => this.openSettings());
  },

  /* ---------- classic 模式构建（0.28 及以前的平铺结构，完整保留） ---------- */

  _buildClassicTools(doc, toolsPopup) {
    const t0 = this._menuItem(doc, toolsPopup, "papilot-menu-hub", "menuHub",
      () => Zotero.Papilot.openHub());
    // 0.22.0：库内问答——问整个文献库（library-wide，与条目选中无关）
    const t0b = this._menuItem(doc, toolsPopup, "papilot-menu-lib-ask", "menuLibAsk",
      () => LibSearch.openDialog());
    // 0.23.0：自动化规则（触发-条件-动作 + 入库自动精读的开关都在这一个窗口里）
    const t0c = this._menuItem(doc, toolsPopup, "papilot-menu-automation", "menuAutomation",
      () => Automation.openDialog());
    // 0.23.0：笔记关系图谱 + 阅读报告
    const t0d = this._menuItem(doc, toolsPopup, "papilot-menu-note-graph", "menuNoteGraph",
      () => NoteGraph.openDialog());
    const t0e = this._menuItem(doc, toolsPopup, "papilot-menu-reading-report", "menuReadingReport",
      () => ReadingStats.run());
    // 0.24.0：文献发现（arXiv 日推）/ 元数据体检 / MCP 对外供给
    const t0f = this._menuItem(doc, toolsPopup, "papilot-menu-discovery", "menuDiscovery",
      () => Discovery.openDialog());
    const t0g = this._menuItem(doc, toolsPopup, "papilot-menu-meta-rules", "menuMetaRules",
      () => MetaRules.openDialog());
    const t0h = this._menuItem(doc, toolsPopup, "papilot-menu-mcp", "menuMcp",
      () => MCP.openDialog());
    const t1 = this._menuItem(doc, toolsPopup, "papilot-menu-conn-test", "menuConnTest",
      () => this.testConnection());
    // AI 模型通道快速切换（popupshowing 时动态填充；0.14.0 取代配置快照菜单）
    const pmenu = this._xul(doc, "menu");
    pmenu.id = "papilot-menu-channels";
    pmenu.setAttribute("label", I18n.t("menuChannels"));
    const ppopup = this._xul(doc, "menupopup");
    pmenu.appendChild(ppopup);
    ppopup.addEventListener("popupshowing", () => this._fillChannelsMenu(doc, ppopup));
    toolsPopup.appendChild(pmenu);
    const t2 = this._menuItem(doc, toolsPopup, "papilot-menu-settings", "menuSettings",
      () => this.openSettings());
    const t3 = this._menuItem(doc, toolsPopup, "papilot-menu-workbench", "menuWorkbench",
      () => Zotero.Papilot.openWorkbench());
    // 0.43.1：cn-translators / cn-verify / cn-login 迁设置面板「知网账号」卡片
    // 0.16.0 外观主题：界面主题 / PDF 阅读主题 两组 radio（popupshowing 动态填充，
    // 交互模式与上面的模型通道菜单一致）
    const themeMenu = this._xul(doc, "menu");
    themeMenu.id = "papilot-menu-themes";
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
  },

  _buildClassicItemMenu(doc, popup) {
    this._menuItem(doc, popup, "papilot-itemmenu-hub", "menuHub",
      () => Zotero.Papilot.openHub());
    // 0.31.0 AI 问答悬浮窗（与 grouped 模式顶层直达同一功能的两处入口）
    this._menuItem(doc, popup, "papilot-itemmenu-ai-chat", "menuAiChat",
      () => Menus.openChatFloat());
    // 0.21.0 多篇 PDF 并排对比（需选中 ≥2 篇带 PDF 的文献）
    this._menuItem(doc, popup, "papilot-itemmenu-pdf-compare", "menuPdfCompare",
      () => PdfCompare.runForSelected());
    popup.appendChild(this._xul(doc, "menuseparator"));
    this._menuItem(doc, popup, "papilot-itemmenu-ai-summary", "menuAiSummary",
      () => this.aiTaskForSelected((it) => AIChat.summarize(it), "noteSummaryTitle"));
    this._menuItem(doc, popup, "papilot-itemmenu-ai-translate", "menuAiTranslate",
      () => this.aiTaskForSelected((it) => AIChat.translateTitleAbstract(it), "noteTranslateTitle"));
    this._menuItem(doc, popup, "papilot-itemmenu-ai-note", "menuAiNote",
      () => this.aiTaskForSelected((it) => AIChat.interpret(it), "noteTitle"));
    popup.appendChild(this._xul(doc, "menuseparator"));
    this._menuItem(doc, popup, "papilot-itemmenu-collect-annot", "menuCollectAnnot",
      () => this.annotationTask(false));
    this._menuItem(doc, popup, "papilot-itemmenu-ai-annot", "menuAiAnnot",
      () => this.annotationTask(true));
    popup.appendChild(this._xul(doc, "menuseparator"));
    this._menuItem(doc, popup, "papilot-itemmenu-ai-tag", "menuAiTag",
      () => AutoTag.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-rule-tag", "menuRuleTag",
      () => RuleTag.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-matrix", "menuMatrix",
      () => Matrix.forSelected());
    popup.appendChild(this._xul(doc, "menuseparator"));
    this._menuItem(doc, popup, "papilot-itemmenu-s2-refresh", "menuS2Refresh",
      () => CitationColumn.refreshForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-cite-trace", "menuCiteTrace",
      () => CitationTrace.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-ref-import", "menuRefImport",
      () => RefImport.openDialog());
    popup.appendChild(this._xul(doc, "menuseparator"));
    this._menuItem(doc, popup, "papilot-itemmenu-meta-enrich", "menuMetaEnrich",
      () => MetaEnrich.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-fake-check", "menuFakeCheck",
      () => FakeCheck.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-paste-check", "menuPasteCheck",
      () => FakeCheck.openPasteDialog());
    this._menuItem(doc, popup, "papilot-itemmenu-smart-cleanup", "menuSmartCleanup",
      () => SmartCleanup.run());
    // ---- 0.11.0 新增 ----
    popup.appendChild(this._xul(doc, "menuseparator"));
    // 0.25.2 引入双栏出口；0.36.0 主入口改为「左原 PDF / 右译文」的对照窗口；
    // 0.42.0 旧「文本双栏窗口」入口下线（功能中心仍可达）
    this._menuItem(doc, popup, "papilot-itemmenu-bilingual-view", "menuPdfDual",
      () => PdfDual.openForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-review", "menuReview",
      () => ReviewGen.forSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-mindmap", "menuMindmap",
      () => MindMap.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-note-template", "menuNoteTemplate",
      () => NoteTemplates.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-anki", "menuAnki",
      () => AnkiExport.runForSelected());
    popup.appendChild(this._xul(doc, "menuseparator"));
    this._menuItem(doc, popup, "papilot-itemmenu-cn-meta", "menuCnMeta",
      () => CNMeta.runForSelected());
    // ---- 0.14.5 中文工具组（茉莉花同等能力）----
    this._menuItem(doc, popup, "papilot-itemmenu-cn-fetch", "menuCnFetch",
      () => CNFetch.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-cn-match-att", "menuCnMatchAtt",
      () => CNFetch.matchAttachmentsFromDownloads());
    this._menuItem(doc, popup, "papilot-itemmenu-cn-name-merge", "menuCnNameMerge",
      () => CNFetch.mergeNames());
    this._menuItem(doc, popup, "papilot-itemmenu-cn-name-split", "menuCnNameSplit",
      () => CNFetch.splitNames());
    this._menuItem(doc, popup, "papilot-itemmenu-meta-lint", "menuMetaLint",
      () => MetaLint.runForSelected());
    // 0.52.0 元数据医生（Crossref 补全，写操作走确认 + 审计可撤销）
    this._menuItem(doc, popup, "papilot-itemmenu-meta-doctor", "menuMetaDoctor",
      () => MetaDoctor.run());
    // 0.53.0 综述工作台（多篇 → 大纲 → 分节草稿）
    this._menuItem(doc, popup, "papilot-itemmenu-review-wb", "menuReviewWorkbench", () => {
      if (!Prefs.get("reviewWorkbenchEnabled", true)) {
        Services.prompt.alert(null, "Papilot", I18n.t("menuReviewWorkbenchDisabled"));
        return;
      }
      ReviewWorkbench.openDialog();
    });
    // 0.52.0 标注→论点速记（AI；未配置 Key 时先指引）
    this._menuItem(doc, popup, "papilot-itemmenu-annot-digest", "menuAnnotDigest", () => {
      if (!Prefs.get("annotationDigestEnabled", true)) {
        Services.prompt.alert(null, "Papilot", I18n.t("menuAnnotDigestDisabled"));
        return;
      }
      if (!AIClient.hasKey()) {
        Services.prompt.alert(null, "Papilot", AIClient.guidance() || I18n.t("chatNoKey"));
        return;
      }
      AnnotationDigest.run();
    });
    this._menuItem(doc, popup, "papilot-itemmenu-oa-fetch", "menuOaFetch",
      () => OAFetch.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-attach-rename", "menuAttachRename",
      () => AttachManager.runForSelected());
    // ---- 0.22.0 库健康/治理增强 ----
    this._menuItem(doc, popup, "papilot-itemmenu-attach-doctor", "menuAttachDoctor",
      () => AttachDoctor.run());
    this._menuItem(doc, popup, "papilot-itemmenu-tag-curator", "menuTagCurator",
      () => TagCurator.run(false));
    this._menuItem(doc, popup, "papilot-itemmenu-tag-normalize", "menuTagNormalize",
      () => TagCurator.run(true));
    // 0.42.0 嵌套标签树（只读视图窗口）
    this._menuItem(doc, popup, "papilot-itemmenu-tag-nested", "menuTagNested",
      () => TagCurator.openNestedView());
    // ---- 0.24.0 元数据体检（规则补齐）----
    this._menuItem(doc, popup, "papilot-itemmenu-meta-rules", "menuMetaRules",
      () => MetaRules.openDialog());
    // ---- 0.23.0 自动化与入库自动精读 ----
    this._menuItem(doc, popup, "papilot-itemmenu-automation", "menuAutomationRun",
      () => Automation.runForSelected());
    this._menuItem(doc, popup, "papilot-itemmenu-auto-read", "menuAutoReadNow",
      () => AutoRead.runForSelected());
    // 0.42.0 自动化用户规则动态项（勾选「出现在条目右键菜单」的）
    this._automationRuleItems(doc, popup);
    popup.appendChild(this._xul(doc, "menuseparator"));
    this._menuItem(doc, popup, "papilot-itemmenu-state-unread", "menuStateUnread",
      () => ReadingState.markForSelected("未读"));
    this._menuItem(doc, popup, "papilot-itemmenu-state-reading", "menuStateReading",
      () => ReadingState.markForSelected("在读"));
    this._menuItem(doc, popup, "papilot-itemmenu-state-done", "menuStateDone",
      () => ReadingState.markForSelected("已读"));
    // 0.46.0 与 grouped 模式对齐：状态区尾部的重置入口
    this._menuItem(doc, popup, "papilot-itemmenu-progress-reset", "menuResetProgress",
      () => Menus.resetProgressForSelected());
    popup.appendChild(this._xul(doc, "menuseparator"));
    // 0.42.0 星标评级
    this._menuItem(doc, popup, "papilot-itemmenu-rating-1", "menuRating1", () => this.setRatingForSelected(1));
    this._menuItem(doc, popup, "papilot-itemmenu-rating-2", "menuRating2", () => this.setRatingForSelected(2));
    this._menuItem(doc, popup, "papilot-itemmenu-rating-3", "menuRating3", () => this.setRatingForSelected(3));
    this._menuItem(doc, popup, "papilot-itemmenu-rating-4", "menuRating4", () => this.setRatingForSelected(4));
    this._menuItem(doc, popup, "papilot-itemmenu-rating-5", "menuRating5", () => this.setRatingForSelected(5));
    this._menuItem(doc, popup, "papilot-itemmenu-rating-clear", "menuRatingClear", () => this.setRatingForSelected(0));
  },

  /* ---------- 菜单定制 pref 的读取与观察 ---------- */

  _hiddenGroups() {
    const raw = String(Prefs.get("menuHiddenGroups", "") || "");
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  },

  /** 高频直达项（≤3，去重，过滤非法 id；state/rating 组与顶层直达项不可作直达） */
  _quickItems() {
    const raw = String(Prefs.get("menuQuickItems", "ai-summary,bilingual-view") || "");
    const seen = new Set();
    const out = [];
    for (const id of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (out.length >= 3) break;
      const item = this.ITEM_REGISTRY.find((i) => i.id === id && i.group && i.group !== "state" && i.group !== "rating");
      if (item && !seen.has(id)) { seen.add(id); out.push(item); }
    }
    return out;
  },

  _watchMenuPrefs() {
    // 与 main.js _watchPrefs 同款：Zotero.Prefs.registerObserver 按完整 key 注册，
    // 沙箱普通对象挂不上 nsIPrefBranch 弱引用 observer（FF140 实证）。
    this._observers = ["menuMode", "menuHiddenGroups", "menuQuickItems", "automationRules"].map((key) =>
      Zotero.Prefs.registerObserver(Prefs.PREFIX + key, () => {
        try {
          this.destroy();
          this.init(this._rootURI);
        } catch (e) { Zotero.logError(e); }
      }, true)
    );
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
            Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
              I18n.t("channelSwitchBlocked") + "：" + r.error);
            return;
          }
          const pw = new Zotero.ProgressWindow({ closeOnClick: true });
          pw.changeHeadline("Papilot");
          const prog = new pw.ItemProgress(
            "chrome://papilot/content/icons/chat.svg",
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

  /**
   * 0.31.0 AI 问答悬浮窗入口：锁定为右键选中的条目并唤起。
   * 显式 setSessionItem（不走 ChatFloat.toggle 的条目解析——
   * 用户在条目 B 上右键，即使 reader 开着别的文献也要就 B 对话）。
   */
  openChatFloat() {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return;
      const zp = Zotero.getActiveZoteroPane();
      if (zp) {
        const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
        if (items.length) ChatFloat.setSessionItem(items[0]);
      }
      ChatFloat.show(win);
    } catch (e) {
      Zotero.logError(e);
    }
  },

  /** 打开 Zotero 设置中的 Papilot 窗格 */
  openSettings() {
    try {
      // openPreferences 收 paneID 不是 pluginID（Z10 navigateToPane 按 pane id 查找，
      // 传 pluginID 会落在常规窗格）；用 register 时存的稳定 paneID
      const paneID = (Zotero.Papilot && Zotero.Papilot._paneID) || "papilot-prefs";
      Zotero.Utilities.Internal.openPreferences(paneID);
    } catch (e) {
      Zotero.logError(new Error("Papilot: 打开设置窗格失败"));
      Zotero.logError(e);
    }
  },

  /** 工具菜单：接口连通性测试，结果弹窗展示 */
  async testConnection() {
    const win = Zotero.getMainWindow();
    if (!AIClient.hasKey()) {
      Services.prompt.alert(win, "Papilot", AIClient.guidance() || I18n.t("chatNoKey"));
      return;
    }
    try {
      const reply = await AIClient.chat([
        { role: "user", content: "用一句话回答：接口连通正常" },
      ]);
      Services.prompt.alert(win, "Papilot",
        `${I18n.t("connOk")}\n\nBase URL：${AIClient.baseUrl()}\n` +
        `模型：${AIClient.model()}\n回复：${String(reply).slice(0, 200)}`);
    } catch (e) {
      Services.prompt.alert(win, "Papilot",
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
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        AIClient.guidance() || I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    pw.show();

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
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
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        AIClient.guidance() || I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    pw.show();

    for (const item of items) {
      const progress = new pw.ItemProgress(
        "chrome://papilot/content/icons/chat.svg",
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
    for (const id of this._observers) {
      try { Zotero.Prefs.unregisterObserver(id); } catch (e) { /* ignore */ }
    }
    this._observers = [];
  },
};
