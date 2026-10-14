/**
 * Every fetch trust derivation makes goes through here (RFC 0010 §5.2 and its
 * fetch-safety note): HTTPS only, no IP literals or local names, at most
 * 256 KB, and per-evaluation caps on count and total time.
 */
import { OjcpError } from "@ojcp/credentials-core";

export const MAX_BODY_BYTES = 256 * 1024;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const LOCAL = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/** True if a URL may be fetched at all: https, a DNS name, not a local one. */
export function isFetchable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host) || !host.includes(".")) return false;
  return !LOCAL.test(host);
}

/**
 * The deployment's `fetch` should also refuse private and link-local
 * addresses after DNS resolution; that check needs the platform's resolver
 * and can't be done portably here.
 */
export async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) throw new OjcpError("malformed", "response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new OjcpError("malformed", "response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A fetch with a budget: at most `maxFetches` calls, all before `deadline`. */
export class BudgetedFetcher {
  readonly #fetch: FetchLike;
  readonly #deadline: number;
  #remaining: number;

  constructor(fetch: FetchLike, options: { maxFetches: number; timeoutMs: number }) {
    this.#fetch = fetch;
    this.#remaining = options.maxFetches;
    this.#deadline = Date.now() + options.timeoutMs;
  }

  /** The text of a successful response, or `undefined` if refused, over budget, failed or late. */
  async text(url: string, accept: string): Promise<string | undefined> {
    if (!isFetchable(url) || this.#remaining <= 0) return undefined;
    const left = this.#deadline - Date.now();
    if (left <= 0) return undefined;
    this.#remaining--;
    try {
      const response = await this.#fetch(url, {
        headers: { accept },
        redirect: "error",
        signal: AbortSignal.timeout(left),
      });
      return response.ok ? await readLimited(response) : undefined;
    } catch {
      return undefined;
    }
  }
}
