# Daily self-test for the social chain on the MSI (Task Scheduler: 7:00 am and at log on; install-social-gate.ps1 registers it).
# No Claude tokens except the optional browser probe. Each failing check runs its fix ONCE and is re-tested; anything
# still failing becomes one dashboard Task. Reports to 5StarFlow as routine ext-social-selftest.
#   -Browser   also run the read-only browser probe (default on Sundays): Facebook/Instagram signed in, window visible.
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
function Log($msg) { Write-FsfLog 'social-selftest' $msg }
try { Import-FsfEnv } catch { Log "aborted: $($_.Exception.Message)"; exit 1 }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$started = (Get-Date).ToUniversalTime().ToString('o')
$results = New-Object System.Collections.ArrayList

# Run one check; on failure run $Fix once and re-test.
function Check([string]$Name, [scriptblock]$Test, [scriptblock]$Fix = $null) {
  $ok = $false; $detail = ''
  try { $r = & $Test; $ok = [bool]$r.ok; $detail = "$($r.detail)" } catch { $detail = "error: $($_.Exception.Message)" }
  $fixed = $false
  if (-not $ok -and $Fix) {
    try { & $Fix | Out-Null; $r = & $Test; $ok = [bool]$r.ok; $detail = "$($r.detail)"; $fixed = $ok } catch { $detail = "$detail; fix failed: $($_.Exception.Message)" }
  }
  $status = if ($ok -and $fixed) { 'FIXED' } elseif ($ok) { 'PASS' } else { 'FAIL' }
  [void]$results.Add([pscustomobject]@{ name = $Name; status = $status; detail = $detail })
  Log ("{0,-6} {1}: {2}" -f $status, $Name, $detail)
}

Check 'env + API' { $w = Invoke-FsfApi 'GET' '/api/ai/whoami' $null 'social-selftest'; @{ ok = ($w -and $w.ok); detail = "actor=$($w.actor)" } }

Check 'repo current' {
  [void](Invoke-FsfNative 'social-selftest' 'git' @('-C', $repo, 'fetch', '--quiet'))
  $head = (& git -C $repo rev-parse HEAD 2>$null); $up = (& git -C $repo rev-parse '@{u}' 2>$null)
  @{ ok = ($head -and $head -eq $up); detail = "HEAD $("$head".Substring(0, [Math]::Min(7, "$head".Length))) vs origin $("$up".Substring(0, [Math]::Min(7, "$up".Length)))" }
} { [void](Invoke-FsfNative 'social-selftest' 'git' @('-C', $repo, 'pull', '--ff-only', '--quiet')) }

foreach ($t in '5StarFlow Social Gate', '5StarFlow Social Selftest', '5StarFlow Request Inbox') {
  Check "task: $t" {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if (-not $task) { return @{ ok = $false; detail = 'missing' } }
    $info = Get-ScheduledTaskInfo -TaskName $t
    $okResult = @(0, 267009, 267011, 267014) -contains $info.LastTaskResult   # 0 ok, 267009 running, 267011 never run, 267014 stopped by time limit
    @{ ok = ($task.State -ne 'Disabled' -and $task.Settings.StartWhenAvailable -and $okResult); detail = "state=$($task.State) last=$($info.LastTaskResult) startWhenAvailable=$($task.Settings.StartWhenAvailable)" }
  } {
    if ($t -like '*Social*') { & (Join-Path $PSScriptRoot 'install-social-gate.ps1') }
    else { Enable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
  }
}

Check 'chrome running + visible' { $s = Ensure-FsfChrome -Log 'social-selftest'; @{ ok = ($s -ne 'missing'); detail = $s } } { Ensure-FsfChrome -Restart -Log 'social-selftest' }

Check 'claude extension installed + enabled' {
  $ext = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
  $prefs = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Default\Secure Preferences'
  $j = Get-Content $prefs -Raw | ConvertFrom-Json
  $e = $j.extensions.settings.$ext
  $dir = Test-Path (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Extensions\$ext")
  $disabled = $e -and ($e.disable_reasons -and @($e.disable_reasons).Count -gt 0 -or $e.state -eq 0)
  @{ ok = ($e -and $dir -and -not $disabled); detail = "present=$([bool]$e) folder=$dir disabled=$([bool]$disabled)" }
}

Check 'native messaging host' {
  $k = Get-ItemProperty 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.anthropic.claude_code_browser_extension' -ErrorAction SilentlyContinue
  if (-not $k) { return @{ ok = $false; detail = 'registry key missing (run claude once with --chrome, or reinstall the extension)' } }
  $manifest = $k.'(default)'
  $path = if ($manifest -and (Test-Path $manifest)) { (Get-Content $manifest -Raw | ConvertFrom-Json).path } else { $null }
  @{ ok = ($path -and (Test-Path $path)); detail = "host=$path" }
}

Check 'chrome.lock not stale' {
  if (Test-Path $FsfChromeLock) { $age = [int]((Get-Date) - (Get-Item $FsfChromeLock).LastWriteTime).TotalMinutes; @{ ok = ($age -lt 120); detail = "age ${age}m" } }
  else { @{ ok = $true; detail = 'no lock' } }
} { Unlock-FsfChrome }

Check 'shift logic (server)' {
  $d = Invoke-FsfApi 'GET' '/api/ai/social/shift-due?dryRun=1' $null 'social-selftest'
  @{ ok = ($d -and $d.day -and $null -ne $d.due -and $d.remaining); detail = "day=$($d.day) due=$(@($d.due | ForEach-Object { $_.kind }) -join ',')" }
}

Check 'reserve rule: a price is refused' {
  $headers = @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN"; 'X-Agent' = 'social' }
  $body = @{ platform = 'facebook'; kind = 'comment'; target = 'https://selftest.invalid/never'; text = 'We do it for $50' } | ConvertTo-Json
  try { Invoke-RestMethod -Method POST -Uri "$env:FIVESTARFLOW_URL/api/ai/social/actions/reserve" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30 | Out-Null; @{ ok = $false; detail = 'server ACCEPTED a price' } }
  catch { $code = [int]$_.Exception.Response.StatusCode; @{ ok = ($code -eq 422); detail = "HTTP $code" } }
}

Check 'qa parity (lint)' {
  $cases = @(
    @{ text = 'Fall cleanup for $99'; want = $false }, @{ text = 'Great news - we are booking now'; want = $false },
    @{ text = 'Call No Bs Yardwork on 204-900-0438'; want = $false }, @{ text = 'Call No-Bs Yardwork on 204-900-9999'; want = $false },
    @{ text = 'Fall cleanups booking now in Winnipeg. No-Bs Yardwork, call or text 204-900-0438.'; want = $true })
  $bad = @()
  foreach ($c in $cases) { $r = Invoke-FsfApi 'POST' '/api/ai/content/lint' @{ caption = $c.text; platform = 'facebook' } 'social-selftest'; if ($null -eq $r -or [bool]$r.ok -ne $c.want) { $bad += $c.text } }
  @{ ok = ($bad.Count -eq 0); detail = if ($bad.Count) { "wrong verdict for: $($bad -join ' | ')" } else { "$($cases.Count) samples agree" } }
}

Check 'media fetch' {
  $list = Invoke-FsfApi 'GET' '/api/ai/assets?limit=1&usable=true' $null 'social-selftest'
  $first = @($list.assets + $list) | Where-Object { $_.id } | Select-Object -First 1
  if (-not $first) { return @{ ok = $true; detail = 'vault empty, nothing to fetch (not a failure)' } }
  $dest = Join-Path $FsfDir 'media'; New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $file = Join-Path $dest 'selftest.bin'
  Invoke-WebRequest -Uri "$env:FIVESTARFLOW_URL/api/ai/assets/$($first.id)" -Headers @{ Authorization = "Bearer $env:FIVESTARFLOW_TOKEN" } -OutFile $file -TimeoutSec 60
  $len = (Get-Item $file).Length; Remove-Item $file -Force
  @{ ok = ($len -gt 1000); detail = "$len bytes" }
}

if ($Browser -or (Get-Date).DayOfWeek -eq 'Sunday') {
  Check 'browser probe (Facebook + Instagram signed in)' {
    if (Test-FsfChromeBusy) { return @{ ok = $true; detail = 'skipped: Chrome busy with another run' } }
    Lock-FsfChrome
    try {
      $probe = 'Using Claude in Chrome ONLY, read-only (no posting, commenting, liking or any change): 1) open https://www.facebook.com/No.BS.Yardworks in a new tab. Report FB_LOGIN=yes if a login form, 2FA or checkpoint is shown, else FB_LOGIN=no. Report FB_AS=<the name shown for the account you act as, if visible>. Report VISIBILITY=<document.visibilityState>. 2) in another new tab open https://www.instagram.com/ and report IG_LOGIN=yes if a login form is shown else IG_LOGIN=no, and IG_USER=<username if visible>. Close the tabs you opened. If browser tools are unavailable print BROWSER=UNAVAILABLE. Print the values on separate lines, nothing else.'
      $r = Invoke-FsfClaude $probe $repo 10 'social-selftest'
    } finally { Unlock-FsfChrome }
    if ($r.out -match 'BROWSER=UNAVAILABLE') { return @{ ok = $false; detail = 'browser unavailable' } }
    $fbLogin = $r.out -match 'FB_LOGIN=no'; $igLogin = $r.out -match 'IG_LOGIN=no'; $vis = $r.out -match 'VISIBILITY=visible'
    @{ ok = ($fbLogin -and $igLogin -and $vis); detail = (($r.out -split "`r?`n" | Where-Object { $_ -match '=' }) -join '; ') }
  } { Ensure-FsfChrome -Restart -Log 'social-selftest' }
}

$fails = @($results | Where-Object { $_.status -eq 'FAIL' })
$summary = "$($results.Count) checks: $(@($results | Where-Object { $_.status -eq 'PASS' }).Count) pass, $(@($results | Where-Object { $_.status -eq 'FIXED' }).Count) auto-fixed, $($fails.Count) fail"
Log $summary
$body = @{
  slug = 'ext-social-selftest'; status = $(if ($fails.Count) { 'failed' } else { 'completed' }); summary = $summary; startedAt = $started
  result = @{ items_found = $results.Count; requires_attention = $fails.Count; actions_taken = @($results | ForEach-Object { "$($_.status) $($_.name): $($_.detail)" }) }
}
if ($fails.Count) {
  $body.tasks = @($fails | ForEach-Object { @{ dedupKey = "social-selftest:$($_.name)"; title = "Social self-test failing: $($_.name)"; urgency = 'high'; whatHappened = $_.detail; whatNeeds = 'Auto-fix did not work. See ~/.5starflow/social-selftest.log on the MSI.' } })
}
[void](Invoke-FsfApi 'POST' '/api/ai/runs' $body 'social-selftest')
$results | Format-Table name, status, detail -AutoSize -Wrap | Out-String -Width 200 | Write-Host
exit $(if ($fails.Count) { 1 } else { 0 })
