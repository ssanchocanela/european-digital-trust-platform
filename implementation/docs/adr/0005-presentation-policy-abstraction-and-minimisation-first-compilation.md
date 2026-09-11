# ADR 0005 — Presentation policy abstraction and minimisation-first compilation

- **Status:** ACCEPTED (Phase 0 checkpoint, 11 September 2026)
- **Date:** 11 September 2026
- **Decision 6 resolved by the user at the Phase 0 checkpoint:** `SAME_DEVICE` is the tested V0 path.

## Context

The implementation prompt's §6.1–§6.4 define a versioned, business-oriented `PresentationPolicy`, a
compiler producing an immutable `VerificationPlan`, two result policies, and a minimisation-first
rule whose worked example is: "for an age check, request `age_over_18` from the PID rather than the
birth date", with a fallback because ARF notes those attributes are present only "if present".

Phase 0 verified that worked example against the pinned baseline and **it is no longer
implementable**. That finding, and the TS5 v1.5 data model, reshape this ADR.

## Decision 1 — The policy model, corrected against TS5 v1.5

TS5 v1.5 (20.08.2026) is the Registrar's data model and the platform's policy must be expressible in
it. Four corrections to the prompt's §6.1 shape:

### 1a. `purpose` is a localised collection, not a string

TS5 `IntendedUse.purpose` is `[1..*]` of `MultiLangString`, and the purpose "SHALL be possible to be
displayed localised to the User's language", with localisations "provided for all official languages
of Member States where the intended use is provided", per Annex E of ETSI TS 119 612 V2.3.1. It is
user-facing: `AS-WP-06-015` (`RPA_10`) requires the Wallet, when asking for approval, to show "the
User-friendly description of the Relying Party's intended use and the link to the applicable privacy
policy".

So `PresentationPolicyVersion.purpose` is `Array<{lang, value}>`, not `string`. This also matches
EUDIPLO, whose `registrationCert.body.purpose` is already `[{lang, value}]`.

### 1b. `privacyPolicy` belongs on `IntendedUse`

TS5 makes it `[1..*]`, and `RPA_10` makes the Wallet link it. `IntendedUse` carries it; EUDIPLO
requires it as `registrationCertificateDefaults.privacy_policy`. A policy version cannot be published
against an intended use that lacks one.

### 1c. `requestedClaims` are OpenID4VP claim **paths**

TS5 `Claim.path` is `[1..1]`, "a path pointer that specifies the path to a claim within the
`Credential`… a non-empty array of strings, nulls and non-negative integers", per OpenID4VP §6.3, with
§7.1 for SD-JWT VC and §7.2 for mdoc. So:

```
requestedClaims: Array<{ path: (string | number | null)[] }>
```

not `string[]`. The subset check in Decision 2 is a **path**-subset check. A flat string comparison
would be wrong in both directions: it would accept `["address","street_address"]` when only
`["address"]` is registered (over-asking a nested claim), and it would reject a correctly nested path
that differs only in serialisation. For mdoc the first segment is the namespace
(`["eu.europa.ec.eudi.pid.1","birth_date"]`), which a flat model would flatten away.

This is the most error-prone detail in the whole policy layer, and it is the one a naive
implementation will get wrong silently.

### 1d. `serviceIdentifier` is optional in TS5; the platform requires it anyway

TS5 `WalletRelyingPartyService.serviceIdentifier` is `[0..1]` and may be omitted for a single-service
RP that needs no service-bound access certificates and uses no intermediary — but **SHALL** be
registered if the RP relies on an intermediary. The platform's model is multi-service from the start
and its EUDIPLO tenant mapping is per Service
([ADR 0002](0002-eudiplo-as-wrapped-engine.md) Decision 3), so it requires the identifier
unconditionally. That is a deliberate stricter-than-TS5 choice, recorded as such and **not** a
conformance claim.

### 1e. Confirmed as written

- `RegistrationCertificate` = the JWT for **exactly one intended use of one Service**. Confirmed by
  `EW-DM-44-014` (`RPRC_09`): "a separate registration certificate for each combination of intended
  use and Relying Party Service, as registered by the Relying Party per `Reg_10d`".
- One registration certificate per request, **by value**. `EW-DM-44-023` (`RPRC_19`).
- V0's "one credential requirement per policy, modelled as a one-element list" is a platform-side
  narrowing of TS5's `IntendedUse.credentials` `[1..*]`, so multi-attestation intended uses are a
  later addition without migration, exactly as the prompt intends.

## Decision 2 — Validation: the claim-path subset check, at publication time

`requestedClaims` must be a **path-subset** of the claims registered for the referenced
`IntendedUse`, for the referenced credential type and format. A violation fails publication with
HTTP **422** and an explicit error naming the offending path. The compiler re-checks at transaction
time.

Path-subset semantics:

- a requested path is permitted if it equals a registered path, or if it **extends** a registered
  path (requesting `["address","locality"]` is permitted when `["address"]` is registered, since the
  registered claim is the broader disclosure);
- a requested path that is a **prefix** of a registered path is **rejected** (requesting
  `["address"]` when only `["address","locality"]` is registered asks for more);
- `null` segments (array wildcards) and integer indices compare structurally, never as strings.

Why do this when EUDIPLO and the Wallet also check:

- EUDIPLO validates that every **credential** in the DCQL query appears in the registration
  certificate's authorized `credentials` claim, and rejects the request otherwise. That is
  credential-level, at request time.
- `EW-DM-44-027` (`RPRC_21`) makes the **Wallet** verify that all requested **attributes** are in the
  registration certificate's attribute list, and warn the user that "the Relying Party is requesting
  more information than it has registered" when they are not.

The platform's check is the only one that catches the error at **policy publication**, before any
customer traffic and before any user sees a warning. Three complementary layers, and the platform
owns the earliest. This is also the check that makes `POLICY_NOT_SATISFIED` meaningful: a policy that
could never be satisfied by a registered intended use should never have been published.

## Decision 3 — The compiler and the `VerificationPlan`

`PresentationPolicyCompiler` takes a `PresentationPolicyVersion` plus `RelyingPartyService`
context, `IntendedUse`, `RegistrationCertificate` and `TrustPolicy`, and produces an immutable
`VerificationPlan`:

```
VerificationPlan {
  credentialRequirement { credentialType, acceptedFormats[], meta }   // vct_values | doctype
  requestedClaims[]            { path }                              // OpenID4VP claim paths
  trustConstraints             { anchorSources[], statusCheckMode, ... }
  resultTransformation         { kind: VERIFIED_CLAIMS | DERIVED_CLAIMS, spec }
  retentionInstructions        { transactionLifetime, ... }
  relyingPartyContext          { rpIdentifier, serviceIdentifier, intendedUseId,
                                 registrationCertificateRef, accessKeyBindingRef }
}
```

**No DCQL anywhere in the plan.** DCQL is produced inside `EudiploVerifierAdapter` from the plan,
per [ADR 0002](0002-eudiplo-as-wrapped-engine.md). The plan is snapshotted or referenced by version
on every transaction, so a later policy edit cannot rewrite history.

The plan is also where `statusCheckMode` is decided. EUDIPLO defaults to `strict` (fail-closed: if the
status list cannot be fetched or validated, verification fails). **V0 keeps `strict`.** It is the
conservative default, and `AS-AP-07-023` (`VCR_13`) makes revocation checking a `SHOULD` whose
omission requires a documented risk analysis — which V0 has not performed. Note the reference
environment itself uses `TrustPolicy.Action.INFORM` for status because "the dev PID list has no
revocation anchors yet", so `strict` may surface `trust_list_unavailable` in the dev environment; that
maps to a verifier-side `TRUST_ERROR` ([ADR 0002](0002-eudiplo-as-wrapped-engine.md) Decision 4) and
must be reported as our operational failure, not as a bad credential.

## Decision 4 — Result policies

- **`VERIFIED_CLAIMS`** — return only the explicitly allowed verified attributes.
- **`DERIVED_CLAIMS`** — return a derived, minimised result through a small explicit transformation
  interface. Named implementations registered at startup. **No expression language, no rules
  engine**, per the prompt's §6.2 and consistent with
  [`05-eudi-services/issuer-product-model.md`](../../../05-eudi-services/issuer-product-model.md)
  recording policy-engine technology as `[OPEN]`.

Both policies additionally strip the `AS-RP-01-002` (`OIA_16`) unique elements — salts, attribute
hashes, the revocation index, the device-binding public key, the provider signature value — from the
customer-facing result, not only from storage. See
[ADR 0004](0004-ephemeral-presentation-and-issuance-processing.md). In practice this means the
adapter must not pass EUDIPLO's `SessionOutcome.trust.issuanceThumbprint` or
`revocationThumbprint`, nor any `VerificationResult.payload`, into the result object.

## Decision 5 — Minimisation-first, rewritten around what the baseline actually permits

**The prompt's worked example is not implementable.** Evidence:

1. **PID Rulebook v1.1 (4 Sep 2025), change log, verbatim:** *"Taking PID Rulebook out of ARF 2.5.0
   and into separate GitHub repository. **Age verification attributes removed, following
   CIR 2024/2977.**"*
2. I enumerated the complete current PID attribute set — §2.2 mandatory (`family_name`, `given_name`,
   `birth_date`, `birth_place`, `nationality`, `portrait`), §2.3 optional, §2.4–2.5 metadata, §2.6
   Rulebook additions (`trust_anchor`, `attestation_legal_category`). There is **no** `age_over_18`,
   `age_over_NN` or `age_in_years`.
3. The live reference issuer agrees: at `https://issuer.eudiw.dev`,
   `eu.europa.ec.eudi.pid_vc_sd_jwt` advertises 27 claims and `eu.europa.ec.eudi.pid_mdoc` 26, and
   **neither contains any age-related claim**.
4. The ARF HLR register mentions `age_over_18` only in a parenthetical note about values changing on a
   birthday, conditioned on "if present". No HLR requires a PID to carry it.
5. The attestation-rulebooks catalogue holds only `pid` and `mdl`; there is no age-verification
   rulebook. Age verification has moved to a separate ecosystem, evidenced by the separate
   mdoc-only AV wallet (`av-app-android-wallet-ui`) that EUDIPLO lists as tested.

The prompt's §6.4 text reflects an ARF version at or before 2.5.0. **So the rule is restated, not
abandoned:**

> **R1 — Prefer a pre-computed minimal attribute where the credential type offers one.** When a
> credential type exposes an attribute that answers the question directly, request that attribute and
> not the source data it was computed from. This is the general rule and it remains binding.
>
> **R2 — Where no such attribute exists, derivation is the minimising choice, not a fallback.** The
> policy must then declare the derivation explicitly, the source attributes must be registered for
> the intended use, and the raw source values must be discarded immediately after derivation and
> never returned, logged or persisted.
>
> **R3 — Age over a PID is the documented counter-example to R1.** No age attribute exists in the
> current PID Rulebook, so an age check over a PID must use R2 over `birthdate` (SD-JWT VC) or
> `eu.europa.ec.eudi.pid.1.birth_date` (mdoc). The compiler must not special-case `age_over_18`,
> because the attribute does not exist.

The prompt's own warning that "filtering the business result is not a substitute for over-asking the
wallet" still holds as a general principle — R1 is exactly that principle. But for age over a PID
there is no less-asking option available, so minimisation **must** be enforced at the result boundary
by `DERIVED_CLAIMS`. That inversion of emphasis is forced by the baseline, not chosen for
convenience, and it is why R2 is phrased as the minimising choice rather than as a concession.

The abstract principle is independently restated in TS5 §2.4.5: a Wallet-Relying Party Service "may
only request the minimum set of attestations (`Credential`) and attributes (`Claim`) within those
necessary for a specific intended use".

**V0 policy, concretely.** Credential `urn:eudi:pid:1` as `dc+sd-jwt`; `requestedClaims:
[{path: ["birthdate"]}]`; result policy `DERIVED_CLAIMS` with a named `AgeAtLeast(18)`
transformation emitting `{ over_18: boolean }` and nothing else. `birthdate` is discarded inside the
same call stack. The customer never receives a date of birth.

Unit tests must assert: the derived result contains no source value; the transaction row contains no
source value; the logs contain no source value (the deny-list test covers `birthdate` and
`birth_date`); and a policy requesting `birthdate` against an intended use that registered only
`["place_of_birth"]` is rejected with 422.

## Decision 6 — `SAME_DEVICE` is the tested V0 path; `QR` is flagged

**Resolved by the user at the Phase 0 checkpoint: use `SAME_DEVICE` as the tested V0 path.**

Therefore:

- `POST /v1/presentations` accepts an optional `interactionType` of `SAME_DEVICE` (the default) or
  `QR`. The response's `interaction.type` echoes what was used.
- `SAME_DEVICE` returns EUDIPLO's `uri` — the variant that carries the post-completion redirect — and
  is the flow covered by the end-to-end target, the smoke script and
  [`reference-wallet-testing.md`](../reference-wallet-testing.md).
- `QR` returns EUDIPLO's `crossDeviceUri`. It stays in the API surface because removing it would
  force a breaking change later, but it is **flagged**: the `OIA_08d` mitigation obligation is unmet
  in V0 and is recorded in [`security-limitations.md`](../security-limitations.md). The API
  documentation says so, and requesting it emits a `platform.interaction.cross_device_requested`
  audit event so its use is visible rather than silent.
- No V0 claim is made that the `QR` path satisfies `EW-PIO-01-017` (`OIA_08d`).

### Why ARF discourages the cross-device redirect flow

The prompt's §6.7 response shape is `interaction: { type: "QR" | "SAME_DEVICE", uri }` and §6.9
describes a QR flow. Two HLRs bear on that directly:

- **`EW-PIO-01-016` (`OIA_08c`):** "Wallet Units **SHOULD NOT** support using a redirects-based
  transmission mechanism for **cross-device** presentation flows."
- **`EW-PIO-01-017` (`OIA_08d`):** "If a Relying Party uses a redirects-based transmission mechanism
  for cross-device presentation flows, it SHALL implement adequate mitigations for the challenges
  described in Section 4.4.3.1 of the ARF main document."

A QR code carrying an `openid4vp://` URI is precisely a redirects-based cross-device flow. ARF 3.0.0
discourages it on the wallet side and places an explicit mitigation **obligation** on the Relying
Party — i.e. on the platform. The sanctioned cross-device path is the W3C Digital Credentials API with
the proximity check in `EW-PIO-01-020` (`OIA_08g`), which the prompt's §6.7 puts **out of scope** for
V0 and which the RI feature matrix marks `n/a`.

Implementing both costs nothing — EUDIPLO returns both `uri` and `crossDeviceUri` from
`POST /verifier/offer` — so the decision above keeps the surface while moving the demonstrated flow to
the one the baseline does not discourage.

## Consequences

- **Positive.** The policy model is expressible in TS5 v1.5, so a future real Registrar integration is
  a mapping exercise, not a redesign.
- **Positive.** Claim paths are modelled correctly from the start. Retrofitting paths onto flat
  attribute names after `PresentationPolicyVersion` rows exist would require a data migration and
  would be wrong in the interim.
- **Positive.** The minimisation rule is now general and verifiable, with age documented as the
  counter-example rather than as the canonical example.
- **Negative.** Path-subset comparison with nulls and indices is fiddly and needs real unit-test
  coverage. It is listed explicitly in the Milestone 1 test plan.
- **Negative.** Localised `purpose` and `privacyPolicy` add friction to policy authoring for a V0 with
  one test tenant. Non-negotiable: the Wallet displays them per `RPA_10`, and TS5 makes them
  multi-valued.
- **Negative.** `DERIVED_CLAIMS` is on the critical path for the flagship V0 scenario rather than
  being an optional extra, so it must be correct in Milestone 1 rather than deferred.
- **Negative (accepted).** The `QR` path remains reachable but untested and non-conformant with
  `OIA_08d`. Recorded in `security-limitations.md` and surfaced as an audit event rather than removed.

## Status of claims

No conformance with ARF 3.0.0 or any Technical Specification is claimed. HLR identifiers cited here
were read from the machine-readable register `hltr/high-level-requirements.csv` at ARF commit
`c64f2cbb19aee37c571c58af66d359c4d5be29c8`; TS5 citations are to version 1.5 at TS-repository commit
`ee91a294c833af5188726fd8c302c641212192aa`; PID Rulebook citations are to version 1.1 at rulebooks
commit `36f8adcf914ac06cac18d685add04e0a8a06d685`.
