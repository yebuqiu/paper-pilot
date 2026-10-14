# Jasminum 中文文献获取机制深度解析 与 PaperPilot AI 增强方案

> 分析对象：<https://github.com/l0o0/jasminum>（main 分支，2026-10 快照）
> 落点：为 PaperPilot 设计「AI 大模型辅助的中文文献（CNKI 为主）获取」改进方案。

---

## 一、jasminum 的两代架构背景

jasminum（茉莉花）仓库里实际存在两套实现，理解流程前必须先分清：

| 代际 | 位置 | 技术栈 | 特点 |
|---|---|---|---|
| 旧版（Zotero 6 时代） | `chrome/content/scripts/*.js`（master 分支残留） | 特权 JS + XUL | 硬编码 Cookie、固定 `v=` 签名串、oversea.cnki.net PDF 直链 |
| 新版（当前 main） | `src/`（TypeScript + zotero-plugin-toolkit） | Zotero 7+ 插件 | 多源检索链、Cookie 沙箱 + 验证码人机协作、PubScholar 签名逆向、**已引入 LLM 视觉识别** |

新版 main 的核心模块地图：

```
src/modules/services/   cnki.ts / pubscholar.ts / ncpssd.ts / wanfangdata.ts / yiigle.ts / searchChain.ts
src/utils/              cookiebox.ts（Cookie 沙箱+验证码）/ pdfParser.ts（PDF 标题版面分析）
                        llm.ts + prompts.ts + pdfMetadata.ts（AI 识别）/ headlessBrowser.ts（无头浏览器）
src/modules/attachments/ localMatch.ts（本地 PDF 文件名匹配）
```

---

## 二、中文文献获取的完整流程（逐环节）

整体是**两阶段任务管线**：`metaSearch`（搜 → 过滤 → 出候选）→ `metaTranslate`（转换 → 修正 → 入库），由 `ScraperTask` 编排，过程消息写入任务面板。

### 环节 1：中文文献识别（`utils/detect.ts`）

- 附件判定：文件名正则 `^(?=(.*?汉字){3})(?=(.*汉字){3}).+\.(pdf|caj|kdh|nh)$` —— 至少 3 个汉字 + 中文数据库常见扩展名。
- 快照判定：快照/网页条目标题含 `- 中国知网`。
- 作用：决定一个条目**走不走中文通道**，是整个流程的总开关。纯文件名启发式，不认内容。

### 环节 2：检索词提取（`services/index.ts getSearchOption` + `utils/pdfParser.ts`）

三级回退，优先级依次降低：

1. **PDF 版面分析**（`namePattern=auto`）：调 `Zotero.PDFWorker.getRecognizerData(itemID, true)` 拿到逐字的版面数据（坐标、字号、字体索引、baseline），然后：
   - `recognizerLineToPdfLine`：字 → 行（字号取 CJK 字均值）；
   - `pdfLinesToPdfParagraphs`：行 → 段落，合并条件是**字号相等 或 语义连贯（行尾逗号/破折号）** 且 **字体索引一致**；
   - `detectDocType`：用一组正则指纹（`指导教师`、`学位申请人`、`答辩委员会`、`保密等级`……）计票区分 期刊论文 / 学位论文；
   - 期刊论文：取首页**最大字号的有效段落**当标题（特判 `《..》网络首发论文` 封面页时跳到第 2 页）；学位论文：找「XX 学位论文」锚点行的**下一行**当标题，兜底还是最大字号段落；
   - 清洗：全角转半角（内置 60+ 字符映射表）、剥脚注符号 `*①②…`、CJK 间空白删除。
2. **文件名模板**：`{%t}_{%g}` 或用户自定义 pattern，从文件名里抠标题/作者。
3. **AI 文件名解析**（`llm.ts parsePDFFilename`，prompt 强调「不许猜、只取文件名中明确信息」）。注意：main 分支里此方法已定义但**未被主流程调用**，属于预留能力。

### 环节 3：多源顺序检索链（`services/searchChain.ts` + `metadataSource` 偏好）

- 按用户配置的源顺序（PubScholar → NCPSSD → Yiigle → CNKI → AI 位）逐源调用 `service.search()`。
- 每源结果先算 **Dice 字符串相似度**（`string-similarity`），三重过滤放行：`标题包含 || 相似度 > 阈值 || 全部标题 token 被结果覆盖`。
- **出现 similarity === 1 的精确匹配即短路**，不再查后续源。
- 「AI」可以作为链上的一个位置：轮到它时若前面没有可靠结果，直接走视觉识别建条目（见环节 8）。

### 环节 4：CNKI 搜索请求构造（`services/cnki.ts createSearchPostOptions`）

这是请求参数构造的核心，**大陆/海外双轨**：

**大陆端点** `POST https://kns.cnki.net/kns8s/brief/grid`：

- 检索式用知网**专家检索语法**：`TI %= '标题' AND AU='作者'`（`%=` 是模糊匹配；标题含空格时不再拆主题词——注释说明拆词会引入大量噪声，这是踩过坑后的取舍）。
- `QueryJson` 结构：`Resource: "CROSSDB"` 跨库 + `QNode.QGroup` 查询树 + `Field: "EXPERT"` 专家模式。
- 硬编码资产：`KuaKuCode`（10 个跨库产品码）、`productStr`（20 个产品码）、`Classid: "WD0FTY92"`、`Referer` 里的 `crossids`——这些是知网前端写死的产品编码，jasminum 原样照抄。
- 表单编码 `jsonToFormUrlEncoded` 后 POST，UA/Accept/Origin/Sec-Fetch-* 全套浏览器伪装。

**海外端点** `POST https://chn.oversea.cnki.net/kns/Brief/GetGridTableHtml`：

- 另一套参数体系（`DBCode: "CFLS"`、`KuaKuCodes: "CJFQ,CDMD,..."`、`ExtendValue: "中英文对照"`），国内/国外由 pref `isMainlandChina` 切换。

### 环节 5：接口校验与反爬对抗（`utils/cookiebox.ts`）—— 关键机制

知网没有开放 API，所有请求都活在反爬阴影下。jasminum 的对抗体系是 **Cookie 沙箱 + 人机协作过验证码**：

1. **独立 Cookie 上下文**：`Zotero.HTTP.newCookieContext()` 创建隔离的 cookie jar，之后所有 CNKI 请求带 `userContextId` 发出，避免污染/被污染 Zotero 主网络栈。
2. **Cookie 获取 = 让用户开一次真页面**：`Zotero.openInViewer(cnki 首页)` 在该上下文中打开知网，页面右上角注入一个红框浮层「请完成验证码，验证成功后，点击此按钮」；用户点「确认完成验证」→ 代码 `cookieContext.getCookies(host)` 收割 cookie → 关窗。
3. **有效期管理**：cookie 缓存 5 分钟（注释写 10 分钟，代码是 `5*60*1000`），过期重新开窗。
4. **403 自愈**：搜索/导出接口返回 403 时，响应体 JSON 的 `message` 字段就是**验证页 URL**——`passCaptchaToCookieBox(respJson.message)` 再次开窗请用户过码，换新 cookie 后**原请求重试一次**。
5. **页面级验证码探测**：详情页标题等于 `知网节超时验证` 或 `captcha` 时判定网页通道被封，切换兜底通道（环节 7-B）。

### 环节 6：结果解析（`DocTools` DOM 抽取）

搜索返回的是 HTML 表格片段，逐行 `table.result-table-list > tbody > tr` 抽取：

- `td.seq input[value]` → `exportID`（后续导出接口的关键参数）；
- `td.operat [data-dbname]` 的 `data-dbname` / `data-filename` → 知网文献两键（dbname + filename，等效主键）；
- 标题/作者/来源/日期/被引（`td.quote`）/网络首发标记（`b.marktip`）。

对**知网快照条目**还有一条捷径：解析快照 HTML 里「记笔记」按钮和「CNKI AI」按钮的 href，直接抠出 `dbcode/tablename/filename/cid`，不必再搜索。

### 环节 7：元数据落地（`CNKI.translate` 双通道）

- **通道 A（首选）**：GET 详情页 → 喂给 Zotero 官方 CNKI 网页翻译器（UUID `5c95b67b-…`）解析成条目。
- **通道 B（验证码兜底）**：网页翻译失败时，改走 `POST https://kns.cnki.net/dm8/API/GetExport`，参数 `filename={exportID}&uniplatform=NZKPT&displaymode=GBTREFER,elearning,EndNote`，拿回 EndNote 格式引文文本 → 用 Zotero 内置 EndNote 导入翻译器（UUID `7b6b135a-…`）建条目。**导出接口的反爬强度低于详情页**，这是绕过验证码的关键工程经验。
- `globalItemFix` 后处理：标签类型归一、被引数写入 `extra: CNKICite`、网络首发写 `Status`、日期回填、清多余笔记。
- 海外轨的导出在代码里还是 `TODO: implement oversea export`，直接返回 null。

### 环节 8：签名生成机制（`services/pubscholar.ts`）—— 唯一真签名

CNKI 通道靠 cookie 而非签名；真正的密码学签名在 **PubScholar（公益学术平台）** 通道：

```ts
const PUBSCHOLAR_SIGNATURE_SECRET = "6m6pingbinwaktg227gngifoocrfbo95"; // 逆向得到
signature = sha1([SECRET, timestamp, nonce].sort().join(""));
```

- **三要素**：`nonce`（6 位随机）、`timestamp`（毫秒）、`signature`（上述 SHA-1）；外加随机 `x-finger` 指纹与 `x-xsrf-token`（须与 Cookie 中的 XSRF-TOKEN 一致）。
- **手写 SHA-1**：Zotero 特权 JS 环境里 `crypto.subtle` 只能异步且受限，插件需要同步计算，于是文件内手写了一份 FIPS 180-1 实现。
- 注释明言风险：「站点若轮换密钥或修改签名方案，本模块将整体失效」——**签名方案是逆向资产，不是契约**。
- 旧版 jasminum 里 CNKI 详情页 URL 的 `v=uJhTu8ARyQjLVTb37OvEMX33PdTT8h_…` 参数同理：知网会话签名串，旧版直接硬编码一个可用值。

**签名在整体流程中的作用**：它是服务端「这是不是合法前端」的门票校验。过不了签名，请求在第一跳就被拒；它管「进不进得去」，不管「查得准不准」。

### 环节 9：PDF 全文获取

- 新版：**只做本地匹配**（`attachments/localMatch.ts`）——扫描用户指定文件夹里的中文文件名 PDF，与条目标题算 Dice 相似度，超阈值取 Top-N 挂为附件；远程下载被注释为「Maybe oneday」。
- 旧版：从详情页 `#pdfDown` 抠链接，拼 `https://oversea.cnki.net` 前缀直连下载，Cookie 用 pref 里用户手动粘贴的。新版把这条链砍了。

### 环节 10：jasminum 已有的 AI 能力（`utils/llm.ts + pdfMetadata.ts + prompts.ts`）

新版已经迈出 AI 第一步，设计相当严谨：

- **输入**：`renderFirstPDFPagesAsPNG`（Zotero 10 的 PDFWorker 渲染前 N 页为 PNG，scale=2）→ base64 data URL → OpenAI 兼容多模态端点（用户自配 baseURL/Key/Model）。
- **提示词纪律**：先判正文语言（明确防止被英文对照标题/Abstract 带偏）→ 按语言取原文元数据 → 「只用图片中清晰可见的信息，不猜不补不翻译，不确定返回 null」→ 要求给每个关键字段附 `evidence`（页码 + 原文证据）。
- **输出把关**：JSON Schema 强约束（自写 `validateJSON` 递归校验：类型/必填/枚举/无多余字段）→ `toZoteroMetadata` 再过一遍 Zotero 字段合法性（itemType 白名单、creatorType 校验、字段对类型有效才写）。
- **定位**：作为检索链上的「AI 位」——识别成功就**直接建条目，不再查任何数据库**。

---

## 三、现有方案的局限性与可优化点

| # | 局限 | 根因 | 可优化点 |
|---|---|---|---|
| 1 | 检索词提取脆 | 「最大字号 = 标题」是纯版面启发式，双栏错位、封面页、扫描件（无文本层）直接失效；文件名模板强依赖命名规范 | 版面启发式只作一路候选，LLM 从页面图像/全文语义提取 |
| 2 | 匹配判定浅 | Dice 系数 + token 覆盖是字符级，处理不了副标题省略、改写、中英混排、异体字 | LLM 语义裁决：标题语义等价 + 作者/期刊/年份交叉验证 |
| 3 | 反爬打断工作流 | cookie 5 分钟过期、403 即弹窗请人过码，批量任务频繁中断 | 多源错峰（PubScholar/万方无验证码优先）、失败队列延迟重试、headless 浏览器自动过简单验证 |
| 4 | 硬编码资产多 | KuaKuCode、translator UUID、签名密钥、固定 UA——任一失效整链断裂（作者注释自认） | 失效时 LLM 解析返回页提取新端点/参数，降级自愈 |
| 5 | 检索召回单一 | CNKI 只有 `TI %= AND AU=` 一种检索式；标题稍有出入就零结果 | LLM 生成多候选检索式（精确标题/截短标题/主题词/一作+刊名）轮询 |
| 6 | AI 用法初级 | jasminum 的 AI 是「识别即入库」，绕过数据库校验，幻觉无兜底；且与检索链是**互斥**关系不是**协作**关系 | AI 从「替代检索」升级为「规划 + 裁决 + 融合」三个协作角色，最终仍以数据库记录为准 |
| 7 | PDF 获取倒退 | 新版只剩本地文件名匹配，远程下载被砍 | 恢复详情页 `#pdfDown` 链路 + AI 辅助定位下载入口 |
| 8 | 海外轨半残 | oversea 导出 TODO、Host 头混用 | 低优先级，可放弃海外轨 |

**一句话总结**：jasminum 把「怎么进知网的门」（cookie/签名/参数）做得很扎实，但「查什么词、哪个结果是对的、字段怎么补」这些**语义层决策全是字符级启发式**——这正是大模型能接管的部分。

---

## 四、PaperPilot 的 AI 增强方案：CNKI 文献智能获取

### 4.1 设计总原则

**分层解耦：协议层保持确定性代码，语义层交给大模型。**

- 签名、Cookie 沙箱、KuaKuCode、QueryJson 构造——这些是**协议硬要求**，一个字都不能让模型碰，继续走确定性实现（直接借鉴 jasminum）。
- 「查什么、选哪条、补哪些字段、失败后怎么办」——这些是**语义判断**，交给 LLM，但输出必须过三重把关：JSON Schema 校验 → 字段白名单（复用 RefImport 的 FIELD_PLAN 纪律）→ 数据库回验。
- 复用 PaperPilot 现有资产：官方 AI 网关（按响应模型计价，auto 档恒免费）、TranslateSvc 的多引擎兜底模式、RefImport 的「AI 只填空不覆盖」纪律、preflight 门禁与迷你 DOM 测试技法。

### 4.2 四层管线架构

```
PDF 附件/条目
   │
   ▼
┌─────────────────────────────────────────────────┐
│ L1 检索词规划器 (Query Planner) —— 轻量文本模型    │
│   输入: PDFWorker 前2页文本(无文本层→首页PNG)      │
│   输出: {title, authors[], journal, year, docType,│
│          searchPlans: [精确式, 截短式, 主题词式]}   │
└──────────────┬──────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────┐
│ L2 协议执行层 (Executor) —— 纯确定性代码，无 AI    │
│   CNKI: cookie沙箱 + QueryJson + GetExport 兜底   │
│   PubScholar: SHA-1 签名三要素                   │
│   万方/NCPSSD: 各自通道；403→验证码窗→重试        │
│   按 searchPlans 逐式轮询，合并去重候选            │
└──────────────┬──────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────┐
│ L3 结果裁决器 (Judge) —— 轻量文本模型              │
│   输入: 本地证据(标题/作者/刊名/年份) + N条候选    │
│   输出: 排序 + 置信度 + 命中解释                  │
│   ≥0.9 自动采用；0.6~0.9 带解释请用户点选；        │
│   <0.6 进 L4 或标记失败                           │
└──────────────┬──────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────┐
│ L4 元数据融合器 (Fuser) + AI 兜底识别              │
│   数据库元数据为准，AI 视觉识别补缺(摘要/DOI/页码) │
│   全部检索失败→视觉模型直读PDF建条目(降级,标AI来源)│
└─────────────────────────────────────────────────┘
```

### 4.3 大模型在流程中的具体职责

**L1 检索词规划（替代 jasminum 环节 2 + 增强环节 4）**

- 输入优先用 PDFWorker 抽出的前 2 页**文本**（便宜），扫描件/无文本层才升级到首页 PNG（视觉模型）。
- 输出结构化检索计划：最多 3 条候选检索式，按精确到宽泛排序：
  1. `TI %= '完整标题' AND AU='一作'`（对标 jasminum 现状）；
  2. `TI %= '主标题'`（模型负责切掉副标题/系列名）；
  3. `SU %= '3-5 个主题词'`（模型从摘要提炼，应对标题有出入的场景）。
- 成本纪律：这一层用 auto 档（恒免费）或最低档模型，纯文本任务。

**L2 与签名等机制的协作关系（关键边界）**

- LLM **不参与、不生成、不修改**任何协议参数。签名密钥、nonce/timestamp 计算、cookie 收割、403 重试、QueryJson 模板，全部留在确定性代码里——这些逻辑错一个字符就是 403，而模型的输出本质上是概率性的，绝不能放在这里。
- LLM 与协议层的接口只有一个：**检索式字符串数组**。协议层把它填进 `QueryJson.QNode.QGroup[0].Items[0].Value` 即完成交接。
- 反向协作：协议层返回的原始结果（含 exportID/dbname/filename）原样交给 L3，模型只读不写。

**L3 结果裁决（替代 Dice 相似度）**

- 把本地证据（L1 提取的标题/作者/刊名/年份）与候选列表（含各自 dbname、被引、来源库）一起发给模型，要求输出 `{index, confidence, reason}`。
- 解决 jasminum 环节 6 的痛点：副标题省略（「——以 XX 为例」被截断）、标题改写、同一文献在知网/万方重复收录、同名不同文。
- 置信度分档策略保持人工可控：中间档在 PaperPilot 任务面板里给出「模型推荐理由」，用户一键确认——比 jasminum 的 `multiple_results` 干列表体验好一个量级。

**L4 元数据融合与兜底（对齐 RefImport 纪律）**

- 正常路径：CNKI 双通道（translator / GetExport EndNote）拿到的元数据为**准**，视觉模型从 PDF 首页识别的字段为**补**——只填数据库缺的（被截断的摘要、DOI、基金、页码），已有字段不覆盖。
- 兜底路径：所有数据库检索均失败时，才走 jasminum 式「视觉识别直接建条目」，并在 `extra` 标记 `Source: AI-recognized, unverified`，提醒用户这是未与数据库核对的记录。

### 4.4 准确率与覆盖率的提升思路

**准确率（查回来的就是这篇）：**

1. 语义裁决替代字符相似度——副标题、改写、中英混排场景从「漏判/误判」变为可判；
2. 作者+刊名+年份三维交叉消歧，干掉「标题相似但非目标」的误命中；
3. evidence 纪律（学 jasminum prompts）：L3/L4 输出必须引用原文证据，Schema 校验不过即重试或降级，幻觉写库概率压到最低。

**覆盖率（该查到的都能查到）：**

1. 多候选检索式轮询：标题有出入时主题词式兜底，CNKI 零结果自动降级万方/PubScholar/NCPSSD 同式重查（多源去重合并）；
2. 扫描件/无文本层 PDF 从「直接放弃」变为视觉模型可读——jasminum 的 PDFWorker 版面方案对此完全无解；
3. 检索词不再依赖文件名规范——用户随手拖进来的 `1.pdf` 也能从内容重建检索词；
4. 自愈降级：CNKI 改版导致固定选择器/接口失效时，把返回 HTML 喂给模型做一次「结果行/导出链接提取」，撑到人工修复——把「整链断裂」降级为「单次变慢」。

### 4.5 落地路线（对齐 PaperPilot 工程纪律）

| 阶段 | 内容 | 风险 | 验证 |
|---|---|---|---|
| P1 | L1 检索词规划 + L3 语义裁决（纯增强，不动协议层） | 低 | 迷你 DOM 真渲染面板测试 + 检索式构造单测（纯函数） |
| P2 | L4 元数据融合（AI 只填空）+ CNKI 双通道移植（cookiebox + GetExport 兜底） | 中（涉 cookie/验证码窗） | preflight 全绿 + 真机批量 50 篇中文 PDF 回归 |
| P3 | 视觉兜底识别 + 失效自愈降级 + PDF 直链下载恢复 | 高（无头浏览器/下载链） | 真机验证，灰度开关 pref 控制 |

计费与配额：L1/L3 走 auto 免费档（文本小任务），L4 视觉识别按响应模型计价计入余额——与现有 AI 计费域（微元计量、三档余额）自然衔接，不新增计费逻辑。

### 4.6 与 jasminum AI 方案的对位差异

| 维度 | jasminum（现状） | PaperPilot（本方案） |
|---|---|---|
| AI 角色 | 检索链上一个互斥的「源」：识别→直接入库 | 贯穿规划/裁决/融合三层的协作角色，最终以数据库记录为准 |
| 幻觉防线 | prompts 纪律 + Schema 校验 | + 数据库回验 + FIELD_PLAN 白名单 + 未验证标记 |
| 检索词 | 版面启发式单式检索 | 模型规划多候选检索式轮询 |
| 结果选择 | Dice 相似度 + 人工多选 | 语义裁决 + 置信度分档 + 推荐理由 |
| 模型接入 | 用户自配 OpenAI 兼容端点 | 官方 AI 网关（免配置）+ 自配通道并存 |

---

## 五、结论

jasminum 的价值在于把 CNKI 的**协议层**（cookie 沙箱、403 自愈、GetExport 兜底、双轨参数、PubScholar 签名逆向）蹚出了一条可复用的路；它的天花板在于**语义层**全部由字符级启发式支撑，且 AI 只被当作一条互斥支路。PaperPilot 的改进方向不是重造协议层，而是**把协议层原样接住，把语义层整体交给大模型**——检索词规划扩大召回、语义裁决提升精度、字段级融合补齐元数据、数据库回验压住幻觉。签名与验证码机制继续由确定性代码守护，模型永远不碰门票，只管判断。
