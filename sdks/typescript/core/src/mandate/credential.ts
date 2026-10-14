/**
 * Standing-mandate claims: built by the issuer (RFC 0008 §2, §3), checked by the
 * verifier against the disclosure rule and padding (§2.1, §2.5).
 */
import { OjcpError } from "../errors.ts";
import { isRecord } from "../guards.ts";
import type { JWK } from "../keys.ts";
import { ONET_SOC_2019 } from "../onet/index.ts";
import { sdArray } from "../sd-jwt.ts";
import {
  ALLOW_LIST_PATHS,
  BINDING_TOKENS,
  BREADTH,
  type Breadth,
  breadthOf,
  monthEpochs,
  normalizeCandidate,
  PAD,
  type ParsedStandingMandateDataset,
  type ProhibitedToken,
  type SalaryElement,
  STANDING_MANDATE_VCT,
  type StandingMandateClaims,
  StandingMandateClaims as StandingMandateClaimsSchema,
} from "./model.ts";
import { salaryRungs } from "./salary.ts";

export interface StandingMandateClaimsInput {
  issuer: string;
  dataset: ParsedStandingMandateDataset;
  holderJwk: JWK;
  status: { idx: number; uri: string };
  vctIntegrity: string;
  ojcpVersion: string;
  now: Date;
}

export function salaryElements(dataset: ParsedStandingMandateDataset): SalaryElement[] {
  const elements: SalaryElement[] = dataset.salary_floor
    ? salaryRungs(dataset.salary_floor)
    : [{ any: true }];
  if (dataset.include_unstated_salary && dataset.salary_floor) elements.push({ unstated: true });
  return elements;
}

/** The issuer-side claims for one credential of a batch, with allow-lists marked for disclosure. */
export function standingMandateClaims(input: StandingMandateClaimsInput): Record<string, unknown> {
  const { dataset } = input;
  const breadth = breadthOf(dataset);
  if (breadth === null)
    throw new OjcpError("policy", "mandate is wider than broad and cannot be issued");
  const pad = BREADTH[breadth].padTo;
  const { nbf, exp } = monthEpochs(input.now, dataset.months);
  const prohibited = [...new Set<ProhibitedToken>([...dataset.prohibited, ...BINDING_TOKENS])];
  const scope: Record<string, unknown> = {
    taxonomy: ONET_SOC_2019,
    job_families: sdArray(dataset.job_families, { padTo: pad }),
    locations: sdArray(dataset.locations, { padTo: pad }),
    remote_policy: sdArray(dataset.remote_policy, { padTo: PAD.remote_policy }),
    salary: sdArray(salaryElements(dataset), { padTo: PAD.salary }),
  };
  if (dataset.employment_type)
    scope.employment_type = sdArray(dataset.employment_type, { padTo: PAD.employment_type });
  if (dataset.experience_level)
    scope.experience_level = sdArray(dataset.experience_level, { padTo: PAD.experience_level });
  return {
    iss: input.issuer,
    vct: STANDING_MANDATE_VCT,
    "vct#integrity": input.vctIntegrity,
    ojcp_version: input.ojcpVersion,
    nbf,
    exp,
    cnf: { jwk: input.holderJwk },
    agent_id: dataset.agent_id,
    status: { status_list: input.status },
    candidate: sdArray(dataset.candidate.map(normalizeCandidate), { padTo: PAD.candidate }),
    scope,
    limits: { per_employer: dataset.per_employer },
    breadth,
    actions: sdArray(dataset.actions, { padTo: PAD.actions }),
    prohibited,
    consent_scope: dataset.consent_scope,
    provider_trust_floor: dataset.provider_trust_floor,
  };
}

const ALLOW_LIST_KEYS = new Set(ALLOW_LIST_PATHS.map((p) => p.join(".")));

function padFor(path: string, breadth: Breadth): number {
  if (path === "scope.job_families" || path === "scope.locations") return BREADTH[breadth].padTo;
  const key = path.replace(/^scope\./, "") as keyof typeof PAD;
  return PAD[key];
}

/**
 * RFC 0008 §2.1 disclosure rule on the issuer-signed payload (before any
 * disclosure is applied): no `_sd` anywhere; array digests only, and only, in the
 * allow-lists; each allow-list exactly its padded length (§2.5).
 */
export function checkDisclosureRule(payload: Record<string, unknown>): void {
  const breadth = payload.breadth;
  if (breadth !== "narrow" && breadth !== "broad")
    throw new OjcpError("disclosure_rule", "breadth missing or invalid");

  const walk = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      const key = path.join(".");
      const isAllowList = ALLOW_LIST_KEYS.has(key);
      for (const element of value) {
        const isDigest = isRecord(element) && "..." in element;
        if (isAllowList && !isDigest)
          throw new OjcpError("disclosure_rule", `${key} must contain only array-element digests`);
        if (!isAllowList && isDigest)
          throw new OjcpError(
            "disclosure_rule",
            `array-element digest outside an allow-list at ${key}`,
          );
        if (isDigest && (Object.keys(element).length !== 1 || typeof element["..."] !== "string"))
          throw new OjcpError("disclosure_rule", `malformed digest entry in ${key}`);
        if (!isDigest) walk(element, path);
      }
      if (isAllowList && value.length !== padFor(key, breadth))
        throw new OjcpError(
          "disclosure_rule",
          `${key} has ${value.length} entries, not its padded length`,
          {
            fixture: "standing_padding",
          },
        );
      return;
    }
    if (!isRecord(value)) return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "_sd")
        throw new OjcpError(
          "disclosure_rule",
          `_sd found at ${[...path].join(".") || "top level"}`,
        );
      if (k === "_sd_alg" && path.length === 0) continue;
      walk(v, [...path, k]);
    }
  };
  walk(payload, []);
  for (const path of ALLOW_LIST_PATHS) {
    const required = !(path[1] === "employment_type" || path[1] === "experience_level");
    let node: unknown = payload;
    for (const seg of path) node = isRecord(node) ? node[seg] : undefined;
    if (required && !Array.isArray(node))
      throw new OjcpError("disclosure_rule", `${path.join(".")} is missing`);
  }
  for (const forbidden of ["aud", "sub", "acting_on_behalf_of", "iat", "jti"])
    if (forbidden in payload)
      throw new OjcpError("invalid_claims", `standing mandate must not carry ${forbidden}`);
}

/** Parses reconstructed claims; allow-lists then hold only what was disclosed. */
export function parseStandingMandate(claims: Record<string, unknown>): StandingMandateClaims {
  const parsed = StandingMandateClaimsSchema.safeParse(claims);
  if (!parsed.success)
    throw new OjcpError("invalid_claims", "standing mandate claims are invalid", {
      issues: parsed.error.issues,
    });
  const m = parsed.data;
  for (const token of BINDING_TOKENS)
    if (!m.prohibited.includes(token))
      throw new OjcpError("invalid_claims", `prohibited must contain ${token}`);
  return m;
}
