# Trust Services for EUDI Participation

**Status:** [PRODUCT], constrained by [SPECIFICATION] sources

The trust service converts signed technical evidence into a traceable resolution result. It must not collapse “signature valid,” “chain trusted,” “entity authorized,” “credential current,” and “business policy accepted” into one Boolean.

| Function | Output |
|---|---|
| Trust-anchor and LoTE resolution | Source, version, freshness, chain and role |
| Access/registration certificate handling | Validity, intended uses, registered attributes and revocation evidence |
| Credential status resolution | Mechanism, value, retrieval time, freshness and cache policy |
| Schema/rulebook discovery | Versioned identifier, authoritative source and validation profile |
| Cryptographic verification | Algorithm, key/certificate evidence and failure reason |
| Policy evaluation | Separately versioned platform/customer decision |

Trust sources must be allow-listed, signed where specified, cached with bounded freshness, observable, and fail according to explicit risk policy. Historical evidence must preserve what was evaluated without retaining unnecessary personal claims.

EUDIPLO provides useful LoTE/trust-list, X.509, certificate, federation and status machinery. `[OPEN]` Requires validation against the authoritative sources and exact ARF 3.0 technical-spec versions selected for each deployment.
