@echo off
setlocal
set LOG=%~dp0_p0_4_defender_exclusions.log
echo ==== OYours P0-4: Defender exclusions for MSCMS write-heavy paths ==== > "%LOG%"
echo time: %DATE% %TIME% >> "%LOG%"
echo rationale: MsMpEng real-time scanning of these dirs measured over 400 percent CPU >> "%LOG%"
echo            (4+ of 12 cores), starving the :3002 event loop; watchdog then logs HTTP 0. >> "%LOG%"
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath 'D:\mscms-ws','D:\mscms-content','D:\MSCMS-Desktop','D:\OYours-recovery','C:\Users\AS\WorkBuddy'" >> "%LOG%" 2>&1
powershell -NoProfile -Command "Add-MpPreference -ExclusionProcess 'node.exe'" >> "%LOG%" 2>&1
echo --- exclusions now --- >> "%LOG%"
powershell -NoProfile -Command "Get-MpPreference | Select-Object -ExpandProperty ExclusionPath" >> "%LOG%" 2>&1
type "%LOG%"
endlocal
