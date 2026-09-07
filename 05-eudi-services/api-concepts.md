# API Concepts

**Status:** [EXPERIMENTAL]

Customers integrate with stable business resources; protocol-specific endpoints remain behind the platform boundary.

```http
POST /v1/issuance-transactions
GET  /v1/issuance-transactions/{id}
POST /v1/verification-transactions
GET  /v1/verification-transactions/{id}
POST /v1/verification-policies
POST /v1/webhook-endpoints
```

Example request (illustrative, not a frozen contract):

```json
{
  "credential_type": "urn:example:education:diploma",
  "subject_binding": { "reference": "student-48291" },
  "claims_source": { "mode": "callback", "reference": "award-937" },
  "delivery": { "mode": "wallet_offer" },
  "idempotency_key": "award-937-v1"
}
```

## Contract principles

- Tenant identity comes from authenticated context, never a caller-controlled body field.
- Idempotency, correlation IDs, expiry and explicit state machines are mandatory.
- Business types map to versioned credential profiles; callers do not choose algorithms or trust anchors ad hoc.
- Claims are resolved just in time where possible and minimized in logs/events.
- Webhooks are signed, replay-protected, allow-listed and retried with bounded policy.
- Errors distinguish business eligibility, protocol, trust, status, policy and transient infrastructure failures.
- Raw credentials and wallet responses are not returned or retained by default.

`[OPEN]` Requires validation: synchronous versus asynchronous result delivery, evidence-bundle format, bulk issuance, cancellation semantics and sector-specific API profiles.
