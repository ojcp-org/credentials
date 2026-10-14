/**
 * Trust lists (RFC 0010 §4): signed by a key the agent's operator pinned,
 * ordered by `iat`, at most 7 days long. Grants lapse with the list; distrust
 * stays in force until a newer list from the same publisher removes it.
 */
import {
  decodeJws,
  type JWK,
  publicPart,
  type Signer,
  signJws,
  thumbprint,
  verifyJws,
} from "@ojcp/credentials-core";
import { z } from "zod";
import type { X509Anchor } from "./x509.ts";

export const TRUST_LIST_TYP = "https://spec.ojcp.dev/vct/trust-list/v1";
const MAX_LIST_LIFETIME = 7 * 86_400;
const FUTURE_SKEW = 300;

const Entry = z.looseObject({
  id: z.string(),
  operator: z.string(),
  vct: z.array(z.string()).min(1),
  jwks: z.looseObject({ keys: z.array(z.record(z.string(), z.unknown())) }).optional(),
  x509: z
    .array(
      z.strictObject({ anchor_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/), san_uri: z.string() }),
    )
    .optional(),
});
const Distrust = z.looseObject({
  id: z.string().optional(),
  keys: z.array(z.string()).optional(),
  spki_sha256: z.array(z.string()).optional(),
  distrust_after: z.iso.datetime({ offset: true }).optional(),
  reason_uri: z.string().optional(),
});
export const TrustListPayload = z.looseObject({
  publisher: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  policy_uri: z.string().optional(),
  appeals_uri: z.string().optional(),
  next_keys: z.array(z.string()).default([]),
  attesters: z.array(Entry),
  logs: z.array(z.unknown()).optional(),
  witnesses: z.array(z.unknown()).optional(),
  witness_quorum: z.number().int().optional(),
  distrusted: z.array(Distrust).default([]),
});
export type TrustListPayload = z.input<typeof TrustListPayload>;
type ParsedList = z.output<typeof TrustListPayload>;

export interface PublisherConfig {
  /** A label for display; identity comes from the pinned keys, never the name. */
  name: string;
  /** RFC 7638 thumbprints of the publisher's signing keys. */
  pins: readonly string[];
}

export interface AttesterGrant {
  id: string;
  operator: string;
  vct: readonly string[];
  jwks: JWK[];
  x509: X509Anchor[];
  publisher: string;
}

export type ListRejection =
  | "unpinned_key"
  | "malformed"
  | "older_than_accepted"
  | "future_iat"
  | "too_long";

interface PublisherState {
  config: PublisherConfig;
  pins: Set<string>;
  newestIat?: number;
  list?: ParsedList;
}

export class TrustLists {
  readonly #publishers: PublisherState[];

  constructor(publishers: readonly PublisherConfig[]) {
    this.#publishers = publishers.map((config) => ({ config, pins: new Set(config.pins) }));
  }

  /** Validates and stores a list from any mirror (§4.2). The signing key travels in the JWS header `jwk`. */
  async accept(token: string, now: number): Promise<"accepted" | ListRejection> {
    let header: Record<string, unknown>;
    try {
      header = decodeJws(token).header;
    } catch {
      return "malformed";
    }
    if (header.typ !== TRUST_LIST_TYP || typeof header.jwk !== "object" || header.jwk === null)
      return "malformed";
    const jwk = publicPart(header.jwk as JWK);
    const tp = await thumbprint(jwk);
    const publisher = this.#publishers.find((p) => p.pins.has(tp));
    if (!publisher) return "unpinned_key";
    let payload: unknown;
    try {
      payload = (await verifyJws(token, jwk)).payload;
    } catch {
      return "unpinned_key";
    }
    const parsed = TrustListPayload.safeParse(payload);
    if (!parsed.success) return "malformed";
    const list = parsed.data;
    if (list.attesters.some((e) => !e.jwks?.keys.length && !e.x509?.length)) return "malformed";
    if (list.iat > now + FUTURE_SKEW) return "future_iat";
    if (list.exp - list.iat > MAX_LIST_LIFETIME) return "too_long";
    if (publisher.newestIat !== undefined && list.iat < publisher.newestIat)
      return "older_than_accepted";
    publisher.newestIat = list.iat;
    publisher.list = list;
    // Rollover: the signing key plus the successors this list announces; others drop.
    publisher.pins = new Set([tp, ...list.next_keys]);
    return "accepted";
  }

  /** Lists currently valid (configured, accepted, unexpired). */
  #valid(now: number): ParsedList[] {
    return this.#publishers.flatMap((p) => (p.list && now < p.list.exp ? [p.list] : []));
  }

  /** Grants for an attester and type, from valid lists only. */
  grantsFor(iss: string, vct: string, now: number): AttesterGrant[] {
    return this.#valid(now).flatMap((list) =>
      list.attesters
        .filter((e) => e.id === iss && e.vct.includes(vct))
        .map((e) => ({
          id: e.id,
          operator: e.operator,
          vct: e.vct,
          jwks: (e.jwks?.keys ?? []).map((k) => k as JWK),
          x509: e.x509 ?? [],
          publisher: list.publisher,
        })),
    );
  }

  /**
   * The strictest distrust any accepted list (expired ones included) applies to
   * this attester or key: `{}` for unconditional, `{ after }` for a cutoff.
   */
  distrustFor(
    iss: string,
    keyThumbprint?: string,
    spkiSha256?: readonly string[],
  ): { after?: number } | undefined {
    let result: { after?: number } | undefined;
    for (const p of this.#publishers) {
      for (const d of p.list?.distrusted ?? []) {
        const matches =
          d.id === iss ||
          (keyThumbprint !== undefined && d.keys?.includes(keyThumbprint)) ||
          (spkiSha256 !== undefined &&
            d.spki_sha256?.some((h) => spkiSha256.includes(h.toLowerCase())));
        if (!matches) continue;
        if (d.distrust_after === undefined) return {};
        const after = Math.floor(Date.parse(d.distrust_after) / 1000);
        if (!result || (result.after !== undefined && after < result.after)) result = { after };
      }
    }
    return result;
  }

  /** The operator an attester counts as: any two attesters given the same operator by any list are one (§4.1). */
  operatorOf(attesterId: string): string {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p === x) return x;
      const root = find(p);
      parent.set(x, root);
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const p of this.#publishers)
      for (const e of p.list?.attesters ?? []) union(`attester:${e.id}`, `operator:${e.operator}`);
    return find(`attester:${attesterId}`);
  }

  /** The earliest expiry among valid lists: a derived tier can't outlive it. */
  validUntil(now: number): number | undefined {
    const exps = this.#valid(now).map((l) => l.exp);
    return exps.length ? Math.min(...exps) : undefined;
  }

  /** What an agent shows its users: the lists in use and where to appeal (§4.3). */
  describe(now: number): Array<{
    name: string;
    publisher?: string;
    valid: boolean;
    policy_uri?: string;
    appeals_uri?: string;
  }> {
    return this.#publishers.map((p) => ({
      name: p.config.name,
      ...(p.list ? { publisher: p.list.publisher } : {}),
      valid: !!p.list && now < p.list.exp,
      ...(p.list?.policy_uri ? { policy_uri: p.list.policy_uri } : {}),
      ...(p.list?.appeals_uri ? { appeals_uri: p.list.appeals_uri } : {}),
    }));
  }
}

/** Signs a trust list (publisher side). */
export function signTrustList(signer: Signer, payload: TrustListPayload): Promise<string> {
  return signJws(
    { typ: TRUST_LIST_TYP, jwk: signer.publicJwk },
    payload as Record<string, unknown>,
    signer,
  );
}
