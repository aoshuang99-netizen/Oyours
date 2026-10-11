@echo off
setlocal
set LOG=%~dp0_p0_2_reload_relay.log
echo ==== OYours P0-2: reload BD relay to load outbound gate ==== > "%LOG%"
echo time: %DATE% %TIME% >> "%LOG%"
echo [1/3] locate PID listening on 10809 >> "%LOG%"
for /f "tokens=5" %%I in ('netstat -ano -p TCP ^| findstr ":10809 " ^| findstr LISTENING') do call :kill %%I
echo [2/3] exit-guard will relaunch relay with NEW code within 60s >> "%LOG%"
echo [3/3] verify: node tools/bd-tumblr-quota-watch.js --status >> "%LOG%"
type "%LOG%"
goto :end

:kill
echo killing pid %1 >> "%LOG%"
taskkill /F /T /PID %1 >> "%LOG%" 2>&1
goto :eof

:end
endlocal