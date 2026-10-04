# PaperPilot arXiv 工具包

零依赖的 arXiv 检索 / 元数据抓取 / 信息提取工具，**可独立运行**（CLI），也可作为 Node 库被调用。

它是插件内 `Discovery`（arXiv 每日推荐）能力的完整版：把「一个硬编码 URL + 一个正则解析器」
扩展成「查询构建 → 限速 → 重试 → 分页 → 解析 → 去重 → 缓存/增量 → 分析 → 双通道输出」的完整流水线。

```
tools/arxiv/
├── bin/arxiv.js          CLI 入口
├── src/                  实现（每个文件一个职责，见下方目录说明）
├── types/index.d.ts      类型声明（API 契约）
├── examples/             真实 API 响应快照 + 示例输出 + 示例配置
└── test/                 9 套离线测试 + 1 套联网冒烟测试
```

---

## 1. 快速开始

```bash
cd tools/arxiv

# 直接跑，无需安装任何依赖
node bin/arxiv.js search -c cs.LG -k "diffusion model" --limit 20

# 自检：配置 / 分类目录 / 连通性
node bin/arxiv.js check
```

想装成全局命令（可选，不装也能用）：

```bash
npm link            # 之后可以直接 `arxiv search ...`
```

> 运行时要求：Node ≥ 14（开发验证于 Node 22）。**无第三方依赖，无 npm install。**

---

## 2. 命令速查

| 命令 | 作用 | 典型用法 |
|---|---|---|
| `search` | 按条件检索（默认命令，可省略） | `arxiv search -c cs.CL -k "rag" --limit 100` |
| `get` | 按 arXiv ID 精确获取 | `arxiv get --id 1706.03762,2501.00001 -f json` |
| `update` | 增量更新，只返回新论文/新版本 | `arxiv update -c cs.LG --limit 200 -f json` |
| `stats` | 检索 + 统计分析（默认开聚类） | `arxiv stats -c cs.LG --cluster 5` |
| `categories` | 列出 / 校验分类（含拼写纠错） | `arxiv categories --check cs.LG,cs.NLP` |
| `cache` | 缓存与增量状态管理 | `arxiv cache stats` / `clear` / `prune` / `state` / `reset` |
| `check` | 自检 | `arxiv check` |
| `config` | 打印最终生效配置 | `arxiv config` |

常用选项（完整列表见 `arxiv help`）：

```
检索条件   -q/--query  -k/--keyword  -a/--author  -c/--category  --id  --doi
          --from  --to  --date-field  --exclude-category  --exclude-keyword  --or  --phrase
分页排序   --sort  --order  --page-size  --limit  --pages  --batch-size
输出      -f/--format  -o/--out  --report  --no-pretty  --max-abstract  --dry-run
信息提取   --highlight  --mark  --no-structured  --no-stats  --cluster [k]
增强      --with-versions  --with-references  --with-citations  --enrich-limit
缓存      --cache-dir  --cache-ttl  --no-cache  --refresh  --state-key  --reset-state
网络      --base-url  --timeout  --retries  --min-interval  --concurrency
通用      --config  --print-config  --log-level  --log-json  --quiet  -v/-vv  -h  -V
```

---

## 3. 检索语法

`--keyword` 支持 arXiv 字段前缀，也可用 `-q` 直接写原始查询串：

| 前缀 | 字段 | 示例 |
|---|---|---|
| `ti` | 标题 | `-k "ti:attention"` |
| `au` | 作者 | `-a "Yoshua Bengio"` |
| `abs` | 摘要 | `-k "abs:reinforcement learning"` |
| `cat` | 分类 | `-c cs.LG`（多个分类默认 AND，`--cat-mode or` 取并集） |
| `co` | 评论 | `-k "co:NeurIPS"` |
| `jr` | 期刊引用 | `--journal-ref Nature` |
| `all` | 全字段（默认） | `-k "diffusion model"` |

```bash
# 布尔组合：多个 -k 之间默认 AND，--or 改为 OR（会自动加括号保证优先级）
arxiv search -k "diffusion" -k "video generation" --or -c cs.CV

# 多个分类默认 AND（只命中「同时属于这些分类」的交叉列表论文）；
# 「浏览这几个分类里有什么新东西」用 --cat-mode or 取并集
arxiv search -c cs.AI -c cs.CL --cat-mode or --limit 200

# 排除（ANDNOT）
arxiv search -c cs.LG --exclude-category cs.CV --exclude-keyword survey

# 日期区间（--from 单独给出 = 自该时刻起；要限一个月就两端都给）
arxiv search -c cs.CL --from 2026-01-01 --to 2026-01-31
arxiv search -c cs.CL --from 2026-09-01

# 原始查询串（完全掌控语法，不做转义）
arxiv search -q 'ti:"sparse autoencoder" AND cat:cs.LG ANDNOT ti:survey'

# 先看会请求哪些 URL，不联网
arxiv search -c cs.LG --limit 500 --page-size 100 --dry-run
```

> ⚠️ arXiv 对**分类大小写敏感**：`cs.CL` 合法，`cs.cl` / `cs.NLP` 不合法（后者根本不存在）。
> 工具会在检索前校验并给出最接近的候选，例如：
> `分类可能拼错 input=cs.NLP suggest=cs.CL/cs.LG`。

---

## 4. 配置

**优先级：命令行 > 环境变量 > 配置文件 > 内置默认。**

配置文件查找顺序（就近优先）：`./arxiv.config.json` → `./.arxivrc.json` → `~/.arxiv/config.json`。
也可用 `--config <path>` 指定；文件支持 BOM 与 `//` 行注释。完整示例见
[`examples/arxiv.config.json`](examples/arxiv.config.json)。

主要环境变量：

```
ARXIV_BASE_URL            ARXIV_TIMEOUT_MS        ARXIV_RETRIES
ARXIV_MIN_INTERVAL_MS     ARXIV_CONCURRENCY       ARXIV_PAGE_SIZE
ARXIV_MAX_RESULTS         ARXIV_SORT_BY           ARXIV_SORT_ORDER
ARXIV_CACHE_DIR           ARXIV_CACHE_TTL_MS      ARXIV_NO_CACHE
ARXIV_FORMAT              ARXIV_LOG_LEVEL         ARXIV_LOG_JSON
ARXIV_HIGHLIGHT           ARXIV_CLUSTER           ARXIV_VERSIONS
```

```bash
# 临时切到只读缓存、加大超时、输出 CSV
ARXIV_NO_CACHE=1 ARXIV_TIMEOUT_MS=60000 ARXIV_FORMAT=csv arxiv search -c cs.LG
```

查看最终生效的配置（含来源）：`arxiv --print-config`。

---

## 5. 输出：双通道

**机器通道**（`-f json|jsonl|csv|bibtex`）与**人类通道**（`--report`）可以同时用：

```bash
# JSON 到 stdout（可管道），同时把可读报告写到文件
arxiv search -c cs.CL -k "rag" --limit 50 -f json -o rag.json --report rag.md
```

| 格式 | 说明 |
|---|---|
| `md` | Markdown 报告（默认）：统计概览 + 分类分布条形图 + 主题词 + 聚类 + 逐条详情 |
| `table` | 终端精简表格（自动按 TTY 上色） |
| `json` | 完整结构化结果（含 `analysis`，字段见 `types/index.d.ts`） |
| `jsonl` | 每行一条条目，适合流式/大数据量管道 |
| `csv` | RFC 4180 转义 + UTF-8 BOM（Excel 打开中文不乱码） |
| `bibtex` | 有 `journal_ref` 用 `@article`，否则 `@misc`（预印本惯例） |
| `url` | 只输出请求 URL，便于排查或交给 curl |

示例输出：[`examples/sample-report.md`](examples/sample-report.md)、
[`examples/sample-output.json`](examples/sample-output.json)、
[`examples/sample-output.csv`](examples/sample-output.csv)。

**日志一律写 stderr**，所以 `arxiv search -f json > out.json` 的 stdout 永远是干净的 JSON。

---

## 6. 信息提取

```bash
# 高亮：--highlight 不带值时自动取 Top10 TF-IDF 主题词
arxiv search -c cs.LG -k "llm" --highlight

# 高亮指定词（中英文都支持；ASCII 按词边界，CJK 按子串）
arxiv search -c cs.LG -k "llm" --highlight "reasoning,hallucination,推理"

# 结构化摘要 + 主题聚类（k 可指定，也可自动 √(n/2)）
arxiv stats -c cs.CL -k "clinical" --cluster 4
```

- **高亮**：单遍正则替换（不会出现 `**a**` 嵌套坏标记）；ASCII 词按词边界，中文按子串。
- **结构化摘要**：识别 `Background/Objective/Methods/Results/Conclusions/Contributions/Limitations`
  及对应中文名（背景/目的/方法/结果/结论…）。**检出 ≥2 个不同标签才判定为结构化**，
  避免偶然出现的 `Results:` 把整篇摘要切碎。
- **分类统计**：全量标签分布、主分类分布、大类分布、标签共现对。
- **主题聚类**：TF-IDF + k-means（余弦距离、k-means++ 初始化、固定随机种子）。
  同一输入 + 同一种子结果完全可复现；空簇会自动重新分配，保证 k 个簇都有内容。

---

## 7. 缓存与增量更新

```bash
# 首次：全量
arxiv update -c cs.LG --limit 200 -f json        # firstRun=true，全部视作新增

# 之后每次：只返回新的提交 / 新的版本
arxiv update -c cs.LG --limit 200 -f json        # newCount=3

arxiv cache stats      # 条目数、占用、命中率
arxiv cache prune      # 清理过期与超限
arxiv cache state      # 每个查询源已见 ID 数、上次运行时间
arxiv cache reset      # 重置增量状态（下次全量）
```

缓存按查询参数做 key，默认 TTL 24 小时（每天最多打一次 arXiv —— 官方明确建议缓存）。
增量状态与缓存**分开存放**：缓存可以过期丢弃，增量状态必须长期保留，丢了就会重复推送老论文。

⚠️ 增量判据有取舍：以 `lastUpdatedDate desc` 排序 + 「`updated ≤ 上次运行时间`即停止翻页」。
若你在两次运行之间改了查询条件，建议用 `--reset-state` 重新建立基线。

---

## 8. 健壮性设计

| 风险 | 处理 |
|---|---|
| arXiv 限速（官方：3 秒 1 次、单连接） | `RateLimiter` 保证**任意两次请求启动间隔 ≥ minIntervalMs**（默认 3000ms），并发默认 1 |
| 瞬时故障 / 502 / 503 / 429 | 指数退避 + 全抖动重试，支持 `Retry-After`；4xx 业务错误不重试 |
| 查询语法错误 | 新版后端返回 HTTP 400 + Atom 错误条目，工具会解析出**人话错误**并给排查建议（不会伪装成「0 条结果」） |
| 挂起的连接 | 应用层超时计时器（不只依赖 socket timeout），保证永不挂死 |
| 分页游标错位 | 用**服务端实际返回条数**推进 `start`，而非请求条数（请求 100 却只回 30 时不会静默跳过） |
| 同一论文多个版本 | 按**不带版本的 ID** 去重，保留版本号最高者，并用旧版补齐新版缺失字段 |
| 跨源重复（同标题不同 ID） | 三级去重：arXiv ID → DOI → 归一化标题 |
| 缓存不可写 | 缓存是纯优化：任何磁盘异常都降级并记 warn，绝不打断检索 |
| 第三方引用数据不给 | 版本历史 / 参考文献抓取失败只记录原因并跳过，条目本身照常返回 |

---

## 9. 目录说明

```
src/
├── cli.js            命令行：参数解析、子命令、输出路由、退出码
├── client.js         ★ 编排核心：查询→限速→重试→分页→解析→去重→缓存/增量→增强
├── query.js          查询串构建（字段前缀 / 布尔 / 分组 / 日期区间 / URL 编码）
├── atom.js           Atom XML 解析（含错误 feed 识别、实体解码、去重合并）
├── http.js           原生 http/https 传输（重定向、应用层超时、Title-Case 头名）
├── rate-limiter.js   限速与并发控制（FIFO + 最小启动间隔）
├── cache.js          磁盘缓存（TTL/LRU）+ 增量状态存储
├── analyze.js        高亮 / 结构化摘要 / 分类统计 / TF-IDF 关键词 / 主题聚类
├── exporters.js      JSON / JSONL / CSV / BibTeX
├── report.js         Markdown 报告 / 终端报表
├── version-history.js 版本历史（abs 页 HTML 解析，可选）
├── references.js     参考文献 / 被引（Semantic Scholar，可选、默认关闭）
├── categories.js     内置分类目录 + 拼写纠错
├── config.js         配置加载与校验（默认 ← 文件 ← env ← CLI）
├── dates.js          日期归一化与区间表达式
├── errors.js         错误分类 + 退出码字典
├── logger.js         分级日志（stderr；支持 JSON 行）
└── index.js          公共 API 汇总导出
```

类型契约见 [`types/index.d.ts`](types/index.d.ts)（`ArxivEntry` / `SearchSpec` / `Config` / `Analysis` 等）。

---

## 10. 测试

```bash
node test/run-all.js                    # 9 套离线测试（约 20s）
node test/run-all.js --include-network  # 追加真实 arXiv 冒烟测试
node test/run-all.js --filter client    # 只跑某套件
```

| 套件 | 覆盖重点 |
|---|---|
| `query` | 引号三态、布尔优先级、日期边界、URL 编码、原始串不被转义 |
| `atom` | 真实响应解析、实体单遍解码、作者机构分块、错误 feed、三级去重 |
| `analyze` | 高亮单遍替换与词边界、中英结构化摘要、统计、聚类确定性与退化 |
| `cache` | TTL、LRU、命中率、只读降级、StateStore 增量语义 |
| `config` | 四级优先级、JSONC/BOM 容忍、越界夹取、非法值点名报错 |
| `exporter` | CSV RFC 4180 转义与 BOM、BibTeX 转义与类型选择 |
| `rate-limiter` | FIFO、最小间隔、并发上限、异常隔离、全抖动范围 |
| `client` | **本地 http 桩服务器**跑通分页/重试/限速/缓存/去重/增量/增强全链路 |
| `cli` | 参数解析、端到端各命令、双通道输出、退出码分类 |
| `network` | 真实 API 的形状、日期区间、ID 精确获取、分页前缀关系（默认跳过） |

---

## 11. 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 未预期错误 |
| 2 | 用法错误（未知选项/命令、缺检索条件） |
| 3 | 网络错误（超时、连接失败、HTTP 5xx/429） |
| 4 | 解析错误（响应不是合法 Atom） |
| 5 | 配置错误 |
| 6 | arXiv 业务错误（查询被拒绝） |

---

## 12. 作为库使用

```js
const { createClient, toCSV, highlight, clusterTopics } = require("./tools/arxiv/src");

const client = createClient({ logger: null, configOverrides: { log: { level: "warn" } } });

const res = await client.search(
  { keywords: ["retrieval augmented generation"], categories: ["cs.CL"], dateFrom: "2026-01-01" },
  { limit: 100, pageSize: 100 }
);

console.log(toCSV(res.entries));
console.log(clusterTopics(res.entries, { k: 4 }).clusters.map((c) => c.topTerms));
```

测试友好：`transport`（传输）、`limiter`（限速）、`cache`、`state`、`sleep`、`backoff`、`now`
全部可注入，因此上层无需联网即可写单测。

---

## 13. 已知限制

- **作者检索是字符串匹配**：`au:Bengio` 能命中 `Yoshua Bengio`，但重名/缩写（`Y. Bengio`）需自行枚举。
- **不支持通配符**：arXiv API 本身不支持，只能放宽关键词后本地过滤。
- **引用关系来自第三方**：arXiv Atom 不含参考文献，`--with-references` 依赖 Semantic Scholar 匿名额度，
  容易 429，故默认关闭。
- **分页总量上限 30000**：arXiv 硬限制，超出返回 400（工具已按此裁剪）。
- **`--from` 语义**：单独给出表示「自该时刻起」（上界开放）；要限定某一天/某个月请显式给 `--to`。

数据来自 arXiv API，请遵守其[使用条款](https://info.arxiv.org/help/api/tou.html)（3 秒 1 次请求、缓存结果、带可识别 User-Agent）。
