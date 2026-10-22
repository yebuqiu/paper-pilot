# Edge Add-ons 提交材料包

> 状态：**材料已就绪，尚未提交**。提交需要开发者账号与两个外部前置项（见“阻塞项”）。
> 更新：2026-10-19

## 目录

```
store/edge/
├── README.md                 # 本文件：清单、阻塞项、提交流程
├── trial-guide.md            # 可直接发给试用用户的说明
├── assets/                   # 商店图标（128×128）
├── tools/make-screenshots.js # 由真实截图合成 1280×800 商店图
├── reader/
│   ├── listing-zh.md         # 名称/简介/详述/权限理由/数据声明
│   ├── privacy-policy.html   # 可托管的隐私政策
│   ├── review-notes.md       # 审核测试说明（含演示账号占位）
│   └── screenshots/01-overview.png
└── cite/
    ├── listing-zh.md
    ├── privacy-policy.html
    ├── review-notes.md
    └── screenshots/01-overview.png, 02-formats.png
```

## 阻塞项（提交前必须解决）

1. **开发者账号**：Microsoft Partner Center → Edge program，免费；需你本人注册并接受协议。
2. **隐私政策公开 URL**：两份 HTML 已就绪，但 Edge 要求可公开访问的 HTTPS 地址。两种落点：
   - 挂到 `pp.xinglintools.top`（需在服务端加两条静态路由并重启，属于生产改动，**待你确认**）；
   - 或放到 Gitee/GitHub Pages 等静态托管（不改服务端）。
3. **阅读扩展的审核演示账号**（**最容易被拒的点**）：AI 功能需要凭据，审核员不会自己申请 Key。需要一个可用的演示账号（建议 `edge-review@` 前缀、Pro 额度、仅审核期有效）。创建账号属于生产数据变更，**待你确认后执行**。
   - 引文扩展不需要账号，无此问题。

## 提交清单

### 通用

- [ ] 开发者账号已通过验证
- [ ] 包版本号与 `manifest.json` 一致（0.2.0）
- [ ] 包内 `manifest.json` / 图标 / 源码齐全（`npm run pack` 产物）
- [ ] 隐私政策 URL 可访问（无登录墙、无 404）
- [ ] 商店图标 128×128 PNG
- [ ] 至少 1 张 1280×800 截图（已生成）
- [ ] 单一用途描述一句话
- [ ] 每个权限都有非模板化理由
- [ ] 数据使用声明与实际代码一致

### 阅读侧边栏（reader）

- [ ] 包：`edge-extension/dist/papilot-edge-0.2.0.zip`
- [ ] 演示账号已写入 `review-notes.md` 并实测可登录
- [ ] 审核步骤按 `review-notes.md` 走一遍（含 arXiv 读页 + 划词 + 回答）
- [ ] 说明“未配置模型时显示横幅”是预期行为
- [ ] 确认扩展名与描述未使用他人商标

### 引文快取（cite）

- [ ] 包：`edge-extension-cite/dist/papilot-cite-0.1.0.zip`
- [ ] 按 `review-notes.md` 在 arXiv 页走一遍（无需账号）
- [ ] 确认无 `<all_urls>`、无 cookies、无远程代码

## 材料自检

```bash
node store/edge/tools/check-assets.js
```

检查：截图是否 1280×800 且非空、简短描述是否 ≤132 字符、隐私页要素是否齐全、
审核说明是否含测试步骤、安装包内版本与清单是否一致。

## 重新生成资产

```bash
# 商店截图（需要 playwright-core）
NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
  node store/edge/tools/make-screenshots.js

# 扩展包
cd edge-extension && npm run pack
cd ../edge-extension-cite && npm run pack
```

## 提交顺序建议

1. **先提引文快取**：无账号依赖、审核最容易过，可先跑通账号与流程。
2. **再提阅读侧边栏**：演示账号就绪后再提交，避免因“无法测试”被拒。
3. 两个扩展**分别提交、分别命名**，不要合并——单一用途审核下，合并会被判多功能。

## 提交后

- 每次更新都需重新审核；新增权限会触发用户重新授权，尽量一次把权限定好。
- 保留 `review-notes.md` 的测试账号到审核结束；被拒时按政策条款逐条修正后重提，不要重复盲提。
- 商店文案、截图与实际功能必须一致，功能删改后同步更新材料。

## 合规红线（已在代码与文案中规避）

- 不含 Sci-Hub / LibGen / 绕过付费墙能力。
- 不做知网批量抓取，不逆向机构登录。
- 不修改 Zotero 已有条目（connector 本身也只支持新增）。
- 不加载远程可执行代码。
- 不在扩展名中使用 “Zotero” 商标；描述中不暗示官方背书。

## 附：隐私政策托管 Runbook（需你确认后执行）

服务端目前只按显式路由返回页面，没有通用静态目录。两种落地方式，任选其一：

### 方案 A：挂到 `pp.xinglintools.top`（推荐，域名与账号服务一致）

1. 复制文件：
   - `store/edge/reader/privacy-policy.html` → `server/public/privacy-edge-reader.html`
   - `store/edge/cite/privacy-policy.html` → `server/public/privacy-edge-cite.html`
2. 在 `server/account-server.js` 顶部常量区加两行：
   ```js
   const EXT_PRIVACY_READER = path.join(__dirname, 'public', 'privacy-edge-reader.html');
   const EXT_PRIVACY_CITE = path.join(__dirname, 'public', 'privacy-edge-cite.html');
   ```
3. 在静态页路由（`/terms` / `/privacy` 那一段）追加：
   ```js
   if (method === 'GET' && (url === '/privacy/edge-reader' || url === '/privacy/edge-cite')) {
     const file = url === '/privacy/edge-reader' ? EXT_PRIVACY_READER : EXT_PRIVACY_CITE;
     let html;
     try { html = fs.readFileSync(file); }
     catch (e) { return json(res, 500, { ok: false, error: '页面文件缺失' }); }
     res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
     return res.end(html);
   }
   ```
4. **重启生产 :8000**（本次改动是代码，不是纯静态文件）。
5. 验收：`curl -I https://pp.xinglintools.top/privacy/edge-reader` 返回 200 且 `text/html`。

最终填写：
- 阅读扩展：`https://pp.xinglintools.top/privacy/edge-reader`
- 引文扩展：`https://pp.xinglintools.top/privacy/edge-cite`

### 方案 B：不改服务端

把两个 HTML 放到任意可公开访问的 HTTPS 静态托管（GitHub Pages / Gitee Pages / 对象存储），
确保无登录墙、无 404、URL 稳定。缺点是与主域名不一致，审核员可能额外核对归属。

## 附：审核演示账号创建 Runbook（需你确认后执行）

1. 用一个专用邮箱注册 Papilot 账号（建议 `edge-review@` 前缀），完成邮箱验证。
2. 在账号管理页给该账号开通 **Pro**（或等价额度），额度只需支撑 5–10 次问答。
3. 在 Edge 扩展设置页用该账号登录一次，确认：
   - 登录成功；
   - 打开 `https://arxiv.org/abs/1706.03762` 能完成一次「解释选中」；
   - 计划额度消耗可见。
4. 把邮箱/密码/有效期写入 `store/edge/reader/review-notes.md` 的“审核账号”一节，并替换掉占位符。
5. 审核结束后可改密或停用该账号。

> 这一步是阅读扩展过审的**硬前提**：审核员不会自备模型 Key，也不会为你安装任何本地服务。
