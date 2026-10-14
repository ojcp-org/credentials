/**
 * SD-JWT (RFC 9901) as OJCP needs it: exact decoy padding, digest order that
 * reveals nothing, strict decoding, selective presentation, and key-binding JWTs
 * that can carry extra claims (RFC 0008's `ojcp_action`).
 */
import { sha256 } from "./digest.ts";
import {
  base64url,
  base64urlJson,
  fromBase64url,
  fromUtf8,
  randomBytes,
  utf8,
} from "./encoding.ts";
import { OjcpError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { decodeJws, type JwtHeader, type JwtPayload, signJws, verifyJws } from "./jws.ts";
import type { JWK, Signer } from "./keys.ts";

export const SD_ALG = "sha-256";
export const KB_JWT_TYP = "kb+jwt";

/** Marks an object member as selectively disclosable. */
export class Disclosable {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

export interface DisclosableArrayOptions {
  /** Pad with decoy digests to this many entries. */
  padTo?: number;
  /** Keep element order (ordered data such as position histories); decoys go last. */
  keepOrder?: boolean;
}

/**
 * Marks an array whose every element is selectively disclosable. By default the
 * digests are padded with decoys to `padTo` entries and sorted, so position
 * reveals nothing (RFC 9901 §4.2.5, §9.7): right for sets such as allow-lists.
 */
export class DisclosableArray {
  readonly values: readonly unknown[];
  readonly padTo: number;
  readonly keepOrder: boolean;
  constructor(values: readonly unknown[], options: DisclosableArrayOptions = {}) {
    this.values = values;
    this.padTo = options.padTo ?? values.length;
    this.keepOrder = options.keepOrder ?? false;
    if (this.padTo < values.length)
      throw new RangeError(`array has ${values.length} elements, more than padTo ${this.padTo}`);
  }
}

export const sd = (value: unknown): Disclosable => new Disclosable(value);
export const sdArray = (
  values: readonly unknown[],
  options?: DisclosableArrayOptions,
): DisclosableArray => new DisclosableArray(values, options);

export type ClaimPath = ReadonlyArray<string | number>;

export interface Disclosure {
  /** The base64url disclosure string as it appears in the SD-JWT. */
  readonly encoded: string;
  readonly digest: string;
  readonly salt: string;
  /** Present for object members; absent for array elements. */
  readonly name?: string;
  readonly value: unknown;
}

async function digestOf(encoded: string): Promise<string> {
  return base64url(await sha256(utf8(encoded)));
}

function newSalt(): string {
  return base64url(randomBytes(16));
}

async function makeDisclosure(name: string | undefined, value: unknown): Promise<Disclosure> {
  const salt = newSalt();
  const array = name === undefined ? [salt, value] : [salt, name, value];
  const encoded = base64urlJson(array);
  const base = { encoded, digest: await digestOf(encoded), salt, value };
  return name === undefined ? base : { ...base, name };
}

async function decoyDigest(): Promise<string> {
  return base64url(await sha256(randomBytes(32)));
}

const RESERVED = new Set(["_sd", "...", "_sd_alg"]);

async function pack(value: unknown, disclosures: Disclosure[]): Promise<unknown> {
  if (value instanceof Disclosable)
    throw new TypeError("sd() marks object members only; use sdArray() for array elements");
  if (value instanceof DisclosableArray) {
    const entries: string[] = [];
    for (const element of value.values) {
      const d = await makeDisclosure(undefined, await pack(element, disclosures));
      disclosures.push(d);
      entries.push(d.digest);
    }
    while (entries.length < value.padTo) entries.push(await decoyDigest());
    return (value.keepOrder ? entries : entries.sort()).map((digest) => ({ "...": digest }));
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => pack(v, disclosures)));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  const digests: string[] = [];
  for (const [key, member] of Object.entries(value)) {
    if (RESERVED.has(key)) throw new TypeError(`claim name ${key} is reserved`);
    if (member instanceof Disclosable) {
      const d = await makeDisclosure(key, await pack(member.value, disclosures));
      disclosures.push(d);
      digests.push(d.digest);
    } else {
      out[key] = await pack(member, disclosures);
    }
  }
  if (digests.length > 0) out._sd = digests.sort();
  return out;
}

export interface IssueOptions {
  /** Header members; `alg` is set from the signer. `typ` defaults to `dc+sd-jwt`. */
  header?: JwtHeader;
  /** Claims, with `sd()` and `sdArray()` marking what is selectively disclosable. */
  claims: Record<string, unknown>;
  signer: Signer;
}

export interface IssuedSdJwt {
  /** `<issuer-signed JWT>~<disclosure>~…~` */
  readonly compact: string;
  readonly disclosures: readonly Disclosure[];
}

export async function issueSdJwt(options: IssueOptions): Promise<IssuedSdJwt> {
  const disclosures: Disclosure[] = [];
  const packed = (await pack(options.claims, disclosures)) as Record<string, unknown>;
  const payload: JwtPayload = { ...packed, _sd_alg: SD_ALG };
  const jwt = await signJws({ typ: "dc+sd-jwt", ...options.header }, payload, options.signer);
  return {
    compact: `${jwt}~${disclosures.map((d) => `${d.encoded}~`).join("")}`,
    disclosures,
  };
}

// ── Decoding ─────────────────────────────────────────────────────────────────

export interface ParsedSdJwt {
  /** The issuer-signed JWT. */
  readonly jwt: string;
  readonly header: JwtHeader;
  readonly payload: JwtPayload;
  readonly disclosures: readonly Disclosure[];
  /** The presentation without the KB-JWT, ending in `~` (the `sd_hash` input). */
  readonly withoutKb: string;
  readonly kbJwt?: string;
}

export async function parseSdJwt(compact: string): Promise<ParsedSdJwt> {
  const parts = compact.split("~");
  if (parts.length < 2) throw new OjcpError("malformed", "not an SD-JWT");
  const jwt = parts[0] as string;
  const kbPart = parts[parts.length - 1] as string;
  const encodedDisclosures = parts.slice(1, -1);
  if (encodedDisclosures.some((d) => d === ""))
    throw new OjcpError("malformed", "empty disclosure");
  const { header, payload } = decodeJws(jwt);
  const disclosures: Disclosure[] = [];
  for (const encoded of encodedDisclosures) {
    let array: unknown;
    try {
      array = JSON.parse(fromUtf8(fromBase64url(encoded)));
    } catch {
      throw new OjcpError("malformed", "disclosure is not base64url JSON");
    }
    if (!Array.isArray(array) || (array.length !== 2 && array.length !== 3))
      throw new OjcpError("malformed", "disclosure must be a 2- or 3-element array");
    const salt = array[0];
    if (typeof salt !== "string")
      throw new OjcpError("malformed", "disclosure salt must be a string");
    const digest = await digestOf(encoded);
    if (array.length === 3) {
      const name = array[1];
      if (typeof name !== "string" || RESERVED.has(name))
        throw new OjcpError("malformed", "invalid disclosure claim name");
      disclosures.push({ encoded, digest, salt, name, value: array[2] });
    } else {
      disclosures.push({ encoded, digest, salt, value: array[1] });
    }
  }
  const withoutKb = `${parts.slice(0, -1).join("~")}~`;
  return kbPart === ""
    ? { jwt, header, payload, disclosures, withoutKb }
    : { jwt, header, payload, disclosures, withoutKb, kbJwt: kbPart };
}

export interface DisclosedClaim {
  readonly path: ClaimPath;
  readonly disclosure: Disclosure;
}

export interface ReconstructedClaims {
  readonly claims: Record<string, unknown>;
  /** Where each presented disclosure landed in the reconstructed claims. */
  readonly disclosed: readonly DisclosedClaim[];
}

/**
 * Rebuilds the claims from the payload and the presented disclosures (RFC 9901
 * §7.1). Fails if a disclosure is unreferenced or referenced twice, a digest
 * repeats, or a disclosed name collides with a plain claim.
 */
export function reconstructClaims(
  payload: JwtPayload,
  disclosures: readonly Disclosure[],
): ReconstructedClaims {
  if (payload._sd_alg !== undefined && payload._sd_alg !== SD_ALG)
    throw new OjcpError("malformed", `unsupported _sd_alg ${String(payload._sd_alg)}`);
  const byDigest = new Map<string, Disclosure>();
  for (const d of disclosures) {
    if (byDigest.has(d.digest)) throw new OjcpError("malformed", "duplicate disclosure");
    byDigest.set(d.digest, d);
  }
  const seenDigests = new Set<string>();
  const used = new Set<string>();
  const disclosed: DisclosedClaim[] = [];

  const visit = (value: unknown, path: ClaimPath): unknown => {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const element of value) {
        if (isRecord(element) && "..." in element) {
          if (Object.keys(element).length !== 1 || typeof element["..."] !== "string")
            throw new OjcpError("malformed", 'array digest entry must be {"...": digest}');
          const digest = element["..."];
          if (seenDigests.has(digest)) throw new OjcpError("malformed", "digest appears twice");
          seenDigests.add(digest);
          const d = byDigest.get(digest);
          if (!d) continue;
          if (d.name !== undefined)
            throw new OjcpError("malformed", "object disclosure referenced from an array");
          used.add(digest);
          const elementPath = [...path, out.length];
          disclosed.push({ path: elementPath, disclosure: d });
          out.push(visit(d.value, elementPath));
        } else {
          out.push(visit(element, [...path, out.length]));
        }
      }
      return out;
    }
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (key === "_sd" || (key === "_sd_alg" && path.length === 0)) continue;
      out[key] = visit(member, [...path, key]);
    }
    const sdList = value._sd;
    if (sdList !== undefined) {
      if (!Array.isArray(sdList) || sdList.some((x) => typeof x !== "string"))
        throw new OjcpError("malformed", "_sd must be an array of strings");
      for (const digest of sdList as string[]) {
        if (seenDigests.has(digest)) throw new OjcpError("malformed", "digest appears twice");
        seenDigests.add(digest);
        const d = byDigest.get(digest);
        if (!d) continue;
        if (d.name === undefined)
          throw new OjcpError("malformed", "array disclosure referenced from an object");
        if (Object.hasOwn(out, d.name))
          throw new OjcpError("malformed", `disclosed claim ${d.name} already present`);
        used.add(digest);
        disclosed.push({ path: [...path, d.name], disclosure: d });
        out[d.name] = visit(d.value, [...path, d.name]);
      }
    }
    return out;
  };

  const claims = visit(payload, []) as Record<string, unknown>;
  for (const d of disclosures)
    if (!used.has(d.digest))
      throw new OjcpError("malformed", "disclosure not referenced by the payload");
  return { claims, disclosed };
}

// ── Presentation ─────────────────────────────────────────────────────────────

const isPrefix = (prefix: ClaimPath, path: ClaimPath): boolean =>
  prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);

/**
 * Builds a presentation keeping the disclosures `select` accepts, everything
 * beneath them, and the disclosures that contain them (RFC 9901 §7.2 recursion).
 * Containers are kept only as containers: their other members stay hidden.
 */
export async function presentSdJwt(
  compact: string,
  select: (claim: DisclosedClaim) => boolean,
): Promise<string> {
  const parsed = await parseSdJwt(compact);
  if (parsed.kbJwt) throw new OjcpError("malformed", "cannot re-present an SD-JWT with a KB-JWT");
  const { disclosed } = reconstructClaims(parsed.payload, parsed.disclosures);
  const keep = new Set<string>();
  for (const claim of disclosed) {
    if (!select(claim)) continue;
    for (const other of disclosed)
      if (isPrefix(other.path, claim.path) || isPrefix(claim.path, other.path))
        keep.add(other.disclosure.digest);
  }
  const kept = parsed.disclosures.filter((d) => keep.has(d.digest));
  return `${parsed.jwt}~${kept.map((d) => `${d.encoded}~`).join("")}`;
}

/** A DCQL claims path (OpenID4VP §7): `null` selects every element of an array. */
export type ClaimsPathQuery = ReadonlyArray<string | number | null>;

/** True if `path` is what `query` names, or lies beneath it. */
export function matchesClaimsPath(query: ClaimsPathQuery, path: ClaimPath): boolean {
  if (path.length < query.length) return false;
  return query.every((seg, i) => (seg === null ? typeof path[i] === "number" : seg === path[i]));
}

/** A `presentSdJwt` selector for DCQL claim paths. */
export function selectClaimsPaths(
  queries: readonly ClaimsPathQuery[],
): (claim: DisclosedClaim) => boolean {
  return (claim) =>
    queries.some((q) => claim.path.length === q.length && matchesClaimsPath(q, claim.path));
}

export interface KbClaims {
  aud: string;
  nonce: string;
  iat?: number;
  /** Extra claims, e.g. RFC 0008 `ojcp_action`. */
  [claim: string]: unknown;
}

/** Appends a key-binding JWT (RFC 9901 §4.3) to a presentation ending in `~`. */
export async function bindKey(
  presentation: string,
  claims: KbClaims,
  holder: Signer,
): Promise<string> {
  if (!presentation.endsWith("~")) throw new TypeError("presentation must end with ~");
  const sdHash = base64url(await sha256(utf8(presentation)));
  const payload = { ...claims, iat: claims.iat ?? Math.floor(Date.now() / 1000), sd_hash: sdHash };
  return presentation + (await signJws({ typ: KB_JWT_TYP }, payload, holder));
}

export interface VerifiedKb {
  readonly header: JwtHeader;
  readonly payload: JwtPayload & { aud: string; nonce: string; iat: number; sd_hash: string };
}

/** Verifies a KB-JWT's signature, `typ`, required claims and `sd_hash`. */
export async function verifyKeyBinding(parsed: ParsedSdJwt, holderJwk: JWK): Promise<VerifiedKb> {
  if (!parsed.kbJwt) throw new OjcpError("invalid_claims", "key-binding JWT missing");
  const { header, payload } = await verifyJws(parsed.kbJwt, holderJwk);
  if (header.typ !== KB_JWT_TYP) throw new OjcpError("invalid_claims", "KB-JWT typ must be kb+jwt");
  const { aud, nonce, iat, sd_hash } = payload;
  if (
    typeof aud !== "string" ||
    typeof nonce !== "string" ||
    typeof iat !== "number" ||
    typeof sd_hash !== "string"
  )
    throw new OjcpError("invalid_claims", "KB-JWT is missing aud, nonce, iat or sd_hash");
  const expected = base64url(await sha256(utf8(parsed.withoutKb)));
  if (sd_hash !== expected) throw new OjcpError("invalid_claims", "KB-JWT sd_hash does not match");
  return { header, payload: { ...payload, aud, nonce, iat, sd_hash } };
}
