# 在非企业版 WPS 里用 Zotero 插文献（WPS-Zotero 方案）

> 目标：WPS 文字（个人版，无 VBA）里出现 **Zotero** 选项卡，能「Add/Edit Citation」插入引文、
> 「Add/Edit Refs」生成参考文献表、「Refresh」刷新样式，且与 MS Word 互通。
>
> 一键安装：`python scripts/wps-zotero/install.py` ｜ 自检：`python scripts/wps-zotero/doctor.py`

---

## 1. 结论先说

| 项目 | 结论 |
|---|---|
| 适用 WPS | **2019 及以上，个人版可用**（不需要企业版/专业版，不需要 VBA） |
| 适用 Zotero | **7 / 8 / 9 / 10**（本机实测 Zotero **10.0.6**） |
| 本机实测 WPS | **12.1.0.28802（个人版，x86）**，安装路径 `...\Kingsoft\WPS Office\12.1.0.28802\office6\wps.exe` |
| 依赖 | Python 3（只用来跑一个 60 KB 的本地 CORS 代理，标准库，无第三方包） |
| 需要联网 | 不需要（加载项源码已随仓库放在 `tools/wps-zotero/addon/`） |
| 系统 | Windows（macOS/Linux 上游另有包，本脚本只管 Windows） |

商用 WPS 的「Zotero 集成」是 WPS 365 企业版自带的；个人版没有，所以要自己接一条链路。
社区做法就是 **WPS JS 加载项 + Zotero 的 HTTP 集成协议 + 本地代理**，本项目把这套做法修到能在
WPS 12 上跑通，并固化成一键脚本。

---

## 2. 原理

### 2.1 引用到底是谁算的

Zotero 的引用格式（CSL 引擎）、文献库、去重与「同一处多篇合并」全在 **Zotero 客户端**里。
它对外暴露一个本地 HTTP 服务（`127.0.0.1:23119`），协议叫 **HTTP integration protocol**：

```
文字处理器插件  ──POST /connector/document/execCommand──▶  Zotero
                ◀── {"command": "...", "arguments": [...]} ──
文字处理器插件  ──POST /connector/document/respond──────▶  Zotero（回传执行结果）
```

也就是说：**插件本身不排版**，它只是「Zotero 的手和眼睛」——Zotero 说「在光标处插一个域」，
插件就去文档里插域；Zotero 说「把这段格式化文本写进去」，插件就写。

### 2.2 为什么个人版 WPS 不能直接用 Zotero 的 Word 插件

Zotero 官方的 `Zotero.dotm` 是 **VBA 宏 + Word 对象模型**。WPS 个人版安装包里**不带 VBA**，
`Zotero.dotm` 放进去也不执行。企业版带 VBA，所以官方文档对企业的说法是「加载 dotm 即可」。

个人版的替代品是 WPS 官方的 **JS 加载项（jsapi）**：一段 HTML+JS，由 WPS 加载，
能用 `wps.WpsApplication()` 操作文档、用 `ribbon.xml` 加选项卡。
社区项目 [tankwyn/WPS-Zotero](https://github.com/tankwyn/WPS-Zotero)（310★，GPL-3.0）
就是用它把上面那套 HTTP 协议接到了 WPS 上。

### 2.3 三个必须解决的问题（也是本方案与"照抄教程"的差别）

| # | 问题 | 现象 | 本方案的处理 |
|---|---|---|---|
| 1 | **跨源限制**：加载项跑在浏览器环境，Zotero 的响应不带 CORS 头 | 所有请求被浏览器拦掉 | 本地代理 `127.0.0.1:21931` 转发到 `23119`，并补 `Access-Control-Allow-Origin` 等头；`OPTIONS` 预检直接本地应答 |
| 2 | **Zotero 10 校验 Host 头**（新变化） | 代理原样透传 `Host: 127.0.0.1:21931` → Zotero 一律 `400 Bad request` | 转发前把 `Host` 改写回 `127.0.0.1:23119`（本方案新修） |
| 3 | **WPS 12 不认"开发模式"注册** | `publish.xml` 里写 `url="http://127.0.0.1:3889/"` 时加载项根本不加载 | 改用 WPS 官方 `wpsjs build` 的**本地安装**格式：`url="<名字>_<版本>"` + `customDomain=""`，指向 `jsaddons` 下真实目录 |

另外两个本机踩到的坑：

- **`document.write` 注入脚本在 WPS 12 不执行**：原版 `index.html` 只引 `main.js`，由它
  `document.write` 出 5 个 `<script>`。WPS 12 里这些脚本没有执行，`OnAddinLoad` 从未定义，
  功能区自然没有选项卡。本方案改成静态 `<script src>`。
- **`wps.OAAssist.ShellExecute` 在 WPS 12 已失效**（上游 issue #16）：加载项原本靠它拉起代理，
  现在不生效。本方案改为**外部常驻代理 + 注册表 Run 项自启**，不依赖加载项去启动进程。

### 2.4 数据流（装好之后）

```
WPS 文字
  └─ Zotero 选项卡（ribbon.xml）
       └─ OnAction → zc_bind().command('addEditCitation')
            └─ POST http://127.0.0.1:21931/connector/document/execCommand
                 └─ proxy.py 改写 Host、补 CORS
                      └─ Zotero 23119：弹出「添加/编辑引文」搜索框，你选中文献
                           └─ Zotero 回 `setText / insertField` 等命令
                                └─ 加载项在文档里写入 Zotero 域（含 CSL_CITATION 数据）
```

---

## 3. 安装（3 步，约 2 分钟）

```bash
# 1) 安装：复制加载项、写注册清单、部署代理并设开机自启
python scripts/wps-zotero/install.py

# 2) 完全退出 WPS（包括托盘常驻），重新打开任意 .docx
#    首次会弹「加载项"wps-zotero"首次加载，是否信任？」→ 点【确定】
#    （如果之前改过加载项，会改问「已经被修改，是否继续加载？」→ 同样点【确定】）

# 3) 自检，全绿即成功
python scripts/wps-zotero/doctor.py
```

安装脚本做了什么：

| 步骤 | 落点 |
|---|---|
| 复制加载项 | `%APPDATA%\kingsoft\wps\jsaddons\wps-zotero_1.0.0\` |
| 注册清单 | 同目录 `publish.xml` 追加 `<jsplugin name="wps-zotero" type="wps" url="wps-zotero_1.0.0" version="1.0.0" enable="enable_dev" install="null" customDomain=""/>` |
| 清旧授权 | 同目录 `authaddin.json` 删掉该加载项记录（让 WPS 重新确认一次并写入正确签名） |
| 部署代理 | `%APPDATA%\Papilot\wps-zotero\proxy.py`（**放在加载项目录之外**，以后升级代理不会改动加载项签名、不会再触发"已被修改"） |
| 开机自启 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\PapilotWpsZoteroProxy` |

> 为什么代理要放外面：WPS 会校验加载项目录的内容哈希，改任何文件都会再问一次"已被修改"。
> 把可迭代的代理挪出去，加载项就能保持"只确认一次"。

卸载：

```bash
python scripts/wps-zotero/install.py --uninstall
```

> 只更新代理（不动加载项、不触发确认框）：`python scripts/wps-zotero/install.py --proxy-only`

### 3.4 插件内的「WPS 集成」卡片（0.68.1 起）

Papilot 设置面板 →「界面与效率」→ **WPS 集成（个人版可用）**，不用记命令：

| 元素 | 作用 |
|---|---|
| 状态五行 | 加载项 / 注册记录 / WPS 信任 / CORS 代理 / Zotero 集成端口，一眼看出断在哪 |
| **一键修复** | 部署代理（随插件分发的 Apache-2.0 `proxy.py`）→ 重写 `publish.xml` 注册 → 拉起代理；幂等，**不动**信任记录 |
| 启动代理 | 手动拉起 21931（没勾自动代理时用） |
| 打开加载项目录 / 安装脚本目录 | 直接跳到 `jsaddons` 与仓库脚本目录 |
| 启动 Zotero 时自动拉起代理 | 勾选后写 `wpsAutoProxy`，下次启动自动起代理（默认关） |

许可边界（刻意如此）：卡片**只带自有代码**（`prefs-wps.js` / `wps-bridge.js` / `tools/wps/proxy.py`），
WPS 加载项本体（GPL-3.0）不随插件分发 —— `check-wiring §60.14` 会守着 `chrome/` 下不得出现加载项资源。
所以首次安装仍需跑一次 `install.py`；之后所有"坏了"的情况都能在卡片里点回来。

### 3.5 加载项本体从哪来（0.68.2 起：卡片内一键下载）

加载项是 GPL-3.0，**不进 xpi**；但它也不再依赖"你先把仓库 clone 下来"。发布物在 `dist/`：

| 文件 | 用途 | 说明 |
|---|---|---|
| `papilot-wps-addon.bundle.json` | **卡片「下载并安装加载项」用** | 文件→base64 内嵌；插件下载后直接落盘，不依赖 ZipReader，可被单测完整覆盖 |
| `papilot-wps-addon.zip` | 人工安装/查阅 | 解压即得加载项目录，可直接放进 `jsaddons` |
| `papilot-wps-addon.manifest.json` | 核对与排障 | 版本、两个产物的 sha256、文件清单 |

文件名**固定不带版本号**（下载地址稳定），版本号取自包内 `version.js`，所以升级加载项不需要改代码。
默认下载地址：`https://gitee.com/cassiuschen9261/zotero-papilot/raw/main/dist/papilot-wps-addon.bundle.json`；
内网/镜像可用 pref `wpsAddonUrl` 覆盖。**三条源依次尝试**：自定义地址 → 内置 Gitee → 本地仓库 `tools/wps-zotero/addon`（开发机）。

安装是"先写 `*.installing` 临时目录再整体替换"，中途失败不会留下半个加载项；落盘前会挡掉
`../`、绝对路径、盘符路径，并校验 7 个必需文件与 `index.html` 是否静态引入。

维护者改完加载项后：

```bash
python scripts/wps-zotero/build-addon-zip.py     # 重新生成 dist/ 三个产物
# 提交 dist/papilot-wps-addon.* → 用户点一次「下载并安装加载项」即可更新
```

---

## 4. 日常使用（8 个按钮·中文界面）

> 加载项 **1.0.1 起为中文版**：选项卡叫 **Zotero 引用**，按钮、悬浮提示、错误弹窗全部中文；
> 英文原名放在悬浮提示（screentip/supertip）里，便于对照上游文档与搜索结果。

| 按钮（英文原名） | 用途 |
|---|---|
| **插入/编辑引文**（Add/Edit Citation） | 光标处插入引文；光标已在某条引文里时是"编辑它" |
| **插入/编辑文献表**（Add/Edit References） | 文末生成/更新参考文献表 |
| **刷新**（Refresh） | 文献库改了、样式换了 → 全文引文与文献表一起重排 |
| **首选项**（Preferences） | 换 CSL 样式（APA / GB/T 7714 / Nature…）与语言 |
| **插入笔记**（Add Note） | 把 Zotero 笔记作为段落插入 |
| **解除链接**（Unlink Citations） | 删域代码、彻底解除链接（不可逆，只在终稿用） |
| **导出**（Export） | 导出成其它文字处理器可导入的格式 |
| **关于**（About） | 版本、作者与 GPL-3.0 许可说明 |

细节：

- 引文请**存成"域"而不是"书签"**，否则本插件不支持后续刷新（这是上游设计约束）。
- 插入时弹出的搜索框是 **Zotero 的窗口**，偶尔不前置 → 点一下任务栏 Zotero 图标即可。
  也可以让 Zotero 强制前置：`extensions.zotero.integration.keepAddCitationDialogRaised = true`。

---

## 5. 怎么验证真的成了（三层）

### 5.1 链路层：一条命令看全貌

```bash
python scripts/wps-zotero/doctor.py
```

期望输出（本机实测）：

```
[ OK ] WPS 12.1.0.28802 (x86)  D:\...\office6\wps.exe
[ OK ] Zotero 在 23119 端口应答
[ OK ] CORS 代理在 21931 端口，健康检查: {"ok":true,"zotero":true}
[ OK ] 代理 → Zotero 转发正常（Host 头已改写）
[ OK ] publish.xml 已注册: <jsplugin name="wps-zotero" ... customDomain=""/>
[ OK ] 加载项目录: ...\jsaddons\wps-zotero_1.0.0
[ OK ] WPS 已信任该加载项（isload=true, md5 已记录）
[ OK ] 代理自启项: "...pythonw.exe" "...\Papilot\wps-zotero\proxy.py"
```

单独验代理（不经 WPS）：

```bash
curl http://127.0.0.1:21931/__health
# {"ok":true,"zotero":true}
curl -i http://127.0.0.1:21931/connector/ping
# HTTP/1.0 200 OK + Access-Control-Allow-Origin: * + "Zotero is running"
```

### 5.2 界面层：选项卡在不在

打开任意 .docx → 功能区应出现 **Zotero** 选项卡，展开后有上表 8 个按钮。
没有的话按 §6 排查。

### 5.3 结果层：文档里对不对

1. 光标放到正文某处 → **插入/编辑引文** → 输入关键词（如 `attention`）→ 选中文献 → 回车；
   正文出现形如 `(Vaswani et al., 2017)` 的灰底文字。
   - 灰底 = 域。若显示正常但不能刷新，说明存成了书签。
2. 光标移到文末 → **插入/编辑文献表** → 生成参考文献表。
3. 在 **首选项** 里换一个样式 → **刷新** → 全文引文与文献表同时变格式（**这是链路真正打通的铁证**，
   因为它要求 Zotero 重新计算并回写全部域）。
4. 保存 → 关闭 → 重开：引文仍在、仍可编辑。
5. 进阶互通性验证：把 .docx 用 MS Word 打开（装 Zotero Word 插件），
   引文应能继续 Refresh——插件写入的域结构与 Word 版一致（唯一差别是
   `formattedCitation` 用 XML 而非 RTF，Zotero 会自动纠正）。

---

## 6. 排障（按现象查）

| 现象 | 原因 | 处理 |
|---|---|---|
| 功能区**没有** Zotero 选项卡 | ① 首次信任没点 ② WPS 没真正退出 ③ `publish.xml` 格式不对 | 完全退出 WPS 重开并点【确定】；`doctor.py` 看注册项；确认 `url` 是 `wps-zotero_<版本>` 而不是 `http://127.0.0.1:3889/` |
| 点按钮弹「Network error / 无法连接」 | 代理没跑 | `python scripts/wps-zotero/install.py --proxy-only`，或手动 `pythonw %APPDATA%\Papilot\wps-zotero\proxy.py` |
| 日志里 `400 Bad request` | 代理没改写 `Host`（Zotero 10 新校验） | 用本方案 `proxy.py`（已内置改写） |
| 日志里 `502` / 一直超时 | **Zotero 的集成服务被未完成的事务挂住了** | 重启 Zotero（本机实测：直连 `23119` 也超时，说明不是代理问题） |
| 提示「加载项已被修改，是否继续加载？」 | 有人动过加载项目录里的文件 | 点【确定】即可；以后只升级外部代理（`--proxy-only`）就不会再问 |
| 引文插入后不能 Refresh | 存成了书签 | 重插，选"域"；或 Preferences 里检查 |
| 插入时 Zotero 窗口跑到后面 | Windows 焦点策略 | 点任务栏 Zotero；或设 `keepAddCitationDialogRaised=true` |

---

## 7. 已知限制

- 只支持**文内引文**与脚注引文（上游对尾注会退化成脚注）。
- 格式标签支持有限（`<p>/<br>/<b>/<i>` 等），极端样式可能丢细节。
- WPS 升级后可能重置 `authaddin.json`，届时会再问一次信任——属于 WPS 的安全设计，不是故障。
- 加载项目录不要手改；要改就升版本号（新目录 + 新 `version`），旧目录清掉。
- 本方案不修改 Zotero 自身，也不碰你的文献库；卸载只删 WPS 侧文件与注册项。

---

## 8. 备选方案与取舍

| 方案 | 前提 | 评价 |
|---|---|---|
| **本方案**：WPS JS 加载项 + 代理 | 任意 WPS 2019+（含个人版） | 唯一在个人版上完整可用的路线；代价是要有个本地代理常驻 |
| `silveryr/zotero-wps-addin`（COM 加载项 DLL） | 需要编译好的 32 位 DLL + WPS 的"COM 加载项"白名单 | 思路干净（不用代理），但产物是 2023 年编的二进制，对新版 WPS 兼容性未知，且需改注册表白名单 |
| 企业版 WPS + `Zotero.dotm` | 必须企业版（自带 VBA） | 官方路径，最稳；但个人版没有 VBA |
| 手动复制粘贴 | 无 | 没有域、不能刷新、换样式全废；只在"就引 3 篇"时凑合 |

---

## 9. 本机验证记录（2026-10-20）

| 检查项 | 结果 |
|---|---|
| WPS 版本/位数 | 12.1.0.28802，x86，个人版 |
| Zotero 版本 | 10.0.6，`/connector/ping` 200 |
| 加载项注册 | `publish.xml` 官方格式生效，WPS 写入 `authaddin.json`（`isload=true`，含签名） |
| 功能区 | UIA 读到 **Zotero 选项卡**（`ButtonControl: Zotero`） |
| 代理 | `21931/__health` = `{"ok":true,"zotero":true}`；`/connector/ping` 经代理返回 200 且带 CORS 头 |
| 未完成项 | 最后一步「点 Add/Edit Citation 让 Zotero 弹出引文框」需要人点一次（本机自动化环境的前台被宿主程序占用，无法向 WPS 注入鼠标/键盘；WPS 自绘弹窗也不接受 PostMessage） |

> 也就是说：**装、信任、选项卡、代理、协议全部已验证**；剩下的"点按钮 → 选文献 → 看正文"
> 属于人工一次性确认，按 §5.3 走一遍即可。

---

## 10. 文件清单

| 路径 | 说明 |
|---|---|
| `tools/wps-zotero/addon/` | 修好的加载项源码（GPL-3.0，源自 tankwyn/WPS-Zotero，含本方案的 4 处修复） |
| `tools/wps-zotero/addon/proxy.py` | 重写版 CORS 代理（Host 改写、请求/响应完整读取、单连接异常隔离） |
| `scripts/wps-zotero/install.py` | 安装 / 卸载 / 只更代理 |
| `scripts/wps-zotero/doctor.py` | 七项自检 |
| `chrome/content/prefs-wps.js` + `scripts/features/wps-bridge.js` | 插件内「WPS 集成」卡片与桥接（检测/修复/代理） |
| `chrome/content/tools/wps/proxy.py` | 随插件分发的代理副本（Apache-2.0，可被一键修复部署） |
