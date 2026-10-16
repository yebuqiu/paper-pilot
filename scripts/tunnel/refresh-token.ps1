# ============================================================
#  refresh-token.ps1 — 从 _brain vault 取回 paperpilot 隧道令牌
#
#  维护用：换机器 / 令牌轮换后运行一次。日常启动不需要它。
#  写入 runtime\cloudflared\token.txt（已被 .gitignore 排除）。
#
#  依赖解析（全部随盘携带，无需安装）：
#    * _brain：优先 -BrainDir 参数 > 环境变量 BRAIN_DIR > 同级目录 ..\_brain
#    * node  ：_brain\bin\node.exe > 项目 runtime\node\node.exe > 系统 PATH
#    * 配置  ：runtime\cloudflared\.brain-config.json（路径字段留空，
#              brain-core 会按 _brain 自身位置相对解析 —— 换盘符不失效）
# ============================================================
param([string]$BrainDir = '')

$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cfDir    = Join-Path $projectRoot 'runtime\cloudflared'
$outFile  = Join-Path $cfDir 'token.txt'
$cfgFile  = Join-Path $cfDir '.brain-config.json'

# 1) 定位 _brain
if (-not $BrainDir) { $BrainDir = $env:BRAIN_DIR }
if (-not $BrainDir) { $BrainDir = Join-Path (Split-Path -Parent $projectRoot) '_brain' }
$printToken = Join-Path $BrainDir 'server\print-token.mjs'
if (-not (Test-Path $printToken)) {
  Write-Host "找不到 _brain：$BrainDir"
  Write-Host '（_brain 与项目同盘时应在 ..\_brain；也可用 -BrainDir 指定或设环境变量 BRAIN_DIR）'
  exit 1
}

# 2) node 解析
$node = $null
foreach ($c in @((Join-Path $BrainDir 'bin\node.exe'), (Join-Path $projectRoot 'runtime\node\node.exe'))) {
  if (Test-Path $c) { $node = $c; break }
}
if (-not $node) { $node = 'node' }

# 3) 便携配置
if (-not (Test-Path $cfgFile)) {
  Set-Content -Path $cfgFile -Value '{"host":"127.0.0.1","port":18808,"exposeSecretValues":false,"tokenHashes":[]}' -Encoding ASCII
}

# 4) 备份旧令牌 + 提取
if (Test-Path $outFile) {
  $bak = $outFile + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $outFile $bak -Force
  Write-Host "已备份旧令牌 -> $(Split-Path -Leaf $bak)"
}

& $node $printToken --config $cfgFile --section tunnel_paperpilot --out $outFile
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outFile)) {
  Write-Host '提取失败：见上面的错误输出（vault 私钥不全？section 名变了？）'
  exit 1
}

$tok = (Get-Content $outFile -Raw)
if ($tok.Length -lt 100 -or -not $tok.StartsWith('eyJ')) {
  Write-Host "校验失败：token.txt 内容不像 cloudflared 令牌（长度 $($tok.Length)）"
  exit 1
}
Write-Host "OK：已刷新 token.txt（$($tok.Length) 字节，前缀 $($tok.Substring(0, 8))…）"
exit 0
