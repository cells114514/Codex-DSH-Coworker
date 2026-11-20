#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { SDK_BACKEND_CAPABILITIES, type BackendCapabilities, type BackendTransport } from "./backend-capabilities.js";
import type { BridgeConfig, SdkBridgeConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { getHostEndpointSnapshot } from "./dsh-client.js";
import type { DshApi } from "./dsh-types.js";
import { collectLockDiagnostics, type LockDiagnostics } from "./lock-doctor.js";
import { createDshApi } from "./dsh-api-factory.js";
import { RuntimeRegistry, type SdkRuntimeRecord } from "./runtime-registry.js";
import { SdkObservedEventStore } from "./sdk-observed-event-store.js";
import { SdkRuntimeManager, type SdkRuntimeClient, type SdkRuntimeClientFactory } from "./sdk-runtime-manager.js";

const execFileAsync = promisify(execFile);
const TESTED_CLI_VERSION = "0.1.0-rc.6";
const SDK_CLIENT_SPECIFIER = "@deepseek-ai/dsh-sdk-client";
const DSH_RUNTIME_PACKAGE = ["@deepseek-ai", "dsh"] as const;

export type CliVersionProbe = () => Promise<string | undefined>;

export async function probeDshCliVersion(): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync("dsh", ["--version"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const value = `${stdout}${stderr}`.trim().split(/\s+/).at(-1);
    return value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function startCommand(hostUrl: string): string {
  const url = new URL(hostUrl);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return `dsh web --host ${host} --port ${port}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function probeMux(api: DshApi): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  let opened = false;
  const consume = (async () => {
    try {
      for await (const _frame of api.openMux(controller.signal, () => {
        opened = true;
        controller.abort();
      })) {
        break;
      }
    } catch (error) {
      if (!opened) throw error;
    }
  })();
  try {
    await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("events.mux open timed out")), 5_000);
        timer.unref?.();
      }),
    ]);
    return opened ? { ok: true } : { ok: false, error: "events.mux closed before opening" };
  } catch (error) {
    controller.abort();
    await consume.catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// SDK backend: static report
//
// The SDK doctor never asks the Host-facing methods anything. `hostDescribe`,
// `sessionList`, and `openMux` throw `unsupported_capability` on this backend,
// so the branch below is taken before any of them is reached. The report is
// assembled from configuration, filesystem shape, the runtime registry, and the
// bridge's own observation store — nothing is spawned, prompted, or resumed.
// ---------------------------------------------------------------------------

export type SdkPathType = "directory" | "file" | "symbolic-link" | "other" | "missing" | "unreadable";

export interface SdkObservedPath {
  path: string;
  exists: boolean;
  type: SdkPathType;
}

export interface SdkPackageReport {
  clientPackageResolvable: boolean;
  clientPackagePath?: string;
  clientVersion?: string;
  runtimeResolvable: boolean;
  runtimeVersion?: string;
  runtimeBin?: string;
  /** Bounded, non-secret explanation of a resolution failure. */
  error?: string;
}

export type SdkPackageResolver = (input: { dshHome: string; bin?: string }) => Promise<SdkPackageReport>;

export interface SdkDoctorOptions {
  /** Test seam: replace package resolution so a missing dependency is reproducible. */
  resolvePackages?: SdkPackageResolver;
}

export interface SdkRuntimeRow {
  taskId: string;
  rootSessionId: string;
  cleanShutdown: boolean;
  /** Bridge instance that claimed the runtime; the recorded pid is never printed. */
  ownerBridgeInstanceId: string;
  updatedAt: string;
  observedEvents: number;
}

export interface SdkRuntimeErrorRow {
  taskId: string;
  error: string;
}

export interface SdkConfigReport {
  dshHome: string;
  profile: string;
  bin: string | null;
  maxRuntimes: number;
  idleTimeoutMs: number;
  initializeTimeoutMs: number;
  shutdownTimeoutMs: number;
  route: { provider: string; model: string; reasoningEffort?: string } | { source: "sdk-default"; note: string };
  profileWarning?: string;
}

export interface SdkBinCheckReport {
  configured: boolean;
  path?: string;
  exists?: boolean;
  isFile?: boolean;
}

export interface SdkHomesReport {
  dshHome: SdkObservedPath;
  profiles: SdkObservedPath;
  sessions: SdkObservedPath;
  bridgeHome: SdkObservedPath & { creatable: boolean };
  warnings: string[];
}

export interface SdkDoctorReport {
  ok: boolean;
  backend: "sdk";
  transport: BackendTransport;
  capabilities: BackendCapabilities;
  checkedAt: string;
  lockDiagnostics: LockDiagnostics;
  config?: SdkConfigReport;
  sdks?: SdkPackageReport;
  binCheck?: SdkBinCheckReport;
  homes?: SdkHomesReport;
  runtimes?: Array<SdkRuntimeRow | SdkRuntimeErrorRow>;
  notes: string[];
  error?: { name: string; message: string };
}

const SDK_DOCTOR_NOTES = [
  "This report is static: doctor spawns no runtime, sends no prompt, resumes no session, and does not start DSH Desktop unless --probe-sdk (which implies --live) is passed.",
  "Approvals and native user questions come from the runtime's own opt-in handlers (initialize.approvalRequests plus onRequest/onUserQuestion), so both are supported on this backend.",
  "This backend has no session catalog, no authoritative history, and no turn/queue cancel: \"no tasks listed\" means unobserved by this bridge, never unauthorized or deleted.",
];

/**
 * Inert `DshApi` for a config whose backend is `sdk`.
 *
 * The SDK branch of `runDoctor` never performs a Host-facing call, so callers can
 * avoid constructing the adapter at all. If that branch order ever regressed,
 * the doctor would fail loudly here instead of silently probing a Host.
 */
export const SDK_ONLY_DOCTOR_API = {} as unknown as DshApi;

const RUNTIME_FALLBACK_ROUTE = "deepseek-official/deepseek-v4-flash";

async function observePath(path: string): Promise<SdkObservedPath> {
  try {
    const details = await lstat(path);
    const type: SdkPathType = details.isSymbolicLink()
      ? "symbolic-link"
      : details.isDirectory()
        ? "directory"
        : details.isFile()
          ? "file"
          : "other";
    return { path, exists: true, type };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { path, exists: false, type: code === "ENOENT" ? "missing" : "unreadable" };
  }
}

async function nearestExistingDirectory(path: string): Promise<string | undefined> {
  let current = resolve(path);
  for (;;) {
    const observed = await observePath(current);
    if (observed.exists) {
      if (observed.type === "directory" || observed.type === "symbolic-link") return current;
      return undefined;
    }
    if (observed.type === "unreadable") return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Whether the bridge home exists or could be created by this process. Never creates it. */
async function inspectCreatable(path: string): Promise<boolean> {
  const observed = await observePath(path);
  if (observed.exists) {
    if (observed.type !== "directory") return false;
    return access(path, fsConstants.W_OK).then(
      () => true,
      () => false,
    );
  }
  const ancestor = await nearestExistingDirectory(path);
  if (ancestor === undefined) return false;
  return access(ancestor, fsConstants.W_OK).then(
    () => true,
    () => false,
  );
}

async function inspectHomes(sdk: SdkBridgeConfig, bridgeHome: string): Promise<SdkHomesReport> {
  const [dshHome, profiles, sessions, bridge, creatable] = await Promise.all([
    observePath(sdk.dshHome),
    observePath(join(sdk.dshHome, "profiles")),
    observePath(join(sdk.dshHome, "sessions")),
    observePath(bridgeHome),
    inspectCreatable(bridgeHome),
  ]);
  const warnings: string[] = [];
  if (!dshHome.exists) {
    warnings.push("DSH_HOME does not exist yet; the SDK runtime creates it on first start, so this is not a failure.");
  }
  if (!profiles.exists) {
    warnings.push("DSH_HOME/profiles is absent; the runtime creates it when the profile is first used.");
  }
  if (!sessions.exists) {
    warnings.push("DSH_HOME/sessions is absent; the runtime creates it on the first session.");
  }
  if (!creatable) {
    warnings.push("The bridge home is neither present nor creatable by this process; tasks, ledgers, and runtime records cannot be written.");
  }
  return { dshHome, profiles, sessions, bridgeHome: { ...bridge, creatable }, warnings };
}

async function inspectSdkBin(sdk: SdkBridgeConfig): Promise<SdkBinCheckReport> {
  if (sdk.bin === undefined) return { configured: false };
  const observed = await observePath(sdk.bin);
  return { configured: true, path: sdk.bin, exists: observed.exists, isFile: observed.type === "file" };
}

function resolveSpecifierUrl(specifier: string): string {
  const meta = import.meta as unknown as { resolve?: (specifier: string) => string };
  if (typeof meta.resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this Node.js runtime");
  }
  return meta.resolve(specifier);
}

async function readPackageManifest(path: string): Promise<{ name?: unknown; version?: unknown; bin?: unknown } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function nearestPackageRoot(startDir: string, expectedName: string): Promise<string | undefined> {
  let current = resolve(startDir);
  for (;;) {
    const manifest = await readPackageManifest(join(current, "package.json"));
    if (manifest?.name === expectedName) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function manifestBinPath(manifest: { bin?: unknown }, root: string): string | undefined {
  const bin = manifest.bin;
  if (typeof bin === "string" && bin !== "") return resolve(root, bin);
  if (typeof bin === "object" && bin !== null) {
    const named = (bin as Record<string, unknown>).dsh;
    if (typeof named === "string" && named !== "") return resolve(root, named);
  }
  return undefined;
}

/**
 * Resolve the client package through Node's own resolver and the runtime
 * package by reading the nearest `node_modules/@deepseek-ai/dsh/package.json`.
 * Failures are reported, never thrown: an uninstalled dependency is a
 * diagnostic, not a doctor crash.
 */
async function defaultSdkPackageResolver(input: { dshHome: string; bin?: string }): Promise<SdkPackageReport> {
  const report: SdkPackageReport = { clientPackageResolvable: false, runtimeResolvable: false };
  const failures: string[] = [];

  try {
    const resolved = resolveSpecifierUrl(SDK_CLIENT_SPECIFIER);
    const entryPath = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    report.clientPackageResolvable = true;
    report.clientPackagePath = entryPath;
    const root = await nearestPackageRoot(dirname(entryPath), SDK_CLIENT_SPECIFIER);
    if (root === undefined) {
      failures.push("the resolved client entry has no reachable @deepseek-ai/dsh-sdk-client package.json");
    } else {
      const manifest = await readPackageManifest(join(root, "package.json"));
      if (typeof manifest?.version === "string") report.clientVersion = manifest.version;
    }
  } catch (error) {
    failures.push(`client package ${SDK_CLIENT_SPECIFIER} is not resolvable (${messageOf(error)})`);
  }

  const bases = [
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
    input.dshHome,
    ...(input.bin === undefined ? [] : [dirname(input.bin)]),
  ];
  let runtimeRoot: string | undefined;
  for (const base of bases) {
    let current = resolve(base);
    for (;;) {
      const candidate = join(current, "node_modules", ...DSH_RUNTIME_PACKAGE);
      const manifest = await readPackageManifest(join(candidate, "package.json"));
      if (manifest?.name === `${DSH_RUNTIME_PACKAGE[0]}/${DSH_RUNTIME_PACKAGE[1]}`) {
        runtimeRoot = candidate;
        if (typeof manifest.version === "string") report.runtimeVersion = manifest.version;
        const binPath = manifestBinPath(manifest, candidate);
        if (binPath !== undefined) report.runtimeBin = binPath;
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (runtimeRoot !== undefined) break;
  }
  if (runtimeRoot !== undefined) report.runtimeResolvable = true;
  else failures.push("no node_modules/@deepseek-ai/dsh/package.json was found near the bridge, cwd, or DSH home");

  if (failures.length > 0) report.error = failures.join("; ");
  return report;
}

async function sdkRuntimeRow(
  record: SdkRuntimeRecord,
  store: SdkObservedEventStore,
): Promise<SdkRuntimeRow | SdkRuntimeErrorRow> {
  let observedEvents: number;
  try {
    observedEvents = (await store.stats(record.taskId)).events;
  } catch (error) {
    return { taskId: record.taskId, error: `observed event store: ${messageOf(error)}` };
  }
  return {
    taskId: record.taskId,
    rootSessionId: record.rootSessionId,
    cleanShutdown: record.cleanShutdown,
    ownerBridgeInstanceId: record.owner.bridgeInstanceId,
    updatedAt: record.updatedAt,
    observedEvents,
  };
}

/**
 * Every runtime record, with invalid records attributed to their task id.
 *
 * `RuntimeRegistry.list()` is strict by design and stops at the first invalid
 * record. The doctor reports instead of aborting, so a rejected listing falls
 * back to reading each `<taskId>.json` on its own.
 */
async function collectSdkRuntimes(
  homeDir: string,
): Promise<Array<SdkRuntimeRow | SdkRuntimeErrorRow>> {
  // Reading a registry creates its directory, so the static report checks first:
  // a doctor run must never create the bridge home's contents.
  const registryPath = await observePath(join(homeDir, "runtimes"));
  if (!registryPath.exists) return [];
  if (registryPath.type === "unreadable") {
    return [{ taskId: "<registry>", error: "the runtime registry path exists but cannot be inspected" }];
  }

  const registry = new RuntimeRegistry(homeDir);
  const store = new SdkObservedEventStore(homeDir);
  try {
    const records = await registry.list();
    const rows: Array<SdkRuntimeRow | SdkRuntimeErrorRow> = [];
    for (const record of records) rows.push(await sdkRuntimeRow(record, store));
    return rows;
  } catch {
    // Attributed scan below.
  }

  let names: string[];
  try {
    names = (await readdir(join(homeDir, "runtimes")))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  } catch (error) {
    return [{ taskId: "<registry>", error: `could not scan the runtime registry: ${messageOf(error)}` }];
  }

  const rows: Array<SdkRuntimeRow | SdkRuntimeErrorRow> = [];
  for (const taskId of names) {
    try {
      const record = await registry.get(taskId);
      if (record === undefined) {
        rows.push({ taskId, error: "the runtime record disappeared during this scan" });
        continue;
      }
      rows.push(await sdkRuntimeRow(record, store));
    } catch (error) {
      rows.push({ taskId, error: messageOf(error) });
    }
  }
  return rows;
}

async function runSdkDoctor(config: BridgeConfig, options: SdkDoctorOptions): Promise<SdkDoctorReport> {
  const checkedAt = new Date().toISOString();
  const lockDiagnostics = await collectLockDiagnostics(config.homeDir);
  const base = {
    backend: "sdk" as const,
    transport: SDK_BACKEND_CAPABILITIES.transport,
    capabilities: { ...SDK_BACKEND_CAPABILITIES },
    checkedAt,
    lockDiagnostics,
    notes: [...SDK_DOCTOR_NOTES],
  };

  const sdk = config.sdk;
  if (sdk === undefined) {
    return {
      ...base,
      ok: false,
      error: {
        name: "SdkConfigError",
        message: "the sdk backend was selected without SDK configuration; export DSH_HOST_PROTOCOL=sdk and rerun",
      },
    };
  }

  const resolvePackages = options.resolvePackages ?? defaultSdkPackageResolver;
  const sdks = await resolvePackages({
    dshHome: sdk.dshHome,
    ...(sdk.bin === undefined ? {} : { bin: sdk.bin }),
  });
  const [binCheck, homes, runtimes] = await Promise.all([
    inspectSdkBin(sdk),
    inspectHomes(sdk, config.homeDir),
    collectSdkRuntimes(config.homeDir),
  ]);

  const invalidRecords = runtimes.filter((row) => "error" in row).length;
  const route: SdkConfigReport["route"] =
    sdk.provider === undefined || sdk.model === undefined
      ? {
          source: "sdk-default",
          note: `no DSH_SDK_PROVIDER/DSH_SDK_MODEL is configured; initialize uses the runtime adapter's fallback ${RUNTIME_FALLBACK_ROUTE} and this backend exposes no model catalog`,
        }
      : {
          provider: sdk.provider,
          model: sdk.model,
          ...(sdk.reasoningEffort === undefined ? {} : { reasoningEffort: sdk.reasoningEffort }),
        };

  return {
    ...base,
    ok: sdks.clientPackageResolvable && invalidRecords === 0,
    config: {
      dshHome: sdk.dshHome,
      profile: sdk.profile,
      bin: sdk.bin ?? null,
      maxRuntimes: sdk.maxRuntimes,
      idleTimeoutMs: sdk.idleTimeoutMs,
      initializeTimeoutMs: sdk.initializeTimeoutMs,
      shutdownTimeoutMs: sdk.shutdownTimeoutMs,
      route,
      ...(sdk.profileWarning === undefined ? {} : { profileWarning: sdk.profileWarning }),
    },
    sdks,
    binCheck,
    homes,
    runtimes,
  };
}

// ---------------------------------------------------------------------------
// SDK backend: explicit live probe
// ---------------------------------------------------------------------------

/** Fixed, disclosed side effects of a live probe. */
export const SDK_PROBE_SIDE_EFFECTS = [
  "loads the plugins of the configured DSH profile",
  "may create or update the DSH home profiles and persistence directories",
  "may read the user's native credentials store",
] as const;

const MAX_PROBE_ERROR_LENGTH = 400;

export interface SdkProbeOptions {
  /** Test seam: replace the dynamically loaded official client. */
  clientFactory?: SdkRuntimeClientFactory;
  /** Hard bound for the whole probe; defaults to initialize + shutdown timeouts plus a margin. */
  timeoutMs?: number;
  cwd?: string;
}

export interface SdkProbeResult {
  ok: boolean;
  elapsedMs: number;
  serverInfo?: { name: string; version: string };
  error?: { name: string; message: string };
  sideEffects: readonly string[];
}

/** One line, bounded: a raw stderr dump is never forwarded to the report. */
function boundedError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/[\r\n]/)[0] ?? "";
  const trimmed = firstLine.length > MAX_PROBE_ERROR_LENGTH ? `${firstLine.slice(0, MAX_PROBE_ERROR_LENGTH)}…` : firstLine;
  return { name, message: trimmed === "" ? "the SDK runtime probe failed without a message" : trimmed };
}

function shortenServerInfo(info: unknown): { name: string; version: string } | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const name = (info as { name?: unknown }).name;
  const version = (info as { version?: unknown }).version;
  if (typeof name !== "string" || typeof version !== "string") return undefined;
  return { name: name.slice(0, 120), version: version.slice(0, 120) };
}

/**
 * Exactly one bounded `initialize` handshake against a real SDK runtime.
 *
 * It reuses `SdkRuntimeManager`, so the client is loaded through the same lazy
 * seam the bridge uses, and no session is resumed, no prompt is sent, and DSH
 * Desktop is never started. Failure is a reported result, not a rejection.
 */
export async function probeSdkRuntime(config: BridgeConfig, options: SdkProbeOptions = {}): Promise<SdkProbeResult> {
  const startedAt = Date.now();
  const sideEffects = [...SDK_PROBE_SIDE_EFFECTS];
  const fail = (error: unknown): SdkProbeResult => ({
    ok: false,
    elapsedMs: Date.now() - startedAt,
    error: boundedError(error),
    sideEffects,
  });

  const sdk = config.sdk;
  if (sdk === undefined) {
    return fail(new Error("the sdk backend was selected without SDK configuration; export DSH_HOST_PROTOCOL=sdk"));
  }

  const captured: { serverInfo?: { name: string; version: string } } = {};
  const manager = new SdkRuntimeManager({
    sdk,
    requestTimeoutMs: config.requestTimeoutMs,
    ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
    onRuntimeExit: () => undefined,
  });

  const route = {
    provider: sdk.provider ?? "deepseek-official",
    model: sdk.model ?? "deepseek-v4-flash",
    ...(sdk.reasoningEffort === undefined ? {} : { reasoningEffort: sdk.reasoningEffort }),
  };
  const boundMs = options.timeoutMs ?? sdk.initializeTimeoutMs + sdk.shutdownTimeoutMs + 5_000;
  let timer: NodeJS.Timeout | undefined;

  const handshake = manager.acquire({
    taskId: "doctor-live-probe",
    sessionId: "doctor-live-probe",
    cwd: options.cwd ?? process.cwd(),
    route,
    resume: false,
    onNotification: () => undefined,
    onRequest: async (_runtime, method) => {
      throw new Error(`the doctor probe answers no server request (${method})`);
    },
    onUserQuestion: async () => {
      throw new Error("the doctor probe answers no user question");
    },
  });
  handshake.catch(() => undefined);

  try {
    const runtime = await Promise.race([
      handshake,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the SDK live probe exceeded its ${boundMs} ms bound`)), boundMs);
      }),
    ]);
    const result: SdkProbeResult = {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      sideEffects,
    };
    const serverInfo = shortenServerInfo(runtime.serverInfo);
    if (serverInfo !== undefined) captured.serverInfo = serverInfo;
    if (captured.serverInfo !== undefined) result.serverInfo = captured.serverInfo;
    return result;
  } catch (error) {
    return fail(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await manager.closeAll("doctor-probe").catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Host-backed doctor (legacy + gateway) — unchanged behavior
// ---------------------------------------------------------------------------

export async function runDoctor(
  config: BridgeConfig,
  api: DshApi,
  cliVersionProbe: CliVersionProbe = probeDshCliVersion,
  options: SdkDoctorOptions = {},
) {
  // The SDK branch is decided first: `hostDescribe`, `sessionList`, and
  // `openMux` are Host-only and throw `unsupported_capability` on this backend.
  // It also skips the CLI version probe, so the static report spawns nothing.
  if (config.hostProtocol === "sdk") return runSdkDoctor(config, options);

  const cliVersion = await cliVersionProbe();
  const lockDiagnostics = await collectLockDiagnostics(config.homeDir);
  if (config.hostProtocol === "gateway") {
    return { ok: false, connectOnly: true, availability: "not_probed", compatibility: "unknown",
      endpoint: getHostEndpointSnapshot(api, { mode: config.hostMode, configuredBaseUrl: config.hostUrl }),
      checkedAt: new Date().toISOString(), dshCliVersion: cliVersion ?? null,
      note: "Read-only doctor does not call /connect or create an API Peer. Authenticated live validation requires explicit operator authorization.",
      lockDiagnostics };
  }
  try {
    const description = await api.hostDescribe();
    const sessions = await api.sessionList();
    const mux = await probeMux(api);
    const coreCapabilities = {
      hostDescribe: true,
      sessionList: true,
      eventsMuxWebSocket: mux.ok,
      history: sessions.items.length === 0 ? "not-probed-no-session" : "not-yet-probed",
      respond: "contract-only-not-mutated",
      queueMutation: "contract-only-not-mutated",
      muxResumeSince: false,
    } as const;
    let history: boolean | "not-probed-no-session" = "not-probed-no-session";
    if (sessions.items[0] !== undefined) {
      try {
        await api.sessionHistory(sessions.items[0].sessionId, { maxMessages: 1 });
        history = true;
      } catch {
        history = false;
      }
    }
    const coreCompatible = mux.ok && history !== false;
    const testedBuild = cliVersion === TESTED_CLI_VERSION;
    const endpoint = getHostEndpointSnapshot(api, {
      mode: config.hostMode,
      configuredBaseUrl: config.hostUrl,
    });
    return {
      ok: coreCompatible,
      connectOnly: true,
      baseUrl: endpoint.resolvedBaseUrl ?? endpoint.configuredBaseUrl ?? null,
      endpoint,
      checkedAt: new Date().toISOString(),
      dshCliVersion: cliVersion ?? null,
      testedCliVersion: TESTED_CLI_VERSION,
      hostDescribeProductVersion: description.version,
      hostVersionWarning:
        description.version === "0.0.1"
          ? "rc.6 host.describe.version is a known placeholder and is not the DSH CLI/package version"
          : "host.describe.version is reported separately and is not used as the CLI compatibility gate",
      compatibility: testedBuild && coreCompatible ? "tested" : coreCompatible ? "compatible-untested" : "incompatible",
      warning: testedBuild
        ? undefined
        : `Only DSH CLI ${TESTED_CLI_VERSION} has been locally verified; detected ${cliVersion ?? "unknown"}`,
      capabilities: { ...coreCapabilities, history },
      startCommand: undefined,
      muxError: mux.error,
      sessionCount: sessions.items.length,
      description,
      lockDiagnostics,
    };
  } catch (error) {
    const endpoint = getHostEndpointSnapshot(api, {
      mode: config.hostMode,
      configuredBaseUrl: config.hostUrl,
    });
    const baseUrl = endpoint.resolvedBaseUrl ?? endpoint.configuredBaseUrl ?? null;
    return {
      ok: false,
      connectOnly: true,
      baseUrl,
      endpoint,
      checkedAt: new Date().toISOString(),
      dshCliVersion: cliVersion ?? null,
      testedCliVersion: TESTED_CLI_VERSION,
      availability: "host_unreachable",
      error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      startCommand: endpoint.mode === "static" && baseUrl !== null ? startCommand(baseUrl) : undefined,
      note:
        endpoint.mode === "desktop-auto"
          ? "The bridge never starts, stops, or restarts DSH Desktop; start the application yourself and rerun doctor."
          : "The bridge never starts, daemonizes, or stops dsh web; run this command yourself or manage it with the OS.",
      lockDiagnostics,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface DoctorCliOptions {
  json: boolean;
  live: boolean;
  probeSdk: boolean;
  help: boolean;
}

export function parseDoctorArgs(argv: readonly string[]): DoctorCliOptions {
  const options: DoctorCliOptions = { json: false, live: false, probeSdk: false, help: false };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--live") options.live = true;
    else if (argument === "--probe-sdk") {
      // A live probe only makes sense as an explicitly live run.
      options.probeSdk = true;
      options.live = true;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`dsh-Agentlink doctor

Usage:
  npm run doctor
  npm run doctor -- --json
  DSH_HOST_PROTOCOL=sdk npm run doctor -- --probe-sdk

Options:
  --json       Print the JSON report (this is already the default output)
  --live       Explicitly allow live work; --probe-sdk implies it
  --probe-sdk  Perform exactly one bounded SDK initialize handshake (SDK backend only)
  --help, -h   Show this help

Without --probe-sdk the SDK report is static: no runtime is spawned, no prompt is
sent, no session is resumed, and DSH Desktop is never started.`);
}

async function main() {
  const options = parseDoctorArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const config = loadConfig();
  const isSdk = config.hostProtocol === "sdk";
  if (options.probeSdk && !isSdk) {
    throw new Error("--probe-sdk requires DSH_HOST_PROTOCOL=sdk");
  }
  const report = await runDoctor(config, createDshApi(config));
  if (isSdk) {
    // The SDK verdict is the static one; the probe never changes it.
    const output =
      options.probeSdk && isSdk
        ? { ...report, liveProbe: await probeSdkRuntime(config) }
        : report;
    console.log(JSON.stringify(output, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const output = JSON.stringify(report, null, 2);
  if (report.ok) console.log(output);
  else {
    console.error(output);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
}
