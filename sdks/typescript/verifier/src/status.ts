/**
 * Status List Token cache. Lists are refreshed on a schedule, never per
 * presentation (RFC 0008 §7.1, RFC 0013 §6.2); a check needs a copy no older
 * than the caller's maximum age. The fetch is injectable so a provider can send
 * first fetches through an Oblivious HTTP relay (RFC 0013 §6.2).
 */
import {
  OjcpError,
  type OjcpStatusList,
  readStatusListToken,
  Status,
} from "@ojcp/credentials-core";
import { type PinnedKey, verifyWithPins } from "./issuers.ts";

export interface StatusCheck {
  uri: string;
  idx: number;
  /** Keys that may sign this list: the same resolution as the credential (TSL §11.3). */
  keys: readonly PinnedKey[];
  /** Seconds; one hour for standing mandates, 12 hours for hiring credentials. */
  maxAge: number;
}

export interface StatusSource {
  /** Throws `OjcpError("revoked")` unless the entry is VALID on a fresh enough copy. */
  requireValid(check: StatusCheck): Promise<void>;
}

interface Cached {
  list: OjcpStatusList;
  fetchedAt: number;
  exp?: number;
}

export interface StatusListCacheOptions {
  fetch?: (uri: string) => Promise<Response>;
  /** Unix seconds. */
  now?: () => number;
}

export class StatusListCache implements StatusSource {
  readonly #cache = new Map<string, Cached>();
  readonly #fetch: (uri: string) => Promise<Response>;
  readonly #now: () => number;

  constructor(options: StatusListCacheOptions = {}) {
    this.#fetch =
      options.fetch ?? ((uri) => fetch(uri, { headers: { accept: "application/statuslist+jwt" } }));
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Fetches and verifies a list; call on a schedule for every list an admitted issuer enumerates. */
  async refresh(uri: string, keys: readonly PinnedKey[], maxTtl: number): Promise<void> {
    const response = await this.#fetch(uri);
    if (!response.ok)
      throw new OjcpError("status_unavailable", `status list ${uri} returned ${response.status}`);
    const token = (await response.text()).trim();
    await verifyWithPins(token, keys);
    const { payload, list } = readStatusListToken(token);
    const now = this.#now();
    if (payload.sub !== uri)
      throw new OjcpError("status_unavailable", "status list sub does not match its URI");
    if (payload.exp !== undefined && payload.exp <= now)
      throw new OjcpError("status_unavailable", "status list token expired");
    if (payload.ttl !== undefined && payload.ttl > maxTtl)
      throw new OjcpError("status_unavailable", "status list ttl too long");
    this.#cache.set(uri, {
      list,
      fetchedAt: now,
      ...(payload.exp === undefined ? {} : { exp: payload.exp }),
    });
  }

  async requireValid(check: StatusCheck): Promise<void> {
    const now = this.#now();
    let cached = this.#cache.get(check.uri);
    if (
      !cached ||
      now - cached.fetchedAt > check.maxAge ||
      (cached.exp !== undefined && cached.exp <= now)
    ) {
      await this.refresh(check.uri, check.keys, check.maxAge);
      cached = this.#cache.get(check.uri);
    }
    if (!cached) throw new OjcpError("status_unavailable", "status unavailable");
    if (cached.list.get(check.idx) !== Status.VALID)
      throw new OjcpError("revoked", "credential is not VALID");
  }
}
