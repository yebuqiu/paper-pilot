# Papilot 模块化拆分与组件商店设计方案

> 基于 `dist/papilot-0.72.4.xpi` 实测解剖数据（2026-10-22）。
> 目标：初始安装包从 **1.92 MB（解压 5.61 MB / 210 个文件）** 降到 **≤ 500 KB**，
> 重功能改为运行时按需拉取，配套版本化更新机制与组件商店。

---

## 一、体积解剖：钱花在哪里

实测 `papilot-0.72.4.xpi`（压缩 1.92 MB / 解压 5.61 MB）：

| 排名 | 构成 | 解压体积 | 占比 | 性质判断 |
|---|---|---:|---:|---|
| 1 | `scripts/features/`（73 个功能模块） | 1850 KB | 33.0% | **可拆**——多数功能并非人人用 |
| 2 | `vendor/pdfjs/`（3 个文件） | 1384 KB | 24.7% | **必拆**——pdf.worker.min.js 单文件 1062 KB |
| 3 | `scripts/ai/`（21 个文件，AI 问答/Agent/计费） | 345 KB | 6.2% | 半拆——免费用户只用基础问答 |
| 4 | `tools/wps-cite.bundle.json` | 214 KB | 3.8% | **必拆**——只有 WPS 用户需要 |
| 5 | `scripts/panels/` + 根目录各 `*.xhtml/js` 窗口 | ~380 KB | 6.8% | 可拆——标签管理器/对比/工作台等独立窗口 |
| 6 | 设置面板族（prefs.xhtml 142KB + prefs-*.js ~350KB） | ~490 KB | 8.7% | 半拆——骨架保留，分组页可懒加载 |
| 7 | `scripts/arxiv/`（86KB）+ `scripts/data/journals.js`（48KB） | 134 KB | 2.4% | 可拆——订阅/检索用户才需要 |
| 8 | 骨架：bootstrap + main.js + menus + core + columns | ~250 KB | 4.5% | **必须留在主包** |

**结论**：体积大头不是"资源文件"，而是 **73 个功能 JS 的全量打包**。pdfjs 是单点最大项（25%）。纯靠压缩已到极限（zip 内 JS 压缩率约 66%），**必须走结构化拆分**。

---

## 二、拆分策略：三层架构

### 2.1 分层定义

```
┌─────────────────────────────────────────────────────┐
│ L0 主包（≤ 500 KB，永不卸载）                          │
│   bootstrap.js / manifest / prefs.js / locale        │
│   scripts/core/（utils + module-loader + module-store）│
│   scripts/menus.js + main.js（瘦身：只做装配）          │
│   设置面板骨架（prefs.xhtml 框架页 + 账号/会员）          │
├─────────────────────────────────────────────────────┤
│ L1 内置推荐模块（随主包装 3~5 个，可卸载）               │
│   阅读进度 / 划词翻译 / AI 基础问答                     │
├─────────────────────────────────────────────────────┤
│ L2 商店模块（远程仓库托管，按需下载）                    │
│   其余 ~65 个 features + pdfjs + wps-cite + journals  │
└─────────────────────────────────────────────────────┘
```

### 2.2 L2 模块清单（按仓库分组）

每个独立仓库 = GitHub + Gitee 双托管（沿用分册 02 双远端纪律），公开仓库。

| 仓库 | 内容 | 体积 | 拆出理由 |
|---|---|---:|---|
| `papilot-mod-pdf` | vendor/pdfjs + pdf-dual/pdf-inline/pdf-compare/ocr | ~1.6 MB | 最大单块；不读 PDF 对照的用户零成本 |
| `papilot-mod-ai` | scripts/ai/* + panels/chat-float + chat-window | ~560 KB | AI 全家桶，免费用户可只装基础问答子包 |
| `papilot-mod-cnki` | cn-fetch/cn-ai/cn-meta/cn-translators + vendor/sm2 | ~300 KB | 知网生态，海外用户不需要 |
| `papilot-mod-discovery` | discovery/search-subs/arxiv/data/journals.js | ~400 KB | 检索订阅全家桶 |
| `papilot-mod-notes` | note-*/mindmap/anki-export/obsidian-export/note-graph | ~350 KB | 笔记流用户自选 |
| `papilot-mod-meta` | meta-*/attach-*/fake-check/lib-graph/collection-stats | ~300 KB | 库健康管理 |
| `papilot-mod-cite` | tools/wps-cite.bundle.json + cite-export/citation-* | ~300 KB | 写作引用族 |
| `papilot-mod-sync` | cloud-sync + cred-vault + vault.xhtml | ~150 KB | 坚果云同步 |
| `papilot-mod-ui` | ui-theme/skill-packs/workbench/tag-manager/compare 等 | ~600 KB | 界面增强与独立窗口族 |

**改 / 不改边界**：
- ✅ 改：`bootstrap.js` 增加模块装配钩子；`main.js` 瘦身为注册表驱动；新增 `scripts/core/module-loader.js` + `module-store.js`。
- ❌ 不改：各 feature 文件**内部逻辑一行不动**——只给每个文件补一个标准包装头尾（注册/注销函数），与现有 `ItemPaneManager.registerSection` 返回注销句柄的惯例一致。
- ❌ 不改：manifest.json 的 ID、update_url、权限模型；现有 `papilot-update.json` 主包更新通道原样保留。

### 2.3 模块清单格式（`module.json`，每仓库根目录）

```json
{
  "id": "papilot-mod-pdf",
  "version": "1.2.0",
  "minHost": "0.73.0",
  "files": [
    { "path": "vendor/pdfjs/pdf.min.js", "sha256": "...", "size": 319981 },
    { "path": "features/pdf-dual.js",    "sha256": "...", "size": 35812 }
  ],
  "entry": "features/_mod-entry.js",
  "provides": ["pdf-dual", "pdf-compare", "ocr"],
  "depends": [],
  "whatsNew": "修复双栏同步滚动缩放漂移"
}
```

---

## 三、在线更新机制设计

### 3.1 加载原理（Zotero bootstrapped 约束下的可行路径）

Zotero 插件无法 `import()` 远程 URL，但可以：

1. **下载落盘**：模块 zip 下载到 `Zotero.Profile.dir/papilot/modules/<id>/<version>/`（沿用 IOUtils.writeUTF8 纪律，绝不传 mode）。
2. **本地加载**：`Services.scriptloader.loadSubScript("file:///.../features/pdf-dual.js", sandbox)` —— 与主包 chrome:// 加载路径等价，特权 API 完全可用。
3. **沙箱隔离**：每个模块一个 `Cu.Sandbox`，注入与主包相同的 `Papilot` 命名空间句柄，模块崩溃不拖垮宿主。
4. **注册协议**：模块 entry 必须调用 `Papilot.Modules.register(id, { install(ctx), uninstall() })`，卸载句柄集中管理（复用 §16 registerSection 返回值注销惯例）。

### 3.2 更新流程（目录 → 校验 → 原子切换）

```
启动时/每 12h：
  1. 拉取目录 index.json（GitHub raw 优先，Gitee 兜底——本机 git 协议被墙但 raw/api 通畅）
  2. 与本地 modules/installed.json 比对版本
  3. 有新版 → 后台静默下载 zip（对齐 Zotero 静默更新习惯，但按分册 21 教训：
     下载完成必须写本地 whatsNew 记录，设置面板可查看「模块更新日志」）
  4. 逐文件 sha256 校验（module.json 内清单）——任一不符整包丢弃
  5. 解压到 modules/<id>/<newVersion>/，成功后改 installed.json 指针，
     旧版本目录保留一份作回滚（再旧即删）
  6. 下次启动生效；运行中模块标记「重启后更新」
```

**安全纪律**：
- 下载源域名白名单写死在主包（`raw.githubusercontent.com` / `gitee.com`），**不允许模块指定第三方 URL**。
- sha256 清单随目录签发的 commit 走，主包内置各仓库的「预期仓库列表」，防目录被替换后指向恶意仓库。
- 校验失败、网络失败一律**静默降级到已装旧版**，不弹窗不阻塞启动（对齐分册 21 异常静默原则）。

### 3.3 主包与模块的版本契约

- `minHost` 字段：模块声明最低主包版本；主包升级导致 API 破坏时，商店页面对不兼容模块显示「需升级主包」。
- 主包内 `Papilot.Modules.API_VERSION` 单调递增，破坏性变更 +1；模块目录记录 `apiVersion`，不匹配拒绝加载并提示。
- 主包自身更新仍走原 `papilot-update.json` 通道（Zotero 原生机制），**两套通道互不替代**：主包管骨架，商店管血肉。

---

## 四、组件商店实现方案

### 4.1 复用现有地基，不重造轮子

仓库已有 `skill-store.js`（43KB，技能包商店：目录三级降级 + 三视图 + manifest 四槽）。
组件商店 = **同一套 UI 骨架 + 新的 manifest 类型**：

| 既有能力（技能包） | 扩展为（组件商店） |
|---|---|
| manifest 四槽声明（prompts/glossary/...） | 增加 `type: "code-module"`，携带 `files/entry/sha256` |
| 目录三级降级（远端→validate→内置） | 直接复用，内置目录只放 3 个官方推荐模块 |
| 安装 = upsert + `sp:` 前缀记账 | 安装 = 下载 zip + 校验 + 落盘 + 记账（`mod:` 前缀），卸载可精确还原 |
| 商店窗口三视图 | 复用；列表项加「体积」「版本」「已装/有更新」徽标 |

**教训预埋**：分册 29 记录 0.48.4「列表始终为空」接缝 bug（renderList 无条件传空 installedIds）——组件商店的 installedIds 必须由 `module-loader` 实际扫描 `modules/` 目录得出，**不允许 UI 层自造空 Set**，并补对应烟测。

### 4.2 商店目录仓库（`papilot-modules-index`）

单一公开仓库（GitHub + Gitee 镜像），结构：

```
index.json            # 全部模块目录（id/名称/简介/图标/体积/版本/仓库地址）
modules/<id>.json     # 每模块详细清单（含文件 sha256）
```

用户端拉取顺序：`raw.githubusercontent.com/.../index.json` → 失败转 `gitee.com/.../raw/index.json` → 再失败用内置快照（含 3 个推荐模块）。12h 缓存，手动刷新强制拉新。

### 4.3 用户体验流

1. **首装瘦身**：新用户装 1.92MB → ~500KB 主包。首次启动向导（复用 wizard.xhtml）加一页「选择你需要的功能」，勾选即后台下载，不打断使用。
2. **按需触发安装**：用户点了未安装的菜单项（如「PDF 对照翻译」）→ 弹出轻量提示「此功能需下载组件（1.6 MB），现在安装？」→ 确认后下载、加载、**当次直接可用**（不需重启的模块尽量热载）。
3. **卸载自由**：商店页可卸载任何 L2 模块，菜单项即时隐藏，磁盘文件清除，主包不受影响。

### 4.4 服务端/账号联动（可选 P2）

- 管理后台「会员管理」可加「Pro 专属模块」标记（如第三方文献源的高级适配），下载时校验会话 plan——复用现有 `planOf` 与 Pro 软门控模式（分册 25）。
- 模块下载量统计走 `pp.xinglintools.top` 的一个计数端点（零依赖 server 加 20 行），帮助决策哪些模块应回并主包。

---

## 五、实施路线图

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0-1** | `module-loader.js`：落盘/校验/沙箱加载/注册注销/回滚 | 单测：假模块 zip 全生命周期（装/升/坏包回滚/卸载） |
| **P0-2** | 拆 `papilot-mod-pdf`（pdfjs 单块，收益最大 1.4MB）跑通端到端 | 主包 -1.4MB；PDF 对照功能真机可用 |
| **P0-3** | 商店 UI 改造（skill-store 骨架 + code-module 类型）+ 目录仓库上线 | 装机空目录 → 商店装 PDF 模块 → 重启存活 |
| **P1** | 按 §2.2 拆其余 8 个仓库；主包 menus/main 瘦身；首装向导页 | 主包 ≤ 500KB；preflight 全绿 |
| **P2** | 热加载（不重启生效）、Pro 模块门控、下载量统计、whatsNew 提示 | — |

**测试纪律**（对齐分册 09/10）：
- 新增门禁 §-条目：check-wiring 扫描「主包不得 import 任何 L2 模块路径」「module.json sha256 与文件实算一致」。
- 模块加载测试用迷你 DOM 真渲染法，端口 `listen(0)`、请求 `agent:false`。
- 装机验证必须先 `-purgecaches`，并核对包内 manifest 版本。

**风险提示**：
- Zotero 主包更新仍是「整体替换」——主包瘦身收益对老用户只在重装后体现，需配合 migration 提示包思路（§3.2.1）通知。
- 模块双远端同步沿用 `sync-github.py` 三坑纪律；目录仓库的 index.json 必须以 Gitee 为准绳之一做交叉校验（防单源被改）。
- 用户处于离线/内网时，商店必须全功能降级为「仅已装模块管理」，不出红字报错。

---

## 附：体积目标测算

| 包 | 现在 | 拆分后 |
|---|---:|---:|
| 主包 xpi（压缩） | 1920 KB | **≈ 420–500 KB**（骨架 + 3 个推荐模块） |
| pdfjs 模块 | — | ~500 KB（压缩后，按需） |
| 其余 8 模块合计 | — | ~700 KB（按需） |
| 全量安装总和 | 1920 KB | ~1700 KB（功能等价，但首装 -74%） |

---

## 六、实现状态（2026-10-22）

设计已按 P0–P2 落地，下面是**实际实现与本文原方案的差异**，以及尚未收口的部分。

### 6.1 与原方案的偏差（均为实测后调整）

| 项 | 原方案 | 实际实现 | 原因 |
|---|---|---|---|
| 加载方式 | 一律 `Cu.Sandbox` | **双模式**：`scope`（默认）/ `sandbox` | 现存 73 个 feature 直接挂全局、彼此引用；一次改成沙箱等于重写全部模块。scope 模式先兼容上线，新模块用 sandbox |
| 模块清单 `minHost` | 固定 `0.73.0` | **跟随 `manifest.json`**（`"auto"`） | 写死会与宿主版本漂移，实测「minHost 0.73.0 vs 宿主 0.72.4」会让全部安装被拒 |
| 发布布局 | 9 个独立仓库 | **默认单仓 `papilot-modules`**，`--layout multi` 保留原方案 | 9 个仓库 = 9 份源码副本 + 9 套 CI/Release，维护成本远大于收益；源码真源仍在主仓 |
| 首装体积目标 | ≤ 500 KB | **实测 654 KB（-66%）** | wps 载荷 214 KB 与设置面板骨架仍必须留在主包 |
| 卸载语义 | 完全可卸载 | scope 模式「尽力卸载」 | JS 已进共享作用域无法回收；只能隐藏 UI + 停用，sandbox 模式才真正 `nukeSandbox` |

### 6.2 已交付清单

- `chrome/content/scripts/core/module-loader.js` —— 清单校验 / sha256 逐文件核对 / 原子切换 / 双模式加载 / 回滚 / 版本目录清理（只留当前 + 上一版）
- `chrome/content/scripts/core/module-store.js` —— 目录三级降级（GitHub → Gitee → 包内快照）/ 12h 缓存 / 安装编排 / 更新检查 / whatsNew 记账 / 本地统计 / Pro 门控
- `chrome/content/module-store.xhtml|window.js|css` —— 组件商店窗口（列表/详情/更新三视图、离线空态、Esc、防重复点击）
- `scripts/module-map.json` + `scripts/build-module.py` —— 9 模块切分、清单/索引/zip 生成、`--check` 一致性校验
- `scripts/publish-modules.py` —— 发布预备树（默认 dry-run，**不自动建公开仓库**）
- `scripts/build-xpi.py` —— `--modular`（默认关闭）+ `--out`（试打包不覆盖已发布包）
- 入口：条目右键 + 工具菜单 + 功能中心卡片，共 3 处
- 测试：`test/module-loader.test.js`（181 断言）+ `test/module-store.test.js`（79 断言）；门禁 §65 五条接线

### 6.3 收口结果（2026-10-22 16:00）

1. **init 门控改为「缺组件占位」**：不再逐点加 `typeof` 守卫。构建期从模块源文件
   提取全局名（101 个）生成 `chrome/content/scripts/modules-globals.js`；
   `ModuleLoader.installFacades()` 只为「未安装模块」的全局装惰性桩
   （可读/可调/可 new/可 await，且 `length=0`、空迭代），启动期静默，8 秒后调用才提示安装。
   完整包所有全局已存在 → 一个桩都不装。
2. **真机验证已过**（独立 profile，读 `papilot-boot.log`）：
   - 完整包 `papilot-0.73.0.xpi`：`init complete`、0 条 FAILED；
   - 瘦身包 `-slim`：`init complete` → 本地目录 → 下载 → sha256 → 装盘 → `module loaded papilot-mod-pdf@0.73.0`，注册表落盘。
3. **目录托管改为「主仓 + Release 附件」**（不新建 10 个公开仓库）：
   `papilot-modules-index.json` 随主仓提交；9 个 zip 挂同一个 v0.73.0 Release；
   客户端 GitHub raw → Gitee raw → 包内快照三级降级。
4. 真机实修 5 个只有真机才暴露的问题：`nsICryptoHash.update` 不吃字符串、
   `PathUtils.join` 不吃含 `/` 的段、`Zotero.HTTP.request` 回调式不触发（改 Promise）、
   缺组件占位导致续费弹窗卡死启动（`Account.__ppFacade` 守卫 + 自检延后 8s）、
   LICENSE 被当 JS 加载（只加载 `.js`）。

### 6.4 体积实测

| 包 | 体积 | 对比 |
|---|---:|---|
| 完整包 `papilot-0.73.0.xpi` | 1913 KB | 与 0.72.4 持平（新增运行时约 20 KB） |
| 瘦身包 `papilot-0.73.0-slim.xpi` | **约 640 KB** | **-66%** |
| 9 个模块包合计 | 1282 KB | 按需下载 |
| 全量装齐 | ≈ 1922 KB | 与完整包持平（无重复） |
