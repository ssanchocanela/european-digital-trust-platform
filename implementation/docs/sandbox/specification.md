# EUDI ecosystem sandbox — specification (S1)

- **Status:** DRAFT for the S1 checkpoint, 12 November 2026.
- **Starting point:** [`s0-findings.md`](s0-findings.md), with D1–D8 accepted by the user on
  12 November 2026.
- **Decisions:** [ADR 0014](../adr/0014-sandbox-trust-domain.md) (trust domain and its CAs) and
  [ADR 0015](../adr/0015-sandbox-sign-in-by-pid.md) (people and sign-in).
- **Plan:** [`plan.md`](plan.md).

Every rule of [`CLAUDE.md`](../../CLAUDE.md) applies. The sandbox is `TEST` only. Nothing in it, or
said about it, claims ARF/TS conformance or production readiness.

## Sources, pinned

| Source | Pin |
|---|---|
| ARF, HLR register | as in CLAUDE.md §2 (`v3.0.0` @ `c64f2cbb…`) — cited as `Harmonized_ID` (`Index`) |
| Technical Specifications | `ee91a294…` — TS5 1.5, TS6 1.2.2, TS2 1.0.1 |
| **ETSI TS 119 475 V1.2.1 (2026-03)** | PDF SHA-256 `77bf8e71715c495494113da23ccba89c0af8bf6b457fe2da38b5a12738ace55f` |
| **ETSI TS 119 411-8 V1.1.1 (2025-10)** | PDF SHA-256 `2bbfffeca655b96b09e52d937a930744215c2c9e3ee7f41f14d990968c845fe3` |
| **ETSI TS 119 602 V1.1.1 (2025-11)** | PDF SHA-256 `27a00765a20661ecd04076a406b26a5be1123228a2f44a2dc74caeb3041155ec`; JSON schema forge.etsi.org `esi/x19_60201_lists_of_trusted_entities` @ `e84f427f0cde99513b574ef4b5a155ac4a38eab6` |
| EUDI Wallet Core | `0.30.2` (the pinned wallet's), read from its compiled classes |

**Not read:**
- EN 319 411-1;
- EN 319 412-1/-2/-3;
- TS 119 182-1.

Where a profile point depends on one of them, this document says so, and S2 reads it before that
point is implemented.

---

## 1. Purpose and scope

The sandbox lets an organisation **play a role of the EUDI Wallet ecosystem against real protocol
flows**, with certificates and trust lists it could not get anywhere else, including deliberately
defective ones. It is a test domain run by the platform, in which the platform plays the Member
State's roles: Registrar, Access CA, provider of registration certificates, and trust-list operator.

**v1 roles:**
- **Relying Party** — a wallet-relying party with entitlement `Service_Provider`;
- **PID Provider** — entitlement `PID_Provider`.

**Later, out of v1:**
- QEAA, PuB-EAA and non-qualified EAA Providers;
- Wallet Provider;
- intermediaries;
- verification of an organisation's identity or representation;
- mdoc PIDs (G-9, planned for v1.1).

**What a participant gets in v1:**
1. Sign-up and sign-in by PID, an organisation, members, API keys (ADR 0015).
2. A registration in the sandbox register, readable through the TS5 read API.
3. Access certificates (WRPAC) and registration certificates (WRPRC) for its services — correct, or
   with a chosen defect (§5).
4. A **hosted verifier** (RP) or a **hosted PID issuer** (PID Provider) configured with those
   certificates, plus a run report for every flow.
5. Its certificates and keys to take away, to test its **own** verifier or issuer software against
   the sandbox's test wallet.
6. The sandbox's trust lists and a test wallet build that reads them.

## 2. The constraint every page states

**Only a modified wallet trusts the sandbox.** An official wallet build accepts access certificates,
registration certificates and PIDs only under anchors on the notified lists:
- `AS-WP-06-005` (`RPA_04`);
- `EW-DM-44-005` (`RPRC_02a`);
- `AS-AP-10-007` (`ISSU_07`).

The sandbox's anchors are not, and never will be, on those lists.

The sandbox is therefore used with an **EDTP test wallet build for the sandbox**: the existing test
wallet, its four list addresses pointed at the sandbox's lists (WD-3, WD-4, WD-8; WD-9 unused in v1).

Every result, page and report says **"modified wallet"**, names the build and its deviations, and
records the position of *Check Registration Certificates*. CLAUDE.md §6.22 governs how that build may
be offered.

## 3. Actors

| Actor | Who | How they act |
|---|---|---|
| **Participant organisation** | A company or public body testing a role | Through its people and API keys; one organisation = one platform `Tenant` |
| **Owner / member** | People of the organisation | Portal, signed in by their Cloudflare Access address; PID optional (ADR 0015, amended by ADR 0018) |
| **Tester** | Whoever holds the test wallet for a run, usually a member | Phone with the sandbox wallet build |
| **Sandbox operator** | The platform operator | Operator role held by configuration: approves brought-in anchors, suspends participants, rotates sandbox keys |
| **The sandbox itself** | The platform | Registrar, Access CA, WRPRC provider, PID CA (for sandbox-issued PID signing certificates), trust-list operator, sign-in verifier |

## 4. User journeys

### J1 — Sign up

*Amended by [ADR 0018](../adr/0018-sandbox-sign-in-by-access-identity.md), 14 November 2026.*

1. The person opens the portal, through Cloudflare Access: a one-time PIN to an invited address.
2. The address Access verified is not yet known, so the portal shows its first screen. It explains:
   - the sandbox and the modified wallet;
   - that only synthetic data belongs in it;
   - that no PID is needed.

   It links the sandbox wallet build (behind Cloudflare Access).
3. The person types a display name and declares the organisation: legal name, trade name, country,
   identifier (§6.1), contact email, support URI, privacy policy URL.
4. The organisation is created and marked **not verified**. The person becomes its owner.

### J2 — Sign in, members, keys, an optional PID

- **Sign in:** opening the portal through Access. The verified address matches, and a session starts.
  The session holds only while Access's assertion names the same address.
- **Members:** an owner invites a member **by e-mail address**, with a single-use link. Only that
  address can accept it. A new invitee types only a display name. The operator must also admit the
  address in the Access policy.
- **API keys:** an owner creates and revokes them (ADR 0015 Decisions 7 and 8).
- **Present a PID (optional):** a signed-in person may present a PID to the sign-in verifier, which
  trusts only the fixed sign-in anchor set (ADR 0015 Decision 2). This is `SAME_DEVICE`, or `QR` from
  a desktop browser. Its pseudonymous subject is recorded on the person, and it gates nothing in v1.

### J3 — Relying Party: register a service and its intended uses

1. Create a **service**: Service trade name and description.
   - The sandbox assigns a Service identifier, unique within the organisation (`AS-MS-27-045`,
     `Reg_33`).
   - Entitlement `Service_Provider`.
2. Add **intended uses**, each with:
   - purpose, localised and multi-valued (CLAUDE.md §6.3);
   - privacy policy;
   - the credentials and claim paths it may request, as OpenID4VP claim paths (CLAUDE.md §6.2);
   - an intended-use identifier, assigned by the sandbox.
3. The register entry is published at once through the read API (§7.2).

### J4 — Relying Party: get certificates

1. **Access certificate**, for the service, one of two ways. *Since S3:* take-away is issued in S3; the
   hosted certificate is issued when the hosted verifier is provisioned (S4), its key generated and
   handed to the engine in the same call.
   - **hosted:** the sandbox generates the key pair and the key goes straight into the engine tenant
     of the hosted verifier, never shown;
   - **take-away:** the participant uploads a PKCS#10 CSR, and the sandbox issues against it. The
     sandbox never sees that private key.
2. **Registration certificate**: one per intended use × service (`EW-DM-44-014`, `RPRC_09`).
3. **Choose a variant** for each certificate: *correct*, or one entry of the defect catalogue (§5).
   - A defective certificate is issued under the same trusted anchors as a correct one (ADR 0014
     Decision 3), so the defect under test is the first thing a wallet meets.
   - Variants can be combined only where §5 says so.
4. Download: chain, leaf, WRPRC (compact JWS) and, for a take-away WRPAC, nothing secret.

### J5 — Relying Party: run a presentation on the hosted verifier

1. **Provision the hosted verifier** for the service: a `RelyingPartyInstance` on an engine tenant
   created at runtime (§8.3), with the chosen WRPAC and the chosen WRPRC.
2. Create a **presentation policy** under an intended use. The existing subset check applies, so a
   policy cannot ask for more than its intended use registers.
   - **One exception, and it is how the over-asking defect is built:** defect `RC-08` registers a
     *narrower* intended use in the WRPRC than the policy asks for. The policy is checked against the
     platform's register entry; the WRPRC carries less.
3. Start a presentation (`SAME_DEVICE`; `QR` under ADR 0012 for the sandbox policies). The tester
   presents from the sandbox wallet.
4. The **run report** (§6) records the result.

### J6 — Relying Party: test its own verifier

The participant runs its own verifier software with a take-away WRPAC and WRPRC from J4.

What the sandbox provides:
- a wallet that trusts them (the sandbox build);
- PIDs to present: from the sandbox's "PID (demo)" issuer, or from another participant's hosted PID
  issuer;
- the register read API, for the verifier's own lookups.

What the sandbox **does not** see: the presentation, which happens between the participant's
verifier and the wallet. The run report for J6 is therefore the participant's own, and the portal
says so.

### J7 — PID Provider: register and get certificates

1. Create a **service** with entitlement `PID_Provider` and `provides_attestations`: the PID types
   and formats it issues. v1 offers `dc+sd-jwt` with `vct` `urn:eudi:pid:1`.
   - No intended use: `EW-DM-44-009` (`RPRC_05`).
   - **Exception:** if the provider wants a PID or attestation presented during issuance, it also
     takes `Service_Provider` and an intended use on the same service ([TS5] §2.4.1).
2. **WRPAC and provider WRPRC**, as in J4, correct or defective.
3. A **PID signing certificate**, D2:
   - **v1 — sandbox-issued:** the sandbox PID CA issues it. Its anchor is already on the sandbox PID
     list, so nothing waits on the operator.
   - **v1.1 — brought in:** the participant uploads its own CA certificate. The operator approves it,
     the sandbox's stand-in for `AS-MS-27-026` (`Reg_19`). Then it goes onto the sandbox PID list,
     and the list is re-signed.

### J8 — PID Provider: issue PIDs from the hosted issuer

1. **Provision the hosted PID issuer**: an `AttestationProvider` on a runtime engine tenant, with:
   - the participant's display name;
   - its PID signing certificate;
   - its WRPAC (key usage `access`);
   - its WRPRC published as `issuer_info`.
2. **Issue a PID:**
   - The participant fills a form with the PID's values. The form says **synthetic data only** on
     every screen and refuses nothing it cannot recognise as real; we cannot tell, so we say it.
   - The sandbox makes a credential offer, by `SAME_DEVICE` link or QR.
   - The tester accepts it into the sandbox wallet.
   - The values are content: ephemeral, never stored (CLAUDE.md §5).
3. **Revoke or suspend an issued PID** (`AS-AP-07-007` `VCR_04`: no un-revocation, CLAUDE.md §6.7).
4. **Present it** to any sandbox Relying Party, including the participant's own. This closes the loop
   between the two v1 roles.

**What J8 cannot test in v1, said on the page.** The engine publishes no signed issuer metadata
(G-10), so the sandbox wallet needs WD-2. Under WD-2 the wallet does not apply its issuer
registration-certificate checks (CLAUDE.md §6.21). The three issuance-side WRPRC defects
(`AS-AP-44-005` `RPRC_22a`, `AS-AP-44-006` `RPRC_22b`, `AS-AP-44-007` `RPRC_23`) are therefore
offered **only as take-away certificates**, with this limitation stated, and never on the hosted
issuer as if they were tested. Decided at S0, D6; an ADR on signing the metadata in front of the
engine is S5 work (plan).

### J9 — Operator

- **Approve or refuse a brought-in PID anchor** (v1.1).
- **Suspend a participant.** Every certificate of the participant is revoked immediately — the
  sandbox's reading of `AS-MS-31-025`/`-026` (`RPACANot_06`/`RPACANot_07`) and of TS 119 411-8
  REV-6.3.9-02..04 — its engine tenants are disabled, and its PID anchor leaves the list.
- **Rotate a sandbox key.**
- **See** participants, quotas and the audit trail.

## 5. The defect catalogue

Each entry is a certificate variant the sandbox can issue. For each, the expected wallet behaviour is
the one **the cited requirement asks for**. Where Wallet Core 0.30.2 names a failure reason
(`RegistrationFailureReason`, read from the pinned classes), it is given, because it is what a tester
will see in a debug log.

**Column "RC check"** marks the defects a wallet looks at only when *Check Registration Certificates*
is on, which it is not by default. Every run report records the preference's position.

### 5.1 Access certificate (WRPAC)

| Id | Defect | Built how | Requirement | Combines |
|---|---|---|---|---|
| AC-00 | *Correct* | §7.1 profile | — | — |
| AC-01 | Unknown CA | Issued by the **untrusted** sandbox Access CA, not on the list | `RPA_04`; issuance `AS-AP-10-061` (`ISSU_34`) | no |
| AC-02 | Expired | `notAfter` in the past | `AS-WP-06-006` (`RPA_05`), `ISSU_34` | no |
| AC-03 | Not yet valid | `notBefore` in the future | as AC-02 | no |
| AC-04 | Revoked | Correct certificate, then on the CRL | **No HLR** — ARF §6.6.3.2 prose; `AS-MS-27-019` (`Reg_12`) obliges revocability | no |
| AC-05 | Missing `organizationIdentifier` | Subject without it | TS 119 411-8 GEN-6.6.1-05; WRPRC binding fails (see RC-06) | no |
| AC-06 | No `dNSName` for the verifier's host | SAN without it | OpenID4VP `x509_san_dns` client identifier — **no ARF identifier** | no |
| AC-07 | Wrong key usage | e.g. `keyCertSign` only | Profile point from EN 319 411-1 — **not read**; built only after S2 reads it | no |

AC-07 is listed so the catalogue is complete. It is **not offered** until its rule is read in
EN 319 411-1 and cited.

SCT defects (`AS-MS-55-005` `CT_05`, `CT_06`) are **out of v1**:
- the sandbox runs no Certificate Transparency log;
- TS 119 411-8 OVR-6.4.5-02 asks only for a description, "where relevant";
- every sandbox WRPAC carries no SCT, and the run report says so;
- a wallet enforcing `AS-MS-55-004` (`CT_04`) would refuse every sandbox certificate. The pinned one
  does not, as runs since September show; recorded in `interop-findings.md` at S2.

### 5.2 Registration certificate (WRPRC)

| Id | Defect | Built how | Requirement | Wallet Core reason | RC check |
|---|---|---|---|---|---|
| RC-00 | *Correct* | §7.2 profile | — | — | — |
| RC-01 | Absent | The hosted verifier sends no `verifier_info` | `EW-DM-44-019` (`RPRC_17`) | `CERTIFICATE_ABSENT` | yes |
| RC-02 | Malformed | Wrong `typ`, or a required claim removed | `RPRC_17` | `MALFORMED` | yes |
| RC-03 | Bad signature | Payload altered after signing | `RPRC_17` | `SIGNATURE_INVALID` | yes |
| RC-04 | Unknown provider | Signed by the **untrusted** sandbox registrar | `RPRC_02a` | `UNTRUSTED_PROVIDER` | yes |
| RC-05 | Expired | `exp` in the past | `RPRC_17` | `EXPIRED` | yes |
| RC-06 | Not bound to the WRPAC | `sub` differs from the WRPAC `organizationIdentifier` | `EW-DM-44-020` (`RPRC_17a`) | `NOT_BOUND_TO_REQUESTER` | yes |
| RC-07 | Revoked | Correct, then set on the status list | **No HLR** — ARF §6.6.2.3; TS 119 475 REV-6.2.6.2-04 | `REVOKED` | yes |
| RC-08 | Over-asking | Registers fewer claims than the policy requests (J5 step 2) | `EW-DM-44-027` (`RPRC_21`) | (over-asked claims list) | yes |
| RC-09 | No status | `status` claim removed | TS 119 475 GEN-6.2.6.1-04 | `STATUS_MISSING` | yes |
| RC-10 | Status list unreachable | `status.uri` points at a sandbox path answering `503` | TS 119 475 CSS-6.2.3.10-02 | `REVOCATION_STATUS_UNKNOWN` | yes |
| RC-11 | Wrong entitlement | A provider WRPRC without `PID_Provider`, used for issuance | **No HLR** — ARF §6.6.2.3 prose | `ENTITLEMENT_MISSING` | take-away only (J8) |
| RC-12 | Attestation type not registered | `provides_attestations` without the PID type | `RPRC_23` | (over-provided) | take-away only (J8) |
| RC-13 | Validity too long | `exp` more than 12 months after `iat` | TS 119 475 GEN-5.2.4-08 | — | yes |

RC-13 is a provider-side rule, not a wallet check. It is offered to test the participant's **own**
validator. The wallet's reaction is recorded, not predicted.

### 5.3 PID (PID Provider role)

| Id | Defect | Built how | Requirement |
|---|---|---|---|
| PID-00 | *Correct* | Signed under the sandbox PID CA | — |
| PID-01 | Signing certificate not on the PID list | Signed under the **untrusted** PID CA | `ISSU_07` |
| PID-02 | Signing certificate expired | Leaf `notAfter` in the past at issuance | `ISSU_07` |
| PID-03 | Revoked PID | Correct PID, then revoked on its status list | `AS-AP-07-007` (`VCR_04`) and the verifier's check |

### 5.4 What the sandbox can and cannot say about a defect

The sandbox controls the certificate, not the wallet. **A run report never says "the wallet
complied".** It says:
- which defect was built in;
- what the platform and the engine did;
- what the tester reports the wallet showed;
- and, when a debug build was used, the reason the wallet logged.

## 6. The run report

**One per flow on a hosted verifier or issuer.** Kept as derived result and audit evidence, never
content:
- the run id, time, role and flow;
- the service, the certificates used (fingerprints) and their variants;
- the wallet build declared by the tester: name, deviations, *Check Registration Certificates* on or
  off;
- the engine outcome, mapped to the platform's failure codes (never the engine's `status`, CLAUDE.md
  §6.5);
- the expected behaviour from §5 with its citation;
- **the tester's observation**: what the wallet showed, chosen from a short list plus free text.

The free text is the participant's own words. It may not contain credential values, and the form
says so.

## 7. Profiles

### 7.1 Access certificate (WRPAC)

**From the texts read:**

- **Policy:** `certificatePolicies`, critical false.
  - `0.4.0.194118.1.2` (NCP-l-eudiwrp) for a legal person, `0.4.0.194118.1.1` for a natural person
    (TS 119 411-8 §5.3, GEN-6.6.1-03).
  - Plus the sandbox's own policy OID, which marks the certificate as a sandbox `TEST` certificate.
    Its arc is allocated in S2.
  - `cpsURI` pointing at the sandbox's CPS page (GEN-6.6.1-06). That page states that the CPS is a
    test policy and that EN 319 411-1 NCP is **not** met.
- **Subject, legal person** (TS 119 475 Table 1; TS 119 411-8 GEN-6.6.1-05):
  - `CN` = trade name;
  - `O` = legal name, **prefixed `TEST ` in the sandbox**;
  - `C`;
  - `organizationIdentifier` (§6.1);
  - `OU` = the Service identifier, which also tells instances apart (GEN-6.6.1-08).
- **SAN:**
  - `uniformResourceIdentifier` (support website, GEN-6.6.1-07);
  - plus `dNSName` for each host a hosted or take-away verifier will serve from, because the pinned
    wallet uses `x509_san_dns`. The `dNSName` is the sandbox's choice; the texts read do not mention
    it.
- **No entitlements, no RP-identifier extension.** TS 119 475 Annex E Table E.1: the WRPAC
  "Includes Entitlements: No".
- **Validity:** 90 days by default, at most 1 year. **Key:** P-256.
- **Revocation:** a CRL distribution point per issuing CA (`AS-MS-27-019`, `Reg_12`). OCSP is out of
  v1.
- **Key usage `digitalSignature`, EKU `clientAuth`**, AKI, SKI, CRL distribution point, AIA
  `caIssuers`, and a qcStatements SemanticsInformation naming the sandbox register as the identifier's
  registration authority (Q-S1, Q-S2).

### 7.2 Registration certificate (WRPRC)

TS 119 475 V1.2.1 §5.2, matched against the claim names Wallet Core 0.30.2 deserialises
(`RegistrationCertificateDto`); the two agree on every name below.

- **Format:** JWT, compact JWS, JAdES B-B (GEN-5.2.1-04; TS 119 182-1 not read — the B-B header
  requirements are checked in S2).
  - Header: `typ` **`rc-wrp+jwt`** (GEN-5.2.2-01), `alg` `ES256`, `x5c` with the whole chain.
  - The CWT form (`rc-wrp+cwt`) is out of v1.
  - The platform's placeholder uses `rc+jwt` and no `x5c`. It is replaced, not extended.
- **All WRPRCs** (Table 7): `name`, `sub_ln`, `sub`, `country`, `registry_uri`, `srv_description`,
  `entitlements`, `privacy_policy`, `info_uri`, `support_uri`, `supervisory_authority`, `policy_id`
  (`["0.4.0.19475.3.1"]`, OVR-6.1.3-01), `certificate_policy`, `iat`, `exp`, `status`.
  - `sub` equals the WRPAC's `organizationIdentifier` — the binding Wallet Core checks, by
    `organizationIdentifier` or else `serialNumber`.
  - `supervisory_authority`: the sandbox names **no real authority**. It carries a sandbox
    placeholder marked `TEST`, because pointing a test certificate at a real DPA would be
    impersonation.
- **Service Provider** (Table 9): `credentials[]` (`format`, `meta`, `claim[].path`), `purpose[]`,
  `intended_use_id`.
- **Attestation provider** (Table 8): `provides_attestations[]`.
- **Status:** `"status": {"status_list": {"idx": <n>, "uri": "<sandbox status list>"}}`.
  - This is the IETF Token Status List shape of the Annex C example. Wallet Core reads
    `status.status_list.idx/uri`.
  - The text also describes `status` as a URI (Table 7) and as `{idx, uri}` (GEN-6.2.6.1-04). That
    inconsistency is recorded in `interop-findings.md` at S2, and the sandbox follows the example
    and the wallet.
- **Unique id** (GEN-6.2.6.1-03): required, but no claim name is defined. **Open question Q-S3.**

**Inconsistencies in TS 119 475 V1.2.1**, recorded at S2 in `interop-findings.md`:
- three shapes for `status`;
- `idx` a numeric string or an integer;
- `sname`/`name`/`act.sub` for the intermediary;
- claim `path` typed "string" but shown as an array;
- ISO 639 vs BCP 47 language tags;
- a dangling reference to "clause 6.3";
- an example requesting `age_over_18` from a PID, which the sandbox must not copy (CLAUDE.md §6.1).

### 7.3 Trust lists (LoTE)

TS 119 602 V1.1.1, Annexes D, F and G. One list per kind, each a compact JAdES-signed JSON LoTE:

| List | `LoTEType` | Service types |
|---|---|---|
| Sandbox PID Providers | `http://uri.etsi.org/19602/LoTEType/EUPIDProvidersList` | `…/SvcType/PID/Issuance`, `…/PID/Revocation` |
| Sandbox Access CAs | `…/LoTEType/EUWRPACProvidersList` | `…/SvcType/WRPAC/Issuance`, `…/WRPAC/Revocation` |
| Sandbox WRPRC providers | `…/LoTEType/EUWRPRCProvidersList` | `…/SvcType/WRPRC/Issuance`, `…/WRPRC/Revocation` |

**Rules:**
- `LoTESequenceNumber` starts at 1 and strictly increases (§6.3.2).
- `NextUpdate` is at most 6 months ahead. The sandbox uses **7 days** and re-signs daily, so a stale
  list is noticed.
- `SchemeOperatorName` is "EDTP Sandbox — TEST ONLY".
- The signer's `C` and `O` match the scheme information (§6.8).
- `ServiceStatus` is not used: being listed is the status.

**The `LoTEType` values are EU-list values.** The Annexes frame these lists as lists the European
Commission publishes. The sandbox uses the same values because the wallet selects lists by them, and
it states the reuse in the scheme information and on the portal. **This is imitation of a list type,
not of a publisher.** The operator name, the signer and the URLs are all the sandbox's.

**Signature:** compact JAdES B-B with protected header `{alg: ES256, typ, x5c, iat}` and no `sigT`
or `crit` (Q-S4, TS 119 182-1 V1.2.1 §5.1.11 and §5.2.1).

**Status lists** have at least 16 384 entries, so an index is hidden in a herd, and grow by doubling.

**The PID list carries** (the sign-in anchors from `SANDBOX_PKI_DIR/pid-sign-in-anchors/*.pem`):
- the sign-in anchor set: reference PID Providers and "PID (demo)", so a sandbox wallet can hold the
  PID it signs in with;
- the sandbox PID CA;
- in v1.1, approved brought-in anchors.

The Access CA and WRPRC lists carry the sandbox's trusted CAs only. They **never** carry the
untrusted ones.

## 8. Architecture

### 8.1 Modules

Consistent with ADR 0003 (modular monolith) and ADR 0002 (EUDIPLO wrapped behind ports).

| Module | Kind | Responsibility |
|---|---|---|
| `packages/sandbox-domain` | new package | Participant organisation, person, membership, invitation, session; sandbox CA, issued certificate, variant, status entry; trust-list publication; run report. Pure, no I/O |
| `packages/sandbox-pki` | new package | X.509 issuance (WRPAC, PID signing, CRL), WRPRC JWS signing, Token Status List, LoTE building and signing. Behind a `SandboxKeyStore` port, so keys can later move to an HSM |
| `packages/domain` | existing | Unchanged model of RP, Service, intended use, policies, attestation providers. The sandbox **fills** it: a sandbox organisation is a `Tenant` + `Organisation` + `RelyingParty` |
| `apps/platform-api` | existing | New routes under `/sandbox/v1`. Engine tenants created at runtime (§8.3) |
| `apps/sandbox-portal` | new app | The participants' portal, Express rendering HTML like the other apps; sign-in pages; the public pages for lists, CRLs, status lists, CPS and register |
| `tools/test-wallet` | existing | A `--profile sandbox` build option setting the four list URLs to the sandbox's |

The boundaries check (`scripts/check-boundaries.mjs`) gains rules:
- `sandbox-domain` imports nothing from the engine adapter;
- nothing outside `sandbox-pki` touches a private key.

### 8.2 Keys

- **The sandbox CAs' private keys are held by `sandbox-pki` behind its key-store port.**
  - In v1: files encrypted at rest under a key from the environment.
  - On a VM without an HSM this is a security limitation, listed in `docs/security-limitations.md`.
- **Hosted-certificate keys:**
  - generated in the platform and handed to the engine at import, as today (a JWK);
  - never stored by the platform.
- **Take-away certificates:** the participant's key never reaches the sandbox (CSR).

### 8.3 Engine tenants at runtime

Today engine credentials come from `ENGINE_TENANT_CREDENTIALS` in the environment, and a new tenant
needs an API restart (G-6). The sandbox creates engine tenants on demand:
- one per hosted verifier;
- one per hosted issuer.

So **engine credentials move to the database, encrypted at rest**, behind the same `EngineClient`. The
environment variable stays for the existing demonstrations.

Each tenant is still created with every role it will ever need (CLAUDE.md §6.18). Session config is
asserted minimal on creation (CLAUDE.md §5).

A quota per organisation bounds how many tenants it may create: **v1 — 3 hosted verifiers and 1
hosted issuer**.

### 8.4 Exposure

**The sandbox runs on a VM of its own (D7)**, built like the demonstration environment (ADR 0010):
- its own tunnel;
- the default-deny allow-list of `docs/test-session-gateway.md`, extended with the sandbox's public
  paths: portal, lists, CRLs, status lists, register read API, CPS;
- edge rate limits;
- scheduled negative checks, which prove the engine's `/api` is unreachable (CLAUDE.md §6.20).

**Every deployment is confirmed by the user first.** It needs its own ADR, numbered at the time.

## 9. API surface (v1)

All under `/sandbox/v1`, authenticated by session (portal) or organisation API key (automation). The
tenant is derived from the credential (CLAUDE.md §9). Request and response shapes are fixed in S2 in
`docs/openapi.json`.

| Area | Routes |
|---|---|
| Organisation | `GET/PATCH /organisation`, `GET/POST/DELETE /members`, `POST /invitations`, `GET/POST/DELETE /api-keys` |
| Services and uses | `GET/POST /services`, `GET/PATCH /services/{id}`, `GET/POST /services/{id}/intended-uses` |
| Certificates | `POST /services/{id}/access-certificates` (hosted or CSR, variant), `POST /services/{id}/registration-certificates` (intended use, variant), `GET …/{certId}`, `POST …/{certId}/revoke` |
| Hosted verifier | `POST /services/{id}/verifier` (certificates to use), `POST /services/{id}/verifier/policies`, `POST /services/{id}/verifier/presentations` |
| Hosted PID issuer | `POST /services/{id}/issuer` (certificates, display name), `POST /services/{id}/issuer/offers` (synthetic values → offer), `POST /services/{id}/issuer/credentials/{credId}/revoke` |
| Runs | `GET /runs`, `GET /runs/{id}`, `POST /runs/{id}/observation` |
| Operator | `GET /operator/organisations`, `POST /operator/organisations/{id}/suspend`, `POST /operator/anchors/{id}/approve` (v1.1) |

**Public, unauthenticated** (`EW-DM-31-003` `TLPub_04`):
- `/lote/{PID,WRPAC,WRPRC}Providers.jwt`;
- `/crl/{ca}.crl`, `/status/{list}`;
- `/cps`;
- the **TS5 register read API**, JWS-signed: `GET /wrp`, `GET /wrp/{identifier}`,
  `GET /wrp/{identifier}/services/{serviceIdentifier}`, `GET /wrp/check-intended-use` ([TS5] §3,
  Annex A.2).

The register's JWS carries the registrar's chain in `x5c`, where TS5 shows an `x-jku-url` response
header: the registrar's key is a certificate the WRPRC providers' list already anchors. Recorded as a
deliberate difference, decided in S3.

There is no write API at TS5 level: [TS5] §3.1.2 leaves registration "for further study", and the
sandbox's own routes above are its design.

## 10. Data classes and privacy

The five classes of CLAUDE.md §5 stay separate.

| Class | Sandbox data |
|---|---|
| Configuration | Organisations, services, intended uses, certificate records (public parts and fingerprints), variants, CA metadata, list publications |
| Transaction metadata | Presentations, issuances, offers, runs (ids, times, outcomes) |
| Content (ephemeral, no table) | PID values at sign-in; synthetic PID values typed for issuance; presentation payloads |
| Derived result | Run reports; the sign-in subject (an HMAC, ADR 0015) |
| Audit evidence | Sign-ins, membership and key changes, certificate issuance and revocation, list publications, operator actions |

- **Sign-in:** ADR 0015 Decision 4. No PID value is stored or logged.
- **Synthetic issuance values** are content, even when synthetic, because the platform cannot tell
  that they are synthetic. They are never persisted by the platform. The engine holds them for its
  bounded window, and the CLAUDE.md §5 sentence applies verbatim.
- **Certificates are public by nature** (they go into presentations and lists) and are stored. They
  contain the organisation's declared data, never a person's PID values.
  - **One exception:** a natural-person WRPAC (`0.4.0.194118.1.1`) would carry a person's name.
  - **v1 issues legal-person certificates only**, so the sandbox certifies no person.

## 11. Security

- **`TEST` everywhere:**
  - the sandbox refuses to start in a `PRODUCTION` trust environment;
  - every certificate it issues carries `TEST` in `O` and the sandbox policy OID;
  - its anchors never enter a `PRODUCTION` configuration (the edt-pid-connector ADR-008 rule, carried
    over).
- **Sign-in cannot be forged by a participant** (ADR 0015 Decision 2).
- **Isolation:**
  - the platform's own tenant isolation, with tests that one organisation cannot read, issue for,
    revoke or run another's;
  - one engine tenant per hosted instance.
- **Abuse:**
  - quotas on certificates (per service per day), on engine tenants and on offers;
  - rate limits at the edge and per API key;
  - CSR uploads size-limited and parsed strictly.
- **Lists change with participants.** Every publication is audited, sequence-numbered and kept;
  `AS-WP-31-014` (`TLPub_08`) asks for the full history.
- **Shared trust is stated** (S0 §6.3). A sandbox wallet trusts every participant's PIDs. A
  participant's own verifier policy can still restrict by trust anchor source.
- **The untrusted CAs** — Access CA, registrar and PID CA — sign only defective certificates, and
  appear on no list.

## 12. What may be said, and what may not

| May be said | Must not be said |
|---|---|
| "Tested against the EDTP sandbox wallet, a modified build of the EUDI Reference Implementation" | "Tested against the Reference Wallet", "works with EUDI wallets" |
| "The certificate follows our reading of ETSI TS 119 475 V1.2.1" | "ETSI-conformant", "ARF-conformant", "CIR 2025/848-compliant" |
| "The sandbox plays the registrar's role in a test domain" | "Registered", "certified", "notified" without "in the sandbox" |
| "The wallet showed X; Wallet Core logged Y" | "The wallet complies with `RPRC_21`" |
| "The issuance-side registration checks are not exercised (G-10)" | Anything implying that `RPRC_22a`/`RPRC_23` were tested on the hosted issuer |

## 13. Open questions

| # | Question | Where it is settled |
|---|---|---|
| Q-S1 | **Closed 12 Nov 2026.** EN 319 412-1 V1.7.1 LEG-5.1.4-03 item 7 allows a *locally defined* type reference: two characters and `:`. With it, LEG-5.1.4-05 requires `nameRegistrationAuthorities` with a URI in the SemanticsInformation (qcStatements, `id-qcs-pkixQCSyntax-v2`, semantics `0.4.0.194121.1.2`). The sandbox uses **`SB:<CC>-<n>`**, e.g. `SB:ES-000001`, with the URI of the sandbox register. It cannot be read as a VAT, NTR or LEI number. **Interpretation, recorded as such:** item 7 frames the form as a national scheme. **Always this form**, even when the organisation declares an EUID: the sandbox does not verify a declared EUID, so a certificate must not carry one (ADR 0015 Decision 6) | §7.1 |
| Q-S2 | **Closed 12 Nov 2026.** EN 319 411-1 V1.5.1 GEN-6.6.1-02 delegates to EN 319 412-3. Its rules: KeyUsage present with one setting, preferably non-mixed (NAT-4.3.2-1, applied by LEG-4.3.1-2); **`digitalSignature` only** for RP authentication. LEG-4.3.1-3 would force `nonRepudiation` only for signatures that evidence the origin of *content*, an interpretation recorded. EKU not critical, no value mandated (GEN-4.3.10-1), so `clientAuth` stays as the wallet accepts it. AKI (GEN-4.3.1-1), `certificatePolicies` (GEN-4.3.3-2), CRL DP (GEN-4.3.11-1) and AIA `caIssuers` (GEN-4.4.1-2) are present. CRL: RFC 5280 (OVR-6.6.2-01), published at least every 24 h (CSS-6.3.9-05), status kept until expiry (CSS-6.3.10-04), no reinstatement after revocation (REV-6.3.9-04). The KeyUsage table's columns did not survive text extraction, so the A–F mapping is unverified | §7.1 |
| Q-S3 | Claim name of the WRPRC unique id (GEN-6.2.6.1-03 names none) | S2; record in `interop-findings.md` |
| Q-S4 | **Closed 12 Nov 2026.** TS 119 182-1 V1.2.1 (the version TS 119 602 cites) §5.2.1: from 2025-07-15 `sigT` *shall not* be incorporated, and §5.1.11 makes `iat` mandatory. §5.1.9: no `crit` is needed without `sigD`. The lists' compact B-B header is `{alg, typ, x5c, iat}`, which also removes the engine's `crit: sigT` problem (A30) for sandbox lists | §7.3 |
| Q-S5 | **Closed 12 Nov 2026, from the source:** no. Wallet Core v0.30.2 binds by entity identifier only (`docs/interop-findings.md` C15). RC-06 changes the entity identifier, which it does check | — |
| Q-S6 | **Decided by the user, 12 Nov 2026: a DER encoder of our own** over `node:crypto`, no new dependency (`packages/sandbox-pki/src/der.ts`). Tested against Node's `X509Certificate` and `openssl` | — |
| Q-S7 | **Decided by the user, 12 Nov 2026: `2.25.122722476230885567871422612338706645671`** (ITU-T X.667, from UUID `5c537d3b-0c20-4d92-9b1f-81c674ea82a7`). It is replaceable by a private-enterprise arc later | §7.1 |
