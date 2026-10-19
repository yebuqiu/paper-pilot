# console-alive.ps1
# Is the launcher window actually pumping messages?
#
# A live process is NOT a working console: the UI thread can be blocked by a
# synchronous probe (see docs/启动控制台-卡死根因分析与治理-2026-10-18.md), and
# then every click / close / second launch looks like nothing happens.
#
# Exit codes (used by 启动Papilot后台.bat):
#   0 = window found and answered within 800ms
#   3 = window found but no answer (UI thread blocked)
#   4 = no window (not running, or still starting)
#
# ASCII only. PS 5.1 compatible. Read-only.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PpConsoleAlive {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(IntPtr lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam,
      IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
'@

$SMTO_ABORTIFHUNG = 0x0002
$WM_NULL = 0x0000

$hwnd = [PpConsoleAlive]::FindWindow([IntPtr]::Zero, 'Papilot 后台 · 控制台')
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output 'no-window'
  exit 4
}

$result = [IntPtr]::Zero
$rc = [PpConsoleAlive]::SendMessageTimeout($hwnd, $WM_NULL, [IntPtr]::Zero, [IntPtr]::Zero,
        $SMTO_ABORTIFHUNG, 800, [ref]$result)
if ($rc -eq [IntPtr]::Zero) {
  Write-Output 'hung'
  exit 3
}
Write-Output 'ok'
exit 0
