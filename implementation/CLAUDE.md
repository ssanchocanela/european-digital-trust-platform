# CLAUDE.md — European Digital Trust Platform V0 (`implementation/`)

Rules that must hold in every session working under `implementation/`. Derived from the V0
implementation prompt and from [Phase 0](docs/phase-0-findings.md). If a rule here conflicts with a
later instruction, raise the conflict rather than silently resolving it.

Everything — code, documentation, comments, commit messages, PR descriptions — is in **English**.

---

## 1. Scope

Work only inside this repository. EUDIPLO, the EUDI Reference Implementation and the ARF are read for
investigation only: **never forked, never modified**.

Three phases with human checkpoints. Do not skip a checkpoint.

| Phase | Branch | Ends with |
|---|---|---|
| Phase 0 — investigation, no product code | `implementation/platform-v0` | **STOP**, summary, await approval ← *complete* |
| Milestone 1 — foundations + Verification as a Service | `implementation/platform-v0` | PR 1, then **STOP** |
| Milestone 2 — Issuance as a Service | `implementation/platform-v0-issuance` (from M1) | PR 2 |

Commit in small, reviewable steps. **Never commit secrets** — only `.env.example`.

The repository root also contains an untracked `sources/` tree of PDFs, `.docx` and `.msg` files,
including internal national comitology material. **Never commit it.** It is covered by `.gitignore`.

---

## 2. Normative baseline and order of precedence

1. Regulation (EU) No 910/2014 as amended by Regulation (EU) 2024/1183, and the Commission
   Implementing Regulations referenced by ARF 3.0.0 — including CIR 2025/848 (registration of
   wallet-relying parties), CIR 2024/2982 (protocols and interfaces) and CIR 2024/2977 (PID and EAA),
   plus the amending acts. Phase 0 additionally found **CIR 2026/1730** and **CIR 2026/1731** in
   scope, and HLRs that cite "the amended CIR 2024/2979" and "the amended CIR 2024/2982".
2. **ARF v3.0.0**, main document and annexes, including the high-level requirements.
3. The Technical Specifications. **TS1–TS14** — there are fourteen, not twelve.
4. Standards referenced by the ARF/TS, at the versions they reference: OpenID4VP, OpenID4VCI, HAIP,
   SD-JWT VC, ISO/IEC 18013-5, IETF Token Status List, ETSI TS 119 612 (Trusted Lists), ETSI
   TS 119 602 (LoTEs), ETSI TS 119 475, ETSI TS 119 411-8, ETSI TS 119 472-1/-2/-3.

**Non-normative:** ARF Discussion Topics, roadmaps and issues. **TS4, TS13 and TS14** (zero-knowledge
proofs) are exploratory — do not build on them. EUDIPLO documentation describes an implementation.
Reference Implementation behaviour is interoperability evidence, not specification. Other repository
material (European Business Wallet working document, DPP Registry guide, national architectures) is
context only.

### Pinned revisions — cite these, not "ARF 3.0.0 / TSn"

The TS and attestation-rulebook repositories are **not tagged**, so a version number alone does not
identify content. Always cite *(HLR identifier | document + internal version | commit SHA)*.

| Source | Pin |
|---|---|
| ARF | tag `v3.0.0`, commit `c64f2cbb19aee37c571c58af66d359c4d5be29c8` |
| ARF HLR register | `hltr/high-level-requirements.csv` at that commit — **the authority for HLR identifiers** |
| Technical Specifications | `eudi-doc-standards-and-technical-specifications` `main` @ `ee91a294c833af5188726fd8c302c641212192aa` (2026-08-22) |
| TS5 | internal version **1.5**, 20.08.2026 |
| PID Rulebook | `eudi-doc-attestation-rulebooks-catalog` @ `36f8adcf914ac06cac18d685add04e0a8a06d685`, document version **1.1** |
| EUDIPLO | `v7.6.0`, commit `3b2a9e7163059db13019bdd1862240cbecb86201` |
| EUDIPLO image | `ghcr.io/openwallet-foundation/eudiplo:7.6.0` @ `sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667` |
| Reference Wallet | Android `Wallet/Demo_Version=2026.09.42-Demo_Build=42` |

### The three non-negotiable citation rules

1. **Terminology similarity does not prove conformance.** Any conformance statement cites a concrete
   ARF section, HLR identifier or TS section, and the version.
2. **Never invent a requirement identifier.** Verify it against the HLR register. If you cannot locate
   the exact identifier, cite the section and record an open question.
3. **Never claim production readiness or ARF/TS conformance.** Not in code comments, not in
   documentation, not in a PR description.

---

## 3. Implementation principles

1. **The platform owns the product model.** Customer-facing APIs never expose EUDIPLO contracts,
   identifiers or configuration objects.
2. **EUDIPLO is a replaceable, wrapped engine.** All interaction goes through platform-owned ports:
   `EudiVerifierPort` → `EudiploVerifierAdapter`, `EudiIssuerPort` → `EudiploIssuerAdapter`.
3. **Business API ≠ EUDI protocol API.** Customers work with `PresentationPolicy`,
   `PresentationTransaction`, `VerificationResult`, `CredentialType`, `IssuancePolicy`,
   `IssuanceTransaction` — never DCQL, OpenID4VP/OpenID4VCI sessions, credential offers or EUDIPLO
   configs. DCQL is produced **only inside the adapter**.
4. **Data minimisation at the source, not only at the output** — but see §6, where the baseline forces
   result-boundary minimisation for age.
5. **Privacy by design.** Presentation and issuance content is processed ephemerally, never logged,
   purged automatically.
6. **Versioned, immutable configuration.** Published policy versions are immutable; every transaction
   snapshots or references the exact version used.
7. **Don't over-engineer V0.** Modular monolith; bounded contexts are modules, not services.
8. **Don't fake integration.** See §8.

---

## 4. Recording divergences — never edit silently

- EUDIPLO or the Reference Wallet behaving differently from ARF/TS → record in
  [`docs/interop-findings.md`](docs/interop-findings.md). **Do not bend the platform domain model to
  match an implementation quirk.**
- An implementation decision conflicting with an existing knowledge page → record in
  [`docs/knowledge-alignment.md`](docs/knowledge-alignment.md) and propose the change.
  **Do not edit the page.** Do not restructure the knowledge documentation.

The six verification-side knowledge pages the prompt referenced **do not exist**
(`verification-operating-models.md`, `presentation-policy.md`, `verifier-product-model.md`,
`presentation-privacy-and-retention.md`, `verification-service-architecture.md`,
`verification-mvp.md`). Creating them is a separate, reviewable knowledge-base change — not an
implementation deliverable. See `knowledge-alignment.md` KA-1.

---

## 5. Privacy — the hard rules

**Never persisted by default:** VP tokens, complete credentials, SD-JWTs, mdocs, raw PID, raw
presentation payloads, attribute values used for issuance.

The citable basis is **`AS-RP-01-002` (`OIA_16`)**: a Relying Party Instance SHALL discard the values
of all unique elements — per `AS-AP-10-064` (`ISSU_35`): per-attribute salts, attribute hash values,
the revocation index, the device-binding public key, the provider signature value — and all
timestamps, as soon as they are no longer needed, and **SHALL NOT communicate these values to the
Relying Party or to any other party**. In the V0 hosted profile the platform *is* the Relying Party
Instance. So `OIA_16` binds us, and it constrains the **customer-facing result**, not only storage.

Also: `AS-RP-03-01` (`PID_03a`) restricts retaining the PID `portrait` and forbids third-country
transfer unless permitted.

Keep these five data classes separate in code **and** in storage: configuration, transaction metadata,
content (ephemeral), derived result, audit evidence. Content has **no table**.

**EUDIPLO does persist content by default** — `SessionEntity.credentials` (disclosed payloads) and
`credentialPayload` (inline issuance claims), for `SESSION_TTL`, default 86400 s, cleanup `full`,
hourly tidy-up. Every `RelyingPartyInstance` provisioning must call `PUT /session-config` and assert
minimal `ttlSeconds` (floor 60) with `cleanupMode: "anonymize"`, keep `LOG_SESSION_STORE=off` and
`LOG_ENABLE_HTTP_LOGGER=false`, never set `LOG_REDACT_SENSITIVE_DATA=false`, and set the audit-log
retention variables explicitly.

**The only honest claim**, to be used verbatim in `privacy.md` and PR descriptions:

> The platform never persists presentation or issuance content. The wrapped engine holds it for a
> bounded, explicitly configured window inside the same trust boundary, minimised to the transaction
> lifetime, and then anonymised by the engine's cleanup job.

Never log credentials, PID attributes, VP tokens, SD-JWTs, mdocs, private keys or secrets. The
redaction deny-list test **fails the build** if payload-like fields reach the logs. The platform never
reads EUDIPLO's database directly — only its API.

See [ADR 0004](docs/adr/0004-ephemeral-presentation-and-issuance-processing.md).

---

## 6. Facts that are easy to get wrong

Each of these contradicts a plausible assumption, including assumptions in the original prompt.

1. **`age_over_18` does not exist in the PID.** PID Rulebook v1.1 change log: "Age verification
   attributes removed, following CIR 2024/2977." The live reference issuer advertises no age claim in
   either format. Never write a policy, test or example requesting `age_over_18` from a PID. Age over
   a PID must be derived from `birthdate` / `eu.europa.ec.eudi.pid.1.birth_date` under
   `DERIVED_CLAIMS`, with the source value discarded in the same call stack.
   [ADR 0005](docs/adr/0005-presentation-policy-abstraction-and-minimisation-first-compilation.md)
   Decision 5.
2. **`requestedClaims` are OpenID4VP claim paths**, arrays of strings, nulls and non-negative
   integers (TS5 `Claim.path`, OpenID4VP §6.3/§7.1/§7.2) — not flat attribute names. The §6.1 subset
   check is a **path**-subset check: extending a registered path is allowed, prefixing it is not.
3. **`purpose` and `privacyPolicy` are localised and multi-valued** (`[1..*]` of `MultiLangString` in
   TS5), and the Wallet displays them per `AS-WP-06-015` (`RPA_10`).
4. **One EUDIPLO tenant per `RelyingPartyInstance`** (per RP Service × environment), **not** per
   platform `Tenant`. EUDIPLO scopes keys, certificates and registrar config per tenant, and ARF
   scopes those to a Service. [ADR 0002](docs/adr/0002-eudiplo-as-wrapped-engine.md) Decision 3.
5. **Never branch on EUDIPLO's session `status`.** `failed` covers trust, signature and protocol
   failures alike. Branch on `session.failureCode` / `outcome.error` using the v7.5.0 taxonomy
   (`signature_invalid`, `no_trust_chain_to_root`, `trust_chain_not_trusted`,
   `trust_list_unavailable`, `certificate_expired`, `x5c_missing`, `verification_error`).
   `trust_list_unavailable` is **our** operational failure, not a bad credential.
6. **`DECLINED_BY_USER` is best-effort.** `AS-WP-06-017` (`RPA_11`) requires the Wallet, on denial, to
   behave as if the credential did not exist. Report it only on an explicit OpenID4VP `access_denied`,
   and document that its absence does not mean consent.
7. **Revocation must not be reversible.** `AS-AP-07-007` (`VCR_04`). EUDIPLO accepts `status: 0` after
   `status: 1`; the platform must reject un-revocation while allowing reinstatement from *suspended*.
8. **Keep the EUDIPLO session id on `IssuedCredentialRecord`.** `POST /session/revoke` is the only
   exposed status mutation and it is session-keyed. `StatusMapping` has no foreign key to the session,
   so revocation survives session purge — but only if we kept the id. It is metadata; never return it
   or log it (the revocation index is an `ISSU_35` unique element).
9. **ARF discourages redirect-based cross-device flows.** `EW-PIO-01-016` (`OIA_08c`) says Wallet Units
   SHOULD NOT support them; `EW-PIO-01-017` (`OIA_08d`) obliges a Relying Party that uses one to
   implement mitigations. A QR carrying `openid4vp://` is exactly that. `SAME_DEVICE` is the V0
   tested path; `QR` is flagged with the unmet obligation in `security-limitations.md`. Open
   question Q5 — **user decision pending.**
10. **EUDIPLO's documentation diverges from its code in at least seven places.** Write the adapter
    against the source and the OpenAPI document. Known: `POST /client` not `/clients`; no
    `PATCH …/status-list/{listId}/entry/{index}` route; `/issuers/:tenantId/chained-as/*` not
    `/{tenant}/chained-as/*`; session config is `{ttlSeconds, cleanupMode: "full"|"anonymize"}` not
    `{retentionDays, cleanupMode: "delete"|...}`; the `-labs` image org is stale; "RFC 9528" is the
    wrong citation for the Token Status List. See [`docs/interop-findings.md`](docs/interop-findings.md).
11. **V0 does not use EUDIPLO's registrar client.** Its only preset (German Sandbox) is not on the
    dev WRPAC LoTE. Access certificates are enrolled out of band and imported via
    `POST /key-chain/import` with `usageType: "access"`, leaf-first, then referenced as
    `accessKeyChainId` on the presentation configuration.
12. **The dev environment collapses three ARF trust domains.** The seven WRPAC, WRPRC and PIDProviders
    anchors are byte-identical. The `TrustResolver` must keep the domains separate regardless, and
    must support both ETSI TS 119 612 Trusted Lists and ETSI TS 119 602 LoTEs — `EW-PIO-01-029`
    (`OIA_15b`).

---

## 7. Trust environment

Every trust-related configuration record carries an explicit `trustEnvironment`: `TEST` or
`PRODUCTION`. **V0 supports `TEST` only.**

Do not fake production registration, certificates or Registrar interactions.

V0 operates as a **hosted Relying Party Instance**: the platform operates the instance on behalf of
the Relying Party using **the Relying Party's own** access and registration certificates. V0 does
**not** implement the Article 5b(10) intermediary profile — per `AS-RP-52-006` (`RPI_06`) an
intermediary uses its own access certificate and presents the intermediated Relying Party's
registration certificate, and per `AS-RP-52-008` (`RPI_07`) the Wallet shall **not** display the
intermediary's trade names at approval. That is a future dedicated operating profile.

**The legal qualification of the hosted-instance profile (processor vs intermediary) needs legal
confirmation** — recorded in [`docs/knowledge-alignment.md`](docs/knowledge-alignment.md) KA-3, open
question Q2. Do not resolve it technically and do not enable `PRODUCTION` before it is resolved.

---

## 8. Do not fake integration

If a full interaction with the official Reference Wallet cannot be completed — because it needs
external trust setup, certificates, wallet builds, configuration, a mobile device, an external issuer,
public HTTPS exposure or an unavailable environment — **do not simulate success**. Instead:

1. implement everything else;
2. document the exact blocker;
3. provide manual steps;
4. provide adapter-level tests;
5. state precisely what is needed for the real test.

**The known V0 blocker (B1):** the official Reference Wallet enables only `ClientIdScheme.X509SanDns`
and `ClientIdScheme.X509Hash`, always enforces access-certificate trust, and accepts only the seven
`EUDIW WRPAC Provider - {EE,NL,CZ,EU,LU,PT,UT} 02` anchors from
`https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt`
(`AS-WP-06-005`, `RPA_04`). A self-signed access certificate cannot work, and `Preregistered` is not
enabled in the shipped build.

- **Path A (preferred):** enrol at `https://registry.serviceproviders.eudiw.dev/`, import the PKCS#12.
  Requires an account — open question Q1.
- **Path B (fallback):** build the wallet from source with `Preregistered` or a custom reader trust
  store. This is a **modified wallet**. If used, label it as such everywhere and never report it as an
  official-wallet result.

A related honesty requirement: the Reference Wallet ships *Check Registration Certificates* **off**, so
a passing V0 demo exercises the access-certificate trust layer only, not the registration layer. Test
M2 issuance with that switch in **both** positions and report both results —
`AS-AP-44-005` (`RPRC_22a`) and `AS-AP-44-007` (`RPRC_23`) make a valid registration certificate a
precondition for the Wallet to request issuance at all.

---

## 9. Security and testing floors

Security (V0 is explicitly **not** production-ready; list every shortcut in
`docs/security-limitations.md`):

- validate all input; parameterised database access;
- isolate tenant data logically, with tests proving cross-tenant access is rejected — the platform's
  own isolation, not EUDIPLO's `tenantId` column;
- tenant derived from the authenticated credential; a `tenantId` in a path or body is only **checked
  against** it, never trusted;
- secrets out of source; commit only `.env.example`;
- protect EUDIPLO credentials; do not expose the EUDIPLO admin API or UI beyond localhost;
- callback URLs HTTPS only and matched against a per-service allow-list (SSRF); payloads HMAC-SHA256
  signed with a timestamp header; retries with exponential backoff and a bounded attempt count; an
  event id per event for idempotency; payload = normalised result only, never content;
- dependency scanning in CI and secret-scanning configuration.

Testing — unit: policy validation against the intended use (including the claim-path subset cases),
the compiler and its minimisation rules, the transaction state machines (including rejection of
illegal transitions), result transformations, EUDIPLO mapping and error normalisation, webhook signing
and retry, the log redaction deny-list. Integration: business layer against mocked ports with no
EUDIPLO; adapter tests against a real EUDIPLO container in a **separately skippable** suite;
migrations up from an empty database.

---

## 10. Where things are

| | |
|---|---|
| Phase 0 findings, blockers, open questions | [`docs/phase-0-findings.md`](docs/phase-0-findings.md) |
| ARF/TS and implementation divergences | [`docs/interop-findings.md`](docs/interop-findings.md) |
| Conflicts with the knowledge base | [`docs/knowledge-alignment.md`](docs/knowledge-alignment.md) |
| ADRs | [`docs/adr/`](docs/adr/) — 0001 technology, 0002 EUDIPLO + tenant mapping, 0003 modular monolith, 0004 ephemeral processing, 0005 policy + minimisation. 0006 (hosted instance vs intermediary) is blocked on Q2; 0007–0008 are Milestone 2 |

Open questions Q1–Q9 are in `phase-0-findings.md` §8. **Q5 (the QR flow) needs a user decision.**
Q1 (an RP Registration Service account) gates the end-to-end demo. Q2 (legal qualification) gates
`PRODUCTION`.
