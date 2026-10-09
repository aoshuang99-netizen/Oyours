# MSCMS v14.3 Desktop Launcher
# Clears WorkBuddy sandbox ELECTRON_RUN_AS_NODE before launching
# 2026-07-09

Write-Host "=== MSCMS v14.3 Desktop Launcher ===" -ForegroundColor Cyan

# ─── CRITICAL: Clear Electron-breaking env vars at PROCESS level ───
[Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "", "Process")
[Environment]::SetEnvironmentVariable("NODE_OPTIONS", "", "Process")
$env:ELECTRON_RUN_AS_NODE = ""
$env:NODE_OPTIONS = ""

Write-Host "[OK] Environment cleaned" -ForegroundColor Green

# Determine paths
$desktopDir = "$env:USERPROFILE\WorkBuddy\2026-06-13-19-42-19\MSCMS-v14-Desktop"
$exePath = "$desktopDir\MSCMS.exe"

if (!(Test-Path $exePath)) {
    Write-Host "[ERROR] MSCMS.exe not found at: $exePath" -ForegroundColor Red
    # Try dev mode
    $electronPath = "$env:USERPROFILE\WorkBuddy\2026-06-13-19-42-19\electron\node_modules\electron\dist\electron.exe"
    $appDir = "$env:USERPROFILE\WorkBuddy\2026-06-13-19-42-19\mscms-desktop"
    if (Test-Path $electronPath) {
        Write-Host "[INFO] Falling back to dev mode: $electronPath" -ForegroundColor Yellow
        Start-Process -FilePath $electronPath -WorkingDirectory $appDir -ArgumentList "." -WindowStyle Normal
    } else {
        Write-Host "[FATAL] No Electron found. Aborting." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "[OK] Found MSCMS.exe at: $exePath" -ForegroundColor Green
    Write-Host "[INFO] Launching with CLEARED env vars..." -ForegroundColor Cyan
    Start-Process -FilePath $exePath -WorkingDirectory $desktopDir -WindowStyle Normal
}

Write-Host "[DONE] Desktop app launched. Check system tray if no window appears." -ForegroundColor Cyan
Write-Host "       Right-click tray icon to Show Window or Restart Server."
