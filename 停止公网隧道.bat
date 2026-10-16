@echo off
chcp 936 >nul
rem pp.xinglintools.top 公网通道 - 停止（只停本隧道，不影响同机其他 cloudflared 隧道）

cd /d "%~dp0."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\tunnel\tunnel.ps1" stop

echo.
pause
