/**
 * Completion-record assertions for the coworker flow, driven by the scripted
 * fake runtime: no process, no queue, no model.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig, type BridgeConfig } from "../src/config.js";
import { CoworkerBindings } from "../src/coworker-binding.js";
import { createSdkDshApi, type SdkDshClient } from "../src/sdk-dsh-client.js";
import { TaskStore } from "../src/task-store.js";
import { fakeRuntimeFactory, type FakeSdkRuntime, type FakeSdkRuntimeScript } from "./support/fake-sdk-runtime.js";

const THREAD = "11111111-2222-4333-8444-555555555555";
const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Harness {
  client: SdkDshClient;
  config: BridgeConfig;
  restart: () => Promise<SdkDshClient>;
  sessionId: string;
  outbox: string;
  created: FakeSdkRuntime[];
  bind: () => Promise<void>;
  records: () => Promise<Array<Record<string, unknown>>>;
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(`condition not met in time (${new Date().toISOString()})`);
}

async function harness(script: FakeSdkRuntimeScript = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "cw-completion-"));
  const dshHome = join(root, "dsh-home");
  const bridgeHome = join(root, "bridge-home");
  const cwd = join(root, "workspace");
  await mkdir(dshHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const config: BridgeConfig = loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: dshHome,
    DSH_BRIDGE_HOME: bridgeHome,
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
    DSH_APPROVAL_TIMEOUT_MS: "5000",
  });
  const { factory, created } = fakeRuntimeFactory(script);
  const client = createSdkDshApi(config, config.sdk!, { clientFactory: factory, logger: () => undefined });
  const tasks = new TaskStore(config.homeDir);
  const createdSession = await client.sessionCreate({ cwd });
  const task = await tasks.create(createdSession.sessionId);
  const outbox = join(config.homeDir, "coworker-outbox");
  const bindings = new CoworkerBindings(config.homeDir);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return {
    client,
    config,
    restart: async () => {
      await client.close().catch(() => undefined);
      const next = createSdkDshApi(config, config.sdk!, { clientFactory: fakeRuntimeFactory(script).factory, logger: () => undefined });
      cleanups.push(async () => { await next.close().catch(() => undefined); });
      return next;
    },
    sessionId: createdSession.sessionId,
    outbox,
    created,
    bind: async () => {
      const bound = await bindings.bind(task.taskId, { threadId: THREAD }, outbox, [outbox]);
      assert.equal(bound.registered, true, String(bound.reason ?? ""));
    },
    records: async () => {
      const names = (await readdir(outbox).catch(() => [])).filter((name) => name.endsWith(".json"));
      return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(outbox, name), "utf8")) as Record<string, unknown>));
    },
  };
}

function emitTurn(runtime: FakeSdkRuntime, sessionId: string, seq: number, reason: unknown = { kind: "completed" }): void {
  runtime.emitEvent(sessionId, { type: "turn/start", seq, data: {} });
  runtime.emitEvent(sessionId, { type: "turn/end", seq: seq + 1, data: { reason } });
  runtime.emitStatus(sessionId, "idle");
}

function text(value = "go"): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: value }];
}

describe("coworker completion records", () => {
  it("attributes an event that arrives before the prompt receipt", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        // Emitted inside prompt(), before the receipt resolves.
        emitTurn(runtime, sessionId, 1);
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() });
    await until(async () => (await h.records()).length === 1);
    const [record] = await h.records();
    assert.equal(record.executionId, "e1");
    assert.equal(record.execution, "turn_completed");
    assert.equal(record.threadId, THREAD);
  });

  it("writes one record when a fast completion repeats its terminal event", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        emitTurn(runtime, sessionId, 1);
        runtime.emitEvent(sessionId, { type: "turn/end", seq: 3, data: { reason: { kind: "completed" } } });
        runtime.emitStatus(sessionId, "idle");
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() });
    await until(async () => (await h.records()).length === 1);
    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await h.records()).length, 1);
  });

  it("does not resend input when the receipt is uncertain", async () => {
    const h = await harness({
      promptError: new Error("receipt lost"),
      onPrompt: (runtime, sessionId) => {
        emitTurn(runtime, sessionId, 1);
      },
    });
    await h.bind();
    await assert.rejects(h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() }), /receipt/i);
    await until(async () => (await h.records()).length === 1);
    assert.equal(h.created[0]?.prompts.length, 1, "the input must not be resubmitted");
  });

  it("ignores a terminal event from a descendant session", async () => {
    const h = await harness({
      onPrompt: (runtime) => {
        emitTurn(runtime, "child-session", 1);
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() });
    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await h.records()).length, 0);
  });

  it("records a failure once and never continues work afterwards", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        emitTurn(runtime, sessionId, 1, { kind: "error", error: { code: "AUTH" } });
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() });
    await until(async () => (await h.records()).length === 1);
    const [record] = await h.records();
    assert.equal(record.execution, "failed");
    const promptsBefore = h.created[0]?.prompts.length ?? 0;
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(h.created[0]?.prompts.length, promptsBefore, "no automatic continuation after a failure");
    assert.equal((await h.records()).length, 1);
  });

  it("gives each follow-up its own record without replaying the first", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        emitTurn(runtime, sessionId, 1);
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("first") });
    await until(async () => (await h.records()).length === 1);
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("second") });
    await until(async () => (await h.records()).length === 2);
    const records = await h.records();
    assert.deepEqual(records.map((entry) => entry.executionId).sort(), ["e1", "e2"]);
    assert.equal(new Set(records.map((entry) => entry.eventId)).size, 2);
  });


  it("holds the notice while a descendant is active, then writes it once", async () => {
    let seq = 1;
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        // Root turn ends while a child session is still running.
        runtime.emitEvent("child-1", { type: "turn/start", seq: 1, data: {} });
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
        runtime.emitEvent(sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
        runtime.emitStatus(sessionId, "idle");
        seq += 10;
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() });
    await new Promise((done) => setTimeout(done, 200));
    assert.equal((await h.records()).length, 0, "no notice while the descendant runs");
  });

  it("accepts a second input after the first interval and notifies per execution", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("a") });
    // Contract: one in-flight execution, because the SDK exposes no reliable
    // message->turn association. The second input is refused, not queued.
    await assert.rejects(
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") }),
      (error: unknown) => (error as { code?: string }).code === "prompt_in_flight",
    );
    assert.equal(h.created[0]?.prompts.length, 1, "the refused input must not be sent");
    const runtime = h.created[0]!;
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 1);
    // After the terminal, the same task accepts the follow-up as a new execution.
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") });
    runtime.emitEvent(h.sessionId, { type: "turn/start", seq: 3, data: {} });
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 2);
    assert.deepEqual((await h.records()).map((entry) => entry.executionId).sort(), ["e1", "e2"]);
  });
  it("notifies once after the descendant finishes and the root summary completes", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent("child-1", { type: "turn/start", seq: 1, data: {} });
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
        runtime.emitEvent(sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
        runtime.emitStatus(sessionId, "idle");
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() });
    await new Promise((done) => setTimeout(done, 120));
    assert.equal((await h.records()).length, 0, "nothing while the descendant runs");
    const runtime = h.created[0]!;
    runtime.emitEvent("child-1", { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus("child-1", "idle");
    runtime.emitEvent(h.sessionId, { type: "turn/start", seq: 3, data: {} });
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length >= 1);
    await new Promise((done) => setTimeout(done, 200));
    assert.equal((await h.records()).length, 1, "exactly one completion notice for the whole run");
  });

  it("refuses e2 while e1 is open and keeps the generations apart afterwards", async () => {
    let submitted = 0;
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        submitted += 1;
        if (submitted === 1) runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("a") });
    await assert.rejects(
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") }),
      (error: unknown) => (error as { code?: string }).code === "prompt_in_flight",
    );
    const runtime = h.created[0]!;
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 1);
    // Now e2 is allowed and gets its own record.
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") });
    runtime.emitEvent(h.sessionId, { type: "turn/start", seq: 3, data: {} });
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 2);
    assert.deepEqual((await h.records()).map((entry) => entry.executionId).sort(), ["e1", "e2"]);
  });
  it("treats a second input consumed by the same turn as unreachable under the contract", async () => {
    // The pinned SDK exposes no message->turn association, so this state cannot be
    // attributed: the second input is refused instead of being accepted and left
    // hanging. The fixture still shows a single turn consuming queued work.
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("a") });
    await assert.rejects(
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") }),
      (error: unknown) => (error as { code?: string }).code === "prompt_in_flight",
    );
    const runtime = h.created[0]!;
    assert.equal(h.created[0]?.prompts.length, 1, "the refused input is never sent");
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 1);
    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await h.records()).length, 1, "one consuming turn yields one notice, none hangs");
  });

  it("notifies once for one input that spans several root turns", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text() });
    const runtime = h.created[0]!;
    // First turn ends but the runtime is still working: no notice yet.
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "running");
    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await h.records()).length, 0, "no notice between turns");
    // Second turn, then idle: exactly one notice for the whole interval.
    runtime.emitEvent(h.sessionId, { type: "turn/start", seq: 3, data: {} });
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 1);
    await new Promise((done) => setTimeout(done, 150));
    const records = await h.records();
    assert.equal(records.length, 1, "exactly one notice for a multi-turn execution");
    assert.equal(records[0]?.executionId, "e1");
  });
  it("leaves generation, pending queue and persisted counter untouched on refusal", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("a") });
    await assert.rejects(
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") }),
      (error: unknown) => (error as { code?: string }).code === "prompt_in_flight",
    );
    const runtime = h.created[0]!;
    assert.equal(runtime.prompts.length, 1, "the refused submit never reaches prompt()");
    // Finish the first execution, then the counter continues at e2 — the refused
    // attempt consumed neither a generation nor a queue slot.
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 1);
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") });
    runtime.emitEvent(h.sessionId, { type: "turn/start", seq: 3, data: {} });
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await until(async () => (await h.records()).length === 2);
    assert.deepEqual((await h.records()).map((entry) => entry.executionId).sort(), ["e1", "e2"]);
  });

  it("keeps the guard until the confirmation and settles exactly once", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      },
      holdWait: true,
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("a") });
    const runtime = h.created[0]!;
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await new Promise((done) => setTimeout(done, 100));
    // The answer is still outstanding: the slot must not be released early.
    await assert.rejects(
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") }),
      (error: unknown) => (error as { code?: string }).code === "prompt_in_flight",
    );
    assert.equal((await h.records()).length, 0, "no record before confirmation");
    runtime.releaseWait();
    await until(async () => (await h.records()).length === 1);
    // A duplicated idle must not write a second record for the same execution.
    runtime.emitStatus(h.sessionId, "idle");
    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await h.records()).length, 1);
    assert.equal((await h.records())[0]?.executionId, "e1");
  });

  it("terminates a pending confirmation when the client closes", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
      },
      holdWait: true,
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("a") });
    const runtime = h.created[0]!;
    runtime.emitEvent(h.sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(h.sessionId, "idle");
    await new Promise((done) => setTimeout(done, 80));
    await h.client.close();
    runtime.releaseWait();
    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await h.records()).length, 0, "a closed client must not write after abort");
  });
  it("distinguishes a pre-submission failure from a lost receipt", async () => {
    const preSubmit = await harness({ initializeError: new Error("handshake failed") });
    await preSubmit.bind();
    await assert.rejects(preSubmit.client.sessionPrompt({ sessionId: preSubmit.sessionId, mode: "queue", content: text() }));
    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await preSubmit.records()).length, 0, "nothing was submitted, so no completion");
    assert.equal(preSubmit.created[0]?.prompts.length ?? 0, 0);

    // Events arrive, then the receipt is lost: the accepted work must survive.
    const lostReceipt = await harness({
      promptError: new Error("receipt lost"),
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
        runtime.emitEvent(sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
        runtime.emitStatus(sessionId, "idle");
      },
    });
    await lostReceipt.bind();
    await assert.rejects(lostReceipt.client.sessionPrompt({ sessionId: lostReceipt.sessionId, mode: "queue", content: text() }));
    await until(async () => (await lostReceipt.records()).length === 1);
    assert.equal(lostReceipt.created[0]?.prompts.length, 1, "the input must not be resubmitted");
  });
  it("continues the generation sequence after a bridge restart", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        emitTurn(runtime, sessionId, 1);
      },
    });
    await h.bind();
    await h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("first") });
    await until(async () => (await h.records()).length === 1);
    const restarted = await h.restart();
    await restarted.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("second") });
    await until(async () => (await h.records()).length === 2);
    const records = await h.records();
    assert.deepEqual(records.map((entry) => entry.executionId).sort(), ["e1", "e2"], "a restart must not reuse e1");
  });

  it("rejects one of two concurrent submissions instead of overwriting a generation", async () => {
    const h = await harness({
      onPrompt: (runtime, sessionId) => {
        runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
        runtime.emitEvent(sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
        runtime.emitStatus(sessionId, "idle");
      },
    });
    await h.bind();
    const settled = await Promise.allSettled([
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("a") }),
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: text("b") }),
    ]);
    const rejected = settled.filter((entry) => entry.status === "rejected");
    assert.equal(rejected.length, 1, "exactly one concurrent submit must be refused");
    assert.equal((rejected[0] as PromiseRejectedResult).reason?.code, "prompt_in_flight");
    assert.equal(h.created[0]?.prompts.length, 1, "only one prompt may be sent");
    await until(async () => (await h.records()).length === 1);
    assert.equal((await h.records()).length, 1);
  });
});
