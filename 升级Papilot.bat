@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

rem 装 dist 里最新的 Papilot xpi 到本机 Zotero（版本号/ profile 全自动，别再写死）
rem 原来这里写死了 papilot-0.19.0.xpi 和 swc79sqh.default —— 双击等于降级或直接失败。
python scripts\install-xpi.py %*
if errorlevel 1 (
  echo.
  echo   [失败] 见上面的原因。Zotero 必须完全退出后再试。
  pause
  exit /b 1
)
echo.
pause
