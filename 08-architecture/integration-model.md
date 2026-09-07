# Integration Model

Prioritise API-first integration with public administration backends, ERP/CRM/PIM/PLM systems, authentic sources, QTSPs, registries and wallet-facing protocols.

**Status:** [PRODUCT]

| Boundary | Preferred pattern | Key control |
|---|---|---|
| Customer systems | Versioned REST + signed webhooks; batch later | OAuth client/workload identity, idempotency |
| Wallets | Standard OID4VCI/OID4VP, DC API and required ISO paths | Conformance profiles, nonce/replay protection |
| Attribute/authentic sources | Just-in-time callback or scoped connector | Data minimization and source authority |
| Trust/registrar sources | Signed documents and versioned APIs | Allow-list, provenance, freshness, fail policy |
| KMS/HSM/QTSP | Provider adapters with purpose-specific keys | Separation of duties and evidence |
| DPP Registry | Dedicated versioned adapter | Distinguish registry record from DPP data |
| DPP hosts | Provider-neutral storage/resolution interface | Availability, integrity, access control |
| eDelivery/QERDS | Qualified-provider and/or Access Point adapter | Preserve qualified evidence semantics |

Protocol callbacks terminate at isolated edge endpoints and publish internal state transitions. No external provider's payload becomes the canonical domain model without validation and mapping.
