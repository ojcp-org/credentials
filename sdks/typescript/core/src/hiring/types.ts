/**
 * Hiring credential types (RFC 0014 §2): employment, education, professional
 * license and certification, each a closed set of claims, with coarse claims so
 * holders can share a year instead of a date.
 */
import { z } from "zod";
import { OjcpError } from "../errors.ts";
import { isRecord } from "../guards.ts";
import { sd, sdArray } from "../sd-jwt.ts";

const VCT_BASE = "https://spec.ojcp.dev/vct";
export const HIRING_VCT = {
  employment: `${VCT_BASE}/employment/v1`,
  education: `${VCT_BASE}/education/v1`,
  professional_license: `${VCT_BASE}/professional-license/v1`,
  certification: `${VCT_BASE}/certification/v1`,
} as const;
export type HiringType = keyof typeof HIRING_VCT;

export const BASIS = ["own_records", "customer_records", "source_check"] as const;
export const Basis = z.enum(BASIS);
export type Basis = z.infer<typeof Basis>;

const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const OjcpDate = z.string().regex(DATE);
/** `lei:<ISO 17442>`, `did:web:<host>`, or `reg:<ISO 3166>:<number>` (RFC 0014 §2.2). */
export const OrganizationId = z
  .string()
  .regex(
    /^(lei:[A-Z0-9]{18}[0-9]{2}|did:web:[a-z0-9.-]+(?::\d+)?|reg:[A-Z]{2}(-[A-Z0-9]{1,3})?:[A-Za-z0-9._-]+)$/,
  );
const RecordStatus = z.enum(["active", "expired", "pending", "suspended"]);
const DegreeStatus = z.enum(["Granted", "InProgress", "Postponed", "NotGranted"]);

/**
 * Record schemas in two modes. `issue`: what an issuer must supply. `presented`:
 * what a verifier may receive, where any member can be withheld because every
 * member is its own disclosure (RFC 0014 §2.1), but nothing outside the type.
 */
function recordSchemas(mode: "issue" | "presented") {
  const req = <T extends z.ZodType>(schema: T) => (mode === "issue" ? schema : schema.optional());
  const opt = <T extends z.ZodType>(schema: T) => schema.optional();
  const organization = z.strictObject({ name: req(z.string()), id: opt(OrganizationId) });
  const period = z.strictObject({ validFrom: opt(OjcpDate), validTo: opt(OjcpDate) });
  return {
    employment: z.strictObject({
      organization: req(organization),
      current: req(z.boolean()),
      start: opt(OjcpDate),
      end: opt(OjcpDate),
      positionHistories: opt(
        z.array(
          z.strictObject({ title: req(z.string()), start: opt(OjcpDate), end: opt(OjcpDate) }),
        ),
      ),
      start_year: opt(z.number().int()),
      end_year: opt(z.number().int()),
      tenure_years: opt(z.number().int().nonnegative()),
    }),
    education: z.strictObject({
      institution: req(organization),
      educationDegrees: opt(
        z.array(
          z.strictObject({
            name: req(z.string()),
            degreeGrantedStatus: req(DegreeStatus),
            date: opt(OjcpDate),
          }),
        ),
      ),
      programs: opt(z.array(z.string())),
      degree_level: opt(z.number().int().min(0).max(8)),
      degree_year: opt(z.number().int()),
    }),
    professional_license: z.strictObject({
      license: req(
        z.strictObject({
          name: req(z.string()),
          id: opt(z.string()),
          issuingAuthority: req(organization),
          status: req(RecordStatus),
          effectiveTimePeriod: opt(period),
          restrictions: opt(z.array(z.string())),
        }),
      ),
    }),
    certification: z.strictObject({
      certification: req(
        z.strictObject({
          name: req(z.string()),
          id: opt(z.string()),
          issuingAuthority: req(organization),
          status: req(RecordStatus),
          issued: opt(OjcpDate),
          effectiveTimePeriod: opt(period),
        }),
      ),
    }),
  };
}

export const RECORD_SCHEMAS = recordSchemas("issue");
/** Verifier side: the type's closed claim set, every member optional. */
export const PRESENTED_RECORD_SCHEMAS = recordSchemas("presented");
export const EmploymentClaims = RECORD_SCHEMAS.employment;
export const EducationClaims = RECORD_SCHEMAS.education;

export type EmploymentRecord = z.infer<typeof RECORD_SCHEMAS.employment>;
export type EducationRecord = z.infer<typeof RECORD_SCHEMAS.education>;
export type ProfessionalLicenseRecord = z.infer<typeof RECORD_SCHEMAS.professional_license>;
export type CertificationRecord = z.infer<typeof RECORD_SCHEMAS.certification>;

/** Claims that are never selectively disclosable (RFC 0014 §2.1). */
export const ALWAYS_VISIBLE = [
  "iss",
  "vct",
  "vct#integrity",
  "iat",
  "exp",
  "cnf",
  "status",
  "basis",
] as const;
const HOLDER_NAME = ["given_name", "family_name"] as const;

const DAY = 86_400;
const TWO_YEARS = 730 * DAY;

export function hiringTypeOf(vct: string): HiringType | undefined {
  return (Object.keys(HIRING_VCT) as HiringType[]).find((t) => HIRING_VCT[t] === vct);
}

function latestDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number | undefined, number | undefined];
  if (m === undefined) return new Date(Date.UTC(y, 11, 31));
  if (d === undefined) return new Date(Date.UTC(y, m, 0));
  return new Date(Date.UTC(y, m - 1, d));
}

function earliestDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number | undefined, number | undefined];
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

/** Whole years, rounded down, never overstated for partial dates. */
function wholeYears(start: string, end: Date): number {
  const from = latestDay(start);
  let years = end.getUTCFullYear() - from.getUTCFullYear();
  if (
    end.getUTCMonth() < from.getUTCMonth() ||
    (end.getUTCMonth() === from.getUTCMonth() && end.getUTCDate() < from.getUTCDate())
  )
    years -= 1;
  return Math.max(0, years);
}

/** Fills the coarse claims RFC 0014 §2.2 requires whenever the exact values exist. */
export function withCoarseClaims(
  type: HiringType,
  record: Record<string, unknown>,
  iat: Date,
): Record<string, unknown> {
  if (type === "employment") {
    const r = EmploymentClaims.parse(record);
    const out: Record<string, unknown> = { ...r };
    if (r.start) out.start_year = Number(r.start.slice(0, 4));
    if (r.end) out.end_year = Number(r.end.slice(0, 4));
    if (r.start)
      out.tenure_years = wholeYears(r.start, r.end && !r.current ? earliestDay(r.end) : iat);
    return out;
  }
  if (type === "education") {
    const r = EducationClaims.parse(record);
    const out: Record<string, unknown> = { ...r };
    const granted = r.educationDegrees?.find((d) => d.degreeGrantedStatus === "Granted" && d.date);
    if (granted?.date) out.degree_year = Number(granted.date.slice(0, 4));
    return out;
  }
  return { ...RECORD_SCHEMAS[type].parse(record) };
}

/** Maximum `exp` for a credential issued at `iat` (RFC 0014 §2.2). */
export function maxExpiry(type: HiringType, record: Record<string, unknown>, iat: number): number {
  if (type === "employment") return iat + (record.current === true ? 90 * DAY : TWO_YEARS);
  if (type === "education") return iat + TWO_YEARS;
  const inner = record[type === "professional_license" ? "license" : "certification"];
  const validTo =
    isRecord(inner) && isRecord(inner.effectiveTimePeriod)
      ? inner.effectiveTimePeriod.validTo
      : undefined;
  const cap = iat + TWO_YEARS;
  return typeof validTo === "string"
    ? Math.min(cap, Math.floor(latestDay(validTo).getTime() / 1000) + DAY)
    : cap;
}

/** `iat` rounded down to the start of the day (RFC 0014 §2.1). */
export function roundToDay(date: Date): number {
  return Math.floor(date.getTime() / 1000 / DAY) * DAY;
}

/** The organization whose `id` a non-`own_records` credential must carry (RFC 0014 §3). */
export function recordOrganization(
  type: HiringType,
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const pick = (v: unknown) => (isRecord(v) ? v : undefined);
  if (type === "employment") return pick(record.organization);
  if (type === "education") return pick(record.institution);
  const inner = pick(record[type === "professional_license" ? "license" : "certification"]);
  return inner ? pick(inner.issuingAuthority) : undefined;
}

export interface HiringClaimsInput {
  type: HiringType;
  issuer: string;
  vctIntegrity: string;
  basis: Basis;
  record: Record<string, unknown>;
  holderJwk: Record<string, unknown>;
  status: { idx: number; uri: string };
  holderName?: { given_name?: string; family_name?: string };
  now: Date;
  /** Defaults to the maximum lifetime. */
  expiresAt?: number;
}

/** Issuer-side claims with every type claim selectively disclosable on its own. */
export function hiringCredentialClaims(input: HiringClaimsInput): Record<string, unknown> {
  const iat = roundToDay(input.now);
  const record = withCoarseClaims(input.type, input.record, new Date(iat * 1000));
  if (
    input.basis !== "own_records" &&
    typeof recordOrganization(input.type, record)?.id !== "string"
  )
    throw new OjcpError("invalid_claims", `${input.basis} credentials require the organization id`);
  if (input.type === "employment" && record.current === false && !record.end && record.start)
    throw new OjcpError("invalid_claims", "a former-employment record needs an end date");
  const cap = maxExpiry(input.type, record, iat);
  const exp = Math.min(input.expiresAt ?? cap, cap);
  const claims: Record<string, unknown> = {
    iss: input.issuer,
    vct: HIRING_VCT[input.type],
    "vct#integrity": input.vctIntegrity,
    iat,
    exp,
    cnf: { jwk: input.holderJwk },
    status: { status_list: input.status },
    basis: input.basis,
  };
  for (const [key, value] of Object.entries(record)) claims[key] = sd(disclosable(value));
  for (const key of HOLDER_NAME) {
    const value = input.holderName?.[key];
    if (value) claims[key] = sd(value);
  }
  return claims;
}

/** Makes every nested member and array element its own disclosure (RFC 0014 §2.1). */
function disclosable(value: unknown): unknown {
  if (Array.isArray(value)) return sdArray(value.map(disclosable), { keepOrder: true });
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sd(disclosable(v))]));
}

export interface HiringCredential {
  type: HiringType;
  basis: Basis;
  iss: string;
  iat: number;
  exp: number;
  status: { idx: number; uri: string };
  /** The disclosed record claims (closed set) and any disclosed holder name. */
  record: Record<string, unknown>;
}

const Envelope = z.looseObject({
  iss: z.string(),
  vct: z.string(),
  "vct#integrity": z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  cnf: z.strictObject({ jwk: z.record(z.string(), z.unknown()) }),
  status: z.strictObject({
    status_list: z.strictObject({ idx: z.number().int().nonnegative(), uri: z.string() }),
  }),
  basis: Basis,
});

/**
 * Checks a reconstructed hiring credential against its type (RFC 0014 §2, §3):
 * only defined claims, lifetime cap, `iat` on a day boundary, organization id
 * for platform and source-check bases.
 */
export function parseHiringCredential(claims: Record<string, unknown>): HiringCredential {
  const envelope = Envelope.safeParse(claims);
  if (!envelope.success)
    throw new OjcpError("invalid_claims", "hiring credential envelope is invalid");
  const env = envelope.data;
  const type = hiringTypeOf(env.vct);
  if (!type) throw new OjcpError("invalid_claims", `unknown hiring credential type ${env.vct}`);
  const record: Record<string, unknown> = {};
  const name: Record<string, string> = {};
  for (const [key, value] of Object.entries(claims)) {
    if ((ALWAYS_VISIBLE as readonly string[]).includes(key)) continue;
    if ((HOLDER_NAME as readonly string[]).includes(key)) {
      if (typeof value !== "string")
        throw new OjcpError("invalid_claims", `${key} must be a string`);
      name[key] = value;
    } else record[key] = value;
  }
  const parsed = PRESENTED_RECORD_SCHEMAS[type].safeParse(record);
  if (!parsed.success)
    throw new OjcpError("invalid_claims", `claims outside ${type}/v1 or of the wrong shape`, {
      issues: parsed.error.issues,
    });
  if (env.iat % DAY !== 0) throw new OjcpError("invalid_claims", "iat must be rounded to the day");
  if (env.exp > maxExpiry(type, record, env.iat))
    throw new OjcpError("invalid_claims", "exp exceeds the type's maximum lifetime");
  return {
    type,
    basis: env.basis,
    iss: env.iss,
    iat: env.iat,
    exp: env.exp,
    status: env.status.status_list,
    record: { ...parsed.data, ...name },
  };
}
