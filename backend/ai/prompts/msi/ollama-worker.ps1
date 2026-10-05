# Runs from Windows Task Scheduler. Zero Claude tokens: it runs a local Ollama model through
# backend/scripts/ollama-worker.js, which only drafts tasks and posts non-urgent notes.
#   ollama-worker.ps1 -Job sms-triage        (every 30 min, 6 am to 10 pm)
#   ollama-worker.ps1 -Job morning-summary   (daily 5:30 am)
param([Parameter(Mandatory = $true)][ValidateSet('sms-triage', 'morning-summary')][string]$Job)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
try { Import-FsfEnv } catch { Write-FsfLog 'ollama-worker' "$Job aborted: $($_.Exception.Message)"; exit 1 }

$lock = Join-Path $FsfDir "ollama-$Job.lock"
if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-30))) { Write-FsfLog 'ollama-worker' "$Job skip: a run is in progress"; exit 0 }

New-Item -ItemType File -Force -Path $lock | Out-Null
try {
  $script = Join-Path $PSScriptRoot '..\..\..\scripts\ollama-worker.js'
  # Ollama's tray app starts the server at login; if it is not up (closed, or the PC just woke), start it.
  $up = { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 11434); $c.Close(); $true } catch { $false } }
  if (-not (& $up)) {
    Write-FsfLog 'ollama-worker' "$Job ollama not listening, starting ollama serve"
    Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
    for ($i = 0; $i -lt 15 -and -not (& $up); $i++) { Start-Sleep -Seconds 2 }
  }
  Write-FsfLog 'ollama-worker' "$Job start"
  $code = Invoke-FsfNative 'ollama-worker' 'node' @('--no-warnings', $script, '--job', $Job)
  Write-FsfLog 'ollama-worker' "$Job exited $code"
} catch {
  Write-FsfLog 'ollama-worker' "$Job failed: $($_.Exception.Message)"
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
