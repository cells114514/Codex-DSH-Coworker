# SDK backend (optional)

Explicit orphan recovery (Windows-qualified): preview with `node docs/operator-tools/recover-sdk-task.mjs --task <exact-task-id> --home <sdk-home>`, using the original provider/model environment. Only after inspecting independent/external work, add `--apply --confirm-no-runtime`. The maintenance path validates a fresh registry snapshot and dead owner, backs up the unclean record under `runtimes/recoveries/`, restores the exact session without submitting or replaying input, and closes its own runtime through the normal drain path. Only that new process's confirmed shutdown may be recorded clean. It does not erase observation gaps or prove prior input delivery. Ordinary follow-up still refuses unclean-owner takeover.

Routine supervision should use `dsh_watch(taskId, timeoutSec=30)`: ordinary event traffic stays inside the bridge, while completion, human interaction, unavailability, observation gaps, or timeout return a compact summary without logs or full status. Repeat watch directly on timeout. Read `dsh_status` once for final review or actionable details; use cursor-based `dsh_tail(maxBytes=4096)` only for specific diagnostic evidence. `dsh_wait` retains its event-level compatibility behavior. Load the new tool and updated Skill only after active tasks finish; restarting an active SDK bridge closes its runtimes. Savings depend on actual caller usage and have not been measured.

**English** | [简体中文](sdk-backend.zh-CN.md)

Codex-DSH-Orchestrator has three backends: `legacy` (default), `gateway`, and `sdk`. The `sdk` backend is
optional, explicitly selected with `DSH_HOST_PROTOCOL=sdk`, and never becomes the default. It drives the official
DeepSeek Harness TypeScript SDK runtime over stdio JSON-RPC, so Codex can delegate to DSH without starting DSH
Desktop or the Gateway launcher. The existing `legacy` and `gateway` backends, their configuration, and their
bridge data are unchanged, and a failure in the SDK backend never switches to another backend automatically.

## What it is

- **Transport.** The bridge starts one `dsh` CLI module as a child process and speaks the SDK JSON-RPC protocol
  with it over stdio. That is why there is no Host URL, no connect token, and no Desktop discovery on this
  backend: those variables are never read or validated here.
- **Ownership.** The bridge itself owns the runtime processes it starts. It starts them lazily, caps them,
  reclaims idle ones, and closes them on exit. Capability and lifecycle facts are declared once per backend, so
  an unsupported feature is reported as a structured error instead of an empty list or a simulated success.
- **Discovery and history.** The SDK wire has no session catalog and no history read; a persisted session is
  restored for model context but is not re-broadcast. Discovery is therefore bridge-owned, and history is the
  bridge's own observation record with explicit coverage gaps. It is an observation cache, not DSH history, and
  is never presented as authoritative.
- **Credentials.** The runtime reads the DSH home's own native configuration and credential store, exactly as
  any other DSH runtime would. The bridge never reads, copies, or writes them, and the generated configuration
  contains no model API key. The `sdk` profile mounts two provider routes, and the route is chosen by
  `DSH_SDK_PROVIDER`/`DSH_SDK_MODEL` (or the runtime default) at `initialize`:

  | Route | Credential | Where it comes from |
  | --- | --- | --- |
  | `deepseek-official` (default) | API key sent as `x-api-key` | The DSH home's managed credential store, then the inherited environment, then a project `.env`, then the user `.env` |
  | `deepseek-account` | Account grant sent as `x-dsh-auth-token` | A stored `grant` whose issuer is not localhost, with the request destination on the official inference origin |

  Account sign-in is a browser flow that needs a Host web server; the stdio-only SDK profile cannot start one, so
  a grant must already exist in that home. A successful `initialize` proves the route exists — not that a
  credential works, because the credential is evaluated on the first model call.
- **Independence.** The SDK runtime and DSH Desktop are separate processes with separate homes. The SDK backend
  does not require, start, or stop Desktop, and version skew between the two is expected rather than a defect.

## Requirements

- Node.js 22+ (the package requires it and setup re-checks the major version), npm, Git, Codex and the
  repository checkout.
- A DSH home that already holds the user's authorized DSH configuration. The bridge does not create, copy, or
  substitute credentials; onboarding, login and provider authorization stay with the user.
- Disk and install time for the pinned client: `npm install` of `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3`
  resolves 606 packages (~745 MB). The runtime pin is `@deepseek-ai/dsh@0.2.2-rc.3`.
- A runtime profile that serves the SDK JSON-RPC server. The default profile name is `sdk`; a custom profile is
  used as-is and the installer cannot verify that it still serves the SDK server.
- Platform: the recorded qualification is Windows only. macOS is unverified.

## Install

```sh
npm ci
npm run check
npm run setup -- --backend sdk --yes --no-preset --dry-run
```

Review the dry run, then repeat the same command without `--dry-run`. For this backend the dry run prints one
JSON object (server name, target config path, command, args, environment, human-approval block, `writes: false`
and any warnings) and writes nothing.

Installer options for this backend:

| Option | Meaning |
| --- | --- |
| `--backend sdk` | Select the SDK backend; without it setup keeps the `legacy` default |
| `--dsh-home <dir>` | DSH home written as `DSH_HOME` (default: existing `DSH_HOME` or `~/.dsh`) |
| `--sdk-profile <name>` | Runtime profile (default `sdk`) |
| `--sdk-bin <path>` | Path to a `dsh` CLI module, written as `DSH_SDK_BIN`; a module path, never a shell command |
| `--bridge-home <dir>` | Override the bridge home instead of the per-backend default |
| `--dry-run` | Print the review object and write nothing |
| `--no-preset` | Omit `--preset` instead, or pass this flag; an explicit preset is rejected because the SDK backend cannot select one |
| `--skill-path` / `--no-skill` / `--replace` / `--replace-skill` / `--skip-doctor` | Unchanged from the other backends |

`--host-url`, `--host`, `--desktop-auto` and `--gateway` describe a DSH Host and are rejected together with
`--backend sdk`, as are a pre-set `DSH_CONNECT_ORIGIN` or `DSH_CONNECT_TOKEN_ENV`. The written MCP environment
contains `DSH_HOST_PROTOCOL=sdk`, `DSH_HOME`, `DSH_SDK_PROFILE` plus whatever SDK variable the operator supplied
explicitly — never a Host URL, a connect-token variable, or a model API key. `approval_mode = "prompt"` for
`dsh_resolve_approval` stays as it is on the other backends. Manual TOML configuration is described in
[Manual configuration](manual-configuration.md).

### Check the installation with doctor

```sh
npm run build
node dist/doctor.js                      # static report: spawns nothing
node dist/doctor.js --probe-sdk          # one bounded initialize handshake
```

Export the same SDK variables the MCP server receives (at minimum `DSH_HOST_PROTOCOL=sdk`) before running either
command. The static report reads configuration, package resolution, the DSH home shape, the runtime registry and
the bridge's own observation store; it spawns no runtime, sends no prompt, resumes no session, and starts no
Desktop. `--probe-sdk` implies `--live`, requires `DSH_HOST_PROTOCOL=sdk`, and performs exactly one bounded
`initialize` handshake: no prompt, no resume, no Desktop. It is side-effecting and says so in its own output —
it loads the plugins of the configured DSH profile, it may create or update DSH home profile and persistence
directories, and it may read the user's native credential store. A probe result is reported, not raised, and it
never changes the static verdict.

### Run the live acceptance driver

`docs/operator-tools/sdk-live-acceptance.mjs` drives the real MCP bridge over stdio and reports one verdict per
scenario (`PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`) with its evidence class.

```sh
npm run build
node docs/operator-tools/sdk-live-acceptance.mjs --stages L1,L2,L3   # throwaway DSH home
node docs/operator-tools/sdk-live-acceptance.mjs --stages L1 --home <sdk-home> --provider deepseek-account --model deepseek-flash
```

`--stages` selects scenarios, so a confirmed environment does not repeat everything; `--home` uses an
operator-supplied SDK home instead of a throwaway one; `--work` and `--work-two` choose workspaces;
`--stage-limit` bounds a scenario; `--max-model-calls` caps model calls; `--interaction-policy deny|allow`
decides how runtime approvals and questions are answered (default `deny`, so nothing is ever auto-granted);
`--provider` / `--model` select the runtime route for the run; `--json-out` writes the report to a file.

The driver deletes only directories it created, tears down in `finally`, never copies a credential store, and
prints no prompt text, reply text, credential, or real task/session id. It exits non-zero unless every requested
scenario is `PASS`; `BLOCKED` is a failure, not a pass. The dated round-2 run is in
[acceptance results](sdk-live-acceptance-results.md).

### Route through a custom OpenAI-compatible gateway

A non-DeepSeek endpoint is registered through the profile's dormant `llm-pi-ai` row, not through
a bridge setting. Edit `<DSH_HOME>/profiles/sdk/cordis.patch.yml` in the SDK home:

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencode-go:                       # the route name, selected by DSH_SDK_PROVIDER
        displayName: OpenCode Go
        api: openai-completions
        baseURL: https://opencode.ai/inference/go/openai/v1
        apiKeyEnv: OPENCODE_GO_API_KEY   # a credential reference, never a secret
        compat:
          thinkingFormat: deepseek       # parse `reasoning_content`
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
```

Then run the bridge with `DSH_SDK_PROVIDER=opencode-go` and `DSH_SDK_MODEL=deepseek-v4.1-flash`,
and put the key in the SDK home's credential store as a `refs` entry named by `apiKeyEnv`, or
export that variable for the bridge process. A key in the store wins over the environment, so
remove a stale store entry before relying on the variable.

The store is a YAML document with `version: 1`, an optional `refs:` map, and the `records:` map
that holds login grants. Add the entry with
[`set-sdk-credential-ref.mjs`](operator-tools/set-sdk-credential-ref.mjs) so the value never
enters shell history or a chat transcript:

```sh
set OPENCODE_GO_API_KEY=sk-...          # your own terminal; or $env:OPENCODE_GO_API_KEY="..."
node docs/operator-tools/set-sdk-credential-ref.mjs "$HOME/.dsh-sdk-test" OPENCODE_GO_API_KEY --from-env OPENCODE_GO_API_KEY
unset OPENCODE_GO_API_KEY
```

It preserves `records`, is idempotent, and prints only the entry name and length class. Run
[`inspect-credential-structure.mjs`](operator-tools/inspect-credential-structure.mjs) afterwards
to confirm the entry exists without showing it.

Requires a per-session header? Add a small local plugin next to the profile and import it by a
relative path — the loader resolves relative specifiers from the configuration file:

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

The value is stable for every call of one session and distinct across sessions; calls without a
session id need their own fallback. Harness attribution runs after contributors, so reserved
header names cannot be overridden. Two stub-based helpers verify this wiring without spending
provider requests:
[`verify-opencode-session-header.mjs`](operator-tools/verify-opencode-session-header.mjs) and
[`verify-opencode-reasoning-tools.mjs`](operator-tools/verify-opencode-reasoning-tools.mjs).

## Configuration reference## Configuration reference

For the SDK backend these variables are the whole configuration surface. The Host URL, the connect-token
variables and Desktop discovery are never read or validated on this backend, so an unrelated Host setting cannot
block it and Gateway credentials can never leak into it.

| Variable | Default | Notes |
| --- | --- | --- |
| `DSH_HOST_PROTOCOL=sdk` | `legacy` | Explicit opt-in to this backend |
| `DSH_HOME` | `~/.dsh` | SDK persistence, profiles and credentials |
| `DSH_SDK_PROFILE` | `sdk` | A custom profile must still serve the SDK server; the installer cannot verify that |
| `DSH_SDK_BIN` | unset (the same-version `@deepseek-ai/dsh` from the dependency) | Path to a `dsh` CLI module, resolved lexically; never shell-interpolated, never a command line; Windows paths with spaces are supported |
| `DSH_SDK_PROVIDER`, `DSH_SDK_MODEL` | unset (runtime defaults `deepseek-official` / `deepseek-v4-flash`) | Both or neither; the runtime validates the exact route during `initialize` |
| `DSH_SDK_REASONING_EFFORT` | unset | Requires provider and model; validated by the runtime at `initialize` |
| `DSH_SDK_MAX_RUNTIMES` | `2` | Hard cap on concurrent runtimes |
| `DSH_SDK_IDLE_TIMEOUT_MS` | `600000` | `0` disables idle reclamation |
| `DSH_SDK_INITIALIZE_TIMEOUT_MS` | `60000` | Bound for the handshake |
| `DSH_SDK_SHUTDOWN_TIMEOUT_MS` | `10000` | Bounded teardown |
| `DSH_APPROVAL_TIMEOUT_MS` | `300000` | Pending approval/question expiry; the timer cancels, it never grants |
| `DSH_BRIDGE_HOME` | `<DSH_HOME>/codex-bridge-sdk` for `sdk`; `<DSH_HOME>/codex-bridge` for `legacy`/`gateway` | Different state roots; never repointed automatically |

Shared variables keep their meaning: `DSH_BRIDGE_TIME_ZONE` is accepted but not transmitted, because the SDK
wire has no field for it — results report `clientTimeZoneApplied: false` instead of pretending. A
`--preset`/`DSH_BRIDGE_AGENT_PRESET` request is rejected rather than ignored, because the SDK wire carries no
preset field and the runtime profile fixes composition. `DSH_HOST_VERSION` stays an operator declaration, kept
separate from verified product evidence. When both provider and model are omitted, `dsh_host_status` and doctor
name the fallback route instead of claiming a catalog.

## Capabilities

Capabilities are declared per backend and reported in `dsh_host_status.capabilities`; callers must branch on
those flags rather than on a protocol name.

| Capability | `sdk` | `legacy` / `gateway` (Host-backed) |
| --- | --- | --- |
| Transport | `stdio-jsonrpc` | `http-websocket` |
| Session discovery | Bridge-owned | Host catalog |
| History source | Observed cache | Host |
| Authoritative history | No | Yes |
| Resume by exact session id | Yes | Yes |
| Native rename | No | Yes |
| Model catalog | No | Yes |
| Dynamic model selection | No | Yes |
| Steering (`mode=steer`) | No | Yes |
| Turn cancel | No | Yes |
| Queue snapshot / mutation | No | Yes (subject to the Host capability probe) |
| Subagent history | Observed cache only | Only when the Host probe reports it |
| `agentPreset` selection | Unsupported | Supported |
| One-shot approvals | Yes | Yes |
| Native user questions | Yes | Yes |
| Events mux over WebSocket | No | Yes |

## Lifecycle and concurrency

- **One runtime per root task.** A runtime is created lazily by the first prompt of that task — never at MCP
  startup and never by a read. `dsh_host_status`, `dsh_status`, `dsh_tail` and `dsh_find_sessions` report
  "loaded", "not loaded" or "unknown" and start nothing.
- **Bounded start, observation first.** The child process, the request handlers, the notification subscription and
  its pump are established *before* the `initialize` handshake, and `acquire` returns only once notifications
  already received are persisted. Handlers and the subscription therefore exist before the first prompt, and
  events committed during `initialize` or `session/resume` are not lost. A bounded barrier marks coverage partial
  if the queue cannot be drained in time.
- **Fixed route.** The provider/model route is verified during `initialize` and then fixed for that runtime. An
  unavailable adapter or model fails the handshake, no prompt is sent, and nothing falls back silently.
- **Capacity.** At most `DSH_SDK_MAX_RUNTIMES` runtimes exist at once. When every slot is held by active work the
  bridge returns `runtime_capacity_exceeded` instead of queueing unboundedly.
- **Reclamation.** A runtime is reclaimed only when it is idle *and* has no unanswered interaction. Capacity
  reclamation never kills active work, and `DSH_SDK_IDLE_TIMEOUT_MS=0` disables the idle timer entirely.
- **Shutdown and clean-shutdown semantics.** The bridge closes the runtimes it owns when the MCP transport closes,
  on stdin EOF, on SIGINT/SIGTERM, and on an interrupted initialization. Teardown is bounded: process close, then
  a bounded drain of the notification queue, then the subscription is closed and one exit report is emitted. The
  close is asynchronous, awaited before exit, and idempotent. A task is recorded as `cleanShutdown` only when the
  process exit is proven **and** the queue was drained; a task that cannot prove the drain is marked partial, its
  `observation.complete` becomes `false`, and normal follow-ups are refused with `observation_gap` until a new
  task is started. An exit that cannot be proven at all keeps its capacity slot and refuses a replacement for
  that task with `runtime_unavailable`.
- **Ownership.** Ownership is recorded per task. A second bridge that finds a record without a clean shutdown gets
  `runtime_owner_conflict` instead of taking the task over, and a new owner only takes over after a recorded clean
  shutdown.
- **Resume.** Resume happens only after a recorded clean shutdown and only by the exact session id, with the same
  DSH home, profile and route. Anything else fails before a prompt is accepted.
- **Observation.** A crash, a transport loss, a close during a running turn or a pending interaction, or a failed
  store write degrades that task's observation and marks the turn interrupted instead of reporting success. A
  transport loss releases the runtime slot (the child's stream ended) but still degrades the task, so the next
  follow-up reports the gap rather than a shortened transcript.
- **Concurrent starts.** Callers that race for the same task share one runtime, concurrent starts across tasks
  cannot exceed the capacity limit, and a failed start releases its reserved slot.
- **Status revision.** `dsh_status.connection.revision` is a strictly monotonic view clock: it is stable while
  nothing changes and never decreases, including when a runtime is removed and rebuilt, so a stale-view rejection
  cannot be fooled by a reused number.
- **Interruption inference.** Observed `running` is unknown until a status transition is seen. An unknown state is
  never reported as `interrupted`; only an authoritative "not running" report resolves a turn that way.

## Data on disk

Everything below lives under the SDK backend's own bridge home (`<DSH_HOME>/codex-bridge-sdk` by default).

| Path | Contents |
| --- | --- |
| `<bridge home>/tasks/<taskId>.json` | The existing two-field task mapping, unchanged; no conversation text |
| `<bridge home>/runtimes/<taskId>.json` | Runtime record: `schemaVersion`, `backend`, `cwd`, DSH home, profile, fixed route, config fingerprint, observation epoch, clean-shutdown flag, owner, bridge title |
| `<bridge home>/observed/<taskId>/events.jsonl` | The bridge's own observed events, appended before derived state |
| `<bridge home>/observed/<taskId>/meta.json` | Per-session sequence statistics, byte accounting and degradation entries |
| `<bridge home>/ledger`, `<bridge home>/claims` | The existing event ledger and workspace claims, unchanged |

The observed files may contain conversation text, so they are created with private file modes (directories
`0700`, files `0600`). They hold only what this bridge observed: an observed event is not DSH history, restored
sessions do not re-broadcast earlier events, and completeness is always reported explicitly. The bridge never
parses DSH's own `sessions/**/session.*.jsonl.zstd` logs or projection caches, and never writes into them.

## Errors

SDK failures are structured objects carrying `code`, `backend`, `retryable`, `suggestion` and task/session
identifiers. An unsupported capability is never reported as an empty list or a fake success.

| Code | Meaning |
| --- | --- |
| `unsupported_capability` | The backend does not implement the requested semantic; `details.capability` names it |
| `sdk_initialize_failed` | The bounded `initialize` handshake failed; no prompt was sent |
| `runtime_unavailable` | No live runtime for the operation, or the runtime manager has already shut down |
| `runtime_capacity_exceeded` | All `DSH_SDK_MAX_RUNTIMES` slots are held by active tasks |
| `runtime_owner_conflict` | Another bridge owns the task's runtime without a recorded clean shutdown |
| `runtime_identity_mismatch` | The recorded runtime identity (home, profile, route, cwd, session) does not match |
| `backend_mismatch` | The session was not created by this bridge, or is not part of the task's observed lineage |
| `observation_gap` | Observed coverage is incomplete, so a normal follow-up would look complete while events are missing |
| `prompt_outcome_unknown` | The prompt receipt was not confirmed; the message may already be queued, so it was not retried |
| `session_resume_failed` | The resume handshake failed; no prompt was sent |
| `sdk_unavailable` | The pinned SDK client package could not be loaded or does not export the client |

`prompt_outcome_unknown` must never be retried: inspect `dsh_status` for observed events instead, because
resubmitting the same input can duplicate work. Likewise `observation_gap` is not repairable in place — keep using
read-only status/tail, which report the gap, or start a new task with an explicit handoff summary.

## Limits (first release)

- No Desktop session discovery or attach, and no discovery of sessions created elsewhere. Only tasks this bridge
  created are discoverable; `dsh_find_sessions` lists them, and `dsh_attach_session` returns
  `unsupported_capability`.
- Restored sessions restore model context only. The bridge cannot re-read history it did not observe, and
  observation gaps block normal follow-ups until the user starts a new task with their own handoff summary.
- The provider/model route is fixed per runtime: no catalog, no switching, and no per-task reasoning-effort
  change. `modelProfile`, visual routing and `reasoningEffort` requests are rejected rather than silently ignored.
- No steering: `dsh_followup` accepts `mode=queue` only.
- No turn or queue cancel: `dsh_cancel` returns `unsupported_capability`, and closing a runtime is not reported as
  a cancelled turn.
- No subagent listing; `dsh_status` reports the observed lineage instead.
- No protocol version negotiation: the client does not validate the runtime's `serverInfo` version.
- `clientTimeZone` is not transmitted (`clientTimeZoneApplied: false`); the runtime profile's own time zone
  applies.
- Desktop data is never migrated or modified, and the two backends never share or repoint each other's homes.
- The bridge does not run a background service after it exits, and it cannot recover work after the process ends.
- This is not a sandbox or an OS-level isolation mechanism. The bridge-local workspace claim still coordinates
  bridge users only, and a dedicated worktree per writable task is still recommended.

## Rollback

Set `DSH_HOST_PROTOCOL` back to `gateway` (or `legacy`) and restore that backend's own bridge home; then reload
the caller during an agreed window. SDK data stays on disk untouched — it is never migrated into another backend
and never deleted automatically. Preserve the previous checkout, the configuration backup and the installed Skill
backup, and review any later configuration edits before restoring them. See [Known issues](../KNOWN_ISSUES.md)
for lock recovery and Windows filesystem limits.

## Verification status

- `npm run check` — build plus 401 automated tests — passed on Windows with Node 25.6.0 (386 at the end of
  round 1; the round-2 additions cover handshake-phase observation, drain-bounded shutdown, concurrent
  acquisition and revision monotonicity).
- Real-machine probes are recorded in [SDK qualification](sdk-qualification.md): a valid `initialize` completed
  in ~2.6 s, an invalid provider/model route was rejected in ~2.6 s with no session created, a prompt returned a
  UUID receipt and was followed by streamed events, and a resume in a second process started at a later sequence
  without re-broadcasting earlier events.
- Windows only. macOS is unverified.
- Live acceptance is reported in two phases. With no credential, L1–L7 were `BLOCKED` at the provider boundary
  (`MISSING_CREDENTIAL`, `AUTH`/401, `ACCOUNT_SIGN_IN_REQUIRED`). After one operator-performed browser sign-in in
  an isolated SDK home, the account route (`deepseek-account` / `deepseek-flash`) passed **L1** (a real reply),
  **L2** (same-task context continuity) and **L3** (clean shutdown, exact-session resume, another completed turn).
  L4–L7 were not run. The API-key route remains transport-only evidence here because no valid key exists. See
  [acceptance results](sdk-live-acceptance-results.md).
- A live approval round trip, a live native user question (including cancellation), two concurrent live runtimes,
  a mid-turn crash, and the supervised runtime-kill procedure are covered by mock-runtime tests only. Mock coverage
  is not qualification evidence. A partial-drain shutdown and an unproven exit are likewise mock-only; clean
  shutdowns *were* observed live, with `cleanShutdown: true` and no recorded degradation, and a restart resumed the
  exact session without a false `observation_gap`.
- Documented install weight: `npm install` of the pinned SDK client resolves 606 packages (~745 MB), pinned client
  `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3` with runtime `@deepseek-ai/dsh@0.2.2-rc.3`.

The full evidence record, including the capability gaps behind every `No` above, is
[SDK qualification](sdk-qualification.md). Backend-wide validation for the Host-backed paths remains in
[Validation](validation.md).
