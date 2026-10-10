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

# ---------------------------------------------------------------------------------------------------
# Chrome keeper. The social agent drives the owner's own Chrome (Default profile: Claude extension plus the
# already signed-in Facebook and Instagram cookies). Nothing here types a password; it only makes sure that
# Chrome is running, its window is visible and the Claude extension has had time to connect.
# ---------------------------------------------------------------------------------------------------
$FsfChromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$FsfChromeUrl = 'https://www.facebook.com/No.BS.Yardworks'

if (-not ('FsfWinNative' -as [type])) {
  Add-Type -Namespace '' -Name 'FsfWinNative' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
}

function Get-FsfChromeWindows { @(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) }

# True when a visible (not minimized) Chrome window exists. Restores a minimized one.
function Restore-FsfChromeWindow([string]$Log = 'social-gate') {
  $restored = $false
  foreach ($p in Get-FsfChromeWindows) {
    if ([FsfWinNative]::IsIconic($p.MainWindowHandle)) { [void][FsfWinNative]::ShowWindow($p.MainWindowHandle, 9); $restored = $true }
  }
  if ($restored) { Write-FsfLog $Log 'chrome: window was minimized, restored' }
  return ((Get-FsfChromeWindows | Where-Object { -not [FsfWinNative]::IsIconic($_.MainWindowHandle) }).Count -gt 0)
}

# Make sure Chrome is up on the Default profile with a visible window. -Restart closes it gracefully first
# (cookies and tabs are kept) and is the kick for an extension that will not connect.
# Returns 'up' | 'launched' | 'restarted' | 'missing'.
function Ensure-FsfChrome([switch]$Restart, [string]$Log = 'social-gate') {
  if (-not (Test-Path $FsfChromeExe)) { Write-FsfLog $Log "chrome: $FsfChromeExe not found"; return 'missing' }
  $result = 'up'
  if ($Restart -and (Get-Process chrome -ErrorAction SilentlyContinue)) {
    Write-FsfLog $Log 'chrome: restarting gracefully'
    foreach ($p in Get-FsfChromeWindows) { [void]$p.CloseMainWindow() }
    for ($i = 0; $i -lt 30 -and (Get-Process chrome -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
    if (Get-Process chrome -ErrorAction SilentlyContinue) { Write-FsfLog $Log 'chrome: still running after 30s, leaving it (not killing, to keep the session safe)' }
    else { $result = 'restarted' }
  }
  if (-not (Get-Process chrome -ErrorAction SilentlyContinue)) {
    Write-FsfLog $Log 'chrome: launching on the Default profile'
    Start-Process -FilePath $FsfChromeExe -ArgumentList '--profile-directory=Default', '--restore-last-session', $FsfChromeUrl
    if ($result -eq 'up') { $result = 'launched' }
    for ($i = 0; $i -lt 30 -and (Get-FsfChromeWindows).Count -eq 0; $i++) { Start-Sleep -Seconds 1 }
    Write-FsfLog $Log 'chrome: waiting 45s for the Claude extension to connect'
    Start-Sleep -Seconds 45
  }
  $visible = Restore-FsfChromeWindow $Log
  if (-not $visible) { Write-FsfLog $Log 'chrome: no visible window'; return 'missing' }
  Write-FsfLog $Log "chrome: $result"
  return $result
}

# Only one thing drives Chrome at a time (request gate, social gate and the self-test share this lock).
$FsfChromeLock = Join-Path $FsfDir 'chrome.lock'
function Test-FsfChromeBusy { (Test-Path $FsfChromeLock) -and ((Get-Item $FsfChromeLock).LastWriteTime -gt (Get-Date).AddHours(-2)) }
function Lock-FsfChrome { New-Item -ItemType File -Force -Path $FsfChromeLock | Out-Null }
function Unlock-FsfChrome { Remove-Item $FsfChromeLock -Force -ErrorAction SilentlyContinue }

# Call the 5StarFlow API with the env token. Returns the parsed JSON, or $null (and logs) on failure.
function Invoke-FsfApi([string]$Method, [string]$Path, $Body = $null, [string]$Log = 'social-gate') {
  $headers = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'social' }
  try {
    if ($null -ne $Body) { return Invoke-RestMethod -Method $Method -Uri "$env:FIVESTARFLOW_URL$Path" -Headers $headers -TimeoutSec 30 -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 6) }
    return Invoke-RestMethod -Method $Method -Uri "$env:FIVESTARFLOW_URL$Path" -Headers $headers -TimeoutSec 30
  } catch { Write-FsfLog $Log "api $Method $Path failed: $($_.Exception.Message)"; return $null }
}

# Run Claude Code non-interactively with the prompt on stdin. Returns @{ code; out }. Kills it after $TimeoutMin.
function Invoke-FsfClaude([string]$Prompt, [string]$WorkDir, [int]$TimeoutMin = 90, [string]$Log = 'social-gate') {
  $claude = if ($env:CLAUDE_BIN) { $env:CLAUDE_BIN } else { 'claude' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $claude
  $psi.Arguments = '-p --chrome --dangerously-skip-permissions --model sonnet'
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $proc.StandardInput.Write($Prompt); $proc.StandardInput.Close()
  if (-not $proc.WaitForExit($TimeoutMin * 60000)) { try { $proc.Kill() } catch {}; Write-FsfLog $Log "claude: killed after $TimeoutMin min"; return @{ code = 124; out = $outTask.Result } }
  [void]$errTask.Wait(5000)
  return @{ code = $proc.ExitCode; out = $outTask.Result }
}
