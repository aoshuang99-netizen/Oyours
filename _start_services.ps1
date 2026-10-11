# MSCMS 服务开机自启（幂等）：主系统 3002(生产 50云手机) + 养号 3005
# 触发：当前用户 Startup 文件夹副本（登录时自动运行）
# 端口已 LISTENING 则跳过，避免重复拉起 / 端口冲突

$WS = "C:\Users\AS\WorkBuddy\2026-06-13-19-42-19"

# ── 单实例互斥体（2026-09-15 新增）────────────────────────────────────
# Startup 文件夹里同时存在多个 MSCMS 自启入口（MSCMS_ServicesStartup.cmd /
# MSCMS_Watchdog.cmd / mscms-services.bat），登录时可能被并发执行
#   → 同时判定"3307 未监听" → 双启 mysqld → 数据目录锁冲突，MySQL 反而起不来。
# 用命名互斥体串行化：后到者立即退出，保证只有一个实例真正执行自启流程。
$script:MsMutex = New-Object System.Threading.Mutex($false, 'MSCMS_StartServices_Lock')
$script:MsHasLock = $false
try { $script:MsHasLock = $script:MsMutex.WaitOne(0, $false) } catch { $script:MsHasLock = $true }
if (-not $script:MsHasLock) { exit 0 }

# ── 关于子进程输出编码（2026-09-15 记录，重要）─────────────────────────
# PS 5.1 在 zh-CN 下会用 GBK 解码原生命令的 stdout，而 node 输出的是 UTF-8，
# 结果捕获到的中文全是乱码（实测 startup.log 里 对账完成 存成了乱码）。
# 注意：[Console]::OutputEncoding = UTF8 这条在非交互会话里设不上，
# 异常会被静默吞掉，看起来改了其实没生效。
# 所以本脚本一律不让 PS 去解码子进程 stdout，而是让 cmd 重定向到文件、
# 再用显式 UTF-8 读回来（见 Sync-RuntimeCode）。

# ── managed node 真身探测 ────────────────────────────────────────────
# versions 目录下同时存在 junction 软链(22.22.2)与真实目录(22.22.2-2)。
# 硬编码 "22.22.2\node.exe" 会 ENOENT —— 2026-09-04 排查发现开机自启长期静默失败。
# 改为：优先真实目录，其次按 semver 倒序扫描所有版本目录，取第一个真实存在的 node.exe。
$versionsDir = "C:\Users\AS\.workbuddy\binaries\node\versions"
$candidates = New-Object System.Collections.ArrayList
[void]$candidates.Add((Join-Path $versionsDir "22.22.2-6\node.exe"))
Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+' } |
  Sort-Object { [version]($_.Name -replace '^(\d+\.\d+\.\d+).*', '$1') } -Descending |
  ForEach-Object { [void]$candidates.Add((Join-Path $_.FullName 'node.exe')) }
$NODE = $null
foreach ($c in $candidates) { if (Test-Path $c) { $NODE = $c; break } }

# NODE_PATH 优先工作区自带依赖（server.js 依赖 mysql2/undici 等），缺失时回退全局 workspace
$WS_NODE_MODULES = Join-Path $WS 'node_modules'
$NODE_PATH = if (Test-Path $WS_NODE_MODULES) { $WS_NODE_MODULES } else { "C:\Users\AS\.workbuddy\binaries\node\workspace\node_modules" }

# ── 存储根：所有运行时写入一律落 D 盘 ──────────────────────────────
# 背景：C 盘曾 195G/195G 完全写满导致 DataStore 全量 ENOSPC；
#       且后台 node 进程经 junction 覆盖已存在文件会 EPERM。
# 因此：代码留 C 盘（只读），一切写入走 D 盘真实路径。详见 storage-paths.js。
# 下面的环境变量会被 Launch 启动的 node 子进程继承。
$STORAGE_ROOT = if ($env:MSCMS_STORAGE_ROOT) { $env:MSCMS_STORAGE_ROOT } else { 'D:\mscms-ws' }
$env:MSCMS_STORAGE_ROOT = $STORAGE_ROOT
# 说明：默认 data2 —— 原 data 目录中数个大文件被 Windows Defender(MsMpEng) 扫描时锁定，
#       导致高频 flush 报 EPERM；换目录后归零。根治需管理员执行：
#       Add-MpPreference -ExclusionPath "D:\mscms-ws"
# 注意：默认目录必须与运行中的实际数据目录一致（D:\mscms-ws\data）。
# 曾默认 'data2'，导致自启拉起的实例读写另一份空数据，与正在运行的实例数据错位。
$env:DATA_DIR      = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $STORAGE_ROOT 'data' }
$env:LOG_DIR       = Join-Path $STORAGE_ROOT 'logs'
$env:MSCMS_TMP_DIR = Join-Path $STORAGE_ROOT 'tmp'
$env:TEMP = 'D:\mscms-tmp'
$env:TMP  = 'D:\mscms-tmp'
foreach ($d in @($env:DATA_DIR, $env:LOG_DIR, $env:MSCMS_TMP_DIR, $env:TEMP)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

$LOGDIR = $env:LOG_DIR
if (-not (Test-Path $LOGDIR)) { New-Item -ItemType Directory -Path $LOGDIR | Out-Null }
$LOG = Join-Path $LOGDIR "startup.log"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

 Write-StartupLog($message) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try {
    [System.IO.File]::AppendAllText($LOG, "[$stamp] $message" + [Environment]::NewLine, $Utf8NoBom)
  } catch {
    # Logging must never prevent the services from starting.
  }
}

 PortInUse($port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ar = $c.BeginConnect("", $port, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(1500, $false)
    if ($ok -and $c.Connected) { $c.Close(); return $true }
    $c.Close(); return $false
  } catch { return $false }
}

 Launch($port, $envMap, $scriptName, $label, $logName, $procPattern) {
  # 进程级单实例守卫：3002 启动需数分钟，此期间端口尚未 LISTENING，
  # 仅靠端口检查会被误判为"未运行"而重复拉起 —— 曾导致 2~4 个实例互抢端口与数据文件。
  # $procPattern 用 ? 通配路径分隔符，可同时匹配正斜杠/反斜杠两种写法。
  if ($procPattern) {
    $existing = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
      $_.CommandLine -and $_.CommandLine -like $procPattern
    })
    if ($existing.Count -gt 0) {
      Write-StartupLog "${label} 已有进程在运行 (PID $($existing[0].ProcessId))，跳过"
      return
    }
  }
  if (PortInUse $port) {
    Write-StartupLog "${port} 已监听，跳过 ${label}"
    return
  }
  Write-StartupLog "启动 ${label} (${port})"
  # 在 PowerShell 会话内设置环境变量，child 进程（node）会继承 —— 比 cmd /c "set &&" 链更可靠
  $env:ELECTRON_RUN_AS_NODE = ''
  $env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
  $env:NODE_PATH = $NODE_PATH
  foreach ($k in $envMap.Keys) { [Environment]::SetEnvironmentVariable($k, $envMap[$k], 'Process') }
  # 【2026-09-15 修复静默失败】旧实现直接 Process::Start(node)，UseShellExecute 为默认 true。
  #   实测：非交互会话下它会【静默失败】—— startup.log 写了"启动 主MSCMS(3002)"，
  #   但进程表里根本没有该进程，且没有任何异常/报错，故障被完全吞掉，
  #   直到人工核对端口才发现"启动了但没起来"。
  #   现改为 cmd.exe /c + 输出重定向（UseShellExecute=$false + CreateNoWindow）：
  #     · 启动失败会在 $logFile 里留下真实的 node 报错（可观测）
  #     · 不产生独立控制台窗口（用户对弹窗敏感）
  #     · 避开 PS 5.1 在 RedirectStandard* 下的 Path/PATH 大小写冲突 bug
  #   环境变量通过 $env: 继承（上面已 SetEnvironmentVariable）。
  $logFile = Join-Path $LOGDIR "$logName.log"
  $cmdLine = "`"$NODE`" `"$WS\$scriptName`" >> `"$logFile`" 2>&1"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
  $psi.Arguments = "/c $cmdLine"
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $WS
  [System.Diagnostics.Process]::Start($psi) | Out-Null
  Start-Sleep -Seconds 4
}

# ── 2026-09-15 新增：运行时代码同步（必须先于任何服务拉起）────────────
# 为什么必须先做：看门狗（tools/mscms-watchdog.js）的 main:3002 是用
#   cwd = D:\MSCMS-Desktop\resources 拉起 server.js 的，即【桌面版那份代码】；
#   而日常修复都在工作区。若不先同步，看门狗一旦重启 3002 就会把刚修好的东西
#   静默 revert 回旧版本。实测 2026-09-15：工作区有 6 个文件（含 P0-1/P0-2/P0-3
#   发布链路修复）在桌面版里根本不存在 —— 这是个会无声吃掉修复的雷。
 Sync-RuntimeCode {
  $sync = Join-Path $WS 'tools\sync-desktop.js'
  if (-not (Test-Path $sync)) { Write-StartupLog "未找到 sync-desktop.js，跳过代码同步"; return }
  $tmp = Join-Path $env:MSCMS_TMP_DIR 'sync-once.log'
  try {
    # 不让 PowerShell 解码子进程 stdout（原因见文件顶部「关于子进程输出编码」）：
    #   交给 cmd 重定向到文件 → 再用显式 UTF-8 读回，中文才不会变乱码。
    cmd.exe /c "`"$NODE`" `"$sync`" --once > `"$tmp`" 2>&1" | Out-Null
    if (-not (Test-Path $tmp)) { Write-StartupLog "代码同步: （未产生输出文件）"; return }
    $raw = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
    # 只摘关键行入日志（全量输出会把一行撑到上千字符，反而掩盖重点）
    $lines = $raw -split "`r?`n"
    $summary = ($lines | Where-Object { $_ -match '对账完成|一次性对账结束|待重启' }) -join ' | '
    if (-not $summary) { $summary = ($lines | Where-Object { $_.Trim() } | Select-Object -Last 1) }
    if (-not $summary) { $summary = '（无输出）' }
    Write-StartupLog ("代码同步: " + $summary)
  } catch {
    Write-StartupLog ("代码同步失败（非致命）: " + $_.Exception.Message)
  }
}

# ── 2026-09-15 新增：MySQL(3307) 自启 ─────────────────────────────────
# 它是 Tumblr 24h「(账号,内容)」去重闸门的数据源，却不在任何自启/守护清单里；
# 09-14 19:56 一次非正常终止后整整 10 天无人发现（去重闸门全程缺失）。
# 数据目录在 D:\mscms-mysql-data —— C 盘曾写满导致 08-28 启动失败，故不放 C 盘。
 Start-Mysql {
  if (PortInUse 3307) { Write-StartupLog "3307 已监听，跳过 MySQL"; return $true }
  $basedir = Join-Path $WS 'mysql-8.0.41-winx64'
  $mysqld  = Join-Path $basedir 'bin\mysqld.exe'
  if (-not (Test-Path $mysqld)) { Write-StartupLog "❌ 未找到 mysqld.exe: $mysqld"; return $false }
  $myLog   = Join-Path $LOGDIR 'mysql-3307.log'
  $cmdLine = "`"$mysqld`" --basedir=`"$basedir`" --datadir=`"D:/mscms-mysql-data`" --port=3307 --console >> `"$myLog`" 2>&1"
  Write-StartupLog "启动 MySQL (3307)"
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
    $psi.Arguments = "/c $cmdLine"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $basedir
    [System.Diagnostics.Process]::Start($psi) | Out-Null
  } catch {
    Write-StartupLog ("❌ MySQL 启动失败: " + $_.Exception.Message)
    return $false
  }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if (PortInUse 3307) { Write-StartupLog "✅ MySQL 已监听 3307"; return $true }
    Start-Sleep -Seconds 2
  }
  Write-StartupLog "❌ MySQL 60s 内未监听 3307（查 $myLog）"
  return $false
}

# ── 2026-09-15 新增：看门狗自启 ───────────────────────────────────────
# 看门狗以 :3011 作单实例锁；它是 3002/3005/3010/exitguard/visitor/sync/mpt/mysql
# 的统一探活者。此前它的开机入口 MSCMS_Watchdog.cmd 硬编码了【已不存在】的 node
# 版本目录（22.22.2-2）→ ENOENT 静默失败 → 看门狗从未真正跑起来
# → 3005/3010/3012/3013/8080 与出口层长期无人守护。
 Start-Watchdog {
  if (PortInUse 3011) { Write-StartupLog "3011 已监听，看门狗已在运行"; return $true }
  $wd = Join-Path $WS 'tools\mscms-watchdog.js'
  if (-not (Test-Path $wd)) { Write-StartupLog "❌ 未找到 mscms-watchdog.js"; return $false }
  $wdLog = Join-Path $LOGDIR 'watchdog-boot.log'
  $env:NODE_PATH = $NODE_PATH
  $env:ELECTRON_RUN_AS_NODE = ''
  $cmdLine = "`"$NODE`" `"$wd`" >> `"$wdLog`" 2>&1"
  Write-StartupLog "启动 看门狗 (mscms-watchdog.js)"
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
    $psi.Arguments = "/c $cmdLine"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $WS
    [System.Diagnostics.Process]::Start($psi) | Out-Null
  } catch {
    Write-StartupLog ("❌ 看门狗启动失败: " + $_.Exception.Message)
    return $false
  }
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if (PortInUse 3011) { Write-StartupLog "✅ 看门狗已就绪（锁 :3011）"; return $true }
    Start-Sleep -Seconds 2
  }
  Write-StartupLog "❌ 看门狗 45s 内未占用 3011（查 $wdLog）"
  return $false
}

Write-StartupLog "=== 自启检查开始 (node=$NODE, DATA_DIR=$env:DATA_DIR) ==="

# 0) 工作区 → 运行时代码同步（必须最先做，否则看门狗会用旧代码拉起 3002）
Sync-RuntimeCode

# 1) MySQL (3307)：去重闸门数据源，独立于看门狗先起
Start-Mysql | Out-Null

# 2) 看门狗：服务的唯一 owner
#    3002 / 3005 / 3010 / exitguard:20779 / visitor:3012 / sync:3013 / mpt:8080 / mysql:3307
$watchdogUp = Start-Watchdog

# 3) 兜底：看门狗未就绪时才回退到直接拉起核心三服务（旧路径，保可用性）
if (-not $watchdogUp) {
  Write-StartupLog "⚠️ 看门狗未就绪 → 回退到直接拉起 3002/3005/3010"
  Launch 3002 @{ CLOUD_PHONE_COUNT='50'; CLOUD_PHONE_MODE='cloud'; PUBLIC_DOMAIN='hlua.cc.cd'; PORT='3002'; TUMBLR_API_RPM='25'; DATA_DIR=$env:DATA_DIR } "server.js" "主MSCMS(3002)" "server-3002.log" '*2026-06-13-19-42-19?server.js*'
  Launch 3005 @{ TUMBLR_NURTURE_PORT='3005'; TUMBLR_NURTURE_DEVICE='1'; TUMBLR_NURTURE_AUTO='1'; TUMBLR_PROXY='http://:10808'; TUMBLR_API_RPM='25'; DATA_DIR=$env:DATA_DIR } "tumblr-nurture-server.js" "养号(3005)" "nurture-3005.log" '*2026-06-13-19-42-19?tumblr-nurture-server.js*'
  Launch 3010 @{ CONTENT_GEN_PORT='3010'; DATA_DIR=$env:DATA_DIR } "content-gen\service.js" "content-gen(3010)" "contentgen-3010.log" '*2026-06-13-19-42-19?content-gen?service.js*'
} else {
  Write-StartupLog "看门狗已接管 3002/3005/3010，跳过直接拉起"
}

# 2.5) 多出口代理池激活（在 3005 进程内运行 freefq→sing-box→本地 HTTP 代理，探测出口 IP 去重写入 proxy-pool.json）
#      —— 当前环境仅 1 个可用出口 IP（10808/7890 共用 ，freefq 节点已失效）；
#         一旦补充可达的多出口代理订阅，开机即自动分散账号到不同 IP，无需改代码。
 WaitForPort($port, $timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (PortInUse $port) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
# 2026-09-15：等待从 40s 放宽到 240s —— 3005 现由看门狗拉起，而看门狗要先过
#   mysql:3307 的探活、且 3002 冷启动要 12~13 分钟，40s 常常等不到 3005 就绪。
if (WaitForPort 3005 240) {
  try {
    Write-StartupLog "触发 3005 多出口代理池激活"
    $activateJs = 'const http=require("http");const b=JSON.stringify({desired:8});const r=http.request({host:"",port:3005,path:"/api/proxy/activate",method:"POST",timeout:200000"":"application/json","Content-Length":Buffer.byteLength(b)}},res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{console.log("activate",res.statusCode,d)})});r.on("error",e=>console.log("activate ERR",e.message));r.write(b);r.end();'
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = $NODE
    $pinfo.Arguments = "-e `"$activateJs`""
    $pinfo.UseShellExecute = $true
    $pinfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized
    [System.Diagnostics.Process]::Start($pinfo) | Out-Null
  } catch {
    Write-StartupLog ("代理池激活触发失败（非致命）: " + $_.Exception.Message)
  }
} else {
  Write-StartupLog "3005 未在预期时间内就绪，跳过代理池激活"
}

Write-StartupLog "=== 自启检查完成 ==="
