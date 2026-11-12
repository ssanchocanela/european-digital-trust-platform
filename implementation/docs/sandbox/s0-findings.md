# EUDI ecosystem sandbox — S0 findings

Written 12 November 2026. Phase **S0** of the sandbox: investigation only, no product code. It ends
with a **STOP**: the decisions in §8 are the user's, and S1 (the specification) starts from them.

Scope agreed with the user on 12 November 2026: the sandbox lives **in this repository**, and its
first version covers two roles — **Relying Party** and **PID Provider**. Attestation providers
(QEAA, PuB-EAA, non-qualified EAA) and the Wallet Provider come later.

Every rule of [`CLAUDE.md`](../../CLAUDE.md) applies. In particular: `TEST` only, never a
conformance or production-readiness claim, and no simulated success (§8).

Pins used below:
- **[HLR]** — `hltr/high-level-requirements.csv`, ARF `v3.0.0` @ `c64f2cbb19aee37c571c58af66d359c4d5be29c8`;
- **[ARF]** — the main document, same commit;
- **[TSn]** — `eudi-doc-standards-and-technical-specifications` @ `ee91a294c833af5188726fd8c302c641212192aa`
  (TS5 1.5, TS6 1.2.2, TS2 1.0.1).

Every HLR identifier cited here was checked against the register on 12 November 2026.

---

## 1. What the sandbox is, in one paragraph

An organisation signs up by presenting a PID. Inside the sandbox it gets what a Member State's
ecosystem would give it:
- a registration;
- access certificates (WRPAC) and registration certificates (WRPRC) from **the sandbox's own `TEST`
  Access CA and registrar** — correct ones and deliberately defective ones;
- a hosted verifier or a hosted PID issuer configured with those certificates;
- an EDTP test wallet that trusts the sandbox's trust lists.

It can then run real flows, and see what a wallet does with each defect.

**The sandbox plays the Member State's roles in a test domain:** Registrar, Access CA, provider of
registration certificates, and the trust-list notification and publication system. It does not
imitate any real Member State or Commission service, and it never chains to a notified anchor.

## 2. The decisive constraint: no unmodified wallet will trust the sandbox

| Gate | What blocks an official wallet build | HLR |
|---|---|---|
| Access certificates | Only anchors from the notified Access CA LoTEs are accepted | `AS-WP-06-005` (`RPA_04`); issuance: `AS-AP-10-061` (`ISSU_34`) |
| Registration certificates | Only anchors from the notified WRPRC-provider LoTE are accepted | `EW-DM-44-005` (`RPRC_02a`) |
| PID signature | Validated against the PID Provider LoTE | `AS-AP-10-007` (`ISSU_07`) |

So the sandbox is usable **only with the EDTP test wallet**, pointed at the sandbox's lists. That
wallet already exists:
- WD-3: Access CA list;
- WD-4: PID Provider list;
- WD-8: WRPRC-provider list;
- WD-9: PuB-EAA list;
- all in [`tools/test-wallet/deviations.md`](../../tools/test-wallet/deviations.md).

Every result therefore says **"modified wallet"** (CLAUDE.md §6.22, §8). The sandbox would turn that
limitation into a stated property of the product, not a blocker to work around.

The reference ecosystem offers no alternative. Path A at the reference RP Registration Service is
blocked by a defect in that service (`docs/interop-findings.md` C10): no certificate can be obtained
there at all.

**Consequence for participants who bring their own wallet:** a third-party wallet trusts the sandbox
only if it can be configured with the sandbox's LoTE URLs. That is the Wallet Provider role, out of
scope for v1. Record it in the S1 specification as a known limitation.

## 3. What exists and can be reused

### 3.1 In this repository

| Need | What exists | State |
|---|---|---|
| Organisation / RP / Service / intended use / certificates model | `packages/domain/src/kernel/registration.ts`, modelled on TS5 | **Reusable.** `RelyingParty.registrarAssignedIdentifier` is assumed to come from an external registrar; in the sandbox the sandbox *is* the registrar |
| Verifier per Service | `RelyingPartyInstance` → one engine tenant (ADR 0002 D3), presentation policies, compiler, subset check, results, webhooks | **Reusable as is** |
| PID issuer | `AttestationProvider` + `CredentialType` + `IssuancePolicy`, `setup-test-pid-issuer.sh`, `apps/pid-form` (wallet-initiated, hosted form) | **Reusable.** Only `dc+sd-jwt` is issued; the adapter can build `mso_mdoc` but no mdoc PID has been configured |
| Access CA | `scripts/make-dev-access-ca.sh` (P-256 root, 90-day leaf, EKU clientAuth, SAN DNS) | **Script only, and incomplete**: no ETSI TS 119 411-8 / 119 475 content (no organisation identifier, Service identifier or trade names — `Reg_31`–`Reg_35`), no revocation, no SCT |
| Registration certificate | `scripts/make-test-registration-certificate.mjs` | **A placeholder.** Self-signed, no `x5c` (`EW-DM-44-004` `RPRC_02`), `typ: rc+jwt`, shaped for what EUDIPLO checks. Not TS 119 475 |
| Trust lists | `scripts/make-test-lote.mjs` (TS 119 602 JWS, PID / WRPAC / EAA kinds), published on `gh-pages` | **Reusable builder.** No WRPRC-provider, registrar or wallet-provider list of our own. Lists are built by hand, not on change |
| Importing keys and certificates into the engine | `POST …/instance`, `POST …/attestation-providers/{id}/provision`, `POST …/registration-certificates` | **Reusable**; the private key travels as a JWK and is kept only as an engine reference |
| Multi-tenancy | One API key per tenant, tenant derived from the credential, cross-tenant tests | **Reusable for machine access.** There are **no users, no roles, no human sign-in** |
| Public exposure | Default-deny gateway allow-list, the permanent demonstration VM (ADR 0010), Cloudflare Access | **Reusable.** Every deployment to the VM is confirmed by the user first |
| UI | Express 5 apps rendering HTML strings; no front-end framework | Consistent with the repository. A sandbox portal is a new `apps/` member |

### 3.2 In `edt-pid-connector` (a separate Kotlin project of the user's)

The connector **validates** certificates and **never issues** them. Worth porting to TypeScript:

- **WRPRC parser and compliance guard** (`backend/connector-oid4vp/.../Wrprc.kt`):
  - `typ: rc-wrp+jwt`, ES256, `x5c`;
  - the over-asking rules as Wallet Core 0.30.2 applies them (spec-delta D-22);
  - small and pure, so a direct port is realistic.
- **WRPAC validator** (`AccessCertificateLifecycle.kt`): seven named checks. A good baseline for
  "what a defective certificate should fail".
- **LoTE verifier** (`Lote.kt`): pinned signer, `LoTEType`, `NextUpdate`, sequence number, fail
  closed.
- **Design only**:
  - the TEST/PRODUCTION split of its ADR-008 (a sandbox catalogue refused at start-up in a
    PRODUCTION deployment);
  - the PID-based OpenID Provider of its ADR-009/013 (pseudonymous, per-client `sub` by HMAC).

**Caveat:** its WRPRC claim names are those **Wallet Core reads**, not checked against the ETSI
TS 119 475 V1.2.1 text (its D-22, still open). The EDTP placeholder uses `rc+jwt`. **Which `typ`
and claims are right is an S1 question, answered from the ETSI text and Wallet Core source** —
not by picking one of the two.

## 4. What the specifications say the sandbox must model

### 4.1 Its own registrar side (Topic 27)

| Duty | HLR |
|---|---|
| Register PID Providers and Relying Parties | `AS-MS-27-001` (`Reg_01`) |
| Remote registration by API or UI | `AS-MS-27-035` (`Reg_24`) |
| Identify the RP at a level proportionate to risk | `AS-MS-27-036` (`Reg_25`) |
| Approve a PID Provider under a defined policy before listing it | `AS-MS-27-026` (`Reg_19`) |
| Publish the register, signed and machine-readable, through the TS5 API | `Reg_03` (`AS-MS-27-005`), `Reg_06` (`AS-MS-27-008`) |

For the API: [TS5] §3 and Annex A.2 define the **read** API (`GET /wrp`, `/wrp/{id}`,
`/wrp/check-intended-use`). The **write** API is not harmonised ([TS5] §3.1.2), so the sandbox's
write API is its own design.

### 4.2 Its own Access CA

| Rule | HLR |
|---|---|
| Certificates for every registered entity | `AS-MS-27-012` (`Reg_10`) |
| At least one per Service | `AS-MS-27-013` (`Reg_10a`) |
| Chain delivered up to the anchor | `AS-MS-27-014` (`Reg_10b`) |
| ETSI TS 119 411-8 | `AS-MS-27-018` (`Reg_11`) |
| Revocable when validity exceeds 24 h | `Reg_12` (`AS-MS-27-019`) |
| Trade name, EU-wide identifier, Service identifier and Service trade name, identical to the WRPRC | `AS-MS-27-042`–`-048` (`Reg_31`–`Reg_35`) |
| An SCT in each certificate | `AS-MS-55-004` (`CT_04`) |

**No TS at the pin profiles the WRPAC** (extensions, policy OIDs, SAN, entitlement encoding). The
profile is ETSI TS 119 411-8 / 119 475. Neither is in the repositories read; they must be read at the
version TS6 cites (119 475 **V1.2.1**) before S1 states the profile.

### 4.3 Its own WRPRC provider (Topic 44)

| Rule | HLR |
|---|---|
| ETSI TS 119 475 | `EW-DM-44-001` (`RPRC_01`) |
| `x5c` | `EW-DM-44-004` (`RPRC_02`) |
| One certificate per intended use × Service | `EW-DM-44-014` (`RPRC_09`) |
| No intended use for a provider | `EW-DM-44-009` (`RPRC_05`) |
| Identifiers equal to the WRPAC's | `EW-DM-44-010`–`-013` |
| A provider registers the attestation types it issues | `AS-AP-44-003` (`RPRC_15`) |

Entitlements are [TS6] §2 row 12 (CIR 2025/848 Annex I). Use the URIs of [TS5] §2.4.1,
`https://uri.etsi.org/19475/Entitlement/<name>`: v1 needs `Service_Provider` and `PID_Provider`.
The `data.europa.eu` form in the [TS5] §3.2.2 example contradicts §2.4.1, a baseline inconsistency
for `interop-findings.md`.

### 4.4 Its own trust lists (Topic 31)

| List | HLR |
|---|---|
| PID Provider LoTE (TS 119 602 Annex D) | `AS-MS-31-012` (`PPNot_07`) |
| Access CA LoTE (Annex F) | `AS-MS-31-023` (`RPACANot_05`) |
| WRPRC-provider LoTE (Annex G) | `AS-MS-31-024` (`RPACANot_05a`) |
| Retrieval without authentication | `EW-DM-31-003` (`TLPub_04`) |

A notification API to imitate exists in [TS2] §3.3.

### 4.5 The defect catalogue: what a wallet is required to check

This is the raw material for "certificates with different casuistics". Each defect is one the
specifications make a wallet check. A defect with no HLR is marked as such and is not presented as
a requirement.

| Defect the sandbox can produce | The check, at presentation / at issuance |
|---|---|
| WRPAC from a CA not on the Access CA list | `RPA_04` / `ISSU_34` |
| WRPAC expired or not yet valid | `AS-WP-06-006` (`RPA_05`) / `ISSU_34` |
| WRPAC revoked, or revocation information stale | **No HLR** — [ARF] §6.6.3.2 prose; `Reg_12` obliges revocability |
| No SCT, or an invalid one | `AS-MS-55-005` (`CT_05`), `CT_06` |
| Request or metadata not signed with the WRPAC key | `RPA_01`; issuance `ISSU_22` / `ISSU_32` |
| WRPRC absent, malformed, bad signature, unknown provider, expired | `EW-DM-44-019` (`RPRC_17`), `RPRC_02a` / `AS-AP-44-005` (`RPRC_22a`) — **blocking at issuance** |
| WRPRC revoked | **No HLR** — [ARF] §6.6.2.3 prose |
| WRPRC identifiers differ from the WRPAC's | `EW-DM-44-020` (`RPRC_17a`) / `AS-AP-44-006` (`RPRC_22b`) |
| Attributes requested beyond those registered | `EW-DM-44-027` (`RPRC_21`) |
| Attestation type not in the provider's WRPRC | `AS-AP-44-007` (`RPRC_23`) |
| Entitlement wrong for the action (a Service Provider issuing) | **No HLR** — [ARF] §6.6.2.3 prose |
| Trade names differing between WRPAC and WRPRC | `Reg_31`, `RPRC_06` (issuer-side rules, not wallet checks) |
| SAN not matching the `client_id` | **No ARF identifier** — OpenID4VP / HAIP `x509_san_dns` / `x509_hash` |
| PID not verifiable against the PID Provider list | `ISSU_07` |

**What the sandbox can honestly report about each defect.** The sandbox controls the certificate,
not the wallet. For each run it can report:
- the defect it built in;
- what the platform and the engine did with it;
- what the participant reports the wallet showed.

**It cannot report whether the wallet complied.** And the modified wallet's own deviations change
the answer:
- *Check Registration Certificates* is **off by default** (one runtime preference for both
  directions, `docs/milestone-2-issuer-trust.md`);
- **WD-2** switches off the issuer registration check whatever that preference says (CLAUDE.md
  §6.21).

So every result names the wallet build, its deviations and the preference's position.

## 5. Gaps that are new work

| # | Gap | Why it matters |
|---|---|---|
| G-1 | **Human sign-in and users.** The platform has API keys per tenant, no people, no roles | Self-service sign-up by PID needs users, sessions, an entity–user link and at least an owner / member role |
| G-2 | **Sign-up by PID.** Nothing authenticates a platform user by PID. The pieces exist: the hosted verifier, an "Identify with PID" policy | See §6.1 — which PIDs to trust for sign-up is a security decision, not a detail |
| G-3 | **A certificate-issuing service.** Access CA and WRPRC provider as code behind an API, with profiles, revocation and the defect catalogue | The core of the sandbox. Today: two scripts, one of them a placeholder |
| G-4 | **CRL/OCSP and status for issued certificates** | Revocation is half the defect catalogue (`Reg_12`, `RPRC_01a`) |
| G-5 | **Trust lists rebuilt and re-signed on change**, served by the sandbox; plus a WRPRC-provider list of our own | Today a list is built by hand and pushed to `gh-pages` |
| G-6 | **Engine tenants created at runtime.** `create-engine-tenant.sh` writes `.env` and the API needs a restart (`ENGINE_TENANT_CREDENTIALS`, `apps/platform-api/src/config.ts`) | A self-service entity cannot wait for an operator to edit `.env` |
| G-7 | **The TS5 register read API**, signed | `Reg_03` / `Reg_06`; also what lets a participant test their own lookups |
| G-8 | **Bring-your-own certificate testing.** A participant uploads a certificate made elsewhere and runs it through the hosted verifier or issuer | The user's "probar los suyos". Constraint: only certificates under an anchor the test wallet trusts can succeed (§6.2) |
| G-9 | **mdoc PID** | Only SD-JWT VC is issued today |
| G-10 | **Signed issuer metadata** (gate (a), G1/G8) | Without it a hosted PID issuer needs WD-2, and `RPRC_22a` / `RPRC_23` cannot be exercised (CLAUDE.md §6.21) — exactly the issuance-side defects a PID Provider would want to test |

**G-10 is the blocker for the PID Provider role.** EUDIPLO 7.6.0 produces no `signed_metadata`. So the
issuance-side registration defects (`RPRC_22a`, `RPRC_22b`, `RPRC_23`) are **untestable** against the
pinned engine. Three ways forward, for S1:

1. Wait for an upstream change. The batch-issuance contribution shows the route, but nothing exists
   for signed metadata yet.
2. Sign the metadata in a platform component in front of the engine. That is a gateway rewriting a
   protocol document, so it needs its own ADR.
3. Ship v1's PID Provider role without the issuance-side registration checks, and say so plainly.

## 6. Security findings that shape the design

### 6.1 A participant's PID Provider must not be able to sign anyone into the sandbox

This is the most important finding of S0.
- A participant acting as PID Provider gets its signing anchor onto the **sandbox PID list**,
  because that is how the test wallet comes to accept its PIDs.
- If sign-up verifies PIDs against that same list, any participant can mint a PID for any name and
  **sign up, or sign in, as someone else**.

**So the sign-up verifier trusts a fixed, operator-controlled set of PID anchors**, separate from the
list participants are added to. The candidates:
- the seven reference anchors;
- our own "PID (demo)" issuer.

Recommended in §8, D3.

### 6.2 Defective certificates are only useful under a trusted anchor

A certificate from an unknown CA is one defect among many. Every *other* defect (expired, revoked,
wrong identifier, over-asking) must chain to an anchor the test wallet trusts. Otherwise the wallet
stops at the first check and the defect under test is never reached.

So the sandbox Access CA and WRPRC provider issue the defective certificates **under the trusted
anchor**, from issuing CAs dedicated to the purpose. A separate, deliberately untrusted CA produces
only the "unknown CA" case.

### 6.3 Shared lists mean shared trust

Every participant's PID Provider anchor sits on **one** PID list, because the wallet reads one URL.
So a test wallet that trusts the sandbox trusts **every** participant's PIDs, for every participant's
verifier. In a test domain that is acceptable, but it must be stated. It also means:
- a participant cannot, in v1, test "my verifier refuses a PID from a provider I do not trust" by
  list alone;
- the hosted verifier policy's own trust-anchor selection can still express it.

### 6.4 Anything signed by the sandbox is a test artefact

- Every sandbox certificate carries a **`TEST`** marker in its subject.
- The sandbox's anchors are never placed in a `PRODUCTION` configuration.
- The ADR-008 rule from the connector carries over: a deployment refuses to start with the sandbox
  in a `PRODUCTION` trust environment.
- **CA keys:**
  - the demonstration VM has no HSM, so the CA private keys are a security limitation to list in
    `docs/security-limitations.md`;
  - a leaked sandbox CA key compromises only the sandbox domain — which is the point of having one.

### 6.5 Privacy at sign-up

A sign-up PID presentation is the platform acting as Relying Party Instance for itself.
`AS-RP-01-002` (`OIA_16`) applies: unique elements are discarded and not communicated.

What the sandbox keeps of the person is an S1 decision:
- **Recommended:** a pseudonymous subject (an HMAC over stable PID attributes, as the connector's
  ADR-013 does), plus a display name the person confirms.
- **Never** the raw PID.

`docs/interop-findings.md` C11 is a warning for the subject's basis: the reference registry's
`hash_pid` identifies the wallet installation, not the person, and a re-installed wallet would lock
a person out. That is a choice to make knowingly.

### 6.6 PID proves a person, not an organisation

A PID identifies a natural person. It says nothing about authority to act for an organisation
(`Reg_25` asks for identification proportionate to risk).

In a `TEST` sandbox the organisation can be **self-declared** by the person who signed up, marked as
unverified on every certificate and register entry. Verifying representation (an EUID lookup, a
power-of-representation attestation) is future work — and it is exactly what a later attestation
role in this same sandbox could provide.

## 7. Where it would run

- **Publicly reachable, because others sign up.** That means the permanent demonstration
  environment (ADR 0010) or a sibling of it, behind the same default-deny allow-list, with:
  - new public paths for the portal, the register read API, CRL/OCSP and the lists;
  - the engine's Management API never exposed (CLAUDE.md §6.20).
- **Every deployment is confirmed by the user first.**
- The test wallet APK is offered behind Cloudflare Access, per CLAUDE.md §6.22, never publicly.

## 8. Decisions for the user (input to S1)

| # | Decision | Recommendation |
|---|---|---|
| **D1** | **The sandbox's trust domain.** New, separate lists (sandbox Access CA, WRPRC provider, PID Provider), or the existing EDTP TEST lists extended? | **Separate lists.** The existing ones carry the seven reference anchors forward and serve the running demonstrations. A sandbox list changes with every participant and must not disturb those demonstrations. A test wallet build reads one or the other |
| **D2** | **PID Provider signing.** Does the sandbox issue the participant's PID signing certificate under a sandbox PID CA, does the participant bring its own CA to be listed, or both? | **Both, sandbox-issued first.** Bring-your-own is what "probar los suyos" means, but it needs the anchor-approval step of `Reg_19` |
| **D3** | **Which PIDs are accepted for sign-up** (§6.1) | **A fixed operator-controlled set** — the reference PID Providers and "PID (demo)" — **never** the participants' list |
| **D4** | **What is kept of the person** (§6.5) | A pseudonymous subject plus a confirmed display name; nothing else from the PID |
| **D5** | **People and machines.** Human users with roles (owner / member) signing in by PID for the portal, plus API keys per entity for automation | **Yes, both.** The portal is the product; the API is what lets a participant script its tests |
| **D6** | **Signed issuer metadata** (G-10): wait, sign in front of the engine, or ship the PID Provider role without the issuance-side registration checks | **Ship without them in v1, said plainly.** Open an ADR on signing in front of the engine as S2 work |
| **D7** | **Where it runs.** On the demonstration VM beside the demos, or on a VM of its own | **A VM of its own**, same pattern (ADR 0010). The sandbox resets and changes far more often than a demonstration may |
| **D8** | **The certificate profile source.** Reading ETSI TS 119 475 V1.2.1 and TS 119 411-8 is required before S1 can state the WRPAC and WRPRC profiles. Can the user provide the texts, or should S1 work from the ETSI public downloads? | ETSI deliverables are public downloads; S1 fetches them, pins them by version and date, and cites clauses |

## 9. What S1 would produce, once D1–D8 are answered

- `docs/sandbox/specification.md` — actors, user journeys for RP and PID Provider, the defect
  catalogue as a test matrix (defect → how it is built → HLR → what is reported), the API surface,
  data classes, and what is explicitly out of v1.
- An ADR on the sandbox trust domain and its CAs (D1, D2, §6.2).
- An ADR on human sign-in by PID (D3, D4, D5, §6.1).
- The WRPAC and WRPRC profiles, from the ETSI texts (D8), reconciled with what Wallet Core 0.30.2
  actually parses.
- A milestone plan with checkpoints.

**Nothing in S0 is product code.** This document is the only deliverable.

## 10. Checkpoint outcome

**12 November 2026: the user accepted every recommendation of §8, D1–D8, as written.** S1 starts
from them.

ADR numbers: 0013 is held by PR #25 (renumbering pending), so the sandbox ADRs take **0014** onwards.
