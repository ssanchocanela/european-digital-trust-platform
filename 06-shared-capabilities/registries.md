# Registries

Track interactions with EUDI registrars/trust infrastructure, DPP Registry, future Business Wallet directories and other authentic-source or sector registries.

**Status:** [PRODUCT] integration pattern

Each registry adapter must declare authority, identifiers, authentication, supported operations, versioning, rate/availability limits, evidence, error semantics and personal-data handling. Registry records should be referenced rather than copied unless caching is justified and freshness is explicit.

The DPP Registry adapter is separate from DPP data hosting. EUDI registrar integration is separate from trust-list resolution. `[OPEN]` Future Business Wallet directory/registry assumptions require proposal and implementing-material validation.
