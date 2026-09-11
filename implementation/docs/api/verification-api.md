# Verification API (V0)

The customer-facing business API. An OpenAPI document is served at `/openapi` when the service is
running.

**What is not in this contract:** DCQL, OpenID4VP, `client_id` schemes, response modes, credential
offers, engine sessions, engine configuration objects. Protocol details stay below the platform's
ports, and a CI boundary check fails the build if they leak. Customers work with policies, claims
and transactions.

No ARF or Technical Specification conformance is claimed. V0 is not production-ready — see
[`security-limitations.md`](../security-limitations.md).

---

## Authentication

`Authorization: Bearer <api-key>`. One key per tenant, returned once when the tenant is created
and stored only as a SHA-256 hash.

**The tenant comes from the credential, never from the request.** A `tenantId` in a path is
checked against the authenticated tenant and a mismatch is `403 tenant_mismatch`.

A separate bootstrap administrative key creates tenants. It is **refused** on every tenant-scoped
route (`403 admin_key_not_tenant_scoped`), so it cannot act as a tenant.

Optional `X-Correlation-Id` on any request: echoed into logs and error responses. Restricted to
`[A-Za-z0-9._-]{1,128}`; anything else is replaced with a generated value, because the header
reaches the logs.

## Errors

```json
{
  "error": "policy_version_invalid",
  "message": "The policy version is not valid for the referenced intended use.",
  "correlationId": "3f1c…",
  "details": [
    { "path": "portrait", "code": "claim_not_registered",
      "message": "Claim path 'portrait' is not within the attributes registered for the referenced intended use." }
  ]
}
```

| Status | Meaning |
|---|---|
| 400 | Malformed request |
| 401 | Missing or invalid credentials |
| 403 | Cross-tenant access, or a callback URL that is not registered |
| 404 | Not found — **including another tenant's resource**, which is invisible rather than forbidden |
| 409 | Illegal state transition, or a missing prerequisite such as an unprovisioned instance |
| 422 | Well-formed but rejected by a domain rule. `details` names every offending item |
| 502 | The verification engine failed or timed out |

`details` is returned for 400 and 422 only. Other failures carry a stable code and a short
message; diagnostic detail goes to the log, mirroring how the engine keeps certificate subjects
and trust-list URLs out of its own responses.

---

## Configuration chain

Each step depends on the one before.

### `POST /v1/tenants` — administrative key only

```json
{ "name": "Example Retailer" }
```

Returns `tenantId` and `apiKey`. **The key is shown once.**

### `POST /v1/tenants/{tenantId}/organisations`

```json
{
  "legalName": "Example Retailer B.V.",
  "memberState": "NL",
  "isPublicSectorBody": false,
  "officialIdentifiers": [
    { "scheme": "http://data.europa.eu/eudi/id/EUID", "value": "NLNHR.12345678" }
  ]
}
```

At least one identifier is required. TS5 v1.5 §2.4.3.1 makes the European unique identifier (EUID)
the default scheme where a national business register provides one.

### `POST /v1/tenants/{tenantId}/relying-parties`

```json
{
  "organisationId": "…",
  "registrarAssignedIdentifier": "NLNHR.12345678",
  "registrar": "NL-Registrar-Sandbox",
  "trustEnvironment": "TEST"
}
```

`registrarAssignedIdentifier` is **assigned by the Registrar** and recorded here, never generated —
ARF §3.11.1, `AS-MS-27-043` (`Reg_32`).

**`trustEnvironment` must be `TEST`.** `PRODUCTION` returns `422 trust_environment_not_supported`:
V0 does not simulate production registration, certificates or Registrar interactions, and the
legal qualification of the hosted Relying Party Instance profile is unresolved.

### `POST /v1/tenants/{tenantId}/rp-services`

```json
{
  "relyingPartyId": "…",
  "serviceIdentifier": "age-gate",
  "serviceTradeName": "Example Age Gate",
  "description": [{ "lang": "en", "value": "Age gate for account onboarding" }],
  "callbackUrlAllowList": ["https://verifier.example/hooks/presentations"]
}
```

Returns a `webhookSecret`, **shown once**, which signs result callbacks.

`serviceIdentifier` is RP-chosen and unique within the Relying Party (ARF §3.11.2). TS5 makes it
optional; the platform requires it, which is a deliberate stricter-than-TS5 choice.

`serviceTradeName` is what the Wallet displays to the User — `AS-WP-06-007` (`RPA_06`).

`callbackUrlAllowList` entries must be HTTPS. A request may only name a URL that **exactly**
matches an entry. This is the SSRF control: without it a caller could point the platform's
outbound request at an internal address.

### `POST /v1/tenants/{tenantId}/rp-services/{serviceId}/intended-uses`

```json
{
  "intendedUseIdentifier": "registrar-intended-use-1",
  "purpose": [{ "lang": "en", "value": "Confirm the customer is an adult" }],
  "privacyPolicyUris": [{ "lang": "en", "value": "https://verifier.example/privacy" }],
  "registeredCredentials": [
    {
      "format": "dc+sd-jwt",
      "vctValues": ["urn:eudi:pid:1"],
      "claims": [["birthdate"]]
    }
  ]
}
```

`purpose` and `privacyPolicyUris` are **localised and mandatory**, because the Wallet displays both
when asking the User for approval — `AS-WP-06-015` (`RPA_10`). TS5 models them as `[1..*]` of
MultiLangString. An `en` entry is required in V0 as the fallback.

`claims` are **OpenID4VP claims path pointers**: arrays of strings, nulls and non-negative
integers (TS5 `Claim.path`; OpenID4VP §6.3, §7.1, §7.2). Not flat attribute names. A `null` is an
array wildcard; an integer is an array index. For mdoc the first segment is the namespace, e.g.
`["eu.europa.ec.eudi.pid.1", "birth_date"]`.

### `POST /v1/tenants/{tenantId}/rp-services/{serviceId}/registration-certificates`

```json
{ "intendedUseId": "…", "trustEnvironment": "TEST" }
```

Records the certificate slot for one intended use — `EW-DM-44-014` (`RPRC_09`) pairs them
one-to-one. `jwt` is optional because **V0 has no reachable provider of registration
certificates**. Without it, presentation requests go without one and every transaction reports
that.

### `POST /v1/tenants/{tenantId}/rp-services/{serviceId}/instance`

```json
{
  "engineTenantRef": "root",
  "trustEnvironment": "TEST",
  "accessCertificate": {
    "privateKeyJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "d": "…" },
    "certificateChain": ["-----BEGIN CERTIFICATE-----…"],
    "subject": "CN=Example Age Gate",
    "issuer": "CN=Development Access CA"
  }
}
```

Provisions the Relying Party Instance, imports the access certificate into the engine key store,
and applies the mandatory session-retention settings.

The key arrives as a **JWK** and the chain as PEM, leaf first, because that is what the engine's
import endpoint accepts — it does not take a PKCS#12 blob. Use
`scripts/import-access-certificate.sh` to convert a P12.

The platform stores only the opaque key-binding reference the engine returns. No private key
reaches the platform database.

---

## Presentation policies

### `POST /v1/tenants/{tenantId}/presentation-policies`

```json
{
  "relyingPartyServiceId": "…",
  "intendedUseId": "…",
  "name": "Adult verification",
  "description": "Confirms the customer is at least 18 years old."
}
```

### `POST /v1/tenants/{tenantId}/presentation-policies/{policyId}/versions`

```json
{
  "purpose": [{ "lang": "en", "value": "Confirm the customer is an adult" }],
  "credentialRequirements": [
    { "credentialType": "urn:eudi:pid:1", "acceptedFormats": ["dc+sd-jwt"] }
  ],
  "requestedClaims": [{ "path": ["birthdate"] }],
  "resultPolicy": {
    "kind": "DERIVED_CLAIMS",
    "derivations": [
      { "name": "AgeAtLeast", "sourcePath": ["birthdate"],
        "minimumAgeYears": 18, "outputClaim": "over_18" }
    ]
  },
  "publish": true
}
```

`credentialRequirements` holds **exactly one** element in V0. It is a list so multi-attestation
intended uses, which TS5 permits, can be added later without a migration.

#### The claim-path subset rule

`requestedClaims` must be within the attributes registered for the intended use, as **paths**:

- an identical path is permitted;
- a path that **extends** a registered path is permitted — `["address","locality"]` is within a
  registered `["address"]`, because the registered claim is the broader disclosure;
- a path that is a strict **prefix** of a registered one is refused — `["address"]` is not within
  a registered `["address","locality"]`, because it asks for more;
- a registered `null` is a wildcard covering any index at that position; a registered index covers
  only the identical index.

A violation is `422 policy_version_invalid` with a `details` entry naming every offending path.
This is the earliest of three checks: the engine also checks at credential granularity, and
`EW-DM-44-027` (`RPRC_21`) makes the Wallet check at attribute granularity and warn the User.
Catching it here means no User sees that warning.

#### Result policies

**`VERIFIED_CLAIMS`** returns only the explicitly allowed verified attributes:

```json
{ "kind": "VERIFIED_CLAIMS", "allowedClaims": [["given_name"], ["family_name"]] }
```

**`DERIVED_CLAIMS`** returns a derived, minimised result through named transformations. No
expression language and no rules engine.

| Derivation | Parameters | Returns |
|---|---|---|
| `AgeAtLeast` | `sourcePath`, `minimumAgeYears`, `outputClaim` | boolean; the source date never leaves the server |
| `ClaimPresence` | `sourcePath`, `outputClaim` | boolean; the value is not returned |
| `ClaimInSet` | `sourcePath`, `allowedValues`, `outputClaim` | boolean; the value is not returned |

A result policy may only read claims the version requests; otherwise `422`.

> **`age_over_18` is not available.** PID Rulebook v1.1 removed the age-verification attributes
> following CIR 2024/2977, and the reference PID issuer advertises none. An age check over a PID
> must derive from the date of birth, which is why `AgeAtLeast` exists and why derivation is the
> primary route rather than a fallback. Whatever the result policy says, the
> `AS-AP-10-064` (`ISSU_35`) unique elements — salts, hashes, the revocation index, the
> device-binding key, the provider signature — are stripped from the response, because
> `AS-RP-01-002` (`OIA_16`) forbids communicating them onward.

### `POST /v1/tenants/{tenantId}/presentation-policies/{policyId}/versions/{version}/publish`

Publishes a draft. A published version is **immutable**, and re-publishing is
`409 policy_version_not_draft`.

### `GET /v1/tenants/{tenantId}/presentation-policies/{policyId}`

Returns the policy and every version with its status.

---

## Presentations

### `POST /v1/presentations`

```json
{
  "policyId": "…",
  "policyVersion": 2,
  "businessReference": "order-4711",
  "callbackUrl": "https://verifier.example/hooks/presentations",
  "interactionType": "SAME_DEVICE"
}
```

`policyVersion` defaults to the latest **published** version. A draft is never resolvable.

`callbackUrl` must exactly match an entry on the Service allow-list.

`interactionType` defaults to `SAME_DEVICE`, which is the tested V0 path.

> **`QR` is available but flagged.** ARF `EW-PIO-01-016` (`OIA_08c`) says Wallet Units SHOULD NOT
> support redirect-based cross-device flows, and `EW-PIO-01-017` (`OIA_08d`) obliges a Relying
> Party that uses one to implement mitigations for the challenges in ARF §4.4.3.1. **V0 implements
> none of them**, and no claim is made that this path satisfies `OIA_08d`. Requesting it emits a
> `platform.interaction.cross_device_requested` audit event.

Response:

```json
{
  "presentationId": "…",
  "status": "AWAITING_WALLET",
  "interaction": { "type": "SAME_DEVICE", "uri": "openid4vp://?…" },
  "expiresAt": "2026-09-11T08:05:00.000Z",
  "warnings": [
    { "code": "no_registration_certificate",
      "message": "The presentation request was sent without a registration certificate, because none is available for this intended use." }
  ]
}
```

`interaction.uri` is **opaque**. Hand it to the wallet; do not parse or rewrite it.

The `warnings` array appears when `EW-DM-44-023` (`RPRC_19`) could not be satisfied. It is
reported rather than hidden.

### `GET /v1/presentations/{presentationId}`

Advances the transaction if the engine has moved on, then returns it.

```json
{
  "presentationId": "…",
  "businessReference": "order-4711",
  "status": "VERIFIED",
  "policyId": "…",
  "policyVersion": 2,
  "expiresAt": "2026-09-11T08:05:00.000Z",
  "result": { "claims": { "over_18": true } }
}
```

| `status` | Meaning |
|---|---|
| `AWAITING_WALLET` | Waiting for the wallet |
| `VERIFIED` | Valid and the policy is satisfied. `result.claims` present |
| `REJECTED` | Credential verification failed — signature, validity or status |
| `POLICY_NOT_SATISFIED` | A valid presentation that does not satisfy the policy |
| `DECLINED_BY_USER` | An explicit OpenID4VP `access_denied`. **Best-effort** — see below |
| `TRUST_ERROR` | Issuer or attestation trust could not be established |
| `PROTOCOL_ERROR` | Protocol or engine failure |
| `EXPIRED` | No wallet response within the transaction lifetime |
| `CANCELLED` | Cancelled by the business client |

> **`DECLINED_BY_USER` is best-effort.** `AS-WP-06-017` (`RPA_11`) requires a Wallet Unit, when the
> User denies a presentation, to "behave towards the Relying Party as if the attestation or PID did
> not exist". A denial is therefore not reliably distinguishable from the User not holding the
> credential. **The absence of this status does not mean the User consented.**

`failureCode` carries the engine's stable code where there is one. A `trust_list_unavailable` is a
**verifier-side** condition — our misconfiguration or outage, not a defect in the presented
credential — and is never reported as a bad credential.

### `POST /v1/presentations/{presentationId}/cancel`

Cancels a transaction that is still awaiting the wallet. Once a presentation has been received the
User has already disclosed attributes, so cancelling is refused with
`409 presentation_already_settled` and the transaction must settle on a real outcome.

### `GET /health`

```json
{ "status": "ok", "engine": "reachable" }
```

Unauthenticated. An unreachable engine does not fail the platform: configuration routes stay
usable, and only presentation creation needs it.

---

## Result callbacks

`POST` to the registered `callbackUrl`, with headers:

| Header | Value |
|---|---|
| `x-edtp-signature` | `sha256=<hex>` |
| `x-edtp-timestamp` | Unix seconds |
| `x-edtp-event-id` | UUID, stable across retries |

```json
{
  "eventId": "…",
  "event": "presentation.settled",
  "presentationId": "…",
  "businessReference": "order-4711",
  "status": "VERIFIED",
  "policyId": "…",
  "policyVersion": 2,
  "settledAt": "2026-09-11T08:01:12.000Z",
  "result": { "claims": { "over_18": true } }
}
```

### Verifying the signature

```
expected = HMAC_SHA256(secret, timestamp + "." + body)
```

The **raw body** and the timestamp, joined by a dot. Binding the timestamp into the signed string
is what makes the freshness check meaningful: signing the body alone would let an attacker replay
a captured payload with a fresh timestamp.

Reject a timestamp older than 300 seconds, compare in constant time, and deduplicate on
`x-edtp-event-id`.

Retries use exponential backoff with full jitter, up to `WEBHOOK_MAX_ATTEMPTS` (default 5). A
retry resends the **identical bytes**, so the signature still verifies. A delivery failure never
changes the verification outcome: the result stays readable through `GET`, and the transaction's
delivery status records the failure.

The payload carries the normalised result only. Never a VP token, a credential, a disclosed
attribute outside the result policy, or an engine identifier.

---

## Out of scope for V0

W3C Digital Credentials API flows, ISO/IEC 18013-5 proximity presentation, the Article 5b(10)
intermediary profile, and issuance (Milestone 2).
