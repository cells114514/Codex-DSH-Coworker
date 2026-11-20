/**
 * Consumption-probe regression for the case that broke the first live run: the
 * message had already left the queue before the probe started.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { waitForConsumption } from "../docs/operator-tools/coworker-consumption.mjs";

const THREAD = "11111111-2222-4333-8444-555555555555";
const MESSAGE = "55555555-6666-4777-8888-999999999999";
const cleanups = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function emptyQueue() {
  const root = await mkdtemp(join(tmpdir(), "cw-consumed-"));
  const db = join(root, "queue.db");
  const handle = new DatabaseSync(db);
  handle.exec(`
    create table queued_items (id text primary key, thread_id text not null, payload_json text, queue_order integer, created_at_ms integer, updated_at_ms integer);
    create table queued_thread_revisions (thread_id text primary key, revision integer not null);
  `);
  handle.prepare("insert into queued_thread_revisions (thread_id, revision) values (?, ?)").run(THREAD, 7);
  handle.close();
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return db;
}

describe("consumption probe timing", () => {
  it("reports consumed when an acknowledged message already left the queue", async () => {
    const db = await emptyQueue();
    const result = await waitForConsumption({ queueDb: db, messageId: MESSAGE, threadId: THREAD, acceptedByReceipt: true, timeoutMs: 1_000, intervalMs: 100 });
    assert.equal(result.status, "consumed");
    assert.equal(result.observation, "row-absent-after-acknowledged-receipt");
    assert.equal(result.stages.accepted, true);
  });

  it("still reports never_accepted without a receipt", async () => {
    const db = await emptyQueue();
    const result = await waitForConsumption({ queueDb: db, messageId: MESSAGE, threadId: THREAD, timeoutMs: 400, intervalMs: 100 });
    assert.equal(result.status, "never_accepted");
  });
});
