/**
 * The agent's view of a provider's effective trust tier (RFC 0010 §5). The
 * wallet consumes it only through this interface; deriving tiers is RFC 0010's
 * job and lives outside the wallet.
 */
export type TrustTier = "unverified" | "verified" | "audited";

export interface EffectiveTier {
  tier: TrustTier;
  /**
   * RFC 0010 §5.4: `derived` is source (a), derivation under §5.2;
   * `pinned_index` is source (b), an index the operator pinned during migration.
   */
  source: "derived" | "pinned_index";
}

export interface TrustResolver {
  /** The provider's effective tier now, or `undefined` if none can be established. */
  effectiveTier(origin: string): Promise<EffectiveTier | undefined>;
}

const RANK: Record<TrustTier, number> = { unverified: 0, verified: 1, audited: 2 };

export function tierAtLeast(tier: TrustTier, floor: TrustTier): boolean {
  return RANK[tier] >= RANK[floor];
}
