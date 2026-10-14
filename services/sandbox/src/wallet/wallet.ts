/**
 * The candidate's wallet. It collects hiring credentials over OpenID4VCI
 * (pre-authorized code with a transaction code, RFC 0014 §5.3) and presents
 * them over OpenID4VP 1.0 to the employer that asks, never to the agent
 * (RFC 0013). Before showing a request it checks who signed it: the
 * `x509_hash` client ID, the certificate chain to a CA it trusts, and that
 * responses go to the certificate's host. Responses are encrypted to the
 * verifier (`direct_post.jwt`).
 */
import {
  ALWAYS_VISIBLE,
  base64url,
  bindKey,
  type ClaimsPathQuery,
  decodeJws,
  type GeneratedSigner,
  generateSigner,
  HIRING_VCT,
  type HiringType,
  hiringTypeOf,
  isRecord,
  type JWK,
  parseSdJwt,
  presentSdJwt,
  randomBytes,
  reconstructClaims,
  selectClaimsPaths,
  signJws,
  utf8,
  verifyJws,
} from "@ojcp/credentials-core";
import { CompactEncrypt, importJWK } from "jose";
import { z } from "zod";
import type { EventBus, SandboxClock } from "../events.ts";
import { checkRequestSigner } from "../pki.ts";
import {
  APPLICATION_INFO_FORMAT,
  ApplicationInfo,
  claimLabel,
  describeValues,
  isPermittedEmploymentClaim,
  valuesAt,
} from "./claims.ts";

const PRE_AUTHORIZED = "urn:ietf:params:oauth:grant-type:pre-authorized_code";
const BATCH = 3;

const Offer = z.object({
  credential_issuer: z.url(),
  credential_configuration_ids: z.array(z.string()).min(1),
  grants: z.object({
    [PRE_AUTHORIZED]: z.object({
      "pre-authorized_code": z.string(),
      tx_code: z
        .object({ length: z.number().int().optional(), description: z.string().optional() })
        .optional(),
    }),
  }),
});
const IssuerMetadata = z.looseObject({
  credential_issuer: z.url(),
  authorization_servers: z.array(z.url()).optional(),
  credential_endpoint: z.url(),
  nonce_endpoint: z.url(),
  display: z.array(z.object({ name: z.string() })).optional(),
  credential_configurations_supported: z.record(
    z.string(),
    z.looseObject({ format: z.string(), vct: z.string().optional() }),
  ),
});
const AsMetadata = z.looseObject({ token_endpoint: z.url() });
const IssuerKeys = z.object({ jwks: z.object({ keys: z.array(z.looseObject({})) }) });

const PathQuery = z.array(z.union([z.string(), z.number().int().nonnegative(), z.null()])).min(1);
const RequestObject = z.looseObject({
  client_id: z.string(),
  response_type: z.literal("vp_token"),
  response_mode: z.literal("direct_post.jwt"),
  response_uri: z.url({ protocol: /^https$/ }),
  nonce: z.string().min(16),
  state: z.string().min(16),
  exp: z.number(),
  dcql_query: z.object({
    credentials: z
      .array(
        z.object({
          id: z.string(),
          format: z.literal("dc+sd-jwt"),
          meta: z.object({ vct_values: z.array(z.string()).min(1) }),
          claims: z.array(z.object({ path: PathQuery })).min(1),
        }),
      )
      .length(1),
  }),
  client_metadata: z.looseObject({
    jwks: z.object({
      keys: z
        .array(z.looseObject({ kty: z.literal("EC"), crv: z.literal("P-256"), kid: z.string() }))
        .min(1),
    }),
  }),
  verifier_info: z.array(z.object({ format: z.string(), data: z.unknown() })).optional(),
});

interface HeldCredential {
  compact: string;
  signer: GeneratedSigner;
  /** Hosts it has been presented to; a fresh one per verifier keeps them unlinkable. */
  presentedTo: string[];
}

export interface HeldRecord {
  id: string;
  type: HiringType;
  issuer: { origin: string; name: string };
  basis: string;
  record: Record<string, unknown>;
  holderName: string | undefined;
  addedAt: number;
  expiresAt: number;
  credentials: HeldCredential[];
}

export interface OfferPreview {
  issuer: { origin: string; name: string };
  types: string[];
  txCode: { length: number; description: string } | undefined;
}

export interface Share {
  label: string;
  value: string;
}

export interface PendingRequest {
  id: string;
  clientId: string;
  verifier: { host: string; organization: string };
  application: ApplicationInfo | undefined;
  recordId: string | undefined;
  share: Share[];
  /** What the record holds that this request leaves out. */
  withheld: string[];
  /** Claims outside RFC 0013 §5's permitted list (the wallet warns, §5). */
  warnings: string[];
  expiresAt: number;
  queryId: string;
  paths: ClaimsPathQuery[];
  responseUri: string;
  nonce: string;
  state: string;
  encryptionKey: JWK & { kid: string };
}

export interface WalletActivity {
  at: number;
  kind: "added" | "shared" | "declined";
  text: string;
}

/** Thrown with a message the candidate can read. */
export class WalletError extends Error {}

function parseOfferUri(offerUri: string): string {
  const query = offerUri.includes("?") ? offerUri.slice(offerUri.indexOf("?") + 1) : "";
  const uri = new URLSearchParams(query).get("credential_offer_uri");
  if (!uri?.startsWith("https://")) throw new WalletError("This isn't a wallet offer link.");
  return uri;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new WalletError(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

const TYPE_NAMES: Record<HiringType, string> = {
  employment: "Employment record",
  education: "Education record",
  professional_license: "Professional license",
  certification: "Certification",
};

export class SandboxWallet {
  readonly records: HeldRecord[] = [];
  readonly activity: WalletActivity[] = [];
  readonly #requests = new Map<string, PendingRequest>();
  readonly #anchors: readonly string[];
  readonly #clock: SandboxClock;
  readonly #events: EventBus;
  readonly #host: string;

  constructor(options: {
    host: string;
    /** Verifier CAs the wallet trusts for request signatures (hex SHA-256 of each CA's DER). */
    anchors: readonly string[];
    clock: SandboxClock;
    events: EventBus;
  }) {
    this.#host = options.host;
    this.#anchors = options.anchors;
    this.#clock = options.clock;
    this.#events = options.events;
  }

  #emit(outcome: "ok" | "refused" | "info", title: string, detail?: Record<string, unknown>) {
    this.#events.emit({
      actor: "wallet",
      where: this.#host,
      title,
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  // ── Collecting a record (OpenID4VCI) ───────────────────────────────────────

  async #offer(offerUri: string) {
    const offer = Offer.parse(await getJson(parseOfferUri(offerUri)));
    const metadata = IssuerMetadata.parse(
      await getJson(`${offer.credential_issuer}/.well-known/openid-credential-issuer`),
    );
    if (metadata.credential_issuer !== offer.credential_issuer)
      throw new WalletError("The issuer's metadata doesn't match the offer.");
    return { offer, metadata };
  }

  async previewOffer(offerUri: string): Promise<OfferPreview> {
    const { offer, metadata } = await this.#offer(offerUri);
    const tx = offer.grants[PRE_AUTHORIZED].tx_code;
    return {
      issuer: {
        origin: offer.credential_issuer,
        name: metadata.display?.[0]?.name ?? new URL(offer.credential_issuer).host,
      },
      types: offer.credential_configuration_ids.map((id) => {
        const vct = metadata.credential_configurations_supported[id]?.vct;
        const type = vct ? hiringTypeOf(vct) : undefined;
        return type ? TYPE_NAMES[type] : id;
      }),
      txCode: tx ? { length: tx.length ?? 6, description: tx.description ?? "" } : undefined,
    };
  }

  async acceptOffer(offerUri: string, txCode: string): Promise<HeldRecord> {
    const { offer, metadata } = await this.#offer(offerUri);
    const grant = offer.grants[PRE_AUTHORIZED];
    const configurationId = offer.credential_configuration_ids[0] as string;
    const asOrigin = metadata.authorization_servers?.[0] ?? offer.credential_issuer;
    const as = AsMetadata.parse(
      await getJson(`${asOrigin}/.well-known/oauth-authorization-server`),
    );
    const token = await fetch(as.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: PRE_AUTHORIZED,
        "pre-authorized_code": grant["pre-authorized_code"],
        ...(grant.tx_code ? { tx_code: txCode.trim() } : {}),
      }),
    });
    if (!token.ok) {
      this.#emit("refused", "The issuer refused the code for this offer");
      throw new WalletError("That code didn't work. Check the text message and try again.");
    }
    const { access_token } = z.object({ access_token: z.string() }).parse(await token.json());
    const { c_nonce } = z
      .object({ c_nonce: z.string() })
      .parse(await getJson(metadata.nonce_endpoint, { method: "POST" }));

    // One key per credential: each presentation can use a different one (RFC 0014 §4.1 item 4).
    const now = this.#clock.now();
    const signers = await Promise.all(Array.from({ length: BATCH }, () => generateSigner("ES256")));
    const proofs = await Promise.all(
      signers.map((s) =>
        signJws(
          { typ: "openid4vci-proof+jwt", jwk: s.publicJwk },
          { aud: offer.credential_issuer, iat: now, nonce: c_nonce },
          s,
        ),
      ),
    );
    const issued = z
      .object({ credentials: z.array(z.object({ credential: z.string() })).min(1) })
      .parse(
        await getJson(metadata.credential_endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
          body: JSON.stringify({
            credential_configuration_id: configurationId,
            proofs: { jwt: proofs },
          }),
        }),
      );

    // Check each credential against the issuer's published keys before keeping it.
    const keys = IssuerKeys.parse(
      await getJson(`${offer.credential_issuer}/.well-known/jwt-vc-issuer`),
    ).jwks.keys as JWK[];
    let claims: Record<string, unknown> = {};
    for (const { credential } of issued.credentials) {
      const parsed = await parseSdJwt(credential);
      const verified = await Promise.any(keys.map((k) => verifyJws(parsed.jwt, k))).catch(() => {
        throw new WalletError("The record's signature didn't match the issuer's published key.");
      });
      if (verified.payload.iss !== offer.credential_issuer)
        throw new WalletError("The record names a different issuer.");
      claims = reconstructClaims(parsed.payload, parsed.disclosures).claims;
    }
    const type = hiringTypeOf(String(claims.vct));
    if (!type) throw new WalletError("This wallet doesn't know that kind of record.");
    const ENVELOPE = new Set([...ALWAYS_VISIBLE, "given_name", "family_name", "nbf", "_sd_alg"]);
    const { given_name, family_name } = claims;
    const held: HeldRecord = {
      id: base64url(randomBytes(6)),
      type,
      issuer: {
        origin: offer.credential_issuer,
        name: metadata.display?.[0]?.name ?? new URL(offer.credential_issuer).host,
      },
      basis: String(claims.basis),
      record: Object.fromEntries(Object.entries(claims).filter(([k]) => !ENVELOPE.has(k))),
      holderName:
        typeof given_name === "string"
          ? `${given_name} ${String(family_name ?? "")}`.trim()
          : undefined,
      addedAt: now,
      expiresAt: Number(claims.exp),
      credentials: issued.credentials.map((c, i) => ({
        compact: c.credential,
        signer: signers[i] as GeneratedSigner,
        presentedTo: [],
      })),
    };
    this.records.push(held);
    const org = isRecord(held.record.organization) ? String(held.record.organization.name) : "";
    this.activity.unshift({
      at: now,
      kind: "added",
      text: `Added your ${TYPE_NAMES[type].toLowerCase()}${org ? ` from ${org}` : ""}, issued by ${held.issuer.name}`,
    });
    this.#emit(
      "ok",
      `Wallet redeemed the offer (pre-authorized code + code from the text) and stored ${issued.credentials.length} copies, each bound to its own key`,
      { issuer: offer.credential_issuer, vct: HIRING_VCT[type], basis: held.basis },
    );
    return held;
  }

  // ── Presenting (OpenID4VP) ──────────────────────────────────────────────────

  /** Fetches and checks a request; the result is what the consent screen shows. */
  async openRequest(clientId: string, requestUri: string): Promise<PendingRequest> {
    const now = this.#clock.now();
    const response = await fetch(requestUri);
    if (!response.ok)
      throw new WalletError("This request has expired. Start again from the employer's page.");
    const jwt = await response.text();
    const { header } = decodeJws(jwt);
    const x5c = Array.isArray(header.x5c) ? header.x5c.map(String) : [];
    const signer = await checkRequestSigner(x5c, clientId, this.#anchors, now);
    if (!signer) {
      this.#emit(
        "refused",
        "Wallet refused a request: its signer isn't a verifier this wallet trusts",
      );
      throw new WalletError(
        "This wallet couldn't confirm who is asking, so it won't show the request.",
      );
    }
    const payload = RequestObject.parse((await verifyJws(jwt, signer.jwk)).payload);
    const responseHost = new URL(payload.response_uri).hostname;
    if (payload.client_id !== clientId || !signer.dnsNames.includes(responseHost))
      throw new WalletError("The request's details don't match who signed it.");
    if (payload.exp < now)
      throw new WalletError("This request has expired. Start again from the employer's page.");

    const query = payload.dcql_query.credentials[0] as z.infer<
      typeof RequestObject
    >["dcql_query"]["credentials"][number];
    const paths = query.claims.map((c) => c.path as ClaimsPathQuery);
    const record = this.records.find((r) => query.meta.vct_values.includes(HIRING_VCT[r.type]));
    const info = payload.verifier_info?.find((v) => v.format === APPLICATION_INFO_FORMAT);
    const application = info ? ApplicationInfo.safeParse(info.data) : undefined;
    const requested = new Set(paths.map((p) => claimLabel(p)));
    const holderView = record ? { ...record.record } : {};
    const pending: PendingRequest = {
      id: base64url(randomBytes(9)),
      clientId,
      verifier: { host: responseHost, organization: signer.organization ?? responseHost },
      application: application?.success ? application.data : undefined,
      recordId: record?.id,
      share: paths.map((p) => ({
        label: claimLabel(p),
        value: describeValues(valuesAt(holderView, p)),
      })),
      withheld: record
        ? Object.keys(record.record)
            .map((k) => claimLabel([k]))
            .filter((l) => !requested.has(l) && !l.startsWith("Job history"))
        : [],
      warnings: paths.filter((p) => !isPermittedEmploymentClaim(p)).map((p) => claimLabel(p)),
      expiresAt: payload.exp,
      queryId: query.id,
      paths,
      responseUri: payload.response_uri,
      nonce: payload.nonce,
      state: payload.state,
      encryptionKey: payload.client_metadata.jwks.keys[0] as JWK & { kid: string },
    };
    this.#requests.set(pending.id, pending);
    this.#emit(
      "info",
      `Wallet checked a request from ${responseHost}: signed under a trusted verifier certificate for that host (${signer.organization ?? "no organization"})`,
      { client_id: clientId, asks_for: pending.share.map((s) => s.label) },
    );
    return pending;
  }

  request(id: string): PendingRequest | undefined {
    return this.#requests.get(id);
  }

  /** Shares or declines. Returns where the verifier sends the candidate next. */
  async respond(id: string, decision: "share" | "decline"): Promise<string | undefined> {
    const request = this.#requests.get(id);
    if (!request) throw new WalletError("This request is no longer open.");
    this.#requests.delete(id);
    const now = this.#clock.now();
    let body: URLSearchParams;
    if (decision === "decline") {
      body = new URLSearchParams({ error: "access_denied", state: request.state });
    } else {
      const record = this.records.find((r) => r.id === request.recordId);
      if (!record) throw new WalletError("You don't have a record this employer accepts.");
      const credential =
        record.credentials.find((c) => !c.presentedTo.includes(request.verifier.host)) ??
        (record.credentials[0] as HeldCredential);
      credential.presentedTo.push(request.verifier.host);
      const presentation = await bindKey(
        await presentSdJwt(credential.compact, selectClaimsPaths(request.paths)),
        { aud: request.clientId, nonce: request.nonce, iat: now },
        credential.signer,
      );
      const jwe = await new CompactEncrypt(
        utf8(
          JSON.stringify({ vp_token: { [request.queryId]: [presentation] }, state: request.state }),
        ),
      )
        .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM", kid: request.encryptionKey.kid })
        .encrypt(await importJWK(request.encryptionKey, "ECDH-ES"));
      body = new URLSearchParams({ response: jwe });
    }
    const response = await fetch(request.responseUri, { method: "POST", body });
    const answer = z
      .object({ redirect_uri: z.url().optional() })
      .safeParse(await response.json().catch(() => ({})));
    const who = request.application?.employer ?? request.verifier.organization;
    this.activity.unshift(
      decision === "share"
        ? {
            at: now,
            kind: "shared",
            text: `Shared with ${who} (${request.verifier.host}): ${request.share.map((s) => s.label.toLowerCase()).join(", ")}`,
          }
        : { at: now, kind: "declined", text: `Declined a request from ${who}` },
    );
    this.#emit(
      decision === "share" ? "ok" : "info",
      decision === "share"
        ? `Wallet sent an encrypted presentation to ${request.verifier.host} with only the requested claims, bound to its nonce and client ID`
        : `Candidate declined ${request.verifier.host}'s request in the wallet`,
      decision === "share" ? { disclosed: request.share.map((s) => s.label) } : undefined,
    );
    return answer.success ? answer.data.redirect_uri : undefined;
  }

  summary() {
    return {
      records: this.records.map((r) => ({
        id: r.id,
        type: TYPE_NAMES[r.type],
        issuer: r.issuer,
        basis: r.basis,
        holderName: r.holderName,
        record: r.record,
        addedAt: r.addedAt,
        expiresAt: r.expiresAt,
        copies: r.credentials.length,
      })),
      activity: this.activity,
    };
  }
}
