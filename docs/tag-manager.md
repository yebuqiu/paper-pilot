# 标签管理（Tag Manager）

> 版本：0.70.0 起 · 入口：**左下角标签右键 → Papilot 标签工具**，或右键条目 → 标签治理 → 标签管理器
> 代码：`chrome/content/scripts/features/tag-ops.js`（数据与规则）、`tag-menu.js`（左下角入口）、
> `chrome/content/tag-manager.xhtml` + `tag-manager.js`（窗口）

## 1. 为什么不是"在左下角加个删除按钮"

Zotero 10 的左下角标签列表是 **React + react-virtualized** 渲染的：

- 文件：`chrome/content/zotero/components/tagSelector/tagSelectorList.js`
- 每个标签是 `div.tag-selector-item`，**只渲染可视区**（虚拟滚动）
- 点击语义是「加/减筛选条件」（`role="checkbox"`，`aria-checked` 表示是否参与筛选）
- 原生右键菜单 `#tag-menu` 已经有 4 条**单标签**操作：指派颜色 / 重命名 / 拆分 / 删除

推论（也是设计边界）：

| 想做的事 | 能不能在 tag selector 上做 | 原因 |
|---|---|---|
| 遍历 DOM 统计标签 | ❌ | 虚拟列表，DOM 里只有可视的几十个 |
| 给 chip 插复选框做多选 | ❌ | React 重渲染会抹掉，且与筛选语义打架 |
| 追加右键菜单项 | ✅ | 原生 `#tag-menu` 的 id 稳定，`popupshowing` 追加即可 |
| 批量选择 / 批量操作 | ✅ 独立窗口 | 见 `tag-manager.xhtml` |

所以：**左下角只做入口，批量能力全部在独立窗口**。

## 2. 能力清单

### 2.1 批量编辑（主视图）

- **筛选**：文本（含层级路径）、使用数区间、前缀/后缀、正则、手动/自动类型、层级深度、是否受保护、颜色
- **多选**：逐行勾选、全选（**只作用于当前筛选结果**）、反选、清空、选中全部受保护标签
- **删除**：预览受影响条目数 + 抽样标题 → 确认 → 执行（默认跳过保护名单）
- **重命名**：查找替换（字面/正则/整名）、加前后缀、剥前缀、大小写归一（小写/大写/首字母大写）、去尾随标点、全角转半角
- **合并**：选中的标签全部并入一个**已存在**的目标标签
- **层级**：加父级（`a/b` → `父/a/b`）、换父级（`旧/x` → `新/x`）、剥前缀
- **颜色**：9 色 + 清除（自动分配空闲槽位，Zotero 上限 9 个彩色标签）
- **保护名单**：把选中标签加入/移出保护

### 2.2 体检报告

只读分析，每块都能一键「选中这些」跳回批量视图：

- 写法变体组（忽略大小写/全半角/空格/连字符后同名）
- 仅使用 1 次（多为误输入）
- 缺少父级标签（有 `a/b` 但没有 `a`）
- 超长标签（> 40 字符）
- 层级过深（> 4 级）
- 统计卡：总数 / 累计使用 / 平均 / 仅 1 次 / 变体组 / 缺父级

### 2.3 快照与撤销

- 每次**删除 / 重命名 / 改色**前自动写一份快照：受影响标签 → 条目 ID 列表 + 颜色
- 位置：`<Zotero 数据目录>/papilot/tag-snapshots.json`（默认保留 30 条，pref `tagSnapshotKeep`）
- 撤销只回滚**标签关系**：条目已被删除的会跳过并计数，不会凭空造条目
- 用过即标记 `undoneAt`（保留审计痕迹，不直接销毁）

### 2.4 体系与导入导出

- 保护名单编辑（每行一条，支持 `*` `?` 通配；留空 = 默认 `#状态/*`、`#治理/*`）
- CSV 导出（name/count/manual/auto/color/protected）
- CSV 导入 → **按名单选中**（不直接改数据），或把 `protected=1` 的行并入保护名单
- 标签共现分析：常一起出现的标签对（建议建层级或判定同义词）

## 3. 安全约束

1. **没有一键直删**。删除必须走「预览删除 → 确认删除」两步，预览里给出标签数、影响条目数、抽样标题。
2. **保护名单默认生效**。`#状态/*`、`#治理/*` 是 Papilot 自己写的系统标签，批量删除默认跳过；要删必须在预览前显式勾选「包含受保护标签」。
3. **删除不可撤销 → 靠快照**。`Zotero.Tags.removeFromLibrary` 直接 `DELETE itemTags` 行，没有任何内置 undo。
4. **群组库安全**。库 ID 取 `ZoteroPane.getSelectedLibraryID()`，不写死 `userLibraryID`（旧 `TagCurator.collectTagStats` 的老毛病）。
5. **只读库禁用**。Feeds / 虚拟库下 `tagSelector.state.viewOnly === true`，删除项在菜单里直接 disabled。

## 4. 实现要点（改代码前必读）

```js
// 数据层：先计划，再执行
TagOps.planRename(tags, rules, { only, zh })   // → {changes, conflicts, invalid, unchanged}
TagOps.planMerge(tags, target, { zh })
TagOps.planAddParent(tags, parent, { only })
TagOps.planReparent(tags, oldSeg, newSeg, { anywhere })
TagOps.planStripPrefix(tags, prefix)

// 执行层：破坏性操作前必须 snapshot
await TagOps.snapshot(libID, names, { op: "delete" | "rename" | "color", changes })
await TagOps.deleteTags(libID, names, onProgress)
await TagOps.renameTags(libID, changes, onProgress)
await TagOps.applyColors(libID, names, color)
await TagOps.undo(snapshotID)
```

坑（都已踩过并加守卫）：

| 坑 | 现象 | 修法 |
|---|---|---|
| `Zotero.Prefs.get(key, true)` 第二参是 **global 标志，不是默认值** | 未设置时返回 `true`，`String(true)` 变成一条叫 `true` 的保护规则 → 系统标签失去保护 | 按 `typeof v === "string"` 收口 |
| 在 `busy=true` 里回头 `load(true)` 刷新 | 删完标签，列表还是旧的（像"按钮没反应"） | `if (S.busy && !force) return` |
| XUL `<script src>` 早于 DOM 执行 | 窗口空白、按钮死 | `DOMContentLoaded` + `readyState` 双守卫 |
| 注入节点只按 `getElementById` 摘 | 异常路径漏删 → 右键菜单越堆越多 | `_hook.nodes` 记引用优先摘 |
| `select` 里用 `setAttribute("selected")` | 真机上不一定压过第一项默认选中 | 属性 + `op.selected = true` 都设 |
| XHTML 注释里写 `&nbsp;` | XML 解析失败 → 整个窗口空白（Zotero 不报错） | 注释改用文字描述，§30 守卫会拦 |

## 5. 门禁

```bash
node test/tag-ops.test.js           # 352 断言：筛选/改名/合并/层级/快照 diff/CSV 纯函数
node test/tag-manager-ui.test.js    # 45 断言：迷你 DOM 真渲染（列表/多选/预览/执行/撤销/体检）
node test/tag-menu.test.js          # 24 断言：右键注入幂等、重建不堆叠、只读库禁用、保护翻转
python scripts/check-wiring.py      # §63（33 条）：装配顺序、windowtype 一致、snapshot 先于 delete
```

`check-wiring §63` 的存在意义：这几条不变量**改坏了也不会报错**，只会在真机上表现为
「右键没反应 / 窗口空白 / 删了不能撤销」。静态钉住它们比事后排查便宜得多。
