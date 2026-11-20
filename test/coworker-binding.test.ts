/**
 * Binding + completion-record tests for the coworker flow.
 *
 * Covers: exact-identity validation, binding persistence, concurrent binding,
 * one completion record per execution generation, and that a second execution
 * cannot reuse the first completion. All filesystem-only: no queue, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkerBindings, normalizeBinding } from "../src/coworker-binding.js";

const THREAD_A = "11111111-2222-4333-8444-555555555555";
const THREAD_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function home(): Promise<{ dir: string; outbox: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cw-binding-"));
  const outbox = join(dir, "outbox");
  return { dir, outbox, cleanup: async () => undefined };
}

test("coworker binding rejects identities that are not exact chat uuids", () => {
  for (const threadId of ["", "my test chat", "Chat 3", "01a1eee6", "recent"]) {
    const result = normalizeBinding({ threadId }, "/tmp/outbox");
    assert.equal(result.registered, false, `"${threadId}" must not be accepted`);
  }
  const ok = normalizeBinding({ threadId: THREAD_A }, "/tmp/outbox", ["/tmp"]);
  assert.equal(ok.registered, true);
  assert.equal(ok.threadId, THREAD_A);
});

test("coworker binding persists and can be read back", async () => {
  const h = await home();
  const bindings = new CoworkerBindings(h.dir);
  const bound = await bindings.bind("dsh_task_a", { threadId: THREAD_A, outboxDir: h.outbox }, join(h.dir, "default-outbox"), [h.outbox]);
  assert.equal(bound.registered, true);
  const stored = await bindings.get("dsh_task_a");
  assert.equal(stored?.threadId, THREAD_A);
  assert.equal(stored?.outboxDir, h.outbox);
  assert.equal(await bindings.get("dsh_missing"), undefined);
});

test("coworker binding failure is reported without losing the task association", async () => {
  const h = await home();
  const bindings = new CoworkerBindings(h.dir);
  const bad = await bindings.bind("dsh_task_b", { threadId: "not-a-uuid" }, join(h.dir, "default-outbox"), [h.outbox]);
  assert.equal(bad.registered, false);
  assert.match(String(bad.reason), /uuid/i);
});

test("concurrent binding of the same task settles on one binding", async () => {
  const h = await home();
  const bindings = new CoworkerBindings(h.dir);
  const results = await Promise.all([
    bindings.bind("dsh_task_c", { threadId: THREAD_A, outboxDir: h.outbox }, h.outbox, [h.outbox]),
    bindings.bind("dsh_task_c", { threadId: THREAD_B, outboxDir: h.outbox }, h.outbox, [h.outbox]),
  ]);
  assert.ok(results.every((entry) => entry.registered === true));
  const stored = await bindings.get("dsh_task_c");
  assert.ok(stored?.threadId === THREAD_A || stored?.threadId === THREAD_B);
  const files = await readdir(join(h.dir, "coworker"));
  assert.equal(files.filter((name) => name.endsWith(".json")).length, 1, "one sidecar per task");
});

test("one completion record per execution, and a second execution is distinct", async () => {
  const h = await home();
  const bindings = new CoworkerBindings(h.dir);
  await bindings.bind("dsh_task_d", { threadId: THREAD_A, outboxDir: h.outbox }, h.outbox, [h.outbox]);
  const stored = await bindings.get("dsh_task_d");
  assert.ok(stored);

  const first = await bindings.writeCompletion(stored!, { taskId: "dsh_task_d", executionId: "e1", execution: "turn_completed", turnSeq: 12 });
  assert.equal(first.written, true);
  const duplicate = await bindings.writeCompletion(stored!, { taskId: "dsh_task_d", executionId: "e1", execution: "turn_completed", turnSeq: 12 });
  assert.equal(duplicate.written, false, "the same execution must not be recorded twice");
  assert.equal(duplicate.deduped, true);

  const second = await bindings.writeCompletion(stored!, { taskId: "dsh_task_d", executionId: "e2", execution: "turn_completed", turnSeq: 31 });
  assert.equal(second.written, true);
  assert.notEqual(second.eventId, first.eventId, "a new execution must have a new identity");

  const records = (await readdir(h.outbox)).filter((name) => name.endsWith(".json"));
  assert.equal(records.length, 2);
  const firstRecord = JSON.parse(await readFile(first.path, "utf8"));
  assert.equal(firstRecord.status, "pending");
  assert.equal(firstRecord.threadId, THREAD_A);
  assert.match(String(firstRecord.notification), /^\[coworker\]/);
  assert.match(String(firstRecord.eventId), /e1/);
  assert.doesNotMatch(String(firstRecord.eventId), /e2/);
});

test("a failing completion still produces one record with the failure name", async () => {
  const h = await home();
  const bindings = new CoworkerBindings(h.dir);
  await bindings.bind("dsh_task_e", { threadId: THREAD_A, outboxDir: h.outbox }, h.outbox, [h.outbox]);
  const stored = await bindings.get("dsh_task_e");
  assert.ok(stored);
  const written = await bindings.writeCompletion(stored!, { taskId: "dsh_task_e", executionId: "e1", execution: "failed", turnSeq: 4 });
  assert.equal(written.written, true);
  const record = JSON.parse(await readFile(written.path, "utf8"));
  assert.equal(record.execution, "failed");
  assert.match(String(record.notification), /状态 failed/);
});

test("a damaged existing record is left in place rather than overwritten", async () => {
  const h = await home();
  const bindings = new CoworkerBindings(h.dir);
  await bindings.bind("dsh_task_f", { threadId: THREAD_A, outboxDir: h.outbox }, h.outbox, [h.outbox]);
  const stored = await bindings.get("dsh_task_f");
  assert.ok(stored);
  const eventId = "dsh_task_f:e1:turn_completed";
  const path = join(h.outbox, `${eventId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  await writeFile(path, "{ not json", "utf8");
  const written = await bindings.writeCompletion(stored!, { taskId: "dsh_task_f", executionId: "e1", execution: "turn_completed" });
  assert.equal(written.written, false);
  assert.equal(await readFile(path, "utf8"), "{ not json");
});
