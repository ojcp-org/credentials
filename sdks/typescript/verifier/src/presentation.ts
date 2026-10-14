/**
 * Validation of a wallet presentation of an RFC 0014 hiring credential in
 * `dc+sd-jwt` format (RFC 0013 §6.2 steps 2–5). Step 1 (decrypting the response
 * and matching it to a live request from the bound session) and step 6 (the
 * contact binding of §3) belong to the provider's verification page; this
 * module supplies the contact comparison for step 6.
 */
import {
  type Basis,
  type ClaimsPathQuery,
  type HiringCredential,
  type HiringType,
  isOjcpError,
  isRecord,
  type JWK,
  matchesClaimsPath,
  normalizeCandidate,
  OjcpError,
  ojcpBytesDigest,
  parseHiringCredential,
  parseSdJwt,
  reconstructClaims,
  sha256,
  timingSafeEqual,
  utf8,
  verifyKeyBinding,
} from "@ojcp/credentials-core";
import { type PinnedKey, verifyWithPins } from "./issuers.ts";
import type { StatusSource } from "./status.ts";

export type IssuerProfile = "baseline" | "high_assurance";

/** One entry of the provider's issuer policy (RFC 0013 §6.1). */
export interface AcceptedHiringIssuer {
  iss: string;
  /** Pinned keys with their RFC 0014 §5.1 signing windows. */
  keys: readonly PinnedKey[];
  /** The profile the issuer declares in `ojcp_issuer.profile`. */
  profile: IssuerProfile;
  types: readonly HiringType[];
  basis: readonly Basis[];
}

export interface HiringPresentationPolicy {
  issuers: readonly AcceptedHiringIssuer[];
  /** Profiles accepted for each type. */
  profiles: Partial<Record<HiringType, readonly IssuerProfile[]>>;
  status: StatusSource;
  now?: () => number;
}

export interface HiringPresentationRequest {
  type: HiringType;
  /** The OpenID4VP request nonce. */
  nonce: string;
  /** The `client_id`, or `origin:<origin>` over the Digital Credentials API. */
  audience: string;
  /** DCQL claim paths requested; everything else is dropped unread. */
  claims: readonly ClaimsPathQuery[];
}

export interface ValidatedHiringPresentation {
  credential: HiringCredential;
  issuer: { iss: string; profile: IssuerProfile };
  /** What the provider keeps instead of the raw presentation (RFC 0013 §8). */
  presentationSha256: string;
}

const SKEW = 60;
const KB_WINDOW = 300;
const TWO_YEARS = 730 * 86_400;
const STATUS_MAX_AGE = 12 * 3600;

/** Keeps only the requested paths of the disclosed claims. */
function keepRequested(
  value: unknown,
  queries: readonly ClaimsPathQuery[],
  path: Array<string | number> = [],
): unknown {
  if (queries.some((q) => matchesClaimsPath(q, path))) return value;
  const relevant = queries.filter((q) =>
    path.every((seg, i) => q[i] === seg || (q[i] === null && typeof seg === "number")),
  );
  if (relevant.length === 0) return undefined;
  if (Array.isArray(value)) {
    const out = value
      .map((v, i) => keepRequested(v, relevant, [...path, i]))
      .filter((v) => v !== undefined);
    return out.length > 0 ? out : undefined;
  }
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const kept = keepRequested(v, relevant, [...path, k]);
    if (kept !== undefined) out[k] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function verifyHiringPresentation(
  policy: HiringPresentationPolicy,
  presentation: string,
  request: HiringPresentationRequest,
): Promise<ValidatedHiringPresentation> {
  const now = policy.now?.() ?? Math.floor(Date.now() / 1000);
  const parsed = await parseSdJwt(presentation);
  if (parsed.header.typ !== "dc+sd-jwt") throw new OjcpError("malformed", "typ must be dc+sd-jwt");

  // 2. Issuer key, signing window, accepted issuer/type/profile/basis.
  const issuer = policy.issuers.find((i) => i.iss === parsed.payload.iss);
  if (!issuer) throw new OjcpError("not_admitted", "issuer not accepted");
  const { key } = await verifyWithPins(parsed.jwt, issuer.keys);
  const { claims } = reconstructClaims(parsed.payload, parsed.disclosures);
  const credential = parseHiringCredential(claims);
  if (credential.type !== request.type || !issuer.types.includes(credential.type))
    throw new OjcpError("not_admitted", "type not accepted from this issuer");
  if (!issuer.basis.includes(credential.basis))
    throw new OjcpError("not_admitted", "basis not accepted from this issuer");
  if (!(policy.profiles[credential.type] ?? []).includes(issuer.profile))
    throw new OjcpError("not_admitted", "issuer profile not accepted for this type");
  if (key.signUntil !== undefined) {
    const lastSigningDay = Math.floor(key.signUntil / 86_400) * 86_400;
    if (credential.iat > lastSigningDay)
      throw new OjcpError("invalid_claims", "issued after the key's signing window");
    if (now > key.signUntil + TWO_YEARS)
      throw new OjcpError("expired", "beyond the key's signing window plus lifetime");
  }

  // 3. Time.
  const nbf = parsed.payload.nbf;
  if (typeof nbf === "number" && now < nbf - SKEW)
    throw new OjcpError("not_yet_valid", "credential not yet valid");
  if (now >= credential.exp + SKEW) throw new OjcpError("expired", "credential expired");

  // 4. Holder binding and status.
  const cnf = isRecord(claims.cnf) ? (claims.cnf.jwk as JWK) : undefined;
  if (!cnf) throw new OjcpError("invalid_claims", "cnf.jwk missing");
  const kb = await verifyKeyBinding(parsed, cnf);
  if (kb.payload.nonce !== request.nonce)
    throw new OjcpError("replayed", "KB-JWT nonce does not match the request");
  if (kb.payload.aud !== request.audience)
    throw new OjcpError("binding_mismatch", "KB-JWT aud does not match");
  if (Math.abs(now - kb.payload.iat) > KB_WINDOW)
    throw new OjcpError("expired", "KB-JWT iat outside 5 minutes");
  await policy.status.requireValid({
    ...credential.status,
    keys: issuer.keys,
    maxAge: STATUS_MAX_AGE,
  });

  // 5. Drop what wasn't requested, unread.
  const record = (keepRequested(credential.record, request.claims) ?? {}) as Record<
    string,
    unknown
  >;
  return {
    credential: { ...credential, record },
    issuer: { iss: issuer.iss, profile: issuer.profile },
    presentationSha256: await ojcpBytesDigest(utf8(presentation)),
  };
}

/** Same as `verifyHiringPresentation`, returning `null` instead of throwing (failures are logged, not surfaced). */
export async function tryVerifyHiringPresentation(
  policy: HiringPresentationPolicy,
  presentation: string,
  request: HiringPresentationRequest,
): Promise<ValidatedHiringPresentation | { error: OjcpError }> {
  try {
    return await verifyHiringPresentation(policy, presentation, request);
  } catch (error) {
    if (isOjcpError(error)) return { error };
    throw error;
  }
}

/**
 * RFC 0013 §3 item 4: compares the contact a candidate types on the wallet
 * device with the application's verified contact, after RFC 0008 §2.3
 * normalization, by hash.
 */
export async function contactMatches(entered: string, verified: string): Promise<boolean> {
  const norm = (value: string) => {
    const element = value.includes("@") ? { email: value } : { phone: value };
    return JSON.stringify(normalizeCandidate(element));
  };
  return timingSafeEqual(await sha256(norm(entered)), await sha256(norm(verified)));
}
