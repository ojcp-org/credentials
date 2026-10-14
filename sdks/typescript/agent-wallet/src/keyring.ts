/**
 * The agent platform's keys: a request-signing key, and the mandate key set
 * (RFC 0008 §3.4): at least 32 shared P-256 keys, each with
 * `ojcp_mandate_until`, published in the key directory.
 */
import {
  generateSigner,
  type JWK,
  KEY_DIRECTORY_MEDIA_TYPE,
  type Signer,
  thumbprint,
} from "@ojcp/credentials-core";

export const MIN_MANDATE_KEYS = 32;
/** A key binds no credential until it has been published this long (RFC 0008 §3.4). */
export const MANDATE_KEY_QUARANTINE = 7 * 86_400;

export interface MandateKey {
  signer: Signer;
  thumbprint: string;
  /** NumericDate after which the key binds no mandate. */
  until: number;
  /** When the key first appeared in the directory. */
  publishedAt: number;
}

export interface KeyDirectoryDocument {
  keys: Array<JWK & { kid: string; ojcp_mandate_until?: number }>;
}

export class AgentKeyring {
  readonly #request: { signer: Signer; thumbprint: string };
  readonly #mandate = new Map<string, MandateKey>();

  private constructor(request: { signer: Signer; thumbprint: string }) {
    this.#request = request;
  }

  /** Wraps an existing request-signing key (HSM/KMS-backed in production). */
  static async create(requestSigner: Signer): Promise<AgentKeyring> {
    return new AgentKeyring({
      signer: requestSigner,
      thumbprint: await thumbprint(requestSigner.publicJwk),
    });
  }

  get requestSigner(): Signer {
    return this.#request.signer;
  }

  /** Adds a mandate key; P-256 only (RFC 0008 §3.4). */
  async addMandateKey(signer: Signer, until: number, publishedAt: number): Promise<MandateKey> {
    if (signer.alg !== "ES256") throw new TypeError("mandate keys are P-256");
    const key = { signer, thumbprint: await thumbprint(signer.publicJwk), until, publishedAt };
    this.#mandate.set(key.thumbprint, key);
    return key;
  }

  /** Generates in-memory mandate keys up to `count` (tests and local development). */
  async generateMandateKeys(count: number, until: number, publishedAt: number): Promise<void> {
    for (let i = 0; i < count; i++)
      await this.addMandateKey(await generateSigner("ES256"), until, publishedAt);
  }

  /** Removes a compromised key at once (RFC 0008 §7.4). */
  revokeMandateKey(thumbprint: string): void {
    this.#mandate.delete(thumbprint);
  }

  mandateKey(thumbprint: string): MandateKey | undefined {
    return this.#mandate.get(thumbprint);
  }

  /** Keys an issuer may bind a credential expiring at `exp` to, at time `now`. */
  eligibleMandateKeys(exp: number, now: number): MandateKey[] {
    return [...this.#mandate.values()].filter(
      (k) => k.until >= exp && now - k.publishedAt >= MANDATE_KEY_QUARANTINE,
    );
  }

  /** A signer for any key this platform holds, by RFC 7638 thumbprint. */
  signerFor(thumbprint: string): Signer | undefined {
    if (thumbprint === this.#request.thumbprint) return this.#request.signer;
    return this.#mandate.get(thumbprint)?.signer;
  }

  /** The document served at `/.well-known/http-message-signatures-directory`. */
  directory(): KeyDirectoryDocument {
    const keys: KeyDirectoryDocument["keys"] = [
      { ...this.#request.signer.publicJwk, kid: this.#request.thumbprint },
    ];
    for (const key of this.#mandate.values())
      keys.push({ ...key.signer.publicJwk, kid: key.thumbprint, ojcp_mandate_until: key.until });
    if (keys.length > 1 && keys.length - 1 < MIN_MANDATE_KEYS)
      throw new Error(`a mandate key set holds at least ${MIN_MANDATE_KEYS} keys`);
    return { keys };
  }

  /** The directory as an HTTP response. */
  directoryResponse(): Response {
    return new Response(JSON.stringify(this.directory()), {
      headers: { "content-type": KEY_DIRECTORY_MEDIA_TYPE, "cache-control": "max-age=300" },
    });
  }
}
