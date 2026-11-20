/**
 * Shutdown-path assertions: the driver must close, wait, and report — never
 * assume a stop happened. Real child processes, no model, no queue.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";

import { shutdownAll, waitForExit } from "../docs/operator-tools/coworker-lifecycle.mjs";

const children = [];
after(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});

function spawnChild(script) {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true });
  children.push(child);
  return child;
}

describe("shutdown path", () => {
  it("waits for a bridge process to exit and reports it", async () => {
    const child = spawnChild("setTimeout(() => process.exit(0), 300);");
    const report = await shutdownAll({ client: { close: async () => undefined }, sender: spawnChild("setInterval(() => {}, 1000);") });
    const exited = await waitForExit(child, 3_000);
    assert.equal(exited.exited, true);
    assert.equal(report.clientClosed, true);
    assert.equal(report.confirmed, true, JSON.stringify(report));
  });

  it("reports an unconfirmed stop when the bridge never exits", async () => {
    const bridge = spawnChild("setInterval(() => {}, 1000);");
    const report = await shutdownAll({
      client: { close: async () => undefined },
      bridgeChild: bridge,
      bridgeTimeoutMs: 400,
      sender: spawnChild("setInterval(() => {}, 1000);"),
      senderTimeoutMs: 400,
    });
    assert.equal(report.confirmed, false, "a stop that cannot be proven is not clean");
    assert.equal(report.bridge?.reason, "timeout");
  });

  it("reports a client close failure instead of swallowing it", async () => {
    const report = await shutdownAll({
      client: { close: async () => { throw new Error("rpc close failed"); } },
      sender: spawnChild("setInterval(() => {}, 1000);"),
      senderTimeoutMs: 400,
    });
    assert.equal(report.clientClosed, false);
    assert.equal(report.confirmed, false);
    assert.match(report.errors.join(" "), /client-close: rpc close failed/);
  });

  it("is safe when the sender was already gone", async () => {
    const sender = spawnChild("process.exit(0);");
    await new Promise((done) => sender.once("exit", done));
    const report = await shutdownAll({ client: { close: async () => undefined }, sender });
    assert.equal(report.sender?.exited, true);
    assert.equal(report.confirmed, true);
  });
});
