# 设置面板对比度门禁实测（0.72.2 复审批次）

> 生成：`node scripts/audit/contrast-audit.js`｜口径：WCAG 2.x 相对亮度，sRGB 线性化，alpha 先合成再比。
> 输入：`chrome/content/ui-tokens.css`（209 行，sha256:b7091cd3f999，mtime 2026-10-21T18:16:44.834Z）、`chrome/content/prefs.css`（1484 行，sha256:d81eacfc744d，mtime 2026-10-21T18:14:06.697Z）。只读，未改动任何产品文件。
> 阈值：普通文本 4.5｜≥18.66px 或 ≥14px 且 bold 3.0｜非文本（描边/焦点环/图标）3.0。
> **计数粒度**：同一「前景 × 背景」组合的多个选择器合并为一「对」（与裁决书 43 对同粒度）。

## 零、结论（先看这里）

- 门禁计入 **90 对**（文字 53 + 非文本控件/焦点 37），通过 **82**，未过 **8** → 退出码 1。
- 文字：**53/53** 通过 —— 含裁决书点名的 5 组及其同批颜色的残留位，全部达标。
- 非文本：**29/37** 通过。剩余 8 组描边 <3:1，涉及令牌 `--pp-border`、`--pp-accent-line`、`--pp-border-strong`，其中 2 组落在可交互元素上。焦点环为「2px 实色 + 4px alpha 光晕」双层，主环达标。
- 裁决书 10 对回归（拆成 18 条测项，按选择器逐条定位）：文字侧 **12/12 PASS**；非文本 6 条中 **2 条仍 FAIL**（N3 / N4），焦点环 2 条 PASS。
- 主题：显式 `data-theme="dark"` 已接入（prefs.css 有 `:root[data-theme="dark"] .pp-root`，与 media 块同值），三态数值自洽。
- 原生控件：两份 CSS 都**没有 `color-scheme` 声明** → 暗色下原生 checkbox / select 弹层 / 滚动条仍按浅色渲染（gate-render 增强制 4× 截图实证：未勾选 checkbox 是纯白 13×13 方块）。这不是「对比度不足」而是「对比度反向过剩 + 勾选态可辨识性下降」，修法是在暗色块里加一行 `color-scheme: dark`。

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

| 状态 | 文字对 | 非文本·控件/焦点（计入） | 装饰性（仅测量，不计入） | 豁免 | 退出码 |
|---|---|---|---|---|---|
| 亮色（默认，无属性） | **25/25** | **14/18** | 16 对中 11 对 <3:1 | 1 | 1 |
| 深色（@media prefers-color-scheme: dark） | **28/28** | **15/19** | 17 对中 11 对 <3:1 | 1 | 1 |
| 深色（:root[data-theme="dark"] 显式） | **28/28** | **15/19** | 17 对中 11 对 <3:1 | 1 | 1 |
| **合计（浅+深）** | **53/53** | **29/37** | 33 对中 22 对 <3:1 | 2 | 1 |

> 门禁计入的「文字 + 控件/焦点」共 **90** 对，通过 **82**，未通过 **8**。装饰性分隔线（1px 的 --pp-border 分区线、卡片轮廓）照测照列：WCAG 1.4.11 只约束 UI 组件的视觉信息与图形对象，它们不参与通过率与退出码。

## 三.1 逐对实测 · 亮色（默认，无属性）

### 文字

| 前景 | 背景（已合成） | 实测 | 阈值 | 判定 | 选择器 |
|---|---|---|---|---|---|
| #ffffff | #f6f8fa | **1.06:1** | 4.5 | INFO | `.pp-root .pp-rank-preview .pp-badge-demo` |
| #8a9199 | #f6f8fa | **2.99:1** | 4.5 | N/A | `.pp-root .pp-mb-opt-soon` |
| #6a7380 | #f6f8fa | **4.51:1** | 4.5 | PASS | `.pp-root .pp-mem-time` |
| #0969da | #ddf4ff | **4.56:1** | 4.5 | PASS | `.pp-root .pp-mb-opt-on`、`.pp-root .pp-chip-on`、`.pp-root .pp-mb-badge` … 共 6 处 |
| #0969da | #ebf3fc | **4.64:1** | 4.5 | PASS | `.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active`、`.pp-root .pp-count-hit` |
| #6a7380 | #ffffff | **4.80:1** | 4.5 | PASS | `.pp-root .pp-input::placeholder`、`.pp-root .pp-textarea::placeholder`、`.pp-root .pp-fold-arrow` … 共 5 处 |
| #0969da | #f6f8fa | **4.88:1** | 4.5 | PASS | `.pp-root .pp-mb-opt:hover`、`.pp-root .pp-fold-head:hover .pp-card-title`、`.pp-root .pp-mb-compare thead th.pp-cmp-pro` |
| #0969da | #ffffff | **5.19:1** | 4.5 | PASS | `.pp-root .pp-chip:hover`、`.pp-root .pp-ds-chip:hover`、`.pp-root .pp-ts-chip:hover:not(:disabled)` … 共 8 处 |
| #ffffff | #0969da | **5.19:1** | 4.5 | PASS | `.pp-root .pp-btn-primary`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #5b6570 | #eef1f4 | **5.23:1** | 4.5 | PASS | `.pp-root .pp-fold-head:hover .pp-fold-arrow` |
| #b31d28 | #f2e3e6 | **5.40:1** | 4.5 | PASS | `.pp-root .pp-mb-renew-expired` |
| #5b6570 | #f6f8fa | **5.57:1** | 4.5 | PASS | `.pp-root .pp-anchor-nav .pp-btn`、`.pp-root .pp-count`、`.pp-root .pp-cat-count` … 共 18 处 |
| #7a4d00 | #ebe7dc | **5.87:1** | 4.5 | PASS | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew`、`.pp-root .pp-ai-tier-trial` |
| #5b6570 | #ffffff | **5.93:1** | 4.5 | PASS | `.pp-root .pp-search-clear`、`.pp-root .pp-cat-label`、`.pp-root .pp-empty` … 共 18 处 |
| #7a4d00 | #f3ede0 | **6.22:1** | 4.5 | PASS | `.pp-root .pp-pill-warn`、`.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` |
| #b31d28 | #f6f8fa | **6.32:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-expired` |
| #116329 | #e4f0e8 | **6.33:1** | 4.5 | PASS | `.pp-root .pp-pill-ok`、`.pp-root .pp-dlg-badge-ok` |
| #b31d28 | #ffffff | **6.72:1** | 4.5 | PASS | `.pp-root .pp-chip-x`、`.pp-root .pp-link-danger` |
| #7a4d00 | #f6f8fa | **6.83:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-warn`、`.pp-root .pp-mb-warn` |
| #ffffff | #0757b3 | **6.95:1** | 4.5 | PASS | `.pp-root .pp-btn-primary:hover:not(:disabled)`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #116329 | #ffffff | **7.39:1** | 4.5 | PASS | `.pp-root .pp-mb-compare .pp-cmp-yes` |
| #1f2328 | #e3edf7 | **13.30:1** | 4.5 | PASS | `.pp-root .pp-mb-quote` |
| #1f2328 | #eef1f4 | **13.93:1** | 4.5 | PASS | `.pp-root .pp-search-clear:hover`、`.pp-root .pp-dlg-close:hover` |
| #1f2328 | #f6f8fa | **14.84:1** | 4.5 | PASS | `.pp-root .pp-chip`、`.pp-root .pp-ds-chip`、`.pp-root .pp-pdf-item` … 共 7 处 |
| #1f2328 | #ffffff | **15.80:1** | 4.5 | PASS | `.pp-root .pp-input`、`.pp-root .pp-select`、`.pp-root .pp-textarea` … 共 14 处 |
| #0f141a | #f6f8fa | **17.38:1** | 4.5 | PASS | `.pp-root .pp-mb-title`、`.pp-root .pp-dev-name`、`.pp-root .pp-ch-name` … 共 5 处 |
| #0f141a | #ffffff | **18.50:1** | 4.5 | PASS | `.pp-root .pp-card-title`、`.pp-root .pp-sub-title`、`.pp-root .pp-subtitle` … 共 8 处 |

### 非文本 · 控件边界与焦点环（计入门禁）

| 颜色 | 相邻底 | 实测 | 阈值 | 判定 | 类型 | 选择器 |
|---|---|---|---|---|---|---|
| #d8dee4 | #f6f8fa | **1.27:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-ch-row`、`.pp-root .pp-chip`、`.pp-root .pp-ds-chip` … 共 6 处 |
| #d8dee4 | #ffffff | **1.36:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-dev-row` |
| #c4dbf6 | #ffffff | **1.42:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-ch-row:hover` |
| #c3cdd6 | #f6f8fa | **1.51:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-dev-row:hover` |
| #828b95 | #ffffff | **3.46:1** | 3 | PASS | 描边 | `.pp-root .pp-input`、`.pp-root .pp-select`、`.pp-root .pp-textarea` … 共 6 处 |
| #6e7781 | #eef1f4 | **4.01:1** | 3 | PASS | 描边 | `.pp-root .pp-btn:hover:not(:disabled)` |
| #cf222e | #f2e3e6 | **4.30:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-renew-expired` |
| #0969da | #e3edf7 | **4.37:1** | 3 | PASS | 描边 | `.pp-root .pp-dev-row-cur` |
| #6e7781 | #ffffff | **4.55:1** | 3 | PASS | 描边 | `.pp-root .pp-input:hover:not(:focus)`、`.pp-root .pp-select:hover:not(:focus)`、`.pp-root .pp-color:hover` |
| #0969da | #ddf4ff | **4.56:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-opt-on`、`.pp-root .pp-chip-on` |
| #0969da | #ebf3fc | **4.64:1** | 3 | PASS | 描边 | `.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active` |
| #0969da | #ebf3fc | **4.64:1** | 3 | PASS | 图标 | `.pp-root .pp-card-icon` |
| #6a7380 | #ffffff | **4.80:1** | 3 | PASS | 图标 | `.pp-root .pp-search-icon` |
| #0969da | #f6f8fa | **4.88:1** | 3 | PASS | 焦点环 | `.pp-root .pp-ts-chip:focus-visible`、`.pp-root .pp-fold-head:focus-visible` |
| #0969da | #f6f8fa | **4.88:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-opt:hover`、`.pp-root .pp-mb-renew:hover`、`.pp-root .pp-theme-card:hover` … 共 4 处 |
| #0969da | #ffffff | **5.19:1** | 3 | PASS | 焦点环 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus`、`.pp-root .pp-textarea:focus` … 共 6 处 |
| #0969da | #ffffff | **5.19:1** | 3 | PASS | 描边 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus`、`.pp-root .pp-textarea:focus` … 共 8 处 |
| #7a4d00 | #ebe7dc | **5.87:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew` |

### 非文本 · 装饰性分隔线（仅测量，不计入）

| 颜色 | 相邻底 | 实测 | 选择器 |
|---|---|---|---|
| #cce4d3 | #e4f0e8 | 1.15:1 | `.pp-root .pp-pill-ok` |
| #e8ddc5 | #f3ede0 | 1.16:1 | `.pp-root .pp-pill-warn` |
| #d8dee4 | #f6f8fa | 1.27:1 | `.pp-root .pp-count`、`.pp-root .pp-cat-count` … 共 20 处 |
| #c7dbf4 | #f6f8fa | 1.32:1 | `.pp-root .pp-ts-chip:focus-visible`、`.pp-root .pp-fold-head:focus-visible` |
| #cee1f8 | #ffffff | 1.33:1 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus` … 共 4 处 |
| #d8dee4 | #ffffff | 1.36:1 | `.pp-root .pp-toolbar`、`.pp-root .pp-cat-label` … 共 20 处 |
| #afcdf0 | #e3edf7 | 1.38:1 | `.pp-root .pp-mb-quote` |
| #b5d2f4 | #ebf3fc | 1.39:1 | `.pp-root .pp-count-hit`、`.pp-root .pp-card-icon` |
| #aad3f6 | #ddf4ff | 1.39:1 | `.pp-root .pp-mb-badge`、`.pp-root .pp-mem-kind` |
| #c4dbf6 | #ffffff | 1.42:1 | `.pp-root .pp-subs-row:hover`、`.pp-root .pp-sch-row:hover` … 共 4 处 |
| #c3cdd6 | #ffffff | 1.61:1 | `.pp-root .pp-account-email` |
| #0969da | #ddf4ff | 4.56:1 | `.pp-root .pp-ds-on`、`.pp-root .pp-theme-on` … 共 4 处 |
| #0969da | #ffffff | 5.19:1 | `.pp-root .pp-theme-cat` |
| #7a4d00 | #ebe7dc | 5.87:1 | `.pp-root .pp-ai-tier-trial` |
| #7a4d00 | #f3ede0 | 6.22:1 | `.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` |
| #116329 | #e4f0e8 | 6.33:1 | `.pp-root .pp-dlg-badge-ok` |

## 三.2 逐对实测 · 深色（@media prefers-color-scheme: dark）

### 文字

| 前景 | 背景（已合成） | 实测 | 阈值 | 判定 | 选择器 |
|---|---|---|---|---|---|
| #6d737b | #1a1e23 | **3.52:1** | 4.5 | N/A | `.pp-root .pp-mb-opt-soon` |
| #9198a1 | #2a3038 | **4.57:1** | 4.5 | PASS | `.pp-root .pp-fold-head:hover .pp-fold-arrow` |
| #ffffff | #1f6feb | **4.63:1** | 4.5 | PASS | `.pp-root .pp-btn-primary`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #3fb950 | #263d31 | **4.63:1** | 4.5 | PASS | `.pp-root .pp-pill-ok`、`.pp-root .pp-dlg-badge-ok` |
| #d29922 | #3d382a | **4.65:1** | 4.5 | PASS | `.pp-root .pp-pill-warn`、`.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` |
| #4493f8 | #21252b | **4.97:1** | 4.5 | PASS | `.pp-root .pp-chip:hover`、`.pp-root .pp-ds-chip:hover`、`.pp-root .pp-ts-chip:hover:not(:disabled)` … 共 8 处 |
| #8b949e | #21252b | **5.00:1** | 4.5 | PASS | `.pp-root .pp-input::placeholder`、`.pp-root .pp-textarea::placeholder`、`.pp-root .pp-fold-arrow` … 共 5 处 |
| #4493f8 | #17233a | **5.06:1** | 4.5 | PASS | `.pp-root .pp-mb-badge`、`.pp-root .pp-dlg-badge-info` |
| #d29922 | #373223 | **5.07:1** | 4.5 | PASS | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew`、`.pp-root .pp-ai-tier-trial` |
| #9198a1 | #21252b | **5.29:1** | 4.5 | PASS | `.pp-root .pp-search-clear`、`.pp-root .pp-cat-label`、`.pp-root .pp-empty` … 共 18 处 |
| #4493f8 | #1a1e23 | **5.40:1** | 4.5 | PASS | `.pp-root .pp-mb-opt:hover`、`.pp-root .pp-fold-head:hover .pp-card-title` |
| #8b949e | #1a1e23 | **5.44:1** | 4.5 | PASS | `.pp-root .pp-mem-time` |
| #ff7b72 | #392528 | **5.66:1** | 4.5 | PASS | `.pp-root .pp-mb-renew-expired` |
| #9198a1 | #1a1e23 | **5.75:1** | 4.5 | PASS | `.pp-root .pp-anchor-nav .pp-btn`、`.pp-root .pp-count`、`.pp-root .pp-cat-count` … 共 18 处 |
| #3fb950 | #21252b | **6.06:1** | 4.5 | PASS | `.pp-root .pp-mb-compare .pp-cmp-yes` |
| #ff7b72 | #21252b | **6.10:1** | 4.5 | PASS | `.pp-root .pp-chip-x`、`.pp-root .pp-link-danger` |
| #79b8ff | #253244 | **6.24:1** | 4.5 | PASS | `.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active`、`.pp-root .pp-count-hit` |
| #ffffff | #1158c7 | **6.47:1** | 4.5 | PASS | `.pp-root .pp-btn-primary:hover:not(:disabled)`、`.pp-root .pp-avatar`、`.pp-root .pp-mb-badge-pro` |
| #d29922 | #1a1e23 | **6.64:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-warn`、`.pp-root .pp-mb-warn` |
| #ff7b72 | #1a1e23 | **6.64:1** | 4.5 | PASS | `.pp-root .pp-mb-expiry-expired` |
| #79b8ff | #17233a | **7.56:1** | 4.5 | PASS | `.pp-root .pp-mb-opt-on`、`.pp-root .pp-chip-on`、`.pp-root .pp-ds-on` … 共 4 处 |
| #79b8ff | #1a1e23 | **8.07:1** | 4.5 | PASS | `.pp-root .pp-mb-compare thead th.pp-cmp-pro` |
| #e6edf3 | #2a3038 | **11.26:1** | 4.5 | PASS | `.pp-root .pp-search-clear:hover`、`.pp-root .pp-dlg-close:hover` |
| #e6edf3 | #1f2c3d | **11.96:1** | 4.5 | PASS | `.pp-root .pp-mb-quote` |
| #e6edf3 | #21252b | **13.03:1** | 4.5 | PASS | `.pp-root .pp-btn`、`.pp-root .pp-mb-opt`、`.pp-root .pp-label` … 共 11 处 |
| #e6edf3 | #1b1f24 | **14.02:1** | 4.5 | PASS | `.pp-root .pp-input`、`.pp-root .pp-select`、`.pp-root .pp-textarea` |
| #e6edf3 | #1a1e23 | **14.17:1** | 4.5 | PASS | `.pp-root .pp-chip`、`.pp-root .pp-ds-chip`、`.pp-root .pp-pdf-item` … 共 7 处 |
| #f2f6fa | #21252b | **14.18:1** | 4.5 | PASS | `.pp-root .pp-card-title`、`.pp-root .pp-sub-title`、`.pp-root .pp-subtitle` … 共 8 处 |
| #f2f6fa | #1a1e23 | **15.42:1** | 4.5 | PASS | `.pp-root .pp-mb-title`、`.pp-root .pp-dev-name`、`.pp-root .pp-ch-name` … 共 5 处 |
| #ffffff | #1a1e23 | **16.75:1** | 4.5 | INFO | `.pp-root .pp-rank-preview .pp-badge-demo` |

### 非文本 · 控件边界与焦点环（计入门禁）

| 颜色 | 相邻底 | 实测 | 阈值 | 判定 | 类型 | 选择器 |
|---|---|---|---|---|---|---|
| #3d444d | #21252b | **1.56:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-dev-row` |
| #2c4668 | #21252b | **1.60:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-ch-row:hover` |
| #3d444d | #1a1e23 | **1.70:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-ch-row`、`.pp-root .pp-chip`、`.pp-root .pp-ds-chip` … 共 6 处 |
| #4d565f | #1a1e23 | **2.24:1** | 3 | **FAIL** | 描边 | `.pp-root .pp-dev-row:hover` |
| #6e7a86 | #21252b | **3.51:1** | 3 | PASS | 描边 | `.pp-root .pp-btn`、`.pp-root .pp-mb-opt` |
| #6e7a86 | #1b1f24 | **3.78:1** | 3 | PASS | 描边 | `.pp-root .pp-input`、`.pp-root .pp-select`、`.pp-root .pp-textarea` … 共 4 处 |
| #4493f8 | #253244 | **4.18:1** | 3 | PASS | 描边 | `.pp-root .pp-anchor-nav .pp-btn:hover:not(:disabled)`、`.pp-root .pp-anchor-nav .pp-btn.pp-anchor-active` |
| #4493f8 | #253244 | **4.18:1** | 3 | PASS | 图标 | `.pp-root .pp-card-icon` |
| #f85149 | #392528 | **4.26:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-renew-expired` |
| #4493f8 | #1f2c3d | **4.56:1** | 3 | PASS | 描边 | `.pp-root .pp-dev-row-cur` |
| #8d99a6 | #2a3038 | **4.59:1** | 3 | PASS | 描边 | `.pp-root .pp-btn:hover:not(:disabled)` |
| #4493f8 | #21252b | **4.97:1** | 3 | PASS | 焦点环 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus`、`.pp-root .pp-textarea:focus` … 共 6 处 |
| #4493f8 | #21252b | **4.97:1** | 3 | PASS | 描边 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus`、`.pp-root .pp-textarea:focus` … 共 8 处 |
| #8b949e | #21252b | **5.00:1** | 3 | PASS | 图标 | `.pp-root .pp-search-icon` |
| #4493f8 | #17233a | **5.06:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-opt-on`、`.pp-root .pp-chip-on` |
| #d29922 | #373223 | **5.07:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-renew`、`.pp-root button.pp-mb-renew` |
| #8d99a6 | #21252b | **5.31:1** | 3 | PASS | 描边 | `.pp-root .pp-input:hover:not(:focus)`、`.pp-root .pp-select:hover:not(:focus)`、`.pp-root .pp-color:hover` |
| #4493f8 | #1a1e23 | **5.40:1** | 3 | PASS | 焦点环 | `.pp-root .pp-ts-chip:focus-visible`、`.pp-root .pp-fold-head:focus-visible` |
| #4493f8 | #1a1e23 | **5.40:1** | 3 | PASS | 描边 | `.pp-root .pp-mb-opt:hover`、`.pp-root .pp-mb-renew:hover`、`.pp-root .pp-theme-card:hover` … 共 4 处 |

### 非文本 · 装饰性分隔线（仅测量，不计入）

| 颜色 | 相邻底 | 实测 | 选择器 |
|---|---|---|---|
| #2a5136 | #263d31 | 1.30:1 | `.pp-root .pp-pill-ok` |
| #554728 | #3d382a | 1.30:1 | `.pp-root .pp-pill-warn` |
| #2b4464 | #21252b | 1.55:1 | `.pp-root .pp-input:focus`、`.pp-root .pp-select:focus` … 共 4 处 |
| #3d444d | #21252b | 1.56:1 | `.pp-root .pp-toolbar`、`.pp-root .pp-cat-label` … 共 18 处 |
| #2e4f7a | #253244 | 1.56:1 | `.pp-root .pp-count-hit`、`.pp-root .pp-card-icon` |
| #263f5f | #1a1e23 | 1.56:1 | `.pp-root .pp-ts-chip:focus-visible`、`.pp-root .pp-fold-head:focus-visible` |
| #2a4b75 | #1f2c3d | 1.59:1 | `.pp-root .pp-mb-quote` |
| #2c4668 | #21252b | 1.60:1 | `.pp-root .pp-subs-row:hover`、`.pp-root .pp-sch-row:hover` … 共 4 处 |
| #254573 | #17233a | 1.62:1 | `.pp-root .pp-mb-badge`、`.pp-root .pp-mem-kind` |
| #3d444d | #1a1e23 | 1.70:1 | `.pp-root .pp-count`、`.pp-root .pp-cat-count` … 共 20 处 |
| #4d565f | #21252b | 2.06:1 | `.pp-root .pp-account-email` |
| #3fb950 | #263d31 | 4.63:1 | `.pp-root .pp-dlg-badge-ok` |
| #d29922 | #3d382a | 4.65:1 | `.pp-root .pp-dlg-badge-warn`、`.pp-root .pp-dlg-tail` |
| #4493f8 | #21252b | 4.97:1 | `.pp-root .pp-theme-cat` |
| #4493f8 | #17233a | 5.06:1 | `.pp-root .pp-ds-on`、`.pp-root .pp-theme-on` … 共 4 处 |
| #d29922 | #373223 | 5.07:1 | `.pp-root .pp-ai-tier-trial` |
| #3d444d | #ffffff | 9.85:1 | `.pp-root .pp-mb-qr`、`.pp-root .pp-dlg-qr` |

## 三.3 逐对实测 · 深色（:root[data-theme="dark"] 显式）

> 该状态已接入：prefs.css 的 `:root[data-theme="dark"] .pp-root` 与 media 块逐令牌同值，所以计数与 3.2 完全相同，不重复整表（完整数据在 `contrast.json` 的 `groups["dark-explicit"]`）。

- 文字 28/28｜非文本控件/焦点 15/19｜装饰性 17 对中 11 对 <3:1。

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

| 选择器 | 状态 | 实测 | 阈值 | 修复方向 |
|---|---|---|---|---|
| `.pp-root .pp-ch-row`、`.pp-root .pp-chip` … 共 6 处 | 浅 | 1.27:1 | 3 | 该元素仍用装饰性 --pp-border（只该服务卡片轮廓与分区线）：如果它是可交互控件（chip / 行内按钮 / 可点行），改 --pp-border-control；纯容器行则 1.4.11 不强制 |
| `.pp-root .pp-dev-row` | 浅 | 1.36:1 | 3 | 该元素仍用装饰性 --pp-border（只该服务卡片轮廓与分区线）：如果它是可交互控件（chip / 行内按钮 / 可点行），改 --pp-border-control；纯容器行则 1.4.11 不强制 |
| `.pp-root .pp-ch-row:hover` | 浅 | 1.42:1 | 3 | alpha 线（.24/.30）合成后不足 3:1：控件态可 alpha ≈.55–.6，或直接用实色 accent |
| `.pp-root .pp-dev-row:hover` | 浅 | 1.51:1 | 3 | hover 态仍走 --pp-border-strong：控件 hover 应改 --pp-border-control-hover |
| `.pp-root .pp-dev-row` | 深 | 1.56:1 | 3 | 该元素仍用装饰性 --pp-border（只该服务卡片轮廓与分区线）：如果它是可交互控件（chip / 行内按钮 / 可点行），改 --pp-border-control；纯容器行则 1.4.11 不强制 |
| `.pp-root .pp-ch-row:hover` | 深 | 1.60:1 | 3 | alpha 线（.24/.30）合成后不足 3:1：控件态可 alpha ≈.55–.6，或直接用实色 accent |
| `.pp-root .pp-ch-row`、`.pp-root .pp-chip` … 共 6 处 | 深 | 1.70:1 | 3 | 该元素仍用装饰性 --pp-border（只该服务卡片轮廓与分区线）：如果它是可交互控件（chip / 行内按钮 / 可点行），改 --pp-border-control；纯容器行则 1.4.11 不强制 |
| `.pp-root .pp-dev-row:hover` | 深 | 2.24:1 | 3 | hover 态仍走 --pp-border-strong：控件 hover 应改 --pp-border-control-hover |

- 文字对（4.5:1）**全部通过**，包括裁决书点名的 5 组及其同批颜色的残留位。
- 描边类非文本对仍有 **8** 组未过 3:1，涉及令牌：（未能反查令牌）。
- 其中 **8 组落在可交互元素上**（WCAG 1.4.11 强制）：`.pp-ch-row` 1.27:1；`.pp-dev-row` 1.36:1；`.pp-ch-row:hover` 1.42:1；`.pp-dev-row:hover` 1.51:1；`.pp-dev-row` 1.56:1；`.pp-ch-row:hover` 1.60:1；`.pp-ch-row` 1.70:1；`.pp-dev-row:hover` 2.24:1。

## 六、静态不可判 / 边界

- 背景带 alpha 时，合成基色由 BASE_MAP（脚本第 4 节）按「最近祖先面令牌」显式声明，并已把基色打进表格；静态 CSS 无法证明真实 DOM 嵌套，若实际嵌套不同，该行需按实际底色重算。prefs.css 中 --pp-bg 与 --pp-surface 两态同值，面板级歧义零影响。
- 由 prefs-*.js 运行时写入的内联色（.pp-badge-demo 的徽章底色等）静态不可判，已标 INFO 且不计入通过率。
- 渐变底（.pp-avatar / .pp-mb-badge-pro）取渐变两端中较差的一对入表，是保守下界。
- disabled 控件与「即将上线」占位项按 WCAG 1.4.3 豁免，计 N/A，不进通过率。
- 显式深色已由 :root[data-theme="dark"] .pp-root 覆盖（与 media 块同值）；该态断言基于「系统亮色 + 显式深色」的层叠推导。
- 焦点指示器同时扫 box-shadow 环与 outline（.pp-link-btn / .pp-disclose > summary 走 outline 2px；只看 box-shadow 会误判为「无焦点环」——gate-render 实测确认）。焦点过渡有 .12s transition，本脚本读的是声明值而非运行时计算值，不受过渡起点影响。
- 两份 CSS 都没有 color-scheme 声明 → 暗色下原生 checkbox / select 弹层 / 滚动条仍按浅色绘制（gate-render 4× 截图实测：未勾选 checkbox 是纯白 13×13 方块，比卡面还亮，勾选后才是蓝底白勾）。修法：暗色块里加一行 color-scheme: dark。
- 原生控件（checkbox/select 弹层/滚动条）的外观由 UA 的 color-scheme 决定，不在本脚本的对比度对里；上面那条是静态声明扫描 + gate-render 的 4× 截图交叉验证，两者结论一致。
- opacity < 1 的元素（如 .pp-mb-opt-soon）按 opacity 混合后计有效对比度，并标豁免。
- 表格里的合成底色是四舍五入到 8 位的 hex，内部按浮点 RGB 计算；用显示值手算可能差 ±0.01（例如 #cf222e on #f2e3e6 内部 4.30，用四舍五入后的 hex 手算会得 4.31）。
- 公式自检：#000000 on #ffffff = 21.00、#767676 on #ffffff = 4.54（WCAG AA 边界经典值），与本脚本输出一致。

