# Coworker 回调试用操作说明

适用范围：官方 Desktop Gateway 或 SDK 后端、本机 Codex 桌面端及 `dsh_agentlink` MCP。Windows 验收结果见 [验证记录](desktop-coworker-validation.md)。

## Gateway 快速上手

1. 按 [官方 Desktop Gateway](official-desktop-gateway.md) 安装并通过启动器完成授权。
2. 从仓库根目录启动下面的发送器。Gateway 默认 outbox 为 `~/.dsh/codex-bridge/coworker-outbox`。若显式设置了 `DSH_BRIDGE_HOME`，用实际目录下的 `coworker-outbox`。
3. 在希望收到通知的 Codex 聊天里，提供该聊天的完整 UUID 和准确的 DSH Desktop 会话。让 Codex 附着到空闲根会话，再用 `dsh_followup` 传入 `coworker.threadId`。
4. `callbackReady=true` 时可结束当前 Codex 轮次，收到通知后再查询结果。单轮流程已在 Windows 实机验证。

## 1. SDK 独立构建示例

```powershell
cd <repo>
npx tsc -p tsconfig.json --outDir dist-cw   # 试用期使用独立输出
```

MCP 配置里的入口指向该输出（示例，保持你现有配置风格）：

```toml
[mcp_servers.dsh_agentlink]
command = "node"
args = ["<repo>\\dist-cw\\index.js"]
env = { DSH_HOME = "<isolated home>", DSH_BRIDGE_HOME = "<isolated home>\\codex-bridge-sdk", DSH_HOST_PROTOCOL = "sdk", DSH_SDK_PROVIDER = "opencode-go", DSH_SDK_MODEL = "deepseek-v4.1-flash" }
```

## 2. 发送器

从仓库根目录启动。将内核占位符替换成 Codex 安装目录中实际的 `resources/codex.exe` 路径：

```powershell
node .\docs\operator-tools\coworker-sender.mjs `
  --outbox "<bridge home>\coworker-outbox" `
  --kernel "<Codex 内核绝对路径>" `
  --interval 2
```

停止：写入 STOP 标记（阻止后续发送，不撤回已入队消息），再结束进程：

```powershell
New-Item "<bridge home>\coworker-outbox\STOP" -ItemType File
Get-Process -Id <sender pid> | Stop-Process
Remove-Item "<bridge home>\coworker-outbox\STOP"
```

回执与重发规则：`delivery_unknown` **不自动重试**；需要人工核对队列后再决定。

## 3. Skill 更新

仓库内已随提交更新 `skill/codex-dsh/SKILL.md` 与 `skill/claude-code-dsh/SKILL.md`。
使用安装器更新对应客户端的 Skill。只使用 Codex 时，只需更新 Codex Skill。

## 4. Codex 重启

MCP 入口或 skill 变更后需重启 Codex 桌面端才会加载新代码（本批**未重启**）。
重启前确认发送器已停止或 STOP 已置位，避免重启期间的空投递。

## 5. 回调不可用的处理

委派返回 `coworker.callbackReady=false` 时：

1. 报告“任务已接收，但回调不可用”，**不要**重发任务；
2. 用 `dsh_status` 人工检查，或等发送器就绪后再看 outbox；
3. 不要静默恢复 `dsh_watch` 轮询循环；仅用户明确要求持续监督时使用 `dsh_watch`。

`prompt_in_flight`（`retryable=false`）表示本次提交不自动重试，**不代表任务不能续接**：当前执行终结后用 `dsh_followup` 继续。

## 6. 回退步骤

```powershell
# 1) 停发送器（STOP + 结束进程）
# 2) MCP 配置改回原入口（或删除 coworker 相关 env）
# 3) 重启 Codex 桌面端
# 4) 需要彻底回退时删除试用期独立输出目录 dist-cw
```

已入队但未消费的消息仍会留在 Codex 队列中；回退不会撤回它们。

## 7. 绑定当前聊天（重要限制）

**当前没有可靠的自动获取聊天 UUID 的方式**，且明确禁止按标题、cwd 或最近时间猜测。
试用期采用人工绑定：

1. 在 Codex 里打开目标聊天，从 `~/.codex` 的会话索引或聊天详情中复制该会话 **UUID**；
2. 委派时显式传入：

```json
{ "coworker": { "threadId": "<uuid>", "outboxDir": "<bridge home>\\coworker-outbox" } }
```

3. 同一任务后续 `dsh_followup` **可省略** `coworker`，会沿用已确认绑定；
4. 改绑必须显式传入新的 `threadId`。

自动化绑定（例如由 Codex 侧提供当前会话标识）尚未实现，列为试用限制。
