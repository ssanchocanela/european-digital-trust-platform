# Issuance Service MVP

**Status:** [EXPERIMENTAL] learning roadmap, not production readiness

## MVP 1 — Vertical slice

Prove that the platform-owned product layer can make a configured issuance decision and deliver an interoperable credential through a wrapped protocol engine.

| Scope | MVP 1 decision |
|---|---|
| Tenancy | One Tenant, one Issuer |
| Catalogue | One Credential Type and one versioned configuration |
| Source | One external Authentic Source through one REST connector |
| Policy | One configurable, explainable eligibility rule; technology [OPEN] |
| Delegation | Platform retrieval, eligibility, approval-by-policy, issuance and lifecycle; source remains external |
| Credential/protocol | `dc+sd-jwt`, OpenID4VCI pre-authorized-code flow, QR offer |
| Security/trust | Platform-managed development signing; explicit test trust configuration |
| Lifecycle | Basic active/revoked status and customer-triggered revocation |
| Evidence | Minimal transaction/audit trail with policy/config versions and source reference |
| Interoperability | Successful issuance to an official EUDI Reference Wallet build |
| Engine | EUDIPLO behind the platform EUDI adapter |

### MVP 1 success criteria

- Source unavailability, ineligibility, duplicate request, expired offer and revocation paths are tested.
- The business API contains no OpenID4VCI or EUDIPLO-specific contract requirements.
- A transaction explains which source observation and policy/config versions produced the decision without persisting unnecessary source payloads.
- Adapter contract tests demonstrate that business state is independent of EUDIPLO session identifiers.

## MVP 2 — Delegation and breadth

- Real multi-tenancy with isolation tests and multiple Credential Types.
- Multiple Authentic Sources for at least one Credential Type and reconciliation behavior.
- Customer-, platform- and hybrid Delegation Profiles, including final approval workflow.
- Authorization-code flow and `mso_mdoc` alongside MVP 1 capabilities.
- Source/platform-driven renewal, update, suspension and revocation automation.
- Stronger trust/registration integration and configuration promotion.

## Productionisation — separate workstream

Production readiness separately addresses HA/DR, formal security architecture, HSM/KMS strategy, observability, tenant isolation, regulatory onboarding, authoritative trust infrastructure, privacy/DPIA inputs, conformance, support/SLA model, vulnerability management, SBOM/software supply chain, incident response and data residency.

## Explicit exclusions and open questions

- No production claim, qualification or certification is an MVP outcome.
- No general-purpose rules engine is selected.
- No commitment is made to SOAP, database, event or batch connectors in MVP 1.
- `[OPEN] Requires legal/regulatory analysis.` Technical execution does not settle the legal Attestation Provider for EAA, PuB-EAA or QEAA.

See the [issuance architecture](../08-architecture/issuance-service-architecture.md) and [gaps](gaps.md).
