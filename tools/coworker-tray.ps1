# Coworker tray: one icon that starts, stops and reports the sender.
# Requires no install; run with: powershell -ExecutionPolicy Bypass -File coworker-tray.ps1
# -SelfTest validates the status logic and exits without creating an icon.

param([switch]$SelfTest, [switch]$StartSender)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'coworker-config.ps1')
$config = Get-CoworkerConfig
$outbox = Get-CoworkerOutbox
$env:COWORKER_OUTBOX = $outbox
$heartbeat = Join-Path $outbox ".sender-heartbeat"
$startScript = Join-Path $PSScriptRoot "coworker-sender-start.ps1"
$stopScript = Join-Path $PSScriptRoot "coworker-sender-stop.ps1"
$entry = $config.EntryPath
$viewerScript = Join-Path $PSScriptRoot "session-viewer.mjs"
$viewerPort = if ($env:COWORKER_VIEWER_PORT) { [int]$env:COWORKER_VIEWER_PORT } else { 7317 }
$viewerUrl = "http://127.0.0.1:$viewerPort/"
$bridgeHome = $config.BridgeHome
$skillPath = Join-Path $env:USERPROFILE ".codex\skills\codex-dsh\SKILL.md"

function Get-SenderState {
  $state = [pscustomobject]@{ Running = $false; Pid = $null; AgeSeconds = $null; Reason = "no-heartbeat"; Outbox = $outbox }
  if (-not (Test-Path $heartbeat)) { return $state }
  $age = [int]((Get-Date) - (Get-Item $heartbeat).LastWriteTime).TotalSeconds
  $text = (Get-Content $heartbeat -TotalCount 1) -split '\s+' | Select-Object -First 1
  $candidate = 0
  if (-not [int]::TryParse($text, [ref]$candidate)) { $state.Reason = "heartbeat-unparsable"; return $state }
  $process = Get-CoworkerSender $outbox
  $state.Pid = $candidate
  $state.AgeSeconds = $age
  if (-not $process) { $state.Reason = "sender-not-found"; return $state }
  if (-not $process.Kernel -or -not (Test-Path -LiteralPath $process.Kernel -PathType Leaf)) { $state.Reason = "kernel-missing"; return $state }
  if (-not $process.Fresh) { $state.Reason = "stale-heartbeat"; return $state }
  $state.Running = $true
  $state.Reason = "running"
  return $state
}

function Test-Viewer {
  try {
    $response = Invoke-WebRequest $viewerUrl -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Start-Viewer {
  if (Test-Viewer) { return $true }
  if (-not (Test-Path $viewerScript)) { return $false }
  $node = (Get-Command node).Source
  Start-Process -FilePath $node -ArgumentList @(
    "`"$viewerScript`"",
    "--bridge-home", "`"$bridgeHome`"",
    "--port", "$viewerPort"
  ) -WorkingDirectory $repo -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    if (Test-Viewer) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Stop-Viewer {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*session-viewer.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Get-InstallState {
  return [pscustomobject]@{
    EntryPresent = [bool]($entry -and (Test-Path -LiteralPath $entry -PathType Leaf))
    SkillInstalled = Test-Path $skillPath
    OutboxPresent = Test-Path $outbox
    ViewerRunning = Test-Viewer
  }
}

if ($SelfTest) {
  $sender = Get-SenderState
  $install = Get-InstallState
  [pscustomobject]@{
    Backend = $config.Backend
    Outbox = $outbox
    EntryPath = $entry
    ScriptsPresent = (Test-Path $startScript) -and (Test-Path $stopScript)
    SenderRunning = $sender.Running
    SenderPid = $sender.Pid
    SenderReason = $sender.Reason
    EntryPresent = $install.EntryPresent
    SkillInstalled = $install.SkillInstalled
    OutboxPresent = $install.OutboxPresent
    ViewerRunning = $install.ViewerRunning
    ViewerUrl = $viewerUrl
  } | ConvertTo-Json
  exit 0
}

# One tray per session: a second instance would fight over the same outbox.
$mutex = New-Object System.Threading.Mutex($false, "Global\CoworkerTray")
if (-not $mutex.WaitOne(0)) {
  # Silent exit: a modal dialog in a hidden launch would hang forever.
  exit 0
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "Coworker 发送器"
$notify.Visible = $true

function Update-Tray {
  $state = Get-SenderState
  $label = if ($state.Running) { "运行中 pid=$($state.Pid) 心跳=$($state.AgeSeconds)s" } else { "已停止（$($state.Reason)）" }
  $notify.Text = "Coworker: $label"
  $statusItem.Text = "状态：$label"
  $viewerStopItem.Enabled = Test-Viewer
  $startItem.Enabled = -not $state.Running
  $stopItem.Enabled = $state.Running
  return $state
}

function Show-Balloon([string]$title, [string]$text, [string]$icon = "Info") {
  $notify.BalloonTipTitle = $title
  $notify.BalloonTipText = $text
  $notify.BalloonTipIcon = $icon
  $notify.ShowBalloonTip(4000)
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
$startItem = New-Object System.Windows.Forms.ToolStripMenuItem("启动发送器")
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem("停止发送器")
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("重启发送器")
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem("打开 outbox 目录")
$viewerItem = New-Object System.Windows.Forms.ToolStripMenuItem("打开会话面板")
$viewerStopItem = New-Object System.Windows.Forms.ToolStripMenuItem("停止会话面板")
$checkItem = New-Object System.Windows.Forms.ToolStripMenuItem("检查安装状态")
$autoStartItem = New-Object System.Windows.Forms.ToolStripMenuItem("开机自启")
$autoStartItem.CheckOnClick = $true
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("退出")

$startupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "coworker-tray.lnk"
$autoStartItem.Checked = Test-Path $startupLink

function Invoke-SenderScript([string]$scriptPath) {
  $child = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $scriptPath)
  ) -WindowStyle Hidden -PassThru
  return ($child.WaitForExit(20000) -and $child.ExitCode -eq 0)
}
$startItem.add_Click({
  $ok = Invoke-SenderScript $startScript
  $state = Update-Tray
  if ($ok -and $state.Running) { Show-Balloon "发送器已启动" "pid=$($state.Pid)" } else { Show-Balloon "启动失败" "原因：$($state.Reason)" "Warning" }
})
$stopItem.add_Click({
  $ok = Invoke-SenderScript $stopScript
  $state = Update-Tray
  if ($ok -and -not $state.Running) { Show-Balloon "发送器已停止" "已入队消息会继续保留" } else { Show-Balloon "停止失败" "请检查发送器状态" "Warning" }
})
$restartItem.add_Click({
  $ok = (Invoke-SenderScript $stopScript) -and (Invoke-SenderScript $startScript)
  $state = Update-Tray
  if ($ok -and $state.Running) { Show-Balloon "发送器已重启" "pid=$($state.Pid)" } else { Show-Balloon "重启失败" "原因：$($state.Reason)" "Warning" }
})
$openItem.add_Click({ Start-Process explorer.exe $outbox })
$viewerItem.add_Click({
  if (Start-Viewer) {
    Start-Process $viewerUrl
    Show-Balloon "会话面板已打开" $viewerUrl
  } else {
    Show-Balloon "会话面板启动失败" "检查 node 与 tools\session-viewer.mjs 是否存在" "Warning"
  }
})
$viewerStopItem.add_Click({
  Stop-Viewer
  Show-Balloon "会话面板已停止" "只影响本地查看，不影响任务与通知"
})
$checkItem.add_Click({
  $install = Get-InstallState
  $state = Get-SenderState
  $lines = @(
    "MCP 入口（$($config.Backend)）：$(if ($install.EntryPresent) { '存在' } else { '缺失' })",
    "已安装 Skill：$(if ($install.SkillInstalled) { '存在' } else { '缺失' })",
    "outbox：$(if ($install.OutboxPresent) { '存在' } else { '缺失' })",
    "发送器：$(if ($state.Running) { "运行中 pid=$($state.Pid)" } else { "未运行（$($state.Reason)）" })"
  ) -join "`r`n"
  [System.Windows.Forms.MessageBox]::Show($lines, "Coworker 安装状态") | Out-Null
})
$autoStartItem.add_Click({
  if ($autoStartItem.Checked) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupLink)
    $shortcut.TargetPath = "wscript.exe"
    $shortcut.Arguments = "`"$(Join-Path $PSScriptRoot 'coworker-tray.vbs')`""
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Save()
    Show-Balloon "已设置开机自启" "登录后显示托盘图标并启动发送器"
  } else {
    Remove-Item $startupLink -ErrorAction SilentlyContinue
    Show-Balloon "已取消开机自启" ""
  }
})
$exitItem.add_Click({ $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() })

[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($startItem)
[void]$menu.Items.Add($stopItem)
[void]$menu.Items.Add($restartItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add($viewerItem)
[void]$menu.Items.Add($viewerStopItem)
[void]$menu.Items.Add($checkItem)
[void]$menu.Items.Add($autoStartItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($exitItem)
$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Show-Balloon "Coworker" (Update-Tray | ForEach-Object { if ($_.Running) { "运行中 pid=$($_.Pid)" } else { "已停止：$($_.Reason)" } }) })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ Update-Tray | Out-Null })
$timer.Start()

if ($StartSender -and -not (Get-SenderState).Running -and -not (Test-Path -LiteralPath (Join-Path $outbox "STOP"))) {
  if (-not (Invoke-SenderScript $startScript)) { Show-Balloon "发送器启动失败" "请检查 Codex 是否已安装，以及托盘中的发送器状态" "Warning" }
}
Update-Tray | Out-Null
Show-Balloon "Coworker 托盘已启动" "发送器$(if ((Get-SenderState).Running) { '运行中' } else { '未运行，点击菜单启动' })"

[System.Windows.Forms.Application]::Run()
$timer.Stop()
$notify.Visible = $false
$notify.Dispose()
$mutex.ReleaseMutex()
$mutex.Dispose()
