# One-time setup on the MSI PC. Run in PowerShell from the repo, logged in as the user whose Chrome
# has Claude in Chrome and the Facebook page signed in:
#   powershell -ExecutionPolicy Bypass -File backend\ai\prompts\msi\install-request-gate.ps1
# Registers the hourly owner-request gate in Task Scheduler and does one test run. Safe to re-run.
$ErrorActionPreference = 'Stop'

$dir = Join-Path $HOME '.5starflow'
$envFile = Join-Path $dir 'env'
if (-not (Test-Path $envFile)) { throw "$envFile not found. Create it with FIVESTARFLOW_URL=... and FIVESTARFLOW_TOKEN=... lines." }
$lines = Get-Content $envFile
foreach ($k in 'FIVESTARFLOW_URL', 'FIVESTARFLOW_TOKEN') {
  if (-not ($lines -match "^\s*$k\s*=\s*\S")) { throw "$envFile has no $k." }
}

# Task Scheduler does not get the interactive PATH, so pin the full path to claude.
$cmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $cmd) { throw 'claude is not on PATH. Install Claude Code and sign in (run "claude" once), then re-run.' }
$lines = $lines | Where-Object { $_ -notmatch '^\s*CLAUDE_BIN\s*=' }
$lines += "CLAUDE_BIN=$($cmd.Source)"
Set-Content -Path $envFile -Value $lines

$gate = Join-Path $PSScriptRoot 'request-gate.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$gate`""
# Daily at 6 am, repeating hourly for 16 h (Task Scheduler only takes repetition from a -Once trigger).
$trigger = New-ScheduledTaskTrigger -Daily -At '6:00am'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '6:00am' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 16)).Repetition
# Interactive: Claude in Chrome needs the signed-in desktop session, so the task runs only while this user is logged on.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName '5StarFlow Request Inbox' -Force -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

Write-Host 'Test run:'
& $gate
Get-Content (Join-Path $dir 'request-gate.log') -Tail 3
Write-Host 'Done. Task "5StarFlow Request Inbox" runs hourly 6 am to 10 pm while you are logged in. Log: ~/.5starflow/request-gate.log'
