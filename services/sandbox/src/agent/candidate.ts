/**
 * What the candidate sees: jobs with a plain answer to "can my agent apply,
 * and to whom does it go", applications with what each employer learned and
 * didn't, and the permission they gave in words. Built on the agent, never
 * around it: every answer comes from the same checks the wallet runs.
 */
import {
  type CoverageFailure,
  evaluateScope,
  type JobPostingFacts,
  jobFacts,
  onet,
  type ScopeDisclosure,
  type StandingMandateClaims,
} from "@ojcp/credentials-core";
import { confirmEmployer, type DerivedTier } from "@ojcp/trust";
import type { Host } from "../config.ts";
import {
  type ApplyOutcome,
  employerName,
  PROVIDER_HOSTS,
  postingEmployer,
  type SandboxAgent,
} from "./agent.ts";

/** Who receives an application, as RFC 0010 §5.5 says to show it. */
export interface Recipient {
  /** The attested legal name, or the bare host when nothing could be verified. */
  name: string;
  verified: boolean;
  /** e.g. "Identity verified · registered in US-DE". */
  note: string;
  /** For hosted sites: the employer the application is for, confirmed only by an independent attestation. */
  onBehalfOf?: { name: string; confirmed: boolean };
  /** One sentence for lists and records. */
  summary: string;
}

function recipientOf(
  derived: DerivedTier,
  site: string,
  employer: { ojcp_employer_id?: string; name?: string },
): Recipient {
  if (!derived.entity)
    return {
      name: site,
      verified: false,
      note: whyUnverified(derived),
      summary: `${site} (unverified)`,
    };
  const name = derived.entity.legal_name;
  const hosted =
    employer.name && employer.name !== name
      ? confirmEmployer(derived, {
          ...(employer.ojcp_employer_id ? { ojcp_employer_id: employer.ojcp_employer_id } : {}),
          name: employer.name,
        })
      : undefined;
  const note = `Identity verified${derived.tier === "audited" ? " and audited" : ""} · registered in ${derived.entity.jurisdiction}${derived.weakerPolicy ? " · single-attester policy" : ""}`;
  // RFC 0010 §5.5: the attested legal name with its jurisdiction, and the host it was verified for.
  const who = `${name} (${derived.entity.jurisdiction}) at ${new URL(`https://${site}`).hostname}`;
  const summary = hosted
    ? `${who}, on behalf of ${hosted.name}${hosted.confirmed ? "" : " (not confirmed)"}`
    : who;
  return { name, verified: true, note, summary, ...(hosted ? { onBehalfOf: hosted } : {}) };
}

/** Why a site's identity couldn't be confirmed, in words, from what derivation found (RFC 0010 §5.2). */
function whyUnverified(derived: DerivedTier): string {
  const reasons = new Set(derived.rejected.map((r) => r.reason));
  if (reasons.has("wrong_subject"))
    return "It shows attestations made for a different site or key: copied, or the site changed hands.";
  if (reasons.has("distrusted"))
    return "The trust list stopped trusting the attester that vouched for it.";
  if (derived.notes.some((n) => /status (suspended|revoked)/.test(n)))
    return "An attester suspended what it said about this site while it investigates.";
  if (reasons.has("expired") || reasons.has("lifetime"))
    return "What attesters said about it has expired.";
  if (reasons.has("untrusted_issuer"))
    return "The only parties vouching for it aren't on the trust list.";
  return "No independent party vouches for who runs it.";
}

const ORDER: Record<FeedItem["verdict"], number> = {
  can_apply: 0,
  applied: 1,
  no_permission: 2,
  outside: 3,
  unverified: 4,
};

/**
 * The ATS lists its tenants' jobs on its own site too. Read the tenant's
 * careers site first and skip the ATS's copy. (The lookalike's copies of
 * Acme's jobs stay: that a stranger lists them is the point.)
 */
const TENANT_FIRST = (host: Host): number => (host === "globex" ? 0 : 1);
const LISTS_TENANT_JOBS = new Set<Host>(["ats", "globex"]);

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
const day = (s: number) =>
  new Date(s * 1000).toLocaleDateString("en", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

const WHY_NOT: Record<CoverageFailure, string> = {
  unclassified: "The posting has no occupation code, so I can't tell whether it's a job you chose.",
  job_family: "It isn't one of the kinds of job you chose.",
  location: "It isn't in a place you chose.",
  remote_policy: "Its work arrangement isn't one you chose.",
  employment_type: "Its employment type isn't one you chose.",
  experience_level: "Its level isn't one you chose.",
  salary: "It pays less than your floor, or doesn't say what it pays.",
};

export interface FeedItem {
  provider: Host;
  site: string;
  job: {
    id: string;
    title: string;
    employer: string;
    place: string;
    arrangement: string;
    pay: string;
    occupation: string;
  };
  recipient: Recipient;
  verdict: "can_apply" | "outside" | "unverified" | "applied" | "no_permission";
  reasons: string[];
}

export interface ApplicationRecord {
  id: string;
  at: number;
  provider: Host;
  jobId: string;
  title: string;
  employer: string;
  recipient: string;
  state: "sent" | "needs_you" | "not_sent";
  headline: string;
  detail: string;
  learned: string[];
  notLearned: string[];
  approvalId?: string;
  terms?: Array<{ title: string; statement: string }>;
  /** RFC 0013: a wallet step the candidate completes on the employer's own page. */
  verification?: {
    id: string;
    url: string;
    ref: string;
    maskedContact: string | undefined;
    /** The employer's own statement, shown as theirs (§4.1 item 3). */
    purpose: string;
    asks: string[];
    withoutWallet: string;
  };
  /** How the work-history step ended, as the employer reports it (RFC 0013 §2.2). */
  workHistory?: "completed" | "deferred";
}

const place = (j: JobPostingFacts): string => {
  const raw = Array.isArray(j.jobLocation) ? j.jobLocation[0] : j.jobLocation;
  const a = raw?.address;
  if (!a?.addressCountry) return "No location given";
  return [a.addressLocality, a.addressRegion, regionNames.of(a.addressCountry) ?? a.addressCountry]
    .filter(Boolean)
    .join(", ");
};

const ARRANGEMENT: Record<string, string> = {
  on_site: "On site",
  hybrid: "Hybrid",
  remote: "Remote",
  flexible: "Flexible",
};

export class CandidateView {
  readonly #agent: SandboxAgent;
  readonly applications: ApplicationRecord[] = [];

  constructor(agent: SandboxAgent) {
    this.#agent = agent;
  }

  async #mandate(): Promise<StandingMandateClaims | undefined> {
    const batches = await this.#agent.store.batches();
    return batches.find((b) => !b.revoked)?.mandate;
  }

  /** What the agent will ask for, in words, before any permission exists. */
  proposalSummary(): Record<string, unknown> {
    const p = this.#agent.proposal;
    const floor = p.scope.salary_floor;
    const until = new Date(
      Date.UTC(
        new Date(this.#agent.world.clock.now() * 1000).getUTCFullYear(),
        new Date(this.#agent.world.clock.now() * 1000).getUTCMonth() + p.months,
        1,
      ),
    );
    return {
      jobs: p.scope.job_families.map((c) => `${onet.title(c) ?? c} and related roles`).join("; "),
      places: `${p.scope.locations
        .map((l) =>
          "anywhere" in l
            ? "Anywhere, for remote jobs"
            : [l.addressRegion, regionNames.of(l.addressCountry)].filter(Boolean).join(", "),
        )
        .join("; ")} · ${p.scope.remote_policy.map((r) => ARRANGEMENT[r] ?? r).join(" or ")}`,
      pay: floor
        ? `At least ${money(floor.value, floor.currency)} a ${floor.unitText.toLowerCase()}`
        : "Any pay",
      perEmployer: p.per_employer,
      total: p.applications_total,
      until: until.toLocaleDateString("en", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }),
    };
  }

  /** The permission in words, from what the candidate approved. */
  async summary(): Promise<Record<string, unknown> | undefined> {
    const batches = await this.#agent.store.batches();
    const batch = batches.find((b) => !b.revoked);
    if (!batch) return undefined;
    const m = batch.mandate;
    const sent = (await this.#agent.store.submissions(batch.id)).length;
    const floor = batch.terms.salary_floor;
    return {
      jobs: m.scope.job_families.map((c) => `${onet.title(c) ?? c} and related roles (${c})`),
      places: m.scope.locations.map((l) =>
        "anywhere" in l
          ? "Anywhere, for remote jobs"
          : [l.addressRegion, regionNames.of(l.addressCountry)].filter(Boolean).join(", "),
      ),
      arrangements: m.scope.remote_policy.map((r) => ARRANGEMENT[r] ?? r),
      pay: floor
        ? `At least ${money(floor.value, floor.currency)} a ${floor.unitText.toLowerCase()}`
        : "Any pay",
      perEmployer: m.limits.per_employer,
      total: batch.terms.applications_total,
      sent,
      until: day(m.exp),
      employers:
        m.provider_trust_floor === "audited"
          ? "Only employers whose identity is verified and independently audited"
          : "Only employers whose identity your agent has verified",
      never: [
        "Accept legal terms or background-check authorizations",
        "Answer equal-opportunity questions",
        "Accept a job offer",
      ],
    };
  }

  #learned(
    d: ScopeDisclosure,
    m: StandingMandateClaims,
  ): { learned: string[]; notLearned: string[] } {
    const loc =
      "anywhere" in d.location
        ? "anywhere, for remote work"
        : [d.location.addressRegion, regionNames.of(d.location.addressCountry)]
            .filter(Boolean)
            .join(", ");
    const pay =
      "at_least" in d.salary
        ? `that ${money(d.salary.at_least, d.salary.currency)} a ${d.salary.unitText.toLowerCase()}, this job's own starting pay, is enough for you`
        : "that you're open to jobs that don't state pay";
    return {
      learned: [
        `Your email address, ${this.#agent.email}`,
        `That you're open to ${onet.title(d.job_family) ?? d.job_family} roles`,
        `That you're open to working in ${loc}, ${ARRANGEMENT[d.remote_policy]?.toLowerCase() ?? d.remote_policy}`,
        `Pay: ${pay}`,
        `That an agent applied for you, with your permission, at most ${m.limits.per_employer} times per company`,
      ],
      notLearned: [
        "Your actual pay floor",
        "The other job types, places and arrangements you chose",
        "How many applications you've sent elsewhere, or to whom",
        "Your total application limit",
      ],
    };
  }

  /**
   * Every job at every provider, with the agent's answer for each. A job posted
   * both on an ATS's own site and on the employer's careers site under it is the
   * same job, so it's listed once, from the employer's site.
   */
  async feed(): Promise<FeedItem[]> {
    const m = await this.#mandate();
    const items: FeedItem[] = [];
    const seen = new Set<string>();
    for (const host of [...PROVIDER_HOSTS].sort((a, b) => TENANT_FIRST(a) - TENANT_FIRST(b))) {
      const { derived } = await this.#agent.describe(host);
      const jobs = await this.#agent.search(host);
      const site = this.#agent.world.origins.host(host);
      for (const j of jobs) {
        const sameJob = `${j.employer?.ojcp_employer_id ?? host}|${String(j.title)}`;
        if (LISTS_TENANT_JOBS.has(host)) {
          if (seen.has(sameJob)) continue;
          seen.add(sameJob);
        }
        const code = Array.isArray(j.occupationalCategory) ? j.occupationalCategory[0] : undefined;
        const codeValue =
          code && typeof code === "object" && "codeValue" in code
            ? String(code.codeValue)
            : undefined;
        const pay =
          j.baseSalary?.minValue !== undefined
            ? `${money(j.baseSalary.minValue, j.baseSalary.currency)}–${money(j.baseSalary.maxValue ?? j.baseSalary.minValue, j.baseSalary.currency)} a year`
            : "Pay not stated";
        const base = {
          provider: host,
          site,
          job: {
            id: j.ojcp_id,
            title: String(j.title ?? j.ojcp_id),
            employer: employerName(j),
            place: place(j),
            arrangement: ARRANGEMENT[j.remote_policy ?? ""] ?? "Not stated",
            pay,
            occupation: codeValue ? (onet.title(codeValue) ?? codeValue) : "Not classified",
          },
          recipient: recipientOf(derived, site, postingEmployer(j)),
        };
        // Any attempt counts: one held back by a limit shouldn't be offered again.
        const applied = this.applications.find((a) => a.jobId === j.ojcp_id);
        if (applied) items.push({ ...base, verdict: "applied", reasons: [applied.headline] });
        else if (!m)
          items.push({
            ...base,
            verdict: "no_permission",
            reasons: ["Give me permission first."],
          });
        else if (!base.recipient.verified)
          items.push({
            ...base,
            verdict: "unverified",
            reasons: [
              `I couldn't confirm who runs this site, so I won't send your details there. ${base.recipient.note}`,
            ],
          });
        else {
          const coverage = evaluateScope(m.scope, jobFacts(j, m.scope.taxonomy));
          items.push(
            coverage.covered
              ? { ...base, verdict: "can_apply", reasons: [] }
              : { ...base, verdict: "outside", reasons: coverage.failures.map((f) => WHY_NOT[f]) },
          );
        }
      }
    }
    return items.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);
  }

  #record(
    host: Host,
    job: JobPostingFacts,
    recipient: string,
    outcome: ApplyOutcome,
    m: StandingMandateClaims | undefined,
  ): ApplicationRecord {
    const coverage = m ? evaluateScope(m.scope, jobFacts(job, m.scope.taxonomy)) : undefined;
    const disclosed =
      coverage?.covered && m
        ? this.#learned(coverage.disclose, m)
        : { learned: [], notLearned: [] };
    const base = {
      id: `${job.ojcp_id}#${this.applications.length}`,
      at: this.#agent.world.clock.now(),
      provider: host,
      jobId: job.ojcp_id,
      title: String(job.title ?? job.ojcp_id),
      employer: employerName(job),
      recipient,
    };
    switch (outcome.status) {
      case "submitted":
        return {
          ...base,
          state: "sent",
          headline: "Sent",
          detail:
            "I applied for you. The employer sees it was sent by an assistant you authorized.",
          ...disclosed,
        };
      case "needs_approval":
        return {
          ...base,
          state: "needs_you",
          headline: "Needs you",
          detail:
            "This application includes terms only you can agree to. I won't accept them for you.",
          ...disclosed,
          approvalId: outcome.approval.id,
          terms: outcome.approval.bindingActions.map((b) => ({
            title: b.title,
            statement: b.statement,
          })),
        };
      case "needs_verification":
        return {
          ...base,
          state: "needs_you",
          headline: "Needs you",
          detail: `${base.employer} asks you to confirm your work history with your wallet, on its own page. I never see your records, so this step is yours.`,
          ...disclosed,
          verification: {
            id: outcome.verification.id,
            url: outcome.verification.url,
            ref: outcome.verification.ref,
            maskedContact: outcome.verification.maskedContact,
            purpose: outcome.verification.purpose,
            asks: outcome.verification.asks,
            withoutWallet:
              outcome.verification.alternative === "post_submission"
                ? "No wallet? The page lets you continue without one; the employer checks another way after you apply."
                : "No wallet? The page offers a conventional verification service instead.",
          },
        };
      case "refused_by_agent":
        return {
          ...base,
          state: "not_sent",
          headline: "Held back",
          detail: AGENT_REASON[outcome.reason] ?? outcome.text,
          learned: [],
          notLearned: ["Nothing was sent to this employer."],
        };
      case "refused_by_provider":
        return {
          ...base,
          state: "not_sent",
          headline: "Not accepted",
          detail:
            "The employer's system didn't accept my permission. It never says which check failed; if you recently cancelled your permission, this is why.",
          learned: [],
          notLearned: ["Your application was not created."],
        };
    }
  }

  async apply(host: Host, jobId: string): Promise<ApplicationRecord> {
    const m = await this.#mandate();
    const job = await this.#agent.job(host, jobId);
    const { derived } = await this.#agent.describe(host);
    const recipient = recipientOf(
      derived,
      this.#agent.world.origins.host(host),
      postingEmployer(job),
    ).summary;
    const record = this.#record(host, job, recipient, await this.#agent.apply(host, jobId), m);
    this.applications.unshift(record);
    return record;
  }

  async approve(recordId: string): Promise<ApplicationRecord> {
    const record = this.applications.find((a) => a.id === recordId);
    if (!record?.approvalId) throw new Error("nothing to approve");
    const outcome = await this.#agent.approveAndSubmit(record.approvalId);
    if (outcome.status === "submitted") {
      record.state = "sent";
      record.headline = "Sent";
      record.detail =
        "You agreed to the terms on your own device, for this application only, and I sent it.";
    } else {
      record.state = "not_sent";
      record.headline = "Not accepted";
      record.detail = outcome.text;
    }
    delete record.approvalId;
    delete record.terms;
    return record;
  }

  /** The candidate finished at the employer's page: the agent checks the step and submits. */
  async continueVerification(recordId: string): Promise<ApplicationRecord> {
    const record = this.applications.find((a) => a.id === recordId);
    if (!record?.verification) throw new Error("nothing to continue");
    const result = await this.#agent.continueAfterVerification(record.verification.id);
    if (result.status === "still_pending") return record;
    const { outcome, step } = result;
    if (step === "expired") {
      record.state = "not_sent";
      record.headline = "Expired";
      record.detail = `${record.employer} gave three days to confirm your work history, and the time ran out. Ask me to apply again if you're still interested.`;
    } else if (outcome.status === "submitted") {
      record.state = "sent";
      record.headline = "Sent";
      record.detail =
        step === "deferred"
          ? "You chose not to use your wallet, and I sent the application. The employer checks your work history its own way; that doesn't count against you."
          : "You confirmed your work history with your wallet, straight to the employer, and I sent the application.";
      record.workHistory = step;
    } else if (outcome.status === "refused_by_agent") {
      record.state = "not_sent";
      record.headline = "Held back";
      record.detail = AGENT_REASON[outcome.reason] ?? outcome.text;
    } else {
      record.state = "not_sent";
      record.headline = "Not accepted";
      record.detail = outcome.text;
    }
    delete record.verification;
    return record;
  }

  /** What an auto-apply agent does: every job it may apply to, until a limit stops it. */
  async autoApply(): Promise<ApplicationRecord[]> {
    const done: ApplicationRecord[] = [];
    for (const item of await this.feed()) {
      if (item.verdict !== "can_apply") continue;
      done.push(await this.apply(item.provider, item.job.id));
    }
    return done;
  }

  reset(): void {
    this.applications.length = 0;
  }
}

const AGENT_REASON: Record<string, string> = {
  per_employer_reached:
    "You allowed at most this many applications per company, and I've reached it.",
  total_reached: "I've sent as many applications as you allowed in total.",
  not_covered: "This job is outside what you gave me permission for.",
  trust: "I couldn't confirm who runs this site, so I won't send your details there.",
  binding_actions: "This application needs terms only you can agree to.",
  no_mandate: "I don't have current permission to apply for you.",
  no_credential: "I need to renew my permission before applying again.",
  wallet_claims:
    "The employer asked your wallet for information employers aren't allowed to ask for, so I didn't pass the request on.",
  wallet_step_origin:
    "The employer's verification page wasn't on its own site, so I didn't pass it on.",
  wallet_step_malformed: "The employer's verification request didn't make sense, so I stopped.",
};
