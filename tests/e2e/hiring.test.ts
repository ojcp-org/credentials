import {
  bindKey,
  type ClaimsPathQuery,
  type GeneratedSigner,
  generateSigner,
  type JWK,
  presentSdJwt,
  selectClaimsPaths,
  signJws,
} from "@ojcp/credentials-core";
import {
  type AcceptedHiringIssuer,
  type HiringPresentationPolicy,
  StatusListCache,
  verifyHiringPresentation,
} from "@ojcp/verifier";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorld, ISSUER, type World } from "./harness.ts";

const ADMIN = { authorization: `Bearer ${"a".repeat(40)}`, "content-type": "application/json" };
const VERIFIER = "x509_hash:careers.acme.example";
const DCQL_PATHS: ClaimsPathQuery[] = [
  ["organization", "name"],
  ["current"],
  ["end_year"],
  ["positionHistories", null, "title"],
];

const MAYA = {
  type: "employment",
  basis: "own_records",
  record: {
    organization: { name: "Globex Corporation", id: "did:web:globex.example" },
    current: true,
    start: "2021-03-15",
    positionHistories: [
      { title: "Data Analyst", start: "2021-03-15", end: "2023-12-31" },
      { title: "Senior Data Analyst", start: "2024-01-08" },
    ],
  },
  holderName: { given_name: "Maya", family_name: "Chen" },
  personalEmail: "maya@proton.example",
  personalPhone: "+15555550123",
};

const Offer = z.object({
  grants: z.record(z.string(), z.object({ "pre-authorized_code": z.string() })),
});
const Token = z.object({ access_token: z.string() });
const Credentials = z.object({ credentials: z.array(z.object({ credential: z.string() })) });
const IssuerKeys = z.object({
  jwks: z.object({ keys: z.array(z.looseObject({ ojcp_sign_until: z.number() })) }),
});

/** The candidate's phone wallet redeeming an offer (OpenID4VCI pre-authorized code flow). */
async function redeem(world: World, holderKeys: GeneratedSigner[]): Promise<string[]> {
  const offerMail = [...world.messenger.sent]
    .reverse()
    .find((m) => m.text.includes("openid-credential-offer://"));
  const offerUri = decodeURIComponent(offerMail!.text.match(/credential_offer_uri=([^\s]+)/)![1]!);
  const offer = Offer.parse(await (await world.issuerFetch(offerUri)).json());
  const code = Object.values(offer.grants)[0]!["pre-authorized_code"];
  const txCode = world.messenger.lastCodeFor(MAYA.personalPhone);
  const token = Token.parse(
    await (
      await world.issuerFetch(`${ISSUER}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
          "pre-authorized_code": code,
          tx_code: txCode,
        }),
      })
    ).json(),
  );
  const { c_nonce } = z
    .object({ c_nonce: z.string() })
    .parse(await (await world.issuerFetch(`${ISSUER}/nonce`, { method: "POST" })).json());
  const proofs = await Promise.all(
    holderKeys.map((k) =>
      signJws(
        { typ: "openid4vci-proof+jwt", jwk: k.publicJwk },
        { aud: ISSUER, iat: world.clock.now, nonce: c_nonce },
        k,
      ),
    ),
  );
  const response = await world.issuerFetch(`${ISSUER}/credential`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      credential_configuration_id: "ojcp_employment",
      proofs: { jwt: proofs },
    }),
  });
  return Credentials.parse(await response.json()).credentials.map((c) => c.credential);
}

/** The provider's issuer policy, with keys pinned from the issuer's metadata (RFC 0013 §6.1). */
async function policyFor(
  world: World,
  overrides: Partial<AcceptedHiringIssuer> = {},
): Promise<HiringPresentationPolicy> {
  const metadata = IssuerKeys.parse(
    await (await world.issuerFetch(`${ISSUER}/.well-known/jwt-vc-issuer`)).json(),
  );
  const keys = metadata.jwks.keys.map((k) => ({ jwk: k as JWK, signUntil: k.ojcp_sign_until }));
  return {
    issuers: [
      {
        iss: ISSUER,
        keys,
        profile: "baseline",
        types: ["employment"],
        basis: ["own_records"],
        ...overrides,
      },
    ],
    profiles: { employment: ["baseline"] },
    status: new StatusListCache({
      fetch: (uri) => world.issuerFetch(uri),
      now: () => world.clock.now,
    }),
    now: () => world.clock.now,
  };
}

async function present(
  world: World,
  credential: string,
  holder: GeneratedSigner,
  paths: ClaimsPathQuery[],
  nonce = "req-nonce-1",
): Promise<string> {
  return bindKey(
    await presentSdJwt(credential, selectClaimsPaths(paths)),
    { aud: VERIFIER, nonce, iat: world.clock.now },
    holder,
  );
}

const request = {
  type: "employment" as const,
  nonce: "req-nonce-1",
  audience: VERIFIER,
  claims: DCQL_PATHS,
};

describe("RFC 0014 issuance to RFC 0013 presentation", () => {
  it("issues from an HR record, presents only what's asked, and drops the rest", async () => {
    const world = await createWorld();
    expect(
      (
        await world.issuerFetch(`${ISSUER}/admin/records/emp-1`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify(MAYA),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await world.issuerFetch(`${ISSUER}/admin/records/emp-1/offer`, {
          method: "POST",
          headers: ADMIN,
        })
      ).status,
    ).toBe(200);
    const holders = [await generateSigner("ES256"), await generateSigner("ES256")];
    const credentials = await redeem(world, holders);
    expect(credentials).toHaveLength(2);

    const policy = await policyFor(world);
    const validated = await verifyHiringPresentation(
      policy,
      await present(world, credentials[0]!, holders[0]!, DCQL_PATHS),
      request,
    );
    expect(validated.credential.record).toEqual({
      organization: { name: "Globex Corporation" },
      current: true,
      positionHistories: [{ title: "Data Analyst" }, { title: "Senior Data Analyst" }],
    });
    expect(validated.credential).toMatchObject({
      type: "employment",
      basis: "own_records",
      iss: ISSUER,
    });
    expect(validated.presentationSha256).toMatch(/^sha256:/);

    // A wallet that over-discloses: the extra claims are dropped unread.
    const over = await present(world, credentials[1]!, holders[1]!, [
      ...DCQL_PATHS,
      ["start"],
      ["given_name"],
    ]);
    const validatedOver = await verifyHiringPresentation(policy, over, request);
    expect(validatedOver.credential.record).not.toHaveProperty("start");
    expect(validatedOver.credential.record).not.toHaveProperty("given_name");
  });

  it("refuses a wrong nonce or audience, an unaccepted profile or basis, and a key past its window", async () => {
    const world = await createWorld();
    await world.issuerFetch(`${ISSUER}/admin/records/emp-1`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(MAYA),
    });
    await world.issuerFetch(`${ISSUER}/admin/records/emp-1/offer`, {
      method: "POST",
      headers: ADMIN,
    });
    const holder = await generateSigner("ES256");
    const [credential] = await redeem(world, [holder]);
    const policy = await policyFor(world);

    await expect(
      verifyHiringPresentation(
        policy,
        await present(world, credential!, holder, DCQL_PATHS, "other"),
        request,
      ),
    ).rejects.toMatchObject({ kind: "replayed" });
    await expect(
      verifyHiringPresentation(policy, await present(world, credential!, holder, DCQL_PATHS), {
        ...request,
        audience: "origin:https://evil.example",
      }),
    ).rejects.toMatchObject({
      kind: "binding_mismatch",
    });
    const p = await present(world, credential!, holder, DCQL_PATHS);
    await expect(
      verifyHiringPresentation(
        { ...policy, profiles: { employment: ["high_assurance"] } },
        p,
        request,
      ),
    ).rejects.toMatchObject({ kind: "not_admitted" });
    await expect(
      verifyHiringPresentation(await policyFor(world, { basis: ["customer_records"] }), p, request),
    ).rejects.toMatchObject({ kind: "not_admitted" });
    const retired = await policyFor(world);
    const keys = retired.issuers[0]!.keys.map((k) => ({
      ...k,
      signUntil: world.clock.now - 3 * 86_400,
    }));
    await expect(
      verifyHiringPresentation(
        { ...retired, issuers: [{ ...retired.issuers[0]!, keys }] },
        p,
        request,
      ),
    ).rejects.toMatchObject({ kind: "invalid_claims" });
  });

  it("offboarding invalidates the current record and offers a former-employee credential", async () => {
    const world = await createWorld();
    await world.issuerFetch(`${ISSUER}/admin/records/emp-1`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(MAYA),
    });
    await world.issuerFetch(`${ISSUER}/admin/records/emp-1/offer`, {
      method: "POST",
      headers: ADMIN,
    });
    const holder = await generateSigner("ES256");
    const [current] = await redeem(world, [holder]);
    const policy = await policyFor(world);
    await verifyHiringPresentation(
      policy,
      await present(world, current!, holder, DCQL_PATHS),
      request,
    );

    const offboard = await world.issuerFetch(`${ISSUER}/admin/records/emp-1/offboard`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ end: "2026-10-31" }),
    });
    expect(offboard.status).toBe(200);
    await world.issuer.status.applyEpoch();
    world.clock.advance(12 * 3600 + 1);
    await expect(
      verifyHiringPresentation(policy, await present(world, current!, holder, DCQL_PATHS), request),
    ).rejects.toMatchObject({ kind: "revoked" });

    const formerHolder = await generateSigner("ES256");
    const [former] = await redeem(world, [formerHolder]);
    const validated = await verifyHiringPresentation(
      policy,
      await present(world, former!, formerHolder, DCQL_PATHS),
      request,
    );
    expect(validated.credential.record).toMatchObject({ current: false, end_year: 2026 });
  });

  it("sends an alumni offer only to the personal contact on record", async () => {
    const world = await createWorld();
    await world.issuerFetch(`${ISSUER}/admin/records/emp-1`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(MAYA),
    });
    const before = world.messenger.sent.length;
    await world.issuerFetch(`${ISSUER}/alumni`, {
      method: "POST",
      body: new URLSearchParams({ email: "attacker@example.com" }),
    });
    expect(world.messenger.sent.length).toBe(before);
    await world.issuerFetch(`${ISSUER}/alumni`, {
      method: "POST",
      body: new URLSearchParams({ email: "Maya@Proton.example" }),
    });
    const sent = world.messenger.sent.slice(before);
    expect(sent.map((m) => ("email" in m.to ? m.to.email : m.to.phone))).toEqual([
      "maya@proton.example",
      "+15555550123",
    ]);
  });
});
