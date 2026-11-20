/**
 * Gateway completion tracking.
 *
 * A Gateway task is a session the bridge attached to (or created); the desktop can
 * also write to the same session, so a finished turn is not by itself evidence that
 * *our* submission finished. Attribution therefore needs all of:
 *
 *   1. a bridge submission on this task, with its durable request id and the
 *      session sequence observed before that submission;
 *   2. a `user/message` event above that baseline whose durable source names the
 *      same request id, which pins the consuming turn number;
 *   3. a `turn/end` for exactly that turn, verified against history so the result
 *      is readable before a notification is promised.
 *
 * Events below the baseline (attach history), duplicates, and turns that consumed
 * nothing this bridge submitted are ignored, and an unattributable turn end is
 * reported as such instead of being guessed.
 */

export interface GatewayEventLike {
  type?: unknown;
  seq?: unknown;
  data?: unknown;
}

export interface GatewayExecution {
  executionId: string;
  requestId: string;
  turn: number | null;
  state: "awaiting" | "consumed" | "settled";
  consumedSeq?: number;
  settledSeq?: number | undefined;
  /** A terminal seen for this turn whose result was not yet readable. */
  pendingTerminal?: { seq: number; turn: number } | undefined;
}

export interface GatewayTaskState {
  taskId: string;
  sessionId: string;
  baselineSeq: number;
  executions: Map<string, GatewayExecution>;
  byRequest: Map<string, string>;
  seenSeqs: Set<number>;
}

export type GatewayObservation =
  | { kind: "ignored"; reason: string }
  | { kind: "consumed"; executionId: string; turn: number; seq: number }
  | { kind: "terminal"; executionId: string; turn: number; seq: number }
  | { kind: "duplicate"; executionId: string; seq: number }
  | { kind: "unattributed"; reason: string; turn: number | null; seq: number }
  /** A pending terminal may now be confirmable; re-verify this execution. */
  | { kind: "recheck"; executionId: string; turn: number; seq: number };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function requestIdOf(data: Record<string, unknown>): string | undefined {
  // The Gateway contract puts the durable submission id in `source.rpcId`; the
  // bridge ledger derives `initiatedBy: bridge` from exactly that field.
  const candidates = [asRecord(data.source), asRecord(asRecord(data.message)?.source)];
  for (const candidate of candidates) {
    for (const key of ["rpcId", "requestId"] as const) {
      const id = candidate?.[key];
      if (typeof id === "string" && id !== "") return id;
    }
  }
  return undefined;
}

export class GatewayCompletionTracker {
  private readonly tasks = new Map<string, GatewayTaskState>();

  /** Register a task whose session the bridge is observing. */
  observeTask(taskId: string, sessionId: string, baselineSeq: number): GatewayTaskState {
    const existing = this.tasks.get(taskId);
    if (existing !== undefined && existing.sessionId === sessionId) {
      existing.baselineSeq = Math.max(existing.baselineSeq, baselineSeq);
      return existing;
    }
    const state: GatewayTaskState = {
      taskId,
      sessionId,
      baselineSeq,
      executions: new Map(),
      byRequest: new Map(),
      seenSeqs: new Set(),
    };
    this.tasks.set(taskId, state);
    return state;
  }

  state(taskId: string): GatewayTaskState | undefined {
    return this.tasks.get(taskId);
  }

  /** Record one bridge submission. Repeated request ids stay idempotent. */
  begin(
    taskId: string,
    execution: { sessionId: string; executionId: string; requestId: string; baselineSeq: number },
  ): GatewayExecution | undefined {
    const state = this.observeTask(taskId, execution.sessionId, execution.baselineSeq);
    const known = state.byRequest.get(execution.requestId);
    if (known !== undefined) return state.executions.get(known);
    const record: GatewayExecution = {
      executionId: execution.executionId,
      requestId: execution.requestId,
      turn: null,
      state: "awaiting",
    };
    state.executions.set(execution.executionId, record);
    state.byRequest.set(execution.requestId, execution.executionId);
    return record;
  }

  /**
   * Reopen an execution whose terminal could not be verified. The next valid
   * terminal event re-runs the check instead of leaving a silent gap.
   */
  reopen(taskId: string, executionId: string): void {
    const state = this.tasks.get(taskId);
    const record = state?.executions.get(executionId);
    if (record === undefined || record.state !== "settled") return;
    record.state = "consumed";
    record.settledSeq = undefined;
    // Keep pendingTerminal: the terminal is still the evidence being confirmed.
  }

  /** Executions waiting on a readable result, for bounded in-bridge re-checks. */
  pendingTerminals(taskId: string): string[] {
    const state = this.tasks.get(taskId);
    if (state === undefined) return [];
    return [...state.executions.values()]
      .filter((entry) => entry.pendingTerminal !== undefined)
      .map((entry) => entry.executionId);
  }

  /** Clear the terminal evidence once a record has been written for it. */
  confirm(taskId: string, executionId: string): void {
    const record = this.tasks.get(taskId)?.executions.get(executionId);
    if (record !== undefined) record.pendingTerminal = undefined;
  }

  /** Abandon an execution whose submission never reached the Host. */
  cancel(taskId: string, executionId: string): void {
    const state = this.tasks.get(taskId);
    if (state === undefined) return;
    const record = state.executions.get(executionId);
    if (record === undefined || record.state === "settled") return;
    state.executions.delete(executionId);
    state.byRequest.delete(record.requestId);
  }

  /**
   * Feed one durable session event. `turn/start` and queue frames are irrelevant to
   * attribution and are reported as ignored instead of being interpreted.
   */
  observe(taskId: string, event: GatewayEventLike): GatewayObservation {
    const state = this.tasks.get(taskId);
    if (state === undefined) return { kind: "ignored", reason: "task-not-observed" };
    const type = typeof event.type === "string" ? event.type : "";
    const seq = typeof event.seq === "number" ? event.seq : undefined;
    const data = asRecord(event.data) ?? {};

    if (type === "turn/end") {
      const turn = typeof data.turn === "number" ? data.turn : null;
      if (seq === undefined) return { kind: "unattributed", reason: "terminal-without-seq", turn, seq: -1 };
      if (seq <= state.baselineSeq) return { kind: "ignored", reason: "below-baseline" };
      if (state.seenSeqs.has(seq)) {
        const settled = [...state.executions.values()].find((entry) => entry.settledSeq === seq);
        return settled === undefined
          ? { kind: "ignored", reason: "duplicate-seq" }
          : { kind: "duplicate", executionId: settled.executionId, seq };
      }
      state.seenSeqs.add(seq);
      const owned = [...state.executions.values()].find(
        (entry) => entry.state === "consumed" && entry.turn !== null && entry.turn === turn,
      );
      if (owned === undefined) {
        return {
          kind: "unattributed",
          reason: turn === null ? "turn-unknown" : "turn-not-submitted-by-bridge",
          turn,
          seq,
        };
      }
      owned.state = "settled";
      owned.settledSeq = seq;
      owned.pendingTerminal = { seq, turn: owned.turn as number };
      return { kind: "terminal", executionId: owned.executionId, turn: owned.turn as number, seq };
    }

    if (type === "turn/start") {
      // A queued message has no turn of its own in this contract: the turn that
      // starts after it is the one that consumes it.
      const waiting = [...state.executions.values()].find(
        (entry) => entry.state === "consumed" && entry.turn === null && seq !== undefined && entry.consumedSeq !== undefined && seq > entry.consumedSeq,
      );
      if (waiting === undefined) return { kind: "ignored", reason: "no-consumed-execution" };
      const turn = typeof data.turn === "number" ? data.turn : null;
      if (turn === null) return { kind: "ignored", reason: "turn-start-without-turn" };
      waiting.turn = turn;
      return { kind: "recheck", executionId: waiting.executionId, turn, seq: seq as number };
    }

    if (type === "assistant/message") {
      // A reply may become readable after the terminal that announced it: keep the
      // terminal evidence and let this event re-trigger verification.
      const pending = [...state.executions.values()].find((entry) => entry.pendingTerminal !== undefined);
      if (pending === undefined || pending.pendingTerminal === undefined) {
        return { kind: "ignored", reason: "no-pending-terminal" };
      }
      return {
        kind: "recheck",
        executionId: pending.executionId,
        turn: pending.pendingTerminal.turn,
        seq: typeof event.seq === "number" ? event.seq : pending.pendingTerminal.seq,
      };
    }

    if (type !== "user/message") return { kind: "ignored", reason: `event-${type || "unknown"}` };
    if (seq === undefined) return { kind: "ignored", reason: "message-without-seq" };
    if (seq <= state.baselineSeq) return { kind: "ignored", reason: "below-baseline" };
    if (state.seenSeqs.has(seq)) return { kind: "ignored", reason: "duplicate-seq" };
    state.seenSeqs.add(seq);

    const requestId = requestIdOf(data);
    if (requestId === undefined) return { kind: "ignored", reason: "no-durable-request-id" };
    const executionId = state.byRequest.get(requestId);
    if (executionId === undefined) return { kind: "ignored", reason: "request-not-from-bridge" };
    const record = state.executions.get(executionId);
    if (record === undefined || record.state === "settled") return { kind: "ignored", reason: "execution-settled" };
    const turn = typeof data.turn === "number" ? data.turn : null;
    record.turn = turn;
    record.state = "consumed";
    record.consumedSeq = seq;
    return { kind: "consumed", executionId, turn: turn ?? -1, seq };
  }
}
