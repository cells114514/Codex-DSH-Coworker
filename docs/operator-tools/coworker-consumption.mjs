/**
 * Consumption check for one queued notification.
 *
 * Queue acceptance is not consumption, and a disappearing row is not proof that
 * the model read anything. This probe waits (bounded) for the *exact* message id
 * in the *exact* thread, then reports the later stages separately:
 * accepted -> consumed -> chat turn added -> MCP read.
 */
import { DatabaseSync } from "node:sqlite";

const STAGES = ["accepted", "consumed", "chatTurnAdded", "mcpRead"];

export function readQueuedRow({ queueDb, messageId, threadId }) {
  const db = new DatabaseSync(queueDb, { readOnly: true });
  try {
    const row = db
      .prepare("select id, thread_id, queue_order, created_at_ms from queued_items where id = ? and thread_id = ?")
      .get(messageId, threadId);
    const revision = (db.prepare("select revision from queued_thread_revisions where thread_id = ?").get(threadId) ?? {})
      .revision;
    const threadRows = db.prepare("select id from queued_items where thread_id = ?").all(threadId).length;
    return { row: row ?? null, revision, threadRows };
  } finally {
    db.close();
  }
}

/**
 * Bounded wait for the row to leave the queue. Never calls the model or any MCP
 * observation tool: it only reads the local queue database.
 */
export async function waitForConsumption(options) {
  const { queueDb, messageId, threadId } = options;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const began = Date.now();
  let seenAccepted = options.acceptedByReceipt === true;
  let last = null;

  while (Date.now() - began <= timeoutMs) {
    last = readQueuedRow({ queueDb, messageId, threadId });
    if (last.row !== null) seenAccepted = true;
    if (seenAccepted && last.row === null) {
      return {
        status: "consumed",
        observation: options.acceptedByReceipt === true ? "row-absent-after-acknowledged-receipt" : "row-left-queue",
        messageId,
        threadId,
        elapsedMs: Date.now() - began,
        revision: last.revision,
        stages: { accepted: true, consumed: true, chatTurnAdded: null, mcpRead: null },
      };
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }

  return {
    status: seenAccepted ? "consumption_timeout" : "never_accepted",
    messageId,
    threadId,
    elapsedMs: Date.now() - began,
    row: last?.row ?? null,
    revision: last?.revision ?? null,
    threadRows: last?.threadRows ?? null,
    stages: { accepted: seenAccepted, consumed: false, chatTurnAdded: false, mcpRead: false },
    note:
      "The row is still queued (or was never visible). This is not evidence about the app window; it only means no consumer took the message in the window.",
  };
}

export const consumptionStages = STAGES;
