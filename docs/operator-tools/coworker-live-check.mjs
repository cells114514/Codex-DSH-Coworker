/**
 * One bounded live check of the callback chain, with no observation calls.
 *
 * Sequence: start the sender (background), delegate one short task with a
 * coworker binding, then wait for the sender to deliver the completion
 * notification. dsh_status / dsh_watch / dsh_tail are never called after the
 * dispatch, which is the point of the test.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.env.LIVE_HOME;
const bridge = process.env.LIVE_BRIDGE ?? resolve("dist-cw/index.js");
const kernel = process.env.LIVE_KERNEL;
const threadId = process.env.LIVE_THREAD;
const provider = process.env.LIVE_PROVIDER ?? "opencode-go";
const model = process.env.LIVE_MODEL ?? "deepseek-v4.1-flash";
if ([home, kernel, threadId].some((value) => value === undefined)) {
  console.error("LIVE_HOME, LIVE_KERNEL and LIVE_THREAD are required");
  process.exit(2);
}

const bridgeHome = join(home, "codex-bridge-sdk");
const outbox = join(bridgeHome, "coworker-outbox");
await rm(outbox, { recursive: true, force: true }).catch(() => undefined);
const work = await mkdtemp(join(tmpdir(), "cw-live-"));

const sender = spawn(process.execPath, [resolve("docs/operator-tools/coworker-sender.mjs"), "--outbox", outbox, "--kernel", kernel, "--interval", "2"], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  shell: false,
  detached: false,
});
sender.stdout.on("data", () => {});
sender.stderr.on("data", () => {});
await new Promise((done) => setTimeout(done, 2_500));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridge],
  env: {
    ...process.env,
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: home,
    DSH_BRIDGE_HOME: bridgeHome,
    DSH_REQUEST_TIMEOUT_MS: "300000",
    DSH_SDK_PROVIDER: provider,
    DSH_SDK_MODEL: model,
    DSH_SDK_IDLE_TIMEOUT_MS: "0",
  },
  stderr: "ignore",
});
const client = new Client({ name: "coworker-live", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const delegate = JSON.parse((await client.callTool({
  name: "dsh_delegate",
  arguments: {
    prompt: "Reply with exactly: CW-LIVE-OK",
    cwd: work,
    coworker: { threadId, outboxDir: outbox },
  },
})).content.find((item) => item.type === "text").text);

// Deliberately no status/watch/tail from here on.
const began = Date.now();
let record = null;
let delivered = null;
while (Date.now() - began < 180_000) {
  await new Promise((done) => setTimeout(done, 3_000));
  const names = await readdir(outbox).catch(() => []);
  const json = names.filter((name) => name.endsWith(".json"));
  if (json.length === 0) continue;
  const parsed = await Promise.all(json.map(async (name) => JSON.parse(await readFile(join(outbox, name), "utf8"))));
  record = parsed.find((entry) => entry.taskId === delegate.taskId) ?? null;
  if (record !== null && record.status !== "pending" && record.status !== "sending") {
    delivered = record.status;
    break;
  }
}

await client.close().catch(() => undefined);
sender.kill();

console.log(JSON.stringify({
  taskId: delegate.taskId,
  callbackReady: delegate.coworker?.callbackReady ?? null,
  advice: delegate.coworker?.advice ?? null,
  recordWritten: record !== null,
  recordStatus: record?.status ?? null,
  executionId: record?.executionId ?? null,
  eventId: record?.eventId ?? null,
  delivered,
  elapsedMs: Date.now() - began,
  observationCallsAfterDispatch: 0,
}, null, 2));
