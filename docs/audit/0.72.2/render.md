# 设置面板 0.72.2 · 真实渲染门禁（无头 Chrome 实测）

- 生成时间：2026-10-21T18:09:01.392Z
- 被测页：`docs/预览-设置面板-0.72.2.html`
- 浏览器：Chrome（playwright-core 驱动，`C:/Program Files/Google/Chrome/Application/chrome.exe`）
- 说明：页面是静态快照，不含 `prefs-*.js` 行为逻辑，本报告只验证视觉与几何，不验证交互逻辑。

## 0. 快照指纹与时效（重要）

| 项 | 值 |
| --- | --- |
| 被测页 | `docs/预览-设置面板-0.72.2.html`，mtime **01:53:01**，sha256 前 16 位 `f2d8176ffbeac7fb` |
| 页内内嵌 prefs.css 副本 | 49170 字符 / 1425 行，sha256 前 16 位 `441c520b2253df7c` |
| 当前 `chrome/content/prefs.css` | 52339 字符 / 1492 行，mtime **02:18:20**，sha256 `865a51d496888eaf` |
| 差异 | 新增 77 行（`--pp-border-control/-hover`、`--pp-danger-fg` 硬值、`color-scheme: light\|dark`、`:root[data-theme="dark"] .pp-root` 整块） |

**结论：本报告的截图与数值对应「改前快照」**（01:53 的内嵌 CSS）。02:16–02:18 fix-css 已改 `prefs.css` / `ui-tokens.css`，但预览页没有重新生成，所以第 1–9 节的数值仍是改前态。第 10 节第 6 条（暗色白块 checkbox）在改后 CSS 里已修，见下方「注入验证」。

注入验证（运行时 `addStyleTag` 追加当前 prefs.css，不改任何文件，`zoom/inject-dark-cb-off.png`）：

- `.pp-root` 的 `color-scheme`：亮 `light` / 暗 `dark`（改前恒 `normal`）→ 暗色未勾选 checkbox 由**纯白方块**变成深底 + 中灰描边
- `.pp-input` 描边：`rgb(130,139,149)`（#828b95）/ 暗 `rgb(110,122,134)`（#6e7a86）；改前为 #d8dee4
- 焦点环不变：亮 `rgb(9,105,218) 0 0 0 2px, rgba(9,105,218,.2) 0 0 0 4px`，暗 `rgb(68,147,248) … .28`
- 无布局回归：`#pp-tr-glossary` 121.13px、卡图标 28×28、`documentElement` / `.pp-root` 横向溢出仍为 0

> 待 fix 冻结后重新生成预览页并重跑本脚本，本节数字会被刷新；在此之前请把第 1–9 节理解为「0.72.2 快照态」，第 10 节第 6 条理解为「已在源码修复、待新快照复核」。

## 1. 结论速览

| 组合 | 视口 | `documentElement` scrollWidth / clientWidth | `.pp-root` scrollWidth / clientWidth | 横向溢出 | 折叠态内容高 | 展开态内容高 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280-light | 1280x900 | 1280 / 1280 | 1024 / 1024 | 0px | 2787px | 13402px | PASS |
| 1280-dark | 1280x900 | 1280 / 1280 | 1024 / 1024 | 0px | 2787px | 13402px | PASS |
| 560-light | 560x900 | 560 / 560 | 560 / 560 | 0px | 2887px | 16606px | PASS |
| 560-dark | 560x900 | 560 / 560 | 560 / 560 | 0px | 2887px | 16606px | PASS |

> 该页 `body{overflow:hidden}`，`.pp-root` 自身是 `height:calc(100vh-46px); overflow-y:auto` 的滚动容器（模拟 Zotero 设置窗格）。因此 `documentElement.scrollWidth` 恒等于视口宽，横向溢出必须同时看 `.pp-root` 的 `scrollWidth`。

- 溢出组合数：0 / 4
- SVG：总数 23，可见 22，尺寸越界（可见且 <8 或 >32）：0 个
- 卡片图标：19 张全部可见、全部含 svg；图标盒实测 28×28（CSS 声明 26×26 + 1px 边框，box-sizing 非 border-box → 实渲 28×28），内嵌 svg 16×16（均在 8–32 内）
- 焦点环：4 组合 × 4 目标（主按钮 / 输入框 / 文本域 / `.pp-link-btn`）全部 PASS（聚焦后等 400ms 取值，详见第 6 节）
- #pp-tr-glossary 高度：121.13px（阈值：须远大于 28px）

## 2. 截图

> `*-full*.png` 是长图：因页面内部滚动容器裁剪，截图时在运行时临时把 `.pp-root` 高度改为 auto（仅内存态，不改文件），截完即移除。

| 组合 | 首屏（折叠 = 用户首见） | 全页长图（折叠） | 全展开首屏 | 全展开长图 |
| --- | --- | --- | --- | --- |
| 1280-light | [1280-light.png](./1280-light.png) | [1280-light-full.png](./1280-light-full.png) | [1280-light-expanded-top.png](./1280-light-expanded-top.png) | [1280-light-full-expanded.png](./1280-light-full-expanded.png) |
| 1280-dark | [1280-dark.png](./1280-dark.png) | [1280-dark-full.png](./1280-dark-full.png) | [1280-dark-expanded-top.png](./1280-dark-expanded-top.png) | [1280-dark-full-expanded.png](./1280-dark-full-expanded.png) |
| 560-light | [560-light.png](./560-light.png) | [560-light-full.png](./560-light-full.png) | [560-light-expanded-top.png](./560-light-expanded-top.png) | [560-light-full-expanded.png](./560-light-full-expanded.png) |
| 560-dark | [560-dark.png](./560-dark.png) | [560-dark-full.png](./560-dark-full.png) | [560-dark-expanded-top.png](./560-dark-expanded-top.png) | [560-dark-full-expanded.png](./560-dark-full-expanded.png) |

## 3. 横向溢出

### 1280-light（展开态）

- `documentElement.scrollWidth` = 1280，`clientWidth` = 1280 → 溢出 0px（PASS）
- `.pp-root` scrollWidth = 1024，clientWidth = 1024 → 溢出 0px（PASS）
- `.pp-root` 内容高度：折叠 2787px → 展开 13402px（客户端可视高 878px，需内部滚动）
- 无元素 `getBoundingClientRect().right > 可用宽度`。
- 折叠态对照：`.pp-root` scrollWidth = 1024，溢出 0px

### 1280-dark（展开态）

- `documentElement.scrollWidth` = 1280，`clientWidth` = 1280 → 溢出 0px（PASS）
- `.pp-root` scrollWidth = 1024，clientWidth = 1024 → 溢出 0px（PASS）
- `.pp-root` 内容高度：折叠 2787px → 展开 13402px（客户端可视高 878px，需内部滚动）
- 无元素 `getBoundingClientRect().right > 可用宽度`。
- 折叠态对照：`.pp-root` scrollWidth = 1024，溢出 0px

### 560-light（展开态）

- `documentElement.scrollWidth` = 560，`clientWidth` = 560 → 溢出 0px（PASS）
- `.pp-root` scrollWidth = 560，clientWidth = 560 → 溢出 0px（PASS）
- `.pp-root` 内容高度：折叠 2887px → 展开 16606px（客户端可视高 878px，需内部滚动）
- 无元素 `getBoundingClientRect().right > 可用宽度`。
- 折叠态对照：`.pp-root` scrollWidth = 560，溢出 0px

### 560-dark（展开态）

- `documentElement.scrollWidth` = 560，`clientWidth` = 560 → 溢出 0px（PASS）
- `.pp-root` scrollWidth = 560，clientWidth = 560 → 溢出 0px（PASS）
- `.pp-root` 内容高度：折叠 2887px → 展开 16606px（客户端可视高 878px，需内部滚动）
- 无元素 `getBoundingClientRect().right > 可用宽度`。
- 折叠态对照：`.pp-root` scrollWidth = 560，溢出 0px

## 4. SVG 图标实测

### 1280-light

- 总数 23，可见 22，隐藏 1
- 可见尺寸分布：13x13 × 1，16x16 × 19，14x14 × 2
- 无「可见但 <8px 或 >32px」的图标。

### 1280-dark

- 总数 23，可见 22，隐藏 1
- 可见尺寸分布：13x13 × 1，16x16 × 19，14x14 × 2
- 无「可见但 <8px 或 >32px」的图标。

### 560-light

- 总数 23，可见 22，隐藏 1
- 可见尺寸分布：13x13 × 1，16x16 × 19，14x14 × 2
- 无「可见但 <8px 或 >32px」的图标。

### 560-dark

- 总数 23，可见 22，隐藏 1
- 可见尺寸分布：13x13 × 1，16x16 × 19，14x14 × 2
- 无「可见但 <8px 或 >32px」的图标。

### stroke = currentColor 抽样

| 组合 | 图标父 class | svg stroke | svg fill |
| --- | --- | --- | --- |
| 1280-light | pp-card-icon | rgb(9, 105, 218) | none |
| 1280-light | pp-search-icon | rgb(106, 115, 128) | none |
| 1280-dark | pp-card-icon | rgb(68, 147, 248) | none |
| 1280-dark | pp-search-icon | rgb(139, 148, 158) | none |
| 560-light | pp-card-icon | rgb(9, 105, 218) | none |
| 560-light | pp-search-icon | rgb(106, 115, 128) | none |
| 560-dark | pp-card-icon | rgb(68, 147, 248) | none |
| 560-dark | pp-search-icon | rgb(139, 148, 158) | none |

## 5. 卡片图标（19 张）

| # | 卡片标题 | 图标 w×h | svg w×h | 可见 | stroke |
| --- | --- | --- | --- | --- | --- |
| 1 | 账号与会员 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 2 | AI 模型通道 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 3 | AI 参数与智能体 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 4 | 技能包商店 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 5 | 翻译引擎与术语表 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 6 | 阅读器划词浮窗 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 7 | PDF 阅读主题 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 8 | 知网账号与校园网 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 9 | 第三方文献源（试验） | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 10 | 检索订阅 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 11 | 定时任务 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 12 | 列表数据列 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 13 | 规则打标与 AI 打标 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 14 | 工具与增强 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 15 | WPS 集成（Papilot Cite） | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 16 | 界面主题与壁纸 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 17 | 菜单定制 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 18 | 快捷键 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |
| 19 | 云同步与备份 | 28×28 | 16×16 | yes | rgb(9, 105, 218) |

跨 4 组合一致性：四组合几何完全一致（图标盒 28×28、内嵌 svg 16×16），仅颜色不同

- 阈值核对（0 尺寸 / >24px 高）：0 尺寸 0 个；图标**盒** 28px 高度 > 24px 阈值，19/19 命中——但这是 26px 声明 + 1px 边框（content-box）撑出的盒尺寸，**内嵌字形仍是 16×16**。若门禁口径是「图标视觉尺寸」，则全部通过；若口径是「图标盒高度」，则 19 张全部超阈值 4px，需在 CSS 上归 box-sizing: border-box 或把声明改成 24px。

## 6. 焦点环实测（等过渡结束后取值）

> **测量方法（0.72.2 修订）**：焦点样式带 `transition: box-shadow var(--pp-dur-fast) ease`（`.12s`），聚焦后**立即**读 `getComputedStyle` 拿到的是过渡起点 `rgba(0, 0, 0, 0) 0px 0px 0px 0px`，会被误判成「无焦点环」。本节改为：按钮用真实键盘 `Tab`（触发 `:focus-visible`）、`.pp-input` 与 `.pp-textarea` 用程序化 `focus()`（其规则是 `:focus`），**聚焦后等待 400ms** 再读样式。

判定：`box-shadow` 至少有 1 层「color alpha > 0 且最大半径 > 0」，**或** `outline-style` 为 solid/dashed/dotted/double 且宽度 ≥ 2px → PASS。

| 组合 | 目标 | 实际聚焦元素 | :focus-visible | box-shadow（过渡后） | outline | outline-offset | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280-light | linkBtn | button#pp-account-email.pp-link-btn.pp-account-email | true | none | rgb(9, 105, 218) solid 2px | 2px | **PASS** |
| 1280-light | primaryBtn | button#pp-bal-recharge-toggle.pp-btn.pp-btn-primary | true | rgb(9, 105, 218) 0px 0px 0px 2px, rgba(9, 105, 218, 0.2) 0px 0px 0px 4px | rgb(255, 255, 255) none 3px | 0px | **PASS** |
| 1280-light | input | input#pp-prefs-search.pp-input.pp-search-input | true | rgb(9, 105, 218) 0px 0px 0px 2px, rgba(9, 105, 218, 0.2) 0px 0px 0px 4px | rgb(31, 35, 40) none 3px | 0px | **PASS** |
| 1280-light | textarea | textarea#pp-tr-glossary.pp-textarea | true | rgb(9, 105, 218) 0px 0px 0px 2px, rgba(9, 105, 218, 0.2) 0px 0px 0px 4px | rgb(31, 35, 40) none 3px | 0px | **PASS** |
| 1280-dark | linkBtn | button#pp-account-email.pp-link-btn.pp-account-email | true | none | rgb(68, 147, 248) solid 2px | 2px | **PASS** |
| 1280-dark | primaryBtn | button#pp-bal-recharge-toggle.pp-btn.pp-btn-primary | true | rgb(68, 147, 248) 0px 0px 0px 2px, rgba(68, 147, 248, 0.28) 0px 0px 0px 4px | rgb(255, 255, 255) none 3px | 0px | **PASS** |
| 1280-dark | input | input#pp-prefs-search.pp-input.pp-search-input | true | rgb(68, 147, 248) 0px 0px 0px 2px, rgba(68, 147, 248, 0.28) 0px 0px 0px 4px | rgb(230, 237, 243) none 3px | 0px | **PASS** |
| 1280-dark | textarea | textarea#pp-tr-glossary.pp-textarea | true | rgb(68, 147, 248) 0px 0px 0px 2px, rgba(68, 147, 248, 0.28) 0px 0px 0px 4px | rgb(230, 237, 243) none 3px | 0px | **PASS** |
| 560-light | linkBtn | button#pp-account-email.pp-link-btn.pp-account-email | true | none | rgb(9, 105, 218) solid 2px | 2px | **PASS** |
| 560-light | primaryBtn | button#pp-bal-recharge-toggle.pp-btn.pp-btn-primary | true | rgb(9, 105, 218) 0px 0px 0px 2px, rgba(9, 105, 218, 0.2) 0px 0px 0px 4px | rgb(255, 255, 255) none 3px | 0px | **PASS** |
| 560-light | input | input#pp-prefs-search.pp-input.pp-search-input | true | rgb(9, 105, 218) 0px 0px 0px 2px, rgba(9, 105, 218, 0.2) 0px 0px 0px 4px | rgb(31, 35, 40) none 3px | 0px | **PASS** |
| 560-light | textarea | textarea#pp-tr-glossary.pp-textarea | true | rgb(9, 105, 218) 0px 0px 0px 2px, rgba(9, 105, 218, 0.2) 0px 0px 0px 4px | rgb(31, 35, 40) none 3px | 0px | **PASS** |
| 560-dark | linkBtn | button#pp-account-email.pp-link-btn.pp-account-email | true | none | rgb(68, 147, 248) solid 2px | 2px | **PASS** |
| 560-dark | primaryBtn | button#pp-bal-recharge-toggle.pp-btn.pp-btn-primary | true | rgb(68, 147, 248) 0px 0px 0px 2px, rgba(68, 147, 248, 0.28) 0px 0px 0px 4px | rgb(255, 255, 255) none 3px | 0px | **PASS** |
| 560-dark | input | input#pp-prefs-search.pp-input.pp-search-input | true | rgb(68, 147, 248) 0px 0px 0px 2px, rgba(68, 147, 248, 0.28) 0px 0px 0px 4px | rgb(230, 237, 243) none 3px | 0px | **PASS** |
| 560-dark | textarea | textarea#pp-tr-glossary.pp-textarea | true | rgb(68, 147, 248) 0px 0px 0px 2px, rgba(68, 147, 248, 0.28) 0px 0px 0px 4px | rgb(230, 237, 243) none 3px | 0px | **PASS** |

| 组合 | 目标 | 可见 shadow 层（alpha / 最大半径） | outline 判定 | transition |
| --- | --- | --- | --- | --- |
| 1280-light | linkBtn | 无 | yes（≥2px 实线） | all / 0s |
| 1280-light | primaryBtn | alpha 1 / 2px；alpha 0.2 / 4px | no | background, border-color, color, box-shadow / 0.12s, 0.12s, 0.12s, 0.12s |
| 1280-light | input | alpha 1 / 2px；alpha 0.2 / 4px | no | border-color, box-shadow, background / 0.12s, 0.12s, 0.12s |
| 1280-light | textarea | alpha 1 / 2px；alpha 0.2 / 4px | no | border-color, box-shadow / 0.12s, 0.12s |
| 1280-dark | linkBtn | 无 | yes（≥2px 实线） | all / 0s |
| 1280-dark | primaryBtn | alpha 1 / 2px；alpha 0.28 / 4px | no | background, border-color, color, box-shadow / 0.12s, 0.12s, 0.12s, 0.12s |
| 1280-dark | input | alpha 1 / 2px；alpha 0.28 / 4px | no | border-color, box-shadow, background / 0.12s, 0.12s, 0.12s |
| 1280-dark | textarea | alpha 1 / 2px；alpha 0.28 / 4px | no | border-color, box-shadow / 0.12s, 0.12s |
| 560-light | linkBtn | 无 | yes（≥2px 实线） | all / 0s |
| 560-light | primaryBtn | alpha 1 / 2px；alpha 0.2 / 4px | no | background, border-color, color, box-shadow / 0.12s, 0.12s, 0.12s, 0.12s |
| 560-light | input | alpha 1 / 2px；alpha 0.2 / 4px | no | border-color, box-shadow, background / 0.12s, 0.12s, 0.12s |
| 560-light | textarea | alpha 1 / 2px；alpha 0.2 / 4px | no | border-color, box-shadow / 0.12s, 0.12s |
| 560-dark | linkBtn | 无 | yes（≥2px 实线） | all / 0s |
| 560-dark | primaryBtn | alpha 1 / 2px；alpha 0.28 / 4px | no | background, border-color, color, box-shadow / 0.12s, 0.12s, 0.12s, 0.12s |
| 560-dark | input | alpha 1 / 2px；alpha 0.28 / 4px | no | border-color, box-shadow, background / 0.12s, 0.12s, 0.12s |
| 560-dark | textarea | alpha 1 / 2px；alpha 0.28 / 4px | no | border-color, box-shadow / 0.12s, 0.12s |

- 1280-light：Tab 次数 14，等待 400ms 后取值，未取到 无
- 1280-dark：Tab 次数 14，等待 400ms 后取值，未取到 无
- 560-light：Tab 次数 14，等待 400ms 后取值，未取到 无
- 560-dark：Tab 次数 14，等待 400ms 后取值，未取到 无

## 7. 新增契约类实渲

### 7.1 `.pp-link-btn`

| 组合 | 计数 | 可见 | 标签 | 全为 <button> |
| --- | --- | --- | --- | --- |
| 1280-light | 8 | 3 | button | true |
| 1280-dark | 8 | 3 | button | true |
| 560-light | 8 | 3 | button | true |
| 560-dark | 8 | 3 | button | true |

可见实例的盒模型（`background` 全透明、`border-width` 全 0 → 无按钮盒感）：

| 元素 | 文本 | background | border-width | border-style | padding | color | h |
| --- | --- | --- | --- | --- | --- | --- | --- |
| button#pp-account-email.pp-link-btn.pp-account-email | chen@example.edu | rgba(0, 0, 0, 0) | 0px 0px 1px 0px | none | 0px 0px 0px 0px | rgb(91, 101, 112) | 19 |
| button#pp-mb-code-toggle.pp-link-btn | 有激活码？ | rgba(0, 0, 0, 0) | 0px 0px 0px 0px | none | 0px 0px 0px 0px | rgb(9, 105, 218) | 18.75 |
| button#pp-mb-compare-toggle.pp-link-btn | 免费版 vs 专业版差异 ▾ | rgba(0, 0, 0, 0) | 0px 0px 0px 0px | none | 0px 0px 0px 0px | rgb(9, 105, 218) | 18.75 |

- 不可见实例（位于预览脚本隐藏的登录/订单视图内，属正常）：button#pp-register-link.pp-link-btn、button#pp-forgot-link.pp-link-btn、button#pp-reg-back.pp-link-btn、button#pp-bal-order-view.pp-link-btn.pp-order-view、button#pp-mb-order-view.pp-link-btn.pp-order-view
- 唯一破例：`#pp-account-email` 带 `1px` 下边框且文字为 `--pp-muted`（rgb(91,101,112)）——来自它的附加类 `.pp-account-email`（把一个邮箱地址做成「可点但有下划线」的弱化链接），不是 `.pp-link-btn` 契约本身；其余两个实例严格 0 边框、0 内边距、透明底。

### 7.2 `.pp-disclose`（`<details>`）

| # | 所在卡片 | summary 文本 | summary 高 | 闭合高 | 打开高 | Δ | cursor | ::before 尺寸 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 检索订阅 | 更多条件 | 18.75 | 29.75 | 192.5 | 162.75 | pointer | 12px / 12px |
| 2 | 云同步与备份 | 高级参数（分卷与限额） | 18.75 | 29.75 | 335.25 | 305.5 | pointer | 12px / 12px |

### 7.3 `.pp-notes`（`<ul>`）

| # | 所在卡片 | li 数 | padding-left | list-style | font-size | color | ul 高 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 翻译引擎与术语表 | 2 | 16px | disc/outside | 12px | rgb(91, 101, 112) | 40.38 |
| 2 | 翻译引擎与术语表 | 4 | 16px | disc/outside | 12px | rgb(91, 101, 112) | 82.75 |
| 3 | 检索订阅 | 2 | 16px | disc/outside | 12px | rgb(91, 101, 112) | 59.56 |
| 4 | 检索订阅 | 4 | 16px | disc/outside | 12px | rgb(91, 101, 112) | 82.75 |
| 5 | 列表数据列 | 2 | 16px | disc/outside | 12px | rgb(91, 101, 112) | 59.56 |
| 6 | 工具与增强 | 3 | 16px | disc/outside | 12px | rgb(91, 101, 112) | 80.75 |

### 7.4 `.pp-textarea`

| 元素 | rows | wrap | w×h | scrollHeight | line-height | padding | 可见 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| textarea#pp-mf-extraBody.pp-textarea | 2 | — | 0×0 | 0 | 20.625px | 8px/8px | no |
| textarea#pp-sysprompt.pp-textarea | 4 | — | 966×100.5 | 99 | 20.625px | 8px/8px | yes |
| textarea#pp-profile.pp-textarea | 3 | — | 966×79.88 | 78 | 20.625px | 8px/8px | yes |
| textarea#pp-tr-glossary.pp-textarea | 5 | off | 966×121.13 | 119 | 20.625px | 8px/8px | yes |
| textarea.pp-textarea | 6 | — | 966×141.75 | 140 | 20.625px | 8px/8px | yes |
| textarea.pp-textarea | 3 | — | 966×79.88 | 78 | 20.625px | 8px/8px | yes |
| textarea#pp-tpl-custom.pp-textarea | 3 | — | 966×79.88 | 78 | 20.625px | 8px/8px | yes |

## 8. 字号 / 控件高度

| 指标 | 实测 |
| --- | --- |
| .pp-btn 高（非 sm） | 28 |
| .pp-btn-sm 高 | 24 |
| .pp-input 高 | 28 |
| .pp-select 高 | 28 |
| .pp-color 高 | 26 |
| .pp-disclose summary 高 | 18.75 |
| .pp-card-icon 盒 w×h | 28 × 28（content-box / border 1px） |
| .pp-card-icon 内 svg 高 | 16 |
| .pp-fold-head 高 | 37 |
| 正文 font-size（.pp-root） | 12.5px |
| body font-size | 13px |
| .pp-label font-size | 12.5px |
| .pp-hint font-size（首个可见） | 10.5px |
| .pp-card-title font-size | 13.5px |
| .pp-link-btn font-size | 12px |
| .pp-notes font-size | 12px |
| .pp-textarea font-size | 12.5px |
| 可见 .pp-btn 高度分布 | 24 / 28 |
| 可见 .pp-input + .pp-select 高度分布 | 24 / 28 |
| 隐藏（不参与布局）的 .pp-btn 数量 | 27 |

> 「控件只有 28/24 两档」核对：可见 `.pp-btn` 高度分布只有 28 与 24（24 = `.pp-btn-sm`）；可见 `.pp-input` / `.pp-select` 分布为 24 / 28，其中 28px 是常态，唯一的 24px 是 `#pp-sk-source`（见下表），仍落在 24/28 两档内，但没有按 `.pp-input` 的 28px 渲染。`.pp-color` 26、`.pp-card-icon` 28 属独立控件，不在这两档之列。

高度不等于 28px 的可见输入控件：

| 元素 | 实测高 | 计算 height | flex（grow/shrink/basis） | 父级 | 父级 flex-direction |
| --- | --- | --- | --- | --- | --- |
| input#pp-sk-source.pp-input.pp-grow | 24 | 24px | 1/1/0% | label.pp-field | column |

> 根因（对照实验验证）：`#pp-sk-source` 带 `.pp-grow{flex:1}`，而父级 `label.pp-field` 是 **column** 方向的 flex 容器，`flex-basis:0%` 覆盖了 `.pp-input{height:28px}`；运行时把该元素 `flex-basis` 改回 `auto` 后实测高度立即变 28px（`flex-grow:0` 无效，证明是 basis 而非 grow 造成的）。属控件高度契约的唯一破例点。

## 9. 主题令牌落值（实测 vs 源码声明）

| 令牌 | 亮色实测 | 暗色实测 | 源码亮色声明 | 源码暗色声明 | 对账 |
| --- | --- | --- | --- | --- | --- |
| --pp-accent | #0969da | #4493f8 | #0969da | #4493f8 | OK |
| --pp-accent-fg | #0969da | #79b8ff | var(--pp-accent) | #79b8ff | 别名已解析一致 |
| --pp-success | #116329 | #3fb950 | #116329 | #3fb950 | OK |
| --pp-warn | #7a4d00 | #d29922 | #7a4d00 | #d29922 | OK |
| --pp-danger-fg | #cf222e | #ff7b72 | var(--pp-danger) | #ff7b72 | 别名已解析一致 |
| --pp-btn-primary-bg | #0969da | #1f6feb | var(--pp-accent) | #1f6feb | 别名已解析一致 |
| --pp-on-accent | #ffffff | #ffffff | #ffffff | #ffffff | 暗色块未覆盖（继承亮色） |
| --pp-focus-ring | rgba(9, 105, 218, .20) | rgba(68, 147, 248, .28) | rgba(9, 105, 218, .20) | rgba(68, 147, 248, .28) | OK |

- 令牌取值节点：`.pp-root`（变量都声明在这里；`.pp-root` 自身未设 background，故背景取 body 对照）
- 主题生效校验：亮色 `.pp-root` color = rgb(31, 35, 40)、body bg = rgb(239, 241, 244)；暗色 color = rgb(230, 237, 243)、body bg = rgb(21, 24, 28) → 两者不同，`prefers-color-scheme` 生效
- 注意：`--pp-on-accent` 只在亮色块声明，暗色块未覆盖，暗色实测仍为 #ffffff。

## 10. 肉眼观察（截图实看）

**看图方式**：用 Read 工具实际打开 4 组合首屏 PNG 逐张看，再补拍并逐张看：工具栏 / 大类直达 / 卡片头 / 账号卡（PRO 徽章 + 用量柱）/ notes 列表 / disclose / 术语表 textarea 的 2×–4× 局部放大，以及按卡片滚动的整屏图（翻译引擎、定时任务、列表数据列、界面主题、快捷键、云同步，1280 亮暗 + 560 亮）。

**结论**：4 组合均无错位、无文字截断、无横向滚动条；暗色下正文 / 次要文字 / 卡片图标 / 用量柱状图都清晰可辨，不存在「暗色下图标几乎看不见」。`<ul class="pp-notes">` 的圆点在实渲中确实可见（16px 缩进 + disc），术语表 textarea 明显是多行高框（121px），焦点环在亮/暗下均为 2px 实色 + 4px 柔光两环。

**观察到 5 处非阻断观感问题（均不改变第 1–9 节结论）**，另附 gate-render 的 5 条补充复看（第 6–10 条，含一条暗色 P2）：

1. **560 宽下折叠箭头不贴右（P2）**：`.pp-fold-arrow` 没有 `margin-left:auto`，宽屏是靠 `.pp-card-desc` 占满剩余宽度把它挤到右边；`@media (max-width:560px)` 把 desc 设为 `display:none` 后，箭头停在标题右侧（实测 `arrow.x=141.2`，header 宽 518 → 右侧约 350px 空白）。2× 放大图里能明显看到「账号与会员 ▾」后面一大片空。
2. **同一按钮簇内 24/28 混排（P3）**：账号卡「充值额度」是 `.pp-btn-sm`（24px），紧挨下一行「升级专业版」是全尺寸 `.pp-btn`（28px），两行 `.pp-row` 间距只有 4px，上下相邻时高差与疏密都看得出来。
3. **同一行内按钮与下拉不等高（P3）**：术语表导出行是 `.pp-btn-sm`(24) + `.pp-select`(28) 混排，下拉上下各多出 2px（截图里「导出 CSV」与右侧下拉的顶/底缘不齐）。
4. **「导出 CSV」旁的空下拉像 split-button 残件（P3，快照假象）**：`#pp-tr-glossary-pack` 这个 `<select>` 在静态快照里没有 `<option>`，实渲只剩一个窄空框 + 箭头，看着像按钮被拆开。实机由 `prefs-*.js` 填充词包列表，**不算产品缺陷**，仅记录以免复审误判。
5. **卡片图标盒比设计值胖 2px（P3）**：声明 26×26，但 `box-sizing` 非 border-box 且带 1px 边框 → 实渲 28×28（见第 8 节）。与 24px 按钮、12.5px 标题并排时略显厚重；暗色下图标是 `#4493f8` 描边 + 8%/12% 透明底，对比弱于亮色但仍可辨认。

### 补充复看（gate-render，4× 放大 + 按卡滚动整屏）

证据目录：`./zoom/`（局部 2×/3×/4× 放大）、`./scroll/`（按卡片滚动的整屏图，含 1280 亮/暗、560 亮）。

6. **暗色下未勾选的原生 checkbox 是纯白方块（P2，真缺陷）**：`4x-dark-cb-off.png` 里 13×13 的未选框是 **纯白填充、无可见边框**，在 `#21252b` 卡面上是全屏最高对比的元素，第一眼像「已选中」；勾选后（`4x-dark-cb-on.png`）是蓝底白勾，两者只能靠勾号区分。原因可测：`getComputedStyle(input).appearance = auto`、`colorScheme = normal`，`prefs.css` / `ui-tokens.css` / 页面里**没有任何 `color-scheme` 声明**，所以原生控件始终按浅色渲染（`.pp-check input` 只设了 13×13 和 `accent-color`，没设背景/边框）。同类影响：`<select>` 下拉弹层、滚动条在暗色下同样是浅色。修法一行：暗色媒体查询里给 `.pp-root` 或 `:root` 加 `color-scheme: dark`。
7. **折叠箭头字形只有 10.5px，视觉约 7px（P3）**：`.pp-fold-arrow` 盒是 18×18 的圆形热区，内容却是文本 `▾`，`font-size: var(--pp-fs-xs)` = 10.5px，字形实渲约 7px；1× 截图里它看起来像标题右侧的一个「·」（`3x-light/dark-fold-arrow.png` 可确认是三角形但很小）。建议换成 16px 的内联 svg chevron，或至少把字号提到 13px。
8. **「界面主题与壁纸」卡有 6 个只有标题的空网格（P2，快照假象）**：`#pp-cat-standard` 之外的 `#pp-cat-anime / #pp-cat-scenery / #pp-cat-dynamic / #pp-cat-giant / #pp-photo-grid / #pp-ui-special` 在 HTML 里都是**空 div**（实测高 0），六个分类标题各 18.8px，之间只剩余白 → 视觉上是一大片空洞（`scroll/1280-light-界面主题与壁纸.png`）。实机由 `prefs-theme.js` 填充，**不算产品缺陷**，但复审看静态快照时极易误判为「主题卡没渲染出来」。
9. **取色器全黑 + 7 个空下拉（P3，快照假象）**：`input[type=color]` 全部无 `value` → 实际值 `#000000`，所以亮色卡里 `#ffffff` 旁边挂着纯黑小方块；`pp-account-official-model / pp-mf-provider / pp-tr-active / pp-tr-glossary-pack / pp-menu-quick-0..2` 共 7 个 `<select>` 没有任何 `<option>`，实渲是空白框。均由 `prefs-*.js` 在实机填充。
10. **560 下卡片头信息量骤降（P3，设计取舍）**：`@media (max-width:560px)` 隐藏 `.pp-card-desc` 后，卡片头只剩「图标 + 标题 + 箭头」，箭头还紧贴标题（见第 1 条），整行右侧留白约 380px；同时「大类直达」7 个按钮换行成「6 + 1」，第二行只有一个「数据与同步」，视觉上略失衡（`560-light.png` / `560-dark.png`）。
