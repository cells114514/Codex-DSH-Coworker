/**
 * Sender assertions: the background process that turns persisted completion
 * records into notifications. Uses the queue stub only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sender = resolve("docs/operator-tools/coworker-sender.mjs");
const stub = resolve("docs/operator-tools/coworker-queue-stub.mjs");
const THREAD = "11111111-2222-4333-8444-555555555555";

async function harness(): Promise<{ root: string; outbox: string; stubLog: string }> {
  const root = await mkdtemp(join(tmpdir(), "cw-sender-"));
  const outbox = join(root, "outbox");
  await mkdir(outbox, { recursive: true });
  return { root, outbox, stubLog: join(root, "stub.log") };
}

function run(h: { outbox: string; stubLog: string }, env: Record<string, string> = {}, extra: string[] = []): Promise<{ code: number | null; report: { results?: Array<{ status?: string | null }> } | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [sender, "--outbox", h.outbox, "--stub", stub, "--once", ...extra], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: { ...process.env, COWORKER_STUB_LOG: h.stubLog, ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("exit", (code) => {
      let report = null;
      try { report = JSON.parse(stdout); } catch { report = null; }
      resolveRun({ code, report });
    });
  });
}

async function attempts(log: string): Promise<number> {
  try {
    const text = await readFile(log, "utf8");
    return text.trim() === "" ? 0 : text.trim().split("\n").length;
  } catch {
    return 0;
  }
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "dsh_task:e1:turn_completed",
    taskId: "dsh_task",
    executionId: "e1",
    execution: "turn_completed",
    threadId: THREAD,
    status: "pending",
    createdAt: new Date().toISOString(),
    notification: "[coworker] fixed",
    ...overrides,
  };
}

test("sender keeps the receipt message id on the delivered record", async () => {
  const h = await harness();
  await writeFile(join(h.outbox, "a.json"), JSON.stringify(record()), "utf8");
  await run(h);
  const stored = JSON.parse(await readFile(join(h.outbox, "a.json"), "utf8"));
  assert.equal(stored.status, "acknowledged");
  assert.equal(typeof stored.messageId, "string", "the receipt identity is persisted for later consumption checks");
  assert.ok(String(stored.messageId).length >= 8);
});

test("sender delivers a pending record exactly once", async () => {
  const h = await harness();
  await writeFile(join(h.outbox, "a.json"), JSON.stringify(record()), "utf8");
  const first = await run(h);
  assert.equal(await attempts(h.stubLog), 1, "one delivery attempt");
  assert.equal(first.report?.results?.[0]?.status, "acknowledged");
  const second = await run(h);
  assert.equal(await attempts(h.stubLog), 1, "a second pass must not resend");
  assert.ok(second.report?.results?.length === 0, "nothing pending remains");
});

test("sender leaves a damaged record untouched and skips it", async () => {
  const h = await harness();
  await writeFile(join(h.outbox, "bad.json"), "{ not json", "utf8");
  const result = await run(h);
  assert.equal(await attempts(h.stubLog), 0, "a damaged record must not be sent");
  assert.equal(await readFile(join(h.outbox, "bad.json"), "utf8"), "{ not json");
  assert.equal(result.code, 0);
});

test("sender stops when the STOP marker exists", async () => {
  const h = await harness();
  await writeFile(join(h.outbox, "a.json"), JSON.stringify(record()), "utf8");
  await writeFile(join(h.outbox, "STOP"), "stopped\n", "utf8");
  await run(h);
  assert.equal(await attempts(h.stubLog), 0, "STOP must suppress delivery");
});

test("sender records delivery_unknown and does not resend on the next pass", async () => {
  const h = await harness();
  await writeFile(join(h.outbox, "a.json"), JSON.stringify(record({ eventId: "dsh_task:e9:turn_completed" })), "utf8");
  await run(h, { COWORKER_STUB_MODE: "lost-receipt" });
  assert.equal(await attempts(h.stubLog), 1);
  await run(h, { COWORKER_STUB_MODE: "lost-receipt" });
  assert.equal(await attempts(h.stubLog), 1, "delivery_unknown must not be retried");
});

test("two senders over one outbox deliver each record once", async () => {
  const h = await harness();
  await writeFile(join(h.outbox, "a.json"), JSON.stringify(record({ eventId: "dsh_task:e1:turn_completed" })), "utf8");
  await writeFile(join(h.outbox, "b.json"), JSON.stringify(record({ eventId: "dsh_task:e2:turn_completed", executionId: "e2" })), "utf8");
  const [first, second] = await Promise.all([run(h), run(h)]);
  const total = await attempts(h.stubLog);
  assert.equal(total, 2, `each record once, saw ${total}`);
  const statuses = [...(first.report?.results ?? []), ...(second.report?.results ?? [])].map((entry) => entry.status);
  assert.ok(statuses.every((status) => status === "acknowledged" || status === "locked" || status === "deduplicated"));
});

test("sender writes a heartbeat so readiness can be observed", async () => {
  const h = await harness();
  await run(h);
  const files = await readdir(h.outbox);
  assert.ok(files.includes(".sender-heartbeat"), "heartbeat file must exist after a pass");
});

test("keeps the notifier diagnostics when writing the delivery outcome back", async () => {
  const h = await harness();
  await writeFile(join(h.outbox, "dsh_diag_e1_turn_completed.json"), JSON.stringify(record({ eventId: "dsh_diag:e1:turn_completed", taskId: "dsh_diag" })), "utf8");
  await run(h, { COWORKER_STUB_MODE: "lost-receipt" });
  const stored = JSON.parse(await readFile(join(h.outbox, "dsh_diag_e1_turn_completed.json"), "utf8"));
  assert.equal(stored.status, "delivery_unknown");
  assert.ok(stored.receipt !== undefined, "the sender must not erase the notifier evidence");
  assert.equal(typeof stored.receipt.reason, "string");
  assert.ok("code" in stored.receipt);
});