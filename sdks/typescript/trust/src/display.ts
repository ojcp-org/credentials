/**
 * What an agent shows a candidate about the recipient (RFC 0010 §5.5): the
 * attested legal name and jurisdiction, never a self-asserted name; the host
 * in A-label form; for a hosted origin, both parties, with the employer
 * confirmed only by an independent `hosted-employer` attestation (§3.5).
 */
import type { DerivedTier } from "./derive.ts";

export interface PostingEmployer {
  /** The posting's `employer.ojcp_employer_id`. */
  ojcp_employer_id?: string;
  /** The employer's organization identifier, when known. */
  did?: string;
  /** The posting's self-asserted employer name, shown only as unconfirmed. */
  name?: string;
}

export interface RecipientDescription {
  /** A-label host of the receiving origin. */
  host: string;
  /** e.g. "ExampleATS Inc. (verified, US-DE)". */
  recipient: string;
  /** Present when a posting employer was given. */
  employer?: { name: string; confirmed: boolean };
  /** The full sentence to show. */
  text: string;
}

/** The posting's employer, confirmed only through an accepted `hosted-employer` attestation. */
export function confirmEmployer(
  derived: DerivedTier,
  employer: PostingEmployer,
): { name: string; confirmed: boolean } | undefined {
  const match = derived.hostedEmployers.find(
    (h) =>
      (employer.ojcp_employer_id && h.employer_id === employer.ojcp_employer_id) ||
      (employer.did && h.employer === employer.did),
  );
  if (match) return { name: match.legal_name, confirmed: true };
  return employer.name ? { name: employer.name, confirmed: false } : undefined;
}

export function describeRecipient(
  derived: DerivedTier,
  employer?: PostingEmployer,
): RecipientDescription {
  // WHATWG URL serializes hosts in A-label (punycode) form.
  const host = new URL(derived.origin).hostname;
  const weaker = derived.weakerPolicy ? ", single-attester policy" : "";
  const recipient = derived.entity
    ? `${derived.entity.legal_name} (${derived.tier}, ${derived.entity.jurisdiction}${weaker})`
    : `${host} (${derived.tier})`;
  const e = employer ? confirmEmployer(derived, employer) : undefined;
  const onBehalf = e
    ? `, on behalf of ${e.name}, ${e.confirmed ? "confirmed" : "not confirmed"}`
    : "";
  return {
    host,
    recipient,
    ...(e ? { employer: e } : {}),
    text: `Your application goes to ${recipient} at ${host}${onBehalf}.`,
  };
}
