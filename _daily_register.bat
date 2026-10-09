@echo off
setlocal
REM Daily Tumblr  -> nurture engine
REM Invoked by Windows Task Scheduler: MSCMS_TumblrDailyRegister (daily 03:00)
set ELECTRON_RUN_AS_NODE=
set TUMBLR_NURTURE_PORT=3005
set NODE_PATH=C:\Users\AS\\binaries\node\workspace\node_modules
set TUMBLR_PROXY=http://:10808
cd /d "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19"

REM --- resolve node.exe ---
REM 2026-09-11: 旧硬编码 versions\22.22.2 被删 → 本脚本静默空跑 16 天，而任务计划仍报成功。
REM 2026-09-14: 又犯一次 —— 上一轮改成三级硬编码(-2 / 22.22.2 / current)，但这三个现在
REM   【全部不存在】(versions 下只剩 22.22.2-3；current 目录里没有 node.exe)
REM   → 03:00 任务会再次静默空跑。
REM 根治：不再硬编码任何版本号，遍历 versions\*\node.exe 取第一个可用的（目录名倒序≈版本倒序）。
set NODE_EXE=
for /f "delims=" %%i in ('dir /b /o-n "C:\Users\AS\\binaries\node\versions" 2^>nul') do (
  if not defined NODE_EXE if exist "C:\Users\AS\\binaries\node\versions\%%i\node.exe" set NODE_EXE=C:\Users\AS\\binaries\node\versions\%%i\node.exe
)
REM 兜底 2：任何在 PATH 里的 node
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set NODE_EXE=%%i
)
if not defined NODE_EXE (
  echo [%DATE% %TIME%] FATAL: no usable node.exe under binaries\node\versions >> "D:\mscms-ws\logs\_onboard_daily.log"
  exit /b 1
)
echo [%DATE% %TIME%] node = %NODE_EXE% >> "D:\mscms-ws\logs\_onboard_daily.log"

"%NODE_EXE%" "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\tumblr-daily-.js"
set REG_RC=%ERRORLEVEL%

REM --- propagate the real exit code ---
REM A bare `endlocal` restores ERRORLEVEL to the value captured at setlocal (usually 0),
REM which made every failure look like success. Emit the real code instead.
REM 0 = ok / 1 = crashed / 2 = intentionally stopped (env not ready, e.g. ShardX down)
endlocal & exit /b %REG_RC%
