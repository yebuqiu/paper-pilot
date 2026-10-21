# Papilot Cite · 部署与调试

Zotero ↔ WPS 文字集成：插入引文、生成文献表，并且**引文与原文双向可跳**
（从引文跳回 PDF 那页那句话；从台账看还有谁引了它）。

- 适用：WPS 2019+（个人版即可，**不需要 VBA / 企业版**）｜Zotero 7–10｜Windows
- 依赖：Python 3（只跑一个 130 行的本地代理，标准库，无第三方包）
- 许可：本目录代码 Apache-2.0；不包含任何第三方加载项源码

> 设计取舍（为什么不用 Word 域、为什么不用 Zotero 的 integration protocol、
> 书签命名与台账 schema）见 **[docs/DESIGN.md](docs/DESIGN.md)**。

---

## 1. 部署（3 步）

```bash
# ① 安装：装加载项 + 写 WPS 注册 + 部署代理 + 注册开机自启 + 自检
python wps-cite/tools/install.py

# ② 完全退出 WPS（含托盘），重新打开任意 .docx
#    功能区出现「Papilot 引用」时会弹「加载项首次加载，是否信任？」→ 点【确定】
#    （这是 WPS 的安全确认，只能在 WPS 界面里点，无法自动化）

# ③ Zotero → 设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」
#    （不给这个权限，检索会返回 403）
```

再跑一次自检确认全绿：

```bash
python wps-cite/tools/install.py --check
```

期望输出：

```
[ OK ] 加载项目录 C:\Users\<你>\AppData\Roaming\kingsoft\wps\jsaddons\papilot-cite_0.1.0
[ OK ] publish.xml 注册指向当前版本
[ OK ] WPS 已信任（authaddin 里有记录）      ← 第 ② 步点过确定才会 OK
[ OK ] 代理 21932 在监听
[ OK ] Zotero 23119 可连
[ OK ] Zotero 本地 API 已开启（否则检索会 403）
```

卸载：`python wps-cite/tools/install.py --uninstall`（台账 `%APPDATA%\PapilotCite` 会保留，可手删）。

### 安装脚本到底做了什么

| 步骤 | 落点 |
|---|---|
| 复制加载项 | `%APPDATA%\kingsoft\wps\jsaddons\papilot-cite_<版本>\` |
| WPS 注册 | 同目录 `publish.xml`：`url="papilot-cite_<版本>"` + `customDomain=""`（**开发模式 URL 在 WPS 12 上不会加载**） |
| 清同名旧版本 | 避免 WPS 列出两份 |
| 部署代理 | `%APPDATA%\PapilotCite\proxy.py` |
| 开机自启 | `HKCU\...\Run\PapilotCiteProxy` |
| 代理启动脚本 | `%APPDATA%\PapilotCite\start-proxy.bat`（手点）、`start-proxy.vbs`（启动文件夹）、Run 项——**三条通道任一活着代理就能起来** |
| 清信任记录 | **只在首次安装**（或 `--reset-trust`）时清；覆盖安装不再打扰 |

---

## 2. 用起来

| 按钮 | 做什么 |
|---|---|
| **插入引文** | **弹出对话框**检索 Zotero（标题栏显示当前样式），勾选后写入光标处；一处引多篇会自动合成 `[1,2]` |
| **插入/更新文献表** | 在文末生成或重建参考文献表 |
| **刷新** | 改了文献库、换了样式后全文重排，并同步引用台账 |
| **回到原文** | 光标放在引文里 → Zotero 打开该条目的 PDF，定位到当初引的那一页（有标注时高亮那句话） |
| **查看引用** | 光标放在引文里 → 列出还有哪些文档引用了同一处，可直接打开 |

样式：默认 **GB/T 7714-2015 顺序编码制**，可切 APA 7（`js/app.js` 的 `STYLES`，
当前选择存在文档属性 `PPCStyle` 里，随文档走）。

---

## 3. 调试

### 3.1 三层日志

| 层 | 位置 | 用途 |
|---|---|---|
| 代理 | `%APPDATA%\PapilotCite\proxy.log` | 转发、台账写入、打开文件；**链路问题的第一现场** |
| 加载项 | WPS → 开发者工具 → Console（功能区右键「开发者工具」或按 F12） | `Papilot Cite：…` 开头的报错 |
| 台账 | `%APPDATA%\PapilotCite\links.json` | 直接看"谁引用了谁"长什么样 |

### 3.2 不打开 WPS 也能验的部分

```bash
# 代理活着吗？Zotero 在吗？本地 API 开了吗？
curl http://127.0.0.1:21932/__health
# {"ok":true,"zotero":true,"localApi":true}

# 经代理能读到 Zotero 条目吗（等价于窗格里的检索）
curl "http://127.0.0.1:21932/zotero/api/users/0/items?q=deep&limit=3&format=json"

# 台账写入与反查
curl -X POST http://127.0.0.1:21932/links/upsert -H "Content-Type: application/json" \
     --data-binary '{"doc":"C:/docs/a.docx","cites":[{"itemKey":"ABCD1234","page":7}]}'
curl "http://127.0.0.1:21932/links?itemKey=ABCD1234"
```

> Windows 的 Git Bash 里 `-d '{"a":"C:\\x"}'` 里的反斜杠会被吞，调试时用 `--data-binary` + 正斜杠路径。

### 3.3 纯逻辑内核测试（不需要 WPS / 不需要 Zotero）

```bash
node wps-cite/test/core.test.js      # 64 断言：书签编码 / 聚簇编号 / 两种样式 / 双向链接
```

覆盖的是"排版决策"——最该被自动化盯住的部分：编号顺序、连续压缩 `[1-3]`、
同簇合并、条目丢失降级 `[?]`、GB/T 7714 的作者与类型标识、APA 的 `et al.` 与 `p. 7`、
`zotero://` URI 拼装、台账摘要截断。

### 3.4 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| **点按钮弹「连接不上本地服务」** | 90% 是本地代理没在跑（WPS 12 里加载项无法自己拉起进程） | 双击 `%APPDATA%\PapilotCite\start-proxy.bat`；或 `python wps-cite/tools/install.py --repair`。然后看 `%APPDATA%\PapilotCite\proxy.log`：**有 `health probe` 行** = 加载项与代理已通，问题在别处；**没有** = 加载项 JS 没跑（检查是否点过信任、`install.py --check`） |
| 功能区没有「Papilot 引用」 | ① 信任没点 ② WPS 没真退出 ③ 注册被别的版本覆盖 | 完全退出 WPS 重开并点【确定】；`install.py --check` 看注册项；确认 `publish.xml` 里 `url` 是目录名而不是 `http://…` |
| 点「插入引文」窗格不出现 | 该 WPS 版本不支持 `wps.CreateTaskPane` | 见 DESIGN §6 限制 3；其余命令仍可用 |
| 检索/插入报 403 | ① Zotero 本地 API 没开（最常见）② 代理 Origin 白名单拦了加载项页面 | ① Zotero 设置 → 高级 → 允许其他应用通信；② 看 proxy.log 的 `reject origin:` 行，把 Origin 值反馈给开发者 |
| 检索报「代理未运行」 | 代理没起 | `pythonw %APPDATA%\PapilotCite\proxy.py`，或重跑 install.py |
| 「回到原文」没反应 | Zotero 未注册 `zotero://` 协议 / 条目没有 PDF | 先在 Zotero 里双击该条目确认能打开 PDF；无 PDF 时退化为"在 Zotero 选中条目" |
| 刷新后编号乱 | 文档里有手工编辑过的书签名 | 别手工改 `PPC…` 书签；坏了就删掉那条引文重新插入 |
| 引文变成 `[?]` | 条目被移出 Zotero 或换了库 | 刷新时会有提示；把条目放回库再刷新即恢复 |

### 3.5 三行日志判定链路（最省时间的排查）

```bash
tail "$APPDATA/PapilotCite/proxy.log"
```

| 日志里看到 | 含义 |
|---|---|
| `health probe ok-zotero=True` | 加载项 JS 已执行、能访问代理、Zotero 也在 → 链路通，问题只可能在具体命令 |
| `beacon from addon` | 连图片请求都出去了（网络栈完全正常） |
| 只有 `proxy on 21932`，没有 probe | 代理活着但**加载项没跑**：多半是信任没点，或加载项没加载 |
| 连 `proxy on` 都没有 | 代理没起来：双击 `start-proxy.bat` |

### 3.6 干净复现一招

怀疑是"旧状态"导致的问题时：

```bash
python wps-cite/tools/install.py --uninstall
rm -rf "%APPDATA%\PapilotCite"            # 连台账与配置一起清
python wps-cite/tools/install.py
```

---

## 3.7 附：让 WPS 出现「Zotero」官方选项卡（可选，dotm 路线）

有些人的 WPS 里有 Zotero 选项卡，有些没有——**它不是 WPS 自带**，而是 Zotero 的 Word 插件
`Zotero.dotm` 被放进了 WPS 的启动目录。本仓库提供一个一键工具来补这一步：

```bash
python wps-cite/tools/wps-dotm.py          # 安装（幂等；已是最新会跳过）
python wps-cite/tools/wps-dotm.py --check  # 只看状态
python wps-cite/tools/wps-dotm.py --remove # 卸载（只删与 Zotero 源字节一致的副本，并还原 .bak）
python wps-cite/tools/install.py --with-dotm   # 装 Papilot Cite 时顺带做这件事
```

它做什么：

1. 从 `C:\Program Files\Zotero\integration\word-for-windows\Zotero.dotm` 取源文件
   （**不打包、不分发** dotm——只用用户机器上已有的 Zotero 组件，许可最干净）；
2. 枚举所有 WPS 的 `office6\startup` 目录（运行中的 wps.exe 路径 + 各盘符的
   `Users\*\AppData\Local` / `Program Files` 两条路径，因为 WPS 可能装在非系统盘）；
3. 复制过去，覆盖前留 `.bak`；已存在且 sha256 相同则跳过。

**边界（别指望它更多）**：
- dotm 是 **VBA + customUI**，只有「插入/编辑引文、文献表、笔记、刷新、去代码、文档首选项」那套；
- **没有**引文 ↔ 原文双向链接（那是 Papilot Cite 自己做的）；
- 依赖 WPS 的 VBA 能力：没有 VBA 的 WPS 会显示选项卡但按钮无效；
- WPS 重装/升级可能清掉 `office6\startup`，重跑一次工具即可。

### 3.8 为什么不去改造 `Zotero.dotm`

| 因素 | 事实 |
|---|---|
| 逻辑位置 | 功能区只是 `customUI.xml`（2.3 KB 的壳），真正实现是 `vbaProject.bin`（40 KB **已编译**字节码），改不了源码 |
| 签名 | 包内带 `vbaProjectSignature{,Agile,V3}.bin` 三个签名；动一个字节签名即失效，WPS 会拒绝加载 |
| 依赖 | 它调用 Zotero 的 `libzoteroWinWordIntegration.dll`（2.6 MB，Word 集成桥），那不是我们能碰的组件 |
| 能力上限 | 即使改界面，也只有"插入/编辑引文"那套，没有引文 ↔ 原文双向链接 |

所以路线是"另做一层"：`ShowDialog` 弹出对话框（拿不到就退任务窗格，再不行退 prompt），
插入走我们自己的 `insertCitation`；dotm 那份原样保留，用户想要原生选项卡就用 §3.7 的工具装上，两者并存。

## 4. 0.1.0 实测踩坑（都已修，写下来免得重犯）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 点「插入引文」窗格能开、但检索/插入报 `HTTP 404` | `zotero.js` 的请求少了 `/api/users/0` 前缀（本地 API 完整路径是 `/api/users/0/items/...`） | 前缀补进 `api()`；`curl` 手写全路径验证过，反而掩盖了这个 bug |
| 2 | 改了 `proxy.py` 却不生效 | 安装脚本只在端口未监听时启动代理，旧进程还占着 21932 | `install.py` 先 `kill_proxy()` 再启动，`--repair` 同理 |
| 3 | 覆盖安装后 WPS 里**没有**这个选项卡，也不弹窗 | 同名目录内容变了、`authaddin` 里的签名对不上，WPS 直接跳过 | `install.py` 覆盖安装时清掉该加载项信任记录，让 WPS 重新问一次 |
| 4 | 任务窗格里点「插入选中」没反应 | 窗格是独立页面，未必注入 `wps` 对象，拿不到文档 | 窗格检测不到 `wps` 就走代理队列 `/queue`，主页面每 1.2 s 取走并真正写入 |
| 5 | 从窗格/后台调用时 `ActiveDocument` 为 null | 页面没焦点 | `doc()` 退化为 `Documents.Item(1)`；`insertAtCursor` 无选区时退化为文末插入 |
| 6 | 排查全靠猜 | WPS 界面不能自动化点，日志又在页面里看不到 | 加载项把 `addin loaded`（含 API 能力探测）/`action`/`queue`/异常栈 POST 到代理 `/log`，全部落进 `proxy.log` |
| 7 | 某台电脑**全功能** 403（检索/插入/导出诊断包全挂），Zotero 本地 API 正常 | 该机 WPS 内嵌旧 Chromium 把 file 源序列化成 `file://` 而非 `null`，撞代理 Origin 白名单；proxy.log 全是 `reject origin: 'file://'` | 白名单补 `file://`（proxy 0.1.2）；403 响应体带被拒 Origin 值；冒烟测试钉住 |
| 8 | 装了新版插件，仍然 403（报错文案是新的、但不显示 Origin 值） | **Python 进程启动时就把 proxy.py 读进内存**，覆盖文件对运行中的实例无效；桥接原来看端口通就跳过重启 | 桥接按 `__health` 的 `proxyVersion` 判版本，不符则 Stop-Process 旧进程再起（0.72.1）；代理补 `/__shutdown` 与真正的 `proxy.py stop` |

> 第 6 条是这轮最值钱的一步：`log("addin loaded", apiProbe())` 一次就证明了
> `wps.CreateTaskPane` / `ShowDialog` 都是 function，也让第 1 条的真凶（404）无处可藏。

## 4. 目录与文件

| 路径 | 说明 |
|---|---|
| `addon/` | 加载项源码（WPS jsapi），`install.py` 直接复制，无构建步骤 |
| `proxy/proxy.py` | 本地代理：CORS + Host 改写 + 台账 + 打开文件 |
| `tools/install.py` | 安装 / 卸载 / 自检 |
| `test/core.test.js` | 纯逻辑内核测试 |
| `docs/DESIGN.md` | 架构、数据模型、同步规则、扩展点、限制 |

版本：加载项版本在 `addon/version.js`（`PPC_VERSION`）。改版本号后重跑 `install.py`，
它会把新目录写进 `publish.xml` 并清掉旧目录。
