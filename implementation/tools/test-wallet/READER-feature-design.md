# EDTP test wallet — proximity READER (verifier) role

EDTP addition. Not part of the upstream EUDI Reference Implementation. Adds an **ISO 18013-5
proximity reader (verifier)** role to the fork, so the app can *read* a credential presented in
person over BLE (and, as a cheap extra, NFC), in addition to the holder role it already has.

Goal for the first cut: **read a PID (mdoc, `eu.europa.ec.eudi.pid.1`) over BLE**, show the
disclosed attributes and a verification verdict. **mDL (`org.iso.18013.5.1.mDL`) later** is one extra
entry in the request builder — no structural change.

## Why this is feasible with no new dependency

The stack already pins **Multipaz 0.99.0** (`org.multipaz:multipaz-android-legacy`). The holder role
uses its `DeviceRetrievalHelper`; the reader role is its counterpart `VerificationHelper`, already on
the classpath. Confirmed present in the resolved AAR:

- `com.android.identity.android.mdoc.deviceretrieval.VerificationHelper` (+ `Builder`, `Listener`)
- Reader transports: `DataTransportBleCentralClientMode`, `DataTransportBlePeripheralServerMode`
  (both expose `connectAsMdocReader`), and `DataTransportNfc`.

Confirmed reader API (bytecode):

```
VerificationHelper.Builder(Context, Listener, Executor)
    .setDataTransportOptions(DataTransportOptions)
    .setNegotiatedHandoverConnectionMethods(List<MdocConnectionMethod>)   // NFC handover
    .build()
helper.setDeviceEngagementFromQrCode(qr: String)   // from scanning the holder's engagement QR
helper.connect(MdocConnectionMethod)               // choose the BLE transport offered
helper.getSessionTranscript(): ByteArray           // to build the request and verify the response
helper.sendRequest(deviceRequest: ByteArray)
// Listener: onDeviceEngagementReceived(List<MdocConnectionMethod>), onDeviceConnected,
//           onResponseReceived(ByteArray), onError(Throwable), onDeviceDisconnected(Boolean)
```

Request/response CBOR is built and validated with `DeviceRequestGenerator` and
`DeviceResponseParser` from the core `multipaz` module (also on the classpath).

## Flow

1. **Scan** — camera screen scans the holder's device-engagement QR. (The holder shows it from its
   existing "present in person" screen.)
2. **Connect** — parse engagement → pick the BLE transport (`BleCentralClientMode` by default) →
   `connect(...)`.
3. **Request** — build a `DeviceRequest` for `eu.europa.ec.eudi.pid.1` with a fixed demo attribute
   set (family_name, given_name, birth_date, …), bound to `getSessionTranscript()`. No reader
   authentication in the first cut (unsigned request); add reader auth later if a holder requires it.
4. **Response** — on `onResponseReceived`, parse with `DeviceResponseParser(response, transcript)`.
5. **Result** — show the disclosed attributes and a **verdict** per document:
   - issuer signature (MSO) valid,
   - issuer certificate chains to a configured trust anchor,
   - MSO validity dates / `validityInfo`,
   - device authentication (device signature/MAC) valid,
   - requested-vs-returned (any missing).
   Shown transparently (demo-grade): the result screen lists each check pass/fail, like the trust
   overlay — it does not pretend a failing read succeeded.

## Trust anchors (verifier side)

To validate the PID's MSO the reader needs the **issuer** trust anchors (IACA / document-signer),
which is the *opposite* of the holder's reader-trust-store. First cut: a bundled trust store with our
dev PID signer anchor, overridable. A `--reader-trust <url|file>` build option can point it at our
PID list later; default is the bundled demo anchor. Never a production anchor (`TEST` only, §7).

## Module & build integration

- New feature module **`reader-feature`** mirroring `proximity-feature`
  (`scan` → `transfer`/loading → `result`, DI module, nav graph), wired into `settings.gradle.kts`,
  `assembly-logic` and `MainActivity`.
- Compiled in only under a new **`--reader`** build option (a *capability*, not a deviation; it adds
  functionality rather than relaxing trust). Default off → the build is byte-for-byte upstream without
  it. `build.sh` refuses it if the module/patch is absent, on the same honesty rule as every flag.
  A home entry "Read in person (verifier)" appears only when the flag is on, and the modified-build
  banner names the capability.
- Permissions: `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`/`BLUETOOTH_ADVERTISE`, `CAMERA` (QR),
  and NFC later. Requested at runtime on the scan screen.
- Delivered as a single conditional deviation, `deviations/edtp-reader-feature.patch`, applied only
  by the `--reader` block in `build.sh` (not in `patches/`, which are always applied — that is what
  keeps a non-reader build byte-for-byte upstream). Same discipline as the trust/wd patches: author
  against pristine upstream + `patches/`, freeze the index, generate only the delta, verify
  forward-apply with `git apply --check`. The patch touches `src/main` and the shared `build-logic`
  (module enum, `settings.gradle.kts`, `assembly-logic` dependency + Koin, `MainActivity` graph,
  `RouterContract`, the Home card, the banner) and adds the `reader-feature/**` module.

## EUPL

The reader is new functionality in a derivative of the EUPL 1.2 wallet. It is covered by the same
§6.22 terms as the rest of the modified build: a release build, our key, the EUPL notices and the
"modified, and how" statement travel with the file; source stays under `tools/test-wallet/`. Nothing
here changes the publishing conditions.

## Pinned API (Multipaz 0.99.0) — recorded from the resolved artifacts

Dumped with `javap` from the AARs Gradle already resolves (`multipaz-release` core and
`multipaz-android-legacy-0.99.0`), so Phases 2–4 compile against a known surface rather than a guess.

Reader transport / session (`com.android.identity.android.mdoc.deviceretrieval`, android-legacy):

```
VerificationHelper.Builder(Context, Listener, Executor)
    .setDataTransportOptions(DataTransportOptions)
    .setNegotiatedHandoverConnectionMethods(List<MdocConnectionMethod>)   // NFC handover
    .build()
helper.setDeviceEngagementFromQrCode(qr: String)
helper.connect(MdocConnectionMethod)                 // pick the BLE method offered
helper.getSessionTranscript(): ByteArray
helper.sendRequest(deviceRequest: ByteArray)
// Listener: onDeviceEngagementReceived(List<MdocConnectionMethod>), onDeviceConnected,
//           onResponseReceived(ByteArray), onError(Throwable), onDeviceDisconnected(Boolean)
```

Request (`org.multipaz.mdoc.request.DeviceRequestGenerator`, core):

```
DeviceRequestGenerator(encodedSessionTranscript: ByteArray)
suspend addDocumentRequest(docType, itemsToRequest: Map<String, Map<String, Boolean>>, …,
                           readerKey/SecureArea + certChain = null for an UNSIGNED request)
generate(): ByteArray
```
`addDocumentRequest` is a **suspend** function with Kotlin default args for the reader-auth
parameters, so the first cut (no reader auth) calls it with the doc type and the requested items and
lets the rest default. Must run in a coroutine.

Response + verdict (`org.multipaz.mdoc.response.DeviceResponseParser`, core):

```
DeviceResponseParser(encodedDeviceResponse: ByteArray, encodedSessionTranscript: ByteArray)
    .setEphemeralReaderKey(AsymmetricKey)            // only for an encrypted (18013-7) session
suspend parse(): DeviceResponse                      // suspend — run in a coroutine
DeviceResponse.getDocuments(): List<Document>
```
`Document` already carries every check the verdict screen needs, so the MSO-signature, device-auth,
digest-integrity and validity checks are **reads**, not re-implementations:

```
issuerSignedAuthenticated: Boolean        // MSO signature verifies against the DS cert in the chain
deviceSignedAuthenticated: Boolean         // device auth (signature/MAC) valid
numIssuerEntryDigestMatchFailures: Int     // + getIssuerEntryDigestMatch(ns, el): Boolean
validityInfoSigned / validityInfoValidFrom / validityInfoValidUntil / ...ExpectedUpdate: Instant
issuerCertificateChain: X509CertChain      // the chain WE validate to a trust anchor (Phase 4)
docType: String; getIssuerNamespaces(); getIssuerEntryNames(ns); getIssuerEntryString(ns, el); …
```
Note the parser authenticates the MSO signature against the document-signer cert *in the response*;
it does **not** decide trust. Chaining `issuerCertificateChain` to a configured anchor is our own
Phase-4 code, which is exactly the separate "chains to a trust anchor" check in the Flow above.

## Phases

1. **Scaffold + de-risk** — `reader-feature` module, `--reader` flag, nav entry, home tile,
   permissions; compiles; Multipaz 0.99 request/response/verdict signatures pinned (above).
   **DONE** (2026-11-06): `deviations/edtp-reader-feature.patch` + the `--reader` block in
   `build.sh`; `:app:compileEdtptestDebugKotlin` is green with the flag and the build is
   byte-for-byte upstream without it.
2. **Engagement + BLE** — scan QR, parse engagement, connect, surface connect/disconnect state.
   **DONE** (2026-11-09): `ReaderScanInteractor` wraps `VerificationHelper` (listener → a
   `Flow<ReaderTransferEvent>`; on `onDeviceEngagementReceived` it picks the first
   `MdocConnectionMethodBle` and `connect()`s); the screen requests camera + BLE permissions, scans
   the engagement QR with common-feature's `QrCodeAnalyzer` (reused, no new scanner), and reflects
   `SCANNING → CONNECTING → CONNECTED / DISCONNECTED / ERROR`. `:app:compileEdtptestDebugKotlin` and
   `processEdtptestDebugManifest` are green; the BLE + camera permissions merge into the app manifest.
   `reader-feature` gains an explicit `org.multipaz:multipaz-android-legacy:0.99.0` dependency —
   eudi-wallet-core exposes the Multipaz *core* but not android-legacy, which holds `VerificationHelper`;
   the version tracks the wallet-core Multipaz pin. **On-device run needs a second device acting as
   holder** (ours shows an engagement QR from its existing "present in person" screen) — deferred to
   the end of Phase 3, when there is a full read to watch.
3. **Request + response** — send the PID `DeviceRequest`, parse the `DeviceResponse`, show raw
   disclosed attributes. **DONE** (2026-11-09): on `onDeviceConnected` the interactor builds an
   **unsigned** PID request (`DeviceRequestGenerator(sessionTranscript).addDocumentRequest(...)` with
   `readerKey = null`, `signatureAlgorithm = Algorithm.UNSET`, `readerKeyCertificateChain = null` — no
   reader auth) and `sendRequest()`s it; `onResponseReceived` → `DeviceResponseParser(...).parse()` →
   a Multipaz-free `List<ReaderDocument>` whose attribute values are rendered with
   `Cbor.toDiagnostics(...)`. The screen shows `SCANNING → CONNECTING → REQUESTING → COMPLETED`
   (attribute list) with a "Read another" reset. `:app:compileEdtptestDebugKotlin` green.
   Both `addDocumentRequest` overloads require signing material; the unsigned path is the EcPrivateKey
   overload with a null key — recorded so Phase 4/5 (reader auth) knows where to plug a real key.
   **On-device run is blocked on a second device as holder** (BLE needs two): our one Pixel cannot be
   both reader and holder. Deferred until a second device (or the reference holder) is available.
4. **Verdict** — MSO signature + trust-anchor chain + validity + device auth → per-check result UI.
   **DONE** (2026-11-09): `parseResponse` computes a Multipaz-free `List<ReaderCheck>` per document —
   **Issuer signature (MSO)** (`issuerSignedAuthenticated`), **Data integrity** (`numIssuerEntryDigest
   MatchFailures == 0`), **Validity period** (`kotlin.time.Clock.System.now()` within
   `validityInfoValidFrom..validityInfoValidUntil`), **Device authentication** (`deviceSignedAuthenticated`)
   and **Trusted issuer** (the `issuerCertificateChain` reaches a configured anchor — anchor-in-chain
   via `X509Cert` equality). The screen shows each as ✓/✗/– above the disclosed attributes. A new
   `ReaderTrustStore` holds the issuer anchors; it returns **none** for now, so "Trusted issuer" is
   honestly **SKIPPED** (the MSO signature alone proves only that the document-signer in the chain
   signed the response, not that it is trusted). `:app:compileEdtptestDebugKotlin` green.
5. **Polish** — NFC negotiated handover, mDL doctype, error/timeout states, release build + notices.
   **Trust anchor DONE** (2026-11-09): the build bundles `reader-feature/res/raw/edtp_reader_trust.pem`
   — the "EDTP Development PID Provider CA - TEST ONLY" anchor, extracted from the published PID
   Providers LoTE (which our test PID issuer's signing certificates chain to). `ReaderTrustStore` loads
   it (optional resource, by name lookup) and the "Trusted issuer" check verifies the chain against it
   (`X509Cert.verify(anchor.ecPublicKey)` or anchor-in-chain), so it now evaluates PASS/FAIL instead of
   SKIPPED for a PID from our issuer. `build.sh --reader-trust <file>` replaces the bundled anchor
   (TEST only). `:app` compiles and the resource merges.
   **mDL DONE** (2026-11-09): the request now carries one docRequest per document type —
   `eu.europa.ec.eudi.pid.1` and `org.iso.18013.5.1.mDL` (namespace `org.iso.18013.5.1`,
   driving-licence elements) — built generically from `REQUESTED_DOCUMENTS`, so adding mDL was one map
   entry, no structural change. The holder returns only what it holds; the response parse, attribute
   render and verdict are doctype-agnostic, so an mDL shows its attributes and the five checks like a
   PID. We issue no mDL, so **no mDL anchor is bundled** (the default anchor is PID-only, so an mDL's
   "Trusted issuer" is a truthful ✗ until configured); the EC dev **mDL Providers LoTE** anchors are
   available via `--reader-trust` (a combined PID+mDL PEM can be prepared from that list).
   **Remaining**: NFC handover, error/timeout states, the release build + EUPL notices, and an
   on-device run against a second device (holder). *(start here)*

## Out of scope (first cut)

Reader authentication (signed request), multiple-document requests, Wi-Fi Aware transport,
reverse/negotiated engagement beyond NFC handover, and any production trust.
