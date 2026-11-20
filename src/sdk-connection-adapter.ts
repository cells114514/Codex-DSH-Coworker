/**
 * `DshConnection` implemented over the SDK backend's observation layer.
 *
 * `BridgeService` was written against a Host connection that owns mux
 * observation, lineage, pending interactions, and queue snapshots. The SDK
 * backend has no Host, no mux, and no queue, so this adapter supplies the same
 * contract from the bridge's own observation record. It never starts a runtime:
 * reads report "loaded / not loaded / unknown" instead of forcing a probe, and
 * only a write path (`sessionPrompt` through the API) spawns a process.
 */
import type { HostConnectionSnapshot, DshConnection, QueueSnapshot, TaskChangeResult, TaskLineageSession } from "./connection-manager.js";
import { PendingInteractionError } from "./connection-manager.js";
import type { DshPendingEnvelope, DshQuestionAnswer, DshSessionHistory } from "./dsh-types.js";
import type { DshApi } from "./dsh-types.js";
import type { SdkDshClient } from "./sdk-dsh-client.js";
import type { SdkRuntimeRecord } from "./runtime-registry.js";
import type { TaskRecord, TaskStore } from "./task-store.js";

const SDKS_CONNECTION_EPOCH = 1;

export interface SdkConnectionAdapterOptions {
  tasks: TaskStore;
  client: SdkDshClient;
  now?: () => number;
}

/** Narrow a `DshApi` to the SDK backend by its declared identity, not by `instanceof`. */
export function isSdkDshClient(api: DshApi): api is SdkDshClient {
  return api.backend === "sdk" && typeof (api as SdkDshClient).bridgeCatalog === "function";
}

export class SdkConnectionAdapter implements DshConnection {
  private readonly client: SdkDshClient;
  private readonly tasks: TaskStore;
  private readonly now: () => number;
  private readonly records = new Map<string, SdkRuntimeRecord | undefined>();
  private revision = 0;
  private stopped = false;

  constructor(options: SdkConnectionAdapterOptions) {
    this.client = options.client;
    this.tasks = options.tasks;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    // Nothing to connect: runtimes start lazily per task, on first prompt.
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client.close();
  }

  snapshot(): HostConnectionSnapshot {
    const runtimes = this.client.runtimeSnapshots();
    // A strictly monotonic view clock: the SDK backend's observation counter
    // plus the runtime manager's lifecycle counter. Summing generations or map
    // sizes would let a removed-and-rebuilt runtime reuse an earlier revision
    // and accept a stale write; this value cannot decrease, and it is stable
    // while nothing changes.
    const source = this.client.changes + (this.stopped ? 1 : 0);
    this.revision = Math.max(this.revision, source);
    return {
      availability: this.stopped ? "stopped" : "connected",
      baseUrl: null,
      connectionEpoch: SDKS_CONNECTION_EPOCH,
      revision: this.revision,
      ...(this.stopped ? {} : { connectedAt: new Date(this.now()).toISOString() }),
      testedAgainstDshVersion: null,
      compatibility: "capability-probed",
      backend: "sdk",
      transport: "stdio-jsonrpc",
      observationSource:
        "bridge-owned observed events plus the SDK runtime handshake; the SDK wire exposes no session catalog, history read, or queue snapshot",
      runtimes: runtimes.map((runtime) => ({
        taskId: runtime.taskId,
        sessionId: runtime.sessionId,
        state: runtime.state,
        generation: runtime.generation,
        startedAt: runtime.startedAt,
        ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
        pumpProcessed: runtime.pumpProcessed,
        observationDrained: !runtime.drainTimedOut,
      })),
      capabilities: {
        unaryRpc: false,
        eventsMuxWebSocket: false,
        muxResumeSince: false,
        historyReconciliation: false,
        queueSnapshot: false,
        queueEmptyBaselineInference: false,
        typedRespond: true,
        pendingReplayReconciliation: "stable-rpcid-baseline-idle",
        subagentHistory: true,
        timedQuestions: false,
        subagentModeDiscovery: false,
      },
    };
  }

  async trackTask(task: TaskRecord): Promise<void> {
    if (this.records.has(task.taskId)) return;
    this.records.set(task.taskId, await this.client.runtimeRecord(task.taskId));
  }

  /**
   * Refresh the persisted runtime identity of every known task.
   *
   * This is metadata only: no runtime is started, and an unloaded task stays
   * explicitly unloaded rather than being reported as idle.
   */
  async refreshLineage(): Promise<void> {
    const tasks = await this.tasks.list();
    await Promise.all(
      tasks.map(async (task) => {
        this.records.set(task.taskId, await this.client.runtimeRecord(task.taskId));
      }),
    );
  }

  async reconcileTask(taskId: string): Promise<void> {
    const task = await this.tasks.get(taskId);
    this.records.set(taskId, await this.client.runtimeRecord(taskId));
  }

  async readSessionHistory(
    taskId: string,
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<DshSessionHistory> {
    const history = await this.client.readHistory(taskId, sessionId, options);
    return history;
  }

  lineageForTask(taskId: string): TaskLineageSession[] {
    const state = this.client.taskStateSync(taskId);
    const record = this.records.get(taskId);
    const task = state === undefined ? undefined : { sessionId: state.sessionId };
    const rootSessionId = task?.sessionId ?? record?.rootSessionId;
    if (rootSessionId === undefined) return [];
    const rows: TaskLineageSession[] = [
      {
        sessionId: rootSessionId,
        found: true,
        origin: "root",
        ...(state === undefined
          ? {}
          : state.rootStatus === "running"
            ? { running: true }
            : state.rootStatus === "idle"
              ? { running: false }
              : {}),
        historyCapability: "observed-cache",
      },
    ];
    if (state !== undefined) {
      for (const row of state.lineage.values()) {
        if (row.sessionId === rootSessionId) continue;
        rows.push({
          sessionId: row.sessionId,
          found: true,
          ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
          origin: row.origin,
          ...(row.running === "unknown" ? {} : { running: row.running }),
          historyCapability: "observed-cache",
        });
      }
    }
    return rows;
  }

  pendingForTask(taskId: string): DshPendingEnvelope[] {
    return this.client.pendingForTask(taskId);
  }

  queueForSession(sessionId: string): QueueSnapshot {
    void sessionId;
    return { known: false, stale: false, connectionEpoch: SDKS_CONNECTION_EPOCH, items: [] };
  }

  async waitForTaskChange(
    taskId: string,
    afterCursor: number,
    afterRevision: number,
    waitMs: number,
  ): Promise<TaskChangeResult> {
    const waited = await this.client.waitForTaskChange(taskId, afterCursor, waitMs, afterRevision);
    return { timedOut: waited.timedOut, connection: this.snapshot(), ledger: await this.client.ledgerSnapshot(taskId) };
  }

  async answerQuestion(taskId: string, requestId: string, answers: DshQuestionAnswer[]): Promise<unknown> {
    try {
      return await this.client.answerQuestion(taskId, requestId, answers);
    } catch (error) {
      if (error instanceof PendingInteractionError) throw error;
      throw new PendingInteractionError("bad-response", error instanceof Error ? error.message : String(error));
    }
  }

  async resolveApproval(taskId: string, requestId: string, outcome: "allow_once" | "reject"): Promise<unknown> {
    try {
      return await this.client.resolveApproval(taskId, requestId, outcome);
    } catch (error) {
      if (error instanceof PendingInteractionError) throw error;
      throw new PendingInteractionError("bad-response", error instanceof Error ? error.message : String(error));
    }
  }

  /** Pending interactions grouped for status output (approval/question, task scoped). */
  groupPendingInteractions(taskId: string) {
    return this.client.groupPendingInteractions(taskId);
  }
}
