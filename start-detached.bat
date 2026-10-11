@echo off
REM Critical: Use setx-like clearing for Electron env vars
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "CLOUD_PHONE_COUNT=1"
set "NODE_PATH=%USERPROFILE%\\binaries\node\workspace\node_modules"

cd /d "%USERPROFILE%\WorkBuddy\2026-06-13-19-42-19"

rem Launch server in a completely detached process
start "MSCMS-Server" /b /min cmd /c ""%USERPROFILE%\\binaries\node\versions\22.22.2\node.exe" server.js > "D:\mscms-server.log" 2>&1"
