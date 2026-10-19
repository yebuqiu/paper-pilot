# runtime/cloudflared —— 项目内自包含的公网通道（pp.xinglintools.top）

本目录让「公网通道」随项目一起走：**移动硬盘插到任何一台电脑，双击即可上线，
不依赖 `~/.cloudflared`、不依赖 `_brain` 保险库、不依赖用户目录。**

> 历史沿革：此前该隧道（papilot，a445d5c2）由 `~/.cloudflared`（用户目录）承载，
> 令牌解析经 `E:\project\_brain` 保险库 + `PapilotGuard` 计划任务；
> 项目迁入移动硬盘后整链失效（公网 530）。2026-10-16 迁移为项目内自包含版本
> （对齐「心血管科药物」项目 cvmech.top 的成熟模式）。

## 目录内容

```
runtime/cloudflared/
├─ README.md                          ← 本文件（入库）
├─ cloudflared.exe                    ← Cloudflare 隧道客户端（~55MB，不入库，随盘携带）
├─ token.txt                          ← papilot 隧道运行令牌（不入库、敏感！）
├─ .brain-config.json                 ← 便携取令牌用的 _brain 配置（不入库）
├─ cloudflared-run-papilot.bat     ← 运行器（单次运行；可传协议与 edge 版本两个参数）
├─ cloudflared-run-papilot-hidden.vbs ← 隐藏窗口启动器（供自启/守护用）
└─ logs/cf-run-papilot.log         ← 隧道运行日志（>20MB 自动轮换）
```

## 日常使用

| 操作 | 入口 | 说明 |
|---|---|---|
| 启动 | 根目录双击 `启动公网隧道.bat`，或控制台「公网通道」组点「启动」 | 幂等；自动挑选连接参数并等待建连成功 |
| 停止 | 根目录双击 `停止公网隧道.bat`，或控制台点「停止」 | 只停本隧道（按 metrics 端口 20250 匹配），不影响同机其他云隧道 |
| 状态 | `powershell -File scripts\tunnel\tunnel.ps1 status` | 进程 / 边缘连接 / 令牌 / 公网自检 |
| 重启 | 同上，`restart` | 停止后重新启动（换网络后连不上先用它） |
| 刷新令牌 | `powershell -File scripts\tunnel\refresh-token.ps1` | 从同级 `..\_brain` vault 重新提取 token.txt |

> 控制台（`启动Papilot后台.bat`）的「公网通道（pp.xinglintools.top）」组 ——
> 启动/停止/测试访问/日志按钮均已指向本目录。

## 关键参数（固定）

| 项 | 值 | 说明 |
|---|---|---|
| 隧道 | papilot（`a445d5c2-01e0-4d8b-b704-2b483f393d81`） | Cloudflare 侧 remotely-managed，ingress 在云端管理 |
| 回源 | `http://127.0.0.1:8000` | 即账号后台（`server/`，端口 8000） |
| 公网域名 | https://pp.xinglintools.top | 插件内 `account.js` 的 `SERVER_DEFAULT` 硬编码此地址 |
| metrics | `127.0.0.1:20250` | 健康判据 = `/ready` 的 readyConnections > 0（端口通 ≠ 健康） |
| 连接参数 | 默认 `http2 + IPv4`；备选 IPv6 / quic | `tunnel.ps1` 启动时自动依次尝试直到建连 |
| 令牌传递 | `--token-file token.txt` | 不进命令行，进程列表里看不到令牌 |

## 迁移到新电脑（最小步骤）

前提：项目目录（或整个移动硬盘）原样携带。

1. 插上硬盘，确认 `runtime\cloudflared\` 下 `cloudflared.exe` 与 `token.txt` 都在（随项目一起走）；
2. 双击根目录 `启动Papilot后台.bat` → 控制台窗口 → 「启动后台」（账号服务，8000）；
3. 控制台「公网通道」组点「启动」，等状态灯变绿「运行中（隧道已连接）」；
4. 浏览器打开 https://pp.xinglintools.top/api/health 验证（应返回 `{"ok":true,...}`）。

无需安装任何东西、无需管理员权限；本套脚本不写系统目录 / 用户目录 / 注册表。
若 `token.txt` 丢失或轮换：`powershell -File scripts\tunnel\refresh-token.ps1`
（需要同级 `..\_brain` 目录与私钥），或直接从旧机器复制 `token.txt`。

## 常见问题

| 现象 | 排查 |
|---|---|
| 公网 530 | 隧道没起或未建连：双击 `启动公网隧道.bat` 看提示；或看 `logs\cf-run-papilot.log` |
| 公网 502 | 隧道正常、后台没起：在控制台点「启动后台」（8000） |
| 控制台显示通道「未运行」 | 与 `tunnel.ps1 status` 同判据（20250 /ready）；确认 cloudflared.exe 未被安全软件拦截 |
| 换网络后连不上 | `tunnel.ps1 restart`（会自动换连接参数重试） |
| 插件提示连不上账号服务器 | 先 `curl https://pp.xinglintools.top/api/health` 判断是通道还是后端问题 |

## 安全说明

- `token.txt` 等同隧道运行凭证：**严禁提交 git、严禁外发**，本地备份即可。
- `.gitignore` 已排除：`cloudflared.exe` / `token.txt` / `.brain-config.json` / `logs/`。
- 令牌轮换（怀疑泄露）：Cloudflare 控制台轮换隧道令牌 → 更新 `_brain` vault →
  `refresh-token.ps1`，或直接替换 `token.txt`。
