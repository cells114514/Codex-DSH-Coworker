/**
 * Structured errors of the SDK backend.
 *
 * Every code documented in the delivery contract has exactly one class here so
 * the MCP layer maps them without string matching, and so an unsupported
 * capability can never be reported as an empty list or a silent success.
 */
export type SdkBackendErrorCode =
  | "unsupported_capability"
  | "sdk_initialize_failed"
  | "runtime_unavailable"
  | "runtime_capacity_exceeded"
  | "runtime_owner_conflict"
  | "runtime_identity_mismatch"
  | "backend_mismatch"
  | "observation_gap"
  | "prompt_outcome_unknown"
  | "prompt_in_flight"
  | "session_resume_failed"
  | "sdk_unavailable";

export interface SdkBackendErrorDetails {
  /** Capability name the caller must consult before retrying. */
  capability?: string;
  taskId?: string;
  rootSessionId?: string;
  retryable: boolean;
  suggestion: string;
  [key: string]: unknown;
}

export class SdkBackendError extends Error {
  readonly backend = "sdk" as const;

  constructor(
    readonly code: SdkBackendErrorCode,
    message: string,
    readonly details: SdkBackendErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SdkBackendError";
  }

  get retryable(): boolean {
    return this.details.retryable;
  }

  toBody(): Record<string, unknown> {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      backend: this.backend,
      ...(this.details.taskId === undefined ? {} : { taskId: this.details.taskId }),
      ...(this.details.capability === undefined ? {} : { capability: this.details.capability }),
      retryable: this.details.retryable,
      suggestion: this.details.suggestion,
      details: this.details,
    };
  }
}

/** Build one `unsupported_capability` error naming the missing semantic. */
export function unsupportedCapability(
  capability: string,
  explanation: string,
  extra: { taskId?: string; rootSessionId?: string } = {},
): SdkBackendError {
  return new SdkBackendError(
    "unsupported_capability",
    `${explanation} (capability: ${capability})`,
    {
      capability,
      retryable: false,
      suggestion:
        "Use a capability this backend declares in dsh_host_status.capabilities, or select the gateway backend for Host-backed features.",
      ...extra,
    },
  );
}
