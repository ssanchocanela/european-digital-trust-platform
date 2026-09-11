# Test wallet plan — Phase W0 investigation

**This was the W0 deliverable: investigation only.** It is kept as written, because the plan is what
the build was judged against.

> **W1 status, added afterwards.** The renamed-identity build exists and the sheets are written.
> `tools/test-wallet/` holds the three patches, `build.sh` and the deviation register; the APK is
> `eu.europa.ec.euidi.edtptest`, signed with our own key, **no deviation compiled in**, and two builds
> from the same inputs were byte-identical. What W1 did **not** do is run anything on a phone — the one
> question this document could not answer is answered by
> [`../tools/test-wallet/INSTALL-AND-PID.md`](../tools/test-wallet/INSTALL-AND-PID.md), which is
> prepared and not yet run.
>
> | | |
> |---|---|
> | Build tooling and deviation register | [`../tools/test-wallet/README.md`](../tools/test-wallet/README.md), [`deviations.md`](../tools/test-wallet/deviations.md) |
> | Install and first PID | [`INSTALL-AND-PID.md`](../tools/test-wallet/INSTALL-AND-PID.md) |
> | Public exposure design | [`test-session-gateway.md`](test-session-gateway.md) |
> | Certificates, when they arrive | [`certificate-intake-runbook.md`](certificate-intake-runbook.md) |
> | First VaaS run, official wallet | [`vaas-official-wallet-run-sheet.md`](vaas-official-wallet-run-sheet.md) |
>
> One thing the build corrected about §5 below: the layout here proposed a `flavour/` directory copied
> in by `build.sh`. It turned out the three per-flavour source sets can simply be **copied from
> `demo`**, because with every deviation off their content is upstream's — so no upstream Kotlin is
> duplicated into this repository at all.

A modified Android wallet, built from the official EUDI Reference Implementation, so the platform can
be tested end to end. Every result it produces is labelled as coming from a **modified** build, never
from "the Reference Wallet" — `CLAUDE.md` §8 applies without exception.

---

## 1. Pins

| | |
|---|---|
| App | `eu-digital-identity-wallet/eudi-app-android-wallet-ui`, tag **`Wallet/Demo_Version=2026.09.42-Demo_Build=42`**, commit `43f362d2a720edb6d37a356b6a51b52b32c61f25` |
| Wallet Core | `eudi-lib-android-wallet-core` **`0.30.2`** (`libs.versions.toml: eudiWalletCore`), consumed as a Maven artefact — not a source dependency |
| ETSI trust library | `eu.europa.ec.eudi:etsi-1196x2-consultation` **`0.4.0-alpha.1`**. An **alpha** transitive dependency sitting directly under the trust decisions in WD-1 |
| Licence | **EUPL-1.2** (`LICENSE.txt`). Retained in full; every patch file carries the upstream header |

### Build prerequisites

| | |
|---|---|
| JDK | **17** (`sourceCompatibility`/`targetCompatibility` = `VERSION_17`) |
| Gradle | **9.7.1** (wrapper-pinned — use the wrapper, not a local Gradle) |
| AGP | **9.4.0**; Kotlin **2.4.0** |
| Android SDK | `compileSdk 37`, `minSdk 29` |
| Signing | A release `signingConfig` reads `androidKeyPassword` / `ANDROID_KEY_PASSWORD`. **Our own keystore**, never upstream's |

### Flavours

`flavorDimensions = [contentType]`, two flavours from `AppFlavor`:

| Flavour | `applicationIdSuffix` | Points at |
|---|---|---|
| `demo` | *(none)* → `eu.europa.ec.euidi` | `wallet-provider.eudiw.dev`, `issuer.eudiw.dev` |
| `dev` | `.dev` | `dev.wallet-provider.eudiw.dev` |

Plus build types `debug` (`applicationIdSuffix` from `AppBuildType.DEBUG`) and `release`.

**`AppFlavor` already carries an unused `applicationNameSuffix`,** and the manifest label is
`android:label="${appName}${appNameSuffix}"`. So a third flavour — `edtptest` — can set both the id
suffix and the visible name **without touching the manifest or any source file**. That is the cheapest
possible route to the required distinct identity, and it is configuration, not a patch.

## 2. The critical question: does it need the reference Wallet Provider?

**Yes, it calls one — and a rebuilt APK can use the reference one unchanged.**

### What the contract actually is

`WalletAttestationRepositoryImpl` (`network-logic`):

```
POST {walletProviderHost}/wallet-instance-attestation/jwk   body {jwk}          → {walletInstanceAttestation}
POST {walletProviderHost}/key-attestation/jwk-set           body {nonce,jwkSet} → {keyAttestation}
```

`walletProviderHost` comes from the flavour: `https://wallet-provider.eudiw.dev` (demo) or
`https://dev.wallet-provider.eudiw.dev` (dev).

### Why a rebuild can obtain attestations

Verified by reading both repositories:

| Check | Result |
|---|---|
| Play Integrity / SafetyNet / `IntegrityManager` / App Attest | **Zero occurrences** in either repo |
| Client certificate (mTLS) on the HTTP client | **None.** `HttpClient(Android)` with only `Logging` and `ContentNegotiation` |
| Certificate pinning | **None** |
| API key, bearer token, or app-identity header | **None** |
| `applicationId`, package name or signing certificate in the request | **Not sent.** The body is a JWK (and a nonce) |

So the reference Wallet Provider attests **a key, not an app**. Nothing in the request distinguishes our
rebuild from the official build, and therefore a rebuilt APK with a different `applicationId` and our own
signing key should obtain both wallet and key attestations unchanged.

> This is a property of the **reference** environment, which is explicitly a test service. It is not a
> finding about a production Wallet Provider, and it should not be written up as one. A production
> provider would be expected to bind attestation to app integrity; this one does not need to.

### Will `issuer.eudiw.dev` issue a test PID to it?

**Probably yes, and it is the one thing W0 cannot settle by reading code.** The issuer is configured as:

```kotlin
VciConfig(issuerUrl = "https://issuer.eudiw.dev",
  config = OpenId4VciManager.Config.Builder()
    .withClientAuthenticationType(
      OpenId4VciManager.ClientAuthenticationType.AttestationBased(clientId = "eudiw-abca"))
    …)
```

The issuer authenticates the **wallet client** by attestation, under a fixed `clientId` of `eudiw-abca`
that is a constant in the source and would be unchanged in our rebuild. Since the attestation is
obtainable (above) and the client id is the same, PID issuance should work.

What could still stop it, and cannot be determined statically:

1. the issuer validating the attestation's `aud`/`iss` against something tied to the official app;
2. rate limiting or an allow-list on `clientId`;
3. the Wallet Provider refusing a key it has not seen before for an unrecognised installation.

**This is the first thing to test in W1**, before any deviation work, because every other test depends
on holding a PID. It is a five-minute test once an APK exists: install, onboard, request a PID.

### Options if it fails

| Option | Cost | Notes |
|---|---|---|
| **A. Use the `dev` flavour's provider** | Free | `dev.wallet-provider.eudiw.dev` may be more permissive |
| **B. Ask the EUDIW reference-environment maintainers** | A conversation | The honest route, and they may simply say yes |
| **C. Stand up our own Wallet Provider** | Moderate | The contract is two POSTs returning a JWT. A stub is a day's work — but the attestation must then be trusted by **our** platform's engine, not by `issuer.eudiw.dev`, so **a PID from the reference issuer would no longer be obtainable**. Only viable if we also issue our own test PID, which is a PID Provider role we are explicitly out of scope for |
| **D. Skip the PID** | Free | Only IaaS tests need no PID. VaaS tests and the PID-during-issuance feature both do. This shrinks the matrix rather than unblocking it |

**A, then B.** C is a trap: it unblocks attestation and blocks the PID.

## 3. The deviation points — exact locations

All three are in **`WalletCoreConfigImpl`**, which exists twice —
`core-logic/src/demo/java/.../config/WalletCoreConfigImpl.kt` and the `dev` variant. A third source set
for our flavour (`core-logic/src/edtptest/java/…`) is the cleanest home: **no upstream file is edited at
all**, which makes every deviation a file we own rather than a patch that conflicts on every upstream
release.

Each deviation is behind a named flag whose default is upstream behaviour.

### WD-1 — `eaaProviders` trust list pointing at our TEST LoTE

*Gate (b). ARF-intended mechanism; configuration only.*

```kotlin
configureEtsiTrust {
    loteLocations(SupportedLists(
        pidProviders    = Uri("…/PIDProviders.jwt"),
        wrpacProviders  = Uri("…/WRPACProviders.jwt"),
        wrprcProviders  = Uri("…/WRPRCProviders.jwt"),
        pubEaaProviders = Uri("…/PubEAAProviders.jwt"),
        // WD-1: our published TEST list. `eaaProviders` is a MAP keyed by use case
        // (EtsiTrustProvider.kt:149 relaxes it), and upstream never populates it.
        eaaProviders    = mapOf(/* useCase to Uri(our TEST LoTE) */),
    ))
    classifications(AttestationClassifications(
        pids = /* unchanged */,
        // WD-1: our attestation type must be classified, or it resolves to no context at all.
        eaas = AttestationIdentifierPredicate.any(
            identifiers = setOf(AttestationIdentifier.SDJwtVc(vct = "urn:edtp:employee-badge:1"))),
    ))
}
```

**Two changes, not one** — the list *and* the classification. Without the classification an attestation
has no `VerificationContext`, so no list is consulted whatever is configured. This is the deviation that
exercises the real §6.3.2.4 path rather than bypassing it, which is why it is preferred over WD-2.

### WD-2 — relax the signed-issuer-metadata requirement

*Gate (a). A **security relaxation**, needed only because of engine gap G1. Off by default.*

> **Numbering note.** The scope instruction named this gap `G2`. In the engine gap register
> (`eudiplo-integration.md` §10B) **G1 is `signed_metadata`** and **G2 is the registration certificate
> not emitted as `verifier_info`**. WD-2 is about signed metadata, so it is G1. Recorded rather than
> silently renumbered.

```kotlin
configureIssuerTrust {
    policy { default(TrustPolicy.Action.ENFORCE) }   // unchanged
    // WD-2: upstream is requireSignedMetadata(). The engine produces no `signed_metadata`
    // (gap G1), so an unmodified wallet refuses our issuer before any credential request.
    if (BuildConfig.WD2_RELAX_SIGNED_METADATA) ignoreSignedMetadata() else requireSignedMetadata()
}
```

`IssuerTrustConfigBuilder` offers `requireSignedMetadata()` / `preferSignedMetadata()` /
`ignoreSignedMetadata()` → `MetadataPolicyMode.{REQUIRE,PREFER,IGNORE}`.

**Prefer `preferSignedMetadata()` over `ignoreSignedMetadata()`** if it works: it accepts unsigned
metadata while still validating a signature when present, so the relaxation is narrower. Worth trying
first.

> **This deviation weakens issuer authentication.** It must never be the default, never be on in a run
> whose purpose is to evidence gate (a), and every result from a WD-2 run must say so. Its only
> legitimate use is reaching the *rest* of the flow while G1 is open.

### WD-3 — an additional TEST Access CA anchor

*Only if the Q1a chain check fails.*

```kotlin
// WD-3: only when verify-access-certificate-chain.sh says our RPAC does not chain to a
// dev WRPACProviders anchor. Note the note in EudiWalletConfig: for ETSI/LoTE-based trust,
// configureEtsiTrust with relaxPkixRevocation() is the documented route, not this.
configureReaderTrustStore(readerTrustedCertificates = listOf(/* our dev Access CA */))
```

`configureReaderTrustStore(List<X509Certificate>)` exists on `EudiWalletConfig` and takes precedence
over the ETSI store. **Run the chain check first** — if Path A holds, WD-3 is unnecessary and should not
be built.

### The registration-certificate-check preference

Not a deviation — an existing **runtime** setting, which is convenient.

| | |
|---|---|
| Storage | `prefsController.getBool("RegistrationCheckEnabled", false)` — **default off** |
| UI | Settings → `SettingsMenuItemType.REGISTRATION_CHECK` (`SettingsViewModel.kt:163`, `SettingsInteractor.kt:114`) |
| Gates | **Both** `configureIssuerRegistrationPolicy(...)` and `configureWrpRegistrationPolicy(...)` |

One toggle, both sides, flippable without rebuilding — so both positions are testable on one APK.

## 4. Network

### The wallet refuses cleartext, full stop

`network_security_config.xml`: `<base-config cleartextTrafficPermitted="false" />`.

So **public HTTPS with an OS-trusted certificate is mandatory** — no `http://`, no self-signed TLS, no
IP literal. This is blocker **B5**, now confirmed from the wallet side rather than inferred.

### Tunnel options

| Option | Fit |
|---|---|
| **Cloudflare Tunnel** (`cloudflared`) | **Recommended.** Stable hostname, real certificate, no inbound ports, free tier. Two routes needed: one to `eudiplo:3000`, one to `platform-api:3100` |
| ngrok | Works; the free tier's changing hostname is painful because `ENGINE_PUBLIC_URL` is baked into issued URLs |
| Tailscale Funnel | Works if the phone is off-tailnet; a neat middle ground |
| Reverse proxy on a VPS | Most control, most setup |

### The thing to get right, and the thing to be careful about

`ENGINE_PUBLIC_URL` must be the **public** origin before any session is created — it is baked into every
wallet-facing URL the engine emits, so changing it later invalidates in-flight sessions. The same applies
to `PLATFORM_PUBLIC_URL` for the same-device return URL.

> ⚠️ **A tunnel in front of port 3000 exposes the engine's management API**, which is normally bound to
> localhost. `POST /api/key-chain/import` and the tenant routes would be publicly reachable, protected
> only by the client-credentials secret. Route **only** the wallet-facing paths —
> `/.well-known/*`, `/presentations/*`, `/issuers/*` — and never `/api/*`. This is already recorded as
> blocker B5 and it is the single biggest operational risk in the whole wallet exercise.

## 5. Repository layout

No wallet source in this repository.

```
implementation/tools/test-wallet/
  README.md            what this is, and the §8 labelling rule
  build.sh             clone at the pinned tag into ./upstream (gitignored), apply patches, assemble
  pins.env             WALLET_UI_TAG, WALLET_UI_COMMIT, WALLET_CORE_VERSION
  patches/             minimal, each with the EUPL-1.2 header retained
  flavour/             our `edtptest` source set, copied in by build.sh — no upstream file edited
  deviations.md        the deviation register (WD-1..WD-3): flag, default, files, justification
```

`implementation/.gitignore` gains `tools/test-wallet/upstream/` and `*.apk`, `*.keystore`, `*.jks`.

### Per-run record

Every run records, in `docs/test-wallet-runs.md`:

| Field | Source |
|---|---|
| Wallet build hash | `sha256` of the APK |
| Upstream tag + commit | `pins.env` |
| Active deviations | The `BuildConfig.WD*` values, printed by the in-app banner |
| EUDIPLO version + digest | `docker compose images` |
| Platform commit | `git rev-parse HEAD` |
| Registration-certificate check | The Settings toggle, on or off |

The in-app banner shows the app name **and the active deviations**, so a screenshot is self-describing —
which matters more than it sounds, because screenshots are what end up in reports.

## 6. Test matrix

`RC` = the registration-certificate-check preference.

### VaaS

| # | Wallet | Flow | RC | Expected |
|---|---|---|---|---|
| V1 | **Official**, if Q1a passes | same-device | off | Presentation completes. `RPRC_19` not exercised |
| V2 | **Official**, if Q1a passes | same-device | **on** | `RPRC_17` warning — no registration certificate (gap G2). **Evidence of G2** |
| V3 | Official or test | QR (cross-device) | off | Completes. ADR 0009 mitigations active; `OIA_08d` still not claimed |
| V4 | Test (WD-3 only if Q1a fails) | same-device | off | Completes. Labelled modified |
| V5 | Test | same-device | **on** | `RPRC_17` warning, as V2 |

V1–V3 need **no deviation** if Q1a passes — the wallet would be official and unmodified. That is the
most valuable evidence available and the reason the chain check comes first.

### IaaS — the two rows that are the point

| # | Wallet | WD-1 | WD-2 | RC | Expected |
|---|---|---|---|---|---|
| I1 | Test | **on** | **off** | off | **Expected failure at gate (a)**: the wallet refuses our issuer for unsigned metadata. **This is the evidence for G1** — a deliberate, recorded failure, not a broken test |
| I2 | Test | **on** | **on** | off | Full issuance completes. Labelled: modified wallet, WD-1 + WD-2, gate (a) bypassed not satisfied |
| I3 | Test | on | on | **on** | Issuer registration certificate validated → expect refusal or warning. `RPRC_22a`/`RPRC_23` make a valid certificate a precondition for the Wallet to request issuance at all (blocker B3) |
| I4 | Test | **off** | on | off | **Expected failure at gate (b)**: no trust list for our EAA type, `evaluateIssuerTrust` throws. **Evidence that WD-1 is load-bearing** |
| I5 | Test | on | on | off | Revocation: issue, revoke via the platform, re-present → status check fails |

**I1 and I4 are designed to fail**, and their value is exactly that: I1 demonstrates G1 from the wallet
side, I4 demonstrates that the §6.3.2.4 mechanism is really being used rather than bypassed. A matrix
where everything passes would prove less.

### PID during issuance — only after the above

| # | Setup | Expected |
|---|---|---|
| P1 | `FEATURE_PID_DURING_ISSUANCE=true`, test wallet holding a PID, WD-1 + WD-2 | The nested presentation completes and eligibility is decided from real PID attributes. Also the **first** exercise of the issuer-as-relying-party path, so `RPRC_19` applies twice |

## 7. What W1 should do first, in order

1. **The Q1a chain check.** It decides whether V1–V3 can use an official build, which is worth more than
   everything else in the matrix. One command, no wallet needed.
2. **Build an unmodified APK with only a new flavour** — distinct `applicationId`, name and banner, zero
   behavioural deviation — and test whether it gets attestations and a PID. That isolates the identity
   question from every trust question.
3. Only then WD-1, then WD-2.

Doing 2 before 3 matters: if a renamed but otherwise stock build cannot get a PID, no amount of
deviation work helps, and options A–D above become the actual task.

---

**STOP — Phase W0 ends here.** Nothing has been built. The open question W0 could not answer by reading
code is whether `issuer.eudiw.dev` will issue a test PID to a rebuilt APK; everything needed to answer it
in one short W1 step is above.
