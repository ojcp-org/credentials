# Roadmap

Everything tracks draft RFCs. When they change during the comment period (closing November 11, 2026), `vectors/` changes first and the code follows.

## Done (TypeScript, local)

- **Foundations.** pnpm workspace, `@ojcp/credentials-core`, `Signer` interface, RFC 9421 signing profile, mandate key set with `ojcp_mandate_until` and the 7-day rule.
- **The credential.** Standing-mandate SD-JWT VCs: claim set, disclosure rule, fixed padding, salary rungs, `breadth`, `prohibited`, month epochs. Verifier §8 steps 1–6.
- **Applying.** O*NET-SOC hierarchy, coverage engine, disclosure choice, KB-JWT with `ojcp_action`, credential choice per resource server and employer, binding actions and EEO fail closed, the user's total and per-employer counts, signed `fetch`, MCP client.
- **Issuance.** Issuer service with consent page, one-time codes, OpenID4VCI code and refresh flows, batch issuance, status lists on hourly epochs, revocation from an account page.
- **Hiring credentials.** RFC 0014 types and baseline issuer profile (records API, offers with `tx_code`, offboarding, alumni retrieval); RFC 0013 §6.2 presentation validation.
- **Action mandates.** Statement for approval, presentation, verification.
- **Provider trust (RFC 0010).** `@ojcp/trust`: identity keys and key certificates, attestations (JWK or X.509 pinned), trust lists, status, tier derivation and display; its resolver drives the wallet's trust floor.
- **Vectors.** Language-neutral vectors and a TypeScript test that holds the SDK to them.
- **Sandbox.** `services/sandbox`: one story in five persona tabs (record keepers, wallet, assistant, employer, under the hood), every party on its own origin. It covers the RFC 0014 record into a browser wallet and RFC 0013 presentation to an employer that pins the issuers, with the record available from an HR platform, a payroll provider or the employer itself, plus standing mandates, trust incidents, hostile-agent probes and a conformance run against the sandbox's providers. Live at `https://sandbox.ojcp.dev`. Next: the same flow with a real wallet app on a phone.

Proved by 66 tests, including end-to-end runs through the issuer's HTTP handlers (the built-in consent page and the JSON consent API), the agent wallet and a provider built on the verifier, covering every RFC 0008 §10 fixture class except `standing_unlinkable`, and the RFC 0010 §11 fixture groups.

## Next

1. **Python SDK** (`sdks/python`): agent wallet and verifier, on the OpenWallet Foundation's Python SD-JWT library, held to `vectors/`. Agent frameworks are mostly Python.
2. **Kotlin SDK** (`sdks/kotlin`): verifier first, for JVM providers (including the Recruitics provider, which already uses `ojcp-java-sdk`), held to `vectors/`.
3. **Conformance.** Move the RFC 0008 §10 cases into `@ojcp/conformance` as fixtures that drive a provider over the wire, generated from `vectors/`.
4. **Publish.** npm trusted publishing for the three TypeScript packages, and a container image for the issuer.
5. **Issuer gaps.** `jkt` candidate bindings (proof of possession at issuance), the high-assurance profile (`x5c`, wallet and key attestation), ISO mdoc encoding (RFC 0014 §2.4), an Oblivious HTTP client for first status fetches.

## First adopters

- The sandbox deployed at `*.sandbox.ojcp.dev`, with a "Try the sandbox" link from ojcp.dev.
- One provider verifying mandates in production code.
- One agent platform piloting the wallet. Tink is the natural first ask, given its feedback on PR #40.

**Done when:** the pilot agent applies through the pilot provider under a real mandate, and the conformance suite passes both.

## Dependencies and blockers

| Dependency | Why it blocks | Plan |
|---|---|---|
| **Real attesters and lists** | §5.3: standing mandates need a derived `verified` tier, which needs two independent attesting operators on lists the agent pins. None exist yet. | `@ojcp/trust` implements the agent side; recruit a free business-registration attester and two list publishers (RFC 0010 §10). |
| **RFC 0011 key transparency** | Tenure for `audited` comes from logged identity-key lineage. | `KeyLineage` interface; implement against RFC 0011 logs when they exist. |
| **RFC 0009 job codes** | Coverage needs `occupationalCategory` with O*NET codes on postings. No listed provider emits them yet. | Demo against coded jobs; ask providers to add codes as part of 0009 adoption. |
| **Type Metadata at `spec.ojcp.dev`** | `vct#integrity` must match the published bytes. | Publish `vectors/type-metadata/*.json` byte for byte (RFC feedback note 10). |
