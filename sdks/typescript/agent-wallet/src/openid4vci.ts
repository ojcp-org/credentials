/**
 * Obtaining standing-mandate batches over OpenID4VCI 1.0 (RFC 0008 §3): the
 * agent proposes the mandate in `authorization_details`, the user approves at
 * the issuer, and the agent receives a batch bound to its mandate keys.
 */
import { base64url, randomBytes, randomInt, sha256, signJws } from "@ojcp/credentials-core";
import { z } from "zod";
import type { AgentKeyring, MandateKey } from "./keyring.ts";
import type { HeldBatch, StandingMandateHolder } from "./standing.ts";

export const STANDING_MANDATE_CONFIGURATION = "ojcp_standing_mandate";

/** The `ojcp_standing_mandate` proposal (RFC 0008 §3.1). */
export interface StandingMandateProposal {
  candidate: Array<{ email: string } | { phone: string }>;
  scope: {
    job_families: string[];
    locations: Array<{ addressCountry: string; addressRegion?: string } | { anywhere: true }>;
    remote_policy: string[];
    employment_type?: string[];
    experience_level?: string[];
    salary_floor?: {
      value: number;
      currency: string;
      unitText: "HOUR" | "WEEK" | "MONTH" | "YEAR";
    };
    include_unstated_salary?: boolean;
  };
  per_employer: 1 | 2 | 3;
  applications_total: number;
  actions: string[];
  prohibited?: string[];
  consent_scope: string;
  provider_trust_floor: "verified" | "audited";
  months: 1 | 2 | 3;
}

const IssuerMetadata = z.looseObject({
  credential_issuer: z.string(),
  credential_endpoint: z.url(),
  nonce_endpoint: z.url(),
  authorization_servers: z.array(z.url()).optional(),
  batch_credential_issuance: z.looseObject({ batch_size: z.number().int().positive() }).optional(),
});
const AsMetadata = z.looseObject({ authorization_endpoint: z.url(), token_endpoint: z.url() });
const TokenResponse = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  authorization_details: z
    .array(
      z.looseObject({
        credential_configuration_id: z.string(),
        credential_identifiers: z.array(z.string()).min(1),
        ojcp_standing_mandate: z
          .looseObject({
            applications_total: z.number().int().positive(),
            salary_floor: z
              .strictObject({ value: z.number(), currency: z.string(), unitText: z.string() })
              .optional(),
            nbf: z.number().int(),
            exp: z.number().int(),
          })
          .optional(),
      }),
    )
    .length(1),
});
const CredentialResponse = z.looseObject({
  credentials: z.array(z.looseObject({ credential: z.string() })).min(1),
});

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

async function json<T>(schema: z.ZodType<T>, response: Response, what: string): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${what} failed (${response.status}): ${JSON.stringify(body)}`);
  return schema.parse(body);
}

async function discover(issuer: string, fetchFn: FetchLike) {
  const metadata = await json(
    IssuerMetadata,
    await fetchFn(new URL("/.well-known/openid-credential-issuer", issuer)),
    "issuer metadata",
  );
  const as = metadata.authorization_servers?.[0] ?? metadata.credential_issuer;
  const asMetadata = await json(
    AsMetadata,
    await fetchFn(new URL("/.well-known/oauth-authorization-server", as)),
    "authorization server metadata",
  );
  return { metadata, asMetadata };
}

export interface AuthorizationStart {
  /** Send the user here; the issuer renders consent. */
  url: string;
  state: string;
  /** Keep until the redirect returns; never send it anywhere else. */
  codeVerifier: string;
}

export async function beginStandingMandate(options: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  proposal: StandingMandateProposal;
  fetch?: FetchLike;
}): Promise<AuthorizationStart> {
  const { asMetadata } = await discover(options.issuer, options.fetch ?? fetch);
  const codeVerifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const url = new URL(asMetadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", base64url(await sha256(codeVerifier)));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set(
    "authorization_details",
    JSON.stringify([
      {
        type: "openid_credential",
        credential_configuration_id: STANDING_MANDATE_CONFIGURATION,
        ojcp_standing_mandate: options.proposal,
      },
    ]),
  );
  return { url: url.toString(), state, codeVerifier };
}

interface Exchange {
  issuer: string;
  clientId: string;
  keyring: AgentKeyring;
  holder: StandingMandateHolder;
  fetch?: FetchLike;
  now?: () => number;
}

export interface ObtainedBatch {
  batch: HeldBatch;
  /** Keep to refresh the batch without the user (RFC 0008 §7.3). */
  refreshToken?: string;
}

/** Exchanges the authorization code and receives the first batch. */
export async function completeStandingMandate(
  options: Exchange & { redirectUri: string; code: string; codeVerifier: string },
): Promise<ObtainedBatch> {
  return obtain(options, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    client_id: options.clientId,
  });
}

/** Replaces a batch on the same terms, onto fresh keys (RFC 0008 §7.3). */
export async function refreshStandingMandate(
  options: Exchange & { refreshToken: string },
): Promise<ObtainedBatch> {
  const obtained = await obtain(options, {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });
  return { batch: obtained.batch, refreshToken: options.refreshToken };
}

async function obtain(options: Exchange, form: Record<string, string>): Promise<ObtainedBatch> {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const { metadata, asMetadata } = await discover(options.issuer, fetchFn);
  const token = await json(
    TokenResponse,
    await fetchFn(asMetadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }),
    "token request",
  );
  const [detail] = token.authorization_details;
  const terms = detail?.ojcp_standing_mandate;
  if (detail?.credential_configuration_id !== STANDING_MANDATE_CONFIGURATION || !terms)
    throw new Error("issuer did not grant a standing mandate");

  // One distinct key per credential, a random subset of the eligible set (RFC 0008 §3.4).
  const eligible = options.keyring.eligibleMandateKeys(terms.exp, now);
  const size = Math.min(metadata.batch_credential_issuance?.batch_size ?? 1, eligible.length);
  if (size === 0)
    throw new Error("no mandate key is eligible: keys must be published 7 days and valid past exp");
  const chosen: MandateKey[] = [];
  const pool = [...eligible];
  while (chosen.length < size) chosen.push(pool.splice(randomInt(pool.length), 1)[0] as MandateKey);

  const { c_nonce } = await json(
    z.object({ c_nonce: z.string() }),
    await fetchFn(metadata.nonce_endpoint, { method: "POST" }),
    "nonce request",
  );
  const proofs = await Promise.all(
    chosen.map((key) =>
      signJws(
        { typ: "openid4vci-proof+jwt", jwk: key.signer.publicJwk },
        { aud: metadata.credential_issuer, iat: now, nonce: c_nonce, iss: options.clientId },
        key.signer,
      ),
    ),
  );
  const response = await json(
    CredentialResponse,
    await fetchFn(metadata.credential_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({
        credential_identifier: detail.credential_identifiers[0],
        proofs: { jwt: proofs },
      }),
    }),
    "credential request",
  );
  const batch = await options.holder.addBatch({
    id: detail.credential_identifiers[0] as string,
    terms: {
      applications_total: terms.applications_total,
      ...(terms.salary_floor ? { salary_floor: terms.salary_floor } : {}),
    },
    credentials: response.credentials.map((c) => c.credential),
  });
  return token.refresh_token ? { batch, refreshToken: token.refresh_token } : { batch };
}
