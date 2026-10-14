/**
 * The issuer's protocol logic, independent of HTTP: OpenID4VCI 1.0 with the
 * RFC 0008 standing-mandate profile and the RFC 0014 baseline profile.
 */
import {
  algForJwk,
  BINDING_TOKENS,
  breadthOf,
  CandidateElement,
  ConsentScope,
  decodeJws,
  HIRING_VCT,
  type HiringType,
  hiringCredentialClaims,
  isGridValue,
  issueSdJwt,
  JobFamilyElement,
  type JWK,
  LocationElement,
  monthEpochs,
  normalizeCandidate,
  ONET_SOC_2019,
  type ParsedStandingMandateDataset,
  ProhibitedToken,
  publicPart,
  RemotePolicyElement,
  SALARY_UNITS,
  STANDING_MANDATE_VCT,
  StandingMandateDataset,
  Status,
  standingMandateClaims,
  Tool,
  TrustFloor,
  TYPE_METADATA,
  thumbprint,
  vctIntegrity,
  verifyJws,
} from "@ojcp/credentials-core";
import { z } from "zod";
import type { AgentClient, IssuerConfig } from "./config.ts";
import { type ConsentView, consentView } from "./consent.ts";
import { hashToken, numericCode, pkceMatches, token } from "./secrets.ts";
import { StatusRegistry } from "./status.ts";
import type {
  Grant,
  IssuedCredential,
  MandateAuthorization,
  PendingAuthorization,
  SubjectRecord,
} from "./store.ts";

export const STANDING_CONFIG_ID = "ojcp_standing_mandate";
export const HIRING_CONFIG_IDS: Record<HiringType, string> = {
  employment: "ojcp_employment",
  education: "ojcp_education",
  professional_license: "ojcp_professional_license",
  certification: "ojcp_certification",
};
const PRE_AUTHORIZED_GRANT = "urn:ietf:params:oauth:grant-type:pre-authorized_code";
const PROOF_TYP = "openid4vci-proof+jwt";
const MANDATE_KEY_QUARANTINE = 7 * 86_400;
const OTP_TTL = 600;
const CODE_TTL = 60;
const ACCESS_TTL = 300;
const OFFER_TTL = 7 * 86_400;
/** An offer shown inside a signed-in session is used at once. */
const SESSION_OFFER_TTL = 600;

/** OAuth/OpenID4VCI error responses. */
export class ProtocolError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
  toJSON(): { error: string; error_description: string } {
    return { error: this.error, error_description: this.message };
  }
}

/** RFC 0008 §3.1: the `ojcp_standing_mandate` member of an `authorization_details` entry. */
export const StandingMandateRequest = z.strictObject({
  candidate: z.array(CandidateElement).min(1).max(4),
  scope: z.strictObject({
    taxonomy: z.literal(ONET_SOC_2019).optional(),
    job_families: z.array(JobFamilyElement).min(1),
    locations: z.array(LocationElement).min(1),
    remote_policy: z.array(RemotePolicyElement).min(1),
    employment_type: z.array(z.string()).min(1).optional(),
    experience_level: z.array(z.string()).min(1).optional(),
    salary_floor: z
      .strictObject({
        value: z.number().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        unitText: z.enum(SALARY_UNITS),
      })
      .optional(),
    include_unstated_salary: z.boolean().optional(),
  }),
  per_employer: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  applications_total: z.number().int().positive().max(1000),
  actions: z.array(Tool).min(1),
  prohibited: z.array(ProhibitedToken).default([]),
  consent_scope: ConsentScope,
  provider_trust_floor: TrustFloor,
  months: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export type StandingMandateRequest = z.infer<typeof StandingMandateRequest>;

const AuthorizationDetails = z
  .array(
    z.looseObject({
      type: z.literal("openid_credential"),
      credential_configuration_id: z.literal(STANDING_CONFIG_ID),
      ojcp_standing_mandate: StandingMandateRequest,
    }),
  )
  .length(1);

export const AuthorizeParams = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.url(),
  state: z.string().max(512).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  authorization_details: z.string(),
});

export const TokenRequest = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string(),
    redirect_uri: z.string(),
    code_verifier: z.string(),
    client_id: z.string(),
  }),
  z.object({
    grant_type: z.literal(PRE_AUTHORIZED_GRANT),
    "pre-authorized_code": z.string(),
    tx_code: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string(),
    client_id: z.string().optional(),
  }),
]);

export const CredentialRequest = z.looseObject({
  credential_configuration_id: z.string().optional(),
  credential_identifier: z.string().optional(),
  proofs: z.strictObject({ jwt: z.array(z.string()).min(1) }),
});

/** Narrowing the user applied on the consent screen: only removals and reductions. */
export interface Narrowing {
  job_families?: string[];
  locations?: string[];
  remote_policy?: string[];
  actions?: string[];
  per_employer?: number;
  applications_total?: number;
  months?: number;
}

const identifierKey = (e: CandidateElement): string => JSON.stringify(normalizeCandidate(e));

export class Issuer {
  readonly config: IssuerConfig;
  readonly status: StatusRegistry;
  /** Thumbprint of the signing key; the `kid` of everything it signs. */
  readonly kid: string;
  readonly #integrity: ReadonlyMap<string, string>;

  private constructor(config: IssuerConfig, kid: string, integrity: ReadonlyMap<string, string>) {
    this.config = config;
    this.kid = kid;
    this.#integrity = integrity;
    this.status = new StatusRegistry({
      uris: config.statusLists,
      signer: config.signer,
      kid,
      ttl: 3600,
      store: config.store,
    });
  }

  static async create(config: IssuerConfig): Promise<Issuer> {
    const integrity = new Map<string, string>();
    for (const [name, metadata] of Object.entries(TYPE_METADATA))
      integrity.set(name, await vctIntegrity(metadata));
    return new Issuer(config, await thumbprint(config.signer.publicJwk), integrity);
  }

  now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  client(clientId: string): AgentClient | undefined {
    return this.config.clients.find((c) => c.clientId === clientId);
  }

  // ── Metadata ───────────────────────────────────────────────────────────────

  async credentialIssuerMetadata(): Promise<Record<string, unknown>> {
    const base = this.config.issuer;
    const sdJwtConfig = (vct: string, scope: string) => ({
      format: "dc+sd-jwt",
      scope,
      vct,
      cryptographic_binding_methods_supported: ["jwk"],
      credential_signing_alg_values_supported: ["ES256"],
      proof_types_supported: { jwt: { proof_signing_alg_values_supported: ["ES256"] } },
    });
    const configurations: Record<string, unknown> = {
      [STANDING_CONFIG_ID]: sdJwtConfig(STANDING_MANDATE_VCT, "ojcp_standing_mandate"),
    };
    for (const [type, id] of Object.entries(HIRING_CONFIG_IDS))
      configurations[id] = sdJwtConfig(HIRING_VCT[type as HiringType], id);
    return {
      credential_issuer: base,
      authorization_servers: [base],
      credential_endpoint: `${base}/credential`,
      nonce_endpoint: `${base}/nonce`,
      batch_credential_issuance: { batch_size: this.config.batchSize ?? 10 },
      ...(this.config.displayName
        ? { display: [{ name: this.config.displayName, locale: "en" }] }
        : {}),
      credential_configurations_supported: configurations,
      ojcp_issuer: {
        profile: "baseline",
        policy_uri: this.config.policyUri,
        status_lists: [...this.config.statusLists],
        ...(this.config.consumerReportingAgency === undefined
          ? {}
          : { consumer_reporting_agency: this.config.consumerReportingAgency }),
      },
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.config.issuer;
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", PRE_AUTHORIZED_GRANT, "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      authorization_details_types_supported: ["openid_credential"],
      "pre-authorized_grant_anonymous_access_supported": true,
      token_endpoint_auth_methods_supported: ["none"],
    };
  }

  /** JWT VC Issuer Metadata: the signing key with its RFC 0014 §5.1 window. */
  async jwtVcIssuerMetadata(): Promise<Record<string, unknown>> {
    const jwk = publicPart(this.config.signer.publicJwk);
    return {
      issuer: this.config.issuer,
      jwks: {
        keys: [
          {
            ...jwk,
            kid: await thumbprint(jwk),
            use: "sig",
            alg: algForJwk(jwk),
            ojcp_sign_until: this.config.signUntil,
          },
        ],
      },
    };
  }

  // ── Standing mandates: authorization ───────────────────────────────────────

  async startAuthorization(query: Record<string, string>): Promise<PendingAuthorization> {
    const params = AuthorizeParams.safeParse(query);
    if (!params.success)
      throw new ProtocolError("invalid_request", "malformed authorization request");
    const { client_id, redirect_uri, state, code_challenge } = params.data;
    const client = this.client(client_id);
    if (!client?.redirectUris.includes(redirect_uri))
      throw new ProtocolError("unauthorized_client", "unknown client or redirect_uri");
    let details: unknown;
    try {
      details = JSON.parse(params.data.authorization_details);
    } catch {
      throw new ProtocolError("invalid_authorization_details", "authorization_details is not JSON");
    }
    const parsed = AuthorizationDetails.safeParse(details);
    if (!parsed.success)
      throw new ProtocolError(
        "invalid_authorization_details",
        "authorization_details does not describe a standing mandate",
      );
    const [entry] = parsed.data;
    if (!entry)
      throw new ProtocolError("invalid_authorization_details", "no authorization_details entry");
    const dataset = this.#toDataset(client, entry.ojcp_standing_mandate);
    const pending: PendingAuthorization = {
      id: token(),
      clientId: client_id,
      redirectUri: redirect_uri,
      ...(state === undefined ? {} : { state }),
      codeChallenge: code_challenge,
      credentialConfigurationId: STANDING_CONFIG_ID,
      dataset,
      verified: [],
      createdAt: this.now(),
    };
    await this.config.store.put("pending", pending);
    return pending;
  }

  #toDataset(client: AgentClient, request: StandingMandateRequest): ParsedStandingMandateDataset {
    if (request.candidate.some((c) => "jkt" in c))
      throw new ProtocolError(
        "invalid_authorization_details",
        "this issuer verifies email and phone bindings only",
      );
    if (request.actions.some((a) => (BINDING_TOKENS as readonly string[]).includes(a)))
      throw new ProtocolError(
        "invalid_authorization_details",
        "binding actions can't be permitted",
      );
    if (request.scope.salary_floor && !isGridValue(request.scope.salary_floor.value))
      throw new ProtocolError("invalid_authorization_details", "salary floor must be a grid value");
    const dataset = StandingMandateDataset.safeParse({
      agent_id: client.agentId,
      candidate: request.candidate.map(normalizeCandidate),
      job_families: request.scope.job_families,
      locations: request.scope.locations,
      remote_policy: request.scope.remote_policy,
      ...(request.scope.employment_type ? { employment_type: request.scope.employment_type } : {}),
      ...(request.scope.experience_level
        ? { experience_level: request.scope.experience_level }
        : {}),
      ...(request.scope.salary_floor ? { salary_floor: request.scope.salary_floor } : {}),
      include_unstated_salary: request.scope.include_unstated_salary ?? false,
      per_employer: request.per_employer,
      applications_total: request.applications_total,
      actions: request.actions,
      prohibited: [...new Set([...request.prohibited, ...BINDING_TOKENS])],
      consent_scope: request.consent_scope,
      provider_trust_floor: request.provider_trust_floor,
      months: request.months,
    });
    if (!dataset.success)
      throw new ProtocolError(
        "invalid_authorization_details",
        "standing mandate request is invalid",
      );
    if (breadthOf(dataset.data) === null)
      throw new ProtocolError(
        "invalid_authorization_details",
        "more than 10 job families or places",
      );
    return dataset.data;
  }

  async pending(id: string): Promise<PendingAuthorization | undefined> {
    const pending = await this.config.store.get("pending", id);
    return pending && this.now() - pending.createdAt < 3600 ? pending : undefined;
  }

  /** Sends a one-time code to each identifier the mandate would bind (RFC 0008 §2.3). */
  async sendCodes(pendingId: string): Promise<void> {
    const pending = await this.pending(pendingId);
    if (!pending) throw new ProtocolError("invalid_request", "authorization expired", 404);
    for (const element of pending.dataset.candidate)
      await this.#sendOtp(`${pendingId}:${identifierKey(element)}`, element);
  }

  async #sendOtp(id: string, element: CandidateElement): Promise<void> {
    if ("jkt" in element) return;
    const code = numericCode();
    await this.config.store.put("otp", {
      id,
      identifier: identifierKey(element),
      codeHash: await hashToken(code),
      attempts: 0,
      expiresAt: this.now() + OTP_TTL,
    });
    await this.config.messenger.send(element, {
      subject: "Your verification code",
      text: `Your code is ${code}. It expires in 10 minutes.`,
    });
  }

  async #checkOtp(id: string, code: string): Promise<boolean> {
    const otp = await this.config.store.get("otp", id);
    if (!otp || otp.expiresAt < this.now() || otp.attempts >= 5) return false;
    if ((await hashToken(code.trim())) !== otp.codeHash) {
      await this.config.store.put("otp", { ...otp, attempts: otp.attempts + 1 });
      return false;
    }
    await this.config.store.delete("otp", id);
    return true;
  }

  /**
   * The user approved on the consent screen: checks every one-time code,
   * applies any narrowing, records the authorization, and returns the redirect.
   */
  async approve(
    pendingId: string,
    codes: Record<string, string>,
    narrowing: Narrowing = {},
  ): Promise<string> {
    const pending = await this.pending(pendingId);
    if (!pending) throw new ProtocolError("invalid_request", "authorization expired", 404);
    for (const element of pending.dataset.candidate) {
      const key = identifierKey(element);
      const code = codes[key];
      if (!code || !(await this.#checkOtp(`${pendingId}:${key}`, code)))
        throw new ProtocolError("access_denied", "a verification code is wrong or expired", 403);
    }
    return this.#authorize(pending, narrowing);
  }

  /**
   * The operator approved for a person it has already signed in, e.g. a wallet
   * provider whose app unlocked with the owner's biometrics. `verified` are the
   * identifiers the operator itself verified for that person (RFC 0008 §2.3);
   * the mandate may bind only those, so a request naming anyone else is refused.
   */
  async approveSignedIn(
    pendingId: string,
    verified: CandidateElement[],
    narrowing: Narrowing = {},
  ): Promise<string> {
    const pending = await this.pending(pendingId);
    if (!pending) throw new ProtocolError("invalid_request", "authorization expired", 404);
    const theirs = new Set(verified.map(identifierKey));
    if (!pending.dataset.candidate.every((e) => theirs.has(identifierKey(e))))
      throw new ProtocolError(
        "access_denied",
        "this request names someone other than the signed-in person",
        403,
      );
    return this.#authorize(pending, narrowing);
  }

  /** What the consent screen shows for a pending request, or undefined once it expired. */
  async consent(pendingId: string): Promise<ConsentView | undefined> {
    const pending = await this.pending(pendingId);
    const client = pending && this.client(pending.clientId);
    if (!pending || !client) return undefined;
    const { exp } = monthEpochs(new Date(this.now() * 1000), pending.dataset.months);
    return consentView(pendingId, client, pending.dataset, new Date(exp * 1000));
  }

  async #authorize(pending: PendingAuthorization, narrowing: Narrowing): Promise<string> {
    const pendingId = pending.id;
    const dataset = narrow(pending.dataset, narrowing);
    const { nbf, exp } = monthEpochs(new Date(this.now() * 1000), dataset.months);
    const client = this.client(pending.clientId);
    if (!client) throw new ProtocolError("unauthorized_client", "client no longer registered");
    const authorization: MandateAuthorization = {
      id: token(),
      clientId: client.clientId,
      agentId: client.agentId,
      dataset,
      nbf,
      exp,
      approvedAt: this.now(),
      revoked: false,
    };
    await this.config.store.put("authorization", authorization);
    const code = token();
    await this.config.store.put("grant", {
      id: await hashToken(code),
      kind: "code",
      subject: { kind: "mandate", authorizationId: authorization.id },
      clientId: client.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      expiresAt: this.now() + CODE_TTL,
      used: false,
    });
    await this.config.store.delete("pending", pendingId);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    redirect.searchParams.set("iss", this.config.issuer);
    return redirect.toString();
  }

  /** The user declined. */
  async deny(pendingId: string): Promise<string> {
    const pending = await this.pending(pendingId);
    if (!pending) throw new ProtocolError("invalid_request", "authorization expired", 404);
    await this.config.store.delete("pending", pendingId);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    if (pending.state) redirect.searchParams.set("state", pending.state);
    return redirect.toString();
  }

  // ── Token endpoint ─────────────────────────────────────────────────────────

  async token(form: Record<string, string>): Promise<Record<string, unknown>> {
    const request = TokenRequest.safeParse(form);
    if (!request.success) throw new ProtocolError("invalid_request", "malformed token request");
    const r = request.data;
    const store = this.config.store;
    let subject: Grant["subject"];
    let clientId: string | undefined;
    if (r.grant_type === "authorization_code") {
      const grant = await store.get("grant", await hashToken(r.code));
      if (grant?.kind !== "code" || grant.used || grant.expiresAt < this.now())
        throw new ProtocolError("invalid_grant", "code invalid or expired");
      await store.put("grant", { ...grant, used: true });
      if (grant.clientId !== r.client_id || grant.redirectUri !== r.redirect_uri)
        throw new ProtocolError("invalid_grant", "client or redirect_uri mismatch");
      if (!grant.codeChallenge || !(await pkceMatches(r.code_verifier, grant.codeChallenge)))
        throw new ProtocolError("invalid_grant", "PKCE verification failed");
      subject = grant.subject;
      clientId = grant.clientId;
    } else if (r.grant_type === "refresh_token") {
      const grant = await store.get("grant", await hashToken(r.refresh_token));
      if (grant?.kind !== "refresh" || grant.expiresAt < this.now())
        throw new ProtocolError("invalid_grant", "refresh token invalid");
      subject = grant.subject;
      clientId = grant.clientId;
    } else {
      const grant = await store.get("grant", await hashToken(r["pre-authorized_code"]));
      if (grant?.kind !== "pre_authorized" || grant.used || grant.expiresAt < this.now())
        throw new ProtocolError("invalid_grant", "pre-authorized code invalid or expired");
      if (grant.txCodeHash && (!r.tx_code || (await hashToken(r.tx_code)) !== grant.txCodeHash))
        throw new ProtocolError("invalid_grant", "tx_code wrong");
      await store.put("grant", { ...grant, used: true });
      subject = grant.subject;
    }

    const accessToken = token();
    await store.put("grant", {
      id: await hashToken(accessToken),
      kind: "access",
      subject,
      ...(clientId ? { clientId } : {}),
      expiresAt: this.now() + ACCESS_TTL,
      used: false,
    });
    const response: Record<string, unknown> = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
    };

    if (subject.kind === "mandate") {
      const authorization = await store.get("authorization", subject.authorizationId);
      if (!authorization || authorization.revoked || authorization.exp <= this.now())
        throw new ProtocolError("invalid_grant", "mandate revoked or expired");
      if (r.grant_type === "authorization_code") {
        const refreshToken = token();
        await store.put("grant", {
          id: await hashToken(refreshToken),
          kind: "refresh",
          subject,
          ...(clientId ? { clientId } : {}),
          expiresAt: authorization.exp,
          used: false,
        });
        response.refresh_token = refreshToken;
      }
      const d = authorization.dataset;
      response.authorization_details = [
        {
          type: "openid_credential",
          credential_configuration_id: STANDING_CONFIG_ID,
          credential_identifiers: [authorization.id],
          ojcp_standing_mandate: {
            applications_total: d.applications_total,
            ...(d.salary_floor ? { salary_floor: d.salary_floor } : {}),
            nbf: authorization.nbf,
            exp: authorization.exp,
          },
        },
      ];
    } else {
      const record = await store.get("record", subject.recordId);
      if (!record) throw new ProtocolError("invalid_grant", "record not found");
      response.authorization_details = [
        {
          type: "openid_credential",
          credential_configuration_id: HIRING_CONFIG_IDS[record.type],
          credential_identifiers: [record.id],
        },
      ];
    }
    return response;
  }

  async nonce(): Promise<string> {
    const c = token();
    await this.config.store.put("cnonce", { id: c, expiresAt: this.now() + 300 });
    return c;
  }

  // ── Credential endpoint ────────────────────────────────────────────────────

  async credential(
    accessToken: string | undefined,
    body: unknown,
  ): Promise<{ credentials: Array<{ credential: string }> }> {
    if (!accessToken) throw new ProtocolError("invalid_token", "missing access token", 401);
    const grant = await this.config.store.get("grant", await hashToken(accessToken));
    if (grant?.kind !== "access" || grant.expiresAt < this.now())
      throw new ProtocolError("invalid_token", "access token invalid", 401);
    const request = CredentialRequest.safeParse(body);
    if (!request.success)
      throw new ProtocolError("invalid_credential_request", "malformed credential request");
    if (request.data.proofs.jwt.length > (this.config.batchSize ?? 10))
      throw new ProtocolError("invalid_proof", "too many proofs");
    const keys = await this.#checkProofs(request.data.proofs.jwt, grant.clientId);
    return grant.subject.kind === "mandate"
      ? this.#issueMandates(grant.subject.authorizationId, keys)
      : this.#issueRecord(grant.subject.recordId, keys);
  }

  /** OpenID4VCI §8.2.1.1 and Appendix F.1 key proofs; one distinct key per credential. */
  async #checkProofs(proofs: readonly string[], clientId: string | undefined): Promise<JWK[]> {
    const keys: JWK[] = [];
    const seen = new Set<string>();
    for (const proof of proofs) {
      const { header } = decodeJws(proof);
      if (
        header.typ !== PROOF_TYP ||
        header.alg !== "ES256" ||
        typeof header.jwk !== "object" ||
        header.kid ||
        header.x5c
      )
        throw new ProtocolError("invalid_proof", "proof header must carry typ, ES256 and jwk only");
      const jwk = publicPart(header.jwk as JWK);
      let payload: Record<string, unknown>;
      try {
        payload = (await verifyJws(proof, jwk)).payload;
      } catch {
        throw new ProtocolError("invalid_proof", "proof signature invalid");
      }
      if (payload.aud !== this.config.issuer)
        throw new ProtocolError("invalid_proof", "proof aud must be the credential issuer");
      if (clientId && payload.iss !== undefined && payload.iss !== clientId)
        throw new ProtocolError("invalid_proof", "proof iss must be the client");
      const iat = payload.iat;
      if (typeof iat !== "number" || iat > this.now() + 60 || iat < this.now() - 300)
        throw new ProtocolError("invalid_proof", "proof iat out of range");
      const nonce =
        typeof payload.nonce === "string"
          ? await this.config.store.get("cnonce", payload.nonce)
          : undefined;
      if (!nonce || nonce.expiresAt < this.now())
        throw new ProtocolError("invalid_nonce", "c_nonce missing or expired");
      const tp = await thumbprint(jwk);
      if (seen.has(tp))
        throw new ProtocolError("invalid_proof", "each credential needs its own key");
      seen.add(tp);
      keys.push(jwk);
    }
    for (const proof of proofs) {
      const n = decodeJws(proof).payload.nonce;
      if (typeof n === "string") await this.config.store.delete("cnonce", n);
    }
    return keys;
  }

  async #issueMandates(
    authorizationId: string,
    keys: JWK[],
  ): Promise<{ credentials: Array<{ credential: string }> }> {
    const store = this.config.store;
    const authorization = await store.get("authorization", authorizationId);
    if (!authorization || authorization.revoked || authorization.exp <= this.now())
      throw new ProtocolError("invalid_grant", "mandate revoked or expired");
    const client = this.client(authorization.clientId);
    if (!client || client.agentId !== authorization.agentId)
      throw new ProtocolError("invalid_grant", "agent changed; the user must approve again");

    // RFC 0008 §3.2, §3.4: every key a current mandate key of the approved agent, published ≥ 7 days, valid past exp.
    const published = await this.config.mandateKeys.mandateKeys(client);
    for (const jwk of keys) {
      const tp = await thumbprint(jwk);
      const key = published.find((k) => k.thumbprint === tp);
      if (!key)
        throw new ProtocolError("invalid_proof", "key is not in the agent's mandate key set");
      if (key.until < authorization.exp)
        throw new ProtocolError("invalid_proof", "key's ojcp_mandate_until is before exp");
      if (this.now() - key.firstSeen < MANDATE_KEY_QUARANTINE)
        throw new ProtocolError("invalid_proof", "key published less than 7 days ago");
    }

    // §7.3: a new batch replaces the previous one.
    await this.#revokeIssued(
      (c) => c.subject.kind === "mandate" && c.subject.authorizationId === authorizationId,
    );

    const entries = await this.status.allocate(keys.length);
    const credentials: Array<{ credential: string }> = [];
    for (const [i, jwk] of keys.entries()) {
      const status = entries[i] as { uri: string; idx: number };
      const claims = standingMandateClaims({
        issuer: this.config.issuer,
        dataset: authorization.dataset,
        holderJwk: jwk,
        status,
        vctIntegrity: this.#integrity.get("standing_mandate") as string,
        ojcpVersion: this.config.ojcpVersion,
        now: new Date(authorization.nbf * 1000),
      });
      const { compact } = await issueSdJwt({
        signer: this.config.signer,
        header: { kid: this.kid },
        claims,
      });
      credentials.push({ credential: compact });
      await this.#recordIssued({ kind: "mandate", authorizationId }, status, authorization.exp);
    }
    return { credentials };
  }

  async #issueRecord(
    recordId: string,
    keys: JWK[],
  ): Promise<{ credentials: Array<{ credential: string }> }> {
    const record = await this.config.store.get("record", recordId);
    if (!record) throw new ProtocolError("invalid_grant", "record not found");
    if (this.now() > this.config.signUntil)
      throw new ProtocolError("server_error", "signing key is past its window", 500);
    const entries = await this.status.allocate(keys.length);
    const credentials: Array<{ credential: string }> = [];
    for (const [i, jwk] of keys.entries()) {
      const status = entries[i] as { uri: string; idx: number };
      const claims = hiringCredentialClaims({
        type: record.type,
        issuer: this.config.issuer,
        vctIntegrity: this.#integrity.get(record.type) as string,
        basis: record.basis,
        record: record.record,
        holderJwk: jwk as Record<string, unknown>,
        status,
        ...(record.holderName ? { holderName: record.holderName } : {}),
        now: new Date(this.now() * 1000),
      });
      const { compact } = await issueSdJwt({
        signer: this.config.signer,
        header: { kid: this.kid },
        claims,
      });
      credentials.push({ credential: compact });
      await this.#recordIssued({ kind: "record", recordId }, status, claims.exp as number);
    }
    return { credentials };
  }

  async #recordIssued(
    subject: Grant["subject"],
    status: { uri: string; idx: number },
    exp: number,
  ): Promise<void> {
    const issued: IssuedCredential = {
      id: token(),
      subject,
      statusUri: status.uri,
      statusIdx: status.idx,
      exp,
      issuedAt: this.now(),
    };
    await this.config.store.put("issued", issued);
  }

  async #revokeIssued(match: (c: IssuedCredential) => boolean): Promise<number> {
    const issued = await this.config.store.list("issued", match);
    for (const c of issued) {
      await this.status.set(c.statusUri, c.statusIdx, Status.INVALID);
      await this.config.store.delete("issued", c.id);
    }
    return issued.length;
  }

  // ── Revocation (RFC 0008 §7.2) ─────────────────────────────────────────────

  /** Authorizations that bind an identifier the user proved. */
  async authorizationsFor(identifier: CandidateElement): Promise<MandateAuthorization[]> {
    const key = identifierKey(identifier);
    return this.config.store.list(
      "authorization",
      (a) => !a.revoked && a.dataset.candidate.some((c) => identifierKey(c) === key),
    );
  }

  async sendAccountCode(identifier: CandidateElement): Promise<string> {
    const id = token();
    await this.#sendOtp(`account:${id}`, identifier);
    return id;
  }

  async checkAccountCode(id: string, code: string): Promise<boolean> {
    return this.#checkOtp(`account:${id}`, code);
  }

  /** Revokes every credential of an authorization, refreshed batches included. */
  async revokeAuthorization(authorizationId: string): Promise<void> {
    const authorization = await this.config.store.get("authorization", authorizationId);
    if (!authorization) return;
    await this.config.store.put("authorization", { ...authorization, revoked: true });
    await this.#revokeIssued(
      (c) => c.subject.kind === "mandate" && c.subject.authorizationId === authorizationId,
    );
    for (const g of await this.config.store.list(
      "grant",
      (g) => g.subject.kind === "mandate" && g.subject.authorizationId === authorizationId,
    ))
      await this.config.store.delete("grant", g.id);
  }

  // ── Hiring records (RFC 0014) ──────────────────────────────────────────────

  async putRecord(record: Omit<SubjectRecord, "updatedAt">): Promise<SubjectRecord> {
    if (record.basis !== "own_records" && this.config.consumerReportingAgency === undefined)
      throw new ProtocolError(
        "invalid_request",
        "consumer_reporting_agency must be declared before issuing on this basis",
      );
    // Validates the record now rather than at issuance.
    hiringCredentialClaims({
      type: record.type,
      issuer: this.config.issuer,
      vctIntegrity: "",
      basis: record.basis,
      record: record.record,
      holderJwk: {},
      status: { idx: 0, uri: this.config.statusLists[0] as string },
      now: new Date(this.now() * 1000),
    });
    const stored = { ...record, updatedAt: this.now() };
    await this.config.store.put("record", stored);
    return stored;
  }

  /**
   * Sends a Credential Offer with a pre-authorized code to the record's personal
   * email, and the transaction code by a separate channel (RFC 0014 §5.3 route 1).
   */
  async offer(recordId: string): Promise<{ offerUri: string }> {
    const record = await this.config.store.get("record", recordId);
    if (!record) throw new ProtocolError("invalid_request", "record not found", 404);
    if (!record.personalEmail)
      throw new ProtocolError("invalid_request", "no personal email on record");
    const preAuthorizedCode = token();
    const txCode = numericCode();
    await this.config.store.put("grant", {
      id: await hashToken(preAuthorizedCode),
      kind: "pre_authorized",
      subject: { kind: "record", recordId },
      txCodeHash: await hashToken(txCode),
      expiresAt: this.now() + OFFER_TTL,
      used: false,
    });
    const offerId = token();
    await this.config.store.put("offer", {
      id: offerId,
      recordId,
      preAuthorizedCode,
      txCodeRequired: true,
      expiresAt: this.now() + OFFER_TTL,
    });
    const offerUri = `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(`${this.config.issuer}/offers/${offerId}`)}`;
    await this.config.messenger.send(
      { email: record.personalEmail },
      {
        subject: "Your record is ready for your wallet",
        text: `Open this link with your credential wallet: ${offerUri}\nYou'll also receive a 6-digit code separately.`,
      },
    );
    const txChannel = record.personalPhone
      ? { phone: record.personalPhone }
      : { email: record.personalEmail };
    await this.config.messenger.send(txChannel, {
      subject: "Your wallet code",
      text: `Your code is ${txCode}.`,
    });
    return { offerUri };
  }

  /**
   * An offer for a holder the HR system has already signed in, e.g. an employee
   * on their own records page (RFC 0014 §4.1, OpenID4VCI §3.5). It goes only to
   * that session, so no transaction code; it is single-use and short-lived.
   */
  async sessionOffer(recordId: string): Promise<{ offerUri: string }> {
    const record = await this.config.store.get("record", recordId);
    if (!record) throw new ProtocolError("invalid_request", "record not found", 404);
    const preAuthorizedCode = token();
    const expiresAt = this.now() + SESSION_OFFER_TTL;
    await this.config.store.put("grant", {
      id: await hashToken(preAuthorizedCode),
      kind: "pre_authorized",
      subject: { kind: "record", recordId },
      expiresAt,
      used: false,
    });
    const offerId = token();
    await this.config.store.put("offer", {
      id: offerId,
      recordId,
      preAuthorizedCode,
      txCodeRequired: false,
      expiresAt,
    });
    return {
      offerUri: `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(`${this.config.issuer}/offers/${offerId}`)}`,
    };
  }

  async credentialOffer(offerId: string): Promise<Record<string, unknown> | undefined> {
    const offer = await this.config.store.get("offer", offerId);
    if (!offer || offer.expiresAt < this.now()) return undefined;
    const record = await this.config.store.get("record", offer.recordId);
    if (!record) return undefined;
    return {
      credential_issuer: this.config.issuer,
      credential_configuration_ids: [HIRING_CONFIG_IDS[record.type]],
      grants: {
        [PRE_AUTHORIZED_GRANT]: {
          "pre-authorized_code": offer.preAuthorizedCode,
          ...(offer.txCodeRequired
            ? {
                tx_code: {
                  input_mode: "numeric",
                  length: 6,
                  description: "The code we sent you separately",
                },
              }
            : {}),
        },
      },
    };
  }

  /**
   * Employment ended: queue every current credential INVALID (within RFC 0014's
   * 7 days) and offer a `current: false` record in its place (§5.3).
   */
  async offboard(recordId: string, end: string): Promise<{ offerUri?: string }> {
    const record = await this.config.store.get("record", recordId);
    if (record?.type !== "employment")
      throw new ProtocolError("invalid_request", "employment record not found", 404);
    await this.#revokeIssued((c) => c.subject.kind === "record" && c.subject.recordId === recordId);
    await this.putRecord({ ...record, record: { ...record.record, current: false, end } });
    return record.personalEmail ? this.offer(recordId) : {};
  }

  /** Route 3: a fresh offer goes only to the personal contact on record, never to a typed one. */
  async alumniRequest(email: string): Promise<void> {
    const key = email.trim().toLowerCase();
    const records = await this.config.store.list(
      "record",
      (r) => r.personalEmail?.toLowerCase() === key,
    );
    for (const r of records) await this.offer(r.id);
  }

  /** Marks a record's credentials INVALID (degree rescinded, license lapsed…). */
  async revokeRecord(recordId: string): Promise<number> {
    return this.#revokeIssued(
      (c) => c.subject.kind === "record" && c.subject.recordId === recordId,
    );
  }
}

function narrow(dataset: ParsedStandingMandateDataset, n: Narrowing): ParsedStandingMandateDataset {
  const keep = <T>(
    list: readonly T[],
    chosen: readonly string[] | undefined,
    key: (v: T) => string,
  ): T[] => {
    if (!chosen) return [...list];
    const out = list.filter((v) => chosen.includes(key(v)));
    if (out.length === 0) throw new ProtocolError("invalid_request", "keep at least one of each");
    return out;
  };
  const lower = <T extends number>(requested: T, chosen: number | undefined): T => {
    if (chosen === undefined) return requested;
    if (!Number.isInteger(chosen) || chosen < 1 || chosen > requested)
      throw new ProtocolError("invalid_request", "you can only lower limits");
    return chosen as T;
  };
  const out = {
    ...dataset,
    job_families: keep(dataset.job_families, n.job_families, (v) => v),
    locations: keep(dataset.locations, n.locations, (v) => JSON.stringify(v)),
    remote_policy: keep(dataset.remote_policy, n.remote_policy, (v) => v),
    actions: keep(dataset.actions, n.actions, (v) => v),
    per_employer: lower(dataset.per_employer, n.per_employer),
    applications_total: lower(dataset.applications_total, n.applications_total),
    months: lower(dataset.months, n.months),
  };
  return out;
}
