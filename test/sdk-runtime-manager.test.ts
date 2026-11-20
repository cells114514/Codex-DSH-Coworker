import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig, type SdkBridgeConfig } from "../src/config.js";
import { SdkBackendError } from "../src/sdk-errors.js";
import { SdkRuntimeManager, type AcquireSdkRuntimeInput } from "../src/sdk-runtime-manager.js";
import { fakeRuntimeFactory, waitFor, type FakeSdkRuntimeScript } from "./support/fake-sdk-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function manager(options: {
  env?: Record<string, string>;
  script?: FakeSdkRuntimeScript;
  hasPending?: (taskId: string) => boolean;
  isBusy?: (taskId: string) => boolean;
  clock?: { value: number };
  onRuntimeExit?: (taskId: string, info: { clean: boolean; reason: string; error?: string }) => void;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "sdk-manager-"));
  const config = loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: join(root, "home"),
    DSH_BRIDGE_HOME: join(root, "bridge"),
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
    ...options.env,
  });
  const sdk: SdkBridgeConfig = config.sdk!;
  const { factory, created } = fakeRuntimeFactory(options.script);
  const exits: Array<{ taskId: string; clean: boolean; reason: string; observationDrained: boolean }> = [];
  const runtimeManager = new SdkRuntimeManager({
    sdk,
    requestTimeoutMs: 5_000,
    clientFactory: factory,
    hasPendingInteractions: options.hasPending ?? (() => false),
    isBusy: options.isBusy ?? (() => false),
    logger: () => undefined,
    ...(options.clock === undefined ? {} : { now: () => options.clock!.value }),
    onRuntimeExit: (taskId, info) => {
      exits.push({ taskId, clean: info.clean, reason: info.reason, observationDrained: info.observationDrained });
      options.onRuntimeExit?.(taskId, info);
    },
  });
  cleanups.push(async () => {
    await runtimeManager.closeAll("test-cleanup");
    await rm(root, { recursive: true, force: true });
  });
  return { runtimeManager, created, sdk, exits, root };
}

function acquireInput(taskId: string, sessionId: string): AcquireSdkRuntimeInput {
  return {
    taskId,
    sessionId,
    cwd: process.cwd(),
    route: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    resume: false,
    onNotification: () => undefined,
    onRequest: async () => ({}),
    onUserQuestion: async () => ({ cancelled: true }),
  };
}

describe("sdk runtime manager", () => {
  it("spawns one runtime per task and installs handlers before initialize", async () => {
    const { runtimeManager, created } = await manager();
    const runtime = await runtimeManager.acquire(acquireInput("dsh_aaaaaaaaaaaa", "session-a"));
    assert.equal(runtime.state, "ready");
    // Subscribing before the handshake is required: `session/resume` can emit
    // notifications before its RPC result returns.
    assert.deepEqual(created[0]?.calls.slice(0, 4), ["start", "onRequest", "subscribe", "initialize"]);
    assert.equal(runtimeManager.state("dsh_aaaaaaaaaaaa"), "ready");

    const again = await runtimeManager.acquire(acquireInput("dsh_aaaaaaaaaaaa", "session-a"));
    assert.equal(again, runtime, "a live runtime is reused");
    assert.equal(created.length, 1);
  });

  it("refuses to bind an existing task runtime to another root session", async () => {
    const { runtimeManager } = await manager();
    await runtimeManager.acquire(acquireInput("dsh_bbbbbbbbbbbb", "session-a"));
    await assert.rejects(
      runtimeManager.acquire(acquireInput("dsh_bbbbbbbbbbbb", "session-b")),
      (error: unknown) => error instanceof SdkBackendError && error.code === "runtime_identity_mismatch",
    );
  });

  it("bounds capacity and never kills active work", async () => {
    const busy = new Set(["dsh_cccccccccccc"]);
    const { runtimeManager, created } = await manager({
      env: { DSH_SDK_MAX_RUNTIMES: "1" },
      isBusy: (taskId) => busy.has(taskId),
    });
    await runtimeManager.acquire(acquireInput("dsh_cccccccccccc", "session-a"));
    await assert.rejects(
      runtimeManager.acquire(acquireInput("dsh_dddddddddddd", "session-b")),
      (error: unknown) => error instanceof SdkBackendError && error.code === "runtime_capacity_exceeded" && error.retryable === true,
    );
    assert.equal(created.length, 1, "no second runtime was spawned");
    assert.equal(runtimeManager.state("dsh_cccccccccccc"), "ready", "the active runtime stays alive");

    // Once the first task is idle and has no pending interaction, capacity
    // pressure reclaims it instead of waiting unboundedly.
    busy.delete("dsh_cccccccccccc");
    const second = await runtimeManager.acquire(acquireInput("dsh_dddddddddddd", "session-b"));
    assert.equal(second.state, "ready");
    assert.equal(runtimeManager.state("dsh_cccccccccccc"), "absent");
  });

  it("reclaims idle runtimes only after the idle bound and never with a pending interaction", async () => {
    const clock = { value: 1_000 };
    let pending = false;
    const { runtimeManager } = await manager({
      env: { DSH_SDK_IDLE_TIMEOUT_MS: "1000" },
      clock,
      hasPending: () => pending,
    });
    await runtimeManager.acquire(acquireInput("dsh_eeeeeeeeeeee", "session-a"));
    clock.value += 500;
    assert.deepEqual(await runtimeManager.reclaimIdle("idle-timeout"), []);
    pending = true;
    clock.value += 5_000;
    assert.deepEqual(await runtimeManager.reclaimIdle("idle-timeout"), [], "a pending interaction blocks reclamation");
    pending = false;
    assert.deepEqual(await runtimeManager.reclaimIdle("idle-timeout"), ["dsh_eeeeeeeeeeee"]);
    assert.equal(runtimeManager.state("dsh_eeeeeeeeeeee"), "absent");
  });

  it("reports a failed initialize without leaking a runtime slot", async () => {
    const { runtimeManager, created } = await manager({ script: { initializeError: new Error("no adapter registered for provider") } });
    await assert.rejects(
      runtimeManager.acquire(acquireInput("dsh_ffffffffffff", "session-a")),
      (error: unknown) =>
        error instanceof SdkBackendError &&
        error.code === "sdk_initialize_failed" &&
        error.retryable === true &&
        error.details.reason !== undefined,
    );
    assert.equal(created[0]?.closed, true, "the failed runtime is reaped");
    assert.equal(runtimeManager.size, 0);
  });

  it("reports a failed resume as session_resume_failed", async () => {
    const { runtimeManager } = await manager({ script: { resumeError: new Error("no such session") } });
    const input = { ...acquireInput("dsh_111111111111", "session-a"), resume: true };
    await assert.rejects(
      runtimeManager.acquire(input),
      (error: unknown) => error instanceof SdkBackendError && error.code === "session_resume_failed",
    );
    assert.equal(runtimeManager.size, 0);
  });

  it("marks a dropped transport as crashed and reports an unclean exit", async () => {
    const { runtimeManager, created, exits } = await manager();
    await runtimeManager.acquire(acquireInput("dsh_222222222222", "session-a"));
    const runtime = created[0]!;
    await runtime.close();
    await waitFor(() => exits.length === 1);
    assert.equal(exits[0]?.clean, false);
    assert.equal(exits[0]?.reason, "transport-closed");
    assert.equal(exits[0]?.observationDrained, false);
    // A lost transport releases its slot (the child's stdio ended) without
    // claiming an unproven exit, so the task stays resumable.
    await waitFor(() => runtimeManager.get("dsh_222222222222") === undefined);
    assert.equal(runtimeManager.usedCapacity, 0);
    assert.equal(runtimeManager.unprovenExit("dsh_222222222222"), undefined);
  });

  it("closes every runtime it owns and stays idempotent", async () => {
    const { runtimeManager, created } = await manager();
    await runtimeManager.acquire(acquireInput("dsh_333333333333", "session-a"));
    await runtimeManager.acquire(acquireInput("dsh_444444444444", "session-b"));
    await runtimeManager.closeAll();
    assert.equal(created.every((runtime) => runtime.closed), true);
    await runtimeManager.closeAll();
    assert.equal(runtimeManager.size, 0);
    await assert.rejects(
      runtimeManager.acquire(acquireInput("dsh_555555555555", "session-c")),
      (error: unknown) => error instanceof SdkBackendError && error.code === "runtime_unavailable",
    );
  });
});
