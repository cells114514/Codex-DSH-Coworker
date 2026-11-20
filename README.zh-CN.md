# Codex-DSH-Coworker

[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) | **简体中文**

Codex-DSH-Coworker 可以让 Codex 续接已有的 DSH Desktop 会话，并在 DSH 完成后通知原 Codex 聊天。回调就绪时，Codex 派发后可以结束当前轮，等通知再读取结果。

## 项目边界

connect-only MCP 注册名为 `dsh_agentlink`，连接由用户管理的 DSH Host。Desktop 启动、登录、权限和模型凭据由用户负责，审批需要人工确认。它不是 DSH Cordis bundle，请勿使用 `dsh plugin --profile ... add ...` 安装。

本项目基于 Fly2Kiana 的 [Codex-DSH-Orchestrator](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator)（基线提交 [428c69f](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/commit/428c69f)），其上游为 [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink)。原 MIT 许可及署名见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

## 快速上手

准备 Node.js 22+、npm、Git、Codex 和对应平台的官方 DeepSeek Harness Desktop。仓库放在固定工具目录，因为 setup 会记录绝对路径。

| Host 路径 | setup 选项 |
| --- | --- |
| Windows 或 macOS 官方 Desktop | `--gateway --desktop-auto --no-preset` |
| 已知 origin 的官方 Gateway | `--gateway --host <origin> --no-preset` |
| 旧 rc.6 Web Host 或 Windows 社区 Desktop | 参见[旧版配置](docs/manual-configuration.zh-CN.md#旧版-host) |

本仓库发布源码。Windows 实机已验证 Gateway 附着、同会话续接和单轮完成通知。可选 SDK 后端也支持完成通知，无需启动 Desktop。使用方法见 [Coworker 试用指南](docs/coworker-trial-runbook.md)，验证范围见[验收记录](docs/desktop-coworker-validation.md)。

### 推荐：复制给 Agent 的安装 Prompt

```text
从 https://github.com/cells114514/Codex-DSH-Coworker 安装到我批准的固定工具目录。
核对 Node.js 22+、npm、Git 和选定的源码版本，执行 npm ci、npm run check。
官方 Desktop 先预览：
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run

报告 MCP、Skill 目标及冲突。跨项目使用时选择一个用户级 Skill 位置；
只在仓库使用时保留 .agents/skills/codex-dsh-orchestrator。
已装在旧全局位置的 Skill 原地更新。使用 --replace 或 --replace-skill 前先问我。
只安装审阅后的目标，保留备份；部分成功时报告实际状态。

准备阶段保持我的应用和任务运行。授权交接前，说明哪些应用将启动或重启，等我批准空窗。
启动授权只经私有进程管道传递，不打印、不保存，也不要向我索要 provider API key。

我重启后，核对 MCP 和 Skill 加载，再做仅连接验收。
模型调用另行审批。分别报告安装、连接和真实任务结果。
```

### 手动配置与验收

每台电脑使用独立 clone：

```sh
git clone https://github.com/cells114514/Codex-DSH-Coworker.git
cd Codex-DSH-Coworker
npm ci
npm run check
```

Windows 和 macOS 官方 Desktop 使用同一组参数，先预览：

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run
```

默认 Skill 位置是当前 checkout 的 `.agents/skills/codex-dsh-orchestrator/`。如需在任何项目中调用，在预览和安装命令中都加上 `--skill-path "$HOME/.agents/skills/codex-dsh-orchestrator"`。已有的 `~/.codex/skills` 安装可以继续使用原位置，显式指定该位置更新，避免出现同名双份 Skill。目录规则参见 [Codex Skill 官方文档](https://learn.chatgpt.com/docs/build-skills)。

确认目标后，去掉 `--dry-run` 正式安装：

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset
```

setup 注册 bridge，为审批保留 `approval_mode = "prompt"`，并复制 `SKILL.md` 和 `agents/openai.yaml`。MCP 与 Skill 内容冲突分别需要 `--replace`、`--replace-skill`；先检查冲突再替换。`--no-skill` 跳过 Skill 安装。替换成功时会产生备份；若只完成其中一部分，先核对状态再重试。

官方 Gateway 通过私有内存管道把 Desktop 启动授权交给新启动的 Codex。**这一步会启动 Desktop 和 Codex，执行前需要先正常退出两个应用。请先结束当前工作，再按 [Win/Mac 启动步骤](docs/official-desktop-gateway.md#operator-startup)操作。**使用期间保持该终端运行。

受控启动后，通过 `/mcp` 或设置确认 `dsh_agentlink`，用 `/skills` 或 `$codex-dsh-orchestrator` 确认 Skill。随后仅调用 `dsh_host_status` 检查连接，不创建任务、不调用模型。该调用会按需交换授权、建立 Gateway API Peer；doctor 则有意将这一步报告为 `not_probed`。

### 换机与回滚

换电脑请重新 clone。单个 linked worktree 的 `.git` 指向原始 clone，不能直接当作独立安装复制。

将 `DSH_BRIDGE_HOME` 放在可靠的本地磁盘。遵守同一协作锁协议的兼容进程可以共用；独立管理或不兼容的 build 使用不同 home。新 home 的 mapping、cursor 和 claim 从头开始，DSH 对话历史仍由 Host 保留。

升级时保留旧 checkout、配置和已安装 Skill 的备份。回滚前先检查后续配置改动，只恢复目标 MCP 与 Skill，再在约定空窗重启调用方。锁恢复及 Windows 文件权限限制见[已知问题](KNOWN_ISSUES.md)。

## SDK 后端（可选）

委派也可以不启动 DSH Desktop 或 Gateway 启动器。`DSH_HOST_PROTOCOL=sdk` 选择可选的 `sdk` 后端，即 `legacy`（默认）与 `gateway` 之外第三个后端。它通过 stdio JSON-RPC 驱动官方 DeepSeek Harness TypeScript SDK runtime，每个 root 任务使用一个 runtime 进程。它永不成为默认值，Host 支撑的后端保持现有行为与数据，SDK 失败也不会自动切换到其他后端。

```sh
npm run setup -- --backend sdk --yes --no-preset --dry-run
```

审阅打印的 JSON 预览，然后去掉 `--dry-run` 重跑同一命令。该后端不支持 agent preset，请省略 `--preset`（或传 `--no-preset`）；`--host-url`、`--host`、`--desktop-auto` 和 `--gateway` 与 `--backend sdk` 一起使用会被拒绝。完整的安装、生命周期与回滚说明见 [SDK 后端](docs/sdk-backend.zh-CN.md)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_HOST_PROTOCOL=sdk` | `legacy` | 显式启用 |
| `DSH_HOME` | `~/.dsh` | SDK 持久化、profile 与凭据 |
| `DSH_SDK_PROFILE` | `sdk` | 自定义 profile 必须仍然提供 SDK server；安装器无法验证 |
| `DSH_SDK_BIN` | 未设置（使用依赖中同版本的 `@deepseek-ai/dsh`） | `dsh` CLI 模块路径，按词法解析；绝不是命令行；支持带空格的 Windows 路径 |
| `DSH_SDK_PROVIDER`、`DSH_SDK_MODEL` | 未设置（runtime 默认 `deepseek-official` / `deepseek-v4-flash`） | 必须同时设置或同时省略；runtime 在初始化时校验该精确路由 |
| `DSH_SDK_REASONING_EFFORT` | 未设置 | 需要 provider 与 model；由 runtime 校验 |
| `DSH_SDK_MAX_RUNTIMES` | `2` | 并发 runtime 硬上限 |
| `DSH_SDK_IDLE_TIMEOUT_MS` | `600000` | `0` 关闭空闲回收 |
| `DSH_SDK_INITIALIZE_TIMEOUT_MS` | `60000` | 握手时限 |
| `DSH_SDK_SHUTDOWN_TIMEOUT_MS` | `10000` | 有界关闭时限 |
| `DSH_APPROVAL_TIMEOUT_MS` | `300000` | 待处理审批/问题到期时间；只取消，从不授予 |
| `DSH_BRIDGE_HOME` | `sdk` 为 `<DSH_HOME>/codex-bridge-sdk`；`legacy`/`gateway` 为 `<DSH_HOME>/codex-bridge` | 不同状态根，从不自动改指向 |

此后端从不读取、也不校验 Host URL、connect token 变量和 Desktop 发现。凭据来自 DSH home 自身的原生配置与凭据存储；bridge 从不读取、复制或写入这些凭据，生成的配置中不含任何模型 API key。每个 root 任务在第一个 prompt 时按需启动一个 runtime——不在 MCP 启动时、也不因读取而启动——受并发上限约束，仅回收既空闲又无未回答交互的 runtime，并在退出时由 bridge 关闭。只有记录为干净关闭之后，按精确会话 ID 才能恢复。

能力差异是设计选择：发现由 bridge 自有，历史是 bridge 自己的观察缓存而非 DSH 历史，provider/model 路由在初始化时固定。没有模型目录与切换、没有 steering、没有 turn 或队列取消、没有子 Agent 列表；恢复的会话只恢复模型上下文，观察缺口会阻止正常 follow-up，协议也无法传递客户端时区（`clientTimeZoneApplied: false`）。一次性审批与原生用户问题受支持。`node dist/doctor.js` 静态报告此后端，`node dist/doctor.js --probe-sdk` 执行一次有界握手并披露副作用。回滚时把 `DSH_HOST_PROTOCOL` 改回 `gateway` 或 `legacy`，并恢复该后端自己的 bridge home；SDK 数据原样留在磁盘。每一项限制背后的证据见 [SDK 资质](docs/sdk-qualification.md)。

## 给 AI Agents

读取聚焦的安装、验证文档和所需的非敏感配置，保留无关 MCP、Skill。准备工作不包含替换安装、关闭应用或调用模型的授权。

报告源码版本、构建结果、MCP/Skill 安装位置、调用方重载和连接结果。公开报告不包含凭据、真实会话标识及个人路径。应用空窗、DSH 审批和发布由用户批准。

## 使用方式

在已加载 bridge 和 Skill 的项目中说：

> 请委派给 DSH 完成这个有明确范围的任务，按当前项目状态交接，并由 Codex 审阅结果。

可用 `$codex-dsh-orchestrator` 显式调用，也可使用自然语言委派。Skill 根据进度、Git 状态、重点文件、测试和限制组织 compact handoff，让 DSH 先读重点文件。Bridge 不会自动取得此前的调用方对话。

同一已知任务使用 `dsh_followup`。跨 Codex 对话接续时，先由仅元数据 `dsh_find_sessions` 找到精确 canonical 工作区内唯一 mapped、idle root，再以新鲜 title/cwd/update 前置条件执行 `dsh_attach_session`。标题或措辞相似不足以决定复用。保留上下文能减少重复读取，也可能增加输入 token；Host 没有文档化用量遥测时，provider cache 证据保持 `not_exposed`。

## 模型路由

委派和 follow-up 共用显式启用、保留兼容的模型路由。

| 请求 | 行为 |
| --- | --- |
| 省略路由或使用 `inherit` | 验证当前会话路由，不写入模型选择 |
| `flash` / `pro` | 在当前账号/API Key provider 内选择目录实际提供的官方模型 |
| `reasoningEffort` | 要求目录明确支持该等级 |
| 低复杂度视觉任务 | `visualIntent="required"`、`complexity="low"`，有可信图片能力证据时才选择官方 Flash Vision |
| 高复杂度视觉任务 | 由用户在 `official-flash-vision` 与 `modlens-pro` 中选择 |

Flash 兼容 `deepseek-flash` 与旧 `deepseek-v4-flash`；Pro 使用 `deepseek-v4-pro`。Pro 不可用时拒绝继续，账号与 API Key provider 保持分离。选择后 bridge 会重读目录验证。选择保存为全局默认值时，委派和 follow-up 返回 `modelRouting.persistsAsDshDefault=true`；即使验证失败、尚未发出 prompt，这个副作用也可能已经发生。

官方 rc.3 会话目录省略图片模态信息，因此仅凭 Vision 名称不能启用原生视觉。ModLens Flash 只在获批视觉路由耗尽符合条件的有界重试后尝试一次；无效输入、模型缺失、权限和配置错误不触发备用切换。prompt 写入不自动重试。省略视觉策略字段时，显式旧式 `modlens-flash` 仍保留兼容。

自动测试已覆盖路由策略；当前原生视觉、ModLens 及备用 provider 执行仍待真实验证。具体能力限制和旧 Code Mode 交接见 [Gateway 说明](docs/official-desktop-gateway.md#models-and-capabilities)。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `dsh_host_status` | 连接状态和能力 |
| `dsh_find_sessions` | 有界 root 会话元数据发现 |
| `dsh_attach_session` | 以新鲜前置条件接管精确空闲 root |
| `dsh_delegate` | 创建 root 并排入初始 prompt |
| `dsh_followup` / `dsh_continue` | 在同一 root 排队或 steer |
| `dsh_status` | 执行、待交互项、最终回复与 claim |
| `dsh_tail` | 有界事件摘要和后续 cursor |
| `dsh_wait` / `dsh_observe` | 单次最多 30 秒的有界观察 |
| `dsh_cancel` | 取消当前 turn 或已观察到的队列项 |
| `dsh_list` | 映射任务列表 |
| `dsh_answer_question` | 回答类型化待答问题 |
| `dsh_resolve_approval` | 经人工批准的 `allow_once` 或拒绝 |
| `dsh_release_workspace` | 释放协作 claim，保留 DSH 会话 |

操作前保留最新 cursor/revision。单次等待结束后继续观察，直到真实终态或需要人工处理。Workspace claim 协调 bridge 用户，不执行 DSH 文件系统权限限制。

## 调用方支持

Codex 使用上述 canonical Skill 与 setup。Claude Code 保留项目级安装器：

```sh
npm run setup:claude -- --yes --project /absolute/path/to/project
```

该安装器配置 legacy 集成，新官方 Gateway 尚无近期 Claude Code 真实验收。ZCode、OpenCode、Workbuddy 和 Claude Desktop 暂缓，见[延期路线图](docs/deferred-roadmap.zh-CN.md)。

## 项目组成

- `src/`：共享 MCP runtime 与 setup。
- `skill/codex-dsh-orchestrator/`：canonical Codex Skill，修改此源文件而非安装副本。
- `skill/codex-dsh/`、`skill/claude-code-dsh/`：兼容 Skill。
- `test/`：模拟 Host、协议、持久化与安装回归。
- [项目总览](docs/project-overview.zh-CN.md)、[架构](docs/architecture.zh-CN.md)、[验证](docs/validation.md)、[手动配置](docs/manual-configuration.zh-CN.md)、[SDK 后端](docs/sdk-backend.zh-CN.md)、[发布清单](docs/release-checklist.md)、[贡献](CONTRIBUTING.md)及[安全](SECURITY.md)。

## 相关项目

| 项目 | 关系 |
| --- | --- |
| [DeepSeek Harness](https://www.deepseek.com/harness/en/) / [源码](https://github.com/deepseek-ai/deepseek-harness) | 官方 Desktop 与 Host runtime |
| [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop) | 社区客户端，保留 Windows legacy 自动发现 |
| [ModLens](https://github.com/liustack/modlens) | 可选视觉插件。本项目不维护 ModLens，也不与其存在隶属关系 |
| [Model Context Protocol](https://modelcontextprotocol.io/) | 调用方与 bridge 之间的协议 |
| [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) | 上游 MIT 源码与兼容沿革 |

## 许可证

[MIT](LICENSE)。升级共享 bridge home 前请阅读[已知问题](KNOWN_ISSUES.md)。
