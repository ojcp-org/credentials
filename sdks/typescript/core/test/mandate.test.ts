import { describe, expect, it } from "vitest";
import { generateSigner } from "../src/keys.ts";
import {
  checkDisclosureRule,
  parseStandingMandate,
  standingMandateClaims,
} from "../src/mandate/credential.ts";
import { type MandateScope, StandingMandateDataset } from "../src/mandate/model.ts";
import { gridValuesBetween, isGridValue, salaryRungs } from "../src/mandate/salary.ts";
import { evaluateScope, jobFacts } from "../src/mandate/scope.ts";
import { contains, ONET_SOC_2019 } from "../src/onet/index.ts";
import { issueSdJwt, parseSdJwt, presentSdJwt, reconstructClaims } from "../src/sd-jwt.ts";
import type { JobPostingFacts } from "../src/wire.ts";

describe("O*NET-SOC containment", () => {
  it("follows the published hierarchy, not string prefixes", () => {
    expect(contains("29-1210", "29-1221.00")).toBe(true); // broad Physicians contains Pediatricians, General
    expect(contains("29-1000", "29-1221.00")).toBe(true); // minor group, two levels up
    expect(contains("29-1200", "29-1221.00")).toBe(false); // looks like a prefix, isn't a SOC group
    expect(contains("15-1250", "15-1252.00")).toBe(true);
    expect(contains("15-1252", "15-1252.00")).toBe(true);
    expect(contains("15-2051", "15-2051.00")).toBe(true);
    expect(contains("15-1250", "15-2051.00")).toBe(false);
  });
  it("matches residual codes only exactly", () => {
    expect(contains("15-1200", "15-1299.00")).toBe(false);
    expect(contains("15-1299", "15-1299.00")).toBe(true);
    expect(contains("15-1299.00", "15-1299.00")).toBe(true);
    expect(contains("15-1200", "15-1299.04")).toBe(true); // Penetration Testers is not residual
  });
  it("rejects unknown codes", () => {
    expect(contains("99-9999", "15-1252.00")).toBe(false);
    expect(contains("15-1250", "15-1252.99")).toBe(false);
  });
});

describe("salary grid", () => {
  it("produces RFC 0008's example rungs", () => {
    expect(isGridValue(125_000)).toBe(true);
    expect(isGridValue(120_000)).toBe(false);
    const rungs = salaryRungs({ value: 125_000, currency: "USD", unitText: "YEAR" });
    expect(rungs[0]).toEqual({ at_least: 125_000, currency: "USD", unitText: "YEAR" });
    expect(rungs.map((r) => ("at_least" in r ? r.at_least : 0))).toContain(132_000);
    expect(rungs.at(-1)).toEqual({ at_least: 500_000, currency: "USD", unitText: "YEAR" });
    expect(rungs.length).toBeLessThanOrEqual(25);
  });
  it("handles hourly floors exactly", () => {
    expect(gridValuesBetween(31, 34)).toEqual([31.5, 33.5]);
  });
});

const dataset = StandingMandateDataset.parse({
  agent_id: "ai.northstar.assistant",
  candidate: [{ email: "Jordan@Example.com" }],
  job_families: ["15-2051"],
  locations: [{ addressCountry: "US", addressRegion: "NY" }],
  remote_policy: ["hybrid", "remote"],
  salary_floor: { value: 125_000, currency: "USD", unitText: "YEAR" },
  per_employer: 2,
  applications_total: 40,
  actions: ["search_jobs", "begin_application", "submit_application"],
  prohibited: [],
  consent_scope: "application_prefill",
  provider_trust_floor: "verified",
  months: 3,
});

const analystJob: JobPostingFacts = {
  ojcp_id: "careers.acme.com:analyst-1",
  occupationalCategory: [
    { "@type": "CategoryCode", codeValue: "15-2051.00", inCodeSet: ONET_SOC_2019 },
  ],
  jobLocation: {
    "@type": "Place",
    address: { addressCountry: "US", addressRegion: "NY", addressLocality: "New York" },
  },
  remote_policy: "hybrid",
  baseSalary: { currency: "USD", minValue: 132_000, maxValue: 150_000, unitText: "YEAR" },
};

describe("scope coverage", () => {
  const scope: MandateScope = {
    taxonomy: ONET_SOC_2019,
    job_families: dataset.job_families,
    locations: dataset.locations,
    remote_policy: dataset.remote_policy,
    salary: salaryRungs(dataset.salary_floor!),
  };

  it("covers RFC 0008's example job and picks the example's disclosures", () => {
    const result = evaluateScope(scope, jobFacts(analystJob, ONET_SOC_2019));
    expect(result).toEqual({
      covered: true,
      disclose: {
        job_family: "15-2051",
        location: { addressCountry: "US", addressRegion: "NY" },
        remote_policy: "hybrid",
        salary: { at_least: 132_000, currency: "USD", unitText: "YEAR" },
      },
    });
  });

  it("fails closed on silence and mismatch", () => {
    const below = {
      ...analystJob,
      baseSalary: { currency: "USD", minValue: 110_000, unitText: "YEAR" },
    };
    expect(evaluateScope(scope, jobFacts(below, ONET_SOC_2019))).toEqual({
      covered: false,
      failures: ["salary"],
    });
    const unclassified = { ...analystJob, occupationalCategory: undefined };
    expect(evaluateScope(scope, jobFacts(unclassified, ONET_SOC_2019))).toMatchObject({
      failures: ["unclassified"],
    });
    const textOnly = {
      ...analystJob,
      jobLocation: { address: { addressCountry: "United States" } },
    };
    expect(evaluateScope(scope, jobFacts(textOnly, ONET_SOC_2019))).toMatchObject({
      failures: ["location"],
    });
    const noPay = { ...analystJob, baseSalary: undefined };
    expect(evaluateScope(scope, jobFacts(noPay, ONET_SOC_2019))).toMatchObject({
      failures: ["salary"],
    });
    expect(
      evaluateScope(
        { ...scope, salary: [...scope.salary, { unstated: true }] },
        jobFacts(noPay, ONET_SOC_2019),
      ),
    ).toMatchObject({ covered: true, disclose: { salary: { unstated: true } } });
    const euro = {
      ...analystJob,
      baseSalary: { currency: "EUR", minValue: 150_000, unitText: "YEAR" },
    };
    expect(evaluateScope(scope, jobFacts(euro, ONET_SOC_2019))).toMatchObject({
      failures: ["salary"],
    });
  });

  it("covers remote jobs without a country only with anywhere", () => {
    const remote = { ...analystJob, remote_policy: "remote", jobLocation: undefined };
    expect(evaluateScope(scope, jobFacts(remote, ONET_SOC_2019))).toMatchObject({
      failures: ["location"],
    });
    expect(
      evaluateScope({ ...scope, locations: [{ anywhere: true }] }, jobFacts(remote, ONET_SOC_2019)),
    ).toMatchObject({ covered: true, disclose: { location: { anywhere: true } } });
  });
});

describe("standing mandate credential", () => {
  it("issues padded allow-lists that pass the disclosure rule, and presents selectively", async () => {
    const issuer = await generateSigner("ES256");
    const holder = await generateSigner("ES256");
    const claims = standingMandateClaims({
      issuer: "https://mandates.example",
      dataset,
      holderJwk: holder.publicJwk,
      status: { idx: 412907, uri: "https://mandates.example/status/7" },
      vctIntegrity: "sha256-test",
      ojcpVersion: "0.3",
      now: new Date("2026-10-13T12:00:00Z"),
    });
    const { compact } = await issueSdJwt({ signer: issuer, claims });
    const parsed = await parseSdJwt(compact);
    checkDisclosureRule(parsed.payload);
    expect(parsed.payload).toMatchObject({ nbf: 1790812800, exp: 1798761600, breadth: "narrow" });
    expect(parsed.payload).toHaveProperty(["candidate", "length"], 4);
    expect(parsed.payload).toHaveProperty(["scope", "salary", "length"], 26);

    const presented = await presentSdJwt(compact, (c) => {
      const v = c.disclosure.value;
      return (
        JSON.stringify(v) === JSON.stringify({ email: "jordan@example.com" }) ||
        v === "15-2051" ||
        v === "hybrid" ||
        v === "submit_application" ||
        JSON.stringify(v) ===
          JSON.stringify({ at_least: 132_000, currency: "USD", unitText: "YEAR" }) ||
        JSON.stringify(v) === JSON.stringify({ addressCountry: "US", addressRegion: "NY" })
      );
    });
    const p = await parseSdJwt(presented);
    const mandate = parseStandingMandate(reconstructClaims(p.payload, p.disclosures).claims);
    expect(mandate.candidate).toEqual([{ email: "jordan@example.com" }]);
    expect(mandate.scope.salary).toEqual([
      { at_least: 132_000, currency: "USD", unitText: "YEAR" },
    ]);
    expect(mandate.prohibited).toEqual(expect.arrayContaining(["accept_terms", "accept_offer"]));
  });

  it("rejects hidden restrictions and wrong padding", () => {
    const base = {
      breadth: "narrow",
      candidate: Array(4).fill({ "...": "d" }),
      scope: {
        taxonomy: ONET_SOC_2019,
        job_families: Array(4).fill({ "...": "d" }),
        locations: Array(4).fill({ "...": "d" }),
        remote_policy: Array(8).fill({ "...": "d" }),
        salary: Array(26).fill({ "...": "d" }),
      },
      actions: Array(8).fill({ "...": "d" }),
      prohibited: ["accept_terms", "accept_offer"],
    };
    expect(() => checkDisclosureRule(base)).not.toThrow();
    expect(() => checkDisclosureRule({ ...base, _sd: ["x"] })).toThrow(/_sd found/);
    expect(() => checkDisclosureRule({ ...base, prohibited: [{ "...": "d" }] })).toThrow(
      /outside an allow-list/,
    );
    expect(() =>
      checkDisclosureRule({
        ...base,
        scope: { ...base.scope, job_families: Array(5).fill({ "...": "d" }) },
      }),
    ).toThrow(/padded length/);
    expect(() =>
      checkDisclosureRule({
        ...base,
        scope: { ...base.scope, locations: [...Array(3).fill({ "...": "d" }), "US"] },
      }),
    ).toThrow(/only array-element digests/);
  });
});
