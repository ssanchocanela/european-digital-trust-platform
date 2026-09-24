# Privacy

What the platform does with personal data, and what it deliberately cannot do.

No GDPR compliance assessment is made here. A DPIA is out of scope for V0.

---

## 1. The claim, stated honestly

> The **platform** never persists presentation content. The **wrapped engine** holds it for a
> bounded, explicitly configured window inside the same trust boundary, minimised to the
> transaction lifetime, and then anonymised by the engine's cleanup job.

The second sentence is not a hedge. Phase 0 established that EUDIPLO persists disclosed claims
on its session rows — `SessionEntity.credentials` carries the verified payload, and
`credentialPayload` can carry inline issuance claims — for `SESSION_TTL`, which defaults to
86 400 seconds. Claiming "no content is ever persisted" without naming that would be false for
the deployment the V0 plan asks for, so the platform names it, minimises it and tests it.

---

## 2. The normative basis

Not a preference. `AS-RP-01-002` (`OIA_16`) of ARF 3.0.0:

> "When receiving a PID or attestation, a Relying Party Instance SHALL discard the values of
> all unique elements, including at least the ones mentioned in requirement `ISSU_35` …, as
> well as any timestamps, as soon as they are no longer needed. The Relying Party Instance
> SHALL NOT communicate these values to the Relying Party or to any other party inside or
> outside the EUDI Wallet ecosystem."

`AS-AP-10-064` (`ISSU_35`) enumerates those unique elements: per-attribute salts, attribute
hash values, the attestation identifier or index used for revocation, the device-binding public
key, and the Attestation Provider signature value.

In the V0 hosted profile the platform **is** the Relying Party Instance. Two consequences that
a storage-only reading would miss:

1. The obligation covers **onward communication**, so it constrains the customer-facing result
   and the log, not only the database.
2. It forbids passing those values **up to the Relying Party** — so the platform must strip
   them from what it returns to its own customer.

Also binding: `AS-RP-03-01` (`PID_03a`) restricts retaining the PID `portrait` absent a
specific legal basis and forbids transfer to third countries unless permitted;
`EW-PIO-01-021` (`OIA_09`) requires the presentation response to be encrypted so attributes are
accessible only to the Relying Party Instance.

---

## 3. Five data classes, separated in storage

| Class | Where it lives | Lifetime |
|---|---|---|
| Configuration | `tenants` … `presentation_policy_versions` | Durable; published policy versions immutable |
| Transaction metadata | `presentation_transactions`, `presentation_transaction_transitions` | Durable |
| **Presentation content** | **no table** | Never stored |
| Derived / normalised result | `presentation_results` | `purgeAfter`, from the policy's `resultRetentionSeconds` |
| Audit evidence | `audit_events` | Durable, purpose-limited |
| Delivery | `webhook_deliveries` | Until delivered or attempts exhausted |

Content has **no table at all**. That is the strongest available form of the guarantee: there
is nowhere for it to be written, so the property does not depend on anyone remembering it.
`tests/integration/migrations.test.ts` asserts the exact table list, so a future migration that
added a content table would fail the build.

---

## 4. How content is handled

A disclosed-claims value exists only inside the call stack that receives it:

1. `EudiVerifierPort.processPresentationResult` returns it;
2. `applyResultPolicy` reads what the policy permits;
3. the derived or allowed values are written to `presentation_results`;
4. the disclosed value goes out of scope when the method returns.

It is never assigned to a field, placed on a queue, written into a retry payload, or logged. A
retry re-fetches from the engine rather than replaying a stored response — which is why a
delivery retry cannot resurrect content.

The V0 plan's escape hatch ("if temporary persistence is technically unavoidable, document why,
encrypt it, and enforce automatic purge with a tested job") is **not used**.

### Verified, not asserted

`tests/integration/verification-flow.test.ts` settles a real transaction with
`birthdate: "1990-05-17"`, a disclosed name and an `_sd` hash array, then **scans every table in
the database** for those values and fails if any appears. A second test scans every emitted log
line. Both run on every `pnpm verify`.

---

## 5. The result policy strips the unique elements

Whatever a policy says, `applyResultPolicy` removes `_sd`, `_sd_alg`, `sd_hash`, `salt`, `cnf`,
`status`, `x5c`, `issuanceThumbprint`, `revocationThumbprint` and device-key fields from the
value it returns, at every depth. A policy cannot opt out, because the stripping runs after the
policy does.

This matters because the engine's own `SessionOutcome.trust` exposes `issuanceThumbprint` and
`revocationThumbprint`, and its `VerificationResult` carries the disclosed payload. Passing
those through would breach `OIA_16` even though nothing was stored.

---

## 6. Minimisation — and why derivation is the primary route

V0's flagship policy requests `["birthdate"]` and returns `{ over_18: boolean }`. The date of
birth never reaches the customer.

That looks like output filtering, which the V0 plan warns is "not a substitute for over-asking
the wallet". The plan's preferred alternative — request `age_over_18` from the PID — **is not
available**:

- PID Rulebook v1.1 (4 Sep 2025) change log: *"Age verification attributes removed, following
  CIR 2024/2977."*
- The complete current PID attribute set contains no `age_over_18`, `age_over_NN` or
  `age_in_years`.
- The live reference PID issuer at `https://issuer.eudiw.dev` advertises 27 claims for
  `eu.europa.ec.eudi.pid_vc_sd_jwt` and 26 for `eu.europa.ec.eudi.pid_mdoc`, and **neither
  contains any age-related claim**.

So for an age check over a PID, derivation from the date of birth is the only conformant route.
The platform therefore enforces minimisation at the result boundary, under conditions: the
policy declares the derivation explicitly, the source attribute must be registered for the
intended use, and the raw value is discarded in the same call stack. ADR 0005 Decision 5.

The general rule is unchanged and still binding: prefer a pre-computed minimal attribute where
the credential type offers one. Age over a PID is the documented counter-example, not the model.

TS5 v1.5 §2.4.5 restates the principle: a Wallet-Relying Party Service "may only request the
minimum set of attestations (`Credential`) and attributes (`Claim`) within those necessary for a
specific intended use".

---

## 7. Over-asking is refused before it reaches a wallet

Three layers check that requested attributes stay within what was registered. The platform owns
the earliest:

| Layer | When | Granularity |
|---|---|---|
| **Platform** | policy publication | claim path — HTTP 422 naming every offending path |
| Engine | request time | credential, against the registration certificate |
| Wallet (`EW-DM-44-027`, `RPRC_21`) | presentation request | attribute, warning the User |

Catching it at publication means no customer traffic and no User ever sees the Wallet's
"requesting more information than it has registered" warning.

---

## 8. Engine retention settings

Applied and asserted when a Relying Party Instance is provisioned, and again before every
session is created — so no session can exist under the engine's 24-hour default.

| Setting | Value | Why |
|---|---|---|
| `ttlSeconds` | the transaction lifetime (V0 default 300), floored at the engine's minimum of 60 | Sized to the flow, not to an audit window |
| `cleanupMode` | `anonymize` | Keeps the id, status and timestamps the platform reconciles against; nulls the content |
| `SESSION_TTL` / `SESSION_CLEANUP_MODE` | `300` / `anonymize` in Compose | A safe floor even before the per-tenant call lands |
| `LOG_SESSION_STORE` | `off` | Session logs are a second content store |
| `LOG_ENABLE_HTTP_LOGGER` | `false` | Request and response bodies |
| `LOG_REDACT_SENSITIVE_DATA` | never `false` | The engine's own redaction |
| `AUDIT_LOG_RETENTION_DAYS`, `AUDIT_LOG_MAX_ENTRIES_PER_TENANT` | set explicitly | Both default to disabled, i.e. unbounded growth |

**Open.** Whether `anonymize` nulls every content-bearing field is taken from the engine's
documentation and entity definitions; it is **not yet verified empirically**. A Milestone 1
adapter-contract test should assert that after cleanup `credentials`, `credentialPayload`,
`requestObject` and `responseEncryptionPrivateJwk` are null. Until that test runs against a real
container, this row is configuration intent rather than verified behaviour. Recorded in
`security-limitations.md`.

The platform never reads the engine's database directly, only its API — a second reason the two
databases are separate.

---

## 9. Logging

Structured JSON, one line per event, with a correlation id and the presentation, policy and
tenant identifiers. Every field passes through `redact()` before serialisation, in the only code
path that can emit a line.

The deny-list covers content keys, the `ISSU_35` unique elements, PID attribute names, and
secrets and key material. `tests/unit/redaction.test.ts` fails the build if a denied key
survives, and additionally checks an emitted line independently for denied key names carrying
values. Values of unknown shape — a class instance that could expose a getter, a Buffer, a Map —
are replaced wholesale rather than walked.

Never logged: credentials, PID attributes, VP tokens, SD-JWTs, mdocs, private keys, secrets.

---

## 10. What the customer receives

`GET /v1/presentations/{id}` and the signed callback carry: the presentation id, the business
reference, the status, the policy id and version, timestamps, and — only on `VERIFIED` — the
claims the result policy emitted. No VP token, no credential, no disclosed attribute outside the
result policy, none of the `ISSU_35` unique elements, and no engine identifier.

The engine session reference is retained as internal correlation metadata and is never returned.

---

## 11. Honest limitations

- The engine holds content for the configured window. Minimised and documented, not eliminated.
- `anonymize` completeness is unverified (§8).
- Trust-anchor **management** — `EW-PIO-01-028` (`OIA_15a`)'s duty to refresh lists and remove
  invalidated anchors from every Relying Party Instance — is not implemented. V0 delegates trust
  validation to the engine.
- V0 exercises one of ARF's two trust layers. No registration certificate is available
  (blocker B3), so `EW-DM-44-023` (`RPRC_19`) is **not** demonstrated; each transaction records
  that it was sent without one.
- The webhook signing secret is stored in the platform database in plain text. A development
  shortcut, listed in `security-limitations.md`.
- The legal qualification of the hosted Relying Party Instance profile — processor or
  Article 5b(10) intermediary — is unresolved (open question Q2). User approval in the Wallet
  does not itself establish a lawful basis for processing.
