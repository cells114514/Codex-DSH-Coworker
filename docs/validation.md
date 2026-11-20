# Validation guide

## Automated checks

From a clean checkout:

```sh
npm ci
npm run check
npm pack --dry-run --ignore-scripts
git diff --check
```

The CI definition runs build, tests and package preview on Ubuntu/Windows/macOS with Node 22/24/26. Record results for the exact candidate SHA; a workflow definition or an older green run is not a result for a new dependency tree.

Tests use synthetic Hosts and inert caller fixtures. They cover MCP schemas, authorization handoff, process/listener inspection, Gateway admission, session attachment, durable observation, cancellation, questions/approvals, coordination locks and model routing. No inference is required.

## Current evidence

| Area | Evidence | Remaining check |
| --- | --- | --- |
| Runtime source `85fd145` | Windows Node 26.7.0: build and 298/298 tests; Mac Node 24.20.0: build, 297 passed and one Windows-only skip; all nine Ubuntu/Windows/macOS x Node 22/24/26 CI jobs passed; 119 expected package entries | Later author-policy and documentation changes preserve the exercised runtime and dependency tree |
| Public source `89bdd59`, 2026-10-27 | Nine CI jobs passed; Windows 308/308, Ubuntu/macOS 307 passed with one Windows-only skip; 119 package entries; both CodeQL analyses had zero results; main author check passed | Record subsequent source revisions through their own GitHub checks |
| Official Windows Desktop, 2026-10-26 | Native startup, owned-listener discovery and Gateway admission; one inherited read-only task plus same-root follow-up completed; fixture unchanged and claim released | Historical task reconciliation retains an unrelated lock warning; Desktop session visibility and original pinned-icon grouping were not qualified |
| Apple Silicon Mac, 2026-10-27 | Controlled-start `85fd145`, Gateway admission and one inherited read-only task plus same-root follow-up completed; fixture unchanged and final claim released | Intel live parity and Desktop session visibility remain unverified; first reply included one extra confirmation sentence |
| rc.3 contract | Scoped source comparison plus synthetic dynamic-catalog, effort and rejection regressions | Real rc.3 account/catalog availability |
| Vision/ModLens | Automated route policy and failure behavior | Current provider/tool execution and visual completion |

The qualified runtime source is `85fd1451d4c8ac1e3234e4ec8237f49d58545e97`, tree `3c48cefe7f9511b512369e36b6dbe9a69ba27cf2`. Windows exercised installed `26f22a5807e374ffa1de761644b19dde84aac9e1`: all 93 built runtime files were byte-identical to `85fd145`, with the same lockfile and canonical Skill. Mac exercised the exact `85fd145` installation. Subsequent publication-document changes do not change those runtime identities.

Recorded environments:

| Component | Windows | Apple Silicon Mac |
| --- | --- | --- |
| Node / npm | 26.7.0 x64 / 11.19.0 | 24.20.0 arm64 / 11.19.0 |
| Codex app metadata | OpenAI.Codex 26.1021.3705.0 | 26.1021.31345, bundle build 21828 |
| Official Desktop bundle | 0.2.1-rc.2 | 0.2.1-rc.2 |
| Packaged core metadata | 0.2.1-rc.2 | Not independently sampled |

These are recorded installation metadata, not guarantees about later automatic updates. Mac hardware/OS were reported as M5 Max and macOS 26.5.1. A wire-reference label does not establish the running core version.

Both smokes used `inherit` and reported `deepseek-official/deepseek-flash/high` with `persistsAsDshDefault=false`. No unexpected model selection, visual fallback, pending interaction or automatic approval occurred. Source, build, configuration and Skill stayed unchanged. Two prompts were submitted per qualified run; provider-internal inference counts, billing and cache hits were not exposed.

On Mac, the first answer correctly described the manifest but added a confirmation sentence beyond the requested three lines. After an early claim release, one metadata lookup and an exact-root read-only attach reacquired that same mapping without a prompt or model selection. The single follow-up completed on the original root. This qualifies communication and read-only continuation, not exact-format compliance. Earlier Mac attempts retaining a pre-installation connection are excluded from the alpha.6 evidence.

The Mac user observed one original Dock icon; Windows direct startup showed a separate taskbar group. Manual Desktop session visibility, Intel live parity, filesystem crash behavior, current visual providers and broader question/approval/cancel flows remain outside these smokes.

Public source `89bdd594d8b76f45de7c236e432d188666644748` passed [CI](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/actions/runs/40496150696), [CodeQL](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/actions/runs/40496151155) and the [maintainer-author check](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/actions/runs/40496150865). Its ten additional tests cover author identity and coauthor policy; its runtime, dependencies and Skill remain those qualified above. Later documentation-only revisions use their GitHub checks for the final source result.

Private Review CI is recorded separately. Code scanning was unavailable in that repository; a private snapshot's CI result does not substitute for the public CodeQL analysis.

### Maintainer-author gate

Ten regression tests cover the canonical account/noreply identity, spoofed names or account IDs, bot authors, incomplete metadata and coauthor trailers. A temporary PR also verified the live required status: approved maintainer metadata reached `CLEAN`; an unauthorized-author fixture reached `BLOCKED` while ordinary CI and CodeQL remained green. The PR was closed without merge and its branch removed. The [contribution policy](../CONTRIBUTING.md#pull-requests) records the owner's approval requirement and trusted-base workflow boundary.

## SDK backend validation

Scope: **Windows only**, Node 25.6.0, npm 11.8.0, client `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3` against runtime `@deepseek-ai/dsh@0.2.2-rc.3`. The installed Desktop runtime on that machine was `0.2.1-rc.2`; the two are independent processes with independent homes, so version skew between them is expected and is not evidence of a defect. macOS was not exercised. Wire findings, the rejected `0.2.1-rc.2` pairing, and the credential evidence are recorded in [the qualification record](sdk-qualification.md); the dated round-2 run is recorded in [the acceptance results](sdk-live-acceptance-results.md).

Two evidence classes are kept strictly apart below: **automated** (a scripted fake runtime over the RPC boundary, no real process) and **live** (a real runtime driven through the real MCP bridge). Mock coverage is never cited as a live result.

### Automated checks

`npm run check` (build plus tests) passed on Windows with Node 25.6.0, including **401** tests (386 at the end of round 1). The SDK backend suites are:

| Suite | Covers |
| --- | --- |
| `test/sdk-dsh-client.test.ts` | Prompt receipts, observed-event ordering, capability rejections, pending approvals/questions, observation gaps, ownership and identity errors |
| `test/sdk-runtime-manager.test.ts` | Lazy start, handler ordering, capacity, idle reclamation, never-kill-active-work, teardown, crash settlement, slot retention on an unproven exit |
| `test/sdk-lifecycle.test.ts` | Handshake-phase observation, resume-phase events, deduplication, drain-bounded shutdown, handler-failure partials, idempotent close, unproven-exit slot retention, concurrent acquisition, monotonic revision |
| `test/sdk-bridge-service.test.ts` | Capability branching in the shared service: discovery scope, routing rejection, follow-up, tail/status source, cancel rejection |
| `test/sdk-observed-event-store.test.ts` | Durable append before derived state, duplicate/conflict identity, redelivery dedupe, overflow, corruption and coverage reporting |
| `test/runtime-registry.test.ts` | Locked claim transactions, identity immutability, owner conflict, clean-shutdown takeover, record validation |
| `test/sdk-doctor.test.ts` | Static report, path/home observations and the explicit `--probe-sdk` handshake |
| `test/sdk-setup.test.ts` | `--backend sdk` installation planning, forbidden combinations and generated MCP environment |

All of these drive a scripted fake runtime (`test/support/fake-sdk-runtime.ts`). No test loads the official package, spawns a real runtime, or produces qualification evidence.

### Defects fixed in round 2

Each row names the defect, what prevents it now, and the test that pins it.

| Defect | Prevention | Pinning test |
| --- | --- | --- |
| Events committed during `initialize` or `session/resume` (before the RPC result) were dropped, because the subscription was created after the handshake | `acquire()` order is `start → onRequest → subscribe → startPump → initialize → (resume) → bounded drain barrier`, and it returns only after already-received notifications are persisted | `sdk-lifecycle`: "persists events emitted during initialize…", "persists events emitted while a session is being resumed, in wire order" (also asserts `subscribe` before `resumeSession`) |
| `dispose()` closed the subscription first and never awaited the pump, so a clean shutdown could be recorded while events were still queued | Bounded `client.close()` → bounded queue drain (default 2000 ms) → subscription close → single exit report; `cleanShutdown` requires a proven exit **and** a drained queue | `sdk-lifecycle`: "processes the last events emitted during close…", "marks a shutdown partial when the drain bound is exceeded" |
| A bridge-initiated close was recorded as a transport failure, so every normal shutdown looked partial and left a gap that blocked resume | A close this bridge initiated is the expected end of the stream and is not recorded as a failure | `sdk-lifecycle` drain cases plus the clean-exit assertion in `sdk-dsh-client` "closes idempotently…" |
| An unproven process exit freed its capacity slot, allowing a replacement beside a possibly-live process | The slot is retained in `usedCapacity` and a replacement for that task is refused with `runtime_unavailable` (not retryable) | `sdk-runtime-manager`: "retains the capacity slot and blocks a replacement when shutdown is unproven" |
| Concurrent acquisition could exceed `maxRuntimes` or start two runtimes for one task | Per-task in-flight joining plus a synchronous test-and-reserve slot; a failed start releases the slot | `sdk-lifecycle`: "spawns exactly one runtime for concurrent acquires…", "never exceeds maxRuntimes under concurrent…", "releases its reservation when a start fails" |
| The view revision was a sum of generations and record counts, so a removed-and-rebuilt runtime could reuse an earlier revision | A strictly monotonic view clock (observation counter + manager lifecycle counter): stable while nothing changes, never decreasing | `sdk-lifecycle`: "keeps the connection revision strictly monotonic across runtime removal and rebuild" |
| A fresh SDK turn could be stamped `interrupted`, because an *unknown* observed running state was read as "not running" | `interrupted` is derived only when the absence of a running turn is authoritative: a Host catalog report, or a known-false observation state | `bridge-service`: "SDK backend: an unknown observed running state is never derived as interrupted" (asserts the Host branch still resolves `interrupted`) |
| A redelivered event with a newer observation timestamp was reported as a corruption conflict | Duplicate identity is `(sessionId, seq)` plus lineage and payload; `observedAt` is excluded | `sdk-observed-event-store`: "treats a redelivered event with a new observation time as a duplicate" |

Two operational consequences of these fixes, both verified live:

- A normal bridge shutdown now ends with a clean, gap-free record. In the round-2 run the registry recorded `cleanShutdown: true`, `degraded: 0` and 18 persisted events after teardown; before the fix the same path recorded a transport failure and a degradation.
- A shutdown that cannot prove its drain degrades the task instead: `dsh_status.observation.complete` becomes `false` and normal follow-ups are refused with `observation_gap`. This is intentional and covered by the mock suite; it was not triggered live because no live shutdown failed its drain.

### Real-machine probes

| Probe | Result |
| --- | --- |
| `initialize` with a valid default route | Succeeded in about 2.6 s; returned `{serverInfo: {name: "deepseek-harness-sdk-runtime", version: "0.0.1"}}`. This authenticates the route's existence only |
| `initialize` with an unknown provider/model | Rejected in about 2.6 s with `JsonRpcResponseError` ("no adapter registered for provider"); no session was created and no prompt was sent |
| `initialize` with `deepseek-account` | Accepted — the account route is mounted in the `sdk` profile. Acceptance at handshake time does not imply a usable login |
| Prompt receipt | Returned a UUID `messageId` immediately; this is a durable enqueue receipt, not a finished turn |
| One real turn | Emitted `user/message`, `request/header`, `request/context`, `session/title`, `assistant/attempt`, `step/end`, `turn/end`; `seq` advanced monotonically. Every turn ended with a **model-boundary error**, never assistant text: `MISSING_CREDENTIAL` on a fresh home (API-key route), `AUTH`/401 when a copy of the local credential store was seeded, `ACCOUNT_SIGN_IN_REQUIRED` on the account route without a grant |
| Second process resuming the same session (same home, profile and route) | Succeeded; new events began at a later `seq` and earlier events were **not** re-broadcast |
| `dsh-agentlink-doctor --probe-sdk` | One bounded `initialize` handshake completed in about 7.3 s |

The resume probe is why all returned history comes from the bridge's own observation record and why coverage is stated explicitly: the runtime does not replay, and its persisted session log is an internal format the bridge must not parse.

### Live scenario matrix

Run on 2026-11-17/18 with the checked-in driver, one model call, and the default route; the `deepseek-account` variant was run once more as a separate probe. `BLOCKED` is a failure, not a pass.

Two phases ran on this machine. **Phase A** (before any credential existed) was `BLOCKED` on the API-key route and is kept as history: `MISSING_CREDENTIAL` on a throwaway home, `AUTH`/401 with a seeded copy, `ACCOUNT_SIGN_IN_REQUIRED` on the account route without a grant. **Phase B** used an isolated SDK home (`<user home>/.dsh-sdk-test`) that was signed in once through a web-capable Host (`dsh web`, runtime 0.2.2-rc.3, loopback only), with the Desktop home left untouched and no API key used. Phase B results:

| ID | Scenario | Verdict | Evidence | Result |
| --- | --- | --- | --- | --- |
| L1 | One successful text turn | **PASS** | live | `execution: turn_completed`, `finalMessageStatus: available`, reply length 11, runtime `ready`, observation complete — route `deepseek-account` / `deepseek-flash` |
| L2 | Same-task context continuity | **PASS** | live | follow-up stayed on the same `sessionId`; a random marker was stored, and the recall turn completed with a non-empty reply (length 25) |
| L3 | Normal shutdown then exact resume | **PASS** | live | bridge closed (`cleanShutdown` on both task records), a new bridge resumed the exact task/session, the next turn completed, and `observation.complete` stayed `true` — i.e. the drain fix produced no false gap that would have refused the resume |
| L4 | Runtime user question | **PASS** | live | the runtime asked one question, the bridge surfaced it as a pending envelope, the driver answered it, and the turn completed with a 56-character reply |
| L5 | One runtime approval | **PASS** | live | an out-of-workspace write raised one sandbox-escalation approval; both decisions were exercised — the driver's default `reject` (target absent, filesystem-asserted) and an operator `allow_once` (`allowed: true`, turn completed). The operator decision has **not** been re-run since the `targetWritten` assertion was added, so "the allowed write landed" is unproven; the assertion itself is proven on the reject path |
| L6 | Two isolated tasks | **PASS** | live | two tasks in two workspaces, two distinct sessions, two live runtimes at capacity 2, both terminal, no marker cross-talk between the transcripts |
| L7 | One task's runtime dies | **PASS** | live | one bridge-owned runtime child stopped (parent-pid verified); the victim task recorded `observation.complete: false`, its follow-up was refused in 270 ms, and the other task completed another turn |

Phase B overall verdict: `PASS`, process exit code `0` for `--stages L1` and for `--stages L2,L3`. Phase A overall verdict was `FAIL` with exit code `1`, which is why the credential work came first.

Phase C also covered the two isolation scenarios on the same route and home: **L6** (two workspaces, distinct sessions, two live runtimes, no cross-talk) and **L7** (one bridge-owned runtime child stopped after verifying its parent is the bridge this driver started). L7's gate is explicit — `--kill-owned-runtime` must be passed — the driver never matches processes by image name, and it does not retry the refused follow-up or the killed turn.

**Phase C** reused the same isolated home but switched the route to a customer-declared OpenAI-compatible gateway — OpenCode Go (`opencode-go`, base URL `https://opencode.ai/inference/go/openai/v1`, model `deepseek-v4.1-flash`, `compat.thinkingFormat: deepseek`, key supplied through the home's credential store). L1, L2 and L3 all `PASS` with exit code `0`; a tool-forcing prompt produced one `tool/call` and one `tool/result`; a reasoning prompt produced an assistant `reasoning` block (63 characters) next to a 4-character answer; and the route completed every turn while carrying the gateway-required `x-opencode-session` header, whose presence, per-session stability and cross-session distinctness were proven against a local stub before the live run. Phase C timings are in [acceptance results](sdk-live-acceptance-results.md).

Isolation checks after Phase B: the Desktop home's `.credentials.yaml` was unchanged in size and modification time; the test home holds its own `profiles/`, `sessions/`, `storages/`, credential store and bridge home; both task records report `cleanShutdown: true`, zero recorded degradations, and 47/19 persisted observed events.

### Segmented timings (receipt and observability spans, not model latency)

Phase A (blocked runs, `deepseek-official` / `deepseek-account`):

| Span | `deepseek-official` | `deepseek-account` (no grant) |
| --- | --- | --- |
| MCP connect (`client.connect`) | 456 ms | 520 ms |
| `dsh_delegate` total: runtime spawn + `initialize` + prompt receipt | 6011 ms | 5769 ms |
| First observed event after that receipt | 150 ms | 62 ms |
| Task terminal state after the receipt | 490 ms | 402 ms |

Phase B (successful runs, `deepseek-account`):

| Span | L1 run | L2/L3 run |
| --- | --- | --- |
| MCP connect | 433 ms | 430 ms |
| `dsh_delegate` total (spawn + `initialize` + receipt) | 6254 ms | 5954 ms |
| First observed event after the receipt | 31 ms | 46 ms |
| Task terminal state after the receipt | 1057 ms | 1121 ms |
| Follow-up receipt (context continuity) | — | 119 ms / 95 ms |
| Recall turn terminal | — | 1488 ms |
| Bridge clean shutdown | — | 82 ms |
| Reconnect + exact resume receipt | — | 402 ms / 5938 ms |
| Post-resume turn terminal | — | 1126 ms |

`dsh_delegate` returning is a *receipt* measurement, not task completion, and none of these numbers is a model-latency or throughput claim. A follow-up receipt of tens of milliseconds (measured in round 1) is likewise receipt latency only.

### Running the live driver

```sh
npm run build
node docs/operator-tools/sdk-live-acceptance.mjs --stages L1,L2,L3
```

Path flags accept `%USERPROFILE%` and `$env:USERPROFILE` spellings: an unexpanded shell variable would otherwise arrive as a literal directory name, so the driver expands both forms and refuses an unknown variable by name.

Options that matter: `--stages` selects scenarios so a confirmed environment does not repeat everything; `--home` uses an operator-supplied SDK home (otherwise the driver creates a throwaway one and deletes it); `--work` / `--work-two` choose workspaces; `--stage-limit` bounds each scenario; `--max-model-calls` caps model calls; `--interaction-policy deny|allow` decides how runtime approvals/questions are answered (default `deny`); `--provider` / `--model` select the runtime route; `--json-out` writes the machine-readable report. The driver only deletes directories it created, tears down in `finally`, prints `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN` with the evidence class per scenario, and exits non-zero unless every requested scenario is `PASS`. It never copies a credential store and never prints prompt text, reply text, credentials, or real task/session identifiers.

### L7 supervised procedure (not run this round)

L7 needs one specific runtime process stopped, and it must be proven to be one this bridge started. A supervised run is safe; batch-killing by image name is not.

1. Start the bridge yourself with SDK configuration and create two tasks in two different workspaces (for example `--stages L6` in the driver, or two `dsh_delegate` calls from a Codex session).
2. Identify the bridge process you started, and from it the single child `dsh`/node process whose command line and start time correspond to the target task's runtime. Do not match by image name alone, and do not target the Desktop application or another caller's bridge.
3. Terminate only that child process.
4. Observe the affected task with `dsh_status`: it must not report success, must not resend the earlier input, and must show `interrupted`/`failed` with an explicit observation gap or partial coverage.
5. Observe the other task: its turn and events must be unaffected, and its runtime must still be usable.
6. Restart the bridge afterwards and confirm the affected task's recovery path returns a truthful `observation_gap` refusal rather than a silently shortened transcript.

L4 was exercised with the default `deny` policy only: the question was answered by the driver, and an operator-authored answer is **not** verified. L5 was exercised with both decisions: `deny`/`reject` by the driver and a human `allow_once` through `--interaction-policy ask`, which prints the request on stderr and blocks for input; an empty answer, a closed stdin or the 180 s bound still falls back to `reject`, so a missing human can never become an approval.

**What an approval grants.** The decision is not a permission for the named file. The runtime asks to escalate the sandbox, in this environment to `danger-full-access`, and `allow_once` grants exactly that scope for that one call: a subsequent command in the same turn is not limited to the file that triggered the request. The driver prints the requested escalation with the request, and the closure applies to the single call only — it is not remembered as a standing grant.

Under `workspace-write` the runtime auto-approves commands inside the workspace, so L5 deliberately targets a write outside it — that is what raises an escalation, and the driver checks the outcome in the filesystem instead of trusting the decision alone.

### Not verified

None of the following has live evidence, and none is claimed:

- macOS of any kind.
- The `allow_once` path against the filesystem assertion (the approval itself and the completed turn are verified; "the allowed write landed" is not).
- An operator-authored answer to a runtime question (the driver's own answer is what was verified).
- A runtime-initiated question cancellation.
- Two concurrent live runtimes and therefore real capacity pressure with reclamation (L6 is `NOT_RUN`).
- A crash mid-turn, an unproven-exit restart, or a partial-drain shutdown against a real runtime (L7 is `NOT_RUN`; the supervised procedure below has not been executed).
- History replay or reconstruction beyond what one process observed.
- The API-key route: no valid key exists in this environment, so `deepseek-official` remains transport-only evidence. Only the account route produced a successful live turn, and only from a home that completed one browser sign-in.

Two things previously on this list are now verified and are removed: a successful end-to-end assistant reply, and same-task context continuity plus a clean-shutdown/restart-resume cycle (L1, L2, L3 above).

## Visual routing validation

The automated contract covers:

- Non-visual low/high complexity selects Flash/Pro when no explicit profile is supplied.
- Visual low selects official Flash Vision with exact image-capability evidence; high asks for an explicit choice between that route and ModLens Pro.
- ModLens Flash is never a first-choice route under declared visual policy. Selection/verification can make three attempts for qualifying timeout, unreachable-Host or HTTP 5xx failures, then one ModLens Flash fallback attempt.
- Cancellation, invalid input, missing models/efforts, provider ambiguity, permissions, credentials, protocol/configuration errors and prompt-write failures do not trigger fallback.
- Fallback results provide a short notice and a `dsh_status.visualFallback` marker. A failed prompt does not persist a success marker.
- Omitting visual-policy fields preserves an explicitly supplied legacy `modelProfile="modlens-flash"`.
- Text prompts carry DSH-accessible image paths; image bytes are not uploaded by the bridge.

The official rc.3 session catalog omits modalities. A model name alone cannot authorize image input. The separately scoped legacy vision exception and Code Mode instructions are described in [Gateway capabilities](official-desktop-gateway.md#models-and-capabilities).

## rc.3 catalog regressions

`test/rc3-model-contract.test.ts` exercises the real adapter against a synthetic Gateway:

- Fresh session projections take precedence over the global default.
- Model withdrawal/restoration and changing effort availability are reflected on the next read.
- An available API-key Pro cannot replace a missing account Pro.
- Current/legacy Flash IDs retain their exact provider, and unadvertised efforts are rejected.
- `CLIENT_UPGRADE_REQUIRED`, `MODEL_UNSUPPORTED`, permission and configuration rejections at selection or prompting cause no replay or ModLens switch; raw provider details stay out of errors.
- Withdrawal after an accepted selection prevents prompting even when the projection still matches.

These injections qualify bridge behavior at an RPC boundary, not the exact error shape produced by every provider deployment. The adapter retains its rc.2 wire qualification label separately from actual product-version evidence.

## Installation and portability

Use a fresh clone on another machine. Same-machine worktrees depend on the source clone's metadata. Keep the tools checkout and Node path stable, and use a fresh local bridge home for a new machine.

Official Desktop setup uses `--gateway --desktop-auto --no-preset` on Windows or macOS. Legacy community Desktop automatic discovery remains Windows-only. A static official Gateway uses an explicit `--gateway --host <origin>`.

Preview before writing. Review conflicts, then verify the selected MCP entry and the two Skill files against canonical source. Setup replaces only approved targets and reports backups or partial success. Repository scope is `.agents/skills/codex-dsh-orchestrator/`; user-wide scope can use `$HOME/.agents/skills/codex-dsh-orchestrator`. Update existing legacy global installations in place to avoid duplicate names.

The startup handoff launches applications. Schedule downtime, finish active work, quit Desktop/Codex normally and follow the [operator startup instructions](official-desktop-gateway.md#operator-startup). Preserve the old install and backups for rollback.

### Verify runtime loading

1. Record candidate SHA/tree, package version and actual Node executable.
2. Verify MCP points at that candidate's built entry and that one `dsh_agentlink` is loaded.
3. Confirm the Skill selector/explicit invocation loads the canonical content.
4. Confirm unrelated MCP/Skill configuration and the source tree remain intact.

After replacement, a reconnect timestamp alone cannot prove new code loaded: an older process can reconnect after sleep. Verify the effective entry point, fixed build files, startup context and new caller process together. A retained pre-installation connection does not qualify the replacement build.

Repeat this after moving a checkout, changing Node or replacing an installation.

### Connection-only acceptance

`npm run doctor` is a configuration/lock preflight. In Gateway mode it intentionally leaves admission `not_probed`.

After separate connection approval, call `dsh_host_status` once. It can exchange startup authorization and open one API Peer, but creates no session or prompt. Record successful connection/resolution epochs, availability and capabilities without exposing endpoint or authorization details.

On failure, use sanitized stage/reason diagnostics. Leave processes and lock directories intact; report the failure before changing the installation or restarting applications.

## Windows and macOS non-visual acceptance

Use the same approved source SHA and dependency tree on both platforms. Obtain approval for model use, keep the DSH route inherited, and use a disposable workspace containing a small non-sensitive package manifest.

1. Record file hashes and current source/configuration identity.
2. Delegate one read-only task asking for the manifest's project name, version and short purpose.
3. Observe with `dsh_status`, bounded `dsh_wait` and `dsh_tail.nextCursor` until a real terminal outcome. A quiet 30-second window is only an observation window.
4. Check the returned answer and unchanged workspace hashes. Confirm no automatic approval, unexpected model selection or visual fallback.
5. After a clean first turn, send one `dsh_followup` asking for a one-line summary. Confirm the same root continues.
6. Release the claim after the follow-up. A cooperative read-only claim does not enforce the DSH filesystem sandbox.
7. Separately record whether the intended session is visible in Desktop. API success alone cannot establish UI visibility.

Report failures before attempting another root session. Record sanitized outcomes; keep credentials, prompts, personal paths, endpoint details and real identifiers in private operator notes.

## Optional interaction and reuse acceptance

Questions, approvals, cancellation and existing-session attachment are separate tests. Use ordinary harmless interactions; do not create a sandbox escape to provoke an approval. Answer typed questions through `dsh_answer_question`, and confirm each approval requires the user's explicit decision.

For reuse, metadata-only discovery must find one unique mapped idle root at the exact canonical workspace. Attach with fresh `sessionId`, `updatedAt`, `cwd` and title preconditions; attachment sends no prompt or model-selection write. A later approved follow-up continues that root. Stale, running, incomplete or ambiguous candidates are refused.

## Public package and release evidence

Inspect the exact tracked tree, new reachable history and package inventory. Keep credentials, personal paths, real identifiers and internal maintenance plans out of public artifacts. Preserve MIT/NOTICE attribution and `private: true`.

A source archive and an npm package have different inventories: `dist/` is ignored in Git and generated locally, while the package preview includes it. Exclude local `node_modules`, generated Skill copies, bridge state, logs and archives from the source release. See [Release checklist](release-checklist.md).

Revalidate the final candidate after dependency/runtime, Host, caller, routing or reconciliation changes. Keep automated results, connection acceptance and real task completion as distinct evidence.
