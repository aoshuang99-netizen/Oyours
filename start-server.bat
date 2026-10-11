@echo off
set CLOUD_PHONE_COUNT=0
set PORT=3002
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
"C:\Users\AS\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" "server.js" > "server.log" 2> "server-error.log"