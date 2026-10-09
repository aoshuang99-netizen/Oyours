@echo off
rem MSCMS logon startup entry
rem Service logic is in _start_services.ps1
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\_start_services.ps1"
exit /b 0
