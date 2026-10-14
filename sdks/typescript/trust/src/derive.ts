/**
 * Effective trust tier derivation (RFC 0010 §5.2), in order:
 *   1. validate the manifest and its key certificate;
 *   2. derive the organization identifier and identity key;
 *   3. check stapled attestations locally (no attester fetch before this);
 *   4. establish status, staples first, at most 8 fetches in 5 seconds;
 *   5. apply the thresholds, and tenure for `audited`.
 */
import { isRecord } from "@ojcp/credentials-core";
import { z } from "zod";
import {
  type Attestation,
  checkAttestation,
  isIdentityType,
  type Rejection,
  Staple,
} from "./attestation.ts";
import { BudgetedFetcher, type FetchLike } from "./fetcher.ts";
import { OjcpKeySet, organizationId } from "./identity.ts";
import { certifiedManifest } from "./manifest.ts";
import { attestationStatus } from "./status.ts";
import type { TrustLists } from "./trust-list.ts";

export type TrustTier = "unverified" | "verified" | "audited";

const TENURE = 90 * 86_400;
const UNVERIFIED_CACHE = 300;

/** Key history from RFC 0011. Without a log policy the agent knows no predecessors and no tenure. */
export interface KeyLineage {
  /** Identity-key thumbprints linked to `current` by a logged successor chain. */
  predecessors(subject: string, current: string): Promise<string[]>;
  /** Authenticated first-seen time of the lineage's genesis, under the agent's log and witness policy. */
  genesisFirstSeen(subject: string, current: string): Promise<number | undefined>;
}

export const NO_LINEAGE: KeyLineage = {
  predecessors: async () => [],
  genesisFirstSeen: async () => undefined,
};

/** The agent's own record of when it first accepted each attestation (§4.1 `distrust_after`). */
export interface AcceptanceLog {
  firstAccepted(digest: string): Promise<number | undefined>;
  record(digest: string, at: number): Promise<void>;
}

export class InMemoryAcceptanceLog implements AcceptanceLog {
  readonly #seen = new Map<string, number>();
  async firstAccepted(digest: string): Promise<number | undefined> {
    return this.#seen.get(digest);
  }
  async record(digest: string, at: number): Promise<void> {
    if (!this.#seen.has(digest)) this.#seen.set(digest, at);
  }
}

export interface DerivationOptions {
  lists: TrustLists;
  fetch: FetchLike;
  lineage?: KeyLineage;
  acceptance?: AcceptanceLog;
  /** Operators that must agree for `verified`. Default 2; 1 needs `allowSingleOperator`. */
  identityThreshold?: number;
  allowSingleOperator?: boolean;
  /** During migration (§10), `listing-tenure` attestations count as tenure. */
  migration?: boolean;
  now?: () => number;
}

export interface LegalEntity {
  legal_name: string;
  jurisdiction: string;
  lei?: string;
  registration_number?: string;
}

export interface HostedEmployer {
  legal_name: string;
  jurisdiction: string;
  employer?: string;
  employer_id?: string;
}

export interface DerivedTier {
  tier: TrustTier;
  origin: string;
  subject?: string;
  entity?: LegalEntity;
  /** Operators whose identity attestations agreed. */
  operators: string[];
  /** True when the operator lowered the threshold to one: show it with the tier (§4.3). */
  weakerPolicy: boolean;
  /** Accepted `hosted-employer` attestations (display only, §3.5). */
  hostedEmployers: HostedEmployer[];
  /** The tier may be cached until then and no longer (§5.2). */
  validUntil: number;
  /** Why the tier isn't higher, for logs. */
  notes: string[];
  rejected: Array<{ index: number; reason: Rejection }>;
}

const fold = (s: string) => s.normalize("NFKC").toLocaleLowerCase("und").normalize("NFKC");

function claimString(a: Attestation, key: string): string | undefined {
  const value = a.claims[key];
  return typeof value === "string" ? value : undefined;
}

interface Counted {
  attestation: Attestation;
  until: number;
}

function entityOf(a: Attestation): LegalEntity {
  const s = (k: string) => claimString(a, k);
  const lei = s("lei");
  const reg = s("registration_number");
  return {
    legal_name: s("legal_name") ?? "",
    jurisdiction: s("jurisdiction") ?? "",
    ...(lei ? { lei } : {}),
    ...(reg ? { registration_number: reg } : {}),
  };
}

/** §4.3: identity attestations must agree; if any two disagree, none count. */
function agreedEntity(entities: LegalEntity[]): LegalEntity | undefined {
  const [first] = entities;
  if (!first) return undefined;
  for (const e of entities) {
    if (fold(e.legal_name) !== fold(first.legal_name) || e.jurisdiction !== first.jurisdiction)
      return undefined;
    for (const other of entities) {
      if (e.lei && other.lei && e.lei !== other.lei) return undefined;
      if (
        e.registration_number &&
        other.registration_number &&
        e.registration_number !== other.registration_number
      )
        return undefined;
    }
  }
  const lei = entities.find((e) => e.lei)?.lei;
  const reg = entities.find((e) => e.registration_number)?.registration_number;
  return {
    legal_name: first.legal_name,
    jurisdiction: first.jurisdiction,
    ...(lei ? { lei } : {}),
    ...(reg ? { registration_number: reg } : {}),
  };
}

function seconds(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
  }
  return undefined;
}

const ManifestTrust = z.looseObject({
  trust: z.looseObject({ attestations_uri: z.url() }).optional(),
});

export async function deriveTier(origin: string, options: DerivationOptions): Promise<DerivedTier> {
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const url = new URL(origin);
  const result: DerivedTier = {
    tier: "unverified",
    origin: url.origin,
    operators: [],
    weakerPolicy: false,
    hostedEmployers: [],
    validUntil: now + UNVERIFIED_CACHE,
    notes: [],
    rejected: [],
  };
  const threshold = options.identityThreshold ?? 2;
  if (threshold < 1 || (threshold < 2 && !options.allowSingleOperator))
    throw new RangeError("a threshold of one needs allowSingleOperator");
  result.weakerPolicy = threshold < 2;

  // Steps 1–2: the provider's own origin.
  const own = new BudgetedFetcher(options.fetch, { maxFetches: 3, timeoutMs: 5000 });
  const json = async (path: string, accept: string): Promise<unknown> => {
    const text = await own.text(new URL(path, url.origin).toString(), accept);
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const manifest = await json("/.well-known/ojcp.json", "application/json");
  const keySet = OjcpKeySet.safeParse(
    await json("/.well-known/ojcp-keys.json", "application/jwk-set+json"),
  );
  if (!isRecord(manifest) || !keySet.success) {
    result.notes.push("manifest or key set unavailable");
    return result;
  }
  const certified = await certifiedManifest(manifest, url.origin, keySet.data, now);
  if (!certified) {
    result.notes.push("manifest unsigned, invalid, or its key lacks a valid ojcp_cert");
    return result;
  }
  const subject = organizationId(url.origin) as string;
  result.subject = subject;
  const lineage = options.lineage ?? NO_LINEAGE;
  const keys = [
    certified.identity.thumbprint,
    ...(await lineage.predecessors(subject, certified.identity.thumbprint)),
  ];

  // Step 3: stapled attestations, checked locally.
  const trust = ManifestTrust.safeParse(manifest);
  const stapleUri = trust.success ? trust.data.trust?.attestations_uri : undefined;
  if (!stapleUri || new URL(stapleUri).origin !== url.origin) {
    result.notes.push("no attestations published on the manifest origin");
    result.validUntil = Math.min(certified.validUntil, now + UNVERIFIED_CACHE);
    return result;
  }
  let staple: Staple | undefined;
  try {
    const raw = await own.text(stapleUri, "application/json");
    const parsed = raw === undefined ? undefined : Staple.safeParse(JSON.parse(raw));
    staple = parsed?.success ? parsed.data : undefined;
  } catch {
    staple = undefined;
  }
  if (!staple) {
    result.notes.push("attestation staple unavailable or malformed");
    return result;
  }
  const acceptance = options.acceptance ?? new InMemoryAcceptanceLog();
  const binding = { subject, keys, host: url.hostname.toLowerCase() };
  const survivors: Attestation[] = [];
  for (const [index, compact] of staple.attestations.entries()) {
    const checked = await checkAttestation(compact, {
      lists: options.lists,
      binding,
      now,
      firstAccepted: (d) => acceptance.firstAccepted(d),
    });
    if (typeof checked === "string") result.rejected.push({ index, reason: checked });
    else if (checked.relationship === "none") survivors.push(checked);
    else
      result.notes.push(
        `${checked.type} from ${checked.iss} has relationship ${checked.relationship}; not counted`,
      );
  }

  // Step 4: status, only for issuers that passed step 3.
  const attesters = new BudgetedFetcher(options.fetch, { maxFetches: 8, timeoutMs: 5000 });
  const counted: Counted[] = [];
  for (const attestation of survivors) {
    const status = await attestationStatus(attestation, {
      stapled: staple.status_tokens,
      fetcher: attesters,
      now,
    });
    if (status.state === "valid") {
      counted.push({ attestation, until: Math.min(status.until, attestation.exp) });
      await acceptance.record(attestation.digest, now);
    } else result.notes.push(`${attestation.type} from ${attestation.iss}: status ${status.state}`);
  }

  // Step 5: thresholds.
  const identity = counted.filter((c) => isIdentityType(c.attestation.type));
  const entity = agreedEntity(identity.map((c) => entityOf(c.attestation)));
  const operators = [
    ...new Set(identity.map((c) => options.lists.operatorOf(c.attestation.grant.id))),
  ];
  const validUntil = (inputs: Array<{ until: number }>) =>
    Math.min(
      certified.validUntil,
      options.lists.validUntil(now) ?? now,
      ...inputs.map((i) => i.until),
    );
  if (identity.length > 0 && !entity)
    result.notes.push("identity attestations disagree; none count");
  if (!entity || operators.length < threshold) {
    if (entity)
      result.notes.push(
        `identity attested by ${operators.length} operator(s); ${threshold} needed`,
      );
    result.validUntil = Math.min(certified.validUntil, now + UNVERIFIED_CACHE);
    return result;
  }
  result.tier = "verified";
  result.entity = entity;
  result.operators = operators;
  result.hostedEmployers = counted
    .filter((c) => c.attestation.type === "hosted_employer")
    .map(({ attestation: a }) => {
      const s = (k: string) => claimString(a, k);
      const employer = s("employer");
      const employerId = s("employer_id");
      return {
        legal_name: s("employer_legal_name") ?? "",
        jurisdiction: s("employer_jurisdiction") ?? "",
        ...(employer ? { employer } : {}),
        ...(employerId ? { employer_id: employerId } : {}),
      };
    });
  const used = [...identity];

  const conformance = counted.find((c) => c.attestation.type === "conformance");
  const review = counted.find((c) => c.attestation.type === "security_review");
  let tenureFrom = await lineage.genesisFirstSeen(subject, certified.identity.thumbprint);
  let tenureInput: Counted | undefined;
  if (tenureFrom === undefined && options.migration) {
    const listing = counted.find((c) => c.attestation.type === "listing_tenure");
    const since = seconds(listing?.attestation.claims.listed_since);
    if (listing && since !== undefined) {
      tenureFrom = since;
      tenureInput = listing;
    }
  }
  if (conformance && review && tenureFrom !== undefined && now - tenureFrom >= TENURE) {
    result.tier = "audited";
    used.push(conformance, review, ...(tenureInput ? [tenureInput] : []));
  } else if (!conformance || !review)
    result.notes.push("audited needs accepted conformance and security-review attestations");
  else result.notes.push("audited needs 90 days of identity-key tenure");
  result.validUntil = validUntil(used);
  return result;
}
