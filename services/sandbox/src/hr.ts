/**
 * The HR platform the candidate's employer uses: a Workday-class vendor
 * issuing RFC 0014 employment records from parts it already runs. It's a second
 * `services/issuer`, on its own origin, signing in its own name as a
 * `customer_records` issuer: its word about what its customer, Vandelay
 * Industries, recorded. An employee signed in to the portal can add their
 * record to a wallet at any time (RFC 0014 §4.1); leaving isn't required.
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
import { NOTICE, type Origins } from "./config.ts";
import type { EventBus, Inbox, SandboxClock } from "./events.ts";

const DAY = 86_400;
export const PLATFORM_NAME = "ExamplePeople";
export const EMPLOYER = { name: "Vandelay Industries", id: "reg:US-NY:SB-48151623" };
const RECORD_ID = "vandelay-e1042";

/** What the HR system holds about the employee. */
const RECORD = {
  organization: EMPLOYER,
  current: true,
  start: "2021-03-15",
  positionHistories: [
    { title: "Data Analyst", start: "2021-03-15", end: "2023-12-31" },
    { title: "Senior Data Analyst", start: "2024-01-08" },
  ],
};

export class HrPlatform {
  readonly origin: string;
  readonly issuer: Issuer;
  readonly signer: GeneratedSigner;
  readonly signUntil: number;
  readonly #events: EventBus;
  readonly #employee: { name: string; email: string };
  /** Whether the employee has asked for their record in the portal. */
  offered = false;

  private constructor(
    origin: string,
    issuer: Issuer,
    signer: GeneratedSigner,
    signUntil: number,
    events: EventBus,
    employee: { name: string; email: string },
  ) {
    this.origin = origin;
    this.issuer = issuer;
    this.signer = signer;
    this.signUntil = signUntil;
    this.#events = events;
    this.#employee = employee;
  }

  static async create(deps: {
    origins: Origins;
    clock: SandboxClock;
    events: EventBus;
    inbox: Inbox;
    employee: { name: string; given: string; family: string; email: string; phone: string };
  }): Promise<HrPlatform> {
    const origin = deps.origins.origin("hr");
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
        name: `${PLATFORM_NAME} for ${EMPLOYER.name}`,
      }),
      mandateKeys: new DirectoryMandateKeySource(store),
      clients: [],
      statusLists: [1, 2].map((n) => `${origin}/status/${n}`),
      ojcpVersion: "0.3",
      policyUri: `${origin}/practice`,
      consumerReportingAgency: false,
      adminToken: base64url(randomBytes(32)),
      cookieSecret: base64url(randomBytes(32)),
      displayName: PLATFORM_NAME,
      batchSize: 3,
      notice: NOTICE,
      now: () => deps.clock.now(),
    });
    await issuer.putRecord({
      id: RECORD_ID,
      type: "employment",
      basis: "customer_records",
      record: RECORD,
      holderName: { given_name: deps.employee.given, family_name: deps.employee.family },
      personalEmail: deps.employee.email,
      personalPhone: deps.employee.phone,
    });
    return new HrPlatform(origin, issuer, signer, signUntil, deps.events, deps.employee);
  }

  /** The key a provider pins for this issuer (RFC 0013 §6.1). */
  pinnedKey(): { jwk: JWK; signUntil: number } {
    return { jwk: publicPart(this.signer.publicJwk), signUntil: this.signUntil };
  }

  app(): Hono {
    const app = new Hono();
    // The employee is signed in to the portal (the sandbox stands in for single sign-on).
    app.get("/api/hr/me", (c) =>
      c.json({
        platform: PLATFORM_NAME,
        employer: EMPLOYER,
        employee: this.#employee,
        record: RECORD,
        basis: "customer_records",
        issuer: this.origin,
      }),
    );
    app.post("/api/hr/wallet-offer", async (c) => {
      const { offerUri } = await this.issuer.sessionOffer(RECORD_ID);
      this.offered = true;
      this.#events.emit({
        actor: "hr",
        where: new URL(this.origin).host,
        title:
          "Employee asked for their record in the portal: a single-use, 10-minute pre-authorized offer, returned only to their signed-in session",
        outcome: "info",
        detail: { basis: "customer_records", organization: EMPLOYER },
      });
      return c.json({ offerUri });
    });
    app.route("/", createApp(this.issuer));
    return app;
  }
}
