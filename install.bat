@echo off
chcp 65001 >nul
title MSCMS v14 一键安装程序
color 0A

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║     MSCMS v14 综合精细化系统 - 本地安装包      ║
echo  ║          Version 3.0 | 2026-07-03            ║
echo  ╚══════════════════════════════════════════════╝
echo.

set "INSTALL_DIR=%~dp0"
set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "DESKTOP=%USERPROFILE%\Desktop"
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\MSCMS v14"

echo [1/6] 检查 Node.js 环境...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org
    echo        推荐版本: Node.js 18+ LTS
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo        Node.js 版本: %NODE_VER%

where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未检测到 npm
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('npm -v') do set NPM_VER=%%i
echo        npm 版本: %NPM_VER%
echo        [√] 环境检查通过

echo.
echo [2/6] 安装项目依赖...
cd /d "%INSTALL_DIR%"
call npm install --production 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo        [注意] 部分可选依赖安装失败，尝试基础安装...
    call npm install express mysql2 axios 2>nul
)
echo        [√] 依赖安装完成

echo.
echo [3/6] 创建启动脚本...
(
echo @echo off
echo chcp 65001 ^>nul
echo title MSCMS v14 Server
echo cd /d "%INSTALL_DIR%"
echo echo 正在启动 MSCMS v14 服务器...
echo start "" "http://localhost:3002/v14"
echo node server.js
echo pause
) > "%INSTALL_DIR%\start-mscms.bat"
echo        [√] start-mscms.bat 已创建

echo.
echo [4/6] 创建桌面快捷方式...
powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%DESKTOP%\MSCMS v14 控制台.url'); $Shortcut.TargetPath = 'http://localhost:3002/v14'; $Shortcut.IconLocation = '%SystemRoot%\System32\imageres.dll,15'; $Shortcut.Save()" 2>nul
echo        [√] 桌面快捷方式: MSCMS v14 控制台.url

powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%DESKTOP%\启动 MSCMS v14.lnk'); $Shortcut.TargetPath = '%INSTALL_DIR%\start-mscms.bat'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.IconLocation = '%SystemRoot%\System32\imageres.dll,14'; $Shortcut.Save()" 2>nul
echo        [√] 桌面快捷方式: 启动 MSCMS v14.lnk

echo.
echo [5/6] 创建开始菜单文件夹...
if not exist "%START_MENU%" mkdir "%START_MENU%"
powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%START_MENU%\启动 MSCMS v14.lnk'); $Shortcut.TargetPath = '%INSTALL_DIR%\start-mscms.bat'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.IconLocation = '%SystemRoot%\System32\imageres.dll,14'; $Shortcut.Save()" 2>nul

powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%START_MENU%\MSCMS v14 控制台.lnk'); $Shortcut.TargetPath = 'http://localhost:3002/v14'; $Shortcut.IconLocation = '%SystemRoot%\System32\imageres.dll,15'; $Shortcut.Save()" 2>nul

powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%START_MENU%\卸载 MSCMS v14.lnk'); $Shortcut.TargetPath = '%INSTALL_DIR%\uninstall.bat'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.Save()" 2>nul
echo        [√] 开始菜单已创建

echo.
echo [6/6] 配置开机自启 (可选)...
set /p AUTO_START="是否添加到开机自启动？(Y/N): "
if /i "%AUTO_START%"=="Y" (
    powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut([Environment]::GetFolderPath('Startup') + '\MSCMS v14.lnk'); $Shortcut.TargetPath = '%INSTALL_DIR%\start-mscms.bat'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.WindowStyle = 7; $Shortcut.Save()"
    echo        [√] 已添加开机自启
) else (
    echo        [×] 跳过开机自启
)

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║          安装完成！✅                         ║
echo  ╠══════════════════════════════════════════════╣
echo  ║  桌面快捷方式:                                ║
echo  ║    • 启动 MSCMS v14 (启动服务器)              ║
echo  ║    • MSCMS v14 控制台 (打开浏览器)            ║
echo  ║                                              ║
echo  ║  开始菜单: MSCMS v14                         ║
echo  ║    • 启动 MSCMS v14                          ║
echo  ║    • MSCMS v14 控制台                        ║
echo  ║    • 卸载 MSCMS v14                          ║
echo  ║                                              ║
echo  ║  访问地址:                                    ║
echo  ║    控制台: http://localhost:3002/v14          ║
echo  ║    API: http://localhost:3002/api/v14/...     ║
echo  ║                                              ║
echo  ║  立即启动? 双击桌面的 "启动 MSCMS v14"       ║
echo  ╚══════════════════════════════════════════════╝
echo.
pause
