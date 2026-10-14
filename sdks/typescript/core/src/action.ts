/**
 * Action statements (spec *User Mandates → Action Statement*, RFC 0009 §3.6):
 * what a mandate binds, and the digests agent and provider both reconstruct.
 */
import { ojcpDigest } from "./digest.ts";
import type { Tool } from "./wire.ts";

export interface ActionStatementInput {
  ojcp_version?: string;
  /** Origin of the OJCP endpoint; equals the mandate's `aud`. */
  resource_server: string;
  /** Required when the resource server serves more than one employer. */
  employer?: { ojcp_employer_id: string; official_job_url?: string };
  tool: Tool;
  job_id: string;
  agent_id: string;
  agent_key_thumbprint: string;
  /** Required for submit_application. */
  application_id?: string;
  candidate_data_digest?: string;
  mandate_nonce?: string;
  /** RFC 0009 §3.6: required for submit_application when binding_actions is non-empty. */
  binding_actions_digest?: string;
  /** Spec *Mandate Nonce*: begin_application binds the requested consent scope. */
  consent_scope?: string;
}

export type ActionStatement = Readonly<ActionStatementInput>;

const REQUIRED_FOR_SUBMIT = ["application_id", "candidate_data_digest", "mandate_nonce"] as const;

/** Builds an action statement, omitting absent members so agent and provider hash the same object. */
export function actionStatement(input: ActionStatementInput): ActionStatement {
  if (input.tool === "submit_application")
    for (const field of REQUIRED_FOR_SUBMIT)
      if (input[field] === undefined)
        throw new TypeError(`${field} is required for submit_application`);
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as ActionStatement;
}

export function actionDigest(statement: ActionStatement): Promise<string> {
  return ojcpDigest(statement);
}

/** `candidate_data_digest` over the request's `application_data` and `candidate_context`, exactly as sent. */
export function candidateDataDigest(request: {
  application_data?: unknown;
  candidate_context?: unknown;
}): Promise<string> {
  const material: Record<string, unknown> = {};
  if (request.application_data !== undefined) material.application_data = request.application_data;
  if (request.candidate_context !== undefined)
    material.candidate_context = request.candidate_context;
  return ojcpDigest(material);
}

/** RFC 0009 §3.6: digest of the session's `binding_actions` array exactly as returned. */
export function bindingActionsDigest(bindingActions: readonly unknown[]): Promise<string> {
  return ojcpDigest(bindingActions);
}
