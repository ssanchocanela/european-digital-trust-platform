# Issuer Trust and Registration

**Status:** [REGULATORY] / [IMPLEMENTING-ACT] / [SPECIFICATION] / [PRODUCT-HYPOTHESIS] / [OPEN]

Issuer onboarding is not one generic “trust-list registration.” Each regime has a different legal and technical trust path.

| Regime | Legal provider | Binding establishment of status | Wallet/provider trust path | Platform position |
|---|---|---|---|---|
| EAA | `[REGULATORY]` Non-qualified trust service provider | `[REGULATORY]` General trust-service supervision; sector/scheme rules. No universal qualified-status procedure. | `[SPECIFICATION]` Provider access/registration artefacts plus scheme-defined trust; ARF notes non-qualified trusted lists may exist but are out of scope. | `[OPEN]` Automate only against the selected Member State/scheme process. |
| PuB-EAA | `[REGULATORY]` Responsible public body or Member-State-designated public body | `[REGULATORY]` Article 45f notification with CAB report; `[IMPLEMENTING-ACT]` Member State notification and Commission provider list under Regulation 2025/1569 Articles 5-6 | `[SPECIFICATION]` PuB-EAA Provider LoTE/signature validation; binding list remains the legal reference. | `[PRODUCT-HYPOTHESIS]` Prepare evidence and monitor state; cannot self-register/designate provider. |
| QEAA | `[REGULATORY]` QTSP for QEAA service | `[REGULATORY]` Articles 20-22: CAB report, supervisory grant, national trusted-list entry before service starts | `[REGULATORY]` Article 22 trusted list and Annex V QTSP signature/seal; `[SPECIFICATION]` provider access/registration checks for Wallet issuance | `[PRODUCT-HYPOTHESIS]` Integrate QTSP; cannot synthesize qualified status. |

## Provider access material is not legal status

`[IMPLEMENTING-ACT]` Regulation 2024/2982 Article 4 requires the Wallet to request issuance from a party with a valid access certificate carrying the expected provider entitlement. `[SPECIFICATION]` ARF 3.0 trust model additionally checks matching provider/service identifiers and registered attestation types in registration certificates.

`[INFERENCE]` These artefacts authenticate the endpoint and convey registered entitlement; they do not independently make a private entity a QTSP, designate a PuB provider, prove the Authentic Source relationship, or replace the qualified/PuB trust source.

## Onboarding state machine

`[PRODUCT-HYPOTHESIS]` Use explicit states per provider/service/environment:

```text
draft -> evidence-collected -> externally-submitted -> approved/notified
      -> access-material-issued -> interoperable -> active
      -> suspended | expiring | revoked | ceased
```

Promotion to `active` requires independent proofs for legal role, scheme membership, authoritative trust-source state, access/registration certificates, key/certificate binding, provider metadata, status endpoints and interoperability. `[INFERENCE]` Never collapse them into one `trusted=true` flag.

## Evidence snapshot

`[PRODUCT-HYPOTHESIS]` Snapshot legal entity/provider identifier, regime and service, jurisdiction, source/designation basis, scheme/version, CAB report reference, notification/submission and authority decision, trusted-list/Commission-list/LoTE evidence, access and registration certificate chains/status, certificate policy, signing identity/key route, metadata, status endpoints, effective dates and operator delegations.

`[OPEN]` Resolve which production registrar issues provider access/registration artefacts, when the amended verification duties apply, and how the ARF LoTE representation maps to the Commission's binding PuB provider list in each production ecosystem.

## Sources

- [eIDAS consolidated](https://eur-lex.europa.eu/eli/reg/2014/910)
- [Implementing Regulation 2025/1569, current consolidated text](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02025R1569-20260811)
- [Implementing Regulation 2024/2982](https://eur-lex.europa.eu/eli/reg_impl/2024/2982/oj/eng)
- [ARF 3.0 provider roles](https://eudi.dev/3.0.0/main/03-roles-within-the-eudi-wallet-ecosystem/)
- [ARF 3.0 trust model](https://eudi.dev/3.0.0/main/06-trust-model/)
- [Technical Specification 2 — provider notification/publication](https://eudi.dev/3.0.0/technical-specifications/ts2-notification-publication-provider-information/)
