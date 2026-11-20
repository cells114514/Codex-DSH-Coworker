/**
 * Background sender: consume the durable coworker outbox written by the bridge.
 *
 * The bridge never sends anything; it only persists one record per terminal
 * execution. This process reads those records and delivers them through the
 * notifier, so all the delivery rules (per-event lock, STOP marker, receipt
 * verification, delivery_unknown without retry) stay in one place.
 *
 * Records are already terminal, so `--assume-terminal` skips bridge polling:
 * the sender must not depend on any observation call to make progress.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const options = { outbox: undefined, kernel: undefined, stub: undefined, once: false, intervalSec: 5, max: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--outbox": options.outbox = resolve(next()); break;
      case "--kernel": options.kernel = resolve(next()); break;
      case "--stub": options.stub = resolve(next()); break;
      case "--interval": options.intervalSec = Number(next()); break;
      case "--max": options.max = Number(next()); break;
      case "--once": options.once = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (!options.help && options.outbox === undefined) throw new Error("--outbox is required");
  return options;
}

const notifier = resolve("docs/operator-tools/coworker-notify.mjs");

/** Freshness marker so a binding can tell "sender running" from "sender absent". */
async function heartbeat(outbox) {
  await mkdir(outbox, { recursive: true }).catch(() => undefined);
  try {
    await writeFile(join(outbox, ".sender-heartbeat"), `${process.pid} ${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A read-only outbox is reported by the delivery records, not here.
  }
}

async function pendingRecords(outbox) {
  let names = [];
  try {
    names = await readdir(outbox);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(outbox, name);
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record?.status !== "pending") continue;
      if (typeof record.eventId !== "string" || typeof record.taskId !== "string" || typeof record.threadId !== "string") continue;
      if (!["turn_completed", "failed", "interrupted", "canceled"].includes(record.execution)) continue;
      records.push({ path, record });
    } catch {
      // A damaged record must stay untouched for the operator to inspect.
      continue;
    }
  }
  return records.sort((left, right) => String(left.record.createdAt).localeCompare(String(right.record.createdAt)));
}

function recordPathFor(outbox, eventId) {
  // Same sanitized name the notifier would use; passing it keeps evidence in one file.
  return join(outbox, `${String(eventId).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function deliver(options, record) {
  return new Promise((resolveRun) => {
    const args = [
      notifier,
      "--task", record.taskId,
      "--thread", record.threadId,
      "--outbox", options.outbox,
      "--event-id", record.eventId,
      "--record-path", recordPathFor(options.outbox, record.eventId),
      "--assume-terminal", record.execution,
      "--stage-limit", "5",
    ];
    if (options.stub !== undefined) args.push("--stub", options.stub);
    if (options.kernel !== undefined) args.push("--kernel", options.kernel);
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: options.stub === undefined ? { ...process.env, COWORKER_QUEUE_STUB: "" } : { ...process.env, COWORKER_QUEUE_STUB: options.stub },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("exit", (code) => {
      let report = null;
      try { report = JSON.parse(stdout); } catch { report = null; }
      resolveRun({ code, status: report?.status ?? null, eventId: record.eventId, messageId: report?.messageId ?? null });
    });
  });
}

async function loop(options) {
  const results = [];
  for (let round = 0; round < (options.once ? 1 : Number.MAX_SAFE_INTEGER); round += 1) {
    await heartbeat(options.outbox);
    const records = (await pendingRecords(options.outbox)).slice(0, options.max);
    if (records.length === 0) {
      if (options.once) break;
      await new Promise((done) => setTimeout(done, options.intervalSec * 1_000));
      continue;
    }
    for (const { path, record } of records) {
      const outcome = await deliver(options, record);
      results.push(outcome);
      // Reflect the delivery outcome into the source record so a later pass
      // cannot pick the same completion up again.
      try {
        // The notifier writes its own evidence (receipt, reason) into the same file
        // while we wait; re-read it so our write-back cannot erase that evidence.
        const fresh = await readFile(path, "utf8").then((text) => JSON.parse(text), () => record);
        const updated = {
          ...record,
          ...fresh,
          // Never drop the receipt identity: the exact message id and thread are
          // what a later consumption check has to look for.
          ...(typeof outcome.messageId === "string" ? { messageId: outcome.messageId } : {}),
          status: outcome.status ?? (outcome.code === 0 ? "acknowledged" : "delivery_unknown"),
          deliveredAt: new Date().toISOString(),
        };
        await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Leaving the record pending is safe: the notifier's own record dedupes it.
      }
    }
    if (options.once) break;
  }
  process.stdout.write(`${JSON.stringify({ outbox: options.outbox, results }, null, 2)}\n`);
  return results.every((entry) => entry.status === "acknowledged" || entry.status === "deduplicated" || entry.code === 0) ? 0 : 1;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("coworker-sender --outbox <dir> [--kernel <exe>|--stub <mjs>] [--once] [--interval 5]\n");
  process.exitCode = 0;
} else {
  process.exitCode = await loop(options);
}
