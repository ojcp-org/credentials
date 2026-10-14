/**
 * Holding and exercising standing mandates (RFC 0008 §§4–6, agent side).
 *
 * The holder picks which credential of a batch to present (§4.1), decides what
 * to disclose from the full scope it holds, enforces what only the agent can
 * (the floor, the total, the trust floor, per-employer counts across
 * providers), and binds each request with a KB-JWT (§4.2).
 */
import {
  actionDigest,
  actionStatement,
  bindKey,
  type CandidateElement,
  CONSENT_SCOPES,
  type ConsentScope,
  candidateDataDigest,
  type DisclosedClaim,
  evaluateScope,
  type JobPostingFacts,
  jobFacts,
  newNonce,
  normalizeCandidate,
  parseSdJwt,
  parseStandingMandate,
  presentSdJwt,
  randomInt,
  reconstructClaims,
  type Signer,
  type StandingMandateClaims,
  type Tool,
  thumbprint,
} from "@ojcp/credentials-core";
import type { AgentKeyring } from "./keyring.ts";
import { type TrustResolver, tierAtLeast } from "./trust.ts";

/** What the issuer returned in the Token Response `authorization_details` (RFC 0008 §3.2). */
export interface MandateTerms {
  applications_total: number;
  salary_floor?: { value: number; currency: string; unitText: string };
}

export interface HeldCredential {
  compact: string;
  keyThumbprint: string;
  /** Where it has been presented: one application pair, or one resource server for search (§4.1). */
  use?:
    | { kind: "application"; origin: string; employerId: string }
    | { kind: "search"; origin: string; count: number };
}

export interface HeldBatch {
  id: string;
  iss: string;
  terms: MandateTerms;
  credentials: HeldCredential[];
  /** The full mandate, every allow-list element included (the holder has every disclosure). */
  mandate: StandingMandateClaims;
  revoked?: boolean;
}

export interface SubmissionRecord {
  batchId: string;
  employerId: string;
  origin: string;
  at: number;
}

/** Persistence for batches and the agent's own counts. In-memory by default. */
export interface HolderStore {
  batches(): Promise<HeldBatch[]>;
  saveBatch(batch: HeldBatch): Promise<void>;
  submissions(batchId: string): Promise<SubmissionRecord[]>;
  recordSubmission(record: SubmissionRecord): Promise<void>;
}

export class InMemoryHolderStore implements HolderStore {
  readonly #batches = new Map<string, HeldBatch>();
  readonly #submissions: SubmissionRecord[] = [];
  async batches(): Promise<HeldBatch[]> {
    return [...this.#batches.values()];
  }
  async saveBatch(batch: HeldBatch): Promise<void> {
    this.#batches.set(batch.id, batch);
  }
  async submissions(batchId: string): Promise<SubmissionRecord[]> {
    return this.#submissions.filter((s) => s.batchId === batchId);
  }
  async recordSubmission(record: SubmissionRecord): Promise<void> {
    this.#submissions.push(record);
  }
}

export type RefusalReason =
  | "no_mandate"
  | "not_permitted"
  | "not_covered"
  | "trust"
  | "binding_actions"
  | "eeo"
  | "consent_scope"
  | "total_reached"
  | "per_employer_reached"
  | "no_credential";

/** The mandate doesn't cover this: ask the user, or use an action mandate. */
export class StandingMandateRefusal extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.name = "StandingMandateRefusal";
    this.reason = reason;
  }
}

export interface ExerciseInput {
  tool: Tool;
  /** The provider's resource-server origin. */
  origin: string;
  /** The OJCP version the provider speaks. */
  ojcpVersion: string;
  /** Application tools. */
  job?: JobPostingFacts;
  employerId?: string;
  session?: {
    application_id?: string;
    mandate_nonce?: string;
    binding_actions?: readonly unknown[];
  };
  /** The tool arguments the action statement digests. */
  request?: {
    application_data?: Record<string, unknown>;
    candidate_context?: Record<string, unknown>;
  };
  consentScope?: ConsentScope;
}

export interface Exercise {
  /** `agent_declaration.user_mandate`. */
  userMandate: string;
  /** Sign the request with this key: the credential's `cnf` key. */
  signer: Signer;
  /** Use this as the request signature's `nonce`. */
  signatureNonce: string;
  batchId: string;
}

const APPLICATION_TOOLS = new Set<Tool>(["begin_application", "submit_application"]);

export interface StandingMandateHolderOptions {
  keyring: AgentKeyring;
  agentId: string;
  trust: TrustResolver;
  store?: HolderStore;
  now?: () => number;
}

export class StandingMandateHolder {
  readonly #keyring: AgentKeyring;
  readonly #agentId: string;
  readonly #trust: TrustResolver;
  readonly #store: HolderStore;
  readonly #now: () => number;

  constructor(options: StandingMandateHolderOptions) {
    this.#keyring = options.keyring;
    this.#agentId = options.agentId;
    this.#trust = options.trust;
    this.#store = options.store ?? new InMemoryHolderStore();
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Stores a batch received from an issuer. */
  async addBatch(input: {
    id: string;
    terms: MandateTerms;
    credentials: readonly string[];
  }): Promise<HeldBatch> {
    if (input.credentials.length === 0) throw new TypeError("empty batch");
    const held: HeldCredential[] = [];
    let mandate: StandingMandateClaims | undefined;
    for (const compact of input.credentials) {
      const parsed = await parseSdJwt(compact);
      const full = parseStandingMandate(
        reconstructClaims(parsed.payload, parsed.disclosures).claims,
      );
      if (full.agent_id !== this.#agentId) throw new TypeError("credential names another agent");
      const keyThumbprint = await thumbprint(full.cnf.jwk);
      if (!this.#keyring.mandateKey(keyThumbprint))
        throw new TypeError("credential bound to a key this platform doesn't hold");
      held.push({ compact, keyThumbprint });
      mandate ??= full;
    }
    const batch: HeldBatch = {
      id: input.id,
      iss: (mandate as StandingMandateClaims).iss,
      terms: input.terms,
      credentials: held,
      mandate: mandate as StandingMandateClaims,
    };
    await this.#store.saveBatch(batch);
    return batch;
  }

  /** Marks a batch revoked locally (the user revoked at the issuer). */
  async revokeBatch(id: string): Promise<void> {
    const batch = (await this.#store.batches()).find((b) => b.id === id);
    if (batch) await this.#store.saveBatch({ ...batch, revoked: true });
  }

  /** Records a terminal successful submission; call once per application. */
  async recordSubmission(batchId: string, origin: string, employerId: string): Promise<void> {
    await this.#store.recordSubmission({ batchId, origin, employerId, at: this.#now() });
  }

  /** Builds `user_mandate` for one request, or refuses with the reason. */
  async exercise(input: ExerciseInput): Promise<Exercise> {
    const now = this.#now();
    const batches = (await this.#store.batches()).filter(
      (b) =>
        !b.revoked &&
        b.mandate.nbf <= now &&
        now < b.mandate.exp &&
        b.mandate.actions.includes(input.tool) &&
        !b.mandate.prohibited.includes(input.tool),
    );
    if (batches.length === 0)
      throw new StandingMandateRefusal(
        "no_mandate",
        "no current standing mandate permits this tool",
      );

    const isApplication = APPLICATION_TOOLS.has(input.tool);
    let lastRefusal: StandingMandateRefusal | undefined;
    for (const batch of batches) {
      try {
        return isApplication
          ? await this.#application(batch, input)
          : await this.#search(batch, input);
      } catch (error) {
        if (!(error instanceof StandingMandateRefusal)) throw error;
        lastRefusal = error;
      }
    }
    throw lastRefusal as StandingMandateRefusal;
  }

  async #search(batch: HeldBatch, input: ExerciseInput): Promise<Exercise> {
    // §4.1: never an application credential; never two resource servers; fresh where possible.
    const fresh = batch.credentials.filter((c) => !c.use);
    const sameOrigin = batch.credentials.filter(
      (c) => c.use?.kind === "search" && c.use.origin === input.origin,
    );
    const pool = fresh.length > 0 ? fresh : sameOrigin;
    if (pool.length === 0)
      throw new StandingMandateRefusal("no_credential", "batch exhausted; refresh it");
    const credential = pool[randomInt(pool.length)] as HeldCredential;
    credential.use = {
      kind: "search",
      origin: input.origin,
      count: (credential.use?.kind === "search" ? credential.use.count : 0) + 1,
    };
    await this.#store.saveBatch(batch);
    const signatureNonce = newNonce();
    const presentation = await presentSdJwt(
      credential.compact,
      (c) => c.path[0] === "actions" && c.disclosure.value === input.tool,
    );
    return this.#bind(
      batch,
      credential,
      presentation,
      { aud: input.origin, nonce: signatureNonce },
      signatureNonce,
    );
  }

  async #application(batch: HeldBatch, input: ExerciseInput): Promise<Exercise> {
    const m = batch.mandate;
    const { job, employerId } = input;
    if (!job || !employerId) throw new TypeError("application tools need job and employerId");
    const isSubmit = input.tool === "submit_application";

    // §5.3: provider trust, from derivation only.
    const tier = await this.#trust.effectiveTier(input.origin);
    if (
      tier?.source !== "derived" ||
      !tierAtLeast(tier.tier, "verified") ||
      !tierAtLeast(tier.tier, m.provider_trust_floor)
    )
      throw new StandingMandateRefusal(
        "trust",
        "provider's derived trust tier is below the mandate's floor",
      );
    if (
      input.consentScope &&
      CONSENT_SCOPES.indexOf(input.consentScope) > CONSENT_SCOPES.indexOf(m.consent_scope)
    )
      throw new StandingMandateRefusal(
        "consent_scope",
        "consent_scope above the mandate's ceiling",
      );

    // §2.2: coverage on the full scope, which also applies the floor (rungs start at it).
    const coverage = evaluateScope(m.scope, jobFacts(job, m.scope.taxonomy));
    if (!coverage.covered)
      throw new StandingMandateRefusal(
        "not_covered",
        `job not covered: ${coverage.failures.join(", ")}`,
      );

    if (isSubmit) {
      // §5.1, §5.2: fail closed on binding actions and EEO.
      const ba = input.session?.binding_actions;
      if (!ba || ba.length > 0)
        throw new StandingMandateRefusal("binding_actions", "binding actions need the user");
      if (input.request?.application_data?.eeo !== undefined)
        throw new StandingMandateRefusal("eeo", "EEO data needs per-submission consent");
      const submissions = await this.#store.submissions(batch.id);
      if (submissions.length >= batch.terms.applications_total)
        throw new StandingMandateRefusal("total_reached", "the user's total is used up");
      if (submissions.filter((s) => s.employerId === employerId).length >= m.limits.per_employer)
        throw new StandingMandateRefusal("per_employer_reached", "per-employer limit reached");
    }

    // §2.3: exactly one candidate element, the one this application uses.
    const contact = input.request?.candidate_context?.email;
    const candidate = this.#pickCandidate(
      m.candidate,
      typeof contact === "string" ? contact : undefined,
    );
    if (!candidate)
      throw new StandingMandateRefusal(
        "not_covered",
        "no candidate binding matches the application's contact",
      );

    const credential = this.#credentialFor(batch, input.origin, employerId);
    const keyThumbprint = credential.keyThumbprint;
    const statement = actionStatement({
      ojcp_version: input.ojcpVersion,
      resource_server: input.origin,
      ...(job.employer?.ojcp_employer_id
        ? { employer: { ojcp_employer_id: job.employer.ojcp_employer_id } }
        : {}),
      tool: input.tool,
      job_id: job.ojcp_id,
      agent_id: this.#agentId,
      agent_key_thumbprint: keyThumbprint,
      ...(isSubmit
        ? {
            application_id: input.session?.application_id,
            mandate_nonce: input.session?.mandate_nonce,
            candidate_data_digest: await candidateDataDigest(input.request ?? {}),
          }
        : {
            ...(input.request?.candidate_context
              ? {
                  candidate_data_digest: await candidateDataDigest({
                    candidate_context: input.request.candidate_context,
                  }),
                }
              : {}),
            ...(input.consentScope ? { consent_scope: input.consentScope } : {}),
          }),
    });
    const d = coverage.disclose;
    const wanted = (c: DisclosedClaim): boolean => {
      const [head, sub] = c.path;
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      if (head === "actions") return c.disclosure.value === input.tool;
      if (head === "candidate")
        return same(normalizeCandidate(c.disclosure.value as CandidateElement), candidate);
      if (head !== "scope") return false;
      if (sub === "job_families") return c.disclosure.value === d.job_family;
      if (sub === "locations") return same(c.disclosure.value, d.location);
      if (sub === "remote_policy") return c.disclosure.value === d.remote_policy;
      if (sub === "employment_type") return c.disclosure.value === d.employment_type;
      if (sub === "experience_level") return c.disclosure.value === d.experience_level;
      if (sub === "salary") return same(c.disclosure.value, d.salary);
      return false;
    };
    const presentation = await presentSdJwt(credential.compact, wanted);
    const signatureNonce = newNonce();
    const kbNonce = isSubmit ? input.session?.mandate_nonce : signatureNonce;
    if (!kbNonce) throw new TypeError("submit_application needs the session's mandate_nonce");
    await this.#store.saveBatch(batch);
    return this.#bind(
      batch,
      credential,
      presentation,
      { aud: input.origin, nonce: kbNonce, ojcp_action: await actionDigest(statement) },
      signatureNonce,
    );
  }

  #pickCandidate(
    elements: readonly CandidateElement[],
    contact: string | undefined,
  ): CandidateElement | undefined {
    const normalized = elements.map(normalizeCandidate);
    if (contact === undefined) return normalized.find((e) => "email" in e) ?? normalized[0];
    const target = JSON.stringify(
      normalizeCandidate(contact.includes("@") ? { email: contact } : { phone: contact }),
    );
    return normalized.find((e) => JSON.stringify(e) === target);
  }

  /** §4.1: one credential per (resource server, employer), never presented elsewhere. */
  #credentialFor(batch: HeldBatch, origin: string, employerId: string): HeldCredential {
    const assigned = batch.credentials.find(
      (c) =>
        c.use?.kind === "application" && c.use.origin === origin && c.use.employerId === employerId,
    );
    if (assigned) return assigned;
    const fresh = batch.credentials.filter((c) => !c.use);
    if (fresh.length === 0)
      throw new StandingMandateRefusal("no_credential", "batch exhausted; refresh it");
    const chosen = fresh[randomInt(fresh.length)] as HeldCredential;
    chosen.use = { kind: "application", origin, employerId };
    return chosen;
  }

  async #bind(
    batch: HeldBatch,
    credential: HeldCredential,
    presentation: string,
    kb: { aud: string; nonce: string; ojcp_action?: string },
    signatureNonce: string,
  ): Promise<Exercise> {
    const signer = this.#keyring.signerFor(credential.keyThumbprint);
    if (!signer) throw new StandingMandateRefusal("no_credential", "mandate key no longer held");
    return {
      userMandate: await bindKey(presentation, { ...kb, iat: this.#now() }, signer),
      signer,
      signatureNonce,
      batchId: batch.id,
    };
  }
}
