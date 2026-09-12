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
| Milestone 1 — foundations + Verification as a Service | `implementation/platform-v0` | PR 1, then **STOP** ← *complete* |
| Milestone 2 — Issuance as a Service | `implementation/platform-v0-issuance` (from M1) | PR 2 ← *complete* |

### Milestone 2 starts with an investigation, and with a checkpoint of its own

**The first task of Milestone 2 is to re-verify how the pinned Reference Wallet release decides to
trust an issuer of a non-qualified EAA — before any issuance code is written.** Decided at the
Milestone 1 review.

The reason this cannot wait: the verification side already proved that the shipped wallet build
accepts only anchors from the notified Access CA LoTEs and ships no preregistered escape hatch
(`AS-WP-06-005` / `RPA_04`, blocker B1). The issuance side has its own, *different* trust path — a
Non-Qualified EAA Provider is trusted through whatever the build resolves for issuer trust, which is
not the WRPAC LoTE — and nothing in Phase 0 verified it. Assuming it resolves the way verification
does would be exactly the "terminology similarity does not prove conformance" error in §2.

Verify against the pinned release `Wallet/Demo_Version=2026.09.42-Demo_Build=42` and Wallet Core
`v0.30.2`, in the source, not by inference:

1. Which trust mechanism the build uses for an attestation **issuer** — the dev
   `PubEAAProviders` LoTE, a separate issuer trust store, the OpenID4VCI issuer metadata, or
   nothing at all — and whether a non-qualified EAA is treated differently from a PID.
2. Whether a development issuer can be trusted without modifying the build, and if not, what the
   smallest modification is.
3. Whether *Check Registration Certificates* being off by default changes what is actually
   exercised, given that `AS-AP-44-005` (`RPRC_22a`) and `AS-AP-44-007` (`RPRC_23`) make a valid
   registration certificate a precondition for the Wallet to request issuance at all — which V0
   does not have (blocker B3).

**Then STOP and report**, before building the issuance flow. If it is a blocker, say so plainly and
state what a real test needs; do not design around it silently and do not simulate success (§8).

**Done, 11 September 2026 — and it is a blocker (B7).** Issuer trust is ETSI LoTE-based, resolved
per `VerificationContext`; for a non-qualified EAA the pinned build has no trust list, no
classification and an `ENFORCE` default, so `evaluateIssuerTrust` throws. The mechanism is absent by
design. Full record, the smallest wallet modification, and the finding that *Check Registration
Certificates* is one **runtime preference (default off)** gating **both** the issuer and verifier
registration checks: [`docs/milestone-2-issuer-trust.md`](docs/milestone-2-issuer-trust.md). Test M2
issuance with that switch in **both** positions and report both — one build suffices, since it is a
preference.

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

**Confidentiality.** The repository working tree holds an untracked `sources/` directory of reference
material, including internal national comitology documents. Never commit a path under it, and never
cite or quote that material in a committed file — cite the public instrument instead. Enforced by
`scripts/check-confidentiality.mjs`, run by `pnpm verify` and by the `.githooks/pre-commit` hook
(enable once per clone with `git config core.hooksPath .githooks`). Confirmed clean as of
11 September 2026.

The six verification-side knowledge pages the prompt referenced **do not exist**
(`verification-operating-models.md`, `presentation-policy.md`, `verifier-product-model.md`,
`presentation-privacy-and-retention.md`, `verification-service-architecture.md`,
`verification-mvp.md`). They are **backlog**, listed in `knowledge-alignment.md` KA-1, and are
**not** created in an implementation PR. The same applies to the `RPI_07` correction in KA-2: a
separate small PR against `main`, not bundled into implementation work.

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
   implement mitigations — **for the challenges in ARF §4.4.3.2, not §4.4.3.1 which `OIA_08d` cites in
   error** (`docs/interop-findings.md` D6). A QR carrying `openid4vp://` is exactly such a flow, and
   the pinned wallet release **does** still scan them (verified in source). **Decided:** `SAME_DEVICE`
   is the tested default; `QR` stays, with four implemented mitigations — see
   [ADR 0009](docs/adr/0009-cross-device-presentation-mitigations.md). Two of the five challenges
   cannot be addressed by a Relying Party at all, so **never state that `OIA_08d` is satisfied**, and
   never present `QR` as the demonstrated flow. The residual risks ride in every cross-device audit
   record; do not remove them.
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
12. **Age is not bound to the PID in the domain model.** V0 derives it from the PID date of birth
    because no age attribute exists there, but that is a *policy* choice. A policy must stay able to
    target a dedicated age attestation, in either format, with no domain change.
    `tests/unit/age-not-pid-bound.test.ts` fails if any PID type or age attribute name is hard-coded
    into `packages/domain`. Note also that ARF 3.0.0 still carries a residual "`age_over_*` … if
    present" note for attributes the PID Rulebook removed — a baseline inconsistency logged in
    `docs/interop-findings.md` D7. Follow the Rulebook.
13. **The engine's management API is under `/api`; only `/health` is not.** EUDIPLO serves two
    OpenAPI documents on one port — the wallet-facing Protocol API at `/docs-json` (unprefixed)
    and the Management API at `/api/docs-json` (all routes under `/api`). `EngineClient.request`
    applies the prefix centrally, so adapter call sites write the unprefixed path and a path that
    already carries it is rejected rather than doubled. Getting this wrong produces a `404` on
    every management call and nothing else. `docs/interop-findings.md` A10.
14. **The engine's `root` client cannot serve a Relying Party Instance,** and the engine does not
    create its own schema from migrations. Root's token carries `roles: ["tenants:manage"]` and
    `tenant_id: null`; a usable credential comes from `POST /api/tenant`, which returns a
    per-tenant admin client. And `DB_SYNCHRONIZE` must be **true** for the engine's database or it
    crash-loops on `relation "client_entity" does not exist` — its migrations transform an existing
    schema and never create one. Both confined to the engine's own separate database.
    `docs/interop-findings.md` A9 and A11.
15. **A database constraint violation is a client error, not a server error.** PostgreSQL class 23
    codes are translated in `error.filter.ts`: `23505` to a `409` naming the **constraint**, never
    PostgreSQL's `detail`, which embeds the offending values. And an unhandled throw logs its
    message and a capped stack — through the redactor, which strips denied keys — because a 500
    that logs only `{"errorName":"Error"}` cannot be diagnosed. Both found by running the stack.
16. **Issuer trust is two separate gates, and neither is satisfied.** (a) ARF §6.6.2.2, pre-issuance
    provider authentication: the engine publishes the registration certificate as `issuer_info` but
    produces **no `signed_metadata`**, which the pinned wallet requires — so a Wallet cannot
    authenticate the provider. (b) ARF §6.3.2.4, attestation signature trust: anchors come from the
    **Rulebook**, optionally from an ETSI TS 119 602 list that is **not** a Topic 31 notified list —
    which is why the platform may publish one, `TEST` only. `CredentialType.rulebook` is trust
    configuration, not a label. Never claim either gate.
    [`docs/issuer-trust-model.md`](docs/issuer-trust-model.md).
17. **On the issuance side, four engine payload shapes are accepted-then-wrong.** `usageType` is
    `attestation` not `signing`; `credentialClaims` is a tagged union (`{type: "inline", claims}`);
    `registrationCertificate` needs `enabled` *and* `mode: "import"`; `authorizationServers` is a
    discriminated union on `type` and an entry without it is silently ignored; the id `built-in` is
    reserved. A test asserting only "the call succeeded" would pass on four of them.
    `docs/interop-findings.md` A14.
18. **The engine tenant must be created with every role it will ever need.** Roles cannot be widened
    afterwards — `PATCH /api/tenant/{id}` rejects a `roles` key — and a tenant cannot grant its
    clients roles it lacks. `docs/interop-findings.md` A16.
19. **The dev environment collapses *four* ARF trust domains**, not three: `PubEAAProviders` carries
    the same seven byte-identical anchors as `PIDProviders` and `WRPACProviders`. The lists also roll
    over, so anything reading one must honour `NextUpdate` — `verify-access-certificate-chain.sh`
    fetches live and reports freshness.
20. **A tunnel in front of the engine publishes its Management API.** The engine serves the Protocol
    API unprefixed and the Management API under `/api` **on the same port**, so exposing port 3000 for
    a phone exposes `POST /api/key-chain/import` and every tenant route, protected only by a
    client-credentials secret. Never tunnel a whole port: use the default-deny path allow-list in
    [`docs/test-session-gateway.md`](docs/test-session-gateway.md), run its negative checks before any
    wallet interaction, and treat a `401` on an `/api/*` probe as a failure — it proves the endpoint
    is reachable. A tunnel is hand-started, open only during a session, synthetic data only.
21. **Gate (a) is one mechanism, and G1 and G8 are one fix.** ETSI TS 119 472-3 V1.1.1 routes all of
    it through a single JWS: the metadata **shall** be signed (`ISS-MDATA-4.2.1-01`), the signing
    certificate **shall be the access certificate** (`-02`), it travels in the `x5c` protected header
    (`ISS-MDATA-ACC_CERT-4.2.2-01/-02`), and `issuer_info` sits at the **top level of the signed
    payload** (`ISS-MDATA-REG_CERT-4.2.3-02`). So the access certificate has no separate home — it *is*
    the signer — and the registration certificate the engine publishes today is in the unsigned
    document, which is the wrong place. Three consequences: the **Q1a chain check gates gate (a) too**
    (the wallet validates that chain with `VerificationContext.WalletRelyingPartyAccessCertificate`,
    the same anchors as a verifier's); the metadata signing key must be **`access`**-usage, not the
    attestation key; and **`RPRC_22a`/`RPRC_23` are untestable until the metadata is signed**, because
    `IssuerCreator` applies the issuer registration-certificate check only under `RequireSigned`, so
    WD-2 silently switches it off whatever the wallet's *Check Registration Certificates* preference
    says. Obtain the access certificate at registration regardless: PID-during-issuance uses one, and
    that path works.
22. **The EDTP test wallet is a modified build, and its identity is deliberate.** `applicationId`
    `eu.europa.ec.euidi.edtptest`, our own signing key (`OU=TEST ONLY`), a banner on every screen, and
    `BuildConfig.EDTP_DEVIATIONS` naming what is compiled in. Every deviation defaults to upstream
    behaviour and `build.sh` **refuses** a deviation flag it cannot honestly honour. Never write "the
    Reference Wallet" about a result from it, and never commit or publish the APK.
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

- **Path A — the route, and it needs no account.** `https://registry.serviceproviders.eudiw.dev/`
  authenticates by **OID4VP PID presentation** (`/authentication` → QR → `/getpidoid4vp` →
  `hash_pid`). Then **chain-check before any wallet test** —
  `scripts/verify-access-certificate-chain.sh` — and record the result in
  `docs/reference-wallet-testing.md` §8.1. Then import the PKCS#12.
- **Path B — the fallback, only if that chain check fails:** build the wallet from the Reference
  Implementation with a platform-operated development Access CA in its reader trust store
  (`configureReaderTrustStore(context, R.raw.…)`, which takes precedence over the ETSI store).

**Never attempt a wallet test before the chain check.** `AS-WP-06-005` (`RPA_04`) makes the Wallet
accept only Access CA anchors from the notified LoTEs, so an unchecked certificate produces a
misleading failure.

**`hash_pid`, the PKCS#12 and its password are secrets.** Gitignored local files or `.env` only;
never in a log, an audit record, a document, a fixture or a commit. They are on the redaction
deny-list and `*.p12` / `*hash_pid*` are gitignored.

**If Path B is used it produces a MODIFIED wallet, not the official Reference Wallet.** Therefore,
without exception:

- every report, document, test name, log line and PR statement says "self-built Reference
  Implementation wallet" or "modified wallet" — never "the Reference Wallet" unqualified;
- the result against an **official** build remains **unverified**, and
  `docs/reference-wallet-testing.md` and the PR description must say so explicitly;
- the development Access CA is `TEST`-only, never added to any `PRODUCTION` trust configuration, and
  is listed in `docs/security-limitations.md`;
- test *Check Registration Certificates* in both positions and report both, since V0 has no
  registration certificate (blocker B3).

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
| **Where the work stands, and the next action** | [`docs/status.md`](docs/status.md) — **read this first**; it carries what the code and the git history do not |
| Prerequisites, and moving to another machine (Windows → WSL2) | [`docs/development-setup.md`](docs/development-setup.md) |
| Phase 0 findings, blockers, open questions | [`docs/phase-0-findings.md`](docs/phase-0-findings.md) |
| Test wallet: build tooling, deviation register, install + first PID sheet | [`tools/test-wallet/`](tools/test-wallet/) — and [`docs/test-wallet-plan.md`](docs/test-wallet-plan.md) for the W0 investigation it was built from |
| Public exposure for a phone test, and the G7 evaluation | [`docs/test-session-gateway.md`](docs/test-session-gateway.md) — the allow-list governs both deployments; [`docs/test-session-vm.md`](docs/test-session-vm.md) is the disposable-VM alternative, recommended for any recorded result |
| Certificates, when they arrive; then the first VaaS run | [`docs/certificate-intake-runbook.md`](docs/certificate-intake-runbook.md), [`docs/vaas-official-wallet-run-sheet.md`](docs/vaas-official-wallet-run-sheet.md) |
| Conformance: the run that happened, and the one prepared | [`docs/conformance-results.md`](docs/conformance-results.md), [`docs/conformance-faithful-profile.md`](docs/conformance-faithful-profile.md) |
| ARF/TS and implementation divergences | [`docs/interop-findings.md`](docs/interop-findings.md) |
| Conflicts with the knowledge base | [`docs/knowledge-alignment.md`](docs/knowledge-alignment.md) |
| ADRs | [`docs/adr/`](docs/adr/) — 0001 technology, 0002 EUDIPLO + tenant mapping, 0003 modular monolith, 0004 ephemeral processing, 0005 policy + minimisation, **0009 cross-device mitigations**. 0006 (hosted instance vs intermediary) stays reserved and is blocked on Q2; 0007–0008 are Milestone 2, so a new ADR takes the next free number from 0009 |

Open questions are in `docs/phase-0-findings.md` §8. **Q1 and Q5 were resolved at the Phase 0
checkpoint**: Q1 → **Path A** — enrol a real access certificate at the reference RP Registration
Service, which needs **no account** because it authenticates by OID4VP PID presentation, and test
against an **official** wallet build. Path B (a wallet self-built from the Reference Implementation
with a platform-operated development Access CA in its reader trust store — a *modified* wallet) stays
documented as the fallback and is used *only* if the chain check in §8 fails. Q5 → `SAME_DEVICE` is
the tested path, `QR` retained with the ADR 0009 mitigations. **Q1a** is the new gating item: run
`scripts/verify-access-certificate-chain.sh` and record the result before any wallet interaction.
Q2 (legal qualification) gates `PRODUCTION`. Q3 and Q4 are Milestone 2 concerns. Q6–Q9 remain open.
