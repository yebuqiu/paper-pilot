# 第三方声明

本扩展（Papilot 学术阅读侧边栏）随包分发以下第三方组件：

| 组件 | 版本 | 许可证 | 用途 | 位置 |
|---|---|---|---|---|
| PDF.js（pdfjs-dist） | 3.11.174 | Apache-2.0 | 在扩展内解析 PDF 文本 | `src/vendor/pdfjs/` |

PDF.js 的完整许可证文本随附于 `src/vendor/pdfjs/LICENSE`。本项目自身以 Apache-2.0 发布，
版权归 Cassiuschen 所有；扩展图标为原创绘制，未使用第三方素材。

扩展运行时不加载任何远程 JavaScript；所有可执行代码均包含在安装包内。
