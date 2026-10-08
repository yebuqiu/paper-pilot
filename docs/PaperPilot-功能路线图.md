# PaperPilot 功能路线图（基于 Zotero 插件生态 Top 100 功能借鉴地图）

> 来源：`docs/PaperPilot-功能借鉴地图-Zotero插件Top100.html`（100 个插件 / 16 个功能域 / 23 项「强烈建议参考」）
> 原则：**只借鉴功能与交互设计，不搬运代码**；优先做「本地可验证、无外部强依赖」的能力。

## 一、PaperPilot 当前功能坐标

| 功能域 | 现状 | 说明 |
|---|---|---|
| AI 阅读与问答 | 🟡 已有但可升级 | 问答/总结/综述齐全，缺「跨全库问答」与「入库自动精读」 |
| 翻译 | 🟢 已有 | 划词 + 全文对照已具备 |
| 笔记与卡片 | 🟡 部分覆盖 | 能生成笔记，缺「笔记之间」的关系与管理 |
| 元数据与库健康 | 🟢 基础扎实 | 缺规则深度（DOI 体检、期刊缩写、作者名归一、OCR） |
| 附件与文件管理 | 🟡 部分覆盖 | 有重命名，缺补挂与完整健康扫描 |
| 标签与自动化 | 🟡 打标强、治理弱 | AI 打标无配套的标签归一/层级/合并 |
| 阅读状态与统计 | 🟡 有状态、无行为 | 无阅读时长/热力图/阅读报告 |
| 指标与数据列 | 🟢 已领先 | 分区列 + 被引量列 |
| **检索与发现** | 🔴 空白 | 无文献发现、无库内语义检索 |
| **集成与互操作** | 🔴 基本空白 | AI 能力未对外供给（无 MCP / 本地 API） |
| **插件生态** | 🔴 空白 | 功能中心未升级为能力集市 |
| 界面与主题 | 🟢 明显领先 | 19 套主题 + 壁纸引擎 |
| 引文、导出与写作 | 🟡 部分覆盖 | 有引文追溯，缺导出（citekey/BibTeX） |

## 二、分阶段实施计划

### 阶段 1（本次实施 · 0.22.0）：补「库内检索」与两项治理能力

三个模块，共同特点是**完全本地、无外部强依赖、可离线单测**：

| 模块 | 功能 | 借鉴来源 | 验收标准 |
|---|---|---|---|
| `lib-search` **库内问答** | 自然语言「问自己的库」：中文 bigram + 英文分词的两阶段检索（标题/标签/摘要/作者/笔记加权打分 → Top N 读全文复核）→ AI 生成带 `[n]` 引用编号的回答；可限定分类；结果可存为笔记 | ai4paper（文库级问答）、ZotSeek（库内检索） | 检索命中排序合理（单测：给定库与查询，期望文献进入 Top 5）；未登录时给精确指引而非静默 |
| `tag-curator` **标签治理** | 扫描标签变体（大小写/全半角/空格/连字符）、罕见标签、层级缺失；预览确认后批量归一合并 | zotero-taxonomy-curator | 变体检测零漏报（单测覆盖 DNN/dnn、机器学习／机器学习、deep-learning/deep learning）；归一后全库无重复变体 |
| `attach-doctor` **附件体检** | 无附件条目、断链附件、同父重复附件、无文本层 PDF（AI 不可读）、存储目录孤儿文件；输出报告并打标签，**不做破坏性操作** | zotero-attachment-scanner、zotero-storage-scanner | 五类问题各自可复现；孤儿文件检测在 API 不可用时明确报告「已跳过」而非静默 |

### 阶段 2：把 AI 从「手动」变「自动」，把笔记从「孤岛」变「网络」

| 模块 | 功能 | 借鉴来源 |
|---|---|---|
| 入库自动精读 | 新条目入库 → 自动生成结构化笔记（研究问题/方法/结论/局限）；带白名单、每日上限、成本闸门 | zotero-AI-Butler |
| 笔记关系图谱 | 笔记 ↔ 条目 ↔ 笔记的双向链接与关系图窗口；笔记大纲整理 | zotero-better-notes |
| 图表速览 | 抽取图中图/表/公式集中浏览，支持「选中图直接问 AI」 | zotero-figure |
| 阅读行为统计 | 阅读会话计时、逐页热度、热力图日历、周报（依赖 tab 事件，需先验证稳定性） | Chartero |
| 一键自动化引擎 | 可视化「触发-条件-动作」配置器（入库/打标/改字段/跑 AI），替代现有单点规则 | zotero-actions-tags |

### 阶段 3：补两个空白功能域

| 模块 | 功能 | 借鉴来源 |
|---|---|---|
| 文献发现 | 库兴趣向量 → arXiv 每日增量推荐 → 站内推荐列表（推送通道后置） | zotero-arxiv-daily |
| MCP 对外供给 | 把「库检索 / 读全文 / 读批注 / 写笔记」封装为 MCP 工具，供外部 AI 客户端使用（仅 127.0.0.1 + 鉴权） | cookjohn/zotero-mcp |
| 元数据规则补齐 | 期刊缩写全称互转、作者名归一化、DOI 有效性体检、问题清单 + 勾选修复 | zotero-format-metadata |
| 能力集市 | 功能中心升级为「按场景推荐配置包 + 可选插件索引」（含来源白名单） | zotero-addons |

> **实际落地（0.24.0）**：前三项已实现（见第八节）；**「能力集市」本轮未做** ——
> 它本质是「分发别人的插件」，涉及来源可信度与版本适配的长期维护成本，
> 在当前阶段收益低于前三项，留待有明确的生态策略后再评估。
> 另：文献发现未采用「向量化库兴趣」，而是**词元加权画像**（无嵌入依赖、可离线单测）；
> 若后续命中率不足，可与阶段 4 的向量检索一并升级。

### 阶段 4（评估后决定）

- **OCR 文本层**：扫描版 PDF 的 AI 可用性（需外部二进制，做成可选依赖）
- **跨全库向量检索**：若阶段 1 的关键词检索命中率不足，再引入本地嵌入索引
- **导出与写作**：citekey/BibTeX 导出（优先做「检测到 Better BibTeX 则联动」的轻方案）
- **全文获取补充渠道（0.27.0 落地）**：原「明确不做 Sci-Hub 类全文获取（法律风险）」的决策于 2026-10-08 反转（用户决策）——Unpaywall 未命中时可选接力 Sci-Hub / Sci-Net 补 PDF（默认开启、设置可关、镜像可配置；仅供个人学术研究用途）
- 明确不做：Word/LibreOffice 深度集成（超出插件边界）

## 三、风险与约束

1. **AI 未就绪必须显式提示**：任何功能都不得在 `AIClient.hasKey()` 为假时静默 return（历史投诉根因）。
2. **破坏性操作一律「预览 → 确认 → 可回滚」**：标签合并、批量重命名、附件清理都属于此类。
3. **Zotero 7–10 跨版本**：内部 API（全文索引、标签、存储目录）逐版本探测 + try/catch 降级，不可用时明确报「跳过」。
4. **成本闸门**：涉及批量 AI 调用的功能必须提供每日上限与白名单。

## 四、进度

- [x] 阶段 1：`lib-search` / `tag-curator` / `attach-doctor`（0.22.0，2026-10-03 已发版）
- [x] 阶段 2 第一批：`automation`（自动化引擎）/ `auto-read`（入库自动精读）（0.23.0，与 B 线会员体系合并发版）
- [x] 阶段 2 第二批：`note-graph`（笔记关系图谱）/ `reading-stats`（阅读行为统计）（0.23.0 一并发版；`figure-view` 图表速览暂缓，理由见下）
- [x] 阶段 3：`discovery`（arXiv 日推）/ `mcp`（MCP 对外供给）/ `meta-rules`（元数据规则补齐）（0.24.0）
- [ ] 阶段 4

> **图表速览为何暂缓**：从 PDF 抽取图/表/公式依赖 pdf.js 算子级的版面分析（坐标聚类 + 图像对象识别），
> 效果高度依赖真实 PDF 的多样性——没有真机样本无法验证准确率，写出来的大概率是「看起来做了但不好用」。
> 建议等真机验证环节有具体样本文献后再做，避免产出无法评估的功能。

## 五、阶段 1 实施记录（0.22.0）

### 新增文件

| 文件 | 说明 |
|---|---|
| `chrome/content/scripts/features/lib-search.js` | 库内问答核心：分词（中文 bigram + 英文词 + 停用词）、字段加权打分（标题 5 / 标签 3 / 期刊 2 / 摘要 2 / 作者 1.5 / extra 1）、覆盖率加成（`total × coverage^0.5`）、全文复核（整串命中 +6、词元每个 +1，并抽取命中片段）、上下文组装（按 `libSearchContextChars` 预算截断）、AI 回答与存笔记 |
| `chrome/content/lib-ask.xhtml` + `lib-ask.js` | 问答对话框：问题输入（Ctrl/⌘+Enter 直接检索）、范围选项（当前分类 / 只搜有附件 / 全文复核 / 候选上限）、候选列表（相关度 + 命中字段 + 命中片段，点击在主窗口定位）、AI 回答区（Markdown 渲染）、存为笔记、状态栏 |
| `chrome/content/scripts/features/tag-curator.js` | 标签治理：`_norm`（全角→半角、空白归一、去尾随标点、小写）、`_shape`（再抹分隔符）、`analyze`（变体分组 + 规范形择优 + 罕见标签 + 层级缺失）、库级重命名（`Zotero.Tags.rename` 优先，回退按标签搜索逐条目 `setTags`） |
| `chrome/content/scripts/features/attach-doctor.js` | 附件体检：无附件 / 无 PDF / 文件丢失断链 / 同父重复（文件名+体积）/ 无文本层 PDF（`AIChat._readIndexedText`，上限 300 篇）/ storage 孤儿文件（`IOUtils` 遍历 + attachmentPath 比对）；接口不可用时显式记入 `skipped` 并写入报告 |

### 接入点

- `main.js`：加载 3 个模块并暴露为 `Zotero.PaperPilot.libSearch / tagCurator / attachDoctor`
- `menus.js`：工具菜单新增「库内问答…」；条目右键新增「附件体检」「标签治理（只读）」「标签归一（执行合并）」
- `hub.js`：新增「🧭 检索与发现」类别（库内问答）；「🩺 库健康」新增「附件体检」；「🏷 标签与状态」新增标签治理/归一
- `prefs.js`：`libSearchContextChars`（12000）、`libSearchTopN`（8）
- `utils.js`：I18n 新增 4 条菜单文案

### 验证证据

| 检查 | 结果 |
|---|---|
| 逐文件语法检查（`node --check` × 8，XHTML XML 解析 × 1） | 全部通过 |
| 核心逻辑单测（`E:/tmp/pp_test/pp22-test.js`，vm + 最小 mock） | **47 项断言全通过**：归一化 8 项（含全角字母/全角空格/尾随标点/全角斜杠）、变体分析 12 项、分词 7 项、打分与覆盖率 3 项、全文复核 3 项、上下文与消息 7 项、附件报告渲染 7 项 |
| 全模块加载冒烟（`pp22-smoke.js`，深 Proxy 顶替 Zotero/Services） | 按 main.js 顺序加载 **42 个模块，0 失败**，关键全局无缺失 |
| 接线一致性（静态扫描） | hub.js 的 `PP.*` 引用全部在 main.js 暴露；menus.js 调用的 26 个模块名均有声明；features 目录无漏加载文件 |
| 打包产物复测 | `dist/paper-pilot-0.22.0.xpi`（73 文件）解包后重跑单测（47/47）与冒烟（42/42）**全绿**，包内 manifest version = 0.22.0 |

### 发版记录（2026-10-03 完成）

| 项 | 状态 |
|---|---|
| 提交 | `9338d24`「0.22.0: 库内问答 + 标签治理 + 附件体检」（另有 `2f7b11e` 为 0.21.3 的 PDF 对比修复，此前未提交，一并清账） |
| 标签 | `v0.22.0`（Gitee 已推送；GitHub Releases 自 v0.14.5 后停用，不再创建） |
| Gitee | `main` 已推送；远端 `paperpilot-update.json` 最新版本 = 0.22.0；`dist/paper-pilot-0.22.0.xpi` 下载 **sha256 与本地一致**（309745 字节，包内 73 文件 / manifest 0.22.0） |
| GitHub | API 同步完成（commit `c0fa878ebf`，自检「远端 132 个 blob 与本地完全一致」）；raw 通道 update.json 与 xpi 均 200 可访问 |
| 客户端 | **未做真机验证**：需在 Zotero 中实装 0.22.0 后验证三个入口与对话框（本地强制升级流程见项目记忆） |

> 提示：Zotero 只在**自己启动时**检查扩展更新。若已装旧版，重启 Zotero 后应能收到 0.22.0 的更新提示；界面若仍停在旧版，按「三处交叉核对客户端真实版本」的方法排查。

## 六、阶段 2 第一批实施记录（0.23.0）

### 新增文件

| 文件 | 说明 |
|---|---|
| `chrome/content/scripts/features/automation.js` | 自动化引擎：规则存储（`automationRules` JSON）、`validate()`（字段/操作/动作白名单校验）、`compileRegex()`（**剥掉 `(?i)` 前缀 + 默认忽略大小写**）、`matchCondition` / `matchRule`（all/any/无条件）、`planActions`（幂等：已有标签/相同字段值不再产生变更）、`preview`（只统计不落库）、`apply(rules, items, dryRun)`、`importFromRuleTag()`（把旧行式规则转成单条件规则）、`presets()`（4 条内置示例，默认不启用）、newItem / readerOpen 两个 Notifier（4s 防抖 + 每批上限） |
| `chrome/content/automation.xhtml` + `automation-ui.js` | 规则编辑器：左列规则卡（启用勾选/校验提示/编辑/删除），右侧表单（名称/触发/匹配方式/条件行增删/动作行增删，动作参数随类型切换控件，分类下拉取自真实分类），顶部全局开关区（自动触发 2 个开关 + 入库自动精读的启用/白名单/每日上限），「对选中条目试跑（只预览）」按钮 |
| `chrome/content/scripts/features/auto-read.js` | 入库自动精读：三道闸门（默认关闭 / 每日上限 / 幂等）、`canRun()` 给出可读原因、`inScope()` 分类白名单、`eligible()` 综合判定（常规条目 + 有 PDF + 未精读 + 在范围内）、串行队列 + 单条进度窗、跨日额度自动归零、手动入口 `runForSelected()` 也会遵守额度并明确告知截断 |

### 顺手修掉的一个真 bug（影响既有功能）

`rule-tag.js` 文档里给的示例操作符 `regex` 用了 `(?i)heart|cardio` —— 但 **JS 的 `RegExp` 不支持 `(?i)` 这种内联标志**（那是 Java/Python 语法），`new RegExp("(?i)…")` 直接抛异常，又被 `try/catch` 吞掉，结果是**规则静默永不命中**（用户视角＝「规则写了没用」）。现在 `rule-tag.js` 与 `automation.js` 都改为 `compileRegex()`：剥离 `(?i)` / `(?-i)` 前缀，默认加 `i` 标志，`(?-i)` 显式要求区分大小写。

### 验证证据

| 检查 | 结果 |
|---|---|
| 语法检查（`node --check` × 7，XHTML × 1） | 全部通过 |
| 核心逻辑单测（`E:/tmp/pp_test/pp23-test.js`） | **78 项断言全通过**：规则校验 10 项、条件求值 17 项（含 9 种操作、正则大小写三种情形）、动作规划幂等 10 项、预览与 dry-run 7 项、存储/导入/预设 10 项、AutoRead 额度闸门 12 项、白名单与幂等 9 项、其余为边界用例 |
| 全模块加载冒烟 | 按 main.js 顺序加载 **44 个模块，0 失败**，关键全局无缺失 |
| 接线一致性 | hub 的 `PP.*` 全部有暴露；menus 调用的模块名均有声明；features 无漏加载；两个新对话框的脚本引用均存在 |
| 打包产物复测 | 见下方发版记录 |

### 发版记录（2026-10-03）

| 项 | 状态 |
|---|---|
| 提交 | `0.23.0: 自动化引擎 + 入库自动精读（阶段 2 第一批）` |
| Gitee | `main` + 标签 `v0.23.0`；远端 `paperpilot-update.json` 最新版本 = 0.23.0 |
| 产物校验 | `dist/paper-pilot-0.23.0.xpi` 远端 sha256 与本地一致、包内 manifest 版本一致 |
| GitHub | API 同步 + tree 自检一致 |

## 七、阶段 2 第二批实施记录（笔记关系图谱 + 阅读行为统计）

### 新增文件

| 文件 | 说明 |
|---|---|
| `chrome/content/scripts/features/note-graph.js` | 笔记关系图谱：`extractLinks()` 解析四类链接（`zotero://select/.../items/<KEY>`、`zotero://open-pdf/...`、`zotero://note/u/<KEY>`、`[[标题]]`）；`buildGraph()` 构图（归属边 + 链接边 + 附件经 parentKey 归并到父条目 + wiki 标题匹配 + 悬挂边剪除 + 按连接度截断）；`layout()` 确定性力导向布局（固定种子 LCG + 黄金角初始分布 + **低连接度节点向心力**，避免孤立点沿画布边缘排成直线）；`collect()` 采集条目/笔记/附件记录 |
| `chrome/content/note-graph.xhtml` + `note-graph-ui.js` | 图谱窗口：SVG 渲染（节点大小=连接度的平方根、颜色区分条目/笔记、只给高连接度节点打标签）、边类型配色与图例、点节点在主窗口定位、范围/「只显示有连接的节点」开关、统计状态栏 |
| `chrome/content/scripts/features/reading-stats.js` | 阅读行为统计：**心跳采集**（每 60s 检查焦点阅读器属于哪篇，命中 +1 分钟——不依赖 tab open/close 事件配对，避免「打开后没关=假的 8 小时」）；pref 存储 + 60 天滚动保留；`aggregate()` / `heatmap()` / `human()`；报告笔记为**原生 HTML**（日历热力图 + 每周列对齐 + 每日明细 + 时长 Top15 + 免责说明） |

### 验证证据

| 检查 | 结果 |
|---|---|
| 语法检查（`node --check` × 7，XHTML × 1） | 全部通过 |
| 核心逻辑单测（`E:/tmp/pp_test/pp24-test.js`） | **76 项断言全通过**：链接抽取 12 项、构图 16 项（含附件归并、悬空边剪除、截断、去重）、布局 7 项（有限性/边界/确定性/空输入）、存储与日期 9 项、聚合与热力图 22 项、心跳 7 项 |
| 前两批单测回归 | 47/47（阶段 1）+ 78/78（阶段 2 第一批）全绿 |
| 全模块加载冒烟 | **46 个模块，0 失败**，关键全局无缺失 |
| 接线一致性 | hub 的 34 个 `PP.*` 引用全部有暴露；menus 调用模块名均有声明；features 无漏加载；三个新对话框的脚本引用均存在 |
| 布局质量（`E:/tmp/pp_test/graph-preview.js` 合成 48 节点/60 边） | 边长 min/avg/max = 40/105/193 px，画布占用 602×454（900×620）——无节点重叠、无边缘堆叠 |

### 本次实修的两个模型问题

1. **附件记录缺失导致 pdf 链接解析失败**：`collect()` 原来只采集条目与笔记，笔记里的 `zotero://open-pdf/.../items/<附件KEY>` 找不到附件记录 → 边指向不存在的节点。现在采集附件记录（仅作解析中介），`buildGraph()` 里把附件排除出节点集。
2. **悬空边污染统计**：指向未采集 key（群组库条目等）的边原本会计入 degree 与边数。现在统一剪除「端点不在可见节点集合里」的边，再据此重算连接度。

## 八、阶段 3 实施记录（0.24.0）

### 新增文件

| 文件 | 说明 |
|---|---|
| `chrome/content/scripts/features/discovery.js` | 文献发现：`buildProfile()`（标题 ×3 / 标签 ×3 / 期刊 ×2 / 摘要 ×1 加权词频，泛词过滤下限 3 条）+ `extractArxiv()`（从 extra / url / archiveID 抽 arXiv id 与分类）+ `parseAtom()`（自写 arXiv Atom 正则解析器，含 XML 实体解码）+ `scoreEntry()`（标题 ×3 / 摘要 ×1 + 分类加成 + 7 天新近度）+ `rank()`（去重 / 排除已入库 / 排除忽略 / 截断）+ `buildQuery()`（分类优先，否则画像词元）+ `run()`（全流程 + 按天缓存）+ 每日定时 + `collect()`（建 preprint 条目并加入「arXiv 推荐」分类） |
| `chrome/content/discovery.xhtml` + `discovery-ui.js` | 推荐窗口：分类输入、刷新、每日自动刷新开关、卡片（标题 / 作者 / 日期 / 分类 / 命中理由 / 摘要展开）、打开 / PDF / 收藏到库 / 忽略、存为笔记、恢复已忽略 |
| `chrome/content/scripts/features/mcp.js` | MCP 服务：JSON-RPC 2.0 核心（`handleMessage` / `handlePayload`，支持 initialize、tools/list、tools/call、ping、resources/list、prompts/list 与 batch）、8 个工具定义与实现、Bearer 鉴权（常量时间比较）、`Zotero.Server.Endpoints['/paperpilot/mcp']` 注册（GET 返回 info / POST 走 JSON-RPC）、`serverStatus()` 与 `ensureServer()`（检测并恢复 Zotero 本地 HTTP 服务）、端到端 `selfTest()` |
| `chrome/content/mcp.xhtml` + `mcp-ui.js` | 状态与配置窗口：启停、端点、令牌（显示 / 重置）、工具清单、Zotero 本地服务状态（含一键启用）、自检、可复制的客户端配置 JSON |
| `chrome/content/scripts/features/meta-rules.js` | 元数据体检：`normJournal` / `journalIndex`（内置 100 条刊表 + 用户自定义）/ `journalHint`（expand \| abbrev \| both \| off）/ `normalizeCreators`（单栏拆分、逗号逆序、全角空格与空白、尾随句点且不误伤 Jr.）/ `doiHint` / `fixPages` / `snapshot` / `detect`（9 条规则，fix 与 warn 两类）/ `scanAll`（含重复 DOI 索引）/ 报告与笔记 |
| `chrome/content/meta-rules.xhtml` + `meta-rules-ui.js` | 体检窗口：范围（选中 / 整库）、期刊方向、按「分组 → 规则 → 条目」渲染的清单、逐条与逐规则勾选、全选 / 全不选、修复勾选项、存为报告笔记 |

### 实修的两个问题（写测试时暴露）

1. **`snapshot()` 漏读必备字段** → 「类型必备字段」规则会对**所有**条目误报「缺少出版社 / 授予单位」等：这些字段不在快照里，判定恒为空。现补上 publisher / university / institution / issuingAuthority。
2. **画像泛词过滤下限过严** → 下限取 2 时，小库（新用户只有几篇）里「出现在 2 篇」的真兴趣词会被当成泛词剔除，画像接近清空 → 用户视角「推荐没效果」。改为下限 3。

### 验证证据

| 检查 | 结果 |
|---|---|
| 语法检查（`node --check` × 10，XHTML × 3，prefs.js） | 全部通过 |
| 阶段 3 单测（`E:/tmp/pp_test/pp-s3-test.js`） | **155 项断言全通过**：MetaRules 47 项（归一化 / 刊名表与方向 / 作者名 8 种情形 / DOI 三类 / 页码 / 规则命中 / 重复 DOI / 报告）、Discovery 60 项（Atom 解析含实体解码与中文作者 / 画像 / 打分权重 / 排序去重 / 查询构造 / 端到端 run 与缓存）、MCP 48 项（工具定义与深拷贝隔离 / 协议协商 / 通知 / 批量 / 9 类错误码 / 5 种鉴权 / HTTP 状态码 503·403·200·204 / 工具错误 / 注册注销 / 本地服务状态与恢复） |
| 前序回归 | 47（阶段 1）+ 78（阶段 2 第一批）+ 76（阶段 2 第二批）全绿 |
| 全模块加载冒烟 | **49 个模块 0 失败**，关键全局无缺失，三个新模块的纯函数加载后可用 |
| 接线一致性 | hub 的 37 个 `PP.*` 全部有暴露；menus 调用的 33 个模块名均有声明；features 无漏加载；6 个对话框脚本、windowtype 唯一性、3 个单实例枚举名全部匹配；阶段 3 用到的 11 个 pref 键均有默认值 |

### 关于 MCP 载体的一次实勘

本机实测 `http://127.0.0.1:23119/connector/ping` 返回 **HTTP 000**（当时 Zotero 进程未运行）。
查 omni.ja 确认：端点由 Zotero 自带的连接器服务承载，受核心 pref `httpServer.enabled`（默认 **true**）控制，
`zotero.js:718` 在启动时按该开关调用 `Zotero.Server.init()`；
且 `Zotero.Server.responseCodes` **没有 401 / 202**（可用码见 `server.js`），
故鉴权失败改用 **403**、纯通知响应用 **204**。
据此新增 `serverStatus()` / `ensureServer()`：窗口显式展示本地服务状态，被关闭时可一键恢复，
避免「客户端配好了却连不上」这类静默失败。

### 真机验证（仍未做）

Zotero 当前运行的是 **0.21.3**（profile 内 xpi 时间 10-03 01:00 + boot 日志 `startup begin v0.21.3`），
即 **0.22.0 / 0.23.0 / 0.24.0 均未在 Zotero 中实装过**。需要重启或本地强制升级后实测：
阶段 1 三个入口、阶段 2 的自动化与笔记图谱、阶段 3 的三窗口与 MCP 端到端（`selfTest`）。
