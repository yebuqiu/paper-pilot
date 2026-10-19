# Papilot 真机验证报告

> 环境：Zotero **10.0.5**（Windows）｜ 实装包：本地强制升级（profile 内 xpi 覆盖 + 删 `addonStartup.json.lz4`）
> 验证人：Papilot 开发会话 ｜ 时间：2026-10-03 02:43–03:10
> 验证对象：0.21.3（起点）→ 0.24.0 → **0.24.1 → 0.24.2**

## 一、为什么必须做这一步

0.22.0 / 0.23.0 / 0.24.0 三个版本连续发布，但**从未在 Zotero 里跑过**——本机 profile 内一直是 0.21.3
（`papilot-boot.log` 末行 `startup begin v0.21.3` + profile xpi 的 sha1 与 0.21.3 包一致）。
离线单测（370+ 断言）与静态接线扫描能证明「代码自洽」，**证明不了「接口在真实 Zotero 上存在」**。
本次验证**一次就抓出 4 个真 bug**，其中 2 个会造成「对外输出错误结论」，另 2 个会让功能「看起来做了但没用」。

## 二、验证手段

| 手段 | 覆盖什么 |
|---|---|
| 本地强制升级 + 启动日志 | 插件能否加载、版本是否正确、各模块注册是否成功、有无加载期异常 |
| **MCP 端点端到端 HTTP 调用** | 这是唯一能在无人点击的情况下**真实驱动插件内部逻辑**的通道：`curl` 打 `127.0.0.1:23119/papilot/mcp`，用真实库数据跑 8 个工具 |
| **arXiv 真实响应喂解析器** | 解析器此前只对自造样例测过；用线上真实 Atom 响应验证字段是否齐备 |
| **真实 zotero.sqlite 离线复算** | 从库里读出 1000 条真实条目的标题/摘要/期刊/DOI/作者/标签，直接喂 Discovery 画像与 MetaRules 规则，看它们**在真实数据上**的表现 |
| 强制触发每日定时 | 把 `discoveryEnabled=true` + `discoveryLastRun=""` 写进 prefs 再启动，让每日定时**在真机上自己跑一遍**，关闭后读 `prefs.js` 里的缓存验证结果 |

## 三、通过的验证

### 3.1 启动与加载（0.24.0 / 0.24.1 / 0.24.2 三次启动均通过）

```
startup begin v0.24.1 reason=1
chrome registered rootURI=...papilot@dev.local.xpi!/
main.js loaded → subscripts loaded
PreferencePanes registered paneID=papilot-prefs
rank/citation column, chat pane, glance pane, reading state, menus,
ui theme, pdf theme, reader popup, rule tag, automation, auto read → 全部 registered
reading stats heartbeat started
mcp endpoint register=true enabled=true
discovery daily timer started (enabled=...)
init complete
account store: dirs=2 copies=0 newest=- loggedIn=false
```
三次启动**均无 FAILED / ERROR 行**；49 个模块全部加载。

### 3.2 MCP 端到端（真实库：1493 条目 / 884 条有 PDF）

| 检查 | 结果 |
|---|---|
| Zotero 本地服务 | `127.0.0.1:23119/connector/ping` → **200** |
| 未注册路径（对照） | `/papilot/nope` → **404**（证明路由表生效） |
| 无令牌 / 错令牌 | → **403** + `{"error":{"code":-32001,"message":"Unauthorized…"}}` |
| `GET /papilot/mcp` 带令牌 | → **200**，返回 server/version/endpoint/tools + `zoteroServer{enabled:true,running:true,port:23119}` |
| 纯通知（`notifications/initialized`） | → **204** 无内容 |
| `initialize` | → `protocolVersion` 按客户端请求协商为 `2025-06-18`；`serverInfo.version = 0.24.x` |
| `tools/list` | → 8 个工具 |
| `search_library` | → 真实命中（如「抽动障碍 数据挖掘」扫 1493 篇、返回带相关度/命中词/标签的候选；`fulltext:true` 时附带**正文命中片段**） |
| `get_item` | → 完整元数据（`itemType: 学位论文`、DOI、标签、所属分类、附件 key）；也支持按中文标题解析 |
| `read_fulltext` | → 真实 PDF 文本（扫描版 OCR 文本，含空格噪声，符合预期） |
| `list_annotations` | → 真实批注 2 条（含页码） |
| `library_stats` | → 1493 条 / 884 有 PDF / 类型分布 / Top 标签 / 年份分布 |
| `list_recent` | → 真实最近条目 |
| 未知工具 | → `isError:true` + 可读文案（不是协议级错误，符合 MCP 约定） |

### 3.3 arXiv 链路

- **真实响应用解析器**：`export.arxiv.org` HTTP 200、51KB、**20 条条目解析成功且字段零缺失**（id/标题/摘要/作者/分类/链接/PDF 链接全部就位），打分排序链路正常。
- **真机每日定时**：注入开关后启动，`discoveryLastRun` 被写成当天、`discoveryResults` 落盘为
  `generatedAt=…T18:51:56Z`（启动后约 92 秒，与设计的 90s 一致）、拉取 100 条、推荐 30 条。

## 四、抓到的 4 个真 bug（全部已修）

### ① `Zotero.Library` 上不存在 `getCollections()`（0.24.1 修）

两个模块都误用了它，调用抛 `TypeError`，又被 `try/catch` 吞掉 → **把「接口失败」伪装成「没有数据」**：

- **MCP `list_collections`**：对外报告「库中还没有任何分类」。而同一会话里 `get_item` 明明能读出条目所属分类
  —— 对外供给场景下，**外部 AI 会据此得出完全错误的结论**。
- **文献发现的「收藏到库」**：条目建好了但**永远加不进分类**（用户视角「收藏了但没进分类」）。

修复：统一改用从 `omni.ja` 的 `xpcom/data/collections.js:72` 查到的
`Zotero.Collections.getByLibrary(libraryID, recursive, includeTrashed)`；
并把「接口失败」与「确实为空」在输出上**明确区分**（失败就 `isError` 带原因，不再回落成空结果）。
修复后实测：`list_collections` 正确列出 **344 个分类**（含层级与条数）。

### ② DOI 有效性规则把 **shortDOI 全判成非法**（0.24.2 修）

原正则 `^10\.\d{4,9}\/…` 拒绝 `10/gq7zfp` 这类 **Crossref shortDOI**。
在真实库 1000 条里产生 **71 条误报**（占全部 DOI 提示的 100%）。
修复：`^10(\.\d+)?\/\S+$`（接受 shortDOI；尾段放宽到「无空白即可」，避免对 Wiley 旧式含 `<>()` 的合法 DOI 误报）。
实测误报 **71 → 1**。

### ③ 期刊「尾随句点」规则**破坏缩写刊名**（0.24.2 修）

真实库里该规则命中 7 条，**全部是误伤**：`Ann. Neurol.`、`J. Child Neurol.`、`Psychiatry Res.`、
`Mol. Cytogenet.`、`Am. J. Med. Genet. B. Neuropsychiatr. Genet.` …
—— 缩写体刊名的末尾句点是**缩写规范的一部分**，去掉反而破坏数据。
修复：新增 `looksAbbrevJournal()`（存在「1–4 字符 + 句点」的词即视为缩写体 → 跳过），
只对「全称末尾多了一个句点」（`Nature.` / `Science.`）清理。实测该规则命中 **7 → 0**。

### ④ 兴趣画像被**噪声标签**与**中文 bigram 误杀**双重破坏（0.24.2 修）

这是本次最有价值的发现——**只有拿真实库跑才会暴露**：

- **噪声标签主导画像**：Better BibTeX 之类插件打的 `⛔ No INSPIRE recid found`（176 条）、
  `⛔ No DOI found`（72 条）、`/unread`（301 条）被当作普通标签，且标签权重 ×3 →
  修复前画像第一词竟是 **`inspire`（783）**，随后 `found`/`from`/`that`/`this`/`results`，
  推荐结果完全被功能词带偏。
- **中文二字词全军覆没**：画像选词写了 `t.length >= 3`，而**中文词元是 2 字 bigram** →
  「抽动 / 障碍 / 中医 / 中药 / 数据」这类核心词**一个都进不了画像**（实测中文词元数为 0）。

修复：
1. `isNoiseTag()` —— 非文字开头即视为标记（`⛔ / # @ ⭐` …），但**保留内容型标签**
   （以 `《 “ ( [` 开头，实测库里有「《中医方剂大辞典》」「“五行十态”体质」）；另加状态词表（unread/未读/已读…）。
2. `EXTRA_STOP` —— 补上完整英文功能词与泛学术词（from/that/this/results/found/using…），
   以及中文泛词（治疗/临床/中国/杂志/专家/指南/进展/共识…）。
3. 长度下限 `>=3` → **`>=2`**（否则中文 bigram 全丢）。

修复后同一份真实数据上的画像（Top 20）：

```
中医:823, tourette:585, syndrome:532, 中药:504, disorders:270, tic:264,
中华:263, 障碍:262, 血管:256, 药理:227, 医学:222, 抽动:216, humans:214, disorder:213, 诊疗:212
→ 噪声词残留：无 ✓ ｜ 中文词元数：0 → 17 ✓
```

### ⑤ 推荐「零信号」时静默给出无用清单（0.24.3 修）

改进画像后重跑每日定时（`generatedAt=…T19:03:22Z`，启动后 91 秒），画像已完全清洁
（`中医:1245, 中药:765, tourette:587, syndrome:555, 障碍/血管/药理/医学…`，噪声词残留为 0），
但**30 条推荐全部只有 9.1 分、命中词只有分类代码**——即没有任何一条与库内兴趣词真实重合。
原因：这个库是中医 / 抽动障碍主题，而默认分类是 `cs.AI, cs.CL, cs.LG`，两者毫无交集。
界面此时会呈现**一张看起来完全正常的无用清单**，用户无法判断「是没数据还是没匹配上」。

修复：`scoreEntry()` 分别统计「画像词元命中数」（`termHits`）与「分类加成」；
整批推荐词元命中数为 0 时，缓存写入 `termMatched` 与 `note`，窗口顶部显示橙色告警并给出可执行建议
（换成领域对应的分类，如神经科学 `q-bio.NC`、医学信息学 `q-bio.QM`；或清空分类框改用库内兴趣词检索），
存为笔记时也带上该提示。**这是本项目第 N 次栽在同一类问题上（静默失败），已按纪律改为显式上报。**

### 附带修掉的小问题

- `list_recent` 的分母曾写成被截断后的条数（「3 / 400」有歧义）→ 改为「显示 N 条，共检索到 M 条常规条目」。
- `Discovery.collect()` 在分类步骤失败时返回 `colError`，UI 明确提示「条目已建，但加入分类失败」，不再静默。

## 五、回归与验证留痕

| 检查 | 结果 |
|---|---|
| 阶段 3 单测 `pp-s3-test.js` | **196/196**（含为上述 4 个 bug 新增的 33 项断言；其中 3 项是「源码层面禁止再出现 `userLibrary.getCollections`」这类防回归断言） |
| 全套回归 | 47 + 78 + 76 + 196 = **397 项全绿** |
| 全模块加载冒烟 | **49/49** |
| 打包产物复测 | 0.24.1（90 文件）与 0.24.2 解包后全部测试复跑全绿 |
| 远端产物 | Gitee：update.json 最新版本正确、下载 xpi **sha256 与本地一致**、包内含修复代码；GitHub：API 同步 + tree 自检 blob 数一致 |

## 六、仍未验证的部分（需要人工点击）

以下无法在无人值守下验证，**需要打开 Zotero 界面点一次**：

1. **三个新对话框能否正常打开与渲染**：工具菜单 →「文献发现（arXiv 每日推荐）…」「元数据体检（规则补齐）…」「MCP 对外供给…」；
   以及「检索与发现」里的库内问答窗口。已通过 XML 解析、脚本引用检查、windowtype 唯一性检查，但**版式与交互未目视确认**。
2. **阶段 1/2 的历史功能**：标签治理、附件体检、自动化规则编辑器、笔记关系图谱、阅读报告、多篇 PDF 对比。
3. **arXiv 推荐在人类视角下的可用性**：本次验证的库是**中医/抽动障碍**主题，而默认分类是 `cs.AI, cs.CL, cs.LG`
   —— 主题与分类不匹配，推荐质量自然低。0.24.3 已为其加上「零词元命中」告警，但**更换分类后的推荐质量**
   仍需人工在窗口里目视判断（建议试 `q-bio.NC` 等匹配分类）。
4. **MCP 与真实 MCP 客户端联调**：本次用 `curl` 模拟了 JSON-RPC 全流程，但未经 Claude Desktop / Cursor 实测
   （这两个客户端是否接受「不支持 SSE 的单次 JSON 响应」形态，需实际验证）。
5. **旧数据迁移路径**：从 0.21.3 直升 0.24.x 后，账号会话、主题、分区数据等旧状态是否正常（本次看到 `copies=0 loggedIn=false`，即本机本来就没登录过，未覆盖登录态迁移场景）。

## 七、验证过程用到的资产（可复跑）

| 路径 | 用途 |
|---|---|
| `E:/tmp/pp_test/pp-s3-test.js` | 阶段 3 单测（196 项，含真机回归） |
| `E:/tmp/pp_test/arxiv-real.js` | 拉真实 arXiv 响应喂解析器 |
| `E:/tmp/pp_test/real-lib.js` + `E:/tmp/pp_realverify/db/items.json` | 用真实库数据复算画像与元数据规则 |
| `E:/tmp/pp_test/diag.js` | 规则在真实字段上的命中诊断 |
| `E:/tmp/pp_realverify/backup-*/` | 强制升级前的 profile 备份（xpi / extensions.json / addonStartup.json.lz4 / prefs.js） |
