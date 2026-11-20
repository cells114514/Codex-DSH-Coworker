/**
 * SDK backend adapter: `DshApi` over the official
 * `@deepseek-ai/dsh-sdk-client` runtime.
 *
 * Scope of this adapter (see `docs/sdk-qualification.md` for evidence):
 * create a session identity, submit one prompt, observe real events, expose a
 * bounded wait, answer one-shot approvals and native user questions, resume a
 * known session by exact id, and shut down deterministically.
 *
 * Everything the wire does not provide — a session catalog, history reads,
 * rename, a model catalog, dynamic model selection, steering, turn cancel,
 * queue snapshots/mutation — throws `unsupported_capability` instead of
 * returning an empty list or pretending success. History this bridge returns is
 * its own observation log, never an authoritative DSH history.
 */
import { randomUUID } from "node:crypto";

import type { BridgeConfig, SdkBridgeConfig } from "./config.js";
import { SDK_BACKEND_CAPABILITIES } from "./backend-capabilities.js";
import {
  attachDshUnaryMetadata,
  type DshApi,
  type DshBackendRoute,
  type DshClientResponse,
  type DshHostDescription,
  type DshBridgeOwnedSession,
  type DshMuxFrame,
  type DshObservedHistory,
  type DshPendingEnvelope,
  type DshApprovalRequestedFrame,
  type DshQuestionRequestedFrame,
  type DshQuestionAnswer,
  type DshQuestionItem,
  type DshServerRequest,
  type DshSessionCancelValue,
  type DshSessionCreateValue,
  type DshSessionHistory,
  type DshSessionListValue,
  type DshSessionModels,
  type DshSessionPromptValue,
  type DshSessionRenameValue,
  type DshSessionSelectModelValue,
  type DshSessionUpdateQueueValue,
  type DshSubagentListValue,
  type DshSubagentAddress,
  type DshUnaryResult,
} from "./dsh-types.js";
import { PendingInteractionError } from "./connection-manager.js";
import { EventLedger } from "./event-ledger.js";
import { RuntimeRegistry, RuntimeRegistryError, type SdkRuntimeRecord } from "./runtime-registry.js";
import { SdkBackendError, unsupportedCapability } from "./sdk-errors.js";
import {
  ObservationConflictError,
  ObservationStoreError,
  SdkObservedEventStore,
  type ObservedCoverage,
  type ObservedDegradationReason,
  type ObservedEventRecord,
} from "./sdk-observed-event-store.js";
import {
  SdkRuntimeManager,
  type ManagedSdkRuntime,
  type SdkRuntimeClientFactory,
  type SdkRuntimeNotification,
} from "./sdk-runtime-manager.js";
import { TaskStore, type TaskRecord } from "./task-store.js";
import { CoworkerBindings, ExecutionCounter } from "./coworker-binding.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
const MAX_QUESTIONS_PER_REQUEST = 20;
const MAX_OPTIONS_PER_QUESTION = 50;
const MAX_PENDING_PER_TASK = 32;
const MAX_UNKNOWN_NOTIFICATIONS_RECORDED = 50;

type TaskRuntimePhase = "unknown" | "running" | "idle" | "awaiting_input";

type TerminalKind = "turn_completed" | "failed" | "interrupted" | "canceled";

interface LineageRow {
  sessionId: string;
  origin: "root" | "subagent";
  parentSessionId?: string;
  running: boolean | "unknown";
  finished?: boolean;
  verified: boolean;
}

interface PendingApproval {
  kind: "approval";
  taskId: string;
  requestId: string;
  approvalId: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  generation: number;
  createdAt: number;
  settle: (result: { outcome: "allowed-once" | "rejected" | "cancelled" }) => void;
  timer: NodeJS.Timeout;
}

interface PendingQuestion {
  kind: "question";
  taskId: string;
  requestId: string;
  sessionId: string;
  questions: DshQuestionItem[];
  generation: number;
  createdAt: number;
  settle: (result: { answers: DshQuestionAnswer[] } | { cancelled: true }) => void;
  timer: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
}

type PendingInteraction = PendingApproval | PendingQuestion;

export interface TaskState {
  taskId: string;
  sessionId: string;
  generation: number;
  phase: TaskRuntimePhase;
  rootStatus: "unknown" | "running" | "idle";
  lastTerminal?: TerminalKind;
  lastTurnEndSeq?: number;
  /** Monotonic per-task execution generation, one per accepted prompt. */
  executionSeq: number;
  /** Identity of the execution whose terminal event is expected next. */
  executionId?: string | undefined;
  /** True when the submit outcome is unknown; the execution may not have run. */
  executionUncertain?: boolean;
  /** Serializes prompt submissions so execution ids cannot be overwritten. */
  executionChain?: Promise<void>;
  /** Generation pinned by the run's own turn/start event. */
  runningExecutionId?: string | undefined;
  /** Submissions awaiting their turn, in submit order (FIFO). */
  pendingExecutions?: string[];
  /** Set while an accepted execution has not reached its terminal state. */
  executionInFlight?: boolean | undefined;
  /** messageId -> executionId, so a turn can be claimed by the message it consumed. */
  messageExecutions?: Map<string, string>;
  /** Descendant sessions with an open turn since the last root terminal event. */
  activeDescendants?: Set<string>;
  /** Terminal event deferred while descendants were still running. */
  deferredCompletion?: { executionId: string; terminal: TerminalKind | undefined; turnSeq: number } | undefined;
  /** Execution id that currently holds the single in-flight slot. */
  inFlightExecutionId?: string | undefined;
  lineage: Map<string, LineageRow>;
  pending: Map<string, PendingInteraction>;
  lastSeqBySession: Map<string, number>;
  observedEvents: number;
  lastEventAt?: string;
  nativeTitle?: string;
  bridgeTitle?: string;
  degraded?: { reason: ObservedDegradationReason; detail: string; at: string };
  unknownNotifications: string[];
  messageIds: string[];
  revision: number;
}

export interface SdkTaskView {
  taskId: string;
  rootSessionId: string;
  backend: "sdk";
  generation: number;
  runtimeState: "absent" | "starting" | "ready" | "crashed" | "closed";
  phase: TaskRuntimePhase;
  rootStatus: "unknown" | "running" | "idle";
  lastTerminal?: TerminalKind;
  route: DshBackendRoute;
  lineage: LineageRow[];
  pending: Array<{ key: string; kind: "approval" | "question"; requestId: string; sessionId: string }>;
  observed: ObservedCoverage;
  title: string | null;
  titleSource: "bridge" | "dsh-native" | null;
  messageIds: string[];
  lastEventAt?: string;
  observationEpoch: number;
  cleanShutdown: boolean;
  degraded?: { reason: ObservedDegradationReason; detail: string; at: string };
}

export interface SdkDshClientOptions {
  clientFactory?: SdkRuntimeClientFactory;
  now?: () => number;
  logger?: (message: string) => void;
  bridgeInstanceId?: string;
  coworkerBindings?: CoworkerBindings;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = asObject(value)?.[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = asObject(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function textBlocks(content: Array<{ type: "text"; text: string }>): Array<{ type: "text"; text: string }> {
  return content.map((block) => ({ type: "text" as const, text: block.text }));
}

function classifyTerminal(reason: unknown): TerminalKind {
  const kind = stringField(reason, "kind");
  if (kind === "completed") return "turn_completed";
  if (kind === "aborted") {
    const nested = stringField(asObject(reason)?.reason, "kind");
    return nested === "user" ? "canceled" : "interrupted";
  }
  if (kind === "interrupted") return "interrupted";
  return "failed";
}

/** Map one wire question into the bridge's pending-question shape without inventing fields. */
function mapQuestions(raw: unknown): DshQuestionItem[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS_PER_REQUEST) return undefined;
  const mapped: DshQuestionItem[] = [];
  for (const item of raw) {
    const question = asObject(item);
    const id = stringField(question, "id");
    const text = stringField(question, "question");
    if (id === undefined || text === undefined) return undefined;
    const header = stringField(question, "header");
    const detail = stringField(question, "detail");
    const options = Array.isArray(question?.options)
      ? question.options.slice(0, MAX_OPTIONS_PER_QUESTION).flatMap((option) => {
          const label = stringField(option, "label");
          if (label === undefined) return [];
          const description = stringField(option, "description");
          return [{ label, ...(description === undefined ? {} : { description }) }];
        })
      : undefined;
    const intent = asObject(question?.intent);
    const intentKind = stringField(intent, "kind");
    const approve = stringField(intent, "approve");
    mapped.push({
      id,
      question: text,
      ...(header === undefined ? {} : { header }),
      ...(detail === undefined ? {} : { detail }),
      ...(options === undefined ? {} : { options }),
      ...(typeof question?.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
      ...(intentKind === "plan-review" && approve !== undefined
        ? { intent: { kind: "plan-review" as const, approve } }
        : {}),
    });
  }
  return mapped;
}

/**
 * The SDK backend's `DshApi`.
 *
 * No method here starts a subprocess except `sessionPrompt` (through the
 * runtime manager). The constructor only parses configuration, so starting the
 * MCP server never spawns runtimes for historical tasks.
 */
export class SdkDshClient implements DshApi {
  readonly backend = "sdk" as const;
  readonly capabilities = SDK_BACKEND_CAPABILITIES;
  readonly protocolCapabilities = { queueSnapshot: false };

  private readonly config: BridgeConfig;
  private readonly sdk: SdkBridgeConfig;
  private readonly tasks: TaskStore;
  private readonly ledger: EventLedger;
  private readonly registry: RuntimeRegistry;
  private readonly coworkerBindings: CoworkerBindings | undefined;
  /** Per-task submission mutex: concurrent prompts must not share a generation. */
  private readonly submissionLocks = new Map<string, Promise<void>>();
  /** In-flight settlement confirmations, aborted when the client closes. */
  private readonly settleControllers = new Set<AbortController>();
  private readonly store: SdkObservedEventStore;
  private readonly manager: SdkRuntimeManager;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  private readonly bridgeInstanceId: string;
  private readonly states = new Map<string, TaskState>();
  private readonly sessionCwd = new Map<string, string>();
  private readonly cwdsBySession = new Map<string, string>();
  private readonly sessionTasks = new Map<string, string>();
  private readonly waiters = new Map<string, Array<{ revision: number; cursor: number; resolve: () => void }>>();
  private readonly approvalTimeoutMs: number;
  private serial = 0;
  /** Monotonic observation clock; every state change advances it. */
  private viewClock = 0;
  private wireIdentity: { name: string; version: string } | undefined;
  private closed = false;

  constructor(config: BridgeConfig, sdk: SdkBridgeConfig, options: SdkDshClientOptions = {}) {
    this.config = config;
    this.sdk = sdk;
    this.tasks = new TaskStore(config.homeDir);
    this.ledger = new EventLedger(config.homeDir);
    this.registry = new RuntimeRegistry(config.homeDir);
    this.coworkerBindings = options.coworkerBindings;
    this.store = new SdkObservedEventStore(config.homeDir);
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? (() => undefined);
    this.bridgeInstanceId = options.bridgeInstanceId ?? randomUUID();
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.manager = new SdkRuntimeManager({
      sdk,
      requestTimeoutMs: config.requestTimeoutMs,
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
      hasPendingInteractions: (taskId) => (this.states.get(taskId)?.pending.size ?? 0) > 0,
      isBusy: (taskId) => {
        const state = this.states.get(taskId);
        return state !== undefined && (state.rootStatus === "running" || state.phase === "running");
      },
      now: this.now,
      logger: this.logger,
      onRuntimeExit: (taskId, info) => this.onRuntimeExit(taskId, info),
    });
  }

  /** Bounded runtime snapshots for diagnostics; starts nothing. */
  runtimeSnapshots() {
    return this.manager.snapshot();
  }

  /** Ledger snapshot of one task, for the connection adapter's wait result. */
  async ledgerSnapshot(taskId: string) {
    return this.ledger.snapshot(taskId);
  }

  /** In-process observation state of one task, without starting anything. */
  taskStateSync(taskId: string): TaskState | undefined {
    return this.states.get(taskId);
  }

  /** Read the persisted runtime identity of one task; starts nothing. */
  async runtimeRecord(taskId: string): Promise<SdkRuntimeRecord | undefined> {
    return this.registry.get(taskId).catch(() => undefined);
  }

  startReaper(): void {
    this.manager.startReaper();
  }

  async close(): Promise<void> {
    // Pending settlement confirmations must terminate with the client instead of
    // outliving it or writing a record after shutdown.
    for (const controller of this.settleControllers) controller.abort();
    this.settleControllers.clear();
    if (this.closed) return;
    this.closed = true;
    const outcomes = await this.manager.closeAll("bridge-shutdown");
    // Only a confirmed exit may be recorded as clean, and only for a record this
    // instance still owns: an ownership change in the meantime must not be
    // overwritten with our claim of a clean shutdown.
    const at = new Date(this.now()).toISOString();
    await Promise.all(
      outcomes.map(async (outcome) => {
        if (outcome.confirmed !== true) {
          this.logger(`[dsh-agentlink] runtime ${outcome.taskId} shutdown not confirmed: ${outcome.reason ?? "unknown"}`);
          return;
        }
        const record = await this.registry.get(outcome.taskId).catch(() => undefined);
        if (record === undefined || record.owner.bridgeInstanceId !== this.bridgeInstanceId) {
          this.logger(`[dsh-agentlink] clean shutdown skipped for ${outcome.taskId}: ownership changed`);
          return;
        }
        await this.registry
          .update(outcome.taskId, { cleanShutdown: true, cleanShutdownAt: at })
          .catch((error: unknown) => {
            this.logger(`[dsh-agentlink] clean shutdown not persisted task=${outcome.taskId}: ${errorMessage(error)}`);
          });
      }),
    );
  }

  // ---------------------------------------------------------------- host/route

  async hostDescribe(signal?: AbortSignal): Promise<DshUnaryResult<DshHostDescription>> {
    signal?.throwIfAborted();
    const route = this.configuredRoute();
    const description: DshHostDescription = {
      version: this.wireIdentity?.version ?? "sdk-runtime-uninitialized",
      cwd: process.cwd(),
      provider: route.provider,
      model: route.model,
      attachedSessions: this.manager.size,
      canOpenPath: false,
      backend: "sdk",
      transport: "stdio-jsonrpc",
      ...(this.wireIdentity === undefined ? {} : { serverName: this.wireIdentity.name }),
      ...(this.wireIdentity === undefined ? {} : { serverVersion: this.wireIdentity.version }),
      productVersion: null,
      dshHome: this.sdk.dshHome,
      profile: this.sdk.profile,
      initializedRuntimes: this.manager.size,
      capabilitySource: "@deepseek-ai/dsh-sdk-client",
    };
    return attachDshUnaryMetadata(description, { issuedRpcId: this.localRpcId("host/describe"), method: "host/describe" });
  }

  async routeInfo(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshBackendRoute>> {
    signal?.throwIfAborted();
    const task = await this.taskForSession(sessionId);
    const record = await this.registry.get(task.taskId);
    const route: DshBackendRoute = {
      provider: record?.route.provider ?? this.configuredRoute().provider,
      model: record?.route.model ?? this.configuredRoute().model,
      ...(record?.route.reasoningEffort === undefined && this.sdk.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: record?.route.reasoningEffort ?? this.sdk.reasoningEffort! }),
      source: "sdk-initialize",
      catalogAvailable: false,
      titleSource: record?.titleSource === "bridge" ? "bridge" : "dsh-native",
    };
    return attachDshUnaryMetadata(route, { issuedRpcId: this.localRpcId("session/route"), method: "session/route" });
  }

  // ------------------------------------------------------------------- create

  async sessionCreate(
    payload: { cwd: string; agentPreset?: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionCreateValue>> {
    signal?.throwIfAborted();
    const preset = payload.agentPreset?.trim();
    if (preset !== undefined && preset !== "") {
      throw unsupportedCapability(
        "agentPreset",
        "the SDK backend cannot select an agent preset: the SDK wire carries no preset field and the runtime profile fixes composition",
      );
    }
    const requested = payload.sessionId?.trim();
    const sessionId = requested === undefined || requested === "" ? randomUUID() : requested;
    this.sessionCwd.set(sessionId, payload.cwd);
    const value: DshSessionCreateValue = { sessionId, identityProvenance: "bridge-local-id" };
    return attachDshUnaryMetadata(value, { issuedRpcId: this.localRpcId("session/create"), method: "session/create" });
  }

  // ------------------------------------------------------------------- prompt

  async sessionPrompt(
    payload: {
      sessionId: string;
      mode: "queue" | "steer";
      content: Array<{ type: "text"; text: string }>;
      clientTimeZone?: string;
    },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionPromptValue>> {
    signal?.throwIfAborted();
    if (payload.mode === "steer") {
      throw unsupportedCapability(
        "steer",
        "the SDK wire has no steering placement: `session/prompt` queues one durable user message and `session/query` routes native commands, neither appends to a running step",
      );
    }
    const text = payload.content.map((block) => block.text).join("");
    if (text.trim() === "") {
      throw new SdkBackendError("runtime_unavailable", "refusing to submit an empty prompt", {
        retryable: false,
        suggestion: "Send at least one non-empty text block.",
        rootSessionId: payload.sessionId,
      });
    }
    const task = await this.taskForSession(payload.sessionId);
    const cwd = await this.cwdForTask(task);
    const route = this.configuredRoute();
    // Submissions are serialized per task before any state is resolved: a
    // concurrent prompt must not create a second state or overwrite the
    // execution generation the previous one is still using.
    const previousSubmit = this.submissionLocks.get(task.taskId) ?? Promise.resolve();
    let releaseSubmit!: () => void;
    const held = previousSubmit.then(() => new Promise<void>((release) => { releaseSubmit = release; }));
    this.submissionLocks.set(task.taskId, held);
    await previousSubmit;
    try {
    const record = await this.claimRuntime(task, cwd, route);
    const state = this.stateFor(task);

    if (state.executionSeq === 0) {
      state.executionSeq = await this.executionCounter().load(task.taskId);
    }
    // Single in-flight execution per task, checked inside the same submission
    // lock that reserves the generation: the SDK exposes no message->turn
    // association, so a second accepted input could be consumed by a turn that
    // belongs to another execution. The refused submit never calls prompt.
    if (state.executionInFlight === true) {
      throw new SdkBackendError(
        "prompt_in_flight",
        "one execution is already in flight for this task; wait for it to settle, then submit the next input as a follow-up",
        {
          retryable: false,
          suggestion:
            "retryable=false means this submission is not retried automatically; the task can still be continued with dsh_followup once the current execution settles.",
          taskId: task.taskId,
          rootSessionId: task.sessionId,
        },
      );
    }    if (record.existed) {
      // A gap recorded by a previous runtime generation, a crash, or another
      // process must be read from disk: this instance's in-memory coverage can
      // be stale after an unclean exit.
      const coverage = await new SdkObservedEventStore(this.config.homeDir).coverage(task.taskId);
      if (!coverage.complete) {
        throw new SdkBackendError(
          "observation_gap",
          "this task has an unrepaired observation gap; a normal follow-up would look like a complete transcript while earlier events are missing",
          {
            retryable: false,
            suggestion:
              "Start a new task with an explicit handoff summary, or keep using read-only status/tail which report the gap explicitly.",
            taskId: task.taskId,
            rootSessionId: task.sessionId,
            coverage,
          },
        );
      }
    }

    let runtime: ManagedSdkRuntime;
    try {
      runtime = await this.manager.acquire({
        taskId: task.taskId,
        sessionId: task.sessionId,
        cwd,
        route,
        resume: record.existed,
        onNotification: (managed, notification) => this.handleNotification(task.taskId, managed, notification),
        onRequest: (managed, method, params) => this.handleServerRequest(task.taskId, managed, method, params),
        onUserQuestion: (managed, request, context) => this.handleUserQuestion(task.taskId, managed, request, context),
      });
    } catch (error) {
      throw this.mapRuntimeError(error, task.taskId, task.sessionId);
    }
    if (runtime.serverInfo !== undefined) {
      this.wireIdentity = { name: runtime.serverInfo.name, version: runtime.serverInfo.version };
    }
    state.generation = runtime.generation;
    // Record the runtime process identity before any prompt: a bridge pid alone
    // cannot prove which runtime a record belongs to, and pids are reused. A record
    // that cannot carry this evidence must not keep accepting input.
    const runtimeIdentity = runtime.client.runtimeIdentity?.();
    if (runtimeIdentity !== undefined) {
      const owner = await this.registry.get(task.taskId).catch(() => undefined);
      if (owner === undefined || owner.owner.bridgeInstanceId !== this.bridgeInstanceId) {
        await this.manager.closeAll("identity-owner-mismatch").catch(() => undefined);
        throw new SdkBackendError(
          "runtime_owner_conflict",
          "the runtime identity could not be recorded because the task record is owned by another bridge instance",
          {
            retryable: false,
            suggestion: "Inspect the task record owner before retrying.",
            taskId: task.taskId,
            rootSessionId: task.sessionId,
          },
        );
      }
      try {
        await this.registry.update(task.taskId, {
          diagnostic: { runtimePid: runtimeIdentity.pid, runtimeStartedAt: runtimeIdentity.startedAt },
        });
      } catch (error) {
        // Unproven identity: stop the runtime we just started instead of leaving an
        // untraceable process behind, and never send the prompt.
        await this.manager.closeAll("identity-persist-failed").catch(() => undefined);
        throw new SdkBackendError(
          "runtime_identity_mismatch",
          "the runtime identity could not be persisted, so the prompt was not sent",
          {
            retryable: false,
            suggestion: "Inspect the SDK bridge home permissions, then retry the delegation.",
            taskId: task.taskId,
            rootSessionId: task.sessionId,
            reason: errorMessage(error),
          },
        );
      }
    }
    await this.registry
      .update(task.taskId, { observationEpoch: runtime.generation })
      .catch((error: unknown) => {
        this.logger(`[dsh-agentlink] sdk observation epoch not persisted task=${task.taskId}: ${errorMessage(error)}`);
      });
    state.phase = "running";
    const issuedRpcId = `sdk-prompt-${runtime.generation}-${++this.serial}`;
    // Reserve the execution generation before submitting: an event may arrive
    // while the prompt receipt is still in flight, and it must already belong
    // to this execution rather than to the previous one.
    state.executionSeq += 1;
    state.executionId = `e${state.executionSeq}`;
    const reservedExecutionId = state.executionId;
    state.executionInFlight = true;
    state.inFlightExecutionId = reservedExecutionId;
    // The generation must be durable before the prompt leaves: a restart would
    // otherwise reuse it and collide with an existing outbox record. A failed
    // write aborts the submit instead of risking a duplicate identity.
    try {
      await this.executionCounter().persist(task.taskId, state.executionSeq);
    } catch (error) {
      // Nothing was sent, so the reservation is released and a later submit may
      // reuse the lock without inheriting a phantom in-flight execution.
      state.pendingExecutions = (state.pendingExecutions ?? []).filter((value) => value !== reservedExecutionId);
      state.executionInFlight = false;
      throw new SdkBackendError("runtime_unavailable", "the execution generation could not be persisted, so the prompt was not sent", {
        retryable: false,
        suggestion: "Inspect the SDK bridge home permissions, then retry the delegation.",
        taskId: task.taskId,
        rootSessionId: task.sessionId,
        reason: errorMessage(error),
      });
    }
    state.executionUncertain = false;
    try {
      const messageId = await runtime.client.prompt(task.sessionId, textBlocks(payload.content));
      const executions = state.messageExecutions ?? (state.messageExecutions = new Map());
      // executionId -> messageId: a turn claims the generation by the message it
      // consumed, so the lookup must follow that direction.
      executions.set(state.executionId, messageId);
      state.messageIds.push(messageId);
      this.manager.noteActivity(task.taskId);
      await this.ledger
        .append(task.taskId, {
          sourceSessionId: task.sessionId,
          origin: "root",
          type: "bridge/prompt-issued",
          raw: {
            issuedRpcId,
            mode: "queue",
            provenance: "bridge-local-operation-id",
            messageId,
            generation: runtime.generation,
          },
        })
        .catch((error: unknown) => {
          this.logger(`[dsh-agentlink] sdk prompt ledger append failed task=${task.taskId}: ${errorMessage(error)}`);
        });
      const value: DshSessionPromptValue = {
        accepted: true,
        messageId,
        messageIdSource: "sdk-durable-inbox",
        clientTimeZoneApplied: false,
      };
      return attachDshUnaryMetadata(value, { issuedRpcId, method: "session/prompt" });
    } catch (error) {
      // A receipt timeout or a dropped transport means the runtime may already
      // have accepted the message: never retry, report the uncertainty.
      throw new SdkBackendError(
        "prompt_outcome_unknown",
        "the SDK runtime did not confirm the prompt receipt; the message may already be queued, so it was not retried",
        {
          retryable: false,
          suggestion:
            "Inspect dsh_status for observed events before deciding. Resubmitting the same input can duplicate work.",
          taskId: task.taskId,
          rootSessionId: task.sessionId,
          reason: errorMessage(error),
        },
        { cause: error },
      );
    }
    } finally {
      releaseSubmit();
      if (this.submissionLocks.get(task.taskId) === held) this.submissionLocks.delete(task.taskId);
    }
  }

  /** Explicit operator recovery: restore this exact persisted session without submitting input. */
  async recoverTask(taskId: string, expected: { ownerInstanceId: string; updatedAt: string }) {
    const task = await this.tasks.get(taskId);
    const stored = await this.registry.get(taskId);
    if (!stored || this.manager.get(taskId)) {
      throw new SdkBackendError("runtime_owner_conflict", "recovery requires a stored task without a locally loaded runtime", {
        taskId, retryable: false, suggestion: "Inspect the exact task and runtime ownership first.",
      });
    }
    const cwd = await this.cwdForTask(task);
    const route = this.configuredRoute();
    const recovered = await this.registry.recoverOrphan({
      taskId, rootSessionId: task.sessionId, canonicalCwd: cwd,
      dshHome: this.sdk.dshHome, profile: this.sdk.profile, route,
      configFingerprint: this.configFingerprint(route), observationEpoch: stored.observationEpoch + 1,
      owner: { bridgeInstanceId: this.bridgeInstanceId, pid: process.pid, startedAt: new Date(this.now()).toISOString() },
    }, expected);
    const state = this.stateFor(task);

    if (state.executionSeq === 0) {
      state.executionSeq = await this.executionCounter().load(task.taskId);
    }
    const runtime = await this.manager.acquire({
      taskId, sessionId: task.sessionId, cwd, route, resume: true,
      onNotification: (managed, notification) => this.handleNotification(taskId, managed, notification),
      onRequest: (managed, method, params) => this.handleServerRequest(taskId, managed, method, params),
      onUserQuestion: (managed, request, context) => this.handleUserQuestion(taskId, managed, request, context),
    });
    state.generation = runtime.generation;
    await this.manager.waitForTask({ taskId, sessionId: task.sessionId, timeoutMs: this.config.requestTimeoutMs });
    const snapshot = await this.ledger.snapshot(taskId);
    if (snapshot.execution === "running") {
      await this.ledger.append(taskId, { sourceSessionId: task.sessionId, origin: "root",
        type: "bridge/turn-interrupted", raw: { reason: "operator-recovery-after-unproven-exit" } });
    }
    return {
      taskId, rootSessionId: task.sessionId, promptSubmitted: false,
      backupPath: recovered.backupPath,
      observation: await new SdkObservedEventStore(this.config.homeDir).coverage(taskId),
    };
  }

  // ------------------------------------------------------------------ history

  async readHistory(
    taskId: string,
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshObservedHistory>> {
    signal?.throwIfAborted();
    const task = await this.tasks.get(taskId);
    if (task.sessionId !== sessionId) {
      const state = this.states.get(taskId);
      const lineage = state?.lineage.get(sessionId);
      if (lineage === undefined) {
        throw new SdkBackendError(
          "backend_mismatch",
          `session ${sessionId} is not part of task ${taskId}`,
          {
            retryable: false,
            suggestion: "Use the session ids reported by dsh_status.lineage for this task.",
            taskId,
            rootSessionId: task.sessionId,
          },
        );
      }
    }
    const page = await this.store.readSession(taskId, sessionId, options);
    const history: DshObservedHistory = {
      events: page.events.flatMap((record) => {
        const event = asObject(record.event);
        if (event === undefined || typeof event.type !== "string" || typeof event.seq !== "number") return [];
        return [{ event: event as unknown as DshSessionHistory["events"][number]["event"] }];
      }),
      hasMore: page.hasMore,
      coverage: page.coverage,
    };
    return attachDshUnaryMetadata(history, { issuedRpcId: this.localRpcId("bridge/observed-history"), method: "session/observed-history" });
  }

  /** Record a bridge-local display title; the SDK wire has no rename. */
  async recordTaskTitle(taskId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed === "") return;
    const state = this.states.get(taskId);
    if (state !== undefined) state.bridgeTitle = trimmed;
    try {
      await this.registry.update(taskId, { title: trimmed, titleSource: "bridge" });
    } catch (error) {
      // A missing record means the runtime was never claimed; the title then
      // stays in memory and is re-derived on the next delegation.
      this.logger(`[dsh-agentlink] sdk title not persisted task=${taskId}: ${errorMessage(error)}`);
    }
    await this.ledger
      .append(taskId, {
        sourceSessionId: state?.sessionId ?? "",
        origin: "root",
        type: "bridge/title",
        raw: { title: trimmed, titleSource: "bridge" },
      })
      .catch(() => undefined);
  }

  /** Bridge-owned discovery: only tasks this bridge registered, with stated freshness. */
  async bridgeCatalog(): Promise<DshBridgeOwnedSession[]> {
    const records = await this.registry.list();
    const snapshots = this.manager.snapshot();
    const sessions: DshBridgeOwnedSession[] = [];
    for (const record of records) {
      const state = this.states.get(record.taskId);
      const coverage = await this.store.coverage(record.taskId);
      const runtime = snapshots.find((candidate) => candidate.taskId === record.taskId);
      const nativeTitle = state?.nativeTitle;
      const bridgeTitle = state?.bridgeTitle ?? record.title;
      sessions.push({
        taskId: record.taskId,
        sessionId: record.rootSessionId,
        cwd: record.canonicalCwd,
        title: nativeTitle ?? bridgeTitle ?? null,
        titleSource: nativeTitle !== undefined ? "dsh-native" : bridgeTitle !== undefined ? "bridge" : null,
        runtimeState: runtime?.state ?? "absent",
        running:
          state === undefined
            ? null
            : state.rootStatus === "running"
              ? true
              : state.rootStatus === "idle"
                ? false
                : null,
        phase: state?.phase ?? "unknown",
        blank: state === undefined ? null : state.observedEvents === 0,
        observation: coverage,
        cleanShutdown: record.cleanShutdown,
        updatedAt: record.updatedAt,
      });
    }
    return sessions;
  }

  async sessionHistory(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshObservedHistory>> {
    const task = await this.taskForSession(sessionId);
    return this.readHistory(task.taskId, sessionId, options, signal);
  }

  async subagentHistory(
    address: DshSubagentAddress,
    options: { beforeSeq?: number; maxMessages?: number } = {},
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshObservedHistory>> {
    const task = await this.taskForSession(address.parentSessionId);
    const state = this.stateFor(task);

    if (state.executionSeq === 0) {
      state.executionSeq = await this.executionCounter().load(task.taskId);
    }
    if (!state.lineage.has(address.childSessionId)) {
      throw new SdkBackendError(
        "backend_mismatch",
        "the requested child session is not part of this task's observed lineage",
        {
          retryable: false,
          suggestion: "Read dsh_status.lineage for the verified child sessions of this task.",
          taskId: task.taskId,
          rootSessionId: task.sessionId,
          childSessionId: address.childSessionId,
        },
      );
    }
    return this.readHistory(task.taskId, address.childSessionId, options, signal);
  }

  // -------------------------------------------------------------- unsupported

  async sessionList(signal?: AbortSignal): Promise<DshUnaryResult<DshSessionListValue>> {
    signal?.throwIfAborted();
    throw unsupportedCapability(
      "sessionDiscovery",
      "the SDK wire exposes no session catalog; only tasks this bridge registered are discoverable",
    );
  }

  async sessionModels(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionModels>> {
    signal?.throwIfAborted();
    throw unsupportedCapability(
      "modelCatalog",
      `the SDK backend cannot enumerate models for ${sessionId}: the runtime validates one route during initialize and exposes no catalog`,
    );
  }

  async sessionSelectModel(
    _payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionSelectModelValue>> {
    signal?.throwIfAborted();
    throw unsupportedCapability(
      "dynamicModelSelection",
      "the SDK backend fixes the provider/model route during the runtime initialize handshake; it cannot switch models for a live session",
    );
  }

  async sessionRename(
    _sessionId: string,
    _title: string,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionRenameValue>> {
    signal?.throwIfAborted();
    throw unsupportedCapability(
      "nativeRename",
      "the SDK wire has no rename method; the bridge records display titles locally instead",
    );
  }

  async sessionCancel(_sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionCancelValue>> {
    signal?.throwIfAborted();
    throw unsupportedCapability(
      "turnCancel",
      "the SDK wire has no turn or session cancel; abandoning a turn would require closing the runtime, which is a different semantic",
    );
  }

  async sessionUpdateQueue(
    _sessionId: string,
    _itemId: string,
    _action: { kind: "remove" },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionUpdateQueueValue>> {
    signal?.throwIfAborted();
    throw unsupportedCapability(
      "queueMutation",
      "the SDK wire exposes no pending-inbox snapshot or queue mutation",
    );
  }

  async subagentList(parentSessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSubagentListValue>> {
    signal?.throwIfAborted();
    await this.taskForSession(parentSessionId);
    // Observed lineage is reported through dsh_status; the wire has no
    // one-shot/continuable mode classification to report here.
    throw unsupportedCapability(
      "subagentList",
      "the SDK wire has no subagent listing; the bridge reports observed lineage in dsh_status instead",
    );
  }

  openMux(): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    throw unsupportedCapability(
      "eventsMuxWebSocket",
      "the SDK backend streams notifications over stdio JSON-RPC; there is no events mux WebSocket",
    );
  }

  // ------------------------------------------------------------------ pending

  pendingForTask(taskId: string): DshPendingEnvelope[] {
    const state = this.states.get(taskId);
    if (state === undefined) return [];
    return [...state.pending.values()].map((pending) => this.envelopeFor(pending));
  }

  groupPendingInteractions(taskId: string): Array<{ key: string; requestId: string; kind: "approval" | "question"; sessionId: string }> {
    const state = this.states.get(taskId);
    if (state === undefined) return [];
    return [...state.pending.values()].map((pending) => ({
      key: pending.kind === "approval" ? `approval:${pending.sessionId}:${pending.approvalId}` : `rpc:${pending.sessionId}:${pending.requestId}`,
      requestId: pending.requestId,
      kind: pending.kind,
      sessionId: pending.sessionId,
    }));
  }

  async answerQuestion(
    taskId: string,
    requestId: string,
    answers: DshQuestionAnswer[],
  ): Promise<{ accepted: true; requestId: string }> {
    const { pending, state } = this.findPending(taskId, requestId);
    if (pending.kind !== "question") {
      throw new PendingInteractionError("wrong-type", `pending interaction ${requestId} is an approval, not a question`);
    }
    const wanted = new Set(pending.questions.map((question) => question.id));
    for (const answer of answers) {
      if (!wanted.has(answer.id)) {
        throw new PendingInteractionError("invalid-answer", `answer id ${JSON.stringify(answer.id)} is not part of this question request`);
      }
    }
    if (answers.length !== wanted.size) {
      throw new PendingInteractionError(
        "invalid-answer",
        "every question in the request must be answered exactly once",
      );
    }
    this.settlePending(state, pending, { answers });
    await this.recordResolved(taskId, pending, "answered");
    return { accepted: true, requestId };
  }

  async resolveApproval(
    taskId: string,
    requestId: string,
    outcome: "allow_once" | "reject",
  ): Promise<{ accepted: true; requestId: string; outcome: "allowed-once" | "rejected" }> {
    const { pending, state } = this.findPending(taskId, requestId);
    if (pending.kind !== "approval") {
      throw new PendingInteractionError("wrong-type", `pending interaction ${requestId} is a question, not an approval`);
    }
    const resolved = outcome === "allow_once" ? "allowed-once" : "rejected";
    this.settlePending(state, pending, { outcome: resolved });
    await this.recordResolved(taskId, pending, resolved);
    return { accepted: true, requestId, outcome: resolved };
  }

  async respond(message: DshClientResponse, signal?: AbortSignal): Promise<{ accepted: true } | { accepted: false; reason: "not-pending" | "bad-response" }> {
    signal?.throwIfAborted();
    const value = asObject(message.result?.value);
    if (value === undefined) return { accepted: false, reason: "bad-response" };
    for (const state of this.states.values()) {
      const pending = state.pending.get(message.rpcId);
      if (pending === undefined) continue;
      if (pending.sessionId !== value.sessionId) {
        throw new PendingInteractionError("wrong-task", "the response session does not match the pending interaction");
      }
      if (pending.kind === "approval") {
        const outcome = value.outcome;
        if (outcome !== "allowed-once" && outcome !== "rejected") return { accepted: false, reason: "bad-response" };
        this.settlePending(state, pending, { outcome });
        await this.recordResolved(state.taskId, pending, outcome);
        return { accepted: true };
      }
      const answersValue = asObject(value.answer);
      const answers = Array.isArray(answersValue?.answers) ? (answersValue.answers as DshQuestionAnswer[]) : undefined;
      if (answers === undefined) return { accepted: false, reason: "bad-response" };
      this.settlePending(state, pending, { answers });
      await this.recordResolved(state.taskId, pending, "answered");
      return { accepted: true };
    }
    return { accepted: false, reason: "not-pending" };
  }

  // ------------------------------------------------------------------- waits

  /**
   * Wait until this task records new observation or the ledger cursor advances.
   * Returns `timedOut: true` when nothing changed within the bound.
   */
  async waitForTaskChange(taskId: string, afterCursor: number, waitMs: number, afterRevision?: number): Promise<{ timedOut: boolean }> {
    const state = this.stateOrUndefined(taskId);
    const revision = state?.revision ?? 0;
    const changed = () => (state?.revision ?? 0) !== revision ||
      (afterRevision !== undefined && this.changes !== afterRevision);
    const snapshot = await this.ledger.snapshot(taskId);
    if (snapshot.cursor > afterCursor || changed()) return { timedOut: false };
    if (waitMs <= 0) return { timedOut: true };
    const timedOut = await new Promise<boolean>((resolve) => {
      const waiter = { revision, cursor: afterCursor, resolve: () => { clearTimeout(timer); resolve(false); } };
      const list = this.waiters.get(taskId) ?? [];
      list.push(waiter);
      this.waiters.set(taskId, list);
      const timer = setTimeout(() => {
        const current = this.waiters.get(taskId) ?? [];
        this.waiters.set(taskId, current.filter((candidate) => candidate !== waiter));
        resolve(true);
      }, waitMs);
    });
    return { timedOut };
  }

  // ------------------------------------------------------------------ internals

  private localRpcId(method: string): string {
    return `sdk-local-${method}-${++this.serial}`;
  }

  private configuredRoute(): { provider: string; model: string; reasoningEffort?: string } {
    return {
      provider: this.sdk.provider ?? "deepseek-official",
      model: this.sdk.model ?? "deepseek-v4-flash",
      ...(this.sdk.reasoningEffort === undefined ? {} : { reasoningEffort: this.sdk.reasoningEffort }),
    };
  }

  private stateOrUndefined(taskId: string): TaskState | undefined {
    return this.states.get(taskId);
  }

  private stateFor(task: TaskRecord): TaskState {
    const existing = this.states.get(task.taskId);
    if (existing !== undefined) return existing;
    const state: TaskState = {
      taskId: task.taskId,
      sessionId: task.sessionId,
      generation: 0,
      executionSeq: 0,
      phase: "unknown",
      rootStatus: "unknown",
      lineage: new Map([
        [task.sessionId, { sessionId: task.sessionId, origin: "root", running: "unknown", verified: true }],
      ]),
      pending: new Map(),
      lastSeqBySession: new Map(),
      observedEvents: 0,
      unknownNotifications: [],
      messageIds: [],
      revision: 0,
    };
    this.states.set(task.taskId, state);
    this.sessionTasks.set(task.sessionId, task.taskId);
    return state;
  }

  /** Resolve a task by its exact root session id, accepting only bridge-owned mappings. */
  private async taskForSession(sessionId: string): Promise<TaskRecord> {
    const known = this.sessionTasks.get(sessionId);
    if (known !== undefined) return this.tasks.get(known);
    const mapping = (await this.tasks.list()).filter((record) => record.sessionId === sessionId);
    if (mapping.length > 1) {
      throw new SdkBackendError(
        "backend_mismatch",
        `session ${sessionId} is mapped to multiple bridge tasks`,
        {
          retryable: false,
          suggestion: "Repair the task mapping directory before continuing.",
          rootSessionId: sessionId,
        },
      );
    }
    const task = mapping[0];
    if (task === undefined) {
      throw new SdkBackendError(
        "backend_mismatch",
        `session ${sessionId} is not a task registered by this bridge`,
        {
          retryable: false,
          suggestion:
            "The SDK backend only continues tasks it created. Start a new delegation, or use the gateway backend for Host-catalog sessions.",
          rootSessionId: sessionId,
        },
      );
    }
    this.sessionTasks.set(sessionId, task.taskId);
    return task;
  }

  private async cwdForTask(task: TaskRecord): Promise<string> {
    const created = this.sessionCwd.get(task.sessionId);
    if (created !== undefined) return created;
    const cached = this.cwdsBySession.get(task.sessionId);
    if (cached !== undefined) return cached;
    const record = await this.registry.get(task.taskId);
    if (record === undefined) {
      throw new SdkBackendError(
        "runtime_identity_mismatch",
        "the task has no recorded SDK runtime identity, so its workspace and model route cannot be reconstructed",
        {
          retryable: false,
          suggestion: "Start a new delegation; a task created by another backend cannot be promoted to the SDK backend.",
          taskId: task.taskId,
          rootSessionId: task.sessionId,
        },
      );
    }
    this.cwdsBySession.set(task.sessionId, record.canonicalCwd);
    return record.canonicalCwd;
  }

  private configFingerprint(route: { provider: string; model: string; reasoningEffort?: string }): string {
    return RuntimeRegistry.configFingerprint({
      backend: "sdk",
      dshHome: this.sdk.dshHome,
      profile: this.sdk.profile,
      route,
      ...(this.sdk.bin === undefined ? {} : { bin: this.sdk.bin }),
    });
  }

  private async claimRuntime(
    task: TaskRecord,
    cwd: string,
    route: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<{ record: SdkRuntimeRecord; existed: boolean }> {
    const existing = await this.registry.get(task.taskId);
    const fingerprint = this.configFingerprint(route);
    try {
      const claimed = await this.registry.claim({
        taskId: task.taskId,
        rootSessionId: task.sessionId,
        canonicalCwd: cwd,
        dshHome: this.sdk.dshHome,
        profile: this.sdk.profile,
        route,
        configFingerprint: fingerprint,
        observationEpoch: existing?.observationEpoch ?? 1,
        owner: { bridgeInstanceId: this.bridgeInstanceId, pid: process.pid, startedAt: new Date(this.now()).toISOString() },
        ...(existing?.title === undefined ? {} : { title: existing.title }),
      });
      return { record: claimed.record, existed: !claimed.created };
    } catch (error) {
      if (error instanceof RuntimeRegistryError) {
        if (error.code === "owner_conflict") {
          throw new SdkBackendError(
            "runtime_owner_conflict",
            "another bridge instance owns this task's SDK runtime",
            {
              retryable: false,
              suggestion:
                "Close the other bridge (or its leftover record) before continuing; this bridge never takes over an unproven runtime.",
              taskId: task.taskId,
              rootSessionId: task.sessionId,
              owner: error.details.owner ?? null,
            },
            { cause: error },
          );
        }
        if (error.code === "identity_mismatch") {
          throw new SdkBackendError(
            "runtime_identity_mismatch",
            "the recorded SDK runtime identity does not match the current backend configuration",
            {
              retryable: false,
              suggestion:
                "Restore the DSH_HOME, DSH_SDK_PROFILE, provider, and model used when the task was created, or start a new task.",
              taskId: task.taskId,
              rootSessionId: task.sessionId,
              differing: error.details.differing ?? error.details,
            },
            { cause: error },
          );
        }
        throw new SdkBackendError(
          "runtime_unavailable",
          error.message,
          {
            retryable: false,
            suggestion: "Inspect the runtime registry files with the doctor and repair them before retrying.",
            taskId: task.taskId,
            rootSessionId: task.sessionId,
          },
          { cause: error },
        );
      }
      throw error;
    }
  }

  private mapRuntimeError(error: unknown, taskId: string, sessionId: string): Error {
    if (error instanceof SdkBackendError) return error;
    return new SdkBackendError(
      "runtime_unavailable",
      `the SDK runtime for task ${taskId} could not be used`,
      {
        retryable: true,
        suggestion: "Retry once; if it repeats, run the doctor live probe and inspect the bounded stderr tail.",
        taskId,
        rootSessionId: sessionId,
        reason: errorMessage(error),
      },
      { cause: error },
    );
  }

  // ------------------------------------------------------- observation plumbing

  /**
   * Monotonic view clock for this backend.
   *
   * Folding the manager's lifecycle counter with the observation counter keeps
   * the value strictly increasing across runtime removal and rebuild, so a view
   * that changed can never reuse a previous revision (no ABA acceptance).
   */
  get changes(): number {
    return this.viewClock + this.manager.changes;
  }

  private bumpRevision(taskId: string, cursor: number): void {
    const state = this.states.get(taskId);
    this.viewClock += 1;
    if (state !== undefined) state.revision += 1;
    const waiters = this.waiters.get(taskId);
    if (waiters === undefined || waiters.length === 0) return;
    const remaining: typeof waiters = [];
    for (const waiter of waiters) {
      if (waiter.revision !== (state?.revision ?? 0) || cursor > waiter.cursor) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters.set(taskId, remaining);
  }

  private async degrade(
    taskId: string,
    reason: ObservedDegradationReason,
    detail: string,
  ): Promise<void> {
    const state = this.states.get(taskId);
    this.viewClock += 1;
    if (state !== undefined) {
      state.degraded = { reason, detail, at: new Date(this.now()).toISOString() };
    }
    try {
      await this.store.degrade(taskId, reason, detail);
    } catch (error) {
      this.logger(`[dsh-agentlink] sdk observation degrade failed task=${taskId}: ${errorMessage(error)}`);
    }
  }

  private async handleNotification(
    taskId: string,
    runtime: ManagedSdkRuntime,
    notification: SdkRuntimeNotification,
  ): Promise<void> {
    const task = await this.tasks.get(taskId).catch(() => undefined);
    if (task === undefined) return;
    const state = this.stateFor(task);

    if (state.executionSeq === 0) {
      state.executionSeq = await this.executionCounter().load(task.taskId);
    }
    this.manager.noteActivity(taskId);
    switch (notification.method) {
      case "session.event":
        await this.handleSessionEvent(task, state, runtime, notification.params);
        return;
      case "session.status": {
        const sessionId = stringField(notification.params, "sessionId");
        const status = stringField(notification.params, "status");
        if (sessionId === undefined || (status !== "idle" && status !== "running")) {
          await this.degrade(taskId, "observation_degraded", "received a malformed session.status notification");
          return;
        }
        const row = state.lineage.get(sessionId);
        if (row !== undefined) row.running = status === "running";
        if (sessionId === task.sessionId && status === "idle") {
          const deferred = state.deferredCompletion;
          const settledExecutionId = deferred?.executionId ?? state.inFlightExecutionId;
          if (
            deferred !== undefined &&
            settledExecutionId !== undefined &&
            (state.activeDescendants ?? new Set<string>()).size === 0
          ) {
            state.deferredCompletion = undefined;
            // Confirmation is detached: the notification loop must keep draining,
            // and a late answer may only settle the execution it was started for.
            void this.settleExecution(runtime, task.taskId, task.sessionId, state, {
              executionId: settledExecutionId,
              terminal: deferred.terminal,
              turnSeq: deferred.turnSeq,
            });
          }
        }
        if (sessionId === task.sessionId) {
          state.rootStatus = status;
          state.phase = status === "running" ? "running" : state.pending.size > 0 ? "awaiting_input" : "idle";
        }
        this.bumpRevision(taskId, (await this.ledger.snapshot(taskId)).cursor);
        return;
      }
      case "subagent.started": {
        const parentSessionId = stringField(notification.params, "parentSessionId");
        const childSessionId = stringField(notification.params, "childSessionId");
        if (parentSessionId === undefined || childSessionId === undefined) {
          await this.degrade(taskId, "observation_degraded", "received a malformed subagent.started notification");
          return;
        }
        state.lineage.set(childSessionId, {
          sessionId: childSessionId,
          origin: "subagent",
          parentSessionId,
          running: "unknown",
          verified: parentSessionId === task.sessionId || state.lineage.has(parentSessionId),
        });
        await this.ledger
          .append(taskId, {
            sourceSessionId: childSessionId,
            parentSessionId,
            origin: "subagent",
            type: "bridge/subagent-started",
            raw: { parentSessionId, childSessionId, generation: runtime.generation },
          })
          .catch(() => undefined);
        this.bumpRevision(taskId, 0);
        return;
      }
      case "subagent.finished": {
        const childSessionId = stringField(notification.params, "childSessionId");
        const status = stringField(notification.params, "status");
        if (childSessionId !== undefined) {
          const row = state.lineage.get(childSessionId);
          if (row !== undefined) {
            row.finished = true;
            row.running = false;
          }
        }
        await this.ledger
          .append(taskId, {
            sourceSessionId: childSessionId ?? task.sessionId,
            origin: "subagent",
            type: "bridge/subagent-finished",
            raw: {
              childSessionId,
              status,
              stopReason: stringField(notification.params, "stopReason"),
              generation: runtime.generation,
            },
          })
          .catch(() => undefined);
        this.bumpRevision(taskId, 0);
        return;
      }
      case "user-question.cancelled": {
        const requestId = stringField(notification.params, "requestId");
        if (requestId === undefined) return;
        const pending = state.pending.get(requestId);
        if (pending === undefined) return;
        this.settlePending(state, pending, { cancelled: true });
        await this.recordResolved(taskId, pending, "cancelled");
        return;
      }
      case "session.query.completed":
        // The adapter submits plain `session/prompt` only; a command completion
        // here means another client used the runtime, so keep it visible but do
        // not attribute it to a bridge prompt.
        await this.ledger
          .append(taskId, {
            sourceSessionId: task.sessionId,
            origin: "root",
            type: "bridge/observed-command-completion",
            raw: { generation: runtime.generation, finalResponse: stringField(notification.params, "finalResponse") ?? null },
          })
          .catch(() => undefined);
        return;
      default: {
        if (state.unknownNotifications.length < MAX_UNKNOWN_NOTIFICATIONS_RECORDED) {
          state.unknownNotifications.push(notification.method);
        }
        return;
      }
    }
  }

  private async handleSessionEvent(
    task: TaskRecord,
    state: TaskState,
    runtime: ManagedSdkRuntime,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = stringField(params, "sessionId");
    const event = asObject(params.event);
    const type = event === undefined ? undefined : stringField(event, "type");
    const seq = event === undefined ? undefined : numberField(event, "seq");
    if (sessionId === undefined || event === undefined || type === undefined || seq === undefined) {
      await this.degrade(task.taskId, "observation_degraded", "received a malformed session.event notification");
      return;
    }
    const origin: "root" | "subagent" = sessionId === task.sessionId ? "root" : "subagent";
    const row = state.lineage.get(sessionId);
    const parentSessionId = row?.parentSessionId;
    // Durability first: the observed event is written before any derived
    // coordination state, so a crash cannot leave a final-message pointer to
    // text that was never persisted.
    try {
      await this.store.append(task.taskId, [
        {
          sessionId,
          seq,
          origin,
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          observedAt: new Date(this.now()).toISOString(),
          event,
        },
      ]);
    } catch (error) {
      if (error instanceof ObservationConflictError) {
        await this.degrade(task.taskId, "corruption", `conflicting event content for ${sessionId}:${seq}`);
        return;
      }
      if (error instanceof ObservationStoreError) {
        await this.degrade(
          task.taskId,
          error.code === "event_too_large" ? "overflow" : "write_failure",
          `${error.code}: ${error.message}`,
        );
        return;
      }
      await this.degrade(task.taskId, "write_failure", errorMessage(error));
      return;
    }
    const previousSeq = state.lastSeqBySession.get(sessionId);
    if (previousSeq !== undefined && seq > previousSeq + 1) {
      await this.degrade(
        task.taskId,
        "observation_degraded",
        `missed events between ${previousSeq} and ${seq} in session ${sessionId}`,
      );
    }
    if (previousSeq === undefined || seq > previousSeq) state.lastSeqBySession.set(sessionId, seq);
    state.observedEvents += 1;
    state.lastEventAt = new Date(this.now()).toISOString();

    if (origin !== "root") {
      const active = state.activeDescendants ?? (state.activeDescendants = new Set<string>());
      if (type === "turn/start") active.add(sessionId);
      else if (type === "turn/end") {
        active.delete(sessionId);
        if (active.size === 0 && state.deferredCompletion !== undefined) {
          const deferred = state.deferredCompletion;
          state.deferredCompletion = undefined;
          state.runningExecutionId = state.runningExecutionId ?? state.pendingExecutions?.[0];
          await this.recordCoworkerCompletion(task.taskId, state, deferred.terminal, deferred.turnSeq, state.sessionId);
        }
      }
    }
    if (origin === "root") {
      if (type === "turn/start") {
        state.rootStatus = "running";
        state.phase = "running";
        // Pin the generation that owns this turn: a later submit must not
        // re-attribute the event that is already in flight.
        // FIFO: turns start in submission order, so the oldest pending
        // generation owns this turn even if a newer prompt is already queued.
        // One claim per turn/start: FIFO order matches submission order, and the
        // runtime is not assumed to report message ids on this event.
        const pending = state.pendingExecutions ?? (state.pendingExecutions = []);
        state.runningExecutionId = pending.length > 0 ? pending.shift() : state.executionId;      } else if (type === "turn/end") {
        state.rootStatus = "idle";
        state.lastTurnEndSeq = seq;
        state.lastTerminal = classifyTerminal(asObject(event.data)?.reason);
        state.phase = state.pending.size > 0 ? "awaiting_input" : "idle";
        // Background notification hook: runs inside the event handler, so a
        // completion is recorded even when the caller never watches or polls.
        this.trace("turn/end", { seq, sessionId, running: state.runningExecutionId, pending: [...(state.pendingExecutions ?? [])] });
        // SDK fact: one accepted input may span several root turns and the
        // activity interval ends at the next whole-agent idle, so a turn end is
        // only a candidate. The notice is written when idle arrives.
        const ownedExecutionId = state.runningExecutionId ?? state.executionId;
        if (ownedExecutionId !== undefined) {
          state.deferredCompletion = { executionId: ownedExecutionId, terminal: state.lastTerminal, turnSeq: seq };
        }
      } else if (type === "session/title") {
        const title = stringField(asObject(event.data), "title");
        if (title !== undefined) state.nativeTitle = title;
      }
    }

    const record = await this.ledger
      .append(task.taskId, {
        sourceSessionId: sessionId,
        sourceSeq: seq,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        origin,
        type: "session/event",
        raw: { type: "session/event", sessionId, event },
      })
      .catch((error: unknown) => {
        this.logger(`[dsh-agentlink] sdk ledger append failed task=${task.taskId}: ${errorMessage(error)}`);
        return undefined;
      });
    this.manager.noteActivity(task.taskId);
    this.bumpRevision(task.taskId, record?.cursor ?? 0);
  }

  private executionCounter(): ExecutionCounter {
    return new ExecutionCounter(this.config.homeDir);
  }

  /**
   * Confirm that the root activity interval really ended. The SDK's `session/wait`
   * waits for managed descendants and their root summary turns, so a child
   * finishing is never treated as "root summary complete".
   */
  private async confirmExecutionSettled(runtime: ManagedSdkRuntime, sessionId: string, signal: AbortSignal): Promise<boolean> {
    try {
      if (signal.aborted) return false;
      await runtime.client.request("session/wait", { sessionId });
      return true;
    } catch (error) {
      this.logger(`[dsh-agentlink] session/wait confirmation failed session=${sessionId}: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * Settle one execution after its activity interval ends. Identity matters: a
   * late `session/wait` answer may only release the execution it was started
   * for, and the completion record is written at most once per execution.
   */
  private async settleExecution(
    runtime: ManagedSdkRuntime,
    taskId: string,
    rootSessionId: string,
    state: TaskState,
    deferred: { executionId: string; terminal: TerminalKind | undefined; turnSeq: number },
  ): Promise<void> {
    const controller = new AbortController();
    this.settleControllers.add(controller);
    try {
      const confirmed = await this.confirmExecutionSettled(runtime, rootSessionId, controller.signal);
      if (controller.signal.aborted) return;
      if (state.inFlightExecutionId !== deferred.executionId) return;
      if (confirmed) state.executionInFlight = false;
      state.rootStatus = "idle";
      state.runningExecutionId = deferred.executionId;
      await this.recordCoworkerCompletion(taskId, state, deferred.terminal, deferred.turnSeq, rootSessionId);
      state.runningExecutionId = undefined;
    } catch (error) {
      this.logger(`[dsh-agentlink] execution settle failed task=${taskId}: ${errorMessage(error)}`);
    } finally {
      this.settleControllers.delete(controller);
    }
  }

  /** Redacted decision trace for tests; enabled with COWORKER_TRACE=1. */
  private trace(kind: string, detail: Record<string, unknown>): void {
    if (process.env.COWORKER_TRACE !== "1") return;
    process.stderr.write(`[coworker-trace] ${JSON.stringify({ kind, ...detail })}` + "\n");
  }

  /**
   * Persist one completion record for a bound task. Progress never enters the
   * outbox; only a terminal event does, and only once per execution generation.
   */
  private async recordCoworkerCompletion(
    taskId: string,
    state: TaskState,
    terminal: TerminalKind | undefined,
    turnSeq: number,
    eventSessionId: string,
  ): Promise<void> {
    const executionId = state.runningExecutionId ?? state.executionId;
    if (executionId === undefined) return;
    // Only the root task's own terminal event counts: descendant sub-agent turns
    // and intermediate step completions must not raise a completion notice.
    if (eventSessionId !== state.sessionId) return;
    // A root turn can end while a sub-agent it started is still working; the
    // completion notice waits for a terminal event with no active descendant.

    this.trace("record-candidate", { executionId, pending: [...(state.pendingExecutions ?? [])], descendants: [...(state.activeDescendants ?? [])] });
    if ((state.activeDescendants ?? new Set<string>()).size > 0) {
      // Remember that this terminal event still owes a notice; the descendant's
      // own end re-runs this check instead of waiting for another root turn.
      state.deferredCompletion = { executionId, terminal, turnSeq };
      return;
    }
    const activeDescendant = [...state.lineage.values()].some(
      (row) => row.sessionId !== state.sessionId && row.running === true,
    );
    if (activeDescendant) return;
    const bindings = this.coworkerBindings ?? new CoworkerBindings(this.config.homeDir);
    const binding = await bindings.get(taskId);
    if (binding === undefined) return;
    const execution = terminal === "failed" ? "failed" : "turn_completed";
    try {
      await bindings.writeCompletion(binding, {
        taskId,
        executionId,
        execution,
        turnSeq,
      });
    } catch (error) {
      this.logger(`[dsh-agentlink] coworker completion record failed task=${taskId}: ${errorMessage(error)}`);
    }
  }

  private async handleServerRequest(
    taskId: string,
    runtime: ManagedSdkRuntime,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== "approval/request") {
      // Fail closed: the runtime must not receive a fabricated result.
      throw new Error(`unsupported SDK server request: ${method}`);
    }
    const task = await this.tasks.get(taskId);
    const state = this.stateFor(task);

    if (state.executionSeq === 0) {
      state.executionSeq = await this.executionCounter().load(task.taskId);
    }
    if (state.pending.size >= MAX_PENDING_PER_TASK) {
      throw new Error("too many pending interactions for this task");
    }
    const sessionId = stringField(params, "sessionId");
    const toolName = stringField(params, "toolName");
    if (sessionId === undefined || toolName === undefined) {
      throw new Error("approval/request must carry sessionId and toolName");
    }
    this.assertOwnedSession(task, state, sessionId);
    const requestId = `sdk-approval-request-${runtime.generation}-${++this.serial}`;
    const approvalId = `sdk-approval-${runtime.generation}-${this.serial}`;
    const callId = stringField(params, "callId");
    const reason = stringField(params, "reason");
    const envelope: DshServerRequest<DshApprovalRequestedFrame> = {
      type: "server-request",
      rpcId: requestId,
      method: "approval/request",
      payload: {
        type: "approval/requested",
        sessionId,
        approvalId,
        toolName,
        ...(callId === undefined ? {} : { callId }),
        ...(reason === undefined ? {} : { reason }),
        approvalIdSource: "bridge-local" as const,
      },
    };
    const promise = new Promise<{ outcome: "allowed-once" | "rejected" | "cancelled" }>((resolve) => {
      const timer = setTimeout(() => {
        void (async () => {
          const pending = state.pending.get(requestId);
          if (pending === undefined) return;
          this.settlePending(state, pending, { outcome: "cancelled" });
          await this.recordResolved(taskId, pending, "cancelled");
        })();
      }, this.approvalTimeoutMs);
      state.pending.set(requestId, {
        kind: "approval",
        taskId,
        requestId,
        approvalId,
        sessionId,
        toolName,
        ...(callId === undefined ? {} : { callId }),
        ...(reason === undefined ? {} : { reason }),
        generation: runtime.generation,
        createdAt: this.now(),
        settle: (result) => resolve(result),
        timer,
      });
    });
    await this.ledger
      .append(taskId, { sourceSessionId: sessionId, origin: "root", type: "approval/requested", raw: envelope })
      .catch(() => undefined);
    state.phase = "awaiting_input";
    this.bumpRevision(taskId, 0);
    return promise;
  }

  private async handleUserQuestion(
    taskId: string,
    runtime: ManagedSdkRuntime,
    request: unknown,
    context: { signal: AbortSignal },
  ): Promise<unknown> {
    const task = await this.tasks.get(taskId);
    const state = this.stateFor(task);

    if (state.executionSeq === 0) {
      state.executionSeq = await this.executionCounter().load(task.taskId);
    }
    const object = asObject(request);
    const requestId = stringField(object, "requestId");
    const sessionId = stringField(object, "sessionId");
    const questions = mapQuestions(object?.questions);
    if (requestId === undefined || sessionId === undefined || questions === undefined) {
      throw new Error("user-question/ask must carry requestId, sessionId, and well-formed questions");
    }
    this.assertOwnedSession(task, state, sessionId);
    if (state.pending.size >= MAX_PENDING_PER_TASK) {
      throw new Error("too many pending interactions for this task");
    }
    const envelope: DshServerRequest<DshQuestionRequestedFrame> = {
      type: "server-request",
      rpcId: requestId,
      method: "user-question/ask",
      payload: { type: "question/requested", sessionId, questions },
    };
    // A runtime cancellation must settle the caller-side wait immediately; a
    // late answer is then rejected as not-pending.
    const promise = new Promise<{ answers: DshQuestionAnswer[] } | { cancelled: true }>((resolve) => {
      const timer = setTimeout(() => {
        void (async () => {
          const pending = state.pending.get(requestId);
          if (pending === undefined) return;
          this.settlePending(state, pending, { cancelled: true });
          await this.recordResolved(taskId, pending, "cancelled");
        })();
      }, this.approvalTimeoutMs);
      const pending: PendingQuestion = {
        kind: "question",
        taskId,
        requestId,
        sessionId,
        questions,
        generation: runtime.generation,
        createdAt: this.now(),
        settle: (result) => resolve(result),
        timer,
        signal: context.signal,
      };
      if (context.signal.aborted) {
        resolve({ cancelled: true });
        return;
      }
      const onAbort = () => {
        const current = state.pending.get(requestId);
        if (current === undefined) return;
        this.settlePending(state, current, { cancelled: true });
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      pending.abortListener = onAbort;
      state.pending.set(requestId, pending);
    });
    await this.ledger
      .append(taskId, { sourceSessionId: sessionId, origin: "root", type: "question/requested", raw: envelope })
      .catch(() => undefined);
    state.phase = "awaiting_input";
    this.bumpRevision(taskId, 0);
    return promise;
  }

  private assertOwnedSession(task: TaskRecord, state: TaskState, sessionId: string): void {
    if (sessionId === task.sessionId) return;
    const row = state.lineage.get(sessionId);
    if (row === undefined || row.verified !== true) {
      throw new Error(`session ${sessionId} is not a verified member of task ${task.taskId}`);
    }
  }

  private envelopeFor(pending: PendingInteraction): DshPendingEnvelope {
    if (pending.kind === "approval") {
      const approval: DshServerRequest<DshApprovalRequestedFrame> = {
        type: "server-request",
        rpcId: pending.requestId,
        method: "approval/request",
        payload: {
          type: "approval/requested",
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          toolName: pending.toolName,
          ...(pending.callId === undefined ? {} : { callId: pending.callId }),
          ...(pending.reason === undefined ? {} : { reason: pending.reason }),
          approvalIdSource: "bridge-local",
        },
      };
      return approval;
    }
    const question: DshServerRequest<DshQuestionRequestedFrame> = {
      type: "server-request",
      rpcId: pending.requestId,
      method: "user-question/ask",
      payload: { type: "question/requested", sessionId: pending.sessionId, questions: pending.questions },
    };
    return question;
  }

  private findPending(taskId: string, requestId: string): { pending: PendingInteraction; state: TaskState } {
    const state = this.states.get(taskId);
    if (state === undefined) {
      throw new PendingInteractionError("not-pending", `task ${taskId} has no pending interaction ${requestId}`);
    }
    const pending = state.pending.get(requestId);
    if (pending === undefined) {
      throw new PendingInteractionError(
        "not-pending",
        `the interaction ${requestId} is not pending; it may have timed out, been cancelled, or already been answered`,
      );
    }
    return { pending, state };
  }

  private settlePending(
    state: TaskState,
    pending: PendingInteraction,
    result: { outcome: "allowed-once" | "rejected" | "cancelled" } | { answers: DshQuestionAnswer[] } | { cancelled: true },
  ): void {
    if (!state.pending.delete(pending.requestId)) return;
    clearTimeout(pending.timer);
    if (pending.kind === "question") {
      if (pending.abortListener !== undefined) pending.signal?.removeEventListener("abort", pending.abortListener);
    }
    if (pending.kind === "approval") {
      pending.settle(result as { outcome: "allowed-once" | "rejected" | "cancelled" });
      return;
    }
    if ("cancelled" in result) {
      pending.settle({ cancelled: true });
      return;
    }
    if ("outcome" in result) {
      // A decision never applies to a question; fail the question closed.
      pending.settle({ cancelled: true });
      return;
    }
    pending.settle({ answers: result.answers });
  }

  private async recordResolved(
    taskId: string,
    pending: PendingInteraction,
    outcome: "allowed-once" | "rejected" | "cancelled" | "answered",
  ): Promise<void> {
    const state = this.states.get(taskId);
    if (state !== undefined && state.pending.size === 0) {
      state.phase = state.rootStatus === "running" ? "running" : "idle";
    }
    const raw =
      pending.kind === "approval"
        ? { type: "approval/resolved", sessionId: pending.sessionId, approvalId: pending.approvalId, outcome }
        : { type: "question/resolved", sessionId: pending.sessionId, questionRpcId: pending.requestId, outcome };
    await this.ledger
      .append(taskId, { sourceSessionId: pending.sessionId, origin: "root", type: raw.type, raw })
      .catch(() => undefined);
    this.bumpRevision(taskId, 0);
  }

  /**
   * Settle a runtime exit.
   *
   * Two independent facts decide the verdict: whether the child process proved
   * its exit, and whether the notification queue was drained into the store
   * before that. A run whose queue was not drained leaves an observation gap
   * even when the process exited normally — the bridge then stops claiming a
   * complete transcript for this task and refuses normal follow-ups.
   */
  private async onRuntimeExit(
    taskId: string,
    info: { clean: boolean; reason: string; error?: string; observationDrained: boolean },
  ): Promise<void> {
    const state = this.states.get(taskId);
    let clean = info.clean && info.observationDrained;
    if (state !== undefined) {
      // A runtime closed while a turn was in flight or an interaction was
      // pending cannot have observed the turn's terminal event.
      if (state.rootStatus === "running" || state.pending.size > 0) clean = false;
      for (const pending of [...state.pending.values()]) {
        this.settlePending(state, pending, pending.kind === "approval" ? { outcome: "cancelled" } : { cancelled: true });
      }
      if (state.rootStatus === "running") {
        state.lastTerminal = "interrupted";
        state.phase = "unknown";
        await this.ledger
          .append(taskId, {
            sourceSessionId: state.sessionId,
            origin: "root",
            type: "bridge/turn-interrupted",
            raw: {
              reason: info.reason,
              runtimeGeneration: state.generation,
              ...(state.lastTurnEndSeq === undefined ? {} : { lastTurnEndSeq: state.lastTurnEndSeq }),
            },
          })
          .catch(() => undefined);
      }
    }
    if (!info.observationDrained) {
      await this.degrade(
        taskId,
        "observation_degraded",
        `runtime exit (${info.reason}) did not drain its notification queue before shutdown`,
      );
    } else if (!info.clean) {
      await this.degrade(taskId, "observation_degraded", `runtime exit (${info.reason}): ${info.error ?? "unknown reason"}`);
    }
    try {
      await this.registry.markOwnerExited(taskId, this.bridgeInstanceId, {
        clean,
        at: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      this.logger(`[dsh-agentlink] sdk registry settle failed task=${taskId}: ${errorMessage(error)}`);
    }
    this.bumpRevision(taskId, 0);
  }
}

/** Build the SDK backend `DshApi`. Construction spawns nothing. */
export function createSdkDshApi(
  config: BridgeConfig,
  sdk: SdkBridgeConfig,
  options: SdkDshClientOptions = {},
): SdkDshClient {
  const client = new SdkDshClient(config, sdk, options);
  client.startReaper();
  return client;
}
