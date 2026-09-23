# Wallet deviation register

Every way the EDTP test wallet differs from the official EUDI Reference Implementation at the pinned
tag, what it is for, and whether it is compiled in.

**Default is upstream behaviour, for every entry without exception.** A deviation that is off changes
nothing; a deviation that is on is named in `BuildConfig.EDTP_DEVIATIONS`, printed by the banner on
every screen, and must appear in the record of any test run it touched.

`build.sh --deviations` accepts `none`, `wd-2`, `wd-3`, `wd-4` and `wd-5`, and **refuses anything else**, and
any of them without what it needs, rather than accepting a flag that does nothing. An accepted-but-inert flag is how a test record comes to say
"WD-1 active" about a build where it was not.

| | Deviation | Gate | Kind | State |
|---|---|---|---|---|
| **Identity** | Distinct `applicationId`, app name and an on-screen banner | — | Identity only | **Built** (W1) |
| **WD-1** | `eaaProviders` trust list pointing at our TEST LoTE | (b), ARF §6.3.2.4 | Configuration of an ARF-intended mechanism | Not built |
| **WD-2** | Signed-issuer-metadata requirement relaxed | (a), ARF §6.6.2.2 | **Security relaxation** | Not built |
| **WD-3** | `wrpacProviders` trust list pointing at our TEST LoTE, which carries the notified anchors **plus** ours | — | Configuration of an ARF-intended mechanism | **Built** (W3, W4) — Path A failed |
| **WD-4** | `pidProviders` trust list pointing at our TEST PID LoTE, which carries the notified anchors **plus** our development PID Provider CA | (b), for a PID | Configuration of an ARF-intended mechanism | **Built** (W5, W6) |
| **WD-5** | The wallet's issuer list (*From list*) offers our issuer only; optional relabel of the merged PID row | — | Configuration (which issuers the app offers) | **Built** (W6), 24 September 2026 |

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

## WD-3 — `wrpacProviders` trust list pointing at our TEST LoTE

**No longer conditional: it is needed.** Path A failed for a reason unrelated to the trust question
it was meant to answer — the reference Registration Service cannot issue an access certificate at
all (`docs/interop-findings.md` C10) — so there is nothing to run the Q1a chain check against. The
chain check was run against our development certificate anyway, and reports what it should: no
notified anchor, fall back to Path B.

### The earlier description of this deviation was wrong

It said "additional TEST Access CA anchor in the reader trust store", via
`configureReaderTrustStore(readerTrustedCertificates = ...)`. Reading the library
(`eudi-lib-android-wallet-core` v0.30.2) shows that cannot be done as described:

- `EtsiTrustConfigBuilder` has **no method that adds a trust anchor**. Its whole surface is
  `loteLocations`, `classifications`, `fileCacheExpiration`, `cacheTtl`,
  `relaxCertificateProfiles`, `relaxPkixRevocation`, `jwtSignatureVerifier` and `loteConstraints`.
  Anchors come only from the LoTE URIs — which is `AS-WP-06-005` (`RPA_04`) enforced by
  configuration, not merely by policy.
- The block form the app actually uses, `configureReaderTrustStore { readerAuthPolicy(...) }`, sets
  `useEtsiReaderTrust = true` and its builder carries **only** the reader-auth policy. It cannot
  carry certificates.
- The certificate-taking overloads exist, but they *replace* the ETSI reader trust rather than add
  to it: a build using one would trust our CA and **distrust every notified Access CA**. That is a
  far larger behavioural change than this register described, and it would also need
  `revocationPolicy = SoftFail`, since the built-in store defaults to `HardFail` and our
  development CA publishes neither CRL nor OCSP.

So the deviation is done through the list mechanism instead, which is what the ARF intends and what
WD-1 already does for the issuer side.

### The point

`core-logic/src/edtptest/.../config/WalletCoreConfigImpl.kt`:

```kotlin
configureEtsiTrust {
    loteLocations(
        SupportedLists(
            // three unchanged, pointing upstream …
            wrpacProviders = Uri("<our published TEST LoTE>"),
        )
    )
}
```

`wrpacProviders` is a single `Uri`, so pointing it at our list *replaces* the notified one. **That
is why our list carries the seven notified anchors as well as ours** — `scripts/make-test-lote.mjs`
fetches the live notified list and appends our anchor as an eighth, so the build trusts every real
Relying Party *and* us. Without that, WD-3 would be a replacement masquerading as an addition.

### The second point, if the first is not enough

Possibly `jwtSignatureVerifier`. `EtsiTrustConfig.customJwtSignatureVerifier` defaults to `null`, so
the library's built-in verifier decides whether our self-signed list signer is acceptable, and what
it requires has not been established. If it refuses the list, this becomes the same "two
configuration points, one alone does nothing" shape as WD-1. **Determined on the first build, not
before.**

### What a run with this build may and may not say

It may say that our presentation flow works end to end against a real wallet. It may **not** say
anything about whether an unmodified wallet would accept our certificates — it would not, and that
is the whole reason this exists. Every report, document, test name, log line and PR statement says
"modified wallet".

## WD-4 — `pidProviders` trust list pointing at our TEST PID LoTE

For the **test PID issuer**: a PID this platform issues, signed under the development PID Provider CA
(`scripts/make-dev-pid-ca.sh`), so the end-to-end demonstration's first step no longer depends on the
EUDI reference issuer.

The shape of WD-3 in the other trust domain. `pidProviders` is a single `Uri` in the same
`SupportedLists`, so pointing it at our list *replaces* the notified one, and our list carries the
seven notified development PID anchors forward for the same reason — the build still trusts a PID from
the reference issuer. Built by `scripts/make-test-lote.mjs --kind pid` and published at
`https://ssanchocanela.github.io/european-digital-trust-platform/lote/PIDProviders.jwt`, signed by the
same list signer as WD-3's.

**One configuration point, not two.** Unlike WD-1, the classification already exists: upstream
classifies `urn:eudi:pid:1` and `eu.europa.ec.eudi.pid.1` as PIDs, which resolves them to
`VerificationContext.PID`, which consults `pidProviders`. Only the location changes.

**Applied as a line replacement, not a patch.** `wd-3.patch` carries the upstream `pidProviders`
line as context, so a patch changing it could never be applied together with WD-3. `build.sh`
replaces that exact line with `deviations/wd-4.kt` and refuses if it is not there exactly once.
Verified with `--prepare-only` for `wd-2,wd-3,wd-4`.

### What a run with this build may and may not say

That a PID issued by this platform under a development CA is accepted by a wallet configured to
trust that CA, and that it can then be presented to this platform. **Nothing** about a real PID, a
real PID Provider, or an unmodified wallet — which would refuse it, correctly: PID Provider anchors
come from a Member State notification (`EW-PIO-01-024`, `OIA_12`), and ours has none. The PID is
**test data**, whatever it contains.

## WD-5 — the wallet's issuer list offers our issuer only

For **wallet-initiated PID issuance** from the app's own *Add document → From list*, built for an FNMT
demonstration. Upstream builds that list from the Credential Issuer metadata of the issuers hard-coded
in `issuersConfig` — the EUDI reference issuer and its backend; there is no remote list. WD-5 leaves
exactly one, ours (`--issuer`, e.g. `https://edtp-engine.murcata.es/issuers/pid-1`), with every other
setting of the entry as upstream has it: attestation-based client authentication as `eudiw-abca`, the
same authorization redirect deep link, PAR if supported, DPoP, the same reuse policies.

**Applied by anchoring on the two exact upstream URLs.** `build.sh` removes the second `VciConfig`
block whole, points the first at `--issuer`, and refuses if either URL is not there exactly once, if
an EUDI issuer remains, or if more than one issuer is left. Verified with `--prepare-only` and built as
**W6** (`.edtptest6`, debug, `wd-2,wd-3,wd-4,wd-5`) on 24 September 2026.

**Offers are unaffected.** A credential offer from any issuer still works, because upstream uses the
first configured issuer's settings for an issuer it does not know.

**`--pid-label`** (optional) replaces upstream's fixed "PID Combined" label of an issuer's merged PID
row with a flavour string resource; W6 uses "PID - FNMT".

**One thing to know on the phone.** Every EDTP test build keeps upstream's authorization redirect,
`eu.europa.ec.euidi://authorization`. With several builds installed, Android may ask which app should
open it when the browser hands back; choose the build the flow started in.

### What a run with this build may and may not say

That this platform can issue a PID into a wallet that *discovers* it as its issuer, with the
authorization step on a web form of ours. Nothing about which issuers an unmodified wallet offers —
it offers the EUDI reference issuers, and its list is not something a Relying Party or an issuer
controls. The PID is test data, and the FNMT branding is a demonstration, not an FNMT service.

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
