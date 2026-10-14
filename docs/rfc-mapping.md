# RFC 0008 requirement map

Where each requirement of [RFC 0008](https://github.com/ojcp-org/ojcp/pull/40) lives. **AW** = `@ojcp/agent-wallet`, **MI** = reference mandate issuer, **MV** = `@ojcp/mandate-verifier`. "Fixture" names the conformance case in RFC 0008 §10 that tests it.

## Credential (§2)

| § | Requirement | Where | Fixture |
|---|---|---|---|
| 2 | SD-JWT VC, `vct` `https://spec.ojcp.dev/vct/standing-mandate/v1`, `vct#integrity` | MI issues, MV checks | — |
| 2.1 | Claim set; no `aud`, `sub`, `acting_on_behalf_of`; no `iat` or `jti` | MI | — |
| 2.1 | Disclosure rule: digests only in the listed allow-lists, no `_sd` anywhere | MI emits, MV rejects violations | `standing_hidden_restriction` |
| 2.2 | Closed `scope`; O*NET hierarchy matching (not string prefix); residual "All Other" codes only exact; unstated or ambiguous means not covered | AW (before applying), MV (authoritative) | `standing_scope` |
| 2.2 | Salary rungs on the grid, floor never sent; agent discloses the highest rung not above the posting's low end; `unstated` only on opt-in | MI computes rungs, AW selects, MV checks | `standing_salary` |
| 2.3 | Candidate binding: email or phone verified by code, or `jkt` by proof of possession; exactly one element disclosed on application actions, none on search | MI verifies, AW discloses, MV matches | `standing_candidate_mismatch` |
| 2.4 | `per_employer` ∈ {1, 2, 3}; overall total kept by issuer and agent only | MI, AW | `standing_per_employer` |
| 2.5 | `breadth` and fixed padded lengths | MI pads, MV checks | `standing_padding` |
| 2.6 | `prohibited` contains `accept_terms` and `accept_offer`; actions allow-list | MI, AW, MV | `standing_binding_actions` |
| 2.7 | Lifetime ≤ 3 months, epoch-aligned times | MI, MV | `standing_policy` |

## Issuance (§3)

| § | Requirement | Where |
|---|---|---|
| 3.1 | OpenID4VCI with `authorization_details` carrying `ojcp_standing_mandate` | AW (client), MI (server) |
| 3.2 | Verify candidate identifiers; verify every proof key in the agent's key directory with `ojcp_mandate_until` ≥ `exp`; return `applications_total` and the floor in the token response | MI |
| 3.3 | Consent page rendered by the issuer from pinned Type Metadata, with every listed element | MI |
| 3.4 | Mandate key set of ≥ 32 shared P-256 keys, 7-day publication rule, batches bound to a random subset | AW (key set), MI (checks) |

## Presentation (§4)

| § | Requirement | Where | Fixture |
|---|---|---|---|
| 4.1 | One credential per (resource server, employer) for application actions; fresh for search; never across resource servers | AW | `standing_unlinkable` |
| 4.2 | KB-JWT: `aud`, `nonce` (signature nonce, or `mandate_nonce` for submit), `sd_hash`, `ojcp_action` digest | AW builds, MV checks | `standing_replay`, `standing_wrong_agent_key` |
| 4.3 | Replay via the RFC 9421 nonce cache; idempotent submit retries | AW, MV | `standing_replay` |

## Authorization limits (§5)

| § | Requirement | Where | Fixture |
|---|---|---|---|
| 5.1 | Submit only if `binding_actions` is present and empty; never answer assent questions | AW stops, MV enforces | `standing_binding_actions` |
| 5.2 | No `eeo` under a standing mandate | AW omits, MV rejects | `standing_eeo` |
| 5.3 | Provider tier from RFC 0010 source (a), at least `verified` and the mandate's trust floor; `consent_scope` ceiling | AW (`TrustResolver`) | `standing_trust_floor` |
| 5.4 | Admission defaults; delegated applications marked for the employer | MV | — |

## Counting, status, keys, verification (§6–§9)

| § | Requirement | Where | Fixture |
|---|---|---|---|
| 6.1 | Count keyed by HMAC(employer, candidate binding), per-employer secret on multi-tenant providers, trailing window | MV | `standing_per_employer` |
| 6.3 | No cross-provider counting service; overall total in the agent | AW | — |
| 7.1 | Unique unpredictable status indexes, batches spread across lists, epochs ≤ 1 h, provider copies ≤ 1 h old | MI, MV | `standing_revoked` |
| 7.2 | Revocation of every credential of the authorization | MI | `standing_revoked` |
| 7.3 | Refresh only on identical terms; anything else needs the user | AW, MI | — |
| 7.4 | Key retirement and compromise handling | AW | — |
| 8 | Verification steps 1–7, fail closed with `user_mandate_required` | MV | all |
| 9 | Read `auth.user_mandates` from the manifest; respect provider maximums | AW reads, MV publishes | `standing_policy` |

## Dependencies on other RFCs

| RFC | What the wallet needs from it |
|---|---|
| [0009](https://github.com/ojcp-org/ojcp/pull/46) | `occupationalCategory` on postings (scope matching) and `binding_actions` on `begin_application` (§5.1) |
| [0010](https://github.com/ojcp-org/ojcp/pull/41) | Effective trust tiers from source (a). A standing mandate can't be exercised without one (§5.3) |
| [0013](https://github.com/ojcp-org/ojcp/pull/44) / [0014](https://github.com/ojcp-org/ojcp/pull/45) | Later: presenting hiring credentials alongside applications |
