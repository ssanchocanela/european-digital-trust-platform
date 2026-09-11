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

## 11. Adoption gates still open

[`eudiplo-assessment.md`](../../05-eudi-services/eudiplo-assessment.md) set six gates. Gate 1
(pin a release and map every used feature) is what Phase 0 and this document do. Gates 2–6 —
conformance and cross-wallet tests, a threat model covering tenant isolation, SSRF, key custody,
trust caches and the admin API, a replaceability proof, SLO/HA/DR evidence, and an Apache-2.0
notice and supply-chain review — remain open and belong to productionisation.
