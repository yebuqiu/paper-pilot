# ============================================================
# PaperPilot 后台 · 统一控制台 v1（WinForms GUI）
# 双击项目根目录"启动PaperPilot后台.bat"无窗拉起本脚本。
#
# 功能（对标心血管药物学习平台启动管理器，适配 PaperPilot 账号后台）：
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

# DPI 感知（须在创建任何窗口前调用）
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiAware{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[void][DpiAware]::SetProcessDPIAware()

# 单实例锁：重复双击直接提示并退出
$script:mutex = New-Object System.Threading.Mutex($false, 'PaperPilotLauncherMutex')
if (-not $script:mutex.WaitOne(0)) {
  [System.Windows.Forms.MessageBox]::Show('控制台已在运行（可能已最小化到系统托盘），请点击托盘图标恢复窗口。', 'PaperPilot 后台', 'OK', 'Information') | Out-Null
  exit
}

# ---------------- 配置 ----------------
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ServerDir   = Join-Path $ProjectRoot 'server'
$DataDir     = Join-Path $ServerDir 'data'
$ServerLog   = Join-Path $DataDir 'server-console.log'
$Port        = 8000
$AdminPage   = 'http://127.0.0.1:' + $Port + '/admin'
$HealthUrl   = 'http://127.0.0.1:' + $Port + '/api/health'

# ---------------- node 路径：自动扫描最新版本 ----------------
function Resolve-NodeExe {
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
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch {}
  return 0
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
  try {
    $r = Invoke-RestMethod -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
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
function Get-ServerState {
  $portPid = Get-PortOwnerPid
  if ($portPid -gt 0) {
    if (Test-Health) { return @{ State = 'running'; PortPid = $portPid } }
    $started = Get-ProcessStart $portPid
    $age = 999
    if ($started) { $age = ((Get-Date) - $started).TotalSeconds }
    if ($age -lt 30) { return @{ State = 'starting'; PortPid = $portPid } }
    return @{ State = 'degraded'; PortPid = $portPid }
  }
  if ((Get-ServerProcess).Count -gt 0) { return @{ State = 'starting'; PortPid = 0 } }
  return @{ State = 'stopped'; PortPid = 0 }
}

# ---------------- 后台启停 ----------------
function Start-Server {
  $portPid = Get-PortOwnerPid
  if ($portPid -gt 0) {
    $name = Get-ProcName $portPid
    if ($name -eq 'node') { return 'already' }
    return 'occupied:' + $name + ':' + $portPid
  }
  if ((Get-ServerProcess).Count -gt 0) { return 'starting' }
  try {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    # 清除手动停机标记：用户点了启动 = 明确要服务运行（PaperPilotGuard 守护据此恢复守护）
    Remove-Item (Join-Path $DataDir 'stopped-account.flag') -Force -ErrorAction SilentlyContinue
    if ((Test-Path $ServerLog) -and (Get-Item $ServerLog).Length -gt 20MB) {
      $rotName = 'server-console-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'
      Move-Item $ServerLog (Join-Path $DataDir $rotName) -Force -ErrorAction SilentlyContinue
    }
    $cmdArgs = '/c ""' + $NodeExe + '" account-server.js >> "' + $ServerLog + '" 2>&1"'
    Start-HiddenProcess 'cmd.exe' $cmdArgs $ServerDir
    return 'started'
  } catch {
    return 'error:' + $_.Exception.Message
  }
}

function Stop-Server {
  $killed = 0
  $portPid = Get-PortOwnerPid
  if ($portPid -gt 0) {
    try { Stop-Process -Id $portPid -Force -ErrorAction Stop; $killed++ } catch {}
  }
  foreach ($p in (Get-ServerProcess)) {
    if ($p.ProcessId -ne $portPid) {
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
    }
  }
  # 手动停机标记：PaperPilotGuard 守护看到此标记不会复活服务（下次 Start-Server 自动清除）
  if ($killed -gt 0) {
    try { Set-Content (Join-Path $DataDir 'stopped-account.flag') 'stopped by launcher' -Encoding ASCII } catch {}
  }
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
    TimeoutSec = 30
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
  if (Test-Health) { return $true }
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
    'user.create' = '新建用户'; 'user.update' = '修改用户'; 'user.password' = '重置密码'
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
  Update-ChannelLine
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
      [System.Windows.Forms.MessageBox]::Show('已注册 ' + $txtEmail.Text.Trim() + $extra + "`n`n" + '可在 Zotero：设置 → PaperPilot 中登录使用。', '注册成功', 'OK', 'Information') | Out-Null
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
  [void]$lv.Columns.Add('邮箱', 195)
  [void]$lv.Columns.Add('昵称', 90)
  [void]$lv.Columns.Add('等级', 55)
  [void]$lv.Columns.Add('会员到期', 150)
  [void]$lv.Columns.Add('今日用量', 80)
  [void]$lv.Columns.Add('活跃设备', 80)
  [void]$lv.Columns.Add('最近登录', 105)
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
        [void]$it.SubItems.Add(($u.dailyUsed.ToString() + ' / ' + $u.dailyLimit.ToString()))
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
        $txtFreeLimit.Text = [string]$freePlan.dailyLimit
        $chkFreeHi.Checked = [bool]$freePlan.highTierModels
      }
      $txtTrialDays.Text = [string]$script:mbAiTrialDays
      if ($proPlan) {
        $txtProLimit.Text = [string]$proPlan.dailyLimit
        $txtProPrice.Text = [string]$proPlan.price
        $chkProHi.Checked = [bool]$proPlan.highTierModels
      }
      if ($r.plans.ai) { $script:mbAiTrialDays = [int]$r.plans.ai.trialDays }
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

  New-PLabel $pgPlan '免费版 · 每日额度（次）' 16 20
  $txtFreeLimit = New-PInput $pgPlan 190 17 120
  New-PLabel $pgPlan '专业版 · 每日额度（次）' 16 54
  $txtProLimit = New-PInput $pgPlan 190 51 120
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
    try {
      $body = @{
        plans = @{
          Free = @{ dailyLimit = [int]$txtFreeLimit.Text; highTierModels = [bool]$chkFreeHi.Checked }
          Pro = @{ dailyLimit = [int]$txtProLimit.Text; price = [int]$txtProPrice.Text; highTierModels = [bool]$chkProHi.Checked }
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
  $lblPTip.Text = '额度改为按套餐配置下发：用户在用户级被管理员单独设过 dailyLimit 的，仍以用户级为准。' + "`n" + '「新用户全模型试用」从注册时间起算，试用期内免费用户也能用高级模型（额度不变）；「可用高级模型」需配合通道窗体里的分级清单。' + "`n" + '同一套配置也作用于 Web 管理页（/admin → 会员管理）。'
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

# ---------------- 开机自启（HKCU Run 键） ----------------
$script:RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunKeyName = 'PaperPilotAccountServer'
function Get-StartupEnabled {
  try {
    $p = Get-ItemProperty -Path $script:RunKeyPath -ErrorAction Stop
    return [bool]($p.$script:RunKeyName)
  } catch { return $false }
}
function Set-Startup([bool]$enable) {
  if ($enable) {
    Set-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyName -Value (Join-Path $PSScriptRoot 'start-server-hidden.vbs')
  } else {
    Remove-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyName -ErrorAction SilentlyContinue
  }
}

# ---------------- 主界面 ----------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'PaperPilot 后台 · 控制台'
$form.ClientSize = New-Object System.Drawing.Size(472, 682)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Icon = $script:appIcon

$script:tickCount = 0
$script:pendingSince = $null
$script:timeoutNotified = $false

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = 'PaperPilot 账号后台'
$lblTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
$lblTitle.TextAlign = 'MiddleCenter'
$lblTitle.SetBounds(0, 10, 472, 30)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.Text = '账号 · 官方模型网关 · AI 模型通道 —— 一站式控制台'
$lblSub.ForeColor = [System.Drawing.Color]::DimGray
$lblSub.TextAlign = 'MiddleCenter'
$lblSub.SetBounds(0, 40, 472, 18)

$lampSvc = New-Object System.Windows.Forms.Label
$lampSvc.Text = '●'
$lampSvc.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12)
$lampSvc.ForeColor = [System.Drawing.Color]::Gray
$lampSvc.TextAlign = 'MiddleCenter'
$lampSvc.SetBounds(16, 60, 22, 24)

$lblSvc = New-Object System.Windows.Forms.Label
$lblSvc.Text = '正在检测后台状态…'
$lblSvc.SetBounds(42, 63, 416, 20)

function New-Group([string]$text, [int]$y, [int]$h) {
  $g = New-Object System.Windows.Forms.GroupBox
  $g.Text = $text
  $g.Location = New-Object System.Drawing.Point(14, $y)
  $g.Size = New-Object System.Drawing.Size(444, $h)
  $form.Controls.Add($g)
  return $g
}
function New-Btn($parent, [string]$text, [int]$x, [int]$y, [int]$w, $handler) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, 30)
  $b.add_Click($handler)
  $parent.Controls.Add($b)
  return $b
}

foreach ($c in @($lblTitle, $lblSub, $lampSvc, $lblSvc)) { [void]$form.Controls.Add($c) }

# 分组 1：账号后台控制
$grpCtl = New-Group '账号后台控制（端口 8000，插件默认对接地址）' 96 92
$btnStart = New-Btn $grpCtl '启动后台' 10 26 98 {
  $r = Start-Server
  Show-StartResult $r
  Update-All
}
$btnStop = New-Btn $grpCtl '停止后台' 116 26 98 {
  $n = Stop-Server
  if ($n -gt 0) { $lblMsg.Text = '已停止账号后台服务' } else { $lblMsg.Text = '后台未在运行' }
  Update-All
}
$btnRestart = New-Btn $grpCtl '重启后台' 222 26 98 {
  [void](Stop-Server)
  Start-Sleep -Seconds 1
  $r = Start-Server
  Show-StartResult $r
  Update-All
}
$btnLog = New-Btn $grpCtl '查看服务日志' 328 26 104 {
  if (Test-Path $ServerLog) { Invoke-Item $ServerLog }
  else { [System.Windows.Forms.MessageBox]::Show('暂无日志文件（服务经本控制台启动后才会产生）', '提示') | Out-Null }
}
$lblCtlTip = New-Object System.Windows.Forms.Label
$lblCtlTip.Text = '服务数据：server\data\（users.json / channels.json / membership.json / 日志）· 关闭控制台不影响已启动的服务'
$lblCtlTip.ForeColor = [System.Drawing.Color]::DimGray
$lblCtlTip.SetBounds(10, 64, 424, 20)
[void]$grpCtl.Controls.Add($lblCtlTip)

# 分组 2：AI 模型通道
$grpLlm = New-Group 'AI 模型通道（官方网关上游）' 196 110
$lblLlm = New-Object System.Windows.Forms.Label
$lblLlm.Text = '检测中…'
$lblLlm.Location = New-Object System.Drawing.Point(10, 22)
$lblLlm.Size = New-Object System.Drawing.Size(424, 36)
[void]$grpLlm.Controls.Add($lblLlm)
$btnChMgr = New-Btn $grpLlm '通道管理（增/删/切换/实测）' 10 64 208 { Show-ChannelManager }
$btnChPage = New-Btn $grpLlm '打开浏览器管理页' 226 64 208 {
  if (-not (Require-ServerRunning)) { return }
  Open-Url $AdminPage
}

# 分组 3：账号管理（0.23.0：新增「会员管理」入口 —— 订单核销 / 激活码 / 套餐与收款）
$grpUser = New-Group '账号管理' 314 96
$btnReg = New-Btn $grpUser '注册账号' 10 24 208 { Show-RegisterUser }
$btnUsers = New-Btn $grpUser '用户列表（会员/密码/删除）' 226 24 208 { Show-UserList }
$btnMember = New-Btn $grpUser '会员管理（订单核销 / 激活码 / 价格 / 收款 / 审计）' 10 58 424 { Show-MembershipManager }

# 分组 4：维护
$grpOps = New-Group '维护' 418 94
$btnStartup = New-Btn $grpOps '开机自启：…' 10 24 118 {
  $new = -not (Get-StartupEnabled)
  Set-Startup $new
  $btnStartup.Text = '开机自启：' + $(if ($new) { '开' } else { '关' })
  if ($new) { $state = '已开启：重启电脑后账号后台将自动启动' } else { $state = '已关闭' }
  [System.Windows.Forms.MessageBox]::Show($state, '开机自启', 'OK', 'Information') | Out-Null
}
$btnData = New-Btn $grpOps '数据目录' 142 24 98 {
  if (Test-Path $DataDir) { Invoke-Item $DataDir }
  else { $lblMsg.Text = '数据目录尚未创建（启动服务后自动生成）' }
}
$btnProj = New-Btn $grpOps '项目目录' 248 24 98 { Invoke-Item $ProjectRoot }
$btnXpi = New-Btn $grpOps '安装包' 354 24 80 {
  $xpi = Get-ChildItem (Join-Path $ProjectRoot 'dist') -Filter '*.xpi' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($xpi) {
    $r = [System.Windows.Forms.MessageBox]::Show('最新安装包：' + $xpi.Name + "`n`n在 Zotero 中安装：工具 → 附加组件 → 齿轮 → Install Add-on From File…`n是否现在打开所在文件夹？", '插件安装包', 'YesNo', 'Information')
    if ($r -eq 'Yes') { Invoke-Item $xpi.DirectoryName }
  } else { $lblMsg.Text = 'dist 目录下暂无 .xpi 安装包' }
}
$lblOpsTip = New-Object System.Windows.Forms.Label
$lblOpsTip.Text = "登录用户经 /v1 网关调用活动通道；未登录插件仍可用自己的通道。`n关闭窗口=最小化到托盘；「退出程序」才会结束控制台（不影响已启动的服务）"
$lblOpsTip.Location = New-Object System.Drawing.Point(10, 62)
$lblOpsTip.Size = New-Object System.Drawing.Size(424, 28)
$lblOpsTip.ForeColor = [System.Drawing.Color]::DimGray
[void]$grpOps.Controls.Add($lblOpsTip)

# 底部操作
$btnTray = New-Btn $form '最小化到托盘' 14 618 150 { Hide-ToTray }
$btnTray.Height = 32
$btnExit = New-Btn $form '退出程序' 174 618 110 { Exit-App }
$btnExit.Height = 32

$lblMsg = New-Object System.Windows.Forms.Label
$lblMsg.Text = ''
$lblMsg.ForeColor = [System.Drawing.Color]::DimGray
$lblMsg.TextAlign = 'MiddleLeft'
$lblMsg.SetBounds(16, 656, 440, 20)
[void]$form.Controls.Add($lblMsg)

# ---------------- 状态刷新 ----------------
$green  = [System.Drawing.Color]::FromArgb(0x0F, 0x6E, 0x56)
$red    = [System.Drawing.Color]::FromArgb(0xA3, 0x2D, 0x2D)
$yellow = [System.Drawing.Color]::FromArgb(0xB8, 0x86, 0x0B)
$orange = [System.Drawing.Color]::FromArgb(0xC4, 0x5A, 0x1B)

function Format-Uptime([datetime]$started) {
  $span = (Get-Date) - $started
  if ($span.TotalHours -ge 1) { return ('{0}小时{1}分' -f [int]$span.TotalHours, $span.Minutes) }
  if ($span.TotalMinutes -ge 1) { return ('{0}分{1}秒' -f $span.Minutes, $span.Seconds) }
  return ('{0}秒' -f [int]$span.TotalSeconds)
}

function Update-ServiceStatus {
  $st = Get-ServerState
  if ($st.State -eq 'running') {
    $lampSvc.ForeColor = $green
    $up = ''
    $started = Get-ProcessStart $st.PortPid
    if ($started) { $up = '，已运行 ' + (Format-Uptime $started) }
    $lblSvc.Text = '运行中（PID ' + $st.PortPid + $up + '）'
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $btnRestart.Enabled = $true
    $script:timeoutNotified = $false
  } elseif ($st.State -eq 'degraded') {
    $lampSvc.ForeColor = $orange
    $lblSvc.Text = '服务异常：端口在听但健康检查不过（建议重启）'
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $btnRestart.Enabled = $true
  } elseif ($st.State -eq 'starting') {
    $lampSvc.ForeColor = $yellow
    $lblSvc.Text = '服务启动中，等待端口 ' + $Port + ' 就绪…'
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $btnRestart.Enabled = $true
    if ($script:pendingSince -and ((Get-Date) - $script:pendingSince).TotalSeconds -gt 40 -and -not $script:timeoutNotified) {
      $script:timeoutNotified = $true
      $lblMsg.Text = '启动耗时较长，若持续无响应请查 server\data\server-console.log'
    }
  } else {
    $lampSvc.ForeColor = $red
    $lblSvc.Text = '未运行'
    $btnStart.Enabled = $true
    $btnStop.Enabled = $false
    $btnRestart.Enabled = $false
  }
}

function Update-ChannelLine {
  try {
    $r = Invoke-AdminApi 'GET' '/api/admin/channels'
    $n = @($r.channels).Count
    $act = $null
    foreach ($c in @($r.channels)) { if ($c.id -eq $r.active) { $act = $c; break } }
    if ($act) {
      $lblLlm.Text = '活动通道：' + $act.name + '（' + $act.model + '）· 共 ' + $n + ' 个'
      $lblLlm.ForeColor = $green
    } elseif ($n -gt 0) {
      $lblLlm.Text = '⚠ 未设置活动通道（官方调用将返回 503）· 共 ' + $n + ' 个'
      $lblLlm.ForeColor = $orange
    } else {
      $lblLlm.Text = '暂无通道——请在「通道管理」中新增上游（如 DeepSeek / 通义 / 本地网关）'
      $lblLlm.ForeColor = $orange
    }
  } catch {
    $lblLlm.Text = '后台未连接（启动服务后可管理模型通道）'
    $lblLlm.ForeColor = [System.Drawing.Color]::Gray
  }
}

function Update-All {
  $script:tickCount++
  Update-ServiceStatus
  if ($script:tickCount % 5 -eq 1) { Update-ChannelLine }
}

# ---------------- 系统托盘 ----------------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $script:appIcon
$tray.Text = 'PaperPilot 后台 · 控制台'
$tray.Visible = $false

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = $menu.Items.Add('显示主窗口')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miStart = $menu.Items.Add('启动后台')
$miStop = $menu.Items.Add('停止后台')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miExit = $menu.Items.Add('退出程序')
$tray.ContextMenuStrip = $menu

$script:trayTipShown = $false
$script:allowExit = $false

function Hide-ToTray {
  $form.WindowState = 'Minimized'
  $form.Hide()
  $tray.Visible = $true
  if (-not $script:trayTipShown) {
    $script:trayTipShown = $true
    $tray.ShowBalloonTip(2000, 'PaperPilot 后台', '控制台已最小化到系统托盘继续运行，点击托盘图标恢复窗口。', 'Info')
  }
}

function Show-MainWindow {
  $form.Show()
  $form.WindowState = 'Normal'
  $form.Activate()
  $form.BringToFront()
  $tray.Visible = $false
}

function Exit-App {
  $script:allowExit = $true
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  $form.Close()
}

$miShow.add_Click({ Show-MainWindow })
$miStart.add_Click({
  $r = Start-Server
  Show-StartResult $r
  Update-All
})
$miStop.add_Click({
  [void](Stop-Server)
  Update-All
})
$miExit.add_Click({ Exit-App })

$tray.add_MouseClick({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-MainWindow }
})

# 关闭（X）= 最小化到托盘驻留；「退出程序」是唯一真正退出入口
$form.add_FormClosing({
  param($s, $e)
  if (-not $script:allowExit) {
    $e.Cancel = $true
    Hide-ToTray
  }
})

$form.add_Resize({
  if ($form.WindowState -eq 'Minimized') { Hide-ToTray }
})

$form.add_Shown({
  Update-All
  $btnStartup.Text = '开机自启：' + $(if (Get-StartupEnabled) { '开' } else { '关' })
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  try { Update-All } catch {}
})
$timer.Start()

[void][System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$form.Dispose()
try { $script:mutex.ReleaseMutex() } catch {}
