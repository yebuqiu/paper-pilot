@echo off
rem ============================================================
rem  pp.xinglintools.top tunnel runner  (project-local / portable)
rem  usage : cloudflared-run-paperpilot.bat [protocol] [edge-ip-version]
rem          default: http2  4
rem  token : read from token.txt via --token-file (never on the command line)
rem  log   : logs\cf-run-paperpilot.log  (rotated when > 20 MB)
rem  note  : single run; exit code mirrors cloudflared's. No auto-restart.
rem ============================================================
setlocal
set "CFDIR=%~dp0."
set "PROTO=%~1"
set "EDGE=%~2"
if "%PROTO%"=="" set "PROTO=http2"
if "%EDGE%"=="" set "EDGE=4"
cd /d "%CFDIR%"
if not exist "logs" mkdir "logs"
set "LOG=%CFDIR%\logs\cf-run-paperpilot.log"

if not exist "cloudflared.exe" (
  call :log "FATAL: cloudflared.exe not found in %CFDIR%"
  exit /b 1
)
if not exist "token.txt" (
  call :log "FATAL: token.txt missing - run scripts\tunnel\refresh-token.ps1 first"
  exit /b 1
)

if exist "%LOG%" (
  for %%F in ("%LOG%") do if %%~zF GTR 20000000 del "%LOG%"
)

call :log "start tunnel protocol=%PROTO% edge=%EDGE% metrics=127.0.0.1:20250"
"cloudflared.exe" tunnel --no-autoupdate --protocol %PROTO% --edge-ip-version %EDGE% --metrics 127.0.0.1:20250 run --token-file "token.txt" >> "%LOG%" 2>&1
set "EC=%errorlevel%"
call :log "cloudflared exited code=%EC%"
exit /b %EC%

:log
echo [%date% %time%] %~1
echo [%date% %time%] %~1 >> "%LOG%"
exit /b 0
