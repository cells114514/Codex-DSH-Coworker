/**
 * Coworker notifier (route 1): watch one SDK task through the existing MCP
 * bridge and, when it reaches a terminal state, send exactly one fixed
 * notification into the original Codex chat via `codex queue`.
 *
 * Contract (accepted by the operator, recorded in docs):
 *   - The notification is a USER bubble in Codex. It is NOT a tool message and
 *     NOT a native external-tool channel.
 *   - Its text is fixed and carries only the task id and event id. It never
 *     carries DSH-authored instructions and grants no authorization.
 *   - Real content is read by Codex through the MCP tools (dsh_status /
 *     dsh_followup), not through the notification body.
 *   - At most one notification per (taskId, execution, cursor). No retry on an
 *     ambiguous send: the record stays `delivery_unknown`.
 *
 * State machine, per event:
 *
 *   (absent) --lock--> pending --sending--> acknowledged
 *                                    |--> delivery_unknown    (no validated success,
 *                                                              including non-zero exit)
 *   STOP present   --> suppressed-after-stop (no send, exit 2)
 *   unreadable outbox --> outbox_unreadable  (no send, exit 3)
 *   lock held by another process --> locked (no send, exit 4)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseArgs(argv) {
  const options = {
    task: undefined,
    thread: undefined,
    home: undefined,
    bridge: resolve(process.cwd(), "dist", "index.js"),
    outbox: undefined,
    kernel: undefined,
    stub: process.env.COWORKER_QUEUE_STUB === undefined || process.env.COWORKER_QUEUE_STUB === "" ? undefined : process.env.COWORKER_QUEUE_STUB,
    stopFile: undefined,
    stageLimitSec: 900,
    eventId: undefined,
    recordPath: undefined,
    assumeTerminal: undefined,
    lockWaitMs: 2_000,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--task": options.task = next(); break;
      case "--thread": options.thread = next(); break;
      case "--home": options.home = resolve(next()); break;
      case "--bridge": options.bridge = resolve(next()); break;
      case "--outbox": options.outbox = resolve(next()); break;
      case "--kernel": options.kernel = resolve(next()); break;
      case "--stub": options.stub = resolve(next()); break;
      case "--stop-file": options.stopFile = resolve(next()); break;
      case "--stage-limit": options.stageLimitSec = Number(next()); break;
      case "--event-id": options.eventId = next(); break;
      case "--assume-terminal": options.assumeTerminal = next(); break;
      case "--lock-wait": options.lockWaitMs = Number(next()); break;
      case "--dry-run": options.dryRun = true; break;
      case "--record-path": options.recordPath = resolve(next()); break;
      case "--help":
      case "-h": options.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (!options.help && (options.task === undefined || options.thread === undefined)) {
    throw new Error("--task and --thread are required");
  }
  return options;
}

/** Fixed notification text: identifiers only, no DSH-authored prose. */
export function notificationText(taskId, eventId, execution) {
  return `[coworker] 事件 ${eventId} / 任务 ${taskId} / 状态 ${execution}。用 dsh_status 读取结果。`;
}

function safeKey(eventKey) {
  return eventKey.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function outboxPath(outbox, eventKey) {
  return join(outbox, `${safeKey(eventKey)}.json`);
}

function lockPath(outbox, eventKey) {
  return join(outbox, `.${safeKey(eventKey)}.lock`);
}

/**
 * Only a missing file means "no record". Corruption, permission problems and
 * every other read error stop the run instead of being treated as absence.
 */
async function readOutboxStrict(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: `${error?.code ?? "unknown"}: ${String(error?.message ?? error).slice(0, 120)}` };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return { state: "unreadable", reason: "not-an-object" };
    return { state: "present", record: parsed };
  } catch (error) {
    return { state: "unreadable", reason: `invalid-json: ${String(error?.message ?? error).slice(0, 100)}` };
  }
}

/** Atomic write: temp file in the same directory, then rename over the target. */
async function writeOutbox(path, record) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

/**
 * Cross-process mutual exclusion for check -> transition -> send.
 * `wx` fails when the file exists, so exactly one process can own the event.
 */
async function acquireLock(outbox, eventKey, waitMs) {
  const path = lockPath(outbox, eventKey);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      await handle.close();
      return { owned: true, path };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // A stale lock from a crashed run is deliberately NOT stolen: it means the
      // previous send's outcome is unknown.
      if (Date.now() >= deadline) return { owned: false, path, reason: "lock-held" };
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

async function releaseLock(path) {
  await rm(path, { force: true }).catch(() => undefined);
}

async function sendQueue(kernel, threadId, text, stub) {
  // `--stub` runs a local stand-in instead of the Codex kernel, so state-machine
  // tests never touch the real queue or wake a chat.
  const command = stub === undefined ? kernel : process.execPath;
  const argv = stub === undefined
    ? ["queue", "--thread", threadId, "--message", text]
    : [stub, "queue", "--thread", threadId, "--message", text];
  return new Promise((resolveSend) => {
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => resolveSend({ code, signal, stdout: stdout.trim().slice(0, 400), stderr: stderr.trim().slice(0, 200) }));
    child.on("error", (error) => resolveSend({ code: null, signal: null, error: String(error?.message ?? error).slice(0, 200) }));
  });
}

/**
 * A confirmation is only trusted when it names a message id AND the requested
 * thread. Anything else is an unknown outcome.
 */
/**
 * Diagnostics must not carry authorization or conversation content: only the shape
 * of the kernel output is useful, so tokens, authorization headers, token-bearing
 * URLs and the notification text itself are removed before anything is stored.
 */
function redactKernelOutput(text, secrets = []) {
  let value = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) value = value.split(secret).join("[redacted]");
  }
  return value
    .replace(/(authorization\s*[:=]\s*)[^\s"']+/gi, "$1[redacted]")
    .replace(/((?:token|api[-_]?key|secret|password|cookie)\s*[:=]\s*)[^\s"'&]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^\s"'?]+\?[^\s"']*?)(token|key|sig|signature)=[^\s"'&]+/gi, "$1$2=[redacted]")
    .replace(/\[coworker\][^\n]*/g, "[coworker] [redacted]")
    .slice(0, 300);
}
function parseReceipt(sent, threadId) {
  if (sent.error !== undefined) return { trusted: false, reason: `spawn-error: ${sent.error}` };
  if (sent.signal !== null && sent.signal !== undefined) return { trusted: false, reason: `signal: ${sent.signal}` };
  // An exit status cannot prove that queue insertion did not happen first.
  if (sent.code !== 0) return { trusted: false, reason: `nonzero-exit: ${sent.code}` };
  const match = /Queued message\s+([0-9a-fA-F-]{8,})\s+for thread\s+([0-9a-fA-F-]{8,})\s*\.?\s*$/.exec(sent.stdout);
  if (match === null) return { trusted: false, reason: "no-parseable-receipt" };
  const [, messageId, receiptThread] = match;
  if (receiptThread !== threadId) {
    return { trusted: false, reason: `thread-mismatch: ${receiptThread.slice(0, 8)}…` };
  }
  return { trusted: true, messageId };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${notificationText("<taskId>", "<eventId>", "<execution>")}\n`);
    return 0;
  }
  const outbox = options.outbox ?? join(options.home ?? process.cwd(), "coworker-outbox");
  await mkdir(outbox, { recursive: true });

  const env = { ...process.env, DSH_HOST_PROTOCOL: "sdk", DSH_REQUEST_TIMEOUT_MS: String(options.stageLimitSec * 1_000) };
  if (options.home !== undefined) env.DSH_HOME = options.home;
  const transport = new StdioClientTransport({ command: process.execPath, args: [options.bridge], env, stderr: "ignore" });
  const client = new Client({ name: "coworker-notifier", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result?.content?.find((item) => item.type === "text")?.text ?? "{}";
    try {
      return { isError: result.isError === true, body: JSON.parse(text) };
    } catch {
      return { isError: result.isError === true, body: { unparsed: true } };
    }
  };

  const began = Date.now();
  let last = {};
  const deadline = Date.now() + options.stageLimitSec * 1_000;
  // Test seam: state-machine cases do not need a live task, and must never
  // spend a model call to reach the terminal branch.
  if (options.assumeTerminal !== undefined) {
    last = { execution: options.assumeTerminal, cursor: 1 };
  } else while (Date.now() < deadline) {
    const status = await call("dsh_status", { taskId: options.task });
    last = status.body;
    if (["turn_completed", "failed", "interrupted", "canceled"].includes(last.execution)) break;
    await new Promise((done) => setTimeout(done, 1_000));
  }

  const execution = last.execution ?? "unknown";
  const terminal = ["turn_completed", "failed", "interrupted", "canceled"].includes(execution);
  const pointer = last.finalMessagePointer;
  const pointerKey =
    typeof pointer === "number" || typeof pointer === "string"
      ? String(pointer)
      : pointer === undefined || pointer === null
        ? "none"
        : `h${[...JSON.stringify(pointer)].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 0xffffffff, 7).toString(36)}`;
  const eventId = options.eventId ?? `${options.task}:${execution}:${last.cursor ?? pointerKey}`;
  // The sender may hand us the exact record file so its write-back keeps the evidence.
  const path = options.recordPath ?? outboxPath(outbox, eventId);

  const report = { taskId: options.task, execution, terminal, elapsedMs: Date.now() - began, eventId, outbox: path };

  if (!terminal) {
    report.status = "not-terminal";
    await client.close().catch(() => undefined);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }

  const stopFile = options.stopFile ?? join(outbox, "STOP");
  const stopMarker = existsSync(stopFile);
  if (stopMarker) {
    report.status = "suppressed-after-stop";
    report.stopped = true;
    await client.close().catch(() => undefined);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 2;
  }

  // Everything below is serialized per event across processes.
  const lock = await acquireLock(outbox, eventId, options.lockWaitMs);
  if (!lock.owned) {
    const current = await readOutboxStrict(path);
    report.status = "locked";
    report.reason = lock.reason;
    report.record = current.state === "present" ? current.record.status ?? null : current.state;
    await client.close().catch(() => undefined);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 4;
  }

  let exitCode = 1;
  try {
    const existing = await readOutboxStrict(path);
    if (existing.state === "unreadable") {
      // A damaged record must never be overwritten or treated as absent.
      report.status = "outbox_unreadable";
      report.reason = existing.reason;
      exitCode = 3;
      return exitCode;
    }
    if (existing.state === "present" && existing.record.status !== "pending") {
      report.status = existing.record.status;
      report.deduplicated = true;
      exitCode = 0;
      return exitCode;
    }

    const text = notificationText(options.task, eventId, execution);
    report.notification = text;

    if (options.dryRun || (options.kernel === undefined && options.stub === undefined)) {
      const record = existing.state === "present" ? existing.record : { eventId, taskId: options.task, execution, createdAt: new Date().toISOString() };
      record.status = "dry-run";
      await writeOutbox(path, record);
      report.status = "dry-run";
      exitCode = 0;
      return exitCode;
    }

    const record = existing.state === "present"
      ? existing.record
      : { eventId, taskId: options.task, execution, createdAt: new Date().toISOString(), status: "pending" };
    record.status = "sending";
    record.startedAt = new Date().toISOString();
    await writeOutbox(path, record);

    const sent = await sendQueue(options.kernel, options.thread, text, options.stub);
    // Test-only crash point: die after the send, before the outcome is stored.
    if (process.env.COWORKER_CRASH_AFTER_SEND === "1") {
      process.stderr.write("coworker-notifier: simulated crash after send\n");
      process.exit(70);
    }

    const receipt = parseReceipt(sent, options.thread);
    record.send = { exitCode: sent.code ?? null, signal: sent.signal ?? null, at: new Date().toISOString() };
    if (receipt.trusted) {
      record.status = "acknowledged";
      record.messageId = receipt.messageId;
      record.receiptThread = options.thread;
    } else {
      record.status = "delivery_unknown";
      record.reason = receipt.reason;
      // Keep what the kernel actually said: without it a failed receipt can only be
      // guessed at, and the record is the only place this evidence can survive.
      record.receipt = {
        reason: receipt.reason,
        code: sent.code ?? null,
        signal: sent.signal ?? null,
        stdout: redactKernelOutput(sent.stdout, [record.notification]),
        stderr: redactKernelOutput(sent.stderr, [record.notification]),
      };
    }
    await writeOutbox(path, record);
    report.status = record.status;
    report.messageId = typeof record.messageId === "string" ? record.messageId : null;
    report.messageIdPrefix = typeof record.messageId === "string" ? `${record.messageId.slice(0, 8)}…` : null;
    report.reason = record.reason ?? null;
    exitCode = record.status === "acknowledged" ? 0 : 1;
    return exitCode;
  } finally {
    await releaseLock(lock.path);
    await client.close().catch(() => undefined);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

const code = await main();
process.exitCode = code;
