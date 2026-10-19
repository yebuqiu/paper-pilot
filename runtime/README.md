# runtime/ —— 项目内置运行时

本目录用于**存放项目自带的运行时**，让 Papilot 账号后台与公网通道脱离
WorkBuddy（或其托管运行时）也能运行 —— **移动硬盘插到任何一台电脑，
双击 `启动Papilot后台.bat` 即可，不依赖系统目录、用户目录或注册表。**

## 目录结构

```
runtime/
├─ README.md            ← 本文件（入库）
├─ node/
│  └─ node.exe          ← Node 22.x 单文件运行时（不入库，随盘携带）
└─ cloudflared/
   ├─ README.md                    ← 公网通道说明（入库）
   ├─ cloudflared.exe              ← Cloudflare 隧道客户端（不入库，随盘携带）
   ├─ token.txt                    ← papilot 隧道令牌（不入库、敏感！）
   ├─ cloudflared-run-papilot.bat        ← 隧道运行器
   ├─ cloudflared-run-papilot-hidden.vbs ← 隐藏窗口启动器
   └─ logs/cf-run-papilot.log   ← 隧道运行日志（>20MB 自动轮换，不入库）
```

## 为什么只需要 node.exe 一个文件

- 账号后台 `server/` 是**零第三方依赖**的纯 Node 标准库实现（内置 `http`/`https`/`fs`）；
- 所以一个 `node.exe` 就够跑整个后台，不需要 `npm`、不需要安装程序、不需要写注册表。

## 运行时解析顺序（改一处必须同步全部消费方）

以下位置统一按此顺序解析 Node：

1. `runtime\node\node.exe`（项目自带，**首选**）
2. 系统 `PATH` 里的 `node`
3. `%USERPROFILE%\.workbuddy\binaries\node\versions\*`（历史兜底，取最新版）

消费方清单：`scripts\launcher.ps1`、`scripts\guard-papilot.ps1`、
`scripts\start-account-server.ps1`、`scripts\start-server-hidden.vbs`。

## 还需要外部依赖的部分

| 能力 | 是否需要外部依赖 | 说明 |
|---|---|---|
| 账号后台（:8000） | ❌ 不需要 | 走 `runtime\node\node.exe` |
| 公网通道 pp.xinglintools.top | ❌ 不需要 | 项目自带 `runtime\cloudflared\`（cloudflared.exe + token.txt + 运行器） |
| 官方模型网关（登录用户 /v1） | ⚠️ 需要上游通道 | 后台管理页/控制台配置任意 OpenAI 兼容上游 |
| 打包 / 门禁 / 发布脚本 | ⚠️ 需要 Python 3 | 仅开发自测需要，不影响运行 |
