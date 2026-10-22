# 审核测试说明 · Papilot 学术阅读侧边栏

> 提交到 Edge Partner Center 的 “Notes for certification” 字段。中文为主，末尾附英文摘要。

## 一、这个扩展做什么

在学术论文页面提供 AI 阅读辅助：解释选中内容、逐句翻译、生成结构化摘要，并基于当前页正文回答追问。不读写 Zotero 文献库。

## 二、审核账号（必填，当前阻塞）

AI 功能需要模型凭据。请使用下面的演示账号（**待创建**）：

- 邮箱：`edge-review@xinglintools.top`（占位，提交前替换）
- 密码：`（提交前填入）`
- 套餐：Pro（足够完成 5 次以内测试）
- 说明：该账号仅用于审核，额度有限；测试完成后可作废。

> 若演示账号未就绪，审核员也可以选择「自带 API Key」，填入任意 OpenAI 兼容接口。但这会让审核依赖第三方服务，**不建议作为唯一路径**。

## 三、测试步骤（约 3 分钟）

1. 安装扩展。首次安装会自动打开设置页。
2. 在设置页选择「Papilot 账号」，填入上方演示账号并点「登录 Papilot」，等待出现「登录成功」。
3. 打开测试论文页：`https://arxiv.org/abs/1706.03762`。
4. 点浏览器工具栏的 Papilot 图标，侧边栏打开后点「读取本页」，应显示「已读取 N 字」。
5. 在页面摘要里选中一句话，回到侧边栏点「解释选中」。预期在 5–20 秒内流式输出中文解释。
6. 可选：点「本页摘要」，预期输出 TL;DR / 研究问题 / 方法 / 主要结论 / 局限 / 可借鉴点。
7. **页内气泡**：在页面摘要里选中一句，页面内应弹出「翻译 / 解释 / 存摘录」。点「翻译」，结果在气泡内流式显示；点「存摘录」后，侧边栏「摘录」页应出现一条记录。
8. **整页对照**：切到侧边栏「对照」页，点「翻译本页」，应逐段产出中文译文；进度显示 n/N 段，可点「停止」。

## 四、预期结果

- 侧边栏可打开、可读取页面、可选择格式并复制。
- AI 回答为中文、引用当前页内容，不出现错误横幅。
- 若未配置任何凭据，界面会显示「尚未配置模型」横幅，点击可进入设置页；这是预期行为，不是故障。

## 五、权限用途

| 权限 | 为什么需要 |
|---|---|
| sidePanel | 展示侧边栏 UI |
| storage | 保存模型配置、术语表、会话 |
| scripting | 点击「读取本页」时抽取正文 |
| activeTab | 只在用户点击时访问当前标签页 |
| 学术站点 host permissions | 在论文站点自动捕获划词；不含全站通配 |
| pp.xinglintools.top | 账号登录与官方模型网关 |

## 六、数据流（供隐私核对）

- 页面标题、URL、正文节选、选中文本 → 仅发送到用户选择的模型接口。
- 账号模式：经 `pp.xinglintools.top` 转发到模型服务商；密码只换取令牌，不落盘。
- 无遥测、无广告、无浏览历史读取、无远程代码。

## 七、已知行为

- Edge 内置 PDF 阅读器无法注入，需在面板点「解析 PDF 全文」，或把本地 PDF 拖入面板。
- 非白名单站点需先点一次扩展图标授权，之后才能读取当前页。
- 页内气泡只在学术站点白名单自动出现；设置里可关闭。
- 扫描版 PDF（无文本层）无法抽取文字，会给出提示。

## 八、联系方式

- 支持邮箱：947250030@qq.com
- 隐私政策：见提交时填写的 URL

---

### English summary

Papilot Academic Side Reader provides AI reading assistance on scholarly pages: explain a selection, translate, summarize the page, and ask follow-up questions grounded in the page text. It does not access the user's Zotero library. AI features require either the demo account above or a user-supplied OpenAI-compatible API key. Test with `https://arxiv.org/abs/1706.03762`: open the side panel, click "Read this page", select a sentence in the abstract, then click "Explain selection". No remote code, no telemetry, no browsing-history access.
