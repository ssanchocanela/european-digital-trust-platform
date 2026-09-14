# DRAFT — not filed

A defect report for the **EUDI reference Relying Party Registration Service** at
`https://registry.serviceproviders.eudiw.dev/`, drafted on 12 September 2026. **It has not been
submitted.** Filing is a human decision: it is outward-facing, it names a service we only consume,
and someone should confirm we are not using it in a way its maintainers did not intend.

Before filing, check whether the route already behaves differently — the observation is a single
afternoon's, and a silent server-side failure is the kind of thing that gets fixed without an
announcement.

The report below contains **no `hash_pid`**. That value is the session credential for the whole
registration and is a secret; every request is shown with a placeholder.

---

**Title:** `POST /intended_use/create` returns `201 ... created successfully` with a `null` id and
persists nothing, which makes both certificate routes unreachable

**Service:** `https://registry.serviceproviders.eudiw.dev/`, OpenAPI document at `/apispec_1.json`
(title "My API", version 1.0.0, 51 paths), observed 12 September 2026, ~15:30–16:20 UTC

## Summary

The recommended workflow in `/guide` cannot be completed. Steps up to and including
`POST /provider/create` work. `POST /intended_use/create` then reports success, returns `null`
where the new identifier should be, and creates no record. Because every remaining step consumes
that identifier, the registration cannot be finished and **neither certificate can be issued**:

- `POST /wallet_rp/create` requires `intendedUse_ids`.
- `POST /wallet_rp/certificate` is keyed by the `wrp_id` that call would mint — so no PKCS#12.
- `POST /intended_use/certificate` is keyed by `intended_use_id` — so no registration certificate.

## What happens

Request (`hash_pid` elided; `privacyPolicy_id` and `credential_ids` are records this same session
created and owns):

```json
POST /intended_use/create
{
  "hash_pid": "<hash_pid>",
  "intended_uses": [
    {
      "intendedUseIdentifier": "age-gate",
      "createdAt": "2026-09-12T00:00:00Z",
      "revokedAt": "2027-09-12T00:00:00Z",
      "purpose": [{ "lang": "en", "content": "Confirm the customer is an adult" }],
      "privacyPolicy_id": [436],
      "credential_ids": [335]
    }
  ]
}
```

Response — HTTP **201**:

```json
{
  "code": 201,
  "data": { "Credentials ids": [null] },
  "message": "Intended Use created successfully",
  "status": "success"
}
```

Three things are wrong with that response: the identifier is `null`, the key reads
`"Credentials ids"` rather than anything about intended uses, and the message asserts a creation
that did not happen.

## Evidence that nothing was persisted

`POST /intended_use/list` with the same `hash_pid`, immediately afterwards and after four separate
creation attempts with different payloads:

```json
{ "code": 200, "data": { "intended_use": [] },
  "message": "Intended Use retrieved successfully.", "status": "success" }
```

`POST /list_full_info` with the same `hash_pid` confirms it from the other direction. Everything
created before this step is present; there is no intended use anywhere in the response, and the
provider's `wrp` array is empty:

```json
{ "legal_entity_id": 236,
  "LegalPerson": { "legalName": ["…"] },
  "identifier": [{ "identifier_id": 248, "type": "http://data.europa.eu/eudi/id/VATIN", … }],
  "providers": [
    { "provider_id": 235, "provider_type": "WALLET_PROVIDER", "legal_entity_id": 236,
      "policy": [{ "policy_id": 435, … }],
      "wrp": [], "x5c": [] }
  ] }
```

For completeness, the records this session owns and which the failing call referenced:
law `253`, legal person `244`, identifier `248`, legal entity `236`, policy (`wrp`) `435`,
provider `235`, credential `335`, policy (`intended_use`) `436`.

## The failure is after validation, and it is silent

Ownership validation works correctly. Substituting an identifier belonging to another registrant
produces a clear rejection:

```
POST /intended_use/create   with "credential_ids": [1]
400 { "code": 400, "message": "The Credential ID 1 does not belong to this user.", "status": "error" }

POST /intended_use/create   with "privacyPolicy_id": [2]
400 { "code": 400, "message": "The Policy ID 2 does not belong to this user", "status": "error" }
```

So the route reaches its own checks, passes them, and then fails without saying so. A `500`, or a
`400` naming the problem, would have been far easier to act on than a `201`.

One further check suggests the validation is narrower than the document implies: passing a policy
whose `intention` is `wrp` (id `435`) as `privacyPolicy_id` also returns `201 ... created
successfully`, although the OpenAPI document describes that field as *"Must be valid intended_use
policy types"*.

## Expected behaviour

Either a `201` whose `data` carries the new identifier and whose record appears in
`/intended_use/list`, or a `4xx`/`5xx` naming what went wrong. The present behaviour is the one
outcome a client cannot handle: it reports success, so a client that trusts the message proceeds to
build later requests around an identifier that does not exist.

## Steps to reproduce

1. Authenticate: `GET /authentication` → present the PID → `POST /getpidoid4vp` → `hash_pid`.
2. `POST /law/create`, `POST /legal_person/create`, `POST /identifier/create`,
   `POST /legal_entity/create` — all succeed.
3. `POST /policy/create` twice, once with `"intention": "wrp"` and once with
   `"intention": "intended_use"` — both succeed.
4. `POST /provider/create` — succeeds.
5. `POST /credential/create` — succeeds, **provided `meta` is a string** (see below).
6. `POST /intended_use/create` referencing the ids from 3 and 5 — returns `201` with a `null` id.
7. `POST /intended_use/list` — empty.

## Three smaller findings from the same session

Reported together because each cost a debugging cycle, and each is a divergence between the OpenAPI
document and the running service rather than a misreading of it.

**1. `credentials[].meta` must be a string; an object returns `500`.** The document declares
`meta` as `{"type": "object"}` with the example `{"name": "PID Credential", "version": "1.0"}`.
Sending exactly that — including the literal example from `/guide` — returns an HTML
`500 Internal Server Error` page with no diagnostic content. A string succeeds. An empty object is
correctly refused with `400 {"data":{"missing_fields":["meta"]}}`, so the validator sees the field
but something downstream cannot handle its declared type.

**2. Creation routes return `data` as an object keyed by a prose label, not as an array.** The
document declares `data` as `{"type": "array", "items": {"type": "integer"}}`. Observed:

```
POST /law/create          →  "data": { "Law new ids:": [252] }      (note the trailing colon)
POST /credential/create   →  "data": { "Credentials ids": [334] }   (no colon)
```

The label differs per route and reads like a debug print, so a client cannot key off it. Either
shape is workable; the mismatch is the problem, and the inconsistency between the two labels
suggests neither is intentional.

**3. `GET /v3/api-docs`, `/openapi.json` and `/swagger-ui/index.html` return `500`.** The working
document is at `/apispec_1.json`, linked from `/apidocs/`. Harmless once known, and a few minutes
lost before then.

## What this report does not claim

Nothing here is a statement about the ARF or about conformance. It is a report about one deployment
of a test service, observed on one afternoon. We are a consumer of that service, not a reviewer of
it, and the service's own documentation says it is not for production use — this report is offered
in that spirit.
