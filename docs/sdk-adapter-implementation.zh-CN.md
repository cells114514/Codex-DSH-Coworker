# SDK 后端改造任务书（交给 DSH 实施）

> **历史设计与需求记录（归档）：** 本文是任务书原文，保留作为该轮工作的需求与设计依据，不代表当前实现状态。当前实现与交付范围见
> [`docs/sdk-delivery-report.zh-CN.md`](sdk-delivery-report.zh-CN.md)，实机验收结论见
> [`docs/sdk-live-acceptance-results.md`](sdk-live-acceptance-results.md) 与 [`docs/validation.md`](validation.md)。
日期：2026-11-17。评估基线：本仓库 `428c69f`，版本 `0.1.0-alpha.6`。

本文是待实施的设计与验收要求，不代表这些能力已经实现或通过实机验证。实施时先检查当前分支差异，保留已有修改；路径、符号和上游接口发生变化时以实际源码为准，并记录设计调整。

## 1. 执行目标与范围

为 Codex-DSH-Orchestrator 增加官方 TypeScript SDK 后端，让用户正常启动 Codex 后，由 MCP Bridge 按需启动、管理 DSH SDK Runtime，无需先启动 DSH Desktop，也无需 Desktop Gateway 临时授权启动管道。

保留现有 `legacy` 和 `gateway` 后端。SDK 是新增后端，首版显式选择使用，不修改已有安装的默认行为，不在故障后自动切换后端。

首版交付范围：

1. 新建任务、提交文本、同一已知任务的普通后续输入。
2. 实时事件、状态、有限等待、最终回复读取。
3. 用户问题、单次审批及其取消、超时处理。
4. 本 Bridge 创建的任务注册、已知会话按精确 ID 恢复。
5. 运行时所有权、并发限制、可靠退出、失败诊断。
6. 安装配置、能力声明、自动测试与实机验收文档。

首版不承诺：完整 Desktop 历史发现、任意 Desktop 会话附加、历史事件完整补齐、运行中动态切换模型、普通 steer、队列清空、单轮取消、退出 Codex 后继续后台执行、SDK 与 Desktop 插件完全一致。上述功能在缺少经过验证的官方接口时必须返回明确的不支持错误，不能模拟成功。

不要因为这些扩展项暂不可用而放弃首版。先完成范围内的可用闭环，再单列缺口、证据和后续方案。

## 2. 开始实施前必须核对的事实

使用官方公开接口，核对并记录实际安装版本；不能只按上游 master 文档编码。下列链接是接口调查入口，不是可直接固定为生产依赖的版本：

- [TypeScript SDK 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)
- [SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)
- [SDK 服务端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md)
- [SDK Profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-app/README.md)
- [SDK 包依赖](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/package.json)

本次调查发现：

| 项目 | 当前公开契约 | 实施约束 |
| --- | --- | --- |
| 低层客户端 | `HarnessClient` 管理进程、初始化、请求和通知订阅 | 优先用于 Adapter |
| 提交输入 | `session/prompt` 返回持久入队的 `messageId` | 接收成功不等于任务完成 |
| 高层执行 | `run()` 收集一次活动区间 | 不直接作为 MCP 长任务主控循环 |
| 会话恢复 | `session/resume` / `resumeSession()` | 使用原持久化环境；拒绝不存在、损坏、不兼容或占用的会话 |
| 历史 | 恢复不重新广播旧事件 | 必须自行说明观察记录完整性 |
| 审批 | 显式启用 `approvalRequests` 并注册处理器 | 只能明确的 allowed-once 授权一次操作 |
| 用户问题 | `onUserQuestion` 或相应协议处理器 | 处理取消信号及迟到回答 |
| 取消 | 无标准单会话取消/关闭方法 | 关闭 Runtime 是不同语义 |
| 模型 | 初始化指定路由；恢复可能记录初始化路由 | 不伪造模型目录，不静默改用其他模型 |
| 协议兼容 | 无成熟协议版本协商承诺 | 锁定并验证客户端与 Runtime 组合 |

先完成能力验证记录：客户端/Runtime 具体版本、包获取方式、公开导出、Profile、认证来源类别、cwd、初始化路由、通知样例的脱敏结构、恢复与退出结果。禁止记录凭据或完整环境变量。

发布包中的依赖应能被普通安装实际解析；上游仓库内 `workspace:*` 写法不能直接复制进本项目。不要手写未经验证的 lockfile，也不要为了引入 SDK 顺带全面升级其他依赖。

若实际可安装版本缺少必要接口，记录准确缺口，完成不依赖该接口的代码与测试；不得通过导入上游私有源码或解析 undocumented 文件格式来冒充完成。

## 3. 现有代码定位

| 文件 | 当前职责 | 改造要求 |
| --- | --- | --- |
| `src/dsh-api-factory.ts` | 构造 legacy/Gateway 客户端 | 增加 SDK 分支，构造阶段无进程副作用 |
| `src/dsh-types.ts` | 共用协议及 `DshApi` | 增加后端身份、能力与异步关闭契约 |
| `src/config.ts` | 环境配置及 Host 校验 | 增加 SDK 配置，按后端校验 |
| `src/connection-manager.ts` | 观察、重连、历史补齐、交互 | 去除 SDK 路径对 Web/Gateway 的硬依赖 |
| `src/bridge-service.ts` | 委派、续接、状态、路由、写入前置检查 | 按能力执行，保留工作区及陈旧视图检查 |
| `src/event-ledger.ts` | 脱敏协调日志、游标、状态归并 | 保留现有职责；不直接改为原文历史仓库 |
| `src/task-store.ts` | 严格的 taskId/sessionId 映射 | 保持旧格式；新增独立运行信息存储 |
| `src/index.ts` | MCP 初始化和退出 | SDK 惰性启动；等待异步关闭 |
| `src/mcp-server.ts` | 工具定义、说明、错误返回 | 能力差异和结构化错误 |
| `src/doctor.ts` | 环境诊断 | 区分静态检查与有副作用的 SDK 探测 |
| `src/setup-codex.ts`、`src/codex-integration.ts` | Codex 安装 | 增加显式后端选择和可审阅配置 |
| `src/setup-claude-code.ts` 等 | 其他调用端安装 | 保持原兼容；不要误写 SDK 配置 |
| `src/skill-content.ts`、`skill/` | 调用端操作指导 | 核对实际生成源，更新 SDK 能力限制 |

重点检查：`delegate()` 当前即使采用 inherit 路由也会调用模型目录；`preflightWrite()` 会刷新列表与补齐历史；最终回复通过历史指针读取。不能只加一个 `SdkDshClient`，然后让这些必经路径一直报 unsupported。

## 4. 目标架构

```text
Codex
  └─ MCP Bridge / BridgeService
       ├─ TaskStore + WorkspaceClaim + EventLedger
       ├─ BackendCapabilities + RuntimeRegistry
       └─ DshApi
            ├─ DshClient              （legacy，保留）
            ├─ GatewayDshClient       （gateway，保留）
            └─ SdkDshClient           （新增）
                 ├─ SdkRuntimeManager
                 ├─ SdkObservedEventStore
                 └─ HarnessClient → DSH SDK Runtime
```

首版采用“一个根任务对应一个 SDK Runtime”的管理方式。该 Runtime 内的 DSH 子 Agent 仍归属该根任务，不为每个子 Agent 再创建外部 Runtime。

选择此方案是为了隔离任务崩溃、初始化路由和后续进程级停止；它不提供操作系统级工作区隔离。保留现有工作区 claim，推荐每个可写任务使用独立 worktree。

运行进程数有上限。idle 且无待答交互的 Runtime 可以按明确策略正常关闭；之后通过精确 ID 恢复，不能关闭后重新 prompt 历史输入。活动任务不得因 LRU、容量压力或别的任务启动而被杀死。全部容量均被活动任务占用时，返回 `runtime_capacity_exceeded`，不得无限等待或无限建进程。

首版只负责 Bridge 生命周期内托管。MCP 断开/Bridge 退出后正常关闭自己拥有的 SDK Runtime；不做脱离父进程的后台常驻服务。不要误关 Desktop 或其他 Bridge 的进程。

## 5. 后端配置及兼容规则

建议扩展已有 `DSH_HOST_PROTOCOL=legacy|gateway|sdk`，减少迁移变量。若重命名配置，应保留旧变量兼容并测试冲突规则。

SDK 专用配置建议如下，最终名称可按现有命名风格调整，但必须同步文档、安装器和测试：

| 配置 | 含义 | 要求 |
| --- | --- | --- |
| `DSH_SDK_BIN` | 可选 Runtime 可执行文件路径 | 使用 SDK 支持的 launch spec；验证 Windows 路径和空格 |
| `DSH_HOME` | SDK 持久化与 Profile 根目录 | 明确解析后传入 SDK，不能只用于派生 bridge home |
| `DSH_SDK_PROFILE` | 默认 `sdk` | 自定义 Profile 必须保留 SDK server |
| `DSH_SDK_PROVIDER`、`DSH_SDK_MODEL` | 初始化模型路由 | 要么完整指定，要么采用已验证的 SDK 默认；拒绝不完整组合 |
| `DSH_SDK_REASONING_EFFORT` | 可选推理等级 | 由真实适配器在初始化时验证 |
| `DSH_SDK_MAX_RUNTIMES` | 进程上限 | 正整数，建议初始值 2 |
| `DSH_SDK_IDLE_TIMEOUT_MS` | idle 回收时间 | 明确允许范围；0 表示关闭回收时需单独支持 |
| `DSH_SDK_INITIALIZE_TIMEOUT_MS` | 初始化超时 | 与任务执行等待区分 |
| `DSH_SDK_SHUTDOWN_TIMEOUT_MS` | 正常关闭等待 | 使用 SDK 支持的选项并验证回收 |
| `DSH_BRIDGE_HOME` | Bridge 状态根目录 | SDK 与 Gateway 使用不同 home |

约束：

- SDK 分支不解析/连接 Host URL，不读取或交换 Gateway connect token，不触发 Desktop discovery。
- 工厂必须先分支，再构建该分支需要的 endpoint resolver，防止 SDK 被无关 Host 校验阻塞。
- 配置和 Adapter 构造均为惰性操作；启动 MCP 不应立即拉起所有历史 Runtime。
- `DSH_SDK_BIN` 是路径，不是拼接 shell 命令。禁止 `shell: true` 拼接用户输入；Windows `.cmd` shim 需采用实际 SDK 支持的安全启动方式并单独测试。
- 如传 SDK `env`，注意其可能是整体替换而非追加；不得无意丢失 PATH、认证或用户代理配置，也不得把 Gateway 授权传入 SDK。
- 不写模型 API Key 或账号 token 到 MCP 配置、任务记录或诊断。说明凭据由哪个原生配置入口提供。
- 不自动搬移 Desktop 数据、安装插件或切换用户默认模型。
- SDK 不支持的 `agentPreset` 不得静默忽略；安装器也不能继续无条件注入原默认 `code` preset。显式非空值返回 `unsupported_capability`。
- 现有 clientTimeZone 不能假装已通过 SDK 协议传递；SDK Profile 的 fallback timezone 与真实请求时区分开说明。

## 6. 能力模型

扩展统一能力声明，避免上层以 `hostProtocol === gateway` 作为所有功能判断条件。建议区分：

```ts
interface BackendCapabilities {
  backend: 'legacy' | 'gateway' | 'sdk';
  transport: 'http-websocket' | 'stdio-jsonrpc';
  sessionDiscovery: 'host-catalog' | 'bridge-owned';
  historySource: 'host' | 'observed-cache';
  authoritativeHistory: boolean;
  resumeSession: boolean;
  nativeRename: boolean;
  modelCatalog: boolean;
  dynamicModelSelection: boolean;
  steer: boolean;
  turnCancel: boolean;
  queueSnapshot: boolean;
  queueMutation: boolean;
  subagentHistory: boolean;
  userQuestions: boolean;
  approvals: boolean;
}
```

以上是设计形状，不要求机械复制；与原有 `protocolCapabilities` 统一，避免形成两套相互矛盾的真值。legacy/Gateway 的值以现有证据及测试为准，不要全部设为 true。

SDK 首版：bridge-owned、observed-cache；不声明权威历史、原生重命名、模型目录、动态模型切换、普通 steer、单轮取消或队列控制。审批及问答仅在初始化成功注册处理器后声明可用。

状态输出应新增后端、传输、任务级 Runtime 状态、观察完整性。SDK 的 `eventsMuxWebSocket` 必须为 false。旧字段为兼容保留时应解释弃用含义；不要用虚构 URL 或 Desktop 产品版本填充 SDK 信息。

API 中不支持的方法可以继续存在并抛结构化错误，但常用流程必须在调用前分支。不得以空列表、空历史、空队列代表未知或不支持。

## 7. SDK Adapter 的行为映射

### 7.1 创建和提交

1. 验证 cwd、支持的路由、preset 和输入；尽早拒绝不支持参数。
2. 分配任务和精确 session 身份；SDK 创建身份的方式以实际公开 API 为准。
3. 建立 task/session 与 RuntimeRegistry，取得工作区 claim。
4. 从初始化前或首次可订阅点安装事件/请求处理器，保证首次输入前已订阅。
5. 初始化选定的 provider/model/effort 和工作目录，确认握手成功。
6. 发送一次 `session/prompt`，保存 messageId 与提交结果，返回任务信息。

如现有 API 结构要求先创建会话再登记任务，可保留顺序，但 prompt 之前必须具备有效 claim、观察器和持久化映射。登记或 claim 失败时不能发送 prompt；尽量回收新建空 Runtime，并保留准确失败诊断。

不以 `run()` 阻塞 MCP 直到完成。`waitSeconds` 仍是调用端有限等待，不是模型执行截止时间。

`DshUnaryMetadata.issuedRpcId` 如需使用本地操作 ID，应标注 provenance；SDK 的真实 `messageId` 单独存储，不能声称随机 UUID 是上游 wire RPC ID。接收凭据超时、连接中断等不确定结果都不自动重发。

### 7.2 模型与标题

首版采用 Runtime 初始化时确定的固定路由。BridgeService 必须有无需 `sessionModels()` 的 SDK 路径：返回初始化路由与验证来源，模型目录标为 unavailable。

不能把配置中的一个模型包装成“上游返回的完整 catalog”。显式请求 modelProfile、视觉路由、effort 切换等，只有在存在经过验证的等价映射并在初始化前完成精确校验时才支持；首版默认拒绝这些额外路由，不改变原 Gateway 路由。

普通 inherit 续接使用任务记录中的路由。恢复时比较所需配置与原路由，防止 resume 静默覆盖模型。用户修改全局 SDK 默认只影响新任务；旧任务遇到环境不兼容需返回明确错误。

自动标题存为 Bridge 本地显示元数据；不得调用不支持的上游 rename。输出应区分 `titleSource=bridge` 与 DSH 原生标题。

### 7.3 事件、完成和子 Agent

- 转换 `session.event`、`session.status`、`subagent.started/finished`；保持真实 sessionId、source seq 和事件顺序。
- 在上游没有 seq 的通知上，不伪造 durable source seq；Bridge 自有 cursor 单独编号。
- 根任务完成不能只看一个子 Agent finished，也不能只看瞬时 root idle。结合当前活动代次的终结事件及公开 `session/wait` 所确认的托管后代完成；不从状态字段推断整个目标已达成。
- `session/wait` 返回也不代表输入独占某个回复，不能承诺 prompt 与 assistant 一一对应；多轮 goal 的等待边界需单列验证。
- 只关联实际观察到并验证的子 Agent lineage，禁止用猜测 ID 或持久 parent 字段建立审批所有权。
- 队列或事件缓冲设置条数和字节上限。过载时显式报告观察中断/缺口，不能丢弃必要终结或审批事件后继续报告完整。
- 单个任务失败不能关闭其他任务的 Runtime 或整个 MCP 服务。

## 8. 任务归属、历史与恢复

### 8.1 RuntimeRegistry

建议新增 `runtime-registry.ts`，在 bridge home 下保存独立且带 schemaVersion 的记录。保留 TaskStore 旧两字段格式。

记录至少覆盖：taskId、root sessionId、backend、规范化 cwd、dshHome、Profile、固定路由、配置指纹、观察 epoch、正常关闭标记。进程 PID 若记录，仅作诊断，不能作为跨进程所有权证明。禁止保存 API Key、环境变量全集和凭据。

后端和环境归属在任务创建时固定。SDK 与 Gateway home 混用、配置指纹不匹配或缺少 SDK 归属信息时返回 `backend_mismatch` / `runtime_identity_mismatch`。不要根据当前配置把历史 Gateway task 当作 SDK task。

同一任务同时只能由一个 Bridge 持有 Runtime 所有权。使用现有文件锁机制保护短事务，并设计运行期租约/所有权：没有心跳的旧锁不能自动按时间/PID删除；过期状态只给诊断。第二个 Bridge 返回 `runtime_owner_conflict`，不接管、不复制会话。不要持有 TaskStore 全局锁等待模型、用户回答或 Runtime 退出。

### 8.2 已观察事件存储

建议新增 `sdk-observed-event-store.ts`，保存返回最终回复和 tail 所需的已观察持久事件。它与现有脱敏协调日志分开，目录及文档明确其可能包含对话原文。

- 只保存该 Bridge 自己拥有的任务，按 task/session/真实 seq 索引，限制单条大小和读取页数。
- 先可靠追加事件，再更新派生协调状态；崩溃后可从该存储重新归并，避免最终回复指针指向尚未保存的正文。
- 对重复 `(sessionId, seq)` 验证内容一致性；冲突报错，不能覆盖原事件。
- 写入失败、磁盘满、损坏或缓冲溢出时将该任务观察状态降级，停止给出“完整”保证；不能继续接受依赖完整视图的写操作。
- 支持仅限 observed-cache 的本地分页读取；有缺口时返回 coverage，不把 hasMore=false 解释为完整 DSH 历史。
- 不解析上游内部 JSONL、projection cache 或未公开的持久化路径来补齐历史。
- 默认本地受限权限；Windows 不以 chmod 成功冒充 ACL 审计。禁止把正文或数据路径中敏感部分写入公开诊断与 Git。
- 首版不自动删除仍被 final pointer 引用的事件；保留和清理策略写明，避免无提示压缩丢失正文。

### 8.3 恢复策略

区分三件事：模型上下文恢复、Bridge 已观察记录、原外部进程恢复。只有第一项由 resume 提供，Shell/浏览器等外部进程不能保证恢复。

正常关闭：只有 SDK 正常退出已确认、通知已排空、本地存储已持久化，才写 cleanShutdown。下一次恢复仍核对上游新事件与本地水位；若不能证明覆盖连续性，不承诺历史完整。

异常退出：保留已观察记录，标记 `historyCompleteness=partial` / `observation_gap`。允许按精确 ID 恢复上下文，但不能自动重发最后一次输入，也不能自动继续 goal 或未完成操作。

首版保守规则：存在不可补齐的观察缺口时，状态/历史查询仍可返回带缺口说明的已知内容，普通后续写入返回 `observation_gap`。用户可明确新建任务并提供自己的交接摘要。若决定增加“明确接受缺口后续接”功能，应作为独立扩展，增加显式输入、审计和测试，不能默认开启。

缺口不要直接无条件映射为现有永久 `ledger/gap`，导致所有只读查询都无法使用。区分“Bridge cursor 损坏”和“上游历史未观察完整”，保留可读取的本地记录。

恢复不存在、损坏、占用、版本不兼容的会话时返回原类别错误；禁止偷偷创建一个替代会话并沿用旧 taskId。

### 8.4 查找、附加与写入前置检查

- SDK 的 findSessions 仅列本 Bridge 注册任务，标明 `scope=bridge-owned`、数据来源和新鲜度。不能把本地旧更新时间冒充上游 fresh updatedAt。
- 任意 Desktop 会话 attach 在首版返回 unsupported；已知 SDK task 通过原 taskId 续接，不走伪造的 Desktop attach 流程。
- `refreshLineage`、`reconcileTask` 改为 SDK 任务注册、运行时状态和本地缓存流程；不再强制调用缺失的远端列表/历史接口。
- `preflightWrite` 保留 claim、revision、cursor、task/session 归属和所有权检查。不得为使 SDK 跑通而直接跳过整段 preflight。
- Runtime 可达性、会话是否加载、正在运行/等待输入/未知必须分开。resume 成功不自动代表 idle；不要仅凭缓存判断新鲜状态。
- 不要为查询所有历史任务而自动启动全部 Runtime；快照可以标记 unloaded/unknown。针对单任务的真实探测按需且有界进行。

## 9. 审批、问答和取消

在初始化前注册真实处理器，转换为现有 pending 交互格式；上层继续通过现有 answer/approval 工具回答。

1. Pending key 至少包含 task、session、Runtime generation 和真实 request 身份，避免重启后的 ID 冲突。
2. 跨任务回答、重复回答、错误类型和迟到回答一律拒绝。
3. SDK 取消信号触发后立即从 pending 移除并中止等待；正常关闭也要清理。
4. 超时不等于授权，不编造用户回答；明确拒绝、取消或失败关闭。
5. `allow_once` 仍要求有效工作区 claim；拒绝操作保持现有更宽松的可用边界。
6. 接收交互期间保持事件读取；不能让等待人工回答堵塞整个 JSON-RPC 通道。
7. 子 Agent 问题只能落到已验证归属的根任务；未识别归属不交给错误任务。

现有取消工具的 turn 和 queue scope 在 SDK 中返回 `unsupported_capability`，不调用 Runtime close 冒充成功。

首版不新增进程级停止工具也可以完成交付。若新增，应使用独立名称或明确新 scope，返回影响范围“根任务及其托管子 Agent 的 Runtime”，并说明后台外部进程不保证停止；进程停止后标 interrupted，不伪造 `turn/end`。绝不能影响其他根任务。

## 10. 生命周期、错误与诊断

`DshApi.close` 应允许并等待异步结果，例如 `close?(): void | Promise<void>`；`src/index.ts` 必须 await，并且重复触发 shutdown 幂等。

SDK 关闭应使用 SDK 自己的有界退出机制，验证真实进程退出。清理失败保留诊断，不得在旧进程存活未明时无界启动新进程。窗口关闭、stdin EOF、SIGINT/SIGTERM 和初始化中断都覆盖。

建议错误分类：

| 错误码 | 含义 |
| --- | --- |
| `unsupported_capability` | 当前后端不能实现请求语义 |
| `sdk_initialize_failed` | 初始化路由、Profile 或握手失败 |
| `runtime_unavailable` | Runtime 不可用或异常退出 |
| `runtime_capacity_exceeded` | 进程容量已满 |
| `runtime_owner_conflict` | 会话归属另一个 Bridge |
| `runtime_identity_mismatch` | 原运行环境与恢复目标不符 |
| `backend_mismatch` | task 不属于所选后端 |
| `observation_gap` | 存在不能补齐的观察缺口 |
| `prompt_outcome_unknown` | 提交可能已成功，禁止自动重试 |
| `session_resume_failed` | 保留 missing/occupied/incompatible 等细分类别 |

错误通过现有 MCP `isError` 路径输出，包含 backend、capability、taskId（如已有）、retryable 与简短修复建议。stderr 只保留有界且经过脱敏的尾部；不要原样回显可能带 token 的启动日志。协议 `serverInfo.version` 与真实产品版本分开。

静态 doctor：校验安装包/可执行文件、配置及本地状态结构，不启动模型任务，不恢复会话、不改账号配置。启动 SDK 握手可能加载插件、持久化和日程，因此应通过独立显式的 live probe 入口执行，并在工具说明中准确描述副作用；不能复用 legacy 的探测逻辑误称纯只读。

## 11. 测试要求

使用可控 mock SDK 进程和 transport fixture；核心测试不依赖网络、真实账号或模型响应。测试可见行为和故障边界，避免只断言私有方法被调用。

建议新增：

- `test/sdk-dsh-client.test.ts`
- `test/sdk-runtime-manager.test.ts`
- `test/sdk-observed-event-store.test.ts`
- `test/sdk-recovery.test.ts`
- `test/sdk-bridge-service.test.ts`
- `test/support/mock-sdk-runtime.ts`

最小测试矩阵：

| 类别 | 必测场景 |
| --- | --- |
| 后端选择 | 三个分支正确；SDK 不建 Host resolver、不读 token、不碰 Desktop；构造与普通启动无子进程 |
| 首次执行 | 观察器先于 prompt；claim 失败不提交；initialize 失败不提交；MCP 很快返回 taskId |
| 输入语义 | 接收凭据有 messageId；接收不代表完成；超时/断线不自动重发 |
| 状态 | 根 idle 但后代活动；子 Agent 完成不等于根完成；状态未知不显示成功 |
| 并发 | 两任务事件隔离；单任务崩溃不影响另一个；容量满；同 task 多 Bridge 冲突 |
| 交互 | 问答、一次允许、拒绝、取消、超时、重复回答、迟到回答、错误任务、子 Agent 归属 |
| 恢复 | 正常关闭后已知会话恢复；异常退出缺口；missing/occupied/incompatible；不创建替代会话 |
| 存储 | 去重、冲突、磁盘失败、损坏、分页、正文指针、事件先持久化后归并、重放幂等 |
| 能力限制 | preset/steer/turn cancel/queue clear/动态路由/Desktop attach 明确失败且无副作用 |
| 生命周期 | EOF、信号、初始化期间退出、重复 close、关闭超时；无遗留已知子进程 |
| 配置安装 | 空格路径、Windows 启动形式、invalid 值、dry-run、旧配置保留、无凭据写入 |
| 兼容 | legacy/Gateway 原测试和公开工具接口无回归 |

SDK 的非模型进程 fixture 应覆盖坏 frame、未知通知、stderr 超量、响应超时和突然退出；根据 SDK 本身已负责的协议层职责决定测试位置，避免重新实现 SDK。

完成必要定向测试后运行 `npm run check`。如果依赖未安装，先按项目 lockfile 安装；不要声称未运行的检查已通过。文档注意仓库 `public-surface` 检查，不能写入个人绝对目录或内部身份。

## 12. 实机验收

使用可丢弃工作目录和明确的测试任务；先只读，再测试一个范围清楚的小文件修改。记录版本、操作步骤、结果、耗时及问题，不保存原始凭据。

1. 正常启动 Codex，不通过 Gateway 专用启动器；执行 SDK delegation 成功。
2. 无需 DSH Desktop 进程即可完成任务；环境若有 Desktop，不主动关闭用户正在使用的应用。
3. 同一 taskId 普通续接能使用先前上下文，cwd 和固定模型路由正确。
4. 问题可回答、审批可允许一次或拒绝；取消等待后旧回答失效。
5. 两个独立工作区任务同时执行，事件与结果不串线。
6. 正常退出 Bridge 后 Runtime 被回收；重启后精确恢复；说明实际观察完整性。
7. 异常中断后不重复最后一个输入，状态明确提示缺口或 interrupted。
8. 不支持功能返回结构化错误，既不假成功，也不切换 Gateway。
9. 改回 gateway 配置及其独立 home，原受控启动流程仍可使用。

至少在 Windows 实测一轮；macOS 未测就标为未验证，不根据源码测试宣称跨平台验收通过。

测量冷启动、热续接、两个任务常驻内存和正常关闭耗时。只报告观测值；不要承诺 SDK 会提升模型推理速度、降低 token 或自动修复旧锁问题。

## 13. 分阶段提交与完成标准

| 阶段 | 产物 | 完成标准 |
| --- | --- | --- |
| P0 能力验证 | `docs/sdk-qualification.md` | 实际版本和安装可复现；确认关键缺口 |
| P1 配置与能力 | 配置、工厂、能力声明、安装 dry-run | SDK 无启动副作用；原两后端无回归 |
| P2 基本执行 | Adapter、RuntimeManager、事件存储 | 单任务 delegate → observe → final → followup 闭环 |
| P3 交互与恢复 | Registry、所有权、审批问答、恢复、退出 | 并发隔离和异常行为测试通过 |
| P4 集成验收 | 全量检查、实机记录、用户文档 | 功能和限制与真实行为一致 |

预估：P0 加原型 2–4 人日；全部首版合计约 12–20 人日。该估算以熟悉本项目的开发者、可安装 SDK 和可用测试账号为前提。完整 Gateway 等价能力约 25–40 人日以上，依赖上游接口时需重新估算。

提交按可审阅边界拆分，避免一个提交同时改所有后端、锁实现和路由政策。不要删除或弱化现有测试来制造通过；若合同确实变化，在提交说明中解释原因。

## 14. 需要同步更新的文档与交付报告

更新 README 中 SDK 可选启动方式、配置表、能力对照和退出边界；更新安装说明、架构说明、KNOWN_ISSUES、validation 及实际供安装器生成的 Skill。现有 Desktop Gateway 文档继续保留。

交付报告至少包括：

1. 已实现能力和明确不支持项。
2. 修改文件与关键设计决定。
3. 客户端/Runtime 版本、实际安装及配置步骤。
4. 数据目录、原文缓存、任务后端归属与恢复限制。
5. 自动测试命令、结果与未运行项。
6. 实机验证的平台、场景、观测值及未验证项。
7. Gateway 回退步骤：还原所选后端配置并使用原 home；保留 SDK 数据，不自动搬迁或删除任务。
8. 上游待补接口及后续工作；不把剩余扩展写成已完成能力。

## 15. 可直接发给 DSH 的执行指令

请按本任务书为当前仓库新增官方 TypeScript SDK 后端，先核对当前代码和实际可安装 SDK 契约，然后按 P0–P4 推进首版实现。保留 legacy/Gateway 的行为与数据；SDK 显式启用、惰性启动、每个根任务一个有界管理的 Runtime。重点完成基本任务闭环、真实事件观察、问答审批、精确 ID 恢复、所有权及退出管理。

对 SDK 缺少的历史、模型目录、取消和队列接口使用明确能力限制；不要伪造数据、忽略参数、自动重发输入或切换后端。不要修改我的账号、凭据、全局模型默认或已有 Desktop 会话。实现、测试、文档可以在本仓库内完成；真实模型调用使用已有授权范围，缺少认证则先完成 mock 验证及可独立进行的工作，并说明实机验收条件。

最终提交可审阅改动、测试结果、实际使用步骤和限制清单。不要停留在重复评估，也不要为了追求完整 Gateway 对等功能阻塞首版交付。
