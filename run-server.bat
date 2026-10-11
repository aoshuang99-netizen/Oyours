@echo off
set CLOUD_PHONE_COUNT=0
set PORT=3002
set NODE_PATH=C:\Users\AS\\binaries\node\workspace\node_modules
"C:\Users\AS\\binaries\node\versions\22.22.2\node.exe" server.js > server-stdout.log 2> server-stderr.log
