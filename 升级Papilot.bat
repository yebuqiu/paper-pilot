@echo off
chcp 936 >nul
setlocal
set "SRC=%~dp0dist\papilot-0.19.0.xpi"
set "DST=%APPDATA%\Zotero\Zotero\Profiles\swc79sqh.default\extensions\papilot@dev.local.xpi"

copy /Y "%SRC%" "%DST%" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [失败] 插件文件被占用，说明 Zotero 还在运行。
  echo   请完全退出 Zotero（含右下角托盘图标）后再双击本脚本。
  echo.
  pause
  exit /b 1
)
echo.
echo   [成功] Papilot 已更新到 0.19.0（主题视觉重做 + 在线美图）。
echo   现在打开 Zotero 即可看到新主题库。
echo.
pause
