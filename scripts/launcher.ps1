# ============================================================
# Papilot 后台 · 统一控制台 v1（WinForms GUI）
# 双击项目根目录"启动Papilot后台.bat"无窗拉起本脚本。
#
# 功能（对标心血管药物学习平台启动管理器，适配 Papilot 账号后台）：
#   1. 账号后台控制：启动 / 停止 / 重启 / 查看日志 / 状态灯（端口 8000 健康检测）
#   2. AI 模型通道管理：列表 / 新增 / 编辑 / 删除 / 设为活动 / 实测 / 🔍检测 / 📡拉取模型
#      （通道 = 官方网关上游池；Zotero 插件登录用户经 /v1 网关使用活动通道）
#   3. 账号管理：注册账号 / 用户列表 / 重置密码 / 删除用户
#      会员管理（0.23.0）：订单核销开通 / 激活码生成与作废 / 套餐与收款配置 / 用户开通续期
#   4. 维护：开机自启（HKCU Run 键） / 数据目录 / 项目目录 / 浏览器管理页
#   5. 关闭窗口 = 最小化到系统托盘驻留；托盘右键「退出程序」为唯一真正退出
#
# 兼容 Windows PowerShell 5.1（勿用 PS7+ 语法：禁 ?? ?. 三元 && ||）。
# ============================================================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic
try { [void][System.Windows.Forms.Application]::EnableVisualStyles() } catch {}

# ---------------- 启动日志 / 致命错误兜底 ----------------
# bat 用 wscript 隐藏拉起本脚本：如果脚本在窗口出现前就失败，用户只会看到「双击没反应」。
# 这里把每个启动阶段写进 %TEMP%\papilot-launcher-boot.log，并用 trap 弹窗（默认桌面，
# 避免隐藏进程的弹窗被其他窗口盖住）。
$script:BootLog = Join-Path $env:TEMP 'papilot-launcher-boot.log'
function Write-Boot([string]$msg) {
  try {
    $line = '[' + (Get-Date).ToString('HH:mm:ss.fff') + '] ' + $msg + "`r`n"
    [System.IO.File]::AppendAllText($script:BootLog, $line, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}
Write-Boot ('boot: pid=' + $PID + ' ps=' + $PSVersionTable.PSVersion.ToString())

trap {
  $detail = 'FATAL: ' + $_.Exception.ToString()
  Write-Boot $detail
  try {
    [System.Windows.Forms.MessageBox]::Show(
      '控制台启动失败：' + $_.Exception.Message + "`n`n日志：" + $script:BootLog,
      'Papilot 后台', 'OK', 'Error', 'Button1', 'DefaultDesktopOnly') | Out-Null
  } catch { }
  exit 1
}

# DPI 感知 + 窗口查找（重复启动时把已有窗口拉到前台，而不是弹一个看不见的提示）
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PpWin32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  // 第一参数用 IntPtr：PowerShell 的 $null 传给 string 参数会marshal成空串而不是 NULL，
  // FindWindow 用空串找不到任何窗口（曾导致重复启动判断永远失败）。
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(IntPtr lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  // 窗口应答探测：进程活着 != 界面能用。UI 线程被同步探测卡住时，
  // SetForegroundWindow 会被排队但永不处理，用户看到的就是「再双击也没反应」。
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg,
      IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
'@
[void][PpWin32]::SetProcessDPIAware()

# 全局异常兜底：WinForms 的事件处理器里一旦抛出未捕获异常，进程会**静默退出**。
# 这里统一记录到 %TEMP%\papilot-launcher-error.log 并弹窗，避免“点一下窗口就没了”。
try {
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
  [System.Windows.Forms.Application]::add_ThreadException({
    param($s, $e)
    $log = Join-Path $env:TEMP 'papilot-launcher-error.log'
    try {
      $line = '[' + (Get-Date).ToString('o') + '] ' + $e.Exception.ToString() + "`r`n"
      [System.IO.File]::AppendAllText($log, $line, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
    try {
      [System.Windows.Forms.MessageBox]::Show(
        '界面异常：' + $e.Exception.Message + "`n`n日志：" + $log,
        'Papilot 控制台', 'OK', 'Error', 'Button1', 'DefaultDesktopOnly') | Out-Null
    } catch { }
  })
} catch { }

# 单实例锁：已在运行则把窗口拉到前台；正在启动则等 5 秒；确实找不到才提示。
$script:mutex = New-Object System.Threading.Mutex($false, 'PapilotLauncherMutex')
if (-not $script:mutex.WaitOne(0)) {
  $hwnd = [PpWin32]::FindWindow([IntPtr]::Zero, 'Papilot 后台 · 控制台')
  if ($hwnd -eq [IntPtr]::Zero) {
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Milliseconds 500
      $hwnd = [PpWin32]::FindWindow([IntPtr]::Zero, 'Papilot 后台 · 控制台')
      if ($hwnd -ne [IntPtr]::Zero) { break }
    }
  }
  if ($hwnd -ne [IntPtr]::Zero) {
    # 把已有实例的 PID 写进 pid 文件：bat 用它做「是否真的起来了」的存活判断。
    $ownerPid = [uint32]0
    try {
      [void][PpWin32]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
      if ($ownerPid -gt 0) {
        [System.IO.File]::WriteAllText((Join-Path $env:TEMP 'papilot-launcher.pid'), [string]$ownerPid,
          (New-Object System.Text.UTF8Encoding($false)))
      }
    } catch { }

    # ★ 进程活着 ≠ 界面能用。UI 线程被同步探测卡死时，ShowWindow/SetForegroundWindow
    #   只会被排队、永远不处理 —— 用户看到的正是「再双击也没反应」。
    #   这里用 400ms 窗口应答探测区分两种情形，卡住时给一键重启（不影响后台服务）。
    $probe = [IntPtr]::Zero
    $answered = [PpWin32]::SendMessageTimeout($hwnd, 0, [IntPtr]::Zero, [IntPtr]::Zero, 2, 400, [ref]$probe)
    if ($answered -ne [IntPtr]::Zero) {
      [void][PpWin32]::ShowWindow($hwnd, 9)
      [void][PpWin32]::SetForegroundWindow($hwnd)
      Write-Boot 'duplicate launch: activated existing window'
      exit 0
    }

    Write-Boot ('duplicate launch: window found but NOT responding (pid=' + $ownerPid + ')')
    $ans = [System.Windows.Forms.MessageBox]::Show(
      '控制台已经在运行，但界面 400ms 内没有响应（UI 线程被卡住了）。' + "`n`n" +
      '要结束它并重新打开吗？' + "`n" +
      '账号后台与公网通道是独立进程，不受影响。',
      'Papilot 后台 · 界面无响应', 'YesNo', 'Warning', 'Button1', 'DefaultDesktopOnly')
    if ($ans -eq 'Yes' -and $ownerPid -gt 0) {
      try { Stop-Process -Id ([int]$ownerPid) -Force -ErrorAction Stop } catch { }
      # 等旧进程真的消失再拉起：否则新实例会抢不到单实例锁，落到「已在运行但没窗口」分支。
      for ($i = 0; $i -lt 30; $i++) {
        $still = $false
        try { [void](Get-Process -Id ([int]$ownerPid) -ErrorAction Stop); $still = $true } catch { $still = $false }
        if (-not $still) { break }
        Start-Sleep -Milliseconds 100
      }
      try { Remove-Item (Join-Path $env:TEMP 'papilot-launcher.pid') -Force -ErrorAction SilentlyContinue } catch { }
      try {
        # 这里不能复用 Start-HiddenProcess：它在脚本更后面才定义，而这段代码在启动早期执行。
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '"'
        $psi.WorkingDirectory = (Split-Path -Parent $PSScriptRoot)
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        [void][System.Diagnostics.Process]::Start($psi)
      } catch { }
      Write-Boot 'duplicate launch: killed hung instance and relaunched'
    }
    exit 0
  }
  Write-Boot 'duplicate launch: mutex held but no window found'
  [System.Windows.Forms.MessageBox]::Show(
    '控制台已在运行，但窗口没找到（可能正在启动或卡在初始化）。' + "`n`n请等 10 秒再双击；仍然不行就查看日志：" + $script:BootLog,
    'Papilot 后台', 'OK', 'Warning', 'Button1', 'DefaultDesktopOnly') | Out-Null
  exit 0
}
try {
  [System.IO.File]::WriteAllText((Join-Path $env:TEMP 'papilot-launcher.pid'), [string]$PID,
    (New-Object System.Text.UTF8Encoding($false)))
} catch { }
Write-Boot 'mutex acquired'

# ---------------- 配置 ----------------
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ServerDir   = Join-Path $ProjectRoot 'server'
$DataDir     = Join-Path $ServerDir 'data'
$ServerLog   = Join-Path $DataDir 'server-console.log'
# stdout 与 Node 自身日志分开：cmd 的 >> 会独占句柄，若指向 server-console.log
# 会把服务端 log() 的 appendFileSync 锁死（1.8.0 排障实测），故单独落一份。
$StdoutLog   = Join-Path $DataDir 'server-stdout.log'
$Port        = 8000
$AdminPage   = 'http://127.0.0.1:' + $Port + '/admin'
$HealthUrl   = 'http://127.0.0.1:' + $Port + '/api/health'
Write-Boot ('root=' + $ProjectRoot)

# ---------------- 公网通道（Cloudflare 隧道，项目内自包含 2026-10-16） ----------------
# 依赖全部在 runtime\cloudflared\（cloudflared.exe + token.txt + 运行器），
# 随移动硬盘走：换电脑 / 换盘符均可直接使用（勿改成绝对路径）。
$CfDir             = Join-Path $ProjectRoot 'runtime\cloudflared'
$TunnelBat         = Join-Path $CfDir 'cloudflared-run-papilot.bat'
$TunnelLog         = Join-Path $CfDir 'logs\cf-run-papilot.log'
$TunnelTokenFile   = Join-Path $CfDir 'token.txt'
$TunnelMetricsPort = 20250
$TunnelReadyUrl    = 'http://127.0.0.1:' + $TunnelMetricsPort + '/ready'
$SiteUrl           = 'https://pp.xinglintools.top'

# ---------------- node 路径：项目自带运行时优先，历史兜底扫描 ----------------
function Resolve-NodeExe {
  # 1) 项目自带运行时（移动硬盘换机首选）
  $local = Join-Path $ProjectRoot 'runtime\node\node.exe'
  if (Test-Path $local) { return $local }
  # 2) 历史兜底：扫描 managed 目录取最新版本
  $base = 'C:\Users\Administrator\.workbuddy\binaries\node\versions'
  try {
    $dirs = Get-ChildItem $base -Directory -ErrorAction Stop | Where-Object {
      Test-Path (Join-Path $_.FullName 'node.exe')
    } | Sort-Object {
      $k = 0
      if ($_.Name -match '^(\d+)\.(\d+)\.(\d+)') {
        $k = [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3]
      }
      $k
    } -Descending
    if ($dirs -and $dirs.Count -gt 0) { return Join-Path $dirs[0].FullName 'node.exe' }
  } catch {}
  return 'node'
}
$NodeExe = Resolve-NodeExe
Write-Boot ('node=' + $NodeExe)

# ---------------- 进程/网络检测 ----------------
function Start-HiddenProcess($fileName, $arguments, $workDir) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $fileName
  $psi.Arguments = $arguments
  $psi.WorkingDirectory = $workDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Get-PortOwnerPid {
  # ★ 不要用 Get-NetTCPConnection：本机实测 1200ms（走 CIM 提供程序），在 UI 线程上就是硬卡顿。
  #   netstat -ano 约 100ms，且不依赖 WMI 服务健康状态。
  try {
    $lines = & "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null
    foreach ($ln in $lines) {
      if (-not $ln) { continue }
      $parts = ($ln -replace '\s+', ' ').Trim().Split(' ')
      if ($parts.Length -lt 5) { continue }
      if ($parts[1] -notmatch (':' + $Port + '$')) { continue }
      if ($parts[3] -ne 'LISTENING') { continue }
      $p = 0
      if ([int]::TryParse($parts[4], [ref]$p)) { return $p }
    }
  } catch {}
  return 0
}

# ★ 快探测：TCP 连接 150ms 就够（Get-NetTCPConnection 在本机要 200~800ms，
#   每 3 秒跑一次会把 UI 拖出可感知的卡顿）。PID 只用于展示，缓存 15 秒。
function Test-PortOpen([int]$p, [int]$TimeoutMs = 150) {
  $c = $null
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { $c.EndConnect($iar); return $true }
    return $false
  } catch { return $false } finally { if ($c) { try { $c.Close() } catch {} } }
}

$script:portPidCache = 0
function Get-PortOwnerPidCached {
  # PID 只为展示：拿到一次就一直用（进程活着就返回）；停止/重启时主动清缓存。
  # 不再按时间轮询 Get-NetTCPConnection——那是本机最慢的一步。
  if ($script:portPidCache -gt 0) {
    try { [void](Get-Process -Id $script:portPidCache -ErrorAction Stop); return $script:portPidCache } catch { $script:portPidCache = 0 }
  }
  $p = Get-PortOwnerPid
  $script:portPidCache = $p
  return $p
}
function Clear-PortPidCache { $script:portPidCache = 0 }

$script:srvProcCache = @()
$script:srvProcAt = [datetime]::MinValue
function Get-ServerProcessCached {
  # 仅在端口不通时用于识别「进程在但端口未起」；60 秒一次足够，避免停止状态每拍跑 CIM
  if (((Get-Date) - $script:srvProcAt).TotalSeconds -lt 60) { return $script:srvProcCache }
  $script:srvProcCache = @(Get-ServerProcess)
  $script:srvProcAt = Get-Date
  return $script:srvProcCache
}

# 兜底判定：命令行匹配（识别"进程在但端口未通"的启动窗口期/僵尸）
function Get-ServerProcess {
  try {
    $list = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
    return @($list | Where-Object {
      $_.CommandLine -and $_.CommandLine.IndexOf('account-server.js') -ge 0
    })
  } catch { return @() }
}

function Test-Health {
  # ⚠ 仅用于显式诊断（一次 1 秒的同步 HTTP）。UI 定时器 / 点击链路一律走
  #   Get-HealthCached（带端口前置 + 负缓存），不要再直接调用本函数。
  try {
    $r = Invoke-RestMethod -Uri $HealthUrl -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    return ($null -ne $r -and $r.ok)
  } catch { return $false }
}

function Get-ProcName([int]$procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return '' }
}

function Get-ProcessStart([int]$procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).StartTime } catch { return $null }
}

# 服务状态机：running（端口通且健康）/ degraded（端口通但健康不过且进程超 30 秒）
#             starting（启动窗口期）/ stopped
# HealthOk：调用方从健康快照传入（$true/$false/$null），避免重复 HTTP；
# 端口探测用 150ms TCP 连接，不再每拍跑 Get-NetTCPConnection。
function Get-ServerState([object]$HealthOk = $null) {
  if (Test-PortOpen $Port 150) {
    $portPid = Get-PortOwnerPidCached
    if ($HealthOk -eq $true) { return @{ State = 'running'; PortPid = $portPid } }
    # ★ 这里不再兜底调 Test-Health：那是一次 1 秒的同步 HTTP，藏在状态机里最容易被忽略。
    #   健康快照由 Get-HealthCached 统一负责（带端口前置 + 负缓存），调用方传入即可。
    $age = 999
    $started = $null
    if ($portPid -gt 0) { $started = Get-ProcessStart $portPid }
    if ($started) { $age = ((Get-Date) - $started).TotalSeconds }
    if ($age -lt 30) { return @{ State = 'starting'; PortPid = $portPid } }
    return @{ State = 'degraded'; PortPid = $portPid }
  }
  if ((Get-ServerProcessCached).Count -gt 0) { return @{ State = 'starting'; PortPid = 0 } }
  return @{ State = 'stopped'; PortPid = 0 }
}

# ---------------- 公网通道：进程/健康检测与启停 ----------------
function Get-TunnelProcess {
  # 只认命令行里带本隧道 metrics 端口（20250）的 cloudflared，绝不误伤同机其他隧道。
  # 注意：return ,@(...) 不能省 —— PowerShell 会“展平”单元素数组，裸对象 .Count 为空。
  try {
    $list = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop
    return ,@($list | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf([string]$TunnelMetricsPort) -ge 0 })
  } catch { return ,@() }
}

# CIM 查询在进程多/杀软扫描时可达数百毫秒：UI 每拍都用缓存，只有用户主动操作才强制刷新。
$script:tunProcCache = @()
$script:tunProcAt = [datetime]::MinValue
function Get-TunnelProcessCached([int]$MaxAgeSec = 30) {
  if (((Get-Date) - $script:tunProcAt).TotalSeconds -lt $MaxAgeSec) { return $script:tunProcCache }
  $script:tunProcCache = @(Get-TunnelProcess)
  $script:tunProcAt = Get-Date
  return $script:tunProcCache
}
function Clear-TunnelProcessCache { $script:tunProcAt = [datetime]::MinValue }

function Test-TunnelReady {
  # 就绪判据 = /ready 的 readyConnections > 0（端口通 ≠ 健康）。
  # ★ 400ms 硬超时：隧道「进程活着但连不上边缘」时 /ready 会挂很久，
  #   用 Invoke-RestMethod 的 1 秒超时也会拖住 UI；这里用 WebRequest 精确到毫秒。
  try {
    $req = [System.Net.WebRequest]::Create($TunnelReadyUrl)
    $req.Timeout = 400
    $req.ReadWriteTimeout = 400
    $req.Proxy = $null
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $txt = $sr.ReadToEnd()
    $sr.Close()
    $resp.Close()
    $r = $txt | ConvertFrom-Json
    return ([int]$r.readyConnections -gt 0)
  } catch { return $false }
}

function Start-Tunnel {
  if ((Get-TunnelProcess).Count -gt 0) { return 'already' }
  if (-not (Test-Path $TunnelBat)) { return 'missing' }
  if (-not (Test-Path $TunnelTokenFile)) { return 'no-token' }
  try {
    Start-HiddenProcess 'cmd.exe' ('/c "' + $TunnelBat + '"') $CfDir
    Clear-TunnelProcessCache
    return 'started'
  } catch {
    return 'error:' + $_.Exception.Message
  }
}

function Stop-Tunnel {
  $killed = 0
  foreach ($p in (Get-TunnelProcess)) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
  }
  Clear-TunnelProcessCache
  return $killed
}

# ---------------- 后台启停 ----------------
function Start-Server {
  Clear-PortPidCache
  $script:srvProcAt = [datetime]::MinValue
  $portPid = Get-PortOwnerPid
  if ($portPid -gt 0) {
    $name = Get-ProcName $portPid
    if ($name -eq 'node') { return 'already' }
    return 'occupied:' + $name + ':' + $portPid
  }
  if ((Get-ServerProcess).Count -gt 0) { return 'starting' }
  try {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    # 清除手动停机标记：用户点了启动 = 明确要服务运行（PapilotGuard 守护据此恢复守护）
    Remove-Item (Join-Path $DataDir 'stopped-account.flag') -Force -ErrorAction SilentlyContinue
    if ((Test-Path $ServerLog) -and (Get-Item $ServerLog).Length -gt 20MB) {
      $rotName = 'server-console-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'
      Move-Item $ServerLog (Join-Path $DataDir $rotName) -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path $StdoutLog) -and (Get-Item $StdoutLog).Length -gt 20MB) {
      $rotName2 = 'server-stdout-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'
      Move-Item $StdoutLog (Join-Path $DataDir $rotName2) -Force -ErrorAction SilentlyContinue
    }
    # ★ stdout/stderr 走独立文件：不能和 Node 的 server-console.log 共用，
    #   否则 cmd 的独占写句柄会让服务端 log() 静默失败。
    $cmdArgs = '/c ""' + $NodeExe + '" account-server.js >> "' + $StdoutLog + '" 2>&1"'
    Start-HiddenProcess 'cmd.exe' $cmdArgs $ServerDir
    return 'started'
  } catch {
    return 'error:' + $_.Exception.Message
  }
}

function Stop-Server {
  $killed = 0
  $portPid = Get-PortOwnerPid
  # ★ 先留痕再杀：Stop-Process -Force 走 TerminateProcess，服务端的 SIGTERM 处理器
  #   （account-server.js 的 shutdown）永远不会执行，日志里就不会有 shutdown 记录 ——
  #   历史上「后端无声消失」查不出是谁动的手，就是缺了这一行。
  if ($portPid -gt 0) {
    try {
      $enc = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::AppendAllText($ServerLog,
        ('[' + (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + '] (launcher) stop-server: terminate pid ' + $portPid + "`r`n"), $enc)
    } catch { }
  }
  if ($portPid -gt 0) {
    try { Stop-Process -Id $portPid -Force -ErrorAction Stop; $killed++ } catch {}
  }
  foreach ($p in (Get-ServerProcess)) {
    if ($p.ProcessId -ne $portPid) {
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
    }
  }
  # 手动停机标记：看门狗 / PapilotGuard 看到此标记不会复活服务（下次 Start-Server 自动清除）。
  # ★ 不看 $killed：用户点了「停止」就是明确意图，哪怕当时进程已经不在，也不该被 9 秒后自动拉起。
  try { Set-Content (Join-Path $DataDir 'stopped-account.flag') ('stopped by launcher @ ' + (Get-Date).ToString('o') + ' killed=' + $killed) -Encoding ASCII } catch {}
  Clear-PortPidCache
  $script:srvProcAt = [datetime]::MinValue
  return $killed
}

function Show-StartResult([string]$r) {
  if ($r -eq 'started') {
    $lblMsg.Text = '服务启动中，请稍候…'
    $script:pendingSince = Get-Date
    $script:timeoutNotified = $false
  } elseif ($r -eq 'already') {
    $lblMsg.Text = '后台服务已在运行'
  } elseif ($r -eq 'starting') {
    $lblMsg.Text = '服务正在启动中，请稍候…'
    $script:pendingSince = Get-Date
  } elseif ($r.StartsWith('occupied:')) {
    $rest = $r.Substring(9)
    $i = $rest.LastIndexOf(':')
    $occName = $rest.Substring(0, $i)
    $occPid = $rest.Substring($i + 1)
    [System.Windows.Forms.MessageBox]::Show(('端口 {0} 被 {1}（PID {2}）占用，请先关闭该程序再启动。' -f $Port, $occName, $occPid), '端口被占用', 'OK', 'Warning') | Out-Null
    $lblMsg.Text = '端口 ' + $Port + ' 被占用，未能启动'
  } elseif ($r.StartsWith('error:')) {
    $lblMsg.Text = '启动失败：' + $r.Substring(6)
  }
}

# ---------------- 管理 API 封装 ----------------
function Invoke-AdminApi([string]$method, [string]$path, $body) {
  $params = @{
    Method = $method
    Uri = ('http://127.0.0.1:' + $Port + $path)
    UseBasicParsing = $true
    # ★ 30s 会让「保存」这类按钮把整个窗口冻住半分钟；本机回环 8s 已经非常宽裕。
    TimeoutSec = 8
    ErrorAction = 'Stop'
  }
  if ($null -ne $body) {
    # PS5.1：字符串 Body 按 ContentType 的 charset 编码，必须显式 utf-8 否则中文昵称会乱码
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = ($body | ConvertTo-Json -Compress -Depth 6)
  }
  return Invoke-RestMethod @params
}

# 从异常响应体里提取后端真实错误（4xx/5xx 时 Invoke-RestMethod 抛异常）
function Get-HttpErrorDetail($err) {
  try {
    $resp = $err.Exception.Response
    if ($resp) {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $raw = $sr.ReadToEnd()
      $sr.Close()
      if ($raw) {
        try {
          $j = $raw | ConvertFrom-Json
          if ($j.error) { return $j.error }
          if ($j.message) { return $j.message }
        } catch {}
        if ($raw.Length -gt 120) { $raw = $raw.Substring(0, 120) }
        return $raw
      }
    }
  } catch {}
  return $err.Exception.Message
}

function Require-ServerRunning {
  # 走缓存（8s），别在这里再开一次同步 HTTP——点击链路上每多一次探测就多一次白屏
  if (Get-HealthCached 8) { return $true }
  [System.Windows.Forms.MessageBox]::Show('账号后台服务未运行，请先在主窗口点击「启动后台」。', '服务未运行', 'OK', 'Warning') | Out-Null
  return $false
}

# ---------------- 品牌图标（优先用插件自带 icon.png，失败则自绘） ----------------
function New-FallbackIcon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $s = $size / 64.0
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $cr = 14 * $s
  $bgPath.AddArc(0, 0, (2 * $cr), (2 * $cr), 180, 90)
  $bgPath.AddArc(($size - 2 * $cr), 0, (2 * $cr), (2 * $cr), 270, 90)
  $bgPath.AddArc(($size - 2 * $cr), ($size - 2 * $cr), (2 * $cr), (2 * $cr), 0, 90)
  $bgPath.AddArc(0, ($size - 2 * $cr), (2 * $cr), (2 * $cr), 90, 90)
  $bgPath.CloseFigure()
  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(13, 21, 38))
  $g.FillPath($bgBrush, $bgPath)
  $font = New-Object System.Drawing.Font('Segoe UI', [float](30 * $s), [System.Drawing.FontStyle]::Bold)
  $br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF(0, (2 * $s), $size, $size)
  $g.DrawString('P', $font, $br, $rect, $sf)
  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(37, 99, 235))
  $g.FillEllipse($dotBrush, [float](46 * $s), [float](8 * $s), [float](9 * $s), [float](9 * $s))
  $dotBrush.Dispose(); $br.Dispose(); $font.Dispose(); $sf.Dispose()
  $bgBrush.Dispose(); $bgPath.Dispose(); $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$script:appIcon = $null
try {
  $iconPng = Join-Path $ProjectRoot 'chrome\content\icons\icon.png'
  if (Test-Path $iconPng) {
    $bmp = New-Object System.Drawing.Bitmap($iconPng)
    $script:appIcon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  }
} catch {}
if ($null -eq $script:appIcon) { $script:appIcon = New-FallbackIcon 32 }

# ---------------- 页面/目录打开 ----------------
function Open-Url([string]$url) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $url
    $psi.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
  } catch {}
}

# ============================================================
# 通道管理对话框（列表 + 新增/编辑/删除/切换/实测）
# ============================================================
$script:providerRows = @()

function Get-ProviderName([string]$pid_) {
  foreach ($p in $script:providerRows) { if ($p.id -eq $pid_) { return $p.name } }
  return '自定义'
}

# ISO 时间 → 列表短格式（0.23.0 会员管理复用）
function Format-Dt([string]$s) {
  if (-not $s) { return '—' }
  $t = ([string]$s).Replace('T', ' ')
  if ($t.Length -ge 16) { return $t.Substring(0, 16) }
  return $t
}

# 字节数 → 可读（1.4.4 审计日志体积）
function Format-Bytes([object]$n) {
  $v = 0.0
  try { $v = [double]$n } catch { $v = 0 }
  if ($v -lt 1024) { return ([string][int]$v + ' B') }
  if ($v -lt 1048576) { return ([string][math]::Round($v / 1024, 1) + ' KB') }
  return ([string][math]::Round($v / 1048576, 2) + ' MB')
}

# 审计条目里的 before/after 压缩成一行（太长会撑爆列表列宽）
function ConvertTo-ShortJson([object]$o) {
  if ($null -eq $o) { return '' }
  $s = ''
  try { $s = ($o | ConvertTo-Json -Compress -Depth 4) } catch { return '' }
  if (-not $s) { return '' }
  if ($s.Length -gt 90) { return $s.Substring(0, 90) + '…' }
  return $s
}

# 对账结果 → 中文（服务端 1.4.5；与服务端 lib/reconcile.js 的 STATUS_TEXT 对齐）
function Get-ReconcileStatusText([string]$st) {
  if ($st -eq 'matched')   { return '命中' }
  if ($st -eq 'unmatched') { return '无对应订单' }
  if ($st -eq 'ambiguous') { return '需人工确认' }
  if ($st -eq 'duplicate') { return '重复流水' }
  return $st
}

# 审计动作中文名（与服务端 lib/audit.js 的 ACTIONS 对齐；未知动作原样返回）
function Get-AuditText([string]$a) {
  $map = @{
    'user.create' = '新建用户'; 'user.update' = '修改用户'; 'user.password' = '重置密码'; 'user.change-password' = '修改密码'; 'user.change-email' = '改绑邮箱'; 'user.delete-account' = '注销账号'
    'user.delete' = '删除用户'; 'user.unlock' = '解除登录锁定'; 'user.membership' = '开通/续期会员'
    'price.create' = '新增价格条目'; 'price.update' = '修改价格条目'; 'price.delete' = '删除价格条目'
    'membership.config' = '修改会员/收款配置'
    'order.fulfill' = '核销开通订单'
    'order.pay' = '在线支付自动入账'
    'pay.config' = '修改支付网关配置'; 'order.cancel' = '取消订单'; 'order.reconcile' = '对账自动核销'
    'coupon.create' = '生成优惠券'; 'coupon.update' = '修改优惠券'; 'coupon.revoke' = '作废优惠券'
    'session.revoke' = '踢出登录设备'; 'session.revoke-others' = '踢出其他全部设备'; 'session.revoke-admin' = '管理员踢出设备'; 'session.label' = '给设备命名'
    'code.create' = '生成激活码'; 'code.revoke' = '作废激活码'
    'backup.create' = '手动打快照'; 'backup.restore' = '回滚数据'; 'backup.delete' = '删除快照'
    'alert.check' = '手动巡检积压告警'
    'channel.create' = '新增模型通道'; 'channel.update' = '修改模型通道'
    'channel.delete' = '删除模型通道'; 'channel.active' = '切换活动通道'
    'channel.published' = '修改上线模型清单'
    'channel.high-tier' = '修改高级模型清单'
    'pricing.update' = '修改 AI 模型单价'
    'balance.adjust' = '充值/调整余额'
  }
  if ($map.ContainsKey($a)) { return $map[$a] }
  return $a
}

# 订单状态 → 中文（0.23.0）
function Get-OrderStatusText([string]$st) {
  if ($st -eq 'pending')   { return '待支付' }
  if ($st -eq 'claimed')   { return '待核销' }
  if ($st -eq 'fulfilled') { return '已开通' }
  if ($st -eq 'cancelled') { return '已取消' }
  if ($st -eq 'expired')   { return '已过期' }
  return $st
}

# 激活码状态 → 中文（0.23.0）
function Get-CodeStatusText([string]$st) {
  if ($st -eq 'unused')  { return '未使用' }
  if ($st -eq 'used')    { return '已使用' }
  if ($st -eq 'expired') { return '已过期' }
  return $st
}

# 用户会员摘要（0.23.0 账号列表「会员到期」列）
function Get-MembershipText($u) {
  $m = $u.membership
  if (-not $m -or -not $m.expiresAt) {
    if ($u.planRaw -and ([string]$u.planRaw) -ne 'Free') { return ([string]$u.planRaw) + '（无到期）' }
    return '—'
  }
  $d = ([string]$m.expiresAt).Substring(0, 10)
  if ($m.expired) { return '已过期 · ' + $d }
  return ('剩 ' + $m.daysLeft + ' 天 · ' + $d)
}

function Show-ChannelManager {
  if (-not (Require-ServerRunning)) { return }

  # 预设目录（一次拉取，供表单复用）
  try { $script:providerRows = @(Invoke-AdminApi 'GET' '/api/admin/providers').providers }
  catch { $script:providerRows = @() }

  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = 'AI 模型通道管理（官方网关上游）'
  $dlg.ClientSize = New-Object System.Drawing.Size(568, 570)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = '通道 = 官方网关的上游：登录用户经 /v1 网关调用「活动通道」；auto 自动映射为「官方默认模型」，可在下方下拉选择或自定义输入。'
  $hint.ForeColor = [System.Drawing.Color]::DimGray
  $hint.SetBounds(12, 10, 544, 34)
  [void]$dlg.Controls.Add($hint)

  $lb = New-Object System.Windows.Forms.ListBox
  $lb.Font = New-Object System.Drawing.Font('Consolas', 9.5)
  $lb.HorizontalScrollbar = $true
  $lb.SetBounds(12, 46, 544, 250)
  $lb.IntegralHeight = $false
  [void]$dlg.Controls.Add($lb)

  $lblInfo = New-Object System.Windows.Forms.Label
  $lblInfo.Text = ''
  $lblInfo.ForeColor = [System.Drawing.Color]::DimGray
  $lblInfo.SetBounds(12, 300, 544, 20)
  [void]$dlg.Controls.Add($lblInfo)

  # 官方默认模型快捷行：活动通道的 model 字段 = 登录用户 auto 映射的模型
  $lblDef = New-Object System.Windows.Forms.Label
  $lblDef.Text = '官方默认模型：'
  $lblDef.SetBounds(12, 331, 94, 18)
  [void]$dlg.Controls.Add($lblDef)
  $cmbDefault = New-Object System.Windows.Forms.ComboBox
  $cmbDefault.DropDownStyle = 'DropDown'
  $cmbDefault.SetBounds(108, 328, 296, 24)
  [void]$dlg.Controls.Add($cmbDefault)

  # 对外上线模型行（0.15.0）：逗号分隔；留空 = 全部上线；auto 恒可用
  $lblPub = New-Object System.Windows.Forms.Label
  $lblPub.Text = '对外上线模型：'
  $lblPub.SetBounds(12, 362, 96, 18)
  [void]$dlg.Controls.Add($lblPub)
  $txtPub = New-Object System.Windows.Forms.TextBox
  $txtPub.SetBounds(108, 358, 296, 24)
  [void]$dlg.Controls.Add($txtPub)

  # 高级模型分级（1.4.9）：逗号分隔，必须落在上面的上线清单内；留空 = 不做分级全部免费
  $lblHigh = New-Object System.Windows.Forms.Label
  $lblHigh.Text = '高级模型(需Pro)：'
  $lblHigh.SetBounds(12, 396, 96, 18)
  [void]$dlg.Controls.Add($lblHigh)
  $txtHigh = New-Object System.Windows.Forms.TextBox
  $txtHigh.SetBounds(108, 392, 296, 24)
  [void]$dlg.Controls.Add($txtHigh)

  $script:cmRows = @()
  $script:cmActiveId = $null

  function New-DlgBtn($parent, [string]$text, [int]$x, [int]$y, [int]$w, $handler) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object System.Drawing.Point($x, $y)
    $b.Size = New-Object System.Drawing.Size($w, 30)
    $b.add_Click($handler)
    [void]$parent.Controls.Add($b)
    return $b
  }

  function Refresh-CmList {
    try {
      $r = Invoke-AdminApi 'GET' '/api/admin/channels'
      $script:cmRows = @($r.channels)
      $script:cmActiveId = $r.active
      $lb.Items.Clear()
      $i = 0
      foreach ($c in $r.channels) {
        $mark = '  '
        if ($c.id -eq $r.active) { $mark = '●' }
        $prov = Get-ProviderName $c.provider
        [void]$lb.Items.Add(('{0} {1,-22} [{2}] {3}  {4}' -f $mark, $c.name, $c.model, $c.apiKeyMasked, $prov))
        $i++
      }
      $actCh = $null
      foreach ($c in $r.channels) { if ($c.id -eq $r.active) { $actCh = $c; break } }
      # 对外上线模型清单（空 = 全部上线，0.15.0）
      $txtPub.Text = (@($r.publishedModels) -join ', ')
      $txtHigh.Text = (@($r.highTierModels) -join ', ')
      # 官方默认模型下拉跟随活动通道（可下拉选择，也可自由输入自定义模型名）
      $cmbDefault.Items.Clear()
      if ($actCh) {
        foreach ($m in @($actCh.models)) {
          if ($m) { [void]$cmbDefault.Items.Add([string]$m) }
        }
        if ($actCh.model -and $actCh.model -ne 'auto') {
          $cmbDefault.Text = [string]$actCh.model
          if (-not $cmbDefault.Items.Contains([string]$actCh.model)) { [void]$cmbDefault.Items.Add([string]$actCh.model) }
        } else {
          $cmbDefault.Text = ''
        }
        $lblInfo.Text = '活动通道：' + $actCh.name + '（默认模型 ' + $actCh.model + '）· 共 ' + $r.channels.Count + ' 个'
      } else {
        $cmbDefault.Text = ''
        if ($r.channels.Count -eq 0) {
          $lblInfo.Text = '暂无通道——登录用户调用官方模型会收到 503，请先新增一条'
        } else {
          $lblInfo.Text = '⚠ 未设置活动通道（官方调用将返回 503）· 共 ' + $r.channels.Count + ' 个'
        }
      }
    } catch {
      $lblInfo.Text = '加载失败：' + (Get-HttpErrorDetail $_)
    }
  }

  function Get-SelectedChannel {
    if ($lb.SelectedIndex -lt 0 -or $lb.SelectedIndex -ge $script:cmRows.Count) { return $null }
    return $script:cmRows[$lb.SelectedIndex]
  }

  $btnPullDef = New-DlgBtn $dlg '📡 拉取' 410 326 70 {
    if (-not $script:cmActiveId) { $lblInfo.Text = '请先在列表中设置活动通道'; return }
    $lblInfo.Text = '正在拉取活动通道的模型列表…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = Invoke-AdminApi 'GET' ('/api/admin/channels/' + $script:cmActiveId + '/models')
      $cmbDefault.Items.Clear()
      foreach ($m in @($r.models)) { [void]$cmbDefault.Items.Add([string]$m) }
      $cur = $cmbDefault.Text.Trim()
      if ($cur -and -not $cmbDefault.Items.Contains($cur)) { [void]$cmbDefault.Items.Add($cur) }
      $lblInfo.Text = '✓ 拉到 ' + @($r.models).Count + ' 个模型——请下拉选择默认官方模型'
    } catch { $lblInfo.Text = '✗ 拉取失败：' + (Get-HttpErrorDetail $_) }
  }
  $btnSetDef = New-DlgBtn $dlg '设为默认' 484 326 72 {
    if (-not $script:cmActiveId) { $lblInfo.Text = '请先在列表中设置活动通道'; return }
    $m = $cmbDefault.Text.Trim()
    if (-not $m) { $lblInfo.Text = '请下拉选择或输入默认官方模型'; return }
    try {
      [void](Invoke-AdminApi 'PUT' ('/api/admin/channels/' + $script:cmActiveId) @{ model = $m })
      $lblInfo.Text = '✓ 官方默认模型已设为 ' + $m + '（登录用户 auto 即走此模型）'
      Refresh-CmList
    } catch { $lblInfo.Text = '✗ 设置失败：' + (Get-HttpErrorDetail $_) }
  }

  # 0.15.0 对外上线模型：填充候选 / 保存清单（控制插件端可见可调用的模型范围）
  $btnFillPub = New-DlgBtn $dlg '📡 填充' 410 355 70 {
    if (-not $script:cmActiveId) { $lblInfo.Text = '请先在列表中设置活动通道'; return }
    $lblInfo.Text = '正在拉取活动通道的模型列表…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = Invoke-AdminApi 'GET' ('/api/admin/channels/' + $script:cmActiveId + '/models')
      $txtPub.Text = (@($r.models) -join ', ')
      $lblInfo.Text = '✓ 已填充 ' + @($r.models).Count + ' 个候选——删掉不上线的，再点「保存上线」'
    } catch { $lblInfo.Text = '✗ 拉取失败：' + (Get-HttpErrorDetail $_) }
  }
  $btnSavePub = New-DlgBtn $dlg '保存上线' 484 355 72 {
    try {
      $models = @($txtPub.Text -split '[,，]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      [void](Invoke-AdminApi 'PUT' '/api/admin/channels/published' @{ models = $models })
      if ($models.Count) {
        $lblInfo.Text = '✓ 已上线 ' + $models.Count + ' 个模型（auto 恒可用），插件端 /v1/models 即时生效'
      } else {
        $lblInfo.Text = '✓ 上线清单已清空——恢复为全部上线'
      }
      Refresh-CmList
    } catch { $lblInfo.Text = '✗ 保存失败：' + (Get-HttpErrorDetail $_) }
  }

  $btnFillHigh = New-DlgBtn $dlg '📡 填充' 410 389 70 {
    # 把当前上线清单填进来最省事：留着的就是「需专业版」，删掉的就是免费
    $txtHigh.Text = $txtPub.Text
    $lblInfo.Text = '已把上线清单填入——删掉要保持免费的，留下的即「需专业版」，再点「保存分级」'
  }
  $btnSaveHigh = New-DlgBtn $dlg '保存分级' 484 389 72 {
    try {
      $models = @($txtHigh.Text -split '[,，]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $r = Invoke-AdminApi 'PUT' '/api/admin/channels/high-tier' @{ models = $models }
      if ($models.Count) {
        $lblInfo.Text = '✓ 已设 ' + $models.Count + ' 个模型需专业版（auto 恒免费）'
      } else {
        $lblInfo.Text = '✓ 已取消模型分级——全部上线模型免费'
      }
      $outside = @($r.outsidePublished)
      if ($outside.Count -gt 0) {
        $lblInfo.Text = $lblInfo.Text + '；注意 ' + ($outside -join '、') + ' 不在上线清单内，暂不生效'
      }
      Refresh-CmList
    } catch { $lblInfo.Text = '✗ 保存失败：' + (Get-HttpErrorDetail $_) }
  }

  $btnActivate = New-DlgBtn $dlg '设为活动' 12 434 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    try {
      [void](Invoke-AdminApi 'PUT' '/api/admin/channels/active' @{ id = $c.id })
      $lblInfo.Text = '已切换活动通道：' + $c.name
      Refresh-CmList
    } catch { $lblInfo.Text = '切换失败：' + (Get-HttpErrorDetail $_) }
  }
  $btnTest = New-DlgBtn $dlg '实测' 124 434 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    $lblInfo.Text = '正在实测「' + $c.name + '」，请稍候…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = Invoke-AdminApi 'POST' ('/api/admin/channels/' + $c.id + '/test') @{}
      if ($r.ok) {
        [System.Windows.Forms.MessageBox]::Show(('通道正常' + "`n" + '模型：' + $r.model + "`n" + '延迟：' + $r.latencyMs + 'ms' + "`n" + '应答：' + $r.reply), '实测通过', 'OK', 'Information') | Out-Null
        $lblInfo.Text = '实测通过（' + $r.latencyMs + 'ms）'
      } else {
        [System.Windows.Forms.MessageBox]::Show('调用失败：' + $r.error, '实测失败', 'OK', 'Warning') | Out-Null
        $lblInfo.Text = '实测失败'
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show('请求失败：' + (Get-HttpErrorDetail $_), '实测失败', 'OK', 'Warning') | Out-Null
      $lblInfo.Text = '实测请求失败'
    }
  }
  $btnEdit = New-DlgBtn $dlg '编辑' 236 434 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    [void](Show-ChannelForm $c)
    Refresh-CmList
  }
  $btnDel = New-DlgBtn $dlg '删除' 348 434 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    $r = [System.Windows.Forms.MessageBox]::Show('确定删除通道「' + $c.name + '」？删除后不可恢复。', '删除通道', 'YesNo', 'Question')
    if ($r -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/channels/' + $c.id))
      $lblInfo.Text = '已删除：' + $c.name
      Refresh-CmList
    } catch { $lblInfo.Text = '删除失败：' + (Get-HttpErrorDetail $_) }
  }
  $btnClose = New-DlgBtn $dlg '关闭' 460 434 96 { $dlg.Close() }

  $btnAdd = New-DlgBtn $dlg '＋ 新增通道' 12 470 180 {
    [void](Show-ChannelForm $null)
    Refresh-CmList
  }
  $btnOpenPage = New-DlgBtn $dlg '在浏览器中管理' 200 470 180 { Open-Url $AdminPage }
  $btnRefresh = New-DlgBtn $dlg '刷新' 388 470 168 { Refresh-CmList }

  $tip = New-Object System.Windows.Forms.Label
  $tip.Text = "● = 活动通道。新增时可只填 API Key 后点「🔍 检测」自动识别厂商；编辑时 Key 留空 = 保持原密钥。`n「官方默认模型」= 活动通道的默认模型（登录用户 auto 映射），从拉取列表选择或输入自定义名后点「设为默认」。`n「对外上线模型」= 插件端可见可调用的模型范围（逗号分隔；留空 = 全部上线；auto 恒可用）——官方模型分批发布用。`n「高级模型」= 上线模型里**只给专业版**用的（逗号分隔；留空 = 不做分级全部免费；auto 恒免费）——免费用户调用会返回 403；新用户在试用期内不受限。"
  $tip.ForeColor = [System.Drawing.Color]::DimGray
  $tip.SetBounds(12, 506, 544, 60)
  [void]$dlg.Controls.Add($tip)

  Refresh-CmList
  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
  Update-ChannelUI $true
}

# ---------------- 通道 新增/编辑 表单 ----------------
function Show-ChannelForm($editing) {
  $isEdit = ($null -ne $editing)
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '新增通道'
  if ($isEdit) { $dlg.Text = '编辑通道：' + $editing.name }
  $dlg.ClientSize = New-Object System.Drawing.Size(560, 478)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  function New-FLabel($parent, [string]$text, [int]$x, [int]$y, [int]$w) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, 18)
    [void]$parent.Controls.Add($l)
    return $l
  }
  function New-FInput($parent, [int]$x, [int]$y, [int]$w, [bool]$isPassword) {
    $t = New-Object System.Windows.Forms.TextBox
    if ($isPassword) { $t.UseSystemPasswordChar = $true }
    $t.Location = New-Object System.Drawing.Point($x, $y)
    $t.Size = New-Object System.Drawing.Size($w, 24)
    [void]$parent.Controls.Add($t)
    return $t
  }

  [void](New-FLabel $dlg '厂商预设（选择后自动填充地址与模型建议）' 12 12 400)
  $selProvider = New-Object System.Windows.Forms.ComboBox
  $selProvider.DropDownStyle = 'DropDownList'
  $selProvider.Location = New-Object System.Drawing.Point(12, 32)
  $selProvider.Size = New-Object System.Drawing.Size(536, 24)
  foreach ($p in $script:providerRows) { [void]$selProvider.Items.Add($p.name) }
  if ($script:providerRows.Count -eq 0) { [void]$selProvider.Items.Add('自定义 OpenAI 兼容接口') }
  [void]$dlg.Controls.Add($selProvider)

  [void](New-FLabel $dlg '通道 ID（小写字母/数字/连字符）' 12 64 260)
  $txtId = New-FInput $dlg 12 84 260 $false
  [void](New-FLabel $dlg '名称' 292 64 256)
  $txtName = New-FInput $dlg 292 84 256 $false

  [void](New-FLabel $dlg 'Base URL *（OpenAI 兼容 /v1）' 12 116 536)
  $txtBase = New-FInput $dlg 12 136 536 $false

  [void](New-FLabel $dlg 'API Key（编辑时留空 = 保持原密钥）' 12 168 260)
  $txtKey = New-FInput $dlg 12 188 260 $true
  [void](New-FLabel $dlg '默认模型（auto 映射；可下拉或自定义）' 292 168 256)
  $cmbModel = New-Object System.Windows.Forms.ComboBox
  $cmbModel.DropDownStyle = 'DropDown'
  $cmbModel.Location = New-Object System.Drawing.Point(292, 188)
  $cmbModel.Size = New-Object System.Drawing.Size(256, 24)
  [void]$dlg.Controls.Add($cmbModel)

  [void](New-FLabel $dlg '模型列表（逗号分隔，供 /v1/models 展示；可点「📡 拉取」自动填充）' 12 220 536)
  $txtModels = New-FInput $dlg 12 240 536 $false
  # 模型列表变化 → 同步「默认模型」下拉候选（拉取/检测/预设/手动编辑均触发）
  function Sync-ModelCombo {
    $seen = @{}
    $cmbModel.Items.Clear()
    foreach ($m in ($txtModels.Text -split '[,，]')) {
      $t = $m.Trim()
      if ($t -and -not $seen.ContainsKey($t)) { $seen[$t] = $true; [void]$cmbModel.Items.Add($t) }
    }
    $cur = $cmbModel.Text.Trim()
    if ($cur -and -not $seen.ContainsKey($cur)) { [void]$cmbModel.Items.Add($cur) }
  }
  $txtModels.Add_TextChanged({ Sync-ModelCombo })

  [void](New-FLabel $dlg 'extraBody（JSON，并入调用方请求体，可空）' 12 272 536)
  $txtExtra = New-FInput $dlg 12 292 536 $false

  [void](New-FLabel $dlg '探活超时 ms' 12 324 160)
  $numTimeout = New-Object System.Windows.Forms.NumericUpDown
  $numTimeout.Minimum = 2000; $numTimeout.Maximum = 120000; $numTimeout.Increment = 1000
  $numTimeout.Location = New-Object System.Drawing.Point(12, 344)
  $numTimeout.Size = New-Object System.Drawing.Size(120, 24)
  [void]$dlg.Controls.Add($numTimeout)

  $lblFMsg = New-Object System.Windows.Forms.Label
  $lblFMsg.Text = ''
  $lblFMsg.ForeColor = [System.Drawing.Color]::DimGray
  $lblFMsg.SetBounds(12, 442, 536, 30)
  [void]$dlg.Controls.Add($lblFMsg)

  # 预设联动：仅填充空字段（不覆盖已填内容）
  $selProvider.Add_SelectedIndexChanged({
    $p = $null
    foreach ($row in $script:providerRows) { if ($row.name -eq $selProvider.Text) { $p = $row; break } }
    if ($null -eq $p) { return }
    if (-not $txtBase.Text -and $p.baseUrl) { $txtBase.Text = $p.baseUrl }
    if (-not $txtName.Text) { $txtName.Text = $p.name }
    if (-not $txtId.Text -and $p.id -ne 'custom') { $txtId.Text = $p.id + '-main' }
    if (-not $txtModels.Text -and $p.models.Count -gt 0) { $txtModels.Text = ($p.models -join ', ') }
    if (-not $cmbModel.Text -and $p.models.Count -gt 0) { $cmbModel.Text = $p.models[0] }
    if (-not $txtExtra.Text -and $p.extraBody) { $txtExtra.Text = ($p.extraBody | ConvertTo-Json -Compress) }
  })

  if ($isEdit) {
    foreach ($p in $script:providerRows) { if ($p.id -eq $editing.provider) { $selProvider.Text = $p.name } }
    if (-not $selProvider.Text) { $selProvider.Text = '自定义 OpenAI 兼容接口'; [void]$selProvider.Items.Add('自定义 OpenAI 兼容接口') }
    $txtId.Text = $editing.id; $txtId.Enabled = $false
    $txtName.Text = $editing.name
    $txtBase.Text = $editing.baseUrl
    $txtModels.Text = (@($editing.models) -join ', ')
    $cmbModel.Text = [string]$editing.model
    if ($editing.extraBody) {
      $keys = @($editing.extraBody.PSObject.Properties.Name)
      if ($keys.Count -gt 0) { $txtExtra.Text = ($editing.extraBody | ConvertTo-Json -Compress) }
    }
    $numTimeout.Value = [Math]::Min([Math]::Max([int]$editing.timeoutMs, 2000), 120000)
    $lblFMsg.Text = '提示：API Key 留空则保持原密钥不变'
  } else {
    $numTimeout.Value = 12000
    if ($script:providerRows.Count -gt 0) { $selProvider.SelectedIndex = 0 }
  }

  $btnDetect = New-Object System.Windows.Forms.Button
  $btnDetect.Text = '🔍 检测（按密钥识别厂商）'
  $btnDetect.Location = New-Object System.Drawing.Point(12, 384)
  $btnDetect.Size = New-Object System.Drawing.Size(200, 30)
  $btnDetect.add_Click({
    if (-not $txtKey.Text.Trim()) { $lblFMsg.Text = '请先填写 API Key 再检测'; return }
    $lblFMsg.Text = '正在按密钥格式探测厂商…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = Invoke-AdminApi 'POST' '/api/admin/channels/detect' @{ apiKey = $txtKey.Text.Trim(); baseUrl = $txtBase.Text.Trim() }
      $p = $null
      foreach ($row in $script:providerRows) { if ($row.id -eq $r.provider) { $p = $row; break } }
      if ($p) { $selProvider.Text = $p.name }
      if ($r.provider -ne 'custom') { $txtId.Text = $r.provider + '-main' }
      $txtBase.Text = $r.baseUrl
      $txtModels.Text = ($r.models -join ', ')
      if (-not $cmbModel.Text -and $r.models.Count -gt 0) { $cmbModel.Text = $r.models[0] }
      $lblFMsg.Text = '✓ 识别为「' + $r.providerName + '」，拉到 ' + $r.models.Count + ' 个模型（' + $r.latencyMs + 'ms）'
      $lblFMsg.ForeColor = [System.Drawing.Color]::Green
    } catch {
      $d = Get-HttpErrorDetail $_
      try {
        # detect 失败也返回候选信息（400 带正文字段）；尽力预填
        $raw = $_.Exception.Response
        if ($raw) {
          $sr = New-Object System.IO.StreamReader($raw.GetResponseStream())
          $j = $sr.ReadToEnd() | ConvertFrom-Json
          $sr.Close()
          if ($j.provider -and $j.provider -ne 'custom') {
            foreach ($row in $script:providerRows) { if ($row.id -eq $j.provider) { $selProvider.Text = $row.name; $txtId.Text = $j.provider + '-main'; break } }
          }
        }
      } catch {}
      $lblFMsg.Text = '✗ ' + $d
      $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnDetect)

  $btnPull = New-Object System.Windows.Forms.Button
  $btnPull.Text = '📡 拉取上游模型'
  $btnPull.Location = New-Object System.Drawing.Point(222, 384)
  $btnPull.Size = New-Object System.Drawing.Size(160, 30)
  $btnPull.add_Click({
    if (-not $txtBase.Text.Trim()) { $lblFMsg.Text = '请先填写 Base URL'; return }
    $lblFMsg.Text = '正在拉取上游模型…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = $null
      if ($isEdit) {
        $r = Invoke-AdminApi 'GET' ('/api/admin/channels/' + $editing.id + '/models')
      } else {
        $r = Invoke-AdminApi 'POST' '/api/admin/channels/detect' @{ apiKey = $txtKey.Text.Trim(); baseUrl = $txtBase.Text.Trim() }
      }
      $txtModels.Text = ($r.models -join ', ')
      if (-not $cmbModel.Text -and $r.models.Count -gt 0) { $cmbModel.Text = $r.models[0] }
      $lblFMsg.Text = '✓ 拉到 ' + $r.models.Count + ' 个模型（' + $r.latencyMs + 'ms）'
      $lblFMsg.ForeColor = [System.Drawing.Color]::Green
    } catch {
      $lblFMsg.Text = '✗ ' + (Get-HttpErrorDetail $_)
      $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnPull)

  $btnSave = New-Object System.Windows.Forms.Button
  $btnSave.Text = '保存'
  $btnSave.Location = New-Object System.Drawing.Point(392, 384)
  $btnSave.Size = New-Object System.Drawing.Size(74, 30)
  $btnSave.add_Click({
    $extra = @{}
    if ($txtExtra.Text.Trim()) {
      try { $extra = $txtExtra.Text.Trim() | ConvertFrom-Json }
      catch { $lblFMsg.Text = '✗ extraBody 不是合法 JSON'; $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick; return }
      if ($null -eq $extra) { $extra = @{} }
      if ($extra -is [System.Array]) { $lblFMsg.Text = '✗ extraBody 必须是 JSON 对象'; $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick; return }
    }
    $prov = ''
    foreach ($row in $script:providerRows) { if ($row.name -eq $selProvider.Text) { $prov = $row.id; break } }
    if (-not $prov) { $prov = 'custom' }
    $models = @()
    foreach ($m in ($txtModels.Text -split '[,，]')) {
      $t = $m.Trim()
      if ($t) { $models += $t }
    }
    $body = @{
      id = $txtId.Text.Trim()
      name = $txtName.Text.Trim()
      provider = $prov
      baseUrl = $txtBase.Text.Trim()
      apiKey = $txtKey.Text
      model = $cmbModel.Text.Trim()
      models = $models
      extraBody = $extra
      timeoutMs = [int]$numTimeout.Value
    }
    try {
      if ($isEdit) {
        [void](Invoke-AdminApi 'PUT' ('/api/admin/channels/' + $editing.id) $body)
      } else {
        [void](Invoke-AdminApi 'POST' '/api/admin/channels' $body)
      }
      $dlg.Close()
    } catch {
      $lblFMsg.Text = '✗ ' + (Get-HttpErrorDetail $_)
      $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnSave)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'
  $btnCancel.Location = New-Object System.Drawing.Point(474, 384)
  $btnCancel.Size = New-Object System.Drawing.Size(74, 30)
  $btnCancel.add_Click({ $dlg.Close() })
  [void]$dlg.Controls.Add($btnCancel)

  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}

# ============================================================
# 账号管理对话框（注册 / 用户列表 / 编辑 / 重置密码 / 删除）
# ============================================================
function Show-RegisterUser {
  if (-not (Require-ServerRunning)) { return }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '注册新账号（登录 Zotero 插件用）'
  $dlg.ClientSize = New-Object System.Drawing.Size(420, 300)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  function New-RLabel([string]$text, [int]$y) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object System.Drawing.Point(16, $y); $l.Size = New-Object System.Drawing.Size(120, 20)
    [void]$dlg.Controls.Add($l)
  }
  function New-RInput([int]$y, [int]$w, [bool]$isPassword) {
    $t = New-Object System.Windows.Forms.TextBox
    if ($isPassword) { $t.UseSystemPasswordChar = $true }
    $t.Location = New-Object System.Drawing.Point(140, $y); $t.Size = New-Object System.Drawing.Size($w, 24)
    [void]$dlg.Controls.Add($t)
    return $t
  }

  New-RLabel '邮箱 *' 16;  $txtEmail = New-RInput 14 260 $false
  New-RLabel '密码 *（≥8 位）' 46;  $txtPwd = New-RInput 44 260 $true
  New-RLabel '昵称' 76;  $txtNick = New-RInput 74 260 $false
  New-RLabel '初始等级' 106
  $selPlan = New-Object System.Windows.Forms.ComboBox
  $selPlan.DropDownStyle = 'DropDownList'
  $selPlan.Location = New-Object System.Drawing.Point(140, 104)
  $selPlan.Size = New-Object System.Drawing.Size(120, 24)
  foreach ($p in @('Free', 'Pro')) { [void]$selPlan.Items.Add($p) }
  $selPlan.SelectedIndex = 0
  [void]$dlg.Controls.Add($selPlan)
  # 0.23.0：等级会员一律走「叠加式开通」，不再用固定到期日（避免覆盖式/叠加式两套语义打架）
  New-RLabel 'Pro 时长（月）' 136
  $txtMonths = New-Object System.Windows.Forms.TextBox
  $txtMonths.Text = '12'
  $txtMonths.Location = New-Object System.Drawing.Point(140, 134)
  $txtMonths.Size = New-Object System.Drawing.Size(80, 24)
  [void]$dlg.Controls.Add($txtMonths)
  $lblMonthsHint = New-Object System.Windows.Forms.Label
  $lblMonthsHint.Text = '（仅选 Pro 时生效，按剩余时长叠加）'
  $lblMonthsHint.ForeColor = [System.Drawing.Color]::DimGray
  $lblMonthsHint.SetBounds(226, 137, 190, 20)
  [void]$dlg.Controls.Add($lblMonthsHint)

  $lblMsg2 = New-Object System.Windows.Forms.Label
  $lblMsg2.Text = ''
  $lblMsg2.ForeColor = [System.Drawing.Color]::DimGray
  $lblMsg2.SetBounds(16, 168, 388, 60)
  [void]$dlg.Controls.Add($lblMsg2)

  $btnOk = New-Object System.Windows.Forms.Button
  $btnOk.Text = '注册'
  $btnOk.Location = New-Object System.Drawing.Point(220, 240)
  $btnOk.Size = New-Object System.Drawing.Size(88, 32)
  $btnOk.add_Click({
    if (-not $txtEmail.Text.Trim() -or $txtPwd.Text.Length -lt 8) {
      $lblMsg2.Text = '请填写邮箱，且密码至少 8 位'
      $lblMsg2.ForeColor = [System.Drawing.Color]::Firebrick
      return
    }
    try {
      # 先按 Free 建号，再（可选）用会员接口叠加 Pro —— 与 Web 管理页同一套语义
      $r = Invoke-AdminApi 'POST' '/api/admin/users' @{
        email = $txtEmail.Text.Trim(); password = $txtPwd.Text
        nickname = $txtNick.Text.Trim(); plan = 'Free'; expiresAt = $null
      }
      $extra = ''
      if ($selPlan.Text -eq 'Pro') {
        $months = 1
        [void][int]::TryParse($txtMonths.Text, [ref]$months)
        if ($months -lt 1) { $months = 1 }
        $r2 = Invoke-AdminApi 'POST' ('/api/admin/users/' + $r.user.id + '/membership') @{
          plan = 'Pro'; months = $months; note = '注册时开通'
        }
        $exp = ''
        if ($r2.membership -and $r2.membership.expiresAt) { $exp = ([string]$r2.membership.expiresAt).Substring(0, 10) }
        $extra = "`n" + '已开通 Pro ' + $months + ' 个月，到期 ' + $exp
      }
      [System.Windows.Forms.MessageBox]::Show('已注册 ' + $txtEmail.Text.Trim() + $extra + "`n`n" + '可在 Zotero：设置 → Papilot 中登录使用。', '注册成功', 'OK', 'Information') | Out-Null
      $dlg.Close()
    } catch {
      $lblMsg2.Text = '注册失败：' + (Get-HttpErrorDetail $_)
      $lblMsg2.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnOk)

  $btnNo = New-Object System.Windows.Forms.Button
  $btnNo.Text = '取消'
  $btnNo.Location = New-Object System.Drawing.Point(316, 240)
  $btnNo.Size = New-Object System.Drawing.Size(88, 32)
  $btnNo.add_Click({ $dlg.Close() })
  [void]$dlg.Controls.Add($btnNo)

  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}

# 某账号的登录设备（服务端 1.4.7）。
# 令牌 30 天滑动续期、靠请求续期 ⇒「活跃」= 最近 N 天内有请求（关掉 Zotero 不会立刻下线）。
# 超阈值只提示不处罚：同一人台式 + 笔记本 + 实验室机器很常见。确认共享/倒卖时才踢。
function Show-SessionsDialog($u) {
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '登录设备 · ' + [string]$u.email
  $dlg.ClientSize = New-Object System.Drawing.Size(780, 430)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  $lvS = New-Object System.Windows.Forms.ListView
  $lvS.View = 'Details'; $lvS.FullRowSelect = $true; $lvS.HideSelection = $false
  $lvS.SetBounds(12, 12, 756, 336)
  [void]$lvS.Columns.Add('设备', 190)
  [void]$lvS.Columns.Add('平台', 120)
  [void]$lvS.Columns.Add('最近活动', 140)
  [void]$lvS.Columns.Add('来源 IP', 130)
  [void]$lvS.Columns.Add('状态', 80)
  [void]$dlg.Controls.Add($lvS)

  $lblS = New-Object System.Windows.Forms.Label
  $lblS.Text = '加载中…'
  $lblS.ForeColor = [System.Drawing.Color]::DimGray
  $lblS.SetBounds(12, 354, 756, 20)
  [void]$dlg.Controls.Add($lblS)

  # 内层辅助：捕获上面的 $dlg（与会员管理对话框里的 New-MbBtn 同一写法）
  function New-SBtn([string]$text, [int]$x, [int]$w, $handler) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.SetBounds($x, 386, $w, 30)
    $b.add_Click($handler)
    [void]$dlg.Controls.Add($b)
    return $b
  }

  $script:ssRows = @()

  function Refresh-Sessions {
    try {
      $r = Invoke-AdminApi 'GET' ('/api/admin/users/' + [string]$u.id + '/sessions')
      $script:ssRows = @($r.sessions)
      $lvS.Items.Clear()
      foreach ($s in $script:ssRows) {
        $label = '（未上报设备标识）'
        if ($s.deviceLabel) { $label = [string]$s.deviceLabel }
        elseif ($s.deviceId) { $label = ([string]$s.deviceId).Substring(0, 8) + '…' }
        $it = New-Object System.Windows.Forms.ListViewItem($label)
        if ($s.platform) { [void]$it.SubItems.Add([string]$s.platform) } else { [void]$it.SubItems.Add('—') }
        [void]$it.SubItems.Add($(if ($s.lastSeenAt) { Format-Dt ([string]$s.lastSeenAt) } else { '—' }))
        [void]$it.SubItems.Add($(if ($s.ip) { [string]$s.ip } elseif ($s.ipMasked) { [string]$s.ipMasked } else { '—' }))
        $st = '长期未用'
        if ($s.current) { $st = '当前' } elseif ($s.active) { $st = '活跃' }
        [void]$it.SubItems.Add($st)
        [void]$lvS.Items.Add($it)
      }
      $lblS.Text = '活跃设备 ' + [string]$r.activeCount + ' 台（阈值 ' + [string]$r.maxDevices + ' 台 / 窗口 ' + [string]$r.activeDays + ' 天）'
      if ([int]$r.activeCount -gt [int]$r.maxDevices) {
        $lblS.Text = $lblS.Text + '　超过阈值：可能是账号共享（不自动处罚）'
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show('加载设备失败：' + (Get-HttpErrorDetail $_), '错误', 'OK', 'Warning') | Out-Null
    }
  }

  New-SBtn '踢出选中设备' 12 130 {
    if ($lvS.SelectedItems.Count -eq 0) { return }
    $sid = [string]$script:ssRows[$lvS.SelectedItems[0].Index].sid
    $q = [System.Windows.Forms.MessageBox]::Show(
      ('确定踢出这台设备？' + "`n" + '该设备下次请求会被拒绝，需要重新登录；不影响其他设备。'),
      '踢出设备', 'YesNo', 'Question')
    if ($q -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/users/' + [string]$u.id + '/sessions/' + $sid))
      Refresh-Sessions
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '失败', 'OK', 'Warning') | Out-Null }
  }
  New-SBtn '踢出其他全部' 150 130 {
    $q = [System.Windows.Forms.MessageBox]::Show(
      ('把这台设备之外的登录设备全部踢出？' + "`n" + '设备持有者需要重新登录。'),
      '踢出其他全部', 'YesNo', 'Question')
    if ($q -ne 'Yes') { return }
    $n = 0
    foreach ($s in @($script:ssRows)) {
      try {
        [void](Invoke-AdminApi 'DELETE' ('/api/admin/users/' + [string]$u.id + '/sessions/' + [string]$s.sid))
        $n = $n + 1
      } catch { }
    }
    [System.Windows.Forms.MessageBox]::Show('已踢出 ' + [string]$n + ' 台设备', '完成', 'OK', 'Information') | Out-Null
    Refresh-Sessions
  }
  New-SBtn '刷新' 288 70 { Refresh-Sessions }
  New-SBtn '关闭' 672 96 { $dlg.Close() }

  Refresh-Sessions
  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}


function Show-UserList {
  if (-not (Require-ServerRunning)) { return }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '账号列表（会员 / 密码 / 登录设备 / 删除）'
  $dlg.ClientSize = New-Object System.Drawing.Size(940, 420)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  $lv = New-Object System.Windows.Forms.ListView
  $lv.View = 'Details'; $lv.FullRowSelect = $true; $lv.HideSelection = $false
  $lv.Location = New-Object System.Drawing.Point(12, 12)
  $lv.Size = New-Object System.Drawing.Size(916, 320)
  [void]$lv.Columns.Add('邮箱', 180)
  [void]$lv.Columns.Add('昵称', 80)
  [void]$lv.Columns.Add('等级', 48)
  [void]$lv.Columns.Add('会员到期', 130)
  [void]$lv.Columns.Add('AI 余额', 90)
  [void]$lv.Columns.Add('今日调用', 68)
  [void]$lv.Columns.Add('活跃设备', 68)
  [void]$lv.Columns.Add('最近登录', 100)
  [void]$dlg.Controls.Add($lv)

  $script:ulRows = @()
  function Refresh-UserList {
    try {
      $r = Invoke-AdminApi 'GET' '/api/admin/users'
      $script:ulRows = @($r.users)
      $lv.Items.Clear()
      foreach ($u in $r.users) {
        $it = New-Object System.Windows.Forms.ListViewItem([string]$u.email)
        [void]$it.SubItems.Add([string]($u.nickname))
        [void]$it.SubItems.Add([string]($u.plan))
        [void]$it.SubItems.Add((Get-MembershipText $u))
        # 1.8.0：取消每日次数上限 —— 只显示余额（微元文案由服务端格式化）与今日调用次数
        $balTxt = '—'
        if ($u.balance -and $u.balance.text) { $balTxt = [string]$u.balance.text }
        [void]$it.SubItems.Add($balTxt)
        [void]$it.SubItems.Add([string]$u.dailyUsed)
        # 1.4.7 登录设备：超过阈值加「!」提示（可能是账号共享，只提示不处罚）
        $sess = '—'
        if ($null -ne $u.sessionsActive) {
          $sess = [string]$u.sessionsActive
          if ($u.sessionsOverLimit) { $sess = $sess + ' !' }
        }
        [void]$it.SubItems.Add($sess)
        $last = '从未'
        if ($u.lastLoginAt) { $last = ([string]$u.lastLoginAt).Replace('T', ' ').Substring(0, 16) }
        [void]$it.SubItems.Add($last)
        [void]$lv.Items.Add($it)
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show('加载失败：' + (Get-HttpErrorDetail $_), '错误', 'OK', 'Warning') | Out-Null
    }
  }

  function New-UBtn([string]$text, [int]$x, [int]$w, $handler) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, 344); $b.Size = New-Object System.Drawing.Size($w, 30)
    $b.add_Click($handler)
    [void]$dlg.Controls.Add($b)
  }

  # 0.23.0：开通 / 续期（叠加式）—— 与 Web 管理页同一套语义
  New-UBtn '开通/续期（叠加）' 12 140 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    $u = $script:ulRows[$lv.SelectedItems[0].Index]
    $gm = New-Object System.Windows.Forms.Form
    $gm.Text = '开通 / 续期：' + $u.email
    $gm.ClientSize = New-Object System.Drawing.Size(440, 250)
    $gm.StartPosition = 'CenterParent'
    $gm.FormBorderStyle = 'FixedSingle'
    $gm.MaximizeBox = $false
    $gm.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $gm.Icon = $script:appIcon

    $cur = '当前：' + [string]$u.plan + '，无到期日'
    $mCur = $u.membership
    if ($mCur -and $mCur.expiresAt) {
      $d0 = ([string]$mCur.expiresAt).Substring(0, 10)
      if ($mCur.expired) { $cur = '当前：已过期（' + $d0 + '）' }
      else { $cur = '当前：' + [string]$mCur.plan + '，剩 ' + $mCur.daysLeft + ' 天（' + $d0 + ' 到期）' }
    }
    $lc = New-Object System.Windows.Forms.Label
    $lc.Text = $cur
    $lc.ForeColor = [System.Drawing.Color]::DimGray
    $lc.SetBounds(16, 14, 408, 20)
    [void]$gm.Controls.Add($lc)

    $lp = New-Object System.Windows.Forms.Label; $lp.Text = '套餐'; $lp.SetBounds(16, 48, 60, 20); [void]$gm.Controls.Add($lp)
    $gp = New-Object System.Windows.Forms.ComboBox; $gp.DropDownStyle = 'DropDownList'
    $gp.SetBounds(96, 46, 150, 24)
    try {
      $plDoc = Invoke-AdminApi 'GET' '/api/admin/membership'
      foreach ($p in $plDoc.plans.plans) { if ($p.purchasable) { [void]$gp.Items.Add([string]$p.id) } }
    } catch {}
    if ($gp.Items.Count -eq 0) { [void]$gp.Items.Add('Pro') }
    $gp.SelectedIndex = 0
    [void]$gm.Controls.Add($gp)

    $lm = New-Object System.Windows.Forms.Label; $lm.Text = '时长（月）'; $lm.SetBounds(16, 84, 80, 20); [void]$gm.Controls.Add($lm)
    $tm = New-Object System.Windows.Forms.TextBox; $tm.Text = '1'; $tm.SetBounds(96, 82, 80, 24); [void]$gm.Controls.Add($tm)

    $ln = New-Object System.Windows.Forms.Label; $ln.Text = '备注'; $ln.SetBounds(16, 120, 80, 20); [void]$gm.Controls.Add($ln)
    $tn = New-Object System.Windows.Forms.TextBox; $tn.SetBounds(96, 118, 320, 24); [void]$gm.Controls.Add($tn)

    $lh = New-Object System.Windows.Forms.Label
    $lh.Text = '按「剩余时长 + 本次时长」叠加；要把到期日钉成固定日期请用「编辑」。'
    $lh.ForeColor = [System.Drawing.Color]::DimGray
    $lh.SetBounds(16, 150, 410, 20)
    [void]$gm.Controls.Add($lh)

    $bg = New-Object System.Windows.Forms.Button; $bg.Text = '确认开通'
    $bg.SetBounds(216, 190, 100, 32)
    $bg.add_Click({
      $months = 1
      [void][int]::TryParse($tm.Text, [ref]$months)
      if ($months -lt 1) { $months = 1 }
      try {
        $r2 = Invoke-AdminApi 'POST' ('/api/admin/users/' + $u.id + '/membership') @{
          plan = [string]$gp.SelectedItem; months = $months; note = $tn.Text.Trim()
        }
        $exp2 = ''
        if ($r2.membership -and $r2.membership.expiresAt) { $exp2 = ([string]$r2.membership.expiresAt).Substring(0, 10) }
        [System.Windows.Forms.MessageBox]::Show('已为 ' + $u.email + ' 开通 ' + $months + ' 个月，到期 ' + $exp2, '成功', 'OK', 'Information') | Out-Null
        $gm.Close()
        Refresh-UserList
      } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '开通失败', 'OK', 'Warning') | Out-Null }
    })
    [void]$gm.Controls.Add($bg)
    $bx = New-Object System.Windows.Forms.Button; $bx.Text = '取消'
    $bx.SetBounds(326, 190, 100, 32); $bx.add_Click({ $gm.Close() })
    [void]$gm.Controls.Add($bx)

    [void]$gm.ShowDialog($dlg)
    $gm.Dispose()
  }
  New-UBtn '编辑（等级/到期）' 158 140 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    $u = $script:ulRows[$lv.SelectedItems[0].Index]
    $ed = New-Object System.Windows.Forms.Form
    $ed.Text = '编辑用户：' + $u.email
    $ed.ClientSize = New-Object System.Drawing.Size(380, 210)
    $ed.StartPosition = 'CenterParent'
    $ed.FormBorderStyle = 'FixedSingle'
    $ed.MaximizeBox = $false
    $ed.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $ed.Icon = $script:appIcon
    $l1 = New-Object System.Windows.Forms.Label; $l1.Text = '昵称'; $l1.SetBounds(16, 16, 80, 20); [void]$ed.Controls.Add($l1)
    $t1 = New-Object System.Windows.Forms.TextBox; $t1.Text = [string]$u.nickname; $t1.SetBounds(100, 14, 250, 24); [void]$ed.Controls.Add($t1)
    $l2 = New-Object System.Windows.Forms.Label; $l2.Text = '等级（覆盖式）'; $l2.SetBounds(16, 48, 90, 20); [void]$ed.Controls.Add($l2)
    $cb = New-Object System.Windows.Forms.ComboBox; $cb.DropDownStyle = 'DropDownList'
    foreach ($p in @('Free', 'Pro')) { [void]$cb.Items.Add($p) }
    $cb.SelectedItem = [string]$u.planRaw
    if (-not $cb.SelectedItem) { $cb.SelectedIndex = 0 }
    $cb.SetBounds(112, 46, 120, 24); [void]$ed.Controls.Add($cb)
    $l3 = New-Object System.Windows.Forms.Label; $l3.Text = '会员到期日'; $l3.SetBounds(16, 80, 90, 20); [void]$ed.Controls.Add($l3)
    $dt = New-Object System.Windows.Forms.DateTimePicker
    $dt.Format = 'Short'; $dt.ShowCheckBox = $true
    if ($u.expiresAt) { $dt.Checked = $true; $dt.Value = [datetime]([string]$u.expiresAt).Substring(0, 10) } else { $dt.Checked = $false }
    $dt.SetBounds(110, 78, 140, 24); [void]$ed.Controls.Add($dt)
    $bOk = New-Object System.Windows.Forms.Button; $bOk.Text = '保存'
    $bOk.SetBounds(180, 140, 84, 30)
    $bOk.add_Click({
      try {
        $exp = $null
        if ($dt.Checked) { $exp = $dt.Value.ToString('yyyy-MM-dd') }
        [void](Invoke-AdminApi 'PUT' ('/api/admin/users/' + $u.id) @{ nickname = $t1.Text.Trim(); plan = $cb.Text; expiresAt = $exp })
        $ed.Close(); Refresh-UserList
      } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '保存失败', 'OK', 'Warning') | Out-Null }
    })
    [void]$ed.Controls.Add($bOk)
    $bNo = New-Object System.Windows.Forms.Button; $bNo.Text = '取消'
    $bNo.SetBounds(272, 140, 84, 30); $bNo.add_Click({ $ed.Close() })
    [void]$ed.Controls.Add($bNo)
    [void]$ed.ShowDialog($dlg)
    $ed.Dispose()
  }
  New-UBtn '重置密码' 304 100 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    $u = $script:ulRows[$lv.SelectedItems[0].Index]
    $pw = [Microsoft.VisualBasic.Interaction]::InputBox('为 ' + $u.email + ' 设置新密码（≥8 位，将吊销其全部登录会话）：', '重置密码', '')
    if (-not $pw) { return }
    try {
      [void](Invoke-AdminApi 'POST' ('/api/admin/users/' + $u.id + '/password') @{ password = $pw })
      [System.Windows.Forms.MessageBox]::Show('密码已重置，该用户既有登录已全部吊销。', '成功', 'OK', 'Information') | Out-Null
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '失败', 'OK', 'Warning') | Out-Null }
  }
  New-UBtn '删除用户' 410 100 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    $u = $script:ulRows[$lv.SelectedItems[0].Index]
    $r = [System.Windows.Forms.MessageBox]::Show('确定删除用户 ' + $u.email + '？其全部登录会话将被吊销。', '删除用户', 'YesNo', 'Question')
    if ($r -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/users/' + $u.id))
      Refresh-UserList
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '失败', 'OK', 'Warning') | Out-Null }
  }
  New-UBtn '注册新账号' 516 110 { [void](Show-RegisterUser); Refresh-UserList }
  New-UBtn '刷新' 632 56 { Refresh-UserList }
  New-UBtn '查看/踢出设备' 816 118 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    Show-SessionsDialog $script:ulRows[$lv.SelectedItems[0].Index]
    Refresh-UserList
  }
  New-UBtn '关闭' 694 114 { $dlg.Close() }

  Refresh-UserList
  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}

# ============================================================
# 价格条目 新增/编辑 子对话框（0.23.1）
#   价格条目 = 会员等级 × 计费周期 × 生效时段；时段重叠时按优先级决胜
#   ⚠️ PS 5.1：不要把「+」放在续行开头（会报「表达式中缺少右)」），一律拆中间变量
# ============================================================
function Get-PriceRangeText([string]$from, [string]$to) {
  $f = '立即'
  $t = '长期'
  if ($from -and $from.Length -ge 10) { $f = $from.Substring(0, 10) }
  if ($to -and $to.Length -ge 10) { $t = $to.Substring(0, 10) }
  return ($f + ' → ' + $t)
}

function Show-PriceForm($parent, $editing) {
  $fm = New-Object System.Windows.Forms.Form
  if ($editing) { $fm.Text = '编辑价格（' + [string]$editing.planName + ' · ' + [string]$editing.cycleName + '）' }
  else { $fm.Text = '新增价格条目' }
  $fm.ClientSize = New-Object System.Drawing.Size(500, 400)
  $fm.StartPosition = 'CenterParent'
  $fm.FormBorderStyle = 'FixedSingle'
  $fm.MaximizeBox = $false
  $fm.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $fm.Icon = $script:appIcon

  function New-PRLabel([string]$text, [int]$y, [int]$w) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.SetBounds(16, $y, $w, 20)
    [void]$fm.Controls.Add($l)
  }

  New-PRLabel '会员等级 *' 18 120
  $selPlan = New-Object System.Windows.Forms.ComboBox
  $selPlan.DropDownStyle = 'DropDownList'
  $selPlan.SetBounds(180, 15, 290, 24)
  foreach ($p in $script:mbPricePlans) {
    [void]$selPlan.Items.Add(([string]$p.name + '（' + [string]$p.id + '）'))
  }
  [void]$fm.Controls.Add($selPlan)

  New-PRLabel '计费周期 *' 52 120
  $selCycle = New-Object System.Windows.Forms.ComboBox
  $selCycle.DropDownStyle = 'DropDownList'
  $selCycle.SetBounds(180, 49, 290, 24)
  foreach ($c in $script:mbCycles) {
    # 永久周期不适用月数，别显示「0 个月」
    $span = $(if ([string]$c.id -eq 'perpetual') { '不适用月数' } else { ([string]$c.months + ' 个月') })
    [void]$selCycle.Items.Add(([string]$c.id + ' · ' + [string]$c.name + '（' + $span + '）'))
  }
  [void]$fm.Controls.Add($selCycle)

  New-PRLabel '周期月数 *' 86 120
  $txtMonths = New-Object System.Windows.Forms.TextBox
  $txtMonths.Text = '1'
  $txtMonths.SetBounds(180, 83, 80, 24)
  [void]$fm.Controls.Add($txtMonths)

  New-PRLabel '该周期总价（¥）*' 120 150
  $txtPrice = New-Object System.Windows.Forms.TextBox
  $txtPrice.Text = '0'
  $txtPrice.SetBounds(180, 117, 80, 24)
  [void]$fm.Controls.Add($txtPrice)
  $lblPer = New-Object System.Windows.Forms.Label
  $lblPer.ForeColor = [System.Drawing.Color]::DimGray
  $lblPer.SetBounds(270, 120, 210, 20)
  [void]$fm.Controls.Add($lblPer)

  New-PRLabel '展示名（可空）' 154 150
  $txtLabel = New-Object System.Windows.Forms.TextBox
  $txtLabel.SetBounds(180, 151, 290, 24)
  [void]$fm.Controls.Add($txtLabel)

  New-PRLabel '生效起始（不勾=立即）' 188 160
  $dtFrom = New-Object System.Windows.Forms.DateTimePicker
  $dtFrom.Format = 'Custom'
  $dtFrom.CustomFormat = 'yyyy-MM-dd HH:mm'
  $dtFrom.ShowCheckBox = $true
  $dtFrom.Checked = $false
  $dtFrom.SetBounds(180, 185, 170, 24)
  [void]$fm.Controls.Add($dtFrom)

  New-PRLabel '生效截止（不勾=长期）' 218 160
  $dtTo = New-Object System.Windows.Forms.DateTimePicker
  $dtTo.Format = 'Custom'
  $dtTo.CustomFormat = 'yyyy-MM-dd HH:mm'
  $dtTo.ShowCheckBox = $true
  $dtTo.Checked = $false
  $dtTo.SetBounds(180, 215, 170, 24)
  [void]$fm.Controls.Add($dtTo)

  New-PRLabel '优先级 0-9' 248 120
  $txtPrio = New-Object System.Windows.Forms.TextBox
  $txtPrio.Text = '0'
  $txtPrio.SetBounds(180, 245, 60, 24)
  [void]$fm.Controls.Add($txtPrio)
  $lblPrioHint = New-Object System.Windows.Forms.Label
  $lblPrioHint.Text = '时段重叠时高者胜（促销建议给 1+）'
  $lblPrioHint.ForeColor = [System.Drawing.Color]::DimGray
  $lblPrioHint.SetBounds(248, 248, 230, 20)
  [void]$fm.Controls.Add($lblPrioHint)

  $chkEnabled = New-Object System.Windows.Forms.CheckBox
  $chkEnabled.Text = '启用（取消勾选 = 停用但保留配置）'
  $chkEnabled.Checked = $true
  $chkEnabled.SetBounds(180, 275, 290, 24)
  [void]$fm.Controls.Add($chkEnabled)

  New-PRLabel '备注（可空）' 306 120
  $txtNote = New-Object System.Windows.Forms.TextBox
  $txtNote.SetBounds(180, 303, 290, 24)
  [void]$fm.Controls.Add($txtNote)

  # 回填 / 默认值
  if ($editing) {
    $selPlan.Text = ([string]$editing.planName + '（' + [string]$editing.plan + '）')
    foreach ($item in $selCycle.Items) {
      if (([string]$item -split ' · ')[0] -eq [string]$editing.cycle) { $selCycle.SelectedItem = $item }
    }
    if (-not $selCycle.SelectedItem -and $selCycle.Items.Count -gt 0) { $selCycle.SelectedIndex = 0 }
    $txtMonths.Text = [string]$editing.months
    $txtPrice.Text = [string]$editing.price
    $txtLabel.Text = [string]$editing.label
    $txtPrio.Text = [string]$editing.priority
    $chkEnabled.Checked = [bool]$editing.enabled
    $txtNote.Text = [string]$editing.note
    if ($editing.effectiveFrom) {
      try { $dtFrom.Value = [datetime]([string]$editing.effectiveFrom).Substring(0, 16).Replace('T', ' '); $dtFrom.Checked = $true } catch {}
    }
    if ($editing.effectiveTo) {
      try { $dtTo.Value = [datetime]([string]$editing.effectiveTo).Substring(0, 16).Replace('T', ' '); $dtTo.Checked = $true } catch {}
    }
  } else {
    if ($selPlan.Items.Count -eq 0) {
      [System.Windows.Forms.MessageBox]::Show('没有可配置价格的等级（免费版不需要配价）', '提示', 'OK', 'Information') | Out-Null
      $fm.Dispose()
      return
    }
    $selPlan.SelectedIndex = 0
    if ($selCycle.Items.Count -gt 0) { $selCycle.SelectedIndex = 0 }
  }

  # 联动：选周期自动带出月数；周期/价格/月数变化实时显示折合月单价
  $syncPer = {
    $cidNow = (([string]$selCycle.SelectedItem) -split ' · ')[0]
    $m = 0
    [void][int]::TryParse($txtMonths.Text, [ref]$m)
    $p = 0.0
    [void][double]::TryParse($txtPrice.Text, [ref]$p)
    if ($cidNow -eq 'perpetual') { $lblPer.Text = '永久：不按月折算' }
    elseif ($m -gt 0) { $lblPer.Text = ('折合 ¥' + [math]::Round($p / $m, 2) + ' / 月') }
    else { $lblPer.Text = '' }
  }
  $selCycle.add_SelectedIndexChanged({
    $cid = (([string]$selCycle.SelectedItem) -split ' · ')[0]
    $perp = ($cid -eq 'perpetual')
    foreach ($c in $script:mbCycles) {
      if ([string]$c.id -eq $cid -and [int]$c.months -gt 0) { $txtMonths.Text = [string]$c.months }
    }
    if ($perp) { $txtMonths.Text = '0' }
    $txtMonths.Enabled = -not $perp
    & $syncPer
  })
  $txtMonths.add_TextChanged($syncPer)
  $txtPrice.add_TextChanged($syncPer)
  & $syncPer

  $lblMsg = New-Object System.Windows.Forms.Label
  $lblMsg.ForeColor = [System.Drawing.Color]::Firebrick
  $lblMsg.SetBounds(16, 330, 460, 20)
  [void]$fm.Controls.Add($lblMsg)

  $btnOk = New-Object System.Windows.Forms.Button
  $btnOk.Text = '保存'
  $btnOk.SetBounds(280, 354, 90, 32)
  $btnOk.add_Click({
    $months = 0
    [void][int]::TryParse($txtMonths.Text, [ref]$months)
    $price = 0.0
    [void][double]::TryParse($txtPrice.Text, [ref]$price)
    $prio = 0
    [void][int]::TryParse($txtPrio.Text, [ref]$prio)
    $cycleId = (([string]$selCycle.SelectedItem) -split ' · ')[0]
    if ($cycleId -eq 'perpetual') { $months = 0 }        # 永久：月数不适用
    elseif ($months -lt 1) { $lblMsg.Text = '周期月数必须 ≥ 1'; return }
    if ($price -le 0) { $lblMsg.Text = '价格必须大于 0'; return }
    $pid = $selPlan.Text
    $lp = $pid.LastIndexOf('（')
    if ($lp -gt 0) { $pid = $pid.Substring($lp + 1).TrimEnd('）') }
    $fromIso = $null
    if ($dtFrom.Checked) { $fromIso = $dtFrom.Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
    $toIso = $null
    if ($dtTo.Checked) { $toIso = $dtTo.Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
    $body = @{
      plan = $pid
      cycle = $cycleId
      months = $months
      price = $price
      label = $txtLabel.Text.Trim()
      effectiveFrom = $fromIso
      effectiveTo = $toIso
      priority = $prio
      enabled = [bool]$chkEnabled.Checked
      note = $txtNote.Text.Trim()
    }
    try {
      if ($editing) { [void](Invoke-AdminApi 'PUT' ('/api/admin/prices/' + $editing.id) $body) }
      else { [void](Invoke-AdminApi 'POST' '/api/admin/prices' $body) }
      $fm.Close()
      Refresh-Membership
    } catch { $lblMsg.Text = Get-HttpErrorDetail $_ }
  })
  [void]$fm.Controls.Add($btnOk)

  $btnNo = New-Object System.Windows.Forms.Button
  $btnNo.Text = '取消'
  $btnNo.SetBounds(380, 354, 90, 32)
  $btnNo.add_Click({ $fm.Close() })
  [void]$fm.Controls.Add($btnNo)

  [void]$fm.ShowDialog($parent)
  $fm.Dispose()
}

# ============================================================
# 会员管理对话框（0.23.0）：订单核销 / 激活码 / 价格与周期 / 套餐与收款
#   购买流程：用户在插件内下单 → 扫码付款后点「我已完成支付」→ 这里核销即自动开通
#   （订单绑定账号，用户无需再输码；核销同时留档一枚已用兑换码便于对账）
#   续期一律按「剩余时长 + 本次时长」叠加 —— 与 Web 管理页（/admin）同一套接口
# ============================================================
# 新建 / 编辑优惠券。$c 为 $null 时新建（可批量），否则编辑既有券（类型不可改）
function Show-CouponForm($c) {
  $isEdit = ($null -ne $c)
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = $(if ($isEdit) { '编辑优惠券 ' + [string]$c.code } else { '新建优惠券' })
  $dlg.ClientSize = New-Object System.Drawing.Size(520, 420)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  $lblType = New-Object System.Windows.Forms.Label
  $lblType.Text = '减免类型'; $lblType.SetBounds(16, 18, 90, 20)
  [void]$dlg.Controls.Add($lblType)
  $cmbType = New-Object System.Windows.Forms.ComboBox
  $cmbType.DropDownStyle = 'DropDownList'
  $cmbType.SetBounds(110, 16, 200, 24)
  [void]$cmbType.Items.Add('按比例减免（折扣）')
  [void]$cmbType.Items.Add('固定金额减免（满减）')
  $cmbType.SelectedIndex = 0
  if ($isEdit -and [string]$c.type -eq 'amount') { $cmbType.SelectedIndex = 1 }
  if ($isEdit) { $cmbType.Enabled = $false }
  [void]$dlg.Controls.Add($cmbType)

  $lblVal = New-Object System.Windows.Forms.Label
  $lblVal.Text = '减免百分比 %'; $lblVal.SetBounds(16, 50, 90, 20)
  [void]$dlg.Controls.Add($lblVal)
  $txtVal = New-Object System.Windows.Forms.TextBox
  $txtVal.SetBounds(110, 48, 120, 24)
  $txtVal.Text = '20'
  [void]$dlg.Controls.Add($txtVal)

  $lblMin = New-Object System.Windows.Forms.Label
  $lblMin.Text = '门槛（元）'; $lblMin.SetBounds(250, 50, 90, 20)
  [void]$dlg.Controls.Add($lblMin)
  $txtMin = New-Object System.Windows.Forms.TextBox
  $txtMin.SetBounds(340, 48, 110, 24)
  $txtMin.Text = '0'
  [void]$dlg.Controls.Add($txtMin)

  $lblScope = New-Object System.Windows.Forms.Label
  $lblScope.Text = '适用等级（留空 = 全场通用，可填 Pro / Free）'; $lblScope.SetBounds(16, 82, 320, 20)
  [void]$dlg.Controls.Add($lblScope)
  $txtScope = New-Object System.Windows.Forms.TextBox
  $txtScope.SetBounds(16, 104, 486, 24)
  [void]$dlg.Controls.Add($txtScope)

  $lblMax = New-Object System.Windows.Forms.Label
  $lblMax.Text = '可用总次数（0 = 不限）'; $lblMax.SetBounds(16, 138, 160, 20)
  [void]$dlg.Controls.Add($lblMax)
  $txtMax = New-Object System.Windows.Forms.TextBox
  $txtMax.SetBounds(180, 136, 90, 24)
  $txtMax.Text = '0'
  [void]$dlg.Controls.Add($txtMax)

  $lblPer = New-Object System.Windows.Forms.Label
  $lblPer.Text = '每人限用（0 = 不限）'; $lblPer.SetBounds(286, 138, 150, 20)
  [void]$dlg.Controls.Add($lblPer)
  $txtPer = New-Object System.Windows.Forms.TextBox
  $txtPer.SetBounds(436, 136, 66, 24)
  $txtPer.Text = '1'
  [void]$dlg.Controls.Add($txtPer)

  $lblTo = New-Object System.Windows.Forms.Label
  $lblTo.Text = '生效截止（不勾 = 长期有效）'; $lblTo.SetBounds(16, 170, 200, 20)
  [void]$dlg.Controls.Add($lblTo)
  $dtTo = New-Object System.Windows.Forms.DateTimePicker
  $dtTo.Format = 'Short'; $dtTo.ShowCheckBox = $true; $dtTo.Checked = $false
  $dtTo.SetBounds(216, 168, 140, 24)
  [void]$dlg.Controls.Add($dtTo)

  $lblCnt = New-Object System.Windows.Forms.Label
  $lblCnt.Text = '生成数量（1~200，仅新建）'; $lblCnt.SetBounds(16, 202, 200, 20)
  [void]$dlg.Controls.Add($lblCnt)
  $txtCnt = New-Object System.Windows.Forms.TextBox
  $txtCnt.SetBounds(216, 200, 80, 24)
  $txtCnt.Text = '1'
  [void]$dlg.Controls.Add($txtCnt)

  $lblNote = New-Object System.Windows.Forms.Label
  $lblNote.Text = '备注（后台可见，不给用户看）'; $lblNote.SetBounds(16, 234, 260, 20)
  [void]$dlg.Controls.Add($lblNote)
  $txtNote = New-Object System.Windows.Forms.TextBox
  $txtNote.SetBounds(16, 256, 486, 24)
  [void]$dlg.Controls.Add($txtNote)

  # 编辑既有券：回填现值
  if ($isEdit) {
    $txtVal.Text = $(if ([string]$c.type -eq 'amount') { [string]([int]$c.amountCents / 100.0) } else { [string]$c.percent })
    $txtMin.Text = [string]([int]$c.minAmountCents / 100.0)
    $txtScope.Text = (@($c.plans) -join ',')
    $txtMax.Text = [string]$c.maxUses
    $txtPer.Text = [string]$c.perUser
    $txtNote.Text = [string]$c.note
    if ($c.effectiveTo) {
      $dtTo.Checked = $true
      try { $dtTo.Value = [datetime]::Parse([string]$c.effectiveTo) } catch { $dtTo.Checked = $false }
    }
    $txtCnt.Enabled = $false
  }

  $lblMsgC = New-Object System.Windows.Forms.Label
  $lblMsgC.Text = ''
  $lblMsgC.ForeColor = [System.Drawing.Color]::DimGray
  $lblMsgC.SetBounds(16, 286, 486, 44)
  [void]$dlg.Controls.Add($lblMsgC)

  $btnOk = New-Object System.Windows.Forms.Button
  $btnOk.Text = $(if ($isEdit) { '保存' } else { '创建' })
  $btnOk.SetBounds(296, 342, 96, 32)
  $btnOk.add_Click({
    $isAmt = ($cmbType.SelectedIndex -eq 1)
    $body = @{
      minAmountCents = [int]([math]::Round((([double]$txtMin.Text) * 100)))
      maxUses        = [int]$txtMax.Text
      perUser        = [int]$txtPer.Text
      note           = $txtNote.Text.Trim()
    }
    if ($isAmt) { $body['amountCents'] = [int]([math]::Round((([double]$txtVal.Text) * 100))) }
    else { $body['percent'] = [double]$txtVal.Text }
    if ($txtScope.Text.Trim()) { $body['plans'] = @($txtScope.Text.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    if ($dtTo.Checked) { $body['effectiveTo'] = $dtTo.Value.ToString('yyyy-MM-ddTHH:mm') }
    try {
      if ($isEdit) {
        [void](Invoke-AdminApi 'PUT' ('/api/admin/coupons/' + [string]$c.id) $body)
      } else {
        $body['count'] = [int]$txtCnt.Text
        [void](Invoke-AdminApi 'POST' '/api/admin/coupons' $body)
      }
      $dlg.Close()
    } catch {
      $lblMsgC.Text = '保存失败：' + (Get-HttpErrorDetail $_)
      $lblMsgC.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnOk)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'
  $btnCancel.SetBounds(400, 342, 96, 32)
  $btnCancel.add_Click({ $dlg.Close() })
  [void]$dlg.Controls.Add($btnCancel)

  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}


function Show-MembershipManager {
  if (-not (Require-ServerRunning)) { return }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '会员管理（订单 / 激活码 / 价格与周期 / 优惠券 / 套餐与收款 / 审计日志）'
  $dlg.ClientSize = New-Object System.Drawing.Size(900, 580)
  $dlg.StartPosition = 'CenterParent'
  $dlg.MinimizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  $script:mbOrders = @()
  $script:mbCodes = @()
  $script:mbPrices = @()
  $script:mbCycles = @()
  $script:mbPricePlans = @()
  $script:mbCoupons = @()
  $script:mbCouponPlans = @()
  $script:mbAiTrialDays = 0
  $script:planTrialDays = 0

  $lblTop = New-Object System.Windows.Forms.Label
  $lblTop.SetBounds(14, 8, 872, 38)
  $lblTop.ForeColor = [System.Drawing.Color]::DimGray
  $lblTop.Text = '加载中…'
  [void]$dlg.Controls.Add($lblTop)

  $tabs = New-Object System.Windows.Forms.TabControl
  $tabs.SetBounds(14, 50, 872, 472)
  [void]$dlg.Controls.Add($tabs)

  # ---------------- 页 1：订单 ----------------
  $pgOrder = New-Object System.Windows.Forms.TabPage
  $pgOrder.Text = '订单'
  [void]$tabs.TabPages.Add($pgOrder)

  $lvO = New-Object System.Windows.Forms.ListView
  $lvO.View = 'Details'; $lvO.FullRowSelect = $true; $lvO.HideSelection = $false
  $lvO.SetBounds(8, 8, 848, 380)
  [void]$lvO.Columns.Add('订单号', 110)
  [void]$lvO.Columns.Add('用户', 200)
  [void]$lvO.Columns.Add('套餐 / 时长', 120)
  [void]$lvO.Columns.Add('金额', 70)
  [void]$lvO.Columns.Add('状态', 70)
  [void]$lvO.Columns.Add('下单时间', 130)
  [void]$lvO.Columns.Add('已支付', 130)
  [void]$pgOrder.Controls.Add($lvO)

  $lblOTip = New-Object System.Windows.Forms.Label
  $lblOTip.Text = '选中一行后点「核销开通」即给该账号叠加会员（未支付订单 7 天后自动过期）'
  $lblOTip.ForeColor = [System.Drawing.Color]::DimGray
  $lblOTip.SetBounds(8, 394, 848, 20)
  [void]$pgOrder.Controls.Add($lblOTip)

  function New-MbBtn($parent, [string]$text, [int]$x, [int]$y, [int]$w, $handler) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.SetBounds($x, $y, $w, 30)
    $b.add_Click($handler)
    [void]$parent.Controls.Add($b)
    return $b
  }

  function Refresh-Membership {
    try {
      $r = Invoke-AdminApi 'GET' '/api/admin/membership'
      $script:mbOrders = @($r.orders)
      $script:mbCodes = @($r.codes)
      $lvO.Items.Clear()
      foreach ($o in $r.orders) {
        $it = New-Object System.Windows.Forms.ListViewItem([string]$o.id)
        [void]$it.SubItems.Add([string]$o.email)
        [void]$it.SubItems.Add(([string]$o.plan) + ' · ' + $o.months + ' 个月')
        [void]$it.SubItems.Add(('¥' + $o.amount))
        [void]$it.SubItems.Add((Get-OrderStatusText ([string]$o.status)))
        [void]$it.SubItems.Add((Format-Dt ([string]$o.createdAt)))
        [void]$it.SubItems.Add((Format-Dt ([string]$o.claimedAt)))
        [void]$lvO.Items.Add($it)
      }
      # 激活码页
      $lvC.Items.Clear()
      foreach ($c in $r.codes) {
        $it = New-Object System.Windows.Forms.ListViewItem([string]$c.code)
        [void]$it.SubItems.Add(([string]$c.plan) + ' · ' + $c.months + ' 个月')
        [void]$it.SubItems.Add((Get-CodeStatusText ([string]$c.status)))
        [void]$it.SubItems.Add($(if ($c.usedByEmail) { [string]$c.usedByEmail } elseif ($c.boundToEmail) { '定向 ' + [string]$c.boundToEmail } else { '—' }))
        [void]$it.SubItems.Add([string]$c.note)
        [void]$it.SubItems.Add((Format-Dt ([string]$c.usedAt)))
        [void]$lvC.Items.Add($it)
      }
      $cnt = $r.counts
      # ⚠️ 不要写「换行后以 + 开头」的续行：PS 5.1 解析器不认，会报「表达式中缺少右)」
      #    （最小复现已验：`$x = ('a' + $b` 换行 `+ 'c')` 直接语法错误）→ 拆成中间变量
      $s1 = '待核销订单 ' + $cnt.awaitingReview + ' ｜ 未使用激活码 ' + $cnt.codesUnused + ' ｜ '
      $s2 = '已核销订单 ' + $cnt.fulfilled + ' ｜ 共 ' + $r.orders.Count + ' 个订单、' + $r.codes.Count + ' 枚激活码'
      $lblTop.Text = ($s1 + $s2)
      # 价格表页（0.23.1）：单独拉一次，失败不影响订单/激活码区
      try {
        $prd = Invoke-AdminApi 'GET' '/api/admin/prices'
        $script:mbPrices = @($prd.items)
        $script:mbCycles = @($prd.cycles)
        $script:mbPricePlans = @($prd.plans)
        $lvP.Items.Clear()
        foreach ($it in $prd.items) {
          $st = [string]$it.stateText
          if ($it.winner) { $st = $st + ' · 当前' }
          $row = New-Object System.Windows.Forms.ListViewItem([string]$it.planName)
          [void]$row.SubItems.Add([string]$it.cycleName)
          [void]$row.SubItems.Add(([string]$it.months + ' 个月'))
          [void]$row.SubItems.Add(('¥' + [string]$it.price))
          [void]$row.SubItems.Add(('¥' + [string]$it.perMonth + '/月'))
          [void]$row.SubItems.Add((Get-PriceRangeText ([string]$it.effectiveFrom) ([string]$it.effectiveTo)))
          [void]$row.SubItems.Add([string]$it.priority)
          [void]$row.SubItems.Add($st)
          [void]$row.SubItems.Add([string]$it.note)
          [void]$lvP.Items.Add($row)
        }
        $lblTop.Text = $lblTop.Text + ' ｜ 价格 ' + $script:mbPrices.Count + ' 条（生效中 '
        $active = 0
        foreach ($it in $script:mbPrices) { if ($it.state -eq 'active') { $active = $active + 1 } }
        $lblTop.Text = $lblTop.Text + $active + '）'
      } catch {
        $script:mbPrices = @()
        $lvP.Items.Clear()
      }
      # 套餐配置页（避免 $hash[[string]$k] 这种嵌套方括号写法——PS 5.1 解析器会报错）
      $freePlan = $r.plans.plans | Where-Object { $_.id -eq 'Free' } | Select-Object -First 1
      $proPlan = $r.plans.plans | Where-Object { $_.id -eq 'Pro' } | Select-Object -First 1
      if ($freePlan) {
        # 1.8.0：每日次数已取消，改为「每月额度」（微元 → 元）
        $fg = 0.0
        if ($freePlan.monthlyGrantMicro) { $fg = [double]$freePlan.monthlyGrantMicro / 1000000 }
        $txtFreeGrant.Text = $fg.ToString('0.00')
        $chkFreeHi.Checked = [bool]$freePlan.highTierModels
      }
      # ★ 先用服务端返回值刷新 $script:mbAiTrialDays，再写控件 —— 顺序反了会把 0 写进文本框，
      #   随后点「保存配置」就把 7 天试用误关成 0（2026-10-17 实踩，已恢复）。
      if ($r.plans.ai) { $script:mbAiTrialDays = [int]$r.plans.ai.trialDays }
      $txtTrialDays.Text = [string]$script:mbAiTrialDays
      if ($proPlan) {
        $pg = 0.0
        if ($proPlan.monthlyGrantMicro) { $pg = [double]$proPlan.monthlyGrantMicro / 1000000 }
        $txtProGrant.Text = $pg.ToString('0.00')
        $txtProPrice.Text = [string]$proPlan.price
        $chkProHi.Checked = [bool]$proPlan.highTierModels
      }
      $txtPayChannel.Text = [string]$r.plans.pay.channel
      $txtPayQr.Text = [string]$r.plans.pay.qrImage
      $txtPayText.Text = [string]$r.plans.pay.qrText
      $txtPayNote.Text = [string]$r.plans.pay.note
      # 生成激活码的套餐下拉（只列可购买的）
      $selCodePlan.Items.Clear()
      foreach ($p in $r.plans.plans) { if ($p.purchasable) { [void]$selCodePlan.Items.Add([string]$p.id) } }
      if ($selCodePlan.Items.Count -gt 0 -and -not $selCodePlan.SelectedItem) { $selCodePlan.SelectedIndex = 0 }
      $opts = @()
      foreach ($po in $r.plans.priceOptions) { $opts += ($po.label + ' ¥' + $po.price) }
      $lblPrice.Text = $(if ($opts.Count -gt 0) { '当前价格档位：' + ($opts -join '　|　') } else { '当前无价格档位' })
      $r = $null
    } catch {
      [System.Windows.Forms.MessageBox]::Show('加载会员数据失败：' + (Get-HttpErrorDetail $_), '错误', 'OK', 'Warning') | Out-Null
    }
    # 审计页顺带刷新（同一套 /api/admin/audit；失败只在顶部提示，不打断其他页）
    try { Refresh-Audit } catch { }
  }

  New-MbBtn $pgOrder '核销开通（叠加会员）' 8 420 170 {
    if ($lvO.SelectedItems.Count -eq 0) {
      [System.Windows.Forms.MessageBox]::Show('请先选中一个订单', '提示', 'OK', 'Information') | Out-Null
      return
    }
    $o = $script:mbOrders[$lvO.SelectedItems[0].Index]
    if ($o.status -eq 'fulfilled') { [System.Windows.Forms.MessageBox]::Show('该订单已核销，无需重复操作', '提示', 'OK', 'Information') | Out-Null; return }
    if ($o.status -eq 'cancelled') { [System.Windows.Forms.MessageBox]::Show('该订单已取消，无法核销', '提示', 'OK', 'Information') | Out-Null; return }
    $q = '确认已收到订单 ' + $o.id + ' 的款项 ¥' + $o.amount + '？' + "`n" + '将立即为 ' + $o.email + ' 叠加 ' + $o.months + ' 个月' + $o.plan + '。'
    if ([System.Windows.Forms.MessageBox]::Show($q, '核销订单', 'YesNo', 'Question') -ne 'Yes') { return }
    try {
      $r = Invoke-AdminApi 'POST' ('/api/admin/orders/' + $o.id + '/fulfill') @{}
      $exp = ''
      if ($r.user -and $r.user.membership -and $r.user.membership.expiresAt) { $exp = ([string]$r.user.membership.expiresAt).Substring(0, 10) }
      $mark = ''
      if ($r.archiveCode) { $mark = $r.archiveCode.code }
      [System.Windows.Forms.MessageBox]::Show('已核销并开通。' + "`n`n" + '用户：' + $r.user.email + "`n" + '会员到期：' + $exp + "`n" + '留档兑换码：' + $mark, '核销成功', 'OK', 'Information') | Out-Null
      Refresh-Membership
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '核销失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgOrder '取消订单' 186 420 100 {
    if ($lvO.SelectedItems.Count -eq 0) { return }
    $o = $script:mbOrders[$lvO.SelectedItems[0].Index]
    if ([System.Windows.Forms.MessageBox]::Show('取消订单 ' + $o.id + '？用户端会显示为已取消。', '取消订单', 'YesNo', 'Question') -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'POST' ('/api/admin/orders/' + $o.id + '/cancel') @{ reason = '管理员取消' })
      Refresh-Membership
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '取消失败', 'OK', 'Warning') | Out-Null }
  }
  # ---- 收款流水对账（服务端 1.4.5）----
  # 下单会给每笔订单分配一个「同金额内唯一」的小数尾数，所以收款流水按金额即可自动匹配到订单。
  # 这里只做「预览 → 确认」两步；核销由服务端执行（并写审计）。同一套接口，Web 管理页也有入口。
  function Show-ReconcileDialog {
    $rc = New-Object System.Windows.Forms.Form
    $rc.Text = '收款流水对账（按金额自动匹配核销）'
    $rc.ClientSize = New-Object System.Drawing.Size(880, 560)
    $rc.StartPosition = 'CenterParent'
    $rc.MinimizeBox = $false
    $rc.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $rc.Icon = $script:appIcon

    $rcTip = New-Object System.Windows.Forms.Label
    $rcTip.Text = '粘贴收款流水，每行一条：金额,时间,备注（时间与备注可空；也接受 CSV / 带 ¥）。' + "`n" + '下单时会分配唯一小数尾数，所以金额可唯一对应到订单；先预览，确认无误再核销。'
    $rcTip.ForeColor = [System.Drawing.Color]::DimGray
    $rcTip.SetBounds(12, 8, 856, 34)
    [void]$rc.Controls.Add($rcTip)

    $rcText = New-Object System.Windows.Forms.TextBox
    $rcText.Multiline = $true
    $rcText.ScrollBars = 'Vertical'
    $rcText.Font = New-Object System.Drawing.Font('Consolas', 9)
    $rcText.SetBounds(12, 46, 856, 120)
    [void]$rc.Controls.Add($rcText)

    $rcWinLbl = New-Object System.Windows.Forms.Label
    $rcWinLbl.Text = '时间窗'
    $rcWinLbl.SetBounds(12, 176, 50, 20)
    [void]$rc.Controls.Add($rcWinLbl)
    $rcWin = New-Object System.Windows.Forms.NumericUpDown
    $rcWin.Minimum = 1; $rcWin.Maximum = 365; $rcWin.Value = 30
    $rcWin.SetBounds(62, 173, 60, 24)
    [void]$rc.Controls.Add($rcWin)
    $rcWinTip = New-Object System.Windows.Forms.Label
    $rcWinTip.Text = '天（只匹配下单后这段时间内的流水）'
    $rcWinTip.ForeColor = [System.Drawing.Color]::DimGray
    $rcWinTip.SetBounds(128, 176, 240, 20)
    [void]$rc.Controls.Add($rcWinTip)

    $rcLv = New-Object System.Windows.Forms.ListView
    $rcLv.View = 'Details'; $rcLv.FullRowSelect = $true; $rcLv.HideSelection = $false
    $rcLv.SetBounds(12, 206, 856, 280)
    [void]$rcLv.Columns.Add('流水金额', 100)
    [void]$rcLv.Columns.Add('结果', 100)
    [void]$rcLv.Columns.Add('订单号', 140)
    [void]$rcLv.Columns.Add('用户', 190)
    [void]$rcLv.Columns.Add('说明', 300)
    [void]$rc.Controls.Add($rcLv)

    $rcMsg = New-Object System.Windows.Forms.Label
    $rcMsg.Text = ''
    $rcMsg.ForeColor = [System.Drawing.Color]::DimGray
    $rcMsg.SetBounds(12, 492, 856, 20)
    [void]$rc.Controls.Add($rcMsg)

    $btnApply = New-Object System.Windows.Forms.Button
    $btnApply.Text = '确认核销'
    $btnApply.Enabled = $false
    $btnApply.SetBounds(560, 516, 170, 32)
    [void]$rc.Controls.Add($btnApply)

    $btnPrev = New-Object System.Windows.Forms.Button
    $btnPrev.Text = '预览匹配'
    $btnPrev.SetBounds(740, 516, 128, 32)
    [void]$rc.Controls.Add($btnPrev)

    $script:rcLast = $null

    $btnPrev.add_Click({
      if (-not $rcText.Text.Trim()) { $rcMsg.Text = '请先粘贴收款流水（每行：金额,时间,备注）'; return }
      try {
        $r = Invoke-AdminApi 'POST' '/api/admin/reconcile' @{
          text = $rcText.Text; dryRun = $true; windowDays = [int]$rcWin.Value
        }
        $rcLv.Items.Clear()
        foreach ($x in @($r.results)) {
          $it = New-Object System.Windows.Forms.ListViewItem([string]$x.amountText)
          [void]$it.SubItems.Add((Get-ReconcileStatusText ([string]$x.status)))
          [void]$it.SubItems.Add($(if ($x.orderId) { [string]$x.orderId } else { '—' }))
          [void]$it.SubItems.Add($(if ($x.email) { [string]$x.email } else { '—' }))
          if ($x.status -eq 'matched') {
            $dur = $(if ($x.perpetual) { '永久会员' } else { ([string]$x.months + ' 个月') })
            [void]$it.SubItems.Add($dur + '　下单于 ' + (Format-Dt ([string]$x.createdAt)))
          } else {
            [void]$it.SubItems.Add([string]$x.reason)
          }
          [void]$rcLv.Items.Add($it)
        }
        $script:rcLast = $r
        $mm = [int]$r.summary.matched
        $rcPart1 = '预览：共 ' + [string]$r.summary.total + ' 条 · 命中 ' + [string]$mm + ' · 无对应 '
        $rcPart1 = $rcPart1 + [string]$r.summary.unmatched + ' · 需人工 ' + [string]$r.summary.ambiguous
        $rcMsg.Text = $rcPart1 + '　命中金额 ' + [string]$r.summary.matchedText
        $btnApply.Enabled = ($mm -gt 0)
        $btnApply.Text = $(if ($mm -gt 0) { ('确认核销 ' + [string]$mm + ' 笔') } else { '确认核销' })
      } catch { $rcMsg.Text = '对账失败：' + (Get-HttpErrorDetail $_) }
    })

    $btnApply.add_Click({
      if (-not $script:rcLast) { $rcMsg.Text = '请先点「预览匹配」'; return }
      $n = [int]$script:rcLast.summary.matched
      if ($n -le 0) { return }
      $askMsg = '确认核销 ' + [string]$n + ' 笔订单（合计 ' + [string]$script:rcLast.summary.matchedText + '）？'
      $askMsg = $askMsg + "`n" + '将立即为对应用户开通/叠加会员，并写入审计日志。'
      $ask = [System.Windows.Forms.MessageBox]::Show($askMsg, '确认核销', 'YesNo', 'Question')
      if ($ask -ne 'Yes') { return }
      try {
        $r = Invoke-AdminApi 'POST' '/api/admin/reconcile' @{
          text = $rcText.Text; dryRun = $false; windowDays = [int]$rcWin.Value
        }
        $done = @($r.applied | Where-Object { $_.ok }).Count
        $rcMsg.Text = '已核销 ' + [string]$done + ' 笔；「审计日志」页可见 order.reconcile 记录'
        $script:rcLast = $null
        $btnApply.Enabled = $false
        Refresh-Membership
      } catch { $rcMsg.Text = '核销失败：' + (Get-HttpErrorDetail $_) }
    })

    [void]$rc.ShowDialog($dlg)
    $rc.Dispose()
  }

  New-MbBtn $pgOrder '对账导入' 372 420 100 { Show-ReconcileDialog }
  New-MbBtn $pgOrder '刷新' 480 420 70 { Refresh-Membership }
  New-MbBtn $pgOrder '打开 Web 管理页' 558 420 130 {
    Open-Url $AdminPage
  }
  New-MbBtn $pgOrder '关闭' 760 420 96 { $dlg.Close() }

  # ---------------- 页 2：激活码 ----------------
  $pgCode = New-Object System.Windows.Forms.TabPage
  $pgCode.Text = '激活码'
  [void]$tabs.TabPages.Add($pgCode)

  $lblGen = New-Object System.Windows.Forms.Label
  $lblGen.Text = '套餐'
  $lblGen.SetBounds(8, 14, 40, 20)
  [void]$pgCode.Controls.Add($lblGen)
  $selCodePlan = New-Object System.Windows.Forms.ComboBox
  $selCodePlan.DropDownStyle = 'DropDownList'
  $selCodePlan.SetBounds(50, 11, 110, 24)
  [void]$pgCode.Controls.Add($selCodePlan)

  $lblM = New-Object System.Windows.Forms.Label
  $lblM.Text = '时长(月)'
  $lblM.SetBounds(172, 14, 56, 20)
  [void]$pgCode.Controls.Add($lblM)
  $txtCodeMonths = New-Object System.Windows.Forms.TextBox
  $txtCodeMonths.Text = '1'
  $txtCodeMonths.SetBounds(232, 11, 50, 24)
  [void]$pgCode.Controls.Add($txtCodeMonths)

  $lblN = New-Object System.Windows.Forms.Label
  $lblN.Text = '数量'
  $lblN.SetBounds(292, 14, 34, 20)
  [void]$pgCode.Controls.Add($lblN)
  $txtCodeCount = New-Object System.Windows.Forms.TextBox
  $txtCodeCount.Text = '1'
  $txtCodeCount.SetBounds(328, 11, 50, 24)
  [void]$pgCode.Controls.Add($txtCodeCount)

  $lblNote = New-Object System.Windows.Forms.Label
  $lblNote.Text = '备注'
  $lblNote.SetBounds(388, 14, 34, 20)
  [void]$pgCode.Controls.Add($lblNote)
  $txtCodeNote = New-Object System.Windows.Forms.TextBox
  $txtCodeNote.SetBounds(424, 11, 250, 24)
  [void]$pgCode.Controls.Add($txtCodeNote)

  New-MbBtn $pgCode '生成' 682 8 70 {
    try {
      $plan = [string]$selCodePlan.SelectedItem
      if (-not $plan) { throw (New-Object System.Exception '请选择套餐（可购买等级）') }
      $body = @{
        plan = $plan
        months = [int]$txtCodeMonths.Text
        count = [int]$txtCodeCount.Text
        note = $txtCodeNote.Text.Trim()
      }
      $r = Invoke-AdminApi 'POST' '/api/admin/codes' $body
      $codes = @()
      foreach ($c in $r.codes) { $codes += $c.code }
      [System.Windows.Forms.Clipboard]::SetText(($codes -join "`r`n"))
      [System.Windows.Forms.MessageBox]::Show(('已生成 ' + $codes.Count + ' 枚激活码（已复制到剪贴板）：' + "`n`n" + ($codes -join "`n")), '生成成功', 'OK', 'Information') | Out-Null
      $txtCodeNote.Text = ''
      Refresh-Membership
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '生成失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgCode '刷新' 758 8 96 { Refresh-Membership }

  $lvC = New-Object System.Windows.Forms.ListView
  $lvC.View = 'Details'; $lvC.FullRowSelect = $true; $lvC.HideSelection = $false
  $lvC.SetBounds(8, 44, 848, 344)
  [void]$lvC.Columns.Add('激活码', 160)
  [void]$lvC.Columns.Add('套餐 / 时长', 120)
  [void]$lvC.Columns.Add('状态', 70)
  [void]$lvC.Columns.Add('绑定 / 使用', 200)
  [void]$lvC.Columns.Add('备注', 170)
  [void]$lvC.Columns.Add('使用时间', 130)
  [void]$pgCode.Controls.Add($lvC)

  $lblCTip = New-Object System.Windows.Forms.Label
  $lblCTip.Text = '激活码给线下售卖 / 赠送 / 补偿用；用户在插件「会员」卡片里输入即可激活（大小写与连字符不敏感）'
  $lblCTip.ForeColor = [System.Drawing.Color]::DimGray
  $lblCTip.SetBounds(8, 392, 848, 20)
  [void]$pgCode.Controls.Add($lblCTip)

  New-MbBtn $pgCode '复制选中' 8 418 100 {
    if ($lvC.SelectedItems.Count -eq 0) { return }
    $c = $script:mbCodes[$lvC.SelectedItems[0].Index]
    [System.Windows.Forms.Clipboard]::SetText([string]$c.code)
    [System.Windows.Forms.MessageBox]::Show('已复制：' + $c.code, '复制', 'OK', 'Information') | Out-Null
  }
  New-MbBtn $pgCode '作废选中' 116 418 100 {
    if ($lvC.SelectedItems.Count -eq 0) { return }
    $c = $script:mbCodes[$lvC.SelectedItems[0].Index]
    if ($c.status -eq 'used') {
      [System.Windows.Forms.MessageBox]::Show('已使用的激活码不能作废（保留对账记录）', '提示', 'OK', 'Information') | Out-Null
      return
    }
    if ([System.Windows.Forms.MessageBox]::Show('作废激活码 ' + $c.code + '？', '作废', 'YesNo', 'Question') -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/codes/' + $c.id))
      Refresh-Membership
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '作废失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgCode '关闭' 760 418 96 { $dlg.Close() }

  # ---------------- 页 3：价格与周期（0.23.1） ----------------
  $pgPrice = New-Object System.Windows.Forms.TabPage
  $pgPrice.Text = '价格与周期'
  [void]$tabs.TabPages.Add($pgPrice)

  $lvP = New-Object System.Windows.Forms.ListView
  $lvP.View = 'Details'; $lvP.FullRowSelect = $true; $lvP.HideSelection = $false
  $lvP.SetBounds(8, 8, 848, 344)
  [void]$lvP.Columns.Add('等级', 90)
  [void]$lvP.Columns.Add('计费周期', 80)
  [void]$lvP.Columns.Add('时长', 60)
  [void]$lvP.Columns.Add('价格', 80)
  [void]$lvP.Columns.Add('折合', 90)
  [void]$lvP.Columns.Add('生效时段', 160)
  [void]$lvP.Columns.Add('优先级', 55)
  [void]$lvP.Columns.Add('状态', 110)
  [void]$lvP.Columns.Add('备注', 120)
  [void]$pgPrice.Controls.Add($lvP)

  $lblPTip2 = New-Object System.Windows.Forms.Label
  $lblPTip2.Text = '价格 = 等级 × 计费周期 × 生效时段；时段留空即「立即生效 / 长期有效」。促销不必切分基础价：时段重叠时按优先级决胜（高者胜 → 起期晚者胜）。'
  $lblPTip2.ForeColor = [System.Drawing.Color]::DimGray
  $lblPTip2.SetBounds(8, 356, 848, 20)
  [void]$pgPrice.Controls.Add($lblPTip2)

  New-MbBtn $pgPrice '＋ 新增价格' 8 380 110 {
    Show-PriceForm $dlg $null
  }
  New-MbBtn $pgPrice '编辑' 126 380 80 {
    if ($lvP.SelectedItems.Count -eq 0) { return }
    Show-PriceForm $dlg $script:mbPrices[$lvP.SelectedItems[0].Index]
  }
  New-MbBtn $pgPrice '启用/停用' 214 380 100 {
    if ($lvP.SelectedItems.Count -eq 0) { return }
    $it = $script:mbPrices[$lvP.SelectedItems[0].Index]
    try {
      [void](Invoke-AdminApi 'PUT' ('/api/admin/prices/' + $it.id) @{ enabled = (-not [bool]$it.enabled) })
      Refresh-Membership
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '操作失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgPrice '删除' 322 380 80 {
    if ($lvP.SelectedItems.Count -eq 0) { return }
    $it = $script:mbPrices[$lvP.SelectedItems[0].Index]
    $q = '删除价格条目「' + [string]$it.planName + ' · ' + $it.months + ' 个月 ¥' + $it.price + '」？' + "`n`n" + '历史订单不受影响（订单已存价格快照）。'
    if ([System.Windows.Forms.MessageBox]::Show($q, '删除价格', 'YesNo', 'Question') -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/prices/' + $it.id))
      Refresh-Membership
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '删除失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgPrice '刷新' 410 380 70 { Refresh-Membership }
  New-MbBtn $pgPrice '关闭' 760 380 96 { $dlg.Close() }

  # ---------------- 页 4：套餐与收款 ----------------
  $pgPlan = New-Object System.Windows.Forms.TabPage
  $pgPlan.Text = '套餐与收款'
  [void]$tabs.TabPages.Add($pgPlan)

  function New-PLabel($parent, [string]$text, [int]$x, [int]$y) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.SetBounds($x, $y, 150, 20)
    [void]$parent.Controls.Add($l)
  }
  function New-PInput($parent, [int]$x, [int]$y, [int]$w) {
    $t = New-Object System.Windows.Forms.TextBox
    $t.SetBounds($x, $y, $w, 24)
    [void]$parent.Controls.Add($t)
    return $t
  }

  New-PLabel $pgPlan '免费版 · 每月额度（¥）' 16 20
  $txtFreeGrant = New-PInput $pgPlan 190 17 120
  New-PLabel $pgPlan '专业版 · 每月额度（¥）' 16 54
  $txtProGrant = New-PInput $pgPlan 190 51 120
  New-PLabel $pgPlan '专业版 · 单月价（¥）' 16 88
  $txtProPrice = New-PInput $pgPlan 190 85 120
  $lblPrice = New-Object System.Windows.Forms.Label
  $lblPrice.ForeColor = [System.Drawing.Color]::DimGray
  $lblPrice.SetBounds(330, 88, 500, 20)
  [void]$pgPlan.Controls.Add($lblPrice)

  # 1.4.9 AI 能力：新用户全模型试用天数 + 各档能否用高级模型
  New-PLabel $pgPlan '新用户全模型试用（天）' 16 122
  $txtTrialDays = New-PInput $pgPlan 190 119 80
  New-PLabel $pgPlan '可用高级模型：' 330 122
  $chkFreeHi = New-Object System.Windows.Forms.CheckBox
  $chkFreeHi.Text = '免费版'
  $chkFreeHi.SetBounds(490, 120, 76, 22)
  [void]$pgPlan.Controls.Add($chkFreeHi)
  $chkProHi = New-Object System.Windows.Forms.CheckBox
  $chkProHi.Text = '专业版'
  $chkProHi.SetBounds(572, 120, 76, 22)
  [void]$pgPlan.Controls.Add($chkProHi)
  $lblAiHint = New-Object System.Windows.Forms.Label
  $lblAiHint.Text = '0 = 关闭试用；需配合通道窗体里的「高级模型」清单，清单为空则此项无效果'
  $lblAiHint.ForeColor = [System.Drawing.Color]::DimGray
  $lblAiHint.SetBounds(330, 144, 520, 20)
  [void]$pgPlan.Controls.Add($lblAiHint)

  New-PLabel $pgPlan '收款渠道名' 16 170
  $txtPayChannel = New-PInput $pgPlan 190 167 250
  New-PLabel $pgPlan '收款码图片地址（可空）' 16 204
  $txtPayQr = New-PInput $pgPlan 190 201 640
  New-PLabel $pgPlan '文字收款信息（无图片时展示）' 16 238
  $txtPayText = New-PInput $pgPlan 190 235 640
  New-PLabel $pgPlan '支付说明' 16 272
  $txtPayNote = New-PInput $pgPlan 190 269 640

  New-MbBtn $pgPlan '保存配置' 16 316 120 {
    # 试用天数是数字文本框：非法/留空一律按 0 处理（服务端还会再校验一次）
    $td = 0
    if (-not [int]::TryParse($txtTrialDays.Text.Trim(), [ref]$td)) { $td = 0 }
    if ($td -lt 0) { $td = 0 }
    $script:planTrialDays = $td
    # 每月额度（元）→ 微元；非法/空按 0
    $fg = 0.0
    if (-not [double]::TryParse($txtFreeGrant.Text.Trim(), [ref]$fg)) { $fg = 0 }
    if ($fg -lt 0) { $fg = 0 }
    $pg = 0.0
    if (-not [double]::TryParse($txtProGrant.Text.Trim(), [ref]$pg)) { $pg = 0 }
    if ($pg -lt 0) { $pg = 0 }
    try {
      $body = @{
        plans = @{
          Free = @{ monthlyGrantMicro = [int][Math]::Round($fg * 1000000); highTierModels = [bool]$chkFreeHi.Checked }
          Pro = @{ monthlyGrantMicro = [int][Math]::Round($pg * 1000000); price = [int]$txtProPrice.Text; highTierModels = [bool]$chkProHi.Checked }
        }
        ai = @{ trialDays = $script:planTrialDays }
        pay = @{
          channel = $txtPayChannel.Text.Trim()
          qrImage = $txtPayQr.Text.Trim()
          qrText = $txtPayText.Text.Trim()
          note = $txtPayNote.Text.Trim()
        }
      }
      [void](Invoke-AdminApi 'PUT' '/api/admin/membership' $body)
      [System.Windows.Forms.MessageBox]::Show('已保存并即时生效（插件端下次拉取即更新，无需重启服务端）', '成功', 'OK', 'Information') | Out-Null
      Refresh-Membership
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '保存失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgPlan '重新载入' 144 316 100 { Refresh-Membership }
  New-MbBtn $pgPlan '关闭' 760 316 96 { $dlg.Close() }

  $lblPTip = New-Object System.Windows.Forms.Label
  $lblPTip.Text = '1.8.0 起取消「每日调用次数」：AI 调用统一从余额扣费（注册赠送 → 每月额度 → 充值），余额不足返回 402。' + "`n" + '「每月额度」= 该档每月发放的金额（¥，0 = 不发，不结转）；专业版默认 ¥20。' + "`n" + '「新用户全模型试用」从注册时间起算，试用期内免费用户也能用高级模型（余额口径不变）；同一套配置也作用于 Web 管理页。'
  $lblPTip.ForeColor = [System.Drawing.Color]::DimGray
  $lblPTip.SetBounds(16, 360, 830, 54)
  [void]$pgPlan.Controls.Add($lblPTip)

  # ---------------- 页 5：审计日志（服务端 1.4.4） ----------------
  # 记录所有管理写操作（核销/改价/删用户/回滚/改配置…）：时间、对象、来源、前后值。
  # 密钥与密码永不写入；激活码也不记码值本身。同一套数据也能在 Web 管理页「审计日志」里看。
  $pgAudit = New-Object System.Windows.Forms.TabPage
  $pgAudit.Text = '审计日志'
  [void]$tabs.TabPages.Add($pgAudit)

  $lvA = New-Object System.Windows.Forms.ListView
  $lvA.View = 'Details'; $lvA.FullRowSelect = $true; $lvA.HideSelection = $false
  $lvA.SetBounds(8, 40, 848, 372)
  [void]$lvA.Columns.Add('时间', 140)
  [void]$lvA.Columns.Add('操作', 120)
  [void]$lvA.Columns.Add('对象', 190)
  [void]$lvA.Columns.Add('来源', 90)
  [void]$lvA.Columns.Add('说明 / 前后值', 300)
  [void]$pgAudit.Controls.Add($lvA)

  $lblAF = New-Object System.Windows.Forms.Label
  $lblAF.Text = '筛选'; $lblAF.SetBounds(10, 13, 34, 20)
  [void]$pgAudit.Controls.Add($lblAF)
  $cmbAAct = New-Object System.Windows.Forms.ComboBox
  $cmbAAct.DropDownStyle = 'DropDownList'
  $cmbAAct.SetBounds(46, 10, 240, 24)
  [void]$cmbAAct.Items.Add('全部操作')
  $cmbAAct.SelectedIndex = 0
  [void]$pgAudit.Controls.Add($cmbAAct)
  $txtATgt = New-Object System.Windows.Forms.TextBox
  $txtATgt.SetBounds(296, 10, 240, 24)
  [void]$pgAudit.Controls.Add($txtATgt)
  $lblATip = New-Object System.Windows.Forms.Label
  $lblATip.Text = '对象可填邮箱 / 订单号 / 条目 id'
  $lblATip.ForeColor = [System.Drawing.Color]::DimGray
  $lblATip.SetBounds(544, 13, 240, 20)
  [void]$pgAudit.Controls.Add($lblATip)

  function Refresh-Audit {
    try {
      $q = 'limit=200'
      if ($cmbAAct.SelectedIndex -gt 0) { $q = $q + '&action=' + [uri]::EscapeDataString([string]$cmbAAct.SelectedItem) }
      if ($txtATgt.Text.Trim()) { $q = $q + '&target=' + [uri]::EscapeDataString($txtATgt.Text.Trim()) }
      $r = Invoke-AdminApi 'GET' ('/api/admin/audit?' + $q)
      # 首次拉到动作表后填充下拉（保留当前选择）
      if ($cmbAAct.Items.Count -le 1 -and $r.actions) {
        foreach ($k in $r.actions.PSObject.Properties.Name) { [void]$cmbAAct.Items.Add($k) }
      }
      $lvA.Items.Clear()
      foreach ($e in @($r.items)) {
        $it = New-Object System.Windows.Forms.ListViewItem((Format-Dt ([string]$e.at)))
        [void]$it.SubItems.Add((Get-AuditText ([string]$e.action)))
        [void]$it.SubItems.Add([string]$e.target)
        [void]$it.SubItems.Add([string]$e.ip)
        $parts = @()
        if ($e.note) { $parts += [string]$e.note }
        if ($e.before -and $e.after) { $parts += ('前 ' + (ConvertTo-ShortJson $e.before) + ' → 后 ' + (ConvertTo-ShortJson $e.after)) }
        elseif ($e.after) { $parts += (ConvertTo-ShortJson $e.after) }
        elseif ($e.before) { $parts += ('前 ' + (ConvertTo-ShortJson $e.before)) }
        [void]$it.SubItems.Add(($parts -join '；'))
        [void]$lvA.Items.Add($it)
      }
      $st = $r.stats
      $lblTop.Text = '审计日志 ' + @($r.items).Count + ' 条 · 体积 ' + (Format-Bytes $st.bytes) + ' / 上限 ' + (Format-Bytes $st.maxBytes)
    } catch {
      $lblTop.Text = '审计日志读取失败：' + (Get-HttpErrorDetail $_)
    }
  }
  New-MbBtn $pgAudit '刷新' 300 416 70 { Refresh-Audit }
  New-MbBtn $pgAudit '关闭' 760 416 96 { $dlg.Close() }

  $lblATip2 = New-Object System.Windows.Forms.Label
  $lblATip2.Text = '一行一条 JSON，落在 server\data\audit.log（本地文件，不进 git）；超过 2MB 自动轮转成 audit.log.1。'
  $lblATip2.ForeColor = [System.Drawing.Color]::DimGray
  $lblATip2.SetBounds(16, 446, 830, 20)
  [void]$pgAudit.Controls.Add($lblATip2)

  # ---------------- 页 6：优惠券 / 折扣码 ----------------
  # 与激活码的分工：激活码"直接发会员"（免费、不走订单）；优惠券"只打折"，仍走下单→收款→核销。
  # 名额在下单时占用、取消/超时释放、核销才消耗 ⇒ 用户乱点不会把限量券耗光。
  $pgCoup = New-Object System.Windows.Forms.TabPage
  $pgCoup.Text = '优惠券'
  [void]$tabs.TabPages.Add($pgCoup)

  $lvCp = New-Object System.Windows.Forms.ListView
  $lvCp.View = 'Details'; $lvCp.FullRowSelect = $true; $lvCp.HideSelection = $false
  $lvCp.SetBounds(8, 8, 848, 400)
  [void]$lvCp.Columns.Add('券码', 150)
  [void]$lvCp.Columns.Add('内容', 210)
  [void]$lvCp.Columns.Add('范围', 110)
  [void]$lvCp.Columns.Add('用量', 110)
  [void]$lvCp.Columns.Add('有效期', 130)
  [void]$lvCp.Columns.Add('状态', 70)
  [void]$pgCoup.Controls.Add($lvCp)

  $lblCpTip = New-Object System.Windows.Forms.Label
  $lblCpTip.Text = '折后仍会再加 1~99 分的专属对账尾数（自动对账不受影响）；折后至少留 ¥1，100% 减免请用激活码。'
  $lblCpTip.ForeColor = [System.Drawing.Color]::DimGray
  $lblCpTip.SetBounds(10, 442, 840, 20)
  [void]$pgCoup.Controls.Add($lblCpTip)

  function Refresh-Coupons {
    try {
      $r = Invoke-AdminApi 'GET' '/api/admin/coupons'
      $script:mbCoupons = @($r.coupons)
      $lvCp.Items.Clear()
      foreach ($c in $script:mbCoupons) {
        $usage = '0 / 不限'
        if ([int]$c.maxUses -gt 0) { $usage = [string]$c.usedCount + ' / ' + [string]$c.maxUses }
        else { $usage = [string]$c.usedCount + ' / 不限' }
        if ([int]$c.perUser -gt 0) { $usage = $usage + '（每人 ' + [string]$c.perUser + '）' }
        $scope = '全场通用'
        if (@($c.plans).Count -gt 0) { $scope = (@($c.plans) -join '/') }
        $from = '立即'
        if ($c.effectiveFrom) { $from = ([string]$c.effectiveFrom).Substring(0, 10) }
        $to = '长期'
        if ($c.effectiveTo) { $to = ([string]$c.effectiveTo).Substring(0, 10) }
        $it = New-Object System.Windows.Forms.ListViewItem([string]$c.code)
        [void]$it.SubItems.Add([string]$c.label)
        [void]$it.SubItems.Add($scope)
        [void]$it.SubItems.Add($usage)
        [void]$it.SubItems.Add($from + ' ~ ' + $to)
        [void]$it.SubItems.Add([string]$c.stateText)
        [void]$lvCp.Items.Add($it)
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show('加载优惠券失败：' + (Get-HttpErrorDetail $_), '错误', 'OK', 'Warning') | Out-Null
    }
  }

  New-MbBtn $pgCoup '＋ 新建优惠券' 8 418 130 { Show-CouponForm $null; Refresh-Coupons }
  New-MbBtn $pgCoup '编辑' 146 418 70 {
    if ($lvCp.SelectedItems.Count -eq 0) { return }
    Show-CouponForm $script:mbCoupons[$lvCp.SelectedItems[0].Index]
    Refresh-Coupons
  }
  New-MbBtn $pgCoup '停用/启用' 224 418 90 {
    if ($lvCp.SelectedItems.Count -eq 0) { return }
    $c = $script:mbCoupons[$lvCp.SelectedItems[0].Index]
    $want = -not [bool]$c.enabled
    try {
      [void](Invoke-AdminApi 'PUT' ('/api/admin/coupons/' + [string]$c.id) @{ enabled = $want })
      Refresh-Coupons
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgCoup '复制券码' 322 418 90 {
    if ($lvCp.SelectedItems.Count -eq 0) { return }
    $code = [string]$script:mbCoupons[$lvCp.SelectedItems[0].Index].code
    try {
      [System.Windows.Forms.Clipboard]::SetText($code)
      [System.Windows.Forms.MessageBox]::Show('已复制：' + $code + "`n" + '发给用户即可，大小写与连字符都不敏感。', '已复制', 'OK', 'Information') | Out-Null
    } catch {
      [System.Windows.Forms.MessageBox]::Show('券码：' + $code, '复制失败，请手工抄录', 'OK', 'Information') | Out-Null
    }
  }
  New-MbBtn $pgCoup '作废' 420 418 70 {
    if ($lvCp.SelectedItems.Count -eq 0) { return }
    $c = $script:mbCoupons[$lvCp.SelectedItems[0].Index]
    $q = [System.Windows.Forms.MessageBox]::Show(
      ('确定作废 ' + [string]$c.code + '？' + "`n" + '已被订单占用或已使用的券无法作废（需先处理那些订单）。'),
      '作废优惠券', 'YesNo', 'Question')
    if ($q -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/coupons/' + [string]$c.id))
      Refresh-Coupons
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '失败', 'OK', 'Warning') | Out-Null }
  }
  New-MbBtn $pgCoup '刷新' 498 418 70 { Refresh-Coupons }
  New-MbBtn $pgCoup '关闭' 760 418 96 { $dlg.Close() }

  Refresh-Membership
  Refresh-Coupons
  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}

# ---------------- 开机自启（HKCU Run 键：账号后台 + 公网通道） ----------------
$script:RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunKeyName = 'PapilotAccountServer'
$script:RunKeyNameTunnel = 'PapilotTunnel'
function Get-StartupEnabled {
  try {
    $p = Get-ItemProperty -Path $script:RunKeyPath -ErrorAction Stop
    return ([bool]($p.$script:RunKeyName) -and [bool]($p.$script:RunKeyNameTunnel))
  } catch { return $false }
}
function Set-Startup([bool]$enable) {
  if ($enable) {
    Set-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyName -Value (Join-Path $PSScriptRoot 'start-server-hidden.vbs')
    # 公网通道自启：项目内 vbs（随移动硬盘走；换电脑后点两次本按钮即可刷新路径）
    Set-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyNameTunnel -Value (Join-Path $ProjectRoot 'runtime\cloudflared\cloudflared-run-papilot-hidden.vbs')
  } else {
    Remove-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyName -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyNameTunnel -ErrorAction SilentlyContinue
  }
}

# ---------------- 随控制台自动拉起后台与通道（1.8.1） ----------------
# 默认开启：双击 bat 后不需要再点两个「启动」。偏好存 HKCU，换盘不影响。
$script:PrefKey = 'HKCU:\Software\Papilot'
function Get-AutoBootServices {
  try {
    $p = Get-ItemProperty -Path $script:PrefKey -Name AutoStartServices -ErrorAction Stop
    return ([int]$p.AutoStartServices -ne 0)
  } catch { return $true }
}
function Set-AutoBootServices([bool]$on) {
  try {
    if (-not (Test-Path $script:PrefKey)) { New-Item -Path $script:PrefKey -Force | Out-Null }
    Set-ItemProperty -Path $script:PrefKey -Name AutoStartServices -Value ([int]$on)
  } catch { }
}

function Start-ServicesOnBoot {
  if (-not (Get-AutoBootServices)) {
    Write-Boot 'auto-start disabled by pref'
    return
  }
  $h = Get-HealthCached 2
  $st = Get-ServerState ($null -ne $h)
  if ($st.State -eq 'stopped') {
    $r = Start-Server
    $ok = -not ([string]$r).StartsWith('error:') -and -not ([string]$r).StartsWith('occupied:')
    Write-LauncherAudit 'auto-start-server' ([string]$r) $ok
    Write-Boot ('auto start server: ' + $r)
    if ($r -eq 'started') { $lblMsg.Text = '已自动启动账号后台，等待就绪（约 10~30 秒）…' }
    elseif ($r -eq 'already') { $lblMsg.Text = '账号后台已在运行' }
    elseif ($r -eq 'starting') { $lblMsg.Text = '账号后台正在启动中…' }
    elseif (([string]$r).StartsWith('occupied:')) { $lblMsg.Text = '端口 8000 被其他程序占用，未能自动启动后台' }
  }
  # 进程未起才拉通道；有进程但未连边不重复拉（避免多开）
  $tp = Get-TunnelProcessCached 0
  if ($tp.Count -eq 0) {
    $tr = Start-Tunnel
    Write-LauncherAudit 'auto-start-tunnel' ([string]$tr) ($tr -eq 'started' -or $tr -eq 'already')
    Write-Boot ('auto start tunnel: ' + $tr)
    if ($tr -eq 'started') { $lblMsg.Text = ([string]$lblMsg.Text + ' · 已发起公网通道').Trim() }
    elseif ($tr -eq 'no-token') { $lblMsg.Text = '公网通道缺少 token.txt，未自动启动（见维护页自检）' }
    elseif ($tr -eq 'missing') { $lblMsg.Text = '公网通道缺少运行器，未自动启动（见维护页自检）' }
  }
  $script:healthAt = [datetime]::MinValue
  $script:tunProcAt = [datetime]::MinValue
  $script:tunTick = 0
}

# ============================================================
# 主界面（v1.8.0 重构：侧栏导航 + 五页 + 状态卡 / 运维面板）
# ------------------------------------------------------------
# 设计依据见 docs/启动控制台-v1.8.0-重构设计.md：
#   1) 1.8.0 取消每日调用次数 → 控制台不再出现「次数/上限」，改为余额口径
#   2) 计费阀门（enforce / 注册赠送 / Pro 每月 ¥20 / 在线支付）必须一眼可见
#   3) 把 health 里的告警/计量/快照信号落到「运维与告警」页
#   4) 控制台自己的启停/快照动作写本地审计（launcher-audit.jsonl）
# ============================================================
$script:ColBg     = [System.Drawing.Color]::FromArgb(245, 247, 250)
$script:ColCard   = [System.Drawing.Color]::White
$script:ColText   = [System.Drawing.Color]::FromArgb(30, 41, 59)
$script:ColMuted  = [System.Drawing.Color]::FromArgb(100, 116, 139)
$script:ColSide   = [System.Drawing.Color]::FromArgb(15, 23, 42)
$script:ColSideHi = [System.Drawing.Color]::FromArgb(30, 41, 59)
$script:ColAccent = [System.Drawing.Color]::FromArgb(37, 99, 235)
$script:ColGreen  = [System.Drawing.Color]::FromArgb(15, 110, 86)
$script:ColRed    = [System.Drawing.Color]::FromArgb(163, 45, 45)
$script:ColAmber  = [System.Drawing.Color]::FromArgb(184, 134, 11)
$script:ColOrange = [System.Drawing.Color]::FromArgb(196, 90, 27)

$script:ApiBase = 'http://127.0.0.1:' + $Port
$script:StdoutLog = $StdoutLog
$script:health = $null
$script:healthAt = [datetime]::MinValue
$script:plans = $null
$script:plansAt = [datetime]::MinValue
# 1.8.3 在线支付网关详情（/api/admin/payment；控制台「计费与会员」页展示）
$script:payGw = $null
$script:payGwAt = [datetime]::MinValue
$script:channels = $null
$script:channelsAt = [datetime]::MinValue
$script:opsAt = [datetime]::MinValue
$script:pages = [ordered]@{}
$script:navButtons = [ordered]@{}
$script:pageMeta = [ordered]@{}
$script:ui = @{}
$script:activePage = 'overview'
$script:busy = $false
$script:svcState = 'stopped'
$script:tunProcCount = 0
$script:lastSvcState = ''
$script:lastTunState = ''
$script:lastBacklogOverdue = $false
# 健康探测的负缓存 / 退避（见 Get-HealthCached）：失败也要记账，否则一拍会重发多次探测
$script:healthFailAt = [datetime]::MinValue
$script:healthHardFail = 0
$script:tickBusy = $false

# ---------------- 通用控件工厂 ----------------
function New-UiLabel {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H,
        [double]$Size = 9, [bool]$Bold = $false, $Color = $null)
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $Text
  $l.SetBounds($X, $Y, $W, $H)
  $style = [System.Drawing.FontStyle]::Regular
  if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
  $l.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', [float]$Size, $style)
  if ($Color -is [System.Drawing.Color]) { $l.ForeColor = $Color } else { $l.ForeColor = $script:ColText }
  $l.AutoEllipsis = $true
  [void]$Parent.Controls.Add($l)
  return $l
}

function New-UiButton {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H, $Handler)
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $Text
  $b.SetBounds($X, $Y, $W, $H)
  $b.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  if ($null -ne $Handler) { $b.add_Click($Handler) }
  [void]$Parent.Controls.Add($b)
  return $b
}

function New-UiGroup {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H)
  $g = New-Object System.Windows.Forms.GroupBox
  $g.Text = $Text
  $g.SetBounds($X, $Y, $W, $H)
  $g.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $g.ForeColor = $script:ColText
  [void]$Parent.Controls.Add($g)
  return $g
}

function New-UiCard {
  param($Parent, [string]$Title, [int]$X, [int]$Y, [int]$W, [int]$H)
  $p = New-Object System.Windows.Forms.Panel
  $p.SetBounds($X, $Y, $W, $H)
  $p.BackColor = $script:ColCard
  $p.BorderStyle = 'FixedSingle'
  [void]$Parent.Controls.Add($p)
  $t = New-UiLabel $p $Title 12 8 ($W - 24) 18 8.5 $false $script:ColMuted
  $v = New-UiLabel $p '—' 12 28 ($W - 24) 26 11 $true $script:ColText
  $d = New-UiLabel $p '' 12 56 ($W - 24) 32 8 $false $script:ColMuted
  return @{ Panel = $p; Value = $v; Detail = $d }
}

function New-UiStat {
  param($Parent, [string]$Title, [int]$X, [int]$Y, [int]$W)
  $p = New-Object System.Windows.Forms.Panel
  $p.SetBounds($X, $Y, $W, 64)
  $p.BackColor = $script:ColCard
  $p.BorderStyle = 'FixedSingle'
  [void]$Parent.Controls.Add($p)
  $t = New-UiLabel $p $Title 10 7 ($W - 20) 16 8 $false $script:ColMuted
  $v = New-UiLabel $p '—' 10 25 ($W - 20) 30 14 $true $script:ColText
  return @{ Panel = $p; Value = $v }
}

function Set-UiCard {
  param($Card, [string]$Value, [string]$Detail, $Color)
  if ($null -eq $Card) { return }
  $Card.Value.Text = $Value
  # 防御：颜色参数异常时退回默认色，绝不让一次刷新把整个 UI 打崩
  if ($Color -is [System.Drawing.Color]) { $Card.Value.ForeColor = $Color }
  $Card.Detail.Text = $Detail
}

function Set-UiStat {
  param($Stat, [string]$Value, $Color)
  if ($null -eq $Stat) { return }
  $Stat.Value.Text = $Value
  if ($Color -is [System.Drawing.Color]) { $Stat.Value.ForeColor = $Color }
}

# ---------------- 控制台本地操作审计 ----------------
$script:LauncherAuditFile = Join-Path $DataDir 'launcher-audit.jsonl'

function Write-LauncherAudit {
  param([string]$Action, [string]$Detail, [bool]$Ok = $true)
  try {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    $obj = [ordered]@{ at = (Get-Date).ToString('o'); action = $Action; detail = $Detail; ok = $Ok; user = [string]$env:USERNAME }
    $line = ($obj | ConvertTo-Json -Compress)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($script:LauncherAuditFile, $line + "`n", $enc)
    $lines = [System.IO.File]::ReadAllLines($script:LauncherAuditFile, [System.Text.Encoding]::UTF8)
    if ($lines.Length -gt 500) {
      $keep = $lines[($lines.Length - 500)..($lines.Length - 1)]
      [System.IO.File]::WriteAllLines($script:LauncherAuditFile, $keep, $enc)
    }
  } catch { }
}

function Read-LauncherAudit {
  param([int]$Limit = 8)
  try {
    if (-not (Test-Path $script:LauncherAuditFile)) { return @() }
    $lines = [System.IO.File]::ReadAllLines($script:LauncherAuditFile, [System.Text.Encoding]::UTF8)
    $out = @()
    for ($i = $lines.Length - 1; $i -ge 0 -and $out.Count -lt $Limit; $i--) {
      if (-not $lines[$i]) { continue }
      try { $out += ($lines[$i] | ConvertFrom-Json) } catch { }
    }
    return $out
  } catch { return @() }
}

# ---------------- HTTP / 缓存 ----------------
function Invoke-UiApi {
  param([string]$Method, [string]$Path, $Body, [int]$TimeoutSec = 4)
  $params = @{
    Method = $Method
    Uri = ($script:ApiBase + $Path)
    UseBasicParsing = $true
    TimeoutSec = $TimeoutSec
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = ($Body | ConvertTo-Json -Compress -Depth 6)
  }
  return Invoke-RestMethod @params
}

function Get-HealthCached {
  param([int]$MaxAgeSec = 8)
  $now = Get-Date
  if ($script:health -and ($now - $script:healthAt).TotalSeconds -lt $MaxAgeSec) { return $script:health }

  # ★ 负缓存：失败也要记账。历史 bug 是「只在成功时写 healthAt」，于是后端一挂，
  #   每个 UI 定时器拍子都会重发 2~3 次探测，每次吃满 1 秒 → 窗口彻底不响应。
  #   连续 3 次超时视为「后端半死」，冷却拉到 15 秒，避免把 UI 线程耗在黑洞上。
  $cool = 4
  if ([int]$script:healthHardFail -ge 3) { $cool = 15 }
  if ($script:healthFailAt -ne [datetime]::MinValue -and
      ($now - $script:healthFailAt).TotalSeconds -lt $cool) { return $null }

  # ★ 端口前置：端口没开就不要发 HTTP。本机对「关闭的回环端口」发一次请求要等满 1 秒
  #   （SYN 被丢弃，约 2s 才失败），这一次 TCP 探测只要 120ms。
  if (-not (Test-PortOpen $Port 120)) {
    $script:health = $null
    $script:healthFailAt = $now
    return $null
  }

  try {
    $h = Invoke-UiApi 'GET' '/api/health' $null 1
    $script:health = $h
    $script:healthAt = $now
    $script:healthFailAt = [datetime]::MinValue
    $script:healthHardFail = 0
    return $h
  } catch {
    $script:health = $null
    $script:healthFailAt = $now
    $script:healthHardFail = [int]$script:healthHardFail + 1
    return $null
  }
}

function Get-ChannelsCached {
  param([int]$MaxAgeSec = 60)
  if ($script:channels -and ((Get-Date) - $script:channelsAt).TotalSeconds -lt $MaxAgeSec) { return $script:channels }
  try {
    $r = Invoke-UiApi 'GET' '/api/admin/channels' $null 2
    $script:channels = $r
    $script:channelsAt = Get-Date
    return $r
  } catch { return $null }
}

# ---------------- 版本 / 安装包 ----------------
$script:PluginVersion = '—'
try {
  $mfPath = Join-Path $ProjectRoot 'manifest.json'
  $mf = [System.IO.File]::ReadAllText($mfPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $script:PluginVersion = [string]$mf.version
} catch { }

function Get-LatestXpi {
  try {
    return (Get-ChildItem (Join-Path $ProjectRoot 'dist') -Filter '*.xpi' -ErrorAction Stop |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1)
  } catch { return $null }
}

# ---------------- 页面骨架 ----------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Papilot 后台 · 控制台'
$form.ClientSize = New-Object System.Drawing.Size(1000, 700)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Icon = $script:appIcon
$form.BackColor = $script:ColBg

# 左侧导航
$side = New-Object System.Windows.Forms.Panel
$side.SetBounds(0, 0, 196, 700)
$side.BackColor = $script:ColSide
[void]$form.Controls.Add($side)

$logo = New-Object System.Windows.Forms.PictureBox
$logo.SetBounds(18, 18, 30, 30)
$logo.SizeMode = 'Zoom'
try { $logo.Image = $script:appIcon.ToBitmap() } catch { }
[void]$side.Controls.Add($logo)
[void](New-UiLabel $side 'Papilot' 56 15 126 22 12 $true ([System.Drawing.Color]::White))
[void](New-UiLabel $side '后台控制台' 56 38 126 18 8.5 $false ([System.Drawing.Color]::FromArgb(148, 163, 184)))

$navDefs = @(
  @{ id = 'overview'; text = '总览' },
  @{ id = 'services'; text = '服务与通道' },
  @{ id = 'billing'; text = '计费与会员' },
  @{ id = 'ops'; text = '运维与告警' },
  @{ id = 'about'; text = '维护与关于' }
)
$navY = 84
foreach ($n in $navDefs) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $n.text
  $b.SetBounds(10, $navY, 176, 42)
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderSize = 0
  $b.FlatAppearance.MouseOverBackColor = $script:ColSideHi
  $b.TextAlign = 'MiddleLeft'
  $b.Padding = New-Object System.Windows.Forms.Padding(16, 0, 0, 0)
  $b.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
  $b.BackColor = $script:ColSide
  $b.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
  $b.Tag = $n.id
  $b.add_Click({ param($s, $e) Show-UiPage ([string]$s.Tag) })
  [void]$side.Controls.Add($b)
  $script:navButtons[$n.id] = $b
  $navY += 48
}

$script:ui.sideSrv = New-UiLabel $side '服务端 —' 18 606 162 18 8.5 $false ([System.Drawing.Color]::FromArgb(148, 163, 184))
$script:ui.sidePlug = New-UiLabel $side '插件 0.45.1' 18 626 162 18 8.5 $false ([System.Drawing.Color]::FromArgb(148, 163, 184))
[void](New-UiLabel $side '移动硬盘便携版' 18 652 162 16 8 $false ([System.Drawing.Color]::FromArgb(100, 116, 139)))

# 右侧内容区
$content = New-Object System.Windows.Forms.Panel
$content.SetBounds(196, 0, 804, 700)
$content.BackColor = $script:ColBg
[void]$form.Controls.Add($content)

$header = New-Object System.Windows.Forms.Panel
$header.SetBounds(0, 0, 804, 64)
$header.BackColor = $script:ColCard
[void]$content.Controls.Add($header)

$lblPageTitle = New-UiLabel $header '总览' 24 9 430 28 15 $true $script:ColText
$lblPageSub = New-UiLabel $header '' 24 38 470 18 8.5 $false $script:ColMuted

$script:ui.pillSvc = New-UiLabel $header '● 后台 检测中' 500 22 100 20 9 $false $script:ColMuted
$script:ui.pillTun = New-UiLabel $header '● 通道 检测中' 604 22 100 20 9 $false $script:ColMuted
$script:ui.pillLlm = New-UiLabel $header '● 模型 检测中' 704 22 90 20 9 $false $script:ColMuted

$body = New-Object System.Windows.Forms.Panel
$body.SetBounds(0, 64, 804, 596)
$body.BackColor = $script:ColBg
[void]$content.Controls.Add($body)

$footer = New-Object System.Windows.Forms.Panel
$footer.SetBounds(0, 660, 804, 40)
$footer.BackColor = $script:ColCard
[void]$content.Controls.Add($footer)

# 注意：$lblMsg 必须是脚本级普通变量 —— Show-StartResult 里直接读 $lblMsg
$lblMsg = New-UiLabel $footer '' 16 10 540 20 9 $false $script:ColMuted
$script:ui.lblRefresh = New-UiLabel $footer '尚未刷新' 600 10 188 20 8.5 $false $script:ColMuted
$script:ui.lblRefresh.TextAlign = 'MiddleRight'

function New-UiPage {
  param([string]$Id, [string]$Title, [string]$Sub)
  $p = New-Object System.Windows.Forms.Panel
  $p.SetBounds(0, 0, 804, 596)
  $p.BackColor = $script:ColBg
  $p.AutoScroll = $true
  $p.Visible = $false
  [void]$body.Controls.Add($p)
  $script:pages[$Id] = $p
  $script:pageMeta[$Id] = @{ Title = $Title; Sub = $Sub }
  return $p
}

# ============================================================
# 页面 1 · 总览
# ============================================================
$pgOverview = New-UiPage 'overview' '总览' '账号 · 公网通道 · 官方模型网关 —— 一眼看清四个关键状态'

$script:ui.svcCard = New-UiCard $pgOverview '账号后台 :8000' 16 14 184 96
$script:ui.tunCard = New-UiCard $pgOverview '公网通道' 212 14 184 96
$script:ui.llmCard = New-UiCard $pgOverview 'AI 模型通道' 408 14 184 96
$script:ui.billCard = New-UiCard $pgOverview '计费阀门' 604 14 184 96

$script:ui.statUsers = New-UiStat $pgOverview '用户数' 16 124 122
$script:ui.statOrders = New-UiStat $pgOverview '待核销订单' 146 124 122
$script:ui.statGaps = New-UiStat $pgOverview '未配价模型' 276 124 122
$script:ui.statDevices = New-UiStat $pgOverview '活跃设备' 406 124 122
$script:ui.statBacklog = New-UiStat $pgOverview '告警积压' 536 124 122
$script:ui.statSnapshots = New-UiStat $pgOverview '数据快照' 666 124 122

$gQuick = New-UiGroup $pgOverview '快捷操作' 16 202 772 92
$script:ui.btnStart = New-UiButton $gQuick '启动后台' 12 28 100 30 { Do-StartServer }
$script:ui.btnStop = New-UiButton $gQuick '停止后台' 120 28 100 30 { Do-StopServer $true }
$script:ui.btnRestart = New-UiButton $gQuick '重启后台' 228 28 100 30 { Do-RestartServer }
[void](New-UiButton $gQuick '打开管理页' 336 28 108 30 { Do-OpenAdmin })
[void](New-UiButton $gQuick '测试公网' 452 28 96 30 { Do-TestSite })
[void](New-UiButton $gQuick '刷新状态' 556 28 96 30 { $script:healthAt = [datetime]::MinValue; Update-All })
[void](New-UiButton $gQuick '计费与会员' 660 28 100 30 { Show-UiPage 'billing' })
[void](New-UiLabel $gQuick '停止/重启会中断正在进行的 AI 请求；关闭窗口 = 退出控制台（后台服务继续运行）。' 12 60 744 18 8 $false $script:ColMuted)

$gEvents = New-UiGroup $pgOverview '最近事件（控制台操作审计）' 16 306 772 274
$script:ui.evtList = New-Object System.Windows.Forms.ListView
$script:ui.evtList.View = 'Details'
$script:ui.evtList.FullRowSelect = $true
$script:ui.evtList.GridLines = $true
$script:ui.evtList.HeaderStyle = 'Nonclickable'
$script:ui.evtList.SetBounds(12, 24, 748, 238)
[void]$script:ui.evtList.Columns.Add('时间', 140)
[void]$script:ui.evtList.Columns.Add('动作', 130)
[void]$script:ui.evtList.Columns.Add('结果', 60)
[void]$script:ui.evtList.Columns.Add('详情', 400)
[void]$gEvents.Controls.Add($script:ui.evtList)
$script:ui.evtEmpty = New-UiLabel $gEvents '暂无控制台操作记录 —— 启动 / 停止 / 重启 / 快照 / 巡检后会出现在这里。' 24 120 720 24 9 $false $script:ColMuted
$script:ui.evtEmpty.TextAlign = 'MiddleCenter'

# ============================================================
# 页面 2 · 服务与通道
# ============================================================
$pgServices = New-UiPage 'services' '服务与通道' '启停账号后台 / 公网隧道 / AI 模型通道，并做依赖自检'

$gSvc = New-UiGroup $pgServices '账号后台（127.0.0.1:8000）' 16 12 772 150
$script:ui.svcLine = New-UiLabel $gSvc '检测中…' 14 24 744 24 10 $true $script:ColMuted
$script:ui.svcMeta = New-UiLabel $gSvc '' 14 50 744 18 8.5 $false $script:ColMuted
$script:ui.btnSvcStart = New-UiButton $gSvc '启动后台' 12 76 100 30 { Do-StartServer }
$script:ui.btnSvcStop = New-UiButton $gSvc '停止后台' 120 76 100 30 { Do-StopServer $true }
$script:ui.btnSvcRestart = New-UiButton $gSvc '重启后台' 228 76 100 30 { Do-RestartServer }
[void](New-UiButton $gSvc '服务日志' 336 76 96 30 { Do-OpenLog $ServerLog '服务日志' })
[void](New-UiButton $gSvc '标准输出' 440 76 96 30 { Do-OpenLog $script:StdoutLog '标准输出日志' })
[void](New-UiButton $gSvc '打开管理页' 544 76 108 30 { Do-OpenAdmin })
[void](New-UiButton $gSvc '数据目录' 660 76 100 30 { if (Test-Path $DataDir) { Invoke-Item $DataDir } else { $lblMsg.Text = '数据目录尚未创建' } })
[void](New-UiLabel $gSvc '服务日志 = Node 业务/审计日志；标准输出 = 进程 stdout/stderr（崩溃栈）。' 12 114 744 18 8 $false $script:ColMuted)

$gTun = New-UiGroup $pgServices '公网通道（pp.xinglintools.top → 127.0.0.1:8000）' 16 174 772 150
$script:ui.tunLine = New-UiLabel $gTun '检测中…' 14 24 744 24 10 $true $script:ColMuted
$script:ui.tunMeta = New-UiLabel $gTun '' 14 50 744 18 8.5 $false $script:ColMuted
[void](New-UiButton $gTun '启动通道' 12 76 100 30 { Do-StartTunnel })
[void](New-UiButton $gTun '停止通道' 120 76 100 30 { Do-StopTunnel $true })
[void](New-UiButton $gTun '测试访问' 228 76 100 30 { Do-TestSite })
[void](New-UiButton $gTun '通道日志' 336 76 96 30 { Do-OpenLog $TunnelLog '通道日志' })
[void](New-UiButton $gTun '刷新状态' 440 76 96 30 { $script:tunTick = 0; Update-All })
[void](New-UiLabel $gTun '依赖：cloudflared.exe / token.txt / 运行器均在 runtime\cloudflared（换盘丢失令牌 → refresh-token.ps1）。' 12 114 744 18 8 $false $script:ColMuted)

$gLlm = New-UiGroup $pgServices 'AI 模型通道（官方网关上游）' 16 336 772 150
$script:ui.llmLine = New-UiLabel $gLlm '检测中…' 14 24 744 24 10 $true $script:ColMuted
$script:ui.llmMeta = New-UiLabel $gLlm '' 14 50 744 18 8.5 $false $script:ColMuted
[void](New-UiButton $gLlm '通道管理' 12 76 120 30 { Show-ChannelManager })
[void](New-UiButton $gLlm '打开管理页' 140 76 120 30 { Do-OpenAdmin })
[void](New-UiButton $gLlm '刷新通道' 268 76 100 30 { $script:channelsAt = [datetime]::MinValue; $script:healthAt = [datetime]::MinValue; Update-All })
[void](New-UiLabel $gLlm '上线模型 = 插件可见范围；高级模型 = 仅专业版；auto 恒可用且按基础档计费。' 12 114 744 18 8 $false $script:ColMuted)

[void](New-UiLabel $pgServices '端口：账号后台 8000 · 隧道指标 20250｜站点：https://pp.xinglintools.top｜数据：server\data（users / channels / membership / pricing / 日志）' 16 494 772 40 8 $false $script:ColMuted)

# ============================================================
# 页面 3 · 计费与会员（服务端 1.8.0 口径）
# ============================================================
$pgBilling = New-UiPage 'billing' '计费与会员' '1.8.0 起按余额计费；1.8.3 免签网关多付尾差窗口（支付订单展示见插件 0.49.0）'

$gBill = New-UiGroup $pgBilling '计费口径（服务端 1.8.0）' 16 12 772 150
$script:ui.billEnforce = New-UiLabel $gBill '余额拦截：检测中…' 14 24 744 20 9 $true $script:ColMuted
$script:ui.billGrant = New-UiLabel $gBill '注册赠送：检测中…' 14 48 744 20 9 $false $script:ColText
$script:ui.billPro = New-UiLabel $gBill '专业版月度额度：检测中…' 14 72 744 20 9 $false $script:ColText
$script:ui.billPay = New-UiLabel $gBill '在线支付：检测中…' 14 96 744 20 9 $false $script:ColText
[void](New-UiLabel $gBill '扣减顺序：注册赠送 → 订阅额度 → 充值；高级模型跳过注册赠送；余额为 0 也会被拦（402）。' 14 120 744 20 8 $false $script:ColMuted)

$gPlans = New-UiGroup $pgBilling '套餐与价格（/api/plans）' 16 174 772 190
$script:ui.planList = New-Object System.Windows.Forms.ListView
$script:ui.planList.View = 'Details'
$script:ui.planList.FullRowSelect = $true
$script:ui.planList.GridLines = $true
$script:ui.planList.HeaderStyle = 'Nonclickable'
$script:ui.planList.SetBounds(12, 24, 748, 120)
[void]$script:ui.planList.Columns.Add('等级', 90)
[void]$script:ui.planList.Columns.Add('每月额度', 130)
$script:ui.planList.Columns.Add('高级模型', 90) | Out-Null
[void]$script:ui.planList.Columns.Add('价格档位', 420)
[void]$gPlans.Controls.Add($script:ui.planList)
[void](New-UiButton $gPlans '会员管理（订单/激活码/价格/套餐）' 12 152 300 28 { Show-MembershipManager })
[void](New-UiButton $gPlans '用户列表（余额/设备/密码）' 320 152 240 28 { Show-UserList })
[void](New-UiButton $gPlans '打开网页管理页' 568 152 180 28 { Do-OpenAdmin })

$gBillHealth = New-UiGroup $pgBilling '计费数据健康' 16 376 772 120
$script:ui.billPriced = New-UiLabel $gBillHealth '已配价模型：—' 14 26 360 20 9 $false $script:ColText
$script:ui.billGaps = New-UiLabel $gBillHealth '未配价模型：—' 14 52 360 20 9 $false $script:ColText
$script:ui.billRecharge = New-UiLabel $gBillHealth '充值档位：—' 14 78 360 20 9 $false $script:ColText
$script:ui.billCost = New-UiLabel $gBillHealth '成本看板：后台 → 会员管理 → 成本与用量（按模型 / 按天 / Top 消耗）' 390 26 370 60 9 $false $script:ColMuted
[void](New-UiButton $gBillHealth '刷新计费数据' 390 84 130 26 { $script:healthAt = [datetime]::MinValue; $script:plansAt = [datetime]::MinValue; Update-BillingUI $true })

[void](New-UiLabel $pgBilling '说明：1.8.0 起没有「每日调用次数」；套餐页只配「每月额度（¥）」与高级模型开关。auto 恒可用，且按基础档计费（不会被通道默认模型误判为高级档）。' 16 506 772 40 8 $false $script:ColMuted)

# ---- 在线支付网关（1.8.3：免签网关加价容差 + 连接自检）----
# 数据源：GET /api/admin/payment（本机管理接口，含实际生效的容差值）；
# 深度测试 = 按真实参数向网关创建一笔 0.01 元未支付测试单（需显式确认）。
$gPayGw = New-UiGroup $pgBilling '在线支付网关（服务端 1.8.3 · 免签网关适配）' 16 556 772 176
$script:ui.pgwState = New-UiLabel $gPayGw '网关状态：检测中…' 14 24 744 22 9.5 $true $script:ColMuted
$script:ui.pgwMeta = New-UiLabel $gPayGw '' 14 50 744 20 8.5 $false $script:ColText
$script:ui.pgwOverpay = New-UiLabel $gPayGw '' 14 74 744 20 8.5 $false $script:ColText
[void](New-UiLabel $gPayGw '免签网关（个人收款码）靠「唯一金额」区分并发同额订单：第 2、3…笔会被网关 +1 分递增加价，回调金额校验因此放开多付尾差窗口；少付仍一律拒绝、到账仍按本地订单额度。' 14 98 744 34 8 $false $script:ColMuted)
[void](New-UiButton $gPayGw '连接测试' 14 136 96 28 { Do-TestPayGateway $false })
[void](New-UiButton $gPayGw '深度测试（0.01 元）' 118 136 136 28 { Do-TestPayGateway $true })
[void](New-UiButton $gPayGw '网关配置（管理页）' 262 136 156 28 { Do-OpenAdmin })
$script:ui.pgwMsg = New-UiLabel $gPayGw '' 426 140 332 20 8.5 $false $script:ColMuted

# ============================================================
# 页面 4 · 运维与告警
# ============================================================
$pgOps = New-UiPage 'ops' '运维与告警' '积压 / 计量缺口 / 快照 / 管理审计 —— 出问题时先看这一页'

$gAlert = New-UiGroup $pgOps '订单积压与告警' 16 12 772 128
$script:ui.alertBacklog = New-UiLabel $gAlert '积压：检测中…' 14 24 560 22 10 $true $script:ColMuted
$script:ui.alertOldest = New-UiLabel $gAlert '' 14 50 560 20 8.5 $false $script:ColMuted
$script:ui.alertMail = New-UiLabel $gAlert '' 14 74 560 36 8.5 $false $script:ColMuted
[void](New-UiButton $gAlert '立即巡检' 596 24 160 30 { Do-AlertCheck })
[void](New-UiButton $gAlert '告警日志' 596 62 160 28 { Do-OpenLog (Join-Path $DataDir 'alerts.log') '告警日志' })

$gHealth = New-UiGroup $pgOps '数据健康' 16 152 772 146
$script:ui.healthGaps = New-UiLabel $gHealth '未配价模型：—' 14 26 360 20 9 $false $script:ColText
$script:ui.healthPriced = New-UiLabel $gHealth '已配价模型：—' 14 52 360 20 9 $false $script:ColText
$script:ui.healthDevices = New-UiLabel $gHealth '活跃设备：—' 14 78 360 20 9 $false $script:ColText
$script:ui.healthAudit = New-UiLabel $gHealth '审计体积：—' 14 104 360 20 9 $false $script:ColText
$script:ui.healthSnap = New-UiLabel $gHealth '快照：—' 390 26 370 20 9 $false $script:ColText
$script:ui.healthMailSvc = New-UiLabel $gHealth '邮件服务：—' 390 52 370 20 9 $false $script:ColText
$script:ui.healthBacklogMini = New-UiLabel $gHealth '积压超时：—' 390 78 370 20 9 $false $script:ColText
[void](New-UiLabel $gHealth '「未配价模型」> 0 表示有调用按兜底价记账；「缺 usage」> 0 表示上游没回 token，成本未知。' 14 116 744 18 8 $false $script:ColMuted)

$gSnap = New-UiGroup $pgOps '数据快照' 16 310 772 96
$script:ui.snapLine = New-UiLabel $gSnap '最近快照：—' 14 24 480 20 9 $false $script:ColText
[void](New-UiButton $gSnap '立即快照' 14 50 120 30 { Do-Snapshot })
[void](New-UiButton $gSnap '备份目录' 144 50 110 30 { $p = Join-Path $DataDir 'backup'; if (Test-Path $p) { Invoke-Item $p } else { $lblMsg.Text = '备份目录尚未创建' } })
[void](New-UiLabel $gSnap '改配置 / 回滚前先打一份；回滚仍在网页管理页（需二次确认）。' 270 54 494 20 8 $false $script:ColMuted)

$gAudit = New-UiGroup $pgOps '最近管理审计（服务端 /api/admin/audit）' 16 418 772 160
$script:ui.auditList = New-Object System.Windows.Forms.ListView
$script:ui.auditList.View = 'Details'
$script:ui.auditList.FullRowSelect = $true
$script:ui.auditList.GridLines = $true
$script:ui.auditList.HeaderStyle = 'Nonclickable'
$script:ui.auditList.SetBounds(12, 24, 748, 96)
[void]$script:ui.auditList.Columns.Add('时间', 130)
[void]$script:ui.auditList.Columns.Add('动作', 140)
[void]$script:ui.auditList.Columns.Add('对象', 220)
[void]$script:ui.auditList.Columns.Add('结果', 60)
[void]$gAudit.Controls.Add($script:ui.auditList)
[void](New-UiButton $gAudit '打开审计文件' 610 126 150 26 { Do-OpenLog (Join-Path $DataDir 'audit.log') '管理审计' })

# ============================================================
# 页面 5 · 维护与关于
# ============================================================
$pgAbout = New-UiPage 'about' '维护与关于' '自启、目录、运行环境与版本 —— 换盘迁移时看这一页'

$gMaint = New-UiGroup $pgAbout '维护' 16 12 772 128
$script:ui.btnStartup = New-UiButton $gMaint '开机自启：…' 14 26 170 30 {
  $new = -not (Get-StartupEnabled)
  Set-Startup $new
  $script:ui.btnStartup.Text = '开机自启：' + $(if ($new) { '开' } else { '关' })
  Write-LauncherAudit 'startup-toggle' ($(if ($new) { 'on' } else { 'off' })) $true
  [System.Windows.Forms.MessageBox]::Show($(if ($new) { '已开启：重启电脑后账号后台与公网通道将自动启动' } else { '已关闭' }), '开机自启', 'OK', 'Information') | Out-Null
}
[void](New-UiButton $gMaint '数据目录' 196 26 110 30 { if (Test-Path $DataDir) { Invoke-Item $DataDir } else { $lblMsg.Text = '数据目录尚未创建' } })
[void](New-UiButton $gMaint '项目目录' 316 26 110 30 { Invoke-Item $ProjectRoot })
[void](New-UiButton $gMaint '安装包（dist）' 436 26 130 30 {
  $xpi = Get-LatestXpi
  if ($xpi) {
    $r = [System.Windows.Forms.MessageBox]::Show('最新安装包：' + $xpi.Name + "`n`n在 Zotero 中安装：工具 → 附加组件 → 齿轮 → Install Add-on From File…`n是否现在打开所在文件夹？", '插件安装包', 'YesNo', 'Information')
    if ($r -eq 'Yes') { Invoke-Item $xpi.DirectoryName }
  } else { $lblMsg.Text = 'dist 目录下暂无 .xpi 安装包' }
})
[void](New-UiButton $gMaint '打开网页管理页' 576 26 170 30 { Do-OpenAdmin })
$script:ui.chkAutoBoot = New-Object System.Windows.Forms.CheckBox
$script:ui.chkAutoBoot.Text = '启动控制台时自动拉起账号后台与公网通道（默认开）'
$script:ui.chkAutoBoot.SetBounds(14, 68, 420, 22)
$script:ui.chkAutoBoot.Checked = Get-AutoBootServices
$script:ui.chkAutoBoot.add_Click({
  Set-AutoBootServices $script:ui.chkAutoBoot.Checked
  Write-LauncherAudit 'auto-boot-toggle' ($(if ($script:ui.chkAutoBoot.Checked) { 'on' } else { 'off' })) $true
  $lblMsg.Text = '已' + $(if ($script:ui.chkAutoBoot.Checked) { '开启' } else { '关闭' }) + '：控制台启动时自动拉起后台与通道（下次启动生效）'
})
[void]$gMaint.Controls.Add($script:ui.chkAutoBoot)
[void](New-UiLabel $gMaint '关闭窗口 = 最小化到托盘驻留；「退出程序」才会结束控制台（不影响已启动的服务与通道）。' 14 96 744 22 8 $false $script:ColMuted)

$gEnv = New-UiGroup $pgAbout '运行环境（换盘自检）' 16 152 772 146
$script:ui.envNode = New-UiLabel $gEnv 'Node：—' 14 26 744 20 9 $false $script:ColText
$script:ui.envCf = New-UiLabel $gEnv 'cloudflared：—' 14 52 744 20 9 $false $script:ColText
$script:ui.envToken = New-UiLabel $gEnv '隧道令牌：—' 14 78 744 20 9 $false $script:ColText
$script:ui.envRuntime = New-UiLabel $gEnv '运行时目录：—' 14 104 744 20 9 $false $script:ColText
[void](New-UiLabel $gEnv '以上依赖全部在项目内（runtime\node、runtime\cloudflared），换电脑/换盘符无需安装。' 14 120 744 16 7.5 $false $script:ColMuted)

$gVer = New-UiGroup $pgAbout '版本' 16 310 772 120
$script:ui.verServer = New-UiLabel $gVer '服务端：—' 14 26 360 20 9 $false $script:ColText
$script:ui.verPlugin = New-UiLabel $gVer '插件（manifest）：—' 14 52 360 20 9 $false $script:ColText
$script:ui.verXpi = New-UiLabel $gVer '最新安装包：—' 14 78 360 20 9 $false $script:ColText
$script:ui.verSite = New-UiLabel $gVer '站点：https://pp.xinglintools.top' 390 26 370 20 9 $false $script:ColMuted
[void](New-UiButton $gVer '刷新版本信息' 390 70 140 28 { $script:healthAt = [datetime]::MinValue; Update-AboutUI })

[void](New-UiLabel $pgAbout '运维缺口（后续迭代，见设计文档 §5）：批量用户操作、控制台口令、一键诊断包、版本更新检查、守护自愈、成本阈值告警。' 16 444 772 36 8 $false $script:ColMuted)

# ============================================================
# 导航 / 页面切换
# ============================================================
function Show-UiPage {
  param([string]$Id)
  if (-not $script:pages.Contains($Id)) { return }
  $script:activePage = $Id
  foreach ($k in $script:pages.Keys) { $script:pages[$k].Visible = ($k -eq $Id) }
  foreach ($k in $script:navButtons.Keys) {
    $b = $script:navButtons[$k]
    if ($k -eq $Id) {
      $b.BackColor = $script:ColAccent
      $b.ForeColor = [System.Drawing.Color]::White
    } else {
      $b.BackColor = $script:ColSide
      $b.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
    }
  }
  $meta = $script:pageMeta[$Id]
  $lblPageTitle.Text = $meta.Title
  $lblPageSub.Text = $meta.Sub
  if ($Id -eq 'billing') { Update-BillingUI $true }
  elseif ($Id -eq 'ops') { Update-OpsUI $true }
  elseif ($Id -eq 'about') { Update-AboutUI }
  elseif ($Id -eq 'services') { Update-ChannelUI $true }
}

# ============================================================
# 状态刷新
# ============================================================
function Format-Uptime([datetime]$Started) {
  $span = (Get-Date) - $Started
  if ($span.TotalHours -ge 1) { return ('{0}小时{1}分' -f [int]$span.TotalHours, $span.Minutes) }
  if ($span.TotalMinutes -ge 1) { return ('{0}分{1}秒' -f $span.Minutes, $span.Seconds) }
  return ('{0}秒' -f [int]$span.TotalSeconds)
}

function Notify-Transition {
  param([string]$Text, [string]$Level = 'Warning')
  if (-not $tray.Visible) { return }
  try { $tray.ShowBalloonTip(3000, 'Papilot 后台', $Text, $Level) } catch { }
}

function Update-StatusUI {
  $h = Get-HealthCached 8
  $st = Get-ServerState ($null -ne $h)
  # 服务端在 /api/health 里回 pid：直接用它，省掉一次 netstat；顺便把缓存喂给其它调用方
  if ($h -and $h.pid) {
    $hp = 0
    if ([int]::TryParse([string]$h.pid, [ref]$hp) -and $hp -gt 0) {
      $script:portPidCache = $hp
      $st.PortPid = $hp
    }
  }
  $script:svcState = $st.State
  $ver = '—'
  if ($h -and $h.version) { $ver = [string]$h.version }
  # 事件循环延迟（服务端自报）：>500ms 说明后端被同步 IO 堵住，正是"端口在听但不干活的"前兆
  $lagMs = 0
  $lagTxt = ''
  if ($h -and $null -ne $h.lagMs) {
    try { $lagMs = [int]$h.lagMs } catch { $lagMs = 0 }
    if ($lagMs -ge 200) { $lagTxt = ' · 事件循环延迟 ' + $lagMs + 'ms' }
  }

  if ($st.State -eq 'running') {
    $up = ''
    $started = Get-ProcessStart $st.PortPid
    if ($started) { $up = ' · 已运行 ' + (Format-Uptime $started) }
    if ($lagMs -ge 1000) {
      Set-UiCard $script:ui.svcCard '运行中（卡顿）' ('事件循环延迟 ' + $lagMs + 'ms' + $up) $script:ColAmber
      $script:ui.pillSvc.Text = '● 后台 卡顿'
      $script:ui.pillSvc.ForeColor = $script:ColAmber
    } else {
      Set-UiCard $script:ui.svcCard '运行中' ('PID ' + $st.PortPid + $up) $script:ColGreen
      $script:ui.pillSvc.Text = '● 后台 运行中'
      $script:ui.pillSvc.ForeColor = $script:ColGreen
    }
    $script:ui.svcLine.Text = '● 运行中'
    $script:ui.svcLine.ForeColor = $script:ColGreen
    $script:ui.svcMeta.Text = 'PID ' + $st.PortPid + $up + ' · 服务端 v' + $ver + $lagTxt
    $script:ui.btnSvcStart.Enabled = $false
    $script:ui.btnSvcStop.Enabled = $true
    $script:ui.btnSvcRestart.Enabled = $true
    $script:ui.btnStart.Enabled = $false
    $script:ui.btnStop.Enabled = $true
    $script:ui.btnRestart.Enabled = $true
    $script:timeoutNotified = $false
  } elseif ($st.State -eq 'degraded') {
    Set-UiCard $script:ui.svcCard '服务异常' '端口在听但健康检查不过（建议重启）' $script:ColOrange
    $script:ui.svcLine.Text = '● 服务异常：端口在听但 /api/health 不过'
    $script:ui.svcLine.ForeColor = $script:ColOrange
    $script:ui.svcMeta.Text = 'PID ' + $st.PortPid + ' · 可能是依赖或数据文件异常'
    $script:ui.pillSvc.Text = '● 后台 异常'
    $script:ui.pillSvc.ForeColor = $script:ColOrange
    $script:ui.btnSvcStart.Enabled = $false
    $script:ui.btnSvcStop.Enabled = $true
    $script:ui.btnSvcRestart.Enabled = $true
    $script:ui.btnStart.Enabled = $false
    $script:ui.btnStop.Enabled = $true
    $script:ui.btnRestart.Enabled = $true
  } elseif ($st.State -eq 'starting') {
    Set-UiCard $script:ui.svcCard '启动中' '等待端口 ' + $Port + ' 就绪…' $script:ColAmber
    $script:ui.svcLine.Text = '● 启动中：等待端口 ' + $Port + ' 就绪…'
    $script:ui.svcLine.ForeColor = $script:ColAmber
    $script:ui.svcMeta.Text = '冷启动（移动硬盘 + 杀软扫描）可能需要 10~30 秒'
    $script:ui.pillSvc.Text = '● 后台 启动中'
    $script:ui.pillSvc.ForeColor = $script:ColAmber
    $script:ui.btnSvcStart.Enabled = $false
    $script:ui.btnSvcStop.Enabled = $true
    $script:ui.btnSvcRestart.Enabled = $true
    $script:ui.btnStart.Enabled = $false
    $script:ui.btnStop.Enabled = $true
    $script:ui.btnRestart.Enabled = $true
    if ($script:pendingSince -and ((Get-Date) - $script:pendingSince).TotalSeconds -gt 40 -and -not $script:timeoutNotified) {
      $script:timeoutNotified = $true
      $lblMsg.Text = '启动耗时较长：请查 server\data\server-console.log 与 server-stdout.log'
    }
  } else {
    Set-UiCard $script:ui.svcCard '未运行' '插件将无法登录 / 使用官方 AI' $script:ColRed
    $script:ui.svcLine.Text = '● 未运行'
    $script:ui.svcLine.ForeColor = $script:ColRed
    $script:ui.svcMeta.Text = '端口 ' + $Port + ' 无 node 监听'
    $script:ui.pillSvc.Text = '● 后台 未运行'
    $script:ui.pillSvc.ForeColor = $script:ColRed
    $script:ui.btnSvcStart.Enabled = $true
    $script:ui.btnSvcStop.Enabled = $false
    $script:ui.btnSvcRestart.Enabled = $false
    $script:ui.btnStart.Enabled = $true
    $script:ui.btnStop.Enabled = $false
    $script:ui.btnRestart.Enabled = $false
  }

  if ($script:lastSvcState -and $script:lastSvcState -ne $st.State) {
    if ($st.State -eq 'stopped') { Notify-Transition '账号后台已停止：插件将无法登录 / 使用官方 AI' 'Warning' }
    elseif ($st.State -eq 'degraded') { Notify-Transition '账号后台异常：端口在听但健康检查不过，建议重启' 'Warning' }
    elseif ($st.State -eq 'running' -and $script:lastSvcState -ne 'starting') { Notify-Transition '账号后台已恢复运行' 'Info' }
  }
  $script:lastSvcState = $st.State
  if ($h) { $script:ui.sideSrv.Text = '服务端 ' + $ver } else { $script:ui.sideSrv.Text = '服务端 未连接' }
  $stateTxt = '未运行'
  if ($st.State -eq 'running') { $stateTxt = '运行中' }
  elseif ($st.State -eq 'starting') { $stateTxt = '启动中' }
  elseif ($st.State -eq 'degraded') { $stateTxt = '异常' }
  try { $tray.Text = 'Papilot 后台 · ' + $stateTxt } catch { }
  Invoke-ServiceWatchdog $st.State
}

# ---------------- 自愈看门狗（v1.9.0） ----------------
# 后端「无声消失」是这个项目的历史顽疾：没有守护计划任务，崩溃只丢 stderr，控制台只剩一个红点。
# 控制台本来就是最常驻的进程，让它兼任看门狗：
#   · 连续 3 拍（约 9s）确认服务不在 → 自动拉起
#   · 2 分钟内不重复；每小时最多 5 次，超过就停手并提示人工介入（避免起不来时疯狂重启）
#   · 用户点了「停止」（stopped-account.flag）或关了开机自启 → 一律不插手
#   · 同时尊重 $script:busy：用户正在手动启停时绝不并发操作
$script:svcFailStreak = 0
$script:lastAutoRestartAt = [datetime]::MinValue
$script:autoRestartCount = 0
$script:autoRestartHourAt = [datetime]::MinValue
$script:watchdogGaveUp = $false

function Invoke-ServiceWatchdog([string]$State) {
  if ($script:watchdogGaveUp) { return }
  if ($script:busy) { return }
  if ($State -eq 'running' -or $State -eq 'starting') { $script:svcFailStreak = 0; return }
  if (-not (Get-AutoBootServices)) { return }
  try { if (Test-Path (Join-Path $DataDir 'stopped-account.flag')) { return } } catch { return }

  $script:svcFailStreak = [int]$script:svcFailStreak + 1
  if ($script:svcFailStreak -lt 3) { return }

  $now = Get-Date
  if ($script:lastAutoRestartAt -ne [datetime]::MinValue -and
      ($now - $script:lastAutoRestartAt).TotalSeconds -lt 120) { return }
  if ($script:autoRestartHourAt -eq [datetime]::MinValue -or
      ($now - $script:autoRestartHourAt).TotalHours -ge 1) {
    $script:autoRestartHourAt = $now
    $script:autoRestartCount = 0
  }
  if ([int]$script:autoRestartCount -ge 5) {
    $script:watchdogGaveUp = $true
    $lblMsg.Text = '后台反复启动失败，已停止自动拉起：请查 server\data\server-console.log'
    Write-LauncherAudit 'watchdog-giveup' ('count=' + $script:autoRestartCount) $false
    Write-Boot 'watchdog: give up after 5 restarts in one hour'
    return
  }

  $script:svcFailStreak = 0
  $r = Start-Server
  # 'starting' = 端口没开但还有 node 残留（上一次退出的余波）。这不是一次真正的重启尝试，
  # 不能吃掉 2 分钟退避，否则明明立刻能起也会白等两分钟。
  if ($r -eq 'starting') {
    if ([int]$script:autoRestartCount -gt 0) { $script:autoRestartCount = [int]$script:autoRestartCount - 1 }
    Write-Boot 'watchdog: pending server process found, wait next window'
    return
  }
  $script:lastAutoRestartAt = $now
  $script:autoRestartCount = [int]$script:autoRestartCount + 1
  $ok = -not ([string]$r).StartsWith('error:')
  Write-LauncherAudit 'watchdog-restart' ([string]$r) $ok
  Write-Boot ('watchdog: auto restart -> ' + $r)
  if ($r -eq 'started') {
    $lblMsg.Text = '检测到后台已停止，看门狗已自动拉起（约 10~30 秒就绪）…'
    $script:pendingSince = Get-Date
    $script:timeoutNotified = $false
    Notify-Transition '账号后台已停止，控制台已自动重新拉起' 'Warning'
  } else {
    $lblMsg.Text = '看门狗拉起失败：' + [string]$r
  }
  # 让下一拍立即重新探测（否则负缓存会把它压住，看起来像没生效）
  $script:health = $null
  $script:healthAt = [datetime]::MinValue
  $script:healthFailAt = [datetime]::MinValue
  $script:healthHardFail = 0
  Clear-PortPidCache
  $script:srvProcAt = [datetime]::MinValue
}

function Update-TunnelUI {
  $script:tunTick = [int]$script:tunTick + 1
  # 3 拍（约 9 秒）探一次 /ready，400ms 硬超时；进程列表缓存 10 秒
  if (($script:tunTick % 3) -eq 1) { $script:tunReady = Test-TunnelReady }
  $proc = Get-TunnelProcessCached 30
  $script:tunProcCount = $proc.Count
  if ($script:tunReady) {
    Set-UiCard $script:ui.tunCard '已连接' $SiteUrl $script:ColGreen
    $script:ui.tunLine.Text = '● 已连接边缘：' + $SiteUrl
    $script:ui.tunLine.ForeColor = $script:ColGreen
    $script:ui.tunMeta.Text = 'readyConnections > 0 · 进程 ' + $proc.Count + ' 个'
    $script:ui.pillTun.Text = '● 通道 正常'
    $script:ui.pillTun.ForeColor = $script:ColGreen
    $script:lastTunState = 'ready'
  } elseif ($proc.Count -gt 0) {
    Set-UiCard $script:ui.tunCard '未连边' '进程在，尚未连接边缘（稍候/重启）' $script:ColOrange
    $script:ui.tunLine.Text = '● 进程在，尚未连接边缘（久不绿可重启通道）'
    $script:ui.tunLine.ForeColor = $script:ColOrange
    $script:ui.tunMeta.Text = '进程 ' + $proc.Count + ' 个 · 指标端口 ' + $TunnelMetricsPort
    $script:ui.pillTun.Text = '● 通道 未连边'
    $script:ui.pillTun.ForeColor = $script:ColOrange
    if ($script:lastTunState -eq 'ready') { Notify-Transition '公网通道已断开边缘连接（公网将不可达）' 'Warning' }
    $script:lastTunState = 'pending'
  } else {
    Set-UiCard $script:ui.tunCard '未运行' '插件将无法连接账号服务器' $script:ColRed
    $script:ui.tunLine.Text = '● 未运行（公网入口不可达）'
    $script:ui.tunLine.ForeColor = $script:ColRed
    $script:ui.tunMeta.Text = '无 cloudflared 进程（指标端口 ' + $TunnelMetricsPort + '）'
    $script:ui.pillTun.Text = '● 通道 未运行'
    $script:ui.pillTun.ForeColor = $script:ColRed
    if ($script:lastTunState -eq 'ready') { Notify-Transition '公网通道已停止：插件将无法连接账号服务器' 'Warning' }
    $script:lastTunState = 'stopped'
  }
}

function Update-ChannelUI {
  param([bool]$Force = $false)
  $h = Get-HealthCached 10
  if (-not $h) {
    Set-UiCard $script:ui.llmCard '后台未连接' '启动后查看活动通道' $script:ColMuted
    $script:ui.llmLine.Text = '后台未连接'
    $script:ui.llmLine.ForeColor = $script:ColMuted
    $script:ui.llmMeta.Text = ''
    $script:ui.pillLlm.Text = '● 模型 —'
    $script:ui.pillLlm.ForeColor = $script:ColMuted
    return
  }
  $n = [int]$h.channels
  $published = 0
  $high = 0
  try { $published = [int]$h.publishedModels } catch { }
  try { $high = [int]$h.highTierModels } catch { }
  if ($n -le 0) {
    Set-UiCard $script:ui.llmCard '暂无通道' '官方调用将返回 503' $script:ColOrange
    $script:ui.llmLine.Text = '● 暂无通道：请在「通道管理」新增上游'
    $script:ui.llmLine.ForeColor = $script:ColOrange
    $script:ui.llmMeta.Text = '上线模型 ' + $published + ' · 高级模型 ' + $high
    $script:ui.pillLlm.Text = '● 模型 无通道'
    $script:ui.pillLlm.ForeColor = $script:ColOrange
    return
  }
  $ch = $null
  if ($Force) { $script:channelsAt = [datetime]::MinValue }
  $ch = Get-ChannelsCached 60
  $name = [string]$h.active
  $model = '—'
  if ($ch) {
    foreach ($c in @($ch.channels)) { if ($c.id -eq $ch.active) { $name = [string]$c.name; $model = [string]$c.model; break } }
  }
  if (-not $h.active) {
    Set-UiCard $script:ui.llmCard '未设活动通道' '官方调用将返回 503' $script:ColOrange
    $script:ui.llmLine.Text = '● 未设置活动通道（共 ' + $n + ' 个）'
    $script:ui.llmLine.ForeColor = $script:ColOrange
    $script:ui.llmMeta.Text = '上线模型 ' + $published + ' · 高级模型 ' + $high
    $script:ui.pillLlm.Text = '● 模型 未启用'
    $script:ui.pillLlm.ForeColor = $script:ColOrange
    return
  }
  Set-UiCard $script:ui.llmCard '已就绪' ($name + '（' + $model + '）') $script:ColGreen
  $script:ui.llmLine.Text = '● 活动通道：' + $name + '（' + $model + '）'
  $script:ui.llmLine.ForeColor = $script:ColGreen
  $script:ui.llmMeta.Text = '共 ' + $n + ' 个通道 · 上线模型 ' + $published + ' · 高级模型 ' + $high
  $script:ui.pillLlm.Text = '● 模型 就绪'
  $script:ui.pillLlm.ForeColor = $script:ColGreen
}

function Update-OverviewUI {
  $h = $script:health
  if ($h) {
    Set-UiStat $script:ui.statUsers ([string]$h.users) $script:ColText
    Set-UiStat $script:ui.statOrders ([string]$h.ordersAwaitingReview) $(if ([int]$h.ordersAwaitingReview -gt 0) { $script:ColOrange } else { $script:ColText })
    Set-UiStat $script:ui.statGaps ([string]$h.meteringGaps) $(if ([int]$h.meteringGaps -gt 0) { $script:ColOrange } else { $script:ColText })
    Set-UiStat $script:ui.statDevices ([string]$h.sessionsActive) $(if ($h.devicesOverLimit) { $script:ColOrange } else { $script:ColText })
    Set-UiStat $script:ui.statBacklog ([string]$h.backlogCount) $(if ($h.backlogOverdue) { $script:ColRed } elseif ([int]$h.backlogCount -gt 0) { $script:ColAmber } else { $script:ColText })
    Set-UiStat $script:ui.statSnapshots ([string]$h.snapshots) $script:ColText

    if ($h.balanceEnforce) {
      Set-UiCard $script:ui.billCard '余额拦截 开' '注册 ¥6 · Pro ¥20/月' $script:ColGreen
    } else {
      Set-UiCard $script:ui.billCard '余额拦截 关' '等于不限量（仅压测）' $script:ColOrange
    }
    if ($h.backlogOverdue -and -not $script:lastBacklogOverdue) {
      Notify-Transition ('订单积压超时：' + $h.backlogCount + ' 单待核销') 'Warning'
    }
    $script:lastBacklogOverdue = [bool]$h.backlogOverdue
  } else {
    foreach ($s in @($script:ui.statUsers, $script:ui.statOrders, $script:ui.statGaps, $script:ui.statDevices, $script:ui.statBacklog, $script:ui.statSnapshots)) {
      Set-UiStat $s '—' $script:ColMuted
    }
    Set-UiCard $script:ui.billCard '后台未连接' '启动后查看计费阀门' $script:ColMuted
  }
}

function MicroText([object]$Micro) {
  $n = 0.0
  try { $n = [double]$Micro } catch { $n = 0 }
  $y = $n / 1000000
  if ($y -ge 1) { return ('¥{0:0.00}' -f $y) }
  if ($y -gt 0) { return ('¥' + ([string]([math]::Round($y, 4))).TrimEnd('0').TrimEnd('.')) }
  return '¥0'
}

function Update-BillingUI {
  param([bool]$Force = $false)
  $h = Get-HealthCached 10
  if (-not $h) {
    $script:ui.billEnforce.Text = '余额拦截：后台未连接'
    $script:ui.billEnforce.ForeColor = $script:ColMuted
    $script:ui.billGrant.Text = '注册赠送：—'
    $script:ui.billPro.Text = '专业版月度额度：—'
    $script:ui.billPay.Text = '在线支付：—'
    $script:ui.planList.Items.Clear()
    $script:ui.billPriced.Text = '已配价模型：—'
    $script:ui.billGaps.Text = '未配价模型：—'
    $script:ui.billRecharge.Text = '充值档位：—'
    if ($script:ui.pgwState) {
      $script:ui.pgwState.Text = '网关状态：后台未连接'
      $script:ui.pgwState.ForeColor = $script:ColMuted
      $script:ui.pgwMeta.Text = ''
      $script:ui.pgwOverpay.Text = ''
    }
    return
  }
  if ($Force -or -not $script:plans -or ((Get-Date) - $script:plansAt).TotalSeconds -gt 60) {
    try {
      $script:plans = Invoke-UiApi 'GET' '/api/plans' $null 2
      $script:plansAt = Get-Date
    } catch { }
  }
  $p = $script:plans

  if ($h.balanceEnforce) {
    $script:ui.billEnforce.Text = '余额拦截：开启（余额不足 → 402，余额为 0 也拦）'
    $script:ui.billEnforce.ForeColor = $script:ColGreen
  } else {
    $script:ui.billEnforce.Text = '余额拦截：关闭 —— 取消次数上限后等于不限量，仅压测用'
    $script:ui.billEnforce.ForeColor = $script:ColOrange
  }
  $script:ui.billGrant.Text = '注册赠送：' + (MicroText $h.signupGrantMicro) + ' / 30 天（限基础模型）'

  $proGrant = 0
  $freeGrant = 0
  if ($p) {
    foreach ($pl in @($p.plans)) {
      if ($pl.id -eq 'Pro') { $proGrant = [double]$pl.monthlyGrantMicro }
      if ($pl.id -eq 'Free') { $freeGrant = [double]$pl.monthlyGrantMicro }
    }
  }
  $script:ui.billPro.Text = '专业版月度额度：' + (MicroText $proGrant) + ' / 月（不结转；免费版 ' + (MicroText $freeGrant) + '）'

  if ($h.onlinePay) {
    $script:ui.billPay.Text = '在线支付：已启用（充值可自助下单 → 扫码 → 自动到账）'
    $script:ui.billPay.ForeColor = $script:ColGreen
  } else {
    $script:ui.billPay.Text = '在线支付：未配置（走收款码 + 人工核销；可在网页管理页的在线支付网关开启）'
    $script:ui.billPay.ForeColor = $script:ColMuted
  }

  $script:ui.billPriced.Text = '已配价模型：' + [string]$h.pricedModels + ' 条'
  $script:ui.billGaps.Text = '未配价模型：' + [string]$h.meteringGaps + ' 次调用缺 usage'
  $script:ui.billGaps.ForeColor = $(if ([int]$h.meteringGaps -gt 0) { $script:ColOrange } else { $script:ColText })
  $rc = 0
  if ($p -and $p.rechargeOptions) { $rc = @($p.rechargeOptions).Count }
  $script:ui.billRecharge.Text = '充值档位：' + $rc + ' 个'

  $script:ui.planList.Items.Clear()
  if ($p) {
    foreach ($pl in @($p.plans)) {
      $it = New-Object System.Windows.Forms.ListViewItem([string]$pl.name + '（' + [string]$pl.id + '）')
      [void]$it.SubItems.Add((MicroText ([double]$pl.monthlyGrantMicro)) + ' / 月')
      [void]$it.SubItems.Add($(if ($pl.highTierModels) { '可用' } else { '不可用' }))
      $priceTxt = '—'
      if ($pl.id -eq 'Pro' -and $p.priceOptions) {
        $arr = @()
        foreach ($po in @($p.priceOptions)) { $arr += ([string]$po.label + ' ¥' + [string]$po.price) }
        if ($arr.Count -gt 0) { $priceTxt = $arr -join ' ｜ ' }
      } elseif ($pl.id -eq 'Free') {
        $priceTxt = '免费'
      }
      [void]$it.SubItems.Add($priceTxt)
      [void]$script:ui.planList.Items.Add($it)
    }
  }

  # ---- 在线支付网关详情（1.8.3，缓存 15 秒；本机管理接口仅本机可访问）----
  if ($Force -or $null -eq $script:payGw -or ((Get-Date) - $script:payGwAt).TotalSeconds -gt 15) {
    try {
      $script:payGw = Invoke-UiApi 'GET' '/api/admin/payment' $null 2
    } catch {
      $script:payGw = $null
    }
    $script:payGwAt = Get-Date
  }
  if ($script:ui.pgwState) {
    $pmt = $null
    if ($script:payGw -and $script:payGw.payment) { $pmt = $script:payGw.payment }
    if (-not $pmt) {
      $script:ui.pgwState.Text = '网关状态：读取失败（管理接口不可用）'
      $script:ui.pgwState.ForeColor = $script:ColMuted
      $script:ui.pgwMeta.Text = ''
      $script:ui.pgwOverpay.Text = ''
    } else {
      $prov = '易支付 V1（MD5）'
      if ([string]$pmt.provider -eq 'mzf2') { $prov = '易支付 V2（RSA）' }
      $qm = '标准 api.php?act=order'
      if ([string]$pmt.queryMode -eq 'checkOrder') { $qm = '变体 GET /Api/checkOrder' }
      $script:ui.pgwMeta.Text = '协议 ' + $prov + ' ｜ 网关 ' + [string]$pmt.gateway + ' ｜ pid ' + [string]$pmt.pid + ' ｜ 查单 ' + $qm

      $cents = 100
      if ($null -ne $pmt.overpayCents) { $cents = [double]$pmt.overpayCents }
      if ($cents -gt 0) {
        $script:ui.pgwOverpay.Text = '免签多付容差：¥' + ($cents / 100).ToString('0.00') + '（少付仍拒绝；pp.env 的 PP_PAY_OVERPAY_CENTS 可调，0=精确比对）'
      } else {
        $script:ui.pgwOverpay.Text = '免签多付容差：0（精确比对；免签网关并发同额订单可能因加价被拒）'
      }

      if ($pmt.onlineReady) {
        $script:ui.pgwState.Text = '网关状态：已就绪 —— 插件下单 → 扫码 → 自动到账'
        $script:ui.pgwState.ForeColor = $script:ColGreen
      } elseif (-not $pmt.enabled) {
        $script:ui.pgwState.Text = '网关状态：未启用（客户端回落收款码 + 人工核销）'
        $script:ui.pgwState.ForeColor = $script:ColAmber
      } elseif (-not $pmt.hasKey) {
        $script:ui.pgwState.Text = '网关状态：未就绪 —— 未填商户密钥'
        $script:ui.pgwState.ForeColor = $script:ColRed
      } elseif (-not $script:payGw.payment.siteBaseConfigured) {
        $script:ui.pgwState.Text = '网关状态：未就绪 —— PP_PUBLIC_URL 未配置（回调地址无法确定）'
        $script:ui.pgwState.ForeColor = $script:ColRed
      } else {
        $script:ui.pgwState.Text = '网关状态：未就绪 —— 检查网关地址与密钥是否匹配'
        $script:ui.pgwState.ForeColor = $script:ColAmber
      }
    }
  }
}

function Update-OpsUI {
  param([bool]$Force = $false)
  $h = Get-HealthCached 10
  if (-not $h) {
    $script:ui.alertBacklog.Text = '积压：后台未连接'
    $script:ui.alertBacklog.ForeColor = $script:ColMuted
    $script:ui.alertOldest.Text = ''
    $script:ui.alertMail.Text = ''
    $script:ui.healthGaps.Text = '未配价模型：—'
    $script:ui.healthPriced.Text = '已配价模型：—'
    $script:ui.healthDevices.Text = '活跃设备：—'
    $script:ui.healthAudit.Text = '审计体积：—'
    $script:ui.healthSnap.Text = '快照：—'
    $script:ui.healthMailSvc.Text = '邮件服务：—'
    $script:ui.healthBacklogMini.Text = '积压超时：—'
    $script:ui.snapLine.Text = '最近快照：—'
    $script:ui.auditList.Items.Clear()
    return
  }

  $overdue = [bool]$h.backlogOverdue
  $script:ui.alertBacklog.Text = '待核销积压：' + [string]$h.backlogCount + ' 单' + $(if ($overdue) { '（已超时）' } else { '' })
  $script:ui.alertBacklog.ForeColor = $(if ($overdue) { $script:ColRed } elseif ([int]$h.backlogCount -gt 0) { $script:ColAmber } else { $script:ColGreen })
  $script:ui.alertOldest.Text = '最久等待：' + [string]$h.backlogOldestMinutes + ' 分钟 · 巡检间隔 5 分钟'
  $script:ui.alertMail.Text = '邮件告警：见下方「邮件服务」；积压/设备超限会写 alerts.log 并按配置发邮件。'

  $script:ui.healthGaps.Text = '未配价模型：' + [string]$h.meteringGaps + ' 次调用缺 usage'
  $script:ui.healthGaps.ForeColor = $(if ([int]$h.meteringGaps -gt 0) { $script:ColOrange } else { $script:ColText })
  $script:ui.healthPriced.Text = '已配价模型：' + [string]$h.pricedModels + ' 条'
  $script:ui.healthDevices.Text = '活跃设备：' + [string]$h.sessionsActive + ' 台' + $(if ($h.devicesOverLimit) { '（超阈值）' } else { '' })
  $script:ui.healthDevices.ForeColor = $(if ($h.devicesOverLimit) { $script:ColOrange } else { $script:ColText })
  $script:ui.healthAudit.Text = '审计体积：' + (Format-Bytes $h.auditBytes)
  $script:ui.healthSnap.Text = '快照：' + [string]$h.snapshots + ' 份'
  $script:ui.healthMailSvc.Text = '邮件服务：' + $(if ($h.mail -eq 'on') { '已配置' } else { '未配置（只写 alerts.log）' })
  $script:ui.healthMailSvc.ForeColor = $(if ($h.mail -eq 'on') { $script:ColText } else { $script:ColMuted })
  $script:ui.healthBacklogMini.Text = '积压超时：' + $(if ($overdue) { '是（' + [string]$h.backlogOldestMinutes + ' 分钟）' } else { '否' })

  if (-not $Force -and ((Get-Date) - $script:opsAt).TotalSeconds -lt 20) { return }
  $script:opsAt = Get-Date

  try {
    $b = Invoke-UiApi 'GET' '/api/admin/backups' $null 2
    if ($b.items -and @($b.items).Count -gt 0) {
      $first = @($b.items)[0]
      $script:ui.snapLine.Text = '最近快照：' + [string]$first.id + ' · ' + [string]$first.reason + ' · ' + (Format-Bytes $first.size)
    } else { $script:ui.snapLine.Text = '最近快照：暂无' }
  } catch { }

  try {
    $a = Invoke-UiApi 'GET' '/api/admin/alerts' $null 2
    if ($a.alerts) {
      $rcp = @($a.alerts.recipients).Count
      if ($rcp -gt 0) {
        $script:ui.alertMail.Text = '邮件告警：已配置（收件人 ' + $rcp + ' 个）'
      } elseif ($a.alerts.mailConfigured) {
        $script:ui.alertMail.Text = '邮件服务已就绪，但未设告警收件人（只写 alerts.log；pp.env 加 PP_ALERT_EMAIL）'
        $script:ui.alertMail.ForeColor = $script:ColOrange
      } else {
        $script:ui.alertMail.Text = '邮件告警：未配置 —— 只在 alerts.log 留痕（pp.env 加 PP_ALERT_EMAIL）'
        $script:ui.alertMail.ForeColor = $script:ColMuted
      }
    }
  } catch { }

  try {
    $au = Invoke-UiApi 'GET' '/api/admin/audit?limit=8' $null 2
    $script:ui.auditList.Items.Clear()
    foreach ($e in @($au.items)) {
      $when = ''
      try { $when = ([datetime]$e.at).ToLocalTime().ToString('MM-dd HH:mm') } catch { $when = [string]$e.at }
      $it = New-Object System.Windows.Forms.ListViewItem($when)
      [void]$it.SubItems.Add([string]$e.actionText)
      [void]$it.SubItems.Add([string]$e.target)
      [void]$it.SubItems.Add($(if ($e.ok -eq $false) { '失败' } else { '成功' }))
      [void]$script:ui.auditList.Items.Add($it)
    }
  } catch { }
}

function Update-AboutUI {
  $h = Get-HealthCached 10
  $ver = '未运行'
  if ($h -and $h.version) { $ver = 'v' + [string]$h.version + '（运行中）' }
  $script:ui.verServer.Text = '服务端：' + $ver
  $script:ui.verPlugin.Text = '插件（manifest）：v' + $script:PluginVersion
  $xpi = Get-LatestXpi
  if ($xpi) { $script:ui.verXpi.Text = '最新安装包：' + $xpi.Name } else { $script:ui.verXpi.Text = '最新安装包：dist 下暂无' }
  $script:ui.envNode.Text = 'Node：' + $NodeExe
  $cfExe = Join-Path $CfDir 'cloudflared.exe'
  $cfRun = Join-Path $CfDir 'cloudflared-run-papilot.bat'
  $okCf = (Test-Path $cfExe) -and (Test-Path $cfRun)
  $script:ui.envCf.Text = 'cloudflared：' + $(if ($okCf) { '就绪（exe + 运行器）' } else { '缺失（检查 runtime\cloudflared）' })
  $script:ui.envCf.ForeColor = $(if ($okCf) { $script:ColText } else { $script:ColRed })
  $okTok = Test-Path $TunnelTokenFile
  $script:ui.envToken.Text = '隧道令牌：' + $(if ($okTok) { '存在（token.txt）' } else { '缺失（运行 scripts\tunnel\refresh-token.ps1）' })
  $script:ui.envToken.ForeColor = $(if ($okTok) { $script:ColText } else { $script:ColRed })
  $script:ui.envRuntime.Text = '运行时目录：' + (Join-Path $ProjectRoot 'runtime')
  $script:ui.sidePlug.Text = '插件 ' + $script:PluginVersion
}

function Update-All {
  $script:tickCount = [int]$script:tickCount + 1
  Update-StatusUI
  Update-TunnelUI
  Update-ChannelUI $false
  Update-OverviewUI
  if ($script:activePage -eq 'billing') { Update-BillingUI $false }
  if ($script:activePage -eq 'ops' -and ($script:tickCount % 5 -eq 1)) { Update-OpsUI $false }
  if ($script:tickCount % 5 -eq 1) { Fill-LauncherEvents }
  $script:ui.lblRefresh.Text = '刷新 ' + (Get-Date -Format 'HH:mm:ss')
}

# 等一会儿但**保持窗口可响应**：所有按钮处理里的等待都走这里，不许裸 Start-Sleep。
function Wait-Ui([int]$Ms) {
  $deadline = (Get-Date).AddMilliseconds($Ms)
  while ((Get-Date) -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 40
  }
}

# ============================================================
# 操作封装（按钮 / 托盘共用）
# ============================================================
function Do-StartServer {
  if ($script:busy) { return }
  $script:busy = $true
  try {
    $lblMsg.Text = '正在启动账号后台…'
    [System.Windows.Forms.Application]::DoEvents()
    $r = Start-Server
    $ok = -not ($r -eq 'error:') -and -not ([string]$r).StartsWith('occupied:')
    Write-LauncherAudit 'start-server' ([string]$r) $ok
    Show-StartResult $r
    Wait-Ui 300
    Update-All
  } finally { $script:busy = $false }
}

function Do-StopServer {
  param([bool]$Confirm = $false)
  if ($script:busy) { return }
  if ($Confirm) {
    $ans = [System.Windows.Forms.MessageBox]::Show('停止后：插件将无法登录 / 使用官方 AI，公网通道也会失去后端。确定停止？', '停止账号后台', 'YesNo', 'Warning')
    if ($ans -ne 'Yes') { return }
  }
  $script:busy = $true
  try {
    $lblMsg.Text = '正在停止账号后台…'
    [System.Windows.Forms.Application]::DoEvents()
    $n = Stop-Server
    Write-LauncherAudit 'stop-server' ('killed=' + $n) $true
    if ($n -gt 0) { $lblMsg.Text = '已停止账号后台服务' } else { $lblMsg.Text = '后台未在运行' }
    $script:health = $null
    $script:healthFailAt = [datetime]::MinValue
    $script:healthHardFail = 0
    $script:channels = $null
    Update-All
  } finally { $script:busy = $false }
}

function Do-RestartServer {
  if ($script:busy) { return }
  $ans = [System.Windows.Forms.MessageBox]::Show('重启会中断正在进行的 AI 请求。确定重启？', '重启账号后台', 'YesNo', 'Warning')
  if ($ans -ne 'Yes') { return }
  $script:busy = $true
  try {
    $lblMsg.Text = '正在停止账号后台…'
    [System.Windows.Forms.Application]::DoEvents()
    $n = Stop-Server
    # ★ 原实现是 20 × (Get-NetTCPConnection 1.2s + Start-Sleep 500ms) ≈ 最坏 40 秒不响应。
    #   现在用 150ms TCP 探测 + Wait-Ui（内部 DoEvents），总预算 8 秒，窗口全程可用。
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
      if (-not (Test-PortOpen $Port 150)) { break }
      Wait-Ui 150
    }
    Wait-Ui 200
    $lblMsg.Text = '正在启动账号后台…'
    [System.Windows.Forms.Application]::DoEvents()
    $r = Start-Server
    Write-LauncherAudit 'restart-server' ('killed=' + $n + ' / ' + [string]$r) $true
    Show-StartResult $r
    $script:health = $null
    $script:healthFailAt = [datetime]::MinValue
    $script:healthHardFail = 0
    $script:channels = $null
    Update-All
  } finally { $script:busy = $false }
}

function Do-StartTunnel {
  if ($script:busy) { return }
  $script:busy = $true
  try {
    $r = Start-Tunnel
    Write-LauncherAudit 'start-tunnel' ([string]$r) ($r -eq 'started' -or $r -eq 'already')
    if ($r -eq 'started') { $lblMsg.Text = '已发起公网通道启动，约 10~30 秒就绪（状态灯变绿前请勿重复点击）' }
    elseif ($r -eq 'already') { $lblMsg.Text = '公网通道已在运行' }
    elseif ($r -eq 'no-token') {
      [System.Windows.Forms.MessageBox]::Show('缺少令牌文件：runtime\cloudflared\token.txt' + "`n" + '可运行 scripts\tunnel\refresh-token.ps1 从 _brain 重新提取。', '无法启动', 'OK', 'Warning') | Out-Null
    }
    elseif ($r -eq 'missing') {
      [System.Windows.Forms.MessageBox]::Show('缺少运行器：runtime\cloudflared\cloudflared-run-papilot.bat' + "`n" + '（cloudflared.exe 是否随盘携带？）', '无法启动', 'OK', 'Warning') | Out-Null
    }
    else { $lblMsg.Text = '启动失败：' + [string]$r }
    $script:tunTick = 0
    Update-All
  } finally { $script:busy = $false }
}

function Do-StopTunnel {
  param([bool]$Confirm = $false)
  if ($script:busy) { return }
  if ($Confirm) {
    $ans = [System.Windows.Forms.MessageBox]::Show('停止后公网入口 pp.xinglintools.top 将不可达（插件无法连接账号服务器）。确定停止？', '停止公网通道', 'YesNo', 'Warning')
    if ($ans -ne 'Yes') { return }
  }
  $script:busy = $true
  try {
    $n = Stop-Tunnel
    Write-LauncherAudit 'stop-tunnel' ('killed=' + $n) $true
    if ($n -gt 0) { $lblMsg.Text = '已停止公网通道（结束 ' + $n + ' 个进程）' } else { $lblMsg.Text = '公网通道本来未在运行' }
    $script:tunTick = 0
    Update-All
  } finally { $script:busy = $false }
}

function Do-TestSite {
  try {
    $r = Invoke-RestMethod -Uri ($SiteUrl + '/api/health') -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
    [System.Windows.Forms.MessageBox]::Show(('公网访问正常' + "`n" + $SiteUrl + "`n" + '服务：' + [string]$r.service + ' v' + [string]$r.version), '测试通过', 'OK', 'Information') | Out-Null
  } catch {
    [System.Windows.Forms.MessageBox]::Show('公网访问失败：检查通道是否启动（状态灯）+ 账号后台是否运行（8000）', '测试失败', 'OK', 'Warning') | Out-Null
  }
}

# 1.8.3 在线支付网关自检（浅测 = 查单链路可达；深测 = 按真实参数建 0.01 元未支付测试单）
function Do-TestPayGateway {
  param([bool]$Deep = $false)
  if ($script:busy) { return }
  if (-not (Require-ServerRunning)) { return }
  if ($Deep) {
    $r = [System.Windows.Forms.MessageBox]::Show(
      ('深度测试会按真实下单参数向支付网关创建一笔 0.01 元测试单（不支付、商户后台会留未支付记录，可忽略）。' + "`n`n是否继续？"),
      '深度测试', 'YesNo', 'Question')
    if ($r -ne 'Yes') { return }
  }
  $script:busy = $true
  try {
    if ($script:ui.pgwMsg) {
      $script:ui.pgwMsg.Text = $(if ($Deep) { '深度测试中（最长 30 秒）…' } else { '连接测试中…' })
      $script:ui.pgwMsg.ForeColor = $script:ColMuted
    }
    # 先把「测试中」画出来再阻塞，否则用户只会看到一片白
    [System.Windows.Forms.Application]::DoEvents()
    $res = $null
    try {
      $res = Invoke-UiApi 'POST' '/api/admin/payment/test' @{ deep = $Deep } 30
    } catch {
      $res = @{ ok = $false; msg = $_.Exception.Message }
    }
    $ok = [bool]($res -and $res.ok)
    $msg = '无响应'
    if ($res -and $null -ne $res.msg) { $msg = [string]$res.msg }
    if ($script:ui.pgwMsg) {
      $script:ui.pgwMsg.Text = $(if ($ok) { '✓ ' } else { '✗ ' }) + $msg
      $script:ui.pgwMsg.ForeColor = $(if ($ok) { $script:ColGreen } else { $script:ColRed })
    }
    $auditDetail = 'shallow: '
    if ($Deep) { $auditDetail = 'deep: ' }
    Write-LauncherAudit 'pay-gateway-test' ($auditDetail + $msg) $ok
    # 自检后刷新网关状态卡（enable/ready 可能变化）
    $script:payGw = $null
    $script:payGwAt = [datetime]::MinValue
    Update-BillingUI $true
  } finally { $script:busy = $false }
}

function Do-OpenAdmin {
  if (-not (Require-ServerRunning)) { return }
  Open-Url $AdminPage
}

function Do-OpenLog {
  param([string]$Path, [string]$Label)
  if (Test-Path $Path) { Invoke-Item $Path }
  else { $lblMsg.Text = $Label + '尚未产生：' + $Path }
}

function Do-Snapshot {
  if (-not (Require-ServerRunning)) { return }
  try {
    $r = Invoke-UiApi 'POST' '/api/admin/backups' @{ note = '控制台手动快照' } 10
    $id = ''
    if ($r.snapshot) { $id = [string]$r.snapshot.id }
    Write-LauncherAudit 'snapshot' $id $true
    $lblMsg.Text = '已创建快照：' + $id
    $script:opsAt = [datetime]::MinValue
    $script:healthAt = [datetime]::MinValue
    Update-OpsUI $true
    [System.Windows.Forms.MessageBox]::Show('快照已创建：' + $id, '数据快照', 'OK', 'Information') | Out-Null
  } catch {
    $msg = Get-HttpErrorDetail $_
    Write-LauncherAudit 'snapshot' $msg $false
    $lblMsg.Text = '快照失败：' + $msg
    [System.Windows.Forms.MessageBox]::Show($msg, '快照失败', 'OK', 'Warning') | Out-Null
  }
}

function Do-AlertCheck {
  if (-not (Require-ServerRunning)) { return }
  try {
    $r = Invoke-UiApi 'POST' '/api/admin/alerts/check' @{} 15
    $backlog = 0
    if ($r.result -and $r.result.backlog) { $backlog = [int]$r.result.backlog.backlogCount }
    $mailed = '未发'
    if ($r.result -and $r.result.mailed) { $mailed = '已发' }
    Write-LauncherAudit 'alert-check' ('backlog=' + $backlog) $true
    $lblMsg.Text = '巡检完成：积压 ' + $backlog + ' 单，邮件' + $mailed
    $script:healthAt = [datetime]::MinValue
    $script:opsAt = [datetime]::MinValue
    Update-OpsUI $true
    [System.Windows.Forms.MessageBox]::Show('巡检完成' + "`n" + '待核销积压：' + $backlog + ' 单' + "`n" + '邮件告警：' + $mailed, '告警巡检', 'OK', 'Information') | Out-Null
  } catch {
    $msg = Get-HttpErrorDetail $_
    Write-LauncherAudit 'alert-check' $msg $false
    $lblMsg.Text = '巡检失败：' + $msg
    [System.Windows.Forms.MessageBox]::Show($msg, '巡检失败', 'OK', 'Warning') | Out-Null
  }
}

function Fill-LauncherEvents {
  $lv = $script:ui.evtList
  if (-not $lv) { return }
  $lv.Items.Clear()
  foreach ($e in (Read-LauncherAudit 8)) {
    $when = ''
    try { $when = ([datetime]$e.at).ToLocalTime().ToString('MM-dd HH:mm:ss') } catch { $when = [string]$e.at }
    $it = New-Object System.Windows.Forms.ListViewItem($when)
    [void]$it.SubItems.Add([string]$e.action)
    [void]$it.SubItems.Add($(if ($e.ok -eq $false) { '失败' } else { '成功' }))
    [void]$it.SubItems.Add([string]$e.detail)
    [void]$lv.Items.Add($it)
  }
  $has = $lv.Items.Count -gt 0
  $lv.Visible = $has
  if ($script:ui.evtEmpty) { $script:ui.evtEmpty.Visible = -not $has }
}

# ============================================================
# 系统托盘
# ============================================================
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $script:appIcon
$tray.Text = 'Papilot 后台 · 控制台'
# ★ 托盘图标常驻：旧版只在「关闭窗口」时才显示，而 Win11 默认把新图标折叠进溢出区，
#   用户既关不掉窗口也找不到托盘 → 只能当它卡死。现在从启动起就可见。
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = $menu.Items.Add('显示主窗口')
$miHide = $menu.Items.Add('最小化到托盘')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miStart = $menu.Items.Add('启动后台')
$miStop = $menu.Items.Add('停止后台')
$miAdmin = $menu.Items.Add('打开管理页')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miExit = $menu.Items.Add('退出程序（关闭控制台）')
$tray.ContextMenuStrip = $menu

$script:trayTipShown = $false
$script:allowExit = $false

function Hide-ToTray {
  $form.Hide()
  $tray.Visible = $true
  if (-not $script:trayTipShown) {
    $script:trayTipShown = $true
    $tray.ShowBalloonTip(2500, 'Papilot 后台', '控制台已收到托盘，服务继续运行；左键点托盘图标可恢复窗口。', 'Info')
  }
}

function Show-MainWindow {
  $form.Show()
  $form.WindowState = 'Normal'
  $form.Activate()
  $form.BringToFront()
  $tray.Visible = $true
}

function Exit-App {
  $script:allowExit = $true
  $timer.Stop()
  try { $script:bootTimer.Stop() } catch { }
  $tray.Visible = $false
  $tray.Dispose()
  $form.Close()
}

$miShow.add_Click({ Show-MainWindow })
$miHide.add_Click({ Hide-ToTray })
$miStart.add_Click({ Do-StartServer })
$miStop.add_Click({ Do-StopServer $false })
$miAdmin.add_Click({ Do-OpenAdmin })
$miExit.add_Click({ Exit-App })

$tray.add_MouseClick({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-MainWindow }
})

# ★ 关闭（X）= 退出控制台（带确认）。旧行为是「静默最小化到托盘」，
#   在托盘图标被折叠时表现为"窗口关不掉、进程退不掉"，是"卡死"观感的主要来源之一。
#   退出只结束控制台本身：账号后台与公网通道是独立进程，不受影响。
$form.add_FormClosing({
  param($s, $e)
  if ($script:allowExit) { return }
  $e.Cancel = $true
  $ans = [System.Windows.Forms.MessageBox]::Show(
    ('退出控制台？' + "`n`n" + '账号后台与公网通道会继续在后台运行，不受影响。' + "`n" +
     '下次双击「启动Papilot后台.bat」即可重新打开控制台。'),
    '退出控制台', 'YesNo', 'Question')
  if ($ans -eq 'Yes') { Exit-App }
})

$form.add_Shown({
  # 支持从快捷方式/排障脚本直达某一页：set PP_LAUNCHER_START_PAGE=billing
  $startPage = [string]$env:PP_LAUNCHER_START_PAGE
  if (-not $startPage -or -not $script:pages.Contains($startPage)) { $startPage = 'overview' }
  Show-UiPage $startPage
  $script:ui.btnStartup.Text = '开机自启：' + $(if (Get-StartupEnabled) { '开' } else { '关' })
  $script:ui.chkAutoBoot.Checked = Get-AutoBootServices
  Fill-LauncherEvents
  Update-AboutUI
  Write-Boot 'form shown'
  # ★ 先让窗口画出来，再自动拉起后台/通道并做首次网络探测：
  #   这些操作有 1~3 秒的 IO，放在 Shown 里会让窗口「出来了但点不动」。
  $script:bootTimer.Start()
})

$script:bootTimer = New-Object System.Windows.Forms.Timer
$script:bootTimer.Interval = 250
$script:bootTimer.Add_Tick({
  $script:bootTimer.Stop()
  try {
    Start-ServicesOnBoot
    Update-All
    Fill-LauncherEvents
    Write-Boot 'auto-start + first refresh done'
  } catch {
    Write-Boot ('first refresh failed: ' + $_.Exception.Message + ' @ ' + $_.ScriptStackTrace)
    $lblMsg.Text = '首次刷新失败：' + $_.Exception.Message
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$script:lastRefreshErr = ''
# 慢刷新留痕：没有这份日志，下一次"卡死"仍然只能靠猜。
$script:SlowLog = Join-Path $env:TEMP 'papilot-launcher-slow.log'
function Write-SlowLog([string]$msg) {
  try {
    $line = '[' + (Get-Date).ToString('HH:mm:ss.fff') + '] ' + $msg + "`r`n"
    [System.IO.File]::AppendAllText($script:SlowLog, $line, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}
$timer.Add_Tick({
  # ★ 单飞：一次刷新没跑完就不允许重入（旧版无此保护，慢一拍会和下一拍叠起来）
  if ($script:tickBusy) { return }
  $script:tickBusy = $true
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    Update-All
    $script:lastRefreshErr = ''
  } catch {
    $msg = $_.Exception.Message
    if ($script:lastRefreshErr -ne $msg) {
      $script:lastRefreshErr = $msg
      Write-Boot ('refresh failed: ' + $msg + ' @ ' + $_.ScriptStackTrace)
    }
    $lblMsg.Text = '界面刷新失败：' + $msg
  } finally {
    $script:tickBusy = $false
    $sw.Stop()
    if ($sw.ElapsedMilliseconds -gt 800) {
      Write-SlowLog ('refresh ' + $sw.ElapsedMilliseconds + 'ms page=' + $script:activePage +
                     ' svc=' + $script:svcState + ' healthFail=' + $script:healthHardFail)
    }
  }
})
$timer.Start()
Write-Boot 'ui built; entering message loop'

[void][System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$form.Dispose()
try { $script:mutex.ReleaseMutex() } catch { }
