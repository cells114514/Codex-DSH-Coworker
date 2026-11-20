# Coworker sender: stop. STOP first so no delivery starts mid-stop, then end the
# exact pid recorded in the heartbeat, then clear the marker.
$ErrorActionPreference = "Continue"
$outbox = if ($env:COWORKER_OUTBOX) { $env:COWORKER_OUTBOX } else { Join-Path $env:USERPROFILE ".dsh-sdk-test\codex-bridge-sdk\coworker-outbox" }
$stopFile = Join-Path $outbox "STOP"
$heartbeat = Join-Path $outbox ".sender-heartbeat"

New-Item -ItemType File -Path $stopFile -Force | Out-Null

$senderPid = $null
if (Test-Path $heartbeat) {
  $text = (Get-Content $heartbeat -TotalCount 1) -split '\s+' | Select-Object -First 1
  $parsed = 0
  if ([int]::TryParse($text, [ref]$parsed)) { $senderPid = $parsed }
}
if ($senderPid -and (Get-Process -Id $senderPid -ErrorAction SilentlyContinue)) {
  Stop-Process -Id $senderPid -Force
  Write-Host "stopped sender pid: $senderPid"
} else {
  Write-Host "no live sender pid recorded in the heartbeat"
}

Start-Sleep -Seconds 1
Remove-Item $stopFile -ErrorAction SilentlyContinue
Write-Host "STOP marker cleared: $(-not (Test-Path $stopFile))"