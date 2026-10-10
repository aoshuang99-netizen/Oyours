@echo off
REM ============================================================
REM  MSCMS v14 — WinSW Watchdog 安装脚本
REM  必须以【管理员】身份运行（右键 -> 以管理员身份运行）
REM  设计：只包看门狗一个服务，由看门狗承载整棵服务树（详见 README.md）
REM ============================================================
setlocal
cd /d "%~dp0"

if not exist mscms-watchdog.exe ( echo [!] 缺少 mscms-watchdog.exe & pause & exit /b 1 )
if not exist mscms-watchdog.xml ( echo [!] 缺少 mscms-watchdog.xml & pause & exit /b 1 )

REM 0) 管理员权限校验
net session >nul 2>&1
if errorlevel 1 ( echo [!] 请以【管理员】身份运行此脚本 & pause & exit /b 1 )

REM 1) 安装服务（exe 与 xml 同名，WinSW 自动匹配配置）
echo [*] 安装 MSCMS v14 Watchdog 服务...
mscms-watchdog.exe install
if errorlevel 1 ( echo [!] 安装失败，请检查权限 / D:\mscms-ws\logs\winsw 日志 & pause & exit /b 1 )

REM 2) 登录账户
REM    默认 LocalSystem：无需密码，可访问 D: 盘与 127.0.0.1:10808 本地代理。
REM    若启动后报 ACL / 用户资源读取错误，再切成交互账户 .\AS：
REM        sc config mscms-watchdog obj= ".\AS" password= "你的Windows登录密码"
REM    或在 services.msc -> MSCMS v14 Watchdog -> 登录 -> 此账户 手动设置。
echo [*] 登录账户保持 LocalSystem（遇 ACL 错误再切 .\AS，见上方注释）

REM 3) 启动
echo [*] 启动服务...
mscms-watchdog.exe start
timeout /t 3 >nul
mscms-watchdog.exe status

REM 4) 停用旧自启计划任务（避免与看门狗 :3011 单实例锁冲突）
echo [*] 停用 MSCMS_Autostart 计划任务（若存在）...
schtasks /Query /TN "MSCMS_Autostart" >nul 2>&1
if not errorlevel 1 (
  schtasks /Change /TN "MSCMS_Autostart" /DISABLE
  echo [ok] 已停用 MSCMS_Autostart
) else (
  echo [i] 未找到 MSCMS_Autostart 计划任务，跳过
)

REM 5) 自动注释 _autostart_mscms.bat 的看门狗块（step4+5），使 WinSW 成为唯一父级
REM    避免与看门狗 :3011 单实例锁冲突。脚本自带备份 + 幂等（见 patch-autostart.js）。
echo [*] 自动跳过 _autostart_mscms.bat 的看门狗启动块...
set "NODEEXE=C:\Users\AS\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODEEXE%" (
  "%NODEEXE%" "%~dp0patch-autostart.js"
) else (
  echo [!] 未找到固定 node 路径，跳过自动注释；请手动按 README 注释 _autostart 第4~5步
)

echo.
echo [完成] 看门狗服务已安装并启动；旧自启计划任务已停用；_autostart 看门狗块已跳过。
echo 日志见 D:\mscms-ws\logs\winsw\
pause
