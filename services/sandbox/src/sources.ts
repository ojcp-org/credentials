/**
 * The places that hold Jordan's Vandelay Industries work record, each able to
 * sign it (RFC 0014 §3): WorkSecond, the HR platform Vandelay uses (a wink at
 * Workday), and MDP, its payroll processor (a wink at ADP), both signing in
 * their own name as `customer_records` issuers; and Vandelay itself, signing
 * its `own_records`. Each is a `services/issuer` on its own origin. An
 * employee signed in to any of them can add the record to a wallet at any
 * time (§4.1); leaving isn't required. Employers choose which of them they
 * accept, and the candidate chooses which to share.
 */
import {
  base64url,
  type GeneratedSigner,
  generateSigner,
  type JWK,
  publicPart,
  randomBytes,
} from "@ojcp/credentials-core";
import { createApp, DirectoryMandateKeySource, InMemoryIssuerStore, Issuer } from "@ojcp/issuer";
import { Hono } from "hono";
import { type Host, NOTICE, type Origins } from "./config.ts";
import type { EventBus, Inbox, SandboxClock } from "./events.ts";
import { OJCP_VERSION } from "./provider/provider.ts";

const DAY = 86_400;
export const EMPLOYER = { name: "Vandelay Industries", id: "reg:US-NY:SB-48151623" };

/** What Vandelay's systems hold about the employee: the same job, wherever it's kept. */
const RECORD = {
  organization: EMPLOYER,
  current: true,
  start: "2021-03-15",
  positionHistories: [
    { title: "Data Analyst", start: "2021-03-15", end: "2023-12-31" },
    { title: "Senior Data Analyst", start: "2024-01-08" },
  ],
};

export type SourceHost = Extract<Host, "hr" | "mdp" | "vandelay">;

export interface SourceProfile {
  host: SourceHost;
  name: string;
  /** What it is to Vandelay, in a phrase: "the HR platform Vandelay uses". */
  role: string;
  basis: "customer_records" | "own_records";
}

/** The three, in the order the candidate is offered them. */
export const SOURCES: readonly SourceProfile[] = [
  {
    host: "hr",
    name: "WorkSecond",
    role: `the HR platform ${EMPLOYER.name} uses`,
    basis: "customer_records",
  },
  {
    host: "mdp",
    name: "MDP",
    role: `${EMPLOYER.name}'s payroll provider`,
    basis: "customer_records",
  },
  {
    host: "vandelay",
    name: EMPLOYER.name,
    role: "your employer, from its own records",
    basis: "own_records",
  },
];

export class RecordSource {
  readonly profile: SourceProfile;
  readonly origin: string;
  readonly issuer: Issuer;
  readonly signer: GeneratedSigner;
  readonly signUntil: number;
  readonly #recordId: string;
  readonly #events: EventBus;
  readonly #employee: { name: string; email: string };
  /** Whether the employee has asked for their record here. */
  offered = false;

  private constructor(
    profile: SourceProfile,
    origin: string,
    issuer: Issuer,
    signer: GeneratedSigner,
    signUntil: number,
    recordId: string,
    events: EventBus,
    employee: { name: string; email: string },
  ) {
    this.profile = profile;
    this.origin = origin;
    this.issuer = issuer;
    this.signer = signer;
    this.signUntil = signUntil;
    this.#recordId = recordId;
    this.#events = events;
    this.#employee = employee;
  }

  static async create(
    profile: SourceProfile,
    deps: {
      origins: Origins;
      clock: SandboxClock;
      events: EventBus;
      inbox: Inbox;
      employee: { name: string; given: string; family: string; email: string; phone: string };
    },
  ): Promise<RecordSource> {
    const origin = deps.origins.origin(profile.host);
    const store = new InMemoryIssuerStore();
    const signer = await generateSigner("ES256");
    // RFC 0014 §5.1: a signing window, published with the key.
    const signUntil = deps.clock.now() + 365 * DAY;
    const issuer = await Issuer.create({
      issuer: origin,
      signer,
      signUntil,
      store,
      messenger: deps.inbox.as({
        actor: "hr",
        where: new URL(origin).host,
        name:
          profile.basis === "own_records" ? profile.name : `${profile.name} for ${EMPLOYER.name}`,
      }),
      mandateKeys: new DirectoryMandateKeySource(store),
      clients: [],
      statusLists: [1, 2].map((n) => `${origin}/status/${n}`),
      ojcpVersion: OJCP_VERSION,
      policyUri: `${origin}/practice`,
      consumerReportingAgency: false,
      adminToken: base64url(randomBytes(32)),
      cookieSecret: base64url(randomBytes(32)),
      displayName: profile.name,
      batchSize: 3,
      notice: NOTICE,
      now: () => deps.clock.now(),
    });
    const recordId = `${profile.host}-e1042`;
    await issuer.putRecord({
      id: recordId,
      type: "employment",
      basis: profile.basis,
      record: RECORD,
      holderName: { given_name: deps.employee.given, family_name: deps.employee.family },
      personalEmail: deps.employee.email,
      personalPhone: deps.employee.phone,
    });
    return new RecordSource(
      profile,
      origin,
      issuer,
      signer,
      signUntil,
      recordId,
      deps.events,
      deps.employee,
    );
  }

  /** The key a provider pins for this issuer (RFC 0013 §6.1). */
  pinnedKey(): { jwk: JWK; signUntil: number } {
    return { jwk: publicPart(this.signer.publicJwk), signUntil: this.signUntil };
  }

  app(): Hono {
    const app = new Hono();
    const { name, role, basis } = this.profile;
    // The employee is signed in to the portal (the sandbox stands in for single sign-on).
    app.get("/api/hr/me", (c) =>
      c.json({
        platform: name,
        role,
        employer: EMPLOYER,
        employee: this.#employee,
        record: RECORD,
        basis,
        issuer: this.origin,
      }),
    );
    app.post("/api/hr/wallet-offer", async (c) => {
      const { offerUri } = await this.issuer.sessionOffer(this.#recordId);
      this.offered = true;
      this.#events.emit({
        actor: "hr",
        where: new URL(this.origin).host,
        title:
          "Employee asked for their record in the portal: a single-use, 10-minute pre-authorized offer, returned only to their signed-in session",
        outcome: "info",
        detail: { basis, organization: EMPLOYER },
        say:
          basis === "own_records"
            ? `${name} offered a signed record of your job, from its own records, to your wallet.`
            : `${name}, ${role}, offered a signed record of your job to your wallet.`,
      });
      return c.json({ offerUri });
    });
    app.route("/", createApp(this.issuer));
    return app;
  }
}
