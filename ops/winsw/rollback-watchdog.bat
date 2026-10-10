@echo off
REM ============================================================
REM  MSCMS v14 — WinSW Watchdog 回滚脚本（管理员运行）
REM  卸载看门狗服务并恢复旧自启计划任务。
REM ============================================================
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 ( echo [!] 请以【管理员】身份运行此脚本 & pause & exit /b 1 )

echo [*] 停止并卸载 MSCMS v14 Watchdog 服务...
mscms-watchdog.exe stop
timeout /t 3 >nul
mscms-watchdog.exe uninstall

echo [*] 恢复 MSCMS_Autostart 计划任务...
schtasks /Change /TN "MSCMS_Autostart" /ENABLE >nul 2>&1
if not errorlevel 1 ( echo [ok] 已启用 MSCMS_Autostart ) else ( echo [i] 无 MSCMS_Autostart 或恢复失败 )

echo [!] 记得恢复 _autostart_mscms.bat 中被注释掉的看门狗启动块。
echo [完成] 已回滚。
pause
