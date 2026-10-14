/**
 * Requests a faulty or hostile agent could send, over the wire, to any OJCP
 * provider that admits the sandbox issuer. Each case states the refusal RFC
 * 0008 §10 (or the spec's agent-identity rules) requires. The demo's
 * "misbehave" switches and the conformance runner both use them.
 */
import {
  actionDigest,
  actionStatement,
  bindKey,
  candidateDataDigest,
  type DisclosedClaim,
  evaluateScope,
  isRecord,
  issueSdJwt,
  JobPostingFacts,
  jobFacts,
  newNonce,
  presentSdJwt,
  type ScopeDisclosure,
  type Signer,
  StandingMandateDataset,
  sd,
  sdArray,
  signRequest,
  standingMandateClaims,
  type Tool,
  TYPE_METADATA,
  utf8,
  vctIntegrity,
} from "@ojcp/credentials-core";
import { z } from "zod";
import { OJCP_VERSION } from "../provider/provider.ts";
import type { SandboxAgent } from "./agent.ts";

export interface Wire {
  ok: boolean;
  result: Record<string, unknown>;
}

export interface CaseResult {
  id: string;
  title: string;
  rfc: string;
  expected: string;
  got: string;
  pass: boolean | "skipped";
  note?: string;
}

interface Credential {
  compact: string;
  keyThumbprint: string;
}

interface Target {
  origin: string;
  endpoint: string;
  jobs: JobPostingFacts[];
}

const Manifest = z.looseObject({ mcp_endpoint: z.url() });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Probe {
  readonly #agent: SandboxAgent;
  readonly #target: Target;

  private constructor(agent: SandboxAgent, target: Target) {
    this.#agent = agent;
    this.#target = target;
  }

  /** Finds the provider's MCP endpoint from its manifest and lists its jobs. */
  static async at(agent: SandboxAgent, origin: string): Promise<Probe> {
    const manifest = Manifest.parse(
      await (await fetch(`${new URL(origin).origin}/.well-known/ojcp.json`)).json(),
    );
    const probe = new Probe(agent, {
      origin: new URL(origin).origin,
      endpoint: manifest.mcp_endpoint,
      jobs: [],
    });
    const listed = await probe.call(
      "search_jobs",
      { query: "", agent_declaration: agent.declaration() },
      agent.world.keyring.requestSigner,
    );
    probe.#target.jobs = Array.isArray(listed.result.jobs)
      ? listed.result.jobs.flatMap((j) =>
          JobPostingFacts.safeParse(j).success ? [JobPostingFacts.parse(j)] : [],
        )
      : [];
    return probe;
  }

  get jobs(): JobPostingFacts[] {
    return this.#target.jobs;
  }

  /** A signed JSON-RPC `tools/call`, with the key and nonce chosen by the caller. */
  async call(
    tool: Tool,
    args: Record<string, unknown>,
    signer?: Signer,
    nonce?: string,
    replay?: { headers: Headers; body: string },
  ): Promise<Wire & { sent: { headers: Headers; body: string } }> {
    const body =
      replay?.body ??
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      });
    let headers =
      replay?.headers ??
      new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });
    if (signer && !replay) {
      headers = (
        await signRequest(
          { method: "POST", url: this.#target.endpoint, headers, body: utf8(body) },
          {
            signer,
            signatureAgent: this.#agent.origin,
            now: this.#agent.world.clock.now(),
            ...(nonce ? { nonce } : {}),
          },
        )
      ).headers;
    }
    const response = await fetch(this.#target.endpoint, { method: "POST", headers, body });
    const json: unknown = await response.json().catch(() => undefined);
    const result = isRecord(json) && isRecord(json.result) ? json.result : {};
    const content = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = isRecord(content) && typeof content.text === "string" ? content.text : "{}";
    const payload: unknown = JSON.parse(text);
    return {
      ok: result.isError !== true && response.ok,
      result: isRecord(payload) ? payload : {},
      sent: { headers, body },
    };
  }

  async #credentials(): Promise<Credential[]> {
    const batches = await this.#agent.store.batches();
    const fresh = batches.flatMap((b) => b.credentials.filter((c) => !c.use));
    if (fresh.length < 2)
      throw new Error(
        "the agent needs a standing mandate with unused credentials: approve one first",
      );
    return fresh;
  }

  async #scope() {
    const [batch] = await this.#agent.store.batches();
    if (!batch) throw new Error("no standing mandate held");
    return batch.mandate.scope;
  }

  /** A job the mandate covers, with what to disclose for it. */
  async #covered(
    predicate: (j: JobPostingFacts) => boolean = () => true,
  ): Promise<{ job: JobPostingFacts; disclose: ScopeDisclosure } | undefined> {
    const scope = await this.#scope();
    for (const job of this.#target.jobs.filter(predicate)) {
      const coverage = evaluateScope(scope, jobFacts(job, scope.taxonomy));
      if (coverage.covered) return { job, disclose: coverage.disclose };
    }
    return undefined;
  }

  #select(tool: Tool, disclose: ScopeDisclosure | undefined, email: string | null) {
    return (c: DisclosedClaim): boolean => {
      const v = c.disclosure.value;
      if (c.path[0] === "actions") return v === tool;
      if (c.path[0] === "candidate") return email !== null && same(v, { email });
      if (c.path[0] !== "scope" || !disclose || c.path.length !== 3) return false;
      const key = c.path[1];
      if (key === "job_families") return v === disclose.job_family;
      if (key === "locations") return same(v, disclose.location);
      if (key === "remote_policy") return v === disclose.remote_policy;
      if (key === "salary") return same(v, disclose.salary);
      return false;
    };
  }

  async #present(
    credential: Credential,
    tool: Tool,
    disclose: ScopeDisclosure | undefined,
    kb: { nonce: string; aud?: string; ojcp_action?: string },
    opts: { email?: string | null; kbSigner?: Signer } = {},
  ): Promise<string> {
    const signer = opts.kbSigner ?? this.#agent.world.keyring.signerFor(credential.keyThumbprint);
    if (!signer) throw new Error("mandate key not held");
    const presentation = await presentSdJwt(
      credential.compact,
      this.#select(tool, disclose, opts.email === undefined ? this.#agent.email : opts.email),
    );
    return bindKey(
      presentation,
      {
        aud: kb.aud ?? this.#target.origin,
        nonce: kb.nonce,
        iat: this.#agent.world.clock.now(),
        ...(kb.ojcp_action ? { ojcp_action: kb.ojcp_action } : {}),
      },
      signer,
    );
  }

  async #statement(
    tool: Tool,
    job: JobPostingFacts,
    keyThumbprint: string,
    extra: Record<string, unknown>,
  ): Promise<string> {
    return actionDigest(
      actionStatement({
        ojcp_version: OJCP_VERSION,
        resource_server: this.#target.origin,
        ...(job.employer?.ojcp_employer_id
          ? { employer: { ojcp_employer_id: job.employer.ojcp_employer_id } }
          : {}),
        tool,
        job_id: job.ojcp_id,
        agent_id: this.#agent.world.origins.agentId,
        agent_key_thumbprint: keyThumbprint,
        ...extra,
      }),
    );
  }

  /** A begin_application request, with any part made wrong. */
  async begin(
    job: JobPostingFacts,
    disclose: ScopeDisclosure | undefined,
    credential: Credential,
    wrong: {
      email?: string | null;
      aud?: string;
      digestJob?: JobPostingFacts;
      requestSigner?: Signer;
    } = {},
  ): Promise<
    Wire & {
      session?: { application_id: string; mandate_nonce: string; binding_actions: unknown[] };
    }
  > {
    const candidate_context = this.#agent.candidateContext();
    const nonce = newNonce();
    const ojcp_action = await this.#statement(
      "begin_application",
      wrong.digestJob ?? job,
      credential.keyThumbprint,
      {
        candidate_data_digest: await candidateDataDigest({ candidate_context }),
        consent_scope: "application_prefill",
      },
    );
    const mandate = await this.#present(
      credential,
      "begin_application",
      disclose,
      { nonce, ojcp_action, ...(wrong.aud ? { aud: wrong.aud } : {}) },
      { ...(wrong.email !== undefined ? { email: wrong.email } : {}) },
    );
    const signer =
      wrong.requestSigner ?? this.#agent.world.keyring.signerFor(credential.keyThumbprint);
    const out = await this.call(
      "begin_application",
      {
        job_id: job.ojcp_id,
        candidate_context,
        agent_declaration: this.#agent.declaration(mandate),
      },
      signer,
      nonce,
    );
    if (!out.ok) return out;
    return {
      ...out,
      session: {
        application_id: String(out.result.application_id),
        mandate_nonce: String(out.result.mandate_nonce),
        binding_actions: Array.isArray(out.result.binding_actions)
          ? out.result.binding_actions
          : [],
      },
    };
  }

  async submit(
    job: JobPostingFacts,
    disclose: ScopeDisclosure,
    credential: Credential,
    session: { application_id: string; mandate_nonce: string },
    wrong: { contact?: string; eeo?: boolean } = {},
  ): Promise<Wire> {
    const application_data = {
      ...this.#agent.applicationData(),
      ...(wrong.eeo ? { eeo: { gender: "decline_to_answer" } } : {}),
    };
    const candidate_context = this.#agent.candidateContext(wrong.contact ?? this.#agent.email);
    const ojcp_action = await this.#statement("submit_application", job, credential.keyThumbprint, {
      application_id: session.application_id,
      mandate_nonce: session.mandate_nonce,
      candidate_data_digest: await candidateDataDigest({ application_data, candidate_context }),
    });
    const mandate = await this.#present(credential, "submit_application", disclose, {
      nonce: session.mandate_nonce,
      ojcp_action,
    });
    return this.call(
      "submit_application",
      {
        application_id: session.application_id,
        application_data,
        candidate_context,
        agent_declaration: this.#agent.declaration(mandate),
      },
      this.#agent.world.keyring.signerFor(credential.keyThumbprint),
    );
  }

  /** A credential the sandbox issuer signs with a corruption no honest issuer would produce. */
  async forged(
    credential: Credential,
    corrupt: (claims: Record<string, unknown>) => void,
  ): Promise<Credential> {
    const world = this.#agent.world;
    const key = world.keyring.mandateKey(credential.keyThumbprint);
    if (!key) throw new Error("mandate key not held");
    const claims = standingMandateClaims({
      issuer: world.origins.origin("issuer"),
      dataset: StandingMandateDataset.parse({
        agent_id: world.origins.agentId,
        candidate: this.#agent.proposal.candidate,
        job_families: this.#agent.proposal.scope.job_families,
        locations: this.#agent.proposal.scope.locations,
        remote_policy: this.#agent.proposal.scope.remote_policy,
        salary_floor: this.#agent.proposal.scope.salary_floor,
        per_employer: this.#agent.proposal.per_employer,
        applications_total: this.#agent.proposal.applications_total,
        actions: this.#agent.proposal.actions,
        prohibited: [],
        consent_scope: this.#agent.proposal.consent_scope,
        provider_trust_floor: this.#agent.proposal.provider_trust_floor,
        months: this.#agent.proposal.months,
      }),
      holderJwk: key.signer.publicJwk,
      status: { idx: 4242, uri: `${world.origins.origin("issuer")}/status/1` },
      vctIntegrity: await vctIntegrity(TYPE_METADATA.standing_mandate),
      ojcpVersion: OJCP_VERSION,
      now: new Date(world.clock.now() * 1000),
    });
    corrupt(claims);
    const { compact } = await issueSdJwt({
      signer: world.issuer.config.signer,
      header: { kid: world.issuer.kid },
      claims,
    });
    return { compact, keyThumbprint: credential.keyThumbprint };
  }

  // ── Cases ────────────────────────────────────────────────────────────────

  static readonly CASES = [
    {
      id: "covered",
      title: "An honest agent applies to a covered job",
      rfc: "RFC 0008 §8",
      expected: "accepted",
    },
    {
      id: "unsigned",
      title: "begin_application without an RFC 9421 signature",
      rfc: "spec Agent Identity",
      expected: "agent_signature_missing",
    },
    {
      id: "no-candidate",
      title: "No candidate binding disclosed on begin_application",
      rfc: "RFC 0008 §2.3",
      expected: "user_mandate_required",
    },
    {
      id: "contact-swap",
      title: "Submits with a different email than the one disclosed",
      rfc: "RFC 0008 §2.3",
      expected: "user_mandate_required",
    },
    {
      id: "uncovered",
      title: "Discloses the mandate's job family for a job outside it",
      rfc: "RFC 0008 §2.2",
      expected: "user_mandate_required",
    },
    {
      id: "other-job",
      title: "ojcp_action computed over another job",
      rfc: "RFC 0008 §4.2",
      expected: "user_mandate_required",
    },
    {
      id: "wrong-audience",
      title: "Key-binding JWT addressed to another provider",
      rfc: "RFC 0008 §4.2",
      expected: "user_mandate_required",
    },
    {
      id: "wrong-key",
      title: "Request signed by a key other than the mandate's",
      rfc: "RFC 0008 §8 step 1",
      expected: "user_mandate_required",
    },
    {
      id: "replay",
      title: "The same signed request sent twice",
      rfc: "RFC 0008 §4.3",
      expected: "agent_nonce_replayed",
    },
    {
      id: "eeo",
      title: "EEO answers under a standing mandate",
      rfc: "RFC 0008 §5.2",
      expected: "user_mandate_required",
    },
    {
      id: "skip-terms",
      title: "Submits past a legal agreement under the standing mandate",
      rfc: "RFC 0008 §5.1",
      expected: "user_mandate_required (action_mandate_required)",
    },
    {
      id: "hidden-restriction",
      title: "Credential with a hidden _sd claim",
      rfc: "RFC 0008 §2.1",
      expected: "user_mandate_required",
    },
    {
      id: "padding",
      title: "Allow-list longer than its breadth allows",
      rfc: "RFC 0008 §2.5",
      expected: "user_mandate_required",
    },
  ] as const;

  async run(id: (typeof Probe.CASES)[number]["id"]): Promise<CaseResult> {
    const meta = Probe.CASES.find((c) => c.id === id);
    if (!meta) throw new Error(`unknown case ${id}`);
    const done = (got: Wire | string, pass: boolean | "skipped", note?: string): CaseResult => {
      const text =
        typeof got === "string"
          ? got
          : got.ok
            ? "accepted"
            : `${String(got.result.error_code)}${isRecord(got.result.details) && got.result.details.reason ? ` (${String(got.result.details.reason)})` : ""}`;
      return { ...meta, got: text, pass, ...(note ? { note } : {}) };
    };
    const refusedWith = (w: Wire, code: string, reason?: string) =>
      !w.ok &&
      w.result.error_code === code &&
      (reason === undefined || (isRecord(w.result.details) && w.result.details.reason === reason));

    if (id === "unsigned") {
      const job = this.#target.jobs[0];
      if (!job) return done("no jobs", "skipped");
      const w = await this.call("begin_application", {
        job_id: job.ojcp_id,
        agent_declaration: this.#agent.declaration(),
      });
      return done(w, refusedWith(w, "agent_signature_missing"));
    }
    const credentials = await this.#credentials();
    const [c1, c2] = credentials as [Credential, Credential];
    const covered = await this.#covered();
    if (!covered) return done("no covered job at this provider", "skipped");
    const { job: coveredJob, disclose } = covered;

    switch (id) {
      case "covered": {
        // The first covered job without a legal agreement.
        const scope = await this.#scope();
        for (const job of this.#target.jobs) {
          const r = evaluateScope(scope, jobFacts(job, scope.taxonomy));
          if (!r.covered) continue;
          const b = await this.begin(job, r.disclose, c1);
          if (!b.session) return done(b, false);
          if (b.session.binding_actions.length > 0) continue;
          const s = await this.submit(job, r.disclose, c1, b.session);
          return done(s, s.ok);
        }
        return done("every covered job has a legal agreement", "skipped");
      }
      case "no-candidate": {
        const w = await this.begin(coveredJob, disclose, c1, { email: null });
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "contact-swap": {
        const b = await this.begin(coveredJob, disclose, c1);
        if (!b.session) return done(b, false, "begin failed");
        const w = await this.submit(coveredJob, disclose, c1, b.session, {
          contact: "someone.else@example.com",
        });
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "uncovered": {
        const scope = await this.#scope();
        const outside = this.#target.jobs.find((j) => {
          const r = evaluateScope(scope, jobFacts(j, scope.taxonomy));
          return !r.covered && r.failures.includes("job_family");
        });
        if (!outside) return done("no job outside the mandate's families", "skipped");
        const w = await this.begin(outside, disclose, c1);
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "other-job": {
        const other = this.#target.jobs.find((j) => j.ojcp_id !== coveredJob.ojcp_id);
        if (!other) return done("only one job", "skipped");
        const w = await this.begin(coveredJob, disclose, c1, { digestJob: other });
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "wrong-audience": {
        const w = await this.begin(coveredJob, disclose, c1, {
          aud: "https://careers.elsewhere.example",
        });
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "wrong-key": {
        const w = await this.begin(coveredJob, disclose, c1, {
          requestSigner: this.#agent.world.keyring.signerFor(c2.keyThumbprint),
        });
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "replay": {
        const signer = this.#agent.world.keyring.requestSigner;
        const first = await this.call(
          "search_jobs",
          { query: "", agent_declaration: this.#agent.declaration() },
          signer,
        );
        const again = await this.call("search_jobs", {}, undefined, undefined, first.sent);
        return done(again, refusedWith(again, "agent_nonce_replayed"));
      }
      case "eeo": {
        const b = await this.begin(coveredJob, disclose, c1);
        if (!b.session) return done(b, false, "begin failed");
        const w = await this.submit(coveredJob, disclose, c1, b.session, { eeo: true });
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "skip-terms": {
        for (const job of this.#target.jobs) {
          const scope = await this.#scope();
          const r = evaluateScope(scope, jobFacts(job, scope.taxonomy));
          if (!r.covered) continue;
          const b = await this.begin(job, r.disclose, c1);
          if (b.session && b.session.binding_actions.length > 0) {
            const w = await this.submit(job, r.disclose, c1, b.session);
            return done(w, refusedWith(w, "user_mandate_required", "action_mandate_required"));
          }
        }
        return done("no covered job with binding actions", "skipped");
      }
      case "hidden-restriction": {
        const forged = await this.forged(c1, (c) => {
          c.hidden = sd("only employers in the agent's partner network");
        });
        const w = await this.begin(coveredJob, disclose, forged);
        return done(w, refusedWith(w, "user_mandate_required"));
      }
      case "padding": {
        const forged = await this.forged(c1, (c) => {
          if (isRecord(c.scope))
            c.scope.job_families = sdArray(this.#agent.proposal.scope.job_families, { padTo: 5 });
        });
        const w = await this.begin(coveredJob, disclose, forged);
        return done(w, refusedWith(w, "user_mandate_required"));
      }
    }
  }

  async runAll(): Promise<CaseResult[]> {
    const out: CaseResult[] = [];
    for (const c of Probe.CASES) {
      try {
        out.push(await this.run(c.id));
      } catch (error) {
        out.push({
          ...c,
          got: `error: ${error instanceof Error ? error.message : String(error)}`,
          pass: false,
        });
      }
    }
    return out;
  }
}
