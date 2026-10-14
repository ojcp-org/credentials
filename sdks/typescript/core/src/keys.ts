import { calculateJwkThumbprint, type JWK } from "jose";

export type { JWK };

/** JWS algorithms OJCP credentials and request signatures use. */
export type JwsAlg = "ES256" | "EdDSA";

/**
 * A signing key whose private half may live anywhere: in memory, an OS keychain,
 * an HSM or a cloud KMS. `sign` returns the raw signature: r||s for ES256
 * (IEEE P1363, as JWS and RFC 9421 both require), 64 bytes for EdDSA.
 */
export interface Signer {
  readonly alg: JwsAlg;
  readonly publicJwk: JWK;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** RFC 9421 algorithm label for a JWS algorithm. */
export function httpSignatureAlgorithm(alg: JwsAlg): "ecdsa-p256-sha256" | "ed25519" {
  return alg === "ES256" ? "ecdsa-p256-sha256" : "ed25519";
}

/** RFC 7638 SHA-256 thumbprint, base64url. */
export function thumbprint(jwk: JWK): Promise<string> {
  return calculateJwkThumbprint(publicPart(jwk), "sha256");
}

/** The public members of a JWK (drops `d` and any private parameters). */
export function publicPart(jwk: JWK): JWK {
  if (jwk.kty === "EC") return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y } as JWK;
  if (jwk.kty === "OKP") return { kty: "OKP", crv: jwk.crv, x: jwk.x } as JWK;
  throw new TypeError(`unsupported key type ${jwk.kty}`);
}

export function algForJwk(jwk: JWK): JwsAlg {
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return "EdDSA";
  throw new TypeError(`unsupported key ${jwk.kty}/${jwk.crv}`);
}

function webCryptoParams(alg: JwsAlg): {
  generate: EcKeyGenParams | Algorithm;
  sign: EcdsaParams | Algorithm;
  import: EcKeyImportParams | Algorithm;
} {
  return alg === "ES256"
    ? {
        generate: { name: "ECDSA", namedCurve: "P-256" },
        sign: { name: "ECDSA", hash: "SHA-256" },
        import: { name: "ECDSA", namedCurve: "P-256" },
      }
    : { generate: { name: "Ed25519" }, sign: { name: "Ed25519" }, import: { name: "Ed25519" } };
}

/** A Signer over a WebCrypto private key. */
export async function webCryptoSigner(
  privateKey: CryptoKey,
  publicJwk: JWK,
  alg: JwsAlg,
): Promise<Signer> {
  const params = webCryptoParams(alg);
  const pub = publicPart(publicJwk);
  return {
    alg,
    publicJwk: pub,
    async sign(data) {
      return new Uint8Array(
        await crypto.subtle.sign(params.sign, privateKey, data as Uint8Array<ArrayBuffer>),
      );
    },
  };
}

export interface GeneratedSigner extends Signer {
  /** Present only when generated with `extractable: true` (tests, local development). */
  readonly privateJwk?: JWK;
}

/**
 * Generates a key pair in memory. Production deployments keep keys in an HSM or
 * KMS and implement `Signer` over it instead.
 */
export async function generateSigner(
  alg: JwsAlg,
  options: { extractable?: boolean } = {},
): Promise<GeneratedSigner> {
  const params = webCryptoParams(alg);
  const pair = (await crypto.subtle.generateKey(params.generate, options.extractable ?? false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JWK;
  const signer = await webCryptoSigner(pair.privateKey, publicJwk, alg);
  if (!options.extractable) return signer;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JWK;
  return { ...signer, sign: signer.sign, privateJwk };
}

/** A Signer from a private JWK (tests and local development only). */
export async function signerFromPrivateJwk(privateJwk: JWK): Promise<GeneratedSigner> {
  const alg = algForJwk(privateJwk);
  const params = webCryptoParams(alg);
  const key = await crypto.subtle.importKey("jwk", privateJwk as JsonWebKey, params.import, false, [
    "sign",
  ]);
  const signer = await webCryptoSigner(key, publicPart(privateJwk), alg);
  return { ...signer, sign: signer.sign, privateJwk };
}

/** Verifies a raw signature with a public JWK. */
export async function verifyRaw(
  publicJwk: JWK,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const alg = algForJwk(publicJwk);
  const params = webCryptoParams(alg);
  const key = await crypto.subtle.importKey(
    "jwk",
    publicPart(publicJwk) as JsonWebKey,
    params.import,
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    params.sign,
    key,
    signature as Uint8Array<ArrayBuffer>,
    data as Uint8Array<ArrayBuffer>,
  );
}
