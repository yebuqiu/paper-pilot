# 设置面板静态门禁审计（0.72.2）

> 生成时间：2026-10-22T02:23:16+08:00｜脚本：`scripts/audit/static-audit.py`（可重复运行）
> 输入：`chrome/content/prefs.xhtml`（1843 行）、`prefs.css`（1492 行）、`ui-tokens.css`（208 行）、`prefs-*.js`（11 个）
> 行数口径：`wc -l`（换行符数）；按 `\n` 切分会多 1（末尾保留换行）。
> 指纹（SHA-256 前 16 位 · 字节 · 行尾）：prefs.xhtml `e8d622cf66d63522`（143589 B · LF，无 BOM，末尾保留换行）；prefs.css `06badc391e8c7a55`（56378 B · LF，无 BOM，末尾保留换行）；ui-tokens.css `b7091cd3f99949b0`（7939 B · LF，无 BOM，末尾保留换行）
> 全部计数来自脚本实测；明细超过 20 条时只列前 20 条并注明余量。

## 总览

| # | 门禁 | 结果 | 关键计数 |
|---|---|---|---|
| 1 | emoji 硬门禁 | **PASS** | ① 桶 0（② 57 / ③ 32 允许）；JS 范围外 6（其中注释 6） |
| 2 | 裸色值 lint | **PASS** | 组件区 0 / 内联 0 / #4b7bec 产品源 0 |
| 3 | 字号令牌纪律 | **PASS** | px 字面量 0；90 处走 var()；低于 10px 0 |
| 4 | 间距令牌纪律 | **FAIL** | CSS 刻度外 39 处；内联裸值 187 处（刻度外 17） |
| 5 | 假按钮 / 键盘可达 | **PASS** | click id 87 个全部可键盘达；动态节点复核 0 处违例 |
| 6 | 语义标签 | **PASS** | label 无关联 0；控件无标签 0；img 无 alt 0 |
| 7 | 文案一致性 | **PASS** | 五词按钮文案违例 0；通道行行内反馈 有；动词 4 种并存 |

## 1. emoji 硬门禁 — PASS

| 指标 | 值 |
|---|---|
| 扫描文件 | chrome/content/prefs.xhtml、chrome/content/prefs.css |
| ① emoji 字符数（判定项） | 0 |
| ① 不同 emoji 字符 | 0 |
| ② dingbats/符号数（允许） | 57 |
| ③ 箭头/数学符号数（允许） | 32 |
| 排版标点（—… 等，不计） | 61 |
| 范围外 · JS 中 emoji 字符数 | 6 |
| 范围外 · 其中写在注释里 | 6 |
| 范围外 · 会进入 UI 的字面量 | 0 |

### ① emoji（判定桶，必须 0）

（无）

### ② dingbats/符号（允许，仅报数）

| 字符 | 码位 | 次数 | 位置 |
|---|---|---|---|
| ▾ | U+25BE | 21 | chrome/content/prefs.xhtml:61、chrome/content/prefs.xhtml:234、chrome/content/prefs.xhtml:335、chrome/content/prefs.xhtml:412、chrome/content/prefs.xhtml:567 等 21 次 |
| ✓ | U+2713 | 9 | chrome/content/prefs.xhtml:259、chrome/content/prefs.xhtml:263、chrome/content/prefs.xhtml:264、chrome/content/prefs.xhtml:268、chrome/content/prefs.xhtml:269 等 9 次 |
| ① | U+2460 | 4 | chrome/content/prefs.xhtml:17、chrome/content/prefs.xhtml:994、chrome/content/prefs.css:10、chrome/content/prefs.css:444 |
| ③ | U+2462 | 4 | chrome/content/prefs.xhtml:17、chrome/content/prefs.css:12、chrome/content/prefs.css:701、chrome/content/prefs.css:943 |
| ★ | U+2605 | 4 | chrome/content/prefs.xhtml:19、chrome/content/prefs.xhtml:1193、chrome/content/prefs.xhtml:1200、chrome/content/prefs.xhtml:1839 |
| ⚠ | U+26A0 | 3 | chrome/content/prefs.xhtml:4、chrome/content/prefs.css:100、chrome/content/prefs.css:149 |
| ② | U+2461 | 3 | chrome/content/prefs.xhtml:17、chrome/content/prefs.xhtml:994、chrome/content/prefs.css:11 |
| ④ | U+2463 | 2 | chrome/content/prefs.xhtml:17、chrome/content/prefs.css:14 |
| ⑦ | U+2466 | 2 | chrome/content/prefs.xhtml:18、chrome/content/prefs.css:516 |
| ● | U+25CF | 2 | chrome/content/prefs.xhtml:1467、chrome/content/prefs.xhtml:1690 |
| ⑤ | U+2464 | 1 | chrome/content/prefs.xhtml:18 |
| ⑥ | U+2465 | 1 | chrome/content/prefs.xhtml:18 |
| ⑫ | U+246B | 1 | chrome/content/prefs.css:569 |

### ③ 箭头/数学符号（允许，仅报数）

| 字符 | 码位 | 次数 | 位置 |
|---|---|---|---|
| → | U+2192 | 24 | chrome/content/prefs.xhtml:154、chrome/content/prefs.xhtml:171、chrome/content/prefs.xhtml:544、chrome/content/prefs.xhtml:987、chrome/content/prefs.xhtml:1160 等 24 次 |
| ≤ | U+2264 | 2 | chrome/content/prefs.xhtml:136、chrome/content/prefs.css:462 |
| − | U+2212 | 2 | chrome/content/prefs.xhtml:830、chrome/content/prefs.xhtml:1382 |
| × | U+00D7 | 2 | chrome/content/prefs.css:444、chrome/content/prefs.css:463 |
| ÷ | U+00F7 | 1 | chrome/content/prefs.xhtml:1207 |
| ≥ | U+2265 | 1 | chrome/content/prefs.css:30 |

### 范围外补充：prefs-*.js 字面量中的 emoji

| 字符 | 码位 | 次数 | 其中在运行代码 | 位置（前 5） |
|---|---|---|---|---|
| 👁 | U+1F441 | 2 | 0 | prefs-pane.js:189、prefs-translate.js:51 |
| 🖼 | U+1F5BC | 1 | 0 | prefs-theme.js:165 |
| 🆓 | U+1F193 | 1 | 0 | prefs-translate.js:146 |
| 🔑 | U+1F511 | 1 | 0 | prefs-translate.js:146 |
| 🤖 | U+1F916 | 1 | 0 | prefs-translate.js:146 |

- 判定只对 ① 桶生效；②③ 按基准单独计数、不参与 PASS/FAIL。
- JS 一表为范围外补充事实：预览/面板脚本里的字面量不在 xhtml/css 文本里，故不影响本门禁判定。
- 现存 6 处全部写在注释里（不进入 UI）。

## 2. 裸色值 lint — PASS

| 指标 | 值 |
|---|---|
| prefs.css 颜色字面量（.pp-root 令牌区，放行） | 107 |
| prefs.css 组件区违例 | 0 |
| prefs.xhtml 内联违例 | 0 |
| #4b7bec 产品源命中 | 0 |
| #4b7bec 非产品源命中（docs 快照） | 5 |

### 组件区违例（prefs.css）

（无）

### 内联违例（prefs.xhtml style=）

（无）

### #4b7bec 命中（全仓库）

| 位置 | 是否产品源 |
|---|---|
| docs/设计审查裁决-设置面板-0.72.1.md:25 | 否（历史快照） |
| docs/设计审查裁决-设置面板-0.72.1.md:75 | 否（历史快照） |
| docs/设计改进方案-设置面板-0.72.1.md:62 | 否（历史快照） |
| docs/预览-设置面板-0.65.0.html:2984 | 否（历史快照） |
| docs/预览-设置面板-0.72.1.html:3154 | 否（历史快照） |

- 放行口径：prefs.css 中 .pp-root / :root 规则块内的声明视为令牌定义，不计违例。
- 内联检查含 var(--x, #fff) 形式的兜底字面量。

## 3. 字号令牌纪律 — PASS

| 指标 | 值 |
|---|---|
| 令牌档位（ui-tokens + prefs.css） | 10.5px / 12px / 12.5px / 13.5px / 15px / 24px |
| prefs.css font-size px 字面量 | 0 |
| ui-tokens.css font-size px 字面量 | 0 |
| distinct px 字面量值 | （无） |
| 不在令牌内的值 | 0 |
| 低于 10px 的值 | 0 |
| font-size 声明使用 var(--pp-fs-*) 次数 | 90 |

### 各字号 token 使用次数（prefs.css 声明级）

| token | 值 | 次数 |
|---|---|---|
| --pp-fs-sm | 12px | 35 |
| --pp-fs-xs | 10.5px | 24 |
| --pp-fs-md | 12.5px | 21 |
| --pp-fs-lg | 13.5px | 6 |
| --pp-fs-xl | 15px | 3 |
| --pp-fs-2xl | 24px | 1 |

### 不在令牌内的 px 值

（无）

### 范围外补充：JS 写死的 font-size px

| 位置 | px |
|---|---|
| prefs-account.js:633 | 11.5 |
| prefs-account.js:1875 | 12 |
| prefs-pane.js:265 | 11 |
| prefs-pane.js:285 | 11 |
| prefs-pane.js:291 | 11 |
| prefs-subs.js:349 | 13 |
| prefs-subs.js:539 | 12 |
| prefs-subs.js:813 | 13 |
| prefs-translate.js:587 | 12 |
| prefs-translate.js:668 | 11 |

- probe 口径：font-size 声明里的 px 数字（含简写外的单值）；var() 视为合规引用。
- 令牌档位中未被使用的档位：无。
- 范围外 JS 内联字号 10 处，其中不在令牌档位内的值 7 处（11px×4、11.5px×1、13px×2）。

## 4. 间距令牌纪律 — FAIL

| 指标 | 值 |
|---|---|
| 令牌刻度（4pt 基线） | 4px / 6px / 8px / 10px / 12px / 16px / 22px |
| prefs.css 间距 px 字面量 | 40 |
| prefs.css distinct 值 | 8 |
| prefs.css 不在刻度内 | 7 种 / 39 处 |
| prefs.xhtml 内联带 px 的间距声明 | 187 处 |
| prefs.xhtml 内联 var(--pp-sp-*) 声明 | 0 处 |
| prefs.xhtml 内联 px 字面量 | 189 |
| prefs.xhtml 内联 distinct 值 | 10 |
| prefs.xhtml 内联不在刻度内 | 4 种 / 17 处 |

### prefs.css 间距值分布

| px | 次数 | 是否在刻度 | 位置（前 5） |
|---|---|---|---|
| 1 | 8 | 否 | prefs.css:266、prefs.css:652、prefs.css:726、prefs.css:860、prefs.css:1080 等 8 次 |
| 2 | 18 | 否 | prefs.css:286、prefs.css:291、prefs.css:328、prefs.css:369、prefs.css:396 等 18 次 |
| 3 | 6 | 否 | prefs.css:457、prefs.css:601、prefs.css:788、prefs.css:995、prefs.css:1005 等 6 次 |
| 5 | 4 | 否 | prefs.css:397、prefs.css:1149、prefs.css:1213、prefs.css:1240 |
| 8 | 1 | 是 | prefs.css:396 |
| 18 | 1 | 否 | prefs.css:1367 |
| 24 | 1 | 否 | prefs.css:232 |
| 25 | 1 | 否 | prefs.css:231 |

### prefs.xhtml 内联间距值分布

| px | 次数 | 是否在刻度 | 位置（前 5） |
|---|---|---|---|
| 1 | 7 | 否 | prefs.xhtml:853、prefs.xhtml:1583、prefs.xhtml:1590、prefs.xhtml:1597、prefs.xhtml:1604 等 7 次 |
| 2 | 5 | 否 | prefs.xhtml:46、prefs.xhtml:720、prefs.xhtml:1102、prefs.xhtml:1132、prefs.xhtml:1283 |
| 4 | 14 | 是 | prefs.xhtml:376、prefs.xhtml:430、prefs.xhtml:484、prefs.xhtml:574、prefs.xhtml:581 等 14 次 |
| 6 | 55 | 是 | prefs.xhtml:46、prefs.xhtml:340、prefs.xhtml:378、prefs.xhtml:404、prefs.xhtml:473 等 55 次 |
| 8 | 46 | 是 | prefs.xhtml:491、prefs.xhtml:830、prefs.xhtml:842、prefs.xhtml:942、prefs.xhtml:947 等 46 次 |
| 10 | 32 | 是 | prefs.xhtml:66、prefs.xhtml:87、prefs.xhtml:98、prefs.xhtml:338、prefs.xhtml:361 等 32 次 |
| 12 | 24 | 是 | prefs.xhtml:27、prefs.xhtml:120、prefs.xhtml:433、prefs.xhtml:452、prefs.xhtml:481 等 24 次 |
| 14 | 2 | 否 | prefs.xhtml:1720、prefs.xhtml:1723 |
| 16 | 1 | 是 | prefs.xhtml:529 |
| 18 | 3 | 否 | prefs.xhtml:672、prefs.xhtml:676、prefs.xhtml:1651 |

- 统计属性：margin / padding / gap / row-gap / column-gap 及其 -top/-right/-bottom/-left 变体；简写里的每个 px 值各计 1 次。
- 判定：CSS 出现刻度外值、或内联出现任何 px 裸值（即使数值恰在刻度上），均记 FAIL。
- CSS 刻度外构成：1px×8、2px×18、3px×6、5px×4、18px×1、24px×1、25px×1；其中 1/2/3/5px 合计 36 处（发丝级微调），18/24/25px 合计 3 处。
- 内联刻度外构成：1px×7、2px×5、14px×2、18px×3；其余 172 个字面量虽落在刻度上，但仍是写死的 px（未走 var）。

## 5. 假按钮 / 键盘可达 — PASS

| 指标 | 值 |
|---|---|
| JS 绑定了 click 的 id 数 | 87 |
| 其中 xhtml 可定位 | 87 |
| 其中动态生成（xhtml 无此 id） | 0 |
| 判定通过的按钮 | 87 |
| 假按钮（键盘不可达） | 0 |
| 付款弹窗无障碍五项 | 齐备 |
| 补充 · 动态生成的可点击元素 | 0 个（键盘不可达 0 个） |

### 基准点名 id 现状

| id | 标签 | 行 | role | tabindex | 判定 |
|---|---|---|---|---|---|
| pp-register-link | html:button | 80 | — | — | ✓ 原生 button |
| pp-forgot-link | html:button | 81 | — | — | ✓ 原生 button |
| pp-reg-back | html:button | 110 | — | — | ✓ 原生 button |
| pp-mb-code-toggle | html:button | 185 | — | — | ✓ 原生 button |
| pp-bal-order-view | html:button | 176 | — | — | ✓ 原生 button |
| pp-mb-order-view | html:button | 225 | — | — | ✓ 原生 button |
| pp-account-email | html:button | 124 | — | — | ✓ 原生 button |
| pp-mb-renew | html:button | 137 | — | — | ✓ 原生 button |
| pp-mb-compare-toggle | html:button | 234 | — | — | ✓ 原生 button |

### 假按钮违例（click 可达、键盘不可达）

（无）

### 付款弹窗实现（prefs-account.js）

| 项 | 存在 | 行号 |
|---|---|---|
| role="dialog" | ✓ | 587 |
| aria-modal="true" | ✓ | 587 |
| aria-labelledby | ✓ | 587 |
| 关闭钮为 <button> | ✓ | 594 |
| Esc 关闭 | ✓ | 699 |
| focus trap 候选集 | ✓ | 556 |
| Tab 循环 | ✓ | 704 |
| 记录触发元素 | ✓ | 583 |
| 关闭后归还焦点 | ✓ | 796 |

### 付款弹窗实现函数（prefs-account.js）

| 函数 | 起始行 |
|---|---|
| _focusables() | 556 |
| show() | 574 |
| _onKey(Esc/Tab) | 696 |
| close() | 775 |

### 范围外复核：JS 动态生成的可点击 span/div（键鼠不等价）

（无）

- 可键盘达口径：html:button / a[href] / input[type=button|submit]；其余标签须 role=button + tabindex + JS keydown 三者齐备。
- 弹窗二维码由 JS 创建（el("img"…)），alt 属性：无。
- 动态生成 id（不在 xhtml，跳过判定）0 个。
- 范围外复核：JS 运行时创建的可点击元素已全部消除（0 处 span/div 绑定 click 且无 role/tabindex/keydown）。

## 6. 语义标签 — PASS

| 指标 | 值 |
|---|---|
| html:label 总数 | 139 |
| 其中带 for= | 23 |
| 其中 for= 断链 | 0 |
| 元素 id 重复 | 0 |
| 其中包裹控件 | 116 |
| 既无 for 也无包裹控件（必须 0） | 0 |
| 表单文本类控件总数 | 121 |
| 无 label 且无 aria-label（必须 0） | 0 |
| html:img 总数 / 无 alt | 2 / 0 |
| .pp-msg 总数 | 43 |
| .pp-msg 带 aria-live | 41 |
| .pp-msg 无 aria-live | 2（均为 aria-hidden 装饰点，按设计豁免） |
| class=pp-label 的元素 | html:span×62、html:label×23、html:div×13 |

### label 关联方式分布

| 类别 | 数量 |
|---|---|
| 带 for= | 23 |
| 包裹式 | 116 |
| 既有 for 又包裹 | 0 |
| 两者皆无 | 0 |

### 无关联的 label（伪标题/伪标签）

（无）

### 无 label / 无 aria 的文本类控件

（无）

### 按设计豁免的装饰点（aria-hidden，无 aria-live）

| 行 | id | class | aria-hidden |
|---|---|---|---|
| 1467 | pp-wps-dot | pp-msg | true |
| 1690 | pp-cloud-dot | pp-msg | true |

- 文本类控件口径：html:input 除 button/checkbox/radio/hidden/submit/reset/image/file 外的全部类型（含 text/number/color/password/range），加 html:select / html:textarea。
- checkbox/radio 由包裹式 label 承担即算已关联。
- 所有 label 均带 for= 或包裹控件（无孤立 label）。
- 23 个 for= 全部指向存在且唯一的 id（断链 0、重复 id 0）。
- .pp-msg 中 2 个无 aria-live（pp-wps-dot、pp-cloud-dot），均为彩色状态圆点（内容「●」）借用 .pp-msg 类：现为 aria-hidden="true" 纯装饰，状态播报由紧邻文字节点承担（#pp-wps-state / #pp-cloud-state 各自带 aria-live="polite" 与初始文案）。

## 7. 文案一致性 — PASS

| 指标 | 值 |
|---|---|
| 历史用词命中总数 | 8 |
| 其中出现在按钮/标签文案 | 1 |
| 按钮文案违例 | 0 |
| 现存按钮文案的动词种类 | 测试×4、检测×4、验证×2、试跑×1 |
| 通道行行内 .pp-msg | 有 |
| 通道卡底部兜底位 #pp-ch-test-result 引用 | 4 处 |

### 历史用词现存位置

| 位置 | 用词 | 语境 | 原文 |
|---|---|---|---|
| prefs-cloud.js:9 | 保存并测试 | 注释/说明 | *   ① 账号/应用密码 → 保存并测试连接（走 CloudSync.login，凭据校验失败会回滚）； |
| prefs-cloud.js:13 | 保存并测试 | 注释/说明 | * 0.72.2 设计修复：动词统一（保存并测试 → 保存并测试连接）。 |
| prefs-cloud.js:276 | 保存并测试 | 注释/说明 | throw Object.assign(new Error("还没有应用密码：请在下面填入后点「保存并测试连接」"), { code: "AUT |
| prefs-hotkeys.js:222 | 实测 | 注释/说明 | * 用户看到的就是「直达没反应」（真机实测：prefsFoldOpen 已写入 → 点击生效，纯粹滚不动）。 |
| prefs-translate.js:9 | 实测 | 注释/说明 | *          + 全部引擎列表（设为主引擎 / 纳入回退 / 填写密钥 / 实测） |
| prefs-wps.js:137 | 重新检测 | 注释/说明 | if (verbose) setMsg("已重新检测", "ok"); |
| prefs.xhtml:1696 | 实测 | 注释/说明 | 登录密码直连会返回 401（已实测）。 |
| prefs.xhtml:1716 | 保存并测试 | 按钮/标签文案 | <html:button id="pp-cloud-save" class="pp-btn pp-btn-primary">保存并测试连接</h |

### 现存含 测试/检测/实测/验证 的按钮文案

| 位置 | 文案 |
|---|---|
| prefs-account.js:1960 | 测试连接中（真实调用一次）… |
| prefs-account.js:1978 | 测试连接 |
| prefs-account.js:2165 | 检测中 |
| prefs-account.js:2191 | 检测 |
| prefs.xhtml:114 | 重发验证邮件 |
| prefs.xhtml:369 | 检测 |
| prefs.xhtml:895 | 检测权限 |
| prefs.xhtml:899 | 解除风控验证 |
| prefs.xhtml:924 | 测试连接 |
| prefs.xhtml:1064 | 试跑预览 |
| prefs.xhtml:1716 | 保存并测试连接 |

- 通道行行内反馈槽：prefs-account.js:1900
- 「保存并测试连接」视为已统一后的规范词，不计违例；仅「保存并测试」（无「连接」）计违例。

---

判定口径见脚本常量：emoji 桶按 Unicode 区段 + 显式允许符号表；颜色放行 `.pp-root` / `:root` 规则块；字号/间距以 `ui-tokens.css` 与 `prefs.css` 的 `--pp-fs-*` / `--pp-sp-*` 为准；键盘可达以原生可聚焦标签或 role+tabindex+keydown 三者齐备为准。
