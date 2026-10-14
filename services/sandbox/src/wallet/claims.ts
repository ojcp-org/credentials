/**
 * Employment-record claims in plain words, and RFC 0013 §5's permitted list.
 * The wallet, the assistant and the employer all describe a request with the
 * same words, so the candidate sees the same thing on every screen.
 */
import { type ClaimsPathQuery, isRecord, PRESENTED_RECORD_SCHEMAS } from "@ojcp/credentials-core";
import { z } from "zod";

const LABELS: Array<[string, string]> = [
  ["organization.name", "Employer"],
  ["organization.id", "Employer's registration number"],
  ["organization", "Employer"],
  ["current", "Still working there"],
  ["start", "Start date"],
  ["end", "End date"],
  ["start_year", "Year you started"],
  ["end_year", "Year you left"],
  ["tenure_years", "Years you worked there"],
  ["positionHistories.*.title", "Job titles"],
  ["positionHistories.*.start", "When each job started"],
  ["positionHistories.*.end", "When each job ended"],
  ["positionHistories", "Job history"],
  ["given_name", "First name"],
  ["family_name", "Last name"],
];

const key = (path: ClaimsPathQuery): string =>
  path.map((s) => (s === null || typeof s === "number" ? "*" : s)).join(".");

export function claimLabel(path: ClaimsPathQuery): string {
  const k = key(path);
  return LABELS.find(([p]) => p === k)?.[1] ?? k;
}

/**
 * RFC 0013 §5: an employment step may ask only for the claims of RFC 0014 §2.2
 * (and the holder's name). An agent refuses to relay anything else.
 */
export function isPermittedEmploymentClaim(path: ClaimsPathQuery): boolean {
  const top = path[0];
  if (typeof top !== "string") return false;
  if (top === "given_name" || top === "family_name") return path.length === 1;
  return Object.hasOwn(PRESENTED_RECORD_SCHEMAS.employment.shape, top);
}

/** The values a claims path selects (`null` is every array element). */
export function valuesAt(value: unknown, path: ClaimsPathQuery): unknown[] {
  const [head, ...rest] = path;
  if (head === undefined) return value === undefined ? [] : [value];
  if (head === null) return Array.isArray(value) ? value.flatMap((v) => valuesAt(v, rest)) : [];
  if (typeof head === "number") return Array.isArray(value) ? valuesAt(value[head], rest) : [];
  return isRecord(value) ? valuesAt(value[head], rest) : [];
}

export function describeValues(values: readonly unknown[]): string {
  if (values.length === 0) return "Not in your record";
  return values
    .map((v) =>
      typeof v === "boolean" ? (v ? "Yes" : "No") : isRecord(v) ? JSON.stringify(v) : String(v),
    )
    .join(", ");
}
/** The application details the provider puts in `verifier_info` (RFC 0013 §3 item 2). */
export const ApplicationInfo = z.object({
  application_ref: z.string(),
  masked_contact: z.string(),
  purpose: z.string(),
  employer: z.string(),
  job_title: z.string(),
});
export type ApplicationInfo = z.infer<typeof ApplicationInfo>;
export const APPLICATION_INFO_FORMAT = "ojcp_application";
