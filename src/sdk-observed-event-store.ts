import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock } from "./file-lock.js";

// Observed-cache for the SDK backend.
//
// This store answers exactly one question: which session events did THIS bridge
// actually observe? Paginated reads and the "final reply" pointer must never
// reference text that was not durably written here. It is deliberately not an
// authoritative DSH history: coverage is always reported explicitly, and a
// restored SDK session does not re-broadcast old events, so a task can be
// readable and still incomplete.
//
// The files hold raw conversation events, hence directories are 0o700 and every
// file this module creates is 0o600. Nothing here reads DSH's own session files
// (sessions/**/session.*.jsonl.zstd) or any upstream projection cache.

export type ObservedDegradationReason = "corruption" | "overflow" | "write_failure" | "observation_degraded";

export interface ObservedDegradation {
  reason: ObservedDegradationReason;
  detail: string;
  at: string;
}

export interface ObservedEventRecord {
  sessionId: string;
  seq: number;
  origin: "root" | "subagent";
  parentSessionId?: string;
  observedAt: string;
  event: unknown;
}

export interface ObservedEventInput extends ObservedEventRecord {}

export interface ObservedAppendResult {
  appended: number;
  duplicates: number;
  degraded: boolean;
}

export interface ObservedGap {
  reason: ObservedDegradationReason;
  detail?: string;
}

export interface ObservedCoverage {
  observedSource: "observed-cache";
  complete: boolean;
  firstSeq?: number;
  lastSeq?: number;
  observedCount: number;
  gaps: ObservedGap[];
  note: string;
}

export interface ObservedHistoryPage {
  events: ObservedEventRecord[];
  hasMore: boolean;
  coverage: ObservedCoverage;
}

export class ObservationConflictError extends Error {
  readonly code = "observation_conflict";
  readonly sessionId: string;
  readonly seq: number;

  constructor(sessionId: string, seq: number, detail: string) {
    super(
      `observed event conflict for session ${JSON.stringify(sessionId)} seq ${seq}: ${detail}. The stored event is never overwritten; the caller must treat the observation as inconsistent.`,
    );
    this.name = "ObservationConflictError";
    this.sessionId = sessionId;
    this.seq = seq;
  }
}

export class ObservationStoreError extends Error {
  constructor(
    readonly code: "corrupt_store" | "event_too_large" | "invalid_input" | "write_failure",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ObservationStoreError";
  }
}

const TASK_ID_PATTERN = /^dsh_[a-f0-9]{12}$/;
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_TASK_BYTES = 64 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const MAX_DEGRADATIONS = 64;

const OBSERVED_NOTE =
  "observed-cache only: this is the bridge's own observation log, restored SDK sessions do not re-broadcast old events, so completeness is not guaranteed.";

interface SessionStats {
  firstSeq: number;
  lastSeq: number;
  count: number;
}

interface MetaFile {
  schemaVersion: 1;
  taskId: string;
  sessions: Record<string, SessionStats>;
  degraded: ObservedDegradation[];
  bytes: number;
  updatedAt: string;
}

interface TaskState {
  index: Map<string, ObservedEventRecord>;
  sessions: Map<string, SessionStats>;
  degraded: ObservedDegradation[];
  bytes: number;
  // True when the event log ends in a truncated (newline-less) tail, so the next
  // append must start on its own line instead of merging into that tail.
  needsSeparator: boolean;
}

interface PreparedEvent {
  record: ObservedEventRecord;
  key: string;
  line: string;
  canonical: string;
}

export class SdkObservedEventStore {
  readonly dir: string;
  private readonly maxEventBytes: number;
  private readonly maxTaskBytes: number;
  private readonly states = new Map<string, Promise<TaskState>>();

  constructor(homeDir: string, options: { maxEventBytes?: number; maxTaskBytes?: number } = {}) {
    this.dir = join(homeDir, "observed");
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxTaskBytes = options.maxTaskBytes ?? DEFAULT_MAX_TASK_BYTES;
    for (const [name, value] of [
      ["maxEventBytes", this.maxEventBytes],
      ["maxTaskBytes", this.maxTaskBytes],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new ObservationStoreError("invalid_input", `${name} must be a positive integer, got ${JSON.stringify(value)}`);
      }
    }
  }

  async append(taskId: string, inputs: readonly ObservedEventInput[]): Promise<ObservedAppendResult> {
    requireTaskId(taskId);
    if (!Array.isArray(inputs)) {
      throw new ObservationStoreError("invalid_input", "observed events must be provided as an array");
    }
    const prepared = inputs.map((input) => this.prepare(input));
    if (prepared.length === 0) {
      const idle = await this.state(taskId);
      return { appended: 0, duplicates: 0, degraded: idle.degraded.length > 0 };
    }

    const taskDir = this.taskDir(taskId);
    await this.ensureTaskDir(taskDir);
    return withFileLock(join(taskDir, "append.lock"), async () => {
      const state = await this.state(taskId);
      const pending = new Map<string, PreparedEvent>();
      let duplicates = 0;
      // Dedupe/conflict resolution happens before anything is written, so a
      // conflicting batch leaves the store byte-identical.
      for (const item of prepared) {
        const existing = state.index.get(item.key) ?? pending.get(item.key)?.record;
        if (existing !== undefined) {
          if (canonicalize(existing) !== item.canonical) {
            throw new ObservationConflictError(
              item.record.sessionId,
              item.record.seq,
              "the appended content differs from the event already persisted for this (sessionId, seq)",
            );
          }
          duplicates += 1;
          continue;
        }
        pending.set(item.key, item);
      }
      if (pending.size === 0) {
        return { appended: 0, duplicates, degraded: state.degraded.length > 0 };
      }

      const toWrite = [...pending.values()];
      const separator = state.needsSeparator ? "\n" : "";
      const payload = `${separator}${toWrite.map((item) => `${item.line}\n`).join("")}`;
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      if (state.bytes + payloadBytes > this.maxTaskBytes) {
        // Overload is a recorded gap, never a silent drop: coverage stops
        // claiming completeness and the batch is not written at all.
        await this.degradeUnlocked(
          taskId,
          state,
          "overflow",
          `observed cache holds ${state.bytes} bytes and the batch needs ${payloadBytes} more, above the ${this.maxTaskBytes}-byte task limit; the batch was not written`,
        );
        return { appended: 0, duplicates: 0, degraded: true };
      }

      // Events are flushed before meta is touched: meta is derived state, so a
      // crash between the two must still leave readable events behind.
      await this.appendEvents(taskId, payload);
      state.needsSeparator = false;
      for (const item of toWrite) {
        state.index.set(item.key, item.record);
        applySession(state.sessions, item.record);
      }
      state.bytes += payloadBytes;

      const metaWritten = await this.writeMeta(taskId, state);
      return { appended: toWrite.length, duplicates, degraded: !metaWritten || state.degraded.length > 0 };
    });
  }

  async readSession(
    taskId: string,
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<ObservedHistoryPage> {
    requireTaskId(taskId);
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ObservationStoreError("invalid_input", "sessionId must be a non-empty string");
    }
    const beforeSeq = options.beforeSeq;
    if (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 0)) {
      throw new ObservationStoreError("invalid_input", `beforeSeq must be an integer >= 0, got ${JSON.stringify(beforeSeq)}`);
    }
    const maxMessages = options.maxMessages ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new ObservationStoreError("invalid_input", `maxMessages must be a positive integer, got ${JSON.stringify(maxMessages)}`);
    }
    const limit = Math.min(maxMessages, MAX_PAGE_SIZE);

    const state = await this.state(taskId);
    const matching: ObservedEventRecord[] = [];
    for (const record of state.index.values()) {
      if (record.sessionId !== sessionId) continue;
      if (beforeSeq !== undefined && record.seq >= beforeSeq) continue;
      matching.push(record);
    }
    matching.sort((left, right) => left.seq - right.seq);
    // Paged from the end: the caller asks for the newest window it has not read.
    const events = matching.length > limit ? matching.slice(matching.length - limit) : matching;
    return {
      events: events.map(cloneEvent),
      hasMore: matching.length > events.length,
      coverage: coverageFor(state),
    };
  }

  async findEvent(taskId: string, sessionId: string, seq: number): Promise<ObservedEventRecord | undefined> {
    requireTaskId(taskId);
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ObservationStoreError("invalid_input", "sessionId must be a non-empty string");
    }
    if (!Number.isInteger(seq) || seq < 0) {
      throw new ObservationStoreError("invalid_input", `seq must be an integer >= 0, got ${JSON.stringify(seq)}`);
    }
    const state = await this.state(taskId);
    const record = state.index.get(recordKey(sessionId, seq));
    return record === undefined ? undefined : cloneEvent(record);
  }

  async latest(taskId: string, sessionId: string): Promise<ObservedEventRecord | undefined> {
    requireTaskId(taskId);
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ObservationStoreError("invalid_input", "sessionId must be a non-empty string");
    }
    const state = await this.state(taskId);
    const stats = state.sessions.get(sessionId);
    if (stats === undefined) return undefined;
    const record = state.index.get(recordKey(sessionId, stats.lastSeq));
    return record === undefined ? undefined : cloneEvent(record);
  }

  async sessions(taskId: string): Promise<string[]> {
    requireTaskId(taskId);
    const state = await this.state(taskId);
    return [...state.sessions.keys()].sort();
  }

  async coverage(taskId: string): Promise<ObservedCoverage> {
    requireTaskId(taskId);
    const state = await this.state(taskId);
    return coverageFor(state);
  }

  async degrade(taskId: string, reason: ObservedDegradationReason, detail: string): Promise<void> {
    requireTaskId(taskId);
    if (!isDegradationReason(reason)) {
      throw new ObservationStoreError("invalid_input", `unknown degradation reason ${JSON.stringify(reason)}`);
    }
    if (typeof detail !== "string" || detail.length === 0) {
      throw new ObservationStoreError("invalid_input", "degradation detail must be a non-empty string");
    }
    const taskDir = this.taskDir(taskId);
    await this.ensureTaskDir(taskDir);
    await withFileLock(join(taskDir, "append.lock"), async () => {
      const state = await this.state(taskId);
      await this.degradeUnlocked(taskId, state, reason, detail);
    });
  }

  async stats(taskId: string): Promise<{ events: number; bytes: number; path: string }> {
    requireTaskId(taskId);
    const state = await this.state(taskId);
    return { events: state.index.size, bytes: state.bytes, path: this.eventsPath(taskId) };
  }

  private prepare(input: ObservedEventInput): PreparedEvent {
    const record = validateEventInput(input);
    const line = serializeEvent(record);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxEventBytes) {
      throw new ObservationStoreError(
        "event_too_large",
        `observed event ${JSON.stringify(record.sessionId)} seq ${record.seq} is ${bytes} bytes, above the ${this.maxEventBytes}-byte limit`,
      );
    }
    return { record, key: recordKey(record.sessionId, record.seq), line, canonical: canonicalize(record) };
  }

  private async degradeUnlocked(
    taskId: string,
    state: TaskState,
    reason: ObservedDegradationReason,
    detail: string,
  ): Promise<boolean> {
    this.pushDegradation(state, reason, detail);
    return this.writeMeta(taskId, state);
  }

  private pushDegradation(state: TaskState, reason: ObservedDegradationReason, detail: string): void {
    if (state.degraded.some((entry) => entry.reason === reason && entry.detail === detail)) return;
    state.degraded.push({ reason, detail, at: new Date().toISOString() });
    if (state.degraded.length > MAX_DEGRADATIONS) {
      state.degraded.splice(0, state.degraded.length - MAX_DEGRADATIONS);
    }
  }

  private async appendEvents(taskId: string, payload: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.eventsPath(taskId), "a", 0o600);
      await handle.writeFile(payload, "utf8");
      // Flush before meta: a crash must not leave meta pointing past unreadable text.
      await handle.sync();
    } catch (error) {
      throw new ObservationStoreError("write_failure", `could not append observed events for task ${JSON.stringify(taskId)}`, {
        cause: error,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeMeta(taskId: string, state: TaskState): Promise<boolean> {
    const taskDir = this.taskDir(taskId);
    const target = join(taskDir, "meta.json");
    const temp = join(taskDir, `.meta.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const meta: MetaFile = {
      schemaVersion: SCHEMA_VERSION,
      taskId,
      sessions: sortedSessions(state.sessions),
      degraded: state.degraded.map((entry) => ({ ...entry })),
      bytes: state.bytes,
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temp, target);
      return true;
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      // Events are already durable; only the derived view is behind. Record the
      // gap in memory so coverage stops claiming completeness, and keep going.
      this.pushDegradation(state, "write_failure", `could not persist meta.json: ${errorMessage(error)}`);
      return false;
    }
  }

  private state(taskId: string): Promise<TaskState> {
    const cached = this.states.get(taskId);
    if (cached !== undefined) return cached;
    const loaded = this.loadState(taskId).catch((error: unknown) => {
      this.states.delete(taskId);
      throw error;
    });
    this.states.set(taskId, loaded);
    return loaded;
  }

  private async loadState(taskId: string): Promise<TaskState> {
    const taskDir = this.taskDir(taskId);
    const index = new Map<string, ObservedEventRecord>();
    const sessions = new Map<string, SessionStats>();
    let bytes = 0;
    let malformedLines = 0;
    let needsSeparator = false;

    let raw: string | undefined;
    try {
      raw = await readFile(this.eventsPath(taskId), "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new ObservationStoreError("write_failure", `could not read observed events for task ${JSON.stringify(taskId)}`, {
          cause: error,
        });
      }
    }

    if (raw !== undefined) {
      bytes = Buffer.byteLength(raw, "utf8");
      // A leftover tail without a trailing newline (crash mid-write) must not be
      // merged into the next record; it stays a reported corrupt line instead.
      needsSeparator = raw.length > 0 && !raw.endsWith("\n");
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const record = parseStoredLine(line);
        if (record === undefined) {
          // Never invented, never repaired: report the gap once and move on.
          malformedLines += 1;
          continue;
        }
        const key = recordKey(record.sessionId, record.seq);
        if (index.has(key)) continue;
        index.set(key, record);
        applySession(sessions, record);
      }
    }

    let degraded: ObservedDegradation[] = [];
    let metaRaw: string | undefined;
    try {
      metaRaw = await readFile(join(taskDir, "meta.json"), "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        degraded.push(corruptionEntry(`meta.json is unreadable: ${errorMessage(error)}`));
      }
      // Absence is not corruption: a missing meta is simply rebuilt from events.
    }
    if (metaRaw !== undefined) {
      const meta = parseMeta(metaRaw, taskId);
      if (meta === undefined) {
        degraded.push(corruptionEntry("meta.json is malformed and was rebuilt from events.jsonl"));
      } else {
        degraded = meta.degraded.map((entry) => ({ ...entry }));
      }
    }
    if (malformedLines > 0) {
      degraded.push(
        corruptionEntry(`${malformedLines} malformed line(s) in events.jsonl were skipped; those events are not observed`),
      );
    }

    return { index, sessions, degraded: dedupeDegradations(degraded), bytes, needsSeparator };
  }

  private async ensureTaskDir(taskDir: string): Promise<void> {
    await mkdir(taskDir, { recursive: true, mode: 0o700 });
    await chmod(taskDir, 0o700);
  }

  private taskDir(taskId: string): string {
    requireTaskId(taskId);
    return join(this.dir, taskId);
  }

  private eventsPath(taskId: string): string {
    return join(this.dir, taskId, "events.jsonl");
  }
}

function requireTaskId(taskId: string): void {
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    throw new ObservationStoreError("invalid_input", `invalid task id ${JSON.stringify(taskId)}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDegradationReason(value: unknown): value is ObservedDegradationReason {
  return (
    value === "corruption" ||
    value === "overflow" ||
    value === "write_failure" ||
    value === "observation_degraded"
  );
}

function corruptionEntry(detail: string): ObservedDegradation {
  return { reason: "corruption", detail, at: new Date().toISOString() };
}

function dedupeDegradations(entries: ObservedDegradation[]): ObservedDegradation[] {
  const seen = new Set<string>();
  const deduped: ObservedDegradation[] = [];
  for (const entry of entries) {
    const key = `${entry.reason}\u0000${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...entry });
  }
  return deduped.length > MAX_DEGRADATIONS ? deduped.slice(deduped.length - MAX_DEGRADATIONS) : deduped;
}

function recordKey(sessionId: string, seq: number): string {
  return `${sessionId}\u0000${seq}`;
}

function applySession(sessions: Map<string, SessionStats>, record: ObservedEventRecord): void {
  const stats = sessions.get(record.sessionId);
  if (stats === undefined) {
    sessions.set(record.sessionId, { firstSeq: record.seq, lastSeq: record.seq, count: 1 });
    return;
  }
  stats.firstSeq = Math.min(stats.firstSeq, record.seq);
  stats.lastSeq = Math.max(stats.lastSeq, record.seq);
  stats.count += 1;
}

function sortedSessions(sessions: Map<string, SessionStats>): Record<string, SessionStats> {
  const sorted: Record<string, SessionStats> = {};
  for (const sessionId of [...sessions.keys()].sort()) {
    const stats = sessions.get(sessionId);
    if (stats === undefined) continue;
    sorted[sessionId] = { firstSeq: stats.firstSeq, lastSeq: stats.lastSeq, count: stats.count };
  }
  return sorted;
}

/**
 * Identity of one observed event for duplicate/conflict detection.
 *
 * `observedAt` is deliberately excluded: it records when this bridge saw the
 * event, so the same wire event redelivered a moment later must still count as
 * a duplicate. Lineage and payload must match exactly — a changed parent or a
 * changed payload for one `(sessionId, seq)` is a real conflict.
 */
function canonicalize(record: ObservedEventRecord): string {
  return JSON.stringify({
    sessionId: record.sessionId,
    seq: record.seq,
    origin: record.origin,
    ...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
    event: record.event,
  });
}

function serializeEvent(record: ObservedEventRecord): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sessionId: record.sessionId,
    seq: record.seq,
    origin: record.origin,
    ...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
    observedAt: record.observedAt,
    event: record.event,
  });
}

function validateEventInput(input: ObservedEventInput): ObservedEventRecord {
  const raw = asObject(input);
  if (raw === undefined) {
    throw new ObservationStoreError("invalid_input", "observed event must be an object");
  }
  const sessionId = raw.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ObservationStoreError("invalid_input", "observed event sessionId must be a non-empty string");
  }
  const seq = raw.seq;
  if (!isNonNegativeInteger(seq)) {
    throw new ObservationStoreError("invalid_input", `observed event seq must be an integer >= 0, got ${JSON.stringify(seq)}`);
  }
  const origin = raw.origin;
  if (origin !== "root" && origin !== "subagent") {
    throw new ObservationStoreError("invalid_input", `observed event origin must be "root" or "subagent", got ${JSON.stringify(origin)}`);
  }
  const observedAt = raw.observedAt;
  if (typeof observedAt !== "string" || observedAt.length === 0) {
    throw new ObservationStoreError("invalid_input", "observed event observedAt must be a non-empty string");
  }
  const parentSessionId = raw.parentSessionId;
  if (parentSessionId !== undefined && (typeof parentSessionId !== "string" || parentSessionId.length === 0)) {
    throw new ObservationStoreError("invalid_input", "observed event parentSessionId must be a non-empty string when present");
  }
  // `undefined` would be dropped by JSON.stringify and turn the line into a
  // corrupt record, so an explicitly missing payload is invalid input.
  if (!("event" in raw) || raw.event === undefined) {
    throw new ObservationStoreError("invalid_input", "observed event must carry the upstream event payload");
  }
  const record: ObservedEventRecord = {
    sessionId,
    seq,
    origin: origin === "subagent" ? "subagent" : "root",
    ...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
    observedAt,
    event: raw.event,
  };
  // Round-trip through the serializer now so a non-serializable payload fails
  // here as invalid input instead of corrupting the append.
  try {
    JSON.stringify(record.event);
  } catch (error) {
    throw new ObservationStoreError("invalid_input", "observed event payload is not JSON-serializable", { cause: error });
  }
  return record;
}

function parseStoredLine(line: string): ObservedEventRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const raw = asObject(value);
  if (raw === undefined) return undefined;
  if (raw.schemaVersion !== SCHEMA_VERSION) return undefined;
  const sessionId = raw.sessionId;
  const seq = raw.seq;
  const origin = raw.origin;
  const observedAt = raw.observedAt;
  const parentSessionId = raw.parentSessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  if (!isNonNegativeInteger(seq)) return undefined;
  if (origin !== "root" && origin !== "subagent") return undefined;
  if (typeof observedAt !== "string" || observedAt.length === 0) return undefined;
  if (parentSessionId !== undefined && (typeof parentSessionId !== "string" || parentSessionId.length === 0)) return undefined;
  if (!("event" in raw)) return undefined;
  return {
    sessionId,
    seq,
    origin: origin === "subagent" ? "subagent" : "root",
    ...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
    observedAt,
    event: raw.event,
  };
}

function parseMeta(raw: string, expectedTaskId: string): MetaFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const meta = asObject(value);
  if (meta === undefined) return undefined;
  if (meta.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (meta.taskId !== expectedTaskId) return undefined;
  const bytes = meta.bytes;
  if (!isNonNegativeInteger(bytes)) return undefined;
  const updatedAt = meta.updatedAt;
  if (typeof updatedAt !== "string" || updatedAt.length === 0) return undefined;

  const sessionsRaw = asObject(meta.sessions);
  if (sessionsRaw === undefined) return undefined;
  const sessions: Record<string, SessionStats> = {};
  for (const [sessionId, statsRaw] of Object.entries(sessionsRaw)) {
    const stats = asObject(statsRaw);
    if (stats === undefined || sessionId.length === 0) return undefined;
    const firstSeq = stats.firstSeq;
    const lastSeq = stats.lastSeq;
    const count = stats.count;
    if (!isNonNegativeInteger(firstSeq) || !isNonNegativeInteger(lastSeq) || !isNonNegativeInteger(count)) {
      return undefined;
    }
    sessions[sessionId] = { firstSeq, lastSeq, count };
  }

  const degradedRaw = meta.degraded;
  if (!Array.isArray(degradedRaw)) return undefined;
  const degraded: ObservedDegradation[] = [];
  for (const entryRaw of degradedRaw) {
    const entry = asObject(entryRaw);
    if (entry === undefined) return undefined;
    const reason = entry.reason;
    const detail = entry.detail;
    const at = entry.at;
    if (!isDegradationReason(reason)) return undefined;
    if (typeof detail !== "string") return undefined;
    if (typeof at !== "string" || at.length === 0) return undefined;
    degraded.push({ reason, detail, at });
  }

  return { schemaVersion: SCHEMA_VERSION, taskId: expectedTaskId, sessions, degraded, bytes, updatedAt };
}

function cloneEvent(record: ObservedEventRecord): ObservedEventRecord {
  return {
    ...record,
    ...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
    event: structuredClone(record.event),
  };
}

function coverageFor(state: TaskState): ObservedCoverage {
  let firstSeq: number | undefined;
  let lastSeq: number | undefined;
  let observedCount = 0;
  for (const stats of state.sessions.values()) {
    observedCount += stats.count;
    firstSeq = firstSeq === undefined ? stats.firstSeq : Math.min(firstSeq, stats.firstSeq);
    lastSeq = lastSeq === undefined ? stats.lastSeq : Math.max(lastSeq, stats.lastSeq);
  }
  const gaps: ObservedGap[] = state.degraded.map((entry) => ({ reason: entry.reason, detail: entry.detail }));
  return {
    observedSource: "observed-cache",
    complete: gaps.length === 0,
    ...(firstSeq !== undefined ? { firstSeq } : {}),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
    observedCount,
    gaps,
    note: OBSERVED_NOTE,
  };
}
