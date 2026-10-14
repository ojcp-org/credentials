/**
 * Issuer persistence. Every record kind is a typed collection; the in-memory
 * implementation serves tests and local development, and a deployment
 * implements the same interface over its database.
 */
import type { Basis, HiringType, JWK, ParsedStandingMandateDataset } from "@ojcp/credentials-core";

export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  credentialConfigurationId: string;
  dataset: ParsedStandingMandateDataset;
  /** Identifiers proven by one-time code, as normalized JSON. */
  verified: string[];
  createdAt: number;
}

export interface Otp {
  id: string;
  /** Normalized identifier JSON. */
  identifier: string;
  codeHash: string;
  /** Wrong guesses so far, across every code sent for this request. */
  attempts: number;
  /** Codes sent for this request: each resend is another message to the person. */
  sends: number;
  expiresAt: number;
}

/** An approved standing mandate (RFC 0008 §3.2: the issuer keeps the floor and total here). */
export interface MandateAuthorization {
  id: string;
  clientId: string;
  agentId: string;
  dataset: ParsedStandingMandateDataset;
  nbf: number;
  exp: number;
  approvedAt: number;
  revoked: boolean;
}

export interface Grant {
  /** Hash of the code, token or refresh token. */
  id: string;
  kind: "code" | "access" | "refresh" | "pre_authorized";
  subject: { kind: "mandate"; authorizationId: string } | { kind: "record"; recordId: string };
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  txCodeHash?: string;
  expiresAt: number;
  used: boolean;
}

export interface CNonce {
  id: string;
  expiresAt: number;
}

/** A person's record held by a hiring-credential issuer (RFC 0014). */
export interface SubjectRecord {
  id: string;
  type: HiringType;
  basis: Basis;
  record: Record<string, unknown>;
  holderName?: { given_name?: string; family_name?: string };
  /** Personal contacts captured on record (RFC 0014 §5.3), never work accounts. */
  personalEmail?: string;
  personalPhone?: string;
  updatedAt: number;
}

/** What the issuer keeps about an issued credential: enough to revoke it, nothing more. */
export interface IssuedCredential {
  id: string;
  subject: Grant["subject"];
  statusUri: string;
  statusIdx: number;
  exp: number;
  issuedAt: number;
}

export interface Offer {
  id: string;
  recordId: string;
  preAuthorizedCode: string;
  txCodeRequired: boolean;
  expiresAt: number;
}

export interface ObservedKey {
  /** `${agentId}#${thumbprint}` */
  id: string;
  jwk: JWK;
  until: number;
  firstSeen: number;
}

/** A persisted status list, its allocated indexes, and changes queued for the next epoch. */
export interface StoredStatusList {
  /** The list URI. */
  id: string;
  bits: number;
  lst: string;
  size: number;
  used: number[];
  pending: Array<[idx: number, value: number]>;
}

export interface Collections {
  pending: PendingAuthorization;
  otp: Otp;
  authorization: MandateAuthorization;
  grant: Grant;
  cnonce: CNonce;
  record: SubjectRecord;
  issued: IssuedCredential;
  offer: Offer;
  observedKey: ObservedKey;
  statusList: StoredStatusList;
}

export interface IssuerStore {
  get<K extends keyof Collections>(kind: K, id: string): Promise<Collections[K] | undefined>;
  put<K extends keyof Collections>(kind: K, value: Collections[K]): Promise<void>;
  delete<K extends keyof Collections>(kind: K, id: string): Promise<void>;
  list<K extends keyof Collections>(
    kind: K,
    filter?: (value: Collections[K]) => boolean,
  ): Promise<Collections[K][]>;
}

export class InMemoryIssuerStore implements IssuerStore {
  readonly #data = new Map<string, Map<string, unknown>>();

  #collection(kind: string): Map<string, unknown> {
    let c = this.#data.get(kind);
    if (!c) {
      c = new Map();
      this.#data.set(kind, c);
    }
    return c;
  }

  async get<K extends keyof Collections>(kind: K, id: string): Promise<Collections[K] | undefined> {
    return structuredClone(this.#collection(kind).get(id)) as Collections[K] | undefined;
  }

  async put<K extends keyof Collections>(kind: K, value: Collections[K]): Promise<void> {
    this.#collection(kind).set(value.id, structuredClone(value));
  }

  async delete<K extends keyof Collections>(kind: K, id: string): Promise<void> {
    this.#collection(kind).delete(id);
  }

  async list<K extends keyof Collections>(
    kind: K,
    filter?: (value: Collections[K]) => boolean,
  ): Promise<Collections[K][]> {
    const all = [...this.#collection(kind).values()].map(
      (v) => structuredClone(v) as Collections[K],
    );
    return filter ? all.filter(filter) : all;
  }
}
