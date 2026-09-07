# Credential Services

Shared credential capabilities may include format handling, schema/rulebook management, issuance, presentation validation, status, revocation and lifecycle evidence.

**Status:** [PRODUCT] / [SPECIFICATION]

The platform uses a canonical credential-profile model and adapters for `dc+sd-jwt` and `mso_mdoc`; customer APIs should not expose format internals unnecessarily. Profiles pin claim semantics, disclosure rules, cryptographic suites, trust policy, status mechanism, display metadata and compatibility tests.

The authoritative business source decides eligibility and claim values. The credential service performs protocol/format work and records minimal lifecycle evidence. `[OPEN]` Requires validation: additional formats, schema catalogue authority, reissuance semantics and sector rulebooks.
