# guard-paperpilot.ps1
# Watchdog for the PaperPilot account backend + public tunnel on this host.
# Optional: register as scheduled task "PaperPilotGuard" (once per machine,
# no elevation needed - the services run in the user session).
#
#   pass 1: account server (127.0.0.1:8000, node account-server.js)
#           -> resurrect via scripts/start-account-server.ps1 (idempotent).
#              Honors server/data/stopped-account.flag (set by launcher
#              "stop" button / manual stop) - a flagged stop stays stopped.
#   pass 2: paperpilot tunnel (metrics 127.0.0.1:20250, pp.xinglintools.top
#           -> 127.0.0.1:8000) -> resurrect via the project-local toolkit
#           runtime/cloudflared/ (cloudflared.exe + token.txt).
#              Honors runtime/cloudflared/stopped.flag if present.
#
# Idempotent: each pass is a silent no-op while its endpoint answers.
# Tunnel health = HTTP /ready with readyConnections > 0 (a squatted metrics
# port can no longer mask a dead connector - port-open != healthy).
# A tunnel process younger than 90s is given time to finish connecting
# before any restart (avoids a kill/restart loop during slow edge connects).
# Log: server/data/guard.log (rotated at 2MB).
#
# 2026-10-16: rewritten for the portable layout - all dependencies now live
# in the project folder (runtime/), no more ~/.cloudflared or _brain vault
# references (the old chain broke as soon as the project moved to the
# external drive; public endpoint was down with a 530).
#
# PS 5.1 compatible. English output only (runs from a scheduled task).

$ErrorActionPreference = "Continue"

$scriptDir  = $PSScriptRoot
$projectDir = Split-Path -Parent $scriptDir
$serverDir  = Join-Path $projectDir "server"
$dataDir    = Join-Path $serverDir "data"
$logFile    = Join-Path $dataDir "guard.log"
$cfDir      = Join-Path $projectDir "runtime\cloudflared"
$cfExe      = Join-Path $cfDir "cloudflared.exe"
$cfToken    = Join-Path $cfDir "token.txt"
$cfStopFlag = Join-Path $cfDir "stopped.flag"

function Write-Log {
    param([string]$Msg)
    try {
        if (!(Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
        if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 2MB) {
            Remove-Item $logFile -Force -ErrorAction SilentlyContinue
        }
        Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg) -Encoding UTF8
    } catch {}
}

function Test-Port {
    param([int]$Port, [int]$TimeoutMs = 2000)
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { $c.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { if ($c) { try { $c.Close() } catch {} } }
}

function Test-TunnelReady {
    # readyConnections > 0 on the metrics endpoint; 3s cap so a hung
    # connector cannot stall the whole guard run.
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:20250/ready" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return ([int](($r.Content | ConvertFrom-Json).readyConnections) -gt 0)
    } catch { return $false }
}

function Get-TunnelProcs {
    try {
        $list = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop
        return ,@($list | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('20250') -ge 0 })
    } catch { return ,@() }
}

function Find-Node {
    # 1) project-local runtime (portable, first choice)
    $local = Join-Path $projectDir "runtime\node\node.exe"
    if (Test-Path $local) { return $local }
    # 2) managed runtimes - newest version
    $base = "C:\Users\Administrator\.workbuddy\binaries\node\versions"
    if (Test-Path $base) {
        $best = $null; $bestKey = -1
        Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $exe = Join-Path $_.FullName "node.exe"
            if (Test-Path $exe) {
                $parts = $_.Name.Split(".")
                if ($parts.Count -ge 3) {
                    $p2 = $parts[2].Split("-")
                    $k = [double]$parts[0] * 1000000 + [double]$parts[1] * 1000 + [double]$p2[0]
                    if ($k -gt $bestKey) { $bestKey = $k; $best = $exe }
                }
            }
        }
        if ($best) { return $best }
    }
    # 3) PATH
    return "node"
}

# ---------- pass 1: account server (8000) ----------
try {
    if (Test-Port 8000) {
        # healthy - silent no-op
    } elseif (Test-Path (Join-Path $dataDir "stopped-account.flag")) {
        # intentionally stopped - leave it down (launcher Start clears the flag)
    } else {
        Write-Log "account server (8000) down, resurrecting..."
        $nodeExe = Find-Node
        if (!(Test-Path $nodeExe) -and $nodeExe -ne "node") {
            Write-Log "FATAL: node.exe not found"
        } else {
            # raw Process.Start on node.exe - no cmd.exe quoting games, no stdio
            # redirection needed (the server writes its own log file since v1.2)
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $nodeExe
            $psi.Arguments = "account-server.js"
            $psi.WorkingDirectory = $serverDir
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            [void][System.Diagnostics.Process]::Start($psi)
            Start-Sleep -Seconds 25
            if (Test-Port 8000) { Write-Log "account server back up" }
            else { Write-Log "FATAL: account server did not come up (see server-console.log)" }
        }
    }
} catch { Write-Log ("pass1 error: " + $_.Exception.Message) }

# ---------- pass 2: paperpilot tunnel (metrics 20250) ----------
try {
    if (Test-TunnelReady) {
        # healthy - silent no-op
    } elseif (Test-Path $cfStopFlag) {
        # intentionally stopped (delete the flag to resume guarding)
    } else {
        $procs = Get-TunnelProcs
        $young = $false
        foreach ($p in $procs) {
            try {
                $started = (Get-Process -Id $p.ProcessId -ErrorAction Stop).StartTime
                if (((Get-Date) - $started).TotalSeconds -lt 90) { $young = $true }
            } catch {}
        }
        if ($young) {
            # edge connect window - silent, re-check next minute
        } else {
            if ($procs.Count -gt 0) {
                Write-Log "paperpilot tunnel (20250) not ready, replacing stale process..."
                foreach ($p in $procs) {
                    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
                }
                Start-Sleep -Seconds 2
            } else {
                Write-Log "paperpilot tunnel (20250) down, resurrecting..."
            }
            if ((Test-Path $cfExe) -and (Test-Path $cfToken)) {
                $psi = New-Object System.Diagnostics.ProcessStartInfo
                $psi.FileName = $cfExe
                $psi.Arguments = 'tunnel --protocol http2 --edge-ip-version 4 --metrics 127.0.0.1:20250 --no-autoupdate run --token-file token.txt'
                $psi.WorkingDirectory = $cfDir
                $psi.UseShellExecute = $false
                $psi.CreateNoWindow = $true
                [void][System.Diagnostics.Process]::Start($psi)
                Start-Sleep -Seconds 20
                if (Test-TunnelReady) { Write-Log "paperpilot tunnel back up" }
                else { Write-Log "tunnel process started but not edge-ready yet (see runtime\cloudflared\logs)" }
            } else {
                Write-Log "FATAL: cloudflared.exe or token.txt missing in runtime\cloudflared"
            }
        }
    }
} catch { Write-Log ("pass2 error: " + $_.Exception.Message) }
