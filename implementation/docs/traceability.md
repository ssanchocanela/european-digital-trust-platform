# Traceability

Implemented behaviour → ARF high-level requirement → specification section.

**No requirement identifier in this table was invented.** Every `EW-*` and `AS-*` identifier was
read from the machine-readable register `hltr/high-level-requirements.csv` at ARF commit
`c64f2cbb19aee37c571c58af66d359c4d5be29c8` (tag `v3.0.0`); the bracketed name in parentheses is
the ARF's own local `Index` value for the same row. Where an exact identifier could not be
located, the section is cited and an open question is recorded instead.

**No conformance is claimed.** A row in this table means "this behaviour was implemented with
that requirement in view", not "this requirement is satisfied". The `Status` column says which.

## How sources are pinned

The Technical Specifications and the attestation rulebooks are **not in the ARF repository and
are not tagged**, so a version number alone does not identify content (see
[`interop-findings.md`](interop-findings.md) D1, D2). Citations therefore name a document
version *and* a commit:

| Source | Pin |
|---|---|
| ARF | tag `v3.0.0`, commit `c64f2cbb19aee37c571c58af66d359c4d5be29c8` |
| Technical Specifications | `eudi-doc-standards-and-technical-specifications` `main` @ `ee91a294c833af5188726fd8c302c641212192aa` (2026-08-22) |
| TS5 | internal version **1.5**, dated 20.08.2026 |
| PID Rulebook | `eudi-doc-attestation-rulebooks-catalog` @ `36f8adcf914ac06cac18d685add04e0a8a06d685`, document version **1.1** |
| Retrieved | 11 September 2026 |

`Status` values: **IMPLEMENTED** (behaviour present and tested), **PARTIAL** (present with a
stated gap), **NOT DEMONSTRATED** (modelled but not exercised end to end), **OUT OF SCOPE**.

---

## 1. Roles, registration and identifiers

| Behaviour | Requirement | Specification | Status |
|---|---|---|---|
| `RelyingParty.registrarAssignedIdentifier` is recorded, never minted; unique per trust environment | `AS-MS-27-043` (`Reg_32`); ARF §3.11.1 | TS5 v1.5 §2.4.3.1 — EUID is the default scheme | IMPLEMENTED |
| `RelyingPartyService.serviceIdentifier` is RP-chosen and unique within the Relying Party | `AS-MS-27-045` (`Reg_33`); ARF §3.11.2 | TS5 v1.5 §2.4.1 `serviceIdentifier` **[0..1]** — the platform requires it (stricter; ADR 0005 Decision 1d) | IMPLEMENTED |
| `RelyingPartyService.serviceTradeName` is carried into the plan for Wallet display | `AS-MS-27-046` (`Reg_34`), `AS-WP-06-007` (`RPA_06`) | TS5 v1.5 `serviceTradeName` **[1..1]** | IMPLEMENTED |
| An intended use is registered per Service; a policy may not borrow another Service's | `AS-MS-27-016` (`Reg_10d`) | TS5 v1.5 §2.4.1 `intendedUses` | IMPLEMENTED |
| `IntendedUse.intendedUseIdentifier` is Registrar-provided, never minted | ARF §3.11.2 | TS5 v1.5 §2.4.4 `intendedUseIdentifier` **[1..1]** | IMPLEMENTED |
| `Organisation` carries at least one official identifier and the Member State | — | TS5 v1.5 §2.4.3.1, §2.1 `isPSB` | IMPLEMENTED |
| One Relying Party Instance per Service and environment | ARF §3.11.3 | — | IMPLEMENTED |
| Registrar and Access CA interactions are not simulated; V0 is `TEST`-only | `AS-MS-27-012` (`Reg_10`), `AS-MS-27-018` (`Reg_11`) | ETSI TS 119 411-8 | OUT OF SCOPE |

## 2. Registration and access certificates

| Behaviour | Requirement | Specification | Status |
|---|---|---|---|
| One registration-certificate record per (intended use × Service), enforced by a unique index | `EW-DM-44-014` (`RPRC_09`) | ETSI TS 119 475; contents per Annex V of CIR 2025/848 (`EW-DM-44-006`, `RPRC_03`) | IMPLEMENTED (record); **NOT DEMONSTRATED** (no JWT obtainable — blocker B3) |
| The compiler attaches exactly one registration certificate, by value, and reports its absence | `EW-DM-44-023` (`RPRC_19`) | ETSI TS 119 472-2 as amended by Annex 2 of the amended CIR 2024/2982 (`EW-DM-44-025`, `RPRC_20`) | **NOT DEMONSTRATED** — every transaction records `sentWithoutRegistrationCertificate` |
| A certificate issued for another intended use is refused | `EW-DM-44-014` (`RPRC_09`) | — | IMPLEMENTED |
| Requested attributes are within the registered list, checked at policy publication | `EW-DM-44-027` (`RPRC_21`) | TS5 v1.5 §2.4.2 `Claim.path`; OpenID4VP §6.3, §7.1, §7.2 | IMPLEMENTED |
| The access certificate is bound to the Service and its key lives in the engine key store | ARF §3.18; `AS-WP-06-003` (`RPA_02`) | RFC 5280; ETSI TS 119 411-8, TS 119 475 | PARTIAL — imported. `scripts/verify-access-certificate-chain.sh` chain-checks it against the WRPAC LoTE before a wallet test, but the platform does not re-validate the chain at import time (security limitation I2) |
| The certificate's key is held by the Relying Party Instance | ARF §3.11.3 | — | **DIVERGENT for TEST.** The reference RP Registration Service generates the key pair itself and delivers a PKCS#12, so the key was outside the subject's control by construction. Accepted for `TEST` only — [`interop-findings.md`](interop-findings.md) C8, `security-limitations.md` K1a |
| An expired access certificate refuses compilation | `AS-WP-06-004` (`RPA_03`) | — | IMPLEMENTED |
| The Wallet accepts only Access CA anchors from notified LoTEs | `AS-WP-06-005` (`RPA_04`) | ETSI TS 119 602 | **NOT DEMONSTRATED** — the gating chain check is recorded in [`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1. On success Milestone 1 uses an official build; only on failure does it fall back to a self-built wallet with a development CA |

## 3. Presentation

| Behaviour | Requirement | Specification | Status |
|---|---|---|---|
| Remote presentation of an SD-JWT VC over OpenID4VP | `EW-PIO-01-007` (`OIA_03c`) | OpenID4VP profiled by HAIP §5, 5.1, 5.3.2, the "IETF SD-JWT VCs" profile in §6, and §7–8 | PARTIAL — produced by the adapter; not verified against a wallet |
| mdoc remote presentation | `EW-PIO-01-006` (`OIA_03b`) | HAIP §5, 5.1, 5.3.1; "ISO mdocs" profile | PARTIAL — modelled and emitted; untested |
| Relying Party authentication in every transaction, using an access certificate | `AS-WP-06-004` (`RPA_03`) | ETSI TS 119 475, TS 119 411-8 | PARTIAL — the request is signed by the engine; wallet-side acceptance not demonstrated |
| Localised purpose and privacy policy are mandatory, because the Wallet shows them | `AS-WP-06-015` (`RPA_10`) | TS5 v1.5 §2.4.4 `purpose` **[1..*]**, `privacyPolicy` **[1..*]**, Annex E of ETSI TS 119 612 V2.3.1 | IMPLEMENTED |
| `DECLINED_BY_USER` is best-effort and its absence never implies consent | `AS-WP-06-017` (`RPA_11`) | — | IMPLEMENTED, documented as best-effort |
| `SAME_DEVICE` is the tested path and the default | `EW-PIO-01-016` (`OIA_08c`) | — | IMPLEMENTED |
| Four cross-device mitigations implemented for `QR`: lifetime cap, requester-attributable for the whole lifetime, no result via the interaction channel, audited opt-in | `EW-PIO-01-017` (`OIA_08d`) | **ARF main §4.4.3.2** — *not* §4.4.3.1, which `OIA_08d` cites in error; see the note below | **PARTIAL, and `OIA_08d` is NOT claimed.** Two of the five challenges are addressable by a Relying Party, one partly, two not at all. Residual risks are in every cross-device audit record and in `security-limitations.md` P1. [ADR 0009](adr/0009-cross-device-presentation-mitigations.md) |
| W3C Digital Credentials API, which closes challenges 1–4 | `EW-PIO-01-013/014/015` (`OIA_08`, `OIA_08a`, `OIA_08b`), `EW-PIO-01-020` (`OIA_08g`) | HAIP §5.2; ISO/IEC 18013-7 Annex C | OUT OF SCOPE for V0 — planned as the iteration after Milestone 1 (`reference-wallet-testing.md` §9) |
| Proximity presentation | `EW-PIO-01-001` (`OIA_01`) | ISO/IEC 18013-5 | OUT OF SCOPE |

### A cross-reference discrepancy in `OIA_08d`

`EW-PIO-01-017` (`OIA_08d`) requires mitigations "for the challenges described in Section 4.4.3.1 of
the ARF main document". At ARF commit `c64f2cb`, **§4.4.3.1 is "Introduction"** and describes no
challenges; the five challenges are in **§4.4.3.2, "Challenges for remote presentation flows using
custom URIs"**.

Recorded because it changes what the requirement asks for: read literally it points at a section with
nothing to implement. The platform derives its mitigations from §4.4.3.2. Logged as a baseline
inconsistency in [`interop-findings.md`](interop-findings.md) D6.

## 4. Privacy and data handling

| Behaviour | Requirement | Specification | Status |
|---|---|---|---|
| Unique elements and timestamps are discarded as soon as they are no longer needed, and never communicated onward | `AS-RP-01-002` (`OIA_16`) | enumerated by `AS-AP-10-064` (`ISSU_35`) | IMPLEMENTED — content has no table; a test scans every table and every log line |
| The result policy strips unique elements from the customer-facing result | `AS-RP-01-002` (`OIA_16`) | — | IMPLEMENTED |
| The PID `portrait` is not retained | `AS-RP-03-01` (`PID_03a`) | PID Rulebook v1.1 §2.2 | IMPLEMENTED — `portrait` is on the log deny-list and no content is stored |
| Minimisation of requested attributes | — (principle) | TS5 v1.5 §2.4.5 | IMPLEMENTED — validated subset, derived result |
| `age_over_18` is **not** requested, because it is no longer a PID attribute | — | PID Rulebook v1.1 change log: "Age verification attributes removed, following CIR 2024/2977" | IMPLEMENTED — ADR 0005 Decision 5 |
| Age is **not bound to the PID in the domain model**: a policy can target a dedicated age attestation, in either format, with no domain change | — | — | IMPLEMENTED — asserted by `tests/unit/age-not-pid-bound.test.ts`, which fails if any PID type or age attribute name is hard-coded into `packages/domain` |
| ARF 3.0.0 still carries a residual "`age_over_*` … if present" note for attributes the PID Rulebook has removed | — | — | Baseline inconsistency, logged in [`interop-findings.md`](interop-findings.md) D7. The platform follows the Rulebook |
| Presentation response encryption | `EW-PIO-01-021` (`OIA_09`) | — | Engine responsibility; `direct_post.jwt` is used | NOT VERIFIED by the platform |

## 5. Trust and status

| Behaviour | Requirement | Specification | Status |
|---|---|---|---|
| Both Trusted Lists and LoTEs are representable as anchor sources | `EW-PIO-01-029` (`OIA_15b`) | ETSI TS 119 612; ETSI TS 119 602 | IMPLEMENTED (model) — resolution delegated to the engine |
| Trust domains are kept separate and never inferred from one another | `EW-PIO-01-024` (`OIA_12`), `AS-WP-06-005` (`RPA_04`), `EW-DM-44-005` (`RPRC_02a`) | — | IMPLEMENTED (model) |
| Trust-anchor refresh, propagation and removal | `EW-PIO-01-028` (`OIA_15a`) | — | **NOT IMPLEMENTED** — security limitation K3 |
| Revocation checking is fail-closed, with no risk analysis on record to justify skipping it | `AS-AP-07-023` (`VCR_13`) | — | IMPLEMENTED — `statusCheckMode: STRICT` |
| A checking Relying Party supports both status mechanisms | `AS-AP-07-021` (`VCR_12`), `AS-AP-07-019` (`VCR_11`) | Annex 2 of the amended CIR 2024/2979 | **NOT CLAIMED** for mdoc — open question Q4 |
| SD-JWT VC status | `AS-AP-07-020` (`VCR_11a`) | IETF Token Status List | Engine responsibility |
| Trust-list unavailability is reported as a verifier-side failure, not a bad credential | — (engine taxonomy) | — | IMPLEMENTED |

## 6. Operating profile

| Behaviour | Requirement | Specification | Status |
|---|---|---|---|
| V0 operates as a hosted Relying Party Instance using the RP's own certificates | ARF §3.11.3 | — | IMPLEMENTED |
| The Article 5b(10) intermediary profile is not implemented | `AS-RP-52-001` (`RPI_01`) … `AS-RP-52-013` (`RPI_10`) | — | OUT OF SCOPE — legal qualification open (Q2) |
| The Wallet shall not display an intermediary's trade names at approval | `AS-RP-52-008` (`RPI_07`) | — | N/A — recorded in `knowledge-alignment.md` KA-2, which corrects a knowledge-base statement |

## 7. Issuance (Milestone 2 — recorded now so the constraints are not rediscovered)

| Behaviour | Requirement | Status |
|---|---|---|
| An Attestation Provider includes its registration certificate in Credential Issuer metadata, by value | `AS-AP-44-004` (`RPRC_22`) | NOT STARTED |
| A Wallet Unit **shall not request issuance** when that certificate is absent, invalid, mismatched, or does not cover the attestation type | `AS-AP-44-005` (`RPRC_22a`), `AS-AP-44-006` (`RPRC_22b`), `AS-AP-44-007` (`RPRC_23`) | NOT STARTED — blocker B4; stricter than the presentation path |
| A revocation shall not be reversed | `AS-AP-07-007` (`VCR_04`) | NOT STARTED — the engine permits it, so the platform must refuse it (`interop-findings.md` B1) |
| An Attestation Provider that also requests attestations registers both entitlements in one service registration | — | TS5 v1.5 §2.4.1 `entitlements` | NOT STARTED |

---

## What this table does not say

- It does not say the platform conforms to ARF 3.0.0 or to any Technical Specification.
- It does not say V0 is production-ready.
- Rows marked PARTIAL or NOT DEMONSTRATED are the honest status. The single largest gap is that
  **no wallet interaction of any kind has been attempted**. The gating step is the
  access-certificate chain check recorded in [`reference-wallet-testing.md`](reference-wallet-testing.md)
  §8.1: on success Milestone 1 can use an official build, and only on failure does it fall back to
  a self-built wallet — which would then be labelled a modified wallet everywhere.
- `EW-PIO-01-017` (`OIA_08d`) is the one requirement this table deliberately marks PARTIAL while
  having implemented something: four mitigations exist, two of the five challenges remain
  unaddressable by a Relying Party, and the obligation is therefore not claimed as met.
