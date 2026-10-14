/**
 * Scope coverage (RFC 0008 §2.2). The wallet runs it on the full scope to pick
 * what to disclose; the verifier runs it on the disclosed scope to decide. Where
 * a posting is silent or ambiguous the job is not covered.
 */
import { contains } from "../onet/index.ts";
import { CategoryCode, type JobPostingFacts, Place } from "../wire.ts";
import type { LocationElement, MandateScope, SalaryElement } from "./model.ts";
import { comparableLowEnd, type PostedSalary } from "./salary.ts";

export interface JobFacts {
  /** The primary `occupationalCategory` code, when its `inCodeSet` matches the taxonomy. */
  primaryCode?: string;
  /** Code-form locations only; text values count as unstated (RFC 0009 §2). */
  locations: Array<{ country: string; region?: string }>;
  remotePolicy?: string;
  employmentType?: string;
  experienceLevel?: string;
  salary?: PostedSalary;
}

export function jobFacts(posting: JobPostingFacts, taxonomy: string): JobFacts {
  const facts: JobFacts = { locations: [] };
  const primary = CategoryCode.safeParse(posting.occupationalCategory?.[0]);
  if (primary.success && primary.data.inCodeSet === taxonomy)
    facts.primaryCode = primary.data.codeValue;
  const places = posting.jobLocation === undefined ? [] : [posting.jobLocation].flat();
  for (const raw of places) {
    const place = Place.safeParse(raw);
    const country = place.success ? place.data.address?.addressCountry : undefined;
    if (!country || !/^[A-Z]{2}$/.test(country)) continue;
    const region = place.success ? place.data.address?.addressRegion : undefined;
    facts.locations.push(
      region && /^[A-Z0-9]{1,3}$/.test(region) ? { country, region } : { country },
    );
  }
  if (posting.remote_policy) facts.remotePolicy = posting.remote_policy;
  if (posting.employmentType) facts.employmentType = posting.employmentType;
  if (posting.experienceLevel) facts.experienceLevel = posting.experienceLevel;
  if (posting.baseSalary) facts.salary = posting.baseSalary;
  return facts;
}

export interface ScopeDisclosure {
  job_family: string;
  location: LocationElement;
  remote_policy: string;
  employment_type?: string;
  experience_level?: string;
  salary: SalaryElement;
}

export type CoverageFailure =
  | "unclassified"
  | "job_family"
  | "location"
  | "remote_policy"
  | "employment_type"
  | "experience_level"
  | "salary";

export type CoverageResult =
  | { covered: true; disclose: ScopeDisclosure }
  | { covered: false; failures: CoverageFailure[] };

function pickLocation(scope: MandateScope, job: JobFacts): LocationElement | undefined {
  const anywhere = scope.locations.find((l) => "anywhere" in l);
  if (job.locations.length === 0) {
    // A remote job that names no country is covered only by `anywhere`; any other
    // job without a code location has an unstated location.
    return job.remotePolicy === "remote" ? anywhere : undefined;
  }
  for (const loc of job.locations) {
    const regional = scope.locations.find(
      (l) =>
        "addressCountry" in l &&
        l.addressCountry === loc.country &&
        l.addressRegion !== undefined &&
        l.addressRegion === loc.region,
    );
    if (regional) return regional;
  }
  for (const loc of job.locations) {
    const national = scope.locations.find(
      (l) =>
        "addressCountry" in l && l.addressCountry === loc.country && l.addressRegion === undefined,
    );
    if (national) return national;
  }
  return anywhere;
}

function pickSalary(scope: MandateScope, job: JobFacts): SalaryElement | undefined {
  const any = scope.salary.find((s) => "any" in s);
  if (any) return any;
  const low = comparableLowEnd(job.salary);
  if (low === null) return scope.salary.find((s) => "unstated" in s);
  // The highest rung that does not exceed the posting's low end. A posting with a
  // complete salary in another currency or unit is not covered: the provider can't
  // tell `unstated` from a floor it never sees (see docs/rfc-feedback.md).
  let best: SalaryElement | undefined;
  for (const s of scope.salary) {
    if (!("at_least" in s) || s.currency !== low.currency || s.unitText !== low.unitText) continue;
    if (s.at_least <= low.minValue && (!best || ("at_least" in best && s.at_least > best.at_least)))
      best = s;
  }
  return best;
}

export function evaluateScope(scope: MandateScope, job: JobFacts): CoverageResult {
  const failures: CoverageFailure[] = [];

  let jobFamily: string | undefined;
  if (job.primaryCode === undefined) failures.push("unclassified");
  else {
    const code = job.primaryCode;
    jobFamily = scope.job_families.find((f) => contains(f, code));
    if (jobFamily === undefined) failures.push("job_family");
  }

  const location = pickLocation(scope, job);
  if (location === undefined) failures.push("location");

  const remotePolicy =
    job.remotePolicy !== undefined &&
    (scope.remote_policy as readonly string[]).includes(job.remotePolicy)
      ? job.remotePolicy
      : undefined;
  if (remotePolicy === undefined) failures.push("remote_policy");

  let employmentType: string | undefined;
  if (scope.employment_type !== undefined) {
    employmentType =
      job.employmentType !== undefined && scope.employment_type.includes(job.employmentType)
        ? job.employmentType
        : undefined;
    if (employmentType === undefined) failures.push("employment_type");
  }

  let experienceLevel: string | undefined;
  if (scope.experience_level !== undefined) {
    experienceLevel =
      job.experienceLevel !== undefined && scope.experience_level.includes(job.experienceLevel)
        ? job.experienceLevel
        : undefined;
    if (experienceLevel === undefined) failures.push("experience_level");
  }

  const salary = pickSalary(scope, job);
  if (salary === undefined) failures.push("salary");

  if (failures.length > 0 || !jobFamily || !location || !remotePolicy || !salary)
    return { covered: false, failures };
  return {
    covered: true,
    disclose: {
      job_family: jobFamily,
      location,
      remote_policy: remotePolicy,
      ...(employmentType === undefined ? {} : { employment_type: employmentType }),
      ...(experienceLevel === undefined ? {} : { experience_level: experienceLevel }),
      salary,
    },
  };
}
