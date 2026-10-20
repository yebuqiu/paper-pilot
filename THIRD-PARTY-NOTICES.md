# Third-Party Notices / 第三方组件与数据源声明

本文件列出 Papilot 使用或调用的第三方组件与数据服务。各组件版权归其作者所有，适用其自身许可；
**本文件中的组件不受本仓库 Apache-2.0 约束。**

最后更新：2026-10-19（对应插件 0.56.0）

---

## 1. 随包分发的第三方代码

### sm-crypto 0.3.10

- **文件**：`chrome/content/scripts/vendor/sm2.js`（随 xpi 分发）
- **用途**：知网账号登录流程中的 SM2 签名与 SM3 摘要
- **许可证**：MIT
- **上游**：<https://github.com/JuneAndGreen/sm-crypto>
- **修改情况**：代码原样保留（与 npm `sm-crypto@0.3.10` 的 `dist/sm2.js` 逐字节一致），仅在文件头追加许可声明注释
- **MIT 许可全文**：

```
MIT License

Copyright (c) 2017 JuneAndGreen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Nord 色板（仅颜色数值）

- **用途**：`ui-theme.js` 中 Nord 主题的配色取值（`#2E3440` / `#88C0D0` 等）
- **许可证**：MIT（<https://github.com/nordtheme/nord>）
- **说明**：颜色数值本身不构成著作权客体，此处仅作出处标注

### pdf.js 3.11（pdfjs-dist legacy UMD 构建）

- **文件**：`chrome/content/vendor/pdfjs/pdf.min.js`、`pdf.worker.min.js`、`LICENSE`（随 xpi 分发）
- **用途**：对扫描版 PDF 做**本地**页面光栅化，供 OCR 使用；渲染在用户本机完成，不上传 PDF
- **许可证**：Apache-2.0（Copyright © Mozilla Foundation）
- **上游**：<https://github.com/mozilla/pdf.js>
- **修改情况**：代码原样保留（取自本仓库 `edge-extension/src/vendor/pdfjs/`，与 pdfjs-dist 3.11 legacy 构建一致），未做修改；许可证全文随文件分发


---

## 2. 运行时下载、不随包分发

| 组件 | 许可证 | 说明 |
|---|---|---|
| [translators_CN](https://github.com/l0o0/translators_CN) | AGPL-3.0 | 由用户本机从上游镜像下载至 **Zotero 数据目录**，用于修复中文文献抓取。Papilot **不内置、不修改、不再分发**其代码；使用时请遵守其许可 |
| [open-termbank](https://github.com/yebuqiu/open-termbank) | 见上游仓库 | 术语包在线词库，按用户操作下载到本机 |

> 上述内容进入的是用户自己的 Zotero 数据目录，属于用户本机使用行为，不构成本项目对该代码的分发。

---

## 3. 仅调用公开接口（不包含其数据副本）

| 服务 | 用途 | 条款要点 |
|---|---|---|
| [OpenAlex](https://openalex.org) | 文献元数据、被引关系 | 数据以 CC0 发布 |
| [Crossref](https://www.crossref.org) | DOI 元数据 | 公开 REST API，需礼貌标识（`mailto`） |
| [Semantic Scholar](https://www.semanticscholar.org/product/api) | 被引量、相关文献、引文上下文 | **其 API License 限内部/非商业研究用途；商用需向 AI2 申请扩展许可。Papilot 仅在用户自备 API Key 时调用，不随包提供任何 Key** |
| [Unpaywall](https://unpaywall.org) | 开放获取全文定位 | 需提供联系邮箱（用户自填） |
| [easyScholar](https://www.easyscholar.cn) | 期刊分区/等级 | **用户自备 SecretKey**，插件不含任何内置 Key |
| [arXiv](https://arxiv.org) | 预印本检索与每日推荐 | 遵守其 API 使用政策与请求频率 |
| PubMed / Europe PMC | 生物医学文献元数据 | 公开接口 |
| 各机器翻译引擎（Google / Bing / DeepL / 有道 / 腾讯 / 彩云 / LibreTranslate / Lingva 等） | 翻译 | 仅调用各服务公开接口；**不包含**其客户端代码。自建实例（LibreTranslate / Lingva / DeepLX）按其自身许可使用 |

---

## 4. 分发物中的第三方二进制（仅便携盘/整包分发时适用）

仓库本身**不包含**以下二进制（已在 `.gitignore` 中排除）。若以「便携盘」或整包形式分发，需一并附上其许可：

| 二进制 | 位置 | 许可证 |
|---|---|---|
| Node.js | `runtime/node/node.exe` | MIT（含其捆绑的第三方组件，详见上游 `LICENSE`） |
| cloudflared | `runtime/cloudflared/cloudflared.exe` | Apache-2.0 |

---

## 5. 已核查、确认未使用第三方代码的部分

- 期刊分区离线示例数据 `chrome/content/data/journal-rank.json`：自编示例（2.4 KB，注释注明「仅供演示」），**不是** easyScholar 数据库副本
- 图标 `chrome/content/icons/*.svg`：本项目手写路径
- 主题壁纸：程序化生成或用户自备
- 技能包目录 45 个包：均由本项目创作

---

## 6. 报告问题

若你认为本文件遗漏了某个组件，或某处使用不符合其许可，请提交 Issue，我们会在下一个版本修正。
