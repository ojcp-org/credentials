/**
 * Attestation status (RFC 0010 §3.4). A Status List Token counts only if it is
 * on the attester's origin, signed by a key pinned for that attester, carries
 * `exp` and `ttl`, and is younger than the earliest of `exp`, `iat` + `ttl`
 * and 24 hours. Anything unresolved is absent: it never lowers or raises a tier.
 */
import {
  decodeJws,
  readStatusListToken,
  Status,
  type StatusListTokenContents,
  thumbprint,
  verifyJws,
} from "@ojcp/credentials-core";
import type { Attestation } from "./attestation.ts";
import type { BudgetedFetcher } from "./fetcher.ts";
import { validateX5c } from "./x509.ts";

const MAX_CACHE = 86_400;

export type StatusOutcome =
  | { state: "valid"; until: number }
  | { state: "invalid" }
  | { state: "absent" };

async function signedByAttester(
  token: string,
  attestation: Attestation,
  now: number,
): Promise<boolean> {
  try {
    const { header } = decodeJws(token);
    if (Array.isArray(header.x5c)) {
      const chain = await validateX5c(
        header.x5c.map(String),
        attestation.iss,
        attestation.grant.x509,
        now,
      );
      if (!chain) return false;
      await verifyJws(token, chain.jwk);
      return true;
    }
    for (const jwk of attestation.grant.jwks) {
      if (
        typeof header.kid === "string" &&
        header.kid !== jwk.kid &&
        header.kid !== (await thumbprint(jwk))
      )
        continue;
      try {
        await verifyJws(token, jwk);
        return true;
      } catch {
        // next pinned key
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolves one attestation's status from stapled tokens first, then by fetching (step 4 of §5.2). */
export async function attestationStatus(
  attestation: Attestation,
  options: { stapled: readonly string[]; fetcher: BudgetedFetcher; now: number },
): Promise<StatusOutcome> {
  const { uri, idx } = attestation.status;
  if (new URL(uri).origin !== attestation.iss) return { state: "absent" };
  const candidates = options.stapled.filter((t) => {
    try {
      return decodeJws(t).payload.sub === uri;
    } catch {
      return false;
    }
  });
  const tryToken = async (token: string): Promise<StatusOutcome | undefined> => {
    if (!(await signedByAttester(token, attestation, options.now))) return undefined;
    let read: StatusListTokenContents;
    try {
      read = readStatusListToken(token);
    } catch {
      return undefined;
    }
    const { payload, list } = read;
    if (payload.sub !== uri || payload.exp === undefined || payload.ttl === undefined)
      return undefined;
    const until = Math.min(payload.exp, payload.iat + payload.ttl, payload.iat + MAX_CACHE);
    if (options.now >= until) return undefined;
    try {
      return list.get(idx) === Status.VALID ? { state: "valid", until } : { state: "invalid" };
    } catch {
      return undefined;
    }
  };
  for (const token of candidates) {
    const outcome = await tryToken(token);
    if (outcome) return outcome;
  }
  const fetched = await options.fetcher.text(uri, "application/statuslist+jwt");
  if (fetched) {
    const outcome = await tryToken(fetched.trim());
    if (outcome) return outcome;
  }
  return { state: "absent" };
}
