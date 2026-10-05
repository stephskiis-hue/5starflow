# Shared by every MSI Task Scheduler script. Dot-source it: . (Join-Path $PSScriptRoot 'common.ps1')
$FsfDir = Join-Path $HOME '.5starflow'

# KEY=value lines from ~/.5starflow/env into the process environment. Accepts a leading "export ".
function Import-FsfEnv {
  $envFile = Join-Path $FsfDir 'env'
  if (-not (Test-Path $envFile)) { throw "$envFile not found (needs FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN)" }
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.+?)\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2].Trim('"', "'") }
  }
}

# One timestamped line per event, trimmed to the last 500 lines so the log never grows unbounded.
function Write-FsfLog([string]$Name, [string]$Message) {
  $log = Join-Path $FsfDir "$Name.log"
  Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  $lines = @(Get-Content $log)
  if ($lines.Count -gt 500) { $lines | Select-Object -Last 500 | Set-Content $log }
}

# Runs a native program and returns its exit code. Windows PowerShell 5.1 turns any stderr line into a
# terminating NativeCommandError under ErrorActionPreference=Stop (Node's ExperimentalWarning did exactly
# that), so stderr is relaxed for the call and appended to the log instead.
function Invoke-FsfNative([string]$Name, [string]$Exe, [string[]]$Arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object { Add-Content -Path (Join-Path $FsfDir "$Name.log") -Value "  $_" }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
}
