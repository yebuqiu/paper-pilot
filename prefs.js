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
// 0.38.0 提示词深度优化：从一句话人设升级为「人设 + 五条回答纪律」——
// 反编造/注明出处/区分推断与原文/禁客套废话/要具体数字，全部 AI 功能共用此地基
pref("extensions.zotero.paperpilot.aiSystemPrompt", "你是一位严谨的学术研究助手，协助分析论文、解读文献、整理研究思路。回答纪律：\n1. 严格基于所给材料回答；材料中没有的信息明确说明「材料未提及」，绝不编造数据、结论或引文；\n2. 引用论文观点时注明位置（如「见第 3 节」「摘要提到」），你的推断要与论文原文明确区分，不混在一起；\n3. 直接给结论：不写开场白、不复述问题、不用「希望有帮助」类结尾；\n4. 用具体术语和数字说话（含单位与比较基准），避免「效果显著」「十分重要」这类空泛表述；\n5. 默认中文回答，术语与专有名词保留英文；默认 Markdown 格式（当前指令要求纯文本时以指令为准）。");
pref("extensions.zotero.paperpilot.aiMaxTokens", 4096);
// 注意：Mozilla pref 没有浮点类型（int 会截断 0.3→0），温度一律存字符串，代码里 Number() 解析
pref("extensions.zotero.paperpilot.aiTemperature", "0.3");
// top_p 核采样（可选，空 = 不传该字段——部分网关对未知字段报错；字符串存法同温度）
pref("extensions.zotero.paperpilot.aiTopP", "");
pref("extensions.zotero.paperpilot.aiFullTextMaxChars", 16000);
// 0.48.0 多轮上下文管理：对话历史滑窗轮数（1-30，默认 6 轮 = 12 条消息）
pref("extensions.zotero.paperpilot.aiHistoryRounds", 6);
// 0.48.0 Agent 模式（交互参考 Hermes Agent：任务规划 + 工具调用 + 上下文管理）：
// 总开关默认关（零回归）；工具白名单 CSV；写操作默认逐次确认（协作模式）；
// 工具调用轮数上限（1-12，防失控）
pref("extensions.zotero.paperpilot.chatAgentMode", false);
pref("extensions.zotero.paperpilot.aiAgentMaxSteps", 5);
pref("extensions.zotero.paperpilot.aiAgentConfirmWrite", true);
// 0.49.0：工具集扩至 11 个（读：arXiv/被引/笔记检索/文献导出；写：移动文集）
pref("extensions.zotero.paperpilot.aiAgentTools", "search_library,get_item_details,read_item_fulltext,list_collections,search_arxiv,get_citation_count,search_notes,export_bibliography,add_note,add_tags,move_to_collection,memory_read,memory_write");
// 0.51.0 AI 回答内「文献 n」引用可点击
pref("extensions.zotero.paperpilot.citeLinksEnabled", true);
// 0.51.0 Agent 长期记忆（JSON 数组，LRU 200）
pref("extensions.zotero.paperpilot.agentMemory", "");
// 0.51.0 条目详情面板「相关文献」（Semantic Scholar 推荐）
pref("extensions.zotero.paperpilot.relatedPapersEnabled", true);
// 0.52.0 条目详情面板「引文上下文」（S2 citations 引用句 + 倾向）
pref("extensions.zotero.paperpilot.citationContextEnabled", true);
// 0.52.0 标注→论点速记（菜单入口开关）
pref("extensions.zotero.paperpilot.annotationDigestEnabled", true);
// 0.49.0 Agent 决策模型路由（空 = 工具决策轮也用主通道模型）
pref("extensions.zotero.paperpilot.aiAgentDecisionModel", "");
// 0.49.0 研究者画像（注入所有 system prompt 的长期偏好，空 = 不注入）
pref("extensions.zotero.paperpilot.researcherProfile", "");
// 0.49.0 浮窗会话持久化（JSON 数组，LRU 50；空 = 无历史）
pref("extensions.zotero.paperpilot.chatSessions", "");
// 0.49.0 写操作审计日志（JSON 数组，LRU 100，最新在前）
pref("extensions.zotero.paperpilot.agentAuditLog", "");
// 0.49.0 定时任务（"HH:MM" 本地时间；空 = 关闭）
pref("extensions.zotero.paperpilot.scheduleDailyDigest", "");
pref("extensions.zotero.paperpilot.scheduleWeeklyReport", "");
pref("extensions.zotero.paperpilot.scheduleLibHealth", "");
// 定时任务上次执行日期记账（JSON {jobId:"YYYY-MM-DD"}）
pref("extensions.zotero.paperpilot.scheduleLastRun", "");
// 0.48.x 技能包商店（Skills Hub）：已安装记账 / 本地评分 / 目录源（空 = 仅内置目录）
pref("extensions.zotero.paperpilot.skillPacksInstalled", "");
pref("extensions.zotero.paperpilot.skillPackRatings", "");
// 0.48.1 起默认指向官方在线目录（Gitee raw，与更新通道同基础设施；清空该 pref = 回落纯内置目录）
pref("extensions.zotero.paperpilot.skillStoreSource", "https://gitee.com/cassiuschen9261/paper-pilot/raw/main/server/public/skill-catalog.json");
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
// 0.46.0 AI 打标签 v2：受控词表（复用库内已有标签）/ 结果缓存 / 标签语言 / 置信度预选阈值
pref("extensions.zotero.paperpilot.autoTagUseVocab", true);
pref("extensions.zotero.paperpilot.autoTagCache", true);
pref("extensions.zotero.paperpilot.autoTagLang", "auto");
pref("extensions.zotero.paperpilot.autoTagConfidenceThreshold", 0.7);
// 建议缓存数据（指纹→建议，LRU 上限 100 条；autoTagCache=false 时不读写）
pref("extensions.zotero.paperpilot.autoTagCacheData", "");
// 0.6.0 新增：Semantic Scholar 被引量列
pref("extensions.zotero.paperpilot.citationColumnEnabled", true);
// 标题译文列（读 extra 中 PP Title Translation 行，由「翻译标题与摘要」写回）
pref("extensions.zotero.paperpilot.titleTranslationColumnEnabled", true);
// 阅读进度列（心跳时长 ÷ PDF 页数；无页数走时长启发值）
pref("extensions.zotero.paperpilot.progressColumnEnabled", true);
// 星标评级列（读 ★×n 标签）
pref("extensions.zotero.paperpilot.ratingColumnEnabled", true);
// 「翻译标题与摘要」成功后把译文写回 extra（PP Title/Abstract Translation 行）
pref("extensions.zotero.paperpilot.translateWriteBack", true);
pref("extensions.zotero.paperpilot.s2ApiKey", "");
// 无 DOI 的条目是否走标题检索兜底（较慢、可能误配，可关闭）
pref("extensions.zotero.paperpilot.s2TitleSearch", true);
// 0.6.0 新增：规则打标。行格式：标签 | 字段 | 操作 | 值（// 开头为注释）
pref("extensions.zotero.paperpilot.ruleTagRules", "// 每行一条规则：标签 | 字段 | 操作 | 值\n// 字段：title publicationTitle journalAbbreviation abstractNote year itemType DOI creators\n// 操作：contains !contains regex = != > < exists\n// 例：#方法/机器学习 | abstractNote | contains | machine learning\n// 例：#领域/心血管 | publicationTitle | regex | (?i)heart|cardio\n// 例：#近期文献 | year | > | 2023");
pref("extensions.zotero.paperpilot.ruleTagAutoOnNew", false);
// 0.10.0 新增：阅读器划词浮窗 2.0
pref("extensions.zotero.paperpilot.readerPopupAutoTranslate", false);
// 0.28.0：目标语言值域由显示名（"中文"）迁移为规范语言码（"zh-CN"），
// 对全部翻译功能统一生效；旧值由 TranslateSvc.migrate() 一次性改写
pref("extensions.zotero.paperpilot.readerPopupTargetLang", "zh-CN");
// 0.28.0 新增：多引擎翻译。源语言（"auto" = 自动检测）
pref("extensions.zotero.paperpilot.translateFromLang", "auto");
// 翻译引擎配置：{active, fallback:[引擎id], timeoutMs, retry, cache, secrets:{引擎id:"a#b"}}
pref("extensions.zotero.paperpilot.translateCfg", "");
// 0.28.0 一次性迁移标记：目标语言显示名 → 规范码
pref("extensions.zotero.paperpilot.translateMigrated28", false);
// 0.31.0 一次性迁移标记：默认回退链升级为含 edge 的新默认（仅当用户从未自定义过排序）
pref("extensions.zotero.paperpilot.translateFallbackUpgraded", false);
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
// 0.33.0 全文对照翻译深度优化（复杂 PDF）：
// 术语表：每行「原文 = 译文」（支持 => 与 TAB 分隔，# 与 // 为注释；另兼容 JSON 数组）。
// 注入 AI 大模型提示词保证术语全文一致；专用引擎（Google/DeepL…）无指令通道，不生效
pref("extensions.zotero.paperpilot.translateGlossary", "");
// 0.4x 术语表领域化：行式第三段「原文 = 译文 | 领域」（多标签 ; 或 , 分隔）；
// 本项为启用域白名单（分号分隔，如 "医学;计算机"）——空串 = 全部启用（默认）。
// 无领域标注的通用术语永不被滤；领域术语须命中白名单才注入。缓存键随过滤结果变化
pref("extensions.zotero.paperpilot.translateGlossaryDomains", "");
// 0.4x 在线词包（数据源 = GitHub open-termbank）：
// PackBase = 自定义取用镜像（空 = 走内置 jsDelivr→raw 回退链；被墙网络可指镜像/代理）
pref("extensions.zotero.paperpilot.translateGlossaryPackBase", "");
// PackState = 已导入域的 sha256 记账（JSON：{"<slug>":"<sha256>"}），用于「有更新」检测
pref("extensions.zotero.paperpilot.translateGlossaryPackState", "");
// 结构化提取（默认开）：阅读器逐页取文优先、全文索引兜底 → 段落块（body/caption/formula）；
// 公式原样直出不送翻、图表注单列、页眉页脚/页码/DOI/坐标轴刻度等高置信垃圾行过滤
pref("extensions.zotero.paperpilot.bilingualStructExtract", true);
// 上下文感知翻译（默认开，仅 llm 引擎消费）：文档标题 + 上一段译文作为上下文
pref("extensions.zotero.paperpilot.bilingualContext", true);
// 行内公式保护（默认开，仅非 llm 引擎启用）：高置信数学片段占位符化，译后原样还原
pref("extensions.zotero.paperpilot.translateFormulaProtect", true);
// 0.34.0 PDF 原位对照翻译（阅读器内把译文按**原文段落坐标**叠加回原页，保留原始排版）：
// 模式 overlay（译文覆盖原文、原文淡显）/ bilingual（原文清晰 + 半透明译文卡）/ off
pref("extensions.zotero.paperpilot.pdfInlineMode", "off");
// 译文卡字号比例（字符串存法同 aiTemperature，代码里 Number() 解析；0.7–1.6）
pref("extensions.zotero.paperpilot.pdfInlineFontScale", "1");
// 译文卡可选中（默认关：卡片 pointer-events:none，不干扰 pdf.js 划词选择）
pref("extensions.zotero.paperpilot.pdfInlineSelectable", false);
// 段间节流（毫秒；免费引擎限流友好，0 = 不等待）
pref("extensions.zotero.paperpilot.pdfInlineGapMs", 120);
// 0.36.0 PDF 对照翻译（左原版 PDF / 右译文，双栏窗口）：
// 同步滚动（页号 + 页内比例映射，默认开；关掉则两栏各自滚）
pref("extensions.zotero.paperpilot.pdfDualSyncScroll", true);
// 同步缩放（两侧同 scaleValue ⇒ 页高一致、位置映射无误差，默认开）
pref("extensions.zotero.paperpilot.pdfDualSyncZoom", true);
// 右栏形态：mono（译文替换原文文字、图表与公式保留）/ overlay（译文叠加 + 原文淡显）
pref("extensions.zotero.paperpilot.pdfDualRightMode", "mono");
// 自检开关（默认关）：置 true 后下次启动自动开一次对照窗口，把左右 pane 挂载情况与
// 右栏每页段落/卡片数写进 paperpilot-boot.log；验完请改回 false
pref("extensions.zotero.paperpilot.pdfDualSelfTest", false);
// 自检开关（默认关）：置 true 后下次启动自动拿库里第一个 PDF 开一次原位对照，
// 把每页段落数/卡片数/首卡落点写进 paperpilot-boot.log —— 「段落抽取错/卡片错位」
// 只有真实 PDF 才暴露；验完请改回 false
pref("extensions.zotero.paperpilot.pdfInlineSelfTest", false);
// 0.37.1 更新提示（默认开）：启动后台检查一次更新清单，**只有确实有更高版本时**才弹
// Zotero 原生通知（Zotero 自身的插件更新是静默的，用户感知不到）。同一版本只提示一次；
// 网络失败静默；可在「设置 → 增强功能」里关掉
pref("extensions.zotero.paperpilot.updateNoticeEnabled", true);
// 0.44.1：上次「运行过」的版本——即使更新是 Zotero 静默完成的，下次启动也会弹一次
// 「已更新到 vX + 本次更新内容」（每版只提示一次）；空 = 尚未记录（首次静默）
pref("extensions.zotero.paperpilot.updateNoticeLastSeen", "");
pref("extensions.zotero.paperpilot.noteTemplatesCustom", "");
pref("extensions.zotero.paperpilot.attachNamePattern", "{author} - {year} - {title}");
pref("extensions.zotero.paperpilot.unpaywallEmail", "");
// 0.27.0 新增：Sci-Hub / Sci-Net 补全文（Unpaywall 未命中时的补充渠道，可在设置关闭）
// 0.43.0：默认镜像链 3 → 7（+ .ren/.ee/.hkvisa.net/.mksa.top，参考 2026 活跃开源项目
// scihub-mcp 与 Zotero 中文社区镜像页）；旧默认值用户由 SciHub.upgradeMirrorsPref()
// 启动时一次性迁移。新增出版商直连（doi.org → citation_pdf_url，校园 VPN/机构订阅
// 兜底 Sci-Hub 停更后的新文献），独立于 Sci-Hub 开关
pref("extensions.zotero.paperpilot.scihubEnabled", true);
pref("extensions.zotero.paperpilot.scihubMirrors", "sci-hub.ru, sci-hub.se, sci-hub.st, sci-hub.ren, sci-hub.ee, sci-hub.hkvisa.net, sci-hub.mksa.top");
pref("extensions.zotero.paperpilot.scinetEnabled", true);
pref("extensions.zotero.paperpilot.scinetUrl", "https://sci-net.xyz");
pref("extensions.zotero.paperpilot.publisherDirectEnabled", true);
// 0.43.0 新增：原生 Find Full Text 集成（fulltext-resolver.js）——启动时把 Unpaywall
// 与 Sci-Hub/Sci-Net（尊重上面的开关）写进 Zotero 内置 extensions.zotero.findPDFs.resolvers，
// 复用原生「查找全文」与「自动下载 PDF」流程；卸载时精确移除。关 = 完全不碰该 pref
pref("extensions.zotero.paperpilot.fulltextResolverEnabled", true);
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
// 0.42.0 新增：中文文献 AI 增强四层（cn-ai.js）
// cnFetchAI      L1 检索词规划 + P3 AI 兜底/自愈总开关（关则全部回退确定性启发式）
// cnFetchAIJudge L3 语义裁决（多候选排序+置信度分档）
// cnFetchCNKIExport P2 双通道：CNKI 命中后经 GetExport 拿 EndNote 权威元数据融合
// cnFetchAIVision P3 视觉路径（扫描件渲染 PNG 喂多模态；Zotero 10+，实验默认关）
// cnAIAutoThreshold / cnAIConfirmThreshold 裁决置信度分档阈值
pref("extensions.zotero.paperpilot.cnFetchAI", true);
pref("extensions.zotero.paperpilot.cnFetchAIJudge", true);
pref("extensions.zotero.paperpilot.cnFetchCNKIExport", true);
pref("extensions.zotero.paperpilot.cnFetchAIVision", false);
pref("extensions.zotero.paperpilot.cnAIAutoThreshold", 0.9);
pref("extensions.zotero.paperpilot.cnAIConfirmThreshold", 0.6);
// 0.43.0 新增：知网个人账号登录（详情页下载按钮只在有权限的会话里渲染）。
// 凭据只存本机 Zotero profile（prefs 数据库），**绝不进 git**；密码 base64 混淆。
pref("extensions.zotero.paperpilot.cnkiUsername", "");
pref("extensions.zotero.paperpilot.cnkiPassword", "");
// 0.43.1 新增：知网链路启动自检（发版前真机功能验证：权限三态/登录/搜索探测 → boot 日志）。
// 默认关；开一次验证完记得关（每次启动都会打一次知网接口）。
pref("extensions.zotero.paperpilot.cnkiBootSelfTest", false);
// 0.14.7 新增：设置界面敏感信息默认掩码（接口地址明文开关）
// 0.43.2：开关 UI 已移除——地址与密钥永久防窥屏隐藏（无明文出口）；
// 历史 user pref 由面板脚本 initShowUrlToggle 清理，本默认值仅为向后兼容保留。
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
// 0.42.0：主窗口收藏夹工具栏的主题按钮默认不注入（入口收敛到设置面板/视图菜单），开此恢复
pref("extensions.zotero.paperpilot.themeMainButtonEnabled", false);
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
// 0.29.0 菜单瘦身：右键/工具菜单结构。grouped（默认）= 高频直达 + 语义分组两层；
// classic = 0.28 及以前的平铺结构（设置窗格可一键切回）
pref("extensions.zotero.paperpilot.menuMode", "grouped");
// 右键菜单中隐藏的分组（逗号分隔组 id：ai/notes/citation/tags/meta/cn/automation/state；
// 隐藏的功能仍可从功能中心、工具菜单、classic 模式到达）
pref("extensions.zotero.paperpilot.menuHiddenGroups", "");
// 右键菜单顶部高频直达项（逗号分隔命令 id，最多 3 个；取值见 menus.js ITEM_REGISTRY）
pref("extensions.zotero.paperpilot.menuQuickItems", "ai-summary,bilingual-view");
// 0.31.0 新增：AI 问答悬浮窗几何记忆（zotero-gpt 式可拖动/停靠悬浮窗）
// chatFloatPos = "x,y"（浮动坐标，px）；chatFloatSize = "w,h"（px）；
// chatFloatDock = "" | "left" | "right"（贴边停靠模式）
// chatFloatOpacity = "1" | "0.9" | "0.75" | "0.6"（整窗不透明度，字符串存法同 aiTemperature）
pref("extensions.zotero.paperpilot.chatFloatPos", "");
pref("extensions.zotero.paperpilot.chatFloatSize", "");
pref("extensions.zotero.paperpilot.chatFloatDock", "");
pref("extensions.zotero.paperpilot.chatFloatOpacity", "1");
// 0.33.0 参考文献一键入库：启用的检索来源（逗号分隔 crossref/openalex/pubmed/europepmc/arxiv/s2；
// 留空 = 全部启用，但**知网 cnki 例外**——它会走风控，必须在对话框里显式勾选，
// 或把 cnki 加进本 pref 才启用）。关掉某个源可显著加快检索，代价是命中率下降。
pref("extensions.zotero.paperpilot.refImportSources", "");
// 0.33.0：Crossref / OpenAlex 的「礼貌池」联系邮箱（填了会获得更高的限速配额，
// 建议填真实邮箱；留空走内置占位值，功能不受影响）
pref("extensions.zotero.paperpilot.refImportMailto", "");
// 0.38.0 设置面板折叠分组：已展开的分组键（CSV，取值为 prefs.xhtml 里 data-fold：
// account/channels/translate/aiparams/popup/columns/tagging/enhance/uitheme/pdftheme/menu）。
// 留空 = 全部收起（默认）；面板里点标题行 / 全部展开会更新本 pref
pref("extensions.zotero.paperpilot.prefsFoldOpen", "");
// 0.38.0 顶部快捷按钮：条目工具栏一键菜单（高频直达项 + 功能中心 + 设置）。
// 直达项内容与右键菜单共用 menuQuickItems（单一真源），在「设置 → 菜单定制」里改
pref("extensions.zotero.paperpilot.quickBarButtonEnabled", true);

// 0.44.0（实验）第三方文献源（文献虫/毕业助手等代查站）：默认关闭；面向 Pro 会员试用；
// 凭据只存本机（base64 混淆，非加密，不上传）。站点清单与登录自检见 features/third-source.js
pref("extensions.zotero.paperpilot.thirdSourceEnabled", false);
pref("extensions.zotero.paperpilot.thirdSourceSite", "wenxianchong");
pref("extensions.zotero.paperpilot.thirdSourceUsername", "");
pref("extensions.zotero.paperpilot.thirdSourcePassword", "");
// 0.44.0（实验）实机验证后补：上次登录测试结果（JSON：at/ok/code/site/username）
// 与账号权限缓存（JSON 数组，登录成功时自动刷新；面板「账号权限」行展示）
pref("extensions.zotero.paperpilot.thirdSourceLastTest", "");
pref("extensions.zotero.paperpilot.thirdSourceEntitlements", "");
// 0.44.2：网点检测缓存（{at, list:[{id,ok,ms}]}，面板「检测入口」后写入）
pref("extensions.zotero.paperpilot.thirdSourceEndpointCheck", "");
// 0.46.0 阅读进度 2.0（条目列表进度条）：三源融合的位置进度（心跳捕获当前页 +
// Zotero 原生上次阅读位置 + 标注页），时长折算作兜底。数据只存本机 pref，不上传。
// readingProgress = {schema, items:{<条目key>:{p:最远页,t:总页数,a:更新ms,
// d:{<页>:分钟}}}}（LRU 3000 条；d = 每页时长，高能进度条的燃料）
pref("extensions.zotero.paperpilot.readingProgress", "");
// ★ 主显示形态：进度直接画在「标题」列背景（对齐 zotero-style 高能进度条挂法），
// 无需勾选任何列。progressRowEnabled 默认开；heat = 每页一格读得越久颜色越深
// （无每页数据时自动回退整体填充），fill = 整体按百分比铺色
pref("extensions.zotero.paperpilot.progressRowEnabled", true);
pref("extensions.zotero.paperpilot.progressRowStyle", "heat");
// 进度口径：auto = 位置优先、无位置时长兜底（默认）/ position = 仅位置 / time = 仅时长（0.42.0 旧行为）
pref("extensions.zotero.paperpilot.progressBasis", "auto");
// 「阅读进度」数据列（默认隐藏，表头右键勾选；主要用于点列头按进度排序）
// 列内样式：bar = 线性填充（默认）/ gradient = 蓝→绿渐变填充 / percent = 仅百分比标注
pref("extensions.zotero.paperpilot.progressBarStyle", "bar");
// 按阅读状态着色：已读绿（--accent-green）/ 在读强调色 / 未读中性灰；关 = 统一强调色
pref("extensions.zotero.paperpilot.progressColorByState", true);
// 进度反向驱动阅读状态：有进度且未读 → 自动「在读」；位置进度 ≥ 阈值且页数真实 → 自动「已读」
pref("extensions.zotero.paperpilot.progressAutoFinish", true);
// 「已读」达标阈值（80-100，百分整数；Mozilla pref 无浮点，同 aiTemperature 存法）
pref("extensions.zotero.paperpilot.progressAutoFinishPct", 95);
