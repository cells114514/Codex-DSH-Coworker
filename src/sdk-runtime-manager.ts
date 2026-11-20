/**
 * Lifecycle manager for SDK runtime subprocesses.
 *
 * One root task owns one runtime. Ownership exists so a task's crash, its
 * initialized model route, and its later process-level stop stay isolated from
 * every other task. The manager is the only place that spawns, reclaims, or
 * shuts a runtime down, so the capacity limit, the idle reclamation policy, and
 * the "never kill active work" rule are enforced in one place.
 *
 * The client is behind a narrow structural seam (`SdkRuntimeClient`) so tests
 * drive the manager with a scripted fake and never load the official package.
 */
import type { SdkBridgeConfig } from "./config.js";
import { SdkBackendError } from "./sdk-errors.js";

export interface SdkRuntimeNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface SdkRuntimeSubscription {
  next(): Promise<SdkRuntimeNotification>;
  tryNext(): SdkRuntimeNotification | undefined;
  close(): void;
}

export interface SdkInitializeParams {
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  approvalRequests?: boolean;
  capabilities?: { userQuestions?: boolean };
}

export interface SdkInitializeResult {
  serverInfo: { name: string; version: string };
}

/**
 * The subset of `@deepseek-ai/dsh-sdk-client`'s `HarnessClient` this adapter
 * uses. `HarnessClient` satisfies it structurally.
 */
/** Best-effort runtime process identity, used for ownership evidence. */
export interface SdkRuntimeIdentity {
  pid: number;
  startedAt: string;
}

export interface SdkRuntimeClient {
  start(): void;
  onRequest?(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void;
  initialize(params: SdkInitializeParams): Promise<SdkInitializeResult>;
  prompt(sessionId: string, contentBlocks: Array<{ type: "text"; text: string }>): Promise<string>;
  resumeSession(sessionId: string): Promise<void>;
  getWorkingDirectory(sessionId: string): Promise<string>;
  subscribe(filter?: (notification: SdkRuntimeNotification) => boolean): SdkRuntimeSubscription;
  request(method: string, params?: object, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  /** The spawned runtime process, when the client can report it. */
  runtimeIdentity?(): SdkRuntimeIdentity | undefined;
}

export interface SdkRuntimeClientOptions {
  dshBin?: string;
  profile: string;
  dshHome: string;
  processCwd?: string;
  initializeTimeoutMs: number;
  shutdownTimeoutMs: number;
  onUserQuestion?: (request: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
}

export type SdkRuntimeClientFactory = (options: SdkRuntimeClientOptions) => SdkRuntimeClient;

export type SdkRuntimeState = "starting" | "ready" | "closing" | "crashed" | "closed";

export interface ManagedSdkRuntime {
  readonly taskId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly client: SdkRuntimeClient;
  readonly startedAt: string;
  state: SdkRuntimeState;
  lastActivityAt: number;
  /** Verified wire identity reported by the `initialize` handshake. */
  serverInfo?: { name: string; version: string };
  lastError?: string;
  subscription?: SdkRuntimeSubscription;
  /** True while the notification pump waits on an empty queue. */
  pumpIdle: boolean;
  /** Notifications consumed by the pump, in wire order. */
  pumpProcessed: number;
  pumpError?: string;
  /** The bounded drain did not reach an empty queue before shutdown. */
  drainTimedOut?: boolean;
  /** Whether the runtime exit was already reported to `onRuntimeExit`. */
  exitReported: boolean;
}

export interface AcquireSdkRuntimeInput {
  taskId: string;
  sessionId: string;
  cwd: string;
  route: { provider: string; model: string; reasoningEffort?: string };
  /** Resume the persisted session after initialize and before the caller prompts. */
  resume: boolean;
  onNotification: (runtime: ManagedSdkRuntime, notification: SdkRuntimeNotification) => void | Promise<void>;
  onRequest: (runtime: ManagedSdkRuntime, method: string, params: Record<string, unknown>) => Promise<unknown>;
  onUserQuestion: (runtime: ManagedSdkRuntime, request: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
}

export interface SdkRuntimeSnapshot {
  taskId: string;
  sessionId: string;
  generation: number;
  state: SdkRuntimeState;
  startedAt: string;
  lastActivityAt: string;
  lastError?: string;
  serverInfo?: { name: string; version: string };
  subscribePumpActive: boolean;
  /** Notifications consumed in wire order; a drain bound and an empty queue follow it. */
  pumpProcessed: number;
  pumpIdle: boolean;
  drainTimedOut: boolean;
}

/** Result of one shutdown attempt; `confirmed` is the only clean-shutdown signal. */
export interface CloseOutcome {
  taskId: string;
  confirmed: boolean;
  reason?: string;
}

export interface SdkRuntimeManagerOptions {
  sdk: SdkBridgeConfig;
  requestTimeoutMs: number;
  clientFactory?: SdkRuntimeClientFactory;
  /** Whether a task currently needs a human answer; such a runtime is never reclaimed. */
  hasPendingInteractions?: (taskId: string) => boolean;
  /** Whether a task has in-flight work; such a runtime is never reclaimed. */
  isBusy?: (taskId: string) => boolean;
  now?: () => number;
  /**
   * Reported once per runtime teardown. `observationDrained` is false when the
   * notification queue could not be proven empty before the bound expired, or
   * when the pump failed: the observation record is then incomplete even if the
   * child process exited normally.
   */
  onRuntimeExit?: (
    taskId: string,
    info: { clean: boolean; reason: string; error?: string; observationDrained: boolean },
  ) => void | Promise<void>;
  logger?: (message: string) => void;
  /** Bound on draining queued notifications during teardown (default 2000 ms). */
  drainTimeoutMs?: number;
  /** Bound on waiting for the pump to persist already-received notifications after a handshake. */
  acquisitionDrainTimeoutMs?: number;
}

const MIN_REAPER_INTERVAL_MS = 1_000;
const MAX_REAPER_INTERVAL_MS = 60_000;

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Import the official client lazily.
 *
 * A dynamic specifier keeps this repository's build independent of the
 * package's own declaration graph, and lets the SDK backend report a bounded
 * `sdk_unavailable` diagnostic when the dependency is absent instead of
 * failing at module load for users of the legacy or gateway backends.
 */
async function loadOfficialClient(): Promise<SdkRuntimeClientFactory> {
  const specifier = "@deepseek-ai/dsh-sdk-client";
  let loaded: unknown;
  try {
    loaded = await import(/* webpackIgnore: true */ specifier);
  } catch (error) {
    throw new SdkBackendError(
      "sdk_unavailable",
      "the official DeepSeek Harness TypeScript SDK client could not be loaded",
      {
        retryable: false,
        suggestion:
          "Install the pinned dependency (@deepseek-ai/dsh-sdk-client) or set DSH_SDK_BIN to a dsh CLI module that serves the SDK profile.",
        detail: errorMessage(error),
      },
      { cause: error },
    );
  }
  const ctor = (loaded as { HarnessClient?: new (options: unknown) => SdkRuntimeClient }).HarnessClient;
  if (typeof ctor !== "function") {
    throw new SdkBackendError("sdk_unavailable", "the loaded SDK client package does not export HarnessClient", {
      retryable: false,
      suggestion: "Reinstall the pinned @deepseek-ai/dsh-sdk-client dependency.",
    });
  }
  return (options) => {
    const client = new ctor({
      ...(options.dshBin === undefined ? {} : { dshBin: options.dshBin }),
      profile: options.profile,
      dshHome: options.dshHome,
      ...(options.processCwd === undefined ? {} : { processCwd: options.processCwd }),
      initializeTimeoutMs: options.initializeTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      ...(options.onUserQuestion === undefined ? {} : { onUserQuestion: options.onUserQuestion }),
    }) as SdkRuntimeClient & { child?: { pid?: number; spawnfile?: string } };
    // The SDK keeps its child process private; a pid plus spawn marker is the only
    // ownership evidence available to the bridge, so expose it best-effort.
    const runtimeIdentity = (): SdkRuntimeIdentity | undefined => {
      const child = client.child;
      if (child === undefined || typeof child.pid !== "number" || child.pid <= 0) return undefined;
      return { pid: child.pid, startedAt: new Date().toISOString() };
    };
    // A Proxy keeps the class methods (they live on the prototype) while adding
    // the identity accessor; spreading the instance would drop them.
    return new Proxy(client as SdkRuntimeClient, {
      get(target, property) {
        if (property === "runtimeIdentity") return runtimeIdentity;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

export class SdkRuntimeManager {
  private readonly runtimes = new Map<string, ManagedSdkRuntime>();
  private readonly generations = new Map<string, number>();
  private readonly pumps = new Map<string, Promise<void>>();
  /** In-flight acquisitions per task, so a second caller joins instead of spawning. */
  private readonly acquiring = new Map<string, Promise<ManagedSdkRuntime>>();
  /** In-flight teardowns per task, so repeated close requests are idempotent. */
  private readonly disposing = new Map<string, Promise<void>>();
  /**
   * Tasks whose child process exit could not be proven. They keep their capacity
   * slot and block a replacement runtime: starting beside a process whose exit is
   * unproved is how orphan runtimes are created.
   */
  private readonly unprovenExits = new Map<string, { reason: string; error: string }>();
  /** Exits that happened but were not proven complete (for example a drain timeout). */
  private readonly uncleanExits = new Map<string, string>();
  private readonly sdk: SdkBridgeConfig;
  private readonly requestTimeoutMs: number;
  private readonly clientFactory: SdkRuntimeClientFactory | undefined;
  private readonly hasPendingInteractions: (taskId: string) => boolean;
  private readonly isBusy: (taskId: string) => boolean;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  private readonly onRuntimeExit: SdkRuntimeManagerOptions["onRuntimeExit"];
  private readonly drainTimeoutMs: number;
  private readonly acquisitionDrainTimeoutMs: number;
  private reaper: NodeJS.Timeout | undefined;
  private reaperRunning = false;
  private closed = false;
  /** Slots reserved by an acquisition that has not registered its runtime yet. */
  private reservations = 0;
  /** Monotonic view clock; any registration, state change, or teardown advances it. */
  private changeCount = 0;

  constructor(options: SdkRuntimeManagerOptions) {
    this.sdk = options.sdk;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.clientFactory = options.clientFactory;
    this.hasPendingInteractions = options.hasPendingInteractions ?? (() => false);
    this.isBusy = options.isBusy ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? (() => undefined);
    this.onRuntimeExit = options.onRuntimeExit;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 2_000;
    this.acquisitionDrainTimeoutMs = options.acquisitionDrainTimeoutMs ?? 5_000;
  }

  get capacity(): number {
    return this.sdk.maxRuntimes;
  }

  /** Task ids with a loaded runtime, used for shutdown bookkeeping. */
  activeTaskIds(): string[] {
    return [...this.runtimes.keys()];
  }

  get size(): number {
    return this.runtimes.size;
  }

  /** Monotonic count of lifecycle changes; safe to fold into a view revision. */
  get changes(): number {
    return this.changeCount;
  }

  /** Slots currently occupied by a live, closing, reserved, or unproven runtime. */
  get usedCapacity(): number {
    return this.runtimes.size + this.reservations + this.unprovenExits.size;
  }

  get(taskId: string): ManagedSdkRuntime | undefined {
    return this.runtimes.get(taskId);
  }

  state(taskId: string): SdkRuntimeState | "absent" {
    return this.runtimes.get(taskId)?.state ?? "absent";
  }

  /** Whether this task's last teardown left a process whose exit was not proven. */
  unprovenExit(taskId: string): { reason: string; error: string } | undefined {
    return this.unprovenExits.get(taskId);
  }

  snapshot(): SdkRuntimeSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => ({
      taskId: runtime.taskId,
      sessionId: runtime.sessionId,
      generation: runtime.generation,
      state: runtime.state,
      startedAt: runtime.startedAt,
      lastActivityAt: nowIso(runtime.lastActivityAt),
      ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
      ...(runtime.serverInfo === undefined ? {} : { serverInfo: runtime.serverInfo }),
      subscribePumpActive: this.pumps.has(runtime.taskId),
      pumpProcessed: runtime.pumpProcessed,
      pumpIdle: runtime.pumpIdle,
      drainTimedOut: runtime.drainTimedOut === true,
    }));
  }

  /** Record that a task did something observable; postpones idle reclamation. */
  noteActivity(taskId: string): void {
    const runtime = this.runtimes.get(taskId);
    if (runtime !== undefined) runtime.lastActivityAt = this.now();
  }

  /**
   * Return one live, initialized runtime for the task, creating it when absent.
   *
   * Creation order is deliberate and load-bearing:
   * `start → onRequest → subscribe → startPump → initialize → (resume) → drain`.
   *
   * The subscription exists before the handshake, because `session/resume` can
   * emit notifications before its RPC result returns; subscribing afterwards
   * would drop exactly the events that prove the restored session progressed.
   * The pump starts before the handshake for the same reason, and `acquire`
   * only returns once the already-received notifications are persisted, so a
   * caller's first follow-up can never overtake them.
   *
   * Concurrent callers for one task join the same attempt, and capacity is
   * reserved synchronously before any await, so neither a second task nor a
   * second caller can exceed `maxRuntimes`.
   */
  async acquire(input: AcquireSdkRuntimeInput): Promise<ManagedSdkRuntime> {
    if (this.closed) {
      throw new SdkBackendError("runtime_unavailable", "the SDK runtime manager has already shut down", {
        retryable: false,
        suggestion: "Restart the bridge process to use the SDK backend again.",
        taskId: input.taskId,
      });
    }
    const unproven = this.unprovenExits.get(input.taskId);
    if (unproven !== undefined) {
      throw new SdkBackendError(
        "runtime_unavailable",
        "this task's previous SDK runtime did not confirm its exit, so a replacement runtime is not started",
        {
          retryable: false,
          suggestion:
            "Verify no orphan dsh process remains for this task, then restart the bridge; the bridge never spawns beside a process whose exit is unproved.",
          taskId: input.taskId,
          rootSessionId: input.sessionId,
          reason: unproven.error,
        },
      );
    }
    const inFlight = this.acquiring.get(input.taskId);
    if (inFlight !== undefined) {
      const joined = await inFlight;
      if (joined.sessionId !== input.sessionId) {
        throw new SdkBackendError(
          "runtime_identity_mismatch",
          "the live runtime of this task is bound to a different root session",
          {
            retryable: false,
            suggestion: "Inspect the task mapping and runtime registry; do not reuse a task id for another session.",
            taskId: input.taskId,
            rootSessionId: input.sessionId,
            runtimeSessionId: joined.sessionId,
          },
        );
      }
      return joined;
    }

    const attempt = this.createRuntime(input);
    this.acquiring.set(input.taskId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.acquiring.get(input.taskId) === attempt) this.acquiring.delete(input.taskId);
    }
  }

  private async createRuntime(input: AcquireSdkRuntimeInput): Promise<ManagedSdkRuntime> {
    const existing = this.runtimes.get(input.taskId);
    if (existing !== undefined && existing.state === "ready") {
      if (existing.sessionId !== input.sessionId) {
        throw new SdkBackendError(
          "runtime_identity_mismatch",
          "the live runtime of this task is bound to a different root session",
          {
            retryable: false,
            suggestion: "Inspect the task mapping and runtime registry; do not reuse a task id for another session.",
            taskId: input.taskId,
            rootSessionId: input.sessionId,
            runtimeSessionId: existing.sessionId,
          },
        );
      }
      existing.lastActivityAt = this.now();
      return existing;
    }
    if (existing !== undefined) await this.dispose(input.taskId, "replaced");

    await this.reserveOrReclaim(input.taskId);
    try {
      const generation = (this.generations.get(input.taskId) ?? 0) + 1;
      this.generations.set(input.taskId, generation);
      const factory = this.clientFactory ?? (await loadOfficialClient());
      const runtimeRef: { current?: ManagedSdkRuntime } = {};
      const client = factory({
        ...(this.sdk.bin === undefined ? {} : { dshBin: this.sdk.bin }),
        profile: this.sdk.profile,
        dshHome: this.sdk.dshHome,
        processCwd: input.cwd,
        initializeTimeoutMs: this.sdk.initializeTimeoutMs,
        shutdownTimeoutMs: this.sdk.shutdownTimeoutMs,
        onUserQuestion: (request, context) => {
          const runtime = runtimeRef.current;
          if (runtime === undefined) {
            throw new Error("the SDK runtime is not registered yet");
          }
          return input.onUserQuestion(runtime, request, context);
        },
      });
      const runtime: ManagedSdkRuntime = {
        taskId: input.taskId,
        sessionId: input.sessionId,
        generation,
        client,
        startedAt: nowIso(this.now()),
        state: "starting",
        lastActivityAt: this.now(),
        pumpIdle: false,
        pumpProcessed: 0,
        exitReported: false,
      };
      runtimeRef.current = runtime;
      this.runtimes.set(input.taskId, runtime);
      this.changeCount += 1;

      try {
        client.start();
        client.onRequest?.((method, params) => input.onRequest(runtime, method, params));
        // Subscribe and pump before the handshake: notifications emitted during
        // `initialize` or `session/resume` are collected in wire order instead
        // of being lost between the RPC result and a later subscribe.
        const subscription = client.subscribe();
        runtime.subscription = subscription;
        this.startPump(runtime, input.onNotification);
        const initialized = await client.initialize({
          cwd: input.cwd,
          provider: input.route.provider,
          model: input.route.model,
          ...(input.route.reasoningEffort === undefined ? {} : { reasoningEffort: input.route.reasoningEffort }),
          approvalRequests: true,
          capabilities: { userQuestions: true },
        });
        runtime.serverInfo = { name: initialized.serverInfo.name, version: initialized.serverInfo.version };
        if (input.resume) await client.resumeSession(input.sessionId);
        // Barrier: everything the runtime sent before the handshake returned is
        // persisted before this task's first prompt is allowed to exist.
        const drained = await this.waitPumpDrained(runtime, this.acquisitionDrainTimeoutMs);
        if (!drained) {
          runtime.drainTimedOut = true;
          this.logger(
            `[dsh-agentlink] sdk handshake drain timed out task=${input.taskId}; observation coverage is partial`,
          );
        }
        runtime.state = "ready";
        this.changeCount += 1;
        this.logger(
          `[dsh-agentlink] sdk runtime ready task=${input.taskId} generation=${generation} server=${initialized.serverInfo.name}@${initialized.serverInfo.version} drained=${drained}`,
        );
        return runtime;
      } catch (error) {
        // Fail closed: no subscription, no process, no fake-ready runtime.
        runtime.subscription?.close();
        const closeFailure = await this.closeQuietly(client);
        this.runtimes.delete(input.taskId);
        this.changeCount += 1;
        if (closeFailure !== undefined) {
          this.unprovenExits.set(input.taskId, {
            reason: input.resume ? "resume-failure-teardown" : "initialize-failure-teardown",
            error: closeFailure,
          });
        }
        if (error instanceof SdkBackendError) throw error;
        throw new SdkBackendError(
          input.resume ? "session_resume_failed" : "sdk_initialize_failed",
          input.resume
            ? `the SDK runtime could not restore session ${input.sessionId}; no prompt was sent`
            : "the SDK runtime could not complete its initialize handshake; no prompt was sent",
          {
            retryable: closeFailure === undefined,
            suggestion: input.resume
              ? "Check that the session id, DSH home, profile, and model route still match the original runtime, then retry."
              : "Check DSH_SDK_BIN, DSH_HOME, DSH_SDK_PROFILE, and the provider/model route; run the doctor live probe for a bounded handshake.",
            taskId: input.taskId,
            rootSessionId: input.sessionId,
            reason: errorMessage(error),
            ...(closeFailure === undefined ? {} : { closeError: closeFailure }),
          },
          { cause: error },
        );
      }
    } finally {
      this.reservations = Math.max(0, this.reservations - 1);
    }
  }

  /** Send one bounded `session/wait` for a managed runtime. */
  async waitForTask(input: { taskId: string; sessionId: string; timeoutMs: number }): Promise<void> {
    const runtime = this.runtimes.get(input.taskId);
    if (runtime === undefined || runtime.state !== "ready") {
      throw new SdkBackendError("runtime_unavailable", "the task has no live SDK runtime to wait on", {
        retryable: true,
        suggestion: "Resume the task with dsh_followup (an idle runtime is reclaimed by policy).",
        taskId: input.taskId,
        rootSessionId: input.sessionId,
      });
    }
    await runtime.client.request("session/wait", { sessionId: input.sessionId }, input.timeoutMs);
    runtime.lastActivityAt = this.now();
  }

  /** Close one runtime; used by idle reclamation, task close, and shutdown. */
  async release(taskId: string, reason: string): Promise<void> {
    await this.dispose(taskId, reason);
  }

  /** Close every runtime this bridge owns; bounded by `shutdownTimeoutMs` per runtime. */
  async closeAll(reason = "bridge-shutdown"): Promise<CloseOutcome[]> {
    this.closed = true;
    this.stopReaper();
    const taskIds = [...this.runtimes.keys()];
    await Promise.all(taskIds.map(async (taskId) => this.dispose(taskId, reason)));
    // Report per task: only a runtime whose exit was confirmed may be recorded as
    // a clean shutdown. An unconfirmed close or an unprocessed drain is not clean.
    return taskIds.map((taskId) => {
      const unproven = this.unprovenExits.get(taskId);
      if (unproven !== undefined) {
        return { taskId, confirmed: false, reason: `unconfirmed-exit: ${unproven.error}` };
      }
      const unclean = this.uncleanExits.get(taskId);
      if (unclean !== undefined) return { taskId, confirmed: false, reason: unclean };
      return { taskId, confirmed: true };
    });
  }

  startReaper(): void {
    if (this.reaper !== undefined || this.sdk.idleTimeoutMs <= 0) return;
    const interval = Math.min(Math.max(Math.floor(this.sdk.idleTimeoutMs / 4), MIN_REAPER_INTERVAL_MS), MAX_REAPER_INTERVAL_MS);
    this.reaper = setInterval(() => {
      void this.reclaimIdle("idle-timeout");
    }, interval);
    this.reaper.unref?.();
  }

  stopReaper(): void {
    if (this.reaper === undefined) return;
    clearInterval(this.reaper);
    this.reaper = undefined;
  }

  /**
   * Close runtimes that are idle and have no pending interaction.
   *
   * `reason` distinguishes the timer from capacity pressure in diagnostics.
   * Active work, running turns, and unanswered questions are never reclaimed.
   */
  async reclaimIdle(reason: "idle-timeout" | "capacity"): Promise<string[]> {
    if (this.reaperRunning) return [];
    this.reaperRunning = true;
    const reclaimed: string[] = [];
    try {
      const threshold = this.sdk.idleTimeoutMs;
      for (const runtime of [...this.runtimes.values()]) {
        if (runtime.state !== "ready") continue;
        if (this.isBusy(runtime.taskId) || this.hasPendingInteractions(runtime.taskId)) continue;
        if (reason === "idle-timeout") {
          if (threshold === 0) continue;
          if (this.now() - runtime.lastActivityAt < threshold) continue;
        }
        await this.dispose(runtime.taskId, reason);
        reclaimed.push(runtime.taskId);
        if (reason === "capacity" && this.usedCapacity < this.capacity) break;
      }
      return reclaimed;
    } finally {
      this.reaperRunning = false;
    }
  }

  /**
   * Reserve one capacity slot, or reclaim an idle runtime first.
   *
   * The check and the increment happen in the same synchronous tick, so two
   * concurrent acquisitions cannot both take the last slot; reclamation only
   * ever targets runtimes that are idle and have no unanswered interaction, so
   * active work is never killed for capacity.
   */
  private async reserveOrReclaim(taskId: string): Promise<void> {
    // Synchronous fast path: check and reserve in one tick.
    if (this.usedCapacity < this.capacity) {
      this.reservations += 1;
      return;
    }
    await this.reclaimIdle("capacity");
    if (this.usedCapacity < this.capacity) {
      this.reservations += 1;
      return;
    }
    throw new SdkBackendError(
      "runtime_capacity_exceeded",
      `all ${this.capacity} SDK runtime slots are held by active tasks; no runtime was started for this task`,
      {
        retryable: true,
        suggestion:
          "Finish or close one active task, or raise DSH_SDK_MAX_RUNTIMES; the bridge never waits unboundedly and never kills active work.",
        taskId,
        capacity: this.capacity,
        used: this.usedCapacity,
        activeTasks: [...this.runtimes.keys()],
      },
    );
  }

  /**
   * Notification pump: one consumer per runtime, strictly in wire order.
   *
   * `pumpIdle` is set while the queue is empty, which is the signal the
   * handshake barrier and the shutdown drain both wait on. A transport failure
   * marks the runtime crashed instead of leaving it looking ready.
   */
  private startPump(
    runtime: ManagedSdkRuntime,
    onNotification: AcquireSdkRuntimeInput["onNotification"],
  ): void {
    const subscription = runtime.subscription;
    if (subscription === undefined) return;
    const pump = (async () => {
      for (;;) {
        let notification: SdkRuntimeNotification;
        const queued = subscription.tryNext();
        if (queued === undefined) {
          runtime.pumpIdle = true;
          try {
            notification = await subscription.next();
          } catch (error) {
            // The transport ended while the queue was empty. When this bridge
            // is the one closing the runtime, that is the expected end of the
            // stream and the queue was already drained — recording a failure
            // here would make every normal shutdown look partial. When the
            // runtime died on its own, it is a real, unreported loss.
            const selfClosing = runtime.state === "closing";
            if (!selfClosing) {
              runtime.pumpIdle = false;
              runtime.pumpError = errorMessage(error);
            }
            // Transport closed: the runtime is gone. A closing runtime is
            // settled by `dispose`, which owns its exit report.
            if (runtime.state === "ready" || runtime.state === "starting") {
              runtime.state = "crashed";
              runtime.lastError = runtime.pumpError ?? errorMessage(error);
              this.changeCount += 1;
              this.logger(`[dsh-agentlink] sdk runtime lost task=${runtime.taskId}: ${runtime.lastError}`);
              await this.reportExit(runtime, {
                clean: false,
                reason: "transport-closed",
                error: runtime.lastError,
                observationDrained: false,
              });
              // A closed transport means the child's stdio ended: the channel
              // that would carry a replacement's events is gone, so the slot is
              // released and the task stays resumable. This is not the same as
              // an unproven `close()` on a live process.
              this.runtimes.delete(runtime.taskId);
              this.changeCount += 1;
              void this.closeQuietly(runtime.client);
            }
            break;
          }
        } else {
          notification = queued;
        }
        runtime.pumpIdle = false;
        runtime.lastActivityAt = this.now();
        runtime.pumpProcessed += 1;
        try {
          await onNotification(runtime, notification);
        } catch (error) {
          // A handler failure must never kill the pump for unrelated events; it
          // is reported, and the adapter owns marking the task degraded.
          runtime.pumpError = errorMessage(error);
          this.logger(
            `[dsh-agentlink] sdk notification handler failed task=${runtime.taskId} method=${notification.method}: ${runtime.pumpError}`,
          );
        }
      }
    })();
    this.pumps.set(runtime.taskId, pump);
    void pump.finally(() => {
      if (this.pumps.get(runtime.taskId) === pump) this.pumps.delete(runtime.taskId);
    });
  }

  /** Wait (bounded) until the pump has consumed everything already received. */
  private async waitPumpDrained(runtime: ManagedSdkRuntime, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + Math.max(0, timeoutMs);
    if (this.pumps.get(runtime.taskId) === undefined) return true;
    while (this.now() <= deadline) {
      if (runtime.pumpIdle) return true;
      if (runtime.state === "crashed") return false;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return false;
  }

  /**
   * Tear down one runtime: bounded process teardown, then a bounded drain of the
   * notification queue, and only then a verdict.
   *
   * Cleanliness has two independent parts, and the record only claims what both
   * prove: the child process confirmed its exit, AND the observation queue was
   * drained into the store. A `client.close()` that resolves while events are
   * still queued is not a clean observation state.
   */
  private async dispose(taskId: string, reason: string): Promise<void> {
    const inFlight = this.disposing.get(taskId);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const runtime = this.runtimes.get(taskId);
    if (runtime === undefined) return;
    const work = (async () => {
      runtime.state = "closing";
      this.changeCount += 1;
      const closeFailure = await this.closeQuietly(runtime.client);
      // The runtime has stopped emitting, but its last notifications may still
      // sit in the subscription queue or in a handler.
      const drained =
        closeFailure === undefined && runtime.pumpError === undefined
          ? await this.waitPumpDrained(runtime, this.drainTimeoutMs)
          : false;
      if (!drained && closeFailure === undefined) {
        runtime.drainTimedOut = true;
        this.uncleanExits.set(taskId, "drain-timeout");
      }
      runtime.subscription?.close();
      const pump = this.pumps.get(taskId);
      if (pump !== undefined) await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 50))]);
      runtime.state = closeFailure === undefined ? "closed" : "crashed";
      if (closeFailure !== undefined) runtime.lastError = closeFailure;
      this.runtimes.delete(taskId);
      this.changeCount += 1;
      if (closeFailure !== undefined) {
        // Keep the slot and block a replacement: the old process may still run.
        this.unprovenExits.set(taskId, { reason, error: closeFailure });
        this.logger(
          `[dsh-agentlink] sdk runtime ${taskId} did not confirm shutdown (${reason}): ${closeFailure}; slot retained`,
        );
      }
      await this.reportExit(runtime, {
        clean: closeFailure === undefined && drained,
        reason,
        ...(runtime.lastError === undefined ? {} : { error: runtime.lastError }),
        observationDrained: drained,
      });
      if (closeFailure === undefined && !drained) {
        this.logger(
          `[dsh-agentlink] sdk runtime ${taskId} closed before its observation queue drained; marking the task partial`,
        );
      }
    })();
    this.disposing.set(taskId, work);
    try {
      await work;
    } finally {
      if (this.disposing.get(taskId) === work) this.disposing.delete(taskId);
    }
  }

  /** Report a runtime exit exactly once per generation. */
  private async reportExit(
    runtime: ManagedSdkRuntime,
    info: { clean: boolean; reason: string; error?: string; observationDrained: boolean },
  ): Promise<void> {
    if (runtime.exitReported) return;
    runtime.exitReported = true;
    await this.onRuntimeExit?.(runtime.taskId, info);
  }

  private async closeQuietly(client: SdkRuntimeClient): Promise<string | undefined> {
    try {
      const bounded = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`shutdown exceeded ${this.sdk.shutdownTimeoutMs} ms`));
        }, this.sdk.shutdownTimeoutMs + 1_000);
        timer.unref?.();
        client.close().then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      await bounded;
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }
}
