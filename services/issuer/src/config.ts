/**
 * Issuer configuration and the integrations a deployment supplies: message
 * delivery, the agent key directories it reads, and the clock.
 */
import { type JWK, KeyDirectory, type Signer, thumbprint } from "@ojcp/credentials-core";
import type { IssuerStore } from "./store.ts";

/** An agent platform registered as an OAuth client (the OpenID4VCI Wallet role, RFC 0008 §3.1). */
export interface AgentClient {
  clientId: string;
  /** Shown on the consent screen. */
  name: string;
  agentId: string;
  redirectUris: readonly string[];
  /** Origin serving the platform's key directory. */
  keyDirectory: string;
  /** Whether this issuer shares control with the platform (RFC 0008 §2.3). */
  affiliated: boolean;
}

/** Sends one-time codes, credential offers and transaction codes. */
export interface Messenger {
  send(
    to: { email: string } | { phone: string },
    message: { subject: string; text: string },
  ): Promise<void>;
}

/** Mandate keys an agent platform currently publishes, with when this issuer first saw each. */
export interface MandateKeySource {
  mandateKeys(
    client: AgentClient,
  ): Promise<Array<{ jwk: JWK; thumbprint: string; until: number; firstSeen: number }>>;
}

export interface IssuerConfig {
  /** The `iss` origin, e.g. `https://mandates.example`. */
  issuer: string;
  /** The credential signing key: separate from any single sign-on key (RFC 0014 §4.1). */
  signer: Signer;
  /** RFC 0014 §5.1 signing window for this key. */
  signUntil: number;
  store: IssuerStore;
  messenger: Messenger;
  mandateKeys: MandateKeySource;
  clients: readonly AgentClient[];
  /** Status list URIs under the issuer origin; at least two. */
  statusLists: readonly string[];
  /** OJCP version of the mandate vocabulary. */
  ojcpVersion: string;
  /** Practice statement URL (RFC 0014 §6). */
  policyUri: string;
  /** RFC 0014 §6: REQUIRED when issuing customer_records or source_check credentials. */
  consumerReportingAgency?: boolean;
  /** Bearer token for the record-holder API (HRIS integration). */
  adminToken?: string;
  /** Secret for signing the account-page cookie. */
  cookieSecret: string;
  batchSize?: number;
  /** The issuer's name for wallets to show (OpenID4VCI §12.2.4 `display`). */
  displayName?: string;
  /**
   * The operator's own consent screen, as a URL template with `{id}`, e.g.
   * `https://wallet.example/permissions/{id}` in a wallet provider's app, or a
   * path such as `/consent/{id}` on this origin. `/authorize` creates the
   * request and redirects there. That screen reads the request with
   * `Issuer.consent` (or the JSON consent API) and approves with
   * `Issuer.approveSignedIn` for a person the operator already verified, or
   * with one-time codes. Unset: the built-in page.
   */
  consentUi?: string;
  /** A banner shown on every page, e.g. for a test-only deployment. */
  notice?: string;
  now?: () => number;
}

/**
 * Reads mandate keys from the platform's key directory and remembers when each
 * key first appeared, which the 7-day rule (RFC 0008 §3.4) needs.
 */
export class DirectoryMandateKeySource implements MandateKeySource {
  readonly #store: IssuerStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(store: IssuerStore, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#store = store;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Poll on a schedule so first-seen times are recorded before any issuance needs them. */
  async mandateKeys(
    client: AgentClient,
  ): Promise<Array<{ jwk: JWK; thumbprint: string; until: number; firstSeen: number }>> {
    const url = new URL("/.well-known/http-message-signatures-directory", client.keyDirectory);
    const response = await this.#fetch(url);
    if (!response.ok) throw new Error(`key directory returned ${response.status}`);
    const directory = KeyDirectory.parse(await response.json());
    const now = this.#now();
    const out = [];
    for (const raw of directory.keys) {
      const until = raw.ojcp_mandate_until;
      if (typeof until !== "number" || raw.kty !== "EC" || raw.crv !== "P-256") continue;
      const jwk = { kty: "EC", crv: "P-256", x: raw.x, y: raw.y } as JWK;
      const tp = await thumbprint(jwk);
      const id = `${client.agentId}#${tp}`;
      let observed = await this.#store.get("observedKey", id);
      if (!observed) {
        observed = { id, jwk, until, firstSeen: now };
        await this.#store.put("observedKey", observed);
      }
      out.push({ jwk, thumbprint: tp, until, firstSeen: observed.firstSeen });
    }
    return out;
  }
}

/** Logs messages instead of sending them (local development only). */
export class ConsoleMessenger implements Messenger {
  async send(
    to: { email: string } | { phone: string },
    message: { subject: string; text: string },
  ): Promise<void> {
    console.info(
      `[message to ${"email" in to ? to.email : to.phone}] ${message.subject}\n${message.text}`,
    );
  }
}
