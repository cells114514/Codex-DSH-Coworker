# Pause pending deliveries while stopping the sender for this exact outbox.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'coworker-config.ps1')
$outbox = Get-CoworkerOutbox
$sender = Get-CoworkerSender $outbox
if (-not $sender) { Write-Host 'No sender for this outbox is running.'; exit 0 }

$stopFile = Join-Path $outbox 'STOP'
$createdMarker = -not (Test-Path -LiteralPath $stopFile)
if ($createdMarker) { New-Item -ItemType File -Path $stopFile | Out-Null }
$process = Get-Process -Id $sender.Pid -ErrorAction SilentlyContinue
if ($process -and -not $process.HasExited) {
    Stop-Process -InputObject $process -ErrorAction Stop
    if (-not $process.WaitForExit(5000)) { throw 'The sender did not exit, so the STOP marker has been retained.' }
}
if ($createdMarker) { Remove-Item -LiteralPath $stopFile }
Write-Host "Stopped sender pid $($sender.Pid)."
