@echo off
REM ======================================================================
REM  MSCMS v14 autostart - SINGLE AUTHORITATIVE ENTRY POINT (2026-09-15)
REM ----------------------------------------------------------------------
REM  Why this file exists (verified incident, do not "simplify" it back):
REM
REM  Previous chain was:
REM    Startup folder .cmd
REM      -> powershell -NoProfile -File _start_services.ps1
REM        -> ProcessStartInfo(cmd.exe) -> node/mysqld children
REM
REM  After the 2026-09-15 17:08 reboot that chain failed completely:
REM    - startup.log recorded "starting MySQL" / "starting watchdog" /
REM      "starting 3002/3005/3010"
REM    - but NONE of the 7 children ever created a log file,
REM      none bound a port, and every one of them vanished.
REM    - Result: the whole stack (3002/3005/3010/3011/3012/3013/8080,
REM      MySQL 3307, exit layer 20779/20880/202xx, cloudflared) stayed DEAD.
REM
REM  Meanwhile molie-mirror on the SAME machine, started from the SAME
REM  Startup folder but with a plain .bat + "start /min" (no powershell
REM  anywhere in the chain), came up fine and is still alive.
REM
REM  Conclusion: do NOT route MSCMS autostart through powershell on this
REM  box. Keep the chain: logon/.bat -> start /min -> node.
REM
REM  Idempotent: every step is guarded by a TCP LISTENING check, so this
REM  file is safe to run at logon AND from a repeating scheduled task.
REM  ASCII only on purpose - cmd.exe garbles non-ASCII inside .bat files.
REM ======================================================================

setlocal
set "WS=C:\Users\AS\WorkBuddy\2026-06-13-19-42-19"
set "VDIR=C:\Users\AS\\binaries\node\versions"
set "STORAGE=D:\mscms-ws"
set "LOGDIR=%STORAGE%\logs"
set "LOG=%LOGDIR%\autostart.log"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
if not exist "D:\mscms-tmp" mkdir "D:\mscms-tmp" >nul 2>&1

call :log "=== autostart invoked (pid of this cmd: %random%) ==="

REM ---------------------------------------------------------------
REM  1) resolve the newest existing node.exe. NEVER hardcode a
REM     version directory: 22.22.2-2 was deleted by a managed-node
REM     upgrade and that single line silently killed the whole stack
REM     (ENOENT -> uncaughtException -> watchdog dead -> exit layer dead).
REM     dir /o-d sorts by date desc, so we always pick the newest install.
REM ---------------------------------------------------------------
set "NODE="
for /f "delims=" %%d in ('dir /b /ad /o-d "%VDIR%" 2^>nul') do (
  if not defined NODE if exist "%VDIR%\%%d\node.exe" set "NODE=%VDIR%\%%d\node.exe"
)
if not defined NODE (
  call :log "FATAL: no node.exe found under %VDIR% - abort"
  exit /b 1
)
call :log "node = %NODE%"

REM ---------------------------------------------------------------
REM  2) shared environment. All writes go to D: (C: hit 98% full and
REM     caused DataStore ENOSPC). The watchdog also re-declares these
REM     in BASE_ENV; setting them here keeps every child consistent.
REM ---------------------------------------------------------------
set "ELECTRON_RUN_AS_NODE="
set "NODE_TLS_REJECT_UNAUTHORIZED=0"
set "NODE_PATH=%WS%\node_modules"
set "MSCMS_STORAGE_ROOT=%STORAGE%"
set "DATA_DIR=%STORAGE%\data"
set "LOG_DIR=%LOGDIR%"
set "MSCMS_TMP_DIR=D:\mscms-tmp"
set "TEMP=D:\mscms-tmp"
set "TMP=D:\mscms-tmp"

REM ---------------------------------------------------------------
REM  3) MySQL 3307 - the Tumblr 24h (account,content) dedup gate.
REM     It is NOT managed by the watchdog's own spawn list in all
REM     builds, so it is started explicitly here, first, because the
REM     3002 publisher needs it as soon as it boots.
REM     No --console: let mysqld write its own .err inside datadir.
REM ---------------------------------------------------------------
call :isup 3307
if errorlevel 1 (
  call :log "3307 down -> starting mysqld"
  start "mscms-mysql" /min /d "%WS%\mysql-8.0.41-winx64" "%WS%\mysql-8.0.41-winx64\bin\mysqld.exe" --basedir="%WS%\mysql-8.0.41-winx64" --datadir="D:/mscms-mysql-data" --port=3307
) else (
  call :log "3307 already LISTENING -> skip mysqld"
)

REM ---------------------------------------------------------------
REM  4) watchdog - the single owner of every other service
REM     (3002/3005/3010/3012/3013/8080/exitguard/202xx exit layer).
REM     It holds :3011 as its single-instance lock.
REM     The watchdog writes its own watchdog.log, so no redirect needed.
REM ---------------------------------------------------------------
call :isup 3011
if errorlevel 1 (
  call :log "3011 down -> starting mscms-watchdog.js"
  REM MSCMS_SILENT=1 is set by mscms-start.vbs, which runs this file inside a
  REM HIDDEN cmd. In that case /B makes the child inherit the hidden console,
  REM so no window shows up at all. Without the flag we keep the historical
  REM /min behaviour (visible window) for manual runs.
  if defined MSCMS_SILENT (
    start "mscms-watchdog" /B /d "%WS%" "%NODE%" "%WS%\tools\mscms-watchdog.js"
  ) else (
    start "mscms-watchdog" /min /d "%WS%" "%NODE%" "%WS%\tools\mscms-watchdog.js"
  )
) else (
  call :log "3011 already LISTENING -> skip watchdog"
)

REM ---------------------------------------------------------------
REM  5) fallback: if the watchdog did not claim :3011 within ~30s,
REM     start the three core services directly so the business is not
REM     left without a publisher. The repeating scheduled task will
REM     retry the watchdog on its next tick.
REM ---------------------------------------------------------------
set /a TRIES=0
:waitwd
call :isup 3011
if not errorlevel 1 goto wdok
set /a TRIES+=1
if %TRIES% GEQ 10 goto wdfail
ping -n 4  >nul 2>&1
goto waitwd

:wdok
call :log "watchdog took :3011 - it owns the rest"
exit /b 0

:wdfail
call :log "WARN: watchdog did not take :3011 in 30s -> direct fallback launch"
call :isup 3002
if errorlevel 1 (
  call :log "starting 3002 directly"
  start "mscms-3002" /min /d "%WS%" cmd /c "set CLOUD_PHONE_COUNT=50&& set CLOUD_PHONE_MODE=cloud&& set PUBLIC_DOMAIN=hlua.cc.cd&& set PORT=3002&& set TUMBLR_API_RPM=25&& "%NODE%" "%WS%\server.js" >> "%LOGDIR%\server-3002.log" 2>&1"
)
call :isup 3005
if errorlevel 1 (
  call :log "starting 3005 directly"
  start "mscms-3005" /min /d "%WS%" cmd /c "set TUMBLR_NURTURE_PORT=3005&& set TUMBLR_NURTURE_DEVICE=1&& set TUMBLR_NURTURE_AUTO=1&& set TUMBLR_PROXY=http://:10808&& set TUMBLR_API_RPM=25&& "%NODE%" "%WS%\tumblr-nurture-server.js" >> "%LOGDIR%\nurture-3005.log" 2>&1"
)
call :isup 3010
if errorlevel 1 (
  call :log "starting 3010 directly"
  start "mscms-3010" /min /d "%WS%" cmd /c "set CONTENT_GEN_PORT=3010&& "%NODE%" "%WS%\content-gen\service.js" >> "%LOGDIR%\contentgen-3010.log" 2>&1"
)
call :log "=== autostart done (fallback path) ==="
exit /b 0

REM ---------------------------------------------------------------
:isup
REM  returns 0 if a LISTENING socket exists on port %1, else 1
netstat -ano | findstr /c:":%1 " | findstr /i "LISTENING" >nul 2>&1
if errorlevel 1 (exit /b 1) else (exit /b 0)

:log
REM  %date% under zh-CN renders as "2026/09/15 <weekday>" and the weekday
REM  is written as GBK bytes -> mojibake in an otherwise ASCII log.
REM  ~0,10 keeps just the numeric date, which is pure ASCII.
set "DT=%date%"
>> "%LOG%" echo [%DT:~0,10% %time%] %~1
exit /b 0
