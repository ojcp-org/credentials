/** @jsxImportSource hono/jsx */
/**
 * The pages the issuer renders itself: the consent screen (RFC 0008 §3.3) and
 * the account page where a user revokes. The agent platform never renders
 * consent. Wording is plain; every limit is shown in words.
 */
import {
  type CandidateElement,
  type LocationElement,
  onet,
  type ParsedStandingMandateDataset,
} from "@ojcp/credentials-core";
import type { Child } from "hono/jsx";
import type { AgentClient } from "./config.ts";
import type { MandateAuthorization } from "./store.ts";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

const TOOL_WORDS: Record<string, string> = {
  search_jobs: "search for jobs",
  get_job_detail: "read job details",
  get_employer_context: "read employer information",
  begin_application: "start applications",
  submit_application: "send applications",
  check_application_status: "check application status",
};

const CONSENT_WORDS: Record<string, string> = {
  search_personalization: "your search preferences",
  fit_scoring: "your search preferences, skills and experience, to score fit",
  application_prefill: "your contact details, resume and profile, to fill in applications",
  full_profile: "your full profile",
};

const REMOTE_WORDS: Record<string, string> = {
  on_site: "on site",
  hybrid: "hybrid",
  remote: "remote",
  flexible: "flexible",
};

export function placeInWords(place: LocationElement): string {
  if ("anywhere" in place) return "anywhere, for remote jobs that name no country";
  const country = regionNames.of(place.addressCountry) ?? place.addressCountry;
  return place.addressRegion ? `${place.addressRegion}, ${country}` : country;
}

export function contactInWords(element: CandidateElement): string {
  return "email" in element ? element.email : "phone" in element ? element.phone : "a key you hold";
}

function money(value: number, currency: string, unit: string): string {
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${amount} a ${unit.toLowerCase()}`;
}

function Layout(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <style>{`body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.5rem}li{margin:.2rem 0}.note{color:#555;font-size:.92rem}
fieldset{border:1px solid #ccc;padding:.75rem;margin:1rem 0}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}
input[type=text]{font:inherit;padding:.3rem;width:8rem}`}</style>
      </head>
      <body>{props.children}</body>
    </html>
  );
}

export interface ConsentProps {
  pendingId: string;
  client: AgentClient;
  dataset: ParsedStandingMandateDataset;
  expiry: Date;
  codesSent: boolean;
  error?: string;
}

export function ConsentPage({
  pendingId,
  client,
  dataset: d,
  expiry,
  codesSent,
  error,
}: ConsentProps) {
  const until = expiry.toLocaleDateString("en", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const floorWords = d.salary_floor
    ? `Jobs that pay at least ${money(d.salary_floor.value, d.salary_floor.currency, d.salary_floor.unitText)}.`
    : "Any pay.";
  const tierWords =
    d.provider_trust_floor === "audited"
      ? "Applications go only to employers whose identity your agent has verified and that have been independently audited."
      : "Applications go only to employers whose identity your agent has verified.";
  return (
    <Layout title={`Let ${client.name} apply for you`}>
      <h1>
        Let {client.name} apply for jobs for you until {until}
      </h1>
      <p>
        {client.affiliated
          ? `This service is run by, or shares control with, ${client.name}.`
          : `This service is independent of ${client.name}.`}
      </p>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <form method="post" action={`/authorize/${pendingId}/approve`}>
        <h2>Jobs it can apply to</h2>
        <fieldset>
          <legend>Job families</legend>
          {d.job_families.map((code) => (
            <label style="display:block">
              <input type="checkbox" name="job_families" value={code} checked />{" "}
              {onet.title(code) ?? code} ({code})
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Places</legend>
          {d.locations.map((place) => (
            <label style="display:block">
              <input type="checkbox" name="locations" value={JSON.stringify(place)} checked />{" "}
              {placeInWords(place)}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Work arrangements</legend>
          {d.remote_policy.map((p) => (
            <label style="display:block">
              <input type="checkbox" name="remote_policy" value={p} checked />{" "}
              {REMOTE_WORDS[p] ?? p}
            </label>
          ))}
        </fieldset>
        {d.employment_type ? <p>Employment types: {d.employment_type.join(", ")}.</p> : null}
        {d.experience_level ? <p>Experience levels: {d.experience_level.join(", ")}.</p> : null}
        <p>
          {floorWords}{" "}
          {d.salary_floor
            ? d.include_unstated_salary
              ? "Jobs that don't state comparable pay are included."
              : "Jobs that don't state comparable pay are not included."
            : null}
        </p>

        <h2>Limits</h2>
        <label style="display:block">
          At most{" "}
          <select name="per_employer">
            {[1, 2, 3]
              .filter((n) => n <= d.per_employer)
              .map((n) => (
                <option value={String(n)} selected={n === d.per_employer}>
                  {n}
                </option>
              ))}
          </select>{" "}
          applications to any one company,
        </label>
        <label style="display:block">
          and at most{" "}
          <input
            type="text"
            name="applications_total"
            value={String(d.applications_total)}
            inputmode="numeric"
          />{" "}
          applications in total.
        </label>
        <p>It can:</p>
        {d.actions.map((a) => (
          <label style="display:block">
            <input type="checkbox" name="actions" value={a} checked /> {TOOL_WORDS[a] ?? a}
          </label>
        ))}
        <p>{tierWords}</p>
        <p>It may share {CONSENT_WORDS[d.consent_scope]}.</p>
        <p>
          Each company it applies to sees {d.candidate.map(contactInWords).join(" or ")}. The agent
          writes the application content for you.
        </p>

        <h2>Never covered</h2>
        <p>
          Legal agreements, background-check authorizations, attestations, voluntary
          equal-opportunity questions, and accepting an offer. Employers' systems enforce "never
          accept an offer" only within OJCP. Elsewhere, such as email, it is an instruction the
          agent is required to follow, which no employer can check.
        </p>

        <h2>Ending it</h2>
        <p>
          This ends on {until}. You can cancel at any time on this site's account page, by proving
          your email address or phone number again. {client.name} may renew its credentials without
          asking you, only on these same terms and with the same end date.
        </p>

        <h2>Confirm it's you</h2>
        {codesSent ? (
          d.candidate.map((c) => (
            <label style="display:block">
              Code sent to {contactInWords(c)}:{" "}
              <input
                type="text"
                name={`code:${JSON.stringify(c)}`}
                autocomplete="one-time-code"
                inputmode="numeric"
                required
              />
            </label>
          ))
        ) : (
          <p class="note">We'll send a code to {d.candidate.map(contactInWords).join(" and ")}.</p>
        )}
        {codesSent ? (
          <button type="submit" name="decision" value="approve">
            Approve
          </button>
        ) : (
          <button type="submit" formaction={`/authorize/${pendingId}/send-codes`}>
            Send codes
          </button>
        )}
        <button type="submit" name="decision" value="deny" formnovalidate>
          Decline
        </button>
      </form>
    </Layout>
  );
}

export function MessagePage(props: { title: string; message: string }) {
  return (
    <Layout title={props.title}>
      <h1>{props.title}</h1>
      <p>{props.message}</p>
    </Layout>
  );
}

export function AccountStartPage(props: { error?: string }) {
  return (
    <Layout title="Your standing mandates">
      <h1>Your standing mandates</h1>
      {props.error ? (
        <p role="alert">
          <strong>{props.error}</strong>
        </p>
      ) : null}
      <form method="post" action="/account/code">
        <label>
          Email address or phone number{" "}
          <input type="text" name="identifier" style="width:16rem" required />
        </label>{" "}
        <button type="submit">Send code</button>
      </form>
    </Layout>
  );
}

export function AccountCodePage(props: { challenge: string }) {
  return (
    <Layout title="Enter your code">
      <h1>Enter your code</h1>
      <form method="post" action="/account/verify">
        <input type="hidden" name="challenge" value={props.challenge} />
        <label>
          Code{" "}
          <input
            type="text"
            name="code"
            autocomplete="one-time-code"
            inputmode="numeric"
            required
          />
        </label>{" "}
        <button type="submit">Continue</button>
      </form>
    </Layout>
  );
}

export function AccountPage(props: {
  authorizations: Array<{ authorization: MandateAuthorization; client?: AgentClient }>;
}) {
  return (
    <Layout title="Your standing mandates">
      <h1>Your standing mandates</h1>
      {props.authorizations.length === 0 ? <p>You have no active standing mandates.</p> : null}
      {props.authorizations.map(({ authorization: a, client }) => (
        <form method="post" action={`/account/revoke/${a.id}`}>
          <p>
            <strong>{client?.name ?? a.agentId}</strong>, until{" "}
            {new Date(a.exp * 1000).toLocaleDateString("en", {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
            : {a.dataset.job_families.map((c) => onet.title(c) ?? c).join(", ")}.
          </p>
          <button type="submit">Cancel this</button>
        </form>
      ))}
    </Layout>
  );
}
