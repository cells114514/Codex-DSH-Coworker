# SDK Backend — P0 Capability Qualification

Status: **qualified with blockers.** This record states which client/runtime pair was
actually installed, how it was obtained, what the public exports and wire contract are,
what was verified by running it on this machine, and which gaps block which features.

Round 2 (2026-11-17/18) correction: **no live probe has ever produced a successful
assistant turn.** The round-1 probes are kept as recorded, with their error outcomes
intact. What round 2 adds is the route/credential mechanism ([§4.1](#41-routes-and-credential-mechanisms)),
the observed error classes ([§5.1](#51-observed-credential-error-classes)), the state of
every gap after the round-2 fixes ([§6.1](#61-gaps-mitigated-in-round-2)), and the operator
actions that would unblock a live turn ([§5.3](#53-confirmed--not-confirmed--next-operator-action)).
The dated run record is [SDK live acceptance results](sdk-live-acceptance-results.md).

It is evidence, not a design essay. Nothing below is inferred from documentation alone
unless the item is explicitly labeled **not exercised**.

## 1. Environment

| Item | Value |
| --- | --- |
| OS | Windows |
| Node.js | 25.6.0 |
| npm | 11.8.0 |
| Qualification dates | 2026-11-17 (round-1 live probes), 2026-11-17/18 (round-2 live acceptance) |
| Baseline | git HEAD `428c69f590d569b0c7cfbdb831bfa88beedc938b` with the round-2 changes uncommitted |
| Package version | `0.1.0-alpha.7` |
| Desktop runtime present on machine | `0.2.1-rc.2` |
| SDK pair selected | client `0.2.2-rc.3` / runtime `0.2.2-rc.3` |

Paths are referred to as **the DSH home** (the runtime's configured home directory) and
**a temporary probe directory** (a throwaway project dir per probe, with its own
throwaway home). No absolute developer paths, environment dumps, tokens, or identities
are recorded here.

## 2. Package availability

`@deepseek-ai/dsh-sdk-client` publishes many versions. Observed dist-tags:

| Dist-tag | Version |
| --- | --- |
| `latest` | `0.0.1-rc.1` (stale) |
| `next` | `0.2.2-rc.3` |

Versions up to and including `0.2.2-rc.3` exist. The `latest` tag is not usable — it
does not correspond to the current line.

### 2.1 First attempt — `0.2.1-rc.2` (rejected pairing)

`0.2.1-rc.2` was tried first because it matched the installed Desktop runtime
(`0.2.1-rc.2`). Its published README and protocol README state:

- client→server notifications and **server→client requests are unimplemented on both
  wire ends** — described as "a dead capability";
- there is no mid-turn cancel;
- `run()` owns receipt-to-idle collection.

That pair therefore cannot carry approvals or user questions, both of which the first
release requires. The pairing was abandoned as a capability gap, not an install failure.

### 2.2 Selected pairing — `0.2.2-rc.3`

| Field | Pin |
| --- | --- |
| `dependencies` | `@deepseek-ai/dsh@0.2.2-rc.3` (the runtime; `bin.dsh = lib/bin.js`) |
| `peerDependencies` | `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-sdk-protocol`, `@deepseek-ai/dsh-session` at the same version, plus `@deepseek-ai/cordis ~4.1.0` |

Install result: `npm install @deepseek-ai/dsh-sdk-client@0.2.2-rc.3` in an empty project
resolved **606 packages** (~745 MB on disk). No `workspace:*` specifier is involved; the
published dependency graph resolves with a normal install.

### 2.3 Process independence

The Desktop runtime (`0.2.1-rc.2`) and the SDK runtime (`0.2.2-rc.3`) are independent
processes with independent homes. The SDK backend does not require, start, or stop
Desktop. Version skew between the two is expected and is not a defect.

## 3. Public exports

Used from the package root only; deep imports are not exported.

Values: `DeepSeekHarness`, `HarnessSession`, `validatedSessionEvent`, `HarnessClient`,
`NotificationSubscription`, `JsonRpcResponseError`, `RequestTimeoutError`,
`SdkProtocolError`, `TransportClosedError`.

Types: `DeepSeekHarnessOptions`, `HarnessClientOptions`, `HarnessNotification`,
`NotificationFilter`, `RunResult`, `SdkPromptContentBlock`, `SdkEncodedImageBlock`,
`SdkUserQuestionRequest`, `SdkUserQuestionAnswer`, `SdkUserQuestionResult`.

### 3.1 `HarnessClient` options used

| Option | Semantics that matter to the bridge |
| --- | --- |
| `dshBin` | A CLI **module** path, not a command line. |
| `profile` | Runtime profile selector. |
| `dshHome` | Runtime home; must match on resume. |
| `processCwd` | Child process working directory. |
| `env` | **Replaces** the child environment entirely when provided. The bridge does not pass it. |
| `initializeTimeoutMs` | Default 10000. |
| `requestTimeoutMs` | `undefined` waits indefinitely. |
| `shutdownTimeoutMs` | Default 1000. |
| `onUserQuestion` | Native user-question callback. |
| `approvalRequests` | Opt-in for `approval/request`. |

## 4. Wire contract (protocol `0.2.2-rc.3`)

Client → server requests: `initialize`, `session/prompt`, `session/query`,
`session/resume`, `session/wait`, `session/working-directory/get`,
`session/working-directory/set`, `shutdown`.

Server → client notifications: `session.event`, `session.status`,
`session.subagent.started`, `subagent.finished`, `session.query.completed`,
`user-question.cancelled`.

Server → client requests (opt-in): `approval/request`, enabled with
`initialize.approvalRequests = true` and a `client.onRequest(handler)` installed **after
`start()` and before `initialize`**. Result shape:
`{outcome: "allowed-once" | "rejected" | "cancelled"}`.

Native user questions: `initialize.capabilities.userQuestions = true` plus the
`onUserQuestion(request, {signal})` callback. Requests carry
`{requestId, sessionId, questions}`; answers are
`{answers: [{id, selected, custom?}]}` or `{cancelled: true}`. Cancellation arrives
through the callback's `AbortSignal` and/or the `user-question.cancelled` notification.
Late answers are ignored by the runtime.

Semantics that are easy to get wrong:

- `session/prompt` returns **only** a durable enqueue receipt `{messageId}`. It does not
  mean the turn finished.
- `session/wait` returns after the root is idle and managed descendants finish. It does
  not mean the input owns the next assistant message.
- `session/resume` restores a persisted session by exact id from the configured home,
  sends no input, and does not re-broadcast historical events.
- **No protocol version negotiation.** `serverInfo` is
  `{name: "deepseek-harness-sdk-runtime", version: "0.0.1"}` and the client does not
  validate that version.

Absent from the wire: session catalog/list, history read, rename, model
catalog/selection, turn or session cancel, queue snapshot/mutation, steering placement,
subagent listing.

### 4.1 Routes and credential mechanisms

The `sdk` profile composes `dsh-base`, which mounts two DeepSeek routes and one credential
resolver. The route is chosen during `initialize` and is then fixed for that runtime.

| Route | Credential header | Resolver behavior |
| --- | --- | --- |
| `deepseek-official` (runtime default) | `x-api-key` | Resolves the key from the managed store (`<DSH home>/.credentials.yaml`), then the inherited environment, then a project `.env`, then the user `.env`. |
| `deepseek-account` | `x-dsh-auth-token` | Returns a token only when the request destination origin is the DeepSeek account API origin **and** the store holds a `grant` record whose issuer is not localhost. |

Account sign-in is a browser flow that requires a running Host web server. The `sdk`
profile serves stdio JSON-RPC only and cannot start one, so an account-route runtime
cannot complete sign-in on its own; the grant has to exist in that home already.

Two limits follow, and both are easy to overclaim:

- A successful `initialize` proves the route and adapter exist. It proves nothing about
  whether the provider accepts a credential, because the credential is only evaluated on
  the first model call.
- The bridge never reads, copies, or writes these stores. Whatever the resolver does is
  the DSH home's own behavior; the bridge only classifies the resulting error.

## 5. Observed runtime behavior

Live probes only. Each probe ran in a temporary probe directory against a throwaway DSH
home. No prompt text, response text, or credential is recorded.

| # | Probe | Result |
| --- | --- | --- |
| 1 | Invalid provider: `initialize({cwd, provider: "__no_such_provider__", model: "no-such-model"})` | Rejected in ~2576 ms with `JsonRpcResponseError`: `no adapter registered for provider "__no_such_provider__"`. No session created. |
| 2 | Valid default route: `initialize({cwd, provider: "deepseek-official", model: "deepseek-v4-flash"})` | Succeeded in ~2600 ms; returned `{serverInfo: {name: "deepseek-harness-sdk-runtime", version: "0.0.1"}}`. **Handshake only** — per [§4.1](#41-routes-and-credential-mechanisms) this authenticates the route's existence, not the credential. |
| 3 | Prompt: `prompt(sessionId, [{type:"text", text:"Reply with exactly: ping"}])` | Returned a UUID `messageId` immediately; `session.event` notifications followed. Event types in one turn: `user/message`, `request/header`, `request/context`, `session/title`, `assistant/attempt`, `step/end`, `turn/end`. `seq` increased monotonically 12→17 in that sample; `agent/inbox/spliced`, `turn/start`, `step/start` appeared earlier in a second sample. The turn ended with a model error, not assistant text: a throwaway home has no credentials (`turn/end` `reason.kind = "error"`, `code = MISSING_CREDENTIAL`), and a throwaway home seeded with a copy of the local credential store reached the provider but was rejected (`code = AUTH`, `status = 401`, invalid API key). No prompt text, response text, or credential is recorded here. |
| 4 | Persistence layout under the throwaway home | Created `sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd`, `storages/`, `storages/session_projcache/`, `profiles/sdk/{cordis.yml,cordis.patch.yml,package.json,pnpm-workspace.yaml}`, `.credentials.yaml`, `.anonymous-user-id`. |
| 5 | Resume: second client process, same `dshHome`, `resumeSession(sessionId)` | Succeeded; new events began at `seq` 19 — earlier events 1..18 were **not** re-broadcast. |
| 6 | Shutdown: `close()` | Completed bounded teardown (protocol `shutdown`, then EOF → SIGTERM → SIGKILL ladder); process reaped. |

Answers to the two questions that decide the backend's design:

- **Is real model execution reachable from this environment?** Yes — through the account
  route, after one operator-performed browser sign-in in an isolated home, and not through
  the API-key route. The sequence matters and is kept explicit:

  | Phase | Home and route | Outcome |
  | --- | --- | --- |
  | A | Throwaway home, `deepseek-official` / `deepseek-account` | Every turn reached the provider and failed there (`MISSING_CREDENTIAL`, `AUTH`/401, `ACCOUNT_SIGN_IN_REQUIRED`); the bridge recorded each as `failed` / `terminal_missing_final` |
  | B | Isolated SDK test home signed in once through `dsh web` (runtime 0.2.2-rc.3, loopback only), route `deepseek-account` / `deepseek-flash` | `turn_completed` with an available final message; the same task kept context on a follow-up; a clean shutdown was followed by an exact-session resume that completed another turn |

  Phase B did not touch the Desktop home, used no API key (the test home's credential store
  holds only account `grant` records and no `refs`), and did not change the capability matrix
  or the pinned pair.
- **Can a resumed session be replayed?** No (probe 5). The session log
  (`session.v4.jsonl.zstd`) is an internal compressed format the bridge must not parse.
  Therefore **all history the bridge returns comes from its own observation record**,
  and the bridge must mark coverage itself. This record is an observation cache; it is
  not upstream history authority, and it must never be presented as such.

Consequences for teardown and for resume semantics are handled bridge-side: `close()`
drains the SDK teardown, the bridge then verifies its own slot bookkeeping, and a task
is marked `cleanShutdown` only after the SDK teardown resolves **and** the notification
queue was drained ([§6.1](#61-gaps-mitigated-in-round-2)).

### 5.1 Observed credential error classes

Round 2 ran the bridge itself over the real MCP path against throwaway homes. No prompt
text, reply text, credential, or raw provider error body is reproduced; the codes below
are the runtime's own `turn/end` codes and the response status.

| Home / route | Terminal outcome | Error class |
| --- | --- | --- |
| Fresh throwaway home, `deepseek-official` | `execution: failed`, `finalMessageStatus: terminal_missing_final` | `MISSING_CREDENTIAL` — no key resolvable from the store, environment, or `.env` chain |
| Throwaway home seeded with a copy of the local credential store, `deepseek-official` | Same failure shape, but the turn reached the provider | `AUTH`, HTTP 401 — the provider rejected the stored key |
| Throwaway home, `deepseek-account` | Same failure shape, no model output | `ACCOUNT_SIGN_IN_REQUIRED` — no non-localhost `grant` record in that home, and the profile cannot run the browser flow |

`initialize` succeeded in all three runs, which is exactly why [§4.1](#41-routes-and-credential-mechanisms)
separates "the route exists" from "the credential works". The bridge's failure classifier
maps these to a provider class (`provider_credential_missing`, `provider_auth_rejected`,
`provider_account_sign_in_required`), which is what keeps a blocked environment distinct
from a broken bridge.

### 5.2 Not exercised

Labeled **not exercised** — no live evidence exists for any of these, and none is
claimed: a live `approval/request` round trip; a live native user question (including
cancellation); capacity pressure with two concurrent live runtimes; a crash mid-turn; and a
supervised kill of one bridge-owned runtime process. These paths are covered by the bridge's
mock-runtime tests only. Mock coverage is not qualification evidence and must not be cited
as such. A *successful* live turn is no longer on this list: it was obtained in Phase B, on
the account route, from an isolated signed-in home.

### 5.3 Confirmed / Not confirmed / Next operator action

**Confirmed**

- The pinned pair runs on this machine: install resolves, the runtime spawns, `initialize`
  succeeds on a route that exists, and an unknown provider is rejected without creating a
  session.
- `session/prompt` returns only an enqueue receipt, and events follow in wire order; the
  observed ledger, not the runtime, is the only source the bridge returns.
- Resume by exact session identifier restores model context and re-broadcasts nothing.
- Credentials are resolved inside the DSH home by one of two routes with different headers,
  and the `sdk` profile cannot perform account sign-in.
- Three credential failure classes are reproducible, and each is recorded as a failed turn,
  never as success.
- After one browser sign-in in an isolated SDK home, the account route completes real
  model turns: a successful reply, same-task context continuity, and a clean
  shutdown/restart-resume cycle all passed live (L1–L3). The account grant is stored in that
  home's own credential store; the bridge neither reads nor copies it.

**Not confirmed**

- Whether the stored key in the local credential store is expired or simply wrong.
- Whether an existing Desktop grant would satisfy the account route from an SDK runtime.
  The supported path is a sign-in performed for the SDK home itself; copying the Desktop
  home is out of scope and was not done.
- Whether the API-key route can complete a model turn here: it cannot today, because no
  valid key exists in this environment.
- macOS behavior of any of the above.

**Next operator action** — option 3 below was executed and unblocked L1–L3; the list is kept
as the remaining alternatives. No secret may be pasted into a chat transcript or committed
to the repository.

1. Put a valid key into the SDK test home through the native entry point (the Models page
   of a Host using that home), or export the provider key variable in the environment that
   launches the bridge, keeping provider `deepseek-official`. Not done here.
2. Explicitly authorize using the existing DSH home that already holds the Desktop login
   and run with `DSH_SDK_PROVIDER=deepseek-account` plus a listed model. This writes new
   sessions into that home, so it is the operator's decision, not a default. Not done here.
3. Perform one browser sign-in in the SDK test home through a web-capable profile that
   shares the same `DSH_HOME`, then use `deepseek-account`. **Done:** `dsh web` from the
   pinned runtime, loopback only, against an isolated home; the Host was stopped afterwards
   and the Desktop home was never used.

## 6. Gaps and consequences

Format: requirement → evidence → consequence.

**Session catalog**
Requirement: discover or attach to sessions this bridge did not create.
Evidence: no session/list or catalog method exists on the wire.
Consequence: discovery is bridge-owned — only tasks this bridge registered are
discoverable. `find` and `attach` return explicit unsupported errors. No
Desktop/arbitrary-session discovery or attach.

**History read**
Requirement: return a transcript for a session the bridge did not observe.
Evidence: no history read method; persisted log is an internal compressed format.
Consequence: the bridge cannot reconstruct a transcript it did not observe. Restoring a
session restores model context only. History is an observed cache with explicit
coverage gaps.

**Model catalog / selection**
Requirement: enumerate or switch models.
Evidence: no catalog or selection method; the route is fixed at `initialize`.
Consequence: explicit `modelProfile`, visual routing, and effort switching are rejected
as `unsupported_capability`. No catalog is fabricated from configuration.

**Rename**
Requirement: rename a session.
Evidence: no rename method; `session/title` arrives only as an event.
Consequence: titles are recorded bridge-side (`titleSource=bridge`); DSH-native titles
are reported separately when observed.

**Cancel / queue control**
Requirement: cancel a turn or mutate the queue.
Evidence: no cancel method, no queue snapshot or mutation on the wire.
Consequence: `dsh_cancel` for turn and queue scopes returns `unsupported_capability`.
Closing the runtime is never reported as a cancelled turn.

**Steering**
Requirement: place an input as a mid-turn steer.
Evidence: no steering placement on the wire.
Consequence: `dsh_followup mode=steer` is rejected; `queue` is the only accepted
placement.

**Route fallback**
Requirement: recover from an unavailable adapter or model.
Evidence: probe 1 — the handshake fails and no session is created.
Consequence: an unavailable adapter/model fails `initialize`; no prompt is sent and
nothing silently falls back.

**Session identity**
Requirement: stable session ids.
Evidence: the wire has no create method; ids are minted bridge-side and persisted by the
runtime.
Consequence: a session id is a bridge-local identity until the runtime persists it.
Resume requires the same home, profile, and route.

**Client time zone**
Requirement: transmit the client's time zone.
Evidence: not transmittable on this wire.
Consequence: the runtime profile's own time zone applies; the bridge reports
`clientTimeZoneApplied: false` instead of pretending.

**Approval identity**
Requirement: a stable approval id across processes.
Evidence: the wire carries no approval identity.
Consequence: approval ids are bridge-local (`approvalIdSource: "bridge-local"`); the
JSON-RPC request id is the correlation key.

### 6.1 Gaps mitigated in round 2

Round 2 did not remove any wire limitation above — the wire is unchanged. It removed
several ways the *bridge* could lose or misreport what the wire did deliver. Every item
in this subsection is pinned by a mock-runtime test; none of it is live evidence, and none
of it is an upgrade of the capability matrix.

| Was | Now |
| --- | --- |
| Events emitted during `initialize` or `session/resume` — before the RPC result — were dropped, because `subscribe` ran after the handshake. Observation coverage could therefore start already incomplete. | The order is `start → onRequest → subscribe → startPump → initialize → (resume) → bounded drain barrier`, and `acquire()` returns only after everything already received is persisted. A drain that exceeds its bound marks coverage partial instead of claiming completeness. |
| A shutdown could be recorded as clean while the notification queue still held events; a timer race meant the pump was never awaited. | Teardown is bounded `close()` → bounded queue drain → subscription close → one exit report, and `cleanShutdown` requires **both** a proven process exit and a drained queue. |
| Every bridge-initiated close recorded a transport failure, so each normal shutdown looked partial and left a gap that then blocked the resume path. | A close this bridge initiated is the expected end of the stream and is not recorded as a failure. |
| An unproven process exit freed its capacity slot, so a replacement runtime could start beside a process that might still run. | The slot is retained and a replacement for that task is refused with `runtime_unavailable` (not retryable) until an operator verifies no orphan remains. |
| Concurrent acquisition could exceed the cap or start two runtimes for one task. | Per-task in-flight joining plus a synchronous test-and-reserve slot; a failed start releases the slot; active work is never killed for capacity. |
| The view revision was a sum of generations and record counts, so a removed-and-rebuilt runtime could reuse an earlier revision and accept a stale write. | A strictly monotonic view clock (observation counter plus manager lifecycle counter): a changed view can never reuse an earlier revision. |
| A fresh turn could be stamped `interrupted`, because an SDK status of *unknown* was read as "not running". | `interrupted` is derived only when the absence of a running turn is authoritative — a Host catalog report, or a known-false observation state. The Host-backed rule is unchanged. |

Two consequences for how these results must be read:

- The **history-authority** gap is unchanged: the observed record is still not DSH history.
  What changed is that a missing event can no longer be caused by the bridge's own ordering
  on the handshake or shutdown path, and coverage is now explicit in both places.
- **Observation coverage** is stated, not assumed. A partial drain degrades the task and
  blocks normal follow-ups rather than returning a transcript that looks complete.

## 7. Pinned pair

| Component | Pin |
| --- | --- |
| Client | `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3` |
| Runtime | `@deepseek-ai/dsh@0.2.2-rc.3` |
| Node.js | >= 22 |
| Platform verified | Windows only |

The pair is unchanged from round 1; round 2 changed bridge behavior only. The round-2
baseline is git HEAD `428c69f590d569b0c7cfbdb831bfa88beedc938b` with those changes
uncommitted, package version `0.1.0-alpha.7`. The Desktop runtime on the same machine stays
`0.2.1-rc.2` in its own process and home, and is not part of this pin.

macOS not verified. The dependency installs as a normal npm dependency from the registry
— it is not a `workspace:*` link, so no monorepo checkout is required. A user may
instead point `DSH_SDK_BIN` at a `dsh` CLI module and skip the bundled runtime pin.
