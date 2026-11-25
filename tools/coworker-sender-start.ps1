# Coworker sender: start (background) for the trial install.
# Paths come from the environment so nothing machine-specific is committed.
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'coworker-config.ps1')
$outbox = Get-CoworkerOutbox
$kernel = if ($env:COWORKER_KERNEL) {
  $env:COWORKER_KERNEL
} else {
  $pkg = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
  if ($pkg) {
    $candidate = Join-Path $pkg.InstallLocation "app\resources\codex.exe"
    if (Test-Path $candidate) { $candidate }
  }
}
$senderScript = Join-Path $repo 'docs\operator-tools\coworker-sender.mjs'

if (Test-Path -LiteralPath (Join-Path $outbox 'STOP')) { throw "A STOP marker is present in $outbox." }
if (-not (Test-Path $outbox)) { New-Item -ItemType Directory -Path $outbox -Force | Out-Null }
if (-not $kernel -or -not (Test-Path -LiteralPath $kernel -PathType Leaf)) {
  throw 'Set COWORKER_KERNEL to an existing Codex kernel executable.'
}

$existing = Get-CoworkerSender $outbox
if ($existing) {
  if (-not $existing.Kernel) { throw 'The existing sender has no identifiable kernel. Stop it before starting another sender.' }
  if (Test-Path -LiteralPath $existing.Kernel -PathType Leaf) {
    if (-not $existing.Fresh) { throw 'The existing sender heartbeat is stale. Check it before starting another sender.' }
    Write-Host "sender already running: pid $($existing.Pid)"
    exit 0
  }
  # A Windows Store update can remove the kernel while the sender stays alive.
  $oldProcess = Get-Process -Id $existing.Pid -ErrorAction Stop
  Stop-Process -InputObject $oldProcess -ErrorAction Stop
  if (-not $oldProcess.WaitForExit(5000)) { throw 'The sender using the removed kernel did not exit.' }
  Write-Host "Replaced sender with missing Codex kernel: pid $($existing.Pid)"
}

$node = (Get-Command node).Source
$arguments = @(
  "`"$senderScript`"",
  "--outbox", "`"$outbox`"",
  "--kernel", "`"$kernel`"",
  "--interval", "2"
)
$started = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  if ($started.HasExited) { throw "The Coworker sender exited during startup (code $($started.ExitCode))." }
  $live = Get-CoworkerSender $outbox
  if ($live -and $live.Pid -eq $started.Id -and $live.Fresh) {
    Write-Host "sender pid: $($live.Pid)"
    Write-Host "outbox:    $outbox"
    Write-Host "kernel:    $kernel"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
throw "Sender did not become ready: no fresh heartbeat in $outbox."
