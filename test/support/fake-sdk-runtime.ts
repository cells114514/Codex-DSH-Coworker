import type {
  SdkInitializeParams,
  SdkInitializeResult,
  SdkRuntimeClient,
  SdkRuntimeClientOptions,
  SdkRuntimeNotification,
  SdkRuntimeSubscription,
} from "../../src/sdk-runtime-manager.js";

type Listener = (notification: SdkRuntimeNotification) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One scripted subscription queue. */
class FakeSubscription implements SdkRuntimeSubscription {
  private readonly queue: SdkRuntimeNotification[] = [];
  private readonly waiters: Array<{
    resolve: (value: SdkRuntimeNotification) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: Error | undefined;

  next(): Promise<SdkRuntimeNotification> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("subscription closed"));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  tryNext(): SdkRuntimeNotification | undefined {
    return this.queue.shift();
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("subscription closed"));
  }

  push(notification: SdkRuntimeNotification): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(notification);
      return;
    }
    this.queue.push(notification);
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface FakeSdkRuntimeScript {
  initializeError?: Error;
  promptError?: Error;
  resumeError?: Error;
  closeError?: Error;
  /** Delay before a close resolves, so tests can observe the in-flight shutdown. */
  closeDelayMs?: number;
  workingDirectory?: string;
  /** Called after a prompt is accepted, so tests can emit the notification stream. */
  onPrompt?: (runtime: FakeSdkRuntime, sessionId: string, text: string) => void;
  /** Called at the start of `request('session/wait')`. */
  onWait?: (runtime: FakeSdkRuntime, sessionId: string) => void;
  /** Hold `session/wait` until `releaseWait()` so tests can model a late answer. */
  holdWait?: boolean;
  /** Simulate a client that cannot report its runtime process identity. */
  omitIdentity?: boolean;
  /** Called inside `initialize` before it resolves, to emit handshake-phase notifications. */
  onInitialize?: (runtime: FakeSdkRuntime, params: SdkInitializeParams) => void;
  /** Called inside `resumeSession` before it resolves, to emit restore-phase notifications. */
  onResume?: (runtime: FakeSdkRuntime, sessionId: string) => void;
  /** Called at the start of `close`, before the subscription is failed. */
  onClose?: (runtime: FakeSdkRuntime) => void;
}

/**
 * A scripted stand-in for `@deepseek-ai/dsh-sdk-client`'s `HarnessClient`.
 *
 * It records the exact call order the adapter depends on (start → onRequest →
 * initialize → resume → prompt) so tests can prove handler installation happens
 * before the first prompt, and it never spawns a process or touches a network.
 */
export class FakeSdkRuntime implements SdkRuntimeClient {
  static readonly instances: FakeSdkRuntime[] = [];

  readonly calls: string[] = [];
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  readonly initializes: SdkInitializeParams[] = [];
  readonly resumed: string[] = [];
  readonly requests: Array<{ method: string; params: object | undefined }> = [];
  readonly options: SdkRuntimeClientOptions;
  script: FakeSdkRuntimeScript;

  closed = false;
  private started = false;
  private requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;
  private readonly subscriptions = new Set<FakeSubscription>();

  constructor(options: SdkRuntimeClientOptions, script: FakeSdkRuntimeScript = {}) {
    this.options = options;
    this.script = script;
    FakeSdkRuntime.instances.push(this);
  }

  start(): void {
    this.calls.push("start");
    this.started = true;
  }

  onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void {
    if (!this.started) throw new Error("onRequest before start");
    this.calls.push("onRequest");
    this.requestHandler = handler;
  }

  async initialize(params: SdkInitializeParams): Promise<SdkInitializeResult> {
    this.calls.push("initialize");
    this.initializes.push(params);
    if (this.script.initializeError !== undefined) throw this.script.initializeError;
    this.script.onInitialize?.(this, params);
    return { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } };
  }

  async prompt(sessionId: string, contentBlocks: Array<{ type: "text"; text: string }>): Promise<string> {
    this.calls.push("prompt");
    const text = contentBlocks.map((block) => block.text).join("");
    this.prompts.push({ sessionId, text });
    // A lost receipt can still leave committed events behind: emit first, then
    // fail, so tests can prove the bridge keeps accepted work.
    this.script.onPrompt?.(this, sessionId, text);
    if (this.script.promptError !== undefined) throw this.script.promptError;
    return `message-${this.prompts.length}`;
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.calls.push("resumeSession");
    this.resumed.push(sessionId);
    if (this.script.resumeError !== undefined) throw this.script.resumeError;
    // A restore can commit events before its RPC result returns; the bridge must
    // already be subscribed to see them.
    this.script.onResume?.(this, sessionId);
  }

  async getWorkingDirectory(sessionId: string): Promise<string> {
    this.calls.push(`getWorkingDirectory:${sessionId}`);
    return this.script.workingDirectory ?? this.options.processCwd ?? process.cwd();
  }

  subscribe(): SdkRuntimeSubscription {
    this.calls.push("subscribe");
    const subscription = new FakeSubscription();
    this.subscriptions.add(subscription);
    return subscription;
  }

  async request(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    this.calls.push(`request:${method}`);
    this.requests.push({ method, params });
    void timeoutMs;
    if (method === "session/wait") {
      this.script.onWait?.(this, String((params as { sessionId?: string } | undefined)?.sessionId));
      if (this.script.holdWait === true) {
        await new Promise<void>((release) => this.waitGates.push(release));
      }
    }
    return {};
  }

  private readonly waitGates: Array<() => void> = [];

  /** Release every held `session/wait` so a pending settlement can finish. */
  /** Stand-in runtime identity so tests can exercise identity persistence. */
  runtimeIdentity(): { pid: number; startedAt: string } | undefined {
    return this.script.omitIdentity === true ? undefined : { pid: 4321, startedAt: "2026-11-19T00:00:00.000Z" };
  }

  releaseWait(): void {
    for (const release of this.waitGates.splice(0)) release();
  }

  async close(): Promise<void> {
    this.calls.push("close");
    if (this.script.closeDelayMs !== undefined) {
      await new Promise((done) => setTimeout(done, this.script.closeDelayMs));
    }
    this.script.onClose?.(this);
    if (this.script.closeError !== undefined) throw this.script.closeError;
    this.closed = true;
    for (const subscription of this.subscriptions) subscription.fail(new Error("runtime closed"));
  }

  /** Emit one server notification to every live subscription. */
  emit(notification: SdkRuntimeNotification): void {
    for (const subscription of this.subscriptions) subscription.push(notification);
  }

  // ----- helpers used by the tests -----------------------------------------

  emitEvent(sessionId: string, event: { type: string; seq: number; data?: unknown; time?: number }): void {
    this.emit({
      method: "session.event",
      params: { sessionId, event: { time: 1_700_000_000_000, ...event } },
    });
  }

  emitStatus(sessionId: string, status: "idle" | "running"): void {
    this.emit({ method: "session.status", params: { sessionId, status } });
  }

  emitSubagentStarted(parentSessionId: string, childSessionId: string): void {
    this.emit({ method: "subagent.started", params: { parentSessionId, childSessionId } });
  }

  emitSubagentFinished(parentSessionId: string, childSessionId: string, status: "ok" | "error" = "ok"): void {
    this.emit({
      method: "subagent.finished",
      params: { parentSessionId, childSessionId, status, provider: "local", agentId: childSessionId, stopReason: { kind: "completed" } },
    });
  }

  /** Drive one approval/request server request through the installed handler. */
  requestApproval(params: Record<string, unknown>): Promise<unknown> {
    if (this.requestHandler === undefined) throw new Error("no request handler installed");
    return this.requestHandler("approval/request", params);
  }

  /** Drive one native user question through the configured callback. */
  requestUserQuestion(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const handler = this.options.onUserQuestion;
    if (handler === undefined) throw new Error("no user-question handler installed");
    return handler(params, { signal: signal ?? new AbortController().signal });
  }
}

/** Factory for the runtime manager; each call mints one scripted runtime. */
export function fakeRuntimeFactory(script: FakeSdkRuntimeScript = {}) {
  const created: FakeSdkRuntime[] = [];
  const factory = (options: SdkRuntimeClientOptions): SdkRuntimeClient => {
    const runtime = new FakeSdkRuntime(options, script);
    created.push(runtime);
    return runtime;
  };
  return { factory, created };
}

/** A prompt script that emits one complete turn: user message, assistant reply, turn end. */
export function completeTurn(
  runtime: FakeSdkRuntime,
  sessionId: string,
  text: string,
  startSeq = 1,
): void {
  runtime.emitEvent(sessionId, { type: "turn/start", seq: startSeq, data: { turn: 1 } });
  runtime.emitEvent(sessionId, {
    type: "user/message",
    seq: startSeq + 1,
    data: { content: [{ type: "text", text }], role: "user" },
  });
  runtime.emitEvent(sessionId, {
    type: "assistant/message",
    seq: startSeq + 2,
    data: { message: { content: [{ type: "text", text: `answer to ${text}` }] } },
  });
  runtime.emitEvent(sessionId, { type: "turn/end", seq: startSeq + 3, data: { turn: 1, reason: { kind: "completed" } } });
  runtime.emitStatus(sessionId, "idle");
}

/** Wait until a predicate holds, bounded; used instead of fixed sleeps. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
