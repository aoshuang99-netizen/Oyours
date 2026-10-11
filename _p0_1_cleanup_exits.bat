@echo off
setlocal
set LOG=%~dp0_p0_1_cleanup.log
echo ==== OYours P0-1 outbound cleanup ==== > "%LOG%"
echo time: %DATE% %TIME% >> "%LOG%"
echo step 1: stopping legacy tunnels and old exit-guard - all SYSTEM owned >> "%LOG%"
for %%P in (20779 20880 20777 10950) do call :killport %%P
echo step 2: done. watchdog relaunches exit-guard with NEW config within 60s >> "%LOG%"
echo step 3: new exit-guard guards BD relay and purges leftover tunnels >> "%LOG%"
type "%LOG%"
goto :eof

:killport
for /f "tokens=5" %%I in ('netstat -ano -p TCP ^| findstr ":%~1 " ^| findstr LISTENING') do (
echo kill port %~1 pid %%I >> "%LOG%"
taskkill /F /T /PID %%I >> "%LOG%" 2>&1
)
goto :eof
