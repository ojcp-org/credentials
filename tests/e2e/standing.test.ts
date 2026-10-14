import { refreshStandingMandate } from "@ojcp/agent-wallet";
import {
  actionDigest,
  actionStatement,
  candidateDataDigest,
  type DisclosedClaim,
  isRecord,
  issueSdJwt,
  type JobPostingFacts,
  ONET_SOC_2019,
  parseSdJwt,
  StandingMandateDataset,
  sd,
  sdArray,
  standingMandateClaims,
  type Tool,
} from "@ojcp/credentials-core";
import { describe, expect, it } from "vitest";
import {
  AGENT_ID,
  CLIENT_ID,
  callTool,
  callToolSignedBy,
  createWorld,
  heldCredentials,
  ISSUER,
  job,
  MANIFEST,
  obtainMandate,
  PROPOSAL,
  PROVIDER,
  rawPresentation,
  type ToolResult,
  type World,
} from "./harness.ts";

const EMAIL = "jordan@example.com";
const candidateContext = (email = EMAIL) => ({ consent_scope: "application_prefill", email });
const declaration = (userMandate: string) => ({
  agent_id: AGENT_ID,
  interaction_mode: "autonomous",
  user_mandate: userMandate,
});

async function search(world: World): Promise<ToolResult> {
  const ex = await world.holder.exercise({
    tool: "search_jobs",
    origin: PROVIDER,
    ojcpVersion: "0.3",
  });
  return callTool(world, "search_jobs", {
    query: "data analyst",
    agent_declaration: declaration(ex.userMandate),
  });
}

async function begin(world: World, posting: JobPostingFacts): Promise<ToolResult> {
  const candidate_context = candidateContext();
  const ex = await world.holder.exercise({
    tool: "begin_application",
    origin: PROVIDER,
    ojcpVersion: "0.3",
    job: posting,
    employerId: posting.employer?.ojcp_employer_id as string,
    request: { candidate_context },
    consentScope: "application_prefill",
  });
  return callTool(world, "begin_application", {
    job_id: posting.ojcp_id,
    candidate_context,
    agent_declaration: declaration(ex.userMandate),
  });
}

async function submit(
  world: World,
  posting: JobPostingFacts,
  session: Record<string, unknown>,
): Promise<{ result: ToolResult; batchId: string }> {
  const application_data = {
    cover_letter: "I'd like to apply.",
    resume_url: "https://files.example/jordan.pdf",
  };
  const candidate_context = candidateContext();
  const ex = await world.holder.exercise({
    tool: "submit_application",
    origin: PROVIDER,
    ojcpVersion: "0.3",
    job: posting,
    employerId: posting.employer?.ojcp_employer_id as string,
    session: {
      application_id: session.application_id as string,
      mandate_nonce: session.mandate_nonce as string,
      ...(session.binding_actions ? { binding_actions: session.binding_actions as unknown[] } : {}),
    },
    request: { application_data, candidate_context },
  });
  const result = await callTool(world, "submit_application", {
    application_id: session.application_id,
    application_data,
    candidate_context,
    agent_declaration: declaration(ex.userMandate),
  });
  if (result.ok && !result.result?.retried)
    await world.holder.recordSubmission(
      ex.batchId,
      PROVIDER,
      posting.employer?.ojcp_employer_id as string,
    );
  return { result, batchId: ex.batchId };
}

async function apply(world: World, posting: JobPostingFacts): Promise<ToolResult> {
  const started = await begin(world, posting);
  if (!started.ok) return started;
  return (await submit(world, posting, started.result as Record<string, unknown>)).result;
}

describe("standing mandate, end to end", () => {
  it("issues a batch through consent, then searches, begins and submits under it", async () => {
    const world = await createWorld();
    const analyst = job({ ojcp_id: "careers.acme.com:analyst-1" });
    world.provider.jobs.set(analyst.ojcp_id, analyst);
    await obtainMandate(world);

    expect(await search(world)).toMatchObject({ ok: true, result: { jobs: [analyst.ojcp_id] } });
    const started = await begin(world, analyst);
    expect(started).toMatchObject({ ok: true, result: { binding_actions: [] } });
    const { result } = await submit(world, analyst, started.result as Record<string, unknown>);
    expect(result).toMatchObject({ ok: true, result: { status: "submitted" } });
  });

  it("returns the original outcome to a retried submission and counts it once", async () => {
    const world = await createWorld();
    const a = job({ ojcp_id: "careers.acme.com:a" });
    const b = job({ ojcp_id: "careers.acme.com:b" });
    const c = job({ ojcp_id: "careers.acme.com:c" });
    for (const p of [a, b, c]) world.provider.jobs.set(p.ojcp_id, p);
    await obtainMandate(world);
    const started = (await begin(world, a)).result as Record<string, unknown>;
    const first = await submit(world, a, started);
    const retry = await submit(world, a, started);
    expect(first.result.result).toMatchObject({ status: "submitted" });
    expect(retry.result).toMatchObject({
      ok: true,
      result: { status: "submitted", retried: true },
    });
    // per_employer is 2: the retry didn't count, so one more is allowed, then none.
    expect(await apply(world, b)).toMatchObject({ ok: true });
    await expect(begin(world, c).then(() => apply(world, c))).rejects.toMatchObject({
      reason: "per_employer_reached",
    });
  });

  it("keeps credentials for applications however much the agent searches", async () => {
    const world = await createWorld();
    const employers = ["e1", "e2", "e3", "e4", "e5"].map((e) =>
      job({ ojcp_id: `careers.acme.com:${e}`, employerId: e }),
    );
    for (const p of employers) world.provider.jobs.set(p.ojcp_id, p);
    await obtainMandate(world);
    for (let i = 0; i < 25; i++) expect((await search(world)).ok).toBe(true);
    for (const p of employers) expect(await apply(world, p)).toMatchObject({ ok: true });
    // The batch is now spent on applications, so the holder reports a refresh is due (§4.1).
    expect(await world.holder.needsRefresh()).toHaveLength(1);
  });
});

// ── Helpers for presentations a faulty or hostile agent could send ─────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Discloses what RFC 0008 §2.8's example discloses for the analyst job. */
function exampleDisclosures(tool: Tool, overrides: { email?: string | null } = {}) {
  const email = overrides.email === undefined ? EMAIL : overrides.email;
  return (c: DisclosedClaim): boolean => {
    const v = c.disclosure.value;
    if (c.path[0] === "actions") return v === tool;
    if (c.path[0] === "candidate") return email !== null && same(v, { email });
    if (c.path[0] !== "scope" || c.path.length !== 3) return false;
    // Matched by meaning, so a corrupted element is still disclosed.
    if (c.path[1] === "locations") return isRecord(v) && v.addressCountry === "US";
    if (c.path[1] === "salary") return isRecord(v) && v.at_least === 132_000;
    return v === "15-2051" || v === "hybrid";
  };
}

async function statementDigest(
  tool: Tool,
  posting: JobPostingFacts,
  keyThumbprint: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return actionDigest(
    actionStatement({
      ojcp_version: "0.3",
      resource_server: PROVIDER,
      employer: { ojcp_employer_id: posting.employer?.ojcp_employer_id as string },
      tool,
      job_id: posting.ojcp_id,
      agent_id: AGENT_ID,
      agent_key_thumbprint: keyThumbprint,
      ...extra,
    }),
  );
}

async function rawBegin(
  world: World,
  posting: JobPostingFacts,
  credential: { compact: string; keyThumbprint: string },
  options: { email?: string | null; aud?: string; digestJob?: JobPostingFacts } = {},
) {
  const nonce = `n_${Math.random().toString(36).slice(2)}aaaaaaaaaaaaaaaa`;
  const userMandate = await rawPresentation(
    world,
    credential,
    exampleDisclosures("begin_application", options),
    {
      nonce,
      ...(options.aud ? { aud: options.aud } : {}),
      ojcp_action: await statementDigest(
        "begin_application",
        options.digestJob ?? posting,
        credential.keyThumbprint,
      ),
    },
  );
  const signer = world.keyring.signerFor(credential.keyThumbprint);
  if (!signer) throw new Error("no signer");
  return callToolSignedBy(
    world,
    signer,
    "begin_application",
    { job_id: posting.ojcp_id, agent_declaration: declaration(userMandate) },
    nonce,
  );
}

async function rawSubmit(
  world: World,
  posting: JobPostingFacts,
  credential: { compact: string; keyThumbprint: string },
  session: Record<string, unknown>,
  options: { email?: string; contact?: string; eeo?: boolean; kbNonce?: string } = {},
) {
  const application_data = {
    cover_letter: "Hello",
    ...(options.eeo ? { eeo: { gender: "decline_to_answer" } } : {}),
  };
  const candidate_context = candidateContext(options.contact ?? EMAIL);
  const userMandate = await rawPresentation(
    world,
    credential,
    exampleDisclosures("submit_application", options.email ? { email: options.email } : {}),
    {
      nonce: options.kbNonce ?? (session.mandate_nonce as string),
      ojcp_action: await statementDigest("submit_application", posting, credential.keyThumbprint, {
        application_id: session.application_id,
        mandate_nonce: session.mandate_nonce,
        candidate_data_digest: await candidateDataDigest({ application_data, candidate_context }),
      }),
    },
  );
  const signer = world.keyring.signerFor(credential.keyThumbprint);
  if (!signer) throw new Error("no signer");
  return callToolSignedBy(world, signer, "submit_application", {
    application_id: session.application_id,
    application_data,
    candidate_context,
    agent_declaration: declaration(userMandate),
  });
}

/** A credential the admitted issuer signed, built from claims a test then corrupts. */
async function forged(
  world: World,
  keyThumbprint: string,
  corrupt: (claims: Record<string, unknown>) => void,
) {
  const key = world.keyring.mandateKey(keyThumbprint);
  if (!key) throw new Error("no key");
  const claims = standingMandateClaims({
    issuer: ISSUER,
    dataset: StandingMandateDataset.parse({
      agent_id: AGENT_ID,
      candidate: PROPOSAL.candidate,
      job_families: PROPOSAL.scope.job_families,
      locations: PROPOSAL.scope.locations,
      remote_policy: PROPOSAL.scope.remote_policy,
      salary_floor: PROPOSAL.scope.salary_floor,
      per_employer: 2,
      applications_total: 40,
      actions: PROPOSAL.actions,
      prohibited: [],
      consent_scope: "application_prefill",
      provider_trust_floor: "verified",
      months: 2,
    }),
    holderJwk: key.signer.publicJwk,
    status: { idx: 4242, uri: `${ISSUER}/status/1` },
    vctIntegrity: "sha256-x",
    ojcpVersion: "0.3",
    now: new Date(world.clock.now * 1000),
  });
  corrupt(claims);
  const { compact } = await issueSdJwt({
    signer: world.issuerSigner,
    header: { kid: world.issuer.kid },
    claims,
  });
  return { compact, keyThumbprint };
}

function rejected(result: ToolResult, kind?: string, reason?: string) {
  expect(result.ok).toBe(false);
  expect(result.error?.error_code).toBe("user_mandate_required");
  if (reason) expect(result.error?.details?.reason).toBe(reason);
  else expect(result.error?.details).toBeUndefined();
  if (kind) expect(result.kind).toBe(kind);
}

async function worldWithMandate(options: Parameters<typeof createWorld>[0] = {}) {
  const world = await createWorld(options);
  const analyst = job({ ojcp_id: "careers.acme.com:analyst-1" });
  world.provider.jobs.set(analyst.ojcp_id, analyst);
  await obtainMandate(world);
  const credentials = await heldCredentials(world);
  return { world, analyst, credentials };
}

describe("RFC 0008 §10: every refusal is user_mandate_required", () => {
  it("standing_candidate_mismatch", async () => {
    const { world, analyst, credentials } = await worldWithMandate();
    rejected(await rawBegin(world, analyst, credentials[0]!, { email: null }), "binding_mismatch");
    const session = (await rawBegin(world, analyst, credentials[0]!)).result as Record<
      string,
      unknown
    >;
    rejected(
      await rawSubmit(world, analyst, credentials[0]!, session, {
        contact: "someone.else@example.com",
      }),
      "binding_mismatch",
    );
  });

  it("standing_hidden_restriction", async () => {
    const { world, analyst, credentials } = await worldWithMandate();
    const tp = credentials[0]!.keyThumbprint;
    const setScope = (c: Record<string, unknown>, key: string, value: unknown) => {
      if (isRecord(c.scope)) c.scope[key] = value;
    };
    const cases: Array<[string, (c: Record<string, unknown>) => void]> = [
      [
        "disclosure_rule", // _sd at top level
        (c) => {
          c.hidden = sd("x");
        },
      ],
      [
        "disclosure_rule", // _sd inside a locations element
        (c) =>
          setScope(
            c,
            "locations",
            sdArray([{ addressCountry: "US", addressRegion: "NY", note: sd("x") }], { padTo: 4 }),
          ),
      ],
      [
        "disclosure_rule", // _sd inside a salary element
        (c) =>
          setScope(
            c,
            "salary",
            sdArray([{ at_least: 132_000, currency: "USD", unitText: "YEAR", cap: sd(1) }], {
              padTo: 26,
            }),
          ),
      ],
      [
        "disclosure_rule", // a digest inside prohibited
        (c) => {
          c.prohibited = sdArray(["accept_terms", "accept_offer"]);
        },
      ],
      [
        "disclosure_rule", // a digest inside limits
        (c) => {
          c.limits = { per_employer: sd(2) };
        },
      ],
      ["invalid_claims", (c) => setScope(c, "age_range", ["25-40"])], // an undefined scope member
    ];
    for (const [kind, corrupt] of cases)
      rejected(await rawBegin(world, analyst, await forged(world, tp, corrupt)), kind);
  });

  it("standing_padding", async () => {
    const { world, analyst, credentials } = await worldWithMandate();
    const credential = await forged(world, credentials[0]!.keyThumbprint, (c) => {
      (c.scope as Record<string, unknown>).job_families = sdArray(["15-2051"], { padTo: 5 });
    });
    rejected(await rawBegin(world, analyst, credential), "disclosure_rule");
  });

  it("standing_scope and standing_salary", async () => {
    const { world, credentials } = await worldWithMandate();
    const outside = job({
      ojcp_id: "careers.acme.com:nurse",
      occupationalCategory: [
        { "@type": "CategoryCode", codeValue: "29-1141.00", inCodeSet: ONET_SOC_2019 },
      ],
    });
    const unclassified = job({
      ojcp_id: "careers.acme.com:unclassified",
      occupationalCategory: ["Data Analyst"],
    });
    const lowPay = job({
      ojcp_id: "careers.acme.com:low",
      baseSalary: { currency: "USD", minValue: 110_000, unitText: "YEAR" },
    });
    const maxOnly = job({
      ojcp_id: "careers.acme.com:max",
      baseSalary: { currency: "USD", maxValue: 150_000, unitText: "YEAR" },
    });
    const hourly = job({
      ojcp_id: "careers.acme.com:hourly",
      baseSalary: { currency: "USD", minValue: 70, unitText: "HOUR" },
    });
    for (const p of [outside, unclassified, lowPay, maxOnly, hourly]) {
      world.provider.jobs.set(p.ojcp_id, p);
      // The agent won't present for a job it doesn't cover…
      await expect(begin(world, p)).rejects.toMatchObject({ reason: "not_covered" });
      // …and a provider refuses a hostile agent that does.
      rejected(await rawBegin(world, p, credentials[1]!), "not_covered");
    }
    const atRung = job({
      ojcp_id: "careers.acme.com:rung",
      baseSalary: { currency: "USD", minValue: 132_000, unitText: "YEAR" },
    });
    world.provider.jobs.set(atRung.ojcp_id, atRung);
    expect((await begin(world, atRung)).ok).toBe(true);
  });

  it("standing_binding_actions and standing_eeo", async () => {
    const { world, analyst, credentials } = await worldWithMandate();
    world.provider.bindingActions = [
      { id: "terms", type: "accept_terms", title: "Terms", statement: "I agree", required: true },
    ];
    const withTerms = (await begin(world, analyst)).result as Record<string, unknown>;
    await expect(submit(world, analyst, withTerms)).rejects.toMatchObject({
      reason: "binding_actions",
    });
    rejected(
      await rawSubmit(world, analyst, credentials[1]!, withTerms),
      undefined,
      "action_mandate_required",
    );

    world.provider.bindingActions = undefined;
    const without = (await rawBegin(world, analyst, credentials[2]!)).result as Record<
      string,
      unknown
    >;
    rejected(
      await rawSubmit(world, analyst, credentials[2]!, without),
      undefined,
      "action_mandate_required",
    );

    world.provider.bindingActions = [];
    const clean = (await rawBegin(world, analyst, credentials[3]!)).result as Record<
      string,
      unknown
    >;
    rejected(await rawSubmit(world, analyst, credentials[3]!, clean, { eeo: true }), "prohibited");
  });

  it("standing_per_employer across credentials, refreshed batches and tenants", async () => {
    const world = await createWorld();
    const acme = ["a1", "a2", "a3"].map((id) => job({ ojcp_id: `careers.acme.com:${id}` }));
    const globex = ["g1", "g2"].map((id) =>
      job({ ojcp_id: `careers.acme.com:${id}`, employerId: "globex" }),
    );
    for (const p of [...acme, ...globex]) world.provider.jobs.set(p.ojcp_id, p);
    const refreshToken = await obtainMandate(world);
    expect(await apply(world, acme[0]!)).toMatchObject({ ok: true });
    expect(await apply(world, acme[1]!)).toMatchObject({ ok: true });
    // Two employers on one origin: two applications each are fine.
    expect(await apply(world, globex[0]!)).toMatchObject({ ok: true });
    expect(await apply(world, globex[1]!)).toMatchObject({ ok: true });

    // A third to Acme, from a credential never used for Acme: the count is keyed on the candidate.
    const credentials = await heldCredentials(world);
    const unused = credentials[credentials.length - 1]!;
    const session = (await rawBegin(world, acme[2]!, unused)).result as Record<string, unknown>;
    rejected(await rawSubmit(world, acme[2]!, unused, session), "limit_reached");

    // …or from a refreshed batch.
    const { keyring, holder, issuerFetch } = world;
    await refreshStandingMandate({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      refreshToken: refreshToken!,
      keyring,
      holder,
      fetch: issuerFetch,
      now: () => world.clock.now,
    });
    const fresh = (await heldCredentials(world))[0]!;
    const session2 = (await rawBegin(world, acme[2]!, fresh)).result as Record<string, unknown>;
    rejected(await rawSubmit(world, acme[2]!, fresh, session2), "limit_reached");
  });

  it("standing_policy: exceeds_provider_policy", async () => {
    const tight = { ...MANIFEST, standing: { ...MANIFEST.standing!, max_lifetime_months: 1 } };
    const { world, analyst, credentials } = await worldWithMandate({ manifest: tight });
    rejected(await rawBegin(world, analyst, credentials[0]!), "policy", "exceeds_provider_policy");

    const broad = await createWorld();
    broad.provider.jobs.set(analyst.ojcp_id, analyst);
    await obtainMandate(broad, {
      ...PROPOSAL,
      scope: { ...PROPOSAL.scope, job_families: ["15-2051", "15-2041", "15-2031", "15-1252"] },
    });
    rejected(
      await rawBegin(broad, analyst, (await heldCredentials(broad))[0]!),
      "policy",
      "exceeds_provider_policy",
    );

    const three = await createWorld();
    three.provider.jobs.set(analyst.ojcp_id, analyst);
    await obtainMandate(three, { ...PROPOSAL, per_employer: 3 });
    rejected(
      await rawBegin(three, analyst, (await heldCredentials(three))[0]!),
      "policy",
      "exceeds_provider_policy",
    );
  });

  it("standing_wrong_agent_key", async () => {
    const { world, credentials } = await worldWithMandate();
    const first = credentials[0]!;
    const second = credentials[1]!;
    // KB-JWT by another mandate key.
    const nonce = "n_wrongkbkey_aaaaaaaaaaaaaaaa";
    const otherKey = world.keyring.signerFor(second.keyThumbprint)!;
    const byOther = await rawPresentation(
      world,
      first,
      exampleDisclosures("search_jobs"),
      { nonce },
      otherKey,
    );
    rejected(
      await callToolSignedBy(
        world,
        world.keyring.signerFor(first.keyThumbprint)!,
        "search_jobs",
        { agent_declaration: declaration(byOther) },
        nonce,
      ),
      "invalid_signature",
    );
    // Request signed by a key other than cnf.
    const nonce2 = "n_wrongreqkey_aaaaaaaaaaaaaaa";
    const good = await rawPresentation(world, first, exampleDisclosures("search_jobs"), {
      nonce: nonce2,
    });
    rejected(
      await callToolSignedBy(
        world,
        world.keyring.requestSigner,
        "search_jobs",
        { agent_declaration: declaration(good) },
        nonce2,
      ),
      "binding_mismatch",
    );
    // agent_id differs from the mandate's.
    const nonce3 = "n_wrongagent_aaaaaaaaaaaaaaaa";
    const p3 = await rawPresentation(world, first, exampleDisclosures("search_jobs"), {
      nonce: nonce3,
    });
    rejected(
      await callToolSignedBy(
        world,
        world.keyring.signerFor(first.keyThumbprint)!,
        "search_jobs",
        { agent_declaration: { ...declaration(p3), agent_id: "ai.northstar.assistant.beta" } },
        nonce3,
      ),
      "binding_mismatch",
    );
  });

  it("standing_replay", async () => {
    const { world, analyst, credentials } = await worldWithMandate();
    const c = credentials[0]!;
    // The same KB-JWT on a second search request: the signature nonce is already used.
    const nonce = "n_replay_aaaaaaaaaaaaaaaaaaaa";
    const p = await rawPresentation(world, c, exampleDisclosures("search_jobs"), { nonce });
    const signer = world.keyring.signerFor(c.keyThumbprint)!;
    expect(
      (
        await callToolSignedBy(
          world,
          signer,
          "search_jobs",
          { agent_declaration: declaration(p) },
          nonce,
        )
      ).ok,
    ).toBe(true);
    expect(
      await callToolSignedBy(
        world,
        signer,
        "search_jobs",
        { agent_declaration: declaration(p) },
        nonce,
      ),
    ).toMatchObject({ ok: false, error: { error_code: "agent_nonce_replayed" } });
    // KB-JWT nonce that isn't the signature nonce.
    const mismatched = await rawPresentation(world, c, exampleDisclosures("search_jobs"), {
      nonce: "n_kbnonce_aaaaaaaaaaaaaaaaaaa",
    });
    rejected(
      await callToolSignedBy(
        world,
        signer,
        "search_jobs",
        { agent_declaration: declaration(mismatched) },
        "n_signonce_aaaaaaaaaaaaaaaaaa",
      ),
      "replayed",
    );
    // Wrong audience; ojcp_action over another job.
    rejected(
      await rawBegin(world, analyst, c, { aud: "https://careers.other.com" }),
      "binding_mismatch",
    );
    rejected(
      await rawBegin(world, analyst, c, { digestJob: job({ ojcp_id: "careers.acme.com:other" }) }),
      "binding_mismatch",
    );
    // Submission KB nonce that isn't the session's mandate_nonce.
    const session = (await rawBegin(world, analyst, c)).result as Record<string, unknown>;
    rejected(
      await rawSubmit(world, analyst, c, session, { kbNonce: "mn_notthesessionnonce_aaaaaaaa" }),
      "replayed",
    );
  });

  it("standing_revoked and standing_expired", async () => {
    const { world, analyst } = await worldWithMandate();
    expect((await search(world)).ok).toBe(true);

    // The user cancels on the issuer's account page.
    const code = await world.issuerFetch(`${ISSUER}/account/code`, {
      method: "POST",
      body: new URLSearchParams({ identifier: EMAIL }),
    });
    const challenge = (await code.text()).match(/name="challenge" value="([^"]+)"/)?.[1] as string;
    const pendingCookie = code.headers.get("set-cookie")!.split(";")[0]!;
    const verify = await world.issuerFetch(`${ISSUER}/account/verify`, {
      method: "POST",
      headers: { cookie: pendingCookie },
      body: new URLSearchParams({ challenge, code: world.messenger.lastCodeFor(EMAIL) }),
    });
    expect(verify.status).toBe(303);
    const session = verify.headers
      .getSetCookie()
      .find((c) => c.startsWith("ojcp_account="))!
      .split(";")[0]!;
    const page = await (
      await world.issuerFetch(`${ISSUER}/account/mandates`, { headers: { cookie: session } })
    ).text();
    const id = page.match(/\/account\/revoke\/([A-Za-z0-9_-]+)/)?.[1] as string;
    expect(
      (
        await world.issuerFetch(`${ISSUER}/account/revoke/${id}`, {
          method: "POST",
          headers: { cookie: session },
        })
      ).status,
    ).toBe(200);

    // Status applies at the next epoch, and providers' copies are at most an hour old.
    expect(await world.issuer.status.applyEpoch()).toBeGreaterThan(0);
    world.clock.advance(3601);
    const credentials = await heldCredentials(world);
    rejected(await rawBegin(world, analyst, credentials[5]!), "revoked");

    const expiring = await worldWithMandate();
    expiring.world.clock.now = Date.UTC(2026, 11, 1) / 1000; // the mandate's exp: two months from October
    rejected(await rawBegin(expiring.world, expiring.analyst, expiring.credentials[0]!), "expired");
  });

  it("standing_trust_floor: the agent won't apply below its floor or on a tier it didn't derive", async () => {
    const { world, analyst } = await worldWithMandate();
    world.trust.source = "pinned_index";
    await expect(begin(world, analyst)).rejects.toMatchObject({ reason: "trust" });
    world.trust.source = "derived";
    world.trust.tier = "unverified";
    await expect(begin(world, analyst)).rejects.toMatchObject({ reason: "trust" });
  });

  it("standing_unlinkable: batch credentials share nothing but the dataset", async () => {
    const { world, credentials } = await worldWithMandate();
    expect(credentials.length).toBe(10);
    const parsed = await Promise.all(credentials.map((c) => parseSdJwt(c.compact)));
    const statuses = parsed.map((p) => JSON.stringify(p.payload.status));
    expect(new Set(statuses).size).toBe(credentials.length);
    expect(
      new Set(
        parsed.map((p) => (p.payload.status as { status_list: { uri: string } }).status_list.uri),
      ).size,
    ).toBeGreaterThan(1);
    expect(new Set(parsed.map((p) => p.jwt.split(".")[2])).size).toBe(credentials.length);
    expect(new Set(parsed.flatMap((p) => p.disclosures.map((d) => d.salt))).size).toBe(
      parsed.reduce((n, p) => n + p.disclosures.length, 0),
    );
    expect(new Set(credentials.map((c) => c.keyThumbprint)).size).toBe(credentials.length);
    for (const p of parsed) {
      expect(new Date((p.payload.nbf as number) * 1000).getUTCDate()).toBe(1);
      expect(new Date((p.payload.exp as number) * 1000).getUTCDate()).toBe(1);
    }
    // Search presentations disclose neither candidate nor scope.
    const ex = await world.holder.exercise({
      tool: "search_jobs",
      origin: PROVIDER,
      ojcpVersion: "0.3",
    });
    const shown = (await parseSdJwt(ex.userMandate)).disclosures.map((d) => d.value);
    expect(shown).toEqual(["search_jobs"]);
  });
});
