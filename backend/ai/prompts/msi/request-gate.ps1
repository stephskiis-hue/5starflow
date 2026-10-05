# Runs from Windows Task Scheduler every 10 minutes. Costs zero Claude tokens when nothing is pending:
# it only starts a Claude session when /api/ai/requests/pending-count is above 0.
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $HOME '.5starflow\env'
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
}

# Keep this checkout (skills, playbooks, prompts) current so every MSI routine follows the latest rules.
# Fast-forward only: local edits or a diverged branch are left alone, and a failed pull never blocks the inbox.
try { git -C (Join-Path $PSScriptRoot '..\..\..\..') pull --ff-only --quiet 2>$null | Out-Null } catch { }

$lock = Join-Path $HOME '.5starflow\request-inbox.lock'
if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddHours(-2))) { exit 0 }   # a run is in progress

$headers = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'orchestrator' }
try {
  $pending = (Invoke-RestMethod -Uri "$env:FIVESTARFLOW_URL/api/ai/requests/pending-count" -Headers $headers -TimeoutSec 20).pending
} catch { exit 0 }
if ($pending -lt 1) { exit 0 }

New-Item -ItemType File -Force -Path $lock | Out-Null
try {
  $promptFile = Join-Path $PSScriptRoot '..\request-inbox.md'
  $prompt = ((Get-Content $promptFile -Raw) -split '```')[1].Trim()
  claude -p $prompt --chrome --dangerously-skip-permissions --model sonnet
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
