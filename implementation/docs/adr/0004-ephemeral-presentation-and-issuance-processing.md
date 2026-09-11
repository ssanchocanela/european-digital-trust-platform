# ADR 0004 — Ephemeral presentation and issuance processing

- **Status:** DRAFT (Phase 0), awaiting approval
- **Date:** 11 September 2026

## Context

The implementation prompt's §8.1 requires that VP tokens, complete credentials, SD-JWTs, mdocs, raw
PID, raw presentation payloads and attribute values used for issuance are **never persisted by
default**, and that platform retention be aligned with EUDIPLO's session retention as verified in
Phase 0.

Phase 0 established two facts that make this more than a coding convention.

**There is a normative obligation, not only a privacy preference.** `AS-RP-01-002` (`OIA_16`):

> "When receiving a PID or attestation, a Relying Party Instance SHALL discard the values of all
> unique elements, including at least the ones mentioned in requirement `ISSU_35`…, as well as any
> timestamps, as soon as they are no longer needed. The Relying Party Instance SHALL NOT communicate
> these values to the Relying Party or to any other party inside or outside the EUDI Wallet
> ecosystem."

`AS-AP-10-064` (`ISSU_35`) enumerates the unique elements: per-attribute salts, attribute hash
values, the revocation index or attestation identifier, the device-binding public key, and the
Attestation Provider signature value. In the V0 hosted profile the platform **is** the Relying Party
Instance, so `OIA_16` binds the platform — and it forbids passing these values **upward to the
Relying Party**, not merely storing them. Related: `AS-RP-03-01` (`PID_03a`) restricts retaining the
PID `portrait` absent a specific legal basis and forbids third-country transfer unless permitted.

**EUDIPLO does persist content by default.** Verified on `SessionEntity` at v7.6.0:
`credentials?: VerificationResult[]` (from `@sd-jwt/sd-jwt-vc`, carrying the disclosed payload),
`credentialPayload?: OfferRequestDto` (which can carry **inline issuance claims**), plus
`requestObject`, `responseEncryptionPrivateJwk`, `offer`. Defaults: `SESSION_TTL` = 86400 s (24 h),
`SESSION_CLEANUP_MODE` = `full`, `SESSION_TIDY_UP_INTERVAL` = 3600 s. Per tenant,
`PUT /session-config` accepts `{ttlSeconds (min 60), cleanupMode: "full" | "anonymize"}`.

So "never persisted" cannot be claimed for the deployment as a whole without qualification. It can be
claimed for the platform, and the engine's window can be minimised and stated.

## Decision

### 1. Five data classes, separated in code and in storage

| Class | Examples | Persisted? |
|---|---|---|
| Configuration | `Tenant`, `Organisation`, `RelyingParty`, `RelyingPartyService`, `IntendedUse`, `PresentationPolicy{,Version}`, `CredentialType`, `IssuancePolicy{,Version}` | Yes, durably |
| Transaction metadata | `PresentationTransaction` ids, status, timestamps, `businessReference`, policy id + version, `deliveryStatus`, `closedAt`, EUDIPLO session id | Yes |
| Presentation / issuance **content** | VP tokens, SD-JWTs, mdocs, disclosed claim values, salts, hashes, device-binding public keys, provider signature values, issuance attribute values from the authentic source | **No** |
| Derived / normalised result | only what the result policy permits | Yes, minimised |
| Audit evidence | actor, action, policy and config versions, outcome, correlation id, evidence **references** | Yes |

Separate tables with separate lifecycles, not columns on a shared row. That is what makes the claim
checkable. Content has no table at all, which is the strongest available form of the guarantee: there
is nowhere for it to be written.

### 2. Content is handled in memory only, and discarded at the earliest point

The adapter fetches the EUDIPLO result, the result policy is applied **in the same call stack**, and
the content is dropped before the transaction is written. Concretely:

- no content is placed on a queue, in a cache, in a temp file, or in a retry payload;
- a retry re-fetches from EUDIPLO rather than replaying a stored response;
- derivation (see [ADR 0005](0005-presentation-policy-abstraction-and-minimisation-first-compilation.md))
  happens inside that same stack, and the source value is out of scope before the transaction row
  exists;
- `VERIFIED_CLAIMS` emits only explicitly allowed attributes; `DERIVED_CLAIMS` emits only the derived
  values.

**The result policy also strips `OIA_16` unique elements from the customer-facing result**, not only
from storage. EUDIPLO's `SessionOutcome.trust` exposes `issuanceThumbprint` and
`revocationThumbprint`, and `VerificationResult` carries the payload; none of these may reach the
business API response or the webhook payload. This is the part of `OIA_16` that is easy to miss,
because it is not a storage rule.

The prompt's escape hatch ("if temporary persistence is technically unavoidable, document why,
encrypt it, and enforce automatic purge with a tested job") is **not used in V0**. If it ever is, it
is recorded here and in `privacy.md` with the reason, the encryption, and the purge test.

### 3. EUDIPLO session configuration is mandatory, applied at instance provisioning

When a `RelyingPartyInstance` is provisioned, the adapter calls `PUT /session-config` on its EUDIPLO
tenant and asserts the result. Not optional, not a deployment note:

| Setting | Value | Why |
|---|---|---|
| `ttlSeconds` | the transaction lifetime plus a small margin, floored at EUDIPLO's minimum of **60** | Sized to the flow, not to an audit window. EUDIPLO's 86400 default is a 24-hour exposure of disclosed claims |
| `cleanupMode` | `anonymize` | Keeps id, status and timestamps — which the platform correlates against — while nulling content. `full` would delete the row the platform may still need to reconcile |
| `LOG_SESSION_STORE` | `off` (the default; `errors`, `all`, `verbose` persist session logs) | Session logs are a second content store |
| `LOG_ENABLE_HTTP_LOGGER` | `false` | Request and response bodies |
| `LOG_REDACT_SENSITIVE_DATA` | never `false` | EUDIPLO's own redaction |
| `AUDIT_LOG_RETENTION_DAYS`, `AUDIT_LOG_MAX_ENTRIES_PER_TENANT` | set explicitly | Both default to disabled, i.e. unbounded growth |

`EncryptionKeySource` is left at `env` for V0 (derived from `MASTER_SECRET`) and recorded in
`security-limitations.md` as development-only; EUDIPLO documents Vault/AWS/Azure as the production
choice so the key is only in RAM.

### 4. The honest statement, and why it is phrased this way

> The **platform** never persists presentation or issuance content. The **wrapped engine** holds it
> for a bounded, explicitly configured window inside the same trust boundary, minimised to the
> transaction lifetime, and then anonymised by the engine's cleanup job.

This goes into `privacy.md` and into the PR description. Stating "no content is ever persisted"
without the second sentence would be false for the deployment the prompt asks for, and the prompt's
§12 principle — do not simulate a property you have not achieved — applies to privacy claims as much
as to interoperability claims.

Two consequences follow:

- The platform never reads EUDIPLO's database directly, only its API. Reading that database would be
  reading stored personal data, and is a second reason for separate databases
  ([ADR 0001](0001-platform-technology.md)).
- EUDIPLO's `POST /storage` / `GET /storage/:key` endpoints are not used for content.

### 5. Revocation metadata is retained, and that is consistent

M2 revocation works through `POST /session/revoke` with EUDIPLO's `sessionId`. `StatusMapping` is a
separate table whose only foreign keys are to the tenant and the status list — **not** to the session
— so mappings survive session cleanup and revocation still works after the session is purged. But
only if the platform kept the `sessionId`.

`IssuedCredentialRecord` therefore retains the EUDIPLO session id, and the status list URI and index
where available. These are **metadata** — they identify a credential's status slot, not its content —
and `IssuedCredentialRecord` holds **no attribute values**, per the prompt's §7.2. Note that the
revocation index is itself an `ISSU_35` unique element, so it must not be returned in a
customer-facing result or logged; it is internal correlation metadata only.

### 6. Logging

Structured JSON, a correlation id, and presentation / issuance / tenant ids where safe. A redaction
layer with a **deny-list test that fails the build** if payload-like fields reach the logs, per the
prompt's §8.2. The deny list covers at minimum: `vp_token`, `presentation`, `credential`,
`credentials`, `verifiedClaims`, `presentedClaims`, `claims`, `credentialClaims`, `credentialPayload`,
`disclosures`, `_sd`, `sd_hash`, `salt`, `portrait`, `picture`, `birthdate`, `birth_date`, `x5c`,
`private`, `privateJwk`, `responseEncryptionPrivateJwk`, `client_secret`, `password`, `Authorization`.

Never logged: credentials, PID attributes, VP tokens, SD-JWTs, mdocs, private keys, secrets.

## Consequences

- **Positive.** The guarantee is structural — content has no table — rather than dependent on care.
- **Positive.** `OIA_16` is satisfied at both boundaries (storage and upward propagation), with a
  citation rather than an appeal to good practice.
- **Positive.** The engine's retention window is an explicit, asserted configuration value, so it can
  be stated precisely in `privacy.md` and reviewed.
- **Negative.** A short `ttlSeconds` removes EUDIPLO's session as a debugging aid. Accepted; that is
  the point. Diagnosis uses correlation ids and the platform's audit trail.
- **Negative.** Re-fetching instead of replaying a stored response makes retries more expensive and
  means a result can become unavailable if EUDIPLO's session expires before the platform reads it.
  The `EXPIRED` outcome covers this, and `ttlSeconds` must be sized so it is not the common case.
- **Negative.** `cleanupMode: anonymize` leaves session metadata rows accumulating in EUDIPLO.
  Bounded by the audit-log retention settings above; operational growth is monitored.
- **Open.** Whether `anonymize` nulls every content-bearing field is asserted from EUDIPLO's
  documentation and entity definitions, not yet verified empirically. A Milestone 1 integration test
  against a real container must assert, after cleanup, that `credentials`, `credentialPayload`,
  `requestObject` and `responseEncryptionPrivateJwk` are null. Until that test passes, the claim in
  §4 is a configuration intent rather than a verified behaviour, and `privacy.md` must say so.

## Status of claims

No conformance with ARF 3.0.0 or any Technical Specification is claimed. No GDPR compliance
assessment is made here; `OIA_16` and `PID_03a` are cited as ARF requirements, and
[`06-shared-capabilities/rp-registration-and-access.md`](../../../06-shared-capabilities/rp-registration-and-access.md)
correctly records that user approval in the Wallet does not itself establish a lawful basis for
processing. A DPIA is out of scope for V0.
