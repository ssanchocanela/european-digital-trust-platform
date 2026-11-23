# Handoff — building the EDTP test wallet on **iOS**, from scratch

**Audience:** an iOS developer who will produce an iOS equivalent of the Android EDTP test wallet.
**Target:** reproduce the behaviour of the Android **FNMT "complete" build** — the deliverable last
cut on **2026-11-16** — on the EUDI **iOS** reference wallet.

This document is self-contained: read it top to bottom. The authoritative per-change detail (anchor
text, exact mechanism, standards citation) lives in [`deviations.md`](deviations.md); every Android
change is a patch in [`deviations/`](deviations/) or [`patches/`](patches/). Where this page and
`deviations.md` disagree, `deviations.md` wins.

---

## 0. Honesty rules (these bind the iOS build too)

- It is a **modified build**, never "the Reference Wallet" in any report, screen, test name or PR.
- **WD-6, WD-17, WD-20 are relaxations**; **WD-2** (not in this build) would be another. Any result
  that depends on a relaxation must say so.
- `TEST`/development only. Never a production trust anchor, never production issuers, synthetic data
  only.
- The bundled reader trust anchor and the dev PID Provider CA are **TEST** only.
- Give the iOS build its **own** bundle id and an on-screen **"modified build"** marker (the Android
  red banner is Android-only, but the *marker* requirement carries — see §3).

---

## 1. The exact target build

The Android deliverable this iOS build must match (`dist/DELIVERY-NOTICE.md`, 2026-11-16):

| | |
|---|---|
| Upstream (Android) | `eudi-app-android-wallet-ui`, tag `Wallet/Demo_Version=2026.09.42-Demo_Build=42`, commit `43f362d2` |
| Wallet Core | `0.30.2` (source `v0.30.2` @ `6533dd10` for the patched rebuilds) |
| ETSI TS 119 602 lib | `0.4.0-alpha.1` (source `v0.4.0-alpha.1` @ `7222a085` for the patched rebuild) |
| **Deviations** | `wd-3, wd-4, wd-6, wd-7, wd-8, wd-10, wd-11, wd-12, wd-13, wd-14, wd-15, wd-16, wd-17, wd-18, wd-19, wd-20, wd-21` |
| **Capability** | `reader (verifier)` (ISO 18013-5 proximity reader) |
| **Trust lists** | Commission **Launchpad 2026 testbed** (development env) for PID / WRPAC / WRPRC / mDL; pub-EAA left on the EUDI reference list |
| EDTP trust layers | granular C1/C2/C3 core always compiled in; runtime toggles off by default (§6) |

**iOS upstream to start from — the release that matches `2026.09.42-Demo_Build=42`** (resolved from
the EUDI iOS repo's tags and its `Package.resolved`, 2026-11-23):

| | |
|---|---|
| App | `eu-digital-identity-wallet/eudi-app-ios-wallet-ui`, tag **`Wallet/Demo_2026.09.42-Demo_Build=42`**, commit `7da95a7be097c538469293171612e743a4c0d550`. Xcode project **`EudiReferenceWallet.xcodeproj`** |
| `eudi-lib-ios-wallet-kit` | **0.51.0** — the app-facing façade (trust config, issuer list, schemes) |
| `eudi-lib-ios-openid4vci-swift` | **0.53.2** — issuance ⇒ WD-6, WD-11, **WD-21** |
| `eudi-lib-ios-openid4vp-swift` | **0.41.0** — presentation ⇒ WD-19, request object |
| `eudi-lib-ios-iso18013-data-model` / `-data-transfer` / `-security` | **0.25.0** — mdoc/mDL, the reader role, device/issuer-auth verdict |
| `eudi-lib-ios-statium-swift` | **0.5.0** — token status lists ⇒ WD-16 / WD-17 |
| `eudi-lib-ios-wallet-storage` | **0.26.0** — credential storage ⇒ WD-20 (reuse policy) |
| `eudi-lib-sdjwt-swift` | **0.14.7** — SD-JWT PID |

These are the versions that release pins; a later minor can move or rename a call site, so verify each
change against the version you actually build. Record the exact app tag + wallet-kit version in the
run record (§9).

> **⚠ Trust-model difference — investigate this FIRST.** The iOS wallet's `Package.resolved` has **no
> ETSI TS 119 602 trusted-list library** (Android's trust lives in `eudi-lib-kmp-etsi-1196x2`, which
> WD-10/13/15 patch). So the iOS trust mechanism is **not the same shape**: it likely does **not**
> consume LoTE/ETSI trusted lists the way Android does, and trust anchors may be configured directly
> in `eudi-lib-ios-wallet-kit`. This affects **WD-3, WD-4, WD-8, WD-10, WD-12, WD-13, WD-15** — half
> the set. Before porting those one by one, map **how `eudi-lib-ios-wallet-kit` 0.51.0 establishes
> issuer/reader trust**, then translate the *intent* (trust our dev PID/WRPAC/WRPRC/mDL anchors)
> rather than the Android list-parsing patches. §5.1 and §5.3 below assume the Android (ETSI-list)
> shape — adapt them to whatever iOS actually does.

---

## 2. Prerequisites & environment

| | |
|---|---|
| Machine | macOS with **Xcode** (a version that builds the chosen iOS wallet release; check its README) |
| Language | Swift / SwiftUI; dependencies via **Swift Package Manager** |
| Apple account | An **Apple Developer** account for signing: a Bundle ID, a development (or ad-hoc/TestFlight) **provisioning profile**, and a registered test device (UDID) |
| Device | A **real iPhone** — proximity BLE (the reader role, §7) and some secure-key paths don't work on the Simulator |
| Network | The phone must be on a network/DNS that resolves the FNMT dev hosts (see §4) |

**How you will apply "patches" on iOS.** Android rebuilds two dependencies from source with a patch
(the ETSI lib, Wallet Core). On iOS the equivalents are **Swift packages**. For any change that lands
inside a dependency (ETSI list parsing/validation, registration-cert parsing, status-list fetch), you
**fork the Swift package** (or vendor it as a local package) and point the app's `Package.swift` /
Xcode package dependency at your fork/branch. Changes inside the **app** itself (HTTP client, issuance
settings, issuer list, schemes) are edited in the app target directly. Each section below says which
it is.

---

## 3. What does NOT carry to iOS (Android build-identity only — skip)

`applicationId`/bundle-id suffix, the `edtptest`/`fnmtce`/`fnmtcediag` Gradle flavours, our Android
signing key, the on-screen **red banner widget**, `BuildConfig.EDTP_*`, and **WD-7** (Android release
logging). iOS has its own identity, signing and logging. **But keep the intent:** give the iOS build a
distinct bundle id and a visible **"modified build — TEST only"** marker on screen, and make sure a
release build does not log credential contents (the WD-7 *goal*, by iOS means).

---

## 4. NOT wallet changes — do not implement these in the wallet

These were fixed in **FNMT-RCM's back end**, not the wallet. If something fails here, it is not an iOS
porting gap:

- The **mDL signer** (sign the mDL with the mDL-list cert, not the PID cert).
- The verifier's **P-384 Request-Object signing** (the inbox/authgateway).
- The **registration certificate** (`provides_attestations`, the status host).
- **DNS/operational:** the phone must resolve `*.dev.credenciales.fnmt.es` and `cebsi-aks-dev…`.
  Seen to fail on some mobile-data DNS; use Wi-Fi/DNS that resolves the FNMT dev hosts.

---

## 5. The changes to port (the deviations)

Grouped by area. For each: **what**, **why/standard**, **Android site**, **iOS target**.

### 5.1 Trust lists → the Commission's development lists  *(config; WD-3/4/8/12)*

Point the wallet's provider lists at the Launchpad 2026 testbed lists. Android sets these in
`core-logic/.../WalletCoreConfigImpl.kt` (the `edtptest` source set) and overrides the URLs with
`--pid-lote/--wrpac-lote/--wrprc-lote/--mdl-lote`. On iOS these are the Wallet Kit trust-list
configuration.

| List | URL to configure | Android dev |
|---|---|---|
| PID providers | `https://development.trust.tech.ec.europa.eu/lists/eudiw/pid-providers.json` | WD-4 |
| WRPAC providers | `https://development.trust.tech.ec.europa.eu/lists/eudiw/wrpac-providers.json` | WD-3 |
| WRPRC providers | `https://development.trust.tech.ec.europa.eu/lists/eudiw/wrprc-providers.json` | WD-8 |
| mDL providers (`eaaProviders["mdl"]`) | `https://development.trust.tech.ec.europa.eu/lists/eudiw/mdl-providers.json` | WD-12 |
| pub-EAA providers | **leave at the EUDI reference list** `https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PubEAAProviders.jwt` | — |

- The Commission's `pub-eaa-providers.json` still returns **403 (not published)** — no CE URL to point
  to yet. Repoint pub-EAA to the CE URL when it is published.
- These lists **roll over**: honour `NextUpdate` / re-fetch; never serve a stale cached copy.

### 5.2 mDL is trusted from the mDL list  *(WD-12, extension)*

Wallet Kit trusts an attestation issuer only through a providers list, and its EU baseline has **no
mDL entry**, so an mDL is untrusted out of the box. Add the mDL providers list to the trust baseline
**and** classify the ISO doctype `org.iso.18013.5.1.mDL` against the `"mdl"` list. Without this the
iOS wallet (like Android) treats the mDL as a generic public-EAA and never trusts it.
*(Android: `deviations/wd-12.patch`, against the ETSI 119602 library's consultation module.)*

### 5.3 ETSI TS 119 602 list parsing / chain validation  *(defect fixes in the list library — fork the Swift ETSI lib)*

- **WD-10 — `LoTELegalNotice` as a multilingual string.** The list's
  `PolicyOrLegalNotice.LoTELegalNotice` is a multilingual character string; modelling it as a
  structured object fails to parse the **whole** list → every list unusable. Accept it as a string.
  (TS 119 602 V1.1.1 §6.3.11.) *(`deviations/wd-10.patch`.)*
- **WD-13 — validate up to the list anchor, not past it.** An ETSI list states which certificate is
  the trust **anchor**; PKIX takes the anchor as input (RFC 5280 §6.1). Stop at the first certificate
  in the chain that **is** a list anchor; do not require a path beyond it. Without this, a chain whose
  anchor is an intermediate is refused (`Path does not chain with any of the trust anchors`).
  *(`deviations/wd-13.patch`.)*
- **WD-15 — a leaf that IS an anchor is trusted directly.** If the leaf is **byte-for-byte** a trust
  anchor of the list (within validity), trust it directly. Built on WD-13. *(`deviations/wd-15.patch`.)*

These gate both the issuer-metadata chain (gate a) and attestation trust (gate b). Replicate in the
iOS list-parsing + chain-validation code.

### 5.4 Registration certificate (RPRC)  *(defect fixes in Wallet Core — fork the Swift wallet-kit)*

- **WD-14 — `srv_description` as an array of arrays.** Read the registration certificate's
  `srv_description` as ETSI **TS 119 475 V1.2.1** defines it (array of arrays), in addition to the flat
  form. *(`deviations/wd-14.patch`.)*
- **WD-16 — status list may be a CWT.** When the registration cert's status list cannot be had as a
  JWT, fetch it as a **CWT** and verify it the same way. *(`deviations/wd-16.patch`.)*
- **WD-17 — CWT status list sent as base64url text (relaxation).** FNMT's status endpoint returns the
  CWT **base64url-encoded as text**; decode it before reading. Transport **relaxation**
  (`draft-ietf-oauth-status-list §8.2` does not allow it); the token is still fully verified.
  *(`deviations/wd-17.patch`.)*

**Setting:** *Check Registration Certificates* is a wallet setting, **off by default**, gating the
whole RPRC check (issuer + verifier). iOS must expose/honour the same switch; **test both positions**
and record which each run used.

### 5.5 HTTP client Accept headers  *(defect fixes — app HTTP client)*

The app hands Wallet Kit an HTTP client whose JSON content-negotiation **adds** `Accept` types to
requests that must carry one type alone. Replicate on the iOS networking layer:

- **WD-11 — signed issuer metadata.** `/.well-known/openid-credential-issuer` asking for signed
  metadata must send `Accept: application/jwt` **alone** (not `application/jwt, application/json`).
  (ARF §6.6.2.2.) *(`deviations/wd-11.patch`.)*
- **WD-19 — OpenID4VP Request Object.** A request for the Request Object (`request_uri`) must send
  `Accept: application/oauth-authz-req+jwt` **alone** (OpenID4VP 1.0 §5.10). *(`deviations/wd-19.patch`.)*

### 5.6 Protocol / offer behaviour  *(config — app)*

- **WD-6 — response encryption `REQUIRED` → `SUPPORTED`** (security **relaxation**). Accept an issuer
  that offers no credential-response encryption. iOS: the OpenID4VCI issuance config
  (`credentialResponseEncryption` policy). *(`deviations/wd-6.patch`.)*
- **WD-18 — accept the Launchpad URL schemes** `eu-eaap://` (presentation) and `eu-eaa-offer://`
  (credential offer). iOS: register the schemes in **Info.plist** (`CFBundleURLTypes`) and accept them
  in the deep-link/offer parser. *(`deviations/wd-18.patch`.)*
- **WD-20 — PID reused across presentations** (`RotatingBatch`, one credential) instead of used once
  (`OnceOnly`, ten) — **privacy relaxation** (presentations become **linkable**). Needed for a demo
  where one PID is presented repeatedly (e.g. presentation-during-issuance). iOS: the PID issuance
  batch / credential-reuse policy. *(`deviations/wd-20.patch`.)*

### 5.7 Binding-key algorithm negotiation (ES384 / P-384)  *(WD-21 — defect fix, app issuance controller)*

**Essential for the FNMT `pid-demo` PID.** That issuer's signed metadata declares
`proof_types_supported.jwt.proof_signing_alg_values_supported: ["ES384"]` — it accepts **only** an
ES384 (P-384) proof of possession. The reference wallet always creates the credential's **binding key
as ES256 (P-256)**, so an ES384-only issuer is unsatisfiable (`ProofTypeSigningAlgorithmNotSupported`).

**Port:** before creating the binding key, read the offered document's
`proofTypesSupported[JWT].proof_signing_alg_values_supported`, pick a supported algorithm, and create
the binding key with **that** algorithm (ES384 ⇒ P-384) instead of the ES256 default; fall back to the
default unchanged when the issuer accepts ES256. On iOS, Secure Enclave generally holds only P-256, so
a P-384 key must go to a **software/TEE-equivalent** key store, not the Secure Enclave — mirror the
Android choice (`setUseStrongBox(false)`), i.e. do not force the hardware enclave for the non-P-256
key. *(Android: `deviations/wd-21.patch`, `WalletCoreDocumentsController`.)*

**Caveat (carries to iOS):** the FNMT issuer also sets `key_attestations_required`. If a key
attestation becomes a hard gate, it needs a key-attestation provider the reference wallet does not
configure — a separate, larger piece. Not yet proven end-to-end on Android either; flag it if it
blocks.

---

## 6. EDTP granular trust layers C1 / C2 / C3  *(advanced; optional for a first iOS cut)*

The Android build always compiles in a **trust core** (`patches/0004`–`0009`) plus runtime toggles
that verify trust in three independent layers, each tri-state **off | observe | enforce**, at three
lifecycle points (offer, pre-store, presentation):

- **C1 — signatures & binding.** Issuer signature (mdoc MSO / SD-JWT VC), request-object/reader-auth
  signature, RPAC/RPRC/WRPRC signature, holder/device-key binding.
- **C2 — chain vs trust lists.** PKIX chain of document-signer / RPAC / RPRC-signer against the LoTE
  anchors, entitlements, over-asking, certificate profile.
- **C3 — validity & revocation.** Validity + revocation of every certificate (RPAC CRL/OCSP,
  RPRC/WRPRC token status list, document-signer CRL/OCSP) and the credential's own status list.

`observe` records each check (pass/fail/unknown + reason) without blocking; `enforce` additionally
blocks (offer refused / credential deleted before store / request denied before consent); `UNKNOWN` is
blocking under `enforce`. Default: all layers **off** on a fresh install (byte-for-byte upstream).

> **Naming caution:** `deviations.md` labels these three layers "WD-21/WD-22/WD-23" in the granular-
> trust section, but the **deviation register's WD-21 is the binding-key fix in §5.7** — a different
> thing. Treat the three trust layers as **C1/C2/C3** to avoid the clash.

**For a first iOS build, this layer is optional** — it is a diagnostic/enforcement overlay, not needed
for issuance/presentation to work. If you port it, it is an app-level overlay plus check-site wiring
(observe grade feeds off outcomes the app already receives; enforce grade needs the wallet-kit fork
to stop failing open). See `deviations.md` §"Granular trust verification" and `TRUST-GRANULAR-design.md`.

---

## 7. Capability: proximity READER (verifier) role

A **capability**, not a deviation (Android stamps it `EDTP_READER`, separate from `EDTP_DEVIATIONS`).
It **adds** an ISO/IEC 18013-5 proximity reader so the wallet can *read* a credential presented in
person:

- Scan the holder's engagement **QR**, connect over **BLE**, send a `DeviceRequest`, parse the
  `DeviceResponse`, show the disclosed attributes.
- Per document, show a **five-check verdict**: issuer signature, data integrity, validity, device
  authentication, trusted issuer (✓/✗/–).
- Requests a **PID** (`eu.europa.ec.eudi.pid.1`) and an **mDL** (`org.iso.18013.5.1.mDL`). A **TEST**
  issuer anchor (the "EDTP Development PID Provider CA") is bundled so a PID shows "Trusted issuer" ✓;
  no mDL anchor is bundled, so an mDL's "Trusted issuer" is a truthful ✗ until configured.

**Android** uses Multipaz 0.99.0 (`VerificationHelper`, BLE reader transports, `DeviceRequestGenerator`
/ `DeviceResponseParser`). **iOS equivalent:** use the iOS proximity/verifier stack (the EUDI iOS
proximity libraries / mdoc reader; confirm what the chosen wallet-kit exposes). Needs **BLE + camera**
usage strings in Info.plist and a **second device as holder** to test (BLE needs two). `TEST` only;
never a production trust anchor. Design/phase detail: `READER-feature-design.md`.

> If the first iOS deliverable is holder-only (issuance + presentation), the reader role can be a
> **second phase** — say so in the run record rather than shipping it half-done.

---

## 8. Build, sign, install (iOS)

1. **Clone** the chosen `eudi-app-ios-wallet-ui` release; open in Xcode; let SPM resolve.
2. **Apply the changes** from §5 (and §6/§7 if in scope): app-target edits directly; dependency
   changes via **forked/local Swift packages** pointed at from the package manifest (§2).
3. **Configure** trust-list URLs (§5.1), schemes (§5.6), the RPRC setting (§5.4), and the
   "modified build" marker + distinct bundle id (§3).
4. **Signing:** set the team + a development/ad-hoc provisioning profile; register the test device.
5. **Archive & export:**
   - Xcode: *Product → Archive → Distribute App* (Development or Ad Hoc, or TestFlight), or
   - CLI: `xcodebuild -scheme <App> -configuration Release -archivePath build/App.xcarchive archive`
     then `xcodebuild -exportArchive -archivePath build/App.xcarchive -exportOptionsPlist <plist>
     -exportPath build/export`.
6. **Install** the `.ipa` on the registered device (TestFlight, Apple Configurator, or Xcode *Devices*).
7. **Record** the exact iOS app tag, wallet-kit version, and which forks/branches you used (§9).

*(No Android keystore, no `.apk`. Never distribute a build that logs credential contents — the WD-7
goal.)*

---

## 9. Test checklist + what a run must record

**Functional (against the FNMT dev env / Launchpad, synthetic data only):**
- [ ] **PID issuance** end-to-end (`pid-demo.dev.credenciales.fnmt.es`), including the **ES384** proof
      (§5.7) — the PID is stored, doctype `eu.europa.ec.eudi.pid.1`, issuer trusted.
- [ ] **Presentation** of the PID (OpenID4VP), request-object fetched and parsed (Accept header §5.5).
- [ ] **Presentation-during-issuance** (mDL against CORPME) if in scope — needs WD-20 so the PID
      survives repeated presentations.
- [ ] **mDL** trusted from the mDL list (§5.2) when an mDL is issued.
- [ ] **Check Registration Certificates** — run **both** positions (on/off) and record each.
- [ ] **Reader role** (§7) if in scope — needs a second device as holder.

**Every run records (as Android does):**

| Field | Where |
|---|---|
| iOS app tag + commit | the clone you built |
| Wallet-kit version + your fork branches | `Package.resolved` / your package pins |
| Active deviations / capabilities | your build config (mirror `EDTP_DEVIATIONS` + `reader`) |
| Trust-list URLs in effect | §5.1 |
| Registration-certificate-check position | the Settings toggle — default off; gates issuer **and** verifier |
| Back-end versions (EUDIPLO / FNMT env) | from the environment under test |

Say **"modified build"** (never "the Reference Wallet"), and flag any result that relied on a
relaxation (WD-6 / WD-17 / WD-20).

---

## 10. References

- [`deviations.md`](deviations.md) — the authoritative per-change register (anchor text, mechanism,
  standard, build log F1…F16). **Read the WD-NN section before porting that change.**
- [`deviations/`](deviations/) — the Android patches (`wd-NN.patch`), and `edtp-reader-feature.patch`.
- [`patches/`](patches/) — the always-applied base (`0001`…`0009`), incl. the trust core (`0004`) and
  observe/enforce wiring (`0005`–`0009`).
- `TRUST-GRANULAR-design.md`, `READER-feature-design.md` — the designs for §6 and §7.
- [`pins.env`](pins.env) — the Android upstream + dependency pins this build is defined against.
- [`HANDOFF-MAC.md`](HANDOFF-MAC.md) — the Android build/sign/run recipe, for cross-reference.
