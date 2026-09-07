# Component Model

**Status:** [EXPERIMENTAL]

| Component | Owns | Must not own |
|---|---|---|
| API Gateway / SDKs | Stable contracts, auth context, quotas, idempotency | Protocol implementation |
| Business Wallet Workspace | Organisation UI, tasks, approvals, portfolio | Authoritative mandate source |
| Organisation & Mandate Service | Users, roles, evaluated authority, delegation workflows | Natural-person wallet or national source of truth |
| DPP Management | Portfolio, lifecycle and adapters | Complete Registry implementation |
| Issuer Gateway | Canonical issuance transactions | Source-system eligibility |
| Verifier Gateway | Requests, normalized validation result | Undifferentiated “trust” decision |
| Protocol engine | OID4VCI/OID4VP/DC API/format mechanics | Customer-facing stable product contract |
| Credential Lifecycle | Profiles, status authority and evidence | Business source data by default |
| Trust Resolution | Lists, chains, certificates, status and freshness | Business acceptance policy |
| Crypto/QTSP adapters | KMS/HSM and qualified-service integration | Pretending generic signing is qualified |
| QERDS/eDelivery adapter | Communication transport/provider abstraction | Qualification itself |
| Registry adapters | Versioned external registry integration | DPP data hosting |
| Audit & Evidence | Minimal traceability and evidence references | Raw credential archive |

Components may begin in one deployment; these ownership boundaries preserve future separation and replaceability.
