# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 11 September 2026. **It has not been submitted.** Filing is a human decision.

---

**Title:** Five presentation-config fields are documented as arrays but the validator requires strings

**Version:** `v7.6.0` (image digest
`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`)

## Summary

On `PresentationConfigCreateDto` and `PresentationConfigUpdateDto`, five fields are declared in the
Management API document as arrays of strings:

| Field | Documented | Accepted |
|---|---|---|
| `registrationCertImportJwt` | `{type: "array", items: {type: "string"}}` | a **string** |
| `registrationCertImportId` | same | a **string** |
| `registrationCertBodyPrivacyPolicy` | same | a **string** |
| `registrationCertBodySupportUri` | same | a **string** |
| `registrationCertBodyIntermediary` | same | a **string** |

Sending the documented shape is rejected:

```json
{"statusCode":400,"message":"Validation failed",
 "errors":[{"path":["registrationCertImportJwt"],
            "message":"expected string, received array","code":"invalid_type"}]}
```

A string is accepted, and is stored as `registration_cert: { jwt: "…" }`.

## Reproduction

```bash
# Documented shape — rejected.
curl -X POST "$ENGINE/api/verifier/config" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"t","dcql_query":{...},"registrationCertImportJwt":["'"$RC_JWT"'"]}'

# Works.
curl -X POST "$ENGINE/api/verifier/config" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"t","dcql_query":{...},"registrationCertImportJwt":"'"$RC_JWT"'"}'
```

## Why it looks like one problem rather than five

All five are the flattened `registrationCert*` companions to the nested `registration_cert` object,
and all five are annotated the same way. `readerAuth` — a boolean — is likewise declared
`{type: "array", items: {type: "boolean"}}`. That pattern suggests a single cause: the fields look
like they are annotated for a **multipart/form-data** variant, where repeated values naturally arrive
as arrays, and that annotation is leaking into the JSON schema.

If that is right, one fix addresses all six rather than six separate corrections.

## Why it matters

Generated clients follow the document, so a client generated from the published OpenAPI emits a
request the engine rejects — and the error points at the field rather than at the document, so the
natural conclusion is that the caller is wrong.

`PresentationConfigCreateDto` also declares `additionalProperties: false`, so there is no
forgiving path: a caller working from the document gets a 400 either way.

## Suggested fix

Whichever is correct, make the document and the validator agree:

- if the JSON API takes a string, annotate these fields as `string` (and `readerAuth` as `boolean`);
- if arrays are intended, have the validator accept a single-element array, or both shapes.

If the annotation is shared with a multipart variant, splitting the DTOs — or applying the
array-shaped annotation only to the multipart schema — would stop the JSON document inheriting it.

## Impact on us, and our workaround

We send a string and pin the shape with a contract test, so a future change in either direction fails
our build rather than silently altering behaviour. This is recorded as gap **G3** in our engine gap
register, classified as contract friction rather than a defect with consequences — unlike the two
gaps that block ARF requirements.

Worth saying: we found this only because we write our adapter against the running engine rather than
against the document, which was a lesson from earlier releases. A project that trusted the document
would ship a broken client.
