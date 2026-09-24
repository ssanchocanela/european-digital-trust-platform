# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 11 September 2026. **It has not been submitted.** Filing is a human decision: it is
outward-facing, it names a project we only consume, and someone should confirm we are not simply
using the engine in a way its maintainers did not intend.

If it is filed, check first whether a later release changed the guard, and whether an equivalent
issue is already open.

---

**Title:** An imported registration certificate is never emitted as `verifier_info` unless a live
registrar is configured

**Version:** `v7.6.0` (image digest
`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`), PostgreSQL 17.6

## Summary

`registrationCertImportJwt` lets a caller supply a registration certificate it already holds. The
certificate is accepted, validated and cached — and then never included in the OpenID4VP request
object, because emission is additionally gated on a **registrar configuration** existing for the
tenant. A registrar config can only be saved if a registrar service is reachable and authenticates.

So a deployment that has a valid registration certificate but no registrar cannot put it in a
presentation request. That matters because including it is a `SHALL` in the ARF:
`EW-DM-44-023` (`RPRC_19`) requires a Relying Party Instance to include a single applicable
registration certificate **in each presentation request, by value**, in both proximity and remote
flows.

## Reproduction

1. Create a tenant and import an access certificate.
2. Create a presentation configuration with a registration certificate:

```bash
curl -X POST "$ENGINE/api/verifier/config" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "id": "demo",
    "dcql_query": { "credentials": [{ "id":"pid", "format":"dc+sd-jwt",
      "meta": {"vct_values":["urn:eudi:pid:1"]}, "claims":[{"path":["birthdate"]}] }] },
    "accessKeyChainId": "'"$KEY_CHAIN"'",
    "registrationCertImportJwt": "'"$RC_JWT"'"
  }'
```

The certificate is accepted (201) and `GET /api/verifier/config/demo` shows it both as
`registration_cert` and in `registrationCertCache`.

3. Create an offer and fetch the resulting request object:

```bash
curl -X POST "$ENGINE/api/verifier/offer" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"response_type":"uri","requestId":"demo"}'
# then GET the request_uri from the returned uri
```

4. Decode the JWS payload. Claims present: `response_type`, `client_id`, `response_uri`,
   `response_mode`, `nonce`, `dcql_query`, `client_metadata`, `state`, `aud`, `exp`, `iat`.
   **`verifier_info` is absent.**

## Cause

`dist/verifier/oid4vp/oid4vp.service.js`:

```js
let regCert = undefined;
if (presentationConfig.registration_cert &&
    (await this.registrarService.isEnabledForTenant(session.tenantId))) {
  regCert = await this.presentationsService.getOrIssueRegistrationCertificate(
    presentationConfig, dcql_query, session.requestId);
}
// ...
verifier_info: regCert ? [{ format: "registration_cert", data: regCert }] : undefined,
```

`RegistrarConfigService.isEnabledForTenant` is `!!config`, and `saveConfig` calls
`await this.authService.testCredentials(dto)` **before** persisting — so the config cannot exist
unless a registrar is reachable and its OIDC credentials authenticate (an unreachable URL returns
503 and saves nothing).

The `isEnabledForTenant` guard is right for `mode: generate`, where the engine must call a registrar
to mint a certificate. It is the `import` path that does not need it: the certificate is already in
hand, already validated, and already cached.

## Suggested fix

Gate on what is actually needed:

```js
const canEmit =
  presentationConfig.registration_cert?.jwt !== undefined ||          // imported: no registrar needed
  (await this.registrarService.isEnabledForTenant(session.tenantId)); // generated: registrar needed
if (presentationConfig.registration_cert && canEmit) { /* ... */ }
```

Or more simply: if the cache already holds a validated certificate, emit it regardless of registrar
configuration. The validation that matters — expiry, and that the certificate authorises every
credential in the DCQL query — already runs on import and is independent of the registrar.

## Second, smaller issue: an OpenAPI / validator mismatch on the same field

`registrationCertImportJwt` is declared in the Management API document as an array:

```json
"registrationCertImportJwt": {
  "description": "Optional imported registration certificate JWT.",
  "type": "array",
  "items": { "type": "string" }
}
```

but the runtime validator requires a **string**. Sending the documented array gives:

```json
{"statusCode":400,"message":"Validation failed",
 "errors":[{"path":["registrationCertImportJwt"],
            "message":"expected string, received array","code":"invalid_type"}]}
```

A string is accepted and is stored as `registration_cert: { jwt: "…" }`. The same array-vs-string
shape appears on the sibling `registrationCertImportId`, `registrationCertBodyPrivacyPolicy`,
`registrationCertBodySupportUri` and `registrationCertBodyIntermediary` fields, so this looks like
one systematic annotation problem rather than four separate ones — possibly a multipart/form-data
annotation leaking into the JSON schema.

Either the document or the validator should move. Generated clients follow the document, so today
they emit a request the engine rejects.

## Impact on us, and our workaround

We wrap the engine behind a port, so we found both of these with a contract test that decodes the
request object rather than trusting the configuration call — the field-name defect would otherwise
have surfaced only when a real certificate first arrived.

For the array/string mismatch we send a string and pin it with a test. For the registrar gate there
is no workaround: we record that `RPRC_19` is not satisfied, and our test for it **skips with a
logged reason** when no registrar is configured, so it turns green by itself if this is fixed.

## Not a complaint about the validation

The engine's own checks are good and caught a real error in our placeholder certificate — it refuses
one with no authorised-credentials claim, which is the `RPRC_21` check. The narrow point is that the
*emission* gate is stricter than the import path needs.
