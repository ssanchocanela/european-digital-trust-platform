# Reference Wallet testing

How to attempt a wallet interaction, what currently blocks it, and exactly what is needed for a
real test.

**Read this first:** no interaction with an **official** Reference Implementation build has been
demonstrated. Milestone 1 targets a **self-built** wallet trusting a platform-operated
development Access CA, approved at the Phase 0 checkpoint. That is a *modified* wallet. Every
report, including the PR description, says so.

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

### Path A — an access certificate from the official RP Registration Service (preferred)

`https://registry.serviceproviders.eudiw.dev/` issues Relying Party Access Certificates in
PKCS#12. It is on the same `serviceproviders.eudiw.dev` host family as the dev trusted lists,
which strongly suggests its CA is among the seven anchors — **suggests, not proves**: its
documentation does not name its CA, and I could not verify a chain without an account. How a
developer obtains an account is not documented.

Its own documentation states it "must not be used to manage real Relying Party access
certificates".

If you obtain one:

```bash
TENANT_ID=<tenant-id> ./scripts/import-access-certificate.sh \
  <service-id> <tenant-api-key> <engine-tenant-ref> rpac.p12
```

**Verify the chain against the LoTE before anything else.** Extract the anchors and check that
your leaf chains to one of them:

```bash
curl -s https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt \
  | python3 -c '
import sys, base64, json, hashlib
def d(s): s += "=" * (-len(s) % 4); return base64.urlsafe_b64decode(s)
payload = json.loads(d(sys.stdin.read().strip().split(".")[1]))
for entity in payload["LoTE"]["TrustedEntitiesList"]:
    for svc in entity.get("TrustedEntityServices", []):
        info = svc.get("ServiceInformation", svc)
        name = info.get("ServiceName", [{}])[0].get("value")
        for cert in info.get("ServiceDigitalIdentity", {}).get("X509Certificates", []):
            der = base64.b64decode(cert["val"])
            print(hashlib.sha256(der).hexdigest()[:16], name)
'
```

No platform code changes on this path. The certificate is imported the same way.

### Path B — a self-built wallet (chosen for Milestone 1)

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

**This is a modified wallet.** Requirements that follow from that, without exception:

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
| Which wallet? | "self-built Reference Implementation wallet, build `<tag>`, with a development Access CA in its reader trust store" — never "the Reference Wallet" |
| Official build? | "unverified" until Path A succeeds |
| *Check Registration Certificates* on? | both results, separately |
| Registration certificate present? | "no — `EW-DM-44-023` (`RPRC_19`) not satisfied; the transaction records `sentWithoutRegistrationCertificate`" |
| Conformance? | none claimed |

## 8. Current status

| Item | Status |
|---|---|
| Engine reachable, authenticated, retention applied | Verifiable by `pnpm test:adapter` against a container; **not yet run** (no container available in the Phase 0/Milestone 1 environment) |
| Configuration chain and transaction creation | **Verified** — 66 integration tests against real PostgreSQL |
| Interaction URI obtained from the engine | **Not yet verified** against a real engine; covered by the fake port and by the adapter-contract suite when a container is present |
| Self-built wallet interaction | **Not attempted** — needs a built wallet, a public HTTPS origin and the development CA |
| Official Reference Implementation build | **Unverified**, and expected to refuse without a Path A certificate |

EUDIPLO's own recorded Reference Implementation compatibility is `2026.02.26-Demo`, last verified
26 February 2026 — about six and a half months stale against the current wallet release and
engine version, and it notes the wallet "forces Wallet attestation". Treat that matrix as stale
evidence, not as a current statement. Open question Q8.
