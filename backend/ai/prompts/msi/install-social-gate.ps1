# One-time setup on the MSI PC. Run in PowerShell from the repo, logged in as the user whose Chrome
# has Claude in Chrome and the Facebook / Instagram pages signed in:
#   powershell -ExecutionPolicy Bypass -File backend\ai\prompts\msi\install-social-gate.ps1
# Registers two Task Scheduler jobs and does a dry run. Safe to re-run.
#   "5StarFlow Social Gate"     every 5 min 6 am to 10 pm and at log on (catches up shifts missed while the PC was off)
#   "5StarFlow Social Selftest" 7:00 am daily and at log on (checks the whole chain and fixes what it can)
$ErrorActionPreference = 'Stop'

$dir = Join-Path $HOME '.5starflow'
$envFile = Join-Path $dir 'env'
if (-not (Test-Path $envFile)) { throw "$envFile not found. Create it with FIVESTARFLOW_URL=... and FIVESTARFLOW_TOKEN=... lines." }
$lines = Get-Content $envFile
foreach ($k in 'FIVESTARFLOW_URL', 'FIVESTARFLOW_TOKEN') {
  if (-not ($lines -match "^\s*$k\s*=\s*\S")) { throw "$envFile has no $k." }
}
if (-not ($lines -match '^\s*CLAUDE_BIN\s*=\s*\S')) {
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'claude is not on PATH. Install Claude Code and sign in, then re-run.' }
  Add-Content -Path $envFile -Value "CLAUDE_BIN=$($cmd.Source)"
}

# Interactive: Claude in Chrome needs the signed-in desktop session, so the tasks run only while this user is logged on.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

function Register-Fsf([string]$Name, [string]$Script, $Triggers) {
  $path = Join-Path $PSScriptRoot $Script
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$path`""
  Register-ScheduledTask -TaskName $Name -Force -Action $action -Trigger $Triggers -Principal $principal -Settings $settings | Out-Null
  Write-Host "Registered: $Name"
}

# Gate: daily 6 am repeating every 5 min for 16 h (repetition only comes from a -Once trigger), plus 1 min after log on.
$every5 = New-ScheduledTaskTrigger -Daily -At '6:00am'
$every5.Repetition = (New-ScheduledTaskTrigger -Once -At '6:00am' -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Hours 16)).Repetition
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"; $logon.Delay = 'PT1M'
Register-Fsf '5StarFlow Social Gate' 'social-gate.ps1' @($every5, $logon)

$logon2 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"; $logon2.Delay = 'PT3M'
Register-Fsf '5StarFlow Social Selftest' 'social-selftest.ps1' @((New-ScheduledTaskTrigger -Daily -At '7:00am'), $logon2)

Write-Host 'Dry run (no Chrome, no claim, no Claude):'
$env:SOCIAL_GATE_DRYRUN = '1'
& (Join-Path $PSScriptRoot 'social-gate.ps1')
Remove-Item Env:SOCIAL_GATE_DRYRUN
Get-Content (Join-Path $dir 'social-gate.log') -Tail 3
Write-Host 'Done. Logs: ~/.5starflow/social-gate.log and social-selftest.log'
