/**
 * The provider's mandate ledger: consumed `mandate_nonce`/`jti` values and the
 * per-employer standing-mandate count (RFC 0008 §6). A terminal submission
 * consumes and counts in one atomic step; a retry with the same action returns
 * the original outcome (§4.3).
 */
import { base64url, jcs, utf8 } from "@ojcp/credentials-core";

export interface SubmissionCommit {
  /** `mandate_nonce` and, for action mandates, `jti`. */
  nonces: readonly string[];
  /** The `ojcp_action` digest; a retry carrying the same one is idempotent. */
  action: string;
  /** Present for standing mandates. */
  count?: { key: string; limit: number; windowStart: number };
  at: number;
  /** The provider's result to return on retries (application id, status…). */
  outcome: unknown;
}

export type CommitResult =
  | { status: "committed" }
  | { status: "duplicate"; outcome: unknown }
  | { status: "nonce_consumed" }
  | { status: "limit_reached" };

export interface MandateLedger {
  /** Whether a nonce was consumed, and by which action. */
  consumed(nonce: string): Promise<{ action: string; outcome: unknown } | undefined>;
  /** Count entries for a key at or after `since`. */
  count(key: string, since: number): Promise<number>;
  /** Atomic: check nonces and limit, then consume and count. */
  commit(commit: SubmissionCommit): Promise<CommitResult>;
  /** Deletes count entries older than `before` (§6.1: entries are deleted after the window). */
  purge(before: number): Promise<void>;
}

/** Single-process ledger. A deployment uses a transactional store with the same semantics. */
export class InMemoryLedger implements MandateLedger {
  readonly #nonces = new Map<string, { action: string; outcome: unknown }>();
  readonly #counts = new Map<string, number[]>();

  async consumed(nonce: string): Promise<{ action: string; outcome: unknown } | undefined> {
    return this.#nonces.get(nonce);
  }

  async count(key: string, since: number): Promise<number> {
    return (this.#counts.get(key) ?? []).filter((t) => t >= since).length;
  }

  async commit(commit: SubmissionCommit): Promise<CommitResult> {
    // JavaScript runs this synchronously between awaits, so it is atomic in-process.
    for (const nonce of commit.nonces) {
      const prior = this.#nonces.get(nonce);
      if (prior)
        return prior.action === commit.action
          ? { status: "duplicate", outcome: prior.outcome }
          : { status: "nonce_consumed" };
    }
    const count = commit.count;
    if (count) {
      const entries = (this.#counts.get(count.key) ?? []).filter((t) => t >= count.windowStart);
      if (entries.length >= count.limit) return { status: "limit_reached" };
      entries.push(commit.at);
      this.#counts.set(count.key, entries);
    }
    for (const nonce of commit.nonces)
      this.#nonces.set(nonce, { action: commit.action, outcome: commit.outcome });
    return { status: "committed" };
  }

  async purge(before: number): Promise<void> {
    for (const [key, entries] of this.#counts) {
      const kept = entries.filter((t) => t >= before);
      if (kept.length === 0) this.#counts.delete(key);
      else this.#counts.set(key, kept);
    }
  }
}

/**
 * RFC 0008 §6.1 count key: HMAC-SHA-256 under the employer's own secret of the
 * employer identifier and the normalized candidate binding.
 */
export async function countKey(
  secret: Uint8Array,
  employerId: string,
  candidate: unknown,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8(jcs([employerId, candidate])) as Uint8Array<ArrayBuffer>,
  );
  return base64url(new Uint8Array(mac));
}
