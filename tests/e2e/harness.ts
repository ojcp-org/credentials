/**
 * An issuer, an agent platform and an OJCP provider wired together in-process
 * with one controllable clock. Nothing is mocked except message delivery and
 * the network: every request goes through the real HTTP handlers.
 */
import {
  AgentKeyring,
  beginStandingMandate,
  completeStandingMandate,
  createSignedFetch,
  InMemoryHolderStore,
  StandingMandateHolder,
  type StandingMandateProposal,
  type TrustResolver,
} from "@ojcp/agent-wallet";
import {
  type ActionStatement,
  AgentDeclaration,
  AgentSignatureError,
  actionStatement,
  base64url,
  bindKey,
  bindsByNamespace,
  type CandidateElement,
  ConsentScope,
  candidateDataDigest,
  type DisclosedClaim,
  fromUtf8,
  type GeneratedSigner,
  generateSigner,
  type JobPostingFacts,
  type JWK,
  ONET_SOC_2019,
  presentSdJwt,
  randomBytes,
  type Signer,
  signRequest,
  Tool,
  type UserMandatesPolicy,
  utf8,
  verifyRequest,
} from "@ojcp/credentials-core";
import {
  createApp,
  DirectoryMandateKeySource,
  InMemoryIssuerStore,
  Issuer,
  type Messenger,
} from "@ojcp/issuer";
import {
  InMemoryLedger,
  type MandatePolicy,
  MandateRejected,
  type StandingMandateDecision,
  StatusListCache,
  submittedContact,
  type VerifiedAgent,
  verifyStandingMandate,
} from "@ojcp/verifier";
import { z } from "zod";

const ToolCall = z.object({
  params: z.object({
    name: Tool,
    arguments: z.looseObject({
      agent_declaration: AgentDeclaration,
      candidate_context: z.looseObject({ consent_scope: ConsentScope.optional() }).optional(),
    }),
  }),
});

import type { Hono } from "hono";

export const ISSUER = "https://mandates.example";
export const AGENT_ORIGIN = "https://assistant.northstar.ai";
export const AGENT_ID = "ai.northstar.assistant";
export const PROVIDER = "https://careers.acme.com";
export const CLIENT_ID = "northstar";
export const REDIRECT = "https://assistant.northstar.ai/callback";

/** 2026-10-13T12:00:00Z */
export const START = 1_791_892_800;

export class Clock {
  now = START;
  advance(seconds: number): void {
    this.now += seconds;
  }
}

export class CapturingMessenger implements Messenger {
  readonly sent: Array<{
    to: { email: string } | { phone: string };
    subject: string;
    text: string;
  }> = [];
  async send(
    to: { email: string } | { phone: string },
    message: { subject: string; text: string },
  ): Promise<void> {
    this.sent.push({ to, ...message });
  }
  lastCodeFor(contact: string): string {
    const m = [...this.sent]
      .reverse()
      .find(
        (s) =>
          ("email" in s.to ? s.to.email : s.to.phone) === contact && /code is \d{6}/.test(s.text),
      );
    const code = m?.text.match(/code is (\d{6})/)?.[1];
    if (!code) throw new Error(`no code sent to ${contact}`);
    return code;
  }
}

export function job(
  overrides: Partial<JobPostingFacts> & { ojcp_id: string; employerId?: string },
): JobPostingFacts {
  const { employerId, ...rest } = overrides;
  return {
    occupationalCategory: [
      { "@type": "CategoryCode", codeValue: "15-2051.00", inCodeSet: ONET_SOC_2019 },
    ],
    jobLocation: {
      "@type": "Place",
      address: { addressCountry: "US", addressRegion: "NY", addressLocality: "New York" },
    },
    remote_policy: "hybrid",
    baseSalary: { currency: "USD", minValue: 132_000, maxValue: 150_000, unitText: "YEAR" },
    employer: { ojcp_employer_id: employerId ?? "acme-corp" },
    ...rest,
  };
}

export const PROPOSAL: StandingMandateProposal = {
  candidate: [{ email: "jordan@example.com" }],
  scope: {
    job_families: ["15-2051"],
    locations: [{ addressCountry: "US", addressRegion: "NY" }],
    remote_policy: ["hybrid", "remote"],
    salary_floor: { value: 125_000, currency: "USD", unitText: "YEAR" },
  },
  per_employer: 2,
  applications_total: 40,
  actions: ["search_jobs", "get_job_detail", "begin_application", "submit_application"],
  consent_scope: "application_prefill",
  provider_trust_floor: "verified",
  months: 2,
};

export const MANIFEST: UserMandatesPolicy = {
  types: ["action", "standing"],
  required_for: ["submit_application"],
  action_mandate_required_for: ["accept_terms", "accept_offer"],
  standing: {
    vct_values: ["https://spec.ojcp.dev/vct/standing-mandate/v1"],
    max_lifetime_months: 3,
    max_per_employer: 2,
    max_breadth: "narrow",
    taxonomies: [ONET_SOC_2019],
  },
  action: { max_lifetime_seconds: 600 },
};

interface Session {
  application_id: string;
  mandate_nonce: string;
  employerId: string;
  job: JobPostingFacts;
  binding_actions?: unknown[];
  candidate?: CandidateElement;
  outcome?: unknown;
}

export interface ToolResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { error_code: string; details?: { reason: string } };
  /** The internal failure class, for assertions only; never on the wire. */
  kind?: string;
}

/**
 * A minimal OJCP provider: verifies the RFC 9421 signature and agent binding,
 * then the standing mandate, for search_jobs, begin_application and
 * submit_application.
 */
export class Provider {
  readonly ledger = new InMemoryLedger();
  readonly sessions = new Map<string, Session>();
  readonly jobs = new Map<string, JobPostingFacts>();
  readonly #seen = new Set<string>();
  readonly #secrets = new Map<string, Uint8Array>();
  /** Set per test to exercise binding_actions handling. */
  bindingActions: unknown[] | undefined = [];
  policy: MandatePolicy;
  readonly clock: Clock;
  readonly directory: () => { keys: Array<JWK & { kid: string }> };

  constructor(
    clock: Clock,
    directory: () => { keys: Array<JWK & { kid: string }> },
    issuerKeys: JWK[],
    issuerFetch: (url: string) => Promise<Response>,
    manifest: UserMandatesPolicy = MANIFEST,
  ) {
    this.clock = clock;
    this.directory = directory;
    this.policy = {
      origin: PROVIDER,
      manifest,
      issuers: [
        { iss: ISSUER, keys: issuerKeys.map((jwk) => ({ jwk })), types: ["standing", "action"] },
      ],
      ojcpVersions: ["0.3"],
      status: new StatusListCache({ fetch: issuerFetch, now: () => clock.now }),
      ledger: this.ledger,
      countSecret: async (employerId) => {
        let s = this.#secrets.get(employerId);
        if (!s) {
          s = randomBytes(32);
          this.#secrets.set(employerId, s);
        }
        return s;
      },
      now: () => clock.now,
    };
  }

  /** The `fetch` the agent's signed fetch calls. */
  readonly fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    const headers = new Headers(init?.headers);
    try {
      const verified = await verifyRequest(
        { method: init?.method ?? "GET", url: String(url), headers, body },
        {
          resolveKey: async (origin, kid) =>
            origin === AGENT_ORIGIN ? this.directory().keys.find((k) => k.kid === kid) : undefined,
          seenNonce: async (kid, nonce) => {
            const key = `${kid}:${nonce}`;
            if (this.#seen.has(key)) return true;
            this.#seen.add(key);
            return false;
          },
          now: this.clock.now,
        },
      );
      const message = ToolCall.parse(JSON.parse(fromUtf8(body)));
      const declaration = message.params.arguments.agent_declaration;
      if (!bindsByNamespace(declaration.agent_id, verified.signatureAgent))
        throw new AgentSignatureError("agent_identity_mismatch", "agent_id not bound");
      const agent: VerifiedAgent = { ...verified, agent_id: declaration.agent_id };
      const result = await this.#call(
        message.params.name,
        message.params.arguments,
        agent,
        declaration.user_mandate,
      );
      return Response.json(result);
    } catch (error) {
      if (error instanceof AgentSignatureError)
        return Response.json({ ok: false, error: { error_code: error.code } }, { status: 401 });
      if (error instanceof MandateRejected)
        return Response.json({ ok: false, error: error.toToolError(), kind: error.kind });
      throw error;
    }
  };

  async #call(
    tool: Tool,
    args: z.infer<typeof ToolCall>["params"]["arguments"],
    agent: VerifiedAgent,
    mandate: string | undefined,
  ): Promise<ToolResult> {
    if (!mandate) throw new MandateRejected("missing", "no mandate");
    if (tool === "search_jobs") {
      await verifyStandingMandate(this.policy, { presentation: mandate, agent, tool });
      return { ok: true, result: { jobs: [...this.jobs.values()].map((j) => j.ojcp_id) } };
    }
    if (tool === "begin_application") {
      const job = this.jobs.get(String(args.job_id));
      if (!job) throw new Error("unknown job");
      const employerId = job.employer?.ojcp_employer_id as string;
      const decision = await verifyStandingMandate(this.policy, {
        presentation: mandate,
        agent,
        tool,
        job,
        employerId,
        statement: await this.#statement(tool, job, agent.keyid, args),
        ...(args.candidate_context?.consent_scope
          ? { consentScope: args.candidate_context.consent_scope }
          : {}),
      });
      const session: Session = {
        application_id: `app_${base64url(randomBytes(9))}`,
        mandate_nonce: `mn_${base64url(randomBytes(18))}`,
        employerId,
        job,
        ...(this.bindingActions ? { binding_actions: this.bindingActions } : {}),
        ...(decision.candidate ? { candidate: decision.candidate } : {}),
      };
      this.sessions.set(session.application_id, session);
      return {
        ok: true,
        result: {
          application_id: session.application_id,
          mandate_nonce: session.mandate_nonce,
          ...(session.binding_actions ? { binding_actions: session.binding_actions } : {}),
        },
      };
    }
    if (tool === "submit_application") {
      const session = this.sessions.get(String(args.application_id));
      if (!session) throw new Error("unknown application");
      const applicationData = args.application_data as Record<string, unknown> | undefined;
      const decision: StandingMandateDecision = await verifyStandingMandate(this.policy, {
        presentation: mandate,
        agent,
        tool,
        job: session.job,
        employerId: session.employerId,
        statement: await this.#statement(tool, session.job, agent.keyid, args, session),
        session: {
          mandate_nonce: session.mandate_nonce,
          ...(session.binding_actions ? { binding_actions: session.binding_actions } : {}),
          ...(session.candidate ? { candidate: session.candidate } : {}),
        },
        submittedContact: submittedContact(args),
        hasEeo: applicationData?.eeo !== undefined,
      });
      if (decision.priorOutcome !== undefined)
        return { ok: true, result: { ...(decision.priorOutcome as object), retried: true } };
      const outcome = { application_id: session.application_id, status: "submitted" };
      const committed = await decision.commit?.(outcome);
      if (committed?.status === "limit_reached")
        throw new MandateRejected("limit_reached", "per_employer limit reached");
      if (committed?.status === "nonce_consumed")
        throw new MandateRejected("replayed", "nonce consumed");
      if (committed?.status === "duplicate")
        return { ok: true, result: { ...(committed.outcome as object), retried: true } };
      return { ok: true, result: outcome };
    }
    throw new Error(`tool ${tool} not served`);
  }

  /** The action statement rebuilt from the provider's own state (spec *Action Statement*). */
  async #statement(
    tool: Tool,
    job: JobPostingFacts,
    keyid: string,
    args: Record<string, unknown>,
    session?: Session,
  ): Promise<ActionStatement> {
    const request = {
      ...(args.application_data !== undefined ? { application_data: args.application_data } : {}),
      ...(args.candidate_context !== undefined
        ? { candidate_context: args.candidate_context }
        : {}),
    };
    const consent = z
      .object({ consent_scope: ConsentScope.optional() })
      .safeParse(args.candidate_context ?? {});
    return actionStatement({
      ojcp_version: "0.3",
      resource_server: PROVIDER,
      ...(job.employer?.ojcp_employer_id
        ? { employer: { ojcp_employer_id: job.employer.ojcp_employer_id } }
        : {}),
      tool,
      job_id: job.ojcp_id,
      agent_id: AGENT_ID,
      agent_key_thumbprint: keyid,
      ...(session
        ? {
            application_id: session.application_id,
            mandate_nonce: session.mandate_nonce,
            candidate_data_digest: await candidateDataDigest(request),
          }
        : {
            ...(request.candidate_context
              ? {
                  candidate_data_digest: await candidateDataDigest({
                    candidate_context: request.candidate_context,
                  }),
                }
              : {}),
            ...(consent.success && consent.data.consent_scope
              ? { consent_scope: consent.data.consent_scope }
              : {}),
          }),
    });
  }
}

export interface World {
  clock: Clock;
  messenger: CapturingMessenger;
  issuer: Issuer;
  issuerApp: Hono;
  issuerFetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  keyring: AgentKeyring;
  holder: StandingMandateHolder;
  holderStore: InMemoryHolderStore;
  provider: Provider;
  trust: { tier: "unverified" | "verified" | "audited"; source: "derived" | "pinned_index" };
  agentFetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  issuerSigner: GeneratedSigner;
}

export async function createWorld(
  options: { manifest?: UserMandatesPolicy; consentUi?: string } = {},
): Promise<World> {
  const clock = new Clock();
  const messenger = new CapturingMessenger();
  const store = new InMemoryIssuerStore();
  const keyring = await AgentKeyring.create(await generateSigner("EdDSA"));
  // Mandate keys published 8 days ago, valid for a year.
  await keyring.generateMandateKeys(32, START + 365 * 86_400, START - 8 * 86_400);
  const directoryFetch = (async () => keyring.directoryResponse()) as unknown as typeof fetch;
  const mandateKeys = new DirectoryMandateKeySource(store, {
    fetch: directoryFetch,
    now: () => clock.now,
  });
  const issuerSigner = await generateSigner("ES256");
  const issuer = await Issuer.create({
    issuer: ISSUER,
    signer: issuerSigner,
    signUntil: START + 365 * 86_400,
    store,
    messenger,
    mandateKeys,
    clients: [
      {
        clientId: CLIENT_ID,
        name: "Northstar Assistant",
        agentId: AGENT_ID,
        redirectUris: [REDIRECT],
        keyDirectory: AGENT_ORIGIN,
        affiliated: false,
      },
    ],
    statusLists: [`${ISSUER}/status/1`, `${ISSUER}/status/2`, `${ISSUER}/status/3`],
    ojcpVersion: "0.3",
    policyUri: `${ISSUER}/practice`,
    consumerReportingAgency: false,
    adminToken: "a".repeat(40),
    cookieSecret: "c".repeat(40),
    now: () => clock.now,
    ...(options.consentUi ? { consentUi: options.consentUi } : {}),
  });
  // The issuer observed the directory when the keys were published.
  clock.now = START - 8 * 86_400;
  await mandateKeys.mandateKeys(issuer.config.clients[0]!);
  clock.now = START;

  const issuerApp = createApp(issuer);
  const issuerFetch = async (url: string | URL, init?: RequestInit) =>
    issuerApp.request(String(url), init);
  const trust: World["trust"] = { tier: "verified", source: "derived" };
  const trustResolver: TrustResolver = { effectiveTier: async () => ({ ...trust }) };
  const holderStore = new InMemoryHolderStore();
  const holder = new StandingMandateHolder({
    keyring,
    agentId: AGENT_ID,
    trust: trustResolver,
    store: holderStore,
    now: () => clock.now,
  });
  const provider = new Provider(
    clock,
    () => keyring.directory(),
    [issuerSigner.publicJwk],
    (url) => issuerFetch(url),
    options.manifest,
  );
  const agentFetch = createSignedFetch({
    keyring,
    signatureAgent: AGENT_ORIGIN,
    fetch: provider.fetch,
    now: () => clock.now,
  });
  return {
    clock,
    messenger,
    issuer,
    issuerApp,
    issuerFetch,
    keyring,
    holder,
    holderStore,
    provider,
    trust,
    agentFetch,
    issuerSigner,
  };
}

/** Runs the whole consent flow as the user would, returning the batch's refresh token. */
export async function obtainMandate(
  world: World,
  proposal: StandingMandateProposal = PROPOSAL,
  narrowing: Record<string, string | string[]> = {},
): Promise<string | undefined> {
  const start = await beginStandingMandate({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    proposal,
    fetch: world.issuerFetch,
  });
  const consent = await world.issuerFetch(start.url);
  if (consent.status !== 200)
    throw new Error(`consent page: ${consent.status} ${await consent.text()}`);
  const html = await consent.text();
  const pendingId = html.match(/\/authorize\/([A-Za-z0-9_-]+)\/approve/)?.[1];
  if (!pendingId) throw new Error("no pending id on consent page");
  await world.issuerFetch(`${ISSUER}/authorize/${pendingId}/send-codes`, {
    method: "POST",
    body: new URLSearchParams(),
  });
  const form = new URLSearchParams();
  for (const c of proposal.candidate) {
    const contact = "email" in c ? c.email : c.phone;
    form.set(`code:${JSON.stringify(c)}`, world.messenger.lastCodeFor(contact));
  }
  for (const f of proposal.scope.job_families) form.append("job_families", f);
  for (const l of proposal.scope.locations) form.append("locations", JSON.stringify(l));
  for (const r of proposal.scope.remote_policy) form.append("remote_policy", r);
  for (const a of proposal.actions) form.append("actions", a);
  form.set("per_employer", String(proposal.per_employer));
  form.set("applications_total", String(proposal.applications_total));
  for (const [k, v] of Object.entries(narrowing)) {
    form.delete(k);
    for (const value of [v].flat()) form.append(k, value);
  }
  form.set("decision", "approve");
  const approved = await world.issuerFetch(`${ISSUER}/authorize/${pendingId}/approve`, {
    method: "POST",
    body: form,
  });
  if (approved.status !== 303)
    throw new Error(`approve: ${approved.status} ${await approved.text()}`);
  const redirect = new URL(approved.headers.get("location") as string);
  if (redirect.searchParams.get("state") !== start.state) throw new Error("state mismatch");
  const obtained = await completeStandingMandate({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    code: redirect.searchParams.get("code") as string,
    codeVerifier: start.codeVerifier,
    keyring: world.keyring,
    holder: world.holder,
    fetch: world.issuerFetch,
    now: () => world.clock.now,
  });
  return obtained.refreshToken;
}

/** Calls a tool at the provider through the agent's signed fetch. */
export async function callTool(
  world: World,
  tool: Tool,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  const response = await world.agentFetch(`${PROVIDER}/ojcp/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return (await response.json()) as ToolResult;
}

/** Calls a tool with a request signed by an explicit key and nonce (bypassing the signed fetch's choice). */
export async function callToolSignedBy(
  world: World,
  signer: Signer,
  tool: Tool,
  args: Record<string, unknown>,
  nonce?: string,
): Promise<ToolResult> {
  const body = utf8(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  );
  const url = `${PROVIDER}/ojcp/mcp`;
  const signed = await signRequest(
    { method: "POST", url, headers: new Headers({ "content-type": "application/json" }), body },
    { signer, signatureAgent: AGENT_ORIGIN, now: world.clock.now, ...(nonce ? { nonce } : {}) },
  );
  const response = await world.provider.fetch(url, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  return (await response.json()) as ToolResult;
}

/** The credentials of the agent's current batch. */
export async function heldCredentials(
  world: World,
): Promise<Array<{ compact: string; keyThumbprint: string }>> {
  const batches = await world.holderStore.batches();
  return batches.flatMap((b) =>
    b.credentials.map((c) => ({ compact: c.compact, keyThumbprint: c.keyThumbprint })),
  );
}

/**
 * Presents a credential exactly as told, with no holder-side checks: what a
 * faulty or hostile agent could send.
 */
export async function rawPresentation(
  world: World,
  credential: { compact: string; keyThumbprint: string },
  select: (claim: DisclosedClaim) => boolean,
  kb: { aud?: string; nonce: string; ojcp_action?: string },
  kbSigner?: Signer,
): Promise<string> {
  const signer = kbSigner ?? world.keyring.signerFor(credential.keyThumbprint);
  if (!signer) throw new Error("no signer");
  return bindKey(
    await presentSdJwt(credential.compact, select),
    {
      aud: kb.aud ?? PROVIDER,
      nonce: kb.nonce,
      iat: world.clock.now,
      ...(kb.ojcp_action ? { ojcp_action: kb.ojcp_action } : {}),
    },
    signer,
  );
}
