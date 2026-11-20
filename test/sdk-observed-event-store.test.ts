import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ObservationConflictError, ObservationStoreError, SdkObservedEventStore } from "../src/sdk-observed-event-store.js";
import type { ObservedEventInput } from "../src/sdk-observed-event-store.js";
import { assertPortablePrivateMode } from "./support/platform.js";

const rootTask = "dsh_0000000000a1";
const otherTask = "dsh_0000000000a2";
const rootSession = "session-root";
const childSession = "session-child";

function observed(
  sessionId: string,
  seq: number,
  text: string,
  extra: { origin?: "root" | "subagent"; parentSessionId?: string } = {},
): ObservedEventInput {
  return {
    sessionId,
    seq,
    origin: extra.origin ?? "root",
    ...(extra.parentSessionId !== undefined ? { parentSessionId: extra.parentSessionId } : {}),
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq % 60)).toISOString(),
    event: { type: "text", seq, text },
  };
}

function textOf(record: { event: unknown }): string {
  const event = record.event as { text?: string };
  return event.text ?? "";
}

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-observed-"));
  try {
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("SdkObservedEventStore round-trips observed events and keeps private POSIX modes where supported", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    assert.equal(store.dir, join(home, "observed"));

    assert.deepEqual(await store.append(rootTask, [observed(rootSession, 0, "hello"), observed(rootSession, 1, "world")]), {
      appended: 2,
      duplicates: 0,
      degraded: false,
    });

    const page = await store.readSession(rootTask, rootSession);
    assert.deepEqual(
      page.events.map((record) => record.seq),
      [0, 1],
    );
    assert.equal(textOf(page.events[0]!), "hello");
    assert.equal(page.hasMore, false);
    assert.equal(page.coverage.observedSource, "observed-cache");
    assert.equal(page.coverage.complete, true);
    assert.equal(page.coverage.observedCount, 2);
    assert.equal(page.coverage.firstSeq, 0);
    assert.equal(page.coverage.lastSeq, 1);
    assert.deepEqual(page.coverage.gaps, []);
    assert.match(page.coverage.note, /observed-cache/);
    assert.match(page.coverage.note, /do not re-broadcast/);

    assert.deepEqual(await store.findEvent(rootTask, rootSession, 0), observed(rootSession, 0, "hello"));
    assert.equal(await store.findEvent(rootTask, rootSession, 9), undefined);
    assert.equal((await store.latest(rootTask, rootSession))?.seq, 1);
    assert.deepEqual(await store.sessions(rootTask), [rootSession]);

    const stats = await store.stats(rootTask);
    const eventsPath = join(home, "observed", rootTask, "events.jsonl");
    assert.equal(stats.path, eventsPath);
    assert.equal(stats.events, 2);
    assert.ok(stats.bytes > 0);

    const metaPath = join(home, "observed", rootTask, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.taskId, rootTask);
    assert.deepEqual(meta.sessions, { [rootSession]: { firstSeq: 0, lastSeq: 1, count: 2 } });
    assert.equal(meta.bytes, stats.bytes);
    assert.deepEqual(meta.degraded, []);

    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(JSON.parse(lines[0]!) as Record<string, unknown>).sort(), [
      "event",
      "observedAt",
      "origin",
      "schemaVersion",
      "seq",
      "sessionId",
    ]);

    assertPortablePrivateMode((await stat(join(home, "observed", rootTask))).mode, 0o700);
    assertPortablePrivateMode((await stat(eventsPath)).mode, 0o600);
    assertPortablePrivateMode((await stat(metaPath)).mode, 0o600);
  });
});

test("SdkObservedEventStore counts duplicates, rewrites nothing, and refuses conflicting (sessionId, seq)", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    await store.append(rootTask, [observed(rootSession, 0, "hello"), observed(rootSession, 1, "world")]);
    const eventsPath = join(home, "observed", rootTask, "events.jsonl");
    const before = await readFile(eventsPath, "utf8");

    assert.deepEqual(await store.append(rootTask, [observed(rootSession, 0, "hello")]), {
      appended: 0,
      duplicates: 1,
      degraded: false,
    });
    assert.equal(await readFile(eventsPath, "utf8"), before);

    await assert.rejects(
      () => store.append(rootTask, [observed(rootSession, 0, "replacement")]),
      (error: unknown) =>
        error instanceof ObservationConflictError && error.code === "observation_conflict" && error.seq === 0,
    );
    assert.equal(await readFile(eventsPath, "utf8"), before);

    // Nothing from a conflicting batch is written, not even its fresh seq.
    await assert.rejects(
      () => store.append(rootTask, [observed(rootSession, 5, "new"), observed(rootSession, 1, "changed")]),
      (error: unknown) => error instanceof ObservationConflictError,
    );
    assert.equal(await readFile(eventsPath, "utf8"), before);
    assert.equal((await store.stats(rootTask)).events, 2);

    // Same-batch duplicates are deduplicated too.
    assert.deepEqual(await store.append(rootTask, [observed(rootSession, 6, "once"), observed(rootSession, 6, "once")]), {
      appended: 1,
      duplicates: 1,
      degraded: false,
    });
  });
});

test("SdkObservedEventStore treats a redelivered event with a new observation time as a duplicate", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    const first = observed(rootSession, 4, "payload");
    await store.append(rootTask, [first]);
    // A transport retransmission carries the same wire event but a later
    // `observedAt`; only the payload and lineage define identity.
    const redelivered = { ...first, observedAt: new Date(Date.parse(first.observedAt) + 5_000).toISOString() };
    assert.deepEqual(await store.append(rootTask, [redelivered]), {
      appended: 0,
      duplicates: 1,
      degraded: false,
    });
    assert.equal((await store.stats(rootTask)).events, 1);
    assert.equal((await store.coverage(rootTask)).complete, true, "a retransmission is not a corruption gap");
  });
});

test("SdkObservedEventStore pages from the end with beforeSeq and maxMessages", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    await store.append(
      otherTask,
      Array.from({ length: 10 }, (_, seq) => observed("session-page", seq, `m${seq}`)),
    );

    const newest = await store.readSession(otherTask, "session-page", { maxMessages: 3 });
    assert.deepEqual(
      newest.events.map((record) => record.seq),
      [7, 8, 9],
    );
    assert.equal(newest.hasMore, true);

    const older = await store.readSession(otherTask, "session-page", { beforeSeq: 7, maxMessages: 3 });
    assert.deepEqual(
      older.events.map((record) => record.seq),
      [4, 5, 6],
    );
    assert.equal(older.hasMore, true);

    const oldest = await store.readSession(otherTask, "session-page", { beforeSeq: 1, maxMessages: 3 });
    assert.deepEqual(
      oldest.events.map((record) => record.seq),
      [0],
    );
    assert.equal(oldest.hasMore, false);

    const capped = await store.readSession(otherTask, "session-page", { maxMessages: 10_000 });
    assert.equal(capped.events.length, 10);
    assert.equal(capped.hasMore, false);
    assert.equal((await store.readSession(otherTask, "session-page")).events.length, 10);
  });
});

test("SdkObservedEventStore isolates sessions and rehydrates from disk on a fresh instance", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    await store.append(rootTask, [observed(rootSession, 0, "root-0"), observed(rootSession, 1, "root-1")]);
    await store.append(rootTask, [
      observed(childSession, 0, "child-0", { origin: "subagent", parentSessionId: rootSession }),
    ]);

    assert.deepEqual(await store.sessions(rootTask), [childSession, rootSession].sort());
    const fresh = new SdkObservedEventStore(home);
    const rootPage = await fresh.readSession(rootTask, rootSession);
    assert.deepEqual(
      rootPage.events.map((record) => record.seq),
      [0, 1],
    );
    const childPage = await fresh.readSession(rootTask, childSession);
    assert.equal(childPage.events.length, 1);
    assert.equal(childPage.events[0]?.origin, "subagent");
    assert.equal(childPage.events[0]?.parentSessionId, rootSession);
    assert.equal(childPage.coverage.observedCount, 3);
    assert.equal(childPage.coverage.complete, true);
    assert.equal((await fresh.coverage(rootTask)).lastSeq, 1);
    assert.equal((await fresh.latest(rootTask, childSession))?.seq, 0);
    assert.deepEqual(await fresh.sessions(rootTask), [childSession, rootSession].sort());
  });
});

test("SdkObservedEventStore skips corrupt lines, reports a corruption gap, and invents nothing", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    await store.append(rootTask, [observed(rootSession, 0, "hello"), observed(rootSession, 1, "world")]);
    const eventsPath = join(home, "observed", rootTask, "events.jsonl");
    await appendFile(eventsPath, "{not-json}\n\n[]\n");

    const corrupted = new SdkObservedEventStore(home);
    const page = await corrupted.readSession(rootTask, rootSession);
    assert.deepEqual(
      page.events.map((record) => record.seq),
      [0, 1],
    );
    assert.equal(page.coverage.complete, false);
    assert.equal(page.coverage.gaps.length, 1);
    assert.equal(page.coverage.gaps[0]?.reason, "corruption");
    assert.equal(page.coverage.observedCount, 2);
    const stats = await corrupted.stats(rootTask);
    assert.equal(stats.events, 2);

    // Appending a fresh event after contact with corruption still works and the
    // gap stays reported exactly once.
    assert.deepEqual(await corrupted.append(rootTask, [observed(rootSession, 2, "after-gap")]), {
      appended: 1,
      duplicates: 0,
      degraded: true,
    });
    const reread = new SdkObservedEventStore(home);
    const coverage = await reread.coverage(rootTask);
    assert.equal(coverage.complete, false);
    assert.equal(coverage.gaps.filter((gap) => gap.reason === "corruption").length, 1);
    assert.equal(coverage.observedCount, 3);
  });
});

test("SdkObservedEventStore keeps a new event readable after a truncated tail", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    await store.append(rootTask, [observed(rootSession, 0, "hello")]);
    const eventsPath = join(home, "observed", rootTask, "events.jsonl");
    // Simulate a crash that left a partial line without its newline.
    const raw = await readFile(eventsPath, "utf8");
    await writeFile(eventsPath, `${raw}{"schemaVersion":1,"sessionId":"session-ro`);

    const truncated = new SdkObservedEventStore(home);
    assert.deepEqual(await truncated.append(rootTask, [observed(rootSession, 1, "world")]), {
      appended: 1,
      duplicates: 0,
      degraded: true,
    });
    const page = await truncated.readSession(rootTask, rootSession);
    assert.deepEqual(
      page.events.map((record) => record.seq),
      [0, 1],
    );
    assert.equal(page.coverage.complete, false);
    assert.equal(page.coverage.gaps.filter((gap) => gap.reason === "corruption").length, 1);

    const fresh = new SdkObservedEventStore(home);
    assert.deepEqual(
      (await fresh.readSession(rootTask, rootSession)).events.map((record) => record.seq),
      [0, 1],
    );
    assert.deepEqual(await fresh.sessions(rootTask), [rootSession]);
  });
});

test("SdkObservedEventStore rebuilds meta without inventing a corruption gap for absence", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    await store.append(rootTask, [observed(rootSession, 0, "hello")]);
    const metaPath = join(home, "observed", rootTask, "meta.json");

    await writeFile(metaPath, "{oops\n");
    const malformed = new SdkObservedEventStore(home);
    const malformedCoverage = await malformed.coverage(rootTask);
    assert.equal(malformedCoverage.complete, false);
    assert.deepEqual(
      malformedCoverage.gaps.map((gap) => gap.reason),
      ["corruption"],
    );
    assert.equal(malformedCoverage.observedCount, 1);

    await rm(metaPath);
    const rebuilt = new SdkObservedEventStore(home);
    const rebuiltCoverage = await rebuilt.coverage(rootTask);
    assert.equal(rebuiltCoverage.complete, true);
    assert.deepEqual(rebuiltCoverage.gaps, []);
    assert.equal(rebuiltCoverage.observedCount, 1);
    // The next append re-materialises meta.json from the events file.
    await rebuilt.append(rootTask, [observed(rootSession, 1, "world")]);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(meta.sessions, { [rootSession]: { firstSeq: 0, lastSeq: 1, count: 2 } });
  });
});

test("SdkObservedEventStore rejects oversized events and records overflow as an explicit gap", async () => {
  await withHome(async (home) => {
    const tight = new SdkObservedEventStore(home, { maxEventBytes: 128 });
    await assert.rejects(
      () => tight.append(rootTask, [observed(rootSession, 0, "x".repeat(400))]),
      (error: unknown) => error instanceof ObservationStoreError && error.code === "event_too_large",
    );
    assert.equal((await tight.stats(rootTask)).events, 0);

    const bounded = new SdkObservedEventStore(home, { maxTaskBytes: 1024 });
    const firstBatch = Array.from({ length: 4 }, (_, seq) => observed("session-bounded", seq, `m${seq}`));
    assert.deepEqual(await bounded.append(otherTask, firstBatch), { appended: 4, duplicates: 0, degraded: false });

    const tooBig = Array.from({ length: 16 }, (_, seq) => observed("session-bounded", seq + 4, "y".repeat(200)));
    assert.deepEqual(await bounded.append(otherTask, tooBig), { appended: 0, duplicates: 0, degraded: true });
    assert.equal((await bounded.stats(otherTask)).events, 4);

    const coverage = await bounded.coverage(otherTask);
    assert.equal(coverage.complete, false);
    assert.deepEqual(
      coverage.gaps.map((gap) => gap.reason),
      ["overflow"],
    );
    const meta = JSON.parse(await readFile(join(home, "observed", otherTask, "meta.json"), "utf8")) as {
      degraded: Array<{ reason: string }>;
    };
    assert.deepEqual(
      meta.degraded.map((entry) => entry.reason),
      ["overflow"],
    );
  });
});

test("SdkObservedEventStore keeps reads available but never claims completeness once degraded", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    assert.deepEqual(await store.append(rootTask, [observed(rootSession, 0, "hello")]), {
      appended: 1,
      duplicates: 0,
      degraded: false,
    });

    await store.degrade(rootTask, "observation_degraded", "upstream notification stream ended");
    const coverage = await store.coverage(rootTask);
    assert.equal(coverage.complete, false);
    assert.deepEqual(
      coverage.gaps.map((gap) => gap.reason),
      ["observation_degraded"],
    );

    assert.deepEqual(await store.append(rootTask, [observed(rootSession, 1, "more")]), {
      appended: 1,
      duplicates: 0,
      degraded: true,
    });
    const page = await store.readSession(rootTask, rootSession);
    assert.equal(page.events.length, 2);
    assert.equal(page.coverage.complete, false);
    const meta = JSON.parse(await readFile(join(home, "observed", rootTask, "meta.json"), "utf8")) as {
      degraded: Array<{ reason: string }>;
    };
    assert.deepEqual(
      meta.degraded.map((entry) => entry.reason),
      ["observation_degraded"],
    );
  });
});

test("SdkObservedEventStore rejects invalid task ids and invalid event fields", async () => {
  await withHome(async (home) => {
    const store = new SdkObservedEventStore(home);
    const isInvalidInput = (error: unknown): boolean =>
      error instanceof ObservationStoreError && error.code === "invalid_input";

    for (const taskId of ["../escape", "dsh_short", "dsh_ZZZZZZZZZZZZ", ""]) {
      await assert.rejects(() => store.append(taskId, [observed(rootSession, 0, "x")]), isInvalidInput);
      await assert.rejects(() => store.readSession(taskId, rootSession), isInvalidInput);
      await assert.rejects(() => store.findEvent(taskId, rootSession, 0), isInvalidInput);
      await assert.rejects(() => store.latest(taskId, rootSession), isInvalidInput);
      await assert.rejects(() => store.sessions(taskId), isInvalidInput);
      await assert.rejects(() => store.coverage(taskId), isInvalidInput);
      await assert.rejects(() => store.stats(taskId), isInvalidInput);
      await assert.rejects(() => store.degrade(taskId, "corruption", "x"), isInvalidInput);
    }

    await assert.rejects(() => store.append(rootTask, [{ ...observed(rootSession, 0, "x"), seq: -1 }]), isInvalidInput);
    await assert.rejects(() => store.append(rootTask, [{ ...observed(rootSession, 0, "x"), seq: 1.5 }]), isInvalidInput);
    await assert.rejects(() => store.append(rootTask, [{ ...observed(rootSession, 0, "x"), sessionId: "" }]), isInvalidInput);
    await assert.rejects(() => store.append(rootTask, [{ ...observed(rootSession, 0, "x"), observedAt: "" }]), isInvalidInput);
    await assert.rejects(
      () => store.append(rootTask, [{ ...observed(rootSession, 0, "x"), origin: "external" as unknown as "root" }]),
      isInvalidInput,
    );
    await assert.rejects(() => store.append(rootTask, [{ ...observed(rootSession, 0, "x"), event: undefined }]), isInvalidInput);
    await assert.rejects(() => store.readSession(rootTask, rootSession, { maxMessages: 0 }), isInvalidInput);
    await assert.rejects(() => store.readSession(rootTask, rootSession, { beforeSeq: -1 }), isInvalidInput);
    assert.equal((await store.stats(rootTask)).events, 0);
  });
});

test("SdkObservedEventStore surfaces a store-level I/O failure instead of succeeding silently", async () => {
  await withHome(async (home) => {
    // A directory where the event log belongs makes the observation path fail closed.
    await mkdir(join(home, "observed", rootTask, "events.jsonl"), { recursive: true });
    const store = new SdkObservedEventStore(home);
    await assert.rejects(
      () => store.append(rootTask, [observed(rootSession, 0, "x")]),
      (error: unknown) => error instanceof ObservationStoreError && error.code === "write_failure",
    );
    await assert.rejects(() => store.coverage(rootTask), (error: unknown) => error instanceof ObservationStoreError);
  });
});
