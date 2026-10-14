/**
 * Action mandates (spec *User Mandates*, RFC 0003), agent side: the agent
 * builds the action statement the user approves, and presents the resulting
 * mandate with a key-binding proof by its signing key.
 */
import {
  type ActionStatement,
  type ActionStatementInput,
  actionDigest,
  actionStatement,
  bindKey,
  candidateDataDigest,
  parseSdJwt,
  type Signer,
  thumbprint,
} from "@ojcp/credentials-core";

/** The statement to show the user and send to their mandate issuer. */
export async function statementForApproval(
  input: Omit<ActionStatementInput, "agent_key_thumbprint" | "candidate_data_digest">,
  signer: Signer,
  request: { application_data?: unknown; candidate_context?: unknown },
): Promise<{ statement: ActionStatement; digest: string }> {
  const hasData = request.application_data !== undefined || request.candidate_context !== undefined;
  const statement = actionStatement({
    ...input,
    agent_key_thumbprint: await thumbprint(signer.publicJwk),
    ...(hasData ? { candidate_data_digest: await candidateDataDigest(request) } : {}),
  });
  return { statement, digest: await actionDigest(statement) };
}

/**
 * Presents an action mandate: all its disclosures, plus a KB-JWT by the agent
 * signing key named in `cnf.jkt`. `nonce` is the request signature's nonce, or
 * the session `mandate_nonce` for submit_application.
 */
export async function presentActionMandate(
  mandate: string,
  options: { aud: string; nonce: string; signer: Signer; iat?: number },
): Promise<string> {
  const parsed = await parseSdJwt(mandate);
  if (parsed.kbJwt) throw new TypeError("mandate already carries a key-binding JWT");
  return bindKey(
    parsed.withoutKb,
    { aud: options.aud, nonce: options.nonce, ...(options.iat ? { iat: options.iat } : {}) },
    options.signer,
  );
}
