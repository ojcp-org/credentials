/**
 * A demo OJCP provider. It does what a real one would: signs its manifest
 * with a key its identity key certifies, publishes attestations, verifies
 * every agent request (RFC 9421) and every user mandate (RFC 0008, RFC 0003),
 * and counts applications per employer. Every decision goes to the timeline.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type ActionStatement,
  AgentDeclaration,
  AgentSignatureError,
  actionStatement,
  base64url,
  bindingActionsDigest,
  bindsByNamespace,
  type CandidateElement,
  ConsentScope,
  candidateDataDigest,
  type GeneratedSigner,
  generateSigner,
  HIRING_VCT,
  isRecord,
  type JWK,
  KeyDirectory,
  ONET_SOC_2019,
  onet,
  parseSdJwt,
  publicPart,
  randomBytes,
  STANDING_MANDATE_VCT,
  type Tool,
  thumbprint,
  type UserMandatesPolicy,
  verifyRequest,
} from "@ojcp/credentials-core";
import { isFetchable, signKeyCertificate, signManifest } from "@ojcp/trust";
import {
  type AdmittedMandateIssuer,
  InMemoryLedger,
  type MandatePolicy,
  MandateRejected,
  StatusListCache,
  submittedContact,
  type VerifiedAgent,
  verifyActionMandate,
  verifyStandingMandate,
} from "@ojcp/verifier";
import { Hono } from "hono";
import { z } from "zod";
import type { EventBus, SandboxClock } from "../events.ts";
import { page } from "../html.ts";
import { employerJobs, type SandboxJob } from "./jobs.ts";
import type { KeptPresentation, WalletStepVerifier } from "./wallet-step.ts";

export const OJCP_VERSION = "0.3";
const DAY = 86_400;

/** A kept presentation as reviewers see it: no record of which path completed the step. */
type ReviewedPresentation = Omit<KeptPresentation, "via">;
const withoutPath = (kept: KeptPresentation | undefined): ReviewedPresentation | undefined =>
  kept && {
    record: kept.record,
    issuer: kept.issuer,
    issuerName: kept.issuerName,
    basis: kept.basis,
    presentationSha256: kept.presentationSha256,
  };

export const MANIFEST_POLICY: UserMandatesPolicy = {
  types: ["action", "standing"],
  required_for: ["begin_application", "submit_application"],
  action_mandate_required_for: ["accept_terms", "accept_offer"],
  standing: {
    vct_values: [STANDING_MANDATE_VCT],
    max_lifetime_months: 3,
    max_per_employer: 2,
    max_breadth: "broad",
    taxonomies: [ONET_SOC_2019],
  },
  action: { max_lifetime_seconds: 600 },
};

export interface ProviderOptions {
  origin: string;
  name: string;
  employers: Array<{
    employer: { ojcp_employer_id: string; name: string };
    kind: "acme" | "globex" | "initech";
  }>;
  /** Shared with tenants that run under the same identity key (RFC 0010 §3.5). */
  identity?: GeneratedSigner;
  /** The mandate issuer the provider admits. */
  issuerOrigin: string;
  /** Candidate device keys the provider has bound to accounts, admitted for action mandates. */
  candidateKeys: () => Array<{ iss: string; jwk: JWK }>;
  /** The staple: attestation compact forms and where to get current status tokens. */
  staple: () => Promise<{ attestations: string[]; statusTokens: string[] }>;
  clock: SandboxClock;
  events: EventBus;
  notice: string;
  /** RFC 0013 wallet steps, for providers that ask candidates to verify records. */
  walletSteps?: WalletStepVerifier;
}

/** What the employer's recruiters see for one application. */
export interface ReceivedApplication {
  applicationId: string;
  at: number;
  job: { id: string; title: string };
  employer: string;
  /** Standing: sent by an agent under the candidate's permission. Action: approved by the candidate. */
  mandate: "standing" | "action";
  /** What the mandate disclosed at begin_application. */
  learned: Record<string, unknown>;
  contact: string | undefined;
  coverLetter: string | undefined;
  workHistory:
    | {
        /** Completed with a wallet, or deferred: the candidate chose not to use one (RFC 0013 §7). */
        status: string;
        kept: ReviewedPresentation | undefined;
        /** The job's rule, applied by a recruiter when reviewing (RFC 0013 §2.2). */
        requirement: string | undefined;
        /** A deferred step's check, done by the employer's own means after submission. */
        check?: { outcome: "confirmed" | "not_confirmed"; note: string; at: number };
      }
    | undefined;
}

interface Session {
  application_id: string;
  mandate_nonce: string;
  job: SandboxJob;
  candidate?: CandidateElement;
  /** The application's contact (`candidate_context.email`). */
  contact?: string;
  learned?: Record<string, unknown>;
  status: "in_progress" | "submitted";
  outcome?: unknown;
}

const ToolArgs = z.looseObject({
  agent_declaration: AgentDeclaration.optional(),
  candidate_context: z
    .looseObject({ consent_scope: ConsentScope.optional(), email: z.string().optional() })
    .optional(),
  application_data: z.looseObject({}).optional(),
  job_id: z.string().optional(),
  application_id: z.string().optional(),
  binding_actions_digest: z.string().optional(),
});

/** What each tool advertises over MCP (the OJCP tool inputs, abbreviated). */
const declaration = z
  .object({
    agent_id: z.string(),
    interaction_mode: z.string().optional(),
    user_mandate: z.string().optional(),
  })
  .optional();
const TOOL_INPUTS = {
  search_jobs: { query: z.string().optional(), agent_declaration: declaration },
  get_job_detail: { job_id: z.string(), agent_declaration: declaration },
  begin_application: {
    job_id: z.string(),
    candidate_context: z.record(z.string(), z.unknown()).optional(),
    agent_declaration: declaration,
  },
  submit_application: {
    application_id: z.string(),
    application_data: z.record(z.string(), z.unknown()).optional(),
    candidate_context: z.record(z.string(), z.unknown()).optional(),
    binding_actions_digest: z.string().optional(),
    agent_declaration: declaration,
  },
  check_application_status: { application_id: z.string(), agent_declaration: declaration },
};

export class SandboxProvider {
  readonly origin: string;
  readonly host: string;
  readonly name: string;
  readonly jobs: SandboxJob[];
  identity: GeneratedSigner;
  identityThumbprint = "";
  readonly #options: ProviderOptions;
  #manifestKey!: GeneratedSigner;
  #keyCert = "";
  readonly #sessions = new Map<string, Session>();
  readonly #nonces = new Map<string, number>();
  readonly #directories = new Map<string, { at: number; keys: Array<Record<string, unknown>> }>();
  readonly #secrets = new Map<string, Uint8Array>();
  readonly ledger = new InMemoryLedger();
  readonly received: ReceivedApplication[] = [];
  readonly #status: StatusListCache;
  #issuerKeys: { at: number; keys: JWK[] } | undefined;

  private constructor(options: ProviderOptions, identity: GeneratedSigner) {
    this.#options = options;
    this.origin = options.origin;
    this.host = new URL(options.origin).host;
    this.name = options.name;
    this.identity = identity;
    this.jobs = options.employers.flatMap(({ employer, kind }) =>
      employerJobs(new URL(options.origin).hostname, employer, kind),
    );
    this.#status = new StatusListCache({ now: () => options.clock.now() });
  }

  static async create(options: ProviderOptions): Promise<SandboxProvider> {
    const provider = new SandboxProvider(
      options,
      options.identity ?? (await generateSigner("ES256")),
    );
    await provider.#certify();
    return provider;
  }

  get subject(): string {
    return `did:web:${new URL(this.origin).hostname}${new URL(this.origin).port ? `%3A${new URL(this.origin).port}` : ""}`;
  }

  async #certify(): Promise<void> {
    this.identityThumbprint = await thumbprint(this.identity.publicJwk);
    this.#manifestKey = await generateSigner("ES256");
    const now = this.#options.clock.now();
    this.#keyCert = await signKeyCertificate(this.identity, {
      sub: this.subject,
      key: this.#manifestKey.publicJwk,
      purposes: ["manifest"],
      iat: now - DAY,
      exp: now + 170 * DAY,
    });
  }

  /** Incident: the domain changes hands and the new owner installs its own identity key (RFC 0010 §2.2). */
  async takeOver(): Promise<void> {
    this.identity = await generateSigner("ES256");
    await this.#certify();
    this.#emit(
      "info",
      "Domain taken over: a new identity key with no logged link to the old one",
      undefined,
      `Someone took over ${this.host} with a new key. Its old attestations don't match it, so assistants stop trusting it.`,
    );
  }

  #emit(
    outcome: "ok" | "refused" | "info",
    title: string,
    detail?: Record<string, unknown>,
    say?: string,
  ): void {
    this.#options.events.emit({
      actor: "provider",
      where: this.host,
      title,
      outcome,
      ...(detail ? { detail } : {}),
      ...(say ? { say } : {}),
    });
  }

  async manifest(): Promise<Record<string, unknown>> {
    const now = this.#options.clock.now();
    return signManifest(
      {
        ojcp_version: OJCP_VERSION,
        provider: {
          name: this.name,
          description: "A sandbox provider with made-up jobs.",
          did: this.subject,
        },
        mcp_endpoint: `${this.origin}/ojcp/mcp`,
        tools: [
          "search_jobs",
          "get_job_detail",
          "begin_application",
          "submit_application",
          "check_application_status",
        ],
        apply_paths: ["provider_hosted"],
        auth: {
          required: false,
          agent_signatures: {
            supported: true,
            algorithms: ["ed25519", "ecdsa-p256-sha256"],
            required_for: ["begin_application", "submit_application"],
          },
          user_mandates: { ...MANIFEST_POLICY, policy_id: `${this.origin}/mandate-policy` },
        },
        trust: { attestations_uri: `${this.origin}/.well-known/ojcp-attestations.json` },
        // RFC 0013 §6.3: which wallet records this provider accepts, and from whom.
        ...(this.#options.walletSteps
          ? {
              wallet_presentation: {
                accepts: [
                  {
                    verification_type: "employment",
                    format: "dc+sd-jwt",
                    types: [HIRING_VCT.employment],
                    profiles: ["baseline"],
                  },
                ],
                accepted_issuers_uri: `${this.origin}/ojcp/accepted-issuers.json`,
              },
            }
          : {}),
        sandbox: this.#options.notice,
      },
      this.#manifestKey,
      {
        kid: "manifest-1",
        iss: this.host,
        signedAt: new Date((now - 60) * 1000),
        expiresAt: new Date((now + DAY) * 1000),
      },
    );
  }

  keySet(): { keys: Array<Record<string, unknown>> } {
    return {
      keys: [
        {
          ...publicPart(this.identity.publicJwk),
          kid: "identity",
          alg: "ES256",
          ojcp_role: "identity",
        },
        {
          ...publicPart(this.#manifestKey.publicJwk),
          kid: "manifest-1",
          alg: "ES256",
          ojcp_cert: this.#keyCert,
        },
      ],
    };
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  async #fetchJson(url: string): Promise<unknown> {
    if (!isFetchable(url)) throw new Error(`refusing to fetch ${url}`);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  }

  async #issuerPins(): Promise<JWK[]> {
    const now = this.#options.clock.now();
    if (this.#issuerKeys && now - this.#issuerKeys.at < 3600) return this.#issuerKeys.keys;
    const metadata = z
      .object({ jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }) })
      .parse(await this.#fetchJson(`${this.#options.issuerOrigin}/.well-known/jwt-vc-issuer`));
    this.#issuerKeys = { at: now, keys: metadata.jwks.keys.map((k) => k as JWK) };
    return this.#issuerKeys.keys;
  }

  async #policy(): Promise<MandatePolicy> {
    const issuers: AdmittedMandateIssuer[] = [
      {
        iss: this.#options.issuerOrigin,
        keys: (await this.#issuerPins()).map((jwk) => ({ jwk })),
        types: ["standing"],
      },
      ...this.#options
        .candidateKeys()
        .map((k) => ({ iss: k.iss, keys: [{ jwk: k.jwk }], types: ["action" as const] })),
    ];
    return {
      origin: this.origin,
      manifest: MANIFEST_POLICY,
      issuers,
      ojcpVersions: [OJCP_VERSION],
      status: this.#status,
      ledger: this.ledger,
      countSecret: async (employerId) => {
        let secret = this.#secrets.get(employerId);
        if (!secret) {
          secret = randomBytes(32);
          this.#secrets.set(employerId, secret);
        }
        return secret;
      },
      now: () => this.#options.clock.now(),
    };
  }

  async #resolveAgentKey(signatureAgent: string, keyid: string): Promise<JWK | undefined> {
    const now = this.#options.clock.now();
    let cached = this.#directories.get(signatureAgent);
    if (!cached || now - cached.at > 60 || !cached.keys.some((k) => k.kid === keyid)) {
      const directory = KeyDirectory.parse(
        await this.#fetchJson(`${signatureAgent}/.well-known/http-message-signatures-directory`),
      );
      cached = { at: now, keys: directory.keys };
      this.#directories.set(signatureAgent, cached);
    }
    const key = cached.keys.find((k) => k.kid === keyid);
    return key ? publicPart(key as JWK) : undefined;
  }

  async #verifyAgent(
    request: Request,
    body: Uint8Array,
    declaredAgentId: string | undefined,
  ): Promise<VerifiedAgent | undefined> {
    if (!request.headers.has("signature")) return undefined;
    const now = this.#options.clock.now();
    for (const [k, exp] of this.#nonces) if (exp < now) this.#nonces.delete(k);
    const verified = await verifyRequest(
      {
        method: request.method,
        url: request.url.replace(/^http:/, "https:"),
        headers: request.headers,
        body,
      },
      {
        resolveKey: (agent, kid) => this.#resolveAgentKey(agent, kid),
        seenNonce: async (kid, nonce, expires) => {
          const key = `${kid}:${nonce}`;
          if (this.#nonces.has(key)) return true;
          this.#nonces.set(key, expires);
          return false;
        },
        now,
      },
    );
    if (!declaredAgentId || !bindsByNamespace(declaredAgentId, verified.signatureAgent))
      throw new AgentSignatureError(
        "agent_identity_mismatch",
        "agent_id is not bound to the signing origin",
      );
    return { ...verified, agent_id: declaredAgentId };
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  async #statement(
    tool: Tool,
    job: SandboxJob,
    agent: VerifiedAgent,
    args: z.infer<typeof ToolArgs>,
    session?: Session,
  ): Promise<ActionStatement> {
    const request = {
      ...(args.application_data !== undefined ? { application_data: args.application_data } : {}),
      ...(args.candidate_context !== undefined
        ? { candidate_context: args.candidate_context }
        : {}),
    };
    return actionStatement({
      ojcp_version: OJCP_VERSION,
      resource_server: this.origin,
      employer: { ojcp_employer_id: job.employer.ojcp_employer_id },
      tool,
      job_id: job.ojcp_id,
      agent_id: agent.agent_id,
      agent_key_thumbprint: agent.keyid,
      ...(session
        ? {
            application_id: session.application_id,
            mandate_nonce: session.mandate_nonce,
            candidate_data_digest: await candidateDataDigest(request),
            ...(job.binding_actions.length > 0
              ? { binding_actions_digest: await bindingActionsDigest(job.binding_actions) }
              : {}),
          }
        : {
            ...(request.candidate_context
              ? {
                  candidate_data_digest: await candidateDataDigest({
                    candidate_context: request.candidate_context,
                  }),
                }
              : {}),
            ...(args.candidate_context?.consent_scope
              ? { consent_scope: args.candidate_context.consent_scope }
              : {}),
          }),
    });
  }

  /** Verifies whichever kind of user mandate was presented; returns what the provider learned. */
  async #mandate(
    tool: Tool,
    mandate: string,
    agent: VerifiedAgent,
    job: SandboxJob,
    args: z.infer<typeof ToolArgs>,
    session?: Session,
  ): Promise<{
    kind: "standing" | "action";
    learned: Record<string, unknown>;
    candidate?: CandidateElement;
    prior?: unknown;
    commit?: (outcome: unknown) => Promise<{ status: string }>;
  }> {
    const policy = await this.#policy();
    const statement = await this.#statement(tool, job, agent, args, session);
    const vct = (await parseSdJwt(mandate)).payload.vct;
    if (vct === STANDING_MANDATE_VCT) {
      const decision = await verifyStandingMandate(policy, {
        presentation: mandate,
        agent,
        tool,
        job,
        employerId: job.employer.ojcp_employer_id,
        statement,
        ...(session
          ? {
              session: {
                mandate_nonce: session.mandate_nonce,
                binding_actions: job.binding_actions,
                ...(session.candidate ? { candidate: session.candidate } : {}),
              },
              submittedContact: submittedContact(args),
              hasEeo: isRecord(args.application_data) && args.application_data.eeo !== undefined,
            }
          : {}),
        ...(args.candidate_context?.consent_scope
          ? { consentScope: args.candidate_context.consent_scope }
          : {}),
      });
      const m = decision.mandate;
      return {
        kind: "standing",
        learned: {
          issuer: decision.iss,
          candidate: m.candidate,
          job_families: m.scope.job_families,
          locations: m.scope.locations,
          remote_policy: m.scope.remote_policy,
          salary: m.scope.salary,
          per_employer: m.limits.per_employer,
          breadth: m.breadth,
          expires: new Date(m.exp * 1000).toISOString().slice(0, 10),
        },
        ...(decision.candidate ? { candidate: decision.candidate } : {}),
        ...(decision.priorOutcome !== undefined ? { prior: decision.priorOutcome } : {}),
        ...(decision.commit ? { commit: decision.commit } : {}),
      };
    }
    const decision = await verifyActionMandate(policy, {
      presentation: mandate,
      agent,
      tool,
      statement,
      ...(session ? { mandateNonce: session.mandate_nonce } : {}),
      multiTenant: true,
    });
    return {
      kind: "action",
      learned: { issuer: decision.iss, jti: decision.jti, approved_action: decision.action },
      ...(decision.priorOutcome !== undefined ? { prior: decision.priorOutcome } : {}),
      commit: decision.commit,
    };
  }

  #publicJob(job: SandboxJob): Record<string, unknown> {
    const { demo: _, binding_actions: __, verify_employment: ___, ...rest } = job;
    return rest;
  }

  async #call(
    tool: Tool,
    args: z.infer<typeof ToolArgs>,
    agent: VerifiedAgent | undefined,
  ): Promise<Record<string, unknown>> {
    const mandate = args.agent_declaration?.user_mandate;
    const needsAgent = tool === "begin_application" || tool === "submit_application";
    if (needsAgent && !agent)
      throw new AgentSignatureError("agent_signature_missing", "this tool needs a signed request");

    if (tool === "search_jobs" || tool === "get_job_detail") {
      if (mandate && agent && (await parseSdJwt(mandate)).payload.vct === STANDING_MANDATE_VCT) {
        await verifyStandingMandate(await this.#policy(), { presentation: mandate, agent, tool });
        this.#emit("ok", `${tool}: standing mandate accepted; it disclosed only the action`);
      }
      if (tool === "get_job_detail") {
        const job = this.jobs.find((j) => j.ojcp_id === args.job_id);
        if (!job) return { error_code: "job_not_found", message: "No such job." };
        return { ojcp_version: OJCP_VERSION, job: this.#publicJob(job) };
      }
      this.#emit(
        "info",
        `search_jobs from ${agent ? agent.agent_id : "an unsigned agent"}: ${this.jobs.length} jobs`,
      );
      return { ojcp_version: OJCP_VERSION, jobs: this.jobs.map((j) => this.#publicJob(j)) };
    }

    if (tool === "begin_application") {
      const job = this.jobs.find((j) => j.ojcp_id === args.job_id);
      if (!job) return { error_code: "job_not_found", message: "No such job." };
      if (!mandate) throw new MandateRejected("missing", "no user mandate");
      const verified = await this.#mandate(tool, mandate, agent as VerifiedAgent, job, args);
      const contact = args.candidate_context?.email;
      const session: Session = {
        application_id: `app_${base64url(randomBytes(9))}`,
        mandate_nonce: `mn_${base64url(randomBytes(18))}`,
        job,
        status: "in_progress",
        learned: verified.learned,
        ...(verified.candidate ? { candidate: verified.candidate } : {}),
        ...(contact ? { contact } : {}),
      };
      this.#sessions.set(session.application_id, session);
      this.#emit(
        "ok",
        `begin_application for ${job.title} (${job.employer.name}) accepted under a ${verified.kind} mandate`,
        { learned: verified.learned },
      );
      const walletSteps = this.#options.walletSteps;
      if (job.verify_employment && walletSteps && contact) {
        const { step, deadline } = await walletSteps.start(
          session.application_id,
          { title: job.title, rule: job.verify_employment },
          contact,
        );
        return {
          ojcp_version: OJCP_VERSION,
          application_id: session.application_id,
          status: "pending_verification",
          mandate_nonce: session.mandate_nonce,
          // RFC 0013 §2.1: the step's verifier_id must be listed here.
          apply_path: {
            type: "provider_hosted",
            supports_agent_submission: true,
            requires_verification: true,
            accepted_verifiers: [walletSteps.host],
          },
          binding_actions: job.binding_actions,
          verification_steps: [step],
          verification_deadline: deadline,
        };
      }
      return {
        ojcp_version: OJCP_VERSION,
        application_id: session.application_id,
        status: "in_progress",
        mandate_nonce: session.mandate_nonce,
        binding_actions: job.binding_actions,
      };
    }

    if (tool === "submit_application") {
      const session = this.#sessions.get(args.application_id ?? "");
      if (!session) return { error_code: "application_not_found", message: "No such application." };
      if (!mandate) throw new MandateRejected("missing", "no user mandate");
      // RFC 0009 §3.6: with a required binding action, the agent must state it presented this exact list.
      if (
        session.job.binding_actions.some((b) => b.required) &&
        args.binding_actions_digest !== (await bindingActionsDigest(session.job.binding_actions))
      )
        return {
          error_code: "missing_required_field",
          message:
            "binding_actions_digest is missing or doesn't match the terms on this application.",
          details: { field: "binding_actions_digest" },
        };
      // RFC 0013: a pending wallet step blocks submission; a deferred one doesn't (§7).
      const walletSteps = this.#options.walletSteps;
      const step = walletSteps?.stepState(session.application_id);
      if (
        walletSteps &&
        step &&
        session.status !== "submitted" &&
        (step.status === "pending" ||
          !(await walletSteps.submissionMatches(
            session.application_id,
            submittedContact(args).email,
          )))
      )
        return {
          ojcp_version: OJCP_VERSION,
          application_id: session.application_id,
          status: "verification_failed",
          verification_errors: [
            {
              step_id: step.stepId,
              error: "missing_proof",
              message: "The candidate hasn't completed this verification step.",
            },
          ],
        };
      const verified = await this.#mandate(
        tool,
        mandate,
        agent as VerifiedAgent,
        session.job,
        args,
        session,
      );
      if (verified.prior !== undefined) {
        this.#emit(
          "ok",
          "submit_application retried: original outcome returned, nothing counted twice",
        );
        return { ...(verified.prior as Record<string, unknown>), retried: true };
      }
      const outcome = {
        ojcp_version: OJCP_VERSION,
        application_id: session.application_id,
        status: "submitted",
        delegated: verified.kind === "standing",
      };
      const committed = await verified.commit?.(outcome);
      if (committed?.status === "limit_reached")
        throw new MandateRejected("limit_reached", "per_employer limit reached");
      if (committed?.status === "nonce_consumed")
        throw new MandateRejected("replayed", "mandate nonce already used");
      session.status = "submitted";
      this.received.unshift({
        applicationId: session.application_id,
        at: this.#options.clock.now(),
        job: { id: session.job.ojcp_id, title: session.job.title },
        employer: session.job.employer.name,
        mandate: verified.kind,
        learned: session.learned ?? verified.learned,
        contact: submittedContact(args).email,
        coverLetter:
          isRecord(args.application_data) && typeof args.application_data.cover_letter === "string"
            ? args.application_data.cover_letter
            : undefined,
        workHistory: step
          ? {
              status: step.status,
              // RFC 0013 §7: reviewers see whether the step completed, never which path did it.
              kept: withoutPath(walletSteps?.kept(session.application_id)),
              requirement: session.job.verify_employment,
            }
          : undefined,
      });
      this.#emit(
        "ok",
        `Application to ${session.job.employer.name} submitted under a ${verified.kind} mandate${verified.kind === "standing" ? ", marked as delegated for the employer" : ""}`,
        { learned: verified.learned },
      );
      return outcome;
    }

    if (tool === "check_application_status") {
      const session = this.#sessions.get(args.application_id ?? "");
      if (!session) return { error_code: "application_not_found", message: "No such application." };
      // RFC 0013 §2.2: the agent learns the step's state and nothing about its content.
      const step = this.#options.walletSteps?.stepState(session.application_id);
      const status =
        session.status === "submitted"
          ? "submitted"
          : step?.status === "expired"
            ? "expired"
            : step?.status === "pending"
              ? "pending_verification"
              : "pending_submission";
      return {
        ojcp_version: OJCP_VERSION,
        application_id: session.application_id,
        status,
        ...(step
          ? {
              verification_status: {
                steps_total: 1,
                steps_completed: step.status === "completed" ? 1 : 0,
                pending_steps: step.status === "pending" ? [step.stepId] : [],
                completed_steps: step.status === "completed" ? [step.stepId] : [],
                deferred_steps: step.status === "deferred" ? [step.stepId] : [],
              },
            }
          : {}),
      };
    }
    return { error_code: "unsupported_tool", message: `${tool} is not supported` };
  }

  async #handleMcp(request: Request): Promise<Response> {
    const body = new Uint8Array(await request.arrayBuffer());
    let message: unknown;
    try {
      message = body.length ? JSON.parse(new TextDecoder().decode(body)) : undefined;
    } catch {
      message = undefined;
    }
    const params = isRecord(message) && isRecord(message.params) ? message.params : undefined;
    const declared =
      params && isRecord(params.arguments)
        ? AgentDeclaration.safeParse(params.arguments.agent_declaration)
        : undefined;
    let agent: VerifiedAgent | undefined;
    let agentError: AgentSignatureError | undefined;
    try {
      agent = await this.#verifyAgent(
        request,
        body,
        declared?.success ? declared.data.agent_id : undefined,
      );
    } catch (error) {
      agentError =
        error instanceof AgentSignatureError
          ? error
          : new AgentSignatureError("agent_signature_invalid", String(error));
    }

    const server = new McpServer({ name: this.name, version: OJCP_VERSION });
    const tools: Tool[] = [
      "search_jobs",
      "get_job_detail",
      "begin_application",
      "submit_application",
      "check_application_status",
    ];
    for (const tool of tools) {
      server.registerTool(
        tool,
        {
          description: `OJCP ${tool} (sandbox)`,
          inputSchema: TOOL_INPUTS[tool as keyof typeof TOOL_INPUTS],
        },
        async () => {
          const args = ToolArgs.safeParse(
            params && isRecord(params.arguments) ? params.arguments : {},
          );
          try {
            if (agentError) throw agentError;
            if (!args.success)
              return this.#error({
                error_code: "invalid_arguments",
                message: "Arguments don't match the tool.",
              });
            const result = await this.#call(tool, args.data, agent);
            if (typeof result.error_code === "string") return this.#error(result);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (error instanceof AgentSignatureError) {
              this.#emit("refused", `${tool} refused: ${error.code}`, { error_code: error.code });
              return this.#error({ error_code: error.code, message: error.message });
            }
            if (error instanceof MandateRejected) {
              const wire = error.toToolError();
              this.#emit("refused", `${tool} refused: user_mandate_required`, {
                wire,
                internal_check_that_failed: error.kind,
                why: error.message,
              });
              return this.#error({ ojcp_version: OJCP_VERSION, ...wire });
            }
            throw error;
          }
        },
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        ...(body.length ? { body } : {}),
      }),
      {
        parsedBody: message,
      },
    );
  }

  #error(error: Record<string, unknown>): {
    isError: true;
    content: Array<{ type: "text"; text: string }>;
  } {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(error) }] };
  }

  app(): Hono {
    const app = new Hono();
    // The site's own pages are the React app; these are the data behind them.
    app.get("/api/site", (c) =>
      c.json({
        name: this.name,
        host: this.host,
        employers: [...new Set(this.jobs.map((j) => j.employer.name))],
        jobs: this.jobs.map((j) => ({
          ...this.#publicJob(j),
          asks_for_work_history: j.verify_employment !== undefined,
        })),
      }),
    );
    // Occupation names for recruiters, from the codes the mandate disclosed.
    app.get("/api/ats", (c) =>
      c.json({
        received: this.received.map((r) => ({
          ...r,
          occupations: (Array.isArray(r.learned.job_families) ? r.learned.job_families : []).map(
            (code) => `${onet.title(String(code)) ?? String(code)} (${String(code)})`,
          ),
        })),
      }),
    );
    // A recruiter records the result of checking a deferred step by their own means.
    app.post("/api/ats/:id/check", async (c) => {
      const r = this.received.find((x) => x.applicationId === c.req.param("id"));
      const work = r?.workHistory;
      if (!r || work?.status !== "deferred")
        return c.json({ error: "Nothing to check for this application." }, 404);
      if (work.check) return c.json({ error: "A check is already recorded." }, 409);
      const body = z
        .object({ outcome: z.enum(["confirmed", "not_confirmed"]), note: z.string().max(500) })
        .safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ error: "Choose an outcome." }, 400);
      work.check = { ...body.data, at: this.#options.clock.now() };
      this.#emit(
        "info",
        `A recruiter recorded their own work-history check for ${r.job.title}: ${body.data.outcome === "confirmed" ? "confirmed" : "couldn't confirm"}`,
      );
      return c.json({ ok: true });
    });
    this.#options.walletSteps?.routes(app);
    app.get("/.well-known/ojcp.json", async (c) => c.json(await this.manifest()));
    app.get("/.well-known/ojcp-keys.json", (c) =>
      c.json(this.keySet(), 200, { "content-type": "application/jwk-set+json" }),
    );
    app.get("/.well-known/ojcp-attestations.json", async (c) => {
      const staple = await this.#options.staple();
      return c.json({
        attestations: staple.attestations,
        status_tokens: staple.statusTokens,
        issuer_jwks: {},
      });
    });
    app.get("/mandate-policy", (c) =>
      c.html(
        page(
          `${this.name}: mandate policy`,
          `<p>Admits standing mandates from the sandbox issuer only, and action mandates from candidate keys bound to accounts here. Maximums: 3 months, 2 applications per employer, breadth broad.</p>`,
          this.#options.notice,
        ),
      ),
    );
    app.all("/ojcp/mcp", (c) => this.#handleMcp(c.req.raw));
    return app;
  }
}
