/**
 * A provider's wallet steps (RFC 0013): the provider, not the agent, asks the
 * candidate's wallet for a record and checks it. `verification_url` first
 * confirms the application's contact with a code, which makes that browser the
 * application's bound session (§3). Only that session can open a wallet request.
 * Requests are signed as `x509_hash` (§4.2) and answered encrypted to a key made
 * for that request. A presentation completes the step only when it returns to
 * the bound session, or when the candidate types the contact on the wallet's
 * device (§3 item 4). The provider keeps what it asked for and a hash of the
 * presentation, nothing else.
 */
import {
  base64url,
  type ClaimsPathQuery,
  HIRING_VCT,
  isRecord,
  type JWK,
  randomBytes,
  sha256,
  signJws,
  timingSafeEqual,
  utf8,
} from "@ojcp/credentials-core";
import type { Messenger } from "@ojcp/issuer";
import {
  type AcceptedHiringIssuer,
  contactMatches,
  type HiringPresentationPolicy,
  StatusListCache,
  tryVerifyHiringPresentation,
} from "@ojcp/verifier";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { compactDecrypt, decodeProtectedHeader, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import type { EventBus, SandboxClock } from "../events.ts";
import type { RequestCredential } from "../pki.ts";
import { APPLICATION_INFO_FORMAT, claimLabel, describeValues, valuesAt } from "../wallet/claims.ts";

const HOUR = 3600;
/** RFC 0013 §7: a wallet step's default deadline. */
const STEP_DEADLINE = 72 * HOUR;
/** §4: a request URI works for at most 10 minutes and 5 fetches. */
const REQUEST_TTL = 600;
const REQUEST_FETCHES = 5;
const CODE_TTL = 600;
const CODE_TRIES = 5;
const COOKIE = "ojcp_verify";

/** What the job needs, from §5's closed list, coarse claims first. */
export const EMPLOYMENT_PATHS: ClaimsPathQuery[] = [
  ["organization", "name"],
  ["current"],
  ["tenure_years"],
  ["positionHistories", null, "title"],
];

export interface WalletStepOptions {
  origin: string;
  employerName: string;
  request: RequestCredential;
  /** Issuers this provider accepts for employment records, with pinned keys (§6.1). */
  issuers: AcceptedHiringIssuer[];
  /** Every status list the accepted issuers enumerate, refreshed on a schedule (§6.2). */
  statusLists: () => Promise<string[]>;
  messenger: Messenger;
  clock: SandboxClock;
  events: EventBus;
}

/** What the provider keeps from a completed step. */
export interface KeptPresentation {
  record: Record<string, unknown>;
  issuer: string;
  basis: string;
  presentationSha256: string;
  /** Bound session, or the contact typed on the wallet's device. */
  via: "bound_session" | "contact_confirmed";
}

interface Step {
  applicationId: string;
  stepId: string;
  ref: string;
  job: { title: string; rule: string };
  contact: string;
  status: "pending" | "completed" | "deferred";
  deadline: number;
  code?: { hash: Uint8Array; expires: number; tries: number };
  /** Hashes of bound-session tokens. */
  sessions: Uint8Array[];
  /** A validated presentation waiting for the binding of §3. */
  awaiting?: { responseCode: string; kept: Omit<KeptPresentation, "via"> };
  result?: KeptPresentation;
  declined?: boolean;
}

interface OpenRequest {
  id: string;
  ref: string;
  nonce: string;
  state: string;
  kid: string;
  privateKey: CryptoKey;
  jwt: string;
  expires: number;
  fetches: number;
}

const ResponseForm = z.union([
  z.object({ response: z.string() }),
  z.object({ error: z.string(), state: z.string() }),
]);

function mask(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
}

function newRef(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
}

export class WalletStepVerifier {
  readonly #o: WalletStepOptions;
  readonly #steps = new Map<string, Step>();
  readonly #requests = new Map<string, OpenRequest>();
  readonly #status: StatusListCache;
  readonly #policy: HiringPresentationPolicy;

  constructor(options: WalletStepOptions) {
    this.#o = options;
    this.#status = new StatusListCache({ now: () => options.clock.now() });
    this.#policy = {
      issuers: options.issuers,
      profiles: { employment: ["baseline"] },
      status: this.#status,
      now: () => options.clock.now(),
    };
  }

  get host(): string {
    return new URL(this.#o.origin).host;
  }

  #emit(outcome: "ok" | "refused" | "info", title: string, detail?: Record<string, unknown>) {
    this.#o.events.emit({
      actor: "provider",
      where: this.host,
      title,
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  /** §6.2: status lists refresh on a schedule, never when a candidate presents. */
  async refreshStatus(): Promise<void> {
    for (const uri of await this.#o.statusLists()) {
      const issuer = this.#o.issuers.find((i) => uri.startsWith(`${i.iss}/`));
      if (issuer) await this.#status.refresh(uri, issuer.keys, 12 * HOUR).catch(() => undefined);
    }
  }

  #purpose(step: Step): string {
    return `${this.#o.employerName} asks to confirm your work history for your application to ${step.job.title} (${step.ref}). We check that the record is genuine and keep only what's listed here, for this application. A recruiter applies the job's requirement ("${step.job.rule}") when reviewing; it never rejects you on its own.`;
  }

  /** The wallet step `begin_application` returns (§2.1). */
  async start(applicationId: string, job: { title: string; rule: string }, contact: string) {
    const step: Step = {
      applicationId,
      stepId: `ws_${base64url(randomBytes(6))}`,
      ref: newRef(),
      job,
      contact,
      status: "pending",
      deadline: this.#o.clock.now() + STEP_DEADLINE,
      sessions: [],
    };
    this.#steps.set(step.ref, step);
    this.#emit(
      "info",
      `Wallet step opened for ${job.title} (reference ${step.ref}): verify work history at the provider's own page`,
      { asks_for: EMPLOYMENT_PATHS.map(claimLabel) },
    );
    return {
      step: {
        step_id: step.stepId,
        type: "employment",
        verifier_id: this.host,
        verifier_name: this.#o.employerName,
        verification_url: `${this.#o.origin}/verify/${step.ref}`,
        required: true,
        human_required: true,
        proof_delivery: "provider_managed",
        estimated_completion_minutes: 3,
        instructions:
          "Open the verification page. It confirms your email, then asks your wallet. If you don't have a wallet, you can continue without one.",
        wallet_request: {
          purpose: this.#purpose(step),
          application_ref: step.ref,
          masked_contact: mask(contact),
          dcql_query: this.#dcql(),
          alternative: "post_submission",
        },
      },
      deadline: new Date(step.deadline * 1000).toISOString(),
    };
  }

  #dcql() {
    return {
      credentials: [
        {
          id: "employment",
          format: "dc+sd-jwt",
          meta: { vct_values: [HIRING_VCT.employment] },
          claims: EMPLOYMENT_PATHS.map((path) => ({ path })),
        },
      ],
    };
  }

  #byApplication(applicationId: string): Step | undefined {
    return [...this.#steps.values()].find((s) => s.applicationId === applicationId);
  }

  /** §2.2: the state the agent may learn, and nothing more. */
  stepState(applicationId: string): { stepId: string; status: Step["status"] } | undefined {
    const step = this.#byApplication(applicationId);
    return step ? { stepId: step.stepId, status: step.status } : undefined;
  }

  /** §3 item 6: at submission the application's contact must equal the verified one. */
  async submissionMatches(applicationId: string, contact: string | undefined): Promise<boolean> {
    const step = this.#byApplication(applicationId);
    if (step?.status !== "completed") return true;
    if (!contact || !(await contactMatches(contact, step.contact))) {
      step.status = "pending";
      step.result = undefined;
      return false;
    }
    return true;
  }

  /** How far the candidate has got with any step (for the sandbox's story view). */
  progress(): { opened: boolean; bound: boolean; settled: boolean } {
    const steps = [...this.#steps.values()];
    return {
      opened: steps.length > 0,
      bound: steps.some((s) => s.sessions.length > 0),
      settled: steps.some((s) => s.status !== "pending"),
    };
  }

  kept(applicationId: string): KeptPresentation | undefined {
    return this.#byApplication(applicationId)?.result;
  }

  async #bound(c: Context, step: Step): Promise<boolean> {
    const token = getCookie(c, `${COOKIE}_${step.ref}`);
    if (!token) return false;
    const hash = await sha256(utf8(token));
    return step.sessions.some((s) => timingSafeEqual(s, hash));
  }

  /**
   * The verification page's state. Anyone holding the `verification_url`
   * (the agent too) may see the step and its state; what was shared, by whom,
   * and whether a try was declined is shown only in the candidate's bound
   * session (RFC 0013 §2.2: the agent learns only pending, completed or deferred).
   */
  async #view(c: Context, step: Step, responseCode?: string) {
    const bound = await this.#bound(c, step);
    // The wallet's redirect carries the response code: whoever holds it may type the contact (§3 item 4).
    const holdsResponse =
      responseCode !== undefined && step.awaiting?.responseCode === responseCode;
    return {
      ref: step.ref,
      employer: this.#o.employerName,
      job: step.job.title,
      masked_contact: mask(step.contact),
      purpose: this.#purpose(step),
      asks: EMPLOYMENT_PATHS.map(claimLabel),
      status: step.status,
      bound,
      code_sent: step.code !== undefined,
      deadline: step.deadline,
      ...(bound
        ? {
            declined: step.declined === true,
            awaiting_confirmation: step.awaiting !== undefined,
            result: step.result
              ? {
                  basis: step.result.basis,
                  issuer: step.result.issuer,
                  shared: EMPLOYMENT_PATHS.map((p) => ({
                    label: claimLabel(p),
                    value: describeValues(valuesAt(step.result?.record, p)),
                  })),
                }
              : undefined,
          }
        : { declined: false, awaiting_confirmation: holdsResponse }),
    };
  }

  #complete(step: Step, via: KeptPresentation["via"]): void {
    if (!step.awaiting) return;
    step.result = { ...step.awaiting.kept, via };
    step.awaiting = undefined;
    step.status = "completed";
    this.#emit(
      "ok",
      `Wallet step ${step.ref} completed: the presentation came back to the ${via === "bound_session" ? "bound browser session" : "wallet's device and the candidate typed the application's contact"}`,
      {
        kept: EMPLOYMENT_PATHS.map(claimLabel),
        presentation_sha256: step.result.presentationSha256,
      },
    );
  }

  routes(app: Hono): void {
    const step = (c: Context) => this.#steps.get(c.req.param("ref") ?? "");
    const missing = { error: "This verification link is no longer valid." };

    app.get("/ojcp/accepted-issuers.json", (c) =>
      c.json({
        employment: {
          formats: ["dc+sd-jwt"],
          types: [HIRING_VCT.employment],
          profiles: ["baseline"],
          issuers: this.#o.issuers.map((i) => ({
            iss: i.iss,
            basis: i.basis,
            keys: i.keys.map((k) => ({ ...k.jwk, ojcp_sign_until: k.signUntil })),
          })),
        },
      }),
    );

    app.get("/api/verify/:ref", async (c) => {
      const s = step(c);
      return s ? c.json(await this.#view(c, s)) : c.json(missing, 404);
    });

    // §3 item 1: contact first. The code goes to the application's contact, never to a typed one.
    app.post("/api/verify/:ref/code", async (c) => {
      const s = step(c);
      if (!s) return c.json(missing, 404);
      const code = String(100_000 + (new DataView(randomBytes(4).buffer).getUint32(0) % 900_000));
      s.code = {
        hash: await sha256(utf8(code)),
        expires: this.#o.clock.now() + CODE_TTL,
        tries: 0,
      };
      await this.#o.messenger.send(
        { email: s.contact },
        {
          subject: `${this.#o.employerName}: confirm it's you (${s.ref})`,
          text: `Your code is ${code}. It confirms it's you for application ${s.ref}.`,
        },
      );
      return c.json(await this.#view(c, s));
    });

    app.post("/api/verify/:ref/session", async (c) => {
      const s = step(c);
      if (!s) return c.json(missing, 404);
      const { code } = z.object({ code: z.string() }).parse(await c.req.json());
      const now = this.#o.clock.now();
      if (!s.code || s.code.expires < now || s.code.tries >= CODE_TRIES)
        return c.json({ error: "That code has expired. Send a new one." }, 400);
      s.code.tries++;
      if (!timingSafeEqual(await sha256(utf8(code.trim())), s.code.hash))
        return c.json({ error: "That code isn't right." }, 400);
      s.code = undefined;
      const token = base64url(randomBytes(24));
      s.sessions.push(await sha256(utf8(token)));
      setCookie(c, `${COOKIE}_${s.ref}`, token, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: STEP_DEADLINE,
      });
      this.#emit(
        "ok",
        `Contact confirmed for ${s.ref}: this browser is now the application's bound session`,
      );
      return c.json({ ...(await this.#view(c, s)), bound: true });
    });

    // Only the bound session can open a wallet request (§4).
    app.post("/api/verify/:ref/wallet", async (c) => {
      const s = step(c);
      if (!s) return c.json(missing, 404);
      if (!(await this.#bound(c, s)))
        return c.json({ error: "Confirm your email on this page first." }, 403);
      const opened = await this.#openRequest(s);
      return c.json(opened);
    });

    // §7: choosing not to use a wallet defers the step; submission goes ahead.
    app.post("/api/verify/:ref/skip", async (c) => {
      const s = step(c);
      if (!s) return c.json(missing, 404);
      if (!(await this.#bound(c, s)))
        return c.json({ error: "Confirm your email on this page first." }, 403);
      s.status = "deferred";
      this.#emit(
        "info",
        `Candidate chose to continue without a wallet for ${s.ref}: the step is deferred, and the employer checks later by its own means`,
      );
      return c.json(await this.#view(c, s));
    });

    app.post("/api/verify/:ref/complete", async (c) => {
      const s = step(c);
      if (!s) return c.json(missing, 404);
      const { response_code } = z.object({ response_code: z.string() }).parse(await c.req.json());
      if (!s.awaiting || s.awaiting.responseCode !== response_code)
        return c.json(await this.#view(c, s));
      if (await this.#bound(c, s)) this.#complete(s, "bound_session");
      return c.json(await this.#view(c, s, response_code));
    });

    // §3 item 4: an unbound presentation counts only once the candidate types the contact.
    app.post("/api/verify/:ref/confirm-contact", async (c) => {
      const s = step(c);
      if (!s) return c.json(missing, 404);
      const body = z
        .object({ response_code: z.string(), contact: z.string() })
        .parse(await c.req.json());
      if (!s.awaiting || s.awaiting.responseCode !== body.response_code)
        return c.json(await this.#view(c, s));
      if (!(await contactMatches(body.contact, s.contact))) {
        this.#emit(
          "refused",
          `A presentation for ${s.ref} was not confirmed: the typed contact didn't match`,
        );
        return c.json({ ...(await this.#view(c, s, body.response_code)), mismatch: true });
      }
      this.#complete(s, "contact_confirmed");
      return c.json(await this.#view(c, s));
    });

    app.get("/oid4vp/request/:id", (c) => {
      const r = this.#requests.get(c.req.param("id"));
      if (!r || r.expires < this.#o.clock.now() || r.fetches >= REQUEST_FETCHES)
        return c.text("expired", 404);
      r.fetches++;
      return c.body(r.jwt, 200, { "content-type": "application/oauth-authz-req+jwt" });
    });

    app.post("/oid4vp/response", async (c) => {
      const form = ResponseForm.safeParse(Object.fromEntries(await c.req.formData()));
      if (!form.success) return c.json({ error: "invalid_request" }, 400);
      if ("error" in form.data) {
        const { state } = form.data;
        const r = [...this.#requests.values()].find((x) => x.state === state);
        const s = r ? this.#steps.get(r.ref) : undefined;
        if (!r || !s) return c.json({ error: "invalid_request" }, 400);
        this.#requests.delete(r.id);
        s.declined = true;
        this.#emit(
          "info",
          `The wallet answered ${s.ref} with "${form.data.error}": the candidate declined`,
        );
        return c.json({ redirect_uri: `${this.#o.origin}/verify/${s.ref}?declined=1` });
      }
      return this.#receive(c, form.data.response);
    });
  }

  async #openRequest(s: Step) {
    const now = this.#o.clock.now();
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256" });
    const kid = base64url(randomBytes(8));
    const request: Omit<OpenRequest, "jwt"> = {
      id: base64url(randomBytes(12)),
      ref: s.ref,
      nonce: base64url(randomBytes(18)),
      state: base64url(randomBytes(18)),
      kid,
      privateKey: privateKey as CryptoKey,
      expires: now + REQUEST_TTL,
      fetches: 0,
    };
    const encJwk = { ...((await exportJWK(publicKey)) as JWK), kid, use: "enc", alg: "ECDH-ES" };
    const jwt = await signJws(
      { typ: "oauth-authz-req+jwt", x5c: this.#o.request.x5c },
      {
        aud: "https://self-issued.me/v2",
        client_id: this.#o.request.clientId,
        response_type: "vp_token",
        response_mode: "direct_post.jwt",
        response_uri: `${this.#o.origin}/oid4vp/response`,
        nonce: request.nonce,
        state: request.state,
        iat: now,
        exp: request.expires,
        dcql_query: this.#dcql(),
        client_metadata: {
          jwks: { keys: [encJwk] },
          // HAIP 1.0 §5: verifiers list both.
          encrypted_response_enc_values_supported: ["A128GCM", "A256GCM"],
          vp_formats_supported: {
            "dc+sd-jwt": { "sd-jwt_alg_values": ["ES256"], "kb-jwt_alg_values": ["ES256"] },
          },
        },
        verifier_info: [
          {
            format: APPLICATION_INFO_FORMAT,
            data: {
              application_ref: s.ref,
              masked_contact: mask(s.contact),
              purpose: this.#purpose(s),
              employer: this.#o.employerName,
              job_title: s.job.title,
            },
          },
        ],
      },
      this.#o.request.signer,
    );
    this.#requests.set(request.id, { ...request, jwt });
    const requestUri = `${this.#o.origin}/oid4vp/request/${request.id}`;
    const params = new URLSearchParams({
      client_id: this.#o.request.clientId,
      request_uri: requestUri,
    });
    this.#emit(
      "info",
      `Signed a wallet request for ${s.ref} as ${this.#o.request.clientId.slice(0, 24)}…: 10 minutes, 5 fetches, response encrypted to a key made for this request`,
      { dcql_query: this.#dcql() },
    );
    return {
      client_id: this.#o.request.clientId,
      request_uri: requestUri,
      openid4vp_uri: `openid4vp://?${params}`,
      expires: request.expires,
    };
  }

  async #receive(c: Context, jwe: string): Promise<Response> {
    // §6.2 item 1: a response that fails validation doesn't use up the request.
    const fail = (why: string) => {
      this.#emit("refused", `Rejected a wallet response: ${why}`);
      return c.json({ error: "invalid_request" }, 400);
    };
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(jwe).kid;
    } catch {
      return fail("not a JWE");
    }
    const r = [...this.#requests.values()].find((x) => x.kid === kid);
    if (!r || r.expires < this.#o.clock.now()) return fail("no live request for this key");
    const s = this.#steps.get(r.ref);
    if (!s) return fail("no such step");
    let payload: unknown;
    try {
      const { plaintext } = await compactDecrypt(jwe, r.privateKey);
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      return fail("couldn't decrypt");
    }
    if (!isRecord(payload) || payload.state !== r.state) return fail("state doesn't match");
    const tokens = isRecord(payload.vp_token) ? payload.vp_token.employment : undefined;
    const presentation = Array.isArray(tokens) ? tokens[0] : undefined;
    if (typeof presentation !== "string") return fail("no employment presentation");
    const checked = await tryVerifyHiringPresentation(this.#policy, presentation, {
      type: "employment",
      nonce: r.nonce,
      audience: this.#o.request.clientId,
      claims: EMPLOYMENT_PATHS,
    });
    if ("error" in checked) return fail(`${checked.error.kind}: ${checked.error.message}`);
    this.#requests.delete(r.id);
    const responseCode = base64url(randomBytes(18));
    s.awaiting = {
      responseCode,
      kept: {
        record: checked.credential.record,
        issuer: checked.issuer.iss,
        basis: checked.credential.basis,
        presentationSha256: checked.presentationSha256,
      },
    };
    this.#emit(
      "ok",
      `Validated the presentation for ${s.ref}: pinned issuer key and signing window, accepted type, basis and profile, key binding to this request's nonce, status VALID; everything not asked for was dropped unread`,
      { issuer: checked.issuer.iss, basis: checked.credential.basis },
    );
    return c.json({
      redirect_uri: `${this.#o.origin}/verify/${s.ref}?response_code=${responseCode}`,
    });
  }
}
