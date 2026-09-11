# One PID login, both roles: the exact sequence

What you need in front of you to register as **both** a Relying Party and a **non-qualified EAA
Provider** in a single session at `https://registry.serviceproviders.eudiw.dev/`, so one PID
presentation covers both.

ARF §6.3.2.3 is the basis for doing it in one pass: a registered entity may hold **dual-role
registration certificates**, and an Attestation Provider that also verifies attestations is exactly
that case. The Registrar issues per-role artefacts; the *registration* is one act.

> **Read this first.** The reference service is explicitly non-production and its own documentation
> says so. Everything below is `TEST`. Nothing here registers anything real.

---

## 0. Before you start — the three secrets rule

`hash_pid`, every PKCS#12 and every P12 password are **secrets**. Gitignored local files or `.env`
only; never in a log, an audit record, a document, a fixture or a commit. They are on the
log-redaction deny-list, and `*.p12`, `*.pfx`, `*.key`, `*.pem`, `*hash_pid*` and
`access-certificate*` are gitignored. If you paste one into a terminal, remember shell history.

Have ready:

| | |
|---|---|
| A wallet holding a **test PID** | From `https://issuer.eudiw.dev` — either `eu.europa.ec.eudi.pid_vc_sd_jwt` (`dc+sd-jwt`, `vct=urn:eudi:pid:1`) or `eu.europa.ec.eudi.pid_mdoc` (`mso_mdoc`) |
| A device that can scan a QR | The login is an OID4VP presentation, not a password |
| Somewhere to put files | A directory outside the repository, or one that is gitignored |

## 1. Authenticate — one PID presentation for the whole session

```
GET  https://registry.serviceproviders.eudiw.dev/authentication
      → renders a QR encoding an openid4vp:// request
     [scan it with the wallet, approve the PID presentation]
POST https://registry.serviceproviders.eudiw.dev/getpidoid4vp
      → returns hash_pid
```

`hash_pid` is the session credential for **everything** that follows. Capture it once and reuse it;
re-authenticating would give a different session and defeat the point of doing both roles together.

```bash
# Outside the repo, or in a gitignored path.
read -r -s -p "hash_pid: " HASH_PID && export HASH_PID
```

**No account is created and none is needed.** That was the Q1 finding: the service authenticates by
PID presentation, so there is nothing to sign up for.

## 2. The data to have prepared

Fill these in *before* you start, because the session is easier to complete in one pass than to
resume. One column per role; the **shared** rows are entered once.

### Shared — the legal entity

| Field | What to put | Where it ends up |
|---|---|---|
| Legal name | The registered name, as in an official record | `organizationName` in both certificates |
| Country | `NL` (or yours) | `countryName`; also the three-letter prefix of the semantic identifier |
| Organisation identifier | An EORI / LEI / VAT number, or the scheme's test equivalent | `organizationIdentifier`, per ETSI EN 319 412-1 §5.1.4 |
| Trade name | The user-recognisable name | `commonName` — **this is what a Wallet shows the User** |
| Support URI | `https://<your-host>/support` | SAN URI in the access certificate; `support_uri` in the registration certificate |
| Privacy policy URI | `https://<your-host>/privacy` | Shown by the Wallet at approval |
| Contact email | A real mailbox you can read | SAN `rfc822Name` |

### Role A — Relying Party (verification)

| Field | Value for V0 | Notes |
|---|---|---|
| Role / entitlement | Wallet-Relying Party | The `entitlement` set in the register |
| Service identifier | e.g. `age-gate` | **RP-chosen, unique within the RP.** `AS-MS-27-045` (`Reg_33`). The platform requires it even though TS5 makes it `[0..1]` |
| Service trade name | e.g. `Age Gate` | Displayed with the RP name at approval |
| Intended use — purpose | "Confirm the customer is an adult" | Localised and **multi-valued**: `[1..*]` MultiLangString. The Wallet displays it (`AS-WP-06-015` / `RPA_10`) |
| Intended use — attributes | `urn:eudi:pid:1` → `birthdate` | **Not `age_over_18`.** PID Rulebook v1.1 removed the age attributes following CIR 2024/2977, so an age check derives from the date of birth |

### Role B — non-qualified EAA Provider (issuance)

| Field | Value for V0 | Notes |
|---|---|---|
| Role / entitlement | `Non_Q_EAA_Provider` | The entitlement that makes this an Attestation Provider rather than a relying party |
| Attestation type | `urn:edtp:employee-badge:1` | The `vct`. Must match the credential type you create in the platform |
| Format | SD-JWT VC (`dc+sd-jwt`) | One type for V0 |
| Attributes issued | `employee_id` (mandatory, string) | Keep it to one or two; every attribute has to be justified in the registration |
| Rulebook identifier + version | `urn:edtp:rulebook:employee-badge`, `1.0` | **Ask the Registrar what it expects here.** ARF §6.3.2.4 makes the Rulebook the source of trust anchors, so this is trust configuration, not a label |
| Status mechanism | IETF Token Status List | So revocation works |

> **The question to ask the Registrar**, because the answer decides a design point we deliberately
> left open: *for a non-qualified EAA, do you expect the Rulebook alone to name the trust anchors, or
> will there also be a list of trusted Attestation Providers published per ETSI TS 119 602?* That
> maps onto `anchorSource` — `RULEBOOK_ONLY` versus `RULEBOOK_AND_PUBLISHED_LIST` — and if the answer
> is the latter, ask **who publishes it**. See [`issuer-trust-model.md`](issuer-trust-model.md).

## 3. The endpoint sequence

The reference service's UI walks these; the API shape is given so you can script the repeat runs.
Every call carries the same `hash_pid`.

```
# --- once, shared ------------------------------------------------------------------
POST /api/registration                       legal entity + contact + identifiers
      → registrationId

# --- role A: Relying Party ---------------------------------------------------------
POST /api/registration/{registrationId}/services          serviceIdentifier, tradeName
POST /api/registration/{registrationId}/intended-uses     purpose[], privacyPolicy[], attributes[]
POST /api/registration/{registrationId}/access-certificate
      → PKCS#12  (the RP access certificate)        ← save as rpac.p12

# --- role B: non-qualified EAA Provider -------------------------------------------
POST /api/registration/{registrationId}/entitlements      Non_Q_EAA_Provider
POST /api/registration/{registrationId}/attestations      vct, format, attributes, rulebook
POST /api/registration/{registrationId}/access-certificate?role=attestation-provider
      → PKCS#12  (the attestation-signing certificate)  ← save as apac.p12

# --- registration certificates, if the service issues them ------------------------
POST /api/registration/{registrationId}/registration-certificate?role=relying-party
POST /api/registration/{registrationId}/registration-certificate?role=attestation-provider
      → JWT each                                    ← save as rprc.jwt / aprc.jwt
```

**Route names are indicative.** The service's own OpenAPI is authoritative, and Milestone 1 taught
that documented routes diverge from running ones — so open its document and reconcile before
scripting. What is *not* negotiable is the order: the shared registration first, then per-role
artefacts, because each certificate is bound to the registration it was issued under.

If the service exposes only one `access-certificate` route with no role parameter, **run the
registration twice against the same `hash_pid`** — once per role — rather than reusing one
certificate for both. An access certificate carries one role's identifiers; using the RP's
certificate to sign attestations would misrepresent the provider.

## 4. Immediately after: the gating check, before any wallet test

```bash
# The RP access certificate must chain to a dev WRPACProviders anchor.
./scripts/verify-access-certificate-chain.sh rpac.p12

# The attestation-signing certificate is a different question: there is no notified list for a
# non-qualified EAA provider (see issuer-trust-model.md gate (b)), so expect this to find no anchor.
# Run it anyway and record the result, rather than assuming.
LOTE_URL=https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PubEAAProviders.jwt \
  ./scripts/verify-access-certificate-chain.sh apac.p12
```

The script now also reports **list freshness**. The dev lists roll over — `PubEAAProviders` had
`NextUpdate` 2026-09-12 — and a stale list must not be trusted silently: a rotated-out anchor would
still look valid to a cached copy while a Wallet, which refetches, refuses the certificate. Record
both the matched anchor and the freshness line in
[`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1.

## 5. Then hand over

What the platform needs, and nothing more:

| Artefact | Goes to | Kept where |
|---|---|---|
| `rpac.p12` + password | `scripts/import-access-certificate.sh` | Engine key store; the platform keeps only the opaque key-binding reference |
| `apac.p12` + password | `POST .../attestation-providers/{id}/provision` | Same |
| `rprc.jwt` | `POST .../registration-certificates` | Stored on the intended use |
| `aprc.jwt` | `provision`, as `registrationCertificateJwt` | Published as `issuer_info` |
| The registrar-assigned identifiers | `registrarAssignedIdentifier` on both records | Configuration rows |

Pass the passwords by environment variable or prompt — never as a command-line argument. Both scripts
use `-passin env:` for exactly that reason.

## 6. What this still will not achieve

Stated so the session is not mistaken for more than it is.

- **A real registration certificate closes `RPRC_19` on the platform side only.** The engine will
  not put it in a presentation request without a *configured live registrar* (`interop-findings.md`
  A13), so the Wallet still receives none.
- **Issuance to an unmodified official wallet remains blocked (B7).** Gate (a) needs
  `signed_metadata`, which the engine does not produce; gate (b) has no notified list for a
  non-qualified EAA. Neither is fixed by registering.
- **Nothing here is production.** `TEST` only, and the service says so itself.
