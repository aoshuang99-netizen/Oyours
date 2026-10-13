@echo off
title Oyours -- push via Personal Access Token
setlocal

echo ============================================================
echo   Oyours -- push via GitHub Personal Access Token
echo ============================================================
echo.
echo  Create a token here:
echo     https://github.com/settings/tokens
echo.
echo  Token type / scope you need:
echo     classic      -- check the  repo  scope
echo     fine-grained -- Contents = Read and write
echo.
echo  NOTE: the token stays on this machine. It is visible while
echo        you paste it into this window.
echo.

set "TOKEN="
set /p "TOKEN=Paste token, then press Enter: "
if not defined TOKEN goto empty
if "%TOKEN%"=="" goto empty

set "GUSER=aoshuang99-netizen"
set /p "GUSER=GitHub username, press Enter for aoshuang99-netizen: "
if not defined GUSER set "GUSER=aoshuang99-netizen"

set "REPO=aoshuang99-netizen/Oyours"
set "CRED=%TEMP%\_oyours_cred.txt"

echo.
echo [1/3] caching credential in Windows Credential Manager ...
echo protocol=https> "%CRED%"
echo host=github.com>> "%CRED%"
echo username=%GUSER%>> "%CRED%"
echo password=%TOKEN%>> "%CRED%"
git credential approve < "%CRED%"
if errorlevel 1 echo       warn: git credential approve returned an error
del "%CRED%" >nul 2>nul

echo [2/3] pushing main to %REPO% ...
set GIT_TERMINAL_PROMPT=0
git push -u origin main
if errorlevel 1 goto direct

echo.
echo [3/3] state
git fetch origin --quiet
for /f %%A in ('git rev-list --count origin/main..HEAD') do echo       local ahead of origin/main = %%A
git log --oneline -1
echo.
echo DONE. Credential is cached -- later pushes need no prompt.
pause
exit /b 0

:direct
echo.
echo       helper push failed, retrying with an inline token URL ...
git push "https://%GUSER%:%TOKEN%@github.com/%REPO%.git" main:main
if errorlevel 1 goto pushfail
echo.
echo DONE via inline token. Credential caching may have failed,
echo so future pushes might prompt again.
pause
exit /b 0

:empty
echo.
echo [X] empty token -- aborted, nothing was changed.
pause
exit /b 1

:pushfail
echo.
echo [X] push failed. Read the git message above for the reason.
pause
exit /b 1
