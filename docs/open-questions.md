# Decisions and open questions

## Decided

1. **Name and home.** `ojcp-org/credentials`, Apache-2.0. Packages: `@ojcp/agent-wallet`, `@ojcp/verifier`, `@ojcp/credentials-core`, and the `services/issuer` service.
2. **AP2 alignment.** P-256 keys, SD-JWT with key binding and status lists, as in AP2's mandates, so one holder can carry shopping and hiring mandates. RFC 0008 says how the two relate.
3. **Several languages.** A native SDK per language under `sdks/`, built on that ecosystem's libraries, all held to `vectors/`. No shared native core.
4. **Trust.** The wallet consumes RFC 0010 tiers only through a `TrustResolver` interface and accepts only derived tiers for standing mandates.
5. **Own SD-JWT code.** RFC 0008 needs exact padding, checks on the raw payload and KB-JWT extra claims, which the general-purpose libraries don't expose. Interoperability with the OpenWallet Foundation implementation is tested.
6. **Candidate authentication at the reference issuer.** A one-time code to each email or phone the mandate binds, and again to cancel.

## Open

7. **Where RFC 0010 lives.** Proposed: a separate `@ojcp/trust` package. Every agent needs it, not only those holding mandates, and the registry needs the same logic.
8. **Who runs a sandbox issuer.** RFC 0008 has no central issuer. A sandbox is useful for demos, but it must be clearly a test instance.
9. **Employer opt-out.** If PR #40 adds a `standing_not_accepted` reason and per-employer refusal, the holder must read it before applying.
10. **Account security at the issuer.** One-time codes prove control of the contact. A passkey for returning users would make cancellation and renewal harder to hijack.
