# 贡献指南

## 贡献技能包（最常见）

为 PaperPilot 技能商店贡献 AI 技能包（提示词标签 / 术语表 / 笔记模板 / Agent 预设）：

👉 **完整指南见 [community-packs/README.md](./community-packs/README.md)**

快速路径：在插件「技能商店 → ＋ 制作技能包」生成 JSON → 校验 → 提交 PR 或 Issue 投稿 → 审核合并后全体用户可见。

## 贡献代码

1. Fork 并克隆仓库，在 `main` 分支基础上开分支；
2. 改动请保持每个 PR 聚焦一件事；
3. 运行门禁（需 Node 18+）：
   ```bash
   python scripts/preflight.py --fast
   ```
4. 提交 PR，描述清楚动机与改动点。

## 行为准则

友善、对事不对人；提示范例请遵循项目「结构化输出 + 证据纪律」风格。
