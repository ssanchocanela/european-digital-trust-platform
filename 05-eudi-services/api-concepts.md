# API Concepts

**Status:** [PRODUCT] direction / [OPEN] contract design

Customers integrate with business resources; OpenID4VCI, credential-format and EUDIPLO endpoints remain behind the platform-owned EUDI adapter. These examples illustrate distinct service journeys and do not freeze paths, schemas or transport style.

## Gateway-oriented operation

```http
POST /v1/credentials
```

The customer asserts that its assigned retrieval, eligibility and approval steps are complete and supplies approved data or a short-lived claims reference. The platform validates the applicable Delegation Profile and hand-off evidence before issuing.

```json
{
  "credentialType": "urn:example:education:diploma",
  "subject": { "reference": "student-48291" },
  "approvedClaims": { "reference": "award-937" },
  "approvalEvidence": { "reference": "approval-204" },
  "idempotencyKey": "award-937-v1"
}
```

## Full-issuer or hybrid operation

```http
POST /v1/issuance-transactions
GET  /v1/issuance-transactions/{id}
POST /v1/issuance-transactions/{id}/actions
```

The caller identifies the Subject and Credential Type. The platform resolves the versioned Delegation Profile, retrieves assigned source attributes, evaluates eligibility/policies and creates any customer/human approval task.

```json
{
  "credentialType": "urn:example:professional:membership",
  "subject": { "reference": "member-1882" },
  "requestedDelivery": "wallet_offer",
  "idempotencyKey": "membership-1882-2027"
}
```

Lifecycle commands may eventually express renew, update, suspend, reinstate or revoke operations, but command names and synchronous/asynchronous behavior remain `[OPEN]`.

## Contract principles

- Tenant identity comes from authenticated context, never a caller-controlled body field.
- Every operation resolves an authorized Credential Type and snapshots configuration, policy and Delegation Profile versions.
- Idempotency, correlation, expiry and explicit state transitions apply across customer/platform hand-offs.
- APIs distinguish source observation, eligibility result, approval result, protocol outcome, credential status and policy decision.
- Business types map to versioned credential profiles; callers do not choose algorithms, keys or trust anchors ad hoc.
- Source/claim data is retrieved just in time and minimized in state, responses, logs and events.
- Webhooks/actions are signed or strongly authenticated, replay-protected, authorized and auditable.
- Raw credentials and wallet responses are not returned or retained by default.

`[OPEN]` Requires validation: resource names, action model, bulk issuance, cancellation, evidence bundles, optimistic concurrency, event/webhook schemas and customer approval UX.

See [Issuance as a Service](issuance-as-a-service.md) and the [issuer product model](issuer-product-model.md).
