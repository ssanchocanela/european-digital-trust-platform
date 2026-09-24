# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 11 September 2026, **revised the same day** once ETSI TS 119 472-3 was read. **It has not
been submitted.** Filing is a human decision.

If it is filed, check first whether a later release added support, and whether an equivalent issue is
already open.

> **This draft now covers gaps G1 and G8 together, and supersedes the separate G8 draft that was
> planned.** The first version of this issue asserted that the missing metadata signature was
> *separable* from the certificates the metadata carries. That was wrong. ETSI TS 119 472-3 V1.1.1
> makes the signature, the access certificate and the registration certificate **one mechanism**: the
> access certificate *is* the signing certificate, and the registration certificate belongs inside the
> signed payload. One fix closes all three.

---

**Title:** Credential Issuer metadata is not signed, so neither the access certificate nor the
registration certificate can be provided as ETSI TS 119 472-3 requires

**Version:** `v7.6.0` (image digest
`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`)

## Summary

The Credential Issuer metadata served at `/.well-known/openid-credential-issuer/issuers/{tenantId}` is
a plain JSON document. There is no `signed_metadata`, and the engine has no support for producing one:
the string `signed_metadata` has **zero occurrences** in the compiled output.

For an EUDI deployment that is not one missing convenience but the whole of pre-issuance provider
authentication, because the profile routes three things through the signature:

| | Requirement | Engine today |
|---|---|---|
| The metadata is signed | `ISS-MDATA-4.2.1-01`: the Issuer Metadata **shall** be signed metadata per OpenID4VCI clause 12.2.3, as a JWS (RFC 7515) | **Absent** |
| The signer is the access certificate | `ISS-MDATA-4.2.1-02`: the signing certificate **shall be the access certificate** of the PID/EAA Provider | **No access certificate anywhere in the issuance configuration** |
| The certificate reaches the Wallet | `ISS-MDATA-ACC_CERT-4.2.2-01/-02`: the JWS protected header **shall** contain `x5c`, carrying the DER-encoded access certificate, **which shall also be the signing certificate** (and `-03`: *should* carry the chain up to, excluding, the trust anchor) | **No `x5c`, because there is no JWS** |
| The registration certificate is inside the signature | `ISS-MDATA-REG_CERT-4.2.3-01/-02`: the metadata **shall** contain `issuer_info`, **placed at the top level of the Signed JWT payload** used for retrieving the Issuer Metadata (`-03`: same structure as OpenID4VP `verifier_info`; `-04`: one element *may* carry the registration certificate) | Emitted, but **in the unsigned JSON document**, so there is no signed payload for it to be at the top level of |

*All identifiers above are from ETSI TS 119 472-3 V1.1.1 (2026-03), "Profiles for Electronic
Attestation of Attributes; Part 3: Profiles for issuance of EAA or PID", clauses 4.2.1–4.2.3.*

ARF 3.0.0 §6.6.2.2 says the same thing in prose: a Provider "does not send its access certificate to
the Wallet Unit in a request, but makes it available in its Credential Issuer metadata according to
[OpenID4VCI] and [ETSI TS 119 472-3]", and "does not sign a request, but rather its Credential Issuer
metadata". The Wallet then "verifies that the access certificate … is valid and authentic, and the
signature over the metadata is valid" — one check over one artefact.

## What the reference wallet does, concretely

`eudi-lib-android-wallet-core` v0.30.2, which the pinned reference build
(`Wallet/Demo_Version=2026.09.42-Demo_Build=42`) uses:

```kotlin
configureIssuerTrust {
    policy { default(TrustPolicy.Action.ENFORCE) }
    requireSignedMetadata()        // → IssuerMetadataPolicy.RequireSigned(issuerTrust)
}
```

`IssuerTrustConfigBuilder` defaults to `MetadataPolicyMode.REQUIRE`, so this is the default even
without the explicit call. Its documentation states the mechanism exactly: *"the library extracts the
x5c certificate chain from the JWT header and validates it against the configured trust source"*, and
`eudi-lib-jvm-openid4vci-kt` states *"The signed metadata JWT must contain the `x5c` header claim, the
leaf certificate of which must contain the public key used to sign the metadata and whose chain must be
trusted"*.

The trust source is not an issuer-specific one. `EtsiCertificateChainTrust` calls
`isChainTrusted(chain, VerificationContext.WalletRelyingPartyAccessCertificate)` — so the chain is
validated against the **Wallet-Relying-Party Access Certificate** context, which is consistent with
`ISS-MDATA-4.2.1-02`: the certificate being validated really is an access certificate.

There is also a second-order effect worth knowing, because it is not obvious from the configuration
API. In `IssuerCreator`:

```kotlin
val registrationCertificatePolicy = issuerRegistration
    ?.takeIf { issuerMetadataPolicy is IssuerMetadataPolicy.RequireSigned }
```

The issuer **registration-certificate** check is applied only under `RequireSigned`. Under
`PreferSigned` or `IgnoreSigned` it is silently skipped, with a log line saying so. So without signed
metadata a Wallet cannot check the registration certificate either — even one the engine publishes, and
even with the Wallet's own *Check Registration Certificates* preference switched on.

## Reproduction

```bash
curl -s "$ENGINE/.well-known/openid-credential-issuer/issuers/$TENANT" | jq 'keys'
# no signed_metadata, with or without a registration certificate configured

docker run --rm --entrypoint sh "$IMAGE" -c 'grep -ro "signed_metadata" /app/dist | wc -l'
# 0
```

And there is nowhere to configure an access certificate: `IssuanceConfig` (and `UpdateIssuanceDto`)
carry `signingKeyId`, `registrationCertificate`, `registrationCertificateCache` and
`walletProviderTrustLists`, with no access-certificate field. `issuer_info` is assembled in exactly one
place — `appendIssuerRegistrationCertificateInfo` in `oid4vci.service.ts` — which only ever pushes
`format: "registration_cert"`.

## Suggested fix — one change, not three

The pieces already exist: the engine imports key chains by `usageType` (`access | attestation |
trustList | statusList | encrypt`), and it already signs OpenID4VP request objects with an `access`
chain and puts `x5c` in the header. That is the same operation this needs, on a different document.

1. Add an issuance-configuration option, defaulting to **off** so no existing deployment changes
   behaviour — for example:

   ```json
   "metadata": { "signed": true, "accessKeyChainId": "<an access-usage key chain>" }
   ```

   Naming it `accessKeyChainId` rather than `signingKeyId` would mirror
   `POST /api/verifier/config`, and make it clear that this is **not** the attestation signing key.
2. When enabled, build the metadata object as today, then sign it as a JWS whose protected header
   carries `x5c` with that chain (leaf first, up to but excluding the trust anchor), and whose payload
   is the metadata parameters plus `iss` — **with `issuer_info` at the top level of that payload**, per
   `ISS-MDATA-REG_CERT-4.2.3-02`.
3. Serve it as `signed_metadata` alongside the plain parameters, so clients that do not use it keep
   working.

Two notes that matter for the implementation:

- **The metadata signing key must be an `access`-usage chain, distinct from the `attestation` key that
  signs credentials.** They authenticate different things — the provider's identity versus the
  attestation's origin — and `ISS-MDATA-4.2.1-02` names the access certificate specifically.
- **`issuer_info` should move inside the signed payload**, not be duplicated. Keeping it in the
  unsigned document as well is harmless for compatibility, but the profile's requirement is about the
  signed copy, and a Wallet under `RequireSigned` reads the signed one.

## Impact on us, and our workaround

We wrap the engine behind a port and report this rather than working around it. Our
provider-authentication endpoint returns the conjunction a Wallet actually faces:

```json
{ "registrationCertificatePresent": true,
  "metadataSigned": false,
  "walletCanAuthenticateProvider": false }
```

and a contract test asserts `metadataSigned === false` with a message saying to update our
documentation if it ever passes — so a release that adds support surfaces as a failing test pointing at
the right place rather than as a silent change in what we claim.

There is no workaround on our side that does not either put us in front of the engine's OpenID4VCI
surface — which is precisely what the engine exists to avoid — or require a modified wallet build
(`ignoreSignedMetadata()`), which bypasses the check rather than satisfying it, and which additionally
disables the registration-certificate check as described above.

Recorded as gaps **G1** and **G8** in our engine gap register; since reading TS 119 472-3 we treat them
as one fix.

## Not a complaint about the issuance implementation

The issuance side is otherwise complete and careful: the registration-certificate import path works and
is correctly gated, the validation is real, and `Oid4VpAuthorizationServerConfig` supports using an
OpenID4VP presentation as the authorization step, which is a genuinely useful capability we rely on.
This is one missing piece — admittedly a load-bearing one — in an otherwise working gate.
