# Wallet deviation register

Every way the EDTP test wallet differs from the official EUDI Reference Implementation at the pinned
tag, what it is for, and whether it is compiled in.

**Default is upstream behaviour, for every entry without exception.** A deviation that is off changes
nothing; a deviation that is on is named in `BuildConfig.EDTP_DEVIATIONS`, printed by the banner on
every screen, and must appear in the record of any test run it touched.

`build.sh --deviations` currently accepts only `none`, and **refuses anything else** rather than
accepting a flag that does nothing. An accepted-but-inert flag is how a test record comes to say
"WD-1 active" about a build where it was not.

| | Deviation | Gate | Kind | State |
|---|---|---|---|---|
| **Identity** | Distinct `applicationId`, app name and an on-screen banner | — | Identity only | **Built** (W1) |
| **WD-1** | `eaaProviders` trust list pointing at our TEST LoTE | (b), ARF §6.3.2.4 | Configuration of an ARF-intended mechanism | Not built |
| **WD-2** | Signed-issuer-metadata requirement relaxed | (a), ARF §6.6.2.2 | **Security relaxation** | Not built |
| **WD-3** | Additional TEST Access CA anchor in the reader trust store | — | Trust configuration | Not built, and **may never be needed** |

---

## Identity — built in W1

Not a behavioural deviation, and deliberately separated from the three that are: it exists so that a
build which behaves exactly like upstream still cannot be mistaken for upstream.

| | |
|---|---|
| `applicationId` | `eu.europa.ec.euidi.edtptest` — installs alongside the official `eu.europa.ec.euidi` |
| App name | `EDTP Test Wallet — modified reference build` |
| Banner | Red strip on **every** screen: `EDTP TEST WALLET · MODIFIED REFERENCE BUILD · NOT THE OFFICIAL EUDI WALLET · deviations: <list>` |
| Signing | Our own key; the certificate subject says `OU=TEST ONLY` |
| `versionName` | `2026.09.42-edtptest` |

Three patches, each against one upstream file:

| Patch | File | What |
|---|---|---|
| `0001` | `build-logic/.../AppFlavor.kt` | Adds the `EdtpTest` flavour; adds `applicationNameOverride` (upstream's existing `applicationNameSuffix` could only *append* to "EUDI Wallet", and a modified build must not read as a variant of the official one); adds the `EDTP_BUILD` and `EDTP_DEVIATIONS` build-config fields |
| `0002` | `app/build.gradle.kts` | Signing keystore path from `ANDROID_KEYSTORE_PATH`, falling back to upstream's path; optional `ANDROID_STORE_PASSWORD` |
| `0003` | `ui-logic/.../content/` | The banner composable, and one call in `ContentScreen` |

The banner sits in `ContentScreen`, the scaffold every screen uses, rather than on individual
screens — a banner that can be navigated away from would make a screenshot ambiguous about which
build produced it, which is the one thing it exists to prevent. Its text comes from
`BuildConfig.EDTP_DEVIATIONS`, so it cannot drift from what was compiled.

### The flavour source sets are generated, not committed

Three modules carry per-flavour sources (`business-logic`, `core-logic`, `resources-logic`), so a
third flavour needs a third source set in each. `build.sh` **copies** them from `demo`. With all
deviations off their content is upstream's, so copying is both the smallest possible change and the
reason no upstream Kotlin is duplicated into this repository. WD-1 and WD-2, when built, will be
patches against these copies — which is why they are cheap: **no upstream file is edited for them at
all**, because `WalletCoreConfigImpl` is per-flavour.

## WD-1 — `eaaProviders` trust list pointing at our TEST LoTE

**One deviation with two configuration points.** Both are required; one alone does nothing, which is
exactly the trap worth recording.

Gate (b), ARF §6.3.2.4. The ARF-intended mechanism for a non-qualified EAA: anchors come from the
applicable Rulebook and optionally from a list published per ETSI TS 119 602. This configures the
wallet to consult our published TEST list. **Configuration of an intended mechanism, not a
relaxation of a check** — which is why it is preferred over the `forVct(..., INFORM)` downgrade.

Both points are in `core-logic/src/edtptest/.../config/WalletCoreConfigImpl.kt`:

| # | Point | Why it is needed |
|---|---|---|
| **1** | `configureEtsiTrust { loteLocations(SupportedLists(..., eaaProviders = mapOf(useCase to Uri(ourTestLoTE)))) }` | `SupportedLists.eaaProviders` is a **map keyed by use case** and upstream never populates it |
| **2** | `configureEtsiTrust { classifications(AttestationClassifications(..., eaas = AttestationIdentifierPredicate.any(setOf(AttestationIdentifier.SDJwtVc(vct = ourVct))))) }` | Without a classification the attestation resolves to **no `VerificationContext`**, so no list is consulted whatever point 1 says |

Point 2 is the part that is easy to miss, and missing it produces the same symptom as not configuring
anything — a trust failure that looks like a list problem.

**Requires our TEST LoTE to be published and reachable from the phone**, which is what
`TrustAnchorPublication` exists for. Until then WD-1 cannot be tested even once it is built.

## WD-2 — signed-issuer-metadata requirement relaxed

**A security relaxation.** It exists only because of engine gap **G1** (EUDIPLO produces no
`signed_metadata`), and it weakens issuer authentication rather than satisfying it.

Gate (a), ARF §6.6.2.2. Point:
`configureIssuerTrust { requireSignedMetadata() }` → `preferSignedMetadata()` or
`ignoreSignedMetadata()`, in the same per-flavour `WalletCoreConfigImpl`.

**`preferSignedMetadata()` is the narrower of the two** — it accepts unsigned metadata while still
validating a signature when one is present — so prefer it. But be clear that it buys less than it looks
like it does, for the reason below.

### What this deviation silently switches off as well

Read from `IssuerCreator` in wallet-core 0.30.2:

```kotlin
val registrationCertificatePolicy = issuerRegistration
    ?.takeIf { issuerMetadataPolicy is IssuerMetadataPolicy.RequireSigned }
```

**The issuer registration-certificate check runs only under `RequireSigned`.** Under `PreferSigned` *or*
`IgnoreSigned` it is skipped, with a log line saying so — and the Wallet's own *Check Registration
Certificates* preference does not bring it back.

So a run with WD-2 on cannot evidence `AS-AP-44-005` (`RPRC_22a`) or `AS-AP-44-007` (`RPRC_23`) in
either position of that preference. Those two become testable only when the engine signs its metadata,
which is the one change that also closes G1 and G8. That is a matrix correction, not a footnote — see
the test matrix in `../../docs/test-wallet-plan.md`.

Rules attached to this one, and they are not negotiable:

- **off by default**, and off in any run whose purpose is to evidence gate (a);
- a run with WD-2 on **never** supports a statement that gate (a) is satisfied — the gate is bypassed,
  not met;
- every result from such a run says so in the record.

Its only legitimate use is reaching the rest of the flow while G1 is open.

## WD-3 — additional TEST Access CA anchor

**Conditional, and quite possibly unnecessary.** Only if the Q1a chain check
(`scripts/verify-access-certificate-chain.sh`) shows that our access certificate does not chain to an
anchor on the dev `WRPACProviders` LoTE.

Point: `EudiWalletConfig.configureReaderTrustStore(readerTrustedCertificates = listOf(ourDevAccessCa))`,
which takes precedence over the ETSI store.

**Run the chain check before building this.** If Path A holds, WD-3 must not be built: it would
replace a real trust path with a configured one and make a passing test say less than the unmodified
wallet already would. Note also that `EudiWalletConfig` documents `configureEtsiTrust` with
`relaxPkixRevocation()` as the route for ETSI/LoTE-based trust, so if the failure is revocation rather
than anchoring, this is the wrong lever.

---

## What a test run must record

Per the scope decision, every run records all of:

| Field | Where it comes from |
|---|---|
| Wallet build hash | `build.sh`'s build record (APK SHA-256) |
| Upstream tag and commit | `pins.env` |
| Active deviations | `BuildConfig.EDTP_DEVIATIONS`, visible in the banner |
| EUDIPLO version and image digest | `docker compose images` |
| Platform commit | `git rev-parse HEAD` |
| Registration-certificate-check preference | The wallet's Settings toggle — **default off**, and it gates both the issuer and the verifier check |
