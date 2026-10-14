import type { OjcpErrorKind } from "@ojcp/credentials-core";

export const USER_MANDATE_REQUIRED = "user_mandate_required";

/** The only `details.reason` values RFC 0008 §8 allows: both depend only on published policy. */
export type MandateRejectionReason = "action_mandate_required" | "exceeds_provider_policy";

export interface ToolError {
  error_code: typeof USER_MANDATE_REQUIRED;
  message: string;
  details?: { reason: MandateRejectionReason };
}

/**
 * A refused mandate. `kind` and `message` are for the provider's own logs and
 * tests; `toToolError()` is what goes on the wire, and never says which
 * credential check failed.
 */
export class MandateRejected extends Error {
  readonly kind: OjcpErrorKind | "missing";
  readonly reason?: MandateRejectionReason;

  constructor(kind: OjcpErrorKind | "missing", message: string, reason?: MandateRejectionReason) {
    super(message);
    this.name = "MandateRejected";
    this.kind = kind;
    if (reason) this.reason = reason;
  }

  toToolError(): ToolError {
    return {
      error_code: USER_MANDATE_REQUIRED,
      message: "A valid user mandate is required for this action.",
      ...(this.reason ? { details: { reason: this.reason } } : {}),
    };
  }
}
