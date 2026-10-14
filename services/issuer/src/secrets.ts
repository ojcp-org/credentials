import {
  base64url,
  randomBytes,
  randomInt,
  sha256,
  timingSafeEqual,
  utf8,
} from "@ojcp/credentials-core";

/** An unguessable token (codes, access tokens, ids). */
export function token(): string {
  return base64url(randomBytes(32));
}

/** Stored form of a token: only its hash is kept. */
export async function hashToken(value: string): Promise<string> {
  return base64url(await sha256(value));
}

/** A numeric one-time code. */
export function numericCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomInt(10));
  return out;
}

/** RFC 7636 S256 check. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return timingSafeEqual(utf8(base64url(await sha256(verifier))), utf8(challenge));
}
