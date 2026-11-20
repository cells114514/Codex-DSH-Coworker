import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { withFileLock } from "./file-lock.js";

// Durable per-task SDK runtime identity and ownership. This record is separate
// from the legacy two-field TaskStore mapping because it pins the environment a
// task was created in; it never stores credentials, tokens, or whole
// environments (no env dump, no API keys).
//
// The registry lock covers short read-modify-write transactions only. It must
// never be held across model waits, user answers, or runtime shutdown.

export const SDK_RUNTIME_RECORD_SCHEMA_VERSION = 1;

export interface SdkRuntimeRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface SdkRuntimeOwner {
  bridgeInstanceId: string;
  pid: number;
  startedAt: string;
}

export interface SdkRuntimeRecord {
  schemaVersion: 1;
  taskId: string;
  rootSessionId: string;
  backend: "sdk";
  canonicalCwd: string;
  dshHome: string;
  profile: string;
  route: SdkRuntimeRoute;
  configFingerprint: string;
  observationEpoch: number;
  cleanShutdown: boolean;
  createdAt: string;
  updatedAt: string;
  owner: SdkRuntimeOwner;
  title?: string;
  titleSource?: "bridge";
  lastObservationAt?: string;
  lastObservedRootSeq?: number;
  cleanShutdownAt?: string;
  diagnostic?: { runtimePid?: number; runtimeStartedAt?: string; lastError?: string };
}

export interface SdkRuntimeClaimInput {
  taskId: string;
  rootSessionId: string;
  canonicalCwd: string;
  dshHome: string;
  profile: string;
  route: SdkRuntimeRoute;
  configFingerprint: string;
  observationEpoch: number;
  owner: SdkRuntimeOwner;
  title?: string;
}

export interface SdkRuntimePatch {
  observationEpoch?: number;
  cleanShutdown?: boolean;
  cleanShutdownAt?: string;
  title?: string;
  titleSource?: "bridge";
  lastObservationAt?: string;
  lastObservedRootSeq?: number;
  diagnostic?: { runtimePid?: number; runtimeStartedAt?: string; lastError?: string };
}

export class RuntimeRegistryError extends Error {
  constructor(
    readonly code: "invalid_record" | "identity_mismatch" | "owner_conflict" | "not_found",
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeRegistryError";
  }
}

const TASK_ID_PATTERN = /^dsh_[a-f0-9]{12}$/;

const REQUIRED_KEYS = [
  "backend",
  "canonicalCwd",
  "cleanShutdown",
  "configFingerprint",
  "createdAt",
  "dshHome",
  "observationEpoch",
  "owner",
  "profile",
  "rootSessionId",
  "route",
  "schemaVersion",
  "taskId",
  "updatedAt",
] as const;

const OPTIONAL_KEYS = [
  "cleanShutdownAt",
  "diagnostic",
  "lastObservationAt",
  "lastObservedRootSeq",
  "title",
  "titleSource",
] as const;

const ALLOWED_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

// Identity fields are fixed at claim time and can never be changed by update().
const IDENTITY_FIELDS = [
  "rootSessionId",
  "backend",
  "canonicalCwd",
  "dshHome",
  "profile",
  "route",
  "configFingerprint",
  "taskId",
  "schemaVersion",
  "owner",
  "createdAt",
] as const;

const PATCH_KEYS = new Set<string>([
  "observationEpoch",
  "cleanShutdown",
  "cleanShutdownAt",
  "title",
  "titleSource",
  "lastObservationAt",
  "lastObservedRootSeq",
  "diagnostic",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireTaskId(taskId: string): void {
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    throw new RuntimeRegistryError("invalid_record", `invalid task id ${JSON.stringify(taskId)}`);
  }
}

function requireAbsolutePath(value: unknown, field: string): string {
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    throw new RuntimeRegistryError("invalid_record", `${field} must be an absolute path, got ${JSON.stringify(value)}`, {
      field,
    });
  }
  return resolve(value);
}

function validateRoute(value: unknown): SdkRuntimeRoute {
  const route = asObject(value);
  if (route === undefined) {
    throw new RuntimeRegistryError("invalid_record", "route must be an object", { field: "route" });
  }
  for (const key of Object.keys(route)) {
    if (key !== "provider" && key !== "model" && key !== "reasoningEffort") {
      throw new RuntimeRegistryError("invalid_record", `route has unknown field ${JSON.stringify(key)}`, {
        field: "route",
        unknown: key,
      });
    }
  }
  const provider = route.provider;
  const model = route.model;
  const reasoningEffort = route.reasoningEffort;
  if (!isNonEmptyString(provider) || !isNonEmptyString(model)) {
    throw new RuntimeRegistryError("invalid_record", "route.provider and route.model must be non-empty strings", {
      field: "route",
    });
  }
  if (reasoningEffort !== undefined && (!isNonEmptyString(reasoningEffort) || reasoningEffort.trim().length === 0)) {
    throw new RuntimeRegistryError("invalid_record", "route.reasoningEffort must be a non-empty string when present", {
      field: "route",
    });
  }
  return { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) };
}

function validateOwner(value: unknown): SdkRuntimeOwner {
  const owner = asObject(value);
  if (owner === undefined) {
    throw new RuntimeRegistryError("invalid_record", "owner must be an object", { field: "owner" });
  }
  for (const key of Object.keys(owner)) {
    if (key !== "bridgeInstanceId" && key !== "pid" && key !== "startedAt") {
      throw new RuntimeRegistryError("invalid_record", `owner has unknown field ${JSON.stringify(key)}`, {
        field: "owner",
        unknown: key,
      });
    }
  }
  const bridgeInstanceId = owner.bridgeInstanceId;
  const pid = owner.pid;
  const startedAt = owner.startedAt;
  if (!isNonEmptyString(bridgeInstanceId)) {
    throw new RuntimeRegistryError("invalid_record", "owner.bridgeInstanceId must be a non-empty string", {
      field: "owner.bridgeInstanceId",
    });
  }
  if (!isPositiveInteger(pid)) {
    throw new RuntimeRegistryError("invalid_record", `owner.pid must be a positive integer, got ${JSON.stringify(pid)}`, {
      field: "owner.pid",
    });
  }
  if (!isNonEmptyString(startedAt)) {
    throw new RuntimeRegistryError("invalid_record", "owner.startedAt must be a non-empty string", {
      field: "owner.startedAt",
    });
  }
  return { bridgeInstanceId, pid, startedAt };
}

function validateDiagnostic(value: unknown): { runtimePid?: number; runtimeStartedAt?: string; lastError?: string } {
  const diagnostic = asObject(value);
  if (diagnostic === undefined) {
    throw new RuntimeRegistryError("invalid_record", "diagnostic must be an object", { field: "diagnostic" });
  }
  for (const key of Object.keys(diagnostic)) {
    if (key !== "runtimePid" && key !== "runtimeStartedAt" && key !== "lastError") {
      throw new RuntimeRegistryError("invalid_record", `diagnostic has unknown field ${JSON.stringify(key)}`, {
        field: "diagnostic",
        unknown: key,
      });
    }
  }
  const runtimePid = diagnostic.runtimePid;
  const lastError = diagnostic.lastError;
  const runtimeStartedAt = diagnostic.runtimeStartedAt;
  if (runtimePid === undefined && runtimeStartedAt === undefined && lastError === undefined) {
    throw new RuntimeRegistryError("invalid_record", "diagnostic must carry runtimePid or lastError", {
      field: "diagnostic",
    });
  }
  if (runtimePid !== undefined && !isPositiveInteger(runtimePid)) {
    throw new RuntimeRegistryError(
      "invalid_record",
      `diagnostic.runtimePid must be a positive integer, got ${JSON.stringify(runtimePid)}`,
      { field: "diagnostic.runtimePid" },
    );
  }
  if (runtimeStartedAt !== undefined && typeof runtimeStartedAt !== "string") {
    throw new RuntimeRegistryError("invalid_record", "diagnostic.runtimeStartedAt must be a string", {
      field: "diagnostic.runtimeStartedAt",
    });
  }
  if (lastError !== undefined && typeof lastError !== "string") {
    throw new RuntimeRegistryError("invalid_record", "diagnostic.lastError must be a string", {
      field: "diagnostic.lastError",
    });
  }
  return {
    ...(runtimePid !== undefined ? { runtimePid } : {}),
    ...(runtimeStartedAt !== undefined ? { runtimeStartedAt } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

function validateRecord(value: unknown, expectedTaskId: string, path: string): SdkRuntimeRecord {
  const raw = asObject(value);
  if (raw === undefined) {
    throw new RuntimeRegistryError("invalid_record", `invalid SDK runtime record in ${path}: not a JSON object`);
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has unknown field ${JSON.stringify(key)}`);
    }
  }
  if (raw.schemaVersion !== SDK_RUNTIME_RECORD_SCHEMA_VERSION) {
    throw new RuntimeRegistryError(
      "invalid_record",
      `SDK runtime record in ${path} has unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}`,
    );
  }
  if (raw.taskId !== expectedTaskId) {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} does not match its task id`);
  }
  const rootSessionId = raw.rootSessionId;
  const backend = raw.backend;
  const profile = raw.profile;
  const configFingerprint = raw.configFingerprint;
  const observationEpoch = raw.observationEpoch;
  const cleanShutdown = raw.cleanShutdown;
  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;

  if (!isNonEmptyString(rootSessionId)) {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an empty rootSessionId`);
  }
  if (backend !== "sdk") {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has backend ${JSON.stringify(backend)}`);
  }
  if (!isNonEmptyString(profile)) {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an empty profile`);
  }
  if (!isNonEmptyString(configFingerprint)) {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an empty configFingerprint`);
  }
  if (!isNonNegativeInteger(observationEpoch)) {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an invalid observationEpoch`);
  }
  if (typeof cleanShutdown !== "boolean") {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an invalid cleanShutdown flag`);
  }
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has invalid timestamps`);
  }

  const record: SdkRuntimeRecord = {
    schemaVersion: SDK_RUNTIME_RECORD_SCHEMA_VERSION,
    taskId: expectedTaskId,
    rootSessionId,
    backend: "sdk",
    canonicalCwd: requireAbsolutePath(raw.canonicalCwd, "canonicalCwd"),
    dshHome: requireAbsolutePath(raw.dshHome, "dshHome"),
    profile,
    route: validateRoute(raw.route),
    configFingerprint,
    observationEpoch,
    cleanShutdown,
    createdAt,
    updatedAt,
    owner: validateOwner(raw.owner),
  };

  const title = raw.title;
  if (title !== undefined) {
    if (!isNonEmptyString(title)) {
      throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an empty title`);
    }
    record.title = title;
  }
  const titleSource = raw.titleSource;
  if (titleSource !== undefined) {
    if (titleSource !== "bridge") {
      throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has titleSource ${JSON.stringify(titleSource)}`);
    }
    record.titleSource = "bridge";
  }
  if (record.titleSource !== undefined && record.title === undefined) {
    throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} sets titleSource without a title`);
  }
  const lastObservationAt = raw.lastObservationAt;
  if (lastObservationAt !== undefined) {
    if (!isNonEmptyString(lastObservationAt)) {
      throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an empty lastObservationAt`);
    }
    record.lastObservationAt = lastObservationAt;
  }
  const lastObservedRootSeq = raw.lastObservedRootSeq;
  if (lastObservedRootSeq !== undefined) {
    if (!isNonNegativeInteger(lastObservedRootSeq)) {
      throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an invalid lastObservedRootSeq`);
    }
    record.lastObservedRootSeq = lastObservedRootSeq;
  }
  const cleanShutdownAt = raw.cleanShutdownAt;
  if (cleanShutdownAt !== undefined) {
    if (!isNonEmptyString(cleanShutdownAt)) {
      throw new RuntimeRegistryError("invalid_record", `SDK runtime record in ${path} has an empty cleanShutdownAt`);
    }
    record.cleanShutdownAt = cleanShutdownAt;
  }
  if (record.cleanShutdownAt !== undefined && !record.cleanShutdown) {
    throw new RuntimeRegistryError(
      "invalid_record",
      `SDK runtime record in ${path} records cleanShutdownAt while cleanShutdown is false`,
    );
  }
  const diagnostic = raw.diagnostic;
  if (diagnostic !== undefined) {
    record.diagnostic = validateDiagnostic(diagnostic);
  }
  return record;
}

function parseRecord(raw: string, expectedTaskId: string, path: string): SdkRuntimeRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RuntimeRegistryError("invalid_record", `could not parse SDK runtime record in ${path}`, { path }, { cause: error });
  }
  return validateRecord(value, expectedTaskId, path);
}

function cloneRecord(record: SdkRuntimeRecord): SdkRuntimeRecord {
  return {
    ...record,
    route: { ...record.route },
    owner: { ...record.owner },
    ...(record.diagnostic !== undefined ? { diagnostic: { ...record.diagnostic } } : {}),
  };
}

function normalizedClaim(input: SdkRuntimeClaimInput): SdkRuntimeClaimInput {
  requireTaskId(input.taskId);
  if (!isNonEmptyString(input.rootSessionId)) {
    throw new RuntimeRegistryError("invalid_record", "rootSessionId must be a non-empty string", {
      field: "rootSessionId",
    });
  }
  if (!isNonEmptyString(input.profile)) {
    throw new RuntimeRegistryError("invalid_record", "profile must be a non-empty string", { field: "profile" });
  }
  if (!isNonEmptyString(input.configFingerprint)) {
    throw new RuntimeRegistryError("invalid_record", "configFingerprint must be a non-empty string", {
      field: "configFingerprint",
    });
  }
  if (!isNonNegativeInteger(input.observationEpoch)) {
    throw new RuntimeRegistryError("invalid_record", "observationEpoch must be an integer >= 0", {
      field: "observationEpoch",
    });
  }
  const title = input.title;
  if (title !== undefined && !isNonEmptyString(title)) {
    throw new RuntimeRegistryError("invalid_record", "title must be a non-empty string when present", { field: "title" });
  }
  return {
    taskId: input.taskId,
    rootSessionId: input.rootSessionId,
    canonicalCwd: requireAbsolutePath(input.canonicalCwd, "canonicalCwd"),
    dshHome: requireAbsolutePath(input.dshHome, "dshHome"),
    profile: input.profile,
    route: validateRoute(input.route),
    configFingerprint: input.configFingerprint,
    observationEpoch: input.observationEpoch,
    owner: validateOwner(input.owner),
    ...(title !== undefined ? { title } : {}),
  };
}

export class RuntimeRegistry {
  readonly dir: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, "runtimes");
  }

  static configFingerprint(input: {
    backend: "sdk";
    dshHome: string;
    profile: string;
    route: SdkRuntimeRoute;
    bin?: string;
  }): string {
    // Fixed key order, documented fields only: no environment dump, no credential.
    const canonical = JSON.stringify({
      backend: input.backend,
      bin: input.bin ?? "",
      dshHome: input.dshHome,
      profile: input.profile,
      route: {
        provider: input.route.provider,
        model: input.route.model,
        reasoningEffort: input.route.reasoningEffort ?? "",
      },
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  }

  async claim(input: SdkRuntimeClaimInput): Promise<{ record: SdkRuntimeRecord; created: boolean }> {
    const requested = normalizedClaim(input);
    return this.withRegistryLock(async () => {
      const stored = await this.readRecord(requested.taskId);
      if (stored === undefined) {
        const now = new Date().toISOString();
        const record: SdkRuntimeRecord = {
          schemaVersion: SDK_RUNTIME_RECORD_SCHEMA_VERSION,
          taskId: requested.taskId,
          rootSessionId: requested.rootSessionId,
          backend: "sdk",
          canonicalCwd: requested.canonicalCwd,
          dshHome: requested.dshHome,
          profile: requested.profile,
          route: requested.route,
          configFingerprint: requested.configFingerprint,
          observationEpoch: requested.observationEpoch,
          cleanShutdown: false,
          createdAt: now,
          updatedAt: now,
          owner: requested.owner,
          // A title coming from the bridge is always tagged as bridge-local
          // display metadata; it is never presented as an upstream rename.
          ...(requested.title !== undefined ? { title: requested.title, titleSource: "bridge" as const } : {}),
        };
        await this.writeRecord(record);
        return { record: cloneRecord(record), created: true };
      }

      const differences = identityDifferences(stored, requested);
      if (Object.keys(differences).length > 0) {
        throw new RuntimeRegistryError(
          "identity_mismatch",
          `SDK runtime identity for task ${requested.taskId} does not match the recorded environment`,
          { taskId: requested.taskId, differingFields: Object.keys(differences).sort(), differences },
        );
      }

      if (stored.owner.bridgeInstanceId === requested.owner.bridgeInstanceId) {
        // Same owner instance re-claiming is idempotent: no rewrite, no new epoch.
        return { record: cloneRecord(stored), created: false };
      }

      if (!stored.cleanShutdown) {
        throw new RuntimeRegistryError(
          "owner_conflict",
          `SDK runtime for task ${requested.taskId} is owned by another bridge that has not shut down cleanly`,
          { taskId: requested.taskId, owner: { ...stored.owner } },
        );
      }

      // Takeover is only ever accepted after a recorded clean shutdown; stale
      // ownership is never auto-released by wall-clock time or PID liveness.
      const next: SdkRuntimeRecord = {
        ...stored,
        owner: requested.owner,
        cleanShutdown: false,
        // A new owner means a new observation epoch; never move it backwards.
        observationEpoch: Math.max(stored.observationEpoch, requested.observationEpoch),
        updatedAt: new Date().toISOString(),
        ...(requested.title !== undefined ? { title: requested.title, titleSource: "bridge" as const } : {}),
      };
      delete next.cleanShutdownAt;
      await this.writeRecord(next);
      return { record: cloneRecord(next), created: false };
    });
  }

  async get(taskId: string): Promise<SdkRuntimeRecord | undefined> {
    requireTaskId(taskId);
    return this.withRegistryLock(async () => {
      const stored = await this.readRecord(taskId);
      return stored === undefined ? undefined : cloneRecord(stored);
    });
  }

  /** Operator-only recovery; never used by ordinary claim() or automatic reconnect. */
  async recoverOrphan(input: SdkRuntimeClaimInput, expected: { ownerInstanceId: string; updatedAt: string }) {
    const requested = normalizedClaim(input);
    return this.withRegistryLock(async () => {
      const stored = await this.readRecord(requested.taskId);
      if (!stored) throw new RuntimeRegistryError("not_found", "recovery task not found");
      if (stored.owner.bridgeInstanceId !== expected.ownerInstanceId || stored.updatedAt !== expected.updatedAt) {
        throw new RuntimeRegistryError("owner_conflict", "recovery snapshot changed; inspect again");
      }
      if (Object.keys(identityDifferences(stored, requested)).length) {
        throw new RuntimeRegistryError("identity_mismatch", "recovery must preserve the exact task environment");
      }
      const requireAbsent = (pid: number) => {
        try { process.kill(pid, 0); }
        catch (error) { if (errorCode(error) === "ESRCH") return; throw error; }
        throw new RuntimeRegistryError("owner_conflict", "recorded owner or runtime process still exists", { pid });
      };
      requireAbsent(stored.owner.pid);
      if (stored.diagnostic?.runtimePid) requireAbsent(stored.diagnostic.runtimePid);
      const directory = join(this.dir, "recoveries");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const backupPath = join(directory, `${stored.taskId}-${randomBytes(12).toString("hex")}.json`);
      await writeFile(backupPath, JSON.stringify({
        action: "operator-orphan-recovery", at: new Date().toISOString(),
        previousRecord: stored, nextOwner: requested.owner,
        note: "Previous exit remains unclean; recovery sends no prompt and makes no history-completeness claim.",
      }, null, 2), { flag: "wx", mode: 0o600 });
      // Repeat the process check after the durable audit, under the same registry lock.
      requireAbsent(stored.owner.pid);
      const next: SdkRuntimeRecord = {
        ...stored, owner: requested.owner, cleanShutdown: false,
        observationEpoch: stored.observationEpoch + 1, updatedAt: new Date().toISOString(),
      };
      delete next.cleanShutdownAt;
      await this.writeRecord(next);
      return { record: cloneRecord(next), backupPath };
    });
  }

  async list(): Promise<SdkRuntimeRecord[]> {
    return this.withRegistryLock(async () => (await this.readAllRecords()).map(cloneRecord));
  }

  async update(taskId: string, patch: SdkRuntimePatch): Promise<SdkRuntimeRecord> {
    requireTaskId(taskId);
    const validated = validatePatch(patch);
    return this.withRegistryLock(async () => {
      const stored = await this.readRecord(taskId);
      if (stored === undefined) {
        throw new RuntimeRegistryError("not_found", `SDK runtime record for task ${taskId} does not exist`, { taskId });
      }
      const next: SdkRuntimeRecord = { ...stored };
      if (validated.observationEpoch !== undefined) next.observationEpoch = validated.observationEpoch;
      if (validated.lastObservationAt !== undefined) next.lastObservationAt = validated.lastObservationAt;
      if (validated.lastObservedRootSeq !== undefined) next.lastObservedRootSeq = validated.lastObservedRootSeq;
      if (validated.diagnostic !== undefined) next.diagnostic = validated.diagnostic;
      if (validated.title !== undefined) {
        next.title = validated.title;
        next.titleSource = validated.titleSource ?? "bridge";
      } else if (validated.titleSource !== undefined) {
        throw new RuntimeRegistryError("invalid_record", "titleSource requires a title in the same patch", {
          field: "titleSource",
        });
      }
      if (validated.cleanShutdown === true) {
        next.cleanShutdown = true;
        next.cleanShutdownAt = validated.cleanShutdownAt ?? next.cleanShutdownAt ?? new Date().toISOString();
      } else if (validated.cleanShutdown === false) {
        next.cleanShutdown = false;
        delete next.cleanShutdownAt;
      }
      next.updatedAt = new Date().toISOString();
      await this.writeRecord(next);
      return cloneRecord(next);
    });
  }

  async markOwnerExited(
    taskId: string,
    ownerInstanceId: string,
    outcome: { clean: boolean; at: string },
  ): Promise<SdkRuntimeRecord | undefined> {
    requireTaskId(taskId);
    if (!isNonEmptyString(ownerInstanceId)) {
      throw new RuntimeRegistryError("invalid_record", "ownerInstanceId must be a non-empty string", {
        field: "ownerInstanceId",
      });
    }
    const clean = asObject(outcome)?.clean;
    const at = asObject(outcome)?.at;
    if (typeof clean !== "boolean" || !isNonEmptyString(at)) {
      throw new RuntimeRegistryError("invalid_record", "outcome must be { clean: boolean, at: non-empty string }", {
        field: "outcome",
      });
    }
    return this.withRegistryLock(async () => {
      const stored = await this.readRecord(taskId);
      if (stored === undefined || stored.owner.bridgeInstanceId !== ownerInstanceId) return undefined;
      const next: SdkRuntimeRecord = {
        ...stored,
        cleanShutdown: clean,
        updatedAt: new Date().toISOString(),
      };
      if (clean) next.cleanShutdownAt = at;
      else delete next.cleanShutdownAt;
      await this.writeRecord(next);
      return cloneRecord(next);
    });
  }

  /**
   * Reachability classification for diagnostics only. The mapping is:
   *   missing file                          -> "missing"
   *   record with cleanShutdown === true    -> "unowned"  (safe to take over)
   *   record with cleanShutdown === false   -> "owned"    (single-bridge assumption:
   *                                            presence of a live-looking record)
   * This is not an ownership decision: an adapter that wants to take a task over
   * must call claim() and let the locked transaction decide conflicts.
   */
  async describe(
    taskId: string,
  ): Promise<{ record?: SdkRuntimeRecord; ownership: "owned" | "other-owner" | "unowned" | "missing" }> {
    requireTaskId(taskId);
    return this.withRegistryLock(async () => {
      const stored = await this.readRecord(taskId);
      if (stored === undefined) return { ownership: "missing" as const };
      return {
        record: cloneRecord(stored),
        ownership: stored.cleanShutdown ? ("unowned" as const) : ("owned" as const),
      };
    });
  }

  async remove(taskId: string): Promise<boolean> {
    requireTaskId(taskId);
    return this.withRegistryLock(async () => {
      try {
        await unlink(this.pathFor(taskId));
        return true;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    });
  }

  private async withRegistryLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    return withFileLock(join(this.dir, "registry.lock"), work);
  }

  private async readAllRecords(): Promise<SdkRuntimeRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    // Same strictness as TaskStore: an invalid record is an error, never skipped.
    const taskIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    const records: SdkRuntimeRecord[] = [];
    for (const taskId of taskIds) {
      requireTaskId(taskId);
      const path = this.pathFor(taskId);
      records.push(parseRecord(await readFile(path, "utf8"), taskId, path));
    }
    return records;
  }

  private async readRecord(taskId: string): Promise<SdkRuntimeRecord | undefined> {
    const path = this.pathFor(taskId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    return parseRecord(raw, taskId, path);
  }

  private async writeRecord(record: SdkRuntimeRecord): Promise<void> {
    const target = this.pathFor(record.taskId);
    const temp = join(this.dir, `.${record.taskId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private pathFor(taskId: string): string {
    requireTaskId(taskId);
    return join(this.dir, `${taskId}.json`);
  }
}

function identityDifferences(stored: SdkRuntimeRecord, requested: SdkRuntimeClaimInput): Record<string, unknown> {
  const differences: Record<string, unknown> = {};
  const scalars = [
    "rootSessionId",
    "canonicalCwd",
    "dshHome",
    "profile",
    "configFingerprint",
  ] as const;
  for (const field of scalars) {
    if (stored[field] !== requested[field]) {
      differences[field] = { stored: stored[field], requested: requested[field] };
    }
  }
  const routeFields = ["provider", "model", "reasoningEffort"] as const;
  const routeDifference: Record<string, unknown> = {};
  for (const field of routeFields) {
    if (stored.route[field] !== requested.route[field]) {
      routeDifference[field] = { stored: stored.route[field], requested: requested.route[field] };
    }
  }
  if (Object.keys(routeDifference).length > 0) differences.route = routeDifference;
  return differences;
}

function validatePatch(patch: SdkRuntimePatch): SdkRuntimePatch {
  const raw = asObject(patch);
  if (raw === undefined) {
    throw new RuntimeRegistryError("invalid_record", "patch must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!PATCH_KEYS.has(key)) {
      const identity = (IDENTITY_FIELDS as readonly string[]).includes(key);
      throw new RuntimeRegistryError(
        "invalid_record",
        identity
          ? `update() cannot change identity field ${JSON.stringify(key)}; only claim() may set it`
          : `unknown patch field ${JSON.stringify(key)}`,
        { field: key, identity },
      );
    }
  }

  const validated: SdkRuntimePatch = {};
  const observationEpoch = raw.observationEpoch;
  if (observationEpoch !== undefined) {
    if (!isNonNegativeInteger(observationEpoch)) {
      throw new RuntimeRegistryError("invalid_record", "observationEpoch must be an integer >= 0", {
        field: "observationEpoch",
      });
    }
    validated.observationEpoch = observationEpoch;
  }
  const cleanShutdown = raw.cleanShutdown;
  if (cleanShutdown !== undefined) {
    if (typeof cleanShutdown !== "boolean") {
      throw new RuntimeRegistryError("invalid_record", "cleanShutdown must be a boolean", { field: "cleanShutdown" });
    }
    validated.cleanShutdown = cleanShutdown;
  }
  const cleanShutdownAt = raw.cleanShutdownAt;
  if (cleanShutdownAt !== undefined) {
    if (!isNonEmptyString(cleanShutdownAt)) {
      throw new RuntimeRegistryError("invalid_record", "cleanShutdownAt must be a non-empty string", {
        field: "cleanShutdownAt",
      });
    }
    if (validated.cleanShutdown !== true) {
      throw new RuntimeRegistryError(
        "invalid_record",
        "cleanShutdownAt requires cleanShutdown: true in the same patch",
        { field: "cleanShutdownAt" },
      );
    }
    validated.cleanShutdownAt = cleanShutdownAt;
  }
  const title = raw.title;
  if (title !== undefined) {
    if (!isNonEmptyString(title)) {
      throw new RuntimeRegistryError("invalid_record", "title must be a non-empty string", { field: "title" });
    }
    validated.title = title;
  }
  const titleSource = raw.titleSource;
  if (titleSource !== undefined) {
    if (titleSource !== "bridge") {
      throw new RuntimeRegistryError("invalid_record", 'titleSource must be "bridge"', { field: "titleSource" });
    }
    validated.titleSource = "bridge";
  }
  const lastObservationAt = raw.lastObservationAt;
  if (lastObservationAt !== undefined) {
    if (!isNonEmptyString(lastObservationAt)) {
      throw new RuntimeRegistryError("invalid_record", "lastObservationAt must be a non-empty string", {
        field: "lastObservationAt",
      });
    }
    validated.lastObservationAt = lastObservationAt;
  }
  const lastObservedRootSeq = raw.lastObservedRootSeq;
  if (lastObservedRootSeq !== undefined) {
    if (!isNonNegativeInteger(lastObservedRootSeq)) {
      throw new RuntimeRegistryError("invalid_record", "lastObservedRootSeq must be an integer >= 0", {
        field: "lastObservedRootSeq",
      });
    }
    validated.lastObservedRootSeq = lastObservedRootSeq;
  }
  const diagnostic = raw.diagnostic;
  if (diagnostic !== undefined) {
    validated.diagnostic = validateDiagnostic(diagnostic);
  }
  return validated;
}
