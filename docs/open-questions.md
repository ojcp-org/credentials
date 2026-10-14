# Decisions and open questions

## Decided

1. **Name.** "OJCP Agent Wallet", published as `@ojcp/agent-wallet` (with `@ojcp/mandate-verifier` and the reference mandate issuer). No "bot": it's the word employers associate with application spam.
2. **Home.** Public from day one at [`ojcp-org/agent-wallet`](https://github.com/ojcp-org/agent-wallet), Apache-2.0, so it reads as neutral tooling rather than a vendor product.
3. **AP2 alignment.** Align with AP2's mandates wherever hiring allows (P-256 keys, SD-JWT-based credentials with key binding, status-list revocation), so one agent wallet can hold both shopping and hiring mandates. RFC 0008 says how the two relate.

## Open

4. **RFC 0010 trust resolution.** Standing mandates can't be used for real until the agent can derive a provider's trust tier itself (RFC 0008 §5.3, RFC 0010 source (a)). Proposed: a separate package, `@ojcp/trust`, in this repository at first. Every agent needs it, not only ones holding mandates, and the registry's "who vouches" view needs the same logic. Until real attesters and trust lists exist, it grades against test trust lists only.
5. **Who runs the sandbox issuer.** RFC 0008 has no central issuer and `registry.ojcp.dev` gets no special status. A sandbox for demos is useful, but it must be clearly a test instance, not "the OJCP issuer".
6. **Candidate authentication at the issuer.** RFC 0008 leaves it to the issuer. Proposed reference default: email or phone one-time code for the binding, plus a passkey for the account.
7. **JVM parity.** Should `ojcp-java-sdk` get a mandate verifier tested against the same fixtures, so the Recruitics provider can verify mandates?
8. **Python.** Port the agent wallet after the TypeScript API settles, on the OpenWallet Foundation's Python SD-JWT library and the shared fixtures.
9. **Employer opt-out.** If PR #40 adds a `standing_not_accepted` reason and per-employer refusal, the coverage engine must read it from employer context and job data before applying.
