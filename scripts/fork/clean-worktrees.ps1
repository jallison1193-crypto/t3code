# Fork: delete agent worktrees that are finished: clean, merged into a myfork branch, and idle for two days.
#   pwsh -NoProfile -File scripts/fork/clean-worktrees.ps1 [-DryRun] [-IdleHours 48]
# Never touches a worktree with changes, unpushed commits, a running setup, or recent git activity.
param(
  [string]$WorktreeRoot = "C:\Users\jalli\.t3\worktrees\t3code-fork",
  [string]$ForkRemote = "myfork",
  [string[]]$KeepBranches = @("t3/run-daily-upstream-sync"),
  [int]$IdleHours = 48,
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"
$root = (Resolve-Path -LiteralPath $WorktreeRoot -ErrorAction SilentlyContinue).Path
if (-not $root) { Write-Output "No worktree root at $WorktreeRoot."; exit 0 }
$cutoff = (Get-Date).AddHours(-$IdleHours)

$entries = @()
$current = $null
foreach ($line in (& git worktree list --porcelain)) {
  if ($line -like "worktree *") { $current = @{ Path = ($line.Substring(9) -replace "/", "\"); Branch = $null; Head = $null }; $entries += $current }
  elseif ($line -like "HEAD *") { $current.Head = $line.Substring(5) }
  elseif ($line -like "branch refs/heads/*") { $current.Branch = $line.Substring(18) }
}

function Get-LastGitActivity([string]$path) {
  $gitFile = Join-Path $path ".git"
  if (-not (Test-Path -LiteralPath $gitFile -PathType Leaf)) { return Get-Date }
  $adminDir = ((Get-Content -LiteralPath $gitFile -TotalCount 1) -replace "^gitdir:\s*", "").Trim()
  $stamps = @("index", "HEAD", "logs\HEAD") | ForEach-Object { Join-Path $adminDir $_ } |
    Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTime }
  if (-not $stamps) { return Get-Date }
  return ($stamps | Measure-Object -Maximum).Maximum
}

function Remove-WorktreeFolder([string]$path) {
  & git worktree remove --force $path 2>&1 | Out-Null
  if (Test-Path -LiteralPath $path) { & cmd.exe /d /c "rd /s /q `"\\?\$path`"" 2>&1 | Out-Null }
  return -not (Test-Path -LiteralPath $path)
}

$removed = 0
foreach ($wt in $entries) {
  if (-not $wt.Path.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
  $name = Split-Path $wt.Path -Leaf
  if (-not (Test-Path -LiteralPath $wt.Path)) { continue }
  $skip = $null
  if ($wt.Branch -and $KeepBranches -contains $wt.Branch) { $skip = "kept branch" }
  elseif (Test-Path -LiteralPath (Join-Path $wt.Path ".t3\setup-running")) { $skip = "setup running" }
  elseif ((Get-LastGitActivity $wt.Path) -gt $cutoff) { $skip = "active in the last $IdleHours h" }
  elseif (@(& git -C $wt.Path status --porcelain 2>$null).Count -gt 0) { $skip = "has changes" }
  elseif (-not (& git branch -r --contains $wt.Head --list "$ForkRemote/*" 2>$null)) { $skip = "not pushed to $ForkRemote" }
  if ($skip) { Write-Output "keep  $name ($skip)"; continue }
  if ($DryRun) { Write-Output "would remove $name [$($wt.Branch)]"; continue }
  $ok = Remove-WorktreeFolder $wt.Path
  if ($ok -and $wt.Branch) { & git branch -D $wt.Branch 2>&1 | Out-Null }
  Write-Output "$(if ($ok) { 'removed' } else { 'FAILED ' }) $name [$($wt.Branch)]"
  if ($ok) { $removed++ }
}

$registered = @($entries | ForEach-Object { $_.Path })
foreach ($dir in Get-ChildItem -LiteralPath $root -Directory) {
  if ($registered -contains $dir.FullName) { continue }
  if ($dir.LastWriteTime -gt $cutoff) { Write-Output "keep  $($dir.Name) (unregistered, recent)"; continue }
  if ($DryRun) { Write-Output "would remove leftover $($dir.Name)"; continue }
  & cmd.exe /d /c "rd /s /q `"\\?\$($dir.FullName)`"" 2>&1 | Out-Null
  Write-Output "$(if (Test-Path -LiteralPath $dir.FullName) { 'FAILED ' } else { 'removed' }) leftover $($dir.Name)"
}

& git worktree prune
& git for-each-ref --format="%(refname:short)" "refs/heads/fork/sync-*" | ForEach-Object {
  $b = $_
  $tip = (& git rev-parse $b).Trim()
  & git merge-base --is-ancestor $tip "$ForkRemote/fork/main" 2>$null
  if ($LASTEXITCODE -eq 0 -and -not ($entries | Where-Object { $_.Branch -eq $b -and (Test-Path -LiteralPath $_.Path) })) {
    if ($DryRun) { Write-Output "would delete branch $b" } else { & git branch -D $b 2>&1 | Out-Null; Write-Output "deleted branch $b" }
  }
}
Write-Output "Worktree cleanup: $removed removed."
exit 0
