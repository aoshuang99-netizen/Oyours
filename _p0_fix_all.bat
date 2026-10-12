@echo off
setlocal EnableExtensions
title OYours P0 FIX-ALL (auto-elevating)
echo ================================================================
echo   OYours / MSCMS v14  --  P0 FIX-ALL  (single click)
echo ----------------------------------------------------------------
echo   This launcher needs administrator rights. It will ask for
echo   them through ONE UAC prompt, then re-run itself elevated and
echo   hand over to _p0_admin_apply.bat (6 steps), which ends by
echo   running _p0_verify.ps1.
echo.
echo   Nothing here touches the network path itself. Latest change
echo   carried by that run:
echo     - http-client.js  agent cache bounded to an LRU of 24 and
echo       released (close + hard destroy). That unbounded cache is
echo       the real cause of the 3002 RSS climb to 4 GB.
echo ================================================================
echo.

net session >nul 2>&1
if not errorlevel 1 goto ELEVATED
fltmc >nul 2>&1
if not errorlevel 1 goto ELEVATED

echo [..] Not elevated yet -- requesting administrator rights.
echo      A UAC dialog will appear. Click YES to continue.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
if errorlevel 1 (
  echo [X] Elevation request failed or was declined.
  echo     Fallback: right-click _p0_admin_apply.bat and pick
  echo     "Run as administrator".
  pause
  exit /b 1
)
echo [OK] Elevated instance launched. This window can be closed.
exit /b 0

:ELEVATED
echo [OK] Running with administrator rights.
echo.
call "%~dp0_p0_admin_apply.bat"
set "_RC=%ERRORLEVEL%"
echo.
echo ================================================================
echo   _p0_admin_apply.bat returned %_RC%
echo   (that script ends with its own pause, so results stay visible)
echo ================================================================
exit /b %_RC%
