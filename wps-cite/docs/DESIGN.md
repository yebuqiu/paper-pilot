# Papilot Cite · 设计说明

> 目标：在 **非企业版 WPS（无 VBA）** 里插入 Zotero 引文，并且做到旧实现做不到的事——
> **引文 ↔ 原文双向可跳**。从零实现，不复用 `wps-zotero` 的任何代码或结构。

## 1. 为什么不走旧路

旧实现（以及上游 `tankwyn/WPS-Zotero`）是：**让 Zotero 驱动文字处理器**。

```
Zotero（CSL 引擎）──execCommand──▶ 加载项（实现 Word 域语义）──▶ WPS Field
```

它必须实现一整套 Word 对象模型语义（`insertField / setText / getDocument / …`，
上游为此写了 1200 行），而 WPS 12 对 **Field** 的兼容性并不稳：域代码藏在二进制里、
用户看不见、刷新时拿不到可靠结果。这条路上还有两个额外的坑（本次实测）：

- Zotero 10 会校验 `Host` 头，非 `127.0.0.1:23119` 一律 `400`；
- integration 是**有状态事务**，一旦某次没走完 `/respond`，Zotero 侧会一直挂住，直到重启。

本实现把方向反过来：**我们读数据、我们排版**。

```
加载项（自实现渲染）──读──▶ Zotero 本地只读 API（/api/users/0/…）
        │
        └──写──▶ WPS 文档（书签名 + 文本）
        └──写──▶ 本地台账（谁引用了谁）
```

代价：要自己实现 CSL 子集（本版内置 GB/T 7714-2015 与 APA 7）。收益：
排版可测、文档结构简单、双向链接有地方落、不再受 Zotero 事务状态影响。

## 2. 三个关键设计决定

### 2.1 引文不用「域」，用「书签 + 命名编码」

| | Word 域（旧） | 书签（本实现） |
|---|---|---|
| 稳定性 | WPS 12 上不稳 | 两端原生、稳定 |
| 可见性 | 二进制域代码 | 名字可读，用户能改 |
| 复制粘贴 | 域会跟着走，但 id 可能撞 | 书签跟着走，名字**唯一** |
| 定位 | 需要按 id 反查 | 直接 `Bookmarks.Item(name)` |

书签名就是索引（≤40 字符，Word 上限）：

```
PPC<tok>_<itemKey>[_p<page>][_a<anno8>][_l<locator>][_i<idx>][_L<libId>]
PPC7f3q_K2M9X4TA_p7_aA1B2C3D4
```

- `tok` 4 位 base36：**同一处引多篇共用一个 tok**，`_i0.._i8` 是簇内序号；
- `itemKey`：Zotero 条目（8 位）；
- `page` / `anno`：**反向链接的钥匙**——当初引的是第 7 页上那条高亮；
- `locator`：正文里标的页码（`[3]12` 里的 12）；
- `libId`：群组库才写（个人库省略）。

**文档就是自己的数据库**：换电脑、丢配置、别人发来文档，只要有书签就能完整重建引文
（条目数据来自 Zotero，缺条目时降级成 `[?]` 而不是静默删掉）。

### 2.2 编号与刷新：纯函数算出"该写什么"

`model.plan(scan, byKey, style)` 输入"书签列表 + 条目数据 + 样式"，输出"每条书签该写什么、
文献表该列哪些"。它不碰 WPS，所以 64 条断言可以把它钉死（`test/core.test.js`）。

```
scan（书签 + 字符位置）
  → cluster（按位置排序，按 tok 聚簇）
  → numbering（数字制：按条目首次出现顺序编号；作者-年制：不编号）
  → edits  [{name, text, remove}]      先写文本，再清理簇内多余书签
  → bib    [{itemKey, seq}]            文末文献表
```

顺序问题的处理：编号依赖"谁先出现"，所以**每次刷新都重写全文引文文本**（而不是增量改），
这就是 CSL 类工具的标准做法（Zotero/EndNote 同样如此）。

### 2.3 双向链接：正向用 Zotero 原生，反向用本地台账

**正向（引文 → 原文）** 零依赖：Zotero 原生支持 URI scheme。

```
zotero://open-pdf/library/items/<attachmentKey>?page=7&annotation=A1B2C3D4
zotero://select/library/items/<itemKey>
```

加载项把光标所在引文的 `page/anno` 拼成 URI，交给本地代理 `os.startfile()`
（WPS 12 里加载项自己的 `ShellExecute` 已失效，必须由外部进程代劳）。
有标注时 Zotero 会直接打开 PDF 并高亮那句话；没有标注就跳页。

**反向（原文 → 引文）** Zotero 没有原生能力，所以自建台账：

```
%APPDATA%\PapilotCite\links.json
{
  "v": 1,
  "items": {
    "ABCD1234": [
      {"doc":"C:/docs/初稿.docx","token":"7f3q","page":7,"anno":"A1B2C3D4",
       "seq":1,"text":"注意力机制在机器翻译中的应用","snippet":"…","updatedAt":"2026-10-21T09:55:24"}
    ]
  }
}
```

**同步规则（重要）**：文档是权威来源。每次刷新，加载项把**本文档的全部引文**整批 POST 给代理，
代理先删掉该 `doc` 的旧记录、再写入本次的——所以删掉一条引文不会留下幽灵记录，
也不会因为并发写而重复。

反查：`GET /links?itemKey=ABCD1234&page=7` → 打开文档（`POST /open {path}`）。
"查看引用"命令就是这条链路，能列出除本文档外还有谁引了它。

## 3. 模块划分

```
wps-cite/
├─ addon/                         WPS 加载项（jsapi，浏览器环境）
│  ├─ ribbon.xml                  功能区（中文，6 个按钮，带 screentip/supertip）
│  ├─ index.html / version.js     入口与版本
│  ├─ js/codes.js       ★纯函数   书签名编码/解析（含冲突规避）
│  ├─ js/model.js       ★纯函数   聚簇 / 编号 / 生成编辑计划
│  ├─ js/styles/util.js ★纯函数   作者名、年份、页码、类型标识
│  ├─ js/styles/gb7714.js ★纯函数 GB/T 7714-2015 顺序编码制
│  ├─ js/styles/apa.js  ★纯函数   APA 7
│  ├─ js/links.js       ★纯函数   URI 构造、台账记录、边车 Markdown
│  ├─ js/zotero.js      数据访问  本地 API（经代理）
│  ├─ js/doc.js         文档适配  唯一直接调 wps.* 的文件
│  ├─ js/app.js         主控      六个命令 + 功能区回调
│  └─ js/picker.js + picker.html  选文献任务窗格
├─ proxy/proxy.py                 本地代理：CORS + Host 改写 + 台账 + 打开文件
├─ tools/install.py               安装 / 卸载 / 自检
└─ test/core.test.js              纯逻辑内核测试（64 断言）
```

★ = 不依赖 WPS 与网络，可在 Node 里直接测。这条边界是刻意的：
**排版决策出错必须在 CI 里被抓到，而不是让用户在 WPS 里发现。**

## 4. 时序

### 插入一条引文

```
用户点「插入引文」→ 记录插入锚（书签 PPANCHOR，点窗格会丢选区）
  → 窗格检索：GET /zotero/api/users/0/items?q=…
  → 勾选 → 点插入 → 回到锚点
  → 生成书签名（新 tok 或同簇 _i<n>）
  → 写文本（先用 plan 算出这一处的渲染结果）
  → refreshAll()：重排全文 + 重建文献表 + 台账 upsert
```

### 刷新

```
scan 书签 → 取条目（一次批量，40 条/批）→ plan
  → 逐条 setText（书签若被覆写丢失则补回）
  → 清簇内多余书签
  → 重建文献表（锚点书签 PPCBIB）
  → POST /links/upsert（整批替换该文档记录）
```

### 跳转

```
「回到原文」：光标 → citationAtCursor() → 取 page/anno
  → bestPdf(itemKey)（优先已下载的 imported_file 附件）
  → POST /open {uri}  → 代理 os.startfile("zotero://…")
「查看引用」：光标 → 取 itemKey/page → GET /links → 列其它文档 → 可 POST /open {path}
```

## 5. 扩展点

| 想加什么 | 改哪里 |
|---|---|
| 新样式（如 Nature、IEEE） | 在 `js/styles/` 加一个文件，实现 `{id,label,numeric,cite(items),bib(entries)}`，在 `app.js` 的 `STYLES` 注册 |
| 引用页码/章节 | 已支持：`_l` 段，`PPCodes.make(exists, {locator:'12-15'})` |
| 群组库 | 已支持：`_L<libId>` 段，`selectUri` 会走 `groups/<id>` |
| 从"选中的原文句子"直接引用 | picker 里加一步：读 `PPZotero.annotations(attachmentKey)`，把 `page/anno` 带进 `insertCitation` |
| "谁引用了我"做成 Zotero 侧面板 | 读同一个 `links.json`（格式见 §2.3），不需要改代理 |

## 5.5 另一条路线：Zotero 原生对话框（integration protocol）

用户要"和 dotm 一样的页面"。取证结论：**dotm 自己没有页面**——搜索框是 Zotero 进程里的
`chrome/content/zotero/integration/citationDialog.js`（102 KB）。要"页面完全一致"只能走 Zotero 的集成协议。

### 协议形态（读 `xpcom/httpIntegrationClient.js` + `server/server_connectorIntegration.js` 得）

**反向 RPC**：处理器发请求，Zotero 把"下一条命令"当响应下发。

```
POST /connector/document/execCommand {command:"addCitation", docId}
  ← 200 {"command":"Application.getActiveDocument","arguments":[]}
POST /connector/document/respond  <上一条命令的返回值>
  ← {"command":"Document.getDocumentData","arguments":["<docId>"]}
  … 直到 {"command":"Document.complete"}
```

### 已确认的契约（逐条实测，`tools/integration_probe.py` 可复现）

| 命令 | 期望返回 |
|---|---|
| `Application.getActiveDocument` | `{documentID, outputFormat:"html", processorName, supportsCitationMerging, supportsTextInsertion, supportsImportExport, supportedNotes}` —— **key 是 `documentID`，不是 `docId`**（我第一次写成后者，导致后续所有 docId 都是 null） |
| `Document.canInsertField` | `true`（返回 null 时 Zotero 直接 `displayAlert("此处无法插入 Zotero 字段")` 并结束） |
| `Document.cursorInField` | `false` |
| `Document.insertField` | `{"id": <fieldId>}` —— Field 构造取 `retVal.id`，返回裸数字会得到 `null` |
| `Field.setCode` | `null` |
| `Document.getFields` | 数组（**未闭合**：返回 `[]` 时 Zotero 停在等待，疑似结构不符） |

### 三个能让人重启 Zotero 的坑（都踩过，务必照做）

**① `inProgress` 只有一条复位路径。**
`Zotero.HTTPIntegrationClient.inProgress` 只在 `Document.prototype.complete()` 里被置 false
（`httpIntegrationClient.js:160`），而 `complete()` 在 `Zotero.Integration.execCommand` 的
`finally` 里，条件是 **`document` 变量已经存在**（`integration.js:323`）。

推论（血泪）：

- **在 `Application.getActiveDocument` 这一步或之前失败 = 永久卡死。** Zotero 拿不到
  `documentID` 就没有 `document` 对象，`finally` 跳过 `cleanup/activate/complete`，
  `inProgress` 永远是 `true`，之后所有 `execCommand` 一律 503，只能重启 Zotero。
  → 所以 `run()` **必须在发起事务之前**先确认 WPS 里有打开的文档；`getActiveDocument`
  这个 case **无论如何都要返回合法结构**，宁可让下一条命令失败。
- **中途失败也不能"直接 return"。** 必须顺着 `respond` 的错误通道回
  `{error:"Alert", message, stack}`（`server_connectorIntegration.js:65` 会把它 reject 成
  `Zotero.Exception.Alert`），**然后继续响应后续命令**直到 `Document.complete`。
  实测收尾序列是 `Document.activate → Document.displayAlert → Document.activate → Document.complete`。

**② `respond` 是长轮询，超时给短了就断链。**
Zotero 把下一条命令当成这次 `respond` 的 HTTP 响应下发，期间可能一直在等用户在对话框里
挑文献。代理侧 `/zit/*` 的超时是 **1800 s**，前端 `LONG` 也是 1800 s。
给 240 s 时挑文献超过 4 分钟就断，事务卡死。

**③ 不能直连 23119。**
Zotero 的本地服务不带 CORS 头，`file://` 页面里 `fetch` 直接被拦（表现为
`Failed to fetch`）。必须经代理 `http://127.0.0.1:21932/zit`，由代理补
`Access-Control-Allow-Origin`。

### `outputFormat:"html"` 必须自己渲染成富文本

citeproc 按 `outputFormat` 出串：`html` 给 `<sup>[1]</sup>`、`i/b`、`span[small-caps]`。
官方 Word 插件靠剪贴板粘贴让 Word 自己换格式；WPS 没这条路。
把 HTML 当普通文字塞进 `Field.Result.Text`，用户看到的就是字面量：

```
【<sup>[1,1,2,2,3,3–5]</sup>】
```

所以 `Field.setText` 里必须：`htmlToRuns()` 解析成 run 列表 → 写入纯文本 →
按绝对字符区间 `d.Range(s, e).Font.Superscript = true` 补格式。
解析器是手写扫描（不依赖 DOMParser），这样同一套逻辑能在 Node 单测里跑。

### 域身份不能靠 COM 对象引用（否则编号重复）

`Zotero.Integration.Field.equals()` 比的是 `_id`。原来 `getFields` 用
`v.field === f` 找已有 id，而 WPS 每次 `Fields.Item(i)` 可能返回新的包装对象，
`===` 恒 false → 同一个域每次扫描都拿新 id → Zotero 认为一条引文是多条 →
渲染成 `[1,1,2,2,3,3–5]`。
改用域代码里的 `citationID`（CSL_CITATION 自带，跨刷新不变）作为稳定身份，
文献表域退化为「位置 + 代码前缀」。

另外 `setCode` / `setDocumentData` 都要**回读校验长度**：WPS 若截断域代码或
自定义属性，Zotero 的 JSON 就残缺，症状正是「文献表插不进去 / 刷新后编号乱跳」。

### `Document.activate` 绝对不能真去激活窗口

日志里每次事务都停在这一行，之后既没有 `Document.complete` 也没有 `done`：

```
i:10 cmd | {"i": 10, "cmd": "Document.activate"}
```

根因：调 `d.Activate()` 会让 WPS 切换窗口，加载项那个**隐藏的 Chromium 内嵌页转后台**，
CEF 对后台页面的 `fetch` 会节流甚至掐断 → 我们 respond 出去的请求收不到下一条命令 →
`inProgress` 永久为 true → 用户点任何按钮都提示"上一个操作还没结束"。

把它推迟到 `setTimeout(..., 0)` **同样会触发**，只是把卡死往后挪一点。
正确做法是**只应答、什么都不做**：Zotero 只需要宿主对这条命令有个回复，
并不要求真把文档窗口拉到前台。

### 事务互斥要有逃生口

给按钮加"防重复点击"的锁时，必须同时给锁配退路，否则一次没走完的收尾就能把 UI 永久锁死
（实测：用户点 X 取消后收尾要 30 s，期间每次点击都被硬拒绝，观感就是"插件坏了"）。
现在的策略：先忙等最多 10 s，仍忙才提示；锁被占超 3 min 视为僵尸锁强制释放；
插入类命令若全程没写过文本则判为「用户取消」，静默返回、不去同步台账。

### 加载顺序（曾经的 `reading 'doc'` 报错根因）

`integration.js` 依赖 `root.PPDoc`（`doc.js` 导出）。它曾在 `index.html` 里排在 `doc.js`
**之前**，顶层 `const Doc = root.PPDoc` 拿到 `undefined`，点「插入引文」立刻抛
`Cannot read properties of undefined (reading 'doc')`。
现在两道保险：`index.html` 把它排在最后；`integration.js` 内部改成惰性取用 `D()`。

### 已打通到哪一步

点击命令后会真实弹出 Zotero 的 **「文档首选项」**（样式列表含 GB/T 7714、Nature、IEEE…），
自动点 OK 后序列继续走 `canInsertField → cursorInField → insertField → setCode`。
事务可开可收已用 `test/zotero-state.js` 端到端验证（含错误中止后的收尾）。

**未闭合**：`Document.getFields` 的返回结构，以及 WPS 侧的 ADDIN 域（`Fields.Add` 的
`type=81`）兼容性——这两块决定"添加引文"对话框能否走到插入。

## 6. 已知限制（写清楚比藏起来强）

0. **Zotero 原生对话框（integration 协议）已搬进加载项**（`js/integration.js`），
   三个主按钮（插入引文 / 文献表 / 刷新）都走它。事务可开可收已端到端验证；
   剩 `Document.getFields` 的返回结构 + WPS 的 ADDIN 域兼容性待真机闭环（见 §5.5）。
1. **样式只内置两种**（GB/T 7714 顺序编码、APA 7）。要别的样式得按 §5 加一个渲染器；
   本版不解析 `.csl` 文件（那需要引入 citeproc-js，~900 KB）。
2. **同簇最多 9 篇**（`_i0.._i8`），超过要拆成两处引用（书签名 40 字符上限）。
3. **任务窗格依赖 `wps.CreateTaskPane`**：个别 WPS 版本不支持，此时"插入引文"不可用（其余命令仍可）。
   这是本版最需要真机确认的一环。
4. **台账只在本机**：换电脑后"查看引用"为空，但文档本身（书签）仍完整，"回到原文"仍可用。
5. 条目被移出 Zotero 时引文降级为 `[?]` 并在刷新时提示，不会静默丢。
6. 不处理"同一文档被两人同时编辑"的合并冲突（台账按 doc 覆盖，最后写入者生效）。
