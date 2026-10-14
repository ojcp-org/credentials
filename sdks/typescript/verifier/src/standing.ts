/**
 * Standing-mandate verification (RFC 0008 §8, steps 1–6). Step 7, binding the
 * decision to the application session, is the provider's: it stores the
 * returned decision with the session.
 */
import {
  type ActionStatement,
  actionDigest,
  type CandidateElement,
  CONSENT_SCOPES,
  type ConsentScope,
  checkDisclosureRule,
  evaluateScope,
  isMonthEpoch,
  isOjcpError,
  isRecord,
  type JobPostingFacts,
  type JWK,
  jobFacts,
  monthsBetween,
  normalizeCandidate,
  type OjcpError,
  parseSdJwt,
  parseStandingMandate,
  reconstructClaims,
  STANDING_MANDATE_VCT,
  type StandingMandateClaims,
  type Tool,
  thumbprint,
  type UserMandatesPolicy,
  verifyKeyBinding,
} from "@ojcp/credentials-core";
import { MandateRejected, type MandateRejectionReason } from "./errors.ts";
import { type PinnedKey, verifyWithPins } from "./issuers.ts";
import { type CommitResult, countKey, type MandateLedger } from "./ledger.ts";
import type { StatusSource } from "./status.ts";

/** The output of agent-identity verification (spec *Agent Identity → Verification*). */
export interface VerifiedAgent {
  agent_id: string;
  /** RFC 7638 thumbprint of the key that signed the request. */
  keyid: string;
  jwk: JWK;
  /** The RFC 9421 signature's `nonce`. */
  nonce: string;
  created: number;
  expires: number;
}

/** An issuer in the provider's mandate-admission policy (spec *Mandate Admission*). */
export interface AdmittedMandateIssuer {
  iss: string;
  keys: readonly PinnedKey[];
  /** Mandate types admitted from this issuer. */
  types: ReadonlyArray<"standing" | "action">;
  /** Tools this issuer's mandates are admitted for; defaults to RFC 0008 §5.4. */
  tools?: readonly Tool[];
  /** agent_ids this issuer shares control with; listed as affiliated in `policy_id` (§2.3). */
  affiliatedAgentIds?: readonly string[];
}

export interface MandatePolicy {
  /** The resource server's origin: every `aud` and `resource_server` must equal it. */
  origin: string;
  manifest: UserMandatesPolicy;
  issuers: readonly AdmittedMandateIssuer[];
  ojcpVersions: readonly string[];
  status: StatusSource;
  ledger: MandateLedger;
  /** RFC 0008 §6.1: a separate secret per `ojcp_employer_id`. */
  countSecret(employerId: string): Promise<Uint8Array>;
  /** For `jkt` candidate bindings: whether the provider bound this key to the candidate's account. */
  isBoundUserKey?(jkt: string): Promise<boolean>;
  /** Unix seconds. */
  now?: () => number;
}

const APPLICATION_TOOLS = new Set<Tool>(["begin_application", "submit_application"]);
const KB_MAX_AGE = 300;
const STATUS_MAX_AGE = 3600;

export interface StandingMandateRequest {
  /** `agent_declaration.user_mandate`. */
  presentation: string;
  agent: VerifiedAgent;
  tool: Tool;
  /** Required for application tools. */
  employerId?: string;
  /** The job, for application tools, as the provider holds it. */
  job?: JobPostingFacts;
  /** The action statement the provider rebuilt from its own session state. */
  statement?: ActionStatement;
  session?: {
    /** Issued with the session; the KB-JWT nonce for submit_application. */
    mandate_nonce?: string;
    /** As returned by begin_application. Absent means the provider didn't send it. */
    binding_actions?: readonly unknown[];
    /** The candidate element disclosed at begin_application. */
    candidate?: CandidateElement;
  };
  /** submit_application: the contact the request carries (`candidate_context.email`). */
  submittedContact?: { email?: string; phone?: string };
  /** submit_application: whether `application_data.eeo` is present. */
  hasEeo?: boolean;
  /** The `consent_scope` the agent declares in `candidate_context`. */
  consentScope?: ConsentScope;
}

export interface StandingMandateDecision {
  iss: string;
  mandate: StandingMandateClaims;
  /** The disclosed candidate element; store it with the session at begin_application. */
  candidate?: CandidateElement;
  /** For application tools, the verified `ojcp_action`. */
  action?: string;
  /** Set when this submission retries one already committed: return this outcome. */
  priorOutcome?: unknown;
  /** submit_application only: atomically consume `mandate_nonce` and count, after the application is created. */
  commit?(outcome: unknown): Promise<CommitResult>;
}

/** Reads the contact `submit_application` carries. */
export function submittedContact(request: { candidate_context?: unknown }): { email?: string } {
  const ctx = request.candidate_context;
  return isRecord(ctx) && typeof ctx.email === "string" ? { email: ctx.email } : {};
}

function reject(kind: OjcpError["kind"], message: string, reason?: MandateRejectionReason): never {
  throw new MandateRejected(kind, message, reason);
}

const BREADTH_ORDER = { narrow: 0, broad: 1 } as const;

/** RFC 0008 §2.1 rule 3: each disclosed element is a scalar or a flat object without `_sd` or `...`. */
function checkDisclosedElements(values: readonly unknown[]): void {
  for (const value of values) {
    if (Array.isArray(value)) reject("disclosure_rule", "disclosed element is an array");
    if (!isRecord(value)) continue;
    for (const [k, v] of Object.entries(value)) {
      if (k === "_sd" || k === "...") reject("disclosure_rule", `disclosed element contains ${k}`);
      if (typeof v === "object" && v !== null)
        reject("disclosure_rule", "disclosed element is not flat");
    }
  }
}

function sameCandidate(a: CandidateElement, b: CandidateElement): boolean {
  return JSON.stringify(normalizeCandidate(a)) === JSON.stringify(normalizeCandidate(b));
}

export async function verifyStandingMandate(
  policy: MandatePolicy,
  request: StandingMandateRequest,
): Promise<StandingMandateDecision> {
  try {
    return await verify(policy, request);
  } catch (error) {
    if (error instanceof MandateRejected) throw error;
    if (isOjcpError(error)) throw new MandateRejected(error.kind, error.message);
    throw error;
  }
}

async function verify(
  policy: MandatePolicy,
  request: StandingMandateRequest,
): Promise<StandingMandateDecision> {
  const now = policy.now?.() ?? Math.floor(Date.now() / 1000);
  const standing = policy.manifest.standing;
  if (!policy.manifest.types.includes("standing") || !standing)
    reject("not_admitted", "provider admits no standing mandates");

  // ── 1. Credential and holder proof ─────────────────────────────────────────
  const parsed = await parseSdJwt(request.presentation);
  if (parsed.header.typ !== "dc+sd-jwt") reject("malformed", "typ must be dc+sd-jwt");
  const iss = parsed.payload.iss;
  const issuer = policy.issuers.find((i) => i.iss === iss && i.types.includes("standing"));
  if (!issuer) reject("not_admitted", "issuer not admitted for standing mandates");
  await verifyWithPins(parsed.jwt, issuer.keys);
  checkDisclosureRule(parsed.payload);
  checkDisclosedElements(parsed.disclosures.map((d) => d.value));
  const { claims } = reconstructClaims(parsed.payload, parsed.disclosures);
  const mandate = parseStandingMandate(claims);
  const cnf = mandate.cnf.jwk as JWK;
  if (cnf.kty !== "EC" || cnf.crv !== "P-256") reject("invalid_claims", "cnf must be a P-256 key");
  const kb = await verifyKeyBinding(parsed, cnf);
  if (kb.header.alg !== "ES256") reject("invalid_signature", "KB-JWT must be ES256");
  if ((await thumbprint(cnf)) !== request.agent.keyid)
    reject("binding_mismatch", "cnf is not the request's signing key");
  if (mandate.agent_id !== request.agent.agent_id)
    reject("binding_mismatch", "agent_id differs from the verified agent");
  if (kb.payload.iat < request.agent.created - KB_MAX_AGE || kb.payload.iat > request.agent.expires)
    reject("expired", "KB-JWT iat is outside the request signature window");

  // ── 2. Admission ───────────────────────────────────────────────────────────
  if (!standing.vct_values.includes(STANDING_MANDATE_VCT))
    reject("not_admitted", "vct not admitted");
  if (policy.manifest.action_mandate_required_for.includes(request.tool))
    reject("not_admitted", "this tool needs an action mandate", "action_mandate_required");
  const admittedTools =
    issuer.tools ??
    ([
      "search_jobs",
      "get_job_detail",
      "get_employer_context",
      "begin_application",
      "submit_application",
      "check_application_status",
    ] as const);
  if (!admittedTools.includes(request.tool))
    reject("not_admitted", "issuer not admitted for this tool");
  if (BREADTH_ORDER[mandate.breadth] > BREADTH_ORDER[standing.max_breadth])
    reject("policy", "breadth above policy", "exceeds_provider_policy");
  if (mandate.limits.per_employer > standing.max_per_employer)
    reject("policy", "per_employer above policy", "exceeds_provider_policy");

  // ── 3. Audience, time, version ─────────────────────────────────────────────
  if (kb.payload.aud !== policy.origin)
    reject("binding_mismatch", "KB-JWT aud is not this resource server");
  if (now < mandate.nbf) reject("not_yet_valid", "mandate not yet valid");
  if (now >= mandate.exp) reject("expired", "mandate expired");
  if (!isMonthEpoch(mandate.nbf) || !isMonthEpoch(mandate.exp))
    reject("invalid_claims", "nbf and exp must be month epochs");
  const months = monthsBetween(mandate.nbf, mandate.exp);
  if (months < 1 || months > 3) reject("invalid_claims", "lifetime must be one to three months");
  if (months > standing.max_lifetime_months)
    reject("policy", "lifetime above policy", "exceeds_provider_policy");
  if (!policy.ojcpVersions.includes(mandate.ojcp_version))
    reject("invalid_claims", "unsupported ojcp_version");
  if (!standing.taxonomies.includes(mandate.scope.taxonomy))
    reject("invalid_claims", "unsupported taxonomy");

  // ── 4. Action and scope ────────────────────────────────────────────────────
  if (!mandate.actions.includes(request.tool) || mandate.prohibited.includes(request.tool))
    reject("prohibited", "tool not permitted by the mandate");
  const isSubmit = request.tool === "submit_application";
  const expectedNonce = isSubmit ? request.session?.mandate_nonce : request.agent.nonce;
  if (!expectedNonce || kb.payload.nonce !== expectedNonce)
    reject("replayed", "KB-JWT nonce does not match");
  if (
    request.consentScope !== undefined &&
    CONSENT_SCOPES.indexOf(request.consentScope) > CONSENT_SCOPES.indexOf(mandate.consent_scope)
  )
    reject("policy", "consent_scope above the mandate's ceiling");

  let candidate: CandidateElement | undefined;
  let action: string | undefined;
  if (APPLICATION_TOOLS.has(request.tool)) {
    if (!request.job || !request.statement || !request.employerId)
      reject("invalid_claims", "application context missing");
    const coverage = evaluateScope(mandate.scope, jobFacts(request.job, mandate.scope.taxonomy));
    if (!coverage.covered)
      reject("not_covered", `job not covered: ${coverage.failures.join(", ")}`);
    if (mandate.candidate.length !== 1)
      reject("binding_mismatch", "exactly one candidate element must be disclosed");
    candidate = normalizeCandidate(mandate.candidate[0] as CandidateElement);
    if ("jkt" in candidate) {
      if (!(await policy.isBoundUserKey?.(candidate.jkt)))
        reject("binding_mismatch", "jkt is not bound to the candidate");
    } else if (isSubmit) {
      if (!request.session?.candidate || !sameCandidate(candidate, request.session.candidate))
        reject("binding_mismatch", "candidate differs from begin_application");
      const contact = request.submittedContact ?? {};
      const submitted =
        "email" in candidate ? { email: contact.email ?? "" } : { phone: contact.phone ?? "" };
      if (!sameCandidate(candidate, submitted))
        reject("binding_mismatch", "candidate does not match the submitted contact");
    }
    if (isSubmit) {
      const ba = request.session?.binding_actions;
      if (!ba || ba.length > 0)
        reject("not_admitted", "binding actions need an action mandate", "action_mandate_required");
      if (request.hasEeo) reject("prohibited", "eeo is not allowed under a standing mandate");
    }
    if (request.statement.resource_server !== policy.origin)
      reject("binding_mismatch", "statement resource_server differs");
    if (request.statement.agent_key_thumbprint !== request.agent.keyid)
      reject("binding_mismatch", "statement key differs");
    action = await actionDigest(request.statement);
    if (kb.payload.ojcp_action !== action)
      reject("binding_mismatch", "ojcp_action does not match the rebuilt statement");
  }

  // ── 5. Status ──────────────────────────────────────────────────────────────
  await policy.status.requireValid({
    ...mandate.status.status_list,
    keys: issuer.keys,
    maxAge: STATUS_MAX_AGE,
  });

  const decision: StandingMandateDecision = {
    iss: issuer.iss,
    mandate,
    ...(candidate ? { candidate } : {}),
    ...(action ? { action } : {}),
  };
  if (!isSubmit) return decision;

  // ── 6. Replay and count ────────────────────────────────────────────────────
  const nonce = expectedNonce;
  const prior = await policy.ledger.consumed(nonce);
  if (prior) {
    if (prior.action !== action) reject("replayed", "mandate_nonce already consumed");
    return { ...decision, priorOutcome: prior.outcome };
  }
  const employerId = request.employerId as string;
  const key = await countKey(await policy.countSecret(employerId), employerId, candidate);
  const limit = Math.min(mandate.limits.per_employer, standing.max_per_employer);
  const windowStart = windowStartFor(now, standing.max_lifetime_months);
  if ((await policy.ledger.count(key, windowStart)) >= limit)
    reject("limit_reached", "per_employer limit reached");
  return {
    ...decision,
    commit: (outcome) =>
      policy.ledger.commit({
        nonces: [nonce],
        action: action as string,
        count: { key, limit, windowStart },
        at: now,
        outcome,
      }),
  };
}

/** The trailing count window: the provider's maximum lifetime, in calendar months (§6.1). */
export function windowStartFor(now: number, months: number): number {
  const d = new Date(now * 1000);
  return Math.floor(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() - months,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ) / 1000,
  );
}
