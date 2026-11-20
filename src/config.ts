import { homedir } from "node:os";
import { resolve } from "node:path";

/** SDK backend settings; present only when `DSH_HOST_PROTOCOL=sdk`. */
export interface SdkBridgeConfig {
  /** Optional `dsh` CLI module path (`DSH_SDK_BIN`); resolved lexically, never shell-interpolated. */
  bin?: string;
  /** Harness home passed to the runtime as `dshHome` (persistence + profiles + credentials). */
  dshHome: string;
  /** Named runtime profile serving the SDK protocol. */
  profile: string;
  /** Fixed provider/model route verified during `initialize`; both set or both absent. */
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxRuntimes: number;
  /** Idle reclamation bound in milliseconds; `0` explicitly disables reclamation. */
  idleTimeoutMs: number;
  initializeTimeoutMs: number;
  shutdownTimeoutMs: number;
  /** Informational only: a non-default profile name cannot be checked for the SDK server. */
  profileWarning?: string;
}

export interface BridgeConfig {
  hostUrl: string;
  hostMode?: "static" | "desktop-auto";
  hostProtocol?: "legacy" | "gateway" | "sdk";
  connectTokenEnv?: string;
  connectTokenOrigin?: string;
  homeDir: string;
  requestTimeoutMs: number;
  allowRemoteHost: boolean;
  defaultAgentPreset?: string;
  clientTimeZone?: string;
  declaredDshVersion?: string;
  approvalTimeoutMs?: number;
  /** Present only for the SDK backend; the Host URL is then unused. */
  sdk?: SdkBridgeConfig;
}

const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SDK_PROFILE = "sdk";
export const DEFAULT_SDK_MAX_RUNTIMES = 2;
export const DEFAULT_SDK_IDLE_TIMEOUT_MS = 600_000;
export const DEFAULT_SDK_INITIALIZE_TIMEOUT_MS = 60_000;
export const DEFAULT_SDK_SHUTDOWN_TIMEOUT_MS = 10_000;

function booleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function optionalPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return positiveIntegerEnv(value, 1);
}

function nonNegativeIntegerEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be zero or a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function normalizeHostUrl(raw: string, allowRemoteHost: boolean): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`DSH host URL must use http or https, received ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("DSH host URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("DSH host URL must be an origin without a path, query, or fragment");
  }
  if (!allowRemoteHost && !isLoopback(url.hostname)) {
    throw new Error(
      `refusing non-loopback DSH host ${url.hostname}; set DSH_ALLOW_REMOTE_HOST=true only for a trusted deployment`,
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function detectTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone === "" ? undefined : timeZone;
  } catch {
    return undefined;
  }
}

function optionalTrimmed(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${name} must not be empty`);
  return trimmed;
}

/**
 * Parse and validate the SDK backend configuration.
 *
 * Only SDK variables are read here: no Host URL, connect-token, or Desktop
 * discovery setting participates, so an unrelated Host typo cannot block the
 * SDK backend and the SDK backend can never pick up Gateway credentials.
 */
export function loadSdkConfig(env: NodeJS.ProcessEnv, dshHome: string): SdkBridgeConfig {
  const bin = optionalTrimmed(env.DSH_SDK_BIN, "DSH_SDK_BIN");
  const profile = optionalTrimmed(env.DSH_SDK_PROFILE, "DSH_SDK_PROFILE") ?? DEFAULT_SDK_PROFILE;
  const provider = optionalTrimmed(env.DSH_SDK_PROVIDER, "DSH_SDK_PROVIDER");
  const model = optionalTrimmed(env.DSH_SDK_MODEL, "DSH_SDK_MODEL");
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error("DSH_SDK_PROVIDER and DSH_SDK_MODEL must be set together or omitted together");
  }
  const reasoningEffort = optionalTrimmed(env.DSH_SDK_REASONING_EFFORT, "DSH_SDK_REASONING_EFFORT");
  if (reasoningEffort !== undefined && provider === undefined) {
    throw new Error("DSH_SDK_REASONING_EFFORT requires DSH_SDK_PROVIDER and DSH_SDK_MODEL");
  }
  const maxRuntimes = positiveIntegerEnv(env.DSH_SDK_MAX_RUNTIMES, DEFAULT_SDK_MAX_RUNTIMES);
  const idleTimeoutMs = nonNegativeIntegerEnv(
    env.DSH_SDK_IDLE_TIMEOUT_MS,
    DEFAULT_SDK_IDLE_TIMEOUT_MS,
    "DSH_SDK_IDLE_TIMEOUT_MS",
  );
  const initializeTimeoutMs = positiveIntegerEnv(env.DSH_SDK_INITIALIZE_TIMEOUT_MS, DEFAULT_SDK_INITIALIZE_TIMEOUT_MS);
  const shutdownTimeoutMs = positiveIntegerEnv(env.DSH_SDK_SHUTDOWN_TIMEOUT_MS, DEFAULT_SDK_SHUTDOWN_TIMEOUT_MS);
  return {
    ...(bin === undefined ? {} : { bin: resolve(bin) }),
    dshHome,
    profile,
    ...(provider === undefined ? {} : { provider, model: model! }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    maxRuntimes,
    idleTimeoutMs,
    initializeTimeoutMs,
    shutdownTimeoutMs,
    ...(profile === DEFAULT_SDK_PROFILE
      ? {}
      : {
          profileWarning:
            "a non-default DSH_SDK_PROFILE is used as-is; verify that it still serves the SDK JSON-RPC server before relying on this backend",
        }),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const allowRemoteHost = booleanEnv(env.DSH_ALLOW_REMOTE_HOST);
  const hostProtocol = env.DSH_HOST_PROTOCOL?.trim() || "legacy";
  if (hostProtocol !== "legacy" && hostProtocol !== "gateway" && hostProtocol !== "sdk") {
    throw new Error("DSH_HOST_PROTOCOL must be legacy, gateway, or sdk");
  }
  if (env.DSH_HOME !== undefined && env.DSH_HOME.trim() === "") throw new Error("DSH_HOME must not be empty");
  if (env.DSH_BRIDGE_HOME !== undefined && env.DSH_BRIDGE_HOME.trim() === "") {
    throw new Error("DSH_BRIDGE_HOME must not be empty");
  }
  const dshHome = env.DSH_HOME === undefined ? resolve(homedir(), ".dsh") : resolve(env.DSH_HOME);
  // The SDK backend never builds a Host endpoint resolver, never reads a
  // connect token, and does not validate an unrelated DSH_HOST_URL.
  if (hostProtocol === "sdk") {
    const sdk = loadSdkConfig(env, dshHome);
    const defaultAgentPreset = env.DSH_BRIDGE_AGENT_PRESET?.trim();
    const clientTimeZone = env.DSH_BRIDGE_TIME_ZONE?.trim() || detectTimeZone();
    const declaredDshVersion = env.DSH_HOST_VERSION?.trim();
    const approvalTimeoutMs = optionalPositiveIntegerEnv(env.DSH_APPROVAL_TIMEOUT_MS);
    return {
      hostUrl: "",
      hostMode: "static",
      hostProtocol,
      homeDir: resolve(env.DSH_BRIDGE_HOME ?? resolve(dshHome, "codex-bridge-sdk")),
      requestTimeoutMs: positiveIntegerEnv(env.DSH_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      allowRemoteHost,
      ...(defaultAgentPreset === undefined || defaultAgentPreset === "" ? {} : { defaultAgentPreset }),
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      ...(declaredDshVersion === undefined || declaredDshVersion === "" ? {} : { declaredDshVersion }),
      ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
      sdk,
    };
  }
  const connectTokenEnv = env.DSH_CONNECT_TOKEN_ENV?.trim() || "DSH_CONNECT_TOKEN";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(connectTokenEnv)) {
    throw new Error("DSH_CONNECT_TOKEN_ENV must name an environment variable, not contain a token");
  }
  let connectTokenOrigin: string | undefined;
  if (hostProtocol === "gateway" && env.DSH_CONNECT_ORIGIN !== undefined) {
    try { connectTokenOrigin = normalizeHostUrl(env.DSH_CONNECT_ORIGIN, allowRemoteHost); }
    catch { throw new Error("DSH_CONNECT_ORIGIN must be a permitted credential-free origin"); }
  }
  const requestedHostMode = env.DSH_HOST_MODE?.trim() || "static";
  if (requestedHostMode !== "static" && requestedHostMode !== "desktop-auto") {
    throw new Error(`DSH_HOST_MODE must be static or desktop-auto, received ${JSON.stringify(requestedHostMode)}`);
  }
  const defaultAgentPreset = env.DSH_BRIDGE_AGENT_PRESET?.trim();
  const clientTimeZone = env.DSH_BRIDGE_TIME_ZONE?.trim() || detectTimeZone();
  const declaredDshVersion = env.DSH_HOST_VERSION?.trim();
  const approvalTimeoutMs = optionalPositiveIntegerEnv(env.DSH_APPROVAL_TIMEOUT_MS);

  return {
    hostUrl: normalizeHostUrl(env.DSH_HOST_URL ?? DEFAULT_HOST_URL, allowRemoteHost),
    hostMode: env.DSH_HOST_URL === undefined ? requestedHostMode : "static",
    hostProtocol,
    ...(hostProtocol === "gateway" ? { connectTokenEnv } : {}),
    ...(connectTokenOrigin === undefined ? {} : { connectTokenOrigin }),
    homeDir: resolve(env.DSH_BRIDGE_HOME ?? resolve(dshHome, "codex-bridge")),
    requestTimeoutMs: positiveIntegerEnv(env.DSH_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    allowRemoteHost,
    ...(defaultAgentPreset === undefined || defaultAgentPreset === "" ? {} : { defaultAgentPreset }),
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    ...(declaredDshVersion === undefined || declaredDshVersion === "" ? {} : { declaredDshVersion }),
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  };
}
