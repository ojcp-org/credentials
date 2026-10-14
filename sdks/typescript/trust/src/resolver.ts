/**
 * Effective tiers for an agent (RFC 0010 §5.4). Source (a) is derivation;
 * source (b), during migration only, is the tier from an index the agent's
 * operator pinned. The higher wins, and its source is recorded. A tier from
 * any other index, a provider's own claim, or a tool response never counts.
 *
 * Structurally implements `TrustResolver` from `@ojcp/agent-wallet`.
 */
import { type DerivationOptions, type DerivedTier, deriveTier, type TrustTier } from "./derive.ts";

const RANK: Record<TrustTier, number> = { unverified: 0, verified: 1, audited: 2 };

/** An index the agent's operator pinned in configuration (§5.4 b). */
export interface PinnedIndex {
  /** The index URL the operator pinned, recorded with the tier. */
  url: string;
  /** The index's `trust_tier` for an origin, from a response the deployment has authenticated. */
  tierFor(origin: string): Promise<TrustTier | undefined>;
}

export interface EffectiveTier {
  tier: TrustTier;
  source: "derived" | "pinned_index";
  derived: DerivedTier;
}

export interface TrustResolverOptions extends DerivationOptions {
  /** Only consulted while `migration` is true. */
  pinnedIndex?: PinnedIndex;
}

export class DerivedTrustResolver {
  readonly #options: TrustResolverOptions;
  readonly #cache = new Map<string, DerivedTier>();

  constructor(options: TrustResolverOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** The derived tier, cached no longer than its shortest input. */
  async derive(origin: string): Promise<DerivedTier> {
    const key = new URL(origin).origin;
    const cached = this.#cache.get(key);
    if (cached && this.#now() < cached.validUntil) return cached;
    const derived = await deriveTier(key, this.#options);
    this.#cache.set(key, derived);
    return derived;
  }

  /** Drops cached tiers, e.g. after a trust list update. */
  invalidate(origin?: string): void {
    if (origin) this.#cache.delete(new URL(origin).origin);
    else this.#cache.clear();
  }

  async effectiveTier(origin: string): Promise<EffectiveTier> {
    const derived = await this.derive(origin);
    const index = this.#options.migration ? this.#options.pinnedIndex : undefined;
    const indexed = index ? await index.tierFor(derived.origin).catch(() => undefined) : undefined;
    if (indexed && RANK[indexed] > RANK[derived.tier])
      return { tier: indexed, source: "pinned_index", derived };
    return { tier: derived.tier, source: "derived", derived };
  }
}
