# Decisions and open questions

## Decided

1. **Name and home.** `ojcp-org/credentials`, Apache-2.0. Packages: `@ojcp/agent-wallet`, `@ojcp/verifier`, `@ojcp/credentials-core`, and the `services/issuer` service.
2. **AP2 alignment.** P-256 keys, SD-JWT with key binding and status lists, as in AP2's mandates, so one holder can carry shopping and hiring mandates. RFC 0008 says how the two relate.
3. **Several languages.** A native SDK per language under `sdks/`, built on that ecosystem's libraries, all held to `vectors/`. No shared native core.
4. **Trust.** RFC 0010 lives in its own package, `@ojcp/trust`: every agent needs it, not only those holding mandates, and indexes need the same logic. The wallet consumes it only through `TrustResolver` and accepts only derived tiers for standing mandates.
5. **Own SD-JWT code.** RFC 0008 needs exact padding, checks on the raw payload and KB-JWT extra claims, which the general-purpose libraries don't expose. Interoperability with the OpenWallet Foundation implementation is tested.
6. **Candidate authentication at the reference issuer.** A one-time code to each email or phone the mandate binds, and again to cancel.
7. **The sandbox.** A test world of its own at `*.sandbox.ojcp.dev`, not part of ojcp.dev: it needs many origins and a stateful backend, and must never pass for OJCP infrastructure. Every page says it uses test keys and made-up data. Its issuer exists only inside it; there is still no production issuer.

## Open

8. **Employer opt-out.** If PR #40 adds a `standing_not_accepted` reason and per-employer refusal, the holder must read it before applying.
9. **Account security at the issuer.** One-time codes prove control of the contact. A passkey for returning users would make cancellation and renewal harder to hijack.
