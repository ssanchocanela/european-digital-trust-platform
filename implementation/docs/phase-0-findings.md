# Phase 0 — Investigation and decisions

**Investigation date:** 11 September 2026
**Branch:** `implementation/platform-v0`
**Scope:** investigation only. No product code was written in this phase.

This document records what was verified, against which pinned sources, and what is still
unresolved. Every conformance statement cites a concrete ARF section, high-level requirement
(HLR) identifier or specification section at a stated version. Where an identifier could not be
located, the section is cited and an open question is recorded instead.

---

## 1. Pinned sources

All findings below were taken from these exact revisions.

| Source | Pinned revision | Notes |
|---|---|---|
| ARF | tag `v3.0.0`, commit `c64f2cbb19aee37c571c58af66d359c4d5be29c8`, released 2026-07-23 | `eu-digital-identity-wallet/eudi-doc-architecture-and-reference-framework` |
| ARF HLR register | `hltr/high-level-requirements.csv` at the above commit, 725 requirements | Machine-readable; the authority for HLR identifiers used here |
| Technical Specifications TS1–TS14 | `eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications`, `main` at commit `ee91a294c833af5188726fd8c302c641212192aa` (2026-08-22) | **No tags, no releases exist in this repository** — see Finding 1.1 |
| TS5 | version `1.5`, dated 20.08.2026 (from the document's own version table) | Common formats and API for RP registration information |
| PID Rulebook | `eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog`, `main` at commit `36f8adcf914ac06cac18d685add04e0a8a06d685`; document version `1.1`, dated 4 Sep 2025 | **No tags, no releases exist in this repository** |
| EUDIPLO | release `v7.6.0`, published 2026-09-08, git commit `3b2a9e7163059db13019bdd1862240cbecb86201`, Apache-2.0 | `openwallet-foundation/eudiplo` |
| EUDIPLO backend image | `ghcr.io/openwallet-foundation/eudiplo:7.6.0` @ `sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667` | Identical digest to `:latest` on 11 Sep 2026 |
| EUDIPLO client image | `ghcr.io/openwallet-foundation/eudiplo-client:7.6.0` @ `sha256:c264d0eb5a1b7a046f119b86ac271c75c15f97d9f027acb92b47057a2bdaf49a` | Admin web UI; not required by the platform |
| Reference Wallet (Android) | `eudi-app-android-wallet-ui`, release `Wallet/Demo_Version=2026.09.42-Demo_Build=42`, 2026-09-10 | Target for V0 |
| Reference Wallet (iOS) | `eudi-app-ios-wallet-ui`, release `Wallet/Demo_2026.09.42-Demo_Build=42`, 2026-09-10 | Not targeted in V0 |
| Wallet Core SDK | `eudi-lib-android-wallet-core` `v0.30.2`, 2026-08-26 | Source of the wallet's OpenID4VP client-id-scheme support |

The prompt stated EUDIPLO `v7.2.0` (2026-08-19) as the latest release. That is no longer current:
**`v7.6.0` is current**, and four further releases (`v7.3.0`, `v7.4.0`, `v7.5.0`, `v7.6.0`) landed
between 26 Aug and 8 Sep 2026. `v7.5.0` and `v7.6.0` carry changes that are directly material to
this platform (see §4.6 and §4.9), so pinning `v7.2.0` would have been the wrong choice.

### 1.1 The baseline is more fragmented than the prompt assumes

The prompt's §1.1 order of precedence assumes "TS1–TS12 published with ARF 3.0.0" are pinnable
artefacts at "the versions the TS reference". They are not, in three ways:

1. **The TS documents are not in the ARF repository.** The ARF 3.0.0 files
   `docs/technical-specifications/ts*.md` are four-line stubs that link to a separate repository.
   So the ARF 3.0.0 tag does **not** freeze any TS content.
2. **The TS repository has no tags and no releases.** TS content is a moving target on `main`.
   The only way to pin it is a commit SHA, which is what §1 above does. Individual TS documents
   carry their own internal version tables (TS5 is at `1.5`, 20.08.2026), and those version
   numbers are the citable unit — not an ARF version.
3. **The PID Rulebook has also moved out of the ARF** into
   `eudi-doc-attestation-rulebooks-catalog`, likewise untagged. ARF 3.0.0 Annex 3.01 is now a stub.

There are **14** TS documents, not TS1–TS12. TS13 and TS14 exist and are zero-knowledge-proof
work (`ts13-zksnarks`, `ts14-zkps-from-mms`), alongside TS4. The prompt's instruction to treat
TS4/TS13/TS14 as exploratory therefore holds and covers all three.

**Consequence for the platform:** `implementation/docs/traceability.md` must cite
*(HLR identifier | TS document + internal version | commit SHA)* triples, not "ARF 3.0.0 / TSn".
Recorded as ADR-relevant in [ADR 0002](adr/0002-eudiplo-as-wrapped-engine.md) and as an open
question in §7.

### 1.2 Which document actually defines what

The prompt's §3.2 asks which TS defines the presentation protocol profile, the issuance protocol
profile, credential formats, trust anchor distribution and status/revocation. **None of TS1–TS14
does.** ARF 3.0.0 delegates all five to external standards, and the HLR register names them
explicitly:

| Concern | Normative source | Citation |
|---|---|---|
| Remote presentation profile (SD-JWT VC) | `[OpenID4VP]` profiled by `[HAIP]` §5, 5.1, 5.3.2, the "IETF SD-JWT VCs" profile in §6, and §7–8 | `EW-PIO-01-007` (`OIA_03c`) |
| Remote presentation profile (mdoc) | `[OpenID4VP]` profiled by `[HAIP]` §5, 5.1, 5.3.1, the "ISO mdocs" profile in §6, and §7–8 | `EW-PIO-01-006` (`OIA_03b`) |
| Remote presentation via DC API | `[HAIP]` §5, 5.2, 5.3.1/5.3.2; or `[ISO/IEC 18013-7]` Annex C | `EW-PIO-01-013/014/015` (`OIA_08`, `OIA_08a`, `OIA_08b`) |
| Issuance protocol profile | `[OpenID4VCI]` profiled by `[HAIP]` §4 and §6, plus ARF Annex 2 Topics 10 and 9, plus **TS3** | `EW-PIO-10-001` (`ISSU_01`), `AS-AP-10-001` (`ISSU_01a`) |
| Credential formats | `[ISO/IEC 18013-5]` and `[SD-JWT VC]`, with additions in ARF Annex 2 and **ETSI TS 119 472-1** | `AS-AP-10-002` (`ISSU_02`) |
| Trust anchor distribution | **ETSI TS 119 612** (Trusted Lists) **and ETSI TS 119 602** (LoTEs) — RPs SHALL support both | `EW-PIO-01-029` (`OIA_15b`) |
| Status/revocation, SD-JWT VC | `[Token Status List]` (IETF) | `AS-AP-07-020` (`VCR_11a`) |
| Status/revocation, mdoc | Annex 2 of the amended **CIR 2024/2979** (Attestation Status List *or* Attestation Revocation List) | `AS-AP-07-019` (`VCR_11`) |
| RP registration information format and API | **TS5** (v1.5) and **TS6** | `AS-MS-27-005` (`Reg_03`), `AS-MS-27-045` (`Reg_33`) |
| Registration certificate format | **ETSI TS 119 475**; contents at least per Annex V of CIR 2025/848 | `EW-DM-44-001` (`RPRC_01`), `EW-DM-44-006` (`RPRC_03`) |
| Access certificate format | RFC 5280, **ETSI TS 119 411-8**, **ETSI TS 119 475** | ARF §3.18; `AS-MS-27-018` (`Reg_11`), `AS-WP-06-003` (`RPA_02`) |
| Transferring the registration certificate in the request | **ETSI TS 119 472-2**, as amended by Annex 2 of the amended CIR 2024/2982 | `EW-DM-44-025` (`RPRC_20`) |
| Registration certificate in issuer metadata | **ETSI TS 119 472-3** extension to OpenID4VCI | `AS-AP-44-004` (`RPRC_22`) |

Newer implementing acts appear in the baseline that the prompt's §1.1 list does not mention:
**CIR (EU) 2026/1730** (TS5 v1.5 aligns to it; adds `servedWRPServices`) and **CIR (EU) 2026/1731**
(amending CIR 2024/2982; already referenced by
[`06-shared-capabilities/rp-registration-and-access.md`](../../06-shared-capabilities/rp-registration-and-access.md)).

---

## 2. Repository reading — §3.1

### 2.1 Files that do not exist

Six of the ten paths the prompt told me to read are **absent** from this repository:

| Required path | Status |
|---|---|
| `05-eudi-services/verification-as-a-service.md` | present (49 lines) |
| `05-eudi-services/verification-operating-models.md` | **MISSING** |
| `05-eudi-services/presentation-policy.md` | **MISSING** |
| `05-eudi-services/verifier-product-model.md` | **MISSING** |
| `05-eudi-services/eudiplo-assessment.md` | present (59 lines) |
| `06-shared-capabilities/rp-registration-and-access.md` | present (63 lines) |
| `06-shared-capabilities/presentation-privacy-and-retention.md` | **MISSING** |
| `08-architecture/verification-service-architecture.md` | **MISSING** |
| `09-product-roadmap/verification-mvp.md` | **MISSING** |

The knowledge base is **asymmetric**: the issuance side is documented in depth while the
verification side is not. Issuance pages read in full and used below:
`05-eudi-services/issuance-as-a-service.md`, `issuer-product-model.md`, `issuer-onboarding.md`,
`attestation-provider-operating-models.md`, `pubeaa-managed-service.md`, `qeaa-qtsp-model.md`,
`08-architecture/issuance-service-architecture.md`, `attestation-provider-architecture.md`,
`09-product-roadmap/issuance-mvp.md`,
`06-shared-capabilities/issuer-trust-and-registration.md`.

This matters because Milestone 1 is the **verification** milestone. The platform-side concepts
the prompt's §5–§6 introduce — `PresentationPolicy`, `PresentationPolicyVersion`,
`VerificationPlan`, the result policy, the transaction state machine — have **no existing
knowledge page to align with**. Per the prompt's §1.3 I must not invent those pages or
restructure the knowledge base; I have instead recorded in
[`knowledge-alignment.md`](knowledge-alignment.md) that the verification-side pages are missing
and proposed their creation as a separate, reviewable change.

### 2.2 Existing decisions the implementation inherits

- `eudiplo-assessment.md` (7 Sep 2026) already decided **`WRAP`**, not adopt, and set six adoption
  gates. Phase 0 confirms that decision on the pinned release. Note that the assessment's
  inspected commit `1885065b547…` is in fact the OID4VCI-caching commit that shipped in
  **v7.6.0** — the assessment was made against pre-release `main`, one day before v7.6.0 was cut.
- `reuse-strategy.md` classifies EUDIPLO's trust modules as `EXTEND` and requires validation of
  "ARF 3.0/technical-spec versions and authoritative trust sources". §5 below is that validation,
  and it found a material gap.
- `api-concepts.md` already states "Tenant identity comes from authenticated context, never a
  caller-controlled body field". The prompt's §6.7 API shape puts `{tenantId}` in the path. These
  are reconcilable only if the path value is validated against the authenticated tenant and never
  trusted — which the prompt also says. Recorded in `knowledge-alignment.md`.
- `09-product-roadmap/gaps.md` already lists "RP hosting versus intermediary", "RPAC/RPRC
  delegated key management" and "Implementing-act transition" as phase 1–2 gaps. Phase 0 does not
  close them; it sharpens them (§6).

---

## 3. Baseline map — §3.2

Verified against the ARF HLR register at the pinned commit. These are the requirements the V0
design rests on.

### 3.1 Roles and identifiers (ARF §3.11, §3.17–3.19)

ARF §3.11.1: the Registrar assigns **an EU-wide unique Relying Party identifier**.
ARF §3.11.2: the **Relying Party Service identifier can be freely chosen by the Relying Party**,
as long as it is unique for that Relying Party; **intended-use identifiers are generated by the
Registrar**, not chosen by the RP. ARF §3.11.3: a Relying Party Instance is software and hardware
interacting with Wallet Units and may hold **multiple access certificates** if it serves multiple
Services.

ARF §3.18: an access certificate is an RFC 5280 public-key certificate complying with
**ETSI TS 119 411-8**; Access CA trust anchors are placed on a **LoTE published by the
Commission**. ARF §3.19: a registration certificate is a **JWT per RFC 7519, not an X.509
certificate**; both certificate types carry the entity's unique identifier and Service identifier
so the Wallet can verify they belong to the same entity.

This confirms the prompt's §5 table. Supporting HLRs:

| Requirement | Identifier | Substance |
|---|---|---|
| One or more access certificates per registered Service | `AS-MS-27-013` (`Reg_10a`) | "SHALL receive at least one access certificate for each registered Service" |
| RP registers which intended uses apply to which Service | `AS-MS-27-016` (`Reg_10d`) | Confirms `IntendedUse` ↔ `RelyingPartyService` cardinality |
| Access cert carries entity trade name | `AS-MS-27-042` (`Reg_31`) | Identical to the registered name and to the name in the registration certificate |
| Access cert carries EU-wide unique entity identifier | `AS-MS-27-043` (`Reg_32`) | Identical to TS6-registered identifier and to `RPRC_07` |
| Access cert carries RP Service identifier | `AS-MS-27-045` (`Reg_33`) | **Provided by the registering entity**, unique within that entity |
| Access cert carries RP Service trade name | `AS-MS-27-046` (`Reg_34`) | Suitable for presenting to a User |
| Access CA issuance process complies with ETSI TS 119 411-8 | `AS-MS-27-018` (`Reg_11`) | CA must have a governing policy |

### 3.2 Registration certificates (ARF Topic 44)

| Requirement | Identifier | Substance |
|---|---|---|
| **One registration certificate per (intended use × Service)** | `EW-DM-44-014` (`RPRC_09`) | "a separate registration certificate for each combination of intended use and Relying Party Service, as registered by the Relying Party per `Reg_10d`", issued automatically and without undue delay |
| **Exactly one RPRC per presentation request, by value** | `EW-DM-44-023` (`RPRC_19`) | "a single registration certificate applicable for its current Service and intended use in each presentation request… included in the request by value, not by reference", in both proximity and remote flows |
| Transfer mechanism | `EW-DM-44-025` (`RPRC_20`) | ETSI TS 119 472-2 extension for OpenID4VP or ISO/IEC 18013-5, as amended by Annex 2 of the amended CIR 2024/2982 |
| RPRC and access cert must agree on identifiers | `EW-DM-44-012` (`RPRC_07a`), `EW-DM-44-020` (`RPRC_17a`) | Same unique RP identifier **and** same Service identifier; mismatch ⇒ Wallet warns the User |
| **Wallet checks requested attributes ⊆ registered attributes** | `EW-DM-44-027` (`RPRC_21`) | On a negative outcome the Wallet warns that the RP "is requesting more information than it has registered"; the Wallet Provider's policy decides whether to allow, allow-registered-only, or reject |
| RPRC distribution to Instances | `EW-DM-44-015` (`RPRC_10`) | The RPRC sent to an Instance must carry the same Service identifier as that Instance's access certificate |
| RPRC must carry deletion-request contact and DPA contact | `EW-DM-44-016` (`RPRC_11`), `EW-DM-44-017` (`RPRC_12`) | At least one of URL / e-mail / phone for each |
| RPRC contents floor | `EW-DM-44-006` (`RPRC_03`) | At least Annex V of CIR 2025/848 |

`RPRC_09` and `RPRC_19` together **validate the prompt's §5 `RegistrationCertificate` model
exactly** ("the JWT registration certificate for exactly one intended use of one Service"), and
`RPRC_21` **validates the prompt's §6.1 validation rule** — the platform's pre-check is not
redundant bureaucracy, it prevents a user-visible over-asking warning in the Wallet.

### 3.3 Relying Party authentication (ARF Topic 6)

| Requirement | Identifier | Substance |
|---|---|---|
| RP authentication mandatory in **every** presentation transaction | `AS-WP-06-004` (`RPA_03`) | Proximity and remote, using an access certificate |
| Mechanism must also prevent request replay | `AS-WP-06-001` (`RPA_01`) | Identify + authenticate + detect copy/replay |
| Access certificates per ETSI TS 119 475 and TS 119 411-8 | `AS-WP-06-003` (`RPA_02`) | Both Wallet Units and RP Instances |
| **Wallet accepts only Access CA trust anchors from notified LoTEs** | `AS-WP-06-005` (`RPA_04`) | "SHALL accept only the trust anchors in the LoTE(s) of all Access Certificate Authorities notified by Member States" |
| Failure ⇒ user told the request is not trustworthy | `AS-WP-06-006` (`RPA_05`), `AS-WP-06-008` (`RPA_06a`) | Wallet either refuses or offers an explicit choice |
| On success the Wallet displays RP and Service trade names from the access certificate | `AS-WP-06-007` (`RPA_06`) | Shown together with the requested attributes |
| Wallet shows the intended use description and privacy policy link | `AS-WP-06-015` (`RPA_10`) | Drives the need for localised purpose text — see §3.6 |
| Denial is indistinguishable from absence | `AS-WP-06-017` (`RPA_11`) | "behave towards the Relying Party as if the attestation or PID did not exist" |

`RPA_04` is the hard constraint behind the V0 blocker in §5.

`AS-WP-06-017` (`RPA_11`) has a direct consequence for the prompt's §6.5 outcome set: when the
user denies, the Wallet is required to behave as if the credential were absent. A
`DECLINED_BY_USER` outcome is therefore **not reliably distinguishable** from "the user does not
hold the credential". The platform must not present `DECLINED_BY_USER` as evidence of refusal;
it can only report what the protocol surfaced (an OpenID4VP `access_denied` error, when one
arrives). Recorded as a design constraint for M1.

### 3.4 Ephemeral processing — the citable basis for §8.1

| Requirement | Identifier | Substance |
|---|---|---|
| **RP Instance SHALL discard unique elements and timestamps** | `AS-RP-01-002` (`OIA_16`) | "discard the values of all unique elements, including at least the ones mentioned in `ISSU_35`… as well as any timestamps, as soon as they are no longer needed. The Relying Party Instance SHALL NOT communicate these values to the Relying Party or to any other party" |
| What counts as a unique element | `AS-AP-10-064` (`ISSU_35`) | Per-attribute salts, attribute hash values, the revocation index/identifier, the device-binding public key, and the Attestation Provider signature value |
| Response encryption mandatory | `EW-PIO-01-021` (`OIA_09`) | Attributes accessible only to the RP Instance |
| Portrait retention restricted | `AS-RP-03-01` (`PID_03a`) | Shall not be retained absent a specific legal basis; no third-country transfer unless permitted |
| Revocation checking recommended, with a risk analysis if skipped | `AS-AP-07-023` (`VCR_13`) | `SHOULD` verify; deviation requires documented risk analysis |
| An RP that checks revocation must support **both** mechanisms | `AS-AP-07-021` (`VCR_12`) | Status List **and** Revocation List per `VCR_11` |

`OIA_16` is stronger than the prompt's §8.1 and is the reason the prompt's rule is not merely a
privacy preference: it is a normative obligation on the Relying Party **Instance**, which in the
V0 hosted profile is the platform. It forbids passing salts, hashes, the device-binding public
key and the provider signature **up to the Relying Party itself**. The platform's result policy
must therefore strip these even from the customer-facing result, not only from storage.

### 3.5 The intermediary profile (ARF Topic 52) — and a correction

| Requirement | Identifier | Substance |
|---|---|---|
| Intermediary registers as an RP, declaring intermediary intent | `AS-RP-52-001` (`RPI_01`) | Per all of Topic 27 |
| Intermediated RP must be registered in its own Member State, and the intermediary must hold its RPRCs | `AS-RP-52-003` (`RPI_03`) | Each RPRC shows that the RP uses the intermediary's services |
| Registrar needs legally valid evidence of the relationship | `AS-RP-52-004` (`RPI_04`) | Before registering it |
| The intermediated RP names which single RPRC to use | `AS-RP-52-005` (`RPI_05`) | Per request |
| **The intermediary sends its own access certificate plus the RP's registration certificate** | `AS-RP-52-006` (`RPI_06`) | Exactly as the prompt's §5.1 describes |
| **The Wallet SHALL NOT display the intermediary's trade names** | `AS-RP-52-008` (`RPI_07`) | When asking for User approval per `RPA_07` |
| Forward only to the intermediated RP; delete immediately | `AS-RP-52-011` (`RPI_08`), `AS-RP-52-013` (`RPI_10`) | "completely and immediately" after forwarding, or after failed verification |

`RPI_07` **contradicts** a statement in the existing knowledge base.
[`06-shared-capabilities/rp-registration-and-access.md`](../../06-shared-capabilities/rp-registration-and-access.md)
says "ARF 3.11.4 requires the intermediary relationship to be registered and the Wallet to
identify both the intermediary and intermediated RP" and that the Wallet "must not misleadingly
show only the public body when the platform is a separate intermediary". At ARF 3.0.0 the
requirement is the opposite for the approval screen: the Wallet **shall not** display the
intermediary. Recorded in [`knowledge-alignment.md`](knowledge-alignment.md); I have not edited
that page.

The prompt's §5.1 claim that an intermediary uses "a separate set per intermediated Relying
Party" of access certificates is **not supported** by `RPI_06`, which refers to "the applicable
intermediary's access certificate". The per-RP separation may follow from `Reg_10a` plus TS5
`serviceIdentifier` registration, but I could not locate a requirement stating it. Open question
Q7.

### 3.6 TS5 v1.5 — the registration data model, and four corrections to §5–§6.1

TS5 v1.5 defines the data model the Registrar holds. It maps onto the prompt's §5 closely, with
four differences the implementation must absorb.

| Platform object (prompt §5) | TS5 v1.5 class / attribute |
|---|---|
| `Organisation` | `WalletRelyingParty` ← `Provider` ← `LegalEntity`; plus `isPSB` [1..1], `supervisoryAuthority` [1..1] |
| `RelyingParty` | `WalletRelyingParty`, plus `registryURI` [1..1] — **provided by the national Registrar on registration** |
| `RelyingPartyService` | `WalletRelyingPartyService`: `serviceTradeName` [1..1], `serviceIdentifier` **[0..1]**, `srvDescription` [1..*], `entitlements` [0..*], `isIntermediary` [1..1] |
| `IntendedUse` | `IntendedUse`: `intendedUseIdentifier` [1..1] **Registrar-provided**, `purpose` [1..*], `privacyPolicy` [1..*], `createdAt` [1..1], `revokedAt` [0..1], `credentials` [1..*] |
| `requestedClaims[]` | `Credential.claims` [1..*] of `Claim`, where `Claim.path` [1..1] is an **OpenID4VP claims path pointer** (array of strings, nulls and non-negative integers) per OpenID4VP §6.3 and §7.1/7.2 |
| credential requirement | `Credential`: `format` [1..1], `meta` [1..1] (`vct_values` for SD-JWT VC, `doctype` for mdoc), `claims` [1..*] |

**Correction 1 — `purpose` is multilingual and mandatory-multilingual.** TS5 `IntendedUse.purpose`
is `[1..*]` of `MultiLangString`, and the purpose "SHALL be possible to be displayed localised to
the User's language" with localisations "provided for all official languages of Member States
where the intended use is provided", per Annex E of ETSI TS 119 612 V2.3.1. The prompt's
`PresentationPolicyVersion.purpose` is a scalar field. It must be a localised collection, because
`AS-WP-06-015` (`RPA_10`) makes the Wallet display it. This also matches EUDIPLO, whose
`registrationCert.body.purpose` is already an array of `{lang, value}`.

**Correction 2 — `privacyPolicy` is part of the intended use, not optional plumbing.** TS5 makes
it `[1..*]` on `IntendedUse`, and `RPA_10` makes the Wallet show the link. The platform's
`IntendedUse` must carry it; EUDIPLO requires it too, as `registrationCertificateDefaults.privacy_policy`.

**Correction 3 — `requestedClaims` are claim *paths*, not attribute names.** The §6.1 subset
check must be a path-subset check over OpenID4VP claims path pointers, which are nested
(`["address","street_address"]`) and may contain array indices and nulls. A flat string compare
would silently accept `address.street_address` when only `address` was registered, or reject a
correctly nested path. This is the single most error-prone detail in §6.1.

**Correction 4 — `serviceIdentifier` is optional in TS5.** It is `[0..1]`, and may be omitted when
the RP has one service, needs no service-bound access certificates, and uses no intermediary —
but it **SHALL** be registered if the RP relies on an intermediary. The platform should require it
unconditionally (its model is multi-service from the start); that is a deliberate
stricter-than-TS5 choice to record, not a conformance claim.

Also relevant to Milestone 2: TS5 `entitlements` are URIs such as
`https://uri.etsi.org/19475/Entitlement/Service_Provider` and
`…/Entitlement/Non_Q_EAA_Provider`, and TS5 states that "an attestation provider that requires
presentation of another attestation during issuance of their own attestation SHALL register both
as a `Service_Provider` and with their attestation provider entitlement in a **single service
registration**". That is precisely the prompt's §7.3 stretch goal (eligibility by presenting a PID
during issuance), and TS5 tells us how it must be registered.

---

## 4. EUDIPLO capability map — §3.3, verified at v7.6.0

Everything in this section was read from the source or the shipped documentation at commit
`3b2a9e7163059db13019bdd1862240cbecb86201`. Route paths were extracted from the NestJS
controllers, not from prose.

### 4.1 Authentication

OAuth 2.0 **client credentials** only, at `POST /api/oauth2/token` (credentials via HTTP Basic or
in the JSON body). Metadata at `GET /.well-known/oauth-authorization-server`, keys at
`GET /.well-known/jwks.json`. Either an integrated OAuth2 server (`MASTER_SECRET`,
`AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` — all required, no defaults) or an external OIDC provider
(`OIDC=…`), in which case EUDIPLO stops issuing tokens itself.

Roles are a fixed enum: `tenant:manage`, `tenant:read`, `tenant:admin`, `issuance:offer`,
`issuance:config`, `presentation:request`, `presentation:config`, `key:manage`, `key:read`,
`registrar:manage`, `metrics:read`. A client may hold several roles but maps to **at most one
tenant**; a `tenant:manage` client must not be bound to any tenant. Client secrets are bcrypt-hashed
and unreadable after creation (`POST /client/:id/rotate-secret` to replace).

Beyond roles there is resource-level scoping: `allowedPresentationConfigs` and
`allowedIssuanceConfigs` on a client restrict which configurations it may use, enforced with
`403`. This is directly useful: the platform's per-tenant EUDIPLO client can be confined to that
tenant's configurations as defence in depth.

### 4.2 Tenant model and the mapping decision

EUDIPLO tenancy is a single `tenantId` column on every entity — "row-based", with per-tenant keys,
sessions and configurations. The documentation is explicit that stronger isolation (per-tenant
databases, row-level security) is future work. Administration is via `/tenant`, `/client`, `/user`.

**Mapping decision.** The EUDIPLO tenant is the natural home for key material, access
certificates and registrar configuration, and those are scoped in ARF terms to a **Relying Party
Service**, not to a commercial customer:

- an access certificate carries one RP identifier **and** one Service identifier (`Reg_32`, `Reg_33`);
- a registration certificate must carry the same Service identifier as the Instance's access
  certificate (`RPRC_10`);
- EUDIPLO's registrar configuration is per tenant and derives `rpId` automatically from "the
  tenant's registrar relying party" — it cannot be set per request.

Therefore **one EUDIPLO tenant per platform `RelyingPartyInstance`** (i.e. per Relying Party
Service and `trustEnvironment`), **not** one per platform `Tenant`. A platform `Tenant` with two
Organisations, each with two Services, needs four EUDIPLO tenants. Decided in
[ADR 0002](adr/0002-eudiplo-as-wrapped-engine.md).

### 4.3 Presentation configuration and request

`POST /verifier/config` stores a presentation configuration; `GET`/`PATCH`/`DELETE /verifier/config/:id`
manage it; `POST /verifier/config/:id/registration-cert/reissue` re-mints its RPRC. Fields:

- `id`, `description` (both required);
- `dcql_query` (required) — raw DCQL, including `trusted_authorities`;
- `registrationCert` — one of `jwt` (use verbatim), `id` (look up at the registrar, falling back
  to creating from `body`), or `body` (create at the registrar); at least one required if present;
- `webhook`, `redirectUri` (supports a `{sessionId}` placeholder), `transaction_data`,
  `skewSeconds` (default 60), `accessKeyChainId`;
- `statusCheckMode`: `strict` (default, fail-closed), `best_effort`, `disabled`;
- `readerAuth` (ISO 18013-7 DC API only).

`POST /verifier/offer` creates a request: `{response_type: "uri" | "dc-api" | "iso-18013-7",
requestId, webhook?, redirectUri?, transaction_data?, skewSeconds?, expected_origin?}`. Request-time
values **replace** rather than merge with configuration values.

Response is `OfferResponse = {uri, crossDeviceUri?, session}`. For `response_type: "uri"` both URIs
are prefixed `openid4vp://?…`. This is the opaque interaction URI the prompt's §6.6 requires the
adapter to pass through unchanged — and note there are **two**: `uri` and `crossDeviceUri` (the
latter omits the post-completion redirect). The platform's `interaction` object must choose
deliberately between them; see §6.2 on whether a cross-device QR flow should be offered at all.

**Client-id scheme.** EUDIPLO signs the request object and sets `client_id: "x509_hash:" + certHash`,
selecting the Access key chain via `presentationConfig.accessKeyChainId`. The request object is
retrieved by the wallet from `/presentations/:sessionId/oid4vp/request`. Response mode is
`direct_post.jwt` with the full OpenID4VP §13.3 identifier separation (`session.id` internal,
`walletNonce` wallet-facing, `nonce`, one-time `response_code`).

**EUDIPLO already enforces over-asking prevention.** Every registration certificate is validated
before use: `exp`/`nbf` with 60 s skew, and **every credential in the DCQL query must appear in
the certificate's authorized `credentials` claim**, else the request is rejected. When
`registrationCert.body.credentials` is not set it is auto-derived from `dcql_query.credentials`,
forwarding only `format`, `claims` and `meta` and stripping `id`, `multiple` and
`trusted_authorities`. This is a second, independent layer beneath the platform's §6.1 check —
they are complementary, and the platform's check is the one that can return a clean `422` to the
customer at policy-publication time rather than at request time.

### 4.4 Issuance configuration (Milestone 2)

- `POST /issuer/credentials` (+ `GET`/`PATCH`/`DELETE`, `…/:id`) — credential configurations:
  `config.format` (`dc+sd-jwt` / `mso_mdoc`), claims, display, and a `status` block
  (`enabled`, `bits` ∈ {1,2,4,8}, `credentialConfigurationBound`).
- `GET`/`POST /issuer/config`, `POST /issuer/config/registration-cert/reissue` — issuance
  configuration including `authorizationServers`.
- `POST /issuer/offer` — creates an offer:
  `{response_type, flow: "pre_authorized_code" | "authorization_code", credentialConfigurationIds[],
  tx_code?, tx_code_description?, authorization_server?, credentialClaims?, webhookEndpointId?}`,
  returning the same `OfferResponse` shape.
- `credentialClaims` per credential is one of three sources: `{type:"inline", claims}`,
  `{type:"attributeProvider", attributeProviderId}`, `{type:"webhook", webhook}`.
- `POST /issuer/attribute-providers` — the attribute-provider extension point.
- `POST /issuer/deferred/:transactionId/complete|fail` — deferred issuance.
- Authorization modes: built-in AS, external AS, and a **chained AS** facade
  (`/issuers/:tenantId/chained-as/*`) that delegates to an upstream OIDC provider while issuing
  EUDIPLO's own tokens carrying `issuer_state`. A `chained-as-vp` variant exists
  (`/issuers/:tenantId/chained-as-vp/par|authorize|vp-callback|token`) plus
  `GET /issuers/:tenantId/authorization-servers/:id/vp-callback`.

**"Presentation during issuance" is supported** — the `chained-as-vp` routes and
`POST /issuers/:tenantId/authorize/interactive` (the Interactive Authorization Endpoint) are the
mechanism. That makes the prompt's §7.3 stretch goal technically reachable. Two caveats: the RI
wallet's feature matrix lists IAE as `n/a` (untested), and TS5 requires the dual-entitlement
registration described in §3.6. Treat as a stretch goal, confirmed feasible in the engine,
unproven with the wallet.

Offers are **single-use and non-replayable**: code replay gives `invalid_grant`, a resolved
`credential_offer_uri` returns `404` on a second fetch, and `consumedAt` records first use.

### 4.5 Status lists and revocation (Milestone 2) — one important shape

Implemented with `@owf/token-status-list` ^0.3.2. Admin routes: `GET/PUT/DELETE /status-list-config`,
`GET/POST /status-lists`, `GET/PATCH/DELETE /status-lists/:listId`. Public routes:
`GET /issuers/:tenantId/status-management/status-list/:listId` and `…/status-list-aggregation`.
Lists are allocated automatically, shared by default or bound to a credential configuration, and
a new shared list is created when one fills.

**Revocation is keyed by EUDIPLO session, not by list index.** The only exposed mutation is
`POST /session/revoke` with `{sessionId, credentialConfigurationId?, status: 0 | 1 | 2}`
(0 = valid, 1 = revoked, 2 = suspended). The `PATCH /{tenant}/status-management/status-list/{listId}/entry/{index}`
route shown in the documentation **does not exist** in the code.

This looks like it would collide with session cleanup, but it does not: `StatusMapping` is a
separate table keyed by `(tenantId, sessionId, statusListId, index, credentialConfigurationId)`
whose only foreign keys are to the tenant and the status list — **not** to the session. Mappings
therefore survive session deletion, and `POST /session/revoke` keeps working after the session
itself has been purged. The adapter consequence is concrete: `IssuedCredentialRecord` must retain
the EUDIPLO `sessionId` (and ideally the status list URI and index) as internal correlation
metadata, or revocation becomes impossible. This is metadata, not content, so it is consistent
with §8.1.

Two normative constraints the platform must impose on top:

- `AS-AP-07-007` (`VCR_04`): a revocation **SHALL NOT be reversed**. EUDIPLO will happily accept
  `status: 0` after `status: 1`. The platform must reject un-revocation while permitting
  reinstatement from *suspended*.
- `AS-AP-07-021` (`VCR_12`) / `AS-AP-07-019` (`VCR_11`): mdoc revocation must use the mechanism in
  Annex 2 of the amended CIR 2024/2979. Whether EUDIPLO's CWT status-list encoding satisfies that
  Annex is **not established** — see Q4. For SD-JWT VC, `VCR_11a` points at
  `[Token Status List]`, which is what EUDIPLO implements. V0 issuance is SD-JWT VC, so this is
  not on the M2 critical path, but it is not a conformance claim for mdoc either.

### 4.6 Session results, and the error taxonomy that maps onto §6.5

Session states: `active`, `fetched`, `completed`, `expired`, `failed`.
Retrieval: `GET /session/:id` (returns `verifiedClaims`), `GET /session` (paginated),
`GET /session/:id/events` (SSE, JWT in a query parameter), `GET /session/:id/logs`,
`DELETE /session/:id`. For same-device redirect flows the `response_code` from the redirect is the
only safe lookup key.

v7.5.0 added a **structured verification outcome** persisted on the session (`SessionOutcome`)
and a shared failure taxonomy, which is the single most useful thing for the prompt's §6.5:

```
SessionOutcome { result: "success" | "failed", error?, message?, credentials?: [
  { id?, format?, docType?, verified, error?, message?, trust?: {matchedIssuer,
    issuanceThumbprint, matchMode, revocationThumbprint}, warnings?: [{code,message}] } ] }
```

Failure codes, stable and format-agnostic (same codes for mdoc and SD-JWT VC, and whether the
trust source is an ETSI TS 119 602 LoTE or an ETSI TS 119 612 Trusted List), returned as HTTP 400
with `{error, message}` and mirrored into `session.failureCode` / `session.errorReason`:
`signature_invalid`, `no_trust_chain_to_root`, `trust_chain_not_trusted`, `trust_list_unavailable`,
`certificate_expired`, `x5c_missing`, `verification_error`.

Proposed mapping to the prompt's §6.5 terminal outcomes — this is the concrete basis for the
adapter's error normalisation:

| EUDIPLO signal | Platform outcome |
|---|---|
| `status: completed`, `outcome.result: "success"`, policy satisfied | `VERIFIED` |
| `status: completed`, outcome success, policy not satisfied | `POLICY_NOT_SATISFIED` |
| `signature_invalid`, `certificate_expired`, `x5c_missing` | `REJECTED` |
| `no_trust_chain_to_root`, `trust_chain_not_trusted` | `TRUST_ERROR` |
| `trust_list_unavailable` | `TRUST_ERROR`, flagged verifier-side — EUDIPLO documents this as a misconfiguration or outage, **not** a credential defect, and the platform must not report it to the customer as a failed credential |
| OpenID4VP error response with `error: "access_denied"` | `DECLINED_BY_USER` (subject to `RPA_11`, §3.3) |
| other OpenID4VP error, `verification_error`, adapter timeout | `PROTOCOL_ERROR` |
| `status: expired` | `EXPIRED` |
| platform-initiated `DELETE /session/:id` | `CANCELLED` |

Wallet error responses are first-class: `AuthorizationResponse` accepts
`{error, error_description, error_uri, state}` per OpenID4VP §6.2, so `access_denied` does reach
EUDIPLO.

`status: failed` alone is **not** sufficient to choose an outcome — it covers trust failures,
signature failures and protocol failures alike. The adapter must branch on `failureCode` /
`outcome.error`, never on `status`.

### 4.7 Retention behaviour — and what EUDIPLO actually stores

Global defaults (Joi-validated): `SESSION_TTL` = 86400 s (24 h), `SESSION_CLEANUP_MODE` = `full`,
`SESSION_TIDY_UP_INTERVAL` = 3600 s. Per tenant, `GET/PUT/DELETE /session-config` accepts
`{ttlSeconds (min 60, null resets to global), cleanupMode: "full" | "anonymize"}`. `full` deletes
the record; `anonymize` keeps id/status/timestamps and nulls the sensitive fields.

**The session row holds presentation and issuance content.** Verified fields on `SessionEntity`
include `credentials?: VerificationResult[]` (from `@sd-jwt/sd-jwt-vc`, which carries the
disclosed payload), `credentialPayload?: OfferRequestDto` (which can contain **inline issuance
claims**), `requestObject`, `responseEncryptionPrivateJwk`, `offer`, plus `outcome`, `failureCode`
and `errorReason`.

So with defaults, disclosed personal data and inline issuance claims sit in the EUDIPLO database
for **up to 24 hours**. That is incompatible with the prompt's §8.1 ("never persisted by
default") unless the platform configures it away. Required configuration, per EUDIPLO tenant:

- `ttlSeconds` at or near the floor of **60**, sized to the transaction lifetime, not to an audit
  window;
- `cleanupMode: "anonymize"` so the outcome metadata the platform correlates against survives
  while the content does not;
- `LOG_SESSION_STORE=off` (the default) — `errors`, `all` and `verbose` persist session logs;
- `LOG_ENABLE_HTTP_LOGGER=false` and **never** `LOG_REDACT_SENSITIVE_DATA=false`;
- `AUDIT_LOG_RETENTION_DAYS` / `AUDIT_LOG_MAX_ENTRIES_PER_TENANT` set explicitly (both default to
  disabled, i.e. unbounded growth).

Even so, content exists in EUDIPLO's database transiently and within the tidy-up interval. The
honest statement for `privacy.md` is: the **platform** never persists presentation or issuance
content; the **wrapped engine** holds it for a bounded, configured window inside the trust
boundary, and the platform documents and minimises that window rather than denying it. Decided in
[ADR 0004](adr/0004-ephemeral-presentation-and-issuance-processing.md).

`POST /storage` and `GET /storage/:key` also exist; the platform must not use them for content.

### 4.8 Result delivery — and a security gap to compensate for

Two paths: webhooks (recommended) or polling/SSE on `/session`. Webhook endpoints are tenant
resources (`POST /issuer/webhook-endpoints`) with `{id, url, events[], auth}`; events include
`credential.issued`, `presentation.completed`, `notification.received`, deferred-ready.
`presentation.completed` carries `presentedClaims` — i.e. the claims themselves.

Authentication options are `apiKey` (static header), `bearerToken`, `basic`, `none`. There is
**no payload signature, no timestamp, and no event id for idempotency**. The prompt's §6.8
requirements (HMAC-SHA256, timestamp header, event id, exponential backoff) are for the
*platform's* customer-facing webhook, and remain unchanged. But the EUDIPLO → platform hop is a
separate, weaker channel carrying claims. Mitigations for V0:

- keep that hop on the internal Compose/cluster network, never public;
- bind the platform's receiver to a per-EUDIPLO-tenant bearer secret, and reject anything else;
- correlate every callback to a known platform transaction via the EUDIPLO session id and drop
  unknown ones (the platform's own idempotency, since EUDIPLO supplies no event id);
- do not expose EUDIPLO's admin API or UI beyond localhost, per the prompt's §8.3.

Polling `GET /session/:id` avoids the inbound hop entirely and is the safer V0 default. The
adapter should support both behind `EudiVerifierPort.getPresentationStatus` /
`processPresentationResult`, with polling as the default and the webhook as an optimisation.

### 4.9 Keys, access certificates and the registrar client

`/key-chain` manages key chains: `POST /key-chain`, `POST /key-chain/import`, `PUT`/`DELETE`,
`POST /key-chain/:id/rotate`, `GET /key-chain/:id/export`, plus provider management
(`GET/PUT/DELETE /key-chain/providers/config`, `/providers/health`). `KeyUsageType` is
`access | attestation | trustList | statusList | encrypt`. Import accepts PEM/CRT/CER/DER and
pasted PEM, validates the key/certificate relationship, and expects leaf-first chain order.
KMS options: database-encrypted, Vault, AWS, PKCS#11.

Registrar integration: `GET/POST/PATCH/DELETE /registrar/config` and
`POST /registrar/access-certificate` with `{keyChainId}`, returning `{id, keyChainId, crt}`.
Configuration is per tenant (`registrarUrl`, `oidcUrl`, `clientId`, `clientSecret?`, `username`,
`password`, `registrationCertificateDefaults`) and can also come from
`config/{tenant-id}/registrar.json`. Note: credentials imported from file at startup are **not**
validated.

The shipped registrar preset list has exactly one entry: **"German Sandbox"**, at
`https://sandbox.eudi-wallet.org/api` with OIDC realm
`https://auth.sandbox.eudi-wallet.org/realms/sandbox-registrar`. This matters a great deal — §5.

Trust: `POST/GET/PUT/DELETE /trust-list` with versioning and export, `GET /issuers/:tenantId/trust-list/:id`
for publication, and cache control at `GET /cache/stats`, `DELETE /cache`, `DELETE /cache/trust-list`,
`DELETE /cache/status-list`. Both ETSI TS 119 602 LoTEs (JSON) and ETSI TS 119 612 Trusted Lists
(XML) are normalised at the load boundary into one trust store, which satisfies the shape
`EW-PIO-01-029` (`OIA_15b`) requires — though not, by itself, `EW-PIO-01-028` (`OIA_15a`)'s trust
anchor **management** obligations.

### 4.10 Database, deployment and release risk

TypeORM. SQLite by default (`DB_TYPE=sqlite`, file under `FOLDER`, default `./config`);
**PostgreSQL supported and documented as production-ready** (`DB_TYPE=postgres`, `DB_HOST`,
`DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`, `DB_SSL`, plus
`DB_SSL_REJECT_UNAUTHORIZED`, `DB_SSL_CA_PATH`, mTLS paths). Migrations since v2.0.0, run on
startup by default (`DB_MIGRATIONS_RUN=true`); `DB_SYNCHRONIZE` defaults to `false` and must stay
there. V0 will use PostgreSQL in a database **separate from the platform's**, per the prompt §3.3.

`docker-compose.yml` ships `eudiplo` (port 3000, healthcheck `GET /health`, volume
`./assets:/app/config`) and `eudiplo-client` (4200→8080), both on `:latest`, with **no database
service** — i.e. the shipped Compose implies SQLite. The platform's Compose must add PostgreSQL
and pin digests. Required services beyond those two: none. OpenTelemetry is optional
(`OTEL_SDK_DISABLED=true` locally).

`PUBLIC_URL` drives every wallet-facing URL (issuer metadata, request URIs, status lists), so it
must be the externally reachable HTTPS origin, not `localhost`, whenever a phone is involved.
`TLS_ENABLED` with cert/key paths allows EUDIPLO to serve HTTPS directly.

**Release-velocity risk, with evidence.** Six releases in 27 days. `v7.5.0` upgraded to NestJS 12
on CommonJS; `v7.6.0` then migrated the backend to native ESM. `v7.3.0` fixed "the session
columns that no migration ever created" (closing issue #894) — a real migration defect reaching a
release. `v7.3.0` also added optimistic concurrency to status lists and `v7.6.0` serialised SQLite
status-list writes. The `eudiplo-assessment.md` verdict of `WRAP` with an anti-corruption layer is
well supported; the adapter and its contract tests are the mitigation, and the pinned digest is
the control.

### 4.11 Documentation divergences found in EUDIPLO

Recorded in full in [`interop-findings.md`](interop-findings.md). Summary: documented routes that
do not exist as written (`POST /clients` vs `/client`; `PATCH /{tenant}/status-management/status-list/{listId}/entry/{index}`;
`/{tenant}/chained-as/*` vs `/issuers/:tenantId/chained-as/*`); a stale retention model in
`architecture/sessions.md` (`{cleanupMode: "delete"|"anonymize", retentionDays: 90}` vs the actual
`{ttlSeconds, cleanupMode: "full"|"anonymize"}`); a stale image reference
(`ghcr.io/openwallet-foundation-labs/eudiplo:latest`); and a wrong citation of the status-list
specification as "RFC 9528" (`reference/protocols.md` links the correct IETF draft). **The
adapter must be written against the code and the OpenAPI document, not the prose.**

---

## 5. Reference Wallet target and trust setup — §3.4

### 5.1 Target

Both platforms are at `2026.09.42-Demo_Build=42` (2026-09-10) and actively maintained on a monthly
cadence. **Target Android.** Reasons: EUDIPLO's own wallet-compatibility page lists only the
Android RI build as tested; the Android repository is the one whose trust configuration is
documented (`wiki/CONFIGURATION.md`, `wiki/GO_LIVE.md`); and if a custom build is needed (§5.4)
Android is far cheaper to build and side-load than iOS.

EUDIPLO's tested RI version is `2026.02.26-Demo`, last verified **26 February 2026** — about six
and a half months stale, across EUDIPLO v4.x→v7.6.0 and seven wallet releases. Its recorded note
is that the RI "forces Wallet attestation". Its feature matrix marks the RI as supporting
authorization-code and pre-authorized-code issuance, DPoP, wallet attestation, SD-JWT and mdocs,
with DC API `n/a` and ISO 18013-7 Annex C untested. **Treat that matrix as stale evidence, not as
a current compatibility statement.**

### 5.2 Supported flows and formats

From the RI README and the wallet's own configuration: OpenID4VP v1 remote presentation with
DCQL, OpenID4VCI 1.0 issuance, ISO/IEC 18013-5 proximity, RQES modules.
`withFormats(Format.MsoMdoc.ES256, Format.SdJwtVc.ES256)`. Registered deep-link schemes include
`openid4vp`, `eudi-openid4vp`, `mdoc-openid4vp`, `haip-vp` and `openid-credential-offer` — so
EUDIPLO's `openid4vp://?…` presentation URI and `openid-credential-offer` issuance URI are both
accepted.

### 5.3 How the wallet decides to trust a verifier — verified in code

The wallet's demo-flavour configuration
(`core-logic/src/demo/java/eu/europa/ec/corelogic/config/WalletCoreConfigImpl.kt`) is decisive:

```kotlin
configureOpenId4Vp {
    withClientIdSchemes(listOf(ClientIdScheme.X509SanDns, ClientIdScheme.X509Hash))
    …
}
configureEtsiTrust {
    loteLocations(SupportedLists(
        pidProviders   = Uri("https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PIDProviders.jwt"),
        wrpacProviders = Uri("https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt"),
        wrprcProviders = Uri("https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPRCProviders.jwt"),
        pubEaaProviders= Uri("https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PubEAAProviders.jwt")))
    relaxCertificateProfiles(); relaxPkixRevocation()   // dev/demo only
}
configureReaderTrustStore { readerAuthPolicy(ReaderAuthPolicy.EnforceIfPresent) }
configureIssuerTrust { policy { default(TrustPolicy.Action.ENFORCE) }; requireSignedMetadata(); … }
```

Four consequences:

1. **Only `X509SanDns` and `X509Hash` are enabled.** `ClientIdScheme.Preregistered` is supported by
   Wallet Core v0.30.2 but is **not** configured in the shipped build, and enabling it means
   editing Kotlin constants and rebuilding the app. EUDIPLO uses `x509_hash:` — so the schemes
   match, and the *only* gate is the certificate chain.
2. **Access-certificate trust is always enforced**, against trust anchors downloaded at runtime
   from the WRPAC LoTE. `ReaderAuthPolicy.EnforceIfPresent` admits a reader that sends **no**
   reader authentication — but an `x509_hash` request object is signed with an `x5c`, so reader
   authentication *is* present and the chain *is* checked. `EnforceIfPresent` provides no escape.
3. **Registration-certificate checking ships off.** One Settings switch,
   *Check Registration Certificates*, drives both `configureWrpRegistrationPolicy` and
   `configureIssuerRegistrationPolicy`, read once at wallet-configuration build time (so a change
   applies on next app start). With it off, nothing about registration is evaluated. With it on:
   on the **presentation** path an unverified or over-reaching registration does not block — the
   user is warned and must acknowledge; on the **issuance** path it is a **precondition for
   storing the document**, and failure refuses issuance outright.
4. Dev relaxations `relaxCertificateProfiles()` and `relaxPkixRevocation()` are active in the
   reference flavours and must be removed for production — meaning the dev environment is more
   permissive about certificate profiles and revocation than a conformant deployment.

### 5.4 The V0 blocker, with evidence

I fetched all four live dev LoTEs (HTTP 200, ES256-signed `jose+json` with `x5c`) and decoded
them. The WRPAC list — `LoTEType http://uri.etsi.org/19602/LoTEType/EUWRPACProvidersList`, issued
2026-07-09, next update 2027-01-05 — contains exactly **seven** Access CA trust anchors:
`EUDIW WRPAC Provider - {EE, NL, CZ, EU, LU, PT, UT} 02`, each with a paired `…/Revocation`
service entry.

**Therefore:** a self-hosted EUDIPLO verifier is trusted by an unmodified official RI build only
if its access certificate chains to one of those seven anchors. A self-signed access certificate
cannot work. And the **"German Sandbox" registrar that EUDIPLO ships as its only preset
(`https://sandbox.eudi-wallet.org/api`) is not among them** — there is no `DE` entry in the
WRPAC LoTE. So EUDIPLO's own registrar-enrolment path does not produce a certificate the official
RI wallet will accept.

Two further observations from the same data:

- The seven WRPAC anchors are byte-identical (same SHA-256 digests) to the seven **WRPRC** anchors
  **and** to the seven **PIDProviders** anchors. The dev environment collapses three distinct ARF
  trust domains onto one set of certificates, which are literally named
  `CN=PID Issuer CA 02, O=EUDI Wallet Reference Implementation, C=EU`, with CRLs under
  `https://preprod.pki.eudiw.dev/crl/`. The platform's `TrustResolver` must keep the domains
  separate regardless — as
  [`06-shared-capabilities/trust-infrastructure.md`](../../06-shared-capabilities/trust-infrastructure.md)
  already requires — and this is concrete evidence that the reference environment does not.
- The `PubEAAProviders` LoTE has seven **distinct** trusted entities, unlike the other three which
  each have one entity holding many services. Relevant to M2 only.

### 5.5 The viable path, and what it costs

**Path A — enrol at the official RP Registration Service (preferred).**
`https://registry.serviceproviders.eudiw.dev/` issues Relying Party Access Certificates **in
PKCS#12**, on the same `serviceproviders.eudiw.dev` host family as the dev trusted lists, which
strongly suggests its CA is among the seven anchors — **suggests, not proves**: the service
documentation does not name its CA, and I could not verify the chain without an account. Its
documentation carries an explicit non-production disclaimer and states it "must not be used to
manage real Relying Party access certificates". How a developer obtains an account is **not
documented** (Q1).

Because EUDIPLO's registrar client targets a different registrar, the integration is not
"EUDIPLO enrols the certificate" but:

1. enrol the Relying Party and Service at `registry.serviceproviders.eudiw.dev` out of band;
2. `POST /key-chain/import` the resulting P12 into an EUDIPLO key chain with
   `usageType: "access"`, leaf-first;
3. set `accessKeyChainId` on the presentation configuration to that key chain.

That path is fully supported by EUDIPLO's verified API. Registration certificates are a separate
matter: the service appears to issue RPAC only, not RPRC. Since the RI wallet ships registration
checking **off**, a V0 presentation can complete with RPAC alone — while being explicit that this
exercises one of the two ARF trust layers, not both.

**Path B — build the RI wallet from source.** Either add `ClientIdScheme.Preregistered` or
register a custom reader trust store (`configureReaderTrustStore(context, R.raw.my_ca)`; a custom
store takes precedence over the ETSI store, which takes precedence over static certificates).
This works but produces a **modified wallet**, not the official Reference Wallet. Per the prompt's
§12 it must be labelled as such and never reported as an official-wallet result.

**Decision.** Implement everything, pursue Path A, and if no account is obtainable in time,
deliver Path B **explicitly labelled as a modified build** plus adapter-level tests, documented
manual steps, and a precise statement of what is still needed — exactly the §12 procedure. Do not
simulate success either way.

### 5.6 Test credentials and network requirements

The live test PID issuer `https://issuer.eudiw.dev` responds 200 on
`/.well-known/openid-credential-issuer` and advertises **27** credential configurations, including:

| Configuration id | Format | Type |
|---|---|---|
| `eu.europa.ec.eudi.pid_vc_sd_jwt` | `dc+sd-jwt` | `vct = urn:eudi:pid:1` |
| `eu.europa.ec.eudi.pid_mdoc` | `mso_mdoc` | `doctype = eu.europa.ec.eudi.pid.1` |
| `eu.europa.ec.eudi.pid_mdoc_deferred` | `mso_mdoc` | deferred variant |

Metadata declares `batch_credential_issuance`, `credential_request_encryption`,
`credential_response_encryption`, `deferred_credential_endpoint`, `nonce_endpoint` and
`notification_endpoint`. A second issuer `https://issuer-backend.eudiw.dev` and the wallet
provider `https://wallet-provider.eudiw.dev` are also configured in the RI.

Network: the phone must reach EUDIPLO over public HTTPS with a valid certificate, and
`PUBLIC_URL` must be that origin. Options, in order of preference for V0: a public test host with
a real certificate; an HTTPS tunnel (the EUDIPLO docs use ngrok); `TLS_ENABLED=true` with a
publicly trusted certificate. A self-signed TLS certificate will not work — the RI's hardening
guidance explicitly forbids trust-all `X509TrustManager` or permissive `HostnameVerifier`, and the
shipped build honours that.

---

## 6. Chosen end-to-end scenarios

### 6.1 VaaS (Milestone 1)

Tenant → Organisation → Relying Party (`TEST`) → Service → Intended Use → Presentation Policy,
then `POST /v1/presentations` → snapshot → compile → `EudiVerifierPort` → EUDIPLO
`POST /verifier/offer` → `openid4vp://` URI → RI wallet presents → EUDIPLO verifies → platform
normalises and applies the result policy → result via `GET` and callback → content purged.

**Credential:** PID as **SD-JWT VC**, `vct = urn:eudi:pid:1`, from `issuer.eudiw.dev`. The prompt
prefers a PID presentation and the reference environment supports it. SD-JWT VC rather than mdoc
because `EW-PIO-01-007` (`OIA_03c`) is the cleaner profile for a redirect-based remote flow, and
because the dev SD-JWT PID exposes flat claim paths that make the §6.1 path-subset check easy to
demonstrate.

**Requested claim — and why it is not `age_over_18`:** see §6.3. The V0 policy requests
`["birthdate"]` under a `DERIVED_CLAIMS` result policy that emits only a boolean `over_18`.

### 6.2 An ARF constraint on the QR / cross-device flow that §6.7 does not anticipate

The prompt's §6.7 response shape is `interaction: { type: "QR" | "SAME_DEVICE", uri }`, and §6.9
describes a QR flow. Two HLRs bear directly on that:

- `EW-PIO-01-016` (`OIA_08c`): "Wallet Units **SHOULD NOT** support using a redirects-based
  transmission mechanism for **cross-device** presentation flows."
- `EW-PIO-01-017` (`OIA_08d`): "If a Relying Party uses a redirects-based transmission mechanism
  for cross-device presentation flows, it SHALL implement adequate mitigations for the challenges
  described in Section 4.4.3.1 of the ARF main document."

A QR code carrying an `openid4vp://` URI is exactly a redirects-based cross-device flow. ARF 3.0.0
discourages it on the wallet side and places an explicit mitigation obligation on the RP. The
sanctioned cross-device path is the W3C Digital Credentials API with the proximity check in
`EW-PIO-01-020` (`OIA_08g`) — which the prompt's §6.7 puts **out of scope** for V0, and which the
RI feature matrix marks `n/a`.

This is a genuine tension in the V0 scope, not a blocker. Recommendation: keep both
`interaction.type` values in the API surface, make `SAME_DEVICE` the documented and tested V0
path, and treat `QR` as available-but-flagged with the `OIA_08d` mitigation obligation recorded as
unmet in `security-limitations.md`. EUDIPLO supports this cleanly because it returns both `uri`
and `crossDeviceUri`. Raised here for the user's decision; proposed in
[ADR 0005](adr/0005-presentation-policy-abstraction-and-minimisation-first-compilation.md).

### 6.3 The minimisation example in §6.4 is not implementable — and this is the most consequential finding

The prompt's §6.4 instructs: "for an age check, request `age_over_18` from the PID rather than the
birth date", and notes that ARF says these attributes are present "if present", so a fallback may
be needed.

That reflects an **earlier ARF version**. At the pinned baseline:

- **PID Rulebook v1.1 (4 Sep 2025), change log, verbatim:** *"Taking PID Rulebook out of ARF 2.5.0
  and into separate GitHub repository. **Age verification attributes removed, following
  CIR 2024/2977.**"*
- I enumerated every attribute in the current Rulebook — §2.2 mandatory, §2.3 optional, §2.4–2.5
  metadata, §2.6 Rulebook additions. The complete set contains **no** `age_over_18`,
  `age_over_NN` or `age_in_years`. Mandatory attributes are `family_name`, `given_name`,
  `birth_date`, `birth_place`, `nationality`, `portrait`. §2.6 adds only `trust_anchor` and
  `attestation_legal_category`.
- The live dev PID issuer agrees: `eu.europa.ec.eudi.pid_vc_sd_jwt` advertises 27 claims and
  `eu.europa.ec.eudi.pid_mdoc` 26, and **neither contains any age-related claim**. The only date
  of birth is `birthdate` (SD-JWT VC) / `eu.europa.ec.eudi.pid.1.birth_date` (mdoc).
- The ARF HLR register mentions `age_over_18` only in a parenthetical note about values changing
  on a birthday, conditioned on "if present". No HLR requires a PID to carry it.
- The rulebook catalogue currently contains only `pid` and `mdl` — there is no age-verification
  attestation rulebook. Age verification has moved to a separate ecosystem, evidenced by the
  separate AV wallet (`av-app-android-wallet-ui`, mdoc-only) that EUDIPLO lists as tested.

**Consequences, all of which shape ADR 0005:**

1. Requesting `age_over_18` from a PID would fail against the reference environment and would not
   be conformant with the current PID Rulebook.
2. For an age check over a PID, derivation from `birth_date` is not a fallback — it is the **only**
   available route. The prompt's conditions on derivation therefore become the primary path, not
   an exception: the policy must declare the derivation explicitly, the source attribute must be
   registered for the intended use, and the raw value must be discarded immediately after
   derivation and never returned.
3. The minimisation principle itself is unaffected and still binding — TS5 §2.4.5 restates it
   ("may only request the minimum set of attestations and attributes … necessary for a specific
   intended use") — but the **source-level** minimisation the prompt describes is unavailable for
   age, so minimisation must be enforced at the **result** boundary by `DERIVED_CLAIMS`. That is
   the opposite emphasis from §6.4's "filtering the business result is not a substitute", and it is
   forced by the baseline, not chosen.
4. The compiler's minimisation rules should be written as a general *preference* ("prefer a
   pre-computed minimal attribute where the credential type offers one"), with age as a
   **documented counter-example** where no such attribute exists. Writing the rule around
   `age_over_18` specifically would hard-code an attribute that no longer exists.

### 6.4 IaaS (Milestone 2) — scope confirmed, with one wallet-side condition

One non-qualified EAA, SD-JWT VC, pre-authorized-code flow, `openid-credential-offer` URI, status
via Token Status List, revocation via `POST /session/revoke`, fixture authentic-source connector.
All supported at v7.6.0 per §4.4–§4.5.

The condition is `AS-AP-44-004` (`RPRC_22`), `AS-AP-44-005` (`RPRC_22a`), `AS-AP-44-006`
(`RPRC_22b`) and `AS-AP-44-007` (`RPRC_23`): an Attestation Provider must include its registration
certificate **in its Credential Issuer metadata, by value** (per the ETSI TS 119 472-3 extension
to OpenID4VCI), and a Wallet Unit **SHALL NOT request issuance** if that certificate is absent,
malformed, inauthentic or expired, if its identifier does not match the access certificate, or if
the attestation type is not listed in it.

This is materially stricter than the presentation path, where the wallet only warns. The RI wallet
implements it behind the same *Check Registration Certificates* switch: with it on, a verified
in-scope registration certificate is a **precondition for storing any document**. So M2 end-to-end
issuance to the official RI build works today **only** because that switch ships off. With the
switch on, M2 needs an Attestation Provider registration certificate from a WRPRC-listed provider
— which the EUDIW dev RP Registration Service does not appear to issue. Recorded as blocker B4 and
open question Q3.

---

## 7. Blockers

| # | Blocker | Evidence | Effect | Mitigation |
|---|---|---|---|---|
| **B1** | No wallet-trusted access certificate for a self-hosted verifier | WRPAC LoTE contains only 7 EUDIW anchors; `AS-WP-06-005` (`RPA_04`); RI enables only `X509SanDns`/`X509Hash` | The **official** RI build will refuse a self-hosted verifier. | **Accepted and mitigated at the Phase 0 checkpoint:** Milestone 1 uses **Path B** — a self-built wallet from the Reference Implementation with a platform-operated development Access CA added to its reader trust store. This is a **modified wallet** and every report must say so. The official-build result remains **unverified**; Path A closes it |
| **B2** | EUDIPLO's only registrar preset is not on the dev WRPAC LoTE | `registrar.component.ts` preset `https://sandbox.eudi-wallet.org/api`; no `DE` entry in WRPAC LoTE | EUDIPLO's built-in enrolment cannot produce a wallet-trusted certificate | Out-of-band enrolment + key-chain import; do **not** model the registrar client as the platform's enrolment path in V0 |
| **B3** | No registration certificate provider reachable for V0 | RP Registration Service documents PKCS#12 RPAC only; WRPRC LoTE has only the 7 EUDIW anchors | Only one of the two ARF trust layers can be exercised. Tolerable because the RI ships registration checking **off** | Support `registrationCert.jwt` passthrough so a real RPRC can be dropped in later; state in `traceability.md` that `RPRC_19`/`RPRC_21` are **not** demonstrated end to end |
| **B4** | M2 issuance depends on the RI's registration switch being off | `RPRC_22a`/`RPRC_23`; RI `configureIssuerRegistrationPolicy` | Turning the switch on breaks M2 issuance with no RPRC | Test M2 with the switch in **both** positions and report both results honestly |
| **B5** | Public HTTPS required for any phone test | `PUBLIC_URL`; RI forbids permissive TLS | No physical-device test from plain localhost | Tunnel or public test host; document both; adapter tests must not depend on it |
| **B6** | EUDIPLO release velocity and migration defects | 6 releases in 27 days; ESM migration in v7.6.0 after NestJS 12/CJS in v7.5.0; v7.3.0 fixed missing session-column migrations | Upgrades may break the adapter | Pin the digest; adapter contract tests; treat any bump as a reviewed change |
| **B7** | `age_over_18` does not exist in the current PID | PID Rulebook v1.1 change log; full attribute enumeration; live issuer metadata | The §6.4 worked example and any policy written around it are unimplementable | Redesign ADR 0005 around derivation-as-primary (§6.3) |

---

## 8. Open questions

| # | Question | Why it matters | How to resolve |
|---|---|---|---|
| ~~**Q1**~~ | ~~How does a developer obtain an account at `registry.serviceproviders.eudiw.dev`?~~ | — | **RESOLVED** at the Phase 0 checkpoint: Milestone 1 proceeds on **Path B**, a self-built wallet from the EUDI Reference Implementation with a platform-operated development Access CA in its reader trust store. Path A remains the preferred production route and is still worth pursuing in parallel; if an account arrives, the same access certificate is imported the same way and no platform code changes |
| **Q2** | Is the platform's hosted-RP-Instance profile a GDPR processor or an Article 5b(10) intermediary? | `RPI_01`–`RPI_10` impose registration, display and no-storage duties if intermediary | Legal and registrar confirmation. Already open in `gaps.md`; recorded in `knowledge-alignment.md`. **Not resolvable technically** |
| **Q3** | Which provider can issue an Attestation Provider registration certificate for a `TEST` EAA? | B4 | Ask the EUDIW reference-environment maintainers; inspect the WRPRC LoTE for any non-EUDIW entity |
| **Q4** | Does EUDIPLO's CWT status-list encoding satisfy Annex 2 of the amended CIR 2024/2979? | `VCR_11` for mdoc; `VCR_12` requires both mechanisms of a checking RP | Read CIR 2024/2979 Annex 2 against `@owf/token-status-list`. Not on the V0 path (V0 issues SD-JWT VC) but must not be claimed |
| ~~**Q5**~~ | ~~Should V0 offer the QR / cross-device flow, given `OIA_08c` and the `OIA_08d` mitigation duty?~~ | — | **RESOLVED** at the Phase 0 checkpoint: `SAME_DEVICE` is the tested V0 path; `QR` stays in the API surface, flagged, with the unmet `OIA_08d` obligation in `security-limitations.md`. See ADR 0005 Decision 6 |
| **Q6** | How should the platform pin TS documents, given neither TS repo is tagged? | §1.1; `traceability.md` integrity | Proposal: record *(TS internal version + repo commit SHA + retrieval date)* per citation |
| **Q7** | Does an intermediary need a separate access certificate **per intermediated RP**? | The prompt §5.1 asserts it; `RPI_06` does not say so | Read ETSI TS 119 475 and TS5 `servedWRPServices`. Out of V0 scope; do not assert either way |
| **Q8** | What is the current RI ↔ EUDIPLO compatibility status? | EUDIPLO's matrix is 6.5 months stale; the RI "forces Wallet attestation" | Empirical test once B1/B5 are cleared. Until then the honest answer is "unverified" |
| **Q9** | Does the RI wallet accept an `x509_hash` request whose certificate chains to a WRPAC anchor but carries no RPRC, without a blocking warning? | Determines whether the V0 demo is clean or warning-laden | Empirical, after B1 |

---

## 9. Decisions taken in Phase 0

1. **Pin EUDIPLO `v7.6.0` by digest**, not `v7.2.0` and not `:latest`. §1, §4.10.
2. **One EUDIPLO tenant per platform `RelyingPartyInstance`** (per RP Service × environment), not
   per platform `Tenant`. §4.2, ADR 0002.
3. **Target the Android Reference Wallet** `2026.09.42-Demo_Build=42`. §5.1.
4. **VaaS scenario: PID as SD-JWT VC (`urn:eudi:pid:1`) from `issuer.eudiw.dev`**, requesting
   `["birthdate"]` with a `DERIVED_CLAIMS` boolean result. §6.1, §6.3.
4a. **`SAME_DEVICE` is the tested V0 interaction**; `QR` is present but flagged. Resolved at the
   Phase 0 checkpoint. ADR 0005 Decision 6.
4b. **Milestone 1 interoperates with a self-built Reference-Implementation wallet** (Path B),
   trusting a platform-operated development Access CA. Resolved at the Phase 0 checkpoint. Every
   report must label it a modified wallet; the official build stays unverified.
5. **Access certificates enter EUDIPLO by import, not by registrar enrolment**, in V0. §5.5, B2.
6. **Polling is the default result-delivery path** from EUDIPLO; webhook is an optimisation on an
   internal network with a platform-side bearer secret and platform-side idempotency. §4.8.
7. **Per-EUDIPLO-tenant session configuration is mandatory**: minimal `ttlSeconds`,
   `cleanupMode: "anonymize"`, session logging off. §4.7, ADR 0004.
8. **`requestedClaims` are OpenID4VP claim paths**, and the §6.1 subset check is a path-subset
   check. §3.6.
9. **`purpose` and `privacyPolicy` are localised, multi-valued** on `IntendedUse`. §3.6.
10. **Retain the EUDIPLO session id on `IssuedCredentialRecord`** so M2 revocation remains
    possible after session purge. §4.5.
11. **Branch on `failureCode` / `outcome.error`, never on `status`**, when normalising outcomes.
    §4.6.
12. **Record divergences rather than editing knowledge pages**:
    [`interop-findings.md`](interop-findings.md), [`knowledge-alignment.md`](knowledge-alignment.md).

ADR drafts: [0001](adr/0001-platform-technology.md), [0002](adr/0002-eudiplo-as-wrapped-engine.md),
[0003](adr/0003-modular-monolith.md), [0004](adr/0004-ephemeral-presentation-and-issuance-processing.md),
[0005](adr/0005-presentation-policy-abstraction-and-minimisation-first-compilation.md).
ADR 0006 (hosted RP instance vs intermediary) is listed in the prompt's §10 and is blocked on Q2;
0007 and 0008 belong to Milestone 2.

**No conformance with ARF 3.0.0 or any Technical Specification is claimed by this document. No
part of this investigation demonstrates production readiness.**
