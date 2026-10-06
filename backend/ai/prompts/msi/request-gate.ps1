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

$lock = Join-Path $FsfDir 'request-inbox.lock'
if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddHours(-2))) { Log 'skip: a run is in progress'; exit 0 }

$headers = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'orchestrator' }
try {
  $pending = (Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/requests/pending-count" -Headers $headers -TimeoutSec 20).pending
} catch { Log "pending-count failed: $($_.Exception.Message)"; exit 1 }
if ($pending -lt 1) { if (-not $quiet) { Log 'pending 0' }; exit 0 }

$claude = if ($env:CLAUDE_BIN) { $env:CLAUDE_BIN } else { 'claude' }
Log "pending ${pending}, starting $claude"
New-Item -ItemType File -Force -Path $lock | Out-Null
try {
  $promptFile = Join-Path $PSScriptRoot '..\request-inbox.md'
  $prompt = ((Get-Content $promptFile -Raw) -split '```')[1].Trim()
  $code = Invoke-FsfNative 'request-gate' $claude @('-p', $prompt, '--chrome', '--dangerously-skip-permissions', '--model', 'sonnet')
  Log "claude exited $code"
} catch {
  Log "claude failed to start: $($_.Exception.Message)"
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
