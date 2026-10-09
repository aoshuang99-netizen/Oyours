# MSCMS v14 稳定启动脚本 — Playwright-free 模式
$ErrorActionPreference = 'Stop'

# 清除有害环境变量
[Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "", "Process")
[Environment]::SetEnvironmentVariable("NODE_OPTIONS", "", "Process")
[Environment]::SetEnvironmentVariable("CLOUD_PHONE_COUNT", "0", "Process")
[Environment]::SetEnvironmentVariable("PORT", "3002", "Process")

$workDir = "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19"
$nodeExe = "C:\Users\AS\\binaries\node\versions\22.22.2\node.exe"
$nodeModules = "C:\Users\AS\\binaries\node\workspace\node_modules"

Push-Location $workDir

try {
    # 清理旧日志
    Remove-Item "$workDir\server.log" -Force -ErrorAction SilentlyContinue
    Remove-Item "$workDir\server-error.log" -Force -ErrorAction SilentlyContinue

    # 直接启动 Node.js 进程（当前进程上下文，便于日志输出）
    $env:NODE_PATH = $nodeModules
    $env:CLOUD_PHONE_COUNT = "0"
    $env:PORT = "3002"
    
    Write-Host "=== MSCMS v14 Starting (Playwright-free mode) ==="
    Write-Host "Node: $nodeExe"
    Write-Host "CLOUD_PHONE_COUNT=$env:CLOUD_PHONE_COUNT"
    Write-Host "================================================"
    
    & $nodeExe server.js 2>&1 | Tee-Object -FilePath "$workDir\server.log"
} catch {
    Write-Error "Server crashed: $($_.Exception.Message)"
    $_ | Out-File "$workDir\server-error.log"
} finally {
    Pop-Location
}
