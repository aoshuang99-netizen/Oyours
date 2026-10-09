' mscms-start.vbs — 供计划任务 MSCMS_Autostart 调用
'
' 背景：任务原本直接 `cmd /c _autostart_mscms.bat`，cmd 是控制台程序会弹黑窗；
'       且 bat 内部 `start "xxx" /min` 会让每个服务各自带一个最小化窗口。
'
' 做法：
'   1) 由 wscript.exe（GUI 子系统，自身无窗口）执行本脚本
'   2) 设置 MSCMS_SILENT=1，再以窗口模式 0 启动 cmd
'   3) bat 检测到该标志后用 `start /B` 而不是 `start /min`，
'      子进程继承这个隐藏控制台 —— 全程零窗口
'
' 手动运行 bat 时（无该标志）仍保持原有 /min 行为，不影响排障。
Option Explicit
Dim ws
Set ws = CreateObject("WScript.Shell")

ws.Environment("PROCESS").Item("MSCMS_SILENT") = "1"
ws.CurrentDirectory = "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19"
ws.Run "cmd /c ""C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\_autostart_mscms.bat""", 0, False

Set ws = Nothing
WScript.Quit 0
