# Runs from Windows Task Scheduler every 5 minutes, 6 am to 10 pm, and at log on (install-social-gate.ps1 registers it).
# 5StarFlow decides WHAT is due (GET /api/ai/social/shift-due): morning 7:30, midday 12:30, evening 18:30, Monday studio 10:30.
# A PC that was off just picks the missed shift up on its next tick. This script costs zero Claude tokens when nothing is due.
#   SOCIAL_GATE_DRYRUN=1  log what it would do and stop (no Chrome, no claim, no Claude).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
function Log($msg) { Write-FsfLog 'social-gate' $msg }
$quiet = (Get-Date).Minute -ge 5   # log "nothing due" once an hour, not every 5 min
try { Import-FsfEnv } catch { Log "aborted: $($_.Exception.Message)"; exit 1 }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path

# Keep this checkout (skills, prompts) current. Fast-forward only; a failed pull never blocks the shift.
$null = Invoke-FsfNative 'social-gate' 'git' @('-C', $repo, 'pull', '--ff-only', '--quiet')

$due = Invoke-FsfApi 'GET' '/api/ai/social/shift-due'
if ($null -eq $due) { exit 1 }
$todo = @($due.due)
if ($todo.Count -lt 1) { if (-not $quiet) { Log "nothing due ($($due.day))" }; exit 0 }
$shift = $todo[0]

if ($env:SOCIAL_GATE_DRYRUN -eq '1') { Log "DRYRUN: would run the $($shift.kind) shift (attempt $($shift.attempts + 1), late=$($shift.late))"; exit 0 }
# Claude plan limit hit earlier ("You've hit your limit, resets 8:10pm"): wait it out quietly instead of burning the shift's attempts.
$limitFile = Join-Path $FsfDir 'claude-limit-until.txt'
if (Test-Path $limitFile) {
  $until = [datetime]::Parse((Get-Content $limitFile -Raw).Trim())
  if ((Get-Date) -lt $until) { if (-not $quiet) { Log "waiting for the Claude plan limit to reset at $($until.ToString('h:mm tt')), $($shift.kind) stays due" }; exit 0 }
  Remove-Item $limitFile -Force -ErrorAction SilentlyContinue
}
if (Test-FsfChromeBusy) { Log "skip: Chrome is busy with another run (chrome.lock), $($shift.kind) stays due"; exit 0 }

Lock-FsfChrome
$claimed = $null
try {
  $state = Ensure-FsfChrome
  if ($state -eq 'missing') { $state = Ensure-FsfChrome -Restart }
  if ($state -eq 'missing') { Log "chrome unavailable, $($shift.kind) shift not started (the next tick retries)"; exit 0 }

  $claimed = Invoke-FsfApi 'POST' '/api/ai/social/shift-claim' @{ kind = $shift.kind }
  if ($null -eq $claimed -or -not $claimed.ok) { Log "claim refused for $($shift.kind) (someone else has it, or out of attempts)"; exit 0 }
  Log "starting $($shift.kind) shift, attempt $($claimed.attempt), shiftId $($claimed.shiftId)"

  $promptFile = Join-Path $PSScriptRoot '..\social-shift.md'
  $prompt = ((Get-Content $promptFile -Raw -Encoding UTF8) -split '```')[1].Trim()
  $remaining = ($due.remaining | ConvertTo-Json -Depth 5 -Compress)
  $prompt = $prompt.Replace('{{SHIFT}}', $shift.kind).Replace('{{SHIFT_ID}}', $claimed.shiftId).Replace('{{ATTEMPT}}', "$($claimed.attempt)").Replace('{{REMAINING}}', $remaining)

  $r = Invoke-FsfClaude $prompt $repo 100
  $tail = ($r.out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 8) -join "`n  "
  Log "claude exited $($r.code). Last lines:`n  $tail"

  if ($r.out -match "hit your limit[^
]*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)") {
    $h = [int]$Matches[1] % 12; if ($Matches[3] -eq 'pm') { $h += 12 }
    $until = (Get-Date).Date.AddHours($h).AddMinutes($(if ($Matches[2]) { [int]$Matches[2] } else { 0 })).AddMinutes(2)
    if ($until -lt (Get-Date)) { $until = $until.AddDays(1) }
    Set-Content -Path $limitFile -Value $until.ToString('o')
    Log "Claude plan limit hit, pausing the gate until $($until.ToString('h:mm tt'))"
  }
  # The agent reports its own result (POST /social/shift-finish). The gate only steps in when it did not.
  if ($r.out -match 'SHIFT_RESULT:\s*browser_unavailable') {
    Log 'browser unavailable: restarting Chrome for the next try'
    [void](Ensure-FsfChrome -Restart)
    [void](Invoke-FsfApi 'POST' '/api/ai/social/shift-finish' @{ shiftId = $claimed.shiftId; status = 'failed'; error = 'browser unavailable (extension not connected), Chrome restarted' })
  } else {
    $after = Invoke-FsfApi 'GET' '/api/ai/social/shift-due'
    $still = @($after.shifts | Where-Object { $_.kind -eq $shift.kind -and $_.status -eq 'running' })
    if ($still.Count -gt 0) {
      Log 'agent did not report a result, marking the shift failed'
      [void](Invoke-FsfApi 'POST' '/api/ai/social/shift-finish' @{ shiftId = $claimed.shiftId; status = 'failed'; error = "claude exited $($r.code) without reporting" })
    }
  }
} catch {
  Log "gate error: $($_.Exception.Message)"
  if ($claimed -and $claimed.shiftId) { [void](Invoke-FsfApi 'POST' '/api/ai/social/shift-finish' @{ shiftId = $claimed.shiftId; status = 'failed'; error = "gate error: $($_.Exception.Message)" }) }
} finally {
  Unlock-FsfChrome
}
