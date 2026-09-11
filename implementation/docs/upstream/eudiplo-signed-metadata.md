# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 11 September 2026. **It has not been submitted.** Filing is a human decision.

If it is filed, check first whether a later release added support, and whether an equivalent issue is
already open.

---

**Title:** Credential Issuer metadata is not signed, so EUDI Wallets requiring `signed_metadata`
cannot authenticate the issuer

**Version:** `v7.6.0` (image digest
`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`)

## Summary

The Credential Issuer metadata served at
`/.well-known/openid-credential-issuer/issuers/{tenantId}` carries no `signed_metadata` claim, and
the engine has no support for producing one: the string `signed_metadata` has **zero occurrences** in
the compiled output.

OpenID4VCI defines `signed_metadata` as a JWT, signed by the Credential Issuer, carrying the metadata
parameters so a Wallet can authenticate the document itself rather than trusting the transport. For
an EUDI deployment this is not optional in practice: the EUDI Wallet reference implementation
requires it.

In `eudi-lib-android-wallet-core` v0.30.2 the application configuration is:

```kotlin
configureIssuerTrust {
    policy { default(TrustPolicy.Action.ENFORCE) }
    requireSignedMetadata()        // → IssuerMetadataPolicy.RequireSigned(issuerTrust)
    // …
}
```

`IssuerTrustConfigBuilder` defaults to `MetadataPolicyMode.REQUIRE`, and the shipped
`Wallet/Demo_Version=2026.09.42-Demo_Build=42` build uses `requireSignedMetadata()` explicitly. So a
wallet built from the reference implementation refuses an issuer whose metadata is unsigned,
regardless of what else is configured correctly.

## Why this is separable from the registration certificate

The engine already does the *other* half of issuer authentication well: with
`registrationCertificate: {enabled: true, mode: "import", jwt: …}` it publishes

```json
"issuer_info": [{ "format": "registration_cert", "data": "<jwt>" }]
```

which we verified end to end. The gap is narrow and specific — the metadata document is not itself
authenticated — and it defeats the registration certificate it publishes, because a Wallet that
cannot trust the document cannot trust the certificate inside it.

ARF §6.6.2.2 treats pre-issuance provider authentication as a single step, which is why half of it
working does not help.

## Reproduction

```bash
curl -s "$ENGINE/.well-known/openid-credential-issuer/issuers/$TENANT" | jq 'keys'
```

Returns the metadata keys with no `signed_metadata` among them, with or without a registration
certificate configured.

```bash
docker run --rm --entrypoint sh "$IMAGE" -c 'grep -ro "signed_metadata" /app/dist | wc -l'
# 0
```

## Suggested fix

The engine already holds a signing key per tenant and already signs OpenID4VP request objects, so
the pieces exist:

1. Add an issuance-configuration option — for example
   `metadata: { signed: true, signingKeyId?: string }` — defaulting to off so existing deployments do
   not change behaviour.
2. When enabled, build the metadata object as now, then sign it as a JWT whose payload is the
   metadata parameters plus `iss` (the credential issuer identifier) and `sub`, per OpenID4VCI, with
   `x5c` carrying the attestation or a dedicated metadata-signing chain.
3. Include it as `signed_metadata` alongside the plain parameters, so unsigned-metadata clients keep
   working.

Reusing `accessKeyChainId`-style key selection would keep it consistent with how
`POST /api/verifier/config` already chooses a signing key.

## Impact on us, and our workaround

We wrap the engine behind a port and report this rather than working around it. Our
provider-authentication endpoint returns:

```json
{ "registrationCertificatePresent": true,
  "metadataSigned": false,
  "walletCanAuthenticateProvider": false }
```

and a contract test asserts `metadataSigned === false` with a message saying to update our
documentation if it ever passes — so a release that adds support surfaces as a failing test pointing
at the right place, rather than as a silent change in what we claim.

There is no workaround on our side that does not either put us in front of the engine's OpenID4VCI
surface — which is what the engine exists to avoid — or require a modified wallet build
(`ignoreSignedMetadata()`), which bypasses the check rather than satisfying it.

## Not a complaint about the issuance implementation

The issuance side is otherwise complete and careful: the registration-certificate path works, the
validation is real, and `Oid4VpAuthorizationServerConfig` supports using an OpenID4VP presentation as
the authorization step, which is a genuinely useful capability we now rely on. This is one missing
piece in an otherwise working gate.
