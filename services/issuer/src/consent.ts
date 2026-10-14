/**
 * The consent screen in plain words (RFC 0008 §3.3), as data. The issuer's own
 * pages render it, and so can an operator's own UI (a wallet provider's app,
 * say) through the JSON consent API. Both say exactly the same thing.
 */
import {
  type CandidateElement,
  type LocationElement,
  onet,
  type ParsedStandingMandateDataset,
} from "@ojcp/credentials-core";
import type { AgentClient } from "./config.ts";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export const TOOL_WORDS: Record<string, string> = {
  search_jobs: "Search for jobs",
  get_job_detail: "Read job details",
  get_employer_context: "Read employer information",
  begin_application: "Start applications",
  submit_application: "Send applications",
  check_application_status: "Check how applications are going",
};

export const CONSENT_WORDS: Record<string, string> = {
  search_personalization: "your search preferences",
  fit_scoring: "your search preferences, skills and experience",
  application_prefill: "your contact details, resume and profile, to fill in applications",
  full_profile: "your full profile",
};

export const REMOTE_WORDS: Record<string, string> = {
  on_site: "On site",
  hybrid: "Hybrid",
  remote: "Remote",
  flexible: "Flexible",
};

export const NEVER = [
  "Agree to terms, legal agreements or background-check authorizations",
  "Make statements or attestations for you",
  "Answer equal-opportunity questions",
  "Accept a job offer",
];

export const WRITER = "The agent writes your applications for you.";
export const ENFORCEMENT =
  "Employers' systems enforce these when the agent applies through OJCP. Elsewhere, such as by email, they're rules the agent must follow that no employer can check.";

export function placeInWords(place: LocationElement): string {
  if ("anywhere" in place) return "Anywhere, for remote jobs that don't name a country";
  const country = regionNames.of(place.addressCountry) ?? place.addressCountry;
  return place.addressRegion ? `${place.addressRegion}, ${country}` : country;
}

export function contactInWords(element: CandidateElement): string {
  return "email" in element ? element.email : "phone" in element ? element.phone : "a key you hold";
}

export function money(value: number, currency: string, unit: string): string {
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${amount} a ${unit.toLowerCase()}`;
}

export const day = (d: Date): string =>
  d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export function payInWords(d: ParsedStandingMandateDataset): string {
  if (!d.salary_floor) return "Any pay.";
  const floor = `Only jobs that pay at least ${money(d.salary_floor.value, d.salary_floor.currency, d.salary_floor.unitText)}.`;
  return `${floor} ${d.include_unstated_salary ? "Jobs that don't say what they pay are included." : "Jobs that don't say what they pay are left out."}`;
}

export function recipientsInWords(d: ParsedStandingMandateDataset): string {
  return d.provider_trust_floor === "audited"
    ? "Only employers whose identity the agent has verified and that have been independently audited."
    : "Only employers whose identity the agent has verified.";
}

export interface Option {
  /** What the form sends back. */
  value: string;
  label: string;
  hint?: string;
}

/** Everything the consent screen shows, for a UI of the operator's own. */
export interface ConsentView {
  id: string;
  client: { name: string; agentId: string; affiliated: boolean };
  until: string;
  jobs: Option[];
  places: Option[];
  arrangements: Option[];
  pay: string;
  /** The highest values the person may keep; they can only lower them. */
  perEmployer: number;
  total: number;
  actions: Option[];
  recipients: string;
  shared: string;
  never: string[];
  /** RFC 0008 §3.3: the agent, not the employer, writes the application. */
  writer: string;
  /** RFC 0008 §3.3: "never" is enforced only when the agent applies through OJCP. */
  enforcement: string;
  ending: string;
  /** Each contact gets a code; `value` is the key for its code on approval. */
  contacts: Option[];
}

export function consentView(
  id: string,
  client: AgentClient,
  d: ParsedStandingMandateDataset,
  expiry: Date,
): ConsentView {
  const until = day(expiry);
  return {
    id,
    client: { name: client.name, agentId: client.agentId, affiliated: client.affiliated },
    until,
    jobs: d.job_families.map((code) => ({
      value: code,
      label: `${onet.title(code) ?? code} and related roles`,
      hint: `Occupation code ${code}`,
    })),
    places: d.locations.map((place) => ({
      value: JSON.stringify(place),
      label: placeInWords(place),
    })),
    arrangements: d.remote_policy.map((p) => ({ value: p, label: REMOTE_WORDS[p] ?? p })),
    pay: payInWords(d),
    perEmployer: d.per_employer,
    total: d.applications_total,
    actions: d.actions.map((a) => ({ value: a, label: TOOL_WORDS[a] ?? a })),
    recipients: recipientsInWords(d),
    shared: `Each employer sees ${d.candidate.map(contactInWords).join(" or ")}, and ${CONSENT_WORDS[d.consent_scope] ?? d.consent_scope}.`,
    never: NEVER,
    writer: WRITER,
    enforcement: ENFORCEMENT,
    ending: `It ends on ${until}. You can cancel any time. ${client.name} may renew its credentials without asking you, but only on these same terms and with the same end date.`,
    contacts: d.candidate.map((c) => ({ value: JSON.stringify(c), label: contactInWords(c) })),
  };
}
