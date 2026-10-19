# start-account-server.ps1
# Orphan-spawn the Papilot account backend (node account-server.js) via raw
# System.Diagnostics.Process so the server survives this launcher and any
# sandbox session (sandbox-hosted background processes get silently reaped).
# Equivalent to start-server-hidden.vbs but usable from automation contexts
# where wscript is blocked. Idempotent: exits when 127.0.0.1:8000 answers.
# PS 5.1 compatible. English output only. ASCII only.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File start-account-server.ps1

$ErrorActionPreference = "Stop"

$scriptDir  = $PSScriptRoot
$projectDir = Split-Path -Parent $scriptDir
$serverDir  = Join-Path $projectDir "server"
$serverJs   = Join-Path $serverDir "account-server.js"
$logDir     = Join-Path $serverDir "data"
# stdout/stderr 走独立文件：cmd 的 >> 会独占写句柄，若指向 server-console.log
# 会让 Node 自己的 log()（appendFileSync）静默失败（1.8.0 实测）。
$logFile    = Join-Path $logDir  "server-stdout.log"

if (!(Test-Path $serverJs)) { Write-Output "FATAL: account-server.js missing at $serverJs"; exit 1 }
if (!(Test-Path $logDir))   { New-Item -ItemType Directory -Path $logDir | Out-Null }

# clear the manual-stop marker: invoking this script means the user wants the server up
# (PapilotGuard honors the marker and would otherwise resurrect a stopped server)
Remove-Item (Join-Path $logDir "stopped-account.flag") -Force -ErrorAction SilentlyContinue

# locate node.exe: project-local runtime first (portable), then newest
# managed runtime version, else PATH
function Find-LatestNode {
    $local = Join-Path $projectDir "runtime\node\node.exe"
    if (Test-Path $local) { return $local }
    $base = "C:\Users\Administrator\.workbuddy\binaries\node\versions"
    if (Test-Path $base) {
        $best = $null; $bestKey = -1
        Get-ChildItem $base -Directory | ForEach-Object {
            $exe = Join-Path $_.FullName "node.exe"
            if (Test-Path $exe) {
                $parts = $_.Name.Split(".")
                $p2 = $parts[2].Split("-")
                $k = [double]$parts[0] * 1000000 + [double]$parts[1] * 1000 + [double]$p2[0]
                if ($k -gt $bestKey) { $bestKey = $k; $best = $exe }
            }
        }
        if ($best) { return $best }
    }
    return "node"
}

function Test-ServerPort {
    param([int]$TimeoutMs = 1200)
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", 8000, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { $c.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { if ($c) { try { $c.Close() } catch {} } }
}

if (Test-ServerPort) {
    Write-Output "account server already up (127.0.0.1:8000 answering); nothing to do"
    exit 0
}

$nodeExe = Find-LatestNode
# cmd /c needs the whole command wrapped in an extra pair of quotes (same form as vbs/launcher)
# 2026-10-16 fix: previous form built 'cmd /c ...' then Substring("cmd /c ".Length) --
# that STRIPPED the /c switch, cmd.exe hung on an interactive prompt with the command
# as an argument and node never started (silent: port stayed down, log untouched).
$cmdArgs = '/c ""' + $nodeExe + '" account-server.js >> "' + $logFile + '" 2>&1"'

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = $cmdArgs
    $psi.WorkingDirectory = $serverDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    Write-Output ("spawned PID " + $proc.Id)
} catch {
    Write-Output ("FATAL: spawn failed: " + $_.Exception.Message)
    exit 1
}

# external-drive cold start is slow (runtime node first-read + AV scan): allow 30s
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ServerPort) { $ok = $true; break }
}
if ($ok) { Write-Output "account server is up on 127.0.0.1:8000" }
else     { Write-Output "FATAL: 8000 not answering after 30s (see $logFile)"; exit 2 }
