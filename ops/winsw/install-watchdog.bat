@echo off
REM ============================================================
REM  OYours (MSCMS v14) - WinSW watchdog installer
REM  AUTO-ELEVATING: just double-click it; it raises UAC itself.
REM
REM  ASCII-only + CRLF on purpose:
REM    - a UTF-8/Chinese .bat in a cp936 console becomes mojibake
REM    - LF-only endings break cmd's if(...) block parsing
REM  .gitattributes pins *.bat to eol=crlf. Do not "fix" either.
REM ============================================================
setlocal EnableExtensions
set "HERE=%~dp0"
cd /d "%HERE%"

set "LOGDIR=D:\mscms-ws\logs\winsw"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\install.log"
set "NODEEXE=C:\Users\AS\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

REM ---------- 0) elevation gate (auto-elevate once) ----------
net session >nul 2>&1
if not errorlevel 1 goto :elevated

if defined MSCMS_ELEVATED goto :noluck

echo.
echo [!] Administrator rights are required.
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
echo     Fix: press Win+R, type  cmd  , press Ctrl+Shift+Enter (elevated),
echo     then run:
echo        cd /d "%HERE%"
echo        install-watchdog.bat
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
if not "%RC%"=="0" goto :failed
echo [DONE] Watchdog service installed and started.
echo        Verify with:  sc query mscms-watchdog     (expect RUNNING)
echo        Logs:         %LOGDIR%
echo.
pause
exit /b 0

:failed
echo [FAILED] exit code %RC% - full detail is in:
echo          %LOG%
echo.
echo Common causes, in order of likelihood:
echo   1) third-party .exe blocked in this shell  (exit 5)
echo      -^> run this .bat from a REAL elevated cmd, not from an IDE terminal
echo   2) node.exe path in mscms-watchdog.xml is wrong  (exit 4)
echo   3) the service was already running under another account  (exit 6)
echo.
pause
exit /b %RC%

REM ============================================================
:main
echo === OYours WinSW watchdog install ===
echo date: %DATE%  time: %TIME%
echo dir : %HERE%
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [!] not elevated - abort
  exit /b 2
)

if not exist "%HERE%mscms-watchdog.exe" (
  echo [!] missing "%HERE%mscms-watchdog.exe"
  exit /b 3
)
if not exist "%HERE%mscms-watchdog.xml" (
  echo [!] missing "%HERE%mscms-watchdog.xml"
  exit /b 3
)
if not exist "%NODEEXE%" (
  echo [!] node.exe not found at "%NODEEXE%"
  echo     update ^<executable^> in mscms-watchdog.xml, then re-run
  exit /b 4
)

echo --- 1) is the WinSW binary launchable in this shell? ---
"%HERE%mscms-watchdog.exe" version
if errorlevel 1 goto :blocked
echo [ok] binary is launchable.

echo.
echo --- 2) remove any previous instance ---
sc query mscms-watchdog >nul 2>&1
if errorlevel 1 (
  echo [i] no existing service - clean install.
) else (
  echo [!] service already exists - stopping and removing it first.
  "%HERE%mscms-watchdog.exe" stop
  timeout /t 3 /nobreak >nul 2>&1
  "%HERE%mscms-watchdog.exe" uninstall
  timeout /t 2 /nobreak >nul 2>&1
)

echo.
echo --- 3) install ---
"%HERE%mscms-watchdog.exe" install
if errorlevel 1 (
  echo [!] install failed
  exit /b 6
)

echo.
echo --- 4) start ---
"%HERE%mscms-watchdog.exe" start
timeout /t 4 /nobreak >nul 2>&1

echo.
echo --- 5) verify ---
sc query mscms-watchdog
echo.
sc qc mscms-watchdog

echo.
echo --- 6) disable the legacy autostart scheduled task ---
schtasks /Query /TN "MSCMS_Autostart" >nul 2>&1
if errorlevel 1 (
  echo [i] MSCMS_Autostart not found - skipped.
) else (
  schtasks /Change /TN "MSCMS_Autostart" /DISABLE >nul 2>&1
  if errorlevel 1 (
    echo [!] could not disable MSCMS_Autostart - disable it manually.
  ) else (
    echo [ok] MSCMS_Autostart disabled.
  )
)

echo.
echo --- 7) skip the watchdog block in _autostart_mscms.bat ---
"%NODEEXE%" "%HERE%patch-autostart.js"
echo [i] patch-autostart exit code: %ERRORLEVEL%

echo.
echo === install finished ===
exit /b 0

:blocked
echo.
echo [!] "mscms-watchdog.exe" could NOT be executed here
echo     ^(access denied / bad image - this shell blocks third-party .exe^).
echo.
echo     Do this instead:
echo       1. Win+R  -^>  cmd            ^(a REAL console^)
echo       2. Ctrl+Shift+Enter          ^(elevate it^)
echo       3. cd /d "%HERE%"
echo       4. install-watchdog.bat
echo.
echo     Do NOT run this from an IDE / integrated terminal / sandbox shell.
exit /b 5
