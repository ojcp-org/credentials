// @peculiar/x509, used here only to mint test certificates, needs this polyfill.
import "reflect-metadata";
import {
  decodeJws,
  generateSigner,
  issueSdJwt,
  type JWK,
  type Signer,
  Status,
  signJws,
  thumbprint,
  webCryptoSigner,
} from "@ojcp/credentials-core";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { ATTESTATION_TYPES } from "../src/attestation.ts";
import {
  type DerivedTier,
  deriveTier,
  InMemoryAcceptanceLog,
  type KeyLineage,
} from "../src/derive.ts";

/** Unverified, and for the stated reason (a note or a rejection), not some other failure. */
async function unverifiedBecause(derived: Promise<DerivedTier>, why: RegExp): Promise<void> {
  const d = await derived;
  expect(d.tier).toBe("unverified");
  expect(JSON.stringify({ notes: d.notes, rejected: d.rejected })).toMatch(why);
}

import { describeRecipient } from "../src/display.ts";
import { organizationId } from "../src/identity.ts";
import { DerivedTrustResolver } from "../src/resolver.ts";
import { signTrustList, TrustLists } from "../src/trust-list.ts";
import { attester, DAY, NOW, provider, publisher, serveStatus, Web } from "./world.ts";

const ORIGIN = "https://careers.acme.com";

/** A provider attested for identity by two independent operators, on lists from two publishers. */
async function setup() {
  const web = new Web();
  const acme = await provider(web, ORIGIN);
  const kyb = await attester(web, "https://kyb.attester.example", "lei:5493001KJTIIGC8Y1R12");
  const registry = await attester(web, "https://registry-a.example.gov", "gov:registry-a");
  const auditor = await attester(web, "https://audit.example", "lei:AUDITORLEI0000000000");
  for (const a of [kyb, registry, auditor]) await serveStatus(web, a);
  const p1 = await publisher("lists.candidate-advocates.example");
  const p2 = await publisher("lists.agent-platforms.example");
  const lists = new TrustLists([
    { name: "Candidate advocates", pins: [p1.pin] },
    { name: "Agent platforms", pins: [p2.pin] },
  ]);
  const listed = [
    kyb.entry(),
    registry.entry(["business_registration"]),
    auditor.entry(["conformance", "security_review"]),
  ];
  expect(await lists.accept(await p1.sign({ attesters: listed }), NOW)).toBe("accepted");
  expect(await lists.accept(await p2.sign({ attesters: [kyb.entry()] }), NOW)).toBe("accepted");
  const identity = [
    await kyb.issue("legal_entity", acme),
    await registry.issue("business_registration", acme),
  ];
  acme.staple(identity);
  const derive = (extra: Partial<Parameters<typeof deriveTier>[1]> = {}) =>
    deriveTier(ORIGIN, { lists, fetch: web.fetch, now: () => NOW, ...extra });
  return { web, acme, kyb, registry, auditor, p1, p2, lists, identity, derive };
}

describe("RFC 0010 derivation", () => {
  it("verified: two operators agree after NFKC and case folding", async () => {
    const { derive } = await setup();
    const d = await derive();
    expect(d).toMatchObject({
      tier: "verified",
      subject: "did:web:careers.acme.com",
      entity: { legal_name: "Acme Corporation", jurisdiction: "US-DE" },
    });
    expect(d.operators).toHaveLength(2);
    expect(describeRecipient(d).text).toBe(
      "Your application goes to Acme Corporation (verified, US-DE) at careers.acme.com.",
    );
  });

  it("threshold: one operator, a lowered threshold, disagreement, and one operator behind two ids", async () => {
    const { acme, kyb, registry, derive, p1, lists, web } = await setup();
    acme.staple([await kyb.issue("legal_entity", acme)]);
    await unverifiedBecause(derive(), /1 operator\(s\); 2 needed/);
    const single = await derive({ identityThreshold: 1, allowSingleOperator: true });
    expect(single).toMatchObject({ tier: "verified", weakerPolicy: true });
    expect(describeRecipient(single).recipient).toContain("single-attester policy");
    await expect(derive({ identityThreshold: 1 })).rejects.toThrow(/allowSingleOperator/);

    acme.staple([
      await kyb.issue("legal_entity", acme),
      await registry.issue("business_registration", acme, {
        claims: { ...CLAIMS_BR, legal_name: "Acme Holdings" },
      }),
    ]);
    await unverifiedBecause(derive(), /disagree/);

    // A newer list maps the registry to the same operator as the KYB firm.
    acme.staple([
      await kyb.issue("legal_entity", acme),
      await registry.issue("business_registration", acme),
    ]);
    await lists.accept(
      await p1.sign({
        iat: NOW - 60,
        attesters: [
          kyb.entry(),
          { ...registry.entry(["business_registration"]), operator: kyb.operator },
        ],
      }),
      NOW,
    );
    await unverifiedBecause(derive(), /1 operator\(s\); 2 needed/);
    void web;
  });

  it("attestations: wrong sub, unlinked former key, lifetime, relationship, IP literal", async () => {
    const { acme, kyb, registry, derive, web, lists } = await setup();
    const other = {
      subject: "did:web:careers.acme-jobs.com",
      identityThumbprint: acme.identityThumbprint,
    };
    const formerKey = await generateSigner("ES256");
    const former = {
      subject: acme.subject,
      identityThumbprint: await thumbprint(formerKey.publicJwk),
    };
    const overLifetime = await issueSdJwt({
      signer: kyb.signer,
      header: { kid: await thumbprint(kyb.signer.publicJwk) },
      claims: {
        iss: kyb.id,
        sub: acme.subject,
        vct: ATTESTATION_TYPES.legal_entity.vct,
        cnf: { jkt: acme.identityThumbprint },
        iat: NOW - DAY,
        exp: NOW + 200 * DAY,
        status: { status_list: { idx: 9, uri: kyb.statusUri } },
        relationship: "none",
        legal_name: "Acme Corporation",
        jurisdiction: "US-DE",
        checked_at: "2026-10-01",
      },
    });
    acme.staple([
      await kyb.issue("legal_entity", other),
      await kyb.issue("legal_entity", former),
      overLifetime.compact,
      await registry.issue("business_registration", acme, { relationship: "customer" }),
    ]);
    const d = await derive();
    expect(d.tier).toBe("unverified");
    expect(d.rejected.map((r) => r.reason)).toEqual(["wrong_subject", "wrong_subject", "lifetime"]);
    expect(d.notes.join(" ")).toMatch(/relationship customer; not counted/);

    // The former key, linked by a logged successor chain, counts.
    const lineage: KeyLineage = {
      predecessors: async () => [former.identityThumbprint],
      genesisFirstSeen: async () => undefined,
    };
    acme.staple([
      await kyb.issue("legal_entity", former),
      await registry.issue("business_registration", acme),
    ]);
    expect((await derive({ lineage })).tier).toBe("verified");

    expect(organizationId("https://203.0.113.7")).toBeUndefined();
    await unverifiedBecause(
      deriveTier("https://203.0.113.7", { lists, fetch: web.fetch, now: () => NOW }),
      /unavailable/,
    );
  });

  it("manifests: expired, misdirected or wrong-purpose key certificates, and two identity keys", async () => {
    const { kyb, registry, lists } = await setup();
    for (const options of [
      { cert: { exp: NOW - 1 } },
      { cert: { sub: "did:web:elsewhere.example" } },
      { cert: { purposes: ["posting" as const] } },
      { extraIdentity: true },
    ]) {
      const web = new Web();
      for (const a of [kyb, registry]) await serveStatus(web, a);
      const p = await provider(web, ORIGIN, options);
      p.staple([
        await kyb.issue("legal_entity", p),
        await registry.issue("business_registration", p),
      ]);
      await unverifiedBecause(
        deriveTier(ORIGIN, { lists, fetch: web.fetch, now: () => NOW }),
        /ojcp_cert/,
      );
    }
  });

  it("hosted: tenants sharing the host key, unrelated hosts, employer evidence, confirmation", async () => {
    const { kyb, registry, lists, auditor } = await setup();
    const web = new Web();
    for (const a of [kyb, registry, auditor]) await serveStatus(web, a);
    const ats = await provider(web, "https://ats.example");
    const tenant = await provider(web, "https://acme.ats.example", { identity: ats.identity });
    const hostAttestations = [
      await kyb.issue("legal_entity", ats),
      await registry.issue("business_registration", ats),
    ];
    tenant.staple([...hostAttestations, await kyb.issue("hosted_employer", tenant)]);
    const d = await deriveTier(tenant.origin, { lists, fetch: web.fetch, now: () => NOW });
    expect(d.tier).toBe("verified");
    expect(describeRecipient(d, { ojcp_employer_id: "globex", name: "Globex" }).text).toBe(
      "Your application goes to Acme Corporation (verified, US-DE) at acme.ats.example, on behalf of Globex Corporation, confirmed.",
    );
    expect(describeRecipient(d, { ojcp_employer_id: "initech", name: "Initech" }).employer).toEqual(
      { name: "Initech", confirmed: false },
    );

    const unrelated = await provider(web, "https://acme-ats.example", { identity: ats.identity });
    unrelated.staple(hostAttestations);
    await unverifiedBecause(
      deriveTier(unrelated.origin, { lists, fetch: web.fetch, now: () => NOW }),
      /wrong_subject.*wrong_subject/,
    );

    // A host whose only evidence is about the employer it hosts stays unverified.
    const board = await provider(web, "https://jobs.board.example");
    const employer = await provider(web, "https://globex.example");
    board.staple([
      await kyb.issue("legal_entity", employer),
      await registry.issue("business_registration", employer),
    ]);
    await unverifiedBecause(
      deriveTier(board.origin, { lists, fetch: web.fetch, now: () => NOW }),
      /wrong_subject.*wrong_subject/,
    );
  });

  it("status: invalid, suspended, unpinned signer, missing ttl, stale staple", async () => {
    const { acme, kyb, registry, derive, web } = await setup();
    const le = await kyb.issue("legal_entity", acme, { idx: 500 });
    const br = await registry.issue("business_registration", acme, { idx: 600 });
    acme.staple([le, br]);
    kyb.setStatus(500, Status.INVALID);
    await serveStatus(web, kyb);
    await unverifiedBecause(
      derive(),
      /legal_entity from https:\/\/kyb.attester.example: status invalid/,
    );
    kyb.setStatus(500, Status.SUSPENDED);
    await serveStatus(web, kyb);
    await unverifiedBecause(
      derive(),
      /legal_entity from https:\/\/kyb.attester.example: status invalid/,
    );
    kyb.setStatus(500, Status.VALID);

    // Signed by a key not pinned for the attester: absent.
    web.text(kyb.statusUri, await kyb.statusToken({ signer: await generateSigner("ES256") }));
    await unverifiedBecause(
      derive(),
      /legal_entity from https:\/\/kyb.attester.example: status absent/,
    );

    // Only a stapled token, 25 hours old: stale, and the fetch fails, so absent.
    web.routes.delete(kyb.statusUri);
    acme.staple([le, br], [await kyb.statusToken({ iat: NOW - 25 * 3600 })]);
    await unverifiedBecause(
      derive(),
      /legal_entity from https:\/\/kyb.attester.example: status absent/,
    );
    // A fresh staple works without any fetch to the attester.
    acme.staple([le, br], [await kyb.statusToken()]);
    web.log.length = 0;
    expect((await derive()).tier).toBe("verified");
    expect(web.log).not.toContain(kyb.statusUri);
  });

  it("trust lists: pins, rollover, ordering, future iat, expiry, distrust, malformed", async () => {
    const { p1, p2, kyb, registry, derive, lists, acme } = await setup();
    const stranger = await generateSigner("ES256");
    expect(
      await lists.accept(
        await signTrustList(stranger, { publisher: "x", iat: NOW, exp: NOW + DAY, attesters: [] }),
        NOW,
      ),
    ).toBe("unpinned_key");
    expect(
      await lists.accept(await p1.sign({ iat: NOW - 7200, attesters: [kyb.entry()] }), NOW),
    ).toBe("older_than_accepted");
    expect(
      await lists.accept(await p1.sign({ iat: NOW + 600, attesters: [kyb.entry()] }), NOW),
    ).toBe("future_iat");
    expect(
      await lists.accept(await p1.sign({ exp: NOW + 8 * DAY, attesters: [kyb.entry()] }), NOW),
    ).toBe("too_long");
    expect(
      await lists.accept(await p1.sign({ attesters: [{ ...kyb.entry(), vct: [] }] }), NOW),
    ).toBe("malformed");

    // Rollover: announce a successor, then sign with it.
    const successor = await generateSigner("ES256");
    const successorPin = await thumbprint(successor.publicJwk);
    const listed = [kyb.entry(), registry.entry(["business_registration"])];
    expect(
      await lists.accept(
        await p1.sign({ iat: NOW - 1800, next_keys: [successorPin], attesters: listed }),
        NOW,
      ),
    ).toBe("accepted");
    expect(
      await lists.accept(
        await signTrustList(successor, {
          publisher: "https://lists.candidate-advocates.example",
          iat: NOW - 1200,
          exp: NOW + DAY,
          attesters: listed,
        }),
        NOW,
      ),
    ).toBe("accepted");
    // The old key is no longer named, so it is dropped.
    expect(await lists.accept(await p1.sign({ iat: NOW - 600, attesters: listed }), NOW)).toBe(
      "unpinned_key",
    );

    // Distrust without a cutoff removes the attester, and survives the list's expiry:
    // p2 keeps granting the registry, so only p1's lingering distrust keeps it out.
    expect(
      await lists.accept(await p2.sign({ iat: NOW - 300, exp: NOW + DAY, attesters: listed }), NOW),
    ).toBe("accepted");
    expect(
      await lists.accept(
        await signTrustList(successor, {
          publisher: "p1",
          iat: NOW - 300,
          exp: NOW + 60,
          attesters: listed,
          distrusted: [{ id: registry.id }],
        }),
        NOW,
      ),
    ).toBe("accepted");
    await unverifiedBecause(derive(), /distrusted/);
    await unverifiedBecause(derive({ now: () => NOW + 120 }), /distrusted/);

    // Distrust after a cutoff: only the agent's own earlier record of acceptance counts.
    const fresh = await setup();
    const acceptance = new InMemoryAcceptanceLog();
    expect((await fresh.derive({ acceptance })).tier).toBe("verified");
    const cutoff = new Date((NOW + 10) * 1000).toISOString();
    await fresh.lists.accept(
      await fresh.p1.sign({
        iat: NOW - 60,
        attesters: [fresh.kyb.entry(), fresh.registry.entry(["business_registration"])],
        distrusted: [{ id: fresh.registry.id, distrust_after: cutoff }],
      }),
      NOW,
    );
    expect((await fresh.derive({ acceptance })).tier).toBe("verified");
    await unverifiedBecause(
      fresh.derive({ acceptance: new InMemoryAcceptanceLog() }),
      /distrusted/,
    );
    void acme;
  });

  it("tenure and sources: 89 vs 91 days, listing-tenure in migration, pinned index", async () => {
    const { acme, kyb, registry, auditor, identity, derive, lists, web } = await setup();
    acme.staple([
      ...identity,
      await auditor.issue("conformance", acme),
      await auditor.issue("security_review", acme),
    ]);
    const lineage = (days: number): KeyLineage => ({
      predecessors: async () => [],
      genesisFirstSeen: async () => NOW - days * DAY,
    });
    expect((await derive({ lineage: lineage(89) })).tier).toBe("verified");
    expect((await derive({ lineage: lineage(91) })).tier).toBe("audited");
    expect((await derive()).tier).toBe("verified");

    acme.staple([
      ...identity,
      await auditor.issue("conformance", acme),
      await auditor.issue("security_review", acme),
      await kyb.issue("listing_tenure", acme),
    ]);
    expect((await derive({ migration: true })).tier).toBe("audited");
    expect((await derive({ migration: false })).tier).toBe("verified");

    const index = { url: "https://index.example", tierFor: async () => "audited" as const };
    const migrating = new DerivedTrustResolver({
      lists,
      fetch: web.fetch,
      now: () => NOW,
      migration: true,
      pinnedIndex: index,
    });
    acme.staple(identity);
    expect(await migrating.effectiveTier(ORIGIN)).toMatchObject({
      tier: "audited",
      source: "pinned_index",
    });
    const after = new DerivedTrustResolver({
      lists,
      fetch: web.fetch,
      now: () => NOW,
      pinnedIndex: index,
    });
    expect(await after.effectiveTier(ORIGIN)).toMatchObject({
      tier: "verified",
      source: "derived",
    });
    void registry;
  });

  it("fetch order: an issuer on no list is never fetched", async () => {
    const { acme, web, derive, identity } = await setup();
    const rogue = await attester(web, "https://rogue.example", "rogue");
    acme.staple([...identity, await rogue.issue("legal_entity", acme)]);
    web.log.length = 0;
    const d = await derive();
    expect(d.rejected.map((r) => r.reason)).toEqual(["untrusted_issuer"]);
    expect(web.log.some((u) => u.startsWith("https://rogue.example"))).toBe(false);
  });

  it("X.509: an attester pinned by anchor, with the SAN URI equal to iss", async () => {
    const { acme, kyb, web, p2, lists, derive } = await setup();
    x509.cryptoProvider.set(crypto);
    const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const rootKeys = (await crypto.subtle.generateKey(alg, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const leafKeys = (await crypto.subtle.generateKey(alg, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const iss = "https://registry-b.example.gov";
    const validity = {
      notBefore: new Date((NOW - 30 * DAY) * 1000),
      notAfter: new Date((NOW + 365 * DAY) * 1000),
    };
    const root = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=Registry B Root",
      ...validity,
      signingAlgorithm: alg,
      keys: rootKeys,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
    });
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      subject: "CN=Registry B Attester",
      issuer: root.subject,
      ...validity,
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [new x509.SubjectAlternativeNameExtension([{ type: "url", value: iss }])],
    });
    const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");
    const anchorHash = Buffer.from(await crypto.subtle.digest("SHA-256", root.rawData)).toString(
      "hex",
    );
    const leafJwk = (await crypto.subtle.exportKey("jwk", leafKeys.publicKey)) as JWK;
    const leafSigner = await webCryptoSigner(leafKeys.privateKey, leafJwk, "ES256");
    const registryB = await attester(web, iss, "gov:registry-b", leafSigner);
    await serveStatus(web, registryB);
    const entry = {
      id: iss,
      operator: "gov:registry-b",
      vct: [ATTESTATION_TYPES.business_registration.vct],
      x509: [{ anchor_sha256: anchorHash, san_uri: iss }],
    };
    expect(
      await lists.accept(await p2.sign({ iat: NOW - 60, attesters: [kyb.entry(), entry] }), NOW),
    ).toBe("accepted");
    // Status List Tokens are signed with the same chain.
    web.text(registryB.statusUri, await registryB.statusToken());
    const att = await registryB.issue("business_registration", acme);
    const withChain = await reheader(
      att,
      { x5c: [b64(leaf.rawData), b64(root.rawData)] },
      leafSigner,
    );
    acme.staple(
      [await kyb.issue("legal_entity", acme), withChain],
      [
        await reheaderToken(
          await registryB.statusToken(),
          { x5c: [b64(leaf.rawData), b64(root.rawData)] },
          leafSigner,
        ),
      ],
    );
    expect((await derive()).tier).toBe("verified");

    // The same chain under a list that pins another anchor is rejected.
    entry.x509 = [{ anchor_sha256: "00".repeat(32), san_uri: iss }];
    await lists.accept(await p2.sign({ iat: NOW - 30, attesters: [kyb.entry(), entry] }), NOW);
    expect((await derive()).rejected.map((r) => r.reason)).toContain("invalid_signature");
  });
});

const CLAIMS_BR = {
  legal_name: "ACME CORPORATION",
  jurisdiction: "US-DE",
  registry: "Delaware Division of Corporations",
  registration_number: "1234567",
  registration_status: "active",
  checked_at: "2026-10-01",
};

/** Re-signs a compact SD-JWT's issuer JWT with extra header members (here, `x5c` instead of `kid`). */
async function reheader(
  compact: string,
  header: Record<string, unknown>,
  signer: Signer,
): Promise<string> {
  const [jwt, ...rest] = compact.split("~");
  return `${await reheaderToken(jwt as string, header, signer)}~${rest.join("~")}`;
}

async function reheaderToken(
  jwt: string,
  header: Record<string, unknown>,
  signer: Signer,
): Promise<string> {
  const decoded = decodeJws(jwt);
  const { kid: _, ...rest } = decoded.header;
  return signJws({ ...rest, ...header }, decoded.payload, signer);
}
