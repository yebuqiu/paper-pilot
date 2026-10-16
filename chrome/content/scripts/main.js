/* PaperPilot 主入口：装配各模块
 * 由 bootstrap.js 通过 Services.scriptloader 加载，共享 bootstrap 作用域
 */
/* global Zotero, Services, Prefs, RankColumn, CitationColumn, S2Client, AIChatPane, GlancePane, TranslatePane, Menus, ReaderPopup, AIProviders, Account, Channels, AIClient, AIChat, RuleTag, CitationTrace, RefFormat, RefSources, RefImport, FakeCheck, SmartCleanup, MetaEnrich, ReadingState, AutoTag, Matrix, Annotations, CollectionStats, BilingualTranslate, CNMeta, CNTranslators, CNFetch, CNVerify, NoteTemplates, AttachManager, MindMap, ReviewGen, MetaLint, OAFetch, SciHub, AnkiExport, LibGraph, Prompts, UiTheme, PdfTheme, ThemeToggle, PdfCompare, TagCurator, AttachDoctor, LibSearch, Automation, AutoRead, NoteGraph, ReadingStats, MetaRules, Discovery, MCP, ArxivErrors, ArxivDates, ArxivQuery, ArxivCategories, ArxivAtom, ArxivAnalyze, ArxivRateLimiter, ArxivFetch, TranslateSvc, CommandTags, SlashCommands, Hotkeys, RefPane, TranslateX, Rating, TitleTranslationColumn, ProgressColumn, RatingColumn, FullTextResolver, TranslateCompare, _ppDiag */

Zotero.PaperPilot = {
  id: null,
  version: null,
  rootURI: null,
  _initialized: false,
  _prefObserverSymbols: null,
  _paneID: null,

  _diag(msg) {
    try { _ppDiag(msg); } catch (e) { /* bootstrap 未提供则忽略 */ }
  },

  /**
   * 0.24.4 会员到期提醒：临近到期（≤1 天）或已过期时，启动后提示一次。
   * 「同一个到期周期只提示一次」用 pref renewPromptShownFor=<expiresAt> 记住 ——
   * 否则每次启动都弹，会变成骚扰。主窗口还没就绪时**不落标记**，留给下次。
   */
  async _checkRenewal() {
    try {
      if (!Account.isLoggedIn || !Account.isLoggedIn()) return;
      const rem = Account.renewalReminder && Account.renewalReminder();
      if (!rem || rem.daysLeft > 1) return;
      if (String(Prefs.get("renewPromptShownFor", "") || "") === rem.key) return;
      const win = Zotero.getMainWindow();
      if (!win) { this._diag("renewal reminder deferred (no main window)"); return; }
      Prefs.set("renewPromptShownFor", rem.key);
      const when = new Date(rem.expiresAt).toLocaleDateString();
      const msg = rem.expired
        ? "你的 PaperPilot 专业版已于 " + when + " 到期，已回落为免费版。\n\n"
          + "打开「设置 → PaperPilot」可立即续费（时长叠加，不浪费剩余时间）。"
        : "你的 PaperPilot 专业版仅剩 " + rem.daysLeft + " 天（" + when + " 到期）。\n\n"
          + "打开「设置 → PaperPilot」可提前续费（时长叠加，不浪费剩余时间）。";
      Services.prompt.alert(win, "PaperPilot 会员提醒", msg);
      this._diag("renewal reminder shown (daysLeft=" + rem.daysLeft + ")");
    } catch (e) {
      this._diag("renewal reminder FAILED: " + (e && (e.stack || e.message) || e));
    }
  },

  async init({ id, version, rootURI }) {
    if (this._initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    // 按依赖顺序加载子模块（共享同一全局作用域，var 声明互相可见）
    const files = [
      "core/utils.js",
      "ai/providers.js",
      "ai/account.js",
      "ai/channels.js",
      "ai/client.js",
      // 0.33.0 PDF 文本结构化分析：段落块 / 公式与图注识别 / 垃圾行过滤 / 阅读器逐页取文。
      // 必须排在 translate.js 与 bilingual-translate.js 之前（对照翻译消费它）
      "ai/pdf-text.js",
      // 0.28.0 多引擎翻译：注册表 + 统一调用层（独立于 AI 大模型）
      // 须排在 client.js 之后（llm 引擎要调 AIClient）、chat.js 与各 features 之前
      "ai/translate.js",
      // 0.42.0 标题/摘要译文写回（extra 行级 upsert 纯函数；须在 chat.js 之前，chat 翻译任务消费它）
      "ai/translate-writeback.js",
      "ai/chat.js",
      "ai/prompts.js",
      // 0.42.0 #命令标签（Prompt 标签升级版：可编辑/trigger 正则/导入导出）与 / 命令面板。
      // 须在 prompts.js 之后（内置默认标签来源）、chat-float.js 与 workbench 之前
      "ai/command-tags.js",
      "ai/slash-commands.js",
      "ai/auto-tag.js",
      "ai/matrix.js",
      "ai/semantic-scholar.js",
      "features/annotations.js",
      "features/collection-stats.js",
      "features/reader-popup.js",
      "features/pdf-compare.js",
      "features/rule-tag.js",
      "features/citation-trace.js",
      // 0.33.0 参考文献一键入库重写：格式层（纯函数）→ 多源元数据层 → 编排层。
      // 顺序即依赖顺序，不能调换：ref-import 同时消费 RefFormat 与 RefSources，
      // 而 RefSources 复用 citation-column（CitationColumn）与 arxiv 生成物（懒调用，故只需先加载）。
      "features/ref-format.js",
      "features/ref-sources.js",
      "features/ref-import.js",
      "features/fake-check.js",
      "features/smart-cleanup.js",
      "features/meta-enrich.js",
      "features/bilingual-translate.js",
      "features/cn-meta.js",
      "features/cn-translators.js",
      // 0.42.0 中文文献 AI 增强四层（L1 规划 / L3 裁决 / L4 融合 / P3 兜底）。
      // 必须排在 cn-fetch.js 之前（cn-fetch 消费 CNAI）
      "features/cn-ai.js",
      "features/cn-fetch.js",
      "features/reading-state.js",
      "features/note-templates.js",
      "features/attach-manager.js",
      "features/mindmap.js",
      "features/review-gen.js",
      "features/meta-lint.js",
      // 0.27.0 Sci-Hub / Sci-Net 补全文（Unpaywall 未命中时的补充渠道；须排在 oa-fetch 之前）
      "features/scihub.js",
      "features/oa-fetch.js",
      // 0.44.0（实验）第三方文献源（文献虫/毕业助手）：登录自检 + 入口直达（Pro 试用）
      "features/third-source.js",
      // 0.42.0 原生 Find Full Text 集成：把 Unpaywall/Sci-Hub 链注册为 Zotero 内置 findPDFs resolvers
      "features/fulltext-resolver.js",
      "features/anki-export.js",
      "features/lib-graph.js",
      // 0.22.0 库内问答 / 标签治理 / 附件体检
      "features/lib-search.js",
      "features/tag-curator.js",
      // 0.42.0 翻译多引擎同屏对比小窗（翻译面板「对比引擎」按钮调起）
      "features/translate-compare.js",
      "features/attach-doctor.js",
      // 0.23.0 自动化引擎 + 入库自动精读（阶段 2）
      "features/automation.js",
      "features/auto-read.js",
      // 0.23.0 笔记关系图谱 + 阅读行为统计（阶段 2 第二批）
      "features/note-graph.js",
      "features/reading-stats.js",
      // 0.25.0 arXiv 核心：由 scripts/build-arxiv-core.py 从 tools/arxiv/src 生成
      // （纯函数、不含 Zotero 依赖；必须按依赖序排在 discovery.js 之前。
      //  改了 tools 侧逻辑要重跑生成器，preflight 会拦住忘记生成的情况。）
      "arxiv/arxiv-errors.js",
      "arxiv/arxiv-dates.js",
      "arxiv/arxiv-query.js",
      "arxiv/arxiv-categories.js",
      "arxiv/arxiv-atom.js",
      "arxiv/arxiv-analyze.js",
      "arxiv/arxiv-rate-limiter.js",
      "arxiv/arxiv-fetch.js",
      // 0.24.0 阶段 3：元数据规则补齐 / 文献发现（arXiv 日推）/ MCP 对外供给
      "features/meta-rules.js",
      "features/discovery.js",
      "features/mcp.js",
      "features/ui-theme.js",
      "features/pdf-theme.js",
      // 0.25.1 主题切换按钮：界面主题（主窗口左上角）+ PDF 阅读主题（阅读器工具栏），二者分开
      "features/theme-toggle.js",
      // 0.38.0 顶部快捷按钮：条目工具栏一键菜单（高频直达项 + 功能中心 + 设置）
      "features/toolbar-quick.js",
      // 0.34.0 PDF 页内叠加内核：读 pdf.js textLayer 坐标 → 译文按段叠加回原页位置。
      // 依赖 ai/pdf-text.js（viewerOf/classify 单一真源）与 ai/translate.js，故排在其后。
      // 0.36.0 起它降级为**内核**（不再注入阅读器工具栏），仍被下列模块复用。
      "features/pdf-inline.js",
      // 0.36.0 PDF 对照翻译（左原右译双栏窗口）：右栏 = 同一 PDF 的 mono 译文视图，
      // 复用 PdfInline 内核做提取/翻译/注入 → 必须排在 pdf-inline.js 之后
      "features/pdf-dual.js",
      // 0.39.0 对照翻译导出（双语 PDF 附件 / HTML / Markdown / Word）：
      // 从内核 state 取段落 + 右栏 canvas 叠画 → 零依赖自建 PDF 等；排在 pdf-inline 之后
      "features/pdf-export.js",
      // 0.37.1 更新提示：Zotero 的插件更新是静默的，这里补一次可见反馈
      "features/update-notice.js",
      // 0.42.0 星标评级（★×n 单标签；评级列与右键菜单共用）
      "features/rating.js",
      "columns/rank-column.js",
      "columns/citation-column.js",
      // 0.42.0 三个新列：标题译文 / 阅读进度条 / 星标评级（rating.js 须在 rating-column 之前）
      "columns/title-translation-column.js",
      "columns/progress-column.js",
      "columns/rating-column.js",
      // 0.42.0 快捷键中央注册表（pref 驱动可自定义；须在 chat-float 之前加载并 init）
      "features/hotkeys.js",
      "panels/ai-chat-pane.js",
      "panels/glance-pane.js",
      // 0.30.0 阅读器右侧栏 · 翻译面板（划词即译 / 换引擎 / 全文对照 一处搞定）
      "panels/translate-pane.js",
      // 0.42.0 阅读器右侧栏 · 参考文献面板（自动解析当前 PDF 参考文献，+ 一键入库双向关联；
      // 消费 ref-format/ref-sources/ref-import，故排在 panels 段最后）
      "panels/ref-pane.js",
      // 0.31.0 AI 问答悬浮窗（可拖动/停靠/分屏；唤起：快捷键/阅读器按钮/右键/划词）
      "panels/chat-float.js",
      "menus.js",
    ];
    for (const f of files) {
      try {
        // ?v= 缓存破坏：与 bootstrap 同理，防止热升级时加载到旧编译缓存
        Services.scriptloader.loadSubScript(rootURI + "chrome/content/scripts/" + f + "?v=" + version);
      } catch (e) {
        // 单个模块失败不拖垮整个插件：记录后继续，功能按模块独立降级
        await this._diag("loadSubScript FAILED " + f + ": " + (e && (e.stack || e.message) || e));
      }
    }
    await this._diag("subscripts loaded");

    // 暴露给设置窗口脚本（prefs-pane.js / prefs-account.js 运行在设置窗口作用域，
    // 访问不到 bootstrap 作用域，但能访问 Zotero 全局）
    this.providers = AIProviders;
    // 0.14.0 账号系统 + 模型通道（面板与各窗口脚本经此访问）
    this.account = Account;
    this.channels = Channels;
    // 0.28.0 多引擎翻译：设置面板脚本经此访问引擎注册表与配置
    this.translateSvc = TranslateSvc;
    // 0.33.0 PDF 文本结构化分析（对照翻译消费；排障/测试经此访问）
    this.pdfText = PdfText;
    // 0.29.0 菜单瘦身：设置面板脚本经此读取菜单注册表与 i18n（单一真源，
    // 面板里的分组/直达项定制直接遍历 Menus.ITEM_REGISTRY / GROUPS 渲染）
    this.menus = Menus;
    this.i18n = I18n;
    this.rankColumn = RankColumn;
    this.citationColumn = CitationColumn;
    this.s2 = S2Client;
    this.ruleTag = RuleTag;
    this.citationTrace = CitationTrace;
    // 0.33.0 参考文献一键入库（菜单/功能中心/对话框经此访问；对话框经 windowApi 注入回调）
    this.refImport = RefImport;
    this.fakeCheck = FakeCheck;
    this.smartCleanup = SmartCleanup;
    this.metaEnrich = MetaEnrich;
    // 工作台独立窗口需要（窗口脚本访问不到 bootstrap 作用域）
    this.aiChat = AIChat;
    this.aiClient = AIClient;
    this.notes = Notes;
    this.mdLite = MdLite;
    // 0.12.0 功能中心需要：全部功能模块引用（hub 窗口脚本同样只能经这里访问）
    this.menus = Menus;
    this.autoTag = AutoTag;
    this.matrix = Matrix;
    this.annotations = Annotations;
    this.collectionStats = CollectionStats;
    this.bilingual = BilingualTranslate;
    // 0.30.0 阅读器右侧栏翻译面板（功能中心/排障经此访问）
    this.translatePane = TranslatePane;
    // 0.31.0 AI 问答悬浮窗（分屏窗口脚本经 window.arguments 的 Zotero 访问；
    // 会话与发送逻辑单源在 ChatFloat）
    this.chatFloat = ChatFloat;
    this.cnMeta = CNMeta;
    this.cnTranslators = CNTranslators;
    this.cnFetch = CNFetch;
    this.cnVerify = CNVerify;
    // 0.43.0 知网个人账号登录（静默 SM2 登录 + 滑块回退官方页自动填充；排障经此）
    this.cnAuth = CNAuth;
    this.readingState = ReadingState;
    this.noteTemplates = NoteTemplates;
    this.attachManager = AttachManager;
    this.mindmap = MindMap;
    this.reviewGen = ReviewGen;
    this.metaLint = MetaLint;
    this.oaFetch = OAFetch;
    // 0.27.0 Sci-Hub / Sci-Net 补全文（排障与设置窗口经此访问）
    this.scihub = SciHub;
    // 0.44.0（实验）第三方文献源（设置面板/菜单经此访问）
    this.thirdSource = ThirdSource;
    this.ankiExport = AnkiExport;
    this.libGraph = LibGraph;
    // 0.22.0 库内问答 / 标签治理 / 附件体检（功能中心与 lib-ask 窗口经此访问）
    this.libSearch = LibSearch;
    this.tagCurator = TagCurator;
    this.attachDoctor = AttachDoctor;
    // 0.23.0 自动化（对话框与菜单经此访问）
    this.automation = Automation;
    this.autoRead = AutoRead;
    // 0.23.0 笔记关系图谱 + 阅读统计
    this.noteGraph = NoteGraph;
    this.readingStats = ReadingStats;
    // 0.24.0 阶段 3：元数据体检 / 文献发现 / MCP
    this.metaRules = MetaRules;
    this.discovery = Discovery;
    this.mcp = MCP;
    // 0.25.0 arXiv 核心（生成物）：窗口脚本与排障经此访问
    this.arxiv = ArxivFetch;
    this.arxivCore = {
      errors: ArxivErrors,
      dates: ArxivDates,
      query: ArxivQuery,
      categories: ArxivCategories,
      atom: ArxivAtom,
      analyze: ArxivAnalyze,
      rateLimiter: ArxivRateLimiter,
    };
    // 0.13.0 工作台 2.0 需要：Prompt 技能库
    this.prompts = Prompts;
    // 0.16.0 主题系统：设置面板脚本经此访问主题库与切换接口
    this.uiTheme = UiTheme;
    this.pdfTheme = PdfTheme;
    // 0.25.1 主题切换按钮：界面主题（主窗口）+ PDF 阅读主题（阅读器）
    this.themeToggle = ThemeToggle;
    // 0.34.0/0.36.0 PDF 页内叠加内核（PdfDual 右栏经此复用；设置面板读它就绪状态）
    this.pdfInline = PdfInline;
    // 0.36.0 PDF 对照翻译（左原右译双栏窗口；菜单/工作台/功能中心/翻译面板经此调起）
    this.pdfDual = PdfDual;
    // 0.21.0 多篇 PDF 并排对比（菜单/功能中心经此调起；窗口脚本经 window.arguments 拿引用）
    this.pdfCompare = PdfCompare;
    // 0.42.0 新装配：#命令标签 / 命令面板 / 快捷键注册表 / 参考文献面板 / 新列 / resolver 等
    this.commandTags = CommandTags;
    this.slashCommands = SlashCommands;
    this.hotkeys = Hotkeys;
    this.refPane = RefPane;
    this.translateX = TranslateX;
    this.rating = Rating;
    this.titleTranslationColumn = TitleTranslationColumn;
    this.progressColumn = ProgressColumn;
    this.ratingColumn = RatingColumn;
    this.fulltextResolver = FullTextResolver;
    this.translateCompare = TranslateCompare;

    // 一次性迁移：aiTemperature 旧版本默认是浮点 0.3，被 Mozilla int pref 截断成 0；
    // 0.4.0 起改存字符串。若用户 pref 仍是 int 类型则清掉，让新的字符串默认值生效
    try {
      const tempKey = Prefs.PREFIX + "aiTemperature";
      if (Services.prefs.getPrefType(tempKey) === Services.prefs.PREF_INT) {
        Services.prefs.clearUserPref(tempKey);
        await this._diag("migrated aiTemperature int -> string default");
      }
    } catch (e) {
      await this._diag("pref migration failed: " + (e && (e.stack || e.message) || e));
    }

    // 0.14.0：旧版单通道配置/快照 → 模型通道体系（幂等）；随后恢复账号会话
    // （restore 含网络校验，异步执行不阻塞启动；完成后 UI 经 onSessionChanged 对齐）
    try {
      Channels.migrateLegacy();
      await this._diag("channels migrated (active=" + (Channels.list().active) + ")");
    } catch (e) {
      await this._diag("channels migration FAILED: " + (e && (e.stack || e.message) || e));
    }
    // 0.28.0：翻译引擎一次性迁移（目标语言显示名 → 规范码；初始化 translateCfg）
    try {
      TranslateSvc.migrate();
      await this._diag("translate engine ready (active=" + TranslateSvc.cfg().active +
        ", target=" + TranslateSvc.targetCode() + ")");
    } catch (e) {
      await this._diag("translate migration FAILED: " + (e && (e.stack || e.message) || e));
    }
    // 0.15.0 一次性迁移：不再开放自建后台——清掉指向本地的旧服务器地址（设置界面
    // 已无服务器入口，残留 127.0.0.1 会让老用户升级后登录永远失败）。执行一次后打标。
    try {
      if (!Prefs.get("accountServerMigrated15", false)) {
        const curSrv = String(Prefs.get("accountServerUrl", "") || "");
        if (curSrv && /127\.0\.0\.1|localhost/i.test(curSrv)) {
          Prefs.set("accountServerUrl", ""); // 空值回落官方默认（account.js SERVER_DEFAULT）
          await this._diag("accountServerUrl reset to official (self-host sunset)");
        }
        Prefs.set("accountServerMigrated15", true);
      }
    } catch (e) {
      await this._diag("account server migration FAILED: " + (e && (e.stack || e.message) || e));
    }
    try {
      // 0.23.0：restore 完成后做一次会话仓库自检，把「几份副本 / 最新一份来自哪里 /
      // 是否已登录 / 落盘结果」写进启动日志。下次再出现「更新后掉登录」，
      // boot.log 第一段就能给出结论，不必靠 account.log 逐行倒推。
      Account.restore()
        .then(() => Account.selfCheck())
        .then((snap) => this._diag(snap))
        .then(() => this._checkRenewal())   // 0.24.4：临近到期/已过期提示一次
        .catch((e) => this._diag("account restore/selfCheck failed: " + (e && e.message)));
      await this._diag("account restore scheduled");
    } catch (e) {
      await this._diag("account restore schedule FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 注册设置面板（prefs.xhtml 为 fragment，配套脚本处理测试连接/文件选择）
    // 显式给稳定 id：openPreferences(paneID) 导航需要它（自动生成的 id 带随机串，
    // 且传 pluginID 给 openPreferences 无法定位面板——Z10 preferences.js 实证）
    // 0.15.0：stylesheets = 设置面板主题样式（prefs.css，随系统明暗切换；
    // 官方推荐通道，避免在 fragment 里内嵌 <html:style>）
    // 0.37.2：★ 注册前先把 prefs.xhtml 读出来自查一遍。fragment 解析失败时 Zotero 的表现是
    // **设置面板整块空白**、日志里也没有明显报错（曾因一个 `&nbsp;` 让面板空白了三个版本），
    // 所以这里主动校验，把原因写进 boot 日志。
    // 注：**不用 DOMParser** —— 它在 bootstrap 作用域不一定可用（实测第一次就静默失败），
    // 这里用零依赖的「未定义实体扫描」（正是本次故障的类型）+ 括号配对粗检。
    try {
      // 用 fetch 读包内资源：Zotero.File.getContentsAsync 不支持 jar:/chrome:// 形式的 URL
      // （实测抛 NS_ERROR_FAILURE [nsIURI.username]）
      const pRes = await fetch(rootURI + "chrome/content/prefs.xhtml");
      const pStr = String(await pRes.text());
      const pBad = pStr.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)[a-zA-Z][a-zA-Z0-9]*;/g) || [];
      if (pBad.length) {
        await this._diag("prefs.xhtml 有 XML 未定义实体（设置面板会整块空白！）: " +
          pBad.slice(0, 5).join(" "));
      } else {
        await this._diag("prefs.xhtml ok（" + pStr.length + " 字节，无未定义实体）");
      }
    } catch (e) {
      await this._diag("prefs.xhtml 读取失败: " + (e && (e.message || e)));
    }
    try {
      this._paneID = await Zotero.PreferencePanes.register({
        pluginID: id,
        id: "paperpilot-prefs",
        src: rootURI + "chrome/content/prefs.xhtml",
        scripts: [
          rootURI + "chrome/content/prefs-fold.js",
          rootURI + "chrome/content/prefs-pane.js",
          rootURI + "chrome/content/prefs-account.js",
          // 0.43.1 知网账号卡片（登录类入口收敛到设置面板）
          rootURI + "chrome/content/prefs-cnki.js",
          // 0.44.0（实验）第三方文献源卡片
          rootURI + "chrome/content/prefs-third-source.js",
          rootURI + "chrome/content/prefs-translate.js",
          rootURI + "chrome/content/prefs-menu.js",
          rootURI + "chrome/content/prefs-theme.js",
          // 0.42.0 快捷键卡片（录制/改键/开关）+ 面板锚点目录
          rootURI + "chrome/content/prefs-hotkeys.js",
        ],
        stylesheets: [
          rootURI + "chrome/content/prefs.css",
        ],
        label: "PaperPilot",
        image: "chrome://paperpilot/content/icons/icon.png",
      });
      await this._diag("PreferencePanes registered paneID=" + this._paneID);
    } catch (e) {
      await this._diag("PreferencePanes FAILED: " + (e && (e.stack || e.message) || e));
    }

    // UI 相关要等主窗口就绪（带超时兜底，永不挂死）
    await Promise.race([
      Zotero.uiReadyPromise,
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
    await this._diag("ui ready (or timed out)");

    // 期刊分区列
    if (Prefs.get("rankColumnEnabled", true)) {
      try {
        await RankColumn.load(rootURI);
        await RankColumn.register(id);
        await this._diag("rank column registered");
      } catch (e) {
        await this._diag("rank column FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // 被引量列（Semantic Scholar）
    if (Prefs.get("citationColumnEnabled", true)) {
      try {
        await CitationColumn.register(id);
        await this._diag("citation column registered");
      } catch (e) {
        await this._diag("citation column FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // AI 问答侧栏
    try {
      AIChatPane.register(id);
      await this._diag("chat pane registered");
    } catch (e) {
      await this._diag("chat pane FAILED: " + (e && (e.stack || e.message) || e));
    }

    // PDF 速览侧栏（0.11.0）
    try {
      GlancePane.register(id);
      await this._diag("glance pane registered");
    } catch (e) {
      await this._diag("glance pane FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 翻译面板（0.30.0）：右侧栏的翻译「操作 + 选项 + 结果」入口
    try {
      TranslatePane.register(id);
      await this._diag("translate pane registered");
    } catch (e) {
      await this._diag("translate pane FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 参考文献面板（0.42.0）：右侧栏自动解析当前文献的参考文献，+ 一键入库双向关联
    try {
      RefPane.register(id);
      await this._diag("refs pane registered");
    } catch (e) {
      await this._diag("refs pane FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.42.0 三个新列：标题译文 / 阅读进度 / 星标评级（各自带 pref 开关，结构与 citation 列一致）
    if (Prefs.get("titleTranslationColumnEnabled", true)) {
      try {
        await TitleTranslationColumn.register(id);
        await this._diag("title translation column registered");
      } catch (e) {
        await this._diag("title translation column FAILED: " + (e && (e.stack || e.message) || e));
      }
    }
    if (Prefs.get("progressColumnEnabled", true)) {
      try {
        await ProgressColumn.register(id);
        await this._diag("progress column registered");
      } catch (e) {
        await this._diag("progress column FAILED: " + (e && (e.stack || e.message) || e));
      }
    }
    if (Prefs.get("ratingColumnEnabled", true)) {
      try {
        await RatingColumn.register(id);
        await this._diag("rating column registered");
      } catch (e) {
        await this._diag("rating column FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // 阅读状态自动化（0.11.0）：新条目打「未读」+ 打开 PDF「未读→在读」
    try {
      ReadingState.register();
      await this._diag("reading state notifier registered");
    } catch (e) {
      await this._diag("reading state FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 菜单
    try {
      Menus.init(rootURI);
      await this._diag("menus registered");
    } catch (e) {
      await this._diag("menus FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.16.0 主题系统：界面主题（CSS 变量换肤）+ PDF 阅读主题（叠色/反色）
    try {
      UiTheme.register();
      await this._diag("ui theme registered");
    } catch (e) {
      await this._diag("ui theme FAILED: " + (e && (e.stack || e.message) || e));
    }
    try {
      PdfTheme.register();
      await this._diag("pdf theme registered");
    } catch (e) {
      await this._diag("pdf theme FAILED: " + (e && (e.stack || e.message) || e));
    }
    // 0.25.1 主题按钮：界面主题走主窗口左上角，PDF 阅读主题走阅读器官方 renderToolbar 扩展位
    try {
      ThemeToggle.register(id);
      await this._diag("theme toggle registered");
    } catch (e) {
      await this._diag("theme toggle FAILED: " + (e && (e.stack || e.message) || e));
    }
    // 0.38.0 顶部快捷按钮：条目工具栏一键菜单（须在 menus.js 加载后注册，标签走 I18n）
    try {
      ToolbarQuick.register();
      await this._diag("toolbar quick registered");
    } catch (e) {
      await this._diag("toolbar quick FAILED: " + (e && (e.stack || e.message) || e));
    }
    // 0.34.0 PDF 原位对照翻译：阅读器工具栏按钮（同一个 renderToolbar 扩展位）
    try {
      PdfInline.register(id);
      await this._diag("pdf inline translate registered");
    } catch (e) {
      await this._diag("pdf inline translate FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 阅读器划词浮窗
    try {
      ReaderPopup.register(id);
      await this._diag("reader popup registered");
    } catch (e) {
      await this._diag("reader popup FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.42.0 快捷键中央注册表：必须在 ChatFloat.register 之前 init
    // （悬浮窗的 Ctrl+Shift+K / 阅读器 Ctrl+Enter 已改经注册表生效）
    try {
      Hotkeys.init();
      await this._diag("hotkeys registry ready");
    } catch (e) {
      await this._diag("hotkeys FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.31.0 AI 问答悬浮窗：主窗口快捷键 + 阅读器工具栏按钮/Ctrl+Enter + 分屏窗口
    try {
      ChatFloat.register(id);
      await this._diag("chat float registered");
    } catch (e) {
      await this._diag("chat float FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 规则打标：新条目自动应用的 Notifier（菜单部分已由 Menus 注入）
    try {
      RuleTag.register();
      await this._diag("rule tag notifier registered");
    } catch (e) {
      await this._diag("rule tag FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.23.0 自动化引擎 + 入库自动精读：各自注册 item/tab Notifier
    // （两者内部都有「是否开启」的 pref 闸门，未开启时事件进来直接返回）
    try {
      Automation.register();
      await this._diag("automation notifier registered");
    } catch (e) {
      await this._diag("automation FAILED: " + (e && (e.stack || e.message) || e));
    }
    // 0.42.0 自动化规则快捷键：规则里配了 hotkey 的注册进中央快捷键表
    try {
      this._registerAutomationHotkeys();
    } catch (e) {
      await this._diag("automation hotkeys FAILED: " + (e && (e.stack || e.message) || e));
    }
    try {
      AutoRead.register();
      await this._diag("auto read notifier registered");
    } catch (e) {
      await this._diag("auto read FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.23.0 阅读行为统计：心跳采集（每 60s 结算一次「阅读器处于焦点」的时长）
    try {
      ReadingStats.start();
      await this._diag("reading stats heartbeat started");
    } catch (e) {
      await this._diag("reading stats FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.24.0 MCP 对外供给：注册 Zotero 本地端点 /paperpilot/mcp
    // （端点常驻注册，是否真正对外服务由 pref mcpEnabled 决定，未启用时返回 503）
    try {
      const ok = MCP.register();
      await this._diag("mcp endpoint register=" + ok + " enabled=" + MCP.enabled());
    } catch (e) {
      await this._diag("mcp FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.43.0 原生 Find Full Text 集成：Unpaywall/Sci-Hub 链注册进 Zotero 内置 resolvers
    // （自带 fulltextResolverEnabled 总开关，精确增删、不碰用户其他 resolver 配置）
    // 先做一次性镜像链迁移：默认镜像 3 → 7（用户自定义过的不动），再按新值注册
    try {
      const upgraded = SciHub.upgradeMirrorsPref();
      if (upgraded) await this._diag("scihub mirrors upgraded to 7-mirror chain");
    } catch (e) {
      await this._diag("scihub mirrors upgrade FAILED: " + (e && (e.stack || e.message) || e));
    }
    try {
      FullTextResolver.register();
      await this._diag("fulltext resolvers registered");
    } catch (e) {
      await this._diag("fulltext resolvers FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.24.0 文献发现：每日刷新检查（开关默认关，未开启时定时器空转不做网络请求）
    try {
      Discovery.start();
      await this._diag("discovery daily timer started (enabled=" + Prefs.get("discoveryEnabled", false) + ")");
    } catch (e) {
      await this._diag("discovery FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.25.0 arXiv 核心离线自检（不联网）。
    // 生成物是「代码生成代码」的产物：一旦转换出错（例如 module.exports = 被换成 return =），
    // loadSubScript 只会静默降级、界面看不出异常。把解析/构建/去重的本地断言结果写进
    // boot 日志，实机排查第一眼就能下结论（`arxiv core self-test: ok ...`）。
    try {
      await this._diag("arxiv core self-test: " + ArxivFetch.selfTest());
    } catch (e) {
      await this._diag("arxiv core self-test FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 监听配置变更：分区开关 / 数据路径 即时生效（非关键功能，失败不得拖死 startup）
    try {
      this._watchPrefs();
      await this._diag("pref watchers registered");
    } catch (e) {
      await this._diag("pref watchers FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 中文转换器自动更新（0.14.5）：静默、12h 间隔，修复知网抓取/PDF 下载最常见根因
    try {
      CNTranslators.scheduleAuto();
    } catch (e) {
      await this._diag("cn translators auto-update schedule FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.21.0：多篇 PDF 对比自检（pref compareSelfTest，默认关）。
    // 内嵌预览失败是静默的（面板空白），自检把结果写进 boot 日志以便定位。
    if (Prefs.get("compareSelfTest", false)) {
      try {
        this.pdfCompare.selfTest().catch((e) => this._diag("compare self-test rejected: " + (e && e.message)));
        await this._diag("compare self-test scheduled");
      } catch (e) {
        await this._diag("compare self-test FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // 0.43.1：知网链路启动自检（pref cnkiBootSelfTest，默认关）——权限三态/登录/搜索探测
    // 全写 boot 日志。发版前的真机功能级验证不依赖 GUI：装包设 pref → 重启 → 读日志。
    if (Prefs.get("cnkiBootSelfTest", false)) {
      try {
        setTimeout(() => {
          CNAuth.bootSelfTest().catch((e) => this._diag("cnki selftest rejected: " + (e && e.message)));
        }, 25000); // 25s 后跑：不与启动期网络任务抢带宽
        await this._diag("cnki selftest scheduled");
      } catch (e) {
        await this._diag("cnki selftest schedule FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // 0.34.0：PDF 原位对照翻译自检（pref pdfInlineSelfTest，默认关）。
    // 段落抽取错误 / 译文卡错位这类问题只有真实 PDF 才暴露（迷你 DOM 覆盖不到 pdf.js
    // 的真实 textLayer），自检把「每页段落数 / 卡片数 / 首卡落点」写进 boot 日志。
    if (Prefs.get("pdfInlineSelfTest", false)) {
      try {
        this.pdfInline.selfTest()
          .then((r) => this._diag("pdfInline selfTest: " + JSON.stringify(r)))
          .catch((e) => this._diag("pdfInline selfTest rejected: " + (e && e.message)));
        await this._diag("pdfInline self-test scheduled");
      } catch (e) {
        await this._diag("pdfInline self-test FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // 0.37.1：更新提示（Zotero 的第三方插件更新是静默的，补一次可见反馈；
    // pref updateNoticeEnabled 默认开，检查失败静默，同一版本只提示一次）
    try {
      UpdateNotice.register(id, version, (r) => {
        try { this._diag("update notice: " + JSON.stringify(r || {})); } catch (e) { /* ignore */ }
      });
      await this._diag("update notice scheduled (v" + version + ")");
    } catch (e) {
      await this._diag("update notice FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 0.36.0：左原右译双栏自检（pref pdfDualSelfTest，默认关）——真实 PDF 上验
    // 「两个 pane 是否挂上、右栏段落/卡片数、同步滚动位置」，结果写进 boot 日志
    if (Prefs.get("pdfDualSelfTest", false)) {
      try {
        // pdfDualSelfTestAtt：指定附件 itemID（排障直指用户报告的那篇；0 = 扫库取第一个）
        const att = Number(Prefs.get("pdfDualSelfTestAtt", 0)) || 0;
        this.pdfDual.selfTest(undefined, att)
          .then((r) => this._diag("pdfDual selfTest: " + JSON.stringify(r)))
          .catch((e) => this._diag("pdfDual selfTest rejected: " + (e && e.message)));
        await this._diag("pdfDual self-test scheduled" + (att ? " (att=" + att + ")" : ""));
      } catch (e) {
        await this._diag("pdfDual self-test FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    this._initialized = true;
    Zotero.debug(`PaperPilot ${version} initialized`);
  },

  /** 工作台独立窗口（0.9.0）：单实例——已开则聚焦，未开则新开 */
  openWorkbench() {
    try {
      const wm = Services.wm;
      const en = wm.getEnumerator("paperpilot:workbench");
      if (en.hasMoreElements()) {
        const win = en.getNext();
        try { win.focus(); } catch (e) { /* ignore */ }
        return win;
      }
      const win = Zotero.getMainWindow();
      if (!win) return null;
      // ⚠️ 新开 chrome 窗口里没有 Zotero 全局，主窗口的 Zotero 也不能经
      // opener.Zotero 跨窗口读到；且窗口作用域里 importESModule 加载
      // Services.sys.mjs 会失败（0.9.0 实证）——Zotero/Services 一律经
      // window.arguments 传对象引用，这是唯一可靠通道。
      return win.openDialog(
        "chrome://paperpilot/content/workbench.xhtml",
        "paperpilot-workbench",
        "chrome,extracz,resizable,dialog=no,centerscreen",
        { Zotero, Services }
      );
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 打开工作台失败"));
      Zotero.logError(e);
      return null;
    }
  },

  /** 功能中心独立窗口（0.12.0）：单实例，传参通道与 openWorkbench 相同 */
  openHub() {
    try {
      const wm = Services.wm;
      const en = wm.getEnumerator("paperpilot:hub");
      if (en.hasMoreElements()) {
        const win = en.getNext();
        try { win.focus(); } catch (e) { /* ignore */ }
        return win;
      }
      const win = Zotero.getMainWindow();
      if (!win) return null;
      return win.openDialog(
        "chrome://paperpilot/content/hub.xhtml",
        "paperpilot-hub",
        "chrome,extracz,resizable,dialog=no,centerscreen",
        { Zotero, Services }
      );
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 打开功能中心失败"));
      Zotero.logError(e);
      return null;
    }
  },

  _watchPrefs() {
    // 沙箱作用域里的普通对象挂不上 nsIPrefBranch 弱引用 observer
    // （FF140 实证：addObserver(..., weak=true) 直接抛错拖死 startup）。
    // 改用 Zotero.Prefs.registerObserver——Zotero 自己在主作用域持有单个
    // nsIObserver 再分发，按「完整 pref key」注册（无前缀监听，逐 key 注册）。
    this._prefObserverSymbols = ["rankDataPath", "rankColumnEnabled", "easyScholarEnabled", "easyScholarKey", "citationColumnEnabled", "rankDataSets", "rankMaxBadges", "rankBadgeStyle", "uiTheme", "uiThemeCustom", "uiWallpaper", "uiWallpaperPath", "uiWallpaperUrl", "uiWallpaperOpacity", "pdfTheme", "pdfThemeCustomColor", "pdfThemeCustomOpacity", "themeButtonEnabled", "themeMainButtonEnabled", "quickBarButtonEnabled", "titleTranslationColumnEnabled", "progressColumnEnabled", "ratingColumnEnabled", "fulltextResolverEnabled", "scihubEnabled", "scinetEnabled", "scihubMirrors", "scinetUrl", "unpaywallEmail", "automationRules"].map((key) =>
      Zotero.Prefs.registerObserver(Prefs.PREFIX + key, () => {
        this._onPrefChanged(key).catch((e) => {
          try { Zotero.logError(e); } catch (_) { /* ignore */ }
        });
      }, true)
    );
  },

  async _onPrefChanged(key) {
    if (key === "rankDataPath") {
      if (RankColumn._registered) await RankColumn.reload();
    } else if (key === "rankColumnEnabled") {
      const enabled = Prefs.get("rankColumnEnabled", true);
      if (enabled && !RankColumn._registered) {
        await RankColumn.load(this.rootURI);
        await RankColumn.register(this.id);
      } else if (!enabled && RankColumn._registered) {
        RankColumn.unregister();
      }
    } else if (key === "citationColumnEnabled") {
      const enabled = Prefs.get("citationColumnEnabled", true);
      if (enabled && !CitationColumn._registered) {
        await CitationColumn.register(this.id);
      } else if (!enabled && CitationColumn._registered) {
        CitationColumn.unregister();
      }
    } else if (key === "easyScholarEnabled" || key === "easyScholarKey") {
      // 开关或密钥变化：清查找缓存并立即重绘（ES 结果按内容缓存，无需清空）
      try { RankColumn._lookupCache.clear(); } catch (e) { /* ignore */ }
      try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
      try { Zotero.Notifier.trigger("redraw", "item", []); } catch (e) { /* ignore */ }
    } else if (key === "rankDataSets" || key === "rankMaxBadges" || key === "rankBadgeStyle") {
      // 分区显示配置变化：清条目级缓存并立即重绘（0.18.0）；
      // 0.18.1 补 redraw 兜底——不同 Zotero 版本对行数据缓存处理不一致，
      // 只 refreshColumns() 在部分版本上不会重取 dataProvider，表现为
      // 「设置改了没反应」。
      try { RankColumn._lookupCache.clear(); } catch (e) { /* ignore */ }
      try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
      try { Zotero.Notifier.trigger("redraw", "item", []); } catch (e) { /* ignore */ }
    } else if (key === "uiTheme" || key === "uiThemeCustom" || key === "uiWallpaper" || key === "uiWallpaperPath" || key === "uiWallpaperUrl" || key === "uiWallpaperOpacity") {
      // 主题/壁纸即时生效：设置面板/菜单/工具栏按钮任何一处改动，全部窗口立即换肤
      try { UiTheme.apply(); } catch (e) { /* ignore */ }
      // 两处主题按钮的提示文字同步（界面主题名变了）
      try { ThemeToggle.refresh(); } catch (e) { /* ignore */ }
    } else if (key === "pdfTheme" || key === "pdfThemeCustomColor" || key === "pdfThemeCustomOpacity") {
      // PDF 阅读主题即时生效：重刷全部已打开 reader（不用重开文档）
      try { PdfTheme.refresh(); } catch (e) { /* ignore */ }
      try { ThemeToggle.refresh(); } catch (e) { /* ignore */ }
    } else if (key === "themeButtonEnabled" || key === "themeMainButtonEnabled") {
      // 按钮总开关 / 主窗口按钮独立门控（0.42.0）
      try { ThemeToggle.syncEnabled(); } catch (e) { /* ignore */ }
    } else if (key === "quickBarButtonEnabled") {
      // 顶部快捷按钮开关（直达项变化无需观察：菜单在 popupshowing 时重填）
      try { ToolbarQuick.syncEnabled(); } catch (e) { /* ignore */ }
    } else if (key === "titleTranslationColumnEnabled") {
      const enabled = Prefs.get("titleTranslationColumnEnabled", true);
      if (enabled && !TitleTranslationColumn._registered) {
        await TitleTranslationColumn.register(this.id);
      } else if (!enabled && TitleTranslationColumn._registered) {
        TitleTranslationColumn.unregister();
      }
    } else if (key === "progressColumnEnabled") {
      const enabled = Prefs.get("progressColumnEnabled", true);
      if (enabled && !ProgressColumn._registered) {
        await ProgressColumn.register(this.id);
      } else if (!enabled && ProgressColumn._registered) {
        ProgressColumn.unregister();
      }
    } else if (key === "ratingColumnEnabled") {
      const enabled = Prefs.get("ratingColumnEnabled", true);
      if (enabled && !RatingColumn._registered) {
        await RatingColumn.register(this.id);
      } else if (!enabled && RatingColumn._registered) {
        RatingColumn.unregister();
      }
    } else if (key === "fulltextResolverEnabled" || key === "scihubEnabled" || key === "scinetEnabled"
      || key === "scihubMirrors" || key === "scinetUrl" || key === "unpaywallEmail") {
      // resolver 配置项变化：重算注入清单（幂等，无变化不写 pref）
      try { FullTextResolver.refresh(); } catch (e) { /* ignore */ }
    } else if (key === "automationRules") {
      // 规则增删/改快捷键：重挂自动化热键（register 同 id 覆盖；删除的规则热键
      // 残留到下次启动，触发时 runRule 对未知 id 安全返回）
      try { this._registerAutomationHotkeys(); } catch (e) { /* ignore */ }
    }
  },

  /** 0.42.0：把自动化规则里配了 hotkey 的注册进中央快捷键表（幂等，同 id 覆盖） */
  _registerAutomationHotkeys() {
    if (typeof Automation === "undefined" || typeof Hotkeys === "undefined") return;
    if (!Automation.getHotkeyRules || !Hotkeys.register) return;
    for (const r of Automation.getHotkeyRules()) {
      try {
        Hotkeys.register({
          id: "automation-" + r.id,
          label: "自动化：" + r.name,
          combo: r.hotkey,
          scope: "main",
          handler: () => {
            try { Automation.runRule(r.id); } catch (e) { Zotero.logError(e); }
          },
        });
      } catch (e) { Zotero.logError(e); }
    }
  },

  destroy() {
    if (this._prefObserverSymbols) {
      for (const sym of this._prefObserverSymbols) {
        try { Zotero.Prefs.unregisterObserver(sym); } catch (e) { /* ignore */ }
      }
      this._prefObserverSymbols = null;
    }
    try { Menus.destroy(); } catch (e) { Zotero.logError(e); }
    try { ThemeToggle.unregister(); } catch (e) { Zotero.logError(e); }
    try { ToolbarQuick.unregister(); } catch (e) { Zotero.logError(e); }
    try { PdfInline.unregister(); } catch (e) { Zotero.logError(e); }
    try { UpdateNotice.unregister(); } catch (e) { Zotero.logError(e); }
    try { UiTheme.unregister(); } catch (e) { Zotero.logError(e); }
    try { PdfTheme.unregister(); } catch (e) { Zotero.logError(e); }
    try { RuleTag.unregister(); } catch (e) { Zotero.logError(e); }
    try { Automation.unregister(); } catch (e) { Zotero.logError(e); }
    try { AutoRead.unregister(); } catch (e) { Zotero.logError(e); }
    try { ReadingStats.stop(); } catch (e) { Zotero.logError(e); }
    try { Discovery.stop(); } catch (e) { Zotero.logError(e); }
    try { MCP.unregister(); } catch (e) { Zotero.logError(e); }
    try { ReadingState.unregister(); } catch (e) { Zotero.logError(e); }
    try { ReaderPopup.unregister(); } catch (e) { Zotero.logError(e); }
    try { ChatFloat.unregister(); } catch (e) { Zotero.logError(e); }
    try { AIChatPane.unregister(); } catch (e) { Zotero.logError(e); }
    try { GlancePane.unregister(); } catch (e) { Zotero.logError(e); }
    try { TranslatePane.unregister(); } catch (e) { Zotero.logError(e); }
    try { RefPane.unregister(); } catch (e) { Zotero.logError(e); }
    try { RankColumn.unregister(); } catch (e) { Zotero.logError(e); }
    try { CitationColumn.unregister(); } catch (e) { Zotero.logError(e); }
    try { TitleTranslationColumn.unregister(); } catch (e) { Zotero.logError(e); }
    try { ProgressColumn.unregister(); } catch (e) { Zotero.logError(e); }
    try { RatingColumn.unregister(); } catch (e) { Zotero.logError(e); }
    try { Hotkeys.shutdown(); } catch (e) { Zotero.logError(e); }
    try { FullTextResolver.unregister(); } catch (e) { Zotero.logError(e); }
    // unregister 接收的是 register 返回的 paneID（不是 pluginID；Z10 关机时也会自动注销）
    try {
      if (this._paneID) Zotero.PreferencePanes.unregister(this._paneID);
    } catch (e) { Zotero.logError(e); }
    this._paneID = null;
    this._initialized = false;
  },
};
