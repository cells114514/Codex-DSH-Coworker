# SDK backend — live acceptance results (round 2)

Recorded: 2026-11-18. Platform: Windows, Node 25.6.0, npm 11.8.0.
Driver: [`docs/operator-tools/sdk-live-acceptance.mjs`](operator-tools/sdk-live-acceptance.mjs).

This file is a dated results record, not a plan or a claim of capability. Round-1 samples are kept as history and are not restated as current success.

## Baseline

| Item | Value |
| --- | --- |
| Git HEAD | `428c69f590d569b0c7cfbdb831bfa88beedc938b` |
| Working tree | round-1 and round-2 changes present, uncommitted |
| Package version | `0.1.0-alpha.7` |
| SDK client | `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3` |
| SDK runtime | `@deepseek-ai/dsh@0.2.2-rc.3` |
| Desktop runtime on the same machine | `0.2.1-rc.2` (separate process and home, not part of this run) |
| Locked dependency graph | `package-lock.json` as committed in the working tree |

## Command lines used

```sh
npm run build
node docs/operator-tools/sdk-live-acceptance.mjs --stages L1,L2,L3
node docs/operator-tools/sdk-live-acceptance.mjs --stages L1 --provider deepseek-account --model deepseek-flash --stage-limit 120
```

Both runs used a script-owned throwaway DSH home and bridge home, the default interaction policy (`deny`), and a model-call budget of 6. One model call was consumed in each run.

## Scenario results

| ID | Scenario | Verdict | Evidence class | Reason |
| --- | --- | --- | --- | --- |
| L1 | One successful text turn | `BLOCKED` | live | `execution: failed`, `finalMessageStatus: terminal_missing_final`, `turnErrorCode: MISSING_CREDENTIAL` |
| L2 | Same-task context continuity | `BLOCKED` | live | not attempted; L1 produced no successful turn |
| L3 | Normal shutdown then exact resume | `BLOCKED` | live | not attempted; same gate as L1 |
| L4 | Runtime user question | `BLOCKED` | live | same gate; also needs the model to ask naturally |
| L5 | One runtime approval | `BLOCKED` | live | same gate; the driver never auto-grants (default policy `deny`) |
| L6 | Two isolated tasks | `BLOCKED` | live | same gate |
| L7 | One task's runtime dies | `BLOCKED` | live | same gate; needs the supervised procedure in the validation guide |

Account-route variant of L1: `BLOCKED`, `turnErrorCode: ACCOUNT_SIGN_IN_REQUIRED`.

Overall verdict: `FAIL`. Process exit code: `1`. `BLOCKED`, `FAIL` and `NOT_RUN` all count as a failed acceptance; only `PASS` is a pass.

## Timings

Receipt and observability spans only. None of these is a model-latency or throughput claim.

| Span | Default route | `deepseek-account` route |
| --- | --- | --- |
| MCP connect | 456 ms | 520 ms |
| `dsh_delegate` total (runtime spawn + `initialize` + prompt receipt) | 6011 ms | 5769 ms |
| First observed event after the receipt | 150 ms | 62 ms |
| Task terminal state after the receipt | 490 ms | 402 ms |

Additional observation from a retained-home run (same build, `--no-cleanup`): after the driver closed the bridge, the runtime registry recorded `cleanShutdown: true`, `observationEpoch: 1`, `titleSource: bridge`, zero recorded degradations, and 18 persisted observed events. That is the round-2 drain fix working on a real runtime: the same path previously recorded a transport failure and a degradation.

## Phase B — after one browser sign-in in an isolated home

Recorded 2026-11-18 on the same machine, same build. The operator created an independent SDK home
(`<user home>/.dsh-sdk-test`), started a web-capable Host for that home only (`dsh web` from the pinned
runtime `0.2.2-rc.3`, loopback `127.0.0.1:3187`, `--no-open`), and completed one account sign-in in the
browser. The Desktop home was not used, not modified, and not migrated. No API key was used and no `refs`
entry exists in the test home's credential store.

Grant structure check (structure only, no token, payload, or account identifier read out): record
`deepseek-account-platform/default` with `kind: grant`, issuer host `platform.deepseek.com`, token present —
which is what `resolveToken` requires (official inference destination, non-localhost issuer). The sign-in
Host was then stopped and its port released.

The structure check was done with [`docs/operator-tools/inspect-credential-structure.mjs`](operator-tools/inspect-credential-structure.mjs), which prints only record keys, `kind`, the issuer host, and whether a token field exists — no token, payload, or account identifier.
### Results

| ID | Verdict | Evidence | Detail |
| --- | --- | --- | --- |
| L1 | `PASS` | live | `execution: turn_completed`, `finalMessageStatus: available`, reply length 11, runtime `ready`, observation complete, route `deepseek-account`/`deepseek-flash` |
| L2 | `PASS` | live | same `sessionId`; marker stored on one turn, recall turn completed with a non-empty reply (length 25) |
| L3 | `PASS` | live | bridge closed cleanly, new bridge resumed the exact task/session, next turn completed, `observation.complete` still `true` |
| L4 | `NOT_RUN` | — | not requested in this phase |
| L5 | `NOT_RUN` | — | not requested in this phase |
| L6 | `NOT_RUN` | — | not requested in this phase |
| L7 | `NOT_RUN` | — | not requested in this phase |

Commands and verdicts:

| Command | Stages run | Verdict | Exit code | Model calls |
| --- | --- | --- | --- | --- |
| `--stages L1 --home <test home> --provider deepseek-account --model deepseek-flash` | L1 | `PASS` | 0 | 1 |
| `--stages L2,L3 --home <test home> --provider deepseek-account --model deepseek-flash` | L1 (precondition), L2, L3 | `PASS` | 0 | 3 |

### Timings

Receipt and observability spans only, not model latency.

| Span | L1 run | L2/L3 run |
| --- | --- | --- |
| MCP connect | 433 ms | 430 ms |
| `dsh_delegate` total (spawn + `initialize` + receipt) | 6254 ms | 5954 ms |
| First observed event after receipt | 31 ms | 46 ms |
| Task terminal after receipt | 1057 ms | 1121 ms |
| Continuity follow-up receipt / recall receipt | — | 119 ms / 95 ms |
| Recall turn terminal | — | 1488 ms |
| Bridge clean shutdown | — | 82 ms |
| Reconnect / exact-resume receipt | — | 402 ms / 5938 ms |
| Post-resume turn terminal | — | 1126 ms |

### What this changed in the evidence

- The observation fixes are confirmed live: both task records show `cleanShutdown: true` with zero recorded
  degradations, and the restart-resume path passed the coverage gate instead of being refused with
  `observation_gap` — the failure mode the round-2 drain fix removed.
- The credential blocker is resolved **for the account route only**, and only by an explicit, operator-performed
  browser sign-in in an isolated home. The API-key route remains without a valid key and stays transport-only
  evidence.
- Still mock-only: approvals, native user questions, two concurrent live runtimes, a supervised runtime kill,
  a partial-drain shutdown, and an unproven exit.

### Note about `runtimeRecords`

L3 reports `runtimeRecords: 2` because the driver counts files in `runtimes/`, i.e. task records — the earlier
L1-only run left one, this run added another. It is not two runtime generations for one task.
## Phase C — OpenCode Go route (registered, header verified, live blocked by an expired key)

Recorded 2026-11-18. Same build, same isolated SDK home, Desktop home untouched.

### What was registered

The profile's dormant `llm-pi-ai` row was configured through
`<test home>/profiles/sdk/cordis.patch.yml`, plus one local plugin:

| Item | Value |
| --- | --- |
| Route | `opencode-go` (custom; not a shipped catalog route) |
| Protocol | `openai-completions` |
| Base URL | `https://opencode.ai/inference/go/openai/v1` |
| Model | `deepseek-v4.1-flash` |
| Credential | `apiKeyEnv: OPENCODE_GO_API_KEY` — a reference, not a secret |
| Wire compatibility | `compat.thinkingFormat: deepseek` |
| Session header | local plugin on the `llm-pi-ai/request-headers` waterfall, value = harness session id |

`--dump-config` confirms the composed tree carries the route, the plugin resolves from
`profiles/sdk/plugins/opencode-session.mjs`, and only the reference name appears — no secret.

### Verified

| Check | Result |
| --- | --- |
| Route registration and handshake | `initialize` with `opencode-go` / `deepseek-v4.1-flash` succeeded |
| Bearer auth reaches the endpoint | the request was authenticated and the endpoint answered with a JSON error body, i.e. the request shape and headers are accepted |
| `x-opencode-session` present | present on every request; equal to the harness session id |
| Stability within one session | two prompts in one session carried the same value |
| Distinctness across sessions | a second session carried a different value |
| `reasoning_content` handling | with a local OpenAI-compatible stub emitting `reasoning_content`, the adapter surfaced reasoning and echoed `reasoning_content` back on the next request |
| Tool-call loop | with the stub emitting a `read` tool call, the runtime executed the tool (`tool/call`, `tool/result`) and completed the follow-up turn (`STUB-TOOL-OK`); the read file was unchanged |

The header and reasoning/tool checks used a local stub, not the Go endpoint: they prove the
profile wiring, not Go's own behavior. Helper scripts live in
[`docs/operator-tools/verify-opencode-session-header.mjs`](operator-tools/verify-opencode-session-header.mjs)
and [`docs/operator-tools/verify-opencode-reasoning-tools.mjs`](operator-tools/verify-opencode-reasoning-tools.mjs).

### Live result: PASS with a valid Go workspace key

Rerun with a fresh `oc_sk_…` key placed in the isolated home's store as `OPENCODE_GO_API_KEY`:

| ID | Verdict | Detail |
| --- | --- | --- |
| L1 | `PASS` | `turn_completed`, final message available (11 chars), observation complete |
| L2 | `PASS` | same session; marker stored then recalled, recall reply non-empty (25 chars) |
| L3 | `PASS` | clean shutdown, exact resume, next turn completed, `observation.complete` still `true` |

| Span | L1 | L2/L3 run |
| --- | --- | --- |
| MCP connect | 530 ms | 458 ms |
| `dsh_delegate` total (spawn + `initialize` + receipt) | 9119 ms | 7374 ms |
| First observed event after receipt | 74 ms | 86 ms |
| Task terminal after receipt | 5147 ms | 8109 ms |
| Continuity receipts (remember / recall) | — | 155 ms / 155 ms |
| Recall turn terminal | — | 3377 ms |
| Bridge clean shutdown | — | 126 ms |
| Reconnect / exact-resume receipt | — | 500 ms / 9158 ms |
| Post-resume turn terminal | — | 3764 ms |

Two further live checks on the same route:

| Check | Result |
| --- | --- |
| Tool calls | a prompt naming an exact file path produced one `tool/call` and one `tool/result`; the final reply carried the file's 14-character marker |
| `reasoning_content` | a reasoning prompt produced an assistant message with a `reasoning` block (63 characters) plus a 4-character text block, so `thinkingFormat: deepseek` parses the gateway's reasoning content |
| Session header | the request path is already stub-verified for presence, per-session stability and cross-session distinctness; the live turns completed, which means the gateway accepted the `x-opencode-session` header it requires |

### Isolation scenarios on this route

| ID | Verdict | Evidence |
| --- | --- | --- |
| L6 | `PASS` | two workspaces, distinct tasks and sessions, two live runtimes at capacity 2, both turns completed, no marker cross-talk in either transcript |
| L7 | `PASS` | the runtime child of task A was stopped after proving its parent is this driver's bridge; A recorded `observation.complete: false`, its follow-up was refused (270 ms), and task B completed a further turn (51-character reply) |

L7 needs the explicit `--kill-owned-runtime` flag. The driver enumerates the bridge's children by parent pid and stops exactly one, never by image name, and it does not retry the refused follow-up.

### Interaction round trips: L4 / L5

| ID | Verdict | Evidence |
| --- | --- | --- |
| L4 | `PASS` | the model called `ask_user_question`; the bridge surfaced one pending `user-question/ask` envelope; the driver answered it under the default `deny` policy and the turn completed (56-character reply). The answer was the driver's own text: an operator-authored answer is not verified |
| L5 | `PASS` | a write outside the workspace raised one sandbox-escalation approval (`escalate sandbox to danger-full-access: outside the session workspace`). The driver rejected it under `deny` (target absent, `decisionConsistent: true`) and an operator answered `allow_once` through `--interaction-policy ask` (`allowed: true`, turn completed). The operator path predates the `targetWritten` assertion, so it proves the decision and the completed turn, not that the allowed write landed |

Both were first attempted in the same workspace as the L1 task, which fails earlier than any prompt because the first task holds the workspace claim; each interaction stage now gets its own workspace, and a rejected `dsh_delegate` is reported with its code instead of a generic `NOT_RUN`.

Pending envelopes are shaped `{ type: "server-request", rpcId, method, payload: { type: "approval/requested" | "question/requested", … } }`; the driver reads `rpcId` and `payload`, which is why the first attempt saw zero interactions while the runtime was already `awaiting_input`.

### What an `allow_once` grants

The approval is a **sandbox escalation**, not a per-file permission. In this environment the runtime asked to escalate to `danger-full-access` because the target was outside the session workspace, and `allow_once` granted that scope for the single call. Nothing narrower should be claimed in a UI, a report, or a handoff: the request names the escalation, and the decision applies to it.

### Operator-driven variant (optional): `--interaction-policy ask`

`--interaction-policy ask` turns the driver into an operator-in-the-loop harness: an approval request or a runtime question is printed on stderr and the run blocks for an answer, falling back to `reject` on an empty answer, a closed stdin or the 180 s bound, so a missing human can never become an approval.

```sh
node docs/operator-tools/sdk-live-acceptance.mjs --stages L4 --home <sdk-home> --provider opencode-go --model deepseek-v4.1-flash --interaction-policy ask --max-model-calls 4
node docs/operator-tools/sdk-live-acceptance.mjs --stages L5 --home <sdk-home> --provider opencode-go --model deepseek-v4.1-flash --interaction-policy ask --max-model-calls 4
```

Path flags accept `%USERPROFILE%` and `$env:USERPROFILE` spellings, so the same command works from cmd and PowerShell without hand-expanding the variable.

L4 asks the model to call `ask_user_question` once; L5 asks it to run `echo APPROVAL-OK` through `pwsh`, which only produces an approval round trip when the sandbox policy demands one — if the runtime auto-approves, the stage reports `NOT_RUN` with that reason instead of pretending it verified an approval.
### Earlier result on the same route: BLOCKED — expired key

`--stages L1 --provider opencode-go --model deepseek-v4.1-flash` reached the endpoint and was
rejected with HTTP 401 and provider code `api_key_expired`:

> This API key has expired. Create a new API key in OpenCode Console and replace it in your
> client or secret store. Signing in again will not renew this key.

The bridge reported the turn as `execution: failed` / `finalMessageStatus: terminal_missing_final`
and classified it `provider_auth_rejected`; no success was fabricated. The expired key was not
left in the store: the credential store was restored to its pre-import state (account grants
only, no `refs`), so a fresh key can come from the store or from `OPENCODE_GO_API_KEY` in the
launching environment.

To finish Phase C: create a new Go workspace key in the OpenCode console, place it in the SDK
test home's credential store as `OPENCODE_GO_API_KEY` (or export that variable for the bridge
process), then rerun the L1 command above. The header, reasoning and tool wiring is already in
place and needs no further change.
## Failure classification used by the driver

| Class | Meaning |
| --- | --- |
| `provider_credential_missing` | The runtime resolved no credential for the API-key route (`MISSING_CREDENTIAL`) |
| `provider_auth_rejected` | The provider rejected the presented credential (`AUTH`, HTTP 401) |
| `provider_account_sign_in_required` | The account route found no usable grant (`ACCOUNT_SIGN_IN_REQUIRED`) |
| `runtime_capacity` | No runtime slot was available |
| `unsupported_capability` | The backend refused a semantic it does not implement |
| `timeout` | The scenario exceeded its bound |
| `other` | Anything else, reported as a failure rather than a block |

A `provider_*` class blocks the remaining model-dependent scenarios so the run does not manufacture repeated identical failures.

## Authentication conclusions

Confirmed: the `sdk` profile mounts two DeepSeek routes — `deepseek-official` (API key, `x-api-key`, resolved from the DSH home's managed store, then the environment, then project and user `.env`) and `deepseek-account` (account grant, `x-dsh-auth-token`, requiring a non-localhost grant whose destination is the official inference origin). Account sign-in is a browser flow that needs a Host web server, which the stdio-only `sdk` profile cannot provide. A successful `initialize` proves the route exists, not that a credential works.

Not confirmed: whether the locally stored key is expired or wrong; whether the local Desktop grant would satisfy the account route.

Next operator action (any one unblocks L1; never paste a secret into a chat transcript or a commit):

1. Store a valid API key in the SDK test home through the native Models page, or export the provider key variable in the environment that launches the bridge, keeping `deepseek-official`.
2. Explicitly authorize using the existing DSH home that already holds the Desktop login, and run with `DSH_SDK_PROVIDER=deepseek-account` plus a listed model. This writes new sessions into that home.
3. Perform one browser sign-in in the SDK test home through a web-capable profile that shares the same `DSH_HOME`, then use `deepseek-account`.

After any of these, rerun `--stages L1` first; only extend to `L2,L3` once L1 passes.
