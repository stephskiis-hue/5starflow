# Runs from Windows Task Scheduler every 5 minutes, 6 am to 10 pm (install-request-gate.ps1 registers it).
# Costs zero Claude tokens when nothing is pending: it only starts a Claude session when
# /api/ai/requests/pending-count is above 0. Every run leaves one line in ~/.5starflow/request-gate.log.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
function Log($msg) { Write-FsfLog 'request-gate' $msg }
$quiet = (Get-Date).Minute -ge 5   # log "pending 0" once an hour, not every 5 min
try { Import-FsfEnv } catch { Log "aborted: $($_.Exception.Message)"; exit 1 }

# Keep this checkout (skills, playbooks, prompts) current so every MSI routine follows the latest rules.
# Fast-forward only: local edits or a diverged branch are left alone, and a failed pull never blocks the inbox.
$null = Invoke-FsfNative 'request-gate' 'git' @('-C', (Join-Path $PSScriptRoot '..\..\..\..'), 'pull', '--ff-only', '--quiet')

# The blog task prompt finds this checkout through FSF_REPO in ~/.5starflow/env: add it once.
try {
  if (-not $env:FSF_REPO) {
    $repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
    $envFile = Join-Path $FsfDir 'env'
    $raw = [IO.File]::ReadAllText($envFile)
    $sep = if ($raw.Length -and -not $raw.EndsWith("`n")) { "`r`n" } else { '' }   # never glue onto the token line
    Add-Content -Path $envFile -Value "${sep}FSF_REPO=$repo"
    $env:FSF_REPO = $repo
    Log "added FSF_REPO=$repo to ~/.5starflow/env"
  }
} catch { Log "could not add FSF_REPO: $($_.Exception.Message)" }

$py = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'py' }

# Hourly: copy what 5StarFlow put on the live site itself (Search Console tag, .htaccess redirects) into the site
# folder, so the 3 AM deploy keeps it. One API call, zero Claude tokens; quiet unless something was copied.
if (-not $quiet) {
  try { $null = Invoke-FsfNative 'seo-sync-live' $py @((Join-Path $PSScriptRoot 'seo_site.py'), 'sync-live') }
  catch { Log "seo sync-live failed to start: $($_.Exception.Message)" }
}

# Once a day, at the first check after 7 pm: rebuild the website's sitemaps and blog index from the real files
# (seo_site.py nightly, site folder in seo-site.json) so the 3 AM deploy uploads them. Zero Claude tokens.
# Its own log is ~/.5starflow/seo-site.log; a failure is logged and never blocks the inbox.
try {
  $seoStamp = Join-Path $FsfDir 'seo-site-nightly.stamp'
  $today = Get-Date -Format 'yyyy-MM-dd'
  $doneToday = (Test-Path $seoStamp) -and ((Get-Content $seoStamp -Raw).Trim() -eq $today)
  # a seo-site.json or seo_site.py pulled after tonight's run (a new exclude, a new fix) runs it again before the 3 AM deploy
  $cfgChanged = $doneToday -and @('seo-site.json', 'seo_site.py' | ForEach-Object { Join-Path $PSScriptRoot $_ } |
    Where-Object { (Test-Path $_) -and ((Get-Item $_).LastWriteTime -gt (Get-Item $seoStamp).LastWriteTime) }).Count -gt 0
  if ((Get-Date).Hour -ge 19 -and (-not $doneToday -or $cfgChanged)) {
    Set-Content -Path $seoStamp -Value $today
    $code = Invoke-FsfNative 'seo-nightly' $py @((Join-Path $PSScriptRoot 'seo_site.py'), 'nightly')
    Log "seo nightly exited $code"
  }
} catch { Log "seo nightly failed to start: $($_.Exception.Message)" }

# TextNow Watch (backend/scripts/textnow-watch.js): every 2 hours from 7 am to 9 pm, read the owner's TextNow line and post new
# messages to 5StarFlow. Zero Claude tokens, its own headless browser profile, READ ONLY. Needs a one-time
# `node backend\scripts\textnow-watch.js --login` on this PC. Its log is ~/.5starflow/textnow-watch.log; a failure never blocks the inbox.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$node = if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }
function Invoke-TextNowWatch {
  $code = Invoke-FsfNative 'textnow-watch' $node @((Join-Path $repoRoot 'backend\scripts\textnow-watch.js'))
  Log "textnow-watch exited $code"
  return $code
}
try {
  $tnStamp = Join-Path $FsfDir 'textnow-watch.stamp'
  $tnHour = (Get-Date).Hour
  $tnDue = ($tnHour -ge 7 -and $tnHour -lt 21) -and (-not (Test-Path $tnStamp) -or ((Get-Item $tnStamp).LastWriteTime -lt (Get-Date).AddMinutes(-115)))
  if ($tnDue) {
    New-Item -ItemType File -Force -Path $tnStamp | Out-Null   # stamp first: a crash must not retry every 5 minutes
    $tnCode = Invoke-TextNowWatch
    # a crash or parse hiccup retries in about 30 minutes; logged-out and rate-limited outcomes wait for the next slot
    if ($tnCode -in 1, 3) { (Get-Item $tnStamp).LastWriteTime = (Get-Date).AddMinutes(-85) }
  }
} catch { Log "textnow-watch failed to start: $($_.Exception.Message)" }

# E-transfer Recorder (backend/ai/prompts/etransfer-recorder.md): 8 am to 10 pm, at most every 10 minutes, and only when 5StarFlow has
# matched e-transfers waiting to be recorded in Jobber (to-record-count; zero in test mode or under DRY_RUN). Claude in Chrome
# enters each one with Collect Payment; the server re-reads the invoice before calling it paid. Waits while Chrome is busy or the
# Claude plan limit is waiting to reset; a failure never blocks the inbox.
try {
  $etStamp = Join-Path $FsfDir 'etransfer-recorder.stamp'
  $etHour = (Get-Date).Hour
  $etDue = ($etHour -ge 8 -and $etHour -lt 22) -and (-not (Test-Path $etStamp) -or ((Get-Item $etStamp).LastWriteTime -lt (Get-Date).AddMinutes(-10)))
  if ($etDue) {
    $etHeaders = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'operations' }
    $etPending = [int](Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/etransfers/to-record-count" -Headers $etHeaders -TimeoutSec 20).pending
    $etLimit = Join-Path $FsfDir 'claude-limit-until.txt'
    $etWait = (Test-Path $etLimit) -and ((Get-Date) -lt [datetime]::Parse((Get-Content $etLimit -Raw).Trim()))
    if ($etPending -gt 0 -and -not $etWait -and -not (Test-FsfChromeBusy)) {
      New-Item -ItemType File -Force -Path $etStamp | Out-Null   # stamp first: a crash must not retry every 5 minutes
      Log "etransfer-recorder: $etPending waiting, starting"
      Lock-FsfChrome
      try {
        $etChrome = Ensure-FsfChrome -Log 'request-gate'
        if ($etChrome -eq 'missing') { [void](Ensure-FsfChrome -Restart -Log 'request-gate') }
        $etPrompt = ((Get-Content (Join-Path $PSScriptRoot '..\etransfer-recorder.md') -Raw) -split '```')[1].Trim()
        $et = Invoke-FsfClaude $etPrompt $repoRoot 30 'request-gate'
        $etTail = if ($et.out) { $et.out.Substring([Math]::Max(0, $et.out.Length - 300)) } else { '' }
        Log "etransfer-recorder: claude exited $($et.code) $etTail"
      } finally { Unlock-FsfChrome }
    }
  }
} catch { Log "etransfer-recorder failed to start: $($_.Exception.Message)" }

# TextNow Insight (backend/ai/prompts/textnow-insight.md): once a day, the first quiet check after 7 pm. Claude in Chrome reads the
# day's threads, records what it WOULD have replied, cross-checks the TextNow page and posts the owner summary (5StarFlow texts it
# every digestEveryDays days). READ ONLY. Waits while an owner request is pending, Chrome is busy or the Claude plan limit is
# waiting to reset; up to 3 tries a day.
try {
  $insStamp = Join-Path $FsfDir 'textnow-insight.stamp'
  $insDay = Get-Date -Format 'yyyy-MM-dd'
  $insTxt = if (Test-Path $insStamp) { (Get-Content $insStamp -Raw).Trim() } else { '' }
  $insTries = if ($insTxt -match "^${insDay}:(\d+)$") { [int]$Matches[1] } else { 0 }
  $insHour = (Get-Date).Hour
  if ($insTxt -ne "${insDay}:ok" -and $insTries -lt 3 -and $insHour -ge 19 -and $insHour -lt 23) {
    $insLimit = Join-Path $FsfDir 'claude-limit-until.txt'
    $insWait = (Test-Path $insLimit) -and ((Get-Date) -lt [datetime]::Parse((Get-Content $insLimit -Raw).Trim()))
    $insHeaders = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'communication' }
    $insPending = 0
    try { $insPending = [int](Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/requests/pending-count" -Headers $insHeaders -TimeoutSec 20).pending } catch { }
    if (-not $insWait -and $insPending -lt 1 -and -not (Test-FsfChromeBusy)) {
      Set-Content -Path $insStamp -Value "${insDay}:$($insTries + 1)"   # before the run: a crash must not loop all evening
      Log "textnow-insight: starting (try $($insTries + 1))"
      [void](Invoke-TextNowWatch)   # fresh messages first
      Lock-FsfChrome
      try {
        $insChrome = Ensure-FsfChrome -Log 'request-gate'
        if ($insChrome -eq 'missing') { [void](Ensure-FsfChrome -Restart -Log 'request-gate') }
        $insPrompt = ((Get-Content (Join-Path $PSScriptRoot '..\textnow-insight.md') -Raw) -split '```')[1].Trim()
        $ins = Invoke-FsfClaude $insPrompt $repoRoot 45 'request-gate'
        $insTail = if ($ins.out) { $ins.out.Substring([Math]::Max(0, $ins.out.Length - 300)) } else { '' }
        Log "textnow-insight: claude exited $($ins.code) $insTail"
        if ($ins.code -eq 0 -and $ins.out -match 'INSIGHT_RESULT:\s*(done|needs_owner)') { Set-Content -Path $insStamp -Value "${insDay}:ok" }
      } finally { Unlock-FsfChrome }
    }
  }
} catch { Log "textnow-insight failed to start: $($_.Exception.Message)" }

$lock = Join-Path $FsfDir 'request-inbox.lock'
if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddHours(-2))) { Log 'skip: a run is in progress'; exit 0 }

$headers = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'orchestrator' }
try {
  $pending = (Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/requests/pending-count" -Headers $headers -TimeoutSec 20).pending
} catch { Log "pending-count failed: $($_.Exception.Message)"; exit 1 }
if ($pending -lt 1) { if (-not $quiet) { Log 'pending 0' }; exit 0 }
if (Test-FsfChromeBusy) { Log "skip: Chrome is busy with another run (chrome.lock), $pending request(s) stay pending"; exit 0 }

$claude = if ($env:CLAUDE_BIN) { $env:CLAUDE_BIN } else { 'claude' }
Log "pending ${pending}, starting $claude"
New-Item -ItemType File -Force -Path $lock | Out-Null
Lock-FsfChrome
try {
  $chrome = Ensure-FsfChrome -Log 'request-gate'
  if ($chrome -eq 'missing') { [void](Ensure-FsfChrome -Restart -Log 'request-gate') }
  $promptFile = Join-Path $PSScriptRoot '..\request-inbox.md'
  $prompt = ((Get-Content $promptFile -Raw) -split '```')[1].Trim()
  $code = Invoke-FsfNative 'request-gate' $claude @('-p', $prompt, '--chrome', '--dangerously-skip-permissions', '--model', 'sonnet')
  Log "claude exited $code"
} catch {
  Log "claude failed to start: $($_.Exception.Message)"
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
  Unlock-FsfChrome
}
