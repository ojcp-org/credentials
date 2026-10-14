/**
 * Organization identity (RFC 0010 §2): the `did:web` identifier derived from
 * the manifest origin, the identity key in `ojcp-keys.json`, and key
 * certificates (`ojcp_cert`) by which it certifies working keys.
 */
import {
  decodeJws,
  type JWK,
  publicPart,
  type Signer,
  signJws,
  thumbprint,
  verifyJws,
} from "@ojcp/credentials-core";
import { z } from "zod";

export const KEY_CERT_TYP = "ojcp-key-cert+jwt";
export const KEY_PURPOSES = ["manifest", "posting"] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];
/** RFC 0010 §2.2: certificate lifetime SHOULD NOT exceed 180 days; longer ones are refused here. */
export const MAX_CERT_LIFETIME = 180 * 86_400;

/**
 * The organization identifier for an origin (§2.1): `did:web:` + the host,
 * lowercased, in A-label form, with a non-default port percent-encoded. IP
 * literals have none.
 */
export function organizationId(origin: string): string | undefined {
  const url = new URL(origin);
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return undefined;
  return `did:web:${host}${url.port ? `%3A${url.port}` : ""}`;
}

export const OjcpJwk = z.looseObject({
  kty: z.string(),
  kid: z.string().optional(),
  alg: z.string().optional(),
  ojcp_role: z.literal("identity").optional(),
  ojcp_cert: z.string().optional(),
});
export const OjcpKeySet = z.looseObject({ keys: z.array(OjcpJwk) });
export type OjcpKeySet = z.infer<typeof OjcpKeySet>;

export interface IdentityKey {
  jwk: JWK;
  thumbprint: string;
}

/** The set's identity key; more than one current identity key makes the set invalid (§2.2). */
export async function identityKey(set: OjcpKeySet): Promise<IdentityKey | undefined> {
  const identities = set.keys.filter((k) => k.ojcp_role === "identity");
  if (identities.length !== 1) return undefined;
  const jwk = publicPart(identities[0] as JWK);
  return { jwk, thumbprint: await thumbprint(jwk) };
}

const KeyCertPayload = z.looseObject({
  sub: z.string(),
  jkt: z.string(),
  purposes: z.array(z.string()),
  iat: z.number().int(),
  exp: z.number().int(),
});

/**
 * Checks a key certificate (§2.2): signed by the identity key (`kid` its
 * thumbprint), `sub` the organization, `jkt` the certified key, the purpose
 * listed, unexpired. Returns the certificate's `exp`, or `undefined`.
 */
export async function verifyKeyCertificate(
  cert: string,
  options: { identity: IdentityKey; subject: string; key: JWK; purpose: KeyPurpose; now: number },
): Promise<number | undefined> {
  try {
    const { header } = decodeJws(cert);
    if (header.typ !== KEY_CERT_TYP || header.kid !== options.identity.thumbprint) return undefined;
    const payload = KeyCertPayload.safeParse((await verifyJws(cert, options.identity.jwk)).payload);
    if (!payload.success) return undefined;
    const p = payload.data;
    if (p.sub !== options.subject || p.jkt !== (await thumbprint(options.key))) return undefined;
    if (!p.purposes.includes(options.purpose)) return undefined;
    if (p.exp - p.iat > MAX_CERT_LIFETIME || options.now >= p.exp || options.now < p.iat - 60)
      return undefined;
    return p.exp;
  } catch {
    return undefined;
  }
}

/** Issues a key certificate (provider side). */
export async function signKeyCertificate(
  identity: Signer,
  claims: { sub: string; key: JWK; purposes: KeyPurpose[]; iat: number; exp: number },
): Promise<string> {
  return signJws(
    { typ: KEY_CERT_TYP, kid: await thumbprint(identity.publicJwk) },
    {
      sub: claims.sub,
      jkt: await thumbprint(claims.key),
      purposes: claims.purposes,
      iat: claims.iat,
      exp: claims.exp,
    },
    identity,
  );
}
