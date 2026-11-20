# 双桌面 Coworker 通信 — P0 资格调查（2026-11-18）

状态：**P0 调查完成，P1 被两项外部输入挡住**（下称“待用户输入”）。本文不代表能力已接入或已通过验收。
证据分三类并逐条标注：**源码**（读过该 commit 的文件）、**实机**（本机运行过只读命令并记录输出）、**未验证**（无证据，不得引用为结论）。

## 1. 环境快照（实机，2026-11-18）

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 仓库 HEAD | `1e08d63`（其上还有 18 个未提交路径：精简等待、TypeError 修复、异常任务恢复、调查文档、恢复脚本） | 实机 `git rev-parse/status`；本轮未改动这些文件 |
| Node | `v25.6.0` | 实机 |
| Codex CLI（PATH） | `codex-cli 0.153.4`，真实二进制 `<npm-global>\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` | 实机 |
| Codex 桌面应用 | `OpenAI.Codex` `26.1111.2228.0`（AppX，运行中） | 实机 AppX + 进程 |
| 桌面内置内核 | `codex-cli 0.169.0-alpha.11.1`，`<AppX-package>\app\resources\codex.exe`（SHA256 `094D4DB…F6B4`，与 PATH CLI 不同二进制） | 实机 `--version` + 文件哈希 |
| DSH Desktop | `DeepSeek Harness 0.2.1-rc.2`（运行中，多进程） | 实机 |
| SDK 路由（保留不动） | client/runtime `0.2.2-rc.3`，provider `opencode-go`，model `deepseek-v4.1-flash` | 既有验收记录 |

系统：Windows `10.0.26300`。桌面实例与 PATH CLI 是**两个不同内核版本、两个不同可执行文件**，本轮所有 Codex 侧结论都注明用的是哪一个。

## 2. 候选固定情况

| 候选 | 固定版本 | 许可证 | 本地路径（仓库外） | 证据 |
| --- | --- | --- | --- | --- |
| A `dddzzz123-dz/codex-dsh-bridge` | commit `59c2e6721539464713801efa2659d1f9947d5b40`（= tag `v0.2.0`，package.json `0.2.0`） | MIT（Copyright 2026 dddzzz123-dz） | `<USER_HOME>\coworker-eval\codex-dsh-bridge` | 源码 |
| B `caelricluo/dsh-peer` | commit `e6cc6dd025c859ff93a261e8a54b35ffaf707ed2`（main 最新） | 待读（`LICENSE` 存在，尚未逐字核对） | `<USER_HOME>\coworker-eval\dsh-peer` | 源码（仅 README） |

未执行任何候选的安装器（A 的 `scripts/install-windows.ps1`、B 的 `install.sh` 均未运行）。两个目录都在仓库外，未改动 `~/.dsh`、`~/.codex` 的任何 profile。

## 3. 候选 A 的源码事实

架构（README + 源码核对一致）：

```text
Codex → scripts/dsh-client.mjs → DSH Web API http://127.0.0.1:3080 → Web UI 可见对话
DSH   → Cordis 插件 → http://127.0.0.1:32123 controller → Codex App Server (stdio) → 桌面可见任务
```

关键实现事实（`bridge/controller/app-server-client.mjs`、`controller.mjs`）：

- Codex 侧**自己 spawn** `codex app-server --listen stdio://`，可执行文件取 `CODEX_BRIDGE_EXECUTABLE ?? "codex"`，即 **PATH CLI 0.153.4**，不是桌面实例。
- 与 App Server 的协议是**按行分隔的 JSON-RPC**（`initialize` + `initialized`，随后一般请求/通知），与候选 B 的 CLI 形态一致；不是 MCP 的 `Content-Length` 头。
- 写入既有任务用 `thread/resume` + `turn/start`，其中 `approvalPolicy: "never"`、`sandboxPolicy` 为只读或全访问；结束时 `thread/unsubscribe` 并停掉自己 spawn 的 app-server 进程。README 明确由此产生“在其他位置打开” writers 争用。
- 唤醒 Codex 的方式是**发起一次新 turn**（`input: [{type:"text"}]`），**没有使用 `toolOutput`**。
- DSH 侧走 `http://127.0.0.1:3080` 的 Web API；安装脚本改的是 `~/.dsh/profiles/web/cordis.patch.yml`。
- controller 默认 `127.0.0.1:32123`、无身份验证，单机同用户为信任边界；请求串行。

与本任务书目标的差距（源码证据，非实机）：

| 要求 | A 的现状 |
| --- | --- |
| DSH 端必须是桌面 Host 会话 | DSH 侧依赖 **Web API :3080**；本机 Desktop `0.2.1-rc.2` 未监听该端口（实机：连接被拒绝） |
| 关键事件以工具数据回传，不伪装人类指令 | 只用 `turn/start` 的文本输入，未用 `toolOutput` |
| 权限升级由用户决定 | `approvalPolicy: "never"`，审批不出现在人面前 |
| 不抢占用户轮次 | 承认短暂占用 writer，桌面显示“在其他位置打开” |

## 4. P1 门槛：连接哪个 Codex 实例（实机结论）

### 4.1 桌面实例是否暴露可连的控制通道

- 桌面内核进程命令行（实机）：`codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled …`，**没有 `--listen` 参数** → 它绑定在 Electron 父进程的 stdio 上，不监听 socket/pipe。
- `codex app-server daemon version`（实机）：`Error: codex app-server daemon lifecycle is only supported on Unix platforms` → Windows 没有受管 daemon，也就没有 `proxy` 可连的控制 socket。
- 命名管道枚举（实机）：只有 `codex-app-tools-…`、`codex-browser-use-…`、`codex-computer-use-…` 等工具管道，**没有 app-server 控制管道**。
- 结论：**“连接现有桌面 App Server”（模式 A）在 Windows 上不可达**。此前 proxy 在传输阶段失败与版本号无关，是因为没有可连端点。

### 4.2 独立 app-server + 共享 `~/.codex`（模式 B）是否可用

只读探测：spawn `app-server --listen stdio://`，仅发送 `initialize` + `initialized`，不调用任何 thread/turn 方法，随后结束进程。

| 内核 | `initialize` 结果 | 证据 |
| --- | --- | --- |
| PATH CLI `0.153.4` | 成功，返回 `codexHome: <USER_HOME>\.codex`、`platformFamily: windows` | 实机 |
| 桌面内核 `0.169.0-alpha.11.1` | 成功，同样返回 `codexHome` 与平台 | 实机 |

所以模式 B 在传输层可用，但它是**另一个实例**，只共享 `~/.codex` 状态；桌面窗口看到的是“同一份存储”，不是同一进程。这一点必须与“连接到桌面实例”分开记录，不得混称。

`thread/read` 与 `turn/start` **尚未调用**：本任务书要求使用用户明确指定的测试聊天与准确 threadId，未取得前不按 cwd/标题/最近创建推断。

### 4.3 与候选 A/B 的关系

- A 用的正是模式 B（自 spawn CLI app-server），因此它**不可能**等于“连上桌面实例”；它的“桌面可见”依赖共享 store + writer 争用。
- B 的 Codex 适配层同样驱动 `codex app-server`（README 声明“outbound turns”），倾向同一模式；待源码核对。

## 5. 判定与阻塞

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 版本与实例核对 | 完成 | 桌面 26.1111.2228.0 / 内核 0.169.0-alpha.11.1 / CLI 0.153.4 / DSH 0.2.1-rc.2 |
| 候选固定（A、B） | 完成 | A=59c2e672，B=e6cc6dd0 |
| A 源码审查 | 完成 | 安装器、controller、App Server 客户端、插件、Skill 均已读 |
| A 的 DSH 侧兼容性 | **不兼容当前 Desktop** | 需要 Web API :3080；本机未监听（实机） |
| 模式 A（连桌面实例） | **不可达** | 桌面 app-server 无监听端点；`daemon` 仅 Unix |
| 模式 B（独立实例+共享 store） | 传输层可用 | 两个内核均可 `initialize` |
| P1 只读 `thread/read` | **BLOCKED — 待用户输入** | 需要测试聊天准确 threadId + 窗口侧确认 |
| D1–D11 | NOT_RUN | 未进入，遵守“P1 通过才碰模型” |

## 6. 需要的用户输入（一次说明）

1. **测试聊天的准确 threadId**（Codex 桌面里新建一个只用于本次测试的聊天）。不要用真实工作聊天，也不要让我按 cwd/标题/最近创建去猜。
2. **窗口侧确认**：在我读出该 threadId 后，请你对照桌面窗口确认这就是那个测试聊天（我需要一次“是/否”，不会伪造确认）。
3. **模式选择**：Windows 上只有模式 B 可达。请确认是否允许我用**桌面内核 `0.169.0-alpha.11.1`** 起独立 app-server 做只读 `thread/read`（只读，不 `turn/start`）。若不允许，P1 只能停在“模式 A 不可达”的诊断结论。
4. **DSH 侧对接形态**（P3 前需要）：当前 Desktop 没有 :3080 Web API。选项是 (a) 用 Desktop profile 加载候选插件（需预览 + 备份 + 你确认测试窗口），或 (b) 维持后台 SDK 后端并单列为“非双桌面”。默认先不选，等 P1 结果。
5. **测试隔离**：确认用独立 workspace 与消息目录（拟 `<USER_HOME>\coworker-eval\sandbox\`，仓库外），不触碰现有 M3 等真实任务。

## 7. 安全与回退边界（本轮已遵守 / 将遵守）

- 未运行任何安装器，未改 `~/.dsh`、`~/.codex` 配置，未注册任何 Codex/MCP 服务。
- 未调用 `turn/start`、未创建 thread、未发送 toolOutput、未触发模型请求。
- 未升级/降级 CLI 与桌面应用，未改 `CODEX_CLI_PATH`，未给应用打补丁。
- 所有下载与沙箱都在仓库外；仓库里只新增本文档（不自动提交）。
- 若后续需要改 Desktop profile：先出逐文件 diff 预览 + 备份清单 + 回退步骤，再由用户决定测试窗口。

## 8. P1 只读验证（2026-11-18，通过）

用户指定测试聊天 threadId（完整值由操作方持有，此处只记前缀 `<test-id-1>`）。使用**桌面内置内核** `0.169.0-alpha.11.1`（`<AppX-package>\app\resources\codex.exe`）以 `app-server --listen stdio://` 启动独立实例，仅执行 `initialize` + `initialized` + `thread/read`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `initialize` | 成功，返回 `codexHome`、`platformFamily: windows` | 实机 |
| `thread/read` | 成功 | 实机 |
| 返回 ID 与指定 ID 完全一致 | **是**（`idMatches: true`，返回前缀 `<test-id-1>`） | 实机 |
| 是否创建新 thread | 否，未调用 `thread/start` | 源码（探测脚本） |
| 是否发送 `turn/start` / `toolOutput` | 否 | 源码（探测脚本） |
| 是否改配置/权限/模型 | 否 | 探测脚本不带 `-c` 覆盖 |
| 是否写入 store | 只读调用；未验证写路径（未调用写方法） | — |
| 返回的 thread 字段 | `id/name/cwd/createdAt/updatedAt/status/model/modelProvider/sessionId/historyMode/canAcceptDirectInput/attachedToThreadId/…` | 实机（仅字段名，未记录内容） |
| 通知 | 仅 `remoteControl/status/changed` | 实机 |
| `turns` | `includeTurns: false`，故为 0 条；不代表空会话 | 实机 |

**这项通过说明什么、不说明什么。** 说明：在模式 B（独立实例 + 共享 `~/.codex`）下，可以用准确的 threadId 只读打开桌面里已有的会话。**不说明**：原窗口会自动同步、原轮次结束后能被唤醒、或两个窗口共享同一进程。共享存储可读 ≠ 原窗口实时同步，D2/D3 仍待验证。

探测脚本：`<USER_HOME>\coworker-eval\sandbox\p1-thread-read.mjs`（仓库外）。

## 9. 候选 B：`caelricluo/dsh-peer`（源码与许可证核对）

固定：commit `e6cc6dd025c859ff93a261e8a54b35ffaf707ed2`，`@caelricluo/dsh-peer@0.1.0`，**MIT**（Copyright 2026 caelricluo），零运行时依赖，`peerDependencies: @deepseek-ai/cordis ^4.0.1`（可选），Node >= 20。

结构（源码）：`lib/index.js`（Cordis 插件，`inject = ['tools']`，注册 5 个 `peer_*` 工具）、`lib/bridge.js`（回环 HTTP 桥，默认 `127.0.0.1:45710`，token 存 `~/.dsh-peer/bridge.json` 0600）、`lib/store.js`（append-only thread 日志 + 游标/长轮询）、`lib/adapters/{codex-desktop,codex,claude,dsh}.js`、`cordis.patch.yml`（一条 insert 行挂载插件）、`test/` 五个测试文件。

Codex 侧适配器（`lib/adapters/codex-desktop.js`，源码证据）：

- spawn `codex app-server`（无 `--listen`，stdio），并**以 `clientInfo.name = "Codex Desktop"` 初始化**，让新建 thread 出现在桌面 Recents；注释称协议对标 `codex-cli 0.163.0-alpha.11.1`。
- 方法：`thread/start` / `thread/resume {threadId, excludeTurns}` / `turn/start {threadId, input:[{type:"text"}]}`；通知取 `item/completed`、`turn/completed`。
- 同样**不使用 `toolOutput`**：唤醒是通过新 turn 的文本输入。

与目标的差距（源码证据）：

| 要求 | B 的现状 |
| --- | --- |
| 关键事件作为工具数据回传 | 用 `turn/start` 文本输入，非 `toolOutput` |
| 身份不得伪装 | 以 `"Codex Desktop"` 作为 clientInfo 名，使 thread 看起来像桌面自己创建的；这是可见性手段，但属于身份声明，需要单列风险 |
| 桌面实例 | 仍是模式 B（自 spawn app-server），不是桌面进程内 |
| writer 争用 | `thread/resume` + `turn/start` 写既有 thread 时，桌面可能显示“在其他位置打开” |

DSH 侧兼容性（对 0.2.1-rc.2）：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 插件形态 | 标准 Cordis insert 行 + `dsh.profile.bundles` 挂载，与 Desktop profile 同构 | 源码 |
| 所需服务 | 仅 `inject = ['tools']`；`sessions` 用 `ctx.get()` 可选读取 | 源码 |
| 依赖的内部符号 | `createUserMessage`、`SessionSeq`、`defineTool` 用动态 import 从 `@deepseek-ai/*` 取 | 源码 |
| 桌面运行时是否含这些符号 | 在 Desktop 0.2.1-rc.2 的 `app.asar` 中**字符串命中** `createUserMessage`、`SessionSeq` | 二进制字符串证据（非调用证据） |
| 实际调用是否成立 | **未验证**（未安装、未加载插件） | — |
| 环境观察 | `~/.dsh/profiles/node_modules/@deepseek-ai/cordis` 是指向 WSL 工作树的符号链接（指向一个 WSL 工作树，UNC 路径已脱敏），安装插件会牵动该 workspace | 实机 |

结论：B 比 A 更贴近 Desktop（插件即 Cordis 行、有 thread 游标与长轮询、零依赖、MIT、有测试），但**两者都没解决 toolOutput 语义**，且 B 用桌面 originator 名初始化。是否采用取决于 P2 能否用 `turn/start` 满足“原窗口自动继续”，这必须在真实等待中验证，不能由源码推定。

## 10. Desktop profile 接入预览（未安装，仅计划）

目标 profile：`~/.dsh/profiles/desktop`（`dsh-profile-desktop`，bundles 含 `@deepseek-ai/dsh-base`、`dsh-web-app` 与若干实验插件）。

将发生的写入（**尚未执行**）：

| 文件 | 预期变化 |
| --- | --- |
| `~/.dsh/profiles/desktop/package.json` | `dependencies` 增加 `@caelricluo/dsh-peer`（`link:` 本地路径）；`dsh.profile.bundles` 增加该包名 |
| `~/.dsh/profiles/desktop/pnpm-lock.yaml` | 由 `dsh plugin add` 更新 |
| `~/.dsh/profiles/desktop/node_modules/` | 新增包链接（该目录当前指向 WSL workspace，需先确认链接语义） |
| `~/.dsh-peer/bridge.json` | 首次启动时写入 token（0600），属新文件 |
| Desktop 进程 | 重启后加载插件：监听 `127.0.0.1:45710`，向会话注入 5 个 `peer_*` 工具 |

备份与回退（安装前执行）：

1. 复制 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 到仓库外备份目录，记录 SHA256 与时间戳。
2. 记录 `dsh plugin --profile desktop` 变更前后的 `package.json` diff（供审阅）。
3. 回退：恢复上述三个文件 + 删除 `~/.dsh-peer/`，重启 Desktop；不触碰 SDK 目录、凭据与真实任务。
4. 全程不按进程名批量结束进程；只重启 Desktop 应用本身（用户操作）。

风险（必须在安装前由用户接受）：

- 一旦安装到 `desktop` profile，**用户日常使用的 Desktop 会加载该插件**；这不是隔离测试窗口。
- 插件以 `"Codex Desktop"` 身份初始化 app-server；日志/最近列表可能出现来源混淆。
- 5 个 `peer_*` 工具对**所有** Desktop 会话可见，等于扩大了每个会话的能力面。
- `thread/resume` + `turn/start` 会与桌面争用 writer。
- 桥接端口与 token 文件属于新的本机攻击面（回环 + 同用户信任）。

更保守的替代：先建一个**独立测试 profile**（复制 desktop profile 的必要 bundle、改用独立 DSH home 与独立端口），在独立 home 中验证 D1–D4，再决定是否装入 `desktop` profile。这需要用户确认是否接受多一个 profile。

## 11. P2 协议事实（桌面内核自带 schema，只读，未投递）

用桌面内核 `0.169.0-alpha.11.1` 自带的 `app-server generate-json-schema` 导出协议 schema（输出在仓库外沙箱），核对 `toolOutput` 的真实形态：

| 事实 | 内容 | 证据 |
| --- | --- | --- |
| `toolOutput` 不是独立方法 | 它是 `turn/start` 的字段：`TurnStartParams.toolOutput: TurnToolOutput \| null` | 桌面内核生成的 schema |
| `TurnToolOutput` 结构 | `{ name: string, namespace?: string\|null, output: string \| content-items[], retain?: boolean }`，必填 `name` 与 `output` | 同上 |
| `turn/start` 的 `input` | 仍为必填；`UserInput` 变体只有 `text / image / audio / skill / mention`，**没有** tool-output 变体 | 同上 |
| 空 `input` 是否被接受 | **未知**，需在 P2 实测并记录 | — |
| 调用方来源标记 | `turnTrigger`：`Optional source classification for the caller that starts this turn` | 同上 |
| thread 上的相关字段 | `canAcceptDirectInput`、`attachedToThreadId`、`historyMode` | 实机 `thread/read` 返回字段名 |

**操作方修正后的计划请求**（`toolOutput` 与非空 `input` 不能同时使用；首测只用 `toolOutput`，并省略 `retain`/`namespace`/`turnTrigger` 等非必要字段，避免把兼容问题混进首个结果）：

```json
{"method":"turn/start","params":{
  "threadId":"<测试聊天，前缀 <test-id-1>>",
  "input":[],
  "toolOutput":{"name":"coworker_probe","output":"COWORKER-P2-MARKER: 固定程序生成载荷；不含任何用户文本"}
}}
```

schema 依据：`TurnStartParams.required = ["input","threadId"]`，`input` 是数组但**没有 `minItems`**，所以 `input: []` 在 schema 上合法；`TurnToolOutput` 只要求 `name` 与 `output`。这条请求**不含任何文本输入**，因此不构成“toolOutput + 非空 input 同时出现”。

身份处理：`clientInfo.name = "coworker-test-controller"`（与桌面 originator 不同），首测不带 `turnTrigger`。若该内核只有在 clientInfo 为桌面名时才把会话放进最近列表，这属于限制，将如实记录，而不是改身份绕过。

投递脚本：`<USER_HOME>\coworker-eval\sandbox\p2-tooloutput.mjs`，默认 dry-run，只有 `P2_CONFIRM=YES` 才发送；不重试、不回退为纯文本注入、不调用 `thread/start`。dry-run 输出已核对（见上表请求体）。

P2 需要记录的结果项，三项分开、不得合并成一句“成功”：

| 观测 | 判定方式 |
| --- | --- |
| 模型是否执行 | 是否出现 `turn/*` 或 `item/*` 通知（首测以实际通知为准） |
| 原聊天是否自动继续 | 是否出现 `turn/completed`，以及原聊天是否在**不需要用户追加提示**的情况下产生新回复 |
| 原窗口是否实时显示 | 由操作方在窗口内确认（脚本只记录“待确认”，不自证） |

另有：请求参数（脱敏）、响应类别（`ok` / `error` + code / `timeout` / `identity-mismatch`）、可获得的调用计数证据。失败时先报告准确类别，不自动退回文本注入、不重复投递、不创建替代 thread。

## 12. P2 第 1 次投递：失败（未产生 turn）

2026-11-18，操作方确认窗口对应关系后执行单次投递（脚本 `<USER_HOME>\coworker-eval\sandbox\p2-tooloutput.mjs`，`P2_CONFIRM=YES`）。

请求（与 §11 一致）：

```json
{"method":"turn/start","params":{"threadId":"<test-id-1>","input":[],"toolOutput":{"name":"coworker_probe","output":"COWORKER-P2-MARKER: ..."}}}
```

| 项目 | 结果 |
| --- | --- |
| `initialize` / `initialized` | 成功 |
| `thread/read`（同一实例、同一 ID） | 成功，`idMatches: true` |
| `turn/start` | **失败**：`code -32600`，`message: "thread not found: <test-id-2>"` |
| 返回的 `turn.id` | 无（未创建 turn） |
| 通知 | 仅 `remoteControl/status/changed`、`account/updated` |
| 模型是否执行 | **否**（没有 turn，也没有 `turn/*` 或 `item/*` 通知） |
| 原聊天是否自动继续 | **否** |
| 原窗口是否实时显示 | 由操作方确认；按上两项推断窗口不会有新内容 |

**同一实例里“能读不能投”**：`thread/read` 按磁盘读取成功，`turn/start` 却报 thread not found。schema 对 `thread/resume` 的说明给出解释——非运行中的 thread 必须先用 `thread_id` 从磁盘加载并 resume，之后才能挂 turn；两个候选的适配器也都是 `thread/resume` → `turn/start` 的顺序。第 1 次投递缺少 `thread/resume`。

顺带发现：协议还提供 `thread/injectItems {threadId, items[]}`——“Raw Responses API items to append to the thread's model-visible history”，即**追加模型可见条目而不启动 turn**。它可以作为“投递数据但不唤醒”的原语，但单靠自己不会让模型继续，因此不能替代 turn 语义。

**下一步（待授权，不自动执行）**：改用 `thread/resume {threadId}` → 再发同一条 `toolOutput` 请求（仍然只有 `turn/start` 一次投递、仍然 `input: []`、不带 `retain`/`turnTrigger`）。需要注意 `thread/resume` 会取得该 thread 的 writer，桌面侧可能出现“在其他位置打开”，这属于用户可见副作用，必须先说明再执行。失败类别按实际返回记录，不重试、不改用文本注入、不建替代 thread。

## 13. P2 第 2 次尝试：resume 被拒（active writer），按规则停止

操作方授权对该测试聊天执行一次 `thread/resume`，成功后投一次原定 `toolOutput`；resume 失败即停止。

| 步骤 | 结果 |
| --- | --- |
| `initialize` / `initialized` | 成功 |
| `thread/read`（同 ID） | 成功，`idMatches: true` |
| `thread/resume {threadId, excludeTurns: true}` | **失败**：`code -32600`，`message: "thread <test-id-2> already has an active writer"` |
| `turn/start` | **未执行**（按授权规则，resume 失败即停） |
| 是否创建 turn | 否 |
| 是否产生模型回复 | 否 |
| `thread/unsubscribe` | 未调用（未成功 attach，无可释放） |
| 通知 | 仅 `remoteControl/status/changed` |

### 这条错误的含义

桌面应用对该 thread 持有**独占 writer**。`thread/read` 走磁盘读取不受影响，但 `thread/resume`/`turn/start` 需要写权限，因此被拒。这不是 `toolOutput` 或参数形态的问题，而是**实例边界**问题：模式 B（外部独立 app-server + 共享 `~/.codex`）在桌面应用正持有该会话 writer 时无法接入。

对目标的影响：当用户**打开着**那条聊天时，外部控制器无法让原窗口自动继续——不是“实现细节没调好”，而是当前架构下的硬阻塞。候选 A 的 README 也承认会出现“在其他位置打开”的争用，其成功路径依赖桌面未持有 writer 的时刻。

### 尚未验证的分支（需操作方决定，不自动执行）

1. **关闭该聊天窗口但保持应用运行**，再试一次 `thread/resume`：若 writer 被释放，说明“桌面开着但该会话未打开”时可接入，可继续验证 D2/D3；若仍被拒，则外部接入不可行。
2. **改由桌面进程内的组件持有 writer**（DSH 侧插件或 Codex 侧扩展），这是 P3 的形态问题，不是本次协议探测能解决的。
3. `thread/injectItems` 是否同样受 writer 约束：未测试，预期相同（写路径）。

以上任一分支都需要新的授权，且仍然只针对该测试聊天、单次、不重发。

## 14. 受支持的外部入口调查（模式 B 写入探测已停止）

按操作方要求：停止模式 B 的写入探测，不再尝试 `thread/injectItems`，也不通过“关闭聊天”把原窗口实时通信记为通过。保留结论：**当前 Windows 桌面实例持有目标聊天 writer，独立 App Server 的 `thread/resume` 被拒（`-32600 already has an active writer`），该路径不满足“原窗口自动继续”的要求。**

本节只回答一个问题：Codex 桌面端是否存在**受支持**的外部消息接收与唤醒入口。判定标准：文档化接口（CLI/协议/schema）、可指定准确会话、不需要注入进程或抢 writer、能给出可复现证据。

| 入口 | 形态 | 本机可达性 | 能否写入既有桌面聊天 | 证据 |
| --- | --- | --- | --- | --- |
| `codex app-server --listen stdio://`（模式 B） | 独立 app-server 进程，JSON-RPC over stdio | 可达 | **否**：写路径被 writer 锁拒绝 | 实机（§12、§13） |
| `codex app-server --listen ws://IP:PORT` | 独立 app-server，WebSocket 监听 | CLI 支持；本机未启动 | 同模式 B（仍是另一个实例，受同一 writer 约束） | `--help` 显示 `--listen` 接受 `stdio:// / unix:// / unix://PATH / ws://IP:PORT / off`，并有 `--ws-auth`、`--ws-token-file`、`--ws-shared-secret-file`、`--ws-issuer`、`--ws-audience`、`--ws-max-clock-skew-seconds` |
| `codex app-server proxy --sock` | 转发到“正在运行的 app-server 控制 socket” | **不可达**：桌面实例无监听端点；`daemon` 仅 Unix | 不适用 | 实机（§4） |
| `codex remote-control {start,stop,pair}` | 受管 daemon + 配对码 | 受管 daemon 在 Windows 不支持（`daemon lifecycle is only supported on Unix platforms`） | 不适用 | 实机 + `--help` |
| `codex queue --thread <UUID> --message <TEXT>` | 写入本机队列库、按键为 thread_id 的 inbox | **CLI 可达**（用不存在的 UUID 探测返回 `thread/queue/add failed: … no rollout found`，即写路径存在且按 thread 定位） | **未验证**：是否被运行中的桌面应用消费未知 | 实机命令 + `queue_1.sqlite` 结构（`queued_items(thread_id, payload_json, queue_order …)`、`queued_thread_revisions`） |
| `codex mcp-server`（Codex 作为 MCP server） | 外部客户端调用 Codex 的工具 | 可达 | 否：这是反向的出站工具面，不能投递到既有聊天 | `--help` |
| 桌面调用的 MCP servers / 插件 / hooks | 桌面进程**出站**或**进程内**扩展点 | 不适用 | 否：不是入站通道；hooks 只在 Codex 内部生命周期触发 | `--help`、`docs/` 结构与任务书一致 |
| `codex exec-server --remote` | 云端环境执行服务 | 运行中（另一个进程）但面向 cloud environment | 否 | 实机进程命令行 |
| 文件级共享（`~/.codex/thread_history_1.sqlite`、rollout 文件） | 直接写存储 | 可写，但 | 会绕过 writer 锁与协议约束，属未支持用法，不采用 | 存储结构 + `thread-writer-locks/`（4 个锁文件） |

### 结论

- **没有找到**“受支持、能唤醒既有桌面聊天”的入站入口：桌面 app-server 绑定 Electron stdio，无控制 socket；受管的 daemon/remote-control 在 Windows 不支持；独立实例的写路径被 writer 锁拒绝。
- **唯一有希望的候选**是 `codex queue --thread <UUID> --message <TEXT>`：它是文档化 CLI，按 thread 定位、写本机队列库；但“运行中的桌面应用是否会消费该队列并唤醒原窗口”**没有证据**，且它只能投递文本，不是工具数据。
- 因此按**协议写路径**判断，当前双桌面目标受限：在不修改桌面程序、不注入进程、不抢 writer、不安装未确认扩展的前提下，“原窗口自动继续”无法成立。
- **后续更正（见 §15）**：`codex queue` 这条**原生信箱**路径不受 writer 锁约束，实测被桌面应用消费并触发原聊天新轮次；“无外部入口”的判断据此修正为“入口存在，但形态是信箱、且消息呈现为普通用户气泡”。

### 替代方案：控制器管理的 Codex 会话 + DSH

```text
DSH ──事件──> 控制器（自有 app-server，stdio 或 ws+token）
                 └─> 自有 Codex 会话（thread/start、turn/start、toolOutput）
                       └─> 结果回写 DSH 同一会话
```

- 满足：双向协作、关键事件持久化、DSH 侧事件驱动、结果可回读；
- 若只需“原聊天被唤醒”，`codex queue` 已能做到（见 §15），代价是消息呈现为人类消息而非工具数据；
- 不满足：用户既有聊天的自动继续与原窗口实时同步；
- 界面差异：会话出现在控制器自己的 app-server 实例下，桌面应用可能显示为“其他位置打开”或需要重新加载线程列表；若只有把 clientInfo 冒充成桌面 originator 才出现在最近列表，则如实记为限制，不采用冒充。
- 与现状关系：现有 SDK 工作流保持不变，此方案是**并行**模式，不替换也不迁移真实任务。

以上任何进一步实验（尤其是用 `codex queue` 对测试聊天做一次投递）都需要单独授权；本轮不执行。

## 15. 文本通道测试：`codex queue` 投递一次（2026-11-18）

授权范围：对已确认的专用测试聊天投递**一次** `codex queue` 文本消息；使用桌面内置内核 `0.169.0-alpha.11.1`；不改模型与权限；不重发。消息内容明确标注为程序生成的通信测试数据，只要求一句确认回复，未授权文件、工具或任何其他操作。

投递命令：`<desktop-kernel> queue --thread <test-id-1> --message "PROGRAM-GENERATED COMMUNICATION TEST … 只需一句确认"`

| 观测项 | 结果 | 证据 |
| --- | --- | --- |
| 队列是否接收 | **是**：退出码 0，返回 `Queued message <test-id-3> for thread <test-id-2>`；读 `queue_1.sqlite` 见 1 行（`queue_order 0`），`queued_thread_revisions` revision 90 | 实机 |
| 是否被自动消费 | **是**：约 **10.2 秒**后该行消失，revision 90 → 91 | 实机（只读轮询，未改库） |
| 是否产生模型回复 | **是**：随后只读 `thread/read {includeTurns: true}` 显示该 thread 共 2 个 turn，最后一个 `status: completed`，条目为 `userMessage` + `agentMessage`（回复 42 字符） | 实机（只读） |
| 原窗口是否同步 | **待操作方确认**（本次测试期间操作方未追加消息、未切换/重开该聊天） | 待确认 |
| 残留消息 | 无（最终 `queued_items` 0 行），未做任何数据库修改，也未使用非官方清理 | 实机 |

### 结论（本轮，不再扩展探测）

- `codex queue` 是**受支持的 CLI 入口**，且运行中的桌面应用**会消费**它：外部控制器可以在不注入进程、不抢 writer、不关闭聊天窗口的前提下，把一条消息送进既有桌面聊天并触发一次模型轮次。此前“Windows 桌面无外部入站入口”的判断据此**修正**为：入站入口存在，形态是**每会话的原生信箱**而不是 socket。
- 它投递的是**用户消息**，不是工具数据：DSH 侧事件会以 `userMessage` 出现在 Codex 聊天里。§9 中“来源必须明确是外部工具数据、不伪装人类指令”的要求**未满足**，这次通过的是文本通道，不是 `toolOutput` 语义。
- 自动唤醒（原轮次结束后由外部消息引发新轮次）在本机**已成立**；原窗口是否**实时**刷新仍由操作方观察，CLI 或存储层证据都不能替代。
- `thread/resume`/`turn/start` 的 writer 冲突依然存在；`codex queue` 走的是队列库，不进入该锁，所以两者不矛盾：写既有 thread 的“协议路径”被拒，“信箱路径”可用。

### 对后续形态的影响

若操作方确认窗口实时同步，则“Codex 原聊天自动继续”可以由受支持的 CLI 入口实现，代价是消息以用户消息呈现；若要在呈现上保持“外部工具数据”的语义，仍需进程内持有 writer 的方案（P3 形态），本轮不做。
