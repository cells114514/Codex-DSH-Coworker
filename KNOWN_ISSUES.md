# Known issues

## Official Desktop qualification

The authenticated Gateway has Windows/macOS discovery and startup-handoff support. Both platforms completed one inherited read-only task and same-root follow-up. [Validation](docs/validation.md) separates the exercised runtime builds from the later source CI, CodeQL and author-policy evidence. Intel Mac and a real rc.3 product run remain unverified.

Gateway doctor leaves admission `not_probed`. A separately approved `dsh_host_status` can exchange authorization and open an API Peer. After changing the installation, confirm the actual MCP entry and Skill content before a smoke test.

The current rc.3 session catalog omits image modalities. Native vision therefore needs additional capability evidence. Timed questions remain with the Host, subagent-mode discovery is unavailable, and queue refresh relies on explicit observation/preflight. See [Gateway capabilities](docs/official-desktop-gateway.md#models-and-capabilities).

### Startup terminal and application icons

Keep the controlled-start terminal open. A fresh launch from an ordinary pinned shortcut or Dock entry does not receive that pipeline's temporary authorization. Restoring bridge access then requires another approved controlled start.

Direct executable startup produced a separate Windows taskbar group in the tested installation. The existing pinned shortcut was not changed; its grouping has not been corrected or qualified. The tested Mac launch retained one Dock icon. Neither observation guarantees another installation's icon behavior.

### Historical task lock warning

The Windows smoke still reported a lock warning while reconciling an unrelated historical task. The new task, follow-up and claim release completed. Existing locks and mappings were retained; new-session success does not establish recovery of that older task. Use the lock diagnostics below before planning any cleanup.

## SDK backend (opt-in)

The `sdk` backend is selected only with `DSH_HOST_PROTOCOL=sdk`. It does not change legacy or Gateway behavior, and the defects below are confined to that backend. The qualified environment was Windows with Node 25.6.0 against client/runtime `0.2.2-rc.3`; see [validation](docs/validation.md#sdk-backend-validation) for executed evidence and [the qualification record](docs/sdk-qualification.md) for the wire findings behind each gap.

- **No session discovery or attach.** The SDK wire has no session catalog. `dsh_find_sessions` can only list tasks this bridge registered (`scope="bridge-owned"`, `attachable=false`), and `dsh_attach_session` returns `unsupported_capability`. A Desktop or other-bridge session cannot be adopted.
- **Observed-cache history with explicit gaps.** History, status and tail return the bridge's own observation record, not DSH history. A restored session re-broadcasts no old events, so a readable task can still be incomplete; `coverage.complete=false` and the recorded gap reasons are reported instead of an implied full transcript.
- **A recorded gap blocks normal follow-ups.** Until the user starts a new task with an explicit handoff summary, a follow-up is refused with `observation_gap`. Read-only status and tail keep working and keep reporting the gap. No repair path exists for events that were never observed.
- **A shutdown that cannot prove its drain is recorded as partial.** `cleanShutdown` requires both a proven process exit and a drained notification queue (the internal drain bound is 2000 ms and is not configurable yet). A partial shutdown degrades the task, so `observation.complete` becomes `false` and normal follow-ups are refused with `observation_gap`; read-only status and tail remain usable. A normal idle reclamation and a normal bridge exit are drain-clean, which was confirmed live.
- **An unproven process exit needs an operator restart.** If a runtime cannot confirm its exit, the task keeps its capacity slot and any replacement runtime for that task is refused with `runtime_unavailable` (not retryable). The bridge never spawns beside a process whose exit is unproved; the operator verifies no orphan remains and restarts the bridge.
- **Fixed route.** The provider/model route is fixed by the runtime `initialize` handshake. There is no catalog, no per-task switch and no effort change; explicit `modelProfile`, `reasoningEffort`, `visualIntent` and `agentPreset` are rejected before any session or prompt instead of being silently ignored.
- **No steering.** `dsh_followup mode="queue"` is the only accepted placement; `mode="steer"` returns `unsupported_capability`.
- **No turn or queue cancel.** `dsh_cancel` returns `unsupported_capability` for both scopes. Closing the runtime is a different semantic and is never reported as a cancelled turn, so an unattended run must be bounded upstream.
- **No subagent listing.** Observed descendant events are readable, but there is no listing call and no one-shot/continuable classification for subagents.
- **Not protocol-version-negotiated.** The client does not validate the runtime's reported `serverInfo` version. The pinned client/runtime pair is the only compatibility statement, and mixing versions is unsupported.
- **`clientTimeZone` is not transmitted.** The runtime profile's own time zone applies. Prompt results report `clientTimeZoneApplied: false`; the caller must not present the requested zone as applied.
- **The API-key route has no validated credential here.** `deepseek-official` fails with `MISSING_CREDENTIAL` on a fresh home and `AUTH`/401 when a copy of the local store is seeded. Successful live turns were obtained only through the account route, after an operator performed one browser sign-in in an isolated SDK home. Treat the API-key route as transport-only evidence until a valid key exists in the SDK home's own store or environment chain.
- **Account sign-in cannot run from the SDK profile.** `deepseek-account` needs a browser sign-in served by a Host web server; the `sdk` profile is stdio-only, so the grant must already exist in that DSH home. The supported way is one `dsh web` session bound to that home (`--host 127.0.0.1 --port <free> --no-open`), signed in through the browser, then stopped. Signing in from the Desktop profile does not help the SDK home and copying the Desktop home is out of scope.
- **An approval grants the escalation it names.** `dsh_resolve_approval` answers a sandbox-escalation request, and `allow_once` grants that whole scope for the single call — in the verified run, `danger-full-access` because the target was outside the session workspace. It is not a fine-grained permission on the named file, nothing narrower should be presented, and it is not remembered as a standing grant.
- **Approval and question evidence has three gaps.** Verified live: the driver's `reject` (target absent, filesystem-asserted), an operator's `allow_once` (decision accepted, turn completed), and a user question answered by the driver. Not verified: the `allow_once` path against the filesystem assertion (added after that run), an operator-authored answer to a question, and a runtime-initiated question cancellation. A partial-drain shutdown and an unproven-exit restart remain mock-only.
- **Verified live so far:** a successful turn, same-task context continuity, clean-shutdown/restart-resume, two isolated tasks at capacity, one task's runtime dying while the other kept working, an answered user question, and both approval decisions (L1–L7) — on Windows, on both the account route and a declared OpenCode Go route, from an isolated home. Only question cancellation and macOS remain unverified; see [the acceptance record](docs/sdk-live-acceptance-results.md).
- **L7 needs an explicit flag and a verified parent.** The driver only stops a runtime it can prove is a child of the bridge it started (`--kill-owned-runtime`); it never matches by image name, never targets the Desktop runtime, and does not retry the refused follow-up.
- **macOS is unverified.** Only Windows was exercised.
- **One runtime per root task with a hard cap.** `DSH_SDK_MAX_RUNTIMES` (default 2) bounds live runtimes. Capacity pressure reclaims only idle runtimes with no unanswered interaction; otherwise the prompt fails with `runtime_capacity_exceeded`. No request waits for a slot and active work is never killed.
- **SDK data is never migrated from Desktop.** The SDK runtime and the Desktop installation are independent processes with independent homes. Existing Desktop sessions, credentials and profiles are not imported, converted or migrated, and no bridge file is copied into the Desktop home.

## Shared-ledger duplicate cursor

Fixed in `0.1.0-alpha.2`.

Multiple processes sharing `DSH_BRIDGE_HOME` could produce a duplicate cursor and `unrecoverable_gap`; the rejected ledger queue could then exit the MCP process. Two check-then-delete races let a stale owner observation remove a replacement lock.

The fix retries owner writes lost with `ENOENT` or `EEXIST` without deleting the current directory. Unexpected owner-write failures preserve the path: ownership cannot be proved after a competitor replaces it. Automatic stale-lock reaping is disabled because portable filesystem APIs cannot atomically compare an old observation with a later destructive rename.

When upgrading a shared home, schedule all participating bridge processes onto the compatible build. A remaining alpha.1 process can still violate the corrected locking rules. Keep incompatible or independently managed groups on separate homes.

### Crash recovery

Locks cover short critical sections on a local filesystem. They have no heartbeat, and PID/mtime observations are unsuitable for NFS. A hard kill during ownership, or an `ENOSPC`/`EIO` owner-write failure, can leave a directory that blocks later operations.

Before manual cleanup, stop every bridge process using that home during an agreed window, preserve a backup and inspect the exact directory and ownership. Avoid deleting a whole bridge home. A fresh home allows new delegations but starts new task mappings, claims and cursors; DSH keeps its conversation history.

### Read-only lock diagnostics

Doctor reports structure at `claims/registry.lock` and `ledgers/<valid task id>/events.lock`: path/owner presence, filesystem types and bounded entry observations. Scans report truncation. It leaves directories intact and does not read `owner.json` content, acquire locks or infer ownership/liveness from a snapshot.

Windows lock acquisition retries transient `EPERM` within a bounded window and retains persistent permission errors. This does not repair ACLs or authorize deleting a lock.

### Existing large ledgers

Ingestion skips new top-level `session/projection` snapshots and high-frequency assistant chunks; `session/jobs` remains durable with coordination-only payloads. Existing ledgers, including those larger than 5 MB, are not compacted. Preserve them for diagnosis or use a separate home for new work. `session.history` remains the conversation source.

## Windows file modes and installer paths

Windows uses ACLs, so Node cannot round-trip Unix `0600`, `0640` or `0700` mode bits. `stat` commonly reports `0666`. Tests check supported Windows representations and exact POSIX modes on Unix; this is not an ACL audit.

The installer rejects symlinked directories and non-regular configuration targets, checks stale snapshots and verifies the installed bytes. macOS temp fixtures canonicalize the system temp root before testing this policy; production symlink rejection is unchanged.

## Dependency snapshot

The SDK/Zod migration updates the reviewed lockfile and passed a zero-advisory npm audit snapshot. Audit data changes over time; review the final release tree and dependency alerts again before publication. No automatic `npm audit fix` or permissions change is part of setup.
