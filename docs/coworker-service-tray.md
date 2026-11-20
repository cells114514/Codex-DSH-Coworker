# Coworker 服务托盘与运行时机

托盘程序：`tools/coworker-tray.ps1`（无安装、无依赖，只用 Windows 自带 WinForms）。
它管理的是**发送器**这一个后台服务；bridge 由 Codex 的 MCP 进程按需启动，不在托盘管辖范围内。

## 1. 启动托盘

```powershell
powershell -ExecutionPolicy Bypass -File "<仓库根>\tools\coworker-tray.ps1"
```

或从托盘菜单勾选「开机自启」，之后登录自动出现图标（写入 Startup 快捷方式 `coworker-tray.lnk`）。

同一会话只允许一个托盘实例；重复启动会立即静默退出。

## 2. 菜单项

| 菜单 | 作用 |
| --- | --- |
| 状态：运行中 pid=… 心跳=…s / 已停止（原因） | 只读；每 3 秒自动刷新 |
| 启动发送器 | 幂等；已在运行则只刷新状态 |
| 停止发送器 | 先写 `STOP`，再按心跳里的 pid 结束进程，最后清除 `STOP` |
| 重启发送器 | 停止 + 启动 |
| 打开 outbox 目录 | 打开 `<DSH_BRIDGE_HOME>\coworker-outbox`，可查看记录与 `.sender-heartbeat` |
| 打开会话面板 | 若未运行则先在后台启动 `tools/session-viewer.mjs`（隐藏窗口，仅监听 127.0.0.1:7317），再打开浏览器；只读，不影响任务与通知 |
| 停止会话面板 | 结束该查看器进程；不影响发送器、任务与已入队通知 |
| 检查安装状态 | 显示 MCP 入口、已装 Skill、outbox、发送器四项 |
| 开机自启 | 勾选/取消 Startup 快捷方式 |
| 退出 | 关闭托盘（不会停止发送器） |

判定“运行中”的依据是**心跳新鲜（≤30 s）+ 该 pid 仍存活**，不看进程名，因此残留心跳或复用 pid 都不会被误判。

## 3. 什么时候需要怎么做

| 时机 | 操作 | 原因 |
| --- | --- | --- |
| 登录 Windows 后 | 托盘「启动发送器」（或勾选开机自启让托盘代劳） | 没有发送器时，DSH 完成只会写记录，不会唤醒 Codex |
| 派发任务前 | 看图标状态是否为「运行中」 | `callbackReady=false` 时 Codex 会报告回调不可用，任务不会重发 |
| 任务执行中 | 不需要操作 | 通知会自动入队并唤醒原聊天 |
| 收到通知后 | 不需要操作 | 被唤醒的 Codex 用 `dsh_status` 读取结果并汇报 |
| 需要续接第二轮 | 不需要操作 | `dsh_followup` 省略绑定即沿用 |
| **重启 Codex 之前** | 托盘「停止发送器」 | 重启期间入队的消息会无人消费，避免空投递与堆积 |
| Codex 重启完成后 | 托盘「启动发送器」 | 恢复投递能力 |
| 下班 / 长时间不用 | 托盘「退出」（可选再停发送器） | 只是关图标不会停服务，二者独立 |
| 需要回退到旧版本 | 先停发送器，再恢复 `%USERPROFILE%\.codex\backup-mcp-unify-*\` 并重启 Codex | 见 runbook |
| 怀疑没收到通知 | 「打开 outbox 目录」看记录状态（`pending`/`acknowledged`/`delivery_unknown`） | `delivery_unknown` 不会自动重发 |
| 想查看某任务发生了什么 | 「打开会话面板」 | 只读浏览观察事件、通知状态与完整性缺口，不消耗模型额度 |
| 换机器 / 改路径 | 「检查安装状态」 | 一次性核对入口、Skill、outbox |

## 4. 自检

```powershell
powershell -ExecutionPolicy Bypass -File tools\coworker-tray.ps1 -SelfTest
```

输出 JSON：脚本是否齐全、发送器是否运行及其 pid/原因、`dist/index.js` 是否存在、Skill 是否安装、outbox 是否存在。不创建图标、不改状态。

## 5. 启动方式与“为什么会有 PowerShell 窗口”

托盘脚本由 `powershell.exe` 承载（WinForms），**如果直接在控制台或双击 `.ps1` 启动，那个控制台窗口就是托盘自己的宿主窗口**：它不会自动消失，一旦你把它关掉，托盘（以及菜单）也随之退出。

因此日常请用静默启动器：

```text
tools\coworker-tray.vbs     ← 双击即可，用 wscript 以隐藏窗口方式拉起托盘
```

- 启动器通过 `WScript.Shell.Run(command, 0, False)` 以 **0（隐藏）** 方式运行 `powershell -WindowStyle Hidden -File coworker-tray.ps1`，全程不创建控制台；
- 「开机自启」勾选后写入的快捷方式也指向 `wscript.exe` + 该 `.vbs`，不再出现黑窗；
- 菜单里的启动/停止/重启改用 `Start-Process -WindowStyle Hidden`，避免子进程短暂闪窗。

如果不需要开机自启，也可以给 `.vbs` 建一个桌面快捷方式，双击即可。