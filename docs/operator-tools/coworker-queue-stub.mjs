/**
 * Local stand-in for `codex queue`, used only by the notifier's state-machine
 * tests. It appends one JSON line per invocation to COWORKER_STUB_LOG and prints
 * a success line, so tests can count attempts without touching the real queue.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const logPath = process.env.COWORKER_STUB_LOG;
const mode = process.env.COWORKER_STUB_MODE ?? "ok";
const threadIndex = argv.indexOf("--thread");
const messageIndex = argv.indexOf("--message");
const thread = threadIndex >= 0 ? argv[threadIndex + 1] : null;
const message = messageIndex >= 0 ? argv[messageIndex + 1] : null;

if (logPath !== undefined) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), argv: ["queue"], threadPrefix: typeof thread === "string" ? `${thread.slice(0, 8)}…` : null, messageLength: typeof message === "string" ? message.length : 0, mode })}\n`,
    "utf8",
  );
}

if (mode === "lost-receipt") {
  // Accepted by the queue, but the receipt is lost: exit 0 with no usable output.
  process.exit(0);
}
if (mode === "reject") {
  process.stderr.write("stub: queue rejected the message\n");
  process.exit(1);
}
if (mode === "commit-then-error") {
  if (process.env.COWORKER_STUB_COMMIT_LOG) {
    appendFileSync(process.env.COWORKER_STUB_COMMIT_LOG, "accepted\n", "utf8");
  }
  process.stderr.write("stub: failed after insertion, before acknowledgement\n");
  process.exit(1);
}
const messageId = process.env.COWORKER_STUB_MESSAGE_ID ?? "11111111-2222-4333-8444-555555555555";
const receiptThread = process.env.COWORKER_STUB_RECEIPT_THREAD ?? thread;
process.stdout.write(`Queued message ${messageId} for thread ${receiptThread}.`);
process.exit(0);
