/**
 * Test attesters and a test trust-list publisher (RFC 0010 §3, §4). They run
 * on their own origins with their own keys, so derivation fetches status and
 * lists over HTTPS exactly as it would from real ones. Every document they
 * serve points to the sandbox notice.
 */
import {
  type GeneratedSigner,
  generateSigner,
  type JWK,
  OjcpStatusList,
  Status,
  signStatusListToken,
  thumbprint,
} from "@ojcp/credentials-core";
import {
  ATTESTATION_TYPES,
  type AttestationInput,
  type AttestationType,
  issueAttestation,
  signTrustList,
  type TrustListPayload,
} from "@ojcp/trust";
import { Hono } from "hono";
import { NOTICE } from "./config.ts";
import type { EventBus, SandboxClock } from "./events.ts";
import { page } from "./html.ts";

const DAY = 86_400;

export class SandboxAttester {
  readonly origin: string;
  readonly label: string;
  readonly operator: string;
  readonly signer: GeneratedSigner;
  readonly #list = OjcpStatusList.create();
  readonly #bySubject = new Map<string, number[]>();
  #next = 1000;
  readonly #clock: SandboxClock;
  readonly #events: EventBus;

  private constructor(
    origin: string,
    label: string,
    operator: string,
    signer: GeneratedSigner,
    clock: SandboxClock,
    events: EventBus,
  ) {
    this.origin = origin;
    this.label = label;
    this.operator = operator;
    this.signer = signer;
    this.#clock = clock;
    this.#events = events;
  }

  static async create(
    origin: string,
    label: string,
    operator: string,
    clock: SandboxClock,
    events: EventBus,
  ): Promise<SandboxAttester> {
    return new SandboxAttester(
      origin,
      label,
      operator,
      await generateSigner("ES256"),
      clock,
      events,
    );
  }

  get statusUri(): string {
    return `${this.origin}/status/1`;
  }

  async issue(
    type: AttestationType,
    subject: string,
    identityThumbprint: string,
    claims: Record<string, unknown>,
    relationship: AttestationInput["relationship"] = "none",
  ): Promise<string> {
    const idx = this.#next++;
    this.#bySubject.set(subject, [...(this.#bySubject.get(subject) ?? []), idx]);
    const now = this.#clock.now();
    const lifetime = Math.min(ATTESTATION_TYPES[type].maxLifetime, 60 * DAY);
    this.#events.emit({
      actor: "attester",
      where: new URL(this.origin).host,
      title: `${this.label} attests ${type.replace("_", "-")} for ${subject}`,
      outcome: "info",
      detail: claims,
    });
    return issueAttestation(this.signer, {
      iss: this.origin,
      sub: subject,
      type,
      identityKeyThumbprint: identityThumbprint,
      iat: now - DAY,
      exp: now - DAY + lifetime,
      status: { idx, uri: this.statusUri },
      relationship,
      claims,
    });
  }

  /** RFC 0010 §3.2: suspend everything about a subject (a transfer or an unlinked key was seen). */
  suspend(subject: string): void {
    for (const idx of this.#bySubject.get(subject) ?? []) this.#list.set(idx, Status.SUSPENDED);
    this.#events.emit({
      actor: "attester",
      where: new URL(this.origin).host,
      title: `${this.label} suspends its attestations for ${subject}`,
      outcome: "info",
    });
  }

  reinstate(subject: string): void {
    for (const idx of this.#bySubject.get(subject) ?? []) this.#list.set(idx, Status.VALID);
  }

  statusToken(): Promise<string> {
    return signStatusListToken({
      uri: this.statusUri,
      list: this.#list,
      signer: this.signer,
      ttl: 3600,
      lifetime: 2 * 3600,
      now: new Date(this.#clock.now() * 1000),
    });
  }

  entry(types: AttestationType[]): TrustListPayload["attesters"][number] {
    return {
      id: this.origin,
      operator: this.operator,
      vct: types.map((t) => ATTESTATION_TYPES[t].vct),
      jwks: { keys: [{ ...(this.signer.publicJwk as JWK) }] },
    };
  }

  app(notice: string): Hono {
    const app = new Hono();
    app.get("/", (c) =>
      c.html(
        page(
          this.label,
          `<p>${this.label} is a test attester in the OJCP sandbox. It vouches only for sandbox origins.</p>`,
          notice,
        ),
      ),
    );
    app.get("/.well-known/jwt-vc-issuer", async (c) =>
      c.json({
        issuer: this.origin,
        jwks: {
          keys: [
            {
              ...this.signer.publicJwk,
              kid: await thumbprint(this.signer.publicJwk),
              alg: "ES256",
            },
          ],
        },
        ojcp_attester: {
          policy_uri: `${this.origin}/`,
          abuse_uri: `${this.origin}/`,
          appeals_uri: `${this.origin}/`,
          suspension_hours: 72,
          sandbox: NOTICE,
        },
      }),
    );
    app.get("/status/1", async (c) =>
      c.body(await this.statusToken(), 200, { "content-type": "application/statuslist+jwt" }),
    );
    return app;
  }
}

export class SandboxListPublisher {
  readonly origin: string;
  readonly signer: GeneratedSigner;
  readonly #attesters: Array<{ attester: SandboxAttester; types: AttestationType[] }> = [];
  readonly #distrusted: NonNullable<TrustListPayload["distrusted"]> = [];
  readonly #clock: SandboxClock;
  readonly #events: EventBus;

  private constructor(
    origin: string,
    signer: GeneratedSigner,
    clock: SandboxClock,
    events: EventBus,
  ) {
    this.origin = origin;
    this.signer = signer;
    this.#clock = clock;
    this.#events = events;
  }

  static async create(
    origin: string,
    clock: SandboxClock,
    events: EventBus,
  ): Promise<SandboxListPublisher> {
    return new SandboxListPublisher(origin, await generateSigner("ES256"), clock, events);
  }

  pin(): Promise<string> {
    return thumbprint(this.signer.publicJwk);
  }

  list(attester: SandboxAttester, types: AttestationType[]): void {
    this.#attesters.push({ attester, types });
  }

  /** An incident: distrust an attester outright (RFC 0010 §4.1). */
  distrust(attester: SandboxAttester, reason: string): void {
    this.#distrusted.push({ id: attester.origin, reason_uri: `${this.origin}/` });
    this.#events.emit({
      actor: "lists",
      where: new URL(this.origin).host,
      title: `Trust list distrusts ${attester.label}: ${reason}`,
      outcome: "info",
    });
  }

  clearDistrust(): void {
    this.#distrusted.length = 0;
  }

  token(): Promise<string> {
    const now = this.#clock.now();
    return signTrustList(this.signer, {
      publisher: this.origin,
      iat: now - 60,
      exp: now + 6 * DAY,
      policy_uri: `${this.origin}/`,
      appeals_uri: `${this.origin}/`,
      attesters: this.#attesters.map(({ attester, types }) => attester.entry(types)),
      distrusted: [...this.#distrusted],
    });
  }

  app(notice: string): Hono {
    const app = new Hono();
    app.get("/", (c) =>
      c.html(
        page(
          "Sandbox trust list",
          `<p>A test trust list. It lists only the sandbox attesters and must never be pinned outside the sandbox.</p><p><a href="/trust-list.jwt">trust-list.jwt</a></p>`,
          notice,
        ),
      ),
    );
    app.get("/trust-list.jwt", async (c) =>
      c.body(await this.token(), 200, { "content-type": "application/jwt" }),
    );
    return app;
  }
}
