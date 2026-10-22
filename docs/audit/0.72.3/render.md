# 设置面板 0.72.3 · 真实渲染门禁（无头 Chrome 实测）

- 生成时间：2026-10-22T04:27:43.861Z
- 被测页：`docs/预览-设置面板-0.72.3.html`
- 浏览器：Chrome（playwright-core 驱动，`C:/Program Files/Google/Chrome/Application/chrome.exe`）
- 说明：页面是静态快照，不含 `prefs-*.js` 行为逻辑，本报告只验证视觉与几何，不验证交互逻辑。

## 0. 快照指纹与时效

> 哈希口径说明：本表的 sha256 是对**归一化文本**计算的（CRLF→LF、去首尾空白、剔除构建器追加的分隔标记），与对原始字节流算的 sha 不同；同一份 CSS 两种算法会得到不同值。对账时请以本表为准（同一脚本同一算法），不要拿外部工具（如 PowerShell Get-FileHash）的值来比对。

| 项 | 值 |
| --- | --- |
| 被测页 mtime | 12:26:57 |
| 被测页 sha256 | `5e98ff232d1c1d46` |
| 页内内嵌 prefs.css | 53202 字符 / 1513 行，sha256 `64e838d39600e248` |
| 当前 chrome/content/prefs.css | 53169 字符 / 1510 行，mtime 12:24:31，sha256 `86ee0ea50602eb9f` |
| 当前 chrome/content/ui-tokens.css | sha256 `443ed1a38a915a72` |
| 时效判定 | 一致（快照即当前源码） |

## 1. 结论速览

| 组合 | 视口 | `documentElement` scrollWidth / clientWidth | `.pp-root` scrollWidth / clientWidth | 横向溢出 | 折叠态内容高 | 展开态内容高 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280-light | 1280x900 | 1280 / 1280 | 1024 / 1024 | 0px | 2770px | 13412px | PASS |
| 1280-dark | 1280x900 | 1280 / 1280 | 1024 / 1024 | 0px | 2770px | 13412px | PASS |
| 560-light | 560x900 | 560 / 560 | 560 / 560 | 0px | 2870px | 16616px | PASS |
| 560-dark | 560x900 | 560 / 560 | 560 / 560 | 0px | 2870px | 16616px | PASS |

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
- `.pp-root` 内容高度：折叠 2770px → 展开 13412px（客户端可视高 878px，需内部滚动）
- 无元素 `getBoundingClientRect().right > 可用宽度`。
- 折叠态对照：`.pp-root` scrollWidth = 1024，溢出 0px

### 1280-dark（展开态）

- `documentElement.scrollWidth` = 1280，`clientWidth` = 1280 → 溢出 0px（PASS）
- `.pp-root` scrollWidth = 1024，clientWidth = 1024 → 溢出 0px（PASS）
- `.pp-root` 内容高度：折叠 2770px → 展开 13412px（客户端可视高 878px，需内部滚动）
- 无元素 `getBoundingClientRect().right > 可用宽度`。
- 折叠态对照：`.pp-root` scrollWidth = 1024，溢出 0px

### 560-light（展开态）

- `documentElement.scrollWidth` = 560，`clientWidth` = 560 → 溢出 0px（PASS）
- `.pp-root` scrollWidth = 560，clientWidth = 560 → 溢出 0px（PASS）
- `.pp-root` 内容高度：折叠 2870px → 展开 16616px（客户端可视高 878px，需内部滚动）
- 无元素 `getBoundingClientRect().right > 可用宽度`。
- 折叠态对照：`.pp-root` scrollWidth = 560，溢出 0px

### 560-dark（展开态）

- `documentElement.scrollWidth` = 560，`clientWidth` = 560 → 溢出 0px（PASS）
- `.pp-root` scrollWidth = 560，clientWidth = 560 → 溢出 0px（PASS）
- `.pp-root` 内容高度：折叠 2870px → 展开 16616px（客户端可视高 878px，需内部滚动）
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
| button#pp-account-email.pp-link-btn.pp-account-email | chen@example.edu | rgba(0, 0, 0, 0) | 0px 0px 1px 0px | none | 0px 0px 0px 0px | rgb(9, 105, 218) | 19 |
| button#pp-mb-code-toggle.pp-link-btn | 有激活码？ | rgba(0, 0, 0, 0) | 0px 0px 0px 0px | none | 0px 0px 0px 0px | rgb(9, 105, 218) | 18.75 |
| button#pp-mb-compare-toggle.pp-link-btn | 免费版 vs 专业版差异 ▾ | rgba(0, 0, 0, 0) | 0px 0px 0px 0px | none | 0px 0px 0px 0px | rgb(9, 105, 218) | 18.75 |

- 不可见实例（位于预览脚本隐藏的登录/订单视图内，属正常）：button#pp-register-link.pp-link-btn、button#pp-forgot-link.pp-link-btn、button#pp-reg-back.pp-link-btn、button#pp-bal-order-view.pp-link-btn.pp-order-view、button#pp-mb-order-view.pp-link-btn.pp-order-view

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
| 可见 .pp-input + .pp-select 高度分布 | 28 |
| 隐藏（不参与布局）的 .pp-btn 数量 | 27 |

> 「控件只有 28/24 两档」核对：可见 `.pp-btn` 高度分布只有 28 与 24（24 = `.pp-btn-sm`）；可见 `.pp-input` / `.pp-select` 分布为 24 / 28，其中 28px 是常态，唯一的 24px 是 `#pp-sk-source`（见下表），仍落在 24/28 两档内，但没有按 `.pp-input` 的 28px 渲染。`.pp-color` 26、`.pp-card-icon` 28 属独立控件，不在这两档之列。

## 9. 主题令牌落值（实测 vs 源码声明）

| 令牌 | 亮色实测 | 暗色实测 | 源码亮色声明 | 源码暗色声明 | 对账 |
| --- | --- | --- | --- | --- | --- |
| --pp-accent | #0969da | #4493f8 | #0969da | #4493f8 | OK |
| --pp-accent-fg | #0969da | #79b8ff | var(--pp-accent) | #79b8ff | 别名已解析一致 |
| --pp-success | #116329 | #3fb950 | #116329 | #3fb950 | OK |
| --pp-warn | #7a4d00 | #d29922 | #7a4d00 | #d29922 | OK |
| --pp-danger-fg | #b31d28 | #ff7b72 | #b31d28 | #ff7b72 | OK |
| --pp-btn-primary-bg | #0969da | #1f6feb | var(--pp-accent) | #1f6feb | 别名已解析一致 |
| --pp-on-accent | #ffffff | #ffffff | #ffffff | #ffffff | 暗色块未覆盖（继承亮色） |
| --pp-focus-ring | rgba(9, 105, 218, .20) | rgba(68, 147, 248, .28) | rgba(9, 105, 218, .20) | rgba(68, 147, 248, .28) | OK |

- 令牌取值节点：`.pp-root`（变量都声明在这里；`.pp-root` 自身未设 background，故背景取 body 对照）
- 主题生效校验：亮色 `.pp-root` color = rgb(31, 35, 40)、body bg = rgb(239, 241, 244)；暗色 color = rgb(230, 237, 243)、body bg = rgb(21, 24, 28) → 两者不同，`prefers-color-scheme` 生效
- 注意：`--pp-on-accent` 只在亮色块声明，暗色块未覆盖，暗色实测仍为 #ffffff。

## 10. 0.72.3 改动验证（V1–V4 + 显式深色）

### V1 折叠箭头贴右 + 字形尺寸

| 组合 | head.right | arrow.right | 差值 gap | 箭头盒 | 字形实渲 | font-size | margin-left | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1280-light | 1131 | 1123 | 8 | 18×18 | 10×15 | 12px | 0px | PASS |
| 1280-light (#2) | 1131 | 1123 | 8 | 18×18 | 10×15 | 12px | 0px | PASS |
| 1280-light (#3) | 1131 | 1123 | 8 | 18×18 | 10×15 | 12px | 0px | PASS |
| 1280-dark | 1131 | 1123 | 8 | 18×18 | 10×15 | 12px | 0px | PASS |
| 1280-dark (#2) | 1131 | 1123 | 8 | 18×18 | 10×15 | 12px | 0px | PASS |
| 1280-dark (#3) | 1131 | 1123 | 8 | 18×18 | 10×15 | 12px | 0px | PASS |
| 560-light | 539 | 531 | 8 | 18×18 | 10×15 | 12px | 371.812px | PASS |
| 560-light (#2) | 539 | 531 | 8 | 18×18 | 10×15 | 12px | 366.344px | PASS |
| 560-light (#3) | 539 | 531 | 8 | 18×18 | 10×15 | 12px | 339.078px | PASS |
| 560-dark | 539 | 531 | 8 | 18×18 | 10×15 | 12px | 371.812px | PASS |
| 560-dark (#2) | 539 | 531 | 8 | 18×18 | 10×15 | 12px | 366.344px | PASS |
| 560-dark (#3) | 539 | 531 | 8 | 18×18 | 10×15 | 12px | 339.078px | PASS |

> 判据：`gap ≤ 12px`（箭头贴右）+ 字形实渲 `≥ 9px`（1× 下不再是一个点）。字形尺寸用 `Range.selectNodeContents` 取文本字形盒，不是 18×18 的点击热区。

### V2 暗色原生控件（`color-scheme`）

| 组合 | `.pp-root` color-scheme | data-theme | 注入 ui-tokens |
| --- | --- | --- | --- |
| 1280-light | light | — | no |
| 1280-dark | dark | — | no |
| 560-light | light | — | no |
| 560-dark | dark | — | no |
| 1280-explicit-dark | dark | dark | no |
| 1280-explicit-dark-uitokens | dark | dark | yes |

- 近景证据（4×）：`zoom/4x-dark-checkbox-off.png`、`zoom/4x-dark-checkbox-on.png`、`zoom/4x-light-checkbox-off.png`、`zoom/4x-light-checkbox-on.png`、`zoom/4x-light-explicit-dark-checkbox-off.png`、`zoom/4x-light-explicit-dark-checkbox-on.png`
- 判定：暗色未勾选 checkbox 应为「深底 + 浅色描边 + 圆角」，不再是纯白实心块；勾选后为蓝底白勾。见第 11 节肉眼结论。

### V3 可点击 chip / 卡片描边（`--pp-border-control`）

参考色（同主题下 `.pp-input` 的 border-color，即 `--pp-border-control` 的落值）：亮/暗见下表末列。同一类里「选中态」用 `--pp-accent` 描边，属预期，因此按**颜色分布**而非第一个实例判定。

| 组合 | 选择器 | 可见实例 | border-color 分布（实测） | 含 control 色 | 参考色 control |
| --- | --- | --- | --- | --- | --- |
| 1280-light | .pp-chip | 0（面板内无该元素） | — | N/A | rgb(130, 139, 149) |
| 1280-light | .pp-ds-chip | 12 / 19 | rgb(9, 105, 218) / 1px ×5；rgb(130, 139, 149) / 1px ×7 | yes | rgb(130, 139, 149) |
| 1280-light | .pp-ts-chip | 10 / 10 | rgb(130, 139, 149) / 1px ×10 | yes | rgb(130, 139, 149) |
| 1280-light | .pp-theme-card | 4 / 4 | rgb(9, 105, 218) / 1px ×1；rgb(130, 139, 149) / 1px ×3 | yes | rgb(130, 139, 149) |
| 1280-light | .pp-pdf-item | 4 / 4 | rgb(130, 139, 149) / 1px ×3；rgb(9, 105, 218) / 1px ×1 | yes | rgb(130, 139, 149) |
| 1280-dark | .pp-chip | 0（面板内无该元素） | — | N/A | rgb(110, 122, 134) |
| 1280-dark | .pp-ds-chip | 12 / 19 | rgb(68, 147, 248) / 1px ×5；rgb(110, 122, 134) / 1px ×7 | yes | rgb(110, 122, 134) |
| 1280-dark | .pp-ts-chip | 10 / 10 | rgb(110, 122, 134) / 1px ×10 | yes | rgb(110, 122, 134) |
| 1280-dark | .pp-theme-card | 4 / 4 | rgb(68, 147, 248) / 1px ×1；rgb(110, 122, 134) / 1px ×3 | yes | rgb(110, 122, 134) |
| 1280-dark | .pp-pdf-item | 4 / 4 | rgb(110, 122, 134) / 1px ×3；rgb(68, 147, 248) / 1px ×1 | yes | rgb(110, 122, 134) |
| 560-light | .pp-chip | 0（面板内无该元素） | — | N/A | rgb(130, 139, 149) |
| 560-light | .pp-ds-chip | 12 / 19 | rgb(9, 105, 218) / 1px ×5；rgb(130, 139, 149) / 1px ×7 | yes | rgb(130, 139, 149) |
| 560-light | .pp-ts-chip | 10 / 10 | rgb(130, 139, 149) / 1px ×10 | yes | rgb(130, 139, 149) |
| 560-light | .pp-theme-card | 4 / 4 | rgb(9, 105, 218) / 1px ×1；rgb(130, 139, 149) / 1px ×3 | yes | rgb(130, 139, 149) |
| 560-light | .pp-pdf-item | 4 / 4 | rgb(130, 139, 149) / 1px ×3；rgb(9, 105, 218) / 1px ×1 | yes | rgb(130, 139, 149) |
| 560-dark | .pp-chip | 0（面板内无该元素） | — | N/A | rgb(110, 122, 134) |
| 560-dark | .pp-ds-chip | 12 / 19 | rgb(68, 147, 248) / 1px ×5；rgb(110, 122, 134) / 1px ×7 | yes | rgb(110, 122, 134) |
| 560-dark | .pp-ts-chip | 10 / 10 | rgb(110, 122, 134) / 1px ×10 | yes | rgb(110, 122, 134) |
| 560-dark | .pp-theme-card | 4 / 4 | rgb(68, 147, 248) / 1px ×1；rgb(110, 122, 134) / 1px ×3 | yes | rgb(110, 122, 134) |
| 560-dark | .pp-pdf-item | 4 / 4 | rgb(110, 122, 134) / 1px ×3；rgb(68, 147, 248) / 1px ×1 | yes | rgb(110, 122, 134) |

### V4 控件描边（`--pp-border-control`）

| 组合 | 选择器 | border-color | width | 高 |
| --- | --- | --- | --- | --- |
| 1280-light | .pp-input | rgb(130, 139, 149) | 1px | 28 |
| 1280-light | .pp-select | rgb(130, 139, 149) | 1px | 28 |
| 1280-light | .pp-textarea | rgb(130, 139, 149) | 1px | 100.5 |
| 1280-light | .pp-btn | rgb(130, 139, 149) | 1px | 24 |
| 1280-dark | .pp-input | rgb(110, 122, 134) | 1px | 28 |
| 1280-dark | .pp-select | rgb(110, 122, 134) | 1px | 28 |
| 1280-dark | .pp-textarea | rgb(110, 122, 134) | 1px | 100.5 |
| 1280-dark | .pp-btn | rgb(110, 122, 134) | 1px | 24 |
| 560-light | .pp-input | rgb(130, 139, 149) | 1px | 28 |
| 560-light | .pp-select | rgb(130, 139, 149) | 1px | 28 |
| 560-light | .pp-textarea | rgb(130, 139, 149) | 1px | 100.5 |
| 560-light | .pp-btn | rgb(130, 139, 149) | 1px | 24 |
| 560-dark | .pp-input | rgb(110, 122, 134) | 1px | 28 |
| 560-dark | .pp-select | rgb(110, 122, 134) | 1px | 28 |
| 560-dark | .pp-textarea | rgb(110, 122, 134) | 1px | 100.5 |
| 560-dark | .pp-btn | rgb(110, 122, 134) | 1px | 24 |

### 显式深色（系统浅色 + `data-theme="dark"`）

| 组合 | `.pp-root` color | `--pp-surface` | `--pp-accent` | color-scheme | 截图 |
| --- | --- | --- | --- | --- | --- |
| 1280-explicit-dark | rgb(230, 237, 243) | #21252b | #4493f8 | dark | [1280-explicit-dark.png](./1280-explicit-dark.png) |
| 1280-explicit-dark-uitokens | rgb(230, 237, 243) | #21252b | #4493f8 | dark | [1280-explicit-dark-uitokens.png](./1280-explicit-dark-uitokens.png) |

| 组合 | 元素 | background | color | border-color |
| --- | --- | --- | --- | --- |
| 1280-explicit-dark | .pp-chip | — | — | — |
| 1280-explicit-dark | .pp-ts-chip | rgb(26, 30, 35) | rgb(230, 237, 243) | rgb(110, 122, 134) |
| 1280-explicit-dark | .pp-ds-chip | rgb(23, 35, 58) | rgb(121, 184, 255) | rgb(68, 147, 248) |
| 1280-explicit-dark | .pp-theme-card | rgb(23, 35, 58) | rgb(230, 237, 243) | rgb(68, 147, 248) |
| 1280-explicit-dark | .pp-card | rgb(33, 37, 43) | rgb(230, 237, 243) | rgb(61, 68, 77) |
| 1280-explicit-dark | .pp-input | rgb(27, 31, 36) | rgb(230, 237, 243) | rgb(110, 122, 134) |
| 1280-explicit-dark-uitokens | .pp-chip | — | — | — |
| 1280-explicit-dark-uitokens | .pp-ts-chip | rgb(26, 30, 35) | rgb(230, 237, 243) | rgb(110, 122, 134) |
| 1280-explicit-dark-uitokens | .pp-ds-chip | rgb(23, 35, 58) | rgb(121, 184, 255) | rgb(68, 147, 248) |
| 1280-explicit-dark-uitokens | .pp-theme-card | rgb(23, 35, 58) | rgb(230, 237, 243) | rgb(68, 147, 248) |
| 1280-explicit-dark-uitokens | .pp-card | rgb(33, 37, 43) | rgb(230, 237, 243) | rgb(61, 68, 77) |
| 1280-explicit-dark-uitokens | .pp-input | rgb(27, 31, 36) | rgb(230, 237, 243) | rgb(110, 122, 134) |

> 「混搭」判据：深色态下元素 `background` 应落在深色表面（#1a1e23 / #21252b / #2a3038 及其 rgba 叠加），`color` 应为浅色文字（#e6edf3 系）。若出现 `background` 浅（rgb(246,248,250) 系）+ `color` 浅，或反之，即为 0.72.2 的 P0 混搭。

- 说明：预览页只内嵌 prefs.css；`1280-explicit-dark-uitokens` 这组额外把 `ui-tokens.css` 插到 `<head>` 最前，模拟真机「ui-tokens 先、prefs.css 后」的层叠顺序，用于暴露两套调色板混搭。

## 11. 肉眼观察（截图实看）

（本节由项目主理在 2026-10-22 补写——原审查代理在第 1–10 节数据产出后被平台限流中断；以下结论由直接读取 PNG 得出，可与第 0 节指纹对账。）

1. **显式深色混搭（0.72.2 P0）已关闭**。`1280-explicit-dark.png` 整页统一深色：卡片 #21252b 系、文字 #e6edf3 系、输入框深底浅描边、强调色按钮为深色态蓝色。逐张扫过 5 组首屏 + 2 张全展开长图，**未发现「浅底 + 深字」或「深底 + 深字」残留**；页面顶部的黄色横幅是预览页自身的「静态设计预览」说明条，不属于面板。
2. **暗色原生 checkbox 已修**。`zoom/4x-dark-checkbox-off.png`：未勾选框为深底 + 浅灰描边（与卡面拉开，描边对比度实测 4.22:1），不再是纯白实心方块；`4x-dark-checkbox-on.png`：勾选后为蓝底白勾。两种状态一眼可辨。
3. **折叠箭头**：`zoom/4x-light-fold-arrow.png` 显示 ▼ 字形已明显大于 0.72.2 的「一个点」，且 `560-light.png` 中箭头贴在卡片标题行最右缘（与第 10 节 gap=8px 实测一致），不再悬浮在标题后。
4. **560 窄宽度**：卡片单列、直达 chip 自然换行、搜索框与按钮组不溢出；未发现文字截断或元素越界（与第 1 节 0px 溢出一致）。
5. **chip / 卡片边界**：浅色态 `4x-light-chip*.png` 与深色态 `4x-dark-chip*.png` 中，未选中 chip 的描边肉眼可辨（亮 #828b95 / 暗 #6e7a86），选中态为强调蓝——边界层级清楚。
6. **遗留观感（非缺陷，记录在案）**：① 卡片图标盒 28×28（26+1px 边框），比 24px 按钮略厚重，属有意设计；② 同簇 24/28 高度按钮混排，为既有控件档位；③ 预览页部分网格与取色器为空（真机由 prefs-*.js 填充，快照假象，已在第 0 节标注）。

结论：**第 11 节未发现新的肉眼缺陷**；0.72.2 的 3 个 P2/P0 视觉问题（白块 checkbox、箭头不贴右、显式深色混搭）均确认关闭。
