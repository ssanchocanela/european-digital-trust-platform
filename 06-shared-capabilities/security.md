# Security

**Status:** [PRODUCT] security baseline; [OPEN] formal threat model required

## Security invariants

- Strong tenant isolation across API, session, storage, cache, keys, events and administration paths.
- Isolate issuer identities, source connectors/secrets, policies, configurations, transactions and administrators by tenant.
- Separate keys by tenant, environment and purpose; enforce rotation, revocation and least privilege.
- Store keys in an assurance-appropriate KMS/HSM; never infer qualified status from generic HSM use.
- Treat wallet payloads, claims, offers, callbacks and trust documents as untrusted input.
- Bind protocol sessions to nonce, audience, redirect/response URI, expiry and one-time-use state.
- Allow-list outbound destinations and protect webhooks/attribute providers from SSRF and replay.
- Minimize credential/claim retention; redact logs and encrypt necessary sensitive state.
- Pin dependencies, generate an SBOM, verify artifacts and continuously scan the supply chain.
- Record trust source, policy version and validation outcome without creating unnecessary surveillance data.
- Test failover and cache behavior so stale trust/status information cannot silently become authoritative.
- Apply purpose-bound least privilege, network isolation, source provenance and restricted caching to Authentic Source connectors.

## Assurance boundaries

Wallet certification, issuer/RP authorization, qualified signatures/seals and QERDS qualification are separate assurance regimes. Platform testing and protocol conformance support evidence but do not replace them.

Before production: complete data-flow and abuse-case threat models, DPIA inputs, tenant escape tests, cryptographic review, penetration test, backup/restore and incident exercises.
