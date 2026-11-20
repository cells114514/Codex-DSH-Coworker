# Codex-DSH-Orchestrator architecture and safety model

**English** | [简体中文](architecture.zh-CN.md)

This document describes shared coordination semantics and the legacy rc.6 RPC path. The official Windows/macOS adapter's authentication, discovery, queue mapping and capability differences are in [Official Desktop Gateway](official-desktop-gateway.md). Apply protocol-specific details to the selected adapter.

An optional third backend, selected only with `DSH_HOST_PROTOCOL=sdk`, runs a DSH SDK runtime over stdio instead of talking to a Host. It is never the default and never an automatic fallback; it is described under [SDK backend](#sdk-backend), with evidence in [SDK backend qualification](sdk-qualification.md) and operator setup in [SDK backend](sdk-backend.md).

## Positioning and Host lifecycle

Codex-DSH-Orchestrator is a caller-side orchestration project, not a DSH Cordis bundle. A supported caller such as Codex or Claude Code starts the dsh-Agentlink-derived bridge runtime as a local STDIO MCP server; the bridge connects to an independently running official DSH Web Host.

The bridge is connect-only. It does not start, daemonize, stop, or own `dsh web`, and it has no Host pidfile or port lock. The user or an OS service owns the Host lifecycle. This keeps DSH sessions visible through the official Web UI after an individual caller's MCP process exits.

These rules describe the Host-backed (`legacy` and `gateway`) backends. The optional SDK backend has no Host at all: it starts and owns its own runtime processes, reported as `lifecycleOwnership="bridge-managed-runtime"`. See [SDK backend](#sdk-backend).

## Identity and state model

A BridgeTask, a DSH root session, and a DSH turn are different objects:

- One BridgeTask has one stable `taskId -> rootSessionId` identity mapping.
- The root session can run many turns; `turn_completed` does not remove the task or prevent another follow-up.
- Session-backed DSH subagent descendants are discovered from `session.list`/`subagent.list`, reconciled independently, and retain `parentSessionId` plus `origin="subagent"` in the task ledger.

Status does not collapse connectivity and execution into one enum:

- `availability`: `connected | host_unreachable | session_not_found`
- `execution`: `starting | running | awaiting_approval | awaiting_input | turn_completed | failed | canceled | interrupted`
- Public `status` is `unknown` when availability overrides the current execution observation, while `lastKnownExecutionStatus` is retained.

Queue depth is derived from the latest complete `session/queue` snapshot:

- `nextTurn`: `placement="queued"`
- `steering`: `placement="steering"`
- `context`: `placement="context"`
- `nextStep`: steering plus context
- `total`: all pending items

Queue state is marked stale or unknown as soon as `events.mux` disconnects.

## Event ledger and recovery

DSH session/history is the only source of truth for conversation content. The bridge does not copy prompts, user or assistant text, tool arguments/results, or question bodies into its files. It persists only coordination state in three separate stores:

1. `tasks/<taskId>.json` contains only `{taskId, sessionId}`.
2. `claims/<taskId>.json` contains the canonical cwd, task/session owner, claim mode, and creation time.
3. `ledgers/<taskId>/events.jsonl` is a rebuildable coordination index for task cursors, lineage, source watermarks, non-content execution/pending state, issued rpcIds, and final-message pointers.

Each JSONL record has a monotonic task `cursor`/`mergeIndex`, `sourceSessionId`, optional `sourceSeq`, optional `parentSessionId`, `origin`, event type, and a scrubbed `coordination` object. It never contains the full mux/history envelope. `mergeIndex` is bridge observation and persistence order, not a DSH global causal order.

Task-ledger appends and workspace-claim changes use task/registry-scoped inter-process locks. A writer rereads current disk state while holding the lock before allocating a cursor or changing a claim. Immutable task mappings use atomic temp-file plus hard-link creation. Bridge processes sharing one `DSH_BRIDGE_HOME` therefore share coordination state and must point to the same Host. Use a separate bridge home when changing Host origins. Lock critical sections are short and local-filesystem only; automatic stale-lock reaping is deliberately disabled because PID/mtime observation cannot be atomically coupled to a destructive rename. A hard-killed writer can leave a fail-closed lock that requires explicit operator recovery.

Recovery is subscribe-first:

1. Open `events.mux` and buffer live frames.
2. Read each `session/subscribed.lastSeq` watermark, or use the open stream as the fence for cold sessions.
3. Page `session.history`/`subagent.history` backwards to the persisted per-session high-watermark.
4. Sort and deterministically deduplicate durable events by `(sourceSessionId, sourceSeq)`.
5. Drain buffered live frames, then expose the committed task cursor.

rc.6 ignores `events.mux.since`; it is not a durable backlog. Delivery is documented as **at-least-once with deterministic dedupe**, never exactly-once. A gap that cannot be reconstructed is returned as `unrecoverable_gap`; an obsolete cursor is `cursor_expired` with `earliestCursor`. The bridge does not silently skip either condition.

`dsh_tail` returns bounded digests and `nextCursor`. While the Host is connected, it resolves source pointers from `session.history` at call time: assistant chunks are omitted or compacted, tool output is reduced, and questions, approvals, errors, turn outcomes, and the final assistant message remain complete in the response only. When the Host is unavailable, it returns `contentUnavailable` instead of reconstructing conversation text from a bridge copy.

At each root `turn/end`, the ledger folds only the last user-visible `assistant/message` pointer (`sessionId + seq`); `dsh_status` resolves that pointer from live history. A terminal turn with no pointer reports `terminal_missing_final`, not successful empty output.

The event pump runs even when no caller is tailing. After bridge restart, it rebuilds coordination folds from JSONL and reconciles them against authoritative DSH history. It never rebuilds content from bridge files.

## Questions and approvals

`dsh_followup` cannot answer a pending DSH interaction. The bridge continuously consumes `events.mux` and keeps a per-rpcId pending map in memory. While connected, current requested frames are returned verbatim in `dsh_status` and `dsh_tail`; question text is never persisted.

On reconnect, rc.6 replays still-pending requests with stable rpcIds. After the mux baseline quiet period, absent prior requests receive coordination tombstones so they cannot silently revive; a later valid replay reopens the item. This is an explicit rc.6 heuristic capability, not a Host transaction.

Only typed response tools are public:

- `dsh_answer_question(taskId, requestId, answers[])`
- `dsh_resolve_approval(taskId, requestId, outcome="allow_once"|"reject")`

They validate the rpcId type, task/session lineage, question ids, order, and options, then issue exactly one non-retried `POST /api/respond` client response. The Host carrier receipt is authoritative: `bad-response` keeps the item pending; `not-pending` means it was already answered, canceled, raced, or expired.

Safety rules:

- The bridge never automatically allows an approval.
- Every `approval/requested` is treated as a DSH sandbox escalation.
- `allow_once` maps only to wire outcome `allowed-once`; it is not a persistent policy change.
- A configured timeout is only one best-effort reject while this process and connection are alive. It is not a Host-level guarantee.
- For unattended fail-closed operation, configure DSH approval policy `never`; absence of an answerer remains fail-closed.
- Questions are shown verbatim and are never automatically answered on the user's behalf, especially for credentials, publishing, releases, or other sensitive actions.

## Follow-up and cancellation semantics

`dsh_followup(mode="queue")` targets DSH `next-turn`; `mode="steer"` targets `next-step`. Queue can start a later turn after the current turn ends. Steer enters the active turn at the next step. Follow-up may optionally select the same semantic model profiles and catalog-supported reasoning effort as delegation. Selection is written and re-read before the prompt; verification failure sends no prompt, while an attempted `session.selectModel` may already have persisted as the DSH global default. Omitting route fields inherits the current route. The prompt write is never automatically retried; the only bounded retry is the visual-required route selection/verification stage described under Visual routing.

Every session mutation performs a fresh `session.list`/history reconciliation first. Follow-up also reads live `session.models` and reports the actual current route. Mutation tools accept optional `sinceCursor` and `expectedRevision`. If the reconciled view differs, the bridge returns `stale_view` with the observed changes instead of issuing the write.

The unary rpcId generated for each bridge prompt is retained as coordination metadata. A matching `user/message.data.source.rpcId` is marked `initiatedBy="bridge"`; unmatched messages are `external_or_unknown`. This is a freshness check, not a transaction: DSH Web can still race between preflight and the write.

`dsh_cancel(scope="turn")` calls rc.6 `session.cancel`. It cancels only the active root turn with queued inbox work preserved. Built-in foreground shell tools use cooperative abort and escalate the foreground process group from SIGTERM to SIGKILL after about three seconds, but:

- `run_in_background` jobs are not killed by that turn signal and require DSH `job_kill`.
- Third-party tools are cancellable only when they honor `AbortSignal`.

`dsh_cancel(scope="queue")` consumes the current mux queue snapshot and issues one `session.updateQueue(remove)` per item id. It is non-atomic. The result separates `requested`, `removed`, `alreadyClaimed`, and `failed`; it never promises all-or-nothing queue clearing.

## Visual routing

Visual work is caller-declared: `visualIntent="required"` with `complexity="low"|"high"`. Low complexity selects the official native Flash Vision (`deepseek-official/deepseek-v4-flash-vision-exp`). High complexity requires an explicit user choice between `official-flash-vision` and `modlens-pro`; without one the operation fails closed with `user_choice_required` before any session, selection, or prompt. `modlens-flash` is never a first choice.

The approved visual route's selection/verification stage (`session.models` read, `session.selectModel`, re-read verification) may be retried a bounded number of times, but only while every failed attempt is an explicitly classified force-majeure failure: timeout, unreachable Host, or HTTP 5xx. HTTP 400/422 classify as invalid input, HTTP 404 as a missing model, HTTP 401/403 and RPC permission/credential codes as policy denial, and non-JSON or invalid-envelope responses as configuration/protocol errors; none of those ever triggers a retry or the fallback. After the bounded retries are exhausted with force-majeure failures only, the bridge attempts ModLens Flash exactly once. A failed fallback fails closed and reports its own failure classification; it is never disguised as success, and no other non-idempotent write (`session.create`, prompt/follow-up, cancel, queue mutation, `/api/respond`) is ever retried. Any selection write may already have persisted as the DSH global default, and that side effect stays disclosed.

When the fallback succeeds, the bridge records a minimal non-sensitive coordination marker in the event ledger (profile ids, attempt count, failure class, and a short notice — never prompt text, image paths, credentials, history, or error bodies) and exposes it through `dsh_status.visualFallback`; the caller tells the user briefly at task end with the provided notice.

## Workspace coordination

`dsh_delegate` resolves the requested cwd through `realpath` and acquires a persistent workspace claim. `dsh_attach_session` separately revalidates the exact idle root session and its caller-confirmed cwd before creating or reusing the same kind of claim. The default is `exclusive-write`; `read-only` permits overlapping bridge-local read-only claims, while any overlapping ancestor or descendant exclusive claim conflicts. Claims are shared across bridge processes using the same bridge home and remain after `turn/end`, because a person can continue the session later from DSH Web. This is cooperative coordination only: `workspaceMode` does not select, enforce, or verify the DSH Host filesystem sandbox, and `agentPreset` names DSH agent composition rather than a workspace or permission policy. Tool responses expose `workspaceClaimSemantics.controlsDshSandbox=false` so callers can present this boundary without parsing prose.

Release a claim only with `dsh_release_workspace`. Release does not close or cancel the DSH session. Follow-up, question answers, and `allow_once` require the task's claim to remain active; safety cancellation and approval rejection stay available without it.

The claim is cooperative. It prevents conflicting delegations seen by this bridge store, but cannot stop DSH Web, another bridge home, the caller, a shell, or an editor from writing files. A supervising caller must not edit an exclusively claimed cwd. A dedicated git worktree per writable delegation is the recommended strong isolation boundary.

If claim acquisition races after DSH session creation, the bridge returns a conflict identifying the unprompted session/task mapping; it does not silently run without a claim.

## Existing-session attachment

`dsh_find_sessions` reads only bounded `session.list` metadata for root sessions: exact id, bounded title, update timestamp, running/blank state, cwd, preset, and any existing bridge task id. It never reads history or returns raw projections. `dsh_attach_session` accepts only an exact session id plus fresh `updatedAt`, cwd, and title preconditions (including an explicit `null` title); titles never select the target. It rejects running sessions, descendants, missing/unresolvable workspaces, stale metadata, and blank sessions unless explicitly allowed.

Attachment does not call `session.create`, `session.prompt`, `session.rename`, or `session.selectModel`. Under the TaskStore registry lock it creates or reuses the strict `{taskId, sessionId}` mapping, prepares and validates the workspace claim, and begins supervision only after both are valid. If claim preparation rejects, a mapping newly created by that attachment is removed before the operation returns; a pre-existing mapping is never removed by the failed attempt. Legacy duplicate mappings still fail closed, and concurrent identical attachment converges on one BridgeTask. This is operation-failure atomicity, not a filesystem transaction across the separate mapping and claim files after a hard process or machine crash. Continuing work remains a separate, explicit `dsh_followup` write, where optional routing is validated and disclosed before that prompt.

## SDK backend

The SDK backend is an optional third backend. `DSH_HOST_PROTOCOL=sdk` selects it explicitly; `legacy` stays the default, no other setting selects it implicitly, and no failure path switches backends automatically. It speaks stdio JSON-RPC to a DSH SDK runtime instead of HTTP/WebSocket to a Web Host, so it is not a Host client: it starts, owns, bounds and closes its own runtime processes.

[SDK backend qualification](sdk-qualification.md) records the pinned client/runtime pair and the live evidence for every capability below. [SDK backend](sdk-backend.md) is the operator configuration guide, and [validation](validation.md) separates what was executed from what was not.

### Components

```text
Codex -> MCP Bridge / BridgeService
          |- TaskStore + WorkspaceClaim + EventLedger
          |- BackendCapabilities + RuntimeRegistry
          `- DshApi
               |- DshClient         (legacy: HTTP + WebSocket Host)
               |- GatewayDshClient  (gateway: authenticated Host)
               `- SdkDshClient      (sdk: stdio JSON-RPC)
                    |- SdkRuntimeManager      spawn, capacity, idle reclamation, teardown
                    |- SdkObservedEventStore  bridge-owned observed events
                    `- HarnessClient -> SDK runtime subprocess over stdio
```

`BridgeService` is shared by all three backends and branches on `BackendCapabilities`, not on the backend name. A missing semantic throws a structured error; it never becomes an empty list or a fabricated success. The SDK backend serves the same `DshConnection` contract through `SdkConnectionAdapter`, which supplies observation, lineage, pending interactions and the change signal from the bridge's own record instead of a Host mux. Workspace-claim checks, stale-view preconditions, task cursors, ownership checks and the final-message-pointer fold therefore keep running unchanged for SDK tasks.

Construction is inert. Selecting the backend resolves no Host endpoint, reads no connect token, performs no Desktop discovery and spawns no subprocess; `SdkDshClient` and its `SdkRuntimeManager` are constructed, and the first runtime starts with the first prompt of a task.

### Wire contract actually used

Client → server requests: `initialize`, `session/prompt`, `session/resume`, `session/wait`, `shutdown`.

Server → client notifications consumed: `session.event`, `session.status`, `subagent.started`, `subagent.finished`, `user-question.cancelled`. `session.query.completed` is recorded as an observed command completion and is never attributed to a bridge prompt; unknown methods are counted, bounded and kept for diagnostics without changing task state.

Server → client requests (opt-in): `approval/request`, enabled with `initialize.approvalRequests=true`. The request handler is installed after `start()` and before `initialize`, so the first prompt can never race an unanswered approval. The result is exactly `{outcome: "allowed-once" | "rejected" | "cancelled"}`. Native user questions are enabled with `initialize.capabilities.userQuestions=true` plus the `onUserQuestion` callback; cancellation arrives through that callback's `AbortSignal` and/or the `user-question.cancelled` notification, and a late answer is rejected as not-pending.

Semantics the bridge depends on:

- `session/prompt` returns only a durable enqueue receipt `{messageId}`. The bridge reports `messageIdSource="sdk-durable-inbox"` and never presents a receipt as a finished turn.
- `session/wait` returns after the root is idle and managed descendants finish; it does not prove which input produced which assistant message.
- `session/resume` restores a persisted session by exact id from the configured home, sends no input, and re-broadcasts no historical events. It is sent only for a task this bridge already registered.
- There is no protocol version negotiation. The client does not validate the runtime's reported `serverInfo` version, so the pinned client/runtime pair is the compatibility statement.
- `clientTimeZone` is not transmittable on this wire. The bridge reports `clientTimeZoneApplied: false` and the runtime profile's own time zone applies.

### Capabilities

| Capability | SDK value | Operational consequence |
| --- | --- | --- |
| `sessionDiscovery` | `bridge-owned` | Only tasks this bridge registered are visible. `dsh_find_sessions` returns `scope="bridge-owned"`, `attachable=false`; `dsh_attach_session` returns `unsupported_capability`. |
| `historySource` / `authoritativeHistory` | `observed-cache` / `false` | Returned history is the bridge's own observation, with explicit coverage and gaps. It is not DSH history. |
| `resumeSession` | `true` | A known task resumes by exact id in the same home, profile and route. |
| `nativeRename` | `false` | Titles are bridge-local (`titleSource="bridge"`); an observed `session/title` event is reported separately as `dsh-native`. |
| `modelCatalog`, `dynamicModelSelection` | `false` | The route is fixed by `initialize`. Explicit `modelProfile`, `reasoningEffort`, `visualIntent` and `agentPreset` are rejected before any session or prompt. |
| `steer` | `false` | `dsh_followup mode="queue"` is the only accepted placement; `mode="steer"` is rejected. |
| `turnCancel`, `queueSnapshot`, `queueMutation` | `false` | `dsh_cancel` returns `unsupported_capability` for both scopes, and closing a runtime is never reported as a cancelled turn. |
| `subagentHistory` | `true` (observed) | Observed descendant events are readable; a subagent listing call remains `unsupported_capability`. |
| `approvals`, `userQuestions` | `true` | Wire-supported and served through the existing typed response tools; live round trips are not yet exercised. |
| `eventsMuxWebSocket` | `false` | Notifications arrive on the stdio JSON-RPC stream only. |

### Observation model

Observed events are the only conversation content an SDK task can return. A restored session does not replay history, and the runtime's persisted log is an internal compressed format the bridge must not parse. The bridge therefore records what it actually observed and states coverage itself.

For every `session.event` the bridge appends the event to `observed/<taskId>/events.jsonl` and flushes it before touching any derived state (lineage, phase, ledger record, revision counter), so a crash cannot leave a final-message pointer aimed at text that was never written. A duplicate `(sessionId, seq)` whose content is identical is counted and skipped; the same key with different content is an observation conflict that degrades the task instead of overwriting the stored event. A sequence jump, a write failure, an oversized event, a malformed stored line or an unreadable `meta.json` records a gap (`corruption | overflow | write_failure | observation_degraded`) instead of a silent drop, and `coverage.complete` turns `false` for that task. `meta.json` is derived state and is rebuilt from `events.jsonl`; a crash between the two leaves readable events behind.

Consequence: status, tail and history for an SDK task are explicitly non-authoritative, and the sanitized ledger still owns coordination metadata and the final-message pointer. A task with a recorded gap refuses a normal follow-up with `observation_gap`, because a follow-up would look like a complete transcript while earlier events are missing; read-only status and tail keep working and keep reporting the gap. Continuing requires a new task with an explicit handoff summary.

### Ownership model

`runtimes/<taskId>.json` is the durable ownership and environment record. Its claim is a locked read-modify-write transaction. Identity fields (`backend`, root session id, canonical cwd, DSH home, profile, fixed route, config fingerprint, task id, owner, creation time) are fixed at claim time and can never be changed by a later update; only the observation epoch, clean-shutdown flag and timestamp, bridge-local title, last observation fields and a bounded diagnostic may be patched.

A second bridge claiming the same task receives `runtime_owner_conflict`. Takeover is accepted only when the record says the previous owner shut down cleanly; stale ownership is never reclaimed by wall-clock time or PID liveness, so a hard-killed bridge leaves a fail-closed record that an operator must resolve. Changing the DSH home, profile, route or CLI module changes the config fingerprint and yields `runtime_identity_mismatch` instead of silently rebinding a task to a different environment. Records hold no environment dump, credential or token.

### Lifecycle and capacity

- Lazy start: one root task owns one runtime, started by that task's first prompt. Read-only calls (status, tail, find, doctor) start nothing and report a task as unloaded rather than idle. DSH subagents that run inside a runtime belong to that root task and never get their own external runtime.
- Bounded handshake: `initialize` is bounded by `DSH_SDK_INITIALIZE_TIMEOUT_MS` (default 60 s) and carries `approvalRequests: true` and `capabilities.userQuestions: true`. It is followed by an optional `session/resume` and then the notification subscription. A failed handshake ends in `sdk_initialize_failed` or `session_resume_failed`, sends no prompt, and closes the process.
- Capacity: `DSH_SDK_MAX_RUNTIMES` (default 2) live runtimes. Capacity pressure first reclaims runtimes that are idle and have no unanswered interaction; when nothing qualifies, the prompt fails with `runtime_capacity_exceeded`. No request waits unboundedly for a slot.
- Idle reclamation: `DSH_SDK_IDLE_TIMEOUT_MS` (default 600000; `0` disables it). Only a runtime that is idle and has no unanswered interaction is reclaimed. Active turns, pending approvals/questions and other in-flight work are never reclaimed by the timer, by capacity pressure, or by another task's start.
- Shutdown: `close()` is asynchronous and awaited on MCP close, stdin EOF/close, SIGINT, SIGTERM and after an interrupted initialization. Teardown is bounded by `DSH_SDK_SHUTDOWN_TIMEOUT_MS` (default 10 s). The record is marked clean only after the SDK teardown resolves, and a runtime closed mid-turn or with a pending interaction is recorded as unclean even when the process exited.
- Generations: every start increments the task's runtime generation, and interaction identifiers are generation-scoped, so an answer that arrives after a restart is reported as not-pending instead of being applied to a new process.

### Data layout

| Path | Contents | Authority |
| --- | --- | --- |
| `tasks/<taskId>.json` | Unchanged legacy two-field mapping `{taskId, sessionId}` | Identity only; shared with the Host-backed backends |
| `claims/<taskId>.json` | Workspace claim: canonical cwd, owner, claim mode | Cooperative coordination, unchanged |
| `runtimes/<taskId>.json` | Schema version 1 runtime identity and ownership record | Authoritative for ownership and environment binding |
| `observed/<taskId>/events.jsonl` | The bridge's own observed events, one JSON record per line, flushed per batch | The only conversation content this backend can return; explicitly non-authoritative |
| `observed/<taskId>/meta.json` | Derived per-session sequence statistics, degradation list, byte count | Derived; rebuilt from `events.jsonl` |
| `ledgers/<taskId>/events.jsonl` | Sanitized coordination ledger: cursors, lineage, execution/pending state, final-message pointers | Rebuildable index that never holds conversation content |
| `<DSH_HOME>/` | The runtime's own persistence and native credential store (`sessions/`, `storages/`, `profiles/sdk/`) | Owned by the runtime; the bridge never parses, copies or writes it |

Paths are relative to the bridge home, which for the SDK backend defaults to `<DSH_HOME>/codex-bridge-sdk` unless `DSH_BRIDGE_HOME` is set. The observed-event directories are `0o700` and the files `0o600`.

### Failure semantics

Unsupported or failed paths return one of `unsupported_capability`, `sdk_initialize_failed`, `runtime_unavailable`, `runtime_capacity_exceeded`, `runtime_owner_conflict`, `runtime_identity_mismatch`, `backend_mismatch`, `observation_gap`, `prompt_outcome_unknown`, `session_resume_failed` or `sdk_unavailable`, each with a retryable flag and a short suggestion. A prompt receipt timeout or a dropped transport during a prompt is `prompt_outcome_unknown` and is never retried, because the message may already be queued. Missing SDK packages are reported as `sdk_unavailable` instead of failing at module load for callers of the other backends.

## Explicit limitations

- No Host process lifecycle management, authentication layer, pidfile, port lock, or automatic Host start.
- No automatic retry of non-idempotent writes, except the bounded visual-required route selection/verification stage and its single force-majeure-only ModLens Flash fallback described under Visual routing; `session.create`, prompt/follow-up, cancel, queue mutation, and `/api/respond` are never retried.
- A WebSocket disconnect produces `host_unreachable`/unknown, not task failure; read-only reconnect/history recovery continues automatically.
- Host restart loses its process-local active turn, pending interactions, queue, and background-job state. The bridge does not claim seamless continuation.
- If fresh history still ends at `turn/start` but fresh `session.list` says the session is no longer running, status records a content-free `interrupted` coordination marker. A later durable `turn/end` supersedes it during reconciliation.
- DSH durable session/history can survive a Host restart, but a created-only zero-event session may be lazily absent. The bridge process-restart mock test uses a session with durable events; no live rc.6 restart was performed by the implementation run.
- Queue state is unknown after mux connect or reconnect until rc.6 emits an actual `session/queue` snapshot. The bridge does not infer an empty queue from `session/subscribed`.
- Ordinary user-created session forks are not folded into a BridgeTask; session-backed subagent descendants are.
- Host-origin affinity is configuration-scoped rather than stored in the strict task mapping. Do not reuse one `DSH_BRIDGE_HOME` after changing an explicit `DSH_HOST_URL`; per-task cross-Host migration is unsupported. In opt-in Windows `desktop-auto` mode, a DSH Desktop generation may rebind the same logical profile to another ephemeral loopback port. The client invalidates the old endpoint after a transport failure and the connection manager resolves the next generation on its next reconnect iteration. Failed prompt writes are never retried; the only bounded retry is the visual route selection/verification stage described under Visual routing. A profile switch that no longer contains a mapped session remains `session_not_found`; automatic recovery never remaps by title. Explicit attachment is a separate operator-directed flow using a freshly discovered exact session id.
- Workspace claims do not provide OS-level exclusion, and fresh write preflight cannot eliminate a Web-client time-of-check/time-of-use race. Full simultaneous multi-caller plus interactive-Web conflict freedom is not claimed.
- Exactly-once delivery, atomic queue clear, `events.mux.since` resume, argument-dependent caller approval policy, automatic background-job cancellation, and Host-package detection through `host.describe.version` are unsupported.
- Real browser-visible end-to-end interaction is an operator acceptance step, not part of `npm test`. Follow the [validation guide](validation.md) after changing DSH, the model route, the agent preset, or bridge transport behavior.

See [Known issues](../KNOWN_ISSUES.md) for current source-preview defects and operational workarounds.
