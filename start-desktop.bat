@echo off
chcp 65001 >nul
title MSCMS v14 Desktop

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   MSCMS v14 桌面应用 - 立即启动               ║
echo  ╚══════════════════════════════════════════════╝
echo.

cd /d "%~dp0electron"

if not exist "node_modules\electron" (
    echo [首次运行] 正在安装 Electron 框架...
    echo 这可能需要 2-3 分钟，请耐心等待...
    echo.
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo [错误] Electron 安装失败
        echo 请检查网络连接，或手动运行: cd electron ^&^& npm install
        pause
        exit /b 1
    )
    echo [√] Electron 安装完成
    echo.
)

echo 正在启动 MSCMS v14 桌面应用...
call npx electron . --no-sandbox
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [提示] 桌面应用已关闭
)
pause
