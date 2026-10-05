# Runs from Windows Task Scheduler every hour, 6 am to 10 pm (install-request-gate.ps1 registers it).
# Costs zero Claude tokens when nothing is pending: it only starts a Claude session when
# /api/ai/requests/pending-count is above 0. Every run leaves one line in ~/.5starflow/request-gate.log.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $HOME '.5starflow'
$log = Join-Path $dir 'request-gate.log'
function Log($msg) {
  Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  $lines = Get-Content $log
  if ($lines.Count -gt 500) { $lines | Select-Object -Last 500 | Set-Content $log }
}

$envFile = Join-Path $dir 'env'
if (-not (Test-Path $envFile)) { Log "env file $envFile missing"; exit 1 }
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
}

# Keep this checkout (skills, playbooks, prompts) current so every MSI routine follows the latest rules.
# Fast-forward only: local edits or a diverged branch are left alone, and a failed pull never blocks the inbox.
try { git -C (Join-Path $PSScriptRoot '..\..\..\..') pull --ff-only --quiet 2>$null | Out-Null } catch { }

$lock = Join-Path $dir 'request-inbox.lock'
if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddHours(-2))) { Log 'skip: a run is in progress'; exit 0 }

$headers = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'orchestrator' }
try {
  $pending = (Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/requests/pending-count" -Headers $headers -TimeoutSec 20).pending
} catch { Log "pending-count failed: $($_.Exception.Message)"; exit 1 }
if ($pending -lt 1) { Log 'pending 0'; exit 0 }

$claude = if ($env:CLAUDE_BIN) { $env:CLAUDE_BIN } else { 'claude' }
Log "pending ${pending}, starting $claude"
New-Item -ItemType File -Force -Path $lock | Out-Null
try {
  $promptFile = Join-Path $PSScriptRoot '..\request-inbox.md'
  $prompt = ((Get-Content $promptFile -Raw) -split '```')[1].Trim()
  & $claude -p $prompt --chrome --dangerously-skip-permissions --model sonnet
  Log "claude exited $LASTEXITCODE"
} catch {
  Log "claude failed to start: $($_.Exception.Message)"
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
