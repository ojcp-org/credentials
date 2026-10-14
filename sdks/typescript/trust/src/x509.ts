/**
 * X.509 issuer keys (RFC 0010 §3.3): an `x5c` chain must validate to an anchor
 * the trust list pins for this attester, and the end-entity certificate must
 * carry a URI SAN equal to `iss`. An anchor never trusts a whole PKI.
 */

import { type JWK, sha256 } from "@ojcp/credentials-core";
import { ECDSASigValue } from "@peculiar/asn1-ecc";
import { AsnConvert } from "@peculiar/asn1-schema";
import {
  BasicConstraints,
  Certificate,
  id_ce_basicConstraints,
  id_ce_subjectAltName,
  SubjectAlternativeName,
} from "@peculiar/asn1-x509";

export interface X509Anchor {
  /** Lowercase hex SHA-256 of the anchor certificate's DER. */
  anchor_sha256: string;
  san_uri: string;
}

export interface ValidatedChain {
  /** The end-entity key, which must verify the attestation. */
  jwk: JWK;
  /** Lowercase hex SHA-256 of every certificate's SubjectPublicKeyInfo, for `spki_sha256` distrust. */
  spkiSha256: string[];
  /** When the chain stops being valid (earliest `notAfter`). */
  notAfter: number;
}

const SIG_ALGS: Record<
  string,
  { name: "ECDSA" | "RSASSA-PKCS1-v1_5"; hash: "SHA-256" | "SHA-384" }
> = {
  "1.2.840.10045.4.3.2": { name: "ECDSA", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { name: "ECDSA", hash: "SHA-384" },
  "1.2.840.113549.1.1.11": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
};
const EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const RSA_PUBLIC_KEY = "1.2.840.113549.1.1.1";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (buffer: ArrayBuffer) => new Uint8Array(buffer);
const equalBytes = (a: ArrayBuffer, b: ArrayBuffer) => hex(bytesOf(a)) === hex(bytesOf(b));

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface Parsed {
  der: Uint8Array<ArrayBuffer>;
  cert: Certificate;
  spki: ArrayBuffer;
}

async function importSpki(parsed: Parsed, hash: "SHA-256" | "SHA-384"): Promise<CryptoKey> {
  const algorithm = parsed.cert.tbsCertificate.subjectPublicKeyInfo.algorithm.algorithm;
  if (algorithm === EC_PUBLIC_KEY) {
    const point = parsed.cert.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey.byteLength;
    const namedCurve = point === 65 ? "P-256" : point === 97 ? "P-384" : undefined;
    if (!namedCurve) throw new Error("unsupported curve");
    return crypto.subtle.importKey("spki", parsed.spki, { name: "ECDSA", namedCurve }, true, [
      "verify",
    ]);
  }
  if (algorithm === RSA_PUBLIC_KEY)
    return crypto.subtle.importKey("spki", parsed.spki, { name: "RSASSA-PKCS1-v1_5", hash }, true, [
      "verify",
    ]);
  throw new Error("unsupported key type");
}

function rawEcdsa(der: ArrayBuffer, size: number): Uint8Array<ArrayBuffer> {
  const { r, s } = AsnConvert.parse(der, ECDSASigValue);
  const fit = (n: ArrayBuffer) => {
    let b = bytesOf(n);
    while (b.length > size && b[0] === 0) b = b.slice(1);
    const out = new Uint8Array(size);
    out.set(b, size - b.length);
    return out;
  };
  const out = new Uint8Array(size * 2);
  out.set(fit(r), 0);
  out.set(fit(s), size);
  return out;
}

/** True if `issuer` signed `child`. */
async function signedBy(child: Parsed, issuer: Parsed): Promise<boolean> {
  const alg = SIG_ALGS[child.cert.signatureAlgorithm.algorithm];
  if (!alg) return false;
  if (
    !equalBytes(
      AsnConvert.serialize(child.cert.tbsCertificate.issuer),
      AsnConvert.serialize(issuer.cert.tbsCertificate.subject),
    )
  )
    return false;
  try {
    const key = await importSpki(issuer, alg.hash);
    const tbs = AsnConvert.serialize(child.cert.tbsCertificate);
    let signature: Uint8Array<ArrayBuffer> = bytesOf(child.cert.signatureValue);
    if (alg.name === "ECDSA") {
      const size = (key.algorithm as EcKeyAlgorithm).namedCurve === "P-384" ? 48 : 32;
      signature = rawEcdsa(child.cert.signatureValue, size);
    }
    return crypto.subtle.verify(
      alg.name === "ECDSA" ? { name: "ECDSA", hash: alg.hash } : { name: alg.name },
      key,
      signature,
      tbs,
    );
  } catch {
    return false;
  }
}

function isCa(cert: Certificate): boolean {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_basicConstraints);
  if (!ext) return false;
  return AsnConvert.parse(ext.extnValue.buffer, BasicConstraints).cA === true;
}

function sanUris(cert: Certificate): string[] {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_subjectAltName);
  if (!ext) return [];
  return AsnConvert.parse(ext.extnValue.buffer, SubjectAlternativeName)
    .map((n) => n.uniformResourceIdentifier)
    .filter((u): u is string => typeof u === "string");
}

/**
 * Validates `x5c` (base64 DER, leaf first) for attester `iss` against its
 * pinned anchors. The anchor must be included in the chain, since the list
 * pins only its hash.
 */
export async function validateX5c(
  x5c: readonly string[],
  iss: string,
  anchors: readonly X509Anchor[],
  now: number,
): Promise<ValidatedChain | undefined> {
  if (x5c.length === 0 || x5c.length > 5) return undefined;
  let chain: Parsed[];
  try {
    chain = x5c.map((b64) => {
      const der = fromBase64(b64);
      const cert = AsnConvert.parse(der, Certificate);
      return { der, cert, spki: AsnConvert.serialize(cert.tbsCertificate.subjectPublicKeyInfo) };
    });
  } catch {
    return undefined;
  }
  const leaf = chain[0] as Parsed;
  const pins = anchors.filter((a) => a.san_uri === iss);
  if (pins.length === 0 || !sanUris(leaf.cert).includes(iss)) return undefined;

  const hashes = await Promise.all(chain.map(async (c) => hex(await sha256(c.der))));
  const pinned = new Set(pins.map((p) => p.anchor_sha256.toLowerCase()));
  const anchorIndex = hashes.findIndex((h) => pinned.has(h));
  if (anchorIndex < 0) return undefined;
  let notAfter = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= anchorIndex; i++) {
    const c = chain[i] as Parsed;
    const validity = c.cert.tbsCertificate.validity;
    const from = validity.notBefore.getTime().getTime() / 1000;
    const to = validity.notAfter.getTime().getTime() / 1000;
    if (now < from || now > to) return undefined;
    notAfter = Math.min(notAfter, to);
    if (i < anchorIndex) {
      const issuer = chain[i + 1] as Parsed;
      if (!isCa(issuer.cert) || !(await signedBy(c, issuer))) return undefined;
    }
  }
  const leafAlg = SIG_ALGS[leaf.cert.signatureAlgorithm.algorithm];
  const leafKey = await importSpki(leaf, leafAlg?.hash ?? "SHA-256").catch(() => undefined);
  if (!leafKey) return undefined;
  const jwk = (await crypto.subtle.exportKey("jwk", leafKey)) as JWK;
  const spkiSha256 = await Promise.all(
    chain.slice(0, anchorIndex + 1).map(async (c) => hex(await sha256(bytesOf(c.spki)))),
  );
  return {
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, n: jwk.n, e: jwk.e } as JWK,
    spkiSha256,
    notAfter,
  };
}
