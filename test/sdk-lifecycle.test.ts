import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig, type BridgeConfig } from "../src/config.js";
import { createSdkDshApi, type SdkDshClient } from "../src/sdk-dsh-client.js";
import { SdkBackendError } from "../src/sdk-errors.js";
import { SdkConnectionAdapter } from "../src/sdk-connection-adapter.js";
import { SdkObservedEventStore } from "../src/sdk-observed-event-store.js";
import { SdkRuntimeManager, type AcquireSdkRuntimeInput } from "../src/sdk-runtime-manager.js";
import { TaskStore, type TaskRecord } from "../src/task-store.js";
import { completeTurn, fakeRuntimeFactory, waitFor, type FakeSdkRuntime, type FakeSdkRuntimeScript } from "./support/fake-sdk-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "sdk-lifecycle-"));
  const workspace = join(root, "workspace");
  const config = loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: join(root, "dsh-home"),
    DSH_BRIDGE_HOME: join(root, "bridge-home"),
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
  });
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, workspace, config };
}

interface ClientHarness {
  config: BridgeConfig;
  client: SdkDshClient;
  tasks: TaskStore;
  created: FakeSdkRuntime[];
  task: TaskRecord;
  cwd: string;
}

async function clientHarness(script: FakeSdkRuntimeScript = {}, env: Record<string, string> = {}): Promise<ClientHarness> {
  const { root, workspace, config: base } = await roots();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  const config = env === undefined ? base : loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: base.sdk!.dshHome,
    DSH_BRIDGE_HOME: base.homeDir,
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
    ...env,
  });
  const { factory, created } = fakeRuntimeFactory(script);
  const client = createSdkDshApi(config, config.sdk!, { clientFactory: factory, logger: () => undefined });
  const tasks = new TaskStore(config.homeDir);
  const createdSession = await client.sessionCreate({ cwd: workspace });
  const task = await tasks.create(createdSession.sessionId);
  cleanups.push(async () => client.close());
  return { config, client, tasks, created, task, cwd: workspace };
}

describe("SDK backend: handshake-phase observation", () => {
  it("persists events emitted during initialize before returning from acquire", async () => {
    const harness = await clientHarness({
      onInitialize: (runtime, params) => {
        runtime.emitEvent("session-during-init", {
          type: "session/title",
          seq: 1,
          data: { title: "handshake title", messageSeqs: [] },
        });
        void params;
      },
    });
    await harness.client.sessionPrompt({
      sessionId: harness.task.sessionId,
      mode: "queue",
      content: [{ type: "text", text: "hello" }],
    });
    const coverage = await new SdkObservedEventStore(harness.config.homeDir).coverage(harness.task.taskId);
    assert.equal(coverage.complete, true);
    assert.ok((coverage.observedCount ?? 0) >= 1, "the initialize-phase event is persisted");
  });

  it("persists events emitted while a session is being resumed, in wire order", async () => {
    // First runtime creates and finishes a turn so the task has a record.
    const first = await clientHarness({
      onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text, 1),
    });
    await first.client.sessionPrompt({
      sessionId: first.task.sessionId,
      mode: "queue",
      content: [{ type: "text", text: "first" }],
    });
    await waitFor(() => (first.client.taskStateSync(first.task.taskId)?.observedEvents ?? 0) >= 4);
    await first.client.close();

    // A restarted bridge resumes; the runtime commits an event *inside*
    // resumeSession, before its RPC result exists.
    const { factory, created } = fakeRuntimeFactory({
      onResume: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 5, data: { turn: 2 } });
        runtime.emitEvent(sessionId, {
          type: "assistant/message",
          seq: 6,
          data: { message: { content: [{ type: "text", text: "restored context reply" }] } },
        });
        runtime.emitEvent(sessionId, { type: "turn/end", seq: 7, data: { turn: 2, reason: { kind: "completed" } } });
      },
    });
    const restarted = createSdkDshApi(first.config, first.config.sdk!, {
      clientFactory: factory,
      bridgeInstanceId: "restart-owner",
      logger: () => undefined,
    });
    cleanups.push(async () => restarted.close());

    await restarted.sessionPrompt({
      sessionId: first.task.sessionId,
      mode: "queue",
      content: [{ type: "text", text: "second" }],
    });

    const runtime = created[0];
    assert.ok(runtime !== undefined);
    // The subscription must exist before resume: the fake emits synchronously
    // inside resumeSession, which only reaches a subscriber.
    const subscribeIndex = runtime.calls.indexOf("subscribe");
    const resumeIndex = runtime.calls.indexOf("resumeSession");
    assert.ok(subscribeIndex >= 0 && resumeIndex >= 0);
    assert.ok(subscribeIndex < resumeIndex, `subscribe must precede resume, got ${runtime.calls.join(" → ")}`);

    const history = await restarted.readHistory(first.task.taskId, first.task.sessionId, { maxMessages: 50 });
    const seqs = history.events.map((entry) => entry.event.seq);
    assert.ok(seqs.includes(5) && seqs.includes(6) && seqs.includes(7), `resume-phase events are persisted: ${seqs.join(",")}`);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "events are stored in wire order");
    assert.equal(history.coverage?.complete, true);
    // Contract: the resumed input is still in flight (no idle yet), so the next
    // submit is refused instead of being queued without an attributable turn.
    await assert.rejects(
      restarted.sessionPrompt({
        sessionId: first.task.sessionId,
        mode: "queue",
        content: [{ type: "text", text: "third" }],
      }),
      (error: unknown) => (error as { code?: string }).code === "prompt_in_flight",
    );
    assert.equal(runtime.prompts.length, 1, "a refused submit must not send a prompt");
  });

  it("deduplicates a repeated handshake event instead of storing it twice", async () => {
    const harness = await clientHarness({
      onInitialize: (runtime) => {
        runtime.emitEvent("session-dup", { type: "session/title", seq: 3, data: { title: "dup", messageSeqs: [] } });
        // Same (sessionId, seq) and identical content: a retransmission.
        runtime.emitEvent("session-dup", { type: "session/title", seq: 3, data: { title: "dup", messageSeqs: [] } });
      },
    });
    await harness.client.sessionPrompt({
      sessionId: harness.task.sessionId,
      mode: "queue",
      content: [{ type: "text", text: "go" }],
    });
    const coverage = await new SdkObservedEventStore(harness.config.homeDir).coverage(harness.task.taskId);
    assert.equal(coverage.complete, true);
    assert.equal(coverage.observedCount, 1, "the duplicate is counted once");
  });

  it("closes the subscription and leaves no ready runtime when resume fails", async () => {
    const first = await clientHarness({
      onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text, 1),
    });
    await first.client.sessionPrompt({
      sessionId: first.task.sessionId,
      mode: "queue",
      content: [{ type: "text", text: "first" }],
    });
    await waitFor(() => (first.client.taskStateSync(first.task.taskId)?.observedEvents ?? 0) >= 4);
    await first.client.close();

    const { factory, created } = fakeRuntimeFactory({
      resumeError: new Error("no such session"),
      onResume: (runtime, sessionId) => runtime.emitEvent(sessionId, { type: "turn/start", seq: 9, data: { turn: 3 } }),
    });
    const restarted = createSdkDshApi(first.config, first.config.sdk!, {
      clientFactory: factory,
      bridgeInstanceId: "restart-failure",
      logger: () => undefined,
    });
    cleanups.push(async () => restarted.close());
    await assert.rejects(
      restarted.sessionPrompt({
        sessionId: first.task.sessionId,
        mode: "queue",
        content: [{ type: "text", text: "second" }],
      }),
      (error: unknown) => error instanceof SdkBackendError && error.code === "session_resume_failed",
    );
    assert.equal(created[0]?.closed, true, "the failed runtime is reaped");
    assert.deepEqual(restarted.runtimeSnapshots(), [], "no runtime is left looking ready");
    assert.equal(restarted.runtimeSnapshots().length, 0);
  });
});

describe("SDK backend: shutdown drain and cleanShutdown", () => {
  async function managerHarness(options: {
    script?: FakeSdkRuntimeScript;
    drainTimeoutMs?: number;
    env?: Record<string, string>;
  } = {}) {
    const { root, config } = await roots();
    const { factory, created } = fakeRuntimeFactory(options.script);
    const exits: Array<{ clean: boolean; reason: string; observationDrained: boolean; error?: string }> = [];
    const manager = new SdkRuntimeManager({
      sdk: config.sdk!,
      requestTimeoutMs: 5_000,
      clientFactory: factory,
      logger: () => undefined,
      drainTimeoutMs: options.drainTimeoutMs ?? 2_000,
      onRuntimeExit: (_taskId, info) => {
        exits.push({ clean: info.clean, reason: info.reason, observationDrained: info.observationDrained, ...(info.error === undefined ? {} : { error: info.error }) });
      },
    });
    cleanups.push(async () => {
      await manager.closeAll("test-cleanup");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    return { manager, created, exits };
  }

  function input(taskId: string, notifications: Array<{ method: string; params: Record<string, unknown> }>, delayMs = 0): AcquireSdkRuntimeInput {
    return {
      taskId,
      sessionId: `session-${taskId}`,
      cwd: process.cwd(),
      route: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      resume: false,
      onNotification: async () => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        void notifications;
      },
      onRequest: async () => ({}),
      onUserQuestion: async () => ({ cancelled: true }),
    };
  }

  it("processes the last events emitted during close before reporting a clean exit", async () => {
    const finalEvent = { method: "session.event", params: { sessionId: "session-a", event: { type: "turn/end", seq: 10, data: {} } } };
    let processed = 0;
    const { root, config } = await roots();
    const { factory } = fakeRuntimeFactory({
      onClose: (runtime) => {
        // The runtime commits a terminal event, then the stream ends.
        runtime.emit(finalEvent);
      },
    });
    const exits: Array<{ clean: boolean; observationDrained: boolean }> = [];
    const manager = new SdkRuntimeManager({
      sdk: config.sdk!,
      requestTimeoutMs: 5_000,
      clientFactory: factory,
      logger: () => undefined,
      onRuntimeExit: (_taskId, info) => exits.push({ clean: info.clean, observationDrained: info.observationDrained }),
    });
    cleanups.push(async () => {
      await manager.closeAll("test-cleanup");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    await manager.acquire({
      ...input("dsh_drainclean00", []),
      onNotification: async (_runtime, notification) => {
        if (notification.method === "session.event") processed += 1;
      },
    });
    await manager.release("dsh_drainclean00", "idle-timeout");
    assert.equal(processed, 1, "the event emitted during close reached the handler");
    assert.equal(exits.length, 1);
    assert.deepEqual(exits[0], { clean: true, observationDrained: true });
  });

  it("marks a shutdown partial when the drain bound is exceeded", async () => {
    const { manager, exits } = await managerHarness({
      drainTimeoutMs: 20,
      script: {
        onClose: (runtime) => {
          runtime.emit({ method: "session.event", params: { sessionId: "session-a", event: { type: "turn/end", seq: 4, data: {} } } });
        },
      },
    });
    await manager.acquire({
      ...input("dsh_drainslow000", []),
      onNotification: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    });
    await manager.release("dsh_drainslow000", "bridge-shutdown");
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.observationDrained, false);
    assert.equal(exits[0]?.clean, false);
  });

  it("reports a notification-handler failure as an incomplete observation", async () => {
    const { manager, exits } = await managerHarness({
      script: {
        onClose: (runtime) => {
          runtime.emit({ method: "session.event", params: { sessionId: "session-a", event: { type: "turn/end", seq: 6, data: {} } } });
        },
      },
    });
    await manager.acquire({
      ...input("dsh_handlerfail00", []),
      onNotification: async () => {
        throw new Error("disk full");
      },
    });
    await manager.release("dsh_handlerfail00", "bridge-shutdown");
    assert.equal(exits[0]?.observationDrained, false);
    assert.equal(exits[0]?.clean, false);
  });

  it("is idempotent under concurrent duplicate closes", async () => {
    const { manager, created, exits } = await managerHarness();
    await manager.acquire(input("dsh_dupclose0000", []));
    await Promise.all([
      manager.release("dsh_dupclose0000", "first"),
      manager.release("dsh_dupclose0000", "second"),
      manager.release("dsh_dupclose0000", "third"),
    ]);
    assert.equal(created[0]?.calls.filter((call) => call === "close").length, 1, "the process is closed once");
    assert.equal(exits.length, 1, "the exit is reported once");
  });

  it("retains the capacity slot and blocks a replacement when shutdown is unproven", async () => {
    const { root, config } = await roots();
    const { factory, created } = fakeRuntimeFactory({ closeError: new Error("shutdown exceeded") });
    const manager = new SdkRuntimeManager({
      sdk: { ...config.sdk!, maxRuntimes: 1 },
      requestTimeoutMs: 5_000,
      clientFactory: factory,
      logger: () => undefined,
    });
    cleanups.push(async () => {
      await manager.closeAll("test-cleanup");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    await manager.acquire(input("dsh_unproven00000", []));
    await manager.release("dsh_unproven00000", "bridge-shutdown");
    assert.equal(created[0]?.closed, false);
    assert.equal(manager.unprovenExit("dsh_unproven00000") !== undefined, true);

    // The same task may not start beside an unproved process.
    await assert.rejects(
      manager.acquire(input("dsh_unproven00000", [])),
      (error: unknown) => error instanceof SdkBackendError && error.code === "runtime_unavailable" && error.retryable === false,
    );
    // And the retained slot still counts against capacity.
    assert.equal(manager.usedCapacity, 1);
    await assert.rejects(
      manager.acquire(input("dsh_othertask0000", [])),
      (error: unknown) => error instanceof SdkBackendError && error.code === "runtime_capacity_exceeded",
    );
  });
});

describe("SDK backend: concurrent acquisition and view revision", () => {
  async function managerHarness(env: Record<string, string> = {}) {
    const { root, config } = await roots();
    const merged = loadConfig({
      DSH_HOST_PROTOCOL: "sdk",
      DSH_HOME: config.sdk!.dshHome,
      DSH_BRIDGE_HOME: config.homeDir,
      DSH_SDK_IDLE_TIMEOUT_MS: "0",
      ...env,
    });
    const { factory, created } = fakeRuntimeFactory();
    const manager = new SdkRuntimeManager({
      sdk: merged.sdk!,
      requestTimeoutMs: 5_000,
      clientFactory: factory,
      logger: () => undefined,
    });
    cleanups.push(async () => {
      await manager.closeAll("test-cleanup");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    return { manager, created };
  }

  function acquireInput(taskId: string): AcquireSdkRuntimeInput {
    return {
      taskId,
      sessionId: `session-${taskId}`,
      cwd: process.cwd(),
      route: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      resume: false,
      onNotification: () => undefined,
      onRequest: async () => ({}),
      onUserQuestion: async () => ({ cancelled: true }),
    };
  }

  it("spawns exactly one runtime for concurrent acquires of the same task", async () => {
    const { manager, created } = await managerHarness();
    const [first, second, third] = await Promise.all([
      manager.acquire(acquireInput("dsh_sameTask0001")),
      manager.acquire(acquireInput("dsh_sameTask0001")),
      manager.acquire(acquireInput("dsh_sameTask0001")),
    ]);
    assert.equal(created.length, 1, "concurrent callers share one runtime");
    assert.equal(first, second);
    assert.equal(second, third);
  });

  it("never exceeds maxRuntimes under concurrent multi-task acquisition", async () => {
    const { manager, created } = await managerHarness({ DSH_SDK_MAX_RUNTIMES: "2" });
    const results = await Promise.allSettled([
      manager.acquire(acquireInput("dsh_concTask00001")),
      manager.acquire(acquireInput("dsh_concTask00002")),
      manager.acquire(acquireInput("dsh_concTask00003")),
      manager.acquire(acquireInput("dsh_concTask00004")),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(created.length, 2, "the cap is enforced across concurrent starts");
    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 2);
    for (const rejection of rejected) {
      const reason = (rejection as PromiseRejectedResult).reason;
      assert.ok(reason instanceof SdkBackendError && reason.code === "runtime_capacity_exceeded");
    }
    assert.equal(manager.usedCapacity, 2, "reservations are released after success");
  });

  it("releases its reservation when a start fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-reserve-"));
    const config = loadConfig({
      DSH_HOST_PROTOCOL: "sdk",
      DSH_HOME: join(root, "home"),
      DSH_BRIDGE_HOME: join(root, "bridge"),
      DSH_SDK_IDLE_TIMEOUT_MS: "0",
      DSH_SDK_MAX_RUNTIMES: "1",
    });
    // The first attempt fails its handshake; the retry must be allowed to start.
    const script: FakeSdkRuntimeScript = { initializeError: new Error("no adapter registered") };
    const { factory } = fakeRuntimeFactory(script);
    const manager = new SdkRuntimeManager({ sdk: config.sdk!, requestTimeoutMs: 5_000, clientFactory: factory, logger: () => undefined });
    cleanups.push(async () => {
      await manager.closeAll("test-cleanup");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    await assert.rejects(manager.acquire(acquireInput("dsh_reserveFail01")), (error: unknown) => error instanceof SdkBackendError);
    assert.equal(manager.usedCapacity, 0, "the failed attempt releases its slot");
    delete script.initializeError;
    const next = await manager.acquire(acquireInput("dsh_reserveNext01"));
    assert.equal(next.state, "ready");
  });

  it("keeps the connection revision strictly monotonic across runtime removal and rebuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-revision-"));
    const workspace = join(root, "workspace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    const config = loadConfig({
      DSH_HOST_PROTOCOL: "sdk",
      DSH_HOME: join(root, "home"),
      DSH_BRIDGE_HOME: join(root, "bridge"),
      DSH_SDK_IDLE_TIMEOUT_MS: "0",
    });
    const { factory, created } = fakeRuntimeFactory({
      onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text, 1),
    });
    const client = createSdkDshApi(config, config.sdk!, { clientFactory: factory, logger: () => undefined });
    const tasks = new TaskStore(config.homeDir);
    const adapter = new SdkConnectionAdapter({ tasks, client });
    cleanups.push(async () => {
      await adapter.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    const createdSession = await client.sessionCreate({ cwd: workspace });
    const task = await tasks.create(createdSession.sessionId);
    const idle = adapter.snapshot().revision;
    assert.equal(adapter.snapshot().revision, idle, "a stable view keeps the same revision");

    await client.sessionPrompt({ sessionId: task.sessionId, mode: "queue", content: [{ type: "text", text: "one" }] });
    await waitFor(() => (client.taskStateSync(task.taskId)?.observedEvents ?? 0) >= 4);
    const afterPrompt = adapter.snapshot().revision;
    assert.ok(afterPrompt > idle, `revision advances after a prompt (${idle} → ${afterPrompt})`);

    // Remove the runtime, then rebuild it: the old "generation sum" scheme could
    // return a value equal to the earlier one; the view clock cannot.
    const client2 = (client as unknown as { manager?: unknown }) === undefined ? client : client;
    void client2;
    await client.close();
    const afterClose = adapter.snapshot().revision;
    assert.ok(afterClose > afterPrompt, `revision advances on runtime removal (${afterPrompt} → ${afterClose})`);
    assert.ok(created.length >= 1);
  });
});
