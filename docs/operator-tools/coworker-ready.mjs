/**
 * Sender readiness probe for the isolated live acceptance.
 *
 * A sender is ready only when all of the following hold for the *same* outbox:
 *   - the directory resolves to the same canonical absolute path we intended;
 *   - a heartbeat exists, is fresh, and names the pid of the sender we started;
 *   - no STOP marker is present;
 *   - the child process has not exited.
 *
 * A leftover heartbeat from an earlier launch therefore cannot make a dead or
 * not-yet-started sender look ready.
 */
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function probeSenderReady(options) {
  const outbox = resolve(options.outbox);
  const freshMs = options.freshMs ?? 5_000;

  let canonical;
  try {
    canonical = realpathSync.native(outbox);
  } catch {
    return { ready: false, reason: "outbox-missing", detail: { outbox } };
  }
  if (
    options.expectCanonical !== undefined &&
    resolve(options.expectCanonical).toLowerCase() !== canonical.toLowerCase()
  ) {
    return { ready: false, reason: "outbox-path-mismatch", detail: { outbox, canonical, expectCanonical: options.expectCanonical } };
  }

  const stopFile = join(canonical, "STOP");
  try {
    await stat(stopFile);
    return { ready: false, reason: "stopped", detail: { stopFile } };
  } catch {
    // absent STOP is the healthy case
  }

  if (options.exited === true) {
    return { ready: false, reason: "sender-exited", detail: { pid: options.pid ?? null, code: options.exitCode ?? null } };
  }

  const heartbeatPath = join(canonical, ".sender-heartbeat");
  let heartbeat;
  try {
    heartbeat = await readFile(heartbeatPath, "utf8");
  } catch {
    return { ready: false, reason: "heartbeat-missing", detail: { heartbeatPath } };
  }

  const [rawPid] = heartbeat.trim().split(/\s+/);
  const heartbeatPid = Number.parseInt(rawPid ?? "", 10);
  if (!Number.isInteger(heartbeatPid) || heartbeatPid <= 0) {
    return { ready: false, reason: "heartbeat-unparsable", detail: { heartbeat } };
  }
  if (options.pid !== undefined && heartbeatPid !== options.pid) {
    return { ready: false, reason: "heartbeat-pid-mismatch", detail: { expected: options.pid, actual: heartbeatPid } };
  }

  const stats = await stat(heartbeatPath);
  const ageMs = Date.now() - stats.mtimeMs;
  if (ageMs > freshMs) {
    return { ready: false, reason: "heartbeat-stale", detail: { ageMs, freshMs } };
  }

  return { ready: true, reason: "ready", detail: { outbox: canonical, pid: heartbeatPid, ageMs } };
}

/**
 * Bounded wait for readiness. Never sleeps a fixed amount: it polls the probe
 * until the deadline and reports the last reason when it gives up.
 */
export async function waitForSenderReady(options) {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const intervalMs = options.intervalMs ?? 200;
  let last = { ready: false, reason: "not-probed" };
  while (Date.now() < deadline) {
    last = await probeSenderReady(options);
    if (last.ready === true) return last;
    if (last.reason === "stopped" || last.reason === "sender-exited" || last.reason === "outbox-path-mismatch") {
      return last;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  return { ...last, reason: `${last.reason}-timeout` };
}
