/**
 * Consumption-probe assertions against a private queue database that mirrors the
 * real schema. No real queue, no model, no notification.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { readQueuedRow, waitForConsumption } from "../docs/operator-tools/coworker-consumption.mjs";

const THREAD = "11111111-2222-4333-8444-555555555555";
const MESSAGE = "22222222-3333-4444-8555-666666666666";
const cleanups = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function queue(withRow = true) {
  const root = await mkdtemp(join(tmpdir(), "cw-consumption-"));
  const db = join(root, "queue.db");
  const handle = new DatabaseSync(db);
  handle.exec(`
    create table queued_items (id text primary key, thread_id text not null, payload_json text, queue_order integer, created_at_ms integer, updated_at_ms integer);
    create table queued_thread_revisions (thread_id text primary key, revision integer not null);
  `);
  handle.prepare("insert into queued_thread_revisions (thread_id, revision) values (?, ?)").run(THREAD, 10);
  if (withRow) {
    handle
      .prepare("insert into queued_items (id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms) values (?, ?, ?, ?, ?, ?)")
      .run(MESSAGE, THREAD, "{}", 1, Date.now(), Date.now());
  }
  handle.close();
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return db;
}

describe("consumption probe", () => {
  it("looks up the exact message id in the exact thread", async () => {
    const db = await queue();
    const found = readQueuedRow({ queueDb: db, messageId: MESSAGE, threadId: THREAD });
    assert.equal(found.row?.id, MESSAGE);
    assert.equal(found.threadRows, 1);
    const other = readQueuedRow({ queueDb: db, messageId: "33333333-4444-4555-8666-777777777777", threadId: THREAD });
    assert.equal(other.row, null, "a different id must not match");
  });

  it("reports consumed only after that row leaves the queue", async () => {
    const db = await queue();
    setTimeout(() => {
      const handle = new DatabaseSync(db);
      handle.prepare("delete from queued_items where id = ?").run(MESSAGE);
      handle.prepare("update queued_thread_revisions set revision = revision + 1 where thread_id = ?").run(THREAD);
      handle.close();
    }, 350);
    const result = await waitForConsumption({ queueDb: db, messageId: MESSAGE, threadId: THREAD, timeoutMs: 4_000, intervalMs: 100 });
    assert.equal(result.status, "consumed");
    assert.equal(result.stages.accepted, true);
    assert.equal(result.stages.consumed, true);
    assert.equal(result.stages.chatTurnAdded, null, "queue state alone never claims a chat turn");
    assert.equal(result.stages.mcpRead, null, "queue state alone never claims an MCP read");
  });

  it("times out without blaming the app window", async () => {
    const db = await queue();
    const result = await waitForConsumption({ queueDb: db, messageId: MESSAGE, threadId: THREAD, timeoutMs: 600, intervalMs: 100 });
    assert.equal(result.status, "consumption_timeout");
    assert.equal(result.stages.consumed, false);
    assert.match(String(result.note), /not evidence about the app window/);
    assert.equal(result.row?.id, MESSAGE, "the undelivered row is kept for diagnosis");
  });

  it("distinguishes a row that was never accepted", async () => {
    const db = await queue(false);
    const result = await waitForConsumption({ queueDb: db, messageId: MESSAGE, threadId: THREAD, timeoutMs: 400, intervalMs: 100 });
    assert.equal(result.status, "never_accepted");
    assert.equal(result.stages.accepted, false);
  });
});
