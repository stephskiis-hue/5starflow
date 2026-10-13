# One-time setup of TextNow Watch on the MSI PC. Run in PowerShell, logged in as the Windows user who will be signed in:
#   powershell -ExecutionPolicy Bypass -File backend\ai\prompts\msi\install-textnow-watch.ps1
# It checks the server has TextNow Watch, installs what the watcher needs, opens a window for YOU to sign in to TextNow
# (it never types a password), loads the message history, and shows what 5StarFlow now sees. Safe to re-run.
# The schedule itself rides on the existing request gate (install-request-gate.ps1): every 2 hours 7 am to 9 pm, plus the
# daily Claude in Chrome review after 7 pm.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

try { Import-FsfEnv } catch { throw "$($_.Exception.Message)" }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$backend = Join-Path $repo 'backend'
$headers = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'communication' }

Write-Host '1/6 Updating this checkout...'
$null = Invoke-FsfNative 'textnow-setup' 'git' @('-C', $repo, 'pull', '--ff-only', '--quiet')

Write-Host '2/6 Checking the server has TextNow Watch...'
try {
  $null = Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/textnow/status" -Headers $headers -TimeoutSec 30
} catch {
  throw "The server at $env:FIVESTARFLOW_URL does not answer /api/ai/textnow/status yet ($($_.Exception.Message)). The TextNow Watch code has to be merged and deployed first, then re-run this."
}

Write-Host '3/6 Installing what the watcher needs (npm install in backend, a few minutes the first time)...'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'node is not on PATH. Install Node.js 20+ and re-run.' }
$envFile = Join-Path $FsfDir 'env'
$lines = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*NODE_BIN\s*=' }
$lines += "NODE_BIN=$($node.Source)"   # Task Scheduler does not get the interactive PATH
Set-Content -Path $envFile -Value $lines
Push-Location $backend
try {
  $code = Invoke-FsfNative 'textnow-setup' 'npm' @('install', '--no-audit', '--no-fund')
  if ($code -ne 0) { throw "npm install failed (exit $code). See ~/.5starflow/textnow-setup.log" }
} finally { Pop-Location }

Write-Host '4/6 Sign in to TextNow. A normal Chrome window opens on TextNow (its own profile, separate from your everyday Chrome): log in yourself, up to 10 minutes. Do not close it; this script carries on by itself once you are in.'
Push-Location $backend
try {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $node.Source 'scripts\textnow-watch.js' '--login' 2>&1 | ForEach-Object { Write-Host "  $_" }
  $loginCode = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($loginCode -eq 3) { throw "Signed in, but the watcher could not read TextNow's page (its calls may differ from what we expected). Run:  node backend\scripts\textnow-watch.js --probe   then click one conversation when asked, and paste the output into the chat." }
  if ($loginCode -eq 2) { throw "TextNow did not let the sign-in finish (logged out, timed out, or a bot check). Close the Chrome window, wait about 30 minutes, then run this script again. Do not keep retrying the captcha: repeated failures make TextNow stricter." }
  if ($loginCode -ne 0) { throw "The first read did not finish (exit $loginCode). If TextNow showed a captcha or verification, complete it in the window and re-run this script." }

  Write-Host '5/6 Loading the TextNow history (this can take several minutes; it pages slowly on purpose)...'
  $ErrorActionPreference = 'Continue'
  & $node.Source 'scripts\textnow-watch.js' '--backfill' 2>&1 | ForEach-Object { Write-Host "  $_" }
  $ErrorActionPreference = $prev
} finally { Pop-Location }

Write-Host '6/6 What 5StarFlow sees now:'
$s = Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/textnow/status" -Headers $headers -TimeoutSec 30
Write-Host "  watcher: $($s.health), last read $($s.lastSyncAt)"
Write-Host "  messages in the last 7 days: $($s.messages7d), waiting on you: $($s.waiting), urgent: $($s.urgent)"
if (-not (Get-ScheduledTask -TaskName '5StarFlow Request Inbox' -ErrorAction SilentlyContinue)) {
  Write-Host '  NOTE: the request gate is not scheduled on this PC yet. Run backend\ai\prompts\msi\install-request-gate.ps1 so the 2-hourly read and the daily review start.'
} else {
  Write-Host '  The existing request gate will now read TextNow every 2 hours (7 am to 9 pm) and run the daily review after 7 pm.'
}
Write-Host 'Done. Logs: ~/.5starflow/textnow-watch.log and request-gate.log. Summary texts come every 2 days; change digestEveryDays on the ext-textnow-insight routine for daily.'
