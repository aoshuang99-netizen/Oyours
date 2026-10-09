@echo off
chcp 65001 >nul
title MSCMS v14.2 Desktop - 构建工具
color 0B

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║  MSCMS v14 桌面应用 - 构建打包工具            ║
echo  ╚══════════════════════════════════════════════╝
echo.
echo 请选择构建方式:
echo.
echo   [1] 开发模式 - 直接启动桌面应用 (不打包)
echo   [2] 打包为 Windows 安装程序 (.exe)
echo   [3] 打包为便携版 (.exe, 无需安装)
echo   [4] 仅安装 Electron 依赖 (准备开发环境)
echo   [0] 退出
echo.
set /p CHOICE="请输入选项 (0-4): "

if "%CHOICE%"=="1" goto DEV
if "%CHOICE%"=="2" goto BUILD_INSTALLER
if "%CHOICE%"=="3" goto BUILD_PORTABLE
if "%CHOICE%"=="4" goto INSTALL_DEPS
if "%CHOICE%"=="0" goto EXIT
echo 无效选项
pause
exit /b 1

:INSTALL_DEPS
echo.
echo [安装 Electron 依赖...]
cd /d "%~dp0electron"
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo [√] Electron 依赖安装完成
pause
goto MENU

:DEV
echo.
echo [开发模式] 启动桌面应用...
cd /d "%~dp0electron"
if not exist "node_modules" (
    echo 首次运行，正在安装 Electron...
    call npm install
)
call npx electron .
pause
goto MENU

:BUILD_INSTALLER
echo.
echo [打包模式] 生成 Windows 安装程序...
cd /d "%~dp0electron"
if not exist "node_modules" (
    echo 正在安装依赖...
    call npm install
)
echo 正在打包，请稍候... (首次打包约需 3-5 分钟)
call npx electron-builder --win --x64
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 打包失败
    pause
    exit /b 1
)
echo.
echo [√] 打包完成！安装程序位于: dist-desktop\
echo.
explorer "%~dp0dist-desktop"
pause
goto MENU

:BUILD_PORTABLE
echo.
echo [打包模式] 生成便携版...
cd /d "%~dp0electron"
if not exist "node_modules" (
    echo 正在安装依赖...
    call npm install
)
echo 正在打包，请稍候...
call npx electron-builder --win portable --x64
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 打包失败
    pause
    exit /b 1
)
echo.
echo [√] 打包完成！便携版位于: dist-desktop\
echo.
explorer "%~dp0dist-desktop"
pause
goto MENU

:EXIT
exit /b 0
