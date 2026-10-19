# ============================================================
#  tunnel.ps1 — pp.xinglintools.top 公网通道管理器（项目内自包含 / 可移植）
#
#  用法：
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel\tunnel.ps1 start
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel\tunnel.ps1 stop
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel\tunnel.ps1 status
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel\tunnel.ps1 restart
#
#  可移植性设计：
#    * 所有路径相对本脚本位置解析 —— 移动硬盘换盘符 / 换电脑均可用（勿改成绝对路径）
#    * 令牌来自 runtime\cloudflared\token.txt（--token-file 传入，不落命令行）
#    * 指标端口固定 127.0.0.1:20250（与控制台探测、历史台账一致）
#    * start 幂等；就绪判据 = /ready 的 readyConnections > 0（端口通 ≠ 健康）
#    * stop 只结束本隧道进程（按命令行含 20250 匹配），不误伤同机其他隧道
# ============================================================
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'restart')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# ---------- 路径（全部相对脚本位置） ----------
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cfDir       = Join-Path $projectRoot 'runtime\cloudflared'
$cfExe       = Join-Path $cfDir 'cloudflared.exe'
$cfBat       = Join-Path $cfDir 'cloudflared-run-papilot.bat'
$tokenFile   = Join-Path $cfDir 'token.txt'
$logFile     = Join-Path $cfDir 'logs\cf-run-papilot.log'

$metricsPort = 20250
$readyUrl    = "http://127.0.0.1:$metricsPort/ready"
$publicUrl   = 'https://pp.xinglintools.top'

# 候选连接参数（按序尝试；针对不同网络环境兜底）
$profiles = @(
  @{ proto = 'http2'; edge = '4'; note = 'http2 + IPv4（默认）' },
  @{ proto = 'http2'; edge = '6'; note = 'http2 + IPv6（IPv4 出网受限的 ISP）' },
  @{ proto = 'quic';  edge = '4'; note = 'quic + IPv4（UDP 可用时）' }
)
$perProfileWaitSec = 30

# ---------- 基础函数 ----------
function Get-TunnelProcs {
  # 只认命令行里带本隧道 metrics 端口的 cloudflared（绝不误伤其他隧道）
  # 注意：返回必须写 ,@(...) 而不是 @(...) —— PowerShell 会“展平”单元素数组，
  #       裸对象（CimInstance）的 .Count 为空，曾导致 status 误报“未运行”（实测踩坑）。
  try {
    $list = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop
    return ,@($list | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf("$metricsPort") -ge 0 })
  } catch {
    # 兜底：netstat 反查端口 -> PID
    $procs = @()
    try {
      foreach ($line in (netstat -ano | Select-String ":$metricsPort\s")) {
        $f = ($line.ToString().Trim() -split '\s+')
        if ($f.Count -ge 5 -and $f[-2] -eq 'LISTENING') {
          $p = Get-Process -Id ([int]$f[-1]) -ErrorAction SilentlyContinue
          if ($p -and $p.ProcessName -eq 'cloudflared') { $procs += $p }
        }
      }
    } catch {}
    return ,@($procs)
  }
}

function Test-TunnelReady {
  try {
    $r = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    return ([int](($r.Content | ConvertFrom-Json).readyConnections) -gt 0)
  } catch { return $false }
}

function Get-ReadyInfo {
  try {
    return (Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop).Content | ConvertFrom-Json
  } catch { return $null }
}

function Stop-OurTunnel {
  $procs = Get-TunnelProcs
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  if ($procs.Count -gt 0) { Start-Sleep -Seconds 2 }
  return $procs.Count
}

# ---------- 动作 ----------
function Show-Status {
  $procs = Get-TunnelProcs
  $info = Get-ReadyInfo
  if ($procs.Count -gt 0) { Write-Host "运行状态 : 进程在（$($procs.Count) 个）" }
  else { Write-Host '运行状态 : 未运行' }
  if ($info) {
    Write-Host "边缘连接 : readyConnections=$($info.readyConnections)  connectorId=$($info.connectorId)"
  } elseif ($procs.Count -gt 0) {
    Write-Host '边缘连接 : 暂无（进程在但未建连，稍等或看日志）'
  }
  if (Test-Path $tokenFile) {
    $t = Get-Item $tokenFile
    Write-Host "令牌文件 : $($t.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))  $($t.Length) 字节"
  } else {
    Write-Host '令牌文件 : 缺失（运行 scripts\tunnel\refresh-token.ps1 从 _brain 取）'
  }
  Write-Host "指标地址 : http://127.0.0.1:$metricsPort/ready"
  Write-Host "日志文件 : $logFile"
  try {
    $r = Invoke-WebRequest -Uri 'https://pp.xinglintools.top/api/health' -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
    Write-Host "公网自检 : $publicUrl  HTTP $([int]$r.StatusCode)"
  } catch {
    Write-Host "公网自检 : $publicUrl  暂不可达（隧道未建连或后端未启动）"
  }
}

function Start-Tunnel {
  if (Test-TunnelReady) {
    Write-Host '隧道已在运行且边缘就绪（幂等，不做改动）'
    $info = Get-ReadyInfo
    Write-Host "  readyConnections=$($info.readyConnections)"
    return 0
  }
  if ((Get-TunnelProcs).Count -gt 0) {
    Write-Host '发现陈旧隧道进程（端口在但无边缘连接），先清理...'
    [void](Stop-OurTunnel)
  }
  $missing = @()
  if (-not (Test-Path $cfExe))     { $missing += $cfExe }
  if (-not (Test-Path $cfBat))     { $missing += $cfBat }
  if (-not (Test-Path $tokenFile)) { $missing += $tokenFile }
  if ($missing.Count -gt 0) {
    Write-Host '缺少必要文件：'
    foreach ($m in $missing) { Write-Host "  - $m" }
    Write-Host '提示：token.txt 可运行 scripts\tunnel\refresh-token.ps1 生成；cloudflared.exe 随项目携带。'
    return 1
  }
  $logDir = Split-Path -Parent $logFile
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

  foreach ($pf in $profiles) {
    Write-Host "尝试 $($pf.note) ..."
    Start-Process -FilePath $cfBat -ArgumentList $pf.proto, $pf.edge -WorkingDirectory $cfDir -WindowStyle Hidden
    $ok = $false
    for ($i = 0; $i -lt [int]($perProfileWaitSec / 2); $i++) {
      Start-Sleep -Seconds 2
      if (Test-TunnelReady) { $ok = $true; break }
    }
    if ($ok) {
      $info = Get-ReadyInfo
      Write-Host "隧道已建连：$($pf.note)  readyConnections=$($info.readyConnections)"
      Write-Host "公网地址：$publicUrl（自检可运行 status）"
      return 0
    }
    Write-Host "  ${perProfileWaitSec} 秒内未建连，换下一组参数..."
    [void](Stop-OurTunnel)
    Start-Sleep -Seconds 1
  }
  Write-Host '全部候选参数均未建连。最近日志：'
  if (Test-Path $logFile) { Get-Content $logFile -Tail 15 | ForEach-Object { Write-Host "  $_" } }
  return 1
}

function Stop-Tunnel {
  $n = Stop-OurTunnel
  if ($n -eq 0) { Write-Host '隧道本来未在运行（无改动）'; return 0 }
  Start-Sleep -Seconds 1
  if ((Get-TunnelProcs).Count -eq 0) { Write-Host "隧道已停止（结束 $n 个进程）"; return 0 }
  Write-Host '警告：仍有残留进程，请重试或到任务管理器检查'
  return 1
}

switch ($Action) {
  'status'  { Show-Status; exit 0 }
  'start'   { exit (Start-Tunnel) }
  'stop'    { exit (Stop-Tunnel) }
  'restart' { [void](Stop-Tunnel); Start-Sleep -Seconds 2; exit (Start-Tunnel) }
}
