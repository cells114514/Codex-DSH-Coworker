/**
 * Automated assertions for the coworker notifier's state machine.
 *
 * Everything runs against a local queue stub with a temporary outbox: no real
 * `codex queue` call, no queue row, no model wake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const notifier = resolve("docs/operator-tools/coworker-notify.mjs");
const stub = resolve("docs/operator-tools/coworker-queue-stub.mjs");
const taskId = "dsh_state_machine_task";
const threadId = "00000000-0000-4000-8000-000000000000";

interface Harness {
  root: string;
  outbox: string;
  stubLog: string;
  stopFile: string;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "cw-notify-test-"));
  const outbox = join(root, "outbox");
  await mkdir(outbox, { recursive: true });
  return {
    root,
    outbox,
    stubLog: join(root, "stub.log"),
    stopFile: join(outbox, "STOP"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

interface RunResult {
  code: number | null;
  report: Record<string, unknown> | null;
  stderr: string;
}

function runNotifier(
  h: Harness,
  eventId: string,
  options: { env?: Record<string, string>; waitForLock?: number } = {},
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        notifier,
        "--task", taskId,
        "--thread", threadId,
        "--home", h.root,
        "--outbox", h.outbox,
        "--stage-limit", "30",
        "--event-id", eventId,
        "--lock-wait", String(options.waitForLock ?? 2_000),
        "--assume-terminal", "turn_completed",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          COWORKER_QUEUE_STUB: stub,
          COWORKER_STUB_LOG: h.stubLog,
          ...options.env,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      let report: Record<string, unknown> | null = null;
      try {
        report = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        report = null;
      }
      resolveRun({ code, report, stderr: stderr.trim().slice(0, 200) });
    });
  });
}

async function stubAttempts(h: Harness): Promise<number> {
  try {
    const text = await readFile(h.stubLog, "utf8");
    return text.trim() === "" ? 0 : text.trim().split("\n").length;
  } catch {
    return 0;
  }
}

function recordPath(h: Harness, eventId: string): string {
  return join(h.outbox, `${eventId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

test("coworker notifier: stop marker suppresses a later completion event", async () => {
  const h = await harness();
  try {
    await writeFile(h.stopFile, "stopped by operator\n", "utf8");
    const run = await runNotifier(h, `${taskId}:stop-probe`);
    assert.equal(run.code, 2, "stop must exit with code 2");
    assert.equal(run.report?.status, "suppressed-after-stop");
    assert.equal(await stubAttempts(h), 0, "stop must not attempt a send");
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: two concurrent notifiers send exactly once", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:concurrent`;
    const [first, second] = await Promise.all([runNotifier(h, eventId), runNotifier(h, eventId)]);
    const attempts = await stubAttempts(h);
    assert.equal(attempts, 1, `exactly one send attempt expected, saw ${attempts}`);
    const statuses = [first.report?.status, second.report?.status].sort();
    assert.ok(statuses.includes("acknowledged"), `one run must acknowledge, saw ${JSON.stringify(statuses)}`);
    for (const status of statuses) {
      assert.ok(
        status === "acknowledged" || status === "locked" || status === "acked",
        `unexpected status ${String(status)}`,
      );
    }
    const record = JSON.parse(await readFile(recordPath(h, eventId), "utf8"));
    assert.equal(record.status, "acknowledged");
    assert.equal(typeof record.messageId, "string");
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: an unreadable record stops the run instead of sending", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:corrupt`;
    await writeFile(recordPath(h, eventId), "{ not json", "utf8");
    const run = await runNotifier(h, eventId);
    assert.equal(run.code, 3, "an unreadable record must exit 3");
    assert.equal(run.report?.status, "outbox_unreadable");
    assert.equal(await stubAttempts(h), 0, "no send may happen when the record is unreadable");
    assert.equal(await readFile(recordPath(h, eventId), "utf8"), "{ not json", "the damaged record must be left untouched");
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: restart with an unsent record delivers at most once", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:restart-pending`;
    await writeFile(recordPath(h, eventId), `${JSON.stringify({ eventId, status: "pending" }, null, 2)}\n`, "utf8");
    const first = await runNotifier(h, eventId);
    assert.equal(first.report?.status, "acknowledged");
    assert.equal(await stubAttempts(h), 1, "the pending record must be delivered once");
    const second = await runNotifier(h, eventId);
    assert.equal(second.report?.deduplicated, true);
    assert.equal(await stubAttempts(h), 1, "a second run must not send again");
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: restart with an acknowledged record never resends", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:restart-acked`;
    await writeFile(
      recordPath(h, eventId),
      `${JSON.stringify({ eventId, status: "acknowledged", messageId: "stub" }, null, 2)}\n`,
      "utf8",
    );
    const run = await runNotifier(h, eventId);
    assert.equal(run.report?.deduplicated, true);
    assert.equal(await stubAttempts(h), 0, "an acknowledged record must never be sent again");
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: a lost receipt is delivery_unknown and is not retried", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:lost-receipt`;
    const first = await runNotifier(h, eventId, { env: { COWORKER_STUB_MODE: "lost-receipt" } });
    assert.equal(first.report?.status, "delivery_unknown");
    assert.equal(await stubAttempts(h), 1);
    const second = await runNotifier(h, eventId, { env: { COWORKER_STUB_MODE: "lost-receipt" } });
    assert.equal(second.report?.status, "delivery_unknown");
    assert.equal(await stubAttempts(h), 1, "delivery_unknown must not be retried");
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: nonzero exit without a receipt is not proof of rejection", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:rejected`;
    const run = await runNotifier(h, eventId, { env: { COWORKER_STUB_MODE: "reject" } });
    assert.equal(run.report?.status, "delivery_unknown");
    assert.equal(await stubAttempts(h), 1);
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: insertion followed by nonzero exit stays unknown and never resends", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:commit-then-error`;
    const commitLog = join(h.outbox, "accepted.txt");
    const env = { COWORKER_STUB_MODE: "commit-then-error", COWORKER_STUB_COMMIT_LOG: commitLog };
    const first = await runNotifier(h, eventId, { env });
    assert.equal(first.report?.status, "delivery_unknown");
    const second = await runNotifier(h, eventId, { env });
    assert.equal(second.report?.status, "delivery_unknown");
    assert.equal(await stubAttempts(h), 1);
    assert.equal(await readFile(commitLog, "utf8"), "accepted\n");
  } finally { await h.cleanup(); }
});

test("coworker notifier: a receipt naming another thread is not trusted", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:thread-mismatch`;
    const run = await runNotifier(h, eventId, {
      env: { COWORKER_STUB_RECEIPT_THREAD: "99999999-9999-4999-8999-999999999999" },
    });
    assert.equal(run.report?.status, "delivery_unknown");
    const record = JSON.parse(await readFile(recordPath(h, eventId), "utf8"));
    assert.match(String(record.reason), /thread-mismatch/);
  } finally {
    await h.cleanup();
  }
});

test("coworker notifier: a crash after send does not resend on restart", async () => {
  const h = await harness();
  try {
    const eventId = `${taskId}:crash-after-send`;
    const crashed = await runNotifier(h, eventId, { env: { COWORKER_CRASH_AFTER_SEND: "1" } });
    assert.equal(crashed.code, 70, "the simulated crash must surface as exit 70");
    assert.equal(await stubAttempts(h), 1, "the crashed run did send once");
    // The lock file is left behind by the crash; a restart must not send again.
    const restart = await runNotifier(h, eventId, { waitForLock: 300 });
    assert.equal(await stubAttempts(h), 1, "a restart must not send again after a crash");
    assert.ok(
      restart.report?.status === "locked" || restart.report?.status === "delivery_unknown",
      `restart must refuse to send, saw ${String(restart.report?.status)}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("records the kernel output when the receipt cannot be trusted", async () => {
  const h = await harness();
  const eventId = "dsh_rt:e1:turn_completed";
  const path = join(h.outbox, "dsh_rt_e1_turn_completed.json");
  await writeFile(
    path,
    JSON.stringify({
      eventId,
      taskId,
      executionId: "e1",
      execution: "turn_completed",
      threadId,
      status: "pending",
      notification: "[coworker] fixed",
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );
  const result = await runNotifier(h, eventId, { env: { COWORKER_STUB_MODE: "lost-receipt" } });
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.notEqual(stored.status, "acknowledged");
  assert.ok(stored.receipt !== undefined, "the kernel evidence is persisted");
  assert.equal(typeof stored.receipt.reason, "string");
  assert.ok("code" in stored.receipt);
});

test("parses the receipt only after the kernel output stream closes", async () => {
  const h = await harness();
  const eventId = "dsh_rt:e2:turn_completed";
  const path = join(h.outbox, "dsh_rt_e2_turn_completed.json");
  await writeFile(
    path,
    JSON.stringify({
      eventId,
      taskId,
      executionId: "e2",
      execution: "turn_completed",
      threadId,
      status: "pending",
      notification: "[coworker] fixed",
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );
  // The stub writes the receipt and exits in the same tick: only a close-based read
  // sees it, an exit-based read would race and report no receipt.
  const result = await runNotifier(h, eventId, { env: { COWORKER_STUB_MESSAGE_ID: "99999999-8888-4777-8666-555555555555" } });
  assert.equal(result.report?.status, "acknowledged");
  assert.equal(result.report?.messageId, "99999999-8888-4777-8666-555555555555");
});

test("rejects a receipt that names a different thread", async () => {
  const h = await harness();
  const eventId = "dsh_rt:e3:turn_completed";
  const path = join(h.outbox, "dsh_rt_e3_turn_completed.json");
  await writeFile(
    path,
    JSON.stringify({
      eventId,
      taskId,
      executionId: "e3",
      execution: "turn_completed",
      threadId,
      status: "pending",
      notification: "[coworker] 事件 dsh_rt:e3:turn_completed / 任务 dsh_rt / 状态 turn_completed",
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );
  const result = await runNotifier(h, eventId, {
    env: { COWORKER_STUB_RECEIPT_THREAD: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  });
  assert.equal(result.report?.status, "delivery_unknown");
  assert.match(String(result.report?.reason), /thread-mismatch/);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.status, "delivery_unknown");
  assert.match(String(stored.receipt?.reason), /thread-mismatch/);
  assert.ok("code" in stored.receipt);
});

test("never stores authorization or notification text in diagnostics", async () => {
  const h = await harness();
  const eventId = "dsh_rt:e4:turn_completed";
  const path = join(h.outbox, "dsh_rt_e4_turn_completed.json");
  const notification = "[coworker] 事件 dsh_rt:e4:turn_completed / 任务 dsh_rt / 状态 turn_completed";
  await writeFile(
    path,
    JSON.stringify({
      eventId,
      taskId,
      executionId: "e4",
      execution: "turn_completed",
      threadId,
      status: "pending",
      notification,
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );
  await runNotifier(h, eventId, {
    env: {
      COWORKER_STUB_MODE: "reject",
      COWORKER_STUB_LEAK: `Authorization: Bearer sk-live-abcdefgh12345678 token=zzz ${notification}`,
    },
  });
  const stored = JSON.parse(await readFile(path, "utf8"));
  const diagnostic = JSON.stringify(stored.receipt ?? {});
  assert.doesNotMatch(diagnostic, /sk-live-abcdefgh12345678/);
  assert.doesNotMatch(diagnostic, /zzz/);
  assert.doesNotMatch(diagnostic, /任务 dsh_rt/);
});