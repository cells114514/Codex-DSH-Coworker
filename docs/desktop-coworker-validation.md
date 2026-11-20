# 双桌面 Coworker 通信 — D1–D11 实机验收记录（2026-11-18）

范围：Codex 桌面（`OpenAI.Codex 26.1111.2228.0`，内置内核 `codex-cli 0.169.0-alpha.11.1`）与 DSH Desktop（`0.2.1-rc.2`）之间的通信入口验证。
本文只记录**实际跑过**的项目；未执行项标 `NOT_RUN`，不得引用为通过。证据分 `live`（本机实机）与 `mock`（测试替身）两类，不混用。

信封：仓库外沙箱 `<USER_HOME>\coworker-eval\sandbox\`；候选源码固定在 `<USER_HOME>\coworker-eval\{codex-dsh-bridge,dsh-peer}`。仓库内只有文档变更，未安装任何插件，未改 `~/.codex` 与 `~/.dsh` 配置。

## 1. 结果矩阵

| 编号 | 项目 | 判定 | 类别 | 证据要点 |
| --- | --- | --- | --- | --- |
| D1 | 只读连接（精确原聊天、正确实例、不建新 thread） | **PASS** | live | 桌面内核独立 app-server，`initialize` + `thread/read` 返回 ID 与指定 threadId **完全一致**；未调用 `thread/start` |
| D2 | 空闲自动唤醒（原轮次已结束，收一条消息后自动继续，无人工追加提示） | **PASS** | live | `codex queue` 投递 1 条文本；队列行约 **10.2 s** 被消费（revision 90→91）；原聊天产生新 turn |
| D3 | 原窗口同步（原窗口可见消息与结果，不靠新建/重开） | **PASS（附语义限制）** | live | 操作方确认：程序消息与确认回复**均自动出现在原测试聊天**，未追加、未切换、未重开；但消息呈现为**普通用户气泡** |
| D4 | 双向往返（Codex → 原 DSH Desktop 会话 → 原 Codex → 原 DSH，身份不变） | NOT_RUN | — | 未安装 DSH 侧插件；本轮不做 |
| D5 | DSH 主动提问（Codex 收到并回复，DSH 继续） | NOT_RUN | — | 同上 |
| D6 | 普通日志静默（≥100 条进度/工具事件不唤醒） | NOT_RUN | — | 未做事件洪泛实验 |
| D7 | 同 cwd 多聊天（只唤醒明确绑定的原聊天） | NOT_RUN | — | 未做双聊天绑定实验（只操作了单条测试聊天） |
| D8 | 忙碌及并发（不抢占用户轮次、不重复验收、队列策略明确） | NOT_RUN | — | 未做并发实验 |
| D9 | 断线和确认不明（结果保留，`delivery_unknown` 不自动重发） | NOT_RUN | — | 本轮两次失败投递均为**同步错误**，不是超时/断线场景 |
| D10 | 用户停止（停止后不继续自动交接，晚到消息不唤醒） | NOT_RUN | — | 未做停止语义实验 |
| D11 | 重启边界（消息保留且不重复；未验证情形明确列出） | NOT_RUN | — | 未做重启实验 |

## 2. 关键证据（脱敏）

| 项 | 记录 |
| --- | --- |
| 测试会话 | 单个专用测试聊天，ID 前缀 `<test-id-1>`（完整值仅操作方持有）；未使用任何真实工作聊天 |
| D1 调用 | 桌面内核独立 app-server：`initialize`、`initialized`、`thread/read {includeTurns:false}`；无写调用 |
| D2 投递 | `<desktop-kernel> queue --thread <test-id-1> --message "PROGRAM-GENERATED COMMUNICATION TEST … 只需一句确认"`；退出码 0，消息 id `<test-id-3>` |
| D2 消费观测 | 队列库只读轮询：投递后 1 行（`queue_order 0`，revision 90）→ 约 10.2 s 后 0 行（revision 91） |
| D2 回复观测 | 事后只读 `thread/read {includeTurns:true}`：2 个 turn，最后 `status: completed`，条目 `userMessage` + `agentMessage`（回复 42 字符） |
| D3 观测 | 操作方窗口确认（本轮唯一人类判定项），程序消息与回复在**未操作**的原聊天中出现 |
| 残留 | `queued_items` 最终 0 行；未修改数据库，未使用非官方清理 |

## 3. 模型调用计数

| 场景 | 次数 | 说明 |
| --- | --- | --- |
| D2 自动唤醒 | **1** | 由 `codex queue` 投递触发一次 turn，完成并产生回复 |
| 前两次失败投递 | **0** | 第 1 次 `turn/start` 报 `thread not found`；第 2 次 `thread/resume` 报 `already has an active writer`，均为同步拒绝，未创建 turn |
| 本轮总自动唤醒 | **1**（预算上限 6） | 未重发、未重试、未创建替代 thread |

provider 侧的真实请求数无法从本机遥测独立获得；因此只声明“已观察到的 turn 与回复”，不声明 provider 计费口径。

## 4. 明确未通过的语义

| 目标要求 | 状态 | 说明 |
| --- | --- | --- |
| 关键事件以**工具数据**投递（`toolOutput`） | **未通过** | 协议上 `toolOutput` 是 `turn/start` 的字段，要求 thread 已 attach；独立实例的 `resume` 被 writer 拒绝，故未取得任何 `toolOutput` 投递证据 |
| 来源不得伪装人类指令 | **未满足** | `codex queue` 投递的文本在窗口里是**普通用户气泡**，即被呈现为人类消息；这是本通道的固有限制 |
| 协议写路径（`thread/resume`/`turn/start`） | **被拒** | `-32600 already has an active writer`：桌面实例独占 writer |
| 权限升级由用户决定 | 未涉及 | 本次消息明确不授权任何工具/文件操作，未触发审批 |

## 5. 结论

1. **外部入站入口存在且可用**：每会话的**原生信箱**（`codex queue`）能被运行中的桌面应用消费，并触发原聊天的新 turn；不需要注入进程、抢 writer、关闭窗口或安装扩展。
2. **原窗口自动同步成立**（D3 PASS），但**呈现为人类消息**，因此“外部工具数据、不伪装人类指令”这条交付契约仍缺口。
3. **`toolOutput` 语义未通过**；两条协议写路径在本机被 writer 锁拒绝，与队列路径不矛盾（后者不入该锁）。
4. D4–D11 未执行：DSH 侧插件未安装，多聊天/并发/停止/重启/断线语义均无实机证据。后续若继续，应按任务书 P3 的隔离 profile 方案推进，并保持“文本通道 ≠ 工具数据通道”的区分。
5. 本轮未提交、未发布、未切换正式安装；现有 SDK 工作流、Desktop 版本、凭据与真实任务均未改动。

## 6. 复现路径（仓库外脚本）

| 脚本 | 用途 |
| --- | --- |
| `p1-thread-read.mjs` | D1：桌面内核独立实例只读 `thread/read`，校验 ID 一致 |
| `p2-tooloutput.mjs` | `turn/start` + `toolOutput` 单次投递（本轮失败，保留为证据） |
| `p2-resume-tooloutput.mjs` | `thread/resume` → `toolOutput`（本轮 resume 被 writer 拒绝） |
| `p2-text-queue.mjs` | D2：`codex queue` 文本投递 + 队列只读消费观测 |
| `read-turns-after-queue.mjs` | D2 回复观测：只读 turn 数量与条目类型 |
| `schema/`、`inspect-schema.mjs`、`inspect-turnstart.mjs` | 桌面内核自带的协议 schema 与其字段核查 |

## 7. 修订后的交付契约（操作方已接受）与路线一验证

### 7.1 契约

```text
DSH 完成／提问
→ 后台保存事件与结果（outbox，含 eventId）
→ codex queue 发送固定通知（仅事件/任务标识与状态）
→ 原 Codex 聊天被唤醒
→ Codex 通过 MCP 读取真实结果（dsh_status / dsh_tail）
→ 向原 DSH 会话回复（dsh_followup）
```

明确定义的边界：

| 项 | 说明 |
| --- | --- |
| 通知形态 | **普通用户气泡**，不是原生工具消息；不得标为 toolOutput 或“外部工具数据通道” |
| 通知内容 | 固定模板，只含事件 ID、任务 ID、状态；不含 DSH 生成的任意指令或结论 |
| 授权含义 | 通知**不构成**新的用户授权；文件/工具/权限升级仍需人工批准 |
| 真实内容 | 由 Codex 通过 MCP 工具读取，通知正文不承载结果 |
| 去重 | 每个 `(taskId, execution, cursor)` 至多一次；`sending` 后结果不明记为 `delivery_unknown`，不自动重发 |
| 停止 | 操作方停止后不得再自动交接；晚到消息不得重启工作 |

### 7.2 实现（仓库内工具，路线一：复用现有 SDK 事件流，不装 Desktop 插件）

| 文件 | 作用 |
| --- | --- |
| `docs/operator-tools/coworker-notify.mjs` | 通过 MCP 轮询目标任务至终态 → 写 outbox 记录 → 调 `codex queue` 发送固定通知；只按零退出码 + `Queued message` 判定 acknowledged |
| `docs/operator-tools/coworker-create-task.mjs` | 用现有 SDK 后端创建一条短任务并等待终态，供验证使用 |

### 7.3 验证结果（2026-11-18，live）

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| SDK 任务完成 | `dsh_example_4`，`turn_completed`，回复 16 字符 | 实机 |
| outbox 记录 | `dsh_example_4_turn_completed_20.json`，状态 `acknowledged` | 实机（仓库外目录） |
| 固定通知 | `[coworker] 事件 dsh_example_4:turn_completed:20 / 任务 dsh_example_4 / 状态 turn_completed。用 dsh_status 读取结果。` | 实机 |
| 队列接收 | 退出码 0；随后 `queued_items` 该 thread 行数归零，revision 92→93 | 实机（只读轮询） |
| 原聊天被唤醒 | 该 thread turn 数 2→3 | 实机（只读 `thread/read`） |
| 通过 MCP 读取结果 | 该 turn 含 `mcpToolCall`，`server: dsh_agentlink`，`status: completed` | 实机（只读条目类型） |
| 产生模型回复 | 该 turn `completed`，含两条 `agentMessage`（14 / 30 字符） | 实机 |
| 原窗口同步 | 待操作方确认（本轮未追加、未切换） | 待确认 |
| 反馈原 DSH 会话 | **已完成**：操作方在测试聊天发出 `dsh_followup` 指令后，Codex 调用 `dsh_agentlink` 的 `dsh_status`（`{taskId}`）与 `dsh_followup`（`{taskId, mode, prompt, sinceCursor}`），两者 `status: completed`、`error: null`；该 follow-up 落回**同一任务**（`dsh_example_4`，`rootSessionId 0861f454…`）并产生第 2 个 turn：observed 事件 seq 19–27（`user/message` → `assistant/message` → `turn/end`），`dsh_status.finalMessageLength` 由 16 变为 **81** | 实机 |

另：过程中有一次 SDK 任务因默认路由无 key 而 `MISSING_CREDENTIAL` 失败（0 次模型调用），随后改用 `opencode-go` 路由完成任务，未改动任何路由配置。

### 7.4 额度消耗

| 侧 | 次数 | 说明 |
| --- | --- | --- |
| SDK（opencode-go） | **1** | 验证任务的唯一一次模型调用 |
| Codex（被唤醒的 turn） | **1** | 通知触发的自动唤醒轮次 |
| 失败任务 | 0 | `MISSING_CREDENTIAL`，未到 provider |

因此本轮共 2 次模型调用；通知本身不额外消耗 Codex 轮次之外的额度，也不使用轮询式 wait。

### 7.5 现状与注意事项

- “Codex → 原 DSH 会话”已由操作方在测试聊天中触发 `dsh_followup` 完成，落在同一 task/session，未新建任务；`dsh_status` 的 `finalMessageLength` 由 16 变为 81 即为该轮回复。
- **集成注意**：`dsh_tail` 返回的是 ledger 信封（`type: "session/event"` + `digest`），不是原始会话事件类型；按 `type === "user/message"` 过滤会漏判。读取回复应以 `dsh_status.finalMessage` 或 observed store（`observed/<task>/events.jsonl`）为准。
- 反向（DSH → Codex）尚未闭环：需要把这次新完成事件再发一次固定通知，才会回到原 Codex 聊天；本轮未自动发送。
- 去重、停止、重启三项测试仍未做。
- 因此当前状态是：**路线一（SDK 事件流 + 原生信箱）单向往返已闭环（§7.6–7.7），仍不是双桌面插件模式，也不是完整 Coworker 模式**。

### 7.6 去重验证（B，零成本：不发通知、不唤醒）

对已投递并 acknowledged 的同一事件 `dsh_example_4:turn_completed:20` 重新运行通知器（`--event-id` 固定身份），并用三个独立可观测值前后对比，而不是只看返回字段：

| 观测 | 前 | 后 | 判定 |
| --- | --- | --- | --- |
| 该 thread 的 `queued_items` 行数 | 0 | 0 | 无新增队列消息 |
| `queued_thread_revisions.revision` | 93 | 93 | 队列未被改写 |
| 该 thread 的 turn 数 | 4 | 4 | **未触发 Codex 轮次** |
| outbox 记录状态 | `acknowledged` | `acknowledged` | 未被重置或重发 |

通知器返回 `deduplicated: true`、退出码 0，且未调用 `codex queue`。脚本：`docs/operator-tools/coworker-dedupe-check.mjs`。

### 7.7 反向闭环（A，一次固定通知）

对同一任务的新完成事件发送一次固定通知：

| 项 | 结果 |
| --- | --- |
| 事件身份 | `dsh_example_4:turn_completed:30` |
| 通知文本（固定） | `[coworker] 事件 …:30 / 任务 dsh_example_4 / 状态 turn_completed。用 dsh_status 读取结果。` |
| 投递 | 退出码 0，outbox `acknowledged` |
| 队列消费 | 该 thread 行数归零，revision 93→94 |
| Codex 唤醒 | turn 数 4→**5**，该 turn `completed`；条目 `userMessage` → `agentMessage` → `mcpToolCall` → `agentMessage`（14 / 43 字符） |
| 该 turn 的 MCP 调用 | 仅 `{taskId}`（读取）；**未**再调用 `dsh_followup` |
| DSH 侧 | 未被追加新 turn：`finalMessageLength` 仍 81，cursor 仍 30 |

### 7.8 循环边界

- 本次验收后不再自动发送通知，因此不会形成“互相唤醒”的循环；7.7 中 Codex 只读取、未回写，DSH 侧无新增 turn。
- 若将来连续运行通知器，每个新的完成事件都会各触发一次 Codex 唤醒；这是设计上的上限来源，需按 §7.1 的次数与用量上限约束。
- **D4/D5 仍为 `NOT_RUN`**：它们要求“原 DSH **Desktop** 会话”，而本轮闭环的 DSH 端是 SDK 后端（`opencode-go`）。本轮结果记为**路线一（SDK 事件流 + 原生信箱）单向往返已闭环**，**不**记为双桌面插件模式通过。

## 8. 停止、重启与投递不确定性（自动化状态机断言，纳入 `npm run check`）

本节在 2026-11-18 晚完成硬化：状态机用例改为 `test/coworker-notifier.test.ts`（9 项断言，失败即非零退出，随 `npm run check` 一起跑）。全部使用本地队列 stub 与临时 outbox：**零真实入队、零模型唤醒**（真实队列 `queued_items` 0 行、`revision` 95 未变；真实 outbox 仍只有既有两条 `acknowledged`；该测试聊天 turn 数 5 未变）。

### 8.1 加固点

| 项 | 实现 |
| --- | --- |
| 跨进程互斥 | 每个事件一个 `.<event>.lock`，`open(..., "wx")` 独占创建；拿不到锁则等待（默认 2 s）后返回 `locked`（退出码 4），**不发送**。`check → 状态转换 → 发送` 全在锁内 |
| 陈旧锁 | 崩溃残留的锁**不抢占**：新进程视其结果为未知，返回 `locked` |
| outbox 读取 | 只有 `ENOENT` 视为“不存在”；损坏 JSON、权限错误及其他读取错误返回 `outbox_unreadable`（退出码 3），**不覆盖、不发送** |
| 异常退出分类 | 非零退出也可能发生在入队之后，不能证明明确拒绝；非零退出、零退出但无可解析回执、被信号终止、spawn 报错统一保守记 `delivery_unknown` |
| 回执校验 | 解析 `Queued message <messageId> for thread <threadId>`，**同时核对消息 ID 与目标 threadId**；thread 不匹配记 `delivery_unknown` |
| 原子写入 | 先写 `*.tmp` 再 `rename`，避免半写记录 |
| 崩溃窗口 | 提供 `COWORKER_CRASH_AFTER_SEND=1` 测试钩子：发送后、落盘前 `exit 70`；重启时残留锁使其不再发送 |

### 8.2 断言结果（9/9 通过）

| 用例 | 断言 |
| --- | --- |
| 停止标记 | 退出码 2、`suppressed-after-stop`、stub 尝试 0 次 |
| 两个并发通知器 | **恰好 1 次** stub 尝试；一个 `acknowledged`，另一个 `locked`；记录含 `messageId` |
| 记录损坏 | 退出码 3、`outbox_unreadable`、0 次尝试、损坏文件原样保留 |
| 重启（`pending`） | 首次投递 1 次转 `acknowledged`；第二次 `deduplicated`、尝试数不变 |
| 重启（`acknowledged`） | `deduplicated`、尝试 0 次 |
| 回执丢失 | `delivery_unknown`，1 次尝试；再跑不重试 |
| 非零退出无回执 | `delivery_unknown`，1 次尝试，不重发 |
| 回执 thread 不匹配 | `delivery_unknown`，记录 `reason: thread-mismatch` |
| 发送后崩溃 | 崩溃运行 1 次尝试、退出码 70；重启返回 `locked`、**尝试数仍为 1** |

### 8.3 历史记录（修复前的零模型手工测试）

全部使用队列 stub（`docs/operator-tools/coworker-queue-stub.mjs`）与临时 outbox，未调用真实 `codex queue`，未唤醒任何聊天，未向 DSH 追加任务。真实队列前后：`queued_items` 该 thread 行数 0 → 0；真实 outbox 只有既有两条 `acknowledged`；Codex 该 thread turn 数 5 → 5。

| 用例 | 场景 | 结果 | 判定 |
| --- | --- | --- | --- |
| 1 | 停止标记存在时的完成事件 | 退出码 2，状态 `suppressed-after-stop`，stub 尝试 **0** 次 | 不入队、不唤醒、不重启协作 |
| 2 | 重启后处理“未发送”记录（`pending`） | 首次投递 **1** 次并转 `acknowledged`；再次运行 `deduplicated: true`，尝试数不变 | 恢复后至多投递一次 |
| 3 | 重启后处理“已确认入队”记录（`acknowledged`） | `deduplicated: true`，尝试 **0** 次 | 不得重发 |
| 4 | 入队可能成功但回执丢失（stub 零退出、无回执） | 状态 `delivery_unknown`，尝试 1 次；再次运行不重试、仍为 `delivery_unknown` | 不自动重试 |
| 5 | stub 非零退出 | 状态 `delivery_unknown`，尝试 1 次，不自动重试 | 退出码不证明未入队 |

### 语义边界

- **停止不能撤回已入队消息**：停止标记只阻止通知器“后续发送”；对已经进入 Codex 原生队列的消息无效。本轮真实发送过的两条（`…:turn_completed:20`、`…:turn_completed:30`）均已被消费，本地取消无法追回。
- **不从退出码推断拒绝**：零退出但无可用回执及非零退出均记 `delivery_unknown`，不自动重发。当前 CLI 没有本适配器已验证的结构化拒绝回执，因此不声称能可靠分类 `rejected`。

后续源码复核补充：队列子进程改在 `close`（stdio 已结束）后解析回执；新增“stub 记录插入副作用后退出 1”的自动化断言，确认再次运行仍不发送。该补充仅使用 stub，不能当作真实 Codex 队列故障注入验收。
- 通知器新增参数：`--stub`（测试替身）、`--stop-file`（默认 `<outbox>/STOP`）、`--event-id`（固定事件身份）。`STOP` 文件存在时状态为 `suppressed-after-stop`，退出码 2。

### 仍未完成

- 真实环境下的“停止后晚到事件”没有实机证据：本轮用标记 + stub 证明状态机行为，未触发真实队列。
- 重启指的是**通知器进程重启**；Codex 应用重启、DSH 重启下的消息保留与去重仍为 `NOT_RUN`（D11）。
- D4/D5 仍是 `NOT_RUN`（要求 DSH Desktop 会话，本轮 DSH 端是 SDK 后端）。

## 9. 单在途契约与消费确认

### 9.1 契约

同任务同一时刻只允许一个在途执行。执行中第二次提交在按任务互斥锁内被拒绝，返回 `prompt_in_flight`（`retryable=false`），**不调用** `prompt()`，也不改变当前代次、待处理队列或持久化编号；执行确认结束后可用 `dsh_followup` 续接。该守卫覆盖所有同任务 SDK prompt 入口，与是否绑定 coworker 无关。

完成判定不使用 turn/end 或“最后一个子任务结束”：根 session 的 `session.status idle` 之后调用官方 `session/wait`（等待托管后代与根汇总轮），确认成功才释放守卫并写完成记录。确认在事件循环之外执行、绑定发起时的 `executionId`，客户端关闭时中止；迟到确认不会释放后续执行，也不会重复写记录。

### 9.2 验收证据（隔离环境，`dsh_example_5`）

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| 完成落盘 | 通过 | `dsh_example_5_e1_turn_completed.json`，`turnSeq 17`，`createdAt 03:17:01.222Z` |
| 入队接受 | 通过 | 回执校验通过，`status: acknowledged`，`deliveredAt 03:17:02.446Z` |
| 消费 | 通过（延迟，约 2–3 分钟） | 队列行消失，`revision 98→99`，`pendingRows 0` |
| 自动唤醒 | 通过 | 聊天轮次 `6→7` |
| MCP 读取 | 通过 | 新一轮条目 `userMessage → agentMessage → mcpToolCall → agentMessage` |
| 执行中追加输入 | 通过（被拒） | `prompt_in_flight`，`prompt()` 未调用 |
| e2 续接与第二条通知 | **未执行**（上一轮在消费确认处停止，未续跑） | — |

### 9.3 修正与限制

- 曾把一次失败的 `dsh_delegate` 调用计作“1 次 prompt”，实际该次未触达 `runtime.prompt`（任务与绑定已建立后因工作区独占认领冲突失败），真实消耗为 0。计数口径已改为 `delegateCalls` / `confirmedPrompts` / `unknownSends` 分开统计。
- 消费确认改为按回执中的**精确 messageId + threadId** 有界等待（最长 90 s，只读队列数据库，不调用模型或 MCP 观察工具）。超时记为 `consumption_timeout` 并保留原消息与诊断，不据此推断应用窗口状态。
- 队列行消失不等于模型已审阅：消费、聊天新增轮次、MCP 读取三段分别取证。
- 失败通知的 live 状态、e2 的 live 状态仍未验证。
## 10. 两轮实机验收（正常续接，单 bridge 生命周期）

### 10.1 结果（尝试 2 通过；尝试 1 停止于 e2 消费判定）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| e1 派发 + `callbackReady` | 通过 | `dsh_example_6`，`registered/bindingSaved/senderReady/callbackReady` 全 true |
| 执行中追加 | 通过（被拒） | `prompt_in_flight`，`prompts` 未增加 |
| e1 完成落盘 | 通过 | `dsh_example_6:e1:turn_completed` |
| e1 入队接受 | 通过 | 回执 `<test-id-7>`，`deliveredAt 03:57:37.920Z` |
| e1 消费 | 通过（精确 messageId，2.0 s） | 队列 `revision 105→107`，`pendingRows 0` |
| e1 唤醒与 MCP 读取 | 通过 | 聊天新增轮次，条目含 `mcpToolCall` |
| e2 续接（同 task/session，绑定复用） | 通过 | `coworker.reused=true` |
| e2 入队接受 / 消费 | 通过 | 回执 `<test-id-8>`，`deliveredAt 03:57:46.166Z`，4.0 s |
| e2 唤醒与读取 | 通过 | 聊天 `turnCount 12`，最后一轮含 `mcpToolCall` |
| e1 不重放 | 通过 | e1 `deliveredAt` 在 e2 之后保持不变 |
| 统一关闭 | 通过 | bridge `33120` 与 runtime `31540` 均已退出；`cleanShutdown=true`（`03:57:50.705Z`） |
| 派发后观察调用 | 0 | 未使用 `dsh_status` / `dsh_watch` / `dsh_tail` |

### 10.2 尝试 1 的失败与修复

尝试 1 在 e2 之后停止：驱动仍用**整线程 pending 行数**判定 e2 消费，且只在回执后检查一次；当时消息尚未被消费。修复：e2 改用与 e1 相同的**精确 messageId + 有界等待**；探测在“已确认回执但行已消失”时判为 `consumed`（`row-absent-after-acknowledged-receipt`），无回执时仍报 `never_accepted`。回归见 `test/coworker-consumption-race.test.ts`。

### 10.3 预算

批次总预算 4 prompt / 4 通知 / 2 次被拒追加 / 2 次尝试；实际消耗 **4 / 4 / 2 / 2**，第 2 次尝试通过后不再运行。

### 10.4 仍为未验证

- 失败（`failed`）通知的实机投递；
- 应用重启、DSH 重启下的消息保留；
- 历史任务的受控恢复（`dsh_example_5` 记录无 `runtimePid`，证据不足，未执行）；
- SDK 私有 `child` 句柄的跨版本兼容性（当前固定 `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3`）。

## 11. Gateway 完成回调：实机通过（单轮）

状态：**实机通过（单轮）**。任务 `dsh_example_9`（DSH Desktop 会话「专用测试会话」），绑定聊天 `<test-id-10>`，事件 `dsh_example_9:e5:turn_completed`，回执 `<test-id-11>`。

### 11.1 一条链，五个可核对的点

| # | 环节 | 证据（本机只读取证） |
| --- | --- | --- |
| 1 | 自动落盘 | `coworker-outbox\dsh_example_9_e5_turn_completed.json`：`createdAt 11:24:35.429Z`、`turnSeq 9`、`executionId e5`；由桥内在 `turn/end` 后自动写入，派发端未轮询 |
| 2 | 入队回执 | 同一记录：`send.exitCode 0`、`messageId <test-id-11>`、`receiptThread <test-id-2>`、`status acknowledged` |
| 3 | 队列消费 | 队列 `revision 151 → 153`（入队 +1、消费 +1），`pendingRows 0`，该 `messageId` 不再出现在 `queued_items` |
| 4 | 目标聊天收到通知 | 聊天 `turnCount 21 → 24`，其中**仅轮次 23** 的用户消息含精确 `eventId` `dsh_example_9:e5:turn_completed`；条目序列 `user-message → agent-message → mcp-tool-call → agent-message` |
| 5 | 接收方读取结果 | 轮次 23 的助手文本含固定标记 `COWORKER-E2E-1`，且该轮有 1 次 `mcpToolCall`（只读 `dsh_status`） |

### 11.2 两处证据分别来自哪里

| 证据 | 来源 | 说明 |
| --- | --- | --- |
| DSH 原会话回复了标记 | Codex 聊天 **轮次 22**：`user` 与 `agent` 文本均含 `COWORKER-E2E-1`，带 1 次 `mcpToolCall` | 该轮是**人工发起**的带绑定 `dsh_followup` 及其回读；它证明 DSH 侧确实产出了固定标记 |
| Codex 聊天收到通知并读取结果 | Codex 聊天 **轮次 23**：用户消息含 `e5` 的精确 `eventId`，随后 1 次 `mcpToolCall`，助手文本含 `COWORKER-E2E-1` | 该轮由**通知唤醒**产生，是本次唯一可归因于 e5 的轮次；其余新增轮次（22、24）来自人工操作，不计入 |

桥接侧记录（`ledgers\dsh_example_9\events.jsonl`）保留了 `assistant/message` 的 `seq`/`turn`（正文按隐私策略不入库），因此“DSH 回了什么”以聊天轮次 22 与轮次 23 的一致标记为准。

### 11.3 预算

本次验收：**1 次 DSH 输入、1 条通知、1 次唤醒**，未追加第二轮。

### 11.4 保持原状的记录

- `dsh_example_9:e3:turn_completed`、`:e4:turn_completed` 仍为 `delivery_unknown`（当时真实退出码已被旧回写覆盖），**未重发**；
- 两次通道自检记录 `dsh_selftest01/02` 保留，仅作投递通道证据，不对应任何 DSH 任务；
- `e3/e4/e5` 均未重放。

### 11.5 仍未实机验证

- **两轮续接的绑定复用 + 第二条独立通知**（本批只跑了单轮；`e2` 复用为 mock 覆盖）；
- **失败（`failed`）通知**的实机投递；
- **桌面端直接发消息不误通知**（仅 mock 覆盖：`turn-not-submitted-by-bridge` 诊断）；
- 应用/DSH 重启下的消息保留与去重。