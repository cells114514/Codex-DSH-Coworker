# Coworker sender: start (background) for the trial install.
# Paths come from the environment so nothing machine-specific is committed.
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$outbox = if ($env:COWORKER_OUTBOX) { $env:COWORKER_OUTBOX } else { Join-Path $env:USERPROFILE ".dsh-sdk-test\codex-bridge-sdk\coworker-outbox" }
$kernel = if ($env:COWORKER_KERNEL) {
  $env:COWORKER_KERNEL
} else {
  $pkg = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) {
    $candidate = Join-Path $pkg.InstallLocation "app\resources\codex.exe"
    if (Test-Path $candidate) { $candidate }
  }
}
$heartbeat = Join-Path $outbox ".sender-heartbeat"

if (-not (Test-Path $outbox)) { New-Item -ItemType Directory -Path $outbox -Force | Out-Null }
if (-not $kernel) { Write-Host "blueprint: set COWORKER_KERNEL to the Codex kernel executable"; exit 1 }

function Get-LiveSenderPid {
  if (-not (Test-Path $heartbeat)) { return $null }
  if (((Get-Date) - (Get-Item $heartbeat).LastWriteTime).TotalSeconds -gt 30) { return $null }
  $text = (Get-Content $heartbeat -TotalCount 1) -split '\s+' | Select-Object -First 1
  $candidate = 0
  if (-not [int]::TryParse($text, [ref]$candidate)) { return $null }
  if (-not (Get-Process -Id $candidate -ErrorAction SilentlyContinue)) { return $null }
  return $candidate
}

$live = Get-LiveSenderPid
if ($live) { Write-Host "sender already running: pid $live"; exit 0 }

$node = (Get-Command node).Source
$arguments = @(
  "`"$repo\docs\operator-tools\coworker-sender.mjs`"",
  "--outbox", "`"$outbox`"",
  "--kernel", "`"$kernel`"",
  "--interval", "2"
)
Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  $live = Get-LiveSenderPid
  if ($live) { break }
  Start-Sleep -Milliseconds 500
}
if (-not $live) { Write-Host "sender did not become ready: no fresh heartbeat in $outbox"; exit 1 }
Write-Host "sender pid: $live"
Write-Host "outbox:    $outbox"
Write-Host "kernel:    $kernel"