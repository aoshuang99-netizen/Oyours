@echo off
REM ============================================================
REM  OYours (MSCMS v14) - WinSW Watchdog rollback
REM  MUST be run as Administrator.
REM  Uninstalls the watchdog service and restores the legacy
REM  autostart scheduled task.
REM
REM  NOTE: ASCII-only, CRLF on purpose (see install-watchdog.bat).
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "LOGDIR=D:\mscms-ws\logs\winsw"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\rollback.log"

net session >nul 2>&1
if errorlevel 1 ( echo [!] Access denied. Please run this script as Administrator. & pause & exit /b 1 )

echo [*] Stopping and uninstalling "OYours Watchdog" service ...
mscms-watchdog.exe stop
timeout /t 3 /nobreak >nul 2>&1
mscms-watchdog.exe uninstall

echo [*] Restoring scheduled task MSCMS_Autostart ...
schtasks /Change /TN "MSCMS_Autostart" /ENABLE >nul 2>&1
if not errorlevel 1 ( echo [ok] MSCMS_Autostart enabled. ) else ( echo [i] MSCMS_Autostart missing or restore failed. )

echo [*] Restoring the watchdog block in _autostart_mscms.bat (from backup) ...
set "NODEEXE=C:\Users\AS\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODEEXE%" (
  "%NODEEXE%" "%~dp0patch-autostart.js" --restore >> "%LOG%" 2>&1
  echo [ok] restored. Log: %LOG%
) else (
  echo [i] node not found at %NODEEXE% - skipped.
)

echo.
echo [DONE] Rolled back.
pause
