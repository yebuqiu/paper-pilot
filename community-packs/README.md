# 社区技能包贡献指南

欢迎为 PaperPilot 技能商店贡献技能包！你的技能包经审核合并后，**所有用户在技能商店点「刷新目录」即可看到并安装**（无需升级插件）。

## 技能包是什么

一份 JSON 清单（manifest），把四类内容打包进 PaperPilot：

```json
{
  "id": "my-awesome-pack",
  "name": "我的技能包",
  "version": "1.0.0",
  "author": "你的名字或 GitHub ID",
  "desc": "一句话简介（60 字以内，用户搜索靠它）",
  "category": "写作",
  "tags": ["关键词", "便于搜索"],
  "changelog": "1.0.0: 首发",
  "contents": {
    "prompts": [
      { "id": "my-prompt", "label": "标签名", "prompt": "提示词全文……", "color": "", "trigger": "^关键词" }
    ],
    "glossary": ["原文 = 译文 | 领域"],
    "noteTemplates": [{ "name": "模板名", "body": "## {{title}}\n\n（{{creators}} / {{year}} / {{pub}} / {{doi}} 自动填充）" }],
    "agentPreset": { "chatAgentMode": true, "aiAgentTools": "search_library,read_item_fulltext", "aiAgentMaxSteps": 8 }
  }
}
```

四个内容槽全部可选（但至少要有一个），完整规范见 [`_TEMPLATE.json`](./_TEMPLATE.json)。

## 提交方式

### 方式 A：Pull Request（推荐）

1. **制作**：最简单的方式——在 PaperPilot 技能商店点「＋ 制作技能包」，勾选你的 Prompt 标签、填好信息，点「生成技能包」→ 复制 JSON（也可以手写，对照 `_TEMPLATE.json`）。
2. **自检**（可选但强烈建议）：
   ```bash
   git clone https://github.com/yebuqiu/paper-pilot.git
   cd paper-pilot
   # 把你的 JSON 存为 community-packs/<你的id>.json，然后：
   node scripts/validate-pack.js community-packs/<你的id>.json
   ```
3. **提交 PR**：Fork 本仓库 → 在 `community-packs/` 目录添加 `<你的id>.json` → 发起 Pull Request（模板会引导你填写）。CI 会自动校验格式。
4. **等待审核**：维护者会按下方标准 review，通常在数日内回复。通过合并后，维护者运行目录生成器，你的技能包即出现在所有人的技能商店中。

### 方式 B：Issue 投稿（不会 Git 也能投）

[点此开一个「技能包投稿」Issue](https://github.com/yebuqiu/paper-pilot/issues/new?template=skill-pack.md)，把制作器生成的 JSON 粘贴进去即可，维护者审核后代为添加。

## 审核标准

| 项 | 要求 |
|---|---|
| 格式 | 通过 `node scripts/validate-pack.js`（id 唯一 kebab-case、版本三段数字、分类合法等，CI 自动检查） |
| 内容质量 | 提示词遵循「结构化输出 + 证据纪律」风格：要求落到具体位置/数字/章节，区分原文与推断，不写空泛套话 |
| 原创性 | 不与现有技能包功能重复；借鉴需注明 |
| 术语合规 | 术语表只收**自编或已获授权**的高置信译法，禁止搬运版权受限词库（微软术语集、商业词典等） |
| 安全 | 仅声明式内容（manifest 四槽），不接受任何可执行代码；agentPreset 工具白名单只能是插件已注册的六个工具 |
| 署名 | `author` 填你自己（`PaperPilot` 保留给官方内置包） |
| 无敏感内容 | 无违法违规、无竞品推广、无恶意提示注入（诱导用户泄露隐私/破坏数据的 prompt 会被拒绝） |

## 版本与更新

- 用户反馈迭代后，把 `version` 升一位（如 1.0.0 → 1.0.1）并在 `changelog` 写明变化，再发 PR 即可；
- 用户侧更新检测是自动的：目录版本高于已装版本时，技能商店会显示「↑ 更新」按钮。

## 常见问题

**Q：合并后多久用户能看到？**
维护者合并 PR 后运行 `node scripts/build-skill-catalog.js` 并提交，在线目录即时生效（Gitee CDN 有分钟级缓存）。

**Q：我的技能包会被打进插件安装包吗？**
不会。社区包只进**在线目录**（`server/public/skill-catalog.json`），插件离线时回落的内置目录仅含官方精选包。

**Q：可以放外链/推广吗？**
`desc`/`longDesc` 中可以放项目主页链接，但不接受纯推广性质的技能包。

---

许可：向本仓库提交的贡献遵循仓库根目录的 Apache-2.0 许可。
