@echo off
setlocal EnableExtensions EnableDelayedExpansion
title OYours P0 Admin Apply
echo ================================================================
echo   OYours / MSCMS v14  --  P0 admin apply   [run as ADMIN]
echo ----------------------------------------------------------------
echo   Step 1  Defender exclusions
echo           - MsMpEng was measured at 416 percent CPU, a major
echo             contributor to the periodic 3002 stalls.
echo   Step 2  Reload the WATCHDOG process  :3011
echo           activates committed fixes:
echo             a. zombie absolute limit -- failStreak no longer
echo                resets forever, so a log-alive but hung
echo                service can now self-heal
echo             b. startup syntax self-check -- no restart storms
echo   Step 3  Flush datastore, then restart :3002
echo           - 3002 RSS reached 4007 MB. Node default heap cap on a
echo             16 GB box is about 4 GB, so it was pinned at the
echo             ceiling: long full-GC pauses look like HTTP 0, and the
echo             RSS starved the whole machine. A flush-then-restart
echo             reclaims about 4 GB and applies the new heap cap
echo             --max-old-space-size=3072.
echo           - graceful POST /api/v14/datastore/flush runs first so
echo             the in-memory DataStore is written to disk.
echo   Step 4  Restart relay :10809
echo           - loads the direct-bypass whitelist that stops
echo             system/IDE background noise from eating the
echo             BrightData upstream slots.
echo   Step 5  Restart exit-guard :20779   [ADDED 2026-10-12]
echo           - the committed exit-guard change moves the health
echo             probe off BrightData onto a direct-connect host.
echo             Without this step port 20779 keeps running the OLD
echo             code and the acceptance check can never pass.
echo           - the watchdog alone does NOT restart :20779, because
echo             its port stays open, so the supervisor sees it as
echo             healthy and never relaunches it. It must be killed.
echo   Step 6  Post-flight verification  _p0_verify.ps1
echo           - read-only, machine-checked, prints PASS/FAIL for
echo             every fix and exits with the number of failures.
echo ----------------------------------------------------------------
echo   NOTE: no step uses taskkill /T. Services NOT listed above are
echo         never killed, so no 12 to 15 minute cold start is
echo         triggered for them. WinSW restarts the watchdog within
echo         about 10 to 20 s.
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

echo [1/6] Adding Defender exclusions ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath 'D:\mscms-ws','D:\mscms-content','D:\MSCMS-Desktop','D:\OYours-recovery','C:\Users\AS\WorkBuddy' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess 'node.exe' -ErrorAction SilentlyContinue; Write-Host '      ok'"
echo.

echo [2/6] Reloading watchdog process :3011 ...
call :KILLPORT 3011
echo       waiting 20s for the WinSW auto-restart ...
call :SLEEP 20
net start mscms-watchdog 2>nul
echo       waiting for :3011 to come back ...
call :WAITPORT 3011 24
echo.

echo [3/6] Flushing datastore, then restarting :3002 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/v14/datastore/flush' -TimeoutSec 60; Write-Host ('      flush -> ' + ($r | ConvertTo-Json -Compress)) } catch { Write-Host ('      flush failed: ' + $_.Exception.Message) }"
echo       waiting 8s for the disk write ...
call :SLEEP 8
call :KILLPORT 3002
echo       waiting for the watchdog to relaunch :3002 ...
call :WAITPORT 3002 180
echo.

echo [4/6] Restarting relay :10809 ...
call :KILLPORT 10809
echo       waiting for the watchdog to relaunch the relay ...
call :WAITPORT 10809 40
echo.

echo [5/6] Restarting exit-guard :20779 ...
call :KILLPORT 20779
echo       waiting for the watchdog to relaunch exit-guard ...
call :WAITPORT 20779 40
echo.

echo [6/6] Post-flight verification ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_p0_verify.ps1"
set "_VF=!ERRORLEVEL!"
echo.
echo       verification exit code = !_VF!   [0 = all checks passed]
echo.
echo ================================================================
echo   Remaining manual note:
echo     - 3002 needs 12 to 15 minutes to finish booting. If the
echo       verify script reports :3002 as unhealthy right after this
echo       script finishes, just re-run _p0_verify.ps1 a few minutes
echo       later -- no admin needed for that.
echo     - Verification is read-only and safe to run any time.
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
  echo       killing port !_KP! pid=!_PID!   [no /T, unrelated children stay up]
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

:WAITPORT
set "_WP=%~1"
set "_WN=%~2"
:WPLOOP
set "_WPF="
for /f "tokens=5" %%a in ('netstat -ano -p TCP ^| findstr ":%_WP% " ^| findstr LISTENING') do set "_WPF=%%a"
if defined _WPF (
  echo       port %_WP% LISTENING pid=!_WPF!
  exit /b 0
)
set /a _WN-=1
if !_WN! leq 0 (
  echo       port %_WP%  *** STILL NOT LISTENING after the wait ***
  exit /b 1
)
call :SLEEP 5
goto WPLOOP

:SLEEP
ping -n %1 127.0.0.1 >nul
exit /b 0
