/**
 * Readiness-probe assertions. Each case drives real files (and, where needed, a
 * real child process) but never a model, a queue, or a notification.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { probeSenderReady, waitForSenderReady } from "../docs/operator-tools/coworker-ready.mjs";

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function outboxWith(files = {}) {
  const root = await mkdtemp(join(tmpdir(), "cw-ready-"));
  const outbox = join(root, "coworker-outbox");
  await mkdir(outbox, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(outbox, name), body, "utf8");
  }
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return { root, outbox };
}

describe("sender readiness probe", () => {
  it("reports a missing heartbeat before the sender starts", async () => {
    const { outbox } = await outboxWith();
    const result = await probeSenderReady({ outbox, pid: 4242 });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "heartbeat-missing");
  });

  it("does not accept a leftover heartbeat from another launch", async () => {
    const { outbox } = await outboxWith({ ".sender-heartbeat": "999999 2026-01-01T00:00:00.000Z\n" });
    const result = await probeSenderReady({ outbox, pid: 4242 });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "heartbeat-pid-mismatch");
    assert.equal(result.detail.expected, 4242);
    assert.equal(result.detail.actual, 999999);
  });

  it("rejects a stale heartbeat even when the pid matches", async () => {
    const { outbox } = await outboxWith();
    const heartbeat = join(outbox, ".sender-heartbeat");
    await writeFile(heartbeat, "4242 2026-01-01T00:00:00.000Z\n", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(heartbeat, old, old);
    const result = await probeSenderReady({ outbox, pid: 4242, freshMs: 5_000 });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "heartbeat-stale");
  });

  it("stops when the STOP marker exists", async () => {
    const { outbox } = await outboxWith({ STOP: "stopped\n" });
    const result = await probeSenderReady({ outbox, pid: 4242 });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "stopped");
  });

  it("stops when the sender exits early", async () => {
    const { outbox } = await outboxWith();
    const result = await probeSenderReady({ outbox, pid: 4242, exited: true, exitCode: 3 });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "sender-exited");
    assert.equal(result.detail.code, 3);
  });

  it("becomes ready only after the delayed heartbeat appears", async () => {
    const { outbox } = await outboxWith();
    const sender = spawn(process.execPath, ["-e", `
      const { writeFileSync } = require("node:fs");
      setTimeout(() => writeFileSync(${JSON.stringify(join(outbox, ".sender-heartbeat"))}, process.pid + " " + new Date().toISOString() + "\\n"), 600);
      setInterval(() => writeFileSync(${JSON.stringify(join(outbox, ".sender-heartbeat"))}, process.pid + " " + new Date().toISOString() + "\\n"), 500);
    `], { stdio: "ignore", windowsHide: true });
    cleanups.push(async () => sender.kill());
    const began = Date.now();
    const result = await waitForSenderReady({ outbox, pid: sender.pid, timeoutMs: 8_000, intervalMs: 100 });
    const elapsed = Date.now() - began;
    assert.equal(result.ready, true, String(result.reason));
    assert.ok(elapsed >= 400, `must wait for the heartbeat to appear, waited ${elapsed}ms`);
  });

  it("times out with a reason when no sender ever writes a heartbeat", async () => {
    const { outbox } = await outboxWith();
    const result = await waitForSenderReady({ outbox, pid: 4242, timeoutMs: 700, intervalMs: 100 });
    assert.equal(result.ready, false);
    assert.match(String(result.reason), /timeout/);
  });
});
