# DPP Registry

**Status:** [REGULATORY] / [SPECIFICATION]

The DPP Registry does **not** store the complete Digital Product Passport.

It stores a registration record containing the information needed to identify/reference a DPP. The full DPP data remains hosted and maintained by the Economic Operator or a service provider designated by it.

Key identifiers:

- **UPI — Unique Product Identifier:** identifies the DPP and resolves to the hosted DPP data.
- **URI — Unique Registration Identifier:** returned by the DPP Registry for the centrally held registration record.

Registration can have model, batch or item granularity depending on the product-group requirements.

## Architectural contract

The Registry integration owns organisation enrolment, authentication, registration submission, returned identifiers, lifecycle synchronization and evidence of Registry interaction. It does not become the system of record for complete passport data.

The Commission describes the Registry as an EU indexing service storing unique identifiers, registration data and high-level metadata. Product data remains the responsibility of the Economic Operator, hosted directly or through a DPP service provider. Applicable delegated acts or other Union legislation may require additional Registry fields.

`[OPEN]` Requires validation: production API availability, authentication mechanism, identifier syntax, update/delete semantics, delegated administration, availability commitments and product-group-specific fields.

## Source

- [European Commission — The DPP Registry](https://single-market-economy.ec.europa.eu/single-market/digital-product-passport/dpp-registry_en)
