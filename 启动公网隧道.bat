@echo off
chcp 936 >nul
rem pp.xinglintools.top 公网通道 - 启动（项目内自包含：runtime\cloudflared 随移动硬盘走）
rem 幂等：已在运行时直接提示；会用 http2/IPv4、http2/IPv6、quic 依次尝试直到建连成功。

cd /d "%~dp0."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\tunnel\tunnel.ps1" start

echo.
pause
