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
  if ((Get-Date).Hour -ge 19 -and -not $doneToday) {
    Set-Content -Path $seoStamp -Value $today
    $code = Invoke-FsfNative 'seo-nightly' $py @((Join-Path $PSScriptRoot 'seo_site.py'), 'nightly')
    Log "seo nightly exited $code"
  }
} catch { Log "seo nightly failed to start: $($_.Exception.Message)" }

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
