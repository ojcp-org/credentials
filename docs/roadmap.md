# Roadmap

Each milestone ends with something runnable and a test that proves it. Everything tracks draft RFCs; when they change during the comment period (closing November 11, 2026), the fixtures change first and the code follows.

## M0: Foundations

- pnpm workspace with three packages (`agent-wallet`, `mandate-verifier`, `mandate-issuer`), CI, npm trusted publishing.
- RFC 0008's conformance cases (§10) added to `@ojcp/conformance` as shared fixtures, so every implementation tests against the same vectors.
- `Signer` and `Store` interfaces with in-memory implementations.
- Mandate key set: generate, publish in the agent key directory with `ojcp_mandate_until`, enforce the 7-day rule.
- RFC 9421 request signing through `http-message-sig`.

**Done when:** requests signed by the wallet pass the existing agent-identity checks in `@ojcp/conformance`.

## M1: The credential

- Build and verify standing-mandate SD-JWT VCs: claim set, disclosure rule, fixed padding, salary grid rungs, `breadth`, `prohibited`, lifetime.
- `mandate-verifier` §8 steps 1–4 for credentials (holder proof, admission, audience and time, scope).

**Done when:** every credential-level fixture passes in `mandate-verifier`, and credentials produced by the issuer library pass it.

## M2: Applying

- Coverage engine: bundled O*NET-SOC 2019 hierarchy, locations, remote policy, employment type, experience level, salary rung selection.
- Presentation builder: disclosure selection, KB-JWT with `ojcp_action` (JCS digest of the action statement), credential selection per resource server and employer.
- Policy checks: `binding_actions` present and empty, no `eeo`, consent-scope ceiling, overall total and own per-employer count.
- `mandate-verifier`: status checks, replay, idempotent submit, per-employer count (HMAC keyed, per-employer secrets).
- MCP client helper.

**Done when:** an end-to-end test runs search, `begin_application` and `submit_application` against a local OJCP provider using `mandate-verifier`: covered jobs are accepted, and each rejection fixture is refused with `user_mandate_required`.

## M3: Issuance

- Reference mandate issuer: authorization server with `authorization_details`, candidate verification (email or phone code, `jkt` proof of possession), consent page from pinned Type Metadata, batch issuance, status lists on epochs, revocation, dashboard.
- Wallet issuance client and refresh on identical terms.

**Done when:** a person approves a mandate on the consent page, the agent applies to a covered job, and revoking at the dashboard stops further applications within one status epoch.

## M4: First adopters

- Sandbox deployment for demos and integration testing (operator to decide; see Open questions).
- One provider verifying mandates in production code: a TypeScript provider through `mandate-verifier`, or the Recruitics provider through the same fixtures on the JVM.
- One agent platform piloting the wallet. Tink is the natural first ask, since its feedback on PR #40 is about how agents should behave under standing mandates.

**Done when:** the pilot agent applies through the pilot provider under a real mandate, and the conformance suite passes both.

## Dependencies and blockers

| Dependency | Why it blocks | Plan |
|---|---|---|
| **RFC 0010 trust tiers** | §5.3: an agent may exercise a standing mandate only after deriving the provider's tier from source (a). No implementation of 0010 exists yet. | M2 uses a test `TrustResolver`. Real use needs an 0010 implementation, a separate workstream. |
| **RFC 0009 job codes** | Scope matching needs `occupationalCategory` with O*NET codes on postings. No listed provider emits them today. | Demo against the ojcp.dev reference provider with coded jobs; ask providers to add codes as part of 0009 adoption. |
| **RFC 0008 changes** | The employer opt-out under discussion on PR #40 (a `standing_not_accepted` reason, per-employer refusal) changes verifier and wallet behaviour. | Track the PR; fixtures first. |
