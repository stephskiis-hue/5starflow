# Runs from Windows Task Scheduler. Zero Claude tokens: it runs a local Ollama model through
# backend/scripts/ollama-worker.js, which only drafts tasks and posts non-urgent notes.
#   ollama-worker.ps1 -Job sms-triage        (every 30 min, 6 am to 10 pm)
#   ollama-worker.ps1 -Job morning-summary   (daily 5:30 am)
param([Parameter(Mandatory = $true)][ValidateSet('sms-triage', 'morning-summary')][string]$Job)
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $HOME '.5starflow\env'
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
}

$lock = Join-Path $HOME ".5starflow\ollama-$Job.lock"
if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-30))) { exit 0 }   # a run is in progress

New-Item -ItemType File -Force -Path $lock | Out-Null
try {
  $script = Join-Path $PSScriptRoot '..\..\..\scripts\ollama-worker.js'
  $log = Join-Path $HOME '.5starflow\ollama-worker.log'
  node $script --job $Job *>> $log
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
