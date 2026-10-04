/* PaperPilot 核心工具：pref 读写 + 简易 i18n + Markdown→笔记 HTML + 笔记助手 + 选中归一化 */
/* global Zotero, Services */

var Prefs = {
  PREFIX: "extensions.zotero.paperpilot.",

  get(key, fallback) {
    try {
      const v = Zotero.Prefs.get(this.PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  },

  set(key, value) {
    Zotero.Prefs.set(this.PREFIX + key, value, true);
  },
};

// 轻量 i18n：按 Zotero 界面语言选择文案（菜单等无法走 ftl 的地方用）
var I18n = (() => {
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const table = {
    menuSettings: zh ? "PaperPilot 设置" : "PaperPilot Settings",
    menuConnTest: zh ? "PaperPilot 接口连通性测试" : "PaperPilot Connection Test",
    menuAiNote: zh ? "AI 深度解读所选文献（生成笔记）" : "AI Deep Interpretation (note)",
    menuAiSummary: zh ? "AI 总结（生成笔记）" : "AI Summary (note)",
    menuAiTranslate: zh ? "AI 翻译标题与摘要（生成笔记）" : "AI Translate Title & Abstract (note)",
    connOk: zh ? "✅ 接口连通正常" : "✅ Connection OK",
    connFail: zh ? "❌ 接口测试失败" : "❌ Connection failed",
    quickSummary: zh ? "总结本篇" : "Summarize",
    quickTranslate: zh ? "翻译摘要" : "Translate abstract",
    noteSummaryTitle: zh ? "AI 文献总结" : "AI Summary",
    noteTranslateTitle: zh ? "AI 翻译（标题与摘要）" : "AI Translation (Title & Abstract)",
    menuAiTag: zh ? "AI 自动打标签…" : "AI Auto Tag…",
    menuMatrix: zh ? "AI 文献矩阵（对比表格笔记）" : "AI Literature Matrix (note)",
    menuCollectAnnot: zh ? "收集批注为笔记" : "Collect Annotations to Note",
    menuAiAnnot: zh ? "AI 解读我的批注（生成笔记）" : "AI Interpret My Annotations (note)",
    menuCollStat: zh ? "PaperPilot 分类条目统计" : "PaperPilot Collection Stats",
    noteAnnotTitle: zh ? "批注收集" : "Annotations",
    noteAnnotAiTitle: zh ? "AI 批注解读" : "AI Annotation Insights",
    noteMatrixTitle: zh ? "AI 文献矩阵" : "AI Literature Matrix",
    annotEmpty: zh ? "该条目没有高亮或批注" : "No annotations on this item",
    matrixBusy: zh ? "正在逐篇抽取维度…" : "Extracting dimensions…",
    popupTranslate: zh ? "翻译" : "Translate",
    popupExplain: zh ? "解读" : "Explain",
    popupAsk: zh ? "追问…" : "Ask…",
    popupAskPlaceholder: zh ? "就这段文字继续提问…" : "Ask about this excerpt…",
    popupSend: zh ? "发送" : "Send",
    popupCopy: zh ? "复制" : "Copy",
    popupCopied: zh ? "✓ 已复制" : "✓ Copied",
    popupRetry: zh ? "重试" : "Retry",
    popupWriteBack: zh ? "写入批注" : "Add to annotation",
    popupWriteBackDone: zh ? "✓ 已写入批注" : "✓ Added to annotation",
    popupWriteBackFail: zh ? "写入批注失败：" : "Failed to add to annotation: ",
    popupContinuePane: zh ? "在侧栏继续" : "Continue in sidebar",
    popupPaneUnavailable: zh
      ? "请先在右侧栏打开「AI 问答」面板"
      : "Open the AI Chat section in the sidebar first",
    popupDailyNotice: zh
      ? "提示：今日 AI 请求已达 500 次，请注意额度"
      : "Note: 500 AI requests today — watch your quota",
    // ---- 0.15.0 划词浮窗交互升级 ----
    popupStop: zh ? "停止" : "Stop",
    popupBusyHint: zh ? "生成中…（点「停止」可取消）" : "Generating… (click Stop to cancel)",
    popupExpand: zh ? "展开" : "Expand",
    popupCollapse: zh ? "收起" : "Collapse",
    popupZoomIn: zh ? "放大结果字号" : "Larger result text",
    popupZoomOut: zh ? "缩小结果字号" : "Smaller result text",
    promptRun: zh ? "执行" : "Run",
    tagApplyDone: zh ? "已写入标签" : "Tags applied",
    chatPlaceholder: zh ? "针对这篇文献提问…" : "Ask about this paper…",
    chatSend: zh ? "发送" : "Send",
    chatClear: zh ? "清空" : "Clear",
    chatSave: zh ? "存为笔记" : "Save as note",
    chatSaved: zh ? "已保存为笔记" : "Saved as note",
    chatEmptyHistory: zh ? "还没有可保存的对话" : "Nothing to save yet",
    chatNoKey: zh
      ? "请先在 编辑 → 设置 → PaperPilot 中登录账号（官方模型免费），或在「AI 模型通道」中配置自己的接口"
      : "Log in under Edit → Settings → PaperPilot (official model is free), or configure your own channel",
    chatNoPdf: zh
      ? "该条目没有可读取的 PDF 全文（扫描件请先 OCR）"
      : "No readable PDF full text (OCR scanned PDFs first)",
    chatReading: zh ? "正在读取 PDF 全文…" : "Reading PDF full text…",
    chatThinking: zh ? "AI 思考中…" : "AI is thinking…",
    chatEmpty: zh ? "选中一篇带 PDF 的文献，然后开始提问。" : "Select an item with a PDF and ask away.",
    chatNoItem: zh ? "当前没有选中文献" : "No item selected",
    noteTitle: zh ? "AI 文献解读" : "AI Interpretation",
    noteChatTitle: zh ? "AI 问答记录" : "AI Q&A",
    noteDone: zh ? "已生成解读笔记" : "Note created",
    rankColumnLabel: zh ? "期刊分区" : "Journal Rank",
    citationColumnLabel: zh ? "被引量" : "Citations",
    menuS2Refresh: zh ? "重新抓取被引量（Semantic Scholar）" : "Refresh Citations (Semantic Scholar)",
    menuRuleTag: zh ? "规则打标（按自定义规则）" : "Rule-based Tagging",
    menuCiteTrace: zh ? "引文追溯（参考文献/施引文献笔记）" : "Citation Trace (note)",
    menuFakeCheck: zh ? "真假文献识别（AI 幻觉检测）" : "Fake Reference Check",
    menuSmartCleanup: zh ? "智能清理（重复/无附件/缺元数据扫描）" : "Smart Cleanup Scan",
    menuMetaEnrich: zh ? "元数据补全（S2/Crossref 回写缺失字段）" : "Fill Missing Metadata (S2)",
    menuRefImport: zh ? "参考文献一键入库…" : "Import References…",
    menuPasteCheck: zh ? "粘贴文献列表核验（AI 幻觉检测）…" : "Verify Pasted References…",
    menuWorkbench: zh ? "PaperPilot 工作台（独立窗口）" : "PaperPilot Workbench (standalone window)",
    menuChannels: zh ? "PaperPilot AI 模型通道" : "PaperPilot AI Channels",
    menuChannelsEmpty: zh ? "（暂无通道，在设置中新增）" : "(No channels — add in Settings)",
    channelSwitched: zh ? "已切换 AI 通道" : "AI channel switched",
    channelSwitchBlocked: zh ? "无法切换" : "Cannot switch",
    errPrefix: zh ? "出错：" : "Error: ",
    // ---- 0.11.0 新增 ----
    menuHub: zh ? "PaperPilot 功能中心" : "PaperPilot Feature Hub",
    menuBilingual: zh ? "全文对照翻译（AI 双语笔记）" : "Bilingual Full-text Translation (note)",
    noteBilingualTitle: zh ? "全文对照翻译" : "Bilingual Translation",
    menuCnMeta: zh ? "中文文件名识别元数据（知网/万方）" : "Parse Chinese Filename Metadata",
    menuCnFetch: zh ? "抓取中文元数据（网络搜索知网等）" : "Fetch CN Metadata (PubScholar/CNKI)",
    menuCnTranslators: zh ? "更新中文转换器（修复知网抓取）" : "Update CN Translators (fix CNKI)",
    menuCNVerify: zh ? "知网验证（解除风控拦截）" : "CNKI Verification (unblock)",
    menuCnMatchAtt: zh ? "在下载文件夹中查找附件" : "Find Attachments in Downloads",
    menuCnNameMerge: zh ? "合并中文姓名（两栏→单栏）" : "Merge CN Names (to single field)",
    menuCnNameSplit: zh ? "拆分中文姓名（单栏→姓+名）" : "Split CN Names (to two fields)",
    menuReadingState: zh ? "阅读状态" : "Reading State",
    menuStateUnread: zh ? "标记为「未读」" : "Mark as Unread",
    menuStateReading: zh ? "标记为「在读」" : "Mark as Reading",
    menuStateDone: zh ? "标记为「已读」" : "Mark as Done",
    menuNoteTemplate: zh ? "按模板新建笔记…" : "New Note from Template…",
    menuAttachRename: zh ? "附件按规则重命名" : "Rename Attachments by Pattern",
    menuMindmap: zh ? "AI 思维导图（大纲笔记）" : "AI Mind Map (outline note)",
    noteMindmapTitle: zh ? "思维导图" : "Mind Map",
    menuReview: zh ? "AI 文献综述（多篇，带引用）" : "AI Literature Review (multi)",
    noteReviewTitle: zh ? "AI 文献综述" : "AI Literature Review",
    menuMetaLint: zh ? "元数据规范清洗（DOI/日期/标题/URL）" : "Metadata Lint",
    menuOaFetch: zh ? "开放获取补全文（Unpaywall）" : "Find OA Full Text (Unpaywall)",
    menuAnki: zh ? "AI 制卡导出 Anki…" : "AI Cards to Anki…",
    menuLibGraph: zh ? "PaperPilot 文献统计图谱（HTML 报告）" : "PaperPilot Library Report (HTML)",
    // 0.16.0 外观主题
    menuThemes: zh ? "外观主题" : "Appearance Themes",
    menuUiTheme: zh ? "界面主题" : "UI Theme",
    menuPdfTheme: zh ? "PDF 阅读主题" : "PDF Reading Theme",
    themeFollowNative: zh ? "跟随 Zotero 原生" : "Follow Zotero native",
    themeGroupStandard: zh ? "标准系列" : "Standard",
    themeGroupAnime: zh ? "动漫风" : "Anime",
    themeGroupScenery: zh ? "风景" : "Scenery",
    themeGroupDynamic: zh ? "动态壁纸" : "Animated",
    themeCustom: zh ? "自定义主题" : "Custom theme",
    themeGroupGiant: zh ? "巨物风" : "Giant",
    // ---- 0.25.0 统一主题切换按钮（阅读器工具栏 + 主窗口左上角，两处同源）----
    themeButtonTip: zh ? "PaperPilot 主题（界面 + 阅读页）" : "PaperPilot themes (UI + reading)",
    themeOpenSettings: zh
      ? "外观主题设置…（自定义配色 / 壁纸）"
      : "Appearance theme settings… (custom colors / wallpaper)",
    // ---- 0.21.0 多篇 PDF 并排对比 ----
    menuPdfCompare: zh ? "多篇 PDF 并排对比…" : "Compare PDFs Side by Side…",
    compareWindowTitle: zh ? "PaperPilot 多篇 PDF 对比" : "PaperPilot PDF Comparison",
    compareNoPdf: zh
      ? "选中的条目里没有可用的 PDF 附件。\n请选中带 PDF 的文献，或直接选中 PDF 附件。"
      : "No usable PDF attachments in the selection.",
    compareNeedTwo: zh
      ? "对比至少需要两篇带 PDF 的文献。\n请按住 Ctrl/⌘ 多选后再试。"
      : "Select at least two papers with PDFs (Ctrl/⌘-click).",
    compareTrimmed: zh
      ? "已选 %n 篇，超过同时打开的 %m 篇上限，只打开前 %m 篇。\n（上限可在设置 → PaperPilot 中调整）"
      : "Selected %n; the limit is %m, so the first %m were opened.",
    compareCount: zh ? "对比面板：%n / %m" : "Panes: %n / %m",
    compareLayout: zh ? "布局" : "Layout",
    compareLayoutAuto: zh ? "自动（按篇数）" : "Auto (by count)",
    compareLayoutH: zh ? "横向并排" : "Side by side",
    compareLayoutV: zh ? "纵向堆叠" : "Stacked",
    compareLayoutGrid: zh ? "网格 2×2" : "Grid 2×2",
    compareSyncScroll: zh ? "同步滚动" : "Sync scroll",
    compareSyncZoom: zh ? "同步缩放" : "Sync zoom",
    compareZoomIn: zh ? "放大当前面板（同步缩放开启时作用于全部面板）" : "Zoom in",
    compareZoomOut: zh ? "缩小当前面板（同步缩放开启时作用于全部面板）" : "Zoom out",
    compareZoomFit: zh ? "适合宽度" : "Fit width",
    compareAddSelected: zh ? "添加选中文献" : "Add selected",
    compareAddSelectedHint: zh
      ? "把条目列表中当前选中的 PDF 追加到对比窗口"
      : "Append the PDFs currently selected in the item list",
    compareReadingSelection: zh ? "正在读取条目列表的选中项…" : "Reading selection…",
    compareNoSelectionPdf: zh ? "条目列表的当前选中项里没有 PDF" : "No PDF in the current selection",
    compareAdded: zh ? "已添加 %n 篇" : "Added %n",
    compareNothingAdded: zh ? "没有新增面板（可能已存在或已达上限）" : "Nothing added",
    compareEmptyHint: zh
      ? "没有待对比的 PDF。请先在条目列表中选中 2–4 篇带 PDF 的文献，再用「添加选中文献」。"
      : "No PDFs yet. Select 2–4 papers in the item list, then use “Add selected”.",
    compareLoading: zh ? "正在加载 PDF…" : "Loading PDF…",
    compareLoadFailed: zh ? "PDF 加载失败：" : "Failed to load PDF: ",
    compareViewUnavailable: zh
      ? "无法访问该 PDF 视图（Zotero 版本可能已变更内嵌方式）"
      : "Cannot access the PDF view (Zotero internals may have changed)",
    compareApiUnavailable: zh
      ? "当前 Zotero 版本不提供内嵌预览接口（需要 Zotero 7 及以上）"
      : "This Zotero version provides no embedded preview API (Zotero 7+ required)",
    compareOpenInReader: zh ? "在阅读器中打开" : "Open in reader",
    compareOpenInReaderHint: zh
      ? "跳到正式阅读器：可新增高亮/批注、可划词（对比面板本身是只读预览）"
      : "Open in the full reader to annotate and select text (panes are read-only previews)",
    compareRemove: zh ? "移除该面板" : "Remove pane",
    compareUnnamed: zh ? "（未命名 PDF）" : "(untitled PDF)",
    compareLimitReached: zh ? "最多同时对比 %n 篇（可在设置中调整上限）" : "Up to %n panes",
    compareDuplicated: zh ? "该 PDF 已在对比窗口中" : "That PDF is already in the window",
    compareNoFocus: zh ? "请先点击一个面板再缩放" : "Click a pane first, then zoom",
    // ---- 0.21.3 对比窗口：页码导航 / 按页码同步 / 页面文本 ----
    comparePrevPage: zh ? "上一页" : "Previous page",
    compareNextPage: zh ? "下一页" : "Next page",
    compareJumpPageHint: zh ? "输入页码后回车跳转" : "Type a page number and press Enter",
    compareNotReady: zh ? "该面板还没加载完成" : "This pane is not ready yet",
    compareAlign: zh ? "对齐到当前页" : "Align to page",
    compareAlignHint: zh
      ? "让所有面板跳到当前面板所在的页码（对比同一篇论文的不同版本时最有用）"
      : "Jump every pane to the current pane's page",
    compareAligned: zh ? "已对齐到第 %n 页（%c 个面板）" : "Aligned to page %n (%c panes)",
    compareZoom100: zh ? "全部恢复 100%" : "Reset all to 100%",
    compareCopyPage: zh ? "复制本页文本" : "Copy page text",
    compareCopyPageHint: zh
      ? "取当前面板当前页的文字到剪贴板（预览无文本层，不能用鼠标选字，故提供此按钮）"
      : "Copy the current page's text (preview has no text layer, so selection is unavailable)",
    compareExtracting: zh ? "正在提取文字…" : "Extracting text…",
    comparePageTextEmpty: zh ? "本页没有可提取的文字（可能是扫描件，需先 OCR）" : "No extractable text on this page (scanned PDF? OCR it first)",
    comparePageTextTitle: zh ? "第 %p 页文本 ／ 共 %t 页" : "Page %p of %t — text",
    comparePageTextCopied: zh ? "已复制 %n 个字符" : "Copied %n characters",
    compareTranslatePage: zh ? "翻译本页" : "Translate page",
    compareTranslatePageHint: zh
      ? "把当前面板当前页的文字交给 AI 翻译，结果在下方对照区显示"
      : "Translate the current page with AI; the result shows below",
    compareTranslateTitle: zh ? "第 %p 页译文 ／ 共 %t 页" : "Page %p of %t — translation",
    compareTranslating: zh ? "正在翻译本页…" : "Translating page…",
    compareTruncated: zh ? "（本页文字较长，已截断前 6000 字）" : " (page text was truncated to 6000 chars)",
    compareClose: zh ? "关闭" : "Close",
    // ---- 0.21.0 划词浮窗：AI 未就绪不再静默（此前连按钮都不出现）----
    popupNoAi: zh
      ? "AI 不可用：未登录官方模型且未配置自己的模型通道。"
      : "AI unavailable: not logged in and no custom channel configured.",
    popupGoLogin: zh ? "去登录 / 配置" : "Log in / Configure",
    chatNotLoggedIn: zh
      ? "官方模型需要登录：请在 设置 → PaperPilot 登录账号（登录后免费使用），或在「AI 模型通道」中配置自己的接口"
      : "The official model requires login: open Settings → PaperPilot to log in, or configure your own channel",
    chatNoKeyConfigured: zh
      ? "当前模型通道缺少 API Key：请在 设置 → PaperPilot → AI 模型通道 中补全"
      : "The active channel has no API key — fill it in under Settings → PaperPilot → AI Channels",
    // ---- 0.22.0 库内问答 / 标签治理 / 附件体检 ----
    menuLibAsk: zh ? "库内问答（问整个文献库）…" : "Ask the Library (whole library)…",
    menuAttachDoctor: zh ? "附件体检（断链/重复/扫描件/孤儿文件）" : "Attachment Doctor (broken/dup/scanned)",
    menuTagCurator: zh ? "标签治理（扫描变体，只读）" : "Tag Curator (scan, read-only)",
    menuTagNormalize: zh ? "标签归一（执行合并，需确认）" : "Normalize Tags (merge, confirm)",
    // ---- 0.23.0 自动化引擎 / 入库自动精读 ----
    menuAutomation: zh ? "自动化规则（触发→条件→动作）…" : "Automation Rules…",
    menuAutomationRun: zh ? "按自动化规则处理所选（先预览）" : "Run Automation Rules on Selection (preview)",
    menuAutoReadNow: zh ? "立即 AI 精读所选文献" : "AI Deep-read Selected Now",
    // ---- 0.23.0 笔记关系图谱 / 阅读报告 ----
    menuNoteGraph: zh ? "笔记关系图谱…" : "Note Graph…",
    menuReadingReport: zh ? "阅读报告（生成笔记）" : "Reading Report (note)",
    // ---- 0.24.0 文献发现 / 元数据体检 / MCP 对外供给 ----
    menuDiscovery: zh ? "文献发现（arXiv 每日推荐）…" : "Discovery (arXiv Daily)…",
    menuMetaRules: zh ? "元数据体检（规则补齐）…" : "Metadata Rules (checklist)…",
    menuMcp: zh ? "MCP 对外供给（让外部 AI 调用文献库）…" : "MCP Server (expose library)…",
  };
  return {
    t(key) { return table[key] || key; },
    isZh: zh,
  };
})();

// Markdown 子集 → Zotero 笔记 HTML（标题/加粗/行内代码/无序与有序列表/段落）
var MdLite = {
  escape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  // 行内元素（输入为未转义文本）
  inline(s) {
    return this.escape(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  },

  /** Markdown 子集 → 富文本 HTML 正文（0.10.0 抽出：侧栏气泡渲染与笔记共用，
   *  语义标签不加硬编码颜色，深浅主题都安全） */
  toHtml(md) {
    const lines = String(md || "").split(/\r?\n/);
    let html = "";
    let inList = false;
    let para = [];
    let table = [];
    const flushPara = () => {
      if (para.length) { html += "<p>" + para.join("<br/>") + "</p>"; para = []; }
    };
    const closeList = () => {
      if (inList) { html += "</ul>"; inList = false; }
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l)); // 去掉分隔行
      if (rows.length) {
        html += '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;">';
        rows.forEach((l, idx) => {
          const cells = l.trim().replace(/^\||\|$/g, "").split("|");
          const tag = idx === 0 ? "th" : "td";
          html += "<tr>" + cells.map(c => `<${tag}>${this.inline(c.trim())}</${tag}>`).join("") + "</tr>";
        });
        html += "</table>";
      }
      table = [];
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const isTable = /^\s*\|.+\|\s*$/.test(line);
      if (isTable) { flushPara(); closeList(); table.push(line); continue; }
      flushTable();
      const h = line.match(/^\s*#{1,4}\s+(.+)$/);
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (h) {
        flushPara(); closeList();
        html += "<h3>" + this.inline(h[1]) + "</h3>";
      } else if (li) {
        flushPara();
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + this.inline(li[1]) + "</li>";
      } else if (!line.trim()) {
        flushPara(); closeList();
      } else if (/^\s*>/.test(line)) {
        flushPara(); closeList();
        html += "<blockquote>" + this.inline(line.replace(/^\s*>\s?/, "")) + "</blockquote>";
      } else if (/^\s*---+\s*$/.test(line)) {
        flushPara(); closeList();
        html += "<hr/>";
      } else {
        closeList();
        para.push(this.inline(line));
      }
    }
    flushTable();
    flushPara(); closeList();
    return html;
  },

  toNoteHtml(title, md) {
    return "<h2>" + this.escape(title) + "</h2>" + this.toHtml(md);
  },
};

// 笔记助手：常规条目挂到条目下，附件挂到其父条目下
var Notes = {
  async createFromMarkdown(item, title, md) {
    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    if (item.isRegularItem && item.isRegularItem()) {
      note.parentID = item.id;
    } else if (item.parentID) {
      note.parentID = item.parentID;
    }
    note.setNote(MdLite.toNoteHtml(title, md));
    await note.saveTx();
    return note;
  },
};

// 选中条目归一化（0.8.1）：PDF/附件自动上溯到父条目，去重。
// 背景：用户选中 PDF 附件再点 AI 功能时，旧代码 isRegularItem 过滤后列表为空，
// 静默无反应，看起来就像"功能坏了"。
var ItemSel = {
  regularOnly(items) {
    const out = [];
    for (const i of items || []) {
      try {
        if (i.isRegularItem && i.isRegularItem()) { out.push(i); continue; }
        if (i.isAttachment && i.isAttachment() && i.parentID) {
          const p = Zotero.Items.get(i.parentID);
          if (p && p.isRegularItem && p.isRegularItem()) out.push(p);
        }
      } catch (e) { /* ignore */ }
    }
    return [...new Set(out)];
  },

  /** 空选择时给用户明确反馈（各 runForSelected 统一调用） */
  alertEmpty() {
    try {
      Services.prompt.alert(
        Zotero.getMainWindow(),
        "PaperPilot",
        I18n.isZh
          ? "没有可处理的条目。\n请先在条目列表中选中至少一篇文献（选 PDF 附件也可以，会自动定位到其父条目）。"
          : "No processable items. Select at least one item first (selecting a PDF attachment works too — its parent item is used)."
      );
    } catch (e) { /* ignore */ }
  },
};
