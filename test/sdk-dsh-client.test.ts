import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig, type BridgeConfig } from "../src/config.js";
import { createSdkDshApi, type SdkDshClient } from "../src/sdk-dsh-client.js";
import { SdkBackendError } from "../src/sdk-errors.js";
import { SdkObservedEventStore } from "../src/sdk-observed-event-store.js";
import { TaskStore, type TaskRecord } from "../src/task-store.js";
import { completeTurn, fakeRuntimeFactory, waitFor, type FakeSdkRuntime, type FakeSdkRuntimeScript } from "./support/fake-sdk-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Harness {
  root: string;
  config: BridgeConfig;
  client: SdkDshClient;
  tasks: TaskStore;
  created: FakeSdkRuntime[];
  taskId: string;
  sessionId: string;
  cwd: string;
}

async function harness(options: {
  env?: Record<string, string>;
  script?: FakeSdkRuntimeScript;
  bridgeInstanceId?: string;
  prompt?: string;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "sdk-client-"));
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
    ...options.env,
  });
  const { factory, created } = fakeRuntimeFactory(options.script);
  const client = createSdkDshApi(config, config.sdk!, {
    clientFactory: factory,
    logger: () => undefined,
    ...(options.bridgeInstanceId === undefined ? {} : { bridgeInstanceId: options.bridgeInstanceId }),
  });
  const tasks = new TaskStore(config.homeDir);
  const createdSession = await client.sessionCreate({ cwd });
  const task = await tasks.create(createdSession.sessionId);
  cleanups.push(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  if (options.prompt !== undefined) {
    await client.sessionPrompt({ sessionId: task.sessionId, mode: "queue", content: [{ type: "text", text: options.prompt }] });
  }
  return { root, config, client, tasks, created, taskId: task.taskId, sessionId: task.sessionId, cwd };
}

async function eventTypes(client: SdkDshClient, task: TaskRecord, minimum: number): Promise<string[]> {
  await waitFor(() => client.taskStateSync(task.taskId) !== undefined);
  await waitFor(() => (client.taskStateSync(task.taskId)?.observedEvents ?? 0) >= minimum);
  const history = await client.readHistory(task.taskId, task.sessionId, { maxMessages: 50 });
  return history.events.map((entry) => entry.event.type);
}

describe("sdk backend adapter", () => {
  it("constructs without spawning a runtime or touching the Host", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-client-idle-"));
    const config = loadConfig({
      DSH_HOST_PROTOCOL: "sdk",
      DSH_HOME: join(root, "home"),
      DSH_BRIDGE_HOME: join(root, "bridge"),
      DSH_SDK_IDLE_TIMEOUT_MS: "0",
    });
    const { factory, created } = fakeRuntimeFactory();
    const client = createSdkDshApi(config, config.sdk!, { clientFactory: factory, logger: () => undefined });
    cleanups.push(async () => {
      await client.close();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal(created.length, 0, "construction must not spawn a runtime");
    assert.deepEqual(client.runtimeSnapshots(), []);

    const description = await client.hostDescribe();
    assert.equal(description.backend, "sdk");
    assert.equal(description.transport, "stdio-jsonrpc");
    assert.equal(description.productVersion, null, "no Desktop product version is fabricated");
    assert.equal(description.canOpenPath, false);
    assert.equal(created.length, 0, "describing the backend must not spawn a runtime");

    assert.equal(client.capabilities.backend, "sdk");
    assert.equal(client.capabilities.eventsMuxWebSocket ?? false, false);
    assert.equal(client.protocolCapabilities.queueSnapshot, false);
  });

  it("creates a bridge-local session identity and rejects agent presets", async () => {
    const h = await harness();
    assert.match(h.sessionId, /^[0-9a-f-]{36}$/, "the bridge mints a UUID session id");
    const created = await h.client.sessionCreate({ cwd: h.cwd });
    assert.equal(created.identityProvenance, "bridge-local-id");
    await assert.rejects(
      h.client.sessionCreate({ cwd: h.cwd, agentPreset: "code" }),
      (error: unknown) => error instanceof SdkBackendError && error.code === "unsupported_capability" && error.details.capability === "agentPreset",
    );
  });

  it("installs observers before the first prompt and records real events durably", async () => {
    const h = await harness({
      prompt: "hello",
      script: {
        onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text),
      },
    });
    const runtime = h.created[0]!;
    const order = runtime.calls.filter((call) => call === "start" || call === "onRequest" || call === "initialize" || call === "prompt" || call === "subscribe");
    assert.deepEqual(order.slice(0, 4), ["start", "onRequest", "subscribe", "initialize"]);
    assert.equal(order[4], "prompt");
    assert.equal(runtime.initializes[0]?.approvalRequests, true);
    assert.deepEqual(runtime.initializes[0]?.capabilities, { userQuestions: true });

    const types = await eventTypes(h.client, { taskId: h.taskId, sessionId: h.sessionId }, 4);
    assert.ok(types.includes("assistant/message"));
    assert.ok(types.includes("turn/end"));

    const ledger = await h.client.ledgerSnapshot(h.taskId);
    assert.equal(ledger.execution, "turn_completed");
    assert.deepEqual(ledger.finalMessagePointer, { sessionId: h.sessionId, seq: 3 });

    const history = await h.client.readHistory(h.taskId, h.sessionId, { maxMessages: 50 });
    assert.equal(history.coverage?.complete, true);
    assert.equal(history.coverage?.observedSource, "observed-cache");
  });

  it("reports a durable message id and never treats the receipt as completion", async () => {
    const h = await harness({ prompt: "receipt only" });
    const history = await h.client.readHistory(h.taskId, h.sessionId, { maxMessages: 10 });
    // The runtime accepted the message but emitted no turn events yet.
    assert.deepEqual(history.events, []);
    // Contract: the first input is still in flight (no idle yet), so a second
    // submit is refused instead of being queued with no attributable turn.
    await assert.rejects(
      h.client.sessionPrompt({
        sessionId: h.sessionId,
        mode: "queue",
        content: [{ type: "text", text: "second" }],
      }),
      (error: unknown) => (error as { code?: string }).code === "prompt_in_flight",
    );
    const after = await h.client.taskStateSync(h.taskId);
    assert.equal(after?.observedEvents, 0, "a refused submit adds no observation");
  });

  it("reports an unknown prompt outcome instead of retrying", async () => {
    const { factory, created } = fakeRuntimeFactory({ promptError: new Error("RequestTimeoutError: session/prompt") });
    const root = await mkdtemp(join(tmpdir(), "sdk-client-outcome-"));
    const config = loadConfig({
      DSH_HOST_PROTOCOL: "sdk",
      DSH_HOME: join(root, "home"),
      DSH_BRIDGE_HOME: join(root, "bridge"),
      DSH_SDK_IDLE_TIMEOUT_MS: "0",
    });
    const client = createSdkDshApi(config, config.sdk!, { clientFactory: factory, logger: () => undefined });
    cleanups.push(async () => {
      await client.close();
      await rm(root, { recursive: true, force: true });
    });
    const tasks = new TaskStore(config.homeDir);
    const created_ = await client.sessionCreate({ cwd: root });
    const task = await tasks.create(created_.sessionId);
    await assert.rejects(
      client.sessionPrompt({ sessionId: task.sessionId, mode: "queue", content: [{ type: "text", text: "go" }] }),
      (error: unknown) => error instanceof SdkBackendError && error.code === "prompt_outcome_unknown" && error.retryable === false,
    );
    assert.equal(created.length, 1, "one runtime was started for the attempt");
    assert.equal(created[0]?.prompts.length, 1, "the prompt must not be retried");
  });

  it("rejects unsupported capabilities with structured errors and no side effects", async () => {
    const h = await harness();
    const reject = async (promise: Promise<unknown>, capability: string) => {
      await assert.rejects(
        promise,
        (error: unknown) =>
          error instanceof SdkBackendError &&
          error.code === "unsupported_capability" &&
          error.details.capability === capability,
      );
    };
    await reject(h.client.sessionList(), "sessionDiscovery");
    await reject(h.client.sessionModels(h.sessionId), "modelCatalog");
    await reject(
      h.client.sessionSelectModel({ sessionId: h.sessionId, provider: "deepseek-official", model: "deepseek-v4-flash" }),
      "dynamicModelSelection",
    );
    await reject(h.client.sessionRename(h.sessionId, "title"), "nativeRename");
    await reject(h.client.sessionCancel(h.sessionId), "turnCancel");
    await reject(h.client.sessionUpdateQueue(h.sessionId, "item", { kind: "remove" }), "queueMutation");
    await reject(
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "steer", content: [{ type: "text", text: "hi" }] }),
      "steer",
    );
    assert.equal(h.created.length, 0, "unsupported calls never start a runtime");
  });

  it("answers one approval exactly once and refuses duplicates and wrong tasks", async () => {
    const h = await harness({ prompt: "needs approval" });
    const runtime = h.created[0]!;
    const pending = runtime.requestApproval({ sessionId: h.sessionId, toolName: "shell", reason: "run tests" });
    await waitFor(() => h.client.pendingForTask(h.taskId).length === 1);
    const envelope = h.client.pendingForTask(h.taskId)[0]!;
    assert.equal(envelope.payload.type, "approval/requested");
    const approvalFrame = envelope.payload as unknown as { approvalId: string; toolName: string; approvalIdSource: string };
    assert.equal(approvalFrame.toolName, "shell");
    assert.equal(approvalFrame.approvalIdSource, "bridge-local");

    const resolved = await h.client.resolveApproval(h.taskId, envelope.rpcId, "allow_once");
    assert.deepEqual(resolved, { accepted: true, requestId: envelope.rpcId, outcome: "allowed-once" });
    assert.deepEqual(await pending, { outcome: "allowed-once" });
    assert.equal(h.client.pendingForTask(h.taskId).length, 0);

    await assert.rejects(
      h.client.resolveApproval(h.taskId, envelope.rpcId, "allow_once"),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "not-pending",
    );
    // A question answer aimed at an approval request is a type mismatch, not a
    // late answer: both must be refused without settling anything.
    const second = runtime.requestApproval({ sessionId: h.sessionId, toolName: "shell" });
    await waitFor(() => h.client.pendingForTask(h.taskId).length === 1);
    const secondEnvelope = h.client.pendingForTask(h.taskId)[0]!;
    await assert.rejects(
      h.client.answerQuestion(h.taskId, secondEnvelope.rpcId, [{ id: "x", selected: ["y"] }]),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "wrong-type",
    );
    await h.client.resolveApproval(h.taskId, secondEnvelope.rpcId, "reject");
    assert.deepEqual(await second, { outcome: "rejected" });
  });

  it("rejects an approval for a session that is not part of the task", async () => {
    const h = await harness({ prompt: "scope check" });
    const runtime = h.created[0]!;
    await assert.rejects(runtime.requestApproval({ sessionId: "other-session", toolName: "shell" }), /not a verified member/);
  });

  it("cancels an approval on timeout without granting it", async () => {
    const h = await harness({ prompt: "slow approval", env: { DSH_APPROVAL_TIMEOUT_MS: "30" } });
    const runtime = h.created[0]!;
    const outcome = await runtime.requestApproval({ sessionId: h.sessionId, toolName: "shell" });
    assert.deepEqual(outcome, { outcome: "cancelled" });
    assert.equal(h.client.pendingForTask(h.taskId).length, 0);
  });

  it("answers a native user question, validates the shape, and drops late answers", async () => {
    const h = await harness({ prompt: "ask me" });
    const runtime = h.created[0]!;
    const questions = [{ id: "q1", question: "Which environment?", options: [{ label: "staging" }, { label: "prod" }] }];
    const pending = runtime.requestUserQuestion({ requestId: "q1", sessionId: h.sessionId, questions });
    await waitFor(() => h.client.pendingForTask(h.taskId).length === 1);
    const envelope = h.client.pendingForTask(h.taskId)[0]!;
    assert.equal(envelope.payload.type, "question/requested");

    await assert.rejects(
      h.client.answerQuestion(h.taskId, "q1", [{ id: "unknown", selected: ["staging"] }]),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "invalid-answer",
    );
    await assert.rejects(
      h.client.answerQuestion(h.taskId, "q1", []),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "invalid-answer",
    );
    const resolved = await h.client.answerQuestion(h.taskId, "q1", [{ id: "q1", selected: ["staging"] }]);
    assert.equal(resolved.accepted, true);
    assert.deepEqual(await pending, { answers: [{ id: "q1", selected: ["staging"] }] });
    await assert.rejects(
      h.client.answerQuestion(h.taskId, "q1", [{ id: "q1", selected: ["staging"] }]),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "not-pending",
    );

    const controller = new AbortController();
    const cancelled = runtime.requestUserQuestion(
      { requestId: "q2", sessionId: h.sessionId, questions: [{ id: "q2", question: "Proceed?" }] },
      controller.signal,
    );
    await waitFor(() => h.client.pendingForTask(h.taskId).length === 1);
    controller.abort();
    assert.deepEqual(await cancelled, { cancelled: true });
    assert.equal(h.client.pendingForTask(h.taskId).length, 0);
  });

  it("resumes the exact session after a bridge restart", async () => {
    let promptCount = 0;
    const h = await harness({
      prompt: "first",
      script: {
        onPrompt: (runtime, sessionId, text) => {
          promptCount += 1;
          if (promptCount === 1) completeTurn(runtime, sessionId, text);
        },
      },
    });
    await eventTypes(h.client, { taskId: h.taskId, sessionId: h.sessionId }, 4);
    await h.client.close();
    // A restarted bridge takes ownership only because the previous owner
    // recorded a clean shutdown, then restores the exact persisted session.
    const { factory, created } = fakeRuntimeFactory({ onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text) });
    const restarted = createSdkDshApi(h.config, h.config.sdk!, {
      clientFactory: factory,
      bridgeInstanceId: "restarted-bridge",
      logger: () => undefined,
    });
    cleanups.push(async () => restarted.close());
    const resumed = await restarted.sessionPrompt({
      sessionId: h.sessionId,
      mode: "queue",
      content: [{ type: "text", text: "second" }],
    });
    assert.equal(resumed.accepted, true);
    const second = created[0];
    assert.ok(second !== undefined, "a new runtime is created for the follow-up");
    assert.equal(second.calls.includes("resumeSession"), true);
    assert.deepEqual(second.resumed, [h.sessionId]);
  });

  it("blocks a follow-up when the observation record has an unrepaired gap", async () => {
    const h = await harness({
      prompt: "first",
      script: { onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text) },
    });
    await eventTypes(h.client, { taskId: h.taskId, sessionId: h.sessionId }, 4);
    await new SdkObservedEventStore(h.config.homeDir).degrade(h.taskId, "corruption", "simulated crash mid-turn");
    await assert.rejects(
      h.client.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: [{ type: "text", text: "again" }] }),
      (error: unknown) => error instanceof SdkBackendError && error.code === "observation_gap" && error.retryable === false,
    );
  });

  it("refuses a second bridge owner instead of taking over an unproven runtime", async () => {
    const h = await harness({
      prompt: "owner",
      script: { onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text) },
    });
    await eventTypes(h.client, { taskId: h.taskId, sessionId: h.sessionId }, 4);
    const other = createSdkDshApi(h.config, h.config.sdk!, {
      clientFactory: fakeRuntimeFactory().factory,
      bridgeInstanceId: "another-bridge",
      logger: () => undefined,
    });
    cleanups.push(async () => other.close());
    await assert.rejects(
      other.sessionPrompt({ sessionId: h.sessionId, mode: "queue", content: [{ type: "text", text: "steal" }] }),
      (error: unknown) => error instanceof SdkBackendError && error.code === "runtime_owner_conflict",
    );
  });

  it("reports the fixed route, bridge titles, and a bridge-owned catalog", async () => {
    const h = await harness({
      prompt: "title me",
      script: { onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text) },
    });
    await eventTypes(h.client, { taskId: h.taskId, sessionId: h.sessionId }, 4);
    const route = await h.client.routeInfo(h.sessionId);
    assert.equal(route.source, "sdk-initialize");
    assert.equal(route.catalogAvailable, false);
    assert.equal(route.provider, "deepseek-official");
    assert.equal(route.model, "deepseek-v4-flash");

    await h.client.recordTaskTitle(h.taskId, "Bridge title");
    const catalog = await h.client.bridgeCatalog();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]?.taskId, h.taskId);
    assert.equal(catalog[0]?.title, "Bridge title");
    assert.equal(catalog[0]?.titleSource, "bridge");
    assert.equal(catalog[0]?.running, false);
    assert.equal(catalog[0]?.observation.complete, true);
  });

  it("keeps lineage and subagent history scoped to verified observations", async () => {
    const h = await harness({ prompt: "children" });
    const runtime = h.created[0]!;
    runtime.emitSubagentStarted(h.sessionId, "child-1");
    runtime.emitEvent("child-1", { type: "turn/start", seq: 1, data: { turn: 1 } });
    runtime.emitEvent("child-1", {
      type: "assistant/message",
      seq: 2,
      data: { message: { content: [{ type: "text", text: "child answer" }] } },
    });
    runtime.emitSubagentFinished(h.sessionId, "child-1");
    await waitFor(() => (h.client.taskStateSync(h.taskId)?.lineage.size ?? 0) === 2);
    await waitFor(() => (h.client.taskStateSync(h.taskId)?.observedEvents ?? 0) >= 2);

    const childHistory = await h.client.subagentHistory({ parentSessionId: h.sessionId, childSessionId: "child-1", mode: "one-shot" });
    assert.equal(childHistory.events.length, 2);
    await assert.rejects(
      h.client.subagentHistory({ parentSessionId: h.sessionId, childSessionId: "unknown-child", mode: "one-shot" }),
      (error: unknown) => error instanceof SdkBackendError && error.code === "backend_mismatch",
    );
  });

  it("closes idempotently and reaps every runtime it owns", async () => {
    const h = await harness({ prompt: "close me" });
    assert.equal(h.created.length, 1);
    await h.client.close();
    await h.client.close();
    assert.equal(h.created[0]?.closed, true);
    assert.deepEqual(h.client.runtimeSnapshots(), []);
  });

  it("marks an unclean runtime exit as an observation gap instead of success", async () => {
    const h = await harness({
      prompt: "crash",
      script: {
        onPrompt: (runtime, sessionId, text) => {
          runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: { turn: 1 } });
          void text;
        },
      },
    });
    await waitFor(() => (h.client.taskStateSync(h.taskId)?.observedEvents ?? 0) >= 1);
    const runtime = h.created[0]!;
    runtime.script.closeError = new Error("shutdown exceeded");
    await h.client.close();
    const coverage = await new SdkObservedEventStore(h.config.homeDir).coverage(h.taskId);
    assert.equal(coverage.complete, false);
    assert.ok(coverage.gaps.length > 0);
    const ledger = await h.client.ledgerSnapshot(h.taskId);
    assert.equal(ledger.execution, "interrupted");
  });
});
