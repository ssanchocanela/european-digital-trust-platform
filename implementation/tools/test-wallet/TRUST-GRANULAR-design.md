# EDTP Test Wallet — Granular trust verification (design)

Status: **design for review** (no code yet). Target: the EDTP test wallet (fork of EUDI reference
Android wallet, tag `Wallet/Demo_2026.09.42-Build-42`, wallet-core `0.30.2`, etsi-lib `0.4.0-alpha.1`).

## Goal

Make the wallet verify **complete trust** at the three lifecycle points, but **granularly** — three
independent, configurable checks (by validation *layer*), each able to run and report without
necessarily blocking, and surface every check (pass/fail + reason) in an in-app floating panel.

Points (unchanged):
1. **OFFER** — reading/resolving a credential offer (OID4VCI).
2. **PRESTORE** — an issued credential received, before storing it.
3. **PRESENT** — a third party (verifier) requests a presentation (OID4VP + ISO 18013-5/7).

## The three checks (by layer)

| Flag | Layer | Validates |
|---|---|---|
| `EDTP_TRUST_C1_SIGNATURES` | Integrity & binding | issuer signature (mdoc MSO / SD-JWT), request-object signature, RPAC/RPRC/WRPRC signature, holder/device-key binding (`cnf`, `isBoundTo`) |
| `EDTP_TRUST_C2_CHAIN` | Chain vs trust lists | PKIX chain of doc-signer / RPAC / RPRC-signer against LoTE anchors, entitlements, over-asking/over-provisioning, cert profile (`Period`/extensions) |
| `EDTP_TRUST_C3_REVOCATION` | Validity & revocation | validity dates (notBefore/notAfter) of every cert + revocation of everything: RPAC CRL/OCSP, RPRC/WRPRC token status list, doc-signer CRL/OCSP, the credential's own status list |

Each flag is **tri-state**:
- `off` — check does not run.
- `observe` — check runs, result is recorded to the ledger (feeds the overlay), **does not block** the flow.
- `enforce` — check runs, result recorded, and on `FAIL`/`UNKNOWN` it **blocks** at that point.

Defaults: `edtptest` flavour ships all three at `observe` (interop-safe); a "strict" build sets all to
`enforce`.

## Core components (new)

### `TrustLedger`
Observable, per-flow (correlationId) collector. Each individual check emits:

```
TrustCheckResult(
  layer:   C1 | C2 | C3,
  point:   OFFER | PRESTORE | PRESENT,
  subject: ISSUER_SIG | DOC_SIGNER_CHAIN | RPAC | RPRC | WRPRC | CRED_STATUS | ...,
  outcome: PASS | FAIL | UNKNOWN | SKIP,
  reason:  <core enum>,      // EXPIRED, REVOKED, REVOCATION_STATUS_UNKNOWN, UNTRUSTED_PROVIDER,
                             // NOT_BOUND_TO_REQUESTER, SIGNATURE_INVALID, ENTITLEMENT_MISSING,
                             // OVER_ASKING, STATUS_MISSING, ...
  detail:  String?           // cert subject / failing URL / exception message
)
```

Exposed as a `StateFlow<List<TrustCheckResult>>`; reset at the start of each flow, last flow retained
for review.

### `TrustGate.gate(layer, result)`
Single wrapper every check routes through:
- records to the ledger when `layer != off`;
- if `layer == enforce && result.outcome in {FAIL, UNKNOWN}` → throws `TrustBlockedException(layer, reason)`;
- otherwise returns (observe/off do not throw).

Block semantics per point:
- OFFER → `OfferResult.Failure` / `IssuerNotTrusted` (existing mapping, `WalletCoreDocumentsController.kt:739`).
- PRESTORE → throw inside `evaluateIssuerTrust` → `onFailure` deletes the doc (`ProcessResponse.kt:145`).
- PRESENT → deny before emitting `TransferEvent.RequestReceived` (no consent screen).

## Interception points

Legend: **flip** = toggle/behaviour change on an existing seam; **add** = new instrumentation/code.

### C1 — Integrity & binding
| Point | Seam | File:line | flip/add |
|---|---|---|---|
| PRESTORE | issuer sig mdoc `Cose.coseSign1Check` / SD-JWT; **`getOrNull` fail-open closed** → `getOrElse { if (EdtpTrustEnforce.failClosed) throw else null }` (done, `deviations/edtp-c1-failclosed.patch`) | `MsoMdocCredentialTrustVerifier.kt:84`, `SdJwtVcCredentialTrustVerifier.kt:62`, `EvaluateIssuerTrust.kt:78-102` | done |
| PRESENT (OID4VP) | `Resolution.Invalid` (request-object sig) → C1 FAIL; reader hook **fail-closed** when store null | `OpenId4VpManager.kt:182-195`, `OpenId4VpReaderTrust.kt:37` | add/flip |
| PRESENT (ISO) | reader-auth `signatureValid`; `ReaderAuthPolicy = AlwaysRequire` under enforce | `DeviceRequestProcessor.kt:99-110`, `ReaderAuthPolicy.kt:40` | flip |
| OFFER/PRESENT | RPRC/WRPRC signature | `IssuerRegistrationResolver.kt` (D2), `WrprcAuthenticator.kt:71` | add (record) |
| binding | `isBoundTo` access-cert; `cnf`/device-key | `RegistrationCertificateChecks.kt:41`, `MsoMdocCredentialCertifier.kt:41`, `SdJwtVcCredentialCertifier.kt:70` | add (record) |

Note: OID4VP request-object JWS and SD-JWT issuer signature verification live in external libs
(`eudi-lib-jvm-openid4vp`, `eudi-lib-jvm-sdjwt-kt`, not in clone). We record their outcome at the
wallet seam and gate there; we do not re-implement them.

### C2 — Chain vs trust lists
| Point | Seam | File:line | flip/add |
|---|---|---|---|
| PRESTORE | PKIX doc-signer chain vs LoTE anchors | `ValidateCertificateChainUsingPKIXJvm.kt:99-118` | add (record) |
| OFFER | RPRC signer chain + entitlements + over-provisioning | `IssuerRegistrationResolver.kt` (D3), `DefaultIssuerRegistrationEvaluator.kt:70-101` | flip (un-gate WD-2/pref) |
| PRESENT | RPAC chain + WRPRC signer chain + over-asking + profile `Period`/extensions | `EtsiReaderTrustStore.kt:79` / `ReaderTrustStoreImpl.kt:70`, `WrprcAuthenticator.kt:77`, `OverAsking.kt:49` | add |
| PRESENT | **WRPRC warning-only → blocking** under enforce | `RegistrationCertificatePolicyFactory.kt:75-86` | flip |

### C3 — Validity & revocation
| Point | Seam | File:line | flip/add |
|---|---|---|---|
| cross-cutting | **re-enable** PKIX CRL/OCSP (undo `relaxPkixRevocation`) when C3≠off | `WalletCoreConfigImpl.kt:161`, `EtsiTrustProvider.kt:102-107`, `…PKIXJvm.kt:126` | flip |
| RPAC | revocation CRL/OCSP + expiry on the **ETSI path** (none today) → add `RevocationPolicy`/`Period`, or route RPAC via `ReaderTrustStoreImpl(HardFail)` | `EtsiReaderTrustStore.kt:79`, `ReaderTrustStoreImpl.kt:86-110`, `Period.kt` | add |
| RPRC/WRPRC | status list + expiry (exists; `unknown=fail`) → record + block in PRESENT | `RegistrationCertificateChecks.kt:44-114` | flip |
| credential | the credential's own status list **also PRESTORE** (today `checkStatus=null`) | `SdJwtVcCredentialTrustVerifier.kt:65` + `documentStatusResolver` (`WalletCoreConfigImpl.kt:176`) | add |
| doc-signer | expiry + CRL/OCSP of signing cert | `…PKIXJvm.kt:111,177` | flip |

## Floating panel (overlay)

- In-app expandable panel (Compose bottom-sheet) subscribed to the `TrustLedger` `StateFlow`.
- Collapsed: badge with per-layer counts, e.g. `C1 ✔  C2 ✔  C3 ✘2`.
- Expanded: three sections (Integrity / Chain / Validity-Revocation); each row = subject, ✔/✘/–,
  `reason` enum, timestamp, point; tap → detail (cert subject / failing URL / exception).
- Resets per flow; keeps the last for review. In `observe` it shows exactly "what was checked and what
  would have failed" without breaking the run.

## Config wiring

- `BuildConfig.EDTP_TRUST_C1/C2/C3` (enum) + runtime override in Settings (mirrors
  `isRegistrationCheckEnabled`, `WalletCoreConfigImpl.kt:167`).
- Added to the on-screen banner and to the test *run record* (like `EDTP_DEVIATIONS`).
- Landed as a new deviation group **WD-21 (C1) / WD-22 (C2) / WD-23 (C3)**: patches under
  `implementation/tools/test-wallet/patches/`, entries in `deviations.md`, flags parsed by `build.sh`.

## Interaction with existing deviations

- `relaxPkixRevocation` **is** C3's lever; `WrpRegistrationPolicy` / `ReaderAuthPolicy` are the PRESENT
  blocking levers; WD-2 + `isRegistrationCheckEnabled` gate C2 at OFFER; WD-3/4/8 define C2 anchors;
  WD-16/17 widen C3 status source. The new group composes **on top** of these; banner/record reflect it.

## Known limits / honesty

- Request-object JWS and SD-JWT signatures: verified in external libs — we gate on their outcome, not a
  re-implementation.
- RPAC revocation/expiry on the default ETSI reader path and the credential status list pre-store are
  **add** (new code), not just flag flips.
- In this TEST environment, FNMT revocation endpoints (`crl-va.integ.cert.fnmt.es`,
  `wrprc.dev.credenciales.fnmt.es`) are not reachable from some networks; with C3 `enforce` that yields
  `REVOCATION_STATUS_UNKNOWN` → block. `observe` is the right mode to see this without blocking.

## Build order (proposed)

1. Core: `TrustLedger` + `TrustGate` + config (BuildConfig/Settings) + overlay skeleton.
2. Wire C1 interception points.
3. Wire C2 interception points.
4. Wire C3 interception points (incl. the two `add` items).
5. deviations.md + build.sh flags + banner/record.
