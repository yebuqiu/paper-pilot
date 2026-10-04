# AGENTS.md · PaperPilot 文献副驾

> 本文件面向 AI 编码代理与人类协作者，说明**本仓库真实现状**下的开发方式。
> 所有命令、路径、工具链均来自仓库实际内容（`scripts/`、`test/`、`server/`、`manifest.json`）。
> 若你只是要读功能说明，请看 [README.md](README.md) 与 [docs/](docs/)；本文件只讲"怎么改、怎么验、怎么发"。

---

## 1. 项目概览

PaperPilot 是一个 **Zotero 7–10 插件**（浏览器扩展形态，bootstrapped），外加一套**随仓库自带的零依赖 Node 账号后台**。两者版本各自独立演进。

| 组成 | 说明 | 版本锚点 |
|---|---|---|
| **插件本体** | `bootstrap.js` + `chrome/content/**`，Manifest V2 扩展，覆盖阅读助手 / 检索发现 / 笔记卡片 / 批量分析 / 库健康 / 标签状态 / MCP 互操作 / 数据列 / 账号会员等 9 类功能 | `manifest.json` 的 `version`（当前 `0.25.2`） |
| **账号后台** | `server/`，纯 Node 标准库实现：注册登录、会话、会员/订单/激活码/优惠券、官方 AI 模型网关、管理 API 与网页管理页 | `server/account-server.js` 头注释的服务端版本（当前 `1.6.0`） |

- 插件 ID：`paperpilot@dev.local`；兼容 `strict_min_version: "6.999"` → `strict_max_version: "99.*"`。
- 授权：**Apache-2.0**（见 [LICENSE](LICENSE) / [NOTICE](NOTICE)）。插件本体永久免费开源。
- 设计参考了官方 `Make It Red` / `zotero-plugin-template` / `zoterostyle` 的插件结构（见 `bootstrap.js` 头注释）。

### 技术栈

- **插件**：JavaScript（Mozilla 特权 JS 作用域，非浏览器页 JS）+ XHTML/XUL + CSS；**无打包器、无编译步骤**，改完重新打 xpi 即装。
- **服务端**：Node.js（`account-server.js` 注释要求 ≥ 14）+ 内置 `http`/`https`/`fs`，**零第三方依赖**；数据为 `server/data/*.json` 文件存储。
- **脚本/工具链**：Python 3（打包、门禁、接线扫描、GitHub 同步）、Windows PowerShell 5.1 + BAT（启动器 GUI、守护、无窗拉起）。
- **测试**：Node 内置 `vm`/`fs` 手写断言脚本（无 Jest/Mocha），加一个浏览器 E2E。
- **仓库内没有 `package.json`、没有 npm 依赖、没有 ESLint/Prettier 配置**——风格靠约定（见 §5）。

---

## 2. 环境安装与依赖管理

### 2.1 运行/开发所需

| 用途 | 要求 | 说明 |
|---|---|---|
| 运行插件 | Zotero 7–10 | 本机为 Zotero 10.0.5；程序目录 `C:\Program Files\Zotero` |
| 运行账号后台 | Node ≥ 14 | 本机 managed：`C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-5\node.exe` |
| 打包 / 门禁 | Python 3 | 本机：`3.13.12`（managed）；`3.11.9`（system 备选） |
| 启动器 / 守护 | Windows PowerShell 5.1 + `wscript` | GUI 走 WinForms，**必须 `-STA`** |
| 浏览器 E2E | 系统 Chrome + `playwright-core` | 依赖装在 `C:\Users\Administrator\.workbuddy\binaries\node\workspace`，运行时设 `NODE_PATH` |

### 2.2 依赖管理原则

- **插件与后台零运行时依赖**——不要为省事引入 npm 包；`server/` 明确以"零依赖"为设计约束。
- 需要临时脚本依赖时，装到 managed 隔离目录，**不要全局 `npm install -g`，也不要污染系统 Python**。
- **任何密钥一律不进 git**：`prefs.js` 默认值留空；`server/data/` 已被 `.gitignore` 排除（含用户、令牌、通道密钥、日志）。唯一例外是插件内置的 `ES_OFFICIAL_KEY`（用户决策"开箱即用"，优先级 = 用户 pref > 内置 Key）。
- 提交身份必须是 noreply：`cassiuschen9261` / `67265949+13920519261@users.noreply.github.com`。

---

## 3. 常用开发与构建命令

> 所有命令都在**仓库根目录**执行。

### 3.1 测试与质量门禁

```bash
# 一键门禁（推荐，发版前必跑）：全 JS 语法 + arXiv 生成物同步 + 全部 Node 测试套件
#                              + 接线扫描 + 后台 E2E（当前共 23 步）
python scripts/preflight.py

# 快速模式（跳过浏览器 E2E，约 95s，适合改代码时的内循环）
python scripts/preflight.py --fast

# 追加"打包 + 包内自检"
python scripts/preflight.py --with-build 0.25.0

# 单独跑某个测试套件
node test/account-persistence.test.js
node test/membership.test.js
node test/admin-e2e.test.js
node test/arxiv-core.test.js

# arXiv 工具包（tools/arxiv/，CLI + 库；离线约 20s）
node tools/arxiv/test/run-all.js
node tools/arxiv/test/run-all.js --include-network   # 追加真实 arXiv 冒烟

# 接线一致性静态扫描（launcher.ps1 × account-server.js × admin.html × 插件装配）
python scripts/check-wiring.py

# arXiv 核心生成物是否与 tools/arxiv/src 同步
python scripts/build-arxiv-core.py --check
```

`preflight.py` 支持用环境变量 `PP_NODE` 指定 node 可执行文件（默认取 PATH，再退回本机 managed 版本）。

> ⚠️ **新增测试套件时，HTTP 请求助手必须带 `agent: false`**：Node 19+ 客户端默认 keep-alive，
> 而服务端 `keepAliveTimeout` 默认 5s —— 复用一条正被服务端关闭的空闲 socket 会拿到 `ECONNRESET`，
> 表现为**偶发**「异常中断」让门禁假红（`server-ops` 曾 4/6 失败）。`check-wiring.py` §14 有守卫。
> 排障偶发失败时，用 `git archive HEAD | tar -x -C <tmp>` 建干净副本与工作区**交替**跑同一用例。

> ⚠️ **后台 E2E 会静默跳过**：`test/admin-e2e.test.js` 依赖 `playwright-core`（装在
> `C:\Users\Administrator\.workbuddy\binaries\node\workspace`）。preflight 不设 `NODE_PATH`，
> 所以那里通常看到「跳过（未安装 playwright-core）」并以 0 退出——**这不是通过**。
> 想真跑一次：
> ```bash
> export NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules"
> node test/admin-e2e.test.js     # 约 153 项断言
> ```

### 3.2 打包插件

```bash
python scripts/build-xpi.py 0.25.2
# 产物：dist/paper-pilot-0.25.2.xpi（zip，源码目录内容置于根，含包内清单与版本自检）
```

- 打包内容 = 顶层文件（`bootstrap.js` / `LICENSE` / `NOTICE` / `prefs.js` / `README.md` / `manifest.json`）+ 遍历 `chrome/` + `locale/`。
- **`docs/` 与 `test/` 不进包**。
- ⚠️ `build-xpi.py` 里 `ROOT` 是**硬编码本机路径** `E:\project\paper-pilot`；换机需先改这一行。

### 3.3 账号后台（服务端）

```bash
# 直接前台运行（调试用；cwd 必须是 server/）
cd server && node account-server.js

# 生产拉起（幂等：8000 已有应答即退出）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-account-server.ps1

# 图形启动器（账号后台 + 模型通道 + 账号管理 + 会员管理）
启动PaperPilot后台.bat          # 双击运行；内部经 wscript 无窗拉起 launcher.ps1

# 健康检查
curl http://127.0.0.1:8000/api/health
```

- **改了服务端代码必须同轮重启生产 :8000**，否则新客户端会配到旧服务端。
- 守护脚本 `scripts/guard-paperpilot.ps1`（计划任务 `PaperPilotGuard`，每分钟一次）**不因代码更新而重启**，只在端口无人应答时用仓库新代码拉起；`server/data/stopped-account.flag` 存在时保持停机。
- `scripts/start-account-server.ps1` 直接调用会被本机执行策略拦；走上面的 `powershell -ExecutionPolicy Bypass` 形式。

### 3.4 收款流水对账

```bash
node scripts/reconcile.js payments.txt            # 预览（默认 dryRun，不改任何数据）
node scripts/reconcile.js payments.txt --apply    # 确认后核销
node scripts/reconcile.js payments.txt --window 7 --url http://127.0.0.1:8000
```

必须走 HTTP 接口——直接改 `server/data/*.json` 会被服务端内存副本的 `save()` 覆盖。

### 3.5 同步到 GitHub 镜像

```bash
python scripts/sync-github.py            # 本地 HEAD 树 → GitHub refs/heads/main（REST API 通道）
python scripts/sync-github.py --dry-run
```

本机 git 协议访问 github.com 被网络阻断，故走 `api.github.com` 重建提交（提交 SHA 与本地不同、无历史）。PAT 从 Windows 凭据管理器读取，不落盘。

---

## 4. 目录与文件组织说明

```
paper-pilot/
├── manifest.json              ★ 插件版本号在此迭代
├── bootstrap.js               ★ 插件入口（加载 main.js、注册 chrome 协议、诊断日志）
├── prefs.js                   ★ 全部 pref 默认值（无密钥）
├── paperpilot-update.json     Zotero 更新清单（Gitee raw 直链，逐版追加）
├── 启动PaperPilot后台.bat      启动器入口（GBK 编码 + chcp 936）
├── 升级PaperPilot.bat          本地强制覆盖安装插件（GBK 编码）
├── LICENSE / NOTICE           Apache-2.0
│
├── chrome/content/            插件前端与逻辑（打包进 xpi）
│   ├── prefs.xhtml/js        设置面板（fragment）
│   ├── prefs-account.js      设置面板·账号/会员卡片逻辑
│   ├── prefs-theme.js        设置面板·主题逻辑
│   ├── prefs.css             设置面板样式（随系统明暗切换，类名 .pp-）
│   ├── workbench.xhtml/js    工作台 2.0（独立窗口）
│   ├── hub.xhtml/js          功能中心（统一导航）
│   ├── compare / discovery / automation / lib-ask / mcp /
│   │   meta-rules / note-graph / paste-check / tag-preview / refs-picker
│   │                         ·xhtml + ·js 各功能独立窗口/对话框
│   ├── data/journal-rank.json  分区列离线兜底数据
│   ├── icons/                图标（icon.png / chat.svg）
│   └── scripts/
│       ├── main.js           ★ 模块装配清单（files[] 依赖序 + 挂 Zotero.PaperPilot）
│       ├── menus.js          工具菜单注入
│       ├── core/utils.js     Prefs 包装 / I18n / Markdown→笔记 HTML / Notes / 选中归一化
│       ├── ai/               账号 / 模型通道 / LLM 客户端(SSE) / 问答 / Prompt / 自动标签 / S2
│       ├── features/         40+ 功能模块（各为一个全局 var 对象）
│       ├── columns/          期刊分区列 / 被引量列
│       └── panels/           侧栏 section（AI 问答 / PDF 速览）
│
├── locale/{en-US,zh-CN}/paperpilot.ftl   XHTML 用文案
│
├── server/                   账号后台（独立于 xpi，零依赖）
│   ├── account-server.js     ★ 入口：路由 + HTTP + 限速 + 网关
│   ├── lib/                  领域模块：membership / coupon / pricing / balance / reconcile /
│   │                         sessions / audit / backup / alerts / lockout / mail /
│   │                         presets / store
│   ├── public/               管理页与自助页 HTML：admin.html / register / reset / verify / forgot
│   └── data/                 ★ 运行时数据（gitignore）：users.json / membership.json /
│                             channels.json / pricing.json / audit.log / guard.log /
│                             server-console.log / pp.env
│
├── scripts/                  工具（不进 xpi）
│   ├── build-xpi.py          打包 + 包内自检
│   ├── preflight.py          一键门禁
│   ├── check-wiring.py       接线一致性静态扫描
│   ├── sync-github.py        同步 GitHub 镜像
│   ├── reconcile.js          收款对账 CLI
│   ├── launcher.ps1          启动器 GUI（WinForms）
│   ├── guard-paperpilot.ps1  守护（账号后台 + 隧道）
│   ├── start-account-server.ps1 / start-server-hidden.vbs  无窗拉起
│
├── test/                     测试（不进 xpi）
│   ├── account-persistence / membership / price / usage / membership-panel /
│   │   server-ops / audit / reconcile / coupon / sessions / ai-tier /
│   │   pricing / metering / balance / arxiv-core / smoke-load
│   │                         .test.js（Node 单测；arxiv-core 守生成物等价性）
│   ├── legacy-rootcause.probe.js   历史根因探针（接受 git-ref 参数）
│   └── admin-e2e.test.js     后台浏览器 E2E（无浏览器/NODE_PATH 时自动跳过）
│
├── tools/                    开发工具（不进 xpi）
│   └── arxiv/                ★ 零依赖 arXiv 检索/抓取/分析工具包（CLI + 库）
│       ├── bin/arxiv.js      CLI 入口（search/get/update/stats/categories/cache/check）
│       ├── src/              16 个模块：client 编排 + query/atom/analyze/exporters…
│       ├── types/index.d.ts  API 类型契约
│       ├── examples/         真实 API 响应快照 + 示例输出 + 示例配置
│       └── test/             9 套离线 + 1 套联网（run-all.js 汇总）
│
├── dist/                     发行版 xpi（★ 必须入库）
└── docs/                     设计/手册文档（不进 xpi）
```

> **★ `tools/arxiv/src` 是插件侧 arXiv 核心的单一真源**：`chrome/content/scripts/arxiv/arxiv-*.js`
> 由 `scripts/build-arxiv-core.py` **生成**（`var ArxivXxx = (function(){…})()`，去掉 require/module），
> 因为 Zotero 特权作用域没有 `require`，而 Node 工具包不能直接进 xpi。
> 改逻辑改 `tools/arxiv/src/`，然后重跑生成器 —— 详见 §8.3。

---

## 5. 代码规范与命名约定

### 5.1 通用

- **缩进 2 空格**；语句结尾分号不省略；字符串统一用**直引号**。
- 注释、提交信息、文档用中文（代码标识符与 API 路径用英文）。
- 只在必要时写注释；但**踩坑原因、非显然的取舍必须写清**（本仓库注释风格偏"记录为什么"）。

### 5.2 插件模块范式（务必遵守）

- 每个功能模块是**一个全局对象**：`var Xxx = { ... };`，放在 `chrome/content/scripts/{core,ai,features,columns,panels}/` 下。
- 新模块必须**同时**做两件事：
  1. 在 `chrome/content/scripts/main.js` 的 `files[]` 数组里，**按依赖顺序**加入相对路径（被依赖者在前）；
  2. 在 `init()` 里把对象挂到 `Zotero.PaperPilot.<name>`，供独立窗口/面板脚本访问（它们运行在各自作用域，**看不到 bootstrap 作用域**）。
- 独立窗口脚本拿 `Zotero`/`Services` 只经 `window.arguments`（`openDialog(..., { Zotero, Services })`）传递，**不要用 `opener.Zotero` 或窗口内 `importESModule`**。
- 需要跨窗口/UI 的模块在 `destroy()` 里必须**成对**注销（`unregister`/`stop`），见 `main.js` 的 `destroy()`。
- 加载脚本一律带 `?v=<version>` 查询串做缓存破坏（热升级会命中旧编译产物）。

### 5.3 配置（pref）

- 键名：`extensions.zotero.paperpilot.<key>`；**默认值只在 `prefs.js` 声明**，代码里通过 `Prefs.get(key, fallback)` / `Prefs.set(key, value)`（`core/utils.js`）读写。
- Mozilla pref **没有浮点类型**：小数（温度、字号缩放、不透明度）一律存字符串，代码里 `Number()` 解析。
- 新增/改名 pref 后，`prefs.js` 与 `check-wiring.py`（键 vs 默认值）要同步。

### 5.4 UI / 样式 / 文案

- 设置面板 CSS 用 `PreferencePanes.register({ stylesheets: [...] })` 注入；明暗靠 `prefers-color-scheme`，**类名统一 `.pp-` 前缀并收在 `.pp-root` 下**。
- 颜色一律用 CSS 变量，禁止硬编码 hex（主题换肤依赖变量层叠）。
- 菜单等无法走 Fluent 的地方用 `I18n.t(key)`（内联词表在 `core/utils.js`）；XHTML 文案走 `locale/*/paperpilot.ftl`。
- **AI 未就绪时不得静默 `return`**：一律"照常渲染 + 精确原因 + 一键去设置"。

### 5.5 服务端（`server/`）

- 入口 `account-server.js` 用原生 `http` 分发路由；领域逻辑放 `server/lib/*.js`。
- 持久化统一走 `lib/store.js` 的 `JsonStore`；**改数据只经接口**，不直改 `data/*.json`。
- 金额权威字段是**「分」**（`*Cents`）；管理接口用 `isLocalAdmin`（回环且无代理头）保护。
- **新增管理写操作要同时补三处**：① `auditLog(req, '动作')`；② 后台 UI 展示（如需）；③ `check-wiring.py` 断言。审计中文名在 `server/lib/audit.js` 与 `launcher.ps1` 的 `Get-AuditText` **各存一份**，加动作两处都要改。
- 新增关注字段时，**局部更新的 merge 白名单、表单回填、`check-wiring.py` 断言**要一起加（漏过 `priority`、`highTierModels`、`ai.trialDays`）。

### 5.6 PowerShell / BAT

- `.ps1` **必须 UTF-8 带 BOM**（无 BOM 会被 PS 5.1 按 GBK 解码 → 中文乱码 + 假语法错误）。
- `.bat` 面向用户输出中文时**必须 GBK 落盘**并配 `chcp 936`。
- PS 5.1 兼容：不用 `&&`/`||`/三元/`??`；**续行的运算符必须在行尾**（行首 `+` 会报"缺少右)"）。

---

## 6. 测试与质量检查流程

### 6.1 测试分层

| 层 | 位置 | 覆盖 |
|---|---|---|
| **JS 语法** | `preflight.py` 步骤 1 | `node --check` 遍历 bootstrap.js + `chrome/**` + `server/**` + `test/**` |
| **Node 单测（13 套）** | `test/*.test.js` | 会话持久化、会员域、价格表、用量、面板渲染、运维三件套、审计、对账、优惠券、登录设备、套餐 AI、根因探针、全模块加载冒烟 |
| **接线静态扫描** | `scripts/check-wiring.py` | launcher 函数/接口 × 服务端路由 × admin.html 页面一致性 |
| **浏览器 E2E** | `test/admin-e2e.test.js` | 真跑后台管理页；缺浏览器依赖时退出 0（自动跳过） |

### 6.2 门禁

- **改代码内循环**：`python scripts/preflight.py --fast`
- **发版前**：`python scripts/preflight.py`（全量）；打包含自检时用 `--with-build <ver>`。
- 任一环节失败 → 非零退出，并打印"哪一步失败 + 怎么单独复现"。

### 6.3 写新测试的既有约定

- 测试是**手写断言脚本**：`ok(cond, label, extra)` / `eq(a,b,label)` 计数，末尾打印结果并 `process.exit(0/1)`。
- 不依赖真实 Zotero：用 `vm.createContext` + mock（`IOUtils`/`Zotero`/`Services`/`Prefs`）。
- `smoke-load.test.js` 用**深 Proxy** 顶替 Zotero/Services，按 `main.js` 清单在同一 vm context 依序加载全部模块，抓加载期回归（`then` 必须返回 `undefined`，避免被当作 thenable）。新增模块会自动纳入冒烟范围。
- 三套高价值测试技法（全模块加载冒烟 / 设置面板真渲染 / 异步串行队列"别只 await 一次" + 接线扫描匹配纪律）详见项目记忆 `memory/历史模块要点.md`「测试技法」——写新测试前先读，别重造。

### 6.4 测试纪律（高频踩坑）

- **HTTP 测试端口一律 `server.listen(0)` 再回读 `server.address().port`**——不要写死或随机端口（本机常驻 Prism 网关占 `18790/18791`，会 `EADDRINUSE`）。
- **时间相关期望相对 `Date.now()` 生成**，只用整日偏移；不要写固定旧时间戳（"最近 N 天"类规则会落在窗口外而等于没测）。
- 定位类 helper **按 id 精准取**，别用 `find(第一个匹配)` 当"最老的那笔"。
- 不吞异常：`catch{}` 静默会让断言假通过；测试中的失败必须显式暴露。

---

## 7. 提交与分支规范

- **主分支 `main`**。`origin` = Gitee（`cassiuschen9261/paper-pilot`），`github` = GitHub 镜像（`yebuqiu/paper-pilot`）。
- **禁止 `git add -A` / `git add .`**：一律**显式列出路径**。本工作区可能多会话并发，混合 diff 的归属要在提交信息里说明。
- **提交信息格式**：以版本/批次为前缀，例如
  - 插件：`0.24.8(服务端 1.4.9): 套餐 AI 能力分级 —— 官方模型白名单 + 新用户全模型试用`
  - 纯服务端：`服务端 1.5.0: AI 计费计量 —— 网关按 token 记成本 + 单价表 + 成本看板`
  - 纯服务端：`服务端 1.6.0: 余额域 —— 注册赠送 / 充值 / 按成本扣减 / 观察模式`
  - 纯服务端：`服务端 1.4.7: 登录设备与会话管理`
- **版本号口径**：只改服务端/脚本就别挂一个不会发布的插件版本号（服务端版本看 `/api/health` 的 `version`）；插件没动就不动 `manifest.json` 和 xpi。
- GitHub Releases **自 v0.14.5 后不再创建**；GitHub 镜像走 `sync-github.py`。
- **`dist/*.xpi` 必须入库**（`.gitignore` 用 `!dist/` + `!dist/*.xpi` 反豁免）。

### 发版五步（+ 第 0 步）

0. `python scripts/preflight.py`（可 `--with-build <ver>`）；
1. `git status` 辨他人在制品；
2. 显式 `git add <paths>` + `git tag v<x.y.z>`；
3. `git push origin main` + `git push origin v<x.y.z>`；
4. `curl -L` 取远端 `paperpilot-update.json` 验证 + 下载 xpi 比 sha256 与包内 `manifest.json` 版本；
5. `python scripts/sync-github.py`（自检 blob 数）。

> ⚠️ **"双推 + curl 验证"只证明服务端就绪**。Zotero 只在自身启动时查更新，发版后要交叉核对**客户端真实版本**：profile 内 xpi 的 sha1 / `paperpilot-boot.log` 末行 / `extensions.json` 的 `version`。

---

## 8. 常见任务操作指引

### 8.1 新增一个插件功能模块

1. 在 `chrome/content/scripts/features/<name>.js` 新建 `var <Name> = { ... };`（需要窗口 UI 时配 `<name>.xhtml`）。
2. 在 `main.js` 的 `files[]` 按依赖顺序加入，并在 `init()` 里挂 `this.<name> = <Name>;`；有资源需清理的加到 `destroy()`。
3. 如需菜单项，改 `menus.js`；如需设置项，先在 `prefs.js` 加默认值。
4. 跑 `python scripts/preflight.py --fast`（冒烟测试会自动加载新模块）。

### 8.2 新增 / 修改一个 pref

1. `prefs.js` 加/改默认值（键名 `extensions.zotero.paperpilot.<key>`）。
2. 代码里用 `Prefs.get/set`；需要即时生效的，在 `main.js` 的 `_watchPrefs()` 注册观察者并在 `_onPrefChanged()` 处理。
3. `python scripts/check-wiring.py` 会校验"新键 vs prefs.js 默认值"。

### 8.3 修改 arXiv 检索 / 抓取 / 解析逻辑（★ 单一真源纪律）

**绝不要直接改 `chrome/content/scripts/arxiv/arxiv-*.js`** —— 它们是生成物（头部有
`AUTOGENERATED` 标记），下次生成即被覆盖。

```bash
# 1) 改源（单一真源）
vim tools/arxiv/src/atom.js          # 解析/去重
vim tools/arxiv/src/query.js         # 查询串构建
vim tools/arxiv/src/analyze.js       # 高亮/结构化摘要/聚类

# 2) 重新生成到插件侧（会自动跑 node --check 自检语法）
python scripts/build-arxiv-core.py

# 3) 回归
node tools/arxiv/test/run-all.js      # 工具包侧（CLI/库）
node test/arxiv-core.test.js          # 插件侧（生成物等价性 + ArxivFetch 端到端）
python scripts/preflight.py --fast    # 含「arXiv 生成物同步」漂移检查
```

规矩与原因：

- **白名单机制**：只有不依赖 Node 内置模块的「纯模块」才能生成（errors / dates / query /
  categories / atom / analyze / rate-limiter）。要新增一个，往 `build-arxiv-core.py` 的
  `MODULES` 里加，并确认它没有 `require("fs"|"http"|"crypto"|"path"|"os")`——生成器会拒绝并报错。
- **装配顺序 = 依赖序**：`main.js` 的 `files[]` 里 arxiv 核心必须排在 `features/discovery.js` 之前，
  且内部按 errors → dates → query → categories → atom → analyze → rate-limiter → fetch 排。
  顺序错会在加载期抛 ReferenceError，而 `loadSubScript` 失败只写一行 boot 日志、功能静默降级。
- **网络只能经 `ArxivFetch`**：`arxiv-fetch.js` 是唯一的 HTTP 出口，它负责 3 秒限速、
  指数退避重试、分页、判断 `req.status`（`Zotero.HTTP.request` 对 4xx/5xx **不抛异常**）。
  不要在其他地方直接 `Zotero.HTTP.request` 打 arXiv。
- **语义守护**：`Discovery` 的多分类必须是 **OR**（并集）。arXiv 的 `cat:A AND cat:B` 只命中
  「同时属于两个分类」的交叉列表论文，会把「cs.AI / cs.CL / cs.LG 里有什么新东西」的
  结果集静默缩小。`check-wiring.py` §16.100 专门守这条。
- **实机自检**：启动时 `ArxivFetch.selfTest()` 在真实 Zotero 作用域里跑一遍离线的
  构建/解析/去重断言，结论写进 boot 日志（`arxiv core self-test: ok query=1 atom=1 …`）。
  生成物一旦转换出错，这是第一眼能看到的证据。

### 8.4 新增一个后台管理写操作

1. 服务端：路由 + 业务 + **`auditLog(req, '动作')`**。
2. 后台展示：`server/public/admin.html` 与/或 `scripts/launcher.ps1`（若加审计中文名，**`lib/audit.js` 与 `launcher.ps1` 的 `Get-AuditText` 两处都要改**）。
3. `scripts/check-wiring.py` 补断言（函数/接口/控件变量/路由）。
4. `python scripts/preflight.py --fast` 全绿后再重启生产 :8000。

### 8.5 新增 / 修改服务端接口

- 领域逻辑放 `server/lib/`，入口只做路由与鉴权。
- 管理接口必须走 `isLocalAdmin`；用户接口走 Bearer。
- **改动后同轮重启生产 :8000**，并核对 `/api/health` 的 version 与新增字段。
- 破坏性/批量操作遵循"**先出问题清单 → 用户勾选 → 才写库**"；提示类只展示不自动改。

### 8.6 本地强制升级插件（Zotero 未运行）

备份 profile 内 xpi / `extensions.json` / `addonStartup.json.lz4` → 覆盖 profile 里的 xpi → **删除 `addonStartup.json.lz4`**（缺失即触发全量重扫）。或直接双击 `升级PaperPilot.bat`（注意其内写死的版本号/路径需按需更新）。

profile 路径：`C:\Users\Administrator\AppData\Roaming\Zotero\Zotero\Profiles\swc79sqh.default`，
xpi 固定名 `extensions/paperpilot@dev.local.xpi`。

**实机验证（改完插件必做一次，光看单测绿是不够的）**：

1. `python scripts/build-xpi.py <ver>` 打包，`sha256` 记下。
2. 覆盖安装后**核对 profile 内 xpi 的 sha256 与 dist 产物一致**（不一致说明覆盖没生效）。
3. 启动 Zotero —— 两个坑都在这里：
   - **`-P` 接的是 profile 名（`default`），不是目录名（`swc79sqh.default`）**；
     传目录名会走 Profile Manager 然后直接退出，什么都不加载。最省事是只用 `-no-remote`，
     由 `profiles.ini` 的 `Default=1` 选默认 profile。
   - **必须用 `DETACHED_PROCESS` 直接 CreateProcess 启动**（Python `subprocess.Popen` +
     `creationflags=0x8|0x200`）。用 Bash 的 `&` 启动，或经 `cmd /c start` 中转，
     都会被工具调用的进程树回收——表现为「日志一行都没写」。
4. 读**数据目录**的 `paperpilot-boot.log`（`C:\Users\Administrator\Zotero\`）与 profile 同名文件，
   核对：`startup begin v<ver>`、新增功能各自的 `... registered`、**无 `STARTUP FAILED`**、
   `init complete`。插件模块加载失败只写 `loadSubScript FAILED <file>` 一行，容易被忽略。
5. 三处交叉核对版本：profile xpi 的 sha256 / boot 日志的 `v<ver>` / `extensions.json` 的 `version`
   （Zotero 只在**自己启动时**查更新，所以「双推 + curl 验证」只证明服务端就绪，不证明客户端已升）。
6. 关闭 Zotero：`taskkill /IM zotero.exe`（优雅）→ 超时再 `/F`。之后 `parent.lock` 残留无害。

### 8.7 重启账号后台

```bash
# 停：干掉占用 8000 的进程（守护会在端口无人应答时用仓库新代码拉起）
# 起：双击 启动PaperPilot后台.bat，或
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-account-server.ps1
```

---

## 9. 注意事项（改代码前必读）

- **本工作区可能多会话并发**：发版前 `git status` 辨在制品；**禁止 `git add -A`**。`build-xpi.py` 遍历整棵 `chrome/`，**产物侧会自动打包他人的在制品**——并发期要么从干净 git 树构建、要么停发；非本人文件 mtime 仍在变时**不构建、不发布**。
- **密钥不进 git**；`server/data/` 已 gitignore；提交身份用 noreply。
- **服务端零依赖**是硬约束，别引第三方包。
- **`build-xpi.py` 的 `ROOT` 是硬编码本机路径**，换机先改。
- **`.ps1` UTF-8+BOM、`.bat` GBK**；PS 续行运算符放行尾。
- **`IOUtils.writeUTF8` 永不传 `mode`**（它要字符串枚举，传数字 `0o600` 会导致"写入不产出文件"却报成功——这是历史"掉登录"的真凶）；原子写只用 `{tmpPath}`，写完回读校验，失败必须上报 UI。
- **测试端口用 `listen(0)`**；时间戳相对 `Date.now()`；别用会吞异常的 `catch{}`。
- 文档与过程记录：长期纪律见项目记忆 `MEMORY.md`，模块级坑位见 `memory/历史模块要点.md`，改动前**先读相关章节**。

---

## 10. 相关文档

- [README.md](README.md) — 功能总览、安装、更新通道
- [docs/使用教程.md](docs/使用教程.md) — 安装与逐功能说明
- [docs/账号系统与模型通道.md](docs/账号系统与模型通道.md) — 账号/网关部署
- [docs/账号持久化与会员体系.md](docs/账号持久化与会员体系.md) — 会话持久化 + 会员实现/迁移/运维手册
- [docs/PaperPilot-功能路线图.md](docs/PaperPilot-功能路线图.md) — 分阶段功能规划
