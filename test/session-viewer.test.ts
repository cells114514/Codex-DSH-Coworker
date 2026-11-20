/**
 * Read-only session viewer: listings, event tails, integrity flags, and the
 * guarantee that it never serves anything outside the bridge home.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createViewerServer } from "../tools/session-viewer.mjs";

const TASK = "dsh_aaaabbbbcccc";
const THREAD = "11111111-2222-4333-8444-555555555555";
let root;
let server;
let base;

async function get(path) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "viewer-"));
  const home = join(root, "bridge-home");
  await mkdir(join(home, "tasks"), { recursive: true });
  await mkdir(join(home, "runtimes"), { recursive: true });
  await mkdir(join(home, "observed", TASK), { recursive: true });
  await mkdir(join(home, "coworker"), { recursive: true });
  await mkdir(join(home, "coworker-outbox"), { recursive: true });
  await writeFile(join(home, "tasks", `${TASK}.json`), JSON.stringify({ taskId: TASK, sessionId: "sess-1" }));
  await writeFile(
    join(home, "runtimes", `${TASK}.json`),
    JSON.stringify({ owner: { bridgeInstanceId: "inst", pid: 1, startedAt: "x" }, canonicalCwd: "C:\\work", cleanShutdown: true, diagnostic: { runtimePid: 42 } }),
  );
  await writeFile(
    join(home, "observed", TASK, "events.jsonl"),
    [
      JSON.stringify({ type: "user/message", seq: 1, data: { text: "hello" } }),
      JSON.stringify({ type: "tool/call", seq: 2, data: { name: "read" } }),
    ].join("\n"),
  );
  await writeFile(join(home, "observed", TASK, "coverage.json"), JSON.stringify({ complete: false, observedCount: 2, lastObservedRootSeq: 2 }));
  await writeFile(join(home, "coworker", `${TASK}.json`), JSON.stringify({ taskId: TASK, threadId: THREAD, outboxDir: "x" }));
  await writeFile(
    join(home, "coworker-outbox", `${TASK}_e1_turn_completed.json`),
    JSON.stringify({ eventId: `${TASK}:e1:turn_completed`, taskId: TASK, executionId: "e1", threadId: THREAD, status: "pending" }),
  );
  // A file outside the bridge home that must never be served.
  await writeFile(join(root, "secret.txt"), "TOP-SECRET");

  server = createViewerServer({ bridgeHome: home });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
});

describe("session viewer", () => {
  it("lists tasks with session, notification and integrity state", async () => {
    const { status, body } = await get("/api/tasks");
    assert.equal(status, 200);
    const task = body.find((entry) => entry.taskId === TASK);
    assert.ok(task);
    assert.equal(task.sessionId, "sess-1");
    assert.equal(task.cwd, "C:\\work");
    assert.equal(task.notification.bound, true);
    assert.equal(task.notification.pending, true);
    assert.equal(task.integrity.coverageComplete, false);
    assert.match(String(task.integrity.note), /观察缺口/);
  });

  it("tails observed events and reports coverage", async () => {
    const { body } = await get(`/api/task/${TASK}/events?since=0`);
    assert.equal(body.events.length, 2);
    assert.equal(body.events[1].type, "tool/call");
    assert.equal(body.integrity.coverageComplete, false);
    const tail = await get(`/api/task/${TASK}/events?since=1`);
    assert.equal(tail.body.events.length, 1);
  });

  it("rejects ids that could escape the bridge home", async () => {
    const { status } = await get(`/api/task/${encodeURIComponent("../../secret")}/events`);
    assert.equal(status, 400);
    const missing = await get("/api/task/dsh_ffffffffffff/events");
    assert.equal(missing.status, 200);
    assert.equal(missing.body.events.length, 0);
    assert.equal(missing.body.integrity.coverageComplete, null);
  });

  it("is read-only", async () => {
    const response = await fetch(`${base}/api/tasks`, { method: "POST" });
    assert.equal(response.status, 405);
  });

  it("serves the page shell without any write affordance", async () => {
    const { status, body } = await get("/");
    assert.equal(status, 200);
    assert.match(body, /SDK 会话记录/);
    assert.doesNotMatch(body, /method="post"/i);
  });
});

describe("display normaliser", () => {
  it("extracts user and assistant text instead of raw JSON", async () => {
    const { toDisplayItem } = await import("../tools/session-viewer.mjs");
    const user = toDisplayItem({ event: { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "帮我改一下" }] } } });
    assert.equal(user.kind, "user");
    assert.equal(user.text, "帮我改一下");
    const assistant = toDisplayItem({
      event: { type: "assistant/message", seq: 2, data: { message: { content: [{ type: "text", text: "好了" }], source: { model: "deepseek-v4.1-flash" } }, usage: { inputTokens: 10, outputTokens: 2 } } },
    });
    assert.equal(assistant.kind, "assistant");
    assert.equal(assistant.text, "好了");
    assert.match(String(assistant.meta), /flash/);
  });

  it("summarises tool calls and hides technical noise by default", async () => {
    const { toDisplayItem } = await import("../tools/session-viewer.mjs");
    const tool = toDisplayItem({ event: { type: "tool/call", seq: 3, data: { name: "read", arguments: { path: "src/a.ts" } } } });
    assert.equal(tool.kind, "tool");
    assert.match(tool.title, /read/);
    assert.match(tool.text, /src\/a\.ts/);
    const noise = toDisplayItem({ event: { type: "permission/preset", seq: 0, data: { preset: "workspace-write" } } });
    assert.equal(noise.kind, "noise");
    assert.equal(toDisplayItem({ malformed: true, raw: "not json" }).kind, "warning");
  });
});