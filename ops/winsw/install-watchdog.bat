@echo off
REM ============================================================
REM  OYours (MSCMS v14) - WinSW Watchdog installer
REM  MUST be run as Administrator (right-click -> Run as administrator)
REM  Design: only the watchdog is wrapped; it carries the whole
REM  service tree (see README.md).
REM
REM  NOTE: ASCII-only on purpose. A UTF-8/Chinese .bat run in a
REM  cp936 console turns into mojibake, and LF-only line endings
REM  break cmd's if(...) block parsing.
REM  This file MUST keep CRLF line endings (.gitattributes enforces it).
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "LOGDIR=D:\mscms-ws\logs\winsw"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\install.log"

if not exist "mscms-watchdog.exe" ( echo [!] missing mscms-watchdog.exe & pause & exit /b 1 )
if not exist "mscms-watchdog.xml" ( echo [!] missing mscms-watchdog.xml & pause & exit /b 1 )

REM 0) Administrator check
net session >nul 2>&1
if errorlevel 1 ( echo [!] Access denied. Please run this script as Administrator. & pause & exit /b 1 )

REM 1) Install service (exe and xml share the same basename; WinSW auto-loads the xml)
echo [*] Installing "OYours Watchdog" service ...
mscms-watchdog.exe install
if errorlevel 1 ( echo [!] install failed - check privileges and %LOG% & pause & exit /b 1 )

REM 2) Account: LocalSystem by default (no password, can reach D: and the local proxy on 127.0.0.1:10808).
REM    If the service later reports ACL / user-resource errors, switch to the interactive account .\AS:
REM      sc config mscms-watchdog obj= ".\AS" password= "YOUR_WINDOWS_PASSWORD"
REM    or set it in services.msc -> OYours Watchdog -> Log On.
echo [*] Logon account: LocalSystem (switch to .\AS only on ACL errors - see notes above)

REM 3) Start
echo [*] Starting service ...
mscms-watchdog.exe start
timeout /t 3 /nobreak >nul 2>&1
mscms-watchdog.exe status

REM 4) Disable the legacy autostart scheduled task (avoids clashing with the watchdog :3011 single-instance lock)
echo [*] Disabling legacy scheduled task MSCMS_Autostart (if present) ...
schtasks /Query /TN "MSCMS_Autostart" >nul 2>&1
if not errorlevel 1 (
  schtasks /Change /TN "MSCMS_Autostart" /DISABLE >nul 2>&1
  echo [ok] MSCMS_Autostart disabled.
) else (
  echo [i] MSCMS_Autostart not found - skipped.
)

REM 5) Comment out the watchdog block (steps 4-5) in _autostart_mscms.bat so WinSW is the only parent.
REM    The helper script backs up first and is idempotent (see patch-autostart.js).
echo [*] Skipping the watchdog block in _autostart_mscms.bat ...
set "NODEEXE=C:\Users\AS\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODEEXE%" (
  "%NODEEXE%" "%~dp0patch-autostart.js" >> "%LOG%" 2>&1
  echo [ok] patched. Log: %LOG%
) else (
  echo [!] node not found at %NODEEXE% - skipped. Comment steps 4-5 of _autostart manually (see README).
)

echo.
echo [DONE] Watchdog service installed and started.
echo Logs: D:\mscms-ws\logs\winsw\
echo Verify with:  sc query mscms-watchdog
pause
