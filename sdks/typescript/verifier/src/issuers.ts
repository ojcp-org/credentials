/**
 * Issuer admission and key pinning. Keys come only from the provider's own
 * policy (pins, lists, or metadata matched against pins), never from the
 * credential and never from a DID document (RFC 0010 §2.1, RFC 0013 §6.1).
 */
import {
  algForJwk,
  type DecodedJws,
  decodeJws,
  type JWK,
  OjcpError,
  thumbprint,
  verifyJws,
} from "@ojcp/credentials-core";

export interface PinnedKey {
  jwk: JWK;
  /** RFC 0014 §5.1 signing window; absent for keys that carry no window (mandate issuers). */
  signUntil?: number;
}

/** Finds the pinned key that verifies a JWS: by `kid` (key id or thumbprint) when present, else by trial. */
export async function verifyWithPins(
  token: string,
  keys: readonly PinnedKey[],
): Promise<{ decoded: DecodedJws; key: PinnedKey }> {
  const { header } = decodeJws(token);
  const candidates: PinnedKey[] = [];
  for (const key of keys) {
    if (
      typeof header.kid === "string" &&
      header.kid !== key.jwk.kid &&
      header.kid !== (await thumbprint(key.jwk))
    )
      continue;
    if (header.alg !== algForJwk(key.jwk)) continue;
    candidates.push(key);
  }
  for (const key of candidates) {
    try {
      return { decoded: await verifyJws(token, key.jwk), key };
    } catch {
      // try the next pinned key
    }
  }
  throw new OjcpError("unknown_key", "no pinned key verifies this signature");
}
