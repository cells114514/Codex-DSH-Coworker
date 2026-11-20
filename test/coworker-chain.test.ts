/**
 * Full delivery chain: completion record -> sender -> notifier (queue stub) ->
 * receipt parse -> sender write-back -> consumption probe. The final message id
 * and thread must agree across every stage.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { waitForConsumption } from "../docs/operator-tools/coworker-consumption.mjs";

const THREAD = "11111111-2222-4333-8444-555555555555";
const MESSAGE = "44444444-5555-4666-8777-888888888888";
const cleanups = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function chain() {
  const root = await mkdtemp(join(tmpdir(), "cw-chain-"));
  const outbox = join(root, "coworker-outbox");
  await mkdir(outbox, { recursive: true });
  const queueDb = join(root, "queue.db");
  const db = new DatabaseSync(queueDb);
  db.exec(`
    create table queued_items (id text primary key, thread_id text not null, payload_json text, queue_order integer, created_at_ms integer, updated_at_ms integer);
    create table queued_thread_revisions (thread_id text primary key, revision integer not null);
  `);
  db.prepare("insert into queued_thread_revisions (thread_id, revision) values (?, ?)").run(THREAD, 1);
  db.close();
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return { root, outbox, queueDb };
}

function runSender(h, env) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        resolve("docs/operator-tools/coworker-sender.mjs"),
        "--outbox", h.outbox,
        "--stub", resolve("docs/operator-tools/coworker-queue-stub.mjs"),
        "--once",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          COWORKER_STUB_LOG: join(h.root, "stub.log"),
          COWORKER_STUB_MESSAGE_ID: MESSAGE,
          COWORKER_STUB_RECEIPT_THREAD: THREAD,
          ...env,
        },
      },
    );
    child.on("exit", (code) => resolveRun(code));
  });
}

describe("full delivery chain", () => {
  it("carries one message id from receipt to consumption", async () => {
    const h = await chain();
    const eventId = "dsh_chain:e1:turn_completed";
    await writeFile(
      join(h.outbox, "dsh_chain_e1_turn_completed.json"),
      JSON.stringify({
        eventId,
        taskId: "dsh_chain",
        executionId: "e1",
        execution: "turn_completed",
        threadId: THREAD,
        status: "pending",
        notification: "[coworker] chain",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const code = await runSender(h, {});
    assert.equal(code, 0, "the sender exits cleanly after a verified receipt");

    const stored = JSON.parse(await readFile(join(h.outbox, "dsh_chain_e1_turn_completed.json"), "utf8"));
    assert.equal(stored.status, "acknowledged");
    assert.equal(stored.messageId, MESSAGE, "the sender persists the exact receipt id");
    assert.equal(stored.threadId, THREAD, "the record still names the same thread");

    // The queue row exists under that exact id; the probe must find it by id.
    const db = new DatabaseSync(h.queueDb);
    db.prepare("insert into queued_items (id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms) values (?, ?, ?, ?, ?, ?)")
      .run(MESSAGE, THREAD, "{}", 1, Date.now(), Date.now());
    db.close();

    const probe = waitForConsumption({ queueDb: h.queueDb, messageId: stored.messageId, threadId: stored.threadId, timeoutMs: 1_000, intervalMs: 100 });
    setTimeout(() => {
      const handle = new DatabaseSync(h.queueDb);
      handle.prepare("delete from queued_items where id = ?").run(MESSAGE);
      handle.prepare("update queued_thread_revisions set revision = revision + 1 where thread_id = ?").run(THREAD);
      handle.close();
    }, 250);
    const result = await probe;
    assert.equal(result.status, "consumed");
    assert.equal(result.stages.accepted, true);
    assert.equal(result.stages.consumed, true);
  });

  it("reports no receipt identity when the notifier returns none", async () => {
    const h = await chain();
    await writeFile(
      join(h.outbox, "dsh_chain_e2_turn_completed.json"),
      JSON.stringify({
        eventId: "dsh_chain:e2:turn_completed",
        taskId: "dsh_chain",
        executionId: "e2",
        execution: "turn_completed",
        threadId: THREAD,
        status: "pending",
        notification: "[coworker] chain",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await runSender(h, { COWORKER_STUB_MODE: "lost-receipt" });
    const stored = JSON.parse(await readFile(join(h.outbox, "dsh_chain_e2_turn_completed.json"), "utf8"));
    assert.notEqual(stored.status, "acknowledged");
    assert.equal(stored.messageId ?? null, null, "no id is invented when the receipt is missing");
  });
});
