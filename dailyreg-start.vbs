' dailyreg-start.vbs — 供计划任务 MSCMS_TumblrDailyRegister 调用（隐藏执行）
Option Explicit
Dim ws
Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19"
ws.Run "cmd /c ""C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\_daily_.bat""", 0, False
Set ws = Nothing
WScript.Quit 0
