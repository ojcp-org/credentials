# Requirement map

Where each requirement is implemented and tested. **core** = `sdks/typescript/core/src`, **AW** = `sdks/typescript/agent-wallet/src`, **V** = `sdks/typescript/verifier/src`, **I** = `services/issuer/src`. Tests: **e2e** = `tests/e2e/`, **vec** = `vectors/` via `tests/vectors.test.ts`.

## RFC 0008: standing mandates

| § | Requirement | Where | Tested by |
|---|---|---|---|
| 2 | SD-JWT VC, `vct`, `vct#integrity` | core `mandate/credential.ts`, `vct.ts`; I issues | vec type-metadata |
| 2.1 | Claim set; no `aud`, `sub`, `iat`, `jti` | core `standingMandateClaims`, `checkDisclosureRule` | core `mandate.test.ts` |
| 2.1 | Disclosure rule (no `_sd`; digests only, and only, in allow-lists; flat disclosed elements) | core `checkDisclosureRule`, V `checkDisclosedElements` | e2e `standing_hidden_restriction`, vec |
| 2.2 | Closed scope; hierarchy containment; residual codes exact; silence not covered | core `onet`, `mandate/scope.ts` | vec onet-containment, scope-coverage; e2e `standing_scope` |
| 2.2 | Salary grid and rungs; highest rung ≤ low end; `unstated` | core `mandate/salary.ts`, `scope.ts` | vec salary-grid; e2e `standing_salary` |
| 2.3 | Candidate binding; exactly one on application tools, none on search; match at submit | AW holder, V | e2e `standing_candidate_mismatch`, `standing_unlinkable` |
| 2.4 | `per_employer` ∈ {1, 2, 3}; total with issuer and agent only | core model, I token response, AW | e2e `standing_per_employer` |
| 2.5 | `breadth` and padded lengths | core | e2e `standing_padding`, `standing_policy` |
| 2.6 | `prohibited` ⊇ binding tokens; actions allow-list | core, I, V | e2e `standing_hidden_restriction` |
| 2.7 | Month epochs, 1–3 months | core `monthEpochs`, V | e2e `standing_unlinkable`, `standing_expired` |
| 3.1 | `authorization_details` with `ojcp_standing_mandate` | AW `openid4vci.ts`, I `issuer.ts` | e2e (every standing test) |
| 3.2 | Verify identifiers; proof keys in the agent's directory, `ojcp_mandate_until` ≥ `exp`; total and floor in the token response | I | e2e |
| 3.3 | Consent page by the issuer from pinned metadata, every listed element | I `pages.tsx` | rendered and checked visually |
| 3.4 | ≥ 32 shared P-256 keys, 7-day rule, batch on a random subset | AW `keyring.ts`, I `config.ts` | e2e |
| 4.1 | Credential per (resource server, employer); fresh for search | AW holder | e2e `standing_unlinkable` |
| 4.2 | KB-JWT `aud`, `nonce`, `sd_hash`, `ojcp_action`; request signed by the `cnf` key | AW holder and `signed-fetch.ts`, V | e2e `standing_replay`, `standing_wrong_agent_key` |
| 4.3 | Replay through the RFC 9421 nonce cache; idempotent submit | V ledger | e2e retry test, `standing_replay` |
| 5.1 | `binding_actions` present and empty | AW, V | e2e `standing_binding_actions` |
| 5.2 | No `eeo` | AW, V | e2e `standing_eeo` |
| 5.3 | Tier from source (a), ≥ `verified` and the floor; `consent_scope` ceiling | AW `trust.ts`, holder; V ceiling | e2e `standing_trust_floor` |
| 6.1 | HMAC count key under per-employer secrets; trailing window | V `ledger.ts`, `standing.ts` | e2e `standing_per_employer` |
| 7.1 | Unpredictable indexes, batches spread, epochs, provider copies ≤ 1 h | I `status.ts`, V `status.ts` | e2e `standing_unlinkable`, `standing_revoked` |
| 7.2 | Revoke every credential of the authorization | I account page | e2e `standing_revoked` |
| 7.3 | Refresh on identical terms; replaced credentials revoked | AW, I | e2e `standing_per_employer` |
| 8 | Steps 1–7, `user_mandate_required`, `details.reason` | V `standing.ts`, `errors.ts` | all |
| 9 | `auth.user_mandates` | core `wire.ts`, V | e2e `standing_policy` |

## Spec *Agent Identity* and *User Mandates* (RFC 0003)

| Requirement | Where | Tested by |
|---|---|---|
| Signing profile, `Content-Digest`, window ≤ 300 s, error codes | core `agent-identity.ts` | core tests, e2e |
| `agent_id` grammar; namespace and delegated binding | core | core tests |
| Key directory with `ojcp_mandate_until` | AW `keyring.ts` | e2e |
| Action statement, `candidate_data_digest`, `binding_actions_digest` | core `action.ts` | vec digests |
| Action-mandate verification and consumption | V `action.ts` | e2e `action.test.ts` |

## RFC 0014 and RFC 0013: hiring credentials

| Requirement | Where | Tested by |
|---|---|---|
| Four types, closed claim sets, coarse claims, lifetime caps, `iat` rounded | core `hiring/types.ts` | core tests, e2e `hiring.test.ts` |
| Every claim disclosable on its own | core | core DCQL test |
| `basis`; organization `id` for platform and source-check records | core, I | core tests |
| Baseline profile: metadata with `ojcp_issuer`, `ojcp_sign_until`, status lists ≥ 10,000 entries | I | e2e |
| Former employees: offer at offboarding, alumni retrieval to the contact on record | I | e2e |
| Verification: pinned keys and signing windows, accepted issuer/type/profile/basis, holder binding, status, unrequested claims dropped | V `presentation.ts` | e2e |
| Contact confirmation for unbound presentations | V `contactMatches` | — |
