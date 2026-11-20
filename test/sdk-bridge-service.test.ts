import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { BridgeService } from "../src/bridge-service.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { EventLedger } from "../src/event-ledger.js";
import { createSdkDshApi, type SdkDshClient } from "../src/sdk-dsh-client.js";
import { SdkConnectionAdapter } from "../src/sdk-connection-adapter.js";
import { SdkBackendError } from "../src/sdk-errors.js";
import { TaskStore } from "../src/task-store.js";
import { completeTurn, fakeRuntimeFactory, waitFor, type FakeSdkRuntime, type FakeSdkRuntimeScript } from "./support/fake-sdk-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface System {
  root: string;
  config: BridgeConfig;
  api: SdkDshClient;
  tasks: TaskStore;
  service: BridgeService;
  created: FakeSdkRuntime[];
  cwd: string;
  /** The path the caller passed, before canonicalization. */
  requestedCwd: string;
}

async function system(script: FakeSdkRuntimeScript = {}): Promise<System> {
  const root = await mkdtemp(join(tmpdir(), "sdk-bridge-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  const config = loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: join(root, "dsh-home"),
    DSH_BRIDGE_HOME: join(root, "bridge-home"),
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
    DSH_APPROVAL_TIMEOUT_MS: "5000",
  });
  const { factory, created } = fakeRuntimeFactory(script);
  const api = createSdkDshApi(config, config.sdk!, { clientFactory: factory, logger: () => undefined });
  const tasks = new TaskStore(config.homeDir);
  const ledger = new EventLedger(config.homeDir);
  const connection = new SdkConnectionAdapter({ tasks, client: api });
  const service = new BridgeService(config, api, tasks, connection, ledger);
  cleanups.push(async () => {
    await connection.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, config, api, tasks, service, created, cwd: await realpath(cwd), requestedCwd: cwd };
}

const streamingScript: FakeSdkRuntimeScript = {
  onPrompt: (runtime, sessionId, text) => {
    const seq = (runtime.prompts.length - 1) * 4;
    runtime.emitEvent(sessionId, { type: "turn/start", seq: seq + 1, data: { turn: runtime.prompts.length } });
    runtime.emitEvent(sessionId, {
      type: "user/message",
      seq: seq + 2,
      data: { content: [{ type: "text", text }], role: "user" },
    });
    runtime.emitEvent(sessionId, {
      type: "assistant/message",
      seq: seq + 3,
      data: { message: { content: [{ type: "text", text: `done: ${text}` }] } },
    });
    runtime.emitEvent(sessionId, { type: "turn/end", seq: seq + 4, data: { turn: runtime.prompts.length, reason: { kind: "completed" } } });
    runtime.emitStatus(sessionId, "idle");
  },
};

async function delegate(s: System, prompt = "implement the change") {
  const result = await s.service.delegate({ prompt, cwd: s.cwd, waitSeconds: 0 });
  await waitFor(() => (s.api.taskStateSync(result.taskId)?.observedEvents ?? 0) >= 4);
  return result;
}

describe("sdk bridge service", () => {
  it("delegates, observes, and reads the final reply from the bridge's own record", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    assert.equal(delegated.accepted, true);
    assert.equal(delegated.backend ?? "sdk", "sdk");
    assert.equal(delegated.baseUrl, null, "no Host URL is fabricated");
    assert.equal(delegated.titleSource, "bridge");
    assert.equal(delegated.model.provider, "deepseek-official");
    assert.equal(delegated.model.model, "deepseek-v4-flash");
    assert.equal(delegated.modelRouting.mode, "fixed");
    assert.equal(delegated.modelRouting.catalogAvailable, false);
    assert.match(delegated.issuedRpcId ?? "", /^sdk-prompt-1-/);

    const status = await s.service.status(delegated.taskId);
    assert.equal(status.backend, "sdk");
    assert.equal(status.transport, "stdio-jsonrpc");
    assert.equal(status.capabilities.historySource, "observed-cache");
    assert.equal(status.capabilities.authoritativeHistory, false);
    assert.equal(status.runtime?.state, "ready");
    assert.equal(status.execution, "turn_completed");
    assert.equal(status.finalMessage, "done: implement the change");
    assert.equal(status.finalMessageStatus, "available");
    assert.equal(status.observation?.complete, true);
    assert.equal(status.observation?.observedSource, "observed-cache");
    assert.equal(status.queueDepth.known, false, "an unsupported queue is unknown, not empty");
    assert.equal(status.lineage[0]?.historyCapability, "observed-cache");
  });

  it("continues the same task with the recorded fixed route and a time-zone disclosure", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s, "first");
    const followup = await s.service.continueTask(delegated.taskId, "second");
    assert.equal(followup.accepted, true);
    assert.equal(followup.mode, "queue");
    assert.equal(followup.modelRouting.mode, "fixed");
    assert.equal(followup.messageId, "message-2");
    assert.equal(followup.messageIdSource, "sdk-durable-inbox");
    assert.deepEqual(followup.clientTimeZone, {
      applied: false,
      reason: "this backend cannot transmit a caller time zone on its wire; the runtime profile's own time zone applies",
    });
    await waitFor(() => (s.api.taskStateSync(delegated.taskId)?.messageIds.length ?? 0) === 2);
    await waitFor(() => (s.api.taskStateSync(delegated.taskId)?.observedEvents ?? 0) >= 8);
    const status = await s.service.status(delegated.taskId);
    assert.equal(status.finalMessage, "done: second");
  });

  it("preserves SDK recovery and uncertain-receipt errors instead of masking them with a catalog TypeError", async () => {
    const s = await system(streamingScript);
    const task = await delegate(s);
    for (const code of ["runtime_owner_conflict", "runtime_identity_mismatch", "session_resume_failed", "observation_gap", "prompt_outcome_unknown"] as const) {
      const failure = new SdkBackendError(code, "test failure", {
        retryable: false, suggestion: "inspect before retrying", taskId: task.taskId,
      });
      let calls = 0;
      s.api.sessionPrompt = async () => { calls++; throw failure; };
      await assert.rejects(s.service.continueTask(task.taskId, "continue"), (error: unknown) => error === failure);
      assert.equal(calls, 1, "the bridge never retries a rejected or uncertain submission");
    }
    assert.equal(s.created[0]!.prompts.length, 1, "only the original delegation reached the runtime");
  });

  it("restores a persisted SDK task through a fresh bridge without needing a model catalog", async () => {
    const s = await system(streamingScript);
    const task = await delegate(s, "original");
    await s.api.close();
    const { factory, created } = fakeRuntimeFactory({
      onPrompt: (runtime, sessionId, text) => completeTurn(runtime, sessionId, text, 5),
    });
    const api = createSdkDshApi(s.config, s.config.sdk!, { clientFactory: factory, logger: () => undefined });
    const tasks = new TaskStore(s.config.homeDir);
    const ledger = new EventLedger(s.config.homeDir);
    const connection = new SdkConnectionAdapter({ tasks, client: api });
    const service = new BridgeService(s.config, api, tasks, connection, ledger);
    try {
      const result = await service.continueTask(task.taskId, "continue after restart");
      assert.equal(result.taskId, task.taskId);
      assert.equal(result.rootSessionId, task.rootSessionId);
      assert.equal(result.modelRouting.mode, "fixed");
      assert.equal(result.accepted, true);
      assert.deepEqual(created[0]!.resumed, [task.rootSessionId]);
      assert.equal(created[0]!.prompts.length, 1, "only the new input is submitted, without replay");
    } finally { await api.close(); }
  });

  it("explicitly restores an orphan without sending a prompt or fabricating its prior clean exit", async () => {
    const s = await system(streamingScript);
    const task = await delegate(s);
    await s.api.close();
    const recordPath = join(s.config.homeDir, "runtimes", `${task.taskId}.json`);
    const original = JSON.parse(await readFile(recordPath, "utf8"));
    original.cleanShutdown = false;
    delete original.cleanShutdownAt;
    original.owner = { ...original.owner, pid: 2147483647, bridgeInstanceId: "dead-test-owner" };
    await writeFile(recordPath, JSON.stringify(original));
    const { factory, created } = fakeRuntimeFactory();
    const api = createSdkDshApi(s.config, s.config.sdk!, { clientFactory: factory, logger: () => undefined });
    try {
      const result = await api.recoverTask(task.taskId, {
        ownerInstanceId: original.owner.bridgeInstanceId, updatedAt: original.updatedAt,
      });
      assert.equal(result.rootSessionId, task.rootSessionId);
      assert.equal(result.promptSubmitted, false);
      assert.deepEqual(created[0]!.resumed, [task.rootSessionId]);
      assert.equal(created[0]!.prompts.length, 0);
      const backup = JSON.parse(await readFile(result.backupPath, "utf8"));
      assert.equal(backup.previousRecord.cleanShutdown, false);
      const active = JSON.parse(await readFile(recordPath, "utf8"));
      assert.equal(active.cleanShutdown, false);
      assert.equal(active.observationEpoch, original.observationEpoch + 1);
    } finally { await api.close(); }
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).cleanShutdown, true);
  });

  it("lists only bridge-owned tasks and refuses Desktop-style attach", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    const found = await s.service.findSessions({});
    assert.equal(found.scope, "bridge-owned");
    assert.equal(found.sessions.length, 1);
    assert.equal(found.sessions[0]?.taskId, delegated.taskId);
    assert.equal(found.sessions[0]?.cwd, s.cwd);
    assert.equal(found.attachable, false);
    assert.match(found.freshness, /not an upstream freshness signal/);

    await assert.rejects(
      s.service.attachSession({
        sessionId: delegated.rootSessionId,
        expectedUpdatedAt: 1,
        expectedCwd: s.cwd,
        expectedTitle: null,
      }),
      (error: unknown) => error instanceof SdkBackendError && error.code === "unsupported_capability",
    );
  });

  it("refuses turn and queue cancel without closing the runtime", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    for (const scope of ["turn", "queue"] as const) {
      await assert.rejects(
        s.service.cancel(delegated.taskId, scope),
        (error: unknown) => error instanceof SdkBackendError && error.code === "unsupported_capability",
      );
    }
    assert.equal(s.api.taskStateSync(delegated.taskId)?.phase === "unknown", false);
    assert.equal(s.api.runtimeSnapshots()[0]?.state, "ready", "the runtime is not closed as a cancel substitute");
  });

  it("answers an approval through the bridge with a live workspace claim", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    const runtime = s.created[0]!;
    const pending = runtime.requestApproval({ sessionId: delegated.rootSessionId, toolName: "shell" });
    await waitFor(() => s.api.pendingForTask(delegated.taskId).length === 1);
    const status = await s.service.status(delegated.taskId);
    assert.equal(status.pendingInteractions.length, 1);
    assert.equal(status.execution, "awaiting_approval");

    const requestId = s.api.pendingForTask(delegated.taskId)[0]!.rpcId;
    const resolved = await s.service.resolveApproval(delegated.taskId, requestId, "allow_once");
    assert.deepEqual(resolved, { accepted: true, requestId, outcome: "allowed-once" });
    assert.deepEqual(await pending, { outcome: "allowed-once" });
    const after_ = await s.service.status(delegated.taskId);
    assert.equal(after_.pendingInteractions.length, 0);
  });

  it("answers a native user question through the bridge", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    const runtime = s.created[0]!;
    const pending = runtime.requestUserQuestion({
      requestId: "q-1",
      sessionId: delegated.rootSessionId,
      questions: [{ id: "q-1", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }],
    });
    await waitFor(() => s.api.pendingForTask(delegated.taskId).length === 1);
    const answered = await s.service.answerQuestion(delegated.taskId, "q-1", [{ id: "q-1", selected: ["yes"] }]);
    assert.deepEqual(answered, { accepted: true, requestId: "q-1" });
    assert.deepEqual(await pending, { answers: [{ id: "q-1", selected: ["yes"] }] });
  });

  it("hydrates tail digests from the observed cache", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    const tail = await s.service.tail(delegated.taskId);
    assert.equal(tail.contentSource.includes("observed"), true);
    const assistant = tail.events.find((event) => JSON.stringify(event.digest).includes("done: implement the change"));
    assert.ok(assistant !== undefined, "the final assistant text is present in the tail digest");
  });

  it("waits for the observed turn to end", async () => {
    const s = await system(streamingScript);
    const delegated = await s.service.delegate({ prompt: "wait for me", cwd: s.cwd, waitSeconds: 0 });
    const waited = await s.service.wait(delegated.taskId, 5);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.status.execution, "turn_completed");
  });

  it("watches through ordinary log traffic without returning conversation bodies", async () => {
    const s = await system({ onPrompt: (runtime, sessionId) => {
      runtime.emitStatus(sessionId, "running");
      runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: { turn: 1 } });
    } });
    const task = await s.service.delegate({ prompt: "work", cwd: s.cwd });
    let returned = false;
    const watched = s.service.watch(task.taskId, 5).then((result) => { returned = true; return result; });
    const runtime = s.created[0]!;
    for (let seq = 2; seq <= 8; seq++) {
      runtime.emitEvent(task.rootSessionId, { type: "tool/result", seq, data: { result: "PRIVATE_LOG_TEXT" } });
    }
    await waitFor(() => (s.api.taskStateSync(task.taskId)?.observedEvents ?? 0) >= 8);
    assert.equal(returned, false, "ordinary logs do not wake the model supervising this task");
    completeTurn(runtime, task.rootSessionId, "PRIVATE_FINAL_TEXT", 9);
    const result = await watched;
    assert.equal(result.reason, "terminal");
    assert.equal(result.execution, "turn_completed");
    assert.equal(result.timedOut, false);
    assert.equal("status" in result, false, "no full status envelope per wait");
    assert.ok(JSON.stringify(result).length < 1000);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|logPath|lineage/);
    assert.equal((await s.service.status(task.taskId)).finalMessage, "answer to PRIVATE_FINAL_TEXT");
  });

  it("returns a compact timeout without marking the task failed", async () => {
    const s = await system({ onPrompt: (runtime, sessionId) => {
      runtime.emitStatus(sessionId, "running");
      runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
    } });
    const task = await s.service.delegate({ prompt: "work", cwd: s.cwd });
    const result = await s.service.watch(task.taskId, 1);
    assert.equal(result.reason, "timeout");
    assert.equal(result.execution, "running");
    assert.equal(result.timedOut, true);
    assert.match(result.nextAction, /Repeat dsh_watch/);
  });

  it("wakes the watcher for an approval without granting it", async () => {
    const s = await system();
    const task = await s.service.delegate({ prompt: "work", cwd: s.cwd });
    const watched = s.service.watch(task.taskId, 5);
    const pending = s.created[0]!.requestApproval({ sessionId: task.rootSessionId, toolName: "shell" });
    const result = await watched;
    assert.equal(result.reason, "interaction");
    assert.equal(result.pendingCount, 1);
    const requestId = s.api.pendingForTask(task.taskId)[0]!.rpcId;
    await s.service.resolveApproval(task.taskId, requestId, "reject");
    assert.deepEqual(await pending, { outcome: "rejected" });
  });

  it("wakes the watcher when runtime loss degrades observation", async () => {
    const s = await system();
    const task = await s.service.delegate({ prompt: "work", cwd: s.cwd });
    const watched = s.service.watch(task.taskId, 5);
    await s.created[0]!.close();
    const result = await watched;
    assert.equal(result.reason, "observation_gap");
    assert.equal(result.observationComplete, false);
    assert.equal(result.timedOut, false);
  });

  it("keeps two tasks' events and runtimes isolated", async () => {
    const s = await system(streamingScript);
    const first = await delegate(s, "first task");
    const secondCwd = join(s.root, "workspace-two");
    await mkdir(secondCwd, { recursive: true });
    const second = await s.service.delegate({ prompt: "second task", cwd: secondCwd, waitSeconds: 0 });
    assert.notEqual(first.taskId, second.taskId);
    assert.equal(s.created.length, 2, "one runtime per root task");
    await waitFor(() => (s.api.taskStateSync(second.taskId)?.observedEvents ?? 0) >= 4);

    const firstHistory = await s.api.readHistory(first.taskId, first.rootSessionId, { maxMessages: 50 });
    const secondHistory = await s.api.readHistory(second.taskId, second.rootSessionId, { maxMessages: 50 });
    assert.ok(JSON.stringify(firstHistory.events).includes("first task"));
    assert.equal(JSON.stringify(firstHistory.events).includes("second task"), false);
    assert.ok(JSON.stringify(secondHistory.events).includes("second task"));
    const firstStatus = await s.service.status(first.taskId);
    assert.equal(firstStatus.finalMessage, "done: first task");
  });

  it("rejects routing inputs the backend cannot honor before sending a prompt", async () => {
    const s = await system(streamingScript);
    for (const input of [
      { prompt: "p", cwd: s.cwd, modelProfile: "pro" as const },
      { prompt: "p", cwd: s.cwd, agentPreset: "code" },
      { prompt: "p", cwd: s.cwd, reasoningEffort: "high" },
      { prompt: "p", cwd: s.cwd, visualIntent: "required" as const, complexity: "low" as const },
    ]) {
      await assert.rejects(
        s.service.delegate(input),
        (error: unknown) => error instanceof SdkBackendError && error.code === "unsupported_capability",
      );
    }
    assert.equal(s.created.length, 0, "no runtime and no prompt for rejected routing");
  });

  it("rejects steer placement", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    await assert.rejects(
      s.service.continueTask(delegated.taskId, "steer me", "steer"),
      (error: unknown) => error instanceof SdkBackendError && error.code === "unsupported_capability" && error.details.capability === "steer",
    );
  });

  it("requires a workspace claim before an SDK follow-up", async () => {
    const s = await system(streamingScript);
    const delegated = await delegate(s);
    await s.service.releaseWorkspace(delegated.taskId);
    await assert.rejects(
      s.service.continueTask(delegated.taskId, "after release"),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "workspace_claim_missing",
    );
  });

  it("reports backend capabilities through host status without a Host URL", async () => {
    const s = await system();
    const status = await s.service.hostStatus();
    assert.equal(status.backend, "sdk");
    assert.equal(status.transport, "stdio-jsonrpc");
    assert.equal(status.lifecycleOwnership, "bridge-managed-runtime");
    assert.equal("startCommand" in status, false);
    assert.equal(status.sdk?.maxRuntimes, 2);
    assert.match(status.sdk?.credentialSource ?? "", /never reads, copies, or writes/);
  });
});
