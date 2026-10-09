@echo off
set NODE_OPTIONS=
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
