@echo off
set CLOUD_PHONE_COUNT=5
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set NODE_PATH=%USERPROFILE%\\binaries\node\workspace\node_modules
cd /d %USERPROFILE%\WorkBuddy\2026-06-13-19-42-19
%USERPROFILE%\\binaries\node\versions\22.22.2\node.exe server.js >> server.log 2>&1
