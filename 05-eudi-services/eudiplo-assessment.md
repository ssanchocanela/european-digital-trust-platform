# EUDIPLO Assessment

**Assessment date:** 7 September 2026  
**Code inspected:** `openwallet-foundation/eudiplo` `main` at `1885065b54797a9eb4a9deffeeaef11380071477`  
**License:** Apache-2.0  
**Overall decision:** `WRAP` as a candidate protocol engine; do not make it the product core yet

EUDIPLO is a headless HTTP middleware for issuer and verifier roles. It is unusually close to the EUDI Services product thesis, but its active evolution, protocol-version sensitivity and incomplete coverage of platform/business responsibilities make an anti-corruption layer essential.

## Capability findings

| Question | Evidence-based finding | Classification |
|---|---|---|
| Issuer capabilities | Credential/config management, offers, authorization and pre-authorized flows, interactive/chained authorization, deferred issuance, metadata, notifications, attribute-provider and webhook integration, status-list management | `WRAP` |
| Verifier capabilities | Presentation configuration, request/session creation, DCQL, OID4VP response processing, SD-JWT VC/mdoc cryptographic and claim validation, status checks, same/cross-device paths and ISO 18013-7/DC API endpoints | `WRAP` |
| Protocols | OpenID4VCI 1.0 and OpenID4VP 1.0; Digital Credentials API paths; ISO 18013-7 Annex C for mdoc; OAuth Token Status List; optional OpenID Federation paths | `REUSE` behind adapter |
| Credential formats | `dc+sd-jwt` and `mso_mdoc`; JWT/CWT status-list encodings | `REUSE` behind canonical model |
| Trust management | X.509 chains, CRL validation, ETSI Lists of Trusted Entities/trust lists, `trusted_authorities`, registration/access-certificate workflows, registrar client and OpenID Federation extension | `EXTEND` |
| Consuming APIs | OpenAPI-described REST API, client-credentials authentication, tenant-scoped administration, sessions, issuer offers, verifier offers, status, keys, config bundles and webhooks; SDK generated from schemas | `WRAP` |
| Deployment | Node.js/NestJS monorepo; Docker images/Compose; Kubernetes manifests; SQLite, PostgreSQL and MySQL drivers; optional monitoring stack with OpenTelemetry, Prometheus, Grafana, Loki and Tempo | `REUSE` for PoC; `EXTEND` for production |
| Extensibility | Attribute providers, webhooks, interactive authorization endpoint, federation, pluggable storage/KMS, configuration import/export and SDK package | `EXTEND` |
| Dependencies | TypeScript/NestJS, TypeORM, OpenID4VC libraries, OWF crypto/mdoc/LoTE/status packages, JOSE/SD-JWT/X.509 packages, optional cloud/PKCS#11 integrations | `REFERENCE` for SBOM review |
| Maturity | Active releases and migrations, conformance and E2E tests, documented wallet compatibility; README calls it early development and moving releases include breaking changes/security fixes | `EXPERIMENTAL` until platform gates pass |
| ARF alignment | Strong functional alignment with current protocol, trust and registration concepts; exact ARF 3.0/TS conformance must be mapped per feature and release | `[OPEN] Requires validation.` |
| Official RI alignment | Documented tests with the EU Reference Wallet and protocols used by official wallet apps; not part of the official RI organisation | `REFERENCE`/interop candidate |

## Important gaps

EUDIPLO does not by itself supply:

- the organisation-centric Business Wallet workspace, legal representation and mandate semantics;
- qualified trust-service status, QTSP obligations, QES/QSeal or QERDS delivery;
- DPP registry integration, DPP lifecycle or complete DPP data hosting;
- authoritative scheme participation, notification or regulatory onboarding;
- the platform's customer-facing stable API, commercial tenancy, policy decisions, evidence model, billing or support operations;
- proof of production suitability, certification or compliance merely by being open source or conformance tested.

## Product boundary

`[PRODUCT]` EUDIPLO remains behind a platform-owned EUDI adapter/anti-corruption layer. The platform must not move Authentic Source semantics/connectors, eligibility or issuance policy, approval workflows, lifecycle orchestration, commercial tenant management or customer-facing product APIs into EUDIPLO. The adapter translates canonical platform commands, events and errors to the pinned EUDIPLO contract.

## Adoption gates

1. Pin a release and map every used feature to ARF 3.0, applicable technical specifications and implementing acts.
2. Run official/OIDF conformance and cross-wallet tests for each target flow and format.
3. Threat-model tenant isolation, SSRF/webhooks, key custody, trust caches, session retention and admin APIs.
4. Test replaceability through platform-owned issuer, verifier, status and trust interfaces.
5. Establish SLOs, HA/DR, database migration, observability and vulnerability-management evidence.
6. Complete Apache-2.0 notice, dependency-license and software-supply-chain review.

## Sources

- [EUDIPLO repository](https://github.com/openwallet-foundation/eudiplo)
- [Versioned documentation](https://openwallet-foundation.github.io/eudiplo/docs/latest/)
- [OpenAPI documentation](https://openwallet-foundation.github.io/eudiplo/docs/latest/reference/openapi/)
- [Releases](https://github.com/openwallet-foundation/eudiplo/releases)
- [Wallet compatibility](https://github.com/openwallet-foundation/eudiplo/blob/main/apps/docs/docs/reference/wallet-compatibility.md)

See [reuse strategy](../08-architecture/reuse-strategy.md).
