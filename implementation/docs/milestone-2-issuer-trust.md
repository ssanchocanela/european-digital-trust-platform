# Milestone 2, gated first task: how the pinned Reference Wallet trusts an issuer

**Read-only source investigation. No issuance code has been written.** This is the checkpoint
`CLAUDE.md` §1 requires before the issuance flow is built, and open question **Q10**.

**Verdict: it is a blocker.** A non-qualified EAA issued by this platform cannot be accepted by an
unmodified build of the pinned Reference Wallet, for a reason that is structural rather than
configurational. Details below, then what it would take.

## What was read

| Source | Pin |
|---|---|
| `eudi-app-android-wallet-ui` | tag `Wallet/Demo_Version=2026.09.42-Demo_Build=42`, commit `43f362d2a720edb6d37a356b6a51b52b32c61f25` |
| `eudi-lib-android-wallet-core` | tag `v0.30.2`, commit `6533dd10ae838df35037c02f1fde0679647e5839` |
| Dev LoTEs | fetched and decoded live, 11 September 2026 |

Read for investigation only — neither repository was forked or modified.

---

## Q1a. Which mechanism establishes **issuer** trust?

**ETSI LoTE-based trust, classified per attestation type** — not OpenID4VCI issuer metadata alone,
and not a single flat trust store. It is a different subsystem from the verifier-side reader trust
that blocker B1 is about, which is why it had to be checked separately.

The shipped `WalletCoreConfigImpl` (identical in the `demo` and `dev` flavours) configures:

```kotlin
configureEtsiTrust {
    loteLocations(SupportedLists(
        pidProviders    = Uri(".../LOTE/json/PIDProviders.jwt"),
        wrpacProviders  = Uri(".../LOTE/json/WRPACProviders.jwt"),
        wrprcProviders  = Uri(".../LOTE/json/WRPRCProviders.jwt"),
        pubEaaProviders = Uri(".../LOTE/json/PubEAAProviders.jwt"),
    ))
    classifications(AttestationClassifications(
        pids = AttestationIdentifierPredicate.any(identifiers = setOf(
            AttestationIdentifier.MDoc(docType = DocumentIdentifier.MdocPid.formatType),
            AttestationIdentifier.SDJwtVc(vct   = DocumentIdentifier.SdJwtPid.formatType),
        )),
    ))
    relaxCertificateProfiles()
    relaxPkixRevocation()
}
configureIssuerTrust {
    policy { default(TrustPolicy.Action.ENFORCE) }
    requireSignedMetadata()
    configureIssuerRegistrationPolicy(/* user preference, see Q1c */)
}
```

`evaluateIssuerTrust` (wallet-core `trust/EvaluateIssuerTrust.kt`) then does, in order:

1. Derives an `AttestationIdentifier` from the document format — `MDoc(docType)` or `SDJwtVc(vct)`.
2. Picks a `CredentialTrustVerifier` for the format.
3. Verifies the credential's certificate chain against the provisioned anchors.
4. Classifies the attestation into a `VerificationContext` —
   `classifications?.classify(id)?.fold(ifPid, ifPubEaa, ifQEaa, ifEaa)`.
5. Resolves the `TrustPolicy` for that context and applies it:

```kotlin
if (action == TrustPolicy.Action.ENFORCE && result is CertificationChainValidation.NotTrusted) {
    throw IssuerNotTrustedException(result.cause)
}
```

### Yes — a non-qualified EAA is treated differently from a PID, and that is the problem

The distinction is real and explicit: `VerificationContext` has `PID`, `PubEAA`, `QEAA` and
`EAA(useCase)` cases, and `ProvisionTrustAnchorsFromLoTEs.eudiwJvm(svcTypePerCtx = SupportedLists.eu())`
selects anchors **per context**. So trust is only resolvable for a context the build knows about.

Three facts combine badly for a non-qualified EAA:

| | |
|---|---|
| **No list** | `SupportedLists` has an `eaaProviders` field — a *map*, keyed by use case, matching `VerificationContext.EAA(useCase)`; `EtsiTrustProvider.kt:149` relaxes it. **The app never populates it.** Only `pidProviders`, `wrpacProviders`, `wrprcProviders` and `pubEaaProviders` are configured. There is no trust list for non-qualified EAA issuers in this build |
| **No classification** | `classifications(...)` declares **only `pids`**. `pubEaas`, `qEaas` and `eaas` are left unset, in *both* flavours. `PidClassification.kt` confirms the shape: `this?.pids ?: AttestationIdentifierPredicate.None` |
| **Enforcing default** | `policy { default(TrustPolicy.Action.ENFORCE) }`, and the library default is `ENFORCE` too (`TrustPolicy.Builder.default`, and `TrustPolicy.uniform(ENFORCE)` when no policy block is given) |

So a credential of our own `vct` is unclassified, has no list to chain to, and is evaluated under an
enforcing policy. This is not a misconfiguration to be corrected — **ARF does not have non-qualified
EAA providers publishing to a notified trust list the way PID and PubEAA providers do**, so there is
nothing for the Wallet to consult. The mechanism is absent by design, not by oversight.

A fourth, independent gate: `requireSignedMetadata()` produces
`IssuerMetadataPolicy.RequireSigned(issuerTrust)`, so the issuer's OpenID4VCI metadata must be
**signed by a key that the same issuer-trust source can validate**. Even with the chain problem
solved, unsigned metadata is refused.

### The dev environment collapses a **fourth** trust domain

Phase 0 recorded three byte-identical anchor sets (`CLAUDE.md` §6 item 16). Fetched and decoded
today, `PubEAAProviders` has the **same seven anchors with the same SHA-256 fingerprints** as
`PIDProviders` and `WRPACProviders` — `CZ, EE, EU, LU, NL, PT, UT`. So it is four domains, not
three. The platform's `TrustResolver` must keep them separate regardless.

> ⚠️ Operational note: the `PubEAAProviders` list was issued **2026-03-16** with `NextUpdate`
> **2026-09-12** — tomorrow. Expect it to roll over; re-fetch before relying on today's anchors.

## Q1b. Can a development issuer be trusted **without** modifying the build?

**No.** Every relevant value is hard-coded in `WalletCoreConfigImpl`, and the only trust path a
non-qualified EAA could take does not exist in it. The one theoretical route — chaining our issuer
to one of the seven anchors — is closed: they are EUDIW-operated Access/PID/PubEAA CAs and there is
no self-service enrolment for an EAA issuer equivalent to the RP Registration Service that Path A
uses for access certificates.

### The smallest modification, in increasing order of honesty cost

All of these produce a **modified wallet**, and §8 of `CLAUDE.md` applies in full: every report,
document, test name, log line and PR statement must say "self-built Reference Implementation wallet"
or "modified wallet", never "the Reference Wallet" unqualified, and the official-build result stays
**unverified**.

| Option | Change | Cost |
|---|---|---|
| **1 — smallest** | `policy { default(ENFORCE); forVct("<our vct>", TrustPolicy.Action.INFORM) }` | One line, and narrowly scoped: PID stays enforcing, only *our* attestation type is downgraded to "inform". `CertificationChainValidation.NotTrusted` is then returned rather than thrown, so the Wallet surfaces untrusted rather than refusing |
| 2 | Option 1 **+** `ignoreSignedMetadata()` (or sign our issuer metadata properly) | Needed only if we do not sign metadata. Signing it is the better answer and is work on our side, not the wallet's |
| 3 | Populate `eaaProviders` in `loteLocations(...)` with a LoTE we publish, and declare `eaas` in `classifications(...)` | Exercises the *real* code path rather than bypassing it, so it is the most faithful test — but it means operating an ETSI TS 119 602 LoTE, signing it, and hosting it reachably |
| 4 | `trustSource(...)` with a custom `IsChainTrustedForAttestation` | Replaces the subsystem under test. Least informative; avoid |

**Recommendation: option 1 for the first end-to-end issuance test, with option 3 as the goal.**
Option 1 changes one line and leaves the PID path untouched, so what it demonstrates is our issuance
flow, honestly labelled. Option 3 is what would actually evidence the trust mechanism, and is worth
doing once issuance works — but it is a project in itself and should not gate Milestone 2.

## Q1c. Does *Check Registration Certificates* change what is exercised?

**Yes, and more than expected: the single toggle gates both sides of the ecosystem.**

```kotlin
configureIssuerTrust {
    configureIssuerRegistrationPolicy(
        if (isRegistrationCheckEnabled) IssuerRegistrationPolicy.Enabled
        else IssuerRegistrationPolicy.Disabled)
}
configureWrpRegistrationPolicy(
    if (isRegistrationCheckEnabled) WrpRegistrationPolicy.Enabled
    else WrpRegistrationPolicy.Disabled)
```

Both read the **same** `isRegistrationCheckEnabled`, which resolves to
`prefsController.getBool("RegistrationCheckEnabled", false)` — a **runtime user preference in
Settings, defaulting to off**, not a build flag. So:

- With it **off** (the shipped default), `IssuerRegistrationPolicy.Disabled` means the issuer
  registration certificate is *"neither validated nor surfaced"*. An issuance run that succeeds with
  the switch off has exercised **nothing** of the registration layer.
- With it **on**, it is validated and its outcome surfaced. Given blocker B3 — no provider of
  registration certificates is reachable, so we hold none — expect refusal or a warning.

This matters because `AS-AP-44-005` (`RPRC_22a`) and `AS-AP-44-007` (`RPRC_23`) make a valid
registration certificate a precondition for the Wallet to request issuance **at all**. So:

> **Test M2 issuance with the switch in both positions and report both results.** A pass with it off
> is not evidence that the registration layer works. This is the same discipline §8 already requires,
> and it is now confirmed to be a user preference rather than a build-time choice — so the tester can
> flip it without rebuilding.

One convenience: because it is a preference, both positions can be tested on **one** build.

## What this means for Milestone 2

Nothing here blocks building the issuance flow *itself* — the platform side, the `EudiIssuerPort`,
the adapter, the issuance policy model, revocation. What it blocks is **demonstrating issuance to an
unmodified official wallet**, which was never promised for V0 and is now understood precisely rather
than assumed.

Recorded as blocker **B7** and question **Q10** (resolved to this finding). Proposed sequencing for
the checkpoint decision:

1. Build Milestone 2 against the engine, with the adapter-contract suite extended to issuance —
   the same discipline that found five defects on the verification side.
2. Treat the wallet issuance test as a **separate, later** step gated on a decision between options
   1 and 3 above.
3. Do not claim `RPRC_22a`, `RPRC_23` or issuer-trust conformance anywhere.

**Stopping here for review, as `CLAUDE.md` §1 requires.**
