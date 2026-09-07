# Shared Trust Infrastructure

Common trust-resolution and certificate/status capabilities should serve Business Wallet and EUDI Services rather than being implemented independently in each product module.

**Status:** [PRODUCT], driven by [SPECIFICATION] trust sources

Core interfaces should cover trust-source discovery, signed-list validation, certificate path/revocation validation, access and registration certificates, issuer/RP roles, credential status, schema/rulebook resolution and evidence snapshots.

The service returns structured reasons and freshness—not a single “trusted” flag. Trust anchors are environment- and scheme-specific, versioned, allow-listed and observable. Network or cache failure behavior is explicit and risk-based.

`[OPEN]` Requires validation: authoritative production endpoints, trust-list profile versions, cache maximum age, historic validation evidence and cross-border governance.
