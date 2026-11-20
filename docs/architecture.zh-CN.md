# Codex-DSH-Orchestrator 架构与安全模型

[English](architecture.md) | **简体中文**

本文描述共享协作语义与 legacy rc.6 RPC 路径。官方 Win/Mac adapter 的认证、发现、队列映射及能力差异见[官方 Desktop Gateway](official-desktop-gateway.md)，协议细节以实际选择的 adapter 为准。

可选第三种后端只在 `DSH_HOST_PROTOCOL=sdk` 时被选中：它通过 stdio 运行 DSH SDK runtime，而不是连接 Host。它既不是默认后端，也不会作为自动回退被选中，详见 [SDK 后端](#sdk-后端)；证据见 [SDK 后端能力验证](sdk-qualification.md)，配置步骤见 [SDK 后端](sdk-backend.zh-CN.md)。

## 定位与 Host 生命周期

Codex-DSH-Orchestrator 是调用方一侧的编排项目，不是 DSH Cordis bundle。Codex 或 Claude Code 等已支持的调用方会把基于 dsh-Agentlink 派生的 bridge runtime 作为本地 STDIO MCP server 启动，bridge 再连接独立运行的官方 DSH Web Host。

bridge 采用 connect-only 模式：它不会启动、守护、停止或拥有 `dsh web`，也不负责 Host pidfile 或端口锁。Host 生命周期由用户或操作系统服务管理，因此单个调用方 MCP 进程退出后，DSH session 仍可留在官方 Web UI 中查看。

以上规则描述的是 Host-backed（`legacy` 与 `gateway`）后端。可选 SDK 后端没有 Host：它自行启动并拥有自己的 runtime 进程，对外报告 `lifecycleOwnership="bridge-managed-runtime"`。见 [SDK 后端](#sdk-后端)。

## 身份与状态模型

BridgeTask、DSH root session 和 DSH turn 是三种不同对象：

- 一个 BridgeTask 保存一条稳定的 `taskId -> rootSessionId` 映射。
- 一个 root session 可以运行多个 turn；`turn_completed` 不会删除 task，也不会阻止后续 follow-up。
- session-backed DSH subagent descendant 会从 `session.list`/`subagent.list` 中发现并独立 reconcile，在 task ledger 中保留 `parentSessionId` 与 `origin="subagent"`。

状态不会把连接可用性和执行状态压缩成一个枚举：

- `availability`: `connected | host_unreachable | session_not_found`
- `execution`: `starting | running | awaiting_approval | awaiting_input | turn_completed | failed | canceled | interrupted`
- availability 覆盖当前 execution observation 时，公开 `status` 为 `unknown`，同时保留 `lastKnownExecutionStatus`

queue depth 来自最新且完整的 `session/queue` snapshot：

- `nextTurn`: `placement="queued"`
- `steering`: `placement="steering"`
- `context`: `placement="context"`
- `nextStep`: steering 与 context 的合计
- `total`: 全部 pending item

一旦 `events.mux` 断开，queue 状态会立即标记为 stale 或 unknown。

## 事件账本与恢复

DSH session/history 是会话内容的唯一事实来源。bridge 不会把 prompt、用户或 assistant 文本、tool 参数与结果、question body 复制到本地文件。它只在三个彼此分离的 store 中持久化 coordination state：

1. `tasks/<taskId>.json` 只包含 `{taskId, sessionId}`。
2. `claims/<taskId>.json` 包含 canonical cwd、task/session owner、claim mode 和创建时间。
3. `ledgers/<taskId>/events.jsonl` 是可重建的 coordination index，保存 task cursor、lineage、source watermark、无正文的 execution/pending 状态、已发出的 rpcId 和 final-message pointer。

每条 JSONL record 都有单调递增的 task `cursor`/`mergeIndex`、`sourceSessionId`，以及可选的 `sourceSeq`、`parentSessionId`、`origin`、event type 和经过清理的 `coordination` 对象。它不会保存完整 mux/history envelope。`mergeIndex` 只表示 bridge 的观察与持久化顺序，不是 DSH 全局因果顺序。

task ledger append 与 workspace claim 变更使用 task/registry scoped 的跨进程锁。writer 持锁后重新读取磁盘状态，再分配 cursor 或修改 claim。不可变 task mapping 使用原子临时文件加 hard-link 创建。指向同一 `DSH_BRIDGE_HOME` 的 bridge 进程会共享 coordination state，也必须连接同一个 Host；更换 Host origin 时应使用新的 bridge home。锁只用于本地文件系统上的短临界区；自动 stale-lock 回收被明确禁用，因为 PID/mtime 观察无法与后续破坏性 rename 原子绑定。writer 被强制终止时可能留下 fail-closed 锁，需要操作者显式恢复。

恢复流程采用 subscribe-first：

1. 打开 `events.mux` 并缓冲 live frame。
2. 读取每个 `session/subscribed.lastSeq` watermark；cold session 则以已打开的 stream 作为 fence。
3. 从 `session.history`/`subagent.history` 向后分页，直到已持久化的 per-session high watermark。
4. 按 `(sourceSessionId, sourceSeq)` 排序并做确定性去重。
5. 清空缓冲的 live frame，再对外提供已提交的 task cursor。

rc.6 会忽略 `events.mux.since`，它不是 durable backlog。项目承诺的是**至少一次交付加确定性去重**，不是 exactly-once。无法重建的 gap 返回 `unrecoverable_gap`；过旧 cursor 返回带 `earliestCursor` 的 `cursor_expired`。bridge 不会静默跳过这两类错误。

`dsh_tail` 返回有界 digest 与 `nextCursor`。Host 连接正常时，它在调用时从 `session.history` 解析 source pointer：assistant chunk 会省略或压缩，tool output 会归约，但 question、approval、error、turn outcome 和最终 assistant message 只在响应中完整返回。Host 不可用时返回 `contentUnavailable`，不会从 bridge 副本重建会话内容。

每次 root `turn/end` 时，ledger 只折叠最后一个用户可见的 `assistant/message` pointer（`sessionId + seq`）；`dsh_status` 从在线 history 解析该 pointer。terminal turn 没有 pointer 时返回 `terminal_missing_final`，不会伪装成成功的空结果。

event pump 即使无人调用 tail 也会运行。bridge 重启后从 JSONL 重建 coordination fold，再与权威 DSH history reconcile；不会从 bridge 文件恢复对话正文。

## 问题与审批

`dsh_followup` 不能回答 pending DSH interaction。bridge 持续消费 `events.mux`，并在内存中维护按 rpcId 索引的 pending map。连接正常时，当前 requested frame 会在 `dsh_status` 与 `dsh_tail` 中原样返回，但 question 文本不会持久化。

重连后，rc.6 会以稳定 rpcId replay 仍 pending 的 request。mux baseline quiet period 结束后，之前存在但本次缺失的 request 会收到 coordination tombstone；后续有效 replay 仍可重新打开该 item。这是显式的 rc.6 heuristic capability，不是 Host transaction。

公开接口只提供类型化响应工具：

- `dsh_answer_question(taskId, requestId, answers[])`
- `dsh_resolve_approval(taskId, requestId, outcome="allow_once"|"reject")`

它们验证 rpcId 类型、task/session lineage、question id、顺序与选项，然后只发送一次、不自动重试的 `POST /api/respond` client response。Host carrier receipt 是权威结果：`bad-response` 会保留 pending；`not-pending` 表示它已经被回答、取消、竞争处理或过期。

安全规则：

- bridge 永远不会自动允许 approval。
- 每个 `approval/requested` 都被视为 DSH sandbox escalation。
- `allow_once` 只映射到 wire outcome `allowed-once`，不会修改持久策略。
- 已配置的 timeout 只会在当前进程和连接仍存活时 best-effort reject 一次，不是 Host 级保证。
- 真正无人值守且 fail-closed 的运行应把 DSH approval policy 配置为 `never`；没有 answerer 时仍保持 fail-closed。
- question 必须原样展示，尤其不得替用户推断凭据、发布、release 或其他敏感答案。

## 追问与取消语义

`dsh_followup(mode="queue")` 对应 DSH `next-turn`；`mode="steer"` 对应 `next-step`。queue 会在当前 turn 结束后启动后续 turn；steer 会在当前 turn 的下一步注入指导。follow-up 可以选择与 delegation 相同的语义模型档位和 catalog 支持的 reasoning effort。bridge 会在 prompt 前写入并重新读取验证；验证失败不发送 prompt，但已尝试的 `session.selectModel` 可能已经持久化成 DSH 全局默认值。省略路由字段时继承当前 route。prompt 写入永不自动重试；唯一的有界重试是“视觉路由”一节描述的 visual-required 路由选择/验证阶段。

每次 session mutation 前都会重新读取 `session.list`/history 并 reconcile；follow-up 还会读取 live `session.models`，报告实际 route。mutation tool 接受可选 `sinceCursor` 与 `expectedRevision`。如果 reconcile 后的视图不同，bridge 返回带 observed changes 的 `stale_view`，而不是直接写入。

每次 bridge prompt 生成的 unary rpcId 会作为 coordination metadata 保留；匹配 `user/message.data.source.rpcId` 的消息标记为 `initiatedBy="bridge"`，未匹配消息标记为 `external_or_unknown`。这是 freshness check，不是 transaction；DSH Web 仍可能在 preflight 与写入之间发生 race。

`dsh_cancel(scope="turn")` 调用 rc.6 `session.cancel`，只取消 active root turn，并保留 queued inbox work。内置前台 shell tool 使用 cooperative abort，并在约三秒后把前台 process group 从 SIGTERM 升级到 SIGKILL，但：

- `run_in_background` job 不会被该 turn signal 杀死，需要使用 DSH `job_kill`。
- 第三方 tool 只有在遵守 `AbortSignal` 时才能被取消。

`dsh_cancel(scope="queue")` 使用当前 mux queue snapshot，对每个 item id 发出一次 `session.updateQueue(remove)`。该操作不是原子的，结果会分别列出 `requested`、`removed`、`alreadyClaimed` 和 `failed`，不会承诺 all-or-nothing queue clear。

## 视觉路由

视觉工作由调用方声明：`visualIntent="required"` 加 `complexity="low"|"high"`。低复杂度自动选择官方原生 Flash Vision（`deepseek-official/deepseek-v4-flash-vision-exp`）。高复杂度必须由用户在 `official-flash-vision` 与 `modlens-pro` 之间明确选择；没有选择时，操作会在任何 session、selection 或 prompt 之前以 `user_choice_required` 失败关闭。`modlens-flash` 绝不是首选。

获批视觉路由的选择/验证阶段（读取 `session.models`、`session.selectModel`、重新读取验证）可以做有界次数的重试，但仅限于每次失败都是明确分类的强制因素：timeout、Host 不可达或 HTTP 5xx。HTTP 400/422 归类为无效输入，HTTP 404 为模型缺失，HTTP 401/403 与 RPC permission/credential 错误码为策略拒绝，非 JSON 或非法 envelope 响应为配置/协议错误；这些都不会触发重试或 fallback。只有在有界重试全部因强制因素耗尽后，bridge 才会恰好尝试 ModLens Flash 一次。失败的 fallback 会失败关闭并报告其自身的失败分类；它绝不会被伪装成成功，其他非幂等写入（`session.create`、prompt/follow-up、cancel、queue mutation、`/api/respond`）也永不重试。任何选择写入可能已持久化为 DSH 全局默认值，这一副作用会持续披露。

fallback 成功时，bridge 会在 event ledger 中记录一个最小且非敏感的 coordination marker（profile id、尝试次数、失败类别和简短 notice——绝不包含 prompt 文本、图片路径、凭据、history 或错误正文），并通过 `dsh_status.visualFallback` 暴露；调用方在任务结束时用提供的 notice 简要告知用户。

## 工作区协作

`dsh_delegate` 通过 `realpath` 解析目标 cwd，然后取得持久化 workspace claim。`dsh_attach_session` 会单独重新验证精确的空闲 root session 及调用方确认的 cwd，再创建或复用同类 claim。默认是 `exclusive-write`；`read-only` 只允许 bridge-local 的只读 claim 互相重叠，但任何祖先或后代路径上的 exclusive claim 都会冲突。使用同一 bridge home 的 bridge 进程共享 claim。claim 在 `turn/end` 后仍保留，因为用户可能稍后从 DSH Web 继续该 session。这只是 cooperative coordination：`workspaceMode` 不会选择、执行或验证 DSH Host 的 filesystem sandbox，`agentPreset` 表示 DSH agent composition，而不是 workspace 或权限策略。工具响应会暴露 `workspaceClaimSemantics.controlsDshSandbox=false`，调用方不需要解析文案也能展示这个边界。

只有 `dsh_release_workspace` 会释放 claim。释放 claim 不会关闭或取消 DSH session。follow-up、question answer 和 `allow_once` 要求 task claim 仍有效；安全取消与 approval reject 即使没有 claim 仍可用。

workspace claim 是 cooperative coordination。它能阻止同一 bridge store 观察到的冲突 delegation，但不能阻止 DSH Web、另一个 bridge home、调用方、shell 或编辑器直接写文件。task 持有 `exclusive-write` 时，负责监督的调用方不得编辑该 cwd。对可写 delegation，独立 git worktree 是推荐的强隔离边界。

如果 DSH session 创建后才发生 claim acquisition race，bridge 会返回指出无 prompt session/task mapping 的 conflict，不会在没有 claim 的情况下静默运行。

## 接管已有会话

`dsh_find_sessions` 只读取 root session 的有界 `session.list` 元数据：精确 id、有界标题、更新时间、running/blank 状态、cwd、preset 以及已有 bridge task id。它不会读取 history，也不会返回 raw projections。`dsh_attach_session` 只接受精确 session id 加新鲜的 `updatedAt`、cwd 和标题前置条件（无标题时也必须显式传入 `null`）；标题绝不用于选择目标。运行中 session、descendant、缺失或无法解析的 workspace、过期元数据都会被拒绝；blank session 也默认拒绝，除非显式允许。

接管不会调用 `session.create`、`session.prompt`、`session.rename` 或 `session.selectModel`。它在 TaskStore registry lock 下创建或复用严格的 `{taskId, sessionId}` mapping，准备并校验 workspace claim，且仅在两者均有效后开始 supervision。claim 准备失败时，本次接管新建的 mapping 会在操作返回前移除；失败尝试不会删除既有 mapping。旧数据若把同一 session 重复映射仍会失败关闭，并发的相同接管会收敛到同一个 BridgeTask。这保证普通操作失败时的原子性，但不是跨独立 mapping/claim 文件、可抵御进程或机器硬崩溃的文件系统事务。继续工作仍是单独且显式的 `dsh_followup` 写操作；可选路由会在该 prompt 前校验并披露。

## SDK 后端

SDK 后端是可选的第三种后端。只有在显式设置 `DSH_HOST_PROTOCOL=sdk` 时才会选中它；`legacy` 仍是默认值，没有任何其他配置会隐式选择它，任何失败路径都不会自动切换到其他后端。它通过 stdio JSON-RPC 与 DSH SDK runtime 通信，而不是通过 HTTP/WebSocket 连接 Web Host，因此它并不是 Host client：它自行启动、拥有、限制并关闭自己的 runtime 进程。

[SDK 后端能力验证](sdk-qualification.md)记录了固定的 client/runtime 组合以及下列每项能力的实机证据；[SDK 后端](sdk-backend.zh-CN.md)是面向操作者的配置指南，[验证指南](validation.md)把已执行与未执行的项目分开记录。

### 组件

```text
Codex -> MCP Bridge / BridgeService
          |- TaskStore + WorkspaceClaim + EventLedger
          |- BackendCapabilities + RuntimeRegistry
          `- DshApi
               |- DshClient         (legacy: HTTP + WebSocket Host)
               |- GatewayDshClient  (gateway: 已认证 Host)
               `- SdkDshClient      (sdk: stdio JSON-RPC)
                    |- SdkRuntimeManager      spawn、容量、空闲回收、teardown
                    |- SdkObservedEventStore  bridge 自有 observed events
                    `- HarnessClient -> 通过 stdio 连接的 SDK runtime 子进程
```

`BridgeService` 由三种后端共用，并且只按 `BackendCapabilities` 分支，不比较后端名字。缺失的语义会抛出结构化错误，不会变成空列表或伪造的成功。SDK 后端通过 `SdkConnectionAdapter` 提供同一份 `DshConnection` 契约：观察、lineage、pending interaction 和变更信号都来自 bridge 自己的记录，而不是 Host mux。因此 workspace claim 校验、stale-view 前置条件、task cursor、ownership 校验以及 final-message pointer 折叠对 SDK task 仍然照常生效。

构造阶段是惰性的。选中该后端时不会解析 Host endpoint、不会读取 connect token、不会做 Desktop discovery，也不会启动子进程；此时只构造 `SdkDshClient` 及其 `SdkRuntimeManager`，第一个 runtime 由 task 的第一个 prompt 启动。

### 实际使用的协议契约

client → server request：`initialize`、`session/prompt`、`session/resume`、`session/wait`、`shutdown`。

消费的 server → client notification：`session.event`、`session.status`、`subagent.started`、`subagent.finished`、`user-question.cancelled`。`session.query.completed` 会作为观察到的 command completion 记录，但绝不归属到 bridge 发出的 prompt；未知 method 会被计数、有界保存，用于诊断，不改变 task 状态。

server → client request（opt-in）：`approval/request`，通过 `initialize.approvalRequests=true` 启用。请求处理器在 `start()` 之后、`initialize` 之前安装，因此第一个 prompt 不可能与未回答的 approval 竞争。返回结构严格为 `{outcome: "allowed-once" | "rejected" | "cancelled"}`。原生用户问题通过 `initialize.capabilities.userQuestions=true` 加 `onUserQuestion` callback 启用；取消通过该 callback 的 `AbortSignal` 和/或 `user-question.cancelled` notification 到达，迟到的回答会被判定为 not-pending。

bridge 依赖的语义：

- `session/prompt` 只返回持久入队回执 `{messageId}`。bridge 会报告 `messageIdSource="sdk-durable-inbox"`，绝不把回执说成 turn 已完成。
- `session/wait` 在 root 空闲且受管 descendant 结束后返回；它不能证明哪条输入产生了哪条 assistant message。
- `session/resume` 按精确 id 从已配置 home 恢复持久 session，不发送输入，也不重新广播历史事件；它只对 bridge 已注册的 task 使用。
- 该 wire 没有协议版本协商，client 不校验 runtime 报告的 `serverInfo` 版本，因此兼容性承诺由固定的 client/runtime 组合承担。
- `clientTimeZone` 无法在该 wire 上传输。bridge 报告 `clientTimeZoneApplied: false`，实际生效的是 runtime profile 自己的时区。

### 能力

| 能力 | SDK 取值 | 运行影响 |
| --- | --- | --- |
| `sessionDiscovery` | `bridge-owned` | 只能看到本 bridge 注册过的 task。`dsh_find_sessions` 返回 `scope="bridge-owned"`、`attachable=false`；`dsh_attach_session` 返回 `unsupported_capability`。 |
| `historySource` / `authoritativeHistory` | `observed-cache` / `false` | 返回的内容是 bridge 自己的观察记录，附带显式 coverage 与 gap，不是 DSH history。 |
| `resumeSession` | `true` | 已知 task 可在相同 home、profile 与 route 下按精确 id 恢复。 |
| `nativeRename` | `false` | 标题保存在 bridge 本地（`titleSource="bridge"`）；观察到的 `session/title` 事件单独以 `dsh-native` 报告。 |
| `modelCatalog`、`dynamicModelSelection` | `false` | route 由 `initialize` 固定。显式 `modelProfile`、`reasoningEffort`、`visualIntent`、`agentPreset` 会在任何 session 或 prompt 之前被拒绝。 |
| `steer` | `false` | 只接受 `dsh_followup mode="queue"`；`mode="steer"` 被拒绝。 |
| `turnCancel`、`queueSnapshot`、`queueMutation` | `false` | `dsh_cancel` 两个 scope 都返回 `unsupported_capability`，关闭 runtime 也绝不会被报告成 cancel。 |
| `subagentHistory` | `true`（观察所得） | 可读取观察到的 descendant 事件；subagent 列表工具仍是 `unsupported_capability`。 |
| `approvals`、`userQuestions` | `true` | wire 支持，并通过既有的类型化响应工具提供服务；实机往返尚未验证。 |
| `eventsMuxWebSocket` | `false` | notification 只走 stdio JSON-RPC 流。 |

### 观察模型

observed events 是 SDK task 唯一能返回的对话内容。恢复的 session 不会重放历史，runtime 持久化的日志是 bridge 不得解析的内部压缩格式。因此 bridge 只记录它真实观察到的事件，并自行声明覆盖程度。

对每个 `session.event`，bridge 先把事件追加到 `observed/<taskId>/events.jsonl` 并落盘，然后才更新任何派生状态（lineage、phase、ledger record、revision 计数）。这样崩溃不会留下指向未写入文本的 final-message pointer。内容完全相同的重复 `(sessionId, seq)` 会被计数并跳过；同一 key 内容不同则视为观察冲突，会让该 task 降级，而不是覆盖已存事件。seq 跳号、写入失败、超大事件、损坏的存储行或不可读的 `meta.json` 都会记录 gap（`corruption | overflow | write_failure | observation_degraded`），而不是静默丢弃，该 task 的 `coverage.complete` 变为 `false`。`meta.json` 是派生状态，会从 `events.jsonl` 重建；两者之间发生崩溃时，事件仍可读。

由此带来的后果：SDK task 的 status、tail 与 history 都明确不是权威历史，而脱敏 ledger 仍保存 coordination metadata 与 final-message pointer。已记录 gap 的 task 会以 `observation_gap` 拒绝普通 follow-up，因为 follow-up 会让缺失早期事件的记录看起来像完整对话；只读 status 与 tail 仍可用，并继续报告该 gap。继续工作需要新建 task 并显式携带 handoff summary。

### 所有权模型

`runtimes/<taskId>.json` 是持久化的所有权与环境记录。它的 claim 是一次持锁的 read-modify-write 事务。身份字段（`backend`、root session id、canonical cwd、DSH home、profile、固定 route、config fingerprint、task id、owner、创建时间）在 claim 时固定，后续 update 绝不能修改；之后只能 patch observation epoch、clean-shutdown 标记与时间、bridge 本地标题、最近观察字段和有界 diagnostic。

第二个 bridge 对同一 task 发起 claim 会得到 `runtime_owner_conflict`。只有记录显示上一个 owner 已干净退出时才允许接管；过期所有权绝不会按 wall-clock 时间或 PID 存活情况回收，因此被强制杀死的 bridge 会留下 fail-closed 记录，需要操作者自行处理。修改 DSH home、profile、route 或 CLI module 会改变 config fingerprint，从而得到 `runtime_identity_mismatch`，而不是把 task 静默绑定到另一个环境。记录中不含环境变量转储、凭据或 token。

### 生命周期与容量

- 惰性启动：一个 root task 拥有一个 runtime，由该 task 的第一个 prompt 启动。只读调用（status、tail、find、doctor）不会启动任何东西，会把 task 报告为未加载而不是空闲。runtime 内部的 DSH subagent 属于该 root task，永远不会获得自己的外部 runtime。
- 有界握手：`initialize` 受 `DSH_SDK_INITIALIZE_TIMEOUT_MS`（默认 60 s）约束，并携带 `approvalRequests: true` 与 `capabilities.userQuestions: true`；随后是可选的 `session/resume`，然后建立 notification 订阅。握手失败会以 `sdk_initialize_failed` 或 `session_resume_failed` 结束，不发送 prompt，并关闭进程。
- 容量：`DSH_SDK_MAX_RUNTIMES`（默认 2）个活跃 runtime。容量压力会先回收空闲且没有未回答交互的 runtime；若没有符合条件的对象，prompt 以 `runtime_capacity_exceeded` 失败，任何请求都不会无限期等待槽位。
- 空闲回收：`DSH_SDK_IDLE_TIMEOUT_MS`（默认 600000；`0` 表示关闭）。只有空闲且没有未回答交互的 runtime 会被回收。活跃 turn、pending approval/question 以及其他进行中的工作，绝不会被定时器、容量压力或另一个 task 的启动回收。
- 关闭：`close()` 是异步的，会在 MCP 关闭、stdin EOF/close、SIGINT、SIGTERM 以及初始化被中断之后被 await。teardown 受 `DSH_SDK_SHUTDOWN_TIMEOUT_MS`（默认 10 s）约束。只有 SDK teardown resolve 之后记录才会标记为干净；turn 进行中或仍有 pending interaction 时关闭的 runtime，即使进程已退出也会记为不干净。
- 代际：每次启动都会递增该 task 的 runtime generation，交互标识带 generation 前缀，因此重启之后才到达的回答会被报告为 not-pending，而不会作用到新进程上。

### 数据布局

| 路径 | 内容 | 权威性 |
| --- | --- | --- |
| `tasks/<taskId>.json` | 未改动的 legacy 两字段映射 `{taskId, sessionId}` | 仅身份映射；与 Host-backed 后端共用 |
| `claims/<taskId>.json` | workspace claim：canonical cwd、owner、claim mode | 协作式协调，未改动 |
| `runtimes/<taskId>.json` | schema 版本 1 的 runtime 身份与所有权记录 | 所有权与环境绑定的权威来源 |
| `observed/<taskId>/events.jsonl` | bridge 自己的 observed events，每行一条 JSON，按批落盘 | 该后端唯一能返回的对话内容，明确非权威 |
| `observed/<taskId>/meta.json` | 派生的 per-session 序号统计、降级列表、字节数 | 派生数据，可从 `events.jsonl` 重建 |
| `ledgers/<taskId>/events.jsonl` | 脱敏 coordination ledger：cursor、lineage、execution/pending 状态、final-message pointer | 可重建索引，绝不保存对话正文 |
| `<DSH_HOME>/` | runtime 自己的持久化与原生凭据存储（`sessions/`、`storages/`、`profiles/sdk/`） | 归 runtime 所有；bridge 不解析、不复制、不写入 |

路径都相对于 bridge home；SDK 后端的 bridge home 在未设置 `DSH_BRIDGE_HOME` 时默认为 `<DSH_HOME>/codex-bridge-sdk`。observed-event 目录权限为 `0o700`，文件权限为 `0o600`。

### 失败语义

不支持或失败的路径会返回以下之一：`unsupported_capability`、`sdk_initialize_failed`、`runtime_unavailable`、`runtime_capacity_exceeded`、`runtime_owner_conflict`、`runtime_identity_mismatch`、`backend_mismatch`、`observation_gap`、`prompt_outcome_unknown`、`session_resume_failed`、`sdk_unavailable`，并附带 retryable 标记与简短建议。prompt 回执超时或传输中断属于 `prompt_outcome_unknown`，绝不重试，因为消息可能已经入队。缺少 SDK 包时报告 `sdk_unavailable`，不会让其他后端的使用者在模块加载阶段失败。

## 明确限制

- 不管理 Host 进程生命周期、auth layer、pidfile、port lock，也不会自动启动 Host。
- 除 visual-required 路由的选择/验证阶段及其仅在强制因素下的单次 ModLens Flash fallback（见“视觉路由”一节）外，不自动重试非幂等写操作；`session.create`、prompt/follow-up、cancel、queue mutation 和 `/api/respond` 永不重试。
- WebSocket 断开会产生 `host_unreachable`/unknown，不会把 task 误判为失败；只读 reconnect/history recovery 会自动继续。
- Host 重启会丢失 process-local active turn、pending interaction、queue 和 background-job state；bridge 不承诺 seamless continuation。
- fresh history 仍停在 `turn/start`，但 fresh `session.list` 表明 session 已不再运行时，status 会记录不含正文的 `interrupted` coordination marker；后续 durable `turn/end` 会在 reconcile 时覆盖它。
- DSH durable session/history 可以在 Host 重启后保留，但只有创建记录、尚无 event 的 session 可能延迟出现。bridge process-restart mock test 使用带 durable event 的 session；当前实现运行没有做 live rc.6 restart test。
- mux connect 或 reconnect 后，只有 rc.6 发出真实 `session/queue` snapshot，queue state 才能确定；bridge 不会根据 `session/subscribed` 推断空 queue。
- 普通用户创建的 session fork 不会折叠进 BridgeTask；session-backed subagent descendant 会。
- Host-origin affinity 受配置约束，不存储在严格 task mapping 中。更改显式 `DSH_HOST_URL` 后不要复用旧 `DSH_BRIDGE_HOME`；不支持 per-task cross-Host migration。在 Windows 上显式启用 `desktop-auto` 时，同一个 DSH Desktop profile 的新 generation 可以绑定到另一个临时 loopback 端口。旧端点发生 transport failure 后 client 会使其失效，connection manager 在下一次重连迭代中重新解析。失败的 prompt 写入永不重试；唯一的有界重试是“视觉路由”一节描述的视觉路由选择/验证阶段。若切换 profile 后已映射 session 不再存在，状态仍是 `session_not_found`；自动恢复不会按标题重新映射。显式接管是由操作者发起的独立流程，必须使用刚发现的精确 session id。
- workspace claim 不能提供 OS 级排他，fresh write preflight 也不能消除 Web client 的 TOCTOU race。项目不承诺完整的“多调用方加交互式 Web 同时操作无冲突”。
- 不支持 exactly-once delivery、atomic queue clear、`events.mux.since` resume、argument-dependent caller approval policy、自动取消 background job，或通过 `host.describe.version` 检测 Host package 版本。
- 真实浏览器可见的端到端交互属于 operator acceptance，不是 `npm test` 的组成部分。修改 DSH 版本、model route、agent preset、event reconciliation 或 mutation semantics 后，请执行[验证指南](validation.md)。

当前源码预览中的缺陷与临时处理方式见[已知问题](../KNOWN_ISSUES.md)。
