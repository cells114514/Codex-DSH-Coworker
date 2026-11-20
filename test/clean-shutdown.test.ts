/**
 * Clean-shutdown persistence: a completed shutdown marks the runtime record,
 * and an abrupt end must never look clean afterwards.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { createSdkDshApi } from "../src/sdk-dsh-client.js";
import { RuntimeRegistry } from "../src/runtime-registry.js";
import { TaskStore } from "../src/task-store.js";
import { fakeRuntimeFactory, waitFor } from "./support/fake-sdk-runtime.js";

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(script: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "cw-clean-"));
  const dshHome = join(root, "dsh-home");
  const bridgeHome = join(root, "bridge-home");
  const cwd = join(root, "workspace");
  await mkdir(dshHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const config = loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: dshHome,
    DSH_BRIDGE_HOME: bridgeHome,
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
    DSH_APPROVAL_TIMEOUT_MS: "5000",
  });
  const { factory } = fakeRuntimeFactory({ ...script,
    onPrompt: (runtime, sessionId) => {
      runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      runtime.emitEvent(sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
      runtime.emitStatus(sessionId, "idle");
    },
  });
  const client = createSdkDshApi(config, config.sdk, { clientFactory: factory, logger: () => undefined });
  const tasks = new TaskStore(config.homeDir);
  const registry = new RuntimeRegistry(config.homeDir);
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return { client, tasks, registry, cwd, config };
}

describe("clean shutdown bookkeeping", () => {
  it("persists cleanShutdown after a completed close", async () => {
    const h = await harness();
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    await h.client.sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] });
    await waitFor(() => h.client.taskStateSync(task.taskId)?.observedEvents !== undefined);
    const before = await h.registry.get(task.taskId);
    assert.equal(before?.cleanShutdown, false, "a live runtime is not clean yet");
    await h.client.close();
    const after = await h.registry.get(task.taskId);
    assert.equal(after?.cleanShutdown, true);
    assert.ok(typeof after?.cleanShutdownAt === "string", "the timestamp is recorded");
  });


  it("does not record a clean shutdown when the close fails", async () => {
    const h = await harness({ closeError: new Error("rpc close timed out") });
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    await h.client.sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] });
    await waitFor(() => h.client.taskStateSync(task.taskId)?.observedEvents !== undefined);
    await h.client.close();
    const record = await h.registry.get(task.taskId);
    assert.equal(record?.cleanShutdown, false, "an unconfirmed exit must stay unclean");
    assert.equal(record?.cleanShutdownAt, undefined);
  });

  it("does not overwrite a record whose ownership changed", async () => {
    const h = await harness();
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    await h.client.sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] });
    await waitFor(() => h.client.taskStateSync(task.taskId)?.observedEvents !== undefined);
    const current = await h.registry.get(task.taskId);
    assert.ok(current);
    // Another instance takes ownership while this one is still shutting down.
    await h.registry.update(task.taskId, {
      cleanShutdown: false,
      diagnostic: { lastError: "ownership moved" },
    });
    // Simulate another bridge taking ownership by rewriting the record on disk.
    const recordPath = join(h.config.homeDir, "runtimes", `${task.taskId}.json`);
    const moved = { ...current, owner: { ...current.owner, bridgeInstanceId: "other-instance" } };
    await writeFile(recordPath, JSON.stringify(moved, null, 2), "utf8");
    await h.client.close();
    const after = await h.registry.get(task.taskId);
    assert.equal(after?.cleanShutdown, false, "a different owner is not marked clean by us");
    assert.equal(after?.owner.bridgeInstanceId, "other-instance");
  });

  it("marks clean only after cleanup finishes, not before", async () => {
    const h = await harness({ closeDelayMs: 300 });
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    await h.client.sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] });
    await waitFor(() => h.client.taskStateSync(task.taskId)?.observedEvents !== undefined);
    const pending = h.client.close();
    await new Promise((done) => setTimeout(done, 100));
    const during = await h.registry.get(task.taskId);
    assert.equal(during?.cleanShutdown, false, "mid-shutdown is not clean yet");
    await pending;
    const after = await h.registry.get(task.taskId);
    assert.equal(after?.cleanShutdown, true);
  });
  it("keeps cleanShutdown false when the client never closed", async () => {
    const h = await harness();
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    await h.client.sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] });
    await waitFor(() => h.client.taskStateSync(task.taskId)?.observedEvents !== undefined);
    // No close(): this models an abrupt end, which must not look clean.
    const record = await h.registry.get(task.taskId);
    assert.equal(record?.cleanShutdown, false);
    await h.client.close();
  });
});
