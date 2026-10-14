# OJCP issuer

A self-hostable issuer for OJCP credentials:

- **Standing mandates** (RFC 0008): OpenID4VCI authorization code flow with `authorization_details` carrying `ojcp_standing_mandate`, a consent page the issuer renders itself (or the operator's own: see `OJCP_CONSENT_UI`), one-time codes for each candidate binding, batch issuance bound to the agent platform's published mandate keys, refresh on identical terms, and revocation from an account page. An operator that already verified the person, such as a wallet provider whose app is unlocked, approves with `Issuer.approveSignedIn(id, verified, selection)` instead of codes; the request may name only identifiers in `verified`.
- **Hiring credentials** (RFC 0014, baseline profile): employment, education, professional license and certification records, issued over the pre-authorized code flow with a transaction code sent by a separate channel, former-employee offers, and status updates.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /.well-known/openid-credential-issuer` | Credential Issuer Metadata with `ojcp_issuer` (RFC 0014 §6) |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata |
| `GET /.well-known/jwt-vc-issuer` | Signing key with `ojcp_sign_until` (RFC 0014 §5.1) |
| `GET /authorize`, `POST /authorize/:id/send-codes`, `POST /authorize/:id/approve` | Consent (RFC 0008 §3.3) |
| `GET /api/consent/:id`, `POST /api/consent/:id/codes`, `POST /api/consent/:id/approve`, `POST /api/consent/:id/deny` | The same consent as JSON, for an operator's own screen: the plain-language view, sending the codes, and approving (`{codes, selection}`, where the selection can only narrow) or declining. Both return `{redirect}` back to the agent. |
| `POST /token`, `POST /nonce`, `POST /credential` | OpenID4VCI |
| `GET /offers/:id` | Credential Offer by reference |
| `GET /status/:n` | Token Status List (`statuslist+jwt`) |
| `GET /account` … | One-time code sign-in, list and cancel standing mandates (RFC 0008 §7.2) |
| `POST /alumni` | Former-employee retrieval: offers go only to the personal email on record (RFC 0014 §5.3) |
| `PUT /admin/records/:id`, `POST /admin/records/:id/{offer,offboard,revoke}` | Record-holder API for an HRIS or registrar (bearer token) |

## Configuration

| Variable | Meaning |
|---|---|
| `OJCP_ISSUER_URL` | The `iss` origin |
| `PORT` | Listen port (default 8080) |
| `OJCP_SIGNING_KEY` | Private P-256 JWK. Keep it separate from any single sign-on key. |
| `OJCP_SIGN_UNTIL` | `ojcp_sign_until` for the key (Unix seconds). Announce a new key 14 days before first use. |
| `OJCP_CLIENTS_FILE` | JSON array of agent platforms: `clientId`, `name`, `agentId`, `redirectUris`, `keyDirectory` (origin), `affiliated` (whether this issuer shares control with the platform) |
| `OJCP_STATUS_LISTS` | Number of status lists (default 4, at least 2) |
| `OJCP_DATABASE` | SQLite file (default `issuer.db`) |
| `OJCP_POLICY_URI` | Practice statement URL |
| `OJCP_CONSUMER_REPORTING_AGENCY` | `true`/`false`; required before issuing `customer_records` or `source_check` records |
| `OJCP_ADMIN_TOKEN` | Enables the record-holder API |
| `OJCP_COOKIE_SECRET` | Signs the account-page cookie |
| `OJCP_MESSENGER_WEBHOOK` | URL that receives `{to, subject, text}` for every code and offer. Required in production; without it, messages are logged (development only). |
| `OJCP_DISPLAY_NAME` | The issuer's name for wallets (OpenID4VCI `display`) |
| `OJCP_CONSENT_UI` | The operator's own consent screen, as a path on this origin or an `https://` URL, with `{id}`, e.g. `https://wallet.example/permissions/{id}` for a wallet provider that renders consent in its app. `/authorize` then redirects there. That screen reads the request with `Issuer.consent` or the JSON consent API. Unset: the built-in page. |
| `OJCP_ACCOUNT_UI` | The operator's own screen for seeing and cancelling permissions, an `https://` URL such as `https://wallet.example/#permissions`. The account pages then redirect there. Unset: the built-in account pages, signed in with a one-time code. |

The service polls each agent platform's key directory hourly to record when every mandate key first appeared (the 7-day rule) and applies status changes at hourly epochs.

## Limits of this reference

- Candidate bindings are verified for email and phone; `jkt` bindings are refused.
- Only the baseline profile: no `x5c`, wallet attestation or key attestation.
- SD-JWT VC only; no ISO mdoc encoding yet.
