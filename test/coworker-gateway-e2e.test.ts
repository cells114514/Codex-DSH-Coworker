/**
 * End-to-end Gateway completion through the real MCP surface.
 *
 * The fake Host stands in for DSH Desktop: it answers the discovery/attach/prompt
 * contract, then emits the durable events for the turn that consumed the bridge's
 * submission. The caller never calls dsh_status, dsh_watch or dsh_tail; the outbox
 * record must appear on its own, and the queue stub must deliver it exactly once.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { hostBackendCapabilities } from "../src/backend-capabilities.js";
import { BridgeService } from "../src/bridge-service.js";
import { loadConfig } from "../src/config.js";
import type { DshConnection } from "../src/connection-manager.js";
import { attachDshUnaryMetadata } from "../src/dsh-types.js";
import { EventLedger } from "../src/event-ledger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { TaskStore } from "../src/task-store.js";
import { WorkspaceClaimStore } from "../src/workspace-claim.js";

const THREAD = "11111111-2222-4333-8444-555555555555";
const SESSION = "11111111-1111-4111-8111-111111111111";
const REQUEST = "req-bridge-1";
const MESSAGE = "44444444-5555-4666-8777-888888888888";
const cleanups = [];
// A stable timestamp: discovery and attach must see the same metadata.
const UPDATED_AT = Date.now();

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const modelCatalog = { current: { provider: "deepseek-official", model: "deepseek-v4.1-flash" }, default: { provider: "deepseek-official", model: "deepseek-v4.1-flash" }, routable: true, groups: [], failures: [] };

function fakeHost(dshHome: string, cwd: string) {
  const calls = [];
  const events = [];
  let seq = 5;
  let emitBeforeReceipt: (() => void) | undefined;
  const api = {
    backend: "gateway",
    capabilities: hostBackendCapabilities("gateway"),
    calls,
    events,
    async hostDescribe() {
      calls.push("hostDescribe");
      return attachDshUnaryMetadata({ version: "0.2.1-rc.2", dshHome, profile: "gateway" }, { issuedRpcId: "r1", method: "host.describe" });
    },
    async sessionList() {
      calls.push("sessionList");
      return attachDshUnaryMetadata({ items: [{ sessionId: SESSION, updatedAt: UPDATED_AT, cwd, title: "简单回复数字1", origin: "root", status: "idle" }] }, { issuedRpcId: "r2", method: "session.list" });
    },
    async sessionModels() {
      calls.push("sessionModels");
      return attachDshUnaryMetadata({ ...modelCatalog }, { issuedRpcId: "r3", method: "session.models" });
    },
    async routeInfo() {
      calls.push("routeInfo");
      return attachDshUnaryMetadata({ provider: "deepseek-official", model: "deepseek-v4.1-flash" }, { issuedRpcId: "r4", method: "route.info" });
    },
    beforePromptReceipt(emit: () => void) {
      emitBeforeReceipt = emit;
    },
    async sessionPrompt(_payload: unknown, _signal?: AbortSignal, beforeGatewaySend?: (requestId: string) => Promise<void>) {
      await beforeGatewaySend?.(REQUEST);
      calls.push("sessionPrompt");
      emitBeforeReceipt?.();
      return attachDshUnaryMetadata({ accepted: true, messageId: "msg-1" }, { issuedRpcId: REQUEST, method: "session.prompt" });
    },
    async sessionHistory() {
      calls.push("sessionHistory");
      return attachDshUnaryMetadata({ events: events.map((event) => ({ event })), hasMore: false }, { issuedRpcId: "r5", method: "session.history" });
    },
    async sessionRename() {
      return attachDshUnaryMetadata({ renamed: true }, { issuedRpcId: "r6", method: "session.rename" });
    },
    emit(event) {
      events.push(event);
      seq += 1;
      return event;
    },
  };
  return api;
}

function fakeConnection(rootSession) {
  const observers = [];
  return {
    start() {},
    async stop() {},
    snapshot: () => ({ availability: "connected", revision: 1, cursor: 0, task: null, sessions: [], pending: [] }),
    async trackTask() {},
    async refreshLineage() {},
    async reconcileTask() {},
    async readSessionHistory() {
      return { events: [], hasMore: false };
    },
    lineageForTask: () => [rootSession],
    pendingForTask: () => [],
    queueForSession: () => ({ items: [], revision: 0 }),
    async waitForTaskChange() {
      throw new Error("the callback path must not observe the task");
    },
    async answerQuestion() {
      throw new Error("unexpected answer");
    },
    async resolveApproval() {
      throw new Error("unexpected approval");
    },
    attachCompletionObserver(observer) {
      observers.push(observer);
    },
    emit(taskId, event) {
      for (const observer of observers) observer(taskId, event);
    },
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "gw-e2e-"));
  const dshHome = join(root, "dsh-home");
  const bridgeHome = join(root, "bridge-home");
  const cwd = join(root, "workspace");
  await mkdir(dshHome, { recursive: true });
  await mkdir(cwd);
  const config = loadConfig({
    DSH_HOST_PROTOCOL: "gateway",
    DSH_HOME: dshHome,
    DSH_BRIDGE_HOME: bridgeHome,
    DSH_REQUEST_TIMEOUT_MS: "5000",
  });
  const api = fakeHost(dshHome, cwd);
  const tasks = new TaskStore(config.homeDir);
  const ledger = new EventLedger(config.homeDir);
  const connection = fakeConnection({ sessionId: SESSION, origin: "root", found: true, running: false });
  const service = new BridgeService(config, api, tasks, connection as unknown as DshConnection, ledger, new WorkspaceClaimStore(config.homeDir));
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gw-e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const outbox = join(config.homeDir, "coworker-outbox");
  await mkdir(outbox, { recursive: true });
  await writeFile(join(outbox, ".sender-heartbeat"), `${process.pid} ${new Date().toISOString()}\n`, "utf8");
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { config, api, service, connection, client, outbox, tasks };
}

function parse(result) {
  const text = result.content.find((item) => item.type === "text").text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`tool result was not JSON: ${text.slice(0, 400)}`);
  }
}

async function readRecords(outbox) {
  const names = (await readdir(outbox).catch(() => [])).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(outbox, name), "utf8"))));
}

function runSender(outbox) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        resolve("docs/operator-tools/coworker-sender.mjs"),
        "--outbox", outbox,
        "--stub", resolve("docs/operator-tools/coworker-queue-stub.mjs"),
        "--once",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: { ...process.env, COWORKER_STUB_MESSAGE_ID: MESSAGE, COWORKER_STUB_RECEIPT_THREAD: THREAD, COWORKER_STUB_LOG: join(outbox, "stub.log") },
      },
    );
    child.on("exit", (code) => resolveRun(code));
  });
}

describe("gateway completion end to end", () => {
  it("writes and delivers one record without any observation tool call", async () => {
    const h = await harness();
    const sessions = parse(await h.client.callTool({ name: "dsh_find_sessions", arguments: {} }));
    const found = sessions.sessions?.[0];
    assert.equal(found?.sessionId, SESSION, JSON.stringify(sessions).slice(0, 300));

    const attached = parse(
      await h.client.callTool({
        name: "dsh_attach_session",
        arguments: {
          sessionId: SESSION,
          expectedUpdatedAt: found.updatedAt,
          expectedCwd: found.cwd,
          expectedTitle: found.title ?? null,
          allowBlank: true,
        },
      }),
    );
    const taskId = attached.taskId;
    assert.ok(taskId, JSON.stringify(attached).slice(0, 300));

    // The live Gateway opened the turn while its prompt receipt was still in flight.
    h.api.beforePromptReceipt(() => {
      const started = { type: "turn/start", seq: 6, data: { turn: 1 } };
      h.api.emit(started);
      h.connection.emit(taskId, started);
    });
    const followed = parse(
      await h.client.callTool({
        name: "dsh_followup",
        arguments: { taskId, prompt: "回复 2", mode: "queue", coworker: { threadId: THREAD, outboxDir: h.outbox } },
      }),
    );
    assert.equal(followed.coworker?.callbackReady, true, JSON.stringify(followed).slice(0, 400));

    // The later user event carries a durable request id but no explicit turn number.
    const message = { type: "user/message", seq: 7, data: { source: { rpcId: REQUEST }, content: [] } };
    const terminal = { type: "turn/end", seq: 9, data: { turn: 1, reason: { kind: "completed" } } };
    h.api.emit(message);
    h.connection.emit(taskId, message);
    h.api.emit({ type: "assistant/message", seq: 8, data: { turn: 1, message: { content: [{ type: "text", text: "2" }] } } });
    h.api.emit(terminal);
    h.connection.emit(taskId, terminal);
    await new Promise((done) => setTimeout(done, 80));

    const written = await readRecords(h.outbox);
    assert.equal(written.length, 1, JSON.stringify(written));
    assert.equal(written[0].executionId, "e1");
    assert.equal(written[0].threadId, THREAD);
    assert.equal(written[0].status, "pending");

    // The stub sender delivers exactly once and keeps the receipt identity.
    assert.equal(await runSender(h.outbox), 0);
    const delivered = (await readRecords(h.outbox)).filter((record) => record.taskId === taskId);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].status, "acknowledged");
    assert.equal(delivered[0].messageId, MESSAGE);
    assert.equal(delivered[0].threadId, THREAD);
    assert.equal(await runSender(h.outbox), 0);
    assert.equal((await readRecords(h.outbox)).filter((record) => record.taskId === taskId).length, 1, "no second delivery");

    const observed = h.api.calls.filter((call) => ["status", "watch", "tail"].includes(call));
    assert.deepEqual(observed, [], "the callback path must not observe the task");
  });

  it("re-checks a terminal whose reply is not yet readable", async () => {
    const h = await harness();
    const sessions = parse(await h.client.callTool({ name: "dsh_find_sessions", arguments: {} }));
    const found = sessions.sessions?.[0];
    const attached = parse(
      await h.client.callTool({
        name: "dsh_attach_session",
        arguments: {
          sessionId: SESSION,
          expectedUpdatedAt: found.updatedAt,
          expectedCwd: found.cwd,
          expectedTitle: found.title ?? null,
          allowBlank: true,
        },
      }),
    );
    const taskId = attached.taskId;
    await h.client.callTool({
      name: "dsh_followup",
      arguments: { taskId, prompt: "回复 3", mode: "queue", coworker: { threadId: THREAD, outboxDir: h.outbox } },
    });

    // Terminal arrives before the assistant message is readable.
    h.connection.emit(taskId, { type: "user/message", seq: 6, data: { turn: 1, source: { requestId: REQUEST } } });
    h.connection.emit(taskId, { type: "turn/end", seq: 7, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((done) => setTimeout(done, 60));
    assert.deepEqual(await readRecords(h.outbox), [], "no notification before the result is readable");

    // The reply becomes readable and a late terminal re-triggers the check.
    h.api.emit({ type: "assistant/message", seq: 8, data: { turn: 1, message: { content: [{ type: "text", text: "3" }] } } });
    h.connection.emit(taskId, { type: "turn/end", seq: 9, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((done) => setTimeout(done, 80));

    const written = await readRecords(h.outbox);
    assert.equal(written.length, 1, JSON.stringify(written));
    assert.equal(written[0].executionId, "e1");
    assert.equal(written[0].threadId, THREAD);
  });
  it("confirms a single terminal once the reply becomes readable later", async () => {
    const h = await harness();
    const sessions = parse(await h.client.callTool({ name: "dsh_find_sessions", arguments: {} }));
    const found = sessions.sessions?.[0];
    const attached = parse(
      await h.client.callTool({
        name: "dsh_attach_session",
        arguments: {
          sessionId: SESSION,
          expectedUpdatedAt: found.updatedAt,
          expectedCwd: found.cwd,
          expectedTitle: found.title ?? null,
          allowBlank: true,
        },
      }),
    );
    const taskId = attached.taskId;
    await h.client.callTool({
      name: "dsh_followup",
      arguments: { taskId, prompt: "回复 4", mode: "queue", coworker: { threadId: THREAD, outboxDir: h.outbox } },
    });

    // Exactly one terminal, and the reply is not readable yet.
    h.connection.emit(taskId, { type: "user/message", seq: 6, data: { turn: 1, source: { requestId: REQUEST } } });
    h.connection.emit(taskId, { type: "turn/end", seq: 7, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((done) => setTimeout(done, 60));
    assert.deepEqual(await readRecords(h.outbox), [], "no notification before the reply is readable");

    // The reply becomes readable; an assistant event alone must re-trigger the check.
    h.api.emit({ type: "assistant/message", seq: 8, data: { turn: 1, message: { content: [{ type: "text", text: "4" }] } } });
    h.connection.emit(taskId, { type: "assistant/message", seq: 8, data: { turn: 1, message: { content: [] } } });
    await new Promise((done) => setTimeout(done, 120));

    const written = (await readRecords(h.outbox)).filter((record) => record.taskId === taskId);
    assert.equal(written.length, 1, JSON.stringify(written));
    assert.equal(written[0].executionId, "e1");
    assert.equal(written[0].threadId, THREAD);

    // Still one record after further noise, and nothing observed the task.
    h.connection.emit(taskId, { type: "assistant/message", seq: 9, data: { turn: 1, message: { content: [] } } });
    await new Promise((done) => setTimeout(done, 80));
    assert.equal((await readRecords(h.outbox)).filter((record) => record.taskId === taskId).length, 1);
    assert.deepEqual(h.api.calls.filter((call) => ["status", "watch", "tail"].includes(call)), []);
  });
it("reports callbackReady for a gateway api that does not declare backend", async () => {
    const h = await harness();
    const outbox = join(h.config.homeDir, "coworker-outbox");
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, ".sender-heartbeat"), `${process.pid} ${new Date().toISOString()}\n`, "utf8");
    // The real Gateway client exposes capabilities but not `backend`.
    delete (h.api as { backend?: unknown }).backend;
    const sessions = parse(await h.client.callTool({ name: "dsh_find_sessions", arguments: {} }));
    const found = sessions.sessions?.[0];
    const attached = parse(
      await h.client.callTool({
        name: "dsh_attach_session",
        arguments: {
          sessionId: SESSION,
          expectedUpdatedAt: found.updatedAt,
          expectedCwd: found.cwd,
          expectedTitle: found.title ?? null,
          allowBlank: true,
        },
      }),
    );
    const followed = parse(
      await h.client.callTool({
        name: "dsh_followup",
        arguments: { taskId: attached.taskId, prompt: "回复 5", mode: "queue", coworker: { threadId: THREAD, outboxDir: outbox } },
      }),
    );
    assert.equal(followed.coworker?.callbackReady, true, JSON.stringify(followed).slice(0, 300));
  });
});
