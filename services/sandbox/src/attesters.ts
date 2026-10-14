/**
 * Test attesters and a test trust-list publisher (RFC 0010 §3, §4). They run
 * on their own origins with their own keys, so derivation fetches status and
 * lists over HTTPS exactly as it would from real ones. Every document they
 * serve points to the sandbox notice.
 *
 * Each keeps a public record of what it did (what it vouched for, status
 * changes, who fetched its status list) for its own page in the sandbox UI.
 */
import {
  type GeneratedSigner,
  generateSigner,
  type JWK,
  OjcpStatusList,
  Status,
  type StatusValue,
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

const DAY = 86_400;
const MAX_ACTIVITY = 200;

/** RFC 0010's attestation types, as a person would say them. */
const TYPE_WORDS: Record<AttestationType, string> = {
  domain_control: "controls this domain",
  legal_entity: "is a real, registered company",
  business_registration: "is in good standing in the business register",
  hosted_employer: "hosts this employer's careers site, with the employer's say-so",
  conformance: "passed the OJCP conformance suite",
  security_review: "passed a security review",
  listing_tenure: "has been listed for a while without incident",
};

/** One thing an attester or list publisher did, as its page shows it. */
export interface Activity {
  at: number;
  kind: "issued" | "suspended" | "reinstated" | "fetched" | "listed" | "distrusted" | "cleared";
  text: string;
}

/** An attestation as the attester's page lists it: what it vouched for, about whom. */
export interface Vouched {
  subject: string;
  type: AttestationType;
  claims: Record<string, unknown>;
  issuedAt: number;
  expires: number;
  status: "valid" | "suspended";
}

function record(log: Activity[], entry: Activity): void {
  log.unshift(entry);
  if (log.length > MAX_ACTIVITY) log.length = MAX_ACTIVITY;
}

/** `did:web:acme.sandbox.ojcp.dev` → `acme.sandbox.ojcp.dev`, for people. */
const siteOf = (subject: string): string =>
  decodeURIComponent(subject.replace(/^did:web:/, "").split(":")[0] ?? subject);

export class SandboxAttester {
  readonly origin: string;
  readonly label: string;
  readonly operator: string;
  /** What this attester checks before vouching, in a sentence. */
  readonly checks: string;
  readonly signer: GeneratedSigner;
  readonly activity: Activity[] = [];
  readonly #list = OjcpStatusList.create();
  readonly #bySubject = new Map<string, number[]>();
  readonly #vouched = new Map<number, Vouched>();
  #next = 1000;
  readonly #clock: SandboxClock;
  readonly #events: EventBus;

  private constructor(
    origin: string,
    label: string,
    operator: string,
    checks: string,
    signer: GeneratedSigner,
    clock: SandboxClock,
    events: EventBus,
  ) {
    this.origin = origin;
    this.label = label;
    this.operator = operator;
    this.checks = checks;
    this.signer = signer;
    this.#clock = clock;
    this.#events = events;
  }

  static async create(
    origin: string,
    label: string,
    operator: string,
    checks: string,
    clock: SandboxClock,
    events: EventBus,
  ): Promise<SandboxAttester> {
    return new SandboxAttester(
      origin,
      label,
      operator,
      checks,
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
    this.#vouched.set(idx, {
      subject,
      type,
      claims,
      issuedAt: now - DAY,
      expires: now - DAY + lifetime,
      status: "valid",
    });
    record(this.activity, {
      at: now,
      kind: "issued",
      text: `Vouched for ${siteOf(subject)}: ${TYPE_WORDS[type]}`,
    });
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
    this.#setAll(subject, Status.SUSPENDED, "suspended");
    record(this.activity, {
      at: this.#clock.now(),
      kind: "suspended",
      text: `Suspended everything it said about ${siteOf(subject)} while it investigates`,
    });
    this.#events.emit({
      actor: "attester",
      where: new URL(this.origin).host,
      title: `${this.label} suspends its attestations for ${subject}`,
      outcome: "info",
      say: `${this.label} suspended what it said about ${siteOf(subject)}. Until it's sorted out, assistants won't send applications there.`,
    });
  }

  reinstate(subject: string): void {
    if (
      !(this.#bySubject.get(subject) ?? []).some(
        (i) => this.#vouched.get(i)?.status === "suspended",
      )
    )
      return;
    this.#setAll(subject, Status.VALID, "valid");
    record(this.activity, {
      at: this.#clock.now(),
      kind: "reinstated",
      text: `Reinstated what it said about ${siteOf(subject)}`,
    });
  }

  #setAll(subject: string, status: StatusValue, shown: Vouched["status"]): void {
    for (const idx of this.#bySubject.get(subject) ?? []) {
      this.#list.set(idx, status);
      const v = this.#vouched.get(idx);
      if (v) v.status = shown;
    }
  }

  /** What its page shows: who it is, what it checks, what it vouched for, what it did. */
  view(): Record<string, unknown> {
    return {
      name: this.label,
      origin: this.origin,
      checks: this.checks,
      statusList: this.statusUri,
      vouched: [...this.#vouched.values()].map((v) => ({
        ...v,
        site: siteOf(v.subject),
        what: TYPE_WORDS[v.type],
      })),
      activity: this.activity,
    };
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

  /** Its protocol endpoints; its page is the sandbox UI, which reads `/api/registry`. */
  app(): Hono {
    const app = new Hono();
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
    app.get("/status/1", async (c) => {
      record(this.activity, {
        at: this.#clock.now(),
        kind: "fetched",
        text: "Someone fetched its status list (it never learns who, or which attestation they're checking)",
      });
      return c.body(await this.statusToken(), 200, {
        "content-type": "application/statuslist+jwt",
      });
    });
    app.get("/api/registry", (c) => c.json(this.view()));
    return app;
  }
}

export class SandboxListPublisher {
  readonly origin: string;
  readonly signer: GeneratedSigner;
  readonly activity: Activity[] = [];
  readonly #attesters: Array<{ attester: SandboxAttester; types: AttestationType[] }> = [];
  readonly #distrusted: Array<
    NonNullable<TrustListPayload["distrusted"]>[number] & { reason: string }
  > = [];
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
    record(this.activity, {
      at: this.#clock.now(),
      kind: "listed",
      text: `Listed ${attester.label}: believed when it says a company ${types.map((t) => TYPE_WORDS[t]).join(", or ")}`,
    });
  }

  /** An incident: distrust an attester outright (RFC 0010 §4.1). */
  distrust(attester: SandboxAttester, reason: string): void {
    this.#distrusted.push({ id: attester.origin, reason_uri: `${this.origin}/`, reason });
    record(this.activity, {
      at: this.#clock.now(),
      kind: "distrusted",
      text: `Distrusted ${attester.label}: ${reason}. Nothing it signed counts any more`,
    });
    this.#events.emit({
      actor: "lists",
      where: new URL(this.origin).host,
      title: `Trust list distrusts ${attester.label}: ${reason}`,
      outcome: "info",
      say: `The trust list stopped trusting ${attester.label}. Every site that relied on it now shows as unverified.`,
    });
  }

  clearDistrust(): void {
    if (this.#distrusted.length === 0) return;
    this.#distrusted.length = 0;
    record(this.activity, {
      at: this.#clock.now(),
      kind: "cleared",
      text: "Lifted every distrust entry",
    });
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
      distrusted: this.#distrusted.map(({ id, reason_uri }) => ({ id, reason_uri })),
    });
  }

  /** The signed list; its page is the sandbox UI, which reads `/api/registry`. */
  app(): Hono {
    const app = new Hono();
    app.get("/trust-list.jwt", async (c) => {
      record(this.activity, {
        at: this.#clock.now(),
        kind: "fetched",
        text: "An assistant fetched the list to decide which attesters to believe",
      });
      return c.body(await this.token(), 200, { "content-type": "application/jwt" });
    });
    app.get("/api/registry", async (c) =>
      c.json({
        name: "Sandbox trust list",
        origin: this.origin,
        pin: await this.pin(),
        listed: this.#attesters.map(({ attester, types }) => ({
          name: attester.label,
          origin: attester.origin,
          for: types.map((t) => TYPE_WORDS[t]),
          distrusted: this.#distrusted.find((d) => d.id === attester.origin)?.reason,
        })),
        activity: this.activity,
      }),
    );
    return app;
  }
}
