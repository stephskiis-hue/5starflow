# One-time setup on the MSI PC. Run in PowerShell from the repo:
#   powershell -ExecutionPolicy Bypass -File backend\ai\prompts\msi\install-ollama-worker.ps1
# Installs Ollama, picks a model that fits the GPU, adds OLLAMA_* to ~/.5starflow/env and
# registers the two Task Scheduler jobs. Safe to re-run.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required (install Node 20+ and re-run).' }

# Pick the model by VRAM (MiB). Falls back to the small model when there is no NVIDIA GPU.
$vram = 0
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  $vram = [int]((nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1).Trim())
}
$model = if ($vram -ge 12000) { 'qwen3:14b' } elseif ($vram -ge 7500) { 'qwen3:8b' } else { 'qwen3:4b' }
Write-Host "GPU memory: $vram MiB -> model $model"
ollama pull $model

$dir = Join-Path $HOME '.5starflow'
$envFile = Join-Path $dir 'env'
if (-not (Test-Path $envFile)) { throw "$envFile not found. It must already hold FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN (same file request-gate.ps1 uses)." }
$lines = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*OLLAMA_(URL|MODEL)\s*=' }
$lines += 'OLLAMA_URL=http://localhost:11434'
$lines += "OLLAMA_MODEL=$model"
Set-Content -Path $envFile -Value $lines

$runner = Join-Path $PSScriptRoot 'ollama-worker.ps1'
$ps = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 25)

# Daily at 6 am, repeating every 30 min for 16 h (Task Scheduler only takes repetition from a -Once trigger).
$triage = New-ScheduledTaskTrigger -Daily -At '6:00am'
$triage.Repetition = (New-ScheduledTaskTrigger -Once -At '6:00am' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 16)).Repetition
Register-ScheduledTask -TaskName '5StarFlow Ollama SMS triage' -Force -Settings $settings -Trigger $triage `
  -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "$ps -Job sms-triage")

Register-ScheduledTask -TaskName '5StarFlow Ollama morning note' -Force -Settings $settings -Trigger (New-ScheduledTaskTrigger -Daily -At '5:30am') `
  -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "$ps -Job morning-summary")

Write-Host 'Test run (SMS triage):'
& $runner -Job sms-triage
Get-Content (Join-Path $dir 'ollama-worker.log') -Tail 3
Write-Host 'Done. Check AI Command -> Routines for "Local model worker (Ollama on MSI)".'
