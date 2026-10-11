@echo off
setlocal
echo ================================================================
echo   OYours / MSCMS v14  --  P0 admin apply   [run as ADMIN]
echo ----------------------------------------------------------------
echo   Step 1  Defender exclusions
echo           - MsMpEng was measured at 416 percent CPU and is the
echo             main cause of the periodic 3002 stalls.
echo   Step 2  Reload the WATCHDOG process
echo           - activates 3 already-committed fixes:
echo             a) fatal-stall self-heal  zombie absolute limit
echo             b) startup syntax self-check  no restart storms
echo             c) exit-guard probe target decoupled from BrightData
echo ----------------------------------------------------------------
echo   NOTE: Step 2 kills ONLY the watchdog process itself, NOT the
echo         service tree. All running services stay up.
echo         WinSW restarts it automatically within about 10-20s.
echo ================================================================
echo.
echo [1/2] Adding Defender exclusions ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath 'D:\mscms-ws','D:\mscms-content','D:\MSCMS-Desktop','D:\OYours-recovery','C:\Users\AS\WorkBuddy' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess 'node.exe' -ErrorAction SilentlyContinue; Write-Host '      ok'"
echo.
echo [2/2] Reloading watchdog process ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 3011 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Write-Host ('      killing watchdog pid ' + $c.OwningProcess); Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } else { Write-Host '      no listener on :3011' }"
echo      waiting 20s for the WinSW auto-restart ...
timeout /t 20 /nobreak >nul
net start mscms-watchdog 2>nul
timeout /t 6 /nobreak >nul
echo.
echo ---- verify 1: watchdog listener on :3011 ----
netstat -ano | findstr ":3011 " | findstr LISTENING
echo.
echo ---- verify 2: exit-guard probe target ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:20779/health'; Write-Host ('      probeTarget = ' + $r.probeTarget) } catch { Write-Host '      exit-guard not reachable yet - wait 1 min and recheck' }"
echo.
echo Expected result:
echo    - a LISTENING line for :3011
echo    - probeTarget = www.qq.com:443
echo.
echo If probeTarget still shows api.tumblr.com:443, the service did not
echo restart. Run: net stop mscms-watchdog  then  net start mscms-watchdog
echo.
pause
