/**
 * Read-only check of one SDK task through the MCP bridge: execution, cursor,
 * session identity, and whether the expected follow-up text landed. Prints no
 * assistant text.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.env.CS_HOME;
const taskId = process.env.CS_TASK;
const needle = process.env.CS_NEEDLE ?? "脚本已收到结果";
if (home === undefined || taskId === undefined) {
  console.error("CS_HOME and CS_TASK are required");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(process.cwd(), "dist", "index.js")],
  env: { ...process.env, DSH_HOST_PROTOCOL: "sdk", DSH_HOME: home },
  stderr: "ignore",
});
const client = new Client({ name: "coworker-status-check", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  try { return JSON.parse(text); } catch { return { unparsed: true }; }
};

const status = await call("dsh_status", { taskId });
const tail = await call("dsh_tail", { taskId, maxEvents: 400 });
const events = Array.isArray(tail.events) ? tail.events : [];
const textOf = (event) => JSON.stringify(event?.data ?? {});
const userEvents = events.filter((event) => (event?.type ?? "").includes("user/message"));
const needleSeen = userEvents.some((event) => textOf(event).includes(needle));

console.log(JSON.stringify({
  taskId,
  execution: status.execution ?? null,
  rootSessionIdPrefix: typeof status.rootSessionId === "string" ? `${status.rootSessionId.slice(0, 8)}…` : null,
  cursor: status.cursor ?? null,
  finalMessageLength: typeof status.finalMessage === "string" ? status.finalMessage.length : 0,
  observationComplete: status.observation?.complete ?? null,
  eventCount: events.length,
  userMessageEvents: userEvents.length,
  followUpTextSeen: needleSeen,
}, null, 2));
await client.close().catch(() => undefined);
