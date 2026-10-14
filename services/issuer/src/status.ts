/**
 * The issuer's Token Status Lists. Changes queue and apply together at fixed
 * epochs (RFC 0008 §7.1: at most an hour), so a list update never isolates one
 * person's action. Indexes are unpredictable and a batch is spread across
 * lists. Every list is shared by all subjects and holds at least 10,000
 * entries. Lists, used indexes and queued changes are persisted, so a restart
 * never forgets a revocation or reuses an index.
 */
import {
  allocateIndex,
  OjcpStatusList,
  type Signer,
  Status,
  type StatusValue,
  signStatusListToken,
} from "@ojcp/credentials-core";
import type { IssuerStore, StoredStatusList } from "./store.ts";

export interface StatusRegistryOptions {
  /** Absolute list URIs, served from the `iss` origin. */
  uris: readonly string[];
  size?: number;
  signer: Signer;
  kid: string;
  /** Seconds; RFC 0008 caps standing-mandate lists at an hour, RFC 0014 at 12 hours. */
  ttl: number;
  store: IssuerStore;
}

export class StatusRegistry {
  readonly #options: StatusRegistryOptions;

  constructor(options: StatusRegistryOptions) {
    if (options.uris.length < 2)
      throw new Error("use several status lists so a batch can be spread");
    this.#options = options;
  }

  get uris(): readonly string[] {
    return this.#options.uris;
  }

  async #load(uri: string): Promise<StoredStatusList> {
    const stored = await this.#options.store.get("statusList", uri);
    if (stored) return stored;
    const fresh = OjcpStatusList.create(this.#options.size).compressed();
    const created: StoredStatusList = {
      id: uri,
      bits: fresh.bits,
      lst: fresh.lst,
      size: this.#options.size ?? 10_000,
      used: [],
      pending: [],
    };
    await this.#options.store.put("statusList", created);
    return created;
  }

  /** Allocates `count` entries spread across lists, each at an unpredictable index. */
  async allocate(count: number): Promise<Array<{ uri: string; idx: number }>> {
    const uris = this.#options.uris;
    const out: Array<{ uri: string; idx: number }> = [];
    for (let i = 0; i < count; i++) {
      const uri = uris[i % uris.length] as string;
      const stored = await this.#load(uri);
      const used = new Set(stored.used);
      const idx = allocateIndex(stored.size, (n) => used.has(n));
      await this.#options.store.put("statusList", { ...stored, used: [...stored.used, idx] });
      out.push({ uri, idx });
    }
    return out;
  }

  /** Queues a change for the next epoch. */
  async set(uri: string, idx: number, value: StatusValue): Promise<void> {
    const stored = await this.#load(uri);
    await this.#options.store.put("statusList", {
      ...stored,
      pending: [...stored.pending, [idx, value]],
    });
  }

  /** Applies every queued change at once; run on a fixed schedule. Returns how many changes applied. */
  async applyEpoch(): Promise<number> {
    let applied = 0;
    for (const uri of this.#options.uris) {
      const stored = await this.#load(uri);
      if (stored.pending.length === 0) continue;
      const list = OjcpStatusList.fromCompressed(stored.lst, stored.bits, stored.size);
      for (const [idx, value] of stored.pending) list.set(idx, value as StatusValue);
      applied += stored.pending.length;
      await this.#options.store.put("statusList", { ...stored, ...list.compressed(), pending: [] });
    }
    return applied;
  }

  async status(uri: string, idx: number): Promise<number> {
    const stored = await this.#options.store.get("statusList", uri);
    return stored
      ? OjcpStatusList.fromCompressed(stored.lst, stored.bits, stored.size).get(idx)
      : Status.INVALID;
  }

  async token(uri: string, now: Date): Promise<string | undefined> {
    if (!this.#options.uris.includes(uri)) return undefined;
    const stored = await this.#load(uri);
    return signStatusListToken({
      uri,
      list: OjcpStatusList.fromCompressed(stored.lst, stored.bits, stored.size),
      signer: this.#options.signer,
      kid: this.#options.kid,
      ttl: this.#options.ttl,
      lifetime: this.#options.ttl * 2,
      now,
    });
  }
}
