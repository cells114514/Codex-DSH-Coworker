# SDK 后端（可选）

[English](sdk-backend.md) | **简体中文**

Codex-DSH-Orchestrator 有三个后端：`legacy`（默认）、`gateway` 和 `sdk`。`sdk` 后端是可选项，必须用
`DSH_HOST_PROTOCOL=sdk` 显式选择，永不成为默认值。它通过 stdio JSON-RPC 驱动官方 DeepSeek Harness TypeScript SDK
runtime，因此 Codex 无需启动 DSH Desktop 或 Gateway 启动器即可委派 DSH。已有的 `legacy`、`gateway` 后端及其配置和
bridge 数据保持不变；SDK 后端失败时不会自动切换到其他后端。

## 它是什么

- **传输。** bridge 把 `dsh` CLI 模块作为子进程启动，用 SDK JSON-RPC 协议经 stdio 通信。因此这个后端没有 Host URL、
  没有 connect token、也不做 Desktop 发现——这些变量在此后端从不读取、也不校验。
- **归属。** bridge 自己持有它启动的 runtime 进程：按需启动、限制并发、回收空闲、退出时关闭。能力与生命周期事实按后端
  统一声明，所以不受支持的功能返回结构化错误，而不是空列表或伪造的成功。
- **发现与历史。** SDK 协议没有会话目录、也没有历史读取；持久化会话恢复的是模型上下文，不会重播旧事件。因此发现由
  bridge 自有，历史来自 bridge 自己的观察记录并显式标注覆盖缺口。它是观察缓存，不是 DSH 历史，也从不会被当作权威记录。
- **凭据。** runtime 读取 DSH home 自身的原生配置与凭据存储，与其他 DSH runtime 一致。bridge 从不读取、复制或写入这些
  凭据，生成的配置中不包含任何模型 API key。`sdk` profile 挂载两条 provider 路由，路由由
  `DSH_SDK_PROVIDER`/`DSH_SDK_MODEL`（或 runtime 默认值）在 `initialize` 时选定：

  | 路由 | 凭据 | 来源 |
  | --- | --- | --- |
  | `deepseek-official`（默认） | API key，通过 `x-api-key` 发送 | DSH home 的受管凭据存储，其次是继承的环境变量，然后是项目 `.env`、用户 `.env` |
  | `deepseek-account` | 账号授权，通过 `x-dsh-auth-token` 发送 | 已存入且 issuer 非 localhost 的 `grant`，并且请求目标是官方推理源 |

  账号登录是需要 Host Web 服务的浏览器流程；纯 stdio 的 SDK profile 无法发起该流程，因此该 home 必须已经存在授权记录。
  `initialize` 成功只能证明路由存在，不能证明凭据可用——凭据在第一次模型调用时才被评估。
- **独立性。** SDK runtime 与 DSH Desktop 是两个独立进程，各自使用独立 home。SDK 后端不需要、不会启动也不会停止
  Desktop；两者版本不一致属于预期情况，不是缺陷。

## 环境要求

- Node.js 22+（包要求，setup 会再次检查主版本）、npm、Git、Codex 以及本仓库 checkout。
- 一个已包含用户已授权 DSH 配置的 DSH home。bridge 不创建、不复制、也不替代凭据；引导、登录和 provider 授权由用户
  负责。
- 固定版本客户端的磁盘与安装时间：`npm install @deepseek-ai/dsh-sdk-client@0.2.2-rc.3` 会解析 606 个包
  （约 745 MB）。runtime 固定为 `@deepseek-ai/dsh@0.2.2-rc.3`。
- 一个提供 SDK JSON-RPC server 的 runtime profile。默认 profile 名为 `sdk`；自定义 profile 按原样使用，安装器无法
  验证它是否仍提供 SDK server。
- 平台：已有资质记录仅限 Windows，macOS 尚未验证。

## 安装

```sh
npm ci
npm run check
npm run setup -- --backend sdk --yes --no-preset --dry-run
```

审阅预览结果后，去掉 `--dry-run` 执行同一命令。该后端的预览输出一个 JSON 对象（server 名、目标配置文件、command、
args、环境变量、人工审批块、`writes: false` 及警告），不写入任何文件。

该后端的安装参数：

| 参数 | 含义 |
| --- | --- |
| `--backend sdk` | 选择 SDK 后端；不加此参数时 setup 仍使用 `legacy` 默认值 |
| `--dsh-home <dir>` | 写入 `DSH_HOME` 的 DSH home（默认：已有 `DSH_HOME` 或 `~/.dsh`） |
| `--sdk-profile <name>` | runtime profile（默认 `sdk`） |
| `--sdk-bin <path>` | 写入 `DSH_SDK_BIN` 的 `dsh` CLI 模块路径；是模块路径，绝不是 shell 命令 |
| `--bridge-home <dir>` | 覆盖 bridge home，替代按后端区分的默认目录 |
| `--dry-run` | 打印审阅对象，不写入 |
| `--no-preset` | 省略 `--preset` 或显式传入此参数；显式 preset 会被拒绝，因为 SDK 后端无法选择 agent preset |
| `--skill-path` / `--no-skill` / `--replace` / `--replace-skill` / `--skip-doctor` | 与其他后端一致 |

`--host-url`、`--host`、`--desktop-auto` 和 `--gateway` 描述 DSH Host，与 `--backend sdk` 一起使用会被拒绝；预先设置
`DSH_CONNECT_ORIGIN` 或 `DSH_CONNECT_TOKEN_ENV` 同样会被拒绝。写入的 MCP 环境只包含 `DSH_HOST_PROTOCOL=sdk`、
`DSH_HOME`、`DSH_SDK_PROFILE` 以及操作方显式提供的 SDK 变量，绝不含 Host URL、connect token 变量或模型 API key。
`dsh_resolve_approval` 的 `approval_mode = "prompt"` 与其他后端保持一致。手动 TOML 配置见
[手动配置](manual-configuration.zh-CN.md)。

### 用 doctor 检查安装

```sh
npm run build
node dist/doctor.js                      # 静态报告：不启动任何进程
node dist/doctor.js --probe-sdk          # 一次有界 initialize 握手
```

运行前导出 MCP server 会收到的同一组 SDK 变量（至少 `DSH_HOST_PROTOCOL=sdk`）。静态报告读取配置、包解析结果、DSH home
结构、runtime registry 和 bridge 自身的观察存储；它不启动 runtime、不发送 prompt、不恢复会话、也不启动 Desktop。
`--probe-sdk` 隐含 `--live`，要求 `DSH_HOST_PROTOCOL=sdk`，并且只执行一次有界 `initialize` 握手：不发送 prompt、不恢复
会话、不启动 Desktop。它有副作用，并在输出中明确说明：加载配置 profile 的插件、可能创建或更新 DSH home 的 profile 与
持久化目录、可能读取用户的原生凭据存储。探测结果作为报告返回而不是抛出异常，也不会改变静态结论。

### 运行实机验收脚本

`docs/operator-tools/sdk-live-acceptance.mjs` 通过 stdio 驱动真实的 MCP bridge，并为每个场景给出一个判定
（`PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`）和证据类别。

```sh
npm run build
node docs/operator-tools/sdk-live-acceptance.mjs --stages L1,L2,L3   # 一次性临时 DSH home
node docs/operator-tools/sdk-live-acceptance.mjs --stages L1 --home <sdk-home> --provider deepseek-account --model deepseek-flash
```

`--stages` 选择场景，认证已确认的环境无需每次重跑全部；`--home` 使用操作方提供的 SDK home 而不是一次性目录；
`--work` 与 `--work-two` 指定工作区；`--stage-limit` 限定单场景时长；`--max-model-calls` 限制模型调用次数；
`--interaction-policy deny|allow` 决定如何回答 runtime 审批与提问（默认 `deny`，绝不自动批准）；`--provider` /
`--model` 指定本次运行的 runtime 路由；`--json-out` 输出报告文件。

脚本只删除自己创建的目录，在 `finally` 中收尾，从不复制凭据存储，也不输出 prompt 正文、回复正文、凭据或真实任务/会话
标识。除非每个请求的场景都是 `PASS`，退出码非零；`BLOCKED` 属于失败而非通过。本轮带日期的实机结果见
[验收结果](sdk-live-acceptance-results.md)。

### 接入自定义 OpenAI 兼容网关

非 DeepSeek 端点通过 profile 里处于休眠状态的 `llm-pi-ai` 行注册，而不是通过 bridge 的环境变量。
编辑 SDK home 中的 `<DSH_HOME>/profiles/sdk/cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencode-go:                       # 路由名，由 DSH_SDK_PROVIDER 选择
        displayName: OpenCode Go
        api: openai-completions
        baseURL: https://opencode.ai/inference/go/openai/v1
        apiKeyEnv: OPENCODE_GO_API_KEY   # 凭据引用，不是密钥本身
        compat:
          thinkingFormat: deepseek       # 解析 reasoning_content
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
```

然后用 `DSH_SDK_PROVIDER=opencode-go`、`DSH_SDK_MODEL=deepseek-v4.1-flash` 启动 bridge，并把密钥以
`apiKeyEnv` 指定的名字写入该 SDK home 凭据库的 `refs`，或在 bridge 进程环境中导出同名变量。存储中的值
优先于环境变量，所以改用变量前要先删掉过期的存储条目。

该凭据库是 `version: 1` 的 YAML 文档：可选的 `refs:` 映射存放密钥引用，`records:` 映射存放登录授权。
推荐用 [`set-sdk-credential-ref.mjs`](operator-tools/set-sdk-credential-ref.mjs) 写入，密钥不会进入
shell 历史或聊天记录：

```sh
set OPENCODE_GO_API_KEY=sk-...          # 在你自己的终端里；PowerShell 用 $env:OPENCODE_GO_API_KEY="..."
node docs/operator-tools/set-sdk-credential-ref.mjs "$HOME/.dsh-sdk-test" OPENCODE_GO_API_KEY --from-env OPENCODE_GO_API_KEY
unset OPENCODE_GO_API_KEY
```

它会保留既有 `records`、可重复执行，只打印条目名和长度区间。写完后可用
[`inspect-credential-structure.mjs`](operator-tools/inspect-credential-structure.mjs) 确认条目存在，
而不会显示密钥内容。

需要“每个会话稳定”的请求头时，在 profile 旁放一个小插件并用相对路径引入（loader 以配置文件为基准解析
相对路径）：

```yaml
- insert:
    - id: opencode-session-header
      name: './plugins/opencode-session.mjs'
```

```js
// profiles/sdk/plugins/opencode-session.mjs
export const name = 'opencode-session-header'
export function apply(ctx) {
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    if (typeof request?.sessionId === 'string') headers.set('x-opencode-session', request.sessionId)
    return next()
  })
}
```

该值在单个会话内稳定、跨会话不同；没有会话 id 的辅助调用需要自带兜底值。Harness 归属头在所有贡献者之后
写入，因此无法覆盖保留头名。两个基于本地 stub 的校验脚本可以在不消耗真实请求的前提下验证这套接线：
[`verify-opencode-session-header.mjs`](operator-tools/verify-opencode-session-header.mjs) 与
[`verify-opencode-reasoning-tools.mjs`](operator-tools/verify-opencode-reasoning-tools.mjs)。

## 减少 Codex 监督开销

### 异常退出后的显式恢复

普通 followup 仍不会自动接管未干净退出的 owner。维护方可使用独立恢复脚本，先预览：

```powershell
node docs/operator-tools/recover-sdk-task.mjs --task <taskId> --home <sdk-home>
```

核实旧 Bridge、独立 Runtime 及外部工作均已停止，并设置与原任务相同的 provider/model 后，在同一命令后追加
`--apply --confirm-no-runtime`。该入口目前只验证过 Windows。它在 registry 锁内核对 owner、更新时间和完整环境身份，
拒绝存活 owner；在 `runtimes/recoveries/` 保存原始记录后，将归属转交给本次维护进程。该进程仅恢复精确会话并等待 idle，
不提交任何 prompt、不重新创建会话、不重发旧输入，最后使用 SDK 真实关闭路径排空并退出。

新进程正常退出才登记它自己的 cleanShutdown；备份中的旧记录仍保持异常退出事实。旧 running 轮次会标记为 interrupted。
观察缺口不会被清除；若恢复发现缺口或无法正常退出，后续写入仍应拒绝。脚本会保守拒绝在其他 DSH CLI Runtime 存活时执行。
恢复完成后先查状态、核对已有文件和测试，再提交明确的剩余工作。不要把恢复成功当作原任务完成或旧消息已投递的证明。

续接失败时，SDK 的 `runtime_owner_conflict`、`session_resume_failed`、`observation_gap` 和
`prompt_outcome_unknown` 等原始结构化错误会保留，不需要模型目录来生成错误信息。前几类可能发生在提交之前，
而 `prompt_outcome_unknown` 表示可能已入队，不能自动重试。更新 Bridge 不会把未干净退出的历史 owner 自动变成
可接管状态；进程不存在也不能单独证明历史执行或观察完整性。不要删除归属记录或伪造 cleanShutdown 来强行续接。

日常监督优先调用 `dsh_watch(taskId, timeoutSec=30)`。普通工具日志和游标变化在 Bridge 内部处理，不会使该调用提前返回。
它只在任务终结、待答问题/审批、连接不可用、观察缺口或等待窗口到期时返回精简摘要，不包含日志正文或完整状态。

超时后直接再次调用 `dsh_watch`；仅在任务结束或需要处理交互/异常时读取一次 `dsh_status`。确需排查时才调用
`dsh_tail`，使用递增游标并限制 `maxBytes=4096`。不要把 wait、status、tail 三个工具固定串成每轮循环。

`dsh_wait` 保留原有逐事件等待与完整状态行为，适合明确需要详细进度的场景。每个 30 秒窗口仍会返回一次，因而
监督开销不是零；实际额度节省需测量，不能由摘要字节数直接换算。不会发送额外模型请求或改变模型服务端缓存。

安装更新后，正在运行的 Bridge 及其他聊天已加载的 Skill 不会自动变更。等当前 SDK 任务结束后再重启/重载 Codex；
不要为加载工具打断活动任务。旧连接暂时使用 `dsh_wait`，但避免每轮追加 status/tail。

## 配置参考

对 SDK 后端来说，以下变量就是全部配置面。Host URL、connect token 变量和 Desktop 发现在此后端从不读取、也不校验，因此
无关的 Host 设置无法阻塞它，Gateway 凭据也不可能泄漏进来。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_HOST_PROTOCOL=sdk` | `legacy` | 显式启用此后端 |
| `DSH_HOME` | `~/.dsh` | SDK 持久化、profile 与凭据 |
| `DSH_SDK_PROFILE` | `sdk` | 自定义 profile 必须仍然提供 SDK server；安装器无法验证 |
| `DSH_SDK_BIN` | 未设置（使用依赖中同版本的 `@deepseek-ai/dsh`） | `dsh` CLI 模块路径，按词法解析；绝不做 shell 插值，绝不是命令行；支持带空格的 Windows 路径 |
| `DSH_SDK_PROVIDER`、`DSH_SDK_MODEL` | 未设置（runtime 默认 `deepseek-official` / `deepseek-v4-flash`） | 必须同时设置或同时省略；runtime 在 `initialize` 时校验该精确路由 |
| `DSH_SDK_REASONING_EFFORT` | 未设置 | 需要 provider 与 model；由 runtime 在 `initialize` 时校验 |
| `DSH_SDK_MAX_RUNTIMES` | `2` | 并发 runtime 的硬上限 |
| `DSH_SDK_IDLE_TIMEOUT_MS` | `600000` | `0` 关闭空闲回收 |
| `DSH_SDK_INITIALIZE_TIMEOUT_MS` | `60000` | 握手时限 |
| `DSH_SDK_SHUTDOWN_TIMEOUT_MS` | `10000` | 有界关闭时限 |
| `DSH_APPROVAL_TIMEOUT_MS` | `300000` | 待处理审批/问题到期时间；计时器只取消，从不授予 |
| `DSH_BRIDGE_HOME` | `sdk` 为 `<DSH_HOME>/codex-bridge-sdk`；`legacy`/`gateway` 为 `<DSH_HOME>/codex-bridge` | 不同状态根；从不自动改指向 |

共用变量含义不变：`DSH_BRIDGE_TIME_ZONE` 会被接受但不会传递，因为 SDK 协议没有该字段——结果如实返回
`clientTimeZoneApplied: false`。`--preset`/`DSH_BRIDGE_AGENT_PRESET` 请求会被拒绝而不是被忽略，因为 SDK 协议没有
preset 字段，且 runtime profile 固定了 composition。`DSH_HOST_VERSION` 仍是操作方声明，与已验证的产品证据分开记录。
provider 与 model 都省略时，`dsh_host_status` 和 doctor 会给出回退路由名称，而不会声称存在目录。

## 能力

能力按后端声明，并在 `dsh_host_status.capabilities` 中返回；调用方必须依据这些标志判断，而不是依据协议名称。

| 能力 | `sdk` | `legacy` / `gateway`（Host 支撑） |
| --- | --- | --- |
| 传输 | `stdio-jsonrpc` | `http-websocket` |
| 会话发现 | bridge 自有 | Host 目录 |
| 历史来源 | 观察缓存 | Host |
| 权威历史 | 否 | 是 |
| 按精确会话 ID 恢复 | 是 | 是 |
| 原生重命名 | 否 | 是 |
| 模型目录 | 否 | 是 |
| 动态模型选择 | 否 | 是 |
| Steering（`mode=steer`） | 否 | 是 |
| turn 取消 | 否 | 是 |
| 队列快照 / 变更 | 否 | 是（取决于 Host 能力探测） |
| 子 Agent 历史 | 仅观察缓存 | 仅当 Host 探测报告支持时 |
| `agentPreset` 选择 | 不支持 | 支持 |
| 一次性审批 | 是 | 是 |
| 原生用户问题 | 是 | 是 |
| WebSocket 事件多路复用 | 否 | 是 |

## 生命周期与并发

- **每个 root 任务一个 runtime。** runtime 由该任务的第一个 prompt 按需创建——不在 MCP 启动时创建，也不因读取而创建。
  `dsh_host_status`、`dsh_status`、`dsh_tail` 和 `dsh_find_sessions` 只报告“已加载”“未加载”或“未知”，不启动任何东西。
- **有界启动、观察先行。** 子进程、请求处理器、通知订阅与消费循环都在 `initialize` 握手之前建立，`acquire` 只有在已收到的
  通知写入持久化之后才返回。因此处理器与订阅在第一个 prompt 之前就存在，`initialize` 或 `session/resume` 期间提交的事件
  不会丢失。若队列无法在时限内排空，会有界地标记覆盖不完整。
- **固定路由。** provider/model 路由在 `initialize` 时校验，随后对该 runtime 固定。adapter 或模型不可用会让握手失败，
  不会发送 prompt，也不会静默回退。
- **容量。** 同时存在的 runtime 至多 `DSH_SDK_MAX_RUNTIMES` 个。所有槽位都被活跃任务占用时，bridge 返回
  `runtime_capacity_exceeded`，而不是无限排队。
- **回收。** 只有既空闲、又没有未回答交互的 runtime 才会被回收。容量回收绝不终止活跃工作，`DSH_SDK_IDLE_TIMEOUT_MS=0`
  完全关闭空闲计时器。
- **关闭与干净关闭语义。** MCP transport 关闭、stdin EOF、SIGINT/SIGTERM 以及初始化被打断时，bridge 关闭自己持有的
  runtime。关闭过程有界：先关闭进程，再有界排空通知队列，然后关闭订阅并只上报一次退出结果。关闭是异步的，退出前会被等待，
  并且幂等。只有当进程退出已被确认**且**队列已排空时，任务才记为 `cleanShutdown`；无法证明排空的任务记为不完整，
  `observation.complete` 变为 `false`，普通后续输入会以 `observation_gap` 被拒绝，直到新建任务。完全无法确认退出的情况会
  保留容量槽位，并对该任务用 `runtime_unavailable` 拒绝替代 runtime。
- **归属。** 归属按任务记录。第二个 bridge 若发现记录未干净关闭，会收到 `runtime_owner_conflict` 而不是接管任务；新持有者
  只在记录为干净关闭之后才可接管。
- **恢复。** 普通续接只有记录为干净关闭之后、并且用精确会话 ID、相同的 DSH home、profile 和路由才能恢复。异常 owner
  需要维护方显式执行上文恢复脚本；普通调用不会自动执行它，其他不满足条件的情况在接受 prompt 之前失败。
- **观察。** 崩溃、传输中断、在 turn 运行中/交互待回答期间关闭，或存储写入失败，都会降低该任务的观察质量，并把该 turn
  标记为中断，而不是报告成功。传输中断会释放 runtime 槽位（子进程的流已结束），但仍会降级该任务，因此下一次后续输入会报告
  缺口，而不是返回被截断的对话。
- **并发启动。** 同一任务的并发调用共享一个 runtime；跨任务的并发启动不会超过容量上限；启动失败会释放预留的槽位。
- **状态 revision。** `dsh_status.connection.revision` 是严格单调的视图时钟：无变化时保持稳定、永不回退，runtime 被移除并
  重建之后也如此，因此陈旧视图拒绝不会被复用的数字绕过。
- **中断推断。** 观察到的 `running` 在真正看到状态转换之前都是“未知”。未知状态不会被报成 `interrupted`；只有权威的
  “未运行”报告才会这样判定 turn。

## 磁盘数据

以下内容都位于 SDK 后端自己的 bridge home（默认 `<DSH_HOME>/codex-bridge-sdk`）。

| 路径 | 内容 |
| --- | --- |
| `<bridge home>/tasks/<taskId>.json` | 已有两字段任务映射，保持不变；不含对话正文 |
| `<bridge home>/runtimes/<taskId>.json` | runtime 记录：`schemaVersion`、`backend`、`cwd`、DSH home、profile、固定路由、配置指纹、观察纪元、干净关闭标记、持有者、bridge 标题 |
| `<bridge home>/observed/<taskId>/events.jsonl` | bridge 自己观察到的事件，先于派生状态写入 |
| `<bridge home>/observed/<taskId>/meta.json` | 按会话的序号统计、字节计量与降级记录 |
| `<bridge home>/ledger`、`<bridge home>/claims` | 已有事件账本与 workspace claim，保持不变 |

观察文件可能包含对话正文，因此使用私有文件模式创建（目录 `0700`、文件 `0600`）。它们只保存本 bridge 观察到的事件：
观察事件不是 DSH 历史，恢复的会话不会重播旧事件，完整性始终显式报告。bridge 从不解析 DSH 自身的
`sessions/**/session.*.jsonl.zstd` 日志或投影缓存，也不会写入这些文件。

## 错误

SDK 失败采用结构化对象，携带 `code`、`backend`、`retryable`、`suggestion` 以及任务/会话标识。不受支持的能力绝不会被
报告为空列表或伪造的成功。

| 代码 | 含义 |
| --- | --- |
| `unsupported_capability` | 后端未实现所请求的语义；`details.capability` 指明具体能力 |
| `sdk_initialize_failed` | 有界 `initialize` 握手失败；未发送 prompt |
| `runtime_unavailable` | 该操作没有存活的 runtime，或 runtime 管理器已关闭 |
| `runtime_capacity_exceeded` | `DSH_SDK_MAX_RUNTIMES` 个槽位全部被活跃任务占用 |
| `runtime_owner_conflict` | 另一个 bridge 持有该任务的 runtime，且没有记录干净关闭 |
| `runtime_identity_mismatch` | 记录的 runtime 身份（home、profile、路由、cwd、会话）不匹配 |
| `backend_mismatch` | 该会话不是本 bridge 创建的，或不属于该任务已观察到的谱系 |
| `observation_gap` | 观察覆盖不完整，继续 follow-up 会让缺失事件的记录看起来完整 |
| `prompt_outcome_unknown` | 未确认 prompt 回执；消息可能已经排队，因此没有重试 |
| `session_resume_failed` | 恢复握手失败；未发送 prompt |
| `sdk_unavailable` | 无法加载固定版本 SDK 客户端包，或该包未导出客户端 |

`prompt_outcome_unknown` 必须永不重试：改为用 `dsh_status` 查看已观察事件，因为重复提交同一输入可能产生重复工作。
`observation_gap` 同样无法就地修复——继续使用只读 status/tail（它们会显式报告缺口），或由用户带自己的 handoff 摘要
开启新任务。

## 首版限制

- 没有 Desktop 会话发现或附加，也不能发现别处创建的会话。只有本 bridge 创建的任务可被发现：`dsh_find_sessions` 列出
  它们，`dsh_attach_session` 返回 `unsupported_capability`。
- 恢复的会话只恢复模型上下文。bridge 无法重读自己未观察到的历史，观察缺口会阻止正常 follow-up，直到用户带自己的
  handoff 摘要开启新任务。
- provider/model 路由按 runtime 固定：没有目录、不能切换、不能按任务调整推理强度。`modelProfile`、视觉路由和
  `reasoningEffort` 请求会被拒绝，而不是被静默忽略。
- 没有 steering：`dsh_followup` 只接受 `mode=queue`。
- 没有 turn 或队列取消：`dsh_cancel` 返回 `unsupported_capability`，关闭 runtime 不会被报告为已取消的 turn。
- 没有子 Agent 列表；`dsh_status` 报告已观察到的谱系。
- 没有协议版本协商：客户端不校验 runtime 的 `serverInfo` 版本。
- 不传递 `clientTimeZone`（`clientTimeZoneApplied: false`）；使用 runtime profile 自身的时区。
- Desktop 数据从不迁移、从不修改，两个后端也从不共用或改指向彼此的 home。
- bridge 退出后不保留后台服务，进程结束后无法恢复工作。
- 这不是 sandbox，也不是操作系统级隔离机制。bridge 本地 workspace claim 仍只协调 bridge 用户，可写任务仍建议使用独立的
  worktree。

## 回滚

把 `DSH_HOST_PROTOCOL` 改回 `gateway`（或 `legacy`），并恢复该后端自己的 bridge home，然后在约定空窗重载调用方。SDK
数据原样留在磁盘上——永远不迁移到其他后端，也不会被自动删除。保留旧 checkout、配置备份和已安装 Skill 备份；恢复前先
检查后续配置改动。锁恢复与 Windows 文件权限限制见[已知问题](../KNOWN_ISSUES.md)。

## 验证状态

- `npm run check`（构建加 401 个自动测试）已在 Windows/Node 25.6.0 通过（首轮结束时为 386；第二轮新增覆盖握手期观察、
  有界排空的关闭、并发获取与 revision 单调性）。
- 实机探测记录在 [SDK 资质](sdk-qualification.md)：有效 `initialize` 约 2.6 秒完成；无效 provider/model 路由约 2.6 秒
  被拒绝且未创建会话；prompt 返回 UUID 回执后事件开始流式到达；第二个进程恢复会话时从更晚的序号开始，且不重播此前事件。
- 仅 Windows。macOS 尚未验证。
- 实机验收分两个阶段。无可用凭据时，L1–L7 均在模型边界 `BLOCKED`（`MISSING_CREDENTIAL`、`AUTH`/401、
  `ACCOUNT_SIGN_IN_REQUIRED`）。在独立 SDK 测试 home 中由操作方完成一次浏览器账号登录后，账号路由
  （`deepseek-account` / `deepseek-flash`）通过了 **L1**（真实回复）、**L2**（同任务上下文续接）与 **L3**（干净关闭、
  精确会话恢复、恢复后再次完成 turn）；L4–L7 未运行。API key 路由在本机仍只有传输层证据。见
  [验收结果](sdk-live-acceptance-results.md)。
- 真实审批往返、真实原生用户问题（含取消）、两个并发存活 runtime、turn 中途崩溃，以及受控终止 runtime 的流程，仅由
  mock runtime 测试覆盖。mock 覆盖不是资质证据。排空失败与退出无法确认同样只有 mock 覆盖；而“干净关闭”已在实机观察到：
  关闭后记录为 `cleanShutdown: true` 且没有任何降级记录，重启后用精确会话恢复也没有出现错误的 `observation_gap`。
- 记录的安装体量：安装固定版本 SDK 客户端会解析 606 个包（约 745 MB），客户端为
  `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3`，runtime 为 `@deepseek-ai/dsh@0.2.2-rc.3`。

上文每一项“否”背后的能力缺口与完整证据记录见 [SDK 资质](sdk-qualification.md)。Host 支撑路径的整体验证仍见
[验证](validation.md)。
