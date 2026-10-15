# Architecture

Section references (§) are to [RFC 0008](https://github.com/ojcp-org/ojcp/pull/40) unless stated otherwise.

## Roles

RFC 0008 assigns the OpenID4VCI roles like this (§3.1):

| OpenID4VCI role | Who |
|---|---|
| Credential Issuer and Authorization Server | The **mandate issuer** (`services/issuer`) |
| Wallet (holds credentials) | The **agent platform** (`@ojcp/agent-wallet`), not the person |
| End-User | The **candidate**, who proves an email or phone and approves the consent page |

That is why the agent wallet is a server-side library: the platform holds credentials and keys for all its users. Hiring credentials (RFC 0014) go the other way: they are held in the **person's own wallet app** and presented straight to the employer (RFC 0013); the agent never sees them.

## Packages

```mermaid
flowchart TB
  subgraph AP[Agent platform]
    LLM[Agent / LLM tooling] --> AW
    subgraph AW["@ojcp/agent-wallet"]
      KR[AgentKeyring<br/>request key + mandate key set]
      VCI[OpenID4VCI client]
      H[StandingMandateHolder]
      SF[createSignedFetch]
      MCP[connectOjcpProvider]
    end
  end
  subgraph IS[services/issuer]
    AS[Consent + OAuth]
    CI[Credential endpoint]
    SL[Status lists]
    REC[Record API]
  end
  subgraph JP[Job provider]
    V["@ojcp/verifier"]
    L[(Ledger: nonces + counts)]
  end
  W[Person's wallet app] -->|RFC 0013 presentation| V
  VCI <-->|OpenID4VCI| AS
  VCI <-->|OpenID4VCI| CI
  W <-->|OpenID4VCI pre-authorized| CI
  MCP --> SF -->|RFC 9421 + user_mandate| V
  V -->|scheduled fetch| SL
  V --- L
  KR -->|key directory| V
  KR -->|key directory, polled| CI
  AW & V & IS --> CORE["@ojcp/credentials-core"]
```

### `@ojcp/credentials-core`

| Module | Contents |
|---|---|
| `keys`, `jws`, `encoding`, `digest` | The `Signer` interface (WebCrypto, or any HSM/KMS behind it), RFC 7638 thumbprints, compact JWS with the algorithm taken from the key, JCS and the OJCP `sha256:` digest |
| `sd-jwt` | RFC 9901 issuance with exact decoy padding and order-hiding (or order-keeping) arrays, strict parsing and reconstruction, selective presentation by predicate or DCQL claim path, KB-JWTs with extra claims |
| `agent-identity` | The spec's RFC 9421 signing profile (`created`, `expires` ≤ 300 s, `nonce`, `keyid`, `tag=web-bot-auth`, `Content-Digest`), verification with the spec's error codes, `agent_id` grammar, namespace and delegated binding |
| `action` | Action statements, `candidate_data_digest`, `binding_actions_digest` |
| `mandate/*` | The standing-mandate model and claim builder, the disclosure rule and padding checks, the salary grid, scope coverage |
| `onet` | O*NET-SOC 2019 hierarchy containment (never string prefix; residual "All Other" only exact) |
| `hiring/types`, `vct` | The four RFC 0014 types (issue and presented schemas), coarse claims, lifetime caps, `basis`; Type Metadata and `vct#integrity` |
| `status-list` | Token Status Lists with ≥ 10,000 entries and unpredictable indexes |
| `wire` | zod schemas for the OJCP shapes consumed (job facts, binding actions, agent declaration, `auth.user_mandates`) |

### `@ojcp/agent-wallet`

| Module | Responsibility | RFC 0008 |
|---|---|---|
| `AgentKeyring` | Request-signing key; mandate key set of ≥ 32 shared P-256 keys with `ojcp_mandate_until`; eligibility (published ≥ 7 days, valid past `exp`); key directory document | §3.4, §7.4 |
| OpenID4VCI client | `beginStandingMandate` (PKCE, `authorization_details`), `completeStandingMandate`, `refreshStandingMandate`; one proof per randomly chosen eligible key | §3.1, §3.2, §7.3 |
| `StandingMandateHolder` | Credential choice (one per resource server and employer; fresh for search; never across resource servers), coverage on the full scope, trust floor from RFC 0010 source (a) only, binding actions and EEO fail closed, the user's total and own per-employer count, disclosure choice, KB-JWT with `ojcp_action` | §2.2–2.3, §4, §5, §6.3 |
| `createSignedFetch` | Signs every request; for a call carrying a standing mandate, signs with the `cnf` key and reuses the KB-JWT nonce (except `submit_application`) | §4.2 |
| `connectOjcpProvider` (`@ojcp/agent-wallet/mcp`) | MCP client over the signed fetch | — |
| Action mandates | Statement for approval; presentation with a KB-JWT by the agent key | spec *User Mandates* |
| `TrustResolver` | Interface the wallet consumes: an effective tier and its source. `@ojcp/trust`'s `DerivedTrustResolver` implements it | §5.3 |

### `@ojcp/trust` (RFC 0010)

| Module | Responsibility | RFC 0010 |
|---|---|---|
| `identity` | `did:web` organization identifier from the origin; the single identity key in `ojcp-keys.json`; key certificates (`ojcp_cert`) | §2 |
| `manifest` | The spec's *Validation Procedure* (ES256/ES384/RS256/RS384, its error codes) plus the `ojcp_cert` condition for derivation; `signManifest` for providers | §2.2 |
| `attestation` | The seven types with required claims and lifetime caps; issuer keys only from pinned lists; subject binding to the identity key or a logged predecessor; the tenant namespace rule; distrust with the agent's own acceptance records; `issueAttestation` for attesters | §3 |
| `x509` | Chains validated to a pinned anchor, CA flags, validity, a URI SAN equal to `iss`, SPKI hashes for distrust | §3.3 |
| `status` | Status List Tokens on the attester's origin, signed by its pinned key, with `exp` and `ttl`, cached at most 24 hours; unresolved is absent | §3.4 |
| `trust-list` | Key-pinned lists from any mirror, `next_keys` rollover, `iat` ordering, 7-day cap, grants that lapse, distrust that doesn't, operators grouped across lists; `signTrustList` for publishers | §4 |
| `derive`, `resolver` | Steps 1–5 with the fetch caps, two agreeing operators for `verified`, conformance, security review and 90 days of tenure for `audited`; source (b) from a pinned index during migration only; caching bounded by every input | §4.3, §5 |
| `display` | Attested legal name and jurisdiction, A-label host, both parties for hosted origins, employer confirmed only by an independent `hosted-employer` attestation | §3.5, §5.5 |
| `fetcher` | HTTPS only, no IP literals or local names, 256 KB, per-evaluation budgets | §5.2 |

Tenure comes from RFC 0011 through a `KeyLineage` interface. Without a log and witness policy no tenure is known, so `audited` is reachable only through `listing-tenure` during migration.

### `@ojcp/verifier`

| Export | Responsibility |
|---|---|
| `verifyStandingMandate` | §8 steps 1–6. Returns a decision to bind to the session (step 7); for submissions, a `commit()` that atomically consumes `mandate_nonce` and records the count |
| `verifyActionMandate` | Spec *User Mandates → Verification*: digest or embedded statement, `cnf.jkt`, lifetime, status or single use, `jti` and `mandate_nonce` consumption |
| `verifyHiringPresentation` | RFC 0013 §6.2 steps 2–5 for `dc+sd-jwt`: pinned keys and signing windows, accepted issuer/type/profile/basis, time, holder binding, status, dropping unrequested claims; `contactMatches` for the §3 confirmation |
| `StatusListCache` | Scheduled, verified status-list copies with a maximum age; injectable fetch (for an Oblivious HTTP relay) |
| `MandateLedger` | Interface plus an in-memory implementation; the count key is HMAC under a per-employer secret |
| `MandateRejected` | `toToolError()` gives the wire error; the failure class stays internal |

### `services/issuer`

`Issuer` holds the protocol logic; `createApp` is a thin Hono layer; `IssuerStore` has in-memory and SQLite (`node:sqlite`) implementations. Status lists, their used indexes and queued changes are persisted, so restarts never forget a revocation. Integrations a deployment supplies: `Messenger` (webhook in production), `MandateKeySource` (polls agent key directories and records first-seen times).

### `services/sandbox`

A test world on separate origins, in one process: `main.ts` routes each request by Host. `SandboxWorld` builds the parties. They include three keepers of the candidate's work record (an HR platform, a payroll provider and the employer itself, in `sources.ts`) and a permission service, all instances of `services/issuer`. The permission service is run by the candidate's wallet provider: its `consentUi` sends consent to a wallet screen, where the owner, already verified by the wallet, approves with `Issuer.approveSignedIn` and no code; the wallet lists and cancels permissions. There's also a wallet (`wallet/`) that collects records over OpenID4VCI and presents them over OpenID4VP, and attesters and a list publisher from `@ojcp/trust`. Providers run on `@ojcp/verifier`, each with a signed manifest, key set and MCP endpoint. Acme adds RFC 0013 wallet steps (`provider/wallet-step.ts`): contact-first bound sessions, `x509_hash` requests under a sandbox verifier CA (`pki.ts`), and encrypted responses checked by `verifyHiringPresentation`. `SandboxAgent` drives `@ojcp/agent-wallet` and `@ojcp/trust` the way an agent platform would, and checks its own credentials' status, so a cancellation stops it. `CandidateView` and `Assistant` (JobGPT) turn its results into what a candidate sees. The pages are one React and Mantine app (`ui/`) served on every origin with a bootstrap naming the persona. `/_sandbox/` on every origin serves the story, timeline and lab. Protocol traffic between parties always goes over HTTPS through DNS, never through in-process calls, so the timeline shows what crossed the wire. The exceptions are a party reaching into its own systems (the wallet app and the permission service run by the same provider) and the lab's incidents, which act as an operator would.

## Libraries

| Need | Choice |
|---|---|
| SD-JWT | Own implementation in core: RFC 0008 needs exact padding, the disclosure rule on the raw payload, and KB-JWT extra claims. Interoperability is tested against the OpenWallet Foundation's `@sd-jwt/sd-jwt-vc` in both directions. |
| Token Status List | `@owf/token-status-list` |
| RFC 9421 | `http-message-sig` (Cloudflare) |
| JWK thumbprints | `jose` |
| JCS (RFC 8785) | `canonicalize` |
| Validation | `zod` 4 |
| HTTP | `hono`, `@hono/node-server` |
| MCP | `@modelcontextprotocol/sdk` (optional peer dependency) |

Toolchain: TypeScript 7, ESM only, pnpm workspaces, tsdown, vitest, Biome. Sources run directly in development through the `source` export condition.

## Several languages

Each language gets a native SDK under `sdks/<language>/`, built on that ecosystem's libraries. Consistency comes from `vectors/` and `data/onet/`, generated by `scripts/` and checked by every SDK's tests, not from sharing one implementation.

## Security notes

- **Keys.** Mandate keys are shared across a platform's users by design (§3.4); candidate binding limits each credential to its own candidate.
- **Fail closed in the agent too.** The holder refuses before the provider would: uncovered jobs, binding actions, EEO, trust below the floor or not derived.
- **Nothing reveals which check failed.** Every mandate refusal on the wire is `user_mandate_required`, with `details.reason` only for the two policy-dependent cases.
- **No cross-employer counting.** The user's total lives with the agent; providers count per employer, keyed by an HMAC they can't join across employers.
