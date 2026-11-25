[CmdletBinding()]
param(
    [string]$CodexAppDir,
    [string]$DesktopExecutable = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'docs\operator-tools\windows\launch-official-desktop.ps1'
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source

if (-not $CodexAppDir) {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'Codex installation not found. Pass -CodexAppDir with the installed app directory.' }
    $CodexAppDir = Join-Path $package.InstallLocation 'app'
}
$caller = Join-Path $CodexAppDir 'ChatGPT.exe'
$kernel = Join-Path $CodexAppDir 'resources\codex.exe'
foreach ($file in @($caller, $kernel, $DesktopExecutable, (Join-Path $repo 'dist\authorized-caller.js'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required file not found: $file" }
}

. (Join-Path $PSScriptRoot 'coworker-config.ps1')
$config = Get-CoworkerConfig
if ($config.Backend -ne 'gateway') {
    throw "The dsh_agentlink.env block in $($config.ConfigPath) must select the Gateway backend."
}
$outbox = $config.Outbox

$runningApps = @(Get-Process | Where-Object { $_.ProcessName -in @('ChatGPT', 'Codex', 'DeepSeek Harness') })
if ($DryRun) {
    [pscustomobject]@{
        Codex = $caller
        Kernel = $kernel
        DshDesktop = $DesktopExecutable
        Outbox = $outbox
        StopMarker = (Test-Path -LiteralPath (Join-Path $outbox 'STOP'))
        AppsToQuit = ($runningApps.ProcessName | Sort-Object -Unique) -join ', '
    }
    return
}
if ($runningApps.Count -gt 0) { throw 'Finish active work and quit Codex and DeepSeek Harness, including tray instances, then run Start-Gateway.cmd again.' }
if (Test-Path -LiteralPath (Join-Path $outbox 'STOP')) { throw "The sender is stopped by the STOP marker in $outbox." }

$previousOutbox = $env:COWORKER_OUTBOX
$previousKernel = $env:COWORKER_KERNEL
try {
    $env:COWORKER_OUTBOX = $outbox
    $env:COWORKER_KERNEL = $kernel
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot 'coworker-sender-start.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'The Coworker sender did not become ready.' }
} finally {
    $env:COWORKER_OUTBOX = $previousOutbox
    $env:COWORKER_KERNEL = $previousKernel
}

& $launcher -BridgeRepository $repo -NodePath $node -DesktopExecutable $DesktopExecutable -CallerExecutable $caller
exit $LASTEXITCODE
