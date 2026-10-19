# Papilot 阅读器 AI 增强 · 实现方案

> 版本：v1.0（2026-09-30）
> 目标版本：Papilot 0.10.0
> 范围：划词翻译 2.0 + 选区精读问答联动（对照 zotero-pdf-translate 10.5k★ / zotero-gpt 7k★ 的核心体验）

---

## 1. 现状盘点（0.9.2 已有基础）

| 能力 | 现状 | 位置 |
|---|---|---|
| 划词翻译/解读 | 已有：`renderTextSelectionPopup` 注入「翻译 / 解读」两个按钮，结果纯文本展示 | `scripts/features/reader-popup.js` |
| 全文精读问答 | 已有：全文提取（Z9/Z10 双通道索引读取）、FIFO 缓存、头 2/3 + 尾 1/3 截断、多轮历史 | `scripts/ai/chat.js` |
| AI 问答侧栏 | 已有：ItemPane section，Prompt 库、存为笔记、多轮对话 | `scripts/panels/ai-chat-pane.js` |
| LLM 客户端 | OpenAI 兼容 `/chat/completions`，**非流式**，超时 180s | `scripts/ai/client.js` |
| Prompt 技能库 | 内置 5 条 + 用户自定义（`customPrompts` pref） | `scripts/ai/prompts.js` |
| 工作台独立窗口 | 已有，经 `window.arguments` 传 Zotero/Services 引用 | `workbench.xhtml/js` |

**结论：骨架都在，差的是"体验密度"。** 对照 pdf-translate 与 zotero-gpt，差距集中在四点：

| 差距 | pdf-translate / zotero-gpt 的做法 | 影响 |
|---|---|---|
| 无流式输出 | 全部流式逐字渲染 | 长回答白等 10-30s，是最大体验短板 |
| 翻译是一次性的 | 译文可复制、可写回高亮批注（annotation comment），形成沉淀 | 用户译完即丢，没有知识积累 |
| 划词后无法追问 | zotero-gpt 招牌：选中段落 → 就这段提问 → 多轮 | 选区与问答是两个割裂功能 |
| 无自动翻译模式 | 划词即译（可选开关）+ 翻译缓存 | 高频阅读时每段都要手点一次 |

---

## 2. 设计目标与原则

1. **一次划词，三种去向**：即时翻译 / 就地追问 / 写入批注沉淀。
2. **全链路流式**：浮窗、侧栏、工作台共享同一套流式客户端。
3. **零成本复用**：不改 AIChat 全文通道，选区上下文走「引用块」注入。
4. **优雅降级**：网关不支持流式时自动回退非流式；所有新功能可单独开关。
5. **遵守既有约束**（代码注释中的实证教训）：
   - 阅读器/侧栏 UI 必须用 XHTML 命名空间创建元素；
   - 单模块加载失败不拖垮整体（`loadSubScript` 逐个 try/catch 模式）；
   - 新 pref 一律在 `prefs.js` 登记默认值；
   - 不引入外部依赖，纯 bootstrap 作用域实现。

---

## 3. 功能设计

### F1 划词浮窗 2.0（reader-popup.js 重构）

**UI 结构**（在官方 popup 内 append 的容器）：

```
[翻译] [解读] [追问…]        ← 按钮行（追问点击后展开输入框）
─────────────────────────
<结果区：流式渲染，Markdown-lite>
[复制] [重试] [写入批注]      ← 结果操作行（结果就绪后出现）
<追问输入框 + 发送>（可选展开）
```

**行为细节**：

- **自动翻译模式**：新 pref `readerPopupAutoTranslate`（默认关）。开启后划词即自动触发翻译，无需点击。限流：同一选区去重、最短间隔 800ms、选区长度 <2 或 >2000 字符跳过。
- **流式渲染**：结果区逐字追加（复用 F3 的流式客户端）；渲染用现有 `MdLite`（工作台同款）做轻量 Markdown。
- **复制**：`Zotero.Utilities.Internal.copyText()` 写剪贴板，按钮短暂变 ✓。
- **重试**：清结果区重新发起，复用最近一次 mode。
- **写入批注**（pdf-translate 招牌能力）：
  - 若 `params.annotation` 存在（用户在高亮批注上划词）→ 把译文追加到该 annotation item 的 `comment` 字段，`item.saveTx()` 保存；
  - 若是全新选区（无 annotation）→ 按钮文案为「存为高亮批注」，点击后先经 `Zotero.Reader` 当前 reader 实例创建高亮注释再写入 comment。**该路径在 Z7/Z10 的 API 稳定性未实证，列入 M3，若不稳定则降级为"复制译文+提示手动批注"。**
- **目标语言**：新 pref `readerPopupTargetLang`（默认"中文"），拼进翻译 prompt；设置面板提供 中文/English/日本語 三档。

### F2 选区 → 精读问答联动

两种实现，按里程碑递进：

- **M2a · 浮窗内追问（必做，可靠）**：浮窗展开输入框，问题与选区一起发出：
  - system：`aiSystemPrompt` + 选区所在论文元数据（经 `AIChat._paperMeta`，需把当前 reader 对应 item 传入）；
  - user：`【原文摘录】\n{text}\n\n【问题】\n{question}`；
  - 浮窗内维护本会话 history（Map: readerItemID → messages），支持多轮，选区变化时保留。
- **M2b · 送入侧栏（增强，有兼容性风险）**：浮窗加「在侧栏中继续」按钮 → 调 `AIChatPane.injectQuote(item, text)`（新增公开 API）：把选区作为引用块预填到侧栏输入框并聚焦。
  - 风险：阅读器标签页内唤起并聚焦 context pane 的 API 在 Z10 未实证；实现失败时静默隐藏该按钮，**不影响 M2a**。

reader 当前条目获取：`Zotero.Reader.getByTabID(tabID)` → reader item → `AIChat.getPdfAttachment` 链路复用。若读者打开的是独立 reader 窗口，同样经 `Zotero.Reader` 枚举兜底。

### F3 流式响应基础设施（ai/client.js 扩展）

`AIClient.chat(messages)` 保持不变（兼容存量调用），新增：

```js
/**
 * 流式问答
 * @param messages 同 chat()
 * @param onDelta  (textChunk) => void  每收到一段增量即回调
 * @returns {Promise<string>} 完整回复（与 onDelta 累计一致）
 */
async chatStream(messages, onDelta)
```

- 传输：**不用 `Zotero.HTTP`（不支持流式）**，改用 bootstrap 作用域内的 `fetch` + `response.body.getReader()` 手工解析 SSE（`data: {...}\n\n` 帧，`[DONE]` 结束）。Z7（FF115+）/Z10 均带完整 fetch/ReadableStream。
- 兼容探测：payload 加 `stream: true`；若网关返回非 200 或 `content-type` 非 `text/event-stream`，自动降级为一次性读取整段再回调 `onDelta(全文)`——**Prism 网关（127.0.0.1:18790）若不透传 SSE，用户体验与现状一致，不会更差**。
- 取消：内部持 `AbortController`，暴露返回句柄 `{ promise, abort() }`；浮窗关闭/重试/切换条目时 abort。
- 超时：180s 不变，但首字节 30s 未达即报错（非流式网关挂死的防护）。

### F4 翻译缓存与成本护栏

- 会话级缓存：`Map<hash(text+mode+lang), result>`，上限 100 条 FIFO（与 `_textCache` 同款模式），重复划同一句话零请求。
- 每日用量统计（可选）：pref 记 `readerPopupDailyCount`（日期:次数），设置面板可见，超 500 次当日弹一次温和提醒——Prism 本地网关用户无所谓，在线 API 用户防失控。

---

## 4. 配置项与设置面板

`prefs.js` 新增：

```js
pref("extensions.zotero.papilot.readerPopupAutoTranslate", false);
pref("extensions.zotero.papilot.readerPopupTargetLang", "中文");
pref("extensions.zotero.papilot.readerPopupStream", true);
pref("extensions.zotero.papilot.readerPopupWriteBack", true);
pref("extensions.zotero.papilot.readerPopupDailyCount", "");
```

`prefs.xhtml` 阅读器分区新增：自动翻译开关、目标语言下拉、流式开关、写回批注开关。`prefs-pane.js` 按现有绑定模式登记。

---

## 5. 文件改动清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `scripts/ai/client.js` | 新增 `chatStream`（fetch+SSE、降级、Abort） | ~120 行新增 |
| `scripts/features/reader-popup.js` | 重构：三按钮+操作行+追问输入+流式渲染+缓存 | 重写至 ~380 行 |
| `scripts/panels/ai-chat-pane.js` | 新增 `injectQuote(item, text)` 公开 API（M2b） | ~40 行新增 |
| `scripts/ai/chat.js` | 导出 `_paperMeta` 供浮窗复用（改名 `paperMeta`） | 2 行 |
| `chrome/content/locale/*.ftl` | 新增 10 条文案键 | 小 |
| `prefs.js` / `prefs.xhtml` / `prefs-pane.js` | 5 个新 pref + 设置 UI | 小 |
| `manifest.json` | version → 0.10.0 | 1 行 |

无新增文件、无新依赖、不动 bootstrap.js。

---

## 6. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1 流式 + 浮窗增强** | F3 全部；F1 的流式渲染、复制/重试、自动翻译、目标语言、F4 缓存 | 划词后 1s 内首字出现；重复划词零请求；关闭流式开关回退旧行为 |
| **M2 选区追问** | F2 的 M2a（浮窗内多轮追问）；M2b 视 API 实证结果并入或放弃 | 可就选中段落连续追问 3 轮以上，上下文正确引用摘录 |
| **M3 批注沉淀** | 写入既有批注 comment；新建高亮批注路径实证 | 高亮上划词翻译 → 批注 comment 含译文，Zotero 同步无冲突 |

建议 M1+M2a 合发 0.10.0，M3 实证后发 0.10.1。

---

## 7. 风险清单

| 风险 | 等级 | 对策 |
|---|---|---|
| Prism 网关不透传 SSE | 中 | 自动降级非流式，逐字假流式渲染（按 20ms/字符回放完整文本），体感仍优于白等 |
| `fetch` 在 reader popup 事件作用域不可用 | 低 | 流式调用统一收口在 bootstrap 作用域的 AIClient，浮窗只持回调 |
| Z10 reader 批注写入 API 变动 | 中 | M3 独立里程碑，失败降级为复制译文 |
| 侧栏唤起/聚焦 API 未实证（M2b） | 中 | 失败则隐藏按钮，M2a 不受影响 |
| 自动翻译模式请求风暴 | 低 | 去重+限流+长度护栏+每日计数 |
| SSE 解析在插件热升级后的编译缓存 | 低 | 沿用现有 `?v=` 缓存破坏机制 |

---

## 8. 测试方案

1. **手动矩阵**：Zotero 7 / Zotero 10 × 标签页 reader / 独立 reader 窗口 × 流式开/关。
2. **关键用例**：
   - 划词 → 自动翻译（开启时）→ 复制 → 追问 2 轮 → 写入批注；
   - 无 API Key / 网关离线 / 429 的错误文案路径（复用 `_wrapError`）；
   - 切换条目后缓存与 history 隔离正确；
   - 插件禁用 → 启用，popup 事件注销/重注册无泄漏（`unregister` 路径走一遍）。
3. **回归**：侧栏问答、工作台、Prompt 库等存量功能不受影响（AIClient.chat 原路径零改动）。
