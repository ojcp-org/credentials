# Implementation notes for the RFCs

Places where implementing the drafts needed a decision the text doesn't make. Each note gives the choice made here and a suggested wording.

## RFC 0008

1. **Contact at submission (§2.3).** The candidate binding must equal "the corresponding contact field in `application_data`", but `application_data` has no contact field in `submit-application-input.json`. The only contact in the schemas is `candidate_context.email` (RFC 0013 §3 uses it too). *Here:* the verifier takes the submitted contact as an input, and `submittedContact()` reads `candidate_context.email`. A `phone` binding can't be matched at submission until a phone field exists. *Suggest:* name `candidate_context.email` (and a phone field, if added) explicitly.
2. **`unstated` and other currencies or units (§2.2).** `unstated` covers a posting whose salary isn't comparable with the user's floor, including another currency or unit. The provider never learns the floor's currency or unit, so it can't tell "not comparable" from "below the floor": a faulty agent could disclose `unstated` for a USD posting below a USD floor. *Here:* `unstated` covers only postings with no complete low end (none, or no `minValue`); another currency or unit is not covered, on both sides. *Suggest:* either that rule, or disclose the floor's currency and unit as an always-disclosed claim.
3. **KB-JWT `iat` (§4.2).** "Within the validity window of the request signature" is exact only if the KB-JWT is built after signing begins. *Here:* `created − 300 s ≤ iat ≤ expires`. *Suggest:* state the tolerance.
4. **Count window (§6.1).** "A trailing window equal to the provider's maximum lifetime", which is in months. *Here:* calendar months back from now. *Suggest:* say so.
5. **7-day rule (§3.4).** An issuer can only know when it first saw a key. An issuer that starts polling a platform's directory late can't issue for 7 days. *Suggest:* note that issuers poll admitted platforms' directories continuously, or let platforms publish a signed first-publication time.

## Spec *User Mandates*

6. **Consent scope in the statement (*Mandate Nonce*).** For `begin_application` the action statement "MUST still bind … the requested `consent_scope`", but the Action Statement table has no such field. *Here:* a `consent_scope` member, which older readers ignore under the unknown-fields rule. *Suggest:* add it to the table.
7. **Action-mandate KB-JWT nonce.** The profile doesn't say what the KB-JWT `nonce` is for action mandates. *Here:* the request signature's nonce, or the session `mandate_nonce` for submissions, mirroring RFC 0008 §4.2.

## RFC 0014

8. **"Each on its own" (§2.1).** RFC 0013's worked example requests `organization.name` and `positionHistories[].title`, so nested members and array elements must be separately disclosable, not just top-level claims. *Here:* every member and element is its own disclosure; arrays keep their order (a position history is ordered), while RFC 0008 allow-lists are sorted to hide order. *Suggest:* say "every claim, at every depth".
9. **Type Metadata bytes (§2.1).** `vct#integrity` is over the bytes served. *Here:* the served bytes are the JCS serialization of the document, in `vectors/type-metadata/`. *Suggest:* publish exactly those bytes at `spec.ojcp.dev/vct/…`, and state that the JCS form is canonical.
10. **Lifetime cap for undisclosed claims (§2.2, RFC 0013 §6.2).** A license's cap depends on `validTo`, and current employment's on `current`, which the holder may not disclose. *Here:* the verifier applies the cap it can compute from what was disclosed (two years when unknown). *Suggest:* tell verifiers that the lifetime check is against disclosed values, or make `current` and `validTo` always disclosed.

## RFC 0013

11. **First fetch of a status list (§6.2).** It must go through an Oblivious HTTP relay. *Here:* `StatusListCache` takes an injectable `fetch`; no relay client is bundled.

## RFC 0010

12. **How a list's signing key travels (§4.1–4.2).** Agents pin publisher keys by thumbprint, but the list format doesn't say where the key itself is. *Here:* the JWS header carries `jwk`, and its thumbprint must be pinned. *Suggest:* specify `jwk` in the protected header.
13. **Rollover (§4.2).** "Drop a key only when a list signed by a pinned key no longer names it" doesn't say where a key is named. *Here:* after each accepted list, the pin set is that list's signing key plus its `next_keys`. *Suggest:* state that rule.
14. **`anchor_sha256` (§4.1).** The encoding and the hashed object aren't defined, and since the list pins only a hash, the anchor must travel in `x5c`. *Here:* lowercase hex SHA-256 of the anchor certificate's DER, and the anchor must be in the chain. *Suggest:* say both.
15. **Disagreement among three or more (§4.3).** With two operators agreeing and a third disagreeing, the text doesn't say whether the agreeing pair counts. *Here:* any disagreement among accepted identity attestations voids them all (fail closed). *Suggest:* decide explicitly; a majority rule is also defensible but easier to game with a captured attester.
16. **`listed_since` (§3.2).** The type isn't given. *Here:* an ISO 8601 date-time or a NumericDate.
17. **Attestation key types (§3.3).** RSA and P-384 anchors are allowed for chains, but the end-entity key verifies attestations only if it is P-256 (ES256) or Ed25519 here. *Suggest:* pin ES256 for attestation signatures, as HAIP does.
18. **Private addresses after DNS (§5.2, *Key Discovery*).** Refusing private and link-local addresses needs the resolved IP, which portable code can't see. *Here:* the guarded fetcher refuses IP literals and local names; the deployment's `fetch` must refuse private addresses after resolution.
