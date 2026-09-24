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

### 8.1a First wallet run — Path B, modified build, **blocked at relying-party verification**

The first end-to-end attempt against a wallet. It is recorded whatever it says, per `CLAUDE.md` §8.

| Field | Value |
|---|---|
| Date run | **13 September 2026** |
| Wallet | **MODIFIED build**, not the Reference Wallet: `eu.europa.ec.euidi.edtptest2`, `versionName 2026.09.42-edtptest`, APK SHA-256 `5a87a95dcca05f458b626dac1d960c721a0ff91c1beb7f7267dddb48094160bf` |
| Upstream | tag `Wallet/Demo_Version=2026.09.42-Demo_Build=42`, commit `43f362d2`, wallet core `0.30.2` |
| Active deviation | **WD-3** — `wrpacProviders` pointed at our published TEST LoTE |
| Device | Pixel 9a |
| Access certificate | issued by our development Access CA, `x509_hash:jIv6homAf8bSFFKU5tmBAUsXiq4Y_90K9sZ2vDKwNXc`, `x5c` of 2 |
| Exposure | Cloudflare quick tunnels, allow-list enforced; all **14 negative checks returned 404** |
| **Result** | **BLOCKED.** *"This presentation request has been blocked because the relying party could not be verified by your Wallet."* No data shared |

**What this run does establish**, and it is not nothing:

- **Blocker B5 is closed on this machine.** The wallet resolved the `request_uri` over public HTTPS,
  fetched the signed request object and processed it far enough to evaluate relying-party trust. A
  transport failure would have stopped earlier and said something else.
- **The gateway allow-list holds under a real session.** Fourteen paths refused, including the
  engine's Management API, its health endpoint and its OpenAPI documents.
- **The wallet behaves as `RPA_04` requires**: a relying party it cannot verify is refused, and
  nothing is disclosed.

**What it does not establish — and why we cannot yet say:** which of three causes blocked it.

1. the wallet never fetched our list;
2. it fetched it and rejected the signature — the open half of WD-3, and the likeliest;
3. it verified the list but did not match our anchor to the certificate chain.

The screen deliberately does not distinguish them: a wallet should not tell a relying party why it
distrusts it. **And `logcat` cannot either — the release build emits no application logging at all.**
Verified: across a 3,829-line capture the wallet's process wrote only framework lines (a navigation
`Bundle` warning, window callbacks) and nothing of its own. So the next diagnostic step needs a
**debug build**, which both logs and is `run-as`-readable, letting the trust decision and any cached
list be inspected directly.

### 8.1b Second wallet run — **a complete presentation**, modified build

The run that succeeded, 13 September 2026. Same day, same tunnel session, same certificate as
§8.1a; three things changed between them, and each was a real defect.

| Field | Value |
|---|---|
| Wallet | **MODIFIED build**, not the Reference Wallet: `eu.europa.ec.euidi.edtptest3`, **debug**, APK SHA-256 `1fe79eed9fba745ae0cb20518563003d5870336f5c7deaf9a8d50f94fa0c210f` |
| Active deviation | **WD-3** — `wrpacProviders` pointed at our published TEST LoTE |
| Access certificate | our development Access CA, `x509_hash:jIv6homAf8bSFFKU5tmBAUsXiq4Y_90K9sZ2vDKwNXc` |
| Credential presented | PID, `dc+sd-jwt`, `vct=urn:eudi:pid:1`, obtained from `issuer.eudiw.dev` |
| **Result** | **`VERIFIED`**, result `{"over_18": false}` |

The wallet's own log, which is why the debug build exists:

```
LoTE JWT signature verified successfully
validateCertificationTrustPath: result=Trusted(trustAnchor=[
  Trusted CA cert: … Issuer: CN=EDTP Development Access CA - TEST ONLY …
```

**What it establishes.** The platform compiles a policy to DCQL, signs a request object a wallet
accepts, serves it over public HTTPS, receives an encrypted response, verifies the credential,
applies the result policy and returns the derived claim. The minimisation holds where it matters:
`birthdate` entered the adapter, `over_18` came out, and no `birthdate`, `iss`, `iat`, `exp` or
`vct` appears anywhere in the result. `over_18: false` is correct — the test PID's date of birth
was the day of the run.

**What it does not establish, and no report may imply otherwise.** Nothing about an *official*
build. An unmodified wallet consults only the notified `WRPACProviders` list, which does not carry
our anchor and never will, so it would refuse this certificate exactly as §8.1a describes. Blocker
**B1 is untouched** by this result.

**Three defects found on the way**, each invisible until a wallet was involved:

1. Our published list was fetched and its **signature verified**, then refused with
   `FailedToParseJwt`. The only structural difference from the notified list was a missing
   `TEAddress`. The generator now clones the notified entity rather than writing one by hand.
2. The adapter read **`verifiedClaims`**, which the engine's session does not have — disclosed
   content is on `credentials`. `interop-findings.md` **A18**, including why 21 contract tests
   could not have caught it.
3. The identifier in the wallet-facing `request_uri` is **not** the session id the management API
   takes, which sent the first diagnosis down a blind alley.

**Settled, and it simplifies WD-3:** the wallet's built-in JWS verifier accepts our self-signed list
signer, so `jwtSignatureVerifier` is **not** needed. WD-3 is a single configuration point, unlike
WD-1.

### 8.1c Third wallet run — **issuance blocked at gate (a)**, and that is the correct outcome

13 September 2026, W3 (`eu.europa.ec.euidi.edtptest3`, deviation `wd-3` only), over a Cloudflare
quick tunnel, against a §7.3 PID-gated issuance policy.

**The Wallet refused, on screen:**

> ⚠ **Issuance blocked**
> This issuance request has been blocked because the provider could not be verified by your Wallet.
> Your personal information or other data has not been shared with this provider.

**This is blocker B7, observed rather than reasoned about.** Until now it rested on reading
`requireSignedMetadata()` and `evaluateIssuerTrust` in the pinned release. The exchange that produced
it, from the Wallet's own HTTP log:

| | |
|---|---|
| Credential offer | `GET …/issuers/rpi-1/vci/credential-offers/{id}` → **200** |
| Issuer metadata, requested as | `Accept: application/jwt; application/json` — **the Wallet asks for the signed form first** |
| Issuer metadata, served as | `content-type: application/json` — unsigned, **200**. `issuer_info` present, `signed_metadata` absent |
| Outcome | Refused at ARF §6.6.2.2 pre-issuance provider authentication |

Three things this run establishes that the code reading did not.

1. **The Wallet does ask for signed metadata**, and takes the unsigned document only to discover it
   cannot authenticate the provider. The `Accept` header is the direct evidence for `interop-findings.md`
   A15.
2. **It blocks before the eligibility presentation.** "no data has been shared" is the Wallet's own
   statement, and it means the §7.3 presentation half is **unreachable while B7 stands** — the gate
   fixed in A22 is correct at the platform and engine layer and cannot be exercised against a Wallet
   from here.
3. **Everything upstream of the gate worked**, over public HTTPS, first time: the offer resolved, the
   metadata resolved, and it carried both authorization servers and the `issuer_info` registration
   certificate. The failure is exactly where it should be and nowhere else.

**What it does not establish.** Nothing about an official build — W3 is a modified wallet. And
nothing about whether issuance would succeed with the gate passed: that needs deviations `wd-1` and
`wd-2`, and **`wd-2` silently disables the issuer registration-certificate check** whatever the
*Check Registration Certificates* preference says (`CLAUDE.md` §6.21), so a pass obtained that way
proves less again and must be reported with that caveat attached.

### 8.1d Fourth wallet run — **past gate (a)**, and stopped at the authorization-code start

13 September 2026, **W4** (`eu.europa.ec.euidi.edtptest4`, deviations **`wd-2,wd-3`**), over the
same tunnel, against the §7.3 PID-gated issuance policy.

**Gate (a) no longer blocks.** The "Issuance blocked — the provider could not be verified" of §8.1c
is gone, which is what `wd-2` was built to do. **It does not mean the gate is satisfied: it is
bypassed.** `wd-2` accepts unsigned metadata *and* silently switches off the issuer
registration-certificate check, so nothing here evidences ARF §6.6.2.2, `AS-AP-44-005` (`RPRC_22a`)
or `AS-AP-44-007` (`RPRC_23`).

**What the run reached, and where it stopped.** The Wallet fetched the credential offer (200) and
the issuer metadata (200), and then made no further request and logged no error — the screen shows
only a generic failure. The authorization-code flow never started.

**Two platform defects were found getting that far, and both are fixed.**

| | |
|---|---|
| **A gated policy with `PRE_AUTHORIZED_CODE` was accepted** | A pre-authorized code skips the authorization server by construction, and the gate *is* an authorization step. The offer was minted, and the eligibility presentation simply would not have happened. Now refused at publication (`gate_requires_authorization_code`) |
| **The offer did not name its authorization server** | The tenant advertises every server its provider needs (A20), so the offer has to say which one this credential goes through. Without it the engine chose the built-in one — so a gated policy produced an offer pointing away from its own gate. Verified against the running engine: the offer's `authorization_server` was `…/issuers/{ref}` whatever the policy said |

After both fixes the offer carries
`grants.authorization_code.authorization_server = …/authorization-servers/eligibility-<policyId>`
over public HTTPS, the authorization server's own metadata resolves (`issuer`,
`authorization_endpoint`, `token_endpoint`, `response_types_supported: ["code"]`), and the gateway
allow-list passes it. The Wallet still does not proceed, and the reason is not visible from here.

**So the §7.3 eligibility presentation remains unexercised against a wallet.** What this run
establishes is narrower and worth stating exactly: everything the platform emits for a gated
issuance is now correct and reachable, and the remaining gap is on the wallet side of the
authorization-code start. That is a better position than §8.1c — where the failure was ours — but it
is not the test succeeding.

### 8.1e Fifth wallet run — **the first mdoc presentation**, and two defects between here and it

13 September 2026, W3 (`wd-3`), same tunnel, an **mDL** obtained from the reference issuer. Every
previous run on this platform was SD-JWT VC; this is the first time an mdoc has been asked for,
presented and verified.

**Result: `VERIFIED`**, with `{"org.iso.18013.5.1.family_name": "…"}`. The whole mdoc path works —
DCQL with `doctype_value` and namespaced claim paths, credential matching in the wallet, the signed
request object, the encrypted response, and the result policy.

**It took four attempts, and each failure was worth having.**

| | What the screen or the log said | What it was |
|---|---|---|
| 1 | *"The requested document is not available in your EUDI Wallet"* | The relying party was **verified** — the green badge was there — and the wallet then could not satisfy the request. A misread: the run after it showed the wallet did match and did share |
| 2 | `400 invalid_request · mDOC verification failed` | The engine cannot decode the reference issuer's CWT status list: it requires `aggregation_uri`, which the specification makes optional. `interop-findings.md` **A25** |
| 3 | Identical, with `statusCheckMode: BEST_EFFORT` | The platform's status-check lever is **not** a lever for this. The decode throws before the mode is consulted; only `DISABLED` gets past it |
| 4 | `POLICY_NOT_SATISFIED`, on an engine session reporting `success` and `verified: true` | Ours. The engine returns mdoc values flat, without the namespace the claim path addresses, so the result policy looked in the wrong place. **A24** — the same shape as A18 |

**What this run therefore shows, exactly.** The mdoc path is sound and the platform now handles its
result shape. It shows nothing about revocation: the successful run had status checking **disabled**,
which `AS-AP-07-023` (`VCR_13`) permits only after a documented risk analysis that V0 has not
performed. **An mdoc presentation with status checking on does not work today, and the reason is in
the engine.**

### 8.1f Sixth wallet run — **an attestation collected and stored**, modified build

16 September 2026, **W4** (`eu.europa.ec.euidi.edtptest4`), deviations **`wd-2,wd-3`**, rebuilt with
`--diagnostics` (`EDTP_DIAGNOSTICS=yes`, logging only). Pre-authorized-code offer for
*Employee badge*, fixture subject, over the tunnel, with the test gateway's
`GATEWAY_PINNED_WALLET_COMPAT` **on**.

| | |
|---|---|
| Wallet HTTP trace | offer 200 · issuer metadata 200 · AS metadata 200 · `authorize/challenge` 200 · `authorize/token` 200 · `vci/nonce` 200 · **`vci/credential` 200** |
| On the device | *Employee badge*, issued by *Smoke Test Issuer B.V.*, in the Documents list |
| Platform | transaction `ISSUED`, attestation in the register as `VALID`, status confirmed |

**Every layer between the first attempt on 13 September and this run is recorded** in
`interop-findings.md` A28 and A29, in the order a wallet met it.

**What this run establishes.** The platform's issuance chain completes against a real wallet on a
real phone, and the platform records and can revoke what was issued.

**What it does not, and no report may imply otherwise.**

- **A modified build, not the Reference Wallet.** `wd-2` bypasses trust gate (a) — the engine still
  signs no issuer metadata (B7) — and `wd-3` points access-certificate trust at our list.
- **The gateway rewrote two responses on the way** (A29). An unmodified path through the engine alone
  does not complete.
- **`key_attestations_required: iso_18045_basic` is a parser requirement**, not a checked property.
- **Wallet attestation was verified** by the engine against the notified **dev** WalletProviders
  list — a TEST trust list.
- **No registration certificate** (B3), and *Check Registration Certificates* in its default, off.
  Not tested in the on position.

### 8.1g Seventh wallet run — **the end-to-end demonstration: identified by PID, issued a representative credential**

16 September 2026, same W4 build and gateway settings as §8.1f. One person, one wallet, two steps.

| Step | What happened | Evidence |
|---|---|---|
| 1 · Obtain a PID | Already held, from the EUDI reference issuer's own form | `PID (SD-JWT VC)` in the wallet |
| 2 · Present it | Policy *Identify with PID* asks for `family_name` and `given_name` only | presentation **`VERIFIED`**, result holds exactly those two claims; the wallet's PID count went from 30/30 to **29/30** |
| 3 · Request the representative credential from it | `POST /v1/issuances` with the **presentation id** as `subjectReference`, through the `verified-presentation` source | accepted; warnings returned: no registration certificate, and FIXTURE source |
| 4 · Obtain it | offer → metadata → AS → challenge → token → nonce → **`/vci/credential` 200** | *Company representative* in the wallet, four fields, the two names from the PID; platform `ISSUED` |

Values were checked **for presence only** — the names are PID attributes and are not written here.

**What it establishes.** A platform-operated chain in which a verified presentation becomes the source
of an issued attestation, in one tenant, refused across tenants, with the presentation id as the
provenance of every attestation issued from it.

**What it does not — and one thing found the next day.** The identification in step 2 was verified **without any issuer trust check**: the engine skips it when a policy names no trust list, and the platform never passed one (`interop-findings.md` A30, fixed 17 September). The PID was the reference issuer's and would have passed the check, but the run does not show that it did. Everything in §8.1f still holds — a modified wallet, gate (a) bypassed, two
responses rewritten by the gateway, a dev wallet-provider list, no registration certificate. And the
representation itself is **fictitious**: the organisation and the capacity to act for it come from
policy configuration, which is why the source is a FIXTURE and the warning is returned. A real
representative credential needs a company register behind it.

**Setup for this run, beyond §8.1f.** The issuing tenant also needs a verification service whose
instance holds the **development-CA** access certificate (`import-access-certificate.sh`), an intended
use registered on it, and a presentation policy; the tenant's other provisioned service signed with a
certificate the wallet does not trust.

### 8.1h Eighth wallet run — **the same demonstration, driven from the operator console**

16 September 2026, same build, gateway and policies as §8.1g. No API call by hand: the operator
started *Identify with PID* from the console's Verification page, the wallet presented the PID, the
presentation page turned **`VERIFIED`** and offered *Issue from this presentation*; pressing **Issue**
on *Company representative (from a verified PID)* produced the offer QR, the wallet collected it, and
the platform recorded the issuance **`ISSUED`** with a new `VALID`, status-confirmed register entry.
About four minutes from presentation to credential. Values checked for presence only.

One thing to know when watching it: the issuance **list** shows the status last stored, and the status
is refreshed from the engine when the issuance itself is read, so the list can say
`AWAITING_WALLET` for an issuance that is already `ISSUED` until its page is opened.

Every limit of §8.1f and §8.1g still applies.

### 8.1i Ninth and tenth wallet runs — **issuer trust, proved in both directions**

18 September 2026, W4 as before, a fresh tunnel and gateway after a host restart. Two presentations
of the same reference-issued PID against the same policy, differing only in the trust list the policy
names — the check introduced that day (`interop-findings.md` A30).

| Policy version | Trust anchor source it names | Outcome |
|---|---|---|
| v2 | The notified EUDI **development** `PIDProviders` list, loaded into the engine | **`VERIFIED`**, result as before |
| v3 | A negative control: a list holding one anchor, this platform's development **Access** CA, which signs no attestation | **`TRUST_ERROR`**, `trust_chain_not_trusted`, **no result** |

The PID was the same legitimate credential in both runs, so the difference is the check and nothing
else. Together with the platform-side refusal of a policy naming no source at all
(`trust_anchor_sources_missing`, exercised over the API), that is the whole behaviour: refused when
nothing says whom to trust, refused when the signer is not among them, verified when it is.

The negative control was removed afterwards and the policy republished at v4, naming the notified
list. What this does **not** establish: anything about a notified production list, or about an
official wallet build — §8.1f's limits all still apply.

### 8.1j Eleventh wallet run — **a test PID, then the three Power of X attestations, selectively disclosed**

23 September 2026, **W5** (`eu.europa.ec.euidi.edtptest5`, debug, `wd-2,wd-3,wd-4`, APK SHA-256
`5c830bdc…5ea0`) — a **modified wallet**, not the Reference Wallet — on a Pixel 9a, through the gateway
with `GATEWAY_PINNED_WALLET_COMPAT=true`. The gateway's negative checks passed before the phone was
used: every `/api/*` probe, `POST /api/key-chain/import` included, answered `404` and was logged as
denied. Synthetic data throughout.

| Step | What happened | Evidence |
|---|---|---|
| 1 · A test PID | `operator-form` issuance on `pid-1`, synthetic values, offer sent to W5 by `adb` | platform `ISSUED`; W5 stored it |
| 2 · Identify | *Identify with PID, for a Power of X credential* (`c4e31d3f…` v1, TEST PID list), `SAME_DEVICE` | **`VERIFIED`**; the result holds exactly the five requested claims |
| 3 · Power of Representation | `verified-presentation` source, presentation id as `subjectReference` | platform `ISSUED`; W5 stored it |
| 4 · Power of Attorney | the same | platform `ISSUED`; W5 stored it |
| 5 · Power of Employee | the same | platform `ISSUED`; W5 stored it |

**The tokens, decoded.** W5 is a debug build, so its document store was read with `run-as`, the three
SD-JWTs parsed for their structure only, and the copy deleted:

| Attestation | Disclosures | `_sd` digests | Claims in the clear |
|---|---|---|---|
| `urn:edtp:pox:power-of-representation:2` | 19 | 19 | none |
| `urn:edtp:pox:power-of-attorney:2` | 9 — the list of powers is **one** | 9 | none |
| `urn:edtp:pox:power-of-employee:2` | 18 | 18 | none |

**The first attestations this platform has issued with selective disclosure** (A32), and the first
issued on the Power of X model. What it does **not** show: the test PID's own disclosures — W5 used
its single PID credential for the presentation and deleted it, so there was no token left to read;
anything about an official wallet build; a registration certificate (none, B3; *Check Registration
Certificates* in its default, off, and not tested in the on position). The representation is
fictitious and the source a FIXTURE.

**Two defects found on the way, both ours:**

1. **Every issuance on `rpi-1` failed** with `trust_anchor_sources_missing`. The issuer configuration
   gathered the eligibility gates of every *published version*, including those of **retired**
   policies — versions stay published when their policy is retired — and two retired A22 test
   policies were gated on a presentation policy with no trust anchors, which A30 refuses. So from 17
   September no issuance on the provider could have succeeded. Fixed in
   `issuerConfigurationInputs`, with an integration test that fails without the fix.
2. **The tunnel answered every request with a bare `404`.** cloudflared reads
   `~/.cloudflared/config.yml` even for a quick tunnel, and a named tunnel's ingress there — another
   project's — ends in `http_status:404`. `test-session-tunnel.sh` now passes an empty `--config`.

### 8.1k Twelfth wallet run — **the three Power of X attestations verified, and again in a later session**

23 September 2026, W5 (modified wallet) as in §8.1j, the gateway with `GATEWAY_PINNED_WALLET_COMPAT=true`,
and — new — the **named tunnel** `edtp-dev` on fixed `murcata.es` hostnames (`test-session-gateway.md`
§2). Negative checks passed before each session: every `/api/*` probe `404`. Between the two sessions
the engine hostname answered `530`.

The chain was issued again inside a named-tunnel session, so the attestations' status list URI is
`https://edtp-engine.murcata.es/…`: test PID → *Identify with PID, for a Power of X credential* →
Power of Representation, Attorney, Employee, all `ISSUED`. Then:

| Presentation policy (`:2` intended use, TEST EAA list as issuer anchor, status `STRICT`) | Outcome | Result claims |
|---|---|---|
| *Verify a Power of Representation* | **`VERIFIED`** | exactly the six requested |
| *Verify a Power of Attorney* | **`VERIFIED`** | the five common claims and the powers list, whole (two powers) |
| *Verify an employee authorisation* | **`VERIFIED`** | exactly the seven requested |
| *Verify a Power of Representation*, **after closing the session and opening a new one** | **`VERIFIED`** | the same six |

The last row is what the named tunnel was for: an attestation issued in one session, verified with
its status checked in the next. Values were checked for presence only.

**What went wrong first, all recorded:**

1. The first verification attempt, on the attestations of §8.1j, failed fetching their status list
   from the closed quick tunnel (`530`) — no quick-tunnel attestation can be verified afterwards.
2. In the named session the status list answered `404`: the engine signed it with an expired
   smoke-test key it had picked by fallback (`interop-findings.md` A33). Re-pinned through the engine
   API; the adapter now does it at provisioning.
3. Two attempts settled `EXPIRED` although the engine session completed without failure: the wallet
   answered after the platform's transaction lifetime, once because the phone was still resolving the
   new hostname as nonexistent (a negative DNS cache).
4. One attempt never reached the platform's transaction: W5 re-opened a stale deep link from an earlier
   session. Force-stopping the wallet before sending a request avoids it. Two `JWEDecryptionFailed`
   errors on an engine session belonging to none of the day's presentations are unexplained.

Every limit of §8.1j still applies: a modified wallet, no registration certificate, a fictitious
representation, TEST lists that are not notified.

### 8.1l Thirteenth wallet run — **a PID requested from the wallet's own list, through a hosted form (FNMT demonstration)**

24 September 2026, **W6** (`eu.europa.ec.euidi.edtptest6`, debug, `wd-2,wd-3,wd-4,wd-5`,
`--pid-label "PID - FNMT"`) — a **modified wallet** — on the named tunnel, gateway in demo compatibility
mode, hosted-form gate on for `pid-1`. Negative checks passed on all four hosts (19 probes, all `404`)
before the phone was used.

| Step | What happened | Evidence |
|---|---|---|
| 1 · Discover | *Documents → Add document → From list* listed one issuer, ours, with one row "PID - FNMT" | WD-5; the issuer metadata carries one PID configuration (policy v3) |
| 2 · Authorize | PAR, then the browser opened `…/issuers/pid-1/authorize`; the gateway sent it to the hosted form | first attempt refused at PAR: `jwt 'nbf' is in the future` — the phone ran **2.2 s fast** against a zero-tolerance check (A29). Passed with the gateway's 3 s hold |
| 3 · Form | FNMT-styled form, demonstration band, fictitious values, *Confirmar* | platform validated against the credential type, held the values, returned the pass; `303` back to the engine |
| 4 · Collect | the engine sent the browser back to the wallet; token and credential requests; the engine fetched the values from the platform's attribute provider | platform **`ISSUED`** (policy v3) |
| 5 · Token | read from the debug wallet, structure only | `iss` `https://edtp-engine.murcata.es/issuers/pid-1`; **8 disclosures, 8 `_sd` digests** — the typed values including `personal_administrative_number`, and the two fixed ones; `place_of_birth` is structure, its `country` a disclosure |
| 6 · Branding | the wallet showed the FNMT emblem as the issuer logo and, after a re-issue, the issuer name *FNMT-RCM (demo)* | `ENGINE_ISSUER_BRANDING`, `ENGINE_ISSUER_DISPLAY_NAMES`; the wallet stores issuer display at issue time, so an earlier document keeps the earlier name |

The test PID's own selective disclosure is seen on a token for the first time here (§8.1j left it
open). What this does **not** show: anything about an unmodified wallet — whose list offers the EUDI
issuers and is not ours to change — or about FNMT: the branding is a demonstration, the band on the
form says so, and the data is fictitious. No registration certificate (B3).

### 8.1m Fourteenth wallet run — **a representation credential from the wallet's own list, after identifying with the PID (CORPME demonstration)**

24 September 2026, **W6** rebuilt with WD-5 carrying two issuers (`pid-1`, `rpi-1`) — a **modified
wallet** — updated in place, keeping its PID. Named tunnel, gateway in demo compatibility mode, hosted-form
gate on for `pid-1,rpi-1`. Negative checks passed (19 probes, all `404`) before the phone was used.

| Step | What happened | Evidence |
|---|---|---|
| 0 · First attempt | *From list* failed: `attestation proof must contain 'key_attestations_required'` | the session had been opened **without** `GATEWAY_PINNED_WALLET_COMPAT=true`, so the gateway did not add the field (A29 item 3). Reopened with it; `test-session-tunnel.sh` now refuses a form session without it |
| 1 · Discover | the list showed "PID - FNMT" and, from *CORPME (demo)*, *Poder de representación*, *Poder notarial*, *Autorización de empleado* | `rpi-1` advertises only the three PoX v2 configurations; the seven stale ones were withdrawn (`DELETE …/issuance-policies/{id}/provision`) |
| 2 · Authorize | PAR, then the gateway sent the browser to the CORPME-styled form, which resolved the requested policy from the engine session | `POST /v1/hosted-forms/requests/resolve` |
| 3 · Identify | the form started a `SAME_DEVICE` presentation; **the wallet presented its PID mid-issuance** and returned through the platform into the form | presentation **`VERIFIED`**; return destination fixed by the platform, not the request |
| 4 · Request | the form showed the PID claims and the fixed test data; *Solicitar* | submission with the presentation id as subject reference; `303` back to the engine with the pass |
| 5 · Collect | the wallet collected the attestation | platform **`ISSUED`**, *Poder de representación* policy **v2**, warnings: no registration certificate, FIXTURE source |
| 6 · Again | *Poder notarial*, then *Autorización de empleado*, by the same path, each with a fresh PID presentation | presentations `VERIFIED`, issuances **`ISSUED`** (policy v2 each) — all three PoX types |

The risk carried into this run — a wallet presenting while it is itself in the middle of an issuance —
did not materialise: one wallet, one pass. What this does **not** show: anything about an unmodified
wallet, about CORPME (the branding is a demonstration and the band says so), or about anyone's
authority to act for anyone: the organisation, position and powers are fictitious. No registration
certificate (B3).

### 8.1n Fifteenth wallet run — **one PID, presented twice: the reuse policy published by the issuer**

24 September 2026, **W6** unchanged — a **modified wallet**, with **no wallet change for this run**.
Named tunnel, gateway in demo compatibility mode; negative checks passed (19 probes, all `404`).

Before: the PID arrived as one once-only credential and its first presentation spent it (A34). The
PID policy is now at **v4**, identical to v3 but for `reusePolicy: LIMITED_TIME` (re-issue one day
before its seven-day expiry), which the issuer metadata publishes as
`credential_reuse_policy: {id: "arf_annex_ii", options: [{details: ["limited_time"],
reissue_trigger_lifetime_left: 86400}]}`.

| Step | What happened | Evidence |
|---|---|---|
| 1 · Re-issue | the old PID deleted; a new one requested from the list | issuance **`ISSUED`**, policy v4 |
| 2 · First presentation | the identification policy, `SAME_DEVICE` via `adb` | **`VERIFIED`** |
| 3 · Second presentation | the same, straight after | first attempt: the wallet reported `InvalidJarJwt` — the stale-deep-link replay seen with W5/W6, not the PID; resent after a force-stop: **`VERIFIED`** |

Since the engine serves one credential per request with this wallet (A34), a second `VERIFIED` means the
one credential was presented twice: ARF Method B (`ISSU_48`–`ISSU_50`), chosen by the provider
(`ISSU_38`). **Its privacy cost stands**: the two presentations are linkable by signature and salts.
Not shown: re-issuance before expiry, which in a wallet-initiated flow with a web-form authorization
step cannot run unattended; nor anything about an unmodified wallet.

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
