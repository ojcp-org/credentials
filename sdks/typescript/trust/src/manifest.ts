/**
 * Manifest signatures (spec *Manifest Signing* and *Validation Procedure*),
 * and RFC 0010 §2.2's extra condition for derivation: the signing key carries
 * a valid `ojcp_cert` for `manifest` under the identity key.
 */
import {
  base64url,
  fromBase64url,
  isRecord,
  type JWK,
  jcs,
  type Signer,
  utf8,
} from "@ojcp/credentials-core";
import { z } from "zod";
import {
  type IdentityKey,
  identityKey,
  type OjcpKeySet,
  organizationId,
  verifyKeyCertificate,
} from "./identity.ts";

export type ManifestError =
  | "unsigned"
  | "domain_mismatch"
  | "key_resolution_failed"
  | "algorithm_mismatch"
  | "invalid_signature"
  | "expired_signature";

const ManifestSignature = z.looseObject({
  alg: z.enum(["ES256", "ES384", "RS256", "RS384"]),
  kid: z.string(),
  iss: z.string().optional(),
  signed_at: z.string(),
  expires_at: z.string(),
  value: z.string(),
});

export type ManifestCheck =
  | { ok: true; key: JWK; expiresAt: number }
  | { ok: false; error: ManifestError };

const PARAMS = {
  ES256: {
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
  ES384: {
    import: { name: "ECDSA", namedCurve: "P-384" },
    verify: { name: "ECDSA", hash: "SHA-384" },
  },
  RS256: {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  RS384: {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
} as const;

function signedBytes(manifest: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  const { signature: _, ...content } = manifest;
  return utf8(jcs(content));
}

/** Spec *Validation Procedure*, steps 1–6, against an already fetched key set. */
export async function verifyManifestSignature(
  manifest: unknown,
  origin: string,
  keys: OjcpKeySet,
  now: number,
): Promise<ManifestCheck> {
  if (!isRecord(manifest)) return { ok: false, error: "invalid_signature" };
  const sig = ManifestSignature.safeParse(manifest.signature);
  if (manifest.signature === undefined) return { ok: false, error: "unsigned" };
  if (!sig.success) return { ok: false, error: "invalid_signature" };
  const s = sig.data;
  const url = new URL(origin);
  if (url.protocol !== "https:") return { ok: false, error: "domain_mismatch" };
  if (s.iss !== undefined && s.iss !== url.host && s.iss !== url.origin)
    return { ok: false, error: "domain_mismatch" };
  // RFC 0010 §2.1: a declared provider.did must equal the derived one.
  const provider = manifest.provider;
  if (isRecord(provider) && provider.did !== undefined && provider.did !== organizationId(origin))
    return { ok: false, error: "domain_mismatch" };
  const jwk = keys.keys.find((k) => k.kid === s.kid);
  if (!jwk) return { ok: false, error: "key_resolution_failed" };
  if (jwk.alg !== s.alg) return { ok: false, error: "algorithm_mismatch" };
  const params = PARAMS[s.alg];
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, params.import, false, [
      "verify",
    ]);
    valid = await crypto.subtle.verify(
      params.verify,
      key,
      fromBase64url(s.value),
      signedBytes(manifest),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "invalid_signature" };
  const expiresAt = Math.floor(Date.parse(s.expires_at) / 1000);
  if (!Number.isFinite(expiresAt) || expiresAt + 60 <= now)
    return { ok: false, error: "expired_signature" };
  return { ok: true, key: jwk as JWK, expiresAt };
}

export interface CertifiedManifest {
  identity: IdentityKey;
  subject: string;
  /** Earliest of the signature's and the key certificate's expiry. */
  validUntil: number;
}

/**
 * RFC 0010 §2.2: a manifest counts as signed for derivation only if it
 * validates and its key carries an unexpired `ojcp_cert` for `manifest` under
 * the current identity key.
 */
export async function certifiedManifest(
  manifest: unknown,
  origin: string,
  keys: OjcpKeySet,
  now: number,
): Promise<CertifiedManifest | undefined> {
  const subject = organizationId(origin);
  if (!subject) return undefined;
  const check = await verifyManifestSignature(manifest, origin, keys, now);
  if (!check.ok) return undefined;
  const identity = await identityKey(keys);
  const cert = keys.keys.find((k) => k.kid === check.key.kid)?.ojcp_cert;
  if (!identity || !cert) return undefined;
  const certExp = await verifyKeyCertificate(cert, {
    identity,
    subject,
    key: check.key,
    purpose: "manifest",
    now,
  });
  if (certExp === undefined) return undefined;
  return { identity, subject, validUntil: Math.min(check.expiresAt, certExp) };
}

/** Signs a manifest (provider side). ES256 only here. */
export async function signManifest(
  manifest: Record<string, unknown>,
  signer: Signer,
  options: { kid: string; iss: string; signedAt: Date; expiresAt: Date },
): Promise<Record<string, unknown>> {
  if (signer.alg !== "ES256") throw new TypeError("signManifest supports ES256 keys");
  const value = base64url(await signer.sign(signedBytes(manifest)));
  return {
    ...manifest,
    signature: {
      alg: "ES256",
      kid: options.kid,
      iss: options.iss,
      signed_at: options.signedAt.toISOString(),
      expires_at: options.expiresAt.toISOString(),
      value,
    },
  };
}
