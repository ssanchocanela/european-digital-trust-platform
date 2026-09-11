# EUDIPLO integration

How the platform wraps the protocol engine, and the exact contract it depends on.

Everything here was verified against **EUDIPLO v7.6.0**, git commit `3b2a9e7163059db13019bdd1862240cbecb86201`,
by reading its source — **not** its prose documentation, which diverges in at least seven places
(see [`interop-findings.md`](interop-findings.md) section A).

---

## 1. Pinned version

| | |
|---|---|
| Release | `v7.6.0`, published 2026-09-08 |
| Commit | `3b2a9e7163059db13019bdd1862240cbecb86201` |
| Image | `ghcr.io/openwallet-foundation/eudiplo:7.6.0` |
| Digest | `sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667` |
| Licence | Apache-2.0 |

Pinned **by digest** in `docker-compose.yml`, not by tag.

Why v7.6.0 rather than an earlier release: **v7.5.0 added the persisted structured verification
outcome and the shared failure taxonomy the adapter depends on.** Without them, outcome
classification would have to work from the coarse session status, where `failed` covers trust,
signature and protocol failures alike and is not decidable. See §4.

Why by digest: six releases landed in 27 days around Phase 0, including a NestJS 12/CommonJS move
in v7.5.0 followed by a native-ESM migration in v7.6.0, and a v7.3.0 fix for "the session columns
that no migration ever created". An upgrade must be a reviewed change.

Upgrading is gated by `pnpm test:adapter` against a real container.

---

## 2. The routes the platform uses

The whole contract, and nothing more:

```
POST   /api/oauth2/token        client-credentials token
POST   /verifier/config         create or replace a presentation configuration
POST   /verifier/offer          create a presentation request
GET    /session/{id}            read status and, once settled, the disclosed claims
DELETE /session/{id}            cancel, and purge the engine-side session
PUT    /session-config          apply the retention settings (provisioning)
POST   /key-chain/import        import an access certificate (provisioning)
GET    /health
```

Milestone 2 will add `POST /issuer/credentials`, `POST /issuer/config`, `POST /issuer/offer` and
`POST /session/revoke`.

That surface is small enough to re-implement against another engine, which is the point.

### Not using the generated SDK

`@eudiplo/sdk-core` is versioned in lockstep with the engine. Depending on it would put engine
types in the platform's dependency graph and make every engine release a potential compile-time
event — exactly the coupling the anti-corruption layer exists to prevent. The adapter has a small
hand-written typed client instead (ADR 0001).

Responses are **parsed** with zod, not cast. A silently changed response shape is a realistic
failure mode at this release cadence; parsing turns it into a loud failure at the adapter boundary.
Every schema is permissive about fields the platform does not read and strict about the ones it
does.

---

## 3. Tenant mapping

**One engine tenant per `RelyingPartyInstance`** — per Relying Party Service and trust
environment — **not** one per platform `Tenant`. ADR 0002 Decision 3.

The shared word "tenant" invites the wrong mapping. What settles it:

| Engine per-tenant resource | ARF scope |
|---|---|
| Access-certificate key chain | One RP identifier **and** one Service identifier (`Reg_32`, `Reg_33`) |
| Registrar configuration, from which `rpId` is derived and cannot be overridden per request | One EU-wide unique RP identifier, identical across that entity's certificates (`RPRC_08`) |
| Registration certificates | One per (intended use × Service); the one given to an Instance must carry that Instance's Service identifier (`RPRC_09`, `RPRC_10`) |
| Session retention configuration | A per-customer privacy decision |

Consequences: engine tenant count grows with Services rather than customers;
`ENGINE_TENANT_CREDENTIALS` holds one entry per Instance; and a shared platform RP identity is
impossible by construction rather than by policy.

Each engine client should carry the minimum roles — `presentation:config`,
`presentation:request`, `key:manage` — and never `tenant:manage`, which the engine requires to be
unbound from any tenant. Set `allowedPresentationConfigs` to that instance's configurations for
defence in depth; the engine enforces it with `403`.

---

## 4. Outcome normalisation — never branch on the status

The engine's session status is `active | fetched | completed | expired | failed`. **`failed` is not
decidable.** The adapter branches on `session.failureCode` and `session.outcome.error` from the
v7.5.0 taxonomy:

| Engine code | Platform outcome | Why |
|---|---|---|
| *(completed, success)* | `VERIFIED` / `POLICY_NOT_SATISFIED` | Whether the policy is satisfied is the platform's question, answered after the result policy runs |
| `signature_invalid` | `REJECTED` | A defect in the presented credential |
| `certificate_expired` | `REJECTED` | |
| `x5c_missing` | `REJECTED` | |
| `no_trust_chain_to_root` | `TRUST_ERROR` | The credential may be valid under a trust configuration we do not hold |
| `trust_chain_not_trusted` | `TRUST_ERROR` | |
| `trust_list_unavailable` | `TRUST_ERROR`, **verifier-side** | The engine documents this as *our* misconfiguration or outage. Never reported to the customer as a bad credential |
| `access_denied` (OpenID4VP) | `DECLINED_BY_USER` | Best-effort; see `RPA_11` |
| `verification_error` | `PROTOCOL_ERROR` | The engine's generic fallback |
| anything unrecognised | `PROTOCOL_ERROR`, raw code retained | A new engine code must fail safely and visibly |

`fetched` maps to "still awaiting the wallet": the wallet has collected the request object but has
not responded. An unrecognised status also maps to awaiting, never to a terminal outcome — settling
a transaction on a guess would be worse than waiting.

---

## 5. Retention — mandatory, not advisory

The engine persists presentation content on its session rows: `SessionEntity.credentials` carries
the disclosed payload and `credentialPayload` can carry inline issuance claims. Defaults:
`SESSION_TTL` 86 400 s, `SESSION_CLEANUP_MODE` `full`, tidy-up hourly.

The platform therefore calls `PUT /session-config` **before creating any session**, so none can
exist under the 24-hour default:

```json
{ "ttlSeconds": 300, "cleanupMode": "anonymize" }
```

- `ttlSeconds` is the transaction lifetime, floored at the engine's minimum of 60. The adapter
  clamps rather than letting the engine reject the call.
- `anonymize` rather than `full`, so the id, status and timestamps the platform reconciles against
  survive while the content does not.

Compose sets the same values as globals, so the floor is safe even before the per-tenant call
lands, and additionally: `LOG_SESSION_STORE=off` (session logs are a second content store),
`LOG_ENABLE_HTTP_LOGGER=false`, bounded `AUDIT_LOG_RETENTION_DAYS` and
`AUDIT_LOG_MAX_ENTRIES_PER_TENANT` (both default to disabled, i.e. unbounded growth), and
`DB_SYNCHRONIZE=false`.

**Open:** that `anonymize` nulls every content-bearing field is taken from the engine's
documentation and entity definitions, not from an empirical test. See
[`security-limitations.md`](security-limitations.md) V2.

The platform never reads the engine's database directly, only its API — a second reason the two
databases are separate.

---

## 6. Result delivery — polling by default

The engine offers webhooks, polling and SSE. **The platform polls `GET /session/{id}`.**

The engine's outbound webhooks authenticate with a static `apiKey`, `bearerToken` or `basic`
credential and carry **no payload signature, no timestamp and no event id**, while
`presentation.completed` carries `presentedClaims` — the claims themselves. Polling removes that
inbound hop entirely.

If the webhook is enabled later as a latency optimisation: internal network only, bound to a
per-engine-tenant bearer secret, correlated to a known platform transaction via the engine session
id with unknown callbacks dropped, and idempotent platform-side since the engine supplies no event
id. That is independent of the platform's own customer-facing webhook, which is HMAC-signed with a
timestamp and an event id.

---

## 7. Access certificates — import, not registrar enrolment

The engine can enrol access certificates from a registrar, and ships exactly one preset: the
German Sandbox at `https://sandbox.eudi-wallet.org/api`.

**That preset cannot produce a certificate the official Reference Implementation will accept.** The
wallet accepts only the seven `EUDIW WRPAC Provider - {EE,NL,CZ,EU,LU,PT,UT} 02` anchors from
`https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt`
(`AS-WP-06-005`, `RPA_04`), and there is no `DE` entry. Blockers B1 and B2.

V0 therefore imports instead. `POST /key-chain/import` takes:

```json
{
  "key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "d": "…" },
  "usageType": "access",
  "description": "access certificate for service age-gate",
  "crt": ["-----BEGIN CERTIFICATE-----…"]
}
```

An **EC private key in JWK form** plus a certificate chain, leaf first — **not** a PKCS#12 blob.
The engine's web wizard accepts P12 files because the UI converts them; the API does not.
`scripts/import-access-certificate.sh` does the conversion with `openssl`. Corrected from the
Phase 0 note in [`interop-findings.md`](interop-findings.md) A8.

The returned key-chain id becomes `accessKeyChainId` on the presentation configuration, which is
how the engine selects the key that signs the request object. The platform stores only that opaque
reference.

---

## 8. What the adapter builds, and what it hides

**Built inside the adapter:** the DCQL query (`meta.vct_values` for SD-JWT VC per OpenID4VP Annex
B.3.5, `meta.doctype_value` for mdoc per Annex B.2.3 — the field name the engine's v7.3.0 release
fixed to match its schema), the presentation configuration, `statusCheckMode`, and the
`accessKeyChainId` wiring.

**Produced by the engine and never surfaced:** the `x509_hash:` client id, the signed request
object, `direct_post.jwt`, `walletNonce`, `response_code`, the session id.

**Passed through opaquely:** the interaction URI. The engine returns both `uri` (carrying the
post-completion redirect — the same-device variant) and `crossDeviceUri` (without it). The platform
selects by `interactionType` and never parses either.

The DCQL credential id is derived from the credential type, not from the transaction. It travels to
the wallet, so a per-transaction value would be a correlation handle.

A boundary check (`pnpm boundaries`) fails the build if any of this vocabulary appears outside
`packages/eudiplo-adapter`.

---

## 9. Complementary over-asking prevention

Both the engine and the platform check, at different granularities. They are complementary, not
redundant:

| Layer | When | Granularity | Outcome |
|---|---|---|---|
| **Platform** | policy publication | claim path | HTTP 422 naming every offending path |
| Engine | request time | credential, against the registration certificate's authorised `credentials` | Request rejected |
| Wallet (`EW-DM-44-027`, `RPRC_21`) | presentation request | attribute | User warned |

The engine also auto-derives `registrationCert.body.credentials` from the DCQL when not set,
forwarding only `format`, `claims` and `meta` and stripping `id`, `multiple` and
`trusted_authorities`.

The platform's check is the only one that fires before any customer traffic and before any User
sees a warning.

---

## 10. What the platform does **not** delegate

- **Tenant isolation.** The engine's isolation is a `tenantId` column, which its own documentation
  calls row-based with stronger options as future work. The platform isolates its own data and
  proves it with cross-tenant rejection tests; the engine's column is a second, weaker layer.
- **Trust-anchor management.** The engine normalises LoTEs and Trusted Lists into one store and
  exposes cache controls, which satisfies the shape of `EW-PIO-01-029` (`OIA_15b`). It does not
  discharge `EW-PIO-01-028` (`OIA_15a`)'s duty to refresh lists and remove invalidated anchors from
  every Instance. Not implemented in V0 — `security-limitations.md` K3.
- **Revocation irreversibility.** `AS-AP-07-007` (`VCR_04`) states a revocation shall not be
  reversed; the engine accepts a transition back to valid. The platform must refuse un-revocation
  in Milestone 2 — `interop-findings.md` B1.
- **The customer-facing contract, policy decisions, the evidence model.** The engine has no view of
  them.

---

## 10A. Engine schema lifecycle — **development default, with an upgrade warning**

The engine's database needs `DB_SYNCHRONIZE=true` to come up at all on an empty database, and
`false` for everything after that. Getting this wrong in either direction breaks something, so it
is worth stating precisely. All of this was verified against the pinned v7.6.0 image on
11 September 2026.

### What the engine actually does

It **does** have migrations — 45 of them under `dist/database/migrations/`, run on start because
`DB_MIGRATIONS_RUN` defaults to true. So migrations are its supported mechanism for *evolving* a
schema, which is what `v7.3.0`'s changelog note about "the session columns that no migration ever
created" is about.

What it does **not** have is a migration that creates the initial schema.
`BaselineMigration1740000000000` is, in full, a branch and two log lines:

```js
const tables = await queryRunner.getTables(["tenant_entity"]);
if (tables.length > 0) {
  console.log("[Migration] Existing database detected. Marking baseline as complete.");
  return;
}
console.log("[Migration] Fresh database detected. Schema will be created by TypeORM synchronize.");
console.log("[Migration] Ensure DB_SYNCHRONIZE=true is set for initial setup.");
```

It creates nothing by design. Every later migration then finds no tables and skips, and the engine
crash-loops at bootstrap on `relation "client_entity" does not exist`.

`DB_SYNCHRONIZE` itself defaults to **true**, and its own description is unambiguous about the
other half:

> Enable TypeORM schema synchronization. **Set to false in production after initial setup and rely
> on migrations instead.**

### The two phases

| Phase | `ENGINE_DB_SYNCHRONIZE` | Why |
|---|---|---|
| First start, empty database | `true` | Nothing else can create the schema |
| Every start after that | **`false`** | The engine's own instruction. Migrations carry it forward |

`docker-compose.yml` defaults to `${ENGINE_DB_SYNCHRONIZE:-true}` so that a first
`docker compose up` works out of the box. **That default is a development convenience, not a
recommendation.**

> ⚠️ **Upgrade warning.** Leaving `DB_SYNCHRONIZE=true` means TypeORM reconciles the live schema
> against the entity definitions on **every** start. On a project shipping releases roughly weekly
> — six in 27 days at the time of Phase 0, including a CommonJS-to-ESM migration — that is how a
> database silently diverges between two deployments, or loses a column to an entity rename that a
> migration would have handled deliberately. It also means the engine's own migrations never run
> against a schema they expect, so a later migration can fail in ways that are hard to unpick.
> **Set it to `false` in `.env` immediately after the first successful start**, and treat any
> engine upgrade as a reviewed change with a database backup, exactly as the digest pin intends.

### Why this does not reach the platform's own database

Two separate PostgreSQL instances, which is one of the reasons ADR 0001 and ADR 0004 chose that
split. The platform's database has **no** auto-synchronisation anywhere, no code path that creates a
table outside a checked-in migration, and a checksum-verifying migrator that treats an edited
applied migration as a hard failure. The engine's schema management cannot reach it.

An upstream issue is **drafted but not filed** at
[`docs/upstream/eudiplo-baseline-migration.md`](upstream/eudiplo-baseline-migration.md).

## 10B. Engine gap register

Every divergence between what the engine does and what the ARF or an ETSI specification requires,
in one place, with the reference, the impact and whether a workaround exists. Populated from the
running v7.6.0 container, not from its documentation.

**None of these is worked around by rewriting or re-signing engine output.** Doing that would put the
platform in front of the engine's protocol surface, which is what the wrapped-engine architecture
exists to avoid, and would make the platform the author of artefacts it does not control. Where there
is no workaround, the register says so and the requirement is not claimed.

| # | Gap | Reference | Impact | Workaround | Upstream |
|---|---|---|---|---|---|
| **G1** | **Credential Issuer metadata is not signed.** `signed_metadata` has zero occurrences in the compiled source | ARF 3.0.0 **§6.6.2.2** expects the metadata to be signed and verified by the Wallet; OpenID4VCI defines `signed_metadata`; ETSI TS 119 472-3. The pinned wallet enforces it via `requireSignedMetadata()` → `IssuerMetadataPolicy.RequireSigned` | **Blocking.** Trust gate (a) cannot be satisfied, so a Wallet cannot authenticate the Attestation Provider before issuance. Part of blocker **B7** | **None, by choice.** Signing or rewriting the metadata in the platform is explicitly rejected: it would make the platform the author of the issuer's metadata and duplicate the engine's OpenID4VCI surface. A contract test asserts `metadataSigned === false` so a later release that adds support fails the test rather than silently changing what is claimed | [`eudiplo-signed-metadata.md`](upstream/eudiplo-signed-metadata.md) — drafted, **not filed** |
| **G2** | **An imported registration certificate is never emitted as `verifier_info` without a configured live registrar.** `oid4vp.service.js` guards it with `registration_cert && isEnabledForTenant(tenant)`; `isEnabledForTenant` is `!!config`; `saveConfig` calls `testCredentials` before persisting | **`EW-DM-44-023` (`RPRC_19`)** — a Relying Party Instance SHALL include a single applicable registration certificate in each presentation request, by value, in proximity and remote flows | **Blocking.** `RPRC_19` is not satisfied and is not claimed. Expect `EW-DM-44-019` (`RPRC_17`) warnings from any Wallet that checks. **Inherited by PID-during-issuance**, because that makes the issuer a Relying Party | **None.** The platform side is complete and verified up to the engine's gate; the emission gate is the engine's. The contract test for it **skips with a logged reason** when no registrar is configured, so it turns green by itself if this is fixed | [`eudiplo-registration-cert-verifier-info.md`](upstream/eudiplo-registration-cert-verifier-info.md) — drafted, **not filed** |
| **G3** | **OpenAPI document contradicts the runtime validator on five presentation-config fields.** `registrationCertImportJwt`, `registrationCertImportId`, `registrationCertBodyPrivacyPolicy`, `registrationCertBodySupportUri`, `registrationCertBodyIntermediary` are declared `{type: "array", items: {type: "string"}}`; the validator requires a **string** and rejects an array with `expected string, received array` | Not an ARF requirement — an engine-internal inconsistency. Matters because generated clients follow the document | **Low, once known.** A generated client emits a request the engine rejects. Found on first contact; would otherwise have surfaced only when a real certificate arrived | **Yes.** The adapter sends a string and a contract test pins it. The register exists so the next person does not re-derive this from the document | [`eudiplo-openapi-validator-mismatch.md`](upstream/eudiplo-openapi-validator-mismatch.md) — drafted, **not filed** |
| **G4** | **No migration creates the initial schema.** `BaselineMigration` is a branch and two log lines; `DB_SYNCHRONIZE=true` is required for first boot | Not an ARF requirement. The engine's own `DB_SYNCHRONIZE` description says to set it false in production and rely on migrations — which cannot be followed from a clean start | **Operational.** A fresh deployment cannot be brought up by migrations alone | **Yes**, two-phase: `true` for the first start, `false` after. Documented in §10A with an upgrade warning | [`eudiplo-baseline-migration.md`](upstream/eudiplo-baseline-migration.md) — drafted, **not filed** |
| **G5** | **Four issuance payload shapes are accepted-then-wrong**: `usageType` enum excludes `signing`; `credentialClaims` is a tagged union; `registrationCertificate` needs `enabled` *and* `mode`; `authorizationServers` is discriminated on `type` and an untagged entry is ignored | Not an ARF requirement — engine contract surface | **Low, once pinned.** A test asserting only "the call succeeded" passes on four of them, which is why they are pinned by contract tests that decode output | **Yes**, all five pinned by `tests/adapter/issuance-contract.test.ts`. `interop-findings.md` A14 | Not raised: these are contract details, not defects |
| **G6** | **Engine tenant roles cannot be widened after creation.** `PATCH /api/tenant/{id}` rejects a `roles` key; a tenant cannot grant its clients roles it lacks | Not an ARF requirement | **Operational.** A tenant provisioned too narrowly must be recreated | **Yes.** Create the tenant with every role it will need; `.env.example` lists them. `interop-findings.md` A16 | Not raised: arguably correct behaviour |
| **G7** | **The engine's generic error envelope leaks into the OpenID4VP `direct_post` response.** On a failed presentation its response body is `{statusCode, timestamp, path, redirect_uri}` — the NestJS error shape, not the protocol one | **OpenID4VP 1.0 Final §8.2** defines what the direct-post response may contain. Found by the OIDF conformance suite, which flagged *"Direct post response object contains unexpected keys"* | **Low, but real.** A Wallet parsing the response strictly could be confused by the extra keys, and `path` discloses internal routing. The platform never sees or shapes this response — it is engine-to-wallet | **None needed by us**, and none available: the response is the engine's. Recorded so it is not rediscovered, and because only an adversarial peer finds it — our contract tests assert on the engine's management API and on request objects, never on what it returns a wallet on the error path | [`eudiplo-direct-post-error-envelope.md`](upstream/eudiplo-direct-post-error-envelope.md) — drafted, **not filed** |
| **G8** | **There is no way to publish the Attestation Provider's access certificate in the Credential Issuer metadata.** `IssuanceConfig` carries `signingKeyId` and `registrationCertificate` and no access-certificate field; `issuer_info` is assembled in one place (`oid4vci.service.ts`, `appendIssuerRegistrationCertificateInfo`) which only ever pushes `format: "registration_cert"` | ARF 3.0.0 **§6.6.2.2** expects the metadata to carry the provider's **access certificate and** its registration certificate; ETSI TS 119 472-3 | **Blocking, and it compounds G1.** Gate (a) is missing both the signature over the metadata and one of the two certificates the metadata should carry. An EAA Provider access certificate obtained at registration has nowhere to go at this version | **None.** The field does not exist, and adding it to the metadata ourselves would make the platform the author of the issuer's metadata — the same reason G1 has no workaround. The access certificate is still worth obtaining: PID-during-issuance uses one, and that path does work | Not yet drafted. Belongs with G1, since both are gate (a) |

### How to read this register

**G1, G2 and G8 are the ones that matter.** They are the reason two ARF requirements are not satisfied, and
neither has a workaround that does not compromise the architecture — and **G8 was found while preparing
the certificate intake runbook**, when the EAA Provider's access certificate turned out to have nowhere to
go. G1 and G8 are both gate (a), which is therefore short of two things rather than one. G3–G6 are
contract friction: real, worth recording so nobody re-derives them, and all handled. **G7** came from the OIDF conformance suite
rather than from us — see [`conformance-results.md`](conformance-results.md) — which is the argument for
running that suite: it looks at the engine's wallet-facing error path, which our own tests never do.

Nothing in this register has been filed upstream. **Five drafts** exist in
[`upstream/`](upstream/) — G1, G2, G3, G4 and G7; filing is a human decision, and each draft says so.
G8 is not yet drafted and belongs with G1.

## 11. Adoption gates still open

[`eudiplo-assessment.md`](../../05-eudi-services/eudiplo-assessment.md) set six gates. Gate 1
(pin a release and map every used feature) is what Phase 0 and this document do. Gates 2–6 —
conformance and cross-wallet tests, a threat model covering tenant isolation, SSRF, key custody,
trust caches and the admin API, a replaceability proof, SLO/HA/DR evidence, and an Apache-2.0
notice and supply-chain review — remain open and belong to productionisation.
