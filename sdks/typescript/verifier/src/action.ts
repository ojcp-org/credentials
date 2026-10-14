/**
 * Action-mandate verification (spec *User Mandates → Verification*): a
 * short-lived mandate the user approves for one action, bound to the agent key,
 * the resource server and the action statement.
 */
import {
  type ActionStatement,
  actionDigest,
  isOjcpError,
  isRecord,
  type OjcpError,
  parseSdJwt,
  reconstructClaims,
  type Tool,
  verifyKeyBinding,
} from "@ojcp/credentials-core";
import { z } from "zod";
import { MandateRejected, type MandateRejectionReason } from "./errors.ts";
import { verifyWithPins } from "./issuers.ts";
import type { CommitResult } from "./ledger.ts";
import type { MandatePolicy, VerifiedAgent } from "./standing.ts";

const ActionMandateClaims = z.looseObject({
  iss: z.string(),
  aud: z.string(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
  exp: z.number().int(),
  jti: z.string().min(16),
  cnf: z.looseObject({ jkt: z.string() }),
  ojcp_version: z.string(),
  ojcp_action: z.union([
    z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    z.record(z.string(), z.unknown()),
  ]),
  status: z
    .looseObject({
      status_list: z.strictObject({ idx: z.number().int().nonnegative(), uri: z.url() }),
    })
    .optional(),
});
type ActionMandateClaims = z.infer<typeof ActionMandateClaims>;

const REQUIRED_FIELDS: Record<string, readonly (keyof ActionStatement)[]> = {
  submit_application: [
    "resource_server",
    "tool",
    "job_id",
    "application_id",
    "agent_id",
    "agent_key_thumbprint",
    "candidate_data_digest",
    "mandate_nonce",
  ],
  default: ["resource_server", "tool", "job_id", "agent_id", "agent_key_thumbprint"],
};

export interface ActionMandateRequest {
  presentation: string;
  agent: VerifiedAgent;
  tool: Tool;
  /** Rebuilt by the provider from the request and its session state. */
  statement: ActionStatement;
  /** submit_application: the session's `mandate_nonce`. */
  mandateNonce?: string;
  /** True when the resource server serves more than one employer: `employer` is then required. */
  multiTenant: boolean;
}

export interface ActionMandateDecision {
  iss: string;
  jti: string;
  action: string;
  priorOutcome?: unknown;
  /** Atomically consumes `jti` (and `mandate_nonce` for submissions) once the action succeeds. */
  commit(outcome: unknown): Promise<CommitResult>;
}

function reject(kind: OjcpError["kind"], message: string, reason?: MandateRejectionReason): never {
  throw new MandateRejected(kind, message, reason);
}

/** Compares an embedded statement field by field; unknown fields are ignored (spec *Action Statement*). */
function checkFields(
  embedded: Record<string, unknown>,
  statement: ActionStatement,
  required: readonly (keyof ActionStatement)[],
): void {
  for (const field of required) {
    if (embedded[field] === undefined)
      reject("binding_mismatch", `action statement lacks ${field}`);
    if (JSON.stringify(embedded[field]) !== JSON.stringify(statement[field]))
      reject("binding_mismatch", `action statement ${field} differs`);
  }
  for (const field of [
    "employer",
    "binding_actions_digest",
    "consent_scope",
    "candidate_data_digest",
  ] as const) {
    if (
      statement[field] !== undefined &&
      JSON.stringify(embedded[field]) !== JSON.stringify(statement[field])
    )
      reject("binding_mismatch", `action statement ${field} differs`);
  }
}

export async function verifyActionMandate(
  policy: MandatePolicy,
  request: ActionMandateRequest,
): Promise<ActionMandateDecision> {
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
  request: ActionMandateRequest,
): Promise<ActionMandateDecision> {
  const now = policy.now?.() ?? Math.floor(Date.now() / 1000);
  if (!policy.manifest.types.includes("action"))
    reject("not_admitted", "provider admits no action mandates");

  // 1. Credential signature and holder proof.
  const parsed = await parseSdJwt(request.presentation);
  const issuer = policy.issuers.find(
    (i) => i.iss === parsed.payload.iss && i.types.includes("action"),
  );
  // 2. Admission.
  if (!issuer) reject("not_admitted", "issuer not admitted for action mandates");
  await verifyWithPins(parsed.jwt, issuer.keys);
  const parsedClaims = ActionMandateClaims.safeParse(
    reconstructClaims(parsed.payload, parsed.disclosures).claims,
  );
  if (!parsedClaims.success) reject("invalid_claims", "action mandate claims are invalid");
  const m: ActionMandateClaims = parsedClaims.data;
  const kb = await verifyKeyBinding(parsed, request.agent.jwk);
  if (kb.payload.aud !== policy.origin)
    reject("binding_mismatch", "KB-JWT aud is not this resource server");
  const kbNonces = [request.agent.nonce, request.mandateNonce].filter(
    (n): n is string => typeof n === "string",
  );
  if (!kbNonces.includes(kb.payload.nonce)) reject("replayed", "KB-JWT nonce does not match");
  if (issuer.tools && !issuer.tools.includes(request.tool))
    reject("not_admitted", "issuer not admitted for this tool");

  // 3. Audience, time, version, agent key.
  if (m.aud !== policy.origin) reject("binding_mismatch", "aud is not this resource server");
  if (m.nbf !== undefined && now < m.nbf - 60) reject("not_yet_valid", "mandate not yet valid");
  if (now >= m.exp) reject("expired", "mandate expired");
  const maxLifetime = policy.manifest.action?.max_lifetime_seconds;
  if (maxLifetime !== undefined && m.exp - m.iat > maxLifetime)
    reject("policy", "lifetime above policy", "exceeds_provider_policy");
  if (!policy.ojcpVersions.includes(m.ojcp_version))
    reject("invalid_claims", "unsupported ojcp_version");
  if (m.cnf.jkt !== request.agent.keyid)
    reject("binding_mismatch", "cnf.jkt is not the request's signing key");

  // 4. Action statement.
  const statement = request.statement;
  if (statement.resource_server !== policy.origin)
    reject("binding_mismatch", "statement resource_server differs");
  if (request.multiTenant && !statement.employer)
    reject("binding_mismatch", "multi-tenant statements bind the employer");
  const action = await actionDigest(statement);
  if (typeof m.ojcp_action === "string") {
    if (m.ojcp_action !== action) reject("binding_mismatch", "ojcp_action digest does not match");
  } else {
    if (!isRecord(m.ojcp_action)) reject("malformed", "ojcp_action must be an object or digest");
    checkFields(
      m.ojcp_action,
      statement,
      REQUIRED_FIELDS[request.tool] ??
        (REQUIRED_FIELDS.default as readonly (keyof ActionStatement)[]),
    );
  }

  // 5. Status, or single use within a short lifetime.
  if (m.status)
    await policy.status.requireValid({ ...m.status.status_list, keys: issuer.keys, maxAge: 3600 });
  else if (maxLifetime === undefined || m.exp - m.iat > maxLifetime)
    reject("policy", "no status and no single-use lifetime bound");

  // 6. Replay.
  const nonces = [
    `jti:${m.iss}:${m.jti}`,
    ...(request.tool === "submit_application" && request.mandateNonce
      ? [request.mandateNonce]
      : []),
  ];
  for (const nonce of nonces) {
    const prior = await policy.ledger.consumed(nonce);
    if (prior) {
      if (prior.action !== action) reject("replayed", "mandate already consumed");
      return {
        iss: m.iss,
        jti: m.jti,
        action,
        priorOutcome: prior.outcome,
        commit: async () => ({ status: "duplicate", outcome: prior.outcome }),
      };
    }
  }
  return {
    iss: m.iss,
    jti: m.jti,
    action,
    commit: (outcome) => policy.ledger.commit({ nonces, action, at: now, outcome }),
  };
}
