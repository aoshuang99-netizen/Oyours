@echo off
setlocal EnableExtensions EnableDelayedExpansion
title MSCMS P0 Admin Apply
echo ================================================================
echo   OYours / MSCMS v14  --  P0 admin apply   [run as ADMIN]
echo ----------------------------------------------------------------
echo   Step 1  Defender exclusions
echo           - MsMpEng was measured at 416 percent CPU, a major
echo             contributor to the periodic 3002 stalls.
echo   Step 2  Reload the WATCHDOG process  :3011
echo           activates committed fixes:
echo             a) zombie absolute limit   failStreak no longer
echo                resets forever, so a "log-alive but hung"
echo                service can now self-heal
echo             b) startup syntax self-check  no restart storms
echo             c) exit-guard probe target decoupled from BrightData
echo             d) NEW  --max-old-space-size=3072  for :3002
echo   Step 3  Flush datastore, then restart :3002
echo           - 3002 RSS reached 4007 MB. Node default heap cap on a
echo             16 GB box is about 4 GB, so it was pinned at the
echo             ceiling: long full-GC pauses look like HTTP 0, and the
echo             RSS starved the whole machine. A flush-then-restart
echo             reclaims about 4 GB and applies the new heap cap.
echo           - graceful POST /api/v14/datastore/flush runs first so
echo             the in-memory DataStore is written to disk.
echo   Step 4  Restart relay :10809
echo           - loads the direct-bypass whitelist that stops
echo             system/IDE background noise from eating the
echo             BrightData upstream slots.
echo ----------------------------------------------------------------
echo   NOTE: no step uses taskkill /T. Children of the watchdog
echo         (3002 / 3005 / 3010 ...) are never killed as a tree,
echo         so a 12 to 15 minute cold start is avoided.
echo         WinSW restarts the watchdog within about 10 to 20 s.
echo ================================================================
echo.
net session >nul 2>&1
if not errorlevel 1 goto PRIVOK
fltmc >nul 2>&1
if not errorlevel 1 goto PRIVOK
goto NOPRIV
:PRIVOK
echo [OK] Administrator confirmed.
echo.

echo [1/4] Adding Defender exclusions ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath 'D:\mscms-ws','D:\mscms-content','D:\MSCMS-Desktop','D:\OYours-recovery','C:\Users\AS\WorkBuddy' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess 'node.exe' -ErrorAction SilentlyContinue; Write-Host '      ok'"
echo.

echo [2/4] Reloading watchdog process :3011 ...
call :KILLPORT 3011
echo       waiting 20s for the WinSW auto-restart ...
call :SLEEP 20
net start mscms-watchdog 2>nul
call :SLEEP 6
call :SHOWPORT 3011
echo.

echo [3/4] Flushing datastore, then restarting :3002 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/v14/datastore/flush' -TimeoutSec 60; Write-Host ('      flush -> ' + ($r | ConvertTo-Json -Compress)) } catch { Write-Host ('      flush failed: ' + $_.Exception.Message) }"
echo       waiting 8s for the disk write ...
call :SLEEP 8
call :KILLPORT 3002
echo       waiting 25s for the watchdog to relaunch 3002 ...
call :SLEEP 25
call :SHOWPORT 3002
echo.

echo [4/4] Restarting relay :10809 ...
call :KILLPORT 10809
echo       waiting 20s for exit-guard to relaunch the relay ...
call :SLEEP 20
call :SHOWPORT 10809
echo.

echo ================================================================
echo   DONE.  Verify:
echo     port 3011 LISTENING   = watchdog alive with new code
echo     port 3002 LISTENING   = main service alive
echo     port 10809 LISTENING  = relay alive with the new whitelist
echo     http://127.0.0.1:20779/health   probeTarget = www.qq.com:443
echo ================================================================
pause
exit /b 0

:NOPRIV
echo [X] NOT running as Administrator.
echo     Right-click this file and choose "Run as administrator".
pause
exit /b 1

:KILLPORT
set "_KP=%~1"
set "_PID="
for /f "tokens=5" %%a in ('netstat -ano -p TCP ^| findstr ":!_KP! " ^| findstr LISTENING') do set "_PID=%%a"
if defined _PID (
  echo       killing port !_KP! pid=!_PID!   [no /T, children stay up]
  taskkill /F /PID !_PID! >nul 2>&1
) else (
  echo       port !_KP! not listening - skipped
)
exit /b 0

:SHOWPORT
set "_SP="
for /f "tokens=5" %%a in ('netstat -ano -p TCP ^| findstr ":%~1 " ^| findstr LISTENING') do set "_SP=%%a"
if defined _SP (
  echo       port %~1 LISTENING pid=!_SP!
) else (
  echo       port %~1  *** NOT LISTENING ***
)
exit /b 0

:SLEEP
ping -n %1 127.0.0.1 >nul
exit /b 0
