#requires -Version 5.1
# OYours / MSCMS v14 -- P0 post-flight verification.
# Read-only. Safe to run at any time, elevated or not.
# Exit code = number of failed checks (0 = all pass). WARNs do not affect the exit code.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File _p0_verify.ps1
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads this file as ANSI, so any
# non-ASCII literal would be silently mangled and the checks would never match.
#
# 2026-10-12 additions:
#   [1b] watchdog code freshness, [4b] exit-guard code freshness, [6] relay freshness.
#   Iron rule "the file was changed is NOT the change is live" is now machine-checked
#   for every long-lived service: the running process MUST have started AFTER the
#   source file was last written. (This check caught a real timezone mistake today:
#   a file mtime of 13:38Z vs a process start of 12:32Z looked newer at a glance
#   because the two numbers were in different timezones.)

$ErrorActionPreference = 'Continue'
$fail = 0
$pass = 0
$warn = 0

function Say([string]$tag, [string]$msg) {
  if ($tag -eq 'PASS') { $script:pass++; Write-Host ("  [PASS] " + $msg) }
  elseif ($tag -eq 'FAIL') { $script:fail++; Write-Host ("  [FAIL] " + $msg) }
  elseif ($tag -eq 'WARN') { $script:warn++; Write-Host ("  [WARN] " + $msg) }
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

# Freshness: did the running process start after its source file was written?
function CheckFresh([string]$label, $procStart, [string]$srcPath, [bool]$fatal) {
  if (-not (Test-Path $srcPath)) { Say WARN ($label + ": source missing -> " + $srcPath); return }
  if ($null -eq $procStart)   { Say WARN ($label + ": process start time unknown"); return }
  $fmt = Get-Item $srcPath
  $verdict = ''
  if ($procStart -gt $fmt.LastWriteTime) { $verdict = 'FRESH (process started after the last edit)' }
  else { $verdict = 'STALE (process predates the last edit -- restart it)' }
  $msg = $label + ": start=" + $procStart.ToString('yyyy-MM-dd HH:mm:ss') +
         "  file=" + $fmt.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + "  -> " + $verdict
  if ($verdict.StartsWith('FRESH')) { Say PASS $msg }
  elseif ($fatal) { Say FAIL $msg } else { Say WARN $msg }
}

$ROOT = 'C:\Users\AS\WorkBuddy\2026-06-13-19-42-19'

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
Write-Host ""
Write-Host "[1b] watchdog code freshness"
CheckFresh 'watchdog' $ctrlStart ($ROOT + '\tools\mscms-watchdog.js') $true

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
      Say WARN "heap cap not on THIS instance yet -- it is baked into the watchdog and takes effect the next time 3002 is launched"
    }
    try {
      $rss = [math]::Round((Get-Process -Id $pidM -ErrorAction Stop).WorkingSet64 / 1MB, 0)
      Say INFO ("RSS = " + $rss + " MB")
      if ($rss -gt 3500) { Say FAIL "RSS above 3500 MB -- leak not contained" }
      else { Say PASS "RSS below the danger line (3500 MB)" }
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
Write-Host ""
Write-Host "[2b] 3002 code freshness (the P0-5 LRU fix lives in http-client.js)"
$DUP = 'D:\MSCMS-Desktop\resources\http-client.js'
CheckFresh 'main:3002' $startM $DUP $true

# ---------------------------------------------------------------- 3. relay
Write-Host ""
Write-Host "[3] relay :10809 (single outbound path)"
$pidR = Get-ListenerPid 10809
$startR = $null
if ($pidR -gt 0) {
  Say PASS "port 10809 LISTENING pid=$pidR"
  $ir = Get-ProcInfo $pidR
  if ($ir) { $startR = $ir.CreationDate; Say INFO ("started = " + $ir.CreationDate) }
} else { Say FAIL "port 10809 NOT listening" }

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
$startE = $null
if ($pidE -gt 0) {
  Say PASS "port 20779 LISTENING pid=$pidE"
  $ie = Get-ProcInfo $pidE
  if ($ie) { $startE = $ie.CreationDate; Say INFO ("started = " + $ie.CreationDate) }
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
Write-Host ""
Write-Host "[4b] exit-guard code freshness"
CheckFresh 'exit-guard' $startE ($ROOT + '\tools\exit-guard.js') $false

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
Write-Host ""
Write-Host "[5b] 3002 agent-cache diagnostics (P0-5: bounded LRU + release)"
try {
  $newest = Get-ChildItem -Path 'D:\mscms-ws\logs' -Filter 'server-3002-*.log' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest) {
    Say INFO ("log = " + $newest.Name)
    $hit = Select-String -Path $newest.FullName -Pattern '[http-client] agent' -SimpleMatch -ErrorAction SilentlyContinue |
           Select-Object -Last 1
    if ($hit) { Say PASS ("found: " + (AsciiOnly $hit.Line.Trim())) }
    else { Say INFO "diagnostic line not emitted yet (first one appears ~20 min after 3002 starts)" }
    $pc = @(Select-String -Path $newest.FullName -Pattern '[proxy-circuit]' -SimpleMatch -ErrorAction SilentlyContinue)
    Say INFO ("[proxy-circuit] lines in this log = " + $pc.Count + "   (rate-limited to ~40 per 5 min window after the fix)")
  } else { Say INFO "no server-3002 log file found" }
} catch { Say INFO ("log scan failed: " + $_.Exception.Message) }

# ------------------------------------------------------ 6. relay freshness
Write-Host ""
Write-Host "[6] relay code freshness"
CheckFresh 'bd-relay' $startR ($ROOT + '\tools\bd-tls-forwarder.js') $false

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "=================================================================="
Write-Host ("  RESULT:  " + $pass + " passed, " + $fail + " failed, " + $warn + " warn")
if ($fail -eq 0) { Write-Host "  ALL CHECKS PASSED (no failures)." }
else { Write-Host "  NOT fully applied -- see [FAIL] lines above." }
if ($warn -gt 0) { Write-Host "  WARNs are non-fatal (e.g. a fix that only applies at the next service launch)." }
Write-Host "=================================================================="
Write-Host ""
exit $fail
