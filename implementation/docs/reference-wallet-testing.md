# Reference Wallet testing

How to attempt a wallet interaction, what currently blocks it, and exactly what is needed for a
real test.

**Read this first.** Two things, in order:

1. **Path A is the route, and it needs no account.** The EUDI RP Registration Service authenticates
   by **OID4VP PID presentation** — there is no registration form and no credential to request. So
   an access certificate for an official wallet build is obtainable, and §2 has the flow.
2. **Chain-check the certificate before any wallet test.** A Wallet Unit accepts only Access CA
   trust anchors from the notified LoTEs — `AS-WP-06-005` (`RPA_04`). Run
   `scripts/verify-access-certificate-chain.sh` first and record the result in §8. Testing before
   checking wastes the attempt and produces a misleading failure.

The **self-built wallet (Path B) is the fallback**, used only if that chain check fails. It is a
*modified* wallet, and if it is used then every report — including the PR description — says so and
records the official-build result as unverified.

As of 11 September 2026 no interaction with any wallet has been attempted, because neither a
certificate nor a built wallet was available in this environment.

---

## 1. Why an official build refuses a self-hosted verifier

Verified in the wallet's own source, not inferred. `core-logic/src/demo/.../WalletCoreConfigImpl.kt`
in `eudi-app-android-wallet-ui` at `Wallet/Demo_Version=2026.09.42-Demo_Build=42`:

```kotlin
configureOpenId4Vp {
    withClientIdSchemes(listOf(ClientIdScheme.X509SanDns, ClientIdScheme.X509Hash))
}
configureEtsiTrust {
    loteLocations(SupportedLists(
        wrpacProviders = Uri("https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt"),
        …))
    relaxCertificateProfiles(); relaxPkixRevocation()   // dev/demo only
}
configureReaderTrustStore { readerAuthPolicy(ReaderAuthPolicy.EnforceIfPresent) }
```

Four consequences:

1. **Only `X509SanDns` and `X509Hash` are enabled.** `ClientIdScheme.Preregistered` is supported
   by Wallet Core v0.30.2 but is **not configured** in the shipped build. The engine uses
   `x509_hash`, so the schemes match and the certificate chain is the only gate.
2. **Access-certificate trust is always enforced**, against anchors downloaded at runtime from
   the WRPAC LoTE — `AS-WP-06-005` (`RPA_04`).
3. `ReaderAuthPolicy.EnforceIfPresent` admits a reader that sends **no** reader authentication,
   but an `x509_hash` request object is signed with an `x5c`, so reader authentication *is*
   present and the chain *is* checked. It provides no escape.
4. **Registration-certificate checking ships off** — one Settings switch,
   *Check Registration Certificates*, read once when the wallet configuration is built.

I fetched the live WRPAC LoTE and decoded it. It contains exactly **seven** Access CA trust
anchors: `EUDIW WRPAC Provider - {EE, NL, CZ, EU, LU, PT, UT} 02`, each paired with a
`…/Revocation` entry. They are certificates named
`CN=PID Issuer CA 0x, O=EUDI Wallet Reference Implementation, C=EU` with CRLs under
`https://preprod.pki.eudiw.dev/crl/`.

So a self-signed access certificate cannot work, and the engine's only shipped registrar preset —
the German Sandbox at `https://sandbox.eudi-wallet.org/api` — is **not** among those seven. That
is blocker B1 and blocker B2.

---

## 2. The two paths

### Path A — an access certificate from the official RP Registration Service (the route)

`https://registry.serviceproviders.eudiw.dev/` issues Relying Party Access Certificates in PKCS#12.
**No account is needed:** it authenticates by presenting a PID from a wallet.

#### A.1 Obtain a test PID

Issue one to the wallet from `https://issuer.eudiw.dev` first (§5). The registration service will ask
for it.

#### A.2 Log in by PID presentation

The service's login is an OID4VP presentation flow rather than a username and password:

| Step | What happens |
|---|---|
| `/authentication` | The service starts a presentation request and renders a QR code |
| scan | The wallet presents the PID |
| `/getpidoid4vp` | The service polls for the presentation result |
| → `hash_pid` | On success it returns a `hash_pid`, which authenticates the registration session |

**`hash_pid` is a credential.** Keep it in a gitignored local file or `.env`, never in a log, a
document, a fixture or a commit. It is on the log-redaction deny-list, and `*hash_pid*` is
gitignored. Same for the issued PKCS#12 and its password.

#### A.3 Chain-check before anything else

```bash
./scripts/verify-access-certificate-chain.sh rpac.p12
```

Fetches the live WRPACProviders LoTE, extracts its issuance anchors and verifies the leaf against
them with `openssl verify -partial_chain`. On success it names the matched anchor and its SHA-256.
The script writes nothing outside a mode-700 temporary directory it deletes on exit, and prints no
key material.

- **exit 0** — record the matched anchor in §8 and continue with Path A.
- **exit 1** — record that in §8, then fall back to Path B.

Why this matters before the wallet: `AS-WP-06-005` (`RPA_04`) makes the Wallet accept only Access CA
anchors from the notified LoTEs, and the shipped build has no preregistered-client escape hatch. The
service sits on the same `serviceproviders.eudiw.dev` host family as the dev trusted lists, which
*suggests* its CA is among the seven anchors — but suggestion is not verification, and its own
documentation says it "must not be used to manage real Relying Party access certificates".

#### A.4 Import

```bash
export TENANT_ID=<tenant-id>
export PLATFORM_TENANT_API_KEY=<tenant-api-key>   # secret: never an argument
./scripts/import-access-certificate.sh <service-id> <engine-tenant-ref> rpac.p12
```

The script prompts for the PKCS#12 passphrase, or takes it from `$P12_PASSWORD` for an unattended
run. Neither the passphrase nor the API key is ever a command-line argument — not to the script and
not to `openssl`, which is why both scripts use `-passin env:` rather than `-passin pass:`. An argv
is readable by any process on the machine through `ps`, and lands in shell history besides, so
prompting for a passphrase and then putting it on an `openssl` command line would defeat its own
purpose.

No platform code changes on this path.

#### A.5 A divergence to be aware of

The service **generates the key pair itself** and delivers a P12, rather than accepting a CSR for a
key the Relying Party Instance generated. ARF §3.11.3 describes an access certificate as bound to
"a key held by the Relying Party Instance", so a CA-generated key has been outside the subject's
control by construction and the binding is weaker than it looks.

Acceptable for `TEST`. Recorded in [`interop-findings.md`](interop-findings.md) C8 and
[`security-limitations.md`](security-limitations.md) K1a, and **must not carry into `PRODUCTION`**.

### Path B — a self-built wallet (fallback, only if the chain check fails)

Build `eudi-app-android-wallet-ui` from source and add your development Access CA to its reader
trust store. A custom store takes precedence over the ETSI store, which takes precedence over
static certificates:

```kotlin
// core-logic/src/demo/java/eu/europa/ec/corelogic/config/WalletCoreConfigImpl.kt
_config = EudiWalletConfig {
    configureReaderTrustStore(context, R.raw.edtp_dev_access_ca)
    configureOpenId4Vp {
        withClientIdSchemes(listOf(ClientIdScheme.X509SanDns, ClientIdScheme.X509Hash))
        …
    }
    …
}
```

Place the CA certificate at `resources-logic/src/main/res/raw/edtp_dev_access_ca.crt`.

**Use this only when §A.3 returned exit 1.** It is a modified wallet, and the requirements that
follow from that hold without exception:

- every report, document, test name, log line and PR statement says "self-built Reference
  Implementation wallet" or "modified wallet" — never "the Reference Wallet" unqualified;
- the result against an **official** build remains **unverified**, and the PR description says so;
- the development Access CA is `TEST`-only and must never appear in a `PRODUCTION` trust
  configuration — it is listed in [`security-limitations.md`](security-limitations.md) K2;
- test with *Check Registration Certificates* in **both** positions and report both results.

---

## 3. Generating a development Access CA and leaf

`TEST` only. Two certificates: a CA to place in the wallet's trust store, and a leaf for the
engine to sign request objects with.

```bash
# CA
openssl ecparam -name prime256v1 -genkey -noout -out dev-ca.key
openssl req -x509 -new -key dev-ca.key -sha256 -days 365 \
  -subj "/CN=EDTP Development Access CA/O=EDTP Development/C=EU" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out dev-ca.crt

# Leaf. The SAN must be the public host the wallet will see, because the wallet also supports
# the x509_san_dns scheme and an operator may switch to it.
openssl ecparam -name prime256v1 -genkey -noout -out access.key
openssl req -new -key access.key -subj "/CN=Example Age Gate/O=Example Retailer B.V./C=NL" -out access.csr
openssl x509 -req -in access.csr -CA dev-ca.crt -CAkey dev-ca.key -CAcreateserial \
  -days 90 -sha256 \
  -extfile <(printf "subjectAltName=DNS:your-public-host.example\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n") \
  -out access.crt

# Bundle for the import script.
openssl pkcs12 -export -inkey access.key -in access.crt -certfile dev-ca.crt -out access.p12
```

---

## 4. Network requirements

The phone must reach the engine over **public HTTPS with a certificate its OS trusts**. A
self-signed TLS certificate will not work: the Reference Implementation's own hardening guidance
forbids a trust-all `X509TrustManager` or a permissive `HostnameVerifier`, and the shipped build
honours that.

`ENGINE_PUBLIC_URL` must be that public origin, because it drives every wallet-facing URL the
engine emits. `PLATFORM_PUBLIC_URL` must be reachable by the browser that starts the flow,
because it builds the same-device return URL.

Options, in order of preference:

1. a public test host with a real certificate;
2. an HTTPS tunnel (the engine's own documentation uses ngrok);
3. the engine's built-in TLS with a publicly trusted certificate.

**A tunnel in front of port 3000 exposes the engine's admin API.** See
[`security-limitations.md`](security-limitations.md) O4. Put a reverse proxy in front that
exposes only the wallet-facing paths, or accept and document the exposure for the duration of
the test.

---

## 5. Obtaining a test PID

`https://issuer.eudiw.dev` is live and advertises 27 credential configurations. Verified on
11 September 2026:

| Configuration id | Format | Type |
|---|---|---|
| `eu.europa.ec.eudi.pid_vc_sd_jwt` | `dc+sd-jwt` | `vct = urn:eudi:pid:1` |
| `eu.europa.ec.eudi.pid_mdoc` | `mso_mdoc` | `doctype = eu.europa.ec.eudi.pid.1` |

Issue a PID to the wallet from that issuer before attempting a presentation.

**The dev PID carries no age attribute.** Neither configuration advertises `age_over_18`,
`age_over_NN` or `age_in_years` — consistent with PID Rulebook v1.1, whose change log reads
"Age verification attributes removed, following CIR 2024/2977". The V0 policy therefore requests
`["birthdate"]` and returns only a derived boolean. Do not write a test policy around
`age_over_18`; it will fail, and correctly.

---

## 6. The walkthrough

```bash
cd implementation
cp .env.example .env           # fill in every CHANGE-ME, and set ENGINE_PUBLIC_URL
docker compose up -d
PLATFORM_ADMIN_API_KEY=<your-admin-key> ./scripts/smoke-vaas.sh
```

The script walks the whole configuration chain and creates a presentation, printing the
interaction URI. It stops there and says so: it does not pretend a wallet completed the flow.

Then, manually:

1. replace the development key pair with your imported access certificate
   (`scripts/import-access-certificate.sh`);
2. open the interaction URI on the device running the wallet, or render it as a QR code —
   noting that `QR` is the flagged path (`security-limitations.md` P1);
3. approve in the wallet;
4. read the result: `GET /v1/presentations/{id}` with the tenant API key.

A `VERIFIED` outcome with `{"over_18": true}` and no date of birth anywhere in the response is
the success condition.

---

## 7. What to report, and how

Record the result in this file and in the PR description using these exact distinctions:

| Question | Answer to give |
|---|---|
| Which wallet? | Path A: "official Reference Implementation build `<tag>`". Path B: "self-built Reference Implementation wallet, build `<tag>`, with a development Access CA in its reader trust store" — never "the Reference Wallet" unqualified |
| Chain check (§8.1)? | The result, the matched anchor and its SHA-256 — or the failure |
| Official build? | Path A: verified, with the anchor named. Path B: "unverified" |
| *Check Registration Certificates* on? | both results, separately |
| Registration certificate present? | "no — `EW-DM-44-023` (`RPRC_19`) not satisfied; the transaction records `sentWithoutRegistrationCertificate`" |
| Conformance? | none claimed |

## 8. Status record

**Fill this in as each step is done.** It is the record the PR description and
[`traceability.md`](traceability.md) cite, so an empty row means "not done", never "assumed fine".

### 8.1 Access-certificate chain check — the gating step

| Field | Value |
|---|---|
| Date run | *not yet run* |
| Certificate source | *Path A — `registry.serviceproviders.eudiw.dev`, pending* |
| LoTE URL | `https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt` |
| LoTE issued / next update | `2026-07-09T13:45:27Z` / `2027-01-05T13:45:27Z` (as fetched 11 Sep 2026) |
| Issuance anchors in the list | **7** — `EUDIW WRPAC Provider - {EE, NL, CZ, EU, LU, PT, UT} 02` |
| Result | *pending* |
| Matched anchor | *pending* |
| Matched anchor SHA-256 | *pending* |
| Consequence | exit 0 → Path A, official build. exit 1 → Path B, modified build, official result stays unverified |

The script itself is verified: run against a freshly generated self-signed leaf it extracts the 7
anchors from the live list and correctly reports `FAIL`, so a `PASS` is meaningful rather than a
default.

### 8.2 Wallet capability checks

| Item | Status |
|---|---|
| Pinned release still scans `openid4vp://` QR codes | **Yes — verified in source.** `QrScanViewModel.navigateToPresentationRequest` passes the scanned string to `PresentationMode.OpenId4Vp(uri = scanResult)`, reached from `QrScanFlow.Presentation`. So the cross-device flow is reachable in practice, which is why [ADR 0009](adr/0009-cross-device-presentation-mitigations.md) mitigates it rather than relying on the wallet to refuse |
| Only `X509SanDns` and `X509Hash` client-id schemes enabled | **Yes — verified in source.** No `Preregistered` escape hatch in the shipped build |
| *Check Registration Certificates* ships off | **Yes — verified in source.** Both positions must be tested and both reported |

### 8.3 End-to-end status

| Item | Status |
|---|---|
| Configuration chain and transaction creation | **Verified** — 69 integration tests against real PostgreSQL |
| Application boots, migrates, serves, enforces auth | **Verified** — booted against a real database and exercised over HTTP |
| Engine reachable, authenticated, retention applied | **Not yet run.** `pnpm test:adapter` needs a container; none was available in this environment |
| Interaction URI obtained from a real engine | **Not yet verified.** Covered by the fake port, and by the adapter-contract suite once a container exists |
| Wallet interaction | **Not attempted.** Needs the chain check (§8.1), a public HTTPS origin and a wallet |
| Official Reference Implementation build | **Unverified** |

## 8A. The registration certificate, and the warnings to expect without one

**Verified against EUDIPLO v7.6.0 on 11 September 2026.** A presentation request from V0 carries
**no registration certificate**, and it is worth being precise about why and about what a Wallet
will do.

### What the request object actually contains

The signed request object was fetched from its `request_uri` and decoded. Its claims are
`response_type`, `client_id`, `response_uri`, `response_mode`, `nonce`, `dcql_query`,
`client_metadata`, `state`, `aud`, `exp`, `iat` — and **no registration-certificate claim** of any
spelling. The engine emits it as **`verifier_info`** (the earlier OpenID4VP draft name, not
`verifier_attestations`), shaped
`[{ format: "registration_cert", data: "<jwt>" }]`.

### Why it is absent, in order of discovery

| | |
|---|---|
| 1 | **The adapter's field name was wrong** — now fixed. It sent `registrationCert: { jwt }`; the engine's `PresentationConfigCreateDto` declares `additionalProperties: false` and answers 400 `unrecognized key(s) "registrationCert"`. The correct field is **`registrationCertImportJwt`**, and despite the engine's OpenAPI declaring it an array its validator requires a **string** |
| 2 | **The certificate must carry an authorised-credentials claim**, or the engine refuses it: `Registration certificate has no authorized credentials`. This is the engine-side equivalent of the `RPRC_21` check, and the reason the placeholder generator takes `--vct` and `--claim` |
| 3 | **The engine emits it only when a registrar is configured for the tenant.** `oid4vp.service.js` guards the claim with `presentationConfig.registration_cert && await registrarService.isEnabledForTenant(tenantId)`; `isEnabledForTenant` is `!!config`; and `saveConfig` calls `testCredentials` **before** saving, so the registrar must be reachable and must authenticate |

Point 3 is the one that matters: **`RPRC_19` cannot be satisfied through this engine at this
version without a reachable registrar service**, no matter what the platform does. Holding a valid
certificate is not sufficient. Recorded as `A12` and `A13` in
[`interop-findings.md`](interop-findings.md).

### The TEST placeholder

Until a real certificate is available, one can be minted for exercising the code path:

```bash
node scripts/make-test-registration-certificate.mjs \
  --service age-gate --vct urn:eudi:pid:1 --claim birthdate
```

**It is not a registration certificate.** It is a self-signed JWT issued by nobody, whose `iss` is
`urn:edtp:TEST-PLACEHOLDER:NOT-ISSUED-BY-ANY-REGISTRAR` so that anything logging or displaying the
issuer shows what it is. `TEST` only, and never evidence of conformance —
`EW-DM-44-023` (`RPRC_19`) is satisfied only by a certificate from an authorised Provider of
registration certificates, and V0 has none (blocker B3).

### Warnings to expect from a Wallet

`EW-DM-44-019` (`RPRC_17`) is explicit about the absent case:

> A Wallet Unit SHALL verify the format, authenticity, and validity of the registration certificate
> it received … **If the certificate is absent**, malformed, inauthentic, or expired, the Wallet
> Unit SHALL, when asking for User approval according to `RPA_07`, **warn the User that it could
> not obtain or validate the information registered about the Relying Party and its Service**. In
> addition, the Wallet Provider SHALL determine, based on its risk analysis and security policy,
> whether and under which conditions the Wallet Unit will allow the User to approve the
> presentation.

So with V0 as it stands, **expect an approval screen carrying that warning**, and expect that
whether approval is permitted at all is the Wallet Provider's policy decision, not ours. A test run
that shows the warning is behaving correctly; it is evidence the Wallet is doing its job, not
evidence of a platform defect.

Two related points:

- `EW-DM-44-027` (`RPRC_21`) produces a **different** warning — "the Relying Party is requesting
  more information than it has registered" — when requested attributes exceed the certificate's
  list. V0 cannot trigger that one while it sends no certificate at all, and the platform already
  refuses over-asking at policy publication, two layers earlier.
- `RPRC_17` carries a timing note worth knowing: *"The requirement for Wallet Units to verify and
  validate registration certificates only applies as of 24 months after entry into force of the
  Regulation amending CIR 2024/2982."* That is the most likely reason the shipped Reference Wallet
  ships **Check Registration Certificates off by default** — so a default-configuration test may
  show no warning at all. **Test with the switch in both positions and report both**, exactly as
  §7 requires for issuance. A passing run with the switch off is not evidence that `RPRC_19` is met.

### Status

| Item | State |
|---|---|
| Platform carries `IntendedUse` → `RegistrationCertificate` → compiler → `VerificationPlan` → adapter | **Implemented**, and validated: the compiler rejects a certificate bound to another intended use or already expired |
| Adapter sends it to the engine | **Implemented and verified** against v7.6.0 (`registrationCertImportJwt`) |
| Engine puts it in the request object | **Blocked** — needs a registrar configured for the tenant (A13) |
| A real certificate | **Not held.** Blocker B3 |
| `RPRC_19` | **NOT satisfied**, and not claimed |

`tests/adapter/registration-certificate.test.ts` holds the line: it asserts the engine accepts the
certificate, asserts the honest omission when none is held, and its request-object assertion
**skips with a logged reason** when no registrar is configured — turning green by itself once one
is, and failing if a registrar is configured and the claim is still missing.

## 9. Planned next: the W3C Digital Credentials API

Scheduled as **the iteration after Milestone 1**, and it is what actually resolves the cross-device
problem rather than mitigating it.

| What it closes | Requirement |
|---|---|
| The OS-managed proximity check — ARF §4.4.3.2 challenge 1 | `EW-PIO-01-020` (`OIA_08g`) |
| Unified wallet selection — challenge 2 | ARF §4.4.3.3.2 |
| Consistent invocation — challenge 3 | ARF §4.4.3.3.2 |
| Browser-supplied origin — challenge 4 | ARF §4.4.3.3.2 |
| Session binding handled by the browser and OS — challenge 5 | ARF §4.4.3.2 |

Protocol requirements: `EW-PIO-01-013` (`OIA_08`) and `EW-PIO-01-014` (`OIA_08a`) for OpenID4VP over
the DC API via HAIP §5.2, and `EW-PIO-01-015` (`OIA_08b`) for ISO/IEC 18013-7 Annex C.

Engine support already exists — `response_type: "dc-api"` and `"iso-18013-7"` on
`POST /verifier/offer`, with `expected_origin` — so the platform work is the `interactionType`, the
origin plumbing and the browser-side integration, not a new engine. Two caveats carried from
Phase 0: the Reference Implementation's DC API support is marked `n/a` in the engine's
compatibility matrix, and `readerAuth` for the ISO 18013-7 path extracts the access key as a JWK,
so a KMS-backed non-extractable key is not yet usable there
([`interop-findings.md`](interop-findings.md) B9).

EUDIPLO's own recorded Reference Implementation compatibility is `2026.02.26-Demo`, last verified
26 February 2026 — about six and a half months stale against the current wallet release and
engine version, and it notes the wallet "forces Wallet attestation". Treat that matrix as stale
evidence, not as a current statement. Open question Q8.
