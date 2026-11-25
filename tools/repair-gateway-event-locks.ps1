[CmdletBinding()]
param(
    [string]$BridgeHome,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not $BridgeHome) {
    . (Join-Path $PSScriptRoot 'coworker-config.ps1')
    $config = Get-CoworkerConfig
    if ($config.Backend -ne 'gateway') { throw 'The active dsh_agentlink backend is not Gateway.' }
    $BridgeHome = $config.BridgeHome
}
if (-not [IO.Path]::IsPathRooted($BridgeHome)) { throw 'BridgeHome must be absolute.' }

function Test-PlainDirectory($item) {
    return [bool]($item -and $item.PSIsContainer -and
        -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

$root = [IO.Path]::GetFullPath($BridgeHome)
$ledgerRoot = Join-Path $root 'ledgers'
if (-not (Test-Path -LiteralPath $ledgerRoot)) { return }
foreach ($directory in @($root, $ledgerRoot)) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not (Test-PlainDirectory $item) -or $item.FullName -ne $directory) {
        throw "Unexpected ledger path: $directory"
    }
}

# Serialize repairs, including repairs started from different PowerShell windows.
$mutex = New-Object System.Threading.Mutex($false, 'Local\CodexDshGatewayEventLockRepair')
$held = $false
try {
    try { $held = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another Gateway lock repair is running.' }

    foreach ($task in Get-ChildItem -LiteralPath $ledgerRoot -Directory -Force) {
        if ($task.Name -cnotmatch '^dsh_[a-f0-9]{12}$' -or -not (Test-PlainDirectory $task)) { continue }
        $lockPath = Join-Path $task.FullName 'events.lock'
        $lock = Get-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        if (-not $lock) { continue }
        $entries = if (Test-PlainDirectory $lock) { @(Get-ChildItem -LiteralPath $lockPath -Force) }
        $ownerPid = 0
        $state = 'unverified'
        if (@($entries).Count -eq 1 -and $entries[0].Name -ceq 'owner.json' -and
            -not $entries[0].PSIsContainer -and -not ($entries[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            $entries[0].Length -le 4096) {
            $ownerPath = Join-Path $lockPath 'owner.json'
            $raw = Get-Content -LiteralPath $ownerPath -Raw -ErrorAction SilentlyContinue
            $owner = $null
            try { $owner = ConvertFrom-Json -InputObject $raw } catch {}
            $token = [guid]::Empty
            $created = [DateTimeOffset]::MinValue
            if ($owner -and [int]::TryParse([string]$owner.pid, [ref]$ownerPid) -and $ownerPid -gt 0 -and
                [guid]::TryParse([string]$owner.token, [ref]$token) -and
                [DateTimeOffset]::TryParse([string]$owner.createdAt, [ref]$created) -and
                $created.UtcDateTime -le [DateTime]::UtcNow) {
                if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { $state = 'owner-alive' }
                else {
                    $state = 'owner-exited'
                    if ($Apply) {
                        # Check the owner again immediately before moving the lock
                        # to a unique sibling. The ledger files stay in place.
                        if ((Get-Content -LiteralPath $ownerPath -Raw -ErrorAction SilentlyContinue) -ceq $raw -and
                            -not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
                            $resolvedLock = (Resolve-Path -LiteralPath $lockPath).ProviderPath
                            if ($resolvedLock -ne $lockPath -or (Split-Path -Parent $resolvedLock) -ne $task.FullName) {
                                throw "Unexpected lock path: $lockPath"
                            }
                            $backup = Join-Path $task.FullName ('events.lock.recovered-' + [guid]::NewGuid().ToString('N'))
                            [IO.Directory]::Move($resolvedLock, $backup)
                            $state = 'archived'
                        } else { $state = 'owner-changed' }
                    }
                }
            }
        }
        [pscustomobject]@{ Task = $task.Name; Pid = $ownerPid; State = $state }
    }
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
