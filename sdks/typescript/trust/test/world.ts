/** Providers, attesters and list publishers on a simulated web, at a fixed time. */
import {
  type GeneratedSigner,
  generateSigner,
  type JWK,
  OjcpStatusList,
  type Signer,
  type StatusValue,
  signStatusListToken,
  thumbprint,
} from "@ojcp/credentials-core";
import {
  ATTESTATION_TYPES,
  type AttestationInput,
  type AttestationType,
  issueAttestation,
} from "../src/attestation.ts";
import { organizationId, signKeyCertificate } from "../src/identity.ts";
import { signManifest } from "../src/manifest.ts";
import { signTrustList, type TrustListPayload } from "../src/trust-list.ts";

export const NOW = 1_791_892_800; // 2026-10-13T12:00:00Z
export const DAY = 86_400;

export class Web {
  readonly routes = new Map<string, () => Response>();
  readonly log: string[] = [];
  readonly fetch = async (url: string): Promise<Response> => {
    this.log.push(url);
    const route = this.routes.get(url);
    return route ? route() : new Response("not found", { status: 404 });
  };
  json(url: string, value: unknown): void {
    this.routes.set(url, () => Response.json(value));
  }
  text(url: string, value: string): void {
    this.routes.set(url, () => new Response(value));
  }
}

export interface Provider {
  origin: string;
  subject: string;
  identity: GeneratedSigner;
  identityThumbprint: string;
  staple(attestations: string[], statusTokens?: string[]): void;
}

export async function provider(
  web: Web,
  origin: string,
  options: {
    identity?: GeneratedSigner;
    cert?: { sub?: string; purposes?: Array<"manifest" | "posting">; exp?: number };
    extraIdentity?: boolean;
  } = {},
): Promise<Provider> {
  const identity = options.identity ?? (await generateSigner("ES256"));
  const manifestKey = await generateSigner("ES256");
  const subject = organizationId(origin) as string;
  const cert = await signKeyCertificate(identity, {
    sub: options.cert?.sub ?? subject,
    key: manifestKey.publicJwk,
    purposes: options.cert?.purposes ?? ["manifest"],
    iat: NOW - DAY,
    exp: options.cert?.exp ?? NOW + 90 * DAY,
  });
  const keys: Array<Record<string, unknown>> = [
    { ...identity.publicJwk, kid: "identity", alg: "ES256", ojcp_role: "identity" },
    { ...manifestKey.publicJwk, kid: "manifest-2026", alg: "ES256", ojcp_cert: cert },
  ];
  if (options.extraIdentity)
    keys.push({
      ...(await generateSigner("ES256")).publicJwk,
      kid: "identity-2",
      alg: "ES256",
      ojcp_role: "identity",
    });
  web.json(`${origin}/.well-known/ojcp-keys.json`, { keys });
  const host = new URL(origin).host;
  const manifest = await signManifest(
    {
      ojcp_version: "0.4",
      provider: { name: "Acme Careers" },
      tools: ["search_jobs", "begin_application", "submit_application"],
      trust: { attestations_uri: `${origin}/.well-known/ojcp-attestations.json` },
    },
    manifestKey,
    {
      kid: "manifest-2026",
      iss: host,
      signedAt: new Date((NOW - 3600) * 1000),
      expiresAt: new Date((NOW + 20 * 3600) * 1000),
    },
  );
  web.json(`${origin}/.well-known/ojcp.json`, manifest);
  return {
    origin,
    subject,
    identity,
    identityThumbprint: await thumbprint(identity.publicJwk),
    staple(attestations, statusTokens = []) {
      web.json(`${origin}/.well-known/ojcp-attestations.json`, {
        attestations,
        status_tokens: statusTokens,
        issuer_jwks: {},
      });
    },
  };
}

export interface Attester {
  id: string;
  operator: string;
  signer: Signer;
  statusUri: string;
  list: OjcpStatusList;
  issue(
    type: AttestationType,
    subject: Provider | { subject: string; identityThumbprint: string },
    overrides?: Partial<AttestationInput> & { idx?: number },
  ): Promise<string>;
  setStatus(idx: number, value: StatusValue): void;
  statusToken(options?: { iat?: number; signer?: Signer }): Promise<string>;
  entry(vct?: AttestationType[]): TrustListPayload["attesters"][number];
}

const CLAIMS: Record<AttestationType, Record<string, unknown>> = {
  domain_control: { method: "dns-01", checked_at: "2026-10-01" },
  legal_entity: {
    legal_name: "Acme Corporation",
    jurisdiction: "US-DE",
    lei: "5493001KJTIIGC8Y1R12",
    checked_at: "2026-10-01",
  },
  business_registration: {
    legal_name: "ACME CORPORATION",
    jurisdiction: "US-DE",
    registry: "Delaware Division of Corporations",
    registration_number: "1234567",
    registration_status: "active",
    checked_at: "2026-10-01",
  },
  hosted_employer: {
    employer_legal_name: "Globex Corporation",
    employer_jurisdiction: "US-NY",
    employer_id: "globex",
    checked_at: "2026-10-01",
  },
  conformance: { suite_version: "0.3.0", ojcp_version: "0.3" },
  security_review: { scope: "key handling and PII flows" },
  listing_tenure: { listed_since: "2025-01-01T00:00:00Z", index: "https://registry.example" },
};

export async function attester(
  web: Web,
  id: string,
  operator: string,
  signer?: Signer,
): Promise<Attester> {
  const s = signer ?? (await generateSigner("ES256"));
  const statusUri = `${id}/status/1`;
  const list = OjcpStatusList.create();
  let next = 100;
  const a: Attester = {
    id,
    operator,
    signer: s,
    statusUri,
    list,
    async issue(type, subject, overrides = {}) {
      const { idx, ...rest } = overrides;
      const lifetime = Math.min(ATTESTATION_TYPES[type].maxLifetime, 60 * DAY);
      return issueAttestation(s, {
        iss: id,
        sub: subject.subject,
        type,
        identityKeyThumbprint: subject.identityThumbprint,
        iat: NOW - DAY,
        exp: NOW - DAY + lifetime,
        status: { idx: idx ?? next++, uri: statusUri },
        relationship: "none",
        claims: CLAIMS[type],
        ...rest,
      });
    },
    setStatus(idx, value) {
      list.set(idx, value);
    },
    statusToken(options = {}) {
      return signStatusListToken({
        uri: statusUri,
        list,
        signer: options.signer ?? s,
        ttl: 12 * 3600,
        lifetime: 2 * DAY,
        now: new Date((options.iat ?? NOW - 600) * 1000),
      });
    },
    entry(
      vct = [
        "legal_entity",
        "business_registration",
        "hosted_employer",
        "conformance",
        "security_review",
        "listing_tenure",
      ],
    ) {
      return {
        id,
        operator,
        vct: vct.map((t) => ATTESTATION_TYPES[t].vct),
        jwks: { keys: [{ ...(s.publicJwk as JWK) }] },
      };
    },
  };
  web.routes.set(statusUri, () => new Response("pending"));
  return a;
}

/** Serves the attester's current status token at its URI. */
export async function serveStatus(web: Web, a: Attester): Promise<string> {
  const token = await a.statusToken();
  web.text(a.statusUri, token);
  return token;
}

export async function publisher(name: string): Promise<{
  name: string;
  signer: GeneratedSigner;
  pin: string;
  sign(payload: Partial<TrustListPayload> & Pick<TrustListPayload, "attesters">): Promise<string>;
}> {
  const signer = await generateSigner("ES256");
  return {
    name,
    signer,
    pin: await thumbprint(signer.publicJwk),
    sign: (payload) =>
      signTrustList(signer, {
        publisher: `https://${name}`,
        iat: NOW - 3600,
        exp: NOW + 6 * DAY,
        ...payload,
      }),
  };
}
