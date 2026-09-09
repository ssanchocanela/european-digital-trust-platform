# Credential Services

Shared credential capabilities may include format handling, schema/rulebook management, issuance, presentation validation, status, revocation and lifecycle evidence.

**Status:** [PRODUCT] / [SPECIFICATION]

The platform uses a canonical credential-profile model and adapters for `dc+sd-jwt` and `mso_mdoc`; customer APIs should not expose format internals unnecessarily. Profiles pin claim semantics, disclosure rules, cryptographic suites, trust policy, status mechanism, display metadata and compatibility tests.

Authentic Sources remain authoritative for source data. Depending on the Delegation Profile, the customer or platform may retrieve that data, determine eligibility, approve issuance and execute lifecycle decisions. The credential service performs configured orchestration and protocol/format work while recording minimal lifecycle evidence. `[OPEN]` Requires validation: additional formats, schema catalogue authority, reissuance semantics and sector rulebooks.
