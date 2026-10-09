@echo off
setlocal EnableExtensions
REM ======================================================================
REM MSCMS 服务开机自启（幂等）：主系统 3002(生产 50云手机) + 养号 3005
REM 机制：用 node 探测端口是否已 LISTENING，已占用则跳过（避免重复进程/端口冲突）
REM 触发：当前用户 Startup 文件夹快捷方式（登录时自动运行）
REM ======================================================================

set WS=C:\Users\AS\WorkBuddy\2026-06-13-19-42-19
set NODE=C:\Users\AS\\binaries\node\versions\22.22.2\node.exe
set NODE_PATH=C:\Users\AS\\binaries\node\workspace\node_modules
set LOG=%WS%\logs\startup.log
if not exist "%WS%\logs" mkdir "%WS%\logs"

REM 清理可能污染的 Electron 环境
set ELECTRON_RUN_AS_NODE=

REM 端口探测辅助：返回 0=已占用 1=空闲
set PROBE=node -e "const net=require('net');const s=net.connect({port:%P%,host:''});let ok=false;s.on('connect',()=>{ok=true;s.destroy()});s.on('error',()=>{});setTimeout(()=>{process.exit(ok?0:1)},1500)"

echo [%date% %time%] === 自启检查开始 === >> "%LOG%"

REM ======================================================================
REM 1) 主 MSCMS 服务 (端口 3002, 生产模式 50 云手机)
REM ======================================================================
set P=3002
%PROBE% >nul 2>&1
if "%ERRORLEVEL%"=="0" (
  echo [%date% %time%] 3002 已监听，跳过主服务 >> "%LOG%"
) else (
  echo [%date% %time%] 启动主 MSCMS 3002 (CLOUD_PHONE_COUNT=50) >> "%LOG%"
  cd /d "%WS%"
  start "" /min cmd /c "set ELECTRON_RUN_AS_NODE= && set NODE_TLS_REJECT_UNAUTHORIZED=0 && set CLOUD_PHONE_COUNT=50 && set CLOUD_PHONE_MODE=cloud && set PUBLIC_DOMAIN=hlua.cc.cd && set PORT=3002 && set TUMBLR_PROXY=http://:10808 && set TUMBLR_API_RPM=25 && set NODE_PATH=%NODE_PATH% && \"%NODE%\" \"%WS%\server.js\" >> \"%WS%\logs\server-3002.log\" 2>&1"
  timeout /t 4 /nobreak >nul
)

REM ======================================================================
REM 2) Tumblr 养号服务 (端口 3005)
REM ======================================================================
set P=3005
%PROBE% >nul 2>&1
if "%ERRORLEVEL%"=="0" (
  echo [%date% %time%] 3005 已监听，跳过养号服务 >> "%LOG%"
) else (
  echo [%date% %time%] 启动养号服务 3005 (DEVICE=1 AUTO=1) >> "%LOG%"
  cd /d "%WS%"
  start "" /min cmd /c "set ELECTRON_RUN_AS_NODE= && set NODE_TLS_REJECT_UNAUTHORIZED=0 && set TUMBLR_NURTURE_PORT=3005 && set TUMBLR_NURTURE_DEVICE=1 && set TUMBLR_NURTURE_AUTO=1 && set TUMBLR_PROXY=http://:10808 && set TUMBLR_API_RPM=25 && set NODE_PATH=%NODE_PATH% && \"%NODE%\" \"%WS%\tumblr-nurture-server.js\" >> \"%WS%\logs\nurture-3005.log\" 2>&1"
  timeout /t 3 /nobreak >nul
)

REM ======================================================================
REM 3) SOCKS5 透明隧道代理 (端口 10950) — 骑在 VPS VLESS 隧道上，
REM    为本机提供一条【字节透明】的 TCP 隧道（绕过 xray HTTP-CONNECT 嵌套挂起）。
REM    前置：VPS VLESS 隧道(vpsa-cf.json) 须已在运行（出口 ）。
REM ======================================================================
set P=10950
%PROBE% >nul 2>&1
if "%ERRORLEVEL%"=="0" (
  echo [%date% %time%] 10950 已监听，跳过 SOCKS5 代理 >> "%LOG%"
) else (
  echo [%date% %time%] 启动 SOCKS5 代理 10950 (VPS 透明隧道) >> "%LOG%"
  cd /d "%WS%"
  start "" /min cmd /c "\"C:\Users\AS\Pictures\v2rayN-windows-64\bin\xray\xray.exe\" run -c \"%WS%\scripts\vps-socks5-proxy.json\" >> \"%WS%\logs\socks5-10950.log\" 2>&1"
  timeout /t 3 /nobreak >nul
)

REM ======================================================================
REM 4) Bright Data 住宅/ISP 转发器 (端口 10809) — MSCMS 经此走真实住宅/ISP IP。
REM    链路：MSCMS → 10809 → SOCKS5(10950) → VPS() → brd.superproxy.io(ISP zone) → 目标。
REM    TLS 端到端保留 OAuth 头；proxy-pool.json 已加入该出口（enabled），养号/发布即走住宅 IP。
REM ======================================================================
set P=10809
%PROBE% >nul 2>&1
if "%ERRORLEVEL%"=="0" (
  echo [%date% %time%] 10809 已监听，跳过 BD 住宅转发器 >> "%LOG%"
) else (
  echo [%date% %time%] 启动 BD 住宅转发器 10809 (SOCKS5->VPS->BD ISP) >> "%LOG%"
  cd /d "%WS%"
  start "" /min cmd /c "set BD_ZONE=isp_proxy1 && set BD_PASSWORD=d2ream9zn4am && set BD_PORT=44445 && set SOCKS_HOST= && set SOCKS_PORT=10950 && set LISTEN_PORT=10809 && set NODE_PATH=%NODE_PATH% && \"%NODE%\" \"%WS%\scripts\bd-residential-forwarder.js\" >> \"%WS%\logs\bd-fwd-10809.log\" 2>&1"
  timeout /t 3 /nobreak >nul
)

echo [%date% %time%] === 自启检查完成 === >> "%LOG%"
endlocal
exit /b 0
