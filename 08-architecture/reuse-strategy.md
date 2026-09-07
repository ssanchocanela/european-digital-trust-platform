# Reuse Strategy

**Assessment date:** 7 September 2026  
**Status:** [PRODUCT] working architecture decision; revalidate against pinned releases before implementation

## Principles

1. Reuse official EUDI RI components first for wallet-side behavior and conformance examples.
2. Treat EUDIPLO as an independently governed server-side accelerator, not as the platform by default.
3. Keep platform-owned business APIs, policy, tenancy and evidence models independent of protocol engines.
4. Never infer regulatory compliance from open-source interoperability.

## Three-layer matrix

| Capability | Official EUDI RI | EUDIPLO | Custom development? | Strategy | Rationale |
|---|---|---|---|---|---|
| Wallet app/core | Mobile apps, Wallet Core/Kit and protocol libraries | Not a wallet | Only product-specific UX/integration | `REUSE` official RI | Avoid a proprietary wallet implementation |
| OID4VCI issuer | Test/demo issuer services and libraries exist | Implemented issuer, offers, authorization/pre-authorized/deferred flows, metadata and notifications | Stable customer API, policy and assurance controls | `WRAP` EUDIPLO; `REFERENCE` RI demos | EUDIPLO fits the server-side abstraction; benchmark against official clients/tests |
| OID4VP verifier | Remote/proximity test components exist | Implemented request/session/validation flows using DCQL | Business policy and normalized result contract | `WRAP` EUDIPLO; `REFERENCE` RI | Preserve engine replaceability and independent decision/audit policy |
| Digital Credentials API | Wallet-side libraries/examples | OID4VP and ISO 18013-7 browser flows documented/implemented | Browser integration SDK, feature detection and fallback UX | `EXTEND`/`WRAP` | Browser support and ecosystem behavior remain moving targets |
| Credential formats | SD-JWT VC and mdoc in current wallet flows | Issues/verifies `dc+sd-jwt` and `mso_mdoc` | Canonical platform model and format adapters | `REUSE` libraries, `WRAP` formats | Do not leak format-specific payloads into business APIs |
| Status | RI support varies by component/roadmap | OAuth Token Status List, JWT for SD-JWT VC and CWT for mdoc | Lifecycle authority, policy, evidence and operational SLAs | `EXTEND` EUDIPLO | Status mechanism is not the complete lifecycle product |
| Trust resolution | RI implements relevant wallet-side trust features incrementally | ETSI LoTE/trust lists, X.509 chains, registration/access certificates and OpenID Federation paths are present | Authoritative source governance, cache policy, fail-closed rules and admin workflows | `EXTEND` behind platform interface | Trust support is substantial but ecosystem onboarding/governance is broader |
| Keys and signing | Platform-specific wallet secure-component integration | Local/PKCS#11/cloud KMS paths and pluggable storage | HSM/KMS policy, custody, rotation, separation of duties | `WRAP` | Deployment choice cannot establish qualified status |
| Multi-tenancy/admin | Not a managed-service control plane | Tenant/client/config model and admin UI/API | Commercial tenancy, quotas, billing, support and delegated administration | `EXTEND` | Useful base, incomplete SaaS product layer |
| Monitoring/deployment | Component-specific build/deploy guidance | Docker Compose, Kubernetes, PostgreSQL/MySQL/SQLite, OpenTelemetry stack | Production SRE, HA/DR, regionalization and supply-chain controls | `REUSE` templates; `EXTEND` operations | Templates accelerate deployment but do not prove production readiness |
| Business Wallet | Not its purpose | Not provided | Yes | `REFERENCE` ARF; `BUILD` | Organisation workspace, roles and workflows are a separate product/regulatory domain |
| Mandates/representation | Some natural-person representation topics exist in ARF | No complete mandate authority/workspace | Yes | `BUILD` with authentic-source/QTSP integrations | Legal semantics and revocation sources are jurisdiction/use-case specific |
| QES/QSeal/QERDS | RI has RQES-related wallet modules | Not a complete qualified trust service | Yes, mainly orchestration/integration | `REUSE` RI UX where relevant; `WRAP` QTSPs | Qualification and liability remain at the qualified provider boundary |
| DPP registry/data | Not provided | Not provided | Yes | `BUILD` adapters and module | Registry registration is distinct from DPP data hosting |

## EUDIPLO component decisions

| Component area | Decision | Conditions |
|---|---|---|
| Backend issuer/verifier engine | `WRAP` | Pin a tested release; expose platform-owned contracts; retain exit path |
| Core SDK and schemas | `REUSE`/`REFERENCE` | Confirm API stability and license notices per release |
| Admin web client | `REFERENCE` initially | Product UX, RBAC and operational workflows require redesign |
| Tenant/config model | `EXTEND` | Validate isolation, delegation, retention and portability requirements |
| Key management adapters | `WRAP` | Threat model, HSM/KMS assurance and key ceremonies are platform-owned |
| Trust modules | `EXTEND` | Validate ARF 3.0/technical-spec versions and authoritative trust sources |
| Docker/Kubernetes/observability assets | `REUSE` for PoCs | Harden for production; add HA/DR, SLOs and supply-chain controls |
| Business Wallet, QERDS and DPP | `NOT REQUIRED` from EUDIPLO | Develop/integrate outside the protocol engine |

## Evidence behind the assessment

The EUDIPLO `main` branch inspected at commit `1885065b54797a9eb4a9deffeeaef11380071477` contains a TypeScript/NestJS backend, client, CLI, documentation, KMS reference app, webhook app, SDK package, deployment manifests and monitoring stack. Backend modules cover issuer, verifier, sessions, trust, registrar integration, status lists, keys, tenants, audit log, storage and webhooks. The repository is Apache-2.0. Release cadence and recent breaking migrations indicate active development; “production-ready” must remain an evaluation outcome, not an assumption.

See [EUDIPLO assessment](../05-eudi-services/eudiplo-assessment.md), [RI reuse map](../09-product-roadmap/reference-implementation-reuse.md), and [open gaps](../09-product-roadmap/gaps.md).
