/** @jsxImportSource hono/jsx */
/**
 * The pages the issuer renders itself: the consent screen (RFC 0008 §3.3) and
 * the account page where a person cancels. The agent platform never renders
 * consent. Every limit is shown in words, and the person can narrow any of it.
 */
import { onet, type ParsedStandingMandateDataset } from "@ojcp/credentials-core";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { AgentClient } from "./config.ts";
import {
  CONSENT_WORDS,
  contactInWords,
  day,
  NEVER,
  payInWords,
  placeInWords,
  REMOTE_WORDS,
  recipientsInWords,
  TOOL_WORDS,
} from "./consent.ts";
import type { MandateAuthorization } from "./store.ts";

const CSS = `:root{--ink:#14213d;--ink-2:#4a5568;--ink-3:#718096;--line:#e2e8f0;--bg:#f7f8fb;--accent:#3b5bdb;--accent-2:#edf2ff;--ok:#2b8a3e;--bad:#c92a2a}
*{box-sizing:border-box}body{margin:0;font:15.5px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.site{background:#fff;border-bottom:1px solid var(--line)}.site div{max-width:44rem;margin:0 auto;padding:12px 20px;display:flex;gap:8px;align-items:center;font-size:14px;color:var(--ink-2)}
.lock{width:22px;height:22px;border-radius:6px;background:var(--accent-2);color:var(--accent);display:grid;place-items:center;font-size:12px}
main{max-width:44rem;margin:0 auto;padding:24px 20px 60px}
h1{font-size:25px;line-height:1.25;margin:4px 0 8px}h2{font-size:16.5px;margin:0 0 4px}
.lead{color:var(--ink-2);margin:0 0 18px}
.who{display:flex;gap:12px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:0 0 16px}
.who .av{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#5c7cfa,#845ef7);color:#fff;display:grid;place-items:center;font-weight:700}
.chip{display:inline-block;font-size:12px;font-weight:650;border-radius:999px;padding:1px 9px;margin-left:6px}
.chip.ok{background:#ebfbee;color:var(--ok)}.chip.warn{background:#fff4e6;color:#b35c00}
section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 12px}
section p{margin:6px 0}.hint{color:var(--ink-3);font-size:13.5px}
.opt{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--line);cursor:pointer}.opt:last-child{border:0}
.opt input{margin-top:4px;width:17px;height:17px;accent-color:var(--accent)}
.opt small{display:block;color:var(--ink-3)}
.limit{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}
select,input[type=text]{font:inherit;padding:7px 10px;border:1px solid #cbd5e0;border-radius:9px;background:#fff}
input.code{font-size:22px;letter-spacing:.3em;width:10rem;text-align:center}
ul.never{margin:6px 0 0;padding:0;list-style:none}ul.never li{padding:4px 0 4px 26px;position:relative}
ul.never li:before{content:"✕";position:absolute;left:0;top:4px;width:18px;height:18px;border-radius:5px;background:#fff5f5;color:var(--bad);font-size:11px;display:grid;place-items:center}
.actions{padding:8px 0 4px;display:flex;gap:10px;flex-wrap:wrap}
button{font:inherit;font-weight:600;border-radius:10px;padding:11px 18px;cursor:pointer;border:1px solid transparent}
.primary{background:var(--accent);color:#fff}.secondary{background:#fff;color:var(--ink);border-color:var(--line)}.danger{background:#fff;color:var(--bad);border-color:#ffc9c9}
.alert{background:#fff5f5;border:1px solid #ffc9c9;color:#8a1c1c;border-radius:12px;padding:10px 14px;margin:0 0 14px}
.foot{color:var(--ink-3);font-size:13px;text-align:center;margin-top:18px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 12px;display:flex;justify-content:space-between;gap:16px;align-items:center}`;

function Layout(props: { title: string; host?: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {/* Trusted constant: JSX would escape the quotes inside the CSS. */}
        <style>{raw(CSS)}</style>
      </head>
      <body>
        <div class="site">
          <div>
            <span class="lock">✓</span> Permission service{props.host ? ` · ${props.host}` : ""}
          </div>
        </div>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

/** What the person has chosen so far; carried through the code step so nothing is lost. */
export interface Selection {
  job_families?: string[];
  locations?: string[];
  remote_policy?: string[];
  actions?: string[];
  per_employer?: number;
  applications_total?: number;
}

export interface ConsentProps {
  pendingId: string;
  client: AgentClient;
  dataset: ParsedStandingMandateDataset;
  expiry: Date;
  codesSent: boolean;
  error?: string;
  selected?: Selection;
  host?: string;
}

export function ConsentPage({
  pendingId,
  client,
  dataset: d,
  expiry,
  codesSent,
  error,
  selected,
  host,
}: ConsentProps) {
  const until = day(expiry);
  const on = (list: string[] | undefined, value: string) => !list || list.includes(value);
  const perEmployer = selected?.per_employer ?? d.per_employer;
  const total = selected?.applications_total ?? d.applications_total;
  const contacts = d.candidate.map(contactInWords).join(" or ");
  return (
    <Layout title={`Give ${client.name} permission to apply for you`} {...(host ? { host } : {})}>
      <div class="who">
        <div class="av">{client.name.slice(0, 1)}</div>
        <div>
          <strong>{client.name}</strong>
          {client.affiliated ? (
            <span class="chip warn">Shares control with this service</span>
          ) : (
            <span class="chip ok">Independent of this service</span>
          )}
          <div class="hint">is asking for permission to apply for jobs for you until {until}</div>
        </div>
      </div>
      <h1>Review what {client.name} may do</h1>
      <p class="lead">
        Untick anything you don't want, and lower any limit. You can cancel at any time.
      </p>
      {error ? (
        <div class="alert" role="alert">
          {error}
        </div>
      ) : null}
      <form method="post" action={`/authorize/${pendingId}/approve`}>
        <section>
          <h2>Kinds of job</h2>
          {d.job_families.map((code) => (
            <label class="opt">
              <input
                type="checkbox"
                name="job_families"
                value={code}
                checked={on(selected?.job_families, code)}
              />
              <span>
                {onet.title(code) ?? code} and related roles<small>Occupation code {code}</small>
              </span>
            </label>
          ))}
        </section>
        <section>
          <h2>Where and how</h2>
          {d.locations.map((place) => (
            <label class="opt">
              <input
                type="checkbox"
                name="locations"
                value={JSON.stringify(place)}
                checked={on(selected?.locations, JSON.stringify(place))}
              />
              <span>{placeInWords(place)}</span>
            </label>
          ))}
          {d.remote_policy.map((p) => (
            <label class="opt">
              <input
                type="checkbox"
                name="remote_policy"
                value={p}
                checked={on(selected?.remote_policy, p)}
              />
              <span>{REMOTE_WORDS[p] ?? p}</span>
            </label>
          ))}
          {d.employment_type ? (
            <p class="hint">Employment types: {d.employment_type.join(", ")}.</p>
          ) : null}
          {d.experience_level ? <p class="hint">Levels: {d.experience_level.join(", ")}.</p> : null}
        </section>
        <section>
          <h2>Pay</h2>
          <p>{payInWords(d)}</p>
          <p class="hint">
            Employers never see this number. They only learn that a job's own pay is acceptable to
            you.
          </p>
        </section>
        <section>
          <h2>Limits</h2>
          <div class="limit">
            At most
            <select name="per_employer" aria-label="Applications per company">
              {[1, 2, 3]
                .filter((n) => n <= d.per_employer)
                .map((n) => (
                  <option value={String(n)} selected={n === perEmployer}>
                    {n}
                  </option>
                ))}
            </select>
            per company, and at most
            <input
              type="text"
              name="applications_total"
              value={String(total)}
              inputmode="numeric"
              style="width:5rem"
              aria-label="Applications in total"
            />
            in total.
          </div>
          <p class="hint">What it may do:</p>
          {d.actions.map((a) => (
            <label class="opt">
              <input type="checkbox" name="actions" value={a} checked={on(selected?.actions, a)} />
              <span>{TOOL_WORDS[a] ?? a}</span>
            </label>
          ))}
        </section>
        <section>
          <h2>Who receives your applications</h2>
          <p>{recipientsInWords(d)}</p>
          <p>
            Each employer sees <strong>{contacts}</strong>, and {CONSENT_WORDS[d.consent_scope]}.
            The agent writes your applications for you.
          </p>
        </section>
        <section>
          <h2>Never, under this permission</h2>
          <ul class="never">
            {NEVER.map((n) => (
              <li>{n}</li>
            ))}
          </ul>
          <p class="hint">
            Employers' systems enforce these when the agent applies through OJCP. Elsewhere, such as
            by email, they're rules the agent must follow that no employer can check.
          </p>
        </section>
        <section>
          <h2>Ending it</h2>
          <p>
            It ends on <strong>{until}</strong>. You can cancel any time on this service's account
            page by confirming your email again. {client.name} may renew its credentials without
            asking you, but only on these same terms and with the same end date.
          </p>
        </section>
        <section>
          <h2>Confirm it's you</h2>
          {codesSent ? (
            d.candidate.map((c) => (
              <div class="limit">
                <label>
                  Code sent to <strong>{contactInWords(c)}</strong>
                  <br />
                  <input
                    class="code"
                    type="text"
                    name={`code:${JSON.stringify(c)}`}
                    autocomplete="one-time-code"
                    inputmode="numeric"
                    maxlength={6}
                    required
                  />
                </label>
              </div>
            ))
          ) : (
            <p class="hint">
              We'll send a 6-digit code to {d.candidate.map(contactInWords).join(" and ")}.
            </p>
          )}
        </section>
        <div class="actions">
          {codesSent ? (
            <button class="primary" type="submit" name="decision" value="approve">
              Give permission
            </button>
          ) : (
            <button class="primary" type="submit" formaction={`/authorize/${pendingId}/send-codes`}>
              Send me a code
            </button>
          )}
          <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>
            Decline
          </button>
        </div>
      </form>
      <p class="foot">This page comes from the permission service, not from {client.name}.</p>
    </Layout>
  );
}

export function MessagePage(props: { title: string; message: string }) {
  return (
    <Layout title={props.title}>
      <h1>{props.title}</h1>
      <p class="lead">{props.message}</p>
    </Layout>
  );
}

export function AccountStartPage(props: { error?: string }) {
  return (
    <Layout title="Your permissions">
      <h1>Your permissions</h1>
      <p class="lead">
        See and cancel the permissions you've given job agents. First, confirm it's you.
      </p>
      {props.error ? (
        <div class="alert" role="alert">
          {props.error}
        </div>
      ) : null}
      <form method="post" action="/account/code">
        <section>
          <label>
            Email address or phone number
            <br />
            <input
              type="text"
              name="identifier"
              style="width:100%;max-width:22rem;margin-top:6px"
              required
            />
          </label>
        </section>
        <button class="primary" type="submit">
          Send me a code
        </button>
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
        <section>
          <input
            class="code"
            type="text"
            name="code"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength={6}
            required
            aria-label="Code"
          />
        </section>
        <button class="primary" type="submit">
          Continue
        </button>
      </form>
    </Layout>
  );
}

export function AccountPage(props: {
  authorizations: Array<{ authorization: MandateAuthorization; client?: AgentClient }>;
}) {
  return (
    <Layout title="Your permissions">
      <h1>Your permissions</h1>
      {props.authorizations.length === 0 ? (
        <p class="lead">You haven't given any job agent permission right now.</p>
      ) : null}
      {props.authorizations.map(({ authorization: a, client }) => (
        <form method="post" action={`/account/revoke/${a.id}`} class="card">
          <div>
            <strong>{client?.name ?? a.agentId}</strong>
            <div class="hint">
              {a.dataset.job_families.map((c) => onet.title(c) ?? c).join(", ")} · until{" "}
              {day(new Date(a.exp * 1000))}
            </div>
          </div>
          <button class="danger" type="submit">
            Cancel
          </button>
        </form>
      ))}
    </Layout>
  );
}
