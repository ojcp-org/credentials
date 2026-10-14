import { digest as owfDigest } from "@sd-jwt/crypto-browser";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { describe, expect, it } from "vitest";
import { ojcpDigest } from "../src/digest.ts";
import { base64url, fromBase64url, utf8 } from "../src/encoding.ts";
import { generateSigner, verifyRaw } from "../src/keys.ts";
import {
  bindKey,
  issueSdJwt,
  parseSdJwt,
  presentSdJwt,
  reconstructClaims,
  sd,
  sdArray,
  verifyKeyBinding,
} from "../src/sd-jwt.ts";

describe("ojcpDigest", () => {
  it("matches the spec's action-statement example digest", async () => {
    // spec/ojcp-v0.1.bs, Action Statement example; RFC 0008 §4.2 quotes the same digest
    // for ojcp_version 0.3, so this vector pins JCS + SHA-256 + base64url.
    const statement = {
      ojcp_version: "0.1",
      resource_server: "https://careers.acme.com",
      employer: { ojcp_employer_id: "acme-corp" },
      tool: "submit_application",
      job_id: "careers.acme.com:analyst-2026-001",
      application_id: "app_abc123",
      agent_id: "ai.northstar.assistant",
      agent_key_thumbprint: "tKwHslziExQ7dQgDX2HX8q9EuvAYmS_A3SKfjNHpdX8",
      candidate_data_digest: "sha256:l8Kt_6K5fFTzhjg_iIYDcXjskULviQZ5h7QClTNOeqo",
      mandate_nonce: "mn_xBVlesPAiuvWDyyxUDEDzDTG",
    };
    expect(await ojcpDigest(statement)).toBe("sha256:f-iFWllBWhQTjicNqPPPyN25DsN5rkUQThmL2e2VahM");
    expect(await ojcpDigest({ ...statement, ojcp_version: "0.3" })).toBe(
      "sha256:9FB-VobIkY_6Z5nKxHLuSj0G5NdHZs5Z4ejTxdAq-7c",
    );
  });
});

describe("SD-JWT", () => {
  it("pads disclosable arrays with decoys and hides element order", async () => {
    const issuer = await generateSigner("ES256");
    const { compact, disclosures } = await issueSdJwt({
      signer: issuer,
      claims: { iss: "https://issuer.example", list: sdArray(["a", "b", "c"], { padTo: 8 }) },
    });
    const parsed = await parseSdJwt(compact);
    const list = parsed.payload.list as Array<{ "...": string }>;
    expect(list).toHaveLength(8);
    const digests = list.map((e) => e["..."]);
    expect([...digests].sort()).toEqual(digests);
    expect(disclosures).toHaveLength(3);
    expect(reconstructClaims(parsed.payload, parsed.disclosures).claims.list).toEqual(
      expect.arrayContaining(["a", "b", "c"]),
    );
  });

  it("presents only selected disclosures and rejects tampering", async () => {
    const issuer = await generateSigner("ES256");
    const { compact } = await issueSdJwt({
      signer: issuer,
      claims: {
        iss: "x",
        given_name: sd("Maya"),
        family_name: sd("Chen"),
        tags: sdArray(["p", "q"]),
      },
    });
    const presented = await presentSdJwt(
      compact,
      (c) => c.disclosure.name === "given_name" || c.disclosure.value === "q",
    );
    const parsed = await parseSdJwt(presented);
    const { claims } = reconstructClaims(parsed.payload, parsed.disclosures);
    expect(claims).toMatchObject({ given_name: "Maya", tags: ["q"] });
    expect(claims).not.toHaveProperty("family_name");

    const [jwt, ...rest] = presented.split("~");
    const forged = `${jwt}~${base64url(utf8(JSON.stringify(["salt", "family_name", "Smith"])))}~${rest.join("~")}`;
    const forgedParsed = await parseSdJwt(forged);
    expect(() => reconstructClaims(forgedParsed.payload, forgedParsed.disclosures)).toThrow(
      /not referenced/,
    );
  });

  it("binds a presentation to a holder key with extra claims", async () => {
    const issuer = await generateSigner("ES256");
    const holder = await generateSigner("ES256");
    const { compact } = await issueSdJwt({
      signer: issuer,
      claims: { iss: "x", cnf: { jwk: holder.publicJwk }, a: sd(1) },
    });
    const kb = await bindKey(
      await presentSdJwt(compact, () => true),
      { aud: "https://careers.acme.com", nonce: "n1", ojcp_action: "sha256:abc" },
      holder,
    );
    const parsed = await parseSdJwt(kb);
    const verified = await verifyKeyBinding(parsed, holder.publicJwk);
    expect(verified.payload).toMatchObject({
      aud: "https://careers.acme.com",
      ojcp_action: "sha256:abc",
    });
    const other = await generateSigner("ES256");
    await expect(verifyKeyBinding(parsed, other.publicJwk)).rejects.toThrow(/does not verify/);
  });

  it("interoperates with the OpenWallet Foundation implementation", async () => {
    const issuer = await generateSigner("ES256");
    const holder = await generateSigner("ES256");
    const owf = new SDJwtVcInstance({
      hasher: owfDigest,
      verifier: (data, sig) => verifyRaw(issuer.publicJwk, utf8(data), fromBase64url(sig)),
      kbVerifier: (data, sig) => verifyRaw(holder.publicJwk, utf8(data), fromBase64url(sig)),
    });
    const { compact } = await issueSdJwt({
      signer: issuer,
      claims: {
        iss: "https://issuer.example",
        vct: "https://spec.ojcp.dev/vct/employment/v1",
        cnf: { jwk: holder.publicJwk },
        current: sd(true),
        positionHistories: sd([{ title: "Analyst" }]),
        list: sdArray(["x", "y"], { padTo: 4 }),
      },
    });
    const presentation = await bindKey(
      await presentSdJwt(compact, () => true),
      { aud: "https://verifier.example", nonce: "abc" },
      holder,
    );
    const result = await owf.verify(presentation, { keyBindingNonce: "abc" } as never);
    expect(result.payload).toMatchObject({
      current: true,
      list: expect.arrayContaining(["x", "y"]),
    });
    expect(result.kb?.payload.aud).toBe("https://verifier.example");
  });
});
