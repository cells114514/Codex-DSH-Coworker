/**
 * Create one short SDK task through the existing bridge and report its id.
 * Used only to produce a terminal event for the notifier verification.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.env.CT_HOME;
const bridge = process.env.CT_BRIDGE ?? resolve(process.cwd(), "dist", "index.js");
const prompt = process.env.CT_PROMPT ?? "Reply with exactly: COWORKER-TASK-OK";
if (home === undefined) {
  console.error("CT_HOME is required");
  process.exit(2);
}

const work = await mkdtemp(join(tmpdir(), "cw-task-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridge],
  env: {
    ...process.env,
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: home,
    DSH_REQUEST_TIMEOUT_MS: "300000",
    ...(process.env.CT_PROVIDER === undefined ? {} : { DSH_SDK_PROVIDER: process.env.CT_PROVIDER }),
    ...(process.env.CT_MODEL === undefined ? {} : { DSH_SDK_MODEL: process.env.CT_MODEL }),
  },
  stderr: "ignore",
});
const client = new Client({ name: "coworker-task", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  try { return JSON.parse(text); } catch { return { unparsed: true }; }
};

const delegated = await call("dsh_delegate", { prompt, cwd: work });
const taskId = delegated.taskId;
let status = {};
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  status = await call("dsh_status", { taskId });
  if (["turn_completed", "failed", "interrupted", "canceled"].includes(status.execution)) break;
  await new Promise((done) => setTimeout(done, 1_000));
}
console.log(JSON.stringify({
  taskId,
  execution: status.execution ?? null,
  finalMessageLength: typeof status.finalMessage === "string" ? status.finalMessage.length : 0,
  workspace: work,
}, null, 2));
await client.close().catch(() => undefined);
