/**
 * One capability declaration per backend.
 *
 * Upper layers must branch on these flags instead of comparing
 * `hostProtocol === "gateway"`: the SDK backend differs from the Host-backed
 * backends in discovery, history authority, model routing, cancel, and
 * interaction support. A flag is `true` only where the backend can actually
 * implement the semantic; unsupported paths return a structured
 * `unsupported_capability` error rather than an empty list or a fake success.
 */
export type BackendId = "legacy" | "gateway" | "sdk";

export type BackendTransport = "http-websocket" | "stdio-jsonrpc";

export interface BackendCapabilities {
  backend: BackendId;
  transport: BackendTransport;
  sessionDiscovery: "host-catalog" | "bridge-owned";
  historySource: "host" | "observed-cache";
  authoritativeHistory: boolean;
  resumeSession: boolean;
  nativeRename: boolean;
  modelCatalog: boolean;
  dynamicModelSelection: boolean;
  steer: boolean;
  turnCancel: boolean;
  queueSnapshot: boolean;
  queueMutation: boolean;
  subagentHistory: boolean;
  /** Whether the backend can select an agent preset for a new session. */
  agentPreset: boolean;
  userQuestions: boolean;
  approvals: boolean;
}

/** Host-backed protocol capability probes reported by the connection layer. */
export interface HostProtocolCapabilityProbe {
  queueSnapshot?: boolean;
  timedQuestions?: boolean;
  subagentModeDiscovery?: boolean;
  subagentHistory?: boolean | "not-probed";
}

/**
 * Capabilities of the Web-Host-backed backends (`legacy`, `gateway`). Both
 * speak the same HTTP + WebSocket Host protocol; only the credential exchange
 * differs, so their feature surface is identical.
 */
export function hostBackendCapabilities(
  backend: "legacy" | "gateway",
  probe: HostProtocolCapabilityProbe = {},
): BackendCapabilities {
  return {
    backend,
    transport: "http-websocket",
    sessionDiscovery: "host-catalog",
    historySource: "host",
    authoritativeHistory: true,
    resumeSession: true,
    nativeRename: true,
    modelCatalog: true,
    dynamicModelSelection: true,
    steer: true,
    turnCancel: true,
    queueSnapshot: probe.queueSnapshot === true,
    queueMutation: probe.queueSnapshot === true,
    subagentHistory: probe.subagentHistory === true,
    agentPreset: true,
    userQuestions: true,
    approvals: true,
  };
}

/**
 * Capabilities of the SDK backend (`@deepseek-ai/dsh-sdk-client` 0.2.2-rc.3
 * against `@deepseek-ai/dsh` 0.2.2-rc.3).
 *
 * Evidence for every `false` lives in `docs/sdk-qualification.md`: the wire
 * exposes no session catalog, no history read, no rename, no model catalog, no
 * cancel, no queue control, and no steering. Approvals and native user
 * questions are real in this pair: `initialize.approvalRequests` plus
 * `client.onRequest` serves `approval/request`, and `onUserQuestion` serves
 * `user-question/ask`; both handlers are installed at client construction and
 * before `initialize`, so they are declared available from the start.
 */
export const SDK_BACKEND_CAPABILITIES: BackendCapabilities = {
  backend: "sdk",
  transport: "stdio-jsonrpc",
  sessionDiscovery: "bridge-owned",
  historySource: "observed-cache",
  authoritativeHistory: false,
  resumeSession: true,
  nativeRename: false,
  modelCatalog: false,
  dynamicModelSelection: false,
  steer: false,
  turnCancel: false,
  queueSnapshot: false,
  queueMutation: false,
  subagentHistory: true,
  agentPreset: false,
  userQuestions: true,
  approvals: true,
};

/** Capability names an error can name in `details.capability`. */
export type CapabilityName = keyof Omit<BackendCapabilities, "backend" | "transport">;
