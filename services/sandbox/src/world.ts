/**
 * Builds the sandbox: every party with its own keys and origin, wired the way
 * real ones would be. `reset()` in main replaces the whole world.
 */
import { AgentKeyring } from "@ojcp/agent-wallet";
import {
  base64url,
  base64urlJson,
  type GeneratedSigner,
  generateSigner,
  type JWK,
  randomBytes,
  thumbprint,
} from "@ojcp/credentials-core";
import { createApp, DirectoryMandateKeySource, InMemoryIssuerStore, Issuer } from "@ojcp/issuer";
import type { Hono } from "hono";
import { SandboxAttester, SandboxListPublisher } from "./attesters.ts";
import { type Host, NOTICE, Origins, type SandboxConfig } from "./config.ts";
import { EventBus, Inbox, SandboxClock } from "./events.ts";
import { HrPlatform } from "./hr.ts";
import { VerifierCa } from "./pki.ts";
import { SandboxProvider } from "./provider/provider.ts";
import { WalletStepVerifier } from "./provider/wallet-step.ts";
import { walletApp } from "./wallet/app.ts";
import { SandboxWallet } from "./wallet/wallet.ts";

const DAY = 86_400;
export const CANDIDATE = {
  email: "jordan@example.com",
  phone: "+15555550100",
  name: "Jordan Lee",
  given: "Jordan",
  family: "Lee",
  resume_url: "https://files.example/jordan-lee.pdf",
};
export const CLIENT_ID = "sandbox-agent";

export interface CandidateDevice {
  signer: GeneratedSigner;
  /** The device key as a self-describing identifier (did:jwk), admitted by providers for action mandates. */
  iss: string;
}

export class SandboxWorld {
  readonly config: SandboxConfig;
  readonly origins: Origins;
  readonly clock = new SandboxClock();
  readonly events: EventBus;
  readonly inbox: Inbox;
  issuer!: Issuer;
  issuerStore!: InMemoryIssuerStore;
  keyring!: AgentKeyring;
  attestA!: SandboxAttester;
  attestB!: SandboxAttester;
  lists!: SandboxListPublisher;
  readonly providers = new Map<Host, SandboxProvider>();
  candidate!: CandidateDevice;
  hr!: HrPlatform;
  wallet!: SandboxWallet;
  /** Acme's wallet steps (RFC 0013). */
  acmeWalletSteps!: WalletStepVerifier;
  readonly apps = new Map<Host, Hono>();

  private constructor(config: SandboxConfig) {
    this.config = config;
    this.origins = new Origins(config);
    this.events = new EventBus(this.clock);
    this.inbox = new Inbox(this.events, this.clock);
  }

  static async create(config: SandboxConfig): Promise<SandboxWorld> {
    const world = new SandboxWorld(config);
    await world.#build();
    return world;
  }

  /** Moves sandbox time forward; status changes queued at the issuers apply at the next epoch. */
  async advance(seconds: number): Promise<void> {
    this.clock.advance(seconds);
    const applied = await this.tick();
    this.events.emit({
      actor: "sandbox",
      where: this.origins.domain,
      title: `Clock moved ${formatDuration(seconds)} ahead${applied ? `; issuers applied ${applied} status change(s)` : ""}`,
      outcome: "info",
    });
  }

  /** The hourly epoch: issuers publish queued status changes; providers refresh their copies. */
  async tick(): Promise<number> {
    const applied =
      (await this.issuer.status.applyEpoch()) + (await this.hr.issuer.status.applyEpoch());
    await this.acmeWalletSteps.refreshStatus();
    return applied;
  }

  async #build(): Promise<void> {
    const o = this.origins;
    const now = this.clock.now();

    // The agent platform's keys. Its mandate keys count as published 8 days before the sandbox started.
    this.keyring = await AgentKeyring.create(await generateSigner("EdDSA"));
    await this.keyring.generateMandateKeys(32, now + 365 * DAY, now - 8 * DAY);

    // The mandate issuer.
    this.issuerStore = new InMemoryIssuerStore();
    this.issuer = await Issuer.create({
      issuer: o.origin("issuer"),
      signer: await generateSigner("ES256"),
      signUntil: now + 365 * DAY,
      store: this.issuerStore,
      messenger: this.inbox.as({
        actor: "issuer",
        where: o.host("issuer"),
        name: "Permission service",
      }),
      mandateKeys: new DirectoryMandateKeySource(this.issuerStore, { now: () => this.clock.now() }),
      clients: [
        {
          clientId: CLIENT_ID,
          name: "JobGPT",
          agentId: o.agentId,
          redirectUris: [`${o.origin("agent")}/callback`],
          keyDirectory: o.origin("agent"),
          affiliated: false,
        },
      ],
      statusLists: [1, 2, 3].map((n) => `${o.origin("issuer")}/status/${n}`),
      ojcpVersion: "0.3",
      policyUri: `${o.origin("issuer")}/`,
      consumerReportingAgency: false,
      adminToken: base64url(randomBytes(32)),
      cookieSecret: base64url(randomBytes(32)),
      notice: NOTICE,
      // Run by Jordan's wallet provider: consent is a screen in the wallet app.
      consentUi: `${o.origin("wallet")}/permissions/{id}`,
      now: () => this.clock.now(),
    });
    // The issuer saw the agent's directory when its keys were published (RFC 0008 §3.4's 7-day rule).
    for (const key of this.keyring.eligibleMandateKeys(now, now)) {
      await this.issuerStore.put("observedKey", {
        id: `${o.agentId}#${key.thumbprint}`,
        jwk: key.signer.publicJwk as JWK,
        until: key.until,
        firstSeen: now - 8 * DAY,
      });
    }
    this.apps.set("issuer", createApp(this.issuer));

    // Attesters and the trust list (RFC 0010).
    this.attestA = await SandboxAttester.create(
      o.origin("attestA"),
      "Sandbox KYB Co.",
      "sandbox:kyb-co",
      "A know-your-business check, the kind a bank runs: who the company legally is, and which careers sites it has authorised to post its jobs.",
      this.clock,
      this.events,
    );
    this.attestB = await SandboxAttester.create(
      o.origin("attestB"),
      "Sandbox Business Registry",
      "sandbox:registry",
      "A lookup in the company register, the kind a state's Secretary of State keeps: the company is registered and in good standing.",
      this.clock,
      this.events,
    );
    this.lists = await SandboxListPublisher.create(o.origin("lists"), this.clock, this.events);
    this.lists.list(this.attestA, ["legal_entity", "hosted_employer"]);
    this.lists.list(this.attestB, ["business_registration"]);
    this.apps.set("attestA", this.attestA.app());
    this.apps.set("attestB", this.attestB.app());
    this.apps.set("lists", this.lists.app());

    // The HR platform the candidate's employer uses (RFC 0014), and the candidate's wallet.
    this.hr = await HrPlatform.create({
      origins: o,
      clock: this.clock,
      events: this.events,
      inbox: this.inbox,
      employee: CANDIDATE,
    });
    this.apps.set("hr", this.hr.app());
    // Wallets trust CAs that vouch for verifiers' request certificates (RFC 0013 §4.2).
    const verifierCa = await VerifierCa.create("OJCP sandbox verifier CA (test only)");
    this.wallet = new SandboxWallet({
      host: o.host("wallet"),
      anchors: [verifierCa.anchor()],
      clock: this.clock,
      events: this.events,
    });
    this.apps.set(
      "wallet",
      walletApp(this.wallet, {
        issuer: this.issuer,
        owner: { email: CANDIDATE.email },
        events: this.events,
        host: o.host("wallet"),
      }),
    );
    // The candidate's own device key, bound to their accounts at providers.
    const device = await generateSigner("ES256");
    this.candidate = { signer: device, iss: `did:jwk:${base64urlJson(device.publicJwk)}` };

    // Providers.
    const common = {
      issuerOrigin: o.origin("issuer"),
      candidateKeys: () => [
        { iss: this.candidate.iss, jwk: this.candidate.signer.publicJwk as JWK },
      ],
      clock: this.clock,
      events: this.events,
      notice: NOTICE,
    };
    const statusTokens = async () => [
      await this.attestA.statusToken(),
      await this.attestB.statusToken(),
    ];
    const identityClaims = (legal_name: string) => ({
      a: { legal_name, jurisdiction: "US-DE", checked_at: isoDay(now) },
      b: {
        legal_name,
        jurisdiction: "US-DE",
        registry: "Sandbox Registry of Companies",
        registration_number: `SB-${legal_name.length}${legal_name.charCodeAt(0)}`,
        registration_status: "active",
        checked_at: isoDay(now),
      },
    });

    let acmeStaple: string[] = [];
    this.acmeWalletSteps = new WalletStepVerifier({
      origin: o.origin("acme"),
      employerName: "Acme Corporation",
      request: await verifierCa.issue(o.host("acme"), "Acme Corporation"),
      // Acme's issuer policy (RFC 0013 §6.1): the HR platform, pinned by key, for its customers' records.
      issuers: [
        {
          iss: this.hr.origin,
          keys: [this.hr.pinnedKey()],
          profile: "baseline",
          types: ["employment"],
          basis: ["own_records", "customer_records"],
        },
      ],
      statusLists: async () => [...this.hr.issuer.config.statusLists],
      messenger: this.inbox.as({
        actor: "provider",
        where: o.host("acme"),
        name: "Acme Corporation careers",
      }),
      clock: this.clock,
      events: this.events,
    });
    // RFC 0013 §6.2: Acme keeps its copy of the HR platform's status lists fresh
    // on a schedule (startup, then each hourly tick), never when someone applies,
    // so the HR platform can't line its fetches up with an application.
    await this.acmeWalletSteps.refreshStatus();
    const acme = await SandboxProvider.create({
      ...common,
      origin: o.origin("acme"),
      name: "Acme Corp Careers",
      employers: [
        { employer: { ojcp_employer_id: "acme-corp", name: "Acme Corporation" }, kind: "acme" },
      ],
      staple: async () => ({ attestations: acmeStaple, statusTokens: await statusTokens() }),
      walletSteps: this.acmeWalletSteps,
    });
    const acmeClaims = identityClaims("Acme Corporation");
    acmeStaple = [
      await this.attestA.issue("legal_entity", acme.subject, acme.identityThumbprint, acmeClaims.a),
      await this.attestB.issue(
        "business_registration",
        acme.subject,
        acme.identityThumbprint,
        acmeClaims.b,
      ),
    ];

    // A lookalike: same name, own key, and copies of Acme's attestations.
    const lookalike = await SandboxProvider.create({
      ...common,
      origin: o.origin("lookalike"),
      name: "Acme Corp Careers",
      employers: [
        { employer: { ojcp_employer_id: "acme-corp", name: "Acme Corporation" }, kind: "acme" },
      ],
      staple: async () => ({ attestations: acmeStaple, statusTokens: await statusTokens() }),
    });

    // An ATS hosting two employers on one origin, and a tenant site under its host with the same identity key.
    const atsIdentity = await generateSigner("ES256");
    let atsStaple: string[] = [];
    let globexStaple: string[] = [];
    const ats = await SandboxProvider.create({
      ...common,
      origin: o.origin("ats"),
      name: "ExampleATS",
      identity: atsIdentity,
      employers: [
        { employer: { ojcp_employer_id: "globex", name: "Globex Corporation" }, kind: "globex" },
        { employer: { ojcp_employer_id: "initech", name: "Initech" }, kind: "initech" },
      ],
      staple: async () => ({ attestations: atsStaple, statusTokens: await statusTokens() }),
    });
    const globex = await SandboxProvider.create({
      ...common,
      origin: o.origin("globex"),
      name: "Globex Careers (hosted by ExampleATS)",
      identity: atsIdentity,
      employers: [
        { employer: { ojcp_employer_id: "globex", name: "Globex Corporation" }, kind: "globex" },
      ],
      staple: async () => ({ attestations: globexStaple, statusTokens: await statusTokens() }),
    });
    const atsClaims = identityClaims("ExampleATS Inc.");
    atsStaple = [
      await this.attestA.issue("legal_entity", ats.subject, ats.identityThumbprint, atsClaims.a),
      await this.attestB.issue(
        "business_registration",
        ats.subject,
        ats.identityThumbprint,
        atsClaims.b,
      ),
    ];
    globexStaple = [
      ...atsStaple,
      await this.attestA.issue("hosted_employer", globex.subject, globex.identityThumbprint, {
        employer_legal_name: "Globex Corporation",
        employer_jurisdiction: "US-NY",
        employer_id: "globex",
        checked_at: isoDay(now),
      }),
    ];

    for (const [host, provider] of [
      ["acme", acme],
      ["lookalike", lookalike],
      ["ats", ats],
      ["globex", globex],
    ] as const) {
      this.providers.set(host, provider);
      this.apps.set(host, provider.app());
    }
    this.events.emit({
      actor: "sandbox",
      where: o.domain,
      title:
        "Sandbox started: an HR platform, a wallet, a permission service, two attesters, a trust list, four job sites and an assistant, each on its own origin",
      outcome: "info",
    });
  }

  async listPin(): Promise<string> {
    return this.lists.pin();
  }

  thumbprintOf(jwk: JWK): Promise<string> {
    return thumbprint(jwk);
  }
}

function isoDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function formatDuration(seconds: number): string {
  if (seconds % DAY === 0) return `${seconds / DAY} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  return `${seconds} s`;
}
