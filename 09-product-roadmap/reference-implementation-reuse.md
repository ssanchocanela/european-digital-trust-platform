# Reference Implementation Reuse Map

**Status:** [PRODUCT] initial decision record, 7 September 2026

| Need | Primary baseline | Decision | Validation gate |
|---|---|---|---|
| EUDI Wallet mobile behavior | Official Android/iOS apps | `REFERENCE` end-to-end | Test supported flows and accessibility against target release |
| Wallet-side orchestration/storage | Official Wallet Core/Kit | `REUSE` candidate | Security, API stability, license, device support, certification impact |
| Wallet-side OID4VCI/OID4VP | Official protocol libraries | `REUSE` candidate | ARF 3.0 version mapping and interop suite |
| Proximity presentation | Official ISO mdoc/proximity components | `REUSE` candidate | Reader authentication, certificate and device matrix |
| RQES wallet journeys | Official RQES modules | `REUSE`/`REFERENCE` | QTSP compatibility and qualified-signature boundary |
| Server issuer/verifier examples | Official demo/test services | `REFERENCE` | Do not equate demo scope with managed-service readiness |
| Conformance tests | Official testing/conformance assets | `REUSE` | Confirm applicable profile/version and test coverage |
| Managed issuer/verifier engine | EUDIPLO candidate | `WRAP` | Contract tests against official wallet and conformance tools |

## Rules

- Do not duplicate official wallet-side code without a recorded incompatibility or assurance reason.
- Pin repository, release and specification versions in implementation ADRs.
- Keep certification/conformity claims separate from test success.
- Re-run the matrix when ARF, implementing acts, OpenID profiles or RI releases change.

See the detailed [official RI assessment](../02-eudi-wallet/reference-implementation.md) and [reuse strategy](../08-architecture/reuse-strategy.md).
