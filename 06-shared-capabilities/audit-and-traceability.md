# Audit and Traceability

Business contexts require stronger operational traceability than privacy-focused citizen interactions. Define audit boundaries carefully so that business accountability does not undermine EUDI privacy requirements.

**Status:** [PRODUCT], constrained by legal/privacy requirements

Record actor/tenant, action, time, transaction and policy versions, trust/status evidence references and outcome. Do not log raw credentials, undisclosed claims, secrets, offer codes or full tokens by default. Separate security telemetry, customer audit events, regulatory evidence and wallet-visible transaction history.

Use append-only/tamper-evident controls where justified, strict access, export/delete policy, clock integrity and tenant-specific retention. `[OPEN]` Requires validation: legal basis, evidentiary value, retention and data-subject rights per use case.
