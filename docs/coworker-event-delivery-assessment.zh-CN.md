# Coworker 事件交付改造：复用项目核实与实施边界

记录日期：2026-11-18。性质：源码调查与本机只读探测，不是自动唤醒实机验收。本轮未安装第三方编排器、未变更正式 MCP 配置、未提交新模型输入。

## 目标

用户希望 DSH 与 Codex 作为有独立上下文和生命周期的协作方：Codex 提交工作后可结束当前轮次，DSH 独立执行；完成、失败、需要判断时才向原 Codex 聊天投递消息。Codex 可把审阅反馈发回原 DSH task/session。普通进度不触发模型。

现有 dsh_watch 是缓解措施：它过滤普通日志、减少响应体，但每个等待窗口仍会返回到 Codex。它不等于后台回调或已结束轮次的自动唤醒。

## 已核对的复用来源

### dsh-subagent-mcp：优先研究完成回调

仓库：[dqtz5vpvj9-create/dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp)。本次目录快照 HEAD 为 `8ee8a8152e4f7fa1d805bb40e8f1a10fecceabd4`；许可证 MIT，复用需保留声明。

当前源码并不只是存储信箱。`src/notify.mjs` 启动独立监听进程，等待任务结果、先保存结果，再调用回调；`src/codex-callback.mjs` 使用精确 threadId，通过 `turn/start.toolOutput` 交付完成结果；`src/codex-transport.mjs` 的 Windows 分支通过 `codex app-server proxy` 建立通道。

它还区分确认前失败与投递结果不确定，不在可能已投递后自动换通道重发。这些机制值得复用，但不能直接套用它自己的 dsh_wait、状态目录和运行时管理替换本项目。

作者的 [验证记录](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/docs/codex-callback-validation.md) 声明测试了 CLI 0.157.1 / App Server 0.157.0 下的活动轮次及空闲父会话。原始 rollout 未随包公开；这是作者环境的证据，不能当成本机桌面版验收。

### open-agent-bridge：参考双向消息，原会话路由不能直接照搬

仓库：[kevinArgueta96/open-agent-bridge](https://github.com/kevinArgueta96/open-agent-bridge)。本次目录快照 HEAD 为 `c117ae93a8d3a86633fb2fd6d8f3365d44463ac8`；许可证 MIT。

可参考消息关联、持久化、ACK 和双向 reply。当前 `src/client/codex-daemon-socket.ts` 原生交付走 Unix socket，并按 cwd 和时间接近程度挑选已加载 thread；源码也提及恢复旧会话时的歧义。不能把这种选择策略用于必须回到原聊天的本项目。

其独立 App Server bridge 可以拥有另一条 thread，但另一条 thread 的成功运行不等于用户原桌面聊天被唤醒。任何备用路径都不能静默改变目标聊天。

### 其他候选

- [dsh-agent-relay](https://github.com/Noelune/dsh-agent-relay)：可以研究 DSH 工具接入、消息租约/确认和按需启动工作进程；启动一个接收程序不等于唤醒原 Codex 桌面聊天。
- [CCCC](https://github.com/ChesterRa/CCCC)：当前 README 已包含 DeepSeek Harness developer preview，附件中“没有 DSH 原生运行时”的结论需要更新。但连接已有会话的说明仍把原生 Windows 验收列为待验证；整体团队工作台也比本次所需范围更大。

这些是复用方向，不是已在本机安装验证通过的替代品。

## 官方协议与本机证据

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 描述了 `thread/read`、`thread/resume` 和 `turn/start.toolOutput`。后者可以把结果保持为工具数据，而不是伪装成用户指令。协议存在不代表桌面应用一定开放候选程序所需的控制通道。

本机只读结果：

| 对象 | 观测 |
| --- | --- |
| PATH 上的 CLI | 0.153.4 |
| Windows 桌面应用 | 26.1111.2228.0 |
| 桌面应用自带 Codex 内核 | 0.169.0-alpha.11.1 |
| 当前运行环境 | 提供父聊天标识；未在报告中公开其值 |
| CLI 命令存在性 | app-server proxy 的 help 可读取 |
| 通过桌面内核 proxy 连接当前父聊天 | 传输阶段失败，未完成 thread/read |
| 模型输入及唤醒 | 未发送、未验证 |

因此当前阻塞是“现有桌面实例的控制通道能否被可靠访问”。版本号较新、命令存在和项目声称支持 Windows，都不能替代这项验证。失败也不能单独证明所有桌面回调方式均不可行。

## 推荐架构

保留当前 SDK 后端、OpenCode Go 路由、task/session 映射、工作区协调和现有数据。增加独立的任务运行服务与事件投递层；不要切回 Gateway 作为这次改造的前提。

```text
Codex 聊天 ──派发 / 审阅反馈──> MCP 前端 ──> 常驻任务服务 ──> DSH SDK
    ↑                                            │
    └──精确原聊天回调── 投递适配器 <── 持久 outbox <─┘
```

需要处理的消息至少包括完成、失败、问题、回答、审阅反馈；普通进度只在程序内记录。权限升级保留用户审批，不将 DSH 的消息解释成用户授权。

关键要求：

1. 持久记录 taskId、DSH sessionId、精确 Codex threadId 及控制端点归属；不按标题、cwd 或最近时间猜接收方。
2. MCP 前端关闭或调用轮次结束不能直接终止独立服务拥有的任务；明确区分聊天结束、客户端退出、机器关机三种状态。
3. 完成结果先持久化再投递。每次工作分配有独立 executionId；上一轮已完成不能被误认为新一轮结果。
4. ACK 丢失时记录 delivery_unknown，不能声称 exactly-once，也不能自动重新启动验收轮次。程序重启后的去重和恢复需要单独设计。
5. 注册完成回调之前完成可达性检查；不具备自动回调时明确报告“结果将保留，需手动回来”，不能悄悄改回模型轮询。
6. 问题通过有界交互处理器保留请求身份、到期和取消语义；恢复后的旧问题不能由迟到回答授权。
7. 问题/反馈消息设置预算、循环次数和终止规则，避免两个 Agent 自动互问形成新的额度消耗。
8. SDK 回调不等于暂停、取消接口。不要以消息总线掩盖当前 Runtime 中断能力的限制。

## 实施次序及验收门槛

先做 G0：用本机桌面实例完成初始化及精确 thread/read，只读验证、不创建替代聊天、不升级 CLI、不触发模型。记录端点的来源和实际内核身份，不能扫描并猜测其他聊天。

G0 通过后，在单独测试聊天里验证一次小型 toolOutput 回调：Codex 结束当前轮次后仍能在原 thread 被唤醒；原聊天 UI 能显示结果；两条相同 cwd 的聊天不会串线。这一步会启动模型，需按用户授权范围运行。

上述验证通过，才接入后台 DSH 服务与持久 outbox，再做双向问题/回答。先用程序生成的结果测试，不消耗 DSH 模型调用；最后才做短 DSH 任务验收。

验收必须同时满足：等待期间没有 Codex 模型调用；重要事件自动投到精确原聊天；没有改变 provider 或审批权限；完成结果先保存；失败不丢结果；取消后不自动继续；客户端/服务重启不重复提交任务。不能只以“收到通知”或“另一个 Codex thread 有回复”作为通过。

工作量只能给条件估算：控制通道 POC 1–3 人日；若该通道通过，稳健的完成回调加服务生命周期解耦约 5–10 人日；双向消息和故障恢复再约 5–10 人日。前提不成立则应重新选型，不能承诺几天内改完。

本轮只新增调查文档。没有安装候选项目、修改现有 SDK 配置、启动 Codex 模型轮次或替换任务管理器。
