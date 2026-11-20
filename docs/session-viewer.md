# SDK 会话记录面板（只读）

浏览桥接器观察到的 SDK 会话，不必让 Codex 反复读日志。**只读**：没有写接口、不调用模型、不消耗 Codex 额度。

## 1. 先核实的前提：Desktop 是否支持自定义页面

已核对本机 `DeepSeek Harness` 桌面端（`0.2.1-rc.2`，Electron）：

- 安装包内只有 `lib/`（主进程）、`renderer/`（强制更新页、更新对话框等固定页面）、`runtime/`、`dsh/`（运行时）；
- `renderer` 中出现的注入点是 `window.dshMandatoryUpdate`、`window.dshUpdateDialog`，均属更新流程；
- **未发现**任何 `registerPage` / `registerPanel` / `contributes.views` / 插件页面清单之类的扩展入口，也没有插件 UI 文档。

结论：**该版本没有可验证的自定义面板/页面扩展接口**。因此首版按你的备选方案做成**本地只读网页查看器**，后续若能拿到受支持的 UI 扩展点，再把同一份数据层接进桌面。

## 2. 启动

```powershell
node <仓库根>\tools\session-viewer.mjs --bridge-home "%USERPROFILE%\.dsh-sdk-test\codex-bridge-sdk" --port 7317 --open
```

- `--bridge-home` 或环境变量 `DSH_BRIDGE_HOME`（二选一，必填）；
- `--port` 默认 `7317`，只监听 `127.0.0.1`；
- `--open` 用默认浏览器打开；
- 页面无写入控件，服务对非 `GET` 一律返回 405。

## 3. 展示内容

| 区域 | 来源 | 说明 |
| --- | --- | --- |
| 任务列表 | `tasks\<taskId>.json` + `runtimes\<taskId>.json` | taskId、SDK sessionId、工作目录、cleanShutdown、runtimePid |
| 通知状态 | `coworker\<taskId>.json` + `coworker-outbox\*.json` | 是否绑定聊天、待发送/已确认、`delivery_unknown` 标记 |
| 完整性 | `observed\<taskId>\coverage.json` | `coverageComplete=false` 时显示“观察缺口”，明确提示历史可能不完整 |
| 对话视图 | `observed\<taskId>\events.jsonl` | **解析后按对话展示**：用户输入右对齐、助手回复左对齐；推理与工具调用折叠可展开；轮次开始/结束作分隔行；技术事件（权限、沙箱、请求头等）默认隐藏，可用顶部复选框打开；需要时可勾选「显示原始 JSON」逐条查看 |

## 4. 接口

| 路径 | 说明 |
| --- | --- |
| `GET /` | 页面本体 |
| `GET /api/tasks` | 任务列表（含通知与完整性） |
| `GET /api/task/<taskId>/events?since=N` | 从第 N 条起的事件尾巴、解析后的 `items`（`kind`/`title`/`text`/`meta`）与 `nextCursor` |

`items[].kind` 取值：`user`、`assistant`、`reasoning`、`tool`、`status`、`noise`（技术事件）、`warning`（无法解析的行）、`other`。
文本只从协议里的文本块提取；没有文本的事件不会退化成 JSON 堆砌，而是作为技术事件隐藏。

`taskId` 必须匹配 `^dsh_[a-z0-9]+$`；服务端对每个拼接后的路径做前缀校验，**只能读取 bridge home 内部**，目录穿越返回 400。

## 5. 边界

- 这是**桥接观察记录的展示**，不是 Desktop 原生会话，也不保证与 Desktop 同时操作同一会话；
- `observed` 可能缺少恢复前的历史，界面用“观察缺口”标注，不宣称完整聊天记录；
- 只读首版**不提供**续接、审批等写操作；这些必须继续走现有 Bridge（`dsh_followup` / `dsh_resolve_approval`），避免插件与 Codex 同时控制 runtime。

## 6. 自检

```powershell
node --import tsx --test test/session-viewer.test.ts
```

覆盖：任务列表字段、事件增量、完整性标记、非法 taskId 拒绝、非 GET 405、页面无提交表单。
