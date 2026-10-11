$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\AS\WorkBuddy\2026-06-13-19-42-19'
& 'C:\Users\AS\.workbuddy\binaries\node\versions\22.22.2-6\node.exe' 'tools\free-platform-publisher.js' --batch 'tools\free-promo.json'
Write-Host ''
Write-Host "Exit code: $LASTEXITCODE"
Write-Host '(Bluesky will skip if app  not set; Mastodon will post if token is live)'
Read-Host 'Press Enter to close'
