/**
 * Attestations (RFC 0010 §3): SD-JWT VCs about one organization identifier,
 * bound to its identity key, issued by attesters that trust lists pin.
 */
import {
  decodeJws,
  issueSdJwt,
  type JWK,
  ojcpBytesDigest,
  type ParsedSdJwt,
  parseSdJwt,
  reconstructClaims,
  type Signer,
  thumbprint,
  utf8,
  verifyJws,
} from "@ojcp/credentials-core";
import { z } from "zod";
import type { AttesterGrant, TrustLists } from "./trust-list.ts";
import { validateX5c } from "./x509.ts";

const VCT = "https://spec.ojcp.dev/vct";
const DAY = 86_400;

export const ATTESTATION_TYPES = {
  domain_control: {
    vct: `${VCT}/domain-control/v1`,
    maxLifetime: 90 * DAY,
    required: ["method", "checked_at"],
  },
  legal_entity: {
    vct: `${VCT}/legal-entity/v1`,
    maxLifetime: 180 * DAY,
    required: ["legal_name", "jurisdiction", "checked_at"],
  },
  business_registration: {
    vct: `${VCT}/business-registration/v1`,
    maxLifetime: 180 * DAY,
    required: [
      "legal_name",
      "jurisdiction",
      "registry",
      "registration_number",
      "registration_status",
      "checked_at",
    ],
  },
  hosted_employer: {
    vct: `${VCT}/hosted-employer/v1`,
    maxLifetime: 180 * DAY,
    required: ["employer_legal_name", "employer_jurisdiction", "checked_at"],
  },
  conformance: {
    vct: `${VCT}/conformance/v1`,
    maxLifetime: 365 * DAY,
    required: ["suite_version", "ojcp_version"],
  },
  security_review: {
    vct: `${VCT}/security-review/v1`,
    maxLifetime: 365 * DAY,
    required: ["scope"],
  },
  listing_tenure: {
    vct: `${VCT}/listing-tenure/v1`,
    maxLifetime: 365 * DAY,
    required: ["listed_since", "index"],
  },
} as const;
export type AttestationType = keyof typeof ATTESTATION_TYPES;

export function attestationType(vct: string): AttestationType | undefined {
  return (Object.keys(ATTESTATION_TYPES) as AttestationType[]).find(
    (t) => ATTESTATION_TYPES[t].vct === vct,
  );
}

const Origin = z
  .url({ protocol: /^https$/ })
  .refine((u) => new URL(u).origin === u, "an origin with no path");

const AttestationClaims = z.looseObject({
  iss: Origin,
  sub: z.string().startsWith("did:web:"),
  vct: z.string(),
  cnf: z.looseObject({ jkt: z.string() }),
  iat: z.number().int(),
  exp: z.number().int(),
  status: z.looseObject({
    status_list: z.strictObject({ idx: z.number().int().nonnegative(), uri: z.url() }),
  }),
  relationship: z.enum(["none", "operator", "host", "customer", "affiliate"]),
});

export interface Attestation {
  type: AttestationType;
  iss: string;
  sub: string;
  jkt: string;
  iat: number;
  exp: number;
  status: { idx: number; uri: string };
  relationship: string;
  claims: Record<string, unknown>;
  /** Digest of the compact form: the key for acceptance records (§4.1 distrust_after). */
  digest: string;
  /** The grant and key that verified it. */
  grant: AttesterGrant;
  verifiedBy: { thumbprint?: string; spkiSha256?: string[] };
}

export interface AttestationInput {
  iss: string;
  sub: string;
  type: AttestationType;
  identityKeyThumbprint: string;
  iat: number;
  exp: number;
  status: { idx: number; uri: string };
  relationship: "none" | "operator" | "host" | "customer" | "affiliate";
  claims: Record<string, unknown>;
}

/** Issues an attestation (attester side). Published, so no key binding is presented. */
export async function issueAttestation(
  signer: Signer,
  input: AttestationInput,
  header: Record<string, unknown> = {},
): Promise<string> {
  const t = ATTESTATION_TYPES[input.type];
  for (const claim of t.required)
    if (input.claims[claim] === undefined)
      throw new TypeError(`${claim} is required for ${input.type}`);
  if (input.exp - input.iat > t.maxLifetime)
    throw new RangeError(`lifetime above ${input.type}'s maximum`);
  const { compact } = await issueSdJwt({
    signer,
    header: { kid: await thumbprint(signer.publicJwk), ...header },
    claims: {
      iss: input.iss,
      sub: input.sub,
      vct: t.vct,
      cnf: { jkt: input.identityKeyThumbprint },
      iat: input.iat,
      exp: input.exp,
      status: { status_list: input.status },
      relationship: input.relationship,
      ...input.claims,
    },
  });
  return compact;
}

/** The subject binding of §3.1 and §3.5 for one receiving origin. */
export interface SubjectBinding {
  /** Organization identifier of the receiving origin. */
  subject: string;
  /** Thumbprint of its current identity key, and of predecessors linked by RFC 0011. */
  keys: readonly string[];
  /** Host of the receiving origin, for the tenant rule. */
  host: string;
}

function bindsSubject(sub: string, jkt: string, binding: SubjectBinding): boolean {
  if (!binding.keys.includes(jkt)) return false;
  if (sub === binding.subject) return true;
  // §3.5: a host's attestation counts for a tenant under its namespace that carries the same identity key.
  const parentHost = sub.slice("did:web:".length);
  return !parentHost.includes("%3A") && binding.host.endsWith(`.${parentHost}`);
}

export type Rejection =
  | "malformed"
  | "unknown_type"
  | "untrusted_issuer"
  | "invalid_signature"
  | "lifetime"
  | "expired"
  | "wrong_subject"
  | "distrusted"
  | "missing_claims";

/**
 * Step 3 of §5.2: everything that can be checked without the network. Returns
 * the attestation, or why it doesn't count. `relationship` other than `none`
 * is returned as valid; it simply never counts towards a tier (§4.3).
 */
export async function checkAttestation(
  compact: string,
  options: {
    lists: TrustLists;
    binding: SubjectBinding;
    now: number;
    firstAccepted: (digest: string) => Promise<number | undefined>;
  },
): Promise<Attestation | Rejection> {
  let parsed: ParsedSdJwt;
  try {
    parsed = await parseSdJwt(compact);
  } catch {
    return "malformed";
  }
  if (parsed.header.typ !== "dc+sd-jwt" || parsed.kbJwt) return "malformed";
  let claims: Record<string, unknown>;
  try {
    claims = reconstructClaims(parsed.payload, parsed.disclosures).claims;
  } catch {
    return "malformed";
  }
  const base = AttestationClaims.safeParse(claims);
  if (!base.success) return "malformed";
  const c = base.data;
  const type = attestationType(c.vct);
  if (!type) return "unknown_type";
  const spec = ATTESTATION_TYPES[type];
  if (spec.required.some((k) => claims[k] === undefined)) return "missing_claims";
  if (c.exp - c.iat > spec.maxLifetime) return "lifetime";
  if (options.now >= c.exp + 60 || c.iat > options.now + 60) return "expired";
  if (!bindsSubject(c.sub, c.cnf.jkt, options.binding)) return "wrong_subject";
  if (new URL(c.status.status_list.uri).origin !== c.iss) return "malformed";

  // Issuer key: only keys a valid list pins for this attester and type (§3.3).
  const grants = options.lists.grantsFor(c.iss, c.vct, options.now);
  if (grants.length === 0) return "untrusted_issuer";
  const header = decodeJws(parsed.jwt).header;
  let verified: { grant: AttesterGrant; thumbprint?: string; spkiSha256?: string[] } | undefined;
  for (const grant of grants) {
    if (Array.isArray(header.x5c)) {
      const chain = await validateX5c(header.x5c.map(String), c.iss, grant.x509, options.now);
      if (chain && (await verifies(parsed.jwt, chain.jwk)))
        verified = { grant, spkiSha256: chain.spkiSha256 };
    } else {
      for (const jwk of grant.jwks) {
        if (
          typeof header.kid === "string" &&
          header.kid !== jwk.kid &&
          header.kid !== (await thumbprint(jwk))
        )
          continue;
        if (await verifies(parsed.jwt, jwk))
          verified = { grant, thumbprint: await thumbprint(jwk) };
      }
    }
    if (verified) break;
  }
  if (!verified) return "invalid_signature";

  const digest = await ojcpBytesDigest(utf8(compact));
  const distrust = options.lists.distrustFor(c.iss, verified.thumbprint, verified.spkiSha256);
  if (distrust) {
    if (distrust.after === undefined) return "distrusted";
    // Only the agent's own record of accepting it earlier counts; `iat` is never evidence.
    const accepted = await options.firstAccepted(digest);
    if (accepted === undefined || accepted >= distrust.after) return "distrusted";
  }
  return {
    type,
    iss: c.iss,
    sub: c.sub,
    jkt: c.cnf.jkt,
    iat: c.iat,
    exp: c.exp,
    status: c.status.status_list,
    relationship: c.relationship,
    claims,
    digest,
    grant: verified.grant,
    verifiedBy: {
      ...(verified.thumbprint ? { thumbprint: verified.thumbprint } : {}),
      ...(verified.spkiSha256 ? { spkiSha256: verified.spkiSha256 } : {}),
    },
  };
}

async function verifies(jwt: string, jwk: JWK): Promise<boolean> {
  try {
    await verifyJws(jwt, jwk);
    return true;
  } catch {
    return false;
  }
}

/** The stapled attestation document (§3.6). */
export const Staple = z.looseObject({
  attestations: z.array(z.string()).max(32),
  status_tokens: z.array(z.string()).default([]),
  issuer_jwks: z
    .record(z.string(), z.looseObject({ keys: z.array(z.record(z.string(), z.unknown())) }))
    .default({}),
});
export type Staple = z.infer<typeof Staple>;

export function isIdentityType(type: AttestationType): boolean {
  return type === "legal_entity" || type === "business_registration";
}
