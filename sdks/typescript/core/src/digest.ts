import canonicalize from "canonicalize";
import { base64, base64url, utf8 } from "./encoding.ts";

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** RFC 8785 JSON Canonicalization Scheme. */
export function jcs(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new TypeError("value cannot be canonicalized");
  return text;
}

/**
 * The OJCP digest form used by action statements, `candidate_data_digest` and
 * `binding_actions_digest`: `sha256:` + base64url(SHA-256(JCS(value))), no padding.
 */
export async function ojcpDigest(value: unknown): Promise<string> {
  return `sha256:${base64url(await sha256(jcs(value)))}`;
}

/** The OJCP digest of raw bytes (RFC 0009 document digests). */
export async function ojcpBytesDigest(bytes: Uint8Array): Promise<string> {
  return `sha256:${base64url(await sha256(bytes))}`;
}

/** W3C Subresource Integrity value (sha256), used for `vct#integrity`. */
export async function sri(bytes: Uint8Array | string): Promise<string> {
  return `sha256-${base64(await sha256(bytes))}`;
}
