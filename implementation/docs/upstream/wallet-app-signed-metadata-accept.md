# Upstream issue draft — the wallet asks for signed and unsigned issuer metadata when it requires signed

**Not filed.** For `eu-digital-identity-wallet/eudi-app-android-wallet-ui`. Drafted 9 October 2026.

---

**Title:** With `requireSignedMetadata()`, the Credential Issuer Metadata request still carries `Accept: application/jwt, application/json`, and an issuer that answers JSON is then refused

**What happens**

The app configures issuer trust with `requireSignedMetadata()`. `openid4vci-kt` then requests the
metadata with `Accept: application/jwt` only. But the request is sent through the app's own
`HttpClient` — `LogicCoreModule` passes it with `withKtorHttpClientFactory { httpClient }` — and
`NetworkModule.provideHttpClient` installs `ContentNegotiation` with JSON, which appends
`application/json` to the `Accept` header of every request.

On the wire:

```
GET /.well-known/openid-credential-issuer/issuer
Accept: application/jwt, application/json
```

An issuer that supports both forms may answer either. OpenID4VCI 1.0, section 12.2.2: the issuer "MUST
support returning metadata in an unsigned form", "MAY support returning it in a signed form", and it
is only "RECOMMENDED" that it match the `Accept` header. When it answers `application/json`, the wallet
fails with `CredentialIssuerMetadataError.MissingSignedMetadata` and shows "Issuance blocked … the
provider could not be verified by your Wallet" — for an issuer that would have served signed metadata
had it been asked for them alone.

**Seen at** tag `Wallet/Demo_Version=2026.09.42-Demo_Build=42` (commit
`43f362d2a720edb6d37a356b6a51b52b32c61f25`), with `openid4vci-kt` 0.13.1.

**Suggested change**

Either give Wallet Core a client without the JSON `ContentNegotiation` default, or have the metadata
request exclude it (`ContentNegotiation`'s `exclude(ContentType.Application.Json)`), so that a request
for signed metadata asks for nothing else.

---

## What this repository does meanwhile

Deviation **WD-11** of the test wallet (`tools/test-wallet/deviations.md`): a client plugin that sends
`Accept: application/jwt` alone on a metadata request that asked for it. For our own modified builds.
