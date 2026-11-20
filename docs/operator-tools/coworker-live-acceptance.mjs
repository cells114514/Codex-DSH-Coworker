/**
 * Two-round isolated live acceptance for the callback chain.
 *
 * Budget (hard): at most two SDK prompts and at most two notification wakes.
 *   1. delegate with a coworker binding        -> prompt #1, wake #1
 *   2. one extra input while e1 is in flight   -> refused, no prompt sent
 *   3. follow-up on the same task after e1     -> prompt #2, wake #2
 *
 * Nothing observes the task through dsh_status / dsh_watch / dsh_tail after a
 * dispatch: completion is read from the outbox, from the local queue database
 * and from the kernel's thread view. Any anomaly stops the run; nothing retries.
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitForSenderReady } from "./coworker-ready.mjs";
import { waitForConsumption } from "./coworker-consumption.mjs";
import { shutdownAll } from "./coworker-lifecycle.mjs";

const planOnly = process.argv.includes("--plan");
const stubMode = process.argv.includes("--stub");
const home = process.env.LIVE_HOME;
const bridge = process.env.LIVE_BRIDGE ?? resolve("dist-cw/index.js");
const kernel = process.env.LIVE_KERNEL;
const threadId = process.env.LIVE_THREAD;
const provider = process.env.LIVE_PROVIDER ?? "opencode-go";
const model = process.env.LIVE_MODEL ?? "deepseek-v4.1-flash";
const queueDb = join(process.env.USERPROFILE ?? "", ".codex", "queue_1.sqlite");
const runtimeRecordPath = (taskId) => join(bridgeHome, "runtimes", `${taskId}.json`);
const phase = { recordWritten: [], queueAccepted: [], queueConsumed: [], codexRead: [] };
const budget = { delegateCalls: 0, confirmedPrompts: 0, unknownSends: 0, wakes: 0 };
const trace = [];

class Stop extends Error {}
function fail(message) {
  throw new Stop(message);
}

if (planOnly) {
  console.log(JSON.stringify({
    status: "plan",
    steps: [
      "start sender (heartbeat) — no model, no queue write",
      "dsh_delegate + coworker binding -> prompt #1 (budget 1/2)",
      "dsh_followup immediately -> expect prompt_in_flight, assert no prompt sent",
      "read outbox until task:e1 turn_completed is acknowledged (wake 1/2) — no status/watch/tail",
      "read queue_1.sqlite: e1 row accepted then consumed; assert pendingRows == 0",
      "dsh_followup after e1 settled -> prompt #2 (budget 2/2)",
      "read outbox until task:e2 turn_completed is acknowledged (wake 2/2)",
      "assert the e1 record is unchanged (no replay)",
      "kernel thread/read: two new user turns, each reads and reports only",
    ],
    budget: { maxPrompts: 2, maxWakes: 2, maxRefusedInputs: 1 },
    requires: ["LIVE_HOME", "LIVE_KERNEL", "LIVE_THREAD (dedicated test chat only)"],
  }, null, 2));
  process.exit(0);
}

if ([home, kernel, threadId].some((value) => value === undefined)) {
  fail("LIVE_HOME, LIVE_KERNEL and LIVE_THREAD are required; never guess the chat id");
}

const bridgeHome = stubMode ? join(process.env.TEMP ?? ".", "cw-stub-" + Date.now()) : join(home, "codex-bridge-sdk");
const outbox = join(bridgeHome, stubMode ? "coworker-outbox" : "coworker-outbox");

async function readOutbox() {
  const names = (await readdir(outbox).catch(() => [])).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => {
    try {
      return JSON.parse(await readFile(join(outbox, name), "utf8"));
    } catch {
      return { eventId: name, status: "unreadable" };
    }
  }));
}

async function waitForRecord(taskId, executionId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await readOutbox();
    const match = records.find((entry) => entry.taskId === taskId && entry.executionId === executionId);
    if (match !== undefined) {
      phase.recordWritten.push({ executionId, status: match.status, eventId: match.eventId });
      if (match.status === "acknowledged") return match;
      if (match.status === "delivery_unknown" || match.status === "rejected") {
        fail(`delivery ${match.status} for ${executionId}: stopping, no retry`);
      }
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  fail(`timeout waiting for the ${executionId} completion record`);
}

async function stubQueueState() {
  // Stub mode never reads the real Codex queue database.
  return { pendingRows: 0, revision: 100 + budget.wakes };
}

async function queueState() {
  if (stubMode) return stubQueueState();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(queueDb, { readOnly: true });
  try {
    const rows = db.prepare("select id from queued_items where thread_id = ?").all(threadId).length;
    const revision = (db.prepare("select revision from queued_thread_revisions where thread_id = ?").get(threadId) ?? {}).revision;
    return { pendingRows: rows, revision };
  } finally {
    db.close();
  }
}

const sender = spawn(process.execPath, [
  resolve("docs/operator-tools/coworker-sender.mjs"),
  "--outbox", outbox,
  "--interval", "1",
  ...(stubMode
    ? ["--stub", resolve("docs/operator-tools/coworker-queue-stub.mjs")]
    : ["--kernel", kernel]),
], {
  stdio: ["ignore", "ignore", "ignore"],
  windowsHide: true,
});
// Readiness before dispatch: a fixed sleep is not evidence that this sender runs.
const ready = await waitForSenderReady({
  outbox,
  pid: sender.pid,
  timeoutMs: 15_000,
  intervalMs: 250,
  exited: sender.exitCode !== null,
  exitCode: sender.exitCode ?? undefined,
});
trace.push({ step: "sender-ready", ready: ready.ready, reason: ready.reason, detail: ready.detail });
if (ready.ready !== true) fail(`sender not ready before dispatch: ${ready.reason}`);

async function stubCallTool(name, args) {
  // Scripted stand-in: same shapes the bridge returns, no runtime, no model.
  if (name === "dsh_delegate") {
    const taskId = "dsh_stub_" + Date.now().toString(36);
    setTimeout(async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(outbox, { recursive: true });
      await writeFile(join(outbox, `${taskId}_e1_turn_completed.json`), JSON.stringify({
        eventId: `${taskId}:e1:turn_completed`, taskId, executionId: "e1", execution: "turn_completed",
        threadId, status: "pending", notification: "[coworker] stub completion", createdAt: new Date().toISOString(),
      }, null, 2));
    }, 300);
    return { content: [{ type: "text", text: JSON.stringify({ taskId, coworker: { registered: true, bindingSaved: true, senderReady: true, callbackReady: true, threadId, advice: "callback ready: the caller may end its turn and wait for the notification" } }) }] };
  }
  if (name === "dsh_followup") {
    if (args.prompt.includes("do not send")) {
      const error = new Error("one execution is already in flight for this task");
      error.code = "prompt_in_flight";
      throw error;
    }
    const taskId = args.taskId;
    setTimeout(async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(outbox, { recursive: true });
      await writeFile(join(outbox, `${taskId}_e2_turn_completed.json`), JSON.stringify({
        eventId: `${taskId}:e2:turn_completed`, taskId, executionId: "e2", execution: "turn_completed",
        threadId, status: "pending", notification: "[coworker] stub completion", createdAt: new Date().toISOString(),
      }, null, 2));
    }, 300);
    return { content: [{ type: "text", text: JSON.stringify({ taskId, accepted: true, coworker: { registered: true, bindingSaved: true, senderReady: true, callbackReady: true, reused: true, threadId } }) }] };
  }
  throw new Error("unexpected tool " + name);
}

const transport = stubMode ? null : new StdioClientTransport({
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
const client = stubMode
  ? { callTool: (request) => stubCallTool(request.name, request.arguments), close: async () => undefined }
  : new Client({ name: "coworker-live-acceptance", version: "0.0.0" }, { capabilities: {} });
if (!stubMode) await client.connect(transport);

function parse(result) {
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

try {
  const before = await queueState();
  trace.push({ step: "queue-before", ...before });

  // Round 1 — prompt #1.
  // A dedicated scratch workspace: the repository itself is already claimed by an
  // existing task, and an exclusive-write collision would fail after binding.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const work = stubMode ? join(tmpdir(), "cw-accept-stub") : await mkdtemp(join(tmpdir(), "cw-accept-"));
  await (await import("node:fs/promises")).mkdir(work, { recursive: true });
  trace.push({ step: "workspace", work });
  budget.delegateCalls += 1;
  let delegated;
  try {
    delegated = parse(await client.callTool({
      name: "dsh_delegate",
      arguments: {
        prompt: "Reply with exactly: CW-ACCEPT-1",
        cwd: work,
        coworker: { threadId, outboxDir: outbox },
      },
    }));
  } catch (error) {
    fail(`delegate call failed before any confirmation: ${String(error?.message ?? error).slice(0, 400)}`);
  }
  // An error envelope is judged before any success field: it means the prompt was
  // not sent, so the prompt budget is untouched.
  if (delegated.error !== undefined || delegated.code !== undefined) {
    const body = JSON.stringify(delegated).slice(0, 600);
    if (String(delegated.code ?? "").includes("unknown") || String(delegated.message ?? "").includes("unknown")) {
      budget.unknownSends += 1;
    }
    fail(`delegate returned an error envelope: ${body}`);
  }
  budget.confirmedPrompts += 1;
  if (budget.confirmedPrompts > 2) fail("prompt budget exceeded");
  trace.push({
    step: "delegate",
    taskId: delegated.taskId,
    coworker: delegated.coworker ?? null,
    callbackReady: delegated.coworker?.callbackReady ?? null,
    bindingSaved: delegated.coworker?.bindingSaved ?? null,
    senderReady: delegated.coworker?.senderReady ?? null,
    reason: delegated.coworker?.reason ?? null,
    advice: delegated.coworker?.advice ?? null,
  });
  if (delegated.coworker?.callbackReady !== true) {
    fail(`round 1 did not report callbackReady: ${JSON.stringify(delegated).slice(0, 800)}`);
  }

  // Extra input while e1 is in flight: must be refused without a prompt.
  const extra = await client.callTool({
    name: "dsh_followup",
    arguments: { taskId: delegated.taskId, prompt: "do not send this", mode: "queue" },
  }).then((result) => ({ ok: true, result }), (error) => ({ ok: false, error }));
  const extraText = extra.ok ? JSON.stringify(extra.result) : String(extra.error?.message ?? extra.error);
  const refused = extraText.includes("prompt_in_flight") || extra.error?.code === "prompt_in_flight";
  trace.push({ step: "extra-submit", refused });
  if (!refused) fail("the extra submission was not refused with prompt_in_flight");

  const e1 = await waitForRecord(delegated.taskId, "e1");
  // Consumption is a separate, bounded stage keyed by the exact receipt message.
  const consumedE1 = stubMode
    ? { status: "consumed", stub: true, stages: { accepted: true, consumed: true, chatTurnAdded: null, mcpRead: null } }
    : e1.messageId === undefined || e1.messageId === null
    ? { status: "no_receipt_identity", stages: { accepted: true, consumed: null } }
    : await waitForConsumption({
        queueDb,
        messageId: e1.messageId,
        acceptedByReceipt: true,
        threadId,
        timeoutMs: 300_000,
        intervalMs: 2_000,
      });
  trace.push({ step: "consumption-e1", status: consumedE1.status, stages: consumedE1.stages, elapsedMs: consumedE1.elapsedMs });
  // Identity evidence for the newly created runtime, read from the record.
  let runtimeEvidence = null;
  try {
    const record = JSON.parse(await readFile(join(bridgeHome, "runtimes", `${delegated.taskId}.json`), "utf8"));
    runtimeEvidence = {
      runtimePid: record.diagnostic?.runtimePid ?? null,
      runtimeStartedAt: record.diagnostic?.runtimeStartedAt ?? null,
      ownerBridgeInstance: record.owner?.bridgeInstanceId ? String(record.owner.bridgeInstanceId).slice(0, 8) + "…" : null,
      cleanShutdown: record.cleanShutdown,
      recordTaskId: record.taskId,
      recordRootSessionId: record.rootSessionId ? String(record.rootSessionId).slice(0, 8) + "…" : null,
    };
  } catch (error) {
    runtimeEvidence = { error: String(error?.message ?? error).slice(0, 200) };
  }
  trace.push({ step: "runtime-identity", ...runtimeEvidence });  if (consumedE1.status !== "consumed") {
    fail(`e1 notification was accepted but not consumed within the window: ${consumedE1.status}`);
  }
  budget.wakes += 1;
  if (budget.wakes > 2) fail("wake budget exceeded");
  phase.queueAccepted.push({ executionId: "e1", receipt: e1.messageId ?? null });
  const afterE1 = await queueState();
  trace.push({ step: "queue-after-e1", ...afterE1, revisionDelta: afterE1.revision - before.revision });
  if (afterE1.pendingRows !== 0) fail("the e1 notification was not consumed");
  phase.queueConsumed.push({ executionId: "e1", pendingRows: afterE1.pendingRows, revision: afterE1.revision });

  // Round 2 — prompt #2 on the same task.
  const followed = await client.callTool({
    name: "dsh_followup",
    arguments: { taskId: delegated.taskId, prompt: "Reply with exactly: CW-ACCEPT-2", mode: "queue" },
  }).then(parse, (error) => fail(`the follow-up was refused: ${String(error?.message ?? error).slice(0, 400)}`));
  if (followed.error !== undefined || followed.code !== undefined) {
    fail(`follow-up returned an error envelope: ${JSON.stringify(followed).slice(0, 600)}`);
  }
  budget.confirmedPrompts += 1;
  if (budget.confirmedPrompts > 2) fail("prompt budget exceeded");
  trace.push({ step: "followup", accepted: followed.accepted ?? null, coworker: followed.coworker ?? null });

  const e2 = await waitForRecord(delegated.taskId, "e2");
  budget.wakes += 1;
  if (budget.wakes > 2) fail("wake budget exceeded");
  phase.queueAccepted.push({ executionId: "e2", receipt: e2.messageId ?? null });
  // Same rule as e1: exact message id, bounded wait, never a thread-wide guess.
  const consumedE2 = stubMode
    ? { status: "consumed", stub: true, stages: { accepted: true, consumed: true } }
    : e2.messageId === undefined || e2.messageId === null
      ? { status: "no_receipt_identity", stages: { accepted: true, consumed: null } }
      : await waitForConsumption({
          queueDb,
          messageId: e2.messageId,
          threadId,
          acceptedByReceipt: true,
          timeoutMs: 300_000,
          intervalMs: 2_000,
        });
  trace.push({ step: "consumption-e2", status: consumedE2.status, stages: consumedE2.stages, elapsedMs: consumedE2.elapsedMs });
  if (consumedE2.status !== "consumed") fail(`e2 notification accepted but not consumed: ${consumedE2.status}`);
  const afterE2 = await queueState();
  phase.queueConsumed.push({ executionId: "e2", pendingRows: afterE2.pendingRows, revision: afterE2.revision });

  // e1 must not be replayed.
  const finalRecords = await readOutbox();
  const e1After = finalRecords.find((entry) => entry.taskId === delegated.taskId && entry.executionId === "e1");
  if (e1After === undefined || e1After.status !== "acknowledged") fail("the e1 record changed after e2");

  console.log(JSON.stringify({
    status: "passed",
    taskId: delegated.taskId,
    threadId,
    budget,
    phase,
    e1: { eventId: e1.eventId, status: e1.status, deliveredAt: e1.deliveredAt ?? null },
    e2: { eventId: e2.eventId, status: e2.status, deliveredAt: e2.deliveredAt ?? null },
    e1After,
    queue: { before, afterE1, afterE2 },
    trace,
    observationCallsAfterDispatch: 0,
  }, null, 2));
} catch (error) {
  const stopped = String(error?.message ?? error);
  const shutdown = await shutdownAll({ client, sender, bridgeChild: transport?.pid === undefined ? undefined : undefined });
  trace.push({ step: "shutdown", confirmed: shutdown.confirmed, bridge: shutdown.bridge, sender: shutdown.sender, errors: shutdown.errors });
  console.log(JSON.stringify({ status: "stopped", reason: stopped, phase, budget, trace }, null, 2));
  process.exitCode = 1;
} finally {
  await shutdownAll({ client, sender });
  // Post-close evidence: clean flag and whether the recorded runtime pid is gone.
  if (typeof delegated !== "undefined" && delegated?.taskId !== undefined) {
    try {
      const record = JSON.parse(await readFile(join(bridgeHome, "runtimes", `${delegated.taskId}.json`), "utf8"));
      const pid = record.diagnostic?.runtimePid ?? null;
      let pidAlive = null;
      if (typeof pid === "number") {
        try {
          process.kill(pid, 0);
          pidAlive = true;
        } catch {
          pidAlive = false;
        }
      }
      trace.push({ step: "close-evidence", cleanShutdown: record.cleanShutdown, cleanShutdownAt: record.cleanShutdownAt ?? null, runtimePid: pid, runtimePidAliveAfterClose: pidAlive });
    } catch (error) {
      trace.push({ step: "close-evidence", error: String(error?.message ?? error).slice(0, 200) });
    }
  }
}