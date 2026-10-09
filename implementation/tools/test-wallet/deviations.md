# Wallet deviation register

Every way the EDTP test wallet differs from the official EUDI Reference Implementation at the pinned
tag, what it is for, and whether it is compiled in.

**Default is upstream behaviour, for every entry without exception.** A deviation that is off changes
nothing; a deviation that is on is named in `BuildConfig.EDTP_DEVIATIONS`, printed by the banner on
every screen, and must appear in the record of any test run it touched.

`build.sh --deviations` accepts `none` and `wd-2` to `wd-9`, and **refuses anything else**, and
any of them without what it needs, rather than accepting a flag that does nothing. An accepted-but-inert flag is how a test record comes to say
"WD-1 active" about a build where it was not.

| | Deviation | Gate | Kind | State |
|---|---|---|---|---|
| **Identity** | Distinct `applicationId`, app name and an on-screen banner | — | Identity only | **Built** (W1) |
| **WD-1** | `eaaProviders` trust list pointing at our TEST LoTE | (b), ARF §6.3.2.4 | Configuration of an ARF-intended mechanism | Not built |
| **WD-2** | Signed-issuer-metadata requirement relaxed | (a), ARF §6.6.2.2 | **Security relaxation** | Not built |
| **WD-3** | `wrpacProviders` trust list pointing at our TEST LoTE, which carries the notified anchors **plus** ours | — | Configuration of an ARF-intended mechanism | **Built** (W3, W4) — Path A failed |
| **WD-4** | `pidProviders` trust list pointing at our TEST PID LoTE, which carries the notified anchors **plus** our development PID Provider CA | (b), for a PID | Configuration of an ARF-intended mechanism | **Built** (W5, W6) |
| **WD-5** | The wallet's issuer list (*From list*) offers our issuers only (one or two); optional relabel of the merged PID row | — | Configuration (which issuers the app offers) | **Built** (W6), 24 September 2026; two issuers the same day |
| **WD-6** | Credential response encryption `REQUIRED` → `SUPPORTED`: an issuer that offers no encryption is accepted | — | **Security relaxation** | **Prepared** (W8), 2 October 2026 |
| **WD-7** | A release build logs warnings and errors only: no HTTP bodies in logcat or in the log files | — | **Hardening** (no protocol behaviour changes) | **Prepared** (W8), 2 October 2026 |
| **WD-8** | `wrprcProviders` trust list read from another address | — | Configuration of an ARF-intended mechanism | **Built** (F2), 7 October 2026 |
| **WD-9** | `pubEaaProviders` trust list read from another address | — | Configuration of an ARF-intended mechanism | **Built** (F2), 7 October 2026 |
| **WD-10** | The ETSI TS 119 602 data-model library reads a `LoTELegalNotice` written as a multilingual character string | — | **Defect fix in a dependency**: the library is rebuilt from its pinned source with one patch | **Prepared** (F4), 9 October 2026 |

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

## WD-5 — the wallet's issuer list offers our issuers only

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

**Two issuers**, `--issuer <url>,<url>`, for the CORPME demonstration: the PID from `pid-1` and the
representation credentials from `rpi-1`. The two go into upstream's own two slots, the second pointed
at the second URL with the same settings; nothing is added. More than two is refused. W6 was rebuilt
this way on 24 September 2026, with the same suffix, so it updates in place and keeps its documents.

**Three issuers**, `--issuer <url>,<url>,<url>`, for the Large Family Title (28 September 2026): the
PID from `pid-1`, the representation credentials from `rpi-1`, and the title from `fam-1`, a fictitious
autonomous community. The third is **the one addition WD-5 makes**: upstream has two slots, so the
second slot's `VciConfig` block is emitted again as the last element, with only its URL and its
`order` (2) changed — every client setting is the second slot's, which is upstream's. The wallet builds
its list from `issuersConfig` generically (`associateWith`, sorted by `order`) and nothing in it counts
to two. Checked on a copy of the pinned upstream file: the only change is the added block (and a
trailing newline). More than three is refused. **Built on 28 September 2026** as W7 rebuilt in place
(release, our key, `.edtptest7`), and exercised: `reference-wallet-testing.md` §8.1p.

**W7** (24 September 2026) is the build for the generic, permanent demonstration environment (ADR
0010). It has the same deviations and the same two issuers as W6, but the row label is "PID (demo)",
the suffix is `.edtptest7`, the name is "EDTP TEST 7", and it is a **release** build signed with our
`OU=TEST ONLY` key. It is installed alongside W6, which keeps "PID - FNMT" for client demonstrations.

> **Correction, 2 October 2026.** This entry said a release build logs no HTTP bodies. **It does.**
> W7 wrote full request and response bodies to logcat and to its log files during an issuance — see
> WD-7 for why. Any W1–W7 release build has the same behaviour. W8 is the first build without it.

**Offers are unaffected.** A credential offer from any issuer still works, because upstream uses the
first configured issuer's settings for an issuer it does not know.

**`--pid-label`** (optional) replaces upstream's fixed "PID Combined" label of an issuer's merged PID
row with a flavour string resource; W6 uses "PID - FNMT".

**One thing to know on the phone.** Every EDTP test build keeps upstream's authorization redirect,
`eu.europa.ec.euidi://authorization`. With several builds installed, Android may ask which app should
open it when the browser hands back; choose the build the flow started in.

### What a run with this build may and may not say

That this platform can issue a PID into a wallet that *discovers* it as its issuer, with the
authorization step on a web form of ours — and, with two issuers, that a representation credential
can be requested the same way, the person identifying mid-issuance by presenting that PID; with three,
that a second issuer (the Large Family Title's) is offered alongside. Nothing about which issuers an unmodified wallet offers —
it offers the EUDI reference issuers, and its list is not something a Relying Party or an issuer
controls. The PID and the representation data are test data, and the FNMT and CORPME branding is a
demonstration, not a service of either.


## WD-6 — credential response encryption `REQUIRED` → `SUPPORTED`

**A security relaxation.** Wallet Core 0.30.2's `OpenId4VciManager.Config.Builder` defaults to
`EncryptionSupportConfig(credentialResponseEncryptionPolicy = REQUIRED, EcConfig(P-256), RsaConfig(2048))`
(read from the bytecode), and the app never overrides it. Under `REQUIRED`, openid4vci-kt 0.13.1
(`IssuanceEncryptionKt.responseEncryptionSpec`) refuses an issuer whose metadata carries no
`credential_response_encryption`, with `ResponseEncryptionRequiredByWalletButNotSupportedByIssuer`,
before it asks for a token.

Found on 2 October 2026 with an external EAA issuer's development deployment, whose offer and
metadata W7 resolved and then refused for exactly that reason.

The point is in the per-flavour `WalletCoreConfigImpl`: `.withResponseEncryptionConfig(...)` with the
same defaults and `SUPPORTED`, inserted after `.withDPopConfig(DPopConfig.Default)` in **every**
`VciConfig`. Every slot matters, because an offer from an issuer the wallet does not list is handled
with the first slot's settings. `build.sh` applies it after WD-5, so a third slot is covered, and
refuses if any slot is missed.

### What it changes and what it does not

| Issuer's metadata | `REQUIRED` (upstream) | `SUPPORTED` (WD-6) |
|---|---|---|
| no `credential_response_encryption` | **refused** | accepted, response **in clear** inside TLS |
| encryption supported, not required | encrypted | encrypted |
| encryption required | encrypted | encrypted |

Only the first row changes. A credential from such an issuer reaches the wallet protected by TLS
alone, with no application-layer encryption.

### What a run with this build may and may not say

It may say that issuance against an issuer without response encryption works with a wallet relaxed
to accept it. It may **not** say that an unmodified wallet would accept that issuer. It would not, and
the issuer's operator needs to know that. Whether the ARF or HAIP *require* credential response
encryption has not been checked against the HLR register. `docs/interop-findings.md` C13 records it
as an open question.

## WD-7 — a release build logs warnings and errors only

**Hardening, not a relaxation.** It changes nothing the wallet accepts or sends; it is registered as
a deviation because it is a behavioural change to upstream code and the banner must show it.

Upstream at the pinned tag logs HTTP bodies **in release builds**, through a path that `build.sh`, this
register and `docs/demo-hosting-proposal.md` §7 all missed:

1. Wallet Core wraps the HTTP client the app hands it (`withKtorHttpClientFactory`) in Ktor's
   `Logging` plugin at **`LogLevel.ALL`** (`KtorHttpClientFactoryExtensionsKt.wrappedWithLogging`), and
   forwards every line to the wallet `Logger` at DEBUG, tag `OpenId4VciManager`.
2. The app's `WalletCoreLogControllerImpl` passes DEBUG records on to `LogControllerImpl`. Wallet
   Core's own `configureLogging` level evidently does not filter a custom logger: its default is
   INFO, and DEBUG lines reached logcat.
3. `LogControllerImpl` plants `Timber.DebugTree()` and a `FileLoggerTree` at **`Log.DEBUG`** in every
   build type. The second writes `files/logs/eudi-android-wallet-logs*.txt`, up to ten 5 MB files,
   which the app's own *share logs* action can send anywhere.

The `LogLevel.NONE` that upstream's `NetworkModule` sets for release governs the app's own client
only. Observed on W7 (release) on 2 October 2026: issuer metadata, authorization server metadata and
the offer, in full, in logcat under `EUDI Wallet DEMO-RELEASE`. On an issuance that completes, the
credential response, and with it the credential, goes the same way.

The point is `deviations/wd-7.patch`, against `business-logic/src/main/.../log/LogController.kt`
(shared code, so a patch against `src/main`, not a flavour copy). For `AppBuildType.RELEASE` both
trees take a floor of `Log.WARN`; debug is unchanged. `build.sh` **refuses wd-7 with
`--build-type debug`**: the app's own Ktor client logs bodies there too, so the banner would claim a
protection that build does not have.

What it leaves:

- Warnings and errors are still logged, to logcat and to the files. That is how an issuance failure
  still has a reason, such as the WD-6 error above. An exception message can echo an issuer's
  error response; it does not carry a credential, but that has not been proven for every path.
- Files written by an earlier build stay in the app's data directory until the app is uninstalled or
  its data cleared. W8 is a new `applicationId`, so it starts with none.

## W8 — WD-6 and WD-7 on top of W7

Prepared 2 October 2026 (`--prepare-only`, and the patched modules compile for `edtptestRelease`); the signed APK is built by the operator, who holds the key password. Release, our `OU=TEST ONLY` key, `.edtptest8`, "EDTP TEST 8", deviations
`wd-2,wd-3,wd-4,wd-5,wd-6,wd-7`, the same three issuers and "PID (demo)" label as W7. It installs
**alongside** W7, so it starts with no documents. W7 is not rebuilt in place, because W7 is the build
recorded in earlier runs.

## W9 — a fourth listed issuer, on top of W8

Prepared 5 October 2026 (`--prepare-only`: four `VciConfig` slots, `order` 0 to 3, WD-6 on all four);
**not built**: the signed APK is built by the operator, who holds the key password. Release, our
`OU=TEST ONLY` key, `.edtptest9`, "EDTP TEST 9", deviations `wd-2,wd-3,wd-4,wd-5,wd-6,wd-7` — no new
deviation: WD-5 now takes up to four issuers, the fourth being another copy of the second slot's
settings. The fourth is `…/issuers/nominas-1`, "Nóminas Demo", which issues the income certificate
Banco Horizonte's loan asks for (`docs/credential-catalogue.md`). It installs **alongside** W8, so it
starts with no documents.

    ANDROID_HOME=… ANDROID_KEYSTORE_PATH=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… ./build.sh \
      --deviations wd-2,wd-3,wd-4,wd-5,wd-6,wd-7 \
      --wrpac-lote https://ssanchocanela.github.io/european-digital-trust-platform/lote/WRPACProviders.jwt \
      --pid-lote https://ssanchocanela.github.io/european-digital-trust-platform/lote/PIDProviders.jwt \
      --issuer https://edtp-engine.murcata.es/issuers/pid-1,https://edtp-engine.murcata.es/issuers/rpi-1,https://edtp-engine.murcata.es/issuers/fam-1,https://edtp-engine.murcata.es/issuers/nominas-1 \
      --pid-label "PID (demo)" --app-id-suffix .edtptest9 --app-name "EDTP TEST 9"

## A client's look, and a build for a client's own issuers

Decided 7 October 2026 (`CLAUDE.md` §6.22). Two things, neither a deviation:

- **`--brand <name>`** copies a look from `brands/<name>` — logo, launcher icon, theme colours — over
  the flavour's resources. Appearance only: the banner, the signing key and the `applicationId` are
  untouched. `brands/fnmt` is FNMT-RCM's, at its request, from its published black-and-white logo.
- **A build without WD-5** offers upstream's own issuers under "Add document > From list" again.
  Which other deviations such a build needs depends on the issuers and verifiers it is to meet, and is
  recorded here per build, as W1 to W9 are.

### F1 — "FNMT-RCM Cartera demo", the first build for FNMT-RCM

**Built by the operator on 7 October 2026**: `eu.europa.ec.euidi.fnmtdemo1`, "FNMT-RCM Cartera demo", APK
SHA-256 `433bf8fc9a4df6115cda766b9c07e29aad27d5a576fa4b8295bd8b166d9ebe5f`. Checked in the package: the identity, our signature, the deviations, upstream's two
issuers, the TEST PID list, and the brand's launcher icon. **Not yet installed or seen on a device, and
not delivered.**
Release, our `OU=TEST ONLY` key, `.fnmtdemo1`, deviations **`wd-2,wd-4,wd-6,wd-7`**, look `fnmt`.

| Choice | Why |
|---|---|
| No WD-5 | "Add document > From list" offers upstream's two issuers. FNMT-RCM's own issuers, still being set up, are reached by QR code or deep link; they join the list when their addresses are final |
| WD-2, WD-6 | **Security relaxations, taken before knowing they are needed:** an issuer under construction may publish unsigned metadata and offer no response encryption, and without these the wallet refuses it outright. To be dropped if FNMT-RCM's issuers turn out to need neither |
| WD-4, our TEST PID list | So the certificate that signs FNMT-RCM's PID can be trusted **without a rebuild**: it is added to the list and the list republished. The list carries the seven reference anchors too, so a reference PID is trusted as before |
| No WD-3 | This build is not to present to our platform; presentation is another track. Access certificates are trusted from the reference list, as upstream |
| WD-7 | A release build that leaves our hands must not log HTTP bodies |

    ANDROID_HOME=… ANDROID_KEYSTORE_PATH=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… ./build.sh \
      --deviations wd-2,wd-4,wd-6,wd-7 \
      --pid-lote https://ssanchocanela.github.io/european-digital-trust-platform/lote/PIDProviders.jwt \
      --brand fnmt --app-id-suffix .fnmtdemo1 --app-name "FNMT-RCM Cartera demo"

### WD-8 and WD-9 — the other two trust lists

The wallet reads four trust lists, each from a single address: PID providers (WD-4), access-certificate
providers (WD-3), registration-certificate providers and public-body EAA providers. `--wrprc-lote`
(WD-8) and `--pubeaa-lote` (WD-9) set the last two, by replacing the exact upstream line, refused
without an `https` address. As with WD-3 and WD-4, a single address **replaces** the notified list:
the build trusts the anchors of the list it is pointed at and no others for that domain.

### F2 — the FNMT-RCM build, reading FNMT-RCM's own test trust lists

**Built by the operator on 7 October 2026**, APK SHA-256
`bcacaa587a07993ebd2ca54103f079bc2139dbc851b5881e46829e6aa64ffed7`. Checked in the package: the identity, our signature, the deviations, the four list addresses and
the brand's launcher icon. **Not yet installed.** It replaces
F1 in place: the same `applicationId`, name, key and look. Deviations
**`wd-2,wd-3,wd-4,wd-6,wd-7,wd-8,wd-9`**.

F1 refused the PID of FNMT-RCM's test provider, as it should: its PID list was ours. F2 reads all four
lists from where FNMT-RCM's test lists are published,
`https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/<Name>.jwt` — the address each list
declares as its own distribution point. Seen on 7 October: issued 5 October 2026, valid to 3 April
2027, each signed by "EUDI Local Test LoTE JAdES Signing" under an "FNMT-RCM Test Root CA", each
carrying that root and one FNMT-RCM test certificate; the PID list's signature verifies.

**What follows from that, and was chosen by the user:** F2 trusts FNMT-RCM's test ecosystem **and
nothing else**. A PID from the reference issuers that "Add document > From list" still offers will be
refused, and so will a request from a verifier whose access certificate is ours or the reference
environment's. Those lists are not notified lists, and their content is FNMT-RCM's to change.

**Not known until it is tried:** whether the wallet loads these lists as they are. Their header differs
from the reference lists' (`typ` `application/jose`, an `iat`, a two-certificate `x5c`).

    ANDROID_HOME=… ANDROID_KEYSTORE_PATH=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… ./build.sh \
      --deviations wd-2,wd-3,wd-4,wd-6,wd-7,wd-8,wd-9 \
      --pid-lote    https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/PIDProviders.jwt \
      --wrpac-lote  https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/WRPACProviders.jwt \
      --wrprc-lote  https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/WRPRCProviders.jwt \
      --pubeaa-lote https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/PubEAAProviders.jwt \
      --brand fnmt --app-id-suffix .fnmtdemo1 --app-name "FNMT-RCM Cartera demo"

### F3 — the FNMT-RCM build without WD-2, for the registration check

Prepared 8 October 2026 (`--prepare-only`, `requireSignedMetadata()` back in the configuration);
**not built**. It replaces F2 in place: the same `applicationId`, name, key, look and four list
addresses. Deviations **`wd-3,wd-4,wd-6,wd-7,wd-8,wd-9`** — F2's without the one security relaxation
that concerned issuer authentication.

**Why.** FNMT-RCM wants issuance to work with the wallet's *Check Registration Certificates* preference
**on**. Under WD-2 it cannot: the wallet evaluates an issuer's registration only when it requires
signed metadata (`docs/issuer-trust-model.md`), so with WD-2 the outcome is never established, and an
outcome never established refuses. Seen on 7 October with F2's diagnostic variant: both offers resolved
and both were shown as "Issuance blocked".

**What the issuer must change before F3 can issue anything**, read from what it publishes on
8 October — until then F3 refuses it outright, preference on or off, because it will not take unsigned
metadata:

| | Seen | Needed |
|---|---|---|
| Signed metadata | Served as `application/jwt` when that alone is asked for; signature verifies, and its three-certificate chain reaches an anchor of the issuer's own WRPAC list | — |
| Content negotiation | Asked for `application/jwt, application/json`, which is what the wallet sends, it answers the unsigned JSON | The JWT whenever the client accepts it |
| Registration certificate | No `issuer_info` in the signed payload | `issuer_info: [{format: "registration_cert", data: <jwt>}]` at its top level, from a provider on the WRPRC list, covering every attestation the issuer offers |

**Not known until it is tried:** whether the registration certificate's content is what the wallet
library expects, and whether the issuer's access certificate passes the wallet's profile validation,
which is stricter than the path check made here. No issuer has passed this gate in our tests.

**A diagnostic variant**, for our own phone only, never delivered: the same without WD-7, as
`.fnmtdiag`, "FNMT diag". Without WD-7 a release build logs HTTP bodies, credentials included.

    ANDROID_HOME=… ANDROID_KEYSTORE_PATH=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… ./build.sh \
      --deviations wd-3,wd-4,wd-6,wd-7,wd-8,wd-9 \
      --pid-lote    https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/PIDProviders.jwt \
      --wrpac-lote  https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/WRPACProviders.jwt \
      --wrprc-lote  https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/WRPRCProviders.jwt \
      --pubeaa-lote https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/PubEAAProviders.jwt \
      --brand fnmt --app-id-suffix .fnmtdemo1 --app-name "FNMT-RCM Cartera demo"

### WD-10 — a multilingual `LoTELegalNotice` is read

**The defect.** ETSI TS 119 602 V1.1.1 clause 6.3.11 says the `PolicyOrLegalNotice` component holds
either `LoTEPolicy` elements, which are multilingual pointers, or "a sequence of `LoTELegalNotice`
elements which shall be multilingual character strings (see clause 6.1.4)" — a language tag and a
text. The wallet's library, `eudi-lib-kmp-etsi-1196x2`, models the first that way and the second as a
plain string (`PolicyOrLegalNotice.LegalNotice.legalNotice: String`), at the pinned `v0.4.0-alpha.1`
and still on `main` on 9 October 2026. A list that writes its legal notice as the clause says does
not parse — `Expected JsonPrimitive, but had JsonObject … at element: $.LoTELegalNotice` — and a list
that does not parse gives the wallet **no trust anchor at all**.

**The specification does not agree with itself here, and the library follows one half of it.** The
JSON schema the library bundles (`1960201_json_schema.json`, the schema of the same specification)
declares `LoTELegalNotice` as `{"type": "string"}`. So the library is consistent with the schema, and
FNMT-RCM's lists with the clause; a list written to the schema and a list written to the prose are
both defensible, and only a reader that accepts both reads both. That is what the patch does, and it
is why this is not described as the lists' defect nor simply as the library's.

**Why it surfaced now.** The reference lists and ours carry a `LoTEPolicy`, never a legal notice.
FNMT-RCM's four test lists carry a multilingual `LoTELegalNotice`. So **F2 and F3 never loaded any of
them**: every certificate FNMT-RCM's ecosystem presented was untrusted for want of a list, whatever
the lists contained.

**The patch**, `deviations/wd-10.patch`, against the library, not the wallet: a serializer on that
one property that accepts the multilingual form or a plain string and keeps the text. The property
stays a `String`, so the class is unchanged for the library's other modules, which the wallet takes
as published; the language tag is read past, and nothing in the wallet uses it. `build.sh` clones the
library at its pinned commit into `./upstream-etsi`, applies the patch, builds the one module's jar,
and points the wallet at it by a dependency substitution — under a group of our own
(`eu.europa.ec.eudi.edtp`), from a repository of one module inside the wallet's tree.

**The patch carries its tests** — the multilingual form, the plain form, a policy as before, and
three malformed notices refused — and `build.sh` runs them before it builds the library: a build whose
patched library fails them is not built.

**Not done, on purpose: the pointer key.** The model reads `PointerToOtherLoTE`; the bundled schema,
the reference lists and FNMT-RCM's all write `PointersToOtherLoTE`, so the model reads past it. Making
it read the plural would not be a parsing fix but a change of behaviour: the library **follows**
pointers (`LoadLoTEAndPointers`), so every list would start loading the lists it points to. In the
lists seen, each points only to itself. Nothing is gained today, and what a wallet trusts would come
to depend on a path nobody has exercised. Left as upstream has it, and noted in the draft issue.

**Checked**, on 9 October, with the library's own test task: the reported exception reproduced on the
unpatched source; with the patch both forms decode; and of five real lists — FNMT-RCM's four and the
reference WRPAC list — the unpatched library reads one and the patched reads all five. The patched
jar differs from the published one in the classes of that one source file and one added class. The
wallet's code compiles against it and its runtime classpath resolves to it.

**Not a fix for anyone else.** An unmodified Reference Wallet refuses FNMT-RCM's lists exactly as F2
did. The fix that counts is upstream: drafted, not filed, at
[`docs/upstream/etsi-lib-multilingual-legal-notice.md`](../../docs/upstream/etsi-lib-multilingual-legal-notice.md).

### F4 — the FNMT-RCM build that can read FNMT-RCM's lists

**Built by the operator on 9 October 2026**: `eu.europa.ec.euidi.fnmtdemo1`, "FNMT-RCM Cartera demo", APK
SHA-256 `a2a261eb448e002e070c15222342a3b1f14162fc3332b5db2bda6c9beb1fd572`; its diagnostic variant,
`eu.europa.ec.euidi.fnmtdiag`, `0070644313b54316696356eb39e8578b38bdbf589e8987db57093943d538e70a`.
Checked in both packages: the identity, our signature, the deviations, the four list addresses,
upstream's two issuers, and the patched reader's presence. **Not yet installed, and not delivered.**
F3 with WD-10:
**`wd-3,wd-4,wd-6,wd-7,wd-8,wd-9,wd-10`**, the same identity, look and list addresses. Its diagnostic
variant, for our own phone only, is the same without WD-7, as `.fnmtdiag`.

It is the first of these builds that can load FNMT-RCM's lists at all. What F3's entry says about the
issuer still holds: without WD-2 the wallet takes signed metadata only, and FNMT-RCM's issuer answers
the unsigned document to the wallet's request and publishes no `issuer_info`.

    ANDROID_HOME=… ANDROID_KEYSTORE_PATH=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… ./build.sh \
      --deviations wd-3,wd-4,wd-6,wd-7,wd-8,wd-9,wd-10 \
      --pid-lote    https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/PIDProviders.jwt \
      --wrpac-lote  https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/WRPACProviders.jwt \
      --wrprc-lote  https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/WRPRCProviders.jwt \
      --pubeaa-lote https://cebsi-aks-dev.emeal.nttdata.com/trust-list/LOTE/json/PubEAAProviders.jwt \
      --brand fnmt --app-id-suffix .fnmtdemo1 --app-name "FNMT-RCM Cartera demo"

A build that leaves our hands goes with [`DELIVERY-NOTICE.md`](DELIVERY-NOTICE.md), filled in.
The branded resources merge and the theme compiles; **no branded build has been built or delivered.**

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
