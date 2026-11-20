/**
 * Dedupe proof: run the notifier against an already-acknowledged event id and
 * verify that nothing was queued and no Codex turn appeared.
 *
 * Measures three read-only observables before and after:
 *   - queued rows for the thread (and the queue revision)
 *   - the thread's turn count
 *   - the notifier's own outbox record status
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const kernel = process.env.D_EXECUTABLE;
const threadId = process.env.D_THREAD_ID;
const taskId = process.env.D_TASK;
const eventId = process.env.D_EVENT_ID;
const home = process.env.D_HOME;
const outbox = process.env.D_OUTBOX;
const notifier = process.env.D_NOTIFIER;

function queueState() {
  const db = new DatabaseSync(join(homedir(), ".codex", "queue_1.sqlite"), { readOnly: true });
  const rows = db.prepare("select id from queued_items where thread_id = ?").all(threadId);
  const revision = db.prepare("select revision from queued_thread_revisions where thread_id = ?").get(threadId);
  db.close();
  return { pendingRows: rows.length, revision: revision?.revision ?? null };
}

function readTurns() {
  return new Promise((resolveRead) => {
    const server = spawn(kernel, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    let id = 1;
    const pending = new Map();
    let buffer = "";
    server.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          message.error ? entry.reject(message.error) : entry.resolve(message.result);
        }
      }
    });
    const request = (method, params) => new Promise((resolveCall, rejectCall) => {
      const callId = id++;
      pending.set(callId, { resolve: resolveCall, reject: rejectCall });
      server.stdin.write(`${JSON.stringify({ method, id: callId, params })}\n`);
    });
    (async () => {
      try {
        await request("initialize", { clientInfo: { name: "dedupe-check", title: "dedupe", version: "0.0.0" }, capabilities: { experimentalApi: true } });
        server.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const read = await request("thread/read", { threadId, includeTurns: true });
        const thread = read.thread ?? read;
        resolveRead({ turnCount: (thread.turns ?? []).length });
      } catch (error) {
        resolveRead({ error: String(error?.message ?? error).slice(0, 160) });
      } finally {
        try { server.stdin.end(); } catch {}
        setTimeout(() => { try { server.kill(); } catch {} }, 200);
      }
    })();
  });
}

function outboxStatus() {
  try {
    const name = `${eventId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
    const record = JSON.parse(readFileSync(join(outbox, name), "utf8"));
    return { file: name, status: record.status ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 120), files: readdirSync(outbox).slice(0, 5) };
  }
}

function runNotifier() {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [
      notifier,
      "--task", taskId,
      "--thread", threadId,
      "--home", home,
      "--outbox", outbox,
      "--kernel", kernel,
      "--event-id", eventId,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolveRun({ code, stdout: stdout.trim(), stderr: stderr.trim().slice(0, 200) }));
  });
}

const before = { queue: queueState(), turns: await readTurns(), outbox: outboxStatus() };
const run = await runNotifier();
await new Promise((resolve) => setTimeout(resolve, 5_000));
const after = { queue: queueState(), turns: await readTurns(), outbox: outboxStatus() };

let parsed = null;
try { parsed = JSON.parse(run.stdout); } catch { parsed = null; }

console.log(JSON.stringify({
  eventId,
  exitCode: run.code,
  notifierStatus: parsed?.status ?? null,
  deduplicated: parsed?.deduplicated ?? null,
  before,
  after,
  noNewQueueRow: before.queue.pendingRows === after.queue.pendingRows && after.queue.pendingRows === 0,
  queueRevisionUnchanged: before.queue.revision === after.queue.revision,
  noNewCodexTurn: before.turns.turnCount === after.turns.turnCount,
}, null, 2));
