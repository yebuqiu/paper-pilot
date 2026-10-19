' Papilot 后台控制台 - 零黑框启动器（双击本文件，不出现任何 cmd 黑框）
' 与 启动Papilot后台.bat 等效：都经 wscript 无窗拉起 scripts\launcher.ps1
' 差别：本文件由 wscript 直接解释，全程不创建 cmd 控制台，所以不会闪黑框。
Option Explicit
Dim sh, fso, here, ps1
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = here & "\scripts\launcher.ps1"
If Not fso.FileExists(ps1) Then
  MsgBox "未找到 scripts\launcher.ps1。" & vbCrLf & vbCrLf & _
         "请确认本文件与 scripts、server 目录位于同一项目根目录。", 16, "Papilot 后台"
  WScript.Quit 1
End If
sh.CurrentDirectory = here
' intWindowStyle 0 = 不显示窗口；bWaitOnReturn False = 立即返回
sh.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
