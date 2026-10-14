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
