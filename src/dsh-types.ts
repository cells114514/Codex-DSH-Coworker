import { z } from "zod";

import type { BackendCapabilities, BackendId } from "./backend-capabilities.js";

const nonEmptyString = z.string().min(1);

export const dshRpcErrorBodySchema = z
  .object({
    code: nonEmptyString,
    message: z.string(),
    details: z.unknown(),
  })
  .passthrough();

export type DshRpcErrorBody = z.infer<typeof dshRpcErrorBodySchema>;

export const dshHostDescriptionSchema = z
  .object({
    version: z.string(),
    cwd: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
    attachedSessions: z.number().int().nonnegative(),
    canOpenPath: z.boolean(),
    /** Backend identity; absent for Host-backed descriptions that predate it. */
    backend: z.enum(["legacy", "gateway", "sdk"]).optional(),
    transport: z.enum(["http-websocket", "stdio-jsonrpc"]).optional(),
    /** Wire identity reported by the SDK runtime's `initialize` handshake. */
    serverName: z.string().optional(),
    serverVersion: z.string().optional(),
    /** SDK metadata: the runtime has no Desktop product version or URL to report. */
    productVersion: z.string().nullable().optional(),
    dshHome: z.string().optional(),
    profile: z.string().optional(),
    initializedRuntimes: z.number().int().nonnegative().optional(),
    capabilitySource: z.string().optional(),
  })
  .passthrough();

export type DshHostDescription = z.infer<typeof dshHostDescriptionSchema>;

export const dshModelSelectionSchema = z
  .object({
    provider: nonEmptyString,
    model: nonEmptyString,
    reasoningEffort: nonEmptyString.optional(),
  })
  .passthrough();

export type DshModelSelection = z.infer<typeof dshModelSelectionSchema>;

const dshModelReasoningEffortSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
  })
  .passthrough();

const dshModelCatalogModelSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    inputModalities: z.array(nonEmptyString).optional(),
    reasoning: z
      .object({
        efforts: z.array(dshModelReasoningEffortSchema).min(1),
        defaultEffort: nonEmptyString.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const dshModelProviderGroupSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    models: z.array(dshModelCatalogModelSchema),
  })
  .passthrough();

const dshModelCatalogFailureSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    message: z.string(),
  })
  .passthrough();

export const dshSessionModelsSchema = z
  .object({
    current: dshModelSelectionSchema,
    routable: z.boolean(),
    groups: z.array(dshModelProviderGroupSchema),
    failures: z.array(dshModelCatalogFailureSchema),
  })
  .passthrough();

export type DshSessionModels = z.infer<typeof dshSessionModelsSchema>;

export const dshSessionSelectModelValueSchema = z
  .object({ selected: dshModelSelectionSchema })
  .passthrough();

export type DshSessionSelectModelValue = z.infer<typeof dshSessionSelectModelValueSchema>;

export const dshSessionSummarySchema = z
  .object({
    sessionId: nonEmptyString,
    updatedAt: z.number(),
    running: z.boolean(),
    blank: z.boolean(),
    parentSessionId: nonEmptyString.optional(),
    origin: z.literal("subagent").optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
    projections: z.unknown().optional(),
  })
  .passthrough();

export type DshSessionSummary = z.infer<typeof dshSessionSummarySchema>;

export const dshSessionEventSchema = z
  .object({
    type: z.string(),
    seq: z.number().int().nonnegative(),
    time: z.number(),
    data: z.unknown(),
    sourceEventSeqs: z.array(z.number()).optional(),
    surfaceOp: z.unknown().optional(),
    ignorable: z.literal(true).optional(),
  })
  .passthrough();

export type DshSessionEvent = z.infer<typeof dshSessionEventSchema>;

const dshToolEventViewSchema = z
  .object({
    for: z.enum(["call", "result"]),
    view: z.object({ card: z.string() }).passthrough(),
  })
  .passthrough();

export const dshHistoryEntrySchema = z
  .object({
    event: dshSessionEventSchema,
    view: dshToolEventViewSchema.optional(),
  })
  .passthrough();

export type DshHistoryEntry = z.infer<typeof dshHistoryEntrySchema>;

export const dshSessionHistorySchema = z
  .object({
    events: z.array(dshHistoryEntrySchema),
    hasMore: z.boolean(),
    projections: z.unknown().optional(),
  })
  .passthrough();

export type DshSessionHistory = z.infer<typeof dshSessionHistorySchema> & {
  /** Adapter-normalized exact pending inbox; null means unknown, not empty.
   * Only consumed from an adapter advertising queueSnapshot capability. */
  queueSnapshot?: DshQueuedInboxItem[] | null;
};

export const dshSessionListValueSchema = z
  .object({ items: z.array(dshSessionSummarySchema) })
  .passthrough();

export type DshSessionListValue = z.infer<typeof dshSessionListValueSchema>;

export const dshSessionCreateValueSchema = z
  .object({
    sessionId: nonEmptyString,
    agentPreset: z.string().optional(),
    /**
     * Where the session identity came from. The SDK backend mints the id
     * bridge-side because the wire has no session/create method; that is not an
     * upstream server-side identity allocation.
     */
    identityProvenance: z.enum(["host-allocated", "bridge-local-id"]).optional(),
  })
  .passthrough();

export interface DshSessionCreateValue extends z.infer<typeof dshSessionCreateValueSchema> {}

export const dshSessionPromptValueSchema = z
  .object({
    accepted: z.literal(true),
    command: z
      .object({
        kind: z.literal("success"),
        text: z.string().optional(),
      })
      .passthrough()
      .optional(),
    /** Durable inbox identity of the queued user message (SDK `session/prompt`). */
    messageId: z.string().optional(),
    messageIdSource: z.enum(["sdk-durable-inbox", "host"]).optional(),
    /** False when the backend cannot transmit the caller's time zone on the wire. */
    clientTimeZoneApplied: z.boolean().optional(),
  })
  .passthrough();

export interface DshSessionPromptValue extends z.infer<typeof dshSessionPromptValueSchema> {}

export const dshSessionRenameValueSchema = z
  .object({
    title: nonEmptyString,
    seq: z.number().int().nonnegative(),
  })
  .passthrough();

export const dshSessionCancelValueSchema = z.object({ accepted: z.literal(true) }).passthrough();
export const dshSessionUpdateQueueValueSchema = z.object({ accepted: z.literal(true) }).passthrough();

export type DshSessionCancelValue = z.infer<typeof dshSessionCancelValueSchema>;
export type DshSessionUpdateQueueValue = z.infer<typeof dshSessionUpdateQueueValueSchema>;
export type DshSessionRenameValue = z.infer<typeof dshSessionRenameValueSchema>;

export const dshQueuedInboxItemSchema = z
  .object({
    id: nonEmptyString,
    placement: z.enum(["queued", "steering", "context"]),
    message: z
      .object({
        role: z.string(),
        content: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

export type DshQueuedInboxItem = z.infer<typeof dshQueuedInboxItemSchema>;

export const dshServerRequestSchema = z
  .object({
    type: z.literal("server-request"),
    rpcId: z.string(),
    method: z.string(),
    payload: z.unknown(),
  })
  .passthrough();

export interface DshServerRequest<P = unknown> {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: P;
}

export const dshSessionEventFrameSchema = z
  .object({
    type: z.literal("session/event"),
    sessionId: nonEmptyString,
    event: dshSessionEventSchema,
    view: dshToolEventViewSchema.optional(),
  })
  .passthrough();

export const dshSessionSubscribedFrameSchema = z
  .object({
    type: z.literal("session/subscribed"),
    sessionId: nonEmptyString,
    lastSeq: z.number().int(),
  })
  .passthrough();

export const dshApprovalRequestedFrameSchema = z
  .object({
    type: z.literal("approval/requested"),
    sessionId: nonEmptyString,
    approvalId: nonEmptyString,
    toolName: z.string(),
    callId: z.string().optional(),
    reason: z.string().optional(),
    /** Provenance of `approvalId`: the SDK wire carries none, so the bridge mints one. */
    approvalIdSource: z.enum(["host", "bridge-local"]).optional(),
  })
  .passthrough();

export const dshApprovalResolvedFrameSchema = z
  .object({
    type: z.literal("approval/resolved"),
    sessionId: nonEmptyString,
    approvalId: nonEmptyString,
    outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]),
  })
  .passthrough();

export const dshQuestionItemSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    detail: z.string().optional(),
    options: z
      .array(z.object({ label: z.string(), description: z.string().optional() }).passthrough())
      .optional(),
    multiSelect: z.boolean().optional(),
    intent: z
      .object({ kind: z.literal("plan-review"), approve: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const dshQuestionRequestedFrameSchema = z
  .object({
    type: z.literal("question/requested"),
    sessionId: nonEmptyString,
    questions: z.array(dshQuestionItemSchema).min(1),
  })
  .passthrough();

export const dshQuestionResolvedFrameSchema = z
  .object({
    type: z.literal("question/resolved"),
    sessionId: nonEmptyString,
    questionRpcId: z.string(),
    outcome: z.enum(["answered", "cancelled"]),
  })
  .passthrough();

export const dshQueueFrameSchema = z
  .object({
    type: z.literal("session/queue"),
    sessionId: nonEmptyString,
    items: z.array(dshQueuedInboxItemSchema),
  })
  .passthrough();

const dshJobsFrameSchema = z
  .object({
    type: z.literal("session/jobs"),
    sessionId: nonEmptyString,
    jobs: z.array(z.unknown()),
  })
  .passthrough();

const dshProjectionFrameSchema = z
  .object({
    type: z.literal("session/projection"),
    sessionId: nonEmptyString,
    key: nonEmptyString,
    value: z.unknown(),
    seq: z.number().int().nonnegative(),
  })
  .passthrough();

export const dshStreamErrorFrameSchema = z
  .object({
    type: z.literal("stream/error"),
    error: dshRpcErrorBodySchema,
  })
  .passthrough();

export const dshMuxFrameSchema = z.union([
  dshSessionEventFrameSchema,
  dshSessionSubscribedFrameSchema,
  dshApprovalRequestedFrameSchema,
  dshApprovalResolvedFrameSchema,
  dshQuestionRequestedFrameSchema,
  dshQuestionResolvedFrameSchema,
  dshQueueFrameSchema,
  dshJobsFrameSchema,
  dshProjectionFrameSchema,
  dshStreamErrorFrameSchema,
]);

export type DshMuxFrame = z.infer<typeof dshMuxFrameSchema>;
export type DshApprovalRequestedFrame = z.infer<typeof dshApprovalRequestedFrameSchema>;
export type DshQuestionRequestedFrame = z.infer<typeof dshQuestionRequestedFrameSchema>;
export type DshQuestionItem = z.infer<typeof dshQuestionItemSchema>;
export type DshPendingFrame = DshApprovalRequestedFrame | DshQuestionRequestedFrame;
export type DshPendingEnvelope =
  | DshServerRequest<DshApprovalRequestedFrame>
  | DshServerRequest<DshQuestionRequestedFrame>;

export const dshQuestionAnswerSchema = z
  .object({
    id: z.string(),
    selected: z.array(z.string()),
    custom: z.string().optional(),
  })
  .strict();

export type DshQuestionAnswer = z.infer<typeof dshQuestionAnswerSchema>;

export interface DshClientResponse {
  type: "client-response";
  rpcId: string;
  result: {
    ok: true;
    value:
      | {
          sessionId: string;
          answer: { answers: DshQuestionAnswer[] };
        }
      | {
          sessionId: string;
          approvalId: string;
          outcome: "allowed-once" | "rejected";
        };
  };
}

export const dshRpcReceiptSchema = z.union([
  z.object({ accepted: z.literal(true) }).passthrough(),
  z
    .object({
      accepted: z.literal(false),
      reason: z.enum(["not-pending", "bad-response"]),
    })
    .passthrough(),
]);

export type DshRpcReceipt = z.infer<typeof dshRpcReceiptSchema>;

// Keep the pre-rename global symbol key so mixed in-process bridge modules
// continue to recognize the same unary metadata envelope.
export const dshUnaryMetadata = Symbol.for("dsh-orchestrator.dshUnaryMetadata");

export interface DshUnaryMetadata {
  issuedRpcId: string;
  method: string;
}

export type DshUnaryResult<T extends object> = T & {
  readonly [dshUnaryMetadata]: DshUnaryMetadata;
};

export function attachDshUnaryMetadata<T extends object>(
  value: T,
  metadata: DshUnaryMetadata,
): DshUnaryResult<T> {
  const result = { ...value };
  return Object.defineProperty(result, dshUnaryMetadata, {
    value: Object.freeze({ ...metadata }),
    enumerable: false,
    configurable: false,
    writable: false,
  }) as DshUnaryResult<T>;
}

export function getDshUnaryMetadata<T extends object>(result: DshUnaryResult<T>): DshUnaryMetadata;
export function getDshUnaryMetadata(result: object): DshUnaryMetadata | undefined;
export function getDshUnaryMetadata(result: object): DshUnaryMetadata | undefined {
  return (result as { [dshUnaryMetadata]?: DshUnaryMetadata })[dshUnaryMetadata];
}

const dshSubagentChildBaseSchema = z.object({
  kind: z.literal("child"),
  id: nonEmptyString,
  activity: z.enum(["running", "inactive"]),
  hasChildren: z.boolean(),
});

export const dshSubagentListEntrySchema = z.union([
  dshSubagentChildBaseSchema.extend({ mode: z.literal("one-shot"), label: z.string().optional() }).passthrough(),
  dshSubagentChildBaseSchema.extend({ mode: z.literal("continuable"), label: z.string() }).passthrough(),
  z
    .object({
      kind: z.literal("diagnostic"),
      id: nonEmptyString,
      reason: z.enum(["corrupt", "unsupported", "unavailable"]),
    })
    .passthrough(),
]);

export const dshSubagentListValueSchema = z
  .object({
    entries: z.array(dshSubagentListEntrySchema),
    parentAvailable: z.boolean(),
  })
  .passthrough();

export type DshSubagentListValue = z.infer<typeof dshSubagentListValueSchema>;
export type DshSubagentListEntry = z.infer<typeof dshSubagentListEntrySchema>;
export type DshSubagentAddress = {
  parentSessionId: string;
  childSessionId: string;
  mode: "one-shot" | "continuable";
};

/**
 * The model route a backend actually activated for one session.
 *
 * `source` names the evidence: `session-catalog` when the Host answered a
 * model catalog and confirmed a selection, `sdk-initialize` when the SDK
 * runtime fixed the route during its `initialize` handshake. A backend that
 * cannot enumerate models never reports a catalog; it reports the fixed route
 * and `catalogAvailable: false`.
 */
export interface DshBackendRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
  source: "session-catalog" | "sdk-initialize";
  catalogAvailable: boolean;
  /** Bridge-local display title recorded when the backend has no native rename. */
  titleSource?: "bridge" | "dsh-native";
}

/**
 * Local observation coverage for backends whose history is an observed cache
 * rather than an authoritative Host history. Host-backed histories leave this
 * undefined.
 */
export interface DshObservationCoverage {
  observedSource: "observed-cache" | "host";
  /** True only while every observed event of this session was persisted. */
  complete: boolean;
  firstSeq?: number;
  lastSeq?: number;
  /** Number of observed events persisted for this session. */
  observedCount: number;
  gaps: Array<{
    reason: "observation_degraded" | "corruption" | "overflow" | "gap_detected" | "write_failure";
    detail?: string;
  }>;
  note: string;
}

export interface DshHistoryReadOptions {
  beforeSeq?: number;
  maxMessages?: number;
}

export interface DshObservedHistory extends DshSessionHistory {
  coverage?: DshObservationCoverage;
}

/**
 * One bridge-owned session as reported by a backend without a session catalog.
 * Every field states what the bridge observed; unknown state is `null`, never
 * a fabricated idle/blanks/timestamp.
 */
export interface DshBridgeOwnedSession {
  taskId: string;
  sessionId: string;
  cwd: string;
  title: string | null;
  titleSource: "bridge" | "dsh-native" | null;
  runtimeState: "absent" | "starting" | "ready" | "closing" | "crashed" | "closed";
  running: boolean | null;
  phase: "unknown" | "running" | "idle" | "awaiting_input";
  blank: boolean | null;
  observation: DshObservationCoverage;
  cleanShutdown: boolean;
  updatedAt?: string;
}

export interface DshApi {
  /** Backend identity; absent on test doubles built before the SDK backend existed. */
  backend?: BackendId;
  /** Unified capability declaration; upper layers branch on this, not on protocol names. */
  capabilities?: BackendCapabilities;
  protocolCapabilities?: { queueSnapshot: boolean; forceFreshHistoryCut?: boolean; timedQuestions?: boolean; subagentModeDiscovery?: boolean };
  trackSessions?(sessionIds: readonly string[]): void;
  /**
   * Release backend resources. Async backends (the SDK runtime manager) must be
   * awaited by the shutdown path; repeated calls stay idempotent.
   */
  close?(): void | Promise<void>;
  hostDescribe(signal?: AbortSignal): Promise<DshUnaryResult<DshHostDescription>>;
  /** Activated route for one session without requiring a model catalog. */
  routeInfo?(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshBackendRoute>>;
  /** Record a bridge-local display title when the backend has no native rename. */
  recordTaskTitle?(taskId: string, title: string): Promise<void>;
  /** Bridge-owned discovery for backends without a session catalog. */
  bridgeCatalog?(): Promise<DshBridgeOwnedSession[]>;
  /** Read history from this backend's own source (observed cache for the SDK backend). */
  readHistory?(
    taskId: string,
    sessionId: string,
    options?: DshHistoryReadOptions,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshObservedHistory>>;
  sessionList(signal?: AbortSignal): Promise<DshUnaryResult<z.infer<typeof dshSessionListValueSchema>>>;

  sessionCreate(
    payload: { cwd: string; agentPreset?: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionCreateValue>>;
  sessionModels(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionModels>>;
  sessionSelectModel(
    payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionSelectModelValue>>;
  sessionPrompt(
    payload: {
      sessionId: string;
      mode: "queue" | "steer";
      content: Array<{ type: "text"; text: string }>;
      clientTimeZone?: string;
    },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionPromptValue>>;
  sessionRename(
    sessionId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<z.infer<typeof dshSessionRenameValueSchema>>>;
  sessionHistory(
    sessionId: string,
    options?: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>>;
  sessionCancel(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<z.infer<typeof dshSessionCancelValueSchema>>>;
  sessionUpdateQueue(
    sessionId: string,
    itemId: string,
    action: { kind: "remove" },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<z.infer<typeof dshSessionUpdateQueueValueSchema>>>;
  subagentList(parentSessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSubagentListValue>>;
  subagentHistory(
    address: DshSubagentAddress,
    options?: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>>;
  respond(message: DshClientResponse, signal?: AbortSignal): Promise<DshRpcReceipt>;
  openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>>;
}
