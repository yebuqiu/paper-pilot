# Papilot 文献副驾

**给 Zotero 装一个 AI 副驾**：划词翻译、PDF 左右对照译文、库内问答、参考文献一键入库、自动化规则、阅读进度——一个插件覆盖「读文献」的整条链路。

![version](https://img.shields.io/badge/version-0.72.1-blue)
![zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-orange)
![license](https://img.shields.io/badge/license-Apache--2.0-green)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

[**中文**](README.md) ｜ [English](README.en.md)

> **0.55.0 更名**：项目由 **PaperPilot** 更名为 **Papilot**（仓库 `zotero-papilot`）。插件 ID、偏好分支与本地数据文件同步更换；老用户按[第 8 节](#8-从-paperpilot-升级)操作，设置与登录态会自动迁移。

---

## 1. 项目简介

Papilot 是运行在 **Zotero 7–10** 内的第三方插件，定位是「文献副驾」：Zotero 负责收集与引用，Papilot 负责你打开一篇 PDF 之后的事——读懂它、翻译它、问它、把结论沉淀成笔记、把引文补回库。

它由两部分组成，版本各自独立演进：

| 组成 | 说明 | 是否需要你部署 |
|---|---|---|
| **插件本体** | `bootstrap.js` + `chrome/content/**`，Manifest V2 扩展，约 100 个模块 | 否，装 `.xpi` 即用 |
| **账号后台** | `server/`，纯 Node 标准库、零第三方依赖；提供注册登录、官方 AI 网关与管理页 | **普通用户不需要**（官方托管在 `pp.xinglintools.top`）；自建或二次开发才需要 |

三条设计原则：

- **本地优先**：文献、笔记、阅读记录都在你的 Zotero 库里；只有你主动发起的 AI 请求与元数据查询会联网。
- **不锁定模型**：内置 14 个通道预设（11 家云厂商 + 本地 Ollama + 官方账号 + 自定义端点）；翻译另走 16 个引擎，其中 10 个免密钥。
- **不劫持 Zotero**：所有能力以菜单项、面板、列、对话框形式出现，禁用插件后 Zotero 行为完全复原。

---

## 2. 功能特性

功能入口统一在 **功能中心**（`工具 → Papilot ▸ → Papilot 功能中心`），下面按功能中心的八个分组罗列，括号内是实际菜单名。

### 2.1 阅读助手（作用于当前选中文献）

- **AI 工作台**：独立窗口对话，跟随主窗口选中条目，流式输出、多会话。
- **AI 总结 / 翻译标题与摘要 / 深度解读**：分别生成 300–500 字结构化总结、学术语气译文（术语保留英文）、五段式解读（问题/方法/实验/创新/局限），结果落成 Zotero 笔记。
- **PDF 对照翻译（左原版 / 右译文）**：左栏原版页面、右栏同一页译文，按原文段落位置逐段对照，图表与公式保留，同步滚动，可导出双语笔记。
- **AI 问答悬浮窗**：`Ctrl+Shift+K`（主窗口）/ 阅读器工具栏按钮 / `Ctrl+Enter` / 条目右键 / 划词浮窗五个入口；悬浮、贴边停靠、分屏独立窗口三种形态**共享同一会话**。
- **AI 问答侧栏 / 划词浮窗 / PDF 速览**：选中条目即在右侧栏出现问答与摘要开篇；阅读器内划词即翻译、解读、追问。
- **AI 思维导图**：生成层级大纲笔记，可导出 markmap `.md`。
- **技能商店**：浏览、安装、自制 AI 技能包（提示词标签 / 术语表 / 笔记模板 / Agent 预设四类声明式资产）。
- **入库自动精读**：新条目入库自动生成总结笔记并打 `#AI精读`（默认关闭，受每日上限与分类白名单限制）。

### 2.2 检索与发现（跨整个库）

- **库内问答（问整个库）**：一句话提问 → 两阶段检索（标题/标签/摘要加权 → 全文索引复核）→ AI 依据候选作答，结论带 `[n]` 引用编号并可点击定位；可限定当前分类、只搜有附件条目，回答可存为库级笔记。
- **库内检索**：只出候选与命中片段，不调用 AI。
- **文献发现（arXiv 每日推荐）**：用库内文献建兴趣画像 → 按分类拉最新提交 → 打分排序 → 自动排除已入库；结果可收藏到「arXiv 推荐」分类或存为笔记。默认关闭。
- **检索订阅**：**按期刊订阅**——内置 525 种跨学科期刊（18 个学科、中文别名，ISSN 已逐条核验），搜中文名 / 缩写 / ISSN 就能一键订阅该刊新文章，不用去期刊官网找 RSS、也不用自己拼检索式；目录外的刊可直接搜 OpenAlex 3 万+ 刊源。也可按库内研究领域推荐主题（含作者追踪）或用一句话建订阅；先试跑预览，定时多源检索（arXiv / OpenAlex / Crossref / Europe PMC / PubMed）、去重入库、生成速递笔记。

### 2.3 笔记与卡片

- **收集批注为笔记**、**AI 解读批注**（提炼高亮背后的主线）。
- **笔记大纲与批量整理**：选中笔记（或选中文献自动取其全部笔记）→ 生成/刷新文首目录（**不改笔记标题**）、一键移除大纲、批量加/去标签、移入当前分类、统一标题前缀、合并为一条新笔记（原笔记一律保留）。
- **按模板新建笔记**：阅读笔记 / 精读卡片 / 速读记录；模板支持 `{{#if 字段}}…{{else}}…{{/if}}` 条件块、`{{#each tags}}…{{/each}}` 循环与十余个字段占位符（卷期页、期刊缩写、分类、标签、条目 key 等），模板可自定义。
- **AI 制卡导出 Anki**：基于全文生成问答卡，导出 Anki 可导入的 `.txt`。
- **文本双栏对照（备用出口）**：纯文本左右对照，用于无文本层的轻量场景。
- **笔记关系图谱**：把条目与笔记的 `zotero://` 链接、`[[标题]]` 双链画成可交互图谱，点节点回主窗口定位。
- **导出到 Obsidian**：选中条目 → 写入 vault 的 `Papilot/` 子目录，每篇一个 Markdown 文件，含 front-matter（作者/年份/期刊/DOI/标签/分类/Zotero 反向链接）、摘要、批注摘录与一条 GB/T 7714 引用。**只写不回读**，同名文件自动加 `-2` 不覆盖。
- **综述工作台**：多篇文献 → 大纲 → 分节草稿。

### 2.4 批量分析（需选中 2 篇以上或一个分类）

- **多篇 PDF 并排对比**：最多 4 篇同屏（横向 / 纵向 / 2×2），同步滚动与缩放可选，只读预览已有高亮。
- **AI 文献矩阵**：按维度抽取生成对比表格笔记。
- **AI 文献综述**：多篇生成带引用编号的综述段落。
- **引文追溯**：参考文献 / 施引文献分析笔记。
- **参考文献一键入库**：粘贴 DOI、标题、链接、PMID、arXiv ID、BibTeX，或联合检索 Crossref / OpenAlex / PubMed / Europe PMC / arXiv / Semantic Scholar；自动判重、AI 只填空不覆盖，可导出 BibTeX / EndNote。
- **GB/T 7714 参考文献导出**：选中条目 → 顺序编码制或著者-出版年制，可选类型标识（`[J]`/`[M]`/`[D]`…）、是否附 DOI、作者列举上限；先预览再复制，或另存 `.txt`，可直接粘进 Word。中文与英文姓名按国标分别处理（超 3 位用「等 / et al.」）。
- **分类条目统计 / 文献统计图谱 / 阅读报告**：当前分类统计、年份-期刊-作者-标签分布 HTML 报告、近 30 天阅读时长与日历热力图。

### 2.5 库健康

- **中文文献**：中文文件名识别元数据（知网/万方命名）、抓取中文元数据（公益学术平台 + 知网，可带 PDF）、更新中文转换器、知网风控验证、**知网个人账号登录**（凭据只存本机）、下载目录附件自动匹配。
- **元数据**：S2 补全空缺字段（不覆盖已有值）、规范清洗（DOI/日期/标题/URL）、**元数据体检**（刊名缩写↔全称、作者名归一、DOI 有效性、类型必备字段、重复 DOI，出清单后勾选修复）、**元数据医生**（Crossref 反查补 DOI/期刊/年份，预览→确认→可撤销）。
- **真伪与清理**：真假文献识别（AI 幻觉检测）、粘贴文献列表逐条核验、智能清理（重复/无附件/缺元数据）。
- **附件**：附件体检（无附件、文件丢失、同父重复、无文本层 PDF、存储孤儿文件；**只出报告，不删不移**）、按 `{author} - {year} - {title}` 规则重命名。
- **扫描件 OCR**：检测到无文本层 PDF 时，用内置 pdf.js **在本机**逐页渲染，再把当前页图片交给你的视觉模型通道转写；结果只存本机，之后 AI 问答/翻译/综述会自动使用。支持页数上限、渲染倍率、跳过已识别页（可中断续跑）。
- **补全文**：Unpaywall（合法 OA）优先，未命中按设置回退 Sci-Hub / Sci-Net / 出版商直连；可把解析器注入 Zotero 原生「查找全文」。

### 2.6 标签与状态

- **AI 自动打标签**：结构化 JSON 输出 + 受控词表（复用库内既有写法）+ 置信度阈值 + 指纹缓存。
- **规则打标**：`标签 | 字段 | 操作 | 值` 行式规则，支持 `contains / !contains / regex / = / != / > / < / exists`。
- **自动化规则（触发 → 条件 → 动作）**：触发器为新条目入库 / 打开 PDF / 手动对选中条目；条件 17 字段 × 9 操作（含正则）；动作可打标签、去标签、写白名单字段、设阅读状态、加分类、AI 总结、AI 打标；带**试跑预览**（只统计命中，不落库）。
- **标签治理 / 标签归一 / 嵌套标签视图**：先出只读报告（大小写、全半角、空格与连字符变体，罕见标签，层级缺失），确认后才合并；`#a/b` 层级只读浏览。
- **阅读状态三态**：未读 / 在读 / 已读，互斥；打开 PDF 自动转「在读」，进度达阈值自动转「已读」。

### 2.7 集成与互操作

- **MCP 对外供给**：把库能力封装为 10 个 MCP 工具——`search_library`、`get_item`、`read_fulltext`、`list_annotations`、`create_note`、`list_collections`、`library_stats`、`list_recent`、`list_agent_tools`、`run_agent_tool`，供 Claude Desktop / Cursor / 自建 Agent 调用。载体是 Zotero 自带的本地 HTTP 服务（`127.0.0.1:23119`），零额外进程；**默认关闭**，开启后每请求校验 Bearer 令牌，写类工具还需显式 `allowWrite: true`。

### 2.8 数据列与配置

- **期刊分区列**：easyScholar 在线数据 + 离线兜底，支持中英文体系（中科院分区 / PKU / CSCD / CSSCI / 核心），badge 数量与配色可调。
- **被引量列**：Semantic Scholar 被引数，可手动刷新。
- **阅读进度**：主形态直接画在**标题列背景**（每页一格，读得越久越深），三源融合（心跳页码 + Zotero 原生上次位置 + 标注页）；另有「阅读进度」列用于按进度排序。
- **标题译文列 / 星标评级列**。
- **主题**：界面主题（标准 / 动漫 / 风景 / 动态壁纸 + 自定义图片或视频）与 PDF 阅读主题（护眼叠色、夜间反色、自定义色）。
- **菜单定制**：`grouped`（默认，高频直达 + 9 个语义分组）或 `classic`（平铺），可隐藏分组、自定义顶部三个直达项。
- **云同步（坚果云）**：设置项 / AI 对话 / 技能包与安装包统一走坚果云 WebDAV；增量同步、冲突两份都留、大文件分卷、断网自动重试。详见 [坚果云云同步-移植方案与风险评估](docs/坚果云云同步-移植方案与风险评估.md)。

### 2.9 账号（可选）

- 不登录也能用：翻译、数据列、主题、库健康、自动化、MCP 全部本地可用。
- 登录后：可直接使用官方 AI 通道（无需自备 Key），并可查看本机登录设备。
- 也可以改用自备 API Key 或本地模型，完全不依赖账号。

---

## 3. 安装

### 3.1 环境要求

| 项 | 要求 |
|---|---|
| Zotero | **7 / 8 / 9 / 10**（`strict_min_version 6.999`，`strict_max_version 99.*`） |
| 操作系统 | Windows / macOS / Linux |
| 账号后台（仅自建） | Node ≥ 14；**零第三方依赖** |

### 3.2 安装插件

1. 从 [Releases](../../releases) 下载最新的 `papilot-x.y.z.xpi`（仓库内 `dist/` 也有历史产物）。
2. Zotero → **工具 → 插件** → 右上角 **齿轮 → 从文件安装插件**。
3. 选择 `.xpi` → 重启 Zotero。
4. 打开 **设置 → Papilot**，按第 3.3 节配置 AI 通道。

> 第三方插件的更新在 Zotero 里是**静默替换**的。Papilot 自带更新提示：启动 15 秒后后台检查一次清单，**只有确实有更高版本时**才弹 Zotero 原生通知，同一版本只提示一次。

### 3.3 首次配置（三种选择，任选其一）

| 方式 | 操作 | 适用 |
|---|---|---|
| **官方账号** | 设置 → Papilot → 账号 → 注册/登录；模型通道选「Papilot 账号系统」 | 不想自己申请 Key |
| **自备 API Key** | 设置 → Papilot → 模型通道 → 新增通道，选厂商预设填 Key，或填自定义 Base URL | 已有厂商账号、想控成本 |
| **本地模型** | 通道选 `Ollama（本地）`，Base URL `http://127.0.0.1:11434/v1` | 完全离线 |

配完点 **接口连通性测试**（`工具 → Papilot ▸ → 接口连通性测试`）确认可用。

### 3.4 从源码构建

无打包器、无编译步骤：

```bash
python scripts/build-xpi.py 0.55.0     # → dist/papilot-0.55.0.xpi
```

脚本会校验源文件齐全、写出 zip、再解包自检「包内清单 == 预期清单」并打印 `manifest` 版本与条目数。

---

## 4. 运行方式

### 4.1 插件（所有用户）

插件随 Zotero 启动，无需额外进程、无需常驻后台。启动时在 **帮助 → 调试输出** 打一条 `Papilot startup`；自检日志同时写入 Zotero 数据目录下的 `papilot-boot.log`。

### 4.2 账号后台（自建 / 二次开发才需要）

```bash
# 前台调试（cwd 必须是 server/）
cd server && node account-server.js

# 生产拉起（幂等：8000 已有应答即退出）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-account-server.ps1

# 健康检查
curl http://127.0.0.1:8000/api/health
```

图形启动器（推荐）：双击 **`启动Papilot后台.bat`**，经 `wscript` 无窗拉起 WinForms 控制台，左侧是运行状态 / 账号后台 / 公网通道 / 账号管理。

- 服务端数据是 `server/data/*.json`（用户、订单、令牌、通道密钥），**已被 `.gitignore` 排除**，不进版本库。
- 改完服务端代码必须同轮重启生产进程，否则插件连到的还是旧逻辑。

### 4.3 公网通道（仅在自建并需要外网访问时）

```bash
powershell -File scripts/tunnel/tunnel.ps1 status|start|stop|restart
# 或双击 启动公网隧道.bat / 停止公网隧道.bat
```

隧道 `paperpilot` → `pp.xinglintools.top` → `127.0.0.1:8000`；健康判据是 `/ready` 的 `readyConnections > 0`（**端口通 ≠ 健康**）。在线支付回调依赖 `PP_PUBLIC_URL` 为公网 https 地址。

### 4.4 数据落点

| 内容 | 位置 |
|---|---|
| 偏好设置 | Zotero 偏好 `extensions.zotero.papilot.*`（共 197 项） |
| 登录会话 | `papilot-account.json`（含 `.1`/`.2` 两代滚动副本），落在 Zotero 数据目录与配置文件目录两处 |
| 聊天记录 / 期刊缓存 / 阅读统计 / 进度 | 同名目录下 `papilot-chat-sessions.json`、`papilot-easyscholar.json`、`papilot-rank-config.json`、`papilot-s2-citations.json` |
| 文献、笔记、附件 | 始终在 Zotero 库内，插件不复制、不搬移 |

---

## 5. 使用说明

### 5.1 菜单结构

- **工具菜单**：`Papilot ▸` 一个入口（内含功能中心与各分组直达）+ 独立「Papilot 设置」。
- **条目右键**：默认 `grouped` 模式 —— 顶部最多 3 个高频直达（默认「AI 总结」「PDF 对照翻译」）+ 9 个语义分组：AI 阅读助手 / 笔记与输出 / 引文分析 / 标签治理 / 元数据治理 / 中文文献工具 / 自动化 / 阅读状态 / 评级。
- **顶部快捷按钮**：条目工具栏一个按钮，展开同一套高频直达 + 功能中心 + 设置（可在设置里关闭）。
- 任何被折叠的功能都还能从 **功能中心 / 工具菜单分组 / classic 平铺模式** 三处到达。

### 5.2 六条典型流程

1. **读一篇外文**：选中条目 → 右键「PDF 对照翻译」→ 左原版右译文，滚到哪译到哪；需要整篇时点窗口内「翻译全文」。
2. **带着问题读**：`Ctrl+Shift+K` 唤起问答悬浮窗（自动锁定当前条目）→ 追问多轮 → 结论「存为笔记」。
3. **问整个库**：功能中心 → 库内问答 → 输入问题 → 看 `[n]` 引用并点回条目。
4. **清理一批元数据**：选中若干条目 → 元数据体检 → 看问题清单 → 勾选 → 执行；不确定的先用「元数据医生」预览。
5. **建立自动规则**：自动化规则 → 新建「新条目入库 → 标题含 X → 打标签 + 设状态」→ 试跑看命中数 → 启用。
6. **把库交给外部 Agent**：设置 → MCP → 启用 → 复制客户端配置 JSON → 粘进 Claude Desktop / Cursor。

### 5.3 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + Shift + K` | 主窗口唤起 AI 问答悬浮窗 |
| `Ctrl/Cmd + Enter` | 阅读器内唤起问答悬浮窗 |
| `↑` / `↓` | 悬浮窗内翻阅提问历史 |
| `Esc` | 关闭悬浮窗 |

以上可在 **设置 → Papilot → 快捷键** 中改键或禁用；也可为单条自动化规则绑定快捷键。

---

### 5.4 云同步（坚果云）

1. 打开坚果云网页 →「账户信息 → 安全选项 → 添加应用密码」，生成一个专用密码。
   **必须用应用密码，不能用登录密码**——WebDAV 直连登录密码会返回 401（实测）。
2. 设置 → Papilot → 云同步：填账号 + 应用密码 →「保存并测试」。
3. 勾选同步范围（设置项 / AI 对话 / 技能包与安装包），选冲突策略（默认「两份都留」）。
4. 点「立即同步」；之后再点应是「0 上传 0 下载」，说明增量生效。
5. 自己的 xpi / zip / json 放进「打开本地同步目录 → packages/installers」，下次同步自动上传；
   「收集技能包」会把已安装技能包的清单落到 `packages/skill-packs/` 一并同步。

数据都在云端独立目录 `/<同步目录>/`（默认 `/Papilot`），与 Zotero 自带的附件同步互不干扰。
设置项快照**永不包含** API Key / 各类密码 / 同步自身凭据。

## 6. 配置项

### 6.1 设置面板分区（18 个折叠组）

账号 / 知网 / 第三方文献源 / 模型通道 / 翻译 / AI 参数 / 技能包 / 检索订阅 / 定时任务 / 划词浮窗 / 数据列 / 打标与自动化 / 增强功能 / 界面主题 / PDF 阅读主题 / 菜单定制 / 快捷键 / 云同步。

面板顶部支持搜索，折叠状态会记住（`prefsFoldOpen`）。

### 6.2 关键偏好（默认值取自 `prefs.js`）

| 分组 | 偏好键 | 默认值 | 说明 |
|---|---|---|---|
| 云同步 | `cloudSyncEmail` / `cloudSyncToken` | `""` | 坚果云账号与应用密码（可关闭记住） |
| 云同步 | `cloudSyncDatasets` | `settings,chatSessions,packages` | 参与同步的数据集 |
| 通道 | `aiChannels` | `""` | 通道注册表 JSON，见 [7.2](#72-自定义-ai-通道) |
| 通道 | `aiModel` | `auto` | 当前模型；`auto` = 通道默认 |
| 通道 | `aiMaxTokens` | `4096` | 单次回复上限 |
| 通道 | `aiTemperature` | `"0.3"` | 温度（字符串存法，pref 无浮点） |
| 通道 | `aiHistoryRounds` | `6` | 多轮上下文滑窗轮数（1–30） |
| 通道 | `aiFullTextMaxChars` | `16000` | 送入模型的全文上限 |
| Agent | `chatAgentMode` | `false` | Agent 模式总开关 |
| Agent | `aiAgentMaxSteps` | `5` | 工具调用轮数上限（1–12） |
| Agent | `aiAgentConfirmWrite` | `true` | 写操作逐次确认 |
| Agent | `aiAgentTools` | 11 个工具 CSV | 工具白名单 |
| 翻译 | `readerPopupTargetLang` | `zh-CN` | 目标语言（规范语言码） |
| 翻译 | `translateFromLang` | `auto` | 源语言 |
| 翻译 | `translateCfg` | `""` | `{active, fallback[], timeoutMs, retry, cache, secrets{}}` |
| 翻译 | `bilingualStructExtract` | `true` | 段落块结构化（公式/图注/垃圾行分离） |
| 翻译 | `bilingualContext` | `true` | 文档标题 + 上段译文作为上下文 |
| 翻译 | `translateGlossary` | `""` | 术语表，见 [7.4](#74-术语表) |
| 对照 | `pdfInlineMode` | `off` | 原位对照：`overlay` / `bilingual` / `off` |
| 对照 | `pdfDualSyncScroll` | `true` | 左右同步滚动（页 + 页内比例） |
| 对照 | `pdfDualRightMode` | `mono` | 右栏形态：译文替换原文 / 叠加淡显 |
| 列 | `rankColumnEnabled` | `true` | 期刊分区列 |
| 列 | `citationColumnEnabled` | `true` | 被引量列 |
| 列 | `progressRowEnabled` | `true` | 标题列内嵌进度条 |
| 列 | `progressBasis` | `auto` | 进度口径：位置优先 / 仅位置 / 仅时长 |
| 列 | `progressAutoFinishPct` | `95` | 自动判「已读」的进度阈值 |
| 打标 | `autoTagUseVocab` | `true` | 复用库内受控词表 |
| 打标 | `autoTagConfidenceThreshold` | `0.7` | 建议预勾选阈值 |
| 自动化 | `automationRules` | `""` | 规则 JSON 数组 |
| 自动化 | `automationDailyAiCap` | `20` | 每日 AI 调用上限 |
| 自动化 | `autoReadEnabled` | `false` | 入库自动精读 |
| 发现 | `discoveryEnabled` | `false` | arXiv 每日推荐 |
| 发现 | `discoveryCategories` | `cs.AI, cs.CL, cs.LG` | 拉取分类 |
| 集成 | `mcpEnabled` | `false` | MCP 服务开关 |
| 菜单 | `menuMode` | `grouped` | `grouped` / `classic` |
| 菜单 | `menuQuickItems` | `ai-summary,bilingual-view` | 右键顶部直达项 |
| 外观 | `uiTheme` / `pdfTheme` | `""` / `default` | 界面主题 / PDF 阅读主题 |
| 更新 | `updateNoticeEnabled` | `true` | 有新版时提示 |
| 全文 | `fulltextResolverEnabled` | `true` | 注入 Zotero 原生「查找全文」 |

> 所有偏好都可以在 `about:config`（Zotero 高级设置）里直接改；改完即时生效的项会有 pref 观察者，无需重启。

---

## 7. 示例

### 7.1 MCP 客户端配置

在 **设置 → Papilot → MCP** 里启用后，窗口给出可直接复制的 JSON（令牌首次自动生成，可重置）：

```json
{
  "mcpServers": {
    "papilot": {
      "type": "http",
      "url": "http://127.0.0.1:23119/papilot/mcp",
      "headers": { "Authorization": "Bearer <你的令牌>" }
    }
  }
}
```

调用示例（JSON-RPC 工具调用）：

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "search_library", "arguments": { "query": "中医 抽动障碍", "limit": 5 } }
}
```

### 7.2 自定义 AI 通道

设置面板里点「新增通道」是推荐做法；等价的 `aiChannels` 结构如下（`active` 指向通道 id）：

```json
{
  "active": "ds",
  "channels": [
    {
      "id": "ds",
      "name": "DeepSeek",
      "provider": "deepseek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "timeoutMs": 60000
    }
  ]
}
```

`provider` 取值为内置预设 id（`deepseek` / `qwen` / `glm` / `kimi` / `doubao` / `yi` / `ernie` / `minimax` / `siliconflow` / `spark` / `hunyuan` / `ollama` / `custom`）或官方通道 `official`（登录后自动注入地址与密钥，不落盘）。

### 7.3 规则打标语法

`设置 → Papilot → 打标与自动化 → 规则打标`，每行一条规则：

```
# 标签 | 字段 | 操作 | 值
# 字段：title publicationTitle journalAbbreviation abstractNote year itemType DOI creators
# 操作：contains !contains regex = != > < exists
#方法/机器学习 | abstractNote | contains | machine learning
#领域/心血管 | publicationTitle | regex | (?i)heart|cardio
#近期文献 | year | > | 2023
```

`//` 或 `#` 开头为注释。

### 7.4 术语表

`设置 → Papilot → 翻译 → 术语表`，每行 `原文 = 译文`（也支持 `=>` 与 Tab 分隔，兼容 JSON 数组）。领域化写法加第三段：

```
Transformer = 变换器 | 计算机;人工智能
myocardial infarction = 心肌梗死 | 医学
```

领域白名单由 `translateGlossaryDomains` 控制（分号分隔；留空 = 全部启用；无领域标注的通用术语永不被过滤）。术语表会随内容指纹进入翻译缓存键，并注入大模型提示词以保证全文术语一致。

---

## 8. 从 PaperPilot 升级

0.55.0 是品牌级更名，以下标识全部更换：

| 项 | 旧 | 新 |
|---|---|---|
| 插件名 | PaperPilot 文献副驾 | **Papilot 文献副驾** |
| 插件 ID | `paperpilot@dev.local` | `papilot@dev.local` |
| 偏好分支 | `extensions.zotero.paperpilot.*` | `extensions.zotero.papilot.*` |
| 数据文件 | `paperpilot-*.json` | `papilot-*.json` |
| 仓库 | `paper-pilot` | `zotero-papilot` |

**步骤**（插件 ID 变了，旧版不会自动更新到新版）：

1. Zotero → 工具 → 插件，**卸载**旧 PaperPilot。
2. 安装 `papilot-0.55.0.xpi`，重启。
3. 首次启动执行一次性迁移：旧偏好分支的用户值复制到新分支、7 个旧数据文件复制成新名（`brandMigrated` 标记，只跑一次，旧文件保留）。
4. 若某项设置没跟过来，旧值仍在原处，可在新设置里重填。

---

## 9. 隐私与数据

- **默认不联网**：除你主动触发的 AI 请求、元数据查询、更新检查外，插件不上传任何内容；上述三类都可在设置中关闭或限制范围。
- **凭据本地化**：AI Key、知网账号、第三方文献源账号只存本机 pref；登录会话令牌存数据目录 JSON（不进 pref、不进 git）。
- **MCP 三重约束**：默认关闭、只监听 `127.0.0.1`、每请求需 Bearer 令牌；写类工具额外要求显式授权。
- **卸载不删数据**：卸载插件不会删除上述文件，需要清理时手动删除同名文件即可。

---

## 10. 开发

```bash
# 快速门禁（语法 + 生成物同步 + 全部 Node 测试 + 接线扫描，约 2.5 分钟）
python scripts/preflight.py --fast

# 完整门禁（追加浏览器 E2E；需 NODE_PATH 指向 playwright-core）
python scripts/preflight.py

# 打包
python scripts/build-xpi.py 0.55.0

# 接线一致性静态扫描（launcher × server × admin × 插件装配）
python scripts/check-wiring.py

# arXiv 工具包（tools/arxiv 是生成物的单一真源）
node tools/arxiv/test/run-all.js
python scripts/build-arxiv-core.py --check
```

技术栈：JavaScript（Zotero 特权作用域，非网页作用域）+ XHTML/XUL + CSS；测试是 Node `vm` 手写断言，**没有** Jest/Mocha，也**没有** `package.json` 与 npm 依赖。

```
bootstrap.js            # 生命周期入口，注册 chrome://papilot/ 并加载 main.js
chrome/content/         # xhtml 界面 + scripts/（core / ai / features / columns / panels）
locale/                 # zh-CN / en-US 的 FTL 文案
prefs.js                # 全部默认偏好（带逐项注释）
server/                 # 零依赖 Node 账号后台（账号 / AI 网关 / 管理页）
scripts/                # 打包、门禁、接线扫描、发版、GitHub 同步、隧道
test/                   # 73 个 Node 测试套件
tools/arxiv/            # arXiv 检索工具包（核心生成物的源）
docs/                   # 设计文档、验证报告、调研
dist/                   # 历史 xpi 产物
```

开发约定（发布七步、真机验证清单、并发会话纪律）见 [AGENTS.md](AGENTS.md)。

---

## 11. 常见问题

**装了没反应？**
确认 Zotero ≥ 7；打开 `帮助 → 调试输出`，应有 `Papilot startup`。若出现 `STARTUP FAILED`，把堆栈贴到 Issues。

**AI 一直转圈？**
先跑一次「接口连通性测试」。常见原因：端点不可达、Key 失效或配额用尽、通道内模型名写错。

**翻译空白或乱码？**
扫描版 PDF 没有文本层：先跑「附件体检」确认，再用右键「扫描件 OCR」逐页识别（结果只存本机，之后问答/翻译会自动使用）；行内公式被掩码属预期。

**更新了但版本没变？**
第三方插件更新是静默替换，**重启 Zotero** 才生效；Papilot 检测到新版本会提示一次。

**会不会上传我的文献？**
只有你触发 AI 请求时，才把当次需要的文本片段发给你配置的端点；没有后台批量上传。

**阅读进度条不显示？**
确认 `progressRowEnabled` 为 true（默认），且条目有 PDF 附件与页数；纯 EPUB 没有页码，进度按 CFI 记录。

---

## 12. 许可与声明

### 12.1 许可范围

| 范围 | 许可 | 说明 |
|---|---|---|
| 客户端（`bootstrap.js`、`chrome/`、`locale/`、`prefs.js`） | **Apache-2.0** | 允许商用、修改、再分发，须保留 `LICENSE` 与 `NOTICE` |
| 账号与模型网关服务端（`papilot-server`） | **商业许可** | 不在本仓库授权范围内，需单独授权 |
| 文档与技能包内容（`docs/`、`community-packs/`） | **CC BY 4.0** | 署名即可使用与商用 |
| 第三方组件 | 各自许可 | 见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |

### 12.2 二次分发

- 你可以 fork、修改、自行编译并分发本插件，无需付费或报备。
- 但**不得使用 Papilot / 文献副驾 的名称与图标**发布衍生版本（商标保留），也不得把默认服务地址指向官方服务器以免造成混淆。
- 若要在产品中内置本插件或提供托管服务，请先联系授权。

### 12.3 第三方与商标

- 第三方组件、数据源与许可证全文：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- **Zotero** 是 Corporation for Digital Scholarship 的注册商标；Papilot 是独立第三方插件，与 Zotero 官方无隶属关系，也未获其背书。
- 使用第三方文献源、Sci-Hub 等实验能力时，请自行确认所在机构订阅与当地法律要求。

### 12.4 文档

- [使用教程](docs/使用教程.md) ｜ [安装配置指南](docs/Papilot-安装配置指南.md) ｜ [功能清单与分类](docs/Papilot-功能清单与分类.md) ｜ [功能路线图](docs/Papilot-功能路线图.md)
- [命名决策：为什么从 PaperPilot 改名](docs/产品命名评估-重名现状与改名建议-2026-10-19.md)
