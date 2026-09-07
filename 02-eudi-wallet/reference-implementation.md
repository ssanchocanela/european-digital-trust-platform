# Official EUDI Wallet Reference Implementation

**Assessment date:** 7 September 2026  
**Classification:** [SPECIFICATION] evidence source; [EXPERIMENTAL] implementation baseline

The official Reference Implementation (RI) is the first place to look for wallet-side functionality. Its official description says it is ARF-based, modular and built from reusable, business-agnostic components. It also warns that the software is an initial development release with limited scope and reduced production assurance. Reuse therefore requires component-level evaluation, version pinning, security review and interoperability testing.

## Relevant repository families

| Family | Current catalogue examples | Intended reuse |
|---|---|---|
| Wallet applications | Wallet UI App for Android and iOS | `REFERENCE` for end-to-end UX; `REUSE` only if this project later needs a wallet-side experience |
| Wallet coordination | Android Wallet Core and iOS Wallet Kit | `REUSE` for wallet-side orchestration after compatibility and security review |
| Issuance libraries | OpenID4VCI libraries for Kotlin and Swift | `REUSE` before writing equivalent mobile protocol code |
| Presentation libraries | OpenID4VP, SD-JWT and Presentation Exchange libraries; mdoc transfer/trust libraries | `REUSE` selectively; confirm current DCQL/profile paths and remove legacy assumptions |
| Storage/status | Android/iOS document storage and Token Status List libraries | `REUSE` candidates with device-security and privacy review |
| Issuer services | Python and Kotlin OID4VCI issuers, issuer frontend and status API | `REFERENCE` and interoperability fixtures; compare operational model with EUDIPLO |
| Verifier services/apps | Web UI, REST backend, RP registration demo and proximity verifier app/core | `REFERENCE`; proximity components may be reused where that channel is required |
| Supporting services | RP Registration, revocation, trust-list service/manager and RSSP links in the official catalogue | `REFERENCE`/`REUSE` only after component-specific maturity and deployment review |
| RQES components | Android/iOS CSC, core/kit and UI libraries plus signer/QTSP/SCA demos | `REFERENCE`/`REUSE` for wallet journeys; QTSP and qualified-service boundaries remain external |
| Test/conformance assets | Wallet, issuer and online/proximity verifier testing material | `REUSE` in compatibility gates where licensing and scope permit |

## Confirmed scope and limits

- [SPECIFICATION] Current wallet apps advertise OpenID4VCI 1.0 issuance, OpenID4VP 1.0 remote presentation with DCQL, ISO 18013-5 proximity, and RQES-related modules.
- [PRODUCT] The platform will not fork a proprietary wallet merely to provide issuance or verification services; those are server-side roles.
- [OPEN] A repository-by-repository software bill of materials, security posture, release compatibility and license review is required before embedding any library.
- [OPEN] Demo issuer/verifier components must not be classified as production-ready from their names alone.

## Decision

Use the official RI as the primary wallet-side implementation and interoperability baseline. For server-side Issuance-as-a-Service and Verification-as-a-Service, compare its test/demo services with EUDIPLO and platform requirements; do not assume wallet libraries provide a multi-tenant managed-service control plane.

## Sources

- [Official RI description and repository index](https://github.com/eu-digital-identity-wallet/.github/blob/main/profile/reference-implementation.md)
- [RI documentation and feature map](https://docs.eudi.dev/)
- [Official RI repository catalogue](https://docs.eudi.dev/latest/reference-implementation/repositories-list/)
- [Official GitHub organisation](https://github.com/eu-digital-identity-wallet)
- [RI roadmap](https://github.com/eu-digital-identity-wallet/eudi-wallet-reference-implementation-roadmap)
- [ARF 3.0](https://eudi.dev/3.0.0/)
