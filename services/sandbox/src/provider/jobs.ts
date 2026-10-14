/**
 * Made-up postings, coded per RFC 0009, chosen so every coverage rule of
 * RFC 0008 §2.2 shows up in a demo.
 */
import { type BindingAction, ONET_SOC_2019 } from "@ojcp/credentials-core";

export interface SandboxJob extends Record<string, unknown> {
  ojcp_id: string;
  title: string;
  description: string;
  occupationalCategory: Array<{
    "@type": "CategoryCode";
    codeValue: string;
    inCodeSet: string;
    name: string;
  }>;
  jobLocation?: {
    "@type": "Place";
    address: { addressCountry: string; addressRegion?: string; addressLocality?: string };
  };
  remote_policy: "on_site" | "hybrid" | "remote" | "flexible";
  employmentType: string;
  baseSalary?: { currency: string; minValue?: number; maxValue?: number; unitText: string };
  employer: { ojcp_employer_id: string; name: string };
  /** RFC 0009: returned by begin_application. */
  binding_actions: BindingAction[];
  /**
   * RFC 0013: the job asks the candidate to verify their work history with a
   * wallet. The text is the job rule screening applies (never the step itself).
   */
  verify_employment?: string;
  /** Why this posting is in the sandbox. */
  demo: string;
}

const code = (codeValue: string, name: string) => [
  { "@type": "CategoryCode" as const, codeValue, inCodeSet: ONET_SOC_2019, name },
];
const nyc = {
  "@type": "Place" as const,
  address: { addressCountry: "US", addressRegion: "NY", addressLocality: "New York" },
};
const usd = (minValue: number, maxValue: number) => ({
  currency: "USD",
  minValue,
  maxValue,
  unitText: "YEAR",
});

export const TERMS: BindingAction = {
  id: "initech-terms",
  type: "accept_terms",
  title: "Initech candidate terms",
  statement: "I agree to Initech's candidate terms and to Initech contacting me about this role.",
  required: true,
};

export function employerJobs(
  host: string,
  employer: { ojcp_employer_id: string; name: string },
  kind: "acme" | "globex" | "initech",
): SandboxJob[] {
  const id = (s: string) => `${host}:${s}`;
  const base = { employer, employmentType: "FULL_TIME", binding_actions: [] as BindingAction[] };
  if (kind === "acme")
    return [
      {
        ...base,
        ojcp_id: id("bi-analyst-1"),
        title: "Business Intelligence Analyst",
        description: "Dashboards and metrics for the sales team.",
        occupationalCategory: code("15-2051.01", "Business Intelligence Analysts"),
        jobLocation: nyc,
        remote_policy: "hybrid",
        baseSalary: usd(132_000, 150_000),
        demo: "Covered: the RFC 0008 §2.8 example job",
      },
      {
        ...base,
        ojcp_id: id("data-scientist-2"),
        title: "Data Scientist",
        description: "Forecasting models for supply chain.",
        occupationalCategory: code("15-2051.00", "Data Scientists"),
        jobLocation: nyc,
        remote_policy: "remote",
        baseSalary: usd(145_000, 175_000),
        demo: "Covered, and asks the candidate to verify their work history with a wallet (RFC 0013)",
        verify_employment: "At least two years in a data role.",
      },
      {
        ...base,
        ojcp_id: id("nurse-3"),
        title: "Registered Nurse, Occupational Health",
        description: "On-site clinic.",
        occupationalCategory: code("29-1141.00", "Registered Nurses"),
        jobLocation: nyc,
        remote_policy: "on_site",
        baseSalary: usd(98_000, 120_000),
        demo: "Not covered: job family",
      },
      {
        ...base,
        ojcp_id: id("bi-analyst-junior-4"),
        title: "Junior BI Analyst",
        description: "Reporting support.",
        occupationalCategory: code("15-2051.01", "Business Intelligence Analysts"),
        jobLocation: nyc,
        remote_policy: "hybrid",
        baseSalary: usd(85_000, 100_000),
        demo: "Not covered: pays below the floor",
      },
      {
        ...base,
        ojcp_id: id("analyst-anywhere-5"),
        title: "Data Analyst (remote, anywhere)",
        description: "Fully remote.",
        occupationalCategory: code("15-2051.01", "Business Intelligence Analysts"),
        remote_policy: "remote",
        baseSalary: usd(130_000, 140_000),
        demo: "Not covered: remote with no country, unless the mandate has 'anywhere'",
      },
    ];
  if (kind === "globex")
    return [1, 2, 3].map((n) => ({
      ...base,
      ojcp_id: id(`globex-bi-${n}`),
      title: `BI Analyst ${n === 1 ? "" : `(team ${n})`}`.trim(),
      description: "Analytics for Globex's retail division.",
      occupationalCategory: code("15-2051.01", "Business Intelligence Analysts"),
      jobLocation: nyc,
      remote_policy: "hybrid",
      baseSalary: usd(135_000, 155_000),
      demo:
        n === 3 ? "Covered, but a third application to Globex exceeds per_employer 2" : "Covered",
    }));
  return [
    {
      ...base,
      ojcp_id: id("initech-ds-1"),
      title: "Data Scientist",
      description: "Pricing models.",
      occupationalCategory: code("15-2051.00", "Data Scientists"),
      jobLocation: nyc,
      remote_policy: "hybrid",
      baseSalary: usd(140_000, 160_000),
      binding_actions: [TERMS],
      demo: "Covered, but the application has a legal agreement: needs the candidate's own approval",
    },
    {
      ...base,
      ojcp_id: id("initech-ds-2"),
      title: "Data Scientist II",
      description: "Experimentation platform.",
      occupationalCategory: code("15-2051.00", "Data Scientists"),
      jobLocation: nyc,
      remote_policy: "hybrid",
      baseSalary: usd(150_000, 170_000),
      demo: "Covered",
    },
  ];
}
