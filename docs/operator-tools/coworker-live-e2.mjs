/**
 * Follow-up-only acceptance for one existing task: e2 on an already settled e1.
 *
 * Budget: one SDK prompt, one notification. Nothing is re-dispatched: the task id
 * comes from the operator, the binding is reused, and any conflict, observation
 * gap or unknown send stops the run.
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitForSenderReady } from "./coworker-ready.mjs";
import { waitForConsumption } from "./coworker-consumption.mjs";

const home = process.env.LIVE_HOME;
const bridge = process.env.LIVE_BRIDGE ?? resolve("dist-cw/index.js");
const kernel = process.env.LIVE_KERNEL;
const threadId = process.env.LIVE_THREAD;
const taskId = process.env.LIVE_TASK;
const provider = process.env.LIVE_PROVIDER ?? "opencode-go";
const model = process.env.LIVE_MODEL ?? "deepseek-v4.1-flash";
const queueDb = join(process.env.USERPROFILE ?? "", ".codex", "queue_1.sqlite");
const trace = [];
const budget = { delegateCalls: 0, confirmedPrompts: 0, unknownSends: 0, wakes: 0 };

function stop(reason) {
  console.log(JSON.stringify({ status: "stopped", reason, budget, trace }, null, 2));
  process.exit(1);
}

if ([home, kernel, threadId, taskId].some((value) => value === undefined)) {
  stop("LIVE_HOME, LIVE_KERNEL, LIVE_THREAD and LIVE_TASK are required");
}

const bridgeHome = join(home, "codex-bridge-sdk");
const outbox = join(bridgeHome, "coworker-outbox");

async function records() {
  const names = (await readdir(outbox).catch(() => [])).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => {
    try {
      return JSON.parse(await readFile(join(outbox, name), "utf8"));
    } catch {
      return { eventId: name, status: "unreadable" };
    }
  }));
}

const before = await records();
const e1Before = before.find((entry) => entry.taskId === taskId && entry.executionId === "e1") ?? null;
trace.push({ step: "e1-before", deliveredAt: e1Before?.deliveredAt ?? null, status: e1Before?.status ?? null });

const sender = spawn(process.execPath, [
  resolve("docs/operator-tools/coworker-sender.mjs"),
  "--outbox", outbox,
  "--kernel", kernel,
  "--interval", "2",
], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });

const ready = await waitForSenderReady({ outbox, pid: sender.pid, timeoutMs: 15_000, intervalMs: 250 });
trace.push({ step: "sender-ready", ready: ready.ready, reason: ready.reason });
if (ready.ready !== true) {
  sender.kill();
  stop(`sender not ready: ${ready.reason}`);
}

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
const client = new Client({ name: "coworker-e2", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

try {
  let followed;
  try {
    followed = JSON.parse((await client.callTool({
      name: "dsh_followup",
      arguments: { taskId, prompt: "Reply with exactly: CW-ACCEPT-2", mode: "queue" },
    })).content.find((item) => item.type === "text").text);
  } catch (error) {
    stop(`follow-up call failed: ${String(error?.message ?? error).slice(0, 400)}`);
  }
  if (followed.error !== undefined || followed.code !== undefined) {
    if (String(followed.code ?? "").includes("unknown")) budget.unknownSends += 1;
    stop(`follow-up returned an error envelope: ${JSON.stringify(followed).slice(0, 500)}`);
  }
  budget.confirmedPrompts += 1;
  if (budget.confirmedPrompts > 1) stop("prompt budget exceeded");
  trace.push({ step: "followup", accepted: followed.accepted ?? null, coworker: followed.coworker ?? null });

  // Wait for the e2 completion record.
  const deadline = Date.now() + 240_000;
  let e2 = null;
  while (Date.now() < deadline) {
    const current = await records();
    e2 = current.find((entry) => entry.taskId === taskId && entry.executionId === "e2") ?? null;
    if (e2 !== null && e2.status === "acknowledged") break;
    if (e2 !== null && (e2.status === "delivery_unknown" || e2.status === "rejected")) {
      stop(`e2 delivery ${e2.status}: stopping, no retry`);
    }
    if (e2 === null && !current.some((entry) => entry.executionId === "e1")) {
      stop("observation gap: the e1 record disappeared");
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  if (e2 === null || e2.status !== "acknowledged") stop("e2 completion record was not acknowledged in time");
  budget.wakes += 1;
  trace.push({ step: "e2-record", eventId: e2.eventId, status: e2.status, messageIdPrefix: String(e2.messageId ?? "").slice(0, 8) });

  // Consumption: exact message id, bounded to 5 minutes, read-only.
  const consumption = e2.messageId === undefined || e2.messageId === null
    ? { status: "no_receipt_identity", stages: { accepted: true, consumed: null } }
    : await waitForConsumption({ queueDb, messageId: e2.messageId, threadId, timeoutMs: 300_000, intervalMs: 2_000 });
  trace.push({ step: "consumption-e2", status: consumption.status, stages: consumption.stages, elapsedMs: consumption.elapsedMs });

  // e1 must be untouched.
  const after = await records();
  const e1After = after.find((entry) => entry.taskId === taskId && entry.executionId === "e1") ?? null;
  trace.push({ step: "e1-after", deliveredAt: e1After?.deliveredAt ?? null, status: e1After?.status ?? null });
  if (e1After?.deliveredAt !== e1Before?.deliveredAt) stop("the e1 record was redelivered");

  console.log(JSON.stringify({
    status: consumption.status === "consumed" ? "passed" : "stopped_at_consumption",
    taskId,
    threadId,
    budget,
    e2: { eventId: e2.eventId, status: e2.status, deliveredAt: e2.deliveredAt ?? null },
    e1: { deliveredAt: e1Before?.deliveredAt ?? null, unchanged: true },
    consumption,
    trace,
  }, null, 2));
  if (consumption.status !== "consumed") process.exitCode = 2;
} finally {
  await client.close().catch(() => undefined);
  sender.kill();
}
