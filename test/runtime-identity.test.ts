/**
 * Runtime identity persistence: a spawned runtime must be provable in the record
 * before any prompt is accepted, and an unprovable identity must stop the run.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { createSdkDshApi } from "../src/sdk-dsh-client.js";
import { RuntimeRegistry } from "../src/runtime-registry.js";
import { TaskStore } from "../src/task-store.js";
import { fakeRuntimeFactory } from "./support/fake-sdk-runtime.js";

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(script = {}) {
  const root = await mkdtemp(join(tmpdir(), "cw-identity-"));
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
  const { factory, created } = fakeRuntimeFactory(script);
  const client = createSdkDshApi(config, config.sdk, {
    clientFactory: factory,
    logger: () => undefined,
    bridgeInstanceId: "identity-test-bridge",
  });
  const tasks = new TaskStore(config.homeDir);
  const registry = new RuntimeRegistry(config.homeDir);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { client, tasks, registry, cwd, config, created };
}

describe("runtime identity persistence", () => {
  it("records pid, start time and owner before accepting a prompt", async () => {
    const h = await harness();
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    await h.client.sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] });
    const record = await h.registry.get(task.taskId);
    assert.equal(record?.diagnostic?.runtimePid, 4321);
    assert.equal(record?.diagnostic?.runtimeStartedAt, "2026-11-19T00:00:00.000Z");
    assert.equal(record?.owner.bridgeInstanceId, "identity-test-bridge");
    assert.equal(record?.taskId, task.taskId);
    assert.equal(record?.rootSessionId, session.sessionId);
  });

  it("refuses to prompt when the identity cannot be persisted", async () => {
    const h = await harness();
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    // Break the registry for updates: the runtimes directory becomes a file.
    const runtimesDir = join(h.config.homeDir, "runtimes");
    await rm(runtimesDir, { recursive: true, force: true });
    await writeFile(runtimesDir, "not-a-directory", "utf8");
    const failure = await h.client
      .sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] })
      .then(() => null, (error: unknown) => error);
    assert.ok(failure !== null, "the prompt must be refused when the identity is unprovable");
    assert.match(String((failure as { message?: string }).message ?? failure), /identit|persist|registry/i);
    assert.equal(h.created[0]?.prompts.length ?? 0, 0, "no prompt may be sent without a recorded identity");
  });

  it("skips identity when the client cannot report it", async () => {
    const h = await harness({ omitIdentity: true });
    const session = await h.client.sessionCreate({ cwd: h.cwd });
    const task = await h.tasks.create(session.sessionId);
    await h.client.sessionPrompt({ sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] });
    const record = await h.registry.get(task.taskId);
    assert.equal(record?.diagnostic?.runtimePid, undefined, "no identity is invented");
    assert.equal(h.created[0]?.prompts.length, 1, "the prompt still proceeds when identity is unavailable");
  });
});
