import { base64url, base64urlJson, fromBase64url, parseBase64urlJson, utf8 } from "./encoding.ts";
import { OjcpError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { algForJwk, type JWK, type Signer, verifyRaw } from "./keys.ts";

export type JwtHeader = Record<string, unknown> & { alg?: string; typ?: string; kid?: string };
export type JwtPayload = Record<string, unknown>;

export interface DecodedJws {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Uint8Array;
}

/** Signs a compact JWS. `alg` comes from the signer and overrides any value in `header`. */
export async function signJws(
  header: JwtHeader,
  payload: JwtPayload,
  signer: Signer,
): Promise<string> {
  const signingInput = `${base64urlJson({ ...header, alg: signer.alg })}.${base64urlJson(payload)}`;
  return `${signingInput}.${base64url(await signer.sign(utf8(signingInput)))}`;
}

export function decodeJws(token: string): DecodedJws {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OjcpError("malformed", "not a compact JWS");
  const [h, p, s] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = parseBase64urlJson(h);
    payload = parseBase64urlJson(p);
  } catch {
    throw new OjcpError("malformed", "JWS header or payload is not base64url JSON");
  }
  if (!isRecord(header) || !isRecord(payload))
    throw new OjcpError("malformed", "JWS header and payload must be objects");
  return { header, payload, signingInput: `${h}.${p}`, signature: fromBase64url(s) };
}

/**
 * Verifies a compact JWS against a public key. The algorithm is derived from the
 * key, never trusted from the header; a header `alg` that conflicts is rejected.
 */
export async function verifyJws(token: string, publicJwk: JWK): Promise<DecodedJws> {
  const decoded = decodeJws(token);
  const alg = algForJwk(publicJwk);
  if (decoded.header.alg !== alg)
    throw new OjcpError(
      "invalid_signature",
      `JWS alg ${String(decoded.header.alg)} does not match key`,
    );
  if (!(await verifyRaw(publicJwk, utf8(decoded.signingInput), decoded.signature)))
    throw new OjcpError("invalid_signature", "JWS signature does not verify");
  return decoded;
}
