# Shared Trust Infrastructure

Common trust-resolution and certificate/status capabilities should serve Business Wallet and EUDI Services rather than being implemented independently in each product module.

**Status:** [PRODUCT], driven by [SPECIFICATION] trust sources

Core interfaces should cover trust-source discovery, signed-list validation, certificate path/revocation validation, access and registration certificates, issuer/RP roles, credential status, schema/rulebook resolution and evidence snapshots.

Trust domains must remain separate:

- `[REGULATORY]` QEAA provider status resolves through the Article 22 national trusted list for the qualified service.
- `[REGULATORY]` PuB-EAA provider status resolves through Article 45f notification and the Commission provider list; `[SPECIFICATION]` ARF represents operational trust through a PuB-EAA Provider LoTE.
- `[SPECIFICATION]` Non-qualified EAA trust is scheme/sector specific; ARF does not define a universal LoTE for it.
- `[IMPLEMENTING-ACT]` RPAC/RPRC authenticate and scope the party requesting Wallet data. They do not confer issuer/provider status.

The service returns structured reasons and freshness—not a single “trusted” flag. Trust anchors are environment- and scheme-specific, versioned, allow-listed and observable. Network or cache failure behavior is explicit and risk-based.

`[OPEN]` Requires validation: authoritative production endpoints, ARF-LoTE-to-binding-list mapping, registrar/CA availability and applicability dates, trust-list profile versions, cache maximum age, historic validation evidence and cross-border governance.

See [issuer trust and registration](issuer-trust-and-registration.md) and [RP registration and access](rp-registration-and-access.md).
