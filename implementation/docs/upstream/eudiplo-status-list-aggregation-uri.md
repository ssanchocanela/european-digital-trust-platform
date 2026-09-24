# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 13 September 2026. **It has not been submitted.** Filing is a human decision.

If it is filed, check first whether a later release fixed it, and whether an equivalent issue is
already open. This one is cheap to re-test: fetch any status list from the EUDI reference issuer and
try to decode it.

---

**Title:** `StatusList` decoding requires `aggregation_uri`, which the specification marks OPTIONAL,
so an mdoc from the EUDI reference issuer cannot be verified with status checking enabled

**Version:** `v7.6.0`, image `ghcr.io/openwallet-foundation/eudiplo:7.6.0`
(`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`)

**Component:** `MdocverifierService`

## Summary

Verifying an mdoc presentation fails while decoding the Status List Token, because the decoder
requires a claim the Token Status List specification defines as optional:

```
[MdocverifierService] mDOC verification failed: Error: Error decoding StatusListCbor
  ✖ Expected key 'aggregation_uri' to be defined. at "aggregation_uri"
```

The verifier then fails the whole credential, and the wallet receives:

```
400 error=invalid_request
    error_description=Presentation validation failed:
      mDOC verification failed for credential "...": mDOC verification failed
```

To the holder this reads as a problem with their credential. The credential and its status list are
both fine.

## `aggregation_uri` is OPTIONAL

From `draft-ietf-oauth-status-list-13` (October 2025), for the CBOR encoding:

> `aggregation_uri`: OPTIONAL. CBOR Text string (Major Type 3) that contains a URI to retrieve the
> Status List Aggregation for this type of Referenced Token.

and its CDDL, where `?` marks the member optional:

```cddl
StatusList = {
    bits: 1 / 2 / 4 / 8, ; The number of bits used per Referenced Token
    lst: bstr,           ; Byte string that contains the Status List
    ? aggregation_uri: tstr, ; link to the Status List Aggregation
}
```

The JSON encoding carries the same `OPTIONAL` marking. Status List Aggregation is an optional
feature of the specification, and an issuer that does not offer it has nothing to put there.

## The EUDI reference issuer does not send it

A Status List Token fetched live from `https://issuer.eudiw.dev` on 13 September 2026 decodes to
exactly:

```json
{
  "sub": "https://issuer.eudiw.dev/token_status_list/FC/<doctype>/<uuid>",
  "iat": 1789312782,
  "status_list": { "bits": 1, "lst": "eNpjYBgFo2AUjILhCgAE4gAB" }
}
```

No `aggregation_uri`, and none is required. So every mdoc issued by the EUDI reference issuer is
unverifiable by EUDIPLO with status checking enabled.

## Steps to reproduce

1. Configure a presentation for an mdoc credential — `format: mso_mdoc`, any `doctype_value` the
   reference issuer offers — with `statusCheckMode` other than `disabled`.
2. Obtain that credential in a wallet from `https://issuer.eudiw.dev`.
3. Present it.

Expected: verification proceeds, and the status list is decoded and evaluated.
Actual: `Error decoding StatusListCbor`, and the presentation is rejected with `400`.

## `statusCheckMode: best_effort` does not avoid it

This is the part that makes the impact wider than it first appears. `best_effort` reads as "do not
fail the verification if the status cannot be established", which is exactly this situation — but the
decode throws before the mode is consulted, so the whole verification fails identically.

Verified on a running instance: a presentation configuration whose stored `statusCheckMode` was
confirmed as `best_effort` through `GET /api/verifier/config` failed with the same error and the same
`400`. Only `disabled` gets past it.

That matters because ARF `AS-AP-07-023` (`VCR_13`) permits skipping revocation checking only after a
documented risk analysis. A deployment that has not performed one has no usable option: it cannot use
`strict`, `best_effort` does not help, and `disabled` is the thing the requirement is about.

## Suggested fix

Treat `aggregation_uri` as optional when decoding `StatusList`, in both the CBOR and the JSON path.

Separately, and independent of this bug, it is worth considering whether a status list that cannot be
**decoded** should be treated the same as one that cannot be **fetched** — that is, whether
`best_effort` should cover it. Both are "the status could not be established", and neither is
evidence that the credential is bad.

## What this report does not claim

Nothing about the ARF or about conformance. It is a report about one release of one implementation,
observed on one afternoon, from a project that consumes EUDIPLO rather than reviews it.
