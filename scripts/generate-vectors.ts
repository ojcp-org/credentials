/**
 * Writes the language-neutral test vectors in `vectors/`. Every SDK must
 * reproduce them; the TypeScript SDK is checked by tests/vectors.test.ts.
 *
 *   node --conditions=source scripts/generate-vectors.ts
 *
 * Signed vectors use the fixed test keys in vectors/keys.json (generated once;
 * delete the file to rotate). Salts are random, so regenerating changes the
 * signed vectors' bytes but never their expected outcomes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  actionDigest,
  actionStatement,
  bindKey,
  type DisclosedClaim,
  evaluateScope,
  generateSigner,
  gridValuesBetween,
  isRecord,
  issueSdJwt,
  type JobPostingFacts,
  type JWK,
  jcs,
  jobFacts,
  monthEpochs,
  normalizeCandidate,
  OjcpStatusList,
  ONET_SOC_2019,
  ojcpDigest,
  onet,
  presentSdJwt,
  StandingMandateDataset,
  Status,
  salaryRungs,
  sd,
  sdArray,
  signerFromPrivateJwk,
  signStatusListToken,
  standingMandateClaims,
  type Tool,
  TYPE_METADATA,
  thumbprint,
  typeMetadataBytes,
  vctIntegrity,
} from "@ojcp/credentials-core";

const OUT = "vectors";
const write = (name: string, value: unknown) => {
  writeFileSync(`${OUT}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
};
mkdirSync(`${OUT}/type-metadata`, { recursive: true });

// ── Deterministic rules ──────────────────────────────────────────────────────

const specStatement = {
  ojcp_version: "0.1",
  resource_server: "https://careers.acme.com",
  employer: { ojcp_employer_id: "acme-corp" },
  tool: "submit_application",
  job_id: "careers.acme.com:analyst-2026-001",
  application_id: "app_abc123",
  agent_id: "ai.northstar.assistant",
  agent_key_thumbprint: "tKwHslziExQ7dQgDX2HX8q9EuvAYmS_A3SKfjNHpdX8",
  candidate_data_digest: "sha256:l8Kt_6K5fFTzhjg_iIYDcXjskULviQZ5h7QClTNOeqo",
  mandate_nonce: "mn_xBVlesPAiuvWDyyxUDEDzDTG",
};
write("digests.json", {
  description:
    "OJCP digest: 'sha256:' + base64url(SHA-256(JCS(value))), no padding. Sources: spec Action Statement example; RFC 0008 §4.2.",
  cases: await Promise.all(
    [
      { name: "spec action statement (0.1)", value: specStatement },
      {
        name: "RFC 0008 §4.2 action statement (0.3)",
        value: { ...specStatement, ojcp_version: "0.3" },
      },
      {
        name: "candidate_data_digest material",
        value: {
          application_data: { answers: { q1: "yes" }, cover_letter: "Hello" },
          candidate_context: { consent_scope: "application_prefill", email: "jordan@example.com" },
        },
      },
      { name: "binding_actions_digest of an empty array", value: [] },
      {
        name: "JCS orders keys and normalizes numbers",
        value: { b: 1.0, a: [3, "é", { z: null, y: 1e21 }] },
      },
    ].map(async (c) => ({ ...c, jcs: jcs(c.value), digest: await ojcpDigest(c.value) })),
  ),
});

const containment: Array<[string, string]> = [
  ["29-1210", "29-1221.00"],
  ["29-1000", "29-1221.00"],
  ["29-1200", "29-1221.00"],
  ["15-1250", "15-1252.00"],
  ["15-1252", "15-1252.00"],
  ["15-1252.00", "15-1252.00"],
  ["15-2051", "15-2051.00"],
  ["15-0000", "15-2051.00"],
  ["15-1250", "15-2051.00"],
  ["15-1200", "15-1299.00"],
  ["15-1299", "15-1299.00"],
  ["15-1299.00", "15-1299.00"],
  ["15-1200", "15-1299.04"],
  ["15-1299", "15-1299.04"],
  ["99-9999", "15-1252.00"],
  ["15-1250", "15-1252.99"],
  ["15-125", "15-1252.00"],
];
write("onet-containment.json", {
  description:
    "RFC 0008 §2.2: a scope code contains a job's primary code by the published O*NET-SOC 2019 hierarchy, never by string prefix; residual 'All Other' jobs match only an exact code. Data: data/onet/soc-2019.json.",
  cases: containment.map(([scope, job]) => ({ scope, job, contains: onet.contains(scope, job) })),
});

const floors = [
  { value: 125_000, currency: "USD", unitText: "YEAR" },
  { value: 31.5, currency: "USD", unitText: "HOUR" },
  { value: 4000, currency: "EUR", unitText: "MONTH" },
  { value: 100, currency: "GBP", unitText: "HOUR" },
] as const;
write("salary-grid.json", {
  description: "RFC 0008 §2.2: rungs are every grid value from the floor to four times the floor.",
  grid_between: [
    { min: 31, max: 34, values: gridValuesBetween(31, 34) },
    { min: 95_000, max: 140_000, values: gridValuesBetween(95_000, 140_000) },
  ],
  rungs: floors.map((floor) => ({
    floor,
    rungs: salaryRungs(floor).map((r) => ("at_least" in r ? r.at_least : null)),
  })),
  not_grid_values: [120_000, 33, 1.07],
});

const scope = {
  taxonomy: ONET_SOC_2019,
  job_families: ["15-2051", "29-1210"],
  locations: [{ addressCountry: "US", addressRegion: "NY" }, { addressCountry: "CA" }],
  remote_policy: ["hybrid", "remote"],
  salary: [
    ...salaryRungs({ value: 125_000, currency: "USD", unitText: "YEAR" }),
    { unstated: true as const },
  ],
};
const posting = (o: Partial<JobPostingFacts>): JobPostingFacts => ({
  ojcp_id: "x",
  occupationalCategory: [{ codeValue: "15-2051.00", inCodeSet: ONET_SOC_2019 }],
  jobLocation: { address: { addressCountry: "US", addressRegion: "NY" } },
  remote_policy: "hybrid",
  baseSalary: { currency: "USD", minValue: 132_000, maxValue: 150_000, unitText: "YEAR" },
  ...o,
});
const scopeCases: Array<[string, JobPostingFacts]> = [
  ["RFC 0008 §2.8 example", posting({})],
  [
    "low end equals a rung",
    posting({ baseSalary: { currency: "USD", minValue: 132_000, unitText: "YEAR" } }),
  ],
  [
    "low end below the floor",
    posting({ baseSalary: { currency: "USD", minValue: 110_000, unitText: "YEAR" } }),
  ],
  [
    "only maxValue: unstated covers it",
    posting({ baseSalary: { currency: "USD", maxValue: 150_000, unitText: "YEAR" } }),
  ],
  ["no salary: unstated covers it", posting({ baseSalary: undefined })],
  [
    "another currency is not covered",
    posting({ baseSalary: { currency: "EUR", minValue: 150_000, unitText: "YEAR" } }),
  ],
  [
    "hourly against yearly rungs",
    posting({ baseSalary: { currency: "USD", minValue: 90, unitText: "HOUR" } }),
  ],
  [
    "broad occupation contains detailed",
    posting({ occupationalCategory: [{ codeValue: "29-1221.00", inCodeSet: ONET_SOC_2019 }] }),
  ],
  ["plain-string occupationalCategory", posting({ occupationalCategory: ["Data Scientist"] })],
  [
    "secondary code is ignored",
    posting({
      occupationalCategory: [
        { codeValue: "11-1011.00", inCodeSet: ONET_SOC_2019 },
        { codeValue: "15-2051.00", inCodeSet: ONET_SOC_2019 },
      ],
    }),
  ],
  [
    "country-level place",
    posting({ jobLocation: { address: { addressCountry: "CA", addressRegion: "ON" } } }),
  ],
  [
    "region not allowed",
    posting({ jobLocation: { address: { addressCountry: "US", addressRegion: "CA" } } }),
  ],
  ["text location", posting({ jobLocation: { address: { addressCountry: "United States" } } })],
  [
    "remote with no country, no anywhere",
    posting({ remote_policy: "remote", jobLocation: undefined }),
  ],
  ["on-site not allowed", posting({ remote_policy: "on_site" })],
];
write("scope-coverage.json", {
  description:
    "RFC 0008 §2.2 coverage of a job by a (disclosed or full) scope. `disclose` is what an agent presents; failures are listed in this order: unclassified, job_family, location, remote_policy, employment_type, experience_level, salary.",
  scope,
  cases: scopeCases.map(([name, job]) => ({
    name,
    job,
    result: evaluateScope(scope, jobFacts(job, ONET_SOC_2019)),
  })),
});

const types = Object.entries(TYPE_METADATA);
for (const [name, metadata] of types)
  writeFileSync(`${OUT}/type-metadata/${name}.json`, typeMetadataBytes(metadata));
write("type-metadata/integrity.json", {
  description:
    "vct#integrity = SRI sha256 of the served bytes, which are the JCS serialization of the metadata document.",
  types: Object.fromEntries(
    await Promise.all(
      types.map(async ([name, m]) => [name, { vct: m.vct, integrity: await vctIntegrity(m) }]),
    ),
  ),
});

write("candidate-normalization.json", {
  description: "RFC 0008 §2.3 normalization of candidate bindings before comparison and counting.",
  cases: [
    { email: "  Jordan@Example.COM " },
    { phone: "+1 (555) 555-0123" },
    { phone: "+44 20 7946 0958" },
  ].map((input) => ({ input, normalized: normalizeCandidate(input) })),
});

// ── Signed standing-mandate verification vectors ─────────────────────────────

if (!existsSync(`${OUT}/keys.json`)) {
  const issuer = await generateSigner("ES256", { extractable: true });
  const mandate = await generateSigner("ES256", { extractable: true });
  const other = await generateSigner("ES256", { extractable: true });
  write("keys.json", {
    description: "TEST KEYS ONLY. Never use outside these vectors.",
    issuer: issuer.privateJwk,
    agent_mandate_key: mandate.privateJwk,
    agent_other_key: other.privateJwk,
  });
}
const keys = JSON.parse(readFileSync(`${OUT}/keys.json`, "utf8")) as Record<string, JWK>;
const issuerSigner = await signerFromPrivateJwk(keys.issuer as JWK);
const mandateSigner = await signerFromPrivateJwk(keys.agent_mandate_key as JWK);
const otherSigner = await signerFromPrivateJwk(keys.agent_other_key as JWK);
const keyid = await thumbprint(mandateSigner.publicJwk);
const ISS = "https://mandates.example";
const ORIGIN = "https://careers.acme.com";
const STATUS_URI = `${ISS}/status/1`;
const NOW = 1_791_892_800; // 2026-10-13T12:00:00Z
const AGENT_ID = "ai.northstar.assistant";

const status = OjcpStatusList.create();
status.set(666, Status.INVALID);
const statusToken = await signStatusListToken({
  uri: STATUS_URI,
  list: status,
  signer: issuerSigner,
  kid: await thumbprint(issuerSigner.publicJwk),
  ttl: 3600,
  lifetime: 10 * 365 * 86_400,
  now: new Date(NOW * 1000),
});

const baseDataset = {
  agent_id: AGENT_ID,
  candidate: [{ email: "jordan@example.com" }],
  job_families: ["15-2051"],
  locations: [{ addressCountry: "US", addressRegion: "NY" }],
  remote_policy: ["hybrid", "remote"],
  salary_floor: { value: 125_000, currency: "USD", unitText: "YEAR" },
  per_employer: 2,
  applications_total: 40,
  actions: ["search_jobs", "begin_application", "submit_application"],
  prohibited: [],
  consent_scope: "application_prefill",
  provider_trust_floor: "verified",
  months: 2,
};

async function credential(
  options: {
    dataset?: Record<string, unknown>;
    idx?: number;
    corrupt?: (c: Record<string, unknown>) => void;
  } = {},
) {
  const claims = standingMandateClaims({
    issuer: ISS,
    dataset: StandingMandateDataset.parse({ ...baseDataset, ...options.dataset }),
    holderJwk: mandateSigner.publicJwk,
    status: { idx: options.idx ?? 100, uri: STATUS_URI },
    vctIntegrity: await vctIntegrity(TYPE_METADATA.standing_mandate),
    ojcpVersion: "0.3",
    now: new Date(NOW * 1000),
  });
  options.corrupt?.(claims);
  return (
    await issueSdJwt({
      signer: issuerSigner,
      header: { kid: await thumbprint(issuerSigner.publicJwk) },
      claims,
    })
  ).compact;
}

const job: JobPostingFacts = {
  ojcp_id: "careers.acme.com:analyst-1",
  occupationalCategory: [
    { "@type": "CategoryCode", codeValue: "15-2051.00", inCodeSet: ONET_SOC_2019 },
  ],
  jobLocation: {
    "@type": "Place",
    address: { addressCountry: "US", addressRegion: "NY", addressLocality: "New York" },
  },
  remote_policy: "hybrid",
  baseSalary: { currency: "USD", minValue: 132_000, maxValue: 150_000, unitText: "YEAR" },
  employer: { ojcp_employer_id: "acme-corp" },
};
const session = {
  application_id: "app_abc123",
  mandate_nonce: "mn_xBVlesPAiuvWDyyxUDEDzDTG",
  binding_actions: [] as unknown[],
  candidate: { email: "jordan@example.com" },
};
const contact = { email: "jordan@example.com" };
const SIG_NONCE = "sig_nonce_0123456789abcdef";

function disclose(tool: Tool, email = true) {
  return (c: DisclosedClaim) => {
    const v = c.disclosure.value;
    if (c.path[0] === "actions") return v === tool;
    if (c.path[0] === "candidate") return email;
    if (c.path[0] !== "scope" || c.path.length !== 3) return false;
    if (c.path[1] === "locations") return isRecord(v) && v.addressCountry === "US";
    if (c.path[1] === "salary") return isRecord(v) && v.at_least === 132_000;
    return v === "15-2051" || v === "hybrid";
  };
}

function statementFor(tool: Tool, overrides: Record<string, unknown> = {}) {
  return actionStatement({
    ojcp_version: "0.3",
    resource_server: ORIGIN,
    employer: { ojcp_employer_id: "acme-corp" },
    tool,
    job_id: job.ojcp_id,
    agent_id: AGENT_ID,
    agent_key_thumbprint: keyid,
    ...(tool === "submit_application"
      ? {
          application_id: session.application_id,
          mandate_nonce: session.mandate_nonce,
          candidate_data_digest: "sha256:l8Kt_6K5fFTzhjg_iIYDcXjskULviQZ5h7QClTNOeqo",
        }
      : {}),
    ...overrides,
  });
}

interface CaseOptions {
  tool?: Tool;
  compact?: string;
  email?: boolean;
  aud?: string;
  kbNonce?: string;
  kbSigner?: typeof otherSigner;
  digestOverrides?: Record<string, unknown>;
  context?: Record<string, unknown>;
  now?: number;
}

async function vector(
  name: string,
  expected: { accepted: true } | { kind: string; reason?: string },
  o: CaseOptions = {},
) {
  const tool = o.tool ?? "begin_application";
  const compact = o.compact ?? (await credential());
  const isApp = tool !== "search_jobs";
  const statement = statementFor(tool);
  const kbNonce = o.kbNonce ?? (tool === "submit_application" ? session.mandate_nonce : SIG_NONCE);
  const presentation = await bindKey(
    await presentSdJwt(compact, disclose(tool, o.email ?? isApp)),
    {
      aud: o.aud ?? ORIGIN,
      nonce: kbNonce,
      iat: NOW,
      ...(isApp ? { ojcp_action: await actionDigest(statementFor(tool, o.digestOverrides)) } : {}),
    },
    o.kbSigner ?? mandateSigner,
  );
  return {
    name,
    expected,
    now: o.now ?? NOW,
    request: {
      presentation,
      agent: {
        agent_id: AGENT_ID,
        keyid,
        jwk: mandateSigner.publicJwk,
        nonce: SIG_NONCE,
        created: NOW,
        expires: NOW + 60,
      },
      tool,
      ...(isApp ? { employerId: "acme-corp", job, statement } : {}),
      ...(tool === "submit_application"
        ? { session, submittedContact: contact, hasEeo: false }
        : {}),
      ...o.context,
    },
  };
}

const { nbf, exp } = monthEpochs(new Date(NOW * 1000), 2);
const cases = [
  await vector(
    "search_jobs, only the action disclosed",
    { accepted: true },
    { tool: "search_jobs" },
  ),
  await vector("begin_application, RFC 0008 §2.8 disclosures", { accepted: true }),
  await vector("submit_application", { accepted: true }, { tool: "submit_application" }),
  await vector("no candidate element on begin", { kind: "binding_mismatch" }, { email: false }),
  await vector(
    "submitted contact differs",
    { kind: "binding_mismatch" },
    { tool: "submit_application", context: { submittedContact: { email: "other@example.com" } } },
  ),
  await vector(
    "_sd at top level",
    { kind: "disclosure_rule" },
    { compact: await credential({ corrupt: (c) => void Object.assign(c, { hidden: sd("x") }) }) },
  ),
  await vector(
    "digest inside prohibited",
    { kind: "disclosure_rule" },
    {
      compact: await credential({
        corrupt: (c) =>
          void Object.assign(c, { prohibited: sdArray(["accept_terms", "accept_offer"]) }),
      }),
    },
  ),
  await vector(
    "job_families longer than narrow padding",
    { kind: "disclosure_rule" },
    {
      compact: await credential({
        corrupt: (c) =>
          void (
            isRecord(c.scope) &&
            Object.assign(c.scope, { job_families: sdArray(["15-2051"], { padTo: 5 }) })
          ),
      }),
    },
  ),
  await vector(
    "job outside every family",
    { kind: "not_covered" },
    {
      context: {
        job: {
          ...job,
          occupationalCategory: [{ codeValue: "29-1141.00", inCodeSet: ONET_SOC_2019 }],
        },
      },
    },
  ),
  await vector(
    "low end below the disclosed rung",
    { kind: "not_covered" },
    {
      context: {
        job: { ...job, baseSalary: { currency: "USD", minValue: 110_000, unitText: "YEAR" } },
      },
    },
  ),
  await vector(
    "binding_actions non-empty",
    { kind: "not_admitted", reason: "action_mandate_required" },
    {
      tool: "submit_application",
      context: { session: { ...session, binding_actions: [{ id: "t" }] } },
    },
  ),
  await vector(
    "binding_actions absent",
    { kind: "not_admitted", reason: "action_mandate_required" },
    {
      tool: "submit_application",
      context: { session: { ...session, binding_actions: undefined } },
    },
  ),
  await vector(
    "eeo under a standing mandate",
    { kind: "prohibited" },
    { tool: "submit_application", context: { hasEeo: true } },
  ),
  await vector(
    "per_employer above provider maximum",
    { kind: "policy", reason: "exceeds_provider_policy" },
    { compact: await credential({ dataset: { per_employer: 3 } }) },
  ),
  await vector(
    "wrong audience",
    { kind: "binding_mismatch" },
    { aud: "https://careers.other.com" },
  ),
  await vector(
    "ojcp_action over another job",
    { kind: "binding_mismatch" },
    { digestOverrides: { job_id: "careers.acme.com:other" } },
  ),
  await vector(
    "KB-JWT nonce is not the signature nonce",
    { kind: "replayed" },
    { tool: "search_jobs", kbNonce: "some_other_nonce_value" },
  ),
  await vector(
    "KB-JWT nonce is not the mandate_nonce",
    { kind: "replayed" },
    { tool: "submit_application", kbNonce: SIG_NONCE },
  ),
  await vector(
    "KB-JWT signed by another key",
    { kind: "invalid_signature" },
    { kbSigner: otherSigner },
  ),
  await vector(
    "cnf is not the request's signing key",
    { kind: "binding_mismatch" },
    {
      context: {
        agent: {
          agent_id: AGENT_ID,
          keyid: await thumbprint(otherSigner.publicJwk),
          jwk: otherSigner.publicJwk,
          nonce: SIG_NONCE,
          created: NOW,
          expires: NOW + 60,
        },
      },
    },
  ),
  await vector(
    "agent_id differs",
    { kind: "binding_mismatch" },
    {
      context: {
        agent: {
          agent_id: "ai.northstar.assistant.beta",
          keyid,
          jwk: mandateSigner.publicJwk,
          nonce: SIG_NONCE,
          created: NOW,
          expires: NOW + 60,
        },
      },
    },
  ),
  await vector("revoked", { kind: "revoked" }, { compact: await credential({ idx: 666 }) }),
  await vector(
    "expired",
    { kind: "expired" },
    {
      now: exp,
      context: {
        agent: {
          agent_id: AGENT_ID,
          keyid,
          jwk: mandateSigner.publicJwk,
          nonce: SIG_NONCE,
          created: exp,
          expires: exp + 60,
        },
      },
    },
  ),
];

write("standing-mandate-verification.json", {
  description:
    "RFC 0008 §8 verification. Every rejection is `user_mandate_required` on the wire; `kind` is the internal failure class and `reason` the only details.reason value allowed. The provider policy and status list token are shared by every case; the ledger starts empty.",
  policy: {
    origin: ORIGIN,
    manifest: {
      types: ["action", "standing"],
      required_for: ["submit_application"],
      action_mandate_required_for: ["accept_terms", "accept_offer"],
      standing: {
        vct_values: ["https://spec.ojcp.dev/vct/standing-mandate/v1"],
        max_lifetime_months: 3,
        max_per_employer: 2,
        max_breadth: "narrow",
        taxonomies: [ONET_SOC_2019],
      },
    },
    issuers: [{ iss: ISS, keys: [{ jwk: issuerSigner.publicJwk }], types: ["standing"] }],
    ojcpVersions: ["0.3"],
  },
  status_lists: { [STATUS_URI]: statusToken },
  mandate_window: { nbf, exp },
  cases,
});
console.log(`wrote ${cases.length} signed verification vectors`);
