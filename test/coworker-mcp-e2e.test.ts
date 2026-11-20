/**
 * End-to-end coworker field regression: the fake runtime is injected into a real
 * BridgeService, the tool is called through a real MCP client, and the response
 * is parsed exactly like the acceptance script parses it.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeService } from "../src/bridge-service.js";
import { loadConfig } from "../src/config.js";
import type { DshConnection } from "../src/connection-manager.js";
import { EventLedger } from "../src/event-ledger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createSdkDshApi } from "../src/sdk-dsh-client.js";
import { WorkspaceClaimStore } from "../src/workspace-claim.js";
import { TaskStore } from "../src/task-store.js";
import { fakeRuntimeFactory } from "./support/fake-sdk-runtime.js";

const THREAD = "11111111-2222-4333-8444-555555555555";
const cleanups = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Mirrors the acceptance script's parsing of a tool result. */
function parseToolResult(result) {
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

async function mcpHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cw-e2e-"));
  const dshHome = join(root, "dsh-home");
  const bridgeHome = join(root, "bridge-home");
  const workspace = join(root, "workspace");
  await mkdir(dshHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const config = loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: dshHome,
    DSH_BRIDGE_HOME: bridgeHome,
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
    DSH_APPROVAL_TIMEOUT_MS: "5000",
  });
  const { factory } = fakeRuntimeFactory({ onPrompt: (runtime, sessionId) => {
    runtime.emitEvent(sessionId, { type: "turn/start", seq: 1, data: {} });
    runtime.emitEvent(sessionId, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } });
    runtime.emitStatus(sessionId, "idle");
  } });
  const api = createSdkDshApi(config, config.sdk, { clientFactory: factory, logger: () => undefined });
  const tasks = new TaskStore(config.homeDir);
  const connection = { trackTask: async () => undefined, snapshot: async () => ({ task: null }), probe: async () => ({}) } as unknown as DshConnection;
  const ledger = new EventLedger(config.homeDir);
  const service = new BridgeService(config, api, tasks, connection, ledger, new WorkspaceClaimStore(config.homeDir));
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "cw-e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await api.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, workspace, client, bridgeHome };
}

async function writeHeartbeat(outbox, pid = process.pid) {
  await mkdir(outbox, { recursive: true });
  await writeFile(join(outbox, ".sender-heartbeat"), `${pid} ${new Date().toISOString()}\n`, "utf8");
}

describe("coworker fields survive MCP serialisation", () => {
  it("returns bindingSaved, senderReady and callbackReady on success", async () => {
    const h = await mcpHarness();
    const outbox = join(h.bridgeHome, "coworker-outbox");
    await writeHeartbeat(outbox);
    const parsed = parseToolResult(await h.client.callTool({
      name: "dsh_delegate",
      arguments: {
        prompt: "e2e",
        cwd: h.workspace,
        coworker: { threadId: THREAD, outboxDir: outbox },
      },
    }));
    assert.equal(parsed.coworker?.registered, true);
    assert.equal(parsed.coworker?.bindingSaved, true);
    assert.equal(parsed.coworker?.senderReady, true);
    assert.equal(parsed.coworker?.callbackReady, true);
    assert.equal(parsed.coworker?.threadId, THREAD);
  });

  it("reports callbackReady=false with the reason when no sender runs", async () => {
    const h = await mcpHarness();
    const outbox = join(h.bridgeHome, "coworker-outbox");
    const parsed = parseToolResult(await h.client.callTool({
      name: "dsh_delegate",
      arguments: {
        prompt: "e2e",
        cwd: h.workspace,
        coworker: { threadId: THREAD, outboxDir: outbox },
      },
    }));
    assert.equal(parsed.coworker?.bindingSaved, true);
    assert.equal(parsed.coworker?.senderReady, false);
    assert.equal(parsed.coworker?.callbackReady, false);
    assert.match(String(parsed.coworker?.advice), /not ready/);
  });

  it("reports a pre-prompt failure envelope without assuming success fields", async () => {
    const h = await mcpHarness();
    const outbox = join(h.bridgeHome, "coworker-outbox");
    await writeHeartbeat(outbox);
    // Deterministic post-binding failure: the claim path cannot be created.
    await writeFile(join(h.config.homeDir, "claims"), "not-a-directory", "utf8");
    const parsed = parseToolResult(await h.client.callTool({
      name: "dsh_delegate",
      arguments: {
        prompt: "e2e",
        cwd: h.workspace,
        coworker: { threadId: THREAD, outboxDir: outbox },
      },
    }));
    // Documented limitation: a generic pre-prompt failure envelope does not carry
    // the coworker block yet; only a workspace-claim conflict does. The envelope
    // must still name the failure instead of returning a half success payload.
    assert.ok(parsed.error !== undefined || parsed.code !== undefined, "the failure is named");
    assert.equal(parsed.accepted, undefined, "a failure must not look accepted");
  });});
