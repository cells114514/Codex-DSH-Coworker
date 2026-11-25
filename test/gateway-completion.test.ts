/**
 * Gateway execution attribution: only a turn that consumed a durable submission
 * recorded by this bridge may settle, and history, duplicates and desktop-side
 * turns must never produce a completion.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GatewayCompletionTracker } from "../src/gateway-completion.js";

const TASK = "dsh_aaaabbbbcccc";
const SESSION = "sess-1";
const REQUEST = "req-bridge-1";

function trackerWithBaseline(baselineSeq = 10) {
  const tracker = new GatewayCompletionTracker();
  tracker.observeTask(TASK, SESSION, baselineSeq);
  return tracker;
}

function userMessage(seq: number, turn: number, requestId?: string) {
  return {
    type: "user/message",
    seq,
    data: { turn, content: [{ type: "text", text: "hi" }], ...(requestId === undefined ? {} : { source: { kind: "user", requestId } }) },
  };
}

function turnEnd(seq: number, turn: number) {
  return { type: "turn/end", seq, data: { turn, reason: { kind: "completed" } } };
}

describe("gateway completion attribution", () => {
  it("settles only the turn that consumed the bridge submission", () => {
    const tracker = trackerWithBaseline();
    tracker.begin(TASK, { sessionId: SESSION, executionId: "e1", requestId: REQUEST, baselineSeq: 10 });
    assert.equal(tracker.observe(TASK, userMessage(11, 2, REQUEST)).kind, "consumed");
    const terminal = tracker.observe(TASK, turnEnd(12, 2));
    assert.equal(terminal.kind, "terminal");
    assert.equal(terminal.kind === "terminal" ? terminal.executionId : "", "e1");
  });

  it("ignores history below the baseline", () => {
    const tracker = trackerWithBaseline();
    tracker.begin(TASK, { sessionId: SESSION, executionId: "e1", requestId: REQUEST, baselineSeq: 10 });
    assert.equal(tracker.observe(TASK, userMessage(3, 1, REQUEST)).kind, "ignored");
    assert.equal(tracker.observe(TASK, turnEnd(4, 1)).kind, "ignored");
  });

  it("ignores a desktop-side turn that no bridge submission names", () => {
    const tracker = trackerWithBaseline();
    tracker.begin(TASK, { sessionId: SESSION, executionId: "e1", requestId: REQUEST, baselineSeq: 10 });
    assert.equal(tracker.observe(TASK, userMessage(11, 2, "req-from-desktop")).kind, "ignored");
    const terminal = tracker.observe(TASK, turnEnd(12, 2));
    assert.equal(terminal.kind, "unattributed");
    assert.match(String(terminal.kind === "unattributed" ? terminal.reason : ""), /not-submitted|not-from-bridge/);
  });

  it("does not notify again for replayed or duplicate events", () => {
    const tracker = trackerWithBaseline();
    tracker.begin(TASK, { sessionId: SESSION, executionId: "e1", requestId: REQUEST, baselineSeq: 10 });
    tracker.observe(TASK, userMessage(11, 2, REQUEST));
    assert.equal(tracker.observe(TASK, turnEnd(12, 2)).kind, "terminal");
    assert.equal(tracker.observe(TASK, turnEnd(12, 2)).kind, "duplicate");
    assert.equal(tracker.observe(TASK, userMessage(11, 2, REQUEST)).kind, "ignored");
  });

  it("gives each round its own execution and ignores late messages on a settled one", () => {
    const tracker = trackerWithBaseline();
    tracker.begin(TASK, { sessionId: SESSION, executionId: "e1", requestId: REQUEST, baselineSeq: 10 });
    tracker.observe(TASK, userMessage(11, 2, REQUEST));
    tracker.observe(TASK, turnEnd(12, 2));
    tracker.begin(TASK, { sessionId: SESSION, executionId: "e2", requestId: "req-bridge-2", baselineSeq: 12 });
    assert.equal(tracker.observe(TASK, userMessage(13, 3, "req-bridge-2")).kind, "consumed");
    const second = tracker.observe(TASK, turnEnd(14, 3));
    assert.equal(second.kind, "terminal");
    assert.equal(second.kind === "terminal" ? second.executionId : "", "e2");
    assert.equal(tracker.observe(TASK, userMessage(15, 3, REQUEST)).kind, "ignored");
  });

  it("is idempotent for a repeated submission identity", () => {
    const tracker = trackerWithBaseline();
    const first = tracker.begin(TASK, { sessionId: SESSION, executionId: "e1", requestId: REQUEST, baselineSeq: 10 });
    const again = tracker.begin(TASK, { sessionId: SESSION, executionId: "e9", requestId: REQUEST, baselineSeq: 10 });
    assert.equal(again?.executionId, first?.executionId);
    assert.equal(tracker.state(TASK)?.executions.size, 1);
  });

  it("reports unattributed turns when nothing was submitted", () => {
    const tracker = trackerWithBaseline();
    const result = tracker.observe(TASK, turnEnd(11, 4));
    assert.equal(result.kind, "unattributed");
  });

  it("ignores events for a task it never observed", () => {
    const tracker = new GatewayCompletionTracker();
    assert.equal(tracker.observe("dsh_zzzzzzzzzzzz", turnEnd(1, 1)).kind, "ignored");
  });
});

describe("real gateway field structure", () => {
  // Shapes copied from the live ledger: user/message carries source.rpcId but no
  // turn; turn/start and turn/end carry data.turn; a terminal arrives last.
  const TASK2 = "dsh_gggggggggggg";
  const RPC = "c1a6c0e1-6dc4-4614-8ba2-ac8715ca8c5b";

  function liveTracker() {
    const tracker = new GatewayCompletionTracker();
    tracker.observeTask(TASK2, SESSION, 51);
    tracker.begin(TASK2, { sessionId: SESSION, executionId: "e1", requestId: RPC, baselineSeq: 51 });
    return tracker;
  }

  it("attributes a message that carries rpcId instead of requestId", () => {
    const tracker = liveTracker();
    const consumed = tracker.observe(TASK2, { type: "user/message", seq: 52, data: { source: { kind: "user", rpcId: RPC } } });
    assert.equal(consumed.kind, "consumed");
  });

  it("pins the consuming turn from the following turn/start", () => {
    const tracker = liveTracker();
    tracker.observe(TASK2, { type: "user/message", seq: 52, data: { source: { rpcId: RPC } } });
    const started = tracker.observe(TASK2, { type: "turn/start", seq: 53, data: { turn: 4 } });
    assert.equal(started.kind, "recheck");
    const terminal = tracker.observe(TASK2, { type: "turn/end", seq: 57, data: { turn: 4, reason: { kind: "completed" } } });
    assert.equal(terminal.kind, "terminal");
    assert.equal(terminal.kind === "terminal" ? terminal.executionId : "", "e1");
  });

  it("pins the already open turn when a matching user message arrives after turn/start", () => {
    const tracker = liveTracker();
    const started = { type: "turn/start", seq: 52, data: { turn: 6 } };
    tracker.observe(TASK2, started);
    tracker.observe(TASK2, { type: "user/message", seq: 53, data: { source: { rpcId: "desktop" } } });
    assert.deepEqual(
      tracker.observe(TASK2, { type: "user/message", seq: 54, data: { source: { rpcId: RPC } } }),
      { kind: "consumed", executionId: "e1", turn: 6, seq: 54 },
    );
    assert.equal(tracker.observe(TASK2, turnEnd(57, 6)).kind, "terminal");
    assert.equal(tracker.observe(TASK2, started).kind, "ignored");
    assert.equal(tracker.observe(TASK2, turnEnd(57, 6)).kind, "duplicate");
  });

  it("does not use a replayed start to reopen a finished desktop turn", () => {
    const tracker = liveTracker();
    const started = { type: "turn/start", seq: 52, data: { turn: 6 } };
    tracker.observe(TASK2, started);
    assert.equal(tracker.observe(TASK2, turnEnd(55, 6)).kind, "unattributed");
    assert.equal(tracker.observe(TASK2, started).kind, "ignored");
    assert.equal(tracker.observe(TASK2, { type: "user/message", seq: 54, data: { source: { rpcId: RPC } } }).kind, "ignored");
    tracker.observe(TASK2, { type: "turn/start", seq: 57, data: { turn: 7 } });
    assert.equal(tracker.observe(TASK2, turnEnd(59, 7)).kind, "unattributed");
  });

  it("ignores an external message and its turn", () => {
    const tracker = liveTracker();
    const other = tracker.observe(TASK2, { type: "user/message", seq: 52, data: { source: { kind: "user" } } });
    assert.equal(other.kind, "ignored");
    tracker.observe(TASK2, { type: "turn/start", seq: 53, data: { turn: 4 } });
    const terminal = tracker.observe(TASK2, { type: "turn/end", seq: 57, data: { turn: 4 } });
    assert.notEqual(terminal.kind, "terminal");
  });
});
