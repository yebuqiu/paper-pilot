' cloudflared-run-papilot hidden launcher (no console window, style 0)
' Purpose: start the project-local papilot tunnel without flashing a console.
' Used by optional autostart / watchdog setups; the launcher GUI and
' scripts\tunnel\tunnel.ps1 do NOT need this file (they start the bat hidden).
' Keep this file pure ASCII: wscript reads .vbs as the system ANSI codepage.

Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd.exe /c " & """" & dir & "\cloudflared-run-papilot.bat" & """", 0, False
