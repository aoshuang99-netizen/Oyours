@echo off
REM ============================================================
REM  OYours (MSCMS v14) - WinSW watchdog rollback
REM  AUTO-ELEVATING: just double-click it; it raises UAC itself.
REM  Uninstalls the watchdog service and restores the legacy
REM  autostart scheduled task + the _autostart_mscms.bat block.
REM
REM  ASCII-only + CRLF on purpose (see install-watchdog.bat).
REM ============================================================
setlocal EnableExtensions
set "HERE=%~dp0"
cd /d "%HERE%"

set "LOGDIR=D:\mscms-ws\logs\winsw"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\rollback.log"
set "NODEEXE=C:\Users\AS\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "AUTOSTART=%HERE%..\..\_autostart_mscms.bat"
set "AUTOSTART_BAK=%HERE%..\..\_autostart_mscms.bat.bak"

REM ---------- 0) elevation gate (auto-elevate once) ----------
net session >nul 2>&1
if not errorlevel 1 goto :elevated

if defined MSCMS_ELEVATED goto :noluck

echo.
echo [!] Administrator rights are required for rollback.
echo     Requesting elevation - a UAC prompt will appear, please click Yes.
echo.
set "MSCMS_ELEVATED=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%HERE%'" >nul 2>&1
if errorlevel 1 goto :noluck
echo [i] Elevated instance launched in a NEW window. This one can be closed.
timeout /t 4 /nobreak >nul 2>&1
exit /b 0

:noluck
echo [X] Could not obtain administrator rights.
echo     Fix: Win+R  -^>  cmd  -^>  Ctrl+Shift+Enter  -^>  run rollback-watchdog.bat
echo.
pause
exit /b 1

REM ---------- elevated path ----------
:elevated
echo.
echo [*] Running with administrator rights.
echo [*] Full output is also saved to:
echo     %LOG%
echo.

call :main > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

type "%LOG%"

echo.
echo [DONE] Rolled back. Log: %LOG%
echo        Verify with:  sc query mscms-watchdog     (expect 1060 = not installed)
echo.
pause
exit /b %RC%

REM ============================================================
:main
echo === OYours WinSW watchdog rollback ===
echo date: %DATE%  time: %TIME%
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [!] not elevated - abort
  exit /b 2
)

echo --- 1) service: stop + uninstall ---
sc query mscms-watchdog >nul 2>&1
if errorlevel 1 (
  echo [i] service "mscms-watchdog" is NOT installed - nothing to stop or remove.
) else (
  if not exist "%HERE%mscms-watchdog.exe" (
    echo [!] service exists but "%HERE%mscms-watchdog.exe" is missing
    echo     remove it manually:  sc delete mscms-watchdog
  ) else (
    echo [*] stopping ...
    "%HERE%mscms-watchdog.exe" stop
    timeout /t 3 /nobreak >nul 2>&1
    echo [*] uninstalling ...
    "%HERE%mscms-watchdog.exe" uninstall
    timeout /t 2 /nobreak >nul 2>&1
    sc query mscms-watchdog >nul 2>&1
    if errorlevel 1 (
      echo [ok] service removed.
    ) else (
      echo [!] service still present - try:  sc delete mscms-watchdog
    )
  )
)

echo.
echo --- 2) re-enable the legacy autostart scheduled task ---
schtasks /Query /TN "MSCMS_Autostart" >nul 2>&1
if errorlevel 1 (
  echo [i] MSCMS_Autostart not found - nothing to enable.
) else (
  schtasks /Change /TN "MSCMS_Autostart" /ENABLE >nul 2>&1
  if errorlevel 1 (
    echo [!] failed to enable MSCMS_Autostart.
  ) else (
    echo [ok] MSCMS_Autostart enabled.
  )
)

echo.
echo --- 3) restore the watchdog block in _autostart_mscms.bat ---
if exist "%AUTOSTART_BAK%" goto :dorestore
echo [i] no backup "%AUTOSTART_BAK%" - _autostart_mscms.bat was never patched,
echo     so there is nothing to restore. ^(This is normal on a first install.^)
goto :end

:dorestore
if not exist "%NODEEXE%" goto :nonode
"%NODEEXE%" "%HERE%patch-autostart.js" --restore
if errorlevel 1 (
  echo [!] restore FAILED - see messages above.
) else (
  echo [ok] _autostart_mscms.bat restored from backup.
)
goto :end

:nonode
echo [!] node.exe not found at "%NODEEXE%"
echo     copy "%AUTOSTART_BAK%" over "%AUTOSTART%" manually.

:end
echo.
echo === rollback finished ===
exit /b 0
