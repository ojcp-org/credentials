/**
 * Internal failure classes. These are not OJCP wire error codes: a verifier maps
 * them onto the wire codes the spec defines (for mandates, always
 * `user_mandate_required`, so a response never reveals which check failed).
 */
export type OjcpErrorKind =
  | "malformed"
  | "invalid_signature"
  | "unknown_key"
  | "expired"
  | "not_yet_valid"
  | "invalid_claims"
  | "disclosure_rule"
  | "not_covered"
  | "binding_mismatch"
  | "replayed"
  | "revoked"
  | "status_unavailable"
  | "not_admitted"
  | "policy"
  | "limit_reached"
  | "prohibited";

export class OjcpError extends Error {
  readonly kind: OjcpErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: OjcpErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "OjcpError";
    this.kind = kind;
    if (details) this.details = details;
  }
}

export function isOjcpError(error: unknown, kind?: OjcpErrorKind): error is OjcpError {
  return error instanceof OjcpError && (kind === undefined || error.kind === kind);
}
