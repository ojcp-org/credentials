import { presentActionMandate, statementForApproval } from "@ojcp/agent-wallet";
import {
  type ActionStatement,
  type GeneratedSigner,
  generateSigner,
  issueSdJwt,
  thumbprint,
} from "@ojcp/credentials-core";
import {
  InMemoryLedger,
  type MandatePolicy,
  StatusListCache,
  type VerifiedAgent,
  verifyActionMandate,
} from "@ojcp/verifier";
import { describe, expect, it } from "vitest";
import { MANIFEST, PROVIDER, START } from "./harness.ts";

const USER_ISS = "did:jwk:user-root";

async function setup() {
  const user = await generateSigner("ES256");
  const agentKey = await generateSigner("EdDSA");
  const keyid = await thumbprint(agentKey.publicJwk);
  const agent: VerifiedAgent = {
    agent_id: "ai.northstar.assistant",
    keyid,
    jwk: agentKey.publicJwk,
    nonce: "sig-nonce-1",
    created: START,
    expires: START + 60,
  };
  const policy: MandatePolicy = {
    origin: PROVIDER,
    manifest: MANIFEST,
    issuers: [{ iss: USER_ISS, keys: [{ jwk: user.publicJwk }], types: ["action"] }],
    ojcpVersions: ["0.3"],
    status: new StatusListCache({ fetch: async () => new Response("", { status: 404 }) }),
    ledger: new InMemoryLedger(),
    countSecret: async () => new Uint8Array(32),
    now: () => START,
  };
  const request = {
    application_data: { cover_letter: "Hi" },
    candidate_context: { consent_scope: "application_prefill", email: "jordan@example.com" },
  };
  const { statement, digest } = await statementForApproval(
    {
      ojcp_version: "0.3",
      resource_server: PROVIDER,
      employer: { ojcp_employer_id: "acme-corp" },
      tool: "submit_application",
      job_id: "careers.acme.com:analyst-1",
      application_id: "app_abc123",
      agent_id: agent.agent_id,
      mandate_nonce: "mn_session_nonce_123456",
    },
    agentKey,
    request,
  );
  return { user, agentKey, agent, policy, statement, digest };
}

async function mandate(
  user: GeneratedSigner,
  keyid: string,
  ojcpAction: unknown,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { compact } = await issueSdJwt({
    signer: user,
    header: { typ: "dc+sd-jwt" },
    claims: {
      iss: USER_ISS,
      aud: PROVIDER,
      iat: START,
      nbf: START,
      exp: START + 600,
      jti: "mnd_RGBLQJ-l7qj9DiNH",
      cnf: { jkt: keyid },
      ojcp_version: "0.3",
      ojcp_action: ojcpAction,
      ...overrides,
    },
  });
  return compact;
}

const verify = (
  policy: MandatePolicy,
  presentation: string,
  agent: VerifiedAgent,
  statement: ActionStatement,
) =>
  verifyActionMandate(policy, {
    presentation,
    agent,
    tool: "submit_application",
    statement,
    mandateNonce: "mn_session_nonce_123456",
    multiTenant: true,
  });

describe("action mandates (spec User Mandates, RFC 0003)", () => {
  it("accepts the digest form once, then refuses the replay", async () => {
    const { user, agentKey, agent, policy, statement, digest } = await setup();
    const presentation = await presentActionMandate(await mandate(user, agent.keyid, digest), {
      aud: PROVIDER,
      nonce: agent.nonce,
      signer: agentKey,
      iat: START,
    });
    const decision = await verify(policy, presentation, agent, statement);
    expect(await decision.commit({ application_id: "app_abc123" })).toEqual({
      status: "committed",
    });
    const retry = await verify(policy, presentation, agent, statement);
    expect(retry.priorOutcome).toEqual({ application_id: "app_abc123" });
    await expect(
      verify(policy, presentation, agent, { ...statement, job_id: "careers.acme.com:other" }),
    ).rejects.toMatchObject({ kind: "binding_mismatch" });
  });

  it("accepts the embedded object form, ignoring fields it doesn't recognize", async () => {
    const { user, agentKey, agent, policy, statement } = await setup();
    const embedded = { ...statement, future_field: "ignored" };
    const presentation = await presentActionMandate(await mandate(user, agent.keyid, embedded), {
      aud: PROVIDER,
      nonce: agent.nonce,
      signer: agentKey,
      iat: START,
    });
    await expect(verify(policy, presentation, agent, statement)).resolves.toMatchObject({
      jti: "mnd_RGBLQJ-l7qj9DiNH",
    });
    const { candidate_data_digest: _, ...missing } = statement;
    const p2 = await presentActionMandate(
      await mandate(user, agent.keyid, missing, { jti: "mnd_second_mandate_x" }),
      { aud: PROVIDER, nonce: agent.nonce, signer: agentKey, iat: START },
    );
    await expect(verify(policy, p2, agent, statement)).rejects.toMatchObject({
      kind: "binding_mismatch",
    });
  });

  it("refuses another agent key, a long lifetime, expiry and another audience", async () => {
    const { user, agentKey, agent, policy, statement, digest } = await setup();
    const bind = async (m: string) =>
      presentActionMandate(m, { aud: PROVIDER, nonce: agent.nonce, signer: agentKey, iat: START });
    await expect(
      verify(
        policy,
        await bind(await mandate(user, "someOtherThumbprint_aaaaaaaaaaaaaaaaaaaaaaaa", digest)),
        agent,
        statement,
      ),
    ).rejects.toMatchObject({ kind: "binding_mismatch" });
    const long = await verify(
      policy,
      await bind(await mandate(user, agent.keyid, digest, { exp: START + 3600 })),
      agent,
      statement,
    ).catch((e) => e);
    expect(long.toToolError()).toEqual({
      error_code: "user_mandate_required",
      message: expect.any(String),
      details: { reason: "exceeds_provider_policy" },
    });
    await expect(
      verify(
        { ...policy, now: () => START + 601 },
        await bind(await mandate(user, agent.keyid, digest)),
        agent,
        statement,
      ),
    ).rejects.toMatchObject({ kind: "expired" });
    await expect(
      verify(
        policy,
        await bind(await mandate(user, agent.keyid, digest, { aud: "https://other.example" })),
        agent,
        statement,
      ),
    ).rejects.toMatchObject({ kind: "binding_mismatch" });
    const otherAgent = await generateSigner("EdDSA");
    const byOther = await presentActionMandate(await mandate(user, agent.keyid, digest), {
      aud: PROVIDER,
      nonce: agent.nonce,
      signer: otherAgent,
      iat: START,
    });
    await expect(verify(policy, byOther, agent, statement)).rejects.toMatchObject({
      kind: "invalid_signature",
    });
  });
});
