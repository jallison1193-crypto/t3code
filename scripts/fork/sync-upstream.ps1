# Fork: merge upstream main into fork/main, check, push.
# Runs in the dedicated sync worktree so it never touches a checkout someone is working in.
#   pwsh -NoProfile -File scripts/fork/sync-upstream.ps1 [-WorktreePath <path>] [-NoPush]
# Exit codes: 0 synced or already current, 2 merge conflict, 3 checks failed, 4 setup error.
param(
  [string]$WorktreePath = "C:\Users\jalli\dev\t3code-fork-sync",
  [string]$Branch = "fork/main",
  [string]$UpstreamRemote = "origin",
  [string]$ForkRemote = "fork",
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$logDir = Join-Path $env:LOCALAPPDATA "t3code-fork-sync"
New-Item -ItemType Directory -Force $logDir | Out-Null
$checkLog = Join-Path $logDir "check-$stamp.log"
$report = Join-Path $logDir "last-run.md"

function Write-Report([string]$status, [string[]]$lines, [int]$code) {
  $body = @("# Fork sync $stamp", "", "**Status:** $status", "") + $lines
  Set-Content -Path $report -Value ($body -join "`n")
  Write-Output ($body -join "`n")
  exit $code
}

function Invoke-Git {
  $out = & git @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed: $out" }
  return $out
}

try {
  $vpEnv = Join-Path $env:APPDATA "vite-plus\env.ps1"
  if (Test-Path $vpEnv) { . $vpEnv }
  Set-Location $WorktreePath

  $current = (Invoke-Git rev-parse --abbrev-ref HEAD).Trim()
  if ($current -ne $Branch) { Write-Report "setup error" @("Sync worktree is on '$current', expected '$Branch'.") 4 }
  if (Invoke-Git status --porcelain) { Write-Report "setup error" @("Sync worktree has uncommitted changes; left untouched.") 4 }

  Invoke-Git fetch --quiet $UpstreamRemote main | Out-Null
  Invoke-Git fetch --quiet $ForkRemote | Out-Null
  $upstream = "$UpstreamRemote/main"
  $upstreamSha = (Invoke-Git rev-parse --short $upstream).Trim()

  & git merge-base --is-ancestor $upstream HEAD
  if ($LASTEXITCODE -eq 0) {
    if (-not $NoPush) { Invoke-Git push --quiet $ForkRemote "refs/remotes/${upstream}:refs/heads/main" | Out-Null }
    Write-Report "already current" @("$Branch already contains upstream $upstreamSha.") 0
  }

  $pre = (Invoke-Git rev-parse HEAD).Trim()
  $newCommits = (Invoke-Git rev-list --count "HEAD..$upstream").Trim()
  & git merge --no-edit -m "chore(fork): sync upstream $upstreamSha" $upstream 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $conflicts = @(& git diff --name-only --diff-filter=U)
    & git merge --abort 2>&1 | Out-Null
    Write-Report "merge conflict" (@("Merging $newCommits upstream commits ($upstreamSha) conflicts in:", "") + ($conflicts | ForEach-Object { "- ``$_``" }) + @("", "$Branch unchanged; resolve by hand.")) 2
  }

  & git diff --quiet $pre HEAD -- pnpm-lock.yaml
  if ($LASTEXITCODE -ne 0) {
    & vp i *> (Join-Path $logDir "install-$stamp.log")
    if ($LASTEXITCODE -ne 0) { throw "vp i failed; see install-$stamp.log" }
  }

  & vp run check:changed $upstream *> $checkLog
  $checkExit = $LASTEXITCODE
  $logText = Get-Content $checkLog
  $failedSteps = @($logText | Where-Object { $_ -match '^\s+(FAIL|TIMEOUT)\s+(.+?)\s+[\d.]+s\s*$' } | ForEach-Object { $Matches[2] })
  $failedTests = @($logText | Where-Object { $_ -match '^\s*FAIL\s+\|[^|]+\|\s+.+ > ' } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
  $knownFile = Join-Path $WorktreePath "scripts\fork\known-test-failures.txt"
  $known = @(Get-Content $knownFile -ErrorAction SilentlyContinue | Where-Object { $_ -and -not $_.StartsWith("#") })
  $unknownTests = @($failedTests | Where-Object { $t = $_; -not ($known | Where-Object { $t.Contains($_) }) })
  $otherSteps = @($failedSteps | Where-Object { -not $_.StartsWith("test") })
  $testStepOnlyKnown = ($failedSteps | Where-Object { $_.StartsWith("test") }) -and $failedTests.Count -gt 0 -and $unknownTests.Count -eq 0
  $passed = $checkExit -eq 0 -or ($otherSteps.Count -eq 0 -and $testStepOnlyKnown)

  if (-not $passed) {
    $failedBranch = "fork/sync-failed-$stamp"
    Invoke-Git branch $failedBranch | Out-Null
    Invoke-Git reset --quiet --hard $pre | Out-Null
    Write-Report "checks failed" (@("Merged $newCommits upstream commits ($upstreamSha) but checks failed. Merge kept on ``$failedBranch``; $Branch reset to its previous commit.", "", "Failed steps:") + ($failedSteps | ForEach-Object { "- $_" }) + @("", "New failing tests:") + ($unknownTests | ForEach-Object { "- $_" }) + @("", "Log: ``$checkLog``")) 3
  }

  if (-not $NoPush) {
    Invoke-Git push --quiet $ForkRemote $Branch | Out-Null
    Invoke-Git push --quiet $ForkRemote "refs/remotes/${upstream}:refs/heads/main" | Out-Null
  }
  $knownNote = if ($failedTests.Count -gt 0) { @("", "Known Windows-only test failures ignored: $($failedTests.Count).") } else { @() }
  Write-Report "synced" (@("Merged $newCommits upstream commits ($upstreamSha) into $Branch$(if ($NoPush) { ' (not pushed)' } else { ' and pushed' }).", "Merge branch work into feature branches when convenient.") + $knownNote) 0
}
catch {
  Write-Report "setup error" @("$_") 4
}
