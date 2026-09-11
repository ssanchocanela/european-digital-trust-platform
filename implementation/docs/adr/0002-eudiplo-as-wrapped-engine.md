# ADR 0002 — EUDIPLO as a wrapped engine, and the tenant mapping

- **Status:** DRAFT (Phase 0), awaiting approval
- **Date:** 11 September 2026
- **Supersedes nothing.** Confirms the `WRAP` verdict in
  [`05-eudi-services/eudiplo-assessment.md`](../../../05-eudi-services/eudiplo-assessment.md) against
  a pinned release.

## Context

[`eudiplo-assessment.md`](../../../05-eudi-services/eudiplo-assessment.md) (7 September 2026) decided
`WRAP` — EUDIPLO as a candidate protocol engine behind an anti-corruption layer, not as the product
core — and set six adoption gates. It was written against unreleased `main` (see
[`knowledge-alignment.md`](../knowledge-alignment.md) KA-6). Phase 0 re-verified the capability map
against a release and must now decide the version to pin and, specifically, how the EUDIPLO tenant
maps onto the platform's domain.

## Decision 1 — Pin EUDIPLO v7.6.0 by digest

| | |
|---|---|
| Release | `v7.6.0`, published 2026-09-08 |
| Commit | `3b2a9e7163059db13019bdd1862240cbecb86201` |
| Image | `ghcr.io/openwallet-foundation/eudiplo:7.6.0` |
| Digest | `sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667` |
| Licence | Apache-2.0 |

Not `v7.2.0` as the prompt suggested, and not `:latest`. Two of the four releases since v7.2.0 carry
changes the platform depends on directly:

- **v7.5.0** added a persisted structured verification outcome (`SessionOutcome`) and a shared
  verification failure taxonomy, and made EUDIPLO accept presentation registration-certificate
  fields. The taxonomy is the basis for the adapter's outcome normalisation (Decision 4).
- **v7.6.0** added OpenID4VCI authorization-server-metadata and federation-trust caching and
  deduplication, and migrated the backend to native ESM.

Pinning v7.2.0 would mean reimplementing outcome classification from unstructured
`status: "failed"`, which is not reliably decidable (see Decision 4).

## Decision 2 — The port boundary

All interaction with EUDIPLO goes through platform-owned ports. No EUDIPLO type, identifier,
configuration object or error crosses them.

```
Platform domain
   ├── EudiVerifierPort ── EudiploVerifierAdapter ── EUDIPLO
   └── EudiIssuerPort   ── EudiploIssuerAdapter   ── EUDIPLO   (M2; interface only in M1)
```

`EudiVerifierPort`: `createPresentationRequest`, `getPresentationStatus`,
`processPresentationResult`, `cancelPresentation`.

Enforced mechanically, not by convention: EUDIPLO types exist only in
`packages/eudiplo-adapter`, and a CI check fails the build if any other package imports from that
package's internal modules or mentions EUDIPLO identifiers. The business API is separately asserted
to contain no EUDIPLO contracts, which is a Milestone 1 definition-of-done item.

Specifically kept **below** the port:

- DCQL. `dcql_query` is produced inside the adapter from the `VerificationPlan`, never in the domain.
- The EUDIPLO session id, retained only as internal correlation metadata.
- `x509_hash` client-id construction, `direct_post.jwt`, `walletNonce`, `response_code`.
- EUDIPLO's presentation and issuance configuration objects, webhook endpoint resources, key chains
  and status lists.
- The interaction URI, which is passed through **as an opaque value**.

## Decision 3 — Tenant mapping: one EUDIPLO tenant per `RelyingPartyInstance`

This is the decision the prompt's §3.3 specifically asks for, and the naive mapping is wrong.

EUDIPLO's tenancy is a `tenantId` column on every entity, with per-tenant keys, sessions,
configurations and registrar configuration. The tempting mapping is *platform `Tenant` →
EUDIPLO tenant*, since both are called "tenant". It does not hold, because the things EUDIPLO scopes
to a tenant are scoped by ARF to a **Relying Party Service**:

| EUDIPLO per-tenant resource | ARF scope | Citation |
|---|---|---|
| Access-certificate key chain | One RP identifier **and** one Service identifier | `AS-MS-27-043` (`Reg_32`), `AS-MS-27-045` (`Reg_33`) |
| Registrar configuration, from which `rpId` is derived and cannot be overridden per request | One EU-wide unique RP identifier, identical across all that entity's registration certificates | `EW-DM-44-013` (`RPRC_08`) |
| Registration certificates | One per (intended use × Service); the RPRC given to an Instance must carry that Instance's access-certificate Service identifier | `EW-DM-44-014` (`RPRC_09`), `EW-DM-44-015` (`RPRC_10`) |
| Session retention configuration | A per-customer privacy decision | — |

So:

> **One EUDIPLO tenant per platform `RelyingPartyInstance`**, where a `RelyingPartyInstance` is the
> platform-hosted instance serving one `RelyingPartyService` in one `trustEnvironment`.

A platform `Tenant` holding two Organisations with two Services each needs **four** EUDIPLO tenants.
Corollaries:

- `RelyingPartyInstance` holds the EUDIPLO tenant id as internal infrastructure metadata. It is
  never exposed in the business API.
- Each EUDIPLO tenant gets its own EUDIPLO client with the minimum roles —
  `presentation:config`, `presentation:request`, `key:manage` (M1), plus `issuance:config` and
  `issuance:offer` (M2) — and never `tenant:manage`, which EUDIPLO requires to be unbound from any
  tenant.
- Those clients additionally carry `allowedPresentationConfigs` (and, in M2,
  `allowedIssuanceConfigs`) restricted to that instance's configurations. EUDIPLO enforces this with
  `403`, giving defence in depth beneath the platform's own tenant isolation.
- One `PresentationPolicy` maps to one EUDIPLO presentation configuration inside that tenant, keyed
  by published policy version so an immutable published version always resolves to a stable engine
  configuration.
- Because the mapping is per Service, `RPRC_10`'s "same Service identifier" constraint is satisfied
  structurally rather than by validation.

This also means EUDIPLO's row-based isolation is **not** the platform's tenant-isolation mechanism.
The platform isolates its own data and proves it with cross-tenant rejection tests; EUDIPLO's
`tenantId` is a second, weaker layer, and the prompt's §8.3 isolation requirement is met in the
platform, not delegated.

## Decision 4 — Outcome normalisation branches on the failure code, never on the status

EUDIPLO session status is `active | fetched | completed | expired | failed`. **`failed` is not
decidable** — it covers trust failures, signature failures and protocol failures alike. The adapter
branches on the v7.5.0 taxonomy (`session.failureCode`, `outcome.error`):

| EUDIPLO signal | Platform terminal outcome |
|---|---|
| `completed`, `outcome.result: "success"`, policy satisfied | `VERIFIED` |
| `completed`, outcome success, policy not satisfied | `POLICY_NOT_SATISFIED` |
| `signature_invalid`, `certificate_expired`, `x5c_missing` | `REJECTED` |
| `no_trust_chain_to_root`, `trust_chain_not_trusted` | `TRUST_ERROR` |
| `trust_list_unavailable` | `TRUST_ERROR`, marked verifier-side |
| OpenID4VP error with `error: "access_denied"` | `DECLINED_BY_USER` |
| other OpenID4VP error, `verification_error`, timeout, transport failure | `PROTOCOL_ERROR` |
| `expired` | `EXPIRED` |
| platform-initiated `DELETE /session/:id` | `CANCELLED` |

Two refinements:

- `trust_list_unavailable` is documented by EUDIPLO as a verifier-side misconfiguration or outage,
  not a defect in the presented credential. The platform must not report it to the customer as a
  failed credential; it is our operational failure.
- `DECLINED_BY_USER` is best-effort by construction. `AS-WP-06-017` (`RPA_11`) requires the Wallet,
  on user denial, to "behave towards the Relying Party as if the attestation or PID did not exist".
  A denial is therefore not reliably distinguishable from non-possession. The platform reports
  `DECLINED_BY_USER` only when an explicit `access_denied` arrives, and the API documentation says
  plainly that its absence does not mean the user consented.

Any unmapped code maps to `PROTOCOL_ERROR` and is logged with the raw code, so a new EUDIPLO failure
code degrades safely instead of being silently misclassified.

## Decision 5 — Result delivery: poll by default

EUDIPLO offers webhooks, polling and SSE. **Polling `GET /session/:id` is the V0 default.** EUDIPLO's
outbound webhooks authenticate with a static `apiKey`, `bearerToken` or `basic` credential and carry
**no payload signature, no timestamp and no event id**, while `presentation.completed` carries
`presentedClaims` — the claims themselves. Polling removes that inbound hop entirely.

Where the webhook is enabled as an optimisation it must be: on the internal network only; bound to a
per-EUDIPLO-tenant bearer secret; correlated to a known platform transaction via the EUDIPLO session
id, with unknown callbacks dropped; and idempotent on the platform side, since EUDIPLO supplies no
event id. This is independent of the platform's own customer-facing webhook, which is HMAC-SHA256
signed with a timestamp and an event id per the prompt's §6.8.

## Decision 6 — V0 does not use EUDIPLO's registrar client

EUDIPLO can enrol access certificates from a registrar (`POST /registrar/access-certificate`), and
ships exactly one preset: "German Sandbox" at `https://sandbox.eudi-wallet.org/api`. The official
Reference Wallet trusts only the seven `EUDIW WRPAC Provider - {EE,NL,CZ,EU,LU,PT,UT} 02` anchors in
`https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt`, per
`AS-WP-06-005` (`RPA_04`). There is no `DE` entry. EUDIPLO's enrolment path therefore cannot produce
a certificate the official wallet will accept.

V0 instead: enrol out of band at the official RP Registration Service, then
`POST /key-chain/import` the PKCS#12 with `usageType: "access"`, leaf-first, and reference it from
the presentation configuration's `accessKeyChainId`. Registrar-driven enrolment is revisited when a
registrar whose Access CA is on the relevant LoTE is available. See
[`phase-0-findings.md`](../phase-0-findings.md) §5.4–§5.5, blockers B1 and B2.

## Decision 7 — Traceability cites versions, not "ARF 3.0.0 / TSn"

The Technical Specifications are not in the ARF repository and neither that repository nor the
attestation-rulebooks repository is tagged (see [`interop-findings.md`](../interop-findings.md) D1,
D2). `implementation/docs/traceability.md` therefore cites, per row:

> *(ARF HLR identifier | TS document + its internal version | repository commit SHA | retrieval date)*

Pinned for Phase 0: TS repository `ee91a294c833af5188726fd8c302c641212192aa` (2026-08-22), TS5 v1.5
(20.08.2026); rulebooks repository `36f8adcf914ac06cac18d685add04e0a8a06d685`, PID Rulebook v1.1.

## Consequences

- **Positive.** The engine is replaceable: the platform depends on `OfferResponse {uri,
  crossDeviceUri, session}`, the `SessionOutcome` taxonomy, `GET /session/:id`,
  `DELETE /session/:id` and `POST /session/revoke`. That is a small enough surface to re-implement
  against another engine, and small enough to cover with contract tests.
- **Positive.** The per-Service tenant mapping satisfies `RPRC_10` and `Reg_33` structurally and
  makes a shared platform RP identity impossible by construction — which is a control
  [`06-shared-capabilities/rp-registration-and-access.md`](../../../06-shared-capabilities/rp-registration-and-access.md)
  asks for.
- **Negative.** EUDIPLO tenant count grows with Services, not customers. Provisioning a Service
  becomes an engine-level operation, so `RelyingPartyInstance` creation must be transactional across
  platform and engine, with a reconciliation path for partial failure.
- **Negative.** Polling costs latency against a webhook. Accepted for V0; SSE is available later if
  latency matters.
- **Risk.** Release velocity (six releases in 27 days, NestJS 12/CommonJS in v7.5.0 followed by
  native ESM in v7.6.0, and a v7.3.0 fix for session columns no migration created). Mitigated by the
  digest pin, the hand-written typed client ([ADR 0001](0001-platform-technology.md)), and contract
  tests that run against a real container in a separately skippable suite.
- **Risk.** The adoption gates in `eudiplo-assessment.md` are **not** closed by this ADR. Gate 1
  (pin and map) is begun; gates 2–6 (conformance and cross-wallet tests, threat model,
  replaceability proof, SLO/HA/DR, supply-chain review) remain open and belong to productionisation.

## Status of claims

No conformance with ARF 3.0.0 or any Technical Specification is claimed. No production readiness is
claimed. EUDIPLO's own documentation describes the project as early development with breaking
changes across releases.
