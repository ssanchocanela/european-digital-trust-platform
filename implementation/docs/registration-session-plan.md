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

Three endpoints, not two, and the middle one is a poll. Taken from the service's OpenAPI document
(`/apispec_1.json`), which is authoritative over its `/guide` page and over what this plan
previously guessed — see [`interop-findings.md`](interop-findings.md) C9.

```
GET  /authentication
      → {"QR_code_url": "eudi-openid4vp://…", "presentation_id": "…"}
     [encode QR_code_url as a QR, scan it, approve the PID presentation]
GET  /pid_authorization?presentation_id=…
      → poll until it reports success
POST /getpidoid4vp?presentation_id=…
      → hash_pid
```

Note the scheme: the request is `eudi-openid4vp://` with `client_id=x509_hash:…`, so the login
itself uses `ClientIdScheme.X509Hash` — one of the two the pinned wallet build enables. An
unmodified official wallet handles it, which is what makes this path usable at all.

`presentation_id` ties the three calls together. `hash_pid` is then the session credential for
**everything** that follows: capture it once and reuse it, because re-authenticating yields a
different session and defeats the point of doing both roles together.

`scripts/register-relying-party.sh` does all three, polls, and stores `hash_pid` in a mode-600
file outside the repository so an interrupted session resumes instead of restarting:

```bash
./scripts/register-relying-party.sh --login-only
```

It never prints `hash_pid`. Install `qrencode` first if you want the QR rendered in the terminal
rather than having to encode the URL yourself.

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
| Role / entitlement | `http://data.europa.eu/eudi/entitlement/Service_Provider` | The `entitlements` value in the register — a **URI**, and the one 99 of the 122 live entities hold |
| Service identifier | e.g. `age-gate` | **RP-chosen, unique within the RP.** `AS-MS-27-045` (`Reg_33`). The platform requires it even though TS5 makes it `[0..1]` |
| Service trade name | e.g. `Age Gate` | Displayed with the RP name at approval |
| Intended use — purpose | "Confirm the customer is an adult" | Localised and **multi-valued**: `[1..*]` MultiLangString. The Wallet displays it (`AS-WP-06-015` / `RPA_10`) |
| Intended use — attributes | `urn:eudi:pid:1` → `birthdate` | **Not `age_over_18`.** PID Rulebook v1.1 removed the age attributes following CIR 2024/2977, so an age check derives from the date of birth |

### Role B — non-qualified EAA Provider (issuance)

| Field | Value for V0 | Notes |
|---|---|---|
| Role / entitlement | `http://data.europa.eu/eudi/entitlement/Non_Q_EAA_Provider` | Added to the **same** `wallet_rp` as Role A, not to a separate registration — §3 |
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

**Every route this section previously listed was wrong.** It was written from the ARF's vocabulary
rather than from the service, and flagged as indicative; reconciling it against the service's own
OpenAPI document on 12 September 2026 found no `/api` prefix, no `registrationId` in any path and no
`role` parameter anywhere. What follows is read from `/apispec_1.json` (title "My API", version
1.0.0, 51 routes), which is authoritative over the `/guide` page — the guide's example bodies omit
required fields. Recorded as [`interop-findings.md`](interop-findings.md) C9.

The model is a chain: `Person → Legal Entity → Provider → Wallet Relying Party → Intended Use →
Credential`. Every call is a `POST /<resource>/create` carrying `hash_pid` **in the body**, and every
call answers `{"data": [<integer ids>], "message": "…"}`. Each step consumes ids minted by an
earlier one, so the order is not a style choice — the service rejects a reference it cannot resolve.

| # | Route | Consumes | Mints |
|---|---|---|---|
| 1 | `/law/create` | — | law ids |
| 2 | `/legal_person/create` | law ids | `legal_person_id` |
| 3 | `/identifier/create` | — | identifier ids |
| 4 | `/legal_entity/create` | identifier ids, `legal_person_id` | `legal_entity_id` |
| 5 | `/policy/create` `intention: "wrp"` | — | policy id |
| 6 | `/provider/create` | `legalEntityId`, wrp policy ids | `provider_id` |
| 7 | `/credential/create` | — | credential ids |
| 8 | `/policy/create` `intention: "intended_use"` | — | policy id |
| 9 | `/intended_use/create` | credential ids, intended-use policy ids | `intended_use_id` |
| 10 | `/provided_attestation/create` | — | attestation ids |
| 11 | `/supervisory_authority/create` | — | authority id |
| 12 | `/wallet_rp/create` | all of the above | **`wrp_id`** |
| 13 | `/wallet_rp/certificate` | `wrp_id` + a passphrase **you choose** | the access certificate, PKCS#12 |
| 14 | `/intended_use/certificate` | `intended_use_id` | the registration certificate |

Three things in that table are worth stating plainly, because each contradicts what this plan
assumed:

- **One certificate route, and it is keyed by the Wallet Relying Party.** There is no `role`
  parameter and no second access-certificate route. The P12 arrives **base64-encoded inside a JSON
  field**, not as a download, and the passphrase is chosen by the caller and sent in the request
  body — so it must come from an environment variable, never from a `curl` command line.
- **The registration certificate is per intended use**, which is `RPRC_19` expressed as a route.
  One per intended use, not one per Service, exactly as the intake runbook says.
- **`entitlements` are URIs**, not the bare tokens this plan used:
  `http://data.europa.eu/eudi/entitlement/Service_Provider` and
  `http://data.europa.eu/eudi/entitlement/Non_Q_EAA_Provider`.

### Both roles are one registration — settled, not assumed

This plan used to say that not knowing whether one certificate could serve both roles "is what makes
a second session necessary". It is now known, from public evidence rather than inference.

`GET /wrp` is the register itself, unauthenticated, returned as a JWS over the whole list. On
12 September 2026 it held **122 entities**, and their entitlement combinations were:

```
 99  Service_Provider
 10  Non_Q_EAA_Provider + PID_Provider + Service_Provider
  7  Non_Q_EAA_Provider + Service_Provider
  3  all ten entitlements at once
  1  PUB_EAA_Provider + Service_Provider
  1  PID_Provider
  1  Non_Q_EAA_Provider
```

**Twenty entities carry `Non_Q_EAA_Provider` alongside `Service_Provider`.** The dual-role
registration of ARF §6.3.2.3 is the second most common shape in the register, so one `wallet_rp`
holding both entitlements is the normal way to express it — one registration, one certificate, one
session.

What that also means, and it is a reduction in what the session can deliver: **the service issues no
attestation-signing certificate.** `providesAttestations` is declared metadata only — a `format` and
a free-text `meta`. So there is no `apac.p12` to save, and
[`certificate-intake-runbook.md`](certificate-intake-runbook.md) Step 2 was written expecting one.
Gate (b) takes its anchors from the Rulebook regardless
([`issuer-trust-model.md`](issuer-trust-model.md)), so this changes nothing about blocker B7 — but
Step 2 needs rewriting before it is run, and a signing certificate for the EAA Provider role has to
come from somewhere else.

### Run it with the script, and rehearse first

```bash
cp scripts/registration-entity.example.json ~/.edtp/registration/entity.json
# fill in every CHANGE-ME, then rehearse without touching the service:
EDTP_DRY_RUN=1 ./scripts/register-relying-party.sh ~/.edtp/registration/entity.json
# then, for real:
./scripts/register-relying-party.sh ~/.edtp/registration/entity.json
```

Rehearsing matters more here than it usually would. The service has **no idempotency key and no
route that amends a half-built registration**, so a body the service rejects at step 9 leaves eight
entities behind that cannot be edited away. The dry run builds every request body exactly as it
would be sent, validates it as JSON and prints it with `hash_pid` and the passphrase redacted,
without making a single call. A real run records each minted id in a mode-600 state file and skips
what is already recorded, so an interruption resumes.

### 3.1 The one field nobody has documented

`providerType` on `/provider/create` is a **free-form string with no `enum`** in the OpenAPI
document, and it does not appear in the public register, so its accepted values are unknown. The
only value documented anywhere is the guide's example, `WALLET_PROVIDER`, which is plainly not what
a relying party is. Expect to discover it by trying, and record what worked.

`/credential/create` carries a second, smaller unknown: its `claims[].path` is a **JSON-path
string** (`"$.credentialSubject.name"` in the example), which is *not* the OpenID4VP claim-path
array of TS5 `Claim.path` that the platform uses — see CLAUDE.md §6 item 2. The correct spelling for
a PID `birthdate` in this field is therefore unverified; `scripts/registration-entity.example.json`
guesses `$.birthdate` and says so.

## 4. Immediately after: the gating check, before any wallet test

```bash
# The one certificate the session produces must chain to a dev WRPACProviders anchor.
./scripts/verify-access-certificate-chain.sh ~/.edtp/registration/rpac.p12
```

There is only one certificate to check, not two: §3 establishes that the service mints no separate
attestation-signing certificate. The second command this section used to carry, against
`PubEAAProviders` and an `apac.p12`, had nothing to run on.

That single check still covers both gates. Per `ISS-MDATA-4.2.1-02` the access certificate **is** the
signer of issuer metadata, and the pinned wallet validates that chain with
`VerificationContext.WalletRelyingPartyAccessCertificate` — the same anchors a verifier's
certificate is held to. So one chain check decides whether either gate could ever be satisfied
(CLAUDE.md §6 item 21).

The script also reports **list freshness**, and the rollover it was written to warn about has now
happened: all four dev lists reissued on 10–11 September 2026 with `NextUpdate` in March 2027, the
seven anchors unchanged. Still read the freshness line rather than trusting that, and record it
together with the matched anchor in
[`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1.

## 5. Then hand over

What the platform needs, and nothing more:

| Artefact | Goes to | Kept where |
|---|---|---|
| `rpac.p12` + passphrase | `scripts/import-access-certificate.sh` | Engine key store; the platform keeps only the opaque key-binding reference |
| `rprc-intended-use-<id>.jwt` | `POST .../registration-certificates` | Stored on the intended use it was issued for |
| The ids in the state file | `registrarAssignedIdentifier` on the configuration records | Configuration rows |

Two rows that this table used to carry have been removed because the service cannot produce them:
an `apac.p12` (there is no attestation-signing certificate — §3) and an `aprc.jwt` (the registration
certificate is issued per intended use, and the EAA Provider role has no intended use of its own).
`docs/certificate-intake-runbook.md` Step 2 still assumes both, and needs rewriting before it is
run.

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
