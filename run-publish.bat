@echo off
chcp 65001 >nul
cd /d "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19"
"C:\Users\AS\\binaries\node\versions\22.22.2-6\node.exe" tools\free--publisher.js --batch tools\free-promo.json
echo.
echo Exit code: %errorlevel%
echo (Bluesky will skip if app  not set; Mastodon will post if token is live)
pause
