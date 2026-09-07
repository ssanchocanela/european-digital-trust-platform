# Issuance as a Service

**Status:** [PRODUCT] / [EXPERIMENTAL]

## Target users

- small and medium public administrations;
- universities and educational bodies;
- professional organisations;
- public agencies;
- SMEs and sector credential issuers.

## Proposition

```mermaid
sequenceDiagram
  participant B as Business system
  participant P as Platform API
  participant I as Issuer engine
  participant T as Trust/KMS/status services
  participant W as EUDI Wallet
  B->>P: Create issuance transaction + claims reference
  P->>P: Authorize tenant, schema and policy
  P->>I: Create protocol session
  I->>T: Resolve signing key and issuer configuration
  I-->>B: Offer URI / delivery instructions
  W->>I: OpenID4VCI authorization and credential request
  I->>P: Resolve approved attributes (as late as possible)
  P-->>I: Minimal claims
  I->>T: Sign and assign status entry
  I-->>W: Credential
  I-->>P: Outcome event (no unnecessary credential copy)
  P-->>B: Normalized status/webhook
```

The customer should interact through a simple API/workflow while the service handles protocol, credential format, cryptography, trust, status and interoperability concerns.

## Initial scope

- Authorization-code and pre-authorized-code offers; deferred issuance only where a use case needs it.
- `dc+sd-jwt` and `mso_mdoc` through format-neutral business contracts.
- Issuer metadata, keys/certificates, status, notifications and wallet interoperability tests.
- Attribute-provider callback or just-in-time claims, minimizing platform retention.

## Boundaries

- [SPECIFICATION] OID4VCI compatibility does not prove that an issuer is authorized or trusted for a credential type.
- [PRODUCT] The business system remains authoritative for eligibility and source data unless explicitly contracted otherwise.
- [OPEN] Rulebooks, registration, access/registration certificates, wallet attestation and status requirements must be selected per scheme.

See [API concepts](api-concepts.md), [onboarding](onboarding.md), and [EUDIPLO assessment](eudiplo-assessment.md).
