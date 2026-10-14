# Prior art

## Closest sibling: AP2 (Agent Payments Protocol)

Google's [AP2](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol), announced September 2025 with more than sixty payments and technology partners, solves the same problem for shopping:

- an **Intent Mandate** in which the user pre-approves conditions (budget, categories, timing) so an agent can act later without the user present: the counterpart of RFC 0008's standing mandate;
- per-transaction mandates when the user is present: the counterpart of OJCP's action mandate;
- mandates as signed credentials (ECDSA P-256; described as SD-JWTs in a [2026 security analysis](https://arxiv.org/pdf/2608.23858)).

Why OJCP doesn't reuse AP2's mandate format directly: hiring needs things payments doesn't, namely candidate binding, per-employer caps enforced by the receiving side, job-code scope, a hidden salary floor, and binding actions a mandate can never sign. Where formats can line up (key binding, field naming, status), they should, so one agent wallet can hold both shopping and hiring mandates.

## Reusable building blocks

| Project | What it provides | Use here |
|---|---|---|
| [sd-jwt-js](https://github.com/openwallet-foundation/sd-jwt-js) (OpenWallet Foundation) | SD-JWT, SD-JWT VC, Token Status List | Credential format and status |
| [oid4vc-ts](https://openwallet.foundation/2025/02/25/openid4vc-dcql-and-openid-federation-three-new-fundamental-typescript-projects-incubated-at-openwallet-foundation) and dcql-ts (OpenWallet Foundation) | OpenID4VCI and OpenID4VP, DCQL | Issuance client and server; RFC 0013 later |
| [web-bot-auth](https://blog.cloudflare.com/web-bot-auth) (Cloudflare) | RFC 9421 HTTP message signatures for agents (`http-message-sig`) | Request signing, the same scheme as OJCP agent identity |
| [EQUS Credentials SDK](https://github.com/equs-ai/equs-credentials-sdk) | Rust core with Node, WASM, Android and iOS wrappers; SD-JWT VC, OpenID4VC, experimental delegated SD-JWT chains with AP2 support | Closest general-purpose "agent credentials" SDK; small project, so a reference rather than a dependency |

## Standards work to track

- [Delegated SD-JWT](https://datatracker.ietf.org/doc/draft-gco-oauth-delegate-sd-jwt/) (`draft-gco-oauth-delegate-sd-jwt`): chains of SD-JWT delegation. If it matures, mandate issuance could become a standard delegation hop.
- [AI Agent Authentication and Authorization](https://www.ietf.org/archive/id/draft-klrc-aiagent-auth-03.html) (`draft-klrc-aiagent-auth`, informational; authors from Okta, OpenAI, Ping Identity and others).
- [Credential Delegation Protocol for AI Agents](https://www.ietf.org/archive/id/draft-sweeney-wimse-credential-delegation-00.html) (`draft-sweeney-wimse-credential-delegation`), proposed to the IETF WIMSE working group.

## What doesn't exist yet

No project provides hiring-specific mandate scope (job codes, salary floors, per-employer caps, binding-action exclusions), an agent-side wallet that binds mandates to OJCP actions, or hiring credential types. That is the layer this project adds.
