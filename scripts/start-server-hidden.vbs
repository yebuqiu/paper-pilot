' Papilot account backend server - hidden starter (no console window)
' starts node server\account-server.js with WorkingDirectory=server, logs to data\server-console.log
' note: cmd /c needs the whole command wrapped in an extra pair of quotes (same form as launcher.ps1 Start-Server)
' ASCII only. Used by launcher.ps1 auto-start (HKCU Run key) and can be double-clicked directly.
' v1 (2026-10-02): scan .workbuddy binaries for the newest node version instead of hardcoding
' v2 (2026-10-16): prefer project-local runtime\node\node.exe (portable, external-drive friendly)
Dim shell, fso, scriptDir, projectDir, serverDir, logDir, nodeExe, logFile, cmdLine
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
serverDir = projectDir & "\server"
logDir = serverDir & "\data"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

Function FindLatestNode(versionsDir)
    Dim f, bestPath, bestKey, name, parts, p2, k
    bestPath = ""
    bestKey = -1
    If Not fso.FolderExists(versionsDir) Then
        FindLatestNode = ""
        Exit Function
    End If
    For Each f In fso.GetFolder(versionsDir).SubFolders
        If fso.FileExists(f.Path & "\node.exe") Then
            name = f.Name
            parts = Split(name, ".")
            If UBound(parts) >= 2 Then
                p2 = Split(parts(2), "-")
                k = Val(parts(0)) * 1000000 + Val(parts(1)) * 1000 + Val(p2(0))
                If k > bestKey Then
                    bestKey = k
                    bestPath = f.Path & "\node.exe"
                End If
            End If
        End If
    Next
    FindLatestNode = bestPath
End Function

nodeExe = projectDir & "\runtime\node\node.exe"
If Not fso.FileExists(nodeExe) Then
    nodeExe = FindLatestNode("C:\Users\Administrator\.workbuddy\binaries\node\versions")
End If
If nodeExe = "" Then nodeExe = "node"
' stdout/stderr must NOT share server-console.log: cmd's >> holds an exclusive write
' handle there and Node's log() (appendFileSync) then fails silently (1.8.0 实测).
logFile = logDir & "\server-stdout.log"
cmdLine = "cmd /c " & """" & """" & nodeExe & """" & " account-server.js >> " & """" & logFile & """" & " 2>&1" & """"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = serverDir
shell.Run cmdLine, 0, False
