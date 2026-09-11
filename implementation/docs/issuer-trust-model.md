# Issuer trust: two gates, modelled separately

A Wallet has to answer two different questions before it will hold an attestation from us, and ARF
answers them in different sections with different mechanisms. Conflating them is the easy mistake —
they are separate in the domain model, separate in the port, and separately tested.

| | Gate (a) | Gate (b) |
|---|---|---|
| Question | "Is this Attestation Provider who it says it is, *before* I ask for a credential?" | "Is the signature on this attestation one I should trust?" |
| ARF | **§6.6.2.2** — pre-issuance provider authentication | **§6.3.2.4** — attestation signature trust |
| Mechanism | **One JWS.** The metadata is signed with the provider's **access certificate**, which travels in the signature's `x5c` header, and the registration certificate sits in `issuer_info` inside the signed payload (OpenID4VCI 12.2.3; ETSI TS 119 472-3 V1.1.1 clauses 4.2.1–4.2.3) | Trust anchors from the **attestation Rulebook**, optionally a list published per **ETSI TS 119 602** |
| When | Before the credential request | At verification, by whoever receives the attestation |
| V0 status | **Partly supported, blocked on `signed_metadata`** | **Modelled and publishable (TEST); no notified list exists for a non-qualified EAA** |

Everything below was verified against the running EUDIPLO v7.6.0 container
(`sha256:8dd60a2f…`) on 11 September 2026, not read from its documentation.

---

## Gate (a) — pre-issuance provider authentication, §6.6.2.2

### What the engine does support

The registration certificate **is** publishable in the Credential Issuer metadata — in the unsigned
document. The engine emits it as:

```json
"issuer_info": [{ "format": "registration_cert", "data": "<jwt>" }]
```

assembled by `appendIssuerRegistrationCertificateInfo`, gated on
`registrationCertificate.enabled`. Three details cost a debugging cycle each and are now pinned by
contract tests:

| | |
|---|---|
| The config shape is `{enabled, mode: "import", jwt}` | `mode: "generate"` would have the engine call a registrar to mint one, which V0 has none for |
| `enabled` is separately load-bearing | Without it the certificate is stored and **silently never published** — the worst kind of failure |
| The adapter reads it back from the **well-known document** | Not from the management API. The question is what a Wallet receives, and Milestone 1 found the engine storing a certificate it then declined to publish |

**With a caveat added on 11 September 2026, after reading the profile.** `ISS-MDATA-REG_CERT-4.2.3-02`
requires `issuer_info` at the **top level of the signed JWT payload**. The engine puts it in the
unsigned JSON document, and there is no signed payload for it to be in. So "publishable" is accurate
about the document and **not** about the profile: the certificate is present where a curious client can
read it, and absent from the place a conformant Wallet looks.

### What it does not — and this is the blocker

This section originally described the missing signature as one narrow gap, separable from the
certificates. **That was wrong, and the correction matters**: the profile makes the signature the
*carrier* of both certificates, so the gap is not narrow — it is the mechanism.

**`signed_metadata` is not produced.** The term has **zero occurrences** in the engine's compiled
source. It is the OpenID4VCI mechanism by which a Wallet authenticates the metadata *document
itself*, and the pinned Reference Wallet requires it:

```kotlin
configureIssuerTrust {
    requireSignedMetadata()        // → IssuerMetadataPolicy.RequireSigned(issuerTrust)
}
```

So a Wallet cannot authenticate this provider before issuance — and there is no "whatever
certificates the metadata carries" escape, because the access certificate's only conformant home is the
`x5c` header of the signature that does not exist (**G8**), and the registration certificate's is the
payload of the same JWS.

Three further facts about the pinned wallet, all read from its source:

| | |
|---|---|
| The `x5c` chain is validated against **`VerificationContext.WalletRelyingPartyAccessCertificate`** | `EtsiCertificateChainTrust` — the **same** trust context as a verifier's access certificate. So the **Q1a chain check gates gate (a) too**, and one access certificate from the RP Registration Service may serve both roles |
| `RequireSigned` **gates the issuer registration-certificate check** | `IssuerCreator`: `issuerRegistration?.takeIf { issuerMetadataPolicy is IssuerMetadataPolicy.RequireSigned }`. Under `PreferSigned` or `IgnoreSigned` the check is silently skipped, with a log line saying so — **even with the Wallet's own *Check Registration Certificates* preference on** |
| The default is already `RequireSigned` | `IssuerTrustConfigBuilder` defaults to `MetadataPolicyMode.REQUIRE`; the explicit `requireSignedMetadata()` in the reference app is belt and braces |

The second of those has a sharp consequence for testing: **`RPRC_22a`/`RPRC_23` cannot be exercised at
all until the metadata is signed.** A wallet modified to tolerate unsigned metadata stops checking the
registration certificate, so the two cannot be tested independently — which is the opposite of what the
W0 test matrix assumed. The platform reports the conjunction rather than implying success:

```
GET /v1/tenants/{t}/attestation-providers/{p}/provider-authentication
→ { registrationCertificatePresent: true,
    metadataSigned: false,
    walletCanAuthenticateProvider: false }
```

A contract test asserts `metadataSigned === false`, with a message saying what to do if it ever
passes. That is deliberate: the useful behaviour when the engine gains support is a **failing test
that points at this document**, not a silent change in what the platform claims.

### Closing it

Three routes, in rough order of cost:

1. **Upstream**: the engine signs its metadata with an `access`-usage key chain, `x5c` in the header,
   `issuer_info` in the payload. **One change closes G1, G8 and the `issuer_info` placement problem.**
   An issue covering all three is drafted (not filed) at
   [`upstream/eudiplo-signed-metadata.md`](upstream/eudiplo-signed-metadata.md).
2. **In front of the engine**: the platform serves the metadata itself, signing it with the
   attestation key. Means owning an OpenID4VCI surface, which is exactly what the engine exists to
   avoid.
3. **Modify the wallet**: `ignoreSignedMetadata()`. One line, and it bypasses the gate rather than
   satisfying it — a *modified* wallet under `CLAUDE.md` §8.

## Gate (b) — attestation signature trust, §6.3.2.4

For a **non-qualified EAA**, ARF sources the anchors from:

> the applicable attestation Rulebook … and, optionally, a list of trusted Attestation Providers
> published by a trusted entity, in accordance with ETSI TS 119 602

Two things follow, and both shaped the design.

### The Rulebook is trust configuration, so it is a first-class field

`CredentialType.rulebook` carries `identifier`, `version`, optional `publicationUri`, and an explicit
`anchorSource`:

| `anchorSource` | Meaning |
|---|---|
| `RULEBOOK_ONLY` | The anchors are whatever the Rulebook names. The V0 default |
| `RULEBOOK_AND_PUBLISHED_LIST` | A list published per ETSI TS 119 602 is also expected |

A type declaring `RULEBOOK_AND_PUBLISHED_LIST` with no `publicationUri` **cannot have a policy
published**. Issuing an attestation whose anchors a verifier could not resolve is worse than
refusing, and "we'll publish the list later" is how that happens.

The `version` is required for the same reason: anchors change between Rulebook versions, so an
unversioned reference does not identify a trust configuration.

### The published list is in scope — and is *not* a notified list

This is the distinction that makes the capability legitimate. Topic 31 governs the **notified**
lists — PID Providers, PubEAA Providers, WRPAC and WRPRC Providers — whose publication is a Member
State function the platform has no part in. A non-qualified EAA Provider list is an ordinary
ETSI TS 119 602 publication by "a trusted entity", and a platform operating Attestation Providers can
be that entity for its own types.

`TrustAnchorPublication` implements it, with three guardrails:

- **`TEST` only.** `assertPublishable` refuses `PRODUCTION` structurally, naming what is missing: a
  published practice statement, audited key custody, a revocation process, and the unresolved legal
  qualification of the hosted-instance profile (Q2). A `PRODUCTION` list is a standing trust
  assertion third parties could rely on.
- **Labelled inside the signed payload.** The scheme name is prefixed
  `TEST ONLY — NOT A NOTIFIED TRUST LIST — `, and `SchemeTypeCommunityRules` says in full what it is
  and is not. Putting it in the payload rather than alongside means it cannot be stripped in transit.
- **Anchors are scoped to attestation types.** An anchor with no `attestationTypes` is refused: an
  unscoped anchor is a blanket authorisation, which is what scoping exists to prevent.

The body is emitted in the same shape the platform already **consumes** from the dev LoTEs —
`LoTE` / `ListAndSchemeInformation` / `TrustedEntitiesList` /
`ServiceDigitalIdentity.X509Certificates` — so one reader serves producer and consumer. That is the
cheapest available protection against the two drifting apart.

The engine has a `trustList` key usage, which is the right usage type for signing such a list.

### What the attestation itself carries

`sdJwtTrustFormat: "x5c"`, set by the adapter. The chain travels with the attestation, so a verifier
can build a path to an anchor named by the Rulebook or the published list. The alternative,
`federation`, resolves trust through OpenID Federation — a mechanism ARF does not use for
non-qualified EAA signature trust.

### The dev environment collapses four trust domains

Fetched and decoded on 11 September 2026: `PubEAAProviders`, `PIDProviders` and `WRPACProviders` hold
the **same seven anchors with identical SHA-256 fingerprints** (`CZ, EE, EU, LU, NL, PT, UT`). Phase 0
recorded three such domains; it is four. The `TrustResolver` keeps them separate regardless, because
the production environment will not be so forgiving.

`PubEAAProviders` was issued 2026-03-16 with `NextUpdate` **2026-09-12**, so it rolls over
imminently. Nothing in this repository caches a list; `verify-access-certificate-chain.sh` fetches
live and now reports freshness, warning when `NextUpdate` has passed and noting when it is within 48
hours.

## For a future wallet test — prefer the list over the downgrade

Two options, both producing a **modified** wallet under `CLAUDE.md` §8 labelling. **The wallet
modification is deliberately not built here.**

| | Change | Verdict |
|---|---|---|
| **Preferred** | Populate `eaaProviders` in the wallet's `loteLocations(...)` with our published list, and declare `eaas` in its `classifications(...)` | **Exercises the real §6.3.2.4 path.** A passing test then means the mechanism works, not that it was skipped. Needs the published list to exist and be reachable — which is what `TrustAnchorPublication` is for |
| Fallback | `policy { forVct("<our vct>", TrustPolicy.Action.INFORM) }` | One line, and it **bypasses** the gate rather than satisfying it. Use only to unblock something else, and never report it as a trust result |

Gate (a) would still need `ignoreSignedMetadata()` or an engine that signs, so a full issuance test
needs a decision on both gates, not one.

And note what the downgrade costs beyond gate (a): under anything other than `RequireSigned` the wallet
stops checking the issuer's registration certificate entirely. So a WD-2 run cannot evidence
`RPRC_22a`/`RPRC_23` either, in **either** position of the *Check Registration Certificates* preference.

## PID during issuance: the issuer becomes a relying party

The §7.3 stretch goal — requiring a PID presentation as the authorization step of an issuance, reusing
a verification policy. The engine supports it natively via `Oid4VpAuthorizationServerConfig`, so the
platform side is a wiring decision. **Off by default** behind `FEATURE_PID_DURING_ISSUANCE`, and the
gate is at policy *publication*, not at issuance: a policy that cannot run must not become publishable
and then fail with a User waiting.

### What enabling it changes about our role

This is the part that is easy to miss. During that presentation the platform **is a Relying Party**,
not only an Attestation Provider, and every verification-side obligation applies to it:

| | |
|---|---|
| **`RPRC_19` is inherited, not escaped** | The nested presentation request needs a registration certificate by value, and the engine will not emit one without a configured live registrar (gap **G2**). The contract test confirms `verifier_info` is absent from the nested request object. So enabling this feature adds a second place where `RPRC_19` is unsatisfied |
| **`RPA_03`/`RPA_04` apply** | The nested request is authenticated with an **access** certificate, which must chain to a notified Access CA anchor. A separate key from the attestation-signing key — the contract test uses a distinct `access`-usage key chain for exactly this reason |
| **`RPRC_17` warnings are expected** | A Wallet that checks will warn that it could not validate the registered information, as it would for any of our presentations |
| **Received PID attributes follow the VaaS rules** | They are **content**: ephemeral, processed in one call stack, never persisted, never logged, never returned. ADR 0004 and `OIA_16` bind the platform here exactly as they do on the verification side, and the eligibility decision is taken from the values without retaining them. The `EligibilityEvaluator` contract reflects this — it receives attributes and returns a decision, and its `reason` is written to avoid restating the values that drove it |

### What the contract test does and does not prove

`tests/adapter/issuance-contract.test.ts` decodes the nested presentation request as far as a Wallet
would read it: `response_type`, an `x509_hash` client id, `direct_post.jwt`, a nonce, the DCQL asking
for `urn:eudi:pid:1` / `birthdate`, and an `x5c` chain in the header. It also asserts `verifier_info`
is absent, so the inherited limitation is pinned rather than discovered later.

It cannot go further. The Wallet responding, the eligibility decision on real attributes, and the
resulting issuance are **unverified**, and the test logs that rather than implying coverage. That is
why the flag stays off until a wallet test passes.

## Status summary

| Claim | Status |
|---|---|
| Registration certificate publishable in metadata | **Verified** against the engine — in the **unsigned** document. Not in the profile-required place (`ISS-MDATA-REG_CERT-4.2.3-02`) |
| Access certificate publishable in metadata | **No.** No field exists, and its conformant home is the missing signature's `x5c` header — gap **G8**, one fix with G1 |
| Credential Issuer metadata signed | **No** — engine does not support it |
| `§6.6.2.2` provider authentication satisfied | **No.** Not claimed |
| Rulebook reference modelled and enforced | **Yes** |
| ETSI TS 119 602 list publishable | **Yes, `TEST` only**, labelled as such |
| `§6.3.2.4` signature trust satisfied for a non-qualified EAA | **No notified list exists for this role.** Not claimed |
| Wallet can hold an attestation from us | **No.** Blocker B7 |
