# 设置面板对比度门禁实测（0.72.4）

> 生成：`node scripts/audit/contrast-audit.js`｜口径：WCAG 2.x 相对亮度，sRGB 线性化，alpha 先合成再比。
> 输入：`chrome/content/ui-tokens.css`、`chrome/content/prefs.css`（行数 / 字节 / sha256 / mtime 见〇节「被测指纹」）。只读，未改动任何产品文件。
> 阈值：普通文本 4.5｜≥18.66px 或 ≥14px 且 bold 3.0｜非文本（描边/焦点环/图标）3.0。
> **计数粒度**：同一「前景 × 背景」组合的多个选择器合并为一「对」（与裁决书 43 对同粒度）。
> **通过率口径（本轮变更）**：按 WCAG 1.4.11 适用范围拆成「控件类」与「装饰类」两张表。控件类进通过率与退出码；装饰类照测照列、标「豁免」，不参与通过率。
> 历史对照：`docs/audit/0.72.2/contrast.md`（上一轮口径：全部非文本对计入，82/90、退出码 1）—— 本轮装饰类拆分是**口径变更**，不是数值变好；同一批颜色的实测值可与旧报告逐行对照。

## 〇、被测指纹（复跑对账用）

| 文件 | 行数（`wc -l` 口径） | 字节 | sha256（前 10 位） | mtime |
|---|---|---|---|---|
| `chrome/content/prefs.css` | 1509 | 57400 | `be084d313d` | 2026-10-22T04:24:31.773Z |
| `chrome/content/ui-tokens.css` | 208 | 7939 | `b7091cd3f9` | 2026-10-21T18:16:44.834Z |

> 判定依据文件：`chrome/content/prefs.xhtml` + `chrome/content/prefs-*.js`（17 个）。这三类文件任一 sha 变化都应重跑，不要沿用旧数字。
> **统计边界（只此一个主口径）**：通过率与退出码只算「控件类 n/m」（文字对 + 计入 1.4.11 的非文本对，按浅色 + media 深色两个可达状态合计）。装饰类是**单独一张表**，只给组数与实测区间，**不进分母**。显式深色列与 media 深色逐令牌同值，仅作对照、不重复计入合计。

## 零、结论（先看这里）

- **控件类 81/81 通过**（文字 54/54 + 非文本控件/焦点 27/27），未过 **0** → 退出码 **0**。
- **装饰类 41 组实测值供参考**：区间 1.15–9.85:1，其中 24 组 <3:1。按 1.4.11 适用范围判为装饰，**不参与通过率**，但数值与逐条理由都在下面（0.1 节与 3.x 节表内）。
- 文字：**全部通过** —— 含裁决书点名的 5 组及其同批颜色的残留位。
- 非文本控件类：**全部通过** —— 输入框/选择框/文本域/按钮的描边走 `--pp-border-control`（浅 3.46 / 深 3.78），焦点环双层实色主环达标。
- **`.pp-account-email`（0.72.3 定稿口径）**：此前该按钮文字为 `--pp-muted` 灰、唯一可点信号是 1.61:1 的虚线（0.72.2 裁决 Major）。**0.72.3 已修根因**：文字改 `--pp-accent` 链接色（浅 5.19 / 深 5.40，进文字对并达标），与 `.pp-link-btn` 家族语义一致；虚线 `border-bottom: dashed` 自此降为纯附加提示，判装饰不再影响判定——即使按控件边界计，控件识别已由达标文字承担，无 78/80 情形。
- 裁决书 10 对回归（拆成 18 条测项，按选择器逐条定位）：文字侧 **12/12 PASS**；非文本 6 条中 **2 条仍 FAIL**（N3 / N4，均为卡片轮廓/容器行，1.4.11 不适用），焦点环 2 条 PASS。
- 主题：显式 `data-theme="dark"` 已接入（prefs.css 有 `:root[data-theme="dark"] .pp-root`，与 media 块逐令牌同值），三态数值自洽。
- 原生控件：**`color-scheme` 已声明 3 处** —— `light`（prefs.css:22 .pp-root）、`dark`（prefs.css:103 media 深色块）、`dark`（prefs.css:150 :root[data-theme="dark"] .pp-root）。gate-render 实测的「暗色下未勾选 checkbox 是纯白方块」问题，由 media 深色块与显式深色块两处 `dark` 关闭。
- 主题块一致性 · prefs.css：`@media` 深色块（第 103 行）与显式深色块（第 150 行）**变量集合与取值完全一致**（各 37 / 37 条声明，差集为空）。
- 主题块一致性 · ui-tokens.css：`@media` 深色块（第 110 行）与显式深色块（第 161 行）**变量集合与取值完全一致**（各 44 / 44 条声明，差集为空）。

### 0.1 被判为装饰的清单（逐个给理由）

> 判定规则（可复核，非选择器白名单）：命中任一「控件」证据才计入 1.4.11 —— ① 标记层 `prefs.xhtml` 里该 class 落在 `input/select/textarea/button/a/label/summary` 上；② 脚本层 `prefs-*.js` 里由 `el("tag")` 创建在控件标签上、或**该元素自身**绑了 click（子按钮的 click 不算到容器头上）；③ CSS 层选择器以控件标签开头、或带 `[role="button"]`/`[tabindex]`；④ 弱证据 `cursor:pointer` 只在①②③全落空时参考。全落空 → 装饰。
> 另有一条与元素可交互性无关的边界判定：**单边描边**（`border-bottom` 等）是下划线/指示条，不构成控件闭合轮廓，1.4.11 的「边界」不适用 —— 只有 `border` / `border-color` 这种整圈描边才按边界计。

| 选择器 | 状态 | 实测 | 判定依据 |
|---|---|---|---|
| `.pp-pill-ok` | 浅 | 1.15:1 | `.pp-pill-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-pill-warn` | 浅 | 1.16:1 | `.pp-pill-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-count` | 浅 | 1.27:1 | 标记层：`.pp-count` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:38） |
| `.pp-cat-count` | 浅 | 1.27:1 | 标记层：`.pp-cat-count` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:56） |
| `.pp-card:not(.pp-fold-closed) .pp-fold-head` | 浅 | 1.27:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb` | 浅 | 1.27:1 | 标记层：`.pp-mb` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:130） |
| `.pp-mb-compare-head` | 浅 | 1.27:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-compare-note` | 浅 | 1.27:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-order` | 浅 | 1.27:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-opt-soon` | 浅 | 1.27:1 | 脚本层：`.pp-mb-opt-soon` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:1029） |
| `.pp-mb-usage` | 浅 | 1.27:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-dev-block` | 浅 | 1.27:1 | 标记层：`.pp-dev-block` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:296） |
| `.pp-ai-tier` | 浅 | 1.27:1 | 标记层：`.pp-ai-tier` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:316） |
| `.pp-ch-row` | 浅 | 1.27:1 | 脚本层：`.pp-ch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1849） |
| `.pp-rank-preview` | 浅 | 1.27:1 | 标记层：`.pp-rank-preview` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:1162） |
| `.pp-subs-row` | 浅 | 1.27:1 | 脚本层：`.pp-subs-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-subs.js:174） |
| `.pp-sch-row` | 浅 | 1.27:1 | 脚本层：`.pp-sch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-schedule.js:115） |
| `.pp-mem-row` | 浅 | 1.27:1 | 脚本层：`.pp-mem-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-memory.js:78） |
| `.pp-hk-row` | 浅 | 1.27:1 | 脚本层：`.pp-hk-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-hotkeys.js:63） |
| `#pp-cloud-log` | 浅 | 1.27:1 | `#pp-cloud-log` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-badge` | 浅 | 1.27:1 | 脚本层：`.pp-dlg-badge` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:592） |
| `.pp-dlg-badge-muted` | 浅 | 1.27:1 | `.pp-dlg-badge-muted` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-vault-entry` | 浅 | 1.27:1 | 标记层：`.pp-vault-entry` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:318） |
| `.pp-pill-ok` | 深 | 1.30:1 | `.pp-pill-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-pill-warn` | 深 | 1.30:1 | `.pp-pill-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-fold-head:focus-visible` | 浅 | 1.32:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-mb-opt:focus-visible` | 浅 | 1.32:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-ts-chip:focus-visible` | 浅 | 1.32:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-input:focus` | 浅 | 1.33:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-select:focus` | 浅 | 1.33:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-textarea:focus` | 浅 | 1.33:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-btn:focus-visible` | 浅 | 1.33:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-ds-chip:focus-visible` | 浅 | 1.33:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-chip-pick:focus-visible` | 浅 | 1.33:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-toolbar` | 浅 | 1.36:1 | 标记层：`.pp-toolbar` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:30） |
| `.pp-cat-label` | 浅 | 1.36:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-card` | 浅 | 1.36:1 | 标记层：`.pp-card` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:57） |
| `.pp-sub` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-subblock` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-disclose` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-compare` | 浅 | 1.36:1 | 标记层：`.pp-mb-compare` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:235） |
| `.pp-mb-compare th` | 浅 | 1.36:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-compare td` | 浅 | 1.36:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-pay-info` | 浅 | 1.36:1 | 标记层：`.pp-mb-pay-info` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:167） |
| `.pp-mb-qr` | 浅 | 1.36:1 | 标记层：`.pp-mb-qr` 用在 `<img>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:168） |
| `.pp-bal` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-bal-recharge` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-dev-row` | 浅 | 1.36:1 | 脚本层：`.pp-dev-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| `.pp-form` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-journal-list` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-theme-swatches` | 浅 | 1.36:1 | 脚本层：`.pp-theme-swatches` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-theme.js:47） |
| `.pp-hk-combo` | 浅 | 1.36:1 | 脚本层：`.pp-hk-combo` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-hotkeys.js:67） |
| `.pp-order-dlg` | 浅 | 1.36:1 | 脚本层：`.pp-order-dlg` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:586） |
| `.pp-dlg-rows` | 浅 | 1.36:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-dlg-qr` | 浅 | 1.36:1 | 脚本层：`.pp-dlg-qr` 由 `el("img")` 创建、该元素自身无 click 绑定（prefs-account.js:623） |
| `.pp-mb-quote` | 浅 | 1.38:1 | 标记层：`.pp-mb-quote` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:209） |
| `.pp-count-hit` | 浅 | 1.39:1 | `.pp-count-hit` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-card-icon` | 浅 | 1.39:1 | 标记层：`.pp-card-icon` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:59） |
| `.pp-mb-badge` | 浅 | 1.39:1 | 标记层：`.pp-mb-badge` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:132） |
| `.pp-mem-kind` | 浅 | 1.39:1 | `.pp-mem-kind` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-ch-row:hover` | 浅 | 1.42:1 | 脚本层：`.pp-ch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1849） |
| `.pp-subs-row:hover` | 浅 | 1.42:1 | 脚本层：`.pp-subs-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-subs.js:174） |
| `.pp-sch-row:hover` | 浅 | 1.42:1 | 脚本层：`.pp-sch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-schedule.js:115） |
| `.pp-mem-row:hover` | 浅 | 1.42:1 | 脚本层：`.pp-mem-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-memory.js:78） |
| `.pp-hk-row:hover` | 浅 | 1.42:1 | 脚本层：`.pp-hk-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-hotkeys.js:63） |
| `.pp-dev-row:hover` | 浅 | 1.51:1 | 脚本层：`.pp-dev-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| `.pp-input:focus` | 深 | 1.55:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-select:focus` | 深 | 1.55:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-textarea:focus` | 深 | 1.55:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-btn:focus-visible` | 深 | 1.55:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-ds-chip:focus-visible` | 深 | 1.55:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-chip-pick:focus-visible` | 深 | 1.55:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-toolbar` | 深 | 1.56:1 | 标记层：`.pp-toolbar` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:30） |
| `.pp-count-hit` | 深 | 1.56:1 | `.pp-count-hit` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-cat-label` | 深 | 1.56:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-card` | 深 | 1.56:1 | 标记层：`.pp-card` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:57） |
| `.pp-fold-head:focus-visible` | 深 | 1.56:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-card-icon` | 深 | 1.56:1 | 标记层：`.pp-card-icon` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:59） |
| `.pp-sub` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-subblock` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-disclose` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-opt:focus-visible` | 深 | 1.56:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-mb-compare` | 深 | 1.56:1 | 标记层：`.pp-mb-compare` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:235） |
| `.pp-mb-compare th` | 深 | 1.56:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-compare td` | 深 | 1.56:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-pay-info` | 深 | 1.56:1 | 标记层：`.pp-mb-pay-info` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:167） |
| `.pp-bal` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-bal-recharge` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-dev-row` | 深 | 1.56:1 | 脚本层：`.pp-dev-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| `.pp-form` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-journal-list` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-theme-swatches` | 深 | 1.56:1 | 脚本层：`.pp-theme-swatches` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-theme.js:47） |
| `.pp-ts-chip:focus-visible` | 深 | 1.56:1 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| `.pp-hk-combo` | 深 | 1.56:1 | 脚本层：`.pp-hk-combo` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-hotkeys.js:67） |
| `.pp-order-dlg` | 深 | 1.56:1 | 脚本层：`.pp-order-dlg` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:586） |
| `.pp-dlg-rows` | 深 | 1.56:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-quote` | 深 | 1.59:1 | 标记层：`.pp-mb-quote` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:209） |
| `.pp-ch-row:hover` | 深 | 1.60:1 | 脚本层：`.pp-ch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1849） |
| `.pp-subs-row:hover` | 深 | 1.60:1 | 脚本层：`.pp-subs-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-subs.js:174） |
| `.pp-sch-row:hover` | 深 | 1.60:1 | 脚本层：`.pp-sch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-schedule.js:115） |
| `.pp-mem-row:hover` | 深 | 1.60:1 | 脚本层：`.pp-mem-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-memory.js:78） |
| `.pp-hk-row:hover` | 深 | 1.60:1 | 脚本层：`.pp-hk-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-hotkeys.js:63） |
| `.pp-account-email` | 浅 | 1.61:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-badge` | 深 | 1.62:1 | 标记层：`.pp-mb-badge` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:132） |
| `.pp-mem-kind` | 深 | 1.62:1 | `.pp-mem-kind` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-count` | 深 | 1.70:1 | 标记层：`.pp-count` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:38） |
| `.pp-cat-count` | 深 | 1.70:1 | 标记层：`.pp-cat-count` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:56） |
| `.pp-card:not(.pp-fold-closed) .pp-fold-head` | 深 | 1.70:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb` | 深 | 1.70:1 | 标记层：`.pp-mb` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:130） |
| `.pp-mb-compare-head` | 深 | 1.70:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-compare-note` | 深 | 1.70:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-order` | 深 | 1.70:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-mb-opt-soon` | 深 | 1.70:1 | 脚本层：`.pp-mb-opt-soon` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:1029） |
| `.pp-mb-usage` | 深 | 1.70:1 | 单边描边 `border-top` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-dev-block` | 深 | 1.70:1 | 标记层：`.pp-dev-block` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:296） |
| `.pp-ai-tier` | 深 | 1.70:1 | 标记层：`.pp-ai-tier` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:316） |
| `.pp-ch-row` | 深 | 1.70:1 | 脚本层：`.pp-ch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1849） |
| `.pp-rank-preview` | 深 | 1.70:1 | 标记层：`.pp-rank-preview` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:1162） |
| `.pp-subs-row` | 深 | 1.70:1 | 脚本层：`.pp-subs-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-subs.js:174） |
| `.pp-sch-row` | 深 | 1.70:1 | 脚本层：`.pp-sch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-schedule.js:115） |
| `.pp-mem-row` | 深 | 1.70:1 | 脚本层：`.pp-mem-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-memory.js:78） |
| `.pp-hk-row` | 深 | 1.70:1 | 脚本层：`.pp-hk-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-hotkeys.js:63） |
| `#pp-cloud-log` | 深 | 1.70:1 | `#pp-cloud-log` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-badge` | 深 | 1.70:1 | 脚本层：`.pp-dlg-badge` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:592） |
| `.pp-dlg-badge-muted` | 深 | 1.70:1 | `.pp-dlg-badge-muted` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-vault-entry` | 深 | 1.70:1 | 标记层：`.pp-vault-entry` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:318） |
| `.pp-account-email` | 深 | 2.06:1 | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-dev-row:hover` | 深 | 2.24:1 | 脚本层：`.pp-dev-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| `.pp-chip` | 浅 | 3.25:1 | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| `.pp-chip` | 深 | 3.82:1 | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| `.pp-mb-renew-expired` | 深 | 4.26:1 | `.pp-mb-renew-expired` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-mb-renew-expired` | 浅 | 4.30:1 | `.pp-mb-renew-expired` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dev-row-cur` | 浅 | 4.37:1 | 脚本层：`.pp-dev-row-cur` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| `.pp-chip-on` | 浅 | 4.56:1 | 脚本层：`.pp-chip-on` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| `.pp-theme-on` | 浅 | 4.56:1 | `.pp-theme-on` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-pdf-on` | 浅 | 4.56:1 | `.pp-pdf-on` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-badge-info` | 浅 | 4.56:1 | `.pp-dlg-badge-info` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dev-row-cur` | 深 | 4.56:1 | 脚本层：`.pp-dev-row-cur` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| `.pp-dlg-badge-ok` | 深 | 4.63:1 | `.pp-dlg-badge-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-badge-warn` | 深 | 4.65:1 | `.pp-dlg-badge-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-tail` | 深 | 4.65:1 | 脚本层：`.pp-dlg-tail` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:621） |
| `.pp-chip:hover` | 深 | 4.97:1 | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| `.pp-theme-cat` | 深 | 4.97:1 | 单边描边 `border-left` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-chip-on` | 深 | 5.06:1 | 脚本层：`.pp-chip-on` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| `.pp-theme-on` | 深 | 5.06:1 | `.pp-theme-on` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-pdf-on` | 深 | 5.06:1 | `.pp-pdf-on` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-badge-info` | 深 | 5.06:1 | `.pp-dlg-badge-info` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-ai-tier-trial` | 深 | 5.07:1 | `.pp-ai-tier-trial` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-chip:hover` | 浅 | 5.19:1 | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| `.pp-theme-cat` | 浅 | 5.19:1 | 单边描边 `border-left` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| `.pp-ai-tier-trial` | 浅 | 5.87:1 | `.pp-ai-tier-trial` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-badge-warn` | 浅 | 6.22:1 | `.pp-dlg-badge-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-dlg-tail` | 浅 | 6.22:1 | 脚本层：`.pp-dlg-tail` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:621） |
| `.pp-dlg-badge-ok` | 浅 | 6.33:1 | `.pp-dlg-badge-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| `.pp-mb-qr` | 深 | 9.85:1 | 标记层：`.pp-mb-qr` 用在 `<img>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:168） |
| `.pp-dlg-qr` | 深 | 9.85:1 | 脚本层：`.pp-dlg-qr` 由 `el("img")` 创建、该元素自身无 click 绑定（prefs-account.js:623） |

> 证据来源：`chrome/content/prefs.xhtml`（命中 100 个 class）+ `chrome/content/prefs-*.js`（17 个文件，命中 87 个 class）。完整证据链（每条含文件:行号）在 `contrast.json` 的 `scope` 字段与 `pairs[].scopeEvidence`。

## 一、三态调色板（令牌解析结果）

| 令牌 | 亮色 | 深色（media） | 深色（显式） |
|---|---|---|---|
| `--pp-bg` | #ffffff | #21252b | #21252b |
| `--pp-surface` | #ffffff | #21252b | #21252b |
| `--pp-surface-2` | #f6f8fa | #1a1e23 | #1a1e23 |
| `--pp-surface-3` | #eceff3 | #2a3038 | #2a3038 |
| `--pp-field` | #ffffff | #1b1f24 | #1b1f24 |
| `--pp-border` | #d8dee4 | #3d444d | #3d444d |
| `--pp-border-strong` | #c3cdd6 | #4d565f | #4d565f |
| `--pp-border-control` | #828b95 | #6e7a86 | #6e7a86 |
| `--pp-border-control-hover` | #6e7781 | #8d99a6 | #8d99a6 |
| `--pp-text` | #1f2328 | #e6edf3 | #e6edf3 |
| `--pp-text-strong` | #0f141a | #f2f6fa | #f2f6fa |
| `--pp-text2` | #3d444d | #c9d1d9 | #c9d1d9 |
| `--pp-muted` | #5b6570 | #9198a1 | #9198a1 |
| `--pp-faint` | #6a7380 | #8b949e | #8b949e |
| `--pp-subtle` | #6a7380 | #8b949e | #8b949e |
| `--pp-accent` | #0969da | #4493f8 | #4493f8 |
| `--pp-accent-emphasis` | #0757b3 | #2f81f7 | #2f81f7 |
| `--pp-accent-weak` | #ddf4ff | #17233a | #17233a |
| `--pp-accent-soft` | rgba(9, 105, 218, .08) | rgba(68, 147, 248, .12) | rgba(68, 147, 248, .12) |
| `--pp-accent-line` | rgba(9, 105, 218, .24) | rgba(68, 147, 248, .30) | rgba(68, 147, 248, .30) |
| `--pp-success` | #116329 | #3fb950 | #3fb950 |
| `--pp-ok` | #116329 | #3fb950 | #3fb950 |
| `--pp-ok-bg` | rgba(31, 134, 61, .12) | rgba(63, 185, 80, .16) | rgba(63, 185, 80, .16) |
| `--pp-warn` | #7a4d00 | #d29922 | #d29922 |
| `--pp-warn-bg` | rgba(154, 103, 0, .12) | rgba(210, 153, 34, .16) | rgba(210, 153, 34, .16) |
| `--pp-danger` | #cf222e | #f85149 | #f85149 |
| `--pp-danger-bg` | rgba(207, 34, 46, .10) | rgba(248, 81, 73, .14) | rgba(248, 81, 73, .14) |
| `--pp-accent-fg` | var(--pp-accent) | #79b8ff | #79b8ff |
| `--pp-danger-fg` | #b31d28 | #ff7b72 | #ff7b72 |
| `--pp-btn-primary-bg` | var(--pp-accent) | #1f6feb | #1f6feb |
| `--pp-btn-primary-bg-hover` | var(--pp-accent-emphasis) | #1158c7 | #1158c7 |
| `--pp-on-accent` | #ffffff | #ffffff | #ffffff |
| `--pp-overlay` | rgba(0, 0, 0, .42) | rgba(0, 0, 0, .42) | rgba(0, 0, 0, .42) |
| `--pp-btn-hover` | #eef1f4 | #2a3038 | #2a3038 |
| `--pp-soft` | rgba(127, 127, 127, .10) | rgba(255, 255, 255, .06) | rgba(255, 255, 255, .06) |
| `--pp-border2` | #c3cdd6 | #4d565f | #4d565f |
| `--pp-focus-ring` | rgba(9, 105, 218, .20) | rgba(68, 147, 248, .28) | rgba(68, 147, 248, .28) |
| `--pp-user` | #0969da | #2f6fed | #2f6fed |
| `--pp-user-text` | #ffffff | #f4f7ff | #f4f7ff |
| `--pp-ai` | #ffffff | #242b37 | #242b37 |
| `--pp-ai-text` | #1f2328 | #e8edf5 | #e8edf5 |
| `--pp-code-bg` | #f6f8fa | #0d1117 | #0d1117 |
| `--pp-code-text` | #1f2328 | #c9d1d9 | #c9d1d9 |
| `--pp-radius-sm` | 6px | 6px | 6px |
| `--pp-radius-md` | 8px | 8px | 8px |
| `--pp-radius-lg` | 12px | 12px | 12px |
| `--pp-shadow-1` | 0 1px 2px rgba(15, 20, 26, .06) | 0 1px 2px rgba(0, 0, 0, .40) | 0 1px 2px rgba(0, 0, 0, .40) |
| `--pp-shadow-2` | 0 6px 20px rgba(15, 20, 26, .10) | 0 6px 20px rgba(0, 0, 0, .44) | 0 6px 20px rgba(0, 0, 0, .44) |
| `--pp-shadow-3` | 0 12px 40px rgba(15, 20, 26, .22) | 0 12px 40px rgba(0, 0, 0, .55) | 0 12px 40px rgba(0, 0, 0, .55) |
| `--pp-sp-1` | 4px | 4px | 4px |
| `--pp-sp-1h` | 6px | 6px | 6px |
| `--pp-sp-2` | 8px | 8px | 8px |
| `--pp-sp-2h` | 10px | 10px | 10px |
| `--pp-sp-3` | 12px | 12px | 12px |
| `--pp-sp-4` | 16px | 16px | 16px |
| `--pp-sp-5` | 22px | 22px | 22px |
| `--pp-fs-xs` | 10.5px | 10.5px | 10.5px |
| `--pp-fs-sm` | 12px | 12px | 12px |
| `--pp-fs-md` | 12.5px | 12.5px | 12.5px |
| `--pp-fs-lg` | 13.5px | 13.5px | 13.5px |
| `--pp-fs-xl` | 15px | 15px | 15px |
| `--pp-fs-2xl` | 24px | 24px | 24px |
| `--pp-dur-fast` | .12s | .12s | .12s |
| `--pp-dur-med` | .16s | .16s | .16s |
| `--pp-dur-slow` | .2s | .2s | .2s |

> 显式深色列与 media 深色列**逐令牌同值**：prefs.css 已有 `:root:not([data-theme="light"]) .pp-root` 与 `:root[data-theme="dark"] .pp-root` 两块，取值一致。三态自洽。

## 二、汇总

**控件类**（计入通过率与退出码）

| 状态 | 文字对 | 非文本·控件/焦点 | 控件类合计 | 未过 | 退出码 |
|---|---|---|---|---|---|
| 亮色（默认，无属性） | 25/25 | 13/13 | **38/38** | 0 | 0 |
| 深色（@media prefers-color-scheme: dark） | 29/29 | 14/14 | **43/43** | 0 | 0 |
| 深色（:root[data-theme="dark"] 显式） | 29/29 | 14/14 | **43/43** | 0 | 0 |
| **合计（浅+深）** | **54/54** | **27/27** | **81/81** | **0** | **0** |

**装饰类**（照测照列，标「豁免（1.4.11 不适用）」，不参与通过率）

| 状态 | 组数 | 其中 <3:1 | 实测区间 | 豁免 |
|---|---|---|---|---|
| 亮色（默认，无属性） | 20 | 12 | 1.15–6.33:1 | 豁免（1.4.11 不适用） |
| 深色（@media prefers-color-scheme: dark） | 21 | 12 | 1.30–9.85:1 | 豁免（1.4.11 不适用） |
| 深色（:root[data-theme="dark"] 显式） | 21 | 12 | 1.30–9.85:1 | 豁免（1.4.11 不适用） |
| **合计（浅+深）** | **41** | **24** | **1.15–9.85:1** | 豁免（1.4.11 不适用） |

> 控件类合计 **81** 对，通过 **81**，未通过 **0**。装饰类 41 组（含卡片轮廓、容器行、1px 分区线、计数徽标、焦点环的 alpha 光晕、单边下划线）照测照列，逐条理由见 0.1 与 3.x，完整证据链在 `contrast.json`。

## 三.1 逐对实测 · 亮色（默认，无属性）

### 文字（控件类）

| 前景 | 背景（已合成） | 实测 | 阈值 | 判定 | 选择器 |
|---|---|---|---|---|---|
| #ffffff | #f6f8fa | **1.06:1** | 4.5 | INFO | `.pp-root .pp-rank-preview .pp-badge-demo` |
| #8a9199 | #f6f8fa | **2.99:1** | 4.5 | N/A | `.pp-root .pp-mb-opt-soon` |
| #6a7380 | #f6f8fa | **4.51:1** | 4.5 | PASS | `.pp-root .pp-mem-time` |
| #0969da | #ddf4ff | **4.56:1** | 4.5 | PASS | `.pp-root .pp-mb-badge`、`.pp-root .pp-mb-opt-on`、`.pp-root .pp-chip-on` … 共 6 处 |
| #0969da | #ebf3fc | **4.64:1** | 4.5 | PASS | `.pp-root .pp-count-hit`、`.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active` |
| #6a7380 | #ffffff | **4.80:1** | 4.5 | PASS | `.pp-root .pp-fold-arrow`、`.pp-root .pp-input::placeholder`、`.pp-root .pp-textarea::placeholder` … 共 5 处 |
| #0969da | #f6f8fa | **4.88:1** | 4.5 | PASS | `.pp-root .pp-fold-head:hover .pp-card-title`、`.pp-root .pp-mb-compare thead th.pp-cmp-pro`、`.pp-root .pp-mb-opt:hover` |
| #0969da | #ffffff | **5.19:1** | 4.5 | PASS | `.pp-root .pp-disclose > summary`、`.pp-root .pp-link`、`.pp-root .pp-link-btn` … 共 9 处 |
| #ffffff | #0969da | **5.19:1** | 4.5 | PASS | `.pp-root .pp-btn-primary`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #5b6570 | #eef1f4 | **5.23:1** | 4.5 | PASS | `.pp-root .pp-fold-head:hover .pp-fold-arrow` |
| #b31d28 | #f2e3e6 | **5.40:1** | 4.5 | PASS | `.pp-root .pp-mb-renew-expired` |
| #5b6570 | #f6f8fa | **5.57:1** | 4.5 | PASS | `.pp-root .pp-count`、`.pp-root .pp-anchor-nav .pp-btn`、`.pp-root .pp-cat-count` … 共 18 处 |
| #7a4d00 | #ebe7dc | **5.87:1** | 4.5 | PASS | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew`、`.pp-root .pp-ai-tier-trial` |
| #5b6570 | #ffffff | **5.93:1** | 4.5 | PASS | `.pp-root .pp-search-clear`、`.pp-root .pp-cat-label`、`.pp-root .pp-empty` … 共 17 处 |
| #7a4d00 | #f3ede0 | **6.22:1** | 4.5 | PASS | `.pp-root .pp-pill-warn`、`.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` |
| #b31d28 | #f6f8fa | **6.32:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-expired` |
| #116329 | #e4f0e8 | **6.33:1** | 4.5 | PASS | `.pp-root .pp-pill-ok`、`.pp-root .pp-dlg-badge-ok` |
| #b31d28 | #ffffff | **6.72:1** | 4.5 | PASS | `.pp-root .pp-link-danger`、`.pp-root .pp-chip-x` |
| #7a4d00 | #f6f8fa | **6.83:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-warn`、`.pp-root .pp-mb-warn` |
| #ffffff | #0757b3 | **6.95:1** | 4.5 | PASS | `.pp-root .pp-btn-primary:hover:not(:disabled)`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #116329 | #ffffff | **7.39:1** | 4.5 | PASS | `.pp-root .pp-mb-compare .pp-cmp-yes` |
| #1f2328 | #e3edf7 | **13.30:1** | 4.5 | PASS | `.pp-root .pp-mb-quote` |
| #1f2328 | #eef1f4 | **13.93:1** | 4.5 | PASS | `.pp-root .pp-search-clear:hover`、`.pp-root .pp-dlg-close:hover` |
| #1f2328 | #f6f8fa | **14.84:1** | 4.5 | PASS | `.pp-root .pp-ai-tier`、`.pp-root .pp-chip`、`.pp-root .pp-ds-chip` … 共 7 处 |
| #1f2328 | #ffffff | **15.80:1** | 4.5 | PASS | `.pp-root .pp-label`、`.pp-root .pp-check`、`.pp-root .pp-input` … 共 14 处 |
| #0f141a | #f6f8fa | **17.38:1** | 4.5 | PASS | `.pp-root .pp-mb-title`、`.pp-root .pp-dev-name`、`.pp-root .pp-ch-name` … 共 5 处 |
| #0f141a | #ffffff | **18.50:1** | 4.5 | PASS | `.pp-root .pp-card-title`、`.pp-root .pp-sub-title`、`.pp-root .pp-subtitle` … 共 8 处 |

### 非文本 · 控件边界与焦点环（控件类，计入门禁）

| 颜色 | 相邻底 | 实测 | 阈值 | 范围 | 判定 | 类型 | 选择器 |
|---|---|---|---|---|---|---|---|
| #828b95 | #f6f8fa | **3.25:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-ds-chip`、`.pp-root .pp-theme-card`、`.pp-root .pp-pdf-item` … 共 4 处 |
| #828b95 | #ffffff | **3.46:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-input`、`.pp-root .pp-select`、`.pp-root .pp-textarea` … 共 6 处 |
| #6e7781 | #eef1f4 | **4.01:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-btn:hover:not(:disabled)` |
| #6e7781 | #ffffff | **4.55:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-input:hover:not(:focus)`、`.pp-root .pp-select:hover:not(:focus)`、`.pp-root .pp-color:hover` |
| #0969da | #ddf4ff | **4.56:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-mb-opt-on`、`.pp-root .pp-ds-on` |
| #0969da | #ebf3fc | **4.64:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active` |
| #0969da | #ebf3fc | **4.64:1** | 3 | 控件 | PASS | 图标 | `.pp-root .pp-card-icon` |
| #6a7380 | #ffffff | **4.80:1** | 3 | 控件 | PASS | 图标 | `.pp-root .pp-search-icon` |
| #0969da | #f6f8fa | **4.88:1** | 3 | 控件 | PASS | 焦点环 | `.pp-root .pp-fold-head:focus-visible`、`.pp-root .pp-mb-opt:focus-visible`、`.pp-root .pp-ts-chip:focus-visible` |
| #0969da | #f6f8fa | **4.88:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-mb-opt:focus-visible`、`.pp-root .pp-mb-opt:hover`、`.pp-root .pp-mb-renew:hover` … 共 5 处 |
| #0969da | #ffffff | **5.19:1** | 3 | 控件 | PASS | 焦点环 | `.pp-root .pp-disclose > summary:focus-visible`、`.pp-root .pp-input:focus`、`.pp-root .pp-select:focus` … 共 10 处 |
| #0969da | #ffffff | **5.19:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus`、`.pp-root .pp-textarea:focus` … 共 9 处 |
| #7a4d00 | #ebe7dc | **5.87:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew` |

### 非文本 · 装饰类（豁免（1.4.11 不适用），仅测量）

| 颜色 | 相邻底 | 实测 | 范围 | 判定 | 选择器 | 判定依据 |
|---|---|---|---|---|---|---|
| #cce4d3 | #e4f0e8 | 1.15:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-pill-ok` | `.pp-pill-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #e8ddc5 | #f3ede0 | 1.16:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-pill-warn` | `.pp-pill-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #d8dee4 | #f6f8fa | 1.27:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-count`、`.pp-root .pp-cat-count` … 共 21 处 | 标记层：`.pp-count` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:38） |
| #c7dbf4 | #f6f8fa | 1.32:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-fold-head:focus-visible`、`.pp-root .pp-mb-opt:focus-visible` … 共 3 处 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| #cee1f8 | #ffffff | 1.33:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus` … 共 6 处 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| #d8dee4 | #ffffff | 1.36:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-toolbar`、`.pp-root .pp-cat-label` … 共 21 处 | 标记层：`.pp-toolbar` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:30） |
| #afcdf0 | #e3edf7 | 1.38:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-mb-quote` | 标记层：`.pp-mb-quote` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:209） |
| #b5d2f4 | #ebf3fc | 1.39:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-count-hit`、`.pp-root .pp-card-icon` | `.pp-count-hit` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #aad3f6 | #ddf4ff | 1.39:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-mb-badge`、`.pp-root .pp-mem-kind` | 标记层：`.pp-mb-badge` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:132） |
| #c4dbf6 | #ffffff | 1.42:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-ch-row:hover`、`.pp-root .pp-subs-row:hover` … 共 5 处 | 脚本层：`.pp-ch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1849） |
| #c3cdd6 | #f6f8fa | 1.51:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dev-row:hover` | 脚本层：`.pp-dev-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| #c3cdd6 | #ffffff | 1.61:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-account-email` | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| #828b95 | #f6f8fa | 3.25:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-chip` | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| #cf222e | #f2e3e6 | 4.30:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-mb-renew-expired` | `.pp-mb-renew-expired` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #0969da | #e3edf7 | 4.37:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dev-row-cur` | 脚本层：`.pp-dev-row-cur` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| #0969da | #ddf4ff | 4.56:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-chip-on`、`.pp-root .pp-theme-on` … 共 4 处 | 脚本层：`.pp-chip-on` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| #0969da | #ffffff | 5.19:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-chip:hover`、`.pp-root .pp-theme-cat` | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| #7a4d00 | #ebe7dc | 5.87:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-ai-tier-trial` | `.pp-ai-tier-trial` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #7a4d00 | #f3ede0 | 6.22:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` | `.pp-dlg-badge-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #116329 | #e4f0e8 | 6.33:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dlg-badge-ok` | `.pp-dlg-badge-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |

## 三.2 逐对实测 · 深色（@media prefers-color-scheme: dark）

### 文字（控件类）

| 前景 | 背景（已合成） | 实测 | 阈值 | 判定 | 选择器 |
|---|---|---|---|---|---|
| #6d737b | #1a1e23 | **3.52:1** | 4.5 | N/A | `.pp-root .pp-mb-opt-soon` |
| #9198a1 | #2a3038 | **4.57:1** | 4.5 | PASS | `.pp-root .pp-fold-head:hover .pp-fold-arrow` |
| #ffffff | #1f6feb | **4.63:1** | 4.5 | PASS | `.pp-root .pp-btn-primary`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #3fb950 | #263d31 | **4.63:1** | 4.5 | PASS | `.pp-root .pp-pill-ok`、`.pp-root .pp-dlg-badge-ok` |
| #d29922 | #3d382a | **4.65:1** | 4.5 | PASS | `.pp-root .pp-pill-warn`、`.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` |
| #4493f8 | #21252b | **4.97:1** | 4.5 | PASS | `.pp-root .pp-disclose > summary`、`.pp-root .pp-link`、`.pp-root .pp-link-btn` … 共 8 处 |
| #8b949e | #21252b | **5.00:1** | 4.5 | PASS | `.pp-root .pp-fold-arrow`、`.pp-root .pp-input::placeholder`、`.pp-root .pp-textarea::placeholder` … 共 5 处 |
| #4493f8 | #17233a | **5.06:1** | 4.5 | PASS | `.pp-root .pp-mb-badge`、`.pp-root .pp-dlg-badge-info` |
| #d29922 | #373223 | **5.07:1** | 4.5 | PASS | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew`、`.pp-root .pp-ai-tier-trial` |
| #9198a1 | #21252b | **5.29:1** | 4.5 | PASS | `.pp-root .pp-search-clear`、`.pp-root .pp-cat-label`、`.pp-root .pp-empty` … 共 17 处 |
| #4493f8 | #1a1e23 | **5.40:1** | 4.5 | PASS | `.pp-root .pp-fold-head:hover .pp-card-title`、`.pp-root .pp-mb-opt:hover` |
| #8b949e | #1a1e23 | **5.44:1** | 4.5 | PASS | `.pp-root .pp-mem-time` |
| #ff7b72 | #392528 | **5.66:1** | 4.5 | PASS | `.pp-root .pp-mb-renew-expired` |
| #9198a1 | #1a1e23 | **5.75:1** | 4.5 | PASS | `.pp-root .pp-count`、`.pp-root .pp-anchor-nav .pp-btn`、`.pp-root .pp-cat-count` … 共 18 处 |
| #3fb950 | #21252b | **6.06:1** | 4.5 | PASS | `.pp-root .pp-mb-compare .pp-cmp-yes` |
| #ff7b72 | #21252b | **6.10:1** | 4.5 | PASS | `.pp-root .pp-link-danger`、`.pp-root .pp-chip-x` |
| #79b8ff | #253244 | **6.24:1** | 4.5 | PASS | `.pp-root .pp-count-hit`、`.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active` |
| #ffffff | #1158c7 | **6.47:1** | 4.5 | PASS | `.pp-root .pp-btn-primary:hover:not(:disabled)`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #d29922 | #1a1e23 | **6.64:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-warn`、`.pp-root .pp-mb-warn` |
| #ff7b72 | #1a1e23 | **6.64:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-expired` |
| #79b8ff | #21252b | **7.41:1** | 4.5 | PASS | `.pp-root .pp-account-email:hover` |
| #79b8ff | #17233a | **7.56:1** | 4.5 | PASS | `.pp-root .pp-mb-opt-on`、`.pp-root .pp-chip-on`、`.pp-root .pp-ds-on` … 共 4 处 |
| #79b8ff | #1a1e23 | **8.07:1** | 4.5 | PASS | `.pp-root .pp-mb-compare thead th.pp-cmp-pro` |
| #e6edf3 | #2a3038 | **11.26:1** | 4.5 | PASS | `.pp-root .pp-search-clear:hover`、`.pp-root .pp-dlg-close:hover` |
| #e6edf3 | #1f2c3d | **11.96:1** | 4.5 | PASS | `.pp-root .pp-mb-quote` |
| #e6edf3 | #21252b | **13.03:1** | 4.5 | PASS | `.pp-root .pp-label`、`.pp-root .pp-check`、`.pp-root .pp-btn` … 共 11 处 |
| #e6edf3 | #1b1f24 | **14.02:1** | 4.5 | PASS | `.pp-root .pp-input`、`.pp-root .pp-select`、`.pp-root .pp-textarea` |
| #e6edf3 | #1a1e23 | **14.17:1** | 4.5 | PASS | `.pp-root .pp-ai-tier`、`.pp-root .pp-chip`、`.pp-root .pp-ds-chip` … 共 7 处 |
| #f2f6fa | #21252b | **14.18:1** | 4.5 | PASS | `.pp-root .pp-card-title`、`.pp-root .pp-sub-title`、`.pp-root .pp-subtitle` … 共 8 处 |
| #f2f6fa | #1a1e23 | **15.42:1** | 4.5 | PASS | `.pp-root .pp-mb-title`、`.pp-root .pp-dev-name`、`.pp-root .pp-ch-name` … 共 5 处 |
| #ffffff | #1a1e23 | **16.75:1** | 4.5 | INFO | `.pp-root .pp-rank-preview .pp-badge-demo` |

### 非文本 · 控件边界与焦点环（控件类，计入门禁）

| 颜色 | 相邻底 | 实测 | 阈值 | 范围 | 判定 | 类型 | 选择器 |
|---|---|---|---|---|---|---|---|
| #6e7a86 | #21252b | **3.51:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-btn`、`.pp-root .pp-mb-opt` |
| #6e7a86 | #1b1f24 | **3.78:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-input`、`.pp-root .pp-select`、`.pp-root .pp-textarea` … 共 4 处 |
| #6e7a86 | #1a1e23 | **3.82:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-ds-chip`、`.pp-root .pp-theme-card`、`.pp-root .pp-pdf-item` … 共 4 处 |
| #4493f8 | #253244 | **4.18:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active` |
| #4493f8 | #253244 | **4.18:1** | 3 | 控件 | PASS | 图标 | `.pp-root .pp-card-icon` |
| #8d99a6 | #2a3038 | **4.59:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-btn:hover:not(:disabled)` |
| #4493f8 | #21252b | **4.97:1** | 3 | 控件 | PASS | 焦点环 | `.pp-root .pp-disclose > summary:focus-visible`、`.pp-root .pp-input:focus`、`.pp-root .pp-select:focus` … 共 10 处 |
| #4493f8 | #21252b | **4.97:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus`、`.pp-root .pp-textarea:focus` … 共 9 处 |
| #8b949e | #21252b | **5.00:1** | 3 | 控件 | PASS | 图标 | `.pp-root .pp-search-icon` |
| #4493f8 | #17233a | **5.06:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-mb-opt-on`、`.pp-root .pp-ds-on` |
| #d29922 | #373223 | **5.07:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew` |
| #8d99a6 | #21252b | **5.31:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-input:hover:not(:focus)`、`.pp-root .pp-select:hover:not(:focus)`、`.pp-root .pp-color:hover` |
| #4493f8 | #1a1e23 | **5.40:1** | 3 | 控件 | PASS | 焦点环 | `.pp-root .pp-fold-head:focus-visible`、`.pp-root .pp-mb-opt:focus-visible`、`.pp-root .pp-ts-chip:focus-visible` |
| #4493f8 | #1a1e23 | **5.40:1** | 3 | 控件 | PASS | 描边 | `.pp-root .pp-mb-opt:focus-visible`、`.pp-root .pp-mb-opt:hover`、`.pp-root .pp-mb-renew:hover` … 共 5 处 |

### 非文本 · 装饰类（豁免（1.4.11 不适用），仅测量）

| 颜色 | 相邻底 | 实测 | 范围 | 判定 | 选择器 | 判定依据 |
|---|---|---|---|---|---|---|
| #2a5136 | #263d31 | 1.30:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-pill-ok` | `.pp-pill-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #554728 | #3d382a | 1.30:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-pill-warn` | `.pp-pill-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #2b4464 | #21252b | 1.55:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus` … 共 6 处 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| #3d444d | #21252b | 1.56:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-toolbar`、`.pp-root .pp-cat-label` … 共 19 处 | 标记层：`.pp-toolbar` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:30） |
| #2e4f7a | #253244 | 1.56:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-count-hit`、`.pp-root .pp-card-icon` | `.pp-count-hit` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #263f5f | #1a1e23 | 1.56:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-fold-head:focus-visible`、`.pp-root .pp-mb-opt:focus-visible` … 共 3 处 | alpha 光晕叠在实色主环之外，不是唯一视觉指示 → 装饰 |
| #2a4b75 | #1f2c3d | 1.59:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-mb-quote` | 标记层：`.pp-mb-quote` 用在 `<div>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:209） |
| #2c4668 | #21252b | 1.60:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-ch-row:hover`、`.pp-root .pp-subs-row:hover` … 共 5 处 | 脚本层：`.pp-ch-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1849） |
| #254573 | #17233a | 1.62:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-mb-badge`、`.pp-root .pp-mem-kind` | 标记层：`.pp-mb-badge` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:132） |
| #3d444d | #1a1e23 | 1.70:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-count`、`.pp-root .pp-cat-count` … 共 21 处 | 标记层：`.pp-count` 用在 `<span>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:38） |
| #4d565f | #21252b | 2.06:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-account-email` | 单边描边 `border-bottom` 是下划线 / 分区指示条，不构成控件闭合轮廓 → 1.4.11 的「边界」不适用 |
| #4d565f | #1a1e23 | 2.24:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dev-row:hover` | 脚本层：`.pp-dev-row` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| #6e7a86 | #1a1e23 | 3.82:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-chip` | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| #f85149 | #392528 | 4.26:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-mb-renew-expired` | `.pp-mb-renew-expired` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #4493f8 | #1f2c3d | 4.56:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dev-row-cur` | 脚本层：`.pp-dev-row-cur` 由 `el("div")` 创建、该元素自身无 click 绑定（prefs-account.js:1077） |
| #3fb950 | #263d31 | 4.63:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dlg-badge-ok` | `.pp-dlg-badge-ok` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #d29922 | #3d382a | 4.65:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` | `.pp-dlg-badge-warn` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #4493f8 | #21252b | 4.97:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-chip:hover`、`.pp-root .pp-theme-cat` | 脚本层：`.pp-chip` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| #4493f8 | #17233a | 5.06:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-chip-on`、`.pp-root .pp-theme-on` … 共 4 处 | 脚本层：`.pp-chip-on` 由 `el("span")` 创建、该元素自身无 click 绑定（prefs-account.js:2080） |
| #d29922 | #373223 | 5.07:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-ai-tier-trial` | `.pp-ai-tier-trial` 在 chrome/content/prefs.xhtml 与 17 个 prefs-*.js 里都没有控件标签 / role / tabindex / click 绑定的证据（可能由模板字符串或动态 class 拼出），CSS 也无 cursor:pointer |
| #3d444d | #ffffff | 9.85:1 | 装饰 | 豁免（1.4.11 不适用） | `.pp-root .pp-mb-qr`、`.pp-root .pp-dlg-qr` | 标记层：`.pp-mb-qr` 用在 `<img>` 上，该标签不可聚焦、无 role/onclick（chrome/content/prefs.xhtml:168） |

## 三.3 逐对实测 · 深色（:root[data-theme="dark"] 显式）

> 该状态已接入：prefs.css 的 `:root[data-theme="dark"] .pp-root` 与 media 块逐令牌同值，所以计数与 3.2 完全相同，不重复整表（完整数据在 `contrast.json` 的 `groups["dark-explicit"]`）。

- 文字 29/29｜控件类非文本 14/14｜装饰类 21 组（12 组 <3:1）。

## 三·附 焦点态全量（含本轮新增 5 条）

> 焦点指示器按「层」拆开测：实色主环（`0 0 0 Npx <实色>` 或 `outline: Npx solid`）是 1.4.11 的判定对象；外扩的 alpha 光晕是附加装饰，单独列出、不决定判定。

| 选择器 | 状态 | 层 | 实测 | 阈值 | 判定 | 范围 | 本轮新增 |
|---|---|---|---|---|---|---|---|
| `.pp-fold-head:focus-visible` | 浅 | 2px box-shadow 实色 | **4.88:1** | 3 | PASS | 控件 | — |
| `.pp-fold-head:focus-visible` | 浅 | 4px box-shadow 光晕 | **1.32:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-disclose > summary:focus-visible` | 浅 | 2px outline 实色 | **5.19:1** | 3 | PASS | 控件 | — |
| `.pp-input:focus` | 浅 | 2px box-shadow 实色 | **5.19:1** | 3 | PASS | 控件 | — |
| `.pp-input:focus` | 浅 | 4px box-shadow 光晕 | **1.33:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-select:focus` | 浅 | 2px box-shadow 实色 | **5.19:1** | 3 | PASS | 控件 | — |
| `.pp-select:focus` | 浅 | 4px box-shadow 光晕 | **1.33:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-textarea:focus` | 浅 | 2px box-shadow 实色 | **5.19:1** | 3 | PASS | 控件 | — |
| `.pp-textarea:focus` | 浅 | 4px box-shadow 光晕 | **1.33:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-btn:focus-visible` | 浅 | 2px box-shadow 实色 | **5.19:1** | 3 | PASS | 控件 | — |
| `.pp-btn:focus-visible` | 浅 | 4px box-shadow 光晕 | **1.33:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-mb-opt:focus-visible` | 浅 | 2px box-shadow 实色 | **4.88:1** | 3 | PASS | 控件 | 是 |
| `.pp-mb-opt:focus-visible` | 浅 | 4px box-shadow 光晕 | **1.32:1** | 3 | 豁免（装饰层） | 装饰 | 是 |
| `.pp-ds-chip:focus-visible` | 浅 | 2px box-shadow 实色 | **5.19:1** | 3 | PASS | 控件 | 是 |
| `.pp-ds-chip:focus-visible` | 浅 | 4px box-shadow 光晕 | **1.33:1** | 3 | 豁免（装饰层） | 装饰 | 是 |
| `.pp-chip-pick:focus-visible` | 浅 | 2px box-shadow 实色 | **5.19:1** | 3 | PASS | 控件 | 是 |
| `.pp-chip-pick:focus-visible` | 浅 | 4px box-shadow 光晕 | **1.33:1** | 3 | 豁免（装饰层） | 装饰 | 是 |
| `.pp-chip-x:focus-visible` | 浅 | 2px outline 实色 | **5.19:1** | 3 | PASS | 控件 | 是 |
| `.pp-link-btn:focus-visible` | 浅 | 2px outline 实色 | **5.19:1** | 3 | PASS | 控件 | — |
| `.pp-ts-chip:focus-visible` | 浅 | 2px box-shadow 实色 | **4.88:1** | 3 | PASS | 控件 | — |
| `.pp-ts-chip:focus-visible` | 浅 | 4px box-shadow 光晕 | **1.32:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-dlg-close:focus-visible` | 浅 | 2px outline 实色 | **5.19:1** | 3 | PASS | 控件 | 是 |
| `.pp-fold-head:focus-visible` | 深 | 2px box-shadow 实色 | **5.40:1** | 3 | PASS | 控件 | — |
| `.pp-fold-head:focus-visible` | 深 | 4px box-shadow 光晕 | **1.56:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-disclose > summary:focus-visible` | 深 | 2px outline 实色 | **4.97:1** | 3 | PASS | 控件 | — |
| `.pp-input:focus` | 深 | 2px box-shadow 实色 | **4.97:1** | 3 | PASS | 控件 | — |
| `.pp-input:focus` | 深 | 4px box-shadow 光晕 | **1.55:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-select:focus` | 深 | 2px box-shadow 实色 | **4.97:1** | 3 | PASS | 控件 | — |
| `.pp-select:focus` | 深 | 4px box-shadow 光晕 | **1.55:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-textarea:focus` | 深 | 2px box-shadow 实色 | **4.97:1** | 3 | PASS | 控件 | — |
| `.pp-textarea:focus` | 深 | 4px box-shadow 光晕 | **1.55:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-btn:focus-visible` | 深 | 2px box-shadow 实色 | **4.97:1** | 3 | PASS | 控件 | — |
| `.pp-btn:focus-visible` | 深 | 4px box-shadow 光晕 | **1.55:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-mb-opt:focus-visible` | 深 | 2px box-shadow 实色 | **5.40:1** | 3 | PASS | 控件 | 是 |
| `.pp-mb-opt:focus-visible` | 深 | 4px box-shadow 光晕 | **1.56:1** | 3 | 豁免（装饰层） | 装饰 | 是 |
| `.pp-ds-chip:focus-visible` | 深 | 2px box-shadow 实色 | **4.97:1** | 3 | PASS | 控件 | 是 |
| `.pp-ds-chip:focus-visible` | 深 | 4px box-shadow 光晕 | **1.55:1** | 3 | 豁免（装饰层） | 装饰 | 是 |
| `.pp-chip-pick:focus-visible` | 深 | 2px box-shadow 实色 | **4.97:1** | 3 | PASS | 控件 | 是 |
| `.pp-chip-pick:focus-visible` | 深 | 4px box-shadow 光晕 | **1.55:1** | 3 | 豁免（装饰层） | 装饰 | 是 |
| `.pp-chip-x:focus-visible` | 深 | 2px outline 实色 | **4.97:1** | 3 | PASS | 控件 | 是 |
| `.pp-link-btn:focus-visible` | 深 | 2px outline 实色 | **4.97:1** | 3 | PASS | 控件 | — |
| `.pp-ts-chip:focus-visible` | 深 | 2px box-shadow 实色 | **5.40:1** | 3 | PASS | 控件 | — |
| `.pp-ts-chip:focus-visible` | 深 | 4px box-shadow 光晕 | **1.56:1** | 3 | 豁免（装饰层） | 装饰 | — |
| `.pp-dlg-close:focus-visible` | 深 | 2px outline 实色 | **4.97:1** | 3 | PASS | 控件 | 是 |

> 共 **13** 个焦点选择器、**26** 个计入门禁的实色层，最低 **4.88:1**（`.pp-fold-head:focus-visible` · 浅），全部 ≥3。本轮新增的 5 条（`.pp-mb-opt` / `.pp-ds-chip` / `.pp-chip-pick` 双层环，`.pp-chip-x` / `.pp-dlg-close` 单层 outline）实测见标「是」的行。

## 四、裁决书 10 对失败组合逐条复测（按选择器定位）

| # | 位置 | 状态 | 原值 | 现值（真实容器） | 同基色复算 | 判定 |
|---|---|---|---|---|---|---|
| R1 | .pp-btn-primary 深色主按钮 | 深 | 3.10:1 | **4.63:1** | 4.63:1 | PASS |
| R2 | .pp-btn-primary:hover 深色 hover 底 | 深 | 3.75:1 | **6.47:1** | 6.47:1 | PASS |
| R3 | .pp-pill-ok（浅） | 浅 | 4.34:1 | **6.33:1** | 6.33:1 | PASS |
| R4 | .pp-dlg-badge-ok（浅） | 浅 | 4.34:1 | **6.33:1** | 6.33:1 | PASS |
| R5 | .pp-pill-warn（浅，12px 小字） | 浅 | 4.17:1 | **6.22:1** | 6.22:1 | PASS |
| R6 | .pp-mb-renew（浅，到期提醒横幅） | 浅 | 4.17:1 | **5.87:1** | 6.22:1 | PASS |
| R7 | .pp-ai-tier-trial（浅，试用额度说明） | 浅 | 4.17:1 | **5.87:1** | 6.22:1 | PASS |
| R8 | .pp-dlg-tail（浅，付款弹窗尾注） | 浅 | 4.17:1 | **6.22:1** | 6.22:1 | PASS |
| R9 | .pp-count-hit（深，搜索命中计数） | 深 | 4.19:1 | **6.24:1** | 6.24:1 | PASS |
| R10 | .pp-anchor-active（深，当前分类 chip） | 深 | 4.19:1 | **6.24:1** | 6.24:1 | PASS |
| R11 | .pp-dev-row-cur（深，当前设备行） | 深 | 4.19:1（裁决书按 accent 文字计） | **不设 color（见补充）** | — | PASS |
| R12 | .pp-mb-renew-expired（深） | 深 | 3.92:1 | **5.66:1** | 5.20:1 | PASS |
| N1 | 输入框描边（浅） | 浅 | 1.36:1 | **3.46:1** | — | PASS |
| N2 | 输入框描边（深） | 深 | 1.56:1（裁决书按卡片面测） | **3.78:1** | — | PASS |
| N3 | 卡片描边（浅） | 浅 | 1.36:1 | **1.36:1** | — | **FAIL** |
| N4 | 卡片描边（深） | 深 | 1.56:1 | **1.56:1** | — | **FAIL** |
| N5 | 焦点环合成（浅） | 浅 | ≈1.33:1 | **1.33:1 / 5.19:1** | — | PASS |
| N6 | 焦点环合成（深） | 深 | ≈1.55:1 | **1.55:1 / 1.56:1 / 4.97:1** | — | PASS |

> 「同基色复算」= 把背景 alpha 层叠在**原裁决假设的基色**上重算，用于隔离「改色」与「换底」两个变量，与原值可直接对照。

### 4.1 逐条明细

**R1 · .pp-btn-primary 深色主按钮**（深色 media）

- 原值：3.10:1（前景 `#ffffff` / 背景 `#4493f8`）
- 现值：`.pp-root .pp-btn-primary` → #ffffff on #1f6feb = **4.63:1**（阈值 4.5 → PASS）
- 同基色复算：#ffffff on #1f6feb = **4.63:1**
- 结论：**已合规（原失败已修复）**

**R2 · .pp-btn-primary:hover 深色 hover 底**（深色 media）

- 原值：3.75:1（前景 `#ffffff` / 背景 `#2f81f7`）
- 现值：`.pp-root .pp-btn-primary:hover:not(:disabled)` → #ffffff on #1158c7 = **6.47:1**（阈值 4.5 → PASS）
- 同基色复算：#ffffff on #1158c7 = **6.47:1**
- 结论：**已合规（原失败已修复）**

**R3 · .pp-pill-ok（浅）**（浅色）

- 原值：4.34:1（前景 `#1a7f37` / 背景 `#e4f0e8（合成）`）
- 现值：`.pp-root .pp-pill-ok` → #116329 on #e4f0e8 = **6.33:1**（阈值 4.5 → PASS）
- 同基色复算：#116329 on #e4f0e8 = **6.33:1**
- 结论：**已合规（原失败已修复）**

**R4 · .pp-dlg-badge-ok（浅）**（浅色）

- 原值：4.34:1（前景 `#1a7f37` / 背景 `#e4f0e8（合成）`）
- 现值：`.pp-root .pp-dlg-badge-ok` → #116329 on #e4f0e8 = **6.33:1**（阈值 4.5 → PASS）
- 同基色复算：#116329 on #e4f0e8 = **6.33:1**
- 结论：**已合规（原失败已修复）**

**R5 · .pp-pill-warn（浅，12px 小字）**（浅色）

- 原值：4.17:1（前景 `#9a6700` / 背景 `#f3ede0（合成）`）
- 现值：`.pp-root .pp-pill-warn` → #7a4d00 on #f3ede0 = **6.22:1**（阈值 4.5 → PASS）
- 同基色复算：#7a4d00 on #f3ede0 = **6.22:1**
- 结论：**已合规（原失败已修复）**

**R6 · .pp-mb-renew（浅，到期提醒横幅）**（浅色）

- 原值：4.17:1（前景 `#9a6700` / 背景 `#f3ede0（合成）`）
- 现值：`.pp-root .pp-mb-renew` → #7a4d00 on #ebe7dc = **5.87:1**（阈值 4.5 → PASS）
- 现值：`.pp-root button.pp-mb-renew` → #7a4d00 on #ebe7dc = **5.87:1**（阈值 4.5 → PASS）
- 同基色复算：#7a4d00 on #f3ede0 = **6.22:1**
- 说明：该横幅实际嵌在 .pp-mb（surface-2 #f6f8fa）里，合成底比原裁决假设的白底更暗，故真实值略低于同基色复算值。
- 结论：**已合规（原失败已修复）**

**R7 · .pp-ai-tier-trial（浅，试用额度说明）**（浅色）

- 原值：4.17:1（前景 `#9a6700` / 背景 `#f3ede0（合成）`）
- 现值：`.pp-root .pp-ai-tier-trial` → #7a4d00 on #ebe7dc = **5.87:1**（阈值 4.5 → PASS）
- 同基色复算：#7a4d00 on #f3ede0 = **6.22:1**
- 说明：外层 .pp-ai-tier 自身是 surface-2 底，合成基色按 surface-2 计。
- 结论：**已合规（原失败已修复）**

**R8 · .pp-dlg-tail（浅，付款弹窗尾注）**（浅色）

- 原值：4.17:1（前景 `#9a6700` / 背景 `#f3ede0（合成）`）
- 现值：`.pp-root .pp-dlg-tail` → #7a4d00 on #f3ede0 = **6.22:1**（阈值 4.5 → PASS）
- 同基色复算：#7a4d00 on #f3ede0 = **6.22:1**
- 结论：**已合规（原失败已修复）**

**R9 · .pp-count-hit（深，搜索命中计数）**（深色 media）

- 原值：4.19:1（前景 `#4493f8` / 背景 `#253244（合成）`）
- 现值：`.pp-root .pp-count-hit` → #79b8ff on #253244 = **6.24:1**（阈值 4.5 → PASS）
- 同基色复算：#79b8ff on #253244 = **6.24:1**
- 结论：**已合规（原失败已修复）**

**R10 · .pp-anchor-active（深，当前分类 chip）**（深色 media）

- 原值：4.19:1（前景 `#4493f8` / 背景 `#253244（合成）`）
- 现值：`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active` → #79b8ff on #253244 = **6.24:1**（阈值 4.5 → PASS）
- 同基色复算：#79b8ff on #253244 = **6.24:1**
- 结论：**已合规（原失败已修复）**

**R11 · .pp-dev-row-cur（深，当前设备行）**（深色 media）

- 原值：4.19:1（裁决书按 accent 文字计）（前景 `#4493f8` / 背景 `#253244（合成）`）
- 现值：`.pp-root .pp-dev-row-cur` 规则仍在，但该规则只声明 border-color / background，不设文字色（行内文字由子元素决定，见下方补充测项）。
- 补充：`.pp-root .pp-dev-name（行内实际文字，落在 .pp-dev-row-cur 的 accent-soft 底 #1f2c3d 上）` → #f2f6fa on #1f2c3d = **13.02:1**（PASS）
- 补充：`.pp-root .pp-dev-meta（行内实际文字，落在 .pp-dev-row-cur 的 accent-soft 底 #1f2c3d 上）` → #9198a1 on #1f2c3d = **4.85:1**（PASS）
- 说明：当前源码里 .pp-dev-row-cur 只改 border-color / background，不设 color：行内文字仍是 .pp-dev-name(text-strong) / .pp-dev-meta(muted)。故「accent 文字 4.19」这对已不存在，改为测行内实际文字 + accent 描边两项。
- 结论：**已合规（原失败已修复）**

**R12 · .pp-mb-renew-expired（深）**（深色 media）

- 原值：3.92:1（前景 `#f85149` / 背景 `#3f2b2f（合成）`）
- 现值：`.pp-root .pp-mb-renew-expired` → #ff7b72 on #392528 = **5.66:1**（阈值 4.5 → PASS）
- 同基色复算：#ff7b72 on #3f2b2f = **5.20:1**
- 结论：**已合规（原失败已修复）**

**N1 · 输入框描边（浅）**（浅色）

- 原值：1.36:1（前景 `#d8dee4` / 背景 `#ffffff`）
- 现值：`.pp-root .pp-input` → #828b95 on #ffffff = **3.46:1**（阈值 3 → PASS）
- 现值：`.pp-root .pp-select` → #828b95 on #ffffff = **3.46:1**（阈值 3 → PASS）
- 结论：**已合规（原失败已修复）**

**N2 · 输入框描边（深）**（深色 media）

- 原值：1.56:1（裁决书按卡片面测）（前景 `#3d444d` / 背景 `#21252b`）
- 现值：`.pp-root .pp-input` → #6e7a86 on #1b1f24 = **3.78:1**（阈值 3 → PASS）
- 现值：`.pp-root .pp-select` → #6e7a86 on #1b1f24 = **3.78:1**（阈值 3 → PASS）
- 说明：输入框自身底色是 --pp-field #1b1f24，比卡片面更暗，故真实值略高于原裁决的 1.56。
- 结论：**已合规（原失败已修复）**

**N3 · 卡片描边（浅）**（浅色）

- 原值：1.36:1（前景 `#d8dee4` / 背景 `#ffffff`）
- 现值：`.pp-root .pp-card` → #d8dee4 on #ffffff = **1.36:1**（阈值 3 → FAIL，装饰性不计入判定）
- 结论：**仍然不达标**

**N4 · 卡片描边（深）**（深色 media）

- 原值：1.56:1（前景 `#3d444d` / 背景 `#21252b`）
- 现值：`.pp-root .pp-card` → #3d444d on #21252b = **1.56:1**（阈值 3 → FAIL，装饰性不计入判定）
- 结论：**仍然不达标**

**N5 · 焦点环合成（浅）**（浅色）

- 原值：≈1.33:1（前景 `rgba(9,105,218,.20)` / 背景 `#ffffff`）
- 现值：`--pp-focus-ring @0.20 合成于 --pp-surface` → #cee1f8 on #ffffff = **1.33:1**（阈值 3 → FAIL，装饰性不计入判定）
- 现值：`--pp-focus-ring @0.20 合成于 --pp-field` → #cee1f8 on #ffffff = **1.33:1**（阈值 3 → FAIL，装饰性不计入判定）
- 现值：`0.72.2 新增 2px 实色主环 var(--pp-accent)` → #0969da on #ffffff = **5.19:1**（阈值 3 → PASS）
- 结论：**已合规（原失败已修复）**

**N6 · 焦点环合成（深）**（深色 media）

- 原值：≈1.55:1（前景 `rgba(68,147,248,.28)` / 背景 `#21252b`）
- 现值：`--pp-focus-ring @0.28 合成于 --pp-surface` → #2b4464 on #21252b = **1.55:1**（阈值 3 → FAIL，装饰性不计入判定）
- 现值：`--pp-focus-ring @0.28 合成于 --pp-field` → #263f5f on #1b1f24 = **1.56:1**（阈值 3 → FAIL，装饰性不计入判定）
- 现值：`0.72.2 新增 2px 实色主环 var(--pp-accent)` → #4493f8 on #21252b = **4.97:1**（阈值 3 → PASS）
- 结论：**已合规（原失败已修复）**

## 五、仍然 FAIL 的项

**控件类零 FAIL。** 1.4.11 计入的描边/焦点环全部 ≥3:1，文字对全部 ≥4.5:1。

- 控件类零 FAIL → 门禁通过。门禁只按「面板可达」的浅色 + media 深色计；显式深色列与 media 深色逐令牌同值，仅作对照。
- 另有 **41 组装饰类描边**（其中 **24 组 <3:1**，实测区间 1.15–9.85:1）按 1.4.11 适用范围判为装饰，**不计入通过率、不影响退出码**，但数值全部保留在「装饰类」表里供评审查阅。

## 六、静态不可判 / 边界

- 1.4.11 适用范围判定基于静态证据（xhtml 标记 + prefs-*.js 构造/绑定 + CSS 标签与 role），不是运行时 DOM：若某元素的可点性由运行时动态绑定且不在扫描到的 `addEventListener("click")` 形式内，可能被判成装饰。逐条证据（文件:行号）写在 `scope.decorDetail` 与 `pairs[].scopeEvidence` 里，可直接复核。
- 「单边描边」判定：只有 `border` / `border-color` 这种整圈描边算控件边界；`border-bottom` / `border-left` 等单边是下划线或分区指示条。`.pp-account-email`（`<button class="pp-link-btn pp-account-email">`，`border-bottom: 1px dashed var(--pp-border-strong)`，浅 **1.61:1** / 深 **2.06:1**）属此类。**0.72.3 的变化**：该按钮文字已由 `--pp-muted` 改为 `--pp-accent` 链接色（承担控件识别，文字对实测达标），虚线自此是纯装饰性附加提示，与 `text-decoration: underline` 同类，不属 1.4.11 的「UI 组件视觉信息」。修复前它曾是唯一可点信号（0.72.2 裁决书 Major 项），修复后不存在口径分歧：无论虚线怎么判，控件识别都有达标文字兜底。
- 层叠空操作（静态 CSS 的已知盲区）：`.pp-chip-pick` 的 `border-color`（prefs.css:683）被该元素内联 `style="…border:0…"`（prefs-account.js:2086 起）压制，边框宽度为 0，**像素上不产生描边**。本报告按 CSS 声明照录该行（浅 5.19 / 深 4.97），它与同选择器的焦点环落在同一组，不改变任何判定；知道这一点即可，不必按它去改颜色。
- 背景带 alpha 时，合成基色由 BASE_MAP（脚本第 4 节）按「最近祖先面令牌」显式声明，并已把基色打进表格；静态 CSS 无法证明真实 DOM 嵌套，若实际嵌套不同，该行需按实际底色重算。prefs.css 中 --pp-bg 与 --pp-surface 两态同值，面板级歧义零影响。
- 由 prefs-*.js 运行时写入的内联色（.pp-badge-demo 的徽章底色等）静态不可判，已标 INFO 且不计入通过率。
- 渐变底（.pp-avatar / .pp-mb-badge-pro）取渐变两端中较差的一对入表，是保守下界。
- disabled 控件与「即将上线」占位项按 WCAG 1.4.3 豁免，计 N/A，不进通过率。
- 显式深色已由 :root[data-theme="dark"] .pp-root 覆盖（与 media 块同值）；该态断言基于「系统亮色 + 显式深色」的层叠推导。
- 焦点指示器同时扫 box-shadow 环与 outline（.pp-link-btn / .pp-disclose > summary 走 outline 2px；只看 box-shadow 会误判为「无焦点环」——gate-render 实测确认）。焦点过渡有 .12s transition，本脚本读的是声明值而非运行时计算值，不受过渡起点影响。
- color-scheme 已声明：`light`（prefs.css:22 .pp-root）、`dark`（prefs.css:103 :root:not([data-theme="light"]) .pp-root @media）、`dark`（prefs.css:150 :root[data-theme="dark"] .pp-root）。原生 checkbox / select 弹层 / 滚动条按对应模式绘制；gate-render 4× 截图里的「暗色未勾选 checkbox 纯白方块」由两处 `dark` 关闭。
- 主题块一致性（机器核对，非眼看）：prefs.css 与 ui-tokens.css 各有一对「media 深色块 / 显式深色块」，脚本按变量名集合与展开后取值逐条比对，差集与取值差异写在 `themeBlocks` 里。这是唯一会「改一处忘一处」的漂移点。
- `color-scheme` 只影响 UA 原生控件（checkbox / select 弹层 / 滚动条）的绘制模式，不产生对比度对，故不进通过率；其声明位置与取值由 `nativeControls.blocks` 逐块列出。
- 原生控件（checkbox / select 弹层 / 滚动条）的外观由 UA 的 color-scheme 决定，不产生 CSS 对比度对，也不在本脚本的测量范围内；1.4.11 对「外观由用户代理决定且未被作者修改」的组件本身即豁免。所以未勾选 checkbox 的描边强弱属于视觉观感问题，不是门禁项——若要量化只能像素采样（`getComputedStyle` 拿不到 UA 自绘边框）。静态声明扫描 + gate-render 注入复核（白块 → 深底中灰，`docs/audit/0.72.2/zoom/inject-dark-cb-off.png`）两者结论一致。
- opacity < 1 的元素（如 .pp-mb-opt-soon）按 opacity 混合后计有效对比度，并标豁免。
- 表格里的合成底色是四舍五入到 8 位的 hex，内部按浮点 RGB 计算；用显示值手算可能差 ±0.01（例如 #cf222e on #f2e3e6 内部 4.30，用四舍五入后的 hex 手算会得 4.31）。
- 公式自检：#000000 on #ffffff = 21.00、#767676 on #ffffff = 4.54（WCAG AA 边界经典值），与本脚本输出一致。

