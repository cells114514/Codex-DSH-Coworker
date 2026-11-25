# Read the generated dsh_agentlink MCP entry used by the Windows launchers.
function Get-CoworkerConfig {
    $codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $configPath = Join-Path $codexRoot 'config.toml'
    $section = ''
    $bridgeEnv = @{}
    $entryPath = $null
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $configPath -Encoding UTF8) {
            if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
                $section = $Matches[1]
            } elseif ($section -eq 'mcp_servers.dsh_agentlink.env' -and $line -match '^\s*(DSH_HOST_PROTOCOL|DSH_HOME|DSH_BRIDGE_HOME)\s*=\s*("(?:[^"\\]|\\.)*"|''[^'']*'')\s*(?:#.*)?$') {
                $key = $Matches[1]
                $value = $Matches[2]
                $bridgeEnv[$key] = if ($value.StartsWith("'")) { $value.Substring(1, $value.Length - 2) } else { ConvertFrom-Json -InputObject $value }
            } elseif ($section -eq 'mcp_servers.dsh_agentlink' -and $line -match '^\s*args\s*=\s*\[\s*("(?:[^"\\]|\\.)*"|''[^'']*'')\s*(?:,|\])') {
                $value = $Matches[1]
                $entryPath = if ($value.StartsWith("'")) { $value.Substring(1, $value.Length - 2) } else { ConvertFrom-Json -InputObject $value }
            }
        }
    }
    $backend = $bridgeEnv['DSH_HOST_PROTOCOL']
    $dshData = if ($bridgeEnv['DSH_HOME']) { $bridgeEnv['DSH_HOME'] } else { Join-Path $env:USERPROFILE '.dsh' }
    $bridgeFolder = if ($backend -eq 'sdk') { 'codex-bridge-sdk' } else { 'codex-bridge' }
    $bridgeData = if ($bridgeEnv['DSH_BRIDGE_HOME']) { $bridgeEnv['DSH_BRIDGE_HOME'] } else { Join-Path $dshData $bridgeFolder }
    if (-not [IO.Path]::IsPathRooted($bridgeData)) { throw 'Use an absolute bridge home in the MCP configuration.' }
    [pscustomobject]@{
        Backend = $backend
        ConfigPath = $configPath
        EntryPath = $entryPath
        BridgeHome = $bridgeData
        Outbox = (Join-Path $bridgeData 'coworker-outbox')
    }
}

function Get-CoworkerOutbox {
    if ($env:COWORKER_OUTBOX) {
        return [IO.Path]::GetFullPath($env:COWORKER_OUTBOX)
    }
    $config = Get-CoworkerConfig
    if ($config.Backend -notin @('gateway', 'sdk')) {
        throw 'Configure dsh_agentlink for Gateway or SDK, or set COWORKER_OUTBOX explicitly.'
    }
    return $config.Outbox
}

function Get-CoworkerSender([string]$outbox) {
  $heartbeat = Join-Path $outbox '.sender-heartbeat'
  if (-not (Test-Path $heartbeat)) { return $null }
  $text = (Get-Content $heartbeat -TotalCount 1) -split '\s+' | Select-Object -First 1
  $candidate = 0
  if (-not [int]::TryParse($text, [ref]$candidate) -or $candidate -le 0) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $candidate"
  if (-not $process.CommandLine -or
      $process.CommandLine -notmatch '(?i)(?:^|[\s"\\/])coworker-sender\.mjs(?:[\s"]|$)') { return $null }
  $outboxArgument = [regex]::Match($process.CommandLine, '(?i)(?:^|\s)--outbox\s+(?:"([^"]+)"|(\S+))')
  $processOutbox = if ($outboxArgument.Groups[1].Success) { $outboxArgument.Groups[1].Value } else { $outboxArgument.Groups[2].Value }
  if ($processOutbox -ne $outbox) { return $null }
  $kernelArgument = [regex]::Match($process.CommandLine, '(?i)(?:^|\s)--kernel\s+(?:"([^"]+)"|(\S+))')
  $processKernel = if ($kernelArgument.Groups[1].Success) { $kernelArgument.Groups[1].Value } else { $kernelArgument.Groups[2].Value }
  return [pscustomobject]@{
    Pid = $candidate
    Kernel = $processKernel
    Fresh = (((Get-Date) - (Get-Item -LiteralPath $heartbeat).LastWriteTime).TotalSeconds -le 30)
  }
}
