/** The TypeScript SDK reproduces every language-neutral vector in vectors/. */
import { readFileSync } from "node:fs";
import {
  evaluateScope,
  gridValuesBetween,
  isGridValue,
  type JobPostingFacts,
  jcs,
  jobFacts,
  MandateScope,
  normalizeCandidate,
  ojcpDigest,
  onet,
  salaryRungs,
  TYPE_METADATA,
  typeMetadataBytes,
  UserMandatesPolicy,
  vctIntegrity,
} from "@ojcp/credentials-core";
import {
  InMemoryLedger,
  type MandatePolicy,
  MandateRejected,
  type StandingMandateRequest,
  StatusListCache,
  verifyStandingMandate,
} from "@ojcp/verifier";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../vectors/${name}`, import.meta.url), "utf8"));

const Digests = z.object({
  cases: z.array(
    z.object({ name: z.string(), value: z.unknown(), jcs: z.string(), digest: z.string() }),
  ),
});
const Containment = z.object({
  cases: z.array(z.object({ scope: z.string(), job: z.string(), contains: z.boolean() })),
});
const Grid = z.object({
  grid_between: z.array(
    z.object({ min: z.number(), max: z.number(), values: z.array(z.number()) }),
  ),
  rungs: z.array(
    z.object({
      floor: z.object({ value: z.number(), currency: z.string(), unitText: z.string() }),
      rungs: z.array(z.number()),
    }),
  ),
  not_grid_values: z.array(z.number()),
});
const Coverage = z.object({
  scope: MandateScope,
  cases: z.array(
    z.object({
      name: z.string(),
      job: z.looseObject({ ojcp_id: z.string() }),
      result: z.unknown(),
    }),
  ),
});
const Normalization = z.object({
  cases: z.array(z.object({ input: z.unknown(), normalized: z.unknown() })),
});
const Integrity = z.object({
  types: z.record(z.string(), z.object({ vct: z.string(), integrity: z.string() })),
});
const Verification = z.object({
  policy: z.object({
    origin: z.string(),
    manifest: UserMandatesPolicy,
    issuers: z.array(z.any()),
    ojcpVersions: z.array(z.string()),
  }),
  status_lists: z.record(z.string(), z.string()),
  cases: z.array(
    z.object({
      name: z.string(),
      now: z.number(),
      expected: z.union([
        z.object({ accepted: z.literal(true) }),
        z.object({ kind: z.string(), reason: z.string().optional() }),
      ]),
      request: z.looseObject({}),
    }),
  ),
});

describe("shared vectors", () => {
  it("digests", async () => {
    for (const c of Digests.parse(load("digests.json")).cases) {
      expect(jcs(c.value), c.name).toBe(c.jcs);
      expect(await ojcpDigest(c.value), c.name).toBe(c.digest);
    }
  });

  it("O*NET-SOC containment", () => {
    for (const c of Containment.parse(load("onet-containment.json")).cases)
      expect(onet.contains(c.scope, c.job), `${c.scope} ⊇ ${c.job}`).toBe(c.contains);
  });

  it("salary grid", () => {
    const v = Grid.parse(load("salary-grid.json"));
    for (const g of v.grid_between) expect(gridValuesBetween(g.min, g.max)).toEqual(g.values);
    for (const r of v.rungs) {
      const unitText = z.enum(["HOUR", "WEEK", "MONTH", "YEAR"]).parse(r.floor.unitText);
      expect(
        salaryRungs({ ...r.floor, unitText }).map((x) => ("at_least" in x ? x.at_least : null)),
      ).toEqual(r.rungs);
    }
    for (const n of v.not_grid_values) expect(isGridValue(n)).toBe(false);
  });

  it("scope coverage", () => {
    const v = Coverage.parse(load("scope-coverage.json"));
    for (const c of v.cases)
      expect(
        evaluateScope(v.scope, jobFacts(c.job as JobPostingFacts, v.scope.taxonomy)),
        c.name,
      ).toEqual(c.result);
  });

  it("candidate normalization", () => {
    const RawContact = z.union([
      z.strictObject({ email: z.string() }),
      z.strictObject({ phone: z.string() }),
    ]);
    for (const c of Normalization.parse(load("candidate-normalization.json")).cases)
      expect(normalizeCandidate(RawContact.parse(c.input))).toEqual(c.normalized);
  });

  it("type metadata bytes and integrity", async () => {
    const v = Integrity.parse(load("type-metadata/integrity.json"));
    for (const [name, metadata] of Object.entries(TYPE_METADATA)) {
      expect(
        readFileSync(new URL(`../vectors/type-metadata/${name}.json`, import.meta.url), "utf8"),
      ).toBe(typeMetadataBytes(metadata));
      expect(await vctIntegrity(metadata)).toBe(v.types[name]?.integrity);
    }
  });

  it("standing-mandate verification", async () => {
    const v = Verification.parse(load("standing-mandate-verification.json"));
    for (const c of v.cases) {
      const policy: MandatePolicy = {
        ...v.policy,
        status: new StatusListCache({
          fetch: async (uri) =>
            new Response(v.status_lists[uri] ?? "", { status: v.status_lists[uri] ? 200 : 404 }),
          now: () => c.now,
        }),
        ledger: new InMemoryLedger(),
        countSecret: async () => new Uint8Array(32),
        now: () => c.now,
      };
      const outcome = await verifyStandingMandate(
        policy,
        c.request as unknown as StandingMandateRequest,
      ).then(
        () => ({ accepted: true as const }),
        (error: unknown) => {
          if (!(error instanceof MandateRejected)) throw error;
          return { kind: error.kind, ...(error.reason ? { reason: error.reason } : {}) };
        },
      );
      expect(outcome, c.name).toEqual(c.expected);
    }
  });
});
