/**
 * Agent identity (spec *Agent Identity*): RFC 9421 request signatures with the
 * OJCP signing profile, `Content-Digest` (RFC 9530), the `agent_id` grammar, and
 * namespace and delegated binding.
 */
import {
  createSignature,
  type Verifier as HttpVerifier,
  isSignatureError,
  type RequestDescriptor,
  type VerifiedSignature,
  verifySignature,
} from "http-message-sig";
import { z } from "zod";
import { sha256 } from "./digest.ts";
import { base64, base64url, randomBytes, utf8 } from "./encoding.ts";
import {
  algForJwk,
  httpSignatureAlgorithm,
  type JWK,
  type Signer,
  thumbprint,
  verifyRaw,
} from "./keys.ts";

export const SIGNATURE_LABEL = "ojcp";
export const SIGNATURE_TAG = "web-bot-auth";
export const KEY_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const KEY_DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json";
export const AGENT_IDENTITY_DOCUMENT_PATH = "/.well-known/ojcp-agent.json";
export const COVERED_COMPONENTS = [
  "@method",
  "@authority",
  "@path",
  "@query",
  "content-digest",
  "signature-agent",
] as const;
export const MAX_SIGNATURE_WINDOW = 300;
export const CLOCK_SKEW = 60;

export type AgentSignatureErrorCode =
  | "agent_signature_missing"
  | "agent_signature_invalid"
  | "agent_key_not_found"
  | "agent_digest_mismatch"
  | "agent_algorithm_unsupported"
  | "agent_signature_expired"
  | "agent_nonce_replayed"
  | "agent_id_malformed"
  | "agent_identity_mismatch";

export class AgentSignatureError extends Error {
  readonly code: AgentSignatureErrorCode;
  constructor(code: AgentSignatureErrorCode, message: string) {
    super(message);
    this.name = "AgentSignatureError";
    this.code = code;
  }
}

export interface HttpRequestParts {
  method: string;
  url: string;
  headers: Headers;
  /** The exact transmitted body bytes; absent or empty for bodyless requests. */
  body?: Uint8Array;
}

/** RFC 9530 `Content-Digest` with sha-256, over the exact (possibly empty) body. */
export async function contentDigest(body: Uint8Array | undefined): Promise<string> {
  return `sha-256=:${base64(await sha256(body ?? new Uint8Array()))}:`;
}

function describe(req: HttpRequestParts): RequestDescriptor {
  const fields: Array<{ name: string; value: string }> = [];
  req.headers.forEach((value, name) => {
    fields.push({ name, value });
  });
  return { kind: "request", method: req.method.toUpperCase(), targetUri: req.url, fields };
}

export interface SignRequestOptions {
  signer: Signer;
  /** The agent's key directory origin, e.g. `https://agent.wayfarer.ai`. */
  signatureAgent: string;
  /** Defaults to a fresh random nonce. Standing mandates reuse it in the KB-JWT (RFC 0008 §4.2). */
  nonce?: string;
  /** Unix seconds. */
  now?: number;
  /** Seconds the signature stays valid; at most 300. */
  lifetime?: number;
}

export interface SignedRequest {
  headers: Headers;
  keyid: string;
  nonce: string;
  created: number;
  expires: number;
}

export function newNonce(): string {
  return base64url(randomBytes(24));
}

/** Signs a request per the OJCP signing profile; returns headers to send with it. */
export async function signRequest(
  req: HttpRequestParts,
  options: SignRequestOptions,
): Promise<SignedRequest> {
  const lifetime = options.lifetime ?? 60;
  if (lifetime > MAX_SIGNATURE_WINDOW)
    throw new RangeError("signature window is at most 300 seconds");
  const headers = new Headers(req.headers);
  headers.set("content-digest", await contentDigest(req.body));
  headers.set("signature-agent", `"${new URL(options.signatureAgent).origin}"`);
  const keyid = await thumbprint(options.signer.publicJwk);
  const created = options.now ?? Math.floor(Date.now() / 1000);
  const expires = created + lifetime;
  const nonce = options.nonce ?? newNonce();
  const fields = await createSignature(describe({ ...req, headers }), {
    label: SIGNATURE_LABEL,
    components: [...COVERED_COMPONENTS],
    parameters: { created, expires, nonce, keyid, tag: SIGNATURE_TAG },
    signer: {
      algorithm: httpSignatureAlgorithm(options.signer.alg),
      sign: (data) => options.signer.sign(data),
    },
  });
  headers.set("signature-input", fields.signatureInput);
  headers.set("signature", fields.signature);
  return { headers, keyid, nonce, created, expires };
}

export interface VerifyRequestOptions {
  /** Resolves `keyid` (an RFC 7638 thumbprint) in the `Signature-Agent` directory. */
  resolveKey(signatureAgent: string, keyid: string): Promise<JWK | undefined>;
  /** Records `(keyid, nonce)` until `expires`; returns true if it was already seen. */
  seenNonce(keyid: string, nonce: string, expires: number): Promise<boolean>;
  algorithms?: ReadonlyArray<"ecdsa-p256-sha256" | "ed25519">;
  now?: number;
}

export interface VerifiedRequest {
  keyid: string;
  jwk: JWK;
  signatureAgent: string;
  nonce: string;
  created: number;
  expires: number;
}

const SignatureAgentHeader = z.string().regex(/^"https:\/\/[^"]+"$/);

/** Verification steps 1–5 of spec *Agent Identity → Verification*. */
export async function verifyRequest(
  req: HttpRequestParts,
  options: VerifyRequestOptions,
): Promise<VerifiedRequest> {
  if (!req.headers.has("signature") || !req.headers.has("signature-input"))
    throw new AgentSignatureError("agent_signature_missing", "request is not signed");
  const agentHeader = SignatureAgentHeader.safeParse(req.headers.get("signature-agent"));
  if (!agentHeader.success)
    throw new AgentSignatureError(
      "agent_signature_invalid",
      "Signature-Agent must be a quoted https origin",
    );
  const signatureAgent = new URL(agentHeader.data.slice(1, -1)).origin;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const algorithms = options.algorithms ?? ["ed25519", "ecdsa-p256-sha256"];
  let resolvedJwk: JWK | undefined;
  let verified: VerifiedSignature;
  try {
    verified = await verifySignature(describe(req), {
      label: SIGNATURE_LABEL,
      policy: {
        algorithms: [...algorithms],
        requiredComponents: [...COVERED_COMPONENTS],
        requiredParameters: ["created", "expires", "nonce", "keyid", "tag"],
        clockSkew: CLOCK_SKEW,
        now,
      },
      async resolveVerifier(candidate): Promise<HttpVerifier> {
        const keyid = candidate.parameters.keyid;
        if (typeof keyid !== "string")
          throw new AgentSignatureError("agent_signature_invalid", "keyid missing");
        const jwk = await options.resolveKey(signatureAgent, keyid);
        if (!jwk || (await thumbprint(jwk)) !== keyid)
          throw new AgentSignatureError("agent_key_not_found", "key not in directory");
        resolvedJwk = jwk;
        const algorithm = httpSignatureAlgorithm(algForJwk(jwk));
        return { algorithm, verify: (data, signature) => verifyRaw(jwk, data, signature) };
      },
    });
  } catch (error) {
    if (error instanceof AgentSignatureError) throw error;
    if (isSignatureError(error) && error.cause instanceof AgentSignatureError) throw error.cause;
    if (isSignatureError(error) && error.code === "AlgorithmMismatch")
      throw new AgentSignatureError("agent_algorithm_unsupported", error.message);
    if (isSignatureError(error) && /expired|future/.test(error.message))
      throw new AgentSignatureError("agent_signature_expired", error.message);
    if (isSignatureError(error) && /Algorithm .* is not allowed/.test(error.message))
      throw new AgentSignatureError("agent_algorithm_unsupported", error.message);
    throw new AgentSignatureError(
      "agent_signature_invalid",
      error instanceof Error ? error.message : "invalid signature",
    );
  }
  const { created, expires, nonce, keyid, tag } = verified.parameters;
  if (tag !== SIGNATURE_TAG)
    throw new AgentSignatureError("agent_signature_invalid", "tag must be web-bot-auth");
  if (
    typeof created !== "number" ||
    typeof expires !== "number" ||
    typeof nonce !== "string" ||
    typeof keyid !== "string"
  )
    throw new AgentSignatureError(
      "agent_signature_invalid",
      "created, expires, nonce and keyid are required",
    );
  if (expires - created > MAX_SIGNATURE_WINDOW || expires < created)
    throw new AgentSignatureError(
      "agent_signature_expired",
      "signature window exceeds 300 seconds",
    );
  if ((await contentDigest(req.body)) !== req.headers.get("content-digest"))
    throw new AgentSignatureError(
      "agent_digest_mismatch",
      "Content-Digest does not match the body",
    );
  if (await options.seenNonce(keyid, nonce, expires))
    throw new AgentSignatureError("agent_nonce_replayed", "nonce already used for this key");
  if (!resolvedJwk) throw new AgentSignatureError("agent_key_not_found", "key not resolved");
  return { keyid, jwk: resolvedJwk, signatureAgent, nonce, created, expires };
}

// ── agent_id grammar and binding ─────────────────────────────────────────────

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Spec *Agent ID Grammar*: byte-exact, never normalized. */
export function isValidAgentId(agentId: string): boolean {
  if (utf8(agentId).length > 253) return false;
  const labels = agentId.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l));
}

function namespaceOf(origin: string): string | null {
  const host = new URL(origin).hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null;
  return host.split(".").reverse().join(".");
}

/** Spec *Namespace Binding*: the agent_id equals the reversed host or lies beneath it. */
export function bindsByNamespace(agentId: string, signatureAgent: string): boolean {
  const ns = namespaceOf(signatureAgent);
  return ns !== null && (agentId === ns || agentId.startsWith(`${ns}.`));
}

/** Where a delegated binding's Agent Identity Document lives. */
export function agentIdentityDocumentUrl(agentId: string): string {
  return `https://${agentId.split(".").reverse().join(".")}${AGENT_IDENTITY_DOCUMENT_PATH}`;
}

export const AgentIdentityDocument = z.looseObject({
  agent_id: z.string(),
  signers: z.array(z.string()),
});
export type AgentIdentityDocument = z.infer<typeof AgentIdentityDocument>;

/** Spec *Delegated Binding*: the document names the Signature-Agent origin as a signer. */
export function bindsByDelegation(
  agentId: string,
  signatureAgent: string,
  document: unknown,
): boolean {
  const parsed = AgentIdentityDocument.safeParse(document);
  if (!parsed.success || parsed.data.agent_id !== agentId) return false;
  const origin = new URL(signatureAgent).origin;
  return parsed.data.signers.some((s) => {
    try {
      return new URL(s).origin === origin && s.replace(/\/$/, "") === origin;
    } catch {
      return false;
    }
  });
}

/** An agent's key directory document. Mandate keys carry `ojcp_mandate_until` (RFC 0008 §3.4). */
export const KeyDirectory = z.looseObject({ keys: z.array(z.record(z.string(), z.unknown())) });
export type KeyDirectory = z.infer<typeof KeyDirectory>;
