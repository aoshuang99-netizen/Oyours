@echo off
chcp 65001 >nul
title MSCMS v14 卸载程序
color 0C

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║     MSCMS v14 综合精细化系统 - 卸载程序        ║
echo  ╚══════════════════════════════════════════════╝
echo.

echo 此操作将:
echo   - 删除桌面快捷方式
echo   - 删除开始菜单文件夹
echo   - 移除开机自启 (如有)
echo   - 停止正在运行的服务
echo.
echo 注意: 项目文件和数据不会被删除
echo.

set /p CONFIRM="确认卸载？(Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo 已取消卸载
    pause
    exit /b 0
)

echo.
echo [1/4] 停止运行中的服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3002" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
    echo        [√] 已停止 PID %%a
)
echo        服务已停止

echo.
echo [2/4] 删除桌面快捷方式...
if exist "%USERPROFILE%\Desktop\启动 MSCMS v14.lnk" del /q "%USERPROFILE%\Desktop\启动 MSCMS v14.lnk" 2>nul
if exist "%USERPROFILE%\Desktop\MSCMS v14 控制台.url" del /q "%USERPROFILE%\Desktop\MSCMS v14 控制台.url" 2>nul
echo        [√] 桌面快捷方式已删除

echo.
echo [3/4] 删除开始菜单...
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\MSCMS v14" rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\MSCMS v14" 2>nul
echo        [√] 开始菜单已删除

echo.
echo [4/4] 移除开机自启...
if exist "%APPDATA%\Microsoft\Windows\Startup\MSCMS v14.lnk" del /q "%APPDATA%\Microsoft\Windows\Startup\MSCMS v14.lnk" 2>nul
echo        [√] 开机自启已移除

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║          卸载完成                             ║
echo  ║                                              ║
echo  ║  项目文件保留在:                              ║
echo  ║    %~dp0
echo  ╚══════════════════════════════════════════════╝
echo.
pause
