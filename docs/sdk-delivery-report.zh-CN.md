# SDK 后端交付报告（简体中文）

状态：**首版可用交付，带明确缺口**。SDK 后端已作为可选的第三种后端实现，只在显式选择 `DSH_HOST_PROTOCOL=sdk` 时生效；`legacy` 仍是默认后端，任何失败路径都不会自动切换到 SDK，也不会从 SDK 自动切换到其他后端。

需要先说清一条边界：实机运行中每个 turn 都到达了模型 provider，但都在 provider 处以模型错误结束（缺凭据 `MISSING_CREDENTIAL`，或凭据被拒 `AUTH 401`）。**本环境没有验证到一次成功的 assistant 回答**。bridge 对这些 turn 的处理（如实报告失败、不伪造成功）本身已被实机验证。

本报告把证据分成三级，全文不混用：

1. **自动化测试**：`npm run check` 与 SDK 专项测试套件，使用脚本化的 fake runtime，不启动真实进程。
2. **实机探测**：Windows 上对真实 client/runtime 组合执行的一次性探测，仅记录结论，不记录对话正文、凭据或路径。
3. **未验证**：既没有实机证据、也没有被任何测试覆盖为"已通过"的项目。mock 覆盖不等于实机验证，本报告不会把前者写成后者。

相关文档：[SDK 后端能力验证记录](sdk-qualification.md)（证据）、[SDK 后端](sdk-backend.zh-CN.md)（配置指南）、[架构](architecture.zh-CN.md)、[验证指南](validation.md)、[已知问题](../KNOWN_ISSUES.md)。

## 1. 已实现能力与明确不支持项

### 1.1 已实现并可用

| 能力 | 行为 |
| --- | --- |
| 新任务与首个 prompt | 第一个 prompt 时惰性启动 runtime，完成有界 `initialize` 握手后提交 prompt |
| 文本 prompt | `session/prompt` 返回持久入队回执 `{messageId}`；对外标记 `messageIdSource="sdk-durable-inbox"`，不把回执当完成 |
| 实时事件观察 | 消费 `session.event` / `session.status` / `subagent.started` / `subagent.finished`，先落盘再派生状态 |
| 状态、有限等待、tail | 由 bridge 自己的观察记录与 coordination ledger 提供，并显式报告 coverage |
| 已知任务续接 | `dsh_followup mode="queue"`，同一 task 通过 `session/resume` 按精确 id 恢复 |
| 单次审批 | `approval/request`（`approvalRequests: true`），结果只有 `allowed-once` / `rejected` / `cancelled` |
| 原生用户问题 | `capabilities.userQuestions: true` + `onUserQuestion`，支持取消信号与迟到回答拒绝 |
| 本 bridge 任务发现 | `dsh_find_sessions` 返回 `scope="bridge-owned"`，附 runtime 状态、phase、cleanShutdown 与 coverage |
| 运行时所有权与容量 | 每 task 一条 runtime 记录；`DSH_SDK_MAX_RUNTIMES`（默认 2）；首次干净退出后才允许接管 |
| 确定退出 | 异步 `close()`，在 MCP 关闭、stdin EOF/close、SIGINT/SIGTERM 以及初始化被中断后被 await |
| 安装与诊断 | `npm run setup -- --backend sdk`；`DSH_HOST_PROTOCOL=sdk npm run doctor [-- --probe-sdk]` |

### 1.2 明确不支持（返回结构化错误，不模拟成功）

| 不支持项 | 返回 |
| --- | --- |
| 会话目录发现 / 任意会话附加 | `unsupported_capability`（`dsh_attach_session` 直接拒绝） |
| 权威历史读取、历史重放 | 不提供；返回的永远是 observed-cache，`authoritativeHistory=false` |
| 原生重命名 | 标题仅存 bridge 本地，`titleSource="bridge"` |
| 模型目录、动态切换、effort 变更 | 路由由 `initialize` 固定；显式 `modelProfile` / `reasoningEffort` / `visualIntent` / `agentPreset` 在写入前被拒 |
| 普通 steer | 只接受 `mode="queue"` |
| 单轮取消 / 队列取消 | `dsh_cancel` 两个 scope 都返回 `unsupported_capability` |
| 队列快照与队列变更 | 不提供（`queueSnapshot=false`） |
| subagent 列表 | 不提供；只读观察到的事件 |
| events mux WebSocket | 不提供（`eventsMuxWebSocket=false`） |

## 2. 变更文件与关键设计决策

### 2.1 代码文件

| 文件 | 职责 |
| --- | --- |
| `src/backend-capabilities.ts`（新） | 每后端一份能力声明；上层只按能力分支，不比较后端名字 |
| `src/sdk-errors.ts`（新） | 11 个结构化错误码与 `unsupported_capability` 构造器 |
| `src/sdk-dsh-client.ts`（新） | `DshApi` 的 SDK 实现：prompt、观察、历史分页、pending 交互、resume、关闭 |
| `src/sdk-runtime-manager.ts`（新） | runtime 生命周期：惰性启动、容量、空闲回收、teardown、崩溃沉降 |
| `src/runtime-registry.ts`（新） | `runtimes/<taskId>.json` 身份与所有权，schema 版本 1，持锁事务 |
| `src/sdk-observed-event-store.ts`（新） | observed-cache：先落盘、去重/冲突、溢出与损坏降级、coverage |
| `src/sdk-connection-adapter.ts`（新） | 用 bridge 自有观察实现同一份 `DshConnection` 契约 |
| `src/config.ts` | 新增 `sdk` 后端配置解析；SDK 分支不读取 Host URL、connect token 或 Desktop 发现项 |
| `src/dsh-api-factory.ts` | 后端分支先于 endpoint resolver；SDK 构造不产生子进程 |
| `src/dsh-types.ts` | 后端身份、能力、observed history、bridge-owned catalog、异步关闭等契约 |
| `src/index.ts` | 选择 SDK 时装配 `SdkConnectionAdapter`，退出路径 await 异步 `close()` |
| `src/bridge-service.ts` | 按能力执行：发现范围、路由拒绝、follow-up、tail 来源、cancel、审批/提问能力检查 |
| `src/mcp-server.ts` | 工具说明与结构化错误返回 |
| `src/doctor.ts` | SDK 静态报告与显式 `--probe-sdk` 有界握手 |
| `src/setup-codex.ts`、`src/setup-claude-code.ts`、`src/codex-integration.ts` | `--backend sdk` 安装、互斥校验、MCP 环境与凭据隔离 |
| `src/connection-manager.ts`、`src/host-endpoint.ts`、`src/host-endpoint` 相关路径 | 去除 SDK 路径对 Web/Gateway 的硬依赖 |
| `test/sdk-*.test.ts`、`test/runtime-registry.test.ts`、`test/support/fake-sdk-runtime.ts` | 使用脚本化 fake runtime 的自动化覆盖 |

### 2.2 关键设计决策

1. **能力驱动，而非后端名字驱动。** `BridgeService` 只读取 `BackendCapabilities`。缺失语义一律抛结构化错误，不会返回空列表或假成功，因此新增后端不会让既有校验悄悄失效。
2. **构造阶段完全惰性。** 选中 SDK 后端不解析 Host endpoint、不读 token、不做 Desktop 发现、不启动子进程；只有 task 的第一个 prompt 才 spawn。
3. **一个 root task 一个 runtime。** runtime 内部的 DSH subagent 属于该 root task，永远不会获得独立外部 runtime；每次启动递增 generation，交互 id 带 generation 前缀，重启后迟到的回答被判为 not-pending。
4. **观察先落盘、派生在后的顺序不可交换。** 事件写入并 flush 之后才更新 lineage、phase、ledger 与 revision，避免 final-message pointer 指向未写入的文本。
5. **所有权只在干净退出后可接管。** 记录区分"有 owner"与"已干净退出"；不按 wall-clock 或 PID 存活回收，被强杀的 bridge 留下 fail-closed 记录交操作者处理。
6. **请求处理器先于握手安装。** `onRequest` 在 `start()` 之后、`initialize` 之前安装，第一个 prompt 不可能与未回答的审批竞争。
7. **不确定即报告不确定。** prompt 回执超时或传输中断返回 `prompt_outcome_unknown`，从不重试，因为消息可能已入队。
8. **复用既有安全校验。** `SdkConnectionAdapter` 让 workspace claim、stale-view、cursor、ownership、final-message pointer 等检查对 SDK task 原样生效，而不是另写一套。
9. **关闭路径可等待。** `close()` 异步且被 `src/index.ts` 在所有退出信号上 await，确保受管进程被回收。

## 3. 客户端 / Runtime 版本与实际安装、配置步骤

### 3.1 版本

| 组件 | Pin |
| --- | --- |
| 客户端 | `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3` |
| Runtime | `@deepseek-ai/dsh@0.2.2-rc.3`（`bin.dsh = lib/bin.js`） |
| Node.js | `>= 22`；实机探测使用 25.6.0 / npm 11.8.0 |
| 实机验证平台 | 仅 Windows |
| 同机 Desktop runtime | `0.2.1-rc.2`（独立进程、独立 home，与 SDK runtime 版本不一致属预期） |

`npm dist-tag latest` 仍指向过旧版本，不可用；安装时必须按上面的确切版本固定。

### 3.2 实际安装

```sh
npm install @deepseek-ai/dsh-sdk-client@0.2.2-rc.3
```

在空项目里解析出 606 个包（约 745 MB 磁盘占用）。发布依赖图可直接由 registry 解析，不涉及 `workspace:*`，因此不需要上游 monorepo 检出。想复用已有的 `dsh` CLI 时可以改用 `DSH_SDK_BIN` 指向其 CLI module，跳过内置 runtime pin。

### 3.3 配置步骤

1. 设置 `DSH_HOST_PROTOCOL=sdk`。不设置时仍是 `legacy`，SDK 不会被隐式选中。
2. 设置 `DSH_HOME` 指向 SDK runtime 自己的 home（默认 `~/.dsh`）。该 home 会由 runtime 创建 `profiles/sdk/`、`sessions/`、`storages/` 与它自己的原生凭据文件。
3. 可选 `DSH_SDK_BIN`：`dsh` CLI module 路径，按词法解析，绝不作为 shell 命令执行。
4. `DSH_SDK_PROFILE`：实际提供 SDK JSON-RPC server 的 profile，默认 `sdk`；使用非默认值时 doctor 会给出提示，因为无法替用户校验该 profile 是否仍提供 SDK server。
5. 可选 `DSH_SDK_PROVIDER` 与 `DSH_SDK_MODEL`（必须同时出现）；省略时使用 runtime adapter 的默认路由 `deepseek-official` / `deepseek-v4-flash`。`DSH_SDK_REASONING_EFFORT` 需要前两者同时设置。
6. 可选容量与超时：`DSH_SDK_MAX_RUNTIMES`（默认 2）、`DSH_SDK_IDLE_TIMEOUT_MS`（默认 600000，`0` 关闭回收）、`DSH_SDK_INITIALIZE_TIMEOUT_MS`（默认 60000）、`DSH_SDK_SHUTDOWN_TIMEOUT_MS`（默认 10000）。SDK 后端的 bridge home 在未设置 `DSH_BRIDGE_HOME` 时默认为 `<DSH_HOME>/codex-bridge-sdk`。
7. 安装到调用方：

   ```sh
   npm run setup -- --backend sdk --yes --no-preset
   ```

   可选 `--dsh-home <dir>`、`--sdk-profile <name>`、`--sdk-bin <path>`、`--dry-run`。与 `--gateway`、`--host`、`--preset`、`DSH_CONNECT_*` 互斥：SDK 后端不使用 Host URL、Desktop 发现或 connect token，安装器会直接报错而不是默默丢弃这些设置。
8. 验证：`DSH_HOST_PROTOCOL=sdk npm run doctor` 只做静态检查（配置、包可解析性、home、runtime 记录），不 spawn、不发 prompt、不 resume。需要一次有界握手时用 `DSH_HOST_PROTOCOL=sdk npm run doctor -- --probe-sdk`（隐含 `--live`，只执行一次 `initialize`）。

模型凭据始终由 DSH home 自己的原生配置与凭据存储管理；bridge 不读取、不复制、不写入，报告与日志中也不出现凭据、token 或完整环境变量。

## 4. 数据目录、原文缓存、任务后端归属与恢复边界

### 4.1 目录

| 路径（相对 bridge home） | 内容 | 权威性 |
| --- | --- | --- |
| `tasks/<taskId>.json` | 未改动的 legacy 两字段映射 `{taskId, sessionId}` | 仅身份映射，与 Host-backed 后端共用 |
| `claims/<taskId>.json` | workspace claim（canonical cwd、owner、mode） | 协作式协调，未改动 |
| `runtimes/<taskId>.json` | schema 版本 1 的 runtime 身份与所有权记录 | 所有权与环境绑定的权威来源 |
| `observed/<taskId>/events.jsonl` | bridge 自己观察到的事件，逐行 JSON，按批 flush | **唯一**能返回的对话内容，明确非权威 |
| `observed/<taskId>/meta.json` | 派生的 per-session 序号统计、降级列表、字节数 | 派生数据，可从 `events.jsonl` 重建 |
| `ledgers/<taskId>/events.jsonl` | 脱敏 coordination ledger：cursor、lineage、execution/pending、final-message pointer | 可重建索引，绝不保存对话正文 |

`runtimes/<taskId>.json` 记录：backend、root session id、canonical cwd、dsh home、profile、固定路由、config fingerprint（sha256，字段固定顺序）、observation epoch、cleanShutdown、owner（bridge 实例 id / pid / 启动时间）、bridge 本地标题与 `titleSource`、最近观察时间与序号、有界 diagnostic。身份字段在 claim 时固定，后续 update 不能修改。

### 4.2 原文缓存说明

- observed 目录权限 `0o700`，文件 `0o600`。
- 单事件上限 1 MB，单 task 上限 64 MB；分页默认 50 条、最大 500 条。
- 相同 `(sessionId, seq)` 且内容一致 → 计为重复并跳过；内容不一致 → 观察冲突，该 task 降级，**不覆盖**已存事件。
- 写入失败、溢出、损坏行、不可读 meta、seq 跳号 → 记录 gap（`corruption` / `overflow` / `write_failure` / `observation_degraded`），`coverage.complete` 变为 `false`，绝不静默丢弃。
- meta.json 只是派生视图：崩溃在两者之间发生时，事件仍然可读，coverage 停止声称完整。

### 4.3 任务的后端归属

- 一个 task 的归属由 `runtimes/<taskId>.json` 的 backend 字段与 owner 记录共同表达；`backend` 固定为 `sdk`，不会被改写成其他后端。
- 同一 task 被第二个 bridge 认领 → `runtime_owner_conflict`。只有记录显示上一个 owner 干净退出后才能接管；之后 observation epoch 只增不减。
- 改变 DSH home、profile、路由或 CLI module 会改变 config fingerprint → `runtime_identity_mismatch`，不会把 task 静默绑到别的环境。
- 已存在的 SDK task 映射对 Host-backed 后端不可见：Host 上没有对应 session，因此不要在不同后端之间复用同一个 bridge home。

### 4.4 恢复边界

- `session/resume` 恢复的是 runtime 的模型上下文，**不恢复** bridge 视角的历史：runtime 不会重放旧事件。
- runtime 的持久会话日志是内部压缩格式，bridge 不解析、不复制、不猜测其结构。
- 已记录 gap 的 task 会以 `observation_gap` 拒绝普通 follow-up；只读 status / tail 继续可用并继续报告 gap。继续工作需要新建 task 并显式携带 handoff summary。
- 不按 wall-clock 时间或 PID 存活回收所有权；被强杀的 bridge 需要操作者显式处理。
- 不迁移、不导入、不删除 Desktop 的 session、profile 或凭据；SDK 与 Desktop 的数据目录彼此独立。

## 5. 自动化测试命令、结果与未运行项

### 5.1 已运行

```sh
npm run check
```

Windows、Node 25.6.0、npm 11.8.0：build 成功，**386 项测试全部通过**。SDK 相关套件：

```sh
node --import tsx --test test/sdk-dsh-client.test.ts
node --import tsx --test test/sdk-runtime-manager.test.ts
node --import tsx --test test/sdk-bridge-service.test.ts
node --import tsx --test test/sdk-observed-event-store.test.ts
node --import tsx --test test/runtime-registry.test.ts
node --import tsx --test test/sdk-doctor.test.ts
node --import tsx --test test/sdk-setup.test.ts
```

本报告涉及的文档交付另行重跑了公开面校验：

```sh
node --import tsx --test test/docs-security.test.ts test/public-surface.test.ts
```

结果：5 项通过、0 项失败（含架构文档安全措辞、Skill 与渲染器一致、公开面不含机器路径/内部维护标记）。这些测试只用脚本化 fake runtime，不加载官方包、不 spawn 真实进程。

### 5.2 未运行

- macOS 与 Linux 上的全量测试、CI 矩阵与 `npm pack --dry-run` 预览不在本次交付范围内。
- 自动化测试从未驱动真实 SDK runtime：真实进程相关结论全部来自一次性实机探测（见第 6 节），不是测试套件。
- 未执行真实负载下的容量压测、mid-turn 崩溃注入、审批/提问的实机往返。

## 6. 实机平台、场景、观测与未验证项

平台：Windows，Node 25.6.0，client/runtime `0.2.2-rc.3`。每个探测在临时探测目录、对一次性 DSH home 执行；其中一次把本地凭据存储的副本写入该 home，以便真正到达 provider。不记录 prompt 文本、回答文本、凭据或绝对路径。

### 6.1 原始 runtime 探测

| # | 场景 | 观测 |
| --- | --- | --- |
| 1 | 非法 provider 初始化 | 约 2.6 s 后以 `JsonRpcResponseError` 拒绝（未注册 provider），未创建 session，未发送 prompt，无静默回退 |
| 2 | 默认路由初始化 | 约 2.6 s 成功，返回 `serverInfo {name: "deepseek-harness-sdk-runtime", version: "0.0.1"}` |
| 3 | 提交 prompt | 立即返回 UUID `messageId`（入队回执） |
| 4 | 单轮事件 | 观察到 `user/message`、`request/header`、`request/context`、`session/title`、`assistant/attempt`、`step/end`、`turn/end`，`seq` 单调递增。**该 turn 以模型错误结束，没有 assistant 文本**：空的一次性 home 产生 `turn/end` `reason.kind="error"`、`code=MISSING_CREDENTIAL`；写入本地凭据副本的 home 到达了 provider，但被拒绝为 `code=AUTH`、`status=401`（API key 无效） |
| 5 | 第二个进程恢复同一 session | 恢复成功；新事件从更大的 `seq` 开始，旧事件**没有**被重新广播 |
| 6 | doctor `--probe-sdk` | 一次有界 `initialize` 握手约 7.3 s 完成 |

### 6.2 通过 MCP 工具的实机端到端运行

一次端到端运行检验的是 bridge 本身，而不只是裸 runtime：`dsh_host_status` → `dsh_delegate` → `dsh_status` → `dsh_followup` → `dsh_tail` → `dsh_cancel` → `dsh_find_sessions`，随后关闭 bridge 并退出进程。

实测耗时：MCP connect 约 0.5 s；`dsh_delegate` 冷路径约 7.9–8.1 s（runtime spawn + `initialize` + prompt）；`dsh_followup` 约 60–85 ms；失败 turn 检测约 0.6 s；bridge 关闭（含 runtime teardown）约 2.1 s；`dsh_host_status` 约 2 ms。

该次运行确认的事实：

- 每个实机 turn 都到达了模型 provider，并在 provider 处失败。bridge 把这些 turn 如实报告为 `execution=failed`、`finalMessageStatus=terminal_missing_final`，没有伪造成功，也没有把空输出当作成功。
- **本环境未验证到成功的 assistant 回答**：provider 拒绝了可用凭据。因此"SDK 后端能完成一次真实对话"在这台机器上没有证据。
- `dsh_cancel` 返回 `unsupported_capability` 并指明 `turnCancel`，与声明一致，没有假装取消。
- `dsh_find_sessions` 返回 `scope: "bridge-owned"`、`attachable: false`；runtime 设置标题时，会报告 DSH 原生标题。
- `runtimes/<taskId>.json` 与 `observed/<taskId>/{events.jsonl,meta.json}` 都被写出，bridge 进程在 teardown 后退出。

### 6.3 未验证（无实机证据，不得引用为通过）

- 一次成功的 assistant 回答或任何成功的实机 turn 内容（见 6.1 / 6.2）。
- macOS（任何场景）。
- 实机 `approval/request` 往返，含超时与拒绝分支。
- 实机原生用户问题，含取消路径与迟到回答。
- 两个并发实机 runtime，以及在真实负载下的容量压力与回收。
- mid-turn 崩溃、随之产生的不干净退出记录与降级 coverage。
- 超出单进程已观察范围的历史重放/重建。

## 7. Gateway 回滚步骤

SDK 后端只是可选分支，回滚不需要改动 `legacy`/`gateway` 的任何代码。

1. **干净停止。** 结束使用 SDK 后端的调用方/MCP 进程，让它走完异步 `close()`（MCP 关闭、stdin EOF、SIGINT/SIGTERM 都会触发）。记录会因此被标记为 clean shutdown，便于以后再次使用同一 task。
2. **恢复后端选择。** 把安装器写入的 MCP 条目中的 `DSH_HOST_PROTOCOL=sdk` 改回原来的取值（未设置即 `legacy`，或 `gateway`），同时恢复原 `DSH_HOST_URL` / `DSH_HOST_MODE` / `DSH_HOST_VERSION` / `DSH_BRIDGE_AGENT_PRESET` / `DSH_CONNECT_ORIGIN` 等设置；也可以重新执行原来的安装命令覆盖：

   ```sh
   npm run setup -- --backend gateway --yes
   ```

   安装器会先预览再替换，并报告备份或部分成功。
3. **恢复原 home。** 让调用方重新指向原来的 `DSH_BRIDGE_HOME`（Gateway 的 task 映射、claim 与 ledger 都在那里）。**不要**把 Gateway 指向 SDK 的 bridge home：SDK 创建的 task 在 Host 上没有对应 session，只会得到 `session_not_found`；反过来也不要让 SDK 复用 Gateway home。
4. **保留 SDK 数据。** SDK 的 bridge home 与 `DSH_HOME`（含 `runtimes/`、`observed/`、runtime 自己的 `sessions/` 与凭据）原样保留，不迁移、不删除、不改写；回滚只切换选择，不做数据搬运。
5. **验证回滚。** 在 Gateway 模式运行 `npm run doctor`（admission 仍为 `not_probed` 属预期），再单独执行一次 `dsh_host_status`；确认原 task 仍可继续。SDK 的 failure 记录不会阻塞 Gateway 后端。

## 8. 剩余上游缺口与后续工作

| 缺口 | 影响 | 后续工作与激活条件 |
| --- | --- | --- |
| 无会话目录 / 历史读取接口 | 无法发现或附加非本 bridge 创建的会话；历史只能来自观察记录 | 上游提供只读目录与历史接口后，再评估 attach 与历史补齐；在此之前不伪造 |
| 恢复不重放历史 | 恢复只恢复模型上下文 | 需要上游提供重放或读接口；否则保持 observed-cache + 显式 gap |
| 无模型目录 / 选择 / effort / preset | 路由在 `initialize` 固定 | 上游提供目录与切换契约后，再放开 `modelProfile` / `reasoningEffort` / `agentPreset` |
| 无 steer、无单轮/队列取消、无队列快照 | 长任务只能在 bridge 侧设边界 | 上游提供取消与队列契约后再实现；当前如实返回 `unsupported_capability` |
| 无 subagent 列表 | 只能读观察到的 descendant 事件 | 上游提供列表与 one-shot/continuable 分类后再实现 |
| 无协议版本协商 | 只能固定 client/runtime 组合 | 等待上游版本协商契约；在此之前不混用版本 |
| `clientTimeZone` 不可传输 | 时区由 runtime profile 决定 | 上游支持后再传；当前如实报告 `clientTimeZoneApplied: false` |
| 实机验证缺口 | 成功回答、审批、提问、崩溃、容量、macOS 无实机证据 | 见第 6 节清单，属独立验收工作；其中"成功回答"依赖一个当前环境不可用的 provider 凭据 |

后续工作的第一步是把"mock 覆盖"升级为可重复的实机验收脚本（成功回答、审批往返、提问取消、两 runtime 并发、mid-turn 崩溃、真实负载容量），再按[验证指南](validation.md)补记 macOS 结果。在这些实机证据出现之前，相关能力只能表述为"wire 支持且 mock 覆盖"；成功回答还额外依赖一个可用的 provider 凭据。

## 9. 第二轮：事件完整性修正与真实闭环验收

本轮不新增后端，只修首版暴露的事件生命周期缺陷并补齐认证证据。基线：git HEAD `428c69f590d569b0c7cfbdb831bfa88beedc938b`，首版与第二轮改动均在未提交的工作树中；版本仍为 `0.1.0-alpha.7`，SDK client/runtime 仍固定为 `0.2.2-rc.3`，Desktop 仍为独立的 `0.2.1-rc.2`。

### 9.1 修掉的五个缺陷

| 缺陷 | 现状 | 固定它的测试 |
| --- | --- | --- |
| 订阅在握手之后才建立，`initialize` / `session/resume` 期间提交的事件被丢弃 | 顺序改为 `start → onRequest → subscribe → startPump → initialize →（恢复）→ 有界排空屏障`，`acquire` 只在已收到的通知落盘后返回；超时则标记覆盖不完整 | `sdk-lifecycle`：握手期事件、恢复期事件（并断言 `subscribe` 在 `resumeSession` 之前、seq 5/6/7 按序落盘）、重复事件去重 |
| 关闭时先关订阅、且 `Promise.race` 从未真正等待消费循环，可能在队列仍有事件时记为干净关闭 | 关闭序列改为「有界关闭进程 → 有界排空队列（默认 2000 ms）→ 关闭订阅 → 只上报一次退出」；`cleanShutdown` 需要「进程退出已确认」+「队列已排空」两个条件 | `sdk-lifecycle`：关闭期间最后一条事件仍被处理、排空超时记为不完整 |
| 自己发起的关闭被记成传输失败，于是每次正常关闭都留下缺口，进而阻塞恢复 | 自己发起的关闭视为流的正常结束，不再记失败 | `sdk-lifecycle` 关闭用例 + `sdk-dsh-client` 幂等关闭用例 |
| 退出无法确认时仍释放容量槽位，可能在旧进程仍存活时启动替代 runtime | 保留槽位，并对该任务用 `runtime_unavailable`（不可重试）拒绝替代 runtime | `sdk-runtime-manager`：退出未确认时保留槽位并阻止替代 |
| 视图 revision 用「generation 求和 + 记录数」，runtime 移除并重建后可能复用旧值，让陈旧写入被接受 | 改为严格单调的视图时钟（观察计数 + 生命周期计数）：无变化时稳定，永不回退 | `sdk-lifecycle`：revision 在 prompt、runtime 移除与重建后严格递增 |

同时修掉两处会造成误判的问题：事件去重身份原本包含观察时间戳，导致同一事件重投被当成损坏冲突（现在只比较 `(sessionId, seq)` + lineage + payload）；SDK 的「运行状态未知」原本被推断成 `interrupted`，现在只有权威的「未运行」报告才会这样判定，Host 后端规则不变。

### 9.2 并发与 revision 的定向加固

- 同一任务的并发 `acquire` 合并为一次启动；跨任务并发启动不会突破 `DSH_SDK_MAX_RUNTIMES`（同步 test-and-reserve），启动失败释放槽位；容量压力只回收「空闲且无待答交互」的 runtime，绝不终止活跃工作。
- 传输中断会释放槽位（子进程的流已结束，可重新恢复），但仍降级任务，因此下一次后续输入报告缺口而不是截断的对话。

### 9.3 认证结论（已确认 / 尚未确认 / 需要的操作）

已确认：`sdk` profile 挂载两条路由——`deepseek-official`（API key，`x-api-key`，来源依次为 DSH home 受管存储、环境变量、项目与用户 `.env`）与 `deepseek-account`（账号授权，`x-dsh-auth-token`，需要非 localhost 的 `grant` 且目标是官方推理源）。账号登录是需要 Host Web 服务的浏览器流程，纯 stdio 的 SDK profile 无法发起。`initialize` 成功只证明路由存在，不证明凭据可用。

实机复现的三类错误：空 home + `deepseek-official` → `MISSING_CREDENTIAL`；用本地凭据副本的 home → `AUTH`/401；`deepseek-account` 无授权记录 → `ACCOUNT_SIGN_IN_REQUIRED`。

尚未确认：本地存储的 key 是过期还是无效；本机 Desktop 的授权是否足以让 account 路由通过。

需要的操作（任选其一，凭据不得粘贴进聊天或提交进仓库）：① 在 SDK 测试 home 中通过原生 Models 页面写入有效 API key，或在启动 bridge 的环境中导出 provider key 变量，保持 `deepseek-official`；② 明确授权复用已保存 Desktop 登录的现有 DSH home，并用 `DSH_SDK_PROVIDER=deepseek-account` 加一个已列出的模型（会向该 home 写入新会话）；③ 在 SDK 测试 home 中用共享同一 `DSH_HOME` 的 web profile 完成一次浏览器登录，再使用 `deepseek-account`。

### 9.4 实机验收现状

分两个阶段，均在同一台 Windows、Node 25.6.0 上完成。

**阶段 A（无可用凭据，保留为历史）**：L1 `BLOCKED`（API key 路由 `MISSING_CREDENTIAL`；账号路由无授权时为 `ACCOUNT_SIGN_IN_REQUIRED`），L2–L7 因同一门槛 `BLOCKED`，整体 `FAIL`、退出码 1。分段耗时（回执/可观测跨度，不是模型延迟）：MCP 连接 456–520 ms；`dsh_delegate` 冷路径 5769–6011 ms；回执后首个可观察事件 62–150 ms；回执后任务终结 402–490 ms。

**阶段 B（账号登录后，L1–L3 通过）**：按你的要求使用**独立 SDK 测试 home**（`<用户目录>/.dsh-sdk-test`），用固定版本 runtime 的 `dsh web` 在该 home 起一个仅回环的登录 Host，由你完成**一次浏览器账号登录**；登录 Host 随后关闭并释放端口。Desktop 的 `~/.dsh` 全程未被写入（`.credentials.yaml` 大小与修改时间未变），未使用任何 API Key（该 home 的凭据库 `refs` 为空，只存在账号 `grant`）。

| 编号 | 场景 | 结果 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| L1 | 成功的单轮文本任务 | **PASS** | live | `turn_completed`、`finalMessageStatus: available`、回复长度 11、runtime `ready`、观察完整；路由 `deepseek-account` / `deepseek-flash` |
| L2 | 同任务上下文续接 | **PASS** | live | 同一 `sessionId`；先存随机标记，再回忆，回忆轮完成且回复非空（长度 25） |
| L3 | 正常退出后恢复 | **PASS** | live | bridge 干净关闭后重启，按精确 task/session 恢复，下一轮完成，`observation.complete` 仍为 `true` |
| L4/L5/L6/L7 | 提问 / 审批 / 双任务 / 运行时异常 | **NOT_RUN** | — | 本阶段未请求执行 |

两条命令均为 `PASS`、退出码 0：`--stages L1`（1 次模型调用）与 `--stages L2,L3`（3 次模型调用）。阶段 B 分段耗时：MCP 连接 430–433 ms；`dsh_delegate` 冷路径 5954–6254 ms；回执后首个可观察事件 31–46 ms；回执后任务终结 1057–1121 ms；续接回执 95–119 ms；回忆轮终结 1488 ms；关闭 82 ms；重连/恢复回执 402/5938 ms；恢复后终结 1126 ms。

实机确认的正面证据：两个 task 记录均为 `cleanShutdown: true`、零降级、47/19 条已观察事件落盘；重启恢复通过了覆盖门槛，而不是被 `observation_gap` 拒绝——这正是本轮排空修复要去掉的失败模式。

**阶段 C（自定义 OpenAI 兼容网关：OpenCode Go）**：在同一隔离 home 中把路由换成 `opencode-go`（base URL `https://opencode.ai/inference/go/openai/v1`、模型 `deepseek-v4.1-flash`、`compat.thinkingFormat: deepseek`、密钥走该 home 的凭据库 refs）。L1/L2/L3 全部 `PASS`、退出码 0；工具调用实测 1 次 `tool/call` + 1 次 `tool/result` 并读回文件标记；推理实测产出 63 字符的 `reasoning` 块与 4 字符答案；网关要求的 `x-opencode-session` 头在实机 turn 中被接受，其存在性、同会话稳定性与跨会话互异性在本地 stub 上已先行证明。首轮同路由因 `api_key_expired` 被拒（bridge 如实记为 failed），换新 key 后通过。详见[验收结果](sdk-live-acceptance-results.md)。

**阶段 C 的隔离场景**：L6 实机 `PASS`（两个工作区、两个不同任务与会话、两个存活 runtime、容量 2、双方均完成且无标记串流）；L7 实机 `PASS`（先证明目标是本脚本所启 bridge 的子进程，再终止该 runtime：受害任务 `observation.complete=false`、后续输入 270 ms 内被拒，另一任务继续完成一轮，回复 51 字符）。L7 需显式 `--kill-owned-runtime`，脚本不按镜像名匹配、不重试被拒输入。

仍未获实机证据的项：审批往返、原生提问（脚本已备好 `--interaction-policy ask`，需操作方在终端回答）、排空失败与退出无法确认、macOS。

### 9.5 测试与证据文档

`npm run check`：构建 + **401** 项测试全部通过（首轮为 386；新增 `test/sdk-lifecycle.test.ts` 13 项、事件去重回归 1 项、中断推断回归 1 项）。证据文档已同步：[SDK 资质](sdk-qualification.md)（认证与第二轮缓解）、[验证指南](validation.md)（缺陷表、L1–L7、耗时、L7 受控流程）、[验收结果](sdk-live-acceptance-results.md)（带日期记录）、[SDK 后端指南](sdk-backend.zh-CN.md)（关闭语义、并发、revision、路由与验收脚本）、[已知问题](../KNOWN_ISSUES.md)。

本轮结论按层次表述：**代码与自动化**——已修复并有回归覆盖；**传输链路**——实机通过；**模型闭环**——账号路由在独立测试 home 中完成一次浏览器登录后，L1/L2/L3 实机通过；**API key 路由**——本机无有效 key，仍只有传输层证据；**审批、提问、双并发、受控 kill、排空失败与退出无法确认**——仍只有 mock 证据，不得写成"真实可用已验证"。macOS 仍未验证。
## 交付状态

- 工作树以可审阅的 diff 形式保存本次改动：本次文档交付未创建任何 commit，未推送分支，仓库 HEAD 仍是本次改动之前的提交。
- 第一轮交付只改文档（架构中英双语、已知问题、验证指南、本报告）；第二轮在 `src/sdk-*.ts`、`src/bridge-service.ts`、`src/sdk-observed-event-store.ts`、`src/sdk-connection-adapter.ts` 及对应测试中修复了 §9.1 的缺陷，`legacy` 与 `gateway` 的既有声明与行为保持不变（Host 路径的 interrupt 推断规则未改，且有回归断言）。
- 如需复核：`git status`、`git diff` 查看全部改动；`npm run check` 与上面的文档校验命令可重复执行。
