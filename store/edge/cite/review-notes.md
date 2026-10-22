# 审核测试说明 · Papilot 引文快取

> 提交到 Edge Partner Center 的 “Notes for certification” 字段。无需账号、无需 Key。

## 一、这个扩展做什么

在论文详情页读取页面公开的书目元数据，在本地生成五种引文格式（GB/T 7714、APA 7、MLA 9、BibTeX、RIS），供用户复制。扩展不写入任何文献库，不登录，不收集浏览历史。

## 二、测试步骤（约 1 分钟）

1. 安装扩展。
2. 打开测试页：`https://arxiv.org/abs/1706.03762`。
3. 点浏览器工具栏的 Papilot 引文图标，弹窗应显示标题 “Attention Is All You Need”。
4. 默认格式为 GB/T 7714，输出应包含 `[J/OL]`、`arXiv`、`2017` 与 `1706.03762`。
5. 依次点 APA 7 / MLA 9 / BibTeX / RIS，输出应随格式切换。
6. 点「复制引文」，应提示「已复制」。

## 三、预期结果

- 弹窗在 1–2 秒内显示引文，不出现空白或错误。
- 无需登录、无需任何配置即可完成全部步骤。
- 若网络无法访问 Crossref，仍能使用页面元数据生成引文（仅补全能力受影响）。

## 四、权限用途

| 权限 | 为什么需要 |
|---|---|
| activeTab | 只在点击图标时访问当前标签页 |
| scripting | 读取页面的 `citation_*` 与 JSON-LD |
| storage | 保存默认格式与复制后关闭偏好 |
| api.crossref.org | 页面缺字段且存在 DOI 时补全公开元数据 |

## 五、数据流（供隐私核对）

- 页面元数据只在本地内存中处理，不上传。
- 仅当页面缺字段且有 DOI 时，向 Crossref 发送该 DOI。
- 不读取浏览历史、Cookie、剪贴板；无遥测；无远程代码。

## 六、已知行为

- 纯 PDF 页面（Edge 内置 PDF 阅读器）没有书目元数据，会提示改在摘要页使用。
- 页面若没有 `citation_*` 或 JSON-LD，会显示“没有识别到文献信息”。
- GB/T 外文作者采用“姓 + 首字母”简化规则。

## 七、联系方式

- 支持邮箱：947250030@qq.com
- 隐私政策：见提交时填写的 URL

---

### English summary

Papilot Cite Grabber reads the public bibliographic metadata of the current scholarly page and renders five citation formats locally (GB/T 7714, APA 7, MLA 9, BibTeX, RIS) for copying. It does not write to any reference manager, requires no account, and does not collect browsing history. Test with `https://arxiv.org/abs/1706.03762`: open the popup, verify the GB/T output contains `[J/OL]`, switch formats, then copy.
