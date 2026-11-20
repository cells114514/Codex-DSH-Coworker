#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeService } from "./bridge-service.js";
import { loadConfig } from "./config.js";
import { DshConnectionManager, type DshConnection } from "./connection-manager.js";
import { createDshApi } from "./dsh-api-factory.js";
import { EventLedger } from "./event-ledger.js";
import { configuredHostLabel } from "./host-endpoint.js";
import { createMcpServer } from "./mcp-server.js";
import { isSdkDshClient, SdkConnectionAdapter } from "./sdk-connection-adapter.js";
import { TaskStore } from "./task-store.js";

async function main() {
  const config = loadConfig();
  const api = createDshApi(config);
  const tasks = new TaskStore(config.homeDir);
  const ledger = new EventLedger(config.homeDir);
  // The SDK backend has no Host connection to supervise: its DshConnection is
  // served from bridge-owned observation, and it starts no runtime here.
  const connection: DshConnection = isSdkDshClient(api)
    ? new SdkConnectionAdapter({ tasks, client: api })
    : new DshConnectionManager(config, api, tasks, ledger);
  const service = new BridgeService(config, api, tasks, connection, ledger);
  // Gateway tasks are attributed from the durable session stream, inside the same
  // observation loop that already records events, so no caller polling is needed.
  connection.attachCompletionObserver?.((taskId, event) => {
    try {
      service.onGatewaySessionEvent(taskId, event);
    } catch {
      // Tracking must never break observation.
    }
  });
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async () => {
    shutdownPromise ??= (async () => {
      await connection.stop().catch(() => undefined);
      // `close` may be asynchronous (SDK runtime teardown); awaiting it is what
      // guarantees owned runtime processes are reaped before the bridge exits.
      await Promise.resolve(api.close?.()).catch((error: unknown) => {
        console.error(`[dsh-agentlink] backend close failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      await server.close().catch(() => undefined);
    })();
    await shutdownPromise;
  };

  transport.onclose = () => {
    void shutdown();
  };
  process.stdin.once("end", () => {
    void shutdown();
  });
  process.stdin.once("close", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  connection.start();
  await server.connect(transport);
  console.error(
    `[dsh-agentlink] connect-only MCP ready; backend ${config.hostProtocol ?? "legacy"}; configured target ${configuredHostLabel(config)}`,
  );
}

void main().catch((error) => {
  console.error(`[dsh-agentlink] fatal: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  process.exitCode = 1;
});
