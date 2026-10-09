# MSCMS v14 Server Starter with proper logging
$ErrorActionPreference = "Continue"

# Get script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = Get-Location }
Set-Location $scriptDir

# Log files
$stdoutLog = Join-Path $scriptDir "server-stdout.log"
$stderrLog = Join-Path $scriptDir "server-stderr.log"

# Clear old logs
"" | Out-File -FilePath $stdoutLog -Encoding ASCII -Force
"" | Out-File -FilePath $stderrLog -Encoding ASCII -Force

Write-Host "[start-server] Starting MSCMS v14..."
Write-Host "[start-server] Working dir: $scriptDir"
Write-Host "[start-server] Stdout log: $stdoutLog"
Write-Host "[start-server] Stderr log: $stderrLog"

$nodeExe = "$env:USERPROFILE\\binaries\node\versions\22.22.2\node.exe"
$nodePath = "$env:USERPROFILE\\binaries\node\workspace\node_modules"

# Start the server with output redirection
$procInfo = New-Object System.Diagnostics.ProcessStartInfo
$procInfo.FileName = $nodeExe
$procInfo.Arguments = "server.js"
$procInfo.WorkingDirectory = $scriptDir
$procInfo.RedirectStandardOutput = $true
$procInfo.RedirectStandardError = $true
$procInfo.UseShellExecute = $false
$procInfo.CreateNoWindow = $true

# Set environment variables
$procInfo.EnvironmentVariables["CLOUD_PHONE_COUNT"] = "0"
$procInfo.EnvironmentVariables["PORT"] = "3002"
$procInfo.EnvironmentVariables["NODE_PATH"] = $nodePath

$proc = [System.Diagnostics.Process]::Start($procInfo)

# Store the PID for later management
$proc.Id | Out-File -FilePath (Join-Path $scriptDir "server.pid") -Encoding ASCII

# Start background readers to capture output
$stdoutJob = Start-Job -ScriptBlock {
    param($reader, $path)
    $writer = [System.IO.StreamWriter]::new($path, $true)
    $writer.AutoFlush = $true
    try {
        while ($true) {
            $line = $reader.ReadLine()
            if ($line -eq $null) { break }
            $writer.WriteLine($line)
            $writer.Flush()
        }
    } catch { } finally { $writer.Dispose() }
} -ArgumentList $proc.StandardOutput, $stdoutLog

$stderrJob = Start-Job -ScriptBlock {
    param($reader, $path)
    $writer = [System.IO.StreamWriter]::new($path, $true)
    $writer.AutoFlush = $true
    try {
        while ($true) {
            $line = $reader.ReadLine()
            if ($line -eq $null) { break }
            $writer.WriteLine($line)
            $writer.Flush()
        }
    } catch { } finally { $writer.Dispose() }
} -ArgumentList $proc.StandardError, $stderrLog

Write-Host "[start-server] Server started with PID: $($proc.Id)"
Write-Host "[start-server] Use 'Get-Process -Id $($proc.Id)' to check status"
Write-Host "[start-server] Use 'Stop-Process -Id $($proc.Id)' to stop"

# Return the process object so caller can manage it
# Wait a moment then check if it's still alive
Start-Sleep -Seconds 3
if ($proc.HasExited) {
    Write-Host "[start-server] ERROR: Server exited immediately with code $($proc.ExitCode)"
} else {
    Write-Host "[start-server] Server running OK!"
}
return $proc
