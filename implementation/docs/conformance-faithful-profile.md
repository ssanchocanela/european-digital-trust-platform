# Faithful conformance profile — prepared, not run

**Prepared only.** The tightest-profile smoke run is done and recorded in
[`conformance-results.md`](conformance-results.md): 54 pass, 4 fail, 1 warning, and one new engine gap
(**G7**). This document is what the faithful profile needs, so that the moment HTTPS and a real access
certificate exist it can be run without re-deriving anything.

Two plans: `oid4vp-1final-verifier-haip-test-plan` (18 modules) and
`oid4vci-1_0-issuer-haip-test-plan` (24 modules). Suite commit `e3b5558d6d5e0c17ab578a47b955fd3b405f902b`,
prebuilt images, `--fintechlabs.devmode=true` so no OIDF account is involved.

---

## 1. What the smoke run left to fix, in order of value

Each row is a change, not a discovery — all four failures were classified at the time.

| # | Change | Clears | Why it is worth the effort |
|---|---|---|---|
| **1** | Configure the **suite's issuer certificate as an engine trust anchor** | Failure #4 (`400`, expected `200`) | Without it, every module expecting a *successful* presentation stops at the same point, so 17 of 18 verifier modules are untestable. This is the highest-value single change |
| **2** | Serve the engine (and the platform) over **HTTPS** with a certificate the suite trusts | Failures #1 and #2 (`request_uri` / `response_uri` must be `https`) | Also needed for any phone test — this is blocker **B5** work, done once for both |
| **3** | A **real access certificate** (Path A) | Failure #3 (leaf must not be self-signed) | The same certificate the VaaS run sheet needs. Blocker **B1** |
| **4** | Run the remaining **11 verifier modules**, then the **issuer plan** | — | See §4: nine are negative tests, and they are the most valuable evidence left |

With 1–3 done the verifier plan should pass cleanly, and *that* would be meaningful interoperability
evidence — still short of ARF or TS conformance, which this suite does not test and which is not claimed.

## 2. Configuration that was wrong twice, so it is written down

Both were found by reading the suite's Java source, not its documentation. Use these exact keys.

| Wrong | Right |
|---|---|
| `request_object_trust_anchor` | **`client.request_object_trust_anchor_pem`** |
| `credential_issuer.signing_jwk` | **`credential.signing_jwk`** |

`client.request_object_trust_anchor_pem` is also the reason the smoke run was possible at all: the suite
validates our signed request object against an anchor **we supply**, so it does not need our certificate
to chain to anything public. That is what made the run independent of B1 — and it stays true in the
faithful profile.

### Variants resolved in the smoke run, to keep

```
credential_format: sd_jwt_vc      response_mode: direct_post.jwt
client_id_prefix: x509_hash       request_method: request_uri_signed
vp_profile: haip
```

## 3. The three setup steps in detail

### 3a. The suite's issuer certificate as an engine trust anchor

The suite presents a credential signed by **its own** key. The engine holds no anchor for it, so it
answers `400` — *"The credential could not be verified."* — which is correct behaviour, not a defect.
Accepting it is a deliberate configuration step:

1. Extract the issuer certificate the suite uses for the resolved variant (it is in the suite's test
   configuration for the plan, alongside `credential.signing_jwk`).
2. Import it as a trust anchor for the tenant under test, scoped to the attestation type the plan
   presents — **not** as a blanket anchor.
3. Record it in `docs/security-limitations.md` as a `TEST`-only anchor with the run it exists for, and
   **remove it afterwards**. An anchor added for a test run and left behind is exactly how a trust store
   stops meaning anything.

> This must never reach a `PRODUCTION` trust configuration, and the tenant used for conformance runs
> should be a throwaway rather than the one used for wallet tests.

### 3b. HTTPS

The smoke run used `http://eudiplo:3000` so the suite's container could reach it, which is what produced
failures #1 and #2. The faithful profile needs real HTTPS. Two options:

| Option | Notes |
|---|---|
| **The test-session tunnel** ([`test-session-gateway.md`](test-session-gateway.md)) | Reuses work already needed for the phone, and gives a certificate the suite trusts with no extra setup. The suite then reaches us over the public internet, so the run is no longer egress-free — see §5 |
| A local CA, with its root added to the **suite container's** truststore | Keeps the run local and egress-free. More setup, and the truststore edit is per-container and easy to lose |

**Recommendation: the tunnel**, because HTTPS is needed for the phone anyway and one mechanism serving
both is one fewer thing to keep working. Take the egress consequence in §5 knowingly.

If the tunnel is used, its allow-list must admit the wallet-facing paths the **suite** uses — the same
set a wallet uses, which is what §1a of the gateway document already lists. It must still refuse
`/api/*`, and the negative checks must be run before the suite is pointed at it.

### 3c. The real access certificate

Identical to the VaaS precondition: chain check first, then import, then delete the development
certificate. Do **not** run the faithful profile against a self-signed certificate and call it faithful.

## 4. The 11 verifier modules still to run

Nine of these are **negative** tests, and they are the most valuable evidence remaining, because they
test that we *reject* what we should — which our own tests assert against our own assumptions.

| Module | Asserts we reject |
|---|---|
| `invalid-credential-signature` | A credential whose signature does not verify |
| `invalid-sd-hash` | A disclosure whose digest does not match |
| `invalid-kb-jwt-nonce` | Key-binding JWT with the wrong nonce — **replay** |
| `invalid-kb-jwt-aud` | Key-binding JWT addressed to someone else — **audience confusion** |
| `kb-jwt-iat-in-past` / `-in-future` | Key-binding JWT outside the acceptable window |
| `invalid-session-transcript` | A response bound to a different session |
| `minimal-cnf-jwk` | A minimal confirmation key |
| `request-uri-fetched-twice` | A request object fetched twice — **single-use semantics** |
| `request-uri-method-post` | (positive) `request_uri_method=post` handled |
| `happy-flow` | (positive) already run |

`invalid-kb-jwt-nonce` and `invalid-kb-jwt-aud` are the two to look at first if time is short: they are
replay and audience confusion, the failures with real consequences, and they are decided inside the
engine where we have no visibility at all.

A module that *fails to reject* is a **serious finding** and goes in the engine gap register
immediately, not in a summary at the end.

## 5. Egress, and the decision it needs

The smoke run had **zero outbound traffic**. The faithful profile probably cannot, and the difference
should be a decision rather than a drift.

| Destination | Why | Avoidable? |
|---|---|---|
| The four dev LoTEs at `trustedlist.serviceproviders.eudiw.dev` | The engine resolves ETSI trust when validating a presented credential's chain | Only by pre-seeding a cache, which then misrepresents trust. **Allow it** |
| A status list URL **inside the suite's test credential** | `statusCheckMode` on the presentation configuration. The URL is chosen by the suite | Yes, by turning `statusCheckMode` off — at the cost of not exercising status checking |
| The tunnel host, if §3b uses the tunnel | The suite reaches us over the public internet | Yes, by using a local CA instead |

Two corrections to the original inventory, already recorded and repeated here so the list is usable as
is: **`registry.gitlab.com`** was missing (prebuilt images come from the GitLab container registry, a
different host from `gitlab.com`), and **`localhost.emobix.co.uk` needs no runtime DNS** because
`docker-compose-prebuilt.yml` declares it as a network alias for its own nginx container.

**Recommended profile:** allow the four LoTE URLs and the suite's status list; use the tunnel for HTTPS.
Two known destinations plus our own host, and trust resolution and status checking — the parts an
independent implementation is most useful for testing — actually get exercised.

## 6. Then the issuer plan

`oid4vci-1_0-issuer-haip-test-plan`, 24 modules, the suite playing the **wallet**. Worth saying plainly
what it can and cannot reach:

| | |
|---|---|
| **Can** test | Credential Issuer metadata shape, the authorization and token endpoints, the credential request and response, nonce and notification endpoints, and SD-JWT VC form |
| **Cannot** test | Gate (a). The suite is not the pinned wallet and does not enforce `requireSignedMetadata()`, so a pass says nothing about **G1**. Nor does it test gate (b) |

So the issuer plan is evidence that our OpenID4VCI surface is well-formed. It is **not** evidence that a
Wallet Unit would accept an attestation from us, and **B7 is unaffected by any result it produces**.
Expect it to observe the absence of `signed_metadata` only if HAIP requires it — if it does, that is an
independent confirmation of G1 and goes straight into the register.

## 7. What to record

Update [`conformance-results.md`](conformance-results.md) in place, keeping the smoke-run section: a
later run that replaces the earlier record loses the comparison, and the comparison is where drift shows.
For each module: plan, variant set, module name, counts, and every failure classified as **engine gap**,
**platform defect**, or **test-harness environment** — the same three buckets as the smoke run, because a
finding that is not classified gets re-argued later.

And the standing rule: **no ARF or TS conformance is claimed**, and no certification is proposed.
Certification needs the hosted instance and an account, and is not on the table.
