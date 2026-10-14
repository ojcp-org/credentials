/**
 * The demo agent: an agent platform built only from the public packages. It
 * gets a standing mandate through the issuer's consent page, derives each
 * provider's trust tier from a pinned trust list, and applies through signed
 * MCP calls. Everything it does goes to the timeline.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  beginStandingMandate,
  completeStandingMandate,
  type Exercise,
  InMemoryHolderStore,
  presentActionMandate,
  refreshStandingMandate,
  StandingMandateHolder,
  type StandingMandateProposal,
  StandingMandateRefusal,
  statementForApproval,
} from "@ojcp/agent-wallet";
import { connectOjcpProvider } from "@ojcp/agent-wallet/mcp";
import {
  type BindingAction,
  BindingActions,
  base64url,
  bindingActionsDigest,
  isOjcpError,
  isRecord,
  issueSdJwt,
  JobPostingFacts,
  type JWK,
  parseSdJwt,
  randomBytes,
  thumbprint,
} from "@ojcp/credentials-core";
import {
  type DerivedTier,
  DerivedTrustResolver,
  describeRecipient,
  type EffectiveTier,
  TrustLists,
} from "@ojcp/trust";
import { StatusListCache } from "@ojcp/verifier";
import { z } from "zod";
import type { Host } from "../config.ts";
import { OJCP_VERSION } from "../provider/provider.ts";
import { claimLabel, isPermittedEmploymentClaim } from "../wallet/claims.ts";
import { CANDIDATE, CLIENT_ID, type SandboxWorld } from "../world.ts";

/** The mandate the demo agent proposes for a candidate. */
export function proposalFor(email: string): StandingMandateProposal {
  return { ...PROPOSAL_TERMS, candidate: [{ email }] };
}

const PROPOSAL_TERMS: Omit<StandingMandateProposal, "candidate"> = {
  scope: {
    job_families: ["15-2051"],
    locations: [{ addressCountry: "US", addressRegion: "NY" }],
    remote_policy: ["hybrid", "remote"],
    salary_floor: { value: 125_000, currency: "USD", unitText: "YEAR" },
  },
  per_employer: 2,
  applications_total: 20,
  actions: [
    "search_jobs",
    "get_job_detail",
    "begin_application",
    "submit_application",
    "check_application_status",
  ],
  consent_scope: "application_prefill",
  provider_trust_floor: "verified",
  months: 2,
};

export const PROVIDER_HOSTS: Host[] = ["acme", "ats", "globex", "lookalike"];

export interface ToolOutcome {
  ok: boolean;
  result: Record<string, unknown>;
}

export interface PendingApproval {
  id: string;
  provider: Host;
  job: JobPostingFacts;
  employerId: string;
  session: { application_id: string; mandate_nonce: string };
  bindingActions: BindingAction[];
}

/** A posting's employer as the agent reads it: the id from the wire type, plus the name schema.org adds. */
const PostingEmployer = z
  .looseObject({ ojcp_employer_id: z.string().optional(), name: z.string().optional() })
  .catch({});

/** The employer of a posting, as `confirmEmployer` and the candidate's screens want it. */
export function postingEmployer(job: JobPostingFacts): {
  ojcp_employer_id?: string;
  name?: string;
} {
  const e = PostingEmployer.parse(job.employer ?? {});
  return {
    ...(e.ojcp_employer_id ? { ojcp_employer_id: e.ojcp_employer_id } : {}),
    ...(e.name ? { name: e.name } : {}),
  };
}

/** The employer's name for people, or its id when the posting has no name. */
export const employerName = (job: JobPostingFacts): string => {
  const e = postingEmployer(job);
  return e.name ?? e.ojcp_employer_id ?? "the employer";
};

/** An RFC 0013 wallet step as the agent may relay it (§4.1). */
const WalletStep = z.looseObject({
  step_id: z.string(),
  verifier_id: z.string(),
  proof_delivery: z.string(),
  verification_url: z.url({ protocol: /^https$/ }),
  verifier_name: z.string().optional(),
  human_required: z.literal(true),
  wallet_request: z.object({
    purpose: z.string().max(500),
    application_ref: z.string().regex(/^[A-Z0-9]{4,6}$/),
    masked_contact: z.string().optional(),
    dcql_query: z.object({
      credentials: z
        .array(
          z.object({
            claims: z
              .array(
                z.object({
                  path: z.array(z.union([z.string(), z.number(), z.null()])).min(1),
                }),
              )
              .min(1),
          }),
        )
        .min(1),
    }),
    alternative: z.enum(["post_submission", "verifier"]),
  }),
});

/** A wallet step the candidate must complete on the provider's page. */
export interface PendingVerification {
  id: string;
  provider: Host;
  job: JobPostingFacts;
  employerId: string;
  session: { application_id: string; mandate_nonce: string };
  url: string;
  purpose: string;
  ref: string;
  maskedContact: string | undefined;
  /** What the wallet will be asked for, in plain words. */
  asks: string[];
  alternative: "post_submission" | "verifier";
}

export type ApplyOutcome =
  | { status: "submitted"; application_id: string; text: string }
  | { status: "needs_approval"; approval: PendingApproval; text: string }
  | { status: "needs_verification"; verification: PendingVerification; text: string }
  | { status: "refused_by_agent"; reason: string; text: string }
  | { status: "refused_by_provider"; error: Record<string, unknown>; text: string };

export class SandboxAgent {
  readonly world: SandboxWorld;
  readonly store = new InMemoryHolderStore();
  readonly holder: StandingMandateHolder;
  readonly lists: TrustLists;
  readonly trust: DerivedTrustResolver;
  readonly approvals = new Map<string, PendingApproval>();
  readonly verifications = new Map<string, PendingVerification>();
  readonly #clients = new Map<string, Client>();
  readonly #jobs = new Map<string, JobPostingFacts[]>();
  /** Open authorization requests, by OAuth state: a second proposal doesn't lose the first. */
  readonly #pending = new Map<string, string>();
  #refreshToken: string | undefined;
  /** The consent screen the candidate was sent to, while a proposal is open. */
  consentUrl: string | undefined;
  #lastSubmit:
    | {
        provider: Host;
        job: JobPostingFacts;
        employerId: string;
        session: { application_id: string; mandate_nonce: string };
      }
    | undefined;
  readonly email: string;
  readonly proposal: StandingMandateProposal;

  private constructor(world: SandboxWorld, listPin: string, email: string) {
    this.world = world;
    this.email = email;
    this.proposal = proposalFor(email);
    this.lists = new TrustLists([{ name: "Sandbox trust list", pins: [listPin] }]);
    this.trust = new DerivedTrustResolver({
      lists: this.lists,
      fetch: (url, init) => fetch(url, init),
      now: () => world.clock.now(),
    });
    this.holder = new StandingMandateHolder({
      keyring: world.keyring,
      agentId: world.origins.agentId,
      store: this.store,
      now: () => world.clock.now(),
      trust: { effectiveTier: (origin) => this.effectiveTier(origin) },
    });
  }

  /** `email` is the candidate this agent acts for; conformance runs use a fresh one each time. */
  static async create(world: SandboxWorld, email: string = CANDIDATE.email): Promise<SandboxAgent> {
    return new SandboxAgent(world, await world.lists.pin(), email);
  }

  get origin(): string {
    return this.world.origins.origin("agent");
  }

  #emit(
    outcome: "ok" | "refused" | "info",
    title: string,
    detail?: Record<string, unknown>,
    say?: string,
  ): void {
    this.world.events.emit({
      actor: "agent",
      where: this.world.origins.host("agent"),
      title,
      outcome,
      ...(detail ? { detail } : {}),
      ...(say ? { say } : {}),
    });
  }

  // ── Trust (RFC 0010) ──────────────────────────────────────────────────────

  /** Fetches the pinned trust list over HTTPS; done before every derivation in the sandbox so incidents show at once. */
  async refreshLists(): Promise<void> {
    const response = await fetch(`${this.world.origins.origin("lists")}/trust-list.jwt`);
    const accepted = await this.lists.accept(
      (await response.text()).trim(),
      this.world.clock.now(),
    );
    if (accepted !== "accepted") this.#emit("refused", `Trust list not accepted: ${accepted}`);
    this.trust.invalidate();
  }

  async effectiveTier(origin: string): Promise<EffectiveTier> {
    await this.refreshLists();
    const tier = await this.trust.effectiveTier(origin);
    return tier;
  }

  async describe(host: Host): Promise<{
    tier: string;
    text: string;
    notes: string[];
    rejected: unknown[];
    derived: DerivedTier;
  }> {
    const tier = await this.effectiveTier(this.world.origins.origin(host));
    const text = describeRecipient(tier.derived).text;
    this.#emit(
      tier.tier === "unverified" ? "refused" : "ok",
      `Derived trust for ${this.world.origins.host(host)}: ${tier.tier}`,
      {
        shown_to_candidate: text,
        source: tier.source,
        notes: tier.derived.notes,
        rejected_attestations: tier.derived.rejected,
      },
    );
    return {
      tier: tier.tier,
      text,
      notes: tier.derived.notes,
      rejected: tier.derived.rejected,
      derived: tier.derived,
    };
  }

  // ── Mandate (RFC 0008) ────────────────────────────────────────────────────

  async startMandate(): Promise<string> {
    const start = await beginStandingMandate({
      issuer: this.world.origins.origin("issuer"),
      clientId: CLIENT_ID,
      redirectUri: `${this.origin}/callback`,
      proposal: this.proposal,
    });
    this.#pending.set(start.state, start.codeVerifier);
    this.consentUrl = start.url;
    this.#emit(
      "info",
      "Proposed a standing mandate to the permission service; the candidate approves it in their wallet",
      { proposal: this.proposal },
      "JobGPT asked your wallet for permission to apply for you. It can't give itself permission: only you can, in your wallet.",
    );
    return start.url;
  }

  async completeMandate(code: string, state: string): Promise<void> {
    const codeVerifier = this.#pending.get(state);
    if (!codeVerifier) throw new Error("unexpected state");
    const obtained = await completeStandingMandate({
      issuer: this.world.origins.origin("issuer"),
      clientId: CLIENT_ID,
      redirectUri: `${this.origin}/callback`,
      code,
      codeVerifier,
      keyring: this.world.keyring,
      holder: this.holder,
      now: () => this.world.clock.now(),
    });
    this.#pending.clear();
    this.consentUrl = undefined;
    this.#refreshToken = obtained.refreshToken;
    this.#emit(
      "ok",
      `Received a batch of ${obtained.batch.credentials.length} standing-mandate credentials, each bound to a different mandate key`,
      {
        expires: new Date(obtained.batch.mandate.exp * 1000).toISOString().slice(0, 10),
        applications_total: obtained.batch.terms.applications_total,
      },
      "Your wallet's permission service gave JobGPT a set of one-use passes. Each shows an employer only what that application needs.",
    );
  }

  /** The candidate declined in their wallet: the request is closed. Returns whether it was ours. */
  declineMandate(state: string): boolean {
    if (!this.#pending.delete(state)) return false;
    if (this.#pending.size === 0) this.consentUrl = undefined;
    this.#emit(
      "refused",
      "The candidate declined in their wallet; JobGPT has no permission",
      undefined,
      "You declined, so JobGPT has nothing to apply with.",
    );
    return true;
  }

  /**
   * Plays a candidate approving everything proposed (demo shortcut and
   * conformance runs). Conformance candidates aren't the wallet's owner, so this
   * proves their email with a one-time code through the JSON consent API.
   */
  async approveAsCandidate(): Promise<void> {
    const consent = await fetch(await this.startMandate(), { redirect: "manual" });
    const location = consent.headers.get("location") ?? "";
    const id = location.match(/\/permissions\/([A-Za-z0-9_-]+)$/)?.[1];
    if (!id) throw new Error(`the consent screen did not open (${consent.status})`);
    const api = `${this.world.origins.origin("issuer")}/api/consent/${id}`;
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(`${api}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: unknown = await response.json();
      if (!response.ok || !isRecord(json))
        throw new Error(`consent ${path} failed (${response.status})`);
      return json;
    };
    await post("/codes", {});
    const code = this.world.inbox.latestCode(this.email);
    if (!code) throw new Error("no code in the inbox");
    const { redirect } = await post("/approve", {
      codes: { [JSON.stringify({ email: this.email })]: code },
      selection: {},
    });
    const back = new URL(String(redirect));
    this.world.events.emit({
      actor: "candidate",
      where: this.world.origins.host("issuer"),
      title: "Candidate approved the permission in their wallet (one-time code from the inbox)",
      outcome: "ok",
    });
    await this.completeMandate(
      back.searchParams.get("code") ?? "",
      back.searchParams.get("state") ?? "",
    );
  }

  /**
   * Checks the status of the agent's own credentials, as employers do. A
   * permission cancelled in the candidate's wallet shows up here once the
   * permission service publishes the change (its next hourly epoch).
   */
  async syncStatus(): Promise<boolean> {
    const live = (await this.store.batches()).filter((b) => !b.revoked);
    if (live.length === 0) return false;
    const issuer = this.world.origins.origin("issuer");
    const metadata: unknown = await (await fetch(`${issuer}/.well-known/jwt-vc-issuer`)).json();
    const keys =
      isRecord(metadata) && isRecord(metadata.jwks) && Array.isArray(metadata.jwks.keys)
        ? metadata.jwks.keys.filter(isRecord).map((k) => ({ jwk: k as JWK }))
        : [];
    const cache = new StatusListCache({ now: () => this.world.clock.now() });
    let changed = false;
    for (const batch of live) {
      const first = batch.credentials[0];
      if (!first) continue;
      const status = (await parseSdJwt(first.compact)).payload.status;
      const list =
        isRecord(status) && isRecord(status.status_list) ? status.status_list : undefined;
      if (!list || typeof list.uri !== "string" || typeof list.idx !== "number") continue;
      try {
        // RFC 0008 §7.1: standing-mandate status lists live for at most an hour.
        await cache.requireValid({ uri: list.uri, idx: list.idx, keys, maxAge: 3600 });
      } catch (error) {
        // Only a revoked credential means the candidate cancelled; anything else
        // (a list that can't be fetched right now) leaves the permission as it is.
        if (!isOjcpError(error) || error.kind !== "revoked") continue;
        await this.holder.revokeBatch(batch.id);
        this.#refreshToken = undefined;
        changed = true;
        this.#emit(
          "info",
          "The permission service's status list shows the agent's credentials revoked: the candidate cancelled. The agent stops.",
          undefined,
          "JobGPT checked its passes and found them cancelled. It has stopped applying.",
        );
      }
    }
    return changed;
  }

  async refresh(): Promise<void> {
    if (!this.#refreshToken) throw new Error("no mandate to refresh");
    await refreshStandingMandate({
      issuer: this.world.origins.origin("issuer"),
      clientId: CLIENT_ID,
      refreshToken: this.#refreshToken,
      keyring: this.world.keyring,
      holder: this.holder,
      now: () => this.world.clock.now(),
    });
    this.#emit(
      "ok",
      "Refreshed the batch on identical terms; the issuer revoked the credentials it replaced",
    );
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  async #client(host: Host): Promise<Client> {
    const origin = this.world.origins.origin(host);
    let client = this.#clients.get(origin);
    if (!client) {
      client = await connectOjcpProvider({
        url: `${origin}/ojcp/mcp`,
        keyring: this.world.keyring,
        signatureAgent: this.origin,
        now: () => this.world.clock.now(),
        clientInfo: { name: "ojcp-sandbox-agent", version: "0.0.0" },
      });
      this.#clients.set(origin, client);
    }
    return client;
  }

  async callTool(host: Host, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const client = await this.#client(host);
    const response = await client.callTool({ name: tool, arguments: args });
    const content = Array.isArray(response.content) ? response.content : [];
    const first = content[0];
    const text = isRecord(first) && typeof first.text === "string" ? first.text : "{}";
    const parsed: unknown = JSON.parse(text);
    return { ok: response.isError !== true, result: isRecord(parsed) ? parsed : {} };
  }

  declaration(userMandate?: string): Record<string, unknown> {
    return {
      agent_id: this.world.origins.agentId,
      interaction_mode: "autonomous",
      ...(userMandate ? { user_mandate: userMandate } : {}),
    };
  }

  async search(host: Host): Promise<JobPostingFacts[]> {
    let mandate: string | undefined;
    try {
      mandate = (
        await this.holder.exercise({
          tool: "search_jobs",
          origin: this.world.origins.origin(host),
          ojcpVersion: OJCP_VERSION,
        })
      ).userMandate;
    } catch (error) {
      // No mandate covers searching here: search without one. Anything else is a bug.
      if (!(error instanceof StandingMandateRefusal)) throw error;
      mandate = undefined;
    }
    const out = await this.callTool(host, "search_jobs", {
      query: "data",
      agent_declaration: this.declaration(mandate),
    });
    const jobs = Array.isArray(out.result.jobs)
      ? out.result.jobs.map((j) => JobPostingFacts.parse(j))
      : [];
    this.#jobs.set(host, jobs);
    this.#emit(
      out.ok ? "ok" : "refused",
      `search_jobs at ${this.world.origins.host(host)}: ${jobs.length} jobs${mandate ? " (search credential disclosed only the action)" : ""}`,
    );
    return jobs;
  }

  async job(host: Host, jobId: string): Promise<JobPostingFacts> {
    const jobs = this.#jobs.get(host) ?? (await this.search(host));
    const job = jobs.find((j) => j.ojcp_id === jobId);
    if (!job) throw new Error(`no job ${jobId} at ${host}`);
    return job;
  }

  candidateContext(email: string = this.email): Record<string, unknown> {
    return {
      ojcp_candidate_context_version: "0.1",
      consent_scope: "application_prefill",
      email,
      name: CANDIDATE.name,
      resume_url: CANDIDATE.resume_url,
    };
  }

  applicationData(): Record<string, unknown> {
    return {
      cover_letter: `Hello, I'm ${CANDIDATE.name}. I'd like to apply.`,
      resume_url: CANDIDATE.resume_url,
    };
  }

  /** Begin and submit under the standing mandate, stopping wherever the mandate doesn't reach. */
  async apply(host: Host, jobId: string): Promise<ApplyOutcome> {
    // RFC 0008 §4.1: refresh a batch before it runs out, on identical terms (§7.3).
    if (this.#refreshToken && (await this.holder.needsRefresh()).length > 0) await this.refresh();
    const origin = this.world.origins.origin(host);
    const job = await this.job(host, jobId);
    const employerId = job.employer?.ojcp_employer_id ?? "";
    const candidate_context = this.candidateContext();
    const label = `${String(job.title ?? job.ojcp_id)} at ${this.world.origins.host(host)}`;
    try {
      const begin = await this.holder.exercise({
        tool: "begin_application",
        origin,
        ojcpVersion: OJCP_VERSION,
        job,
        employerId,
        request: { candidate_context },
        consentScope: "application_prefill",
      });
      this.#emit(
        "info",
        `Mandate covers ${label}: begin_application disclosing one email, the covering job family, place, work arrangement and pay rung`,
      );
      const started = await this.callTool(host, "begin_application", {
        job_id: job.ojcp_id,
        candidate_context,
        agent_declaration: this.declaration(begin.userMandate),
      });
      if (!started.ok) return this.#providerRefused(label, started.result);
      const session = {
        application_id: String(started.result.application_id),
        mandate_nonce: String(started.result.mandate_nonce),
      };
      if (started.result.status === "pending_verification") {
        const steps = z.array(z.unknown()).parse(started.result.verification_steps ?? []);
        const accepted = z
          .object({ accepted_verifiers: z.array(z.string()).default([]) })
          .catch({ accepted_verifiers: [] })
          .parse(started.result.apply_path).accepted_verifiers;
        return await this.#relayWalletStep(host, job, employerId, session, label, steps, accepted);
      }
      const bindingActions = BindingActions.parse(started.result.binding_actions ?? []);
      if (bindingActions.length > 0) {
        const approval: PendingApproval = {
          id: base64url(randomBytes(6)),
          provider: host,
          job,
          employerId,
          session,
          bindingActions,
        };
        this.approvals.set(approval.id, approval);
        const text = `${label} needs the candidate's own approval: ${bindingActions.map((b) => b.title).join(", ")}. A standing mandate never covers legal agreements.`;
        this.#emit(
          "info",
          text,
          { binding_actions: bindingActions },
          `${employerName(job)} has terms for "${String(job.title)}". JobGPT can't agree to terms for you, so it stopped and asked you.`,
        );
        return { status: "needs_approval", approval, text };
      }
      return await this.#submit(host, job, employerId, session, label);
    } catch (error) {
      if (error instanceof StandingMandateRefusal) {
        const text = `Agent will not apply to ${label}: ${error.message} (${error.reason})`;
        this.#emit(
          "refused",
          text,
          undefined,
          `JobGPT held back on "${String(job.title)}" at ${employerName(job)}: your permission doesn't cover it.`,
        );
        return { status: "refused_by_agent", reason: error.reason, text };
      }
      throw error;
    }
  }

  async #submit(
    host: Host,
    job: JobPostingFacts,
    employerId: string,
    session: { application_id: string; mandate_nonce: string },
    label: string,
  ): Promise<ApplyOutcome> {
    const request = {
      application_data: this.applicationData(),
      candidate_context: this.candidateContext(),
    };
    let ex: Exercise;
    try {
      ex = await this.holder.exercise({
        tool: "submit_application",
        origin: this.world.origins.origin(host),
        ojcpVersion: OJCP_VERSION,
        job,
        employerId,
        session: { ...session, binding_actions: [] },
        request,
      });
    } catch (error) {
      // The mandate may have changed since begin_application (e.g. a limit was reached).
      if (!(error instanceof StandingMandateRefusal)) throw error;
      const text = `Agent will not submit ${label}: ${error.message} (${error.reason})`;
      this.#emit(
        "refused",
        text,
        undefined,
        `JobGPT held back on "${String(job.title)}": a limit you set was reached.`,
      );
      return { status: "refused_by_agent", reason: error.reason, text };
    }
    const submitted = await this.callTool(host, "submit_application", {
      application_id: session.application_id,
      ...request,
      agent_declaration: this.declaration(ex.userMandate),
    });
    if (!submitted.ok) return this.#providerRefused(label, submitted.result);
    // A refusal can also arrive as a normal result (e.g. `verification_failed`): only `submitted` counts.
    if (submitted.result.status !== "submitted")
      return this.#providerRefused(label, {
        error_code: String(submitted.result.status ?? "unknown"),
        details: submitted.result,
      });
    if (!submitted.result.retried)
      await this.holder.recordSubmission(ex.batchId, this.world.origins.origin(host), employerId);
    this.#lastSubmit = { provider: host, job, employerId, session };
    const text = `Submitted ${label}${submitted.result.retried ? " (retry: the provider returned the original outcome)" : ""}`;
    this.#emit(
      "ok",
      text,
      { application_id: session.application_id },
      submitted.result.retried
        ? undefined
        : `JobGPT sent your application for "${String(job.title)}" to ${employerName(job)}. Their system checked your permission first.`,
    );
    return { status: "submitted", application_id: session.application_id, text };
  }

  #providerRefused(label: string, error: Record<string, unknown>): ApplyOutcome {
    const reason =
      isRecord(error.details) && typeof error.details.reason === "string"
        ? ` (${error.details.reason})`
        : "";
    const text = `Provider refused ${label}: ${String(error.error_code)}${reason}`;
    this.#emit("refused", text, { wire_error: error });
    return { status: "refused_by_provider", error, text };
  }

  /** Re-sends the last submission: the provider must return the original outcome and count nothing. */
  async retryLast(): Promise<ApplyOutcome> {
    const last = this.#lastSubmit;
    if (!last) throw new Error("nothing submitted yet");
    return this.#submit(
      last.provider,
      last.job,
      last.employerId,
      last.session,
      `${String(last.job.title)} (retry)`,
    );
  }

  /**
   * The candidate approves the legal agreement on their own device: an action
   * mandate signed by their key, binding the binding-actions digest (RFC 0009 §3.6).
   */
  async approveAndSubmit(id: string): Promise<ApplyOutcome> {
    const a = this.approvals.get(id);
    if (!a) throw new Error("no such approval");
    const origin = this.world.origins.origin(a.provider);
    const request = {
      application_data: this.applicationData(),
      candidate_context: this.candidateContext(),
    };
    const agentKey = this.world.keyring.requestSigner;
    const digestOfActions = await bindingActionsDigest(a.bindingActions);
    const { digest, statement } = await statementForApproval(
      {
        ojcp_version: OJCP_VERSION,
        resource_server: origin,
        employer: { ojcp_employer_id: a.employerId },
        tool: "submit_application",
        job_id: a.job.ojcp_id,
        application_id: a.session.application_id,
        agent_id: this.world.origins.agentId,
        mandate_nonce: a.session.mandate_nonce,
        binding_actions_digest: digestOfActions,
      },
      agentKey,
      request,
    );
    const now = this.world.clock.now();
    const device = this.world.candidate;
    const { compact } = await issueSdJwt({
      signer: device.signer,
      claims: {
        iss: device.iss,
        aud: origin,
        iat: now,
        nbf: now,
        exp: now + 600,
        jti: `mnd_${base64url(randomBytes(12))}`,
        cnf: { jkt: await thumbprint(agentKey.publicJwk) },
        ojcp_version: OJCP_VERSION,
        ojcp_action: digest,
      },
    });
    this.world.events.emit({
      actor: "candidate",
      where: "candidate's device",
      title: `Candidate approved "${a.bindingActions.map((b) => b.title).join(", ")}" for this one application on their own device`,
      outcome: "ok",
      detail: { statement },
    });
    const mandate = await presentActionMandate(compact, {
      aud: origin,
      nonce: a.session.mandate_nonce,
      signer: agentKey,
      iat: now,
    });
    const submitted = await this.callTool(a.provider, "submit_application", {
      application_id: a.session.application_id,
      ...request,
      // RFC 0009 §3.6: the agent states it presented this exact list.
      binding_actions_digest: digestOfActions,
      agent_declaration: this.declaration(mandate),
    });
    this.approvals.delete(id);
    const label = `${String(a.job.title)} at ${this.world.origins.host(a.provider)}`;
    if (!submitted.ok) return this.#providerRefused(label, submitted.result);
    if (submitted.result.status !== "submitted")
      return this.#providerRefused(label, {
        error_code: String(submitted.result.status ?? "unknown"),
        details: submitted.result,
      });
    const text = `Submitted ${label} under the candidate's action mandate`;
    this.#emit(
      "ok",
      text,
      undefined,
      `You agreed on your phone, so JobGPT sent "${String(a.job.title)}" to ${employerName(a.job)}.`,
    );
    return { status: "submitted", application_id: a.session.application_id, text };
  }

  /**
   * RFC 0013 §4.1: before relaying a wallet step the agent checks the site's
   * trust tier, the page's origin and the claims asked for. It only links: it
   * never builds or forwards a wallet request and never sees the record.
   */
  async #relayWalletStep(
    host: Host,
    job: JobPostingFacts,
    employerId: string,
    session: { application_id: string; mandate_nonce: string },
    label: string,
    steps: unknown[],
    acceptedVerifiers: readonly string[],
  ): Promise<ApplyOutcome> {
    const refuse = (reason: string, why: string): ApplyOutcome => {
      const text = `Agent will not relay ${label}'s wallet step: ${why}`;
      this.#emit("refused", text);
      return { status: "refused_by_agent", reason, text };
    };
    const parsed = WalletStep.safeParse(steps[0]);
    if (steps.length !== 1 || !parsed.success)
      return refuse("wallet_step_malformed", "it isn't a well-formed wallet step");
    const step = parsed.data;
    const origin = this.world.origins.origin(host);
    const tier = await this.effectiveTier(origin);
    if (tier.tier !== "verified" && tier.tier !== "audited")
      return refuse("trust", "the site's identity isn't verified");
    if (new URL(step.verification_url).origin !== origin)
      return refuse("wallet_step_origin", "its verification page isn't on the site's own origin");
    // §2.1: the step's verifier is one the apply path names, and the proof goes to the provider.
    if (!acceptedVerifiers.includes(step.verifier_id) || step.verifier_id !== new URL(origin).host)
      return refuse("wallet_step_verifier", "its verifier isn't the site the application is with");
    if (step.proof_delivery !== "provider_managed")
      return refuse(
        "wallet_step_delivery",
        "it would send the proof somewhere other than the site",
      );
    const paths = step.wallet_request.dcql_query.credentials.flatMap((c) =>
      c.claims.map((k) => k.path),
    );
    const outside = paths.filter((p) => !isPermittedEmploymentClaim(p));
    if (outside.length > 0)
      return refuse(
        "wallet_claims",
        `it asks for claims outside RFC 0013 §5's list (${outside.map(claimLabel).join(", ")})`,
      );
    const verification: PendingVerification = {
      id: base64url(randomBytes(6)),
      provider: host,
      job,
      employerId,
      session,
      url: step.verification_url,
      purpose: step.wallet_request.purpose,
      ref: step.wallet_request.application_ref,
      maskedContact: step.wallet_request.masked_contact,
      asks: paths.map(claimLabel),
      alternative: step.wallet_request.alternative,
    };
    this.verifications.set(verification.id, verification);
    const text = `${label} asks the candidate to verify their work history at its own page (${verification.ref}). Wallet steps are for the person: the agent stops and links to the page`;
    this.#emit(
      "info",
      text,
      {
        checked: [
          `site trust tier: ${tier.tier}`,
          "verification page on the site's origin",
          "claims within RFC 0013 §5",
        ],
        asks: verification.asks,
      },
      `${employerName(job)} wants to confirm your work history. That's between you and them, so JobGPT stopped and linked you to their page.`,
    );
    return { status: "needs_verification", verification, text };
  }

  /**
   * After the candidate's turn at the provider's page: submit once the step is no
   * longer pending. The agent learns only the step's state (RFC 0013 §2.2):
   * completed, or deferred because the candidate chose not to use a wallet.
   */
  async continueAfterVerification(
    id: string,
  ): Promise<
    | { status: "still_pending"; text: string }
    | { status: "done"; step: "completed" | "deferred" | "expired"; outcome: ApplyOutcome }
  > {
    const v = this.verifications.get(id);
    if (!v) throw new Error("no such verification");
    const label = `${String(v.job.title)} at ${this.world.origins.host(v.provider)}`;
    const status = await this.callTool(v.provider, "check_application_status", {
      application_id: v.session.application_id,
      agent_declaration: this.declaration(),
    });
    // A failed check says nothing about the step: keep the link so the candidate can try again.
    if (!status.ok) {
      const text = `${label}: couldn't check the application's status (${String(status.result.error_code)})`;
      this.#emit("refused", text, { wire_error: status.result });
      return { status: "still_pending", text };
    }
    const vs = status.result.verification_status;
    if (status.result.status === "pending_verification") {
      const text = `${label}: the work-history step is still pending`;
      this.#emit("info", text, { verification_status: vs });
      return { status: "still_pending", text };
    }
    if (status.result.status === "expired") {
      this.verifications.delete(id);
      const text = `${label}: the work-history step passed its deadline, so the application expired`;
      this.#emit(
        "info",
        text,
        undefined,
        `The time to confirm your work history ran out, so "${String(v.job.title)}" expired.`,
      );
      return {
        status: "done",
        step: "expired",
        outcome: { status: "refused_by_provider", error: { error_code: "expired" }, text },
      };
    }
    const step =
      isRecord(vs) && Array.isArray(vs.deferred_steps) && vs.deferred_steps.length > 0
        ? "deferred"
        : "completed";
    this.#emit(
      "ok",
      `${label}: the provider reports the step ${step === "deferred" ? "deferred (the candidate chose not to use a wallet)" : "completed"}; submitting`,
      { verification_status: vs },
    );
    const outcome = await this.#submit(v.provider, v.job, v.employerId, v.session, label);
    // Kept until submitted: a refusal, e.g. a limit, leaves the record to explain why.
    this.verifications.delete(id);
    return { status: "done", step, outcome };
  }

  async state(): Promise<Record<string, unknown>> {
    const batches = await this.store.batches();
    const submissions = (
      await Promise.all(batches.map((b) => this.store.submissions(b.id)))
    ).flat();
    return {
      mandate: batches.map((b) => ({
        id: b.id.slice(0, 8),
        revoked_locally: b.revoked ?? false,
        credentials: b.credentials.length,
        unused: b.credentials.filter((c) => !c.use).length,
        expires: new Date(b.mandate.exp * 1000).toISOString().slice(0, 10),
        total: b.terms.applications_total,
      })),
      submissions: submissions.map((s) => ({
        employer: s.employerId,
        where: new URL(s.origin).host,
      })),
      approvals: [...this.approvals.values()].map((a) => ({
        id: a.id,
        job: a.job.title,
        provider: this.world.origins.host(a.provider),
        binding_actions: a.bindingActions.map((b) => b.title),
      })),
      jobs: Object.fromEntries(
        [...this.#jobs].map(([h, jobs]) => [
          h,
          jobs.map((j) => ({
            id: j.ojcp_id,
            title: j.title,
            employer: j.employer?.ojcp_employer_id,
          })),
        ]),
      ),
    };
  }
}
