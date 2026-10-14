/**
 * A `fetch` that signs every OJCP request under the spec's signing profile.
 *
 * Which key and nonce to use is read from the request itself, so concurrent
 * calls never mix them up: a `tools/call` carrying a standing mandate is signed
 * by the credential's `cnf` key, and for every tool but `submit_application`
 * with the KB-JWT's nonce (RFC 0008 §4.2). Everything else is signed by the
 * platform's request key with a fresh nonce.
 */
import {
  decodeJws,
  fromUtf8,
  isRecord,
  type JWK,
  parseSdJwt,
  type Signer,
  signRequest,
  thumbprint,
  utf8,
} from "@ojcp/credentials-core";
import type { AgentKeyring } from "./keyring.ts";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface SignedFetchOptions {
  keyring: AgentKeyring;
  /** The origin serving this agent's key directory. */
  signatureAgent: string;
  /** Seconds a signature stays valid; at most 300. */
  lifetime?: number;
  fetch?: FetchLike;
  /** Unix seconds; defaults to the system clock. */
  now?: () => number;
}

interface SigningChoice {
  signer: Signer;
  nonce?: string;
}

async function choose(body: Uint8Array | undefined, keyring: AgentKeyring): Promise<SigningChoice> {
  const fallback = { signer: keyring.requestSigner };
  if (!body || body.length === 0) return fallback;
  let message: unknown;
  try {
    message = JSON.parse(fromUtf8(body));
  } catch {
    return fallback;
  }
  if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params))
    return fallback;
  const { name, arguments: args } = message.params;
  const declaration = isRecord(args) ? args.agent_declaration : undefined;
  const mandate = isRecord(declaration) ? declaration.user_mandate : undefined;
  if (typeof mandate !== "string") return fallback;
  const parsed = await parseSdJwt(mandate);
  const cnf = isRecord(parsed.payload.cnf)
    ? (parsed.payload.cnf.jwk as JWK | undefined)
    : undefined;
  if (!cnf || !parsed.kbJwt) return fallback;
  const signer = keyring.signerFor(await thumbprint(cnf));
  if (!signer) throw new Error("user_mandate is bound to a key this platform doesn't hold");
  const kbNonce = decodeJws(parsed.kbJwt).payload.nonce;
  return name === "submit_application" || typeof kbNonce !== "string"
    ? { signer }
    : { signer, nonce: kbNonce };
}

async function bodyBytes(body: RequestInit["body"]): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return utf8(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function createSignedFetch(options: SignedFetchOptions): FetchLike {
  const base = options.fetch ?? fetch;
  return async (url, init = {}) => {
    const body = await bodyBytes(init.body);
    const method = (init.method ?? "GET").toUpperCase();
    const choice = await choose(body, options.keyring);
    const signed = await signRequest(
      { method, url: String(url), headers: new Headers(init.headers), ...(body ? { body } : {}) },
      {
        signer: choice.signer,
        signatureAgent: options.signatureAgent,
        ...(choice.nonce ? { nonce: choice.nonce } : {}),
        ...(options.lifetime ? { lifetime: options.lifetime } : {}),
        ...(options.now ? { now: options.now() } : {}),
      },
    );
    return base(url, {
      ...init,
      method,
      headers: signed.headers,
      ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
    });
  };
}
