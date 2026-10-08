// 0.14.0: 账号系统 + AI 模型通道管理
// 账号服务器（登录/鉴权/官方模型网关同源）；会话令牌存数据目录 JSON，不进 pref
// 0.15.0 起官方账号服务器地址内置固定（https://pp.xinglintools.top）：
// 设置界面不再提供服务器入口，也不开放自建后台；本 pref 仅作高级覆盖用（about:config）
pref("extensions.zotero.paperpilot.accountServerUrl", "https://pp.xinglintools.top");
// 0.15.0 一次性迁移标记：清除指向本地的旧自建后台地址（执行一次后置 true）
pref("extensions.zotero.paperpilot.accountServerMigrated15", false);
// 模型通道注册表 {channels:[{id,name,provider,baseUrl,apiKey,model,models,extraBody,timeoutMs}],active}
// 官方通道(official)的 baseUrl/apiKey 由账号系统运行时注入，不落盘
pref("extensions.zotero.paperpilot.aiChannels", "");
// —— 以下三项为 0.13 及更早的单通道配置，0.14.0 启动时自动迁移为通道，仅作兜底 ——
pref("extensions.zotero.paperpilot.aiBaseUrl", "http://127.0.0.1:8000/v1");
pref("extensions.zotero.paperpilot.aiApiKey", "");
pref("extensions.zotero.paperpilot.aiModel", "auto");
pref("extensions.zotero.paperpilot.aiProvider", "account");
pref("extensions.zotero.paperpilot.aiSystemPrompt", "你是一个学术研究助手，帮助用户分析论文、解读文献。回复使用中文，除非用户要求其他语言。使用 Markdown 格式输出。");
pref("extensions.zotero.paperpilot.aiMaxTokens", 4096);
// 注意：Mozilla pref 没有浮点类型（int 会截断 0.3→0），温度一律存字符串，代码里 Number() 解析
pref("extensions.zotero.paperpilot.aiTemperature", "0.3");
pref("extensions.zotero.paperpilot.aiFullTextMaxChars", 16000);
pref("extensions.zotero.paperpilot.rankColumnEnabled", true);
pref("extensions.zotero.paperpilot.rankDataPath", "");
// 0.5.0 新增：easyScholar 在线期刊等级（离线 JSON 数据仍为优先兜底）
// 0.15.0：内置官方默认 SecretKey（rank-column.js ES_OFFICIAL_KEY，开箱即用）；
// 本 pref 留空 = 使用内置官方 Key；填入自定义值则优先于内置 Key（用户自有额度）
pref("extensions.zotero.paperpilot.easyScholarEnabled", true);
pref("extensions.zotero.paperpilot.easyScholarKey", "");
// 0.18.0 分区列细化：数据集开关（逗号分隔 kind，空=默认集）、badge 数量上限、
// 配色风格（color=分区色阶 / mono=跟随主题强调色）
// 0.18.1：新增中文体系 kind（cnTier/pku/cscd/core/cssci）与 legacy，
// rankDataSetsM181 为一次性迁移标记（旧显式列表补入新 kind）
pref("extensions.zotero.paperpilot.rankDataSets", "");
pref("extensions.zotero.paperpilot.rankDataSetsM181", false);
pref("extensions.zotero.paperpilot.rankMaxBadges", 6);
pref("extensions.zotero.paperpilot.rankBadgeStyle", "color");
// 0.5.0 新增：AI 配置快照(0.14.0 起由模型通道体系取代，仅作迁移数据源)
pref("extensions.zotero.paperpilot.aiProfiles", "[]");
pref("extensions.zotero.paperpilot.readerPopupEnabled", true);
pref("extensions.zotero.paperpilot.customPrompts", "");
pref("extensions.zotero.paperpilot.matrixMaxItems", 8);
pref("extensions.zotero.paperpilot.autoTagMax", 6);
// 0.6.0 新增：Semantic Scholar 被引量列
pref("extensions.zotero.paperpilot.citationColumnEnabled", true);
pref("extensions.zotero.paperpilot.s2ApiKey", "");
// 无 DOI 的条目是否走标题检索兜底（较慢、可能误配，可关闭）
pref("extensions.zotero.paperpilot.s2TitleSearch", true);
// 0.6.0 新增：规则打标。行格式：标签 | 字段 | 操作 | 值（// 开头为注释）
pref("extensions.zotero.paperpilot.ruleTagRules", "// 每行一条规则：标签 | 字段 | 操作 | 值\n// 字段：title publicationTitle journalAbbreviation abstractNote year itemType DOI creators\n// 操作：contains !contains regex = != > < exists\n// 例：#方法/机器学习 | abstractNote | contains | machine learning\n// 例：#领域/心血管 | publicationTitle | regex | (?i)heart|cardio\n// 例：#近期文献 | year | > | 2023");
pref("extensions.zotero.paperpilot.ruleTagAutoOnNew", false);
// 0.10.0 新增：阅读器划词浮窗 2.0
pref("extensions.zotero.paperpilot.readerPopupAutoTranslate", false);
pref("extensions.zotero.paperpilot.readerPopupTargetLang", "中文");
pref("extensions.zotero.paperpilot.readerPopupStream", true);
pref("extensions.zotero.paperpilot.readerPopupWriteBack", true);
// 0.15.0 新增：浮窗结果区字号缩放（"0.85"/"1"/"1.15"/"1.3"/"1.5"，字符串存法同 aiTemperature）
pref("extensions.zotero.paperpilot.readerPopupFontScale", "1");
// 每日 AI 请求计数（格式：YYYY-MM-DD:次数），设置面板只读展示
pref("extensions.zotero.paperpilot.readerPopupDailyCount", "");
// 0.11.0 新增：阅读状态 / 全文对照翻译 / 笔记模板 / 附件命名 / Unpaywall / Anki
pref("extensions.zotero.paperpilot.readingStateAutoUnread", true);
pref("extensions.zotero.paperpilot.bilingualChunkChars", 1200);
// 0.25.2 新增：全文对照翻译·双栏对照窗口（正文字号 px 11–28；布局 auto|two|single）
pref("extensions.zotero.paperpilot.bilingualViewFontSize", 15);
pref("extensions.zotero.paperpilot.bilingualViewLayout", "auto");
pref("extensions.zotero.paperpilot.noteTemplatesCustom", "");
pref("extensions.zotero.paperpilot.attachNamePattern", "{author} - {year} - {title}");
pref("extensions.zotero.paperpilot.unpaywallEmail", "");
// 0.27.0 新增：Sci-Hub / Sci-Net 补全文（Unpaywall 未命中时的补充渠道，可在设置关闭）
pref("extensions.zotero.paperpilot.scihubEnabled", true);
pref("extensions.zotero.paperpilot.scihubMirrors", "sci-hub.ru, sci-hub.se, sci-hub.st");
pref("extensions.zotero.paperpilot.scinetEnabled", true);
pref("extensions.zotero.paperpilot.scinetUrl", "https://sci-net.xyz");
pref("extensions.zotero.paperpilot.ankiCardCount", 10);
// 0.13.0 新增：工作台 2.0（主题 auto/light/dark；会话持久化 JSON）
pref("extensions.zotero.paperpilot.wbTheme", "auto");
pref("extensions.zotero.paperpilot.workbenchSessions", "");
// 0.14.5 新增：中文转换器/抓取（茉莉花同等能力）
pref("extensions.zotero.paperpilot.cnTranslatorsAuto", true);
pref("extensions.zotero.paperpilot.cnTranslatorUpdateTime", "0");
pref("extensions.zotero.paperpilot.cnFetchUseCNKI", true);
pref("extensions.zotero.paperpilot.cnDownloadDir", "");
// 0.16.1 新增：抓取中文元数据时同时尝试下载 PDF 全文（PubScholar 免费直链 + CNKI 机构权限通道）
pref("extensions.zotero.paperpilot.cnFetchPDF", true);
// 0.14.7 新增：设置界面敏感信息默认掩码（接口地址明文开关）
pref("extensions.zotero.paperpilot.uiShowFullUrl", false);
// 0.16.0 新增：界面主题（"" = 跟随 Zotero 原生；主题 id 见 ui-theme.js THEMES）
// 借鉴 yaobian-zotero（CSS 变量映射换肤）与 zotero-night（Nord 色板）设计
pref("extensions.zotero.paperpilot.uiTheme", "");
// 自定义界面主题色板 JSON：{__dark,background,side,surface,ink,accent,line,select}
// 只填核心角色，toolbar/tab/menu/ink2/ink3 等由模块运行时派生（yaobian 思路）
pref("extensions.zotero.paperpilot.uiThemeCustom", "");
// 0.16.0 新增：PDF 阅读主题（default/careeye/sepia/sakura/mint/night/night-warm/custom）
// 借鉴 zotero-pdf-background（textLayer 半透明叠色 + 阅读器工具栏按钮）
// 与 zotero-night（canvas invert 反色夜间模式）
pref("extensions.zotero.paperpilot.pdfTheme", "default");
// 0.17.0 壁纸语义重构：主题=配色+壁纸一体包
// "theme"（默认）= 用主题包自带壁纸；"off" = 关闭壁纸纯色主题；"custom" = 自定义文件
// （0.16.1 的 auto/内置壁纸 id/"" 由 UiTheme.migrateLegacy 一次性迁移，幂等）
pref("extensions.zotero.paperpilot.uiWallpaper", "theme");
// custom 壁纸的本地文件路径（图片 jpg/png/webp/gif/bmp 或视频 mp4/webm/mkv/mov）
pref("extensions.zotero.paperpilot.uiWallpaperPath", "");
// 0.18.0 新增：在线壁纸 URL（图片或视频直链；优先于本地路径，下载缓存到数据目录）
pref("extensions.zotero.paperpilot.uiWallpaperUrl", "");
// 壁纸可见度 10-90（越大面板越透、壁纸越明显；主题可带推荐值，用户滑条可覆盖）
pref("extensions.zotero.paperpilot.uiWallpaperOpacity", 70);
// 自定义 PDF 叠色：颜色 + 不透明度（5-60，百分整数；Mozilla pref 无浮点）
pref("extensions.zotero.paperpilot.pdfThemeCustomColor", "#578f32");
pref("extensions.zotero.paperpilot.pdfThemeCustomOpacity", 30);
// 0.25.0 新增：主题切换按钮（0.25.1 起拆成两个入口——界面主题在主窗口左上角、
// PDF 阅读主题在阅读器工具栏）。两个按钮各读各的 pref（uiTheme / pdfTheme），
// 任一处切换即时生效并持久化；置 false 可完全隐藏两个入口
// （主题仍可在 视图 → 外观主题 菜单里切换）
pref("extensions.zotero.paperpilot.themeButtonEnabled", true);
// 0.21.0 新增：多篇 PDF 并排对比
// 同时打开的 PDF 上限（2-6，默认 4：2×2 网格在常规屏幕上每页仍可读）
pref("extensions.zotero.paperpilot.compareMaxPanes", 4);
// 布局：auto（按篇数自动）/ h（横向并排）/ v（纵向堆叠）/ grid（2×2 网格）
pref("extensions.zotero.paperpilot.compareLayout", "auto");
// 同步滚动默认关（0.21.2 起）：默认「各面板完全独立滚动」，互不干扰；
// 需要跟读时在对比窗口工具栏勾上——按滚动百分比位置联动，页数不同也能大致对齐
pref("extensions.zotero.paperpilot.compareSyncScroll", false);
// 同步缩放默认关（各篇排版/页边距不同，强制统一缩放常导致某篇字过大或过小）
pref("extensions.zotero.paperpilot.compareSyncZoom", false);
// 自检开关（默认关）：置 true 后下次启动自动用库里前 4 个 PDF 开一次对比窗口，
// 12 秒后把每个面板的加载结果（是否挂上 pdf.js 视图/页数/提示语）写进
// paperpilot-boot.log ——「面板空白」这类静默失败靠它定位，验完请改回 false
pref("extensions.zotero.paperpilot.compareSelfTest", false);
// 0.22.0 新增：库内问答（候选上下文预算，字符数；超出后其余候选仅列标题）
pref("extensions.zotero.paperpilot.libSearchContextChars", 12000);
// 0.22.0 新增：库内问答默认候选上限（可被对话框内输入覆盖）
pref("extensions.zotero.paperpilot.libSearchTopN", 8);
// 0.23.0 新增：自动化引擎（规则 JSON 数组 / 自动触发开关 / 批量上限 / AI 每日额度）
pref("extensions.zotero.paperpilot.automationRules", "");
pref("extensions.zotero.paperpilot.automationOnNewItem", false);
pref("extensions.zotero.paperpilot.automationOnReaderOpen", false);
pref("extensions.zotero.paperpilot.automationMaxPerFlush", 20);
pref("extensions.zotero.paperpilot.automationDailyAiCap", 20);
// 每日 AI 次数（格式：YYYY-MM-DD:次数），与浮窗计数同样的日切做法
pref("extensions.zotero.paperpilot.automationDailyAiCount", "");
// 0.23.0 新增：入库自动精读（默认关闭；仅限分类为空=全库；每日上限；成功标记标签）
pref("extensions.zotero.paperpilot.autoReadEnabled", false);
pref("extensions.zotero.paperpilot.autoReadCollection", "");
pref("extensions.zotero.paperpilot.autoReadDailyCap", 10);
pref("extensions.zotero.paperpilot.autoReadDailyCount", "");
pref("extensions.zotero.paperpilot.autoReadTag", "#AI精读");
pref("extensions.zotero.paperpilot.autoReadMaxPerFlush", 5);
// 0.23.0 新增：阅读行为统计（心跳采集开关 + 数据 JSON，仅存最近 60 天）
pref("extensions.zotero.paperpilot.readingStatsEnabled", true);
pref("extensions.zotero.paperpilot.readingStats", "");
// 0.23.0 新增：笔记关系图谱节点上限（超出按连接度截断）
pref("extensions.zotero.paperpilot.noteGraphMaxNodes", 400);
// 0.24.0 新增：元数据体检（期刊名转换方向 expand|abbrev|both|off；用户自定义刊名表，每行「缩写=全称」）
pref("extensions.zotero.paperpilot.metaRulesJournalDir", "expand");
pref("extensions.zotero.paperpilot.metaRulesJournals", "");
// 0.24.0 新增：文献发现（arXiv 每日推荐）——默认关闭，避免未预期联网
pref("extensions.zotero.paperpilot.discoveryEnabled", false);
pref("extensions.zotero.paperpilot.discoveryCategories", "cs.AI, cs.CL, cs.LG");
pref("extensions.zotero.paperpilot.discoveryMaxPerFeed", 100);
pref("extensions.zotero.paperpilot.discoveryMaxResults", 30);
pref("extensions.zotero.paperpilot.discoveryProfileTerms", 40);
pref("extensions.zotero.paperpilot.discoveryLastRun", "");
pref("extensions.zotero.paperpilot.discoveryResults", "");
pref("extensions.zotero.paperpilot.discoveryIgnored", "[]");
pref("extensions.zotero.paperpilot.discoveryCollectionName", "arXiv 推荐");
// 0.24.0 新增：MCP 对外供给（默认关闭；令牌首次自动生成并持久化）
pref("extensions.zotero.paperpilot.mcpEnabled", false);
pref("extensions.zotero.paperpilot.mcpToken", "");
// 0.24.4 新增：会员到期提醒「已提示过的到期周期」（存 expiresAt；避免每次启动重复弹窗）
pref("extensions.zotero.paperpilot.renewPromptShownFor", "");
// 0.24.7 新增：本机安装标识（首次登录时生成一次并持久化）。
//   ★ 它**不是凭据**：只是让服务端能区分「这是哪台机器」，用于「登录设备」列表与账号共享检测。
//   非敏感标识，可以放 pref（与「令牌绝不进 pref」那条纪律不冲突：令牌是凭据，这个不是）。
pref("extensions.zotero.paperpilot.installId", "");
