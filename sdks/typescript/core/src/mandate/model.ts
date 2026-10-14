/**
 * The standing-mandate credential model (RFC 0008 §2): constants, element
 * schemas for each allow-list, and the issuance dataset.
 */
import { z } from "zod";
import { isKnownCode, ONET_SOC_2019 } from "../onet/index.ts";
import { ConsentScope, REMOTE_POLICIES, Tool } from "../wire.ts";

export const STANDING_MANDATE_VCT = "https://spec.ojcp.dev/vct/standing-mandate/v1";

export const BREADTH = {
  narrow: { maxReal: 3, padTo: 4 },
  broad: { maxReal: 10, padTo: 12 },
} as const;
export type Breadth = keyof typeof BREADTH;

/** Fixed padded lengths (RFC 0008 §2.5); job_families and locations depend on breadth. */
export const PAD = {
  candidate: 4,
  remote_policy: 8,
  employment_type: 8,
  experience_level: 8,
  actions: 8,
  salary: 26,
} as const;

/** The only arrays that may hold array-element digests (RFC 0008 §2.1 rule 2). */
export const ALLOW_LIST_PATHS = [
  ["candidate"],
  ["scope", "job_families"],
  ["scope", "locations"],
  ["scope", "remote_policy"],
  ["scope", "employment_type"],
  ["scope", "experience_level"],
  ["scope", "salary"],
  ["actions"],
] as const;

export const BINDING_TOKENS = ["accept_terms", "accept_offer"] as const;
export const ProhibitedToken = z.union([Tool, z.enum(BINDING_TOKENS)]);
export type ProhibitedToken = z.infer<typeof ProhibitedToken>;

export const TRUST_TIERS = ["unverified", "verified", "audited"] as const;
export const TrustFloor = z.enum(["verified", "audited"]);
export type TrustFloor = z.infer<typeof TrustFloor>;

// ── Element shapes (RFC 0008 §2.1 rule 3: scalar or flat object) ─────────────

const E164 = /^\+[1-9]\d{6,14}$/;
export const CandidateElement = z.union([
  z.strictObject({ email: z.string().email() }),
  z.strictObject({ phone: z.string().regex(E164) }),
  z.strictObject({ jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
]);
export type CandidateElement = z.infer<typeof CandidateElement>;

export const JobFamilyElement = z
  .string()
  .refine(isKnownCode, "not an O*NET-SOC 2019 or SOC 2018 code");

export const LocationElement = z.union([
  z.strictObject({
    addressCountry: z.string().regex(/^[A-Z]{2}$/),
    addressRegion: z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/)
      .optional(),
  }),
  z.strictObject({ anywhere: z.literal(true) }),
]);
export type LocationElement = z.infer<typeof LocationElement>;

export const RemotePolicyElement = z.enum(REMOTE_POLICIES);

export const SALARY_UNITS = ["HOUR", "WEEK", "MONTH", "YEAR"] as const;
export const SalaryElement = z.union([
  z.strictObject({ any: z.literal(true) }),
  z.strictObject({
    at_least: z.number().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitText: z.enum(SALARY_UNITS),
  }),
  z.strictObject({ unstated: z.literal(true) }),
]);
export type SalaryElement = z.infer<typeof SalaryElement>;

/** Disclosed scope as a verifier reconstructs it, or the full scope the wallet holds. */
export const MandateScope = z.strictObject({
  taxonomy: z.literal(ONET_SOC_2019),
  job_families: z.array(JobFamilyElement),
  locations: z.array(LocationElement),
  remote_policy: z.array(RemotePolicyElement),
  employment_type: z.array(z.string()).optional(),
  experience_level: z.array(z.string()).optional(),
  salary: z.array(SalaryElement),
});
export type MandateScope = z.infer<typeof MandateScope>;

/** The standing mandate after reconstruction: only disclosed elements remain in allow-lists. */
export const StandingMandateClaims = z.looseObject({
  iss: z.string(),
  vct: z.literal(STANDING_MANDATE_VCT),
  "vct#integrity": z.string(),
  ojcp_version: z.string(),
  nbf: z.number().int(),
  exp: z.number().int(),
  cnf: z.strictObject({ jwk: z.record(z.string(), z.unknown()) }),
  agent_id: z.string(),
  status: z.looseObject({
    status_list: z.strictObject({ idx: z.number().int().nonnegative(), uri: z.url() }),
  }),
  candidate: z.array(CandidateElement),
  scope: MandateScope,
  limits: z.strictObject({ per_employer: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  breadth: z.enum(["narrow", "broad"]),
  actions: z.array(Tool),
  prohibited: z.array(ProhibitedToken),
  consent_scope: ConsentScope,
  provider_trust_floor: TrustFloor,
});
export type StandingMandateClaims = z.infer<typeof StandingMandateClaims>;

/** What the user approved, before rungs, padding and decoys are applied. */
export const StandingMandateDataset = z.strictObject({
  agent_id: z.string(),
  candidate: z.array(CandidateElement).min(1).max(PAD.candidate),
  job_families: z.array(JobFamilyElement).min(1),
  locations: z.array(LocationElement).min(1),
  remote_policy: z.array(RemotePolicyElement).min(1),
  employment_type: z.array(z.string()).min(1).optional(),
  experience_level: z.array(z.string()).min(1).optional(),
  /** Grid value the user picked; absent means no floor (`any`). */
  salary_floor: z
    .strictObject({
      value: z.number().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      unitText: z.enum(SALARY_UNITS),
    })
    .optional(),
  include_unstated_salary: z.boolean().default(false),
  per_employer: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** Kept by issuer and agent only (RFC 0008 §2.4). */
  applications_total: z.number().int().positive(),
  actions: z.array(Tool).min(1).max(PAD.actions),
  prohibited: z.array(ProhibitedToken),
  consent_scope: ConsentScope,
  provider_trust_floor: TrustFloor,
  /** 1 to 3 calendar months (RFC 0008 §2.7). */
  months: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export type StandingMandateDataset = z.input<typeof StandingMandateDataset>;
export type ParsedStandingMandateDataset = z.output<typeof StandingMandateDataset>;

/** The breadth class of a dataset, or `null` if too broad to issue (RFC 0008 §2.5). */
export function breadthOf(
  dataset: Pick<ParsedStandingMandateDataset, "job_families" | "locations">,
): Breadth | null {
  const widest = Math.max(dataset.job_families.length, dataset.locations.length);
  if (widest <= BREADTH.narrow.maxReal) return "narrow";
  if (widest <= BREADTH.broad.maxReal) return "broad";
  return null;
}

/** Normalizes a candidate identifier the way issuer, agent and provider all must (RFC 0008 §2.3). */
export function normalizeCandidate(element: CandidateElement): CandidateElement {
  if ("email" in element) return { email: element.email.trim().toLowerCase() };
  if ("phone" in element) return { phone: element.phone.replace(/[\s().-]/g, "") };
  return element;
}

/** Month epochs (RFC 0008 §2.7): `nbf` is the first of a month at 00:00Z. */
export function monthEpochs(now: Date, months: 1 | 2 | 3): { nbf: number; exp: number } {
  const nbf = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  const exp = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1) / 1000;
  return { nbf, exp };
}

export function isMonthEpoch(seconds: number): boolean {
  const d = new Date(seconds * 1000);
  return (
    d.getUTCDate() === 1 &&
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0
  );
}

/** Whole calendar months between two month epochs. */
export function monthsBetween(nbf: number, exp: number): number {
  const a = new Date(nbf * 1000);
  const b = new Date(exp * 1000);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}
