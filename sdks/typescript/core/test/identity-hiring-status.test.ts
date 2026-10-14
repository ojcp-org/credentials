import { describe, expect, it } from "vitest";
import {
  AgentSignatureError,
  bindsByDelegation,
  bindsByNamespace,
  isValidAgentId,
  signRequest,
  verifyRequest,
} from "../src/agent-identity.ts";
import { utf8 } from "../src/encoding.ts";
import {
  hiringCredentialClaims,
  parseHiringCredential,
  withCoarseClaims,
} from "../src/hiring/types.ts";
import { generateSigner, type JWK, thumbprint } from "../src/keys.ts";
import {
  issueSdJwt,
  parseSdJwt,
  presentSdJwt,
  reconstructClaims,
  selectClaimsPaths,
} from "../src/sd-jwt.ts";
import {
  OjcpStatusList,
  readStatusListToken,
  Status,
  signStatusListToken,
} from "../src/status-list.ts";
import { TYPE_METADATA, vctIntegrity } from "../src/vct.ts";

describe("agent identity", () => {
  it("signs and verifies a request, then catches tampering and replay", async () => {
    const signer = await generateSigner("EdDSA");
    const body = utf8(JSON.stringify({ jsonrpc: "2.0", method: "tools/call" }));
    const req = {
      method: "POST",
      url: "https://careers.acme.com/ojcp/mcp?limit=10",
      headers: new Headers({ "content-type": "application/json" }),
      body,
    };
    const signed = await signRequest(req, { signer, signatureAgent: "https://agent.wayfarer.ai" });
    const keyid = await thumbprint(signer.publicJwk);
    const seen = new Set<string>();
    const options = {
      resolveKey: async (origin: string, kid: string): Promise<JWK | undefined> =>
        origin === "https://agent.wayfarer.ai" && kid === keyid ? signer.publicJwk : undefined,
      seenNonce: async (kid: string, nonce: string) => {
        const key = `${kid}:${nonce}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      },
    };
    const verified = await verifyRequest({ ...req, headers: signed.headers }, options);
    expect(verified).toMatchObject({
      keyid,
      signatureAgent: "https://agent.wayfarer.ai",
      nonce: signed.nonce,
    });

    await expect(verifyRequest({ ...req, headers: signed.headers }, options)).rejects.toMatchObject(
      { code: "agent_nonce_replayed" },
    );
    const tampered = await signRequest(req, {
      signer,
      signatureAgent: "https://agent.wayfarer.ai",
    });
    await expect(
      verifyRequest(
        { ...req, url: "https://careers.acme.com/ojcp/mcp?limit=99", headers: tampered.headers },
        options,
      ),
    ).rejects.toBeInstanceOf(AgentSignatureError);
    const body2 = await signRequest(req, { signer, signatureAgent: "https://agent.wayfarer.ai" });
    await expect(
      verifyRequest({ ...req, body: utf8("{}"), headers: body2.headers }, options),
    ).rejects.toMatchObject({
      code: "agent_digest_mismatch",
    });
    const stale = await signRequest(req, {
      signer,
      signatureAgent: "https://agent.wayfarer.ai",
      now: 1_000_000,
    });
    await expect(verifyRequest({ ...req, headers: stale.headers }, options)).rejects.toMatchObject({
      code: "agent_signature_expired",
    });
  });

  it("applies the agent_id grammar and binding rules from the spec's table", () => {
    expect(isValidAgentId("ai.wayfarer.agent")).toBe(true);
    expect(isValidAgentId("AI.wayfarer")).toBe(false);
    expect(isValidAgentId("wayfarer")).toBe(false);
    expect(bindsByNamespace("ai.wayfarer.agent", "https://agent.wayfarer.ai")).toBe(true);
    expect(bindsByNamespace("ai.wayfarer.agent", "https://wayfarer.ai")).toBe(true);
    expect(bindsByNamespace("ai.wayfarer.agent", "https://evil.wayfarer.ai")).toBe(false);
    expect(bindsByNamespace("io.github.bob.agent", "https://alice.github.io")).toBe(false);
    expect(bindsByNamespace("ai.wayfarerx.agent", "https://wayfarer.ai")).toBe(false);
    const doc = { agent_id: "com.acme.agent", signers: ["https://acme.agentplatform.example"] };
    expect(bindsByDelegation("com.acme.agent", "https://acme.agentplatform.example", doc)).toBe(
      true,
    );
    expect(bindsByDelegation("com.acme.agent", "https://other.example", doc)).toBe(false);
  });
});

describe("hiring credentials", () => {
  it("derives coarse claims without overstating tenure", () => {
    const iat = new Date("2026-10-13T00:00:00Z");
    expect(
      withCoarseClaims(
        "employment",
        { organization: { name: "Globex" }, current: true, start: "2021-06" },
        iat,
      ),
    ).toMatchObject({
      start_year: 2021,
      tenure_years: 5,
    });
    expect(
      withCoarseClaims(
        "employment",
        { organization: { name: "Globex" }, current: true, start: "2021" },
        iat,
      ),
    ).toMatchObject({
      tenure_years: 4,
    });
  });

  it("issues and validates an employment record with selective disclosure", async () => {
    const issuer = await generateSigner("ES256");
    const holder = await generateSigner("ES256");
    const integrity = await vctIntegrity(TYPE_METADATA.employment);
    const claims = hiringCredentialClaims({
      type: "employment",
      issuer: "https://credentials.hrplatform.example",
      vctIntegrity: integrity,
      basis: "customer_records",
      record: {
        organization: { name: "Globex", id: "did:web:globex.example" },
        current: false,
        start: "2021-03",
        end: "2025-09",
        positionHistories: [{ title: "Data Analyst", start: "2021-03" }],
      },
      holderJwk: holder.publicJwk as Record<string, unknown>,
      status: { idx: 7, uri: "https://credentials.hrplatform.example/status/1" },
      now: new Date("2026-10-13T15:00:00Z"),
    });
    const { compact } = await issueSdJwt({ signer: issuer, claims });
    const presented = await presentSdJwt(compact, (c) =>
      ["organization", "tenure_years"].includes(String(c.disclosure.name)),
    );
    const p = await parseSdJwt(presented);
    const credential = parseHiringCredential(reconstructClaims(p.payload, p.disclosures).claims);
    expect(credential).toMatchObject({
      type: "employment",
      basis: "customer_records",
      record: { tenure_years: 4 },
    });
    expect(credential.record).not.toHaveProperty("start");
    expect(credential.iat % 86_400).toBe(0);

    expect(() =>
      hiringCredentialClaims({
        type: "employment",
        issuer: "x",
        vctIntegrity: integrity,
        basis: "customer_records",
        record: { organization: { name: "Globex" }, current: true },
        holderJwk: {},
        status: { idx: 1, uri: "https://x/1" },
        now: new Date(),
      }),
    ).toThrow(/organization id/);
    expect(() =>
      parseHiringCredential({ ...reconstructClaims(p.payload, p.disclosures).claims, salary: 1 }),
    ).toThrow(/outside employment/);
  });

  it("discloses exactly the nested claims of RFC 0013's worked example", async () => {
    const issuer = await generateSigner("ES256");
    const holder = await generateSigner("ES256");
    const claims = hiringCredentialClaims({
      type: "employment",
      issuer: "https://credentials.globex.example",
      vctIntegrity: await vctIntegrity(TYPE_METADATA.employment),
      basis: "own_records",
      record: {
        organization: { name: "Globex Corporation", id: "did:web:globex.example" },
        current: true,
        start: "2021-03-15",
        positionHistories: [
          { title: "Data Analyst", start: "2021-03-15" },
          { title: "Senior Data Analyst", start: "2024-01-08" },
        ],
      },
      holderJwk: holder.publicJwk as Record<string, unknown>,
      holderName: { given_name: "Maya", family_name: "Chen" },
      status: { idx: 7, uri: "https://credentials.globex.example/status/1" },
      now: new Date("2026-10-12T15:00:00Z"),
    });
    const { compact } = await issueSdJwt({ signer: issuer, claims });
    const presented = await presentSdJwt(
      compact,
      selectClaimsPaths([
        ["organization", "name"],
        ["current"],
        ["positionHistories", null, "title"],
      ]),
    );
    const p = await parseSdJwt(presented);
    const credential = parseHiringCredential(reconstructClaims(p.payload, p.disclosures).claims);
    expect(credential.record).toEqual({
      organization: { name: "Globex Corporation" },
      current: true,
      positionHistories: [{ title: "Data Analyst" }, { title: "Senior Data Analyst" }],
    });
  });
});

describe("status lists", () => {
  it("round-trips statuses through a signed token", async () => {
    const signer = await generateSigner("ES256");
    const list = OjcpStatusList.create();
    list.set(42, Status.INVALID);
    list.set(9_999, Status.SUSPENDED);
    const token = await signStatusListToken({
      uri: "https://issuer.example/status/1",
      list,
      signer,
      ttl: 3600,
      lifetime: 7200,
    });
    const read = readStatusListToken(token);
    expect(read.payload).toMatchObject({ sub: "https://issuer.example/status/1", ttl: 3600 });
    expect(read.list.get(42)).toBe(Status.INVALID);
    expect(read.list.get(9_999)).toBe(Status.SUSPENDED);
    expect(read.list.get(0)).toBe(Status.VALID);
    expect(() => OjcpStatusList.create(100)).toThrow(/at least 10000/);
  });
});
