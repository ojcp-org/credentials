/**
 * Token Status Lists (draft-ietf-oauth-status-list-14, as HAIP pins it) with the
 * OJCP rules: at least 10,000 indexes with unused ones VALID (RFC 0014 §5.2),
 * unpredictable indexes, `exp` and a bounded `ttl`.
 */
import { StatusList } from "@owf/token-status-list";
import { z } from "zod";
import { base64url, fromBase64url, randomInt } from "./encoding.ts";
import { OjcpError } from "./errors.ts";
import { decodeJws, signJws } from "./jws.ts";
import type { Signer } from "./keys.ts";

export const STATUS_LIST_JWT_TYP = "statuslist+jwt";
export const MIN_LIST_SIZE = 10_000;

export const Status = { VALID: 0, INVALID: 1, SUSPENDED: 2 } as const;
export type StatusValue = (typeof Status)[keyof typeof Status];

/** 2 bits per entry, enough for VALID / INVALID / SUSPENDED. */
const BITS = 2 as const;

export class OjcpStatusList {
  readonly #list: StatusList;
  readonly size: number;

  private constructor(list: StatusList, size: number) {
    this.#list = list;
    this.size = size;
  }

  static create(size: number = MIN_LIST_SIZE): OjcpStatusList {
    if (size < MIN_LIST_SIZE)
      throw new RangeError(`status lists hold at least ${MIN_LIST_SIZE} entries`);
    return new OjcpStatusList(new StatusList(new Array(size).fill(Status.VALID), BITS), size);
  }

  static fromCompressed(lst: string, bits: number, size?: number): OjcpStatusList {
    if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8)
      throw new OjcpError("malformed", "invalid status list bits");
    const list = StatusList.decompressStatusListFromBytes(fromBase64url(lst), bits);
    return new OjcpStatusList(list, size ?? list.statusList.length);
  }

  get(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.size)
      throw new OjcpError("malformed", "status index out of range");
    return this.#list.getStatus(index);
  }

  set(index: number, value: StatusValue): void {
    this.#list.setStatus(index, value);
  }

  compressed(): { bits: number; lst: string } {
    return { bits: BITS, lst: base64url(this.#list.compressStatusListToBytes()) };
  }
}

/** Picks an unused, unpredictable index (HAIP §6.1). */
export function allocateIndex(size: number, isUsed: (index: number) => boolean): number {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const index = randomInt(size);
    if (!isUsed(index)) return index;
  }
  throw new OjcpError("policy", "status list is full");
}

export interface StatusListTokenInput {
  /** The list's URI; becomes `sub` and must match the credential's `status.status_list.uri`. */
  uri: string;
  list: OjcpStatusList;
  signer: Signer;
  kid?: string;
  iss?: string;
  /** Seconds. RFC 0014 caps it at 12 hours, RFC 0008 at one hour. */
  ttl: number;
  /** Seconds after `iat` the token expires. */
  lifetime: number;
  now?: Date;
}

export async function signStatusListToken(input: StatusListTokenInput): Promise<string> {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return signJws(
    { typ: STATUS_LIST_JWT_TYP, ...(input.kid ? { kid: input.kid } : {}) },
    {
      sub: input.uri,
      iat,
      exp: iat + input.lifetime,
      ttl: input.ttl,
      ...(input.iss ? { iss: input.iss } : {}),
      status_list: input.list.compressed(),
    },
    input.signer,
  );
}

export const StatusListPayload = z.looseObject({
  sub: z.string(),
  iat: z.number(),
  exp: z.number().optional(),
  ttl: z.number().optional(),
  iss: z.string().optional(),
  status_list: z.looseObject({ bits: z.number().int(), lst: z.string() }),
});
export type StatusListPayload = z.infer<typeof StatusListPayload>;

/** Decodes (does not verify) a Status List Token; verify with `verifyJws` first. */
export function readStatusListToken(token: string): {
  payload: StatusListPayload;
  list: OjcpStatusList;
} {
  const { header, payload } = decodeJws(token);
  if (header.typ !== STATUS_LIST_JWT_TYP)
    throw new OjcpError("malformed", "status list token typ must be statuslist+jwt");
  const parsed = StatusListPayload.safeParse(payload);
  if (!parsed.success) throw new OjcpError("malformed", "invalid status list token payload");
  return {
    payload: parsed.data,
    list: OjcpStatusList.fromCompressed(parsed.data.status_list.lst, parsed.data.status_list.bits),
  };
}
