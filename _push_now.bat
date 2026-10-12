@echo off
setlocal EnableExtensions
title OYours -- one-time Git credential setup + push
echo ================================================================
echo   OYours / MSCMS v14  --  first-time GitHub login + push
echo ----------------------------------------------------------------
echo   WHY THIS EXISTS
echo     The GitHub connector in this IDE authenticates on the SERVER
echo     side (api.githubcopilot.com, auth mode "server-side"), so no
echo     token of yours ever lands on this machine. That makes
echo     "git push" impossible to automate until a credential exists
echo     locally, ONCE. This script creates it.
echo.
echo   WHAT IT DOES
echo     1. makes sure the outbound proxy is set for github.com
echo     2. runs "git push" -- Git Credential Manager opens a browser;
echo        sign in to GitHub and approve. The credential is then
echo        cached in Windows Credential Manager, so every later push
echo        (including scripted ones) works with no prompt.
echo     3. prints the resulting state (local vs remote commit)
echo.
echo   It pushes 8 local commits: ae87b4c .. 93a09b6
echo   (P0-1 outbound, P0-2 rate gate, P0-3 injection, P0-4 zombie,
echo    P0 syntax self-check, P0-5 memory root cause, plus tooling)
echo ================================================================
echo.

cd /d "%~dp0"

echo [1/3] proxy for github.com ...
git config --local http.proxy http://127.0.0.1:10809
git config --local https.proxy http://127.0.0.1:10809
git config --local http.postBuffer 524288000
git config --local credential.helper manager
echo       ok
echo.

echo [2/3] pushing ... (a browser window may open for GitHub sign-in)
git push origin main
set "_RC=%ERRORLEVEL%"
echo.
echo       git push exit code = %_RC%
echo.

echo [3/3] state ...
git log --oneline -1
echo       local  = (above)
for /f "delims=" %%i in ('git rev-parse --short origin/main 2^>nul') do echo       origin = %%i
echo.
if "%_RC%"=="0" (
  echo ================================================================
  echo   DONE. Local and remote are in sync.
  echo   Future pushes need no prompt -- the credential is cached.
  echo ================================================================
) else (
  echo ================================================================
  echo   Push did NOT finish.
  echo   If the browser asked you to approve and you did, just run
  echo   this script once more.
  echo   If it failed for another reason, copy the output above.
  echo ================================================================
)
echo.
pause
exit /b %_RC%
