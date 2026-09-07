# Verification as a Service

**Status:** [PRODUCT] / [EXPERIMENTAL]

## Proposition

Allow an organisation to request trusted attributes from an EUDI Wallet and receive a normalized, policy-validated result without implementing the full verifier/Relying Party stack.

Candidate responsibilities:

- presentation request generation;
- wallet invocation integration;
- OpenID4VP / DC API abstraction;
- RP authentication and registration integration;
- cryptographic and trust validation;
- credential status checks;
- policy and intended-use enforcement;
- normalized response/API;
- audit evidence.

```mermaid
sequenceDiagram
  participant A as Business application
  participant P as Platform verifier API
  participant V as Verifier engine
  participant W as EUDI Wallet
  participant T as Trust/status services
  A->>P: Request policy + transaction context
  P->>P: Resolve allowed claims and purpose
  P->>V: Create DCQL presentation session
  V-->>A: Wallet invocation / QR data
  A->>W: Invoke wallet (redirect, QR or DC API)
  W->>V: OpenID4VP / ISO 18013-7 response
  V->>T: Validate chain, issuer and current status
  V->>V: Verify proof, nonce, audience and DCQL match
  V-->>P: Validated claims + technical evidence
  P->>P: Apply business policy and minimize result
  P-->>A: Normalized decision/result
```

## Result contract

The default response should separate `protocol_validation`, `trust_validation`, `status`, `policy_decision`, normalized claims and an evidence reference. Raw credentials should not be retained or returned by default.

- [SPECIFICATION] Cryptographic validity is not the same as issuer authorization or business acceptance.
- [PRODUCT] The platform policy layer owns purpose, minimum-claim selection and the final business decision.
- [OPEN] Retention, transaction-data signing and offline/cached-status policies require validation per use case.

See [presentation](../02-eudi-wallet/presentation.md), [trust services](trust-services.md), and [security](../06-shared-capabilities/security.md).
