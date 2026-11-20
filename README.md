# Codex-DSH-Coworker

[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

**English** | [简体中文](README.zh-CN.md)

Codex-DSH-Coworker lets Codex continue an existing DeepSeek Harness Desktop session and receive completion notifications in the original Codex chat. When the callback is ready, Codex can finish its turn after dispatch and read the result when notified.

## Project boundary

The connect-only MCP server is registered as `dsh_agentlink` and connects to a user-managed DSH Host. Desktop startup, login, permissions and model credentials stay with the user; approvals require human confirmation. It is not a DSH Cordis bundle. Do not install it with `dsh plugin --profile ... add ...`.

This project builds on Fly2Kiana’s [Codex-DSH-Orchestrator](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator) at [428c69f](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/commit/428c69f), itself derived from [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink). The original MIT license and attribution are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Quick start

Requirements: Node.js 22+, npm, Git, Codex and the official DeepSeek Harness Desktop for your platform. Keep the checkout in a stable tools directory because setup records absolute paths.

| Host path | Setup choice |
| --- | --- |
| Official Desktop on Windows or macOS | `--gateway --desktop-auto --no-preset` |
| Official Gateway at a known origin | `--gateway --host <origin> --no-preset` |
| Legacy rc.6 Web Host or community Windows Desktop | Use the [legacy configuration](docs/manual-configuration.md#legacy-host) |

This repository distributes source code. On Windows, Desktop Gateway attachment, same-session follow-up, and one automatic completion callback were verified end to end. The optional SDK backend also supports completion callbacks and can run without Desktop. See the [Coworker runbook](docs/coworker-trial-runbook.md) and [acceptance notes](docs/desktop-coworker-validation.md).

### Recommended: copy/paste the Agent installation prompt

```text
Install Codex-DSH-Coworker from https://github.com/cells114514/Codex-DSH-Coworker
in a stable tools directory I approve. Check Node.js 22+, npm, Git and the selected source revision.
Run npm ci and npm run check. For official Desktop, preview:
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run

Show the MCP and Skill targets and any conflicts. For use across projects, choose one user Skill
target; for repository-only use, retain .agents/skills/codex-dsh-orchestrator. Existing legacy
global Skill installations should be updated in place. Ask before --replace or --replace-skill.
Install only the reviewed targets, retain backups, and report any partial installation.

Leave my apps and active tasks running during preparation. Explain the application launch/restart
steps and wait for my downtime approval before authorization handoff. Keep startup authorization
in the private process pipe; do not print it or save it. Do not request provider API keys.

After I restart, verify MCP and Skill loading, then perform connection-only acceptance.
Ask separately before any model request. Report setup, connection and live-task results separately.
```

### Manual setup and verification

Clone a fresh copy on each machine:

```sh
git clone https://github.com/cells114514/Codex-DSH-Coworker.git
cd Codex-DSH-Coworker
npm ci
npm run check
```

For official Desktop on Windows or macOS, preview the configuration:

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run
```

The default Skill target is the checkout's `.agents/skills/codex-dsh-orchestrator/`. For access from any project, add `--skill-path "$HOME/.agents/skills/codex-dsh-orchestrator"` to both preview and installation. Existing installations under `~/.codex/skills` can keep their current target; update that copy explicitly and avoid a second copy with the same skill name. These location rules follow the [Codex Skill documentation](https://learn.chatgpt.com/docs/build-skills).

Once the targets are reviewed, run the same setup command without `--dry-run`:

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset
```

Setup registers the bridge, keeps `approval_mode = "prompt"` for approvals and copies `SKILL.md` plus `agents/openai.yaml`. Conflicting MCP or Skill content requires `--replace` or `--replace-skill`, respectively. Review the conflict first. `--no-skill` opts out of Skill installation. Successful replacements create backups; if only one part succeeds, review the reported state before retrying.

The official Gateway uses a private in-memory authorization handoff from Desktop to a newly launched Codex process. **This step starts Desktop and Codex and requires both apps to be quit first. Finish active work before following the [Windows/macOS startup instructions](docs/official-desktop-gateway.md#operator-startup).** Keep that terminal open during use.

After the controlled launch, check `/mcp` or Settings for `dsh_agentlink`, and use `/skills` or `$codex-dsh-orchestrator` to confirm Skill discovery. A connection-only `dsh_host_status` then checks admission without creating a task or invoking a model. Unlike doctor, this call can exchange authorization and create a Gateway API Peer. Doctor deliberately reports Gateway admission as `not_probed`.

### Portability and rollback

Use a fresh clone on another computer. A linked worktree's `.git` file refers to the original clone and cannot serve as an independent installation.

Keep `DSH_BRIDGE_HOME` on a reliable local filesystem. Compatible bridge processes can share it under the cooperative locking protocol; independently managed or incompatible builds need separate homes. A new home starts fresh mappings, cursors and claims while DSH retains conversation history.

Preserve the old checkout, configuration backup and installed Skill backup during an upgrade. To roll back, first review any later configuration edits, restore the intended MCP block and Skill files, then relaunch the caller at an agreed time. See [Known issues](KNOWN_ISSUES.md) for lock recovery and Windows filesystem limits.

## SDK backend (optional)

Delegation can also run without DSH Desktop or the Gateway launcher. `DSH_HOST_PROTOCOL=sdk` selects the optional `sdk` backend, the third backend next to `legacy` (default) and `gateway`. It drives the official DeepSeek Harness TypeScript SDK runtime over stdio JSON-RPC, starting one runtime process per root task. It is never the default, the Host-backed backends keep their current behavior and data, and an SDK failure never switches backends automatically.

```sh
npm run setup -- --backend sdk --yes --no-preset --dry-run
```

Review the printed JSON preview, then repeat the command without `--dry-run`. An agent preset is not available on this backend, so omit `--preset` (or pass `--no-preset`); `--host-url`, `--host`, `--desktop-auto` and `--gateway` are rejected together with `--backend sdk`. The full install, lifecycle and rollback reference is [SDK backend](docs/sdk-backend.md).

| Variable | Default | Note |
| --- | --- | --- |
| `DSH_HOST_PROTOCOL=sdk` | `legacy` | Explicit opt-in |
| `DSH_HOME` | `~/.dsh` | SDK persistence, profiles and credentials |
| `DSH_SDK_PROFILE` | `sdk` | A custom profile must still serve the SDK server; the installer cannot verify that |
| `DSH_SDK_BIN` | unset (same-version `@deepseek-ai/dsh` from the dependency) | `dsh` CLI module path, resolved lexically; never a command line; Windows paths with spaces are supported |
| `DSH_SDK_PROVIDER`, `DSH_SDK_MODEL` | unset (runtime defaults `deepseek-official` / `deepseek-v4-flash`) | Both or neither; the runtime validates the exact route during initialization |
| `DSH_SDK_REASONING_EFFORT` | unset | Requires provider and model; validated by the runtime |
| `DSH_SDK_MAX_RUNTIMES` | `2` | Hard cap on concurrent runtimes |
| `DSH_SDK_IDLE_TIMEOUT_MS` | `600000` | `0` disables idle reclamation |
| `DSH_SDK_INITIALIZE_TIMEOUT_MS` | `60000` | Handshake bound |
| `DSH_SDK_SHUTDOWN_TIMEOUT_MS` | `10000` | Bounded teardown |
| `DSH_APPROVAL_TIMEOUT_MS` | `300000` | Pending approval/question expiry; it cancels and never grants |
| `DSH_BRIDGE_HOME` | `<DSH_HOME>/codex-bridge-sdk` for SDK; `<DSH_HOME>/codex-bridge` for legacy/gateway | Different state roots, never repointed automatically |

The Host URL, the connect-token variables and Desktop discovery are never read or validated on this backend. Credentials come from the DSH home's own native configuration and credential store; the bridge never reads, copies, or writes them, and the generated configuration contains no model API key. One runtime per root task starts lazily on that task's first prompt — never at MCP startup and never by a read — runs under the concurrency cap with idle reclamation only for idle runtimes without unanswered interactions, and is closed by the bridge on exit. Resume works only after a recorded clean shutdown, by exact session id.

Capabilities differ by design: discovery is bridge-owned, history is the bridge's own observed cache rather than DSH history, and the provider/model route is fixed at initialization. There is no model catalog or switching, no steering, no turn or queue cancel, and no subagent listing; restored sessions restore model context only, observation gaps block normal follow-ups, and the wire cannot carry the client time zone (`clientTimeZoneApplied: false`). One-shot approvals and native user questions are supported. `node dist/doctor.js` reports this backend statically, and `node dist/doctor.js --probe-sdk` performs one bounded handshake with disclosed side effects. To roll back, set `DSH_HOST_PROTOCOL` back to `gateway` or `legacy` and restore that backend's own bridge home; SDK data stays on disk untouched. See [SDK qualification](docs/sdk-qualification.md) for the evidence behind every limit.

## For AI Agents

Use the focused setup/validation documents and inspect only the relevant non-sensitive configuration. Preserve unrelated MCP servers and Skills. Preparation does not authorize replacing an installation, closing an application or invoking a model.

Report the source revision, build result, installed MCP/Skill targets, caller reload status and connection result. Keep credentials, real session identifiers and personal paths out of public reports. Only the user can approve application downtime, a DSH approval request or publication.

## Use it

In a project with the bridge and Skill loaded:

> 请委派给 DSH 完成这个有明确范围的任务，按当前项目状态交接，并由 Codex 审阅结果。

Use `$codex-dsh-orchestrator` for explicit invocation. The Skill also matches natural-language delegation requests. It builds a compact handoff from progress, Git state, focus files, relevant tests and constraints. DSH reads those focus files first. The bridge does not receive prior caller conversation state automatically.

Continue the same known task with `dsh_followup`. To resume work from a different Codex chat, metadata-only `dsh_find_sessions` must identify one mapped, idle root with the exact canonical workspace; `dsh_attach_session` checks fresh title/cwd/update preconditions before a follow-up. Titles and similar wording are insufficient for reuse. Session reuse may reduce rereads but can increase input tokens; provider cache evidence remains `not_exposed` without documented usage telemetry.

## Model routing

Model routing is opt-in and backward-compatible for both delegation and follow-up.

| Request | Behavior |
| --- | --- |
| Omit routing, or use `inherit` | Verify the session's current route; no model-selection write |
| `flash` / `pro` | Select an advertised official route on the current account/API-key provider |
| `reasoningEffort` | Require that exact effort in the current catalog |
| Visual low complexity | `visualIntent="required"`, `complexity="low"`: select official Flash Vision only with verified image capability |
| Visual high complexity | Ask the user to choose `official-flash-vision` or `modlens-pro` |

Flash recognizes `deepseek-flash` and the legacy `deepseek-v4-flash`; Pro uses `deepseek-v4-pro`. An unavailable Pro is refused, and account/API-key providers stay separate. The bridge reads the Host catalog again after selection. Delegate and follow-up results report `modelRouting.persistsAsDshDefault=true` when selection saves the global default; a verification failure can leave that side effect even though no prompt was sent.

The official rc.3 session catalog omits image modalities, so a Vision display name alone cannot enable native vision. ModLens Flash is reserved for one fallback after the approved visual route exhausts bounded qualifying failures; invalid input, missing models, permissions and configuration errors do not qualify. The prompt write is never replayed. Explicit legacy `modlens-flash` remains accepted when visual-policy fields are omitted.

Routing policy is covered by automated tests. Current native vision, ModLens and fallback provider execution still need live qualification. [Gateway capabilities](docs/official-desktop-gateway.md#models-and-capabilities) describes the exact limits and the legacy Code Mode handoff.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `dsh_host_status` | Connection state and capabilities |
| `dsh_find_sessions` | Bounded root-session metadata discovery |
| `dsh_attach_session` | Attach an exact idle root with fresh preconditions |
| `dsh_delegate` | Create a root and queue its initial prompt |
| `dsh_followup` / `dsh_continue` | Continue that root; queue or steer |
| `dsh_status` | Execution, pending interactions, final answer and workspace claim semantics |
| `dsh_tail` | Bounded event digests and next cursor |
| `dsh_wait` / `dsh_observe` | Bounded observation; one window is at most 30 seconds |
| `dsh_cancel` | Cancel the current turn or observed queue items |
| `dsh_list` | List mapped tasks |
| `dsh_answer_question` | Answer a typed pending question |
| `dsh_resolve_approval` | Human-approved `allow_once` or rejection |
| `dsh_release_workspace` | Release the cooperative claim; leave the DSH session open |

Retain cursors/revisions before mutations. A wait window ending does not end the task; continue observation until a real terminal state or required human action. Workspace claims coordinate bridge users and do not enforce DSH filesystem permissions.

## Caller support

Codex has the canonical orchestration Skill and setup above. Claude Code has a retained project installer:

```sh
npm run setup:claude -- --yes --project /absolute/path/to/project
```

That installer configures the legacy integration; the new official Gateway path has no fresh Claude Code live qualification. ZCode, OpenCode, Workbuddy and Claude Desktop remain deferred. See [Deferred roadmap](docs/deferred-roadmap.md).

## Project components

- `src/`: shared MCP runtime and setup.
- `skill/codex-dsh-orchestrator/`: canonical Codex Skill; edit this source, not an installed copy.
- `skill/codex-dsh/` and `skill/claude-code-dsh/`: compatibility Skills.
- `test/`: synthetic Host, protocol, persistence and install regressions.
- [Project overview](docs/project-overview.md), [Architecture](docs/architecture.md), [Validation](docs/validation.md), [Manual configuration](docs/manual-configuration.md), [SDK backend](docs/sdk-backend.md), [Release checklist](docs/release-checklist.md), [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).

## Related projects

| Project | Relationship |
| --- | --- |
| [DeepSeek Harness](https://www.deepseek.com/harness/en/) / [source](https://github.com/deepseek-ai/deepseek-harness) | Official Desktop and Host runtime |
| [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop) | Community client, retained Windows legacy discovery |
| [ModLens](https://github.com/liustack/modlens) | Optional vision plugin. Not maintained by or affiliated with this project |
| [Model Context Protocol](https://modelcontextprotocol.io/) | Caller-to-bridge protocol |
| [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) | Upstream MIT code and compatibility lineage |

## License

[MIT](LICENSE). Read [Known issues](KNOWN_ISSUES.md) before upgrading a shared bridge home.
