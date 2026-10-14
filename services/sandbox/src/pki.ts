/**
 * Certificates for wallet requests (RFC 0013 §4.2): each provider signs its
 * OpenID4VP requests under a certificate whose `dNSName` is its manifest host,
 * and names itself `x509_hash:<hash of that certificate>` (HAIP §5). A real
 * provider gets the certificate from a CA that wallets trust. Here a sandbox
 * CA plays that part, and only the sandbox wallet pins it.
 */
import "reflect-metadata";
import {
  base64,
  base64url,
  fromBase64url,
  type JWK,
  type Signer,
  sha256,
  webCryptoSigner,
} from "@ojcp/credentials-core";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(crypto);

const EC = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const YEAR_MS = 365 * 86_400_000;

/** What a provider needs to sign requests as `x509_hash`. */
export interface RequestCredential {
  clientId: string;
  /**
   * The leaf, then any intermediates, standard base64 DER (RFC 7515 §4.1.6).
   * Never the trust anchor: the wallet already has it (HAIP 1.0 §5).
   */
  x5c: string[];
  signer: Signer;
}

/** The checked identity of a request signer. */
export interface RequestSigner {
  jwk: JWK;
  dnsNames: string[];
  organization: string | undefined;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class VerifierCa {
  readonly #keys: CryptoKeyPair;
  readonly #cert: x509.X509Certificate;

  private constructor(keys: CryptoKeyPair, cert: x509.X509Certificate) {
    this.#keys = keys;
    this.#cert = cert;
  }

  static async create(name: string): Promise<VerifierCa> {
    const keys = (await crypto.subtle.generateKey(EC, false, ["sign", "verify"])) as CryptoKeyPair;
    const now = Date.now();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: `CN=${name}`,
      notBefore: new Date(now - 86_400_000),
      notAfter: new Date(now + YEAR_MS),
      signingAlgorithm: EC,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
      ],
    });
    return new VerifierCa(keys, cert);
  }

  /** The CA certificate a wallet keeps as a trust anchor, standard base64 DER. */
  anchor(): string {
    return base64(new Uint8Array(this.#cert.rawData));
  }

  /** A request-signing certificate for one host, as RFC 0013 §4.2 describes. */
  async issue(host: string, organization: string): Promise<RequestCredential> {
    const keys = (await crypto.subtle.generateKey(EC, false, ["sign", "verify"])) as CryptoKeyPair;
    const now = Date.now();
    const hostname = host.split(":")[0] as string;
    const leaf = await x509.X509CertificateGenerator.create({
      // A positive random serial (a leading zero byte keeps the sign bit clear).
      serialNumber: `00${hex(crypto.getRandomValues(new Uint8Array(12)))}`,
      subject: `CN=${hostname}, O=${organization}`,
      issuer: this.#cert.subject,
      notBefore: new Date(now - 86_400_000),
      notAfter: new Date(now + YEAR_MS),
      signingAlgorithm: EC,
      publicKey: keys.publicKey,
      signingKey: this.#keys.privateKey,
      extensions: [
        new x509.SubjectAlternativeNameExtension([{ type: "dns", value: hostname }]),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      ],
    });
    const leafDer = new Uint8Array(leaf.rawData);
    const publicJwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JWK;
    return {
      clientId: `x509_hash:${base64url(await sha256(leafDer))}`,
      x5c: [base64(leafDer)],
      signer: await webCryptoSigner(keys.privateKey, publicJwk, "ES256"),
    };
  }
}

/**
 * The wallet's check of a signed request's certificate chain: the leaf hashes
 * to the `x509_hash` client ID, and the chain, completed with one of the
 * wallet's own anchor certificates, is valid now.
 */
export async function checkRequestSigner(
  x5c: readonly string[],
  clientId: string,
  anchors: readonly string[],
  now: number,
): Promise<RequestSigner | undefined> {
  if (x5c.length < 1 || x5c.length > 4 || !clientId.startsWith("x509_hash:")) return undefined;
  let chain: x509.X509Certificate[];
  let roots: x509.X509Certificate[];
  try {
    chain = x5c.map((b64) => new x509.X509Certificate(b64));
    roots = anchors.map((b64) => new x509.X509Certificate(b64));
  } catch {
    return undefined;
  }
  const leaf = chain[0] as x509.X509Certificate;
  const expected = base64url(await sha256(new Uint8Array(leaf.rawData)));
  const given = clientId.slice("x509_hash:".length);
  if (fromBase64url(given).length !== 32 || given !== expected) return undefined;
  const date = new Date(now * 1000);
  // The last certificate sent must be issued by one of the anchors.
  const top = chain.at(-1) as x509.X509Certificate;
  const root = roots.find((r) => r.subject === top.issuer);
  if (!root || date < root.notBefore || date > root.notAfter) return undefined;
  const full = [...chain, root];
  for (let i = 0; i < chain.length; i++) {
    const cert = full[i] as x509.X509Certificate;
    if (date < cert.notBefore || date > cert.notAfter) return undefined;
    const issuer = full[i + 1] as x509.X509Certificate;
    // Every issuer in the path must be a CA allowed to sign certificates.
    const constraints = issuer.getExtension(x509.BasicConstraintsExtension);
    const usage = issuer.getExtension(x509.KeyUsagesExtension);
    if (!constraints?.ca || (usage && !(usage.usages & x509.KeyUsageFlags.keyCertSign)))
      return undefined;
    if (!(await cert.verify({ publicKey: issuer.publicKey, signatureOnly: true })))
      return undefined;
  }
  // The leaf signs requests; a CA certificate can't stand in for it.
  const leafUsage = leaf.getExtension(x509.KeyUsagesExtension);
  if (leaf.getExtension(x509.BasicConstraintsExtension)?.ca) return undefined;
  if (leafUsage && !(leafUsage.usages & x509.KeyUsageFlags.digitalSignature)) return undefined;
  const key = await leaf.publicKey.export(EC, ["verify"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JWK;
  const san = leaf.getExtension(x509.SubjectAlternativeNameExtension);
  return {
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JWK,
    dnsNames: san ? san.names.items.filter((n) => n.type === "dns").map((n) => n.value) : [],
    organization: leaf.subjectName.getField("O")[0],
  };
}
