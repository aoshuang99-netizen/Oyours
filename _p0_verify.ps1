#requires -Version 5.1
# OYours / MSCMS v14 -- P0 admin-apply post-flight verification.
# Read-only. Safe to run at any time, elevated or not.
# Exit code = number of failed checks (0 = all pass).
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File _p0_verify.ps1
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads this file as ANSI, so any
# non-ASCII literal would be silently mangled and the checks would never match.

$ErrorActionPreference = 'Continue'
$fail = 0
$pass = 0

function Say([string]$tag, [string]$msg) {
  if ($tag -eq 'PASS') { $script:pass++; Write-Host ("  [PASS] " + $msg) }
  elseif ($tag -eq 'FAIL') { $script:fail++; Write-Host ("  [FAIL] " + $msg) }
  else { Write-Host ("         " + $msg) }
}

function AsciiOnly([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '[^\x20-\x7E]', '?')
}

function Get-ListenerPid([int]$port) {
  try {
    $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
         Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch {}
  return 0
}

function Get-ProcInfo([int]$pidv) {
  if ($pidv -le 0) { return $null }
  try { return Get-CimInstance Win32_Process -Filter "ProcessId=$pidv" -ErrorAction Stop } catch { return $null }
}

Write-Host ""
Write-Host "=================================================================="
Write-Host "  OYours / MSCMS v14  --  P0 post-flight verification"
Write-Host "  time = $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "=================================================================="

# ---------------------------------------------------------------- 1. watchdog
Write-Host ""
Write-Host "[1] watchdog :3011 (carrier of the P0-4 / P0-2 fixes)"
$pidW = Get-ListenerPid 3011
$ctrlStart = $null
if ($pidW -gt 0) {
  Say PASS "port 3011 LISTENING pid=$pidW"
  $iw = Get-ProcInfo $pidW
  if ($iw) { $ctrlStart = $iw.CreationDate; Say INFO ("started = " + $iw.CreationDate) }
} else {
  Say FAIL "port 3011 NOT listening -- watchdog is down (WinSW should auto-restart within 10-20s)"
}

# ---------------------------------------------------------------- 2. main 3002
Write-Host ""
Write-Host "[2] main :3002 (heap cap + RSS)"
$pidM = Get-ListenerPid 3002
$startM = $null
if ($pidM -gt 0) {
  Say PASS "port 3002 LISTENING pid=$pidM"
  $im = Get-ProcInfo $pidM
  if ($im) {
    $startM = $im.CreationDate
    Say INFO ("started = " + $im.CreationDate)
    if ($im.CommandLine -match 'max-old-space-size=(\d+)') {
      Say PASS ("heap cap ACTIVE --max-old-space-size=" + $Matches[1] + "MB")
    } else {
      Say FAIL "heap cap NOT ACTIVE -- no --max-old-space-size in the 3002 command line"
    }
    try {
      $rss = [math]::Round((Get-Process -Id $pidM -ErrorAction Stop).WorkingSet64 / 1MB, 0)
      Say INFO ("RSS = " + $rss + " MB")
      if ($rss -gt 3500) { Say FAIL "RSS above 3500 MB -- leak not contained (target: cap keeps it near 3072 MB)" }
      else { Say PASS "RSS within the expected band" }
    } catch { Say INFO "RSS unavailable (access denied)" }
  }
  try {
    $t0 = Get-Date
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/api/v14/data/content?limit=1' -TimeoutSec 20
    $ms = [math]::Round(((Get-Date) - $t0).TotalMilliseconds, 0)
    Say PASS ("HTTP OK in " + $ms + " ms")
  } catch { Say FAIL ("HTTP probe failed: " + $_.Exception.Message) }
} else {
  Say FAIL "port 3002 NOT listening -- main service is down"
}

# ------------------------------------------- 2b. is the committed code LIVE?
# Iron rule: "the file was changed" is NOT "the change took effect".
# The only honest test is: did the running process start AFTER the file was written?
Write-Host ""
Write-Host "[2b] 3002 code freshness -- file changed is NOT change is live"
$DUP = 'D:\MSCMS-Desktop\resources\http-client.js'
if ($pidM -gt 0 -and (Test-Path $DUP)) {
  $fmt = Get-Item $DUP
  Say INFO ("http-client.js mtime = " + $fmt.LastWriteTime + "  size = " + $fmt.Length + " bytes")
  if ($startM -and $startM -gt $fmt.LastWriteTime) {
    Say PASS "3002 started AFTER http-client.js was updated -- the P0-5 fix is live"
  } else {
    Say FAIL "3002 started BEFORE http-client.js was updated -- restart 3002 for the P0-5 fix"
  }
} else {
  Say INFO "skipped (3002 down, or D: copy missing)"
}

# ---------------------------------------------------------------- 3. relay
Write-Host ""
Write-Host "[3] relay :10809 (new direct-bypass whitelist)"
$pidR = Get-ListenerPid 10809
if ($pidR -gt 0) { Say PASS "port 10809 LISTENING pid=$pidR" } else { Say FAIL "port 10809 NOT listening" }

# real CONNECT through the relay: proves the relay still forwards after restart
if ($pidR -gt 0) {
  try {
    $cli = New-Object System.Net.Sockets.TcpClient
    $cli.ReceiveTimeout = 20000
    $cli.Connect('127.0.0.1', 10809)
    $st = $cli.GetStream()
    $req = [System.Text.Encoding]::ASCII.GetBytes("CONNECT api.tumblr.com:443 HTTP/1.1`r`nHost: api.tumblr.com:443`r`n`r`n")
    $st.Write($req, 0, $req.Length); $st.Flush()
    $buf = New-Object byte[] 512
    $n = $st.Read($buf, 0, 512)
    $line = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n).Split("`r")[0]
    $cli.Close()
    if ($line -match '200') { Say PASS ("CONNECT api.tumblr.com:443 -> " + $line) }
    else { Say FAIL ("CONNECT api.tumblr.com:443 -> " + $line) }
  } catch { Say FAIL ("CONNECT test failed: " + $_.Exception.Message) }
}

# ---------------------------------------------------------------- 4. exit-guard
Write-Host ""
Write-Host "[4] exit-guard :20779 (probe target decoupled from BrightData)"
$pidE = Get-ListenerPid 20779
if ($pidE -gt 0) {
  Say PASS "port 20779 LISTENING pid=$pidE"
  $ie = Get-ProcInfo $pidE
  if ($ie) { Say INFO ("started = " + $ie.CreationDate) }
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:20779/health' -TimeoutSec 20
    Say INFO ("probeTarget = " + $h.probeTarget)
    Say INFO ("probe       = " + $h.probe)
    Say INFO ("uptimeSec   = " + $h.uptimeSec)
    if ($h.probeTarget -eq 'www.qq.com:443') {
      Say PASS "probe target is the NEW direct-connect host (www.qq.com:443)"
    } else {
      Say FAIL ("probe target is still the OLD value (" + $h.probeTarget + ") -- exit-guard was NOT restarted")
    }
  } catch { Say FAIL ("health probe failed: " + $_.Exception.Message) }
} else {
  Say FAIL "port 20779 NOT listening"
}

# ---------------------------------------------------------------- 5. machine
Write-Host ""
Write-Host "[5] machine resources"
$os = Get-CimInstance Win32_OperatingSystem
$totGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$freGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
Say INFO ("total = " + $totGB + " GB, free = " + $freGB + " GB")
if ($freGB -lt 1.0) { Say FAIL "free memory under 1 GB -- resource exhaustion risk" } else { Say PASS "free memory ok" }

$agg = 0
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $agg += $_.WorkingSet64 }
$agg = [math]::Round($agg / 1MB, 0)
Say INFO ("aggregate node RSS = " + $agg + " MB")
if ($agg -gt 5000) { Say FAIL "aggregate node RSS above 5000 MB" } else { Say PASS "aggregate node RSS ok" }

# ----------------------------------------- 5b. P0-5 agent-cache observability
# The fix is observable by design: http-client.js prints one line every ~20 min
#   [http-client] agent-cache size=<n>/24 created=<n> retired=<n> ...
# If that line exists, the NEW code is definitely running AND the cache is bounded.
Write-Host ""
Write-Host "[5b] 3002 agent-cache diagnostics (P0-5 root fix: bounded LRU + release)"
try {
  $newest = Get-ChildItem -Path 'D:\mscms-ws\logs' -Filter 'server-3002-*.log' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest) {
    Say INFO ("log = " + $newest.Name)
    $hit = Select-String -Path $newest.FullName -Pattern '[http-client] agent' -SimpleMatch -ErrorAction SilentlyContinue |
           Select-Object -Last 1
    if ($hit) {
      Say PASS ("found: " + (AsciiOnly $hit.Line.Trim()))
    } else {
      Say INFO "diagnostic line not emitted yet (the first one appears ~20 min after 3002 restarts)"
    }
    $pc = @(Select-String -Path $newest.FullName -Pattern '[proxy-circuit]' -SimpleMatch -ErrorAction SilentlyContinue)
    Say INFO ("[proxy-circuit] lines in this log = " + $pc.Count + "  (after the fix: at most ~40 per 5 min window)")
  } else {
    Say INFO "no server-3002 log file found"
  }
} catch { Say INFO ("log scan failed: " + $_.Exception.Message) }

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "=================================================================="
Write-Host ("  RESULT:  " + $pass + " passed, " + $fail + " failed")
if ($fail -eq 0) { Write-Host "  ALL CHECKS PASSED -- the P0 fixes are live." }
else { Write-Host "  NOT fully applied -- see [FAIL] lines above." }
Write-Host "=================================================================="
Write-Host ""
exit $fail
