# Component Model

**Status:** [EXPERIMENTAL]

| Component | Owns | Must not own |
|---|---|---|
| API Gateway / SDKs | Stable contracts, auth context, quotas, idempotency | Protocol implementation |
| Tenant & Issuer Management | Commercial/security scopes, administrators, issuer contexts | Shared mutable tenant security state |
| Business Wallet Workspace | Organisation UI, tasks, approvals, portfolio | Authoritative mandate source |
| Organisation & Mandate Service | Users, roles, evaluated authority, delegation workflows | Natural-person wallet or national source of truth |
| DPP Management | Portfolio, lifecycle and adapters | Complete Registry implementation |
| Issuance Product Service | Credential catalogue, Delegation Profiles, policy orchestration and lifecycle decisions assigned to the platform | Authentic Source authority |
| Authentic Source Connectors | Purpose-bound access, normalization, provenance, availability and source events | Claiming authority over source data |
| Policy & Approval | Eligibility/issuance evaluation and human/system workflows | Protocol/credential serialization |
| Issuance Orchestrator | Transaction state, responsibility hand-offs, configuration snapshots and EUDI commands | Customer-facing protocol leakage |
| Verifier Gateway | Requests, normalized validation result | Undifferentiated “trust” decision |
| Platform EUDI Adapter | Canonical-to-engine mapping, normalized errors/events and contract tests | Business policy or source semantics |
| Wrapped protocol engine | OID4VCI/OID4VP/DC API/format mechanics | Eligibility, approval, product APIs or commercial tenancy |
| Credential Lifecycle | Validity, renewal, update, suspension, revocation and expiry actions | Authentic Source authority |
| Trust Resolution | Lists, chains, certificates, status and freshness | Business acceptance policy |
| Crypto/QTSP adapters | KMS/HSM and qualified-service integration | Pretending generic signing is qualified |
| QERDS/eDelivery adapter | Communication transport/provider abstraction | Qualification itself |
| Registry adapters | Versioned external registry integration | DPP data hosting |
| Audit & Evidence | Minimal traceability and evidence references | Raw credential archive |

Components may begin in one deployment; these ownership boundaries preserve future separation and replaceability. See the [issuance service architecture](issuance-service-architecture.md).
