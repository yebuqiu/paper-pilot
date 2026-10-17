@echo off
chcp 936 >nul
rem PaperPilot 后台启动管理器 - 统一控制台（GUI）
rem 双击后无窗拉起 scripts\launcher.ps1（经临时 vbs 过渡，wscript 无窗口启动）。
rem 图形界面内完成：账号后台启停 / AI 模型通道增减切换实测 / 账号注册与列表
rem                 / 会员管理（订单核销开通、激活码生成作废、套餐与收款配置、用户开通续期）。
rem
rem 注意：本 bat 必须保存为 GBK/ANSI 编码（配合上面的 chcp 936），否则中文提示会乱码。
rem       改完请用 cmd 双击实测一次，确认无 "不是内部或外部命令" 类报错。

rem 前置检查 1：系统必须能找到 powershell（控制台是 WinForms 界面，需要 -STA 参数）
where powershell >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [错误] 未找到 powershell，无法启动控制台。
  echo   本项目需要 Windows PowerShell 5.1 或更高版本。
  echo.
  pause
  exit /b 1
)

rem 前置检查 2：启动脚本必须在位
if not exist "%~dp0scripts\launcher.ps1" (
  echo.
  echo   [错误] 未找到 scripts\launcher.ps1
  echo   请确认本 bat 位于项目根目录（与 scripts、server、chrome 同级）。
  echo.
  pause
  exit /b 1
)

rem 经临时 vbs 桥接实现「无黑框启动」：wscript 无窗口运行 powershell，
rem 隐藏窗口启动 launcher.ps1（launcher 自身负责托盘与单实例锁）。
set "tmpvbs=%TEMP%\paperpilot-launcher-bridge.vbs"
> "%tmpvbs%" echo Set s=CreateObject("Wscript.Shell"):s.Run "powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%~dp0scripts\launcher.ps1""",0,False
wscript.exe "%tmpvbs%"
set "rc=%ERRORLEVEL%"
del "%tmpvbs%" >nul 2>&1
if not "%rc%"=="0" goto :pp_fail

rem wscript 是异步的：返回 0 只代表「已提交」，不代表控制台真的起来了。
rem 用 launcher 写下的 PID + tasklist 做存活确认（最多等约 12 秒）。
for /l %%i in (1,1,12) do (
  call :pp_probe
  if defined ppok goto :pp_ready
  >nul "%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1
)
goto :pp_fail

:pp_probe
set "ppok="
set "pppid="
if exist "%TEMP%\paperpilot-launcher.pid" set /p pppid=<"%TEMP%\paperpilot-launcher.pid"
if not defined pppid exit /b 0
"%SystemRoot%\System32\tasklist.exe" /FI "PID eq %pppid%" /NH 2>nul | "%SystemRoot%\System32\find.exe" "%pppid%" >nul
if not errorlevel 1 set "ppok=1"
exit /b 0

:pp_ready
exit /b 0

:pp_fail
echo.
echo   [提示] 控制台没有启动成功（12 秒内未检测到运行中的控制台进程）。
echo   启动日志：%TEMP%\paperpilot-launcher-boot.log
echo   可把日志发给维护者；也可在本目录手工运行：
echo     powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1"
echo.
pause
exit /b 2
