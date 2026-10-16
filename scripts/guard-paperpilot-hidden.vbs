' guard-paperpilot hidden launcher (no console window, style 0)
' Purpose: the "PaperPilotGuard" scheduled task runs every minute. Invoking
' powershell.exe directly from Task Scheduler (even with the task "hidden")
' still flashes a console window once per minute on the interactive desktop.
' Root cause observed 2026-10-05: task Settings.Hidden was unset -> a visible
' console was created each run. This launcher runs the same guard script with
' window style 0 (fully hidden), so nothing appears on screen.
'
' Keep this file pure ASCII: wscript reads .vbs as the system ANSI codepage.
' The guard script itself is unchanged (guard-paperpilot.ps1).

Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & """" & dir & "\guard-paperpilot.ps1" & """", 0, False
