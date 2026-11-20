# Changelog

This file records user-visible changes to Codex-DSH-Orchestrator. The project
is distributed as source code; `package.json` remains private and this file
does not announce an npm publication.

## Coworker source publication

- Added completion callbacks to Codex for SDK and Desktop Gateway tasks.
- Added a sender with receipt validation, duplicate suppression, and local operator tools.
- Verified a single Desktop Gateway round trip on Windows.

## 0.1.0-alpha.7

Source snapshot. See [Releases](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/releases) for published tags and release artifacts.

- Added an optional, explicitly selected `sdk` backend (`DSH_HOST_PROTOCOL=sdk`)
  that drives the official DeepSeek Harness TypeScript SDK runtime over stdio
  JSON-RPC, so Codex can use DSH without starting Desktop or the Gateway
  launcher. The existing `legacy` and `gateway` backends and their data are
  unchanged, the SDK backend is never the default, and a failure never switches
  backends automatically.
- One root task owns one bounded SDK runtime: lazy start on the first prompt,
  hard concurrency cap (`DSH_SDK_MAX_RUNTIMES`), idle reclamation only for
  idle runtimes without unanswered interactions, awaited and idempotent
  shutdown, per-task ownership records, and exact-session resume after a
  recorded clean shutdown.
- Added a truthful capability model instead of a single protocol check: the SDK
  backend declares bridge-owned discovery, an observed-cache history, and no
  session catalog, history read, native rename, model catalog, dynamic model
  selection, steering, turn cancel, queue control, or agent preset. Unsupported
  calls return structured `unsupported_capability` errors and never simulate
  success.
- Added an observed-event store that persists events before derived state,
  detects duplicate/conflicting sequence numbers, reports coverage gaps
  explicitly, and blocks normal follow-ups with `observation_gap` instead of
  presenting an incomplete transcript as complete. A prompt outcome that cannot
  be confirmed is reported as `prompt_outcome_unknown` and never retried.
- Added one-shot approvals and native user questions for the SDK backend through
  the runtime's opt-in handlers, with pending-identity checks, timeouts that
  cancel rather than grant, and rejection of cross-task, duplicate, wrong-type,
  and late answers.
- Added SDK configuration and validation, an SDK-aware doctor (static by
  default; `--probe-sdk` performs one bounded handshake and states its side
  effects), explicit `--backend sdk` installation with a reviewable dry run, and
  updated caller-facing Skill guidance.
- Closed the event-lifecycle gaps the first cut of the SDK backend exposed: the
  notification subscription and its pump are established before the initialize
  handshake (so events committed during `initialize` or `session/resume` are
  persisted), shutdown is `bounded close -> bounded queue drain -> subscription
  close -> one exit report`, and `cleanShutdown` requires a proven process exit
  **and** a drained queue. A shutdown that cannot prove its drain degrades the
  task instead of claiming completeness, an unproven exit keeps its capacity
  slot and refuses a replacement runtime, concurrent acquisition cannot exceed
  the cap or start two runtimes for one task, the status revision is a strictly
  monotonic view clock, and an unknown observed running state is no longer
  reported as `interrupted`.
- Added the live acceptance driver (`docs/operator-tools/sdk-live-acceptance.mjs`)
  with per-scenario PASS/FAIL/BLOCKED/NOT_RUN plus an evidence class, segmented
  timings, a model-call budget, stage selection, an operator home, and an
  `--interaction-policy deny|allow|ask` that never turns a missing human into an
  approval. Windows results: L1-L3 (reply, same-task continuity, clean
  shutdown/resume) passed on both the account route and a declared OpenCode Go
  route, L6 (two isolated tasks at capacity) and L7 (one task's runtime killed
  while the other kept working) passed, and L4/L5 exercised both interaction
  refusals plus one operator-approved escalation.
- Added support for a customer-declared OpenAI-compatible route through the
  profile's dormant `llm-pi-ai` row (protocol, base URL, model, credential
  reference, `thinkingFormat: deepseek`), a local `llm-pi-ai/request-headers`
  plugin for a per-session header, and operator tools that write one credential
  reference and inspect a store without echoing secrets.
- Pinned `@deepseek-ai/dsh-sdk-client@0.2.2-rc.3` with runtime
  `@deepseek-ai/dsh@0.2.2-rc.3`. Qualification evidence, capability gaps, and
  live-probe observations are recorded in `docs/sdk-qualification.md`; the dated
  live run is in `docs/sdk-live-acceptance-results.md`, and the delivery report
  and `KNOWN_ISSUES.md` list what remains unverified: macOS, an operator-authored
  answer to a runtime question, a runtime-initiated question cancellation, a
  partial-drain shutdown and an unproven-exit restart against a live runtime, and
  the `allow_once` path against the filesystem assertion.
- `npm run check` passed on Windows with 401 automated tests. The SDK install
  resolves 606 packages (~745 MB) at install time; macOS remains unverified.

## 0.1.0-alpha.6

Source snapshot. See [Releases](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/releases) for published tags and release artifacts.

- Added an opt-in authenticated official Desktop Gateway adapter with owned
  loopback discovery on Windows and macOS, in-memory startup authorization,
  and a caller handoff helper. The operator controls application startup.
- Added exact-root history/queue reconciliation, sanitized connection diagnostics
  and current Flash catalog routing with account/API-key separation.
- Updated MCP SDK to 1.32.0 and Zod to 4.6.7, with scoped transitive security
  updates and the required Gateway record-schema migration.
- Added rc.3 catalog refresh, effort and rejection regressions, bounded
  observation-inbox backpressure and a native Windows startup pipe.
- The qualified source passed 308 Windows tests, including ten maintainer-author
  regressions. Ubuntu/macOS passed 307 with one Windows-only test skipped.
  All nine Node 22/24/26 CI jobs and both public CodeQL analyses passed.
- Added maintainer-attribution checks for PRs/main and contribution guidance
  for reintegrating reviewed bot updates with their original PR provenance.
- Updated bilingual setup/Skill guidance and operator startup instructions.
  Windows and Apple Silicon Mac completed inherited read-only tasks and
  same-root follow-ups. Current vision execution and a real rc.3 product run
  remain unverified; see the validation guide for exact build evidence.

## 0.1.0-alpha.5 — source release

- Added a bounded visual-routing policy: non-visual routine and difficult work
  keeps the existing Flash/Pro distinction; low-complexity visual work uses
  the official native Flash Vision route.
- High-complexity visual work now requires an explicit choice between official
  Flash Vision and ModLens Pro. ModLens Flash remains a one-time fallback only
  after bounded timeout, unreachable-Host, or HTTP 5xx failures; other failure
  classes remain fail-closed.
- Added non-sensitive fallback status reporting and regression coverage for
  prompt-failure handling and legacy explicit model-profile compatibility.
- Added macOS Node.js 22/24 CI coverage and normalized the macOS temporary
  directory fixture so the test suite respects the existing symlink-safe
  installation policy.

## 0.1.0-alpha.4 — portability documentation candidate

- Documented fresh-clone/worktree and stable-directory requirements.
- Made Codex setup install the shipped repository-scoped skill by default, with `--no-skill`, `--skill-path`, and explicit `--replace-skill` conflict handling.
- Reorganized human Quick Start and the compact AI-agent installation contract around the real MCP-plus-skill setup flow.
- Documented the tested Node.js 22/24 matrix and DSH Desktop/bridge-home boundaries.
- Kept the package private; this source candidate does not announce an npm publication.

## 0.1.0-alpha.2 — source snapshot

- Established Codex-DSH-Orchestrator as the public project identity.
- Added a project overview describing ownership, component boundaries,
  supported callers, and the DSH Web Host safety boundary.
- Clarified that the shared bridge runtime is an independently maintained
  derivative of dsh-Agentlink.
- Retained the upstream MIT license, copyright attribution, runtime package
  names, CLI names, and MCP identifiers for legal and compatibility reasons.
- Added maintainer-facing source-release checks and aligned the public README,
  architecture documentation, and contribution guidance.
- No core communication protocol or bridge behavior changes are included in
  this documentation-focused snapshot.
